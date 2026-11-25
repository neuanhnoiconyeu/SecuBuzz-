# Authenticated encrypted Edit — Phase 11

The authenticated sender can edit eligible V2 text messages through the existing multiline Save/Cancel UI. The original `Messages` envelope, logical wire ID, storage ID, conversation, owner, timestamp, sequence and existing protection triggers remain unchanged. Edited versions live in an additive, append-only log. Calls and Edit are independent capabilities; this phase does not enable or modify calling.

## Protocol v1 over the unchanged V2 envelope

`shared/messageRevisions.ts` defines a strict revision proof. Its core fields are `v`, `storageId`, `messageId`, `conversationId`, `senderId`, `revision`, `operationId`, `previousHash`, `keyId`, `signerDeviceKeyId` and `editedAt`. The proof adds an `envelopeHash` and an ECDSA P-256/SHA-256 signature from an existing registered sender device. Canonical domain-separated statements are shared by server and client; no new cryptographic primitive is introduced.

1. The client decrypts and verifies the current message, preserves validated reply/forward/operation metadata, and changes only its text. Media messages and attachment captions are ineligible.
2. It prepares the current recipient-covered conversation epoch through the existing trust/key-review pipeline and reserves a fresh AES-GCM nonce through the existing material-scoped browser nonce ledger.
3. It encrypts `\u001eSecuBuzz:edit:1\n` plus JSON `{core, content}` inside an ordinary V2 envelope. This envelope's wire ID is a fresh operation UUID, **not a new displayed message**. Existing V2 AAD authenticates that operation, conversation, sender, header time/name and key ID. The protected core also binds the original logical/storage identity, revision number, predecessor and signing device. `content` is the existing versioned encrypted application-content format.
4. It signs the canonical revision statement, including the complete V2 envelope fingerprint. The first predecessor is the immutable original envelope's SHA-256 fingerprint; each subsequent predecessor is SHA-256 of the previous canonical signed proof. These hashes use lowercase hex; ECDSA signatures use the existing canonical base64url encoding.
5. DATA validates the signature against its immutable registered device directory, active signer ownership, current authenticated sender/session/CSRF, current conversation interaction policy, recipient key coverage, original identity and compare-and-swap predecessor/revision. It rechecks key/device authority inside the commit transaction after the asynchronous verifier. No transaction crosses that asynchronous boundary.

Neither plaintext content nor private signing/AES keys appears in the PATCH request, response receipt, audit metadata or realtime hint. Public revision metadata, edit counts, device/key IDs, signatures and ciphertext remain visible to the server, as documented metadata rather than media/message E2EE secrets.

## Persistence and API

Migration **0011-encrypted-message-revisions.sql** adds `MessageEditRevisions` and narrowly scoped new triggers. It does not modify migrations 0008–0010, rebuild existing tables, alter original envelope/tombstone triggers, or update existing message rows. Existing encrypted messages and legacy rows are preserved. Legacy V1 messages cannot be edited.

The log has a unique `(message_id, revision)`, globally unique operation/proof hashes, signer/message foreign keys, and a conservative `(key_id, iv)` uniqueness guard. Inserts require an active authenticated V2 original, the original owner, an active owner device, no associated encrypted attachments, contiguous revision order, the correct predecessor and matching proof/envelope identities. Updates/deletes are rejected. An additional original-message insert guard prevents reuse of an edit nonce in a subsequent message. Original nonce checks remain in place.

`PATCH /api/messages/:storageId` accepts exactly `{proof, envelope}`. New revisions return `{outcome:'created', edit:{storageId,messageId,conversationId,senderId,revision,operationId,proofHash}}`. Exact retries return the same receipt with `outcome:'duplicate'`. A committed exact replay can be confirmed after epoch rotation or signer revocation, following fresh account/membership/CSRF checks; this returns only an existing receipt and cannot append a revision. New stale/revoked-device edits are refused. Conflicting operation reuse and stale predecessors return 409; malformed/invalid proofs return 400; non-sender access returns 403; inaccessible/ineligible/deleted messages return 404. Existing authentication, CSRF, limits and fixed error responses remain in force.

The existing mutation transaction appends the revision and audit event atomically. Audit failure rolls back the revision. No `UPDATE Messages` occurs for editing. History keeps the original DTO and optionally adds `edit:{v:1,proofs:[{proof,signer}],envelope}`. The complete bounded signed proof chain is returned, with only the latest revision envelope; old ciphertexts remain in the private append-only log. Base `message.revision` still belongs to the existing original/tombstone lifecycle (active 0, deleted 1); edit versions are separate and must not be compared with tombstone counters.

Unsend remains terminal. It continues using the original sender-authorized API and existing message/pin/reaction/attachment cleanup. Deleted history omits edit snapshots and plaintext; subsequent edits and edit retries return 404. Encrypted revision rows are retained privately, consistent with the existing original-ciphertext retention model; Unsend does not physically erase historical ciphertext from backups/storage. No revision-history download endpoint is added.

Migration tests upgrade isolated version-10 databases, preserve every existing schema object and encrypted row, verify immutable protections, and repeat safely. A deliberately failing migration proves atomic batch rollback with the version-10 schema/data intact. There is no destructive automatic down migration; do not drop revision tables containing real history. **Migration 0011 has not been applied to the existing development database during this work.** Review it before normal deployment/startup migration.

## Client validation, synchronization and failures

Clients verify the original V2 envelope, complete signed proof chain, stable ownership/identity, each signer's self-signed registration, and that device's presence under the correct user in an already verified signed conversation epoch. They verify the latest envelope fingerprint/signature, decrypt its AEAD content, compare its protected core with the proof, and require unchanged reply/forward metadata. An invalid signature, changed ciphertext/owner, broken predecessor, missing proof or unavailable key fails closed without a plaintext fallback. Pinned-message reads use this same stored-message verifier, rather than decrypting the original envelope alone.

