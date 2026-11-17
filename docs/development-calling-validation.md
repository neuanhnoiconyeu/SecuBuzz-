# Development calling validation — 2026-11-16

Historical validation record. See [current push-readiness validation](fullstack-push-readiness.md) for later changes and results; the totals and four message-action failures below describe the original run.

Real voice/video calling is **not yet verified**. No LiveKit URL/API credentials or local development environment files were configured when this validation ran. No media packets were transmitted through a real LiveKit service, and no physical microphone/camera tests or two-browser UI session were run.

The authenticated development backend, actual Next.js proxy, and two independent Socket.IO clients were exercised together. React UI and media lifecycle checks use explicit transport/SDK doubles. These are separate levels of evidence.

## Checks run

| Check | Result |
| --- | --- |
| Server `npm.cmd run type-check` | Passed, including the expanded proxy check |
| Server `npm.cmd test` | 397 passed; no failures |
| Server `npm.cmd run test:dev-calls-proxy` | Passed; real loopback HTTP, Next.js routing, polling upgrade, WebSocket signaling, cookie/CSRF authorization and signed tokens; LiveKit HTTP protocol double only |
| Client `npm.cmd run type-check -- --incremental false` | Passed |
| Client `npm.cmd run lint` | Passed; no warnings/errors |
| Client `npm.cmd test -- --runInBand --testTimeout=20000` | 816 passed, 4 failed; 78 suites passed, 1 failed |
| Client `npm.cmd run build` | Passed, including lint/type validation and production static generation |
| `git diff --check` | Passed |

The backend runs TypeScript directly in Node and has no separate build or lint script. Its strict type check and existing standalone execution tests passed. The client test timeout was increased through the command line only; test configuration and unrelated tests were not changed.

The four frontend failures are all in `client/src/components/messenger/__tests__/MessageList.actions.test.tsx`: incoming-message action count, popover focus/closing, reply/edit actions, and disabled actions. Expectations for `Delete`/message ownership differ from the existing `Delete for me` behavior. Both this test and `MessageList.tsx` match HEAD. They were left untouched. The full frontend suite is therefore **not green**.

Logs: `.cache/dev-calling-validation-server.log`, `.cache/dev-calling-validation-client.log`, and `.cache/dev-calling-validation-build.log`.

## Feature results

| Requested test | Automated result | Still untested |
| --- | --- | --- |
| Two independent development sessions | Passed: separate Alice/Bob cookies, CSRF values and authenticated identities through the actual Next proxy | Separate real browser profiles |
| Outgoing signaling | Passed: authenticated initiate, server-owned caller identity, recipient/conversation checks | Browser-to-browser UI delivery |
| Incoming notification | Passed: actual recipient signaling event; caller name and notification/actions in composed React UI tests | Notification in a second real browser |
| Accept/decline | Passed through the actual backend/proxy; cancel and terminal synchronization also passed | Real browser interactions |
| LiveKit establishment | Passed: scoped token signing for both accepted endpoints, matching private room, different participant identities, SDK RoomService HTTP calls against a local protocol double | Actual SDK/WebRTC connection to LiveKit, ICE/TURN traversal |
| Microphone transmission | Passed with SDK doubles: microphone publication, mute/unmute, remote audio attach/playback handling | Physical capture, transmitted RTP, received sound in either direction |
| Video transmission | Passed with SDK doubles: camera publication, local/remote video elements, toggle/permission failures | Captured/received real frames in either direction |
| Hangup/cleanup | Passed: both signaling endpoints end, room deletion API called, logout revokes sessions; track stop/detach and late permission cleanup checked with doubles | Physical capture indicators and actual LiveKit participant/room removal |
| Mini call window | Passed in composed React tests: minimize/expand, controls, duration, same media service, editable draft | Real-browser responsiveness and audio continuity |
| Errors/reconnection | Passed: CSRF/access rejection, service-down response, signaling disconnect/end/reconnect/sync; media reconnect/duration tested with SDK events | Real media/network recovery, browser-specific device errors |

The expanded proxy check adds incoming-event assertions, decline/cancel delivery, tokens for both endpoints, and reconnect/resynchronization after an accepted call is interrupted. It does not connect a browser LiveKit client. An accepted server call or a successful RoomService probe is insufficient to mark a media test passed.

