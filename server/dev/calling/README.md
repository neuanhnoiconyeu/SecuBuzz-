# Local development calling backend

This separate harness supplies **two in-memory development accounts** and one fixed direct conversation to SecuBuzz's existing realtime signaling and LiveKit services. It does not import test fixtures, change production authentication, read/write a database, or add call features. The normal `npm start` and package exports are unchanged.

## Start

Requires the same Node version as `server/` (22.18+).

```powershell
cd D:\Project\SecuBuzz-\server
Copy-Item dev\calling\.env.example dev\calling\.env
# Edit dev/calling/.env: set two distinct private development passwords (12+ characters).
npm.cmd run dev:calls
```

The command reads `server/.env` first, then `server/dev/calling/.env`. Existing process environment variables take precedence over env files. The development `.env` is gitignored. Do not commit credentials.

Required harness settings:

```dotenv
NODE_ENV=development
SECUBUZZ_DEV_CALLS_ENABLED=true
DEV_CALLS_PORT=5101
DEV_CALLS_APP_ORIGIN=http://localhost:3000
DEV_CALLS_ALICE_PASSWORD=<private password for alice>
DEV_CALLS_BOB_PASSWORD=<different private password for bob>
```

Startup rejects production, unset/test `NODE_ENV`, missing opt-in, external/wildcard browser origins, invalid ports, or missing/identical/short development passwords. Binding is hardcoded to `127.0.0.1`; a non-loopback `DEV_CALLS_HOST` is rejected. Development modules also throw on import when `NODE_ENV=production`.

## LiveKit

For real media, configure a running LiveKit server accessible to the backend and both browsers:

```dotenv
LIVEKIT_ENABLED=true
LIVEKIT_URL=wss://<your-livekit-host>
LIVEKIT_API_KEY=<server API key>
LIVEKIT_API_SECRET=<server API secret>
```

The existing configuration requires a printable API secret of at least 32 characters. `ws://127.0.0.1:7880` is allowed for a local LiveKit server in development. This harness does not launch LiveKit or generate its credentials. Keys/secrets stay server-side.

`LIVEKIT_ROOM_CONVERSATIONS` is not needed for the single direct conversation. This harness does not configure catalog Voice Rooms or their group policy. Without valid LiveKit settings, development authentication and signaling still run, but `/api/calls/token` returns `503 livekit_unavailable`. `GET /healthz` reports `mediaConfigured`, which indicates configuration, not successful network connectivity.

When configured, the harness uses the actual `createDirectCallMediaLifecycle(config)` implementation and its RoomService API. Accepted calls receive private two-participant rooms through the existing authenticated token endpoint. Hangup, session loss and logout use the existing termination/room cleanup flow. Tests inject a room-service double; normal startup does not.

## Accounts and conversation

| Login identifier | Server-owned ID | Public label |
| --- | --- | --- |
| `alice` | `call-dev-alice` | Alice (calling development) |
| `bob` | `call-dev-bob` | Bob (calling development) |

Their sole conversation is `calling-dev-alice-bob`. It has exactly those two participants and no blocked pairs. The session resolver, membership/presence authorizer and direct-conversation resolver all use this fixed server-owned data. Arbitrary user registration, account IDs, conversation grants and caller IDs cannot be supplied through the HTTP interface.

Public identities use the existing API-mode `AuthUser` shape (`isDemo: false`) because this is an authenticated backend fixture, rather than the browser's unauthenticated demo adapter. They remain explicitly named development identities, are never persisted, and cannot be used by the production executable.

## HTTP bootstrap

All responses are private/no-store. The cookie is `secubuzz_dev_call_session`, with HttpOnly, SameSite=Strict, path `/` and a one-hour lifetime. HTTPS app origins add Secure. Session and CSRF values are random, ephemeral and never logged. Session creation is bounded; restart clears all fixture state.

| Route | Behavior |
| --- | --- |
| `GET /api/dev-calling/bootstrap` | Creates an anonymous bootstrap cookie if needed; returns `csrfToken`, the two public users, fixed `conversationId`, and media configuration readiness |
| `POST /api/auth/login` | Exact JSON `{ "identifier": "alice" or "bob", "password": "configured password" }`; requires bootstrap cookie, its `X-CSRF-Token`, and exact configured Origin |
| `GET /api/auth/me` | Returns `{ user }` from the authenticated cookie, or `{ user: null }` |
| `GET /api/dev-calling/context` | Authenticated user, the other participant, and the fixed direct conversation; anonymous requests get 401 |
| `GET /api/dev-calling/status` | Authenticated, read-only LiveKit API probe; returns `available`, `unavailable`, `disabled`, or `unconfigured`; checks are bounded and cached for five seconds |
| `POST /api/auth/logout` | Requires session cookie/CSRF/Origin; revokes the session, disconnects its sockets and clears the cookie |
| `POST /api/calls/token` | Existing handler, accepting `{ callId, connectionId }` only after authenticated acceptance and endpoint ownership checks |
| `/socket.io` | Existing authenticated Socket.IO signaling, with the same cookie session and membership checks |

Login rotates the cookie, session ID and CSRF token, and revokes any replaced session. Its response includes `{ user, csrfToken }`. After login, refresh your frontend CSRF bootstrap using that token or fetch `/api/dev-calling/bootstrap` again with the new cookie. A pre-login token cannot authorize post-login media requests. No cookie/session token belongs in localStorage or a browser-readable environment variable.

