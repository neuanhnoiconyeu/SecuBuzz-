# Client E2EE integration — post DB-4B

Date: November 15, 2026. Ownership: client only. This dependency task does not implement Phase 9/10, Socket.IO server delivery, DATA migrations, AI features or an unrelated UI redesign.

November 16 update: the client now integrates Kiro's authenticated v2 Socket.IO server. [Realtime integration](REALTIME_CLIENT_INTEGRATION.md) supersedes the REST-only transport/presence/readiness statements below. This document retains the original crypto and storage implementation record.

The real-account workspace now supports persistent browser device keys, authenticated registration, peer-key review, signed HPKE epochs, envelope-v2 encrypted REST persistence and locally decrypted history. It uses the completed DATA migration-7 implementation and Kiro's existing secubuzz-dm-keys v1 protocol. This is usable for the documented REST flow; it is not a production security approval or a claim that live socket messaging is ready.

## Audit and architecture

Authoritative sources inspected: DATA/docs/e2ee-key-directory-handoff.md, e2ee-frontend-integration.md, e2ee-keys-openapi.json, e2ee-realtime-integration.md, messaging-openapi.json and db4b-frontend-integration.md; docs/e2ee-recipient-key-integration.md; server/src/e2ee/ and server/test/e2ee/, including vectors/protocol-v1.json. Existing client AES-GCM, demo key manager, authentication/CSRF, real workspace, proxy and SocketIoRealtimeClient were inspected.

The demo still uses its existing page-local InMemoryDemoKeyManager and v1 crypto. Real sessions use the independent SecureMessagingSession and never instantiate a demo transport, generate a pretend recipient or fall back to plaintext. No server crypto module is bundled in the client; its Node-only code is read-only. The browser implementation independently follows the exact canonical statements and passes the owning protocol vectors.

| Module | Responsibility |
| --- | --- |
| src/security/e2ee/model.ts | Wire/storage/device/error types with fixed safe messages |
| protocol.ts | Canonical statements, public-point/record/signature validation and strict v2 parsing |
| devices.ts | Non-extractable device identity, restoration/possession checks, registration and safety number |
| storage.ts | Account-scoped IndexedDB records, atomic enrollment/pending writes and durable nonce reservations |
| hpke.ts | Small wrapper around pinned @hpke/core; no improvised ECDH/KDF/wrapping |
| messages.ts | Client-only AES-256-GCM v2 encryption/decryption and authenticated metadata |
| api.ts | Strict typed DATA projections over the existing SessionApi |
| session.ts | Device lifecycle, trust, current epochs, historical keys, pending sends and disposal |
| SecureConversationPanel.tsx | Authenticated controller using the original chat presentation and secure device states |
| components/messenger/authenticatedChatPresentation.ts | Decrypted-row, receipt, conversation and connection view models; no crypto or transport implementation |

RealMessengerWorkspace continues to own profiles/friends/navigation and scopes resources to its authenticated session lifecycle. Old resources are disposed and the subtree remounts when the API resource generation changes, including development StrictMode. Plaintext drafts/history live in React memory and disappear on account replacement/logout/unmount; they are not persisted as plaintext. Persistent device/epoch keys remain enrolled locally after logout, by design.

### Original chat presentation with real services

Authenticated chats reuse ConversationSidebar, ConversationHeader, MessageList
and MessageComposer, including their theme tokens, bubbles, grouping, entry motion,
emoji input and responsive navigation. The YahooChatWindow demo controller is not
mounted for real accounts: its mock transport and page-local crypto remain demo-only.
The presentation adapter accepts authenticated conversations and already decrypted
rows from SecureMessagingSession/SecureRealtimeWorkspace. Ciphertext is never used
as a message preview or a placeholder for successful decryption.

Per-conversation drafts survive conversation changes, secure refresh, reconnect,
Friends navigation and Meeting Rooms navigation. Drafts remain in session memory;
logout, account replacement and browser reload do not persist plaintext drafts.
Sent means persisted; delivered/read require matching realtime receipts. Loading
older history preserves the current scroll position. Hidden chats, including the
mobile conversation list and Meeting Rooms, do not issue visible-chat read receipts.

Transport selection, manual secure refresh, reconnect and browser key management
live in collapsed Advanced settings. Enrollment, revocation and changed-contact-key
warnings remain actionable in the visible chat or mobile conversation list.
Enrollment confirmation and non-extractable persistent key handling are unchanged.
Unverified group/file/voice/direct-call controls are not offered by the real text
composer; their existing separate implementations are preserved. Meeting Rooms
navigation remains available without substituting its transport for DATA messaging.

