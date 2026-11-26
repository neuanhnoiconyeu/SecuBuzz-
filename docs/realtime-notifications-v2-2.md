# V2.2: realtime message, Buzz and incoming-call feedback

Work stays on `bon-fullstack`. Existing uncommitted V2.1, compact header,
security-icon and footer changes are preserved. No backend API, database,
E2EE protocol, calling transport or capability changes are introduced.

## Behavior

- New messages from another authorized participant show a generic `New message
  from â€¦` toast when that conversation is not visible. An open, visible chat
  keeps its normal message entry and unread behavior without a toast.
- Notice metadata is emitted only after a live envelope decrypts and matches an
  active, verified stored row. Initial reconciliation, history, older pages,
  own sends, edits, duplicate IDs and stale sequence replays do not create notices.
  In-memory connection generations prevent a delayed pre-reconnect receive from
  becoming a new alert. These counters are UI bookkeeping, not E2EE watermarks.
- Only sender identity and logical conversation/message IDs enter notice state;
  no decrypted body, attachment name/content, media key or ciphertext is shown.
  No browser/system Notification API or permission prompt is used. Local synthesized
  audio was added in the audible-notification correction documented below.
- Toasts float outside layout using a body portal, expire after five seconds,
  pause for pointer/keyboard interaction or a hidden document, and support Dismiss.
  View conversation reuses existing navigation while the Messenger workspace is
  visible; notices above Voice Rooms offer dismissal without pretending to change
  the outer media workspace. Existing unread badges remain available after the toast expires.
- Authenticated Buzz uses the existing event and ten-second send cooldown. One
  shared real-account controller highlights/shakes the Messenger window for the
  existing 500ms effect, including while another main section is selected.
  Reordered/replayed Buzz IDs are ignored. Messages never automatically send Buzz.
  Sender success/error feedback also uses transient notices rather than inline space.
- Incoming authenticated calls retain the existing controller and permission flow.
  The visible alert names the caller and voice/video type and offers Answer/Decline;
  Answer still invokes the existing `accept` operation. Attention lasts 650ms once
  per call ID. Snapshot revisions or a reconnect cannot replay attention. The alert
  is hidden when signaling is disconnected and removed by existing terminal states.
- Reduced-motion CSS suppresses shaking/movement and keeps text and static visual
  highlights. Calls retain their existing transport encryption; no media E2EE claim
  is added. A1 remains unresolved and unchanged.

## Files in this phase

Runtime additions:

- `client/src/hooks/useRealtimeNotifications.ts`
- `client/src/hooks/useArrivalAttention.ts`
- `client/src/components/messenger/ActivityToast.tsx`

Runtime integration:

- `client/src/realtime/SecureRealtimeWorkspace.ts`
- `client/src/hooks/useConversationBuzz.ts`
- `client/src/components/messenger/RealMessengerWorkspace.tsx`
- `client/src/components/messenger/SecureConversationPanel.tsx`
- `client/src/components/calls/DirectCallsRuntime.tsx`
- `client/src/components/calls/DirectCallLayer.tsx`
- `client/src/components/calls/IncomingCallNotification.tsx`
- `client/src/app/globals.css`
- `client/src/styles/direct-calls.css`

New focused tests:

- `client/src/hooks/__tests__/useRealtimeNotifications.test.tsx`
- `client/src/hooks/__tests__/useArrivalAttention.test.tsx`
- `client/src/components/messenger/__tests__/ActivityToast.test.tsx`

Existing regression coverage updated:

- `client/src/realtime/__tests__/SecureRealtimeWorkspace.test.ts`
- `client/src/hooks/__tests__/useConversationBuzz.test.tsx`
- `client/src/calls/__tests__/liveDirectCalls.test.tsx`
- `client/src/calls/__tests__/directCallUI.test.tsx`
- `client/src/dev/calling/__tests__/callingFlow.test.tsx`
- `client/scripts/verify-authenticated-calls.cjs` (Answer selector)
- `client/scripts/verify-authenticated-buzz.cjs` (whole-window effect target)

## Verification scope and limitations

Primary Docker checks use synthetic accounts and keep their records; no existing
account, message, browser key, stash, database file or Docker volume is reset,
deleted, restored or migrated. Complete media/browser checks can also use the
existing disposable DATA/Next runner with the same real Docker LiveKit SFU.
Disposable database files and browser artifacts stay under ignored `.cache` paths.
Browser contexts and test processes are closed at the end.

Browser media uses explicitly synthetic capture, not physical hardware. UI notices
are session-only and are not OS/push notifications. Offline/history backlog is
recovered normally without replaying transient new-message alerts. A failed or
uninitialized history/verification baseline conservatively suppresses alerts.
Large bursts coalesce to the latest toast; existing per-conversation unread badges
keep their independent counts.

