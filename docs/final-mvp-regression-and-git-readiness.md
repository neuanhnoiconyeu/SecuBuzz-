# Final MVP regression and Git readiness

Reviewed 2026-11-23 on `bon-fullstack`, HEAD `f27ea89`.

Functional regression passed. Ready to prepare reviewed local commits and a **draft team-review PR**. **A1 High/P1 remains reproducible and blocks security clearance and a security-ready merge/release.** All staging/commit commands below are proposals; none executed.

## Final automated verification

Counts below are final runs, not sums of retries/subsets. Browser checks are
acceptance assertions, not additional unit-test cases. No human-operated physical
microphone/camera or existing user browser profile was tested.

| Suite | Passed | Failed | Pending |
| --- | ---: | ---: | ---: |
| Full frontend, serialized (130 suites) | 1,379 | 0 | 0 |
| Full backend/integration/E2EE (82 suites; 640 registered cases) | 603 | 0 | 37 |
| Full DATA, isolated fixtures/migration/property tests | 589 | 0 | 0 |
| Local LiveKit configuration/preservation/exposure tests | 4 | 0 | 0 |
| A1 adversarial security expectations | 0 | **4** | 0 |
| A2 adversarial pin-cache expectations | 2 | 0 | 0 |
| Native browser IndexedDB prerequisites | 5 | 0 | 0 |
| Browser acceptance, nine flows | 322 | 0 | 0 |

The 37 backend TODOs are the unimplemented Format-2 acceptance contracts. They
are neither passing security verification nor approval. Four A1 probes retain
nonzero failure exits: edited-message alias rollback, unsent-message alias
rollback, anonymous legacy deletion-only alias replay, and conflicting valid
original/fingerprint under another alias. A2 is fixed; **A1 is not fixed**.

Client/server TypeScript, frontend ESLint (no warnings), isolated production build
and diff whitespace verification passed. Backend/DATA have no separate configured
ESLint command. E2EE, calling and Buzz tests are included in the full suites above;
focused reruns are not counted again.

### Browser scope

| Existing runner / flag | Checks | Actual coverage |
| --- | ---: | --- |
| `verify-client-realtime.cjs --edit-only` | 51 | Signed encrypted multiline/Unicode revisions, Reply/Forward metadata, reactions/pins, sender/CSRF rules, failures/retries, realtime, reload/logout/login and terminal Unsend |
| `--reply-forward-only` | 32 | Sender/recipient replies, original navigation, validated destinations, independent destination encryption and duplicate-safe partial-note recovery |
| `--local-delete-only` | 32 | Shared Delete dialog, sender/recipient Delete for you, local hides across refresh/logout/reconnect/account isolation, retained server records, emoji picker/cursor/search |
| `--unsend-only` | 36 | Delete for everyone UI, server confirmation, failure preservation, two-user tombstones, offline/reload recovery, stable identity and authorized hints |
| `--attachments-only` | 47 | Valid image/video/PDF/Word fixtures, ciphertext-only upload, authorized download/decryption/rendering, corrupted ciphertext, failures/retries, reconnect/logout/login and Unsend invalidation |
| `--voice-only` | 49 | Actual synthetic-microphone MediaRecorder capture, preview, ciphertext upload, recipient playback, cancellation, permission denial, URL/track cleanup, interruption/retry and Unsend |
| `--a2-only` | 35 | Two recipient tabs sharing real test IndexedDB; stale pin/history replay after verified Edit/Unsend; normal/forced refresh and recovery |
| `verify-authenticated-calls.cjs --isolated` | 29 | Real default-Docker LiveKit SFU, two authenticated accounts, synthetic audio/video publication/subscription, inbound audio energy/samples and decoded video frames both ways, mute/camera, accept/reject/cancel/end, reconnect, permission/token failures and cleanup |
| `verify-authenticated-buzz.cjs --reuse <owned ignored fixture>` | 11 | Primary Docker on port 3001, same two synthetic profiles, two-way Buzz, cooldown, reduced motion, keyboard/reload/reconnect, mobile layout and unchanged history |

