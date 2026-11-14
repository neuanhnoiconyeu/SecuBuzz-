/**
 * Public entry point of the SecuBuzz AI API (Phase 9B), exported as `secubuzz-realtime-server/ai`.
 *
 * The Database Team's API server mounts `createAiHttpHandler` with its Session resolver, CSRF
 * verifier and a durable `AiUsageStore`. Test fixtures, fake stores and mock providers live in
 * `server/test/` and are not exported. See docs/phase9b-gemini-integration.md.
 */
export { createAiHttpHandler } from './http.ts';
export type { AiCsrfInput, AiCsrfVerifier, AiHttpHandler, AiHttpHandlerOptions } from './http.ts';
export { AI_LIMIT_DEFAULTS, AiConfig, AiConfigError, loadAiConfig } from './config.ts';
export type { AiLimits } from './config.ts';
export { AI_DISCLOSURE, CONSENT_TTL_SECONDS, computePayloadDigest } from './consent.ts';
export {
  AI_CONTRACT_MAX_INPUT,
  AI_CONTRACT_MAX_OUTPUT,
  AI_ERROR_CODES,
  AI_ERRORS,
  AI_LANGUAGES,
  AI_SUPPORTED_MODELS,
  AI_TASKS,
  AI_TONES,
  DEFAULT_AI_BASE_PATH,
} from './protocol.ts';
export type { AiConsentResponse, AiErrorBody, AiErrorCode, AiGenerationResponse, AiLanguage, AiModel, AiTask, AiTone } from './protocol.ts';
export { MemoryAiUsageStore, pacificDayKey, secondsUntilNextPacificMidnight } from './usage.ts';
export type { AiReservation, AiReservationRequest, AiUsageLimits, AiUsageStore } from './usage.ts';
export type { AiGenerationRequest } from './validation.ts';
