# Phase 8.7A realtime client contract

Phase 8.7C update: the server contract now exists. See [client/server compatibility and verification](phase8-7c-client-server-compatibility.md) for exact error mappings and the gated `message:new` delivery callback integration. This document retains the original 8.7A implementation boundary; default real sends and delivery confirmation remain disabled.

This is a **proposed client contract for the Realtime/Kiro and Database teams**, not evidence of an implemented server. The repository audit started from clean `main` at `418202a121eabe4770e74ab3aeda4f3680f840c5`. No Socket.IO server, authenticated rooms, recipient key distribution, replay API, or approved realtime event contract was found. The existing Database Express routes are not the `/api/auth/*` cookie-session APIs expected by the client. No backend files, schemas, crypto primitives, Kiro Hooks, or MCP infrastructure were changed.

## Implemented boundaries

| Area | Current evidence and status |
| --- | --- |
| Client abstraction | `client/src/realtime/realtimeModel.ts`: typed lifecycle, messages, receipts, typing, presence, conversation updates, errors; subscription returns cleanup. |
| Existing messaging integration | `RealtimeMessagingTransport` adapts a session client to `MessagingTransport`; `useConversationMessages` remains the sole displayed message store. No second DM store. |
| Demo | `MockRealtimeClient` is development-only and session-scoped; deterministic synthetic events, no server and no outbound decrypt/echo. |
| Socket.IO | `SocketIoRealtimeClient`, using `socket.io-client` 4.8.4. Unit-tested with an injected socket boundary. No live server integration verified. |
| Real UI | An API-authenticated account can initialize the gated connection status component. Its workspace still says profile/friends/conversation APIs are unavailable. It has no demo fixtures or fabricated server history. |
| Real sends | Disabled in composer/hook, bridge, and Socket adapter. `canSendMessages=false`; `sendMessage` rejects before any emit. |
| Groups | Existing seeded group metadata and participant lists support local messages, multiple typers and peer receipt events. No complete group CRUD/membership/invitation service was found. |

`watchConversations` is a local event allowlist, **not a room join or proof of authorization**. `watchPresence` is a requested public-user scope, not a privacy grant. The server owns both decisions.

## Configuration and authentication

The development demo follows the existing `AuthProvider` identity. Production denies mock construction and operations even when a demo flag is explicitly set. There is no API-error fallback to mock data.

Real initialization requires all of:

- API auth mode with an existing successfully resolved, non-demo identity from `AuthProvider`.
- `NEXT_PUBLIC_AUTH_API_READY=true` and the approved authentication/CSRF service (see `client/src/auth/INTEGRATION.md`).
- `NEXT_PUBLIC_REALTIME_CONTRACT_READY=true` and `NEXT_PUBLIC_REALTIME_URL` set to an approved HTTPS endpoint.
- Optional `NEXT_PUBLIC_REALTIME_PATH`, default `/socket.io`. The legacy `NEXT_PUBLIC_WS_URL` does not configure this adapter.

The URL rejects embedded credentials, query strings, hashes and unsafe characters. HTTP is permitted only for loopback development; production requires HTTPS. These public build-time settings are configuration, not secrets and not runtime proof the server is trustworthy. Keep readiness false until the contract is approved and tested.

The socket is created lazily with `autoConnect:false`, `forceNew:true`, `multiplex:false`, `withCredentials:true`, and WebSocket/polling transports. It sends no password, raw token, user ID auth override, or query credentials. The server must authenticate the HttpOnly cookie independently, bind actor identity, reject expired sessions, validate Origin, enforce credentialed CORS with explicit allowed origins, and apply its agreed CSRF/cross-site policy. Do not treat the client's `AuthUser` as authorization.

`connect_error.data.code` values `UNAUTHORIZED`, `SESSION_EXPIRED`, and `AUTH_REQUIRED` are the proposed explicit authentication rejection codes. They cancel pending work, unbind listeners, disconnect, disable reconnect and lock that adapter instance. The API UI asks the existing auth provider to revalidate the session; it does not invent a replacement identity. A fresh authenticated session must create a fresh adapter.

Logout, identity replacement, route unmount or auth invalidation disposes that session's resources. Generation checks discard old callbacks; timers, pending operations, subscribers and caches are released. Profile name changes do not replace the connection or rewrite message-authenticated metadata. The physical connection belongs to the session: switching chats or navigation sections never reconnects an intentionally offline session.

## Proposed events and payloads

Canonical names are defined once in `PROPOSED_EVENT_NAMES`. The adapter accepts an explicit typed event-name mapping to accommodate the server owner's final names; no speculative alternate names are tried. All bodies are plain objects; unknown fields fail closed. A matching optional internal `type` discriminator is accepted for normalized events, but is not required on wire bodies. Identifiers are nonempty strings up to 256 characters without whitespace/control characters. Display names are bounded to 160 characters without control characters. Timestamps are valid ISO strings with explicit timezone. Server timestamps must be authoritative and sufficiently close to client time for ephemeral freshness checks.

