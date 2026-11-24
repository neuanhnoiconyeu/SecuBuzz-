# Implementation Plan: DB-5 / DB-6 Canonical Integration

## Overview

This plan turns the approved requirements and design of `db5-db6-canonical-integration` into coding tasks. The specification phase (DB-0/DB-5A) made no implementation, so every checkbox starts unchecked and is ticked only after the task's own checks pass.

This plan covers the group-chat phases DB-5B to DB-5G as top-level groups 1 to 6, the file-sharing phases DB-6A to DB-6F as groups 7 to 12, and DB-7 (combined regression, handoff and the publication gate) as group 13. Identifiers (DB5-Rnn.m, ARCH-Rnn.m, NFR-nn, COMP-nn, P-nn, OD-nn, OP-nn, DC-nn, AF-nn, CI-nn) and file names are those of requirements.md and design.md. Tests required by DB5-R15 are core work, so no test sub-task carries the optional `*` marker.

The plan was reconciled with the owner-approved decisions of the DB-5A reconciliation (OP-06, OD-01 in part, OD-04, OD-05, OD-08 in part and DK-01 to DK-07) and with the merged Docker_Environment (PR #19): the functional baseline stays d7cd40a, which the tests, checksums and git gates pin, and the integration base is origin/main dc6c997.

## Notes

**Ground rules (every task obeys them)**

- Never open `DATA/server/database/database.sqlite` or its `-wal` and `-shm` files, and never open, mount, archive or write the volumes (`sqlite-data`, `private-storage`) or any file under `/var/lib/secubuzz/` of the running Docker_Environment project, in tests, scripts or manual checks (DB5-R14.17, DB5-R14.21). Use a temporary database in a new directory under the system temporary directory. A container-level migration test or rehearsal runs only in a Disposable_Project (rule below).
- No commit, push or pull request without Project_Owner approval. A task ends with a changed working tree, not a commit.
- Do not edit published migrations 0001 to 0007. Their SHA-256 checksums stay as pinned in the design (Data Models).
- No new cryptographic design: no new protocol, key format, envelope format or primitive (Explicit Exclusion 2). Add no runtime dependency without a handoff entry (NFR-09).
- No edit, rename or deletion of Standalone_Implementation code or tests in DB-5B to DB-7. G2 stays empty until both acceptance records exist.
- DC-01 exception (OP-06 decided in the DB-5A reconciliation): exactly seven migration-ledger assertions of baseline tests may change when a migration is added, only by appending the new migration file name or version number, in the same commit as the migration that forces them (the same change set while nothing is committed), with guard tests that fail on any other changed baseline line. The seven are the applied list in `auth-migrations.test.js` (line 24), `conversations-migrations.test.js` (line 21), `e2ee-migrations.test.js` (lines 12 and 29), `messaging-migrations.test.js` (line 11), `migrations.test.js` (line 14) and `social-migrations.test.js` (line 25) (DB5-R15.11, ARCH-R02.1). G5b lists nothing else.
- The fixtures of T-5B-03 and T-5B-04 are recorded from the unchanged functional baseline d7cd40a (shared by the integration base dc6c997) before any other code change, and are read-only afterwards.
- `GET /api/conversations` stays direct-only and the strict direct parser of the client stays unchanged. The direct message path stays byte-identical except the DB-5E `bindStore` dispatch.
- Every new function ships disabled behind its Feature_Gate switch. No committed environment file, `compose.yaml`, `docker/compose.env.example.yaml` or Docker override file turns a switch on, sets a group or attachment setting or sets a `NEXT_PUBLIC_*` readiness flag to `true` (G8). A switch is enabled for a manual test only through a temporary override file kept outside the repository.
- Tests use an injected clock and limiter, temporary directories, loopback only and a printed seed. No `Math.random`, wall clock or network.
- Gate of record (DB5-R15.10, DK-01): the run of C1 to C5 in the Validation_Runner is the gate of record of every phase; runs on the Windows host are additional evidence and never replace it. Known_Baseline_Failure entries are recorded by test name and platform in the handoff and are never skipped, edited, excluded or silenced; G9 requires `client/src/components/ai/__tests__/messengerAI.test.tsx` to stay unchanged. Any other failing test fails the gate (DB5-R15.15).
- Container-level migration tests and rehearsals run only in a Disposable_Project (DK-03, DK-07; DB5-R14.21, DB5-R14.24): the name is `secubuzz-disposable-` plus 8 lowercase hexadecimal characters, created with an explicit `-p`, with its own volumes and no published port (a temporary override file outside the repository removes the `ports` key of the backend; no repository file is edited). `docker compose -p <name> down -v` runs only after the name matches `^secubuzz-disposable-[0-9a-f]{8}$` and the project was created for that one test. Never use `-v` on any other project. The Validation_Runner is not a Disposable_Project and starts no application container.
- Never run Docker Compose Watch while a migration file is a draft (DK-04, DB5-R14.22). `git status --short -- DATA/server/database/migrations` must print nothing before any `docker compose watch`.
- Cold backup before the first start (DK-05, DB5-R14.23): before the first start of code that contains a new migration against data to keep, stop every process that writes to either volume and archive both complete volume roots by the cold-backup procedure of `docs/docker-development.md`. A copy of a live database file alone is not a backup. No backup helper or script is built (DK-06).
- Docker material is read-only for this work (COMP-10, Explicit Exclusion 11): no edit of `compose.yaml`, any Dockerfile, `docker/*`, `.dockerignore` or `README.md`, and no new service, container, port or volume. `docs/docker-development.md` is edited only after the Project_Owner approves OP-18.
- No application container is started by DB-5B unless a task says so (T-5B-36 does, in a Disposable_Project).
- New files and fixtures avoid the `.dockerignore` names and extensions (G7): the directory names `uploads`, `.uploads`, `private-attachments`, `backups`, `secrets`, `build`, `out`, `dist`, `tmp`, `temp`, `artifacts`, `coverage`, `.cache`, `playwright-report`, `test-results` and names starting `.next`; the extensions `.db`, `.sqlite`, `.sqlite3` (with their `-wal`, `-shm` and `-journal` forms), `.log`, `.part`, `.bak`, `.backup`, `.pem`, `.key`, `.crt`, `.p12`, `.pfx` and `.tsbuildinfo`; and environment files other than the committed examples. Fixtures are `.json` or `.txt`, or are generated in memory or under `os.tmpdir()` at run time.

**Identifiers.** Task IDs are `T-<phase>-<nn>` (T-5B-01, T-5C-01, ...), unique and stable. Display numbers (1.1, 2.3) may move, IDs do not. "Depends on" lists IDs; a range such as `T-5B-01 to T-5B-10` means every ID in that span that is a task. T-5B-34 was dropped by the owner (DK-06) and is never reused, so a range that spans it does not include it; where it matters a list names the IDs one by one.

**Agents.** Kiro: database and backend (`DATA/`, and `server/src/data` in DB-5E). Codex: frontend (`client/`). Independent security reviewer: a person or agent that did not write the code under review (OP-10). Project_Owner: decisions and approvals.

**Verify commands.** C1 to C5 are the commands of the three Validation_Runner groups and run in the folder named. The gate of record is the run in the Validation_Runner (DB5-R15.10, DK-01); the same commands on a Windows host are additional evidence and never replace that run. A focused single-file command in a task's Verify line (for example `node --test tests/groups-policy.test.js` in DATA/) may run on the host or in a container for quick feedback, but a Phase gate uses the runner.

- C1 `npm test` in DATA/ (the script `test` runs `node --test`); runner group `data`
- C2 `npm run type-check` in server/; runner group `server`
- C3 `npm test` in server/; runner group `server`
- C4 `npm test -- --runInBand` in client/; runner group `client`
- C5 `npm run type-check` in client/; runner group `client` (the client group also runs `npm run lint` and `npm run build:verify`)

Build the Validation_Runner once per gate run, then run each group that the phase needs, each with its own evidence directory (PowerShell, repository root; the commands of `docs/docker-development.md`, "Build fresh Linux validation images"). The runner starts no application container, publishes no port and mounts only its evidence directory. The image is built from the working tree, so an image built with a draft migration is never started against volumes that hold data to keep:

```powershell
$project = 'secubuzz-validation-' + [guid]::NewGuid().ToString('N').Substring(0,8)
docker compose -p $project build backend frontend
docker build -f docker/validation.Dockerfile --build-arg "FRONTEND_IMAGE=${project}-frontend:latest" --build-arg "BACKEND_IMAGE=${project}-backend:latest" -t "${project}-runner:latest" .
$evidence = Join-Path (Get-Location) "docker/artifacts/$project-data"     # one directory per group run; ignored by Git
New-Item -ItemType Directory -Path $evidence | Out-Null
docker run --rm --init --network none --shm-size=1g --mount "type=bind,source=$evidence,target=/evidence" -e SECUBUZZ_DOCKER_VALIDATION=true "${project}-runner:latest" node docker/validate.cjs data
```

Repeat the last three commands with the group `server` (C2, C3) and the group `client` (C4, C5), each with its own evidence directory. The runner prints passed, failed and skipped counts, and a damaged or empty image is not valid evidence. G1 to G9 run on the host at the repository root in PowerShell, because they need git, `compose.yaml` and `.dockerignore`, none of which the runner holds. G1 to G6 keep d7cd40a as their base because PR #19 changed none of the paths they name. G7 uses the integration base dc6c997. All nine are read-only:

- G1 `git diff --diff-filter=MD --exit-code d7cd40a -- DATA/server/database/migrations`
- G2 `git diff --exit-code d7cd40a -- server/api-main.cjs server/src/api-app.cjs server/src/routes/groups.cjs server/src/routes/attachment.cjs server/src/db5db6 server/src/storage/attachmentStorage.cjs server/src/middleware/requireAuth.cjs server/test/db5_db6.test.cjs server/test/integration/attachments.test.ts`
- G3 `git diff --diff-filter=DR --name-only d7cd40a -- DATA/tests server client/src`
- G4 `git diff --exit-code d7cd40a -- <the 8 client attachment test files listed in the standalone inventory>`
- G5a `git diff d7cd40a -U0 -- DATA/tests server/test client/src | Select-String -Pattern '^\+.*(\.skip\(|\.todo\(|\.only\(|skip\s*:|todo\s*:)'`
- G5b `git diff d7cd40a -U0 -- DATA/tests server/test client/src | Select-String -Pattern '^-(?!-).*(assert|expect)'`
- G6 `git diff --diff-filter=MD --exit-code d7cd40a -- server/test/data`
- G7 lists any new file whose path `.dockerignore` would silently drop from the image and from the Validation_Runner (the last exclusion names the two preserved untracked client folders):

```powershell
$pattern = '(^|/)(node_modules|uploads|\.uploads|private-attachments|backups|secrets|build|out|dist|tmp|temp|artifacts|coverage|\.cache|\.turbo|\.swc|playwright-report|test-results|\.git|\.kiro|\.next[^/]*)(/|$)|\.(db|sqlite3?|log|part|bak|backup|pem|key|crt|p12|pfx|tsbuildinfo)([-.][^/]*)?$|(^|/)(\.npmrc|\.yarnrc[^/]*|credentials\.json)$|(^|/)(\.env[^/]*|[^/]*\.env)$'
$new = @(git diff --name-only --diff-filter=A dc6c997 -- DATA server shared client docker) + @(git ls-files --others --exclude-standard -- DATA server shared client docker)
$new | Sort-Object -Unique | Where-Object { $_ -match $pattern -and $_ -notmatch '(^|/)\.env\.example(\.txt)?$' -and $_ -notmatch '^client/artifacts/phase8-8(-hotfix)?/' }
```

- G8 `Select-String -Path compose.yaml, docker/compose.env.example.yaml -Pattern 'GROUPS_API_ENABLED|GROUP_MESSAGING_ENABLED|ATTACHMENTS_API_ENABLED|GROUPS_UI_READY|GROUP_MAX_|GROUP_INVITATION|_GATE_RECORD|ATTACHMENT_(QUOTA|PENDING|PURGE|RETENTION|UPLOAD|MAX)|NEXT_PUBLIC_ATTACHMENT_API_READY:\s*.?true'` shows any Docker file that enables a switch or sets a feature setting (`ATTACHMENT_STORAGE_DIR` is allowed and is not matched).
- G9 `git diff --exit-code d7cd40a -- client/src/components/ai/__tests__/messengerAI.test.tsx` shows any edit of the file that holds the two Known_Baseline_Failure tests.

Passing results, in the Validation_Runner: C1 shows `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0` and `# pass` of at least 321 plus the new tests (tests, passed, failed and skipped from `data-results.json`; cancelled and todo from `data-tests.log`). C2 and C5 exit 0, and the lint and `build:verify` steps of the client group exit 0. C3 shows at least 547 passed plus the new tests, with 0 failed and 0 skipped. C4 shows at least 1075 passed on Linux, with 0 failed and 0 skipped. C3 and C4 also meet at least the counts recorded in T-5B-01 and T-5B-02. G1, G2, G4, G6 and G9 exit 0. G3, G5a, G7 and G8 print nothing. G5b prints only the seven DC-01 lines. On the Windows host (additional evidence) C1 and C3 pass as in the runner. C4 records the two named Known_Baseline_Failure tests and their prior signatures as historical evidence; all-pass is acceptable, no tests may be skipped, and any unlisted failure fails the gate. The historical exact-two-failure count is not required.

**Phase gates.** Every phase ends with a "Phase gate" task. It runs the commands of the design's verification table (Testing Strategy, section 11) for that phase, C1 to C5 in the Validation_Runner as the gate of record and G1 to G6 at the repository root, and it also runs G7, G8 and G9 in every phase. It records command and runner group, passed, failed and skipped counts (C1 also cancelled and todo), date, `git rev-parse HEAD` and `git status --short` in `DATA/docs/db5-db6-handoff.md` (DB5-R15.13). The Windows host results are recorded beside the runner results, with the platform named, as additional evidence; the Known_Baseline_Failure entries are listed separately by test name and platform and are never suppressed (DB5-R15.14). A run is not evidence when its results file is missing, when its test count is 0 or below the baseline, when the image build guards fail, or when `validate.cjs` exits non-zero for a reason other than a recorded Known_Baseline_Failure. Docker must be running for a gate run; no application container is started by it, and Compose Watch is off while a migration file is a draft. Where the design requires a Gate_Record (GROUP-MANAGEMENT, GROUP-MESSAGING, GROUP-REALTIME, GROUP-FRONTEND, DB5-ACCEPTANCE) or Project_Owner approval, the gate task also needs that record or approval and stays unchecked until it exists. A failed or skipped test, or a failure that is not on the recorded Known_Baseline_Failure list, keeps the phase open (DB5-R15.15).

**Phase start rule.** A phase starts only when its entry criteria are met and its blocking decisions are settled. Decisions that block each phase:

- DB-5B: only the Project_Owner's approval of the reconciled specification set (the requirements, the design, this task list and the phase order; CI-31) remains. OP-06, OD-05 and DK-01 to DK-07 are decided in the DB-5A reconciliation, and T-5B-07, T-5B-08 and T-5B-38 record them in the handoff. Defaults in force, provisional (recommended by Kiro, not approved) and reported in the handoff: OP-01, OP-07, OP-09.
- DB-5C: no decision blocks coding. OD-04 is decided as 50 active members but stays a required setting (`GROUP_MAX_MEMBERS`, no default in code). The OD-08 expiry is decided as the fixed 7 days (604,800 s) and is not a setting. The two pending-Invitation maxima (`GROUP_MAX_PENDING_INVITATIONS_PER_GROUP`, `GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE`) and the re-invite delay still need values from the Project_Owner before GROUP-MANAGEMENT can be approved. OD-01 is decided in part (direct add stays off; the friendship sub-question is open, default no friendship rule beyond blocks). Defaults in force: OD-02, OD-03, OD-06, OD-07, OD-09 to OD-11, OP-11, OP-17 to OP-19.
- DB-5D: OP-10 (reviewer named). OD-19 is recorded before the review closes. Defaults in force: OD-07, OD-12, OD-13, OP-14.
- DB-5E: none (OP-15 is settled by reading the `conversation:updated` payload in the first task).
- DB-5F: none; the Project_Owner acknowledges the CI-11 expectation change for the `/api/groups` rewrite.
- DB-5G: OP-16 (a missing stage record) and OD-20 (before any Standalone_Implementation code is deprecated).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.6"] },
    { "id": 2, "tasks": ["1.4", "1.7", "1.32"] },
    { "id": 3, "tasks": ["1.5", "1.8"] },
    { "id": 4, "tasks": ["1.9", "1.14", "1.20", "1.37"] },
    { "id": 5, "tasks": ["1.10", "1.38"] },
    { "id": 6, "tasks": ["1.11", "1.12"] },
    { "id": 7, "tasks": ["1.13", "1.15"] },
    { "id": 8, "tasks": ["1.16", "1.21"] },
    { "id": 9, "tasks": ["1.17", "1.22", "1.35"] },
    { "id": 10, "tasks": ["1.18", "1.23"] },
    { "id": 11, "tasks": ["1.19", "1.24"] },
    { "id": 12, "tasks": ["1.25"] },
    { "id": 13, "tasks": ["1.26"] },
    { "id": 14, "tasks": ["1.27"] },
    { "id": 15, "tasks": ["1.28", "1.31"] },
    { "id": 16, "tasks": ["1.29", "1.30", "1.33"] },
    { "id": 17, "tasks": ["1.36"] },
    { "id": 18, "tasks": ["1.39"] },
    { "id": 19, "tasks": ["2.1", "7.1", "7.2"] },
    { "id": 20, "tasks": ["2.2", "7.3", "7.4", "7.20"] },
    { "id": 21, "tasks": ["2.3", "7.6", "7.21"] },
    { "id": 22, "tasks": ["2.4", "7.7", "7.9", "7.11"] },
    { "id": 23, "tasks": ["2.5", "2.7", "7.8", "7.10", "7.18"] },
    { "id": 24, "tasks": ["2.6", "2.8"] },
    { "id": 25, "tasks": ["2.9", "7.13"] },
    { "id": 26, "tasks": ["2.10", "7.14"] },
    { "id": 27, "tasks": ["2.11", "2.33", "7.15"] },
    { "id": 28, "tasks": ["2.12", "7.16"] },
    { "id": 29, "tasks": ["2.13", "2.34", "7.17"] },
    { "id": 30, "tasks": ["2.14", "2.29", "2.35", "7.19"] },
    { "id": 31, "tasks": ["2.15", "7.23"] },
    { "id": 32, "tasks": ["2.16", "2.30", "7.5", "7.22"] },
    { "id": 33, "tasks": ["2.17", "2.31", "7.12"] },
    { "id": 34, "tasks": ["2.18", "2.21", "2.22", "2.32", "2.40", "2.41", "2.42", "7.24"] },
    { "id": 35, "tasks": ["2.19", "2.23", "2.24", "2.36", "2.43", "2.46", "2.51"] },
    { "id": 36, "tasks": ["2.20", "2.25", "2.37", "2.44", "2.47", "2.52"] },
    { "id": 37, "tasks": ["2.26", "2.38", "2.45", "2.48", "2.49"] },
    { "id": 38, "tasks": ["2.27", "2.39", "2.50", "2.53"] },
    { "id": 39, "tasks": ["2.28"] },
    { "id": 40, "tasks": ["2.54"] },
    { "id": 41, "tasks": ["3.1", "3.2", "4.2", "8.1", "8.7", "8.8"] },
    { "id": 42, "tasks": ["3.3", "3.27", "4.4", "8.2", "8.3", "8.4", "8.9", "8.11", "8.12"] },
    { "id": 43, "tasks": ["3.4", "4.1", "4.5", "8.5", "8.10", "8.13", "8.18", "8.21"] },
    { "id": 44, "tasks": ["3.5", "4.6", "6.2", "8.6", "8.14", "8.19", "8.22", "8.49"] },
    { "id": 45, "tasks": ["3.6", "8.15", "8.20", "8.23", "8.37", "8.44"] },
    { "id": 46, "tasks": ["3.7", "8.16", "8.24", "8.32", "8.39", "8.50"] },
    { "id": 47, "tasks": ["3.8", "8.17", "8.25", "8.38"] },
    { "id": 48, "tasks": ["3.9", "8.26", "8.51"] },
    { "id": 49, "tasks": ["3.10", "8.27", "8.33"] },
    { "id": 50, "tasks": ["3.11", "3.12", "3.14", "3.20", "8.28", "8.42"] },
    { "id": 51, "tasks": ["3.13", "3.15", "3.18", "3.21", "8.29", "8.34"] },
    { "id": 52, "tasks": ["3.16", "3.19", "3.22", "6.3", "8.30", "8.35"] },
    { "id": 53, "tasks": ["3.17", "3.23", "8.31"] },
    { "id": 54, "tasks": ["3.24", "3.26", "8.36"] },
    { "id": 55, "tasks": ["3.25", "8.40", "8.43", "8.47", "8.48", "8.52"] },
    { "id": 56, "tasks": ["3.28", "8.41", "8.45", "8.46"] },
    { "id": 57, "tasks": ["3.29", "8.53"] },
    { "id": 58, "tasks": ["3.30", "8.54"] },
    { "id": 59, "tasks": ["3.31", "9.2", "10.2"] },
    { "id": 60, "tasks": ["4.3", "5.1", "9.3", "10.3"] },
    { "id": 61, "tasks": ["4.7", "5.2", "6.4", "9.4", "10.4"] },
    { "id": 62, "tasks": ["4.8", "5.3", "9.1", "10.5"] },
    { "id": 63, "tasks": ["4.9", "5.4", "9.5", "10.6", "10.8", "10.16"] },
    { "id": 64, "tasks": ["5.5", "6.5", "9.6", "10.7", "10.17"] },
    { "id": 65, "tasks": ["5.6", "6.7", "9.7", "10.9", "10.14"] },
    { "id": 66, "tasks": ["5.7", "6.8", "10.10", "10.15", "10.20"] },
    { "id": 67, "tasks": ["5.8", "6.9", "9.8", "10.11"] },
    { "id": 68, "tasks": ["5.9", "9.9", "10.12"] },
    { "id": 69, "tasks": ["5.10", "9.10", "10.13"] },
    { "id": 70, "tasks": ["5.11", "9.11", "10.1", "10.18"] },
    { "id": 71, "tasks": ["5.12"] },
    { "id": 72, "tasks": ["6.1", "9.12"] },
    { "id": 73, "tasks": ["6.6", "10.19"] },
    { "id": 74, "tasks": ["6.10"] },
    { "id": 75, "tasks": ["6.11", "10.21"] },
    { "id": 76, "tasks": ["6.12"] },
    { "id": 77, "tasks": ["9.13"] },
    { "id": 78, "tasks": ["11.1"] },
    { "id": 79, "tasks": ["11.2"] },
    { "id": 80, "tasks": ["11.3"] },
    { "id": 81, "tasks": ["11.4", "11.6"] },
    { "id": 82, "tasks": ["11.5", "11.7"] },
    { "id": 83, "tasks": ["11.8"] },
    { "id": 84, "tasks": ["11.9"] },
    { "id": 85, "tasks": ["11.10"] },
    { "id": 86, "tasks": ["11.11"] },
    { "id": 87, "tasks": ["11.12"] },
    { "id": 88, "tasks": ["11.13", "11.14"] },
    { "id": 89, "tasks": ["11.15"] },
    { "id": 90, "tasks": ["12.1", "12.3", "12.4"] },
    { "id": 91, "tasks": ["12.2"] },
    { "id": 92, "tasks": ["12.5"] },
    { "id": 93, "tasks": ["12.6"] },
    { "id": 94, "tasks": ["12.7"] },
    { "id": 95, "tasks": ["12.8"] },
    { "id": 96, "tasks": ["12.9"] },
    { "id": 97, "tasks": ["12.10"] },
    { "id": 98, "tasks": ["13.1"] },
    { "id": 99, "tasks": ["13.2", "13.3"] },
    { "id": 100, "tasks": ["13.4"] },
    { "id": 101, "tasks": ["13.5"] },
    { "id": 102, "tasks": ["13.6"] },
    { "id": 103, "tasks": ["13.7"] },
    { "id": 104, "tasks": ["13.8"] },
    { "id": 105, "tasks": ["13.9"] },
    { "id": 106, "tasks": ["13.10"] },
    { "id": 107, "tasks": ["13.11"] },
    { "id": 108, "tasks": ["13.12"] },
    { "id": 109, "tasks": ["13.13"] }
  ]
}
```

## Tasks

- [x] 1. DB-5B: group schema, migration 0008, Group_Repository, policy and baseline guards
  **Entry criteria.** Five criteria, all recorded in the handoff. (1) The Project_Owner has approved the reconciled specification set. (2) OP-06, OD-05 and DK-01 to DK-07 are recorded as approved in the DB-5A reconciliation (T-5B-07, T-5B-08 and T-5B-38 write them into the handoff decision log); the provisional defaults of OP-01, OP-07 and OP-09 are reported in the handoff. (3) The local branch is at or after origin/main dc6c997, and the working tree has no change other than the three preserved pre-existing entries (`client/tsconfig.json` modified; `client/artifacts/phase8-8/` and `client/artifacts/phase8-8-hotfix/` untracked) and the spec folder; the stash is preserved. The functional baseline pinned by tests, checksums and git gates stays d7cd40aafcf8f432d17d3f4a85abb26d19fa9bc3. (4) The baseline suites are measured before the first change in the Validation_Runner (gate of record) and on the Windows host (additional evidence), compared with the INFRA-01C numbers (T-5B-01, T-5B-02), and the Known_Baseline_Failure list is recorded (T-5B-39). (5) Docker is running when a gate run needs the Validation_Runner; no application container is started for DB-5B by default; Compose Watch is off while migration files are drafts (`git status --short -- DATA/server/database/migrations` prints nothing before any `docker compose watch`). No change under `server/` or `client/` in this phase.

  - [x] 1.1 Record the DATA and server baseline suite counts in the Validation_Runner
    - **ID**: T-5B-01
    - **Depends on**: none
    - **Affected modules**: none (read-only runs of `DATA/` and `server/` suites; the evidence directories are under the ignored `docker/artifacts/`)
    - **Acceptance criteria**:
      - The Validation_Runner is built once from the unchanged tree (Verify commands, Notes) and the groups `data` and `server` run in it (C1, C2, C3). Command and group, passed, failed, skipped (C1 also cancelled and todo), date, `git rev-parse HEAD` and `git status --short` are noted for T-5B-06.
      - The same C1, C2 and C3 run on the Windows host as additional evidence and are noted beside the runner results with the platform named.
      - C1 shows at least 321 passed with 0 failed, 0 skipped, 0 cancelled and 0 todo in the runner. The server numbers are compared with the INFRA-01C measurements recorded in the design (F27): the type-check passes and C3 shows 547 passed, 0 failed, 0 skipped at d7cd40a. The specification work did not re-run them; this task measures them again. A difference from those numbers, or any other failure, is reported and stops the phase.
      - No test, file or setting is changed. `git status --short` lists the same entries before and after the runs.
    - **Verify**: Validation_Runner groups `data` and `server` (C1, C2, C3); on the Windows host `npm test` in DATA/, `npm run type-check` and `npm test` in server/
    - **Agent**: Kiro
    - _Requirements: DB5-R15.10, DB5-R15.13, ARCH-R02.1, COMP-01_

  - [x] 1.2 Record the client baseline suite counts in the Validation_Runner
    - **ID**: T-5B-02
    - **Depends on**: none
    - **Affected modules**: none (read-only runs in `client/`; the evidence directory is under the ignored `docker/artifacts/`)
    - **Acceptance criteria**:
      - The group `client` runs in the Validation_Runner (C4, C5; the group also runs `npm run lint` and `npm run build:verify`) on the unchanged tree. Command and group, passed, failed, skipped, date, `git rev-parse HEAD` and `git status --short` are noted for T-5B-06. The result is compared with the INFRA-01C measurement of the design (F27): 1075 passed, 0 failed, 0 skipped on Linux (102 suites, one retry seen). A retry of a failed file does not clear the failure: the first result and the retry result are both noted and the Project_Owner decides.
      - C4 and C5 run on the Windows host as additional evidence. INFRA-01C measured 1073 passed, 2 failed, 0 skipped there. The two failures are the Known_Baseline_Failure entries, both on the platform Windows and both in `client/src/components/ai/__tests__/messengerAI.test.tsx`: "a prepared rewrite replaces a draft only after review and confirmation, never sends it" and "draft changes invalidate a pending replacement instead of overwriting newer text". Any other Windows failure is reported and is not accepted as additional evidence. The Linux pass of the two tests is read from `client-jest.json` and noted.
      - The Known_Baseline_Failure names and platform found by the two runs are noted for the handoff (T-5B-06 creates the section and T-5B-39 records the list). No test is changed.
      - The 8 client attachment test files (76 tests) pass and are named in the note.
      - `git status --short` lists the same entries before and after the runs.
    - **Verify**: Validation_Runner group `client` (C4, C5); on the Windows host `npm test -- --runInBand` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB5-R15.10, DB5-R15.13, DB5-R15.14, ARCH-R03.9, COMP-06_

  - [x] 1.3 Add the baseline manifest recorder and `baseline-d7cd40a.json`
    - **ID**: T-5B-03
    - **Depends on**: T-5B-01, T-5B-02
    - **Affected modules**: `DATA/tests/support/record-baseline.js` (new; path chosen here), `DATA/tests/fixtures/baseline-d7cd40a.json` (new)
    - **Acceptance criteria**:
      - The script refuses to run, and writes nothing, unless `git diff --quiet d7cd40a HEAD -- DATA server/src shared client/src` shows no difference. HEAD is at or after the integration base dc6c997, which shares the functional baseline d7cd40aafcf8f432d17d3f4a85abb26d19fa9bc3 because PR #19 changed none of those paths, so a check of `git rev-parse HEAD` against d7cd40a would always refuse.
      - The manifest holds the SHA-256 of the LF-normalised text, read with `git show d7cd40a:<path>`, of the 29 baseline test files and 6 support files in `DATA/tests`, and for the seven DC-01 lines their file, line number and baseline text.
      - A second run on the same commit gives a byte-identical file.
    - **Verify**: `node tests/support/record-baseline.js` in DATA/, run twice; compare the file hash with `Get-FileHash` after each run
    - **Agent**: Kiro
    - _Requirements: DB5-R15.11, ARCH-R02.1_

  - [x] 1.4 Record the direct-message fixtures and add the baseline replay test
    - **ID**: T-5B-04
    - **Depends on**: T-5B-03
    - **Affected modules**: `DATA/tests/support/record-baseline.js` (extended), `DATA/tests/fixtures/direct-baseline-d7cd40a.json` (new), `DATA/tests/dm-fixtures-replay.test.js` (new)
    - **Acceptance criteria**:
      - Fixtures are recorded from the unchanged baseline code, behind the same guard as T-5B-03 and before any other code change of the phase, for direct send, history, receipts, lifecycle and key-directory routes. Each entry holds status, response fields and error code, with identifiers and timestamps masked.
      - `dm-fixtures-replay.test.js` replays the file against the current code on a temporary database and fails on any difference in status, fields or code. It never writes the fixture file.
    - **Verify**: `node --test tests/dm-fixtures-replay.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R02.3, ARCH-R02.4, DB5-R15.4_

  - [x] 1.5 Add `baseline-checksums.test.js` with the DC-01 guard
    - **ID**: T-5B-05
    - **Depends on**: T-5B-03, T-5B-04
    - **Property P-29: Published migrations are immutable (checksum clauses)**
    - **Validates: Requirements DB5-R14.2, DB5-R15.11**
    - **Affected modules**: `DATA/tests/baseline-checksums.test.js` (new)
    - **Acceptance criteria**:
      - The SHA-256 of the LF-normalised 0001 to 0007 equals the values pinned in the design and the checksum the runner records in a temporary database. A single-byte change in a temporary copy makes the runner refuse to start and change nothing.
      - Each baseline test and support file hashes to its immutable d7cd40a manifest value, except the seven DC-01 lines, which may differ only by appended migration file names or version numbers. A later, separate owner-approved exception accepts `DATA/tests/support/auth.js` only at SHA-256 `0d7996a8bef3be2703bfbb40dfe3c170efb3571a9bfdd6077832de2ef50bcc6f`, the exact test-fixture change from commit `85730dd442a570a0b4756847ce34f9300ecfb71f`; its original manifest hash `e9910b540e2078a34ff77763c95a00090a02a9d323fe239ecb40a96e69ac08d7` remains unchanged. Every other `auth.js` hash and every other baseline file remains subject to strict verification. Any unapproved difference fails and names file and line.
      - Test files absent from the manifest are scanned for `.skip(`, `.todo(`, `.only(`, `skip:` and `todo:`, and a hit fails the test.
      - The test reads only the manifest and files under `DATA/`, never git, so it runs unchanged in the Validation_Runner, which holds no `.git` (F29). It is never skipped.
    - **Verify**: `node --test tests/baseline-checksums.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 1.6 Create the handoff document skeleton
    - **ID**: T-5B-06
    - **Depends on**: T-5B-01, T-5B-02
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (new; file name chosen here)
    - **Acceptance criteria**:
      - The first paragraph is the one-way migration warning of the design (Error Handling, Operator view): a database migrated to 0008 or higher cannot start under code without that migration, and in the Docker_Environment the first start of an image that contains 0008 migrates the volume `sqlite-data` at once and permanently. The cold-backup precondition follows by reference to `docs/docker-development.md` (sections "Cold backup commands" and "Restore into new volumes first"), without copying them: stop every process that writes, archive both complete volume roots, restore only into fresh volumes, validate with `docker/database-check.cjs`. For a database file on a host it states a cold copy of `database.sqlite`, `-wal` and `-shm` taken with every connection closed. No backup helper or script is described (DK-06).
      - Sections exist for merged code, endpoint list, authorization rules and error codes, migration instructions and environment variables, test commands and results (with the baseline counts of T-5B-01 and T-5B-02), known gaps (open OD and OP items with defaults, the design's Not verified list), runtime statements, Gate_Record list, a "Decision log" for the DB-5A reconciliation, a "Known_Baseline_Failure" section (test name and platform) and a "Docker development environment" section.
      - The "Docker development environment" section covers: the two volumes `sqlite-data` and `private-storage`; migrate on start; the cold backup by reference to the guide sections; the Compose Watch rule (no watch while a migration file is a draft; `git status --short -- DATA/server/database/migrations` prints nothing before any `docker compose watch`); the Disposable_Project procedure and naming; the gate runner; and the rebuild rules (`DATA/docs`, `DATA/tests`, `DATA/scripts`, `client/authProxy.cjs`, `client/next.config.js`, any `package.json` or lockfile and any Dockerfile need `docker compose up --build -d`). It states that the proposed update of the section "Data and future migrations" of `docs/docker-development.md` (OP-18) is carried as text in the handoff and applied only after the Project_Owner approves it.
      - Runtime statements say the Standalone_Implementation host, identified by `server/api-main.cjs`, the script `npm run start:api` and the variable `API_PORT` and never by a port number alone, is not a supported runtime; `npm run start:data` is the only supported server; in the Docker_Environment port 3001 is the browser-facing address of the application and not of the Standalone_Implementation; approved code lives in `DATA/`, and `server/` keeps realtime and protocol code. The document also states that server-side visibility rules do not replace key-based confidentiality of Protected_Content.
    - **Verify**: C1 passes (`npm test` in DATA/ on the host for quick feedback; the Phase gate uses the runner); review against the design's Handoff checklist
    - **Agent**: Kiro
    - _Requirements: DB5-R13.8, DB5-R14.16, DB5-R14.20, DB5-R14.22, DB5-R14.23, DB5-R15.14, DB5-R08.11, ARCH-R01.9, ARCH-R03.8, COMP-10_

  - [x] 1.7 Record the DC-01 exception decision (OP-06)
    - **ID**: T-5B-07
    - **Depends on**: T-5B-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The decision log records, as decided by the Project_Owner in the DB-5A reconciliation (OP-06; no calendar date), that exactly seven migration-ledger assertions of baseline tests may change when a migration is added (0008 now, 0009 in DB-6B), in the same commit as the migration, with guard tests that fail on any other changed baseline line: `auth-migrations.test.js` line 24 (the applied list), `conversations-migrations.test.js` line 21, `e2ee-migrations.test.js` lines 12 and 29, `messaging-migrations.test.js` line 11, `migrations.test.js` line 14, `social-migrations.test.js` line 25.
      - The entry limits the amendment to appended file names or version numbers and names the guard: `baseline-checksums.test.js` (T-5B-05) fails on any other difference, and G5b lists only the seven lines. No acknowledgement is pending. T-5B-15 depends on this entry only so that the decision is on record before the first migration file exists.
    - **Verify**: Review of the decision-log entry against DB5-R15.11 and the design's DC-01 (no command applies)
    - **Agent**: Kiro
    - _Requirements: ARCH-R02.1, DB5-R15.11_

  - [x] 1.8 Record the history option set decision (OD-05) and the 0008 properties it fixes
    - **ID**: T-5B-08
    - **Depends on**: T-5B-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The decision log records, as decided by the Project_Owner in the DB-5A reconciliation (OD-05): the values are exactly `all` and `from_joined`, the default is `from_joined`, the policy is chosen at group creation (`POST /api/groups` with the optional field `historyPolicy`) and is immutable afterwards. It records the consequences marked "derived from OD-05, confirmed at the DB-5C API contract approval": `PATCH /api/groups/:id` never accepts `historyPolicy` (400 VALIDATION_ERROR naming it, no record changed), the idempotent create fingerprint includes the policy (an omitted value counts as `from_joined`), and the role matrix refuses a policy change for every role.
      - The entry fixes the three properties that `0008-groups.sql` must show for `GroupExtensions.history_policy`: `CHECK (history_policy IN ('all','from_joined'))`, the default `from_joined`, and immutability after insert through the trigger `group_extensions_update`. T-5B-15 creates them, case (i) of T-5B-17 tests them, and the Phase gate T-5B-37 confirms in the handoff that the file matches this entry.
    - **Verify**: Review of the decision-log entry against DB5-R01.14, DB5-R02.13 and DB5-R08.1 (no command applies)
    - **Agent**: Kiro
    - _Requirements: DB5-R01.14, DB5-R01.15, DB5-R02.13, DB5-R08.1, DB5-R08.2_

  - [x] 1.9 Implement the pure rules in `groups/policy.js`
    - **ID**: T-5B-09
    - **Depends on**: T-5B-05
    - **Affected modules**: `DATA/server/groups/policy.js` (new), `DATA/tests/groups-policy.test.js` (new)
    - **Acceptance criteria**:
      - `roleMatrix(role, action)`, `removalDecision(actorRole, targetRole)` (allow, forbidden or conflict), `transferDecision(...)`, `permittedRanges(intervals, policy)`, `inRanges(seq, ranges)` and `invitationRevalidation(state)` import no database, HTTP or clock module.
      - Example tests print the literal table of DB5-R06.13 with its OD flags and the ranges of DB5-R08.12, including an empty interval (`last_seq = first_seq - 1`) and an open interval. Admin removing an admin is forbidden, removing the owner is a conflict, and a transfer demotes the former owner to admin.
      - Under `all` the ranges add the sequences below the earliest interval's `first_seq`; under `from_joined` they do not.
      - The matrix row "Change History_Policy" is refused for the owner, the admin and the member (OD-05 decided: the policy is chosen at creation only), whether the group is archived or not.
      - `INVITATION_EXPIRY_SECONDS` is exported as the constant 604800 (7 days; OD-08 decided in part). It is not read from the environment, no setting overrides it, and an example test asserts the value 604800 and that `policy.js` reads no environment variable.
    - **Verify**: `node --test tests/groups-policy.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R06.13, DB5-R06.7, DB5-R06.8, DB5-R05.1, DB5-R05.3, DB5-R05.4, DB5-R08.1, DB5-R08.12, DB5-R04.1, DB5-R04.8_

  - [x] 1.10 Add the seeded generator `support/random.js`
    - **ID**: T-5B-10
    - **Depends on**: T-5B-09
    - **Affected modules**: `DATA/tests/support/random.js` (new), `DATA/tests/groups-policy.test.js`
    - **Acceptance criteria**:
      - `createRandom(seed)` is deterministic (a 32-bit generator such as mulberry32) and offers `int`, `bool`, `pick`, `weighted`, `shuffle`, `string`, `bytes` and `fork`. `forAll(id, {runs, seed}, generate, check)` derives each run seed from the base seed and the run index.
      - A failing run prints one line `property=<id> seed=<base> run=<index> runSeed=<n>` and the operation list. `PROPERTY_SEED` and `PROPERTY_RUN` replay one run.
      - A determinism check in `groups-policy.test.js` shows that one seed gives one sequence twice, and a static check shows the helper uses no `Math.random`, `Date.now` or network.
    - **Verify**: `node --test tests/groups-policy.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R15.6, NFR-07_

  - [x] 1.11 Add the migration lint helper and its test
    - **ID**: T-5B-11
    - **Depends on**: T-5B-10
    - **Property P-29: Published migrations are immutable (lint clauses)**
    - **Validates: Requirements DB5-R14.1, DB5-R14.5, DB5-R14.11**
    - **Affected modules**: `DATA/tests/support/migration-lint.js` (new), `DATA/tests/migration-lint.test.js` (new)
    - **Acceptance criteria**:
      - The linter strips comments, string literals and quoted identifiers, splits statements, ignores `CREATE [TEMP] TRIGGER ... BEGIN ... END` bodies (including `CASE ... END`), and reports BEGIN, COMMIT, ROLLBACK, VACUUM, ATTACH and PRAGMA outside trigger bodies, `ON DELETE CASCADE`, `SET NULL` and `SET DEFAULT` in 0008 and later, and file names outside `^\d{4}-[a-z0-9-]+\.sql$` or not contiguous.
      - It accepts 0001 to 0007 (the proof for DC-07) and rejects hand-written cases: each keyword alone, a keyword in a string or comment. It accepts the identifier `begin_at`.
      - For generated SQL texts it reports a violation exactly when a forbidden statement lies outside a trigger body.
    - **Verify**: `node --test tests/migration-lint.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 1.12 Implement the cursor codec in `groups/cursor.js`
    - **ID**: T-5B-12
    - **Depends on**: T-5B-10
    - **Property P-13: Cursor round trip**
    - **Validates: Requirements DB5-R02.5, DB5-R09.7**
    - **Affected modules**: `DATA/server/groups/cursor.js` (new), `DATA/tests/groups-pagination.test.js` (new; first created here, extended in DB-5C and DB-5D)
    - **Acceptance criteria**:
      - `encode(payload, context)` and `decode(token, context)` give base64url without padding, at most 2048 characters, deterministic. `decode` rejects with a typed error a token that is too long, not base64url, malformed, or bound to another user, route, conversation or filter digest.
      - For generated payloads (route kind, user id, conversation id or filter digest, ordering tuple, high-water 0 to 2^53 - 1, Unicode filter strings) `decode(encode(p, c), c)` equals `p` in at least 100 runs.
      - The codec is unsigned (OP-01 default). The file header says it rejects malformed and foreign-context cursors and makes no integrity claim for a well-formed altered payload.
    - **Verify**: `node --test tests/groups-pagination.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 1.13 Implement the validators in `groups/validation.js`
    - **ID**: T-5B-13
    - **Depends on**: T-5B-09, T-5B-12
    - **Affected modules**: `DATA/server/groups/validation.js` (new), `DATA/server/social/validation.js` (read-only, helpers reused), `DATA/tests/groups-policy.test.js`
    - **Acceptance criteria**:
      - Validators cover the create and patch bodies (name trimmed, 1 to 100 code points, well-formed Unicode without control characters; description null or at most 1000 code points with line breaks and tabs allowed, ASM-01; idempotency key 1 to 256 characters; unknown fields refused; `membershipRevision` precondition), the optional create field `historyPolicy` (exactly the string `all` or `from_joined`, case-sensitive; any other value, `null` included, fails and names `historyPolicy`; OD-05 decided), the patch rule that `historyPolicy` is never accepted whatever its value (a failure naming `historyPolicy`), path identifiers, list queries (`limit` 1 to 50 with default 20, `cursor`, unknown parameter refused), member and invitation bodies (`userId` only, a `role` field refused), role-change, transfer and read-position bodies.
      - A failure names the offending fields, each matching `^[a-zA-Z][a-zA-Z0-9]{0,63}$`. No validator throws on arbitrary input. Cursor failures report `cursor` through the T-5B-12 codec.
      - Example tests with no database or HTTP cover each validator at its limits.
    - **Verify**: `node --test tests/groups-policy.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R01.4, DB5-R01.5, DB5-R01.6, DB5-R01.7, DB5-R01.12, DB5-R01.15, DB5-R02.5, DB5-R02.6, DB5-R02.7, DB5-R02.10, DB5-R02.13, DB5-R02.14, DB5-R03.7, DB5-R06.4, DB5-R06.9, DB5-R10.4, DB5-R13.4_

  - [x] 1.14 Add the feature configuration skeleton in `features/config.js`
    - **ID**: T-5B-14
    - **Depends on**: T-5B-05
    - **Affected modules**: `DATA/server/features/config.js` (new), `DATA/tests/groups-gate.test.js` (new; first created here, extended from DB-5C)
    - **Acceptance criteria**:
      - The module exports a frozen `DISABLED_FEATURES` (`groupApi`, `groupMessaging`, `attachmentApi` all false, plus empty `groups` and `attachments` objects), a `FeatureConfigError` that carries setting names only, and a `loadFeatureConfig(env)` skeleton that reads `GROUPS_API_ENABLED`, `GROUP_MESSAGING_ENABLED` and `ATTACHMENTS_API_ENABLED` and treats a switch as on only for the exact string `true`.
      - The module declares the Group_API companion settings as a frozen list of names with no default: `GROUP_MAX_MEMBERS` (required; the approved value is 50, supplied as configuration, and the code carries no default; OD-04 decided), `GROUP_MAX_PENDING_INVITATIONS_PER_GROUP` and `GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE` (required, no default; OD-08 unresolved). There is no invitation expiry setting: the expiry is the fixed constant `INVITATION_EXPIRY_SECONDS` of `groups/policy.js` (604,800 s; OD-08 decided in part), `GROUP_INVITATION_TTL_SECONDS` does not exist, is never read and is never named by an error, and no setting exists for a re-invite delay.
      - Value validation of the companion settings (positive whole numbers), `features/gate.js` and all wiring wait for DB-5C (T-5C-01). `app.js` and `start.js` are not edited.
      - Example tests cover unset, `true`, `TRUE`, `1`, empty and spaces, a frozen result, and the start-failure message of `FeatureConfigError`: for each declared setting the message names that setting and no value, a message built for the three Group_API settings names exactly those three, and no message or export contains `GROUP_INVITATION_TTL_SECONDS`.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.1, DB5-R16.5, DB5-R16.7, DB5-R04.1_

  - [x] 1.15 Add migration `0008-groups.sql` (DDL) and amend the seven DC-01 literals
    - **ID**: T-5B-15
    - **Depends on**: T-5B-05, T-5B-07, T-5B-08, T-5B-11
    - **Affected modules**: `DATA/server/database/migrations/0008-groups.sql` (new), `DATA/tests/auth-migrations.test.js` (line 24 literal only), `DATA/tests/conversations-migrations.test.js` (line 21 only), `DATA/tests/e2ee-migrations.test.js` (lines 12 and 29 only), `DATA/tests/messaging-migrations.test.js` (line 11 only), `DATA/tests/migrations.test.js` (line 14 only), `DATA/tests/social-migrations.test.js` (line 25 only)
    - **Acceptance criteria**:
      - 0008 creates `GroupExtensions`, `GroupMembershipIntervals`, `ConversationInvitations`, `GroupReadPositions` and `GroupCreationKeys` with their indexes and triggers as in the design's DDL, including `uq_invitations_pending`, `uq_group_intervals_open` and the `*_keep` triggers. Every new foreign key is `ON DELETE RESTRICT` and every new table has at least one (DC-06). It has no `IF NOT EXISTS`, no BEGIN, COMMIT, ROLLBACK, VACUUM, ATTACH or PRAGMA outside trigger bodies, no `group_id` on Messages and no table that duplicates a canonical one.
      - `GroupExtensions` is the only storage of the description, the History_Policy and the Membership_Revision (the name stays in `Conversations.title`; DB5-R02.1). `history_policy` keeps `CHECK (history_policy IN ('all','from_joined'))` and the default `from_joined`, and is immutable after insert: `history_policy` is in the column list and in the condition of the trigger `group_extensions_update`, so an UPDATE that assigns a different value aborts for an archived and an unarchived group alike, and an UPDATE that assigns the stored value passes (OD-05 decided; DB5-R08.1).
      - The seven literals gain `0008-groups.sql` or version 8 in this same change set. `baseline-checksums` and `migration-lint` pass, and G5b prints only those seven lines.
      - The 321 baseline tests, `schema.test.js` included, pass without further edits.
      - While the file is a draft (present and not committed) no `docker compose watch` runs for any project that holds data to keep, and no application container is started by this task (DB5-R14.22). `git status --short -- DATA/server/database/migrations` is read before any watch.
    - **Verify**: C1 passes (`node --test` in DATA/ on the host for quick feedback; the Phase gate uses the runner); G1; G5b
    - **Agent**: Kiro
    - _Requirements: DB5-R14.1, DB5-R14.3, DB5-R14.5, DB5-R14.11, DB5-R14.12, DB5-R14.22, DB5-R02.1, DB5-R04.2, DB5-R08.1, DB5-R08.3, DB5-R08.4, DB5-R10.1, DB5-R09.15, DB5-R01.14, ARCH-R01.11, ARCH-R02.1_

  - [x] 1.16 Add the 0008 backfill and its upgrade example test
    - **ID**: T-5B-16
    - **Depends on**: T-5B-15
    - **Affected modules**: `DATA/server/database/migrations/0008-groups.sql`, `DATA/tests/groups-migrations.test.js` (new)
    - **Acceptance criteria**:
      - Two `INSERT ... SELECT` statements add one `GroupExtensions` row (`from_joined`, revision 1, description NULL, `created_at` copied) for every group conversation of any origin, and one interval per existing member. `first_seq` is the lowest `message_seq` of an authenticated message created at or after `joined_at`, otherwise the highest sequence plus 1. For a member with `left_at`, `last_seq` is the highest sequence created at or before `left_at`, otherwise `first_seq - 1`. Active members get an open interval.
      - The backfill only inserts: each `GroupExtensions` row is inserted once with `from_joined` and never updated, so the immutability of `history_policy` (`group_extensions_update`) is not involved and the value stays fixed afterwards.
      - An example test builds a version-7 database from a temporary copy of 0001 to 0007 holding a populated group with former members, upgrades it, shows that every backfilled extension row holds `from_joined`, and shows that no member reads a message created before joining.
      - No statement reads or writes direct conversations, messages, receipts, key rows, social rows or attachments except to compute sequences.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R14.13, DB5-R14.7, DB5-R08.3, COMP-03_

  - [x] 1.17 Add the structural migration cases (a), (c), (d), (g), (h), (i) and the one-way check
    - **ID**: T-5B-17
    - **Depends on**: T-5B-16
    - **Affected modules**: `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - Fresh database: one ledger row per file in order with a 64-hex checksum, empty `foreign_key_check`, `integrity_check` ok. The expected version comes from the directory listing, not a literal. A repeat run applies zero migrations and leaves ledger and rows identical.
      - A copy of 0008 with a failing statement in a temporary directory gives `MIGRATION_FAILED` that names the file and no path, and leaves schema, ledger and rows unchanged. Every new foreign key reports `RESTRICT`.
      - `EXPLAIN QUERY PLAN` of the direct history statements (kept as literals) is identical at version 7 and at the latest version (NFR-04). A latest-version database opened with a directory of only 0001 to 0007 gives `MIGRATION_HISTORY_MISMATCH` and changes nothing.
      - Case (i), `history_policy` immutability, on a latest-version database: a direct UPDATE of `GroupExtensions.history_policy` from `from_joined` to `all`, and from `all` to `from_joined`, is aborted by `group_extensions_update` and leaves the row unchanged; an UPDATE of `description` on the same row succeeds; an INSERT with a value outside `all` and `from_joined` fails the CHECK; every backfilled row holds `from_joined`; a value set at insert persists.
      - A static scan fails if DATA opens or imports the standalone database or `server/src/db5db6`.
      - Every case runs on a temporary database that the test creates and removes, and none starts a container. The tests never open `DATA/server/database/database.sqlite` or any file under `/var/lib/secubuzz/`.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R14.6, DB5-R14.9, DB5-R14.10, DB5-R14.11, DB5-R14.16, DB5-R14.17, DB5-R14.19, DB5-R14.21, DB5-R11.2, DB5-R02.13, DB5-R08.1, ARCH-R01.10, NFR-04_

  - [x] 1.18 Write property test P-27 for upgrade from version 7
    - **ID**: T-5B-18
    - **Depends on**: T-5B-17, T-5B-10
    - **Property P-27: Upgrade from version 7 keeps every row and matches a fresh schema**
    - **Validates: Requirements DB5-R14.3, DB5-R14.6, DB5-R14.7, DB5-R14.8, DB5-R14.11, DB5-R14.13, DB5-R09.15, DB5-R08.3, ARCH-R01.11, ARCH-R02.5, COMP-03**
    - **Affected modules**: `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - For 100 generated version-7 databases (0 to 5 users, 0 to 4 groups, 0 to 30 messages each, legacy rows included) the upgrade keeps every pre-existing column value of every version-7 table, including Messages, MessageReceipts, DeviceKeys, ConversationKeyEpochs and ConversationKeyWraps (row-by-row digest).
      - The upgraded schema equals a fresh database (tables, columns with type, nullability and default, indexes, triggers including the text of `group_extensions_update`, foreign keys); `foreign_key_check` is empty; each group has one extension record and backfilled intervals; Messages has no `group_id`.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro

    - **Verified checkpoint (Codex, 2026-11-21)**: the existing P-27 ran all 100 cases (seed 27118; 5955 pre-existing rows) and every preservation, schema, backfill and foreign-key assertion passed. The focused Windows DATA run passed 177 tests, 0 failed/skipped/cancelled/todo. Evidence: `docker/artifacts/db5b-1-23-recovery/final-tests.log`. This is task-level synthetic verification, not the later Validation_Runner phase gate.

  - [x] 1.19 Write property test P-28 for repeat runs and failing batches
    - **ID**: T-5B-19
    - **Depends on**: T-5B-18
    - **Property P-28: Repeat runs change nothing and a failing batch rolls back completely**
    - **Validates: Requirements DB5-R11.2, DB5-R14.9, DB5-R14.10, DB5-R15.7**
    - **Affected modules**: `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - Running the runner n times on a populated latest-version database applies zero migrations and leaves `SchemaMigrations` and every row byte-identical.
      - A generated failing statement (syntax, constraint or foreign key) at a random position of a copy of 0008 in a temporary directory gives `MIGRATION_FAILED` that names the file and no path, and schema, ledger and rows equal their earlier state.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro

    - **Verified checkpoint (Codex, 2026-11-21)**: three executable P-28 tests added to DATA/tests/groups-migrations.test.js. Seed 28119 runs 100 repeat cases over 200 populated fresh/upgraded databases, checking all schema objects, ledger rows and typed row digests after each of 668 repeat calls and 200 restarts. Fresh fixtures populate all five new tables; upgraded fixtures reuse P-27's generator. Another 100 generated cases execute 300 syntax/CHECK/foreign-key failures across all 41 top-level insertion boundaries of a temporary copy of 0008. Six first/last-boundary cases start at version 6 and prove pending 0007 and 0008 roll back together. Transaction callbacks witness DDL, a probe row and a changed existing user before each fault; complete state equality, ended transaction, integrity, foreign keys and reopen-without-migration confirm durable rollback, followed by successful application of the unmodified migrations. Focused run: 3/3 passed. Relevant migration/hardening/lint/checksum run: 70/70 passed, including the three new tests and P-27's 100 cases; the attempted negative selector also included P-28, whose second successful result is retained. Both runs have 0 failed/skipped/cancelled/todo. Local ignored evidence: docker/artifacts/db5b-1-19/. Only the test file and this task's marker/checkpoint changed; migrations, transaction guards, feature gates and unrelated work preserved. Synthetic temporary databases only; no Docker or persistent database access. Task 1.39 was not started.

  - [x] 1.20 Make the two additive edits to `repositories.js` and add `audit-metadata.test.js`
    - **ID**: T-5B-20
    - **Depends on**: T-5B-05
    - **Affected modules**: `DATA/server/database/repositories.js` (two additive edits), `DATA/tests/audit-metadata.test.js` (new)
    - **Acceptance criteria**:
      - The `allowed` list of `audit.insert` gains `target_id` and `role`, both checked by `^[a-zA-Z0-9_.:-]{1,64}$`, and `translate` is exported. No other line of the file changes.
      - Keys such as `password`, `prompt`, `ciphertext` and a `reason_code` with spaces are still rejected, and `repositories.test.js` passes unedited.
      - `audit-metadata.test.js` accepts the new keys with valid values and rejects values with spaces, quotes, path separators or more than 64 characters. This is the allow-list clause of P-30; the full property lands in T-5C-40.
    - **Verify**: `node --test tests/audit-metadata.test.js tests/repositories.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R12.8, DB5-R13.5, ARCH-R01.6, NFR-06_

  - [x] 1.21 Add `support/groups.js` and the helper tests
    - **ID**: T-5B-21
    - **Depends on**: T-5B-15, T-5B-10
    - **Affected modules**: `DATA/tests/support/groups.js` (new), `DATA/tests/groups-repository.test.js` (new)
    - **Acceptance criteria**:
      - `snapshot(db)` returns the SHA-256 of each table of the P-21 list that exists at the current version (rows ordered by primary key, columns sorted) and a total, leaves out `AuthRateLimits`, and a completeness check fails when `sqlite_master` holds a table created by 0008 or 0009 that the list lacks.
      - The helper offers a group fixture (users, groups and members through the repository), the actor classes (unauthenticated, non-member, pending invitee, member, admin, owner, removed member), `assertSecurityHeaders` and a path guard that refuses a path whose real path is outside `os.tmpdir()` or lies under `/var/lib/secubuzz/` (the volumes of a Docker_Environment project).
      - A static check fails when a new test file or helper contains the literal `database.sqlite` outside the guard helper.
    - **Verify**: `node --test tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R15.1, DB5-R15.2, DB5-R11.6, DB5-R14.17, NFR-07, NFR-08_

  - [x] 1.22 Create the Group_Repository core in `groupRepository.js`
    - **ID**: T-5B-22
    - **Depends on**: T-5B-15, T-5B-20, T-5B-21
    - **Affected modules**: `DATA/server/database/groupRepository.js` (new), `DATA/tests/groups-repository.test.js`
    - **Acceptance criteria**:
      - `createGroupRepository(db)` composes `createRepositories(db)` as `socialRepository.js` does. Write functions throw `TypeError` unless `db.inTransaction`. Every state-changing update is a compare-and-set that throws `CONFLICT` unless exactly one row changed.
      - Errors are normalised once: unique or primary key to `DUPLICATE`, trigger to `CONFLICT`, check to `INVALID`, foreign key to `REFERENCE`, busy to `BUSY`, cannot-open, I/O, disk-full and read-only to a new `UNAVAILABLE` class (OP-09), otherwise `DATABASE`. No driver text, constraint name or trigger name reaches an error message. The CI-12 difference with `translate()` is noted for the handoff.
      - Static scans fail when group SQL occurs outside `groupRepository.js` or a `prepare` call interpolates a value. `/api/groups` answers 404 for every method while `DATA/server/routes/groups.js` is absent, and `/api/attachments` and `/api/files` do the same while `DATA/server/routes/attachments.js` is absent. The test is keyed to file existence, so no later edit is needed. `app.js` is unchanged.
    - **Verify**: `node --test tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R14.14, DB5-R13.5, DB5-R11.5, ARCH-R01.6, ARCH-R01.8, NFR-01_

  - [x] 1.23 Add the direct-SQL constraint tests for 0008
    - **ID**: T-5B-23
    - **Depends on**: T-5B-22
    - **Affected modules**: `DATA/tests/groups-repository.test.js`
    - **Acceptance criteria**:
      - Each direct SQL attempt is rejected with a constraint error and leaves the rows unchanged: a second pending Invitation for one group and invitee, a second open interval, an overlapping or non-contiguous interval, an edit or delete of a closed interval, a transition out of a terminal Invitation state or a change of its identity columns, a delete of any retained row, a second Read_Position row, a decreasing position, a revision step other than +1, a change of `GroupExtensions.history_policy` in either direction (the trigger `group_extensions_update`; a same-value UPDATE and an UPDATE of `description` pass), and a `GroupExtensions` row for a direct conversation.
      - The active-owner index `uq_members_active_owner` rejects a second active owner.
    - **Verify**: `node --test tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R14.12, DB5-R04.2, DB5-R04.17, DB5-R06.2, DB5-R07.6, DB5-R08.1, DB5-R08.3, DB5-R08.4, DB5-R10.1, DB5-R10.2, DB5-R02.13_

    - **Verified Option A checkpoint (Codex, 2026-11-21)**: draft 0008 now rejects append-after-open intervals and replacement collisions, including explicit rowid paths, without relying on implicit DELETE triggers. `groups-hardening.test.js` executes 32 cases with recursive triggers OFF/ON and foreign keys ON, including valid UPSERT and lifecycle paths. Initial draft: 18/30 regressions failed; additional rowid coverage: 2/32 failed before its fix. Final focused run: 177/177 passed. A second open interval now maps from the trigger to CONFLICT instead of the former unique-index DUPLICATE; ordinary duplicate keys stay DUPLICATE. No repository mapper or public API contract changed. Evidence remains under `docker/artifacts/db5b-1-23-recovery/`; full phase gate is still pending.

  - [x] 1.24 Add the Group_Repository read functions
    - **ID**: T-5B-24
    - **Depends on**: T-5B-22
    - **Affected modules**: `DATA/server/database/groupRepository.js`, `DATA/tests/groups-repository.test.js`
    - **Acceptance criteria**:
      - `getVisibleGroup(id)` returns a group only for `kind='group' AND origin='authenticated'` with a `GroupExtensions` row, and null for a direct conversation, a legacy-origin group or a group without an extension record (DB5-R14.18).
      - `getMember`, `countActiveMembers`, `listGroupsForUser(actor, {limit, after})` (ordered `updated_at DESC, conversation_id DESC`, with role, member count and unread count), `listMembers(id, {limit, after, former})` (active by open-interval `joined_at, user_id`; former by `left_at, user_id`), `getCreationKey` and `invariantReport(id)` (active owners, active members, open intervals, mismatches) exist.
      - `EXPLAIN QUERY PLAN` of the list statements uses an index and does not scan Messages or ConversationMembers in full (NFR-03).
    - **Verify**: `node --test tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R02.3, DB5-R02.4, DB5-R03.1, DB5-R03.2, DB5-R06.2, DB5-R10.5, DB5-R14.18, NFR-03_

    - **Verified checkpoint (Codex, 2026-11-21)**: seven read functions implemented; eight Task 1.24 cases pass. Focused repository, Option A hardening, baseline-checksum and direct-message replay run: 88 passed, 0 failed/skipped/cancelled/todo. Query plans use existing indexes without full Messages or ConversationMembers scans. Internal lists return limit+1 raw rows for service pagination; after accepts the ordering tuple or decoded last tuple. Migration hashes 0001?0008 and previous checkpoints are unchanged. All execution used disposable synthetic databases; no Docker/volume or feature-gate changes. Evidence: `docker/artifacts/db5b-1-24/regressions.log`. Tasks 1.25 onward remain pending.

  - [x] 1.25 Add the membership and interval write functions
    - **ID**: T-5B-25
    - **Depends on**: T-5B-24
    - **Affected modules**: `DATA/server/database/groupRepository.js`, `DATA/tests/groups-repository.test.js`
    - **Acceptance criteria**:
      - `addMember`, `reactivateMember` (`WHERE left_at IS NOT NULL`, role member), `endMembership` (`WHERE left_at IS NULL AND role <> 'owner'`), `changeRole`, `transferOwnership` (demote first, then promote), `openIntervalAt` (`firstSeq = highWater + 1`) and `closeInterval` (`lastSeq = highWater`) exist.
      - A stale expectation throws `CONFLICT`, a write outside a transaction throws `TypeError`, and `ConversationMembers.joined_at` is never rewritten by a rejoin.
      - Owner-approved paired-operation contract (2026-11-21): membership and interval primitives may temporarily differ inside one coordinated transaction. After the paired writes and before COMMIT, mandatory `invariantReport` validation shows exactly one active owner, exactly one open interval per active member and none per former member; any failure rolls back the complete transaction. Standalone primitive calls cannot commit an invalid final state or expose partial operations outside the transaction; immediate SQLite constraints and migration 0008 hardening remain in force. The internal `withMembershipTransaction(db, work)` boundary owns the outer immediate transaction, rejects ambient/nested transactions and asynchronous work, and automatically validates all groups touched by these primitives before returning to the driver's COMMIT. This clarifies design.md's Group_Service/groupWrite and Concurrency boundary; service authentication and API work remain in their later tasks.
    - **Verify**: `node --test tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R03.13, DB5-R05.1, DB5-R05.6, DB5-R05.9, DB5-R05.10, DB5-R06.3, DB5-R06.7, DB5-R08.3, DB5-R08.4_

    - **Verified checkpoint (Codex, 2026-11-21)**: owner-approved paired-operation boundary enforced by `withMembershipTransaction`; all seven primitives reject ordinary standalone transactions. Mandatory validation of every touched group runs after synchronous work and before COMMIT; failed validation rolls back the whole transaction, including otherwise successful writes. Eight new boundary cases cover incomplete operations, caught second-write failures, mandatory validation, validation failure, missing owners, multiple repository instances/groups, second-connection isolation, and async/ambient/nested rejection. Existing 98 focused checks plus these eight: 106 passed, 0 failed/skipped/cancelled/todo. All execution used disposable synthetic SQLite databases. Migrations 0001-0008 and unrelated files are unchanged; no persistent database, Docker volume, feature-gate or public API changes. Evidence: `docker/artifacts/db5b-1-25-contract/regressions.log`. Task 1.26 and later remain pending.

  - [x] 1.26 Add the group-level write functions
    - **ID**: T-5B-26
    - **Depends on**: T-5B-25
    - **Affected modules**: `DATA/server/database/groupRepository.js`, `DATA/tests/groups-repository.test.js`
    - **Acceptance criteria**:
      - `insertGroup` calls `repositories.conversations.create({kind:'group', origin:'authenticated', created_by})`, then writes the `GroupExtensions` row (revision 1; the supplied History_Policy or, when none is supplied, `from_joined`; description NULL when none is supplied) and the creator's first interval. The extension row is the only storage of the description, the policy and the revision (DB5-R02.1). `updateSettings` writes the title to `Conversations` and the description to `GroupExtensions`, and never writes `history_policy`: the policy is set at insert only (OD-05 decided).
      - Repository tests show that `insertGroup` stores the supplied `all` or `from_joined` and the default `from_joined` when none is supplied, that a value outside the two fails with the `INVALID` class and creates no row, that `updateSettings` leaves `history_policy` unchanged, and that no function of the repository issues an UPDATE of that column (a scan of the prepared statement texts). Direct UPDATE attempts are covered by T-5B-23.
      - `archiveGroup` is a compare-and-set on `archived_at IS NULL`. `bumpRevision` adds exactly 1 and returns the new value. `touchConversation` updates `updated_at`. `claimCreationKey` inserts, or replaces only a row older than 24 hours.
      - A rolled-back transaction leaves no trace of any of these writes.
    - **Verify**: `node --test tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R01.2, DB5-R01.10, DB5-R01.14, DB5-R02.1, DB5-R02.9, DB5-R02.13, DB5-R03.14, DB5-R07.1, DB5-R08.1, DB5-R08.2, DB5-R11.5_

    - **Verified checkpoint (Codex, 2026-11-21)**: `insertGroup`, `updateSettings`, `archiveGroup`, `touchConversation` and `claimCreationKey` implemented; the existing exact +1 `bumpRevision` is preserved. Creation composes the conversation/owner repository and registers the completed new group for mandatory validation by the approved `withMembershipTransaction` boundary. Settings never update `history_policy`. Key renewal uses explicit conditional DELETE then INSERT within one savepoint because 0008 makes key rows immutable; only a row strictly older than 24 hours can be renewed. Live collisions, including exactly 24 hours, retain the existing primary-key DUPLICATE class; no public API contract changes. Fifteen new cases pass. Repository, Option A hardening, published-checksum and direct-message replay checks: 121 passed, 0 failed/skipped/cancelled/todo (the prior 106 plus 15 new). Two strengthened assertions for failed settings and existing-key preservation also pass their targeted rerun. All databases were disposable and synthetic; migrations 0001-0008, the approved Task 1.25 boundary, feature gates and unrelated work are unchanged. Evidence: `docker/artifacts/db5b-1-26/regressions.log` and `review-checks.log` in that directory. Task 1.27 and later remain pending.

  - [x] 1.27 Add the Invitation functions
    - **ID**: T-5B-27
    - **Depends on**: T-5B-26
    - **Affected modules**: `DATA/server/database/groupRepository.js`, `DATA/tests/groups-repository.test.js`
    - **Acceptance criteria**:
      - `getInvitation`, `findPending`, `countPendingForGroup(id, nowIso)`, `countPendingForInvitee(user, nowIso)` (counts exclude rows past expiry), `listPendingForInvitee`, `listPendingForGroup` and `closedIntervalSince(id, user, sinceIso)` exist.
      - `insertInvitation`, `resolveInvitation(id, to, at)` (compare-and-set on `state='pending'`), `cancelPendingFor(id, user, at)` (both directions, returns the count) and `expirePast(id, invitee, nowIso)` exist. A row that left pending never changes.
      - Examples show that a past-expiry row is not counted, that `expirePast` lets a new pending row be inserted, and that a second pending row for one pair fails with `DUPLICATE`.
    - **Verify**: `node --test tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R04.2, DB5-R04.6, DB5-R04.8, DB5-R04.12, DB5-R04.15, DB5-R04.17, DB5-R04.19, DB5-R04.20_

    - **Verified checkpoint (Codex, 2026-11-21)**: seven invitation reads and four guarded writes implemented with bound SQL and existing read/write/savepoint/CAS patterns. Lookups retain expired pending rows for lazy expiry; counts and lists exclude rows at or after expiry. Lists return limit+1 rows ordered by creation time and invitation id descending; own-list projections add only group name and inviter display name. Insertions use the fixed seven-day expiry (an explicitly supplied expiry must agree); duplicate pending rows retain DUPLICATE. Resolution is pending-only, cancellation covers both directions and returns its count, and expiry permits a new pending row at the exact expiry boundary. Fifteen new tests cover transitions, retained history, expiry boundaries, pagination, namespace isolation, invalid input, mid-batch rollback, coordinated membership rollback and second-connection isolation. Repository, Option A hardening, published-checksum and direct-message replay run: 136 passed, 0 failed/skipped/cancelled/todo (the prior 121 plus 15 new). All databases were disposable and synthetic. Migrations 0001-0008, the approved transaction boundary, feature gates, existing tests and unrelated work are unchanged. No service authorization, invitation-limit defaults or public API contracts were added or changed. Evidence: `docker/artifacts/db5b-1-27/focused.log` and `regressions.log` in that directory. Task 1.28 and later remain pending.

  - [x] 1.28 Add the history and read-state functions
    - **ID**: T-5B-28
    - **Depends on**: T-5B-26
    - **Affected modules**: `DATA/server/database/groupRepository.js`, `DATA/tests/groups-repository.test.js`
    - **Acceptance criteria**:
      - `intervalsFor`, `openInterval`, `historyPage(id, user, {policy, limit, highWater, before})` (permitted ranges and page selection in one query), `getPermittedMessage`, `unreadCount`, `getReadPosition` and `upsertReadPosition` (`ON CONFLICT DO UPDATE SET position = max(...)`, returns the stored value) exist.
      - A page holds the requested size while that many permitted messages remain; empty permitted ranges give an empty page without a cursor; a lower position report leaves the stored value unchanged.
      - `EXPLAIN QUERY PLAN` shows `idx_messages_authenticated_history` for the history statement and no full scan of Messages (NFR-03).
    - **Verify**: `node --test tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R08.5, DB5-R08.8, DB5-R08.12, DB5-R08.13, DB5-R08.14, DB5-R09.6, DB5-R10.1, DB5-R10.2, DB5-R10.3, DB5-R10.5, NFR-03_

    - **Verified checkpoint (Codex, 2026-11-21)**: all seven history/read-state functions implemented with existing read/write/savepoint guards. History applies membership ranges before LIMIT in one SQL query, returns limit+1 raw rows for service pagination, and respects supplied high-water and exclusive before bounds. Both policies retain earlier membership intervals and exclude absence gaps; a policy argument cannot override the stored policy. History and single-message retrieval retain permitted tombstones; unread counts exclude tombstones, own sends and legacy rows. Former/non-members receive no history or stored read-position disclosure. Internal interval metadata remains retained. `getReadPosition` returns the stored integer or 0; `upsertReadPosition` validates active membership, high-water and permitted ranges, returns the stored maximum and preserves the row/timestamp on equal or lower valid reports. Fifteen new tests pass. Focused repository, Option A hardening, published-checksum and direct-message replay checks: 151 passed, 0 failed/skipped/cancelled/todo (prior 136 plus 15 new). Three strengthened cases for both-policy unread counts, timestamps and actual cross-group message isolation also pass their targeted rerun. EXPLAIN QUERY PLAN uses `idx_messages_authenticated_history` without a full Messages scan. Savepoint/outer rollback, mandatory membership validation and serialized cross-connection reports are verified. All databases were disposable and synthetic; migrations 0001-0008, approved transaction guards, prior tests, feature gates and unrelated work are unchanged. Evidence: `docker/artifacts/db5b-1-28/focused.log`, `regressions.log` and `review-checks.log` in that directory. Task 1.29 and later remain pending.

  - [x] 1.29 Write property test P-11 for permitted history ranges and the AF-14 regression
    - **ID**: T-5B-29
    - **Depends on**: T-5B-28, T-5B-09, T-5B-10
    - **Property P-11: Permitted ranges decide history exactly**
    - **Owner-approved oracle scope (2026-11-21)**: apply the range oracle only to currently active, authorized members under the stored history policy and approved visibility boundaries. Former members and never-members receive no history, even when retained closed intervals have nonempty ranges. Rejoined members retain earlier permitted intervals and never gain absence-gap history. This clarifies P-11 in design.md without changing production authorization.
    - **Validates: Requirements DB5-R08.1, DB5-R08.5, DB5-R08.6, DB5-R08.7, DB5-R08.8, DB5-R08.12, DB5-R08.13, DB5-R08.14, DB5-R09.6**
    - **Affected modules**: `DATA/tests/groups-history.test.js` (new)
    - **Acceptance criteria**:
      - For generated intervals (0 to 5, disjoint, ordered, empty and open ones, bounds biased to 0, 1, N and `first_seq - 1`), both policies, streams of 0 to 200 messages with tombstones and page sizes 1 to 50, a full traversal of `historyPage` returns exactly the sequences with `inRanges(s, permittedRanges(intervals, policy))`, in at least 100 runs.
      - `getPermittedMessage` finds a message exactly when the same predicate holds, and the result does not change when other members' intervals, senders or `created_at` values change.
      - Test `AF-14: a rejoin keeps the earlier interval and does not rewrite joined_at` runs the design scenario at repository level: reads are 3, 4 and 7 under `from_joined`, also 1 and 2 under `all`, never 5 or 6.
    - **Verify**: `node --test tests/groups-history.test.js` in DATA/
    - **Agent**: Kiro

    - **Verified checkpoint (Codex, 2026-11-21)**: owner-approved authorization scope clarified here and in design.md's P-11 row. New `groups-history.test.js` reuses the guarded disposable database, clock, seeded property runner and pure range oracle. P-11 seed 5129 passes 100 cases, 200 policy cases and 400 original/metamorphic datasets: active 42, removed 41, never-member 17, rejoined 33, with empty intervals in 69 cases. Coverage includes 0-5 intervals, 0/1/200-message boundaries, tombstones, 1-50 page sizes, high-water/before boundaries and complete traversal. Replicas change other-member intervals, senders and timestamp ordering without changing visible sequences. Single-message retrieval, unread counts, monotonic read positions and denied removed/never-member reports agree with the approved scope. The literal AF-14 regression passes both policies: 3/4/7 under from_joined, additionally 1/2 under all, never 5/6; original joined_at, closed interval and read position are retained. Focused file: 2 passed, 0 failed; directly relevant repository, hardening, checksum, direct-message, policy and pagination regressions: 191 passed, 0 failed/skipped/cancelled/todo. Production code, migrations 0001-0008, existing tests, feature gates and unrelated work are unchanged. No persistent database or Docker-volume access. Evidence: `docker/artifacts/db5b-1-29/focused.log` and `regressions.log` in that directory. Task 1.30 and later remain pending.

  - [x] 1.30 Write property test P-32 at repository level
    - **ID**: T-5B-30
    - **Depends on**: T-5B-27, T-5B-28, T-5B-10
    - **Property P-32: Stop and start on the same file changes nothing (repository level)**
    - **Validates: Requirements DB5-R11.1, DB5-R11.2, DB5-R11.4, DB5-R11.5**
    - **Affected modules**: `DATA/tests/groups-restart.test.js` (new)
    - **Acceptance criteria**:
      - For 20 generated sequences of repository operations (groups, members, roles, Invitations, intervals, read positions, revisions, messages), closing the database and reopening it with `openDatabase({filename})` gives identical repository projections, and the second open applies zero migrations.
      - An immediate transaction that is closed without commit leaves no trace. An Invitation past `expires_at` during the stop is not counted as pending.
      - Every test runs in a new temporary directory and never opens `DATA/server/database/database.sqlite`.
    - **Verify**: `node --test tests/groups-restart.test.js` in DATA/
    - **Agent**: Kiro

    - **Verified checkpoint (Codex, 2026-11-21)**: dependencies T-5B-10, T-5B-27 and T-5B-28 verified complete. New `groups-restart.test.js` passes P-32 seed 5130: 20 generated sequences, 39 operations each (780 total) across 14 categories, with both history policies. Reopening each guarded synthetic file through the real `openDatabase({filename})` path yields zero connection changes and identical migration ledger, schema, table snapshots and repository projections (groups, active/former memberships, intervals, roles, Invitations, history/single-message visibility, read positions, unread counts, revisions and creation keys). Separate tests verify rollback of an uncommitted immediate transaction and a closed approved membership transaction, plus expiry at the exact boundary and one millisecond later during downtime. Lazy expiry remains read-only on reopen; subsequent expiry prevents a pending-only acceptance and creates no membership. Focused results: 4 passed, 0 failed. Directly relevant repository/hardening/checksum regressions: 148 passed; targeted fresh/repeat migration and AF-14 regressions: 3 passed; all 151 regression checks have 0 failures/skips/cancellations/todo. Successful P-11 and P-27 generated suites were not rerun. Production code, existing tests, migrations 0001-0008, transaction guards, history authorization, feature gates and unrelated work are unchanged. No persistent database or Docker-volume access. Evidence: `docker/artifacts/db5b-1-30/focused.log`, `regressions.log` and `restart-regressions.log` in that directory. API and process-kill variants remain assigned to later phases by the spec; Task 1.31 and later remain pending.

  - [x] 1.31 Write property test P-19 with populated groups
    - **ID**: T-5B-31
    - **Depends on**: T-5B-04, T-5B-26, T-5B-27, T-5B-10, T-5B-21
    - **Property P-19: Direct conversations and messages are unchanged by groups**
    - **Validates: Requirements DB5-R02.8, DB5-R09.16, DB5-R14.18, DB5-R15.4, ARCH-R02.2, ARCH-R02.3, ARCH-R02.4, COMP-06**
    - **Affected modules**: `DATA/tests/dm-fixtures-replay.test.js`
    - **Acceptance criteria**:
      - For 10 to 30 generated populations built through the repositories (direct conversations and groups of both origins in any membership state, archived or not, pending Invitations, messages), `GET /api/conversations` returns only direct conversations with two participants and the exact key set parsed by `client/src/security/e2ee/api.ts`, never a group identifier.
      - Every group identifier sent to an existing direct route answers 404, a direct identifier sent to `/api/groups/...` answers 404 while the router is unmounted, and the snapshot of all tables is unchanged.
      - The baseline fixture replay gives the recorded status, fields and code on the populated databases.
    - **Verify**: `node --test tests/dm-fixtures-replay.test.js` in DATA/
    - **Agent**: Kiro

    - **Verified checkpoint (Codex, 2026-11-21)**: prerequisites T-5B-04, T-5B-26, T-5B-27, T-5B-10 and T-5B-21 verified complete. P-19 seed 5131 passes 10 generated populations, each with 8 groups and 3-6 users; both replay scenarios run 5 times, comparing 685 recorded entries without changing their statuses, fields, codes or masking. Populations cover both group origins, both managed history policies, active/removed/rejoined/pending membership, archived/unarchived and missing-extension groups, pending/terminal Invitations, authenticated/legacy/tombstoned messages and synthetic attachment metadata. Additional direct rows cover authenticated/legacy origins, archive and missing-credential boundaries. Direct lists paginate and match the exact key sets read from client/src/security/e2ee/api.ts, with exactly two correct participants and no group ids. Group conversation/message storage ids are refused by direct conversation, message, lifecycle and key routes; direct ids on unmounted group routes receive 404. Every denied request preserves hashes of every SQLite table, including auth/session/limiter/ledger tables; successful baseline replay preserves every group-domain row. A minimal optional test-only populate hook was added to the existing replay helper; default scenarios and the frozen fixture bytes remain unchanged. Full replay file: 14 passed, 0 failed; directly relevant baseline/repository/hardening/direct-conversation HTTP regressions: 177 passed, 0 failed/skipped/cancelled/todo. All databases were guarded disposable synthetic fixtures; production code, migrations 0001-0008, feature gates, existing test assertions and unrelated work are unchanged. No persistent database or Docker-volume access. Evidence: `docker/artifacts/db5b-1-31/focused.log` and `regressions.log` in that directory. Task 1.32 was already complete; Task 1.33 and later remain pending.

  - [x] 1.32 Create the Standalone_Implementation test inventory
    - **ID**: T-5B-32
    - **Depends on**: T-5B-06
    - **Affected modules**: `DATA/docs/standalone-inventory.md` (new; file name chosen here)
    - **Acceptance criteria**:
      - The inventory lists at least the streaming size-limited write, the role checks, the history-visibility query, the soft delete, the restart persistence tests, the 14 server tests (`server/test/db5_db6.test.cjs`, `server/test/integration/attachments.test.ts`) and the 76 client attachment tests with the exact paths of their 8 files. Each entry has exactly one disposition (reuse as is, adapt, replace or retire), a non-empty reason and at least one requirement ID, plus the planned canonical replacement file from the design table.
      - The `Messages` rebuild with `group_id` and the standalone attachment table are marked retired. The original author and source file of each artifact marked reuse as is or adapt are recorded, read from `git log`.
      - No standalone file changes: G2 prints nothing.
    - **Verify**: G2; review against the design's inventory table
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.1, ARCH-R03.2, ARCH-R03.3, ARCH-R03.7, ARCH-R03.10, DB5-R15.12_

  - [x] 1.33 Update `schema.md`, `migrations.md` and `repositories.md`
    - **ID**: T-5B-33
    - **Depends on**: T-5B-16, T-5B-28
    - **Affected modules**: `DATA/docs/schema.md`, `DATA/docs/migrations.md`, `DATA/docs/repositories.md`, `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - `schema.md` and `migrations.md` list version 8, the file name `0008-groups.sql`, every table, index and trigger it adds (the trigger `group_extensions_update` with the immutable `history_policy` included) and the backfill rule. `migrations.md` states the one-way warning: a database migrated to 0008 or higher cannot start under code without that migration, because the runner rejects extra ledger rows.
      - `migrations.md` states the precondition of running the Migration_Runner on an existing database: a cold backup taken while no process has the database open. For a database on the volumes of a Docker_Environment project it cites the cold-backup procedure of `docs/docker-development.md` (sections "Cold backup commands" and "Restore into new volumes first"; cited, not copied), which archives both complete volume roots. For a database file on a host it states a cold copy of `database.sqlite`, `-wal` and `-shm` taken with every connection closed. It adds the Docker text: the first start of an image that contains 0008 migrates `sqlite-data` at once and permanently, a failed migration stops startup, and Compose Watch is not used while a migration file is a draft. Rollback is a restore into fresh volumes (COMP-05). No backup helper or script is documented or referenced (DK-06).
      - `repositories.md` gets additions only: the two `repositories.js` edits and the Group_Repository functions. `docs/docker-development.md` is not edited by this task.
      - A documentation test in `groups-migrations.test.js` fails when an object created by 0008 or a migration file name is missing from `schema.md` or `migrations.md`, or when the one-way sentence or the cold-backup citation is missing.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R14.15, DB5-R14.16, DB5-R14.20, DB5-R14.22, DB5-R14.23, COMP-05, COMP-10_

    - **Verified checkpoint (Codex, 2026-11-21)**: dependencies T-5B-16 and T-5B-28 verified complete. Schema/migration guides now list version 8, all migration filenames and all 38 named 0008 objects (5 tables, 7 indexes, 26 triggers), including hardening and immutable history policy, plus the conservative timestamp-normalized backfill. Operations text requires a cold backup with every connection closed, names host file/companions, cites both unchanged Docker-guide backup/restore sections and both complete volume roots, and states permanent first-start migration, failed-start behavior, one-way ledger rejection, fresh-volume rollback and the draft Watch prohibition. No backup script is introduced. Repository documentation is additions-only and covers the two base edits, all implemented group functions, approved transaction/history boundaries, error mapping and unchanged E2EE/key/realtime contracts. Four focused documentation tests pass, including 92 object/filename omission checks and warning/citation/script mutations. The migration run passed all 16 checks, including P-27's 100 cases (5955 version-7 rows); the selector also included that property, so its result is retained as additional evidence. The initial repository run caught a prohibited literal in the new prose validator (147 passed, 1 failed); the filename is now assembled only as a documentation token, the guard is unchanged, and the final rerun passes 148/148 with 0 failures/skips/cancellations/todo. An incidental indentation edit was restored; all original test bytes remain an exact prefix. Overall: 4 new tests and 160 existing regression checks verified. Production code, migrations 0001-0008, feature gates, frozen fixtures, docs/docker-development.md and unrelated work are unchanged. All databases were disposable and synthetic; no persistent database or Docker-volume access. Evidence: `docker/artifacts/db5b-1-33/` (red, final-documentation, migration-regressions, initial repository-regressions and final-repository-regressions logs). Task 1.36 is the next pending task and was not started.

  T-5B-34 dropped by the owner (DK-06, DB-5A reconciliation); the ID is never reused.

  - [x] 1.35 Prepare synthetic migration fixtures or an isolated cold-backup copy
    - **ID**: T-5B-35
    - **Depends on**: T-5B-16
    - **Affected modules**: `DATA/tests/fixtures/` (synthetic `.json` or `.txt` fixture files, only if a fixture is committed); none for a cold-backup copy (it is restored into fresh volumes of a Disposable_Project and nothing is added to the repository)
    - **Acceptance criteria**:
      - Synthetic fixtures are the default evidence of T-5B-36: a populated version-7 data set (legacy and authenticated direct conversations, messages, key rows, social rows, attachments, and groups with active and former members and messages) that the test helpers build in memory or under `os.tmpdir()` at run time, or that is committed only as `.json` or `.txt` files whose names avoid the `.dockerignore` names and extensions. A database file (`.db`, `.sqlite`, `.sqlite3` or their `-wal`, `-shm` and `-journal` forms) is never committed.
      - If the Project_Owner has made a cold backup of both volumes with the documented procedure (every writer stopped, both complete volume roots archived by `docs/docker-development.md`), a copy of those archives is restored only into fresh volumes of a Disposable_Project (the guide section "Restore into new volumes first", with the image of the revision that took the backup). No task hands over, opens, mounts, archives or copies the real development database, `DATA/server/database/database.sqlite` or the volumes of the running project.
      - If the owner supplies no backup, the synthetic fixtures are the evidence and nothing is skipped. The handoff states which input was used.
    - **Verify**: `git status --short -- DATA/tests/fixtures` lists only intended `.json` or `.txt` files, and G7 prints nothing; for a restored backup, the project name matches `^secubuzz-disposable-[0-9a-f]{8}$` and `docker compose -p <project> -f compose.yaml -f <override> config | Select-String 'published'` prints nothing
    - **Agent**: Kiro
    - _Requirements: DB5-R14.7, DB5-R14.13, DB5-R14.20, DB5-R14.21, DB5-R14.23, DB5-R14.24_

  - [x] 1.36 Validate migration 0008 and the backfill on the fixtures or the isolated copy in a Disposable_Project
    - **ID**: T-5B-36
    - **Depends on**: T-5B-35, T-5B-33
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (result note)
    - **Acceptance criteria**:
      - A Disposable_Project is created for this task only (name `secubuzz-disposable-` plus 8 hexadecimal characters, explicit `-p`, own volumes, no published port through a temporary override file outside the repository; no repository file is edited). The image built from the working tree (0008 included) starts on fresh volumes that hold the synthetic fixture database or the restored copy of T-5B-35 (`up -d --wait --wait-timeout 180`); a synthetic version-7 database built under `os.tmpdir()` is archived and restored into the fresh `sqlite-data` volume by the commands of the guide section "Restore into new volumes first". The start applies 0008 on open. No Compose Watch runs while 0008 is a draft.
      - The project becomes healthy and `docker compose logs backend` shows no migration failure. The check `docker/database-check.cjs` (run as the guide's restore step runs it, with the new image) reports `integrity_check` ok, an empty `foreign_key_check` and a ledger equal to the migration files. Row counts of every pre-existing table equal before and after. The rehearsal adds its own counts of the new tables (one extension row per group, one interval per member) and does not edit the helper.
      - The timestamp format found in `ConversationMembers.joined_at` and `Messages.created_at` is recorded (CI-29). A format other than the ISO form assumed by the backfill is reported with its effect on interval boundaries.
      - The time from `up` to healthy and the time of the 0008 backfill on the fixture are recorded and compared with the backend start period of 40 s and its 6 health retries of 10 s (R-21). A backfill that could exceed that window on a populated volume is reported as a finding.
      - `docker compose -p <project> down -v` runs once, only after the name matches the prefix, and the override file is removed. The live database, the volumes of the running project and `DATA/server/database/database.sqlite` are never opened, mounted or archived. The result note shows the project name, the input used and the counts.
    - **Verify**: the Disposable_Project commands of the design's Docker section (PowerShell): `docker compose -p $project -f compose.yaml -f $override config | Select-String 'published'` prints nothing; `docker compose -p $project -f compose.yaml -f $override up -d --wait --wait-timeout 180`; the database check against `${project}_sqlite-data`; `down -v` only inside `if ($project -match '^secubuzz-disposable-[0-9a-f]{8}$')`
    - **Agent**: Kiro
    - _Requirements: DB5-R14.7, DB5-R14.13, DB5-R14.21, DB5-R14.22, DB5-R14.24, COMP-03, COMP-10_

    - **Verified checkpoint (Codex, 2026-11-21)**: T-5B-33 and T-5B-35 complete; T-5B-34 dropped by DK-06. Owner-approved synthetic-only rehearsal in `secubuzz-disposable-7ff8793e`, with fresh owned volumes, an override outside the repository, no published ports and no Watch. Seed 5136 version-7 input was archived/restored before actual startup applied only 0008. Both services healthy in 20.0942418 s; migration runner 11.459622 ms, SQL 2.807993 ms, backfill 0.588281 ms, within the 40 s start period plus 6 retries at 10 s. Unchanged database checker: integrity ok, zero foreign-key violations, ledger 1-8. All values/counts in 21 existing application tables and the first seven ledger rows unchanged; 3 extension and 14 interval rows verified field-for-field; other three new tables empty. Mixed ISO/SQLite-space timestamps recorded, with normalized first_seq 5 versus unsafe text-order 1 in the boundary case. Focused Linux checks 9/9 passed (4 fixture, 5 migration), with no failures/skips. Ownership and exclusive resource use verified before the single explicit-project down -v; zero project containers/volumes/networks/images remained, and the temporary override was removed. Existing application resources were never accessed; migrations 0001-0008, feature gates and unrelated work preserved. Full counts, timing method, resolved harness issues, scale limitation and local ignored evidence are in DATA/docs/db5-db6-handoff.md, Task 1.36 result note. No later task started.

  - [x] 1.37 Record the DB-5A reconciliation decision log in the handoff
    - **ID**: T-5B-38
    - **Depends on**: T-5B-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (section "Decision log")
    - **Acceptance criteria**:
      - The decision log records the decisions approved by the Project_Owner in the DB-5A reconciliation, without calendar dates and each with the criteria that apply it: OD-01 in part (direct add stays disabled and answers 503 FEATURE_UNAVAILABLE; membership starts only through an accepted Invitation; whether friendship with the inviter is required stays open, with the default of no friendship rule beyond blocks), OD-04 (50 active members, supplied as the required setting `GROUP_MAX_MEMBERS`, fail-closed while unset), OD-08 in part (the Invitation expiry is fixed at 7 days = 604,800 s and is not an environment setting; the two pending-Invitation maxima and any re-invite delay stay unresolved with no default) and DK-01 to DK-07 (the T-5B-34 backup helper is dropped and its ID is never reused). The entries of OD-05 (T-5B-08) and OP-06 (T-5B-07) are listed by pointer and are not duplicated.
      - The log lists the four amendments awaiting owner approval: OA-01 (CI-02, OP-05; approval at DB-6A), OA-02 (CI-03, OP-03; DB-6A), OA-03 (CI-10, OP-13; DB-6E) and OA-04 (CI-11, OP-12; DB-5F and DB-6E for the marker, DB-6F for the records). It states that the requirement text is unchanged and that the provisional defaults apply until each approval.
      - The log carries the open decisions list with the provisional default of each: the OD-01 friendship sub-question, OD-02, OD-03, OD-06, OD-07, OD-08 (the two maxima and the re-invite delay), OD-09 to OD-21, OP-01 to OP-05 and OP-07 to OP-20. OP-01, OP-07 and OP-09 are marked provisional (recommended by Kiro, not approved by the Project_Owner) and reported. The approval of the reconciled specification set (CI-31) is noted with its reference.
    - **Verify**: Review against the requirements sections "Decisions recorded in the DB-5A reconciliation" and "Amendments awaiting owner approval at their phase" and the design's "Decisions recorded in the DB-5A reconciliation" (no command applies)
    - **Agent**: Kiro
    - _Requirements: COMP-10, DB5-R15.14_

  - [x] 1.38 Record the Known_Baseline_Failure list and the gate-runner procedure, and run G7, G8 and G9
    - **ID**: T-5B-39
    - **Depends on**: T-5B-01, T-5B-02, T-5B-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (sections "Known_Baseline_Failure" and "Test commands and results")
    - **Acceptance criteria**:
      - The section "Known_Baseline_Failure" lists exactly two entries by test name and platform (Windows), both in `client/src/components/ai/__tests__/messengerAI.test.tsx`: "a prepared rewrite replaces a draft only after review and confirmation, never sends it" and "draft changes invalidate a pending replacement instead of overwriting newer text". It records the Linux pass of the two tests, read from `client-jest.json` of the T-5B-02 run with the read-out of the design (Testing Strategy, "Known_Baseline_Failure handling"). It states the rules: the entries are never skipped, edited, excluded or silenced; any other failing test fails the gate, in the runner and on the Windows host; a new entry exists only by a recorded Project_Owner decision; a retry of a failed file does not clear the failure, and the first result and the retry result are both recorded.
      - The section "Test commands and results" records the gate-runner procedure: build the Validation_Runner once per gate run, run the groups `data`, `server` and `client` with their own evidence directories under the ignored `docker/artifacts/`, what each run records (command and group, counts, date, `git rev-parse HEAD`, `git status --short`), and when a run is not evidence (results file missing, test count 0 or below the baseline, image build guards failed, `validate.cjs` exits non-zero for a reason other than a recorded Known_Baseline_Failure). It also records the INFRA-01C comparison numbers.
      - G7, G8 and G9 run once at the repository root on the tree as it stands at the start of the phase (the three preserved entries and the spec folder). The handoff records that G7 and G8 print nothing and G9 exits 0, with the date and `git rev-parse HEAD`. Any G7 or G8 output, or a non-zero G9, is reported and stops the phase.
    - **Verify**: G7; G8; G9 (PowerShell, repository root; G7 and G8 print nothing, G9 exits 0)
    - **Agent**: Kiro
    - _Requirements: DB5-R15.10, DB5-R15.14, DB5-R15.15, DB5-R15.16_

  - [x] 1.39 Phase gate DB-5B
    - **ID**: T-5B-37
    - **Depends on**: T-5B-01 to T-5B-33, T-5B-35, T-5B-36, T-5B-38, T-5B-39
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - C1 to C5 run in the Validation_Runner (the gate of record) on the final tree, and each result is recorded with command and group, passed, failed and skipped counts, date, `git rev-parse HEAD` and `git status --short`. C1 passes (at least 321 plus the new tests, 0 failed, 0 skipped, 0 cancelled, 0 todo). C2 and C5 exit 0, and the lint and `build:verify` steps of the client group exit 0. C3 and C4 show 0 failed and 0 skipped with at least the counts of T-5B-01 and T-5B-02 (INFRA-01C: 547 and 1075 on Linux). The same C1 to C5 run on the Windows host as additional evidence and are recorded beside the runner results: C1 and C3 pass, and C4 fails exactly the two Known_Baseline_Failure entries and nothing else.
      - G1 to G9 run at the repository root: G1, G2, G4, G6 and G9 exit 0; G3, G5a, G7 and G8 print nothing; G5b prints only the seven DC-01 lines; and `git diff --stat dc6c997 -- server client` lists only the seven owner-approved client files (and no server file): `client/jest.config.js`, `client/jest.setup.js`, `client/tsconfig.json`, `client/src/app/friends.test.tsx`, `client/src/app/page.test.tsx`, `client/src/realtime/__tests__/workspaceRealtime.test.tsx` and `client/src/voice/__tests__/voiceWorkspace.test.tsx` (amendment approved by the Project_Owner; no assertion or production change).
      - Migration cases (a) to (i), the one-way check, the unmounted-prefix 404 test and the fixture replay pass. No `/api/groups`, `/api/attachments` or `/api/files` route exists, and `git diff d7cd40a -- DATA/server/app.js` shows no change.
      - The handoff records each run, the C1 run time, the defaults applied (OP-01 unsigned codec, OP-07 iteration constants at the top of each test file, OP-09 `UNAVAILABLE` class), CI-12, the result of the Disposable_Project rehearsal of T-5B-36 (input used, timestamp format, backfill time) and the Known_Baseline_Failure list with the Linux pass of the two tests. The decision-log entries of T-5B-07, T-5B-08 and T-5B-38 are present, and the handoff states that `0008-groups.sql` matches them (OP-06: seven literals only; OD-05: CHECK `all` and `from_joined`, default `from_joined`, immutable after insert). No Gate_Record applies to DB-5B.
      - No application container is started by the gate. The Disposable_Project of T-5B-36 is removed, and no repository Docker file, `compose.yaml` or `docs/docker-development.md` is changed, except the owner-approved COMP-10 exception: `.dockerignore` and `docker/validation.Dockerfile` may change only to copy `docs/docker-development.md` into the validation image (handoff, Docker section and decision log).
    - **Verify**: C1 to C5 in the Validation_Runner (groups `data`, `server`, `client`); G1; G2; G3; G4; G5a; G5b; G6; G7; G8; G9; `git diff --stat dc6c997 -- server client`; `git diff d7cd40a -- DATA/server/app.js`
    - **Agent**: Kiro
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R15.16, ARCH-R02.1, COMP-01, COMP-10_

- [ ] 2. DB-5C: group management, membership, roles and invitations over `/api/groups`
  **Entry criteria.** DB-5B exit met (T-5B-37). OP-01 answered or defaulted (T-5B-12). No decision blocks coding. Decided in the DB-5A reconciliation: OD-05 (the History_Policy, `all` or `from_joined`, is chosen at creation through G01 and is immutable; G04 refuses `historyPolicy` with 400), OD-04 (50 active members, but `GROUP_MAX_MEMBERS` stays a required setting with no default in code), OD-08 in part (the Invitation expiry is the fixed constant 604,800 s, not a setting) and OD-01 in part (direct add stays disabled and answers 503). Still open and recorded by T-5C-49 before GROUP-MANAGEMENT can be approved: the two pending-Invitation maxima (`GROUP_MAX_PENDING_INVITATIONS_PER_GROUP`, `GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE`; no default) and any re-invite delay (OD-08), and the OD-01 friendship sub-question (default: no friendship rule beyond blocks). Defaults in force: OD-02, OD-03, OD-06, OD-07, OD-09 (no delete or unarchive route), OD-10 (the owner cannot leave), OD-11, OP-11, OP-17 (PUT counts as a mutation), OP-18 (no edit of `docs/docker-development.md` before approval; T-5C-54) and OP-19 (per-source limits configurable, no trust of forwarded headers). No frontend work and no group message routes (G18 to G25) in this phase. Docker: the gate of record is the Validation_Runner (the Windows host run is additional evidence); no application container is started; Compose Watch stays off while a migration file is a draft; no Docker file is edited (COMP-10).

  - [x] 2.1 Complete `features/config.js` for the group switches and settings
    - **ID**: T-5C-01
    - **Depends on**: T-5B-37
    - **Affected modules**: `DATA/server/features/config.js`, `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - With `GROUPS_API_ENABLED=true`, `loadFeatureConfig` requires three settings as positive whole numbers: `GROUP_MAX_MEMBERS` (approved value 50, OD-04 decided; required, with no default in code, so an unset or invalid value still stops the start), `GROUP_MAX_PENDING_INVITATIONS_PER_GROUP` and `GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE` (OD-08, unresolved, no default). Otherwise it throws `FeatureConfigError` naming exactly the missing or invalid settings among those three and no value. A valid result is frozen. `GROUP_MESSAGING_ENABLED` needs no numeric setting.
      - There is no setting `GROUP_INVITATION_TTL_SECONDS`: the Invitation expiry is the fixed constant `INVITATION_EXPIRY_SECONDS` = 604,800 s of `groups/policy.js` (OD-08 decided in part). A test sets that variable in the environment as a distractor and shows that it is not read, not required and never named by a start failure.
      - With `NODE_ENV=production`, a switch that is on also needs `GROUPS_API_GATE_RECORD` or `GROUP_MESSAGING_GATE_RECORD` matching `GR-[A-Z0-9-]{3,48}` (OP-11, format check only).
      - An injected `features` object `{groupApi, groupMessaging, attachmentApi, groups: {...}, attachments: {...}}` is plain per-app data. `groups.maxMembers` is read from it (a test that does not exercise the limit injects 50, the approved value; a test of the maximum itself injects a smaller one), and the two pending maxima have no approved value, so every test that needs them injects its own. `groups.directAdd` (off by default; OD-01 decided in part: direct add stays disabled; flag name chosen here, no environment variable) enables direct add in tests only.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.1, DB5-R16.5, DB5-R16.7, DB5-R16.8, DB5-R03.6, DB5-R03.12, DB5-R04.1, DB5-R04.18_

  - [x] 2.2 Implement `features/gate.js`
    - **ID**: T-5C-02
    - **Depends on**: T-5C-01
    - **Affected modules**: `DATA/server/features/gate.js` (new), `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - `createFeatureGate(config)` offers `status()` returning exactly `{groupApi, groupMessaging, attachmentApi}` with `groupMessaging` true only while `groupApi` is true, `assertEnabled(name)` that throws a 503 `FEATURE_UNAVAILABLE` `AuthError` with empty `fields`, and `middleware(name)` that answers 503 before any rate-limit write or group read.
      - Two application instances in one test keep separate gate state. Without an injected `features` object the default is `DISABLED_FEATURES`.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.1, DB5-R16.2, DB5-R16.4, DB5-R16.5, DB5-R16.13_

  - [x] 2.3 Build the Group_Service infrastructure in `groups/service.js`
    - **ID**: T-5C-03
    - **Depends on**: T-5C-02, T-5B-27, T-5B-28
    - **Affected modules**: `DATA/server/groups/service.js` (new), `DATA/tests/groups-model.test.js` (new)
    - **Acceptance criteria**:
      - `createGroupService({db, auth, limiter, features, now})` composes `createSocialRepository(db)` and `createGroupRepository(db)` and offers `groupRead`, `groupWrite` (session check, CSRF session proof as `conversations.write` does, immediate transaction, synchronous `work`, `assertGroupInvariants` before commit with exactly one active owner and one open interval per active member, otherwise rollback and 500), `visibleGroup` and `requireRole`.
      - One `notFound()` gives the identical 404 for an unknown id, a direct conversation, a legacy-origin group, a group without extension record and a non-member. One mapping turns repository classes into `AuthError`: `DUPLICATE` and `CONFLICT` to 409, `INVALID` and `REFERENCE` to 400, `BUSY` and `UNAVAILABLE` to 503, anything else to 500, with no database text.
      - The audit helper writes one `AuditLogs` row (`source: 'groups'`, `subject_id` the group id, allowed keys only) and rethrows a failed insert as 500 `INTERNAL_ERROR` so the transaction rolls back. The rate-limit numbers of ASM-03 sit in one module as named constants that an options argument of `createGroupService` can override (the per-source numbers are configurable, OP-19; no environment variable is added without the Project_Owner's decision, and nothing trusts a forwarded header).
    - **Verify**: `node --test tests/groups-model.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R12.1, DB5-R12.5, DB5-R12.6, DB5-R12.8, DB5-R12.9, DB5-R13.5, DB5-R02.3, DB5-R06.2, NFR-01_

  - [x] 2.4 Add the router skeleton in `routes/groups.js` and mount it in `createApp`
    - **ID**: T-5C-04
    - **Depends on**: T-5C-03, T-5B-13
    - **Affected modules**: `DATA/server/routes/groups.js` (new), `DATA/server/app.js` (mount and returned members only), `DATA/tests/groups-http.test.js` (new)
    - **Acceptance criteria**:
      - Middleware order: existing Origin check, `requireAuth`, `GET /feature-status` (read bucket, no gate), `requireCsrf` for every method except GET and HEAD, gate, rate limit (separate per-user and per-source read buckets for GET and HEAD and mutation buckets for every other method, PUT included; OP-17 default), body handling (`Content-Length` above 8192 gives 413 `PAYLOAD_TOO_LARGE`; a body whose content type is not JSON gives 400, except that a request the body parser fails on for its content encoding or charset, for example `Content-Encoding: gzip` or `charset=utf-7`, keeps the existing 415 `UNSUPPORTED_MEDIA_TYPE`, DB5-R12.11; `express.json({strict: true, inflate: false})`), a frozen route table, and a final 404 that also answers `DELETE /api/groups/:id`. Fixed routes are registered before `/:id`. Example tests in `groups-http.test.js` show the 400 for a non-JSON content type and the 415 for an encoding or charset failure.
      - `createApp` takes `features` (default `DISABLED_FEATURES`), mounts the router after `/api/messages` and before the legacy 503 stub, and returns `groups` and `features`. Existing mounts and response shapes stay unchanged (COMP-02). With every switch off each route except feature-status answers 503. The router never reads `AUTH_MIDDLEWARE_MODULE`.
      - Every response carries no-store and nosniff.
    - **Verify**: `node --test tests/groups-http.test.js tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R01.3, ARCH-R01.4, ARCH-R01.5, DB5-R12.1, DB5-R12.2, DB5-R12.3, DB5-R12.4, DB5-R12.10, DB5-R12.11, DB5-R12.12, DB5-R12.14, DB5-R13.2, DB5-R16.2, DB5-R16.13, DB5-R07.5, NFR-08_

  - [x] 2.5 Load the feature configuration at start-up
    - **ID**: T-5C-05
    - **Depends on**: T-5C-04
    - **Affected modules**: `DATA/server/start.js`, `DATA/server.js`, `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - `startServer` calls `loadFeatureConfig(process.env)` before `openDatabase`, so a configuration error never triggers a migration. An injected `features` object skips the load. Switch variables other than the exact string `true` give a start-up line per switch showing off.
      - With a switch on and a required setting missing, the process exits with code 1 before listening and prints one stderr line that names every offending setting and no value. A `MIGRATION_FAILED` error prints its code and message (the file name, never the cause or a path).
      - A child process of `server.js` with the Group_API switch on and one setting missing exits 1, names the setting on stderr and leaves the database file unmigrated. The line names only settings that exist (`GROUP_MAX_MEMBERS` and the two pending maxima), never `GROUP_INVITATION_TTL_SECONDS`. The child runs on a temporary database file in a new directory under `os.tmpdir()`, never on `DATA/server/database/database.sqlite` or a Docker volume (DB5-R14.17), and the test runs in the Validation_Runner group `data` as well as on the host.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.7, DB5-R14.10, DB5-R14.17, DB5-R13.3, ARCH-R01.10_

  - [x] 2.6 Check the start path of `server/src/data/main.ts`
    - **ID**: T-5C-06
    - **Depends on**: T-5C-05
    - **Affected modules**: `server/src/data/main.ts` (read in full; edited only if its start-failure output drops setting names or the migration error)
    - **Acceptance criteria**:
      - The file is read in full and its output for a `FeatureConfigError` and a `MIGRATION_FAILED` start failure is recorded in the handoff.
      - If it hides the setting names or the migration file name, a minimal change prints the same one line as `DATA/server.js` (names of existing settings only, never values). No other file of `server/src/data` changes in this task. This is the start path of the Docker_Environment backend (`docker/run.cjs backend` runs `npm --prefix server run start:data`), where the operator reads the line with `docker compose logs backend`; the shipped `compose.yaml` sets no switch, so a project started from it never meets a configuration failure. No container is started by this task.
      - The seven files of `server/test/data` pass unchanged.
    - **Verify**: C2 and C3 (`npm run type-check` and `npm test` in server/; Validation_Runner group `server`, with the host run for quick feedback); G6
    - **Agent**: Kiro
    - _Requirements: DB5-R16.7, DB5-R14.10, ARCH-R01.10, COMP-10_

  - [x] 2.7 Implement group creation (G01)
    - **ID**: T-5C-07
    - **Depends on**: T-5C-04
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - `POST /api/groups` accepts `{name, description?, historyPolicy?, idempotencyKey?}` and no other field. It writes the Conversations row (the name in `Conversations.title`), the creator's owner row, the `GroupExtensions` row (revision 1, the supplied History_Policy or, when `historyPolicy` is absent, `from_joined`, description null if absent; the description, the policy and the revision are stored only there, DB5-R02.1), the first interval and the audit row `group.created` in one immediate transaction, and answers 201 `{group}` with the stored `historyPolicy`. A failure leaves none of them. The audit `metadata_json` holds only the allowed keys, never a name, description or policy value.
      - `historyPolicy` is optional and is exactly the string `all` or `from_joined` (case-sensitive). Any other supplied value, `null` included, answers 400 `VALIDATION_ERROR` with `historyPolicy` in `fields` and creates no row (OD-05 decided; derived from OD-05, confirmed at the DB-5C API contract approval).
      - Same user, key and payload within 24 hours answers 200 with the original group and creates no second group. The payload is the fingerprint `sha256(JSON.stringify(["secubuzz-group-create-v2", trimmedName, description ?? null, historyPolicy]))` with an omitted policy replaced by `from_joined` before hashing, so the policy is part of it and the label is v2 (a key claimed before the change never matches). Another payload with the key, a different policy included, gives 409 `IDEMPOTENCY_CONFLICT`. A key older than 24 hours (injected clock) is replaced. Concurrent requests with one key create one group.
      - A missing, empty or non-object body, an unknown field, a bad name, description, policy or key gives 400 with the field names and never 500. Creation limits of 20 per hour per user and 60 per hour per source give 429 with `Retry-After`.
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R01.1, DB5-R01.2, DB5-R01.3, DB5-R01.4, DB5-R01.5, DB5-R01.6, DB5-R01.7, DB5-R01.8, DB5-R01.9, DB5-R01.10, DB5-R01.11, DB5-R01.12, DB5-R01.13, DB5-R01.14, DB5-R01.15, DB5-R02.1, DB5-R08.1, DB5-R08.2_

  - [x] 2.8 Implement group listing and retrieval (G02, G03)
    - **ID**: T-5C-08
    - **Depends on**: T-5C-07
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - `GET /api/groups?limit&cursor` returns only groups of which the requester is an Active_Member (archived included), ordered `updated_at DESC, conversation_id DESC`, each with role, member count and `unreadCount`. `limit` is 1 to 50 with default 20, the cursor is bound to user and route, and the last page has no cursor. A bad limit, cursor or unknown parameter gives 400 naming it.
      - `GET /api/groups/:id` returns `{id, name, description, historyPolicy, membershipRevision, archived, createdAt, updatedAt, memberCount, role}`. The projection reads the name from `Conversations.title` and the description, the History_Policy and the revision only from the `GroupExtensions` record (DB5-R02.1), and `updatedAt` from `Conversations.updated_at`; a test shows that no other table or column supplies those fields. The 404 is identical for an unknown id, a direct conversation, a legacy-origin group, a group without extension record and a non-member.
      - `GET /api/conversations` still returns no group.
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R02.1, DB5-R02.2, DB5-R02.3, DB5-R02.4, DB5-R02.5, DB5-R02.6, DB5-R02.7, DB5-R02.8, DB5-R10.5, DB5-R14.18_

  - [x] 2.9 Implement group update (G04)
    - **ID**: T-5C-09
    - **Depends on**: T-5C-08
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - The owner's `PATCH /api/groups/:id` updates name and description in one transaction with audit `group.updated` and answers 200 `{group}`. A member gets 403, a non-member 404, an archived group 409, and no record changes on a refusal.
      - Refusal order is the DB5-R02.15 order: Auth_Layer checks, 404 and 403, archived 409, body 400 (criteria 10 and 14), `historyPolicy` 400 (criterion 13), stale revision 409. The route never accepts `historyPolicy`: any request that contains it, with any value (the stored one, `null` and a valid name or description beside it included), answers 400 `VALIDATION_ERROR` with `historyPolicy` in `fields` and changes no row (OD-05 decided: chosen at creation, immutable afterwards; derived from OD-05, confirmed at the DB-5C API contract approval). The 503 of the provisional behavior is gone. A member or admin reaches the 403, a non-member the 404 and the owner of an archived group the 409 before that 400, as the order says. A `membershipRevision` that differs from the stored value gives 409 `STALE_STATE`.
      - Repeating a patch with the same values is a no-op update and bumps no revision.
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R02.9, DB5-R02.10, DB5-R02.11, DB5-R02.12, DB5-R02.13, DB5-R02.14, DB5-R02.15, DB5-R07.2_

  - [x] 2.10 Implement the member list (G05)
    - **ID**: T-5C-10
    - **Depends on**: T-5C-08
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - `GET /api/groups/:id/members` returns Active_Members as `{id, username, displayName, avatar, role, joinedAt}` (joined time of the current interval), ordered by joined time then user id, paged like G02. No e-mail, session, device key or credential data appears.
      - With `former=true` an owner or admin also gets former members with `leftAt`. A requester with role member gets 403 and no member data. A non-member gets the uniform 404.
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R03.1, DB5-R03.2, DB5-R03.3, DB5-R03.4, DB5-R03.15_

  - [x] 2.11 Implement Invitation creation and the manager list (G12, G13)
    - **ID**: T-5C-11
    - **Depends on**: T-5C-10
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-invitations.test.js` (new)
    - **Acceptance criteria**:
      - `POST /api/groups/:id/invitations` with `{userId}` only creates a pending Invitation with `expires_at` equal to creation time plus `INVITATION_EXPIRY_SECONDS` (604,800 s, the fixed constant of `groups/policy.js`; OD-08 decided in part; no environment setting), audit `group.invitation.created`, and answers 201 with that `expiresAt`. Refusal order: a pending-Invitation maximum (OD-08, unresolved, no default) unset or not a positive whole number in an injected `features` object 503 (reachable only that way, because start-up exits first while the switch is on, DB5-R04.18), non-member 404, role 403, archived 409, body 400, target unknown, disabled, without credential or blocked 404 (one body, a block is not revealed), already active 409, pending exists or limit reached 409.
      - Creation first expires a past-expiry pending row of the pair. Limits count unexpired pending rows only. A second identical call gives 409. Buckets of 20 per hour per user, 5 per hour per user, group and invitee, and 60 per hour per source give 429. An example test in `groups-invitations.test.js` (injected clock) shows that `expires_at` equals the creation time plus 604,800 s. No re-invite delay exists and no setting for one (OD-08 still open): a new Invitation may follow a decline at once.
      - `GET /api/groups/:id/invitations` lists pending Invitations to owner and admin only, paged, with the manager projection.
    - **Verify**: `node --test tests/groups-invitations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R04.1, DB5-R04.2, DB5-R04.3, DB5-R04.4, DB5-R04.5, DB5-R04.7, DB5-R04.15, DB5-R04.18, DB5-R04.19, DB5-R04.21, DB5-R12.4_

  - [x] 2.12 Implement Invitation cancel, own list and decline (G14, G15, G17)
    - **ID**: T-5C-12
    - **Depends on**: T-5C-11
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-invitations.test.js`
    - **Acceptance criteria**:
      - `DELETE /api/groups/:id/invitations/:invitationId` by the inviter, owner or admin sets `cancelled` and answers 204. A member gets 403, another user 404, a non-pending Invitation 409.
      - `GET /api/groups/invitations` lists the caller's unexpired pending Invitations with group name and inviter display name and no member list or message data. `POST /api/groups/invitations/:invitationId/decline` sets `declined`, answers 204 and changes no membership. A non-invitee or unknown id gives the identical 404. An expired or non-pending Invitation gives 409.
      - Cancel and decline write `group.invitation.cancelled` or `group.invitation.declined` in the same transaction. A state that left pending never changes. A decline sets no re-invite delay (none is decided, OD-08). Fixed routes are matched before `/:id`.
    - **Verify**: `node --test tests/groups-invitations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R04.6, DB5-R04.7, DB5-R04.13, DB5-R04.14, DB5-R04.15, DB5-R04.16, DB5-R04.17, DB5-R04.21, DB5-R04.22_

  - [x] 2.13 Implement Invitation acceptance (G16)
    - **ID**: T-5C-13
    - **Depends on**: T-5C-12
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-invitations.test.js`
    - **Acceptance criteria**:
      - Accept runs in one immediate transaction. Not the invitee or unknown gives 404, not pending 409 with no change, expired (server time at or after `expires_at`, the creation time plus 604,800 s) sets `expired` and 409, an invitee who is already an Active_Member sets `cancelled`, 409 and leaves the member row untouched, and any other failed re-validation (archived group, inviter no longer active or not allowed to invite, block either way, member maximum `GROUP_MAX_MEMBERS` (50 in the approved configuration, read from the configuration or the injected `features`, never a constant in code), invitee removed since creation) sets `cancelled` and 409.
      - Success adds or reactivates the member with role member, opens an interval, sets `accepted`, bumps the revision once, writes the audit row and answers 200 `{group}`.
      - A refusal commits only the Invitation state and its audit row (DC-09). Membership, role, revision and intervals are unchanged. A concurrent second accept gets 409.
    - **Verify**: `node --test tests/groups-invitations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R04.7, DB5-R04.8, DB5-R04.9, DB5-R04.10, DB5-R04.11, DB5-R04.15, DB5-R04.16, DB5-R04.22, DB5-R03.12, DB5-R03.13, DB5-R03.14, DB5-R12.5_

  - [x] 2.14 Implement direct add (G06)
    - **ID**: T-5C-14
    - **Depends on**: T-5C-10
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - Without the injected `features.groups.directAdd` flag every `POST /api/groups/:id/members` that passes the Auth_Layer answers 503 `FEATURE_UNAVAILABLE` and changes nothing (OD-01 decided in part: direct add stays disabled and membership starts only through an accepted Invitation; only a later owner decision can enable it, and the flag exists for tests only). With the flag (tests only) the refusal order is: 503, group or non-member 404, role member 403, body 400 (a `role` field is refused), target unknown, disabled or without credential 404, block either way 404, already active 409, member maximum (`GROUP_MAX_MEMBERS`) 409.
      - Success adds the user as role member, opens an interval, bumps the revision once, writes `group.member.added` and answers 201 `{member}`. A former member is reactivated without rewriting `joined_at` of the member row.
      - Two concurrent adds of one target commit one. Adds that together pass the maximum commit only those that fit.
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R03.5, DB5-R03.6, DB5-R03.7, DB5-R03.8, DB5-R03.9, DB5-R03.10, DB5-R03.11, DB5-R03.12, DB5-R03.13, DB5-R03.14, DB5-R03.16, DB5-R03.17_

  - [x] 2.15 Implement member removal and leaving (G07, G09)
    - **ID**: T-5C-15
    - **Depends on**: T-5C-13
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - `DELETE /api/groups/:id/members/:userId`: the owner removes an admin or member, an admin removes a member only (403 for admin or owner target), an owner target gives 409, a target who is not active gives 404, role member gives 403, a requester who is not active gives 404. Success answers 204.
      - Removal and `POST /api/groups/:id/leave` set `left_at`, close the interval at the highest sequence, cancel every pending Invitation to or from the user, bump the revision once and write `group.member.removed` or `group.member.left` in one transaction. A failed write rolls back all of them. The member row stays. The owner's leave gives 409 (OD-10 default). Leaving works in an archived group.
      - After commit the user gets the uniform 404 on every group route. A second request gets 404, and two concurrent requests give one 204, one 404 and one revision step.
    - **Verify**: `node --test tests/groups-http.test.js tests/groups-invitations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R05.1, DB5-R05.2, DB5-R05.3, DB5-R05.4, DB5-R05.5, DB5-R05.6, DB5-R05.7, DB5-R05.8, DB5-R05.9, DB5-R05.10, DB5-R05.12, DB5-R05.13, DB5-R05.14, DB5-R05.15, DB5-R05.16, DB5-R05.17, DB5-R04.12, DB5-R07.11_

  - [x] 2.16 Implement role change and ownership transfer (G08, G10)
    - **ID**: T-5C-16
    - **Depends on**: T-5C-15
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - `PATCH /api/groups/:id/members/:userId` with `{role: admin|member, membershipRevision?}` (owner only) refuses in the order of DB5-R06.17: non-member 404, admin or member requester 403, role not admin or member 400, target not active 404, stale revision 409 `STALE_STATE`, owner target or same role 409. Success bumps the revision once, writes `group.role.changed` and answers 200 `{member}`.
      - `POST /api/groups/:id/transfer` with `{userId, membershipRevision?}`: a non-owner (a stale former owner included) gets 403, a missing, inactive or self target 400, a stale revision 409. Success demotes the owner to admin and then promotes the target in one transaction, bumps the revision once, writes `group.owner.transferred` and answers 200 `{group}`. Exactly one owner exists after every commit.
      - An admin can never elevate any user, itself included.
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R06.1, DB5-R06.2, DB5-R06.3, DB5-R06.4, DB5-R06.5, DB5-R06.6, DB5-R06.7, DB5-R06.8, DB5-R06.9, DB5-R06.10, DB5-R06.12, DB5-R06.14, DB5-R06.15, DB5-R06.16, DB5-R06.17_

  - [x] 2.17 Implement archiving and the archived-group guards (G11)
    - **ID**: T-5C-17
    - **Depends on**: T-5C-16, T-5C-14
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/server/routes/groups.js`, `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - `POST /api/groups/:id/archive` by the owner sets `archived_at` and writes `group.archived` in one transaction (a failed audit write leaves `archived_at` unchanged) and answers 200 `{group}`. A second archive gives 409 with no audit row. Admin and member get 403, a non-member 404.
      - After archiving, direct add, invitation creation, role change, transfer and changes of name or description answer 409 unless an earlier check refuses first (DB5-R07.2 no longer lists a policy change: the policy never changes). A PATCH that carries `historyPolicy` for an archived group answers 409 for the owner, because the archived refusal precedes the `historyPolicy` 400 in the DB5-R02.15 order, and changes no row. Reads of metadata, members and permitted history, and leaving, behave as before.
      - No row is deleted. `DELETE /api/groups/:id` and any unarchive path answer 404. A disabled or removed owner account keeps ownership.
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R07.1, DB5-R07.2, DB5-R07.3, DB5-R07.4, DB5-R07.5, DB5-R07.6, DB5-R07.7, DB5-R07.8, DB5-R07.9, DB5-R07.10_

  - [x] 2.18 Add the two-process worker and the four gate concurrency pairs
    - **ID**: T-5C-18
    - **Depends on**: T-5C-17, T-5C-11, T-5B-21
    - **Affected modules**: `DATA/tests/support/groups-worker.cjs` (new), `DATA/tests/groups-concurrency.test.js` (new)
    - **Acceptance criteria**:
      - The worker refuses to start unless `SECUBUZZ_ISOLATED_GROUP_WORKER=1`, `NODE_ENV=test` and `DB_PATH` is a temporary fixture file. It runs `startServer` with `features` read from one JSON environment variable, takes one stdin line `{method, path, body, cookie, csrf}` and prints `{status, body}`.
      - Two workers share one database file. A file barrier (`barrier/ready-<n>`, then `barrier/go`) puts both requests in flight within about 1 ms. Children are killed in `t.after`.
      - The pairs transfer and transfer, invite and invite, accept and remove, leave and transfer run 20 repeats each. Each result equals one legal serial outcome of design section 5, exactly one owner remains, `invariantReport` is empty and the audit rows equal the committed operations. A 503 or 500 fails the repeat.
      - The worker and the four pairs run inside the Validation_Runner (group `data`, C1: `--network none`, user node, `os.tmpdir()` for the database file and the barrier directory) as well as on the Windows host, and pass in both. They use only temporary files, never `DATA/server/database/database.sqlite` or a Docker volume (DB5-R14.17, DB5-R14.21), and start no container. A platform difference in paths or process termination is a branch of the test and never a skip (NFR-07).
    - **Verify**: `node --test tests/groups-concurrency.test.js` in DATA/ (host, quick feedback); the Validation_Runner group `data` (C1) is the gate of record
    - **Agent**: Kiro
    - _Requirements: DB5-R15.5, DB5-R04.20, DB5-R05.17, DB5-R06.11, DB5-R14.17, DB5-R14.21, NFR-07_

  - [x] 2.19 Write property test P-02 for concurrent ownership changes
    - **ID**: T-5C-19
    - **Depends on**: T-5C-18
    - **Property P-02: Concurrent ownership changes leave exactly one owner**
    - **Validates: Requirements DB5-R05.7, DB5-R06.2, DB5-R06.10, DB5-R06.11, DB5-R15.5**
    - **Affected modules**: `DATA/tests/groups-concurrency.test.js`
    - **Acceptance criteria**:
      - Pairs (two transfers to different targets, owner leave and transfer, removing an admin and transferring to that admin, accept and transfer, role change and transfer) run 20 repeats each on groups of 3 to 6 members with random roles.
      - After every run the group has exactly one owner, at most one transfer committed and a stale former owner received 403. A failure prints the log of each process.
    - **Verify**: `node --test tests/groups-concurrency.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.20 Write property test P-08 for concurrent request pairs
    - **ID**: T-5C-20
    - **Depends on**: T-5C-19
    - **Property P-08: Concurrent pairs equal one serial order**
    - **Validates: Requirements DB5-R01.13, DB5-R03.16, DB5-R04.20, DB5-R04.22, DB5-R05.17, DB5-R06.11, DB5-R12.5, DB5-R15.5**
    - **Affected modules**: `DATA/tests/groups-concurrency.test.js`
    - **Acceptance criteria**:
      - Pairs of two identical invitations, two creations with one key, accept and cancel, accept and removal of the inviter, two adds of one user, two adds that together pass the maximum, two removals or leaves of one user, remove and role change of one target, and accept and decline run 20 repeats each in two processes.
      - The pair of responses and the final state equal those of one serial order applied to a model. Exactly one wins where the requirements say so: invitation (201 and 409), removal (204, 404, revision +1 once), creation by key (one group), add (at most one per target, never above the maximum).
    - **Verify**: `node --test tests/groups-concurrency.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.21 Add the contract table and the schema checker
    - **ID**: T-5C-21
    - **Depends on**: T-5C-17, T-5B-21
    - **Affected modules**: `DATA/tests/support/contract.js` (new), `DATA/tests/support/schema-check.js` (new), `DATA/tests/groups-security.test.js` (new)
    - **Acceptance criteria**:
      - `contract.js` transcribes the routes G01 to G17 and G26 (G18 to G25 are added in DB-5D) with id, method, path template, minimum role, success status, the documented status and code pairs and a scope flag (`any`, `self`, `invitee`). The common pairs of DB5-R13.2, 415 `UNSUPPORTED_MEDIA_TYPE` included, apply to every row that takes a body. The row of G01 lists the request fields `name`, `description`, `historyPolicy` and `idempotencyKey` and the 400 whose `fields` can name `historyPolicy`; the row of G04 lists no `historyPolicy` request field and the 400 whose `fields` name it, and no 503 for it. A self-check in `groups-security.test.js` fails when a route id has no row, when a row is missing from the router's frozen route table, or when a response carries a status and code pair the row does not list (DB5-R13.11).
      - `schema-check.js` validates examples against the keyword subset the OpenAPI documents use, fails on an unknown keyword and adds no dependency (NFR-09).
    - **Verify**: `node --test tests/groups-security.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.2, DB5-R13.7, DB5-R13.11, DB5-R15.2, NFR-09_

  - [x] 2.22 Write property test P-03 for the role and state model
    - **ID**: T-5C-22
    - **Depends on**: T-5C-17, T-5B-10, T-5B-09
    - **Property P-03: Every operation answers as the pure rules decide**
    - **Validates: Requirements DB5-R02.11, DB5-R03.2, DB5-R03.5, DB5-R03.8, DB5-R03.9, DB5-R03.10, DB5-R03.11, DB5-R03.12, DB5-R03.15, DB5-R04.4, DB5-R04.5, DB5-R04.13, DB5-R04.14, DB5-R04.21, DB5-R05.1, DB5-R05.2, DB5-R05.3, DB5-R05.4, DB5-R05.5, DB5-R05.6, DB5-R05.15, DB5-R05.16, DB5-R06.3, DB5-R06.4, DB5-R06.5, DB5-R06.6, DB5-R06.8, DB5-R06.9, DB5-R06.13, DB5-R06.14, DB5-R06.15, DB5-R06.16, DB5-R07.9, DB5-R12.6, DB5-R12.13**
    - **Affected modules**: `DATA/tests/groups-model.test.js`
    - **Acceptance criteria**:
      - For generated groups (2 to 8 members with random roles, 0 to 3 blocks, archived or not, member maximum 2 to 10 through `features`), one drawn operation (remove, leave, role change, transfer, archive, update, invite, cancel Invitation, direct add, list former members), one actor class and one target class, status and code equal the decision of `groups/policy.js`.
      - A success changes the membership rows exactly as the model predicts and a refusal changes no row. A spoofed `actorId`, `ownerId` or `createdBy` field (1 case in 10) is refused as an unknown field or ignored and never changes the acting user.
    - **Verify**: `node --test tests/groups-model.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.23 Write property test P-20 for the order of refusals
    - **ID**: T-5C-23
    - **Depends on**: T-5C-22
    - **Property P-20: The first failing check decides the answer**
    - **Validates: Requirements DB5-R01.8, DB5-R01.9, DB5-R02.13, DB5-R02.15, DB5-R03.6, DB5-R03.7, DB5-R03.17, DB5-R06.17, DB5-R12.1, DB5-R12.2, DB5-R12.3, DB5-R12.10, DB5-R12.11, DB5-R12.12, DB5-R12.14, DB5-R13.2, DB5-R13.4, DB5-R16.2, DB5-R16.3, DB5-R16.4, ARCH-R01.5**
    - **Affected modules**: `DATA/tests/groups-model.test.js`
    - **Acceptance criteria**:
      - For subsets of 1 to 5 failing conditions, the response is that of the first failing check of the documented order for the request chain (also with `AUTH_MIDDLEWARE_MODULE` set, which is the AF-12 regression: wrong Origin 403, no session 401, no CSRF 403), PATCH group (the DB5-R02.15 order, in which the archived 409 precedes the `historyPolicy` 400, which precedes the stale-revision 409), direct add, and role change and transfer. Every refusal changes no row.
      - The oracle is an ordered list of (condition, status, code) per operation transcribed from the requirements and the request-level failures table. The message-write order is added in DB-5D.
    - **Verify**: `node --test tests/groups-model.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.24 Write property test P-01 for random operation sequences
    - **ID**: T-5C-24
    - **Depends on**: T-5C-17, T-5B-10, T-5C-21
    - **Property P-01: One active owner after every operation**
    - **Validates: Requirements DB5-R04.10, DB5-R05.4, DB5-R05.7, DB5-R06.2, DB5-R06.7, DB5-R06.8, DB5-R15.6**
    - **Affected modules**: `DATA/tests/groups-random.test.js` (new)
    - **Acceptance criteria**:
      - 100 sequences of 50 operations (constants at the top of the file) over 6 users and 1 to 3 groups draw create, invite, accept, decline, cancel, clock advance, remove, leave, role change, transfer, archive and direct add (enabled through `features`) by weight. Refused, stale and wrong-actor requests are included and one draw in five replays an earlier request. Message send is added in DB-5D.
      - After every operation the group has exactly one Active_Member with role owner and an empty `invariantReport`, and status and code equal the model's decision.
      - The seed of every sequence is printed with `t.diagnostic`. `PROPERTY_SEED` and `PROPERTY_RUN` replay one sequence. The measured run time is noted (target under 120 s).
    - **Verify**: `node --test tests/groups-random.test.js` in DATA/
    - **Agent**: Kiro
    - **Verified checkpoint (Codex, 2026-11-22)**: 100/100 generated sequences and 5,000 operations pass, covering all 12 operation types. Final Node test duration 99,680.9243 ms and wall-clock duration 99,833.3197 ms, below the advisory 120 s target. Related snapshot/security regressions: 37/37 pass; prior groups HTTP/concurrency regressions: 77/77 pass. Syntax checks and `git diff --check` pass.

  - [x] 2.25 Write property test P-04 for the Invitation state machine
    - **ID**: T-5C-25
    - **Depends on**: T-5C-24
    - **Property P-04: An Invitation leaves pending once and never changes again**
    - **Validates: Requirements DB5-R04.9, DB5-R04.15, DB5-R04.17, DB5-R04.22, DB5-R14.12, DB5-R15.6**
    - **Affected modules**: `DATA/tests/groups-random.test.js`
    - **Acceptance criteria**:
      - With an Invitation snapshot after every operation of the P-01 harness, state moves only from pending to accepted, declined, cancelled or expired, a row that left pending never changes any column, and `resolved_at` is NULL exactly while pending.
      - A pending row at or after `expires_at` answers accept and decline with 409 without a background job (clock jumps of 0 to 3 expiry periods of 604,800 s each). A direct UPDATE or DELETE attempt on 1 step in 10 is rejected and leaves the row unchanged.
    - **Verify**: `node --test tests/groups-random.test.js` in DATA/
    - **Agent**: Kiro
    - **Verified checkpoint (Codex, 2026-11-22)**: canonical verifier passes 2/2, including P-01 with 100/100 sequences and 5,000 operations; P-04 records 500 direct SQL mutation attempts across all eight categories and 5,500 invitation checks. Invitation/security regressions pass 92/92. Node duration 97,792.0448 ms; wall-clock 97,932.8656 ms. Syntax and `git diff --check` pass.

  - [x] 2.26 Write property test P-09 for Membership_Revision
    - **ID**: T-5C-26
    - **Depends on**: T-5C-25
    - **Property P-09: The revision moves by exactly the qualifying changes**
    - **Validates: Requirements DB5-R01.14, DB5-R02.12, DB5-R03.14, DB5-R04.11, DB5-R05.10, DB5-R05.13, DB5-R05.17, DB5-R06.3, DB5-R06.7, DB5-R06.12**
    - **Affected modules**: `DATA/tests/groups-random.test.js`
    - **Acceptance criteria**:
      - After each operation the revision equals the previous value plus the qualifying changes: +1 for accept, direct add, rejoin, removal, leave and role change, +1 once for a transfer, +0 for creation, update, archive, invitation create, decline, cancel, expiry and every refused request. Observed values run 1, 2, 3, ... with no gap or repeat.
      - A request with a different `membershipRevision` answers 409 `STALE_STATE` and changes nothing. A direct UPDATE to any value other than old + 1 is rejected by `group_extensions_update`.
    - **Verify**: `node --test tests/groups-random.test.js` in DATA/
    - **Agent**: Kiro
    - **Verified checkpoint (Codex, 2026-11-22)**: P-09 verifier 2/2 PASS; 100 sequences / 5,000 original operations, 1,500 generated updates, 300 rejected direct SQL revision changes and 100 same-value no-op assignments; deterministic replays 0 and 14 PASS; repository suite 106/106 PASS; concurrency suite 380/380 pairs PASS; T-5B-26 isolated PASS; runtime 103.2 s; syntax and `git diff --check` PASS. Revision interpretation: actual value changes must be exactly old + 1; assigning the existing value is a permitted no-op, consistent with `group_extensions_update` and T-5B-23. The Task 2.26 wording is broader; no canonical specification change was made.

  - [x] 2.27 Write property test P-10 for Membership_Intervals
    - **ID**: T-5C-27
    - **Depends on**: T-5C-26
    - **Property P-10: Intervals stay one open, ordered and immutable**
    - **Validates: Requirements DB5-R03.13, DB5-R05.1, DB5-R05.6, DB5-R05.9, DB5-R05.10, DB5-R08.3, DB5-R08.4, DB5-R14.12**
    - **Affected modules**: `DATA/tests/groups-random.test.js`
    - **Acceptance criteria**:
      - After every event of 100 sequences of 50 events over 6 users, each Active_Member has exactly one open interval and each former member none; `interval_no` runs 1 to k; intervals are disjoint and ordered; `first_seq` at a join is the highest sequence plus 1; `last_seq` at a leave is the highest sequence (`first_seq - 1` when empty); closed boundaries and `joined_at` never change and `ConversationMembers.joined_at` never changes after the first insert.
      - Direct SQL that opens a second interval, overlaps one, edits a closed one or deletes one (1 event in 10) is rejected.
    - **Verify**: `node --test tests/groups-random.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.28 Write property test P-24 for archived groups
    - **ID**: T-5C-28
    - **Depends on**: T-5C-27
    - **Property P-24: Archiving stops writes and deletes nothing**
    - **Validates: Requirements DB5-R05.9, DB5-R07.1, DB5-R07.2, DB5-R07.3, DB5-R07.4, DB5-R07.5, DB5-R07.6, DB5-R07.10, DB5-R07.11**
    - **Affected modules**: `DATA/tests/groups-random.test.js`
    - **Acceptance criteria**:
      - In sequences with archive weighted up after step 10, every direct add, invitation creation, role change, transfer and change of name or description after the archive commit answers 409 unless an earlier check refuses first (a PATCH that carries `historyPolicy` meets the archived 409 first for the owner; the policy is never changed). Reads and leave behave as before. A second archive answers 409, keeps `archived_at` and writes no audit row.
      - Row counts of `Conversations`, `ConversationMembers`, `GroupMembershipIntervals`, `ConversationInvitations`, `Messages`, `MessageReceipts` and `Attachments` never decrease for a group. `DELETE /api/groups/:id` and any unarchive route answer 404. The message and attachment parts are added in DB-5D and DB-6D.
    - **Verify**: `node --test tests/groups-random.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.29 Write property test P-05 and the AF-05 regression
    - **ID**: T-5C-29
    - **Depends on**: T-5C-13, T-5B-10
    - **Property P-05: At most one pending Invitation per group and invitee**
    - **Validates: Requirements DB5-R04.2, DB5-R04.3, DB5-R04.15, DB5-R04.19, DB5-R14.12, DB5-R15.3**
    - **Affected modules**: `DATA/tests/groups-invitations.test.js`
    - **Acceptance criteria**:
      - In invitation-heavy sequences over 3 to 6 users with two or three managers and limits 1 to 4, at most one row is pending for any pair at every point. A repeat request (same inviter, another manager, limit reached) answers 409 and adds no row. After expiry a new request succeeds and the old row is `expired`. A direct INSERT of a second pending row is rejected.
      - Test `AF-05: duplicate pending invitations are rejected` asserts 409, one pending row and the unique-constraint error.
    - **Verify**: `node --test tests/groups-invitations.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.30 Write property test P-06 and the AF-03 regression
    - **ID**: T-5C-30
    - **Depends on**: T-5C-29, T-5C-15, T-5C-14
    - **Property P-06: A removal or leave cancels every related Invitation**
    - **Validates: Requirements DB5-R04.8, DB5-R04.9, DB5-R04.12, DB5-R05.8, DB5-R05.14, DB5-R05.15, DB5-R12.13, DB5-R15.3**
    - **Affected modules**: `DATA/tests/groups-invitations.test.js`
    - **Acceptance criteria**:
      - When a user is removed or leaves while an Invitation to or from that user is pending, every such Invitation is cancelled in the same transaction. A later accept answers 409 (404 for a non-invitee). The user has no Active_Member row or open interval, and the stale requests of a removed actor answer 404 and change no row.
      - Test `AF-03: an invitation issued before removal cannot restore the removed member` covers both cases of the design (direct add then removal, and inviter removed) and asserts 409, `cancelled`, 404 on the group, unchanged revision after the accept and no `group.invitation.accepted` audit row.
    - **Verify**: `node --test tests/groups-invitations.test.js` in DATA/
    - **Agent**: Kiro
    - **Local validation evidence (2026-11-23)**: `node --test tests/groups-random.test.js` 3/3 PASS, 159196.7607 ms (100 P-01 sequences, P-10 100 x 50 events, 500 SQL attempts, P-24 800 refused writes and 300 absent routes); `node --test tests/groups-invitations.test.js` 59/59 PASS, 109845.3258 ms; archived HTTP verifier 11/11 PASS, 11243.8912 ms; syntax, `git diff --check`, and migration integrity PASS.

  - [x] 2.31 Write property test P-07 and the AF-04 regression
    - **ID**: T-5C-31
    - **Depends on**: T-5C-30, T-5C-16
    - **Property P-07: Accepting as a current member changes nothing**
    - **Validates: Requirements DB5-R04.10, DB5-R06.2, DB5-R12.5, DB5-R15.3**
    - **Affected modules**: `DATA/tests/groups-invitations.test.js`
    - **Acceptance criteria**:
      - When the invitee is owner, admin or member by the time of the accept, the answer is 409, the Invitation becomes `cancelled`, and the member row (role, `joined_at`, `left_at`), all intervals, the revision and the owner count equal their earlier values.
      - Test `AF-04: a stale invitation accepted by the current owner leaves exactly one owner` runs both design runs (transfer to the invitee, and role change to admin) and asserts one active owner.
    - **Verify**: `node --test tests/groups-invitations.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.32 Add the AF-06 and AF-11 regressions and the `AUTH_MIDDLEWARE_MODULE` scan
    - **ID**: T-5C-32
    - **Depends on**: T-5C-17, T-5C-14
    - **Affected modules**: `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - Test `AF-06: direct add grants no role` covers the OD-01 decision (direct add stays disabled: 503 with and without a `role` field) and, with the test flag on, 400 naming `role`, 201 with role member, 403 for a member, 404 identical to an unknown user for a block, and 403 for an admin's role change. No row changes on a refusal.
      - Test `AF-11` sends `POST /api/groups` with no body, an empty body, malformed JSON and a non-object and gets 400, never 500.
      - A static scan fails if any file under `DATA/server` references `AUTH_MIDDLEWARE_MODULE`.
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R03.5, DB5-R03.6, DB5-R03.7, DB5-R06.5, DB5-R06.6, DB5-R01.7, DB5-R13.4, DB5-R12.10, DB5-R15.3_

  - [x] 2.33 Write property test P-23 for create and update bodies
    - **ID**: T-5C-33
    - **Depends on**: T-5C-09, T-5B-10
    - **Property P-23: Bodies are accepted exactly when the validators accept**
    - **Validates: Requirements DB5-R01.1, DB5-R01.2, DB5-R01.3, DB5-R01.4, DB5-R01.5, DB5-R01.6, DB5-R01.7, DB5-R01.10, DB5-R01.11, DB5-R01.12, DB5-R01.14, DB5-R01.15, DB5-R02.9, DB5-R02.10, DB5-R02.13, DB5-R02.14, DB5-R08.2**
    - **Affected modules**: `DATA/tests/groups-http.test.js`
    - **Acceptance criteria**:
      - 100 bodies per run from a grammar of valid and invalid parts (names of 0 to 120 code points with any whitespace or control characters, description of any type or length, `historyPolicy` absent, `all`, `from_joined`, `null`, `ALL`, an empty string, other strings and numbers, unknown fields, idempotency keys of any type and length) give 201 (200 for PATCH) exactly when the validators accept (for POST `historyPolicy` absent or exactly `all` or `from_joined`; for PATCH no `historyPolicy` field at all), and otherwise 400 with the offending names in `fields` (`historyPolicy` for an invalid POST value and for every PATCH that contains it), never 500, and no row created or changed.
      - On 201 the Conversations row, owner row, extension record (revision 1, the supplied History_Policy or `from_joined` when none is supplied), first interval and audit row all exist. The idempotency window behaves as DB5-R01.10 and R01.11 with clock advances of 0 to 48 hours, and the fingerprint includes the policy (an omitted one counting as `from_joined`).
    - **Verify**: `node --test tests/groups-http.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.34 Write property test P-14 for altered cursors and bad parameters
    - **ID**: T-5C-34
    - **Depends on**: T-5C-12, T-5C-10, T-5B-12
    - **Property P-14: A tampered or foreign cursor is refused with 400**
    - **Validates: Requirements DB5-R02.6, DB5-R02.7, DB5-R09.17**
    - **Affected modules**: `DATA/tests/groups-pagination.test.js`
    - **Acceptance criteria**:
      - Cursors from real first pages of G02, G05, G13 and G15 are altered (flip, insert, delete or replace a character, truncate, append, change case, random base64url, over 2048 characters, characters outside base64url) or presented by another user, route or filter set. The answer is 400 `VALIDATION_ERROR` with `cursor` in `fields`, no item, never 500, no row changed.
      - An unknown query parameter or a `limit` outside 1 to 50 answers 400 with the parameter name in `fields`. Cursors of G18 and A06 are added in DB-5D and DB-6D.
    - **Verify**: `node --test tests/groups-pagination.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.35 Write property test P-15 for listing order and completeness
    - **ID**: T-5C-35
    - **Depends on**: T-5C-34
    - **Property P-15: Paged listings equal the sorted oracle (list endpoints)**
    - **Validates: Requirements DB5-R02.4, DB5-R02.5, DB5-R03.1, DB5-R04.6**
    - **Affected modules**: `DATA/tests/groups-pagination.test.js`
    - **Acceptance criteria**:
      - For 0 to 150 items and page sizes 1 to 50 drawn per request, the listings of groups, members, former members, own pending Invitations and pending Invitations of a group concatenate to the oracle's sorted sequence in the documented order, with no duplicate or skipped element, and the last page has no cursor.
      - The history traversal part and file search are added in DB-5D and DB-6D.
    - **Verify**: `node --test tests/groups-pagination.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.36 Add the actor-class matrix over G01 to G17 and G26
    - **ID**: T-5C-36
    - **Depends on**: T-5C-21, T-5C-17, T-5C-14
    - **Affected modules**: `DATA/tests/groups-security.test.js`
    - **Acceptance criteria**:
      - Every route runs as unauthenticated, non-member, pending invitee, member, admin, owner and removed member. Expected cells follow the six rules of the design: 401, 403 `CSRF_INVALID` (one extra cell per route), the uniform 404 for non-member, pending invitee and removed member, 403 below the minimum role, the success or documented state refusal, and the scope flags.
      - Each denied cell runs with a valid and an invalid body (404 and 403 precede 400), the success cell runs last on its own fresh group, and a cell passes only when status, code, fields and every table hash equal the expectation. The allowed differences are the DC-09 Invitation row with one audit row.
      - G04 gets one more cell per actor class with a body that carries `historyPolicy`: unauthenticated 401, non-member, pending invitee and removed member the uniform 404, member and admin 403, the owner 400 `VALIDATION_ERROR` with `historyPolicy` in `fields` (409 for an archived group), and no cell answers 503 or changes a row (OD-05 decided; the role matrix refuses a policy change for every role). G01 gets cells with `historyPolicy` valid and invalid.
    - **Verify**: `node --test tests/groups-security.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R15.2, DB5-R12.13, DB5-R04.7, DB5-R05.8, DB5-R13.10, DB5-R13.11_

  - [x] 2.37 Write property test P-21 for unchanged records on refusal
    - **ID**: T-5C-37
    - **Depends on**: T-5C-36
    - **Property P-21: A refused request changes no record**
    - **Validates: Requirements DB5-R04.9, DB5-R13.10, DB5-R15.2**
    - **Affected modules**: `DATA/tests/groups-security.test.js`
    - **Acceptance criteria**:
      - For every route of the contract table, every actor class and faults (bad body, bad query, bad cursor, wrong content type, stale state, archived group), a request that answers 400 or higher leaves the snapshot of all group, message and audit tables identical.
      - The only allowed differences are the `AuthRateLimits` counters and the documented DC-09 Invitation change with its audit row.
    - **Verify**: `node --test tests/groups-security.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.38 Write property test P-22 for error shape and uniform 404
    - **ID**: T-5C-38
    - **Depends on**: T-5C-37
    - **Property P-22: Errors are safe, listed and indistinguishable where required**
    - **Validates: Requirements DB5-R02.3, DB5-R03.3, DB5-R04.7, DB5-R04.16, DB5-R05.8, DB5-R05.15, DB5-R07.7, DB5-R12.7, DB5-R12.13, DB5-R13.1, DB5-R13.2, DB5-R13.3, DB5-R13.11, DB5-R14.18, NFR-06, NFR-08**
    - **Affected modules**: `DATA/tests/groups-security.test.js`
    - **Acceptance criteria**:
      - Each failing request returns exactly `{code, fields}` with `fields` non-empty only for 400 and holding names that match `^[a-zA-Z][a-zA-Z0-9]{0,63}$`. The status and code pair is in the route's documented list and malformed input never gives 500.
      - Canary strings in ids, names and descriptions never appear in a response, stderr line or audit row, and no stack, SQL text, constraint or trigger name, path or storage root is shown.
      - For every denial cause of the uniform 404 table, status, body and header names and values (except `Date`) are identical, and a removed member is tried on every group route.
    - **Verify**: `node --test tests/groups-security.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.39 Add the rate-limit tests
    - **ID**: T-5C-39
    - **Depends on**: T-5C-17, T-5C-21
    - **Affected modules**: `DATA/tests/groups-security.test.js`
    - **Acceptance criteria**:
      - With the injected limiter, reads (GET and HEAD) use `groups:read:<user>` and `groups:read-source:<ip>` and mutations (every other method: POST, PATCH, DELETE and a PUT, counted as a mutation by the OP-17 default) use `groups:write:<user>` and `groups:write-source:<ip>`; exhausting one family does not block the other. A unit test over every HTTP method shows the family each one selects, PUT included (the PUT route G23 arrives in DB-5D, T-5D-10). Invitation creation and group creation have their additional buckets of ASM-03.
      - The per-source limits are configurable (OP-19) and `groups-api.md` documents that in the Docker_Environment every request reaches DATA from the one source 127.0.0.1 (the Next proxy over loopback, `trust proxy` off, `AUTH_TRUST_PROXY_IPS` empty), so a per-source bucket is shared by all users of a project and a multi-user manual test can meet 429 early. A test shows that `X-Forwarded-For` and other forwarded headers change no bucket key, and per-user buckets still tell users apart.
      - A limited request answers 429 `RATE_LIMITED` with `Retry-After` in whole seconds of at least 1, and changes no group record.
    - **Verify**: `node --test tests/groups-security.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R12.4, DB5-R12.2, DB5-R13.2_

  - [x] 2.40 Write property test P-30 for audit rows
    - **ID**: T-5C-40
    - **Depends on**: T-5C-17, T-5B-20, T-5B-10
    - **Property P-30: Each committed operation writes one safe audit row**
    - **Validates: Requirements DB5-R12.8, NFR-06**
    - **Affected modules**: `DATA/tests/audit-metadata.test.js`
    - **Acceptance criteria**:
      - With hostile canary text in names and descriptions, each committed group operation writes exactly one `AuditLogs` row in the same transaction with `source` `groups`, `subject_id` the group id and `metadata_json` keys within `operation`, `outcome`, `count`, `duration_ms`, `reason_code`, `target_id` and `role`. String values match `^[a-zA-Z0-9_.:-]{1,64}$`.
      - A refused request writes no audit row except the documented DC-09 change. No audit row, log line or stderr line contains a canary value, and `audit.insert` still rejects any other key.
    - **Verify**: `node --test tests/audit-metadata.test.js` in DATA/
    - **Agent**: Kiro

    - **Local completion evidence (owner-accepted Batch 4)**: Windows C1 `npm test` 822/822 PASS, zero cancelled/skipped/todo; P-01 100 sequences / 5,000 operations in 217.3 s under the unchanged 240 s timeout. Linux C1 822/822 PASS; server 547/547; client 1,075/1,075. Baseline checksums 11/11; migration integrity 63/63; security 9/9; audit 6/6; invitations 61/61; HTTP 79/79; pagination 9/9; group model 44/44; generated random 3/3. Checkpoint commit: `598ecb8` (`test(db5c): complete batch 4 validation and security properties`).

  - [x] 2.41 Write property test P-31 for atomicity
    - **ID**: T-5C-41
    - **Depends on**: T-5C-17, T-5B-10
    - **Property P-31: A failure at any write step leaves every table unchanged**
    - **Validates: Requirements DB5-R01.2, DB5-R05.14, DB5-R07.1, DB5-R11.5, DB5-R12.9, DB5-R13.5, DB5-R13.12, NFR-01**
    - **Affected modules**: `DATA/tests/groups-atomicity.test.js` (new)
    - **Acceptance criteria**:
      - For each state-changing group operation (create, update, archive, add, invite, accept, decline, cancel, remove, leave, role change, transfer) the number of write steps n is measured, then a failure is injected at every step k from 1 to n (including the audit insert) through a test-only seam, and for each error class DUPLICATE, CONFLICT, INVALID, BUSY and DATABASE.
      - The answer carries the status of the repository error mapping (500 for an audit failure), forwards no database text, and every table equals its snapshot before the operation, except the one DC-09 commit.
    - **Verify**: `node --test tests/groups-atomicity.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.42 Write property test P-32 at API level
    - **ID**: T-5C-42
    - **Depends on**: T-5C-17, T-5B-30, T-5C-05
    - **Property P-32: Stop and start on the same file changes nothing (API level)**
    - **Validates: Requirements DB5-R11.1, DB5-R11.2, DB5-R11.3, DB5-R11.4, DB5-R11.6, DB5-R14.17, DB5-R15.7**
    - **Affected modules**: `DATA/tests/groups-restart.test.js`
    - **Acceptance criteria**:
      - For 20 to 50 sequences of 20 operations, stopping and starting through `startServer` on the same file gives identical projections for G02, G03 (the stored `historyPolicy` included), G05 (with `former`), G13 and G15, identical revisions and identical allow or refuse results for each user and action. The second start applies zero migrations. Every sequence runs on a database file in a new temporary directory; no container, volume or `DATA/server/database/database.sqlite` is opened (DB5-R11.6, DB5-R14.17).
      - An Invitation whose expiry passed during the stop answers accept with 409 and creates no membership. The history, read-position and kill variants are added in DB-5D and DB-5G.
    - **Verify**: `node --test tests/groups-restart.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.43 Write property test P-25 for disabled switches
    - **ID**: T-5C-43
    - **Depends on**: T-5C-17, T-5C-21
    - **Property P-25: A disabled function answers 503 and changes nothing**
    - **Validates: Requirements DB5-R15.8, DB5-R16.2, DB5-R16.3, DB5-R16.4, DB5-R16.5, DB5-R16.12**
    - **Affected modules**: `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - For random switch assignments and 10 to 40 requests drawn from the frozen route table with valid CSRF proof, every `/api/groups` route except feature-status answers 503 `FEATURE_UNAVAILABLE` while `groupApi` is off, and the snapshot of every table is identical.
      - After enabling the Group_API, creating data, turning it off and restarting on the same files, data and ledger are unchanged and the routes answer 503 again. A request without CSRF proof answers 403 before the switch is read. The messaging and attachment switches are added in DB-5D and DB-6B.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.44 Write property test P-26 for configuration and feature-status
    - **ID**: T-5C-44
    - **Depends on**: T-5C-43, T-5C-05
    - **Property P-26: Switches follow the exact string and feature-status reports them**
    - **Validates: Requirements DB5-R16.1, DB5-R16.5, DB5-R16.6, DB5-R16.7, DB5-R16.13**
    - **Affected modules**: `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - For generated environment maps (`true`, `TRUE`, `1`, empty, spaces, negative, fractional, huge) a switch is on exactly when its variable is the string `true`. A switch that is on with a missing or non-positive setting throws `FeatureConfigError` naming exactly the offending settings and no value (`GROUP_MAX_MEMBERS` has no default in code, and `GROUP_INVITATION_TTL_SECONDS` in the map as a distractor changes nothing and is never named); valid settings give a frozen result.
      - `GET /api/groups/feature-status` answers 200 with exactly the three booleans for every switch assignment, `groupMessaging` is true only while `groupApi` is true, and without a session the answer is 401. The verifier and storage-root classes are added in DB-5D and DB-6B.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.45 Make the new migration tests independent of a hard-coded ledger
    - **ID**: T-5C-45
    - **Depends on**: T-5B-19, T-5C-44
    - **Affected modules**: `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - A static example test fails when a test file that is not in the baseline manifest hard-codes a migration file list, an applied-version list or a latest-version number. The expected ledger comes from the directory listing of `DATA/server/database/migrations` or from the runner's output.
      - The seven DC-01 lines remain the only hard-coded ledger lists, so adding 0009 in DB-6B needs no edit of any test created in DB-5B or DB-5C except those lines.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R02.1, DB5-R15.11, DB5-R14.6, DB5-R14.9_

  - [x] 2.46 Write `groups-openapi.json` and its conformance test
    - **ID**: T-5C-46
    - **Depends on**: T-5C-21, T-5C-17
    - **Affected modules**: `DATA/docs/groups-openapi.json` (new), `DATA/tests/groups-openapi.test.js` (new)
    - **Acceptance criteria**:
      - The set of (method, path) pairs is equal in three places: the document, the router's frozen route table and the router's mounted layer stack, so an unlisted mounted route fails (DB5-R13.7). Each operation lists the status and code pairs of its contract row, with the common pairs of DB5-R13.2 (415 `UNSUPPORTED_MEDIA_TYPE` included).
      - The request schema of G01 has the optional property `historyPolicy` with the enum `all` and `from_joined` (default `from_joined`) and its example carries one; the 400 entry of G01 names `historyPolicy`. The request schema of G04 has no `historyPolicy` property and refuses additional properties, and its error list holds the 400 whose `fields` can name `historyPolicy` and no 503 for it. The response projections show `historyPolicy`. A static check fails when G04 accepts `historyPolicy` or lists a 503 for it, or when G01 lacks the property (OD-05 decided).
      - Every example validates against its schema with `support/schema-check.js`. All keys of documented and observed bodies match `^[a-z][A-Za-z0-9]*$` (DB5-R13.9). The existing OpenAPI documents are unchanged (COMP-02).
    - **Verify**: `node --test tests/groups-openapi.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.2, DB5-R13.6, DB5-R13.7, DB5-R13.9, DB5-R13.11, DB5-R01.15, DB5-R02.13, COMP-02_

  - [x] 2.47 Write `groups-api.md`
    - **ID**: T-5C-47
    - **Depends on**: T-5C-46
    - **Affected modules**: `DATA/docs/groups-api.md` (new), `DATA/tests/groups-openapi.test.js`
    - **Acceptance criteria**:
      - The document lists every route G01 to G17 and G26 with request schema, response schema, minimum role, status and code list and an example, the conventions (camelCase, no-store, `{code, fields}`), the projections, the common errors including 415 `UNSUPPORTED_MEDIA_TYPE` (CI-19) and each additional code before use, the uniform 404 rules, the DC-05 and DC-09 notes, the decided and default behaviors in force (direct add 503 by the OD-01 decision; `historyPolicy` accepted by G01 only and refused by G04 with 400 by the OD-05 decision; the Invitation expiry fixed at 604,800 s; no delete or unarchive route) and the injected `features` object with the direct-add test flag. The G01 request schema and example carry the optional `historyPolicy`, and the G04 error list holds the 400 for `historyPolicy`.
      - It documents the settings (`GROUP_MAX_MEMBERS`, approved value 50, required with no default; the two pending-Invitation maxima, no default; no `GROUP_INVITATION_TTL_SECONDS`), the per-source rate limits as one shared source 127.0.0.1 in the Docker_Environment (OP-19), and the manual-test procedure of the Docker_Environment: a switch is turned on only through a temporary override file outside the repository (`compose.yaml` is not edited), a change under `DATA/server` reaches a running container only by `docker compose up --build` or by Compose Watch (never while a migration file is a draft, DB5-R14.22), and the first start of code that contains a new migration against data to keep needs the cold backup of both volumes first (DB5-R14.23, a citation of `docs/docker-development.md`).
      - It freezes the verifier contract for DB-5D: `verifyEnvelope(actor, envelope, {conversationId, recipientIds, membershipRevision, fingerprint})`, a 2000 ms deadline, a 32-call concurrency cap, `testOnly` refused in production.
      - A test in `groups-openapi.test.js` fails when a route of the frozen table is missing from the document by method and path.
    - **Verify**: `node --test tests/groups-openapi.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.2, DB5-R13.6, DB5-R13.8, DB5-R09.11, DB5-R09.12, DB5-R01.14, DB5-R02.13, DB5-R12.4, DB5-R14.22, DB5-R14.23_

  - [x] 2.48 Add `.env.example` entries, `gate-records.md` and `gate-records.test.js`
    - **ID**: T-5C-48
    - **Depends on**: T-5C-47, T-5C-01
    - **Affected modules**: `DATA/.env.example` (names and safe defaults only; `DATA/.env` is never read or edited), `DATA/docs/gate-records.md` (new), `DATA/tests/gate-records.test.js` (new)
    - **Acceptance criteria**:
      - `.env.example` documents `GROUPS_API_ENABLED` and `GROUP_MESSAGING_ENABLED` (`false`), the three group settings and the two group gate-record variables, each with a default that leaves the function disabled. `GROUP_MAX_MEMBERS` appears with the approved example value `50` and no other group setting carries a value: the two pending-Invitation maxima (unresolved, no default) are listed commented with no value, and no `GROUP_INVITATION_TTL_SECONDS` entry exists. Existing variables are unchanged (COMP-08).
      - `gate-records.md` defines the entry format `GR-<stage>-<date>` (evidence, commit, approval) and lists the stages. It states that the evidence of a record names the Validation_Runner run (gate of record) and the Windows host run (additional evidence) separately and lists the Known_Baseline_Failure entries apart. No entry is approved yet.
      - `gate-records.test.js` fails when `.env.example` or any committed environment file enables a switch whose Gate_Record is absent, checks the record id format and the standalone inventory (one disposition, a reason and a requirement ID per artifact), compares the dependency lists of the three `package.json` files with the baseline unless the handoff has an entry (NFR-09), and asserts that `client/authProxy.cjs` and `client/next.config.js` hold no `/api/groups`, `/api/attachments` or `/api/files` rewrite.
      - The same test scans `compose.yaml`, `docker/compose.env.example.yaml` and any Docker override file kept in the repository, and fails on an enabled switch (`GROUPS_API_ENABLED`, `GROUP_MESSAGING_ENABLED` or `ATTACHMENTS_API_ENABLED` set to `true`), on `NEXT_PUBLIC_ATTACHMENT_API_READY` or `NEXT_PUBLIC_GROUPS_UI_READY` set to `true` before the matching Gate_Record, and on any of the three variables `GROUPS_API_GATE_RECORD`, `GROUP_MESSAGING_GATE_RECORD` and `ATTACHMENTS_API_GATE_RECORD` (`ATTACHMENT_STORAGE_DIR` is allowed). The Validation_Runner holds none of those Docker files, so the test asserts the expectation of each context: when `SECUBUZZ_DOCKER_VALIDATION` is `true` it asserts that the root Docker files are absent from the image and scans nothing, and on a host it asserts that they exist and scans them. A platform or context difference is a branch of the test, never a skip (DB5-R15.16). Command G8 runs the same scan at the repository root.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/ (host and Validation_Runner group `data`); G8
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8, DB5-R16.11, DB5-R16.7, DB5-R15.16, COMP-08, COMP-10, ARCH-R03.1, ARCH-R03.2, NFR-09_

  - [x] 2.49 Record the Project_Owner decisions needed to approve GROUP-MANAGEMENT
    - **ID**: T-5C-49
    - **Depends on**: T-5C-47
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The log records the two values that are still open under OD-08: the maximum pending Invitations per group (`GROUP_MAX_PENDING_INVITATIONS_PER_GROUP`) and per invitee (`GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE`), and whether a re-invite delay after a decline is wanted (no default exists; this plan selects none). OD-04 (50, the required setting `GROUP_MAX_MEMBERS`) and the OD-08 expiry (604,800 s, a fixed constant, not a setting) are decided and are listed by pointer to T-5B-38, not re-decided. Until both maxima have values the Group_API switch stays off outside tests, and GROUP-MANAGEMENT cannot be approved.
      - It records the confirmation, at the DB-5C API contract approval, of the consequences derived from OD-05: G01 accepts the optional `historyPolicy` (`all` or `from_joined`, default `from_joined`), G04 refuses it with 400 `VALIDATION_ERROR`, the create fingerprint includes the policy (label v2), the role matrix refuses a policy change for every role, and `history_policy` is immutable after insert.
      - It confirms or amends the defaults OD-01 (the friendship sub-question: default no friendship rule beyond blocks), OD-02, OD-03, OD-06, OD-07, OD-09, OD-10, OD-11, OP-17 (PUT counts as a mutation; CI-37, a requirements edit awaiting approval) and OP-19 (values of the per-source limits), and states whether the runtime Gate_Record acknowledgement of OP-11 stays. The OP-18 decision is recorded by T-5C-54.
      - It approves or changes the order of request checks of CI-14 (session, CSRF, switch, rate limit). The amendments CI-04, CI-05, CI-07 and CI-08 are resolved in the requirements and are not decided again.
    - **Verify**: Project_Owner reviews the decision-log entries (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB5-R16.7, DB5-R16.8, DB5-R04.18, DB5-R12.2, DB5-R12.4, DB5-R12.11, DB5-R13.10, DB5-R01.15, DB5-R02.13_

  - [x] 2.50 Draft the GROUP-MANAGEMENT Gate_Record
    - **ID**: T-5C-50
    - **Depends on**: T-5C-48, T-5C-49
    - **Affected modules**: `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - The entry `GR-GROUP-MANAGEMENT-<date>` lists the evidence: the C1 command and its counts in the Validation_Runner (gate of record) with the Windows host run beside it as additional evidence, the documented contract (`groups-api.md`, `groups-openapi.json`), the OD-04 value (50) and the values recorded in T-5C-49 for the two pending-Invitation maxima, the confirmed defaults and the confirmation of the OD-05 consequences, the G8 result, and the commit identifier or the note that nothing is committed yet. The approval line is left empty for the Project_Owner.
      - `gate-records.test.js` still passes, which proves `.env.example` enables nothing.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8_

  - [x] 2.51 Port the group scenario of `server/test/db5_db6.test.cjs` into the canonical suite
    - **ID**: T-5C-51
    - **Depends on**: T-5C-17, T-5C-13, T-5B-32
    - **Affected modules**: `server/test/db5_db6.test.cjs` (read-only), `DATA/tests/groups-http.test.js`, `DATA/tests/groups-invitations.test.js`, `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - The observable steps of the standalone group scenario are listed from the file and reproduced against the canonical contract: create, non-member 404, member PATCH 403, ownership transfer, owner leave refused, removed member 404 (`groups-http.test.js`), and invite, list, accept (`groups-invitations.test.js`). Where the standalone test contradicts a requirement, the test follows the requirement (ARCH-R03.11): direct add with role member answers 503 because the OD-01 decision keeps direct add disabled.
      - The inventory records, for each step, the canonical test that replaces it (ARCH-R03.10). The post-and-history step is ported in T-5D-09 and the attachment steps in DB-6.
      - The standalone test file is untouched: G2 prints nothing.
    - **Verify**: `node --test tests/groups-http.test.js tests/groups-invitations.test.js` in DATA/; G2
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.4, ARCH-R03.10, ARCH-R03.11, DB5-R15.12_

  - [x] 2.52 Add the History_Policy creation-choice and immutability tests
    - **ID**: T-5C-53
    - **Depends on**: T-5C-07, T-5C-09, T-5C-17, T-5B-10
    - **Property P-41: The History_Policy is fixed at creation and never changes**
    - **Validates: Requirements DB5-R01.14, DB5-R01.15, DB5-R02.13, DB5-R08.1, DB5-R08.2, DB5-R15.2**
    - **Affected modules**: `DATA/tests/groups-model.test.js`
    - **Acceptance criteria**:
      - Creation choice (derived from OD-05, confirmed at the DB-5C API contract approval): `POST /api/groups` with `historyPolicy` `all` and with `from_joined` answers 201, and the group read through G03 and the extension record hold that value; with the field absent they hold `from_joined`. A supplied value that is not exactly `all` or `from_joined` (`null`, `ALL`, `From_Joined`, an empty string, a number, an object, an array) answers 400 `VALIDATION_ERROR` with `historyPolicy` in `fields` and creates no row.
      - The same key with the same trimmed name and description and a different policy (an omitted policy counting as `from_joined`) answers 409 `IDEMPOTENCY_CONFLICT` and creates no group. The same policy, or `from_joined` against an omitted policy, answers 200 with the original group.
      - Immutability: a PATCH that contains `historyPolicy` (`all`, `from_joined`, the stored value, another string, `null` or a number; alone or beside a valid name or description) answers 400 `VALIDATION_ERROR` with `historyPolicy` in `fields` for the owner of an unarchived group, never 503, and the snapshot of every group table, `GroupExtensions` included, is identical before and after. A member or admin gets 403, a non-member the uniform 404 and the owner of an archived group 409, because those checks precede it in the DB5-R02.15 order, and no role can change the policy (the role matrix row "Change History_Policy" is refused for owner, admin and member). A direct UPDATE of `history_policy` to another value is rejected by `group_extensions_update` and leaves the row unchanged.
      - The scenario test runs 50 sequences of 20 operations over 4 users and 1 to 2 groups with a printed seed: creation with the policy drawn from absent, `all` and `from_joined`; invite, accept, decline, cancel, clock advance, remove, leave, role change, transfer and archive; one step in four a PATCH attempt (values `all`, `from_joined`, the stored value, other strings, `null`, numbers; owner, admin, member and non-member; archived groups included); one step in ten a direct SQL UPDATE of `history_policy`; and creation pairs with one key and different policies. After every operation the policy read equals the value fixed at creation. Message send joins the operation list in T-5D-18.
    - **Verify**: `node --test tests/groups-model.test.js` in DATA/
    - **Agent**: Kiro

  - [x] 2.53 Prepare the OP-18 proposal for the "Data and future migrations" section in the handoff
    - **ID**: T-5C-54
    - **Depends on**: T-5B-33, T-5C-47
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (proposal text and decision-log entry); `docs/docker-development.md` is not edited unless the Project_Owner has approved OP-18
    - **Acceptance criteria**:
      - The handoff holds a section "Proposed update of docs/docker-development.md (OP-18)" with the exact replacement text for the section "Data and future migrations". The text names version 8 (`0008-groups.sql`) as shipped and keeps 0009 as a future migration until DB-6B ships, repeats the one-way warning (a database migrated to 0008 or higher cannot start under code without that migration, because the runner rejects extra ledger rows with `MIGRATION_HISTORY_MISMATCH`), repeats the cold-backup precondition by citing the guide's own procedure (no backup helper, DK-05 and DK-06), and points to `DATA/docs/migrations.md` and `DATA/docs/schema.md`. It also names, for the Project_Owner's review, the two sentences of the sections "Images and environment" and "Security and support boundary" that say no groups or attachment implementation or new migrations are supplied.
      - The task edits no Docker material: `compose.yaml`, every Dockerfile, `docker/*`, `.dockerignore` and `README.md` stay unchanged. `docs/docker-development.md` (INFRA-01 owns it) stays unchanged unless the Project_Owner has approved OP-18; with that approval only the section "Data and future migrations" changes, as the approved text, and the two sentences above change only as the owner decides.
      - The decision-log entry records the owner's answer (approved, amended or not yet approved) with a pointer to the text. With no approval the proposal stays in the handoff and the task ends there. The DB-6B handoff updates the text for 0009.
    - **Verify**: `git diff --exit-code dc6c997 -- compose.yaml docker server/Dockerfile client/Dockerfile .dockerignore README.md` exits 0; `git diff --exit-code dc6c997 -- docs/docker-development.md` exits 0 until the approval is recorded
    - **Agent**: Kiro
    - _Requirements: COMP-10, DB5-R14.15_

  - [x] 2.54 Phase gate DB-5C
    - **ID**: T-5C-52
    - **Depends on**: T-5C-01 to T-5C-51, T-5C-53, T-5C-54
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - C1 to C5 run in the Validation_Runner (the gate of record) on the final tree, and each result is recorded with command and group, passed, failed and skipped counts, date, `git rev-parse HEAD` and `git status --short`. C1 passes (at least 321 plus the new tests, 0 failed, 0 skipped, 0 cancelled, 0 todo) and `groups-openapi` passes inside it. C2 and C5 exit 0, and the lint and `build:verify` steps of the client group exit 0. C3 and C4 show 0 failed and 0 skipped with at least the counts of T-5B-01 and T-5B-02. The historical comparison from `dc6c997` contains the six previously accepted DB-5B client test/config changes and `client/tsconfig.json`; the DB-5C phase adds no other client changes. Under `server/`, the historical T-5C-06 `server/src/data/main.ts` change is preserved, and the Batch 5 tracked delta from `598ecb8` is empty. The same C1 to C5 run on the Windows host as additional evidence and are recorded beside the runner results: C1 and C3 pass. For Windows C4, the two named Known_Baseline_Failure tests and their prior failure signatures remain historical evidence; a current all-pass result is acceptable. No tests may be skipped, and any unlisted test failure fails the gate. The historical exact-two-failure count is not a required current outcome.
      - G1 to G9 run at the repository root: G1, G2, G4, G6 and G9 exit 0; G3, G5a, G7 and G8 print nothing; G5b prints only the seven DC-01 lines. Preserve the historical comparison `git diff --stat dc6c997 -- server client` and record its eight-path result: `client/jest.config.js`, `client/jest.setup.js`, `client/src/app/friends.test.tsx`, `client/src/app/page.test.tsx`, `client/src/realtime/__tests__/workspaceRealtime.test.tsx`, `client/src/voice/__tests__/voiceWorkspace.test.tsx` (the six previously accepted DB-5B paths introduced by `ae6c0ded874702a39529ea9a68ca6502551696f0`), `client/tsconfig.json`, and `server/src/data/main.ts` (T-5C-06). This historical set does not authorize new production changes. The Batch 5 tracked server/client delta must be empty under `git diff --exit-code 598ecb8 -- server client`; inspect untracked server/client paths and reject any new unapproved source files. Preserve the pre-existing `client/artifacts/phase8-8/` and `client/artifacts/phase8-8-hotfix/` directories; they are protected artifacts, not Batch 5 source changes.
      - With every switch off, every `/api/groups` route except feature-status answers 503, and no committed environment or Docker file enables a switch (G8 and `gate-records.test.js`).
      - The handoff records each run, the C1 run time, the run time of `groups-random.test.js` against the 120 s target and of the new group files against 5 minutes, the contract documents as merged, the values recorded by T-5C-49, the OP-18 outcome of T-5C-54, and the Known_Baseline_Failure list kept apart from the counts, with the Linux pass of the two tests read from `client-jest.json`. A failure that is not on that list keeps the phase open (DB5-R15.15).
      - No application container is started by the gate, and Compose Watch is off while a migration file is a draft (`git status --short -- DATA/server/database/migrations` prints nothing before any `docker compose watch`; DB5-R14.22). Every group test ran on a temporary database, never on the live database or a Docker volume (DB5-R14.17, DB5-R14.21). This phase adds no migration and runs no rehearsal; any rehearsal runs only on synthetic fixtures or an isolated cold-backup copy in a Disposable_Project (DB5-R14.24). A manual start of this code against data to keep needs the cold backup of both volumes first (DB5-R14.23). No Docker file or `README.md` is changed, and `docs/docker-development.md` only as T-5C-54 records.
      - The Gate_Record `GR-GROUP-MANAGEMENT-<date>` carries the Project_Owner's approval. This task stays unchecked until that approval is recorded.
    - **Verify**: C1 to C5 in the Validation_Runner (groups `data`, `server`, `client`); G1; G2; G3; G4; G5a; G5b; G6; G7; G8; G9; `git diff --stat dc6c997 -- server client`; `git diff --exit-code 598ecb8 -- server client`; inspect untracked server/client source paths
    - **Agent**: Kiro, with the Project_Owner approving the Gate_Record
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R15.16, DB5-R16.8, DB5-R14.17, DB5-R14.21, DB5-R14.22, DB5-R14.23, DB5-R14.24, ARCH-R02.1, COMP-01, COMP-10_

- [ ] 3. DB-5D: protected group messaging through the Message_Service, and the independent security review
  **Entry criteria.** DB-5C exit met (T-5C-52). The verifier contract is frozen in `groups-api.md` (T-5C-47). OP-10 (reviewer named) is a visible gate and is recorded by T-5D-01; OD-19 is a visible gate and is recorded before the review closes (T-5D-27). Decided earlier and applied here: OD-05 (a group's History_Policy, `all` or `from_joined`, is chosen at creation through G01 and never changes, so every history test creates its groups with the policy and no test or route changes it afterwards) and OD-04 (the member maximum is the required setting `GROUP_MAX_MEMBERS`, 50). Defaults in force: OD-07, OD-12 (private read position, no receipt list), OD-13 (sender only), OP-14. This phase adds no cryptographic design and no default verifier, so group messaging stays off for Real_Accounts until the GROUP-MESSAGING record exists. Docker: the gate of record is the Validation_Runner (the Windows host run is additional evidence); no application container is started; no Docker file is edited; Compose Watch stays off while a migration file is a draft; this phase adds no migration.

  - [ ] 3.1 Name the independent security reviewer (OP-10)
    - **ID**: T-5D-01
    - **Depends on**: T-5C-52
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The log names the reviewer, who did not write the code under review, and the report form the Project_Owner accepts (findings with severity, and each finding fixed or accepted in writing).
      - Without this entry no GROUP-MESSAGING record can exist, and group messaging stays off.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB5-R16.8_

  - [ ] 3.2 Create `messaging/group.js` with the gate, validation and prepare step
    - **ID**: T-5D-02
    - **Depends on**: T-5C-52
    - **Affected modules**: `DATA/server/messaging/group.js` (new), `DATA/tests/groups-messages.test.js` (new)
    - **Acceptance criteria**:
      - `createGroupMessageService` reuses `messaging/validation.js` (`envelope`, `fingerprint`), the `project(row)` projection, `repositories.messages.insertAuthenticated`, `findAuthenticatedClient`, `highWater` and `repositories.receipts`. `messaging/service.js` is not edited, and there is no second message table or `group_id` column.
      - The prepare step (immediate transaction) checks the gate (503 before any read), envelope validation (400, or 403 when the envelope names another sender; plaintext refused), `visibleGroup` and membership (404) and archive state (409), and reads the revision, the active members other than the sender and the policy. No transaction spans an await.
      - Envelope version 2 for a group answers 503 `RECIPIENT_KEYS_UNAVAILABLE` (OP-14), because the key directory returns null for groups.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R09.1, DB5-R09.2, DB5-R09.9, DB5-R09.10, DB5-R09.14, DB5-R09.15, DB5-R16.3_

  - [ ] 3.3 Add the verifier injection point and the verify step
    - **ID**: T-5D-03
    - **Depends on**: T-5D-02
    - **Affected modules**: `DATA/server/messaging/group.js`, `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - `messageOptions.groupRecipientKeyVerifier` is the only injection point and has no default. `verifyEnvelope(actor, envelope, {conversationId, recipientIds, membershipRevision, fingerprint})` runs outside any transaction with a 2000 ms deadline and a 32-call concurrency cap, as the direct path does.
      - A missing verifier, a verifier marked `testOnly` while `auth.config.production`, a throw or a timeout answers 503 `RECIPIENT_KEYS_UNAVAILABLE`. A result other than `{verified: true}` answers 403 `RECIPIENT_KEYS_UNVERIFIED`. Nothing is stored in either case.
      - No cryptographic primitive, key format or envelope format is introduced.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R09.11, DB5-R09.12, DB5-R09.14, DB5-R16.6_

  - [ ] 3.4 Add the write step with idempotency and the revision re-check
    - **ID**: T-5D-04
    - **Depends on**: T-5D-03
    - **Affected modules**: `DATA/server/messaging/group.js`, `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - The write transaction re-reads membership, archive state and revision. Not active gives 404, archived 409. The same sender, client id and fingerprint gives `duplicate` (200) whatever the revision. The same client id with another sender or fingerprint gives 409 `IDEMPOTENCY_CONFLICT`. A stored revision that differs from the verified one gives 409 `STALE_STATE` (OP-14).
      - Otherwise `message_seq = highWater + 1`, `receiver_id` is NULL, the message is stored, `touchConversation` runs and `message.stored` is audited in the same transaction. A failure rolls everything back.
      - Check order is gate, envelope, membership and archive, verifier, idempotency.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R09.3, DB5-R09.4, DB5-R09.5, DB5-R09.8, DB5-R09.18, DB5-R12.8, NFR-01_

  - [ ] 3.5 Add history, single-message read and tombstone
    - **ID**: T-5D-05
    - **Depends on**: T-5D-04
    - **Affected modules**: `DATA/server/messaging/group.js`, `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - `history` calls `visibleGroup` and `historyPage` so page selection and permitted ranges are one query: 20 per page by default, 50 at most, descending `message_seq`, a context-bound cursor that carries the first page's high-water. A removed or departed user gets 404. Empty permitted ranges give 200 with an empty page.
      - `get` answers 404 for a message outside the permitted ranges, the same as for an unknown id. `remove` tombstones only for the sender (OD-13), repeats return the stored tombstone, and a removed sender cannot remove (OD-07).
      - The direct history statements and their query plans are unchanged.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R08.5, DB5-R08.6, DB5-R08.7, DB5-R08.8, DB5-R08.10, DB5-R08.12, DB5-R08.13, DB5-R08.14, DB5-R09.2, DB5-R09.6, DB5-R09.17, DB5-R05.8_

  - [ ] 3.6 Add read position, receipts and unread counts
    - **ID**: T-5D-06
    - **Depends on**: T-5D-05
    - **Affected modules**: `DATA/server/messaging/group.js`, `DATA/server/groups/service.js`, `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - A position report stores the maximum and returns the stored value. A non-integer, a negative value, a value above the high-water, or a value above 0 outside the permitted ranges answers 400 and changes nothing. The unread count of a group counts permitted, non-tombstoned messages above the position sent by others and feeds `unreadCount` of G02.
      - `recordReceipt` creates at most one receipt per message, observer and status, only for a permitted message of another sender. Unknown, not permitted or own message answers 404 with no row. No other member's position or receipt is returned (OD-12 default).
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R10.1, DB5-R10.2, DB5-R10.3, DB5-R10.4, DB5-R10.5, DB5-R10.6, DB5-R10.7, DB5-R10.9, DB5-R10.10_

  - [ ] 3.7 Add the group `bindStore` store interface
    - **ID**: T-5D-07
    - **Depends on**: T-5D-06
    - **Affected modules**: `DATA/server/messaging/group.js`, `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - `bindStore(context, proof)` of the group service returns `storeMessage`, `findMessage` and `recordReceipt` for group ids, applying the membership, archive, envelope and verifier rules of the HTTP path and raising the same coded errors.
      - `messaging/service.js` is not edited. A group id through its `bindStore` still answers `NOT_FOUND` until DB-5E.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R09.13, DB5-R09.2, DB5-R09.8_

  - [ ] 3.8 Add the message write route (G19) and wire the service in `createApp`
    - **ID**: T-5D-08
    - **Depends on**: T-5D-07
    - **Affected modules**: `DATA/server/routes/groups.js`, `DATA/server/app.js`, `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - `POST /api/groups/:id/messages` (body limit 131072, JSON content type) answers 201 `{outcome: 'created', message}` or 200 `duplicate`, with the error codes of G19. A disabled `groupMessaging` switch answers 503 `FEATURE_UNAVAILABLE` and stores nothing.
      - `createApp` creates `createGroupMessageService` after `groups`, passes `messageOptions.groupRecipientKeyVerifier` and returns `groupMessages`. The existing direct wiring is unchanged and `dm-fixtures-replay` still passes.
    - **Verify**: `node --test tests/groups-messages.test.js tests/dm-fixtures-replay.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R09.9, DB5-R09.10, DB5-R09.11, DB5-R09.12, DB5-R09.18, DB5-R16.3, DB5-R16.6, ARCH-R01.4_

  - [ ] 3.9 Add history, single-message and tombstone routes (G18, G20, G21)
    - **ID**: T-5D-09
    - **Depends on**: T-5D-08, T-5C-51
    - **Affected modules**: `DATA/server/routes/groups.js`, `DATA/tests/groups-messages.test.js`, `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - `GET /api/groups/:id/messages?limit&cursor` answers 200 `{items, nextCursor}` with the direct message projection (`conversationId` the group id). `GET .../messages/:messageId` answers 200 `{message}` with the storage id. `DELETE .../messages/:messageId` answers 200 `{message}` for the sender only and 403 for another member.
      - Unknown query parameters, a bad limit or a bad cursor answer 400 and return no message. Outside the permitted ranges every route answers the uniform 404.
      - The post-and-history step of the standalone group scenario is reproduced by a canonical test, and the inventory records which test replaces it (ARCH-R03.4, ARCH-R03.10).
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R08.5, DB5-R08.13, DB5-R09.6, DB5-R09.17, DB5-R13.9, ARCH-R03.4, ARCH-R03.10_

  - [ ] 3.10 Add the read-state and receipt routes (G22 to G25)
    - **ID**: T-5D-10
    - **Depends on**: T-5D-09
    - **Affected modules**: `DATA/server/routes/groups.js`, `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - `GET /api/groups/:id/read-position` answers 200 `{readPosition}`. `PUT` with `{position}` goes through CSRF and the mutation bucket and answers 200 with the stored maximum. `POST .../messages/:messageId/receipts` with `{status: 'delivered'|'read'}` answers 201 or 200 `{outcome, receipt}`.
      - `GET .../receipts` (G25) answers 503 `FEATURE_UNAVAILABLE` until OD-12 selects visible receipts, so no response of any route carries another member's position or receipt (DB5-R10.7). Where a later OD-12 decision selects visible receipts, per-message read information goes only to Active_Members of the group (DB5-R10.8): this plan builds no visible-receipts form, but the route checks the membership before the 503, so a non-member, a pending invitee and a removed member get the uniform 404 and never any read information, and the later form inherits that order. A non-member gets the uniform 404 on all four routes.
      - The PUT of G23 uses the mutation bucket and CSRF (OP-17 default), as T-5C-39 tests for every method.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R10.2, DB5-R10.3, DB5-R10.4, DB5-R10.6, DB5-R10.7, DB5-R10.8, DB5-R10.9, DB5-R10.10, DB5-R12.2, DB5-R12.4_

  - [ ] 3.11 Write property test P-16 for message idempotency
    - **ID**: T-5D-11
    - **Depends on**: T-5D-10, T-5B-10
    - **Property P-16: Repeated submissions store nothing new**
    - **Validates: Requirements DB5-R09.3, DB5-R09.4, DB5-R09.10**
    - **Affected modules**: `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - For 2 to 5 members and client ids of 1 to 256 characters (some repeated), a repeat with the same id and fingerprint, also after other messages or a revision change, answers `duplicate` with 200 and leaves `Messages`, `MessageReceipts`, the high-water and `updated_at` unchanged.
      - The same id with another sender or fingerprint answers 409 `IDEMPOTENCY_CONFLICT` and stores nothing. A body that is not an envelope answers 400 (403 for another sender's name) and stores nothing.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.12 Write property test P-17 for gap-free sequences across processes
    - **ID**: T-5D-12
    - **Depends on**: T-5D-10, T-5C-18
    - **Property P-17: Concurrent writers get sequences 1 to K without gaps**
    - **Validates: Requirements DB5-R09.1, DB5-R09.3, DB5-R09.4, DB5-R09.5, DB5-R09.8, NFR-01**
    - **Affected modules**: `DATA/tests/groups-concurrency.test.js`, `DATA/tests/support/groups-worker.cjs`
    - **Acceptance criteria**:
      - For 2 to 6 worker processes sending 10 to 60 messages to one database file (about 20 percent repeated client ids, invalid envelopes, one member removed after a random number of sends), the stored `message_seq` values are exactly 1 to K, K equals the number of `created` responses, and each `created` response carries its stored sequence.
      - Duplicates store nothing and a refused write leaves no gap.
    - **Verify**: `node --test tests/groups-concurrency.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.13 Write property test P-18 for read position, unread count and receipts
    - **ID**: T-5D-13
    - **Depends on**: T-5D-10, T-5B-10
    - **Property P-18: The read position only grows and the unread count is exact**
    - **Validates: Requirements DB5-R08.8, DB5-R10.1, DB5-R10.2, DB5-R10.3, DB5-R10.4, DB5-R10.5, DB5-R10.9, DB5-R10.10, DB5-R14.12**
    - **Affected modules**: `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - For 1 to 30 reports (valid and invalid, some from two connections) the stored position equals the maximum of 0 and the valid reports, the response returns it, and a repeat changes nothing. An invalid report answers 400 and changes no row.
      - The unread count equals a brute-force count over the message log (permitted, not tombstoned, above the position, sent by others) for both policies and rejoined members. At most one receipt exists per message, observer and status, only for a permitted message of another sender.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.14 Write property test P-12 for visible history over join, leave and rejoin
    - **ID**: T-5D-14
    - **Depends on**: T-5D-10, T-5B-29
    - **Property P-12: Each member reads exactly the messages the event log entitles**
    - **Validates: Requirements DB5-R05.8, DB5-R08.6, DB5-R08.7, DB5-R08.9, DB5-R08.10, DB5-R15.6**
    - **Affected modules**: `DATA/tests/groups-history.test.js`
    - **Acceptance criteria**:
      - For 100 seeded sequences of 40 join, leave, rejoin, removal and send events by up to 6 users, an Active_Member's paged history contains exactly the messages sent while that user was active and, under policy `all`, those before the first join, and nothing sent between a leave and a rejoin. Each group is created with the policy `all`, `from_joined` or none (`from_joined`), through `POST /api/groups` or `insertGroup` with the supplied policy (OD-05 decided: the policy is chosen at creation), and no test changes the policy of an existing group, because no route does and the column is immutable after insert.
      - The oracle is an event log that does not import `groups/policy.js`. A removed or departed user gets 404 with no message. The seed of every sequence is printed.
    - **Verify**: `node --test tests/groups-history.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.15 Extend property test P-15 to the history traversal
    - **ID**: T-5D-15
    - **Depends on**: T-5D-14, T-5C-35
    - **Property P-15: Paged history is disjoint, ordered and stable (history part)**
    - **Validates: Requirements DB5-R08.5, DB5-R08.14, DB5-R09.6**
    - **Affected modules**: `DATA/tests/groups-pagination.test.js`
    - **Acceptance criteria**:
      - History pages of a member are pairwise disjoint and strictly descending in `message_seq`; every page except the last holds exactly `limit` items while that many permitted messages remain; the last page has no cursor; the union equals the permitted messages not above the first page's high-water.
      - A message stored between two page requests (one to five sends) never appears in the traversal.
    - **Verify**: `node --test tests/groups-pagination.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.16 Extend property test P-14 to history cursors
    - **ID**: T-5D-16
    - **Depends on**: T-5D-15, T-5C-34
    - **Property P-14: A tampered or foreign cursor is refused with 400 (history cursors)**
    - **Validates: Requirements DB5-R09.17, DB5-R02.6, DB5-R02.7**
    - **Affected modules**: `DATA/tests/groups-pagination.test.js`
    - **Acceptance criteria**:
      - Cursors taken from real first pages of G18 are altered or presented by another user, route or conversation. The answer is 400 `VALIDATION_ERROR` with `cursor` in `fields`, with no message returned, never 500 and no row changed.
      - An unknown parameter or a limit outside 1 to 50 on G18 answers 400 naming the parameter.
    - **Verify**: `node --test tests/groups-pagination.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.17 Add the latency example and the history query-plan checks
    - **ID**: T-5D-17
    - **Depends on**: T-5D-15
    - **Affected modules**: `DATA/tests/groups-pagination.test.js`, `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - A fixture of 100 groups for one user, 200 members in the largest group and 10000 messages in one group answers `GET /api/groups`, `GET /api/groups/:id/members` and one history page at the 95th percentile within 200 ms over at least 50 requests on a local temporary database. The figures are measured in the Validation_Runner (gate of record) and on the host and are recorded in the handoff; a miss in either is reported as a finding for the Project_Owner (CI-30, OP-07).
      - `EXPLAIN QUERY PLAN` of the group list, history and unread statements uses an index and never scans Messages or ConversationMembers in full. The plan of the direct history statement is still identical to version 7. A covering index is added only if a measurement requires it and only in a later migration decision of the Project_Owner.
    - **Verify**: `node --test tests/groups-pagination.test.js tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: NFR-02, NFR-03, NFR-04_

  - [ ] 3.18 Extend property test P-01 with message sends
    - **ID**: T-5D-18
    - **Depends on**: T-5D-14, T-5C-24, T-5C-53
    - **Property P-01: One active owner after every operation (with messages)**
    - **Validates: Requirements DB5-R06.2, DB5-R08.1, DB5-R08.9, DB5-R15.6**
    - **Affected modules**: `DATA/tests/groups-random.test.js`, `DATA/tests/groups-model.test.js`
    - **Acceptance criteria**:
      - The 100 sequences of 50 operations now include message send (through the test verifier). After every operation each user's readable messages equal those of the event-log oracle, besides the owner and `invariantReport` checks of T-5C-24.
      - The 50 sequences of the P-41 test of T-5C-53 (`groups-model.test.js`) gain message send in their operation list: after every send the History_Policy read still equals the value fixed at creation.
      - If the target of 120 s is missed, the per-operation visibility read moves from HTTP to the group Message_Service `history` function with the counts unchanged.
    - **Verify**: `node --test tests/groups-random.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.19 Extend property test P-24 with message submission
    - **ID**: T-5D-19
    - **Depends on**: T-5D-18, T-5C-28
    - **Property P-24: Archiving stops writes and deletes nothing (message part)**
    - **Validates: Requirements DB5-R07.2, DB5-R07.3, DB5-R07.4, DB5-R09.8**
    - **Affected modules**: `DATA/tests/groups-random.test.js`
    - **Acceptance criteria**:
      - After the archive commit every message submission answers 409 unless an earlier check refuses first, permitted history stays readable, and `Messages` and `MessageReceipts` counts never decrease for the group.
      - A member who sent messages can still leave the archived group, and the remaining members keep those messages (OD-07).
    - **Verify**: `node --test tests/groups-random.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.20 Extend property test P-25 with the messaging switch
    - **ID**: T-5D-20
    - **Depends on**: T-5D-10, T-5C-43
    - **Property P-25: A disabled function answers 503 and changes nothing (messaging)**
    - **Validates: Requirements DB5-R09.9, DB5-R15.8, DB5-R16.3, DB5-R16.6**
    - **Affected modules**: `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - Over all combinations of `groupApi` and `groupMessaging` with a ready or missing verifier, a message write answers 503 `FEATURE_UNAVAILABLE` when messaging is off and 503 `RECIPIENT_KEYS_UNAVAILABLE` when it is on without a ready verifier, and the snapshot of all tables is unchanged.
      - Reads of the Group_API still work when only messaging is off.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.21 Extend property test P-26 with verifier states
    - **ID**: T-5D-21
    - **Depends on**: T-5D-20, T-5C-44
    - **Property P-26: Switches follow the exact string and feature-status reports them (verifier states)**
    - **Validates: Requirements DB5-R16.6, DB5-R16.13**
    - **Affected modules**: `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - For every switch assignment and verifier state (none, test-only, ready), `GET /api/groups/feature-status` still answers exactly the three booleans and `groupMessaging` is true only while `groupApi` is true.
      - Without a session the answer is 401 in every verifier state, and a registered verifier never changes the answers of the other Group_API routes.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.22 Add the AF-08 regression
    - **ID**: T-5D-22
    - **Depends on**: T-5D-10
    - **Affected modules**: `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - Test `AF-08: a group message that is not a protected envelope is refused and nothing is stored` sends `{content: canary}`, a plain string as ciphertext, an envelope with extra fields and an envelope naming another sender, and gets 400, 400, 400 and 403.
      - With the switch off, no verifier, a test-only verifier under a production config and a refusing verifier the answers are 503 `FEATURE_UNAVAILABLE`, 503 `RECIPIENT_KEYS_UNAVAILABLE` (twice) and 403 `RECIPIENT_KEYS_UNVERIFIED`. `Messages` and `MessageReceipts` are unchanged and the canary appears nowhere in responses, stderr or audit rows.
    - **Verify**: `node --test tests/groups-messages.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R09.10, DB5-R09.11, DB5-R09.12, DB5-R16.3, DB5-R16.6, NFR-06_

  - [ ] 3.23 Extend the contract table and the actor-class matrix to G18 to G25
    - **ID**: T-5D-23
    - **Depends on**: T-5D-22, T-5C-38, T-5C-39
    - **Property P-21: A refused request changes no record (G18 to G25)**
    - **Validates: Requirements DB5-R13.10, DB5-R13.11, DB5-R15.2, DB5-R12.13, DB5-R09.2, DB5-R10.6, NFR-06, NFR-08**
    - **Affected modules**: `DATA/tests/support/contract.js`, `DATA/tests/groups-security.test.js`
    - **Acceptance criteria**:
      - `contract.js` gains the rows G18 to G25. The actor-class matrix, P-21 and P-22 now run over G01 to G26. Every route answers as listed, with security headers, the uniform 404 for non-member, pending invitee and removed member, and unchanged snapshots after each refusal.
      - Another member's tombstone request answers 403, a removed or departed sender answers 404, and G25 answers 503 until OD-12.
    - **Verify**: `node --test tests/groups-security.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.24 Extend property test P-20 with the message write order
    - **ID**: T-5D-24
    - **Depends on**: T-5D-23, T-5C-23
    - **Property P-20: The first failing check decides the answer (message write)**
    - **Validates: Requirements DB5-R09.9, DB5-R09.10, DB5-R09.11, DB5-R09.12, DB5-R09.18, DB5-R16.3, DB5-R16.6**
    - **Affected modules**: `DATA/tests/groups-model.test.js`
    - **Acceptance criteria**:
      - For subsets of failing conditions of one message write (switch, envelope, membership and archive, verifier, idempotency), the answer is that of the first failing check in the order of DB5-R09.18, and every refusal changes no row.
      - The oracle is an ordered list of (condition, status, code) transcribed from DB5-R09.18 and the design's error table, and a canary body never appears in a response.
    - **Verify**: `node --test tests/groups-model.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.25 Extend property tests P-30 and P-31 to message operations
    - **ID**: T-5D-25
    - **Depends on**: T-5D-24, T-5C-40, T-5C-41
    - **Property P-31: A failure at any write step leaves every table unchanged (message operations)**
    - **Validates: Requirements DB5-R12.8, DB5-R12.9, DB5-R13.5, DB5-R13.12, NFR-01, NFR-06**
    - **Affected modules**: `DATA/tests/audit-metadata.test.js`, `DATA/tests/groups-atomicity.test.js`
    - **Acceptance criteria**:
      - A stored message writes exactly one `message.stored` audit row with allowed keys only, and a refused write writes none. Canary text never appears in an audit row, log line or stderr line.
      - A failure injected at every write step of send, tombstone, read position and receipt (for each error class) leaves every table equal to its snapshot and answers the mapped status, 500 for an audit failure.
    - **Verify**: `node --test tests/audit-metadata.test.js tests/groups-atomicity.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 3.26 Extend `groups-api.md` and `groups-openapi.json` to G18 to G25
    - **ID**: T-5D-26
    - **Depends on**: T-5D-23
    - **Affected modules**: `DATA/docs/groups-api.md`, `DATA/docs/groups-openapi.json`
    - **Acceptance criteria**:
      - Both documents list G18 to G25 with request and response schemas, minimum role, status and code pairs and examples, the OD-07, OD-12 and OD-13 defaults, the OP-14 rules (envelope version 2 refused, `STALE_STATE`) and the message projection. They state that server-side visibility rules do not replace key-based confidentiality.
      - `groups-openapi.test.js` passes with the three-way route comparison over all 26 routes.
    - **Verify**: `node --test tests/groups-openapi.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.6, DB5-R13.7, DB5-R08.11, DB5-R09.17_

  - [ ] 3.27 Record the OD-19 decision on the group key model
    - **ID**: T-5D-27
    - **Depends on**: T-5D-01
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry records either that no key model is selected, so group messaging stays disabled, or that a model is selected for separate design and review outside this plan. No cryptographic design is made here.
      - It confirms or amends the OP-14 rules and the OD-07, OD-12 and OD-13 defaults.
      - It states that group messaging stays off for Real_Accounts until a verifier that meets the frozen contract is registered and the GROUP-MESSAGING record exists.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB5-R09.14, DB5-R16.6, DB5-R16.8_

  - [ ] 3.28 Independent security review of protected group messaging
    - **ID**: T-5D-28
    - **Depends on**: T-5D-25, T-5D-26, T-5D-27
    - **Affected modules**: `DATA/docs/db5d-security-review.md` (new; the reviewer's report, file name chosen here)
    - **Acceptance criteria**:
      - The reviewer, who did not write the code, reviews the group write path (prepare, verify, write), the verifier injection point with no default, the `testOnly` refusal in production, the version 2 refusal, the `STALE_STATE` rule, history visibility and receipts, log and error hygiene, and the OD-19 record. The review designs and changes no cryptography; it only reviews and records.
      - The report lists each finding with severity and a verdict. The Project_Owner accepts the report form named in T-5D-01.
    - **Verify**: Project_Owner accepts the report (no command applies); `node --test` in DATA/ still passes
    - **Agent**: Independent security reviewer
    - _Requirements: DB5-R16.8, DB5-R09.14, DB5-R09.11, DB5-R09.12_

  - [ ] 3.29 Fix or formally accept each review finding
    - **ID**: T-5D-29
    - **Depends on**: T-5D-28
    - **Affected modules**: `DATA/docs/db5d-security-review.md`, `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - Every finding is fixed (the change and the test that covers it are named in the report) or accepted in writing by the Project_Owner, and the report shows the final status of each. Code fixes belong to the module named in the finding and keep C1 green.
      - Accepted findings are copied into the known gaps of the handoff.
    - **Verify**: `node --test` in DATA/; Project_Owner reviews the final report
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8_

  - [ ] 3.30 Draft the GROUP-MESSAGING Gate_Record
    - **ID**: T-5D-30
    - **Depends on**: T-5D-29
    - **Affected modules**: `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - The entry `GR-GROUP-MESSAGING-<date>` cites the review report and the OD-19 record, the C1 counts in the Validation_Runner (gate of record, with the Windows host run beside it as additional evidence) and the state of GROUP-MANAGEMENT (DB5-R16.13). The approval line is left empty for the Project_Owner.
      - `gate-records.test.js` still passes.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8, DB5-R16.13_

  - [ ] 3.31 Phase gate DB-5D
    - **ID**: T-5D-31
    - **Depends on**: T-5D-01 to T-5D-30
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - C1 to C5 run in the Validation_Runner (the gate of record) on the final tree, and each result is recorded with command and group, passed, failed and skipped counts, date, `git rev-parse HEAD` and `git status --short`. C1 passes (at least 321 plus the new tests, 0 failed, 0 skipped, 0 cancelled, 0 todo). C2 and C5 exit 0, and the lint and `build:verify` steps of the client group exit 0. C3 and C4 show 0 failed and 0 skipped with at least the counts of T-5B-01 and T-5B-02 (nothing under `server/` or `client/` changes in this phase). The same C1 to C5 run on the Windows host as additional evidence and are recorded beside the runner results: C1 and C3 pass, and C4 fails exactly the two Known_Baseline_Failure entries and nothing else.
      - G1 to G9 run at the repository root: G1, G2, G4, G6 and G9 exit 0; G3, G5a, G7 and G8 print nothing; G5b prints only the seven DC-01 lines; and `git diff --stat dc6c997 -- server client` is unchanged from the DB-5C gate.
      - The handoff records each run, the measured latency and run times, and the Known_Baseline_Failure list kept apart from the counts with the Linux pass of the two tests. A failure that is not on that list keeps the phase open (DB5-R15.15). No application container is started by the gate, no Docker file is edited, and Compose Watch is off while a migration file is a draft.
      - The review report is delivered and every finding is fixed or accepted in writing. `GR-GROUP-MESSAGING-<date>` carries the Project_Owner's approval. This task stays unchecked until it does. Group messaging stays off for Real_Accounts until then, and OD-19 and OP-10 stay recorded as the visible gates of that record.
    - **Verify**: C1 to C5 in the Validation_Runner (groups `data`, `server`, `client`); G1; G2; G3; G4; G5a; G5b; G6; G7; G8; G9; `git diff --stat dc6c997 -- server client`
    - **Agent**: Kiro, with the Project_Owner approving the Gate_Record
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R15.16, DB5-R16.8, ARCH-R02.1, COMP-01, COMP-10_

- [ ] 4. DB-5E: realtime delivery and revocation for groups (Realtime_Bridge extension)
  **Entry criteria.** DB-5C exit met (T-5C-52). DB-5D exit met (T-5D-31) before the `bindStore` dispatch (T-5E-03), a PROPOSED edge of the design. No decision blocks this phase. OP-15 stays a visible point and is settled by the first task. The bridge keeps no database handle and imports no DATA code (`server/test/data/boundaries.test.ts` stays unchanged). `binder.ts` is not edited. Docker: the Realtime_Bridge and DATA run in the one backend process of the Docker_Environment (`npm --prefix server run start:data`), so no service, port or Compose change is needed. The bridge tests belong to the server suite and run in the Validation_Runner group `server` (C2, C3; the gate of record), with the Windows host run as additional evidence. They use test doubles and start no application container. A change under `server/src` reaches a running container only by `docker compose up --build` or by Compose Watch, which stays off while a migration file is a draft; no manual container test is part of this phase.

  - [ ] 4.1 Read the unread realtime files and the `conversation:updated` payload (OP-15)
    - **ID**: T-5E-01
    - **Depends on**: T-5C-52
    - **Affected modules**: `server/src/realtime/server.ts` (read-only), `server/src/realtime/authentication.ts` (read-only), `server/src/realtime/receipts.ts` (read-only), `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - The three files and the payload of `conversation:updated` are read in full. The handoff records whether that payload can carry a group membership hint, and how the realtime server reports a coded store error to a socket.
      - OP-15 is decided: reuse `conversation:updated` if its payload permits, otherwise one additive event that existing clients ignore (COMP-07).
      - No realtime file changes.
    - **Verify**: `git diff --exit-code d7cd40a -- server/src/realtime` at the repository root
    - **Agent**: Kiro
    - _Requirements: COMP-07, DB5-R05.11, DB5-R09.13_

  - [ ] 4.2 Add the status and membership interface to the Group_Service
    - **ID**: T-5E-02
    - **Depends on**: T-5C-52
    - **Affected modules**: `DATA/server/groups/service.js`, `DATA/tests/groups-model.test.js`
    - **Acceptance criteria**:
      - The object returned by `createApp` as `groups` offers `status()` (the three booleans of the gate), `membership.listRoomIds(context, page)` and `membership.canReceive(context, id)`. `canReceive` is true only for an Active_Member of a visible group, evaluated at call time, and false for everything else.
      - No member exposes a database handle, SQL or a repository.
    - **Verify**: `node --test tests/groups-model.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R01.7, DB5-R05.11, ARCH-R02.10_

  - [ ] 4.3 Dispatch `bindStore` by conversation kind inside DATA
    - **ID**: T-5E-03
    - **Depends on**: T-5E-02, T-5D-31
    - **Affected modules**: `DATA/server/messaging/service.js` (the `bindStore` dispatch only), `DATA/server/messaging/group.js`, `DATA/tests/groups-messages.test.js`
    - **Acceptance criteria**:
      - `bindStore` sends a direct conversation id to the unchanged direct code and a group id to the group store. A group store with a disabled switch stores nothing and raises the coded error of the HTTP path.
      - The diff of `messaging/service.js` shows only the dispatch. `dm-fixtures-replay` and the baseline messaging tests pass unchanged.
    - **Verify**: `node --test tests/groups-messages.test.js tests/dm-fixtures-replay.test.js` in DATA/; C1
    - **Agent**: Kiro
    - _Requirements: DB5-R09.13, ARCH-R02.3, ARCH-R02.4_

  - [ ] 4.4 Extend `DataApplication` with the optional `groups` member
    - **ID**: T-5E-04
    - **Depends on**: T-5E-02
    - **Affected modules**: `server/src/data/types.ts`, `server/test/data/groups-types.test.ts` (new)
    - **Acceptance criteria**:
      - `DataApplication` gains an optional `groups` member (`status()`, `membership.listRoomIds(context, page)`, `membership.canReceive(context, id)`). `assertDataApplication` checks it only when present: an application without `groups` is accepted and a malformed `groups` is rejected.
      - The type still has no `db`, asserted by the test. `boundaries.test.ts` passes unchanged.
    - **Verify**: `npm run type-check` in server/; `node --test --test-concurrency=1 --test-timeout=60000 test/data/groups-types.test.ts test/data/boundaries.test.ts` in server/ (host, quick feedback; the file runs inside C3 in the Validation_Runner group `server`)
    - **Agent**: Kiro
    - _Requirements: ARCH-R01.7, ARCH-R02.6_

  - [ ] 4.5 Add group rooms and delivery checks to `authorizer.ts`
    - **ID**: T-5E-05
    - **Depends on**: T-5E-04
    - **Affected modules**: `server/src/data/authorizer.ts`
    - **Acceptance criteria**:
      - `listConversationIds` appends group ids only when `groups.status()` reports both `groupApi` and `groupMessaging` on. `canReceive` asks the direct path first and, for an id the direct path does not know, asks `groups.membership.canReceive`.
      - A throwing `canReceive` or a malformed status denies delivery and grants no group room. Without `groups` the direct behaviour is identical.
      - The seven existing `server/test/data` files pass unchanged.
    - **Verify**: C2 and C3 (`npm run type-check` and `npm test` in server/; Validation_Runner group `server`, with the host run for quick feedback)
    - **Agent**: Kiro
    - _Requirements: DB5-R05.11, DB5-R09.13, ARCH-R02.6, ARCH-R02.10_

  - [ ] 4.6 Add the revocation and refresh hints to `changes.ts`
    - **ID**: T-5E-06
    - **Depends on**: T-5E-05, T-5E-01
    - **Affected modules**: `server/src/data/changes.ts`, `DATA/docs/groups-api.md`
    - **Acceptance criteria**:
      - New `ROUTES` entries: `DELETE /api/groups/:id/members/:userId` (204) revokes the target at once with `revokeConversationAccess(targetId, groupId)` (the target id comes from the path) and then refreshes; `POST /api/groups/:id/leave` (204) revokes the actor; accept (200), direct add (201), role change (200), transfer (200), archive (200) and create (201) call `refreshAllAccess`. The effect type gains `revokeConversationAccess` and `refreshUserAccess`.
      - Hints run only after a success status. A hint call that throws changes no HTTP result. Existing clients ignore the hint event (COMP-07), and `groups-api.md` documents the event chosen in T-5E-01.
    - **Verify**: C2 and C3 (`npm run type-check` and `npm test` in server/; Validation_Runner group `server`, with the host run for quick feedback)
    - **Agent**: Kiro
    - _Requirements: DB5-R05.11, COMP-07, ARCH-R02.10_

  - [ ] 4.7 Write property test P-40 for bridge delivery
    - **ID**: T-5E-07
    - **Depends on**: T-5E-06, T-5E-03
    - **Property P-40: Group events reach only current Active_Members**
    - **Validates: Requirements DB5-R05.11, DB5-R09.13, ARCH-R01.7, ARCH-R02.6, ARCH-R02.10, COMP-07**
    - **Affected modules**: `server/test/data/groups-bridge.test.ts` (new)
    - **Acceptance criteria**:
      - All orderings of 4 events (group message commit, removal commit, hint, periodic revalidation, delivery attempt) for 3 users, 4 hint modes (on time, late, lost, duplicated) and 4 switch states run against test doubles of the realtime handle. `canReceive` throwing and a malformed `groups.status()` are included.
      - A group event reaches user U only while U is an Active_Member when `canReceive` runs, never after the removal on any connection of U, and no group room is granted unless both switches are on. A `DataApplication` without `groups` and every direct event keep the baseline event names, payload fields and recipients.
    - **Verify**: `node --test --test-concurrency=1 --test-timeout=60000 test/data/groups-bridge.test.ts` in server/ (host, quick feedback; the file runs inside C3 in the Validation_Runner group `server`, which is the gate of record)
    - **Agent**: Kiro

  - [ ] 4.8 Draft the GROUP-REALTIME Gate_Record
    - **ID**: T-5E-08
    - **Depends on**: T-5E-07
    - **Affected modules**: `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - The entry `GR-GROUP-REALTIME-<date>` cites the C1, C2 and C3 results in the Validation_Runner (gate of record, with the Windows host run beside them as additional evidence), the P-40 test and the OP-15 outcome, and leaves the approval line empty for the Project_Owner.
      - `gate-records.test.js` still passes.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8_

  - [ ] 4.9 Phase gate DB-5E
    - **ID**: T-5E-09
    - **Depends on**: T-5E-01 to T-5E-08
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - C1 to C5 run in the Validation_Runner (the gate of record) on the final tree, and each result is recorded with command and group, passed, failed and skipped counts, date, `git rev-parse HEAD` and `git status --short`. C1 passes (at least 321 plus the new tests, 0 failed, 0 skipped, 0 cancelled, 0 todo). C2 and C5 exit 0, and the lint and `build:verify` steps of the client group exit 0. C3 shows 0 failed and 0 skipped with at least the count of T-5B-01 plus the new tests, and `groups-bridge` and `groups-types` run inside it. C4 shows 0 failed and 0 skipped with at least the count of T-5B-02 (nothing under `client/` changes). The same C1 to C5 run on the Windows host as additional evidence and are recorded beside the runner results: C1 and C3 pass, and C4 fails exactly the two Known_Baseline_Failure entries and nothing else.
      - G1 to G9 run at the repository root: G1, G2, G4, G6 and G9 exit 0; G3, G5a, G7 and G8 print nothing; G5b prints only the seven DC-01 lines. The seven `server/test/data` files and both standalone server tests pass unchanged.
      - No group event is emitted while a switch is off. The handoff records each run, the OP-15 outcome and the Known_Baseline_Failure list kept apart from the counts. A failure that is not on that list keeps the phase open (DB5-R15.15). No application container is started by the gate, no Docker file is edited, and Compose Watch is off while a migration file is a draft.
      - `GR-GROUP-REALTIME-<date>` carries the Project_Owner's approval. This task stays unchecked until it does.
    - **Verify**: C1 to C5 in the Validation_Runner (groups `data`, `server`, `client`); G1; G2; G3; G4; G5a; G5b; G6; G7; G8; G9
    - **Agent**: Kiro, with the Project_Owner approving the Gate_Record
    - _Requirements: DB5-R15.10, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R16.8, ARCH-R02.1, ARCH-R02.6, COMP-01, COMP-10_

- [ ] 5. DB-5F: group UI behind a client switch and the server feature-status response (Codex only)
  **Entry criteria.** DB-5C and DB-5D exits met (T-5C-52, T-5D-31), so `DATA/docs/groups-api.md` and `DATA/docs/groups-openapi.json` are merged. No decision blocks this phase; the Project_Owner acknowledges the CI-11 expectation change (T-5F-01). Codex derives screens, labels, layout and states from that API contract; this plan fixes only behavior and gating. The contract settles the History_Policy (OD-05): G01 takes an optional `historyPolicy`, and no route changes it afterwards. No server change, no `/api/attachments` or `/api/files` rewrite, and the strict direct parser and the 76 client attachment tests stay unchanged. Docker: client unit tests run in the Validation_Runner group `client` (C4, C5, lint and `build:verify`; the gate of record), and every `npm test` or `npm run type-check` line below is a host run for quick feedback; the Windows host run is additional evidence, where C4 fails exactly the two Known_Baseline_Failure entries. The client switch `NEXT_PUBLIC_GROUPS_UI_READY` reaches the frontend container only through `compose.yaml` (host environment files are not injected); this plan edits no Docker file, so the shipped project leaves the switch unset and the UI disabled, and a committed flag in `compose.yaml` is a separate Project_Owner act (DB5-R16.8). For a manual test the flag is set in a temporary override file kept outside the repository and the frontend container is recreated; a change of `client/authProxy.cjs` or `client/next.config.js` needs an image rebuild (`docker compose up --build`), because both files are copied into the frontend image and are not bind-mounted. A manual test runs only in a project with no real account data, and the group message composer stays off until the GROUP-MESSAGING record exists.

  - [ ] 5.1 Record the Project_Owner acknowledgement of the CI-11 expectation change
    - **ID**: T-5F-01
    - **Depends on**: T-5D-31
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry acknowledges that the `gate-records.test.js` expectation "no `/api/groups` rewrite in the client" changes for the `/api/groups` prefix only in the DB-5F change set, while the expectation for `/api/attachments` and `/api/files` stays until DB-6E.
      - The entry carries the date and the Project_Owner's name, and states that DB-6E needs its own acknowledgement for the other two prefixes.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB5-R16.11_

  - [ ] 5.2 Read the contract and the client code that the UI touches, and plan the files
    - **ID**: T-5F-02
    - **Depends on**: T-5F-01
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (planned-files note); the client files are read only
    - **Acceptance criteria**:
      - Codex reads `groups-api.md`, `groups-openapi.json` and the client hooks, components and messenger entry points that the design did not read (CI-25), and records in the handoff the new file paths and component names it chooses, each tied to a route or rule of the contract.
      - The note lists what the UI will not offer under the decisions and defaults in force: direct add (OD-01), unarchive and deletion (OD-09), any change of the History_Policy after creation (OD-05: it is chosen in the creation form and shown read-only afterwards) and visible receipts (OD-12).
    - **Verify**: `npm run type-check` in client/ (no file changed)
    - **Agent**: Codex
    - _Requirements: DB5-R16.9, DB5-R16.10, DB5-R16.14, COMP-06_

  - [ ] 5.3 Add the `/api/groups` rewrite and update the guard expectation
    - **ID**: T-5F-03
    - **Depends on**: T-5F-02, T-5C-48
    - **Affected modules**: `client/authProxy.cjs`, `client/next.config.js`, `DATA/tests/gate-records.test.js` (one expectation, `/api/groups` prefix only)
    - **Acceptance criteria**:
      - Both client files rewrite `/api/groups` and its sub-paths to the DATA application, in the same style as the existing auth, social and messaging rewrites. No `/api/attachments` or `/api/files` rewrite is added.
      - `gate-records.test.js` now expects the `/api/groups` rewrite and still fails if a rewrite for `/api/attachments` or `/api/files` appears. A client test asserts the same three facts.
      - `client/authProxy.cjs` and `client/next.config.js` are copied into the frontend image, so a manual check of the rewrite in the Docker_Environment needs `docker compose up --build` (a restart or Compose Watch does not carry them). The handoff states this, and no Docker file changes.
    - **Verify**: `npm test` in client/; `node --test tests/gate-records.test.js` in DATA/ (both inside the Validation_Runner groups `client` and `data` at the phase gate)
    - **Agent**: Codex
    - _Requirements: DB5-R16.11_

  - [ ] 5.4 Add the client switch and the feature-status handling
    - **ID**: T-5F-04
    - **Depends on**: T-5F-03
    - **Affected modules**: new client module for feature-status handling and the `NEXT_PUBLIC_GROUPS_UI_READY` switch (path chosen by Codex), the client environment example if one lists the existing `NEXT_PUBLIC_ATTACHMENT_API_READY` (the new flag is listed there as `false`, never `true`; no Docker file is touched)
    - **Acceptance criteria**:
      - The switch counts as on only for the exact string `true`. The module fetches `GET /api/groups/feature-status` and accepts only the exact shape `{groupApi, groupMessaging, attachmentApi}` of booleans.
      - With the switch unset, or the response missing, failed or not matching, all three functions count as disabled for Real_Accounts: no group screen, no navigation entry and no composer.
      - `NEXT_PUBLIC_GROUPS_UI_READY` is supplied through `compose.yaml` only in the Docker_Environment (host environment files are not injected), and this task edits no Docker file and sets the flag to `true` in no committed file: the shipped project leaves it unset, which is the disabled state (G8 prints nothing). A manual test sets it in a temporary override file outside the repository and recreates the frontend container; the Project_Owner approves any committed `compose.yaml` change as a separate act. The handoff records this procedure.
      - Tests cover unset, malformed, failed fetch and each combination of the three booleans.
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB5-R16.9, DB5-R16.10, DB5-R16.14_

  - [ ] 5.5 Add the typed group API client
    - **ID**: T-5F-05
    - **Depends on**: T-5F-04
    - **Affected modules**: new client module for the `/api/groups` requests (path chosen by Codex); `client/src/security/e2ee/api.ts` is not edited
    - **Acceptance criteria**:
      - One request function per route the UI uses (G01 to G17 and G18 to G25), with same-origin fetch, the CSRF handling the existing client uses, strict parsing of the documented projections (the group projection carries `historyPolicy`) and error mapping from `{code, fields}`. The create function takes an optional `historyPolicy` of `all` or `from_joined`; the update function has no `historyPolicy` parameter, because G04 refuses it. Unknown response keys or types are refused as the direct parser does.
      - Tests run against mocked responses taken from the OpenAPI examples, including the uniform 404, 409 `STALE_STATE` and 503 `FEATURE_UNAVAILABLE`.
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB5-R13.1, DB5-R13.2, DB5-R13.9, COMP-06_

  - [ ] 5.6 Build the group list, creation form and navigation entry
    - **ID**: T-5F-06
    - **Depends on**: T-5F-05
    - **Affected modules**: new client screens and the navigation entry (paths chosen by Codex)
    - **Acceptance criteria**:
      - The navigation entry and the list screen render only while the Group_API is reported enabled and the client switch is on. The list shows name, role, unread count and archived state, pages with the cursor, and never shows a group in the direct conversation list.
      - The creation form sends name, optional description, the optional History_Policy choice (`all` or `from_joined`; none sent means `from_joined`) and one idempotency key per submit attempt, and shows the 400 `fields` it receives, `historyPolicy` included. The choice is offered only here.
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB5-R16.9, DB5-R01.1, DB5-R01.14, DB5-R01.15, DB5-R02.4, DB5-R02.8_

  - [ ] 5.7 Build the group detail screen and the membership actions
    - **ID**: T-5F-07
    - **Depends on**: T-5F-06
    - **Affected modules**: new client group-detail screen and action components (paths chosen by Codex)
    - **Acceptance criteria**:
      - The screen shows metadata (the History_Policy read-only), the member list and, for owner and admin, the former members. Each action appears only for the roles of the DB5-R06.13 matrix: remove, role change, transfer, leave (not for the owner), archive (owner). An archived group is read-only except leaving.
      - A 404 shows a not-found state, a 409 `STALE_STATE` offers a reload, and the screen offers no direct add (OD-01), unarchive, delete, History_Policy change (OD-05: no role can change it) or receipt list.
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB5-R16.9, DB5-R06.13, DB5-R05.1, DB5-R05.6, DB5-R07.2, DB5-R07.3, DB5-R08.1_

  - [ ] 5.8 Build the invitation UI
    - **ID**: T-5F-08
    - **Depends on**: T-5F-07
    - **Affected modules**: new client invitation components (paths chosen by Codex)
    - **Acceptance criteria**:
      - Owners and admins can invite a user, list pending Invitations of the group and cancel one. An invitee sees the own pending list (group name and inviter display name only) and can accept or decline. The accept result 409 is shown as "no longer valid" without revealing why.
      - No invitation control is shown to a member, and none while the Group_API is disabled.
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB5-R16.9, DB5-R04.1, DB5-R04.6, DB5-R04.9, DB5-R04.13, DB5-R04.14_

  - [ ] 5.9 Gate the group message area and composer on the messaging status
    - **ID**: T-5F-09
    - **Depends on**: T-5F-08
    - **Affected modules**: new client group message components (paths chosen by Codex)
    - **Acceptance criteria**:
      - No composer renders while the server reports group messaging disabled, the group is archived or the user is not an Active_Member. When messaging is enabled, history pages through G18 with the cursor and the composer submits through an injected sender.
      - The task writes no cryptographic code and no group key handling (OD-19, Explicit Exclusion 2). Tests use a sender double.
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB5-R16.10, DB5-R16.14, DB5-R09.14_

  - [ ] 5.10 Add the client guard tests for disabled state and unchanged contracts
    - **ID**: T-5F-10
    - **Depends on**: T-5F-09
    - **Affected modules**: new client test files (names chosen by Codex)
    - **Acceptance criteria**:
      - With the client switch unset or the status response malformed, a render of the messenger shows no group navigation, screen or composer. The strict direct parser still rejects a group in a conversation list.
      - `client/src/security/e2ee/api.ts` and the 8 client attachment test files are unchanged: `git diff --exit-code d7cd40a -- client/src/security/e2ee/api.ts` exits 0 and G4 exits 0.
    - **Verify**: `npm test` and `npm run type-check` in client/; G4
    - **Agent**: Codex
    - _Requirements: DB5-R16.9, DB5-R16.10, DB5-R16.14, COMP-06, ARCH-R03.9_

  - [ ] 5.11 Draft the GROUP-FRONTEND Gate_Record
    - **ID**: T-5F-11
    - **Depends on**: T-5F-10
    - **Affected modules**: `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - The entry `GR-GROUP-FRONTEND-<date>` cites the C4 and C5 results in the Validation_Runner group `client` (gate of record), the Windows host results beside them as additional evidence, the Known_Baseline_Failure entries listed apart, the guard tests and the note that the client switch and the status response agree, and leaves the approval line empty for the Project_Owner.
      - `gate-records.test.js` still passes, which shows that no committed environment file enables a switch.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Codex
    - _Requirements: DB5-R16.8_

  - [ ] 5.12 Phase gate DB-5F
    - **ID**: T-5F-12
    - **Depends on**: T-5F-01 to T-5F-11
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - C1 to C5 run in the Validation_Runner (the gate of record) on the final tree, and each result is recorded with command and group, passed, failed and skipped counts, date, `git rev-parse HEAD` and `git status --short`. C4 shows 0 failed and 0 skipped with at least the count of T-5B-02 plus the new client tests, including the two Known_Baseline_Failure tests passing on Linux (read from `client-jest.json`). C5 exits 0, and the lint and `build:verify` steps of the client group exit 0. C1, C2 and C3 pass with at least their earlier counts (no server change). The same C1 to C5 run on the Windows host as additional evidence and are recorded beside the runner results: C1 and C3 pass, and C4 fails exactly the two Known_Baseline_Failure entries and nothing else.
      - G1 to G9 run at the repository root: G1, G2, G4, G6 and G9 exit 0; G3, G5a, G7 and G8 print nothing; G5b prints only the seven DC-01 lines. The only new rewrite is `/api/groups`, and `git diff --stat dc6c997 -- server` lists the same files as at the DB-5E gate (no server change in this phase). No group screen, entry or composer renders while a switch is off, and G8 shows no committed Docker file that sets `NEXT_PUBLIC_GROUPS_UI_READY` or any other switch.
      - The handoff records each run, the Known_Baseline_Failure list kept apart from the counts, the rebuild rule for `client/authProxy.cjs` and `client/next.config.js` and the override-file procedure for `NEXT_PUBLIC_GROUPS_UI_READY`. A failure that is not on that list keeps the phase open (DB5-R15.15). No application container is started by the gate, and no Docker file is edited.
      - `GR-GROUP-FRONTEND-<date>` carries the Project_Owner's approval. This task stays unchecked until it does.
    - **Verify**: C1 to C5 in the Validation_Runner (groups `data`, `server`, `client`); G1; G2; G3; G4; G5a; G5b; G6; G7; G8; G9; `git diff --stat dc6c997 -- server`
    - **Agent**: Codex, with the Project_Owner approving the Gate_Record
    - _Requirements: DB5-R15.10, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R16.8, DB5-R16.9, DB5-R16.10, DB5-R16.11, COMP-06, COMP-10_

- [ ] 6. DB-5G: final acceptance of DB-5
  **Entry criteria.** The records GROUP-MANAGEMENT, GROUP-MESSAGING, GROUP-REALTIME and GROUP-FRONTEND exist, or the Project_Owner records a missing stage as a known gap (OP-16, T-5G-01). OD-20 is recorded before any Standalone_Implementation code is marked deprecated (T-5G-02). OD-19 and OP-10 stay the visible gates of the GROUP-MESSAGING record; if it is waived, group messaging stays disabled for Real_Accounts. This phase adds no feature and no endpoint, enables no switch, and changes no Standalone_Implementation file (G2 stays empty). Nothing of the standalone code is deleted in this or any later phase of this plan. Docker: the acceptance runs use the Validation_Runner as the gate of record, with the Windows host results as additional evidence and the Known_Baseline_Failure list recorded separately; no application container is started and no Docker file is edited. The handoff names the Standalone_Implementation host by `server/api-main.cjs`, `npm run start:api` and `API_PORT`, never by a port number alone, and states that in the Docker_Environment port 3001 is the browser-facing address of the application.

  - [ ] 6.1 Record the Project_Owner decision on missing stage records (OP-16)
    - **ID**: T-5G-01
    - **Depends on**: T-5C-52, T-5D-30, T-5E-08, T-5F-11
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry lists the state of the four DB-5 stage records. By default all four are required. If one cannot be approved (for example GROUP-MESSAGING while OD-19 is open), the Project_Owner waives it in writing and the handoff lists it as a known gap.
      - A waiver names the stage and the reason, and states that the function stays disabled for Real_Accounts.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB5-R16.8, ARCH-R02.8_

  - [ ] 6.2 Record the Project_Owner decision on standalone data (OD-20)
    - **ID**: T-5G-02
    - **Depends on**: T-5C-52
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry confirms the default (no row of the standalone database is migrated and its file is never opened or modified) or asks for a migration. A request for a migration opens a new specification, because this plan contains no import tool.
      - The decision stands before any deprecation marker is written (DB-6F).
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB5-R14.19, ARCH-R03.12_

  - [ ] 6.3 Write property test P-32 for the kill and message variants
    - **ID**: T-5G-03
    - **Depends on**: T-5C-42, T-5D-12, T-5D-13
    - **Property P-32: Stop, start and kill change nothing that was acknowledged (full variant)**
    - **Validates: Requirements DB5-R11.1, DB5-R11.2, DB5-R11.3, DB5-R11.4, DB5-R11.5, DB5-R11.6, DB5-R11.7, DB5-R14.17, DB5-R15.7, DB5-R15.16**
    - **Affected modules**: `DATA/tests/groups-restart.test.js`, `DATA/tests/support/groups-worker.cjs`
    - **Acceptance criteria**:
      - History pages, read positions and unread counts join the projections compared before and after a stop and start. A `groups-worker.cjs` child killed with `SIGKILL` right after a 2xx write response (create, accept, removal, message send, read position) shows that change after the next start.
      - A test-only worker command `hold-write` opens an immediate transaction, performs one write through the Group_Repository, reports ready and waits to be killed. After the kill the row is absent.
      - The worker, the kill variants and every restart sequence run on database files in new temporary directories, in the Validation_Runner (Linux, group `data`) as well as on the Windows host. A platform difference in process termination or paths is a branch of the test and never a skip (DB5-R15.16, NFR-07). No container, Docker volume or `DATA/server/database/database.sqlite` is opened (DB5-R11.6, DB5-R14.17).
    - **Verify**: `node --test tests/groups-restart.test.js` in DATA/ (host, quick feedback); the Validation_Runner group `data` (C1) is the gate of record
    - **Agent**: Kiro

  - [ ] 6.4 Run the direct-message fixture replay in every gate state
    - **ID**: T-5G-04
    - **Depends on**: T-5B-31, T-5D-10, T-5E-03
    - **Property P-19: Direct conversations and messages are unchanged by groups (all gate states)**
    - **Validates: Requirements DB5-R02.8, DB5-R09.16, DB5-R15.4, ARCH-R02.2, ARCH-R02.3, ARCH-R02.4, COMP-06**
    - **Affected modules**: `DATA/tests/dm-fixtures-replay.test.js`
    - **Acceptance criteria**:
      - The baseline fixtures of direct send, history, receipts, lifecycle and key-directory routes replay with the recorded status, fields and code in all 8 combinations of the three switches, with groups, Invitations and group messages present.
      - `GET /api/conversations` keeps the exact shape the client parses, group ids to direct routes and direct ids to group routes answer 404, and no row changes.
    - **Verify**: `node --test tests/dm-fixtures-replay.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 6.5 Run the full DATA and server regression
    - **ID**: T-5G-05
    - **Depends on**: T-5G-03, T-5G-04, T-5E-09
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (results note)
    - **Acceptance criteria**:
      - C1, C2 and C3 run in the Validation_Runner (groups `data` and `server`, the gate of record) on the current tree. C1 passes with 0 failed, 0 skipped, 0 cancelled and 0 todo. C3 shows 0 failed and 0 skipped with at least the baseline count of T-5B-01 plus the new tests. The same commands run on the Windows host as additional evidence and are noted beside the runner results with the platform named. The seven `server/test/data` files and both standalone server tests pass unchanged (G6, G2).
      - G1, G3, G5a and G5b give their passing results, and each run is noted with command and group, counts and date.
    - **Verify**: C1 to C3 in the Validation_Runner (groups `data`, `server`); G1; G2; G3; G5a; G5b; G6
    - **Agent**: Kiro
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, ARCH-R02.1, COMP-01_

  - [ ] 6.6 Run the client regression
    - **ID**: T-5G-06
    - **Depends on**: T-5F-12
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (results note)
    - **Acceptance criteria**:
      - C4 and C5 run in the Validation_Runner group `client` (the gate of record, with its lint and `build:verify` steps) on the current tree. C4 shows 0 failed and 0 skipped with at least the baseline count of T-5B-02 plus the new client tests, and the 8 client attachment test files and the strict direct parser are unchanged (G4).
      - The same C4 and C5 run on the Windows host as additional evidence and are noted beside the runner results with the platform named: C4 fails exactly the two Known_Baseline_Failure entries and nothing else, and those entries are listed apart from the counts, with their Linux pass read from `client-jest.json`. G9 exits 0, so `messengerAI.test.tsx` is unchanged.
      - Each run is noted with command and group, counts and date.
    - **Verify**: C4 and C5 in the Validation_Runner (group `client`); G4; G9
    - **Agent**: Codex
    - _Requirements: DB5-R15.13, ARCH-R03.9, COMP-06_

  - [ ] 6.7 Finalise the contract documents
    - **ID**: T-5G-07
    - **Depends on**: T-5G-05
    - **Affected modules**: `DATA/docs/groups-api.md`, `DATA/docs/groups-openapi.json`
    - **Acceptance criteria**:
      - Both documents match the merged code for all 26 routes: request and response schemas, minimum role, status and code lists, additional codes, feature-status, variables and the defaults in force. Every example validates and the three-way route comparison passes.
      - Known gaps of the contract (open OD and OP items) are listed in the documents.
    - **Verify**: `node --test tests/groups-openapi.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.6, DB5-R13.7, DB5-R13.8, DB5-R13.11_

  - [ ] 6.8 Check requirements coverage for DB-5
    - **ID**: T-5G-08
    - **Depends on**: T-5G-07
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (coverage section), `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The coverage section maps every criterion of DB5-R01 to DB5-R16, ARCH-R01 to ARCH-R03 (DB-5 scope), NFR-01 to NFR-09 and COMP-01 to COMP-10 to a passing test (file and test name or property id) or to a document, using the design's property matrix and Testing Strategy section 2. The criteria that the DB-5A reconciliation changed or added (DB5-R01.14, R01.15, DB5-R02.1, R02.13, DB5-R03.5, R03.6, R03.12, DB5-R04.1, R04.18, DB5-R07.2, DB5-R10.8, DB5-R12.2, R12.11, DB5-R13.2, R13.10, DB5-R14.21 to R14.24, DB5-R15.10 to R15.16, DB5-R16.7, ARCH-R01.9 and COMP-10) each name their task or document. A criterion with no covering test is listed as a known gap.
      - `gate-records.test.js` fails when a DB5-R, ARCH-R, NFR or COMP identifier is absent from the coverage section.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R15.1, DB5-R15.11, DB5-R15.13_

  - [ ] 6.9 Complete the standalone inventory for DB-5
    - **ID**: T-5G-09
    - **Depends on**: T-5G-08, T-5G-02
    - **Affected modules**: `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - Every DB-5 artifact has exactly one final disposition, a reason and a requirement ID. Each ported standalone test names the canonical test that replaces it (ARCH-R03.10). Entries for DB-6 artifacts keep one disposition and wait for DB-6A and DB-6F.
      - No Standalone_Implementation code or test is changed, renamed or deleted: G2 prints nothing.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/; G2
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.1, ARCH-R03.2, ARCH-R03.4, ARCH-R03.5, ARCH-R03.10, ARCH-R03.13, DB5-R15.12_

  - [ ] 6.10 Complete the handoff document
    - **ID**: T-5G-10
    - **Depends on**: T-5G-05, T-5G-06, T-5G-09
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The document lists merged code (files per phase and `git rev-parse HEAD`, or the note that nothing is committed), the endpoint list with links to the contract, authorization rules and error codes, migration instructions with the one-way warning and variables (`GROUP_MAX_MEMBERS`, the two pending-Invitation maxima, no `GROUP_INVITATION_TTL_SECONDS`), the cold-backup procedure as a citation of `docs/docker-development.md` (no backup helper; DK-05, DK-06), the command and runner group, passed, failed, skipped and date of every phase run (DB5-R15.13) with the Validation_Runner as the gate of record and the Windows host results beside it, known gaps (open OD and OP items with defaults, the Not verified list, accepted review findings, waivers), runtime statements and the Gate_Record list.
      - The section "Known_Baseline_Failure" lists the two entries by test name and platform and is kept apart from the counts (DB5-R15.14). The runtime statements name the Standalone_Implementation host by `server/api-main.cjs`, `npm run start:api` and `API_PORT`, never by a port number alone, say that it is not a supported runtime, that `npm run start:data` starts the only supported server, and that in the Docker_Environment port 3001 is the browser-facing address of the application (ARCH-R01.9). The OP-18 outcome of T-5C-54 is listed.
      - `gate-records.test.js` fails when a required heading is missing or when a phase from DB-5B to DB-5G has no run record.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.8, DB5-R15.13, DB5-R15.14, DB5-R14.15, DB5-R14.16, DB5-R14.20, DB5-R14.23, ARCH-R01.9, ARCH-R03.8, COMP-10_

  - [ ] 6.11 Draft the DB5-ACCEPTANCE Gate_Record and send the request to the Project_Owner
    - **ID**: T-5G-11
    - **Depends on**: T-5G-10, T-5G-01
    - **Affected modules**: `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - The entry `GR-DB5-ACCEPTANCE-<date>` cites the C1 to C5 results in the Validation_Runner (gate of record) with the Windows host results beside them as additional evidence and the Known_Baseline_Failure list recorded separately, the coverage check, the completed handoff, the four stage records or their recorded waivers, and the OD-20 outcome. The approval line is left empty for the Project_Owner, who is asked to review it.
      - `gate-records.test.js` still passes and no committed environment or Docker file enables a switch.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8, ARCH-R03.6, ARCH-R02.8_

  - [ ] 6.12 Phase gate DB-5G
    - **ID**: T-5G-12
    - **Depends on**: T-5G-01 to T-5G-11
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - C1 to C5 run again in the Validation_Runner (the gate of record) after the documentation changes, and each result is recorded with command and group, passed, failed and skipped counts, date, `git rev-parse HEAD` and `git status --short`. C1 passes (at least 321 plus the new tests, 0 failed, 0 skipped, 0 cancelled, 0 todo). C2 and C5 exit 0, and the lint and `build:verify` steps of the client group exit 0. C3 and C4 show 0 failed and 0 skipped with at least the counts of T-5B-01 and T-5B-02 plus the new tests. The same C1 to C5 run on the Windows host as additional evidence and are recorded beside the runner results with the platform named: C1 and C3 pass, and C4 fails exactly the two Known_Baseline_Failure entries and nothing else. Those two entries are listed separately by test name and platform, never skipped, edited, excluded or silenced, and their Linux pass is read from `client-jest.json` (DB5-R15.14, DB5-R15.15).
      - G1 to G9 run at the repository root: G1, G2, G4, G6 and G9 exit 0; G3, G5a, G7 and G8 print nothing; G5b prints only the seven DC-01 lines. The standalone code is untouched (G2 empty) and nothing of it is deleted or deprecated by this phase. The handoff documentation check passes.
      - The handoff records the final run of each command (command and group, passed, failed, skipped, date). No application container is started by the gate and no Docker file is edited.
      - `GR-DB5-ACCEPTANCE-<date>` carries the Project_Owner's approval. This task stays unchecked until it does. No switch is enabled and no Standalone_Implementation file is deleted or deprecated by it.
    - **Verify**: C1 to C5 in the Validation_Runner (groups `data`, `server`, `client`); G1; G2; G3; G4; G5a; G5b; G6; G7; G8; G9
    - **Agent**: Kiro, with Codex supplying C4 and C5 and the Project_Owner approving the Gate_Record
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R15.16, DB5-R16.8, ARCH-R02.1, ARCH-R03.5, ARCH-R03.13, COMP-01, COMP-10_

- [ ] 7. DB-6A: canonical attachment architecture, contracts and owner decisions (documents, document checks and the 50 MiB proxy measurement; no code)
  **Entry criteria.** DB-5B exit met (T-5B-37, 0008 merged). DB-6A may run beside DB-5C because it shares no code, but `DATA/docs/db5-db6-handoff.md`, `standalone-inventory.md` and `gate-records.md` are shared files, so edits to them are serialised by the dependency graph. This phase writes documents, document checks and one measurement note (T-6A-24) only: no migration, no source file under `DATA/server`, no router, and no change under `server/` or `client/`. `/api/attachments` and `/api/files` keep answering 404 for every method.
  **Decisions and their gates.** None is selected here: each stays on its provisional default until the Project_Owner records it. OA-01 (CI-02, OP-05: the blocked direct pair, 404 for a block and 403 for a pair that is not friends) and OA-02 (CI-03, OP-03: the wording of the upload frame) are decided at this phase (T-6A-10, T-6A-05); the text of `requirements.md` stays unchanged until the Project_Owner approves each amendment. OP-04 (the upload timeout) is recorded at T-6A-12 with the measurement of T-6A-24 as evidence. OD-14 and OD-15 have no default and are recorded before the Attachment_API can be on outside tests (T-6A-11, T-6A-12); they do not block DB-6B coding, which injects the settings. OD-16, OD-17, OD-18, OD-20 and OD-21 run on their provisional defaults until recorded (T-6A-13 to T-6A-17), OD-21 and OP-02 until the DB-6C review, and OP-08 as proposed in T-6A-11. Later gates: OP-10 at DB-6C, OP-12 at DB-6D (T-6D-01) with OA-04 (CI-11, OP-12) at DB-5F and DB-6F, OA-03 (CI-10, OP-13) at DB-6E.
  **Docker (COMP-10).** The gate of record is the Validation_Runner (DB5-R15.10, DK-01); Docker must be running, and the runner starts no application container. The one container step of this phase is the 50 MiB measurement of T-6A-24. It runs only in a Disposable_Project (DK-03: name `secubuzz-disposable-` plus 8 lowercase hexadecimal characters, explicit `-p`, own volumes, no published port through a temporary override file kept outside the repository), never on the running project, with no repository file edited and no Compose Watch. The four documents live under `DATA/docs` and the document checks under `DATA/tests`; Compose Watch does not sync either folder, and the Validation_Runner builds from the working tree. No Docker file, `compose.yaml` or `docs/docker-development.md` is edited (Explicit Exclusion 11).

  - [x] 7.1 Read the standalone attachment sources and the 13 attachment server tests (CI-25)
    - **ID**: T-6A-01
    - **Depends on**: T-5B-37
    - **Affected modules**: `server/test/integration/attachments.test.ts` (read-only), `server/test/db5_db6.test.cjs` (read-only), `server/src/routes/attachment.cjs` (read-only), `server/src/storage/attachmentStorage.cjs` (read-only), `server/src/db5db6/cleanup.cjs` (read-only), `server/src/attachments/db6Transport.ts` (read-only), `DATA/docs/standalone-inventory.md` (observable-step notes)
    - **Acceptance criteria**:
      - The 13 tests of `attachments.test.ts`, of which the design read only the titles, and the attachment steps of `db5_db6.test.cjs` are read in full. For each, the inventory notes the observable steps (request, status, asserted headers and bytes, rows and files checked) in a form that a canonical test can reproduce.
      - The notes list every place where a standalone test contradicts a requirement of DB6-R01 to DB6-R05 (plaintext upload, file name in a header, `?group_id`, 403 for a block, access of a removed uploader), so that the port follows the requirement (ARCH-R03.11).
      - No standalone file changes: G2 prints nothing.
    - **Verify**: G2; review against the design's standalone test inventory table
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.1, ARCH-R03.4, ARCH-R03.10, ARCH-R03.11, DB5-R15.12_

  - [x] 7.2 Write the storage contract document
    - **ID**: T-6A-02
    - **Depends on**: T-5B-37
    - **Affected modules**: `DATA/docs/attachments-storage-contract.md` (new; file name chosen here)
    - **Acceptance criteria**:
      - The document defines the Storage_Provider operations `write(key, readable, {maxBytes})`, `read(key)`, `stat(key)`, `exists(key)`, `delete(key)`, `usage()`, `sweepTemporary(olderThanMs)` and `listKeys()` with inputs and results, the closed error codes (`STORAGE_KEY`, `STORAGE_EXISTS`, `STORAGE_SIZE`, `STORAGE_MISSING`, `STORAGE_IO`) and the rule that no result or error carries an absolute path, the root or operating system text. It marks `sweepTemporary` and `listKeys` as additions to the operations of DB6-R02.1.
      - It fixes the Storage_Key (24 random bytes written as 48 lowercase hexadecimal characters, pattern `^[a-z0-9]{32,128}$`, never derived from user text or content), the path-safety rules (separators, parent references, absolute and drive-letter forms, `:` stream syntax, Windows device names in any case, trailing dots and spaces, links), the root rules (`ATTACHMENT_STORAGE_DIR`, an absolute path whose real path is outside the repository working tree and any served directory, no static route), file modes (0600 and directories 0700 where the platform honours them), `.part` writes with flag `wx`, SHA-256, no-replace finalisation, and the 64 KiB chunk size under the 1,048,576-byte memory bound.
      - Each rule names the criterion it serves.
      - A "Docker_Environment" section fixes the storage root under the Docker_Environment: the reserved `private-storage` volume path `ATTACHMENT_STORAGE_DIR=/var/lib/secubuzz/attachments`, which `compose.yaml` already sets (a Linux named volume outside the working tree, mode 0700, owned by UID 1000 `node`, never served statically, not seeded from the repository), so the start checks of the root pass with no Compose change. It states that `sqlite-data` and `private-storage` are archived and restored together by the cold-backup procedure of `docs/docker-development.md` (a one-sided restore shows up as the two orphan counts of DB6-R03.14), that disk usage and the OD-15 quotas count against the Docker disk image (a full image makes storage fail as 503 `SERVICE_UNAVAILABLE`), and that new files and fixtures avoid the `.dockerignore` names (G7).
    - **Verify**: review against the design's DB-6 forward compatibility section (Storage_Provider contract, Storage root, Docker volume facts, Path-traversal controls); the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: DB6-R02.1, DB6-R02.2, DB6-R02.3, DB6-R02.4, DB6-R02.5, DB6-R02.6, DB6-R02.7, DB6-R02.9, DB6-R02.12, DB6-R02.13, DB6-R02.15, DB6-R04.10, COMP-09, COMP-10, NFR-05_

  - [x] 7.3 Add the Storage_Provider contract test plan to the storage contract document
    - **ID**: T-6A-03
    - **Depends on**: T-6A-02
    - **Affected modules**: `DATA/docs/attachments-storage-contract.md`
    - **Acceptance criteria**:
      - A "Contract tests" section lists the cases that the shared suite `attachments-storage-contract.test.js` and property P-33 run against every provider: the hostile key corpus (100 keys per class), stream faults (abort at a random byte, injected I/O error, size over `maxBytes`, existing final file), no `.part` file left, no replacement, `byteCount` and `sha256` against an independent computation, no absolute path in any error, mode 0600 where the platform honours modes, refusal of links, and a large generated stream for NFR-05.
      - The section states the registry rule (a provider factory exported under `attachments/storage/` and not registered in `support/storage-providers.js` fails the suite) and the plan for the hard-link question of R-10 and CI-28: probe the root at start, run the suite on Windows and Linux and on any path the Project_Owner names, then choose a documented fallback.
      - It maps the ported standalone streaming tests (inventory tests 2 and 12) to the cases that replace them.
      - It states the platform rule of DB5-R15.16: the three storage assertions that depend on the platform (file mode, symbolic link refusal, link-based rename) are each one test that branches on `process.platform` and asserts the expectation of that platform, and none is skipped. The contract suite runs on Linux in the Validation_Runner (the gate of record; mode 0600 and 0700 under UID 1000) and on the Windows host (additional evidence).
    - **Verify**: the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: DB6-R02.11, DB6-R02.6, DB6-R02.13, DB6-R04.12, ARCH-R03.4, ARCH-R03.10, DB5-R15.16, COMP-09, NFR-05_

  - [x] 7.4 Write the upload frame wire format (DC-03, ADR-09)
    - **ID**: T-6A-04
    - **Depends on**: T-6A-01
    - **Affected modules**: `DATA/docs/attachments-upload-frame.md` (new; file name chosen here)
    - **Acceptance criteria**:
      - The document fixes the body of A01: the width and byte order of the length prefix, the header cap in bytes (the frame header is not an HTTP header, so the cap lies above the 16384-byte HTTP header limit of F10 and carries up to 16384 characters of encrypted metadata), the JSON header `{ conversationId, byteSize, encryptedMetadata, algorithm, formatVersion }` with field types and limits (metadata at most 16384 characters, descriptors 1 to 64 characters), the request content type, and exactly `byteSize` bytes after the header. The header is validated before any byte of content is read, and a malformed frame writes no row, no file and no reservation.
      - It settles the points of CI-15: the order of checks (frame header, session and CSRF, gate, membership, archive state, size limit, quotas), the rule for `maxBytes` and the 413 or 400 answer (a declared size over the per-file limit is 413 before any byte is read; a stream that passes the declared size is 413 when it also passes the per-file limit and 400 otherwise), and whether the header carries a category field (default if the Project_Owner does not choose: no field, and the 52,428,800-byte limit of DB6-R04.2 applies to every upload).
      - It lists at least two byte-exact example frames as hex vectors (an empty file and a small file) that the server codec test (T-6B-08) and the client encoder test (T-6E-06) both check. It states that `/api/files` serves only `GET /search`, that the standalone header transport and the `/api/files` alias are discarded (inventory test 8), and what the client implements at DB-6E.
    - **Verify**: review against ADR-09, DC-03, CI-15 and Error Handling (Storage and upload failures); the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: DB6-R03.1, DB6-R04.2, DB6-R04.3, DB6-R04.12, DB6-R05.3, DB6-R05.4, DB6-R05.12, ARCH-R03.4_

  - [x] 7.5 Record the Project_Owner decision on the upload frame (OP-03)
    - **ID**: T-6A-05
    - **Depends on**: T-6A-04, T-6A-24
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry confirms the frame of T-6A-04 (prefix, header cap, category field choice, request content type) or amends it. An amended frame is written into `attachments-upload-frame.md` before T-6B-08 starts.
      - The entry states that Codex adapts the client uploader to this frame at DB-6E and carries the date and the Project_Owner's name.
      - The entry is the decision on amendment OA-02 (CI-03, OP-03): it records approval or rejection of the frame as the basis for the wording of DB6-R03.1 and DB6-R05.12, which stay unchanged in `requirements.md` until the Project_Owner edits them separately. It cites the result of the in-stack measurement of T-6A-24 (digest equality, memory use, time, proxy timeout behavior). No default is selected by this task.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R03.1, DB6-R05.12, DB6-R04.2_

  - [x] 7.6 Write the attachment endpoint contract A01 to A06
    - **ID**: T-6A-06
    - **Depends on**: T-6A-03, T-6A-04
    - **Affected modules**: `DATA/docs/attachments-api.md` (new; file name chosen here)
    - **Acceptance criteria**:
      - The document lists A01 to A06 with method and path, minimum role (direct conversation: the direct send rule), request (the frame for A01, JSON for A02, query for A06), success status and body, errors beyond the common ones, idempotency, and the attachment projection `{ id, conversationId, messageId | null, uploadedBy, byteSize, status, createdAt, expiresAt | null, integrityDigest, algorithm, formatVersion, encryptedMetadata }`. It states that `storage_key` and any path are never returned.
      - It states for each route the outcome in an archived group (A01 409, reads as before, A02 409 and A05 allowed for the uploader unless the Project_Owner decides otherwise, because deletion grants no access), the uniform 404 rule (one body for every cause), the headers of A04 (`application/octet-stream`, `attachment`, `nosniff`, `no-store`, `Content-Length`), the codes declared before use (`QUOTA_EXCEEDED`, `PAYLOAD_TOO_LARGE`, 429 with `Retry-After`, 503 `SERVICE_UNAVAILABLE`) and that a disabled switch answers 503 `FEATURE_UNAVAILABLE` before any read.
      - It records DC-04 (the 15 s `requestTimeout` and the setting `ATTACHMENT_UPLOAD_TIMEOUT_SECONDS`) and names the settings of OD-14 and OD-15 without values. It notes that per-source limits are configurable settings that are not defended by trusting forwarded headers (OP-19): in the Docker_Environment every request reaches DATA from 127.0.0.1, so a per-source bucket is shared by all users of one project.
    - **Verify**: the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: DB6-R01.7, DB6-R01.8, DB6-R03.1, DB6-R03.5, DB6-R03.6, DB6-R03.7, DB6-R03.9, DB6-R03.10, DB6-R03.12, DB6-R03.16, DB6-R03.19, DB6-R03.20, DB6-R03.21, DB6-R04.5, DB6-R04.6, DB5-R16.4, DB5-R13.2, COMP-10, NFR-08_

  - [x] 7.7 Document the protected-content declaration descriptors and the server's no-key rules
    - **ID**: T-6A-07
    - **Depends on**: T-6A-06
    - **Affected modules**: `DATA/docs/attachments-protected-content.md` (new; file name chosen here)
    - **Acceptance criteria**:
      - The document defines the protected-content declaration: `algorithm` and `formatVersion` (each 1 to 64 characters, stored outside `encrypted_metadata` in `declared_algorithm` and `declared_format_version`) and `encryptedMetadata` (at most 16384 characters, opaque). It states that `media_type` is stored as `application/octet-stream` for every protected upload, that file name, original media type and content-derived metadata live only inside `encryptedMetadata`, and that an upload without the declaration or the metadata, or with a descriptor outside 1 to 64 characters, answers 400 with the field name and stores nothing (the OD-16 default).
      - It states the server rules: the Attachment_Service never decrypts, parses, previews, thumbnails, scans or indexes bytes or metadata, receives, requests, stores, logs or derives no key, and adds no cryptographic primitive apart from the SHA-256 digest and the random bytes of the Storage_Key. It states what DB-6E must do: send ciphertext only, no plaintext fallback, flag false until the ATTACHMENTS-PROTECTED record exists.
      - It consumes the existing client protected-content format as it is and designs no cryptography (Explicit Exclusion 2).
    - **Verify**: the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: DB6-R05.1, DB6-R05.2, DB6-R05.3, DB6-R05.4, DB6-R05.5, DB6-R05.8, DB6-R05.9, DB6-R05.10, DB6-R05.11, DB6-R05.12, DB6-R05.13_

  - [x] 7.8 Draft the residual-risk statement for the DB-6C review
    - **ID**: T-6A-08
    - **Depends on**: T-6A-07
    - **Affected modules**: `DATA/docs/attachments-protected-content.md`
    - **Acceptance criteria**:
      - A "Residual risk" section states that the server cannot verify that uploaded bytes are ciphertext, that a buggy or hostile client can store plaintext in an otherwise valid request, and that no sound detection exists without inspecting content, which DB6-R05.1 forbids. It lists the controls that remain (the client sends ciphertext only, the declaration and metadata are required, the Attachment_API stays off for Real_Accounts until the ATTACHMENTS-PROTECTED record, the client flag stays false, the private root) and states that byte size and upload time are visible to the server by design (R-02).
      - The section carries the status DRAFT and the open question for the reviewer (whether padding is required). T-6C-11 replaces the status with the accepted wording.
    - **Verify**: the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: DB6-R05.6, DB6-R05.1, DB6-R05.8, DB6-R05.10_

  - [x] 7.9 Write the DC-02 amendment text for the blocked-pair rule
    - **ID**: T-6A-09
    - **Depends on**: T-6A-06
    - **Affected modules**: `DATA/docs/attachments-api.md` (section "Direct pair rule")
    - **Acceptance criteria**:
      - The section gives, as proposed text, the replacement wording for DB6-R03.2 and DB5-R15.9: a block in either direction between direct participants answers 404 NOT_FOUND, and participants who are not friends answer 403 FORBIDDEN, as the direct message path does. It cites the evidence (`messaging-security.test.js` lines 51 to 58, `conversations-security.test.js` line 73) and the reason (a 404 does not reveal a block).
      - It states that this plan does not edit `requirements.md`, and that until T-6A-10 is recorded `attachments-security.test.js` asserts the baseline literals (404 for a block, 403 for a pair that is not friends).
    - **Verify**: the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: DB6-R03.2, DB5-R15.9, DB6-R03.19_

  - [x] 7.10 Record the Project_Owner decision on the blocked-pair rule (OP-05, DC-02)
    - **ID**: T-6A-10
    - **Depends on**: T-6A-09
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry is the decision on amendment OA-01 (CI-02, OP-05). It confirms the amendment text (404 for a block, 403 for a pair that is not friends) or states another rule, and says whether the Project_Owner will edit `requirements.md` separately; DB6-R03.2 and DB5-R15.9 stay unchanged there until then. No default is selected by this task.
      - A rule that differs from the baseline direct path would change direct-path behavior (ARCH-R02.4) and needs a new specification; the entry says so if chosen.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R03.2, DB5-R15.9_

  - [x] 7.11 Record the Project_Owner decision on attachment retention (OD-14, OP-08)
    - **ID**: T-6A-11
    - **Depends on**: T-6A-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry records the values of `ATTACHMENT_PENDING_TTL_SECONDS`, `ATTACHMENT_PURGE_DELAY_SECONDS` and `ATTACHMENT_RETENTION_INTERVAL_SECONDS`, and the expiry of `AttachmentReservations` rows after a crash (OP-08; proposed: the pending TTL).
      - It confirms that ready attachments are not purged automatically. Until the values exist the Attachment_API stays off outside tests (DB5-R16.7).
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R01.2, DB6-R03.13, DB6-R03.14, DB6-R03.15, DB5-R16.7_

  - [x] 7.12 Record the Project_Owner decision on quotas, limits and the upload timeout (OD-15, OP-04, DC-04)
    - **ID**: T-6A-12
    - **Depends on**: T-6A-06, T-6A-24
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry records `ATTACHMENT_QUOTA_USER_BYTES`, `ATTACHMENT_QUOTA_CONVERSATION_BYTES`, `ATTACHMENT_MAX_PENDING_PER_USER`, `ATTACHMENT_UPLOADS_PER_HOUR`, `ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER` and `ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE`, and confirms the client size policy as the server limit.
      - It records the value of `ATTACHMENT_UPLOAD_TIMEOUT_SECONDS` or keeps the 15 s `requestTimeout`, and notes that a raised value applies to the whole process while the switch is on (R-08). It cites the proxy timeout and buffering behavior measured by T-6A-24 (OP-04) next to the chosen value.
      - It notes that `ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE` stays a configurable setting that is not defended by trusting forwarded headers (OP-19): in the Docker_Environment every request reaches DATA from 127.0.0.1, so the per-source bucket is one bucket for all users of a project.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R04.1, DB6-R04.4, DB6-R04.5, DB6-R04.6, DB6-R04.7, DB5-R16.7_

  - [x] 7.13 Record the Project_Owner decision on plaintext attachments (OD-16)
    - **ID**: T-6A-13
    - **Depends on**: T-6A-07
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry confirms the default (plaintext refused, no allowlist, no scanning) or names another policy. A policy that permits plaintext opens a new specification, because this plan builds no allowlist, no first-512-bytes check and no scanner.
      - The entry states that DB-6B validation follows the default until the decision is final at the DB-6C review (T-6C-08).
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R05.3, DB6-R05.7_

  - [x] 7.14 Record the Project_Owner decision on file search scope (OD-17)
    - **ID**: T-6A-14
    - **Depends on**: T-6A-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry confirms the filters conversation, uploader, byte size range and creation time range, with name and content search refused, or names another scope.
      - It states that a media type class would need a new column and a migration after 0009 and is therefore outside this plan (CI-36).
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R03.9, DB6-R03.10, DB6-R03.11_

  - [x] 7.15 Record the Project_Owner decision on attachment access and deletion (OD-18, with OD-03, OD-07 and OD-13)
    - **ID**: T-6A-15
    - **Depends on**: T-6A-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry confirms that remaining members keep access to a ready attachment after a message tombstone, after the uploader's membership ends and after the group is archived, that removed members lose access, and that only the uploader may delete an attachment.
      - It confirms or amends the OD-03, OD-07 and OD-13 defaults as they apply to attachments.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R03.18, DB6-R03.8, DB6-R03.12_

  - [x] 7.16 Record the OD-20 decision for the standalone attachment table
    - **ID**: T-6A-16
    - **Depends on**: T-6A-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry confirms the default (no row of the standalone attachment table is copied into `Attachments` and the standalone database file is never opened or modified) or asks for a migration, which opens a new specification because this plan contains no import tool.
      - OD-20 is one decision with T-5G-02: whichever task runs first writes the entry and the other cites it.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R01.10, ARCH-R03.12_

  - [x] 7.17 Record that OD-21 and OP-02 stay provisional until the DB-6C review
    - **ID**: T-6A-17
    - **Depends on**: T-6A-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry accepts the provisional form of OD-21 (association by an explicit authenticated request, A02, after the message is committed) for DB-6B and DB-6D, and states that the DB-6C review decides the final form (T-6C-09).
      - It confirms the whole-message reading of the 5-file and 100 MB limits (OP-02), so that attachments already associated to a message count in the same transaction.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R01.4, DB6-R01.9, DB6-R04.11_

  - [x] 7.18 List the decisions and their defaults in the attachment contract
    - **ID**: T-6A-18
    - **Depends on**: T-6A-09
    - **Affected modules**: `DATA/docs/attachments-api.md` (section "Decisions and defaults")
    - **Acceptance criteria**:
      - A table lists OD-14 to OD-21 with the provisional behavior in force, the setting or code each one affects and whether it blocks the switch (OD-14 and OD-15: no default, the Attachment_API cannot be on outside tests). A second table lists the open points OP-02, OP-03, OP-04, OP-05, OP-08, OP-10, OP-12 and OP-13 with their defaults and the phase that settles them, and a third table lists the amendments OA-01 (CI-02, OP-05; DB-6A), OA-02 (CI-03, OP-03; DB-6A), OA-03 (CI-10, OP-13; DB-6E) and OA-04 (CI-11, OP-12; DB-5F and DB-6F) with the criteria they concern, the text in force and the approval phase.
      - The tables cite the decision-log entries of T-6A-05 and T-6A-10 to T-6A-17 once they exist, and state the default where an entry does not exist yet.
    - **Verify**: the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: DB6-R01.9, DB6-R01.10, DB6-R03.18, DB6-R04.5, DB6-R05.3, DB6-R05.7, ARCH-R03.12_

  - [x] 7.19 Plan the 50 MiB proxy measurement (CI-27, R-07)
    - **ID**: T-6A-19
    - **Depends on**: T-6A-04
    - **Affected modules**: `client/authProxy.cjs` (read-only), `client/next.config.js` (read-only), `DATA/docs/db5-db6-handoff.md` (planned-measurement note)
    - **Acceptance criteria**:
      - Codex reads the two files and records in the handoff which proxy settings (timeouts, body size, buffering) govern a rewritten request, the pass criteria for a generated 50 MiB framed body (equal SHA-256 at the receiving end, no truncation, bounded memory) and the fallback if it fails (Codex and the Project_Owner choose another route for uploads, and the client flag stays false). In the Docker_Environment the two files are copied into the frontend image and not mounted, so the measurement of T-6A-24 uses the image built from the working tree.
      - The note states that the in-stack measurement runs in T-6A-24, in a Disposable_Project and over a rewritten prefix that already exists, because no `/api/attachments` rewrite may exist before DB-6E (DB5-R16.11), and that T-6E-07 repeats it through the real rewrite at DB-6E. No client file changes.
    - **Verify**: `npm run type-check` in client/ (no file changed)
    - **Agent**: Codex
    - _Requirements: DB5-R16.11, DB6-R04.10, NFR-05_

  - [x] 7.20 Complete the inventory entries for the attachment artifacts
    - **ID**: T-6A-20
    - **Depends on**: T-6A-01
    - **Affected modules**: `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - The inventory has one entry per attachment artifact of the design's classification table: the streaming write, the upload, metadata, download and delete handlers, the plaintext path and MIME allow-list, the name search, the cleanup script, the standalone attachment table and the `db.cjs` rebuild, the filename transport, the 14 server tests and the client uploader with its 8 test files. Each entry has one disposition (reuse as is, adapt, replace or retire), a non-empty reason and at least one requirement ID. The standalone attachment table and the `Messages` rebuild stay marked retired.
      - For each artifact marked reuse as is or adapt, the original author and source file are recorded, read from `git log` (ARCH-R03.7). No standalone file changes: G2 prints nothing.
    - **Verify**: G2; the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.1, ARCH-R03.2, ARCH-R03.3, ARCH-R03.7, DB5-R15.12_

  - [x] 7.21 Complete the per-test port plan for the 14 server tests and the 76 client tests
    - **ID**: T-6A-21
    - **Depends on**: T-6A-20
    - **Affected modules**: `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - A table lists, for each of the 13 tests of `attachments.test.ts` and for the attachment steps of `db5_db6.test.cjs`, the canonical replacement file, the phase that ports it (DB-6B, DB-6C or DB-6D) and the assertion differences that the requirements force (plaintext upload answers 400 under OD-16, direct add answers 503, a removed uploader loses access, names live inside encrypted metadata, search by name answers 400). Test 8 is recorded as retired with no replacement.
      - The 8 client test files (76 tests) are listed with their paths and the per-file counts as run. The plan states that they stay unchanged until T-6E-01 is recorded (ARCH-R03.9, G4 passes) and that every assertion changed at DB-6E gets a stricter replacement named in the inventory (DB5-R15.12).
      - The table has a layout that the document check can parse.
    - **Verify**: the document check of T-6A-22
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.4, ARCH-R03.9, ARCH-R03.10, ARCH-R03.11, DB5-R15.12_

  - [x] 7.22 Add the DB-6A document checks to `gate-records.test.js`
    - **ID**: T-6A-22
    - **Depends on**: T-6A-08, T-6A-18, T-6A-21, T-6A-24
    - **Affected modules**: `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The test fails when one of the four DB-6A documents is missing or lacks its required parts: the operations list, the "Contract tests" section and the "Docker_Environment" section (storage contract), the length prefix and header cap (frame), the A01 to A06 rows, the "Direct pair rule" section and the decisions tables with OD-14 to OD-21 and OA-01 to OA-04 (API contract), the declaration descriptors and the "Residual risk" section (protected content).
      - The test fails when an attachment artifact of the inventory lacks a disposition, a reason or a requirement ID, when one of the 14 server tests or one of the 8 client files has no row, or when test 8 is not marked retired.
      - The test fails when the handoff holds no measurement note for T-6A-24 (project name, digest and byte count at the receiver, peak memory, time, proxy timeout behavior), and it accepts a note that reports a failed measurement together with its fallback.
      - No baseline test is edited. The count of C1 grows only by these checks.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.1, ARCH-R03.2, ARCH-R03.3, ARCH-R03.10, DB6-R05.6, DB5-R15.12, COMP-10_

  - [x] 7.23 Measure a 50 MiB framed upload through the Next.js rewrite proxy in a Disposable_Project (CI-27, R-07, R-22)
    - **ID**: T-6A-24
    - **Depends on**: T-6A-04, T-6A-19
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (measurement result note); no repository file is edited (the throwaway receiver, the body generator and the override file live in the system temporary directory)
    - **Acceptance criteria**:
      - The measurement runs only in a Disposable_Project created for it (name `secubuzz-disposable-` plus 8 lowercase hexadecimal characters, explicit `-p`, own volumes, no published port through a temporary override file kept outside the repository). The images are built from the working tree with `docker compose -p <name> -f compose.yaml -f <override> build backend frontend`, so the Next.js development rewrite proxy, its body buffering and its timeout settings are those of the Docker_Environment (`client/authProxy.cjs` and `client/next.config.js` are copied into the frontend image). No Docker file, `compose.yaml`, client file or DATA file is edited, no Compose Watch runs, and the running project and its volumes are never used.
      - The method is fixed in this task and recorded in the handoff. A throwaway receiver (a script in the system temporary directory, handed to the disposable backend container through the override file or `docker compose exec`) listens inside the backend's network namespace where `AUTH_BACKEND_URL` points, in place of the DATA process of the disposable project, and answers `GET /healthz` with 200 if the Compose file makes the frontend wait for the backend health check. A generated 50 MiB framed body in the format of `attachments-upload-frame.md` is sent from inside the project's network namespace to the frontend address `127.0.0.1:3001` over a prefix that is already rewritten (no `/api/attachments` rewrite may exist before DB-6E, DB5-R16.11), so the request crosses the proxy path that DB-6E will use.
      - The note records the SHA-256 and byte count at the receiver against the generated body (equal or not), the peak memory of the frontend container (`docker stats` samples), the time to completion, and the proxy timeout and buffering behavior observed (truncation, cut-off or error status, and at which byte or second). The pass criteria are those of T-6A-19: equal digest, no truncation, bounded memory.
      - If the body is truncated, buffered without bound or cut by a timeout, the note says so and names the fallback of T-6A-19 (Codex and the Project_Owner choose another route for uploads, and the client flag stays false). The result is evidence for OA-02 (CI-03, OP-03) and for OP-04 (the 15 s request timeout) and is cited by T-6A-05 and T-6A-12; it selects no default.
      - `docker compose -p <name> -f compose.yaml -f <override> down -v` runs once, only after the name matches `^secubuzz-disposable-[0-9a-f]{8}$` and the project was created for this task. `-v` is never used on another project, and the override file and the receiver are removed. The note shows the project name and the commands. A disposable project of this task that still exists fails the phase gate T-6A-23.
    - **Verify**: `docker compose -p $project -f compose.yaml -f $override config | Select-String 'published'` prints nothing; the receiver prints the SHA-256 and the byte count; `docker compose ls -a` lists no project of this task after the removal (PowerShell, repository root)
    - **Agent**: Kiro, with the proxy settings read by Codex in T-6A-19
    - _Requirements: DB5-R16.11, DB6-R04.10, COMP-10, NFR-05_

  - [x] 7.24 Phase gate DB-6A
    - **ID**: T-6A-23
    - **Depends on**: T-6A-01 to T-6A-10, T-6A-18 to T-6A-22, T-6A-24
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - C1 runs in the Validation_Runner (group `data`, the gate of record, DB5-R15.10) and passes as defined in the Notes: its count rises only by the document checks of T-6A-22. The same C1 on the Windows host is recorded beside it as additional evidence. G1, G2 and G9 exit 0, G3, G5a, G7 and G8 print nothing, and G5b prints only the seven DC-01 lines. No file `0009-*.sql`, no `DATA/server/routes/attachments.js` and no directory `DATA/server/attachments` exists, and `/api/attachments` and `/api/files` answer 404 for every method (the T-5B-22 test passes).
      - The four documents exist and the document check passes. The decisions on OA-02 (OP-03, T-6A-05) and OA-01 (OP-05, T-6A-10) are recorded. T-6A-11 to T-6A-17 may still be open: their defaults stay in force and the handoff lists them as known gaps with their gates (OD-14, OD-15, OD-16, OD-17, OD-18, OD-20, OD-21, OP-02, OP-04, OP-08). No default is selected by this gate.
      - The measurement note of T-6A-24 is in the handoff and its Disposable_Project is removed: `docker compose ls -a` lists no project whose name starts with `secubuzz-disposable-` and was created by this phase. No application container is started by the gate, and no Docker file, `compose.yaml` or client file is changed (G8 prints nothing and `git status --short` lists no such path).
      - The handoff records each run (command and runner group, passed, failed, skipped, date, `git rev-parse HEAD`, `git status --short`) with the Windows host results beside the runner results. The Known_Baseline_Failure list of T-5B-39 is unchanged: no client suite runs in this phase, and no entry is skipped, edited, excluded or silenced (DB5-R15.14, DB5-R15.15). No Gate_Record applies to DB-6A.
    - **Verify**: C1 in the Validation_Runner (group `data`) and on the Windows host; G1; G2; G3; G5a; G5b; G7; G8; G9; `Test-Path` on the three paths above returns False; `docker compose ls -a`
    - **Agent**: Kiro
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.14, DB5-R15.15, ARCH-R01.8, ARCH-R02.1, COMP-01, COMP-10_

- [ ] 8. DB-6B: storage, metadata, migration 0009 and the Attachment_API behind a switch that is off
  **Entry criteria.** DB-6A exit met (T-6A-23) and DB-5C exit met (T-5C-52). Migration 0009 follows 0008 in the ledger, so DB-6B never merges before DB-5B. OP-06 is decided (recorded by T-5B-07, a recording task with nothing pending) and covers 0009 by the same mechanism as 0008: exactly the seven ledger literals of baseline tests gain the new file name or version number, in the same commit as the migration (the same change set while nothing is committed), the guard tests of T-5B-05 and T-6B-02 fail on any other changed baseline line, and G5b lists only those seven lines. The decisions on OA-02 (OP-03, the frame) and OA-01 (OP-05, DC-02) are recorded (T-6A-05, T-6A-10). OD-14 and OD-15 values are not needed to write code, because tests inject the settings through `features`; the Attachment_API stays off outside tests until T-6A-11 and T-6A-12 are recorded (DB5-R16.7). OD-16 runs on its default (plaintext refused) and governs validation. OP-04 (15 s request timeout unless `ATTACHMENT_UPLOAD_TIMEOUT_SECONDS` is set, with the measurement of T-6A-24 as evidence) and OP-08 (reservation expiry equal to the pending TTL) apply as recorded. Still open with their gates, and not selected here: OD-14 and OD-15 (before the switch can be on outside tests), OD-16, OD-17 and OD-21 with OP-02 (DB-6C review), OD-18, OD-20 (T-6A-16, T-5G-02), then OP-10 (DB-6C), OP-12 (DB-6D), OA-03 (DB-6E) and OA-04 (DB-5F and DB-6F).
  **Docker (COMP-10).** The gate of record is the Validation_Runner. The migration tests (T-6B-03, P-27, P-28) run on temporary databases that each test creates and removes and start no container (DB5-R14.17, R14.21), so they run unchanged in the runner and on the Windows host. The container-level rehearsal of 0009 (T-6B-51) runs only in a Disposable_Project (DK-03, DK-07, DB5-R14.24) on synthetic fixtures or an isolated restored cold-backup copy, never on the volumes of the running project or on a live database. 0009 is a draft migration until it is committed, so Docker Compose Watch is not started for any project whose volumes hold data to keep: `git status --short -- DATA/server/database/migrations` must print nothing before any `docker compose watch` (DB5-R14.22). Before the first start of code that contains 0009 against data to keep, every writer is stopped and both complete volume roots, `sqlite-data` and `private-storage`, are archived together by the cold-backup procedure of `docs/docker-development.md` (DB5-R14.23; no backup helper, DK-06). In the Docker_Environment the storage root is the reserved `private-storage` volume path `ATTACHMENT_STORAGE_DIR=/var/lib/secubuzz/attachments` that `compose.yaml` already sets (outside the working tree, mode 0700, UID 1000, never served), and the provider start checks must accept it with no Compose change. Per-source upload limits stay configurable (OP-19): every request reaches DATA from 127.0.0.1 there, so a per-source bucket is shared by all users of a project and no forwarded header is trusted. `close()` stops the Retention_Job inside the 30 s stop grace period. New files and fixtures avoid the `.dockerignore` names and extensions (G7); `DATA/docs`, `DATA/tests` and `DATA/scripts` are not synced by Compose Watch, so an image that must contain them is rebuilt. No Docker file, `compose.yaml` or `docs/docker-development.md` is edited.
  **Scope note.** The design's Phase Plan lands A02, A04 and A06 in DB-6D. This plan builds the service functions and routes of all six endpoints here, with baseline authorization (conversation membership, the direct send rule, the uploader alone for pending metadata and deletion), so that the standalone tests whose code is ported here run in the same phase (ARCH-R03.4). DB-6D adds the permitted-range check on ready reads and search, the direct-pair rule on reads, the archived-group rules for association and deletion, the tombstone and removed-uploader tests, the actor-class matrix and P-35 to P-37. Every route answers 503 FEATURE_UNAVAILABLE while the switch is off. No client change, no cryptographic primitive other than SHA-256 and the random bytes of the Storage_Key, no static route on the storage root.

  - [ ] 8.1 Add migration `0009-attachment-lifecycle.sql` and amend the seven DC-01 literals again
    - **ID**: T-6B-01
    - **Depends on**: T-6A-23, T-5C-52, T-5B-05, T-5B-07, T-5B-11, T-5B-21
    - **Affected modules**: `DATA/server/database/migrations/0009-attachment-lifecycle.sql` (new), the seven baseline test files of T-5B-15, on the same lines and for the literal only (`auth-migrations.test.js`, `conversations-migrations.test.js`, `e2ee-migrations.test.js` two lines, `messaging-migrations.test.js`, `migrations.test.js`, `social-migrations.test.js`)
    - **Acceptance criteria**:
      - 0009 adds to `Attachments` the columns `integrity_digest`, `expires_at`, `deleted_at`, `purge_state` (default `not_purged`), `declared_algorithm` and `declared_format_version` with their CHECKs, the indexes `idx_attachments_pending_expiry`, `idx_attachments_uploader_usage`, `idx_attachments_search` and `idx_attachments_purge`, the triggers `attachments_immutable`, `attachments_lifecycle` and `attachments_metadata_insert`, and the table `AttachmentReservations` with its four indexes, as in the design's DDL. Every new foreign key is `ON DELETE RESTRICT`. No existing column value changes, and the file has no `IF NOT EXISTS`, no BEGIN, COMMIT, ROLLBACK, VACUUM, ATTACH or PRAGMA outside trigger bodies, and no UPDATE, DELETE or DROP of existing data. It rebuilds no existing table (only `ALTER TABLE ... ADD COLUMN`), so the rebuild proof of DB5-R14.4 has nothing to prove.
      - The database does not enforce the `storage_key` format, a non-null digest or the descriptors (the service does), so the baseline attachment test that inserts the key `opaque/test-key` and sets `ready` without a digest passes unedited.
      - The seven literals gain `0009-attachment-lifecycle.sql` or version 9 in this same change set and no other baseline line changes. `schema.test.js` and the 321 baseline tests pass, `baseline-checksums` and `migration-lint` pass, G1 exits 0 and G5b prints only the seven lines. The file runs on the existing SQLite engine and better-sqlite3 version and adds no dependency.
      - The DC-01 mechanism is the one of 0008 (OP-06 is decided, the decision is recorded by T-5B-07 and nothing is pending): only the seven ledger literals of T-5B-15 change, by appending the file name or version number, in the same commit as 0009. 0009 is a draft until it is committed, so Compose Watch is not started while it is (`git status --short -- DATA/server/database/migrations` is checked before any `docker compose watch`, DB5-R14.22), and the file name avoids the `.dockerignore` names and extensions (G7).
    - **Verify**: `node --test` in DATA/; G1; G5b
    - **Agent**: Kiro
    - _Requirements: DB6-R01.2, DB6-R01.3, DB6-R01.6, DB6-R01.11, DB5-R14.1, DB5-R14.3, DB5-R14.4, DB5-R14.5, DB5-R14.11, DB5-R14.12, ARCH-R01.11, ARCH-R02.1, DB5-R14.22, DB5-R15.11, COMP-04, NFR-09_

  - [ ] 8.2 Extend the checksum guard and the lint test to 0009 (property P-29)
    - **ID**: T-6B-02
    - **Depends on**: T-6B-01
    - **Property P-29: Published migrations are immutable (clauses for 0008 and 0009)**
    - **Validates: Requirements DB5-R14.1, DB5-R14.2, DB5-R14.5, DB5-R14.11, DB5-R15.11**
    - **Affected modules**: `DATA/tests/baseline-checksums.test.js`, `DATA/tests/migration-lint.test.js`
    - **Acceptance criteria**:
      - The guard accepts the seven DC-01 lines with `0009-attachment-lifecycle.sql` or version 9 appended and fails on any other difference, naming file and line, exactly as the guard of T-5B-05 does for 0008 (OP-06 decided; the amendment belongs in the same commit as 0009, DB5-R15.11). It pins the SHA-256 of the LF-normalised merged `0008-groups.sql`, computed in this task, so a single-byte change in a temporary copy of 0008 makes the runner refuse to start and change nothing.
      - The lint test accepts 0001 to 0009 (the trigger bodies of 0009 contain `BEGIN`, `CASE` and `END`), reports no `ON DELETE CASCADE`, `SET NULL` or `SET DEFAULT` in 0008 and 0009, and still rejects the hand-written bad cases of T-5B-11. For generated SQL texts it reports a violation exactly when a forbidden statement lies outside a trigger body.
    - **Verify**: `node --test tests/baseline-checksums.test.js tests/migration-lint.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.3 Add the structural migration cases for 0009 and the one-way check
    - **ID**: T-6B-03
    - **Depends on**: T-6B-01, T-5B-17
    - **Affected modules**: `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - Fresh database: the latest version, taken from the directory listing, is 9, with one ledger row per file in order and a 64-hex checksum, an empty `foreign_key_check` and `integrity_check` ok. A repeat run applies zero migrations. A copy of 0009 with a failing statement in a temporary directory gives `MIGRATION_FAILED` that names the file and no path and leaves schema, ledger and rows unchanged.
      - `PRAGMA foreign_key_list` of `AttachmentReservations` reports `RESTRICT` for every key and the table has at least one foreign key (DC-06). `Messages` has no `group_id` column and no table duplicates `Conversations`, `ConversationMembers`, `Messages` or `Attachments`.
      - `EXPLAIN QUERY PLAN` of the direct history statements is identical at version 7 and at version 9 (NFR-04). A version-9 database opened with a directory of only 0001 to 0008 gives `MIGRATION_HISTORY_MISMATCH` and changes nothing. A static scan fails if DATA opens or imports the standalone database or `server/src/db5db6`.
      - Every case runs on a temporary database that the test creates and removes, with the failing file in a temporary directory, and starts no container. No test opens `DATA/server/database/database.sqlite` or the database file on the volumes of a running Docker_Environment project (DB5-R14.17, R14.21); the container-level rehearsal of 0009 is T-6B-51, in a Disposable_Project.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R14.6, DB5-R14.9, DB5-R14.10, DB5-R14.11, DB5-R14.16, DB5-R14.17, DB5-R14.19, DB5-R14.21, ARCH-R01.2, ARCH-R01.10, ARCH-R01.11, NFR-04_

  - [ ] 8.4 Add the direct-SQL constraint tests for the 0009 triggers and reservations
    - **ID**: T-6B-04
    - **Depends on**: T-6B-01, T-5B-21
    - **Affected modules**: `DATA/tests/attachments-repository.test.js` (new; extended in T-6B-20)
    - **Acceptance criteria**:
      - Each direct SQL attempt is rejected and leaves the rows unchanged: an update of `conversation_id`, `uploaded_by`, `storage_key`, `byte_size`, `created_at`, `integrity_digest`, the descriptors, `encrypted_metadata` or `media_type` (`attachments_immutable`); a status change other than pending to ready, pending to deleted or ready to deleted; any change to a deleted row except `purge_state` moving from `not_purged` to `purged`; `ready` without a `message_id`; a change of `message_id`; a `message_id` that names a message of another sender or another conversation; `deleted` without `deleted_at` or the reverse; `purged` on a row that is not deleted; a purged row going back; metadata over 16384 characters on insert.
      - The three valid transitions succeed. `AttachmentReservations` rejects a user or conversation that does not exist (RESTRICT) and a malformed `source_digest` or a `declared_bytes` below 1.
    - **Verify**: `node --test tests/attachments-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.3, DB6-R01.6, DB6-R01.11, DB5-R14.12_

  - [ ] 8.5 Write property test P-27 for upgrades to version 9
    - **ID**: T-6B-05
    - **Depends on**: T-6B-03, T-5B-18
    - **Property P-27: Upgrade from version 7 keeps every row and matches a fresh schema (clauses for 0009)**
    - **Validates: Requirements DB5-R14.3, DB5-R14.6, DB5-R14.7, DB5-R14.8, DB5-R14.11, DB5-R14.13, DB6-R01.2, ARCH-R01.11, ARCH-R02.5, COMP-03**
    - **Affected modules**: `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - For 100 generated databases at version 7, including `Attachments` rows in every status, and a variant at version 8, the upgrade to version 9 keeps every pre-existing column value of every version-7 table (row-by-row digest) and equals a fresh version-9 schema in tables, columns with type, nullability and default, indexes, triggers and foreign keys.
      - `foreign_key_check` is empty, migrated `Attachments` rows have `purge_state` `not_purged` and NULL in every other new column, and `Messages` has no `group_id`.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.6 Write property test P-28 for repeat runs and a failing 0009
    - **ID**: T-6B-06
    - **Depends on**: T-6B-05
    - **Property P-28: Repeat runs change nothing and a failing batch rolls back completely (clauses for 0009)**
    - **Validates: Requirements DB5-R11.2, DB5-R14.9, DB5-R14.10, DB5-R15.7**
    - **Affected modules**: `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - Running the runner n times on a populated version-9 database applies zero migrations and leaves `SchemaMigrations` and every row byte-identical.
      - A generated failing statement (syntax, constraint or foreign key) at a random position of a copy of 0009 in a temporary directory gives `MIGRATION_FAILED` that names the file and no path, and schema, ledger and rows equal their earlier state, also when 0008 and 0009 are pending in one batch.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.7 Create the Storage_Provider contract module
    - **ID**: T-6B-07
    - **Depends on**: T-6A-23, T-5C-52
    - **Affected modules**: `DATA/server/attachments/storage/provider.js` (new), `DATA/tests/attachments-storage-contract.test.js` (new; extended in later tasks)
    - **Acceptance criteria**:
      - `provider.js` carries the JSDoc interface of the operations in `attachments-storage-contract.md`, `assertStorageProvider(candidate)` that throws when an operation is missing, a `StorageError` that carries only one of the codes `STORAGE_KEY`, `STORAGE_EXISTS`, `STORAGE_SIZE`, `STORAGE_MISSING` and `STORAGE_IO`, `STORAGE_KEY_PATTERN` (`^[a-z0-9]{32,128}$`) and `generateStorageKey()` (24 bytes from `crypto.randomBytes`, 48 lowercase hexadecimal characters). The export names are chosen here.
      - The test file starts with examples: a generated key matches the pattern and carries 192 random bits, 10000 draws do not collide, `assertStorageProvider` rejects an object that lacks any operation, and a `StorageError` has no message, path or cause member.
    - **Verify**: `node --test tests/attachments-storage-contract.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R02.1, DB6-R02.3, DB6-R02.7, DB6-R02.11_

  - [ ] 8.8 Implement the upload frame codec
    - **ID**: T-6B-08
    - **Depends on**: T-6A-23, T-5C-52
    - **Affected modules**: `DATA/server/attachments/frame.js` (new), `DATA/tests/attachments-validation.test.js` (new)
    - **Acceptance criteria**:
      - `encode(header, bytes)` (used by tests and helpers) and `parseHeader(stream, {maxHeaderBytes})` implement the frame of `attachments-upload-frame.md` (prefix width and byte order, header cap, JSON header). `parseHeader` reads only the prefix and the header and leaves the rest of the stream unread for the caller. It rejects a prefix above the cap, a truncated header, non-JSON, a non-object, an unknown field and a field of the wrong type with a typed error, before any content byte is read, and names the offending field only when it matches `^[a-zA-Z][a-zA-Z0-9]{0,63}$`.
      - Examples cover each failure, the hex vectors of `attachments-upload-frame.md` and a round trip with 0 bytes, 1 byte and a few MiB. No dependency is added (multipart is rejected by ADR-09).
    - **Verify**: `node --test tests/attachments-validation.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.1, DB6-R04.12, DB6-R05.12, NFR-09_

  - [ ] 8.9 Implement `attachments/validation.js` for the upload header and the size limit table
    - **ID**: T-6B-09
    - **Depends on**: T-6B-08
    - **Affected modules**: `DATA/server/attachments/validation.js` (new), `DATA/tests/attachments-validation.test.js`
    - **Acceptance criteria**:
      - The upload validator checks `conversationId` (the id rules of the existing validators), `byteSize` (a positive integer), `encryptedMetadata` (a non-empty string of at most 16384 characters), `algorithm` and `formatVersion` (1 to 64 characters each). It answers 400 with the offending names in `fields` before any content byte is read. Under the OD-16 default a missing declaration or missing metadata is 400.
      - The limit table is imported from `shared/attachmentPolicy.ts` (Node type stripping, as the test helpers import `client/src/utils/crypto.ts`): per-file limits by category, 5 files and 100 MB per message, 1 MB = 1,048,576 bytes, and 52,428,800 bytes when no category is named. `sizeDecision(declared, category)` returns accept, 413, or the 400 or 413 result of the size rule in `attachments-upload-frame.md`.
      - Example tests cover the limits (0, 1, limit - 1, limit, limit + 1).
    - **Verify**: `node --test tests/attachments-validation.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.1, DB6-R04.1, DB6-R04.2, DB6-R05.3, DB6-R05.5, DB6-R05.12_

  - [ ] 8.10 Write property test P-39 for the limit table
    - **ID**: T-6B-10
    - **Depends on**: T-6B-09, T-5B-10
    - **Property P-39: The server size limits equal the client policy**
    - **Validates: Requirements DB6-R04.1, DB6-R04.2, DB6-R04.11**
    - **Affected modules**: `DATA/tests/attachments-policy.test.js` (new)
    - **Acceptance criteria**:
      - For each category (image, document, audio, archive, video) the per-file limit of the server equals the matching `ATTACHMENT_LIMITS` value in MB times 1,048,576, the per-message count equals `maxCount`, the per-message total equals `maxTotalSizeMb` times 1,048,576, and 52,428,800 bytes applies when no category is named.
      - For sizes 0, 1, limit - 1, limit, limit + 1 and random values up to twice the limit in at least 100 runs, the check accepts exactly the sizes up to the limit and answers 413 above it. A mutated copy of the limit table makes the test fail.
    - **Verify**: `node --test tests/attachments-policy.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.11 Add the test helpers `support/storage-providers.js` and `support/attachments.js`
    - **ID**: T-6B-11
    - **Depends on**: T-6B-07, T-6B-08, T-5B-21
    - **Affected modules**: `DATA/tests/support/storage-providers.js` (new), `DATA/tests/support/attachments.js` (new)
    - **Acceptance criteria**:
      - `storage-providers.js` is the registry of provider factories (each builds a provider on a new temporary root) and offers a check that fails when a factory exported under `attachments/storage/` is not registered. `attachments.js` offers the frame builder, a storage-root helper under `os.tmpdir()` (prefix `secubuzz-db5-`, removed in `t.after`, a guard that refuses a path whose real path is outside `os.tmpdir()`), an upload helper over the existing `Browser`, and a snapshot extension that adds the storage directory listing (file names and byte sizes) to the table hashes of `support/groups.js`.
      - The helpers use the injected clock and limiter, load no `.env` file and contain no `database.sqlite` literal (the static check of T-5B-21 passes).
    - **Verify**: `node --test tests/attachments-storage-contract.test.js tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R15.1, DB5-R11.6, DB6-R02.11, NFR-07, NFR-08_

  - [ ] 8.12 Implement the filesystem provider: root and key resolution
    - **ID**: T-6B-12
    - **Depends on**: T-6B-07
    - **Affected modules**: `DATA/server/attachments/storage/filesystem.js` (new), `DATA/tests/attachments-storage-contract.test.js`
    - **Acceptance criteria**:
      - `createFilesystemProvider({root, repositoryRoot})` resolves the real path of the root at creation and refuses, with a `StorageError` and a reason code for the Feature_Gate, a root that is relative, missing, not a writable directory, inside the repository working tree (the parent of `DATA/`, found from the location of `app.js`) directly, through `..` or through a link, or at or below a statically served directory. It probes whether a hard link can be created in the root and records the result for T-6B-17.
      - `resolve(key)` accepts only `^[a-z0-9]{32,128}$`, rejects the Windows device names `con`, `prn`, `aux`, `nul`, `com1` to `com9` and `lpt1` to `lpt9` in any case, joins the key to the root and checks that `path.dirname(result)` equals the root. Separators, `..`, absolute and drive-letter forms, `:` and every other character fail. No error returns the root or a path. Directories are created with mode 0700.
      - The containment and writability decision is a function of the resolved root, the repository root and the path flavour, so the tests run it with the values of the Docker_Environment: the reserved volume path `/var/lib/secubuzz/attachments` against the working tree `/workspace` is accepted, and a root inside `/workspace`, a `..` form and a link into it are refused, with the same cases in Windows form on a Windows host (COMP-09). No test creates a directory under `/var/lib/secubuzz/` or touches the volumes of a running project (DB5-R14.17).
    - **Verify**: `node --test tests/attachments-storage-contract.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R02.2, DB6-R02.3, DB6-R02.4, DB6-R02.7, DB6-R02.8, DB6-R02.9, COMP-09, COMP-10_

  - [ ] 8.13 Implement the filesystem `write` by adapting the standalone streaming write
    - **ID**: T-6B-13
    - **Depends on**: T-6B-12, T-6A-20
    - **Affected modules**: `DATA/server/attachments/storage/filesystem.js`, `server/src/storage/attachmentStorage.cjs` (read-only), `DATA/tests/attachments-storage-contract.test.js`
    - **Acceptance criteria**:
      - `write(key, readable, {maxBytes})` adapts the standalone writer (a `.part` file opened with flag `wx` and mode 0600, a byte-counting Transform that aborts above `maxBytes`, SHA-256, rename). It differs in these points: a validated 48-character hexadecimal key instead of `randomUUID`, a configured root outside the working tree and no directory created at import, finalisation by link so that an existing file is never replaced, a 64 KiB high-water mark that keeps memory bounded, and sanitised errors. It returns `{byteCount, sha256}`.
      - On abort, size excess, I/O error or an existing final file it removes the `.part` file, leaves any existing file unchanged and throws a `StorageError`. The inventory entry and the change description record the original author and source file of the adapted logic (ARCH-R03.7). The standalone file is not edited: G2 prints nothing.
    - **Verify**: `node --test tests/attachments-storage-contract.test.js` in DATA/; G2
    - **Agent**: Kiro
    - _Requirements: DB6-R02.5, DB6-R02.6, DB6-R02.7, DB6-R02.9, DB6-R02.13, DB6-R04.10, ARCH-R03.4, ARCH-R03.7, NFR-05_

  - [ ] 8.14 Implement the filesystem `read`, `stat`, `exists`, `delete`, `usage`, `sweepTemporary` and `listKeys`
    - **ID**: T-6B-14
    - **Depends on**: T-6B-13
    - **Affected modules**: `DATA/server/attachments/storage/filesystem.js`, `DATA/tests/attachments-storage-contract.test.js`
    - **Acceptance criteria**:
      - `read(key)` validates the key, requires `lstat` to report a regular file that is not a link, and returns `{stream, byteCount}`. `stat` returns the length or null, `exists` a boolean, `delete` removes the file and returns false when it is absent (idempotent), `usage()` returns `{bytes, files}`, `sweepTemporary(olderThanMs)` removes `.part` files older than the age and returns their count, and `listKeys()` lists final keys without paths.
      - A missing file gives `STORAGE_MISSING` and any other failure `STORAGE_IO`. No result or error carries a path, the root or operating system text.
    - **Verify**: `node --test tests/attachments-storage-contract.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R02.1, DB6-R02.4, DB6-R02.7, DB6-R02.10, DB6-R03.14_

  - [ ] 8.15 Run the shared storage contract suite for every registered provider
    - **ID**: T-6B-15
    - **Depends on**: T-6B-14, T-6B-11
    - **Affected modules**: `DATA/tests/attachments-storage-contract.test.js`
    - **Acceptance criteria**:
      - The same suite runs for each registered provider (today `filesystem`): the hostile key corpus (100 keys per class), stream faults (abort at a random byte, injected I/O error, size over `maxBytes`, existing final file), no `.part` file left, no replacement, `byteCount` and `sha256` equal to an independent computation, no absolute path or root in any error, the platform branches of the last bullet, and the registry completeness check.
      - Example tests name the Windows device names in any case, trailing dots and spaces, 8.3 forms, percent-encodings and `:` stream syntax (COMP-09).
      - The three platform-dependent assertions are one test each that branches on `process.platform` and asserts the expectation of that platform; none is skipped (DB5-R15.16). File mode: on POSIX (the Validation_Runner and the Docker volume, where the process runs as UID 1000) a stored file has mode 0600 and the root and its directories 0700; on `win32` the file is created and is readable and writable by its creator and the mode request raised no error, with no permission bits asserted. Link refusal: `read` and `write` refuse a link at the key path where a link can be created, and where `fs.symlink` fails with `EPERM` the same refusal is asserted through an injected `lstat` result that reports a link. Link-based rename: on both platforms `write` publishes through a hard link, an existing final file is left unchanged (`EEXIST`), the temporary name is gone and the final file has one link, and an injected `EPERM` or `EXDEV` covers a filesystem on which `fs.link` fails. The suite runs on Linux in the Validation_Runner (the gate of record) and on the Windows host (additional evidence).
    - **Verify**: `node --test tests/attachments-storage-contract.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R02.11, DB6-R02.4, DB6-R02.5, DB6-R02.6, DB6-R02.7, DB6-R02.9, DB6-R02.13, DB5-R15.16, COMP-09_

  - [ ] 8.16 Write property test P-33 for storage keys and partial writes
    - **ID**: T-6B-16
    - **Depends on**: T-6B-15, T-5B-10
    - **Property P-33: Storage keys are safe and a failed write leaves nothing**
    - **Validates: Requirements DB6-R02.1, DB6-R02.3, DB6-R02.4, DB6-R02.5, DB6-R02.6, DB6-R02.7, DB6-R02.9, DB6-R02.13, DB6-R04.12, COMP-09**
    - **Affected modules**: `DATA/tests/attachments-storage-contract.test.js`
    - **Acceptance criteria**:
      - For any string used as a key (random Unicode, strings of the pattern alphabet of 0 to 200 characters, the hostile corpus) the provider either throws `STORAGE_KEY` or resolves to a path whose directory equals the real root. Generated keys match the pattern, carry at least 128 random bits and do not collide in 10000 draws.
      - For any stream (0 bytes to a few MiB, random chunking) that is aborted at a random byte, meets an injected I/O error, exceeds `maxBytes` or meets an existing file at the final key, the write rejects, leaves no `.part` file and no new final file, and leaves an existing file unchanged. A successful write returns `byteCount` and `sha256` equal to an independent computation, never replaces a file and creates files with the mode that the platform branch of T-6B-15 asserts (0600 on POSIX). No error or result contains an absolute path or the root. The suite runs 100 keys per class and 100 streams for every registered provider.
    - **Verify**: `node --test tests/attachments-storage-contract.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.17 Add the large-stream memory example and record the hard-link probe result
    - **ID**: T-6B-17
    - **Depends on**: T-6B-16
    - **Affected modules**: `DATA/tests/attachments-storage-contract.test.js`, `DATA/docs/db5-db6-handoff.md` (R-10 note)
    - **Acceptance criteria**:
      - A generated stream of several tens of MiB is written and read through the provider while the test samples `process.memoryUsage()`. A threshold constant, fixed after one measurement and noted in the handoff, shows that memory use does not grow with the file size (NFR-05, DB6-R04.10).
      - The handoff records the hard-link probe result on the Windows host and in the Validation_Runner (Linux, the gate of record); T-6B-51 adds the result on the `private-storage` volume of a Disposable_Project (R-10, CI-28). It records the documented fallback if linking fails (an exclusive-create copy with a digest check, run under the same contract suite). Any other target filesystem is named by the Project_Owner; none is assumed.
    - **Verify**: `node --test tests/attachments-storage-contract.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R04.10, DB6-R02.13, DB5-R15.16, NFR-05, COMP-09_

  - [ ] 8.18 Create `attachmentRepository.js` with the core and read functions
    - **ID**: T-6B-18
    - **Depends on**: T-6B-01, T-5B-22
    - **Affected modules**: `DATA/server/database/attachmentRepository.js` (new), `DATA/tests/attachments-repository.test.js`
    - **Acceptance criteria**:
      - `createAttachmentRepository(db)` composes `createRepositories(db)` and calls the existing `repositories.attachments` functions where they exist instead of duplicating their SQL. Write functions throw `TypeError` unless `db.inTransaction`. Errors are normalised by the same six classes as the Group_Repository. Every statement binds its values as parameters.
      - Read functions: `getById`, `usageForUser` and `usageForConversation` (sum of `byte_size` of `pending` and `ready` rows), `pendingCountForUser`, `reservationUsage` (sum of live reservations by user and by conversation, counts by user and by `source_digest`, rows past `expires_at` excluded), `listExpiredPending(nowIso, limit)`, `listPurgeCandidates(beforeIso, limit)` and `listExpiredReservations(nowIso, limit)`.
      - `EXPLAIN QUERY PLAN` of the usage, pending-count, expiry and purge statements uses `idx_attachments_uploader_usage`, `idx_attachments_conversation`, `idx_attachments_pending_expiry`, `idx_attachments_purge` or the reservation indexes and does not scan `Attachments` in full (NFR-03).
    - **Verify**: `node --test tests/attachments-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.1, DB6-R04.4, ARCH-R01.6, DB5-R14.14, NFR-01, NFR-03_

  - [ ] 8.19 Add the attachment and reservation write functions
    - **ID**: T-6B-19
    - **Depends on**: T-6B-18
    - **Affected modules**: `DATA/server/database/attachmentRepository.js`, `DATA/tests/attachments-repository.test.js`
    - **Acceptance criteria**:
      - `insertReservation`, `deleteReservation`, `deleteExpiredReservations`, `insertPending` (status `pending`, `expires_at`, `integrity_digest`, descriptors, `media_type` `application/octet-stream`, storage key, encrypted metadata), `associate(ids, messageId, at)` (a compare-and-set on `status='pending'` and `message_id IS NULL`, one statement per id, `CONFLICT` unless every row changed), `markDeleted(id, at)` (`WHERE status IN ('pending','ready')`, sets `deleted_at`) and `markPurged(id)` (`WHERE status='deleted' AND purge_state='not_purged'`) exist.
      - A stale expectation throws `CONFLICT`, a write outside a transaction throws `TypeError`, and no function updates `uploaded_by` or `conversation_id`.
    - **Verify**: `node --test tests/attachments-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.3, DB6-R01.4, DB6-R01.6, DB6-R01.11, DB6-R04.4, NFR-01_

  - [ ] 8.20 Add the attachment repository tests
    - **ID**: T-6B-20
    - **Depends on**: T-6B-19, T-6B-04
    - **Affected modules**: `DATA/tests/attachments-repository.test.js`
    - **Acceptance criteria**:
      - An example test for each function covers the compare-and-set outcomes, a rolled-back transaction that leaves no trace, usage sums that count `pending` and `ready` rows plus live reservations only, and reservations past `expires_at` that are excluded.
      - Static scans fail when attachment SQL occurs outside `repositories.js` and `attachmentRepository.js`, when group SQL occurs in `attachmentRepository.js`, or when a `prepare` call interpolates a value.
    - **Verify**: `node --test tests/attachments-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R14.14, ARCH-R01.6, DB6-R01.1, DB6-R04.4, NFR-01, NFR-03_

  - [ ] 8.21 Complete `features/config.js` for the attachment switch and settings
    - **ID**: T-6B-21
    - **Depends on**: T-6B-12, T-5C-01
    - **Affected modules**: `DATA/server/features/config.js`, `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - With `ATTACHMENTS_API_ENABLED=true`, `loadFeatureConfig` requires `ATTACHMENT_PENDING_TTL_SECONDS`, `ATTACHMENT_PURGE_DELAY_SECONDS`, `ATTACHMENT_RETENTION_INTERVAL_SECONDS`, `ATTACHMENT_QUOTA_USER_BYTES`, `ATTACHMENT_QUOTA_CONVERSATION_BYTES`, `ATTACHMENT_MAX_PENDING_PER_USER`, `ATTACHMENT_UPLOADS_PER_HOUR`, `ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER` and `ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE` as positive whole numbers, accepts the optional `ATTACHMENT_UPLOAD_TIMEOUT_SECONDS`, and otherwise throws `FeatureConfigError` that names exactly the offending settings and no value. `ATTACHMENT_STORAGE_DIR` is read, but its absence does not stop the start: it keeps the Attachment_API disabled (T-6B-22).
      - With `NODE_ENV=production`, a switch that is on also needs `ATTACHMENTS_API_GATE_RECORD` matching `GR-[A-Z0-9-]{3,48}` (OP-11, format check only). The injected `features.attachments` object carries the same settings as plain per-app data.
      - The upload rate and the per-source concurrent-upload limit are plain settings (OP-19): configurable, with no built-in trust of forwarded headers and no entry added to `AUTH_TRUST_PROXY_IPS`. In the Docker_Environment every request reaches DATA from 127.0.0.1, so the per-source bucket is one bucket for all users of a project (F24); the per-user and per-conversation settings are what tell users apart. The Docker files set none of these settings (G8).
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.1, DB5-R16.5, DB5-R16.7, DB6-R03.15, DB6-R04.5, DB6-R04.6, DB6-R04.7, COMP-10_

  - [ ] 8.22 Extend `features/gate.js` and feature-status with the storage-root readiness
    - **ID**: T-6B-22
    - **Depends on**: T-6B-21, T-6B-12
    - **Affected modules**: `DATA/server/features/gate.js`, `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - `createFeatureGate(config)` reports `attachmentApi: true` only when the switch is on and the provider built from `ATTACHMENT_STORAGE_DIR` passes the root checks of T-6B-12. Otherwise it reports false and the start-up log names the setting `ATTACHMENT_STORAGE_DIR`, never its value. `groupMessaging` stays true only while `groupApi` is true, and the feature-status body keeps exactly the three booleans.
      - `assertEnabled('attachments')` and `middleware('attachments')` answer 503 FEATURE_UNAVAILABLE before any rate-limit write or attachment read.
      - Example tests cover each root candidate: relative, inside the working tree directly, through `..`, through a link, a file, missing, not writable, and a valid external directory, including the Docker_Environment value `/var/lib/secubuzz/attachments` against the working tree `/workspace`, which makes `attachmentApi` true with no Compose change (COMP-10).
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.1, DB5-R16.4, DB5-R16.13, DB6-R02.2, DB6-R02.8, COMP-10_

  - [ ] 8.23 Build the Attachment_Service infrastructure in `attachments/service.js`
    - **ID**: T-6B-23
    - **Depends on**: T-6B-19, T-6B-14, T-6B-09, T-6B-22, T-5C-03
    - **Affected modules**: `DATA/server/attachments/service.js` (new), `DATA/tests/attachments-service.test.js` (new; file name chosen here)
    - **Acceptance criteria**:
      - `createAttachmentService({db, auth, features, storage, limiter, now, settings})` composes `createSocialRepository(db)`, `createAttachmentRepository(db)` and the Group_Repository read functions `getVisibleGroup` and `getMember`. It offers `attachmentRead` (deferred transaction) and `attachmentWrite` (session check, CSRF proof as `groupWrite` does, immediate transaction, synchronous `work`). No transaction spans an await.
      - An access check resolves a conversation for the requester. A direct conversation must pass the direct send rule that the direct path uses (`directVisible`, `isBlocked` and the friendship check, reused and not edited): a block gives 404 and a pair that is not friends gives 403 (the DC-02 literals). A group must be visible and the requester an Active_Member. Every other case, an unknown or malformed identifier and a removed member included, gives one `notFound()` with an identical 404 body. The service passes the Storage_Provider only a key, a byte stream and the size limit.
      - One mapping turns repository classes and `STORAGE_*` codes into `AuthError`: `DUPLICATE` and `CONFLICT` to 409, `INVALID` and `REFERENCE` to 400, `BUSY`, `UNAVAILABLE`, `STORAGE_IO` and `STORAGE_MISSING` to 503 `SERVICE_UNAVAILABLE` with empty `fields`, anything else to 500, with no database text and no path. The audit helper writes one `AuditLogs` row in the same transaction (source `attachments`, a name chosen here; subject the attachment id; allowed keys only; an empty actor for the Retention_Job) and rethrows a failed insert as 500 `INTERNAL_ERROR`. The read, mutation and upload rate buckets and their numbers sit in one module (ASM-03).
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R01.4, ARCH-R01.5, ARCH-R01.6, DB6-R02.10, DB6-R02.15, DB6-R03.2, DB6-R03.3, DB6-R03.16, DB6-R03.19, DB5-R12.5, DB5-R12.8, DB5-R12.9, DB5-R13.5, NFR-01, NFR-06_

  - [ ] 8.24 Implement the upload reserve step
    - **ID**: T-6B-24
    - **Depends on**: T-6B-23
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-service.test.js`
    - **Acceptance criteria**:
      - `reserve(actor, header)` runs in one immediate transaction: the gate, session and CSRF, the access check, the archive state (409 CONFLICT for an archived group), the per-file size limit (413), the per-user and per-conversation byte quotas (the sum of `byte_size` of `pending` and `ready` rows plus live reservations), the pending count, the concurrent-upload counts per user and per `source_digest` (the SHA-256 of the source address, never the address) and the upload rate through the injected limiter. It inserts one reservation row whose `expires_at` follows OP-08 and commits.
      - A quota or pending-count refusal answers 409 `QUOTA_EXCEEDED`. A rate or concurrency refusal answers 429 with `Retry-After` of at least 1 second. A refusal changes no row except the limiter counters, and two reserves in flight cannot exceed a quota because the check and the insert share one immediate transaction.
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.1, DB6-R03.2, DB6-R03.3, DB6-R04.2, DB6-R04.4, DB6-R04.5, DB6-R04.6, DB6-R04.7, NFR-01_

  - [ ] 8.25 Implement the upload stream and finalize steps
    - **ID**: T-6B-25
    - **Depends on**: T-6B-24, T-6B-13
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-service.test.js`
    - **Acceptance criteria**:
      - The stream step writes through `storage.write(key, stream, {maxBytes})` with a key from `generateStorageKey()`, reads at most the declared size plus one byte and applies the size rule of `attachments-upload-frame.md`: 413 when the stream passes the declared size and also the per-file limit, 400 when it ends short or passes the declared size within the limit.
      - The finalize step runs in an immediate transaction. It re-checks access and archive state, compares the streamed count with the declared size, inserts the `Attachments` row (status `pending`, `expires_at` of now plus the pending TTL, `integrity_digest`, descriptors, `media_type` `application/octet-stream`, the encrypted metadata), deletes the reservation, writes the audit event `attachment.uploaded` and commits. An upload never produces a `ready` row (DB6-R02.14), and `conversation_id` and `uploaded_by` are set once and never changed.
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.3, DB6-R02.14, DB6-R02.15, DB6-R03.1, DB6-R03.17, DB6-R04.2, DB6-R04.3, DB6-R04.10, DB6-R05.4, DB6-R05.5_

  - [ ] 8.26 Implement the failure cleanup, crash recovery and reservation expiry
    - **ID**: T-6B-26
    - **Depends on**: T-6B-25
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-service.test.js`
    - **Acceptance criteria**:
      - Every upload path ends in one `finally` that deletes the temporary or final file and then the reservation, each as its own step. A cleanup error never replaces the response status and is counted in the log. A refused, aborted or failed upload (malformed frame, oversize, short stream, storage error, a refusal at finalize, an audit failure) leaves no `Attachments` row, no stored or temporary file, no reservation and no counted usage.
      - A storage or database failure answers 503 `SERVICE_UNAVAILABLE` with `[]`, no path and no operating system text, and an audit write failure answers 500 (CI-17). A member removed meanwhile gets 404 at finalize and a group archived meanwhile 409. A reservation left by a killed process counts until its `expires_at` and is removed by the Retention_Job (T-6B-37).
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R02.6, DB6-R02.10, DB6-R02.14, DB6-R03.16, DB6-R04.12, DB5-R12.9, NFR-06_

  - [ ] 8.27 Implement the metadata read (A03)
    - **ID**: T-6B-27
    - **Depends on**: T-6B-26
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-service.test.js`
    - **Acceptance criteria**:
      - `metadata(actor, id)` returns the projection `{ id, conversationId, messageId, uploadedBy, byteSize, status, createdAt, expiresAt, integrityDigest, algorithm, formatVersion, encryptedMetadata }` for a pending attachment only to its uploader, and for a ready attachment to an Active_Member of the conversation (DB-6D adds the permitted-range check).
      - Every other case, an unknown identifier included, gives the same 404 and changes no row. `storage_key` and any path never appear in a response or an error.
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.7, DB6-R01.8, DB6-R03.4, DB6-R03.19_

  - [ ] 8.28 Implement the deletion (A05)
    - **ID**: T-6B-28
    - **Depends on**: T-6B-27
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-service.test.js`
    - **Acceptance criteria**:
      - `remove(actor, id)` lets the uploader, still an Active_Member, delete a pending or ready attachment. One immediate transaction sets `status='deleted'` and `deleted_at` by compare-and-set and writes `attachment.deleted`. After the commit the bytes are removed and `purge_state` is set to `purged`; if the byte removal fails the row stays `not_purged` for the Retention_Job. The metadata row is kept.
      - A second call answers 404, and nobody else may delete an attachment (OD-03, OD-13 and OD-18 provisional). A deleted attachment never changes status again.
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.6, DB6-R01.11, DB6-R03.12, DB6-R03.17, DB6-R03.18_

  - [ ] 8.29 Implement the message association (A02)
    - **ID**: T-6B-29
    - **Depends on**: T-6B-28
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-service.test.js`
    - **Acceptance criteria**:
      - `associate(actor, {conversationId, messageId, attachmentIds})` runs in one immediate transaction. Each attachment must be pending, unexpired, in the conversation, uploaded by the requester and not yet associated. The message must be committed in that conversation and sent by the requester. The attachments of the message, those already associated included, number at most 5 and total at most 104,857,600 bytes (OP-02, CI-18). All attachments become `ready` with the `message_id`, or none changes. Audit event `attachment.associated`.
      - A missing attachment, another conversation or another uploader gives 404. An attachment that is not pending, is expired or is already associated, or a message that is not committed, gives 409 CONFLICT. More than 5 files or more than 100 MB gives 400 VALIDATION_ERROR. Every failure changes no record, the valid attachments of the request included.
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.3, DB6-R01.4, DB6-R01.5, DB6-R03.17, DB6-R04.11_

  - [ ] 8.30 Implement the download with the 503-before-first-byte rule (A04)
    - **ID**: T-6B-30
    - **Depends on**: T-6B-29, T-6B-14
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-service.test.js`
    - **Acceptance criteria**:
      - `download(actor, id)` re-checks membership and the attachment state (`ready`) in a read transaction, then compares `storage.stat(key).byteCount` with `byte_size` before any header is set. A missing file or a different length writes one audit row (`attachment.download.unavailable`, `reason_code` `missing` or `length_mismatch`, `target_id` the attachment id) in its own short transaction and answers 503 SERVICE_UNAVAILABLE with `[]`, no attachment byte and no change to `Attachments`. A failed audit write keeps the 503 and is counted in the log.
      - On success it returns a stream and the headers `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and `Content-Length`. An error or an abort after the first byte destroys the response. The event `attachment.downloaded` is written only after the last byte was sent. A pending, deleted, unknown or inaccessible attachment gives the uniform 404 and sends no byte.
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R02.10, DB6-R03.5, DB6-R03.6, DB6-R03.7, DB6-R03.17, DB6-R03.19, DB6-R04.10, NFR-08_

  - [ ] 8.31 Implement the file search (A06)
    - **ID**: T-6B-31
    - **Depends on**: T-6B-30, T-5B-12
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/server/attachments/validation.js`, `DATA/tests/attachments-service.test.js`
    - **Acceptance criteria**:
      - `search(actor, query)` accepts only `conversationId`, `uploadedBy`, `minBytes`, `maxBytes`, `createdAfter`, `createdBefore`, `limit` (1 to 50, default 20) and `cursor`. Any other parameter, a name or content filter or a media type class included, answers 400 VALIDATION_ERROR naming the parameter. A range whose minimum exceeds its maximum, a limit outside 1 to 50, and a cursor that is malformed or was issued for another requester or filter set answer 400. Cursors come from `groups/cursor.js`, bound to the requester and a digest of the filters.
      - It returns the ready attachments of conversations in which the requester is an Active_Member, newest first by `created_at` and `attachment_id`, in pages, with a null `nextCursor` on the last page, through `idx_attachments_search`. DB-6D adds the permitted-range predicate to the same query.
    - **Verify**: `node --test tests/attachments-service.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.9, DB6-R03.10, DB6-R03.11, DB6-R03.20, NFR-03_

  - [ ] 8.32 Add the router skeleton in `routes/attachments.js` and mount it in `createApp`
    - **ID**: T-6B-32
    - **Depends on**: T-6B-23, T-6B-09, T-5C-04
    - **Affected modules**: `DATA/server/routes/attachments.js` (new), `DATA/server/app.js` (mount and returned members only), `DATA/tests/attachments-http.test.js` (new)
    - **Acceptance criteria**:
      - `createAttachmentRouters(attachments, middleware)` returns `{attachments, files}`. Both routers run, in order, the existing Origin check, `requireAuth`, `requireCsrf` for every method except GET and HEAD, the gate (503 FEATURE_UNAVAILABLE before any rate-limit write or attachment read), the rate limit (separate read, mutation and upload buckets), and a frozen route table, then a final NOT_FOUND. The A01 body is not passed through a JSON parser; the other bodies follow the group body rules (8 KiB, JSON only, 413 and 400 as there). `/api/files` serves only `GET /search`, and every other path and method under it answers 404. No static route is mounted on the storage root or a directory that contains it. The router never reads `AUTH_MIDDLEWARE_MODULE`.
      - `createApp` takes `storage` and the attachment settings from `features`, mounts `/api/attachments` and `/api/files` after the group mount and before the legacy 503 stub, and returns `attachments`. Existing mounts and response shapes are unchanged (COMP-02). With the switch off every route answers 503. The T-5B-22 test, keyed to the existence of `routes/attachments.js`, expects the mounted behavior without an edit. Every response carries no-store and nosniff.
    - **Verify**: `node --test tests/attachments-http.test.js tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R01.3, ARCH-R01.4, ARCH-R01.5, DB5-R12.3, DB5-R12.10, DB5-R16.4, DB6-R02.12, DB6-R03.21, COMP-02, NFR-08_

  - [ ] 8.33 Add the upload route A01
    - **ID**: T-6B-33
    - **Depends on**: T-6B-32, T-6B-26
    - **Affected modules**: `DATA/server/routes/attachments.js`, `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - `POST /api/attachments` reads the frame header through `parseHeader` and validates it before any content byte is read, checks `Content-Length` against the header and the declared size when present, runs reserve, stream and finalize, and answers 201 `{attachment}` with status `pending`. The statuses and codes follow the A01 row: 400, 403, 404, 409 (archived group, `QUOTA_EXCEEDED`), 413, 429 and 503.
      - Tests cover the 201, an oversize declaration, a size mismatch, a missing declaration, missing metadata, metadata over 16384 characters, a frame cut in the middle, an archived group, a blocked and a non-friend direct peer, and a removed member. Each refusal leaves no row, file or reservation.
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.1, DB6-R03.2, DB6-R03.3, DB6-R04.2, DB6-R04.3, DB6-R04.12, DB6-R05.3, DB6-R05.12_

  - [ ] 8.34 Add the metadata and deletion routes A03 and A05
    - **ID**: T-6B-34
    - **Depends on**: T-6B-33, T-6B-28
    - **Affected modules**: `DATA/server/routes/attachments.js`, `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - `GET /api/attachments/:id` answers 200 `{attachment}` and `DELETE /api/attachments/:id` answers 204. A malformed identifier and every denial cause answer the same 404. A pending attachment is visible only to its uploader.
      - Tests cover the second DELETE (404), a delete by another member (404), and that `storage_key` appears in no response.
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.7, DB6-R01.8, DB6-R03.4, DB6-R03.12, DB6-R03.19_

  - [ ] 8.35 Add the association route A02
    - **ID**: T-6B-35
    - **Depends on**: T-6B-34, T-6B-29
    - **Affected modules**: `DATA/server/routes/attachments.js`, `DATA/server/attachments/validation.js`, `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - `POST /api/attachments/associations` is registered before `/:id`. The validator accepts `{conversationId, messageId, attachmentIds}` with 1 to 5 distinct identifiers, refuses unknown fields and answers 400 with the field names. The success answer is 200 `{attachments}` with every attachment `ready`.
      - Tests cover each 404, 409 and 400 case of T-6B-29 through HTTP, and a retry after success (409).
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.4, DB6-R01.5, DB6-R04.11_

  - [ ] 8.36 Add the download and search routes A04 and A06
    - **ID**: T-6B-36
    - **Depends on**: T-6B-35, T-6B-31
    - **Affected modules**: `DATA/server/routes/attachments.js`, `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - `GET /api/attachments/:id/download` pipes the stream with `stream.pipeline`, sets the headers of T-6B-30 and never uses `sendFile`. `GET /api/files/search` returns 200 `{items, nextCursor}`.
      - Tests cover equal bytes and digest, the headers, 503 before the first byte when the stored file is deleted and when it is truncated, the uniform 404, and search pages.
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.5, DB6-R03.6, DB6-R03.7, DB6-R03.9, DB6-R03.19, DB6-R03.20, DB6-R04.10, NFR-08_

  - [ ] 8.37 Implement the Retention_Job
    - **ID**: T-6B-37
    - **Depends on**: T-6B-19, T-6B-14
    - **Affected modules**: `DATA/server/attachments/retention.js` (new), `DATA/tests/attachments-retention.test.js` (new)
    - **Acceptance criteria**:
      - `createRetentionJob({db, repository, storage, now, settings, logger})` exposes `runOnce()`, `start()` and `stop()`. `runOnce` works in bounded batches: (1) each pending row past `expires_at` is confirmed still pending and expired inside an immediate transaction and set to `deleted` with `deleted_at`, and after the commit its bytes are removed and `purge_state` is set to `purged`; (2) each `deleted` row with `purge_state='not_purged'` older than the purge delay has its bytes removed and is marked purged; (3) `AttachmentReservations` past `expires_at` are deleted. Ready attachments are never purged automatically. Each change writes an audit row with an empty actor.
      - `start()` chains `setTimeout` calls (not `setInterval`) at `ATTACHMENT_RETENTION_INTERVAL_SECONDS`, unreferenced, and reschedules in a `finally`. `stop()` clears the timer. A failure is caught per row, counted in the log and retried at the next run.
      - A start-up sweep removes `.part` files older than the pending TTL and logs only two counts: records without bytes and bytes without records. Final files without a record are counted, not deleted.
    - **Verify**: `node --test tests/attachments-retention.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R01.11, DB6-R03.13, DB6-R03.14, DB6-R03.15, DB6-R03.17, DB6-R03.22, DB6-R04.12, NFR-01_

  - [ ] 8.38 Wire the storage provider and the Retention_Job into `startServer`, with the upload timeout
    - **ID**: T-6B-38
    - **Depends on**: T-6B-37, T-6B-32, T-6B-22
    - **Affected modules**: `DATA/server/start.js`, `DATA/server.js`, `DATA/tests/attachments-retention.test.js`
    - **Acceptance criteria**:
      - `startServer` builds the filesystem provider from `ATTACHMENT_STORAGE_DIR` when the switch is on, passes it to `createApp`, starts the Retention_Job only while the Attachment_API is enabled and stops it in `close()`. With the switch off no job runs and no storage directory is created or listed. No other SQLite file is created, and the server stays one process on one port.
      - `ATTACHMENT_UPLOAD_TIMEOUT_SECONDS`, when set, raises `server.requestTimeout` only while the switch is on; unset keeps 15 s. A slow-upload test with an injected delay shows that the `.part` file and the reservation are removed when the timeout cuts the stream (R-08).
      - A child process of `server.js` with the switch on and a required setting missing exits with code 1, names the setting on stderr without a value and leaves the database file unmigrated.
      - `close()` stops the Retention_Job before the database closes: the chained timer is cleared and an in-flight batch finishes its current row (batches are bounded). A test calls `close()` during `runOnce()` and asserts that `close()` returns, that no timer remains and that no row is half changed. The stop sequence (Retention_Job, DATA application, database) must end well inside the 30 s stop grace period of the Docker_Environment, where `docker/run.cjs` forwards SIGTERM to the process group (F25); the test uses an injected clock and no real wait.
    - **Verify**: `node --test tests/attachments-retention.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.7, DB6-R02.8, DB6-R03.14, DB6-R03.15, ARCH-R01.1, ARCH-R01.2, ARCH-R01.10, COMP-10_

  - [ ] 8.39 Write property test P-38 for the Retention_Job
    - **ID**: T-6B-39
    - **Depends on**: T-6B-37, T-5B-10
    - **Property P-38: Retention marks exactly the expired pending attachments and is idempotent**
    - **Validates: Requirements DB6-R01.11, DB6-R03.13, DB6-R03.14, DB6-R03.15, DB6-R03.22, DB6-R04.12**
    - **Affected modules**: `DATA/tests/attachments-retention.test.js`
    - **Acceptance criteria**:
      - For 100 generated states of 0 to 20 rows (attachments of every status with `expires_at` around the injected clock, deleted rows with and without purged bytes, reservations before and after their expiry, `.part` files older and younger than the pending TTL, byte removal that fails for 0 to 3 rows) `runOnce` marks every expired pending attachment deleted with `deleted_at` set, bytes removed and `purge_state` purged, leaves unexpired pending rows alone, never changes a ready attachment, removes expired reservations, and a second `runOnce` at the same clock changes no row and no file. A row whose processing fails stays unprocessed, the others are still processed, and the next run processes it.
      - An example with fake timers shows that runs are chained and never overlap and that the timer is rescheduled after a failing run.
    - **Verify**: `node --test tests/attachments-retention.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.40 Add the `support/attachments-worker.cjs` process helper
    - **ID**: T-6B-40
    - **Depends on**: T-6B-36, T-5C-18
    - **Affected modules**: `DATA/tests/support/attachments-worker.cjs` (new; file name chosen here)
    - **Acceptance criteria**:
      - The worker is modelled on `groups-worker.cjs`. It refuses to start unless its isolation variable is set, `NODE_ENV=test` and both `DB_PATH` and the storage directory are temporary. It runs `startServer` with the `features` object read from one JSON environment variable and reads one stdin line per command `{method, path, headers, bodyFile, cookie, csrf}`; the body comes from a file in the temporary directory so that binary frames never pass through a text channel. It waits for the `barrier/go` file and prints `{status, body}` as one line.
      - A test-only command `hold-upload` starts an upload, reports that bytes are in flight and waits to be killed.
    - **Verify**: `node --test tests/attachments-quota.test.js` in DATA/ (the helper is exercised by T-6B-41)
    - **Agent**: Kiro
    - _Requirements: DB5-R15.5, DB5-R15.1, DB6-R04.4, NFR-07_

  - [ ] 8.41 Write property test P-34 for quotas under concurrent and failed uploads
    - **ID**: T-6B-41
    - **Depends on**: T-6B-40, T-6B-38, T-5B-10
    - **Property P-34: Quotas hold under concurrent uploads and a failed upload leaves nothing**
    - **Validates: Requirements DB6-R02.6, DB6-R02.10, DB6-R02.14, DB6-R03.1, DB6-R03.16, DB6-R04.2, DB6-R04.3, DB6-R04.4, DB6-R04.5, DB6-R04.6, DB6-R04.7, DB6-R04.12, DB6-R05.3, DB6-R05.12**
    - **Affected modules**: `DATA/tests/attachments-quota.test.js` (new)
    - **Acceptance criteria**:
      - For 20 batches of 4 to 12 uploads over 2 to 4 worker processes (quotas of 1 to 6 files of 1 to 200 KiB, streams cut at a random byte, malformed frames, oversize declarations, short or long streams, members removed during the run, injected storage or audit failures), the sum of `byte_size` of `pending` and `ready` rows plus the `declared_bytes` of live reservations never exceeds either quota at any observation point or at the end, and the pending count never exceeds its maximum. An upload over a limit answers 409 `QUOTA_EXCEEDED`, 413 or 429 as specified.
      - Every refused, aborted or failed upload leaves no `Attachments` row, no reservation after cleanup, no `.part` or final file and no counted usage: usage after the batch equals the usage computed from the committed rows. The seed and the batch index are printed for each batch.
    - **Verify**: `node --test tests/attachments-quota.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.42 Add the upload rate-limit tests
    - **ID**: T-6B-42
    - **Depends on**: T-6B-33
    - **Affected modules**: `DATA/tests/attachments-quota.test.js`
    - **Acceptance criteria**:
      - With limits set through the injected `features` object, the upload rate and the concurrent-upload limits per user and per source answer 429 `RATE_LIMITED` with `Retry-After` of at least 1 second before any content byte is read, and leave no reservation, row or file. The read, mutation and upload buckets of the injected limiter are separate.
      - A request that carries `X-Forwarded-For`, `Forwarded` or `X-Real-IP` headers with another address gets the same `source_digest`, the same concurrent-upload count and the same 429 decision as the request without them (OP-19). In the Docker_Environment every request has the source address 127.0.0.1, so the per-source limit is shared by all users of a project; this is documented and is not defended by trusting a header.
      - The tests use the injected clock and limiter and no real sleep.
    - **Verify**: `node --test tests/attachments-quota.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R04.6, DB5-R12.4, COMP-10, NFR-07_

  - [ ] 8.43 Write property test P-25 for the disabled Attachment_API
    - **ID**: T-6B-43
    - **Depends on**: T-6B-36, T-6B-38
    - **Property P-25: A disabled switch answers 503 and changes nothing (attachment clauses)**
    - **Validates: Requirements DB5-R15.8, DB5-R16.2, DB5-R16.4, DB5-R16.5, DB5-R16.12**
    - **Affected modules**: `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - For all 8 combinations of the three switches and every method and path of A01 to A06 (valid or invalid body, authenticated, valid CSRF proof) with the Attachment_API off, the answer is 503 `FEATURE_UNAVAILABLE`, and the snapshots of the attachment, reservation, audit and limiter tables and the listing of the storage directory are identical before and after. A request without a CSRF proof answers 403 before the switch is read.
      - After enabling the function, uploading, turning the switch off and restarting on the same files, the data, the `SchemaMigrations` ledger and the stored bytes are unchanged and the function answers 503 again (rollback of function, COMP-05).
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.44 Write property test P-26 for the attachment switch and storage root
    - **ID**: T-6B-44
    - **Depends on**: T-6B-22, T-6B-21
    - **Property P-26: Switch parsing, settings and feature-status (attachment clauses)**
    - **Validates: Requirements DB5-R16.1, DB5-R16.5, DB5-R16.7, DB5-R16.13, DB6-R02.2, DB6-R02.8**
    - **Affected modules**: `DATA/tests/groups-gate.test.js`
    - **Acceptance criteria**:
      - For any environment map from a pool of switch names, setting names and values (`true`, `TRUE`, `1`, empty, spaces, negative, fractional, huge), a switch is on exactly when its variable is the string `true`, and a switch that is on with a required attachment setting missing or invalid makes `loadFeatureConfig` throw `FeatureConfigError` that names exactly the offending settings and no value. A valid result is frozen.
      - For every switch assignment and every candidate storage root (relative, inside the working tree directly, through `..` or through a link, a file, missing, not writable, a valid external directory), `GET /api/groups/feature-status` answers 200 with exactly the three booleans, `attachmentApi` is true only for a writable directory whose real path is outside the working tree, and without a session the answer is 401.
    - **Verify**: `node --test tests/groups-gate.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.45 Write property test P-30 for attachment audit rows
    - **ID**: T-6B-45
    - **Depends on**: T-6B-36, T-6B-37, T-5C-40
    - **Property P-30: Audit rows carry only allowed keys and values (attachment operations)**
    - **Validates: Requirements DB5-R12.8, DB6-R03.7, DB6-R03.17, NFR-06**
    - **Affected modules**: `DATA/tests/audit-metadata.test.js`
    - **Acceptance criteria**:
      - For upload, association, download, deletion and Retention_Job runs with hostile text in metadata and canary values (spaces, quotes, newlines, path separators), each committed state-changing operation writes exactly one `AuditLogs` row in the same transaction with source `attachments`, the attachment identifier as subject, metadata keys within the allowed list, string values matching `^[a-zA-Z0-9_.:-]{1,64}$`, and an empty actor for the Retention_Job. A refused request writes no row except the missing-bytes download event.
      - No audit row, log line or stderr line contains a canary value, a file name or a path, and `audit.insert` still rejects any other key.
    - **Verify**: `node --test tests/audit-metadata.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.46 Write property test P-31 for attachment atomicity
    - **ID**: T-6B-46
    - **Depends on**: T-6B-36, T-6B-37, T-5C-41
    - **Property P-31: A failure at any write step leaves every table as before (attachment operations)**
    - **Validates: Requirements DB5-R12.9, DB5-R13.5, DB6-R03.16, NFR-01**
    - **Affected modules**: `DATA/tests/groups-atomicity.test.js`
    - **Acceptance criteria**:
      - For reserve, finalize, association, deletion and each Retention_Job transaction, and for each write step k including the audit insert, a failure forced at step k answers with the status of the error mapping (409, 400, 503, or 500 for an audit failure), forwards no database text, leaves every table equal to the snapshot taken before the operation and leaves no stored file or reservation that the operation created.
      - The error classes `DUPLICATE`, `CONFLICT`, `INVALID`, `BUSY` and `DATABASE` are injected in turn through the test-only seam of T-5C-41.
    - **Verify**: `node --test tests/groups-atomicity.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.47 Write property test P-19 with attachments in the populations
    - **ID**: T-6B-47
    - **Depends on**: T-6B-36, T-5B-31
    - **Property P-19: Direct conversations and messages are unchanged by groups and attachments**
    - **Validates: Requirements DB5-R02.8, DB5-R09.16, DB5-R15.4, ARCH-R02.2, ARCH-R02.3, ARCH-R02.4, COMP-06**
    - **Affected modules**: `DATA/tests/dm-fixtures-replay.test.js`
    - **Acceptance criteria**:
      - For 10 to 30 generated populations that now include attachments in every status and reservations, `GET /api/conversations` returns only direct conversations with two participants and the exact key set parsed by `client/src/security/e2ee/api.ts`, and the baseline fixtures of direct send, history, receipts, lifecycle and key-directory routes replay with the recorded status, fields and code.
      - An attachment identifier sent to a direct or group route and a conversation identifier sent to an attachment route answer 404 and change no row.
    - **Verify**: `node --test tests/dm-fixtures-replay.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 8.48 Write `attachments-openapi.json`, extend the contract checker and the conformance test
    - **ID**: T-6B-48
    - **Depends on**: T-6B-36, T-5C-46
    - **Affected modules**: `DATA/docs/attachments-openapi.json` (new), `DATA/tests/groups-openapi.test.js`, `DATA/tests/support/contract.js` (rows A01 to A06)
    - **Acceptance criteria**:
      - The set of (method, path) pairs is equal in three places: the document, the attachment routers' frozen route tables and their mounted layer stacks, with `/api/files` holding only `GET /search`. Each operation lists the status and code pairs of its contract row. Every example validates with `support/schema-check.js`, and all keys match `^[a-z][A-Za-z0-9]*$`. The existing OpenAPI documents change only by additions (COMP-02).
      - The `support/contract.js` self-check fails when an attachment route id has no row, when a row is missing from the router table or the document, and when a response carries a status and code pair that the row does not list.
    - **Verify**: `node --test tests/groups-openapi.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.6, DB5-R13.7, DB5-R13.9, DB5-R13.11, COMP-02, NFR-08_

  - [ ] 8.49 Add the attachment entries to `.env.example` and `gate-records.md`
    - **ID**: T-6B-49
    - **Depends on**: T-6B-21, T-5C-48
    - **Affected modules**: `DATA/.env.example` (names and safe defaults only; `DATA/.env` is never read or edited), `DATA/docs/gate-records.md`, `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - `.env.example` documents `ATTACHMENTS_API_ENABLED` (`false`), `ATTACHMENT_STORAGE_DIR` (commented, no value), the nine required settings and the optional upload timeout (commented, no value) and `ATTACHMENTS_API_GATE_RECORD`, each with a default that leaves the function disabled. Existing variables are unchanged (COMP-08).
      - `gate-records.md` lists the stages `ATTACHMENTS-PROTECTED` and `DB6-ACCEPTANCE` with no approved entry. `gate-records.test.js` still passes and fails when a committed environment file turns the attachment switch on without a record. The dependency lists of the three `package.json` files equal the baseline, so DB-6B adds no dependency (NFR-09).
      - The `.env.example` comments say that in the Docker_Environment `compose.yaml` already sets `ATTACHMENT_STORAGE_DIR=/var/lib/secubuzz/attachments` and sets no switch or attachment setting, and that per-source limits share one bucket there (OP-19). The Docker files scan of `gate-records.test.js` also fails on an attachment switch, on an attachment setting other than `ATTACHMENT_STORAGE_DIR`, or on `NEXT_PUBLIC_ATTACHMENT_API_READY: true` in `compose.yaml`, `docker/compose.env.example.yaml` or any Docker override file. In the Validation_Runner (`SECUBUZZ_DOCKER_VALIDATION` is `true`) it asserts that those files are absent from the image, and on a host it scans them (G8 runs the same scan at the repository root). No Docker file is edited.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.1, DB5-R16.8, DB6-R05.8, COMP-08, COMP-10, NFR-09_

  - [ ] 8.50 Update `schema.md`, `migrations.md` and `repositories.md` for 0009
    - **ID**: T-6B-50
    - **Depends on**: T-6B-03, T-6B-20
    - **Affected modules**: `DATA/docs/schema.md`, `DATA/docs/migrations.md`, `DATA/docs/repositories.md`, `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - `schema.md` and `migrations.md` list version 9, the file name `0009-attachment-lifecycle.sql`, every column, index, trigger and table it adds, and the rule that the database does not enforce the key format, the digest or the descriptors. `migrations.md` restates that a database migrated to 0009 cannot start under code without that migration, the cold-backup precondition (a host database: a cold copy of the database file with `-wal` and `-shm`, taken with every connection closed; the Docker_Environment: the cold backup of both complete volume roots) and the rollback (restore the cold backup into fresh volumes, or the pre-migration copy on a host; switch off for function, COMP-05). `repositories.md` gets additions only: the attachment repository functions.
      - For the Docker_Environment, `migrations.md` and the handoff section "Docker development environment" state for 0009: the first start of an image that contains 0009 migrates `sqlite-data` at once and permanently (older code then stops with `MIGRATION_HISTORY_MISMATCH`), and before that start against data to keep every writer is stopped and both complete volume roots, `sqlite-data` and `private-storage`, are archived together by the cold-backup procedure of `docs/docker-development.md` (cited, not copied), because rows and bytes are restored as a pair and a one-sided restore shows up as the two orphan counts of DB6-R03.14. They also state that Compose Watch is not used while a migration file is a draft, that the rehearsal runs in a Disposable_Project (T-6B-51) and that no backup helper exists (DK-06). `docs/docker-development.md` is not edited by this task (OP-18).
      - The documentation test in `groups-migrations.test.js` fails when an object created by 0009 or the file name is missing from `schema.md` or `migrations.md`, or when the one-way sentence is missing, or when the cold-backup sentence that names both volumes is missing.
    - **Verify**: `node --test tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R14.15, DB5-R14.16, DB5-R14.20, DB5-R14.22, DB5-R14.23, COMP-05, COMP-10_

  - [ ] 8.51 Rehearse migration 0009 on synthetic fixtures or an isolated cold-backup copy in a Disposable_Project
    - **ID**: T-6B-51
    - **Depends on**: T-6B-50, T-5B-35, T-5B-36, T-6B-17, T-6B-38
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (result note)
    - **Acceptance criteria**:
      - The rehearsal runs only in a Disposable_Project created for this task (name `secubuzz-disposable-` plus 8 lowercase hexadecimal characters, explicit `-p`, own volumes `<project>_sqlite-data` and `<project>_private-storage`, no published port through a temporary override file kept outside the repository, no repository file edited). The input is the synthetic version-7 data set of T-5B-35 (built under `os.tmpdir()` at run time, or committed `.json` or `.txt` fixtures) or an isolated copy of the Project_Owner's cold backup of both volumes, restored into the fresh volumes by the guide section "Restore into new volumes first" (with the image of the revision that took the backup for the restore check). The live database, `DATA/server/database/database.sqlite` and the volumes of the running project are never handed over, opened, mounted, archived or copied (DB5-R14.17, R14.21, R14.24). If no backup exists the synthetic fixtures are the input and the task still runs; nothing is skipped, and the note states which input was used.
      - The image built from the working tree (0008 and 0009 included) starts on those volumes (`up -d --wait --wait-timeout 180`) and applies the pending migrations on open. No Compose Watch runs while 0009 is a draft (DB5-R14.22). The project becomes healthy and `docker compose logs backend` shows no migration failure. `docker/database-check.cjs`, run as the guide's restore step runs it with the new image, reports `integrity_check` ok, an empty `foreign_key_check` and a ledger equal to the migration files. The row count of every pre-existing table and the values of every pre-existing `Attachments` column equal their state before the start, and migrated `Attachments` rows hold `purge_state` `not_purged` and NULL in every other new column. The rehearsal adds its own counts for `Attachments` and `AttachmentReservations` and a digest check of any stored file in `private-storage` against `integrity_digest`, without editing the helper (the helper does not look at that volume).
      - A throwaway script kept outside the repository and run inside the disposable backend container with `docker compose exec` builds the filesystem provider on `ATTACHMENT_STORAGE_DIR=/var/lib/secubuzz/attachments` with `/workspace` as the working tree. The start checks accept the path (COMP-10), a 1 MiB stream is written, read back and deleted with an equal SHA-256, the file mode is 0600 and the directory mode 0700 under UID 1000, and the hard-link probe result on the named volume is recorded for R-10 and CI-28. No switch is enabled by a repository file.
      - The time from `up` to healthy and the time of the 0009 migration on the input are recorded and compared with the backend start period of 40 s and its 6 health retries of 10 s (R-21). `docker compose -p <project> -f compose.yaml -f <override> down -v` runs once, only after the name matches `^secubuzz-disposable-[0-9a-f]{8}$` and the project was created for this task, and the override file and the script are removed. `-v` is never used on another project. The note shows the project name, the input used, the counts and the probe results. It also states the precondition for the Project_Owner, which this task does not perform: before the first start of code that contains 0009 against data to keep, the cold backup of both volumes is taken (DB5-R14.23).
    - **Verify**: the Disposable_Project commands of the design's Docker section (PowerShell): `docker compose -p $project -f compose.yaml -f $override config | Select-String 'published'` prints nothing; `docker compose -p $project -f compose.yaml -f $override up -d --wait --wait-timeout 180`; the database check against `${project}_sqlite-data`; `down -v` only inside `if ($project -match '^secubuzz-disposable-[0-9a-f]{8}$')`; G7
    - **Agent**: Kiro
    - _Requirements: DB5-R14.7, DB5-R14.13, DB5-R14.17, DB5-R14.20, DB5-R14.21, DB5-R14.22, DB5-R14.23, DB5-R14.24, COMP-03, COMP-10_

  - [ ] 8.52 Port standalone tests 1, 9 and 11 and the attachment steps of `db5_db6.test.cjs`
    - **ID**: T-6B-52
    - **Depends on**: T-6B-36, T-5C-51, T-6A-21
    - **Affected modules**: `DATA/tests/attachments-http.test.js`, `server/test/integration/attachments.test.ts` (read-only), `server/test/db5_db6.test.cjs` (read-only), `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - Test 1 (bytes persisted once, canonical metadata instead of flat rows), test 9 (a malformed frame header writes no row and no file), test 11 (group downloads follow active membership, so a removed uploader gets 404, AF-21 at HTTP level) and the attachment steps of `db5_db6.test.cjs` (upload, download, outsider 404) are reproduced against the canonical contract. Where a standalone test contradicts a requirement the test follows the requirement (a plaintext upload answers 400 until OD-16 permits it, ARCH-R03.11).
      - The inventory records for each ported test the canonical test that replaces it (ARCH-R03.10). The standalone files are untouched: G2 prints nothing.
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/; G2
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.4, ARCH-R03.10, ARCH-R03.11, DB5-R15.12, DB6-R03.8_

  - [ ] 8.53 Port standalone tests 2, 12 and 13 and record the remaining ports
    - **ID**: T-6B-53
    - **Depends on**: T-6B-16, T-6B-41, T-6B-39, T-6B-52
    - **Affected modules**: `DATA/tests/attachments-storage-contract.test.js`, `DATA/tests/attachments-quota.test.js`, `DATA/tests/attachments-retention.test.js`, `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - Test 2 (opaque bytes of images, video, Word, PDF, SVG, audio, spreadsheets and archives round-trip with equal SHA-256) is reproduced in the storage contract file, test 12 (size limits authoritative; failed transfers create no rows or files) in the quota and storage contract files, and test 13 (expiry, soft deletion and the cleanup job) in the retention file with `runOnce` and an injected clock, rows marked deleted and not removed.
      - The inventory records the replacement of each (ARCH-R03.10), marks test 8 retired, and records that tests 3 to 7 are ported in DB-6C (T-6C-04) and test 10 in DB-6D (T-6D-09). The standalone files are untouched.
    - **Verify**: `node --test tests/attachments-storage-contract.test.js tests/attachments-quota.test.js tests/attachments-retention.test.js` in DATA/; G2
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.4, ARCH-R03.10, DB5-R15.12, DB6-R04.1, DB6-R03.13_

  - [ ] 8.54 Phase gate DB-6B
    - **ID**: T-6B-54
    - **Depends on**: T-6B-01 to T-6B-53
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - C1 runs in the Validation_Runner (group `data`, the gate of record) and passes as defined in the Notes (at least 321 plus the new tests, 0 failed, 0 skipped, 0 cancelled, 0 todo). The same C1 on the Windows host is recorded beside it as additional evidence. G1, G2 and G9 exit 0, G3, G5a, G7 and G8 print nothing, and G5b prints only the seven DC-01 lines. The checksums of 0001 to 0007 are unchanged, 0008 is pinned, and the seven literals were amended in the same change set as 0009 with the guard passing. The image built for the run contains the draft 0009 and is never started against volumes that hold data to keep.
      - With the switch off every attachment route answers 503 `FEATURE_UNAVAILABLE` and every other path under `/api/files` answers 404. The package dependency lists equal the baseline, and no file under `client/` or `server/` was changed by this phase. `git diff --stat dc6c997 -- compose.yaml docker .dockerignore server/Dockerfile client/Dockerfile` prints nothing, so no Docker file changed and no new service, port or volume was needed (COMP-10; `docs/docker-development.md` changes only after the Project_Owner approved OP-18). G7 lists none of the new files of this phase.
      - The handoff records each run (command and runner group, passed, failed, skipped, date, `git rev-parse HEAD`, `git status --short`), the C1 run time and the run time of the new `attachments-*` files, the defaults applied (OD-16 plaintext refused, OP-04 15 s unless set, OP-08 reservation expiry), the hard-link probe results (host, runner, Docker volume), the result note of T-6B-51 (project name, input used, counts), the one-way warning for 0009 with the cold-backup sentence for both volumes, and the note that per-source upload limits share one bucket in the Docker_Environment (OP-19). The Known_Baseline_Failure list of T-5B-39 is unchanged (no client suite runs in this phase) and no entry is skipped, edited, excluded or silenced. The Disposable_Project of T-6B-51 is removed (`docker compose ls -a`), and no application container is started by the gate. No Gate_Record applies to DB-6B, and the Attachment_API stays off.
    - **Verify**: C1 in the Validation_Runner (group `data`) and on the Windows host; G1; G2; G3; G5a; G5b; G7; G8; G9; `git diff --stat dc6c997 -- compose.yaml docker .dockerignore server/Dockerfile client/Dockerfile`; `docker compose ls -a`
    - **Agent**: Kiro
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R16.4, ARCH-R02.1, ARCH-R03.5, COMP-01, COMP-10, NFR-09_

- [ ] 9. DB-6C: independent security review of protected attachments and the ATTACHMENTS-PROTECTED record
  **Entry criteria.** DB-6B exit met (T-6B-54). OP-10 is answered again for this phase (T-6C-01): the reviewer is named before the review starts. OD-16, OD-17 and OD-21, with OP-02, are decided at the review (T-6C-08, T-6C-09) and none is selected here; OD-18 and OD-20 keep their defaults until recorded (T-6A-15, T-6A-16). OA-01 and OA-02 were decided at DB-6A; OA-03 (DB-6E) and OA-04 (DB-5F and DB-6F) come later. OD-14 and OD-15 are recorded (T-6A-11, T-6A-12) before the Gate_Record can be approved (DB5-R16.7). This phase adds no feature and designs no cryptography: the Attachment_Service never decrypts, parses, previews, scans or indexes content (DB6-R05.1), and the review only reviews and records. The Attachment_API stays off for Real_Accounts until the `ATTACHMENTS-PROTECTED` record exists. DB-6D runs beside this phase and changes authorization, so its changes get a review addendum (T-6D-19) that the record cites before approval.
  **Docker (COMP-10).** The gate of record is the Validation_Runner, with the Windows host as additional evidence. The storage boundary under review includes the Docker volume facts: the reserved `private-storage` volume at `/var/lib/secubuzz/attachments` (mode 0700, UID 1000, never served, not seeded from the repository) and a frontend container that mounts no data volume. No application container is started by this phase and no Docker file is edited.

  - [ ] 9.1 Name the independent security reviewer for DB-6C (OP-10)
    - **ID**: T-6C-01
    - **Depends on**: T-6B-54
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The log names the reviewer, who did not write the code under review (the DB-5D reviewer of T-5D-01 may be named again), and the report form the Project_Owner accepts (findings with severity, and each finding fixed or accepted in writing).
      - Without this entry no ATTACHMENTS-PROTECTED record can exist, and the Attachment_API stays off for Real_Accounts.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R05.8, DB5-R16.8_

  - [ ] 9.2 Add `attachments-protected.test.js` for the protected-content declaration
    - **ID**: T-6C-02
    - **Depends on**: T-6B-54
    - **Affected modules**: `DATA/tests/attachments-protected.test.js` (new)
    - **Acceptance criteria**:
      - An upload without `algorithm`, `formatVersion` or `encryptedMetadata`, with a descriptor that is empty or longer than 64 characters, or with metadata longer than 16384 characters, answers 400 VALIDATION_ERROR with the field names in `fields`. No row, file or reservation is created, and the answer comes before any content byte is read (the test counts the bytes the server consumed).
      - Whatever media type the request or the content suggests (a PNG signature, a JSON body), `media_type` is stored as `application/octet-stream`. The descriptors are stored in `declared_algorithm` and `declared_format_version`, and a canary file name sent inside the metadata appears in no other column, audit row, log line or response header. A plaintext-looking upload without a declaration is refused with 400 and stores nothing (the OD-16 default). The tests are named `AF-15: ...` and `AF-18: ...`.
    - **Verify**: `node --test tests/attachments-protected.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R05.3, DB6-R05.4, DB6-R05.5, DB6-R05.12, DB6-R04.12_

  - [ ] 9.3 Add the opaque-content and no-key checks
    - **ID**: T-6C-03
    - **Depends on**: T-6C-02
    - **Affected modules**: `DATA/tests/attachments-protected.test.js`
    - **Acceptance criteria**:
      - A canary byte pattern and a canary metadata string appear in no audit row, log line, stderr line or error body, and a download equals the upload byte for byte with `Content-Type` `application/octet-stream`, so nothing parses, previews or transforms the content.
      - A static scan of `DATA/server/attachments` fails when it imports a cryptographic module for anything other than `createHash('sha256')` and `randomBytes`, when a function takes a key or passphrase parameter, when it imports an image, archive, MIME-sniffing or parsing package, or when SQL applies `LIKE` or `GLOB` to `encrypted_metadata`. The dependency lists of the three `package.json` files equal the baseline.
    - **Verify**: `node --test tests/attachments-protected.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R05.1, DB6-R05.2, DB6-R05.11, NFR-06, NFR-09_

  - [ ] 9.4 Port the standalone tests 3 to 7 and the file-name step of `db5_db6.test.cjs`
    - **ID**: T-6C-04
    - **Depends on**: T-6C-02
    - **Affected modules**: `DATA/tests/attachments-protected.test.js`, `server/test/integration/attachments.test.ts` (read-only), `server/test/db5_db6.test.cjs` (read-only), `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - The five file names of tests 3 to 7 (spaces, percent signs, accents, emoji, CJK) travel inside `encryptedMetadata`, round-trip byte for byte through upload and the metadata read, and appear in no other column. A search with a name or content filter answers 400. The step of `db5_db6.test.cjs` that checks the file name is not persisted is reproduced the same way.
      - The standalone header transport and the unmarked legacy percent-encoded names are not reproduced (test 8 is retired). The inventory records the replacement of each ported test (ARCH-R03.10). The standalone files are untouched: G2 prints nothing.
    - **Verify**: `node --test tests/attachments-protected.test.js` in DATA/; G2
    - **Agent**: Kiro
    - _Requirements: DB6-R05.4, DB6-R03.11, ARCH-R03.4, ARCH-R03.10, ARCH-R03.11_

  - [ ] 9.5 Prepare the review package
    - **ID**: T-6C-05
    - **Depends on**: T-6C-03, T-6C-04, T-6C-01, T-6A-08
    - **Affected modules**: `DATA/docs/db6c-review-package.md` (new; file name chosen here)
    - **Acceptance criteria**:
      - The package lists the scope and, for each item, the evidence: the upload path (frame, header before bytes, size rule, reservation), storage (key, path safety, root, modes, no static route, the hard-link results of the host, the Validation_Runner and the Docker volume, and the Docker volume facts: the reserved `private-storage` volume path, mode 0700, UID 1000, never served, no data volume in the frontend container), the protected-content declaration and its tests, the opaque-content and no-key scans, audit and log hygiene (P-30), the Attachment_API gate and the client flag rule. Evidence names the test files and the C1 counts of the Validation_Runner run.
      - It lists the open questions for the reviewer and the Project_Owner (OD-16, OD-17, OD-21, whether padding is required, the server-wide scope of a raised `requestTimeout`) and the risks R-02, R-07, R-08, R-10 and R-12. It states that DB-6D changes authorization after this package and that an addendum (T-6D-19) covers those changes.
    - **Verify**: review against the design's Protected-content gate and Risks sections
    - **Agent**: Kiro
    - _Requirements: DB6-R05.6, DB6-R05.8, DB5-R16.8_

  - [ ] 9.6 Independent security review of protected attachments
    - **ID**: T-6C-06
    - **Depends on**: T-6C-05, T-6C-01
    - **Affected modules**: `DATA/docs/db6c-security-review.md` (new; the reviewer's report, file name chosen here)
    - **Acceptance criteria**:
      - The reviewer, who did not write the code, reviews the scope of the package: the upload path, the storage boundary, the protected-content declaration, the claim that the server never decrypts, parses, previews, scans or indexes content and holds no key, log and error hygiene, the gate and the client flag rule, and the open questions. The review designs and changes no cryptography; it only reviews and records.
      - The report lists each finding with severity and a verdict, in the form named in T-6C-01.
    - **Verify**: Project_Owner accepts the report (no command applies); `node --test` in DATA/ still passes
    - **Agent**: Independent security reviewer
    - _Requirements: DB6-R05.1, DB6-R05.2, DB6-R05.6, DB6-R05.8, DB5-R16.8_

  - [ ] 9.7 Fix or formally accept each review finding
    - **ID**: T-6C-07
    - **Depends on**: T-6C-06
    - **Affected modules**: `DATA/docs/db6c-security-review.md`, `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - Every finding is fixed (the change and the test that covers it are named in the report) or accepted in writing by the Project_Owner, and the report shows the final status of each. Code fixes belong to the module named in the finding and keep C1 green.
      - Accepted findings are copied into the known gaps of the handoff.
    - **Verify**: `node --test` in DATA/; Project_Owner reviews the final report
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8, DB6-R05.8_

  - [ ] 9.8 Record the Project_Owner decisions on plaintext and search scope at the review (OD-16, OD-17)
    - **ID**: T-6C-08
    - **Depends on**: T-6C-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry makes OD-16 final: plaintext attachments stay refused, with no allowlist and no scanning, or another policy that opens a new specification (this plan builds neither an allowlist nor a first-512-bytes check). It confirms the DC-04 scope of a raised request timeout (server-wide while the switch is on).
      - It makes OD-17 final: the filters conversation, uploader, size range and time range, with no media type class.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R05.3, DB6-R05.7, DB6-R03.10_

  - [ ] 9.9 Record the Project_Owner decision on the association form (OD-21, OP-02)
    - **ID**: T-6C-09
    - **Depends on**: T-6C-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry makes OD-21 final: association by the explicit request A02 stays, or association inside the message is chosen. The second choice changes the message write and its fingerprint and touches the byte-identical direct path (ARCH-R02.3), so it opens a new specification with its own regression gate (CI-35). This plan builds A02 only.
      - It confirms the whole-message reading of the 5-file and 100 MB limits (OP-02).
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R01.9, DB6-R01.4, DB6-R04.11_

  - [ ] 9.10 Record the Project_Owner acceptance of the residual risk (R-02, DB6-R05.6)
    - **ID**: T-6C-10
    - **Depends on**: T-6C-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry accepts in writing that the server cannot verify that uploaded bytes are ciphertext, names the controls that remain, and states the decision on padding (a padding scheme is a cryptographic or protocol design and is outside this plan).
      - It records which of R-07, R-08, R-10 and R-12 stay open as known gaps.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R05.6, DB6-R05.8_

  - [ ] 9.11 Replace the draft residual-risk statement with the accepted wording
    - **ID**: T-6C-11
    - **Depends on**: T-6C-07, T-6C-08, T-6C-09, T-6C-10
    - **Affected modules**: `DATA/docs/attachments-protected-content.md`, `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The "Residual risk" section carries the status ACCEPTED with the date, the wording agreed in T-6C-10 and the final OD-16 and OD-21 outcomes. Findings accepted at the review are listed in the handoff known gaps.
      - `gate-records.test.js` fails when the section still carries the status DRAFT while an `ATTACHMENTS-PROTECTED` entry exists, and still passes otherwise.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R05.6, DB6-R05.1_

  - [ ] 9.12 Draft the ATTACHMENTS-PROTECTED Gate_Record
    - **ID**: T-6C-12
    - **Depends on**: T-6C-11, T-6A-11, T-6A-12
    - **Affected modules**: `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - The entry `GR-ATTACHMENTS-PROTECTED-<date>` cites the review report and the acceptance of the residual risk, the OD-14 and OD-15 values, the OD-16, OD-17 and OD-21 outcomes, the C1 counts of the Validation_Runner run (the Windows host run as additional evidence), the need for a valid `ATTACHMENT_STORAGE_DIR` (in the Docker_Environment the reserved volume path `/var/lib/secubuzz/attachments`) and the state of OA-02 (OP-03) and OA-01 (OP-05). It lists the DB-6D addendum (T-6D-19) as evidence still to be added. The approval line is left empty for the Project_Owner.
      - `gate-records.test.js` still passes, which shows that no committed environment file turns the attachment switch on.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8, DB5-R16.7, DB6-R05.8_

  - [ ] 9.13 Phase gate DB-6C
    - **ID**: T-6C-13
    - **Depends on**: T-6C-01 to T-6C-12
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - C1 runs in the Validation_Runner (group `data`, the gate of record) and passes as defined in the Notes. The same C1 on the Windows host is recorded beside it as additional evidence. G1, G2 and G9 exit 0, G3, G5a, G7 and G8 print nothing, and G5b prints only the seven DC-01 lines. The residual-risk statement exists (document check) and the review report is delivered, with each finding fixed or accepted in writing.
      - The handoff records each run (command and runner group, passed, failed, skipped, date, `git rev-parse HEAD`, `git status --short`). The Known_Baseline_Failure list of T-5B-39 is unchanged (no client suite runs in this phase) and no entry is skipped, edited, excluded or silenced. `GR-ATTACHMENTS-PROTECTED-<date>` carries the Project_Owner's approval. This task stays unchecked until it does. The Attachment_API stays off for Real_Accounts and `NEXT_PUBLIC_ATTACHMENT_API_READY` stays false until then (G8 prints nothing).
      - No application container is started by the gate and no Docker file is edited.
    - **Verify**: C1 in the Validation_Runner (group `data`) and on the Windows host; G1; G2; G3; G5a; G5b; G7; G8; G9
    - **Agent**: Kiro, with the Independent security reviewer and the Project_Owner approving the Gate_Record
    - _Requirements: DB5-R15.10, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R16.8, DB6-R05.8, DB6-R05.9, ARCH-R02.1, COMP-01, COMP-10_

- [ ] 10. DB-6D: authorization, search and lifecycle hardening and integration with groups
  **Entry criteria.** DB-6B exit met (T-6B-54) and DB-5C exit met (T-5C-52). The design lists the DB-5D exit as an entry criterion. This plan names the DB-5D code task that DB-6D needs (T-5D-05, the group tombstone) instead of the DB-5D gate T-5D-31, because that gate waits for the GROUP-MESSAGING record, which stays open while OD-19 is open (OP-16). Group messages in the tests are stored through the repositories. OD-17 and OD-18 are recorded (T-6A-14, T-6A-15) or run on their defaults, OD-21 stays as decided at T-6C-09, and OP-02 (whole-message limits) applies. OP-12 is recorded in the first task (T-6D-01); the amendment OA-04 (CI-11, OP-12) that would change DB5-R16 criteria 8 and 11 and DB6-R05.8 waits for the Project_Owner at DB-5F (the marker) and DB-6F (the records), and no default is selected here. OD-14, OD-15, OD-20 and the other open items keep their gates (T-6A-11, T-6A-12, T-6A-16, T-5G-02). This phase adds the permitted-range check, the direct-pair rule on reads, the archived-group rules, the tombstone and removed-uploader tests, the actor-class matrix and the properties P-35 to P-37. It adds no cryptography, no client change and no switch. Every route still answers 503 while the switch is off.
  **Docker (COMP-10).** The gate of record is the Validation_Runner, with the Windows host as additional evidence and the Known_Baseline_Failure entries listed separately. No application container is started and no Docker file is edited. The restart tests (T-6D-17) close and reopen the application on temporary files and never touch the volumes of a running project.

  - [ ] 10.1 Record the Project_Owner decision on the records needed to enable attachments (OP-12)
    - **ID**: T-6D-01
    - **Depends on**: T-6B-54
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The requirements name only ATTACHMENTS-PROTECTED for the Attachment_API, and no Gate_Record stage covers DB-6D or DB-6E. The entry confirms the default (both `ATTACHMENTS-PROTECTED` and `DB6-ACCEPTANCE` are required before the Attachment_API switch and `NEXT_PUBLIC_ATTACHMENT_API_READY` are on for Real_Accounts) or names another set.
      - The entry states that no stage record is created for DB-6D and DB-6E and that their evidence is the phase gates T-6D-21 and T-6E-15.
      - The entry is the OP-12 decision behind amendment OA-04 (CI-11, OP-12). The text of DB5-R16 criteria 8 and 11 and of DB6-R05.8 stays unchanged in `requirements.md` until the Project_Owner approves the amendment: the marker part at DB-5F (T-5F-01) and the part that names the records at DB-6F (T-6F-09). No default is selected by this task.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB6-R05.8, DB5-R16.8_

  - [ ] 10.2 Enforce and prove the removed-member and departed-member rule on every attachment route
    - **ID**: T-6D-02
    - **Depends on**: T-6B-54, T-5C-52
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - Every service function (upload, association, metadata, download, deletion, search) runs the membership check before it reads any attachment state. A removed or departed member, the uploader of the attachment included, gets the uniform 404 on A01 to A05 and an empty page on A06. The 404 equals the answer for an unknown identifier in status, body and headers apart from `Date`.
      - The regression `AF-21: a removed uploader loses access to the group attachments, including own uploads` runs the design scenario: U uploads F, sends M and associates F; O downloads F; O removes U (a second run: U leaves); U requests A03, A04, A05 and A06; the remaining members still download F with equal bytes and digest, and no stored file or row changes.
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.3, DB6-R03.8, DB6-R03.19, DB5-R05.8_

  - [ ] 10.3 Add the permitted-range check to ready metadata, download and search
    - **ID**: T-6D-03
    - **Depends on**: T-6D-02
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/server/database/groupRepository.js` (one read function, only if `getPermittedMessage` cannot be reused; group SQL stays in this file), `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - For a group conversation, A03, A04 and A06 return a ready attachment only when the sequence of its message lies inside the permitted ranges of the requester (`permittedRanges(intervals, policy)` and `inRanges`), decided in the same read transaction. Under `from_joined` a member never sees an attachment of a message sent before joining or during a gap while removed. Under `all` earlier messages are included, and the gap never is. A direct conversation has no ranges.
      - Search applies the predicate inside the query, not after paging, so a page holds the requested size while that many permitted attachments remain. Tests cover a rejoin (the AF-14 scenario applied to attachments), both policies, an empty interval and an open interval.
    - **Verify**: `node --test tests/attachments-http.test.js tests/groups-repository.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.4, DB6-R03.5, DB6-R03.9, DB5-R08.8, DB5-R08.13, DB5-R08.14_

  - [ ] 10.4 Apply the direct-pair rule on attachment reads
    - **ID**: T-6D-04
    - **Depends on**: T-6D-03
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - In a direct conversation, A03, A04 and A06 answer for a participant who is blocked in either direction and for a participant who is not a friend with the same status and code as the existing direct message-history read gives for the same actor and state; the test reads that answer first, in the same test. A05 and A02 follow the same pair rule as A01.
      - A01 asserts the DC-02 literals (404 for a block, 403 for a pair that is not friends) or the rule recorded in T-6A-10, and stores nothing on a denial. The direct path is not edited.
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.2, DB6-R03.4, DB5-R15.9_

  - [ ] 10.5 Apply the archived-group rules to attachments
    - **ID**: T-6D-05
    - **Depends on**: T-6D-04
    - **Affected modules**: `DATA/server/attachments/service.js`, `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - In an archived group A03, A04 and A06 answer as before, A01 and A02 answer 409 CONFLICT (unless an earlier check of the documented order refuses them), A05 follows the rule written in `attachments-api.md` (default: allowed for the uploader), and leaving the group behaves as in an unarchived group. No attachment row is removed and the Retention_Job never purges a ready attachment of an archived group.
      - Tests cover each route in an archived group and show that no stored file or row is created or removed by a refusal.
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.18, DB5-R07.1, DB5-R07.2_

  - [ ] 10.6 Add the tombstone and uploader-membership-end tests (OD-18)
    - **ID**: T-6D-06
    - **Depends on**: T-6D-05, T-5D-05
    - **Affected modules**: `DATA/tests/attachments-http.test.js`
    - **Acceptance criteria**:
      - A ready attachment stays available to the remaining members after its message is tombstoned (G21, through the `remove` of `messaging/group.js`), after its uploader leaves or is removed, and after the group is archived. A removed member gets 404, and the Retention_Job never purges a ready row.
      - The still-active uploader of an attachment of a tombstoned message may delete it, and no other member may.
    - **Verify**: `node --test tests/attachments-http.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.18, DB6-R03.8, DB6-R03.12, DB6-R03.13_

  - [ ] 10.7 Add the search filter matrix and the query-plan case
    - **ID**: T-6D-07
    - **Depends on**: T-6D-03
    - **Affected modules**: `DATA/tests/attachments-http.test.js`, `DATA/tests/groups-migrations.test.js`
    - **Acceptance criteria**:
      - Each permitted filter works alone and combined. Each refused filter (file name, content, media type class, unknown parameter) answers 400 naming the parameter. A byte range or time range with minimum above maximum, a limit of 0, 51 or non-integer, and an altered or foreign cursor answer 400. Results are newest first.
      - `EXPLAIN QUERY PLAN` of the search statement, with the permitted-range predicate, uses `idx_attachments_search` and does not scan `Attachments`, `Messages` or `ConversationMembers` in full (case (h), NFR-03).
    - **Verify**: `node --test tests/attachments-http.test.js tests/groups-migrations.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R03.9, DB6-R03.10, DB6-R03.11, DB6-R03.20, NFR-03_

  - [ ] 10.8 Write property test P-37 for association and the attachment lifecycle
    - **ID**: T-6D-08
    - **Depends on**: T-6D-05, T-5B-10
    - **Property P-37: Association is all or nothing and the lifecycle only moves forward**
    - **Validates: Requirements DB6-R01.3, DB6-R01.4, DB6-R01.5, DB6-R01.6, DB6-R01.11, DB6-R03.12, DB6-R03.18, DB6-R04.11**
    - **Affected modules**: `DATA/tests/attachments-association.test.js` (new)
    - **Acceptance criteria**:
      - For any association request naming k attachments (k from 0 to 8; sizes with totals around 104,857,600 bytes set by direct row edit; states pending, expired, ready and deleted; another uploader; another conversation; a message committed or not), the request succeeds exactly when 1 <= k <= 5, the total `byte_size` of the message's attachments (those already associated included) is at most 104,857,600, every attachment is pending, unexpired, in the conversation, uploaded by the requester and not yet associated, and the message is committed and sent by the requester. On success all become `ready` with the `message_id`. On any failure no attachment changes, the valid ones included, and the answer is 400, 404 or 409 as DB6-R01.5 and DB6-R04.11 say.
      - Across sequences of 20 to 50 operations (upload, association, delete, Retention_Job runs, clock jumps around expiry) no message has more than 5 attachments or more than 104,857,600 bytes, status only moves pending to ready, pending to deleted and ready to deleted, `deleted_at` is set exactly for deleted rows, `uploaded_by`, `conversation_id`, `storage_key` and `byte_size` never change, and direct SQL that breaks a rule is rejected by `attachments_lifecycle` or `attachments_immutable`. The test fails if the service checks only the request (OP-02).
    - **Verify**: `node --test tests/attachments-association.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.9 Add the group actor-class matrix over A01 to A06 and port standalone test 10
    - **ID**: T-6D-09
    - **Depends on**: T-6D-06, T-6D-07, T-6B-48, T-5C-21
    - **Affected modules**: `DATA/tests/attachments-security.test.js` (new), `DATA/tests/support/contract.js`, `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - The matrix runs A01 to A06 in a group conversation as each actor class (unauthenticated, non-member, pending invitee, member, admin, owner, removed member including the removed uploader), with the expectations of the design's attachment variant table, and one extra cell per route without a CSRF proof (403 `CSRF_INVALID`). Each denied cell runs with a valid and an invalid body, so 404 and 403 precede 400. Each cell asserts status, `code`, `fields`, the security headers, and that the table hashes and the storage listing are unchanged, except the audit row of a download refused with 503 for missing bytes.
      - Standalone test 10 (outsiders, invalid sessions and unauthorised groups without trusting identity headers) is ported: requests with spoofed identity headers or a body field naming another uploader are ignored and answer exactly as without them. The inventory records the replacement (ARCH-R03.10). The test `AF-17` asserts the DC-02 literals for a direct upload to a blocked or non-friend peer.
    - **Verify**: `node --test tests/attachments-security.test.js` in DATA/; G2
    - **Agent**: Kiro
    - _Requirements: DB5-R15.2, DB5-R15.9, DB6-R03.3, DB6-R03.8, DB6-R03.19, DB6-R03.21, ARCH-R03.4, ARCH-R03.10, NFR-08_

  - [ ] 10.10 Add the direct-conversation variant of the matrix with blocked participants
    - **ID**: T-6D-10
    - **Depends on**: T-6D-09
    - **Affected modules**: `DATA/tests/attachments-security.test.js`
    - **Acceptance criteria**:
      - For a friend participant, a participant blocked by the other, a participant who blocked the other, a former friend and a non-participant, A01 to A06 answer as T-6D-04 defines, and the A01 outcome equals the status of the existing direct send route for the same actor and state, read first in the same test. A denial stores nothing and changes no row or file.
      - The expectations for a block and for a pair that is not friends are the DC-02 literals until T-6A-10 records another rule, and the test names the literal it asserts.
    - **Verify**: `node --test tests/attachments-security.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R15.9, DB6-R03.2, DB6-R03.19_

  - [ ] 10.11 Write property test P-36 for attachment authorization
    - **ID**: T-6D-11
    - **Depends on**: T-6D-10, T-5B-10
    - **Property P-36: Attachment access equals the oracle for every requester class**
    - **Validates: Requirements DB5-R05.8, DB5-R08.8, DB5-R08.13, DB5-R15.9, DB6-R01.7, DB6-R01.8, DB6-R03.2, DB6-R03.3, DB6-R03.4, DB6-R03.5, DB6-R03.8, DB6-R03.9, DB6-R03.10, DB6-R03.11, DB6-R03.19, DB6-R03.20**
    - **Affected modules**: `DATA/tests/attachments-security.test.js`
    - **Acceptance criteria**:
      - For 100 generated conversations (direct or group; 1 to 4 members with 0 to 3 intervals each; policy and archive state generated; 0 to 12 attachments in the states ready, pending and deleted associated to messages at various sequences) and any requester class (uploader, Active_Member, member whose message lies outside the permitted ranges, removed member including the uploader, non-member, blocked direct participant, direct participant who is not a friend, unauthenticated), metadata and download answer 200 exactly when the oracle says so (a ready attachment, the requester an Active_Member, the message sequence inside the permitted ranges; or a pending attachment and the requester its uploader, metadata only).
      - Every other case, unknown identifiers included, answers the identical 404 with no attachment byte, no attachment header and no row change, except the DC-02 outcomes of a direct pair. File search returns exactly the ready attachments of conversations where the requester is an Active_Member and that lie inside the permitted ranges, newest first, honours only the permitted filters and answers 400 to a name or content filter or to a range whose minimum exceeds its maximum. The oracle uses the `policy.js` ranges and the membership state.
    - **Verify**: `node --test tests/attachments-security.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.12 Write property test P-21 over A01 to A06
    - **ID**: T-6D-12
    - **Depends on**: T-6D-09, T-5B-10
    - **Property P-21: A refused request leaves every record and stored file unchanged (attachment routes)**
    - **Validates: Requirements DB5-R13.10, DB5-R15.2, DB5-R15.9, DB6-R03.7**
    - **Affected modules**: `DATA/tests/attachments-security.test.js`
    - **Acceptance criteria**:
      - For any request to A01 to A06 answered with status 400 or higher, from any actor class and with any fault (bad frame, bad body, bad query, bad cursor, wrong content type, stale state, archived group, missing bytes), the snapshot of the 12 tables of P-21 and the storage directory listing are identical before and after.
      - The only allowed differences are the limiter counters in `AuthRateLimits` and the audit row of a download refused with 503 because bytes are missing.
    - **Verify**: `node --test tests/attachments-security.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.13 Write property test P-22 over A01 to A06
    - **ID**: T-6D-13
    - **Depends on**: T-6D-12
    - **Property P-22: Attachment errors have one shape and a uniform 404 (attachment routes)**
    - **Validates: Requirements DB5-R13.1, DB5-R13.2, DB5-R13.3, DB5-R13.11, DB6-R02.7, DB6-R03.16, DB6-R03.19, NFR-06, NFR-08**
    - **Affected modules**: `DATA/tests/attachments-security.test.js`
    - **Acceptance criteria**:
      - For any failing request to A01 to A06 the body is exactly `{code, fields}`, with `fields` non-empty only for 400 and holding only names that match `^[a-zA-Z][a-zA-Z0-9]{0,63}$`, and the status and code pair is in the documented list of the route. No client-supplied malformed input answers 500. No response, stderr line or audit row contains a stack trace, SQL text, a constraint or trigger name, an absolute path, the storage root or a canary value placed in the request.
      - For every denial cause of the uniform 404 (unknown or malformed identifier, other conversation, removed or departed member, pending attachment of another user, deleted attachment, message outside the permitted ranges) the status, body, header names and header values (except `Date`) are identical.
    - **Verify**: `node --test tests/attachments-security.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.14 Extend property test P-14 to the file-search cursors
    - **ID**: T-6D-14
    - **Depends on**: T-6D-07, T-5C-34, T-5B-10
    - **Property P-14: Altered cursors and bad parameters are refused (file search)**
    - **Validates: Requirements DB5-R02.6, DB5-R02.7, DB6-R03.20**
    - **Affected modules**: `DATA/tests/groups-pagination.test.js`
    - **Acceptance criteria**:
      - For any valid cursor issued to user A for A06 and a filter set F, any alteration (flip, insert, delete or replace a character, truncate, append, change case, replace by random base64url, exceed 2048 characters, use characters outside base64url) and any presentation to another user or filter set answers 400 VALIDATION_ERROR with `cursor` in `fields`, returns no item, never answers 500 and changes no row.
      - Any unknown query parameter and any `limit` outside 1 to 50 answers 400 with the parameter name in `fields`.
    - **Verify**: `node --test tests/groups-pagination.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.15 Extend property test P-15 to the file-search listing
    - **ID**: T-6D-15
    - **Depends on**: T-6D-14, T-5C-35
    - **Property P-15: Listings are complete, ordered and disjoint (file search)**
    - **Validates: Requirements DB5-R02.5, DB6-R03.9**
    - **Affected modules**: `DATA/tests/groups-pagination.test.js`
    - **Acceptance criteria**:
      - For 0 to 150 ready attachments across several conversations, page sizes 1 to 50 drawn per request, and a requester with generated intervals, the pages concatenate to the oracle's sorted sequence (newest first by `created_at` and `attachment_id`, restricted to the permitted ranges), without a duplicate or a skipped element, and the last page has no cursor.
      - Every page except the last holds exactly `limit` items while that many permitted attachments remain, and an attachment stored between two page requests is handled as the documented cursor rule says.
    - **Verify**: `node --test tests/groups-pagination.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.16 Extend property test P-24 with attachment writes in archived groups
    - **ID**: T-6D-16
    - **Depends on**: T-6D-05, T-5C-28
    - **Property P-24: Archived groups refuse writes and keep every row (attachment clauses)**
    - **Validates: Requirements DB5-R05.9, DB5-R07.1, DB5-R07.2, DB6-R03.18**
    - **Affected modules**: `DATA/tests/groups-random.test.js`
    - **Acceptance criteria**:
      - In the operation sequences of P-01 with uploads, associations and deletions added to the weighted draw, every attachment upload and association after the archive commit answers 409 CONFLICT unless an earlier check of the documented order refuses it, reads of attachment metadata and permitted downloads answer as before, and the row count of `Attachments` never decreases for the group.
      - The seed and the sequence index are printed for each sequence (DB5-R15.6).
    - **Verify**: `node --test tests/groups-random.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.17 Write property test P-35 and the restart sequence in `attachments-restart.test.js`
    - **ID**: T-6D-17
    - **Depends on**: T-6D-06, T-6B-40
    - **Property P-35: Upload, association, search and download give the same results after a restart**
    - **Validates: Requirements DB6-R01.8, DB6-R02.13, DB6-R03.5, DB6-R03.6, DB6-R03.7, DB6-R04.8, DB6-R04.9, DB6-R05.1, DB6-R05.4, DB6-R05.5, NFR-08**
    - **Affected modules**: `DATA/tests/attachments-restart.test.js` (new), `DATA/tests/support/attachments-worker.cjs`
    - **Acceptance criteria**:
      - For 20 to 50 cases of the sequence upload, association with a message, metadata search, authorized download, stop, start, search, download, with generated content (0 bytes to a few MiB of arbitrary bytes, including text-like content), metadata of up to 16384 characters and descriptors of 1 to 64 characters, the download is byte-identical to the upload, its SHA-256 equals the `integrity_digest` and an independent computation, the headers are `application/octet-stream`, `attachment`, `nosniff` and `no-store`, and metadata, search results and bytes are equal before and after the restart. "Stop" closes the application, its HTTP server and its database connection; "start" calls `openDatabase({filename})` and a new `startServer` on the same storage directory and clock source, and applies zero migrations.
      - No file name, content pattern or metadata text appears in any column other than `encrypted_metadata`, in an audit row or in a log. When the stored file is deleted or its length changes, the download answers 503 before any attachment byte. A worker killed with `SIGKILL` during an upload leaves no `Attachments` row, and the usage after the reservation has expired equals the usage computed from the committed rows.
    - **Verify**: `node --test tests/attachments-restart.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.18 Update the attachment contract documents for the hardened rules
    - **ID**: T-6D-18
    - **Depends on**: T-6D-13, T-6B-48
    - **Affected modules**: `DATA/docs/attachments-api.md`, `DATA/docs/attachments-openapi.json`
    - **Acceptance criteria**:
      - Both documents state, for A01 to A06, the outcome per actor class and per conversation kind, the permitted-range rule, the removed-member rule, the archived-group outcomes, the tombstone rule, the direct pair rule with the DC-02 literals (or the outcome of T-6A-10), the search filters and refusals, and the OD-17 and OD-18 defaults.
      - `groups-openapi.test.js` passes with the three-way route comparison, and every example validates.
    - **Verify**: `node --test tests/groups-openapi.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.6, DB5-R13.7, DB6-R03.4, DB6-R03.8, DB6-R03.18_

  - [ ] 10.19 Obtain the review addendum for the DB-6D authorization changes
    - **ID**: T-6D-19
    - **Depends on**: T-6D-18, T-6D-11, T-6C-12
    - **Affected modules**: `DATA/docs/db6c-security-review.md` (addendum), `DATA/docs/gate-records.md` (evidence line of the `ATTACHMENTS-PROTECTED` entry)
    - **Acceptance criteria**:
      - The Independent security reviewer reads the DB-6D changes (membership check ahead of attachment state, permitted ranges, direct pair rule on reads, archived-group rules, search filters) and the P-36 matrix results, and records for each whether it changes a conclusion of the DB-6C report. Any finding is fixed or accepted in writing as in T-6C-07. The addendum designs no cryptography.
      - Kiro adds the addendum to the evidence list of `GR-ATTACHMENTS-PROTECTED-<date>` before the Project_Owner approves it.
    - **Verify**: Project_Owner reviews the addendum (no command applies); `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Independent security reviewer, with Kiro recording the evidence line
    - _Requirements: DB5-R16.8, DB6-R05.8, DB6-R03.4, DB6-R03.8_

  - [ ] 10.20 Write property test P-20 for the order of refusals on the attachment routes
    - **ID**: T-6D-20
    - **Depends on**: T-6D-09, T-5C-23, T-5B-10
    - **Property P-20: The first failing check decides the answer (attachment routes)**
    - **Validates: Requirements ARCH-R01.5, DB5-R12.1, DB5-R12.2, DB5-R12.3, DB5-R12.10, DB5-R12.11, DB5-R12.12, DB5-R12.14, DB5-R13.2, DB5-R13.4, DB5-R16.4, DB6-R03.21**
    - **Affected modules**: `DATA/tests/groups-model.test.js`
    - **Acceptance criteria**:
      - For any combination of failing conditions of one request to A01 to A06 the response is that of the first failing check of the documented order: Origin, session, CSRF, switch, rate limit, `Content-Length`, content type, JSON syntax (for A01 the frame header, before any content byte), body shape and field validation. The order is the one of the Request-level failures table of Error Handling, and it holds also when `AUTH_MIDDLEWARE_MODULE` is set.
      - Per case a subset of 1 to 5 failing conditions is drawn and the state and request are built to violate exactly that subset. The oracle is an ordered list of (condition, status, code) per route, transcribed from the contract document and not from the router. At least 100 cases per route run, the seed is printed, and every refusal changes no row and no stored file.
    - **Verify**: `node --test tests/groups-model.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 10.21 Phase gate DB-6D
    - **ID**: T-6D-21
    - **Depends on**: T-6D-01 to T-6D-20
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - C1 runs in the Validation_Runner (group `data`, the gate of record) and passes as defined in the Notes. The same C1 on the Windows host is recorded beside it as additional evidence. G1, G2 and G9 exit 0, G3, G5a, G7 and G8 print nothing, and G5b prints only the seven DC-01 lines. The association, metadata, download, search, actor-class matrix and attachment restart tests pass inside C1, and the search query plan uses `idx_attachments_search`.
      - The handoff records each run (command and runner group, passed, failed, skipped, date, `git rev-parse HEAD`, `git status --short`) and the run times of the `attachments-*` files. The Known_Baseline_Failure list of T-5B-39 is unchanged (no client suite runs in this phase) and no entry is skipped, edited, excluded or silenced. OP-12 is recorded (T-6D-01) and the review addendum is delivered. No Gate_Record applies to DB-6D, and the Attachment_API stays off.
      - No application container is started by the gate and no Docker file is edited. The restart tests ran on temporary files, not on the volumes of a running project.
    - **Verify**: C1 in the Validation_Runner (group `data`) and on the Windows host; G1; G2; G3; G5a; G5b; G7; G8; G9
    - **Agent**: Kiro
    - _Requirements: DB5-R15.9, DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.14, DB5-R15.15, ARCH-R02.1, ARCH-R03.5, COMP-01, COMP-10, NFR-03_

- [ ] 11. DB-6E: protected upload client and attachment rewrites (Codex only)
  **Entry criteria.** DB-6C and DB-6D exits met (T-6C-13, T-6D-21), so `attachments-api.md`, `attachments-upload-frame.md`, `attachments-protected-content.md` and `attachments-openapi.json` are merged and the ATTACHMENTS-PROTECTED record exists. DB-5F exit met (T-5F-12; the design marks this edge PROPOSED, because feature-status handling and group views come from DB-5F). The frame is confirmed (T-6A-05). The Project_Owner records two acknowledgements before the code they cover changes: the OP-13 exception for the 76 client attachment tests (T-6E-01) and the CI-11 change of the rewrite expectation for `/api/attachments` and `/api/files` (T-6E-02). Codex derives files and components from the contract documents; this plan fixes behavior and gating only. No server change. No cryptographic design: the client consumes the existing protected-content format as it is (DB6-R05.11). `NEXT_PUBLIC_ATTACHMENT_API_READY` stays false in every committed file until the ATTACHMENTS-PROTECTED record is approved and the Project_Owner enables it. No plaintext fallback. The 76 tests change only in this phase, in place, with a stricter replacement for each changed assertion.
  **Decisions and their gates.** OA-03 (CI-10, OP-13) is decided at this phase by T-6E-01: until the Project_Owner acknowledges it, the 76 client attachment tests stay frozen (ARCH-R03.9, G4 exits 0). OA-04 (CI-11, OP-12): the marker part is acknowledged by T-6E-02 and the part that names the records enabling the Attachment_API stays with DB-6F. OA-02 (OP-03, the frame) was decided at DB-6A (T-6A-05), and OD-16, OD-17, OD-21 with OP-02 at DB-6C (T-6C-08, T-6C-09). No default is selected here.
  **Docker (COMP-10).** Every recorded client test run of this phase (T-6E-03, T-6E-15, T-6F-03) is a run of the Validation_Runner group `client` (C4 and C5, with `npm run lint` and `npm run build:verify`), the gate of record, with the Windows host run as additional evidence; the two Known_Baseline_Failure entries (T-5B-39) are listed separately by test name and platform and are never suppressed. A host `npm test` is quick feedback only. `client/authProxy.cjs` and `client/next.config.js` are copied into the frontend image and are not mounted, so a change to either needs `docker compose up --build` before any manual verification in the stack. `NEXT_PUBLIC_*` values come only from `compose.yaml`, which this phase does not edit: `NEXT_PUBLIC_ATTACHMENT_API_READY` is `false` there, a manual uploader test sets it to `true` only in a temporary override file kept outside the repository, followed by recreation of the frontend container and only in a project with no real account data, and any change of the committed value goes through `compose.yaml` only with the Project_Owner's approval (G8). No server file and no Docker file changes.

  - [ ] 11.1 Record the Project_Owner acknowledgement of the DB5-R15.11 exception for the 76 client tests (OP-13)
    - **ID**: T-6E-01
    - **Depends on**: T-6C-13, T-6D-21, T-5F-12
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry is the acknowledgement of amendment OA-03 (CI-10, OP-13); until it exists the 76 client attachment tests stay frozen (ARCH-R03.9) and G4 exits 0. It states the tension. DB5-R15.11 forbids deleting, skipping or weakening an existing test, and a comparison with the baseline must show no removed or relaxed assertion. The 76 client attachment tests assert the plaintext flat-row contract that DB6-R05 retires, and ARCH-R03.9 forbids any change to them before DB-6E.
      - It acknowledges that from this entry on the 8 test files may change in place under these conditions only: no test is deleted, renamed, skipped or marked todo; every changed assertion has a stricter replacement recorded in the inventory (DB5-R15.12); the test count of each file does not fall; G3 and G5a stay clean and G5b lists only the seven DC-01 lines and the recorded client assertions. It carries the date and the Project_Owner's name. Without it none of the 76 tests changes.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB5-R15.11, DB5-R15.12, ARCH-R03.9, DB6-R05.10_

  - [ ] 11.2 Record the Project_Owner acknowledgement of the CI-11 expectation change for the attachment prefixes
    - **ID**: T-6E-02
    - **Depends on**: T-6C-13, T-6D-21, T-5F-12
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry is the acknowledgement of the marker part of amendment OA-04 (CI-11, OP-12); the part that names the records enabling the Attachment_API stays with DB-6F (T-6F-09). It acknowledges that the `gate-records.test.js` expectation "no `/api/attachments` or `/api/files` rewrite in the client" changes for these two prefixes only, in the DB-6E change set, as T-5F-01 announced.
      - It states that the expectation for any other prefix and the rule that no committed environment file turns a switch on stay unchanged.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: DB5-R16.11_

  - [ ] 11.3 Read the contract documents and the client attachment code, run the 8 files, and plan the changes
    - **ID**: T-6E-03
    - **Depends on**: T-6E-01, T-6A-05
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (planned-files note); the client files are read only
    - **Acceptance criteria**:
      - Codex reads `attachments-api.md`, `attachments-upload-frame.md`, `attachments-protected-content.md`, `attachments-openapi.json`, the client uploader files (`db6Attachments.ts`, `attachmentUpload.ts`, `attachmentFiles.ts`, `attachmentContent.ts`, `localAttachmentStore.ts`, `useAttachmentSource.ts`), the components and hooks that the 8 test files render (CI-25) and the client protected-content helpers they call. It runs the 8 test files in the Validation_Runner group `client` and records the 76 passing tests with per-file counts.
      - The handoff note records the new file paths and component names Codex chooses, each tied to a route or rule of the contract, and for each test file the assertions that encode the plaintext flat-row contract (the list that T-6E-13 completes). It states what the client will not do: no key handling beyond the existing helpers, no plaintext fallback, no rewrite beyond the two prefixes.
    - **Verify**: Validation_Runner group `client` (C4, C5) on the unchanged tree, with the Windows host run as additional evidence; `npm test` and `npm run type-check` in client/ give quick feedback (no file changed)
    - **Agent**: Codex
    - _Requirements: ARCH-R03.9, DB6-R05.10, DB6-R05.13, DB5-R15.12, COMP-06_

  - [ ] 11.4 Add the `/api/attachments` and `/api/files` rewrites and update the guard expectation
    - **ID**: T-6E-04
    - **Depends on**: T-6E-02, T-6E-03, T-5C-48
    - **Affected modules**: `client/authProxy.cjs`, `client/next.config.js`, `DATA/tests/gate-records.test.js` (one expectation, the `/api/attachments` and `/api/files` prefixes only)
    - **Acceptance criteria**:
      - Both client files rewrite `/api/attachments` and `/api/files` and their sub-paths to the DATA application in the same style as the existing auth, social, messaging and `/api/groups` rewrites. No other rewrite changes.
      - `gate-records.test.js` now expects exactly the rewrites for `/api/groups`, `/api/attachments` and `/api/files`, still fails for any other new rewrite, and still fails when a committed environment file turns a switch on. A client test asserts the same facts and that `NEXT_PUBLIC_ATTACHMENT_API_READY` is not `true` in any committed client environment file.
      - Both files are baked into the frontend image and are not mounted, so before any manual verification in the stack the image is rebuilt (`docker compose up --build`, in a Disposable_Project or a project with no real account data); a running container never sees the change otherwise. `compose.yaml` and the Dockerfiles are not edited (COMP-10).
    - **Verify**: `npm test` in client/; `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Codex
    - _Requirements: DB5-R16.11, DB6-R05.9, COMP-10_

  - [ ] 11.5 Gate the attachment controls on the client flag and the feature-status response
    - **ID**: T-6E-05
    - **Depends on**: T-6E-04, T-5F-04
    - **Affected modules**: the feature-status module of T-5F-04 (path chosen by Codex), `YahooChatWindow.tsx` and `SecureConversationPanel.tsx` (the readiness expression only), new client test files (names chosen by Codex)
    - **Acceptance criteria**:
      - An attachment control renders for a Real_Account only while `NEXT_PUBLIC_ATTACHMENT_API_READY` equals the exact string `true` and the feature-status response matches the documented shape with `attachmentApi` true. With the flag unset or false, or the response missing, failed, malformed or reporting `attachmentApi` false, no attachment control renders and no `POST /api/attachments` is sent.
      - Tests cover unset, `false`, `TRUE`, a failed fetch, a malformed response and each combination of the three booleans. The committed default stays false.
      - `NEXT_PUBLIC_ATTACHMENT_API_READY` is `false` in every committed file, `compose.yaml` and `docker/compose.env.example.yaml` included (G8 prints nothing). Any change of the committed value goes through `compose.yaml` only with the Project_Owner's approval. A manual test sets it to `true` only in a temporary override file kept outside the repository, followed by recreation of the frontend container, in a project with no real account data (the value comes only from `compose.yaml`; host environment files are not injected).
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB6-R05.8, DB6-R05.9, COMP-06, COMP-10_

  - [ ] 11.6 Add the upload frame encoder
    - **ID**: T-6E-06
    - **Depends on**: T-6E-03, T-6A-05
    - **Affected modules**: new client module for the frame (path chosen by Codex), new client test file
    - **Acceptance criteria**:
      - The encoder builds the body of A01 as `attachments-upload-frame.md` defines it (length prefix, JSON header with `conversationId`, `byteSize`, `encryptedMetadata`, `algorithm` and `formatVersion`, then the bytes) and streams the content without holding more than 1,048,576 bytes of it in memory.
      - Tests compare the output with the byte-exact hex vectors of the document (the vectors that `attachments-validation.test.js` checks on the server side) and refuse a header over the cap or a byte count that differs from `byteSize`.
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB6-R03.1, DB6-R05.12, DB6-R04.10_

  - [ ] 11.7 Measure a 50 MiB framed upload through the client proxy (CI-27, R-07)
    - **ID**: T-6E-07
    - **Depends on**: T-6E-04, T-6E-06, T-6A-19, T-6A-24
    - **Affected modules**: new client test file or script (name chosen by Codex), `DATA/docs/db5-db6-handoff.md` (result note)
    - **Acceptance criteria**:
      - An automated test streams one generated 50 MiB framed body through the rewrite path configured in `client/authProxy.cjs` and `client/next.config.js` to a loopback sink on port 0, compares byte count and SHA-256 at the sink, and records peak memory and the proxy timeout settings in the handoff. It uses no network beyond loopback. If it runs longer than the jest timeout it is a separate `npm` script, run once and recorded, and is never marked skipped.
      - If the body is truncated, buffered beyond a bound or cut by a timeout, Codex and the Project_Owner choose another route for uploads, the decision is recorded in the handoff, its implementation is outside this plan, and the client flag stays false.
      - The in-stack measurement of T-6A-24 is repeated with the same method and thresholds in a new Disposable_Project built from the working tree, now through the real `/api/attachments` rewrite (the image is rebuilt, because the proxy files are baked into the frontend image), and the two results are compared in the handoff. The Disposable_Project is removed afterwards (`down -v` only after the name matches the prefix).
    - **Verify**: `npm test` in client/ (or the named script); the Disposable_Project commands of the design's Docker section for the in-stack repeat
    - **Agent**: Codex
    - _Requirements: DB6-R04.10, DB6-R05.9, COMP-10, NFR-05_

  - [ ] 11.8 Adapt the transport and the uploader to the protected contract
    - **ID**: T-6E-08
    - **Depends on**: T-6E-06, T-6E-05, T-6E-01
    - **Affected modules**: `client/src/messaging/db6Attachments.ts`, `client/src/messaging/attachmentUpload.ts`, `client/src/messaging/__tests__/attachmentUpload.test.ts`
    - **Acceptance criteria**:
      - The uploader sends one framed `POST /api/attachments` per file with ciphertext bytes, the encrypted metadata and the declaration `{algorithm, formatVersion}` taken from the existing protected-content format, with the CSRF handling the client already uses. After the message is committed it calls A02 with the attachment identifiers. It reads the canonical projection (a nested `attachment`, camelCase, `integrityDigest`, descriptors) instead of the flat snake_case rows.
      - It no longer sends the plaintext bytes, the file name or the original media type outside the encrypted metadata, and no percent-encoded name header. Assertions of `attachmentUpload.test.ts` that encode the retired contract change in place, each with a stricter replacement for T-6E-13. No test is deleted, renamed, skipped or marked todo.
    - **Verify**: `npm test` and `npm run type-check` in client/; G3; G5a
    - **Agent**: Codex
    - _Requirements: DB6-R05.10, DB6-R03.1, DB6-R01.4, ARCH-R03.9, DB5-R15.12_

  - [ ] 11.9 Adapt the file, content and local-store modules
    - **ID**: T-6E-09
    - **Depends on**: T-6E-08
    - **Affected modules**: `client/src/messaging/attachmentFiles.ts`, `client/src/messaging/attachmentContent.ts`, `client/src/messaging/localAttachmentStore.ts`, `client/src/messaging/__tests__/attachmentFiles.test.ts`, `client/src/messaging/__tests__/attachmentContent.test.ts`, `client/src/messaging/__tests__/localAttachmentStore.test.ts`
    - **Acceptance criteria**:
      - The modules produce ciphertext and encrypted metadata with the existing helpers for upload, read the canonical download bytes (A04) and decrypt them with the existing helpers, and key the local store by the canonical attachment identifier. File name and original media type exist in memory only after decryption and are never sent outside the encrypted metadata.
      - Changed assertions are replaced in place by stricter ones recorded for T-6E-13. No test is deleted, renamed, skipped or marked todo, and the count per file does not fall.
    - **Verify**: `npm test` and `npm run type-check` in client/; G3; G5a
    - **Agent**: Codex
    - _Requirements: DB6-R05.10, DB6-R05.4, ARCH-R03.9, DB5-R15.12_

  - [ ] 11.10 Adapt the attachment source hook
    - **ID**: T-6E-10
    - **Depends on**: T-6E-09
    - **Affected modules**: `client/src/hooks/useAttachmentSource.ts`, `client/src/hooks/__tests__/useAttachmentSource.test.tsx`
    - **Acceptance criteria**:
      - The hook reads metadata (A03) and bytes (A04) through the canonical projection and the gates of T-6E-05, issues no request while the flag is false or the status says `attachmentApi` false, and maps a 404 and a 503 to distinct states (not found, service unavailable) without exposing a cause.
      - Changed assertions are replaced in place by stricter ones recorded for T-6E-13. No test is deleted, renamed, skipped or marked todo.
    - **Verify**: `npm test` and `npm run type-check` in client/; G3; G5a
    - **Agent**: Codex
    - _Requirements: DB6-R05.9, DB6-R05.10, ARCH-R03.9, DB5-R15.12_

  - [ ] 11.11 Adapt the attachment components and their tests
    - **ID**: T-6E-11
    - **Depends on**: T-6E-10
    - **Affected modules**: the attachment components that the tests render (existing files, minimal edits), `client/src/components/YahooChatWindow.attachments.test.tsx`, `client/src/components/messenger/__tests__/MessageAttachmentView.test.tsx`, `client/src/components/messenger/__tests__/MessageComposer.attachments.test.tsx`
    - **Acceptance criteria**:
      - The composer attaches files through the adapted uploader and shows each file's state (preparing, uploading, failed, ready). The attachment view renders from the canonical projection and the decrypted metadata only. The chat window keeps the text-only path while the gates of T-6E-05 are off.
      - Changed assertions are replaced in place by stricter ones recorded for T-6E-13. No test is deleted, renamed, skipped or marked todo, and the count per file does not fall.
    - **Verify**: `npm test` and `npm run type-check` in client/; G3; G5a
    - **Agent**: Codex
    - _Requirements: DB6-R05.9, DB6-R05.10, ARCH-R03.9, DB5-R15.12_

  - [ ] 11.12 Add the no-plaintext-fallback rule and the upload failure state
    - **ID**: T-6E-12
    - **Depends on**: T-6E-11
    - **Affected modules**: the composer and uploader files of T-6E-08 and T-6E-11, new client test files (names chosen by Codex)
    - **Acceptance criteria**:
      - When the existing helpers cannot produce ciphertext and encrypted metadata for a file (a thrown error, missing key material or an unsupported file), the client sends no upload request for that file, never sends its plaintext bytes, and shows an upload failure state for that file while the message flow stays usable. Tests use an encrypt double that fails and a request spy that sees zero requests.
      - A canary file name and a canary media type appear nowhere outside the encrypted metadata in any request body, URL or header. The client adds no cryptographic code and no key handling.
    - **Verify**: `npm test` and `npm run type-check` in client/
    - **Agent**: Codex
    - _Requirements: DB6-R05.10, DB6-R05.13, DB6-R05.9_

  - [ ] 11.13 Record each changed client assertion and its stricter replacement in the inventory
    - **ID**: T-6E-13
    - **Depends on**: T-6E-12
    - **Affected modules**: `DATA/docs/standalone-inventory.md`, `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - For each of the 8 client test files the inventory lists every changed assertion (the old text, the new text, why the old one encoded the retired plaintext contract and the stricter assertion that replaces it) and the test count before and after, which does not fall. It states that G4 no longer applies from T-6E-01.
      - A document check in `gate-records.test.js` fails when one of the 8 files has no section, when a section lacks a before and after count, or when a changed assertion has no replacement entry.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Codex
    - _Requirements: DB5-R15.11, DB5-R15.12, ARCH-R03.9, ARCH-R03.10_

  - [ ] 11.14 Add the client guard tests for the disabled state and the unchanged contracts
    - **ID**: T-6E-14
    - **Depends on**: T-6E-12, T-6E-04
    - **Affected modules**: new client test files (names chosen by Codex)
    - **Acceptance criteria**:
      - With the client flag unset or false, or the status response malformed, a render of the messenger shows no attachment control and the request spy sees no `POST /api/attachments`. The strict direct parser still rejects a group in a conversation list and accepts only the direct shape.
      - G8 prints nothing, so `compose.yaml` and `docker/compose.env.example.yaml` keep `NEXT_PUBLIC_ATTACHMENT_API_READY` false and no Docker file sets a switch or an attachment setting.
      - `client/src/security/e2ee/api.ts` is unchanged: `git diff --exit-code d7cd40a -- client/src/security/e2ee/api.ts` exits 0. The rewrites present are exactly `/api/groups`, `/api/attachments` and `/api/files` besides the baseline ones.
    - **Verify**: `npm test` and `npm run type-check` in client/; `git diff --exit-code d7cd40a -- client/src/security/e2ee/api.ts`
    - **Agent**: Codex
    - _Requirements: DB6-R05.9, COMP-06, DB5-R16.11, DB5-R16.14, COMP-10_

  - [ ] 11.15 Phase gate DB-6E
    - **ID**: T-6E-15
    - **Depends on**: T-6E-01 to T-6E-14
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - C4, C5 and C1 run in the Validation_Runner (groups `client` and `data`, the gate of record). C4 shows 0 failed and 0 skipped with at least the baseline count of T-5B-02, the 8 attachment files still run with counts not below those of T-6E-03, and C5, the lint and `build:verify` steps and C1 pass. The same commands run on the Windows host as additional evidence: C4 fails exactly the two Known_Baseline_Failure entries (T-5B-39, platform Windows) and nothing else. Those entries are listed separately by test name and platform and are never skipped, edited, excluded or silenced.
      - G2 and G9 exit 0, G3, G5a, G7 and G8 print nothing, and G5b lists only the seven DC-01 lines and the client assertions recorded in the inventory, each with its replacement. G4 no longer applies.
      - The rewrites are `/api/groups`, `/api/attachments` and `/api/files` only. `NEXT_PUBLIC_ATTACHMENT_API_READY` is false in every committed file (`compose.yaml` included; G8 prints nothing), the flag false sends no `POST /api/attachments`, and no plaintext fallback exists. No file under `DATA/server` or `server/` and no Docker file changed in this phase. Because `client/authProxy.cjs` and `client/next.config.js` are baked into the frontend image, the handoff notes that a manual check of the rewrites needs an image rebuild.
      - The handoff records each run (command and runner group, passed, failed, skipped, date, `git rev-parse HEAD`, `git status --short`) and the proxy measurement result of T-6E-07 beside the result of T-6A-24. No stage Gate_Record applies to DB-6E (T-6D-01). No application container is started by the gate.
    - **Verify**: C4; C5; C1 in the Validation_Runner (groups `client` and `data`) and on the Windows host; G2; G3; G5a; G5b; G7; G8; G9
    - **Agent**: Codex
    - _Requirements: DB5-R15.10, DB5-R15.12, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB6-R05.9, DB6-R05.10, DB6-R05.13, ARCH-R03.9, COMP-06, COMP-10_

- [ ] 12. DB-6F: final acceptance of DB-6
  **Entry criteria.** DB-6E exit met (T-6E-15) and the ATTACHMENTS-PROTECTED record exists (T-6C-13). OP-12 is recorded (T-6D-01). OD-20 is recorded (T-6A-16, T-5G-02) before the inventory is final. OD-14 and OD-15 values are recorded (T-6A-11, T-6A-12) before DB6-ACCEPTANCE can be approved, because the acceptance names the settings under which the function may be switched on. The design's gate row assumes the DB5-ACCEPTANCE record exists; this plan does not need it for DB-6F work, but DB-7 does. This phase adds no feature, enables no switch and changes no Standalone_Implementation file (G2 stays empty). The deprecation markers of ARCH-R03.6 are written in DB-7 (T-7-05), once both acceptance records exist. Nothing of the standalone code is deleted in this or any later phase of this plan.
  **Decisions and their gates.** Not selected here and kept visible: OD-14 and OD-15 (before DB6-ACCEPTANCE can be approved), OD-20 (before the inventory is final), OP-12 with the OA-04 approval of the records that enable the Attachment_API (DB-6F, T-6F-09), and the open parts of OD-01, OD-02, OD-03, OD-06, OD-07, OD-08, OD-09 to OD-13, OD-16 to OD-19 and OD-21, which stay known gaps with their defaults. OA-01 and OA-02 were recorded at DB-6A and OA-03 at DB-6E.
  **Docker (COMP-10).** The gate of record is the Validation_Runner: C1 in the group `data`, C2 and C3 in the group `server`, C4 and C5 in the group `client`. The Windows host results are recorded beside them as additional evidence, and the two Known_Baseline_Failure entries (T-5B-39) are listed separately by test name and platform and are never skipped, edited, excluded or silenced. No application container is started by a gate run, no Docker file is edited, and the volumes of a running project are never opened.

  - [ ] 12.1 Run the attachment restart availability sequence through `startServer`
    - **ID**: T-6F-01
    - **Depends on**: T-6E-15, T-6D-21, T-6B-38
    - **Affected modules**: `DATA/tests/attachments-restart.test.js`
    - **Acceptance criteria**:
      - The scenario of DB6-R04.9 (upload, association with a message, metadata search, authorized download, restart, search, download) runs on an isolated temporary database and storage directory through `startServer` with the Retention_Job, and metadata, search results and bytes (SHA-256 equal to the recorded `integrity_digest`) are equal before and after the restart.
      - A pending attachment that expires while the application is stopped is marked deleted, with its bytes removed, by the first Retention_Job run after the start, and ready attachments are untouched. After the switch is turned off and the application restarted, every attachment route answers 503, and after it is turned on again the same rows and bytes are served (DB5-R16.12, COMP-05).
    - **Verify**: `node --test tests/attachments-restart.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB6-R04.8, DB6-R04.9, DB5-R15.7, DB5-R16.12, COMP-05_

  - [ ] 12.2 Run the full DATA and server regression
    - **ID**: T-6F-02
    - **Depends on**: T-6F-01, T-6D-21
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (results note)
    - **Acceptance criteria**:
      - C1, C2 and C3 run in the Validation_Runner (groups `data` and `server`, the gate of record) on the current tree, and the same commands run on the Windows host as additional evidence. C1 passes with 0 failed, 0 skipped, 0 cancelled and 0 todo. C3 shows 0 failed and 0 skipped with at least the baseline count of T-5B-01. The seven `server/test/data` files and both standalone server tests pass unchanged (G6, G2).
      - G1, G3, G5a and G5b give their passing results, G7 and G8 print nothing and G9 exits 0. Each run is noted with command and runner group, counts, date, `git rev-parse HEAD` and `git status --short`, with the Windows host results beside the runner results.
    - **Verify**: C1; C2; C3 (Validation_Runner groups `data` and `server`, Windows host as additional evidence); G1; G2; G3; G5a; G5b; G6; G7; G8; G9
    - **Agent**: Kiro
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.15, ARCH-R02.1, COMP-01_

  - [ ] 12.3 Run the client regression
    - **ID**: T-6F-03
    - **Depends on**: T-6E-15
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (results note)
    - **Acceptance criteria**:
      - C4 and C5 run in the Validation_Runner group `client` (with `npm run lint` and `npm run build:verify`, the gate of record) on the current tree. C4 shows 0 failed and 0 skipped with at least the baseline count of T-5B-02, the 8 attachment files run with the counts of T-6E-13, the strict direct parser is unchanged and the flag is false in every committed file.
      - The same C4 and C5 run on the Windows host as additional evidence: C4 fails exactly the two Known_Baseline_Failure entries of T-5B-39 (by test name, platform Windows) and nothing else, and the Linux pass of the two tests is noted. The entries are listed separately and are never skipped, edited, excluded or silenced (DB5-R15.14, DB5-R15.15), and G9 exits 0. Each run is noted with command and runner group, counts, date, `git rev-parse HEAD` and `git status --short`.
    - **Verify**: C4; C5 (Validation_Runner group `client`, Windows host as additional evidence); G9
    - **Agent**: Codex
    - _Requirements: DB5-R15.13, DB5-R15.14, DB5-R15.15, DB6-R05.9, ARCH-R03.9, COMP-06_

  - [ ] 12.4 Replay the direct-message fixtures in every gate state with groups and attachments present
    - **ID**: T-6F-04
    - **Depends on**: T-6E-15, T-6B-47, T-6D-21
    - **Property P-19: Direct conversations and messages are unchanged by groups and attachments (all gate states)**
    - **Validates: Requirements DB5-R02.8, DB5-R09.16, DB5-R15.4, ARCH-R02.2, ARCH-R02.3, ARCH-R02.4, COMP-06**
    - **Affected modules**: `DATA/tests/dm-fixtures-replay.test.js`
    - **Acceptance criteria**:
      - The baseline fixtures of direct send, history, receipts, lifecycle and key-directory routes replay with the recorded status, fields and code in all 8 combinations of the three switches, with groups, Invitations, group messages, attachments in every status and reservations present.
      - `GET /api/conversations` keeps the exact shape the client parses, group and attachment identifiers sent to direct routes and direct identifiers sent to group and attachment routes answer 404, and no row changes.
    - **Verify**: `node --test tests/dm-fixtures-replay.test.js` in DATA/
    - **Agent**: Kiro

  - [ ] 12.5 Finalise the attachment contract documents
    - **ID**: T-6F-05
    - **Depends on**: T-6F-02
    - **Affected modules**: `DATA/docs/attachments-api.md`, `DATA/docs/attachments-openapi.json`, `DATA/docs/attachments-upload-frame.md`, `DATA/docs/attachments-storage-contract.md`, `DATA/docs/attachments-protected-content.md`
    - **Acceptance criteria**:
      - The documents match the merged code for A01 to A06: request and response schemas, minimum role, status and code lists, additional codes, settings and defaults (by name, no values), the frame vectors and the storage contract. Every example validates and the three-way route comparison passes.
      - The decisions tables show the recorded outcomes of OD-14 to OD-21, OP-02, OP-03, OP-04, OP-05, OP-08 and OP-12 and of the four amendments OA-01 to OA-04 (approved, or still awaiting approval with the requirement text they would change), and list every open item as a known gap with its default and its gate.
    - **Verify**: `node --test tests/groups-openapi.test.js tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.6, DB5-R13.7, DB5-R13.8, DB5-R13.11, DB6-R05.6_

  - [ ] 12.6 Check requirements coverage for DB-6
    - **ID**: T-6F-06
    - **Depends on**: T-6F-05
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (coverage section), `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The coverage section maps every criterion of DB6-R01 to DB6-R05, ARCH-R01 to ARCH-R03 (DB-6 scope), NFR-01 to NFR-09 and COMP-01 to COMP-09 to a passing test (file and test name or property id) or to a document, using the design's property matrix and Testing Strategy section 2. A criterion with no covering test is listed as a known gap.
      - `gate-records.test.js` fails when a DB6-R identifier, or an ARCH-R, NFR or COMP identifier of DB-6 scope, is absent from the coverage section.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R15.1, DB5-R15.11, DB5-R15.13_

  - [ ] 12.7 Complete the standalone inventory for DB-6
    - **ID**: T-6F-07
    - **Depends on**: T-6F-06, T-6E-15
    - **Affected modules**: `DATA/docs/standalone-inventory.md`
    - **Acceptance criteria**:
      - Every attachment artifact has exactly one final disposition, a reason and a requirement ID. Each of the 13 ported attachment tests and each attachment step of `db5_db6.test.cjs` names the canonical test that replaces it (ARCH-R03.10), test 8 and the standalone attachment table, the `Messages` rebuild and the plaintext path are marked retired, and the OD-20 outcome is cited.
      - The changed client assertions of T-6E-13 are cross-referenced. No Standalone_Implementation code or test is changed, renamed or deleted: G2 prints nothing.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/; G2
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.1, ARCH-R03.2, ARCH-R03.3, ARCH-R03.4, ARCH-R03.10, ARCH-R03.12, ARCH-R03.13, DB5-R15.12_

  - [ ] 12.8 Complete the handoff document for DB-6
    - **ID**: T-6F-08
    - **Depends on**: T-6F-02, T-6F-03, T-6F-07
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The document lists the merged code of DB-6A to DB-6F (files per phase and `git rev-parse HEAD`, or the note that nothing is committed), the attachment endpoint list with links to the contract and OpenAPI documents, authorization rules and error codes, migration instructions for 0009 with the one-way warning and the `ATTACHMENT_*` variables, the command, passed, failed, skipped and date of every DB-6 phase run (DB5-R15.13), known gaps (open OD and OP items with defaults, the Not verified list, the residual risk of DB6-R05.6, accepted review findings, the proxy measurement and hard-link results, waivers) and the Gate_Record list.
      - `gate-records.test.js` fails when a required heading is missing or when a phase from DB-6A to DB-6F has no run record.
      - The document states, as decided facts and not as gaps, the decisions recorded in the DB-5A reconciliation that DB-6 relies on (OP-06 with its seven literals for 0009, DK-01 to DK-07), and lists as gaps only what stays open (the OD-01 friendship sub-question, the OD-08 maxima and re-invite delay, OD-14 to OD-21, OP-02 to OP-05, OP-08, OP-10, OP-12, OP-13 and the amendments OA-01 to OA-04 that are not yet approved). Its Docker section covers the attachment parts: the storage root is the reserved `private-storage` volume path `/var/lib/secubuzz/attachments`; `sqlite-data` and `private-storage` are backed up and restored together by the cold-backup procedure; the rehearsal runs in a Disposable_Project; Compose Watch is not used while a migration file is a draft; per-source limits share one bucket there; `client/authProxy.cjs`, `client/next.config.js` and `DATA/docs` need a rebuild; the Validation_Runner results are the gate of record, with the Windows host results as additional evidence and the Known_Baseline_Failure entries listed separately.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R13.8, DB5-R15.13, DB5-R14.15, DB5-R14.16, ARCH-R01.9, ARCH-R03.8, DB6-R05.6, DB5-R15.14, COMP-10_

  - [ ] 12.9 Draft the DB6-ACCEPTANCE Gate_Record and send the request to the Project_Owner
    - **ID**: T-6F-09
    - **Depends on**: T-6F-08, T-6A-11, T-6A-12, T-6D-01
    - **Affected modules**: `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - The entry `GR-DB6-ACCEPTANCE-<date>` cites the C1 to C5 results, the restart availability result of T-6F-01, the coverage check, the completed handoff, the ATTACHMENTS-PROTECTED record, the OD-14 and OD-15 values, the OD-20 outcome and the OP-12 decision. The approval line is left empty for the Project_Owner, who is asked to review it.
      - `gate-records.test.js` still passes and no committed environment file enables a switch.
      - The request also asks the Project_Owner to approve or reject amendment OA-04 (CI-11, OP-12): which Gate_Records enable the Attachment_API (the OP-12 decision of T-6D-01), with the text of DB5-R16 criteria 8 and 11 and of DB6-R05.8 that it would change. This plan does not edit the requirement text, and this task selects no default.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: DB5-R16.8, DB6-R05.8, ARCH-R03.6, ARCH-R02.8_

  - [ ] 12.10 Phase gate DB-6F
    - **ID**: T-6F-10
    - **Depends on**: T-6F-01 to T-6F-09
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/docs/gate-records.md`
    - **Acceptance criteria**:
      - C1 to C5 run again in the Validation_Runner (groups `data`, `server` and `client`, the gate of record) after the documentation changes and pass as defined in the Notes. The same C1 to C5 run on the Windows host as additional evidence: C1 and C3 pass and C4 fails exactly the two Known_Baseline_Failure entries (T-5B-39) and nothing else. G1, G2 and G9 exit 0, G3, G5a, G7 and G8 print nothing, and G5b prints only the seven DC-01 lines and the client assertions recorded in the inventory. `attachments-restart` passes and the handoff documentation check passes.
      - The handoff records the final run of each command (command and runner group, passed, failed, skipped, date, `git rev-parse HEAD`, `git status --short`) and lists the Known_Baseline_Failure entries separately by test name and platform; none is skipped, edited, excluded or silenced, and any other failure fails the gate (DB5-R15.15). `GR-DB6-ACCEPTANCE-<date>` carries the Project_Owner's approval. This task stays unchecked until it does. No switch is enabled, no application container is started by the gate, no Docker file is edited, and no Standalone_Implementation file is changed, deleted or deprecated by it.
    - **Verify**: C1; C2; C3; C4; C5 in the Validation_Runner (groups `data`, `server` and `client`) and on the Windows host; G1; G2; G3; G5a; G5b; G7; G8; G9
    - **Agent**: Kiro, with Codex supplying C4 and C5 and the Project_Owner approving the Gate_Record
    - _Requirements: DB5-R15.10, DB5-R15.11, DB5-R15.13, DB5-R15.14, DB5-R15.15, DB5-R16.8, DB6-R04.8, ARCH-R02.1, ARCH-R03.13, COMP-01, COMP-10_

- [ ] 13. DB-7: combined regression, handoff and the publication gate
  **Entry criteria.** DB-5G and DB-6F exits met (T-5G-12, T-6F-10), so the records `DB5-ACCEPTANCE` and `DB6-ACCEPTANCE` exist. OD-20 is recorded (T-5G-02) before any deprecation statement is written. Open OD items stay provisional and are listed as known gaps. The tree state is the one the Project_Owner designates: before the first run T-7-01 records `git rev-parse HEAD`, `git status --short` and `git stash list`. No commit, push or pull request is made before the Project_Owner approves publication (T-7-09). No agent runs `git commit`, `git push` or a pull request command in this phase: T-7-10 to T-7-12 belong to the Project_Owner. A failed, skipped, cancelled or unfinished suite means no publication request (ARCH-R02.9). No deletion of Standalone_Implementation code, and no switch is enabled by this plan.
  **Decisions and their gates.** The decided facts (OD-04, OD-05, OP-06, the parts of OD-01 and OD-08 decided in the DB-5A reconciliation, DK-01 to DK-07) are stated as decisions in the handoff. What stays open is listed as a known gap with its default and its gate and is not selected here: the OD-01 friendship sub-question, the OD-08 maxima and re-invite delay, OD-02, OD-03, OD-06, OD-07, OD-09 to OD-21, OP-01 to OP-05, OP-07 to OP-16 (OP-01, OP-07 and OP-09 provisional) and the amendments OA-01 to OA-04 that are not yet approved.
  **Docker (COMP-10).** The suite records of T-7-01 and T-7-13 are Validation_Runner results (the gate of record) and are reported with the Windows host results as additional evidence. The Known_Baseline_Failure entries are listed separately by test name and platform and are never suppressed, and a failure that is not on that list means no publication request (ARCH-R02.9, DB5-R15.15). No application container is started by a gate run, no volume of a running project is opened, archived or restored, every Disposable_Project is removed, and no Dockerfile, `compose.yaml` or `docker/` file is edited (`docs/docker-development.md` only after the OP-18 approval). In the Docker_Environment port 3001 is the application, and the Standalone_Implementation host is identified by `server/api-main.cjs`, `npm run start:api` and `API_PORT`, never by a port number.

  - [ ] 13.1 Run the DATA, server and client suites on one tree state and record the counts
    - **ID**: T-7-01
    - **Depends on**: T-5G-12, T-6F-10
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (results note)
    - **Acceptance criteria**:
      - Before the first run the note records `git rev-parse HEAD`, `git status --short`, `git stash list`, and the size and `LastWriteTime` of `DATA/server/database/database.sqlite` and its `-wal` and `-shm` files, read with `Get-Item` and never opened. C1 to C5 then run in order, in the Validation_Runner, on that tree state, with `git status --short` printed after the last run to show that it did not change.
      - C1 to C5 run in the Validation_Runner (groups `data`, `server` and `client`), the gate of record, and each record holds the command and runner group, passed, failed, skipped, cancelled, todo, the result and the date. The same C1 to C5 run on the Windows host as additional evidence and are recorded beside them with the platform named: C1 and C3 pass and C4 fails exactly the two Known_Baseline_Failure entries (T-5B-39) and nothing else. The entries are listed separately and never skipped, edited, excluded or silenced, and any other failure fails the gate (DB5-R15.15). C1 shows at least 321 plus all new tests with 0 failed, 0 skipped, 0 cancelled and 0 todo. C3 and C4 show 0 failed and 0 skipped with at least the counts of T-5B-01 and T-5B-02. The C3 files `groups-bridge` and `groups-types` show that direct events keep the baseline event names, payload fields and recipients and that no group event is emitted while a switch is off. A suite that fails or ends without a result is recorded as such.
    - **Verify**: C1 to C5 in the Validation_Runner (groups `data`, `server` and `client`) and on the Windows host; G9
    - **Agent**: Kiro, with Codex supplying C4 and C5
    - _Requirements: ARCH-R02.1, ARCH-R02.6, ARCH-R02.7, ARCH-R02.10, DB5-R15.10, DB5-R15.13, DB5-R15.14, DB5-R15.15, COMP-01, COMP-10_

  - [ ] 13.2 Replay the direct-message fixtures and the baseline guards on the final state
    - **ID**: T-7-02
    - **Depends on**: T-7-01
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (results note)
    - **Acceptance criteria**:
      - `dm-fixtures-replay.test.js` and `baseline-checksums.test.js` pass on the final state (inside C1 of the Validation_Runner), and G1, G3, G5a, G5b and G6 give their passing results, G7 and G8 print nothing and G9 exits 0. The two fixture files `baseline-d7cd40a.json` and `direct-baseline-d7cd40a.json` have the same `Get-FileHash` value before and after the runs.
      - `git diff --stat d7cd40a -- server client` is recorded and its files are the ones named by T-5C-06, DB-5E, DB-5F and DB-6E. G2 prints nothing.
    - **Verify**: `node --test tests/dm-fixtures-replay.test.js tests/baseline-checksums.test.js` in DATA/; G1; G2; G3; G5a; G5b; G6; G7; G8; G9
    - **Agent**: Kiro
    - _Requirements: ARCH-R02.1, ARCH-R02.3, ARCH-R02.4, DB5-R15.4, DB5-R15.11, COMP-06_

  - [ ] 13.3 Add the publication-blocker rule to `gate-records.test.js`
    - **ID**: T-7-03
    - **Depends on**: T-7-01
    - **Affected modules**: `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The test fails when the handoff holds a "Publication request" section while any of the five Validation_Runner records C1 to C5 (the gate of record) is missing, has no result, shows failed, skipped or cancelled above 0, or records a `git rev-parse HEAD` that differs from the other records. A Windows host record (additional evidence) may show failures only for tests named in the section "Known_Baseline_Failure" of the handoff with the platform Windows (the two entries of T-5B-39); any other failing test name, a skipped or silenced entry, or a missing Known_Baseline_Failure section fails the rule (DB5-R15.15). It passes when the section is absent.
      - Example tests with temporary copies of the handoff cover each failing case, the two accepted Windows entries and the passing case.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R02.9, ARCH-R02.7, DB5-R15.14, DB5-R15.15_

  - [ ] 13.4 Confirm every Gate_Record and list its evidence
    - **ID**: T-7-04
    - **Depends on**: T-7-01
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (Gate_Record list), `DATA/docs/gate-records.md`, `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The handoff lists `GROUP-MANAGEMENT`, `GROUP-MESSAGING`, `GROUP-REALTIME`, `GROUP-FRONTEND`, `ATTACHMENTS-PROTECTED`, `DB5-ACCEPTANCE` and `DB6-ACCEPTANCE`, each with its `GR-<stage>-<date>` identifier, the gate it opens, the evidence (commands and results, review reports), the approval date and the Project_Owner's name. A stage without an approved record is listed with the Project_Owner's written waiver (OP-16), the reason and the statement that the function stays disabled for Real_Accounts.
      - `gate-records.test.js` fails when a listed stage has neither an approved entry in `gate-records.md` nor a recorded waiver, or when a listed approval line is empty.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R02.8, DB5-R16.8, DB6-R05.8_

  - [ ] 13.5 Mark the Standalone_Implementation deprecated and finalise the inventory
    - **ID**: T-7-05
    - **Depends on**: T-7-04, T-5G-02, T-6F-07
    - **Affected modules**: `DATA/docs/standalone-inventory.md`, `DATA/docs/db5-db6-handoff.md` (runtime statements)
    - **Acceptance criteria**:
      - Only after OD-20 is recorded (T-5G-02, T-6A-16) and both acceptance records are approved, the inventory header and the runtime statements of the handoff state that the Standalone_Implementation is deprecated and cite `GR-DB5-ACCEPTANCE-<date>` and `GR-DB6-ACCEPTANCE-<date>`. The inventory is final: each artifact has one disposition, a reason and a requirement ID, and each ported test names its replacement.
      - No standalone file is edited, renamed or deleted: G2 and G3 print nothing. A comment marker inside a standalone file is a separate change that the Project_Owner may request. If either record or the OD-20 decision is missing, this task stays unchecked.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/; G2; G3
    - **Agent**: Kiro
    - _Requirements: ARCH-R03.6, ARCH-R03.5, ARCH-R03.12, ARCH-R03.13, ARCH-R01.9_

  - [ ] 13.6 Write the final handoff document
    - **ID**: T-7-06
    - **Depends on**: T-7-02, T-7-04, T-7-05
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`, `DATA/tests/gate-records.test.js`
    - **Acceptance criteria**:
      - The document opens with the one-way migration warning for 0008 and 0009 (a cold backup first: in the Docker_Environment both complete volume roots, `sqlite-data` and `private-storage`, archived together by the procedure of `docs/docker-development.md`; on a host a cold copy of the database file with `-wal` and `-shm`). It lists the merged code per phase and the tree state, the endpoint list with links to `groups-api.md`, `groups-openapi.json`, `attachments-api.md` and `attachments-openapi.json`, authorization rules and error codes, migration instructions and environment variables, the test commands and results of T-7-01 and T-7-02, known gaps (open OD and OP items with defaults and gates, the Not verified list, accepted review findings, waivers, the residual risk of DB6-R05.6, unmigrated standalone data, the amendments OA-01 to OA-04 that are not yet approved), the decisions of the DB-5A reconciliation (OP-06, OD-01 in part, OD-04, OD-05, OD-08 in part, DK-01 to DK-07) stated as decided facts and not as gaps, the section "Docker development environment" (volumes, cold backup of both volumes, Disposable_Project, Compose Watch rule, rebuild rules, gate runner, Known_Baseline_Failure list), the runtime statements and the Gate_Record list.
      - The runtime statements say that the Standalone_Implementation host, identified by the file `server/api-main.cjs`, the script `npm run start:api` and the variable `API_PORT` and never by a port number alone, is not a supported runtime; that `npm run start:data` is the only supported server; that in the Docker_Environment port 3001 is the browser-facing address of the application and not of the Standalone_Implementation; that approved DB-5 and DB-6 server code lives in `DATA/`; that `server/` keeps the realtime and end-to-end protocol code; and that the Standalone_Implementation is deprecated (ARCH-R01.9).
      - `gate-records.test.js` fails when a required heading is missing.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/
    - **Agent**: Kiro
    - _Requirements: ARCH-R01.9, ARCH-R03.8, ARCH-R02.7, ARCH-R02.8, DB5-R13.8, DB5-R14.15, DB5-R14.16, DB5-R14.20, DB5-R14.23, DB5-R15.13, DB5-R15.14, COMP-10_

  - [ ] 13.7 Check that the working tree, the stashes and the database file were preserved
    - **ID**: T-7-07
    - **Depends on**: T-7-06
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (preservation note)
    - **Acceptance criteria**:
      - The note compares the state recorded in T-7-01 with the state after the last agent task. `git stash list` is identical (no stash was dropped, popped or cleared), `git status --short` differs only by files that DB-7 tasks list, and no `git reset`, `git checkout --`, `git clean`, `git stash drop` or `git stash clear` was run.
      - The size and `LastWriteTime` of `DATA/server/database/database.sqlite` and its `-wal` and `-shm` files are unchanged (read with `Get-Item`, never opened), and nothing outside the working tree except the system temporary directory was written.
      - No volume of the running Docker_Environment project (`sqlite-data`, `private-storage`) was opened, mounted, archived, restored or removed by a task of this plan. `docker compose ls -a` lists no project whose name starts with `secubuzz-disposable-` that a task of this plan created, and `-v` was never used on another project. No Dockerfile, `compose.yaml` or `docker/` file changed (G8 prints nothing and `git diff --stat dc6c997 -- compose.yaml docker .dockerignore server/Dockerfile client/Dockerfile` prints nothing; `docs/docker-development.md` changed only after the Project_Owner approved OP-18).
    - **Verify**: `git status --short`; `git stash list`; `Get-Item` on the three database files; `docker compose ls -a`; G8
    - **Agent**: Kiro
    - _Requirements: DB5-R14.17, DB5-R14.21, DB5-R11.6, ARCH-R03.13, COMP-10_

  - [ ] 13.8 Request the Project_Owner's publication approval
    - **ID**: T-7-08
    - **Depends on**: T-7-03, T-7-04, T-7-06, T-7-07
    - **Affected modules**: `DATA/docs/db5-db6-publication-request.md` (new; file name chosen here), `DATA/docs/db5-db6-handoff.md` (Publication request section)
    - **Acceptance criteria**:
      - The request holds the tree state (`git rev-parse HEAD` and `git status --short`), the five Validation_Runner suite records (the gate of record) with command and runner group, passed, failed, skipped and result, the Windows host results as additional evidence, the Known_Baseline_Failure list kept separate, the Gate_Record list with evidence, the known gaps, the deprecation statement, the change summary (`git diff --stat d7cd40a`), the one-way migration warning as its first paragraph, and a proposed branch name, commit message and pull request title and description. It states that no commit, push or pull request has been made.
      - If any suite failed (other than the recorded Known_Baseline_Failure entries on the Windows host), was skipped or did not finish, or a Gate_Record has neither approval nor waiver, no request is written (ARCH-R02.9), the blocker is named in the handoff and this task stays unchecked.
    - **Verify**: `node --test tests/gate-records.test.js` in DATA/; Project_Owner reviews the request (no command applies)
    - **Agent**: Kiro
    - _Requirements: ARCH-R02.7, ARCH-R02.8, ARCH-R02.9, DB5-R14.16_

  - [ ] 13.9 Record the Project_Owner's publication approval
    - **ID**: T-7-09
    - **Depends on**: T-7-08
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md` (decision log)
    - **Acceptance criteria**:
      - The entry records the approval or refusal with the date, the tree state approved, the open OD items that stay provisional as known gaps, and whether the Project_Owner will make the commit now.
      - Without an approval entry no commit, push or pull request exists.
    - **Verify**: Project_Owner reviews the decision-log entry (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: ARCH-R02.8, ARCH-R02.9_

  - [ ] 13.10 Create the commit of the approved change set (Project_Owner only)
    - **ID**: T-7-10
    - **Depends on**: T-7-09
    - **Affected modules**: none (git history; no file edit)
    - **Acceptance criteria**:
      - The Project_Owner stages the files named in the publication request by name and commits with a message that cites `GR-DB5-ACCEPTANCE-<date>` and `GR-DB6-ACCEPTANCE-<date>`. The inventory holds the original author and source file of every ported artifact (ARCH-R03.7).
      - `git status --short` prints nothing afterwards. No agent runs a git write command for this task.
    - **Verify**: `git log -1 --stat` and `git status --short` at the repository root
    - **Agent**: Project_Owner
    - _Requirements: ARCH-R02.8, ARCH-R03.7_

  - [ ] 13.11 Push the approved branch (Project_Owner only)
    - **ID**: T-7-11
    - **Depends on**: T-7-10
    - **Affected modules**: none (remote repository)
    - **Acceptance criteria**:
      - The Project_Owner pushes the approved branch to the remote that the Project_Owner names, without force. No agent runs `git push`.
    - **Verify**: `git status -sb` at the repository root shows the branch up to date with its remote
    - **Agent**: Project_Owner
    - _Requirements: ARCH-R02.8_

  - [ ] 13.12 Open the pull request (Project_Owner only)
    - **ID**: T-7-12
    - **Depends on**: T-7-11
    - **Affected modules**: none (hosting service)
    - **Acceptance criteria**:
      - The Project_Owner opens the pull request with the title and description of `db5-db6-publication-request.md`. Its first paragraph is the one-way migration warning, and it lists the Gate_Records and the known gaps.
    - **Verify**: Project_Owner confirms that the pull request exists (no command applies)
    - **Agent**: Project_Owner
    - _Requirements: ARCH-R02.8, DB5-R14.16_

  - [ ] 13.13 Phase gate DB-7
    - **ID**: T-7-13
    - **Depends on**: T-7-01 to T-7-12
    - **Affected modules**: `DATA/docs/db5-db6-handoff.md`
    - **Acceptance criteria**:
      - After the last change C1 runs again in the Validation_Runner (group `data`, the gate of record), with G1, G2, G3, G5a, G5b, G7, G8 and G9, and all pass as defined in the Notes: G5b prints only the seven DC-01 lines and the client assertions recorded in the inventory, G2, G3, G7 and G8 print nothing, and G9 exits 0. The same C1 on the Windows host is recorded beside it as additional evidence. The handoff records the final run (command and runner group, passed, failed, skipped, date) next to the start-of-phase records of T-7-01, and lists the Known_Baseline_Failure entries separately by test name and platform, never suppressed.
      - The Gate_Record list is complete, the Project_Owner's publication approval is recorded, and the commit, push and pull request were made by the Project_Owner. No Standalone_Implementation code was deleted, no switch is enabled by this plan, no Dockerfile, `compose.yaml` or `docker/` file changed (`docs/docker-development.md` only after the OP-18 approval), and `git stash list` equals the list recorded in T-7-01.
    - **Verify**: C1 in the Validation_Runner (group `data`) and on the Windows host; G1; G2; G3; G5a; G5b; G7; G8; G9; `git stash list`
    - **Agent**: Kiro
    - _Requirements: ARCH-R02.1, ARCH-R02.7, ARCH-R02.8, ARCH-R03.13, DB5-R15.13, DB5-R15.14, DB5-R15.15, COMP-01, COMP-10_

## Requirements Traceability

Each row lists the tasks that implement or verify at least one criterion of the requirement, and the properties of the design whose test tasks validate it. A range such as `T-5C-33 to T-5C-35` means every ID in that span that is a task. T-5B-34 was dropped by the owner (DK-06) and never reused: it is in no row and in no range, so the rows list the IDs around it one by one. ARCH-R03 has no property: the design verifies it by document checks and git-history checks over finite lists.

| Requirement | Tasks that implement or verify it | Properties |
| --- | --- | --- |
| DB5-R01 | T-5B-08, T-5B-13, T-5B-15, T-5B-26, T-5C-07, T-5C-20, T-5C-23, T-5C-26, T-5C-32, T-5C-33, T-5C-41, T-5C-46, T-5C-47, T-5C-49, T-5C-53, T-5F-06 | P-08, P-09, P-20, P-23, P-31, P-41 |
| DB5-R02 | T-5B-08, T-5B-12, T-5B-13, T-5B-15, T-5B-17, T-5B-23, T-5B-24, T-5B-26, T-5B-31, T-5C-03, T-5C-07 to T-5C-09, T-5C-22, T-5C-23, T-5C-26, T-5C-33 to T-5C-35, T-5C-38, T-5C-46, T-5C-47, T-5C-49, T-5C-53, T-5D-16, T-5F-06, T-5G-04, T-6B-47, T-6D-14, T-6D-15, T-6F-04 | P-03, P-09, P-13, P-14, P-15, P-19, P-20, P-22, P-23, P-41 |
| DB5-R03 | T-5B-13, T-5B-24 to T-5B-26, T-5C-01, T-5C-10, T-5C-13, T-5C-14, T-5C-20, T-5C-22, T-5C-23, T-5C-26, T-5C-27, T-5C-32, T-5C-35, T-5C-38 | P-03, P-08, P-09, P-10, P-15, P-20, P-22 |
| DB5-R04 | T-5B-09, T-5B-14, T-5B-15, T-5B-23, T-5B-27, T-5C-01, T-5C-11 to T-5C-13, T-5C-15, T-5C-18, T-5C-20, T-5C-22, T-5C-24 to T-5C-26, T-5C-29 to T-5C-31, T-5C-35 to T-5C-38, T-5C-49, T-5F-08 | P-01, P-03, P-04, P-05, P-06, P-07, P-08, P-09, P-15, P-21, P-22 |
| DB5-R05 | T-5B-09, T-5B-25, T-5C-15, T-5C-18 to T-5C-20, T-5C-22, T-5C-24, T-5C-26 to T-5C-28, T-5C-30, T-5C-36, T-5C-38, T-5C-41, T-5D-05, T-5D-14, T-5E-01, T-5E-02, T-5E-05 to T-5E-07, T-5F-07, T-6D-02, T-6D-11, T-6D-16 | P-01, P-02, P-03, P-06, P-08, P-09, P-10, P-12, P-22, P-24, P-31, P-36, P-40 |
| DB5-R06 | T-5B-09, T-5B-13, T-5B-23 to T-5B-25, T-5C-03, T-5C-16, T-5C-18 to T-5C-20, T-5C-22 to T-5C-24, T-5C-26, T-5C-31, T-5C-32, T-5D-18, T-5F-07 | P-01, P-02, P-03, P-07, P-08, P-09, P-20 |
| DB5-R07 | T-5B-23, T-5B-26, T-5C-04, T-5C-09, T-5C-15, T-5C-17, T-5C-22, T-5C-28, T-5C-38, T-5C-41, T-5D-19, T-5F-07, T-6D-05, T-6D-16 | P-03, P-22, P-24, P-31 |
| DB5-R08 | T-5B-06, T-5B-08, T-5B-09, T-5B-15 to T-5B-18, T-5B-23, T-5B-25, T-5B-26, T-5B-28, T-5B-29, T-5C-07, T-5C-27, T-5C-33, T-5C-53, T-5D-05, T-5D-09, T-5D-13 to T-5D-15, T-5D-18, T-5D-26, T-5F-07, T-6D-03, T-6D-11 | P-01, P-10, P-11, P-12, P-15, P-18, P-23, P-27, P-36, P-41 |
| DB5-R09 | T-5B-12, T-5B-15, T-5B-18, T-5B-28, T-5B-29, T-5B-31, T-5C-34, T-5C-47, T-5D-02 to T-5D-05, T-5D-07 to T-5D-09, T-5D-11, T-5D-12, T-5D-15, T-5D-16, T-5D-19, T-5D-20, T-5D-22 to T-5D-24, T-5D-26 to T-5D-28, T-5E-01, T-5E-03, T-5E-05, T-5E-07, T-5F-09, T-5G-04, T-6B-47, T-6F-04 | P-11, P-13, P-14, P-15, P-16, P-17, P-19, P-20, P-21, P-24, P-25, P-27, P-40 |
| DB5-R10 | T-5B-13, T-5B-15, T-5B-23, T-5B-24, T-5B-28, T-5C-08, T-5D-06, T-5D-10, T-5D-13, T-5D-23 | P-18, P-21 |
| DB5-R11 | T-5B-17, T-5B-19, T-5B-21, T-5B-22, T-5B-26, T-5B-30, T-5C-41, T-5C-42, T-5G-03, T-6B-06, T-6B-11, T-7-07 | P-28, P-31, P-32 |
| DB5-R12 | T-5B-20, T-5C-03, T-5C-04, T-5C-11, T-5C-13, T-5C-20, T-5C-22, T-5C-23, T-5C-30 to T-5C-32, T-5C-36, T-5C-38 to T-5C-41, T-5C-47, T-5C-49, T-5D-04, T-5D-10, T-5D-23, T-5D-25, T-6B-23, T-6B-26, T-6B-32, T-6B-42, T-6B-45, T-6B-46, T-6D-20 | P-03, P-06, P-07, P-08, P-20, P-21, P-22, P-30, P-31 |
| DB5-R13 | T-5B-06, T-5B-13, T-5B-20, T-5B-22, T-5C-03 to T-5C-05, T-5C-21, T-5C-23, T-5C-32, T-5C-36 to T-5C-39, T-5C-41, T-5C-46, T-5C-47, T-5C-49, T-5D-09, T-5D-23, T-5D-25, T-5D-26, T-5F-05, T-5G-07, T-5G-10, T-6A-06, T-6B-23, T-6B-46, T-6B-48, T-6D-12, T-6D-13, T-6D-18, T-6D-20, T-6F-05, T-6F-08, T-7-06 | P-20, P-21, P-22, P-31 |
| DB5-R14 | T-5B-05, T-5B-06, T-5B-11, T-5B-15 to T-5B-19, T-5B-21 to T-5B-24, T-5B-31, T-5B-33, T-5B-35, T-5B-36, T-5C-05, T-5C-06, T-5C-08, T-5C-18, T-5C-25, T-5C-27, T-5C-29, T-5C-38, T-5C-42, T-5C-45, T-5C-47, T-5C-52, T-5C-54, T-5D-13, T-5G-02, T-5G-03, T-5G-10, T-6B-01 to T-6B-06, T-6B-18, T-6B-20, T-6B-50, T-6B-51, T-6F-08, T-7-06 to T-7-08, T-7-12 | P-04, P-05, P-10, P-18, P-19, P-22, P-27, P-28, P-29, P-32 |
| DB5-R15 | T-5B-01 to T-5B-07, T-5B-10, T-5B-19, T-5B-21, T-5B-31, T-5B-32, T-5B-37 to T-5B-39, T-5C-18 to T-5C-21, T-5C-24, T-5C-25, T-5C-29 to T-5C-32, T-5C-36, T-5C-37, T-5C-42, T-5C-43, T-5C-45, T-5C-48, T-5C-51 to T-5C-53, T-5D-14, T-5D-18, T-5D-20, T-5D-23, T-5D-31, T-5E-09, T-5F-12, T-5G-03 to T-5G-06, T-5G-08 to T-5G-10, T-5G-12, T-6A-01, T-6A-03, T-6A-09, T-6A-10, T-6A-20 to T-6A-23, T-6B-01, T-6B-02, T-6B-06, T-6B-11, T-6B-15, T-6B-17, T-6B-40, T-6B-43, T-6B-47, T-6B-52 to T-6B-54, T-6C-13, T-6D-04, T-6D-09 to T-6D-12, T-6D-21, T-6E-01, T-6E-03, T-6E-08 to T-6E-11, T-6E-13, T-6E-15, T-6F-01 to T-6F-04, T-6F-06 to T-6F-08, T-6F-10, T-7-01 to T-7-03, T-7-06, T-7-13 | P-01, P-02, P-04, P-05, P-06, P-07, P-08, P-12, P-19, P-21, P-25, P-28, P-29, P-32, P-36, P-41 |
| DB5-R16 | T-5B-14, T-5C-01, T-5C-02, T-5C-04 to T-5C-06, T-5C-23, T-5C-43, T-5C-44, T-5C-48 to T-5C-50, T-5C-52, T-5D-01 to T-5D-03, T-5D-08, T-5D-20 to T-5D-22, T-5D-24, T-5D-27 to T-5D-31, T-5E-08, T-5E-09, T-5F-01 to T-5F-04, T-5F-06 to T-5F-12, T-5G-01, T-5G-11, T-5G-12, T-6A-06, T-6A-11, T-6A-12, T-6A-19, T-6A-24, T-6B-21, T-6B-22, T-6B-32, T-6B-38, T-6B-43, T-6B-44, T-6B-49, T-6B-54, T-6C-01, T-6C-05 to T-6C-07, T-6C-12, T-6C-13, T-6D-01, T-6D-19, T-6D-20, T-6E-02, T-6E-04, T-6E-14, T-6F-01, T-6F-09, T-6F-10, T-7-04 | P-20, P-25, P-26 |
| DB6-R01 | T-6A-06, T-6A-11, T-6A-16 to T-6A-18, T-6B-01, T-6B-04, T-6B-05, T-6B-18 to T-6B-20, T-6B-25, T-6B-27 to T-6B-29, T-6B-34, T-6B-35, T-6B-37, T-6B-39, T-6C-09, T-6D-08, T-6D-11, T-6D-17, T-6E-08 | P-27, P-35, P-36, P-37, P-38 |
| DB6-R02 | T-6A-02, T-6A-03, T-6B-07, T-6B-11 to T-6B-17, T-6B-22, T-6B-23, T-6B-25, T-6B-26, T-6B-30, T-6B-32, T-6B-38, T-6B-41, T-6B-44, T-6D-13, T-6D-17 | P-22, P-26, P-33, P-34, P-35 |
| DB6-R03 | T-6A-04 to T-6A-06, T-6A-09 to T-6A-11, T-6A-14, T-6A-15, T-6A-18, T-6B-08, T-6B-09, T-6B-14, T-6B-21, T-6B-23 to T-6B-34, T-6B-36 to T-6B-39, T-6B-41, T-6B-45, T-6B-46, T-6B-52, T-6B-53, T-6C-04, T-6C-08, T-6D-02 to T-6D-20, T-6E-06, T-6E-08 | P-14, P-15, P-20, P-21, P-22, P-24, P-30, P-31, P-34, P-35, P-36, P-37, P-38 |
| DB6-R04 | T-6A-02 to T-6A-06, T-6A-12, T-6A-17 to T-6A-19, T-6A-24, T-6B-08 to T-6B-10, T-6B-13, T-6B-16 to T-6B-21, T-6B-24 to T-6B-26, T-6B-29, T-6B-30, T-6B-33, T-6B-35 to T-6B-37, T-6B-39 to T-6B-42, T-6B-53, T-6C-02, T-6C-09, T-6D-08, T-6D-17, T-6E-06, T-6E-07, T-6F-01, T-6F-10 | P-33, P-34, P-35, P-37, P-38, P-39 |
| DB6-R05 | T-6A-04, T-6A-05, T-6A-07, T-6A-08, T-6A-13, T-6A-18, T-6A-22, T-6B-08, T-6B-09, T-6B-25, T-6B-33, T-6B-41, T-6B-49, T-6C-01 to T-6C-08, T-6C-10 to T-6C-13, T-6D-01, T-6D-17, T-6D-19, T-6E-01, T-6E-03 to T-6E-12, T-6E-14, T-6E-15, T-6F-03, T-6F-05, T-6F-08, T-6F-09, T-7-04 | P-34, P-35 |
| ARCH-R01 | T-5B-06, T-5B-15, T-5B-17, T-5B-18, T-5B-20, T-5B-22, T-5C-04 to T-5C-06, T-5C-23, T-5D-08, T-5E-02, T-5E-04, T-5E-07, T-5G-10, T-6A-23, T-6B-01, T-6B-03, T-6B-05, T-6B-18, T-6B-20, T-6B-23, T-6B-32, T-6B-38, T-6D-20, T-6F-08, T-7-05, T-7-06 | P-20, P-27, P-40 |
| ARCH-R02 | T-5B-01, T-5B-03, T-5B-04, T-5B-07, T-5B-15, T-5B-18, T-5B-31, T-5B-37, T-5C-45, T-5C-52, T-5D-31, T-5E-02 to T-5E-07, T-5E-09, T-5G-01, T-5G-04, T-5G-05, T-5G-11, T-5G-12, T-6A-23, T-6B-01, T-6B-05, T-6B-47, T-6B-54, T-6C-13, T-6D-21, T-6F-02, T-6F-04, T-6F-09, T-6F-10, T-7-01 to T-7-04, T-7-06, T-7-08 to T-7-13 | P-19, P-27, P-40 |
| ARCH-R03 | T-5B-02, T-5B-06, T-5B-32, T-5C-48, T-5C-51, T-5D-09, T-5F-10, T-5G-02, T-5G-06, T-5G-09 to T-5G-12, T-6A-01, T-6A-03, T-6A-04, T-6A-16, T-6A-18, T-6A-20 to T-6A-22, T-6B-13, T-6B-52 to T-6B-54, T-6C-04, T-6D-09, T-6D-21, T-6E-01, T-6E-03, T-6E-08 to T-6E-11, T-6E-13, T-6E-15, T-6F-03, T-6F-07 to T-6F-10, T-7-05 to T-7-07, T-7-10, T-7-13 | none |

### Non-functional and compatibility requirements

- NFR-01: T-5B-22, T-5C-03, T-5C-41, T-5D-04, T-5D-12, T-5D-25, T-6B-18 to T-6B-20, T-6B-23, T-6B-24, T-6B-37, T-6B-46
- NFR-02: T-5D-17
- NFR-03: T-5B-24, T-5B-28, T-5D-17, T-6B-18, T-6B-20, T-6B-31, T-6D-07, T-6D-21
- NFR-04: T-5B-17, T-5D-17, T-6B-03
- NFR-05: T-6A-02, T-6A-03, T-6A-19, T-6A-24, T-6B-13, T-6B-17, T-6E-07
- NFR-06: T-5B-20, T-5C-38, T-5C-40, T-5D-22, T-5D-23, T-5D-25, T-6B-23, T-6B-26, T-6B-45, T-6C-03, T-6D-13
- NFR-07: T-5B-10, T-5B-21, T-5C-18, T-6B-11, T-6B-40, T-6B-42
- NFR-08: T-5B-21, T-5C-04, T-5C-38, T-5D-23, T-6A-06, T-6B-11, T-6B-30, T-6B-32, T-6B-36, T-6B-48, T-6D-09, T-6D-13, T-6D-17
- NFR-09: T-5C-21, T-5C-48, T-6B-01, T-6B-08, T-6B-49, T-6B-54, T-6C-03
- COMP-01: T-5B-01, T-5B-37, T-5C-52, T-5D-31, T-5E-09, T-5G-05, T-5G-12, T-6A-23, T-6B-54, T-6C-13, T-6D-21, T-6F-02, T-6F-10, T-7-01, T-7-13
- COMP-02: T-5C-46, T-6B-32, T-6B-48
- COMP-03: T-5B-16, T-5B-18, T-5B-36, T-6B-05, T-6B-51
- COMP-04: T-6B-01
- COMP-05: T-5B-33, T-6B-50, T-6F-01
- COMP-06: T-5B-02, T-5B-31, T-5F-02, T-5F-05, T-5F-10, T-5F-12, T-5G-04, T-5G-06, T-6B-47, T-6E-03, T-6E-05, T-6E-14, T-6E-15, T-6F-03, T-6F-04, T-7-02
- COMP-07: T-5E-01, T-5E-06, T-5E-07
- COMP-08: T-5C-48, T-6B-49
- COMP-09: T-6A-02, T-6A-03, T-6B-12, T-6B-15 to T-6B-17
- COMP-10: T-5B-06, T-5B-33, T-5B-36 to T-5B-38, T-5C-06, T-5C-48, T-5C-52, T-5C-54, T-5D-31, T-5E-09, T-5F-12, T-5G-10, T-5G-12, T-6A-02, T-6A-06, T-6A-22 to T-6A-24, T-6B-12, T-6B-21, T-6B-22, T-6B-38, T-6B-42, T-6B-49 to T-6B-51, T-6B-54, T-6C-13, T-6D-21, T-6E-04, T-6E-05, T-6E-07, T-6E-14, T-6E-15, T-6F-08, T-6F-10, T-7-01, T-7-06, T-7-07, T-7-13

### Coverage check

Every requirement ID of the table (DB5-R01 to DB5-R16, DB6-R01 to DB6-R05, ARCH-R01 to ARCH-R03) and every NFR item (NFR-01 to NFR-09) and COMP item (COMP-01 to COMP-10) has at least one task, so no task was added for coverage alone. The tasks added by the DB-5A reconciliation (T-5B-38, T-5B-39, T-5C-53, T-5C-54 and T-6A-24) answer reconciled criteria and decisions, and the dropped T-5B-34 appears in no row.

At criterion level, a script read every criterion of `requirements.md` (369 criteria, NFR and COMP items included) and compared it with the `_Requirements_` and `Validates` lines of this file. No criterion is left uncited: every criterion has at least one task that cites it by its own number. The two criteria that the previous version of this note listed as uncited are now cited: DB5-R02.1 by T-5B-15, T-5B-26, T-5C-07 and T-5C-08, and DB5-R10.8 by T-5D-10 (it applies only if OD-12 selects visible receipts, so G25 answers 503 until then). The design's property matrix still lists both as example-based, and the property column above names P-41 for DB5-R01, DB5-R02, DB5-R08 and DB5-R15 because its test task T-5C-53 cites them.

The criteria that the DB-5A reconciliation added or changed, with the tasks that cite them:

- DB5-R01.14 (History_Policy chosen at creation (OD-05)): T-5B-08, T-5B-15, T-5B-26, T-5C-07, T-5C-26, T-5C-33, T-5C-47, T-5C-53, T-5F-06
- DB5-R01.15 (History_Policy in the idempotent create fingerprint): T-5B-08, T-5B-13, T-5C-07, T-5C-33, T-5C-46, T-5C-49, T-5C-53, T-5F-06
- DB5-R02.1 (storage location of the group fields): T-5B-15, T-5B-26, T-5C-07, T-5C-08
- DB5-R02.13 (PATCH never accepts historyPolicy): T-5B-08, T-5B-13, T-5B-17, T-5B-23, T-5B-26, T-5C-09, T-5C-23, T-5C-33, T-5C-46, T-5C-47, T-5C-49, T-5C-53
- DB5-R04.1 (Invitation expiry fixed at 7 days (OD-08 in part)): T-5B-09, T-5B-14, T-5C-01, T-5C-11, T-5F-08
- DB5-R08.1 (History_Policy values all and from_joined): T-5B-08, T-5B-09, T-5B-15, T-5B-17, T-5B-23, T-5B-26, T-5B-29, T-5C-07, T-5C-53, T-5D-18, T-5F-07
- DB5-R08.2 (History_Policy default and immutability): T-5B-08, T-5B-26, T-5C-07, T-5C-33, T-5C-53
- DB5-R10.8 (per-message read information, only if OD-12 selects visible receipts): T-5D-10
- DB5-R14.17 (migration tests only on isolated temporary databases): T-5B-17, T-5B-21, T-5C-05, T-5C-18, T-5C-42, T-5C-52, T-5G-03, T-6B-03, T-6B-51, T-7-07
- DB5-R14.20 (cold copy or cold backup before running the Migration_Runner): T-5B-06, T-5B-33, T-5B-35, T-5G-10, T-6B-50, T-6B-51, T-7-06
- DB5-R14.21 (container-level migration tests only in a Disposable_Project): T-5B-17, T-5B-35, T-5B-36, T-5C-18, T-5C-52, T-6B-03, T-6B-51, T-7-07
- DB5-R14.22 (no Docker Compose Watch while a migration file is a draft): T-5B-06, T-5B-15, T-5B-33, T-5B-36, T-5C-47, T-5C-52, T-6B-01, T-6B-50, T-6B-51
- DB5-R14.23 (cold backup of both volume roots before the first start of a new migration): T-5B-06, T-5B-33, T-5B-35, T-5C-47, T-5C-52, T-5G-10, T-6B-50, T-6B-51, T-7-06
- DB5-R14.24 (rehearsal only on synthetic fixtures or an isolated cold-backup copy): T-5B-35, T-5B-36, T-5C-52, T-6B-51
- DB5-R15.10 (Validation_Runner as the gate of record, Windows host as additional evidence): T-5B-01, T-5B-02, T-5B-37, T-5B-39, T-5C-52, T-5D-31, T-5E-09, T-5F-12, T-5G-05, T-5G-12, T-6A-23, T-6B-54, T-6C-13, T-6D-21, T-6E-15, T-6F-02, T-6F-10, T-7-01
- DB5-R15.11 (seven DC-01 literals and the guard tests (OP-06)): T-5B-03, T-5B-05, T-5B-07, T-5B-37, T-5C-45, T-5C-52, T-5D-31, T-5G-05, T-5G-08, T-5G-12, T-6A-23, T-6B-01, T-6B-02, T-6B-54, T-6D-21, T-6E-01, T-6E-13, T-6F-02, T-6F-06, T-6F-10, T-7-02
- DB5-R15.14 (Known_Baseline_Failure entries recorded by test name and platform): T-5B-02, T-5B-06, T-5B-37 to T-5B-39, T-5C-52, T-5D-31, T-5E-09, T-5F-12, T-5G-10, T-5G-12, T-6A-23, T-6B-54, T-6C-13, T-6D-21, T-6E-15, T-6F-03, T-6F-08, T-6F-10, T-7-01, T-7-03, T-7-06, T-7-13
- DB5-R15.15 (a skipped, edited, excluded or unlisted failing test fails the gate): T-5B-37, T-5B-39, T-5C-52, T-5D-31, T-5E-09, T-5F-12, T-5G-12, T-6A-23, T-6B-54, T-6C-13, T-6D-21, T-6E-15, T-6F-02, T-6F-03, T-6F-10, T-7-01, T-7-03, T-7-13
- DB5-R15.16 (platform-dependent storage assertions branch and are never skipped): T-5B-37, T-5B-39, T-5C-48, T-5C-52, T-5D-31, T-5G-03, T-5G-12, T-6A-03, T-6B-15, T-6B-17
- DB5-R16.7 (required settings (OD-04 decided, OD-08 maxima unresolved, OD-14, OD-15)): T-5B-14, T-5C-01, T-5C-05, T-5C-06, T-5C-44, T-5C-48, T-5C-49, T-6A-11, T-6A-12, T-6B-21, T-6B-38, T-6B-44, T-6C-12
- ARCH-R01.9 (runtime statements: standalone host named by file, script and variable): T-5B-06, T-5G-10, T-6F-08, T-7-05, T-7-06
- ARCH-R02.1 (all 321 baseline tests, seven literals): T-5B-01, T-5B-03, T-5B-07, T-5B-15, T-5B-37, T-5C-45, T-5C-52, T-5D-31, T-5E-09, T-5G-05, T-5G-12, T-6A-23, T-6B-01, T-6B-54, T-6C-13, T-6D-21, T-6F-02, T-6F-10, T-7-01, T-7-02, T-7-13
- COMP-10 (unchanged under the Docker_Environment): T-5B-06, T-5B-33, T-5B-36 to T-5B-38, T-5C-06, T-5C-48, T-5C-52, T-5C-54, T-5D-31, T-5E-09, T-5F-12, T-5G-10, T-5G-12, T-6A-02, T-6A-06, T-6A-22 to T-6A-24, T-6B-12, T-6B-21, T-6B-22, T-6B-38, T-6B-42, T-6B-49 to T-6B-51, T-6B-54, T-6C-13, T-6D-21, T-6E-04, T-6E-05, T-6E-07, T-6E-14, T-6E-15, T-6F-08, T-6F-10, T-7-01, T-7-06, T-7-07, T-7-13
