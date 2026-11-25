# Phase 12A.1: Database migration compatibility review

Reviewed 2026-11-22 on `bon-fullstack`, HEAD `7078ebf`. **No migration incompatibility or data-preservation defect was found in the tested upgrade paths.** Database team approval is still required before deployment.

At entry, the working tree contained 153 dirty paths (78 tracked modifications, 75 untracked files), including the earlier Phase 12A review work; nothing was staged. This follow-up changes review documentation only. Application code, tests, migrations, authentication/encryption implementations, environment settings and existing uncommitted work were preserved. Development/production databases were not opened or migrated by the review.

## Migration results

| Migration | Result | Compatibility and lifecycle |
| --- | --- | --- |
| [0008: Pins](../DATA/server/database/migrations/0008-authenticated-message-pins.sql) | PASS | Adds pin/version/operation tables and guards. Composite message FKs, unique pins and participant eligibility remain enforced. Unsend removes pins atomically. |
| [0009: Reactions](../DATA/server/database/migrations/0009-authenticated-message-reactions.sql) | PASS | Adds actor/version/operation tables. One slot per user/message; revision and message/member guards. Unsend clears actor/operation metadata. |
| [0010: Encrypted attachments](../DATA/server/database/migrations/0010-encrypted-attachments.sql) | PASS | Adds five nullable attachment columns, indexes, batch metadata and lifecycle guards. Existing attachment values/FKs and message protection triggers are preserved. Voice shares this storage contract. Unsend revokes downloads through deleted file/revoked batch state. |
| [0011: Encrypted revisions](../DATA/server/database/migrations/0011-encrypted-message-revisions.sql) | PASS | Adds an append-only revision table and narrow guards. Existing ciphertext, logical/storage identity, original triggers and earlier migrations remain unchanged. Ordered revisions/nonce uniqueness and retained history do not conflict with pins/reactions or attachment FKs. |

Fresh initialization to version 11 and a version-7 database upgraded through **8 → 9 → 10 → 11** produce identical complete schemas: **30 tables, 43 explicit indexes and 61 triggers** (excluding SQLite internal objects). Foreign-key definitions match. Both isolated database files pass `foreign_key_check` and `integrity_check`; repeated runner execution applies zero migrations.

Populated upgrade fixtures preserve existing message IDs/ciphertext/IVs/times, receipts, attachment references, prior migration checksums and existing protection triggers. Existing tests also cover supported legacy-schema adoption and earlier version upgrades. Unsupported schema variants fail safely rather than being silently rewritten.

Failures deliberately injected into each of 0008–0011 roll the entire pending batch back to version 7, preserving data, schema and ledger. Corrected retries succeed. Existing tests cover interrupted uncommitted transactions, process restart, checksum drift, invalid migration order, disabled FKs and nested transactions. Cross-feature backend checks from the preceding Phase 12A run also passed after Unsend: FK integrity, pin/reaction cleanup, attachment batch revocation and retention of immutable original/revision ciphertext.

## Test results

| Command / verification | Result |
| --- | --- |
| DATA: `node --test "tests/*migrations.test.js"` | **45 passed, 0 failed** |
| DATA: `node --test` | **331 passed, 0 failed** on the final Phase 12A.1 rerun |
| Server: `node --test --test-concurrency=1 test/db5_db6.test.cjs` | **1 passed, 0 failed** |
| Independent isolated fresh/sequential schema and FK comparison | Passed; equivalent schema, integrity OK, repeat runs are no-ops |

The 45 migration tests are included in the full DATA count; do not add them to 331. The five sequential-upgrade/failure-recovery tests already existed when Phase 12A.1 started. No test source was changed in this follow-up. DB5/DB6 uses its own isolated fixture and storage contract; migrations 0008–0011 belong to the DATA ledger.

## Team-review requirements and limits

- Approve all four additive, currently uncommitted migrations in sequence, including pin/reaction receipt retention, encrypted-attachment batch/expiry/purge rules and append-only encrypted revision retention after Unsend.
- Run migrations through the checksum-validated runner with foreign keys enabled. Raw migration SQL is not individually idempotent. Do not rewrite historical migrations or migration-ledger checksums.
- There is no automatic down migration. Transactional failure recovery is verified; post-upgrade recovery requires a reviewed forward fix or coordinated backup restore. DATA's ledger and private encrypted binary directory must be backed up together.
- Fixture compatibility is verified; large production datasets, migration lock duration and operator backup restoration are not benchmarked/tested here. Migration compatibility does not establish overall merge or Security readiness; the separate [Phase 12A integration review](database-security-integration-review.md) records open client rollback-protection findings.

Final preservation check: all 137 dirty non-document source paths have exactly the same aggregate SHA-256 as at Phase 12A.1 entry. Branch and HEAD are unchanged, nothing is staged, and the only additional dirty path in this follow-up is this report (154 dirty paths at completion). Existing local SQLite/build files remain uncommitted. No development database or environment setting was modified by these checks.

Nothing was committed, pushed, staged, reset or discarded. Local SQLite files, build caches, secrets and temporary evidence remain outside any proposed feature commit.
