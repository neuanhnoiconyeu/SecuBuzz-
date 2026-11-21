# INFRA-01B smoke verification

Date: November 20, 2026. Scope: Docker implementation and focused smoke checks
only. Historical checkpoint before the subsequently accepted INFRA-01C.

## Isolation

- Branch: `feat/infra-01-docker-dev`.
- Checkout: isolated Git worktree on the branch above.
- Base: `d7cd40aafcf8f432d17d3f4a85abb26d19fa9bc3`, matching both cached
  `origin/main` and the read-only remote `refs/heads/main` check before creation.
- Disposable Compose project: `secubuzz-infra01b-mwpe8fih`.
- No pre-existing containers or volumes had this project label before startup.
- Host port 3001 was free; no pre-existing process was stopped.

## Build environment

- Docker Desktop Linux engine: 29.7.2, x86_64.
- Compose: 5.4.0.
- Runtime in both containers: Node v24.20.0, UID 1000.
- Base: `node:24.20.0-bookworm-slim`.
- Verified multi-platform digest:
  `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`.
- Client, server, and DATA Linux `npm ci --include=dev` completed using their
  unchanged lockfiles: 750, 99, and 105 installed packages respectively.
- Docker-only npm policy explicitly allows the required better-sqlite3, argon2,
  and esbuild install scripts and rejects unreviewed lifecycle scripts.

## Results

| Check | Observed result |
| --- | --- |
| Compose configuration | Valid |
| Both development image builds | Passed |
| One-command build/start | `up --build -d --wait --wait-timeout 180` succeeded |
| Backend and frontend health checks | Both healthy |
| Backend startup | One unified `start:data` process, port 5000 |
| Realtime startup | Ready, message delivery enabled by existing DATA integration; call signaling remains disabled |
| Shared namespace | Frontend inspected with `network_mode=container:<backend-id>` |
| Host publication | Only `127.0.0.1:3001:3001`; no published port 5000 |
| Native modules | Both packages' better-sqlite3 loaded and queried independent in-memory databases; DATA argon2 loaded |
| Sibling protocol source | DATA resolved the server's genuine recipient-key verifier |
| Fresh canonical migration ledger | Versions 1, 2, 3, 4, 5, 6, 7, with filenames/checksums matching canonical migration files |
| Database location | `/var/lib/secubuzz/sqlite/database.sqlite` in this project's named volume |
| Journal mode | WAL |
| Accounts | 0; no fixtures or real account data imported |
| Private directory permissions | Both persistent roots writable by UID 1000, mode 0700 |
| Image isolation | No DATA/server host `.env` or historical SQLite/sidecar files present in backend image |
| Frontend filesystem | No database mount or SQLite file |
| Backend health from frontend | HTTP 200 through shared loopback |
| Frontend from host | `/login` HTTP 200, HTML response |
| Unauthenticated API rewrite | `/api/auth/me` HTTP 401 through Next with allowed public Origin |
| Shutdown | Both exit 0; no OOM or Docker state error; backend logged SIGTERM and realtime stop |
| Formatting/helper syntax | `git diff --check` and all three Docker helper syntax checks passed |

No unexpected startup failures appeared in container logs. The unchanged Next.js
proxy stack emits Node's `DEP0060` warning for `util._extend`; installation also
reports existing dependency deprecations. Dependencies/application source were
not updated to suppress them.

The smoke script was piped into each container with explicit
`SECUBUZZ_DOCKER_SMOKE=true` and the corresponding role. Its database connection
was read-only and targeted only the newly created Docker volume. No application
startup/migration module was invoked by the smoke helper itself.

## Preservation and cleanup

The original `chuong-data` status remains one commit ahead of
`origin/chuong-data`, with only its pre-existing modified `client/tsconfig.json`
and untracked Kiro/Phase 8.8 directories. SHA-256 checks of 23 protected files
(the modified tsconfig, Kiro specification, Phase 8.8 artifacts, and existing
server/DATA environment files) matched the pre-implementation snapshot. The
existing stash list is unchanged.

Original host database files were not opened, backed up, imported, or migrated.
The backend had no host bind mounts; build exclusions and the image check
confirmed that historical repository SQLite files were absent from the image.
The approved Git worktree checkout materialized committed repository contents;
those historical files were excluded from Docker inputs.

Only `.gitignore` and README changed among existing tracked files in the new
worktree. All other implementation files are new Docker configuration, helpers,
or documentation. Application source, manifests, lockfiles, migration SQL, Kiro
files, and feature gates were not modified. Nothing was staged, committed,
pushed, or published.

The disposable containers were gracefully stopped. Project cleanup uses `down`
without `-v`, retaining these two volumes:

- `secubuzz-infra01b-mwpe8fih_sqlite-data`
- `secubuzz-infra01b-mwpe8fih_private-storage`

Built project images are also retained. No existing volumes are deleted.

## Deferred to INFRA-01C

Registration/login and browser-profile behavior; authenticated Socket.IO and
encrypted-message flows; reconnect and namespace reattachment after backend
replacement; data persistence across restart/recreation; complete Windows source
reload validation; backup/restore drills; client, server, and DATA regressions.
No full regression or DB-5/DB-6 audit was run.

INFRA-01B result: PASS. Ready for owner-authorized INFRA-01C.
