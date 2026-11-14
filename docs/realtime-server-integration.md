# Phase 8.7B realtime server: integration handoff

This document is the handoff from the Realtime/Kiro role to the Database Team (and, for message delivery, the Security Team). It describes what the Socket.IO server in `server/` does today, the adapter interfaces it needs, and the dependencies that are still missing.

Specification: `.kiro/specs/realtime-server/` (requirements, design, tasks). Client contract: [realtime-client-contract.md](realtime-client-contract.md). Adapter type definitions with comments: `server/src/realtime/contracts.ts`.

## 1. Status

| Area | Status |
| --- | --- |
| Socket.IO 4.8 server, path `/socket.io`, namespace `/`, Origin allowlist, credentialed CORS, payload cap | Implemented and tested |
| Cookie-session authentication through an injected `SessionResolver`, error codes `AUTH_REQUIRED` / `UNAUTHORIZED` / `SESSION_EXPIRED` | Implemented and tested with test-only resolvers. **No production resolver exists.** |
| Server-authorized conversation rooms through an injected `RealtimeAuthorizer`, revocation, blocking | Implemented and tested with test-only fixtures. **No production authorizer exists.** |
| Typing relay, presence with privacy filtering and 30 s refresh | Implemented and tested |
| Read-receipt and delivery-receipt routing through an injected `MessageStore` | Implemented and tested with an in-memory test store. **No durable store exists**, so production answers `unavailable`. |
| `message:send` boundary: validation, actor binding, idempotency coordination, durable-first fan-out | Implemented and tested with test-only adapters. **Disabled in production**: no `RecipientKeyVerifier` and no `MessageStore` exist. |
| Session expiry, `revokeSession`, `disconnectUser`, periodic revalidation, reconnect, graceful shutdown | Implemented and tested |
| Real Phase 8.7A `SocketIoRealtimeClient` against this server | Tested over real sockets (`server/test/integration/client-compatibility.test.ts`) |
| Production authentication, persistence, history/replay, recipient key distribution, multi-user E2EE | **Not implemented. Not claimed.** |

The standalone process (`npm start` in `server/`) starts in **fail-closed mode** and rejects every connection with `REALTIME_UNAVAILABLE`, because it has no session resolver or authorizer.

## 2. Mounting the server

### Recommended: same process as the API

The Database Team's Express API (`DATA/server.js`) is CommonJS. Node.js can `require()` the ESM TypeScript entry directly (built-in type stripping and `require(esm)`, both on by default from Node.js 22.18), so no build step is needed. A CommonJS probe that requires `server/src/index.ts`, mounts it on an `http.Server`, serves a non-Socket.IO route and closes cleanly was run on Node.js 24.20. Phase 8.7B does not change `DATA/`; the snippet below is for the Database Team to apply when their adapters exist.

```js
// DATA/server.js (Database Team change, not applied in Phase 8.7B)
const { attachRealtimeServer } = require('../server/src/index.ts');

const httpServer = app.listen(PORT);
const realtime = attachRealtimeServer(httpServer, {
  allowedOrigins: ['https://app.secubuzz.example'],   // exact origins, no wildcards
  sessionCookieName: '__Host-secubuzz_session',        // the cookie your login endpoint sets
  sessionResolver,  // your implementation (section 3)
  authorizer,       // your implementation (section 5)
  messageStore,     // optional now; enables read and delivery receipts (section 7)
});

process.on('SIGTERM', async () => {
  await realtime.close();   // closes realtime transports; leaves httpServer open
  httpServer.close();
});
```

`DATA/` needs `socket.io` available at runtime, either by installing `server/`'s dependencies or by adding `socket.io@^4.8.4` to `DATA/package.json`.

Mounting in the API process gives the realtime server the same session store, the same cookie scope and one origin for TLS. The server keeps all realtime state in memory, so run one process. Several processes need a Socket.IO adapter (for example Redis), shared revocation and cross-node presence; none of that is implemented.

### Standalone (development and smoke tests)

