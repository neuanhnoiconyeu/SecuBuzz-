# Phase 13A.2B: A1 security decision review

2026-11-22 · `bon-fullstack` · HEAD `f27ea89` · primary origin `http://localhost:3001`.

**Decision-ready recommendation, not security approval. A1 remains High/P1 and
unresolved. Phase 13A.3 has not started.** This review adds documentation only.

Reviewed the complete [protocol design](a1-rollback-protection-design.md),
[current A1/A2 findings](security-findings-a1-a2.md), historical
[Database/Security findings](database-security-integration-review.md), and the
relevant storage, verification, cache and Unsend code. Prior results remain:
two A2 adversarial probes pass; three A1 probes fail. No tests were rerun here.

## 1. Recommended decision

Recommend adopting the proposed logical watermark contract, subject to the
approval gates below:

- Key protection by `(authenticatedAccountId, conversationId, originalWireId)`.
  Retain the original fingerprint as an immutable value, not another key.
- Advance only a fully verified, compatible revision prefix; persist terminal
  deletion without losing that prefix. Storage aliases are checked routing
  bindings, never an independent freshness namespace.
- Preserve all legacy observations and existing keys/nonces/pending operations.
  Associate legacy heads only using sufficient evidence anchored in their saved
  commitments. Unresolved, unscoped records require account-wide quarantine.
- Use an additive, same-name browser database upgrade with coordinated legacy
  client shutdown. Do not claim secure coexistence with unmodified old readers.
- Keep trusted recovery and any recovery API **disabled/out of scope by default**.
  Neither is an existing approved solution for empty tombstones.

No server API, SQLite schema or historical migration change is needed for the
core fix. An anonymous legacy record may remain unavailable indefinitely. If the
team rejects that availability consequence, defer legacy activation; do not
substitute a weaker mapping rule and call A1 resolved.

## 2. Assessment against the threat model

The proposed model addresses the documented attack: changing a server storage
ID no longer changes the logical watermark lookup. Changing the conversation or
wire ID of a replayed original breaks its AEAD binding; changing the root at an
already known logical identity produces a conflict. Omitting edit metadata cannot
erase a committed higher head. These conclusions depend on verification occurring
before trusted updates/publication and on every plaintext path using the gate.

The appropriate guarantee is **same-browser monotonicity of durably observed
state**, with trusted client code/local storage and the existing account/device
and key-directory assumptions. It is not independent server freshness, universal
sender attribution for shared-key base messages, or protection from XSS/local
snapshot rollback. An authentic edit signature proves sender intent, not that
the operation won an independently witnessed server commit.

For new-format unseen Unsend, retaining the claimed logical ID closes later
alias-only resurrection, but the deletion remains a server-observed suppression
claim. Unknown root/revision values must remain unknown. This review does not
approve a new signed-Unsend protocol or claim a malicious server cannot suppress
messages. Known identity/alias contradictions must still be rejected.

The design is provisionally suitable for implementation review. It is not a
formal proof, an approved migration, or evidence that the current client is fixed.

## 3. Legacy policy alternatives

| Policy | Security guarantee | Usability/availability | Migration decision |
| --- | --- | --- | --- |
| **Verified commitment association** | Matches the local saved `H0` or signed-chain `Hn` to exact logical identity; preserves the highest compatible head and deletion. Does not trust the new DTO's alias. | Normal operation can resume after complete, unambiguous resolution. Missing proofs, historical trust or ciphertext evidence can prevent completion. | Preferred automatic path for eligible nonempty records. A matching server-supplied digest alone is not evidence. |
| **Explicit account quarantine** | Blocks plaintext/actions that could expose a message covered by any unknown legacy observation. No legacy state is discarded. | Potentially indefinite inability to use encrypted messaging for that account/profile; data remains intact. Login, logout and restricted recovery/help metadata can remain available. | Recommended fallback, only after explicit Security/product approval of scope and UX. |
| **Defer legacy activation and preserve the profile** | Avoids falsely presenting legacy reads as protected; no unsupported recovery or destructive upgrade. Does not itself repair A1. | Legacy account/history is unavailable in the protected workflow until a later approved recovery/upgrade. Independent new test accounts can support development. | Safe operational alternative supported without inventing a recovery service. Keep legacy clients closed; do not offer vulnerable normal operation as a compatibility mode. |
| **Reviewed historical recovery evidence** | Can resolve ambiguity only if it establishes the historical observation-to-identity binding, completeness, account and cutoff under an explicitly approved trust model. | Could restore availability, but no qualifying workflow is currently established. Evidence may not exist. | Optional separate design/approval; unavailable as an automatic fallback now. |
| **Narrower quarantine** | Safe only when sufficient trustworthy evidence establishes the unresolved observation's scope and rules out overlap with released identities. | Could limit interruption to an established scope. | Not applicable to truly anonymous deletion-only records. Never infer scope from today's server mapping. |

