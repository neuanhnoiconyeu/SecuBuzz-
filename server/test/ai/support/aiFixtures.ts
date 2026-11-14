/**
 * TEST-ONLY helpers for the AI API: a fake key, mock Gemini responses, a CSRF verifier, a shared
 * usage store double and a loopback server running the real handler. Nothing here is exported
 * from `src/` and the module refuses to load in production.
 */
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadAiConfig, type AiConfig } from '../../../src/ai/config.ts';
import { AI_DISCLOSURE, computePayloadDigest } from '../../../src/ai/consent.ts';
import { createAiHttpHandler, type AiCsrfInput, type AiCsrfVerifier, type AiHttpHandler, type AiHttpHandlerOptions } from '../../../src/ai/http.ts';
import { MemoryAiUsageStore, type AiReservation, type AiReservationRequest, type AiUsageStore } from '../../../src/ai/usage.ts';
import type { AiGenerationRequest } from '../../../src/ai/validation.ts';
import { CapturingLogger, TestSessionResolver, type FaultMode } from '../../support/fixtures.ts';

if (process.env.NODE_ENV === 'production') throw new Error('AI test fixtures must never be loaded in production.');

/** Fake key: never valid at Google, so even an accidental call could not authenticate. */
export const TEST_GEMINI_KEY = 'test-only-not-a-real-gemini-key-0000000000';
export const TEST_ORIGIN = 'http://localhost:3000';
export const TEST_CONSENT_SECRET = 'test-only-consent-secret-0123456789abcdef';
export const SESSION_COOKIE = 'secubuzz_session';

/** Remote AI enabled with test limits. The limits are test values, not Google quotas. */
export function aiEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AI_REMOTE_ENABLED: 'true',
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_API_KEY: TEST_GEMINI_KEY,
    AI_PROJECT_RPM: '50',
    AI_PROJECT_RPD: '500',
    AI_USER_RPM: '20',
    AI_USER_RPD: '200',
    AI_MAX_CONCURRENT: '5',
    AI_ALLOWED_ORIGINS: TEST_ORIGIN,
    AI_CONSENT_SECRET: TEST_CONSENT_SECRET,
    ...overrides,
  };
}

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AiConfig {
  return loadAiConfig(aiEnv(overrides));
}

const hang = () => new Promise<never>(() => undefined);

async function faulted<Value>(mode: FaultMode, malformed: unknown, run: () => Value | Promise<Value>): Promise<Value> {
  if (mode === 'throw') throw new Error('fixture failure with secret detail: password=hunter2');
  if (mode === 'hang') return hang();
  if (mode === 'malformed') return malformed as Value;
  return run();
}

export interface RecordedGeminiCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: any;
  readonly redirect: RequestInit['redirect'];
  readonly signal: AbortSignal | undefined;
}

export type GeminiReply =
  | Response
  | (() => Response | Promise<Response>)
  | { readonly hang: 'respect-abort' | 'ignore-abort' }
  | { readonly reject: unknown };

/** Mock `fetch` for the Gemini adapter. Replies are used in order; the last one repeats. */
export function mockGemini(...replies: GeminiReply[]) {
  const calls: RecordedGeminiCall[] = [];
  const queue = replies.length > 0 ? [...replies] : [geminiText('Mock reply.')];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      redirect: init.redirect,
      signal: init.signal ?? undefined,
    });
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply instanceof Response) return reply.clone();
    if (typeof reply === 'function') return reply();
    if ('reject' in reply) throw reply.reject;
    if (reply.hang === 'ignore-abort') return hang();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function geminiJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function geminiText(text: string, options: { finishReason?: string; parts?: unknown[]; usage?: Record<string, unknown> } = {}): Response {
  return geminiJson(200, {
    candidates: [{
      content: { role: 'model', parts: options.parts ?? [{ text }] },
      finishReason: options.finishReason ?? 'STOP',
      index: 0,
    }],
    usageMetadata: options.usage ?? { promptTokenCount: 120, candidatesTokenCount: 12, thoughtsTokenCount: 3, totalTokenCount: 135, serviceTier: 'standard' },
    modelVersion: 'gemini-3.5-flash-lite',
  });
}