```powershell
cd server
npm install
Copy-Item .env.example .env   # optional; edit values
npm start                     # node --env-file-if-exists=.env src/main.ts
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `REALTIME_HOST` | `127.0.0.1` | Bind address. Terminate TLS in front of it outside loopback. |
| `REALTIME_PORT` | `5100` | Listen port. |
| `REALTIME_PATH` | `/socket.io` | Must equal the client's `NEXT_PUBLIC_REALTIME_PATH`. |
| `REALTIME_NAMESPACE` | `/` | The client selects the namespace with the path of `NEXT_PUBLIC_REALTIME_URL`; keep `/` unless that URL has a matching path. |
| `REALTIME_ALLOWED_ORIGINS` | empty (rejects all) | Comma-separated exact origins. HTTP only for `localhost`, `127.0.0.1`, `[::1]`. |
| `REALTIME_SESSION_COOKIE` | `secubuzz_session` | Session cookie name. |

`GET /healthz` returns `{"status":"ok"}`. Everything else outside the Socket.IO path returns 404.

### Client configuration

The 8.7A client connects to `NEXT_PUBLIC_REALTIME_URL` with `NEXT_PUBLIC_REALTIME_PATH` (default `/socket.io`). It only does so when `NEXT_PUBLIC_AUTH_MODE=api`, `NEXT_PUBLIC_AUTH_API_READY=true` and `NEXT_PUBLIC_REALTIME_CONTRACT_READY=true`. Phase 8.7B does not change these flags. Keep them `false` until the adapters below exist and the end-to-end flow has been verified.

For local development against the standalone server: `NEXT_PUBLIC_REALTIME_URL=http://localhost:5100`, `REALTIME_ALLOWED_ORIGINS=http://localhost:3000`. Cookies are scoped by host, not port, so a cookie issued by an API on `localhost:5000` is sent to `localhost:5100`.

## 3. Session resolver (Database Team)

```ts
interface SessionResolver {
  resolveSession(context: HandshakeContext): Promise<SessionResolution>;
  checkSession?(session: { sessionId: string; userId: string }): Promise<SessionCheck>;
}

interface HandshakeContext {
  sessionToken: string;      // value of the configured cookie, URL-decoded. Secret.
  origin: string;            // already checked against allowedOrigins
  remoteAddress: string;     // direct peer; behind a proxy this is the proxy
  userAgent: string | null;
  secure: boolean;           // TLS on the direct connection
  receivedAt: Date;
}

type SessionResolution =
  | { status: 'authenticated'; session: { sessionId: string; userId: string; displayName: string; expiresAt: Date } }
  | { status: 'missing' }    // → AUTH_REQUIRED
  | { status: 'invalid' }    // → UNAUTHORIZED
  | { status: 'expired' };   // → SESSION_EXPIRED

type SessionCheck = { status: 'active'; expiresAt: Date } | { status: 'expired' } | { status: 'revoked' };
```

Rules:

- Look the token up in the same session store that `/api/auth/login` writes. Hash tokens at rest. Compare in constant time if you compare secrets yourself.
- Return `invalid` for unknown, revoked, tampered or foreign tokens. Do not distinguish them, and never reveal whether an account exists.
- `sessionId` must be an opaque server-side identifier, **not the cookie value**. It is used in memory for revocation and is never logged.
- `userId` must be the authoritative `AuthUser.id`. The server rejects reserved demo identities (`local-user`, `demo-*`, `demo_*`, `demo:*`) with `UNAUTHORIZED`.
- `displayName` (1–160 characters, no control characters) is used in `typing:update` and must equal `senderName` on future sends.
- `expiresAt` must be a `Date` in the future. The server disconnects the connection at that time. SQLite `DATETIME` strings have no timezone, so convert them explicitly to UTC `Date` objects.
- The handshake's `auth` object, query string and other headers are deliberately not passed. Do not try to read identity from them.
- Throwing, timing out (4 s per call, 8 s per handshake) or returning a malformed result fails closed with `REALTIME_UNAVAILABLE`. Error messages are not logged, because database errors can echo parameters.
- `checkSession` is optional. When present, it runs every 60 s per connected session. `expired`/`revoked` disconnect; `active` updates the expiry (sliding sessions). A failing check keeps the connection and logs a warning.

### Cookie and CSRF expectations

