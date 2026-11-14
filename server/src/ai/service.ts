/**
 * The AI pipeline after authentication and CSRF verification:
 * validate → privacy → breaker → consent token → single-use nonce → atomic reservation →
 * one provider call → lease release → output. Every refusal happens before the provider call.
 */
import { randomUUID } from 'node:crypto';
import { callAdapter } from '../realtime/adapterCall.ts';
import type { RealtimeLogger } from '../realtime/contracts.ts';
import { safeLog } from '../realtime/logger.ts';
import type { AiConfig } from './config.ts';
import { AI_DISCLOSURE, computePayloadDigest, issueConsentToken, verifyConsentToken } from './consent.ts';
import type { AiTextProvider, ProviderOutcome } from './gemini.ts';
import { assessPrivacy } from './privacy.ts';
import { buildPrompt } from './prompts.ts';
import type { AiConsentResponse, AiErrorCode, AiGenerationResponse, AiTask } from './protocol.ts';
import { parseReservation, type AiUsageStore, type BreakerCode, type ProviderBreaker } from './usage.ts';
import { parseConsentBody, parseGenerationBody } from './validation.ts';

/** Identity from the Session resolver. Never from the request body. */
export interface AiActor {
  readonly userId: string;
  readonly sessionId: string;
}

export type AiServiceResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
    readonly ok: false;
    readonly code: AiErrorCode;
    /** Log-only reason code. */
    readonly reason: string;
    readonly retryAfterSeconds?: number;
    readonly task?: AiTask;
  };

export interface AiServiceOptions {
  readonly config: AiConfig;
  readonly usageStore: AiUsageStore;
  readonly provider: AiTextProvider;
  readonly breaker: ProviderBreaker;
  readonly logger: RealtimeLogger;
  readonly now: () => number;
  readonly adapterTimeoutMs: number;
}

/** Lease lifetime beyond the provider timeout, so a crashed process cannot block a user for long. */
const LEASE_MARGIN_MS = 5_000;
/** Retry-After for a refused concurrent request. */
const BUSY_RETRY_SECONDS = 2;
const BREAKER_CODES = new Set<AiErrorCode>(['AI_RATE_LIMITED', 'AI_DAILY_QUOTA_EXHAUSTED', 'AI_PROVIDER_UNAVAILABLE']);

function refused(code: AiErrorCode, reason: string, extra: { retryAfterSeconds?: number; task?: AiTask } = {}): AiServiceResult<never> {
  return { ok: false, code, reason, ...extra };
}

export class AiService {
  readonly #options: AiServiceOptions;
  /** Google applies quotas per project and model; all processes and keys of one project share this scope. */
  readonly scope: string;

  constructor(options: AiServiceOptions) {
    this.#options = options;
    this.scope = `${options.config.quotaScope}:${options.config.model}`;
  }

  issueConsent(actor: AiActor, body: unknown): AiServiceResult<AiConsentResponse> {
    const { config, logger, now } = this.#options;
    const parsed = parseConsentBody(body);
    if (!parsed.ok) return refused(parsed.code, parsed.reason);
    if (parsed.value.disclosureVersion !== AI_DISCLOSURE.version) return refused('AI_CONSENT_REQUIRED', 'consent_disclosure');
    const issued = issueConsentToken(config, { sessionId: actor.sessionId, payloadDigest: parsed.value.payloadDigest, nowMs: now() });
    safeLog(logger, 'info', 'ai.consent.issued', { disclosureVersion: AI_DISCLOSURE.version });
    return { ok: true, value: { consentToken: issued.token } };
  }

