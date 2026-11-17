# Phase 8.6 — Real frontend authentication integration

For the current local port-3000/5000 setup, outage diagnosis and persistent development database/startup commands, see [AUTH_LOCAL_DEBUG.md](AUTH_LOCAL_DEBUG.md). A running Next frontend alone does not start DATA; the earlier integration tests used separate temporary services.

Date: November 14, 2026. Workspace: `D:\Projects\SecuBuzz-`. Branch retained: `chuong-data`, HEAD `72f4e80`. Pre-existing uncommitted DB-2 work is preserved. No Git mutation, commit or push was performed.

## A. Verdict

**COMPLETE for local real frontend authentication integration.** The actual DB-2 process, SQLite, Argon2 and Chrome were used to verify the complete account/session flow. This does not claim production TLS deployment, DB-3/4 Messenger data integration, live realtime/E2EE or Gemini enablement.

## B. Before and after

Before: the application defaulted to demo authentication. Its provisional HTTP adapter read a static meta CSRF token, accepted auto-authenticating registration and several generic logout-success shapes, and had not adopted DB-2 input rules.

After: API auth is the default; legacy demo configuration fails closed in development and production. Every mutation bootstraps CSRF, registration requires explicit login, login confirms the newly established cookie through `/me`, and logout requires DB-2's 204. Network/API errors never select fixtures. The development adapter and demo Messenger remain only for isolated UI regression harnesses; the application factory no longer imports or constructs the demo auth service.

## C. API client

Architecture: `AuthForm → AuthProvider → HttpAuthService → same-origin Next rewrite → unchanged DATA auth routes → SQLite/Argon2`.

| Endpoint | Client behavior |
| --- | --- |
| GET `/api/auth/csrf` | Validate `{csrfToken,expiresAt}` before every mutation; reject malformed or expired proof. |
| POST `/api/auth/register` | Send username/email/password/optional displayName; accept only 201 `{status:'requires-login'}`. |
| POST `/api/auth/login` | Send identifier/password and proof; validate 200 `{user}`, then require a matching authoritative `/me` identity. |
| GET `/api/auth/me` | Restore/revalidate public identity; missing, expired or revoked session is unauthenticated. |
| POST `/api/auth/logout` | Fresh proof, no body; require 204 before claiming server revocation. |

Requests use `credentials:'same-origin'`, `mode:'same-origin'`, `cache:'no-store'`, `redirect:'error'`, and a 15-second deadline covering bootstrap through parsing/confirmation. Same-origin credentials include cookies because browser requests never target a different API origin. Session bearers are never read by application JavaScript, exposed to React, logged, put in URLs or persisted in browser storage.

Unknown server strings and private response properties never enter UI state. Validation fields are allowlisted. Credentials/conflict/rate-limit/CSRF failures use fixed messages; a bounded numeric Retry-After is retained only as metadata. Mutations never automatically retry, including after CSRF rejection; an explicit retry gets a fresh proof.

## D. AuthProvider and restoration

One existing provider owns initializing/authenticated/unauthenticated state. Startup resolves `/me`; focus, visible-tab return and a 60-second interval revalidate authenticated API sessions. Concurrent service lookups coalesce. Logout can supersede restoration, abort/discard older lookups, and prevent stale callbacks from restoring or invalidating a newer actor. Service replacement immediately hides the old identity.

API registration cannot authenticate even if an injected adapter unexpectedly returns an authenticated result. Confirmed logout clears identity and unmounts account-owned state through the existing session boundary. Failed logout retains the current identity and warns that server revocation was not confirmed, with an explicit retry action.

## E. CSRF, cookies and proxy

Backend contracts: [DB-2 handoff](../DATA/docs/db2-handoff.md), [API](../DATA/docs/auth-api.md), [OpenAPI](../DATA/docs/auth-openapi.json), [integration](../DATA/docs/auth-integration.md). These documents and implementation are authoritative; no backend shapes were invented or changed.

Guest proofs are consumed by successful registration/login. The adapter never caches a proof across mutations: login bootstraps again after signup, logout obtains the session-bound proof, and later actions obtain a new guest proof after expiry/logout. A proof is not a session bearer. The static meta-only callback is no longer used by application configuration.

`authProxy.cjs` defines exactly five Next.js rewrites from the same-origin browser prefix to server-only `AUTH_BACKEND_URL`. It rejects unsafe targets, embedded credentials, query/fragment/path components and non-HTTPS production targets; development HTTP is restricted to loopback. No header rewriting, CSRF/Origin forgery, cookie-attribute rewriting, credentialed CORS or unrelated API/AI routing is added. Browser and HTTP tests verified that Cookie/Set-Cookie work, no-store survives, foreign Origin remains rejected, and a missing proof remains 403 through Next.

