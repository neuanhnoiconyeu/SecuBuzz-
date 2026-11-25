# Phase 13A.2: A1 rollback-protection design

**Proposed design v0.1, 2026-11-22; requires Security and product review.**
Repository: `bon-fullstack`, HEAD `f27ea89`. Primary development origin remains
`http://localhost:3001`. This phase changes documentation only. Nothing below has
been implemented, migrated or verified as a fix. **A1 remains High/P1 and unresolved.**

## 1. Recommendation and security boundary

Use account-scoped, authenticated logical message identity as the watermark key.
Keep the original fingerprint and highest verified chain inside that record;
server storage IDs become secondary routing bindings. Upgrade the existing
browser database additively, fence legacy writers, and preserve every old record.
Never infer an anonymous legacy tombstone's identity from a new server response.

For records that cannot be associated safely, the recommended default is an
explicit account quarantine, subject to approval of its availability impact.
There is no transparent, universally available migration for information that
the old format never retained. Compatibility here means preserving ciphertext,
keys, signatures, records and APIs; it does not promise uninterrupted access for
every legacy profile. If quarantine is unacceptable, recovery evidence must be
designed and approved before those profiles can be upgraded securely.

This proposal introduces a **local watermark format 2**, not a new message
envelope or edit-signature format. V2 message bytes and edit protocol v1 stay
unchanged. SQL migrations 0008–0012, existing triggers and Docker volumes stay
unchanged. A2's verified cache checks and pin presentation protections remain.

### Root cause and threat model

The current key is `[accountId, 'message-revision', storageId]`. Original V2 AEAD
authenticates the conversation/wire identity but excludes the server-generated
`storageId`. A response source can replay a valid original under a different
storage ID and obtain a fresh watermark slot after an observed edit or deletion.
An edit's signature binds its storage ID, but omitting the edit snapshot exposes
the original-envelope path again.

Assume an adversary can replay, omit, reorder or rewrite message/history/pin DTOs
and delivery hints, but cannot break SHA-256, AEAD or verified device signatures,
change trusted application code, or directly modify the browser's local records.
Authenticated account/enrollment binding and the existing key-directory trust
model remain prerequisites. CSRF and membership checks remain mandatory; they
do not make a message response a trustworthy freshness source.