All nine browser runs passed with zero runtime exceptions. Messaging browser
flows reported zero plaintext leaks in monitored transports; encrypted media
checks additionally verified ciphertext-only uploads and successful authorized
client-side decryption. These are bounded monitored checks, not a proof about all
possible application traffic. Calls made zero attachment requests. Buzz contains
ephemeral authenticated metadata, not E2EE message content. No call-media E2EE is
claimed: WebRTC transport encryption terminates at the SFU.

## Confirmed fixes in this review

Only two test-harness files changed; no application runtime or migration changes:

1. `server/test/integration/client-compatibility.test.ts`: the legacy Phase 8.7A
   contract comparison incorrectly rejected the new authenticated Buzz extension.
   Explicitly whitelist/assert the shared Buzz names while retaining strict legacy
   event, error and authorization assertions. Initial full backend: 602 passes,
   1 failure, 37 TODOs. Corrected compatibility subset: 26/26; final full backend:
   603 passes, no failures, 37 TODOs.
2. `client/src/auth/__tests__/workspaceIntegration.test.tsx`: repeated aggregate
   15-second timeouts during overlapping full suites/browser jobs left unfinished
   lifecycle work and a subsequent StrictMode assertion failure. The same three
   tests passed unchanged in isolation. Increase only the multi-workspace test's
   overall budget to a bounded 30 seconds; retain every assertion and local wait.
   Earlier full runs: 1,378 pass / 1 timeout, then 1,377 pass / 2 failures (timeout
   plus the subsequent StrictMode assertion). Final serialized result is above.

All earlier failure logs are retained. No A1 expectation was skipped, inverted or
marked passing. No Format-2 runtime, quarantine, watermark reset or migration was
introduced. This report is the only new review document.

PowerShell redirects Jest's normal stderr progress as `NativeCommandError`; the
execution wrapper can consequently return 1 even when the native process passes.
A benign stderr-only process exiting 0 reproduced that wrapper result, and an
explicit `$LASTEXITCODE` rerun of the three workspace tests returned **Jest exit
0**, all passing. The final full Jest assertion report is 1,379 passed / 0 failed.
When capturing native-tool logs in PowerShell, retain and propagate
`$LASTEXITCODE`; do not classify progress output as a failed test.

## Default Docker and data preservation

Project `secubuzz-`, `compose.yaml + compose.calls.yaml`, remains at
**http://localhost:3001**. Backend/frontend are healthy; the existing pinned real
LiveKit server is reachable. Its room API reports zero remaining rooms after
acceptance. Containers were not rebuilt/recreated/restarted in this review.
SHA-256 comparisons matched all 19 pending runtime files against the running
containers. No new persistent project was created. Legacy recovery is stopped.

Most feature browsers used disposable real DATA/Next services on random ports,
isolated SQLite/files and owned synthetic browser contexts, all stopped after
completion. They did not run against or merge primary/legacy account databases.
The call runner used those disposable authentication services with the existing
real Docker SFU. Buzz reused only its two existing synthetic primary profiles.

Consistent read-only before/after primary snapshots show:

- 12 users, 4 conversations, **5 messages**, 4 device records, 0 attachment rows:
  all counts unchanged; every original row across 32 business tables preserved.
- Schema, indexes/triggers and migration ledger/checksums 1–12 unchanged.
- SQLite integrity OK; foreign-key check returned no violations.
- No new primary accounts, keys or messages were created by this review. Normal
  session/challenge/rate-limit records may change through authentication/expiry.
- Host/legacy databases, named volumes and stash `63aba73` are preserved. No
  migration, stash operation, Docker cleanup or key extraction was performed.

Private logs/evidence: ignored `.cache/final-mvp-*.log`, inventory/runtime-source/
browser-summary/preservation JSON, isolated `client/tmp/client-realtime-*/artifacts/`
and `.cache/phase10c-calls-dbdf3066/evidence.json`. Do not publish fixture databases,
browser profiles, screenshots, credentials or snapshots.

## Git inventory and review boundary

Fetched `origin` metadata only. Branch remains `bon-fullstack` at `f27ea89`:
**0 behind / 5 ahead of origin/main** (`fb9083e`),
**0 behind / 12 ahead of origin/bon-fullstack** (`e0e25ef`). Nothing is staged.
No commit, push, merge, rebase, checkout, reset or stash application was performed.
The 55 existing pending source/test/doc files were preserved byte-for-byte.
Review additions are the two test fixes above plus this document: 58 paths total.

