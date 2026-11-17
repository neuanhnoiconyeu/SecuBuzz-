# DATA E2EE key directory and DB-4B integration handoff

Date: November 14, 2026 (America/New_York). Post-DB-4B dependency task; not Phase 9/10. Branch chuong-data and HEAD 72f4e806e1446ce65036f705f9f7eb82275942d9 retained.

## A. Verdict

**COMPLETE for the requested DATA-side dependency.** Migration 7, all six agreed key operations, the actual Kiro protocol/verifier, authoritative directory snapshots and envelope-v2 shared persistence are implemented and verified. Legitimate authenticated v2 messages pass real persisted-key verification without mock success. Missing infrastructure stays unavailable and invalid/stale/revoked state stays refused. This does not claim full product E2EE, browser readiness or Socket.IO integration.

## B. Audit findings and compatibility

The authoritative handoff is docs/e2ee-recipient-key-integration.md §9; server/src/e2ee/, its tests, and .kiro/specs/e2ee-recipient-keys/ were inspected read-only, alongside DB-2/3/4A/4B contracts and migrations 1–6. The initial DATA suite passed 288/288. The starting tree already contained 182 dirty/untracked paths, 98 outside DATA; their hashes and migration bytes were captured before editing.

The six operations are listed below. The existing production seam was async verifyEnvelope(actor,envelope,{conversationId,recipientIds,fingerprint}) with no directory. Messages' base CHECK and migration-6 authenticated trigger permitted v1 only. V2 adds encryption.keyId and changes AAD/fingerprint. Node 24.20.0 can load the Kiro public TypeScript ESM entry directly from DATA CommonJS; required functions exist, so no Kiro-owned source/package change was needed. A single DATA protocol boundary loads that API and checks required exports; missing/incompatible exports fail closed.

## C. Migration 7 and preservation

Migration 0007-recipient-keys.sql adds DeviceKeys, ConversationKeyEpochs and ConversationKeyWraps to the same database. Device records bind signing/agreement public points and self-signature to the account, globally stable deviceId, monotonic keyVersion and permanent status history. Composite owner FKs prevent cross-user creator/recipient key association. Partial active-device uniqueness, ten-device limit, ordered epoch uniqueness/predecessor FKs, bounded wrap positions and history indexes are enforced. Material, epochs and wraps cannot be updated/deleted; device states only move active→superseded/revoked or superseded→revoked.

Messages is rebuilt to permit v1/v2 and add immutable key_id, NULL for legacy/v1 and a conversation-epoch FK for v2. Every prior column/value, storage/wire ID, fingerprint, timestamp, sequence, tombstone, receipt and attachment reference is preserved. Existing named indexes/triggers and foreign keys are restored. The runner retains foreign_keys=ON throughout its existing immediate transaction: transaction-local copies preserve the two dependent tables during rebuilding; a foreign-key check precedes commit. No writable-schema/foreign-key-disable mechanism is used. Forced failure after the rebuild restores all original schema, data and migration ledger. Migrations 1–6 remain byte-for-byte unchanged. No existing development database was migrated.

## D. Six APIs and authorization

| Method / endpoint | Result |
| --- | --- |
| POST /api/keys/devices | Session-bound signed registration/rotation, 201 created or 200 duplicate, {device} |
| GET /api/keys/devices | Own records, all statuses, newest first, max 50, {items} |
| POST /api/keys/devices/:deviceId/revoke | Owner revokes every version permanently, {outcome:revoked/unchanged} |
| GET /api/conversations/:id/keys | Authorized participant IDs, active devices, currentEpoch, latest 20 epochs and cursor for older |
| GET /api/conversations/:id/keys/epochs/:keyId | Authorized signed historical epoch plus all ordered opaque wraps |
| POST /api/conversations/:id/keys/epochs | Current friendship and complete signed active-device coverage; 201 created or 200 duplicate, {epoch} |

