import { AIError, validateAIRequest, type AIErrorCode, type AIProvider, type AIRequest, type AIResponse } from './aiModel';

/**
 * Phase 9B remote @Secu provider. It talks only to the same-origin SecuBuzz AI API; the browser
 * never contacts Google and never sees a Gemini key. Each run asks the server for a consent token
 * bound to this session, this exact text and the disclosure below, then sends the request with it.
 * Relative imports only: server tests load this file to check disclosure and digest parity.
 */

/** Must match `server/src/ai/consent.ts`; a server test enforces it. */
export const AI_REMOTE_DISCLOSURE = Object.freeze({
  version: 'gemini-free-tier-2026-11-v1',
  text: 'This request sends the submitted text to Google Gemini for processing. Free-tier data may be used by Google ' +
    'to improve its products, and human reviewers may read it. Do not submit private messages, passwords, or confidential information.',
});

export const AI_REMOTE_ENDPOINTS = Object.freeze({ consent: '/api/ai/consent', requests: '/api/ai/requests' });

const MAX_RESPONSE_CHARS = 65_536;
const CONSENT_TOKEN = /^[A-Za-z0-9._-]{1,2048}$/;

/** AI API error codes (`server/src/ai/protocol.ts`) mapped to the Phase 9A client codes; a server test checks coverage. */
export const AI_REMOTE_ERROR_MAP: Readonly<Record<string, AIErrorCode>> = Object.freeze({
  AI_DISABLED: 'unavailable',
  AI_NOT_CONFIGURED: 'unavailable',
  AI_AUTH_REQUIRED: 'auth_required',
  AI_FORBIDDEN: 'auth_required',
  AI_CONSENT_REQUIRED: 'consent_required',
  AI_PRIVACY_RESTRICTED: 'privacy_restricted',
  AI_INVALID_REQUEST: 'invalid_input',
  AI_INPUT_TOO_LARGE: 'invalid_input',
  AI_RATE_LIMITED: 'rate_limited',
  AI_DAILY_QUOTA_EXHAUSTED: 'quota_exhausted',
  AI_TIMEOUT: 'timeout',
  AI_CANCELLED: 'cancelled',
  AI_SERVICE_UNAVAILABLE: 'provider_unavailable',
  AI_PROVIDER_UNAVAILABLE: 'provider_unavailable',
  AI_PROVIDER_REJECTED: 'declined',
  AI_INVALID_RESPONSE: 'invalid_response',
  AI_INTERNAL_ERROR: 'request_failed',
  AI_NOT_FOUND: 'request_failed',
  AI_METHOD_NOT_ALLOWED: 'request_failed',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key));
}

/** base64url(SHA-256(UTF-8(JSON array))) over the raw request strings, identical to the server. */
export async function aiPayloadDigest(request: AIRequest): Promise<string> {
  const canonical = JSON.stringify([
    'secubuzz-ai-consent-v1',
    request.task,
    request.input,
    request.tone ?? null,
    request.targetLanguage ?? null,
    request.conversationId ?? null,
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The same CSRF bootstrap the auth adapter uses. */
export function readCsrfMetaToken(): string | null {
  return typeof document === 'undefined' ? null :
    document.querySelector<HTMLMetaElement>('meta[name="secubuzz-csrf-token"]')?.content ?? null;
}

function errorCode(status: number, body: unknown): AIErrorCode {
  const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : null;
  if (code !== null && Object.prototype.hasOwnProperty.call(AI_REMOTE_ERROR_MAP, code)) return AI_REMOTE_ERROR_MAP[code]!;
  if (status === 401) return 'auth_required';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'provider_unavailable';
  return 'request_failed';
}

export interface RemoteAIProviderOptions {
  getCsrfToken: () => string | null;
  /** Test seam. Defaults to the browser `fetch`. */
  fetch?: typeof fetch;
}

export class RemoteAIProvider implements AIProvider {
  readonly mode = 'remote' as const;
  readonly available = true;
  readonly supportsStreaming = false;
  /** Free-tier terms allow Google to use submitted text, so Messenger content is never offered. */
  readonly acceptsMessengerContent = false;
  readonly disclosure = AI_REMOTE_DISCLOSURE.text;
  private readonly requestFetch: typeof fetch;

  constructor(private readonly options: RemoteAIProviderOptions) {
    this.requestFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  async run(untrusted: Readonly<AIRequest>, { signal }: { signal: AbortSignal }): Promise<AIResponse> {
    const request = validateAIRequest({ ...untrusted });
    // Messenger messages and drafts are private; this provider must never receive them.
    if (request.conversationId !== undefined) throw new AIError('privacy_restricted');
    if (signal.aborted) throw new AIError('cancelled');
    let csrf: string | null;
    try { csrf = this.options.getCsrfToken(); } catch { throw new AIError('unavailable'); }
    if (typeof csrf !== 'string' || !csrf.trim() || /[\r\n]/.test(csrf)) throw new AIError('unavailable');

    const body: AIRequest = {
      task: request.task,
      input: request.input,
      ...(request.tone ? { tone: request.tone } : {}),
      ...(request.targetLanguage ? { targetLanguage: request.targetLanguage } : {}),
    };
    let payloadDigest: string;
    try { payloadDigest = await aiPayloadDigest(body); } catch { throw new AIError('unavailable'); }
    const consent = await this.post(AI_REMOTE_ENDPOINTS.consent, { disclosureVersion: AI_REMOTE_DISCLOSURE.version, payloadDigest }, csrf, signal);
    if (!hasOnlyKeys(consent, ['consentToken']) || typeof consent.consentToken !== 'string' || !CONSENT_TOKEN.test(consent.consentToken)) {
      throw new AIError('invalid_response');
    }
    const result = await this.post(AI_REMOTE_ENDPOINTS.requests, { request: body, consentToken: consent.consentToken }, csrf, signal);
    if (!hasOnlyKeys(result, ['output', 'kind']) || result.kind !== 'answer' || typeof result.output !== 'string') {
      throw new AIError('invalid_response');
    }
    return { output: result.output, provider: 'remote', kind: 'answer' };
  }

  private async post(url: string, payload: unknown, csrf: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.requestFetch(url, {
        method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(payload),
      });
    } catch { throw new AIError(signal.aborted ? 'cancelled' : 'request_failed'); }
    let text: string;
    try { text = await response.text(); } catch { throw new AIError(signal.aborted ? 'cancelled' : 'request_failed'); }
    if (signal.aborted) throw new AIError('cancelled');
    let body: unknown = null;
    if (text.length > 0 && text.length <= MAX_RESPONSE_CHARS) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (response.status === 200) {
      if (!isRecord(body)) throw new AIError('invalid_response');
      return body;
    }
    throw new AIError(errorCode(response.status, body));
  }
}
