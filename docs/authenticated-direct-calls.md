# Authenticated direct calls — Phase 10 integration

Status: integration implemented; **media acceptance is blocked**. No LiveKit server URL, API key/secret, or local LiveKit server was available in this checkout. Real-account `directCalls` remains `false`. Signaling/JWT tests and mocked SDK tests do not establish successful microphone/camera delivery. Calls are not advertised as end-to-end encrypted.

## Integrated path

- `RealMessengerWorkspace` mounts one `DirectCallsRuntime` using `SecureRealtimeWorkspace.transport`. `AuthenticatedSocketIoClient.calls` shares the existing authenticated V2 messaging socket; it creates no second connection or demo transport. The runtime survives conversation/navigation changes and disposes with the account workspace. Voice Rooms retains its existing separate status connection without mounting a second direct-call runtime. Only the conversation content hides during room navigation, so the workspace call layer can remain visible. A disabled capability prevents incoming subscriptions, call synchronization, initiation, token requests and media capture.
- `SecureConversationPanel` supplies the selected conversation and authoritative peer to the shared header controls. `DirectCallActions`, `useLiveDirectCalls`, incoming notifications, the floating call panel and existing LiveKit media controller are reused. The backend remains authoritative even if clients forge these targets.
- The combined DATA/realtime host supplies the existing call broker with a read-only resolver over DATA's current conversation service. Only an eligible direct conversation with exactly two distinct participants, containing the session actor and matching the recipient, is accepted. Friendship/block/session policies remain DATA's existing decisions. Client caller IDs, names, timestamps and selected room names are rejected by existing signaling validation.
- Without LiveKit configuration the combined host leaves signaling unavailable. When configured it installs the existing LiveKit room lifecycle: private room, two participants maximum, bounded empty/departure timeouts, guarded creation and teardown. Invitation state is in memory, not stored as a message or database call log. Restart/disconnect ends calls; there is no promise of resuming an established media call after logout or restart.
- `POST /api/calls/token` is routed through Next's same-origin DATA proxy, then DATA's Origin/transport, authenticated-session and CSRF middleware before the existing bounded LiveKit HTTP handler. The handler independently verifies the same actor/session CSRF proof, current membership, accepted call, session/socket ownership and current media grant, and rechecks the session before signing. It accepts only `{callId, connectionId}`.
- The real runtime requests tokens through its account-scoped `SessionApi`, using fresh DATA CSRF and identity checks. Legacy development calling and Discord-style Voice Rooms retain their existing paths; their development harness auth is not used for real accounts.
- Tokens are room-scoped, participant identities are server derived, and validity is at most 30 seconds or remaining session lifetime. Existing publish permissions include microphone, camera and screen share, with no room administration, listing or data publication. Secrets remain in server-only config; connection tokens remain in memory. Media credentials are not sent in Socket.IO call snapshots.
- Logout, access revocation, owner disconnect, end/cancel/reject and deadlines feed the existing authoritative broker and media cleanup. The existing SDK handles microphone/camera capture, permission errors, mute/camera toggles, track cleanup, participant validation and playback unlock. Those controls have automated mocked coverage; real transport remains unverified.

## Database and Security team review

No Phase 10 database migration, schema, repository, trigger, encrypted envelope, message-key protocol, Edit Message or attachment change. Migrations 0008, 0009 and 0010 are unchanged by this phase. Existing local database files were not intentionally modified.

Security-sensitive integration changes: DATA's authenticated token-handler composition hook in `DATA/server/app.js`; DATA call-membership resolver and bridge; the LiveKit handler's trusted-host transport callback (uses the same exact trusted-proxy/loopback/TLS policy as DATA); and the frontend SessionApi/proxy allowlist for the exact token POST. These reuse existing Security services rather than adding an identity verifier or an unauthenticated DB6 endpoint.

