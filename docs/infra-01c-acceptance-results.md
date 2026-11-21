# INFRA-01C acceptance results

November 20, 2026. Branch `feat/infra-01-docker-dev`, base `d7cd40a`.
Checkout: isolated Git worktree at the repository root.

## A. Executive summary

**PASS after INFRA-01C.2.** The authorized test-only synchronization fix in
section P preserves the original dark-surface assertion. It passed twenty
additional complete light/dark cycles and a fresh 58-check Linux realtime
browser suite, with no failures. The original project and all thirteen existing
Docker volumes remain preserved. Earlier conditional results and diagnostic
failures remain historical evidence in sections A–O; section P is the current
verdict. Windows timing sensitivity and the documented backend replacement
lifecycle rule remain known limitations. No production behavior changed.

The original INFRA-01C baseline follows. All 22 Compose functional/lifecycle/persistence/restore
checks and all seven Windows reload/rebuild checks passed. Linux client unit
tests are green after one focused retry; server, DATA, type checks, lint and
production build passed. Existing platform-dependent regression failures remain
listed below, without application or assertion changes.

**The original `infra-01-docker-dev` project is restored:** both services are
healthy and its frontend responds HTTP 200 on `127.0.0.1:3001`. Disposable
projects are stopped; every source, restored and pre-existing volume is retained.

## B. Docker lifecycle results

Project: `secubuzz-infra01c-mwpetkm9`. Each stage compared record counts/hashes,
checked the canonical ledger/integrity, and recovered the same browser profiles.

| Stage | Result | Elapsed |
| --- | --- | ---: |
| Functional browser setup | PASS | 41.64s |
| Backend restart and live reconnection | PASS | 49.44s |
| Compose restart | PASS | 33.34s |
| Down/up without volume deletion | PASS | 48.14s |
| Container recreation | PASS | 43.45s |
| Image rebuild | PASS | 48.93s |
| Backend replacement plus frontend recovery | PASS with explicit recreation | 87.77s |
| Cold backup and restore | PASS | 51.76s |
| Same-profile account switching | PASS | 10.34s |

Initial occupied-port startup correctly refused to bind without interfering with
its owner. The original project was stopped only after explicit owner approval.
Application builds used root contexts and locked Linux dependencies, excluding
host node_modules. Normal application startup remains Docker-only.

Docker initially suffered a read-only metadata filesystem and engine outage.
After external engine recovery, retained application containers needed recreation
to restore publication. The retained validation image contained zero-byte
passwd, runner and client-manifest files; its empty exit-0 executions were
**not counted as tests**. Only that damaged image was rebuilt under a new tag,
with file-integrity guards. The implementation and data were not reset.

## C. Functional browser results

The Compose app passed actual signup UI registration, explicit login, session
restoration, logout/login, friendship request/acceptance through the browser API,
DM creation through the UI, bidirectional live encrypted messages, history,
refresh, explicit device enrollment, and account-scoped browser storage.

Two synthetic accounts, one conversation, four messages and two enrolled devices
were retained. Private keys stayed non-extractable in dedicated Chrome profiles;
no private keys were exported. Same-profile switching did not reuse another
account's device identity. Returning to Alice restored her existing device and
decrypted history without re-enrollment.

## D. Socket.IO and security

Authenticated polling and WebSocket connections passed through the unchanged
Next.js proxy. Backend restart reauthenticated/reconnected and resumed delivery.
The Compose checks observed no synthetic plaintext in HTTP or WebSocket sends.

Unapproved Origin and missing-CSRF mutations remained HTTP 403. The existing
explicit local-HTTP HttpOnly/SameSite cookie policy was verified. No trust-proxy,
authentication, authorization, encryption, Origin or CSRF checks were relaxed.

## E. Database persistence

Accounts, conversations, messages and device identities survived every lifecycle
stage above, with matching record hashes and no duplicate wire IDs. Migrations
0001-0007 matched their canonical names/checksums; no 0008/0009 files were added.