- Issue the session cookie `HttpOnly`, `Secure` (except loopback development), `SameSite=Lax` or `Strict`, with the narrowest `Path`/`Domain` that covers both the API and the realtime endpoint. Prefer a `__Host-` name when everything is served from one origin.
- Deploy the realtime endpoint on the same site as the app (same origin or a subdomain of the same registrable domain); cross-site WebSockets would need `SameSite=None`.
- The WebSocket handshake cannot carry a CSRF token. The server's defense against cross-site WebSocket hijacking is the exact Origin allowlist, checked in `allowRequest` before any session lookup and again in the namespace middleware. Keep the allowlist exact.
- Duplicate cookies with the configured name are rejected (`UNAUTHORIZED`) rather than guessed.

## 4. Session revocation

| Event in your API | Call |
| --- | --- |
| Logout, session revoked, password changed (per session) | `realtime.revokeSession(sessionId)` |
| Account suspended or deleted | `realtime.disconnectUser(userId)` |

Both close the matching connections with a server disconnect. The 8.7A client treats that as terminal (`disconnected`, no automatic reconnect) and its AuthProvider notices the ended session on its next `/api/auth/me` check (60 s, focus, visibility). A revoked `sessionId` is also refused for 10 minutes even if the store still accepts it, which closes the race with a handshake that was in flight. Logout in another process is caught by `checkSession` within one revalidation interval.

## 5. Authorizer (Database Team)

```ts
interface RealtimeAuthorizer {
  listConversationIds(actor: RealtimeActor): Promise<readonly string[]>;
  listBlockedUserIds(actor: RealtimeActor): Promise<readonly string[]>;
  filterPresenceSubjects(viewer: RealtimeActor, subjectIds: readonly string[]): Promise<readonly string[]>;
}
```

- `listConversationIds`: every direct and group conversation the user is currently a member of. Group membership must come from your membership table, never from demo fixtures or client data. At most 1,000 IDs (`maxConversationsPerUser`); more, or any invalid ID, fails the connection closed.
- `listBlockedUserIds`: users with a block relationship with the actor **in either direction** (the actor blocked them, or they blocked the actor). At most 5,000.
- `filterPresenceSubjects`: the subset of requested users whose presence the viewer may see, for example accepted friends who have not hidden their presence. The server intersects your result with the request and removes block pairs.
- The server calls the first two on every handshake and on every refresh, and the third on every `presence:subscribe` and refresh. A failure during a handshake rejects it; a failure during a refresh keeps the last verified grants, grants nothing new and logs a warning; a failure while filtering presence authorizes no subjects.

### Keeping grants current

Grants are cached per connected user. Push changes as they happen:

| Change | Call |
| --- | --- |
| Member removed from a group or DM | `realtime.revokeConversationAccess(userId, conversationId)` (immediate, no database call), then optionally `refreshUserAccess(userId)` |
| Member added, conversation created | `await realtime.refreshUserAccess(userId)` for each added member |
| Friendship accepted or removed | `refreshUserAccess` for both users |
| Block added | `refreshUserAccess` for either user (takes effect immediately) |
| Block removed | `refreshUserAccess` for **both** users. Either side's stale entry keeps the pair blocked, which fails closed. |
| Conversation renamed | `realtime.notifyConversationUpdated(conversationId, { displayName })` |
| Profile presence preference | `realtime.setPresencePreference(userId, 'available' | 'away' | 'busy' | 'invisible')` |

Commit the database change **before** making the call. The server orders authorizer snapshots: a handshake or refresh whose queries started before a revocation cannot re-grant the revoked conversation, and an older snapshot never replaces a newer one. `revokeConversationAccess` also works for a user who is not connected yet, which protects a handshake that is in flight.

Periodic revalidation (default every 60 s) repeats the refresh for every connected user as a safety net. It costs three authorizer calls per connected user per interval; tune `timing.revalidationIntervalMs` or set it to `0` once push notifications are reliable.

### Blocked-user policy

While two users form a block pair the server does not route typing, presence, receipts or messages between them, including inside shared groups. A newly blocked presence subscription receives `unknown` once and then nothing. Read receipts from a blocked reader are recorded but not sent to the sender. What a block means for conversation membership (for example hiding the DM) is your decision in `listConversationIds`.

## 6. Error contracts

Handshake rejections arrive as `connect_error` with `err.data = { code }` and a fixed generic `err.message`:

| Code | Cause | 8.7A client behavior |
| --- | --- | --- |
| `AUTH_REQUIRED` | No session cookie, or resolver `missing` | Locks the adapter and asks the AuthProvider to revalidate |
| `UNAUTHORIZED` | Malformed or duplicate cookie, resolver `invalid`, demo identity, revoked session | Same |
| `SESSION_EXPIRED` | Resolver `expired`, or `expiresAt` already passed | Same |
| `REALTIME_UNAVAILABLE` | Adapter missing, failing, slow or malformed; server shutting down | Status `error`, no reconnect, not locked |
| `CONNECTION_LIMIT` | Global (10,000), per-user (10) or pending-handshake (256) limit | Same as above |
| `ORIGIN_NOT_ALLOWED` | Origin re-check in the namespace failed (normally rejected earlier with HTTP 403/400) | Same as above |
| `POLICY_DENIED` | Optional security policy denied the handshake | Same as above |

Acknowledged events answer `{ status: 'error', code }` on failure, with `code` one of `invalid_payload`, `unauthorized_conversation`, `rate_limited`, `unavailable`, `message_not_found`, `actor_mismatch`, `idempotency_conflict`, `recipient_keys_unavailable`, `policy_denied`.

## 7. Message store (Database Team)

```ts
interface MessageStore {
  findMessage(conversationId: string, messageId: string): Promise<{ conversationId; messageId; senderId } | null>;
  recordReceipt(receipt: { conversationId; messageId; userId; status: 'delivered' | 'read'; observedAt: Date }):
    Promise<{ outcome: 'created' | 'duplicate'; recordedAt: Date }>;
  storeMessage(request: { envelope: MessageEnvelope; fingerprint: string; receivedAt: Date }):
    Promise<{ outcome: 'created' | 'duplicate'; storedAt: Date } | { outcome: 'conflict' }>;
}
```

Configuring a `MessageStore` alone enables read and delivery receipts. It does **not** enable sending; that also needs a `RecipientKeyVerifier` (section 8).

### Receipts

- `findMessage` must be scoped to the conversation: return `null` when the message ID exists only in another conversation, so the server answers `message_not_found` without revealing anything outside the reader's conversations.
- `recordReceipt` is idempotent per `(conversationId, messageId, userId, status)`. Return `created` with the stored time the first time and `duplicate` with the **original** time afterwards. The server notifies the sender only on `created`.
- `userId` is always the authenticated observer. Store per-recipient rows; never collapse a group into one receipt.
- The existing `DATA` `Messages` table has a single `receiver_id`, `delivered_at` and `read_at`, so it cannot represent group or per-device receipts, and its REST routes accept any `sender_id` without authentication. Do not back these adapters with the current unauthenticated routes.

### Message idempotency

Key: authenticated sender + `conversationId` + client message `id`. Requirements for `storeMessage`:

1. `(conversationId, id)` is unique within a conversation (unique index).
2. Same key, same `senderId`, same `fingerprint` → `duplicate` with the original `storedAt`. The server repeats the original acknowledgement and does not broadcast again.
3. Same key with a different sender or fingerprint → `conflict`. The server answers `idempotency_conflict`.
4. Atomic across processes (unique constraint plus transaction), and re-check in the same transaction that the sender is still a member.
5. Store the envelope fields unchanged: `conversationId`, `id`, `senderId`, `senderName` and `timestamp` are AES-GCM additional authenticated data on the client.

`fingerprint` is the lowercase hex SHA-256 of `JSON.stringify([id, conversationId, senderId, senderName, timestamp, type, encryption.version, encryption.algorithm, encoding, iv, ciphertext])` (`envelopeFingerprint` in `server/src/realtime/validation.ts`). Concurrent identical requests on one server are already coalesced into one `storeMessage` call.

### State meanings

| State | Meaning |
| --- | --- |
| `sent` acknowledgement | `storeMessage` reported `created` or `duplicate`, so the message is durably stored. Not delivered. |
| `message:delivered` | A recipient connection invoked the `message:new` callback with `{ conversationId, messageId, status: 'delivered' }` **and** `recordReceipt` returned `created`. |
| `message:read` (server→client) | The recipient sent `message:read`, the store found the message, and `recordReceipt` returned `created`. |

A store failure or timeout returns `unavailable`. For `storeMessage` that outcome is ambiguous (the write may have committed); a retry with the same ID is safe because of idempotency, but the 8.7A client denies retries after ambiguous failures until a status query exists (section 9).

## 8. Recipient key verifier (Security Team)