## Recorded validation

- Final frontend regression: **669 passed, 0 failed, 50 suites**. Covers auth,
  realtime, calling, Buzz, notification hooks/toasts, shared message controls and
  the preserved compact UI. The extra toast test reproduces and fixes expiry
  remaining paused after a replacement notice removes a focused action.
- DATA/backend integration: **41 passed, 0 failed, four suites** for authentication,
  messaging, Buzz authorization/cooldown and call authorization/token lifecycle.
  The first sandbox runs could not load the call test's `tsx` dependency because
  Windows `os.userInfo()` failed with `uv_os_get_passwd / ENOMEM`, even at no load.
  The identical isolated tests passed with the required host API access; no backend
  code or security check was changed to accommodate the test runner.
- Client TypeScript (`--noEmit --incremental false`), ESLint and the isolated
  production build passed. No React act warnings in the final frontend run.
- Primary Docker at `http://localhost:3001`: two-account encrypted live delivery,
  active-chat suppression, inactive-chat notices, generic text, View conversation,
  coalescing and no message-triggered Buzz were verified. Four synthetic primary
  accounts and their own conversations/messages remain from two attempts; test
  sessions were logged out. No existing account/data/key/volume was reset.
- Complete browser acceptance: **31 passed, 0 failed, zero runtime exceptions,
  zero observed message-plaintext transport leaks**. It used disposable DATA/Next
  processes with the **same real Docker LiveKit SFU**, synthetic microphone tracks
  and separate authenticated profiles. Both users received decoded remote audio.
  Video invitations, Answer/Decline, cancel, mobile fit, actual Socket.IO disconnect,
  reduced motion, history/reload suppression and the V2.1 call bubble passed.
  This is not a new physical microphone/camera or video-media acceptance claim.
- Evidence: `.cache/v22-browser-5915eff6/evidence.json` and `mobile-call.png`;
  `.cache/v22-regression-final.log`, `v22-backend-final.log`, `v22-types-final.log`,
  `v22-lint-final.log`, `v22-build-final.log`. These ignored artifacts are not
  application/staging inputs.

Earlier browser attempts stopped on harness issues, not application changes:
the Friends/Chats selectors needed the real navigation labels; reload had to
return from the persisted Friends section before querying the hidden chat's live
status. Chrome's HTTP-offline emulation also left an existing WebSocket open;
the final check closes only its own tracked Socket.IO WebSocket to test a real
signaling interruption. No authentication, CSRF, transport or enrollment rule was
relaxed for these checks. The complete rerun used disposable data to avoid further
primary registrations.

## Audible-notification correction (2026-11-24)

### Current behavior

- One authenticated-workspace audio owner synthesizes original Web Audio tones:
  a short two-note incoming-message chime, a distinct four-pulse Buzz and a
  four-note ringtone repeating every 2.4 seconds. No audio recordings, external
  assets, dependencies, Notification permission prompts or Vibration API are used.
- Only the existing verified incoming-message/Buzz callbacks trigger one-shots.
  A visible active chat can chime without an intrusive toast. Own sends, cached
  events, history/reload/reconnect and duplicate IDs do not produce catch-up audio.
  Bursts are bounded; Buzz takes priority over message tones, and an incoming
  ringtone takes priority over both. No regular message sends Buzz.
- A valid authenticated incoming invitation starts one ringtone, bounded by the
  existing server invitation deadline. Answer and Decline stop it before waiting
  for acknowledgement. Cancellation, timeout, signaling disconnect, loss of
  eligibility and unmount stop and dispose it. Replayed terminal invitations
  cannot restart it. A failed Answer/Decline can leave the existing error UI
  available without unexpectedly restarting audio.
- The navigation offers **Sound On / Muted**. The same shared control appears
  inside incoming-call alerts because the alert overlays the navigation control.
  Both use the same audio owner and account-scoped local preference
  `secubuzz.notification-sounds.v1:<accountId>`; storage events synchronize mute
  between tabs. It stores no message content, media keys or authentication data.
- Sound defaults on as a preference, subject to normal browser autoplay policy.
  A trusted click or key interaction attempts to unlock audio. When an incoming
  event encounters locked audio, a visible hint explains the need for interaction
  and offers **Enable sound**. Unsupported Web Audio is reported explicitly.
  No autoplay-policy bypass is used. Muted/blocked one-shots are consumed and
  never queued; explicit unmute/unlock can resume only a still-valid invitation.
