# DB-5 / DB-6 canonical integration handoff

WARNING (one-way migration): a database migrated to 0008 or higher cannot start under code without that migration, because the migration runner rejects extra ledger rows and stops with `MIGRATION_HISTORY_MISMATCH`. Starting a version that contains 0008 (and 0009 once DB-6B ships) against an existing database applies the migration at once, when the database opens and before the server listens. In the Docker_Environment the first start of an image that contains 0008 migrates the volume `sqlite-data` at once and permanently. Turning a feature switch off does not undo a migration. The only way back is to restore the cold backup taken before the first start, with every process stopped.

Precondition before the first start of code that contains a new migration against data to keep. For a Docker_Environment project, take the cold backup by the procedure of `docs/docker-development.md`, sections "Cold backup commands (PowerShell)" and "Restore into new volumes first (PowerShell)". This handoff cites those sections and does not copy them. In short: stop every process that writes to either volume, archive both complete volume roots (`sqlite-data` and `private-storage`), restore only into fresh volumes, and validate the restore with `docker/database-check.cjs`, run with the image of the revision that took the backup. For a database file on a host, take a cold copy of `database.sqlite`, `database.sqlite-wal` and `database.sqlite-shm` with every connection to the database closed. A copy of a live database file alone is not a backup, and a backup taken after the migration does not restore the earlier version. Rehearse a migration only on synthetic fixtures or on an isolated copy of the cold backup restored into fresh volumes of a Disposable_Project. No backup helper or script exists for this work (DK-06).

Spec: `.kiro/specs/db5-db6-canonical-integration` (requirements, design, tasks). This document is the single handoff of the phases DB-5B to DB-7. T-5B-06 created it as a skeleton. Each later task fills or extends its own section, and each Phase gate records its runs here (DB5-R15.13).

## Merged code

