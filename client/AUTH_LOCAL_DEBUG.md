# Local authentication outage — diagnosis and recovery

For the later Profile failure with a healthy backend and successful authentication, see [the Phase 8.8 Profile hotfix](PHASE_8_8_PROFILE_HOTFIX.md). That incident was a stale pre-DB-3 process, not this earlier stopped-backend outage. DATA has since been restarted with the same development DB to load the real Profile/Friends routes.

Date: November 14, 2026. All source changes for this repair are frontend-only. Existing Phase 8.6 and DB-2 edits are retained; no commit/push or backend source/configuration change was performed.

## Root cause and evidence

Next.js was already listening on port **3000**, while **no DATA backend was listening on port 5000**. Auth defaults to a same-origin rewrite to `http://127.0.0.1:5000`; changing `NEXT_PUBLIC_API_URL` would not fix this because it does not configure auth.

Before recovery:

| Request | Observed result |
| --- | --- |
| Direct `http://127.0.0.1:5000/healthz` | `ECONNREFUSED`. |
| Frontend `http://localhost:3000/api/auth/csrf` | HTTP 500, non-JSON proxy failure. This is the bootstrap step that prevents Signup from submitting registration. |
| Frontend `http://localhost:3000/api/auth/me` | HTTP 500, non-JSON proxy failure. Startup correctly remained unauthenticated. |

`HttpAuthService.failure()` classified generic server/proxy errors as `unavailable`; that code's old message was “Authentication is not available yet. Please try again later.” The request really failed because its backend was stopped, rather than because authentication was an unimplemented feature. The configured API factory was active; neither CSRF/Origin mismatch nor fabricated session restoration caused this incident.

The earlier 80-check Phase 8.6 run used owned test services on ports 3186/5186 and stopped them afterward. It verified the implementation, but did not leave a backend running for the user's existing port-3000 frontend.

## Recovery and frontend correction

- Started the unchanged `DATA/server.js` on `127.0.0.1:5000`, with explicit development HTTP and exact frontend Origins (`http://localhost:3000,http://127.0.0.1:3000`).
- Used a separate persistent development database at `D:\Projects\SecuBuzz-\client\tmp\auth-local\development.sqlite`. This keeps original databases untouched. Keep this DB_PATH on future restarts to retain accounts created in this local session. It is ignored runtime data, not a migration/schema change.
- Kept the existing Next process on port 3000 running. No proxy, cookie, CSRF or Origin security policy was weakened.
- Added a distinct `service_unavailable` error for HTTP 5xx, including non-JSON proxy responses, and a distinct forbidden-request message for non-CSRF 403. Configuration/404, credentials, validation, CSRF and rate-limit errors retain separate meanings. Unknown responses fail as invalid responses. No raw diagnostic bodies are displayed and no automatic retry or demo fallback was introduced.
- Login's `/me` confirmation now uses the same error classification as other authentication requests.

After starting DATA, through the same existing frontend:

| Request | Result |
| --- | --- |
| `/api/auth/csrf` | **200**, valid proof present, `Cache-Control:no-store`. Proof value omitted from evidence. |
| `/api/auth/me` without session | **401 UNAUTHENTICATED**, the expected signed-out result. |
| Registration | **201**, explicit Login required. |
| Login + matching `/me` | **200**, real account entry accessible. |
| Logout + old-cookie replay | **204**, then **401**. |

## Verification

Real Chrome used **the existing `http://localhost:3000` frontend**, the actual DATA process on port 5000, real Argon2 and persistent SQLite. **36/36 checks passed**: Signup, registration without implicit sign-in, correct/incorrect credentials, matching account identity, HttpOnly cookie, refresh restoration, backend process restart with the same valid session, logout/refresh, revoked-cookie replay, protected-route rejection, backend outage and accurate error feedback, restarting DATA and successful Signup/Login recovery, account isolation, CSRF and no browser auth storage.

No application runtime/hydration errors occurred. Expected HTTP errors were observed for deliberate invalid-credential/outage/revocation cases. Normal operation showed neither the original error nor a service-availability alert. Screenshots were captured for the signed-in state and deliberate outage. Backend logs show successful port-5000 startup with empty stderr. The existing Next process's terminal stream was not attached; its actual proxied responses, browser console and network metadata were inspected instead.

| Check | Result |
| --- | --- |
| `npm run type-check -- --incremental false` | Passed. |
| `npm run lint` | Passed with two existing native-image warnings. |
| Relevant auth Jest tests | **190 passed / 12 suites**. |
| Full client Jest suite (`npm test -- --runInBand --testTimeout=15000`) | **727 passed / 60 suites**, zero failures. |
| Production build (`npm run build`) | Passed in an isolated same-drive source copy using the existing dependencies. |
| Scope/whitespace review | Checked before completion against this task's baseline. |

Local evidence: ignored `client/tmp/auth-debug-b492061e422f45c29031fa5d29f1306a/`. Its network records contain only paths/statuses and proof-presence booleans, not credentials, bearer cookies or proof values. Chrome was closed after verification; the existing Next frontend and healthy DATA backend were left running. Only the owned DATA process was restarted for tests.

## Windows startup instructions

Both services are currently running. For a **future fresh start**, use two PowerShell terminals; do not start duplicate services on occupied ports.

Terminal 1 — DATA, using the same persistent development database as this recovery:

```powershell
Set-Location D:\Projects\SecuBuzz-\DATA
$env:NODE_ENV = 'development'
$env:HOST = '127.0.0.1'
$env:PORT = '5000'
$env:DB_PATH = 'D:\Projects\SecuBuzz-\client\tmp\auth-local\development.sqlite'
$env:AUTH_ALLOW_HTTP_LOCAL = 'true'
$env:AUTH_ALLOWED_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000'
$env:AUTH_TRUST_PROXY_IPS = ''
npm start
```

Terminal 2 — frontend:

```powershell
Set-Location D:\Projects\SecuBuzz-\client
$env:NEXT_PUBLIC_AUTH_MODE = 'api'
$env:NEXT_PUBLIC_AUTH_API_READY = 'true'
$env:NEXT_PUBLIC_AUTH_API_BASE_PATH = '/api/auth'
$env:AUTH_BACKEND_URL = 'http://127.0.0.1:5000'
npm run dev -- --port 3000
```

Open `http://localhost:3000/signup` and register your own development account. If using another frontend port/hostname, update DATA's exact Origin allowlist and restart it; restart Next after changing proxy configuration. Do not direct browser credential requests across origins or disable backend checks. Production still requires an approved HTTPS/gateway deployment.

## Files changed in this repair

- `client/src/auth/authModel.ts` — distinguish configuration, service outage and security refusal messages.
- `client/src/auth/httpAuthService.ts` — classify server/proxy errors and reuse classification during login confirmation.
- `client/src/auth/__tests__/httpAuthService.test.ts` — updated service-outage expectation.
- `client/src/auth/__tests__/db2Auth.test.ts` — 5xx/non-JSON and refusal classification regressions.
- `client/src/components/auth/__tests__/AuthForm.test.tsx` — accessible outage/forbidden feedback checks.
- `client/AUTH_LOCAL_DEBUG.md` — this report and reproducible startup commands.
- `client/PHASE_8_6_AUTH_INTEGRATION.md` — link to current runtime troubleshooting.

No DATA/Kiro source fix is required for this outage. The real account's Messenger-services placeholder remains intentional until DB-3/4 services exist; realtime and Gemini composition remain separate owner-controlled work and were not enabled.
