import type {
  MessageStore,
  RealtimeAuthorizer,
  RealtimeLogger,
  RealtimeSecurityPolicy,
  RecipientKeyVerifier,
  SessionResolver,
} from './contracts.ts';
import { COOKIE_NAME } from './cookies.ts';
import { createConsoleLogger } from './logger.ts';
import type { RateSetting } from './rateLimiter.ts';

export interface RealtimeLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerUser: number;
  readonly maxPendingHandshakes: number;
  readonly maxConversationsPerUser: number;
  readonly maxBlockedUsersPerUser: number;
  readonly maxPresenceSubjects: number;
  /** engine.io `maxHttpBufferSize`: largest accepted packet in bytes. */
  readonly maxPayloadBytes: number;
  /** Operational limit for `encryption.ciphertext` (base64 characters). */
  readonly maxCiphertextLength: number;
  readonly maxPendingAcksPerConnection: number;
  readonly maxPendingDeliveryAcksPerConnection: number;
  readonly maxTrackedTimestampKeys: number;
  readonly maxRevokedSessions: number;
  readonly maxPresencePreferences: number;
}

export interface RealtimeRates {
  /** Every known client event. */
  readonly events: RateSetting;
  readonly typing: RateSetting;
  readonly read: RateSetting;
  readonly send: RateSetting;
  readonly presence: RateSetting;
  /** Unknown events and malformed bodies; exhausting it disconnects the socket. */
  readonly invalid: RateSetting;
}

export interface RealtimeTiming {
  readonly adapterTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly pingTimeoutMs: number;
  readonly presenceRefreshIntervalMs: number;
  readonly typingTtlMs: number;
  /** `0` disables periodic session and grant revalidation. */
  readonly revalidationIntervalMs: number;
  readonly deliveryAckTimeoutMs: number;
  readonly maxClockSkewMs: number;
  readonly revokedSessionTtlMs: number;
  readonly shutdownTimeoutMs: number;
}

export interface RealtimeServerOptions {
  /** Exact browser origins allowed to connect. An empty list rejects every handshake. */
  readonly allowedOrigins: readonly string[];
  readonly path?: string;
  readonly namespace?: string;
  readonly sessionCookieName?: string;
  readonly sessionResolver?: SessionResolver;
  readonly authorizer?: RealtimeAuthorizer;
  readonly messageStore?: MessageStore;
  readonly recipientKeyVerifier?: RecipientKeyVerifier;
  readonly securityPolicy?: RealtimeSecurityPolicy;
  readonly logger?: RealtimeLogger;
  readonly limits?: Partial<RealtimeLimits>;
  readonly rates?: Partial<RealtimeRates>;
  readonly timing?: Partial<RealtimeTiming>;
}

export interface ResolvedRealtimeConfig {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly path: string;
  readonly namespace: string;
  readonly sessionCookieName: string;
  readonly sessionResolver: SessionResolver | null;
  readonly authorizer: RealtimeAuthorizer | null;
  readonly messageStore: MessageStore | null;
  readonly recipientKeyVerifier: RecipientKeyVerifier | null;
  readonly securityPolicy: RealtimeSecurityPolicy | null;
  readonly logger: RealtimeLogger;
  readonly limits: RealtimeLimits;
  readonly rates: RealtimeRates;
  readonly timing: RealtimeTiming;
}

export class RealtimeConfigError extends Error {
  override name = 'RealtimeConfigError';
}

export const DEFAULT_PATH = '/socket.io';
export const DEFAULT_NAMESPACE = '/';
export const DEFAULT_SESSION_COOKIE = 'secubuzz_session';
export const MAX_ALLOWED_ORIGINS = 64;
/** The 8.7A client expires presence 45 s after observation; refreshes must arrive well before that. */
export const MAX_PRESENCE_REFRESH_MS = 40_000;

