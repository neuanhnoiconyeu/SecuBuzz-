/**
 * Validated AI configuration from environment variables.
 *
 * Remote AI is off unless `AI_REMOTE_ENABLED` is exactly `true`. Enabling it requires the Gemini
 * key, the allowlisted model and the project quota figures copied from AI Studio; nothing about
 * Google's limits is defaulted. The key and the consent secret live in private fields, so they are
 * absent from `JSON.stringify`, `util.inspect` and log fields. Error messages never contain them.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { DEFAULT_SESSION_COOKIE, MAX_ALLOWED_ORIGINS, normalizeOrigin, RealtimeConfigError } from '../realtime/config.ts';
import { COOKIE_NAME } from '../realtime/cookies.ts';
import { AI_CONTRACT_MAX_INPUT, AI_PROVIDER_NAME, AI_SUPPORTED_MODELS, type AiModel } from './protocol.ts';

export class AiConfigError extends Error {
  override name = 'AiConfigError';
}

export interface AiLimits {
  /** SecuBuzz policy, not a Google quota. */
  readonly userPerMinute: number;
  /** SecuBuzz policy, not a Google quota. */
  readonly userPerDay: number;
  /** Google project RPM from AI Studio. `null` only while remote AI is disabled. */
  readonly projectPerMinute: number | null;
  /** Google project RPD from AI Studio. `null` only while remote AI is disabled. */
  readonly projectPerDay: number | null;
  /** Active provider calls per quota scope. One per user is fixed policy. */
  readonly maxConcurrent: number;
  readonly maxInputChars: number;
  /** Gemini `maxOutputTokens`; it includes thinking tokens. */
  readonly maxOutputTokens: number;
}

export const AI_LIMIT_DEFAULTS = Object.freeze({
  userPerMinute: 3,
  userPerDay: 25,
  maxConcurrent: 2,
  maxInputChars: AI_CONTRACT_MAX_INPUT,
  maxOutputTokens: 2_048,
  timeoutMs: 12_000,
});

/** Below the client's 15-second deadline in `executeAIRequest`. */
export const AI_TIMEOUT_RANGE = Object.freeze([1_000, 14_000] as const);
export const AI_OUTPUT_TOKEN_RANGE = Object.freeze([256, 3_000] as const);
const QUOTA_SCOPE = /^[A-Za-z0-9._-]{1,64}$/;
const API_KEY = /^[\x21-\x7e]{20,512}$/;
const MIN_CONSENT_SECRET = 32;
const MAX_CONSENT_SECRET = 512;

interface AiConfigFields {
  readonly enabled: boolean;
  readonly production: boolean;
  readonly provider: typeof AI_PROVIDER_NAME;
  readonly model: AiModel;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly sessionCookieName: string;
  readonly limits: AiLimits;
  readonly timeoutMs: number;
  readonly quotaScope: string;
  readonly localDevMemoryQuota: boolean;
  readonly consentSecretSource: 'configured' | 'ephemeral';
}

export class AiConfig implements AiConfigFields {
  readonly enabled: boolean;
  readonly production: boolean;
  readonly provider: typeof AI_PROVIDER_NAME;
  readonly model: AiModel;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly sessionCookieName: string;
  readonly limits: AiLimits;
  readonly timeoutMs: number;
  readonly quotaScope: string;
  readonly localDevMemoryQuota: boolean;
  readonly consentSecretSource: 'configured' | 'ephemeral';
  readonly #apiKey: string | null;
  readonly #consentSecret: Buffer;

  constructor(fields: AiConfigFields, apiKey: string | null, consentSecret: Buffer) {
    this.enabled = fields.enabled;
    this.production = fields.production;
    this.provider = fields.provider;
    this.model = fields.model;
    this.allowedOrigins = fields.allowedOrigins;
    this.sessionCookieName = fields.sessionCookieName;
    this.limits = Object.freeze({ ...fields.limits });
    this.timeoutMs = fields.timeoutMs;
    this.quotaScope = fields.quotaScope;
    this.localDevMemoryQuota = fields.localDevMemoryQuota;
    this.consentSecretSource = fields.consentSecretSource;
    this.#apiKey = apiKey;
    this.#consentSecret = Buffer.from(consentSecret);
    Object.freeze(this);
  }

