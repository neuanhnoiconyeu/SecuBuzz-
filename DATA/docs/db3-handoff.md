# DB-3 profiles and friends implementation handoff

Date: November 14, 2026. Branch: chuong-data; HEAD retained at 72f4e80. DB-3 began with 37 uncommitted DATA files and 20 uncommitted frontend files. Their existing work was preserved and extended only where DB-3 required DATA changes. No branch change, commit, push, reset, stash, merge or rebase was performed.

## A. Final Verdict

**COMPLETE — DB-3 verified.** Authenticated profiles/discovery, request workflows, symmetric friendships, directional blocks, object authorization, privacy, bounded paging, consistent revisions and real HTTP restart/concurrency verification are implemented. DB-4 was not started. No live frontend social adapter, Socket.IO, messaging, groups, uploads, presence or Gemini integration is claimed.

## B. Before vs. After

The actual audit confirmed DB-1 migrations/repositories and DB-2 credential/session/CSRF/rate infrastructure. All 133 baseline backend tests passed before edits. The current frontend Phase 8.6 report/code already contained real auth, but its profile/friends services and proxy allowlist did not expose real social data.

DB-3 adds thin authenticated Express routes and one connection-injected social repository/service over existing tables. It separates historical projections from authenticated consent, serializes transitions in SQLite, returns private preferences only to their owner and supports revision-consistent collection reads. DB-2's auth endpoints/middleware/cookie/CSRF/Origin/KDF policies remain intact. Legacy unsafe data routes stay closed; only the new authorized profile/social paths are opened.

## C. User Profiles

- GET /api/users/search: authenticated ASCII username-prefix discovery, trimmed/lowercased, 2..64 characters, deterministic username/user-ID order, indexed range query, max 50 per page. It does not search private email or scan display names.
- GET /api/users/:id: permitted active public FriendUser plus the requesting actor's relationship/request ID; either-direction blocked/inactive/unknown targets return the same 404.
- GET /api/users/me: own UserProfile including private statusMessage/presencePreference and isDemo=false.
- PATCH /api/users/me: partial displayName (40 code points), statusMessage (160), built-in avatar and stored presence preference. Reject null/unknown/protected/owner fields, malformed Unicode and controls; retain omitted values. No uploads or live presence are implemented.

Public results contain only id, username, displayName and avatar, plus the actor's authorized relationship metadata where applicable. No email, account state, hashes, session identifiers, last_seen, private status or presence preference is returned.

## D. Friend Requests

GET /api/friends/requests lists only the actor's incoming/outgoing authenticated requests, defaults to pending and supports explicit resolved history. POST creates a request with implicit authenticated sender. Recipients alone may accept/decline; senders alone may cancel. Self, duplicate/reversed pending, already-friend, blocked and invalid targets are refused. Unrelated/historical request IDs return privacy-safe 404.

Acceptance inserts/confirms one canonical friendship and resolves the request in one write transaction. Decline creates no friendship. Duplicate acceptance/decline or actions on a conflicting resolved state return 409. Repeated own cancelled-request cancellation returns 204; cancelling an accepted request cannot remove its friendship.

## E. Friendships

GET /api/friends returns current symmetric authenticated friendships. DELETE /api/friends/:id interprets id as the **friend's user ID**, removes only that actor/target pair and is idempotent. It does not remove users, sessions, conversations or unrelated pairs. Request history remains; re-friending needs a fresh accepted request.

One canonical binary-ordered pair prevents duplicate/reversed friendships. Immediate transactions serialize reversed sends, double accepts, accept/cancel and accept/block. The real restart test confirms both accounts' friendships and sessions persist across distinct backend processes.

## F. Blocks

GET /api/blocks lists only the actor's outgoing block identities. POST /api/blocks inserts/confirms that direction, removes the pair's friendship and cancels both pending directions atomically. DELETE /api/blocks/:userId removes only the actor's direction and restores nothing. Self-block is rejected; repeated block/unblock is idempotent. The opposite block remains restrictive after one side unblocks.

Search/public profiles/requests/friends enforce block checks in both directions. An owner may see bare identities in their own block list, including during mutual blocking; they cannot obtain the target's private profile or block list. Missing/hidden target errors do not identify which user blocked whom. Blocked-away profile edits do not leak through actor revision changes.

## G. Database Changes

New version: server/database/migrations/0004-profiles-friends.sql. Applied versions 0001..0003 are unchanged.

