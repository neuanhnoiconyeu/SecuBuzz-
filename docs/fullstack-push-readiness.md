# Fullstack push readiness — 2026-11-17

Validated on Windows with Node.js 26.13.0, using the Asia/Saigon review date. This describes source/commit readiness, not production deployment readiness. No files were staged, committed or pushed.

## Corrections

- Filenames now travel as ASCII percent-encoded X-File-Name plus an explicit X-File-Name-Encoding: percent-utf8 marker. The transport around the existing DB6 API decodes exactly once, so original_name and normal metadata searches retain spaces, literal percent signs, percent-looking text and Unicode.
- DB6 download headers use an ASCII fallback plus RFC 5987 UTF-8 filename*, avoiding invalid Node headers for Unicode filenames. Unmarked legacy uploads remain literal, including %20. File bytes, routes, authorization, SQL, storage, retention and cleanup stay owned by the original DB6 implementation.
- Regressions cover spaces, %, literal %20, Vietnamese, Chinese, emoji, decoded filename limits, malformed headers, legacy clients, metadata search and download bytes. The actual API entry point also passes a temporary-storage Unicode smoke test.
- The four MessageList.actions failures were outdated expectations for Delete/ownership and synchronous edit completion. Tests now exercise Delete for me, the existing Unsend dialog, keyboard/disabled behavior and the async edit lifecycle. MessageList.tsx was not changed.
- Ignore rules now protect local env/credentials, database sidecars/journals, generated build metadata and temporary test/upload data. Environment examples remain available. The server lockfile is an intentional reproducibility input; the client lockfile policy is unchanged.
- Calling/LiveKit/attachment status documentation now distinguishes implemented modules, explicit demo previews and missing production service adapters. Historical validation reports link here instead of presenting their old failures as current.

## Validation

| Check | Result |
| --- | --- |
| Full backend npm test, including DB5/DB6 CommonJS regression | 401 passed, 0 failed, 0 skipped |
| Focused attachment/DB5/DB6 regression command | 14 passed (included in the full backend coverage) |
| Full client Jest, runInBand, no cache, 20-second test timeout | 853 passed, 0 failed; 81 suites passed |
| Server TypeScript | Passed |
| Client TypeScript, noEmit, incremental false | Passed |
| Client lint, no cache | Passed, no warnings/errors |
| Production Next.js build | Passed |
| Development calling Next proxy check | Passed with real HTTP/Socket.IO and a LiveKit protocol double |
| API entry-point Unicode store/search/download smoke | Passed with isolated SQLite/private storage |
| Ignore-rule cases | 21/21 passed, including examples and server lockfile |
| Dependency manifest/lock consistency | Passed; server runtime dependencies resolve |
| Candidate audit | 72 files accounted for; no credential patterns, conflict markers, broken local documentation links or unexpected generated files found |
| Preservation/index check | Database/Security business implementations and MessageList runtime unchanged; index empty; diff check passed |

Both shared calling contracts are present in the candidates below and remain untracked until later authorized staging. Database and Security business implementation files are preserved. The only Database host change is composition of the transport wrapper in server/api-main.cjs.

## Local commands

```powershell
npm.cmd --prefix server run type-check
npm.cmd --prefix server test
npm.cmd --prefix server run test:attachments
npm.cmd --prefix server run test:dev-calls-proxy
npm.cmd --prefix client run type-check -- --incremental false
npm.cmd --prefix client run lint -- --no-cache
npm.cmd --prefix client test -- --runInBand --no-cache --testTimeout=20000
npm.cmd --prefix client run build
```

Run the proxy check and production build without another Next process sharing their generated output. Test databases/private files are temporary; the smoke test does not use production credentials or data.

## Remaining deployment requirements

- Real production session, conversation/membership/block, CSRF and voice policy adapters are still required. The development calling harness remains loopback-only and refuses production startup.
- Configure same-origin DB6/token routing, authoritative group/recipient targets and server-only LiveKit credentials before enabling readiness flags. The existing realtime message store and recipient-key integration are also required for remote encrypted messaging.
- Actual two-browser audio/video, screen sharing, devices and TURN/network behavior remain unverified against a real LiveKit deployment. SDK/protocol fixtures and successful token signing do not establish media transmission.
- Call state remains single-process and ephemeral. No distributed locking or durable call-history feature is claimed.
- Existing rows written by the old encoded-name uploader are not migrated automatically. Any needed data correction belongs to an explicit Database-owner migration.

## Candidate handling

No actual local environment files, dependency trees, Next output, raw logs, private uploads, database sidecars or temporary browser profiles belong in these commits. The server lockfile is deliberately included. Existing already-tracked Database snapshots/logs and client build metadata are unchanged; ignore rules do not untrack history, and no index cleanup or local data deletion was performed.

## Exact recommended commit groups

Split shared-file hunks instead of staging server/package.json or server/test/integration/standalone.test.ts wholesale in an early commit. Every pending candidate is assigned below; both shared contracts and the server lockfile are explicit.

### 1. fix(shared): include calling wire contracts

- `shared/directCalls.ts`
- `shared/livekit.ts`

- Both shared contracts are present and unignored; already committed client modules require them. Include both before dependent backend changes. shared/package.json is already tracked.

### 2. test(messenger): align action tests with existing menu behavior