No runtime application, Database or Security implementation was changed during validation. Only the proxy check and this report were extended. No commits or pushes were made.

## Exact manual setup

Use two independent browser profiles on this computer. The harness binds to `127.0.0.1` and intentionally cannot serve a second physical device. Do not expose or relax it for this test. Two ordinary tabs in the same profile share cookies and cannot represent Alice and Bob.

Prerequisites: Node 22.18+, installed `client`/`server` dependencies, a reachable real LiveKit service, working microphone/camera, and headphones to prevent feedback. For simultaneous video, the OS/camera must permit capture from both browser profiles; use distinct cameras if necessary.

1. In terminal A:

   ```powershell
   Set-Location D:\Project\SecuBuzz-\server
   if (!(Test-Path dev\calling\.env)) { Copy-Item dev\calling\.env.example dev\calling\.env }
   ```

   Edit `server/dev/calling/.env` locally:

   ```dotenv
   NODE_ENV=development
   SECUBUZZ_DEV_CALLS_ENABLED=true
   DEV_CALLS_PORT=5101
   DEV_CALLS_APP_ORIGIN=http://localhost:3000
   DEV_CALLS_ALICE_PASSWORD=<distinct private password, at least 12 characters>
   DEV_CALLS_BOB_PASSWORD=<different private password, at least 12 characters>
   LIVEKIT_ENABLED=true
   LIVEKIT_URL=wss://<actual-livekit-host>
   LIVEKIT_API_KEY=<server-only key>
   LIVEKIT_API_SECRET=<server-only secret, at least 32 printable characters>
   ```

   A self-hosted local service may use `ws://127.0.0.1:7880` if already configured and running. The harness does not launch LiveKit. Start the backend with `npm.cmd run dev:calls`.

2. In terminal B:

   ```powershell
   Set-Location D:\Project\SecuBuzz-\client
   if (!(Test-Path .env.development.local)) { Copy-Item dev\.env.calling.example .env.development.local }
   ```

   Check these values in `client/.env.development.local`:

   ```dotenv
   SECUBUZZ_DEV_CALLS_PROXY=true
   DEV_CALLS_BACKEND_URL=http://127.0.0.1:5101
   NEXT_PUBLIC_DEV_CALLS_ENABLED=true
   NEXT_PUBLIC_AUTH_MODE=api
   NEXT_PUBLIC_AUTH_API_READY=true
   NEXT_PUBLIC_REALTIME_CONTRACT_READY=true
   NEXT_PUBLIC_REALTIME_URL=http://localhost:3000
   NEXT_PUBLIC_REALTIME_PATH=/socket.io
   NEXT_PUBLIC_LIVEKIT_ENABLED=true
   NEXT_PUBLIC_LIVEKIT_URL=wss://<same-actual-livekit-host>
   ```

   Keep keys/secrets exclusively in the server file. Start `npm.cmd run dev -- --hostname 127.0.0.1 --port 3000`. If port 3000 is occupied, choose another explicit port and update both configured frontend origins. Restart servers after editing environment files. Existing process environment values override env files.

3. Create two separate Chrome profiles, A and B. Open `chrome://webrtc-internals` in each profile before making a call, then open `http://localhost:3000/login` in each. Sign in as `alice` in A and `bob` in B using the configured passwords. Confirm different signed-in names and the opposite user as call target. Require `LiveKit API: available` and `Signaling: Ready` in both. Neither readiness label proves a media connection.

## Manual test sequence and pass criteria

Record each result as passed, failed, or not run; include browser versions, time, visible error, and sanitized RTP observations. Do not copy cookies or token responses into the record.

1. **Outgoing/incoming and decline.** In A click **Voice call Bob (calling development)**. Require Ringing in A and an incoming notification naming Alice in B. Before acceptance, require no call duration and no call microphone/camera capture. In B click **Decline**. Require Declined on both sides, no media, and no Connected label. Close both finished panels.

2. **Cancel.** Call again from A and click **Hang up call** before B accepts. Require the incoming notification to disappear in B and the call to end on both sides. Close the panels.

3. **Real voice connection.** Call from A; accept in B. Allow microphone permission in both profiles. Require Connecting first and Connected with duration only after both participants reach the actual media room. If it remains Connecting or ends with an error, record failure, even if `/api/calls/token` returned 200. If audio playback is blocked, click **Enable call sound** in the call panel.

