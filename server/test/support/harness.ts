/**
 * TEST-ONLY harness: starts the real realtime server on an ephemeral loopback port with injected
 * fixtures and connects real `socket.io-client` sockets that send the Origin and Cookie headers a
 * browser would send. Nothing here is reachable from the production entry point.
 */
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import type { RealtimeServerOptions } from '../../src/realtime/config.ts';
import type { RealtimeSecurityPolicy } from '../../src/realtime/contracts.ts';
import { attachRealtimeServer, type RealtimeServerHandle } from '../../src/realtime/server.ts';
import {
  CapturingLogger,
  MinimalSessionResolver,
  TestAuthorizer,
  TestKeyVerifier,
  TestMessageStore,
  TestSessionResolver,
} from './fixtures.ts';

export const TEST_ORIGIN = 'http://localhost:3000';
export const SESSION_COOKIE = 'secubuzz_session';

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReceivedEvent {
  readonly event: string;
  readonly payload: unknown;
  readonly args: readonly unknown[];
}

/** Wraps a connected client socket and records every incoming event. */
export class TestClient {
  readonly socket: ClientSocket;
  readonly received: ReceivedEvent[] = [];
  readonly #waiters = new Set<{ match: (entry: ReceivedEvent) => boolean; resolve: (entry: ReceivedEvent) => void }>();

