# Requirements Document

## Introduction

Phase 8.7B adds the server side of SecuBuzz realtime messaging: a Socket.IO 4.x server that authenticates cookie sessions, routes only server-authorized conversation events, relays typing and presence, and defines the boundaries for read receipts, delivery receipts and future encrypted message delivery.

The source of truth for wire behavior is the Phase 8.7A client contract in `docs/realtime-client-contract.md` and its implementation in `client/src/realtime/`. This phase must not rename events, change payload schemas, or modify the frontend.

The Database Team has not delivered session, membership, relationship or message persistence APIs. The server therefore exposes typed adapter interfaces for those dependencies and fails closed while they are missing. Production message delivery stays disabled until authenticated recipient key distribution and durable persistence exist. A structurally valid AES-GCM envelope is not treated as proof of multi-user end-to-end encryption.

Out of scope: Auditor Bot, Sentinel Bot, BUZZ Guard, AI features, database schema, password authentication, login/registration endpoints, durable message persistence, group CRUD, key exchange, history replay APIs, and frontend changes.

## Glossary

- **Realtime_Server**: The Socket.IO server module in `server/src/realtime/`, attached to a Node.js HTTP server.
- **Client_Contract**: `docs/realtime-client-contract.md` plus the Phase 8.7A parsers in `client/src/realtime/realtimeValidation.ts`.
- **Connection**: One authenticated Socket.IO socket in the configured namespace.
- **Actor**: The user identity bound to a Connection by the Session_Resolver: `userId`, `sessionId` and `displayName`.
- **Session_Resolver**: Database-Team adapter that turns the session cookie into an authenticated session, or reports it missing, invalid or expired.
- **Authorizer**: Database-Team adapter that returns an Actor's authorized conversations, block relationships and visible presence subjects.
- **Message_Store**: Database-Team adapter for message lookup, durable receipts and idempotent message persistence.
- **Recipient_Key_Verifier**: Security-Team adapter that attests an envelope is encrypted for authenticated recipient keys. It does not exist in production yet.
- **Security_Policy**: Optional Phase 10 extension point that can allow or deny connections and events.
- **Room**: A Socket.IO room. Conversation rooms are named `conv:<conversationId>`; per-user rooms are named `user:<userId>`.
- **Grant**: A conversation ID that the Authorizer returned for an Actor.
- **Block_Pair**: Two users with a block relationship in either direction.
- **Presence_Subject**: A user whose presence a Connection requested with `presence:subscribe`.
- **Error_Ack**: The acknowledgement body `{ status: 'error', code }` returned for a rejected acknowledged event.
- **Connect_Error_Code**: The `connect_error.data.code` value sent when a handshake is rejected.
- **Fail_Closed**: Deny access or capability when a dependency is missing, failing, slow or returning malformed data.

## Requirements

### Requirement 1: Socket.IO server initialization

**User Story:** As a backend integrator, I want one configurable Socket.IO server I can attach to an existing HTTP server, so that realtime traffic shares the backend without a competing framework.

#### Acceptance Criteria

1. THE Realtime_Server SHALL attach Socket.IO 4.x to a caller-supplied Node.js HTTP or HTTPS server at a configurable path (default `/socket.io`) and namespace (default `/`).
2. IF configured allowed origins include a wildcard, `null`, credentials, a path, a query, a fragment, or a non-HTTPS origin whose host is not loopback, THEN THE Realtime_Server SHALL refuse to start.
3. THE Realtime_Server SHALL answer polling CORS requests with credentials enabled and an `Access-Control-Allow-Origin` value equal to the exact allowlisted request origin, and SHALL omit CORS approval for other origins.
4. WHEN a handshake request has a missing or non-allowlisted `Origin` header, THE Realtime_Server SHALL reject it before invoking the Session_Resolver.
5. IF the same HTTP server is passed to `attachRealtimeServer` twice, THEN THE Realtime_Server SHALL throw and SHALL NOT create a second Socket.IO instance.
6. THE Realtime_Server SHALL disable client-bundle serving and connection-state recovery, and SHALL cap each transport packet at the configured payload limit (default 128 KiB).
7. WHERE a namespace other than `/` is configured, THE Realtime_Server SHALL reject every connection to the default namespace.
8. WHILE no Session_Resolver or no Authorizer is configured, THE Realtime_Server SHALL start in fail-closed mode, log that mode once, and reject every connection with `REALTIME_UNAVAILABLE`.
9. IF a supplied adapter lacks a required method, or a limit or timing value is outside its documented range, THEN THE Realtime_Server SHALL refuse to start.

