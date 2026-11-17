# DB-2 implementation and verification handoff

Date: November 14, 2026. Branch: `chuong-data`. The working tree was clean before DB-2. All modifications/new files remain under `DATA/`; no branch change, commit, push, merge, rebase, reset, stash or cleanup of teammate work was performed.

## A. Final Verdict

**COMPLETE — DB-2 verified.** Registration, real Argon2id credential verification, durable sessions, authentication middleware, CSRF/Origin enforcement, shared rate limits and real HTTP restart/logout tests are implemented. This phase does not claim live frontend/Socket.IO/Gemini integration or completion of DB-3 object authorization. No later phase was started.

## B. Before vs. After

Before: DB-1 supplied twelve core schema entities, legacy Contacts/SecurityLogs, migration versions 1/2, injected repositories and 76 tests. The actual Express server mounted unauthenticated legacy CRUD endpoints. Users had no passwords/private credential data; Sessions was only a persistence primitive. Frontend demo auth was not real authentication.

After: migration 3 adds private credential storage, durable CSRF pre-sessions and shared auth rate counters; the original Express entry now uses an injected application/start factory. Five auth endpoints provide real account/session flows. A valid session must join an active credential-enabled account and matching authentication version. Legacy account records remain unchanged and cannot sign in or claim an account without an explicit later ownership-verification process.

## C. Authentication Endpoints

| Endpoint | Behavior |
| --- | --- |
| GET /api/auth/csrf | Issues/reuses a guest pre-session proof or returns the active session's stable proof. |
| POST /api/auth/register | Validates and atomically creates user/profile/private credentials; returns 201 `{status:'requires-login'}`. |
| POST /api/auth/login | Verifies password, atomically rechecks account/proof, creates/rotates durable session and returns 200 `{user}` plus HttpOnly cookie. |
| GET /api/auth/me | Resolves authoritative identity from a verified SQLite-backed cookie; returns only public AuthUser. |
| POST /api/auth/logout | Requires CSRF, revokes current session, clears cookies and returns 204; guest proof permits a safe already-logged-out retry. |

There is no refresh endpoint because sessions have fixed absolute expiry. Exact requests, errors, cookies and transitions are in [auth-api.md](auth-api.md) and [auth-openapi.json](auth-openapi.json).

## D. Password Security

Pinned node-argon2 0.45.2 implements Argon2id v19 with 19 MiB, two iterations, one lane and independent library-generated salts. New passwords require 15 code points and at most 1024 UTF-8 bytes, without trimming, normalization or truncation. Unknown accounts perform dummy verification; wrong/unknown/legacy/disabled responses are identical. Weaker hashes upgrade on successful login; stronger hashes are retained. Password work is bounded to two concurrent operations per process. Private email/hash records never appear in public Users projections, API JSON or logs.

## E. Session Architecture

Fresh 256-bit random bearer cookies map to SHA-256 verifiers in Sessions; internal session IDs are separate UUIDs. Default lifetime is eight hours, fixed from issue. Sessions persist after process restart. Every request validates expiry/revocation, active credential status, authoritative user/profile and matching auth_version; old DB-1 session version zero is insufficient. Login rotates presented browser sessions, caps concurrent active sessions at five per account, and preserves unrelated sessions. Password/account-security changes revoke that account's older sessions. Cleanup retains expired/revoked rows for seven days before purging.

Production session/pre-session cookies use __Host- names, Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain. Explicit development/test loopback HTTP uses separate unprefixed names and omits Secure; production rejects that override. See [auth-sessions.md](auth-sessions.md).

## F. CSRF, CORS and Rate Limiting

Pre-authentication proofs protect registration/login CSRF. Proofs are tied to a random HttpOnly pre-session/session cookie via a versioned HMAC; only proof/nonce hashes are stored. Guest proofs are consumed transactionally on successful mutations; authenticated proofs remain stable for that session and fail after expiry/revocation. Mutation Origin must exactly match configuration, and unsafe bootstrap origins/Fetch Metadata are rejected. No credentialed/wildcard CORS headers are emitted.

SQLite fixed-window limits are shared across workers using the same database: registration source 5/hour and username/email 5/hour; login source 20/15min plus identifier/resolved account 10/15min; bootstrap/logout source 60/min. X-Forwarded-For is ignored. Source limits group clients behind a proxy/NAT; multi-host deployments with independent files need a shared store/gateway design. KDF concurrency is explicitly process-local, not a global claim. See [auth-operations.md](auth-operations.md) for limits, transport trust and scaling constraints.

## G. Database Changes

Only `0003-authentication.sql` is new. Applied migrations `0001-legacy.sql` and `0002-foundation.sql` are unchanged.