Initial ignored inventory contained 76,726 files (it grows with disposable test
output): dependencies, `.cache/`, `client/tmp/`, isolated `.next-e2ee-*/` builds,
profiles/IndexedDB, snapshots, backups and local configuration. The proposed source
paths had no private-key headers, recognizable credential tokens or literal secret
assignment findings in a targeted scan. This is a bounded scan, not security
approval or a complete historical secret audit.

**Exclude from every proposed commit**, preserving files in place:

- `DATA/server/database/database.sqlite`, `database.sqlite-shm`,
  `database.sqlite-wal`; `client/tsconfig.tsbuildinfo`.
- `DATA/.env`, all local environment/credential files,
  `docker/secrets/` (including the existing LiveKit pair), private keys.
- `docker/backups/`, `.cache/`, `client/tmp/`, browser profiles, test snapshots,
  recordings/screenshots/logs and generated builds/dependencies.
- Existing tracked historical `artifacts/phase8-7a/*.log` files.

Some database/build/log paths are already tracked despite ignore rules; ignore
rules alone cannot protect them from broad staging. Leave that unrelated history
and those working files alone. The tracked, ignored `DATA/package-lock.json` is a
legitimate existing dependency lock and is unchanged; do not remove it.
Historical migrations 0008–0012 are already committed and unchanged.

## Exact proposed staging and commit plan — NOT EXECUTED

All 58 paths below are source, tests, configuration templates/generator code, or
review documentation. They are disjoint and exhaustive. The shared capability
file mixes Buzz and direct-call gates; these are file-level slices of one tested
MVP. Review the complete sequence together; do not treat intermediate commits as
independently deployed/approved releases. None of these commands has been run.

```powershell
Set-Location 'D:\Project\SecuBuzz-'
git branch --show-current
git status --short
git diff --cached --name-only
# The index must still be empty; review any intervening user/team work first.
```

### 1. fix(messaging): finalize A2 verification, Delete and authenticated Buzz

36 explicit paths:

```powershell
$files = @(
  'client/scripts/verify-authenticated-buzz.cjs'
  'client/scripts/verify-client-realtime.cjs'
  'client/src/auth/__tests__/workspaceIntegration.test.tsx'
  'client/src/components/YahooChatWindow.actions.test.tsx'
  'client/src/components/messenger/MessageComposer.tsx'
  'client/src/components/messenger/MessageList.tsx'
  'client/src/components/messenger/SecureConversationPanel.tsx'
  'client/src/components/messenger/UnsendDialog.tsx'
  'client/src/components/messenger/__tests__/MessageComposer.voice.test.tsx'
  'client/src/components/messenger/__tests__/MessageList.actions.test.tsx'
  'client/src/components/messenger/__tests__/SecureConversationPanel.device.test.tsx'
  'client/src/components/messenger/__tests__/authenticatedChatPresentation.test.ts'
  'client/src/components/messenger/__tests__/messagingCapabilities.test.tsx'
  'client/src/components/messenger/authenticatedChatPresentation.ts'
  'client/src/hooks/__tests__/useConversationBuzz.test.tsx'
  'client/src/hooks/useConversationBuzz.ts'
  'client/src/messaging/__tests__/authenticatedPins.test.ts'
  'client/src/messaging/authenticatedPins.ts'
  'client/src/messaging/messagingCapabilities.ts'
  'client/src/realtime/AuthenticatedSocketIoClient.ts'
  'client/src/realtime/SecureRealtimeWorkspace.ts'
  'client/src/realtime/__tests__/AuthenticatedSocketIoClient.test.ts'
  'client/src/realtime/__tests__/SecureRealtimeWorkspace.test.ts'
  'client/src/realtime/authenticatedProtocol.ts'
  'client/src/security/e2ee/__tests__/storage.test.ts'
  'client/src/security/e2ee/session.ts'
  'docs/authenticated-buzz.md'
  'server/src/data/bridge.ts'
  'server/src/realtime/buzz.ts'
  'server/src/realtime/config.ts'
  'server/src/realtime/protocol.ts'
  'server/src/realtime/server.ts'
  'server/test/data/buzz.test.ts'
  'server/test/integration/client-compatibility.test.ts'
  'server/test/integration/encrypted-edits-client.test.ts'
  'shared/buzz.ts'
)
git add -- $files
git diff --cached --check
git diff --cached --stat
git diff --cached
# Only after reviewing the exact staged diff:
git commit -m 'fix(messaging): finalize A2 verification, Delete and authenticated Buzz'
```

