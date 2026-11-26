# DB-5D / DB-6B integration into `origin/main` (2026-11-25)

This record documents how the DB-5D and DB-6B branches were merged with the parallel
`origin/main` implementations from PR #21. It is an integration checkpoint, not a
production-acceptance record. Task 8.54 and the F01 attachment flake remain unresolved.

## Merge shape

- Integration branch: `chuong-data`
- Compatibility baseline: `origin/main` at `b820b46`
- DB-5D checkpoint: `a776d68`
- DB-6B checkpoint: `1460994`
- Pre-merge tip: `c1e1909`
- Recovery refs: `backup/chuong-data-pre-integration-20261125` (`7757b74`),
  `backup/chuong-data-before-main-merge2-20261125` (`c1e1909`),
  `snapshot/db5d-working-20261125` (`a776d68`), DB-6B clone snapshot `1460994`.

A normal merge was used; no published history was rewritten and no force-push was used.

## Migration reconciliation

`origin/main` already published `0008-authenticated-message-pins.sql`,
`0009-authenticated-message-reactions.sql`, `0010-encrypted-attachments.sql`,
`0011-encrypted-message-revisions.sql` and `0012-groups.sql`. Those migrations are
preserved byte-for-byte.

The DB-6B draft `0009-attachment-lifecycle.sql` was renamed to
`0013-attachment-lifecycle.sql` and reconciled:

- `expires_at` is owned by main's `0010-encrypted-attachments.sql`; `0013` does not add it again.
- `0013` adds `integrity_digest`, `deleted_at`, `purge_state`, `declared_algorithm` and
  `declared_format_version`, plus `AttachmentReservations` and the DB-6B indexes.
- The DB-6B triggers (`attachments_immutable`, `attachments_lifecycle`,
  `attachments_metadata_insert`) are scoped with `WHEN NEW.e2ee_version IS NULL`, so they
  never interfere with main's `e2ee_version=1` encrypted-attachment rows or triggers.
- DB-6B repository queries (usage, search, retention, reconciliation, association,
  deletion, purge) are scoped to `e2ee_version IS NULL`.
- Migration ledgers and DC-01 baseline tests now expect versions 1 to 13.

No database that had applied the DB-6B draft `0009` was migrated here; the draft existed
only in disposable fixtures. Fresh initialization and upgrades from version 7 and version
12 were validated.

## Attachment architecture

There is one authoritative owner per endpoint:

- **Default (canonical switch off):** main's encrypted attachment API owns
  `/api/attachments` (`messaging/attachments.js`, `routes/attachments.js`,
  `EncryptedAttachmentBatches`). Frontend encryption guarantees and existing client
  compatibility are preserved.
- **Canonical switch on (`ATTACHMENTS_API_ENABLED=true`):** the DB-6B canonical API owns
  `/api/attachments` and `/api/files`; `routes/canonicalAttachments.js` is mounted and
  main's encrypted router is not. This mode is mutually exclusive and is not activated in
  the shipped configuration.
- `app.js` exposes `encryptedAttachments`, `canonicalAttachments`, and an `attachments`
  alias that resolves to the active implementation. Main's encrypted cleanup uses
  `encryptedAttachments`; DB-6B retention runs only when the canonical switch is on.
- DB-6B storage providers, repository, quotas, retention and audit tests are retained.

## Group architecture

Main's `0012-groups.sql` (the renamed and extended DB-5B groups migration) is the schema
baseline. DB-5C/DB-5D group services, history, membership authorization and group-message
services are merged on top. Main's pins, reactions, revisions and encrypted-attachment
messaging remain intact. No second group table or competing group router was introduced.

## Validation performed

- Migration/reconciliation suite: 59 tests, 0 failures (including `0013` up/`0012`→`0013`
  upgrade, fresh initialization, pins/reactions/revisions ledgers, baseline checksums).
- `groups-migrations`: 21/21.
- Groups HTTP/OpenAPI, DB-6B attachment service/repository/policy/validation/quota/retention/
  storage contract and audit: 173/178 initially; all integration gaps fixed; final focused
  batches green.
- `groups-atomicity` P-31 (group and attachment transactions): 3/3.
- Canonical attachment HTTP: 10/10 (single run; F01 not investigated).
- Main server integration (encrypted attachments, authenticated attachment boundary,
  encrypted edits, pins, reactions, unsend): 30/30.
- Client type-check, lint and `build:verify`: exit 0.
- Secret scan, conflict-marker scan and forbidden-path scan: clean.

## Open items

- Task 8.54 remains unchecked; full canonical C1/C2-C5/G1-G9 and Windows evidence are deferred.
- F01 (A04 download flake) remains unresolved; the single canonical HTTP run passed.
- Node 26 compatibility evaluation was not reopened.
- Groups, group messaging, realtime, LiveKit, AI and the canonical attachment switch remain
  disabled by default.
