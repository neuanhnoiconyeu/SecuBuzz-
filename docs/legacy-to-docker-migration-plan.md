# Phase 12B: legacy development data to Docker

> **Primary-environment decision superseded on 2026-11-22:** the default Compose
> project `secubuzz-` at **http://localhost:3001** is primary. The legacy recovery
> project on port 3000 is stopped, with its containers, volumes and backups
> preserved. The historical assessment and migration instructions below remain
> recovery reference only; they do not authorize adopting or restarting legacy as
> primary. Follow [Primary Docker development](docker-daily-development.md) for
> the current daily workflow and correction verification results.

Reviewed 2026-11-22 on `bon-fullstack`, commit `f27ea89`. **Assessment only: no live database, volume, application configuration, Git history or stash was changed.** Only isolated validation copies and this document were created.

Server-side preservation is feasible and was verified on a copy using the actual Linux backend image. Complete historical decryption additionally requires the original browser keys. Preserve the original browser origin/profile instead of attempting to move private keys. Adoption is not yet approved or verified.

## Observed inventory

| Store | Schema | Users / registered accounts | Conversations / messages | Device keys | Attachment records |
| --- | --- | --- | --- | --- | --- |
| Working-tree `DATA/server/database/database.sqlite` plus its sidecars | Unversioned original four-table schema | 1 / 0 | 0 / 0 | None | None |
| Fixed stash `63aba73fe07e318de6b51ec9cf6fd56b10b4c9d3`, database blob | 11 | 4 / 3 | 1 / 7 | 2 active | 0 |
| Docker `secubuzz-_sqlite-data` | 12 | 2 / 2 | 0 / 0 | 0 | 0 |
| Standalone `server/data/yahoo_messenger.db` plus sidecars | Separate DB5/DB6 schema, no canonical migration ledger | 0 / 0 | 0 / 0 | None | 0 |

The **stash is the useful legacy source**, not the current 4 KiB working-tree database. Its database blob is 581,632 bytes; WAL/SHM paths are absent from that stash tree, not nonempty recoverable sidecars. The stored database opens correctly without them. All seven messages are active authenticated V2 envelopes. It also contains one signed conversation epoch, two recipient wraps, 11 receipts, one friendship, three credential records, seven sessions and associated profile/audit metadata. These are a point-in-time inventory, not proof that no later messages existed elsewhere.

Both current Docker containers are healthy: `secubuzz--backend-1` and `secubuzz--frontend-1`, Compose project `secubuzz-`. Its volumes are:

- `secubuzz-_sqlite-data` mounted at `/var/lib/secubuzz/sqlite`.
- `secubuzz-_private-storage` mounted at `/var/lib/secubuzz/attachments`.

The Docker and legacy registered-account identities are disjoint. No username/email-key collision was detected, but that does **not** establish that merging independent databases is supported. Preserve the current Docker accounts in their existing volumes.

## Compatibility and verification performed

- Legacy ledger 0001–0011 exactly matches the current migration prefix. Docker ledger 0001–0012 matches current code, including names/checksums. No ledger reconciliation or checksum rewriting is needed.
- A copy of the stashed database passed migration 0012 only, repeat-run idempotency, FK/integrity checks and schema comparison with the running Docker database. All **29 pre-existing application tables** retained identical typed row digests; the ledger retained its original prefix and gained row 12.
- An injected failure in an isolated copy of migration 0012 rolled back schema and data completely; correcting that test copy and retrying succeeded.
- The same version-11 data was copied into a disposable Linux container using the actual backend image, Node **24.20.0**, with no existing volumes mounted. It upgraded to 12, preserved those 29 tables and passed integrity/FK checks. The container was removed automatically. Existing host/Docker databases were never migration targets.
- A second disposable container successfully checked the upgraded copy through a read-only mount, confirming the proposed read-only validation access pattern.
- Four fresh-browser sentinel checks confirmed separate IndexedDB storage for different localhost ports, persistence after same-origin reload, and shared cookies across localhost ports. No real browser profile, account or private key was accessed.
- An **unapplied** candidate Compose override was validated with `config --quiet`; its proposed volume names were confirmed absent. No pilot volumes or application containers were created.

Private inspection evidence and disposable databases are under ignored `.cache/phase12b-e2f8p1/`. Database copies contain credential hashes and private account metadata; keep them out of Git, Docker build contexts and shared reports. Only counts/digests were reported. This review did not verify real-account login or decrypt the seven historical messages.

## E2EE and browser origin

Relevant implementation: [devices.ts](../client/src/security/e2ee/devices.ts), [storage.ts](../client/src/security/e2ee/storage.ts), and [session.ts](../client/src/security/e2ee/session.ts).

