# V2.4: authenticated custom voice rooms

Verified 2026-11-24 on `bon-fullstack`, HEAD `58e0da0`. All changes remain unstaged
and uncommitted. Existing V2.1-V2.3 and block/unblock work is preserved.

## Behavior and integration

Signed-in users can create named community rooms in the existing Voice Rooms list.
Names are normalized, trimmed, bounded to 64 UTF-16 characters and reject control
characters. Active normalized names are unique. A session-derived owner can rename
or delete a custom room; other accounts receive 403. The three default rooms retain
their stable IDs/names and cannot be renamed or deleted. Rooms are shared with all
signed-in users; they are not private friend conversations or invitation-only rooms.

The shared Dialog provides Create/Rename/Delete, Cancel, Escape, focus handling,
validation and errors. Concurrent submits are locked. Retried creates retain a
request UUID; DATA returns the original room for an identical owner/request/name
and rejects conflicting reuse. The catalog refresh queues mutations behind an
in-flight poll, preventing a stale read from consuming creation/deletion recovery.
Metadata refreshes every three seconds; a failed read retains the last valid catalog
with an error, rather than inventing empty rooms or occupancy.

The existing `LiveKitConnectionService`, `useLiveRoomMedia`, participant tiles,
audio playback, mute/unmute, device errors, reconnect states and track cleanup are
reused. Participant counts are live in the joined room; other rooms do not claim an
occupancy count. Joining requests a microphone; denied permission leaves a clear
listen-only state with a retry. Switching rooms or leaving cancels owned connections
and stops tracks. Camera controls remain the existing implementation.

## DATA, Database and Security review

- New exact APIs: `GET/POST /api/voice/rooms`, owner-only
  `PATCH/DELETE /api/voice/rooms/:id`. The existing `POST /api/voice/token` handler
  now integrates DATA's community catalog. Direct-call token policy is unchanged.
- DATA derives identity from its verified session, checks current session status,
  verifies session-bound CSRF inside writes, preserves exact Origin/transport
  enforcement and applies read/write budgets. Bodies cannot select an owner or a
  LiveKit room name. Maximum catalog size: 200 active rooms; ten per owner.
- Migration `0013-voice-rooms.sql` adds only `VoiceRooms`, two indexes and two
  protection triggers. The owner FK is ON DELETE RESTRICT. Default rows have no
  account owner. Identity/ownership/defaults and terminal tombstones are protected
  through the supported service writes. No historical migration, message trigger,
  key, ciphertext, account or attachment contract is changed.
- The canonical runner was tested for fresh initialization, upgrade from schema 12,
  preserved original records/ledger, foreign keys, repeat execution and failure
  rollback through the existing isolated suite. Schema 13 is applied in primary
  Docker; all 13 ledger checksums match current files, integrity is `ok`, FK errors
  are zero. Migration 0013 must now be retained unchanged.
- Local LiveKit has `auto_create: false` and a two-participant global default.
  The server explicitly prepares catalog rooms through the existing RoomService
  API with a 32-participant override. Direct calls keep their existing explicit
  two-participant limit; no global LiveKit security setting was relaxed.
- Tokens grant only the authorized catalog room, authenticated participant identity
  and display name, microphone/camera publication and subscription. They do not
  grant administration, arbitrary room creation or data-channel publication.
  Admission TTL is at most 30 seconds and bounded by session expiry. Session and
  catalog access are rechecked before returning the token; server signing secrets
  never enter the browser. SessionApi uses narrowly allowlisted same-origin routes,
  fresh CSRF and account checks before/after each request.
- Delete first retains a durable tombstone and denies new token requests, then
  requests LiveKit room deletion. Clients also leave when a successful catalog
  refresh removes the room. Cleanup failures return 503 and are retried; deletion
  retries are idempotent. A two-second server sweep retries through a 60-second
  admission/cleanup window, and checks retained tombstones again after restart.
  A create that finishes after deletion is cleaned up without returning a token.
- LiveKit JWTs already issued cannot be individually revoked. A cached token has a
  bounded admission window of at most 30 seconds; cleanup reaps deleted rooms
  repeatedly. During a LiveKit outage, immediate disconnection cannot be guaranteed;
  catalog admission remains closed and cleanup retries after recovery.
- Media uses LiveKit transport encryption. **End-to-end media encryption is not
  enabled.** Room names, owners and participant display names are ordinary server
  metadata. The messaging E2EE pipeline is not used for room media. Separate trusted
  deployments should use separate LiveKit credentials/projects.

These new public-room authorization, retention, capacity and admission contracts
require Database/Security team review. A1 remains the separate unresolved High/P1
messaging rollback finding. This feature does not provide security clearance for A1.

## Verification

| Final verification | Result |
| --- | --- |
| Frontend voice/calls, SessionApi/proxy, realtime, Messenger, E2EE, notification and media-forwarding regression | 747 passed, 0 failed; 55 suites |
| DATA full regression, including migrations, groups, messaging and room contracts | 593 passed, 0 failed |
| Backend DATA rooms, authenticated calls, LiveKit tokens and direct-call client/media/signaling | 52 passed, 0 failed |
| Final duplicate-submit/catalog race frontend rerun | 6 passed, 0 failed; subset above |
| Final concurrent-create DATA rerun | 4 passed, 0 failed; subset above |
| Frontend/backend TypeScript | Passed |
| ESLint | Passed, no warnings/errors |
| Isolated production build (`npm.cmd run build:verify`) | Passed |
| Real Docker LiveKit two-account browser acceptance | 26 checks passed, 0 failed |