The database and WAL/SHM sidecars remained together under
`/var/lib/secubuzz/sqlite`. Directory mode 0700, UID-1000 access, SQLite integrity
and zero foreign-key violations were verified. Browser private-key persistence
was checked independently from database persistence.

## F. Backend replacement and namespace recovery

**Limitation:** backend-only replacement leaves an existing frontend attached to
the old container ID. `depends_on.restart` restarts a container but does not
change its namespace attachment. Explicit frontend recreation restored the
namespace, retained records/keys, and resumed live messaging.

Use the verified two-service replacement operation:

```powershell
docker compose up -d --no-build --force-recreate --wait
```

If the backend was already replaced:

```powershell
docker compose up -d --no-deps --no-build --force-recreate --wait frontend
```

This operational limitation is documented; automatic backend-only reattachment
is not claimed.

## G. Backup and restoration

All writers were stopped before archiving the complete SQLite and reserved
private-storage directories. Archives were restored with ownership/modes into
fresh volumes belonging to
`secubuzz-infra01c-mwpetkm9-restore-8a34e0`.

Restored startup, integrity, foreign keys, migration ledger, record hashes,
permissions and browser history decryption all passed. The source and restored
datasets each retain the four synthetic messages. The reserved attachment volume
stays private; no DB-6 feature was activated. No actual host development database
or original-project database was backed up, imported or inspected.

## H. Windows developer experience

Seven checks passed in **127.06s**:

- CSS source edits hot-reloaded without browser navigation.
- Restoring the original CSS was detected.
- Compose Watch synced a temporary backend comment and restarted the unified service.
- Restoring that backend source was also synced/restarted.
- A semantically unchanged lockfile edit invalidated the Linux npm-ci build layer.
- Rebuilding after lock restoration retained records.
- All temporary source and lockfile bytes were restored exactly.

Watch uses `sync+restart`; configuration/lockfile changes require rebuilding.
Linux dependencies stay inside images, separate from Windows dependencies.
Both disposable containers terminated with exit 0 and no OOM. The existing
non-Docker workflow and its source/configuration remain unchanged.

## I. Regression results

All commands use the existing scripts. Counts are passed/failed/skipped.
Linux used Node 24.20.0, Chromium 156 and an isolated image with no external
network or user-data mounts.

| Linux command | Result/counts | Elapsed |
| --- | --- | ---: |
| `cd client; npm test -- --runInBand --json --outputFile=/evidence/client-jest.json` | 1071/4/0, 102 suites | 192.28s |
| Focused retry of the one failed realtime unit file | 9/0/0 | 20.94s |
| Latest result per client file | **1075/0/0**, 102 suites | Combined, not a new full run |
| `cd client; npm run type-check` | PASS | 16.72s |
| `cd client; npm run lint` | PASS | 10.60s |
| `cd client; npm run build:verify` | PASS | 116.03s |
| `cd server; npm run type-check` | PASS | 17.62s |
| `cd server; npm test` | 547/0/0 | 129.10s |
| `cd DATA; npm test` | 321/0/0 | 67.54s |
| `cd client; npm run test:e2ee:browser` | 40/0/0 | 184.64s |
| `cd client; npm run test:realtime:browser` | **46/1/0** executed; 11 later checks not reached | 75.03s |

The failed Linux realtime check is
`dark security disclosure uses a readable dark surface`. It occurs after
successful authenticated messaging, receipts, reconnect, history, key changes
and revocation checks. It remains a recorded failure; no assertion or timing was
changed to hide it. Browser/timing differences are possible, not established.

Previously completed Windows evidence was retained without repeating successful
suites:

| Windows command/run | Result/counts | Elapsed |
| --- | --- | ---: |
| Full client unit run | 1057/18/0 | 362.04s |
| Six-file focused retry | 17/7/0 | 121.58s |
| Four-file final serial retry | 12/2/0 | 53.40s |
| Latest result per client file | **1073/2/0**, 102 suites | Combined |
| Client type-check / lint / build:verify | PASS / PASS / PASS | 44.23s / 35.69s / 107.36s |
| Server type-check / tests | PASS / 547/0/0 | 8.39s / 203.88s |
| DATA tests | 321/0/0 | 94.41s |
| E2EE / realtime browser scripts | 40/0/0 / 58/0/0 | 220.91s / 125.86s |