- Muting stops nodes/loops and closes the AudioContext. Logout/unmount disposes
  contexts, pending resumes, listeners and timers. Late permission completion
  cannot revive a muted/disposed owner. Preference-storage failure leaves the
  toggle functional and reports that persistence is unavailable.
- Authenticated Buzz now shakes the **whole real Messenger window** horizontally
  by up to 10px for 500ms, with a purple border/highlight. It retains the original
  ten-second authorized send cooldown. Reduced motion disables movement and
  preserves the highlight and notification text. Demo Buzz is unchanged.
- The desktop navigation retains its compact dimensions. At mobile widths the
  sound toggle is icon-only with its accessible name/tooltip; the redundant
  profile copy is hidden while the profile avatar and account footer remain.

### Files changed by this correction

New runtime and isolated test support:

- `client/src/notifications/notificationAudio.ts`
- `client/src/notifications/NotificationSoundProvider.tsx`
- `client/src/notifications/useIncomingRingtone.ts`
- `client/src/notifications/testing/fakeAudio.ts`
- `client/src/notifications/__tests__/notificationAudio.test.ts`
- `client/src/notifications/__tests__/NotificationSoundProvider.test.tsx`

Existing runtime integration:

- `client/src/hooks/useRealtimeNotifications.ts`
- `client/src/hooks/useConversationBuzz.ts`
- `client/src/calls/useLiveDirectCalls.ts` (exposes the validated invitation deadline)
- `client/src/components/calls/DirectCallsRuntime.tsx`
- `client/src/components/calls/IncomingCallNotification.tsx`
- `client/src/components/messenger/RealMessengerWorkspace.tsx`
- `client/src/components/messenger/MainNavigation.tsx`
- `client/src/app/globals.css`
- `client/src/styles/motion.css`

Existing tests/documentation:

- `client/src/hooks/__tests__/useRealtimeNotifications.test.tsx`
- `client/src/hooks/__tests__/useConversationBuzz.test.tsx`
- `client/src/calls/__tests__/liveDirectCalls.test.tsx`
- `client/scripts/verify-authenticated-buzz.cjs` (updated animation assertion)
- This document.

Other V2.1/V2.2 and security work was preserved. TypeScript also regenerated the
already tracked `client/tsconfig.tsbuildinfo`; it is generated metadata, not source.
No files were staged or committed.

### Correction validation

- Complete frontend regression: **1,476 passed, 0 failed, 138 suites**. After the
  browser-discovered alert/control overlap was fixed, the affected notification,
  call UI/controller and hook suites were rerun: **60 passed, 0 failed, 6 suites**.
  Focused results are a subset, not an additional 60 distinct regression tests.
- Existing isolated DATA/backend authentication, encrypted messaging, Buzz and
  call integration: **41 passed, 0 failed, 4 suites**.
- Final client TypeScript, ESLint and isolated production build passed without
  errors or lint warnings. Next emitted its existing advisory about automatically
  adding a TypeScript plugin to an extending configuration; no config was changed.
- Two-account browser acceptance: **45 passed, 0 failed**, with separate browser
  contexts, normal `document-user-activation-required` autoplay policy and the
  **existing real Docker LiveKit SFU**. Temporary DATA/Next services and synthetic
  account/device data were used; their owned processes were stopped afterwards.
- Browser acceptance measured **nonzero rendered Web Audio PCM**, message/Buzz
  tone counts, single repeating ring cycles, mute/unmute, blocked/unlocked audio,
  silence after Answer/Decline/cancel/timeout/disconnect, history suppression,
  reduced motion, mobile fit and the existing call-history bubble. Both accounts
  received decoded remote LiveKit audio using synthetic microphone capture.
  No runtime exceptions, observed message-plaintext transport leaks or unexpected
  attachment requests occurred. This does **not** verify physical speakers or
  headphones, nor constitute new video-media or media-E2EE certification.
- Primary Docker `http://localhost:3001` serves the current source through its
  existing read-only frontend mount. Its real-bundle synthetic UI fixture passed
  **17 checks**: current provider/control, actual audio unlock, persisted mute,
  44px targets, keyboard focus and no overflow at 1440/390/320px, whole-window
  animation, reduced motion and AudioContext closure. This fixture makes no
  authenticated API mutations and is distinct from two-account verification.
- The initial primary two-account attempt registered/logged in/enrolled one new
  disposable account, then the second registration was refused. Its status code
  was not captured, so no specific cause is claimed. Existing DATA registration
  limits were preserved; no limiter, account, password or server setting was reset
  to force a pass. The first synthetic account remains, its session logged out.
- The first disposable audio run exposed the call alert covering navigation sound
  controls: automation waited until invitation timeout before it could click.
  Reusing the sound control **inside** the alert fixed that confirmed usability
  defect; the complete 45-check rerun passed. No signaling change was needed.
