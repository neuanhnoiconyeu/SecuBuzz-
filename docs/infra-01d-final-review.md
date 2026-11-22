# INFRA-01D final review

November 20, 2026. Branch: `feat/infra-01-docker-dev`; PR base: `main` at
`d7cd40aafcf8f432d17d3f4a85abb26d19fa9bc3` at review time. The owner accepted
INFRA-01C, including C.2, as PASS. This final phase adds documentation and
publication hygiene; it does not implement DB-5/DB-6 or change application logic.

## Publication inventory

The focused change consists of these 21 files:

| Area | Files |
| --- | --- |
| Repository setup | `.gitignore`, `.dockerignore`, `README.md` |
| Development services | `compose.yaml`, `client/Dockerfile`, `server/Dockerfile` |
| Environment/install policy | `docker/compose.env.example.yaml`, `docker/npm-install.conf` |
| Runtime helpers | `docker/run.cjs`, `docker/healthcheck.cjs` |
| Isolated validation tooling | `docker/smoke.cjs`, `docker/database-check.cjs`, `docker/acceptance.cjs`, `docker/reload-check.cjs`, `docker/validate.cjs`, `docker/validation.Dockerfile` |
| Test synchronization | `client/scripts/verify-client-realtime.cjs` |
| Documentation and results | `docs/docker-development.md`, `docs/infra-01b-smoke-results.md`, `docs/infra-01c-acceptance-results.md`, `docs/infra-01d-final-review.md` |

Actual `.env` files, secrets, databases and sidecars, volumes, browser profiles,
backups, checkpoints, generated logs and synthetic test datasets are excluded.
Four one-off local investigation helpers are also ignored rather than shipped:
`docker/ai-diagnostics.cjs`, `docker/backend-replacement-check.cjs`,
`docker/focused-browser.cjs`, `docker/retry-client.cjs`. Existing local files are
retained. Published reports use portable checkout paths. Existing historical
databases already tracked in the base revision are unchanged and excluded from
Docker build contexts; this PR does not introduce or modify database files.

## Implementation review

- Exactly two services: the unified `start:data` backend and Next development
  frontend. Only `127.0.0.1:3001` is published. The frontend shares the backend's
  network namespace and proxies to its loopback port 5000.
- Both Dockerfiles pin Node 24.20.0 Bookworm slim to
  `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`.
  Separate Linux `npm ci` installs use unchanged client/server/DATA lockfiles.
  Native dependencies load and operate in Linux; compiler fallback is installed.
  Debian repositories/prebuild availability remain external inputs, so this is
  not a bit-identical offline build archive.
- UID 1000, capability dropping, no-new-privileges, loopback-only HTTP, exact
  Origin validation, existing cookie/CSRF/authorization/encryption behavior and
  disabled independent feature gates are retained. No secret is injected.
- SQLite plus WAL/SHM live in one private project volume; private attachment
  storage remains a separate reserved volume. The frontend cannot mount either.
  All accepted C persistence, backup/restore and lifecycle results remain valid.
- C.2 adds only a bounded Playwright wait for completed transitions and the same
  expected background color. The original assertion is textually unchanged.
  Application source, manifests, lockfiles and migrations are unchanged.

## Final focused verification

| Check | Result |
| --- | --- |
| `docker compose config` | PASS: two services, expected ports/mounts/security |
| Optional environment example configuration | PASS: both service environments equal the defaults |
| `docker build --check` for both development Dockerfiles | PASS, no warnings |
| Linux native dependency probe | PASS: both better-sqlite3 packages queried in-memory DBs; Argon2 hash/verify passed; UID 1000 |
| Original backend `/healthz`, frontend `/login`, frontend-to-backend loopback | PASS |
| Fresh network-isolated `npm run test:realtime:browser` | **58 passed, 0 failed**, exit 0; 107.350 s including command/receipt overhead |
| Original dark-surface assertion | PASS unchanged; same C.2 test SHA-256 |
| C.2 stability evidence retained | 20/20 additional transition cycles, 22 visual assertions across two fixtures, 136/0 check executions |
| PowerShell documentation commands | All 13 Docker guide command blocks parse |
| JavaScript helper syntax and Git whitespace | PASS |
| Protected original-workspace hashes | All 23 unchanged |
| Original project preservation | Same container IDs/start timestamps, healthy; no stop/recreate |
| Docker volume preservation | All 13 pre-existing volumes retained; none created/deleted |

No successful full client/server/DATA/build/backup/reload suite was repeated.
The final browser regression used a disposable container with no network,
fresh synthetic accounts/DB, and only the reviewed test file mounted read-only
plus an ignored evidence directory. Its synthetic fixture was exported before
container removal. Raw receipts remain local under `docker/artifacts/infra01d/`;
they are not published. The original source workspace, stash and user data were
not cleaned, imported, backed up, migrated or otherwise modified.

## Documentation completed

The README provides fresh-clone startup and health checks. The development guide
covers Windows/WSL2, Docker disk relocation, exact environment defaults, reload,
shutdown/recreation, safe cold backup and fresh-volume restore, shared namespace
recovery, port conflicts, read-only storage/low-disk diagnostics, local-only
security boundaries and fresh validation-image builds. Official Docker links
support platform-specific procedures. Environment examples contain no secrets
and require no default startup changes.

## Remaining warnings and recommendation

This is local development only: no production deployment claim is made. A
backend-only replacement requires paired recreation or explicit frontend
recovery; the documented command is required. Browser-held keys and localhost
cookie/origin behavior require separate care from database persistence. Windows
AI tests passed normally in C.1 but retain documented sensitivity under
deliberately slow runtime diagnostics; no unrelated test change was made.
The previous damaged-image incident remains recorded, including validation
integrity checks. Dependency deprecations and validation-image ARG-default
warnings recorded in C are nonfatal. No CI workflow is supplied by this change.

**Recommendation: READY TO MERGE after owner review and any repository-required
checks.** Publication details (commit, remote branch and PR URL) are reported
in the PR and final handoff. Do not merge automatically. No DB-5/DB-6 work starts
with this change.