Use `Origin: http://localhost:3000` (or your exact configured `DEV_CALLS_APP_ORIGIN`) for mutations and Socket.IO connections. HTTP requests with external Host/Origin or cross-site fetch metadata are rejected. There is no permissive CORS fallback. Example direct API tooling should also send this Origin; its cookie jar must retain the Set-Cookie response.

## Next.js integration

The opt-in development integration now routes authentication, development context/status, call tokens and Socket.IO through Next's **same-origin external rewrite proxy**, including polling and WebSocket upgrades. It does not proxy unrelated messaging, database, registration or Voice Room policy endpoints. Normal production routing and authentication remain unchanged; enabling the private proxy flag outside `next dev` refuses startup.

In a second terminal:

```powershell
cd D:\Project\SecuBuzz-\client
Copy-Item dev\.env.calling.example .env.development.local
# Edit NEXT_PUBLIC_LIVEKIT_URL to exactly match the backend LIVEKIT_URL.
npm.cmd run dev -- --hostname 127.0.0.1
```

The example enables `SECUBUZZ_DEV_CALLS_PROXY=true`, a private `DEV_CALLS_BACKEND_URL=http://127.0.0.1:5101`, and public API-auth/realtime/LiveKit/development-workspace flags. It contains no credentials. The browser still uses `http://localhost:3000`; this must match both `DEV_CALLS_APP_ORIGIN` on the backend and `NEXT_PUBLIC_REALTIME_URL` on the frontend. Keep one hostname consistently in browser URLs; cookies belong to that hostname. Restart both servers after changing settings. If port 3000 is busy, choose a port explicitly and update both origins instead of letting Next silently choose another port.

Open `http://localhost:3000/login` in **two separate browser profiles**. Sign in as Alice in one and Bob in the other using the configured development passwords. Ordinary same-profile tabs share the session cookie and cannot represent two different users. The API workspace shows the actual authenticated peer and Voice/Video call buttons connected to the existing `DirectCallsRuntime`; the demo workspace remains a UI preview.

The real test view requires development opt-in, API authentication, and a matching authenticated non-demo identity. It mounts the existing `ApiRealtimeConnection` once and shares `DirectCallActions` with conversation headers. LiveKit API availability and signaling readiness are displayed separately from call status. They never mark a call Connected. The existing call window shows Connected and starts duration only after the SDK media room is connected and its authorized remote peer has joined.

To exercise the UI, leave both users signed in, place a voice or video call, and accept or decline it in the other profile. Outgoing hangup cancels a ringing invitation; hangup after acceptance ends the session and releases media for both users. Microphone capture starts after acceptance, and video calls also request the camera. Use the existing floating panel to mute, toggle camera, minimize/expand or hang up. Close a finished call panel before placing another call. If only one participant reaches LiveKit, the call stays Connecting and then fails safely; no timer or server acceptance can fabricate a Connected state. Camera permission failure preserves the voice session and shows the existing retryable device error.

The development auth wrapper obtains an anonymous synchronizer token before login, preserves all `HttpAuthService` validation and same-origin cookie behavior, then re-fetches the token after the backend rotates the session. It publishes only CSRF into the existing meta-token interface used by LiveKit, restores it on page reload, and removes it on logout. Session cookies and LiveKit tokens are never put in browser storage. Missing bootstrap data blocks credential submission. Registration is intentionally unavailable for this fixed fixture.

The workspace resolves its target through authenticated `/api/dev-calling/context`. Calls stay on the single existing socket and media runtime, including incoming notifications, floating panel and cleanup. A read-only authenticated status check calls the actual LiveKit RoomService API; no room is created by that check. Call buttons stay disabled when the service is unreachable or frontend media/signaling is unconfigured. Use **Retry service check** after starting/fixing LiveKit. Runtime failures after a successful probe still flow through the existing token and media error/cleanup paths. The status probe confirms backend API access; microphone/camera permission, browser WebRTC/ICE connectivity and remote media must still be tested by placing a call.

No real LiveKit URL or credentials were configured during integration. Supply your own service credentials on the backend only; the frontend receives only the matching public URL. If running LiveKit locally, ensure its media ports and advertised address are reachable by both browsers. A loopback LiveKit URL is suitable only when both browser profiles run on that same computer. This harness deliberately cannot serve remote test devices.

## Verification

`npm.cmd run type-check` includes `dev/**/*.ts`. `npm.cmd test` includes `test/integration/development-calling-harness.test.ts`: startup/production boundaries, anonymous rejection, credentials, cookie/CSRF rotation, actor isolation, fixed membership, real Socket.IO signaling, signed accepted-call tokens and logout cleanup. Live media packet transmission still requires actual LiveKit configuration and browser integration.

From `server`, `npm.cmd run test:dev-calls-proxy` starts temporary loopback services and Next.js to verify real same-origin HTTP routing, preserved cookies/CSRF, polling-to-WebSocket upgrades, direct WebSocket connections, accepted-call token signing, RoomService SDK HTTP calls, hangup/logout cleanup, and an unavailable RoomService. Its local LiveKit HTTP protocol double validates integration without claiming audio/video transport. It shuts down only its own processes and needs the existing client/server dependencies installed. Run it without another Next development process sharing `client/.next-dev`.

Frontend tests under `client/src/dev/calling/__tests__` compose the actual test workspace, call runtime, shared buttons, incoming notification, and floating panel. Transport/SDK doubles cover decline, accept, outgoing cancellation, camera controls, cleanup, keeping drafts usable while minimized, and refusing Connected before the authorized media peer is present. They complement the real backend/proxy checks; they do not establish that audio/video packets crossed a configured LiveKit service.
