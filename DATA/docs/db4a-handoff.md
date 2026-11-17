# DB-4A — Conversations Foundation handoff

Date: November 14, 2026. Repository: `D:\Projects\SecuBuzz-`. Branch remains `chuong-data` at `72f4e806e1446ce65036f705f9f7eb82275942d9`.

## A. Verdict

COMPLETE — persistent authenticated direct-conversation metadata, pair uniqueness, atomic memberships, current authorization, bounded listing and native-process HTTP/restart verification are implemented. DB-4B has not started.

## B. Architecture and database audit

DB-1 already supplied `Conversations`, `ConversationMembers`, the canonical unordered pair CHECK/UNIQUE constraint and an atomic conversation-plus-two-members creation path. Those remain the one persistence implementation. DB-4A extends `createRepositories(db).conversations` rather than adding a competing repository/schema. Existing membership methods are reused. The new thin service reuses DB-3's active user/friendship/block helpers and transaction convention, DB-2's durable session/CSRF verification and shared SQLite rate limiter, and the existing caller-owned connection.

One new additive migration, `0005-conversation-provenance.sql`, adds `Conversations.origin` (`legacy|authenticated`, default legacy) and a partial authenticated direct-list index. This is needed to keep DB-1 backfilled/trusted legacy conversations from silently becoming authenticated consent. Versions 1–4 are unchanged. No table is duplicated, rebuilt or reset; message/ciphertext schema and rows are untouched.

An explicit unblocked friendship-approved request can activate an intact legacy pair in place, preserving its ID, original creation time, members and ciphertext. Activation changes provenance/update time and commits safe audit metadata in the same transaction. The existing pair UNIQUE constraint means a legacy pair is never replaced with a second DM. Unknown/inactive peers, missing/left members, archived rows and unsupported groups fail closed.

## C. APIs and response contract

| Endpoint | Contract |
| --- | --- |
| `GET /api/conversations` | 200 `{items: Conversation[],nextCursor:string|null}`; own visible direct conversations only |
| `POST /api/conversations/dm` | Exactly `{recipientId}`; 201 for new DM, 200 for existing/explicitly activated legacy DM, both `{conversation:Conversation}` |
| `GET /api/conversations/:id` | 200 `{conversation:Conversation}` only for authorized active pair members |

`Conversation` contains exactly `id`, `type:'direct'`, two public participant summaries (`id,username,displayName,avatar`), ISO `createdAt/updatedAt`, and a current `interactionAllowed` policy hint. There are no message previews, plaintext, private profile preferences, credential/session fields or simulated presence. New IDs are UUIDs; existing approved legacy IDs remain opaque/stable and can be longer. The [OpenAPI](conversations-openapi.json) and [integration guide](db4a-integration.md) include request/response examples, exact validation, error/status codes, headers and repository interfaces.

Lists are ordered by `(updated_at DESC,conversation_id DESC)`, default 20 / maximum 50, using `limit+1` keyset SQL and one joined participant projection. Cursor context is actor/endpoint-scoped and bounded; every page reapplies current authorization. No arbitrary owner/filter/offset input exists. These are current-state pages, not a frozen snapshot; refresh/deduplicate after changes.

## D. Security and existing-conversation policy

The session supplies the initiator; no sender/owner/session selector is accepted. Both active credential-enabled accounts and both active memberships are required. Initial creation and legacy activation require an authenticated confirmed friendship. All mutations retain DB-2's exact Origin, secure transport, HttpOnly cookies and session CSRF checks; the proof and durable session are rechecked inside the writer transaction. JSON/body limits, safe error shapes, no-store headers and non-forwarded-IP rate limits remain enforced.

Existing authenticated metadata remains readable after unfriending with `interactionAllowed=false`; an existing-pair POST only retrieves it and does not create a new interaction. Either-direction block hides both sides' metadata and denies create/retrieve with the same 404 as missing/unrelated records. Rows and memberships remain persistent. Unblock can restore metadata visibility but restores no friendship or interaction grant. Future writes must reauthorize current friendship/blocks in their own transaction rather than trusting this flag.

## E. Concurrency and rollback evidence

The service obtains `BEGIN IMMEDIATE` before checking session, proof, peer, blocks, friendship or existing pair. The existing DB UNIQUE `(dm_user_low,dm_user_high)` is the final cross-process guarantee; process-local locking is not used as a substitute. The existing atomic create inserts the canonical pair and exactly two member rows. Audit metadata joins the same outer transaction. Returning an existing pair changes neither timestamps, memberships nor audit counts.

Six simultaneous reversed requests against **two independent native Node server processes** sharing one isolated SQLite file produced exactly one 201, five 200 responses, one stable ID, one conversation and two memberships. Separate native-process races with block and unfriend were serializable: no new conversation could commit after consent/block checks became invalid; a conversation committed before a subsequent block was retained but immediately hidden afterward.

