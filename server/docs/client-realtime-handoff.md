# Client handoff: encrypted realtime messaging over Socket.IO (for Codex)

From: Kiro (`server/`). To: Codex (`client/`). Server details: [realtime-data-integration.md](realtime-data-integration.md). Nothing in `client/` was changed by this work.

The server side is ready: real DATA sessions, session-bound CSRF, DATA-persisted envelope v2, post-commit delivery, receipts, typing, presence and key-change hints. It was verified with simulated clients (real sockets, real WebCrypto, real HPKE and AES-GCM v2). The real `SocketIoRealtimeClient` cannot take part yet. This document lists what has to change on the client, in the order a two-browser test needs it.

## 1. What blocks the real client today

| Client code (audited) | Gap |
| --- | --- |
| `SocketIoRealtimeClient` (`canSendMessages = false`) | Never emits `message:send` |
| `SocketClientOptions` | No way to pass `auth: { csrfToken }`. The server now requires exactly `{ csrfToken }` for real accounts and refuses a handshake without it (`UNAUTHORIZED`) |
| Server-event parsers and `PROPOSED_EVENT_NAMES` | Describe v1 and demo scope. `message:new` with `encryption.version: 2` and `keyId` is rejected as unknown fields; `conversation:keys-changed` is unknown |
| Send path | Encrypted v2 messages go over REST (`POST /api/conversations/:id/messages`) only |

The server's other events (`message:delivered`, `message:read`, `typing:update`, `presence:update`, `conversation:updated`) and every connect and ack error code are unchanged, so the parts of the adapter that handle them keep working. The existing client compatibility test still passes against the server's legacy mode.

## 2. Handshake

```ts
const { csrfToken } = await (await fetch('/api/auth/csrf', { credentials: 'include' })).json();
const socket = io(realtimeUrl, {
  path: '/socket.io',
  withCredentials: true,
  auth: { csrfToken },          // exactly this one key; any extra key is rejected
  transports: ['websocket', 'polling'],
});
```

- The realtime endpoint is on the same origin and server as the REST API. The page origin must be in DATA's `AUTH_ALLOWED_ORIGINS` (a foreign Origin is refused at the transport with no error code).
- The session cookie is `HttpOnly`; the client never reads it. Do not send `userId`, `sessionId`, tokens or names in `auth` or the query string; they are rejected or ignored.
- The CSRF token is stable for a session and changes at each login. Fetch it after login and again after any new login. Never reuse one across accounts.
- `connect_error.data.code`:
  - `AUTH_REQUIRED`, `UNAUTHORIZED`, `SESSION_EXPIRED`: authentication failures. Do not loop. On `UNAUTHORIZED` fetch a new CSRF token once and retry once; if it fails again treat the user as logged out.
  - `REALTIME_UNAVAILABLE`: DATA or the realtime service could not decide. Retry with backoff.
  - `CONNECTION_LIMIT`, `POLICY_DENIED`: show a generic error; back off.
- Logout (`POST /api/auth/logout`) closes the account's sockets from the server. On the client, also close the socket and drop all key material for that session. Account switching means a new login, a new CSRF token and a new socket.

## 3. Sending

Emit `message:send` with the envelope v2 the client already builds for REST:

```json
{ "id", "conversationId", "senderId", "senderName", "timestamp", "type": "text",
  "encryption": { "version": 2, "algorithm": "AES-256-GCM", "encoding": "base64", "keyId", "iv", "ciphertext" } }
```

- `senderId` must be the session user and `senderName` the current profile name. There is no v1 and no plaintext field on this path.
- Use the Socket.IO ack callback (with a timeout of at least 8 seconds). Success is exactly `{ conversationId, messageId, status: 'sent', timestamp }`. `timestamp` is DATA's authoritative `storedAt`; use it for the sent time.
- Keep the message `id` stable for every retry of the same message. The server is idempotent on `(sender, conversation, id)`.

Ack errors (unchanged closed set) and what to do:

| `code` | Do |
| --- | --- |
| `invalid_payload`, `actor_mismatch` | Permanent. Do not retry. Fix or report a bug |
| `unauthorized_conversation` | Permanent for now (not a member, no longer friends, blocked). Refresh the conversation list |
| `recipient_keys_unavailable` | Crypto or authorization failure. Do not blind-retry. 1) Refetch `GET /api/conversations/:id/keys`, verify device records and epoch signatures. 2) Look up the id in history; if it is already stored, mark it sent. 3) Otherwise re-encrypt for the CURRENT epoch and resend with the SAME `id` |
| `rate_limited` | Retry later with backoff |
| `unavailable` | Infrastructure or timeout. Retry the SAME envelope (same bytes) with backoff. The outcome may be unknown; a retry that finds it stored is acknowledged `sent` with the original timestamp |
| `idempotency_conflict` | Same `id`, different bytes. Create a new id |
| `policy_denied` | The server closed the socket (session or CSRF no longer valid). Re-authenticate |

