# Phase 12A: Database and Security integration review

> Phase 13A follow-up: the pin-refresh cache bypass A2 is fixed with targeted
> regression coverage; A1 remains reproducible and requires a reviewed browser
> watermark identity/migration contract. See the [current A1/A2 review](security-findings-a1-a2.md).
> The observations and test counts below are the historical Phase 12A record.

Reviewed on 2026-11-22. **Ready for team review with blockers; not ready to merge.** Two reproduced client rollback-protection defects require fixes and Security approval. The normal authenticated server flows pass their regression tests. This review changes tests and documentation only; it does not fix or weaken runtime/schema protections.

## Branch and preservation

- Branch `bon-fullstack`, HEAD `7078ebf303bbf04a7d75767326d9afe06a36926f`. Recent commits: `7078ebf`, `a9b077f`, `21f413c`. No staged changes at entry.
- Entry inventory: 150 dirty paths: 78 tracked modifications and 72 untracked files. These include the existing real-account feature implementation, migrations 0008–0011, three local SQLite files and `client/tsconfig.tsbuildinfo`. Ordinary `git diff` alone omits the untracked implementation.
- Baseline source hashes/status are recorded in ignored `.cache/phase12a-inventory.json`. No development database was opened/migrated by this review. Tests use isolated databases/accounts and private binary directories. No environment settings, historical migrations, Calling implementation, Git history or existing features were changed.

## Database contracts

| Migration | Additions and invariants | Cross-feature behavior |
| --- | --- | --- |
| [0008](../DATA/server/database/migrations/0008-authenticated-message-pins.sql) | `ConversationPinVersions`, `MessagePins`, `MessagePinOperations`; composite message FK, pin PK, active-participant/V2 eligibility trigger, immutable pin records. | Unsend removes pins and advances the collection version atomically. Operation receipts remain for idempotency. Pins store identifiers/actor/time, not decrypted text. |
| [0009](../DATA/server/database/migrations/0009-authenticated-message-reactions.sql) | Per-message versions, actor slots and operation receipts; one slot per user/message, actor revision guard, composite FKs. Service validates one Unicode emoji and uses actor CAS. | Edit leaves reactions on the stable original message. Unsend clears actor/operation rows and retains the monotonic message version. Emojis and actors are server-visible metadata. |
| [0010](../DATA/server/database/migrations/0010-encrypted-attachments.sql) | Additive `Attachments` columns/indexes, `EncryptedAttachmentBatches`, scope/lifecycle/immutability guards. Existing columns and FKs remain. | Sealed uploads associate with the message in its commit transaction. Unsend marks files deleted and batches revoked; downloads immediately fail. Private DB6 binaries are purged separately. Voice uses this same contract, without another migration. |
| [0011](../DATA/server/database/migrations/0011-encrypted-message-revisions.sql) | Append-only `MessageEditRevisions`, message/signer FKs, unique operation/proof/nonce, contiguous predecessor/revision checks, immutable/no-delete guards and cross-table nonce guard. | Original envelope/ownership/storage identity remain immutable. Edits preserve Reply/Forward metadata and pin/reaction identity. Attachment/voice messages are ineligible for editing. Unsend hides revisions and blocks new edits; encrypted revision rows remain retained. |

The existing message-envelope, storage-identity and monotonic-tombstone triggers remain intact. Migration 0011 does not authorize arbitrary ciphertext overwrites. SQL guards enforce structural/lifecycle rules; signature/AEAD verification belongs to the server/client protocol validators, not SQLite.

The runner requires FK enforcement, contiguous migration numbers and matching recorded checksums. It holds one immediate transaction for the entire batch, including the migration ledger. Raw SQL is intentionally not repeatable; **the migration runner** is idempotent. Unsupported legacy schemas, checksum drift and FK violations fail closed.

Fresh initialization and supported legacy adoption are covered by the existing DATA tests. Five additional [review tests](../DATA/tests/integration-review-migrations.test.js) upgrade a populated version-7 fixture through each of 8, 9, 10 and 11 individually, preserving messages, receipts, existing attachment references and original triggers. Injected failures in each migration roll the whole 8–11 batch back to version 7; a corrected retry succeeds. Cross-feature integration assertions also verify FK/integrity checks after Unsend, pin/reaction removal, attachment revocation and retention of immutable original/revision ciphertext.

