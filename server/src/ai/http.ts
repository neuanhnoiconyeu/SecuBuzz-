/**
 * Mountable HTTP handler for the AI API: `POST {basePath}/consent` and `POST {basePath}/requests`.
 *
 * Works with Express (`app.use('/api/ai', handler)`; mount it before any body parser) and with a
 * plain `node:http` server. Missing Database Team adapters fail closed with AI_NOT_CONFIGURED.
 * Authentication and CSRF checks run before the body is read. Responses never carry CORS headers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { callAdapter } from '../realtime/adapterCall.ts';
import { DEFAULT_TIMING } from '../realtime/config.ts';
import type { HandshakeContext, RealtimeLogger, SessionResolver } from '../realtime/contracts.ts';
import { extractSessionCookie } from '../realtime/cookies.ts';
import { createConsoleLogger, safeLog } from '../realtime/logger.ts';
import { isDemoIdentity, parseSessionResolution } from '../realtime/validation.ts';
import { AiConfig, AiConfigError } from './config.ts';
import { GeminiProvider } from './gemini.ts';
import { AI_ERRORS, AI_MAX_BODY_BYTES, aiErrorBody, DEFAULT_AI_BASE_PATH, type AiErrorCode, type AiTask } from './protocol.ts';
import { AiService, type AiActor, type AiServiceResult } from './service.ts';
import { MemoryAiUsageStore, ProviderBreaker, type AiUsageStore } from './usage.ts';

export interface AiCsrfInput {
  readonly sessionId: string;
  readonly userId: string;
  /** Value of the `X-CSRF-Token` header. Secret: never log it. */
  readonly token: string;
}

/**
 * Database Team adapter: returns `true` only when `token` is the CSRF token issued for this
 * authenticated session (the one the client reads from `meta[name="secubuzz-csrf-token"]`).
 */
export interface AiCsrfVerifier {
  verify(input: AiCsrfInput): Promise<boolean> | boolean;
}

export interface AiHttpHandlerOptions {
  /** From {@link loadAiConfig}. */
  readonly config: AiConfig;
  /** Database Team session contract shared with the realtime server. Missing → AI_NOT_CONFIGURED. */
  readonly sessionResolver?: SessionResolver;
  /** Database Team CSRF verification. Missing → AI_NOT_CONFIGURED. */
  readonly csrfVerifier?: AiCsrfVerifier;
  /** Durable shared store in production. Missing → AI_NOT_CONFIGURED unless AI_LOCAL_DEV_MEMORY_QUOTA=true. */
  readonly usageStore?: AiUsageStore;
  readonly logger?: RealtimeLogger;
  /** Default `/api/ai`. Matched against `req.originalUrl` (Express) or `req.url`. */
  readonly basePath?: string;
  /** Deadline for each Session resolver, CSRF verifier and usage store call. Default 4,000 ms. */
  readonly adapterTimeoutMs?: number;
  /** Deadline for receiving the request body. Default 10,000 ms. */
  readonly bodyTimeoutMs?: number;
  /** Test seam for the Gemini call. Production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seam for time. */
  readonly now?: () => number;
}

export type AiHttpHandler = (request: IncomingMessage, response: ServerResponse, next?: (error?: unknown) => void) => void;

const SECURITY_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});
const BASE_PATH = /^\/(?!\/)[A-Za-z0-9/._-]{1,127}$/;
const CSRF_TOKEN = /^[\x21-\x7e]{1,512}$/;
const MAX_USER_AGENT = 512;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;

type Route = 'consent' | 'requests';

interface Rejection {
  readonly code: AiErrorCode;
  readonly reason: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly task?: AiTask;
}

function fail(message: string): never {
  throw new AiConfigError(message);
}

function requireMethods(name: string, value: unknown, methods: readonly string[]): void {
  if (value === null || typeof value !== 'object') fail(`${name} must be an object.`);
  for (const method of methods) {
    if (typeof (value as Record<string, unknown>)[method] !== 'function') fail(`${name}.${method} must be a function.`);
  }
}