- Evidence: `.cache/v22-audio-browser-87bf083e/evidence.json`, `mobile-audio.png`,
  `.cache/v22-audio-docker-ui/evidence.json`, `mobile-sound.png`, and
  `.cache/v22-audio-{regression,focused-final,backend,types-final,lint-final,build-final}.log`.
  Ignored browser profiles, disposable databases and build outputs are not source
  or staging inputs. All pre-existing primary/legacy databases, volumes, keys,
  stashes and accounts remain intact. A1 is still unresolved and unchanged.

## Browser-tab unread notifications (V2.2)

- The authenticated workspace passes its existing `snapshot.unread` map to one
  presentation hook. Counts are summed across conversations, with `(1)`, `(N)`
  and `(99+)` prefixes on the unchanged `Yahoo! Security Messenger 2.0` title.
  Zero unread restores the base title. There is no second unread counter or new
  message listener, persistence format, read API or focus/visibility handler.
- Existing verified realtime/history reconciliation owns deduplication. Initial
  history and replay do not fabricate unread; genuinely new offline peer messages
  can be recovered once through the existing reconciliation. Own sends do not
  increment unread. Opening a visible conversation clears its count through the
  existing `select`/read behavior; focusing an inactive conversation's browser tab
  does not clear it. This inherits current session-level unread semantics rather
  than introducing persistent notification state across reloads or devices.
- Valid incoming authenticated voice/video invitations temporarily show
  `(N) Incoming voice call · Yahoo! Security Messenger 2.0` (or video). The unread
  prefix remains current during ringing, and the normal unread title returns on
  accepting, declining, cancellation, termination or signaling disconnect.
  Outgoing calls and demo previews do not receive an incoming-call title.
- A small red dot is drawn into a temporary SVG derived from the existing public
  favicon artwork. Original icon/shortcut link elements remain in place. Their
  original `href`, `type` and `sizes` are restored at zero unread and unmount;
  Apple touch icons and branding assets are unchanged. Failed favicon loading
  leaves the original icon available while the unread title continues to work.
  Late loads are aborted/ignored after read or cleanup. No object URLs, timers,
  private message text, caller identity or attachment metadata are used.
- Changed source/test files for this addition only:
  `client/src/notifications/useBrowserTabNotifications.ts`,
  `client/src/notifications/__tests__/useBrowserTabNotifications.test.tsx`,
  `client/src/components/messenger/RealMessengerWorkspace.tsx`,
  `client/src/realtime/__tests__/SecureRealtimeWorkspace.test.ts`, and this document.
  Existing sound, Buzz, call history, compact UI and E2EE changes are preserved.
  TypeScript regenerated the already tracked `client/tsconfig.tsbuildinfo` only
  as build metadata. No files were staged or committed.
- Relevant frontend regression: **150 passed, 0 failed, 16 suites**, including
  notification audio, Buzz, call controllers/history/UI, authenticated workspace,
  canonical realtime replay/reconnect/read behavior and tab/favicon lifecycle.
  The initial focused run was **41 passed** in two of those suites, not additional
  distinct tests. TypeScript, ESLint and the isolated production build passed.
- Primary Docker frontend/backend remain healthy, with the existing LiveKit
  service running. Its actual frontend bundle passed **14 synthetic UI checks**
  for exact titles/count caps, call precedence, favicon restoration, focus behavior
  and cleanup without authenticated API mutations. Evidence:
  `.cache/v22-tab-docker-ui/evidence.json`.
- Two-account authenticated browser run: **30 passed, 0 failed**, using separate
  synthetic browser sessions with disposable DATA/Next services and the existing
  real Docker LiveKit server. Verified visible/inactive conversation read behavior,
  peer-only counts, a duplicated authenticated encrypted send, actual Socket.IO
  reconnect/history reconciliation, voice/video invitation title precedence,
  cancellation/decline, read clearing, reload and logout cleanup. Canvas pixel
  checks confirmed that the branded favicon SVG actually renders the red dot.
  No browser runtime exceptions or observed message-plaintext transport leaks
  occurred. Evidence: `.cache/v22-tab-browser-bf4430a0/evidence.json`.
  The first browser attempt stopped on a Windows harness encoding mismatch (`?`
  instead of the expected middle-dot separator); the application title was already
  correct. The corrected harness passed without a runtime code change.
- Verification logs: `.cache/v22-tab-{regression,types,lint,build}.log`.
  Browser tests use disposable synthetic accounts, devices and test services;
  primary Docker databases/volumes and all pre-existing user data remain intact.