The two persistent Windows failures in
`client/src/components/ai/__tests__/messengerAI.test.tsx` cannot find
`Review for draft`: prepared rewrite confirmation and invalidation after draft
changes. Those same tests passed in Linux. They are platform-dependent test/
behavior failures on unchanged source, not established Docker integration
regressions. Source-owner triage remains necessary.

Initial sandbox `spawn EPERM` failures were resolved by retrying affected
commands outside the sandbox. Only failed files were retried; assertions and
default timeouts were preserved. The Linux retry cleared the four initial
realtime-unit failures. Exact commands, JSON results and logs are retained in
`docker/artifacts/infra01c/`.

## J. Docker-specific changes

Added `validation.Dockerfile`, `validate.cjs`, `database-check.cjs`,
`acceptance.cjs`, `reload-check.cjs` and `retry-client.cjs` under `docker/`.
They provide guarded disposable testing, counts/timing, read-only snapshots,
lifecycle/restore checks, temporary reload probes and focused retries.

Updated artifact ignore rules, narrowly allowed four committed non-secret
environment examples needed by boundary tests, added validation-image integrity
guards, and documented namespace recovery/verified backup behavior. Normal
Compose topology, application source, manifests, lockfiles, migration SQL,
cryptography and feature gates were not changed.

The verified recovered image is
`secubuzz-infra01c-mwpetkm9-validation-recovered:latest`,
digest `sha256:42832084884e0e4bee4301cf62e79f1baeeee0cb614748bafc433820bd71fe1a`.
The damaged old image was retained and must not be treated as a valid runner.

## K. Preservation and final state

- All **23 protected original-workspace hashes** match.
- Original `chuong-data` status and its single stash are unchanged.
- Application source and all three lockfiles are unchanged; temporary probes
  and generated TypeScript build info were restored.
- Original Compose services are healthy; original frontend HTTP 200 on 3001.
- Source and restored disposable projects are stopped, with all four volumes
  retained. Browser profiles, archives and sanitized evidence remain ignored.
- Only the original SecuBuzz project currently publishes port 3001. No extra
  SecuBuzz host ports, frontend database mounts or feature activations were added.
- Nothing was staged, committed, pushed, merged or published.

## L. Conditions recorded at INFRA-01C completion (superseded by section O)

1. Use explicit frontend/two-service recreation after backend replacement.
2. Review the two Windows AI-unit failures and the Linux dark-surface failure.
   Their behavior is environment-dependent; no app/test fix was authorized or made.
3. The 11 Linux realtime checks after its failure were not reached; the complete
   Windows run and separate Compose checks provide complementary evidence, not
   a claim that the Linux script passed.
4. Engine recovery succeeded, but the earlier damaged-image incident is retained
   in the checkpoint. No Docker reset, prune or volume deletion was performed.
5. Existing dependency deprecations and Next's inherited-tsconfig notice remain
   nonfatal. The validation-image build warns about image ARGs without defaults;
   both image names were supplied explicitly.

## M. Run and validation commands

Normal development remains:

```powershell
# Run from the selected checkout root.
docker compose up --build -d
```

Do not rerun completed tests against the retained populated datasets. For an
independent reproduction, obtain a free port 3001 without stopping unrelated
services, then choose a new project and evidence directory:

```powershell
$project = 'secubuzz-infra01c-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$env:SECUBUZZ_DOCKER_VALIDATION = 'true'
$env:SECUBUZZ_DOCKER_EVIDENCE_DIR = Join-Path (Get-Location) ('docker/artifacts/' + $project)
docker compose -p $project up --build -d --wait --wait-timeout 180
node docker/acceptance.cjs $project
node docker/reload-check.cjs
```

