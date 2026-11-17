# DB-4B — Encrypted Messages & Persistence handoff

Historical DB-4B delivery snapshot. The subsequent [DATA key-directory handoff](e2ee-key-directory-handoff.md)
supersedes this report's absent-verifier/v1-only deployment state. Its test counts
and verification manifest describe that earlier phase, not the current source hashes.

Date: November 14, 2026 (local). Scope: DATA only. Branch `chuong-data`, HEAD `72f4e806e1446ce65036f705f9f7eb82275942d9` retained.

## A. Verdict

**COMPLETE for ciphertext persistence and its required security boundary.** DB-4A prerequisite tests passed before implementation. The shared write service, authorized encrypted history, durable idempotency, sender tombstones and eligible receipts work with real isolated fixtures. Production submission remains fail-closed without genuine recipient-key verification. This is not a claim of complete multi-user E2EE, live frontend delivery or Kiro Socket.IO integration. DB-5/6 were not started.

## B. Message architecture

The existing `createRepositories(db).messages` / `receipts` namespaces and the existing Messages/MessageReceipts tables remain the only store. No separate database or competing schema is added. `createMessageService` is composed as `application.messaging` with the same authoritative DB, DB-2 auth and DB-4A conversation service; adapter options cannot substitute those dependencies.

REST submission and the actor-bound future-realtime adapter call **the same submit pipeline**. It freezes/copies the validated wire envelope and trusted references, checks DB-2/4A policy, obtains bounded recipient-key attestation without holding a transaction, then uses DB-4A's immediate interaction transaction to recheck session/proof/membership/account/archive/friendship/blocks, insert or return a duplicate, update conversation activity and write metadata-only audit. Forced audit failures roll back message, sequence and conversation activity together.

Migration `0006-encrypted-message-lifecycle.sql` adds only provenance, sequence, deleted_at and revision plus authenticated partial uniqueness/history indexes/triggers. Versions 1–5 are unchanged. Existing rows default to legacy, and original columns/ciphertext/receipts remain intact. No existing record is deleted or silently promoted into verified message history.

## C. APIs

| Endpoint | Implemented result |
| --- | --- |
| `POST /api/conversations/:id/messages` | Exact version-1 wire envelope; 201 created / 200 identical retry; `{outcome,message}` |
| `GET /api/conversations/:id/messages` | Authorized `{items,nextCursor}`; encrypted active messages and explicit tombstones; default 20 / maximum 50 |
| `DELETE /api/messages/:storageId` | Current authorized sender's idempotent global tombstone; no physical deletion |
| `POST /api/messages/:storageId/read` | Current eligible recipient's idempotent first read receipt; empty body or `{}` |
| `PATCH /api/messages/:storageId` | Safely deferred: eligible sender receives 503 FEATURE_UNAVAILABLE after authorization; no ciphertext edit occurs |

Exact JSON, headers, validation/status codes and schemas are in [messaging OpenAPI](messaging-openapi.json). Only exact new paths are intercepted; existing metadata routes and closed legacy message/log handlers retain their behavior. No frontend routes or proxy files are edited.

## D. Envelope, identities and security gate

The actual client crypto and Kiro MessageEnvelope/fingerprint contracts were inspected read-only. The accepted encryption payload is exactly version=1, AES-256-GCM, encoding=base64, a canonical 12-byte IV and ciphertext longer than the attached 16-byte GCM tag, bounded to 65,536 base64 characters / 131,072 request bytes. Original id, conversationId, senderId, senderName, timestamp and type stay unchanged for GCM AAD. No plaintext, demo scope, private keys, invented key ID or separate tag is accepted.

The original client `id` is the required idempotency key and remains the wire/encrypted identity. A separate server `storageId` UUID retains DB-1's global message PK; the existing client_id holds wire id and a partial UNIQUE `(conversation_id,client_id)` aligns with Kiro's per-conversation scope. Lifecycle URLs use storageId; neither identity is substituted into the other's AAD/lookup semantics.

No actual production RecipientKeyVerifier exists in this repository. The normal entrypoint supplies none and returns 503 RECIPIENT_KEYS_UNAVAILABLE, even for a structurally valid request. Negative/malformed attestation is 403; throw/timeout is a sanitized 503. Attestation is bounded and cannot grant a late write. Test-only adapters are explicitly refused in production; no environment flag, unauthenticated internal route or HTTP test bypass exists. Isolated positive storage tests inject a branded fixture verifier into a dedicated test composition/worker and use real encrypted fixtures from the unchanged client code. See [the full E2EE storage contract](db4b-e2ee-storage-contract.md).

## E. Idempotency and concurrency