function bounded(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  const text = JSON.stringify(body);
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-length': String(Buffer.byteLength(text)), ...headers });
  response.end(text);
}

function contentTypeAccepted(request: IncomingMessage): boolean {
  const type = request.headers['content-type'];
  if (typeof type !== 'string') return false;
  const [media, ...parameters] = type.split(';').map((part) => part.trim().toLowerCase());
  if (media !== 'application/json') return false;
  const encoding = request.headers['content-encoding'];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') return false;
  return parameters.every((parameter) => parameter === '' || parameter === 'charset=utf-8' || parameter === 'charset="utf-8"');
}

type BodyResult = { readonly ok: true; readonly bytes: Buffer } | ({ readonly ok: false } & Rejection);

function readBody(request: IncomingMessage, limit: number, timeoutMs: number): Promise<BodyResult> {
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    if (!/^\d{1,12}$/.test(declared)) return Promise.resolve({ ok: false, code: 'AI_INVALID_REQUEST', reason: 'content_length' });
    if (Number(declared) > limit) return Promise.resolve({ ok: false, code: 'AI_INPUT_TOO_LARGE', reason: 'body_too_large' });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('close', onClose);
      if (!result.ok) request.resume(); // Discard the rest; the response closes the connection.
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish({ ok: false, code: 'AI_INPUT_TOO_LARGE', reason: 'body_too_large' });
      else chunks.push(chunk);
    };
    const onEnd = () => finish({ ok: true, bytes: Buffer.concat(chunks) });
    const onError = () => finish({ ok: false, code: 'AI_INVALID_REQUEST', reason: 'body_error' });
    const onClose = () => finish({ ok: false, code: 'AI_CANCELLED', reason: 'client_closed' });
    const timer = setTimeout(() => finish({ ok: false, code: 'AI_TIMEOUT', status: 408, reason: 'body_timeout' }), timeoutMs);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('close', onClose);
  });
}

/**
 * Creates the AI API handler. Throws {@link AiConfigError} for invalid options, including a
 * `memory` usage store in production.
 */
