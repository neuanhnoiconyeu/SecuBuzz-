# Docker development

This development environment runs Next.js and the unified DATA HTTP/Socket.IO
backend in two Linux containers. Docker data is separate from host development
data. Existing non-Docker commands and environment files remain unchanged.

## Start

Install Docker Desktop, select Linux containers, and start its engine. From a
fresh clone's repository root:

```powershell
docker info
docker compose version
docker compose config --quiet
docker compose up --build -d --wait --wait-timeout 180
docker compose ps
```

Open **http://localhost:3001** after both services become healthy. Use that exact
hostname: the Origin allowlist is `http://localhost:3001`. Host Node.js, npm
installs, copied environment files, secrets, and database imports are not needed.
Initial image builds need registry, npm, and Debian package-network access.
If port 3001 is occupied, identify its owner; do not stop unrelated processes.

```powershell
docker compose logs --tail 80 backend frontend
docker compose stop
docker compose start
docker compose down
```

`down` removes this project's containers/network and preserves its named volumes.
Do not add `-v`: that deletes the database and private-storage volumes. Use a
consistent project name across starts to retain the same data. Do not run a
second project on host port 3001 concurrently.

On first use, register a synthetic development account, then sign in explicitly
and enroll this browser when prompted. Enrollment creates browser-held keys;
database persistence alone does not back up those keys. Use a second separate
browser profile/account for local multi-user checks. Never import real user
data for onboarding. Keep the same checkout, Compose project name and browser
profile/origin when returning to an existing environment.

## Windows Docker Desktop and WSL2

