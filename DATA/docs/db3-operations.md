# DB-3 migration, performance and operations

No new dependencies or environment variables are required. Reuse DB-2's configured Origin/transport/cookie policy and shared SQLite database. Standard commands from DATA:

```powershell
npm ci
npm run db:migrate
npm start
npm test
```

Do not overwrite an existing .env. Existing secure/local-loopback configuration remains authoritative. The implementation tests create unique temporary databases; upgrade verification must use a consistent backup, not reset the existing database or run destructive tests against it. No users/sessions/Contacts are deleted by migration. Existing frontend authentication work remains preserved.

`0004-profiles-friends.sql` is the only new migration. Versions 0001..0003 are unchanged. It adds legacy/authenticated provenance to the existing three relationship tables, user-scoped revision infrastructure/triggers and indexes. It creates no authenticated relationships, credentials or demo data. See [legacy policy](relationships.md). Repeat migrations apply no changes; failure rolls back the complete pending batch including columns, indexes, revision rows and ledger entries.

## Query and consistency boundaries

- Discovery uses a bounded username_key prefix range and idx_social_discovery(status,username_key,user_id); no contains wildcard, email search, display-name scan or unbounded GET /users endpoint. Ordering is deterministic. Query-plan verification confirms the range index is used.
- Requests use actor/direction/origin/status/time indexes. Friends use canonical low/high indexes and UNION ALL actor scopes. Blocks use owner/target indexes. Joined public projections avoid per-row DB round trips; page size defaults to 20 and caps at 50. A limit+1 probe detects the next page without an unbounded COUNT query.
- The pair-history expression index supports revision/privacy checks involving resolved requests without scanning the global history table; existing block primary/reverse indexes are reused rather than duplicated.
- Each page is one deferred read transaction containing authoritative session validation, actor revision and the joined result query. Collection cursors carry that revision; changed state yields 409 STALE_STATE. Search does not claim a frozen global directory.
- Mutations use one immediate write transaction, with a session/CSRF recheck after parsing. SQLite serializes competing writers across processes. Busy writes return 503 without blind retries. Read/constraint errors are sanitized and no SQL, tokens, private profiles or request bodies are logged.
- Public identity/revision invalidation work scales with visible social neighbours/history. It uses actor indexes and set-based SQL, but very large graphs may require reviewed fanout/resource policy. Cursor pages are not long-lived database snapshots or a hardware-failure guarantee.

## Shared abuse limits

Reuse DB-2's transactional SQLite limiter; keys contain hashed actor/source/scope values, and unverified forwarded IPs are ignored. Limits are additional to DB-2 auth/KDF limits:

| Scope | Limit |
| --- | --- |
| Social reads per actor | 120/minute |
| Social mutations per actor / direct peer | 60/minute / 120/minute |
| Search per actor / direct peer | 30/minute / 60/minute |
| New request attempts per sender / sender-target / direct peer | 20/hour / 5/hour / 60/hour |

Requests rejected as duplicates/hidden targets still consume the relevant attempt limits. Mutation proof failures consume the social mutation budget. Responses include Retry-After for limiter refusals. Workers sharing one DB file share these counters; independent databases do not. A trusted reverse proxy/NAT groups users under one peer-source budget; tune a reviewed gateway design for larger deployments rather than trusting arbitrary X-Forwarded-For. There is no process-local replacement limiter.

## Rollout and known boundaries

The new DATA routes are available after migration/startup, but the current frontend rewrite allowlist still needs owner-approved social route mappings and API adapters. The DB-3 tests use real loopback HTTP/backends and synthetic accounts; no live frontend or Socket.IO integration is claimed. Only profiles and social relationships are enabled. Legacy user CRUD, messages/logs, DM creation, groups, uploads, live presence and AI remain unavailable or owned by later phases.

Discovery currently supports username prefixes only. There are no existing account-discoverability settings; adding custom visibility rules requires a new schema/contract rather than guessing from presence preferences. Public profile visibility is not proof of friendship or messaging permission. Private status/preference edits remain owner-only, and historical Contacts are never replayed as authenticated consent.
