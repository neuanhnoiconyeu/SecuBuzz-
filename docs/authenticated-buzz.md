# Authenticated Buzz — Phase 13C

## Behavior and integration

Demo Mode already had the shared `MessageComposer` Buzz button, local feedback and
`buzz-shake` CSS. Real Account Mode hid Buzz in its capability profile and had no
authenticated transport. Phase 13C connects those existing controls and animation
to the session-owned Socket.IO connection. Demo Mode keeps its existing behavior.

- Send `buzz:send` with exactly `{ conversationId }`. No actor, recipient, message
  text, encryption key or message envelope is accepted in the request.
- DATA's existing direct-conversation resolver verifies current session,
  membership and relationship policy for sender and recipient connections.
  Its reuse does not require LiveKit. The existing CSRF-bound handshake, Origin
  allowlist, event security policy and event/pending-request limits still apply.
- `buzz:received` contains only a server-generated event ID, conversation ID,
  authenticated sender ID/display name and timestamp. The client validates scope,
  rejects malformed/stale/duplicate events and ignores events after disposal.
- A ten-second, account-scoped server cooldown survives tab changes and socket
  reconnects. Reservation occurs before asynchronous authorization checks, so
  concurrent requests cannot race it. The UI also disables Buzz for ten seconds,
  including failed or unconfirmed attempts. Other composer controls remain usable.
- Successful sending and receiving show a visible, polite status notification and
  the existing 500 ms chat-window animation. Existing reduced-motion CSS suppresses
  the animation while retaining the notification. Real-account Buzz is silent;
  no browser audio permission or user preference is overridden.
- Buzz never enters the encrypted message, attachment, revision, deletion, pin,
  reaction, history or watermark pipelines. It is ephemeral session metadata,
  like typing; no media or message E2EE claim applies to Buzz itself.

## Verification

Verified against the updated **default** Docker project at `http://localhost:3001`:

| Check | Result |
| --- | --- |
| Frontend messaging/realtime/recorder/emoji/action-menu regression | 456 passed / 31 suites |
| Backend Buzz, calls, typing, encrypted Edit/A2, pins and reactions | 35 passed |
| Backend DATA/Socket.IO authentication, authorization, policy and validation | 101 passed |
| Default-Docker browser acceptance, two synthetic accounts/profiles | 14 passed |
| Client and server TypeScript | Passed |
| Frontend ESLint | Passed, no warnings |
| Isolated frontend production build | Passed |

The browser run exercised real authenticated Socket.IO delivery in both
directions, sender animation, recipient reduced motion, cooldown, retained draft,
keyboard activation after reload/reconnect, and a 390 px mobile viewport. Buzz
requests contained only the conversation ID, history was identical before/after,
and no browser runtime exceptions occurred. This is automated browser evidence;
no human-operated browser or audible alert testing was performed.

An initial block test expected 201 instead of the existing API's 204; corrected.
The first browser harness checked enrollment before initialization finished;
corrected its wait and reran using the same synthetic accounts/profiles. A Windows
sandbox OS-query failure in existing `tsx` tests was resolved by running those
isolated tests outside the sandbox. Final verification has no failing tests.

Ignored local evidence: `.cache/phase13c-*.log`,
`.cache/phase13c-buzz-0579d5a4/evidence.json`, and
`.cache/phase13c-preservation.json`. The synthetic profiles and their credentials
are private local test artifacts; do not stage or publish them.

## Files changed in this phase

Runtime:

- `shared/buzz.ts`
- `server/src/realtime/{buzz,config,protocol,server}.ts`
- `server/src/data/bridge.ts`
- `client/src/realtime/{authenticatedProtocol,AuthenticatedSocketIoClient,SecureRealtimeWorkspace}.ts`
- `client/src/hooks/useConversationBuzz.ts`
- `client/src/components/messenger/{MessageComposer,SecureConversationPanel}.tsx`
- `client/src/messaging/messagingCapabilities.ts`

Tests and verification:

- `server/test/data/buzz.test.ts`
- `client/src/hooks/__tests__/useConversationBuzz.test.tsx`
- `client/src/realtime/__tests__/{AuthenticatedSocketIoClient,SecureRealtimeWorkspace}.test.ts`
- `client/src/components/messenger/__tests__/{SecureConversationPanel.device,messagingCapabilities}.test.tsx`
- `client/scripts/verify-authenticated-buzz.cjs`
- This document.

## Preservation and limitations

The existing default backend image was rebuilt and its Compose services refreshed
with the existing calling overlay. No Compose configuration was changed. Named
volumes `secubuzz-_sqlite-data` and `secubuzz-_private-storage` are unchanged;
frontend/backend health checks pass and LiveKit remains running. Legacy recovery
remains stopped and stash `63aba73` remains untouched.

Consistent read-only SQLite snapshots before/after verification pass integrity
and foreign-key checks. All original rows across 32 business tables are identical;
migration ledger 1–12 is unchanged. Two synthetic accounts, one conversation,
two device enrollments and their normal supporting records were added for QA.
Existing messages remain at three; Buzz added none. Session/challenge/rate-limit
records may change through normal authentication and expiry.

Of 38 pre-existing dirty files, 34 are byte-identical. The remaining four retain
their prior changes with targeted Buzz additions: `SecureConversationPanel.tsx`,
its device test, the capability profile, and its test. No history/index changes,
database migrations, messaging cryptography or calling changes were made.

Buzz has no offline queue or delivery/read receipt. An offline/unavailable peer
produces error feedback; a transport interruption can lose an ephemeral signal.
Cooldown is in memory in the existing single-process backend and resets on server
restart. A future multi-instance deployment would need shared rate limiting.

Phase 13C is ready for Final Regression. The separate unresolved **A1 High/P1**
rollback-integrity finding remains deferred; no Format-2 implementation or
security approval is implied by this phase.
