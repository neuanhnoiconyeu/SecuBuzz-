# Phase 9B — Gemini backend for @Secu

Implemented on `chuong-fullstack` at `4578429` (uncommitted). Kiro spec: [.kiro/specs/phase9b-gemini-ai/](../.kiro/specs/phase9b-gemini-ai/).

## 1. Implementation summary

Phase 9B adds a real model behind the Phase 9A AI Hub: Google Gemini `gemini-3.5-flash-lite` on the free tier, reached only through an authenticated SecuBuzz API. The browser talks to same-origin `/api/ai/*` endpoints; only the server holds the key and calls Google.

What exists now:

- `server/src/ai/`: a mountable HTTP handler (`createAiHttpHandler`) with validated configuration, session and CSRF checks, strict request validation, privacy restrictions, server-enforced consent tokens, per-user and per-project quotas, a circuit breaker and a single-call Gemini adapter.
- `client/src/ai/remoteAIProvider.ts`: a provider for the existing `AIProvider` contract. AI Hub shows the Gemini disclosure next to the existing per-request consent checkbox. Messenger hides its AI handoffs while this provider is active.
- 137 new server tests, 55 new client tests and a real-Chrome run of 421 assertions, all against mocks.

What does not exist: a running API server that mounts the handler, a production `SessionResolver`, a CSRF verifier, a durable usage store, and a real-account workspace that shows AI Hub. Those belong to the Database Team (and the workspace integration). Until they exist the handler answers `AI_NOT_CONFIGURED`, and `AI_REMOTE_ENABLED` stays `false`.

No Gemini request was made in this phase. The only live calls were the two approved preflights before it (section 5).

## 2. Architecture

```
AI Hub ─ useAIWorkspace ─ executeAIRequest (consent tick, 15 s deadline, strict response check)
   └─ RemoteAIProvider ── POST /api/ai/consent ─┐   same origin, session cookie,
                       └─ POST /api/ai/requests ┤   X-CSRF-Token, no-store, redirect: error
                                                ▼
        createAiHttpHandler (Database Team API process)
          route → enabled → configured → Origin → JSON → session → CSRF → body (64 KiB, 10 s)
          AiService: validate → privacy → breaker → consent token + nonce → reserve quota
                     → Gemini adapter (one call, no retry) → release lease → output
                                                ▼
        https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent
```

Everything owned by another team is injected and fails closed. A remote failure never falls back to the demo provider.

## 3. Files and ownership

| Path | Change | Owner |
| --- | --- | --- |
| `server/src/ai/protocol.ts` | Tasks, limits, error codes and fixed messages | Kiro |
| `server/src/ai/config.ts`, `configReport.ts`, `checkConfig.ts` | `loadAiConfig`, sanitized report, `npm run ai:check-config` | Kiro |
| `server/src/ai/validation.ts`, `privacy.ts`, `consent.ts` | Body parsing, privacy rules, disclosure, digest, consent tokens | Kiro |
| `server/src/ai/usage.ts` | `AiUsageStore` contract, development memory store, Pacific day helpers, breaker | Kiro |
| `server/src/ai/prompts.ts`, `gemini.ts` | Task instructions, Gemini adapter | Kiro |
| `server/src/ai/service.ts`, `http.ts`, `index.ts` | Pipeline, HTTP handler, public entry (`secubuzz-realtime-server/ai`) | Kiro |
| `server/test/ai/**` | Tests, fetch trap, fixtures, reusable store contract | Kiro |
| `server/package.json` | `exports["./ai"]`, `ai:check-config` script | Kiro |
| `server/.env.example`, `server/README.md` | Phase 9B settings and notes | Kiro |
| `client/src/ai/remoteAIProvider.ts` (new), `aiModel.ts`, `demoAIProvider.ts` | Remote provider, error codes, factory selection | Kiro (minimal wiring) |
| `client/src/components/ai/AIHub.tsx` | Disclosure paragraph before the consent checkbox | Kiro (minimal wiring) |
| `client/src/components/messenger/MessengerApp.tsx` | `onRequestAI` only when the provider accepts Messenger content | Kiro (minimal wiring) |
| `client/.env.example` | `NEXT_PUBLIC_AI_REMOTE_READY=false` | Kiro |
| Client tests `remoteAIProvider.test.ts`, `remoteAIHub.test.tsx`, `remoteMessenger.test.tsx` | New | Kiro |

