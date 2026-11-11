/**
 * Runs the real Phase 8.7A client code (`client/src/realtime/SocketIoRealtimeClient.ts` and
 * `realtimeValidation.ts`) against the unmodified real server. The client sources use parameter
 * properties and extensionless imports, so they are loaded through tsx's scoped `tsImport`.
 * The injected socket factory only adds the Origin and Cookie headers a browser would send.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { io as connectClient } from 'socket.io-client';
import { tsImport } from 'tsx/esm/api';
import { ACK_ERROR_CODES, CLIENT_EVENTS, CONNECT_ERROR_CODES, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import { delay, eventually, SESSION_COOKIE, startTestServer, TEST_ORIGIN, testEnvelope, type HarnessOptions, type TestServer, type TestUser } from '../support/harness.ts';

interface ClientEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface ClientAdapter {
  readonly actorId: string;
  readonly canSendMessages: boolean;
  readonly canConfirmDelivery: boolean;
  confirmDelivery(message: unknown): Promise<void>;
  watchConversationParticipants(scopes: readonly { conversationId: string; participantIds: readonly string[] }[]): void;
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
  parseErrorAcknowledgement(input: unknown): { code: string; serverCode: string; retryable: boolean } | null;
}

let clientModule: ClientModule;
let validation: ValidationModule;
let model: { SERVER_ACK_ERROR_CODES: readonly string[]; SERVER_CONNECT_ERROR_CODES: readonly string[] };
let server: TestServer;
const adapters: ClientAdapter[] = [];

function adapterFor(target: TestServer, user: TestUser | null, cookie?: string,
  deliveryConfirmationVerifier?: (message: Readonly<Record<string, unknown>>, actorId: string) => boolean | Promise<boolean>,
  namespace = ''): { adapter: ClientAdapter; events: ClientEvent[] } {
  const header = cookie ?? (user ? `${SESSION_COOKIE}=${encodeURIComponent(user.token)}` : undefined);
  const adapter = new clientModule.SocketIoRealtimeClient({
    user: { id: user?.userId ?? 'alice', username: user?.userId ?? 'alice', displayName: user?.displayName ?? 'Alice', avatar: 'initials', isDemo: false },
    authMode: 'api',
    contractReady: true,
    url: target.url + namespace,
    path: target.path,
    ...(deliveryConfirmationVerifier ? { deliveryConfirmationVerifier } : {}),
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
    model = await tsImport('../../../client/src/realtime/realtimeModel.ts', import.meta.url) as typeof model;
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
    assert.deepEqual(model.SERVER_ACK_ERROR_CODES, ACK_ERROR_CODES);
    assert.deepEqual(model.SERVER_CONNECT_ERROR_CODES, CONNECT_ERROR_CODES);
    for (const code of ACK_ERROR_CODES) {
      const error = validation.parseErrorAcknowledgement({ status: 'error', code });
      assert.equal(error?.code, code);
      assert.equal(error?.serverCode, code);
      assert.equal(error?.retryable, false);
    }
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
      await assert.rejects(adapter.connect(), (error: { code?: string; serverCode?: string }) =>
        error.code === 'authentication_rejected' && error.serverCode === label);
      assert.equal(adapter.getStatus(), 'error');
      assert.ok(events.some((event) => event.type === 'error' && event.code === 'authentication_rejected'));
      await assert.rejects(adapter.connect(), (error: { code?: string }) => error.code === 'authentication_rejected');
    });
  }

  test('a fail-closed server surfaces as unavailable, not as an authentication rejection', async () => {
    const { alice } = await setup({ withSessionResolver: false });
    const { adapter, events } = adapterFor(server, alice);
    await assert.rejects(adapter.connect(), (error: { code?: string; serverCode?: string }) =>
      error.code === 'unavailable' && error.serverCode === 'REALTIME_UNAVAILABLE');
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

  test('a server error acknowledgement preserves message_not_found in markRead', async () => {
    const { alice } = await setup();
    const { adapter } = adapterFor(server, alice);
    adapter.watchConversations(['dm-ab']);
    await adapter.connect();
    await assert.rejects(adapter.markRead('dm-ab', 'missing-message'),
      (error: { code?: string; serverCode?: string }) => error.code === 'message_not_found' && error.serverCode === 'message_not_found');
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

  test('Phase 8.7C live session expiry is terminal; an explicit reconnect preserves SESSION_EXPIRED', async () => {
    await setup();
    const expiring = server.addUser('alice', { sessionId: 'expiring-api-session', ttlMs: 200 });
    const { adapter, events } = adapterFor(server, expiring);
    await adapter.connect();
    const handshakes = server.sessions.contexts.length;
    await eventually(() => adapter.getStatus() === 'disconnected', 2_000, 'session expiry disconnect');
    assert.equal(server.sessions.contexts.length, handshakes, 'no automatic reconnect after server disconnect');
    assert.ok(!events.some((event) => event.type === 'error' && event.code === 'authentication_rejected'),
      'the live disconnect carries no code; do not invent an authentication event');
    await assert.rejects(adapter.connect(), { code: 'authentication_rejected', serverCode: 'SESSION_EXPIRED', retryable: false });
    assert.ok(events.some((event) => event.type === 'error' && event.serverCode === 'SESSION_EXPIRED'));
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
    // Confirmation is gated by default without trusted recipient-key verification.
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

  test('Phase 8.7C uses configured namespace and engine path without changing server routing', async () => {
    const { alice } = await setup({ namespace: '/messenger', path: '/realtime/socket' });
    const { adapter } = adapterFor(server, alice, undefined, undefined, '/messenger');
    await adapter.connect();
    assert.equal(adapter.getStatus(), 'connected');
  });

  test('Phase 8.7C preserves server authorization denial even when the local allowlist contains the ID', async () => {
    const { alice } = await setup();
    const { adapter } = adapterFor(server, alice);
    adapter.watchConversations(['ungranted']);
    await adapter.connect();
    await assert.rejects(adapter.markRead('ungranted', 'm1'), { code: 'unauthorized_conversation', serverCode: 'unauthorized_conversation', retryable: false });
    assert.equal(server.store.receiptCalls.length, 0);
    assert.equal(adapter.getStatus(), 'connected');
  });

  test('Phase 8.7C preserves rate limiting and does not automatically retry', async () => {
    const { alice } = await setup({ withStore: true, rates: { read: { capacity: 1, refillPerSecond: 0 } } });
    const { adapter } = adapterFor(server, alice);
    adapter.watchConversations(['dm-ab']); await adapter.connect();
    await adapter.markRead('dm-ab', 'm1');
    await assert.rejects(adapter.markRead('dm-ab', 'm1'), { code: 'rate_limited', serverCode: 'rate_limited', retryable: false });
    await delay(50);
    assert.equal(server.store.receiptCalls.length, 1);
  });

  test('Phase 8.7C maps a hung store deadline to unavailable rather than invalid payload or logout', async () => {
    const { alice } = await setup({ withStore: true });
    const { adapter, events } = adapterFor(server, alice);
    adapter.watchConversations(['dm-ab']); await adapter.connect(); server.store.findMode = 'hang';
    await assert.rejects(adapter.markRead('dm-ab', 'm1'), { code: 'unavailable', serverCode: 'unavailable', retryable: false });
    assert.equal(adapter.getStatus(), 'connected');
    assert.ok(!events.some((event) => event.code === 'authentication_rejected'));
  });

  test('Phase 8.7C submits delivery exactly once; durable receipt and read are separate server operations', async () => {
    const { alice, bob } = await setup({ withStore: true, withVerifier: true });
    // Explicit TEST-ONLY attestation over synthetic ciphertext. This is not production key exchange.
    const { adapter, events } = adapterFor(server, alice, undefined, (_message, actorId) => actorId === 'alice');
    adapter.watchConversations(['dm-ab']);
    adapter.watchConversationParticipants([{ conversationId: 'dm-ab', participantIds: ['alice', 'bob'] }]);
    await adapter.connect(); const peer = await server.connect(bob);
    const envelope = testEnvelope(bob, 'dm-ab', 'delivery-compatible');
    assert.equal((await peer.emitAck(CLIENT_EVENTS.messageSend, envelope)).status, 'sent');
    await eventually(() => events.some((event) => event.type === 'message'), 2_000, 'incoming envelope');
    const message = events.find((event) => event.type === 'message')!.message;
    assert.equal(server.store.receiptCalls.length, 0, 'receiving the envelope alone does not confirm');
    await Promise.all([adapter.confirmDelivery(message), adapter.confirmDelivery(message)]);
    await adapter.confirmDelivery(message);
    const receipt = await peer.waitFor(SERVER_EVENTS.messageDelivered);
    assert.equal(receipt.userId, 'alice'); assert.equal(receipt.messageId, envelope.id);
    assert.equal(server.store.receiptCalls.length, 1);
    assert.equal(server.store.hasReceipt('dm-ab', 'delivery-compatible', 'alice', 'read'), false);
    assert.ok(!events.some((event) => event.type === 'receipt'), 'no synthetic local delivery event');
    await adapter.markRead('dm-ab', 'delivery-compatible');
    assert.equal((await peer.waitFor(SERVER_EVENTS.messageRead)).userId, 'alice');
    // An idempotent re-send does not rebroadcast or produce a second confirmation.
    await peer.emitAck(CLIENT_EVENTS.messageSend, envelope); await delay(50);
    assert.equal(events.filter((event) => event.type === 'message').length, 1);
    assert.equal(server.store.receiptCalls.filter((entry) => entry.status === 'delivered').length, 1);
    assert.equal(adapter.canSendMessages, false);
  });

  test('Phase 8.7C group delivery denotes one authenticated recipient, never every member', async () => {
    const { alice, bob } = await setup({ withStore: true, withVerifier: true });
    const carol = server.addUser('carol');
    for (const id of ['alice', 'bob', 'carol']) server.authorizer.grant(id, 'group-1');
    const { adapter, events } = adapterFor(server, alice, undefined, () => true);
    adapter.watchConversations(['group-1']);
    adapter.watchConversationParticipants([{ conversationId: 'group-1', participantIds: ['alice', 'bob', 'carol'] }]);
    await adapter.connect(); const sender = await server.connect(bob); await server.connect(carol);
    await sender.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'group-1', 'group-delivery'));
    await eventually(() => events.some((event) => event.type === 'message'), 2_000, 'group envelope');
    await adapter.confirmDelivery(events.find((event) => event.type === 'message')!.message);
    await sender.waitFor(SERVER_EVENTS.messageDelivered);
    assert.deepEqual(sender.events(SERVER_EVENTS.messageDelivered).map((receipt) => (receipt as { userId: string }).userId), ['alice']);
    assert.equal(server.store.hasReceipt('group-1', 'group-delivery', 'carol', 'delivered'), false);
    assert.equal(server.store.hasReceipt('group-1', 'group-delivery', 'alice', 'read'), false);
  });

  for (const cause of ['unknown-participant', 'key-rejected'] as const) {
    test(`Phase 8.7C produces no server delivery when ${cause}`, async () => {
      const { alice, bob } = await setup({ withStore: true, withVerifier: true });
      const { adapter, events } = adapterFor(server, alice, undefined, () => cause !== 'key-rejected');
      adapter.watchConversations(['dm-ab']);
      adapter.watchConversationParticipants([{ conversationId: 'dm-ab', participantIds: cause === 'unknown-participant' ? ['alice'] : ['alice', 'bob'] }]);
      await adapter.connect(); const sender = await server.connect(bob);
      await sender.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'dm-ab', 'rejected-delivery'));
      await eventually(() => events.some((event) => event.type === 'message'), 2_000, 'rejected envelope');
      await assert.rejects(adapter.confirmDelivery(events.find((event) => event.type === 'message')!.message));
      await sender.expectNone(SERVER_EVENTS.messageDelivered, () => true, { ms: 550 });
      assert.equal(server.store.receiptCalls.length, 0);
    });
  }

  test('Phase 8.7C logout cancels pending attestation; replacement session cannot reuse its callback', async () => {
    const { alice, bob } = await setup({ withStore: true, withVerifier: true });
    let release!: (verified: boolean) => void;
    const { adapter, events } = adapterFor(server, alice, undefined, () => new Promise<boolean>((resolve) => { release = resolve; }));
    adapter.watchConversations(['dm-ab']); adapter.watchConversationParticipants([{ conversationId: 'dm-ab', participantIds: ['alice', 'bob'] }]);
    await adapter.connect(); const sender = await server.connect(bob);
    await sender.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'dm-ab', 'old-session'));
    await eventually(() => events.some((event) => event.type === 'message'), 2_000, 'old envelope');
    const message = events.find((event) => event.type === 'message')!.message;
    const pending = adapter.confirmDelivery(message); const rejected = assert.rejects(pending, { code: 'session_ended' });
    await Promise.resolve(); adapter.dispose(); await rejected; release(true);
    const replacement = adapterFor(server, alice, undefined, () => true).adapter;
    replacement.watchConversations(['dm-ab']); replacement.watchConversationParticipants([{ conversationId: 'dm-ab', participantIds: ['alice', 'bob'] }]);
    await replacement.connect();
    await assert.rejects(replacement.confirmDelivery(message), { code: 'invalid_payload' });
    await sender.expectNone(SERVER_EVENTS.messageDelivered, () => true, { ms: 550 });
    assert.equal(server.store.receiptCalls.length, 0);
  });

  test('Phase 8.7C reconnect uses one set of listeners and does not replay old confirmation handles', async () => {
    const { alice, bob } = await setup({ withStore: true, withVerifier: true });
    const { adapter, events } = adapterFor(server, alice, undefined, () => true);
    adapter.watchConversations(['dm-ab']); adapter.watchConversationParticipants([{ conversationId: 'dm-ab', participantIds: ['alice', 'bob'] }]);
    await adapter.connect(); const sender = await server.connect(bob);
    await sender.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'dm-ab', 'before-disconnect'));
    await eventually(() => events.some((event) => event.type === 'message'), 2_000, 'before disconnect');
    const old = events.find((event) => event.type === 'message')!.message;
    adapter.disconnect(); await assert.rejects(adapter.confirmDelivery(old), { code: 'disconnected' });
    await adapter.connect(); await assert.rejects(adapter.confirmDelivery(old), { code: 'invalid_payload' });
    await sender.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'dm-ab', 'after-reconnect'));
    await eventually(() => events.filter((event) => event.type === 'message').length === 2, 2_000, 'after reconnect');
    await adapter.confirmDelivery(events.filter((event) => event.type === 'message')[1]!.message);
    await sender.waitFor(SERVER_EVENTS.messageDelivered);
    assert.deepEqual(sender.events(SERVER_EVENTS.messageDelivered).map((receipt) => (receipt as { messageId: string }).messageId), ['after-reconnect']);
    const before = events.length; adapter.dispose();
    await sender.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'dm-ab', 'after-dispose')); await delay(50);
    assert.equal(events.length, before + 1, 'only the final disconnected state was published');
  });

  test('Phase 8.7C callback submission cannot claim durable delivery after a server callback timeout', async () => {
    const { alice, bob } = await setup({ withStore: true, withVerifier: true, timing: { deliveryAckTimeoutMs: 50 } });
    const { adapter, events } = adapterFor(server, alice, undefined, async () => { await delay(150); return true; });
    adapter.watchConversations(['dm-ab']); adapter.watchConversationParticipants([{ conversationId: 'dm-ab', participantIds: ['alice', 'bob'] }]);
    await adapter.connect(); const sender = await server.connect(bob);
    await sender.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'dm-ab', 'server-expired'));
    await eventually(() => events.some((event) => event.type === 'message'), 2_000, 'expiring envelope');
    await adapter.confirmDelivery(events.find((event) => event.type === 'message')!.message);
    await sender.expectNone(SERVER_EVENTS.messageDelivered);
    assert.equal(server.store.receiptCalls.length, 0);
    assert.ok(!events.some((event) => event.type === 'receipt'));
  });

  test('Phase 8.7C does not fabricate durable delivery when server receipt persistence rejects confirmation', async () => {
    const { alice, bob } = await setup({ withStore: true, withVerifier: true });
    const { adapter, events } = adapterFor(server, alice, undefined, () => true);
    adapter.watchConversations(['dm-ab']); adapter.watchConversationParticipants([{ conversationId: 'dm-ab', participantIds: ['alice', 'bob'] }]);
    await adapter.connect(); const sender = await server.connect(bob);
    await sender.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(bob, 'dm-ab', 'store-rejected'));
    await eventually(() => events.some((event) => event.type === 'message'), 2_000, 'receipt failure envelope');
    server.store.receiptMode = 'throw';
    await adapter.confirmDelivery(events.find((event) => event.type === 'message')!.message);
    await sender.expectNone(SERVER_EVENTS.messageDelivered);
    assert.equal(server.store.hasReceipt('dm-ab', 'store-rejected', 'alice', 'delivered'), false);
  });
});