```ts
interface RecipientKeyVerifier {
  verifyEnvelope(actor: RealtimeActor, envelope: MessageEnvelope): Promise<{ verified: true } | { verified: false }>;
}
```

This is the only switch that can enable message delivery, and only together with a `MessageStore`. There is no environment flag for it. It must attest that the envelope was encrypted for authenticated recipient keys of the conversation members, which requires recipient identity keys, key distribution, key IDs and versioning, rotation and revocation. None of that exists. A structurally valid AES-256-GCM v1 envelope is not proof of multi-user E2EE, and the current client envelopes (`encryption.scope: 'browser-demo'`) are rejected outright.

Until it exists, every valid `message:send` is answered `recipient_keys_unavailable`, and plaintext, demo and malformed envelopes are answered `invalid_payload`. The future envelope will probably need new fields (key ID, recipient key versions), which means a deliberate contract change on both the server and the client.

## 9. History, replay and recovery (future contract)

Not implemented in Phase 8.7B. Socket.IO delivers at most once and this server keeps connection-state recovery disabled, so anything missed while disconnected is gone from the socket. The following is needed before real messaging:

- **Server sequence or cursor**: a per-conversation, monotonically increasing sequence assigned by `storeMessage` and returned with `message:new` and the send acknowledgement.
- **History fetch API** (Database Team, REST): `GET` messages for an authorized conversation after a cursor, paginated, with the same envelope shape.
- **Missed-event reconciliation**: on reconnect the client fetches history after its last cursor, then applies live events, de-duplicating by message ID.
- **Membership changes while disconnected**: the reconnect handshake always re-reads grants. History must be filtered by the membership periods the user actually had.
- **Ambiguous send resolution**: an endpoint or event to ask "was `(conversationId, id)` stored, and with which fingerprint?", so the client can resolve an `unavailable` or timed-out send without guessing.
- **Receipt reconciliation**: fetch receipt state with history, because receipts emitted while the sender was offline are not replayed.

## 10. Event contract as implemented

Names are defined once in `server/src/realtime/protocol.ts` and match `PROPOSED_EVENT_NAMES` in the client.

| Direction | Event | Body | Notes |
| --- | --- | --- | --- |
| C→S | `typing:start`, `typing:stop` | `{ conversationId }` | Any other field (for example `userId`) is rejected. No callback. |
| C→S | `presence:subscribe` | `{ userIds }` (≤ 1,000) | Replaces the scope. No callback, so filtering results are never disclosed. |
| C→S | `message:read` | `{ conversationId, messageId }` + callback | Success: `{ conversationId, messageId, status: 'read', timestamp, userId }`. |
| C→S | `message:send` | Envelope + callback | Disabled in production (section 8). Success: `{ conversationId, messageId, status: 'sent', timestamp }`. |
| S→C | `typing:update` | `{ conversationId, userId, displayName, isTyping, timestamp }` | Not sent to the typist's own connections or blocked users. |
| S→C | `presence:update` | `{ userId, status, timestamp }` | `online`/`away`/`busy`/`offline`; `unknown` once after losing authorization. Re-sent every 30 s. |
| S→C | `message:new` | Envelope + `deliveryStatus: 'sent'` | Only after durable storage; carries a delivery callback. |
| S→C | `message:delivered`, `message:read` | `{ conversationId, messageId, status, userId, timestamp }` | `userId` is the observing recipient. |
| S→C | `conversation:updated` | `{ conversationId, displayName?, updatedAt }` | Never grants membership. |
| S→C | `message:ack` | — | Reserved, never emitted. Send acknowledgements use the callback. |

Timestamps are server-generated ISO-8601 UTC strings and strictly increase per typing key, presence subject and conversation, because the 8.7A client ignores metadata that is not newer than the last value it saw.

## 11. Conflicts with the client contract and resolutions