export const DEFAULT_LIMITS: RealtimeLimits = Object.freeze({
  maxConnections: 10_000,
  maxConnectionsPerUser: 10,
  maxPendingHandshakes: 256,
  maxConversationsPerUser: 1_000,
  maxBlockedUsersPerUser: 5_000,
  maxPresenceSubjects: 1_000,
  maxPayloadBytes: 131_072,
  maxCiphertextLength: 65_536,
  maxPendingAcksPerConnection: 100,
  maxPendingDeliveryAcksPerConnection: 100,
  maxTrackedTimestampKeys: 100_000,
  maxRevokedSessions: 10_000,
  maxPresencePreferences: 100_000,
});

export const DEFAULT_RATES: RealtimeRates = Object.freeze({
  events: Object.freeze({ capacity: 120, refillPerSecond: 30 }),
  typing: Object.freeze({ capacity: 10, refillPerSecond: 2 }),
  read: Object.freeze({ capacity: 100, refillPerSecond: 20 }),
  send: Object.freeze({ capacity: 10, refillPerSecond: 1 }),
  presence: Object.freeze({ capacity: 5, refillPerSecond: 0.2 }),
  invalid: Object.freeze({ capacity: 10, refillPerSecond: 0.1 }),
});

export const DEFAULT_TIMING: RealtimeTiming = Object.freeze({
  adapterTimeoutMs: 4_000,
  handshakeTimeoutMs: 8_000,
  pingIntervalMs: 25_000,
  pingTimeoutMs: 20_000,
  presenceRefreshIntervalMs: 30_000,
  typingTtlMs: 6_000,
  revalidationIntervalMs: 60_000,
  deliveryAckTimeoutMs: 10_000,
  maxClockSkewMs: 300_000,
  revokedSessionTtlMs: 600_000,
  shutdownTimeoutMs: 2_000,
});

const LIMIT_RANGES: Readonly<Record<keyof RealtimeLimits, readonly [number, number]>> = {
  maxConnections: [1, 1_000_000],
  maxConnectionsPerUser: [1, 100],
  maxPendingHandshakes: [1, 10_000],
  maxConversationsPerUser: [1, 10_000],
  maxBlockedUsersPerUser: [0, 100_000],
  maxPresenceSubjects: [0, 10_000],
  maxPayloadBytes: [1_024, 2_097_152],
  maxCiphertextLength: [32, 1_400_000],
  maxPendingAcksPerConnection: [1, 1_000],
  maxPendingDeliveryAcksPerConnection: [0, 1_000],
  maxTrackedTimestampKeys: [100, 10_000_000],
  maxRevokedSessions: [10, 10_000_000],
  maxPresencePreferences: [10, 10_000_000],
};

const TIMING_RANGES: Readonly<Record<keyof RealtimeTiming, readonly [number, number]>> = {
  adapterTimeoutMs: [10, 30_000],
  handshakeTimeoutMs: [20, 30_000],
  pingIntervalMs: [1_000, 120_000],
  pingTimeoutMs: [1_000, 120_000],
  presenceRefreshIntervalMs: [20, MAX_PRESENCE_REFRESH_MS],
  typingTtlMs: [50, 30_000],
  revalidationIntervalMs: [0, 3_600_000],
  deliveryAckTimeoutMs: [20, 60_000],
  maxClockSkewMs: [1_000, 86_400_000],
  revokedSessionTtlMs: [1_000, 86_400_000],
  shutdownTimeoutMs: [0, 30_000],
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PATH = /^\/(?!\/)[A-Za-z0-9/._-]{1,127}$/;
const NAMESPACE = /^\/(?:[A-Za-z0-9._-]{1,64})?$/;

function fail(message: string): never {
  throw new RealtimeConfigError(message);
}

/**
 * Validates one allowed origin and returns its canonical form (`scheme://host[:port]`).
 * Rejects wildcards, `null`, credentials, paths, queries, fragments and plain HTTP for non-loopback hosts.
 */
export function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > 256 ||
    value.includes('*') || /\s/u.test(value)) fail('Allowed origins must be exact origins without wildcards or whitespace.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`Allowed origin is not a valid URL: ${JSON.stringify(value)}.`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash ||
    (url.pathname !== '/' && url.pathname !== '') || /[?#@]/u.test(value) || !/^https?:\/\/[^/]+\/?$/iu.test(value)) {
    fail(`Allowed origin must be scheme://host[:port] only: ${JSON.stringify(value)}.`);
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    fail(`Plain HTTP origins are allowed only for loopback hosts: ${JSON.stringify(value)}.`);
  }
  return url.origin;
}