A blank legacy tombstone contains no conversation, wire ID or original hash.
It may refer to an identity already associated through another alias. Therefore
blocking only its old alias, only previously unknown identities, or only a guessed
conversation is insufficient. Even an otherwise resolved head is not necessarily
safe to release while an unscoped record remains.

Quarantine is local to the account in that origin/browser profile, across its
sharing tabs. Server account/conversation records and the other participant's
history remain intact. Other devices have independent keys/observation histories
and require their own compatible client; local quarantine provides no security
clearance for them.

A current DB lookup, ordinary authenticated REST map, fresh signature over that
map, screenshot or administrator confirmation does not reconstruct the missing
historical binding by itself. Assuming pre-upgrade aliases were always honest
changes the threat assumptions; it is not cryptographic recovery. A risk waiver
must not be counted as passing the original A1 acceptance criteria.

Resetting records, creating a zero head, ignoring selected tombstones, silently
re-enrolling, or moving the same legacy account to another origin/profile are
excluded. No supported private-key export/device-linking recovery is assumed.
An optional proof-only API could help nonempty signed heads; it cannot provide
the missing anchor for an empty tombstone on its own.

### Separate defaults for development and existing profiles

| Population | Recommended future default after approval and implementation |
| --- | --- |
| New independent synthetic development accounts | Use default Docker on port 3001 and format 2 from first protected use. Eligibility requires valid account binding, completed applicable inventory and no unresolved observations; account age or an empty server history is not proof. No second Docker project is needed. |
| Pre-existing profile, legitimate v1 account with zero legacy heads | Inventory under the version fence, preserve keys/nonces and initialize format-2 metadata. Do not confuse this with missing/corrupt expected metadata. No re-enrollment is required. |
| Pre-existing profile with recoverable committed heads | Preserve v1 source; verify all associations, merge all aliases/terminal states, then activate only after the complete ready predicate passes. |
| Pre-existing profile with anonymous, missing-evidence or corrupt observations | Default to deferred activation until migration/quarantine policy is approved; if upgraded, explicit fail-closed quarantine until all blocking entries are resolved. No silent indefinite lockout or deletion/reset workaround. |

The database version belongs to the **origin/profile**, not an individual account.
Creating a new account in a profile that also holds legacy accounts can therefore
affect their client compatibility. Review that whole-profile impact before an
upgrade. Preliminary read-only inventory is advisory while old writers remain;
only the fenced inventory can authorize activation. A separate clean test profile
is acceptable for a genuinely new independent account, not as legacy recovery.

These are proposed post-implementation policies. New accounts on today's client
must not be described as already having format-2 A1 protection.

## 4. Legacy-client compatibility and rollback rules

1. Support simultaneous upgraded tabs through the shared atomic store. Keep
   crypto work outside short transactions; publish only after the relevant
   account/head check and transaction completion.
2. Before activating a profile, coordinate closing/reloading all old tabs and
   workers and reconcile uncertain operations. Preserve exact pending ciphertext,
   nonce and operation IDs. Confirm that the replacement build supports format 2.