  #release(reservationId: string): void {
    const { usageStore, adapterTimeoutMs, logger } = this.#options;
    void callAdapter(() => usageStore.release(this.scope, reservationId), adapterTimeoutMs).then((result) => {
      if (!result.ok) safeLog(logger, 'warn', 'ai.usage.release_failed', { reason: result.reason });
    });
  }

  async generate(actor: AiActor, body: unknown, signal: AbortSignal): Promise<AiServiceResult<AiGenerationResponse>> {
    const { config, usageStore, provider, breaker, logger, now, adapterTimeoutMs } = this.#options;
    const started = now();
    const parsed = parseGenerationBody(body, config.limits.maxInputChars);
    if (!parsed.ok) return refused(parsed.code, parsed.reason);
    const { request, consentToken } = parsed.value;
    const task = request.task;

    const privacy = assessPrivacy(request);
    if (!privacy.allowed) return refused('AI_PRIVACY_RESTRICTED', privacy.reason, { task });

    const { limits } = config;
    const scopePerMinute = limits.projectPerMinute;
    const scopePerDay = limits.projectPerDay;
    if (scopePerMinute === null || scopePerDay === null) return refused('AI_NOT_CONFIGURED', 'project_limits', { task });
    const circuit = breaker.state(started);
    if (circuit.open) return refused(circuit.code, 'breaker_open', { retryAfterSeconds: circuit.retryAfterSeconds, task });

    if (consentToken === null) return refused('AI_CONSENT_REQUIRED', 'consent_missing', { task });
    const consent = verifyConsentToken(config, consentToken, {
      sessionId: actor.sessionId,
      payloadDigest: computePayloadDigest(request),
      nowMs: started,
    });
    if (!consent.ok) return refused('AI_CONSENT_REQUIRED', consent.reason, { task });
    const consumed = await callAdapter(
      () => usageStore.consumeConsentNonce(this.scope, consent.nonce, new Date(consent.expiresAtMs), new Date(started)),
      adapterTimeoutMs,
    );
    if (!consumed.ok) return refused('AI_SERVICE_UNAVAILABLE', `nonce_${consumed.reason}`, { task });
    if (consumed.value !== true) return refused('AI_CONSENT_REQUIRED', 'consent_replayed', { task });
    if (signal.aborted) return refused('AI_CANCELLED', 'client_cancelled', { task });

    const reservationId = randomUUID();
    const reservedAt = now();
    const reserved = await callAdapter(() => usageStore.reserve({
      scope: this.scope,
      userId: actor.userId,
      reservationId,
      now: new Date(reservedAt),
      leaseExpiresAt: new Date(reservedAt + config.timeoutMs + LEASE_MARGIN_MS),
      limits: {
        userPerMinute: limits.userPerMinute,
        userPerDay: limits.userPerDay,
        scopePerMinute,
        scopePerDay,
        maxConcurrentPerScope: limits.maxConcurrent,
      },
    }), adapterTimeoutMs);
    if (!reserved.ok) {
      // A late success may still have created the lease; release it. The count is kept (conservative).
      this.#release(reservationId);
      return refused('AI_SERVICE_UNAVAILABLE', `reserve_${reserved.reason}`, { task });
    }
    const reservation = parseReservation(reserved.value);
    if (!reservation) {
      this.#release(reservationId);
      return refused('AI_SERVICE_UNAVAILABLE', 'reserve_malformed', { task });
    }
    switch (reservation.status) {
      case 'reserved':
        break;
      case 'user_busy':
      case 'scope_busy':
        return refused('AI_RATE_LIMITED', reservation.status, { retryAfterSeconds: BUSY_RETRY_SECONDS, task });
      case 'user_minute':
      case 'scope_minute':
        return refused('AI_RATE_LIMITED', reservation.status, { retryAfterSeconds: reservation.retryAfterSeconds, task });
      case 'user_day':
      case 'scope_day':
        return refused('AI_DAILY_QUOTA_EXHAUSTED', reservation.status, { retryAfterSeconds: reservation.retryAfterSeconds, task });
    }

    let outcome: ProviderOutcome;
    try {
      outcome = await provider.generate(buildPrompt(request), signal);
    } catch {
      outcome = {
        ok: false,
        code: 'AI_INTERNAL_ERROR',
        reason: 'provider_threw',
        diagnostics: { providerStatus: null, providerStatusText: null, providerReason: null, networkCode: null },
      };
    } finally {
      this.#release(reservationId);
    }

    const durationMs = Math.max(0, now() - started);
    if (!outcome.ok) {
      if (outcome.breakerSeconds !== undefined && BREAKER_CODES.has(outcome.code)) {
        breaker.open(outcome.code as BreakerCode, now(), outcome.breakerSeconds);
        safeLog(logger, 'warn', 'ai.breaker.opened', { code: outcome.code, seconds: outcome.breakerSeconds });
      }
      safeLog(logger, outcome.code === 'AI_CANCELLED' ? 'info' : 'warn', 'ai.provider.failed', {
        task,
        code: outcome.code,
        reason: outcome.reason,
        durationMs,
        ...outcome.diagnostics,
      });
      return refused(outcome.code, outcome.reason, {
        task,
        ...(outcome.retryAfterSeconds !== undefined ? { retryAfterSeconds: outcome.retryAfterSeconds } : {}),
      });
    }
    safeLog(logger, 'info', 'ai.request.completed', {
      task,
      durationMs,
      promptTokens: outcome.usage.promptTokens,
      outputTokens: outcome.usage.outputTokens,
      thoughtsTokens: outcome.usage.thoughtsTokens,
      totalTokens: outcome.usage.totalTokens,
      serviceTier: outcome.serviceTier,
    });
    return { ok: true, value: { output: outcome.text, kind: 'answer' } };
  }
}