Account-scoped IndexedDB records retain the highest verified edit hash/revision and terminal deletion state. Atomic updates reject a lower revision, a different proof at the same revision, a broken known prefix, or resurrection after Unsend, including reload/logout/login on the same browser. Realtime row merging preserves immutable original identity and verified proof prefixes; a delayed or invalid row cannot replace a newer valid row.

The authorized `message:edited` event contains only `{conversationId,messageId}`. DATA emits it only from a successful, sender/session/CSRF-checked post-commit receipt. The shared authenticated socket validates exact hint shape/scope, then fetches and verifies durable history. Older targets and already loaded history are reconciled; reconnects and offline recipients use the same authoritative history. Pin snapshots refresh without changing pin state or reaction counts. A hint itself never authorizes changed ciphertext.

An account/message-scoped pending edit stores only the exact encrypted request and a content hash, independently of pending new messages. A failed/uncertain request preserves the editor draft; retries reuse its operation, nonce, ciphertext and signature. A lost successful response is reconciled from signed history without issuing another PATCH. Definitive validation/authorization/conflict failures clear that request. While a request remains uncertain, a different edit is blocked rather than silently submitting another operation. Cancel closes the UI draft; it cannot recall an already transmitted request.

## Limits and Security review

- The signed chain is bounded to **20 edits per message** in protocol v1 to bound verification/history cost. UI eligibility and database limits agree. Encrypted payload limits include the revision wrapper, so the maximum editable text can be slightly smaller than a new message.
- Old messages retain their original V2 format. Clients must understand the optional revision snapshot to display edited conversations; older strict clients fail closed rather than accepting an arbitrary ciphertext replacement. Coordinate client/server rollout.
- This is the existing authenticated key directory and trust-on-first-use model, not independent identity verification or a public transparency log. A previously observed revision/deletion cannot roll back while browser state remains intact. No client can detect an entirely withheld **never-observed** newer revision, or recover a destroyed browser watermark/key history, without an additional trusted freshness source. New devices still need the original historical keys; enrollment does not recover old keys.
- Current-device/key review is still required before new edits. An uncertain uncommitted edit using obsolete keys is not automatically re-encrypted or duplicated. Check history and resolve its status before composing a different operation.
- Team review should cover the new signature domain, epoch/device binding, persistent rollback watermark, bounded append-only storage/retention, replay-only historical receipt handling and rollout compatibility. No message E2EE or original database protection is disabled.

Security/Database implementation files: migration 0011; `DATA/server/messaging/edits.js`, `service.js`, `pins.js` and `routes/messaging.js`; `shared/messageRevisions.ts`; `server/src/e2ee/messageEdits.ts` and its public exports; client `security/e2ee/{edits,session,api,model,storage}.ts`; and the authenticated realtime event/observer/merge integration. Security boundary tests explicitly allow only the new pure shared contract and named revision exports; no socket/test/authentication fallback is introduced into E2EE code.

## Verification

The actual frontend `SecureMessagingSession`, browser key storage and `SecureRealtimeWorkspace` run against two real isolated DATA accounts in `server/test/integration/encrypted-edits-client.test.ts`. Tests cover both senders, actual client-side encryption/decryption, realtime, history/reload, pending-request recovery, tampering, reply/forward metadata, pinned edited content and reaction preservation. `server/test/data/edits.test.ts` additionally covers sender/recipient/session/CSRF authorization, CAS races, replay, immutable storage, audit rollback, key rotation/revocation and terminal Unsend races.

`node scripts/verify-client-realtime.cjs --edit-only` (from `client`) uses separate real Chrome contexts, Next's same-origin proxy, DATA sessions and actual browser crypto. It verifies the multiline Save/Cancel UI, authenticated realtime decryption, stable identity, Edited indicators, exact-byte retries, lost-response reconciliation, offline recovery, reload/logout/login, persistent rollback refusal and Unsend. Existing full frontend/backend/DATA and compatibility regressions are run separately; no stubbed encryption or demo transport is used for edit acceptance.

Final Phase 11 validation, 2026-11-22:

| Check | Result |
| --- | --- |
| Full frontend Jest | **1,349 passed, 128 suites** |
| Full backend Node suite | **584 passed** |
| Full DATA Node suite | **326 passed** |
| Client/server TypeScript, frontend lint, DATA JavaScript syntax | Passed |
| Chrome encrypted Edit and combined pin/reply/forward/reaction/Unsend flow | **51 checks passed** |
| Chrome encrypted image/video/PDF/document regression | **47 checks passed** |
| Chrome encrypted voice-message regression | **49 checks passed** |
| Plaintext-message leaks / browser runtime exceptions in these browser runs | **0 / 0** |
| Migration 0008–0010 and Calling baseline comparison | Unchanged |

Browser evidence: `client/tmp/client-realtime-78eb0285/artifacts/browser-evidence.json` (Edit), `client/tmp/client-realtime-82a5bdd3/artifacts/browser-evidence.json` (files) and `client/tmp/client-realtime-9c6c4195/artifacts/browser-evidence.json` (voice). These are ignored local artifacts; full test logs are `.cache/phase11-{client,server,data}-final.log`.

The completed checks retain exact E2EE export/dependency allowlists and validate the optional identifier-only edit event. Pinned-message test doubles were updated to the stored-message verifier; no crypto validation was stubbed in the actual-client or Chrome acceptance flows. Browser success waits use the existing network-operation timeout after full revision verification. The rollback test covers both history and pin snapshots, including safe recovery from a fresh signed pin when history alone is stale. Final runs have no failures. No production build or independent Security audit is claimed. Existing development databases were not migrated; nothing was staged, committed or pushed.