The additional Windows browser tools need Node 24, locked client test dependencies
and Chrome; normal application startup does not require host Node. The acceptance
tool leaves its restored project running for the reload checks; stop that owned
project afterward and restart any originally stopped project with its volumes.

Linux groups were executed with:

```powershell
$evidence = (Resolve-Path docker/artifacts/infra01c).Path
docker run --rm --init --network none --shm-size=1g --mount "type=bind,source=$evidence,target=/evidence" -e SECUBUZZ_DOCKER_VALIDATION=true secubuzz-infra01c-mwpetkm9-validation-recovered:latest node docker/validate.cjs client
```

Use final arguments `server`, `data` or `browser` for the other groups.
The focused Linux retry was `Get-Content -Raw docker/retry-client.cjs |`
the same network-isolated image with `-i` and `node --input-type=commonjs`.
Recorded commands and receipts are authoritative; no successful suite needs
another run absent a new change or concern.

## N. INFRA-01D readiness at INFRA-01C completion

Ready for **owner review with conditions**, not unconditional regression approval.
Accept or resolve the documented lifecycle rule and platform-dependent failures
before advancing. INFRA-01D was not started.

Final verdict: **CONDITIONAL PASS**.

## O. INFRA-01C.1 focused remediation and acceptance checkpoint

November 20, 2026. Baseline: this report, plus the unchanged
`docker/artifacts/infra01c/checkpoint.json` and its receipts. Follow-up evidence
is separate under ignored `docker/artifacts/infra01c1/`. Branch and worktree
remain `feat/infra-01-docker-dev` and the worktree identified above. Successful
client/server/DATA full suites, builds, E2EE browser suite, backup/restore and
reload/rebuild suites were not repeated. The realtime fixture had to be created
anew to reach its final eleven checks; it used only new synthetic accounts.

### O.1 Exact Windows AI results and root-cause analysis

Both historical failures are in
`client/src/components/ai/__tests__/messengerAI.test.tsx`:

| Exact test name | Historical failing assertion | Normal unchanged follow-up |
| --- | --- | --- |
| `a prepared rewrite replaces a draft only after review and confirmation, never sends it` | Line 87: `await screen.findByRole('button', { name: 'Review for draft' })` cannot find the button | PASS, 2251 ms |
| `draft changes invalidate a pending replacement instead of overwriting newer text` | Line 106: the same first `findByRole` cannot find the button | PASS, 1456 ms |

These failures happen before the tests' later review/confirmation and
newer-draft protection assertions. They are not failures of the send prohibition
or draft-replacement safeguards. The final normal run executed only those two
tests with the original Jest setup, application code, assertions and timeouts:
**2 passed, 0 failed, 4 excluded by the name filter**, Jest exit 0, 5.643 s.
Receipt: `ai-windows-unmodified.json` and `.log`.

Observed mechanism: the demo provider resolves a zero-delay timer asynchronously,
after `executeAIRequest`'s promise microtask. The global role query traverses the
large mounted Messenger DOM. Testing Library's default async deadline is 1000 ms.
Under slower execution, synchronous querying, pending timer delivery and React
rendering can exhaust that deadline before the review button is committed.
The UI can still say `Preparing your demo example…` even when the provider has
just returned its correct prepared result.

Observational runs (the original provider still executes; no response or
assertion is replaced) found the exact expected input, `securebot-demo`
selection, `kind: example`, expected friendly rewrite and an un-aborted signal.
The two-test observation run passed 2/0 in 10.259 s; the six-test file passed 6/0
in 15.373 s, ruling out a persistent within-file ordering failure in this run.
The unchanged code also passed on Linux in the baseline.

Controlled **diagnostic**, non-acceptance runs used Node `--jitless` to slow only
the test process, without changing host settings or UI deadlines:

- Provider observation: 1 passed, 1 failed, 4 filtered out, 10.810 s. The draft
  invalidation test reproduced the exact line-106 failure; its valid provider
  response was logged while the UI still showed preparation.