Lowercase SHA-256 over Kiro's exact fixed-order JSON envelope fields determines equality; supplied adapter fingerprints are recomputed/compared. An identical retry returns the same storage ID, sequence, original envelope and first storedAt. Different ciphertext/nonce/AAD/sender under the same conversation/wire ID returns 409 IDEMPOTENCY_CONFLICT. Independent conversations may reuse the same wire ID. A tombstoned message is never resurrected by retry.

Six simultaneous identical retries through **two independent native Node processes** produced one 201, five 200 responses, one row and one stored audit event. Changed-content races produced one creation and one conflict. Database indexes independently enforce wire-ID and sequence uniqueness; process-local caches are not the guarantee. A bound adapter write and REST retry also shared one durable result. Restart tests retained idempotency and first timestamps.

## F. Authorization, privacy and history

Sender authority comes from the verified DB-2 context, not body/header assertions. The body senderId/path must match; new senderName must match the current authenticated public name. An identical older retry preserves its original AAD after profile rename. Session/proof, active pair memberships/accounts, archive, current friendship and either-direction blocks are checked again after async verification. Tests committed a block or logout during verification and confirmed zero unauthorized writes with no transaction held open.

Unfriend preserves authorized metadata/history reads but refuses new submissions/deletion/receipts. Blocks hide both directions' history and interactions; Charlie gets the same 404 as unknown resources. Legacy messages remain omitted even in an activated DM. Responses/logs never contain private keys, private profile preferences, email credentials, tokens or raw diagnostic strings.

History is ordered by immutable per-conversation sequence descending, independent of client/server timestamp ties. An actor/conversation-bound cursor carries high-water snapshot and strict before sequence. Inserts after the first page do not shift that traversal; deletion preserves its row/position and can appear once as current tombstone state. Reads are bounded limit+1 indexed queries. Every page reapplies current authority; snapshots are not privacy grants and do not freeze later deletion state.

Shared SQLite rates protect history, submission, editing, deletion and read receipts. Current policy: history/read 120/minute/actor; submit/edit/delete 60/minute/actor; mutations also 240/minute/direct source. Forwarded identity/IP headers do not bypass them. Existing Origin, HttpOnly session, CSRF, no-store, body size/type/encoding and safe error behavior are retained.

## G. Shared write service and Kiro boundary

`application.messaging.submit(context,proof,id,envelope)` is authoritative. `bindStore(trustedContext,trustedSessionProof)` returns storeMessage/findMessage/recordReceipt methods with created/duplicate/conflict and Date result shapes compatible with the inspected Kiro contracts. Tests compare the actual Kiro parser/fingerprint and receipt shapes; there is no live socket test or wiring.

The existing global Kiro MessageStore interface does not carry per-call trusted session/proof references. Its owner must thread a secure actor binding; an Alice-bound store cannot be installed globally for every actor. Separate-process integration cannot be solved by importing DATA code or trusting envelope.senderId. The available remote boundary is authenticated HTTPS REST with the actual bound session/proof/original validated Origin. Current Kiro credential propagation is absent; an alternate service-to-service protocol requires Security approval, not a new unauthenticated write endpoint. See [the complete realtime handoff](db4b-realtime-integration.md).

Only committed persistence may be acknowledged/fanned out. Duplicate events return first storage time without creating another row. Recipients must be reauthorized before delivery; delivery/read acknowledgement does not follow automatically from persistence. DATA emits nothing and provides no exactly-once delivery/outbox claim.

## H. Lifecycle

- **Edit deferred:** no agreed encrypted revision/conflict protocol exists; original encrypted identity/envelope remains immutable. No plaintext patch or unversioned replacement is introduced.
- **Delete supported:** sender-only global tombstone under current interaction policy. First deletion sets deletedAt and revision=1; retries preserve them. History hides encrypted bytes on tombstones but physical ciphertext remains in storage/devices/backups. Per-user hiding and unread-count APIs are not implemented.
- **Receipts supported:** only an eligible non-sender recipient can create read/delivered observations. REST exposes read only; the bound future-realtime adapter accepts delivered only for a trusted recipient acknowledgement. First observations survive retry/restart. A new receipt for a tombstone is refused; an existing one remains idempotently retrievable. No automatic fake delivery is recorded.

## I. Persistence and required real HTTP scenario

Isolated accounts use actual DB-2 registration/login and CSRF, establish DB-3 friendship, create a real DB-4A DM and both retrieve its metadata. The dedicated test worker then accepts an actual client-encrypted fixture through the normal documented REST path with explicitly injected test attestation. Identical retry yields one record, paginated history is accessible to members and refused to Charlie, and a second native process reopens the same isolated SQLite database. Ciphertext, memberships, storage ID, original storedAt, duplicate outcome and receipt survive. A later block rejects submission/history.

