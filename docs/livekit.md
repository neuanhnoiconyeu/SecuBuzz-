# LiveKit infrastructure

The browser SDK (`livekit-client`) and Node SDK (`livekit-server-sdk`) are installed. Real accounts can open the LiveKit-backed Voice Rooms UI from their signed-in account screen. Demo accounts retain the explicitly local preview. The standalone server exposes `POST /api/voice/token`, but returns `503 livekit_unavailable` until real authentication, authorization, CSRF and voice-policy adapters are injected. Environment flags and LiveKit credentials cannot bypass that requirement.

## Configuration

Use `server/.env` for server settings; it is gitignored. Never put LiveKit signing credentials in client env files, `NEXT_PUBLIC_*` variables, logs or source code.

```dotenv
LIVEKIT_ENABLED=false
LIVEKIT_URL=wss://your-livekit-host
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_ROOM_CONVERSATIONS={}
```

`LIVEKIT_ROOM_CONVERSATIONS` maps stable frontend catalog IDs to actual group conversation IDs, for example `{"lounge":"<real-group-conversation-id>"}`. It is server-owned configuration, independent of room occupancy. Empty/invalid mappings, missing credentials, or invalid URLs leave configuration unavailable. Use a signing secret of at least 32 characters. `ws://` is accepted only for loopback outside production; production requires `wss://`.

Browser settings in `client/.env.local` contain only public configuration:

```dotenv
NEXT_PUBLIC_LIVEKIT_ENABLED=false
NEXT_PUBLIC_LIVEKIT_URL=wss://your-livekit-host
```

Both URLs must match. Next.js public environment variables are embedded at build time. These flags are readiness switches, not authorization. Keep them false in this checkout.

## API integration

The mountable handler is exported as `secubuzz-realtime-server/livekit`. Supply the same `SessionResolver` and `RealtimeAuthorizer` as Socket.IO. The callbacks below must come from the application's owning services; no production implementations exist in this checkout.

```ts
import { createLiveKitHttpHandler, loadLiveKitConfig } from 'secubuzz-realtime-server/livekit';

const voice = createLiveKitHttpHandler({
  config: loadLiveKitConfig(process.env),
  allowedOrigins, // same exact browser origins used by realtime
  sessionCookieName, // same HttpOnly session cookie as auth/realtime
  sessionResolver,
  authorizer,
  verifyCsrf, // (request, actor) => verify this session's X-CSRF-Token
  authorizeRoom, // (actor, room) => enforce voice-specific group and block policy
});
```

Mount before a JSON body parser, and route `/api/voice/token` and `/api/calls/token` to this handler on the app's origin. It returns `false` for unrelated paths. `server/src/main.ts` mounts it before its fallback and intentionally supplies no production adapters. Attachments belong to the separate DB6 host (`server/api-main.cjs`), whose filename transport wrapper delegates to the existing Database API. The owning authenticated API host must compose LiveKit with real session/CSRF/policy adapters; DB6 does not automatically enable media tokens. No database/schema changes are needed.

The endpoint:

- Accepts only `POST` JSON `{ "roomId": "lounge" }`, bounded to 1 KiB.
- Requires an exact allowed Origin, valid non-demo cookie session, session-bound CSRF token, membership in the mapped conversation, and an affirmative `authorizeRoom` decision. That callback must check group eligibility and the existing block policy; conversation membership alone does not establish media permissions.
- Rechecks the session before signing. Adapter failures/timeouts and missing adapters fail closed.
- Derives the participant identity from authenticated user/session IDs and derives the media room from the configured conversation. Caller-supplied identities, room names and extra payload fields are rejected.
- Returns `{ roomId, roomName, participantIdentity, serverUrl, token, expiresAt }` with `private, no-store`. Tokens allow joining only that room, camera/microphone publication and subscription; no administrative, room-listing, recording or data-publishing grants are issued.
- Limits token lifetime to five minutes or the remaining session lifetime, whichever is shorter. Errors are fixed codes; raw adapter/SDK messages and credentials are not logged or returned. A bounded process-wide token bucket supplements the host API's request limits.

Authentication failures return 401, denied room/origin/CSRF access 403, invalid payload 400/413/415, unsupported methods 405, throttling 429, and unavailable configuration/adapters 503.

## Frontend service

`createSessionLiveKitConnection(user, authMode, onAuthenticationRequired)` uses the existing `AuthUser`, API auth mode and `meta[name="secubuzz-csrf-token"]` bootstrap. It rejects demo users, unconfigured URLs and disabled flags before fetching or loading the SDK.