/** Google RPC error body. The message deliberately contains secret-looking text that must never be echoed. */
export function geminiError(status: number, statusText: string, details: unknown[] = []): Response {
  return geminiJson(status, {
    error: { code: status, message: `Provider detail with secret AIza${'Z'.repeat(35)} and prompt text`, status: statusText, details },
  });
}

export function quotaFailure(quotaId: string, retryDelay?: string): unknown[] {
  return [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }] },
    ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
  ];
}

/** TEST-ONLY CSRF verifier: one token per session. */
export class TestCsrfVerifier implements AiCsrfVerifier {
  readonly #tokens = new Map<string, string>();
  readonly inputs: AiCsrfInput[] = [];
  mode: FaultMode = 'normal';

  issue(sessionId: string): string {
    const token = `csrf-${randomUUID()}`;
    this.#tokens.set(sessionId, token);
    return token;
  }

  async verify(input: AiCsrfInput): Promise<boolean> {
    this.inputs.push(input);
    return faulted(this.mode, 'yes', () => this.#tokens.get(input.sessionId) === input.token);
  }
}

/** Shared state behind {@link SharedTestUsageStore}, standing in for one database used by several processes. */
export class SharedUsageBackend {
  readonly memory = new MemoryAiUsageStore();
  reserveCalls = 0;
  nonceCalls = 0;
  releases = 0;
}

/**
 * TEST-ONLY durable-semantics double. Every instance built on the same backend shares counters,
 * leases and nonces, like processes sharing a database; a new instance simulates a restart.
 * It is not a production store.
 */
export class SharedTestUsageStore implements AiUsageStore {
  readonly kind = 'durable' as const;
  readonly backend: SharedUsageBackend;
  reserveMode: FaultMode = 'normal';
  nonceMode: FaultMode = 'normal';

  constructor(backend: SharedUsageBackend = new SharedUsageBackend()) {
    this.backend = backend;
  }

  reserve(request: AiReservationRequest): Promise<AiReservation> {
    this.backend.reserveCalls += 1;
    return faulted(this.reserveMode, { status: 'user_minute', retryAfterSeconds: 'soon' }, () => this.backend.memory.reserve(request));
  }

  async release(scope: string, reservationId: string): Promise<void> {
    this.backend.releases += 1;
    await this.backend.memory.release(scope, reservationId);
  }

  consumeConsentNonce(scope: string, nonce: string, expiresAt: Date, now: Date): Promise<boolean> {
    this.backend.nonceCalls += 1;
    return faulted(this.nonceMode, 'first', () => this.backend.memory.consumeConsentNonce(scope, nonce, expiresAt, now));
  }
}

export interface TestAiUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly cookie: string;
  readonly csrf: string;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly body: any;
}

export interface PostOptions {
  readonly user?: TestAiUser | null;
  /** `null` omits the header. */
  readonly origin?: string | null;
  readonly cookie?: string | null;
  readonly csrf?: string | null;
  readonly contentType?: string | null;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  /** Sent as is instead of JSON. */
  readonly raw?: string | Buffer;
}

/** Plain `node:http` request so tests control every header (no automatic Origin or cookies). */
export function rawRequest(url: string, method: string, headers: Record<string, string>, body?: string | Buffer): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, text, body: parsed });
      });
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

export interface AiTestServerOptions extends Partial<Omit<AiHttpHandlerOptions, 'config' | 'sessionResolver' | 'csrfVerifier' | 'usageStore' | 'logger'>> {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: AiConfig;
  /** Defaults to true. */
  readonly withResolver?: boolean;
  /** Defaults to true. */
  readonly withCsrf?: boolean;
  /** `undefined` creates a {@link SharedTestUsageStore}; `null` configures none. */
  readonly usageStore?: AiUsageStore | null;
  readonly replies?: GeminiReply[];
  /** Wraps the handler, for example to imitate Express mounting or an earlier body parser. */
  readonly wrap?: (handler: AiHttpHandler) => RequestListener;
}

export class AiTestServer {
  readonly httpServer: Server;
  readonly sessions: TestSessionResolver;
  readonly csrf: TestCsrfVerifier;
  readonly logger: CapturingLogger;
  readonly gemini: ReturnType<typeof mockGemini>;
  readonly usageStore: AiUsageStore | null;
  url = '';
  #sequence = 0;