There is no destructive automatic down migration. Failure rollback is verified; downgrade to an older binary/schema is not supported. Deployment recovery must use a coordinated backup of DATA's ledger and its private encrypted binary directory, or a reviewed forward fix. This review did not migrate or restore existing development data.

## Security and E2EE findings

**A1 — High severity, P1: persisted rollback protection is keyed by an unauthenticated storage alias.**

`BrowserKeyStore.observeRevision` in [storage.ts](../client/src/security/e2ee/storage.ts) keys its record by `storageId`; [edits.ts](../client/src/security/e2ee/edits.ts) and the deleted-message path in [session.ts](../client/src/security/e2ee/session.ts) use that alias. The original V2 envelope authenticates its conversation/wire identity, but not the server-assigned storage ID. After a verified edit or Unsend, a new session accepts the original valid ciphertext again if a replayed history DTO changes only `storageId`. The same replay with the correct storage ID is rejected. No keys, signature forgery or AES break are needed.

Reproduction: create two enrolled accounts; send a text; let the recipient verify an edit (repeat after Unsend); start a fresh recipient client sharing the same IndexedDB; return the saved original DTO from history with a different syntactically valid storage ID. Expected: unavailable/rejected. Actual: original plaintext returns. Honest DATA storage IDs are immutable; this attack requires a rewritten/replayed authenticated response. It nevertheless defeats the claimed protection against rollback of **already observed** content, independently of the documented limitation for never-observed edits.

Required fix: bind persistent revision/deletion watermarks to the authenticated logical `(conversationId, wireMessageId)` within the account, validate storage aliases, and preserve existing observations when upgrading the watermark format. Add history/pin, reload and cross-session adversarial tests. Security must review the identity/upgrade contract.

**A2 — Medium severity, P1: the pin plaintext cache bypasses current revision/deletion watermarks.**

[authenticatedPins.ts](../client/src/messaging/authenticatedPins.ts), lines 71–75, returns identical cached DTO/plaintext before calling `decryptStoredMessage`, including `refresh(cid, true)`. Another client/tab can advance the shared IndexedDB head to an edit or terminal Unsend; a delayed/replayed old pin snapshot still returns the cached original text. Direct verification rejects that exact message. The collection pin version need not advance when text is edited. This concerns cached presentation, not unauthorized server access or recovery of new plaintext keys.

Reproduction: recipient caches an original pin; sender edits/unsends; another recipient client verifies the newer history in the same browser store; refresh the first pin controller using its saved original collection. Expected: reject/hide the stale original. Actual: original plaintext remains available in pin rows. Required fix: consult the current persisted watermark before reusing plaintext and invalidate caches across contexts when their verified head becomes stale/deleted. Keep legitimate pin navigation and missing-key handling intact.

Both defects are executable in [revision-watermark-review.check.ts](../server/test/manual/revision-watermark-review.check.ts):

```text
cd server
node --test --test-concurrency=1 test/manual/revision-watermark-review.check.ts
```

Its **four assertions currently fail**, covering both issues after Edit and Unsend. This is a deliberately explicit negative review probe, excluded from ordinary `*.test.ts` discovery; it must become passing regression coverage when fixed. The probe uses genuine isolated DATA accounts, production client crypto and IndexedDB; only the final read response is replayed. It is not a browser/manual-UI test.

## Verified boundaries and required approvals