- AccountCredentials: private normalized unique username/email, Argon2id hash, active/disabled status, auth_version, timestamps and user FK.
- Sessions: additive auth_version default 0, preserving legacy rows while refusing automatic authentication.
- AuthChallenges: hash-only pre-session/CSRF records with expiry and capacity control.
- AuthRateLimits: hashed bucket keys and durable transactional counters with expiry.
- New username reservation/credential-version triggers prevent new case-folded collisions, immutable credential identity changes and session revival after account-security changes.

Existing users, profiles, contacts, messages, ciphertext, logs and applied checksums are preserved in upgrade tests. Case-ambiguous legacy usernames remain intact and reserved. A consistent backup of the tracked original database upgraded to version 3 with one legacy user preserved, zero credentials created, empty foreign-key violations and integrity_check=ok. SHA-256 checks confirmed the original database/WAL/SHM were unchanged. No default passwords, enrollment or destructive reset was performed.

## H. Files Changed

All paths are repository-relative and Database Team-owned.

| Exact path | Reason |
| --- | --- |
| DATA/package.json | Pin Argon2 and add the cleanup script. |
| DATA/package-lock.json | Reproducible existing dependency graph plus the new Argon2 dependency. |
| DATA/.env.example | Safe explicit auth/transport/Origin configuration template. |
| DATA/.env.example.txt | Preserve the original environment-template entry point. |
| DATA/README.md | Current auth setup/contracts and closed legacy-route status. |
| DATA/server.js | Replace singleton/unprotected mounting with the existing Express backend's start factory. |
| DATA/server/app.js | Injected Express composition, transport/Origin gate, safe error responses and closed legacy routes. |
| DATA/server/start.js | DB ownership, ready/start/shutdown and bounded HTTP server settings. |
| DATA/server/auth/config.js | Strict Origin, environment, cookie, TTL and trusted-proxy configuration. |
| DATA/server/auth/security.js | Token/verifier/CSRF primitives, strict cookies and transport/Origin checks. |
| DATA/server/auth/errors.js | Fixed public error codes/status/field shapes. |
| DATA/server/auth/passwords.js | Real Argon2id verification, salts, dummy work, bounds and upgrades. |
| DATA/server/auth/validation.js | Explicit registration/login input policy and unknown-field refusal. |
| DATA/server/auth/rateLimiter.js | Replaceable atomic SQLite-backed limiter. |
| DATA/server/auth/service.js | Credential/session/proof lifecycle, normalization and bounded password work. |
| DATA/server/auth/middleware.js | Reusable authoritative req.auth and CSRF middleware. |
| DATA/server/auth/adapters.js | Kiro-compatible session resolver/checkSession and AiCsrfVerifier shapes. |
| DATA/server/routes/auth.js | Existing Express conventions for the five auth routes. |
| DATA/server/database/authRepository.js | Private transactional account/session/proof operations extending DB-1. |
| DATA/server/database/repositories.js | Backward-compatible optional session auth_version and safe duplicate classification. |
| DATA/server/database/migrations/0003-authentication.sql | Additive DB-2 schema/constraints/triggers; no credential enrollment. |
| DATA/scripts/auth-cleanup.js | Operational expiry/verifier cleanup with aggregate-only output. |
| DATA/tests/auth-http.test.js | Real HTTP registration/login/logout/session/process-restart/security regressions. |
| DATA/tests/auth-security.test.js | CSRF/Origin/cookies/limits/adapters/credential changes/races/error/privacy tests. |
| DATA/tests/auth-migrations.test.js | Version-2 upgrade preservation, ambiguity reservation and failed DB-2 rollback. |
| DATA/tests/support/auth.js | Isolated databases, browser-cookie fixtures and actual backend child processes. |
| DATA/tests/migrations.test.js | Retain DB-1 assertions while including schema version 3 and a later failure fixture. |
| DATA/tests/schema.test.js | Include new independent auth infrastructure tables in the existing inventory checks. |
| DATA/docs/schema.md | Current additive private/auth schema inventory and ERD relationship. |
| DATA/docs/migrations.md | Describe the new additive version and legacy preservation. |
| DATA/docs/repositories.md | Link current auth contracts and document optional session auth_version. |
| DATA/docs/auth-api.md | Human-readable endpoint/error/bootstrap contract. |
| DATA/docs/auth-openapi.json | OpenAPI 3.1 requests/responses/security specification. |
| DATA/docs/auth-sessions.md | Password, session, cookie and CSRF architecture. |
| DATA/docs/auth-integration.md | Exact frontend/realtime/Gemini dependency handoff. |
| DATA/docs/auth-operations.md | Setup, environment, rate limits, cleanup, deployment and limitations. |
| DATA/docs/db2-handoff.md | This full implementation report. |

