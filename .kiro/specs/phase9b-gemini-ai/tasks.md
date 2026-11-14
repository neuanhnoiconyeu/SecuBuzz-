# Tasks: Phase 9B — Gemini backend for @Secu

Items are checked only after their tests pass. No task makes a live Gemini call or changes `AI_REMOTE_ENABLED=false`.

- [x] 1. Protocol and configuration
  - [x] 1.1 `server/src/ai/protocol.ts`: tasks, tones, languages, limits, error codes with HTTP status and fixed messages
    - _Requirements: 6.3, 6.6, 10.1_
  - [x] 1.2 `server/src/ai/config.ts`: `loadAiConfig(env)` with private key and consent secret, enable only on exact `true`, provider/model allowlist, required project limits, ranges, origins, cookie name, memory-quota and production rules, `NEXT_PUBLIC_*` and TLS refusals
    - _Requirements: 1.2, 1.3, 1.4, 2.1–2.9, 12.2_
  - [x] 1.3 `server/src/ai/configReport.ts`, `server/src/ai/checkConfig.ts` and `npm run ai:check-config` (sanitized, no network)
    - _Requirements: 2.10_
  - [x] 1.4 Unit tests for configuration and the report (`server/test/ai/config.test.ts`)
    - _Requirements: 14.2_

- [x] 2. Validation, privacy and consent
  - [x] 2.1 `server/src/ai/validation.ts`: exact keys, task options, text rules, input size
    - _Requirements: 6.2–6.5_
  - [x] 2.2 `server/src/ai/privacy.ts`: Messenger context and credential patterns
    - _Requirements: 4.1, 4.2, 4.3_
  - [x] 2.3 `server/src/ai/consent.ts`: disclosure, payload digest, HMAC token issue and verify
    - _Requirements: 5.3, 5.4_
  - [x] 2.4 Unit tests for validation, privacy and consent (`server/test/ai/request-rules.test.ts`)
    - _Requirements: 14.2_

- [x] 3. Usage limits
  - [x] 3.1 `server/src/ai/usage.ts`: `AiUsageStore` contract, `MemoryAiUsageStore`, Pacific day helpers, breaker
    - _Requirements: 9.1–9.6_
  - [x] 3.2 Reusable store contract tests (`server/test/ai/support/usageStoreContract.ts`), run against the memory store and a shared durable-semantics double (`server/test/ai/usage.test.ts`)
    - _Requirements: 9.1, 9.2, 5.5, 14.2_

- [x] 4. Gemini provider
  - [x] 4.1 `server/src/ai/prompts.ts`: per-task system instructions and delimited user text
    - _Requirements: 7.1–7.4_
  - [x] 4.2 `server/src/ai/gemini.ts`: one `generateContent` call, timeout, abort, redirect refusal, bounded body, outcome mapping
    - _Requirements: 8.1–8.5_
  - [x] 4.3 Adapter and prompt tests with mock `fetch` for every mapped status and response shape (`server/test/ai/gemini.test.ts`)
    - _Requirements: 8.2, 8.5, 14.1, 14.2_

- [x] 5. Service and HTTP handler
  - [x] 5.1 `server/src/ai/service.ts`: validate → privacy → breaker → consent → reserve → provider → release → output
    - _Requirements: 4, 5, 8, 9_
  - [x] 5.2 `server/src/ai/http.ts`: `createAiHttpHandler` routing, enablement, configuration, origin, content type, session, CSRF, body limits, headers, disconnect abort
    - _Requirements: 3.1–3.7, 6.1, 6.7_
  - [x] 5.3 `server/src/ai/index.ts` and the `./ai` package export
    - _Requirements: 15.1_
  - [x] 5.4 HTTP integration tests: authentication, CSRF, origin, body limits, consent, privacy, quotas, concurrency, restart and multi-worker with a shared test store, disconnect, log hygiene (`server/test/ai/http.test.ts`)
    - _Requirements: 3, 4, 5, 9, 11, 14_
  - [x] 5.5 Boundary tests: AI exports, fetch trap, no Google URL or key variable in client sources (`server/test/ai/boundaries.test.ts`)
    - _Requirements: 1.5, 14.1_

- [x] 6. Client integration
  - [x] 6.1 `client/src/ai/aiModel.ts`: new error codes, messages, retryability, optional provider capabilities
    - _Requirements: 10.3_
  - [x] 6.2 `client/src/ai/remoteAIProvider.ts`: consent then request, CSRF, same-origin fetch options, strict parsing, error mapping
    - _Requirements: 4.4, 5.2, 10.3, 10.4, 13.2_
  - [x] 6.3 `createAIProvider` remote selection under explicit flags; `client/.env.example`
    - _Requirements: 13.1_
  - [x] 6.4 `AIHub` disclosure; `MessengerApp` omits Messenger AI handoffs when the provider refuses Messenger content
    - _Requirements: 4.4, 5.1, 13.3_
  - [x] 6.5 Client tests: remote provider, factory, AI Hub with a mocked backend, hidden Messenger actions
    - _Requirements: 14.2_
  - [x] 6.6 Server-side parity and mocked end-to-end test that loads the client adapter (`server/test/ai/client-parity.test.ts`)
    - _Requirements: 14.3, 14.4_

- [x] 7. Documentation
  - [x] 7.1 `docs/phase9b-gemini-integration.md`
    - _Requirements: 9.8, 12.3, 15.2_
  - [x] 7.2 `server/.env.example` and `server/README.md` updates
    - _Requirements: 2, 15.2_

- [x] 8. Verification
  - [x] 8.1 Server `npm run type-check` and `npm test` (334 passed)
  - [x] 8.2 Client `npm run type-check`, `npm run lint`, `npm test`, `npm run build` (679 passed; build passed)
  - [x] 8.3 Browser verification with a mocked backend (desktop, tablet, mobile × Light, Dark, System): 421 of 421 assertions
  - [x] 8.4 `git diff --check`, temporary files removed, git status equals the baseline plus Phase 9B files, stash untouched

Live use stays blocked on Requirement 15.3: production authentication, CSRF verification, a durable shared usage store and a verified project quota.