Normal DATA entrypoint fail-closed behavior is tested separately, so the storage scenario does not disable production E2EE gates. No user's development database is used as a fixture or restarted/migrated by this task. No browser or live realtime verification is claimed.

## J. Exact DB-4B paths

```text
DATA/server/database/migrations/0006-encrypted-message-lifecycle.sql
DATA/server/database/repositories.js
DATA/server/messaging/validation.js
DATA/server/messaging/service.js
DATA/server/routes/messaging.js
DATA/server/app.js
DATA/tests/support/messaging.js
DATA/tests/support/messaging-worker.cjs
DATA/tests/messaging-http.test.js
DATA/tests/messaging-security.test.js
DATA/tests/messaging-pagination.test.js
DATA/tests/messaging-concurrency.test.js
DATA/tests/messaging-contracts.test.js
DATA/tests/messaging-migrations.test.js
DATA/tests/migrations.test.js
DATA/tests/auth-migrations.test.js
DATA/tests/social-migrations.test.js
DATA/tests/conversations-migrations.test.js
DATA/README.md
DATA/docs/schema.md
DATA/docs/migrations.md
DATA/docs/repositories.md
DATA/docs/messaging-openapi.json
DATA/docs/db4b-handoff.md
DATA/docs/db4b-frontend-integration.md
DATA/docs/db4b-realtime-integration.md
DATA/docs/db4b-e2ee-storage-contract.md
DATA/docs/db4b-verification.json
```

Earlier migration-test expectations now include version 6 and assert all original fields plus exact additive defaults, without weakening old data/checksum assertions. Prior applied SQL files are unchanged. No package/dependency or frontend/Kiro source change is needed.

## K. Verification

| Check | Result |
| --- | --- |
| Pre-edit DB-1/2/3/4A prerequisite (`npm test`) | 247 passed, zero failures |
| Final full DATA suite (`npm test`) | **288 passed, zero failed/skipped/canceled**, 53.126 seconds |
| New messaging coverage | **41 tests** across six files, plus test-only fixtures/workers |
| Existing regressions | All 247 DB-1/2/3/4A tests retained and passed |
| Real HTTP, native restart, concurrency/idempotency | Passed with isolated test DBs, actual cookies/CSRF/Argon2 and genuine client-encrypted fixtures |
| Migration preservation/repeat/rollback | Passed, including legacy ciphertext/receipts and prior history |
| Syntax / OpenAPI references | All 13 changed JavaScript files parse; all 63 local OpenAPI references resolve |
| Whitespace / ownership | `git diff --check` passed; all 28 phase paths are under DATA; 61 existing outside-DATA files retain their hashes |

Node 24.20.0 transforms the existing TypeScript crypto/contract sources only in test memory. Node prints its expected experimental stripTypeScriptTypes warning; it does not indicate a failing test or backend runtime dependency. The initial upgrade-test expectation was adjusted for the additive columns while retaining every earlier field and validating the new legacy/null/zero defaults. No test is skipped, removed or replaced with fake authentication.

## L. Known limitations

Genuine recipient-key verification, secure Kiro per-call credential/context propagation, frontend mappings/composer integration and production TLS/deployment remain owning-team dependencies. Default production message submission remains unavailable by design. Structural envelope validation and isolated test attestation are not E2EE completion. No encrypted editing, per-user hiding, unread counts, durable fan-out/outbox, groups, attachments or backend key exchange is implemented.

## M. Codex / Kiro handoff

Codex must adopt the exact wire/storage ID distinction, same-origin API allowlist, original AAD, encrypted retry behavior, snapshot cursor and tombstone rendering. Kiro/Security must bind actual authenticated session/proof to the shared service, supply genuine current recipient-key verification, reauthorize recipient delivery and acknowledge only durable outcomes. Existing fingerprint validation is compatible, but missing credential context is not repaired by trusting a client sender field. Full contracts are in the four accompanying API/frontend/realtime/E2EE documents.

## N. Ownership and stop boundary

The pre-edit tree contained 127 changed/untracked files, including 61 outside DATA. The final read-only status/hash audit found no missing baseline files or changes outside DATA; all 61 outside-DATA hashes match the pre-edit snapshot. Migrations 1–2 match HEAD after line-ending normalization and migrations 3–5 match their pre-edit byte hashes. The branch and HEAD remain unchanged. Exact phase paths and SHA-256 hashes are recorded in [db4b-verification.json](db4b-verification.json), with its own hash omitted to avoid a self-reference. Original user work, records and previous phase reports are preserved. No commit, push, branch change, reset, stash, clean, merge or rebase is performed.

DB-4B stops here. No DB-5/6, frontend send activation or live Kiro integration is started.
