# DB-1 migration and operations guide

Use Node 24 (verified with 24.20.0), the existing dependencies and the Database Team workspace:

Before any migration of an existing database, satisfy the cold-backup precondition in [Version 12 group migration](#version-12-group-migration). The commands below apply pending migrations; they are not a backup procedure.

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
| `0003-authentication.sql` | Adds private credential records, anonymous CSRF challenges, shared auth rate counters, username reservation triggers and session auth_version. Creates no credentials for existing users and leaves existing entity data intact. |
| `0004-profiles-friends.sql` | Adds relationship provenance, actor-scoped social revisions and query indexes. Existing projections remain legacy; no authenticated friendships are created. Users, sessions and Contacts are preserved. |
| `0005-conversation-provenance.sql` | Adds Conversations.origin defaulting to legacy and an authenticated direct-list index. Preserves all IDs, members, ciphertext, timestamps and earlier checksums; only an explicit friendship-approved API operation activates an existing legacy pair. |
| `0006-encrypted-message-lifecycle.sql` | Adds message provenance, stable per-conversation sequence, tombstone/revision metadata and partial wire-ID/sequence uniqueness/history indexes to Messages. All prior columns/receipts and migration versions are preserved; no legacy envelope is relabeled authenticated and no record is deleted. |
| `0007-recipient-keys.sql` | Adds immutable public DeviceKeys, signed ConversationKeyEpochs and opaque ConversationKeyWraps with permanent status transitions and ownership FKs. Rebuilds Messages to support v1/v2 plus immutable key_id. Preserves all original values, receipts, attachment references, named indexes/triggers and migration checksums. |
| `0008-authenticated-message-pins.sql` | Shared pin metadata, participant eligibility and atomic Unsend cleanup. |
| `0009-authenticated-message-reactions.sql` | Per-user reactions, revision counters and atomic Unsend cleanup. |
| `0010-encrypted-attachments.sql` | Encrypted attachment batch association, staging/retention metadata and Unsend revocation; voice reuses this contract. |
| `0011-encrypted-message-revisions.sql` | Append-only signed encrypted edits; original ciphertext and identity remain immutable. |
| `0012-groups.sql` | Version 12 (DB-5B draft): additive group extensions, membership intervals, Invitations, read positions and creation keys; backfills existing groups and adds immutable-history, overlap and replacement guards. No pre-existing row or published migration changes. |

The runner obtains a `BEGIN IMMEDIATE` writer lock, validates existing history, applies **all** pending versions and checks foreign keys within one transaction. Failures roll back the entire pending batch, including the migration ledger and Messages rebuild. Already committed earlier versions remain intact. Success records each version once. Repeating the command reports zero migrations applied.

The ledger verifies SHA-256 checksums (CRLF normalized to LF), filenames and contiguous versions. Do not edit an applied SQL migration; add the next numbered SQL file. Missing, changed, reordered or future ledger entries fail. Migrations must contain transactional SQL only: do not embed BEGIN/COMMIT/ROLLBACK, VACUUM, attach/detach operations or connection pragma changes. Schema failure recovery is tested for exceptions and a process exiting with an open write transaction; this is not a claim of hardware power-loss testing.

The runner leaves foreign keys enabled throughout. Migration 2 rebuilds Messages before child tables exist. Migration 7 must also preserve existing MessageReceipts and Attachments: it makes transaction-local copies, removes these two dependent tables, creates/copies/renames Messages_v7, recreates their original constraints/indexes/triggers and restores every value. The foreign-key check runs before commit; a later exception rolls back the entire schema/data/ledger change. Migrations 1–6 remain byte-for-byte unchanged. Migration 7 introduces no foreign-key-disable or writable-schema pragma. See SQLite's [table-rebuild guidance](https://www.sqlite.org/lang_altertable.html#otheralter) and [foreign key behavior](https://www.sqlite.org/foreignkeys.html).

## Existing database upgrade

1. Stop every process that can open the database, close every connection and take the cold backup described below. Do not copy only the main file while WAL writers are active.
2. Test `npm run db:migrate` against a **backup copy** using an explicit `DB_PATH`. Verify application counts and required data before upgrading the source.
3. Unversioned databases must match the four-table DATA legacy schema, including its indexes and constraints. Unknown schema variants, extra objects or another team's `server/src/database` schema are rejected rather than guessed.
4. The migration preserves existing user/contact/message/log IDs and legacy fields. It creates profiles from user display names; pending contacts become requests, accepted pairs become canonical friendships, and blocked contacts become directional blocks. Contacts remain intact for provenance.
5. Messages are grouped by unordered sender/receiver pair into deterministic `legacy-dm:<hex-low>:<hex-high>` IDs with both memberships. Original payload, algorithm and times are copied exactly. Delivery/read timestamps become scoped receipts. SecurityLogs descriptions/details remain only in the legacy table; AuditLogs records metadata with a legacy-log reference.
6. Run the migration again and restart the application. The second execution must apply zero versions. Keep the backup under access control until the upgrade is accepted.

No real database is automatically rewritten by the tests. Tests create unique temporary databases. Historical DB-1 verification used an online backup copy; that is not the cold-backup precondition for a DB-5B upgrade. DB-5B validation uses disposable synthetic databases and does not authorize opening a development database or its volumes.

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

## Version 12 group migration

`0012-groups.sql` is the version 12 DB-5B draft. Keep the migration draft isolated until the phase validation is accepted; running the application or Migration_Runner against an existing database still applies pending SQL immediately.

Merge integration: Groups was previously an unapplied `0008-groups.sql`. The team confirmed no applied Groups history needs preservation, so only its filename/version moved to 0012; the SQL body is unchanged. Messaging migrations 0008–0011 keep their existing names, checksums and contracts. Databases already at messaging version 11 append only Groups. Do not rewrite migration ledger rows in an environment with a different applied history.

Merge verification (2026-11-22): 589 DATA tests passed with `node --test --test-concurrency=1`, including fresh/upgrade/rollback property checks and a populated version-11-to-12 failure/retry fixture retaining pins, reactions, encrypted attachment metadata and revisions. The backend's 584 tests and frontend's 1,349 tests passed, along with client/server TypeScript and frontend lint. The realtime Chrome acceptance flow passed, including authenticated encryption, reconnect, device revocation and the merged dark-theme assertion. Development databases and the existing stash were not used or changed. Docker files received static validation only; no Docker executable was available for a merged-image startup test. Earlier parallel DATA runs had loopback connection resets; the complete serial run passed without retries or weakened assertions.

A database migrated to 0012 or higher cannot start under code without that migration, because the runner rejects extra ledger rows with `MIGRATION_HISTORY_MISMATCH`.

Before running the Migration_Runner on an existing database, take a cold backup while no process has the database open (every connection is closed).

For a host database, take a cold copy of `database.sqlite`, `database.sqlite-wal` and `database.sqlite-shm`, preserving every companion that exists after all connections have closed. A clean shutdown may have removed the WAL/SHM; do not create substitutes or omit companions that remain. Keep the copy private and verify a disposable copy before an upgrade.

For Docker data, use [Cold backup commands](../../docs/docker-development.md#cold-backup-commands-powershell) and [Restore into new volumes first](../../docs/docker-development.md#restore-into-new-volumes-first-powershell). That procedure stops every writer and archives both complete volume roots, `sqlite-data` and `private-storage`, together. The commands are cited here, not duplicated. Keep both archives as a pair; a database-only archive is not this backup.

The first start of an image that contains 0012 migrates `sqlite-data` at once and permanently. A failed migration stops startup. Compose Watch is not used while a migration file is a draft. Rollback after a committed upgrade is a cold-backup restore into fresh volumes using the saved application/migration revision, following the cited restore procedure (COMP-05). Retain the source volumes; do not overwrite a running database or mount upgraded data under older code. On a host, restore the pre-migration file and its retained companions with every connection closed. There is no down-migration and no backup helper or backup script is supplied (DK-06).

### Named objects added by 0012

The following inventory contains all 38 explicitly named objects. SQLite also supplies implicit primary-key indexes; the key definitions and full constraints are described in [schema.md](schema.md#version-12-group-migration).

| Kind | Names |
| --- | --- |
| Tables | `GroupExtensions`, `GroupMembershipIntervals`, `ConversationInvitations`, `GroupReadPositions`, `GroupCreationKeys` |
| Interval indexes | `uq_group_intervals_open`, `idx_group_intervals_open_joined` |
| Invitation indexes | `uq_invitations_pending`, `idx_invitations_invitee`, `idx_invitations_group`, `idx_invitations_inviter` |
| Creation-key index | `idx_group_creation_keys_conversation` |
| Extension triggers | `group_extensions_group_only`, `group_extensions_update`, `group_extensions_keep` |
| Interval triggers | `group_intervals_insert`, `group_intervals_close`, `group_intervals_keep` |
| Invitation triggers | `invitations_insert`, `invitations_transition`, `invitations_keep` |
| Read-position triggers | `group_read_positions_monotonic`, `group_read_positions_insert`, `group_read_positions_identity` |
| Creation-key immutability | `group_creation_keys_immutable` |
| Replacement guards | `group_extensions_replacement_guard`, `invitations_replacement_guard`, `group_read_positions_replacement_guard`, `group_creation_keys_replacement_guard`, `group_members_replacement_guard`, `group_owner_replacement_guard`, `group_intervals_replacement_guard` |
| Rowid identity guards | `groupextensions_row_identity`, `groupmembershipintervals_row_identity`, `conversationinvitations_row_identity`, `groupreadpositions_row_identity`, `groupcreationkeys_row_identity`, `conversationmembers_row_identity` |

`group_extensions_update` makes `history_policy` immutable and preserves identity/creation time; a changed revision must be exactly +1. Interval guards reject overlapping closed or open periods and retain closed history. Replacement guards protect schema invariants without relying on implicit DELETE triggers; valid UPSERT remains supported. The owner-approved transaction boundary additionally validates cross-table membership invariants before commit. Applying these tables does not enable group routes or feature gates and does not alter E2EE, key management or realtime security.

### Backfill rule

Every group of both origins receives one extension with NULL description, `from_joined` policy, revision 1 and the existing conversation creation time. Every existing group member receives interval 1 with the original join/leave times. `first_seq` is the lowest authenticated message sequence created at or after joining, otherwise authenticated high-water +1 (1 when there are no messages). Active `last_seq` is NULL; for a former member it is the highest authenticated sequence created at or before leaving, otherwise `first_seq - 1` (an empty closed period). The SQL compares `strftime`-normalized timestamp forms, including legacy SQLite strings; an unparseable time matches no message, narrowing visibility. No original row, ciphertext, membership timestamp or version-1-to-7 checksum changes. This conservative bootstrap is separate from subsequent sequence-based join/leave boundaries.