These are exactly the six §9.2 operations; there is no invented seventh wrap route. Full signed wraps permit signature verification; only the holder of the corresponding device private key opens its wrap. Response projections match the handoff and omit private/raw keys and internal digest/status-change metadata. The agreed key-list cursor is named cursor; message history continues using nextCursor. Read authority is reapplied on every page. [OpenAPI](e2ee-keys-openapi.json) specifies exact fields, limits and safe errors.

## E. Actual verifier integration

DATA imports validateDeviceRegistration, planDeviceRegistration, planDeviceRevocation, planEpochPublication, parseMessageEnvelopeV2, envelopeV2Fingerprint, createRecipientKeyVerifier and verifyRecipientKeysSync from the unchanged Kiro public API. No cryptographic rules, signatures, HPKE implementation or key exchange is copied into production DATA code.

The SQLite directory derives the actual authenticated/unarchived direct participants using DB-4A's active-account/member/block visibility policy. A read transaction loads only their active public devices, current epoch and requested epoch with ordered wraps. Its synchronous read requires a caller transaction. createApp composes the real verifier by default, so the normal entry point requires no key-verification feature flag or test injection. Missing/invalid module exports leave key operations and v2 parsing unavailable; directory errors/timeouts are sanitized 503. No client verification-success flag is accepted.

## F. DB-4B verified submission

Both REST and the existing trusted actor-bound store call the same submit service. Kiro parses the immutable v2 envelope and recomputes the exact fingerprint including keyId. Authenticated sender/path and actual recipient come from DB-2/4A, not body assertions.

The bounded async verifier runs without an open transaction. Before duplicate lookup or insertion, a second immediate transaction rechecks session/proof/member/accounts/archive/friendship/blocks, reads fresh key state on the same connection and calls Kiro's verifyRecipientKeysSync. Current epoch/keyId, valid public records/signatures, creator signature and exact active-device coverage must still match. A v2 service without that sync recheck fails closed. Adapter options cannot replace the application's authoritative check or DB/auth/conversation dependencies.

Default sending rejects v1 with 403 RECIPIENT_KEYS_UNVERIFIED; structural parsing never relabels it verified. Approved historical v1 remains readable with its original AAD; unapproved legacy-origin history remains hidden under DB-4B policy. V2 history returns encryption.keyId. Wire id, separate storageId, immutable sequence/snapshot pagination, sender tombstones and eligible idempotent receipts are preserved. Editing remains deferred.

## G. Security

All key APIs use actual DB-2 identity; mutation proofs are verified again inside the write transaction. Existing Origin/Fetch Metadata/HttpOnly-cookie/TLS policies remain intact. Device discovery is limited to the caller's own list or an authorized DM's public participant devices. Revocation is owner-only, including permanent revocation across all versions. Publication requires current friendship, active creator and exact device coverage. Blocks hide metadata/history/key reads in both directions; unfriending preserves authorized historical reads while denying publication and message interaction.

Strict Kiro shape/encoding/signature/freshness rules reject user/creator/private-key fields, spoofed devices, cross-account statements, stale/replayed versions and malformed epochs. Device JSON bodies are bounded to 8192 bytes; epochs to 16384; message bounds remain 131072 bytes/65536 ciphertext base64 characters. Key mutations share 30/minute/actor and 120/minute/direct source; reads share 120/minute/actor in SQLite. Forwarded IP headers do not grant authority or extra quota. Safe errors reveal no input, private diagnostics or key material; audit stores operational metadata only.

Registry verification is server trust plus client TOFU, not proof against a malicious registry operator. A stolen session/proof can enroll another device; client key-change review and account/device recovery remain necessary. The server cannot prove a sender truly encrypted ciphertext with the named key.

## H. Concurrency and idempotency

Two independent native DATA processes racing registration produced one 201, one 200, one row and one audit event. Competing different publications at the same epoch produced one 201 and one 409 RECIPIENT_KEYS_CHANGED, with one epoch and its complete wraps. Six verified v2 retries across two native processes produced one 201, five 200, one ciphertext row and one stored audit event with identical first metadata.

