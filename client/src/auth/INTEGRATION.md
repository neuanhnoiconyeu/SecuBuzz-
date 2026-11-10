# Phase 8.5 — Authentication UI and session boundary

## Implemented frontend

The existing Next.js 14 App Router now has `/login`, `/signup`, and the protected `/` Messenger entry. One `AuthProvider` lives inside the existing `ThemeProvider`. `AuthOnlyRoute` redirects authenticated users away from auth forms; `RequireAuth` mounts no Messenger content while initializing or unauthenticated. Restoration renders branded loading content, including in server-rendered HTML. These client guards are UX controls. The backend must authorize every protected read and write.

The Login and Sign Up forms reuse Yahoo artwork, Bungee/Space Grotesk, semantic theme colors, shared fields/buttons, and the existing appearance selector. Required fields, email format, confirmation, accessible error focus, password visibility, duplicate submission locks, loading, and sanitized service errors are implemented. Identifiers are trimmed; passwords are never trimmed, normalized, logged, or persisted. Submitted password fields clear after accepted requests and failures. Remember me is omitted because no backend session-duration policy exists.

Username validation is a provisional UI rule (3–30 ASCII letters, digits, `.`, `_`, `-`). Password validation currently requires a value only: no speculative complexity, minimum length, or maximum length is imposed. The backend team must ratify both policies; frontend checks do not replace its validation. Email is submitted for real registration only and is not part of the public auth identity.

Registration explicitly returns either `{ status: 'authenticated', user }` or `{ status: 'requires-login' }`. The first updates centralized state and lets the auth-route guard perform one navigation; the second opens Login with a success message. There is no automatic password replay or guessed session behavior.

## Development demo

From `D:\Projects\SecuBuzz-\client`:

```powershell
npm run dev
```

Open `http://localhost:3000/login`. In development, unset `NEXT_PUBLIC_AUTH_MODE` defaults to the explicitly labeled demo adapter. It may also be set to `demo` before starting Next. Use **Continue as Demo User** for Demo Explorer or **Try Nova Demo User** for Nova Explorer. The ordinary forms can also use fictional sample values to create a temporary synthetic identity. Never enter a real password in demo mode: credentials are not verified, there is no account directory, and no real account is created.

- Explorer preserves the existing `local-user` fixture identity; Nova uses `demo-session-nova`.
- Synthetic form sign-ins receive fresh demo IDs. Mock registration derives a demo-prefixed identity from the provisional username, without storing email/password or implementing a credential database.
- `getCurrentUser` returns the same public identity during the current in-memory session. Refresh or a new tab ends that demo session. Theme preference remains an independent non-sensitive browser preference.
- Sign Out in Profile clears the confirmed demo session. A new session gets fresh profile/friends/conversation state, drafts, message state, transport listeners, and ephemeral key-manager instances, even when signing back in as the same demo user.
- Browser demo authentication is unavailable in a production build, even if `NEXT_PUBLIC_AUTH_MODE=demo` is supplied. The factory, development adapter, centralized provider, and demo workspace each enforce this boundary. Demo identities are rejected by the real API adapter.
- Local profile editing, fictional friendship actions, SecureBot replies, and direct/group preview conversations remain explicitly local. No real user receives a message. Existing new-DM creation, group-member selection, recipient key exchange, and realtime service gaps remain unchanged.

## Production and API configuration

`npm run build` / `npm start` uses an unconfigured, fail-closed auth service until an approved backend contract is explicitly enabled. Login/Sign Up remain visible with an honest unavailable-service notice; there are no demo login controls and Messenger remains guarded. An API error never selects the demo adapter.

Proposed opt-in configuration:

```text
NEXT_PUBLIC_AUTH_MODE=api
NEXT_PUBLIC_AUTH_API_READY=true
```