Forced second-member insertion failure rolled back the conversation and first membership. Forced audit failure after both memberships rolled back all three rows. A forced legacy-activation audit failure preserved original provenance, timestamps and ciphertext. Competing-writer busy errors were bounded and sanitized, without partial records. Direct trusted-DAL duplicate insertion was independently refused by the DB uniqueness constraint.

## F. Persistence and actual HTTP scenario

`conversations-http.test.js` executes real registration/login cookies and CSRF through actual Express/SQLite/Argon2 endpoints. Alice and Bob establish friendship, Alice creates a DM, Bob reads it, repeated/reversed requests retain the ID, and Charlie gets a privacy-safe 404. The first backend process is terminated and a distinct native process reopens the same isolated database. Both sessions can read the same conversation, both memberships remain and reversed creation returns the existing ID. A block then rejects creation/lookup while keeping the stored conversation. No message is inserted.

Tests use temporary isolated databases and ephemeral ports. The user's development database is neither reset nor migrated, and existing local services are not restarted by this task. DATA must be restarted with its intended persistent DB_PATH when the owner deploys DB-4A. A healthy older process is not proof that it loaded changed modules. Frontend mappings and real conversation UI integration remain a separate owner task.

## G. Exact changed paths

```text
DATA/server/database/migrations/0005-conversation-provenance.sql
DATA/server/database/repositories.js
DATA/server/conversations/validation.js
DATA/server/conversations/service.js
DATA/server/routes/conversations.js
DATA/server/app.js
DATA/tests/conversations-http.test.js
DATA/tests/conversations-concurrency.test.js
DATA/tests/conversations-security.test.js
DATA/tests/conversations-migrations.test.js
DATA/tests/migrations.test.js
DATA/tests/auth-migrations.test.js
DATA/tests/social-migrations.test.js
DATA/README.md
DATA/docs/schema.md
DATA/docs/migrations.md
DATA/docs/repositories.md
DATA/docs/conversations-openapi.json
DATA/docs/db4a-integration.md
DATA/docs/db4a-handoff.md
DATA/docs/db4a-verification.json
```

The earlier migration tests now include version 5 in the expected applied sequence; their prior data/checksum/session assertions are retained. No applied migration file is edited. The verification JSON lists exact final hashes and ownership checks separately from earlier uncommitted work.

## H. Tests and final verification

| Check | Result |
| --- | --- |
| Pre-edit full DATA baseline | 199 passed, zero failures |
| Full DATA suite after implementation (`npm test`) | **247 passed, zero failures**, zero skipped/canceled; 40.099 seconds |
| New DB-4A coverage | **48 tests** across HTTP, concurrency, security and migration files |
| DB-1/2/3 regressions | All included in the 247-test run and passed |
| Fresh/repeated, version-4 upgrade and failed-migration rollback | Passed, with old data/history checks preserved |
| Actual HTTP / two native server processes / restart | Passed; real cookies, CSRF and SQLite, no mocked HTTP |
| JavaScript syntax / OpenAPI local references | PASS; all five production JavaScript files parse, all 31 local OpenAPI references resolve |
| `git diff --check`, status, scope and branch | PASS; all 61 pre-existing outside-DATA paths unchanged; branch/HEAD retained |

No unrelated frontend suite is presented as rerun evidence; frontend and Kiro sources are read-only. No external browser is required or claimed for this backend-only milestone. Earlier fixture assertions were corrected to use DB-1's actual long-ID format and DB-2's actual Origin/Fetch Metadata policy; authentication behavior was not weakened.

## I. DB-4B handoff

The existing repository methods, stable ID semantics, two-party participant lookup, membership/account/provenance/block visibility and current friendship policy are ready. `application.conversations.authorizeInTransaction(context,id,{interaction:true})` enforces the common policy within the owning transaction. `withInteraction(context,proof,id,synchronousWork)` supplies an immediate transaction with durable session/proof revalidation, the same policy and existing repositories; errors roll everything back, and asynchronous callbacks are refused.

DB-4B must implement the actual message-write/read/idempotency/receipt service, agree message-ID scope and fingerprints with Kiro, preserve encrypted envelopes and decide legacy-message access. A prior GET, client hint or socket handshake must not authorize a later write. No message service, socket integration, group workflow, attachment API, cryptography or frontend conversation integration is implemented by DB-4A.

## J. Ownership and stop boundary

The pre-edit tree contained 115 changed/untracked files, including 61 outside DATA. Final hashes show every outside-DATA file byte-identical, with no new outside-DATA change. All 21 DB-4A paths are under DATA. Existing applied migrations and all teammate work are retained. No branch changes, commits, pushes, resets, stashes, clean, merge or rebase are performed.

Stop here. DB-4B requires separate user approval; it has not been started.