| Direction | Proposed event | Body / semantics | Implemented behavior |
| --- | --- | --- | --- |
| Client → server | `message:send` | Future recipient-authenticated envelope; stable `id`, `conversationId`, authenticated sender metadata, ISO timestamp, `type:'text'`, versioned `encryption`. | **Never emitted by real adapter.** Current outbound model is browser-demo only and must not be promoted to a wire send. |
| Client → server | `message:read` | `{conversationId, messageId}` | Connected, known-conversation metadata only; callback required, 5s timeout, no automatic retry. |
| Client → server | `typing:start`, `typing:stop` | `{conversationId}` | Volatile emission; no content or caller-supplied identity; no offline queue. |
| Client → server | `presence:subscribe` | `{userIds:string[]}` | Replaces requested subscription scope; sent once connected and after reconnect/scope change, including empty list. Server must filter by privacy/relationships. |
| Server → client | `message:new` | `{message: IncomingEncryptedMessage}` or the raw envelope below. | Validate, known-conversation filter, bounded ID dedupe; bridge checks known sender participant; existing crypto service authenticates before display. |
| Server → client | `message:ack` | Proposed accepted send acknowledgement below. | Ignored by real adapter while no real outgoing IDs can exist. Mock uses the send promise instead. |
| Server → client | `message:delivered` | Receipt below, `status:'delivered'`. | Strict matching event/status, bounded dedupe; bridge applies only to known outgoing IDs and known non-self peers. |
| Server → client | `message:read` | Receipt below, `status:'read'`. | Separate inbound event from the client read request callback. Same scope checks. |
| Server → client | `typing:update` | `{conversationId,userId,displayName,isTyping:boolean,timestamp}` | Known conversation, non-self, known participant at bridge; multiple group peers allowed. |
| Server → client | `presence:update` | `{userId,status:'online'|'away'|'offline'|'busy'|'unknown',timestamp}` | Only requested public-user scope, then watched Friends projection. `busy` reuses the existing presence model. Unknown removes a known status. |
| Server → client | `conversation:updated` | `{conversationId,displayName?,updatedAt}` | Only a known conversation; monotonic bounded name update. Cannot inject participants, messages, new conversations, or membership. |

Incoming encrypted text body:

```ts
{
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  timestamp: string;
  type: 'text';
  deliveryStatus: 'sent' | 'delivered' | 'read';
  encryption: {
    version: 1;
    algorithm: 'AES-256-GCM';
    encoding: 'base64';
    iv: string;         // canonical base64, exactly 12 decoded bytes
    ciphertext: string; // canonical base64, includes tag, >16 bytes
  };
}
```

Incoming real events reject `content`, `demoOnly`, unknown fields and `encryption.scope:'browser-demo'`. Ciphertext is capped at 1,400,000 encoded characters; the server should agree a smaller operational limit and enforce it before broadcasting. The transport does not decrypt. The existing crypto service uses the received metadata as AAD context; authentication failure produces a safe notice, never unverified plaintext or a read request. Local keys do not imply that a remote sender possesses an authenticated recipient key.

Receipt body:

```ts
{ conversationId: string; messageId: string;
  status: 'sent' | 'delivered' | 'read'; userId: string; timestamp: string }
```

Accepted-send promise acknowledgement (mock now; proposed server callback later):

```ts
{ conversationId: string; messageId: string; status: 'sent'; timestamp: string }
```

Read-request callback:

```ts
{ conversationId: string; messageId: string; status: 'read'; timestamp: string; userId?: string }
```

All acknowledgement IDs must exactly match the original request; optional read `userId` must match the session actor. The callback confirms processing that metadata request, not that another person read anything. Receipt `userId` identifies the observing peer. A group peer receipt currently indicates one known peer, not all members; per-member aggregation/quorums need a separate agreed contract. No real delivery/read guarantee has been verified.

## Acknowledgement, retry and reconciliation rules

1. Existing message application flow validates and locally encrypts before the transport sees an envelope. Encryption failure prevents sending. Real send capability is currently denied before encryption/dispatch.
2. Local state starts at Sending, becomes Accepted when the send promise validates, then separately Delivered / Read on receipt events. Demo labels always say simulated. Emitting an event never counts as delivery.
3. Concurrent sends with the same conversation/message ID and identical canonical encrypted metadata share one promise. A changed payload with the same ID is rejected. Explicit retry reuses the original ID, IV, ciphertext, sender metadata and timestamp; it does not re-encrypt.
4. Only definitely retryable failures allow manual retry, at most three attempts per tracked ID. No automatic send retries, offline buffering or plaintext fallback. Ambiguous acknowledgement timeout is not safe to retry without server idempotency/reconciliation, so retry is denied.
5. Incoming IDs are deduplicated in bounded windows. Existing message state deduplicates IDs, orders by timestamp, and preserves arrival order for equal timestamps. Read is terminal; stale Sent/Delivered events cannot regress it. Server sequence/cursor semantics remain an open contract question.
6. Read metadata is requested only for a verified incoming text in the active, visible, connected conversation. Hidden sections/tabs do not send read requests; failed authentication does not count as reading content. Failed read requests are not silently queued or retried.

