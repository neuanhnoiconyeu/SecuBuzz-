# Phase 13A.3 Stage 2: format-2 implementation readiness review

Reviewed 2026-11-23 on `bon-fullstack`, HEAD `f27ea89` (ahead 12).
Primary development origin: `http://localhost:3001`.

**Ready for a bounded implementation discussion; not authorized or ready for
runtime activation. A1 remains High/P1 and unresolved.** D1–D8 remain pending.
This review adds only this document. It implements no model, migrator, gate or
format switch and changes none of the Stage 1 tests.

Sources: [design](a1-rollback-protection-design.md),
[decision review](a1-security-decision-review.md),
[Stage 1 evidence and traceability](a1-acceptance-test-foundation.md), and
[A1/A2 findings](security-findings-a1-a2.md). The older documents' statements that
Phase 13A.3 had not started describe their historical review boundary; Stage 1
has since added tests. Their approval checkboxes remain unapproved.

## Readiness and current evidence

At entry, 12 tracked files were modified and 11 files were untracked; nothing
was staged. These 23 existing files, including five Stage 1 test/harness files,
must remain unchanged by this review. Branch and HEAD must remain unchanged.

Stage 1 provides actual DATA/session/CSRF/crypto fixtures, isolated in-memory
IndexedDB and five real Chrome **platform** checks. Its 37 callback-free TODOs
are not executable format-2 acceptance assertions. Executable partial evidence
maps to 23 scenario IDs; all 37 complete contracts remain pending.

Previously recorded results, **not rerun in this documentation-only review**:
598 backend passes plus 37 TODOs; 589 DATA passes; 38 focused frontend passes;
five native-browser prerequisites pass; server TypeScript passes. The explicit
adversarial run exits 1: two A2 passes and four A1 failures, including the new
original-fingerprint alias replay. Ordinary green suites do not close A1.

The core logical read/rollback store can reuse the existing V2 envelope and
signed-edit protocol without SQL changes. The broader mutation-routing claim
needs the explicit scope decision in gap G1 below. No complete format-2 path,
legacy migrator or actual application cross-tab publication gate exists today.

## Existing interfaces and precise integration boundaries

Line links identify the current working tree; proposed APIs below do not exist.