- Integration base: origin/main `dc6c997952130b02f8b685f9546e9e3c259f1160` (merge of PR #19, the Docker development environment).
- Functional baseline pinned by tests, checksums and git gates: `d7cd40aafcf8f432d17d3f4a85abb26d19fa9bc3`. PR #19 changed no path under `DATA/`, `server/src/`, `shared/`, `client/src/` or `DATA/server/database/migrations/`, so dc6c997 shares the d7cd40a functional state.
- Commits in DB-5B: none. No commit, push or pull request is made without Project_Owner approval; a task ends with a changed working tree.
- Working tree at the DB-5B entry baseline (2026-11-21), before and after the baseline runs: `git rev-parse HEAD` = `dc6c997952130b02f8b685f9546e9e3c259f1160`; `git status --short`:

```
 M client/tsconfig.json
?? .kiro/specs/db5-db6-canonical-integration/
?? client/artifacts/phase8-8-hotfix/
?? client/artifacts/phase8-8/
```

- Files added or changed by DB-5B tasks (working tree, not committed):

| File | Task | Change |
| --- | --- | --- |
| `DATA/docs/db5-db6-handoff.md` | T-5B-06 | new (this document) |

Later DB-5B tasks add their rows. The Phase gate T-5B-37 records the final list with `git rev-parse HEAD` and `git status --short`. DB-5B makes no change under `server/` or `client/`.

## Endpoint list

- DB-5B adds, changes and removes no route. `DATA/server/app.js` stays unchanged in DB-5B.
- While the group router and the attachment router are not mounted, every request to `/api/groups`, `/api/attachments` and `/api/files` answers the 404 NOT_FOUND that any unmatched `/api` path receives, for every HTTP method (ARCH-R01.8).
- `GET /api/conversations` stays direct-only, and the strict direct parser of the client stays unchanged.
- Planned contract documents: `DATA/docs/groups-api.md` and `DATA/docs/groups-openapi.json` (DB-5C: G01 to G17 and G26; DB-5D: G18 to G25); the attachment contract (DB-6A) and its OpenAPI document (DB-6B: A01, A03, A05; DB-6D: A02, A04, A06). This section lists each route with an example once its phase ships it.

## Authorization rules and error codes

- DB-5B mounts no route, so no route-level authorization rule applies yet.
- DB-5B adds the pure rules of `DATA/server/groups/policy.js` (T-5B-09): the role matrix of DB5-R06.13, the removal and transfer decisions, the permitted ranges of DB5-R08.12 and the Invitation revalidation. No HTTP route uses them before DB-5C.
- Error bodies follow the existing DATA form `{code, fields}`. The Group_API status and code pairs are those of DB5-R13.2. Any additional code (for example `RECIPIENT_KEYS_UNAVAILABLE`, `QUOTA_EXCEEDED`) is listed in the contract documents before use.
- DB-5C (role matrix, actor-class tables, uniform 404 rules), DB-5D and DB-6B fill this section.

## Migration instructions and environment variables

- Migrations 0001 to 0007 stay unchanged; their SHA-256 checksums are pinned in the design (Data Models).
- Migration `0008-groups.sql` (T-5B-15) adds `GroupExtensions`, `GroupMembershipIntervals`, `ConversationInvitations`, `GroupReadPositions`, `GroupCreationKeys` and the backfill of one `GroupExtensions` row with the History_Policy `from_joined` for every existing group conversation. It does not exist yet when this skeleton is written. `DATA/docs/schema.md` and `DATA/docs/migrations.md` record it when it is added (DB5-R14.15).
- How the migration runs: `openDatabase` runs the migration runner when the application opens the database, before the server listens. A failing file rolls back the whole pending batch and the process exits with code 1; the database stays at the earlier version. The one-way warning and the cold-backup precondition are the first two paragraphs of this document.
- Environment variables: DB-5B adds none. The DATA database path stays `DB_PATH`. The group switches and settings arrive in DB-5C and the attachment ones in DB-6B, all off in `.env.example`. No committed environment file, `compose.yaml`, `docker/compose.env.example.yaml` or Docker override file turns a switch on or sets a group or attachment setting (G8).
- The proposed update of `docs/docker-development.md` (OP-18) is carried in the section "Docker development environment" below.

## Test commands and results

### DB-5B entry baseline (T-5B-01, T-5B-02)

Measured on 2026-11-21 on the unchanged tree: `git rev-parse HEAD` = `dc6c997952130b02f8b685f9546e9e3c259f1160`, and `git status --short` listed the four entries shown under "Merged code", identical before and after every run. No test, file or setting was changed. No retry and no re-run of any group.

Validation_Runner (gate of record). Project `secubuzz-validation-47185663`, image `secubuzz-validation-47185663-runner:latest`, built once from the working tree with the commands of `docs/docker-development.md` ("Build fresh Linux validation images"); the image integrity guard step passed. Each group ran with `docker run --rm --init --network none --shm-size=1g`, its own evidence directory mounted at `/evidence` and `SECUBUZZ_DOCKER_VALIDATION=true`. Counts come from `<group>-results.json` (C1 cancelled and todo from `data-tests.log`; C4 also from `client-jest.json`).

| Cmd | Runner group | Command in the runner | Tests | Passed | Failed | Skipped | Other | Exit | Elapsed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | `data` | `npm test` in DATA | 321 | 321 | 0 | 0 | cancelled 0, todo 0 | 0 | 77.08 s |
| C2 | `server` | `npm run type-check` in server | n/a | PASS | n/a | n/a | | 0 | 9.30 s |
| C3 | `server` | `npm test` in server | 547 | 547 | 0 | 0 | cancelled 0, todo 0 | 0 | 113.48 s |
| C4 | `client` | `npm test -- --runInBand` in client (the runner adds `--json --outputFile=/evidence/client-jest.json`) | 1075 | 1075 | 0 | 0 | 102 suites, todo 0 | 0 | 157.68 s |
| C5 | `client` | `npm run type-check` in client | n/a | PASS | n/a | n/a | | 0 | 17.82 s |
| lint | `client` | `npm run lint` in client | n/a | PASS | n/a | n/a | no warnings or errors | 0 | 13.35 s |
| build:verify | `client` | `npm run build:verify` in client | n/a | PASS | n/a | n/a | | 0 | 75.94 s |
| E2EE browser | `browser` | `npm run test:e2ee:browser` in client | 40 | 40 | 0 | 0 | | 0 | 159.22 s |
| realtime browser | `browser` | `npm run test:realtime:browser` in client | 58 | 58 | 0 | 0 | | 0 | 110.55 s |

Evidence directories (under the Git-ignored `docker/artifacts/`):

- `docker/artifacts/secubuzz-validation-47185663-data` (`data-results.json`, `data-tests.log`)
- `docker/artifacts/secubuzz-validation-47185663-server` (`server-results.json`, `server-types.log`, `server-tests.log`)
- `docker/artifacts/secubuzz-validation-47185663-client` (`client-results.json`, `client-jest.json`, `client-unit.log`, `client-types.log`, `client-lint.log`, `client-build.log`)
- `docker/artifacts/secubuzz-validation-47185663-browser` (`browser-results.json`, `e2ee-browser.json`, `e2ee-browser.log`, `realtime-browser.json`, `realtime-browser.log`)

Docker isolation of the baseline runs: no application container was started, no port was published and no volume was created or opened. `docker volume ls` and the container list were identical before and after the runs, and the other Compose projects on the machine were not touched.

Windows host (additional evidence). Platform Windows (win32), Windows PowerShell 5.1, Node v24.20.0, npm 12.2.1. Each run set `NODE_ENV=test` and `DB_PATH` to a non-existent file in a new empty folder under the system temporary directory, in the process environment only, so no test could fall back to `DATA/.env`; every guard folder was still empty afterwards. `DATA/server/database/database.sqlite` and its sidecars were not opened. Host logs were kept under the system temporary directory, outside the repository.

| Cmd | Platform | Command | Tests | Passed | Failed | Skipped | Other | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Windows | `npm test` in DATA/ | 321 | 321 | 0 | 0 | cancelled 0, todo 0 | 0 |
| C2 | Windows | `npm run type-check` in server/ | n/a | PASS | n/a | n/a | | 0 |
| C3 | Windows | `npm test` in server/ | 547 | 547 | 0 | 0 | cancelled 0, todo 0 | 0 |
| C4 literal | Windows | `npm test -- --runInBand` in client/ | 7808 | 7498 | 310 | 0 | 1157 suites; every failure is under `client/tmp/` | not captured |
| C4 scoped | Windows | `npm test -- --runInBand --testPathIgnorePatterns /node_modules/ /.next/ /client/tmp/` in client/ | 1075 | 1075 | 0 | 0 | 102 suites, todo 0 | 0 |
| C5 literal config | Windows | `npm run type-check -- --tsBuildInfoFile <file under %TEMP%>` in client/ | n/a | FAIL | 697 errors | n/a | all caused by `client/tmp/` | 2 |
| C5 scoped | Windows | `tsc --noEmit` with a temporary config outside the repository that extends `client/tsconfig.json` and excludes `client/tmp/` | n/a | PASS | 0 errors | n/a | 254 `client/src` files, 0 `client/tmp` files | 0 |

Notes on the Windows client runs:

- The literal Windows client commands also collect stale copies of the repository under the Git-ignored, untracked `client/tmp/` folder, because Jest's `testMatch` and the tsconfig `include` both reach into it. The literal C4 run gave 7498 passed and 310 failed (0 skipped), all failures under `client/tmp/`. Jest did not exit after the run and the process was ended by the tool timeout, so its exit code was not captured. The literal C5 configuration gave 697 type errors: 695 in `client/tmp/` copies and 2 in `client/src/auth/__tests__/nextConfig.integration.test.ts`, caused by the duplicate `client/tmp/` copies of that file in the same program. The scoped runs that exclude `client/tmp/` are therefore the comparable Windows evidence. The Validation_Runner is not affected, because `.dockerignore` drops `tmp`.
- The literal `npm run type-check` in client/ would rewrite the tracked `client/tsconfig.tsbuildinfo` (incremental build). The Windows run therefore pointed `--tsBuildInfoFile` to a file under `%TEMP%`, and the tracked file stayed unchanged.
- Lint, build:verify and the browser scripts were not run on Windows.
- In the scoped C4 run both Known_Baseline_Failure tests passed this time (see the section "Known_Baseline_Failure").

The 8 client attachment test files (76 tests) passed on Linux (runner) and on Windows (scoped run) with the same per-file counts:

| File | Tests |
| --- | --- |
| `client/src/components/YahooChatWindow.attachments.test.tsx` | 3 |
| `client/src/components/messenger/__tests__/MessageAttachmentView.test.tsx` | 6 |
| `client/src/components/messenger/__tests__/MessageComposer.attachments.test.tsx` | 22 |
| `client/src/hooks/__tests__/useAttachmentSource.test.tsx` | 9 |
| `client/src/messaging/__tests__/attachmentContent.test.ts` | 5 |
| `client/src/messaging/__tests__/attachmentFiles.test.ts` | 3 |
| `client/src/messaging/__tests__/attachmentUpload.test.ts` | 23 |
| `client/src/messaging/__tests__/localAttachmentStore.test.ts` | 5 |
| Total | 76 |

Comparison with INFRA-01C (design fact F27, measured at d7cd40a; `docs/infra-01c-acceptance-results.md`, section I):

| Suite | INFRA-01C | Validation_Runner (Linux) | Windows host | Result |
| --- | --- | --- | --- | --- |
| DATA (C1) | 321/0/0 | 321/0/0, cancelled 0, todo 0 | 321/0/0, cancelled 0, todo 0 | no difference |
| server type-check (C2) | PASS | PASS | PASS | no difference |
| server tests (C3) | 547/0/0 | 547/0/0 | 547/0/0 | no difference |
| client unit (C4) | Linux 1075/0/0 in 102 suites (combined: first run 1071/4/0, a focused retry of one realtime unit file passed 9/0/0); Windows 1073/2/0 | 1075/0/0 in 102 suites, first run, no retry | scoped 1075/0/0 in 102 suites; literal 7498/310/0 (all failures in `client/tmp/`) | no regression; the two Known_Baseline_Failure tests passed on Windows this time |
| client type-check (C5) | PASS | PASS | scoped PASS; literal configuration FAIL (697 errors from `client/tmp/`) | no regression |
| client lint | PASS | PASS | not run | no difference |
| client build:verify | PASS | PASS | not run | no difference |
| E2EE browser | 40/0/0 | 40/0/0 | not run | no difference |
| realtime browser | 58/0/0 (after INFRA-01C.2) | 58/0/0 | not run | no difference |

### Gate-runner procedure

Recorded by T-5B-39 from the Notes of tasks.md ("Verify commands", "Passing results", "Phase gates") and the design, Testing Strategy section 11 ("Gate runner of record"). Every Phase gate from DB-5B to DB-7 follows it. The run in the Validation_Runner is the gate of record (DB5-R15.10, DK-01). The same commands on the Windows host are additional evidence and never replace it.

#### Build once, then run each group

1. Before the run: Docker is running, Compose Watch is off while a migration file is a draft, and the gate run starts no application container.
2. Build the Validation_Runner once per gate run from the working tree, under a new project name (PowerShell, repository root; the commands of `docs/docker-development.md`, "Build fresh Linux validation images"). The image holds the uncommitted and draft files of the working tree. An image built with a draft migration is never started against volumes that hold data to keep.

```powershell
$project = 'secubuzz-validation-' + [guid]::NewGuid().ToString('N').Substring(0,8)
docker compose -p $project build backend frontend
if ($LASTEXITCODE -ne 0) { throw 'Application image build failed.' }
docker build -f docker/validation.Dockerfile --build-arg "FRONTEND_IMAGE=${project}-frontend:latest" --build-arg "BACKEND_IMAGE=${project}-backend:latest" -t "${project}-runner:latest" .
if ($LASTEXITCODE -ne 0) { throw 'Validation image build failed.' }
```

3. Run each group that the phase needs with that one image, each with its own new evidence directory under the Git-ignored `docker/artifacts/` (`.gitignore` line 105, `/docker/artifacts/`). The runner runs with `--network none`, publishes no port and mounts only its evidence directory, so it is not a Disposable_Project.

```powershell
$evidence = Join-Path (Get-Location) "docker/artifacts/$project-data"     # one directory per group run; ignored by Git
New-Item -ItemType Directory -Path $evidence | Out-Null
docker run --rm --init --network none --shm-size=1g --mount "type=bind,source=$evidence,target=/evidence" -e SECUBUZZ_DOCKER_VALIDATION=true "${project}-runner:latest" node docker/validate.cjs data
```

Repeat these three commands with `server` and with `client` in place of `data` (directories `$project-server` and `$project-client`), and with `browser` only when the phase asks for it as additional evidence. A repeated run of the same group gets a new directory (for example `$project-data-2`).

| Cmd | Runner group | Steps in the runner | Files in the evidence directory |
| --- | --- | --- | --- |
| C1 | `data` | `npm test` in DATA | `data-results.json`, `data-tests.log` |
| C2, C3 | `server` | `npm run type-check`, then `npm test` in server | `server-results.json`, `server-types.log`, `server-tests.log` |
| C4, C5 | `client` | `npm test -- --runInBand` (the runner adds `--json --outputFile=/evidence/client-jest.json`), `npm run type-check`, `npm run lint`, `npm run build:verify` in client | `client-results.json`, `client-jest.json`, `client-unit.log`, `client-types.log`, `client-lint.log`, `client-build.log` |
| additional | `browser` | `npm run test:e2ee:browser`, `npm run test:realtime:browser` in client | `browser-results.json`, `e2ee-browser.json`, `e2ee-browser.log`, `realtime-browser.json`, `realtime-browser.log` |

4. G1 to G9 run on the host at the repository root in PowerShell, because the runner image holds no `.git`, `compose.yaml` or `.dockerignore`.

#### What each run records

Each gate run is recorded under "Phase gate runs" (DB5-R15.13) with:

- the command line and the runner group, the project and image name, and the evidence directory;
- tests, passed, failed and skipped from `<group>-results.json`; for C1 also cancelled and todo from the summary of `data-tests.log`; for C4 also the suites and the Linux read-out of the two Known_Baseline_Failure tests from `client-jest.json` (section "Known_Baseline_Failure");
- the exit code and elapsed seconds of each step. The runner prints one JSON line per step, for example `{"name":"data-tests","command":"cd DATA && npm test","exitCode":0,"elapsedSeconds":99.19,"tests":334,"passed":334,"failed":0,"skipped":0}`;
- the date, `git rev-parse HEAD` and `git status --short`;
- the Windows host results of the same commands beside the runner results, with the platform named, and the Known_Baseline_Failure entries listed separately.

Passing results in the runner: C1 shows `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0` and `# pass` of at least 321 plus the new tests. C2 and C5 exit 0, and the lint and `build:verify` steps exit 0. C3 shows at least 547 passed plus the new tests, 0 failed and 0 skipped. C4 shows at least 1075 passed on Linux, 0 failed and 0 skipped. C3 and C4 also meet at least the counts of T-5B-01 and T-5B-02. G1, G2, G4, G6 and G9 exit 0; G3, G5a, G7 and G8 print nothing; G5b prints only the seven DC-01 lines. On the Windows host C1 and C3 pass as in the runner, and C4 fails exactly the two Known_Baseline_Failure entries and nothing else (a Windows pass of either entry is recorded and does not change the list).

#### When a run is not evidence

A run does not count for the gate when:

- its results file `<group>-results.json` is missing;
- its `tests` count is 0 or below the baseline (C1 321 plus the new tests, C3 547, C4 1075 on Linux; see the next table);
- the image build guards fail. The guide states that a damaged or empty image is not valid evidence, and an empty runner that exits 0 is not a passing test;
- `validate.cjs` exits non-zero for a reason other than a recorded Known_Baseline_Failure.

A retry does not clear a failure. The first result and the retry result are both recorded, and the Project_Owner decides (section "Known_Baseline_Failure", rule 6).

#### INFRA-01C comparison numbers

INFRA-01C measured these baselines at d7cd40a (design fact F27; `docs/infra-01c-acceptance-results.md`, section I). Every gate compares its runs with them and with the DB-5B entry baseline. The entry comparison is the table "Comparison with INFRA-01C" above: no difference and no regression.

| Suite | INFRA-01C | DB-5B entry, Validation_Runner (Linux) | Floor for a gate run |
| --- | --- | --- | --- |
| DATA (C1) | 321/0/0 | 321/0/0, cancelled 0, todo 0 | 321 plus the new tests; 0 failed, 0 skipped, 0 cancelled, 0 todo |
| server type-check (C2) | PASS | PASS | exit 0 |
| server tests (C3) | 547/0/0 | 547/0/0 | 547 plus the new tests; 0 failed, 0 skipped |
| client unit (C4) | Linux 1075/0/0 in 102 suites, a combined result (first run 1071/4/0, a focused retry of one realtime unit file 9/0/0; CI-39); Windows 1073/2/0 (the two Known_Baseline_Failure entries) | 1075/0/0 in 102 suites, first run, no retry | 1075 on Linux; 0 failed, 0 skipped |
| client type-check (C5), lint, build:verify | PASS | PASS | exit 0 |
| E2EE browser | 40/0/0 | 40/0/0 | 40 checks, when the phase runs the group `browser` |
| realtime browser | 58/0/0 (after the test-only fix INFRA-01C.2; the first Linux run was 46/1/0) | 58/0/0 | 58 checks, when the phase runs the group `browser` |

#### Host-only DATA failures seen in DB-5B (host evidence, not Known_Baseline_Failure)

Observation of DB-5B. On the Windows host, full DATA runs (C1, `npm test` in DATA/) intermittently failed existing tests that start a child backend process. Two errors appeared:

- `Backend startup timed out`. The function `childBackend` in `DATA/tests/support/auth.js` (line 61) kills the child `server.js` process and rejects when the child has not printed `listening on port <n>` within a fixed 10 s (`setTimeout(..., 10000)`).
- `TypeError: fetch failed` with the cause "bad port". The tests start servers with `PORT=0` (`envDefaults`, line 11 of the same file), and the host TCP dynamic port range starts at 1024 (`netsh int ipv4 show dynamicport tcp`: Start Port 1024, Number of Ports 64511, so ports 1024 to 65534). An ephemeral port can therefore be one that Node's fetch refuses as a bad port.

The Linux Validation_Runner did not show either error. The group `data` ran three times on 2026-11-21 from one build (project `secubuzz-validation-0c57fdd2`, image `secubuzz-validation-0c57fdd2-runner:latest`, ID `sha256:32514169e52cd43e227db8990ff6430f7f7a9a117a16517d1f025be9fbb6a149`), on HEAD `dc6c997952130b02f8b685f9546e9e3c259f1160` with the uncommitted T-5B-01 to T-5B-05 files. Source: the T-5B-05 verification note `data-stability-T-5B-05.md`, kept under the system temporary directory (`%TEMP%\db5b-evidence`), outside the repository.

| Run | Evidence directory | Exit | Tests | Passed | Failed | Skipped | Cancelled | Todo | Elapsed (`data-results.json`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `docker/artifacts/secubuzz-validation-0c57fdd2-data-1` | 0 | 334 | 334 | 0 | 0 | 0 | 0 | 99.19 s |
| 2 | `docker/artifacts/secubuzz-validation-0c57fdd2-data-2` | 0 | 334 | 334 | 0 | 0 | 0 | 0 | 93.41 s |
| 3 | `docker/artifacts/secubuzz-validation-0c57fdd2-data-3` | 0 | 334 | 334 | 0 | 0 | 0 | 0 | 98.14 s |

- 334 is the 321 baseline tests plus 13 new tests (10 in `baseline-checksums.test.js`, 3 in `dm-fixtures-replay.test.js`), which passed in all three runs. Each `data-tests.log` has 0 `not ok` lines and no occurrence of "Backend startup timed out", "fetch failed" or "bad port".
- No code, test, helper, timeout or `package.json` was changed for this measurement.
- These host failures are NOT Known_Baseline_Failure entries. The Project_Owner has approved none of them, and the list stays the two client tests of the section "Known_Baseline_Failure". They are recorded here as host evidence only. Adding any of them to the list needs a recorded Project_Owner decision.
- The rules of the list apply to them unchanged: a Windows host run that fails any of these tests is not accepted as additional evidence for the phase, a retry does not clear the failure, and the first result and the retry result are both recorded for the Project_Owner.

#### Windows client commands and `client/tmp/`

The literal Windows client commands (C4 `npm test -- --runInBand` and C5 `npm run type-check` in client/) also collect the stale copies in the Git-ignored, untracked `client/tmp/` folder. This is recorded under "Known gaps" ("Other known gaps", stale `client/tmp/` folder) and in the notes on the Windows client runs above. Until the Project_Owner decides about the folder, the scoped Windows runs that exclude `client/tmp/` are the comparable host evidence, and the literal results are recorded beside them. The Validation_Runner is not affected, because `.dockerignore` drops `tmp`.

#### G7, G8 and G9 (T-5B-39)

Run once on 2026-11-21 at 13:22 (UTC-05:00) at the repository root in Windows PowerShell 5.1, with the commands of the Notes of tasks.md as written. `git rev-parse HEAD` = `dc6c997952130b02f8b685f9546e9e3c259f1160`. The tree was the working tree as it stood at T-5B-39: besides the three preserved entries and the spec folder of the phase start, it already held the DB-5B files listed below.

| Gate | Output | Exit code | Expected | Result |
| --- | --- | --- | --- | --- |
| G7 | nothing (0 lines). Its `git diff` step wrote two Git line-ending warnings to stderr ("LF will be replaced by CRLF the next time Git touches it") for the modified tracked files `DATA/server/database/repositories.js` and `client/tsconfig.json`; these are not new files and not G7 matches | 0 | prints nothing | pass |
| G8 | nothing (0 lines), for `compose.yaml` and `docker/compose.env.example.yaml` | 0 | prints nothing | pass |
| G9 | nothing (no diff of `client/src/components/ai/__tests__/messengerAI.test.tsx` against d7cd40a) | 0 | exit 0 | pass |

G7 checked these new files outside the two preserved `client/artifacts/phase8-8*` folders, which its last exclusion names. None matches the `.dockerignore` pattern:

```
DATA/docs/db5-db6-handoff.md
DATA/docs/standalone-inventory.md
DATA/server/features/config.js
DATA/server/groups/policy.js
DATA/tests/audit-metadata.test.js
DATA/tests/baseline-checksums.test.js
DATA/tests/dm-fixtures-replay.test.js
DATA/tests/fixtures/baseline-d7cd40a.json
DATA/tests/fixtures/direct-baseline-d7cd40a.json
DATA/tests/groups-gate.test.js
DATA/tests/groups-policy.test.js
DATA/tests/support/record-baseline.js
```

`git status --short` at the run:

```
 M DATA/server/database/repositories.js
 M client/tsconfig.json
?? .kiro/specs/db5-db6-canonical-integration/
?? DATA/docs/db5-db6-handoff.md
?? DATA/docs/standalone-inventory.md
?? DATA/server/features/
?? DATA/server/groups/
?? DATA/tests/audit-metadata.test.js
?? DATA/tests/baseline-checksums.test.js
?? DATA/tests/dm-fixtures-replay.test.js
?? DATA/tests/fixtures/
?? DATA/tests/groups-gate.test.js
?? DATA/tests/groups-policy.test.js
?? DATA/tests/support/record-baseline.js
?? client/artifacts/phase8-8-hotfix/
?? client/artifacts/phase8-8/
```

G7 and G8 printed nothing and G9 exited 0, so nothing stops the phase.

### Task 1.36: disposable version-7 upgrade rehearsal (2026-11-21)

**PASS.** Dependencies T-5B-33 and T-5B-35 were complete; T-5B-34 was dropped by DK-06 and is not a prerequisite. This is focused task evidence, not the DB-5B phase gate. The input was synthetic only: `buildVersionSeven` with seed `5136`, built under the system temporary directory, archived with numeric ownership and restored into fresh volumes before startup. No owner backup or existing application resource was used.

Project: `secubuzz-disposable-7ff8793e`. The backend and frontend images were built from the current working tree with migration 0008, using the existing Dockerfiles and pinned Node v24.20.0. An override outside the repository selected unique image tags, removed published ports and used an internal network. The two new volumes were `secubuzz-disposable-7ff8793e_sqlite-data` and `secubuzz-disposable-7ff8793e_private-storage`. Project and unique ownership labels were checked before use and removal. The latter volume held only a synthetic marker. Both restored roots had UID/GID 1000:1000 and mode 0700. No Compose Watch ran; feature switches and repository Docker configuration were unchanged.

The restored database was verified at version 7 before `docker compose -p <project> -f compose.yaml -f <temporary-override> up -d --wait --wait-timeout 180`. Startup applied only `0008-groups.sql`, and both services became healthy. The backend log contained no migration failure. The unchanged `docker/database-check.cjs`, executed with the new backend image, reported integrity `ok`, zero foreign-key violations and ledger versions 1 through 8 matching the migration files. Requests inside the shared network namespace returned HTTP 200 for backend `/healthz` and frontend `/login`; no host port was published.

Every row and value of all 21 pre-existing application tables matched the before-upgrade digests. Their counts were unchanged:

| Table | Before = after |
| --- | ---: |
| AccountCredentials | 6 |
| Attachments | 3 |
| AuditLogs | 7 |
| AuthChallenges | 0 |
| AuthRateLimits | 0 |
| Blocks | 2 |
| Contacts | 2 |
| ConversationKeyEpochs | 4 |
| ConversationKeyWraps | 16 |
| ConversationMembers | 22 |
| Conversations | 7 |
| DeviceKeys | 7 |
| FriendRequests | 6 |
| Friendships | 4 |
| MessageReceipts | 14 |
| Messages | 36 |
| SecurityLogs | 1 |
| Sessions | 2 |
| SocialRevisions | 8 |
| UserProfiles | 8 |
| Users | 8 |

`SchemaMigrations` increased from 7 to 8; the first seven ledger rows remained identical. New counts were `GroupExtensions=3`, `GroupMembershipIntervals=14`, `ConversationInvitations=0`, `GroupReadPositions=0` and `GroupCreationKeys=0`. All 17 backfilled rows were compared field-for-field against an independent timestamp-normalizing oracle, including policy `from_joined`, revision 1, active/former membership boundaries and empty/no-authenticated-message cases.

CI-29: `ConversationMembers.joined_at` contained 19 ISO timestamps and 3 SQLite space-form timestamps; `Messages.created_at` contained 33 ISO and 3 SQLite space-form timestamps. For `synthetic-dan` in `synthetic-group-alpha`, raw text ordering would start visibility at sequence 1, while normalization correctly starts at sequence 5. The actual migration produced 5. Mixed timestamp spelling therefore did not widen this member's interval.

R-21 timing: `up` to both services healthy took **20.0942418 s**. A temporary read-only preload timed the actual startup migration without changing application files: runner **11.459622 ms**, 0008 SQL **2.807993 ms**, and its two final backfill statements **0.588281 ms** (extensions 0.353575 ms; intervals 0.234706 ms). These measurements include instrumentation overhead. This fixture completed within the backend's 40 s start period and 6 subsequent health retries at 10 s intervals, and within the 180 s Compose wait. The small fixture does not establish an upper bound for large databases: backfill on a much larger populated volume could exceed the health window and must be rehearsed on an isolated copy before deployment.

Focused Linux checks in network-disabled disposable containers passed **9/9**, with zero failures, cancellations, skips or todo:

- `DATA/tests/synthetic-v7.test.js`: 4/4, including deterministic seeds 535/4242, v7 counts, actual upgrade and safe fixture paths.
- `DATA/tests/groups-migrations.test.js`, selector `^(upgrade from version 7:|\(a\)|\(c\)|\(d\)|one-way:)`: 5/5, covering backfill, fresh initialization, repeat/restart, failed-migration rollback and older-code rejection. P-27 and the full regression suites were not repeated.

Harness recovery: the first restore helper requested the wrong archive basename and exited before extraction; after ownership verification, only that failed helper was removed and unfinished restoration resumed. The fixture test process passed on its first run; an output-parser mismatch was corrected using its retained result, without rerunning it. These were harness errors, not migration failures.

Cleanup passed: ownership labels, the exact container/volume inventory, exclusive use of both volumes and network endpoints were rechecked. The explicit project `down -v` ran **once**. All task helper containers, both service containers, both volumes, the project network and both uniquely tagged images were removed; scoped queries found **zero** remaining project containers, volumes, networks or images. The temporary override was removed. No prune or removal of shared build cache was performed. Existing application containers, volumes and database files were never accessed. No production code, migrations 0001-0008 or feature gates changed.

Evidence is retained locally under Git-ignored `docker/artifacts/db5b-1-36/`: `manifest.json`, `compose-config.json`, `synthetic-input.json`, `before.json`, `after.json`, `timing.json`, `database-check.json`, `health.json`, focused test logs, startup/backend logs and `cleanup.log`. These runtime artifacts are not deliverable source files. Remaining limitation: real-volume scale is unmeasured. The phase gate remains pending owner authorization; no subsequent task was started.

### Task 1.39: final DB-5B gate attempt (2026-11-21)

**BLOCKED. Task 1.39 / T-5B-37 remains unchecked; DB-5B remains 37/38 complete.** No DB-5C task was started. All required C1-C5 commands were attempted on Linux and Windows; the Windows C4 command exhausted its bounded run without a complete result. No failing check is waived or replaced by a retry.

Owner decisions for this run: the two existing Windows AI timing tests may pass or fail only under their verified known environmental cause; every other failure blocks the gate. The scale rehearsal must contain at least 100,000 synthetic messages and 10,000 membership intervals, record migration/startup/health/resources/integrity, and use the existing timing budgets as references. This Windows decision supersedes the older exact-two-fail wording for this run; the Known_Baseline_Failure list remains exactly two entries.

Common metadata for every row below: 2026-11-21, America/New_York (raw machine receipts use UTC); branch `chuong-data`; HEAD `dc6c997952130b02f8b685f9546e9e3c259f1160`. One build of the current working tree produced both application images and the canonical Validation_Runner, using the existing Dockerfiles. Unique project `secubuzz-disposable-4d3e6b94`, unique ownership labels and no published ports. Each Linux group used that same fresh runner with `SECUBUZZ_DOCKER_VALIDATION=true`, `--network none`, `--shm-size=1g` and only its evidence directory mounted. The gate groups started no application service; only the separately approved large rehearsal started the two isolated services. No Compose Watch ran.

| Check / command | Linux Validation_Runner | Windows host |
| --- | --- | --- |
| C1, DATA: `npm test` | **FAIL**, 575 passed / 576 tests, 1 failed, 0 skipped/cancelled/todo; 147.08 s; exit 1 | PASS, 576/576, 0 failed/skipped/cancelled/todo; 195.251 s; exit 0 |
| C2, server: `npm run type-check` | PASS, 8.21 s; exit 0 | PASS, 8.924 s; exit 0 |
| C3, server: `npm test` | PASS, 547/547, 0 failed/skipped; 105.06 s; exit 0 | PASS, 547/547, 0 failed/skipped/cancelled/todo; 134.844 s; exit 0 |
| C4, client: `npm test -- --runInBand --json --outputFile=<evidence-json>` | **FAIL**, 1073/1075, 2 failed, 0 skipped; 101/102 suites passed; 168.71 s; exit 1 | **INCOMPLETE / BLOCKED**, stopped at 720.388 s using the existing runner's 12-minute command limit; exit 1; no complete Jest JSON or final test totals |
| C5, client: `npm run type-check` | PASS, 13.69 s; exit 0 | **FAIL**, 697 type errors; 134.299 s; exit 2. `--tsBuildInfoFile <temporary-file>` preserved the tracked incremental cache |
| Client `npm run lint` | PASS, 11.97 s; exit 0 | Not required by the Windows C1-C5 criteria; not run |
| Client `npm run build:verify` | PASS, 61.49 s; exit 0 | Not required by the Windows C1-C5 criteria; not run |

Windows commands ran in their original package directories with a temporary synthetic DB_PATH fallback. No Windows source, assertion, timeout or repository configuration was edited. The C4 wrapper terminated only its own child process tree at the bounded command deadline. Partial suite receipts are not final test counts: 73 observed suite passes and 63 observed suite failures, all 63 failures in preserved `client/tmp/` copies; no current-source suite failure was observed, but the current-source collection was not proven complete. No excluded collection was substituted for C4.

Failure details and scope:

- Linux C1: `T-5B-33: schema and migration documentation cover every named SQLite object, migration and operational precondition`, at `DATA/tests/groups-migrations.test.js:1330`, fails with ENOENT opening `/workspace/docs/docker-development.md`. The host file exists and the same test passes on Windows. The canonical image copies DATA/docs but neither the root guide nor root docs; the build context also excludes root docs. This is a missing validation-image input. No Dockerfile, ignore rule or assertion was changed to hide it.
- Linux C4, `client/src/app/friends.test.tsx`: `confirmed blocking disables local chat actions without deleting history, and unblock restores them` exceeded Jest's unchanged 5000 ms test deadline (5739 ms recorded); `incoming badge and accepted profiles use shared state without inventing a new DM` then failed to find the `Pending Requests` tab at line 82 (7622 ms recorded). Timing/cascading async work is a possibility, not a verified root cause or approved exception. No retry or deadline increase cleared these failures. Server/client source diffs remain empty.
- Windows C5: 695 errors originate in `client/tmp/`; the other two are duplicate `Route` / function declarations at lines 1-2 of the current `src/auth/__tests__/nextConfig.integration.test.ts`, in the same program as its copied versions. A supplemental temporary config extending the original client config, preserving its ambient type root and excluding the stale copies, passes in 15.363 s. It emits no files or cache and does **not** replace the failed literal gate. The initial diagnostic config missed the original ambient type root; its failure is retained alongside the corrected diagnostic result.
- Windows C4: the unchanged literal collection reaches the same preserved stale copies and was still running at the 12-minute limit. Its failures are outside the approved exception. The copied workspaces were neither moved nor deleted.

Known Windows AI condition: the existing INFRA-01C report, section on the two AI failures, documents the zero-delay provider timer / React rendering / global role-query delay and the 1000 ms Testing Library deadline, including controlled slow-process observations. G9 confirms the protected test file is unchanged. On Linux both exact tests passed: prepared-rewrite confirmation 3622 ms, draft-change invalidation 2607 ms. On Windows the current `src/components/ai/__tests__/messengerAI.test.tsx` suite reported PASS (18.003 s); individual assertion JSON/durations are unavailable because the overall C4 run timed out. No failure exception was used to pass this gate, and failures of copied suites were not added to the known-failure list.

Host G1-G9 all pass: G1/G2/G4/G6/G9 exit 0; G3/G5a/G7/G8 print nothing; G5b prints exactly the seven DC-01 lines, with the checksum/line guards passing inside C1. The server/client stat is empty (the preserved tsconfig entry is only an existing worktree status), and DATA/server/app.js has no diff. Git emitted only its existing line-ending notices. Migration cases (a)-(i), the one-way rejection, P-27 (100 cases), P-28, published checksums/lint, the unmounted-prefix 404 checks and direct-fixture replay including populated-group P-19 all pass in Linux C1 and in Windows C1. No group, attachment or file router was mounted.

The existing decision-log entries remain in force: OP-06 permits only the seven exact ledger literals; OD-05 gives CHECK `all` / `from_joined`, default `from_joined` and immutable policy after insert, as verified by the unchanged 0008 and its passing tests. Provisional defaults remain OP-01 unsigned cursors, OP-07 the documented iteration constants and OP-09 UNAVAILABLE / 503; CI-12's two additive base-repository edits and error-class mapping are unchanged. No Gate_Record applies to DB-5B.

Large-fixture rehearsal: **PASS for the specified synthetic size and this run**. The unchanged T-5B-35 builder with seed 5139 supplied version-7 legacy/authenticated direct, key, social, attachment and group rows. The isolated harness added 100 groups, 100 users, 100 members per added group and 1000 authenticated messages per added group: 100,000 added messages and 10,000 added memberships. Both complete synthetic volume roots were cold-archived and restored into fresh owned volumes before startup. The restored ledger was verified at 7. `docker compose -p secubuzz-disposable-4d3e6b94 -f compose.yaml -f <outside-repository-override> up -d --wait --wait-timeout 180` then applied only 0008.

| Scale result | Measurement |
| --- | --- |
| Messages retained | 100,036 before = after |
| Membership rows retained | 10,022 before = after |
| New extensions / intervals | 103 / 10,014; other three new tables empty |
| Backfilled rows independently verified | 10,117, every field and normalized boundary; 1904 closed intervals |
| Existing data / ledger | All 21 application-table counts and digests unchanged; first seven ledger rows unchanged; ledger 7 to 8 |
| Integrity / foreign keys | ok / 0 violations, including the unchanged docker/database-check.cjs with ledger matching migration files |
| Migration runner / SQL / backfill | 7.435217 s / 7.329855 s / 7.325732 s |
| Up to both services healthy | 31.147 s; no migration failure in backend logs |
| Engine capacity | 8 vCPUs, 16,627,912,704 bytes memory (15.49 GiB), overlayfs |
| Migration process CPU / peak RSS | 7.370847 s user, 0.058362 s system; 125276 KiB peak RSS |
| Sampled container memory / CPU peaks | Backend 118.6 MiB / 102.82%; frontend 664.3 MiB / 233.11%; 10 samples each |
| Logical database bytes | 79,351,808 at v7; 81,420,288 at v8 |

CI-29 timestamp counts: joined_at has 9019 ISO and 1003 SQLite-space values; message created_at has 100033 ISO and 3 SQLite-space values. The independent oracle normalizes both spellings and verifies every interval. R-21 evaluation uses the unchanged 40 s backend start period, six 10 s health retries (about 100 s total) and 180 s Compose wait: measured backfill, migration and observed full-project health time are below these references. No timing/resource acceptance threshold was invented or relaxed. Timing uses an external read-only preload around the real startup runner and its two backfill statements; process CPU/RSS and container samples are recorded, with polling/instrumentation overhead. Windows C4 was concurrently running on the host. This is one measured distribution, not a worst-case bound for a single much larger group or arbitrary future volumes.

Cleanup: ownership tokens, exact project inventories, volume driver/options, exclusive volume users, network endpoints and image tags/users were verified before removal. The explicit-project `down -v` ran once. 10 task containers (helpers included), two volumes, one network and three uniquely tagged images were removed; scoped queries found zero project containers, volumes, networks or images. The temporary override was removed. No prune ran. Existing application containers, volumes and database files were never inspected, mounted, stopped or migrated; no restoration of an existing project was necessary.

Existing work and all eight migration hashes, feature gates, transaction guards, frozen fixtures, lockfiles, Docker files and the original client cache were preserved. Only this handoff receives result evidence; Task 1.39 stays unchecked. Final Git status (common to the runs; unchanged inventory after the result note):

```
 M DATA/docs/migrations.md
 M DATA/docs/repositories.md
 M DATA/docs/schema.md
 M DATA/server/database/repositories.js
 M DATA/tests/auth-migrations.test.js
 M DATA/tests/conversations-migrations.test.js
 M DATA/tests/e2ee-migrations.test.js
 M DATA/tests/messaging-migrations.test.js
 M DATA/tests/migrations.test.js
 M DATA/tests/social-migrations.test.js
 M client/tsconfig.json
?? .kiro/specs/db5-db6-canonical-integration/
?? DATA/docs/db5-db6-handoff.md
?? DATA/docs/standalone-inventory.md
?? DATA/server/database/groupRepository.js
?? DATA/server/database/migrations/0008-groups.sql
?? DATA/server/features/
?? DATA/server/groups/
?? DATA/tests/audit-metadata.test.js
?? DATA/tests/baseline-checksums.test.js
?? DATA/tests/dm-fixtures-replay.test.js
?? DATA/tests/fixtures/
?? DATA/tests/groups-gate.test.js
?? DATA/tests/groups-hardening.test.js
?? DATA/tests/groups-history.test.js
?? DATA/tests/groups-migrations.test.js
?? DATA/tests/groups-pagination.test.js
?? DATA/tests/groups-policy.test.js
?? DATA/tests/groups-repository.test.js
?? DATA/tests/groups-restart.test.js
?? DATA/tests/migration-lint.test.js
?? DATA/tests/support/groups.js
?? DATA/tests/support/migration-lint.js
?? DATA/tests/support/random.js
?? DATA/tests/support/record-baseline.js
?? DATA/tests/support/synthetic-v7.js
?? DATA/tests/synthetic-v7.test.js
?? client/artifacts/phase8-8-hotfix/
?? client/artifacts/phase8-8/
```

Local evidence: Git-ignored `docker/artifacts/db5b-1-39/` holds baseline/status/hash receipts, image build logs/IDs, compose configuration, `gates.json`, each Linux group and Windows command log/result, exact Linux UI failures, Windows partial suite receipts and diagnostic type results, scale before/after digests, resource/timing samples, unchanged database-check output, cleanup proof and `summary.json`. Missing Windows Jest JSON is explicitly an incomplete run, not zero tests or a pass. Runtime logs, harnesses and synthetic archives are not deliverable source files.

Owner review blockers: (1) approve a way to supply the existing root guide to the canonical validation image without weakening its test; (2) investigate the two unapproved Linux friends tests; (3) approve handling of stale client/tmp collection so the literal Windows C4/C5 gate can complete cleanly. No remediation, later task, reset, clean, prune, commit, push or merge was performed.

### Phase gate runs

Pending: each Phase gate (T-5B-37 for DB-5B) records here C1 to C5 in the Validation_Runner and G1 to G9 at the repository root, with command and group, counts, date, `git rev-parse HEAD` and `git status --short`, and the Windows host results beside them.

### Task 1.39: final gate attempt on the current tree (2026-11-21), BLOCKED at Linux C4

Task 1.39 / T-5B-37 remains unchecked. Project `secubuzz-validation-78161b44`: backend, frontend and runner images built with `--no-cache` from the current working tree, HEAD `dc6c997952130b02f8b685f9546e9e3c259f1160`. Each Linux group ran in that fresh runner with `SECUBUZZ_DOCKER_VALIDATION=true`, `--network none`, `--shm-size=1g`, and only the evidence directory `docker/artifacts/secubuzz-validation-78161b44/` mounted. No application container, prune or deletion ran. The COMP-10 exception applies to `.dockerignore` and `docker/validation.Dockerfile` only.

| Check | Command in the runner | Result | Exit |
| --- | --- | --- | --- |
| C1 | `node docker/validate.cjs data` (`cd DATA && npm test`) | 576 passed of 576, 0 failed, 0 skipped; 168.04 s | 0 |
| C2 | `cd server && npm run type-check` | PASS; 14.1 s | 0 |
| C3 | `cd server && npm test` | 547 passed of 547, 0 failed, 0 skipped; 147.04 s | 0 |
| C4 | `cd client && npm test -- --runInBand --json --outputFile=/evidence/client-jest.json` | 1069 passed of 1075, 6 failed, 0 skipped; 102 suites, 4 failed; 316.13 s | 1 |
| C5 | `cd client && npm run type-check` | PASS; 42.01 s | 0 |
| client lint | `cd client && npm run lint` | PASS; 25.02 s | 0 |
| client build:verify | `cd client && npm run build:verify` | PASS; 74.35 s | 0 |

Failed C4 tests (from `client-jest.json`; all failures are in the current tree, no retry was run):

- `src/realtime/__tests__/workspaceRealtime.test.tsx`: "auth login owns one client and logout/user switching discard messages, typing, presence, and stale callbacks", 5000 ms timeout (5223 ms).
- `src/realtime/__tests__/workspaceRealtime.test.tsx`: "existing DM and group views consume explicit demo incoming controls without additional physical connections", `toBeEnabled` failed (14262 ms).
- `src/components/ai/__tests__/messengerAI.test.tsx`: "draft changes invalidate a pending replacement instead of overwriting newer text", role button "Review for draft" not found (2451 ms). This is a Known_Baseline_Failure entry. The Linux pass recorded earlier in this section did not reproduce in this run.
- `src/voice/__tests__/voiceWorkspace.test.tsx`: "the account view connects the existing room UI and account navigation disposes media", 5000 ms timeout (5097 ms).
- `src/app/page.test.tsx`: "messenger application switches conversation headers and keeps messages isolated", 5000 ms timeout (5582 ms).
- `src/app/page.test.tsx`: "messenger application navigation preserves the active chat and its draft when opening Security", textbox "Message to SecureBot" not found (14 ms; the same file failed earlier by timeout).

The two friends cases pass in this run. The C4 suite took 316 s here, against 168.7 s in the earlier attempt, so the timeouts look load-dependent. That is a hypothesis only; no cause is verified and no deadline was changed. Not run because a mandatory check failed: Windows C1 to C5, G1 to G9, and the revalidation of the scale rehearsal on this tree.

### Task 1.39: Linux C4 full-suite run on the current tree (2026-11-21), FAIL

Task 1.39 / T-5B-37 remains unchecked. Fresh runner `secubuzz-validation-f8d5f985-runner`, built with `--no-cache` from the current working tree, with the three file-scoped 20 s Jest timeouts in `workspaceRealtime.test.tsx`, `voiceWorkspace.test.tsx` and `page.test.tsx`. Command: `npm test -- --runInBand --json --outputFile=/evidence/client-jest.json` in `/workspace/client`, with `SECUBUZZ_DOCKER_VALIDATION=true`, `NODE_ENV=test` and `DB_PATH=/tmp/unused-validation.sqlite`. Exit code 1; 173 s wall (169.4 s reported by Jest). Suites: 101 passed, 1 failed, 102 total. Tests: 1073 passed, 2 failed, 1075 total, 0 skipped, 0 pending, 0 todo. Evidence: `docker/artifacts/secubuzz-validation-f8d5f985/` (`client-jest.json`, `client-console.txt`).

Failed tests, both in the protected `src/components/ai/__tests__/messengerAI.test.tsx`, both with "Unable to find role=button, name Review for draft" at the default 1000 ms `findByRole` deadline:

- "a prepared rewrite replaces a draft only after review and confirmation, never sends it" (2924 ms). New failure: it passed in the earlier full run and in the isolated runs.
- "draft changes invalidate a pending replacement instead of overwriting newer text" (3169 ms). Previously observed: the Known_Baseline_Failure entry, which also failed in the earlier full run.

The suspected cascades did not recur in this run: `workspaceRealtime` "existing DM and group views consume explicit demo incoming controls" passed (1837 ms), and `page.test.tsx` "navigation preserves the active chat" passed (1298 ms). The three tests that exceeded 5 s before passed: `workspaceRealtime` "auth login owns one client" (3525 ms), `voiceWorkspace` "the account view connects" (1369 ms) and `page.test.tsx` "switches conversation headers" (2410 ms).

No exception is recorded for either messengerAI test. The Known_Baseline_Failure list is unchanged.

### Task 1.39: Linux C4 with the Testing Library deadline experiment (2026-11-21), PASS

Measured delayed rendering. In isolation, in the fresh runner, the messengerAI "Review for draft" button appeared after 747, 765, 778, 785, 862 and 865 ms across three runs (scratch copy of the test outside the repository, mounted read-only, with the wait raised to 15 s and logged; the protected file was not edited). The same wait exceeded the default 1000 ms deadline under full-suite load (the failures in the earlier run). The full-load wait itself was not measured.

Configuration change (test-only, approved by the Project_Owner): `client/jest.setup.js` gained `import { configure } from '@testing-library/react'` and `configure({ asyncUtilTimeout: 5000 })`, with a comment. No assertion, production code, feature gate or protected file changed; `git diff --quiet d7cd40a -- client/src/components/ai/__tests__/messengerAI.test.tsx` exits 0.

Fresh runner `secubuzz-validation-ddd6e170-runner`, built with `--no-cache` from the current tree. Targeted run: `jest --runInBand src/components/ai/__tests__/messengerAI.test.tsx` in `/workspace/client`, exit 0, 6 of 6 passed, 0 failed, 0 skipped. Full C4 run with the canonical command `npm test -- --runInBand --json --outputFile=/evidence/client-jest.json`, exit 0, 178 s wall: suites 102 of 102 passed, tests 1075 of 1075 passed, 0 failed, 0 skipped, 0 pending, 0 todo. Evidence: `docker/artifacts/secubuzz-validation-ddd6e170/` (`client-jest.json`, `client-console.txt`, `messengerAI-targeted.json`).

Task 1.39 / T-5B-37 remains unchecked: this is the Linux C4 group only. The Windows checks, C1 to C3, C5, G1 to G9 and the full phase gate were not run in this step. The Known_Baseline_Failure list is unchanged.

### Task 1.39: final DB-5B gate on the final tree (2026-11-21), BLOCKED on one acceptance criterion

Task 1.39 / T-5B-37 remains unchecked. HEAD `dc6c997952130b02f8b685f9546e9e3c259f1160`. `git status --short` (48 lines) is saved in `docker/artifacts/secubuzz-validation-e7c51d1a-data/git-status.txt`. The Linux runner `secubuzz-validation-e7c51d1a-runner` (with its backend and frontend images) was built with `--no-cache` from the working tree. Each group had its own evidence directory. No application container, Compose Watch, prune or volume change ran.

Linux Validation_Runner (`node docker/validate.cjs <group>`, `SECUBUZZ_DOCKER_VALIDATION=true`, `--network none`, `--shm-size=1g`):

| Group | Check and command | Result | Exit |
| --- | --- | --- | --- |
| data | C1 `cd DATA && npm test` | 576 of 576 passed; 0 failed, 0 skipped; 108.35 s | 0 |
| server | C2 `cd server && npm run type-check` | PASS; 6.08 s | 0 |
| server | C3 `cd server && npm test` | 547 of 547 passed; 0 failed, 0 skipped; 92.16 s | 0 |
| client | C4 `cd client && npm test -- --runInBand --json --outputFile=/evidence/client-jest.json` | 1075 of 1075 passed; 102 of 102 suites; 0 failed, 0 skipped, 0 pending, 0 todo; 127.81 s | 0 |
| client | C5 `cd client && npm run type-check` | PASS; 8.87 s | 0 |
| client | `npm run lint` | PASS; 7.89 s | 0 |
| client | `npm run build:verify` | PASS; 46.59 s | 0 |

Group exit codes: data 0, server 0, client 0. Evidence: `docker/artifacts/secubuzz-validation-e7c51d1a-data/`, `-server/`, `-client/` (`*-results.json`, `validate-console.txt`, `client-jest.json`).

Windows host (additional evidence, platform named):

- C1 `npm test` in DATA with `NODE_ENV=test` and `DB_PATH` to a missing file in a new folder under the system temporary directory: 576 of 576 passed; 0 failed, 0 cancelled, 0 skipped, 0 todo; 137 s; exit 0.
- C2 `npm run type-check` in server: exit 0.
- C3 `npm test` in server: 547 of 547 passed; 0 failed, 0 skipped; exit 0.
- C4 `npm test -- --runInBand --json --outputFile=<temp>` in client: 1075 of 1075 passed; 102 of 102 suites; 0 failed, 0 skipped; 120 s; exit 0. No Known_Baseline_Failure occurred in this run.
- C5 `npm run type-check -- --tsBuildInfoFile <temp>` in client: exit 0; no `error TS` line. The redirect keeps the tracked build-info file out of the run.

Logs: the system temporary directory, `db5b-final-win\` (`win-C1-data.log`, `win-C2-server-types.log`, `win-C3-server-tests.log`, `win-C4-client-jest.json`, `win-C4-client-console.log`, `win-C5-client-types.log`).

G1 to G9 at the repository root:

- G1 exit 0. G2 exit 0. G3 no output. G4 exit 0. G5a no output.
- G5b prints seven lines, all DC-01 ledger-literal assertions.
- G6 exit 0. G7 no output. G8 no output. G9 exit 0 (the protected `messengerAI.test.tsx` is unchanged from d7cd40a).
- `git diff d7cd40a -- DATA/server/app.js` has no output (app.js unchanged).

Migration and scale: the SHA-256 of `0008-groups.sql` now is `114B86A02899AAD730E450F5A423D54F01098C051D397A9DC0E77B1125AC3C9E`. The same value is in the scale rehearsal manifest (`docker/artifacts/db5b-1-39/manifest.json`), so the rehearsal used the migration of the final tree. Scale result (`scale-before.log`, `scale-after.log`): Messages 100,036 before and after; GroupMembershipIntervals 10,014; GroupExtensions 103; backfill rows verified 10,117; integrity ok; 0 foreign-key violations. Task 1.36 artifacts are present in `docker/artifacts/db5b-1-36/`. The eight application volumes listed before (`secubuzz-infra01b-*`, `secubuzz-infra01c1-*`, `secubuzz-infra01c-*`) are unchanged, and no disposable volume or container remains.

Blocking acceptance criterion. The Task 1.39 criterion states that `git diff --stat dc6c997 -- server client` lists only `client/tsconfig.json`. It currently lists eight files: `client/jest.config.js` (Jest exclusion of `tmp/`, approved), `client/jest.setup.js` (global asyncUtilTimeout, approved), `client/src/app/page.test.tsx`, `client/src/realtime/__tests__/workspaceRealtime.test.tsx` and `client/src/voice/__tests__/voiceWorkspace.test.tsx` (file-scoped 20 s timeouts, approved), `client/src/app/friends.test.tsx` (20 s timeout, approved, plus region-scoped queries from an earlier recovery that the owner's approvals do not list), `client/tsconfig.json` (exclusion of `tmp`, approved) and `client/tsconfig.tsbuildinfo` (build cache modified by an earlier host type-check, not a planned change). The owner must either amend the criterion to list the approved client changes, or revert the unplanned ones. Until then Task 1.39 stays unchecked.

Approved exceptions recorded for this gate:

- COMP-10 narrow exception: `.dockerignore` and `docker/validation.Dockerfile` copy `docs/docker-development.md` into the validation image only (decision log, Docker section, `tasks.md` Task 1.39).
- File-scoped 20 s Jest timeouts: `page.test.tsx`, `workspaceRealtime.test.tsx`, `voiceWorkspace.test.tsx` and `friends.test.tsx`. Assertions unchanged.
- Global Testing Library async deadline, `client/jest.setup.js`: `configure({ asyncUtilTimeout: 5000 })`. Scope: every client Jest suite, for async queries only (`findBy*`, `waitFor`); no test or assertion changed. Justification: in isolation the messengerAI "Review for draft" button appeared after 747 to 865 ms, and the same wait missed the 1000 ms default under full-suite load (the earlier failures). `messengerAI.test.tsx` is protected by G9 and was not modified.
- Excluding `client/tmp/` from Jest (`testPathIgnorePatterns`) and TypeScript (`tsconfig` exclude). The folder itself was not deleted.

### Task 1.39: final acceptance closure and DB-5B completion (2026-11-21 to 2026-11-22, America/New_York)

HEAD `dc6c997952130b02f8b685f9546e9e3c259f1160`. Final runner: `secubuzz-validation-e7c51d1a-runner` (image created 2026-11-22 05:52 UTC, built with `--no-cache` from the working tree).

Owner decisions recorded here:

1. The Task 1.39 client-diff criterion in `tasks.md` now lists the seven approved client files, with no server file. The owner's list named `client/src/app/workspaceRealtime.test.tsx` and `client/src/app/voiceWorkspace.test.tsx`, which do not exist. The files on disk are `client/src/realtime/__tests__/workspaceRealtime.test.tsx` and `client/src/voice/__tests__/voiceWorkspace.test.tsx`, and the criterion uses those paths.
2. The region-scoped queries and the 20 s Jest timeout in `client/src/app/friends.test.tsx` are retained. Assertions are unchanged.
3. `client/tsconfig.tsbuildinfo` was restored to HEAD with `git checkout` on that one path, after its diff was confirmed as generated incremental build state only: `fileNames`, `fileIdsList`, `fileInfos`, `root`, `referencedMap` and `affectedFilesPendingEmit` differ, while `options` and `version` are identical and `fileInfos` has the same eight entries. No other file was touched.
4. The global Testing Library `asyncUtilTimeout` of 5000 ms in `client/jest.setup.js` is retained. Its scope and justification are in the entry above (affects async queries in every client Jest suite only).

Final diff verification. `git diff --stat dc6c997 -- server client` lists exactly seven files, 38 insertions and 19 deletions: `client/jest.config.js`, `client/jest.setup.js`, `client/tsconfig.json`, `client/src/app/friends.test.tsx`, `client/src/app/page.test.tsx`, `client/src/realtime/__tests__/workspaceRealtime.test.tsx`, `client/src/voice/__tests__/voiceWorkspace.test.tsx`. No server file differs. `client/src/components/ai/__tests__/messengerAI.test.tsx` is unchanged against d7cd40a (G9 exit 0). `DATA/server/app.js` is unchanged against d7cd40a.

Evidence validity. No tracked or untracked file was written after the runner image was built (checked by file timestamps), so the Linux C1 to C5 results of `e7c51d1a` remain valid for the resulting tree. The Windows C1 to C5 runs used the same source. The restore of the generated build-info file changes no test or type-check input. G1 to G9 were rerun after the restore, and each result is unchanged from the gate run. The Task 1.36 rehearsal and the scale evidence are valid: the SHA-256 of `0008-groups.sql` (`114B86A02899AAD730E450F5A423D54F01098C051D397A9DC0E77B1125AC3C9E`) equals the value in the rehearsal manifest.

Linux Validation_Runner, final tree (`node docker/validate.cjs <group>`):

| Check | Result | Exit |
| --- | --- | --- |
| C1 `data` (`cd DATA && npm test`) | 576 passed of 576; 0 failed, 0 cancelled, 0 skipped, 0 todo (`data-tests.log`); 108.35 s | 0 |
| C2 `server` type-check | PASS | 0 |
| C3 `server` tests | 547 passed of 547; 0 failed, 0 skipped | 0 |
| C4 `client` Jest (canonical command) | 1075 passed of 1075; 102 of 102 suites; 0 failed, 0 skipped, 0 pending, 0 todo; 127.81 s | 0 |
| C5 `client` type-check | PASS | 0 |
| `client` lint | PASS | 0 |
| `client` build:verify | PASS | 0 |

Known_Baseline_Failure tests, read from `docker/artifacts/secubuzz-validation-e7c51d1a-client/client-jest.json`: "a prepared rewrite replaces a draft only after review and confirmation, never sends it" passed (2744 ms); "draft changes invalidate a pending replacement instead of overwriting newer text" passed (2003 ms). Both are in the Linux run, and the Known_Baseline_Failure list is unchanged.

Windows host (additional evidence, same source tree; logs in the system temporary directory, `db5b-final-win\`):

- C1 `npm test` in DATA, with `NODE_ENV=test` and `DB_PATH` to a missing file in a new folder under the temporary directory: 576 of 576 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo; 137 s; exit 0.
- C2 `npm run type-check` in server: exit 0.
- C3 `npm test` in server: 547 of 547 passed; exit 0.
- C4 `npm test -- --runInBand --json` in client: 1075 of 1075 passed, 102 suites; 120 s; exit 0. The owner's earlier decision for this gate superseded the exact-two-fail wording for Windows C4, and the two Known_Baseline tests passed.
- C5 `npm run type-check -- --tsBuildInfoFile <temp>` in client: exit 0, no TypeScript error. The redirect keeps the tracked build-info file out of the run.

G1 to G9 at the repository root (rerun after the restore):

- G1 exit 0. G2 exit 0. G3 no output. G4 exit 0. G5a no output.
- G5b prints seven lines, all DC-01 ledger-literal assertions.
- G6 exit 0. G7 no output. G8 no output. G9 exit 0.
- `git diff d7cd40a -- DATA/server/app.js` has no output. `compose.yaml` is unchanged.

Git status. The status saved at the gate run is `docker/artifacts/secubuzz-validation-e7c51d1a-data/git-status.txt` (48 lines, including the build-info change that has since been restored). After the restore, 19 tracked files differ from HEAD, and the DB-5B files are untracked: `.dockerignore`, the three DATA docs, `DATA/server/database/repositories.js`, six DATA test files, the seven client files and `docker/validation.Dockerfile` (COMP-10 exception).

Task 1.36 and scale evidence (valid for the final tree): the rehearsal project was `secubuzz-disposable-4d3e6b94` (removed). Its artifacts are in `docker/artifacts/db5b-1-36/` and `docker/artifacts/db5b-1-39/` (`manifest.json`, `summary.json`, `scale-before.log`, `scale-after.log`). Messages 100,036 before and after; GroupMembershipIntervals 10,014; GroupExtensions 103; backfill rows verified 10,117; integrity ok; 0 foreign-key violations. The application volumes `secubuzz-infra01b-*`, `secubuzz-infra01c1-*` and `secubuzz-infra01c-*` are unchanged, and no disposable volume or container remains.

Decision-log and defaults checks: the OP-01, OP-07 and OP-09 defaults, CI-12, and the decision-log entries for T-5B-07, T-5B-08 and T-5B-38 are recorded above and in the sections already in this handoff. Approved exceptions for this gate: COMP-10 (two Docker files, validation image only), the file-scoped 20 s timeouts, the global 5000 ms asyncUtilTimeout, and the Jest and TypeScript exclusions of `client/tmp/` (the folder itself is preserved).

Task 1.39 / T-5B-37 is complete. DB-5B is 38 of 38 tasks complete.

## Known gaps

### Open Owner Decisions (OD) and open points (OP) with their provisional defaults

Decided in the DB-5A reconciliation and therefore not listed as open: OD-04, OD-05 and OP-06, and the decided parts of OD-01 and OD-08. The section "Decision log" records them. Every item below keeps its provisional default until the Project_Owner records a decision.

| ID | Open question | Provisional default | Phase |
| --- | --- | --- | --- |
| OD-01 (open part) | Whether friendship with the inviter is required | No friendship rule beyond blocks; block rules always apply | DB-5C |
| OD-02 | Which roles may invite or add | Owner and admin only | DB-5C |
| OD-03 | Admin permissions; role of the former owner after a transfer | Matrix of DB5-R06.13; the former owner becomes admin | DB-5C (A05 in DB-6B) |
| OD-06 | Rejoin visibility | The gap while removed is never visible; messages of the member's own earlier intervals stay visible; no access beyond what the member already had | DB-5B |
| OD-07 | Content of a departed member | Authored messages and files stay visible; no deletion by the departed member | DB-5B, DB-5D, DB-6B |
| OD-08 (open part) | Maximum pending Invitations per group and per invitee; re-invite delay after a decline | No default; the Group_API cannot be enabled while the two maximum settings are unset; no re-invite delay setting exists | DB-5C |
| OD-09 | Group deletion versus archive; unarchive; retention after archive | Archive only; no deletion route; no unarchive route; no data removed | DB-5C |
| OD-10 | Owner departure | The owner cannot leave; no automatic transfer | DB-5C |
| OD-11 | Two existing co-members block each other | Blocks only prevent adding, inviting and accepting between the pair; existing co-membership unchanged | DB-5C |
| OD-12 | Exposure of read state | Private per-member read position; no other member's position returned | DB-5D |
| OD-13 | Moderation of others' messages and attachments | Sender or uploader only | DB-5D, DB-6B |
| OD-14 | Attachment retention values | No default; the Attachment_API cannot be enabled while unset; ready attachments are not purged automatically | DB-6A, DB-6B |
| OD-15 | Quota and limit values | Size limits equal the client policy; the Attachment_API cannot be enabled while quotas are unset | DB-6B |
| OD-16 | Plaintext attachments, media type allowlist, scanning | Plaintext refused; no scanning; no allowlist | DB-6B, decided at the DB-6C review |
| OD-17 | Scope of server-side file search | Filters only conversation, uploader, size range and time range; file name and content search refused | DB-6D |
| OD-18 | Attachment access after tombstone, removal and archive | Remaining members keep access; removed members lose access; a tombstone does not delete attachments | DB-6B |
| OD-19 | Group key model for protected group messaging | None selected; group messaging stays disabled | DB-5D |
| OD-20 | Migration of Standalone_Implementation data into DATA | No data migrated; the standalone file stays untouched | DB-5B |
| OD-21 | Message-to-attachment association visible to the server | Association by an explicit authenticated request that references a committed message; the DB-6C review decides the final form | DB-6A, DB-6C, DB-6D |
| OP-01 | Keyed integrity tag on the group cursor | Unsigned codec. PROVISIONAL: recommended by Kiro, not approved by the Project_Owner | DB-5B (format), confirmed at the DB-5D review |
| OP-02 | Association limits when some attachments are already associated | Whole-message reading of DB6-R04.11 | DB-6D |
| OP-03 | Upload frame wire format (DC-03) | ADR-09 length-prefixed body frame | DB-6A; client in DB-6E |
| OP-04 | Upload timeout (DC-04) | `ATTACHMENT_UPLOAD_TIMEOUT_SECONDS` unset keeps 15 s; it applies only while the Attachment_API switch is on | DB-6B |
| OP-05 | Blocked direct pair outcome (DC-02) | Direct-path outcomes: 404 for a block, 403 for a pair that are not friends | DB-6A |
| OP-07 | Iteration counts of P-32, P-34, P-35 and P-40 | Counts of the design's Correctness Properties table. PROVISIONAL: recommended by Kiro, not approved by the Project_Owner | DB-5B; revisit at DB-6B |
| OP-08 | Expiry of `AttachmentReservations` rows after a crash | The pending expiry of OD-14 (proposed) | DB-6B |
| OP-09 | 503 for an unavailable database (DB5-R13.12) | One repository error class UNAVAILABLE: cannot open, I/O error, disk full and read-only answer 503 SERVICE_UNAVAILABLE. PROVISIONAL: recommended by Kiro, not approved by the Project_Owner | DB-5B |
| OP-10 | Independent security reviewer and report form | None named; no GROUP-MESSAGING and no ATTACHMENTS-PROTECTED record, so both functions stay off | before DB-5D; again before DB-6C |
| OP-11 | Runtime acknowledgement of a Gate_Record | Implemented; format check `GR-[A-Z0-9-]{3,48}` only | DB-5C |
| OP-12 | Records needed to enable attachments for Real_Accounts | ATTACHMENTS-PROTECTED and DB6-ACCEPTANCE before the Attachment_API switch and `NEXT_PUBLIC_ATTACHMENT_API_READY` are on for Real_Accounts | DB-6F |
| OP-13 | Exception for adapting the 76 client attachment tests | Each changed assertion has a stricter replacement in the inventory; no DB-6E commit before the acknowledgement | DB-6E |
| OP-14 | Group message write rules | Envelope version 2 refused for groups until a key model exists; a differing `membership_revision` answers 409 STALE_STATE | DB-5D |
| OP-15 | Realtime hint event | One additive event that existing clients ignore | DB-5E |
| OP-16 | Closing DB-5G with a missing stage record | No: all four DB-5 stage records are required; the Project_Owner may waive one in writing as a known gap | DB-5G |
| OP-17 | PUT in the mutation bucket of DB5-R12.4 | PUT counts as a mutation | DB-5C |
| OP-18 | Update of `docs/docker-development.md`, section "Data and future migrations" | No edit until approved; this handoff carries the proposed text | DB-5B and DB-5C handoff |
| OP-19 | Per-source rate limit values in the Docker_Environment | Configurable, generous in development; no trust of forwarded headers | DB-5C, DB-6B |
| OP-20 | Requirement amendments OA-01 to OA-04 | None applied; the requirement text is unchanged and the defaults of OP-05, OP-03, OP-13 and OP-12 apply | DB-6A, DB-5F, DB-6E, DB-6F |

### Not verified (from the design)

| Item from the design's "Not verified" list | Status at the DB-5B entry |
| --- | --- |
| The design run ran the DATA suite only in a throwaway copy, and did not run the server suites or the full client suites | Measured by T-5B-01 and T-5B-02 (section "Test commands and results") |
| Not read in full: `server/src/realtime/server.ts`, `authentication.ts`, `receipts.ts`; `DATA/server/auth/{service,adapters,passwords}.js` beyond excerpts; `DATA/server/routes/{auth,social,keys,users,messages,logs}.js`; `DATA/server/e2ee/repository.js`; the 13 tests of `server/test/integration/attachments.test.ts` beyond their titles; client hooks and components beyond the files named | Open |
| The payload of the realtime event `conversation:updated` was not read | Open; DB-5E reads it first (OP-15) |
| Whether the Next.js 14 rewrite proxy streams 50 MiB request bodies without truncation (R-07) | Open; DB-6A |
| `fs.link` as an atomic no-replace rename on every target filesystem (R-10) | Open; DB-6B |
| The real development database (`DATA/server/database/database.sqlite` and its sidecars) was not opened | Stays unopened by rule |
| The INFRA-01C baselines of F27 were not re-run in the reconciliation | Measured by T-5B-01 and T-5B-02; no difference from INFRA-01C |
| No application container started, no image built and no Docker volume opened for the design; no Disposable_Project created, its commands are a design | T-5B-01 built the Validation_Runner images (no application container, no volume). The Disposable_Project commands stay untested until T-5B-36 |
| The 50 MiB body through the development rewrite proxy and its timeout inside the Docker_Environment (R-22, R-07, CI-27) | Open; DB-6A |
| Whether the 0008 backfill on a populated database finishes inside the 40 s `start_period` of the backend health check (R-21) | Open; timed by T-5B-36 |
| The immutability trigger on `history_policy` that 0008 gained from OD-05 has not run through the runner (F18) | Open; T-5B-15 and T-5B-17 |

### Other known gaps

- Stale `client/tmp/` folder (owner decision). The Git-ignored, untracked `client/tmp/` folder holds old copies of the repository from earlier work. The literal Windows client commands collect them (C4 literal 7498/310/0, C5 literal configuration 697 type errors, all from `client/tmp/`). Nothing was deleted. Whether to clean it is the Project_Owner's decision; until then the scoped Windows runs are the comparable evidence.
- REPLACE guards need `foreign_keys = ON`. Migration 0008 (Option A, owner approved) refuses `INSERT OR REPLACE` and `REPLACE INTO` over the keys of GroupExtensions, ConversationInvitations, GroupReadPositions, GroupCreationKeys, GroupMembershipIntervals and the owner and member rows. Each guard replaces the parent Conversations row, and the immediate ON DELETE RESTRICT of its existing child then refuses the statement, so the guards hold only on connections with `foreign_keys = ON`. The application connection (`connection.js`) sets the pragma, and the migration runner refuses to run without it (`FOREIGN_KEYS_DISABLED`). A raw connection with the pragma OFF can still replace a row (measured for the GroupExtensions policy). Migration 0008 is unchanged for this limitation; the Project_Owner approved it as documented (Option A).
- Design correction (not edited). The design's Component classification row "Client uploader and its 76 tests" pairs the 76 attachment-test counts with the wrong files. The measured per-file counts are: `YahooChatWindow.attachments` 3, `MessageAttachmentView` 6, `MessageComposer.attachments` 22, `useAttachmentSource` 9, `attachmentContent` 5, `attachmentFiles` 3, `attachmentUpload` 23, `localAttachmentStore` 5 (total 76). The total and the set of numbers in the design are right; only the pairing is wrong.
- The Known_Baseline_Failure entries: see the section "Known_Baseline_Failure".
- Later phases add here the standalone inventory dispositions, the residual risk of DB6-R05.6 and the unmigrated standalone data (OD-20).

## Runtime statements

- The Standalone_Implementation host, identified by the file `server/api-main.cjs`, the script `npm run start:api` and the variable `API_PORT`, and never by a port number alone, is not a supported runtime. It is not started, proxied to or imported.
- `npm run start:data` starts the only supported server, on a host and in the Docker_Environment. It serves DATA and realtime from one process.
- In the Docker_Environment port 3001 is the browser-facing address of the application (the Next.js frontend, published as `127.0.0.1:3001`) and not of the Standalone_Implementation.
- Approved DB-5 and DB-6 server code lives in `DATA/`. `server/` keeps the realtime and end-to-end encryption protocol code.
- Server-side visibility rules (membership, Membership_Interval ranges, History_Policy) do not replace key-based confidentiality of Protected_Content, which DB-5D reviews separately.

## Gate_Record list

- No Gate_Record exists. No Gate_Record applies to DB-5B.
- Gate_Records live in `DATA/docs/gate-records.md` (created in DB-5C), each with an identifier `GR-<stage>-<date>`, its evidence, the commit and the Project_Owner approval.
- Stages: GROUP-MANAGEMENT (DB-5C), GROUP-MESSAGING (DB-5D), GROUP-REALTIME (DB-5E), GROUP-FRONTEND (DB-5F), DB5-ACCEPTANCE (DB-5G), ATTACHMENTS-PROTECTED (DB-6C) and DB6-ACCEPTANCE (DB-6F). Each record and its evidence is listed here when it exists, and every record is listed before publication (DB-7).

## Decision log

Decisions approved by the Project_Owner in the DB-5A reconciliation. Entries carry no calendar date.

### OP-06: DC-01 exception for seven migration-ledger assertions

Status: decided by the Project_Owner in the DB-5A reconciliation (OP-06). No acknowledgement is pending. Recorded by T-5B-07.

The approval reads: "permit updating exactly the seven migration-ledger test literals when adding migrations, with corresponding guard tests". The requirements record it as: exactly seven migration-ledger literals in baseline tests may change when a migration is added, in the same commit as the migration, with guard tests that fail on any other changed baseline line (requirements, "Decisions recorded in the DB-5A reconciliation"). It is applied in DB5-R15 criterion 11 and ARCH-R02 criterion 1 and resolves the design conflict DC-01: seven baseline tests hard-code the migration ledger and fail as soon as any migration after 0007 exists.

What the decision permits:

- Exactly seven assertions of the baseline tests at d7cd40a may change, and no other baseline line. They change only when a migration is added: `0008-groups.sql` now (T-5B-15, DB-5B) and `0009-attachment-lifecycle.sql` later (DB-6B; file name as given in the design).
- Each change is made in the same commit as the migration that forces it. While nothing is committed, that means the same change set as the new migration file.
- The change is limited to the new migration file name or version number, as listed per line below. The rest of each line stays byte-identical, and the line keeps its line number: no line is added, removed, split or joined.
- The changed assertions stay exact `deepEqual` or `equal` checks against the real output of the migration runner, so no assertion is relaxed.
- T-5B-15 depends on this entry only so that the decision is on record before the first migration file exists.

The seven lines (files under `DATA/tests/`). The insertion or replacement is relative to the baseline text:

| # | File | Line | What the line asserts | With 0008 | With 0009 |
| --- | --- | --- | --- | --- | --- |
| 1 | `auth-migrations.test.js` | 24 | applied list | insert `,'0008-groups.sql'` after `'0007-recipient-keys.sql'` | insert `,'0008-groups.sql','0009-attachment-lifecycle.sql'` after `'0007-recipient-keys.sql'` |
| 2 | `conversations-migrations.test.js` | 21 | applied list | insert `,'0008-groups.sql'` after `'0007-recipient-keys.sql'` | insert `,'0008-groups.sql','0009-attachment-lifecycle.sql'` after `'0007-recipient-keys.sql'` |
| 3 | `e2ee-migrations.test.js` | 12 | applied list | insert `,'0008-groups.sql'` after `'0007-recipient-keys.sql'` | insert `,'0008-groups.sql','0009-attachment-lifecycle.sql'` after `'0007-recipient-keys.sql'` |
| 4 | `e2ee-migrations.test.js` | 29 | highest ledger version, literal `7` | replace `7` by `8` | replace `7` by `9` |
| 5 | `messaging-migrations.test.js` | 11 | applied list | insert `,'0008-groups.sql'` after `'0007-recipient-keys.sql'` | insert `,'0008-groups.sql','0009-attachment-lifecycle.sql'` after `'0007-recipient-keys.sql'` |
| 6 | `migrations.test.js` | 14 | ledger version list | insert `,8` after the last element `7` | insert `,8,9` after the last element `7` |
| 7 | `social-migrations.test.js` | 25 | applied list | insert `,'0008-groups.sql'` after `'0007-recipient-keys.sql'` | insert `,'0008-groups.sql','0009-attachment-lifecycle.sql'` after `'0007-recipient-keys.sql'` |

Baseline text of the seven lines, quoted from `DATA/tests/fixtures/baseline-d7cd40a.json` (T-5B-03, array `dc01`), in the order of the table, each with its four leading spaces:

```
    assert.deepEqual(migrate(db).applied,['0003-authentication.sql','0004-profiles-friends.sql','0005-conversation-provenance.sql','0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql']);
    assert.deepEqual(migrate(db).applied,['0005-conversation-provenance.sql','0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql']);
    assert.deepEqual(migrate(db).applied,['0007-recipient-keys.sql']);assert.equal(db.pragma('foreign_keys',{simple:true}),1);
    const {db}=fixture(t);assert.equal(db.prepare('SELECT max(version) v FROM SchemaMigrations').get().v,7);assert.deepEqual(db.pragma('foreign_key_check'),[]);
    assert.deepEqual(migrate(db).applied,['0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql']);for(const [name,rows]of Object.entries(before)){if(rows.length)assert.deepEqual(db.prepare(`SELECT ${Object.keys(rows[0]).join(',')} FROM ${name}`).all(),rows);else assert.equal(db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n,0);}
    assert.deepEqual(history.map(row => row.version),[1,2,3,4,5,6,7]);
    assert.deepEqual(migrate(db).applied,['0004-profiles-friends.sql','0005-conversation-provenance.sql','0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql']);
```

Exact permitted change per line, which the guard of T-5B-05 enforces:

- Rows 1, 2, 3, 5, 6 and 7 are applied-migration lists. They grow by appending. The only permitted difference is text inserted immediately after the last element of the expected array literal, before its closing `]`: the new migration file names in single quotes, or for row 6 the new version numbers, each preceded by a comma with no space, in ascending order, in the style of the baseline line. In rows 3 and 5 the insertion is in the array that follows `migrate(db).applied,`. The rest of those lines (the `foreign_keys` check on line 12, the row-preservation loop on line 11) stays unchanged.
- Row 4 (`e2ee-migrations.test.js` line 29) is not a list. It asserts the highest ledger version with the literal `7`, the only digit on the line. The only permitted difference is replacing that single version-number literal by the new highest version: `8` with 0008, `9` with 0009. Nothing else on the line changes, including the `foreign_key_check` assertion.
- Undoing the permitted change gives back the baseline text exactly.

Note on wording: the spec text says these assertions change "only by appending" the new migration file names or version numbers (DB5-R15 criterion 11, ARCH-R02 criterion 1, design DC-01, the DC-01 rule in the Notes of tasks.md and T-5B-05). That describes six of the seven lines. Line 29 of `e2ee-migrations.test.js` holds no list, so its version number is updated by replacing the literal `7`. The approval ("updating exactly the seven migration-ledger test literals") covers this update. This entry does not amend the spec text.

Guard:

- `DATA/tests/baseline-checksums.test.js` (T-5B-05) reads the manifest `DATA/tests/fixtures/baseline-d7cd40a.json`. Each of the 29 baseline test files and 6 support files must hash to its manifest value (SHA-256 of the LF-normalised text). On the seven lines the permitted change above is undone first, after which the file must hash to the manifest again. Any other difference, on any other line or of any other kind on the seven lines, fails the test and names the file and line. The test reads no git, runs unchanged in the Validation_Runner and is never skipped.
- G5b (`git diff d7cd40a -U0 -- DATA/tests server/test client/src | Select-String -Pattern '^-(?!-).*(assert|expect)'`) lists only the seven lines, each with its baseline text as quoted above.

### OD-05: History_Policy option set and the 0008 properties it fixes

Status: decided by the Project_Owner in the DB-5A reconciliation (OD-05). Recorded by T-5B-08.

The requirements record the decision as: the History_Policy values are exactly `all` and `from_joined`; the default is `from_joined`; the policy is chosen at group creation and is immutable afterwards (requirements, "Decisions recorded in the DB-5A reconciliation"). It is applied in DB5-R01 criteria 1, 7, 10, 14 and 15, DB5-R02 criteria 10 and 13, the DB5-R06 role matrix, DB5-R07 criterion 2 and DB5-R08 criteria 1 and 2. It answers every part of the OD-05 question: the options and the default are fixed, nobody may change the policy, and therefore no change can apply to earlier messages.

What the decision fixes:

- The values are exactly `all` and `from_joined`, the value set of the Standalone_Implementation (DB5-R08.1). Each group has exactly one History_Policy, stored only in its Group_Extension_Record, the column `GroupExtensions.history_policy` (DB5-R02.1, DB5-R08.1).
- The default is `from_joined` (DB5-R08.2).
- The policy is chosen at group creation. `POST /api/groups` (G01) takes the optional field `historyPolicy`, one of the four fields its body accepts (DB5-R01.7). The stored value is the supplied one or, when the field is omitted, `from_joined` (DB5-R01.14). A supplied value that is not exactly the string `all` or `from_joined` (case-sensitive; `null` counts as supplied) gives 400 `VALIDATION_ERROR` with `historyPolicy` in `fields` and creates no record (DB5-R01.15).
- The policy is immutable after creation, for an archived and an unarchived group alike (DB5-R08.1). The Standalone_Implementation lets its PATCH route change `history_visibility` (`server/src/routes/groups.cjs`); the canonical Group_API does not.

Consequences, derived from OD-05, confirmed at the DB-5C API contract approval:

- `PATCH /api/groups/:id` (G04) never accepts `historyPolicy`. A body that contains the field, with any value including the stored one, gets 400 `VALIDATION_ERROR` with `historyPolicy` in `fields`, and no record changes (DB5-R02.13). This replaces the 503 that applied while OD-05 was open. DB5-R02.10 still lists `historyPolicy` as a known field, so the body is not refused as carrying an unknown field; criterion 13 refuses it by name.
- The refusal order of DB5-R02.15 still applies: the checks of DB5-R12; 404 `NOT_FOUND` for an unknown group, a Direct_Conversation or a non-member (criterion 3) and 403 `FORBIDDEN` for an Active_Member who is not the owner (criterion 11); 409 `CONFLICT` for an archived group (DB5-R07.2); the body checks of criteria 10 and 14; the `historyPolicy` refusal of criterion 13; the stale precondition of criterion 12. A non-owner therefore gets 403, a non-member 404 and the owner of an archived group 409 before the 400 of criterion 13.
- The idempotent create fingerprint includes the History_Policy: `sha256(JSON.stringify(["secubuzz-group-create-v2", trimmedName, description ?? null, historyPolicy]))`, where an omitted `historyPolicy` is replaced by `from_joined` before hashing (DB5-R01.10; design, "Concurrency and consistency design", item 7). A repeat with the same key within 24 hours that differs only in the policy is a different payload and gets 409 `IDEMPOTENCY_CONFLICT` (DB5-R01.11). A repeat that omits the policy matches an earlier request that sent `from_joined`. The label moved from v1 to v2 because the fingerprint input changed, so no fingerprint made under the earlier label equals a v2 fingerprint.
- The role matrix of DB5-R06.13 refuses the row "Change History_Policy" for the owner, the admin and the member, whether the group is archived or not (`roleMatrix` in `DATA/server/groups/policy.js`, T-5B-09). An owner's PATCH that carries `historyPolicy` meets the 400 of DB5-R02.13; an admin or a member meets the 403 of DB5-R02.11 first.

Properties that `0008-groups.sql` must show for `GroupExtensions.history_policy`:

1. `CHECK (history_policy IN ('all','from_joined'))`. An INSERT with any other value fails with a constraint error.
2. The default `from_joined`.
3. Immutability after insert through the trigger `group_extensions_update`. `history_policy` is in the trigger's `UPDATE OF` column list and in its condition, so an UPDATE that changes `history_policy` is aborted by `RAISE(ABORT, ...)` and leaves the row unchanged, for an archived and an unarchived group alike. An UPDATE that assigns the stored value is not a change and passes, but no repository function issues one (`updateSettings` never writes `history_policy`). An UPDATE of `description` on the same row passes.

Reference text: the DDL of the design (Data Models, `0008-groups.sql`) for the table and the trigger. This entry fixes only the three properties above; the rest of this DDL is governed by the design and T-5B-15.

```sql
CREATE TABLE GroupExtensions (
    conversation_id TEXT NOT NULL PRIMARY KEY REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    description TEXT CHECK(description IS NULL OR length(description) <= 1000),
    history_policy TEXT NOT NULL DEFAULT 'from_joined' CHECK(history_policy IN ('all','from_joined')),
    membership_revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(membership_revision) = 'integer' AND membership_revision >= 1),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER group_extensions_update BEFORE UPDATE OF conversation_id, history_policy, membership_revision, created_at ON GroupExtensions BEGIN
    SELECT CASE WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.created_at IS NOT OLD.created_at OR NEW.history_policy IS NOT OLD.history_policy
        OR (NEW.membership_revision IS NOT OLD.membership_revision AND NEW.membership_revision <> OLD.membership_revision + 1)
        THEN RAISE(ABORT,'group_extension_immutable') END;
END;
```

Who creates, tests and confirms the properties:

- T-5B-15 creates them in the DDL of `0008-groups.sql`.
- T-5B-16 adds the 0008 backfill. Every group conversation that exists before 0008, of any origin, gets one `GroupExtensions` row with `history_policy = 'from_joined'`, `membership_revision = 1`, `description = NULL` and `created_at` copied from the conversation (DB5-R14.13). The backfill only inserts, so `group_extensions_update` is not involved and the value stays fixed afterwards. A legacy-origin group gets a row but stays invisible to the Group_API (DB5-R14.18).
- Case (i) of T-5B-17 tests them on a temporary database at the latest version: a direct UPDATE from `from_joined` to `all`, and from `all` to `from_joined`, is aborted by `group_extensions_update` and leaves the row unchanged; an UPDATE of `description` on the same row succeeds; an INSERT with a value outside `all` and `from_joined` fails the CHECK; every backfilled row holds `from_joined`; a value set at insert persists.
- The Phase gate T-5B-37 confirms in this handoff that `0008-groups.sql` matches this entry: CHECK `all` and `from_joined`, default `from_joined`, immutable after insert.

Open until T-5B-15 and T-5B-17 pass: the guard on `history_policy` was added to the design DDL after the prototype run of F18 and has not yet run through the Migration_Runner (design CI-38; listed under known gaps above). The CHECK is one-way: another option set would need a new Project_Owner decision and a later Schema_Migration that rebuilds `GroupExtensions` under DB5-R14.4.

### Other DB-5A reconciliation decisions, pending amendments and open decisions

Recorded by T-5B-38. Sources: the requirements, sections "Unresolved Owner Decisions", "Decisions recorded in the DB-5A reconciliation" and "Amendments awaiting owner approval at their phase"; the design, section "Unresolved Decisions" (the decision table, "Additional open points" and "Decisions recorded in the DB-5A reconciliation"). This entry records the decisions as the spec states them and changes no requirement, design or task text. No entry carries a calendar date.

#### Approval of the reconciled specification set (CI-31)

Status: approved. The Project_Owner approved the DB-5A reconciliation, that is the reconciled specification set (the requirements, the design, the task list and the phase order), for progression to DB-5B. No calendar date is recorded.

- Reference: design, "Open Consistency Items", item CI-31 (the phase order and the dependency edges are PROPOSED; resolution: approve the reconciled specification set; the Project_Owner decides before DB-5B). It was the one hard prerequisite left in the design section "Decisions needed before DB-5B starts" (item 1) and in the DB-5B line of the "Phase start rule" of tasks.md.
- It meets DB-5B entry criterion 1 (tasks.md, task group 1, "Entry criteria").
- The CI-31 row of the design table "Status after the DB-5A reconciliation" still reads OPEN ("Stays OPEN until the Project_Owner approves the reconciled specification set"). This entry records the approval and does not edit that row.

#### Decisions recorded in the DB-5A reconciliation

The Project_Owner approved these decisions after the Docker development environment (PR #19) was merged. Two of them have their own entries above and are listed here by pointer only:

- OP-06 (DC-01 exception for seven migration-ledger assertions): see the entry "OP-06: DC-01 exception for seven migration-ledger assertions" above, recorded by T-5B-07.
- OD-05 (History_Policy option set): see the entry "OD-05: History_Policy option set and the 0008 properties it fixes" above, recorded by T-5B-08.

The other decisions, each with the criteria that apply it:

| ID | Approved decision | Applied in | What follows in this work |
| --- | --- | --- | --- |
| OD-01 (part) | Direct add of members stays disabled and answers 503 FEATURE_UNAVAILABLE. Membership starts only through an accepted Invitation. Still open: whether friendship with the inviter is required; the default is no friendship rule beyond blocks (listed under "Open decisions and open points" below). | DB5-R03 criteria 5 and 6 | `POST /api/groups/:id/members` (G06) answers 503 by decision, not as a placeholder, and changes no record; only a later Project_Owner decision can enable direct add (DB5-R03.5). After the creator, membership comes only from the Invitation lifecycle (G12, G16; DB-5C). `invitationRevalidation` in `DATA/server/groups/policy.js` (T-5B-09) has no friendship check. Test `AF-06`. |
| OD-04 | The maximum number of active members per group is 50, supplied as a configuration value. The Group_API cannot start with its switch enabled while that value is unset (fail-closed). | DB5-R03 criterion 12; DB5-R16 criterion 7 | `GROUP_MAX_MEMBERS` stays a required setting with the approved value 50 and no default in code; while `GROUPS_API_ENABLED=true`, an unset or invalid value stops the start (T-5C-01, DB-5C). An operation that would add an Active_Member beyond the maximum answers 409 CONFLICT. Tests inject `groups.maxMembers: 50` through `features`; a test of the maximum itself injects a smaller value. DB-5B adds no environment variable. |
| OD-08 (part) | The Invitation expiry is 7 days = 604,800 s. The maximum pending Invitations per group, the maximum pending Invitations per invitee and any re-invite delay after a decline stay unresolved with no default; the Group_API cannot start with its switch enabled until the two maximum settings exist. | DB5-R04 criteria 1 and 18; DB5-R16 criterion 7 | The expiry is the fixed constant `INVITATION_EXPIRY_SECONDS` = 604800 of `DATA/server/groups/policy.js` (T-5B-09) and is not an environment setting. `GROUP_INVITATION_TTL_SECONDS` does not exist, is never read and is never named by a start failure (T-5B-14, T-5C-01). `ConversationInvitations.expires_at` is the creation time plus 604,800 s, written once. The open part is listed under "Open decisions and open points" below. |
| DK-01 | The Validation_Runner (Docker Linux image) is the primary regression gate and the gate of record. The two known Windows client failures are recorded separately as Known_Baseline_Failure entries and are never suppressed. | DB5-R15 criteria 10, 14, 15 and 16 | Every phase gate from DB-5B runs C1 to C5 in the Validation_Runner; Windows host runs are additional evidence; a failure outside the two recorded test names fails the gate. This document: sections "Test commands and results", "Known_Baseline_Failure" and "Docker development environment" (gate runner). |
| DK-02 | The local branch chuong-data is fast-forwarded to origin/main dc6c997 (PR #19), preserving local changes and stashes. | Baseline section of the requirements | The integration base is dc6c997. The functional baseline pinned by tests, checksums and git gates stays d7cd40a, because PR #19 changed no DATA, `server/src`, `shared`, `client/src` or migration file. This document: section "Merged code". |
| DK-03 | Migration testing uses isolated Disposable_Project instances: unique project name, own volumes, no published ports, removed afterwards. | DB5-R14 criteria 17, 21 and 24 | The name is `secubuzz-disposable-` plus 8 hexadecimal characters, passed with an explicit `-p`; `down -v` runs only for such a project (T-5B-36). This document: section "Docker development environment" (Disposable_Project procedure and naming). |
| DK-04 | Docker Compose Watch is not used while a Schema_Migration file is a draft. | DB5-R14 criterion 22; Explicit Exclusion 11 | Watch syncs `DATA/server`, migrations included, and restarts the backend, which would apply a pending migration to the persistent volume. `git status --short -- DATA/server/database/migrations` prints nothing before any `docker compose watch`; the DB-5B and DB-6B entry checks include it. This document: section "Docker development environment" (Compose Watch rule). |
| DK-05 | The existing Docker cold-backup procedure of `docs/docker-development.md` is used: stop all writers, archive both complete volume roots, restore only into fresh volumes, validate with `docker/database-check.cjs`. | DB5-R14 criteria 20 and 23 | This document cites the guide and does not copy it (its second paragraph). Rollback is a restore into fresh volumes. |
| DK-06 | The optional database backup helper (task T-5B-34, `DATA/scripts/backup-database.js`, `npm run db:backup`) is dropped; the cold-backup procedure replaces it. The ID T-5B-34 is never reused. | No requirement; DB5-R14 criterion 23 names the existing procedure | No backup helper, script or `package.json` entry is created or planned. tasks.md keeps only the note that T-5B-34 was dropped; no task takes that ID and no range of task IDs includes it. |
| DK-07 | The rehearsal on a copy (T-5B-35 and its DB-6B equivalent) uses synthetic fixtures or an isolated copy of the cold backup restored into fresh volumes of a Disposable_Project, never the live database and never the volumes of the running project. | DB5-R14 criterion 24 | T-5B-35 prepares the input and T-5B-36 runs the rehearsal; migration cases (a) to (i) use temporary databases and need no container. `DATA/server/database/database.sqlite` and the volumes of the running project are never opened, mounted or archived. |
| COMP-10 exception | Owner-approved narrow exception: `.dockerignore` and `docker/validation.Dockerfile` change only to copy `docs/docker-development.md` into the validation image. No production Docker behavior changes. | COMP-10; DB5-R15 criterion 10 | Linux C1 documentation test in the fresh runner image (final gate). This document: section "Docker development environment". |

Group messaging and protected attachments stay disabled until their security designs (DB-5D, DB-6C) and the owner Gate_Records are approved (DB5-R16 criteria 6 and 8; DB6-R05 criterion 8).

#### Amendments awaiting owner approval (OA-01 to OA-04)

These four requirement amendments are not approved. The requirement text is unchanged, and the provisional default in the last column applies until the Project_Owner approves each amendment at its approval phase. The open point OP-20 tracks the four together.

| ID | Source | Criteria concerned | Pending amendment | Approval phase | Provisional default until approved |
| --- | --- | --- | --- | --- | --- |
| OA-01 | CI-02, OP-05 | DB6-R03 criterion 2; DB5-R15 criterion 9 | Blocked direct pair: the baseline direct path answers 404 NOT_FOUND for a block and 403 FORBIDDEN for a pair that are not friends, while the criteria say 403 for a block. | DB-6A | The direct-path outcomes are reused (DC-02); `attachments-security` asserts those literals. |
| OA-02 | CI-03, OP-03 | DB6-R03 criterion 1; DB6-R05 criterion 12 | Upload frame wording: one POST with a byte stream and up to 16384 characters of encrypted metadata cannot carry the metadata in request headers. | DB-6A | The length-prefixed body frame of ADR-09 (DC-03). |
| OA-03 | CI-10, OP-13 | DB5-R15 criterion 11; ARCH-R03 criterion 9 | Exception for adapting the 76 client attachment tests at DB-6E against the rule that no baseline test is weakened, with a stricter replacement for each changed assertion. | DB-6E | The 76 tests stay frozen; no DB-6E commit before the acknowledgement. |
| OA-04 | CI-11, OP-12 | DB5-R16 criteria 8 and 11; DB6-R05 criterion 8 | A marker for "before DB-5F" in DB5-R16 criterion 11, and the decision which Gate_Records enable the Attachment_API (the requirements name only the DB-6C security review record, and no stage covers DB-6D or DB-6E). | DB-5F and DB-6E (marker); DB-6F (records) | `gate-records.test.js` changes its expectation per prefix with the Project_Owner's acknowledgement; ATTACHMENTS-PROTECTED and DB6-ACCEPTANCE are required before the Attachment_API is enabled for Real_Accounts. |

#### Open decisions and open points with their provisional defaults

Every item below is open and keeps its provisional default until the Project_Owner records a decision. The table "Open Owner Decisions (OD) and open points (OP) with their provisional defaults" under "Known gaps" lists the same items with the phase each one affects. Not listed because decided: OD-04, OD-05, OP-06 and the decided parts of OD-01 and OD-08 (see above).

| ID | Open question | Provisional default |
| --- | --- | --- |
| OD-01 (open part) | Whether friendship with the inviter is required | No friendship rule beyond blocks; block rules always apply |
| OD-02 | Which roles may invite or add: owner and admin only, or any member | Owner and admin only |
| OD-03 | Admin permissions (edit metadata, cancel others' Invitations, remove admins, delete others' attachments); role of the former owner after a transfer | Matrix of DB5-R06.13; the former owner becomes admin |
| OD-06 | Rejoin behavior: visibility of the gap while removed and of messages from earlier Membership_Intervals | The gap is never visible; messages of the member's own earlier intervals stay visible; no access beyond what the member already had |
| OD-07 | Visibility to remaining members of content by a departed member; whether a departed member may delete own content | Authored messages and files stay visible; no deletion by the departed member |
| OD-08 (open part) | Maximum pending Invitations per group; maximum pending Invitations per invitee; any re-invite delay after a decline | No default: `GROUP_MAX_PENDING_INVITATIONS_PER_GROUP` and `GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE` are required settings, and the Group_API cannot be enabled while either is unset (DB5-R16.7); no re-invite delay setting exists, so a new Invitation may follow a decline at once |
| OD-09 | Group deletion versus archive-only; unarchive; retention of data after archive | Archive supported; no deletion route; no unarchive route; no data removed |
| OD-10 | Owner departure: automatic transfer, disabled or removed owner account, orphan groups | The owner cannot leave; no automatic transfer |
| OD-11 | Behavior when two existing co-members block each other | Blocks only prevent adding, inviting and accepting between the pair; existing co-membership unchanged |
| OD-12 | Exposure of read state: private per-member position, or receipts visible to other members | Private per-member position; no other member's position returned |
| OD-13 | Moderation: who may tombstone another member's message or delete another member's attachment | Sender or uploader only |
| OD-14 | Attachment retention: pending upload expiry, purge delay after deletion, Retention_Job interval | No default; the Attachment_API cannot be enabled while unset; ready attachments are not purged automatically |
| OD-15 | Quota and limit values, and confirmation of the client size policy as the server limit | Size limits equal the client policy; the Attachment_API cannot be enabled while quotas are unset |
| OD-16 | Whether plaintext attachments are ever permitted; media type allowlist; content scanning | Plaintext refused; no scanning; no allowlist |
| OD-17 | Scope of server-side file search over encrypted metadata, including disclosure of a media type class | Filters only conversation, uploader, size range and time range; file name and content search refused |
| OD-18 | Attachment access after a message tombstone, after the uploader's removal and after group archive | Remaining members keep access; removed members lose access; a tombstone does not delete attachments |
| OD-19 | Group key model for protected group messaging (selection and review) | None selected; group messaging stays disabled |
| OD-20 | Whether any data of the Standalone_Implementation database must be migrated into DATA | No data migrated; the standalone file stays untouched |
| OD-21 | Whether the server may see which attachments belong to which message, or only a separate authenticated association request | Association by an explicit authenticated request that references a committed message; the DB-6C review decides the final form |
| OP-01 | Keyed integrity tag on the group cursor (`groups/cursor.js`) | Unsigned codec. PROVISIONAL: recommended by Kiro, not approved by the Project_Owner |
| OP-02 | Association limits when some attachments of the message are already associated | Whole-message reading of DB6-R04.11 |
| OP-03 | DC-03: wire format of the upload frame | ADR-09 length-prefixed body frame (JSON header, then bytes) |
| OP-04 | DC-04: upload timeout | `ATTACHMENT_UPLOAD_TIMEOUT_SECONDS` unset keeps 15 s; it applies only while the Attachment_API switch is on |
| OP-05 | DC-02: outcome for a blocked direct pair | Direct-path outcomes: 404 for a block, 403 for a pair that are not friends |
| OP-07 | Iteration counts of P-32, P-34, P-35 and P-40, below the usual 100 | Counts of the design's Correctness Properties table. PROVISIONAL: recommended by Kiro, not approved by the Project_Owner |
| OP-08 | Expiry of `AttachmentReservations` rows after a crash | PROPOSED: the pending expiry of OD-14 |
| OP-09 | 503 for a busy, locked or unavailable database (DB5-R13.12), while the repository class DATABASE maps to 500 | One repository error class UNAVAILABLE: cannot-open, I/O error, disk full and read-only answer 503 SERVICE_UNAVAILABLE. PROVISIONAL: recommended by Kiro, not approved by the Project_Owner |
| OP-10 | Independent security reviewer for DB-5D and DB-6C, and the report form the Project_Owner accepts | None named: no GROUP-MESSAGING and no ATTACHMENTS-PROTECTED record, so both functions stay off |
| OP-11 | Runtime acknowledgement of a Gate_Record in production (ADR-06) | Implemented; format check `GR-[A-Z0-9-]{3,48}` only |
| OP-12 | Records needed to enable attachments for Real_Accounts | ATTACHMENTS-PROTECTED and DB6-ACCEPTANCE before the Attachment_API switch and `NEXT_PUBLIC_ATTACHMENT_API_READY` are on for Real_Accounts |
| OP-13 | Exception for adapting the 76 client attachment tests at DB-6E | Each changed assertion has a stricter replacement in the inventory (DB5-R15.12); no DB-6E commit before the acknowledgement |
| OP-14 | Group message write rules marked PROPOSED | Envelope version 2 refused for groups until a key model exists; a differing `membership_revision` answers 409 STALE_STATE |
| OP-15 | Realtime hint event: the payload of `conversation:updated` or one additive event | One additive event that existing clients ignore (COMP-07) |
| OP-16 | Whether DB-5G may close while a stage record is missing | No: all four DB-5 stage records are required; the Project_Owner may waive one in writing as a known gap |
| OP-17 | PUT in the mutation bucket of DB5-R12 criterion 4 (a requirements edit awaiting approval, CI-37) | PUT counts as a mutation: G23 uses the mutation bucket |
| OP-18 | Update of `docs/docker-development.md`, section "Data and future migrations" (CI-40) | No edit until approved; this document carries the proposed text (section "Docker development environment") |
| OP-19 | Per-source rate limit values in the Docker_Environment | Configurable, generous in development; no trust of forwarded headers (no `X-Forwarded-For`, no entry in `AUTH_TRUST_PROXY_IPS`) |
| OP-20 | Requirement amendments OA-01 to OA-04 | None applied; the requirement text is unchanged and the defaults of OP-05, OP-03, OP-13 and OP-12 apply (table "Amendments awaiting owner approval" above) |

##### Provisional defaults that Kiro applies in DB-5B (OP-01, OP-07, OP-09)

Reported to the Project_Owner. Kiro recommended these three defaults and the Project_Owner has not approved them. They stay PROVISIONAL, and DB-5B code and tests follow them until the Project_Owner approves them or decides otherwise. The Phase gate T-5B-37 records how each one was applied.

- OP-01: `DATA/server/groups/cursor.js` (T-5B-12) is an unsigned codec, with no server secret and no setting. P-14 claims only the rejection of malformed cursors and of cursors presented for another user, route, conversation or filter set; the file header makes no integrity claim for a well-formed altered payload. The range predicate runs in the same query, so an altered payload cannot expose a message outside the permitted ranges. Confirmed at the DB-5D review (CI-32).
- OP-07: P-32, P-34 and P-35 run 20 to 50 cases and P-40 is exhaustive, below the usual 100 runs. The counts of the design's Correctness Properties table are kept as constants at the top of each test file. Kiro reports the run time, and the counts are revisited at DB-6B (CI-30).
- OP-09: the Group_Repository (T-5B-22) maps cannot-open, I/O error, disk-full and read-only failures to a new error class UNAVAILABLE, which answers 503 SERVICE_UNAVAILABLE as DB5-R13 criterion 12 asks, instead of the 500 of the class DATABASE.

##### Open wording point found by T-5B-07 (DC-01 wording)

Open, awaiting the Project_Owner. It is not an OD or OP item. The spec text says the seven DC-01 assertions change by appending the new migration file names or version numbers ("only by appending" in the DC-01 rule of the Notes of tasks.md; the same reading in DB5-R15 criterion 11, ARCH-R02 criterion 1, design DC-01 and T-5B-05). That describes six of the seven lines. Line 29 of `DATA/tests/e2ee-migrations.test.js` holds no list: its change replaces the version literal `7` by the new highest version (`8` with 0008, `9` with 0009). The Project_Owner's approval wording ("updating exactly the seven migration-ledger test literals") covers that replacement, and the guard of T-5B-05 permits exactly it (entry "OP-06" above). The spec wording stays unchanged until the Project_Owner decides whether to amend it. Default: the OP-06 entry above applies as written, and no spec text is edited.

## Known_Baseline_Failure

The list holds exactly two entries, by test name and platform. Both are in `client/src/components/ai/__tests__/messengerAI.test.tsx`, which stays unchanged from d7cd40a (G9), and both are on the platform Windows only. INFRA-01C found that on Windows they cannot find the text `Review for draft` and that both pass on Linux (design fact F27). INFRA-01C traced the Windows failures to a 1000 ms Testing Library deadline under slow execution, so the Windows result depends on host load.

| Entry | Test name | Platform | Line in the file |
| --- | --- | --- | --- |
| 1 | "a prepared rewrite replaces a draft only after review and confirmation, never sends it" | Windows | 79 |
| 2 | "draft changes invalidate a pending replacement instead of overwriting newer text" | Windows | 100 |

### Rules of the list

1. The list is exactly these two names on the platform Windows. A new entry exists only by a recorded Project_Owner decision. No such decision exists. The host-only DATA failures seen in DB-5B are not entries (section "Test commands and results", "Gate-runner procedure").
2. The entries are never skipped, edited, excluded or silenced (DB5-R15.15). G9 requires the file to stay unchanged from d7cd40a, G5a prints no skip marker and G5b prints no removed assertion.
3. Any other failing test fails the gate of the phase, in the Validation_Runner and on the Windows host. A Windows run that fails anything beyond the two names is not accepted as additional evidence for the phase, and the Project_Owner decides what the extra failure is.
4. Every gate run that includes the client group records the Linux pass of both tests with the read-out below. A Linux failure of either test fails the gate.
5. A Windows pass of either test is recorded as well, and the list does not change.
6. A retry of a failed test file does not clear the failure. The first result and the retry result are both recorded, and the Project_Owner decides. INFRA-01C recorded one such retry: a client realtime unit file failed in a full run (1071/4/0) and passed 9 of 9 on retry (F27, CI-39).

### Linux read-out

The read-out of the design (Testing Strategy, "Known_Baseline_Failure handling"), with `duration` added to the selected fields. PowerShell, repository root; `$evidence` is the evidence directory of the client group run, here the one of T-5B-02:

```powershell
$evidence = 'docker/artifacts/secubuzz-validation-47185663-client'
(Get-Content (Join-Path $evidence 'client-jest.json') -Raw | ConvertFrom-Json).testResults.assertionResults |
  Where-Object { $_.title -in 'a prepared rewrite replaces a draft only after review and confirmation, never sends it', 'draft changes invalidate a pending replacement instead of overwriting newer text' } |
  Select-Object title, status, duration
```

### Recorded runs

| Run | Date | Platform | Source | Entry 1 | Entry 2 |
| --- | --- | --- | --- | --- | --- |
| DB-5B entry baseline (T-5B-02) | 2026-11-21 | Linux, Validation_Runner (project `secubuzz-validation-47185663`) | `docker/artifacts/secubuzz-validation-47185663-client/client-jest.json` (1075 tests, 1075 passed, 0 failed, 0 pending, 0 todo, 102 suites) | passed, 3042 ms | passed, 3248 ms |
| DB-5B entry baseline (T-5B-02) | 2026-11-21 | Windows host, scoped C4 run | `host-client-jest-scoped.json` under the system temporary directory (1075 tests, 1075 passed, 0 failed) | passed, 4105 ms | passed, 3939 ms |
| DB-5B final gate attempt (T-5B-37), BLOCKED | 2026-11-21 | Linux Validation_Runner | docker/artifacts/db5b-1-39/linux-client/client-jest.json (1073 passed, 2 other tests failed) | passed, 3622 ms | passed, 2607 ms |
| DB-5B final gate attempt (T-5B-37), BLOCKED | 2026-11-21 | Windows host, incomplete literal C4 | docker/artifacts/db5b-1-39/windows/C4-literal.log; current protected suite PASS, entire run timed out | suite PASS receipt; per-test JSON unavailable | suite PASS receipt; per-test JSON unavailable |

- In the T-5B-02 run both tests passed on both platforms, in the first run and with no retry. On Windows their suite also printed PASS in the literal C4 run. The Windows pass is recorded under rule 5, and both entries stay on the list.
- No test was edited, skipped or excluded. G9 exited 0 on 2026-11-21 (T-5B-39, section "Gate-runner procedure").
- Each later gate run that includes the client group adds its rows here.

## Docker development environment

The DB-5 and DB-6 work changes no Docker material (COMP-10): no edit of `compose.yaml`, any Dockerfile, `docker/*`, `.dockerignore` or `README.md`, and no new service, container, port or volume. All new server code runs inside the existing backend process. Owner exception (approved, DB-5B final gate preparation): `.dockerignore` and `docker/validation.Dockerfile` may change only to copy `docs/docker-development.md` into the Validation_Runner image, where the documentation test reads it. No production Docker behavior, Compose file, service, port or volume changes.

Volumes:

- `sqlite-data`, mounted at `/var/lib/secubuzz/sqlite`, holds `database.sqlite` with its WAL and SHM files (`DB_PATH=/var/lib/secubuzz/sqlite/database.sqlite`).
- `private-storage`, mounted at `/var/lib/secubuzz/attachments`, is the reserved `ATTACHMENT_STORAGE_DIR`. No feature uses it before DB-6B. It is backed up and restored together with `sqlite-data`, so rows and stored bytes do not diverge.

Migrate on start: the backend runs `npm --prefix server run start:data`, and the unchanged DATA connection runs the migration runner when it opens the database, before the server listens. The first start of an image that contains 0008 migrates `sqlite-data` at once and permanently; older code then stops with `MIGRATION_HISTORY_MISMATCH`. A failed migration stops startup, and with no restart policy the container stays stopped; the operator reads `docker compose logs backend`.

Cold backup: by the procedure of `docs/docker-development.md`, sections "Cold backup commands (PowerShell)" and "Restore into new volumes first (PowerShell)", as stated in the second paragraph of this document. This handoff does not copy those commands, and no backup helper or script exists (DK-05, DK-06).

Compose Watch rule (DK-04): never start or keep running `docker compose watch` for a project whose volumes hold data to keep while a migration file is a draft (present in the working tree and not committed). The watch rule for `DATA/server` syncs migration files and restarts the backend, which would apply a pending migration to the persistent volume. `git status --short -- DATA/server/database/migrations` must print nothing before any `docker compose watch`.

Disposable_Project procedure and naming (DK-03, DK-07). A container-level migration test or rehearsal runs only in a Disposable_Project:

1. The name is `secubuzz-disposable-` followed by 8 lowercase hexadecimal characters, and every command passes it with an explicit `-p`.
2. The project has its own volumes (`<project>_sqlite-data`, `<project>_private-storage`) and no published port: a temporary override file kept outside the repository removes the `ports` key of the backend. `docker compose config` with that override must show no published port before the project starts. No repository file is edited.
3. Input is synthetic fixtures, or an isolated copy of a cold backup restored into the fresh volumes of that project (guide section "Restore into new volumes first"), never the live database and never the volumes of the running project.
4. `docker compose -p <name> down -v` runs only after the name matches `^secubuzz-disposable-[0-9a-f]{8}$` and the project was created for that one test. `-v` is never used on any other project.

The design (section "Docker development environment compatibility") holds the full command sequence.

Gate runner: the Validation_Runner is the gate of record of every phase from DB-5B to DB-7 (DK-01); Windows host runs are additional evidence and never replace it. It is built once per gate run from the working tree with the commands of `docs/docker-development.md` ("Build fresh Linux validation images") and runs the groups `data`, `server`, `client` (and `browser` when a phase asks for it), each with its own evidence directory under the Git-ignored `docker/artifacts/`. It runs with `--network none`, starts no application container, publishes no port and mounts only its evidence directory, so it is not a Disposable_Project. The image holds no `.git`, `compose.yaml`, `.dockerignore` or `docs/`, so the git and Docker-file gates G1 to G9 run at the repository root. An image built with a draft migration is never started against volumes that hold data to keep. New files avoid the `.dockerignore` names and extensions, or the image silently drops them (G7).

Rebuild rules: Compose Watch syncs only `server/src`, `DATA/server` and `shared`, and the frontend mounts only `client/src`, `client/public` and `shared`. These need `docker compose up --build -d`: `DATA/docs`, `DATA/tests`, `DATA/scripts`, `client/authProxy.cjs`, `client/next.config.js`, any `package.json` or lockfile, and any Dockerfile. `NEXT_PUBLIC_*` values come only from `compose.yaml`; a flag for a manual test is set only in a temporary override file outside the repository, followed by recreation of the frontend container.

### Proposed update of `docs/docker-development.md` (OP-18)

The proposed update of the section "Data and future migrations" of `docs/docker-development.md` is carried here as text and is applied only after the Project_Owner approves it (OP-18; INFRA-01 owns that file). Until then the guide is not edited. The text below is a draft; its version numbers are set when 0008 ships (and again for 0009 in DB-6B).

Proposed replacement of the second paragraph of "Data and future migrations" (the paragraph that says INFRA-01B contains versions 0001 through 0007 and calls 0008/0009 future migrations):

> The unchanged canonical DATA connection applies its transactional, checksummed migrations before serving requests. The shipped versions are 0001 through 0008 (0009 is added by DB-6B). WARNING: the first start of an image that contains a new migration migrates the `sqlite-data` volume at once and permanently. Older code then refuses to start with `MIGRATION_HISTORY_MISMATCH`, and turning a feature switch off does not undo a migration. Before that first start against data to keep, stop every writer and take the cold backup below. Do not run `docker compose watch` while a migration file is a draft. The migration documents are `DATA/docs/migrations.md` and `DATA/docs/schema.md`; the DB-5/DB-6 handoff is `DATA/docs/db5-db6-handoff.md`. Migration failure stops startup; never initialize from legacy `schema.sql` or rewrite the ledger.

Two related sentences for the owner to review in the same update (not edited):

- Section "Images and environment": "No groups or canonical attachment implementation/migrations are supplied here." Proposed: "Group and canonical attachment code ships disabled behind its feature switches; `compose.yaml` enables none of them."
- Section "Security and support boundary": "No DB-5/DB-6 implementation or new migrations are included." Proposed: "DB-5/DB-6 code and migrations are included, with every new function disabled; see `DATA/docs/db5-db6-handoff.md`."