  constructor(socket: ClientSocket) {
    this.socket = socket;
    socket.onAny((event: string, ...args: unknown[]) => {
      const entry: ReceivedEvent = { event, payload: args[0], args };
      this.received.push(entry);
      for (const waiter of [...this.#waiters]) {
        if (!waiter.match(entry)) continue;
        this.#waiters.delete(waiter);
        waiter.resolve(entry);
      }
    });
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  mark(): number {
    return this.received.length;
  }

  events(event: string, since = 0): unknown[] {
    return this.received.slice(since).filter((entry) => entry.event === event).map((entry) => entry.payload);
  }

  waitForEntry(event: string, predicate: (payload: any) => boolean = () => true, options: { since?: number; timeoutMs?: number } = {}): Promise<ReceivedEvent> {
    const existing = this.received.slice(options.since ?? 0).find((entry) => entry.event === event && predicate(entry.payload));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        match: (entry: ReceivedEvent) => entry.event === event && predicate(entry.payload),
        resolve: (entry: ReceivedEvent) => {
          clearTimeout(timer);
          resolve(entry);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${event}`));
      }, options.timeoutMs ?? 2_000);
      this.#waiters.add(waiter);
    });
  }

  async waitFor(event: string, predicate: (payload: any) => boolean = () => true, options: { since?: number; timeoutMs?: number } = {}): Promise<any> {
    return (await this.waitForEntry(event, predicate, options)).payload;
  }

  /** Waits `ms` and asserts that no matching event arrived since `since`. */
  async expectNone(event: string, predicate: (payload: any) => boolean = () => true, options: { since?: number; ms?: number } = {}): Promise<void> {
    await delay(options.ms ?? 150);
    const found = this.received.slice(options.since ?? 0).filter((entry) => entry.event === event && predicate(entry.payload));
    assert.deepEqual(found.map((entry) => entry.payload), [], `unexpected ${event}`);
  }

  emitAck(event: string, payload: unknown, timeoutMs = 2_000): Promise<any> {
    return this.socket.timeout(timeoutMs).emitWithAck(event, payload);
  }

  emit(event: string, ...args: unknown[]): void {
    this.socket.emit(event, ...args);
  }

  waitForDisconnect(timeoutMs = 2_000): Promise<string> {
    if (!this.socket.connected) return Promise.resolve('already disconnected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for disconnect')), timeoutMs);
      this.socket.once('disconnect', (reason: string) => {
        clearTimeout(timer);
        resolve(reason);
      });
    });
  }

  close(): void {
    this.socket.disconnect();
  }
}

export interface ConnectOptions {
  readonly origin?: string | null;
  readonly cookie?: string | null;
  readonly auth?: Record<string, unknown>;
  readonly query?: Record<string, string>;
  readonly transports?: Array<'websocket' | 'polling'>;
  readonly namespace?: string;
  readonly timeoutMs?: number;
}

export interface ConnectError {
  readonly message: string;
  readonly code: unknown;
  readonly data: unknown;
}

export interface HarnessOptions extends Partial<Omit<RealtimeServerOptions, 'sessionResolver' | 'authorizer' | 'messageStore' | 'recipientKeyVerifier' | 'logger'>> {
  /** Defaults to true. False starts the server without a SessionResolver. */
  readonly withSessionResolver?: boolean;
  /** Use a resolver without the optional `checkSession` method. */
  readonly minimalSessionResolver?: boolean;
  readonly withAuthorizer?: boolean;
  /** Defaults to false: production has no MessageStore yet. */
  readonly withStore?: boolean;
  /** Defaults to false: production has no RecipientKeyVerifier. */
  readonly withVerifier?: boolean;
  readonly securityPolicy?: RealtimeSecurityPolicy;
}

export interface TestUser {
  readonly userId: string;
  readonly displayName: string;
  readonly token: string;
  readonly sessionId: string;
}

export class TestServer {
  readonly httpServer: HttpServer;
  readonly handle: RealtimeServerHandle;
  readonly sessions: TestSessionResolver;
  readonly authorizer: TestAuthorizer;
  readonly store: TestMessageStore;
  readonly verifier: TestKeyVerifier;
  readonly logger: CapturingLogger;
  readonly path: string;
  readonly clients = new Set<TestClient>();
  url = '';
  #sequence = 0;

  constructor(httpServer: HttpServer, handle: RealtimeServerHandle, fixtures: {
    sessions: TestSessionResolver; authorizer: TestAuthorizer; store: TestMessageStore; verifier: TestKeyVerifier; logger: CapturingLogger;
  }, path: string) {
    this.httpServer = httpServer;
    this.handle = handle;
    this.sessions = fixtures.sessions;
    this.authorizer = fixtures.authorizer;
    this.store = fixtures.store;
    this.verifier = fixtures.verifier;
    this.logger = fixtures.logger;
    this.path = path;
  }

  /** Registers a session for `userId` and returns its cookie token. */
  addUser(userId: string, options: { displayName?: string; ttlMs?: number; sessionId?: string } = {}): TestUser {
    this.#sequence += 1;
    const token = `token-${userId}-${this.#sequence}-${Math.random().toString(36).slice(2)}`;
    const sessionId = options.sessionId ?? `session-${userId}-${this.#sequence}`;
    const displayName = options.displayName ?? `User ${userId}`;
    this.sessions.add(token, { sessionId, userId, displayName, expiresAt: new Date(Date.now() + (options.ttlMs ?? 3_600_000)) });
    return { userId, displayName, token, sessionId };
  }

  #socket(token: string | null, options: ConnectOptions): ClientSocket {
    const headers: Record<string, string> = {};
    const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
    if (origin !== null) headers.origin = origin;
    const cookie = options.cookie !== undefined ? options.cookie : token === null ? null : `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
    if (cookie !== null) headers.cookie = cookie;
    return connectClient(`${this.url}${options.namespace ?? ''}`, {
      path: this.path,
      transports: options.transports ?? ['websocket'],
      forceNew: true,
      multiplex: false,
      reconnection: false,
      timeout: options.timeoutMs ?? 5_000,
      extraHeaders: headers,
      ...(options.auth ? { auth: options.auth } : {}),
      ...(options.query ? { query: options.query } : {}),
    });
  }

  /** Connects and resolves once the namespace connection succeeds; rejects with the connect error. */
  connect(user: TestUser | string | null, options: ConnectOptions = {}): Promise<TestClient> {
    const token = typeof user === 'string' || user === null ? user : user.token;
    const socket = this.#socket(token, options);
    const client = new TestClient(socket);
    this.clients.add(client);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => {
        socket.off('connect_error');
        resolve(client);
      });
      socket.once('connect_error', (error: Error & { data?: { code?: unknown } }) => {
        socket.disconnect();
        reject(Object.assign(new Error(error.message), { data: error.data, code: error.data?.code }));
      });
    });
  }

  /** Connects and expects a rejection, returning the error message and `data.code`. */
  async connectError(user: TestUser | string | null, options: ConnectOptions = {}): Promise<ConnectError> {
    try {
      const client = await this.connect(user, options);
      client.close();
    } catch (error) {
      const failure = error as Error & { code?: unknown; data?: unknown };
      return { message: failure.message, code: failure.code, data: failure.data };
    }
    throw new Error('Expected the connection to be rejected.');
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.close();
    await this.handle.close();
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }
}

/** Short timings keep integration tests fast; production defaults are covered by unit tests. */
export const FAST_TIMING = Object.freeze({
  adapterTimeoutMs: 300,
  handshakeTimeoutMs: 600,
  presenceRefreshIntervalMs: 40_000,
  typingTtlMs: 6_000,
  revalidationIntervalMs: 0,
  deliveryAckTimeoutMs: 500,
  shutdownTimeoutMs: 500,
});

export async function startTestServer(options: HarnessOptions = {}): Promise<TestServer> {
  const sessions = new TestSessionResolver();
  const authorizer = new TestAuthorizer();
  const store = new TestMessageStore();
  const verifier = new TestKeyVerifier();
  const logger = new CapturingLogger();
  const {
    withSessionResolver = true, minimalSessionResolver = false, withAuthorizer = true, withStore = false, withVerifier = false,
    securityPolicy, timing, ...rest
  } = options;
  const httpServer = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const handle = attachRealtimeServer(httpServer, {
    allowedOrigins: [TEST_ORIGIN],
    sessionCookieName: SESSION_COOKIE,
    ...rest,
    timing: { ...FAST_TIMING, ...timing },
    logger,
    ...(withSessionResolver ? { sessionResolver: minimalSessionResolver ? new MinimalSessionResolver(sessions) : sessions } : {}),
    ...(withAuthorizer ? { authorizer } : {}),
    ...(withStore ? { messageStore: store } : {}),
    ...(withVerifier ? { recipientKeyVerifier: verifier } : {}),
    ...(securityPolicy ? { securityPolicy } : {}),
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const server = new TestServer(httpServer, handle, { sessions, authorizer, store, verifier, logger }, rest.path ?? '/socket.io');
  server.url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  return server;
}

/** Canonical base64 helpers for building envelopes in tests. */
export const TEST_IV = Buffer.alloc(12, 3).toString('base64');
export const TEST_CIPHERTEXT = Buffer.alloc(48, 5).toString('base64');

export function testEnvelope(sender: TestUser, conversationId: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    conversationId,
    senderId: sender.userId,
    senderName: sender.displayName,
    timestamp: new Date().toISOString(),
    type: 'text',
    encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: TEST_IV, ciphertext: TEST_CIPHERTEXT },
    ...overrides,
  };
}

/** Polls `predicate` until it holds or the timeout passes. */
export async function eventually(predicate: () => boolean, timeoutMs = 2_000, message = 'condition'): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${message}`);
    await delay(10);
  }
}