| Existing file/functions | Required future change |
| --- | --- |
| [storage.ts](../client/src/security/e2ee/storage.ts#L9): `BrowserKeyStore.open`, `transaction`, `key`, `observeRevision`, `close` | `open` currently requests version 1 and unconditionally creates `records`/`nonces` during upgrade. A version bump alone would attempt to recreate existing stores. Use old-version-aware additive upgrade; preserve both stores and every key. The single-store transaction helper cannot atomically span gate/head/aliases/receipts. Replace the alias watermark path with a typed multi-store operation, resolving only at transaction completion. Keep key/nonce/pending operations intact. |
| [edits.ts](../client/src/security/e2ee/edits.ts#L25): `verifyEditedContent`, `originalWire`, `messageEditHead`, `messageEditVersion` | Separate existing strict crypto preparation from durable observation. Produce copied, immutable verified evidence containing original identity/root and the complete bounded prefix. Replace the final `observeRevision(storageId, hashes)` call; a revision number or TypeScript cast cannot confer verification. Preserve AEAD/signature/epoch checks and `sameMetadata`. |
| [model.ts](../client/src/security/e2ee/model.ts#L23), [session.ts](../client/src/security/e2ee/session.ts#L15): `StoredMessage`, `DecryptedRow`, `SecurityErrorCode` | Keep wire DTOs separate from protected views. Add local view-token/readiness types and distinct blocked/conflict/corrupt/storage/uncertain outcomes after review. Do not add local state fields to encrypted wire envelopes or call every policy failure a lost key. |
| [session.ts](../client/src/security/e2ee/session.ts#L26): constructor, `initializeDevice`, `prepare`, `history`, `decryptStoredMessage`, `isCachedMessageCurrent`, `editRow`, `editMessage`, `dispose` | Retain verified account/store binding. Bootstrap local protection state without re-enrollment; gate protected operations separately from device-status/login access. Both active history paths commit logical evidence; deleted history commits terminal logical observations and checks the outcome. Cache checks read account gate plus exact logical head together. Edit success requires confirmed proof and committed protected view; disposal/version changes invalidate outstanding results. |
| [session.ts](../client/src/security/e2ee/session.ts#L131): `confirmed`, `findPersisted`, `send`, `retryPending`, `decryptIncoming` | Preserve exact pending bytes, nonce ledger, operation IDs and lost-ack reconciliation. Confirmed sends/reconciled tombstones need observation before protected publication. `decryptIncoming` is currently crypto-only: workspace `receive` discards its text and Forward uses it to compare pending bytes. Separate/narrow that internal purpose; never treat it as a public display authorization or permanently disable exact-byte retry. |
| [api.ts](../client/src/security/e2ee/api.ts#L54): `stored`, `history`, `remove` | Reuse strict transport parsing and membership checks. Deleted rows have claimed logical IDs but no original ciphertext/proofs. Structural parsing is not evidence of a crypto-verified root. Only G1's stronger routing alternative would require a separately approved mutation API change. |
| [authenticatedUnsend.ts](../client/src/messaging/authenticatedUnsend.ts#L9): `confirmed`, `perform`, `remove` | Currently returns after validated DELETE confirmation or raw-history reconciliation, without persisting a watermark. Commit a logical tombstone in **both** success paths before resolving. Keep the in-flight deduplication and sender checks. Separate network failure from server-confirmed/local-persistence failure; do not retry DELETE or report secured success just because the catch-path history found deletion. |
| [SecureRealtimeWorkspace.ts](../client/src/realtime/SecureRealtimeWorkspace.ts#L19): `mergeSecureRows`, `sync`, `older`, `receive`, `reconcile`, `acceptUnsend`, `acceptEdit`, `update`, `markVisibleRead`, `dispose` | Current row merge may preserve older good text when an incoming row has an error. That remains useful for an invalid untrusted DTO, but cannot override a committed terminal/conflict/quarantine invalidation. Carry/recheck view tokens before derived state, unread/read receipt and action eligibility; accept Unsend only after durable observation. Hints trigger verification, not deletion authority. |
| [authenticatedPins.ts](../client/src/messaging/authenticatedPins.ts#L59): `refresh`, `set`, `authorize`, `dispose` | Preserve A2's read-only cache check and unavailable-row behavior. Switch it to logical gate/head checks, including after async work. Pin version does not establish content freshness. Mutation routes use the retained operational alias subject to G1's limits. |
| [authenticatedForwarding.ts](../client/src/messaging/authenticatedForwarding.ts#L57): `forward`, `deliver`, `permitted` | Currently receives plain `ChatMessage` source content with no durable view token. Resolve/recheck the source through the session before independent destination encryption; preserve operation IDs, exact-byte retries and note partial failures. Recheck remaining unsent destinations if source validity changes. A pending operation comparison must not become a display bypass. Media forwarding remains disabled. |
| [authenticatedReactions.ts](../client/src/messaging/authenticatedReactions.ts#L41): `watch`, `set` | Keep metadata transport/authentication unchanged for the core read fix. Feed verified eligible parents and clear terminal/unavailable derived presentation. Review alias-based mutation routing under G1. No new plaintext reaction store. |
| [authenticatedChatPresentation.ts](../client/src/components/messenger/authenticatedChatPresentation.ts#L12): `mergePinnedRows`, `presentMessages`, `presentConversations` | Preserve A2's unavailable-pin override. A nonnull string alone must no longer establish current protected eligibility; supply only gated snapshots, handle blocked states and invalidate sidebar/reply/forward/pin fallbacks. Reply references remain locators; local hiding never removes a watermark. |
| [SecureConversationPanel.tsx](../client/src/components/messenger/SecureConversationPanel.tsx#L244): `refresh`, `send`, `retry`, `older`, `unsendForEveryone`, `editMessage`, `chooseReply`, `confirmForward`, `togglePin`, `toggleReaction`, attachment provider | Both REST-only and live modes need the same protection gate and stale-result checks. Add reviewed blocked/uncertain UX and recheck preview/action state. Preserve editor drafts, reply metadata and failed-request behavior. Do not implement quarantine merely by globally disabling the real-account capability constants. |
| [authenticatedAttachments.ts](../client/src/messaging/authenticatedAttachments.ts#L52): `read`; [EncryptedAttachmentContext.ts](../client/src/messaging/EncryptedAttachmentContext.ts); [useAttachmentSource.ts](../client/src/hooks/useAttachmentSource.ts#L15); [VoiceMessageView.tsx](../client/src/components/messenger/VoiceMessageView.tsx#L9) | Current read callback accepts attachment metadata and returns a decrypted Blob, with no parent view token. Gate before/after asynchronous download/decryption and at cache reuse/play/download; propagate parent invalidation to abort requests, revoke owned URLs and stop playback. Preserve encryption/manifests/storage APIs and demo behavior. No new attachment or voice delivery protocol. |
| [RealMessengerWorkspace.tsx](../client/src/components/messenger/RealMessengerWorkspace.tsx#L35), [messagingCapabilities.ts](../client/src/messaging/messagingCapabilities.ts#L1) | Use existing per-session resource ownership for status subscriptions, shutdown and cleanup. Effective local readiness is separate from static transport capabilities and authorization. Preserve Demo Mode, direct-call gating and calling runtime. |

Keep [messages.ts](../client/src/security/e2ee/messages.ts),
[protocol.ts](../client/src/security/e2ee/protocol.ts) and
[shared/messageRevisions.ts](../shared/messageRevisions.ts) as the canonical
crypto/hash/validation contracts. No new AAD, signature statement, key export,
SQL migration or history checksum change is needed for the core read protection.

## Proposed local interfaces and atomicity

These are implementation specifications subject to D1–D2, not approved APIs.

- **Identity/value separation:** a native compound key
  `(sessionAccountId, conversationId, originalWireId)`. Original sender and `H0`
  are immutable values, never key suffixes. Preserve exact identifier bytes/case;
  do not normalize, concatenate delimiters or use an edit operation ID as the
  original wire ID. Keep existing canonical hash statements and the 20-edit cap.
- **Data versus evidence:** strict pure parsers validate stored shapes; they
  cannot create trusted crypto evidence. A private verifier constructs immutable
  `VerifiedOriginalEvidence`/`VerifiedRevisionEvidence` from genuine crypto and
  bound session identity. Copy nested proofs/envelopes before async processing;
  `readonly`, a cast or an exported brand constructor is not a runtime boundary.
- **Terminal claim variant:** a separately typed `DeletionObservation` retains
  session/response context and claimed conversation/wire identity. For an unseen
  deletion, root/sender/revision stay unknown; it is not signed sender evidence.
  Known identity/alias contradictions cannot replace a committed head.
- **Store facade:** proposed `observeVerified`, `observeDeletion`,
  `checkCurrentViews`, `getProtectionStatus` and a restricted migration-association
  operation. They share the existing database connection; no second database or
  generic caller-controlled put of a protected head. Return explicit accepted,
  stale, terminal, conflict or blocked outcomes only after commit.
- **View token:** identity, root/head, account/storage generation and monotonic
  counter, bound to a session lifecycle. A token is checked against durable
  account/head state, never trusted because it came from a DTO. Batch checks can
  serve history/pins/sidebar. Tokens/hints contain no plaintext or keys.

The proposed stores are `rollbackSystem`, `rollbackAccounts`, `rollbackHeads`,
`rollbackAliases`, `rollbackLegacy` and `rollbackEvidence`, plus preserved
`records`/`nonces`. Physical IDB schema version 2 and logical watermark format 2
are different fields and must be validated independently.

Each normal observation transaction must:

1. Read the system/account generation, ready gate, current logical head and both
   directions of alias bindings in one overlapping read/write transaction.
2. Re-evaluate prepared evidence against that **current** head. Accept an equal
   prefix idempotently; extend only a compatible higher prefix. A lower head is
   unavailable, not a new slot; timestamps/sequence never break a fork tie.
3. Preserve terminal state and every already committed verified prefix. A crypto
   preparation that had not committed before deletion is not a higher durable
   observation that must be newly published. Deletion wins in either order.
4. For a genuine authenticated root/fork conflict, persist evidence and freeze
   the logical scope while retaining its prior head. **Commit the freeze before
   returning the denied outcome.** Throwing to abort would discard it. Invalid
   AEAD/signatures are rejected without manufacturing persistent fork evidence.
5. Commit aliases, heads, counters, inventory/receipt changes as applicable and
   release eligibility together. A request's `onsuccess` cannot resolve success;
   only transaction completion can. Crypto/network/timers stay outside the tx.
6. Return a committed token and revalidate it at the agreed publication/action
   boundary. Delayed callbacks, focus/resume/pageshow, reconnect and async media
   completion cannot publish an obsolete prepared view. Cross-tab hints only
   invalidate; lost/forged hints do not authorize. Do not promise atomic erasure
   of already displayed pixels or exported plaintext.

Use overlapping IndexedDB transactions as authority, not a tab-local mutex or
BroadcastChannel election. Request strong durability where supported; D2/D4
must define unsupported-browser behavior without claiming immunity to eviction,
hardware loss or complete local snapshot rollback. A server-confirmed Unsend plus
local quota/abort is an explicit uncertain/unavailable state, not success with
old plaintext or an empty replacement watermark.

## Legacy and upgrade boundaries

The additive upgrade must create an inventory-pending marker, preserve every
v1 source record/key/nonce/pending ciphertext and fence old writers before any
inventory is trusted. Initialize zero-head accounts only after a complete valid
inventory; new account age, empty server history or a changed port is no proof.

| Legacy observation | Permitted proposed resolution / remaining gate |
| --- | --- |
| Revision 0 with saved nonempty `H0`, active or deleted | Match the exact locally committed original fingerprint to evidence account-wide, even under a changed alias. Association alone does not authorize plaintext; normal crypto still does. |
| Revision n with saved nonempty `Hn` | Verify the matching proof commitment and bounded prefix establishing original identity/root/owner using existing signer/epoch trust. Missing retained proofs or trust leave it unresolved. |
| Empty hash terminal tombstone | Preserve it verbatim; no cryptographic identity survives. Fresh maps/signatures/current DB lookups cannot repair that loss. Approved account-wide quarantine, or deferred activation, is required. No automatic trusted recovery exists. |
| Malformed or unassignable source | Preserve raw source/reference and block classification in a defined scope. Do not skip the entry or release another account merely by assuming it is unrelated. Scope requires D2/D3. |

Inventory batches commit cursors/counts/source digests together. Association
receipts bind account/generation/source key and exact source digest, resulting
identity/head/deletion and policy/evidence version. Repeated receipts must not
retarget a source, erase deletion or decrement unresolved counts twice. Merge
only comparable prefixes, OR deletions, retain archived aliases as recovery-only
where appropriate. Final readiness is a transactionally checked predicate over
the complete inventory, manifest, generation, conflicts and unresolved counts.
Migration operations may collect evidence while the plaintext gate stays closed.

Anonymous observations can cover already associated identities, so releasing
"known good" rows while one unscoped record remains is not safe. Quarantine's
availability/metadata-only UX needs D3 approval. Existing encrypted history,
browser keys and pending operations must not be reset to obtain eligibility.

The database version affects **all accounts in that origin/profile**. Close and
reload old tabs/workers before activation. `onversionchange` closing today's
handle does not stop cached plaintext or authenticated HTTP access; the current
app has no complete all-context shutdown protocol. A late `onsuccess` after a
blocked/aborted upgrade must not leak a connection or permit protected use.
No version-1 reopen, alternate database, memory fallback or lowered minimum
format is permitted after upgrade. Roll back only to a compatible client that
retains enforcement, or stop protected operations; forward recovery is separate.

## Gaps and decisions to settle before implementation

| ID / priority | Evidence, required decision and acceptance clarification |
| --- | --- |
| **G1 / blocking scope** | I8/A07 says aliases cannot redirect mutations, while the design correctly admits an original DTO's first alias is not crypto-bound. The local index detects contradictions only after a binding exists. Inspect [Unsend backend](../DATA/server/messaging/service.js#L83), [pin input](../DATA/server/messaging/pins.js#L10), [reaction input](../DATA/server/messaging/reactions.js#L8): operations target a storage ID without an expected logical-identity precondition; checking returned IDs occurs after mutation. In contrast [Edit](../DATA/server/messaging/edits.js#L35) checks signed `messageId`/conversation against the stored row. D1/D5 must explicitly limit the core routing claim to retained bindings and trusted initial routing, or separately approve additive logical-identity mutation preconditions. The latter is an API contract change, not a reason to modify SQL history. A new unauthenticated map lookup cannot solve this. |
| **G2 / blocking precision** | Specify exact structural validators, discriminated unknown-root/verified/terminal/conflict states, gate enum, generation/manifest layout and atomic store scopes. Define committed conflict outcomes separately from invalid crypto and storage abort. D1/D2; A05/A09–A11/A15, S01. |
| **G3 / blocking publication boundary** | Today's `DecryptedRow` has no token; caches/merges can retain good text after errors; media Blob callbacks have no parent gate. Define a check/commit linearization point and non-bypassable snapshots/action APIs. Specify Forward's already-accepted versus remaining-target behavior and exact pending retry semantics. D2/D5; A12–A17, C01–C03, F01–F02. |
| **G4 / blocking eligibility** | Define first fenced inventory versus missing post-upgrade metadata, unknown-account corrupt-key scope, duplicate aliases, canonical operational alias selection and each crash cut point. Generation/count sentinels detect some loss, not deletion of the entire history. No server absence proof or fabricated zero root. D2/D3; A08, M01–M08, S01–S02. |
| **G5 / blocking availability and rollout** | Quarantine can be indefinite; first fresh-account use upgrades the entire origin. Supported browsers, durability fallback, worker/BFCache handling, old-context shutdown and compatible build rollback need owners and evidence. D3/D4; M09–M10, R01–R03. Active unmodified v1 readers cannot be made protected by an IDB version alone. |
| **G6 / conditional scope** | M06 describes an approved recovery receipt, but D6 is pending and recovery is excluded by default. Core testing must reject unsupported recovery and leave source/gate unchanged; an actual authority-validation positive path is conditional on a separate approved protocol. Do not count disabling all reads or inventing receipts as full acceptance. |

G1 is a code-inspection inference and a contract inconsistency, **not a new
exploit reproduced in this review**. Proposed isolated subcase A07.c: create two
eligible messages by the same sender; before first observation, substitute the
second storage ID into the first valid original DTO; exercise mutation routing
against honest DATA. Decide the required rejection boundary before adding or
implementing this case. A post-mutation response mismatch is insufficient for a
strong no-redirection claim. A malicious backend itself remains able to suppress
content under the documented threat-model limitations.

No fundamental contradiction was found in the core logical read model when
scoped to durable same-browser observations. The following claims are not
testable as universal guarantees: complete local-history loss detection without
an external anchor; shutdown of all arbitrary unmodified clients; synchronous
erasure of already displayed/copied content; and sender-authenticity of unsigned
deletion claims. Retain those limits explicitly, rather than adding misleading
passing tests.

## Work packages and acceptance mapping

These packages separate review scope and do not replace the existing 37 IDs.
All acceptance outcomes below remain future requirements. D1–D5 precede core
code authorization; D6 applies only to optional recovery, D7 to security closure,
and D8 to any real-profile activation. None has been granted here.

| Package / implementation order | Concrete checklist and exit criterion | Cases |
| --- | --- | --- |
| **W1: pure structures and validators** | Approve G1–G2. Add an unreferenced `rollbackModel.ts` (proposed new file) with exact compound identity, persisted head/alias/token shapes, strict parsers and explicit outcomes; no IO, global initialization or verified-evidence factory. Add boundary tests, including unknown-versus-zero, incompatible prefixes, exact identity bytes and input immutability. Then add pure transitions over verifier-owned evidence once approved. | A04–A11, A15; input-validation portions of S01 |
| **W2: persistence/atomic engine** | Add an internal store facade sharing `BrowserKeyStore`, tested only with explicitly named disposable databases. Implement multi-store reads/commits, conflict freeze, terminal preservation, counters and token checks. Test quota/abort after each write, true Chrome two-tab races and request-success/commit-failure separation. No real-profile/default-name activation. | A09–A14, A17; M07–M08 transaction primitives; S01 |
| **W3: inventory, association, policy** | After D2/D3, add version-aware structural upgrade and a separate `rollbackMigration.ts` (proposed) using frozen legacy source. Implement journal/receipts/ready predicate; approved quarantine or defer activation. Reject unapproved recovery; do not invent a resolver. Test corrupt keys, duplicate aliases and all interruption/restart cut points. | A03, A08; M01–M08; S01–S02 |
| **W4: message/cache integration** | Connect the session verifier and all confirmed Unsend/reconcile paths first; then pins, history/live merges, sidebar/reply/forward and media parent gates. Keep transport bytes/auth/metadata and Demo Mode unchanged. Test ready-account positive controls, not just denial. | A01–A02, A05–A07, A11, A15–A17; C01–C03; F01–F02; R01 |
| **W5: browser compatibility/rollback** | After D4, implement session lifecycle shutdown/status subscriptions, blocked-upgrade UX, compatible downgrade restrictions and resume/pageshow checks. Exercise an actual old build/worker and retained API access, not only sentinel tabs. | M09–M10; A12–A14; C03; S01–S02; R01 |
| **W6: adversarial/release acceptance** | Turn TODOs into assertions against actual production integration; run original probes plus E01 without expected-failure wrappers, all approved subcases and valid ready-account controls. Run full relevant frontend/backend/DATA, TS/lint, protocol and browser checks; verify the existing Docker-served build on port 3001 after separately authorized deployment. Obtain D7, then D8 before activating any real profile. | All A01–A17/M01–M10/S01–S02/C01–C03/F01–F02/R01–R03, with M06 conditional scope explicit |

W2/W3 must be tested together before integration/activation. An inventory gate
is not optional just because a logical engine passes synthetic read tests.
Proposed new module names are review boundaries, not a requirement to duplicate
storage connections, crypto validators or messaging components.

### All ten invariants and the evidence still missing

| Invariant | Implementation owner boundary / required evidence |
| --- | --- |
| I1 logical identity | W1/W2/W4; A01–A08/A15/M02. Fresh-alias rejection and exact account/conversation namespaces with valid positive controls. |
| I2 immutable root/compatible prefix | W1/W2/verifier; A05–A06/A09–A11/M02/R02. Genuine forks freeze; forged evidence never does; root remains a value. |
| I3 terminal deletion | W2/W4; A02–A03/A08/A13/A15–A17/R01. Unknown-root and known-higher-head variants, all sender/recipient/reconcile outcomes. |
| I4 gated publication/cache | W4/W5; A03/M05/C01–C03/F01–F02. A2 remains green; stale history, sidebar, reply, Forward and media cannot bypass. |
| I5 durable observation | W2–W4; A12–A14/A17/M07–M08/S01. Inject abort after successful requests, race actual tabs and test delayed publication. |
| I6 retain/account for all legacy records | W3; A08/M01–M08/S01–S02. Source/key/receipt/generation inventory, no anonymous auto-association or premature release. |
| I7 old clients fenced and limits explicit | W3/W5; M09–M10/R01. No v1 fallback; old memory/API access is a limitation, not a passing secure coexistence claim. |
| I8 alias/routing consistency | W1/W2/W4 plus G1 decision; A04/A07–A08/A16/F01. Separate contradiction detection from stronger first-binding mutation protection. |
| I9 keys/pending/SQL unchanged | All packages; M01/M07/F02/R01–R03. Non-extractability, continued crypto, exact pending bytes and nonce reuse prevention; no history checksum change. |
| I10 explicit fail-closed errors | W2/W3/W5; A17/M04–M07/S01–S02. No reset, temporary fallback, generic success or silent lockout. |

The 14 IDs lacking new Stage 1 executable case-specific evidence are
**A08, A15, M02, M04–M06, S01–S02, C01–C03, F01–F02, R03**. Reused older A2 and
feature regressions do not test their new format-2 semantics. The other 23 IDs
also require their full contracts, including: ready fresh/migrated-account
positive controls; root-zero/nonzero and active/deleted migration; receipt
retarget/count replay; zero-head versus lost metadata; all per-write crashes;
lost/forged hints and suspended tabs; exact pending edits as well as sends;
media callback completion after deletion; and scoped fork invalidation.

Add these explicit subcases within existing IDs before implementation: A07.c
first-alias mutation routing (G1); A10 durable freeze survives reopen while an
invalid proof cannot freeze; A14 immutable prepared evidence and publication
delay; A17 direct/lost-response Unsend with post-confirmation local abort; M07
late blocked-upgrade completion cleanup; M01/S01 corrupt unassignable source in
a multi-account origin; M10 BFCache/worker/API-access limits; F02 already-loaded
Blob invalidation and stopping voice playback. Browser durability and total
eviction limitations need documented expectations, not fabricated success.

## Smallest safe next code change and stop condition

**Now:** obtain and record D1–D5 decisions, including G1's precise scope and G2's
schema/outcomes; expand the subcase specifications. This review grants no code
authorization beyond its documentation scope.

**After separate approval:** implement only the W1 pure data model/parsers and
isolated unit tests, with no runtime imports, storage access, migration,
quarantine defaults, automatic factory side effects or format activation.
Preserve current crypto statements; validate shape without manufacturing
`VerifiedEvidence`. Reject unknown fields/invalid hashes or bounds, distinguish
unknown root from verified revision zero, preserve exact compound identifiers,
and prove input immutability. This small patch can be reviewed independently;
its tests must not be reported as end-to-end A1 closure.

Stop that patch before changing `BrowserKeyStore.open`, adding startup imports
or calling any new observation API. W2 and subsequent packages require separate
review and passing disposable-store tests. D7 independent security validation
and D8 explicit activation remain later mandatory gates. D6 stays deferred
unless separately selected and approved. No SQL/API changes are authorized by
this review, including G1's conditional stronger alternative.

## Review verification and preservation

This phase performs source/document inspection and static checks of the new
report's links, scenario/invariant references, approval gates and Git/file
preservation. It runs no application/browser test fixtures, database migrations,
Docker commands or environment operations. Prior Stage 1 counts above are
historical evidence only; no new runtime compatibility or Docker incorporation
claim is made. No secrets, private keys or actual browser data are read.

Only this review document is added. All 23 pre-existing dirty files and the
staged/tracked diff are preserved; no commit/push/pull/merge/rebase or history
operation is performed. Existing SQL migrations, Docker/legacy volumes, stash,
browser keys/watermarks and default production runtime behavior remain intact.
**A1 is not fixed; format 2 is not enabled; runtime implementation has not begun.**
