# Requirements: Phase 9B — Gemini backend for @Secu

## Introduction

Phase 9A delivered the AI Hub and @Secu with an offline demo provider and a provider-neutral client contract (`client/src/ai/aiModel.ts`). Phase 9B adds a real model behind that contract: Google Gemini (`gemini-3.5-flash-lite`) on the free tier, reached only through an authenticated SecuBuzz backend API.

The phase must cost $0, must not send private Messenger content to a provider whose free-tier terms allow Google to use submitted data, and must fail closed wherever a dependency owned by another team is missing. Today that includes production sessions, CSRF verification and a durable quota store, so the feature is expected to ship disabled (`AI_REMOTE_ENABLED=false`) with a complete, tested implementation behind the boundary.

Scope owned by Kiro in this phase: `server/src/ai/`, its tests, the remote client adapter, minimal wiring in the Phase 9A client, documentation and this spec. Out of scope: Database Team code (`server/src/database/`, `server/src/middleware/`, `DATA/`, auth and sessions), realtime code and contracts (`server/src/realtime/`), AI Hub and Messenger visual design (Codex).

## Glossary

- **AI API**: the SecuBuzz backend endpoints under `/api/ai` implemented by `server/src/ai/http.ts`.
- **Provider**: the Gemini Developer API `generateContent` endpoint.
- **Free tier / Unpaid Services**: Gemini API usage through a Google Cloud project without an active billing account. Google may use submitted content and responses to improve its products, and human reviewers may read them.
- **Session resolver**: the Database Team's `SessionResolver` (`server/src/realtime/contracts.ts`), shared with the realtime server.
- **CSRF verifier**: the Database Team's `AiCsrfVerifier`, which checks the `X-CSRF-Token` header against the authenticated session.
- **Usage store**: an `AiUsageStore` that atomically reserves request capacity and consumes consent nonces. `durable` stores are shared and survive restarts; the `memory` store is for explicit local development only.
- **Consent token**: a short-lived HMAC token issued by `POST /api/ai/consent`, bound to the session, the payload digest and the disclosure version, usable once.
- **Payload digest**: base64url SHA-256 over a fixed JSON array of the request fields (design §6.2), computed identically by client and server.
- **Messenger content**: any message, draft, history or conversation context from Messenger. Requests carrying `conversationId` are Messenger content.
- **Quota scope**: the identifier of one Google Cloud project's quota bucket (`AI_QUOTA_SCOPE`) combined with the model.
- **Breaker**: the in-process circuit breaker that stops provider calls after a provider rate-limit or configuration failure.

## Requirements

### Requirement 1: Backend-only provider access and key custody

**User Story:** As a SecuBuzz operator, I want the Gemini key to stay on the server, so that no browser, bundle or log can expose it.

#### Acceptance Criteria

1. THE System SHALL call the Provider only from server code in `server/src/ai/`.
2. THE System SHALL read the key only from the server environment variable `GEMINI_API_KEY` and send it only in the `x-goog-api-key` header to `https://generativelanguage.googleapis.com`.
3. WHEN any `NEXT_PUBLIC_*` variable name contains `GEMINI`, or any `NEXT_PUBLIC_*` value equals the configured key, THE System SHALL refuse to load the AI configuration.
4. THE System SHALL keep the key in a private field that is excluded from `JSON.stringify`, `util.inspect`, log fields, error messages and API responses.
5. THE client SHALL contain no Provider URL, key variable or `x-goog-api-key` header, and SHALL call only same-origin `/api/ai/*` endpoints.

### Requirement 2: Validated configuration, disabled by default

**User Story:** As an operator, I want explicit, validated settings, so that a typo cannot silently enable spending, another model or another provider.

#### Acceptance Criteria

1. THE System SHALL enable remote AI only WHEN `AI_REMOTE_ENABLED` is exactly `true`; any other value SHALL mean disabled.
2. WHEN `AI_PROVIDER` is set to a value other than `gemini`, THE System SHALL reject the configuration.
3. WHEN `GEMINI_MODEL` is set to a value other than `gemini-3.5-flash-lite`, THE System SHALL reject the configuration, and SHALL NOT select another model automatically.
4. WHEN remote AI is enabled and the key is missing, empty, contains whitespace or exceeds 512 characters, THE System SHALL reject the configuration.
5. WHEN remote AI is enabled, THE System SHALL require `AI_PROJECT_RPM` and `AI_PROJECT_RPD` and SHALL NOT supply defaults for them.
6. THE System SHALL validate `AI_USER_RPM`, `AI_USER_RPD`, `AI_MAX_CONCURRENT`, `AI_MAX_INPUT_CHARS`, `AI_MAX_OUTPUT_TOKENS`, `AI_TIMEOUT_MS`, `AI_QUOTA_SCOPE`, `AI_ALLOWED_ORIGINS`, `AI_SESSION_COOKIE` and `AI_CONSENT_SECRET` as integers, identifiers or origins within documented ranges.
7. WHEN `AI_LOCAL_DEV_MEMORY_QUOTA=true` and `NODE_ENV=production`, THE System SHALL reject the configuration.
8. WHEN remote AI is enabled in production without an `AI_CONSENT_SECRET` of at least 32 characters, THE System SHALL reject the configuration.
9. WHEN remote AI is enabled and `NODE_TLS_REJECT_UNAUTHORIZED=0`, THE System SHALL reject the configuration.
10. THE System SHALL provide `npm run ai:check-config`, which loads `server/.env`, prints a sanitized report without the key or its prefix, and makes no network request.