Device signing/agreement private keys and cached AES conversation keys are non-extractable `CryptoKey` objects in account-scoped records of origin-scoped IndexedDB `secubuzz-e2ee-v1`. The server holds public device registrations and recipient-wrapped epochs. A historical wrap must match both the original user ID and device-key ID.

`http://localhost:3000` and `http://localhost:3001` are different storage origins, even in one browser profile. Copying SQLite does not transfer private keys. A new enrollment on 3001 can support future messages after normal key review; it does not grant old epoch keys. There is no supported cross-origin private-key export/import, recovery or device-linking workflow in the current implementation. Do not copy browser key stores, clear site data, change storage identifiers, reset rollback watermarks or bypass enrollment to make history appear.

**Recommended route:** serve the restored Docker frontend at the exact original URL, presumed `http://localhost:3000`, in each participant's original browser profile. Docker can publish host 3000 to the existing internal frontend port 3001. Set its DATA allowed origin to that exact public origin. Preserve account IDs, message IDs, devices, epochs, wraps and ciphertext unchanged. If the actual old URL was `http://127.0.0.1:3000`, HTTPS or another port, use that exact origin instead and revalidate the override. The original URL/profile and continued key availability still need user confirmation.

Keeping the origin also preserves local Delete for Me preferences, revision watermarks and other browser-local state. Cookies are host/path scoped rather than port scoped: two localhost deployments use the same session-cookie names. Use a separate browser profile for the existing 3001 Docker deployment; use the original key-bearing profile only for the restored legacy deployment. Re-login normally if necessary; do not assume old sessions are still valid.

## Attachment and voice preservation

The authenticated encrypted binary directory defaults to `<directory containing DB_PATH>/encrypted-attachments`, not `ATTACHMENT_STORAGE_DIR`. Therefore Docker's authenticated files belong at `/var/lib/secubuzz/sqlite/encrypted-attachments`, inside **sqlite-data**. `/var/lib/secubuzz/attachments` is the separately reserved private-storage volume. Legacy's default encrypted directory is `DATA/server/database/encrypted-attachments`; it is absent. `server/private-attachments` exists and is empty. Both Docker storage directories are also empty.

For this fixed stash, zero attachment rows and zero available files means no associated persisted media payload needs copying. Encrypted message content was not decrypted/classified. Future snapshots containing media must copy the entire matching encrypted directory with the ledger, preserving storage-key filenames and bytes; validate ready-file lengths and ciphertext SHA-256 values. Voice uses the same attachment ledger/store and needs no separate conversion. Preserve lifecycle/expiry/tombstone metadata; do not revive purged/unsent files. Browser Demo blobs are separate local data, not an authenticated server-file export.

## Procedure for a later, explicitly authorized migration

**None of the modifying commands below was executed.** Keep the current Docker volumes, host databases and stash intact throughout.

