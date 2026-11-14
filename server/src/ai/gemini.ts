/**
 * Gemini Developer API adapter (`generateContent`) with an injectable `fetch`.
 *
 * One call per accepted request: no retries, no continuation of truncated output, no fallback to
 * another model, key or provider. TLS uses Node's default verification (run with
 * `--use-system-ca` to trust the operating-system store). The endpoint is fixed so the key can
 * only ever be sent to Google. Provider messages are discarded; only allowlisted status tokens,
 * HTTP status, network error codes and token counts leave this module.
 */
import { AI_CONTRACT_MAX_OUTPUT, type AiErrorCode, type AiModel } from './protocol.ts';
import type { AiPrompt } from './prompts.ts';
import { secondsUntilNextPacificMidnight } from './usage.ts';

export const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com';
export const GEMINI_MAX_RESPONSE_BYTES = 524_288;
/** Breaker duration after an invalid key, permission, billing, model or precondition failure. */
export const PROVIDER_CONFIGURATION_BREAKER_SECONDS = 300;
const DEFAULT_RATE_LIMIT_SECONDS = 60;
const MAX_RATE_LIMIT_SECONDS = 3_600;
const TOKEN_TEXT = /^[A-Z][A-Z0-9_]{1,63}$/;
const REJECTED_FINISH = new Set([
  'SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'IMAGE_OTHER', 'ESCALATION', 'PUP_LIMITED_DISABLED',
]);
const TRUNCATED_FINISH = new Set(['MAX_TOKENS', 'CONTINUATION']);
const SERVICE_TIERS = new Set(['unspecified', 'standard', 'flex', 'priority']);

export interface ProviderUsage {
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
  readonly thoughtsTokens: number | null;
  readonly totalTokens: number | null;
}

/** Log-safe facts about a provider failure. */
export interface ProviderDiagnostics {
  readonly providerStatus: number | null;
  readonly providerStatusText: string | null;
  readonly providerReason: string | null;
  readonly networkCode: string | null;
}

export type ProviderOutcome =
  | {
    readonly ok: true;
    readonly text: string;
    readonly usage: ProviderUsage;
    readonly serviceTier: string | null;
  }
  | {
    readonly ok: false;
    readonly code: AiErrorCode;
    readonly reason: string;
    /** Sent to the client as Retry-After. */
    readonly retryAfterSeconds?: number;
    /** Open the in-process breaker for this long. */
    readonly breakerSeconds?: number;
    readonly diagnostics: ProviderDiagnostics;
  };

export interface AiTextProvider {
  readonly model: AiModel;
  generate(prompt: AiPrompt, signal: AbortSignal): Promise<ProviderOutcome>;
}

