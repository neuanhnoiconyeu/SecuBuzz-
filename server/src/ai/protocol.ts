/**
 * Phase 9B AI API protocol: tasks, limits and error codes shared by the HTTP handler, the service
 * and tests. Error messages are fixed strings. Nothing from a provider or a request is ever echoed.
 * See docs/phase9b-gemini-integration.md and .kiro/specs/phase9b-gemini-ai/design.md.
 */

/** Mirrors `client/src/ai/aiModel.ts`. */
export const AI_TASKS = Object.freeze(['chat', 'summarize', 'rewrite', 'translate', 'action_items', 'explain'] as const);
export type AiTask = typeof AI_TASKS[number];
export const AI_TONES = Object.freeze(['Friendly', 'Professional', 'Concise'] as const);
export type AiTone = typeof AI_TONES[number];
export const AI_LANGUAGES = Object.freeze(['Spanish', 'French', 'Vietnamese'] as const);
export type AiLanguage = typeof AI_LANGUAGES[number];

/** Phase 9A client contract limits, in UTF-16 code units. */
export const AI_CONTRACT_MAX_INPUT = 8_000;
export const AI_CONTRACT_MAX_OUTPUT = 12_000;

export const AI_PROVIDER_NAME = 'gemini';
/** The only model this phase may call. There is no automatic switch to another model. */
export const AI_SUPPORTED_MODELS = Object.freeze(['gemini-3.5-flash-lite'] as const);
export type AiModel = typeof AI_SUPPORTED_MODELS[number];

export const DEFAULT_AI_BASE_PATH = '/api/ai';
export const AI_MAX_BODY_BYTES = 65_536;

interface ErrorDefinition {
  readonly status: number;
  readonly message: string;
}

export const AI_ERRORS = Object.freeze({
  AI_DISABLED: { status: 503, message: 'Remote AI is turned off on this server.' },
  AI_NOT_CONFIGURED: { status: 503, message: '@Secu is not configured on this server.' },
  AI_AUTH_REQUIRED: { status: 401, message: 'Sign in to use @Secu.' },
  AI_FORBIDDEN: { status: 403, message: 'This request was not allowed.' },
  AI_CONSENT_REQUIRED: { status: 403, message: 'Confirm that this text may be sent to Google Gemini before submitting it.' },
  AI_PRIVACY_RESTRICTED: {
    status: 403,
    message: "This content cannot be sent to the current AI provider because of SecuBuzz's privacy restrictions.",
  },
  AI_INVALID_REQUEST: { status: 400, message: 'The AI request is invalid.' },
  AI_INPUT_TOO_LARGE: { status: 413, message: 'The submitted text is too long.' },
  AI_RATE_LIMITED: { status: 429, message: '@Secu is receiving too many requests. Try again shortly.' },
  AI_DAILY_QUOTA_EXHAUSTED: { status: 429, message: '@Secu has reached its free AI usage limit.' },
  AI_TIMEOUT: { status: 504, message: 'The AI request took too long.' },
  AI_CANCELLED: { status: 499, message: 'The AI request was cancelled.' },
  AI_SERVICE_UNAVAILABLE: { status: 503, message: '@Secu is temporarily unavailable.' },
  AI_PROVIDER_UNAVAILABLE: { status: 503, message: '@Secu is temporarily unavailable.' },
  AI_PROVIDER_REJECTED: { status: 422, message: 'The AI provider declined to process this text.' },
  AI_INVALID_RESPONSE: { status: 502, message: 'The AI response could not be used.' },
  AI_INTERNAL_ERROR: { status: 500, message: '@Secu could not complete the request.' },
  AI_NOT_FOUND: { status: 404, message: 'Not found.' },
  AI_METHOD_NOT_ALLOWED: { status: 405, message: 'Method not allowed.' },
} satisfies Record<string, ErrorDefinition>);

export type AiErrorCode = keyof typeof AI_ERRORS;
export const AI_ERROR_CODES = Object.freeze(Object.keys(AI_ERRORS) as AiErrorCode[]);

export interface AiErrorBody {
  readonly error: { readonly code: AiErrorCode; readonly message: string };
}

export function aiErrorBody(code: AiErrorCode): AiErrorBody {
  return { error: { code, message: AI_ERRORS[code].message } };
}

/** Successful `POST /api/ai/requests` body. */
export interface AiGenerationResponse {
  readonly output: string;
  readonly kind: 'answer';
}

/** Successful `POST /api/ai/consent` body. */
export interface AiConsentResponse {
  readonly consentToken: string;
}