The browser acceptance used two separate Chromium contexts, disposable DATA/Next
fixtures and the **existing real Docker LiveKit SFU**, with synthetic microphones.
Both accounts published/subscribed and received nonzero remote RTP bytes, decoded
audio samples and energy, with advancing HTML audio playback. Verified: creation,
owner-only rename/delete, CSRF, simultaneous participation, mute/unmute propagation,
rename without media replacement, reload/rejoin and recipient playback, denied
microphone/listen-only recovery, deletion disconnection/track cleanup, denied
post-delete tokens, default Lounge audio and mobile overflow. No browser runtime
exceptions or message attachment transfer requests occurred.

This is actual media transport/playback verification, not a stub SFU or a human
speaker/headphone check. Capacity above two and forced packet-loss/network-flap
reconnection were not load-tested in a browser; existing deterministic reconnect,
permission, duplicate-connect and disposal tests cover the media lifecycle.

Primary Docker browser attempts verified login, default catalog, creation,
ownership and CSRF, then found/fixed the exact-route and explicit-room-creation
integration gaps. Further primary registrations hit the existing 429 limit, which
was preserved. Consequently, **the completed two-account media acceptance used
isolated DATA rather than primary accounts**. The primary services are running the
updated integration and remain healthy. No extra persistent Docker project was
created. A direct-call regression suite passed; direct-call media was not repeated
in this browser scenario.

The final real-SFU evidence is `.cache/voice-rooms-8e68589c/evidence.json`; unit,
integration and build logs use the `.cache/v24-*.log` paths. These local artifacts
and temporary fixture databases are ignored and must not be staged.

## Preservation and daily use

Use the existing Compose project at `http://localhost:3001`:

```powershell
docker compose -p secubuzz- -f compose.yaml -f compose.calls.yaml up -d --build --wait
```

Open Voice Rooms, choose Create room, enter a name and create. Another signed-in
account can select the new room and join. Owner controls appear above the selected
room; rename/delete effects propagate through the catalog refresh. On other
machines use the existing supported LiveKit/network deployment configuration;
the present Compose overlay remains loopback development infrastructure.

A consistent SQLite backup was saved before migration to the ignored
`.cache/v24-docker-before-20261124.sqlite`. Read-only comparison preserved all
26 original accounts/profiles, 42 original messages, 14 attachment rows, 18 device
key rows, six attachment batches and one edit revision, with no missing or changed
original values (excluding ordinary Users.last_seen activity). Concurrent normal
chat activity added a message during validation; it was not removed or reset.

Primary validation left five newly registered synthetic accounts and one test room
from its interrupted attempts. Original accounts/records and all named volumes,
browser keys, the host database, legacy environment and stash `63aba73` were
preserved. The isolated fixtures stop only their owned processes. No prune, reset,
history change, branch switch, staging, commit or push was performed.

There is no destructive down migration. An old image with a strict schema-12
runner cannot simply start against schema 13. Preserve the backup; any rollback
that needs schema 12 must first restore into **new isolated volumes**, validate
there and account for subsequent development writes. Do not overwrite primary.

## Exact V2.4 file inventory

The following source/test/docs/configuration paths were added or changed for V2.4;
previously dirty V2 source files remain byte-identical to the pre-V2.4 snapshot.

```text
DATA/server/database/migrations/0013-voice-rooms.sql
DATA/server/voice/rooms.js
DATA/server/app.js
DATA/tests/voice-rooms.test.js
DATA/tests/attachments-migrations.test.js
DATA/tests/auth-migrations.test.js
DATA/tests/conversations-migrations.test.js
DATA/tests/e2ee-migrations.test.js
DATA/tests/edits-migrations.test.js
DATA/tests/groups-migrations.test.js
DATA/tests/groups-repository.test.js
DATA/tests/messaging-migrations.test.js
DATA/tests/migrations.test.js
DATA/tests/pins-migrations.test.js
DATA/tests/reactions-migrations.test.js
DATA/tests/social-migrations.test.js
DATA/tests/support/groups.js
DATA/docs/migrations.md
DATA/docs/schema.md
client/authProxy.cjs
client/scripts/verify-custom-voice-rooms.cjs
client/src/api/__tests__/sessionApi.test.ts
client/src/auth/__tests__/messagingProxy.test.ts
client/src/auth/httpAuthService.ts
client/src/components/voice/VoiceRoomPanel.tsx
client/src/components/voice/VoiceRoomsSidebar.tsx
client/src/components/voice/VoiceRoomsWorkspace.tsx
client/src/styles/voice-rooms.css
client/src/voice/__tests__/customRooms.test.tsx
client/src/voice/__tests__/roomCatalog.test.tsx
client/src/voice/__tests__/livekitConnection.test.ts
client/src/voice/useRoomCatalog.ts
client/src/voice/livekitConnection.ts
client/src/voice/useLiveKitConnection.ts
client/src/voice/useLiveVoiceRoom.ts
client/src/voice/voiceRooms.ts
compose.calls.yaml
server/src/data/bridge.ts
server/src/data/types.ts
server/src/livekit/config.ts
server/src/livekit/http.ts
server/test/data/voice-rooms.test.ts
server/test/integration/livekit.test.ts
docs/custom-voice-rooms-v2-4.md
```

Existing migration-test ledger expectations and the complete group snapshot oracle
now include schema 13/VoiceRooms; prior assertions are preserved. Generated
`client/tsconfig.tsbuildinfo` was also updated by TypeScript and remains local-only.