1. Confirm the fixed stash is the intended latest legacy dataset: 3 registered accounts, 1 conversation and 7 messages. If more records/media are expected, locate the newer source before proceeding. For a live-host source instead, gracefully stop its identified writers and close all SQLite connections before copying the complete DB directory/sidecars and corresponding binary directories. Never copy just a live main database file. Do not stop unrelated Node processes.
2. Preserve the existing Docker project separately. For an immutable backup, follow the [cold-backup procedure](docker-development.md#cold-backup-commands-powershell) for **project `secubuzz-`** and archive both original volume roots. Do not restore anything over them. This backup/stop operation remains future work.
3. Recover the fixed stash into a **new private backup directory**, without applying/popping the stash. Use binary-safe extraction; PowerShell text redirection is unsuitable for SQLite blobs. Produce a clean SQLite backup from that immutable recovered copy. The following recipe is for the inspected fixed stash with no attachment rows:

```powershell
Set-Location 'D:\Project\SecuBuzz-'
$migrationRoot = Join-Path (Get-Location) ('docker/backups/legacy-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$migrationRoot/sqlite", "$migrationRoot/private-storage" | Out-Null
@'
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const Database=require('./DATA/node_modules/better-sqlite3');
(async()=>{
  const root=path.resolve(process.argv[2]);
  const raw=path.join(root,'legacy-from-stash.sqlite');
  const snapshot=path.join(root,'sqlite/database.sqlite');
  if(fs.existsSync(raw)||fs.existsSync(snapshot))throw Error('Refusing to overwrite a backup');
  const bytes=cp.execFileSync('git',['show','63aba73fe07e318de6b51ec9cf6fd56b10b4c9d3:DATA/server/database/database.sqlite'],{maxBuffer:64*1024*1024});
  fs.writeFileSync(raw,bytes,{flag:'wx'});
  const db=new Database(raw,{readonly:true,fileMustExist:true});
  try { await db.backup(snapshot); } finally { db.close(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
'@ | node - $migrationRoot
if ($LASTEXITCODE -ne 0) { throw 'Snapshot creation failed' }
tar -C "$migrationRoot/sqlite" -cf "$migrationRoot/sqlite.tar" .
if ($LASTEXITCODE -ne 0) { throw 'SQLite archive failed' }
tar -C "$migrationRoot/private-storage" -cf "$migrationRoot/private-storage.tar" .
if ($LASTEXITCODE -ne 0) { throw 'Private-storage archive failed' }
Get-FileHash "$migrationRoot/sqlite.tar", "$migrationRoot/private-storage.tar" -Algorithm SHA256
```

4. Revalidate that backup's integrity, ledger prefix, counts and all-table digests against the reviewed source. Record the stash/code revisions, image IDs, origin/profile plan and archive checksums. For any other/newer source, redo inventory and include its actual binaries; do not use an empty media archive by assumption.
5. Choose a separate project and **fresh external volumes**. The review-only override `.cache/phase12b-e2f8p1/restore-origin3000.review.yaml` pins the inspected backend/frontend image IDs, replaces published ports with `127.0.0.1:3000:3001`, sets the matching allowed origin, and references the two new volume names below. It is not part of the application configuration and has not been applied. Review it before use; change hostname if the actual old origin differs.

Its validated contents are reproduced here so the plan does not depend on retaining an ignored artifact. The pinned images must still exist locally; otherwise rebuild/review the matching code revision before proceeding.

```yaml
services:
  backend:
    image: sha256:c05933509aede80bf9afa123fa12a38597ba9c7fbd48bd5bc3d556734ef11ae7
    ports: !override
      - "127.0.0.1:3000:3001"
    environment:
      AUTH_ALLOWED_ORIGINS: http://localhost:3000
  frontend:
    image: sha256:5a20037f94419f92135c4b94b8ca91a67cb63a982cb5fe2db6fbf2c5bf07c8c4
volumes:
  sqlite-data:
    external: true
    name: secubuzz-legacy-pilot-20261122-sqlite
  private-storage:
    external: true
    name: secubuzz-legacy-pilot-20261122-private
```

```powershell
$project = 'secubuzz-legacy-pilot-20261122'
$sqliteVolume = 'secubuzz-legacy-pilot-20261122-sqlite'
$privateVolume = 'secubuzz-legacy-pilot-20261122-private'
$helperImage = 'sha256:c05933509aede80bf9afa123fa12a38597ba9c7fbd48bd5bc3d556734ef11ae7'
$override = '.cache/phase12b-e2f8p1/restore-origin3000.review.yaml'
$existing = @(docker volume ls --format '{{.Name}}')
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing volumes' }
if (($existing -contains $sqliteVolume) -or ($existing -contains $privateVolume)) { throw 'Choose NEW volume names and update the override' }
docker compose -p $project -f compose.yaml -f $override config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Invalid pilot configuration' }
docker volume create --label secubuzz.migration=phase12b $sqliteVolume
if ($LASTEXITCODE -ne 0) { throw 'Volume creation failed' }
docker volume create --label secubuzz.migration=phase12b $privateVolume
if ($LASTEXITCODE -ne 0) { throw 'Volume creation failed; retain any already created volume' }
docker run --rm --pull never --network none --user 0:0 --entrypoint tar --mount "type=volume,source=$sqliteVolume,target=/restore" --mount "type=bind,source=$migrationRoot,target=/backup,readonly" $helperImage --no-same-owner -C /restore -xpf /backup/sqlite.tar
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; do not start the pilot' }
docker run --rm --pull never --network none --user 0:0 --entrypoint tar --mount "type=volume,source=$privateVolume,target=/restore" --mount "type=bind,source=$migrationRoot,target=/backup,readonly" $helperImage --no-same-owner -C /restore -xpf /backup/private-storage.tar
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; do not start the pilot' }
foreach ($volume in @($sqliteVolume,$privateVolume)) {
  docker run --rm --pull never --network none --user 0:0 --entrypoint chown --mount "type=volume,source=$volume,target=/restore" $helperImage -R 1000:1000 /restore
  if ($LASTEXITCODE -ne 0) { throw 'Ownership validation required' }
  docker run --rm --pull never --network none --user 0:0 --entrypoint chmod --mount "type=volume,source=$volume,target=/restore" $helperImage 0700 /restore
  if ($LASTEXITCODE -ne 0) { throw 'Permissions validation required' }
}
docker run --rm --pull never --network none --user 0:0 --entrypoint chmod --mount "type=volume,source=$sqliteVolume,target=/restore" $helperImage 0600 /restore/database.sqlite
if ($LASTEXITCODE -ne 0) { throw 'Database permissions validation required' }
```

6. Confirm the new volume names/labels and that no application is attached to them. Validate the restored **version-11** data read-only first. Then run migrations **only against the new volume**. This should append Groups 0012, preserving all existing rows. Before starting the application, compare the 29 original table digests and original ledger prefix with the source; verify 12 ordered checksummed migrations, integrity/FKs, 4 users / 3 credentials / 1 conversation / 7 messages / 2 devices / 1 epoch / 2 wraps and no missing files. Do not compare mutable session/audit/last-seen hashes after interactive login as if they were immutable content.

```powershell
foreach ($volume in @($sqliteVolume,$privateVolume)) {
  if (@('secubuzz-_sqlite-data','secubuzz-_private-storage') -contains $volume) { throw 'Refusing an original Docker volume' }
  $labels = docker volume inspect $volume --format '{{json .Labels}}' | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $labels.'secubuzz.migration' -ne 'phase12b') { throw 'Unverified migration target volume' }
  $attached = @(docker ps -a -q --filter "volume=$volume")
  if ($LASTEXITCODE -ne 0 -or $attached.Count -gt 0) { throw 'Target volume has an attached container; stop and review' }
}
docker run --rm --pull never --network none --read-only --user 1000:1000 --entrypoint node -e DB_PATH=/var/lib/secubuzz/sqlite/database.sqlite --mount "type=volume,source=$sqliteVolume,target=/var/lib/secubuzz/sqlite" $helperImage /workspace/DATA/scripts/migrate.js
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; retain all sources and inspect the new volume' }
Get-Content -Raw docker/database-check.cjs | docker run --rm -i --pull never --network none --read-only --user 1000:1000 --entrypoint node -e SECUBUZZ_DOCKER_VALIDATION=true -e DB_PATH=/var/lib/secubuzz/sqlite/database.sqlite --mount "type=volume,source=$sqliteVolume,target=/var/lib/secubuzz/sqlite,readonly" $helperImage --input-type=commonjs
if ($LASTEXITCODE -ne 0) { throw 'Read-only restored database checks failed' }
```

7. Once all data comparisons pass and the original host frontend has released port 3000, start only the pilot. Do not change the existing `secubuzz-` project/volume mappings:

```powershell
docker compose -p $project -f compose.yaml -f $override up -d --no-build --pull never --wait --wait-timeout 180
```

8. Sign in through the normal UI in each original key-bearing browser profile. Confirm the expected account identities, active devices, conversation and **all seven historical messages decrypt** without unexpected enrollment or key-change prompts. Verify refresh/logout/login persistence and reconnection. If media is ever present in a newer source, verify authenticated decrypt/playback/download and hashes too. Stop if enrollment is requested unexpectedly or old history fails: check origin/profile/account/snapshot freshness, not private-key or watermark edits. Keep the pilot free of new messages/edits/uploads until adoption is decided. Current Docker accounts should use a separate browser profile to avoid cookie interference.

## Rollback and blockers

- Before adoption, stop only the pilot if a check fails; retain its volumes and evidence. Original host files, stash and original Docker volumes remain available. Do not run `down -v`, prune, overwrite volumes or restore into a running database.
- After new writes are accepted, the pilot is a newer data generation. Snapshot its current DB and binary roots before any rollback; never resume an older snapshot for writes while assuming new messages were preserved. A no-loss runtime fallback must use the latest compatible data in another new location. Older version-11 code rejects a version-12 ledger; no destructive down migration exists.
- Do not restart host DATA with its default working-tree database expecting the stashed legacy accounts: that file is a different, nearly empty store. A later host-runtime fallback would require an explicitly configured, separately restored new data location, never a stash application or overwrite of the existing file.
- **Remaining blockers:** confirmation that the fixed stash is the complete desired source; original URL/profile and intact matching private keys; actual normal-login and historical-decryption acceptance on the restored pilot; and an explicit adoption decision about the two independent account sets. None was bypassed or claimed complete here.
- **Account-set merging is unsupported.** There is no canonical cross-database account/history importer. Do not use `ATTACH`, row replacement, ID remapping, disabled FKs/triggers or manual key-table edits to combine the stores. Keep both deployments/backups, or obtain a separately designed Database/Security import contract.
- If the original keys are lost, no supported recovery path can guarantee decrypting this history from SQLite alone. Database bytes can still be preserved, but readable historical content cannot be promised.

The safe next phase is an authorized restore into the proposed fresh pilot volumes with the original browser origin preserved. This review performed no actual migration or adoption.