- Adds origin=legacy|authenticated to FriendRequests/Friendships/Blocks. All existing rows default to legacy; migration creates no real friendships or credentials.
- Adds actor/direction/origin/status/cursor indexes, canonical friend lookup indexes, active-username discovery range index and pair-history expression index. Existing block primary/reverse indexes are reused.
- Adds SocialRevisions (user FK, nonnegative integer) and transactional invalidation triggers. Versions are actor-scoped opaque equality tokens, not relationship copies or global activity counters.
- Existing Contacts/users/sessions and prior ledger/checksums remain intact. Legacy requests/friendships are hidden/non-actionable until explicit authenticated consent; restrictive legacy blocks remain effective. Explicit sending may cancel an old pending projection before creating a distinct authenticated request; original Contacts remains untouched.

createSocialRepository(db) shares the existing connection and public projections. createSocialService handles domain transitions, target/participant authorization, body validation, metadata-only audit and proof revalidation. Read transactions include current session validation, revision and joined result data. Write transactions preserve 4xx domain failures while rolling back all SQL changes.

## H. Files Changed

These are the **25 DB-3-specific changed/new files**, relative to the repository root. Other pre-existing changes are not attributed to DB-3.

| Exact path | Reason |
| --- | --- |
| DATA/server/database/migrations/0004-profiles-friends.sql | Add provenance, revisions/triggers and query indexes without editing old migrations. |
| DATA/server/database/socialRepository.js | Injected joined queries, block checks, canonical transitions and revision reads. |
| DATA/server/social/service.js | Authorized profile/social workflows and shared rate policy. |
| DATA/server/social/validation.js | Strict profile/target/query/cursor/revision validation and projections. |
| DATA/server/routes/social.js | Thin users/friends/blocks routes using DB-2 middleware. |
| DATA/server/app.js | Mount authorized social routes; retain closed messaging/log paths and sanitized busy errors. |
| DATA/tests/social-http.test.js | Profile/discovery/request/friend flows and actual two-account process restart. |
| DATA/tests/social-security.test.js | Block/privacy/ownership/CSRF/legacy/rate/rollback checks. |
| DATA/tests/social-concurrency.test.js | Independent HTTP/SQLite writer races and busy refusal. |
| DATA/tests/social-migrations.test.js | Version-3 upgrade/data/checksum preservation, repeat and failed migration rollback. |
| DATA/tests/social-revisions.test.js | Coherent snapshots, stale cursors, private-activity isolation, SQL range plan and constant query count. |
| DATA/tests/support/social.js | Real registration/session fixtures and authorized HTTP mutation helpers. |
| DATA/tests/migrations.test.js | Include schema version 4 while retaining prior regression assertions. |
| DATA/tests/auth-migrations.test.js | Include the next additive migration in the existing DB-2 upgrade regression. |
| DATA/docs/profiles-friends-api.md | Endpoint/shape/privacy/validation/pagination/error contract. |
| DATA/docs/profiles-friends-openapi.json | OpenAPI 3.1 specification: 11 paths, 14 operations. |
| DATA/docs/relationships.md | State machine, concurrency, provenance and revision policy. |
| DATA/docs/db3-integration.md | Exact ProfileService/FriendsService/proxy and Kiro/DB-4 handoff. |
| DATA/docs/db3-operations.md | Migration, shared limits, query indexes and scale/deployment boundaries. |
| DATA/docs/db3-handoff.md | This full report. |
| DATA/docs/schema.md | Current additive schema inventory and ERD relationship. |
| DATA/docs/repositories.md | Link authorized DB-3 operations and distinguish legacy primitives. |
| DATA/docs/migrations.md | Describe version 4 and preservation semantics. |
| DATA/docs/auth-api.md | Clarify newly opened authorized social paths without changing auth contracts. |
| DATA/README.md | Current DB-3 entry points, handoffs and remaining closed legacy APIs. |

No client/, Kiro-owned server/, Docker, environment secrets or original database files were edited. Hash comparison confirms all 20 pre-existing frontend files are unchanged. Existing DATA work outside the listed extensions is preserved. Dependency manifests/lockfile are unchanged by DB-3.

## I. Test Results

Windows, Node 24.20.0, npm 12.2.1; real SQLite and Argon2 bindings. Tests use unique temporary databases and synthetic users, not the existing development database.

