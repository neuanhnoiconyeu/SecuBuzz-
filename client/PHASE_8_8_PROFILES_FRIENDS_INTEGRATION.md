# Phase 8.8 — Real Profiles & Friends Frontend Integration

Date: 2026-11-14. Ownership: `client/` only. Branch: `chuong-data`; starting HEAD: `72f4e80`.

Local runtime follow-up: [Profile hotfix and verified recovery](PHASE_8_8_PROFILE_HOTFIX.md). The fresh-backend integration tests below did not detect the user's older port-5000 DATA process, which required a restart to load DB-3. The hotfix also corrects HTTP feature/server error classification without changing the API contract.

## A. Verdict

COMPLETE. Real DB-3 integration, frontend checks and real two-account browser verification passed.

## B. Before and after

Real authenticated accounts previously saw the temporary “You're signed in” card. They now enter the existing Messenger window, branding, MainNavigation, FriendsPage and ProfileDialog. The existing fonts, theme provider, shared controls, dialog focus behavior and responsive navigation remain in use. The real outer shell clips overflow so deep links and focused Friends controls cannot scroll navigation out of view; the content pane retains its own scrolling.

Chats displays “No conversations yet.” There are no seeded conversations, message composer, mock transport, mock presence, AI provider or encryption claims in this real workspace. AI Hub and Security explain the services currently available. Sign Out stays available even if profile or relationship loading fails.

The isolated, explicitly injected development demo harness remains for existing regression tests. Deployed configuration still cannot select demo authentication. Real authenticated execution constructs only remote profile/friends services.

## C. Profile integration

- `GET /api/users/me` loads the owner's private profile and immutable ID/username.
- `PATCH /api/users/me` sends only the supplied editable fields: display name, status message, built-in avatar and presence preference. The response must identify the bound account.
- Existing form validation enforces 40/160 Unicode code-point name/status limits, trims surrounding whitespace and rejects controls and unsupported fields. Server field errors use a fixed allowlisted message.
- Only confirmed response fields update the dialog and navigation. Failed saves retain the draft; network errors never announce success. Stored presence preference is explicitly labeled as a preference. Public profiles never receive it.
- Public profile dialogs call `GET /api/users/:id`. Loading, failed authorization/404 and retry states replace cached list content. Closing, changing the target, mutations and unmount invalidate old responses.

## D. User discovery

Remote discovery accepts a trimmed, case-normalized username prefix of 2–64 ASCII letters, digits, dots, underscores or hyphens. It is not substring, display-name or email search. A 300 ms debounce avoids requests while typing; invalid short prefixes are explained before any search request.

`GET /api/users/search?q=...&limit=20&cursor=...` supplies all results. “Load more users” appends deduplicated next-page results. Query changes abort the old request and clear its cursor; completion guards reject old first-page and pagination results. The server determines discoverability and each `self/none/friend/incoming/outgoing` relationship. Blocked identities are not synthesized into search results. Public projections retain only ID, username, display name, avatar and relationship/request ID; email, private status, preferences and inferred presence are excluded.

## E–G. Requests, friendships and blocks

| UI action | DB-3 operation |
| --- | --- |
| Send request | `POST /api/friends/requests` with `{userId}`; expect 201 |
| Accept / decline | `POST /api/friends/requests/:id/accept` or `/decline`; expect 200 |
| Cancel sent request | `DELETE /api/friends/requests/:id`; expect 204 |
| Remove friend | `DELETE /api/friends/:id`; expect 204 |
| Block | `POST /api/blocks` with `{userId}`; expect 204 |
| Unblock | `DELETE /api/blocks/:userId`; expect 204 |

The existing confirmation dialogs protect remove/block. Duplicate clicks are serialized; action buttons are disabled during mutations, loading and stale snapshots. No mutation is automatically retried. After a confirmed write, a complete authoritative refresh reconciles Friends, Pending, Blocked and search. An accepted write followed by a failed refresh is labeled as accepted but needing refresh; stale data cannot authorize another action. Conflicts/404, failed CSRF, rate limits and outages produce fixed public messages, with bounded Retry-After guidance when supplied.

Snapshots exhaust all pages of friends, pending incoming/outgoing requests and blocked users at one DB-3 revision. A STALE_STATE response discards the entire partial snapshot and retries the read at most twice. Each collection is limited to 20 pages of 50; a whole snapshot has a 15-second deadline. Oversized lists fail visibly instead of silently truncating. Duplicate/cross-collection identities, repeated cursors, invalid bodies and mismatched revisions fail validation.

