# Main integration into chuong-data

This merge preserves `4d90fb7` (including the validated Unsend test fix) and integrates main `1c7d2c3`. PR #16 stays open and draft; this is not a merge into main.

## Conflict resolutions

- `client/next.config.js`: retain DATA auth/CSRF, social, encrypted persistence and Socket.IO proxies, isolated build configuration, and main's media CSP/shared-source configuration. Calling rewrites keep their development-only loopback gate and override only their exact paths when explicitly enabled.
- `client/package.json`: retain E2EE/Playwright scripts and dependencies, main's LiveKit dependency, and the exact compatible fake-indexeddb pin. Install LiveKit 2.24.1 in an independent dependency directory and update the lockfile. Old mirror URLs are replaced by official registry URLs with integrity hashes preserved.
- `AuthenticatedWorkspace.tsx`: keep the real DATA workspace mounted while Voice Rooms is open, preserving drafts and session resources. The media workspace uses its existing calling boundary; it does not replace DATA's authenticated v2 transport. Account/session changes still unmount the complete workspace.
- `authService.ts`: preserve normal DATA fresh-CSRF, verified-cookie login, strict logout, session APIs and no automatic demo fallback. Keep main's existing older HTTP adapter under `dev/calling/httpAuthService.ts`, with a constructor guard restricting it to the explicitly enabled development harness. Its bootstrap/logout semantics remain separate from production DATA auth.

DB-5/DB-6 remain their existing separate database/API entry point with injected authentication. Their required Express/better-sqlite3 dependencies are now declared and locked. No DATA schemas or session adapters were combined. Meeting Rooms media/call components and the DATA/E2EE/authenticated realtime implementation files are unchanged from their respective branches.

## Validation and failure attribution

| Check | Source baseline | Main baseline | Integrated candidate |
| --- | --- | --- | --- |
| Client tests | 867 passed | 617 passed, 4 stale Unsend assertions failed, 21 suites blocked | 815 passed, 0 assertion failures, same 21 suites blocked |
| Server tests | 478 passed | 308 passed, 26 cancelled | 452 passed, same 26 cancelled |
| Client TypeScript | Passed | Nine missing-contract diagnostics with matched SDK/dependencies | Identical nine diagnostics |
| Server TypeScript | — | — | Passed |
| Lint | — | Passed | Passed |
| Production build | Previously passed on feature export | Missing shared modules | Identical missing shared modules |
| DATA | — | — | 321 passed with serialized test files and isolated databases |
| Group/file API | — | — | Passed with isolated SQLite/storage and injected test auth |
| Final targeted auth/CSRF, dev harness, routing/workspace and Unsend checks | — | — | 91 passed |

The 21 blocked client suites fail during setup on missing `shared/livekit.ts` or `shared/directCalls.ts`; every one is also blocked on pristine main. The 26 cancelled server cases belong to the legacy client compatibility suite and have the same missing `shared/directCalls` cause on main. No assertions were disabled or weakened.

Browser E2EE and realtime acceptance scripts were attempted with separate test databases/services. Registration and the same-origin Engine.IO/unauthenticated-WebSocket guards were reached, but the application root cannot compile and returns HTTP 500 on the missing shared imports. Message exchange acceptance is blocked, not passing. Production build errors and client TypeScript diagnostics match pristine main using the same installed SDK. There are no remaining integration-specific failures found in the available checks.

An optional-prop typing issue and a new test's lint import style were corrected during integration; strict compiler/lint rules and test assertions remain enabled. Existing missing modules were not replaced with stubs or mocks. Dedicated workspace wiring tests double existing component boundaries only; the unmocked calling suites remain visibly blocked.

## Work still required before merging PR #16 into main

Restore the omitted original `shared/livekit.ts` and `shared/directCalls.ts` contracts and their matching authenticated LiveKit token/direct-call signaling backend. Token issuance, participant authorization, event contracts and the dev harness backend are not implemented by this merge. Installing the SDK alone does not restore those source files or services.

Then rerun full client/server/type/build and real browser E2EE/realtime/Meeting Rooms checks, complete required reviews/CI, and use the normal PR mechanism. Keep `chuong-data`. The source backup, Git bundles, stashes, development databases and running original services are preserved.

Existing security limits remain: server-authenticated keys with TOFU are not independent identity verification; browser key isolation does not protect against hostile same-origin JavaScript; revocation cannot erase keys already received by another participant. Production still requires HTTPS/WSS, exact Origin/proxy configuration and the documented migration procedure.
