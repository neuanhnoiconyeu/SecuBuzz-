# Authenticated client realtime integration

Date: November 16, 2026. Scope: `client/` only. This extends the persistent E2EE implementation documented in [E2EE_CLIENT_INTEGRATION.md](E2EE_CLIENT_INTEGRATION.md). Current validation and browser evidence are recorded under [artifacts/client-realtime](artifacts/client-realtime/verification.json).

## Contract audit

The implementation follows `server/docs/client-realtime-handoff.md`, `server/docs/realtime-data-integration.md`, the actual `server/src/realtime/{server,protocol,validation,receipts,messages}.ts` code and `server/src/data/` bridge, plus `DATA/docs/{e2ee-realtime-integration.md,messaging-openapi.json,e2ee-keys-openapi.json}`. These sources govern the wire contract. Older client/demo v1 types cannot represent the v2 events.

Real accounts use `AuthenticatedSocketIoClient` through a direct import. The legacy `SocketIoRealtimeClient` interface remains read-only and avoids loading browser-only modules into Kiro's Node compatibility tests; demo/mock flows keep their existing models and tests. `RealMessengerWorkspace` owns a single authenticated transport and `SecureRealtimeWorkspace` per scoped `SessionApi`. Disposal precedes key/session disposal. No new crypto library, database schema, login mechanism or server code was introduced.

## Authentication and routing

`HttpAuthService.createSessionApi().realtimeAuth()` checks `/api/auth/me`, obtains a fresh `/api/auth/csrf` proof through the existing auth owner, then checks the cookie identity again. Requests share the existing cancellation, fixed errors and session invalidation. Disposed or switched actors cannot return a late proof. Each connection attempt creates a new Socket.IO manager with exactly `auth: { csrfToken }`, `withCredentials: true`, no query identity, no JWT, no bearer cookie read and no auth logging.

The browser connects to its own origin with path `/socket.io` and `addTrailingSlash: false`. The Next rewrite explicitly maps that endpoint to DATA's `/socket.io/`. An empty wildcard destination originally removed the slash and returned 404; browser verification exposed and resolved this client routing mismatch. Both HTTP and WebSocket paths were subsequently exercised. REST and realtime use the same `AUTH_BACKEND_URL`, whose existing validation requires HTTPS in production and allows loopback HTTP only outside production.

Deployment must preserve Cookie, Origin and WebSocket upgrades, route both transports to the combined DATA/realtime application, and configure DATA's exact allowed public Origin and trusted TLS proxy. No trust headers are manufactured by browser code. Socket.IO options were checked against the [official client options](https://socket.io/docs/v4/client-options/) and [socket lifecycle](https://socket.io/docs/v4/client-socket-instance/) documentation.

`AUTH_REQUIRED` / `SESSION_EXPIRED` invalidate the scoped session. `UNAUTHORIZED` gets one fresh-proof retry, then invalidates. Other failures use six bounded attempts with exponential delays from one second to a fifteen-second cap; an exhausted connection exposes manual reconnect. Online/focus/visibility events can start another bounded attempt and reconciliation. Server disconnects reauthenticate. No unbounded automatic message retry is enabled.

## Shared encrypted send pipeline

Both transports call `SecureMessagingSession.send` and `retryPending`. Every new logical message fetches current conversation/key state, verifies signed devices/epoch and TOFU trust, uses the existing AES-256-GCM v2 encryption and durable nonce reservation, and atomically saves one exact pending envelope in account-scoped IndexedDB. Retrying preserves the wire ID, authenticated metadata, epoch, IV and ciphertext.

For live sends, `message:send` carries only the seven envelope fields (`id`, `conversationId`, `senderId`, `senderName`, `timestamp`, `type`, `encryption`). The ten-second persistence deadline exceeds Kiro's eight-second requirement. The callback accepts exactly `{ conversationId, messageId, status: 'sent', timestamp }` bound to the emitted message. The timestamp is DATA's original `storedAt`, including idempotent duplicates. The client reads the committed REST row, compares ciphertext/metadata and acknowledgement timestamp, and obtains real storage ID and sequence before clearing the matching pending record. It never POSTs another copy to obtain those fields.