### Requirement 2: Authenticated connections

**User Story:** As a SecuBuzz user, I want my realtime connection bound to my server session, so that nobody can act as me by sending my user ID.

#### Acceptance Criteria

1. WHEN a connection is attempted, THE Realtime_Server SHALL authenticate it only from the configured session cookie, using the injected Session_Resolver.
2. THE Realtime_Server SHALL ignore identity claims in the handshake `auth` payload, query string and event bodies.
3. WHEN authentication succeeds, THE Realtime_Server SHALL bind the resolved `userId`, `sessionId` and `displayName` to the Connection for its lifetime, and SHALL use that Actor for every relayed event.
4. THE Realtime_Server SHALL pass the session cookie value only to the Session_Resolver and SHALL NOT log, persist or emit it.
5. IF the Session_Resolver returns a reserved demo identity (`local-user`, or a user ID starting with `demo-`, `demo_` or `demo:`, case-insensitive), THEN THE Realtime_Server SHALL reject the connection with `UNAUTHORIZED`.
6. THE Realtime_Server SHALL NOT include any built-in, demo, or fallback Session_Resolver in production code.

### Requirement 3: Connection rejection and error contract

**User Story:** As the Phase 8.7A client, I want machine-readable rejection codes, so that I can stop reconnecting and ask the auth provider to revalidate.

#### Acceptance Criteria

1. IF the session cookie is absent or empty, or the Session_Resolver reports `missing`, THEN THE Realtime_Server SHALL reject the handshake with Connect_Error_Code `AUTH_REQUIRED`.
2. IF the session cookie is malformed or appears more than once, or the Session_Resolver reports `invalid`, THEN THE Realtime_Server SHALL reject with `UNAUTHORIZED`.
3. IF the Session_Resolver reports `expired`, or returns an `expiresAt` that is not in the future, THEN THE Realtime_Server SHALL reject with `SESSION_EXPIRED`.
4. IF the Session_Resolver or Authorizer throws, times out, or returns a malformed result, THEN THE Realtime_Server SHALL reject with `REALTIME_UNAVAILABLE`.
5. IF the global connection limit, the per-user connection limit, or the pending-handshake limit is reached, THEN THE Realtime_Server SHALL reject with `CONNECTION_LIMIT`.
6. IF the Origin check fails inside the namespace middleware, THEN THE Realtime_Server SHALL reject with `ORIGIN_NOT_ALLOWED`.
7. THE Realtime_Server SHALL send a fixed generic `connect_error` message and only `{ code }` as data, without session details, account existence, internal error text or stack traces.
8. WHEN a handshake is rejected, THE Realtime_Server SHALL NOT join the socket to any Room or deliver any application event to it.

### Requirement 4: Authorized room management

**User Story:** As a conversation participant, I want events delivered only to authorized participants, so that other users cannot read my conversation activity.

#### Acceptance Criteria

1. WHEN a Connection is authenticated, THE Realtime_Server SHALL obtain the Actor's Grants from the Authorizer and join only `user:<userId>` and the Grants' conversation Rooms.
2. THE Realtime_Server SHALL NOT expose any client event that joins, leaves or selects a Room.
3. IF the Authorizer returns more Grants or block entries than the configured limits, or any entry is not a valid identifier, THEN THE Realtime_Server SHALL reject the connection with `REALTIME_UNAVAILABLE`.
4. WHEN `refreshUserAccess(userId)` succeeds, THE Realtime_Server SHALL leave conversation Rooms that are no longer granted and join newly granted Rooms for every Connection of that user.
5. WHEN `revokeConversationAccess(userId, conversationId)` is called, THE Realtime_Server SHALL remove that user's Connections from the conversation Room immediately, without calling the Authorizer, and SHALL NOT let an Authorizer result whose queries started before the call re-grant that conversation, even for a handshake already in flight.
6. THE Realtime_Server SHALL deliver conversation-scoped events only to Connections currently joined to that conversation's Room.
7. WHILE two users form a Block_Pair, THE Realtime_Server SHALL NOT route typing, receipts, presence or messages from one user to the other.
8. WHERE periodic revalidation is enabled (default every 60 seconds), THE Realtime_Server SHALL refresh every connected user's Grants and block relationships; IF the refresh fails, THEN THE Realtime_Server SHALL keep the last verified Grants, grant nothing new, and log a warning.