These public build-time flags contain no secrets and do not create endpoints. Set them only after the database/auth owner ratifies the contract below. Changing public flags requires restarting development or rebuilding production. The current factory reads a synchronizer token from `<meta name="secubuzz-csrf-token" content="…">`; that token must be supplied by the approved backend/session bootstrap, **not** hard-coded into source or public environment variables. Integrators may instead inject a `getCsrfToken` callback into `HttpAuthService` to match their agreed bootstrap/rotation strategy. Missing or invalid CSRF data prevents every credential-bearing mutation, including login and registration.

API sessions that restore successfully show the confirmed public identity. Real profile/friends/conversation providers do not exist in this repository, so they receive a clear “Messenger services are not connected yet” state with Sign Out. Real users never silently receive fictional local messenger data. Connecting those services belongs to the later integration phase.

## Proposed backend handoff

No handlers, schema, password hashing, or session database were added. Endpoint paths below are configurable same-origin paths and remain proposed contracts.

| Operation | Method/path | Request | Successful response |
| --- | --- | --- | --- |
| Login | `POST /api/auth/login` | `{ "identifier": "username-or-email", "password": "exact input" }` | `200 { "user": AuthUser }` plus backend session cookie |
| Register | `POST /api/auth/register` | `{ "username": "…", "email": "…", "password": "exact input", "displayName"?: "…" }` | `200/201 { "status": "authenticated", "user": AuthUser }` with cookie, or `{ "status": "requires-login" }` |
| Restore | `GET /api/auth/me` | No body | `200 { "user": AuthUser }`, `200 { "user": null }`, or `401` for no session |
| Logout | `POST /api/auth/logout` | No credential/token body | `204`, `200 { "success": true }`, or `401` confirming the session is already absent; revoke cookie/session server-side |

The public identity is a projection of the existing `UserProfile`, not a second user record:

```ts
type AuthUser = {
  id: string;           // Stable, authoritative backend identifier
  username: string;
  displayName: string;
  avatar: ProfileAvatarId; // Existing initials/smile/star/rocket/cat contract
  isDemo: false;        // Required for real API responses
};
```

The adapter allowlists these fields, rejects malformed identities and reserved demo identifiers (`local-user`, `demo-*`, `demo_*`, `demo:*`), and discards unexpected fields such as tokens/private data. Agree any avatar URL extension with the profile owner before changing this model. Server actors must come from the session, never from submitted client identity.

For errors, the proposed body is `{ "fields"?: ["identifier", "username", "email", "password", "displayName"], "code"?: "owner-defined" }`. Only recognized field names are used to select fixed client messages; server strings, stack traces, account details, and response bodies are not rendered or logged. The `code` is reserved for owner agreement and is not currently trusted for authorization or user-facing copy.

| Response | Frontend behavior |
| --- | --- |
| Login `401` | Generic invalid-credentials message, without identifying which account field exists |
| Registration `409` | Generic account-unavailable message, without revealing whether email or username exists |
| `400` / `422` | Safe field-level validation for allowlisted field names |
| Session `401`, confirmed null user, invalidation event | Clear authenticated UI and isolate old session state; return to Login |
| `403` | Safe unauthorized feedback; the backend remains authoritative |
| Network/timeout/`5xx` | Safe unavailable/network feedback; no mock fallback and no automatic write retry |
| Malformed successful response | Fail closed; do not authenticate |
| Failed logout | Keep current local authenticated state and show that server revocation could not be confirmed |

Every request has a 15-second deadline covering CSRF bootstrap, fetch, and JSON consumption. Mutations are serialized in the provider and form. The adapter does not retry writes whose outcomes may be ambiguous. Login/register success responses are accepted only from the configured service; stale requests from a replaced provider/service cannot restore an old actor.

## Session, CSRF, and CORS requirements