| Conflict | Smallest compatible resolution | Owner of any follow-up |
| --- | --- | --- |
| The 8.7A read-ack parser accepts only the success body, so every server error acknowledgement becomes the client's `invalid_payload`. | Server sends `{ status: 'error', code }`; the client still fails closed. Mapping server codes to `unauthorized_conversation`, `unavailable` etc. is a client change. | Codex |
| The contract has no client-to-server delivery signal. | The server attaches an acknowledgement callback to `message:new`. Current clients ignore it, so no delivery receipt is produced, which is the truthful result. A client that invokes it with `{ conversationId, messageId, status: 'delivered' }` gets per-recipient receipts. | Codex |
| Session expiry or revocation of a live connection has no dedicated event. | The server disconnects (`io server disconnect`); the client becomes `disconnected` without reconnecting, and the AuthProvider's `/me` check observes the end of the session. A future `session:ended` notice would be an additive event. | Codex + Realtime |
| `message:ack` is listed as a server event, while the send promise uses a callback. | The callback is the acknowledgement; `message:ack` is reserved and never emitted. | — |
| `typing:update` needs `displayName`, which the client never sends. | Taken from the session resolver; a profile rename shows up after reconnect. The same name is required as `senderName` for sends. | Database Team (resolver) |
| Presence preferences (Busy, Away, Invisible) are local to the client. | `setPresencePreference` exists on the server. Until the profile service calls it, connected users appear `online` to authorized observers, so **Invisible is not private yet**. | Database Team (profile) |
| The URL path selects the Socket.IO namespace. | Server namespace is configurable (default `/`) and the default namespace is closed when a custom one is used. Keep `NEXT_PUBLIC_REALTIME_URL` without a path. | Deployment |

No frontend file, event name or payload schema was changed.

## 12. Limits and timing

Defaults (all configurable through `limits`, `rates` and `timing`, validated at startup):

| Setting | Default |
| --- | --- |
| Connections: global / per user / pending handshakes | 10,000 / 10 / 256 |
| Grants per user / block entries per user / presence subjects per connection | 1,000 / 5,000 / 1,000 |
| Packet size (`maxHttpBufferSize`) / ciphertext length | 128 KiB / 65,536 base64 characters (client cap is 1,400,000) |
| Pending acknowledgements / pending delivery callbacks per connection | 100 / 100 |
| Rates per connection (burst, per second) | all events 120/30, typing 10/2, read 100/20, send 10/1, presence 5/0.2, invalid 10/0.1 (exhausting the invalid budget disconnects) |
| Adapter call / whole handshake deadline | 4 s / 8 s (below the client's 5 s read and 10 s connect timeouts) |
| Presence refresh / typing TTL / revalidation / delivery callback timeout | 30 s (max 40 s) / 6 s / 60 s / 10 s |
| Envelope clock skew / heartbeat | ±5 min / ping every 25 s, 20 s timeout |

## 13. Security notes

- Logs are JSON lines with primitive fields only. Cookies, tokens, session IDs, passwords, plaintext, ciphertext, IVs and raw payloads are never logged; adapter error messages are discarded. User IDs appear only in security warnings.
- `remoteAddress` is the direct peer. If you add IP-based rules behind a reverse proxy, resolve the client address in the proxy and pass it deliberately; the server does not trust `X-Forwarded-For`.
- The optional `RealtimeSecurityPolicy` (Phase 10: Auditor Bot, Sentinel Bot, BUZZ Guard) receives metadata only, runs after authentication and authorization, and fails closed on errors and timeouts. No bot, AI call or moderation is implemented.
- Test fixtures live in `server/test/support/`, are not exported from `server/src/index.ts`, and throw when `NODE_ENV=production`.

## 14. Verification

From `server/`: `npm run type-check` and `npm test` (unit tests, real-socket integration tests, the 8.7A client compatibility test and a standalone-process smoke test). The compatibility test loads `client/src/realtime/*` and therefore needs `client` dependencies installed.

## 15. Remaining blockers before real messaging

1. Database Team: `/api/auth/*` cookie sessions and a `SessionResolver` over the same store.
2. Database Team: conversation, group membership, friendship and block tables plus a `RealtimeAuthorizer`, with push calls for membership and relationship changes.
3. Database Team: durable per-recipient receipts and idempotent message storage (`MessageStore`), plus the history and cursor API.
4. Database Team: profile presence preferences pushed through `setPresencePreference`.
5. Security Team: authenticated recipient keys, key distribution and a `RecipientKeyVerifier`, with an envelope version that carries key metadata.
6. Codex: delivery confirmation on `message:new`, mapping of server error codes, enabling sends after 1–5, and end-to-end multi-user verification.
7. Deployment: TLS, same-site cookie scope, exact origin allowlist, single process or a shared Socket.IO adapter.