### Requirement 5: Event validation

**User Story:** As a security reviewer, I want every client event validated against the Client_Contract, so that malformed or hostile input cannot reach routing logic.

#### Acceptance Criteria

1. THE Realtime_Server SHALL define every client-to-server and server-to-client event name once, using the Client_Contract names: `message:send`, `message:read`, `typing:start`, `typing:stop`, `presence:subscribe`, `message:new`, `message:ack`, `message:delivered`, `message:read`, `typing:update`, `presence:update` and `conversation:updated`.
2. THE Realtime_Server SHALL accept client event bodies only as plain objects that contain exactly the Client_Contract fields, with identifiers of 1–256 characters and no whitespace, control characters or unpaired surrogates.
3. WHEN an unknown event name, an extra argument, or a malformed body is received, THE Realtime_Server SHALL reject it and charge the Connection's invalid-event budget.
4. IF a Connection exhausts its invalid-event budget, THEN THE Realtime_Server SHALL disconnect it.
5. IF `message:read` or `message:send` arrives without an acknowledgement callback, THEN THE Realtime_Server SHALL reject it without processing.
6. WHEN an acknowledged event is rejected, THE Realtime_Server SHALL respond with an Error_Ack whose `code` is one of `invalid_payload`, `unauthorized_conversation`, `rate_limited`, `unavailable`, `message_not_found`, `actor_mismatch`, `idempotency_conflict`, `recipient_keys_unavailable` or `policy_denied`.
7. THE Realtime_Server SHALL emit server-to-client payloads that the Client_Contract parsers accept unchanged.

### Requirement 6: Typing indicators

**User Story:** As a conversation participant, I want to see when other authorized participants are typing, so that the conversation feels live without exposing typing to outsiders.

#### Acceptance Criteria

1. WHEN an authorized Connection sends `typing:start` or `typing:stop` with `{ conversationId }`, THE Realtime_Server SHALL emit `typing:update` `{ conversationId, userId, displayName, isTyping, timestamp }` to the conversation Room, using the Actor's `userId` and `displayName` and a server timestamp.
2. THE Realtime_Server SHALL NOT deliver a user's `typing:update` to that user's own Connections or to users in a Block_Pair with them.
3. IF the Connection is not joined to the conversation Room, THEN THE Realtime_Server SHALL drop the event without relaying it.
4. IF the typing body contains any field other than `conversationId`, including `userId` or `displayName`, THEN THE Realtime_Server SHALL reject it as malformed.
5. IF a Connection exceeds its typing rate limit, THEN THE Realtime_Server SHALL drop the excess events.
6. THE Realtime_Server SHALL keep typing state only in memory and SHALL expire it after the typing TTL (default 6 seconds).
7. WHEN a typing Connection disconnects or loses access to the conversation, THE Realtime_Server SHALL emit `isTyping: false` for that user to the remaining authorized participants, unless another Connection of the same user is still typing there.
8. THE Realtime_Server SHALL make `typing:update` timestamps strictly increasing per conversation and user.

### Requirement 7: Presence

**User Story:** As a user, I want to see my authorized contacts' presence and keep mine private from everyone else.

#### Acceptance Criteria

