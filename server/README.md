# SecuBuzz realtime server (Phase 8.7B)

Socket.IO 4.8 server infrastructure for SecuBuzz. It implements the Phase 8.7A client contract ([docs/realtime-client-contract.md](../docs/realtime-client-contract.md)) and fails closed until the Database and Security teams supply real adapters.

What it does today:

- Authenticates connections from the session cookie through an injected `SessionResolver` and rejects with `AUTH_REQUIRED`, `UNAUTHORIZED` or `SESSION_EXPIRED`.
- Joins only server-authorized conversation rooms from an injected `RealtimeAuthorizer`; no client event can select rooms.
- Relays typing, serves privacy-filtered presence, and routes read and delivery receipts through an injected `MessageStore`.
- Validates every event, rate limits per connection, bounds memory, and cleans up on disconnect, expiry, revocation and shutdown.
- Provides authenticated direct-call signaling when a host direct-conversation resolver is supplied: initiate, accept, decline, cancel, end, missed timeouts and state synchronization. It remains disabled in the standalone host. See [direct-call-signaling.md](../docs/direct-call-signaling.md).

What it does not do: production authentication, persistence, history, key distribution or message delivery. `message:send` answers `recipient_keys_unavailable` until both a `MessageStore` and a Security Team `RecipientKeyVerifier` exist. Without a resolver and authorizer, every connection is rejected with `REALTIME_UNAVAILABLE`.

## Commands

For an isolated, loopback-only calling backend with two authenticated in-memory development users, see [dev/calling/README.md](dev/calling/README.md). Run it explicitly with `npm run dev:calls`; it is never selected by the production entry point and refuses production startup.

Requires Node.js 22.18 or later (developed on 24.20). The source is TypeScript that Node.js runs directly; there is no build step.

```powershell
npm install
npm run type-check   # tsc --noEmit (strict, erasable syntax only)
npm test             # all TypeScript suites plus the CommonJS DB5/DB6 regression
npm run test:db5db6   # focused DB5/DB6 group and attachment API regression
npm run test:attachments # frontend attachment integration with DB6 plus the DB5/DB6 regression
npm start            # standalone fail-closed server on 127.0.0.1:5100 (reads .env if present)
npm run start:api    # separate DB5/DB6 API host on 127.0.0.1:3001 (reads .env if present)
npm run ai:check-config   # Phase 9B: sanitized AI settings report from .env; never contacts Google
```

The client compatibility test loads `../client/src/realtime/*`, so install the client's dependencies first.

The DB5/DB6 API runs from this package and requires its own `express` and `better-sqlite3` dependencies; installing the sibling `DATA/` package does not satisfy module resolution here. LiveKit and realtime use the existing `livekit-server-sdk` and `socket.io` dependencies. `dotenv` is not required by these entry points because Node loads `.env` through the startup flags.

Run these npm commands from `server/`, or use `npm --prefix server run <script>` from the repository root. npm selects the server package as the working directory, which also resolves DB5/DB6's default `database/schema.sql` correctly. The Database test and attachment integration test use isolated temporary databases/private storage. The separate `test:dev-calls-proxy` check remains opt-in because it launches Next.js. API routes still require the existing host-supplied authentication middleware; no authentication implementation is added by these scripts.

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Public API: `attachRealtimeServer`, adapter types, event names, config helpers |
| `src/main.ts` | Standalone realtime process with `/healthz`; attachment routes belong exclusively to the DB6 API host |
| `api-main.cjs`, `src/routes/attachment.cjs` | Existing DB6 upload/metadata/download API; integration: [attachments.md](../docs/attachments.md) |
| `src/attachments/db6Transport.ts` | Explicit UTF-8 filename transport and safe download headers around the unchanged DB6 API; owns no routes or storage |
| `src/calls/` | Direct-call signaling protocol and server-owned lifecycle; public types/constants at `secubuzz-realtime-server/calls` |
| `src/realtime/protocol.ts` | Canonical event names, connect-error and ack-error codes |
| `src/realtime/contracts.ts` | Adapter interfaces for the Database, Security and Phase 10 owners |
| `src/realtime/config.ts` | Option defaults, validation and `REALTIME_*` environment mapping |
| `src/realtime/server.ts` | Socket.IO wiring, connection lifecycle, sweeps and the server handle |
| `src/realtime/authentication.ts` | Handshake authentication middleware |
| `src/realtime/registry.ts`, `rooms.ts` | Connection, user and session indexes; authorized room membership |
| `src/realtime/eventGate.ts` | Argument shape, rate limits, invalid-event budget, security policy |
| `src/realtime/typing.ts`, `presence.ts`, `receipts.ts`, `messages.ts` | Event routers |
| `src/realtime/validation.ts`, `cookies.ts`, `clock.ts`, `rateLimiter.ts`, `logger.ts`, `adapterCall.ts`, `bounded.ts` | Supporting primitives |
| `src/ai/` | Phase 9B AI API (`secubuzz-realtime-server/ai`): `createAiHttpHandler`, config, consent, privacy, quota, Gemini adapter ([docs/phase9b-gemini-integration.md](../docs/phase9b-gemini-integration.md)) |
| `database/schema.sql` | Existing Database schema used by DB5/DB6 (the Database Team owns persistence) |
| `test/support/` | Test-only fixtures and harness (not exported, refuse to load in production) |
| `test/unit/`, `test/integration/` | Test suites |
| `test/ai/` | Phase 9B AI tests with mocked Gemini; a fetch trap fails any non-loopback request |

## Integration

Mount it on the API's HTTP server with real adapters:

```js
const { attachRealtimeServer } = require('../server/src/index.ts');
const realtime = attachRealtimeServer(app.listen(PORT), { allowedOrigins, sessionCookieName, sessionResolver, authorizer });
```

The full handoff (adapter contracts, cookies, revocation, idempotency, receipts, error codes, history dependencies and contract conflicts) is in [docs/realtime-server-integration.md](../docs/realtime-server-integration.md). Current validation and commit boundaries are recorded in [fullstack-push-readiness.md](../docs/fullstack-push-readiness.md).
