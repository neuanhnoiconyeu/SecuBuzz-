# Direct-call signaling

Accepted-call media, screen sharing and floating UI integration are documented in [direct-call-media.md](direct-call-media.md). Signaling remains independent of media readiness.

`server/src/calls/` runs on the existing authenticated Socket.IO namespace. It reuses cookie-session identity, current conversation grants, two-way block checks, the optional event security policy, existing rate/pending-ack limits, and lifecycle/revocation hooks. Caller identity and display name always come from `connection.actor`. Call IDs, timestamps, deadlines and revisions are server-owned. Client-supplied caller fields, names, timestamps and media payloads are rejected.

Signaling is independent of LiveKit. `accepted` means the recipient accepted the invitation; it does **not** mean media is connected. This module creates no LiveKit room, token, stream, or connected-duration timestamp. Media ownership must react to terminal signaling events and perform its own cleanup.

## Integration blocker

The standalone host still supplies no production `SessionResolver` or `RealtimeAuthorizer`, so it rejects connections with `REALTIME_UNAVAILABLE`. The existing authorizer lists membership IDs but cannot identify an actual one-to-one conversation or its intended peer. A production `DirectCallConversationResolver` is also missing. Call signaling remains disabled without it, even on an otherwise authenticated realtime server. There are no demo identity fallbacks or environment switches that bypass these requirements.

Supply the host's real read-only conversation service when mounting the realtime server:

```ts
import { attachRealtimeServer } from 'secubuzz-realtime-server';
import type { DirectCallConversationResolver } from 'secubuzz-realtime-server/calls';

// Implemented by the owning service, not by a browser or an in-memory production fixture.
declare const conversationResolver: DirectCallConversationResolver;

const realtime = attachRealtimeServer(httpServer, {
  allowedOrigins, sessionCookieName, sessionResolver, authorizer,
  directCalls: { conversationResolver },
});
```

`resolveDirectConversation(actor, conversationId)` must return `null` unless the authenticated actor is eligible to call under the application's relationship policy. Otherwise return `{ conversationId, type: 'direct', participants: [{ userId, displayName }, { userId, displayName }] }` from authoritative records. Exactly two distinct, non-demo users must match the authenticated actor and requested recipient. Group membership and presence visibility do not authorize direct calls. The server also refreshes both connected users' existing membership/block grants before signaling and rechecks them after asynchronous decisions. Throws, deadlines, malformed results, stale grants, and missing adapters fail closed.

The real frontend now uses this protocol through the existing socket and the accepted-call media integration described in [direct-call-media.md](direct-call-media.md). Demo accounts continue to use explicit previews. `/api/voice/token` remains restricted to the configured voice-room catalog; `/api/calls/token` independently authorizes accepted direct calls.

## Wire contract

Import `CALL_CLIENT_EVENTS`, `CALL_SERVER_EVENTS` and the payload/ack types from `secubuzz-realtime-server/calls`. Call events use the existing socket, Origin checks and cookie session. Every request requires a Socket.IO acknowledgement callback and exactly one body.

| Client event | Body | Permission / transition |
| --- | --- | --- |
| `call:initiate` | `{ requestId, conversationId, recipientId, kind: 'voice' \| 'video' }` | Authenticated caller → ringing; recipient must currently have an eligible connected device |
| `call:accept` | `{ callId }` | Recipient only; ringing → accepted |
| `call:decline` | `{ callId }` | Recipient only; ringing → declined |
| `call:cancel` | `{ callId }` | Caller only; ringing → cancelled |
| `call:end` | `{ callId }` | Either participant; accepted → ended |
| `call:sync` | `{}` | Own currently authorized calls, active first and then recent terminal records, up to 20 |

Mutations return `{ status: 'ok', call: CallSnapshot }`; sync returns `{ status: 'ok', calls: CallSnapshot[] }`. Errors use `{ status: 'error', code }`, with existing validation/rate/policy/unavailable codes and call-specific `call_not_found`, `call_not_allowed`, `call_busy`, `invalid_call_state`, and `recipient_unavailable`. An unknown call and a nonparticipant request both return `call_not_found`.

`call:state` delivers the same authoritative snapshot to all currently eligible devices of both participants, never to the conversation room or unrelated users. Snapshots include `callId`, `conversationId`, `caller` and `recipient` (`userId`, `displayName`), `kind`, `status`, `revision`, `createdAt`, `updatedAt`, `ringExpiresAt`, nullable `acceptedAt`/`endedAt`, and a nullable fixed `reason`. There are no cookie/session IDs or media credentials in the payload.

When grants or blocks revoke an existing call, `call:cleared` delivers only `{ callId, revision, status: 'ended', reason: 'access_revoked' }` to its participants' live connections. Clear the known call without rendering new peer metadata. Subsequent sync filters records through current grants and blocks.

Subscribe before initiating and perform `call:sync` after every reconnect. Apply snapshots/clears by `(callId, revision)`; acknowledgements and broadcast delivery can interleave. Ignore older/equal revisions and never infer acceptance or connection from a timer. Map signaling acceptance to the UI's connecting state; only the media service can confirm connected and start call duration.

## State ownership and limits

- One active ringing/accepted call per user across all devices. Crossed and overlapping invitations are checked atomically after authorization; one wins and the other receives `call_busy`.
- Retry initiation with the same `requestId` for the same authenticated user and parameters to receive the same call, including a retained terminal outcome. Changed parameters return `idempotency_conflict`. Duplicate accept/decline/cancel/end actions are idempotent once their matching state has been reached. Incompatible actions and attempts to revive a terminal call fail.
- Ringing expires after 30 seconds as `missed` / `unanswered`. Accepting cancels that deadline. Accepted signaling sessions have a four-hour safety limit, then end with `duration_limit`; this does not represent or measure a media connection.
- Losing one device preserves a call while another eligible device of that user remains. Losing the last device cancels caller ringing, marks recipient ringing missed, or ends an accepted call. Reconnect authenticates normally and can retrieve retained terminal state. Session expiry/revocation uses the existing disconnect hooks.
- Access refresh/revocation clears active calls when conversation access or blocking changes. The owning services must continue to invoke the existing access/revocation hooks when their policies change. This module does not implement those services or alter their rules.
- Terminal state and request idempotency are retained for five minutes. After expiry, a reused request ID is a new initiation. No durable missed-call history is claimed. At most 10,000 total active/retained records are held; full capacity rejects new calls without silently evicting idempotency records.
- Optional `ringTimeoutMs`, `maxAcceptedMs`, `terminalTtlMs`, and `maxCalls` are validated server-side settings under `directCalls`. Call requests share the existing connection-wide and send rate budgets. Stats expose `callSignaling`, `activeCalls`, and `retainedCalls`.
- State is bounded, in memory, and owned by one server process, matching the existing connection registry. Process restarts lose it. Multi-process deployment requires a shared atomic signaling owner/store before enabling this feature across workers; a Socket.IO fan-out adapter alone cannot enforce these call locks.
- Shutdown stops deadlines, closes active signaling sessions and clears retained state. Delayed authorization results cannot create or revive calls after disconnect, revocation, expiry or shutdown.

Tests use the real Socket.IO server/client over loopback with explicitly test-only identity and conversation fixtures. No production identity, database schema, security implementation, or LiveKit transport is changed.