The guarantee is monotonicity of **durably observed** state in the same browser
storage context. It cannot detect a never-observed withheld edit, recover erased
keys, resist malicious same-origin JavaScript, or erase copied plaintext. Base
messages use a shared conversation AEAD key; this proposal does not add individual
sender nonrepudiation against another key-holding participant. Edits retain their
existing sender-device signatures. AES-GCM additional-data authentication is the
existing foundation, not a new primitive. [Web Cryptography, AES-GCM](https://www.w3.org/TR/webcrypto/#aes-gcm)

## 2. Existing implementation and evidence

Read in full: [A1/A2 review](security-findings-a1-a2.md) and the historical
[Database/Security review](database-security-integration-review.md).

| Existing boundary | Relevant behavior |
| --- | --- |
| [storage.ts](../client/src/security/e2ee/storage.ts) | Database `secubuzz-e2ee-v1`, IndexedDB version 1; `records` and `nonces`. Legacy watermark stores only revision/hash/deleted under an alias. |
| [protocol.ts](../client/src/security/e2ee/protocol.ts), [messages.ts](../client/src/security/e2ee/messages.ts) | Original header identity is AEAD AAD. Existing exact parsing, nonce reservation and non-extractable keys remain required. |
| [edits.ts](../client/src/security/e2ee/edits.ts), [shared revision contract](../shared/messageRevisions.ts) | Original fingerprint plus a bounded signed proof chain; store observation follows crypto verification. |
| [session.ts](../client/src/security/e2ee/session.ts) | History records alias-keyed tombstones; A2's cache helper reads the same alias-keyed record. |
| [DATA messaging](../DATA/server/messaging/service.js), [revision projection](../DATA/server/messaging/edits.js) | Server-authorized Unsend; deleted DTOs have no original ciphertext or edit snapshot. Retained database ciphertext is not a public recovery API. |
| [adversarial probes](../server/test/manual/revision-watermark-review.check.ts) | Three A1 failures: alias substitution after Edit, after Unsend, and after a deletion-only observation. A2's two probes pass. |

These are existing Phase 13A.1 results, not tests rerun by this design phase.

## 3. Logical identity and hashes

The primary key is the exact compound tuple:

`L = (authenticatedAccountId, conversationId, originalWireMessageId)`.

- Account ID comes from the verified DATA session and must match the local
  enrolled identity's user ID. Never derive it from a message, username or email.
- Conversation and original wire ID come from the AEAD-verified original or
  sufficient previously verified migration evidence. Preserve exact bytes and
  case; no timestamp rewriting, Unicode normalization or delimiter concatenation.
- An edit envelope's operation UUID is **not** the original wire ID.
- Sender identity and original fingerprint are immutable values at `L`, not
  additional partition keys. A different sender/root must not create a fresh slot.
- The browser origin is implicit in IndexedDB isolation. A server-provided realm,
  schema flag, fresh session, new device or changed API URL must not reset `L`.

Retain existing canonical hashes exactly:

`H0 = hex(SHA256(UTF8(revisionEnvelopeStatement(originalEnvelope))))`.

`Hi = hex(SHA256(UTF8(editProofStatement(proof_i))))`, for edit `i >= 1`.

Use the existing field order, lowercase hex and signature encoding. These hashes
must continue matching historical proofs and DATA's original fingerprint.
The DTO's lifecycle `revision` (active 0/deleted 1) is not the edit number:
`highestVerifiedRevision` refers to the verified edit-proof count, currently 0–20.
**Do not put `H0`, the storage alias, revision or key-epoch ID into the primary
key.** Store `H0` as a write-once value, so changed ciphertext at the same logical
identity is detected rather than assigned another bucket.

### Storage aliases

Maintain a secondary account-scoped alias index. One alias cannot bind to two
logical identities. A live logical record has one operational canonical alias;
changes are rejected, not automatically accepted as a storage migration. Track
whether a binding came from an authenticated server observation, an existing
verified edit proof, or approved recovery evidence. An original DTO's alias is
not retroactively made cryptographic by saving it.

Several legacy aliases can turn out to refer to one logical message. Preserve
all observations and merge their compatible heads/deletions; do not pick the
lowest revision or ignore an inconvenient alias. Recovery associations are not
permission to use every archived alias for PATCH/DELETE. Conflicting operational
aliases require reconciliation; none may bypass the logical watermark lookup.

## 4. Proposed additive browser contract

Keep database **name** `secubuzz-e2ee-v1`; propose IndexedDB **version 2**. Do not
create a replacement key database. Leave device keys, enrolled markers, epochs,
trust records, nonce reservations, pending sends and pending edits in place.

| New store | Key and minimum contents |
| --- | --- |
| `rollbackSystem` | Singleton: format/version, inventory progress and storage generation. |
| `rollbackAccounts` | Account ID: gate state, generation, catalog completion, unresolved/corrupt counts, expected record counts and monotonic change counter. |
| `rollbackHeads` | Compound `L`: immutable sender/root when known, verified prefix hashes, terminal deletion/provenance, canonical alias, generation and update counter. |
| `rollbackAliases` | `(accountId, storageId)`: associated `L`, binding provenance and operational/recovery-only status. |
| `rollbackLegacy` | `(accountId, oldStorageId)`: preserved legacy value or reference to an unmodified corrupt source; separate resolution status and evidence reference. |
| `rollbackEvidence` | Immutable association/conflict receipts: source commitments, mapping, evidence kind/digest and policy version; no plaintext or private keys. |

Conceptual head value, not implementation code:

```text
format: 2
accountId, conversationId, originalWireMessageId
storageGeneration
senderId: verified ID or null
originalFingerprint: H0 or null
verifiedPrefixHashes: [H0, ..., Hn] or []
highestVerifiedRevision: n or null
terminalDeletion: false or true
deletionProvenance: null, authenticated-DATA-observation, or verified-legacy-association
identityProvenance: verified-original, verified-legacy-commitment, or deletion-claim
canonicalAlias: alias or null
aliasProvenance
changeCounter
conflict: none or retained evidence reference
```

`null` is deliberate: an unseen deletion has not verified revision zero or an
original fingerprint. A nonempty verified prefix has exactly `n + 1` hashes,
starts with immutable `H0`, and is bounded by the existing 20-edit limit.
Retain the prefix at deletion; never replace it with an empty hash or revision 0.

A fresh deletion DTO can create a terminal **logical suppression claim** keyed
by its conversation/wire ID with unknown sender/root. It is a server-authenticated
claim, not an AEAD-verified original or sender-signed deletion. Later valid active
content with that logical ID remains suppressed even under another alias.
Malformed/mismatched DTOs must not replace known identity fields. This accepts
the existing server's ability to suppress content; it does not claim protection
against forged deletion by a malicious server. Stronger deletion authenticity
would require a separately reviewed signed-Unsend protocol.

Add a generation sentinel alongside existing non-key metadata and an inventory
manifest in the new stores. Never modify a private key to add migration metadata.
Missing stores, mismatched generations, malformed heads or unexpected record
loss are errors, not permission to initialize empty watermarks. Counts/digests
are corruption checks, not protection against an attacker rewriting all local
storage. Do not prune watermarks to solve quota pressure.

## 5. Atomic verification, concurrency and cache publication

Crypto preparation happens outside a live IndexedDB transaction: strict parsing,
membership/identity validation, original AEAD, complete required proof signatures,
historical signer/epoch binding, latest edit AEAD and unchanged application
metadata. Migration evidence may use the narrower commitment-verification path
defined below. Prepared evidence must be immutable and constructible only by
trusted verifier code, not accepted from arbitrary DTO fields.

Then execute one short read/write transaction spanning account gate, head,
alias, legacy-resolution and evidence stores:

1. Re-read the account generation/gate and current `L`; never commit against an
   earlier in-memory head. Only normal `ready` operations may release plaintext.
2. Validate immutable root/sender and both directions of alias bindings.
3. For active candidate revision `m`, require no terminal deletion and an exact
   known prefix. If the stored revision is `n`, require `m >= n` and candidate
   hash at `n` equal to the stored head. An equal head is idempotent; a compatible
   extension advances monotonically. A lower response is unavailable, not new.
4. For an authorized, structurally valid deletion observation, set terminal
   suppression at `L` and preserve any known verified prefix/root. A known
   identity mismatch is an error; an unseen claim must not manufacture verified
   sender/root fields. Check persistence success on this path too.
5. Preserve compatible imported legacy observations atomically. OR terminal
   deletions together. Merge verified prefixes only when they are comparable;
   do not use `max(revision)` without prefix verification.
6. On a valid, authenticated conflicting chain/root, retain conflict evidence,
   preserve the previously committed head, and freeze that logical message.
   Invalid signatures/AEAD are rejected without becoming trusted fork evidence.
7. Commit the head, alias bindings, counters and any resolution receipt together.
   Return success/verified plaintext only after transaction completion.

IndexedDB schedules overlapping read/write transactions serially; request
success alone is not transaction success. Use that transaction boundary rather
than tab-local locks as the source of truth. [IndexedDB transaction rules](https://www.w3.org/TR/IndexedDB-3/#transaction-scheduling)

No network call, WebCrypto await, timer or UI interaction belongs inside that
transaction. A read racing with an edit must recheck the latest committed head;
two tabs cannot lower it. An edit-versus-deletion race ends terminal regardless
of ordering. Wall clocks, DTO sequence, `updatedAt` and pin collection versions
never authorize a lower head. Quota/abort/unavailable storage must not fall back
to memory/localStorage or release uncommitted verified content.

### Publication and A2 preservation

Tag each verified cached view with `L`, root, head hash/revision, account/storage
generation and change counter. Cache reuse reads the account gate and exact head
together. Failed checks invalidate dependent message, pin, sidebar, reply,
forward-source and media views; a pin's removal must not resurrect an older
history cache. Preserve newer verified views instead of replacing them with an
older rejected DTO. A2's current pin guards must move to the new logical lookup.

Post-commit cross-tab hints may carry identifiers/counters, never plaintext or
keys. They only trigger invalidation/rechecks; a forged or missing hint cannot
advance a head. Focus/resume/reconnect must revalidate cached views. Version
change/disposal invalidates pending async results as well as database handles.

Freshness is linearized at the successful store check/commit before publication,
not at a guaranteed simultaneous pixel update in every tab. Already displayed,
copied or downloaded content cannot be retroactively erased.

## 6. Legacy migration and the anonymous-tombstone decision

### Inventory before plaintext

After the version fence, new code must never call the legacy watermark writer.
Create an inventory-pending marker during the structural upgrade. Inventory the
frozen legacy watermark keys in resumable transactions; copy only watermark
values, not device/key records. Keep original v1 entries unchanged. Commit each
batch and its cursor/counts together; mark the catalog complete only after all
entries are accounted for. A partial scan or an exhausted server-history search
cannot establish that legacy observations are absent.

Classify per account: nonempty committed hash; empty deletion-only record;
malformed/corrupt entry. Existing legitimate v1 account data with zero watermark
entries may become ready after completed inventory, without re-enrollment.
A genuinely new account must initialize its metadata before protected reads;
an enrolled account with missing expected metadata is not treated as new.
An unassignable corrupt legacy key blocks classification rather than being
silently ignored. Preserve pending encrypted operations during every state.

### Association rules

| Legacy record | Sufficient evidence | Required action |
| --- | --- | --- |
| Revision 0, nonempty `H0`, active or deleted | Exact original-envelope commitment matching that saved hash; association relies on the old locally verified commitment. | Bind its exact conversation/wire identity. Preserve deletion if set. New plaintext still requires normal AEAD verification. |
| Revision `n > 0`, nonempty saved `Hn` | Matching signed proof commitment at `n`, valid existing device/epoch trust, and the required bounded prefix establishing `H0`, logical identity and ownership. | Import the highest compatible head; preserve deletion. Missing proof/key trust keeps it unresolved. |
| Empty hash and terminal deletion | No cryptographic message identity survives in the local record. | Do not auto-associate; retain unresolved tombstone and quarantine under the approved policy. |
| Malformed record or contradictory evidence | No safe normal association. | Preserve source, report corruption/conflict and block affected scope. |

Match committed hashes account-wide against verified evidence, not just the alias
in the current DTO. A matching legacy record must still be found when an attacker
changes the presented alias. Root/head commitments may establish a recovery
association without releasing plaintext; never mistake a server-supplied digest
for a matching local commitment. Do not relabel an arbitrary hash as `H0` or
ignore an unmatched legacy record to finish migration.

Current deleted history omits original/revision evidence. Some associations may
therefore remain unavailable through existing APIs. A proof-only recovery source
could help nonempty edit commitments, subject to access/retention review. It does
not solve the empty-hash case.

### Safe approaches for unresolved tombstones

| Approach | Security assessment and availability |
| --- | --- |
| Cryptographically verified association | Preferred when a surviving **local commitment** can be matched. No new trust source; limited by missing evidence. Empty-hash tombstones have no such anchor. |
| Reviewed trusted recovery evidence | Conditional, exceptional trust decision. Must establish the historical observation-to-logical-identity binding and completeness, with provenance, cutoff, account binding and recorded approval. A fresh REST map, current DB lookup, screenshot, own-device signature over today's map, or newly signed alias assertion is insufficient by itself. |
| Fail closed | Recommended default when evidence is absent. Preserve all records and withhold protected plaintext/actions for the account until ambiguity is resolved. Safe for integrity; potentially indefinite loss of availability, requiring explicit approval before rollout. |

Even a genuine new edit signature mentioning an old alias does not by itself
prove which message an earlier **unsigned, anonymous** deletion observation
referred to. That alias might already have been substituted before migration.
Assuming all pre-upgrade aliases were honest is an additional trust assumption,
not cryptographic recovery. A trusted recovery policy must say so explicitly.

### Quarantine scope and release

An unknown record has no trustworthy conversation scope. It can also refer to
an identity that another legacy alias has already associated. Therefore the
safe default blocks **all account plaintext**, including apparently resolved
heads, while any anonymous/otherwise unscoped legacy record remains unresolved.
Blocking only the old alias, only new messages, or only unknown conversations
does not close the substitution attack. Narrower quarantine requires trustworthy
scope evidence; other accounts in the origin remain independent.

Authentication, logout, device-status/help and metadata-only recovery views may
remain usable. Protected sending/editing/forwarding and attachment/voice use
must not advertise normal operation while the account is quarantined. Do not
offer a reset, fresh origin, new profile or silent re-enrollment as recovery.
Delete for Me remains separate and never deletes a watermark.

Resolve entries atomically with head/alias updates and evidence receipts. Merge
all duplicate-alias observations; any conflicting association stays blocked.
Each receipt must bind the account/storage generation, original legacy key and
exact source-value digest, resulting logical identity/root/head, preserved
deletion flag, evidence kind/content reference and approved policy version.
Trusted recovery additionally records authority, historical cutoff and approval;
these fields do not substitute for the required evidence. Receipt replay may be
idempotent but cannot decrement unresolved counts twice or retarget a record.
The final transition to `ready` rechecks the complete inventory, zero unresolved
or corrupt records, expected counts, compatible imported heads and storage
generation. Revalidate prepared views after that transition. An administrator's
"ignore this entry" checkbox is not a secure resolution.

## 7. Old/new clients, rollout and rollback

Upgrade the **same database** to version 2. The browser waits for existing
connections before upgrading, and an explicit version-1 open then fails with
`VersionError`. A separate database or a new record kind alone cannot fence old
writers. [IndexedDB connection/version rules](https://www.w3.org/TR/IndexedDB-3/#opening)

This is not a guarantee that old tabs stop showing memory-cached plaintext or
making non-IDB API requests. Current code closes its handle on version change
but does not constitute a complete secure-client shutdown protocol. Secure
simultaneous use of **unmodified** old clients is not supported.

| Combination | Rollout policy |
| --- | --- |
| Two upgraded clients/tabs sharing one origin/account | Supported via the shared atomic store and view rechecks. |
| New client with active old-version tab/worker | Upgrade pending: close/reload all old application contexts, preserve/reconcile pending operations, and verify a compatible client build before activation. Never force database deletion to unblock it. |
| Old client started after upgrade | Fail closed on version mismatch. No alternate database name, storage fallback, downgraded format or private-key copy. |
| Other browser/device or port | Independent observation history. Existing E2EE device enrollment applies; no claim of shared rollback watermarks or historical-key recovery. |
| Current Phase-11-compatible server with upgraded client | Existing V2/edit APIs remain compatible; unsupported recovery evidence leaves migration pending, not weakened. |

A bridge release may improve upgrade messaging and shutdown, but a version flag
cannot make an unmodified reader enforce new security. Client-version API gates
are optional honest-deployment safeguards, not cryptographic proof of client
behavior. If the team requires old clients to remain fully active, the same
rollback guarantee cannot be claimed for those readers.

Recommended sequence: approve this policy; implement/test on disposable browser
stores; deploy the compatible client; coordinate quiescence/reload; perform the
additive fenced upgrade; inventory/recover; activate only eligible accounts.
Keep pending request ciphertext/nonce/operation IDs unchanged and reconcile
uncertain server outcomes before retry. No current environment operation is
authorized or performed by this design document.

There is no downgrade to format 1 once format-2 observations exist. Application
rollback must use a compatible client that retains format-2 enforcement, or
stop protected operations. Restoring an older browser snapshot can lose observed
heads; restoring an old server database can make current heads unavailable.
Neither justifies lowering them. Keep generations/backups and use reviewed
forward recovery. Do not restore over live Docker volumes or mix account stores.

## 8. Feature integration requirements

| Path | Required behavior |
| --- | --- |
| Send and incoming realtime | Record/reconcile a verified original before first protected publication. Frames/hints may trigger durable-history verification; original-only frames never overwrite a newer logical head. Separate internal crypto-only pending-request comparison from display authorization. |
| Edit | Verify original and complete signed prefix as today; atomically extend the logical head. No revision reset on alias/key rotation, no arbitrary ciphertext replacement, and no change to reply/forward metadata. |
| Unsend | Preserve sender-authorized REST behavior. Persist terminal logical state on every confirmed response/history path before claiming secured success, including lost-response reconciliation in `AuthenticatedUnsend`. Raw realtime hints are not deletion proofs. A failed request never deletes the original; a server success plus local persistence failure is an unavailable/uncertain local-security state, not a success fallback. |
| New unseen deletion | Store a terminal suppression claim at the claimed logical ID; root/head remain unknown. It must block later valid content with that ID under any alias. Do not assert a sender-signed deletion or manufacture a fingerprint. |
| Pin and reactions | Pin plaintext/cache/navigation uses the logical watermark and account gate; pin version is not edit freshness. Preserve A2 behavior and prevent stale history fallback after pin removal. Reaction/pin metadata authorization and persistence remain unchanged. |
| Reply | The reference is a locator, not proof of original words. Resolve against currently verified logical state; deleted, hidden, quarantined or unavailable originals reveal no cached snippets. |
| Forward | Recheck the source view token before encrypting an independent message for each destination. A copied original/root is not a new source watermark. Preserve pending operations and partial-failure/idempotency behavior; media forwarding remains disabled. |
| Delete for Me | Local hiding neither weakens nor removes original/revision/deletion watermarks. |
| History, reload, offline/reconnect | All pages and pin fetches use one verifier/store. Reordered/partial pages cannot lower heads or mark an unfinished migration complete. Persisted same-origin observations survive sessions; unavailable evidence stays unavailable offline. |
| Files and voice | Preserve V2 manifests, file keys, upload APIs and Unsend access invalidation. Gate new decrypt/playback/download and cached media reuse on the parent logical state. Release view resources when invalidated; already exported copies cannot be recalled. |

## 9. Failure modes and security invariants

Normal operation must satisfy all of the following:

1. One account/conversation/wire identity has one protected head, regardless of
   aliases, source endpoint, sessions or UI components.
2. A verified original root/sender is immutable. Revision numbers alone never
   authorize new content; signatures, AEAD, prefix commitments and trust checks
   remain mandatory.
3. A terminal deletion is irreversible through normal reads, edits, retries,
   reconnection, unpinning or browser reload. It never erases a higher saved head.
4. No plaintext is newly published/reused until its logical state and account
   gate pass. Already visible caches are invalidated/rechecked, not a bypass.
5. Successful observation is durably committed before presentation. Failed
   storage or aborted transactions cannot be reported as secured success.
6. Every legacy record remains preserved and accounted for. Unknown is not zero,
   an empty deletion hash is not `H0`, and missing evidence is not resolution.
7. Old writers are fenced before inventory is trusted. Old readers are not
   advertised as protected merely because new readers are correct.
8. Alias conflicts cannot create another logical bucket or redirect mutations.
   Account identity never comes from message metadata.
9. Keys, nonce ledger and existing pending ciphertext are neither regenerated nor
   exported. No SQL ledger/checksum/immutability protection is changed.
10. Quota, corrupt metadata, partial inventory, blocked upgrades and unavailable
    keys fail closed with distinct feedback, not a reset or memory fallback.

Interrupted schema upgrades/batches must be atomic or resumable with the account
gate closed. Missing generation metadata alongside existing enrolled state is
corruption/recovery-required, not first use. A missing indexed head with a
remaining alias/manifest entry is not an unseen message. Validate inventory
counts at initialization and reject inconsistent records. Never TTL-expire a
security observation. A narrower safe compaction scheme is outside this phase.

Request strong transaction durability where supported and test browser behavior;
do not promise recovery from total eviction, coordinated local snapshot rollback
or storage/hardware failure. Browser transaction semantics alone cannot provide
an independent freshness witness against loss of the entire security history.

## 10. Implementation boundaries and server/database needs

| Area / affected files | Future implementation work; none performed here |
| --- | --- |
| `client/src/security/e2ee/storage.ts` | Same-name version upgrade, new stores/generation, resumable inventory, atomic logical-head/alias/evidence operations and strict validation. Preserve v1 source and all key/nonce data. |
| `client/src/security/e2ee/{edits,session,model}.ts` | Separate verified evidence from DTO claims; logical observation/deletion/cache APIs; account gates and explicit unavailable/conflict errors. Existing crypto statements/limits unchanged. |
| `client/src/messaging/authenticated{Pins,Unsend,Forwarding,Attachments}.ts` | Route plaintext and successful deletion paths through the new gate; preserve idempotency, A2 and media protections. |
| `client/src/realtime/SecureRealtimeWorkspace.ts` | History/frame reconciliation, cross-context invalidation and propagation of verified unavailability without older cache resurrection. |
| [SecureConversationPanel.tsx](../client/src/components/messenger/SecureConversationPanel.tsx), [authenticatedChatPresentation.ts](../client/src/components/messenger/authenticatedChatPresentation.ts) | Account quarantine/recovery feedback; cache-token enforcement for previews, actions, pins and replies. Reuse current UI/theme. |
| Storage/edit/pin/presentation unit tests; `server/test/integration/encrypted-edits-client.test.ts`; `server/test/manual/revision-watermark-review.check.ts`; `client/scripts/verify-client-realtime.cjs` | Convert all A1 probes into passing ordinary regression coverage; add migration/race/real-browser cases below. |

**Core A1 protection needs no server API or SQLite schema change.** Existing
V2 headers, signed edits and authorized history already provide the normal
verification inputs. No change is proposed to `shared/messageRevisions.ts`,
message AAD, DATA authentication/CSRF, Socket.IO authorization or migrations.

An optional, separately reviewed **proof-only recovery API** could expose bounded
retained signed proofs and public signer/epoch evidence to authorized original
participants. It must preserve membership/session/Origin policy, avoid plaintext
or file keys, respect Unsend retention rules, and never revive attachment access.
It might reuse existing tables without a migration. Its availability and data
disclosure contract need Backend/Database/Security review; it is not required to
ship the core store, not currently implemented, and cannot identify an unanchored
empty legacy tombstone by itself. Exposing deleted ciphertext for convenience
is not part of this recommendation.

## 11. Acceptance matrix for Phase 13A.3

Every row is a future requirement, not a claimed pass in this design phase.
Use isolated stores/accounts and genuine production crypto; replay only test
responses. Real Chrome tests must include separate tabs sharing real IndexedDB.

| ID | Scenario | Required outcome |
| --- | --- | --- |
| A01 | Existing `rebind-edit` probe | Original under a fresh alias yields no plaintext after observed edit. |
| A02 | Existing `rebind-unsend` probe | No resurrection under a fresh alias after observed deletion. |
| A03 | Existing deletion-only probe against a v1 fixture | Unresolved account remains explicitly quarantined; no reset or plaintext. |
| A04 | Same wire ID in different conversations/accounts | Exact namespace isolation; no collisions or cross-account suppression. |
| A05 | Same `L`, different valid original fingerprint/sender | Conflict, not a fresh identity bucket. Invalid AEAD cannot establish a root. |
| A06 | DTO conversation/wire ID changed without re-encryption | AEAD/proof rejection before any trusted state update. |
| A07 | One alias mapped to another `L`, or alias changed at known `L` | Reject route/binding; retain original head and evidence. |
| A08 | Two legacy aliases associate with one `L` | Merge compatible prefixes and OR deletions; conflicting mappings stay blocked. |
| A09 | Lower/equal/higher valid revisions; dropped prefix | Reject lower/broken prefix, idempotent equal, accept only compatible higher. |
| A10 | Same-revision fork or valid nonextending chain | Retain prior head, freeze conflict; no last-response-wins. |
| A11 | Tampered proof/ciphertext/owner/metadata | Existing signature/AEAD/metadata checks still fail closed. |
| A12 | Concurrent tabs read old/new revisions in either order | No downgrade; latest compatible committed head governs publication. |
| A13 | Edit/Delete and Delete/old-read races | Terminal state wins without dropping the verified prefix. |
| A14 | Stale crypto preparation while another tab commits | Transaction re-read rejects obsolete evidence. |
| A15 | New-format unseen deletion, then original under another alias | Logical suppression claim remains terminal with unknown root. |
| A16 | Own Unsend success, recipient event, offline recovery, lost response | Durable logical tombstone on all confirmed paths before secured success. |
| A17 | Failed Unsend or quota failure after server confirmation | No false success, no replacement watermark; clear failure/uncertainty and safe reconciliation. |
| M01 | Fresh origin and v1 account with zero legacy heads | Safe initialization without changing existing device/nonce data. |
| M02 | Nonempty root/head migration evidence under another alias | Association by verified local commitment, never alias-only lookup. |
| M03 | Empty tombstone plus fresh server map/new signature | No automatic resolution; quarantine remains. |
| M04 | Missing proofs/key trust, limited history search, withheld evidence | Preserve unresolved entry; no "migration complete" from absence. |
| M05 | Partial valid associations while one anonymous record remains | No account plaintext, including apparently resolved identities. |
| M06 | Approved recovery receipt wrong account/scope/cutoff or incomplete | Reject; record neither becomes ready nor loses deletion. |
| M07 | Crash/abort during upgrade, inventory, association or final release | Atomic preservation or resumable closed gate; repeat-run idempotency. |
| M08 | Two migration tabs and live verification | One coherent inventory; no lost rows, duplicate application or premature release. |
| M09 | Old tab/worker blocks upgrade; version-1 reopen after upgrade | No deletion workaround; blocked upgrade or version failure, no v1 writes. |
| M10 | Old cached code retains memory/API access | Demonstrate fencing limits; coordinated shutdown required, not a false compatibility pass. |
| S01 | Corrupt/missing record/store/manifest/generation, quota, denied IDB | Distinct fail-closed feedback; no automatic empty store or key regeneration. |
| S02 | Missing all local security history / old browser backup | No claim of retained rollback protection; explicit recovery limits. |
| C01 | Existing two A2 probes and `--a2-only` | Both cache and UI protections remain green. |
| C02 | Pin cache, unpin/removal, sidebar and reply fallback after cross-tab change | No older plaintext reappears from another derived cache. |
| C03 | Forged/lost cross-tab hint, suspended tab and resume | Hints cannot authorize; actual store/gate governs new view reuse. |
| F01 | Reply/Forward, multiline edits, reactions, local hiding | Stable identity/metadata, safe unavailable references, no duplicate forwards. |
| F02 | Attachments/voice, cached media and terminal Unsend | Parent watermark enforced; ciphertext-only storage and access invalidation preserved. |
| R01 | Reload/logout/login, offline/reconnect and uncertain requests | Same monotonic state; exact pending bytes/nonces retained. |
| R02 | Full frontend/backend/DATA, TS/lint and protocol boundaries | Existing suites green; no SQL migration checksum or security-control changes. |
| R03 | Existing default Docker on port 3001 | Source/served build compatible; no extra persistent project or volume replacement. |

Release requires independent Security review of the verifier/transaction boundary,
explicit approval of unresolved-record policy and rollout fencing, passing all
three A1 adversarial scenarios, preserved A2 coverage, and real-browser history/
cache consistency. Do not count a skipped/expected-failure probe as resolution.

## 12. Open decisions and residual risks

1. **Security/product:** approve account-wide quarantine for unscoped legacy
   observations and its potentially indefinite availability impact. If rejected,
   define acceptable historical recovery evidence before implementation rollout.
2. **Security:** specify trusted recovery authority, evidence provenance/cutoff,
   verification format and approval retention. No existing supported workflow is
   assumed; this document authorizes none.
3. **Frontend/release:** approve the same-origin all-context shutdown/reload
   procedure and minimum-client policy. Version fencing alone is insufficient
   for old in-memory readers. Do not deploy a misleading dual-write downgrade.
4. **Backend/Database:** decide whether proof-only recovery is warranted and
   compatible with retained-data access policy. No historical SQL edits; any
   eventual new persistence would require its own additive reviewed contract.
5. **Security/browser platform:** agree supported durability behavior, limits,
   quota UX and long-term watermark growth. No security-record eviction policy
   has been designed here.

Residual limits remain: no trusted global freshness witness; no protection from
complete local-state rollback/eviction or same-origin compromise; existing
authenticated-directory/TOFU trust; no cross-origin key migration; suppression
by a malicious server; and no retroactive erasure of plaintext already obtained.
An authentic signed edit proves sender intent, not an independent certificate
that it won DATA's concurrent commit. Honest DATA CAS remains authoritative for
normal writes; incompatible authentic branches from a dishonest response source
must freeze locally rather than select a winner by server timestamps.
Anonymous legacy tombstones can remain unrecoverable without additional trust.
LiveKit and calling protocols are outside scope and remain unverified.

**Review outcome:** the proposal is ready for team discussion, not approved for
deployment. Phase 13A.3 must be a separately authorized implementation phase.
Only this design document was added; existing uncommitted implementation and
review files, keys, browser stores, databases, stash and Docker were preserved.
