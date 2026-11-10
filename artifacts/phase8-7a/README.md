# Phase 8.7A browser verification

Fresh Chrome/CDP checks against the final application source: **538/538 assertions passed** (9 production, 503 development matrix, 26 additional controls/heading checks). Production build: `xJylRKU69tg23AoPA70Rq`.

All three runs verified identical application TS/TSX/CSS source (83 files, excluding tests), unchanged before/after each run. SHA-256: `59c3108df60a56f20f3259b8363290d7147761f28d30ca4455eef5c56262518a`. Exact timestamps, source fingerprint, Chrome version and process cleanup are in [browser-summary.json](browser-summary.json).

## Executed commands

From `D:\Projects\SecuBuzz-`:

```powershell
node tmp/phase8-7a-browser/run.cjs production
node tmp/phase8-7a-browser/run.cjs development
node tmp/phase8-7a-browser/extras.cjs development
```

The local harness uses installed Next.js and Chrome, without adding test dependencies. Helper scripts and Chrome profiles remain in ignored `tmp/phase8-7a-browser`. Production ran the fresh build without a demo environment flag; development explicitly used the isolated demo authentication adapter. The harness launched hidden owned processes on ports 3110 (Next.js) and 9230 (Chrome CDP), closed its processes and verified both ports were released.

## Responsive and appearance matrix

| Viewport | Appearance | CSS viewport | Evidence |
| --- | --- | --- | --- |
| Desktop | Light | 1440 × 1000 | [Screenshot](desktop-light-connected.png) |
| Desktop | Dark | 1440 × 1000 | [Screenshot](desktop-dark-connected.png) |
| Laptop | Light | 1024 × 900 | [Screenshot](laptop-light-connected.png) |
| Laptop | Dark | 1024 × 900 | [Screenshot](laptop-dark-connected.png) |
| Mobile | Light | 390 × 844 | [Screenshot](mobile-light-connected.png) |
| Mobile | Dark | 390 × 844 | [Screenshot](mobile-dark-connected.png) |

System appearance also followed emulated OS dark/light changes at 390 × 844 without losing message state or connection. Bungee and Space Grotesk were checked using Chrome's actual rendered font data. All six viewports passed page/component horizontal-overflow checks.

[Open screenshot gallery](index.html). Screenshots were visually inspected using `view_image`; the check included contrast, typography, status labels, chat surfaces, composer spacing, and mobile layout.

- [Direct typing](desktop-light-direct-typing.png): Ava direct-message preview with simulated typing, received events and local-demo connection status.
- [Group typing](laptop-dark-group-typing.png): Existing group preview with multiple simulated typers; no group-management service is implied.
- [Failed send](mobile-dark-failed-send.png): Mobile confirmed simulated send failure with an explicit manual Retry action and a single reconciled bubble.
- [System appearance](mobile-system-connected.png): System appearance follows the emulated OS theme while preserving the current message state.
- [Production gate](production-unconfigured-signup.png): Production signup with unavailable-backend notice, disabled form, and no demo authentication/realtime fallback.
- [Desktop demo controls](desktop-light-demo-controls.png): Open System Log scrolled to the local simulation selector and actions at 1440 × 1000.
- [Mobile demo controls](mobile-dark-demo-controls.png): Open System Log scrolled to the responsive two-column simulation actions at 390 × 844.
- [Group heading](laptop-dark-group-heading.png): Full group heading fits at 1024 × 900; heading width and scrollWidth both equal 264 px.
- [Group activity, immediate](laptop-dark-group-activity-immediate.png): Full group heading immediately after simulated group typing/incoming and closing the controls.
- [Group activity, settled](laptop-dark-group-activity-settled.png): The same group activity 250 ms after closing controls; no heading or ancestor horizontal scrolling.

## Behavior checked

- Demo login connects one session-scoped local realtime client. Selection and Friends navigation preserve the connection, drafts and existing conversation IDs.
- Sending, local acceptance, simulated delivery and simulated read are distinct visible states. Incoming direct/group fixtures update the proper preview/unread count and render once when opened.
- Direct/group typing appears and clears; conversation changes and disconnect remove stale indicators. Simulated presence reaches the chat header, sidebar avatar and Friends list, then clears on disconnect.
- Failure remains failed until manual retry. Offline retry is unavailable; explicit reconnect restores retry. A three-attempt ceiling remains enforced, and retries reconcile a single bubble.
- Logout removes the old session's messages, drafts, presence, typing and scheduled replies. A different demo identity receives a fresh isolated session.
- Production protected entrypoints show disabled unavailable-backend forms and expose neither demo login nor mock realtime controls. No real Socket.IO connection was attempted by either run.

## Logs and limits

[Production evidence](production-browser-evidence.json), [development evidence](development-browser-evidence.json), [controls/heading evidence](demo-controls-browser-evidence.json), [production log](production-browser.log), [development log](development-browser.log). Uncaught runtime/hydration errors: **0**. Production console warnings/errors: **0**. Development recorded **10** existing Next.js image-priority LCP warnings for `/branding/yahoo-security-logo-source.png`; no application exception was recorded.

Only isolated mock realtime was exercised. No server authentication, room authorization, database persistence, real recipient key exchange, real-user delivery, or full group-creation/invitation/membership workflow was connected or claimed. Socket adapter rejection, malformed/stale/duplicate event handling, bounded incoming queues and real-send encryption gating are covered by separate focused unit tests, not by a live backend in this browser run.