Run `npm test -- --runInBand --roots src` for source regressions and
`npm run test:realtime:browser` for isolated browser verification. Browser evidence
and redacted screenshots are saved under a unique `tmp/client-realtime-*` directory,
without opening the user's browser profile or modifying the development database.

## Device identity and IndexedDB

New device creation always requires explicit enrollment, including an account's
first device. Startup restores an existing identity or offers **Enroll this
browser**, followed by a confirmation explaining historical-key limitations.
Registration uses the existing authenticated DATA SessionApi and CSRF proof;
private keys remain non-extractable and are never uploaded.

A revoked identity is never reactivated or replaced in place. For an account
whose devices are all revoked, use a fresh browser profile at the same application
address, sign in, and confirm enrollment there. Preserve the original profile and
IndexedDB for any history it can still decrypt. New devices do not automatically
receive old epoch keys; contacts must review changed device sets. The application
does not offer automatic key reset, identity replacement or password-based key
recovery. A generic registration conflict is reported as a conflict, not proof
that the device was revoked.

The origin database is secubuzz-e2ee-v1, schema version 1. Its two object stores are records and nonces. Record keys are JSON arrays prefixed by the SessionApi actor ID, never an actor selected from request body input.

| records key suffix | Value |
| --- | --- |
| device, empty ID | Schema-1 identity: user/device/key IDs, keyVersion=1, public points and ECDSA/ECDH CryptoKeyPairs |
| enrolled, empty ID | Marker detecting a missing/corrupted identity without silently replacing it |
| trust, peerUserId | Previously accepted peer deviceKeyIds |
| verified-device, deviceKeyId | Verified public record retained for historical creator verification |
| epoch, JSON([conversationId,keyId]) | Signed epoch, verified creator public record and non-extractable AES CryptoKey |
| pending, conversationId | One original encrypted v2 envelope awaiting a durable outcome; no plaintext |

Device signing is ECDSA P-256/SHA-256, 64-byte IEEE P1363 signatures. Agreement is ECDH P-256. Both persistent private keys are generated non-extractable and structured-cloned into IndexedDB as CryptoKeys, never plaintext JWK/PKCS8 exports. Public uncompressed P-256 points are 65 bytes, canonical unpadded base64url. deviceId is 16 random bytes (22 characters); deviceKeyId is the 32-byte SHA-256 digest specified by Kiro over both public points. First enrollment uses keyVersion=1.

Restoration checks account ownership, formats, algorithms/usages, non-extractability, public-point exports, derived ID and both private/public associations. A signing challenge and a temporary ECDH agreement comparison prove the stored pairs match; temporary agreement bytes are zeroed. Atomic IDB enrollment serializes simultaneous tabs into the same stored identity.

If an identity is missing but the enrolled marker remains, initialization stops as corrupted. If all local data is missing while the server lists devices, the user must explicitly choose “Enroll this browser — older history may be unavailable.” A new browser is a new device, not key recovery. Corrupted/unavailable storage has no memory/localStorage fallback. Existing local revoked/superseded keys never silently become a replacement identity; new sends stop. The UI supports owner revocation of this browser, with an explicit permanent-revocation confirmation; already received keys are not erased and authorized historical reads remain possible where keys exist. An in-place long-term device-pair rotation management UI is not included; server-side supersession fails this local identity closed.

IndexedDB account namespacing prevents accidental application account mixing. It does **not** isolate keys from malicious same-origin JavaScript, a compromised browser/extension, origin storage inspection or an unlocked OS/browser account. Non-extractable keys can still be used by compromised origin code. Password reset is not E2EE recovery. Clearing site data can permanently lose access to older messages; no private-key backup/recovery protocol is invented.

## HPKE and epochs