Successful block removes friendship and pending requests according to DB-3. Unblock does not restore them. Manual Refresh Friends, visible-window focus and a 30-second visible-window poll reconcile changes made by another account; this is not realtime presence or realtime delivery.

## H. Authentication and security

The existing AuthProvider and HttpAuthService remain the only identity/session infrastructure. `createSessionApi` shares DB-2's fetch, fresh CSRF bootstrap, HttpOnly same-origin cookies and invalidation channel. No token is read from cookies or written into storage. The browser sets its own Origin and Cookie headers.

Each data scope binds the verified account ID/username and authentication generation. Reads and writes check `/api/auth/me` before and after the operation; a changed actor or 401 invalidates the existing provider and discards the result. Logout/authentication mutations abort old data scopes immediately. Workspace keys, abort signals, sequence guards, disposal and empty initial state prevent late results from repopulating another account. Failed logout preserves identity and reports uncertain revocation, while a new generation renews the canceled data scope.

Requests use same-origin paths, `credentials: same-origin`, `mode: same-origin`, `redirect: error`, `cache: no-store`, AbortController and a 15-second deadline covering bootstrap, fetch, parsing and identity checks. Public errors never display backend diagnostics. Cancellation also rejects transports that ignore AbortSignal. Server-side authorization remains authoritative; browser checks do not replace it.

The Next proxy adds exactly eleven DB-3 paths to the existing five auth rewrites. Static routes precede ID routes. It does not expose legacy CRUD, messages, contacts, logs or arbitrary `/api/*` forwarding. Existing target validation requires HTTPS in production and permits loopback HTTP only in development; no security headers or cookie attributes are weakened.

## Configuration and operation

Use the existing API settings in `.env.example`. `AUTH_BACKEND_URL` is server-only and now serves both DB-2 and DB-3 rewrites. DATA must allow the exact frontend public origin. Local example: Next at `http://127.0.0.1:3000`, DATA at `http://127.0.0.1:5000`, `AUTH_ALLOW_HTTP_LOCAL=true`, `AUTH_ALLOWED_ORIGINS=http://127.0.0.1:3000` on DATA. Restart Next after changing proxy settings. Do not mix localhost and 127.0.0.1 cookies/origins.

Production: configure an HTTPS `AUTH_BACKEND_URL` before building, or route the exact public API paths through the deployment reverse proxy. No production backend destination is invented. Browser social paths remain `/api/users`, `/api/friends`, `/api/blocks`; the existing configurable auth base path remains independent. No new dependency or social authentication flag is required. AI/realtime flags stay disabled for this workspace.

## I. Exact Phase 8.8 source paths

Existing files extended (their earlier uncommitted work was retained):

```text
client/.env.example
client/authProxy.cjs
client/next.config.js
client/src/app/globals.css
client/src/auth/AuthProvider.tsx
client/src/auth/AuthenticatedWorkspace.tsx
client/src/auth/INTEGRATION.md
client/src/auth/authService.ts
client/src/auth/httpAuthService.ts
client/src/auth/__tests__/AuthProvider.test.tsx
client/src/auth/__tests__/workspaceIntegration.test.tsx
client/src/components/friends/FriendsPage.tsx
client/src/components/messenger/MainNavigation.tsx
client/src/components/profile/ProfileDialog.tsx
client/src/friends/friendsService.ts
client/src/hooks/useCurrentProfile.ts
client/src/hooks/useFriends.ts
client/src/hooks/__tests__/useCurrentProfile.test.tsx
```

New files:

```text
client/PHASE_8_8_PROFILES_FRIENDS_INTEGRATION.md
client/scripts/verify-phase88.cjs
client/src/api/sessionApi.ts
client/src/api/socialValidation.ts
client/src/api/__tests__/sessionApi.test.ts
client/src/auth/__tests__/socialProxy.test.ts
client/src/components/friends/__tests__/RemotePublicProfile.test.tsx
client/src/components/messenger/RealMessengerWorkspace.tsx
client/src/friends/remoteFriendsService.ts
client/src/friends/__tests__/remoteFriendsService.test.ts
client/src/hooks/__tests__/useRemoteFriends.test.tsx
client/src/profiles/remoteProfileService.ts
client/src/profiles/__tests__/remoteProfileService.test.ts
```

Verification artifacts (exact paths):