DB-2 uses production `__Host-secubuzz_session` / `__Host-secubuzz_preauth`, Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain. Explicit local HTTP uses unprefixed names without Secure. The browser run verified host-only/HttpOnly/Lax/path attributes and that `document.cookie` cannot read the auth cookies. Cookie names are documented for operations, never used by frontend code as authentication evidence.

Production requires an operator-controlled HTTPS same-origin deployment. Use an HTTPS upstream or route `/api/auth/*` through the approved TLS gateway; do not copy the development HTTP target into production. An absent production `AUTH_BACKEND_URL` leaves routing to that gateway. DB-2's trusted-proxy boundary remains its owner's responsibility; no production certificates or TLS termination were provisioned here.

## F. Login, signup, logout and startup

Passwords remain exactly as entered. New passwords require 15 Unicode code points and at most 1024 UTF-8 bytes, with no trimming, normalization, composition or truncation. Login accepts historical shorter passwords within DB-2 bounds. Username/email normalization and reserved names match the backend. Existing field focus, validation, password clearing, pending states, duplicate-submit locks and accessible announcements are retained; rate-limit/CSRF/network messages are safe.

Register navigates to Login with an account-created notice, without replaying credentials. Login enters authenticated state only after matching cookie confirmation. Logout returns to Login after confirmed revocation; failure never claims success. Existing legacy database users have no automatic password enrollment: use a newly registered test account rather than inventing credentials.

Terminal 1 — existing Database Team backend:

```powershell
Set-Location D:\Projects\SecuBuzz-\DATA
$env:NODE_ENV = 'development'
$env:HOST = '127.0.0.1'
$env:PORT = '5000'
$env:AUTH_ALLOW_HTTP_LOCAL = 'true'
$env:AUTH_ALLOWED_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000'
npm start
```

This uses DATA's configured persistent `DB_PATH`. Set a separate absolute path for an isolated test database if needed; never reset the existing database. Automated verification used only a unique temporary SQLite file. No dependency install or existing secret environment-file edit was needed.

Terminal 2 — frontend:

```powershell
Set-Location D:\Projects\SecuBuzz-\client
$env:NEXT_PUBLIC_AUTH_MODE = 'api'
$env:NEXT_PUBLIC_AUTH_API_READY = 'true'
$env:NEXT_PUBLIC_AUTH_API_BASE_PATH = '/api/auth'
$env:AUTH_BACKEND_URL = 'http://127.0.0.1:5000'
npm run dev
```

Open `http://localhost:3000/signup`: register → Sign In → account entry → refresh → Sign Out → refresh. Repeat with another account, wrong credentials and the backend stopped.

| Variable | Behavior |
| --- | --- |
| `NEXT_PUBLIC_AUTH_MODE` | API by default. Demo/unknown/disabled modes cannot authenticate. |
| `NEXT_PUBLIC_AUTH_API_READY` | Explicit false disables auth; absent/true permits real requests, never automatic authentication. |
| `NEXT_PUBLIC_AUTH_API_BASE_PATH` | Same-origin prefix, default `/api/auth`; never a cross-origin browser URL. |
| `AUTH_BACKEND_URL` | Server-only Next destination; development defaults to loopback port 5000, production has no default. |

Restart/rebuild Next after changing configuration. `NEXT_PUBLIC_API_URL` and legacy WebSocket configuration do not configure auth. Do not direct browser auth fetches from frontend port 3000 to backend port 5000: `credentials:'include'` does not override DB-2's same-origin/Origin/CORS policy.

## G. Protected routes and UI

`RequireAuth` protects `/` and workspace-owned profile/navigation, mounting no private content while initializing or signed out. Confirmed expiry/revocation or inability to verify identity returns to Login. `AuthOnlyRoute` redirects confirmed users away from `/login` and `/signup` using the existing safe return allowlist. No cookie-presence-only middleware or parallel auth system was introduced. Backend authorization remains authoritative.

The real-account entry deliberately retains its unavailable-services notice, showing the confirmed user and Sign Out without fabricated friends/messages/profile data. DB-3/4 providers must exist before real Messenger data can appear. Theme tokens, branding, Bungee/Space Grotesk, responsive layout, artwork, NES accents and animations were preserved.

## H. Files and ownership

Only these product/documentation paths were changed by this task:

| Paths (relative to client/) | Change |
| --- | --- |
| `authProxy.cjs` (new), `next.config.js`, `.env.example` | Same-origin auth routing and real API configuration. |
| `src/auth/httpAuthService.ts`, `src/auth/authService.ts`, `src/auth/authModel.ts`, `src/auth/AuthProvider.tsx` | DB-2 protocol, validation, configuration and race handling. |
| `src/components/auth/AuthForm.tsx` | Backend-aligned username/password hints. |
| `src/auth/__tests__/authProxy.test.ts`, `src/auth/__tests__/db2Auth.test.ts` (new) | Proxy/CSRF/session/error/deadline boundaries. |
| `src/auth/__tests__/AuthProvider.test.tsx`, `src/auth/__tests__/authModel.test.ts`, `src/auth/__tests__/authService.test.ts`, `src/auth/__tests__/developmentAuthService.test.ts`, `src/auth/__tests__/httpAuthService.test.ts` | Adopt the confirmed contract and preserve lifecycle/validation/security regressions. |
| `src/components/auth/__tests__/AuthForm.test.tsx` | Accessible rate/CSRF/network error feedback. |
| `src/components/messenger/__tests__/MessageList.actions.test.tsx` | Repair four pre-existing stale tests for main's Delete-for-me/Unsend review and asynchronous edit behavior; retain ownership, keyboard, disabled-state and callback checks. No message-action component/handler changed. |
| `src/auth/INTEGRATION.md`, `PHASE_8_6_AUTH_INTEGRATION.md` (new) | Mark old Phase 8.5 guidance as historical and provide current handoff. |

The Database Team's existing modified/new DATA files were read/tested without editing them. Kiro/server, SQLite schema/migrations/repositories, original databases, Docker, crypto/E2EE and Gemini implementation/configuration were not changed. Branch/HEAD/stash and protected-file hashes are compared with the pre-task baseline before completion.

## I. Test results

| Command/check | Result |
| --- | --- |
| Client `npm run type-check -- --incremental false` | Passed; avoids rewriting tracked tsbuildinfo. |
| Client `npm run lint` | Passed, with two existing native-image warnings. |
| Client `npm test -- --runInBand --testTimeout=15000` | **715 passed / 60 suites**, zero failures. |
| Client `npm run build` | Passed in a source copy with the existing dependency junction. |
| DATA `node --test tests/auth-http.test.js tests/auth-security.test.js tests/auth-migrations.test.js` | **57 passed**, zero failures; real HTTP/expiry/revocation/security/migration tests, unchanged. |
| Chrome + Next + actual DATA process | **80/80 assertions passed** with real Argon2/SQLite, no mock authentication. |
| Whitespace/final status/ownership | Passed: 1,463 protected files unchanged; no new non-client product files; branch/HEAD/stash unchanged. All 170 compared frontend source/config/assets match the validation copy. |

Chrome covered 1440/1024/390px Signup in Light/Dark/System, invalid input without transport, real registration without session, keyboard login, authoritative identities, HttpOnly cookies, refresh, backend process restart with the same database, logout/refresh and revoked-cookie replay, wrong/unknown credentials, duplicate registration, two-account isolation, durable registrations, Origin/CSRF/no-store/CORS behavior, actual rate limiting, backend outage and protected routes. No auth state was persisted in browser storage and no application runtime/hydration errors occurred. Screenshots were captured and visually inspected.

The initial browser setup failed before any scenario because a C:-drive copy with D:-drive dependencies triggered a Next cross-drive junction resolution error. The corrected same-drive copy passed all scenarios; no source/cache workaround was introduced for that environment issue.

Evidence is retained under ignored `client/tmp/phase86-6f3c54c6acf2455480ddc409840c39b8/`; source copies/build output under ignored workspace `tmp/phase86-validation-*` are generated validation artifacts. Only recorded owned browser/Next/backend processes were stopped and their ports released. Evidence omits passwords, bearer/CSRF values and password hashes.

## J. Security review

Only backend-confirmed sessions authenticate real users. Credentials and tokens are absent from storage, URLs, React props and logs. Proof validation/deadlines/race guards fail closed; no automatic write retry or mock fallback exists. Frontend validation and guards do not replace backend checks. Production TLS/gateway/cookie deployment still requires operator verification; local HTTP is an explicit development exception.

## K. Remaining work

DB-3 must deliver authorized profiles/friends/blocks; DB-4/5 must supply conversation/history/membership APIs. Kiro owns Socket.IO composition, ongoing expiry/revocation enforcement, message authorization/persistence and recipient-key distribution. Gemini remains gated pending its owner-approved mounting, session/CSRF composition, durable usage store and real-account workspace integration. No readiness flags or implementations for those features were changed.
