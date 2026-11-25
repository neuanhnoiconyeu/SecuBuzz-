# Phase 13A: A1/A2 security review

Reviewed 2026-11-22 on `bon-fullstack`, starting at `f27ea89`; continued as Phase 13A.1.
**A2's pin-refresh cache bypass and stale UI fallback are fixed and verified.
A1 remains reproducible and blocks security approval.** No watermark reset or
speculative legacy migration was introduced.

The original findings and reproduction evidence are in the historical
[Phase 12A review](database-security-integration-review.md) and
[adversarial probes](../server/test/manual/revision-watermark-review.check.ts).
Before this review, all four original probes failed with restored original
plaintext. Tests use isolated DATA databases/accounts and synthetic enrolled
devices with production client crypto; only the final read response is replayed.
They do not access Docker accounts, existing browser profiles or legacy keys.

## A1: storage-alias substitution bypasses persisted rollback protection

**High severity, P1; unresolved.**

Affected code:

- [storage.ts](../client/src/security/e2ee/storage.ts): `observeRevision` persists
  `[accountId, 'message-revision', storageId]` with `{revision, hash, deleted}`.
- [edits.ts](../client/src/security/e2ee/edits.ts): `verifyEditedContent` consults
  that storage-ID record after authenticating message/revision content.
- [session.ts](../client/src/security/e2ee/session.ts): history records terminal
  Unsend using the same storage ID.

The original V2 AEAD envelope authenticates the logical conversation/message
identity, but not DATA's separately generated storage ID. Signed edits bind
their storage ID, but an attacker can replay the valid **original** envelope
without any edit snapshot. Substituting a new, valid-looking storage ID gives
the rollback check an unused key. The recipient then accepts original content
despite previously observing an edit or Unsend under the original storage ID.

Reproduce with the `rebind-edit` and `rebind-unsend` probes: enroll two isolated
accounts, send text, verify an edit/deletion as the recipient, then create a
fresh recipient session sharing its IndexedDB and replay the original history
DTO with only `storageId` changed. The same DTO with its real storage ID is
rejected; the alias-substituted DTO still yields original plaintext.

This requires a rewritten/replayed authenticated response, such as a malicious
or compromised response source. It is not an ordinary unauthenticated API or
CSRF bypass. Honest DATA storage IDs remain immutable, membership and sessions
remain enforced, signatures/AEAD still reject forged content, and unchanged-ID
rollback is rejected. Those mitigations do not satisfy E2EE protection against
replay by the response source. No arbitrary new plaintext or private key is
recovered, but previously observed message integrity/deletion state is lost.

### Why a transparent upgrade is blocked

A third probe now covers a real historical state: a recipient first encounters
an already-unsent message. The current client legitimately stores only
`{revision: 0, hash: '', deleted: true}` under its server storage ID. There is no
conversation ID, logical wire ID, original-envelope hash or ciphertext in that
record. Even nonempty legacy heads do not generally contain enough information
to reconstruct the logical identity without additional verified history.

Consequently, merely changing the key to `(account, conversation, wire ID)`
silently abandons old observations. Falling back only when the incoming alias
matches still allows the original attack with a different alias. Trusting a
server-supplied mapping of anonymous tombstones is insufficient against the
same rewritten-response threat. Clearing old records or browser storage loses
protection; globally blocking every unknown message until all anonymous records
are mapped would introduce an unapproved availability regression.

Per this phase's constraint, no risky workaround or browser-record migration was
applied. Security must approve an explicit, additive client-storage/protocol
upgrade contract that:

1. Keys new watermarks by account and authenticated `(conversationId, wireId)`,
   retaining the original fingerprint, highest verified chain head, deletion
   state and consistent storage-alias bindings atomically across tabs.
2. Retains every legacy record; backfills only associations established by
   cryptographically sufficient evidence, without downgrading observed heads.
3. Defines a supported policy for unresolved deletion-only records: reviewed
   trusted recovery/mapping evidence or explicit fail-closed restrictions. A
   fresh unverified server response cannot serve as that evidence by itself.
4. Covers old/new client coexistence, concurrent observations, forks, aliases,
   reload, missing local storage and migration interruption. Never reset keys,
   watermarks or existing migration ledgers to make acceptance pass.

This is a browser watermark identity/migration contract, not a reason to modify
historical SQLite migrations or weaken ciphertext-immutability triggers. The
current primary Docker database being independent does not justify silently
discarding older browser observations or changing preserved recovery profiles.

## A2: pin plaintext cache skips newer persisted watermarks

**Medium severity, P1; pin-refresh bypass fixed.**