function validatePath(value: string): string {
  if (!PATH.test(value) || value.split('/').some((part) => part === '.' || part === '..') || value.endsWith('/')) {
    fail('path must look like /socket.io: a leading slash, safe characters, no dot segments or trailing slash.');
  }
  return value;
}

function validateNamespace(value: string): string {
  if (!NAMESPACE.test(value)) fail('namespace must be "/" or a single segment such as "/realtime".');
  return value;
}

function validateCookieName(value: string): string {
  if (!COOKIE_NAME.test(value)) fail('sessionCookieName must be an RFC 6265 cookie-name token.');
  return value;
}

function hasMethods(name: string, adapter: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (adapter === null || typeof adapter !== 'object') fail(`${name} must be an object.`);
  const record = adapter as Record<string, unknown>;
  for (const method of required) if (typeof record[method] !== 'function') fail(`${name}.${method} must be a function.`);
  for (const method of optional) {
    if (record[method] !== undefined && typeof record[method] !== 'function') fail(`${name}.${method} must be a function when provided.`);
  }
}

function resolveNumbers<Shape extends object>(
  label: string,
  defaults: Shape,
  overrides: Partial<Shape> | undefined,
  ranges: Readonly<Record<keyof Shape, readonly [number, number]>>,
): Shape {
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object')) fail(`${label} must be an object.`);
  const result: Record<string, number> = {};
  for (const key of Object.keys(defaults) as Array<keyof Shape & string>) {
    const value = overrides?.[key] ?? defaults[key];
    const [minimum, maximum] = ranges[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
      fail(`${label}.${key} must be an integer between ${minimum} and ${maximum}.`);
    }
    result[key] = value;
  }
  for (const key of Object.keys(overrides ?? {})) if (!(key in defaults)) fail(`${label}.${key} is not a known setting.`);
  return Object.freeze(result) as Shape;
}

function resolveRates(overrides: Partial<RealtimeRates> | undefined): RealtimeRates {
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object')) fail('rates must be an object.');
  const result: Record<string, RateSetting> = {};
  for (const key of Object.keys(DEFAULT_RATES) as Array<keyof RealtimeRates>) {
    const setting = overrides?.[key] ?? DEFAULT_RATES[key];
    if (setting === null || typeof setting !== 'object' || !Number.isInteger(setting.capacity) || setting.capacity < 1 ||
      setting.capacity > 10_000 || typeof setting.refillPerSecond !== 'number' || !Number.isFinite(setting.refillPerSecond) ||
      setting.refillPerSecond < 0 || setting.refillPerSecond > 10_000) {
      fail(`rates.${key} needs an integer capacity of 1–10000 and a refillPerSecond of 0–10000.`);
    }
    result[key] = Object.freeze({ capacity: setting.capacity, refillPerSecond: setting.refillPerSecond });
  }
  for (const key of Object.keys(overrides ?? {})) if (!(key in DEFAULT_RATES)) fail(`rates.${key} is not a known setting.`);
  return Object.freeze(result) as unknown as RealtimeRates;
}

