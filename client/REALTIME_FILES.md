# Authenticated realtime — task-owned files

Compared with the saved pre-edit content snapshot and the tracked file state. Existing work from earlier phases is preserved. All 28 deliverable paths are under `client/`.

```text
client/E2EE_CLIENT_INTEGRATION.md
client/E2EE_KIRO_HANDOFF.md
client/REALTIME_CLIENT_INTEGRATION.md
client/REALTIME_FILES.md
client/artifacts/client-realtime/browser-evidence.json
client/artifacts/client-realtime/midnight-mobile-redacted.png
client/artifacts/client-realtime/mobile-redacted.png
client/artifacts/client-realtime/verification.json
client/authProxy.cjs
client/next.config.js
client/package.json
client/scripts/verify-client-realtime.cjs
client/src/api/__tests__/sessionApi.test.ts
client/src/api/sessionApi.ts
client/src/auth/__tests__/realtimeProxy.test.ts
client/src/auth/httpAuthService.ts
client/src/components/messenger/RealMessengerWorkspace.tsx
client/src/components/messenger/SecureConversationPanel.module.css
client/src/components/messenger/SecureConversationPanel.tsx
client/src/realtime/AuthenticatedSocketIoClient.ts
client/src/realtime/SecureRealtimeWorkspace.ts
client/src/realtime/SocketIoRealtimeClient.ts
client/src/realtime/__tests__/AuthenticatedSocketIoClient.test.ts
client/src/realtime/__tests__/SecureRealtimeWorkspace.test.ts
client/src/realtime/authenticatedProtocol.ts
client/src/realtime/testing/authenticatedFixtures.ts
client/src/security/e2ee/__tests__/backend.test.ts
client/src/security/e2ee/session.ts
```

Ignored disposable fixtures, isolated build directories, Chrome state, generated isolated TypeScript configs and temporary test reports are excluded. The pre-existing main `tsconfig.json` is untouched (its modification timestamp predates this task); its original dirty status is retained. The generated TypeScript cache is restored from its saved byte-for-byte backup after verification. No Git mutation is performed.

See [integration and Kiro handoff](REALTIME_CLIENT_INTEGRATION.md), [verification](artifacts/client-realtime/verification.json) and [browser evidence](artifacts/client-realtime/browser-evidence.json).
