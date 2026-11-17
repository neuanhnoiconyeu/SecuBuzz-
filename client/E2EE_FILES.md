# Client E2EE — exact task paths

Compared against the pre-edit worktree snapshot, rather than the combined diff of earlier phases.
All paths are under client. Isolated databases, Chrome profiles, build output and type-config caches are ignored test artifacts, not source deliverables. The originally clean tracked TypeScript cache and main tsconfig were restored after verification.

```text
client/.gitignore
client/E2EE_CLIENT_INTEGRATION.md
client/E2EE_FILES.md
client/E2EE_KIRO_HANDOFF.md
client/artifacts/client-e2ee/browser-evidence.json
client/artifacts/client-e2ee/midnight-mobile-redacted.png
client/artifacts/client-e2ee/mobile-redacted.png
client/artifacts/client-e2ee/verification.json
client/authProxy.cjs
client/next.config.js
client/package-lock.json
client/package.json
client/scripts/e2ee-build-config.cjs
client/scripts/verify-client-build.cjs
client/scripts/verify-client-e2ee.cjs
client/src/api/sessionApi.ts
client/src/auth/__tests__/messagingProxy.test.ts
client/src/auth/__tests__/workspaceIntegration.test.tsx
client/src/auth/httpAuthService.ts
client/src/components/messenger/RealMessengerWorkspace.tsx
client/src/components/messenger/SecureConversationPanel.module.css
client/src/components/messenger/SecureConversationPanel.tsx
client/src/security/e2ee/__tests__/backend.test.ts
client/src/security/e2ee/__tests__/protocol.test.ts
client/src/security/e2ee/__tests__/storage.test.ts
client/src/security/e2ee/api.ts
client/src/security/e2ee/devices.ts
client/src/security/e2ee/hpke.ts
client/src/security/e2ee/messages.ts
client/src/security/e2ee/model.ts
client/src/security/e2ee/protocol.ts
client/src/security/e2ee/session.ts
client/src/security/e2ee/storage.ts
```

Hashes, checks and ownership evidence: [verification manifest](artifacts/client-e2ee/verification.json).
Architecture, storage schema, commands, trust/recovery limits and test evidence: [integration handoff](E2EE_CLIENT_INTEGRATION.md).
Socket requirements: [Kiro handoff](E2EE_KIRO_HANDOFF.md).