- Timer observation: 0 passed, 2 failed, 4 filtered out, 6.511 s. The prepared
  rewrite test reproduced the exact line-87 failure. Its 1000 ms query deadline
  was scheduled at 1801 ms and fired at 2954 ms; provider invocation/zero-delay
  timer scheduling was delayed until 2430 ms, and that timer had not fired when
  the test ended at 2993 ms. The second test in this deliberately slow run failed
  earlier at `mount()`'s composer-enabled wait, not at the historical line 106.
  That additional setup timeout is recorded separately, not conflated with the
  original failure.

Classification: **pre-existing test path with environment/performance-sensitive
async synchronization**, reproduced outside Docker. The files are unchanged
from the base revision and the tests use a local demo session, not the Compose
backend, database, network namespace or original user data. Docker integration
is not the cause of this reproduced mechanism. The exact CPU/scheduling state
of the earlier INFRA-01C Windows run was not recorded; attribution of that
historical run specifically to host contention remains an inference. No
deterministic AI product defect was established, and no application fix was
justified or made.

Normal Windows latest evidence now combines the baseline's other successful
tests with the two focused passes: **1075 passed, 0 failed, 0 skipped across 102
suites**, an aggregate, not a new full run. The controlled slow-runtime failures
remain visible as flakiness evidence and are not represented as passing runs.

### O.2 Linux visual failure: transition timing, not screenshot differences

Exact check: `dark security disclosure uses a readable dark surface`, in
`client/scripts/verify-client-realtime.cjs`. It immediately reads computed RGB
channels after `emulateMedia({colorScheme:'dark'})` and the HTML `data-theme`
assertion. Its original condition requires three channels with sum **< 500**.
It does not compare screenshots or image baselines.

Linux Chromium 156 reproduced the failure. Direct measurements:

| Sample | HTML theme | Computed background | Channel sum | Original predicate |
| --- | --- | --- | ---: | --- |
| Immediate | dark | `rgb(250, 248, 252)` | 750 | FAIL |
| Approximately 59 ms | dark | `rgb(62, 63, 72)` | 197 | PASS |
| Approximately 133 ms | dark | `rgb(29, 31, 41)` | 101 | PASS |
| Approximately 252 and 519 ms | dark | `rgb(29, 31, 41)` | 101 | PASS |

The immediate sample had running animations at time 0, a resolved surface token
of `#1D1F29`, and computed `background-color`/`border-color` transition durations
of `0.12s`. Animations were absent by the stable dark sample. Existing
`globals.css:159` and `styles/motion.css:3` specify the 120 ms transition;
`SecureConversationPanel.module.css:20` applies the dark surface correctly.
The HTML attribute changing does not wait for the CSS transition to finish.

Root cause: **an existing browser-harness synchronization race exposed by Linux
render scheduling**. The initial light color is an in-progress transition, not
a persistent dark-theme UI regression. RGB parsing works; no font, screenshot
baseline, security rule or rendering-style override was needed. A correct dark
surface and the unchanged numeric predicate were verified after the transition.

`docker/focused-browser.cjs` loads an instrumented copy of the existing fixture
only in the disposable container. It retains the immediate predicate and its
FAIL, samples the transition, and defers only that failure so the eleven later
checks can execute. All other assertions retain their normal failure behavior.
The final evidence is **`passed: false`, 57 passed/1 failed out of 58 checks**;
the original failing check is never counted as a pass. The separate assertion
that the same predicate succeeds after the transition also passed. The checked-in
browser script, application code and assertion thresholds remain unchanged.

### O.3 The eleven previously unreached Linux browser checks

All eleven completed in the same isolated fixture with the existing conditions:

| Exact check name | Result |
| --- | --- |
| `new panel preserves System appearance in light and Midnight dark` | PASS |
| `Bungee and Space Grotesk remain active` | PASS |
| `real block is committed` | PASS: HTTP 204 |
| `authorization revocation removes live scope and clears displayed rows` | PASS |
| `same-browser account switch clears plaintext and isolates device enrollment` | PASS |
| `no plaintext in any captured network request` | PASS: 0 leaks |
| `no browser runtime exceptions` | PASS: 0 exceptions |
| `browser websocket handshakes have exactly csrfToken` | PASS: 15 handshakes, 0 invalid shapes |
| `every captured live send is envelope v2` | PASS: 8/8 sends |
| `real persistence acknowledgments and committed live events observed` | PASS: 8 acknowledgments, 10 events |
| `REST compatibility exercised` | PASS: exactly 1 REST send |

Fixture elapsed time: 65.754 s. Receipt: `focused-browser.json` and `.log`;
original script SHA-256
`72b81caad014f587b716db4cb641b96054e25870b7fdce4f386483692c695602`.
The recovered validation image digest from section J was reused, with
`--network none --shm-size=1g`. Only the dedicated evidence directory was mounted;
no host source, original database, original volumes or host port was exposed.
The synthetic SQLite fixture and redacted screenshots were retained under
`isolated-browser-fixture/`. The container was removed after completion.

### O.4 Backend replacement verification and safe lifecycle guidance

Dedicated project: `secubuzz-infra01c1-mwq18focus`. A Compose override selected
the already validated application images and `ports: !reset []`. The project
used two new named volumes. All five focused checks passed in 40.274 s:

1. No published host ports.
2. Initial frontend namespace matches the backend ID; loopback health succeeds.
3. Backend-only forced recreation changes the backend ID, but leaves the same
   frontend container attached to the old ID; backend health from that frontend
   exits 1 as expected.
4. Explicit frontend recreation changes its namespace to the new backend ID;
   backend loopback health succeeds again.
5. Original project container IDs, start timestamps and healthy states are
   unchanged throughout the check.

Receipt: `backend-replacement.json` and `.log`. Namespace IDs before replacement,
after backend-only replacement and after recovery are retained there. The old
frontend still referred to backend `463749e48644…`; recovery attached a new
frontend to current backend `0971465149e9…`.

**The limitation can be handled safely by a documented Compose lifecycle
operation.** `depends_on.restart: true` propagates a restart, but cannot rewrite
an existing container's `HostConfig.NetworkMode`. For a planned replacement,
recreate both services together (already validated in INFRA-01C):

```powershell
docker compose up -d --no-build --force-recreate --wait
```

If only the backend has already been replaced, the C.1-verified recovery is:

```powershell
docker compose up -d --no-deps --no-build --force-recreate --wait frontend
docker compose exec -T frontend node /workspace/docker/healthcheck.cjs backend
```

Use the intended environment's original project name and all original Compose
files (`-p`/`-f` where applicable); allow a brief development outage. Neither
command removes named volumes. Do not use volume deletion as recovery. The
frontend `/login` health check alone does not establish backend proxy reachability.
No changes to authentication, encryption, DB logic, migrations or the shared
namespace architecture are required. Baseline encrypted-message/persistence
proof remains authoritative; it was not repeated against populated C volumes.

### O.5 Docker-only changes, preservation, remaining risks and verdict

Added only Docker-scoped observation/continuation helpers
(`ai-diagnostics.cjs`, `focused-browser.cjs`, `backend-replacement-check.cjs`)
and lifecycle/report documentation. No Compose architecture or application
behavior change was needed. Inspection receipts summarize runtime metadata;
environment dumps are not retained. No application files, test files, security
controls, DB-5/DB-6 specifications, migrations or lockfiles were modified.

Final preservation verification and machine-readable summary are in
`infra01c1/final-preservation.json` and `infra01c1/summary.json`. The original
workspace's 23 protected hashes, dirty Git status and stash are unchanged. All
11 pre-existing Docker volumes and the two new volumes are retained. The original
project remains healthy, responds HTTP 200 on `/login`, and owns port 3001;
its containers were never stopped or
recreated in this follow-up. Both C.1 Compose containers are stopped, with both
new volumes retained. All earlier original, C source, C restore and other
pre-existing volumes and synthetic data are retained.