Runtime dependency: @hpke/core 1.10.1, locked in client/package-lock.json. It is the maintained [HPKE-JS WebCrypto implementation](https://github.com/dajiaji/hpke-js). Production uses RFC 9180 mode_base, DHKEM(P-256, HKDF-SHA256) KEM 0x0010, HKDF-SHA256 KDF 0x0001, AES-256-GCM AEAD 0x0002, single-shot/sequence 0. No test HPKE implementation was copied into production.

Recipient operations supply a CryptoKeyPair, so the library does not try to derive/export a public key from a non-extractable private key. Long-term private keys never require an extractable fallback. The library owns transient per-wrap ephemeral key objects; these may be extractable internally, are not persisted/uploaded/exported by this integration and last only for the wrap operation/garbage collection. The browser briefly holds 32 random AES key bytes while wrapping them for all active devices; our buffer is zeroed in finally. Unwrapped bytes are immediately imported non-extractable, then zeroed. JavaScript zeroing is best effort and cannot guarantee removal of every runtime/library copy.

Every preparation fetches authoritative DM participants and current key state through SessionApi, validates active device records and self-signatures, and requires this browser's active identity. Every participant must have a device. Public point encoding, coordinate bounds/on-curve import, distinct signing/agreement points, IDs, timestamps, signatures and canonical ordering are checked; no success flag from DATA is treated as a signature substitute.

If the current epoch matches all active devices and has a valid active creator/signature, this browser opens its own wrap. If coverage changed, a new random conversation key is wrapped for every active device of **both** participants, strictly sorted by userId then deviceKeyId. The creator signs Kiro's exact fixed-order epoch statement. Publication uses current+1 and previousKeyId, with a fresh keyId. A known 409 RECIPIENT_KEYS_CHANGED permits one bounded refetch/revalidation before encryption; no ambiguous network outcome causes an automatic different-key message retry.

Peer device sets are pinned with trust on first use. A changed set blocks preparation/sending and presents old/current IDs plus an explicit trust action. The action fetches state again and accepts only the exact set the user reviewed; another change requires review again. Own additional devices cause exact-set epoch renewal; peer additions, rotations or removals require review. A safety number follows Kiro's canonical account/device-key digest and can be compared through another channel. The UI labels server-authenticated/TOFU trust accurately; it does not claim independent identity verification or malicious-server resistance.

Historical decryption first validates a cached signed epoch/key. If necessary it retrieves the old signed epoch, uses a previously verified creator record and opens this browser's own old wrap. A pending review of new peer keys does not block old keys/signed wraps already authorized to this device. An unknown historical creator requires current validated trust; retired-peer-key discovery and historical rewrapping are absent from DATA's six-route contract. New devices cannot recover keys for wraps they never received. Missing wraps/keys and bad signatures/tags produce safe “Unable to decrypt” states rather than ciphertext/plaintext substitution.

## V2 and nonce handling

The real wire body is exactly:

```js
{id,conversationId,senderId,senderName,timestamp,type:'text',
 encryption:{version:2,algorithm:'AES-256-GCM',encoding:'base64',keyId,iv,ciphertext}}
// UTF-8 AES-GCM AAD, byte-for-byte:
JSON.stringify(['yahoo-security-messenger',2,conversationId,id,
 senderId,senderName,timestamp,'text',keyId])
```

keyId is 16 canonical base64url bytes. IV is 12 cryptographically random bytes, canonical padded base64. Ciphertext contains the attached 128-bit tag, decodes to more than 16 bytes and is at most 65,536 base64 characters. Plaintext is limited to 49,136 UTF-8 bytes before encryption; the minimal composer also bounds input length. DATA's total request limit remains 131,072 bytes. Unknown fields, demo markers, plaintext, separate tags, raw/private keys and unsupported algorithms are rejected before outgoing transport. Strict registration/publication API checks likewise reject unexpected secret fields before any request.

The nonces store atomically reserves JSON([accountId,'nonce',JSON([materialId,base64Iv])]). materialId is a **local SHA-256 bookkeeping digest of the unwrapped random AES bytes**, not an encryption key or network field. This makes the guard survive refresh/re-import and cover accidental reuse of the same AES material under another keyId/conversation within this account/browser store. Reservations remain consumed even after failure, and quota/storage failures stop encryption. Sixteen failed collision attempts stop the operation. Independent browsers/devices still rely on the protocol's cryptographically random 96-bit nonce collision bound; there is no invented global nonce-allocation protocol.

Only ciphertext envelopes reach DATA. Decryption validates the original metadata, signed epoch and key before WebCrypto authenticates the tag and UTF-8 decoding. Modification of conversation, sender/name, message ID, timestamp, keyId, IV or ciphertext fails authentication. v1 remains confined to the existing demo/local cryptography; real historical v1 rows without a legitimately held old key render unavailable, never verified multi-user E2EE.

## DATA transport and lifecycle

E2eeApi shares the existing HttpAuthService SessionApi: same-origin HttpOnly session, current-identity checks before and after operations, existing CSRF bootstrap for mutations, no-store, cancellation and account invalidation. No second production authentication system, service token, bearer header or fabricated Origin was added. authProxy.cjs adds only the explicit six key operations and DB-4A/4B conversation/message paths; production target validation still requires HTTPS. There is no blanket proxy or internal unauthenticated route.

| Operation | Endpoint |
| --- | --- |
| Register/list/revoke device | POST/GET /api/keys/devices; POST /api/keys/devices/:deviceId/revoke |
| Discover current devices/epochs | GET /api/conversations/:id/keys |
| Retrieve/publish signed epoch | GET /api/conversations/:id/keys/epochs/:keyId; POST /api/conversations/:id/keys/epochs |
| List/create/read direct conversations | GET /api/conversations; POST /api/conversations/dm; GET /api/conversations/:id |
| Submit/history | POST/GET /api/conversations/:id/messages |
| Eligible read/sender tombstone service methods | POST /api/messages/:storageId/read; DELETE /api/messages/:storageId |

Key-list pagination uses DATA's cursor; message history uses nextCursor with max 50 rows per request. The UI loads older messages explicitly and keeps immutable sequences/tombstones. Stable wire id is authenticated metadata/idempotency; storageId is the server UUID for lifecycle URLs. Metadata/timestamps are never substituted into AAD. Typed projections reject malformed, foreign-account or wrong-conversation results.

One encrypted pending envelope per conversation is stored **before** the first POST. It survives refresh; retries keep exactly its ID, timestamp, IV and ciphertext. A confirmed result clears only that same pending ID, so a late duplicate acknowledgement cannot erase a newer pending send. Ambiguous errors preserve it. Reconcile/retry scans at most 20 history pages (1000 rows), then resubmits the identical envelope only if its epoch is still current/valid. An already-stored old-epoch message may now get 403 before DATA's duplicate lookup: do not re-encrypt it or silently generate a second logical ID. An unresolved old pending message stays blocked pending history/manual reconciliation; unbounded search, automatic discard and automatic changed-key resend are not implemented.

API error mapping distinguishes missing recipient devices, changed keys, unverified keys, proof/conflict/device limits, unavailable verifier, idempotency conflict, session/CSRF/authorization, rate limiting and network errors. Read receipts are available as a service method but not fabricated automatically by persistence/decryption. Encrypted editing remains deferred. The real workspace uses explicit manual REST refresh, with no invented realtime transport, presence or delivery guarantee.

## Commands, evidence and limits

```powershell
cd D:/Projects/SecuBuzz-/client
npm ci
npm test -- --runInBand
npm run type-check
npm run lint
npm run build:verify
npm run test:e2ee:browser
```

The DATA backend requires Node 24.20.0 (verified runtime) and its existing dependencies installed; the integration tests import no test verifier. Browser verification uses the installed Chrome executable, or CHROME_PATH. It starts a normal DATA entry point on an ephemeral port with a new DB under client/tmp and a separate Next dev process/output plus isolated Chrome contexts. No existing service is inspected/stopped/restarted or existing development DB used. The build verifier runs a real production next build with an isolated output and compile-only HTTPS target; it does not deploy or contact that placeholder. CLIENT_TEST_DIST_DIR is validated and affects only isolated build/type-config files, leaving normal asset directories and the main tsconfig intact.

New test dependencies are fake-indexeddb 6.2.8 and @playwright/test 1.65.1. The root optional lockfile-ignore rule is overridden inside client so the exact dependency lock is reviewable. Runtime dependencies are not auto-upgraded beyond the selected HPKE addition. npm reported 17 dependency advisories (6 low, 6 moderate, 4 high, 1 critical); dependency triage/security release review remains required, and this task does not claim an audited dependency clearance.

The pre-edit suite passed 794 tests. The final full suite passes **810 tests in 70 suites, zero failures/skips**, including 16 new tests. Typecheck, lint and an isolated production Next build pass; lint retains only the two existing image-element warnings. New coverage includes actual Kiro protocol-v1.json, RFC 9180 A.3.1, real WebCrypto/HPKE, account-scoped IndexedDB persistence/corruption/unavailability, cross-tab enrollment/nonce reservations, forbidden secret-field uploads, independent Alice/Bob/Charlie and a normal DATA process, backend stop/restart, stale epochs, device changes/revocation and ambiguous-send reconciliation. One existing multi-account UI integration test has a scoped 15-second budget instead of the flaky five-second default; all its assertions remain. Its real-workspace heading expectation changes to the new conversation panel.

Actual browser evidence passes **21 checks** covering independent authenticated accounts, device enrollment, friendship/DM, both encrypted directions through DATA, Charlie's denied access, refresh/same-device restoration, local history decryption, key-change blocking/review, new-device epochs without historical recovery, revocation, mobile layout, light/Midnight System appearance, fonts, account switching, no plaintext requests and no runtime exceptions. Browser checks are separate from unit tests. Screenshots blur synthetic message content; evidence stores route/status/boolean results without cookies, private keys or decrypted messages.

Exact final counts, build/lint/type results, ownership and file hashes: [verification manifest](artifacts/client-e2ee/verification.json). Browser steps: [browser evidence](artifacts/client-e2ee/browser-evidence.json). Exact files: [file list](E2EE_FILES.md). See [Kiro handoff](E2EE_KIRO_HANDOFF.md) for remaining socket work. Manual REST secure messaging is usable; production release still requires socket integration where desired, broader browser/support testing and security/dependency review. No full production E2EE readiness is claimed.
