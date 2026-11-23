# Primary Docker development: localhost:3001

Decision recorded 2026-11-22 on `bon-fullstack`, HEAD `f27ea89`. The default
Compose project **`secubuzz-` at http://localhost:3001 is the primary development
environment**. Create new development accounts there. The legacy recovery project
on port 3000 is stopped and must not become primary.

## Daily workflow (PowerShell)

Start Docker Desktop with Linux containers, then use the repository root and the
explicit existing project name. These commands use only `compose.yaml`, without
the legacy override:

```powershell
Set-Location 'D:\Project\SecuBuzz-'
docker compose -p secubuzz- -f compose.yaml config --quiet
docker compose -p secubuzz- -f compose.yaml up -d --wait --wait-timeout 180
docker compose -p secubuzz- -f compose.yaml ps
```

Open **http://localhost:3001**, using that exact hostname and port. Register your
own synthetic test account, sign in, and enroll this browser through the existing
secure-device UI when prompted. For two-user messaging, use different accounts
in separate browser profiles. Keep each profile and this origin for later
encrypted-message access. Do not clear the old port-3000 profile's site data or
copy its encryption keys.

Inspect service logs when needed; redact private information before sharing:

```powershell
docker compose -p secubuzz- -f compose.yaml logs --tail 100 backend frontend
```

Stop the development services while keeping their containers and data:

```powershell
docker compose -p secubuzz- -f compose.yaml stop frontend backend
```

Use the same startup command on the next day. Preserve named volumes
`secubuzz-_sqlite-data` and `secubuzz-_private-storage`. Do not use volume removal,
Docker pruning, database resets, or legacy overrides as routine maintenance.

Frontend `client/src`, `client/public`, and `shared` are already mounted read-only
for development reload. Backend code and dependencies are baked into its image.
After intentional backend/dependency/Dockerfile changes, rebuild explicitly:

```powershell
docker compose -p secubuzz- -f compose.yaml up --build -d --wait --wait-timeout 180
```

The existing optional backend watch workflow is described in
[Docker development](docker-development.md). Backend startup automatically runs
the canonical migration runner. Review new migrations and make a verified cold
backup of both volume roots before starting changed database code; do not run
migrations against host or legacy databases to prepare this environment.

## Current topology

| Component | Primary configuration |
| --- | --- |
| Browser / Next.js | `http://localhost:3001`, published on loopback only |
| DATA authentication and authenticated Socket.IO | Combined backend, internal `127.0.0.1:5000` |
| API and Socket.IO routing | Existing Next proxy, same browser origin |
| DATA Origin allowlist | Exactly `http://localhost:3001` |
| Database / migration ledger | Default SQLite volume, versions 0001–0012 |
| Authenticated encrypted attachment bytes | `encrypted-attachments` inside the SQLite volume |
| Reserved private storage | Separate default private-storage volume |
| LiveKit | No service or credentials supplied by default Compose; calling disabled |

Do not start the old standalone DB5/DB6 server on host port 3001 or a second
Compose project using this port. DATA is not published separately on host port
5000. Keep existing session, Origin, CSRF, membership and E2EE validation enabled.
`127.0.0.1:3001` is a different origin from the configured `localhost:3001`.

## Correction audit and preservation

Before this correction, Git had no tracked or staged changes. The pre-existing
untracked file was `docs/legacy-to-docker-migration-plan.md`. The interrupted work
also left ignored `.cache/phase12d-inspect.cjs`, two Phase-12D inspection
directories, and Phase-12C verification evidence. The inspection script used
superseded primary/rollback labels. No application/Compose changes, Git history
changes, volume remapping, or service recreation were found; both projects still
had their previously recorded container IDs and start times.

This correction stopped only the identity-verified frontend and backend of
`secubuzz-legacy-12c-acc795f3`. Their containers and these volumes remain:

- `secubuzz-legacy-12c-acc795f3-sqlite`
- `secubuzz-legacy-12c-acc795f3-private`

Its current database has **3 registered accounts, 1 conversation and 11 message
records**, including activity later than the original 7-message stash snapshot.
Those later writes were retained. Both databases passed SQLite integrity and
foreign-key checks at schema 12 before the legacy shutdown.

A new cold archive of both stopped legacy volume roots was saved under ignored,
private `docker/backups/phase12d-retired-legacy-KS4Din/`. Its manifest records
SHA-256 checksums and inventory. Both source mounts were read-only. Preserve this
backup, all earlier Phase-12B/12C backups, the host database and its sidecars,
and stash `63aba73fe07e318de6b51ec9cf6fd56b10b4c9d3`. Backups contain private
account material and must not enter Git or shared build contexts.

The cold archive was also extracted into a new isolated validation directory.
Its SQLite integrity, foreign keys and migration ledger passed. All 34 other
table digests match the pre-shutdown inventory, including accounts, messages,
devices, encrypted revisions, pins and wrapped keys. Only transient
`AuthRateLimits` buckets changed during the interval before shutdown; those
buckets are preserved in the cold archive too.

The default containers were not restarted or recreated. Their existing 2
accounts remained intact; one synthetic verification account
`docker12d-afd00240` was added through normal registration. Its generated test
password was kept only in memory, and both test sessions were logged out. Create
your own accounts for daily use. No private browser profile or encryption key was
accessed or changed.

## Verification and remaining work

The focused correction verification passed **28 checks**:

- Internal DATA health and CSRF, frontend login page and proxied CSRF.
- Exact migration names/checksums 0001–0012, SQLite integrity and foreign keys.
- Registration, explicit login, authenticated identity/conversation/device APIs,
  authenticated Socket.IO through the frontend proxy, logout and session denial.
- Anonymous API/Socket.IO denial, missing-CSRF rejection, HttpOnly/SameSite cookie
  protections, and rejection of the old port-3000 Origin by the default backend.
- Fresh isolated Chrome login, reload persistence and UI logout.
- Existing account identities and message/device/key records preserved; exactly
  one new account; post-test integrity and migration ledger unchanged.

Private evidence is under ignored `.cache/phase12d-corrected-WPIkvv/`. This was a
focused environment/authentication check, not a rerun of all messaging suites or
a new two-account E2EE/media acceptance test.

Historical decryption remains a recovery task. Browser key stores are scoped to
the exact origin: old `localhost:3000` keys do not appear at `localhost:3001`.
There is no supported private-key export/import or cross-database account merge.
New port-3001 accounts support new development; they do not recover legacy
history. Cookies are shared across localhost ports, so any later recovery session
must also account for browser profile/session isolation. Restarting legacy
recovery requires a separate explicit decision; it is not part of daily startup.

Authenticated calling remains disabled. Default Compose has no LiveKit service;
server-only credentials, reachable signaling/ICE/TURN infrastructure and real
two-account audio/video delivery verification are still required. See
[authenticated direct calls](authenticated-direct-calls.md); its older host
inventory predates the current Docker installation. Do not enable flags alone or
claim media E2EE.

The existing [Database/Security review](database-security-integration-review.md)
also records A1 (rollback-watermark identity binding) and A2 (stale pin plaintext
cache) as unresolved review blockers. They were not repaired or retested in this
environment correction. Resolve and review them separately before merge approval.
No application code, security protocol, migration, calling implementation or
Compose configuration was modified by this correction.