Unchanged: `server/src/main.ts`, `server/src/index.ts`, `server/src/realtime/**` (reused by import only), `server/src/database/**`, `server/src/middleware/`, `DATA/`, `server/.env`, authentication and crypto code, and AI Hub layout and styles.

## 4. Configuration

`loadAiConfig(process.env)` validates once at startup and throws `AiConfigError` with a fixed message. The key and the consent secret live in private fields and never appear in `JSON.stringify`, `util.inspect`, logs or errors.

| Variable | Rule | Default |
| --- | --- | --- |
| `AI_REMOTE_ENABLED` | Only the exact value `true` enables | off |
| `AI_PROVIDER` | `gemini` | required when enabled |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` only | required when enabled |
| `GEMINI_API_KEY` | 20–512 printable characters, no whitespace | required when enabled |
| `AI_PROJECT_RPM`, `AI_PROJECT_RPD` | 1–100,000, copied from AI Studio | required when enabled, no default |
| `AI_USER_RPM`, `AI_USER_RPD` | SecuBuzz policy | 3, 25 |
| `AI_MAX_CONCURRENT` | Provider calls in flight per quota scope | 2 |
| `AI_MAX_INPUT_CHARS` | 1–8,000 UTF-16 code units | 8,000 |
| `AI_MAX_OUTPUT_TOKENS` | 256–3,000; includes thinking tokens | 2,048 |
| `AI_TIMEOUT_MS` | 1,000–14,000 (below the client's 15 s) | 12,000 |
| `AI_QUOTA_SCOPE` | One identifier per Google Cloud project | `default` |
| `AI_ALLOWED_ORIGINS` | Exact origins, comma-separated | none (every request refused) |
| `AI_SESSION_COOKIE` | Cookie name | `secubuzz_session` |
| `AI_CONSENT_SECRET` | 32–512 characters, shared by all API processes | random per process; required in production when enabled |
| `AI_LOCAL_DEV_MEMORY_QUOTA` | `true` outside production only | off |

The loader also refuses any `NEXT_PUBLIC_*` variable whose name contains `GEMINI` or whose value equals the key, and refuses `NODE_TLS_REJECT_UNAUTHORIZED=0` when enabled.

`npm run ai:check-config` (in `server/`) loads `server/.env` and prints a report without the key, its length or prefix. It makes no network request. On this machine it reported: `.env` found and loaded, remote AI off, provider `gemini`, model `gemini-3.5-flash-lite`, key present, project limits unset, result valid.

## 5. Gemini provider

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`, key in the `x-goog-api-key` header only. The endpoint is a constant, so the key cannot be sent anywhere else.
- Body: `systemInstruction`, one `user` entry in `contents`, and `generationConfig.maxOutputTokens`. No temperature, top-p/top-k, candidate count, tools, safety overrides or service tier; the [troubleshooting guide](https://aistudio.google.com/docs/troubleshooting) says candidate count is unsupported on Gemini 3 and sampling should stay at its default.
- `generateContent` was chosen over the Interactions API because the preflight verified it, the Phase 9A contract is single-turn, and Google still documents it ([API reference](https://aistudio.google.com/api-reference/generate-content)). The `@google/genai` SDK was not added: it would be a new dependency, and Google's SDKs retry 429 and 5xx by default.
- One call per accepted request, with `redirect: 'error'`, an abort on timeout or client disconnect, and a 512 KiB cap on the response body. No retry, continuation, model switch or demo fallback.
- Output is the text of `candidates[0].content.parts` without `thought` parts, trimmed, 1–12,000 characters, no NUL.
- Preflight history (before this phase, approved one request each): `gemini-2.5-flash-lite` returned 404 "no longer available to new users"; `gemini-3.5-flash-lite` returned 200 in 727 ms with "OK.", `finishReason` STOP, 5 prompt and 2 output tokens.

## 6. API contract

All responses carry `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. There are no CORS headers. Only `POST` is accepted (405 otherwise); other paths under the base path return 404.

`POST /api/ai/consent`

```json
{ "disclosureVersion": "gemini-free-tier-2026-11-v1", "payloadDigest": "<43 base64url characters>" }
→ 200 { "consentToken": "v1.<payload>.<mac>" }
```

`POST /api/ai/requests`

```json
{ "request": { "task": "translate", "input": "Hello!", "targetLanguage": "French" }, "consentToken": "v1.…" }
→ 200 { "output": "Bonjour !", "kind": "answer" }
```

`task` is one of `chat`, `summarize`, `rewrite` (`tone`: Friendly, Professional, Concise), `translate` (`targetLanguage`: Spanish, French, Vietnamese), `action_items`, `explain`. Unknown keys fail, so a body cannot carry a user ID, model, provider, history or `isDemo` flag.

Errors: `{ "error": { "code": "AI_…", "message": "<fixed text>" } }`, with `Retry-After` on 429 and on 503 from an open breaker.

## 7. Error codes

| Code | HTTP | Client message |
| --- | --- | --- |
| `AI_DISABLED`, `AI_NOT_CONFIGURED` | 503 | @Secu is not connected yet. AI tools are unavailable in this session. |
| `AI_AUTH_REQUIRED` (401), `AI_FORBIDDEN` (403) | 401/403 | Sign in again to use @Secu. |
| `AI_CONSENT_REQUIRED` | 403 | Review and allow remote processing before sharing this text with an AI service. |
| `AI_PRIVACY_RESTRICTED` | 403 | This content cannot be sent to the current AI provider because of SecuBuzz's privacy restrictions. |
| `AI_INVALID_REQUEST` (400, 415), `AI_INPUT_TOO_LARGE` (413) | 400/413/415 | Enter between 1 and 8,000 characters and choose a supported option. |
| `AI_RATE_LIMITED` | 429 | @Secu is receiving too many requests. Wait a moment, then try again. (retryable) |
| `AI_DAILY_QUOTA_EXHAUSTED` | 429 | @Secu has reached its free AI usage limit. |
| `AI_TIMEOUT` | 504 (408 for a slow body) | This request took too long. You can try again. (retryable) |
| `AI_CANCELLED` | 499 | Request cancelled. |
| `AI_SERVICE_UNAVAILABLE`, `AI_PROVIDER_UNAVAILABLE` | 503 | @Secu is temporarily unavailable. (retryable) |
| `AI_PROVIDER_REJECTED` | 422 | @Secu couldn’t process this text. Try rephrasing it. |
| `AI_INVALID_RESPONSE` | 502 | The response could not be safely displayed. |
| `AI_INTERNAL_ERROR`, `AI_NOT_FOUND`, `AI_METHOD_NOT_ALLOWED` | 500/404/405 | The request could not be completed. You can try again. |

Gemini outcomes map as follows ([API errors](https://aistudio.google.com/docs/api-errors?generate-content=true)): network or TLS failure → provider unavailable; 400 with `API_KEY_INVALID` or `FAILED_PRECONDITION` → provider unavailable and a 5-minute breaker; other 400 → rejected; 401/402/403/404 → provider unavailable and a 5-minute breaker; 429 with a per-day `QuotaFailure` → daily quota and a breaker until Pacific midnight; other 429 → rate limited and a breaker for `RetryInfo` (default 60 s); 499 → cancelled; 504 → timeout; other 5xx → provider unavailable; prompt block or a safety-family `finishReason` → rejected; `MAX_TOKENS` or `CONTINUATION` → invalid response (never continued).

## 8. Security model

- Identity comes only from the session cookie through the Database Team's `SessionResolver` (the realtime contract). Missing, invalid or expired sessions, demo identities (`local-user`, `demo-…`) and resolver failures fail closed.
- Cross-site requests need an exact allowlisted `Origin`, a JSON content type and an `X-CSRF-Token` verified for the session. Authentication runs before the body is read.
- The key is server-only, held in a private field, sent only to Google, and absent from logs, errors and responses. A static test checks that client sources contain no Google endpoint, key variable or key header; the production bundle scan found none either.
- Prompt injection: user text goes between `BEGIN_USER_TEXT_<nonce>` and `END_USER_TEXT_<nonce>` markers with a random per-request nonce. The system instruction treats it as data, refuses role changes and instruction disclosure, forbids secrets and asks for plain text. No tools, files, URLs or history are sent. Output renders as React text. The system instruction holds no secrets, so leaking it reveals nothing private.
- Logs are JSON lines with event names, codes, reasons, durations, provider HTTP status and status tokens, network error codes and token counts. They never contain user or session IDs, cookies, CSRF or consent tokens, keys, prompts, inputs or outputs.
- Resource bounds: 64 KiB body, 10 s body deadline, 4 s adapter deadlines, 512 KiB provider body, bounded input and output.

## 9. Privacy and E2EE

The Gemini free tier is an Unpaid Service: Google may use submitted content and responses to improve its products, and human reviewers may read, annotate and process API input and output ([Gemini API terms](https://aistudio.google.com/docs/terms)). SecuBuzz therefore:

- Refuses every request carrying `conversationId`, in the browser before any network call and again on the server. This covers Ask/Summarize/Translate/Explain selected message and Rewrite draft.
- Hides those Messenger actions while the remote provider is active (`acceptsMessengerContent = false`). The demo provider keeps them.
- Refuses text that looks like a credential: private keys, JWTs, Google, AWS, GitHub, Slack, Stripe and `sk-` keys, bearer or basic authorization values, password assignments, the session cookie, AES-256-GCM message envelopes and private JWKs. This is a safety net for accidental pastes, not data-loss prevention; private text typed into AI Hub cannot be detected.
- Never trusts a client `isDemo` flag or a claim that content is safe.

E2EE is unaffected: no ciphertext, key, envelope or message store reaches the AI path, and the server never decrypts anything. Text a user types into AI Hub is plaintext by definition and leaves SecuBuzz's end-to-end boundary when submitted, which is what the disclosure says. If the SecuBuzz operator (the API customer) is in the EEA, Switzerland or the UK, the same terms page applies Google's paid-service data terms even to unpaid quota; the disclosure covers the stricter general case.

## 10. Consent

The client shows, before the unchecked checkbox:

> This request sends the submitted text to Google Gemini for processing. Free-tier data may be used by Google to improve its products, and human reviewers may read it. Do not submit private messages, passwords, or confidential information.

On submit (after the tick), the client computes `base64url(SHA-256(JSON.stringify(["secubuzz-ai-consent-v1", task, input, tone ?? null, targetLanguage ?? null, conversationId ?? null])))` and asks `/api/ai/consent` for a token. The token is an HMAC over the session binding, the digest, the disclosure version `gemini-free-tier-2026-11-v1`, issue and expiry times (60 s) and a random nonce. `/api/ai/requests` recomputes the digest, verifies every field and consumes the nonce once in the usage store. A token cannot be replayed, used by another session, used for other text or used after the disclosure changes. The tick is consumed by each submission, so a retry needs a new tick and a new token.

The server cannot prove a person ticked the box. It proves that each request was preceded by an explicit, separate consent step for that exact text and disclosure, from the same authenticated session, within 60 seconds.

## 11. Cost and quota

- Google lists `gemini-3.5-flash-lite` input and output as free of charge on the free tier ([pricing](https://aistudio.google.com/docs/pricing)). Gemini API use becomes a Paid Service only through a project with an active billing account ([terms](https://aistudio.google.com/docs/terms)). **The $0 guarantee depends on the Google Cloud project having no active billing account; code cannot verify that.**
- Google applies rate limits per project, not per key, resets requests per day at midnight Pacific, and shows actual limits only in AI Studio ([rate limits](https://aistudio.google.com/docs/rate-limits)). The 3.5 Flash-Lite limits for this project were not verified, so `AI_PROJECT_RPM` and `AI_PROJECT_RPD` have no defaults. The Gemini 2.5 figures are not reused.
- Before every call the store reserves, atomically: one active request per user, at most `AI_MAX_CONCURRENT` per scope, and the user and scope counts for the sliding minute and the Pacific day. Counts are never refunded, including for failures, timeouts and cancellations.
- Tokens: the largest request is 8,000 input characters, a system instruction of at most 1,318 characters (chat), 80 characters of markers and up to `AI_MAX_OUTPUT_TOKENS`. Choose `AI_PROJECT_RPM` so that RPM × the largest request stays below the project TPM in AI Studio. Token counts from `usageMetadata` are logged.
- A provider 429 opens an in-process breaker; key, permission, billing (402), model (404) and precondition failures open it for 5 minutes. Other processes may each make one more call before their own breaker opens; Google refuses those at no cost.
- Never: retries, paid fallback, automatic model switch, continuation calls, background or scheduled calls, health checks, `countTokens` calls, or tests and CI against Google.

## 12. TLS and Avast

Avast Web/Mail Shield on this machine intercepts HTTPS and re-signs certificates with its own root. Node's bundled CA list does not trust that root, so plain `node` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. `node --use-system-ca` uses the Windows certificate store, where the Avast root is installed, and the preflight verified TLS 1.3 that way.

- Start the API process with `node --use-system-ca`; for npm scripts set `$env:NODE_OPTIONS='--use-system-ca'`.
- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` (the config loader refuses it), install insecure agents or modify Avast or the trust store.
- While Avast inspects HTTPS, it can read requests to Google in plaintext, including submitted text and responses (the key travels in a header Avast can also see). Treat that machine as an extra party to every AI request.
- The adapter logs only an allowlisted network error code (`network_tls` reason for certificate failures), which is enough to diagnose this without logging messages.

## 13. Client integration

- `createAIProvider(isDemoSession)` returns the demo provider for development demo sessions, `RemoteAIProvider` only when the session is not a demo and `NEXT_PUBLIC_AUTH_MODE=api`, `NEXT_PUBLIC_AUTH_API_READY=true` and `NEXT_PUBLIC_AI_REMOTE_READY=true`, and the unavailable provider otherwise. Remote mode is allowed in production builds; the demo never is.
- Today `AuthenticatedWorkspace` mounts Messenger only for demo sessions, so remote mode cannot appear in the app until the real-account workspace is integrated.
- `RemoteAIProvider` sends `POST` with `credentials: 'same-origin'`, `mode: 'same-origin'`, `redirect: 'error'`, `cache: 'no-store'` and the CSRF token from `meta[name="secubuzz-csrf-token"]`; without a token it fails closed before any request.
- Phase 9A behavior is unchanged: one active request, per-request consent, cancel, 15-second deadline, three manual attempts, no automatic retry, memory-only history.
- New client error codes: `privacy_restricted`, `rate_limited`, `quota_exhausted`, `provider_unavailable`, `auth_required`, `declined`. Retryable: `timeout`, `request_failed`, `rate_limited`, `provider_unavailable`.

## 14. Testing

All tests use mocks. `server/test/ai/support/noNetwork.ts` replaces the global `fetch` in every AI test file and fails the file if any non-loopback URL is requested; test keys are fake.

| Suite | Coverage |
| --- | --- |
| `config.test.ts` | Enable switch, provider/model allowlist, key rules, required project limits, ranges, origins, cookie, `NEXT_PUBLIC_*` refusal, memory store and production rules, consent secret, TLS refusal, secret hiding, report and script output |
| `request-rules.test.ts` | Body parsing, task options, control characters, size, privacy patterns (positive and negative, adversarial timing), digest vector, consent token binding, expiry, tampering |
| `usage.test.ts` | Store contract on the memory store and a shared durable-semantics double, Pacific day and DST, restart and multi-worker semantics, breaker |
| `gemini.test.ts` | Request shape and header-only key, every status mapping, no retry, network and TLS errors, timeout with and without abort support, cancellation, body cap, stalled body, prompts |
| `http.test.ts` | Disabled and unconfigured paths, routing, Express mounting, Origin, content type, session failures, CSRF, body limits, consent flow, privacy, validation, user and project minute/day limits, concurrency, breaker, no refund, restart, shared workers, store failures, client disconnect, log hygiene |
| `client-parity.test.ts` | Loads the real client adapter: disclosure and digest parity, error-map coverage, and a mocked end-to-end flow through the real handler |
| `boundaries.test.ts` | AI export list, Google endpoint only in the adapter, no TLS weakening, no Gemini references in client code, templates keep AI off |
| Client `remoteAIProvider.test.ts` | Fetch options, CSRF, consent-then-request, Messenger refusal, every error mapping, malformed bodies, cancellation, factory selection, no demo fallback |
| Client `remoteAIHub.test.tsx`, `remoteMessenger.test.tsx` | AI Hub with the real provider and a mocked backend; Messenger handoffs hidden in remote mode, kept in demo mode |

Results on Node 24.20.0 (Windows):

| Command | Result |
| --- | --- |
| `server`: `npm run type-check` | passed |
| `server`: `npm test` | 334 passed (197 existing, 137 new), 48 suites |
| `client`: `npm run type-check` | passed |
| `client`: `npm run lint` | passed; the 2 existing `no-img-element` warnings |
| `client`: `npm test -- --runInBand` | 679 passed (624 existing, 55 new), 58 suites |
| `client`: `npm run build` | passed; 6 static pages; no Google endpoint or key name in `.next/static` |

The mocked end-to-end tests are not a live Gemini integration.

## 15. Browser verification

Real Chrome 157 (headless, CDP) ran against an isolated copy of the client under ignored `tmp/` with a temporary harness page. The page mounts the real AI Hub, navigation and `RemoteAIProvider`, with an in-page mocked AI API. Product source was not changed for the run. **421 of 421 assertions passed**, with no uncaught page errors and only the existing Next.js image-priority warning.

- Desktop 1440×1000, tablet 1024×900 and mobile 390×844, each in Light, Dark and System (system dark), plus System following a light OS preference: disclosure text and position, checkbox description link, submit disabled until consent, nothing sent before consent, loading and cancel controls, "AI result" labelling, plain-text output, consent reset, fetch options, CSRF header, consent and request bodies, no horizontal overflow.
- Scenarios at desktop/Light and mobile/Dark: daily quota exhausted, rate limited, provider unavailable, privacy restricted, sign-in required, AI disabled, consent required, provider declined, timeout, retry after failure with a fresh consent token, cancel with the request aborted and text kept, rewrite tone and translation language sent, chat with Enter blocked before consent and an "AI response" label.
- Demo regression in the real app: demo login, Messenger draft handoff still offered, "Demo · offline" badge, no disclosure or consent control, prepared example label unchanged.
- Network: 530 requests observed, all to the loopback dev server or `data:` URLs; none to `/api/ai`, Google or any other host.

Screenshots and `browser-evidence.json` are in ignored `tmp/phase9b-3787df95467c/browser/`.

## 16. Local development

What runs today:

```powershell
cd server
npm run ai:check-config     # sanitized settings report from server/.env, no network
npm run type-check
npm test                    # mocks only; cannot reach Google
```

There is no local API process to mount the handler, and no real session resolver or CSRF verifier, so remote AI cannot be exercised end to end yet. Once the Database Team's API server exists, a local run will look like this (with `AI_LOCAL_DEV_MEMORY_QUOTA=true` until the durable store is ready):

```powershell
node --use-system-ca --env-file=server/.env <api-server-entry>
```

Do not change `AI_REMOTE_ENABLED` until section 17 is complete.

## 17. Deployment checklist

1. The Database Team's API server mounts the handler before any body parser:

   ```js
   import { createAiHttpHandler, loadAiConfig } from 'secubuzz-realtime-server/ai';
   app.use('/api/ai', createAiHttpHandler({ config: loadAiConfig(process.env), sessionResolver, csrfVerifier, usageStore }));
   ```

2. The page serves `<meta name="secubuzz-csrf-token">` for the session, and the CSRF verifier accepts only that token.
3. A durable `AiUsageStore` passes `usageStoreContract` (section 18) and is shared by every process.
4. `AI_PROJECT_RPM` and `AI_PROJECT_RPD` are copied from the AI Studio rate-limit page for this project and model.
5. The Google Cloud project has no active billing account (checked in AI Studio and Cloud Billing).
6. `AI_CONSENT_SECRET` (32+ characters, shared) and `AI_ALLOWED_ORIGINS` are set; the Next app and `/api/ai` are served from the same origin.
7. The process starts with `--use-system-ca` only where an OS trust store is required.
8. The real-account workspace mounts AI Hub, and the client sets `NEXT_PUBLIC_AUTH_MODE=api`, `NEXT_PUBLIC_AUTH_API_READY=true` and `NEXT_PUBLIC_AI_REMOTE_READY=true`.
9. `npm run ai:check-config` reports valid settings; only then set `AI_REMOTE_ENABLED=true`, and approve the first live request separately.

## 18. Database Team handoff

- **SessionResolver** (existing realtime contract). For AI requests the handler passes the session cookie value, the allowlisted `Origin` of the POST, the peer address, user agent, `secure` (TLS on the socket) and the receive time. Return `invalid` for unknown, revoked or foreign tokens. The same resolver serves realtime and AI.
- **AiCsrfVerifier**: `verify({ sessionId, userId, token }) → boolean`, `true` only for the token issued to that session. The client already reads `meta[name="secubuzz-csrf-token"]` and sends `X-CSRF-Token`, as the auth adapter does.
- **AiUsageStore** (`kind: 'durable'`):
  - `reserve` is one atomic step across processes and restarts. It ignores expired leases, refuses if the user holds a lease or the scope holds `maxConcurrentPerScope`, checks user and scope counts for the Pacific day and the last 60 seconds, then records the lease and increments every count. Refusals change nothing.
  - `release` deletes the lease; counts are never decremented.
  - `consumeConsentNonce` is an atomic insert-if-absent of (scope, nonce) kept until expiry, `true` only the first time.
  - Proposed SQLite shape (yours to decide): `ai_usage_events(scope, user_id, at_ms)` for minute windows, `ai_usage_days(scope, subject, pacific_day, count)`, `ai_leases(reservation_id PRIMARY KEY, scope, user_id, expires_at_ms)`, `ai_consent_nonces(scope, nonce, expires_at_ms, PRIMARY KEY(scope, nonce))`, all changed inside one `BEGIN IMMEDIATE` transaction.
  - Validate it with `usageStoreContract(name, factory)` from `server/test/ai/support/usageStoreContract.ts`.
- **Cookies and proxy**: HttpOnly, Secure and SameSite session cookie; one origin for the app and `/api/ai`; the proxy must forward `Origin`, `Cookie` and `X-CSRF-Token` unchanged and must not add CORS headers.
- **Workspace**: mount Messenger and AI Hub for real accounts; today they show "Messenger services are not connected yet".

## 19. Codex handoff

Visual and copy decisions left to Codex (no layout or style was changed):

- The AI Hub privacy line "AI work stays in this session" is accurate for local memory but may read as "text stays local" in remote mode; consider remote-specific wording.
- The disclosure uses the existing `.ai-demo-note` style. Restyle freely, but keep `id="ai-remote-disclosure"`, its position before the checkbox and the `aria-describedby` link.
- The badge says "Connected AI service"; naming the provider (Google Gemini, free tier) would be more transparent.
- Messenger AI actions disappear in remote mode without explanation; a short notice could explain why.
- `Retry-After` is not shown; quota and rate-limit messages could show when to try again.
- In remote mode the starter question "How is my text used?" is answered by the model, steered by the system instruction.

## 20. Remaining issues and Phase 10 readiness

Blocking live use:

- No production `SessionResolver` or CSRF verifier, and no CSRF bootstrap (Database Team).
- No durable shared usage store.
- No API server that mounts the handler, and no real-account workspace with AI Hub.
- The project's quota for `gemini-3.5-flash-lite` is unknown until copied from AI Studio.
- The free-tier billing state cannot be verified by code.

Known limits: the breaker is per process; credential detection is heuristic; there is no TPM accounting beyond bounded sizes; no streaming; consent issuance is logged without user identity, so there is no per-user consent audit trail.

Phase 10 readiness: the AI module is isolated in `server/src/ai/`, and `server/src/agents/` is untouched. Security agents can consume the existing log events (`ai.request.rejected` reasons such as `credential` or `messenger_context`, `ai.breaker.opened`, `ai.provider.failed`). A policy hook comparable to `RealtimeSecurityPolicy` (allow or deny before reservation) and a consent audit event would be the natural Phase 10 additions; neither is implemented.

**Verdict: BLOCKED** for live use. The implementation is complete, tested with mocks and shipped disabled; enabling it waits on production authentication, CSRF verification and a durable usage store.