| Command/check | Observed result |
| --- | --- |
| Initial baseline npm test | 133 existing tests passed before implementation. |
| Full npm test after DB-3 | **199 passed, 0 failed, 0 skipped**: 133 regressions + 66 DB-3 checks. |
| Actual two-account HTTP scenario | Alice/Bob register/login, search, request, incoming list, accept, both friends lists, terminate/start separate backend, friendship/session persistence, block/removal, rejected new request, unblock/no restoration all passed. |
| Concurrent writers | Reversed send, double accept, accept/cancel, accept/block, repeated remove/block and busy refusal passed on separate HTTP server/database connections. |
| Security/rollback | Owner/participant isolation, missing/expired/revoked sessions, CSRF/Origin, mass assignment, hidden users, private projections and injected multi-step failures passed. |
| Read consistency/performance | Actor-scoped snapshot revision/stale handling, blocked-away/private preference isolation, indexed discovery range and no per-row query growth passed. |
| Migrations | Fresh/repeat, version-3 → 4 data/checksum preservation, a real credential-verified session/CSRF retained across upgrade, and failed additive migration rollback passed. |
| Consistent backup of tracked database | Upgraded to version 4; all four original tables' fields preserved; zero authenticated friendships created; foreign_key_check empty and integrity_check ok. Source/main/WAL/SHM hashes unchanged. |
| Isolated npm run db:migrate twice | Four applied on fresh setup, zero on repeat. |
| OpenAPI | JSON parses and all local references resolve; 11 paths/14 operations reviewed. No external linter claim. |
| git diff --check, status and scope review | Passed; only DATA files changed by DB-3; original migrations 1..3 and original database preserved; no Git history mutation. |

The initial DB-3 run caught a transaction wrapper converting domain rejections to generic 500s. The dedicated social transaction boundary now preserves fixed 404/409 errors while retaining rollback; tests verify denied operations and no partial writes. No assertions were removed to conceal failures.

## J. Security Review

All routes authenticate through DB-2, recheck authority in the database and protect mutations with the existing Origin/CSRF policy. Object IDs are target selectors only; owners/senders come from req.auth. Unknown/protected fields are refused. Read queries use approved projections, bounded keyset pages, active account joins and symmetric block checks. Request IDs are participant-scoped. State transitions/audits/revisions are atomic and failures expose no SQL, secrets, private profiles or diagnostics.

Shared SQLite rate limits cover reads, search, mutations and request attempts. Unverified forwarded IPs are ignored; busy writes fail safely. Legacy projections do not silently become authenticated consent. Own revisions avoid a global activity counter and exclude private/unrelated/blocked-away edits.

Known limits: username-prefix discovery only; no custom visibility setting exists; direct-peer source limits group proxy/NAT clients; shared limits require one shared durable DB; public-profile invalidation fanout scales with visible social neighbours/history. Query pages are not permanent frozen directory snapshots. Existing trusted low-level legacy modules are not authenticated public APIs. New dependencies were not introduced; DB-2's existing development-only advisory findings remain documented. No production TLS, real browser social integration, Socket.IO event delivery or hardware-fault validation is claimed.

## K. Frontend / Kiro Handoff

See db3-integration.md for exact methods/routes and same-origin proxy work. Codex must extend the current five-route auth rewrite allowlist for approved social endpoints, implement remote ProfileService/FriendsService, use the existing CSRF bootstrap, collect all pages at one actor revision and publish only complete confirmed snapshots. STALE_STATE requires discarding/refetching reads, never blindly retrying a mutation. No demo fallback is allowed.

Kiro/DB-4 can reuse isBlocked(a,b) and blockedIds(actor) from the injected social repository; these are trusted internal checks, not another user's block-list API. Relationship changes emit no socket events. Owners must wire committed invalidation/revalidation and check current block/membership/key permissions transactionally before messaging/presence/history actions. The existing auth/session/CSRF contracts remain unchanged. No Gemini setting or call was enabled.

## L. DB-4 Readiness

**DB-4 can safely begin on the verified DB-3 foundation. It has not been started.** Reuse the migrated connection, DB-2 trusted actor/proof, canonical relationships, symmetric block checks and transaction boundary. Before live messaging, DB-4/Security/Kiro must still agree global-versus-conversation message-ID semantics, durable shared message writes, conversation membership/authorization, recipient-key verification and realtime delivery/invalidation. Friendship alone does not create a conversation or establish E2EE. These later integration dependencies are not represented as completed DB-3 work.
