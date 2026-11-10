import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { io as connectClient } from 'socket.io-client';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import {
  delay,
  eventually,
  SESSION_COOKIE,
  startTestServer,
  TEST_ORIGIN,
  TestClient,
  type HarnessOptions,
  type TestServer,
} from '../support/harness.ts';

let server: TestServer;

function zeroed(target: TestServer) {
  const stats = target.handle.getStats();
  return stats.connections === 0 && stats.users === 0 && stats.sessions === 0 && stats.conversationRooms === 0 &&
    stats.presenceSubscriptions === 0 && stats.typingEntries === 0 && stats.pendingAcks === 0 &&
    stats.pendingDeliveryAcks === 0 && stats.inFlightSends === 0 && stats.pendingHandshakes === 0;
}

async function setup(options: HarnessOptions = {}) {
  server = await startTestServer(options);
  const alice = server.addUser('alice');
  const bob = server.addUser('bob');
  server.authorizer.grant('alice', 'dm-ab');
  server.authorizer.grant('bob', 'dm-ab');
  server.authorizer.befriend('alice', 'bob');
  return { alice, bob };
}

/** A client with Socket.IO reconnection enabled, as the 8.7A adapter uses. Tracked so teardown closes it. */
function reconnectingClient(target: TestServer, token: string): TestClient {
  const client = new TestClient(connectClient(target.url, {
    path: target.path,
    transports: ['websocket'],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 20,
    reconnectionDelayMax: 50,
    extraHeaders: { origin: TEST_ORIGIN, cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
  }));
  target.clients.add(client);
  return client;
}

/** Drops the transport from the client side and resolves once the namespace connection is re-established. */
async function forceReconnect(client: TestClient): Promise<void> {
  const reconnected = new Promise<void>((resolve) => client.socket.once('connect', () => resolve()));
  client.socket.io.engine.close();
  await reconnected;
}

describe('reconnection', () => {
  afterEach(async () => {
    await server.close();
  });

  test('every reconnect is re-authenticated and re-authorized from scratch', async () => {
    const { alice, bob } = await setup();
    const b = await server.connect(bob);
    const client = reconnectingClient(server, alice.token);
    await eventually(() => client.connected, 2_000, 'first connect');
    const contextsBefore = server.sessions.contexts.length;
    const grantsBefore = server.authorizer.conversationCalls;
    server.authorizer.revoke('alice', 'dm-ab');
    await forceReconnect(client);
    assert.equal(server.sessions.contexts.length, contextsBefore + 1);
    assert.equal(server.authorizer.conversationCalls, grantsBefore + 1);
    assert.ok(!client.socket.recovered, 'connection state recovery is disabled');
    client.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await b.expectNone(SERVER_EVENTS.typingUpdate);
    client.close();
  });

  test('handlers are registered once per socket, so events are processed once after reconnects', async () => {
    const { alice, bob } = await setup();
    const b = await server.connect(bob);
    const client = reconnectingClient(server, alice.token);
    await eventually(() => client.connected, 2_000, 'first connect');
    for (let attempt = 0; attempt < 3; attempt += 1) await forceReconnect(client);
    await eventually(() => server.handle.getStats().connections === 2, 1_000, 'one server socket per client');
    client.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await b.waitFor(SERVER_EVENTS.typingUpdate);
    await delay(100);
    assert.equal(b.events(SERVER_EVENTS.typingUpdate).length, 1);
    client.close();
  });

  test('presence subscriptions are not carried over; a new subscribe is re-filtered', async () => {
    const { alice, bob } = await setup();
    await server.connect(alice);
    const client = reconnectingClient(server, bob.token);
    await eventually(() => client.connected, 2_000, 'first connect');
    client.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await client.waitFor(SERVER_EVENTS.presenceUpdate);
    await forceReconnect(client);
    assert.equal(server.handle.getStats().presenceSubscriptions, 0);
    server.handle.setPresencePreference('alice', 'away');
    const mark = client.mark();
    await client.expectNone(SERVER_EVENTS.presenceUpdate, () => true, { since: mark });
    server.authorizer.unfriend('alice', 'bob');
    client.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await client.expectNone(SERVER_EVENTS.presenceUpdate, () => true, { since: mark });
    client.close();
  });

  test('a reconnect with an expired session is rejected', async () => {
    const { alice } = await setup();
    const client = await server.connect(alice);
    client.close();
    server.sessions.remove(alice.token);
    server.sessions.markExpired(alice.token);
    assert.equal((await server.connectError(alice)).code, 'SESSION_EXPIRED');
  });
});

describe('session expiry and revocation', () => {
  afterEach(async () => {
    await server.close();
  });

  test('disconnects a connection when its session expires', async () => {
    server = await startTestServer();
    server.authorizer.grant('alice', 'dm-ab');
    const alice = server.addUser('alice', { ttlMs: 300 });
    const client = await server.connect(alice);
    assert.equal(await client.waitForDisconnect(2_000), 'io server disconnect');
    await eventually(() => zeroed(server), 1_000, 'state cleanup');
  });

  test('revokeSession closes every connection of that session and only that session', async () => {
    const { alice } = await setup();
    const otherSession = server.addUser('alice', { sessionId: 'alice-phone' });
    const first = await server.connect(alice);
    const second = await server.connect(alice);
    const phone = await server.connect(otherSession);
    const closing = [first.waitForDisconnect(), second.waitForDisconnect()];
    assert.equal(server.handle.revokeSession(alice.sessionId), 2);
    assert.deepEqual(await Promise.all(closing), ['io server disconnect', 'io server disconnect']);
    assert.equal(phone.connected, true);
    assert.equal((await server.connectError(alice)).code, 'UNAUTHORIZED', 'a revoked session cannot reconnect');
    assert.equal(server.handle.revokeSession('unknown-session'), 0);
    assert.throws(() => server.handle.revokeSession('bad id'), TypeError);
  });

  test('disconnectUser closes every connection of the user', async () => {
    const { alice, bob } = await setup();
    const a1 = await server.connect(alice);
    const a2 = await server.connect(server.addUser('alice', { sessionId: 'alice-tablet' }));
    const b = await server.connect(bob);
    const closing = [a1.waitForDisconnect(), a2.waitForDisconnect()];
    assert.equal(server.handle.disconnectUser('alice'), 2);
    await Promise.all(closing);
    assert.equal(b.connected, true);
    assert.equal(server.handle.getStats().users, 1);
  });

  test('periodic checkSession disconnects revoked and expired sessions and extends active ones', async () => {
    server = await startTestServer({ timing: { revalidationIntervalMs: 50 } });
    for (const user of ['alice', 'bob', 'carol']) server.authorizer.grant(user, 'dm');
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    const carol = server.addUser('carol', { ttlMs: 400 });
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const c = await server.connect(carol);
    server.sessions.sessionChecks.set(alice.sessionId, { status: 'revoked' });
    server.sessions.sessionChecks.set(bob.sessionId, { status: 'expired' });
    server.sessions.sessionChecks.set(carol.sessionId, { status: 'active', expiresAt: new Date(Date.now() + 60_000) });
    assert.equal(await a.waitForDisconnect(2_000), 'io server disconnect');
    assert.equal(await b.waitForDisconnect(2_000), 'io server disconnect');
    await delay(600);
    assert.equal(c.connected, true, 'the extended expiry replaced the original 400 ms expiry');
    assert.equal((await server.connectError(alice)).code, 'UNAUTHORIZED');
  });

  test('a failing checkSession keeps verified connections and logs a warning', async () => {
    server = await startTestServer({ timing: { revalidationIntervalMs: 40 } });
    server.authorizer.grant('alice', 'dm');
    const client = await server.connect(server.addUser('alice'));
    server.sessions.checkMode = 'throw';
    await eventually(() => server.sessions.checkCalls >= 2, 2_000, 'session checks');
    assert.equal(client.connected, true);
    assert.ok(server.logger.has('realtime.session.check_failed'));
  });

  test('revalidation works with a resolver that has no checkSession', async () => {
    server = await startTestServer({ minimalSessionResolver: true, timing: { revalidationIntervalMs: 40 } });
    server.authorizer.grant('alice', 'dm');
    const client = await server.connect(server.addUser('alice'));
    const calls = server.authorizer.conversationCalls;
    await eventually(() => server.authorizer.conversationCalls > calls, 2_000, 'grant revalidation');
    assert.equal(client.connected, true);
  });
});

describe('cleanup and shutdown', () => {
  afterEach(async () => {
    await server.close();
  });

  test('releases all per-connection state after clients leave', async () => {
    const { alice, bob } = await setup({ withStore: true, withVerifier: true });
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate);
    await b.waitFor(SERVER_EVENTS.typingUpdate);
    const stats = server.handle.getStats();
    assert.ok(stats.connections === 2 && stats.typingEntries === 1 && stats.presenceSubscriptions === 1 && stats.conversationRooms === 1);
    a.close();
    b.close();
    await eventually(() => zeroed(server), 1_000, 'all state released');
  });

  test('closes transports on shutdown, refuses new handshakes, and leaves the HTTP server open', async () => {
    const { alice, bob } = await setup();
    const a = await server.connect(alice);
    const disconnected = a.waitForDisconnect();
    const closing = server.handle.close();
    assert.equal(server.handle.close(), closing, 'close() is idempotent');
    await closing;
    assert.equal(await disconnected, 'transport close');
    assert.ok(zeroed(server));
    assert.equal(server.handle.getStats().closing, true);
    const error = await server.connectError(bob);
    assert.equal(error.code, undefined, 'rejected at the transport while closed');
    const response = await fetch(`${server.url}/other`);
    await response.arrayBuffer();
    assert.equal(response.status, 404, 'the caller’s HTTP server still serves other routes');
    assert.equal(server.handle.notifyConversationUpdated('dm-ab'), 0);
  });

  test('a packet above maxPayloadBytes closes only that transport', async () => {
    const { alice, bob } = await setup({ limits: { maxPayloadBytes: 4_096, maxCiphertextLength: 2_048 } });
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const disconnected = a.waitForDisconnect();
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'x'.repeat(10_000) });
    assert.match(await disconnected, /transport (close|error)/);
    const again = await server.connect(alice);
    again.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await b.waitFor(SERVER_EVENTS.typingUpdate);
  });

  test('conversation:updated goes only to the conversation room and validates input', async () => {
    const { alice, bob } = await setup();
    const outsider = server.addUser('carol');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const c = await server.connect(outsider);
    assert.equal(server.handle.notifyConversationUpdated('dm-ab', { displayName: 'Project chat' }), 2);
    for (const member of [a, b]) {
      const update = await member.waitFor(SERVER_EVENTS.conversationUpdated);
      assert.deepEqual(Object.keys(update).sort(), ['conversationId', 'displayName', 'updatedAt']);
      assert.equal(update.displayName, 'Project chat');
    }
    await c.expectNone(SERVER_EVENTS.conversationUpdated);
    assert.equal(server.handle.notifyConversationUpdated('no-members'), 0);
    assert.throws(() => server.handle.notifyConversationUpdated('dm-ab', { displayName: 'bad\nname' }), TypeError);
    server.handle.notifyConversationUpdated('dm-ab');
    const updates = (await eventually(() => a.events(SERVER_EVENTS.conversationUpdated).length === 2, 1_000, 'second update'),
      a.events(SERVER_EVENTS.conversationUpdated)) as Array<{ updatedAt: string; displayName?: string }>;
    assert.ok(Date.parse(updates[1]!.updatedAt) > Date.parse(updates[0]!.updatedAt));
    assert.equal('displayName' in updates[1]!, false);
  });
});
