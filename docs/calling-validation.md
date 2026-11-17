# Calling system validation — 2026-11-15

Historical validation record. Later filename integration and message-action test corrections are covered by [current push-readiness validation](fullstack-push-readiness.md); the results below describe the original run.

The calling implementation passes its focused automated checks. Actual cross-user LiveKit media has not been verified against a running deployment. Production remains disabled until the existing host integration dependencies are supplied. The complete frontend suite is not green because four unrelated message-menu tests fail.

## Fixes from this review

1. `useLiveDirectCalls.dismiss` now ignores active and mismatched call IDs before changing any controller state. Previously the reducer rejected dismissal but the method still cleared the current signaling reference, which could prevent a subsequent hangup from being synchronized.
2. A confirmed accepted broadcast now takes precedence over a stale error acknowledgement for the same Accept request. This retains media ownership and avoids leaving capture running without an owning call controller.

Both fixes have regression tests in `client/src/calls/__tests__/liveDirectCalls.test.tsx`. New real-frontend/backend compatibility tests in `server/test/integration/direct-call-client.test.ts` also verify that the actual frontend Socket.IO call channel can initiate, accept, end and synchronize calls, and that disposing it cancels pending acknowledgements. Held authorization is released only after the backend observes disconnection to check server-side cancellation accurately.

## Commands and results

| Check | Result |
| --- | --- |
| Client `npm.cmd run type-check -- --incremental false` | Passed on the final source with dev/build generation stopped |
| Server `npm.cmd run type-check` | Passed |
| Client `npm.cmd run lint` | Passed, no warnings or errors |
| Client `npm.cmd run build` | Passed, including Next.js lint/type validation and static generation |
| Server `npm.cmd test` | 385 passed, 0 failed; includes real Socket.IO, authenticated HTTP/token, client compatibility and standalone smoke tests |
| Client focused calling, Voice Rooms, headers/sidebar, API connection and workspace realtime tests | 100 passed across 13 suites, after fixes |
| Broader client `npm.cmd test -- --runInBand --testTimeout=15000` | 793 passed, 4 failed across 74 suites; see unrelated failures below |
| Headless Chrome mini-call preview | Passed at 1280×900 and 390×844, no runtime exceptions; incoming actions, navigation, preserved draft, minimizing/expanding and unavailable-media honesty |
| Headless Chrome camera/layout fixture | Passed: synthetic video frames, fullscreen enter/exit, three-column desktop/one-column mobile grid, camera-off avatar and local capture cleanup |
| `git diff --check` | Passed |

There is no backend lint configuration/script or backend build script in `server/package.json`. The backend executes TypeScript directly in Node; strict TypeScript checking and the production standalone smoke tests cover that execution model. No artificial build/lint configuration was added. The initial parallel checks collided with regenerated `.next`/`.next-dev` type files; the final standalone TypeScript check was rerun sequentially and passed.

Backend client-compatibility tests require running outside this environment's sandbox because tsx reads local process metadata. Those checks used test-only identity services and loopback sockets, not production accounts or an unauthenticated endpoint.

## Feature verification

| Feature | Verified | Remaining live validation |
| --- | --- | --- |
| Direct voice calls | Real frontend signaling adapter ↔ backend; accepted-call token restrictions; two controller/SDK event fixtures join the same scoped media session, publish microphone and render remote audio | Real microphone audio between two authenticated browser sessions |
| Direct video calls | Camera publishing after explicit acceptance, local/remote video rendering, camera-off fallbacks, voice-to-video upgrade without reconnecting | Real camera frames across a deployed LiveKit host |
| Incoming notifications | Correct caller/recipient, real authenticated signaling fan-out, explicit preview notification UI in browser, multi-device endpoint ownership | Delivery between production accounts |
| Accept, decline, cancel, hangup | State-machine guards, roles, idempotency, cross-call and accept/cancel races, missed deadlines, terminal synchronization and server room deletion | Deployment/network interruption scenarios |
| Persistent Voice Rooms | Stable frontend catalog, empty/alone joining, joining/leaving, participant updates and catalog survival independent of occupancy | Actual group authorization and multiple real users in the same room |
| Real multi-user audio/video | Auth/token/room-management boundaries tested over real local HTTP and Socket.IO; media events/tracks tested with fixtures | Media packet transmission, audibility, camera quality and latency remain unverified |
| Microphone and camera controls | Mute/unmute, toggle camera without leaving, permission failures/retry, capture cleanup, expected-peer filtering | Actual device prompts, device removal and platform-specific behavior |
| Mini call window | Nonmodal UI, duration/status/participants, minimize/expand, controls, retained media connection and draft/navigation preservation; responsive browser layout | Physical mobile browser usability during a live call |
| Screen sharing | Same LiveKit participant/connection, screen-video token grant, local/remote rendering without mirroring, Stop Sharing while minimized, cancellation and late grant cleanup | Actual browser display picker, OS screen capture and received screen frames; screen audio is disabled |
| Cleanup and reconnection | Late microphone/camera/screen results, local track stopping and remote detach, media reconnect without duration reset, signaling-loss termination/resynchronization, session/access revocation, late room creation and shutdown | Real network changes, TURN traversal and deployment-specific reconnect/revocation behavior |
| Messaging compatibility | Draft/navigation browser checks; passing composer, attachments, realtime workspace, auth workspace, friends and AI tests in broader run; focused regressions after fixes | Four existing message-menu test failures remain unrelated to calling |

Synthetic camera media and DOM layout fixtures exist only in the isolated browser driver. SDK track doubles exist only in test support. These results do not claim real remote participants, successful production calls, physical-device capture or LiveKit/TURN transmission.

## Unrelated frontend failures

All four failures are in `client/src/components/messenger/__tests__/MessageList.actions.test.tsx`:

- Incoming overflow action count expects only Pin, while the existing renderer also offers Delete for me.
- Popover behavior test looks for a menu item named Delete.
- Reply/editing action test looks for the existing menu's old labels/behavior.
- Disabled conversation controls test looks for a menu item named Delete.

The test and `MessageList.tsx` are unchanged from HEAD and the test directly renders MessageList without importing the calling runtime. These failures were not repaired because changing unrelated message actions/tests is outside this review's scope. The complete frontend suite should therefore not be reported as passing.

## Backend dependencies and deployment limits

- Real `SessionResolver` and `RealtimeAuthorizer` implementations for the existing cookie-session architecture. The standalone host supplies neither and rejects connections with `REALTIME_UNAVAILABLE`.
- The host's authoritative `DirectCallConversationResolver`, validating an actual one-to-one conversation and current relationship/call eligibility.
- Session-bound CSRF verification and same-origin mounting of `/api/calls/token` and `/api/voice/token`. Bind the direct-call handler to the same realtime server handle and its media lifecycle.
- LiveKit URL and server-only API credentials, the public browser URL/readiness settings, and an operational RoomService API. No local LiveKit env files were present in the standard server/client paths checked during this review.
- Real conversation/user APIs to supply authorized outgoing call targets; demo contacts must not be reused for real accounts. Voice Rooms also require the catalog-to-real-group mapping and owner-supplied voice policy.
- Existing owner hooks must propagate logout, expiry, blocking and membership revocation. LiveKit room deletion disconnects present participants; strict replay/rejoin revocation depends on the selected deployment and existing token lifecycle rules, as documented in `direct-call-media.md`.
- Call signaling is bounded in-memory state in one Node process. It is not durable call history or a distributed lock. Shared atomic ownership is required before a multi-worker deployment.

No database schemas or security implementations were modified. No commits or pushes were made.