4. **Audio in both directions.** Keep B's call microphone muted, leave A unmuted, and speak a distinctive phrase into A's selected microphone. Verify the phrase is audible through B's remote playback. Reverse the mute states and repeat B → A. Verify muting prevents the other side hearing newly spoken phrases, then unmute and verify recovery. In each profile's `webrtc-internals`, confirm the appropriate audio `outbound-rtp` sent-byte/packet counters and the other profile's audio `inbound-rtp` received counters increase. If supported, compare received `totalAudioEnergy` while speaking. Counters alone do not establish audibility. A single shared physical microphone/speaker needs careful one-direction-at-a-time testing and headphones.

5. **Real video in both directions.** During that voice call, turn A's camera on. Require a local preview in A and changing remote frames named Alice in B. Turn B's camera on and verify the reverse. Move/wave separately to distinguish received video from a local preview. For each direction, confirm remote video `framesDecoded` and received-byte counters increase in `webrtc-internals`. Toggle each camera off/on; require the remote avatar/video to update, voice to continue, and the call duration not to restart. If a shared camera is exclusive, test each direction in turn with the other camera off, and mark simultaneous two-camera capture untested. Hang up, close panels, then also start a fresh **Video call** and accept to test initial camera publication.

6. **Mini panel.** During an established call, click **Minimize call**. Verify audio continues, duration advances, participants remain accurate, and microphone/camera/hangup controls work. Click **Expand call** and verify video returns without another invitation or a new LiveKit room. Resize to a mobile-sized viewport and check that controls remain reachable. The development API fixture has no real messaging/conversation API; it cannot verify sending real messages during calls. Existing messaging/draft compatibility is covered by automated workspace tests, with the four unrelated message-menu failures noted above.

7. **Hangup/cleanup.** Hang up from A, then repeat a new call and hang up from B. Require both panels to end, duration to stop, audio to stop, local call capture indicators to clear, and media elements to detach. In the LiveKit service console, confirm both participants leave and the private call room is deleted. Browser microphone/camera indicators may remain if another unrelated tab/app is capturing. Close panels and verify a fresh call succeeds; stale controls/events must not reopen the old call.

8. **Permission failures.** Before another call, set microphone permission to Block for the site in one profile. Accept a voice call and require a visible microphone error and no local microphone publication; listening may continue. Allow permission again and retry the microphone control. Repeat with camera blocked during a voice call; require a visible camera error while voice continues, then allow and retry without leaving the call. Do not count a Connected label as proof that the denied device transmitted.

9. **LiveKit unavailable.** With no active call, stop a self-hosted LiveKit service (or temporarily use an unreachable LiveKit URL in both environment files and restart both app servers). After the five-second probe cache expires, click **Retry service check**. Require unavailable/unconfigured and disabled outgoing buttons. Restore correct settings/service and retry. To test failure after a successful readiness probe, interrupt LiveKit after placing/accepting a call; require an error/end and capture cleanup, never a fabricated Connected state.

10. **Media-only reconnection.** With frontend/backend on localhost and LiveKit on a remote host, start a connected call, then interrupt this computer's external network while keeping local processes running. Wait for Reconnecting and restore the network promptly, before the call's 25-second waiting deadline. Require recovery to Connected, the original duration, working audio/video again, and no duplicate concurrent room participants. If the call ends instead, record that outcome; do not claim recovery passed. If LiveKit itself is local, this network toggle does not exercise its transport, so mark this test not run unless a controlled media-only interruption is available.

11. **Signaling/session loss.** During a fresh connected call, close A's call tab. Require B to end and stop capture. Reopen A in the same profile and verify the session restores and no stale call resumes; place a new call. Separately, stop the backend with Ctrl+C and require both calls to stop. Restarting the in-memory backend clears sessions, so sign in again in both profiles. Signaling loss deliberately ends media; automatic resumption of that ended call is not expected. The automated proxy check independently verifies disconnect/reconnect with the original still-live session and terminal-state resynchronization.

Only mark real calling verified after the actual connection, bidirectional audio, bidirectional changing video, and cleanup checks above pass. Token issuance, UI tests, service readiness, or simulated SDK events cannot substitute for those results.
