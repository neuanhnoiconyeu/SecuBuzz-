# V2.1: call duration in direct chat

Implemented on `bon-fullstack`, based on MVP commit `58e0da0`.
The pre-existing clean `feat/v2.1-call-duration` branch pointed to the same commit;
work returned safely to `bon-fullstack` following the user's correction. No new
branch, commit, push or PR was created for this implementation.

## Behavior

The existing floating call panel already measures elapsed time from the first
media connection with the authorized peer, rather than invitation/acceptance.
That working timer remains unchanged: MM:SS normally, with its existing H:MM:SS
format for long calls. Reconnection preserves its original start; hang-up freezes
the displayed duration and removes the interval.

After a call ends, the selected direct chat shows a compact event bubble such as
`Voice call · 05:32` or `Video call · 05:32` **inside MessageList**, with its end
timestamp. Calls are interleaved with messages/attachments by end time, retaining
the authenticated message sequence. Equal timestamps use a deterministic call-ID
tie-breaker. The previous separate expandable summary bar has been removed.
Missed, rejected and canceled calls have distinct labels without an invented
connected duration. A call never observed media-connected on this device says
its duration is unavailable. An unconfirmed termination is labeled explicitly
until the existing signaling path confirms it.

Summaries survive closing the call window and switching conversations within the
same workspace session. They are filtered by conversation, bounded to 50 across
the workspace, cleared on account/client changes, and removed on access-revocation
events. Only an authorized selected conversation supplies its calls to MessageList.
Call events have separate React keys/DOM identifiers and no message action menu;
they do not become encrypted message records. Calls break consecutive-message
grouping and use the existing chat scroll container and jump-to-latest control.
New calls follow the viewport only near the bottom, including at the 50-event
limit; prepending older messages preserves the reader's scroll offset.

## Persistence and boundaries

**Summaries do not survive a page reload, sign-out or workspace remount.**
Each event's accessible description and tooltip disclose this limitation.
There is no existing durable call-history API/table.
The server's five-minute in-memory terminal signaling retention is neither durable
history nor a record of actual media connection time. V2.1 does not fabricate a
duration from `acceptedAt`, add a migration, or persist call events as messages.

Durations are observations on this device, not authoritative/billing records;
participants can observe slightly different media arrival/termination times.
No new timers are introduced for history. Existing media/timer cleanup continues
on end, failure and unmount; navigation that keeps a call active keeps its existing
floating timer active too. Summary navigation itself starts no timers.

E2EE messages, revisions, watermarks, keys and the LiveKit/signaling protocols are
unchanged. A1 remains unresolved High/P1; no Format-2 work is included. Calls retain
their existing WebRTC transport encryption and are not claimed to have media E2EE.

## Files

- `client/src/calls/directCallHistory.ts`: summary projection, labels and bounded deduplication.
- `client/src/calls/useLiveDirectCalls.ts`: collect terminal observations in the existing controller.
- `client/src/components/calls/CallEventBubble.tsx`: compact themed timeline event (replaces the uncommitted summary-bar component).
- `client/src/components/messenger/MessageList.tsx`: interleave calls, maintain grouping and scrolling.
- `client/src/components/messenger/SecureConversationPanel.tsx`: authorized conversation integration.
- `client/src/styles/direct-calls.css`: two scoped theme-compatible event rules.
- `client/src/calls/__tests__/directCallHistory.test.ts`: timing, outcomes and bounded history.
- `client/src/calls/__tests__/conversationCallHistory.test.tsx`: event labels, timestamp, accessible session description and no timers.
- `client/src/components/messenger/__tests__/MessageList.calls.test.tsx`: chronological placement, attachments, stable keys, deduplication, navigation, grouping and scrolling.
- `client/src/components/messenger/__tests__/SecureConversationPanel.device.test.tsx`: authorized conversation-scoped events inside the real MessageList and absence of the old bar.
- `client/src/calls/__tests__/liveDirectCalls.test.tsx`: two-controller completion, media failure, confirmation, account reset and revocation.
- `client/src/calls/__tests__/directCallUI.test.tsx`: active ticker cleanup on unmount.
- This document.

## Validation

- Placement correction frontend regression: **174 passed, 0 failed, 14 suites**. Includes existing
  call-machine/UI, authenticated runtime, LiveKit connection, secure conversation
  and API realtime integration tests. Final run has no React act warnings.
- Client TypeScript (`--noEmit --incremental false`), ESLint (no warnings), isolated
  production build and diff whitespace checks passed.
- Existing `compose.yaml + compose.calls.yaml` validates successfully with
  `docker compose -p secubuzz- -f compose.yaml -f compose.calls.yaml config --quiet`.
- Primary Docker frontend/backend are healthy and the existing LiveKit service is
  running. Bind-mounted event component, MessageList, conversation panel and CSS
  SHA-256 hashes match the host source exactly. No Docker configuration or
  container/volume lifecycle changes were made.
- Browser placement checks at `http://localhost:3001` used separate synthetic
  authenticated profiles and real LiveKit with synthetic capture. Both users
  received decoded audio/video; completed voice/video events appeared once inside
  MessageList. Decrypted text before/after the call confirmed chronological order,
  and timestamps, panel-close preservation, conversation navigation and absence
  of the old bar were checked. Four synthetic accounts/two conversations and
  their test messages were added across two primary runs and retained; existing
  accounts/keys/history were not reset or deleted. Test sessions were logged out.
- Those two scratch browser runs stopped on test-harness issues: the first used
  `Reject` instead of the existing `Decline` button; the second had a PowerShell
  encoding mismatch in its expected Unicode middle dot. Both selectors were
  corrected without changing application behavior. Remaining browser acceptance
  uses the existing disposable DATA/Next runner and the same real Docker LiveKit
  SFU, to avoid adding further primary accounts.
- Final disposable real-SFU browser run: **28 checks passed, 0 failed, 0 runtime
  errors**. Voice/video remote media, chronological timeline placement, panel
  dismissal/navigation, rejected/canceled labels, mobile overflow and reload
  clearing all passed. Desktop/mobile screenshots were inspected. Evidence:
  `.cache/v21-placement-browser-41120542/evidence.json`; screenshots in the same
  ignored directory. Temporary DATA/Next processes and browser profiles were
  closed at the end; the default Docker project remains running.

Jest controller/media tests use synthetic signaling/media fixtures. Browser tests
use the real LiveKit SFU with synthetic browser microphone/camera capture; they
are not manual physical hardware acceptance. Ignored `.cache/v21-placement-*`
logs/fixtures are verification artifacts, not application changes or staging inputs.