- `client/src/components/messenger/__tests__/MessageList.actions.test.tsx`

- The four failures were stale Delete/ownership assertions and an async edit-timing assumption, not regressions in MessageList.tsx.
- Assert incoming Delete for me, outgoing Unsend confirmation, keyboard/disabled behavior, and completion of the asynchronous edit. Production renderer behavior remains unchanged.

### 3. feat(calls): add authenticated direct-call signaling

- `server/src/calls/config.ts`
- `server/src/calls/index.ts`
- `server/src/calls/protocol.ts`
- `server/src/calls/router.ts`
- `server/src/calls/validation.ts`
- `server/src/realtime/config.ts`
- `server/src/realtime/protocol.ts`
- `server/src/realtime/server.ts`
- `server/test/integration/direct-call-client.test.ts`
- `server/test/integration/direct-calls.test.ts`
- `server/test/support/callFixtures.ts`

- Select only the ./calls export hunk in server/package.json. Keep the call media lifecycle interfaces here; the LiveKit implementation follows in commit 4.

### 4. feat(livekit): add authorized media tokens and room lifecycle

- `server/src/livekit/config.ts`
- `server/src/livekit/directCalls.ts`
- `server/src/livekit/http.ts`
- `server/src/livekit/index.ts`
- `server/src/main.ts`
- `server/.env.example`
- `server/test/integration/direct-call-media.test.ts`
- `server/test/integration/livekit.test.ts`

- Select the ./livekit export and livekit-server-sdk dependency hunks in server/package.json.
- Select only the voice-token assertion hunk in server/test/integration/standalone.test.ts; the attachment-route loop belongs in commit 5.

### 5. feat(attachments): integrate the client with canonical DB6 storage

- `.gitignore`
- `client/.env.example`
- `client/src/components/YahooChatWindow.tsx`
- `client/src/components/YahooChatWindow.attachments.test.tsx`
- `client/src/components/messenger/AttachmentDownloadLink.tsx`
- `client/src/components/messenger/AttachmentPreviewDialog.tsx`
- `client/src/components/messenger/MessageAttachmentView.tsx`
- `client/src/components/messenger/MessengerApp.tsx`
- `client/src/components/messenger/__tests__/MessageAttachmentView.test.tsx`
- `client/src/components/messenger/__tests__/MessageComposer.attachments.test.tsx`
- `client/src/hooks/useAttachmentSource.ts`
- `client/src/hooks/__tests__/useAttachmentSource.test.tsx`
- `client/src/hooks/__tests__/useConversationMessages.test.tsx`
- `client/src/messaging/attachmentDownload.ts`
- `client/src/messaging/attachmentUpload.ts`
- `client/src/messaging/db6Attachments.ts`
- `client/src/messaging/__tests__/attachmentContent.test.ts`
- `client/src/messaging/__tests__/attachmentUpload.test.ts`
- `shared/attachmentPolicy.ts`
- `server/test/integration/attachments.test.ts`
- `server/api-main.cjs`
- `server/src/attachments/db6Transport.ts`
- `server/package-lock.json`

- Also select the express/better-sqlite3 dependencies, start:api, test:attachments, test:db5db6 and default CommonJS test glob in server/package.json.
- Select only the attachment-route 404 assertion loop in server/test/integration/standalone.test.ts.
- Include the complete .gitignore changes here; they allow the server lockfile while excluding local credentials, sidecars, build metadata and temporary data.
- The new transport owns no routes or persistence: it wraps the existing DB6 API, decodes explicit percent-utf8 names once and formats UTF-8 download headers.
- DB5/DB6 SQL, routers, schema, storage, retention and Security implementation files are already in main and are not included in this commit.

### 6. dev(calls): add isolated authenticated calling harness

- `server/dev/calling/.env.example`
- `server/dev/calling/README.md`
- `server/dev/calling/adapters.ts`
- `server/dev/calling/config.ts`
- `server/dev/calling/livekitStatus.ts`
- `server/dev/calling/main.ts`
- `server/dev/calling/server.ts`
- `server/test/integration/development-calling-harness.test.ts`
- `server/test/manual/development-calling-proxy.check.ts`
- `server/tsconfig.json`

- Select the dev:calls and test:dev-calls-proxy scripts in server/package.json.
- Client development calling UI, the Next proxy helper and its environment example are already committed; no duplicate files are required.

### 7. docs(fullstack): document current contracts, readiness and validation

- `README.md`
- `server/README.md`
- `docs/realtime-server-integration.md`
- `docs/attachments.md`
- `docs/calling-validation.md`
- `docs/development-calling-validation.md`
- `docs/direct-call-media.md`
- `docs/direct-call-signaling.md`
- `docs/direct-calls.md`
- `docs/livekit.md`
- `artifacts/advanced-attachments/browser-results.json`
- `artifacts/advanced-attachments/desktop.png`
- `artifacts/advanced-attachments/mobile.png`
- `artifacts/advanced-attachments/pdf-preview.png`
- `docs/fullstack-push-readiness.md`

- Include current implementation descriptions and the historical-validation banners. Historical counts remain attached to their original dates; current results are recorded in this document.
- The four artifacts are curated local-demo QA evidence linked from docs/attachments.md, not runtime files. They contain demo UI and test content. Keep raw browser profiles, logs and generated builds outside Git.
