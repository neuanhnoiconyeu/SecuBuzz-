# Secure realtime integration: Socket.IO, DATA and E2EE v2

Owner: Kiro (`server/`). Related owners: Database Team (`DATA/`, read-only here), Codex (`client/`, read-only here).
Spec: [.kiro/specs/realtime-data-integration/](../../.kiro/specs/realtime-data-integration/). Client handoff: [client-realtime-handoff.md](client-realtime-handoff.md).
Older background: [../../docs/realtime-server-integration.md](../../docs/realtime-server-integration.md) (adapter contracts of Phase 8.7B) and [../../docs/e2ee-recipient-key-integration.md](../../docs/e2ee-recipient-key-integration.md) (key protocol).

Status: server side complete and tested against the real DATA application. The real client cannot use it yet (see [Limitations](#14-limitations-and-production-readiness)).

## 1. Architecture

One HTTP server carries both DATA's REST API and the Socket.IO endpoint. The realtime server holds no accounts, sessions, memberships, keys or messages of its own. Every security decision is a call into DATA's application object.

```
Browser ──HTTPS──▶ one http.Server ─┬─▶ DATA Express app (/api/*)         auth, social, conversations, keys, messaging, SQLite
                                    └─▶ Socket.IO (/socket.io)            rooms, fan-out, typing, presence, receipts
                                          ▲
                              src/data/ (Kiro bridge): authorizer, binder, change observer
                              duck-typed calls into the SAME DATA application object
```

| Piece | File |
| --- | --- |
| Composition: `attachRealtimeToData(httpServer, dataApplication, options)` | `src/data/bridge.ts` |
| DATA application shape, checked at attach time | `src/data/types.ts` |
| `RealtimeAuthorizer` over DATA services | `src/data/authorizer.ts` |
| `ConnectionBinder` (handshake CSRF, per-connection store) | `src/data/binder.ts` |
| Observer of DATA's committed HTTP mutations | `src/data/changes.ts` |
| Combined process (`npm run start:data`) | `src/data/main.ts` |
| Realtime core (unchanged architecture, extended) | `src/realtime/` |

Why the same process: DATA's authority is its in-process application object (`auth.csrfProof`, `messaging.bindStore`, `keys.state`). A separate realtime process would have to proxy REST calls with forwarded credentials or open DATA's SQLite file, which creates a second authority. Rejected. `src/` never imports DATA code: `src/data/main.ts` loads it through `createRequire` from `DATA_ROOT` (default `../DATA`), and `attachRealtimeToData` receives the object as a parameter and verifies its shape (`assertDataApplication`) so a DATA version lacking a documented method fails at startup.

## 2. DATA boundary

| Realtime need | DATA call (all synchronous, session-checked by DATA) |
| --- | --- |
| Authenticate the handshake | `adapters.sessionResolver.resolveSession` (cookie, Origin allowlist, secure transport) |
| Periodic session check | `adapters.sessionResolver.checkSession` |
| Handshake CSRF proof | `auth.csrfProof(sessionToken, null, csrfToken)` |
| Per-connection persistence | `messaging.bindStore({userId, sessionId}, proof)`: `storeMessage`, `findMessage`, `recordReceipt` |
| Room grants | `conversations.list` (string `limit: '50'`, paged), only items with `interactionAllowed === true` |
| Own blocks | `social.listBlocks` (paged, restarts on `STALE_STATE`) |
| Presence visibility | `auth.checkSession` + `social.repository.active/friendship/isBlocked` (friends only, no block in either direction) |
| Delivery re-authorization | `auth.checkSession` + `conversations.detail` (`interactionAllowed`) |
| Key-change payload | `keys.state(context, id, {})`: `currentEpoch` only |
| Presence preference | `social.ownProfile`: `presencePreference` |

Nothing reads a DATA table, opens a database, or verifies keys in the realtime layer. In DATA mode the realtime layer does not call `recipientKeyVerifier`: DATA's `submit` runs Kiro's verifier and then `verifyKeysInTransaction` under `BEGIN IMMEDIATE`.

DATA exposes no list of "accounts that blocked me". Own blocks come from `listBlocks`. A conversation blocked by either side is hidden from `conversations.list`, so it is not granted; the registry also indexes blocks in both directions for connected users; and delivery asks DATA again before each emit.

## 3. Authentication and CSRF flow

1. The client logs in over REST. DATA sets the `HttpOnly` session cookie (`secubuzz_session`, or `__Host-secubuzz_session` in production; the name comes from `auth.config.sessionCookie`).
2. The client calls `GET /api/auth/csrf` and receives the session-bound `csrfToken`. The token is stable for the session and changes at the next login.
3. The client connects: `io(url, { withCredentials: true, auth: { csrfToken } })`. `auth` must be exactly `{ csrfToken }`.
4. The server checks, in order: Origin (exact DATA allowlist, refused at the transport before any lookup); cookie present and unambiguous; transport security (mirror of DATA's `secureRequest`); `resolveSession` (demo identities are never sessions); `auth` shape; `auth.csrfProof(sessionToken, null, csrfToken)` whose `sessionId` and `userId` must equal the resolved actor; then grants, blocks and presence preference.
5. The connection receives its own `bindStore(...)` store. Identity is the DATA session. No user ID, token or name is read from `auth`, the query string or any event.

Connect errors (client's closed set): `AUTH_REQUIRED` (no cookie), `UNAUTHORIZED` (unknown or revoked session, missing, wrong, foreign or pre-login CSRF token, extra `auth` keys, demo identity), `SESSION_EXPIRED`, `REALTIME_UNAVAILABLE` (DATA or the binder failed or timed out; always closed, never an implicit pass), `CONNECTION_LIMIT`, `POLICY_DENIED`. A foreign Origin is refused by the transport without a code.

Revocation:

| Event | Effect |
| --- | --- |
| `POST /api/auth/logout` committed (204) | The observer calls `revokeSession(sessionId)`: all sockets of that session close at once and the session is remembered as revoked for later handshakes |
| Session revoked or expired by another path | `checkSession` every 15 s closes the sockets |
| Any store call after revocation | DATA refuses (`UNAUTHENTICATED`/`SESSION_EXPIRED`/`CSRF_INVALID`); the ack is `policy_denied` and the socket is closed |

## 4. Event contracts

Client to server (unchanged names):

| Event | Body | Ack |
| --- | --- | --- |
| `message:send` | envelope v2 (below) | `{conversationId, messageId, status:'sent', timestamp}` or `{status:'error', code}` |
| `message:read` | `{conversationId, messageId}` | `{conversationId, messageId, status:'read', timestamp, userId}` or error |
| `typing:start`, `typing:stop` | `{conversationId}` | none |
| `presence:subscribe` | `{userIds: string[]}` | none |

Server to client:

| Event | Payload |
| --- | --- |
| `message:new` | the committed envelope v2 plus `deliveryStatus: 'sent'`. The recipient confirms with the Socket.IO callback `{conversationId, messageId, status:'delivered'}` |
| `message:delivered`, `message:read` | `{conversationId, messageId, status, userId, timestamp}` to the sender's sockets |
| `typing:update` | `{conversationId, userId, displayName, isTyping, timestamp}` (no content) |
| `presence:update` | `{userId, status, timestamp}`; `unknown` means authorization for that subject ended |
| `conversation:updated` | `{conversationId, displayName?, updatedAt}`; only produced through the handle (`notifyConversationUpdated`). DATA has no trigger for it, and nothing here claims otherwise |
| `conversation:keys-changed` | exactly `{conversationId, currentEpoch: {keyId, epoch} | null}` |

Envelope v2 (transported byte for byte, never decrypted, rewritten or logged):

```json
{ "id": "client-uuid", "conversationId": "...", "senderId": "<session user>", "senderName": "<profile name>",
  "timestamp": "ISO-8601", "type": "text",
  "encryption": { "version": 2, "algorithm": "AES-256-GCM", "encoding": "base64", "keyId": "<22 char base64url>", "iv": "<12 bytes b64>", "ciphertext": "<b64>" } }
```

A connection that has a bound store accepts only version 2. Version 1, plaintext fields, unknown fields and non-canonical encodings answer `invalid_payload`. There is no downgrade and no plaintext path. The live `message:new` carries neither `sequence` nor `storedAt` because the client's parser rejects unknown fields; history carries them.

## 5. Authorization and rooms

- A socket joins exactly the rooms DATA lists for the account with `interactionAllowed`. No client event selects a room. An unfriended or blocked pair has no room, so no sends, typing or messages.
- Grants are re-read: on connect; every 15 s for every connected user (`timing.revalidationIntervalMs`); right after a committed DATA block, unblock, friend accept, friend removal or DM creation (50 ms debounce, via the observer); and when a delivery check finds stale authority.
- Privileged operations never rely on the cache: send (DATA re-checks session, membership, friendship, block and keys inside the commit transaction), read and delivery receipts (DATA), delivery fan-out (`canReceive` before each emit), key events (`keys.state`).
- Typing and presence rely on the cached grants. The window after a change is the observer delay (tens of milliseconds) when the change went through this process's HTTP server, and at most 15 s otherwise. Typing carries no content and presence is metadata.
- Several sockets per account are supported (limit 10); every socket of an authorized account receives messages, including the sender's other devices (those do not owe a delivery receipt).

## 6. Persistence and ack flow

For each `message:send`:

1. Receive the event (rate limit: 10 burst, 1 per second per connection).
2. Parse envelope v2 strictly. A bound connection that sends anything else gets `invalid_payload`.
3. Check the sender: `senderId` must equal the DATA session user, and the conversation must be in the socket's grants.
4. Optional Phase 10 security policy.
5. Fingerprint with `envelopeV2Fingerprint` and submit `{envelope, fingerprint, receivedAt}` to this connection's bound store. In-flight duplicates of the same `(sender, conversation, id)` share one call.
6. DATA (`service.submit`): session and CSRF proof; membership, friendship, blocks; display name equals the current profile name; Kiro's recipient-key verifier (bounded, outside a transaction); then one `BEGIN IMMEDIATE` transaction that re-checks session, proof, membership and relationship, re-reads key state and runs `verifyKeysInTransaction` (current epoch, device coverage), looks for an existing message, inserts, assigns the sequence and audits.
7. The realtime layer receives `created`, `duplicate` or `conflict`, or a refusal.
8. Ack the sender: `{status:'sent', timestamp}` with DATA's `storedAt`.
9. Only for `created`: fan out asynchronously. Each target is re-authorized immediately before its emit.
10. A refusal, a timeout or an unavailable DATA acks an error and broadcasts nothing.

The ack does not wait for fan-out. A `duplicate` is acknowledged with the original `storedAt` and is never fanned out again.

Failure to ack after a commit is possible (timeout, closed socket). The client retries the same envelope. The retry is a `duplicate` and the recipients reconcile through history (see section 10). Retries never create a second message or a second delivery.

## 7. Error mapping

Ack codes are the client's closed set. The realtime layer inspects only an allowlisted `code` token (UPPER_SNAKE) and field names from DATA's `AuthError`; messages and details are discarded.

| DATA result | Ack | Meaning for the client |
| --- | --- | --- |
| `VALIDATION_ERROR`, `PAYLOAD_TOO_LARGE` | `invalid_payload` | Permanent. Fix the envelope |
| `FORBIDDEN` with field `senderId` or `senderName` | `actor_mismatch` | Permanent. Sender identity differs from the session or current profile name |
| other `FORBIDDEN`, `NOT_FOUND` | `unauthorized_conversation` | Permanent for now: not a member, not friends, blocked |
| `RECIPIENT_KEYS_UNVERIFIED` | `recipient_keys_unavailable` | Crypto/authorization failure. Do not blindly retry. Refresh the key directory, check history, re-encrypt for the current epoch with the SAME message id |
| `RATE_LIMITED` | `rate_limited` | Retry later |
| `CSRF_INVALID`, `UNAUTHENTICATED`, `SESSION_EXPIRED` | `policy_denied` and the socket closes | Re-authenticate |
| `IDEMPOTENCY_CONFLICT` (outcome `conflict`) | `idempotency_conflict` | Same id, different bytes. Generate a new id |
| `RECIPIENT_KEYS_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, timeout, malformed answer, any other error | `unavailable` | Infrastructure. Retry the SAME envelope; it is idempotent |
| Realtime-local | `rate_limited`, `policy_denied`, `unauthorized_conversation`, `actor_mismatch`, `invalid_payload` | As above |

Crypto and authorization failures are never retried by the server. After `recipient_keys_unavailable` following an uncertain outcome, reconcile history first: a message that already committed with the old epoch can be refused on retry after a rotation, even though it is stored.

## 8. Key-change behavior

`conversation:keys-changed` is a hint that the key directory may have changed. It is never proof: the client must fetch and verify the directory.

Triggers (after DATA responds 2xx): `POST /api/keys/devices` (201), `POST /api/keys/devices/:deviceId/revoke` (200), `POST /api/conversations/:id/keys/epochs` (201). For a device change, every conversation of the account is notified; for an epoch, the one conversation.

Payload and authorization: each account's payload is built by DATA itself (`keys.state` as that account), so an account DATA would refuse (not a member, unfriended, blocked, ended session) receives nothing, and an account's room membership must also hold. The event carries only `keyId` and `epoch`; never keys, wraps, signatures or device records.

What it does not guarantee:

- DATA has no change feed. The trigger is this process's HTTP mutations. A change made through another DATA process, a script, or while a client was offline produces no event, and nothing is replayed on reconnect. No polling was added because polling cannot make delivery guaranteed either.
- Safety does not depend on the hint. DATA refuses (403 `RECIPIENT_KEYS_UNVERIFIED`, ack `recipient_keys_unavailable`) any send encrypted for a stale device set or epoch, including after a device registration or revocation, so a client with a stale view fails closed.
- Clients must refetch the directory on connect and before encrypting after an error, in addition to on the event.

## 9. Delivery

- Only currently authorized members receive `message:new`, after the message is committed.
- Persistence, delivery and read are distinct: `sent` (committed, ack), `delivered` (a recipient's socket confirmed receipt; DATA stores a `delivered` receipt; the sender gets `message:delivered`), `read` (`message:read` event; DATA stores a `read` receipt; the sender gets `message:read`).
- Repeated read returns the original timestamp and does not notify again. Only the intended recipient can record receipts; the sender and strangers get an error.
- Presence honors the stored `presencePreference` before the first publish (an invisible account is never announced online) and updates live when DATA's `PATCH /api/users/me` commits through this process. If the preference cannot be read at connect, the handshake fails closed.

## 10. Reconnection and history reconciliation

- A reconnect is a new handshake: cookie, Origin, CSRF token and grants are all re-verified. An old cookie or old CSRF token is `UNAUTHORIZED`. After a new login use the new cookie and a fresh `GET /api/auth/csrf`.
- Only rooms DATA still allows are rejoined.
- The socket joins its rooms synchronously while the connection is established, before the client can send its first request. So the client should connect first, then read history (`GET /api/conversations/:id/messages`, newest first, cursors), then dedupe by the wire message `id`. A message committed before the join is in history; a message committed after it is delivered live; the overlap collapses by `id`. This is tested with a concurrent sender (test `reconnect.test.ts`).
- Live events are hints. DATA history is authoritative for content, `sequence` and `storedAt`.
- No exactly-once claim. A recipient can see a message live and again in history (dedupe by `id`), and a recipient can miss the live event of a committed message (ack timeout then duplicate retry, offline, or delivery withheld because authority was stale) and must reconcile from history.

## 11. Deployment

```
cd server
npm run start:data          # DATA + realtime in one process; DATA reads DATA/.env or the environment
```

- DATA configuration is DATA's own (`PORT`, `HOST`, `DB_PATH`, `AUTH_ALLOWED_ORIGINS`, `AUTH_ALLOW_HTTP_LOCAL`, `AUTH_TRUST_PROXY_IPS`, `AUTH_SESSION_TTL_SECONDS`). The realtime server takes its origins, cookie name and proxy trust from DATA's `auth.config`; there is no second origin list. Optional: `DATA_ROOT` (path of the DATA checkout).
- TLS: terminate TLS in a proxy that DATA trusts (`AUTH_TRUST_PROXY_IPS` lists exact proxy peer IPs; the proxy must set `X-Forwarded-Proto: https`) or terminate it in Node. Forwarded headers from any other peer are ignored. `AUTH_ALLOW_HTTP_LOCAL=true` is development only and DATA forbids it in production.
- The proxy must forward WebSocket upgrades on `/socket.io` to the same upstream as `/api`.
- Single instance. Rooms, presence and typing are in process memory, and the change observer sees only this process's HTTP traffic. Running several instances needs a Socket.IO adapter and a cross-process change feed that DATA does not provide.
- `src/main.ts` (`npm start`) is still the standalone fail-closed realtime process. It has no adapters and rejects every connection.
- `main.ts` for DATA mode never loads `server/.env` (no AI keys are needed or read).

## 12. Security properties

- Authentication, authorization, key verification and persistence are DATA's. No competing verifier, session store, authorizer cache of record or database.
- Fail closed: DATA unavailable, malformed answers, timeouts and binder failures reject the handshake or the send and never grant or broadcast.
- No plaintext, no v1 on bound connections, no client-supplied identity, no JWT.
- Logs carry event names, codes and counters only: no ciphertext, IV, keys, tokens, cookies, session ids, envelopes, display names or error messages. Tests assert this.
- Delivery re-authorization and the per-call DATA proof check mean a revoked session, block or unfriend stops delivery and writes even if a cached grant lingers.

## 13. Test evidence

See [section 15](#15-test-evidence-record). Real-integration tests live in `server/test/data/` and `server/test/e2ee/data-integration.test.ts`; they start the real DATA application on an isolated temporary SQLite file, mount the real realtime server through `attachRealtimeToData`, and use real `socket.io-client` sockets with accounts registered through DATA's REST API, device keys and epochs created with independent WebCrypto code, and real HPKE-wrapped keys and AES-GCM v2 ciphertext. The DATA rate limiter dependency is replaced by a permissive one (DATA's documented `limiter` injection) because DATA caps registrations at five per hour per source. Everything else is DATA's code.

## 14. Limitations and production readiness

1. The client cannot use this path yet. `SocketIoRealtimeClient` has `canSendMessages = false`, no `auth.csrfToken` option, v1/demo parsers and no `conversation:keys-changed` listener (see the client handoff). No two-browser test through the real client UI was possible from `server/`.
2. Single process, single instance (section 11).
3. Key-change events are hints without durability (section 8).
4. Typing and presence authorization has a short staleness window (section 5).
5. A user is limited to 1,000 granted conversations (`maxConversationsPerUser`); more fails the handshake closed rather than truncating.
6. The observer refreshes every connected user after a social change (debounced, 8 at a time), and the 15 second sweep re-reads every connected user too. Each is O(connected users) synchronous DATA reads (a few small queries per user); fine for a single instance of moderate size, not for large ones. `timing.revalidationIntervalMs` can be raised through `DataRealtimeOptions.timing` at the price of a longer typing and presence staleness window.
7. Presence preference changes made through another process are not observed until the next connect.
8. `conversation:updated` has no DATA-originated trigger.
9. No load or soak test was run. No test of TLS termination exists beyond unit tests of the transport verdict.
10. DATA's own limits still apply: ten active devices per account, five sessions, the REST rate limiter.

DATA handoff: none required. All DATA behavior this integration needs already exists. Optional DATA-side improvements, not blocking: a durable change feed (outbox with a cursor) for key and relationship changes, which would allow multi-instance realtime and guaranteed key-change delivery, and an API for "accounts that blocked me".

## 15. Test evidence record

Recorded at the end of the implementation. Commands run from `server/`:

| Suite | Command | Result |
| --- | --- | --- |
| Type check | `npm run type-check` | 0 errors |
| Full server suite | `node --test --test-concurrency=1 --test-timeout=60000 "test/**/*.test.ts"` | 478 tests, 478 pass, 0 fail, 0 cancelled, 0 skipped (118 s) |
| DATA suite (regression, unmodified DATA) | `node --test` in `DATA/` | 321 tests, 321 pass |

Baseline before this work: 397 tests, 394 pass, 2 fail, 1 cancelled. The 2 failures were `test/e2ee/data-integration.test.ts` assumptions that DATA had no verifier and no v2 support; DATA now ships both, so that file was rewritten against the real key directory (5 tests, all pass). The cancelled test was a machine-load timeout and passes. 81 tests were added.

New real-integration tests (real DATA on an isolated temporary SQLite file, real Socket.IO, real WebCrypto devices):

| File | Tests | Covers |
| --- | --- | --- |
| `test/data/authentication.test.ts` | 15 | cookie, Origin, session-bound CSRF (missing, forged, pre-login, foreign), extra auth keys, demo identity, expiry, logout, account switching, revocation without the observer, periodic check, transport verdict |
| `test/data/authorization.test.ts` | 10 | rooms, new DM without reconnect, unfriend, block, cached-grant refusal by DATA, delivery re-authorization between commit and fan-out, presence, read receipts, stolen conversation id, account isolation |
| `test/data/messaging.test.ts` | 13 | v2 send, persistence before ack and delivery, replies, multi-socket, retry and conflict, v1 and plaintext refusal, stale epoch and missing device, spoofed sender and name, stranger, DATA outage, ack timeout with late commit, receipts, DATA write budget, log hygiene |
| `test/data/keys.test.ts` | 9 | `conversation:keys-changed` for device register, revoke and epoch; null epoch; payload shape; refused accounts; idempotent and refused requests; no replay; fail-closed on stale views; key-state failure |
| `test/data/reconnect.test.ts` | 7 | offline gap and history, subscribe-then-fetch under a concurrent sender, lost-ack retry, re-authentication, lost rooms, DATA unavailable at handshake, refresh failure |
| `test/data/boundaries.test.ts` | 5 | no DATA import, env and logging rules, package export, attach-time shape check |
| `test/data/process.test.ts` | 1 | `npm run start:data` as a child process: real accounts, real v2 message, foreign origin refused |
| `test/integration/data-binding.test.ts` | 21 | the seam with doubles: binder, handshake shape, failure-mapping table, fan-out rules, `canReceive`, presence preference, key events, config validation |
| `test/e2ee/data-integration.test.ts` | 5 | DATA over REST: no-verifier 503, v1 refusal, accepted v2, authorization before verification, no plaintext at rest |

Flakiness check: the real-DATA files were run five times in a row (45 of 45 each time) and the seam and authentication files twelve times (36 of 36). One earlier full run, executed while a large file-hash scan ran on the same disk, stalled the process for four minutes in one test and reported it cancelled; it did not reproduce in eight isolated and three idle full runs. Mutation checks confirmed that removing the DATA budget charge, the duplicate fan-out guard, or the delivery re-authorization each fails a test.

Not proven by these tests: the real browser client (see section 14), load, TLS termination, multiple instances.