export interface GeminiProviderOptions {
  readonly model: AiModel;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  /** Test seam. Defaults to the global `fetch` at call time. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const NO_DIAGNOSTICS: ProviderDiagnostics = Object.freeze({ providerStatus: null, providerStatusText: null, providerReason: null, networkCode: null });

function failure(code: AiErrorCode, reason: string, diagnostics: Partial<ProviderDiagnostics> = {}, extra: {
  retryAfterSeconds?: number;
  breakerSeconds?: number;
} = {}): ProviderOutcome {
  return { ok: false, code, reason, diagnostics: { ...NO_DIAGNOSTICS, ...diagnostics }, ...extra };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function token(value: unknown): string | null {
  return typeof value === 'string' && TOKEN_TEXT.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** System error code (for example UNABLE_TO_VERIFY_LEAF_SIGNATURE) from a rejected fetch. */
function networkCode(error: unknown): string | null {
  const direct = record(error);
  const cause = record(direct?.cause);
  return token(cause?.code) ?? token(direct?.code);
}

const TLS_CODE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL|ALTNAME/u;

interface ErrorFacts {
  readonly statusText: string | null;
  readonly reason: string | null;
  readonly daily: boolean;
  readonly retryAfterSeconds: number | null;
}

/** Reads `error.status`, `ErrorInfo.reason`, `QuotaFailure.violations[].quotaId` and `RetryInfo.retryDelay`. */
function errorFacts(body: unknown): ErrorFacts {
  const error = record(record(body)?.error);
  let reason: string | null = null;
  let daily = false;
  let retryAfterSeconds: number | null = null;
  const details = Array.isArray(error?.details) ? (error.details as unknown[]).slice(0, 20) : [];
  for (const entry of details) {
    const detail = record(entry);
    const type = typeof detail?.['@type'] === 'string' ? detail['@type'] as string : '';
    if (type.endsWith('google.rpc.ErrorInfo')) reason ??= token(detail?.reason);
    if (type.endsWith('google.rpc.QuotaFailure') && Array.isArray(detail?.violations)) {
      for (const violation of (detail.violations as unknown[]).slice(0, 20)) {
        const quotaId = record(violation)?.quotaId;
        if (typeof quotaId === 'string' && /PerDay|Daily/iu.test(quotaId)) daily = true;
      }
    }
    if (type.endsWith('google.rpc.RetryInfo') && typeof detail?.retryDelay === 'string') {
      const match = /^(\d{1,7})(?:\.\d{1,9})?s$/u.exec(detail.retryDelay);
      if (match) retryAfterSeconds = Math.min(MAX_RATE_LIMIT_SECONDS, Math.max(1, Math.ceil(Number.parseFloat(detail.retryDelay))));
    }
  }
  return { statusText: token(error?.status), reason, daily, retryAfterSeconds };
}

/** Maps a non-200 provider response. Never retried. */
function mapStatus(status: number, body: unknown, nowMs: number): ProviderOutcome {
  const facts = errorFacts(body);
  const diagnostics = { providerStatus: status, providerStatusText: facts.statusText, providerReason: facts.reason };
  const configuration = { breakerSeconds: PROVIDER_CONFIGURATION_BREAKER_SECONDS };
  if (status === 400) {
    if (facts.reason === 'API_KEY_INVALID' || facts.statusText === 'FAILED_PRECONDITION') {
      return failure('AI_PROVIDER_UNAVAILABLE', 'provider_configuration', diagnostics, configuration);
    }
    return failure('AI_PROVIDER_REJECTED', 'provider_bad_request', diagnostics);
  }
  if (status === 401 || status === 402 || status === 403 || status === 404) {
    return failure('AI_PROVIDER_UNAVAILABLE', status === 402 ? 'provider_billing' : 'provider_configuration', diagnostics, configuration);
  }
  if (status === 429) {
    if (facts.daily) {
      const seconds = secondsUntilNextPacificMidnight(nowMs);
      return failure('AI_DAILY_QUOTA_EXHAUSTED', 'provider_daily_quota', diagnostics, { retryAfterSeconds: seconds, breakerSeconds: seconds });
    }
    const seconds = facts.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS;
    return failure('AI_RATE_LIMITED', 'provider_rate_limit', diagnostics, { retryAfterSeconds: seconds, breakerSeconds: seconds });
  }
  if (status === 499) return failure('AI_CANCELLED', 'provider_cancelled', diagnostics);
  if (status === 504) return failure('AI_TIMEOUT', 'provider_deadline', diagnostics);
  if (status >= 500 && status <= 599) return failure('AI_PROVIDER_UNAVAILABLE', 'provider_server_error', diagnostics);
  return failure('AI_INVALID_RESPONSE', 'provider_status', diagnostics);
}

/** Maps a 200 body to text or a failure. */
function mapSuccess(body: unknown): ProviderOutcome {
  const root = record(body);
  if (!root) return failure('AI_INVALID_RESPONSE', 'response_shape', { providerStatus: 200 });
  const blockReason = token(record(root.promptFeedback)?.blockReason);
  const candidates = Array.isArray(root.candidates) ? root.candidates as unknown[] : [];
  if (blockReason !== null && candidates.length === 0) {
    return failure('AI_PROVIDER_REJECTED', 'prompt_blocked', { providerStatus: 200, providerReason: blockReason });
  }
  const candidate = record(candidates[0]);
  if (!candidate) return failure('AI_INVALID_RESPONSE', 'no_candidate', { providerStatus: 200 });
  const finishReason = token(candidate.finishReason);
  if (finishReason !== null && REJECTED_FINISH.has(finishReason)) {
    return failure('AI_PROVIDER_REJECTED', 'output_blocked', { providerStatus: 200, providerReason: finishReason });
  }
  if (finishReason !== null && TRUNCATED_FINISH.has(finishReason)) {
    return failure('AI_INVALID_RESPONSE', 'output_truncated', { providerStatus: 200, providerReason: finishReason });
  }
  if (finishReason !== 'STOP') {
    return failure('AI_INVALID_RESPONSE', 'finish_reason', { providerStatus: 200, providerReason: finishReason });
  }
  const parts = record(candidate.content)?.parts;
  if (!Array.isArray(parts) || parts.length > 64) return failure('AI_INVALID_RESPONSE', 'response_parts', { providerStatus: 200 });
  let text = '';
  for (const entry of parts as unknown[]) {
    const part = record(entry);
    if (!part || part.thought === true) continue;
    if (typeof part.text === 'string') text += part.text;
  }
  text = text.trim();
  if (text.length === 0) return failure('AI_INVALID_RESPONSE', 'empty_output', { providerStatus: 200 });
  if (text.length > AI_CONTRACT_MAX_OUTPUT || text.includes('\u0000')) {
    return failure('AI_INVALID_RESPONSE', 'output_bounds', { providerStatus: 200 });
  }
  const usage = record(root.usageMetadata);
  const tier = usage?.serviceTier;
  return {
    ok: true,
    text,
    usage: {
      promptTokens: count(usage?.promptTokenCount),
      outputTokens: count(usage?.candidatesTokenCount),
      thoughtsTokens: count(usage?.thoughtsTokenCount),
      totalTokens: count(usage?.totalTokenCount),
    },
    serviceTier: typeof tier === 'string' && SERVICE_TIERS.has(tier) ? tier : null,
  };
}

class Aborted extends Error {
  override name = 'Aborted';
}

/** Resolves or rejects with `operation`, or rejects with {@link Aborted} as soon as `signal` aborts. */
function untilAborted<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

type BodyRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'too_large' | 'encoding' };