[AuthenticatedPins.refresh](../client/src/messaging/authenticatedPins.ts)
previously returned cached plaintext whenever its DTO matched the server DTO,
even for a forced refresh. Another session/tab sharing the account's IndexedDB
could verify a newer edit or terminal Unsend; replaying the saved original pin
collection then returned the old plaintext without calling the E2EE verifier.
Editing does not need to advance the pin collection version.

Reproduce using `pin-edit` or `pin-unsend`: cache the original pin in one client,
verify the changed message in another client, replay the saved pin response and
refresh the first controller. Both original probes failed before the change.

The fix never reuses **plaintext** solely because a server DTO is unchanged.
For both normal and forced refreshes, `SecureMessagingSession.isCachedMessageCurrent`
first compares an unchanged, previously verified DTO with the shared account's
persisted revision/hash/deletion record. This is a read-only freshness check,
not authentication of new content: it never creates, resets or migrates a head.
A mismatch falls through to the existing `decryptStoredMessage` pipeline;
failed or unavailable storage cannot return cached plaintext. Unchanged, current
heads avoid unnecessary network requests and repeated crypto verification.

An actual two-tab browser probe also found that the presentation merge could
borrow an old decrypted history row after pin verification had correctly failed.
`mergePinnedRows` now preserves the unavailable pin state instead of that older
preview. A genuinely newer verified edit or terminal deletion still takes
precedence, and storage/wire consistency checks remain enforced. Generic history
merge behavior after an invalid edit is unchanged.

Cached unavailable rows retain their existing explicit retry behavior;
authorized unpin, selection/navigation, collection versions and normal encrypted
content are preserved. Honest later history restores the latest valid text.

Authorization checks and immutable server records previously mitigated ordinary
server access abuse, and uncached pin decrypts already used the verifier. The
fix closes that cache-specific verification bypass. It adds no API, database,
cryptographic format, cross-tab plaintext broadcast or key export. Normal
realtime/reconnect refreshes remain responsible for refreshing displayed pins;
already displayed/downloaded plaintext cannot be retroactively erased. A1's
alias-substitution limitation remains separate and also applies to pin reads.

## Validation

| Final verification | Result |
| --- | --- |
| Full DATA suite, isolated fixtures including migration regressions | **589 passed, 0 failed** |
| Full backend/security/integration suite | **586 passed, 0 failed; 81 suites** |
| Full frontend suite after all fixes | **1,357 passed, 0 failed; 128 suites** |
| Focused frontend UI/cache/storage subset | **63 passed, 0 failed** |
| Actual-client encrypted-edit integration subset | **6 passed, 0 failed** |
| Real Chrome `--a2-only` | **35 checks passed** |
| Real Chrome `--edit-only` | **51 checks passed** |
| Explicit adversarial probes, excluded from normal discovery | **A2: 2 passed; A1: 3 failed**, confirming its unresolved status |
| Client TypeScript (`--incremental false`), server TypeScript | Passed |
| Frontend lint; browser-runner syntax | Passed; no lint warnings/errors |
| Default Docker source/served-code/health and existing ledger | Passed; details below |

Subset counts are included in the full suites, not additional distinct tests.
The three intentional A1 failures return a nonzero process exit and remain
visible in `adversarial-verified.log`; they were neither skipped nor converted
into passing assertions.

The new Chrome case uses two tabs in the **same** recipient browser context,
sharing real account-scoped IndexedDB and the same enrolled device keys. It
holds/replays the first tab's original pin/history responses while the second
tab verifies the genuine sender's Edit or Unsend. Normal and forced refreshes
must remove the old pin text. Honest history restores the edited pin; authorized
participants can still unpin it, and Unsend removes it. These are
authenticated test accounts on an isolated real DATA/Socket.IO backend, not
demo transport or mocked cryptography. Both browser runs recorded **0 plaintext
leaks in monitored sends and 0 browser runtime exceptions**.

The encrypted-edit browser suite additionally exercises Reply/Forward, stable
identity, reactions, pinned navigation, multiline Unicode, sender authorization,
CSRF, offline/reconnect recovery, reload/logout/login, failed saves, exact-byte
retries and terminal Unsend. Frontend/storage tests cover account isolation,
unavailable/corrupt/missing watermarks without reset, missing-key retry and unpin,
and retention of newer verified edits/deletions over stale pin snapshots.

### Earlier failures retained

- The initial always-decrypt pin fix reached 49 browser checks before the final
  reload hit DATA's existing conversation-read rate limit. It was refined to
  check the exact persisted cache head locally. The final encrypted-edit run
  passes all 51 checks; rate limits and application authorization were unchanged.