### 2. feat(calls): verify local authenticated LiveKit audio and video

7 explicit paths:

```powershell
$files = @(
  'client/scripts/verify-authenticated-calls.cjs'
  'client/src/messaging/__tests__/callingCapability.test.ts'
  'client/src/voice/livekitConnection.ts'
  'compose.calls.yaml'
  'docker/init-livekit.cjs'
  'docker/init-livekit.test.cjs'
  'docs/authenticated-direct-calls.md'
)
git add -- $files
git diff --cached --check
git diff --cached --stat
git diff --cached
# Only after reviewing the exact staged diff:
git commit -m 'feat(calls): verify local authenticated LiveKit audio and video'
```

### 3. test(security): retain A1 probes and document pending protocol decisions

12 explicit paths:

```powershell
$files = @(
  'docs/a1-acceptance-test-foundation.md'
  'docs/a1-format2-implementation-readiness.md'
  'docs/a1-rollback-protection-design.md'
  'docs/a1-security-decision-review.md'
  'docs/database-security-integration-review.md'
  'docs/security-findings-a1-a2.md'
  'server/test/integration/a1-acceptance-foundation.test.ts'
  'server/test/manual/a1-browser-platform.check.cjs'
  'server/test/manual/a1-original-identity.check.ts'
  'server/test/manual/revision-watermark-review.check.ts'
  'server/test/support/a1-catalog.ts'
  'server/test/support/a1-client-fixture.ts'
)
git add -- $files
git diff --cached --check
git diff --cached --stat
git diff --cached
# Only after reviewing the exact staged diff:
git commit -m 'test(security): retain A1 probes and document pending protocol decisions'
```

### 4. docs(dev): record Docker workflow and final MVP readiness

3 explicit paths:

```powershell
$files = @(
  'docs/docker-daily-development.md'
  'docs/final-mvp-regression-and-git-readiness.md'
  'docs/legacy-to-docker-migration-plan.md'
)
git add -- $files
git diff --cached --check
git diff --cached --stat
git diff --cached
# Only after reviewing the exact staged diff:
git commit -m 'docs(dev): record Docker workflow and final MVP readiness'
```

After reviewing all local commits, **only when separately authorized**:

```powershell
git status --short
git log -4 --oneline
git fetch origin
git rev-list --left-right --count origin/bon-fullstack...HEAD
git rev-list --left-right --count origin/main...HEAD
# If either target advanced, review before proceeding; do not merge/rebase/reset automatically.
git push --dry-run origin bon-fullstack
# After explicit review/authorization, use a normal non-force push:
git push origin bon-fullstack
```

Recommend a **draft PR from bon-fullstack to main**, linking this report,
`docs/security-findings-a1-a2.md`, the A1 decision review and the local calling
limitations. Keep the four intentionally red A1 expectations visible in the PR
body; a green normal suite does not resolve them.

## Readiness and blockers

- Functional regression passed for team review/demo under the stated local scope.
- **Security clearance / security-ready merge or release is blocked by A1 High/P1.**
  The logical-identity/watermark migration policy and eight security/product
  approvals remain pending. No risk acceptance is implied. The 37 TODO contracts
  require future implementation/adversarial verification, not deadline workarounds.
- Local calls are verified using synthetic capture and the real SFU; physical
  hardware, remote networking, HTTPS/WSS, ICE/TURN and media E2EE remain outside
  this local MVP verification. Do not expose this loopback configuration as a
  production deployment.
- Existing restrictions remain: unsupported media forwarding disabled, device-local
  hiding limited to its browser profile, no offline Buzz queue, and no historical
  key recovery across origins without a supported enrollment/recovery contract.
- No production runtime, authentication, E2EE protocol, historical SQLite migration
  or existing user data was changed by this final regression review.