- The backend owns opaque session creation, validation, expiration, regeneration, revocation, and cookie deletion. Prefer Secure, HttpOnly cookies with the agreed SameSite policy and narrow scope. No access/refresh/session token is stored in localStorage, sessionStorage, IndexedDB, or React state by this implementation.
- The current adapter uses `credentials: 'same-origin'`, `mode: 'same-origin'`, `redirect: 'error'`, `cache: 'no-store'`, JSON requests, and `X-CSRF-Token` on every mutation. It rejects external, protocol-relative, traversal, query-bearing and control-character endpoint configurations. Credentials are not sent to guessed cross-origin services.
- SameSite is not the complete CSRF design. The owner must implement and verify the CSRF token bootstrap/rotation, request-token validation, allowed Origin/Referer policy, and cookie behavior for login, registration and logout.
- Cross-origin development is not enabled by this adapter or the current CSP. If required, the team must agree an exact origin allowlist, credentialed CORS (no wildcard origin), HTTPS/cookie SameSite rules, CSRF validation and CSP changes before extending the client. The existing generic API URL environment example is not automatically used for auth.
- `GET /me` restores session on initialization and rechecks API sessions on focus, visibility return and a 60-second interval. Confirmed expiry removes protected content and disposes the old workspace. A failed session verification fails closed locally without claiming server revocation.
- No refresh endpoint is called. Decide whether server cookies slide automatically or whether `/api/auth/refresh` is required, with its CSRF/rate-limit/rotation semantics, before adding an adapter method. There is no speculative refresh loop or stored refresh token.
- Intended destinations are strictly allowlisted: `/`, `/#chats`, `/#friends`, `/#security`. External URLs, encoded redirects and auth-page loops resolve to `/`. The existing Messenger reads supported hashes after mount.

These boundaries follow [Next.js 14 authorization guidance](https://nextjs.org/docs/14/app/building-your-application/authentication), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), and [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html). Backend policy and authorization still require owner review and end-to-end verification.

## Existing application integration and ownership

The existing page UI was extracted to `components/messenger/MessengerApp.tsx`; it was not replaced. The root page now composes the auth guard and authenticated workspace. Session resources adapt the existing profile service, friends service, demo conversation participants, crypto service and transport. Only optional identity/crypto injection and local transport lifetime were added; encryption algorithms, envelopes, keys' non-extractability and transport protocol were not changed.

Auth session generation keys the whole workspace. A fresh key manager and transport are created per demo session, release their references/listeners on disposal, and reject late operations after logout. React StrictMode setup/cleanup is supported. Profile edits continue through the existing UI, and logout does not delete persisted conversations or files. The current application has no persisted conversation/file backend to modify.

The teammate branch `bon-7-8` remains unmerged and unchanged. It supplies local message actions but no auth API, DM creation service or group workflow. Phase 6 functionality is retained; canonical demo DM/group IDs are reused with the current actor's participant ID. Group creation/invitation remains absent, as documented in Phase 6.

## Files and verification

New auth code lives in `src/auth/`, new form components in `src/components/auth/`, and visual styling in `src/styles/auth.css`. Routes `/login` and `/signup` are new. Modified integration points are the root layout/page, extracted Messenger component, Profile logout entry, seeded profile/conversation fixtures, optional chat crypto-service injection, and local transport factory. Existing Messenger tests now render an explicit session fixture; separate integration tests exercise the actual guarded entry point.

Focused tests cover validation, password preservation/no persistence, safe API errors/CSRF/path validation, mock production denial, provider restoration/expiry/locks/service replacement, guards/redirect safety/no protected flash, both registration outcomes, failed logout, actor isolation, and existing Profile/Friends/DM/group preview compatibility. Required commands are `npm run type-check`, `npm run lint`, `npm test -- --runInBand`, and `npm run build` in `client`.

Browser evidence and screenshots are recorded in `artifacts/phase8-5/` separately for a production build (no demo authentication) and development mode (complete synthetic login/logout flows). Backend login, persistence, real presence, new DM/group workflows, and full multi-user E2EE cannot be claimed until their services and recipient key exchange are connected and verified. Phases 8.6, 8.7 and 9 are not started by this work.