- The first new two-tab run failed because the UI substituted old history text
  after pin verification failed. This confirmed the presentation defect fixed
  by `mergePinnedRows`; the final 35-check run passes both Edit and Unsend.
- A later two-tab run reached the normal-refresh check but a helper's mouse click
  on Advanced settings was covered by chat content. The helper now uses the
  summary's keyboard action. No application CSS or click protection was changed.
- An intermediate full frontend run had **1,353 passes / 1 failure**: a UI fixture
  mocked successful decryption without providing a persisted watermark store.
  Its cache-freshness mock now models a current verified head. The final complete
  run above passes; its assertions and actual storage/browser tests remain active.

Private logs/results are in ignored `.cache/phase13a-qTIkYC/`. Final browser
evidence is in ignored `client/tmp/client-realtime-8cd48556/artifacts/` (A2) and
`client/tmp/client-realtime-c44f5641/artifacts/` (encrypted Edit). Earlier failure
evidence remains in the other run directories; do not publish private fixture
databases or browser profiles. No manual verification in an existing user
profile was performed.

## Docker compatibility

Default project `secubuzz-` remains the only running Docker project at
**http://localhost:3001**. Frontend/backend retain their existing container IDs,
start times and mounts and are healthy. No rebuild, restart, volume operation or
additional persistent environment was needed.

SHA-256 comparisons confirm all four changed runtime source files are present
through the frontend's existing read-only `client/src` bind mount. The actual
workspace chunk served from port 3001 contains the final cache-head helper/check
and `mergePinnedRows`, and lacks the old cache bypass. This verifies incorporation
of the fix, not merely host-source compatibility.

The existing database was inspected **read-only**: schema 12, exact migration
ledger/checksums 0001–0012, `integrity_check=ok`, zero FK violations. No migration
runner was invoked against it. Proxied CSRF succeeds for `localhost:3001` and
rejects the port-3000 Origin. Internal DATA remains on `127.0.0.1:5000` and
LiveKit remains disabled. Functional A2/Edit browser cases ran on isolated,
temporary host test services on random ports, not against existing Docker
accounts. Preserved legacy services, volumes, stash and browser profiles were
not modified or resumed.

## Scope and required review

Runtime changes are limited to the pin cache condition, a read-only E2EE session
cache-freshness helper, and the pin/history presentation merge. Additional changes
are targeted frontend/integration/browser tests, the explicit A1 deletion-only
probe and review documentation. Authentication/session authorization, CSRF,
Origin, Socket.IO, E2EE keys/wire formats, Database migrations and Docker
configuration are unchanged.
Pre-existing uncommitted Docker/recovery documents were retained. No commit,
push, stash operation, volume recreation or legacy restart was performed.

Security should review the A2 cache boundary and the A1 upgrade requirements.
There are no Database schema/migration changes requiring approval in this phase.
Phase 13A.1 is ready for the separate **A1 protocol-design** phase, with its
deletion-only probe available as an explicit acceptance requirement. A2 has no
remaining failure in the final checks; A1 is still High/P1 and prevents overall
security clearance or merge readiness.
**Do not treat the passing ordinary suites as closure of A1 or clearance to
proceed with LiveKit Phase 10C.** LiveKit still needs its own real infrastructure,
authenticated audio/video acceptance and transport-versus-media-E2EE review.

## Changed files and Git state

Branch remains `bon-fullstack`, HEAD `f27ea89`, ahead 12 of its remote tracking
branch. Nothing is staged or committed. Runtime files:

- `client/src/messaging/authenticatedPins.ts`
- `client/src/security/e2ee/session.ts`
- `client/src/components/messenger/authenticatedChatPresentation.ts`
- `client/src/components/messenger/SecureConversationPanel.tsx`

Regression files:

- `client/src/messaging/__tests__/authenticatedPins.test.ts`
- `client/src/security/e2ee/__tests__/storage.test.ts`
- `client/src/components/messenger/__tests__/authenticatedChatPresentation.test.ts`
- `client/src/components/messenger/__tests__/SecureConversationPanel.device.test.tsx`
- `client/scripts/verify-client-realtime.cjs`
- `server/test/integration/encrypted-edits-client.test.ts`
- `server/test/manual/revision-watermark-review.check.ts`

Documentation: this new report and the follow-up notice in
`docs/database-security-integration-review.md`. The two pre-existing untracked
files `docs/docker-daily-development.md` and
`docs/legacy-to-docker-migration-plan.md` remain preserved and uncommitted.
