# DB-1 migration and operations guide

Use Node 24 (verified with 24.20.0), the existing dependencies and the Database Team workspace:

```powershell
cd D:\Projects\SecuBuzz-\DATA
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm run db:migrate
npm test
```

`DB_PATH` defaults to `server/database/database.sqlite` relative to **DATA/**, regardless of the process working directory. Absolute paths and `:memory:` are supported. This preserves the original `cd DATA` default and makes invocations from the repository root deterministic. `DB_BUSY_TIMEOUT_MS` defaults to 5000, range 0..60000. Each connection enables foreign keys, WAL (memory databases report `memory`) and the configured busy timeout. `DATA/.env` is loaded by the CLI; normal server startup continues to use dotenv. No seeds are loaded. Test fixtures are explicitly called helpers under `tests/support/`.

To target another database explicitly:

```powershell
$env:DB_PATH = 'D:\path\to\database.sqlite'
npm run db:migrate
```

Starting the existing `npm start` also applies pending migrations before mounting routes. The factory `openDatabase({ filename })` does the same; close returned connections when the owning process ends. Importing `connection.js` alone does not open a database. The old `db.js` compatibility singleton opens one connection, owned by the application process.

## Versions and transaction guarantees

| Migration | Behavior |
| --- | --- |
| `0001-legacy.sql` | Exact original four-table schema and indexes, retained as the compatibility baseline. On an accepted legacy database its CREATE IF NOT EXISTS statements leave existing records intact. |
| `0002-foundation.sql` | Adds normalized roadmap entities, profiles/timestamps/validation, relationship backfills, DM membership and shared encrypted messages, receipts, attachment metadata and audit metadata. |

The runner obtains a `BEGIN IMMEDIATE` writer lock, validates existing history, applies **all** pending versions and checks foreign keys within one transaction. Failures roll back the entire pending batch, including the migration ledger and Messages rebuild. Already committed earlier versions remain intact. Success records each version once. Repeating the command reports zero migrations applied.

The ledger verifies SHA-256 checksums (CRLF normalized to LF), filenames and contiguous versions. Do not edit an applied SQL migration; add the next numbered SQL file. Missing, changed, reordered or future ledger entries fail. Migrations must contain transactional SQL only: do not embed BEGIN/COMMIT/ROLLBACK, VACUUM, attach/detach operations or connection pragma changes. Schema failure recovery is tested for exceptions and a process exiting with an open write transaction; this is not a claim of hardware power-loss testing.

The runner leaves foreign keys enabled throughout. The Messages rebuild is safe specifically because the accepted legacy schema has no tables/views/triggers referencing it; new child tables are added after the rebuild. The procedure creates Messages_next, copies validated data, drops the old Messages inside the transaction and renames the replacement. It never drops all tables, erases a database, or disables integrity checks. See SQLite's [table-rebuild guidance](https://www.sqlite.org/lang_altertable.html#otheralter) and [foreign key behavior](https://www.sqlite.org/foreignkeys.html).

## Existing database upgrade

1. Stop application writers. Make a consistent SQLite online backup or a verified cold backup with every connection closed. Do not copy only the main file while WAL writers are active.
2. Test `npm run db:migrate` against a **backup copy** using an explicit `DB_PATH`. Verify application counts and required data before upgrading the source.
3. Unversioned databases must match the four-table DATA legacy schema, including its indexes and constraints. Unknown schema variants, extra objects or another team's `server/src/database` schema are rejected rather than guessed.
4. The migration preserves existing user/contact/message/log IDs and legacy fields. It creates profiles from user display names; pending contacts become requests, accepted pairs become canonical friendships, and blocked contacts become directional blocks. Contacts remain intact for provenance.
5. Messages are grouped by unordered sender/receiver pair into deterministic `legacy-dm:<hex-low>:<hex-high>` IDs with both memberships. Original payload, algorithm and times are copied exactly. Delivery/read timestamps become scoped receipts. SecurityLogs descriptions/details remain only in the legacy table; AuditLogs records metadata with a legacy-log reference.
6. Run the migration again and restart the application. The second execution must apply zero versions. Keep the backup under access control until the upgrade is accepted.

No real database is automatically rewritten by the tests. Tests create unique temporary databases. The implementation verification also upgraded an online backup of the tracked database; the original database and its tracked WAL/SHM were left unchanged.

## Failure handling

| Code/result | Action |
| --- | --- |
| `UNSUPPORTED_LEGACY_SCHEMA` | Compare `sqlite_master`, table_info, foreign_key_list and index definitions with DATA's baseline. Obtain an explicit mapping for custom tables/columns; do not delete them or hand-edit the ledger. |
| `LEGACY_FOREIGN_KEY_VIOLATION` | Review orphaned records on a backup. Repair only with an owner-approved data decision, retaining the source backup. |
| `AMBIGUOUS_LEGACY_CONTACTS` | Opposing pending requests or conflicting statuses cannot be assigned an authoritative direction/state automatically. Decide which state is authoritative and record the decision before retrying. |
| `INVALID_LEGACY_USER` / `INVALID_LEGACY_MESSAGE` | Invalid identities, missing required timestamps, empty payloads or self messages need an explicit repair decision. No IDs or payloads are printed in errors. |
| `MIGRATION_FAILED` | Batch rolled back. Inspect the structured `cause` locally under controlled access, identify invalid legacy values or a migration defect, repair a copy and retry. CLI output omits the raw cause and SQL values. |
| `MIGRATION_HISTORY_MISMATCH` | Restore the deployed migration files or reconcile the actual application version. Never recompute ledger checksums to hide a mismatch. |
| Busy/initialization failure | Check path, filesystem permissions, dependency availability and another writer holding the lock. Release the conflicting writer and rerun; there is no blind automatic write retry. |

There is no automated down-migration. Before a committed upgrade, failure is transactional. After a committed upgrade, use a new forward repair migration or an operator-controlled restore of the consistent backup while all application processes are stopped. Do not run legacy schema.sql over the upgraded database.

SQLite files and sidecars are ignored locally. This repository already tracked `DATA/server/database/database.sqlite`, `database.sqlite-wal` and `database.sqlite-shm` before DB-1. Ignore rules cannot untrack existing files; this task deliberately neither removes nor stages them. Coordinate their eventual removal from version control separately without deleting anyone's working database.