Remaining risks/owner decisions:

- The original Linux browser script still has its immediate-color race. Proposed
  source change for owner approval: wait/poll for the **same** background-color
  predicate after the theme switch, then retain the existing check unchanged.
  Do not change CSS or disable motion just to make the assertion pass.
- Windows AI tests pass normally but remain performance-sensitive. If the owner
  requires test-source remediation, synchronize the provider completion/render
  boundary before the existing review lookup, preserving all review, no-send
  and newer-draft assertions. No global timeout increase or assertion removal
  was implemented. Historical host contention is inferred rather than proven.
- Backend-only replacement is not self-healing. The documented paired recreation
  or frontend recovery must be followed. Existing image-integrity cautions from
  the prior engine incident also remain; the damaged image was not used.

**Final verdict: CONDITIONAL PASS.** The eleven missing Linux checks and safe
lifecycle recovery are verified; the Linux immediate assertion still fails as
recorded, and Windows timing sensitivity is reproducible under deliberately
slower execution. No application-source remediation was authorized or implemented.
Owner approval is required before applying the proposed source changes. Nothing
was committed, pushed, merged or submitted as a PR. INFRA-01D was not started.
Stop here for owner review.

## P. INFRA-01C.2 final test synchronization and acceptance

November 20, 2026. Branch/worktree unchanged. Owner authorization covers only
the Linux visual test synchronization; no Windows AI test fix was authorized
or implemented. Historical evidence under `infra01c/` and `infra01c1/` was
preserved. New receipts are under ignored `docker/artifacts/infra01c2/`.

### P.1 Exact changed files and synchronization

Only these two deliverable files changed in this follow-up:

| File | Change |
| --- | --- |
| `client/scripts/verify-client-realtime.cjs` | Six synchronization lines added immediately before the existing dark-surface check, starting at line 184 |
| `docs/infra-01c-acceptance-results.md` | Current executive verdict and this final verification section; earlier results retained |

After the existing `data-theme="dark"` wait, a Playwright `expect.poll` with an
explicit **5000 ms timeout** waits until the disclosure's own animations have
finished and its computed background meets the existing three-channel/sum-<500
condition. It then runs the original assertion. This waits for actual completed
UI state; it adds no fixed sleep and does not disable motion or alter transition
durations.

The original `check('dark security disclosure uses a readable dark surface', …)`
statement is textually unchanged, including its RGB parsing, three-channel
requirement and strict sum **< 500**. Removing only the six added synchronization
lines reproduces the entire original script from HEAD after line-ending
normalization. `scope-check.json` and `sync-only-diff.patch` record this check.
No assertion was weakened, removed, skipped or replaced; failure still throws.

Only the test script was mounted read-only over the existing recovered Linux
validation image. Both runs used separate disposable containers with
`--network none --shm-size=1g`, fresh synthetic accounts/databases, and the
dedicated evidence-directory mount. Neither original Compose service was
stopped or recreated. The image digest remains the verified digest in section J.

### P.2 Repeated runs and surrounding-suite results

| Linux run | Passed / failed | Exact scope | Recorded elapsed |
| --- | --- | --- | ---: |
| Repeated visual verification fixture | **78 / 0** | All 58 existing checks, plus 20 additional executions of the unchanged synchronized dark-surface block | 74.828 s fixture time |
| Fresh original surrounding suite: `cd client && npm run test:realtime:browser` | **58 / 0**, exit 0 | Exact updated script, without repetition instrumentation | 69.921 s command/receipt time; 62.794 s browser fixture time |

The repetition receipt harness copies the exact synchronized block from the
updated test. Before each additional execution it returns the UI to a completed
light state using another bounded Playwright state wait, then triggers dark mode
again. This exercises twenty new transitions rather than repeatedly checking an
already-dark element. It retains every surrounding assertion and the original
throw-on-failure behavior.