  constructor(httpServer: Server, parts: {
    sessions: TestSessionResolver; csrf: TestCsrfVerifier; logger: CapturingLogger; gemini: ReturnType<typeof mockGemini>; usageStore: AiUsageStore | null;
  }) {
    this.httpServer = httpServer;
    this.sessions = parts.sessions;
    this.csrf = parts.csrf;
    this.logger = parts.logger;
    this.gemini = parts.gemini;
    this.usageStore = parts.usageStore;
  }

  addUser(userId: string, options: { ttlMs?: number; sessionId?: string } = {}): TestAiUser {
    this.#sequence += 1;
    const token = `session-token-${userId}-${this.#sequence}-${randomUUID()}`;
    const sessionId = options.sessionId ?? `session-${userId}-${this.#sequence}`;
    this.sessions.add(token, { sessionId, userId, displayName: `User ${userId}`, expiresAt: new Date(Date.now() + (options.ttlMs ?? 3_600_000)) });
    return { userId, sessionId, cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`, csrf: this.csrf.issue(sessionId) };
  }

  post(path: string, body: unknown, options: PostOptions = {}): Promise<HttpResult> {
    const user = options.user ?? null;
    const headers: Record<string, string> = {};
    const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
    if (origin !== null) headers.origin = origin;
    const cookie = options.cookie === undefined ? user?.cookie ?? null : options.cookie;
    if (cookie !== null) headers.cookie = cookie;
    const csrf = options.csrf === undefined ? user?.csrf ?? null : options.csrf;
    if (csrf !== null) headers['x-csrf-token'] = csrf;
    const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
    if (contentType !== null) headers['content-type'] = contentType;
    Object.assign(headers, options.headers);
    const payload = options.raw ?? (body === undefined ? undefined : JSON.stringify(body));
    return rawRequest(`${this.url}${path}`, options.method ?? 'POST', headers, payload);
  }

  async consent(user: TestAiUser, request: AiGenerationRequest, disclosureVersion: string = AI_DISCLOSURE.version): Promise<HttpResult> {
    return this.post('/api/ai/consent', { disclosureVersion, payloadDigest: computePayloadDigest(request) }, { user });
  }

  async consentToken(user: TestAiUser, request: AiGenerationRequest): Promise<string> {
    const result = await this.consent(user, request);
    if (result.status !== 200 || typeof result.body?.consentToken !== 'string') throw new Error(`consent failed: ${result.status} ${result.text}`);
    return result.body.consentToken as string;
  }

  generate(user: TestAiUser, request: AiGenerationRequest, consentToken?: string, options: PostOptions = {}): Promise<HttpResult> {
    return this.post('/api/ai/requests', { request, ...(consentToken === undefined ? {} : { consentToken }) }, { user, ...options });
  }

  /** Consent, then generate: the normal client flow. */
  async ask(user: TestAiUser, request: AiGenerationRequest): Promise<HttpResult> {
    return this.generate(user, request, await this.consentToken(user, request));
  }

  async close(): Promise<void> {
    this.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }
}

export async function startAiServer(options: AiTestServerOptions = {}): Promise<AiTestServer> {
  const { env, config, withResolver = true, withCsrf = true, usageStore, replies, fetch: injectedFetch, wrap, ...rest } = options;
  const sessions = new TestSessionResolver();
  const csrf = new TestCsrfVerifier();
  const logger = new CapturingLogger();
  const gemini = mockGemini(...(replies ?? []));
  const store = usageStore === undefined ? new SharedTestUsageStore() : usageStore;
  const handler = createAiHttpHandler({
    config: config ?? testConfig(env),
    logger,
    fetch: injectedFetch ?? gemini.fetch,
    adapterTimeoutMs: 300,
    bodyTimeoutMs: 1_000,
    ...rest,
    ...(withResolver ? { sessionResolver: sessions } : {}),
    ...(withCsrf ? { csrfVerifier: csrf } : {}),
    ...(store ? { usageStore: store } : {}),
  });
  const httpServer = createServer(wrap ? wrap(handler) : (request, response) => handler(request, response));
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const server = new AiTestServer(httpServer, { sessions, csrf, logger, gemini, usageStore: store });
  server.url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  return server;
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