Timeout/disconnect/unavailable means unknown outcome, with the pending envelope retained. Explicit retry first scans history for that ID, verifies an existing result, and only then may submit the same bytes through the chosen transport after fresh key verification. A scan stops with a resource-limit error after twenty pages instead of assuming absence. No automatic transport fallback or re-encryption occurs. `invalid_payload`, `actor_mismatch` and `idempotency_conflict` are permanent refusals; conflicting bytes never generate a new logical ID. `rate_limited` imposes a five-second minimum wait; key refusals fetch and verify current key state and expose review without resending. Authorization/session failures revoke appropriate authority.

The composer reports encrypting, sending, awaiting persistence acknowledgement, persisted/delivery pending, retryable failure, permanent refusal and verification failure. Per-message delivered/read indicators require their own authoritative observations. Persistence never implies recipient receipt or decryption.

## Receive and history reconciliation

`message:new` must be the exact v2 envelope plus `deliveryStatus: 'sent'`. Validation rejects plaintext fields, v1, unexpected properties, unknown conversations and non-participant senders. `decryptIncoming` uses the same historical signed epoch opening, browser device keys and AES-GCM authentication as REST history; it rechecks conversation access. The event is then reconciled with committed REST history. Because the event carries no sequence or storage UUID, the client invents neither. Accepted plaintext remains in session memory and the UI only.

History merges by the wire message ID within each conversation, orders by DATA sequence, checks conflicting immutable bytes, and preserves newer deletion revisions. Live notifications arriving during an in-flight history request mark it dirty and force a subsequent fetch. On connect, Kiro's connection success is the room-ready barrier, followed by history reconciliation. Reconnect follows older cursors until a known anchor (up to two hundred pages per conversation, failing visibly if exceeded). Initial views load one history page; older messages remain explicitly pageable. One unavailable conversation does not stop others from recovering.

Conversation grants are refreshed every fifteen seconds and on reconnect/focus/manual refresh. New grants reconnect to obtain the server's room-ready barrier. Removed interaction authority clears rows, previews, unread, typing and receipts from live state and blocks the composer. Generation/access barriers discard late old-session or revoked-scope results. The server's current per-operation authorization remains authoritative during refresh windows. No exactly-once network delivery or replay feed is assumed.

Current and other subscribed conversations update without manual refresh. Unread counts and previews are session-local observations, not a durable unread database. Another device of the sender account receives and decrypts its messages without claiming recipient delivery. Scroll follows new messages only when the reader is near the bottom; older-page browsing retains its position. Sidebar names have stable accessible labels and unread descriptions.

## Keys, typing, presence and receipts

| Event | Exact body / behavior |
| --- | --- |
| `conversation:keys-changed` | `{ conversationId, currentEpoch: { keyId, epoch } \| null }`; hint only. Invalidate readiness, fetch the signed directory, apply existing TOFU review. Historical epoch keys remain available for old authorized history. No current-directory cache is retained. Reconnect and every new send revalidate even if the hint was missed. |
| `typing:start` / `typing:stop` | `{ conversationId }`; authorized scope only, starts throttled to 1.5 seconds, idle stop after 2 seconds, stop on selection/visibility change or blur/disposal. Disconnect clears indicators. |
| `typing:update` | `{ conversationId, userId, displayName, isTyping, timestamp }`; participant checked, stale updates ignored, indicator expires after 5 seconds. No draft content. |
| `presence:subscribe` | `{ userIds }`; current authorized peers, bounded to 200. No preference setter or implied online state. |
| `presence:update` | `{ userId, status, timestamp }`; known peers only. `unknown` removes previously visible status after authorization loss. Kiro represents invisible as `offline`. Preferences are governed by DATA, never overridden by the connection. |
| `message:new` callback | `{ conversationId, messageId, status: 'delivered' }` only after successful local decrypt, committed-row match and current access. No callback for failed decrypt or own-account sender. DATA persists the receipt before notifying the sender. |
| `message:delivered` / `message:read` | `{ conversationId, messageId, status, userId, timestamp }`; exact shape and peer scope checked. Read cannot regress to delivered. |
| `message:read` request | `{ conversationId, messageId }`; only decrypted incoming rows in the selected visible chat. Callback must match actor, conversation, message, read status and timestamp. Failed writes create no success state. |
| `conversation:updated` | Refresh the authorized conversation list. This event supplies no new authority. |