async function readBounded(response: Response, limit: number): Promise<BodyRead> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    // Not awaited: cancellation of a tee'd or stalled stream may never settle.
    void response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }
  if (!response.body) return { ok: true, text: '' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, reason: 'encoding' };
  }
}

export class GeminiProvider implements AiTextProvider {
  readonly model: AiModel;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: GeminiProviderOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) throw new Error('A Gemini API key is required.');
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('timeoutMs must be a positive integer.');
    if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) throw new Error('maxOutputTokens must be a positive integer.');
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  /** Exact request body. Sampling, candidate count, tools, safety settings and service tier stay at Google's defaults. */
  requestBody(prompt: AiPrompt): string {
    return JSON.stringify({
      systemInstruction: { parts: [{ text: prompt.systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: prompt.userText }] }],
      generationConfig: { maxOutputTokens: this.#maxOutputTokens },
    });
  }

  async generate(prompt: AiPrompt, signal: AbortSignal): Promise<ProviderOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    const forward = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
    const interrupted = () => timedOut ? failure('AI_TIMEOUT', 'provider_timeout') : failure('AI_CANCELLED', 'client_cancelled');
    try {
      if (controller.signal.aborted) return interrupted();
      const url = `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
      let response: Response;
      try {
        response = await untilAborted(this.#fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-goog-api-key': this.#apiKey },
          body: this.requestBody(prompt),
          redirect: 'error',
          signal: controller.signal,
        }), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return interrupted();
        const code = networkCode(error);
        return failure('AI_PROVIDER_UNAVAILABLE', code !== null && TLS_CODE.test(code) ? 'network_tls' : 'network', { networkCode: code });
      }
      if (!(response instanceof Response)) return failure('AI_INVALID_RESPONSE', 'response_object');
      let read: BodyRead;
      try {
        read = await untilAborted(readBounded(response, GEMINI_MAX_RESPONSE_BYTES), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return interrupted();
        return failure('AI_PROVIDER_UNAVAILABLE', 'network_body', { providerStatus: response.status, networkCode: networkCode(error) });
      }
      if (!read.ok) return failure('AI_INVALID_RESPONSE', read.reason === 'too_large' ? 'response_too_large' : 'response_encoding', { providerStatus: response.status });
      let body: unknown = null;
      try {
        body = read.text.length > 0 ? JSON.parse(read.text) : null;
      } catch {
        if (response.status === 200) return failure('AI_INVALID_RESPONSE', 'response_json', { providerStatus: 200 });
      }
      return response.status === 200 ? mapSuccess(body) : mapStatus(response.status, body, this.#now());
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    }
  }
}