1. THE Realtime_Server SHALL treat a user as online while at least one of their Connections is open, and SHALL report `offline` only after their last Connection closes.
2. WHEN a Connection sends `presence:subscribe` `{ userIds }`, THE Realtime_Server SHALL replace that Connection's requested scope, with at most 1,000 IDs, duplicates and the Actor's own ID removed.
3. THE Realtime_Server SHALL authorize Presence_Subjects as the intersection of the request and the Authorizer's `filterPresenceSubjects` result, minus Block_Pairs.
4. THE Realtime_Server SHALL emit `presence:update` only for authorized Presence_Subjects of the receiving Connection, and SHALL NOT broadcast presence to any other recipient.
5. WHEN Presence_Subjects are authorized, THE Realtime_Server SHALL emit their current status immediately, emit status changes as they happen, and re-emit current status every presence refresh interval (default 30 seconds, at most 40 seconds) so the client's 45-second freshness window never lapses for live subjects.
6. THE Realtime_Server SHALL use server timestamps for `presence:update` that strictly increase per subject.
7. WHEN a Connection loses authorization for a subject after a refresh or a new block, THE Realtime_Server SHALL emit `unknown` for that subject once and then stop emitting it.
8. IF `filterPresenceSubjects` fails, times out or returns malformed data, THEN THE Realtime_Server SHALL authorize no subjects for that request.
9. WHEN a Connection disconnects, THE Realtime_Server SHALL remove its presence subscriptions.
10. WHERE a server-side integration sets a presence preference of `away`, `busy`, `invisible` or `available`, THE Realtime_Server SHALL report `away`, `busy`, `offline` or `online` respectively while the user is connected.

### Requirement 8: Read receipts

**User Story:** As a sender, I want to know when an authorized recipient read my message, without anyone forging that receipt.

#### Acceptance Criteria

