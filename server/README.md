# SecuBuzz realtime server (Phase 8.7B)

Socket.IO 4.8 server infrastructure for SecuBuzz. It implements the Phase 8.7A client contract ([docs/realtime-client-contract.md](../docs/realtime-client-contract.md)) and fails closed until the Database and Security teams supply real adapters.

What it does today:

- Authenticates connections from the session cookie through an injected `SessionResolver` and rejects with `AUTH_REQUIRED`, `UNAUTHORIZED` or `SESSION_EXPIRED`.
- Joins only server-authorized conversation rooms from an injected `RealtimeAuthorizer`; no client event can select rooms.
- Relays typing, serves privacy-filtered presence, and routes read and delivery receipts through an injected `MessageStore`.
- Validates every event, rate limits per connection, bounds memory, and cleans up on disconnect, expiry, revocation and shutdown.

What it does not do: production authentication, persistence, history, key distribution or message delivery. `message:send` answers `recipient_keys_unavailable` until both a `MessageStore` and a Security Team `RecipientKeyVerifier` exist. Without a resolver and authorizer, every connection is rejected with `REALTIME_UNAVAILABLE`.

## Commands

Requires Node.js 22.18 or later (developed on 24.20). The source is TypeScript that Node.js runs directly; there is no build step.

```powershell
npm install
npm run type-check   # tsc --noEmit (strict, erasable syntax only)
npm test             # node:test: unit, real-socket integration, 8.7A client compatibility, standalone smoke test
npm start            # standalone fail-closed server on 127.0.0.1:5100 (reads .env if present)
```

The client compatibility test loads `../client/src/realtime/*`, so install the client's dependencies first.

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Public API: `attachRealtimeServer`, adapter types, event names, config helpers |
| `src/main.ts` | Standalone process with `/healthz`; no adapters, so fail-closed |
| `src/realtime/protocol.ts` | Canonical event names, connect-error and ack-error codes |
| `src/realtime/contracts.ts` | Adapter interfaces for the Database, Security and Phase 10 owners |
| `src/realtime/config.ts` | Option defaults, validation and `REALTIME_*` environment mapping |
| `src/realtime/server.ts` | Socket.IO wiring, connection lifecycle, sweeps and the server handle |
| `src/realtime/authentication.ts` | Handshake authentication middleware |
| `src/realtime/registry.ts`, `rooms.ts` | Connection, user and session indexes; authorized room membership |
| `src/realtime/eventGate.ts` | Argument shape, rate limits, invalid-event budget, security policy |
| `src/realtime/typing.ts`, `presence.ts`, `receipts.ts`, `messages.ts` | Event routers |
| `src/realtime/validation.ts`, `cookies.ts`, `clock.ts`, `rateLimiter.ts`, `logger.ts`, `adapterCall.ts`, `bounded.ts` | Supporting primitives |
| `src/database/schema.sql` | Pre-existing planned schema (unchanged; the Database Team owns persistence) |
| `test/support/` | Test-only fixtures and harness (not exported, refuse to load in production) |
| `test/unit/`, `test/integration/` | Test suites |

## Integration

Mount it on the API's HTTP server with real adapters:

```js
const { attachRealtimeServer } = require('../server/src/index.ts');
const realtime = attachRealtimeServer(app.listen(PORT), { allowedOrigins, sessionCookieName, sessionResolver, authorizer });
```

The full handoff (adapter contracts, cookies, revocation, idempotency, receipts, error codes, history dependencies and contract conflicts) is in [docs/realtime-server-integration.md](../docs/realtime-server-integration.md). The Kiro spec is in [.kiro/specs/realtime-server/](../.kiro/specs/realtime-server/).