3. Upgrade the same database name. A lower explicit version cannot reopen it
   after upgrade, but a blocked upgrade must wait rather than delete data.
   [IndexedDB connection/version rules](https://www.w3.org/TR/IndexedDB-3/#opening)
4. Do not equate a closed IDB handle with a stopped old client. Old code may retain
   plaintext, authenticated cookies or non-IDB API access. No client-version
   header, dual write or capability flag can make that code enforce new reads.
5. No v1 fallback, alternate database, key copying or lowered minimum format after
   a format-2 observation. Application rollback must retain the new enforcement
   or stop protected operations. Old server/browser backups never authorize
   lowering a head; restoration and forward recovery need separate review.

Automatic safe coexistence with fully active, unmodified v1 readers is not
supported by the current architecture. Coordinated shutdown is a deployment
precondition, and the protection claim must be scoped to upgraded readers.
The preserved port-3000 recovery environment remains stopped and outside rollout.

## 5. Explicit approval checklist

**All items below are pending; this review grants none.** Record owner, scope,
decision, date and supporting evidence. Discussion or a passing test is not approval.

- [ ] **D1 — Security:** accept the bounded threat model, logical identity/root
  rules, nullable deletion-claim provenance, prefix/fork handling and limitations
  of unsigned Unsend and shared-key base messages.
- [ ] **D2 — Security + frontend:** approve the additive storage contract, atomic
  ready/head/alias/evidence updates, corruption/durability policy, publication
  boundary and the expanded acceptance subcases below.
- [ ] **D3 — Product + Security:** approve separate fresh/legacy eligibility,
  account-wide quarantine for unscoped entries, potential indefinite interruption
  and explicit recovery/metadata-only UX. No reset/ignore-record option.
- [ ] **D4 — Frontend/release + Security:** approve supported browser/build scope,
  all-context shutdown/reload, blocked-upgrade behavior, origin-wide impact and
  compatible rollback procedure. Reject secure-coexistence claims for v1 readers.
- [ ] **D5 — Maintainers + Security:** approve the core-only Phase 13A.3 scope:
  preserve existing crypto/authentication/CSRF/Origin/authorization and SQL history;
  keep A2 and existing messaging/media features; exclude calling changes.
- [ ] **D6 — Security + Backend/Database, only if recovery is selected:** separately
  approve recovery authority, historical evidence/completeness requirements and
  any proof-only access/retention API. Default decision is to defer this scope;
  core implementation must not invent it.
- [ ] **D7 — Security:** independently review the finished implementation and
  actual adversarial/browser results before A1 closure. Mandatory failures cannot
  be skipped, marked expected, or passed by disabling all ready-account reads.
- [ ] **D8 — Deployment owner + affected user/team:** separately authorize real
  profile migration/activation after validation, with its recorded inventory,
  expected availability impact and preservation/forward-recovery plan.

D1–D5 are prerequisites to core implementation authorization. D6 is conditional;
otherwise trusted recovery stays disabled. D7–D8 are later release/activation
gates, not permissions to migrate profiles during development. Failure to approve
legacy quarantine means **no-go for ambiguous legacy activation**, not permission
to weaken the policy for convenience.

## 6. Acceptance coverage review

The design contains exactly **37 unique scenario IDs**: A01–A17, M01–M10,
S01–S02, C01–C03, F01–F02 and R01–R03. All ten stated invariants have scenario-level
coverage, including adversarial alias replay, concurrency, interrupted migration
and downgrade restrictions. This is a coverage assessment, not proof of test
execution or completeness at every failure point.

| Design invariant | Principal acceptance cases |
| --- | --- |
| I1: one logical protected head across aliases/accounts/paths | A01–A08, A15, M02 |
| I2: immutable root and verified compatible chain | A05–A06, A09–A11, M02 |
| I3: terminal deletion preserves higher observations | A02–A03, A08, A13, A15–A17, R01 |
| I4: gated publication and no cache bypass | A03, M05, C01–C03, F01–F02 |
| I5: committed observation before secured success | A12–A14, A17, M07–M08, S01 |
| I6: every legacy observation retained/accounted for | A08, M01–M08, S01–S02 |
| I7: old writers fenced; old readers not falsely supported | M09–M10, R01 |
| I8: no alias-based bucket or mutation redirection | A07–A08, A16, F01 |
| I9: keys, nonce/pending state and SQL protections preserved | M01, M07, F02, R01–R02 |
| I10: explicit fail-closed storage/recovery errors | A17, M04–M07, S01–S02 |

Before coding, expand the existing IDs into explicit subcases; keep the 37
top-level IDs rather than treating their broad labels as executable tests:

| IDs | Required clarification/additional subcases |
| --- | --- |
| A01–A03, M01–M02 | Positive controls: a ready fresh/migrated account must display the latest valid edit and unrelated valid messages. A01/A02 cannot pass solely through blanket quarantine. A03 must assert preserved source and explicit quarantine, not a fabricated zero head. |
| M02, M06–M08 | Cover root-zero and nonzero heads, active/deleted variants, changed aliases, duplicate aliases, repeated receipts and two migrators. A receipt cannot retarget an entry or decrement unresolved counts twice. |
| A14, A17, M07–M08 | Inject failure after each staged head/alias/receipt/count write and after individual request success but before transaction completion. Final ready checks must be atomic; no partial plaintext release. |
| M01, M05, S01 | Distinguish a legitimate first migration with zero heads from deleted/corrupt metadata on an enrolled/upgraded account. Include a fresh account in a profile containing another account's legacy records and an unassignable corrupt key. |
| A12–A14, C03 | Specify the read/commit linearization point. Delay publication and deliver invalidations, suppress hints, and suspend/resume tabs. Require no stale state overwrite; do not claim simultaneous erasure of every tab's already displayed pixels. |
| C02, F01–F02 | Exercise pin removal, backing history, sidebar, reply quotes, Forward preview/source and media caches. Audit direct decrypt/crypto-only helpers so they cannot bypass the publication gate. Local hiding must never remove security records. |
| M09–M10, R01 | Test old tabs/workers, an old cached build, retained memory/API access after IDB closure and a later version-1 reopen. No alternate database or storage fallback; pending ciphertext/nonces survive. |
| A05, A10–A11, A15–A17 | Invalid proofs must not become trusted fork evidence; valid forks freeze the logical scope. Unseen deletions keep unknown root/revision provenance. A server-confirmed Unsend plus local failure must not report secured success. |

M01/R01 preservation checks must verify public device identity, private-key
non-extractability, continued signing/decryption and nonce-reuse prevention
without exporting private keys. Run real Chrome cross-tab/store tests as well
as isolated fake-IndexedDB tests. R02/R03 require ordinary suites, protocol
boundaries, TypeScript/lint and proof that the running Docker client incorporates
the tested code; historical pass counts alone are insufficient.

## 7. Proposed Phase 13A.3 roadmap

These are reviewable future stages, not work authorized or started here.

| Stage | Scope | Exit criteria |
| --- | --- | --- |
| 0. Freeze decisions and test plan | Obtain D1–D5; split the 37 IDs into the required subcases, specify supported browsers and all plaintext entry points. | Written scope/owner decisions; unresolved recovery remains excluded. No live profile migration. |
| 1. Logical state engine | Typed verified evidence, compound logical keys, immutable root, alias index, atomic prefix/deletion/fork rules and current-view checks. | A04–A15 plus atomic failure/race cases on disposable stores; valid ready-account positive controls. No rewrite of V2 or edit signatures. |
| 2. Additive upgrade/inventory | Same-database version fence, generation/manifest, resumable inventory, commitment-based association and quarantine. | M01–M10 and S01–S02; original legacy/key/nonce/pending data preserved; no automatic recovery assumption. |
| 3. Messaging/cache integration | Session/history, confirmed Unsend/reconciliation, A2 pins, view caches, Reply/Forward and existing encrypted media parent-state checks. | A01–A03 and A16–A17; C/F/R regressions and both A2 probes pass. All publication/action paths use the gate. |
| 4. Upgrade and quarantine UX | Explicit blocked/recovery states, metadata-only access, old-context shutdown, stale-result invalidation and compatible rollback. | Real-browser M09/M10, cross-tab publication/reload/reconnect, no re-enrollment/reset workaround; Product/Security review. |
| 5. Integrated validation | Full relevant DATA/backend/frontend/security suites, actual two-account Chrome tests, interruption/performance/quota tests and default Docker build-incorporation checks. | All approved cases/subcases pass, D7 review complete; no SQL checksum/auth changes or additional persistent Docker environment. |
| 6. Controlled activation | D8 approval; eligible synthetic development accounts first, then separately approved existing profiles. Keep ambiguous profiles preserved/quarantined or deferred. | Recorded eligibility, expected impact and recovery plan. No assumption that security closure means legacy history recovery is complete. |

Stages 1–4 may evolve in a disposable test harness, but must not activate an
incomplete store in real profiles. Any development flag may block protected
operation; it must never downgrade an already upgraded store to v1. Optional
recovery tooling/API is a separate proposal if later approved, not hidden scope
in the core implementation. Calling and LiveKit remain outside these stages.

## 8. Remaining risks and review outcome

- Empty tombstones may be permanently unresolvable. Quarantine preserves
  integrity at a potentially severe availability cost; the team must own that
  decision rather than imply automatic recovery.
- The server can omit never-observed revisions or suppress content. Shared-key
  base messages and unsigned server deletion claims retain their existing trust
  limitations. No independent commit/freshness witness is introduced.
- Complete local-state loss/rollback and malicious same-origin code remain
  outside the guarantee. Metadata sentinels cannot prove absence of all lost
  observations. Non-extractable keys do not make compromised client code safe.
- Old active readers cannot be secured merely by a new schema version. Existing
  profiles require the approved compatibility procedure; rollback cannot erase
  newer security observations. Long-term watermark growth/durability needs a
  supported-browser and resource policy, not TTL eviction.

**Recommendation:** proceed to obtaining the specified approvals and refining
the acceptance subcases. Do not claim A1 closure, deployment readiness or approval
for Phase 13A.3 implementation from this document. This phase adds only this
review document; the original design, existing uncommitted work, Git history,
browser stores/keys, databases, Docker volumes and preserved legacy data remain
unchanged.