```text
client/artifacts/phase8-8/browser-evidence.json
client/artifacts/phase8-8/jest-results.json
client/artifacts/phase8-8/ownership-audit.json
client/artifacts/phase8-8/desktop-profile-light.png
client/artifacts/phase8-8/desktop-friends-light.png
client/artifacts/phase8-8/desktop-discovery-light.png
client/artifacts/phase8-8/mobile-discovery-dark.png
client/artifacts/phase8-8/mobile-profile-dark.png
client/artifacts/phase8-8/mobile-backend-unavailable.png
```

Generated Next caches and the isolated browser database/profile are ignored under `client/.next*` and `client/tmp/`. The tracked incremental TypeScript cache is returned to its original clean content after verification.

Ownership verification compares SHA-256 hashes with the 74-file pre-edit dirty-tree baseline. All 54 pre-existing changed/untracked files outside client must remain byte-identical, and no new outside-client diff is allowed. Backend tests are not presented as rerun evidence for this frontend phase. DATA is started without editing it, against a unique isolated database under client/tmp. No branch changes, commit, push, stash, reset, clean, merge or rebase is performed.

## J. Verification results

| Check | Final result |
| --- | --- |
| TypeScript | PASS — `npm run type-check` |
| ESLint | PASS — `npm run lint`; two existing `no-img-element` warnings in MessageComposer/MessageList |
| Full Jest suite | PASS — 783 tests, 66 suites, zero failures |
| Production build | PASS — `npm run build`; all six static pages generated; `/`, `/login`, `/signup` compiled |
| Real two-account Chrome verification | PASS — 27/27 assertions; Chrome 157.0.8103.78, Node 24.20.0 |
| Ownership / diff / branch checks | PASS — all 54 pre-existing outside-client paths retain their baseline SHA-256; no new outside-client change; `git diff --check` passes; `chuong-data` remains at `72f4e806e1446ce65036f705f9f7eb82275942d9` |

The new regression tests cover shared CSRF/cookie transport, 401 invalidation, changed actors, disposal/late completions, safe errors, no write retries, public-profile 404, field projection, profile validation/failed saves, complete snapshot pagination/revisions, bounded stale retries, discovery paging, canceled queries and stale load-more results. Existing authentication, demo-harness-only Messenger, theme, crypto and AI tests remain in the full suite.

Full-suite command: `npm test -- --runInBand --testTimeout=15000 --json --outputFile=artifacts/phase8-8/jest-results.json`. Earlier concurrent browser/build runs exceeded the existing five-second limit on two multistep demo workspace scenarios. The final suite ran without those competing processes, with a 15-second per-test budget; all assertions passed in 78.081 seconds. No test was skipped or removed. Browser evidence is in `artifacts/phase8-8/browser-evidence.json` and screenshots include desktop light Friends/profile/discovery, mobile dark Friends/profile and the stopped-backend error.

Reproduce the browser test from client with `node scripts/verify-phase88.cjs`. It requires installed DATA/client dependencies and Chrome (`CHROME_PATH` can override its Windows location). It allocates its own free ports, isolated SQLite file and browser contexts; signs up/logs in two real accounts through the UI; exercises profile editing/reload, public profile reads, prefixes/empty/self search, every relationship action, both lists, backend restart, persisted block/profile behavior, mobile dark mode and focus, logout/account switch, rejected missing-CSRF mutation and stopped-backend errors. It records only public API paths/status codes and screenshots, without session tokens, passwords, CSRF challenges or email bodies. It stops only its owned browser/Next processes. Production compilation is verified separately; this local HTTP browser run uses Next development mode with the real DATA implementation.

## K. Known limitations

- Conversation/group/message persistence awaits DB-4; there are no actionable real chat controls or fabricated conversation records.
- No realtime delivery or public online presence is connected. Poll/focus/manual refresh provides eventual relationship updates. Presence preference is stored privately, without a broadcast.
- AI Hub is unavailable for real accounts; Gemini is not enabled. Existing encryption and realtime implementations are unchanged and unmounted from the real workspace until their contracts are ready.
- Large snapshots beyond the explicit traversal/deadline budget fail with a retryable error. Server search paging is not a frozen global directory snapshot; query/mutation refresh clears previous cursors.
- Verification uses isolated local test accounts and an isolated database, not production credentials or deployed infrastructure.

## L. DB-4 / Kiro readiness

Real stable account IDs, authorized public profiles and consent-based relationship state are ready for DB-4 conversation discovery/creation. Kiro can integrate an authenticated conversation/realtime provider at RealMessengerWorkspace without reintroducing the demo session factory. The backend must still define and implement conversation membership, message persistence/delivery/acknowledgements, block enforcement for messaging and authenticated recipient keys. No DB-4 or Kiro-owned implementation is claimed by this phase.
