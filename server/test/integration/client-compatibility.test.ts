/**
 * Runs the real Phase 8.7A client code (`client/src/realtime/SocketIoRealtimeClient.ts` and
 * `realtimeValidation.ts`, unmodified) against the real server. The client sources use parameter
 * properties and extensionless imports, so they are loaded through tsx's scoped `tsImport`.
 * The injected socket factory only adds the Origin and Cookie headers a browser would send.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { io as connectClient } from 'socket.io-client';
import { tsImport } from 'tsx/esm/api';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import { eventually, SESSION_COOKIE, startTestServer, TEST_ORIGIN, testEnvelope, type HarnessOptions, type TestServer, type TestUser } from '../support/harness.ts';

interface ClientEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface ClientAdapter {
  readonly actorId: string;
  readonly canSendMessages: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  dispose(): void;
  getStatus(): string;
  sendMessage(message: unknown): Promise<unknown>;
  sendTyping(conversationId: string, isTyping: boolean): void;
  markRead(conversationId: string, messageId: string): Promise<void>;
  watchConversations(ids: readonly string[]): void;
  watchPresence(ids: readonly string[]): void;
  subscribe(listener: (event: ClientEvent) => void): () => void;
}

interface ClientModule {
  SocketIoRealtimeClient: new (options: Record<string, unknown>) => ClientAdapter;
  PROPOSED_EVENT_NAMES: Record<string, string>;
}

interface ValidationModule {
  parseRealtimeEvent(kind: string, input: unknown, mode: 'realtime' | 'local-demo'): ClientEvent | null;
  parseReadAcknowledgement(input: unknown, conversationId: string, messageId: string): boolean;
  parseSendAcknowledgement(input: unknown): unknown;
}

let clientModule: ClientModule;
let validation: ValidationModule;
let server: TestServer;
const adapters: ClientAdapter[] = [];

function adapterFor(target: TestServer, user: TestUser | null, cookie?: string): { adapter: ClientAdapter; events: ClientEvent[] } {
  const header = cookie ?? (user ? `${SESSION_COOKIE}=${encodeURIComponent(user.token)}` : undefined);
  const adapter = new clientModule.SocketIoRealtimeClient({
    user: { id: user?.userId ?? 'alice', username: user?.userId ?? 'alice', displayName: user?.displayName ?? 'Alice', avatar: 'initials', isDemo: false },
    authMode: 'api',
    contractReady: true,
    url: target.url,
    path: target.path,
    // Exactly the options the adapter chose, plus the headers a browser attaches itself.
    socketFactory: (url: string, options: Record<string, unknown>) => connectClient(url, {
      ...options,
      extraHeaders: { origin: TEST_ORIGIN, ...(header ? { cookie: header } : {}) },
    }),
  });
  adapters.push(adapter);
  const events: ClientEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { adapter, events };
}

let active: TestServer | null = null;

async function setup(options: HarnessOptions = { withStore: true }) {
  server = await startTestServer(options);
  active = server;
  const alice = server.addUser('alice', { displayName: 'Alice' });
  const bob = server.addUser('bob', { displayName: 'Bob' });
  for (const user of ['alice', 'bob']) server.authorizer.grant(user, 'dm-ab');
  server.authorizer.befriend('alice', 'bob');
  server.store.seed('dm-ab', 'm1', 'bob');
  return { alice, bob };
}

describe('Phase 8.7A SocketIoRealtimeClient against the realtime server', () => {
  before(async () => {
    clientModule = await tsImport('../../../client/src/realtime/SocketIoRealtimeClient.ts', import.meta.url) as ClientModule;
    validation = await tsImport('../../../client/src/realtime/realtimeValidation.ts', import.meta.url) as ValidationModule;
  });
  afterEach(async () => {
    for (const adapter of adapters.splice(0)) adapter.dispose();
    await active?.close();
    active = null;
  });
  after(() => {
    for (const adapter of adapters.splice(0)) adapter.dispose();
  });

  test('the server registers exactly the client contract event names', () => {
    const names = clientModule.PROPOSED_EVENT_NAMES;
    assert.deepEqual(
      [names.messageSend, names.messageRead, names.typingStart, names.typingStop, names.presenceSubscribe],
      Object.values(CLIENT_EVENTS),
    );
    assert.deepEqual(
      [names.messageNew, names.messageAck, names.messageDelivered, names.messageReadReceipt, names.typingUpdate, names.presenceUpdate, names.conversationUpdated],
      Object.values(SERVER_EVENTS),
    );
  });

  test('connects with the cookie session and the adapter’s own Socket.IO options', async () => {
    const { alice } = await setup();
    const { adapter, events } = adapterFor(server, alice);
    await adapter.connect();
    assert.equal(adapter.getStatus(), 'connected');
    assert.ok(events.some((event) => event.type === 'connection' && event.status === 'connected'));
    assert.equal(adapter.canSendMessages, false);
  });

  for (const [label, cookieFor] of [
    ['AUTH_REQUIRED', () => ''],
    ['UNAUTHORIZED', () => `${SESSION_COOKIE}=forged`],
    ['SESSION_EXPIRED', (target: TestServer) => {
      target.sessions.markExpired('expired-token');
      return `${SESSION_COOKIE}=expired-token`;
    }],
  ] as const) {
    test(`treats ${label} as an authentication rejection and locks the adapter`, async () => {
      await setup();
      const { adapter, events } = adapterFor(server, null, cookieFor(server));
      await assert.rejects(adapter.connect(), (error: { code?: string }) => error.code === 'authentication_rejected');
      assert.equal(adapter.getStatus(), 'error');
      assert.ok(events.some((event) => event.type === 'error' && event.code === 'authentication_rejected'));
      await assert.rejects(adapter.connect(), (error: { code?: string }) => error.code === 'authentication_rejected');
    });
  }

  test('a fail-closed server surfaces as unavailable, not as an authentication rejection', async () => {
    const { alice } = await setup({ withSessionResolver: false });
    const { adapter, events } = adapterFor(server, alice);
    await assert.rejects(adapter.connect(), (error: { code?: string }) => error.code === 'unavailable');
    assert.equal(adapter.getStatus(), 'error');
    assert.ok(!events.some((event) => event.type === 'error' && event.code === 'authentication_rejected'));
  });

  test('typing flows in both directions and passes the client parsers', async () => {
    const { alice, bob } = await setup();
    const { adapter, events } = adapterFor(server, alice);
    adapter.watchConversations(['dm-ab']);
    await adapter.connect();
    const peer = await server.connect(bob);
    peer.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await eventually(() => events.some((event) => event.type === 'typing'), 2_000, 'client typing event');
    const typing = events.find((event) => event.type === 'typing')!;
    assert.equal(typing.userId, 'bob');
    assert.equal(typing.displayName, 'Bob');
    assert.equal(typing.isTyping, true);

    adapter.sendTyping('dm-ab', true);
    const relayed = await peer.waitFor(SERVER_EVENTS.typingUpdate);
    assert.equal(relayed.userId, 'alice');
    assert.ok(validation.parseRealtimeEvent('typing', relayed, 'realtime'));
  });

  test('presence subscriptions from the adapter receive privacy-filtered presence it accepts', async () => {
    const { alice, bob } = await setup();
    await server.connect(bob);
    const { adapter, events } = adapterFor(server, alice);
    adapter.watchPresence(['bob', 'stranger']);
    await adapter.connect();
    await eventually(() => events.some((event) => event.type === 'presence'), 2_000, 'client presence event');
    const presence = events.filter((event) => event.type === 'presence');
    assert.deepEqual(presence.map((event) => [event.userId, event.status]), [['bob', 'online']]);
    assert.deepEqual(server.authorizer.presenceCalls.at(-1), { viewer: 'alice', subjects: ['bob', 'stranger'] });
  });

  test('markRead resolves with the server acknowledgement and the sender gets a receipt the client accepts', async () => {
    const { alice, bob } = await setup();
    const { adapter } = adapterFor(server, alice);
    adapter.watchConversations(['dm-ab']);
    await adapter.connect();
    const sender = await server.connect(bob);
    await adapter.markRead('dm-ab', 'm1');
    const receipt = await sender.waitFor(SERVER_EVENTS.messageRead);
    assert.deepEqual(validation.parseRealtimeEvent('receipt', receipt, 'realtime'),
      { type: 'receipt', conversationId: 'dm-ab', messageId: 'm1', userId: 'alice', status: 'read', timestamp: receipt.timestamp });
  });

  test('a server error acknowledgement rejects markRead (mapped to invalid_payload by the 8.7A parser)', async () => {
    const { alice } = await setup();
    const { adapter } = adapterFor(server, alice);
    adapter.watchConversations(['dm-ab']);
    await adapter.connect();
    await assert.rejects(adapter.markRead('dm-ab', 'missing-message'), (error: { code?: string }) => error.code === 'invalid_payload');
  });

  test('a revoked session ends the adapter’s connection without reconnect attempts', async () => {
    const { alice } = await setup();
    const { adapter, events } = adapterFor(server, alice);
    await adapter.connect();
    const contexts = server.sessions.contexts.length;
    server.handle.revokeSession(alice.sessionId);
    await eventually(() => adapter.getStatus() === 'disconnected', 2_000, 'terminal disconnect');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(server.sessions.contexts.length, contexts, 'no reconnect handshake was attempted');
    assert.ok(!events.some((event) => event.type === 'connection' && event.status === 'reconnecting'));
  });

  test('the adapter never emits message:send', async () => {
    const { alice } = await setup();
    const { adapter } = adapterFor(server, alice);
    adapter.watchConversations(['dm-ab']);
    await adapter.connect();
    await assert.rejects(adapter.sendMessage(testEnvelope(alice, 'dm-ab', 'x1')), (error: { code?: string }) => error.code === 'recipient_keys_unavailable');
    assert.equal(server.store.storeCalls, 0);
    assert.ok(!server.logger.has('realtime.connection.invalid_budget_exhausted'));
  });

  test('server-emitted messages, delivery receipts and conversation updates pass the client parsers', async () => {
    const { alice, bob } = await setup({ withStore: true, withVerifier: true });
    const { adapter, events } = adapterFor(server, alice);
    adapter.watchConversations(['dm-ab']);
    await adapter.connect();
    const peer = await server.connect(bob);
    const envelope = testEnvelope(bob, 'dm-ab', 'from-bob');
    const ack = await peer.emitAck(CLIENT_EVENTS.messageSend, envelope);
    assert.ok(validation.parseSendAcknowledgement(ack), 'send acknowledgement matches the client contract');
    await eventually(() => events.some((event) => event.type === 'message'), 2_000, 'client message event');
    const message = events.find((event) => event.type === 'message')!.message as Record<string, unknown>;
    assert.deepEqual(message, { ...envelope, deliveryStatus: 'sent' });
    // The 8.7A adapter does not confirm delivery, so the server honestly reports none.
    await peer.expectNone(SERVER_EVENTS.messageDelivered, () => true, { ms: 600 });

    server.handle.notifyConversationUpdated('dm-ab', { displayName: 'Renamed' });
    await eventually(() => events.some((event) => event.type === 'conversation'), 2_000, 'client conversation event');
    assert.equal(events.find((event) => event.type === 'conversation')!.displayName, 'Renamed');

    // A second alice connection that does confirm delivery produces a real server receipt.
    const confirming = await server.connect(alice);
    await peer.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'dm-ab', 'from-bob-2'));
    const entry = await confirming.waitForEntry(SERVER_EVENTS.messageNew, (payload) => payload.id === 'from-bob-2');
    (entry.args[1] as (response: unknown) => void)({ conversationId: 'dm-ab', messageId: 'from-bob-2', status: 'delivered' });
    const delivered = await peer.waitFor(SERVER_EVENTS.messageDelivered);
    assert.deepEqual(validation.parseRealtimeEvent('receipt', delivered, 'realtime'),
      { type: 'receipt', conversationId: 'dm-ab', messageId: 'from-bob-2', userId: 'alice', status: 'delivered', timestamp: delivered.timestamp });
  });
});