There is **no true end-to-end media encryption implementation** here. HTTPS/WSS and WebRTC transport encryption protect network links to the LiveKit SFU. The SFU remains in the media trust boundary. Message E2EE is independent and unchanged. Media teardown and short-lived tokens do not instantly revoke an already-issued LiveKit JWT: self-hosted deployments may permit rejoin within its remaining lifetime. Review deployment-specific revocation, room creation policy and token refresh behavior before enabling calls. Multi-process signaling coordination is outside this single-process broker's contract.

## Configuration and acceptance still required

Reuse the existing ignored environment configuration; do not add secrets to source or public env. The combined host reads process environment (DATA loads its `.env`). Supply server-only `LIVEKIT_ENABLED=true`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` (existing validation requires at least 32 printable secret characters). A `server/.env` must be explicitly loaded into the combined host if used; `npm run start:data` does not implicitly load that file. Direct calls do not need `LIVEKIT_ROOM_CONVERSATIONS`; that separate mapping belongs to Voice Rooms.

The client needs `NEXT_PUBLIC_LIVEKIT_ENABLED=true` and matching `NEXT_PUBLIC_LIVEKIT_URL`; rebuild/restart Next after changing public config. Production requires HTTPS and WSS, trusted proxy configuration matching DATA, and reachable LiveKit signaling/ICE/TURN ports. No environment files were changed during this phase. Public flags cannot override the capability gate or backend authorization.

Before changing `REAL_ACCOUNT_MESSAGING_CAPABILITIES.directCalls` to `true`, validate in an isolated deployment/checkout with two real accounts and separate browser contexts:

1. Use the combined DATA/realtime host, same-origin Next proxy and a working LiveKit deployment. Confirm fresh cookie/CSRF authentication and eligible direct membership.
2. Exercise voice and video outgoing/incoming, accept/reject/cancel/end, busy/offline/deadline errors and duplicates.
3. Confirm microphone audio and camera video at the recipient in both directions. Inspect receiving WebRTC inbound RTP bytes/frames and actual audio/video playback, not just accepted signaling, a connected SDK or local preview.
4. Verify mute/unmute, camera toggles, permission denial/device absence, transport failure, playback unlock, disconnect/reconnect, logout and block revocation. Confirm stopped capture tracks, released media elements and deleted rooms on termination.
5. Recheck existing Demo calls, Voice Rooms and encrypted messaging. Keep calls gated if these checks fail.

## Verification

`server/test/data/calls.test.ts` uses two real DATA accounts, isolated SQLite, genuine sessions/CSRF and Socket.IO. It covers voice/video invitation states, duplicate/busy handling, membership/recipient forgery, owner-bound token grants, signed JWT scope/expiry, unauthorized/CSRF failures, offline/deadlines, logout/block revocation, reconnect and the actual frontend socket/SessionApi adapter. Its injected media lifecycle is a test stub, not a LiveKit server.

Existing call/LiveKit suites cover UI transitions, mocked SDK media controls, capture errors, stale operations and cleanup. New focused frontend tests cover socket reuse/event validation/generation cancellation, account isolation and token routing, scoped media service cleanup and the disabled workspace gate. `verify-client-realtime.cjs --calls-unavailable-only` uses isolated Chrome contexts and actual Next/DATA services to verify the unavailable-call gate, authentication/CSRF, zero capture, encrypted messages, Unicode picker, reload/reconnect and mobile layout. It explicitly reports `mediaVerified: false`.

Final validation on this checkout:

| Check | Result |
| --- | --- |
| Full frontend Jest | 1,341 passed, 126 suites |
| Full backend Node suite | 573 passed |
| Full DATA Node suite | 324 passed |
| Client and server TypeScript | Passed |
| Frontend lint; DATA app syntax; diff whitespace | Passed |
| Chrome calling-unavailable/room-navigation regression | 37 checks passed |
| Chrome two-account encrypted voice-message regression | 49 checks passed |
| Chrome two-account encrypted file regression | 47 checks passed |
| Actual live-call microphone/camera delivery | **Not verified — LiveKit unavailable** |

The first frontend run under simultaneous browser/backend load timed out in five existing UI tests. Those suites passed independently and the entire suite passed on a quiet rerun; no unrelated feature changes or timeout overrides were made. Browser checks used temporary accounts/databases and separate contexts, not existing development accounts. Encrypted voice-message playback is a file/recording regression result, not evidence of live-call media transport. No build or manual hardware-media acceptance is claimed.

## Phase 10B infrastructure recheck — 2026-11-22

**Real LiveKit server used: no. Audio/video delivery: not verified. Keep authenticated call controls disabled.** No application code, capability flag, environment setting, database contract or existing calling implementation was changed during this recheck.

The current process and Windows User/Machine environment have none of the required LiveKit variables. `DATA/.env` exists but contains no LiveKit configuration. `server/.env`, `server/dev/calling/.env`, `client/.env.local` and `client/dev/.env.calling` are absent. Runtime configuration reports `directCallsReady: false`, no configured URL and status `disabled`. Neither Docker nor a LiveKit server executable was found on PATH or the checked conventional installation paths; WSL reports that it is not installed. TCP connection attempts to local ports 7880 and 7881 returned `ECONNREFUSED`. These local checks do not prove anything about an unspecified remote deployment: no remote LiveKit URL was available to probe.

Missing inputs are:

- A real LiveKit deployment reachable by both browser sessions, including usable signaling and WebRTC ICE/TURN connectivity.
- Server-only `LIVEKIT_ENABLED=true`, `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`, supplied through the existing configuration loading path. Do not copy API credentials into public variables, source code or this document.
- Client `NEXT_PUBLIC_LIVEKIT_ENABLED=true` and a matching `NEXT_PUBLIC_LIVEKIT_URL`, followed by a Next rebuild/restart. Public flags alone do not override the capability gate. Leave the gate disabled until the real media acceptance checks above succeed.

No credentials were created or guessed, no server was installed, and no mock/stub was substituted for real media acceptance. Existing authenticated signaling/token regression tests still use their explicitly identified synthetic test configuration and stubbed media lifecycle. They verify DATA authorization, CSRF, state transitions, owner-bound tokens, bounded JWT expiry, reconnect and cleanup contracts; they are not real LiveKit transmission or expired-token rejection tests against an SFU.

The existing live-call path uses the LiveKit SDK `Room` and microphone/camera publication in `useLiveRoomMedia`; it does not invoke the encrypted message-attachment upload path. This is a code-inspection finding. Publication/subscription on a real SFU, incoming RTP bytes, decoded remote video frames, audible playback, real mute/camera behavior, permission-denial recovery, connection recovery, SFU token-expiration enforcement and media cleanup remain unverified. Synthetic tracks are acceptable for a later test, but must traverse a real LiveKit server. There is still no media E2EE implementation or claim.

Phase 10B adds no Database or Security implementation changes. The Phase 10 integration points and deployment-specific JWT revocation/room policy noted above remain the Security review requirements before enablement.

Fresh Phase 10B validation (distinct from the earlier full Phase 10 run):

| Check | Result |
| --- | --- |
| Relevant frontend call/media/session/workspace suites | 165 passed, 15 suites |
| Authenticated DATA calling, direct-call broker and LiveKit token suites | 38 passed |
| Full DATA regression suite | 324 passed |
| Client/server TypeScript, frontend lint and DATA app syntax | Passed |
| Chrome with isolated real DATA sessions: unavailable calls, CSRF, no capture, messaging and Voice Rooms navigation | 37 checks passed |
| Real SFU audio publication/subscription/RTP reception | Blocked; not tested |
| Real SFU video-frame reception | Blocked; not tested |

The browser evidence is `client/tmp/client-realtime-58be2372/artifacts/browser-evidence.json` (ignored local artifact): `mediaVerified: false`, zero runtime errors and zero monitored message-plaintext leaks. Fresh test logs are `.cache/phase10b-client.log`, `.cache/phase10b-server.log` and `.cache/phase10b-data.log`. No new full frontend/backend run or production build is claimed for this documentation-only recheck. Branch remains `bon-fullstack`; nothing was staged, committed or pushed.