An ack timeout means the outcome is unknown. Retry the same envelope (do not re-encrypt) or reconcile through history.

## 4. Receiving

`message:new` payload: the committed v2 envelope plus `deliveryStatus: 'sent'`. Extend the parser to accept `encryption.version === 2` with `keyId`. Then:

1. Find the epoch key by `encryption.keyId`. If it is unknown, fetch `GET /api/conversations/:id/keys/epochs/:keyId`, verify the creator device and signature as the existing key manager does, unwrap with this device's key.
2. Decrypt with the v2 AAD (`['yahoo-security-messenger', 2, conversationId, id, senderId, senderName, timestamp, 'text', keyId]` as already implemented for REST history).
3. Dedupe by the wire `id`.
4. Confirm delivery with the Socket.IO callback only after the message is handled: `ack({ conversationId, messageId: id, status: 'delivered' })`. The server stores a `delivered` receipt and notifies the sender (`message:delivered`).

The live event has no `sequence` or `storedAt`. Treat it as an optimistic display and let history supply ordering (`sequence`) and `storedAt`.

Read receipts: emit `message:read` `{ conversationId, messageId }` with an ack. Success is `{ conversationId, messageId, status: 'read', timestamp, userId }`. Errors are the same closed set (`message_not_found`, `unauthorized_conversation`, ...).

## 5. Key changes

Add `conversation:keys-changed` to the event names and parser. Payload is exactly `{ conversationId, currentEpoch: { keyId, epoch } | null }`.

- It is a hint, never proof. On receipt refetch `GET /api/conversations/:id/keys`, verify, and apply the existing trust-on-first-use flow for new or revoked devices.
- If `currentEpoch` differs from the epoch you hold, load the new epoch. If the current epoch does not cover all active devices of both participants, publish a new epoch before the next send (DATA refuses sends encrypted for an old device set).
- It is process-local and not replayed. On every connect and before encrypting after a failure, refetch the directory regardless of events.
- Do not assume the event reached anyone. DATA protects stale clients by refusing their sends (`recipient_keys_unavailable`).

## 6. Reconnect and history

Order of operations after any connect or reconnect:

1. Obtain a fresh CSRF token if the session changed; connect (this authenticates and joins your rooms before anything else can happen).
2. Fetch history for open conversations through `GET /api/conversations/:id/messages` (newest first, cursor pages) until you reach a message you already have.
3. Merge by wire `id`, order by `sequence`, take times from `storedAt`.
4. Refetch the key directory for open conversations.

Subscribing before reading closes the gap: anything committed after the socket joined arrives live, anything before is in history, the overlap dedupes by `id`. The server does not replay missed events and does not claim exactly-once delivery.

Pending sends at disconnect: resend the same envelope after reconnect; do not create a new message.

## 7. Presence, typing, conversation updates

Unchanged. Note: `presence:update` with `status: 'unknown'` means you are no longer allowed to see that user (unfriend, block). Drop the subject. Typing and presence are authorized from cached grants that refresh within about 15 seconds at worst, usually within tens of milliseconds when the change was made through the same server.

## 8. Acceptance checklist for a two-browser test

1. Alice and Bob register, log in, befriend, create the DM, register devices, publish epoch 1 (existing REST flow).
2. Both connect with `auth.csrfToken`. A connection without it must fail with `UNAUTHORIZED`.
3. Alice sends v2 over the socket. The ack has `status: 'sent'` and DATA's `timestamp`. Bob's UI shows the decrypted text without a refresh. History after reload shows the same ciphertext.
4. Bob replies; Alice decrypts.
5. Bob registers a second device: Alice receives `conversation:keys-changed`, refetches, and a send encrypted for the old set is refused until a new epoch is published.
6. Alice's socket drops, Bob sends, Alice reconnects: history shows the message once.
7. Alice logs out in another tab: her socket closes immediately; reconnect with the old CSRF token fails.
8. Alice blocks Bob: neither can send or see typing; `presence:update` becomes `unknown`.