Install a currently supported Docker Desktop for Windows with WSL2 and hardware
virtualization available. Select the WSL2 engine in Settings > General and Linux
containers. Check `wsl --version` and `wsl --list --verbose` in PowerShell.
PowerShell works without a separate Linux distribution; for a WSL terminal,
enable the chosen distribution under Settings > Resources > WSL Integration.
See the official [Windows installation guide](https://docs.docker.com/desktop/setup/install/windows-install/)
and [WSL2 backend guide](https://docs.docker.com/desktop/features/wsl/).

Keep a clone either on the Windows drive for PowerShell or in the chosen WSL
filesystem for Linux tooling, and run Compose from that clone's root. Avoid
alternating Windows and WSL package installs in one directory. Docker installs
dependencies inside Linux images; host `node_modules` never enters the build.
Windows source mounts use polling; backend changes can use Compose Watch.

### Move Docker storage to another drive

Moving the repository does not move Docker images, build cache or named volumes.
Before relocation, arrange downtime with owners of every Docker project and
make verified volume backups. In Docker Desktop, use Settings > Resources >
Advanced > Disk image location to choose an empty folder on the destination
drive, then apply the change and let Desktop complete the move/restart.
Do not replace an existing disk image at the destination. UI availability varies
by backend/version; follow [Docker's storage settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
and the WSL2 guide above for the selected backend rather than moving live files.

Afterward, run `docker info`, `docker volume ls` and `docker compose ps`; confirm
the same volumes, container health and synthetic application history. Keep the
verified backup until recovery is confirmed. If Desktop cannot start, fully
quit it before copying the configured VM disk to a separate safe location; use
the backend-specific [Docker Desktop backup procedure](https://docs.docker.com/desktop/settings-and-maintenance/backup-and-restore/).
Do not unregister Docker WSL distributions, edit internal storage directories,
reset Desktop or delete volumes as a relocation shortcut. No storage relocation
is performed by this repository's scripts.

## Topology and security

The backend owns a project bridge network and publishes only
`127.0.0.1:3001:3001`. The frontend uses `network_mode: service:backend` and listens
on `0.0.0.0:3001` inside that namespace. DATA binds `127.0.0.1:5000`; port 5000 is
not published. Inspect backend port mappings to see the frontend publication.

The backend command remains `npm --prefix server run start:data`, which starts
DATA HTTP and authenticated Socket.IO in one process. There is no separate DATA,
standalone realtime, DB5/DB6 API, database-server, or cache service.

Next's unchanged proxy uses `AUTH_BACKEND_URL=http://127.0.0.1:5000`. Browser API
and Socket.IO traffic remain on the frontend origin. The existing exact API
rewrites and `/socket.io` to `/socket.io/` mapping are retained. Shared loopback
communication satisfies both the proxy validator and backend transport checks.
Never substitute an HTTP Docker service hostname or relax security validation.

The existing explicit local HTTP option, exact Origin allowlist, HttpOnly session
cookies, CSRF proofs, authorization, and reconnect behavior are preserved. No
TLS-proxy addresses are trusted. This configuration is for local development;
production requires a separately reviewed HTTPS deployment.

The frontend and backend share networking, not filesystems. The frontend has no
database or attachment mount. Port 3000 and port 3001 have separate browser
IndexedDB stores, so an existing non-Docker device key does not automatically
appear here. Cookies are scoped by host/path rather than port: concurrent
localhost instances may affect each other's session cookies. Use separate browser
profiles when testing both workflows.

## Images and environment

Both root-context Dockerfiles pin `node:24.20.0-bookworm-slim` by its immutable
multi-platform digest. Independent Linux `npm ci --include=dev` installs use the
unchanged client, server, and DATA lockfiles. Native dependencies are never copied
from Windows. The backend includes compiler fallback for native installations.
The image's npm install policy allows only `better-sqlite3`, `argon2`, and
`esbuild` lifecycle scripts; unreviewed install scripts fail the build. This
Docker-only configuration does not change application manifests or lockfiles.

The base digest and JavaScript dependency graphs are fixed, but Debian package
repositories and native prebuild availability are external build inputs. Builds
require network access and are not claimed to be bit-for-bit identical or an
offline supply-chain archive. Update the pinned base deliberately after review.

Compose supplies development defaults explicitly. It does not load client,
server, or DATA host environment files into containers. The build allowlist and
exclusions omit actual environment files, secret files, databases/sidecars,
private uploads, dependencies, generated output, evidence, and nested worktrees.
Keep future secret locations excluded as well. No Docker environment template is
needed for the default one-command startup.

[`docker/compose.env.example.yaml`](../docker/compose.env.example.yaml) is an
optional, non-secret reference of the same explicit defaults. It is not a
required environment file. Validate it without starting another project:

```powershell
docker compose -f compose.yaml -f docker/compose.env.example.yaml config --quiet
```

If using that override for startup, repeat both `-f` options on every lifecycle
command. A root `.env` can still affect Compose's own CLI variables such as
`COMPOSE_PROJECT_NAME`; keep private CLI settings local and choose the intended
project explicitly with `-p` when needed. Host application `.env` files are not
injected. Use the checked-in example, not a copy of real credentials.

Key settings:

| Setting | Docker value |
| --- | --- |
| `NODE_ENV` | `development` |
| `DATA_ROOT` | `/workspace/DATA` |
| `HOST` / `PORT` | `127.0.0.1` / `5000` |
| `DB_PATH` | `/var/lib/secubuzz/sqlite/database.sqlite` |
| `DB_BUSY_TIMEOUT_MS` | `5000` |
| `AUTH_ALLOWED_ORIGINS` | `http://localhost:3001` |
| `AUTH_ALLOW_HTTP_LOCAL` | `true`, as already supported for loopback development |
| `AUTH_SESSION_TTL_SECONDS` | `28800` |
| `AUTH_TRUST_PROXY_IPS` | empty |
| `AUTH_BACKEND_URL` | `http://127.0.0.1:5000`, frontend server only |
| `ATTACHMENT_STORAGE_DIR` | `/var/lib/secubuzz/attachments`, reserved |

Existing independent realtime-contract, attachment, LiveKit, and AI gates remain
disabled. The authenticated DM workspace uses the browser's own origin directly.
No groups or canonical attachment implementation/migrations are supplied here.
Optional AI/LiveKit credentials are not required or injected. Never place secrets
in `NEXT_PUBLIC_*` settings. Production Next builds freeze public settings at
build time; changing a runtime environment alone cannot update those bundles.

## Source reload and shutdown

The frontend mounts only `client/src`, `client/public`, and `shared` read-only.
Watchpack polling supports Windows bind mounts. Next's output, generated types,
and any tsconfig adjustments remain in the container, not the checkout. Changes
to package manifests, locks, root configuration, Dockerfiles, or helpers need
`docker compose up --build -d` again.

For optional backend source reload, use a second terminal:

```powershell
docker compose watch backend
```

Use a recent Compose supporting `sync+restart` and `initial_sync`; this setup was
validated with Compose 5.4.0. See the [Compose Develop specification](https://docs.docker.com/reference/compose-file/develop/).
The watch rules copy `server/src`, DATA server code/migrations, and `shared` into
the container and restart the same unified command. Database files are excluded;
no DATA directory is bind-mounted. Stop watching before rebuilding images.
Migration edits belong only to separately approved database work. Native modules
and dependency directories must never be synced or shared across operating systems.

Both containers run as `node` (UID 1000). Empty data volumes inherit the image's
node-owned, mode-0700 directories. Existing volumes with incompatible ownership
fail rather than being recursively changed by a privileged entry point. Docker
init reaps children; a Docker-only launcher forwards SIGTERM/SIGINT to the npm
process group, with a 30-second stop grace period.

The frontend depends on backend health, and explicit Compose dependency restarts
propagate to it. INFRA-01C verified that `restart backend` recovers automatically,
but replacing only the backend leaves the frontend attached to the old container
ID. Replace both services together:

```powershell
docker compose up -d --no-build --force-recreate --wait
```

If the backend has already been replaced, recreate only the frontend against its
current namespace:

```powershell
docker compose up -d --no-deps --no-build --force-recreate --wait frontend
```

Both procedures preserve named volumes. Do not rely on `depends_on.restart` to
change an existing frontend container's network namespace.

Use the same project name and Compose files used to create that environment
(`-p` / `-f`, when applicable). Allow a brief development outage during
replacement. Do not remove volumes to repair the namespace. After recovery,
verify the backend from the frontend's loopback namespace as well as frontend
health:

```powershell
docker compose exec -T frontend node /workspace/docker/healthcheck.cjs backend
```

The frontend health check requests `/login`; that alone does not prove its API
proxy can reach the current backend. INFRA-01C.1 reproduced the stale attachment
and verified the frontend-only recovery above in a separate project with no
published host ports. No authentication, encryption or database changes are
needed for this lifecycle procedure.

## Data and future migrations

Project-scoped `sqlite-data` stores the database plus WAL/SHM sidecars under one
directory. `private-storage` reserves a separate non-public attachment root.
Neither volume is seeded from the repository's tracked historical database.
Do not mount or import the existing host database as a convenience.

The unchanged canonical DATA connection applies its transactional, checksummed
migrations before serving requests. INFRA-01B contains versions 0001 through 0007.
Future approved migrations 0008/0009 use the same runner and persistent path;
this work does not implement them or enable their features. Migration failure
stops startup; never initialize from legacy `schema.sql` or rewrite the ledger.

For backups, stop all application writers and close connections, then archive
the entire SQLite volume directory with ownership and any sidecars present.
When attachments become active, capture a coordinated private-storage backup.
Record the application revision and migration version. Do not copy only a live
main database file. Restore first into fresh volumes while services are stopped,
restore ownership, and validate integrity, foreign keys, migration compatibility,
and application data before adopting the restore. Older code rejects newer
migration histories. INFRA-01C verified cold archives of both disposable volumes,
restoration into fresh volumes, integrity/FK checks, matching migration history,
matching records and browser decryption. Online backup tooling is not supplied.
No host development database should be used for validation.

### Cold backup commands (PowerShell)

Run from the intended project's checkout. Set the actual project name explicitly;
do not use these commands to stop another developer's project. This procedure
stops both application writers and archives **both complete volume roots** using
the already-built backend image's GNU tar. It does not pipe binary archives
through PowerShell. Keep the resulting directory private and outside Git.
This follows Docker's [volume backup/restore approach](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes).

```powershell
$project = 'your-existing-compose-project'
$backendId = docker compose -p $project ps -q backend
if (-not $backendId) { throw 'Select an existing running project first.' }
$backend = (docker inspect $backendId | ConvertFrom-Json)[0]
$helperImage = $backend.Image
$sqliteVolume = ($backend.Mounts | Where-Object Destination -eq '/var/lib/secubuzz/sqlite').Name
$privateVolume = ($backend.Mounts | Where-Object Destination -eq '/var/lib/secubuzz/attachments').Name
if (-not $sqliteVolume -or -not $privateVolume) { throw 'Expected named mounts missing.' }
$backup = Join-Path (Get-Location) ('docker/backups/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup | Out-Null
$revision = git rev-parse HEAD
@{ project=$project; revision=$revision; image=$helperImage; sqlite=$sqliteVolume; private=$privateVolume } |
  ConvertTo-Json | Set-Content (Join-Path $backup 'metadata.json')

docker compose -p $project stop --timeout 30
if ($LASTEXITCODE -ne 0) { throw 'Stop failed; do not archive active writers.' }
try {
  docker run --rm --network none --user 0:0 --entrypoint tar --mount "type=volume,source=$sqliteVolume,target=/volume,readonly" --mount "type=bind,source=$backup,target=/backup" $helperImage --numeric-owner -C /volume -cpf /backup/sqlite.tar .
  if ($LASTEXITCODE -ne 0) { throw 'SQLite archive failed.' }
  docker run --rm --network none --user 0:0 --entrypoint tar --mount "type=volume,source=$privateVolume,target=/volume,readonly" --mount "type=bind,source=$backup,target=/backup" $helperImage --numeric-owner -C /volume -cpf /backup/private-storage.tar .
  if ($LASTEXITCODE -ne 0) { throw 'Private-storage archive failed.' }
  Get-FileHash (Join-Path $backup 'sqlite.tar'), (Join-Path $backup 'private-storage.tar') -Algorithm SHA256 |
    Format-List | Out-File (Join-Path $backup 'checksums.txt')
} finally {
  docker compose -p $project start --wait --wait-timeout 180
}
```

Use the same `-f` options if the project uses overrides. Check both archive
commands succeeded even if the restart succeeds. Backups may contain credentials
and ciphertext metadata; do not publish them. Record the canonical migration
versions associated with the saved revision, and retain that revision/image.
Recover browser keys separately using existing supported browser/key workflows;
a database archive is not an export of browser-held private keys.

### Restore into new volumes first (PowerShell)

Continue with `$backup` and `$helperImage` from the successful backup above, or
load those values from your private metadata. Use a checkout matching the saved
application/migration revision. Inspect trusted archives and their SHA-256 values
before extracting them. Never extract over the source volumes or a running DB.

```powershell
$restoreProject = 'secubuzz-restore-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$restoredSqlite = "${restoreProject}_sqlite-data"
$restoredPrivate = "${restoreProject}_private-storage"
$existingVolumes = @(docker volume ls --format '{{.Name}}')
if ($existingVolumes -contains $restoredSqlite -or $existingVolumes -contains $restoredPrivate) {
  throw 'Choose fresh restore volume names.'
}
docker volume create $restoredSqlite
if ($LASTEXITCODE -ne 0) { throw 'Volume creation failed.' }
docker volume create $restoredPrivate
if ($LASTEXITCODE -ne 0) { throw 'Volume creation failed.' }
docker run --rm --network none --user 0:0 --entrypoint tar --mount "type=volume,source=$restoredSqlite,target=/volume" --mount "type=bind,source=$backup,target=/backup,readonly" $helperImage --numeric-owner --same-owner -C /volume -xpf /backup/sqlite.tar
if ($LASTEXITCODE -ne 0) { throw 'SQLite restore failed.' }
docker run --rm --network none --user 0:0 --entrypoint tar --mount "type=volume,source=$restoredPrivate,target=/volume" --mount "type=bind,source=$backup,target=/backup,readonly" $helperImage --numeric-owner --same-owner -C /volume -xpf /backup/private-storage.tar
if ($LASTEXITCODE -ne 0) { throw 'Private-storage restore failed.' }
Get-Content -Raw docker/database-check.cjs | docker run --rm -i --network none --user 1000:1000 --entrypoint node -e SECUBUZZ_DOCKER_VALIDATION=true -e DB_PATH=/var/lib/secubuzz/sqlite/database.sqlite --mount "type=volume,source=$restoredSqlite,target=/var/lib/secubuzz/sqlite" $helperImage --input-type=commonjs
if ($LASTEXITCODE -ne 0) { throw 'Restored DB integrity/ledger/permissions check failed.' }
```

That read-only database check validates integrity, foreign keys, canonical
migration names/checksums, private directory mode and record hashes/counts
without opening the source DB. Compare the records with your expected snapshot.
Confirm both restored volume roots retain UID 1000 and mode 0700 before startup.
Do not downgrade code across an incompatible migration history.

Only after review should a separate Compose project use these volumes. Its name
must be `$restoreProject`, or its volume mappings must explicitly name these
volumes. Use the matching images/revision, and a no-published-port override while
the original project owns port 3001. Verify both health paths, authenticated
history and browser decryption before adopting a restore. Retain both source
and restored volumes throughout review. INFRA-01C's complete restore drill is
the existing evidence for that application-level verification.

## Troubleshooting

### Port 3001 is already in use

```powershell
docker ps --filter publish=3001 --format '{{.Names}} {{.Ports}}'
Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess
docker compose ls
```

Identify whether your intended project is already running before starting
another one. Do not kill unrelated processes or stop someone else's project.
Changing the browser port also affects the exact Origin allowlist and browser
key storage; changing only the published port is not a supported quick fix.

### Read-only filesystem, engine failures or low disk space

```powershell
docker info
docker system df -v
docker volume ls
Get-PSDrive -PSProvider FileSystem
docker compose logs --tail 80 backend frontend
```

Read-only source bind mounts are intentional; Next's generated output belongs
inside the frontend container. A permission error on a data volume is different:
inspect its ownership and stop before changing permissions or importing files.
Do not recursively chmod/chown existing user data as a generic fix.

Read-only errors in Docker's metadata/snapshot filesystem, missing engine pipes
or unexpectedly empty image files indicate an engine/storage problem. Stop
validation and preserve volumes. Check free space on the drive holding Docker's
disk image as well as the repository drive. Arrange a coordinated Desktop
restart only after other project owners approve its downtime. Use Desktop's
diagnostics and [troubleshooting guidance](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/);
do not reset, prune volumes or unregister WSL to make the error disappear.

Recheck `docker info`, expected volumes and project health after recovery. For a
suspect image, check non-empty `/etc/passwd` and the appropriate package manifest
with a network-isolated helper container before trusting its exit code. Rebuild
only the damaged image from the reviewed Dockerfile once storage is healthy;
an empty runner that exits 0 is not a passing test. No automatic cleanup or
destructive recovery command is supplied here.

### Security and support boundary

This environment uses explicit local HTTP, development servers and one shared
network namespace. Keep it on the loopback interface; do not expose it to the
LAN, deploy it to production or remove Origin/CSRF/transport checks. Production
needs a separately reviewed HTTPS, secrets, deployment and backup design.
Private storage is reserved, not an enabled attachment feature. No DB-5/DB-6
implementation or new migrations are included. Browser-context keys and
localhost cookies have the origin/port limitations described above.

## Focused INFRA-01B smoke checks

Use a unique disposable project name and keep it identical for all commands:

```powershell
$smokeProject = 'secubuzz-infra01b-' + [guid]::NewGuid().ToString('N').Substring(0,8)
docker compose -p $smokeProject config --quiet
docker compose -p $smokeProject up --build -d --wait --wait-timeout 180
Get-Content -Raw docker/smoke.cjs | docker compose -p $smokeProject exec -T -e SECUBUZZ_DOCKER_SMOKE=true -e SECUBUZZ_DOCKER_SMOKE_ROLE=backend backend node --input-type=commonjs
Get-Content -Raw docker/smoke.cjs | docker compose -p $smokeProject exec -T -e SECUBUZZ_DOCKER_SMOKE=true -e SECUBUZZ_DOCKER_SMOKE_ROLE=frontend frontend node --input-type=commonjs
docker compose -p $smokeProject logs --tail 80 backend frontend
docker compose -p $smokeProject down
```

The smoke helper requires an explicit opt-in inside Linux, checks non-root
execution and native dependencies, and opens only the configured Docker database
read-only to compare its migration ledger with canonical files. It checks a fresh
zero-account database, WAL, private directory permissions, frontend reachability,
and a 401 through the unchanged API proxy without credentials. It logs only
versions/statuses/counts. It must not be used against populated development data.
The final command preserves this project's volumes; no existing volumes are deleted.

Registration/login, browser keys, authenticated sockets, encrypted messaging,
restart persistence, cold backup/restore and Windows reload were exercised in
INFRA-01C; see its acceptance report for exact results and remaining regressions.
The existing
profile-hotfix browser harness manages a pre-existing port-5000 process; do not
run it unchanged as a Docker smoke test.

Recorded results: [INFRA-01B smoke verification](infra-01b-smoke-results.md).

Further validation: [INFRA-01C acceptance results](infra-01c-acceptance-results.md).
Normal startup needs only Docker. The additional Windows browser acceptance
tools require Node 24, the locked client test dependencies and Chrome. Use a
unique disposable project and `SECUBUZZ_DOCKER_EVIDENCE_DIR` beneath
`docker/artifacts/` to retain independent evidence and browser profiles.

## Build fresh Linux validation images

For a newly approved regression run, build package images without starting a
second Compose project or claiming port 3001. These tags are independent from
your running application's images. Run only the required group; accepted suites
do not need to be repeated for documentation changes.

```powershell
$validationProject = 'secubuzz-validation-' + [guid]::NewGuid().ToString('N').Substring(0,8)
docker compose -p $validationProject build backend frontend
if ($LASTEXITCODE -ne 0) { throw 'Application image build failed.' }
docker build -f docker/validation.Dockerfile --build-arg "FRONTEND_IMAGE=${validationProject}-frontend:latest" --build-arg "BACKEND_IMAGE=${validationProject}-backend:latest" -t "${validationProject}-runner:latest" .
if ($LASTEXITCODE -ne 0) { throw 'Validation image build failed.' }
$evidence = Join-Path (Get-Location) ('docker/artifacts/' + $validationProject)
New-Item -ItemType Directory -Path $evidence | Out-Null
docker run --rm --init --network none --shm-size=1g --mount "type=bind,source=$evidence,target=/evidence" -e SECUBUZZ_DOCKER_VALIDATION=true "${validationProject}-runner:latest" node docker/validate.cjs browser
if ($LASTEXITCODE -ne 0) { throw 'Browser validation failed; inspect private evidence.' }
```

Groups are `client` (units/types/lint/build), `server`, `data`, and `browser`
(existing E2EE and realtime browser scripts). Browser fixtures allocate internal
ports and synthetic databases; they do not use your running Compose DB. Browser
and SQLite fixture artifacts remain private under the ignored evidence path.
The Dockerfile integrity guards must succeed; a damaged/empty test image is not
valid evidence. No host Node installation is needed for these Linux groups.