| Boundary | Review result and ownership |
| --- | --- |
| Identity, sessions, CSRF and membership | DATA resolves account identity from the authenticated cookie; writes verify matching session CSRF and current interaction policy. Edit rechecks after async verification; uploads recheck after streaming. Socket binding uses the same session/CSRF, with fresh per-operation/delivery authorization. Authentication and Backend owners should approve the bridge/proxy integration. |
| Edit and Unsend | Sender-only, stable wire/storage lookup, active-message eligibility. Signed edits use registered active sender devices, recipient-covered epochs, predecessor/revision CAS, exact-operation idempotency, atomic audit logging and identifier-only post-commit hints. Original ciphertext overwrite remains forbidden. Security approval is blocked by A1/A2. |
| Pins and reactions | Active participants only; no client actor/owner claims; service CAS, unique operation receipts, SQL guards and fresh delivery authorization. Backend/Database owners must approve retention and server-visible emoji/pin metadata. |
| Encrypted files and voice | Per-file AES-256-GCM, fresh key/IV, scope/metadata AAD, versioned private manifests/keys inside V2 content. DATA uses DB6's binary implementation in a separate private namespace. Authenticated download, ciphertext hash/tag/type checks and Unsend invalidation are exercised. File keys/plaintext were absent from captured storage uploads and fixture DB dumps; this is tested-path evidence, not a formal whole-program proof. Security must approve AAD, manifests, format checks and browser key handling; Database must approve batch/retention/backup contracts. |
| Revisions and E2EE compatibility | Original V2 and old content remain decryptable; Reply/Forward metadata survives text edits; pin reads use revision verification when decryption is performed; reactions remain associated. Signing, AEAD tampering, replay, concurrent edits, stale/revoked key attempts and failed commits are tested. A1/A2 identify gaps in persisted/cache rollback enforcement. |
| Tokens and calls | Existing scoped, short-lived LiveKit tokens and DATA authorization are tested with stubbed media infrastructure. No real LiveKit media verification is claimed; authenticated call controls remain disabled. Calling was inspected, not modified. See [direct-call review](authenticated-direct-calls.md). |

Database owners should approve all four **currently uncommitted** migrations together, FK/index choices, append-only revision retention, metadata-operation growth and the isolated upgrade/failure evidence. Security owners should review [edit protocol](authenticated-edit-protocol.md), [encrypted attachments](authenticated-encrypted-attachments.md), [voice](authenticated-encrypted-voice.md), [pins](authenticated-pins.md) and [reactions](authenticated-reactions.md). This review does not constitute either team's approval.

## Validation and remaining limits

| Check during the continued Phase 12A review | Result |
| --- | --- |
| Full backend regression suite, including strengthened cross-feature Unsend/FK checks | 584 passed / 81 suites; 0 failed |
| Full DATA suite, including five added migration review tests | 331 passed; 0 failed |
| Frontend full run | 1,343 passed, 6 failed / 128 suites; failures confined to `workspaceRealtime.test.tsx`, including 5-second timeouts and subsequent state expectations |
| Unchanged isolated frontend workspace rerun | 9 passed; full frontend green rerun remains required |
| Client/server TypeScript; frontend lint | Passed |
| Negative rollback probes | 4 failed assertions, confirming A1/A2; not part of the passing backend count |
| New browser/manual UI checks | Not run in this review; previous Phase 11 evidence is historical |

Logs are in ignored `.cache/phase12a-{client,client-workspace,server,data}.log`. The initial frontend failure is retained; the focused pass does not replace the full-run result. No runtime or SQL changes were made: Phase 12A added migration tests and explicit negative probes and strengthened two existing integration tests. Phase 12A.1 then narrowed work to a read-only [migration compatibility follow-up](database-migration-compatibility-review.md); its fresh schema comparison and test counts are recorded separately.

Known limits beyond A1/A2: browser watermarks cannot detect a never-observed server omission or survive cleared browser storage; enrollment/key-directory trust remains the existing authenticated-directory/TOFU model. Unsend does not erase downloaded local copies, original ciphertext or retained encrypted revision history. Old strict clients require coordinated rollout for edit snapshots and attachment/voice content versions. Edits are V2 text-only, limited to 20 revisions. The edit lookup scans 100 pages of 50 rows, while workspace recovery can scan 200 pages; very old edit eligibility needs a focused limit test. Transfers are bounded whole-file operations, not chunk-resumable transfers. Large production datasets/migration lock duration and real LiveKit media have not been verified here.

Priority: fix A1 and A2 with passing adversarial regressions, obtain Database/Security review, then perform coordinated client/backend rollout checks. Keep the LiveKit gate disabled until real audio/video verification. Preserve local SQLite files, build caches, secrets and temporary evidence outside any eventual feature commit.