The existing contact-key warning and explicit “Trust these device changes” action remain required. The safety number is server-authenticated plus TOFU, not independently verified identity. New browsers need explicit enrollment and cannot recover old epoch wraps; revoked devices cannot prepare future messages. Previously received keys cannot be remotely erased. Same-origin malicious JavaScript remains outside browser key-storage protection.

Receipt indicators are observations within the current workspace. The audited message-history DTO has no receipt projection; after a full page reload, an old receipt is not fabricated from message persistence. Read remains monotonic among the authoritative receipt events observed during the workspace lifetime.

## REST and UI compatibility

The transport selector makes REST use explicit. Both choices share encryption, nonce reservations and the one durable pending envelope. REST may commit without immediate socket fan-out; the UI explains that the contact may need history refresh. Switching a pending message reconciles first and cannot silently duplicate or use changed keys. There is no plaintext or v1 fallback.

The existing Midnight/light/dark/System themes, Bungee/Space Grotesk typography, profiles, Friends, AI Hub, navigation, key recovery UI and responsive layout remain in place. Necessary additions are connection/send states, typing/presence, receipts, unread descriptions, previews and explicit transport choice. No OS notification permission or new account-facing implementation workflow is introduced.

## Reproducible validation

Run from `client/`: `npm test -- --runInBand`, `npm run type-check`, `npm run lint`, `npm run build:verify`, and `npm run test:realtime:browser`.

The browser harness starts its own combined `server/src/data/main.ts` process, DATA SQLite under a unique ignored `client/tmp/` directory, independent Next output/config and isolated Chrome contexts. It stops only the process trees it created. Real accounts/cookies, API, key verifier, persistence, socket transport, UI and local decryption are used. Evidence contains status/path/count metadata and redacted screenshots, never passwords, cookie/CSRF values, key material, raw frames or decrypted logs. Exact final counts, source hashes and scope checks are in `artifacts/client-realtime/verification.json`; the browser steps are in `browser-evidence.json`.

## Final verification

The final full frontend run passed **867 tests in 73 suites, 0 failed and 0 skipped** (baseline: 810 tests in 70 suites). `npm run type-check` passed. `npm run lint` passed with the two pre-existing `no-img-element` warnings in MessageComposer and MessageList. `npm run build:verify` compiled production output, validated types/lint and generated all six static pages in a unique `.next-e2ee-build-*` directory. Its inherited-config plugin notice does not change the user's main TypeScript configuration.

`npm run test:realtime:browser` passed **41 checks, 0 failed and 0 skipped**, with isolated real Alice/Bob/Charlie accounts and an additional Bob browser context against the genuine combined DATA/Socket.IO process. It observed 13 exact CSRF-only browser handshakes, seven envelope-v2 socket sends, seven persistence acknowledgements, nine committed live events and one explicit REST send. It verified both live directions without Refresh, durable delivered-before-read behavior, invisible-as-offline and restored presence, reload identity/history, offline-gap recovery, server restart, key review/epoch rotation, same-account device fan-out, device revocation, blocking, account switching, themes/fonts/mobile layout, and zero detected plaintext leakage or browser runtime exceptions. A separate real WebSocket probe rejected missing credentials with `AUTH_REQUIRED`.

The changes are listed in [REALTIME_FILES.md](REALTIME_FILES.md). Read-only comparison with the saved worktree snapshot preserved 172 pre-existing paths outside client and all three development SQLite files. Branch, HEAD and stashes remain unchanged; the main TypeScript config's timestamp predates the task, and the generated type cache is restored from its original raw-byte snapshot. No commit, push, merge request, existing-service restart or server/DATA/root edit is performed.

Completion applies to this client integration. Production TLS/reverse-proxy deployment, multi-node realtime behavior, load capacity, cross-browser coverage and independent identity verification are not established by local Chrome acceptance. No new DATA/Kiro implementation is required for the verified single-process flow.