1. WHEN a Connection sends `message:read` `{ conversationId, messageId }` with a callback, THE Realtime_Server SHALL treat the Actor as the reader.
2. IF the Connection is not joined to the conversation Room, THEN THE Realtime_Server SHALL respond `unauthorized_conversation`.
3. WHILE no Message_Store is configured, THE Realtime_Server SHALL respond `unavailable` and SHALL NOT record or emit a receipt.
4. IF the Message_Store does not find the message in that conversation, THEN THE Realtime_Server SHALL respond `message_not_found`.
5. IF the reader is the message's sender, THEN THE Realtime_Server SHALL respond `invalid_payload`.
6. WHEN the Message_Store records the receipt, THE Realtime_Server SHALL acknowledge `{ conversationId, messageId, status: 'read', timestamp, userId }` with the reader's `userId` and the recorded time.
7. WHEN a receipt is recorded for the first time, THE Realtime_Server SHALL emit `message:read` `{ conversationId, messageId, status: 'read', userId, timestamp }` to the sender's Connections that are still in the conversation Room, separately from the reader's acknowledgement; a duplicate record SHALL NOT notify again.
8. IF the Message_Store throws or misses the acknowledgement deadline (default 4 seconds, shorter than the client's 5-second timeout), THEN THE Realtime_Server SHALL respond `unavailable` and SHALL NOT emit a receipt.

### Requirement 9: Message send boundary

**User Story:** As a security reviewer, I want message sending to stay disabled until authenticated recipient keys and durable persistence exist, so that no plaintext or demo envelope is ever delivered as if it were E2EE.

#### Acceptance Criteria

1. THE Realtime_Server SHALL accept `message:send` bodies only with exactly `id`, `conversationId`, `senderId`, `senderName`, `timestamp`, `type: 'text'` and `encryption` `{ version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv, ciphertext }`.
2. IF the body contains `content`, `demoOnly`, `encryption.scope` or any other unknown field, THEN THE Realtime_Server SHALL respond `invalid_payload`.
3. IF `iv` is not canonical base64 of exactly 12 bytes, or `ciphertext` is not canonical base64 longer than 16 decoded bytes and within the operational limit (default 65,536 characters), THEN THE Realtime_Server SHALL respond `invalid_payload`.
4. IF `senderId` or `senderName` differs from the Actor, THEN THE Realtime_Server SHALL respond `actor_mismatch`.
5. IF the Connection is not joined to the conversation Room, THEN THE Realtime_Server SHALL respond `unauthorized_conversation`.
6. IF the envelope timestamp differs from server time by more than the allowed skew (default 5 minutes), THEN THE Realtime_Server SHALL respond `invalid_payload`.
7. WHILE no Message_Store or no Recipient_Key_Verifier is configured, THE Realtime_Server SHALL respond `recipient_keys_unavailable` to every valid send and SHALL NOT persist or emit it.
8. IF the Recipient_Key_Verifier does not verify the envelope, THEN THE Realtime_Server SHALL respond `recipient_keys_unavailable`.
9. THE Realtime_Server SHALL emit `message:new` only after the Message_Store reports the message durably stored.

### Requirement 10: Message idempotency

**User Story:** As a client that may retry an ambiguous send, I want duplicates collapsed and changed retries rejected, so that history never contains duplicates or substituted ciphertext.

#### Acceptance Criteria

1. THE Realtime_Server SHALL key idempotency by Actor `userId`, `conversationId` and client message `id`, and SHALL pass the Message_Store a SHA-256 fingerprint of the canonical envelope.
2. WHEN the Message_Store reports a duplicate with the same fingerprint, THE Realtime_Server SHALL return the original acknowledgement `{ conversationId, messageId, status: 'sent', timestamp }` and SHALL NOT emit `message:new` again.
3. IF the Message_Store reports a conflict, or a request reuses an in-flight key with a different fingerprint, THEN THE Realtime_Server SHALL respond `idempotency_conflict`.
4. WHEN identical requests for the same key are in flight at the same time, THE Realtime_Server SHALL call the Message_Store once and give every request the same result.
5. THE Realtime_Server SHALL keep accepted (`sent` acknowledgement), delivered and read as separate states, and SHALL NOT claim durable idempotency without a Message_Store.

### Requirement 11: Delivery receipts

**User Story:** As a sender, I want delivery receipts to mean an authorized recipient device confirmed receipt, not that the server emitted an event.

#### Acceptance Criteria

1. THE Realtime_Server SHALL NOT emit `message:delivered` merely because it emitted `message:new`.
2. WHEN it emits `message:new` to a recipient Connection, THE Realtime_Server SHALL attach an acknowledgement callback with a timeout (default 10 seconds).
3. WHEN that recipient Connection invokes the callback with exactly `{ conversationId, messageId, status: 'delivered' }` for that message, and the Message_Store records the delivery for the first time, THE Realtime_Server SHALL emit `message:delivered` `{ conversationId, messageId, status: 'delivered', userId, timestamp }` with the recipient's `userId` to the sender's Connections in the conversation Room.
4. IF the callback times out, is malformed, or the recipient lost access, THEN THE Realtime_Server SHALL NOT emit a delivery receipt.
5. THE Realtime_Server SHALL emit one receipt per recipient user and SHALL NOT aggregate group receipts.
6. THE Realtime_Server SHALL bound pending delivery acknowledgements per Connection (default 100).

### Requirement 12: Rate limiting and resource limits

**User Story:** As an operator, I want bounded resource use, so that one client cannot exhaust the server.

#### Acceptance Criteria

1. THE Realtime_Server SHALL apply per-Connection token buckets to all events, typing, read requests, sends, presence subscriptions and invalid events.
2. WHEN a rate limit is exceeded, THE Realtime_Server SHALL respond `rate_limited` to acknowledged events and silently drop unacknowledged events.
3. THE Realtime_Server SHALL bound global connections, connections per user, pending handshakes, Grants per user, block entries per user, presence subjects per Connection, pending acknowledgements per Connection, pending delivery acknowledgements per Connection, packet size, ciphertext length, and in-memory timestamp, revocation and preference tables.
4. THE Realtime_Server SHALL make every limit configurable and SHALL validate the configured values at startup.

### Requirement 13: Session expiry and revocation

**User Story:** As a user who signs out, I want my realtime connections closed, so that a revoked session cannot keep receiving events.

#### Acceptance Criteria

1. WHEN a Connection's session `expiresAt` is reached, THE Realtime_Server SHALL disconnect it.
2. WHEN `revokeSession(sessionId)` is called, THE Realtime_Server SHALL disconnect every Connection of that session with a server-initiated disconnect, which the client treats as terminal.
3. WHEN a handshake for a session revoked during its authentication completes, THE Realtime_Server SHALL reject it with `UNAUTHORIZED`.
4. WHEN `disconnectUser(userId)` is called, THE Realtime_Server SHALL disconnect every Connection of that user.
5. WHERE the Session_Resolver implements `checkSession`, THE Realtime_Server SHALL call it during periodic revalidation, disconnect sessions reported expired or revoked, and update the expiry of active sessions.

### Requirement 14: Disconnect cleanup

**User Story:** As an operator, I want all per-connection state released on disconnect, so that memory and stale subscriptions do not accumulate.

#### Acceptance Criteria

1. WHEN a Connection closes, THE Realtime_Server SHALL remove it from the connection, user and session indexes, its Rooms, presence subscriptions, typing state, pending counters and timers.
2. WHEN a user's last Connection closes, THE Realtime_Server SHALL emit `offline` to authorized subscribers and remove the user's in-memory state.
3. THE Realtime_Server SHALL expose counters (`getStats`) that return to zero after every Connection closes.

### Requirement 15: Reconnection and shutdown

**User Story:** As a client on an unreliable network, I want every reconnect treated as a new, fully verified connection.

#### Acceptance Criteria

1. WHEN a client reconnects, THE Realtime_Server SHALL authenticate and authorize the new socket from scratch and SHALL carry no Grants or subscriptions over from the previous socket.
2. THE Realtime_Server SHALL register event handlers once per socket, so each event is processed once after any number of reconnects.
3. WHEN a reconnected Connection sends `presence:subscribe`, THE Realtime_Server SHALL re-filter the requested subjects before emitting presence.
4. THE Realtime_Server SHALL NOT claim message replay, catch-up or exactly-once delivery, and SHALL keep Socket.IO connection-state recovery disabled.
5. WHEN `close()` is called, THE Realtime_Server SHALL stop accepting handshakes, close every transport (so clients may reconnect to another instance), clear its timers and listeners, complete idempotently, and leave the caller's HTTP server open.

### Requirement 16: Security and privacy

**User Story:** As a security reviewer, I want logs and errors that never leak secrets, and a safe extension point for future security agents.

#### Acceptance Criteria

1. THE Realtime_Server SHALL NOT log cookies, session tokens, session IDs, passwords, plaintext, ciphertext, IVs or raw event payloads.
2. THE Realtime_Server SHALL NOT reveal whether another account, session or message outside the Actor's authorized conversations exists.
3. WHERE a Security_Policy is configured, THE Realtime_Server SHALL evaluate it for every handshake and client event, reject denied handshakes with `POLICY_DENIED`, and respond `policy_denied` to denied acknowledged events.
4. IF the Security_Policy throws or times out, THEN THE Realtime_Server SHALL deny the handshake or event.
5. THE Realtime_Server SHALL give the Security_Policy metadata only (event name, conversation and message IDs, payload size) and never ciphertext.
6. THE Realtime_Server SHALL NOT call AI models or implement Auditor Bot, Sentinel Bot or BUZZ Guard.

### Requirement 17: Testability

**User Story:** As a developer, I want deterministic tests over real sockets, so that the contract is verified without a database.

#### Acceptance Criteria

1. THE test harness SHALL start the Realtime_Server on an ephemeral loopback port with injected test adapters and SHALL shut it down cleanly.
2. THE test adapters SHALL live outside `server/src/`, SHALL NOT be exported by the production entry point, and SHALL refuse construction when `NODE_ENV=production`.
3. THE integration tests SHALL use real `socket.io-client` connections for authentication, authorization, presence, typing, messaging, receipts and lifecycle behavior.
4. THE compatibility tests SHALL run the actual Phase 8.7A `SocketIoRealtimeClient` and client parsers against the Realtime_Server.
5. THE standalone entry point SHALL be smoke-tested as a separate Node.js process in its fail-closed configuration.

### Requirement 18: Integration documentation

**User Story:** As a Database Team member, I want a precise handoff document, so that I can implement the adapters without guessing.

#### Acceptance Criteria

1. THE project SHALL include `docs/realtime-server-integration.md` describing the Session_Resolver, Authorizer, Message_Store, Recipient_Key_Verifier and Security_Policy interfaces, cookie and session expectations, blocked-user policy, idempotency and receipt persistence, session revocation, history and replay dependencies, and error contracts.
2. THE integration document SHALL separate implemented behavior from future dependencies and SHALL NOT present missing database or E2EE features as complete.
3. THE integration document SHALL record every conflict found between the Client_Contract and server behavior, with the smallest compatible resolution.