### Requirement 3: Authentication and request integrity

**User Story:** As a user, I want @Secu requests to run only for my authenticated session, so that nobody can spend the project quota or act as me.

#### Acceptance Criteria

1. THE System SHALL authenticate every AI API request from the configured session cookie through the Session resolver, and SHALL never take a user identity from the request body or headers.
2. WHEN the cookie is absent or malformed, or the resolver returns `missing`, `invalid` or `expired`, or the session has expired, or the user is a reserved demo identity, THE System SHALL respond `AI_AUTH_REQUIRED` (401).
3. WHEN no Session resolver, CSRF verifier or usage store is configured, THE System SHALL respond `AI_NOT_CONFIGURED` (503) without calling the Provider.
4. WHEN the resolver or CSRF verifier throws, times out or returns a malformed result, THE System SHALL respond `AI_SERVICE_UNAVAILABLE` (503).
5. WHEN the `Origin` header is absent or not in the exact allowlist, THE System SHALL respond `AI_FORBIDDEN` (403).
6. WHEN the `X-CSRF-Token` header is absent, malformed or not verified for the session, THE System SHALL respond `AI_FORBIDDEN` (403).
7. THE System SHALL accept only `POST` with `Content-Type: application/json` (UTF-8, no content encoding) and a body of at most 64 KiB received within 10 seconds.

### Requirement 4: Privacy restrictions for the free tier

**User Story:** As a Messenger user, I want my private conversations kept away from a provider that may use submitted data, so that using @Secu never exposes them.

#### Acceptance Criteria

1. WHEN a request includes `conversationId`, THE System SHALL respond `AI_PRIVACY_RESTRICTED` (403) and SHALL NOT call the Provider.
2. WHEN the input matches a credential pattern (private keys, JWTs, Google/AWS/GitHub/Slack/Stripe/OpenAI-style keys, bearer tokens, password assignments, the SecuBuzz session cookie, AES-256-GCM message envelopes, private JWKs), THE System SHALL respond `AI_PRIVACY_RESTRICTED` and SHALL NOT call the Provider.
3. THE System SHALL never trust a client `isDemo` flag or any client claim that content is safe to send.
4. WHILE the configured provider is the free-tier Gemini provider, THE client SHALL NOT offer Messenger AI actions (Ask, Summarize, Translate, Explain selected message, Rewrite draft) and SHALL refuse requests carrying `conversationId` before any network call.
5. THE System SHALL NOT log, persist or echo submitted text, prompts or outputs.

### Requirement 5: Server-enforced consent

**User Story:** As a user, I want each submission to require my explicit agreement to the current disclosure, so that text is never sent to Google without my knowledge.

#### Acceptance Criteria

1. THE client SHALL show the disclosure "This request sends the submitted text to Google Gemini for processing. Free-tier data may be used by Google to improve its products, and human reviewers may read it. Do not submit private messages, passwords, or confidential information." next to an unchecked consent control before any remote submission.
2. WHEN the user submits with consent, THE client SHALL obtain a consent token from `POST /api/ai/consent` for the exact payload digest and disclosure version, and THEN send the request with that token.
3. WHEN the disclosure version is not the server's current version, THE System SHALL respond `AI_CONSENT_REQUIRED` (403).
4. WHEN a request has no consent token, or the token is malformed, forged, expired (older than 60 seconds), bound to another session, bound to another payload or disclosure version, or already used, THE System SHALL respond `AI_CONSENT_REQUIRED` and SHALL NOT call the Provider.
5. THE System SHALL consume each consent token at most once across all processes that share a usage store.

### Requirement 6: API contract and input validation

**User Story:** As a client developer, I want a strict, documented contract, so that the client and server reject the same malformed input.

#### Acceptance Criteria

