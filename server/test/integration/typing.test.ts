import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import { delay, eventually, startTestServer, type HarnessOptions, type TestServer } from '../support/harness.ts';

let server: TestServer;

async function setup(options: HarnessOptions = {}) {
  server = await startTestServer(options);
  const alice = server.addUser('alice', { displayName: 'Alice Morgan' });
  const bob = server.addUser('bob', { displayName: 'Bob' });
  for (const user of ['alice', 'bob']) server.authorizer.grant(user, 'dm-ab');
  return { alice, bob, a: await server.connect(alice), b: await server.connect(bob) };
}

describe('typing relay', () => {
  afterEach(async () => {
    await server.close();
  });

  test('relays typing:update with the session actor, display name and a server timestamp', async () => {
    const { a, b } = await setup();
    const before = Date.now();
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    const update = await b.waitFor(SERVER_EVENTS.typingUpdate);
    assert.deepEqual(Object.keys(update).sort(), ['conversationId', 'displayName', 'isTyping', 'timestamp', 'userId']);
    assert.equal(update.conversationId, 'dm-ab');
    assert.equal(update.userId, 'alice');
    assert.equal(update.displayName, 'Alice Morgan');
    assert.equal(update.isTyping, true);
    assert.match(update.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(update.timestamp) - before) < 2_000);
    a.emit(CLIENT_EVENTS.typingStop, { conversationId: 'dm-ab' });
    const stop = await b.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.isTyping === false);
    assert.ok(Date.parse(stop.timestamp) > Date.parse(update.timestamp));
  });

  test('never echoes typing to the typist’s own connections', async () => {
    const { alice, a, b } = await setup();
    const aSecond = await server.connect(alice);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await b.waitFor(SERVER_EVENTS.typingUpdate);
    await a.expectNone(SERVER_EVENTS.typingUpdate);
    await aSecond.expectNone(SERVER_EVENTS.typingUpdate);
  });

  test('drops typing for conversations the connection is not authorized for', async () => {
    const { a, b } = await setup();
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-bc' });
    await b.expectNone(SERVER_EVENTS.typingUpdate);
  });

  test('rejects bodies that try to supply an actor identity', async () => {
    const { a, b } = await setup();
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab', userId: 'bob' });
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab', displayName: 'Admin' });
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab', isTyping: false });
    await b.expectNone(SERVER_EVENTS.typingUpdate);
  });

  test('rate limits typing per connection', async () => {
    const { a, b } = await setup({ rates: { typing: { capacity: 3, refillPerSecond: 0 } } });
    for (let index = 0; index < 6; index += 1) a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await eventually(() => b.events(SERVER_EVENTS.typingUpdate).length >= 3, 1_000, 'three relays');
    await delay(150);
    assert.equal(b.events(SERVER_EVENTS.typingUpdate).length, 3);
  });

  test('timestamps strictly increase per conversation and user across rapid updates', async () => {
    const { a, b } = await setup({ rates: { typing: { capacity: 20, refillPerSecond: 0 } } });
    for (let index = 0; index < 5; index += 1) {
      a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
      a.emit(CLIENT_EVENTS.typingStop, { conversationId: 'dm-ab' });
    }
    await eventually(() => b.events(SERVER_EVENTS.typingUpdate).length === 10, 1_000, 'ten relays');
    const times = b.events(SERVER_EVENTS.typingUpdate).map((payload) => Date.parse((payload as { timestamp: string }).timestamp));
    for (let index = 1; index < times.length; index += 1) assert.ok(times[index]! > times[index - 1]!, `timestamp ${index}`);
  });

  test('a stop without a start is not relayed', async () => {
    const { a, b } = await setup();
    a.emit(CLIENT_EVENTS.typingStop, { conversationId: 'dm-ab' });
    await b.expectNone(SERVER_EVENTS.typingUpdate);
  });

  test('a user stays typing while any of their connections is typing', async () => {
    const { alice, a, b } = await setup();
    const aSecond = await server.connect(alice);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    aSecond.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await eventually(() => b.events(SERVER_EVENTS.typingUpdate).length === 2, 1_000, 'two starts');
    const mark = b.mark();
    a.emit(CLIENT_EVENTS.typingStop, { conversationId: 'dm-ab' });
    await b.expectNone(SERVER_EVENTS.typingUpdate, () => true, { since: mark });
    aSecond.emit(CLIENT_EVENTS.typingStop, { conversationId: 'dm-ab' });
    assert.equal((await b.waitFor(SERVER_EVENTS.typingUpdate, () => true, { since: mark })).isTyping, false);
  });

  test('disconnect emits isTyping:false to remaining participants and clears state', async () => {
    const { a, b } = await setup();
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await b.waitFor(SERVER_EVENTS.typingUpdate);
    assert.equal(server.handle.getStats().typingEntries, 1);
    a.close();
    const stop = await b.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.isTyping === false);
    assert.equal(stop.userId, 'alice');
    await eventually(() => server.handle.getStats().typingEntries === 0, 1_000, 'typing cleanup');
  });

  test('membership revocation stops the revoked user’s typing indicator', async () => {
    server = await startTestServer();
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    for (const user of ['alice', 'bob']) server.authorizer.grant(user, 'group-1');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await b.waitFor(SERVER_EVENTS.typingUpdate);
    server.handle.revokeConversationAccess('alice', 'group-1');
    const stop = await b.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.isTyping === false);
    assert.equal(stop.userId, 'alice');
    assert.equal(server.handle.getStats().typingEntries, 0);
    const mark = b.mark();
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await b.expectNone(SERVER_EVENTS.typingUpdate, () => true, { since: mark });
  });

  test('typing state expires after the TTL and is never persisted', async () => {
    const { a, b } = await setup({ withStore: true, timing: { typingTtlMs: 120 } });
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    await b.waitFor(SERVER_EVENTS.typingUpdate);
    await eventually(() => server.handle.getStats().typingEntries === 0, 1_000, 'typing TTL sweep');
    const mark = b.mark();
    a.close();
    await b.expectNone(SERVER_EVENTS.typingUpdate, () => true, { since: mark });
    assert.equal(server.store.storeCalls, 0);
    assert.equal(server.store.receiptCalls.length, 0);
  });

  test('group typing reaches every other authorized member', async () => {
    server = await startTestServer();
    const users = ['alice', 'bob', 'carol', 'dave'].map((id) => server.addUser(id));
    for (const user of users) server.authorizer.grant(user.userId, 'group-1');
    const clients = await Promise.all(users.map((user) => server.connect(user)));
    clients[0]!.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    for (const client of clients.slice(1)) assert.equal((await client.waitFor(SERVER_EVENTS.typingUpdate)).userId, 'alice');
    await clients[0]!.expectNone(SERVER_EVENTS.typingUpdate);
  });
});