`useLiveKitConnection()` consumes `useAuth()` and owns/disposes a service for each `sessionVersion`. It revalidates auth after a token endpoint 401. Nothing connects on mount. `VoiceRoomsWorkspace` reuses the existing sidebar/panel and `useLiveVoiceRoom()` calls `service.connect(roomId)` or `service.disconnect()` from user actions. SDK connection/reconnection/disconnection events drive the UI. SDK completion, cancellation, room changes, logout, session replacement and late async results are guarded by session generations.

Joining connects directly, including when no other participant is present; there is no ringing, host approval, or occupancy prerequisite. After connection, the UI requests microphone access through `localParticipant.setMicrophoneEnabled(true)` and publishes the microphone. Denied permission leaves the user joined and able to listen, with an error and an Unmute retry. Camera starts off. Mute/unmute and camera controls use SDK publication methods; `stopMicTrackOnMute` releases microphone capture while muted.

The participant list, publication state and speaking rings come from SDK participants, track events and active-speaker events. Stale speaking indicators clear on reconnect and departure. Remote tracks attach to workspace-owned audio elements so audio continues while browsing another room. Browser autoplay restrictions expose an **Enable sound** button, which invokes `room.startAudio()` from a user gesture. Leaving, closing the workspace, logout, session replacement and terminal disconnect detach audio/video, stop local tracks, remove listeners and disconnect; late microphone/camera grants cannot reopen a departed session.

The configured catalog is independent of SDK media sessions. Every room stays listed after all users leave and can be recreated on the next authorized join. Only the joined room has a live participant count. Unjoined-room counts are shown as unknown because no authorized global occupancy API exists.

Camera toggles use the same local participant and connection as voice. `VoiceParticipantTile` renders each participant's camera through `VoiceVideo`, with avatars for disabled cameras and loading/error fallbacks while frames are unavailable. SDK participant and publication events update the responsive grid. Video elements stay muted; remote audio continues through the single workspace-owned audio renderer. Camera permission/device failures offer a retry without disconnecting voice.

Each active video has a fullscreen control, using container fullscreen where available and native video fullscreen on supported iOS browsers. Escape, camera-off, participant departure and unmount release fullscreen without reconnecting or republishing media. Browsers without fullscreen support show a disabled control. Video rendering detaches tracks without stopping remote media; capture and connection cleanup remain owned by the existing room controller.

Token fetches use same-origin cookies, CSRF headers, no cache and no redirects. Connection details are checked against the requested catalog ID and configured media URL. Tokens remain in memory and are never placed in persistent browser storage; the SDK may retain or refresh them for reconnection. The service lazy-loads the browser SDK after the authenticated token request succeeds.

## Blocker and remaining integration

`SessionResolver`, `RealtimeAuthorizer`, session-bound CSRF verification and voice room policy implementations are not supplied by the production host. Both LiveKit flags therefore remain false. The real-account room view is wired to LiveKit but displays unavailable configuration/auth state until those dependencies are provided. No demo-token endpoint, authentication fallback, or fabricated remote participants are provided. Voice can use its separate authenticated workspace without requiring a database-backed chat UI or changing message encryption.

Before enabling a real workspace, the owning services must also propagate logout, expiry, blocks and membership revocation to LiveKit participant removal/permissions. Socket.IO disconnects alone do not disconnect media. Short token lifetimes do not end established calls; self-hosted LiveKit removal also does not immediately invalidate an already-issued token. Account for the selected deployment's revocation behavior, route the token API on the same origin, and verify the selected media host against the existing CSP and network/TURN setup.

## Two-user verification after integration

1. Sign in to two separate browser sessions using real API accounts with access to the same configured group. Open Voice Rooms.
2. Join an empty room in the first browser. It should connect immediately and show only that user, waiting alone. Allow microphone access, or deny it to verify listening while muted.
3. Join the same room in the second browser. Both rosters/counts should update, and speaking should produce received audio and the corresponding speaking indicator. Use Enable sound if the browser blocks playback.
4. Exercise mute/unmute and a network disconnect/reconnect; muted audio must not transmit, and stale speaking state must clear during reconnection.
5. Enable both cameras and confirm local mirrored video, remote video and changing grid layouts on desktop/mobile. Toggle a camera off, deny camera permission and retry; avatars/errors should update while voice continues. Enter/exit fullscreen, then turn the fullscreen camera off or have its participant leave.
6. Leave in both browsers, rejoin the still-listed room, and test logout/closing the workspace. Local capture, remote playback and SDK listeners must end after leaving. This live-network check requires the missing auth/media configuration; SDK event/track fixtures cover the frontend lifecycle independently.

References: [LiveKit browser SDK](https://docs.livekit.io/reference/client-sdk-js/), [server SDK](https://docs.livekit.io/reference/server-sdk-js/), [token grants and lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/).
