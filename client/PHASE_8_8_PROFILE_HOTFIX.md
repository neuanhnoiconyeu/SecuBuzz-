# Phase 8.8 Profile service hotfix

Date: November 14, 2026. Scope: `client/`; branch `chuong-data`, HEAD `72f4e806e1446ce65036f705f9f7eb82275942d9` retained.

## A. Verdict

FIXED. Runtime recovery, all six requested Chrome scenarios, full frontend tests and production build passed.

## B. Confirmed root cause

The user's existing port-5000 DATA process was healthy but still running its **pre-DB-3 module graph**. It was started at `2026-11-14T22:06:50.271Z` (17:06:50 local), before `DATA/server/app.js` and `DATA/server/routes/social.js` were updated at 17:37:43 local. A plain `node DATA/server.js` process does not reload changed modules. The old authenticated legacy users handler intentionally returned `FEATURE_UNAVAILABLE`; `/api/friends` did not exist in that process.

The frontend then incorrectly classified every social HTTP 5xx as a connection failure. This produced “The service could not be reached” even though Next's proxy, cookies, session and backend connectivity were working. Repeated Retry and logout/login could not make the old Node process load the new routes.

The earlier Phase 8.8 integration run used freshly started isolated test backends. It verified the DB-3 implementation but missed the stale process still serving the user's actual port-3000 application. This hotfix reproduced and repaired that existing runtime instead.

This was not an invented endpoint, missing user ID, CSRF bypass, invalid cookie, proxy target error or malformed valid profile response. `GET /api/users/me` is explicitly supported by DB-3's OpenAPI and actual route implementation; it returns the owner-only `{profile}` envelope. No endpoint or backend contract was changed.

## C. Evidence from the actual application

Chrome used **the existing `http://localhost:3000` Next process** and the existing port-5000 DATA process. A unique real test account was registered through the UI in the already configured development database, `client/tmp/auth-local/development.sqlite`; no original DATA-owned database was used.

| Request | Before repair | After restart with current source |
| --- | --- | --- |
| Direct `GET http://127.0.0.1:5000/healthz` | 200 `{status:"ok"}` | 200 `{status:"ok"}` |
| Authenticated `GET http://localhost:3000/api/auth/me` | 200, valid real user | 200, same valid session |
| Authenticated `GET http://localhost:3000/api/users/me` | **503 `{code:"FEATURE_UNAVAILABLE",fields:[]}`**, including explicit Retry | **200 `{profile:{id,username,displayName,avatar,statusMessage,presencePreference,isDemo:false}}`** |
| Unauthenticated `GET /api/friends` through Next and directly to DATA | 404 `NOT_FOUND` | 401 `UNAUTHENTICATED` from the now-mounted DB-3 router |

The failed request reached DATA; it was not canceled or blocked before transmission. Before/after responses, methods and complete public request URLs are captured in `artifacts/phase8-8-hotfix/browser-evidence.json`. Identity/profile response values are redacted. Cookies, CSRF values, passwords and session tokens are never logged.

There were zero unhandled JavaScript runtime exceptions in Chrome. Expected failing HTTP responses are captured as network evidence. The original Next terminal stream was not attached, so no historical frontend terminal log is claimed. The existing DATA startup stdout reported its port with empty stderr; both newly owned restart logs likewise contain the single port-5000 startup message with empty stderr. Runtime log files are retained under ignored `client/tmp/profile-hotfix-82c45c1d-59e4-4c96-914b-5fbee79e0414/`.

## D. Smallest correct repair

1. Restarted only the positively identified, previously owned DATA process. Kept the same port, exact frontend Origin allowlist, eight-hour session setting and persistent database path. Startup loaded the existing DB-3 source/migration through the normal server entrypoint. Existing accounts and sessions were retained. DATA source, configuration files and migration definitions were not edited.
2. The original Next process stayed running on port 3000. No cache deletion or proxy change was needed. In the original browser session, clicking Try again returned the real profile without another login.
3. Added fixed `feature_unavailable` and `service_unavailable` API errors. A 503 with `FEATURE_UNAVAILABLE` now reports that Profiles & Friends are not enabled on the connected service; other 5xx report temporary service unavailability. Genuine transport failures retain connection guidance.
4. Reused a single HTTP classification helper for social responses and their `/api/auth/me` identity checks. Forbidden, missing, conflict, throttling, server and invalid-JSON responses retain their actual meanings. Successful responses with invalid JSON are classified as invalid responses, not network errors. Raw diagnostics never enter UI messages.

HttpOnly same-origin cookies, fresh CSRF before mutations, request deadlines, account/generation guards, privacy projection, cancellation and no automatic mutation retries remain intact. There are no mock profiles or fallback identities, and no UI redesign or unrelated service refactoring.

## E. Exact hotfix paths

Production code:

```text
client/src/api/sessionApi.ts
client/src/auth/httpAuthService.ts
```

Tests, diagnostic runner and handoff links:

```text
client/src/api/__tests__/sessionApi.test.ts
client/scripts/verify-profile-hotfix.cjs
client/PHASE_8_8_PROFILE_HOTFIX.md
client/PHASE_8_8_PROFILES_FRIENDS_INTEGRATION.md
client/AUTH_LOCAL_DEBUG.md
```

Reviewable verification artifacts:

```text
client/artifacts/phase8-8-hotfix/browser-evidence.json
client/artifacts/phase8-8-hotfix/jest-results.json
client/artifacts/phase8-8-hotfix/ownership-audit.json
client/artifacts/phase8-8-hotfix/before-profile-feature-unavailable.png
client/artifacts/phase8-8-hotfix/after-profile-recovered.png
client/artifacts/phase8-8-hotfix/temporary-outage.png
client/artifacts/phase8-8-hotfix/account-switch-profile.png
```

Ignored client runtime state includes the existing development DB/WAL, backend ownership PID record and new Chrome/log directory. The backend is left healthy on port 5000 using the same development database; only the diagnostic Chrome process is closed. The existing Next process remains running. Build cache changes are generated under client; the tracked TypeScript incremental cache is returned to its pre-hotfix content.

## F. Automated checks

| Check | Result |
| --- | --- |
| Targeted API/profile/hook regression tests | **43 passed / 3 suites**, zero failures |
| TypeScript | PASS — `npm run type-check -- --incremental false` |
| ESLint | PASS — two existing native-image warnings in MessageComposer/MessageList |
| Full Jest | **794 passed / 66 suites**, zero failures; `npm test -- --runInBand --testTimeout=15000 --json --outputFile=artifacts/phase8-8-hotfix/jest-results.json` |
| Production build | PASS — all six static pages generated; `/`, `/login`, `/signup` compiled |
| Whitespace / ownership / branch audit | PASS — `git diff --check`; all 54 outside-client baseline paths unchanged; branch/HEAD unchanged |

Eleven added regressions cover the confirmed reachable-backend `FEATURE_UNAVAILABLE` response, same-session explicit retry/recovery, identity-check HTTP classification, actual transport failures, malformed identity/profile JSON, non-JSON proxy errors and safe diagnostics. Existing 401 invalidation, old-account response guards, profile validation, failed-save draft preservation and all Friends tests remain in the full suite. No test was weakened, skipped or removed; the prior generic 503 expectation was corrected to the new service-error category.

## G. Actual Chrome scenarios

**12/12 assertions passed**, including the pre-fix reproduction. All six requested scenarios were executed:

1. Real account login and Profile loading: first reproduced 503 while `/api/auth/me` succeeded, then recovered through the same dialog/session after the runtime restart.
2. Changed display name and status, saved, closed and reopened; confirmed the server's updated values.
3. Refreshed the page, restored the session, and loaded the persisted private profile.
4. Logged out and back in; the profile loaded normally.
5. Held the initial profile request at the browser's request stage, stopped the actual DATA process, then released the request so the real Next proxy failed against the stopped backend. Verified an error with the valid account retained, restarted DATA with the same DB, clicked Try again and recovered without login. No HTTP response was mocked.
6. Used a second real registered account to search, send/accept a request, list the confirmed friendship, block, view the blocked list and unblock. Switched the original browser to that account and confirmed that the prior private status/profile did not leak.

The diagnostic runner requires an explicit ownership record and refuses database paths outside client/tmp. For an already repaired local environment, run from client:

```powershell
node scripts/verify-profile-hotfix.cjs --backend-record tmp/auth-debug-b492061e422f45c29031fa5d29f1306a/owned-backend.json --verify-only
```

This verifies normal behavior, profile persistence, logout/login, temporary outage/retry and Friends on the existing local services. Without `--verify-only`, it first requires the reported stale-backend failure, saves its evidence, and pauses for the `repair` command before restarting the owned server. Do not restore an old backend solely to recreate this historical incident. `HOTFIX_FRONTEND_ORIGIN` and `CHROME_PATH` can override the local frontend/Chrome path.

## H–J. Regression, remaining issues and ownership

Authentication and consent-based Friends remain functional. The anonymous profile/Friends endpoints correctly return 401 after recovery. No backend source correction is required. There is no unresolved Profile loading defect in the verified local environment. Messaging, realtime presence, AI and deployment/TLS remain outside this repair, as in the Phase 8.8 handoff.

Normal future startup commands remain in `AUTH_LOCAL_DEBUG.md`. After changing DATA source, restart the DATA process using the **same DB_PATH**; successful `/healthz` alone does not prove that an older Node process loaded new feature routes. Do not clear the database or sessions to recover from this problem. The frontend process does not restart the separate DATA server.

The final audit compares the pre-hotfix dirty-tree baseline (106 files) with the final state. All 54 outside-client files retain identical SHA-256 hashes; no new outside-client change exists. Existing user work and all prior Phase 8.8 artifacts are preserved. The 14 hotfix files (seven source/test/docs files and seven verification artifacts) are listed in `artifacts/phase8-8-hotfix/ownership-audit.json`. There are no branch changes, commits, pushes, reset, stash, clean, merge or rebase operations.