1. THE System SHALL expose exactly `POST /api/ai/consent` and `POST /api/ai/requests` under a configurable base path (default `/api/ai`), responding `AI_NOT_FOUND` (404) and `AI_METHOD_NOT_ALLOWED` (405) otherwise.
2. THE System SHALL accept only the documented keys: consent `{ disclosureVersion, payloadDigest }`; request `{ request: { task, input, tone?, targetLanguage?, conversationId? }, consentToken }`.
3. THE System SHALL accept the tasks `chat`, `summarize`, `rewrite` (tones Friendly, Professional, Concise), `translate` (Spanish, French, Vietnamese), `action_items` and `explain`, with `tone` only for `rewrite` and `targetLanguage` only for `translate`.
4. WHEN `input` is empty, whitespace only, contains NUL, other C0 controls except tab/newline/carriage return, DEL, or unpaired surrogates, THE System SHALL respond `AI_INVALID_REQUEST` (400).
5. WHEN `input` exceeds `AI_MAX_INPUT_CHARS` UTF-16 code units (default and maximum 8,000), THE System SHALL respond `AI_INPUT_TOO_LARGE` (413).
6. WHEN the request succeeds, THE System SHALL respond 200 `{ "output": string, "kind": "answer" }` with at most 12,000 characters of trimmed plain text.
7. THE System SHALL send `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a JSON content type on every response.

### Requirement 7: Task prompts and prompt-injection resistance

**User Story:** As a user, I want each tool to do only its job, so that text I paste cannot take over the assistant.

#### Acceptance Criteria

1. THE System SHALL send a fixed per-task system instruction and the user text as data between per-request random markers `BEGIN_USER_TEXT_<nonce>` and `END_USER_TEXT_<nonce>`.
2. THE System SHALL instruct the model to ignore instructions inside the user text, not to reveal its instructions, and to answer in plain text.
3. THE System SHALL instruct `action_items` to report only tasks, owners and deadlines stated in the text, using "Not stated" rather than inventing values.
4. THE System SHALL send no tools, function declarations, files, URLs or conversation history, and only the latest user input for chat.
5. THE System SHALL treat model output as untrusted plain text; the client SHALL render it as React text.

### Requirement 8: Gemini adapter behavior

**User Story:** As an operator, I want one bounded provider call per accepted request, so that failures never multiply usage.

#### Acceptance Criteria

1. THE System SHALL call `POST /v1beta/models/gemini-3.5-flash-lite:generateContent` once per accepted request with `systemInstruction`, one user `contents` entry and `generationConfig.maxOutputTokens`, and SHALL NOT set sampling parameters, candidate count, tools, service tier or safety overrides.
2. THE System SHALL NOT retry a failed provider call, SHALL NOT continue truncated output, and SHALL NOT fall back to another model, provider, key or the demo.
3. THE System SHALL abort the provider call after `AI_TIMEOUT_MS` (1,000–14,000 ms, below the client's 15-second deadline) and WHEN the client disconnects.
4. THE System SHALL reject provider redirects and read at most 512 KiB of provider response.
5. THE System SHALL map provider outcomes to AI API errors as specified in design §9, including 429 per-day quota to `AI_DAILY_QUOTA_EXHAUSTED`, other 429 to `AI_RATE_LIMITED`, safety blocks to `AI_PROVIDER_REJECTED`, `MAX_TOKENS` to `AI_INVALID_RESPONSE`, and network or TLS failures to `AI_PROVIDER_UNAVAILABLE`.

### Requirement 9: Zero cost and quota protection

**User Story:** As the project owner, I want hard usage limits enforced before Google sees a request, so that SecuBuzz stays within the free tier.

#### Acceptance Criteria

1. THE System SHALL allow at most one active request per user and at most `AI_MAX_CONCURRENT` active requests per quota scope.
2. THE System SHALL enforce per-user and per-quota-scope requests per sliding minute and per Pacific-time day, reserving capacity atomically before the provider call and never refunding it.
3. WHEN a limit is reached, THE System SHALL respond `AI_RATE_LIMITED` or `AI_DAILY_QUOTA_EXHAUSTED` (429) with `Retry-After` and SHALL NOT call the Provider.
4. WHEN the Provider returns 429, THE System SHALL open the breaker for the provider's retry delay (or until the next Pacific midnight for daily quota) and reject further requests without calling the Provider.
5. WHEN the Provider reports an invalid key, permission, billing, model-availability or precondition failure, THE System SHALL open the breaker for 5 minutes.
6. THE System SHALL use the memory store only WHEN `AI_LOCAL_DEV_MEMORY_QUOTA=true` outside production, and SHALL refuse a `memory` store in production.
7. THE System SHALL make no background, scheduled, health-check or retry calls to the Provider.
8. THE documentation SHALL state that the $0 guarantee depends on the Google Cloud project having no active billing account, and SHALL NOT state Gemini 3.5 Flash-Lite quota numbers that were not verified in AI Studio.

### Requirement 10: Failure handling and error codes

**User Story:** As a user, I want clear, safe messages when @Secu cannot help, so that I know whether to wait, rephrase or sign in.

#### Acceptance Criteria

1. THE System SHALL respond with `{ "error": { "code", "message" } }` using only the codes in design §8 and their fixed messages.
2. THE System SHALL never include provider messages, stack traces, keys, tokens, cookies or user text in error responses or logs.
3. THE client SHALL map AI API codes to Phase 9A error codes plus `privacy_restricted`, `rate_limited`, `quota_exhausted`, `provider_unavailable`, `auth_required` and `declined`, with fixed messages including "@Secu is temporarily unavailable.", "@Secu has reached its free AI usage limit." and "This content cannot be sent to the current AI provider because of SecuBuzz's privacy restrictions."
4. THE client SHALL never fall back to the demo provider after a remote failure.

### Requirement 11: Observability without content

**User Story:** As an operator, I want enough telemetry to diagnose quota, TLS and provider problems, so that I never need to log user text.

#### Acceptance Criteria

1. THE System SHALL log JSON lines with event names, error codes, reason codes, durations, provider HTTP status, allowlisted provider status tokens, network error codes and token counts only.
2. THE System SHALL NOT log user IDs, session IDs, cookies, CSRF or consent tokens, keys, prompts, inputs or outputs.

### Requirement 12: TLS

**User Story:** As a developer behind antivirus HTTPS inspection, I want verified TLS without disabling security, so that local testing works safely.

#### Acceptance Criteria

1. THE System SHALL use Node's default certificate verification and SHALL support `node --use-system-ca` for operating-system trust stores.
2. THE System SHALL NOT disable certificate verification, install insecure agents or modify trust stores.
3. THE documentation SHALL explain that Avast Web/Mail Shield re-signs HTTPS traffic and can inspect requests to Google when the system CA store is trusted.

### Requirement 13: Client integration

**User Story:** As a signed-in user, I want the existing AI Hub to use the backend when it is approved, so that the interface stays familiar.

#### Acceptance Criteria

1. THE client SHALL select the remote provider only WHEN the session is not a demo session AND `NEXT_PUBLIC_AUTH_MODE=api` AND `NEXT_PUBLIC_AUTH_API_READY=true` AND `NEXT_PUBLIC_AI_REMOTE_READY=true`; otherwise it SHALL keep the Phase 9A demo or unavailable behavior.
2. THE remote provider SHALL send same-origin, credentialed, no-store requests with `redirect: 'error'` and the CSRF token from `meta[name="secubuzz-csrf-token"]`, and SHALL fail closed without a token.
3. THE client SHALL keep the Phase 9A layout, per-request consent checkbox, cancellation, 15-second deadline and three-attempt manual retry limit.

### Requirement 14: Testing without live calls

**User Story:** As a maintainer, I want the whole feature verified with mocks, so that tests and CI can never spend quota or leak data.

#### Acceptance Criteria

1. THE tests SHALL use injected mock `fetch` implementations and SHALL fail if any test reaches a non-loopback URL.
2. THE tests SHALL cover configuration, authentication, CSRF and origin, consent, privacy, validation, every mapped provider status, timeout, cancellation, empty, safety-blocked and invalid responses, quota concurrency, minute and daily limits, restart and multi-worker behavior with a shared store, no retry, no fallback, and Phase 9A regressions.
3. THE tests SHALL verify client/server parity of the disclosure and payload digest by loading the client adapter.
4. THE final report SHALL NOT describe a mocked end-to-end test as a live Gemini integration.

### Requirement 15: Deployment and acceptance

**User Story:** As the integrating teams, I want explicit handoffs and a clear verdict, so that remote AI is enabled only when every dependency exists.

#### Acceptance Criteria

1. THE System SHALL be mountable by the Database Team's API server as `createAiHttpHandler` from `secubuzz-realtime-server/ai` without changes to `server/src/main.ts`, `server/src/index.ts` or realtime code.
2. THE documentation SHALL list the Database Team dependencies (Session resolver, CSRF verifier and bootstrap, durable usage store, cookie and proxy settings) and the Codex handoff items.
3. THE phase SHALL be accepted as READY only WHEN production authentication, CSRF verification and a durable shared usage store exist and the project quota is verified in AI Studio; otherwise the verdict SHALL be BLOCKED with the implementation shipped disabled.