export function createAiHttpHandler(options: AiHttpHandlerOptions): AiHttpHandler {
  if (options === null || typeof options !== 'object') fail('AI handler options are required.');
  const { config } = options;
  if (!(config instanceof AiConfig)) fail('config must be created by loadAiConfig().');
  if (options.sessionResolver !== undefined) requireMethods('sessionResolver', options.sessionResolver, ['resolveSession']);
  if (options.csrfVerifier !== undefined) requireMethods('csrfVerifier', options.csrfVerifier, ['verify']);
  if (options.usageStore !== undefined) {
    requireMethods('usageStore', options.usageStore, ['reserve', 'release', 'consumeConsentNonce']);
    if (options.usageStore.kind !== 'memory' && options.usageStore.kind !== 'durable') fail('usageStore.kind must be "memory" or "durable".');
  }
  if (options.logger !== undefined) requireMethods('logger', options.logger, ['log']);
  if (options.fetch !== undefined && typeof options.fetch !== 'function') fail('fetch must be a function.');
  if (options.now !== undefined && typeof options.now !== 'function') fail('now must be a function.');
  const basePath = options.basePath ?? DEFAULT_AI_BASE_PATH;
  if (!BASE_PATH.test(basePath) || basePath.endsWith('/') || basePath.split('/').some((part) => part === '.' || part === '..')) {
    fail('basePath must look like /api/ai: a leading slash, safe characters, no dot segments or trailing slash.');
  }
  const adapterTimeoutMs = bounded('adapterTimeoutMs', options.adapterTimeoutMs ?? DEFAULT_TIMING.adapterTimeoutMs, 10, 10_000);
  const bodyTimeoutMs = bounded('bodyTimeoutMs', options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS, 10, 30_000);

  const production = config.production || process.env.NODE_ENV === 'production';
  const usageStore = options.usageStore ?? (config.localDevMemoryQuota && !production ? new MemoryAiUsageStore() : null);
  if (usageStore?.kind === 'memory' && production) fail('A memory usage store is for local development only; production needs a durable shared store.');
  const logger = options.logger ?? createConsoleLogger();
  const now = options.now ?? Date.now;
  const resolver = options.sessionResolver ?? null;
  const csrfVerifier = options.csrfVerifier ?? null;
  const apiKey = config.geminiApiKey();
  const service = config.enabled && apiKey !== null && usageStore !== null
    ? new AiService({
      config,
      usageStore,
      provider: new GeminiProvider({
        model: config.model,
        apiKey,
        timeoutMs: config.timeoutMs,
        maxOutputTokens: config.limits.maxOutputTokens,
        now,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      breaker: new ProviderBreaker(),
      logger,
      now,
      adapterTimeoutMs,
    })
    : null;
  const routes = new Map<string, Route>([[`${basePath}/consent`, 'consent'], [`${basePath}/requests`, 'requests']]);

  function reject(response: ServerResponse, route: Route | 'unknown', rejection: Rejection, closeConnection: boolean): void {
    const status = rejection.status ?? AI_ERRORS[rejection.code].status;
    const level = rejection.code === 'AI_INTERNAL_ERROR' ? 'error' : status >= 500 ? 'warn' : 'info';
    safeLog(logger, level, 'ai.request.rejected', {
      route,
      code: rejection.code,
      reason: rejection.reason,
      ...(rejection.task ? { task: rejection.task } : {}),
    });
    const headers: Record<string, string> = {};
    if (rejection.retryAfterSeconds !== undefined) headers['retry-after'] = String(rejection.retryAfterSeconds);
    if (closeConnection) headers.connection = 'close';
    if (rejection.code === 'AI_METHOD_NOT_ALLOWED') headers.allow = 'POST';
    send(response, status, aiErrorBody(rejection.code), headers);
  }

  async function authenticate(request: IncomingMessage, origin: string, activeResolver: SessionResolver): Promise<{ ok: true; actor: AiActor } | ({ ok: false } & Rejection)> {
    const cookie = extractSessionCookie(request.headers.cookie, config.sessionCookieName);
    if (cookie.status === 'absent') return { ok: false, code: 'AI_AUTH_REQUIRED', reason: 'cookie_absent' };
    if (cookie.status === 'malformed') return { ok: false, code: 'AI_AUTH_REQUIRED', reason: 'cookie_malformed' };
    const userAgent = request.headers['user-agent'];
    const context: HandshakeContext = Object.freeze({
      sessionToken: cookie.value,
      origin,
      remoteAddress: request.socket.remoteAddress ?? '',
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, MAX_USER_AGENT) : null,
      secure: (request.socket as Partial<TLSSocket>).encrypted === true,
      receivedAt: new Date(now()),
    });
    const resolveSession = activeResolver.resolveSession.bind(activeResolver);
    const resolved = await callAdapter(() => resolveSession(context), adapterTimeoutMs);
    if (!resolved.ok) return { ok: false, code: 'AI_SERVICE_UNAVAILABLE', reason: `resolver_${resolved.reason}` };
    const resolution = parseSessionResolution(resolved.value);
    if (!resolution) return { ok: false, code: 'AI_SERVICE_UNAVAILABLE', reason: 'resolver_malformed' };
    if (resolution.status !== 'authenticated') return { ok: false, code: 'AI_AUTH_REQUIRED', reason: `session_${resolution.status}` };
    const { session } = resolution;
    if (session.expiresAt.getTime() <= now()) return { ok: false, code: 'AI_AUTH_REQUIRED', reason: 'session_expired' };
    if (isDemoIdentity(session.userId)) return { ok: false, code: 'AI_AUTH_REQUIRED', reason: 'demo_identity' };
    return { ok: true, actor: Object.freeze({ userId: session.userId, sessionId: session.sessionId }) };
  }

  async function verifyCsrf(request: IncomingMessage, actor: AiActor, verifier: AiCsrfVerifier): Promise<Rejection | null> {
    const token = request.headers['x-csrf-token'];
    if (token === undefined) return { code: 'AI_FORBIDDEN', reason: 'csrf_missing' };
    if (typeof token !== 'string' || !CSRF_TOKEN.test(token)) return { code: 'AI_FORBIDDEN', reason: 'csrf_malformed' };
    const verify = verifier.verify.bind(verifier);
    const verified = await callAdapter(() => verify(Object.freeze({ sessionId: actor.sessionId, userId: actor.userId, token })), adapterTimeoutMs);
    if (!verified.ok) return { code: 'AI_SERVICE_UNAVAILABLE', reason: `csrf_${verified.reason}` };
    return verified.value === true ? null : { code: 'AI_FORBIDDEN', reason: 'csrf_invalid' };
  }

  async function handle(request: IncomingMessage, response: ServerResponse, next?: (error?: unknown) => void): Promise<void> {
    const original = (request as IncomingMessage & { originalUrl?: unknown }).originalUrl;
    const url = typeof original === 'string' ? original : request.url ?? '';
    const pathname = url.split('?', 1)[0] ?? '';
    const route = routes.get(pathname);
    if (route === undefined) {
      if (pathname !== basePath && !pathname.startsWith(`${basePath}/`) && next) {
        next();
        return;
      }
      reject(response, 'unknown', { code: 'AI_NOT_FOUND', reason: 'route' }, true);
      return;
    }
    // A body parser that ran first consumed the stream; fail loudly instead of hanging.
    const consumed = request.readableEnded || (request as IncomingMessage & { body?: unknown }).body !== undefined;
    if (request.method !== 'POST') return reject(response, route, { code: 'AI_METHOD_NOT_ALLOWED', reason: 'method' }, true);
    if (!config.enabled) return reject(response, route, { code: 'AI_DISABLED', reason: 'disabled' }, true);
    if (!resolver || !csrfVerifier || !service) {
      const missing = !resolver ? 'session_resolver_missing' : !csrfVerifier ? 'csrf_verifier_missing'
        : usageStore === null ? 'usage_store_missing' : 'provider_missing';
      return reject(response, route, { code: 'AI_NOT_CONFIGURED', reason: missing }, true);
    }
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !config.allowedOrigins.has(origin)) return reject(response, route, { code: 'AI_FORBIDDEN', reason: 'origin' }, true);
    if (!contentTypeAccepted(request)) return reject(response, route, { code: 'AI_INVALID_REQUEST', status: 415, reason: 'content_type' }, true);
    if (consumed) return reject(response, route, { code: 'AI_INTERNAL_ERROR', reason: 'body_already_consumed' }, true);

    const controller = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) controller.abort();
    });

    const authenticated = await authenticate(request, origin, resolver);
    if (!authenticated.ok) return reject(response, route, authenticated, true);
    const csrf = await verifyCsrf(request, authenticated.actor, csrfVerifier);
    if (csrf) return reject(response, route, csrf, true);

    const body = await readBody(request, AI_MAX_BODY_BYTES, bodyTimeoutMs);
    if (!body.ok) return reject(response, route, body, true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.bytes));
    } catch {
      return reject(response, route, { code: 'AI_INVALID_REQUEST', reason: 'body_json' }, false);
    }

    const result: AiServiceResult<unknown> = route === 'consent'
      ? service.issueConsent(authenticated.actor, parsed)
      : await service.generate(authenticated.actor, parsed, controller.signal);
    if (!result.ok) return reject(response, route, result, false);
    send(response, 200, result.value);
  }

  return (request, response, next) => {
    handle(request, response, next).catch(() => {
      safeLog(logger, 'error', 'ai.request.rejected', { route: 'unknown', code: 'AI_INTERNAL_ERROR', reason: 'unhandled' });
      if (!response.headersSent) send(response, 500, aiErrorBody('AI_INTERNAL_ERROR'), { connection: 'close' });
      else response.destroy();
    });
  };
}
