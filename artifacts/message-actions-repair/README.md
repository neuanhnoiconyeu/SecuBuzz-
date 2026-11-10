# Message action UI integration repair

## Root cause and Git evidence

The verified workspace is `D:\Projects\SecuBuzz-`, checked out on `chuong-fullstack` at `0584aaaf586a588a03e1ab3d103aadec3b2061a0`. The teammate's compact toolbar was introduced later in `6c19049fc02972203966e2c0f2ab10b751a6b2c7` (`Update UI and emoji reactions in Phase 7`) and is present in the fetched `origin/main` merge `b301535`. `git merge-base --is-ancestor 6c19049 HEAD` returned 1: the checked-out branch does not contain that update. The earlier merge included the older inline-action implementation.

The active rendering path is `app/page.tsx` → `AuthenticatedWorkspace` → `MessengerApp` → `YahooChatWindow` → `components/messenger/MessageList.tsx`. That import was correct; the local MessageList source was the old version. There is no alternate dark-theme toolbar or duplicate active renderer. The compact toolbar and its `message-reactions.css` file were missing from the working source, rather than hidden by a conditional render or a theme preference.

## Focused fix

Reused the teammate's MessageList and companion stylesheet from the reviewed `origin/main` version, which also retains the existing local-demo receipt labels and safe retry guard. No branch was merged, reset, committed or pushed.

Application files changed:

- `client/src/components/messenger/MessageList.tsx`: renders compact React/Reply/More icon buttons; Pin/Unpin, Edit and Delete live in the overflow menu. Existing callbacks, owner-only edit/delete checks, deleted/system/security-message behavior, encryption indicators, attachments, voice rendering and retry behavior remain intact.
- `client/src/components/messenger/message-reactions.css`: reused toolbar/picker styles, scoped to this component. The new controls consume existing application color/surface/focus tokens instead of independently choosing an OS-based palette. No theme files, preferences, global colors, chat backgrounds or theme provider were changed.
- `client/src/components/messenger/__tests__/MessageList.actions.test.tsx`: eight focused interaction regressions. Existing test assertions were not weakened.

The reused popovers received keyboard focus/arrow/Escape/Tab handling, touch-aware outside dismissal, stale-menu cleanup, and bounds checks against the visible chat scroller. Mobile controls retain 44px targets. Popovers remain within the existing disabled conversation fieldset so its permission scope still applies. The old inline action strip is removed, rather than rendered alongside the new toolbar.

No backend, database, authentication, encryption or realtime source/configuration was modified. The pre-existing README edits and pending server/spec/document files were left untouched.

## Next.js/cache findings

The existing `next.config.js` uses `.next-dev` for development and `.next` for production. Webpack packs exist under `client/.next-dev/cache/webpack`, including `server-development`.

No Next cache was removed: the old implementation was directly present in the source and the relevant commit was absent from HEAD. The already-running development server compiled and served the corrected component without clearing those packs, as verified by the browser checks below. The reported historical `hasStartTime` startup warning was not established as the cause; the existing development processes were not restarted to reproduce it. Two pre-existing Next development servers from this workspace were observed on ports 3000 and 3001; neither was stopped or reconfigured.

## Validation

Commands ran from `D:\Projects\SecuBuzz-\client`:

| Check | Result |
| --- | --- |
| `npm test -- --runInBand` | PASS: **515 tests in 49 suites**, 35.202s, including the eight new action tests. |
| `npm run type-check` | PASS, exit 0. |
| `npm run lint` | PASS, exit 0, with the pre-existing native attachment-image optimization warning in MessageList. |
| `npm run build` | PASS, exit 0; all six static pages generated. Production output remained separate from the running dev assets. |
| Chrome interaction tests | PASS: **232/232 assertions** against the actual `/` chat page at localhost:3000. |

The browser harness used a separate temporary Chrome profile and left the user's browser/session/theme preferences untouched. It exercised Dark and Light at **1440, 1024 and 390px**, with the emulated OS preference deliberately opposite to the selected application theme. Native mouse/touch input and keyboard navigation verified owner permissions, reaction expansion/selection/removal, Reply, Pin/Unpin, Edit, Delete, focus restoration, menu bounds, unchanged security indicators, and no legacy toolbar. Existing page/chat background colors and the selected theme were compared before/after every case and remained identical. No horizontal page overflow, runtime exceptions or hydration errors occurred.

Browser command, from the project root: `node tmp/message-actions-repair/verify-browser.cjs`. The local ignored harness reused the established Chrome/CDP helper. It opened only its own browser process, closed it afterwards, and verified port 9232 was released. Source fingerprints before/after the run match. Machine-readable results: [development-browser-evidence.json](development-browser-evidence.json).

Screenshots were visually inspected:

- [Desktop Dark overflow menu](actions-1440-dark.png)
- [Desktop Light overflow menu](actions-1440-light.png)
- [Mobile Dark overflow menu](actions-390-dark.png)
- [Mobile Light overflow menu](actions-390-light.png)
- [Mobile Dark reaction picker](reactions-390-dark.png)
- [Mobile Light reaction picker](reactions-390-light.png)

## Remaining issues

No known message-action regression remains in the verified flows. The existing attachment-image lint warning and branding-logo image-priority development advisories remain outside this repair. The historical Webpack startup warning was not reproduced or treated as a source fix. Other remote changes remain unmerged, and the user's pending server work is unchanged.