  /** True when a usable key is held. The key itself is only available to the provider adapter. */
  get apiKeyConfigured(): boolean {
    return this.#apiKey !== null;
  }

  /** Server-only. Pass it to the Gemini adapter and nowhere else; never log or return it. */
  geminiApiKey(): string | null {
    return this.#apiKey;
  }

  /** HMAC-SHA256 under the consent secret. The secret itself never leaves this object. */
  consentMac(data: string): Buffer {
    return createHmac('sha256', this.#consentSecret).update(data, 'utf8').digest();
  }

  toJSON(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      provider: this.provider,
      model: this.model,
      allowedOrigins: [...this.allowedOrigins],
      sessionCookieName: this.sessionCookieName,
      limits: this.limits,
      timeoutMs: this.timeoutMs,
      quotaScope: this.quotaScope,
      localDevMemoryQuota: this.localDevMemoryQuota,
      consentSecretSource: this.consentSecretSource,
      apiKeyConfigured: this.apiKeyConfigured,
    };
  }
}

function fail(message: string): never {
  throw new AiConfigError(message);
}

/** Unset and empty values are treated the same. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function integer(env: NodeJS.ProcessEnv, name: string, minimum: number, maximum: number, fallback: number): number;
function integer(env: NodeJS.ProcessEnv, name: string, minimum: number, maximum: number, fallback: null): number | null;
function integer(env: NodeJS.ProcessEnv, name: string, minimum: number, maximum: number, fallback: number | null): number | null {
  const text = read(env, name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!/^\d{1,9}$/.test(text) || value < minimum || value > maximum) fail(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function parseOrigins(text: string | undefined): ReadonlySet<string> {
  const entries = (text ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (entries.length > MAX_ALLOWED_ORIGINS) fail(`AI_ALLOWED_ORIGINS accepts at most ${MAX_ALLOWED_ORIGINS} origins.`);
  try {
    return new Set(entries.map(normalizeOrigin));
  } catch (error) {
    // normalizeOrigin messages are authored by the realtime config module and contain no secrets.
    if (error instanceof RealtimeConfigError) fail(`AI_ALLOWED_ORIGINS: ${error.message}`);
    throw error;
  }
}

export interface LoadAiConfigOptions {
  /** Test seam for the per-process consent secret. */
  readonly randomSecret?: () => Buffer;
}