A genuine async verification was held while a revocation, epoch rotation or new device committed; each final sync recheck returned 403 and stored zero messages. No transaction was held across the await. Forced audit failures rolled back supersession/insertion, revocation, epoch plus wraps, and the existing message/lifecycle changes atomically.

Retries reapply current key state before duplicate lookup, as §9.3 requires. After rotation a previously committed old envelope can now receive 403. Clients must reconcile durable history after an uncertain outcome before re-encrypting; an existing wire ID cannot be reused with a changed fingerprint. No idempotency record is rewritten or tombstone resurrected.

## I. Persistence and upgrade

Disposable v6 databases containing legacy ciphertext, approved v1/tombstone rows, receipts and attachment references upgraded with every original value intact; prior checksums/index/trigger names survived and foreign_key_check/integrity_check passed. Repeat migration applied nothing. Forced migration failure restored original schema, values and ledger.

Actual HTTP accounts registered/logged in with Argon2/cookies/CSRF, established friendship and created a real DM. Independent simulated WebCrypto devices published signed HPKE wraps, submitted v2 through normal REST with the genuine verifier and decrypted as the actual recipient simulator. The fixture HTTP service was stopped; a native normal DATA process wrote the message and receipt, then stopped. A replacement native process reopened the isolated database; public keys, signatures, ordered wraps, current epoch, ciphertext, history, receipts, IDs and duplicate timestamps survived. Only the isolated observer connection remained for assertions. User development services and databases were not touched.

## J. Tests

| Check | Result |
| --- | --- |
| Pre-edit full DATA baseline | 288 passed, 0 failed/skipped |
| Final npm test in DATA | **321 passed, 0 failed, 0 skipped, 0 canceled**, 70.941 seconds |
| New DATA-specific tests | 22 across HTTP/security/concurrency/migrations |
| Unchanged Kiro suites reused | 7 reusable directory-contract tests against DATA SQLite/auth; 4 interoperability-vector tests |
| Retained regressions | All 288 DB-1/2/3/4A/4B tests pass |
| Syntax | All 22 changed/new JavaScript files parse |
| OpenAPI / ownership / whitespace | Final machine-readable results in e2ee-verification.json |

Existing migration tests now expect additive version 7 and NULL key_id, retaining original field/checksum/data assertions. The one default-entrypoint v1 assertion now expects 403 from the genuine verifier instead of the old absent-verifier 503. Existing isolated branded v1 storage fixtures remain test-only; production still refuses testOnly verifiers. No test was skipped or removed. Node's existing stripTypeScriptTypes warning is expected in older fixture imports and does not indicate a failing test.

The initial focused run exposed two fixture mistakes (missing attachment byte_size and an already-consumed rate slot); those fixtures were corrected and all final checks pass. No full server suite, browser or live Socket.IO verification is claimed. Kiro's historical pre-integration DATA seam test remains read-only and needs owner updates to its old default/v2 expectations.

## K. Exact changed paths

```text
DATA/README.md
DATA/docs/db4b-e2ee-storage-contract.md
DATA/docs/db4b-frontend-integration.md
DATA/docs/db4b-handoff.md
DATA/docs/db4b-realtime-integration.md
DATA/docs/e2ee-frontend-integration.md
DATA/docs/e2ee-key-directory-handoff.md
DATA/docs/e2ee-keys-openapi.json
DATA/docs/e2ee-realtime-integration.md
DATA/docs/e2ee-verification.json
DATA/docs/messaging-openapi.json
DATA/docs/migrations.md
DATA/docs/repositories.md
DATA/docs/schema.md
DATA/server/app.js
DATA/server/database/migrations/0007-recipient-keys.sql
DATA/server/database/repositories.js
DATA/server/e2ee/directory.js
DATA/server/e2ee/protocol.js
DATA/server/e2ee/repository.js
DATA/server/e2ee/service.js
DATA/server/messaging/service.js
DATA/server/messaging/validation.js
DATA/server/routes/keys.js
DATA/tests/auth-migrations.test.js
DATA/tests/conversations-migrations.test.js
DATA/tests/e2ee-concurrency.test.js
DATA/tests/e2ee-contracts.test.js
DATA/tests/e2ee-http.test.js
DATA/tests/e2ee-migrations.test.js
DATA/tests/e2ee-security.test.js
DATA/tests/e2ee-vectors.test.js
DATA/tests/messaging-migrations.test.js
DATA/tests/messaging-security.test.js
DATA/tests/migrations.test.js
DATA/tests/social-migrations.test.js
DATA/tests/support/e2ee.js
```

