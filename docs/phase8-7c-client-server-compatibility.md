# Phase 8.7C — Client/server compatibility and integration hardening

Workspace: `D:\Projects\SecuBuzz-`. Branch: `chuong-fullstack`. Inspection baseline: clean `5f539608bac8c8fcfa5edce7fd078baf16c83409` (merged PR #6). No branch merge, reset, publication, dependency installation or readiness change was performed for this phase. The pre-existing backup stash was left alone.

## A. Findings and source of truth

Inspected the client contract, server integration handoff and 8.7B implementation report, then checked the actual implementations: `realtimeModel.ts`, `realtimeValidation.ts`, `SocketIoRealtimeClient.ts`, `RealtimeMessagingTransport.ts`, `useSessionRealtime.ts`, `useConversationMessages.ts`, messaging models/transport/state, `ApiRealtimeConnection.tsx`, the session factory and auth lifecycle. On the server, inspected `protocol.ts`, validation, authentication, event gating, message routing, receipts, configuration/lifecycle, and the existing integration harness/fixtures/tests.

Two confirmed incompatibilities were repaired:

1. The socket read callback parsed only success. A perfectly valid `{status:'error', code:'message_not_found'}` became `invalid_payload`. The bridge also parsed only successful send results. Both now parse recognized failure acknowledgements separately, preserve the exact server code and reject the operation with fixed safe wording. Real sending is still disabled.
2. The socket adapter dropped the second `message:new` argument: the server's delivery acknowledgement callback. Added a bounded, session-owned confirmation boundary and connected it through the existing participant validation and authenticated incoming-message path. The application factory supplies no recipient-key verifier, so real confirmation remains disabled.

Handshake classification already distinguished explicit auth failures from unavailability. It now also preserves the exact recognized handshake code, with separate safe mappings for policy, capacity and origin failures. No server implementation defect was confirmed or patched.

## B. Implemented contracts

### Error callbacks

Failure callbacks have exactly two fields:

```ts
{ status: 'error'; code: ServerAckErrorCode }
```

| Server callback code | Internal code | Safe meaning |
| --- | --- | --- |
| `invalid_payload` | Same | Invalid operation/event |
| `unauthorized_conversation` | Same | Conversation unavailable for this session |
| `rate_limited` | Same | Wait before another request |
| `unavailable` | Same | Realtime operation unavailable; not evidence of invalid login |
| `message_not_found` | Same | Message unavailable on server |
| `actor_mismatch` | Same | Operation does not match authenticated account |
| `idempotency_conflict` | Same | Message identifier already used for different metadata |
| `recipient_keys_unavailable` | Same | Recipient keys unavailable; remote sending disabled |
| `policy_denied` | Same | Server policy disallows operation |

`RealtimeOperationError.serverCode` preserves these exact values. All mapped failures have `retryable=false`: no automatic retries or retry permission inferred from an error label. In particular, a timeout or `unavailable` response must not be taken as proof that an operation did not commit. The bridge retains its existing explicitly retryable demo-send policy and maximum of three attempts; a permanent server rejection cannot use it.

Successful read callbacks remain `{conversationId,messageId,status:'read',timestamp,userId}`; the server supplies the authenticated reader. Client validation checks matching IDs and, when present, matching actor. Optional `userId` is retained for backwards compatibility with existing normalized clients; the actual server always supplies it. Successful send callbacks remain `{conversationId,messageId,status:'sent',timestamp}` with matching request IDs. `message:ack` is reserved; it is not a second acceptance signal.

Unknown codes, extra diagnostic fields, malformed acknowledgements and success/failure hybrids fail closed as `invalid_payload`. Error objects contain fixed client messages, not backend messages, stacks, credentials or raw payloads. Normalized error events accept `serverCode` only when it agrees with their internal code.

### Handshake errors and auth lifecycle

Socket.IO supplies `connect_error` with `error.data = {code}`. These are not event callback codes:

| Wire code | Internal code | Session behavior |
| --- | --- | --- |
| `AUTH_REQUIRED` | `authentication_rejected` | Lock adapter; existing API UI asks AuthProvider to revalidate |
| `UNAUTHORIZED` | `authentication_rejected` | Same |
| `SESSION_EXPIRED` | `authentication_rejected` | Same; safe message asks user to sign in again |
| `REALTIME_UNAVAILABLE` | `unavailable` | No auth revalidation or mock fallback; adapter not locked |
| `CONNECTION_LIMIT` | `connection_limit` | No auth invalidation |
| `ORIGIN_NOT_ALLOWED` | `origin_not_allowed` | No auth invalidation |
| `POLICY_DENIED` | `policy_denied` | No auth invalidation |

The first three codes are not accepted as invented error-ACK bodies. A live server expiry/revocation currently sends only `io server disconnect`, without an authenticated reason event. The client becomes disconnected and does not automatically reconnect or invent a logout cause. The existing AuthProvider rechecks `/me` on focus/visibility and every 60 seconds while visible. An explicit reconnect with the expired cookie produces `SESSION_EXPIRED`, which triggers existing revalidation. Immediate expiry-specific notification would require a future agreed server contract; no speculative event was added.

### Actual delivery confirmation

There is **no new client-to-server event**. For a stored envelope, the server emits:

```ts
socket.emit('message:new', encryptedEnvelopeWithDeliveryStatus, deliveryCallback)
// The recipient invokes that supplied callback with EXACTLY:
deliveryCallback({ conversationId, messageId, status: 'delivered' })
```

No actor ID, timestamp, plaintext, key or cookie is added. The server derives the recipient from its authenticated connection, checks membership/non-self/block conditions, records the per-recipient receipt, and emits `message:delivered` to the sender only after a newly created receipt is recorded. The sender's other devices receive envelopes without a recipient-delivery callback.

Server delivery means a recipient device confirmed receiving the encrypted envelope; it does **not** prove decryption or reading. The client deliberately uses a more conservative policy: the hook first authenticates/decrypts, then asks the bridge to confirm, then the adapter requires a trusted recipient-key attestation. Successful local demo decryption is insufficient to implement this attestation. No production verifier exists. A future trusted verifier must attest recipient/sender identity and key/envelope binding; returning true after only checking shape or environment flags is not a valid implementation.

The production factory omits `deliveryConfirmationVerifier`, and `canConfirmDelivery=false`. There is no enabling environment flag. Real sends remain `canSendMessages=false` and reject before any socket emit. Tests explicitly inject a test-only attestation over synthetic ciphertext through existing test sessions; this proves protocol compatibility, not production encryption/key distribution. The hook authentication tests separately exercise the success/failure gate through an injected crypto boundary.

When enabled only through this trusted injection boundary:

- The bridge projects its known conversation participants into a local allowlist. This is not a room join or proof of authorization: server authorization remains independent, and future real projections must come from authorized APIs.
- Only a connected real session can capture a callback for a structurally valid encrypted envelope in a watched conversation, from a known non-self participant. Demo/plaintext/browser-demo envelopes, malformed metadata and callbacks without valid envelopes are excluded.
- Confirmation must match the exact captured canonical envelope, including ciphertext and routing metadata; ID-only or changed-envelope requests cannot reuse it. The snapshot is detached and frozen before reaching the verifier. It contains no plaintext.
- Concurrent/repeated requests share one promise while retained; duplicate incoming IDs cannot replace the callback. No receipt or local delivery-state advancement is fabricated.
- At most 100 callback entries are retained, with a 16 MiB conservative string/entry accounting budget and a five-second lifetime from capture (below the server's default ten seconds). At most 1,000 conversation scopes / 1,000 participant IDs per scope / 10,000 total participant entries are accepted. These limits do not assert an exact JavaScript heap size.
- Disconnect, explicit stop, disposal/logout, bridge disposal, removal of a conversation or participant, timeout and attestation failure release callback handles and cancel pending requests. Late async completion checks entry identity and cannot act for a replacement session. Verification does not even start if cancellation precedes its scheduled start. No automatic retry, offline queue or reconnect replay is introduced.
- A resolved confirmation promise means **local callback submission only**. The server sends no ACK back for this ACK. A shorter server deadline, lost packet, changed membership, block or receipt-store failure may therefore suppress delivery without a client-side rejection. Real-socket tests demonstrate this. Only the sender's server-originated receipt establishes Delivered; the client never labels local callback submission as durable delivery.

### Message lifecycle

No second message history/store was added. `useConversationMessages` remains the displayed store. Sending → Accepted (`sent`) → Delivered → Read remains monotonic in the existing reducer. Read cannot regress, Delivered cannot regress to Accepted, unknown IDs cannot mutate state, duplicate messages remain deduplicated, and the bridge checks known non-self receipt actors and known outgoing IDs.

Receipt `userId` denotes one observing peer. A group Delivered/Read state means a known peer reported it; it does not claim all members or devices received/read the message. Per-member aggregation, quorum and server history/reconciliation remain future contracts. Read requests still require verified incoming text plus an active, visible, connected conversation; delivery does not depend on visibility and is separate from read.

## C. Configuration and security compatibility

| Area | Verified behavior / limitation |
| --- | --- |
| Versions | Installed server `socket.io` and both client packages: 4.8.4. No dependency changes. |
| Namespace/path | Defaults `/` and `/socket.io`; custom `/messenger` namespace with `/realtime/socket` engine path tested against the real server. A URL pathname selects the namespace; it is separate from `path`. Keep production settings aligned with deployment. |
| Cookies | Client chooses `withCredentials:true`, no auth token/user override/query credentials. The test factory only injects harness Cookie/Origin headers that a browser normally supplies. No test token enters application source. |
| Origin/CORS | Server uses explicit allowed origins and credentialed CORS plus namespace Origin recheck. Real-socket harness validates synthetic browser headers; actual browser cookie/SameSite/CORS/TLS deployment is not verified here. |
| Events/schemas | Canonical existing event mapping reused. Cross-package parity assertions cover names and both error-code allowlists; typing/presence/read/message/receipt/conversation parsers accept actual server payloads. |
| Payload limits | Server defaults: 128 KiB packet / 65,536 base64 ciphertext characters. Existing client parser safety cap remains 1,400,000. All default server emissions fit the client; this is not permission for larger sends. Future enabled-send validation must use the agreed operational limit. |
| Other validation | Server additionally rejects lone surrogate identifiers and reserved demo actors. The authenticated server remains authoritative; this patch does not relax validation or treat local allowlists as grants. |
| Reconnect | Client retains its private manager, bounded retries/backoff/deadlines and no automatic acknowledged-event retries. Explicit server disconnect is terminal. Callbacks/listeners are canceled or detached on disposal. |
| Session isolation | Auth-owned lifecycle unchanged. Auth rejection locks that adapter; a fresh authenticated session needs a fresh adapter. Bridge disposal clears its participant projection. Old callback handles cannot migrate to another adapter. |
| Demo isolation | Existing development-only Mock and production guards unchanged and tested. Missing APIs/configuration or server errors cannot activate mock transport. |
| Encryption | No crypto/key-management implementation changed. Real sends and default real confirmation remain disabled; no multi-user E2EE claim. |

Server implementation, auth/authorization, schemas/persistence, Kiro files, public flags, themes and visual components were not modified. The only changed server-package file is a client/server integration **test**.

## D. Files changed

Application/client contract changes:

- `client/src/realtime/realtimeModel.ts`: exact error-code types, safe messages and optional delivery interfaces.
- `client/src/realtime/realtimeValidation.ts`: separate failure callback/handshake parsers and safe normalized error projection.
- `client/src/realtime/SocketIoRealtimeClient.ts`: recognized error propagation, gated callback capture, participant scope and lifecycle cleanup.
- `client/src/realtime/deliveryConfirmations.ts` **(new)**: bounded transient confirmation handles and trusted attestation boundary.
- `client/src/realtime/RealtimeMessagingTransport.ts`: participant projection, validation and optional confirmation delegation; permanent failure handling.
- `client/src/messaging/transport.ts`: optional capability/method on the existing transport.
- `client/src/hooks/useConversationMessages.ts`: post-authentication confirmation request without changing read or message state semantics.

Tests:

- `client/src/realtime/__tests__/SocketIoRealtimeClient.test.ts`
- `client/src/realtime/__tests__/RealtimeMessagingTransport.test.ts`
- `client/src/realtime/__tests__/realtimeValidation.test.ts`
- `client/src/realtime/__tests__/createRealtimeClient.test.ts`
- `client/src/hooks/__tests__/useConversationMessages.realtime.test.tsx`
- `client/src/messaging/__tests__/realtimeMessageState.test.ts`
- `client/src/components/messenger/__tests__/ApiRealtimeConnection.test.tsx` **(new)**
- `server/test/integration/client-compatibility.test.ts`

Documentation: this report **(new)** and a compatibility-update pointer in `docs/realtime-client-contract.md`. Historical 8.7A/8.7B reports were not rewritten to imply their original implementations had this patch.

## E. Verification

Tests use the actual client adapter loaded via the existing scoped `tsx` importer against the unmodified server on ephemeral `127.0.0.1` ports. Session resolver, authorization, persistence and recipient-key verification come exclusively from the existing production-guarded `server/test/support` fixtures. Each test shuts down clients, server and HTTP listener. There are no new dependencies or fixed production credentials.

| Directory | Exact command | Final result |
| --- | --- | --- |
| `client` | `npm run type-check` | Exit 0 |
| `client` | `npm run lint` | Exit 0; two pre-existing Next `<img>` warnings |
| `client` | `npm test -- --runInBand` | Exit 0; **569 tests / 50 suites**, no failures or skips |
| `client` | `npm run build` | Exit 0; optimized build and six static pages; same two warnings |
| `server` | `npm run type-check` | Exit 0 |
| `server` | `npm test` | Exit 0; **197 tests / 28 suites**, no failures or skips; includes **26 cross-package tests** |
| `server` | `node --test --test-concurrency=1 --test-timeout=60000 test/integration/client-compatibility.test.ts` | Exit 0; 25 tests before adding the live-expiry regression; final full suite also executes this file |
| Root | `git diff --check` | Exit 0; no whitespace errors (Git reports normal LF→CRLF conversion notices) |
| Root | `git status --short` | Only the files listed in section D; no staged changes; generated incremental TypeScript info removed |

Frontend additions cover every recognized callback and handshake code, successful existing callbacks, unknown/malformed/hybrid errors, safe code projection, no retry after permanent rejection, timeouts/disconnects, default confirmation gate, invalid/duplicate/unknown/self/demo envelopes, metadata/ciphertext changes, prerequisite rejection/throw, callback throw, callback count and byte limits, missing callbacks, offline arrivals, stale async completion, scope removal, disposal/replacement and failed authenticated decryption. Existing auth/workspace tests still cover demo logout and identity switching; new API component tests verify actual auth rejection revalidation and no revalidation/mock selection for unavailability. Receipt state tests cover both terminal Read and Delivered non-regression.

Cross-package coverage extends the original 13 tests with actual server authorization/rate-limit/store errors, custom namespace/path, verified callback submission, delivery/read separation, group per-peer scope, unknown participants, key rejection, logout/replacement, reconnect/listener disposal, server callback expiry, receipt-store failure and live session expiry. It does not enable real adapter sends: a test peer sends only through the existing test store/verifier.

No browser interaction or visual test was executed. Jest DOM interaction and real Node Socket.IO tests are distinct from browser deployment verification. No DATA/database tests were run because that package was untouched. Existing dev servers were not stopped or repointed; production output uses `.next` independently of `.next-dev`.

## F. Delivery status and remaining owners

**Implemented and tested:** exact success/error compatibility, handshake classification, safe errors, session cleanup, server-compatible callback submission with trusted test injection, participant/envelope checks, bounded dedupe/retention, monotonic receipts and cross-package wire behavior.

**Implemented but gated:** delivery confirmation interface and post-authentication integration. The production session factory has no verifier, so no real confirmation is submitted. Real message sending remains disabled at the existing composer/hook/bridge/socket boundaries.

**Blocked for production integration:**

1. Database/API: approved cookie auth/CSRF/session endpoints and server SessionResolver over the same sessions; authorized profile/friends/conversation/participant/group-membership APIs; membership/block revocation push; durable idempotent MessageStore with per-recipient receipts and history/cursors.
2. Security: authenticated identities, recipient/group key distribution, key IDs/versions, rotation/revocation, agreed envelope semantics and real server RecipientKeyVerifier plus client delivery attestation. A synthetic test identity, local AES key or structural envelope is not sufficient.
3. Realtime/Kiro/deployment: wire the approved adapters; agree operational limits/timers, namespace/path, exact Origin/cookie/TLS policies, privacy preferences and multi-process routing. If immediate live-expiry reasons or recipient callback-result feedback are required, agree explicit protocol additions; neither is silently inferred here.
4. Recovery: history replay, cursor reconciliation, ambiguous-send lookup, receipt reconciliation and group all-member aggregation are not implemented. Socket.IO at-most-once transport and recent-window deduplication do not provide unlimited uniqueness, catch-up or exactly-once delivery.

Production cookies/authenticated multi-user integration and full multi-user E2EE are **not verified or claimed**. No Phase 8.6, 9 or 10 work is included.

**READY — Phase 8.7C complete.** This verdict covers compatibility implementation and isolated test-harness verification. Production authentication, real message sending, delivery confirmation with real recipient keys and multi-user E2EE remain gated by the dependencies above.