/**
 * Validates AI settings once at startup. Throws {@link AiConfigError} on any invalid value,
 * including settings that are present but unused while remote AI is disabled.
 */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env, options: LoadAiConfigOptions = {}): AiConfig {
  if (env === null || typeof env !== 'object') fail('An environment object is required.');
  const production = env.NODE_ENV === 'production';
  const enabled = env.AI_REMOTE_ENABLED === 'true';
  const key = read(env, 'GEMINI_API_KEY');

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('NEXT_PUBLIC_')) continue;
    if (/GEMINI/i.test(name)) fail('Gemini settings must never use NEXT_PUBLIC_* variables; those are sent to browsers.');
    if (key !== undefined && value === key) fail('A NEXT_PUBLIC_* variable holds the Gemini API key; remove it, it would be sent to browsers.');
  }

  const providerText = read(env, 'AI_PROVIDER');
  if (providerText !== undefined && providerText !== AI_PROVIDER_NAME) fail('AI_PROVIDER must be "gemini"; no other provider is supported.');
  if (enabled && providerText === undefined) fail('AI_PROVIDER=gemini is required when AI_REMOTE_ENABLED=true.');

  const modelText = read(env, 'GEMINI_MODEL');
  if (modelText !== undefined && !(AI_SUPPORTED_MODELS as readonly string[]).includes(modelText)) {
    fail(`GEMINI_MODEL must be ${AI_SUPPORTED_MODELS.join(' or ')}; other models are not allowed.`);
  }
  if (enabled && modelText === undefined) fail('GEMINI_MODEL is required when AI_REMOTE_ENABLED=true.');
  const model = (modelText ?? AI_SUPPORTED_MODELS[0]) as AiModel;

  if (enabled && (key === undefined || !API_KEY.test(key))) {
    fail('GEMINI_API_KEY must be set to 20-512 printable characters without whitespace when AI_REMOTE_ENABLED=true.');
  }

  const projectPerMinute = integer(env, 'AI_PROJECT_RPM', 1, 100_000, null);
  const projectPerDay = integer(env, 'AI_PROJECT_RPD', 1, 100_000, null);
  if (enabled && (projectPerMinute === null || projectPerDay === null)) {
    fail('AI_PROJECT_RPM and AI_PROJECT_RPD are required when AI_REMOTE_ENABLED=true. Copy them from the AI Studio rate-limit page.');
  }
  const limits: AiLimits = {
    userPerMinute: integer(env, 'AI_USER_RPM', 1, 1_000, AI_LIMIT_DEFAULTS.userPerMinute),
    userPerDay: integer(env, 'AI_USER_RPD', 1, 100_000, AI_LIMIT_DEFAULTS.userPerDay),
    projectPerMinute,
    projectPerDay,
    maxConcurrent: integer(env, 'AI_MAX_CONCURRENT', 1, 100, AI_LIMIT_DEFAULTS.maxConcurrent),
    maxInputChars: integer(env, 'AI_MAX_INPUT_CHARS', 1, AI_CONTRACT_MAX_INPUT, AI_LIMIT_DEFAULTS.maxInputChars),
    maxOutputTokens: integer(env, 'AI_MAX_OUTPUT_TOKENS', AI_OUTPUT_TOKEN_RANGE[0], AI_OUTPUT_TOKEN_RANGE[1], AI_LIMIT_DEFAULTS.maxOutputTokens),
  };
  const timeoutMs = integer(env, 'AI_TIMEOUT_MS', AI_TIMEOUT_RANGE[0], AI_TIMEOUT_RANGE[1], AI_LIMIT_DEFAULTS.timeoutMs);

  const quotaScope = read(env, 'AI_QUOTA_SCOPE') ?? 'default';
  if (!QUOTA_SCOPE.test(quotaScope)) fail('AI_QUOTA_SCOPE must be 1-64 letters, digits, dots, underscores or hyphens.');

  const sessionCookieName = read(env, 'AI_SESSION_COOKIE') ?? DEFAULT_SESSION_COOKIE;
  if (!COOKIE_NAME.test(sessionCookieName)) fail('AI_SESSION_COOKIE must be an RFC 6265 cookie-name token.');

  const localDevMemoryQuota = env.AI_LOCAL_DEV_MEMORY_QUOTA === 'true';
  if (localDevMemoryQuota && production) fail('AI_LOCAL_DEV_MEMORY_QUOTA=true is for local development only and is refused when NODE_ENV=production.');

  const secretText = read(env, 'AI_CONSENT_SECRET');
  let consentSecret: Buffer;
  let consentSecretSource: 'configured' | 'ephemeral';
  if (secretText !== undefined) {
    if (secretText.length < MIN_CONSENT_SECRET || secretText.length > MAX_CONSENT_SECRET || /\s/u.test(secretText)) {
      fail(`AI_CONSENT_SECRET must be ${MIN_CONSENT_SECRET}-${MAX_CONSENT_SECRET} characters without whitespace.`);
    }
    consentSecret = Buffer.from(secretText, 'utf8');
    consentSecretSource = 'configured';
  } else {
    if (enabled && production) fail('AI_CONSENT_SECRET is required when AI_REMOTE_ENABLED=true and NODE_ENV=production.');
    consentSecret = (options.randomSecret ?? (() => randomBytes(32)))();
    consentSecretSource = 'ephemeral';
  }

  if (enabled && env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    fail('NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate checks; remove it. Use node --use-system-ca for operating-system trust.');
  }

  return new AiConfig({
    enabled,
    production,
    provider: AI_PROVIDER_NAME,
    model,
    allowedOrigins: parseOrigins(read(env, 'AI_ALLOWED_ORIGINS')),
    sessionCookieName,
    limits,
    timeoutMs,
    quotaScope,
    localDevMemoryQuota,
    consentSecretSource,
  }, enabled ? key as string : null, consentSecret);
}