**All 20 additional cycles passed.** Every recorded final color was
`rgb(29, 31, 41)` (sum 101), with **zero active animations**. Measured dark-switch,
wait and assertion durations ranged from **207 to 555 ms**. There is no added
sleep duration. The first visual assertion in that fixture also passed, as did
the assertion in the fresh surrounding suite: **22 unchanged visual-assertion
executions passed across two independent Linux fixtures**.

Across the two runs there were **136 passing check executions, zero failures,
zero skipped checks**; these are repeated executions, not 136 distinct tests.
Both runs also recorded 0 plaintext leaks, 0 browser runtime exceptions,
15 valid CSRF-only WebSocket handshakes, 8/8 v2 live sends, 8 persistence
acknowledgments, 10 live events and exactly 1 REST compatibility send.
No new failures were observed in the relevant surrounding suite.

Receipts:

- `repeat-visual.json` / `.log`: 78 checks, 20 per-cycle samples and timestamps.
- `suite-browser.json`, `suite-results.json`, `suite.log`: the fresh 58-check run.
- `repeat-fixture/` and `suite-fixture/`: retained synthetic databases, browser
  fixture artifacts and redacted screenshots, exported before container removal.
- `repeat-visual.cjs` / `run-suite.cjs`: ignored verification receipt harnesses;
  no existing Docker helper was changed.

Both receipts verified the mounted test SHA-256:
`7504ccac57f42b3e7ee25ac6f324bcd34815b8c9ad583608816d64fae0ba236e`.
Script syntax and `git diff --check` passed. Unrelated successful full unit,
server, DATA, E2EE, build, backup/restore and reload suites were not rerun.

### P.3 Preservation, remaining limitations and final verdict

Final checks are recorded in `infra01c2/final-preservation.json` and
`infra01c2/summary.json`:

- All **23 protected original-workspace hashes** match. The original worktree's
  Git status and stash are unchanged.
- All pre-existing worktree changes are preserved byte-for-byte except this
  explicitly authorized report update. The only new tracked-file difference
  from the follow-up baseline is the six-line test synchronization addition.
- All **13 pre-existing Docker volumes** remain; no volumes were created,
  deleted or replaced. Earlier C/C.1 synthetic datasets and receipts remain.
- Original backend/frontend container IDs and start timestamps are unchanged,
  both services are healthy, and `/login` responds HTTP 200 on port 3001.
  Restoration was unnecessary because the original project remained running.
- Both C.2 disposable containers exited successfully and were removed after
  exporting their synthetic evidence. No C.2 containers remain running.
- Application/production source, transition durations, UI behavior,
  authentication, encryption, database/realtime logic, DB-5/DB-6 specifications,
  migrations and lockfiles were not changed. Nothing was staged or committed.

The earlier Windows AI timing sensitivity under deliberately slow execution is
still documented in O.1; its normal unchanged tests passed in C.1. No Windows
test remediation was made in this Linux-only authorization. Backend-only
replacement still requires the verified Compose lifecycle procedure in O.4.
These remain known limitations, not new failures in C.2.

**Final verdict: PASS for INFRA-01C.2 and the current Linux realtime acceptance.**
The remaining Linux visual condition is resolved with deterministic test-only
synchronization, and the original assertion passes unchanged. Owner review is
still required before further work. No commit, push or INFRA-01D work occurred.
Stop here for owner review.

## Q. INFRA-01D publication note

The owner accepted INFRA-01C as PASS, including the C.2 synchronization fix.
Published checkout paths are portable; raw machine-specific receipts, browser
profiles, archives and checkpoints remain ignored and are not included in Git.
The one-off AI, namespace, visual-continuation and failed-file retry tools named
in historical sections were local investigation tools, not shipped runners.
The durable Docker acceptance, smoke, reload and validation runners remain
available. Historical image tags and commands identify prior runs; use the
fresh-image validation instructions in `docker-development.md` for a new clone.
See [INFRA-01D final review](infra-01d-final-review.md) for final verification.