The server must provide idempotency keyed by authenticated actor + conversation + client message ID and reject same-ID changed-envelope collisions. It must define accepted vs durable storage vs recipient delivery, stable canonical timestamps/IDs, error codes, acknowledgement deadlines, receipt actor authorization, and how to query an ambiguous send. The client cannot prove these guarantees on its own.

Socket.IO defaults to at-most-once arrival and does not replay missed server events automatically. See the official [delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/), [client options](https://socket.io/docs/v4/client-options/), and [offline behavior](https://socket.io/docs/v4/client-offline-behavior/). This adapter uses `retries:0`, checks connectivity before emitting metadata and uses volatile typing to avoid buffered bursts. No application history cursor, reconnect catch-up, exactly-once guarantee or server connection-state recovery is implemented or claimed.

## Lifecycle, freshness and resource limits

States are disconnected, connecting, connected, reconnecting and error. UI presents disconnected/error as Offline. Initial connect has a 90s overall deadline; Socket.IO handshake timeout is 10s. Unexpected network failure permits up to five reconnect attempts with 500ms initial delay and 4s maximum delay (Socket.IO jitter applies). Server rejection and explicit logout do not retry. A single session instance coalesces initial connection requests and owns its listeners; reconnection does not register duplicates. Metadata read promises cancel on disconnect/auth rejection/disposal.

- Presence expires 45s after observation, cleared on disconnect and when a friend leaves the watched set. Delayed samples retain only their remaining lifetime. Equal/older timestamps do not refresh it. Clock skew over +60s is rejected before storing an ordering watermark.
- Typing sends start on meaningful edits, at most every 2s while editing; inactivity stops after 1.5s. Empty draft, blur, submit, hide, conversation change, disconnect and unmount stop it. Remote typing expires after 5s from observation and clears on navigation/disconnect. Own typing is suppressed. No typing persistence or added animation.
- Limits: 1,000 watched IDs per Socket scope; 1,000 recent socket event/metadata entries; 100 pending socket read requests; 2,000 tracked bridge/mock sends and 16MiB envelope fingerprint budget; 2,000 recent incoming/read/activity IDs in the hook; 64 in-flight decrypts plus 256 queued ciphertext envelopes with a 16MiB queued-envelope budget; 40 incoming typing peers; 1,000 retained messages per conversation. The transient decrypt queue snapshots ciphertext/AAD metadata, drains as slots finish, and is cleared on cleanup. Capacity overflow produces a fixed safe security notice once per subscription lifetime; it never displays unauthenticated content or claims history recovery. Cache eviction means dedupe is a recent-window property, not unlimited historical uniqueness. No persistence/history UI was added.
- Malformed socket event diagnostics are coalesced to one safe error per connection. No raw payloads, plaintext, credentials, cookies, tokens or keys are logged. Subscriber exceptions cannot interrupt other subscribers or retain an inaccessible cleanup handle.

## Development-only simulation

One mock belongs to one demo auth session. `Realtime demo controls` inside System Log can simulate incoming messages into any existing conversation, multiple group typers, Ava's presence, a definitely failed next send, offline and reconnect. SecureBot alone auto-replies with a fixed local fixture; DM/group arrivals require explicit simulation. Mock replies never decrypt or echo outgoing content, call AI, connect a network socket or suggest another real user is present.

Mock timing defaults: connect/accept 20ms, delivered 100ms, read 220ms, SecureBot typing 300ms and reply 600ms. Tests can configure timings/disable auto replies. Disconnect cancels queued timers/pending accepts; reconnect does not replay. Synthetic presence is explicitly labelled and still expires. The mock does not implement permanent registration, remote delivery, server-enforced blocking or group membership.

## Outstanding owner decisions before real integration

Realtime/Kiro must agree the namespace/path/event names and callback schemas; cookie authentication and auth-error codes; Origin/CORS policy; authorized room routing/revocation; membership/blocked-user enforcement; privacy-filtered presence subscription and heartbeat cadence; delivery/read aggregation; rate/payload limits; client-ID idempotency; replay/history cursor and recovery semantics; session-expiry/disconnect behavior; and a test server for genuine multi-user validation.

Database/API must supply the Phase 8.5 auth/CSRF/session endpoints and policy plus authorized conversation/participant/friends/profile/history/persistence APIs. Group lifecycle, member invitations/selection, membership-version invalidation and attachment/media APIs remain unverified or absent. A `conversation:updated` event must not authorize membership; an approved API refresh contract is needed when those services exist.

Security/key-distribution work must establish authenticated recipient identities, recipient/group key agreement, key IDs/versioning/rotation/revocation and envelope semantics before enabling real sends. Merely setting readiness flags or connecting this adapter does not establish multi-user E2EE.

No Phase 8.7B, 8.6 or 9 work, backend implementation, database changes, group business-logic rebuild, security-agent infrastructure, or Git publication is included.