No package/lockfile, environment file, running-service configuration or dependency is changed by this task. The verification artifact records phase-specific hashes against the pre-edit snapshot, rather than treating all pre-existing Git changes as this task's work. Its own hash is omitted to avoid self-reference.

## L. Setup and production readiness

Runtime verified: Node 24.20.0, existing DATA dependencies and unchanged sibling Kiro protocol source. No new package dependency, protocol build artifact or key-verification environment switch is required.

From a fresh checkout with dependencies absent, install DATA's existing lockfile using npm ci. Tests choose isolated temporary DBs/processes themselves. These are the exact verification commands:

```powershell
cd D:/Projects/SecuBuzz-/DATA
node --version
npm test
git diff --check
git status --short
```

For a manual isolated DATA instance, use a **new temporary database**, never the existing development DB. The commands below are instructions for a future operator; they were not run against user services:

```powershell
cd D:/Projects/SecuBuzz-/DATA
$e2eeScratch = Join-Path ([System.IO.Path]::GetTempPath()) ('secubuzz-key-review-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $e2eeScratch | Out-Null
$env:DB_PATH = Join-Path $e2eeScratch 'data.sqlite'
$env:NODE_ENV = 'development'
$env:AUTH_ALLOW_HTTP_LOCAL = 'true'
$env:AUTH_ALLOWED_ORIGINS = 'http://localhost:3000'
$env:HOST = '127.0.0.1'
$env:PORT = '0'
npm run db:migrate
npm start
```

The new process reports its ephemeral port. Enroll real signed device records and publish a genuine epoch; no server-side conversation-key generator or fake attestation endpoint exists. For production use the existing [DB-2 deployment/TLS configuration](auth-operations.md), never the local HTTP overrides, and deploy the sibling protocol sources with DATA. Normal DATA can safely accept a valid authorized v2 envelope against current persisted state. Missing infrastructure is 503; invalid/stale/revoked state is 403. Full product activation remains pending client/realtime integration and two-browser/security verification. No production service was started or restarted.

## M. Remaining Codex / Kiro dependencies

Codex must implement persistent account-scoped browser device private keys, reviewed HPKE wrapping/opening, local record/epoch verification, TOFU/key-change and safety-number UX, v2 AAD/parser support, exact proxy/API mappings, history reconciliation and real two-browser tests. The six APIs provide full signed wraps but no retired-peer-key discovery or historical rewrapping endpoint; clients must retain verified historical keys and cannot assume new enrollment grants old keys. See [frontend integration](e2ee-frontend-integration.md).

Kiro must add trusted per-actor session/CSRF store binding, v2 socket parsing/fingerprint, a DATA-backed authorizer, post-commit recipient reauthorization/fan-out, real acknowledgement receipts and agreed keys-changed events. A user-ID-only global store or direct cross-process import is not authority. Authenticated HTTPS REST or an approved same-process credential binding remains the secure boundary; no unauthenticated internal endpoint is added. See [realtime integration](e2ee-realtime-integration.md). Updating Kiro's old seam-test expectations remains Kiro-owned.

No encrypted editing, historical recovery protocol, attachments/groups, AI, outbox or other roadmap phase is implemented here.

## N. Ownership

Only DATA paths changed. All 98 pre-existing outside-DATA hashes match; no baseline file is missing. Migrations 1–6 match their raw pre-edit SHA-256 hashes. Existing user work and stashes are preserved; branch and HEAD are unchanged. No reset, clean, stash, checkout, merge, rebase, commit or push was performed. No development database or running service was modified/restarted. Work stops at this post-DB-4B dependency.