No client/, Kiro-owned server/, Docker, root infrastructure, existing environment secrets or tracked SQLite files were modified. No Git mutations beyond working-file edits were performed in DB-2.

## I. Test Results

Environment: Windows, Node 24.20.0, npm 12.2.1, real SQLite and Argon2 bindings. Tests use unique temporary databases and synthetic accounts, not development/production credentials.

| Verification | Result |
| --- | --- |
| Full `npm test` | **133 passed, 0 failed, 0 skipped** (76 existing regressions + 57 DB-2 tests). |
| DB-1 migration regressions plus version-2 → 3 tests | Fresh/legacy/repeat/restart/rollback pass; prior checksums and original entity fields preserved. |
| Real HTTP actual backend | Register → login → cookie → me → terminate backend process → start a separate process → same session → logout → replay/protected rejection passes. |
| Concurrency/security | Two-server duplicate registration, shared limiter, session rotation/isolation, credential/proof recheck after async work, secure cookies and privacy/error tests pass. |
| Original database backup-copy upgrade | Version 3; one legacy user preserved; zero credentials created; source/sidecar hashes unchanged. |
| Fresh/repeated `npm run db:migrate` on an isolated path | Three migrations on first run; zero on repeat. |
| `npm run auth:cleanup` on that isolated path | Completed; zero records removed in the empty fixture. |
| OpenAPI | JSON parses and all internal references resolve; five auth paths reviewed. No external OpenAPI linter claim. |
| `npm audit --omit=dev --json` | Zero production advisories. Full audit has two existing moderate development-only nodemon/minimatch advisories. |
| `git diff --check`, final status/scope review | Pass; all changed/new files are under DATA; applied DB-1 migrations and tracked database files unchanged. |

Tests were executed outside the sandbox's subprocess restriction using approved test commands. No existing assertions were removed to conceal failures. Production transport was exercised using explicit trusted-proxy semantics; no real TLS infrastructure or live browser/Kiro/Google deployment was provisioned.

## J. Security Review

Implemented protections: salted memory-hard passwords, no credential projections, real durable session verification, fixed expiry, token rotation/revocation, credential-version checks, demo/legacy exclusion, pre-auth/session CSRF binding, exact Origin/transport checks, strict cookies, bounded parsing/password work, shared rate limits, transactional uniqueness and fixed safe errors with no raw logging.

Deployment limits requiring operational attention: use HTTPS and a restricted trusted-proxy boundary, shared durable SQLite for shared limits, consistent backups, controlled DB access and appropriate KDF capacity. Direct-peer rate limits are conservative behind shared proxies. Fixed windows allow boundary bursts, and per-process KDF limits multiply across workers. The existing dev-only watcher advisories remain; use npm start rather than nodemon in production. Email verification, MFA, breach-password checks and recovery/account-claim flows remain future separately reviewed capabilities. No claim of eliminating XSS, all timing side channels or every signup-availability signal is made.

Legacy data handlers are deliberately unavailable in the actual server pending object-level authorization. Their retained internal modules/DAL are trusted compatibility primitives, not authenticated public APIs. Frontend/Kiro integration remains unperformed; existing sockets need owner-wired expiry/revalidation before live use. None of these later integration tasks is represented as completed DB-2 deployment.

## K. Frontend / Kiro Handoff

See [auth-integration.md](auth-integration.md) for exact dependency shapes and files owned by each team. Codex must proxy same-origin auth, replace the static meta-only CSRF callback with bootstrap-aware retrieval, align input hints and verify the real browser flow before setting auth-ready flags. Kiro can inject `createAuthAdapters(authService)`'s SessionResolver/checkSession and CSRF verifier, explicitly configure the production cookie name, and wire trustworthy TLS context and ongoing session revalidation. `REALTIME_SESSION_COOKIE` / `AI_SESSION_COOKIE` must match the selected cookie name. No Kiro environment file was edited.

Realtime authorization/message/key adapters and DB-7's durable AiUsageStore remain outside DB-2. Gemini's handler is not mounted, AI_REMOTE_ENABLED was not changed and no real Google request was made. Phase 9B is not declared unblocked until its owner verifies the full composition.

## L. DB-3 Readiness

**DB-3 can safely begin on the completed authentication foundation. It has not been started.** Reuse the same migrated connection and injected repositories, requireAuth context, transport/Origin/CSRF gate, shared transaction helper and existing normalized profile/friend/block schema. Use userId only from req.auth, validate/project profile fields and implement explicit relationship/block/ownership policy before reopening legacy routes. Add future schema changes as new versions; do not modify applied migrations. Frontend proxy/bootstrap and realtime composition are integration dependencies, not a reason to weaken backend auth while implementing DB-3.