/** Validates options once at startup. Throws {@link RealtimeConfigError} on any invalid value. */
export function resolveRealtimeConfig(options: RealtimeServerOptions): ResolvedRealtimeConfig {
  if (options === null || typeof options !== 'object') fail('Realtime server options are required.');
  if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length > MAX_ALLOWED_ORIGINS) {
    fail(`allowedOrigins must be an array of at most ${MAX_ALLOWED_ORIGINS} exact origins.`);
  }
  const allowedOrigins = new Set(options.allowedOrigins.map(normalizeOrigin));
  const limits = resolveNumbers('limits', DEFAULT_LIMITS, options.limits, LIMIT_RANGES);
  if (limits.maxCiphertextLength >= limits.maxPayloadBytes) fail('limits.maxCiphertextLength must be below limits.maxPayloadBytes.');
  const timing = resolveNumbers('timing', DEFAULT_TIMING, options.timing, TIMING_RANGES);
  if (timing.handshakeTimeoutMs < timing.adapterTimeoutMs) fail('timing.handshakeTimeoutMs must be at least timing.adapterTimeoutMs.');
  if (timing.revalidationIntervalMs !== 0 && timing.revalidationIntervalMs < 20) fail('timing.revalidationIntervalMs must be 0 or at least 20.');
  if (options.sessionResolver !== undefined) hasMethods('sessionResolver', options.sessionResolver, ['resolveSession'], ['checkSession']);
  if (options.authorizer !== undefined) {
    hasMethods('authorizer', options.authorizer, ['listConversationIds', 'listBlockedUserIds', 'filterPresenceSubjects']);
  }
  if (options.messageStore !== undefined) hasMethods('messageStore', options.messageStore, ['findMessage', 'recordReceipt', 'storeMessage']);
  if (options.recipientKeyVerifier !== undefined) hasMethods('recipientKeyVerifier', options.recipientKeyVerifier, ['verifyEnvelope']);
  if (options.securityPolicy !== undefined) hasMethods('securityPolicy', options.securityPolicy, [], ['evaluateConnection', 'evaluateEvent']);
  if (options.logger !== undefined) hasMethods('logger', options.logger, ['log']);
  return Object.freeze({
    allowedOrigins,
    path: validatePath(options.path ?? DEFAULT_PATH),
    namespace: validateNamespace(options.namespace ?? DEFAULT_NAMESPACE),
    sessionCookieName: validateCookieName(options.sessionCookieName ?? DEFAULT_SESSION_COOKIE),
    sessionResolver: options.sessionResolver ?? null,
    authorizer: options.authorizer ?? null,
    messageStore: options.messageStore ?? null,
    recipientKeyVerifier: options.recipientKeyVerifier ?? null,
    securityPolicy: options.securityPolicy ?? null,
    logger: options.logger ?? createConsoleLogger(),
    limits,
    rates: resolveRates(options.rates),
    timing,
  });
}

export interface StandaloneConfig {
  readonly host: string;
  readonly port: number;
  readonly options: RealtimeServerOptions;
}

/** Maps `REALTIME_*` environment variables to options for `src/main.ts`. No adapters come from the environment. */
export function loadStandaloneConfig(env: NodeJS.ProcessEnv): StandaloneConfig {
  const host = env.REALTIME_HOST ?? '127.0.0.1';
  if (!host || host.length > 255 || /[\s/]/u.test(host)) fail('REALTIME_HOST must be a host name or address.');
  const portText = env.REALTIME_PORT ?? '5100';
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port > 65_535) fail('REALTIME_PORT must be an integer from 0 to 65535.');
  const allowedOrigins = (env.REALTIME_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  return {
    host,
    port,
    options: {
      allowedOrigins,
      ...(env.REALTIME_PATH ? { path: env.REALTIME_PATH } : {}),
      ...(env.REALTIME_NAMESPACE ? { namespace: env.REALTIME_NAMESPACE } : {}),
      ...(env.REALTIME_SESSION_COOKIE ? { sessionCookieName: env.REALTIME_SESSION_COOKIE } : {}),
    },
  };
}
