import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import { delay, eventually, startTestServer, type TestServer } from '../support/harness.ts';

let server: TestServer;

describe('authorized room management', () => {
  beforeEach(async () => {
    server = await startTestServer({ rates: { invalid: { capacity: 3, refillPerSecond: 0 } } });
  });
  afterEach(async () => {
    await server.close();
  });

  test('joins only the conversations the authorizer grants', async () => {
    const alice = server.addUser('alice');
    server.authorizer.grant('alice', 'dm-ab', 'group-1');
    await server.connect(alice);
    assert.equal(server.handle.getStats().conversationRooms, 2);
    assert.equal(server.authorizer.conversationCalls, 1);
  });

  test('isolates conversations: members of one conversation never see another conversation’s events', async () => {
    const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((id) => server.addUser(id)) as [ReturnType<TestServer['addUser']>, ReturnType<TestServer['addUser']>, ReturnType<TestServer['addUser']>];
    server.authorizer.grant('alice', 'dm-ab', 'dm-ac');
    server.authorizer.grant('bob', 'dm-ab');
    server.authorizer.grant('carol', 'dm-ac');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const c = await server.connect(carol);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    assert.equal((await b.waitFor(SERVER_EVENTS.typingUpdate)).conversationId, 'dm-ab');
    await c.expectNone(SERVER_EVENTS.typingUpdate);
  });

  test('denies group activity to users the authorizer does not list as members', async () => {
    const [alice, bob, outsider] = ['alice', 'bob', 'outsider'].map((id) => server.addUser(id)) as Array<ReturnType<TestServer['addUser']>>;
    server.authorizer.grant('alice', 'group-1');
    server.authorizer.grant('bob', 'group-1');
    const a = await server.connect(alice!);
    const b = await server.connect(bob!);
    const o = await server.connect(outsider!);
    // A non-member naming the group ID is not proof of membership.
    o.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await a.expectNone(SERVER_EVENTS.typingUpdate);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await b.waitFor(SERVER_EVENTS.typingUpdate);
    await o.expectNone(SERVER_EVENTS.typingUpdate);
  });

  test('exposes no client event that joins or selects rooms', async () => {
    const mallory = server.addUser('mallory');
    const bob = server.addUser('bob');
    server.authorizer.grant('bob', 'secret-room');
    const m = await server.connect(mallory);
    const b = await server.connect(bob);
    for (const event of ['join', 'room:join', 'conversation:join', 'subscribe']) m.emit(event, { conversationId: 'secret-room' });
    await delay(50);
    b.emit(CLIENT_EVENTS.typingStart, { conversationId: 'secret-room' });
    await m.expectNone(SERVER_EVENTS.typingUpdate);
    assert.equal(server.handle.getStats().conversationRooms, 1);
  });

  test('fails the connection closed when the authorizer throws, hangs or returns malformed or oversized grants', async () => {
    const alice = server.addUser('alice');
    for (const mode of ['throw', 'hang', 'malformed'] as const) {
      server.authorizer.conversationsMode = mode;
      assert.equal((await server.connectError(alice)).code, 'REALTIME_UNAVAILABLE', `conversations ${mode}`);
    }
    server.authorizer.conversationsMode = 'normal';
    for (const mode of ['throw', 'malformed'] as const) {
      server.authorizer.blocksMode = mode;
      assert.equal((await server.connectError(alice)).code, 'REALTIME_UNAVAILABLE', `blocks ${mode}`);
    }
    server.authorizer.blocksMode = 'normal';
    server.authorizer.conversationsOverride = Array.from({ length: 1_001 }, (_, index) => `c${index}`);
    assert.equal((await server.connectError(alice)).code, 'REALTIME_UNAVAILABLE', 'more grants than maxConversationsPerUser');
    server.authorizer.conversationsOverride = ['ok', 'has space'];
    assert.equal((await server.connectError(alice)).code, 'REALTIME_UNAVAILABLE', 'invalid conversation identifier');
    assert.equal(server.handle.getStats().connections, 0);
  });

  test('revokeConversationAccess removes the room immediately and stops delivery', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.grant('alice', 'group-1');
    server.authorizer.grant('bob', 'group-1');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const callsBefore = server.authorizer.conversationCalls;
    assert.equal(server.handle.revokeConversationAccess('bob', 'group-1'), true);
    assert.equal(server.authorizer.conversationCalls, callsBefore, 'revocation does not depend on the authorizer');
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await b.expectNone(SERVER_EVENTS.typingUpdate);
    b.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await a.expectNone(SERVER_EVENTS.typingUpdate);
    assert.equal(server.handle.revokeConversationAccess('bob', 'group-1'), false);
    assert.equal(server.handle.revokeConversationAccess('nobody', 'group-1'), false);
  });

  test('refreshUserAccess applies authorizer changes to every connection of the user', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.grant('alice', 'c-old', 'c-new');
    server.authorizer.grant('bob', 'c-old');
    const b1 = await server.connect(bob);
    const b2 = await server.connect(bob);
    const a = await server.connect(alice);
    server.authorizer.revoke('bob', 'c-old');
    server.authorizer.grant('bob', 'c-new');
    assert.equal(await server.handle.refreshUserAccess('bob'), true);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c-new' });
    await b1.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.conversationId === 'c-new');
    await b2.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.conversationId === 'c-new');
    const mark = b1.mark();
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c-old' });
    await b1.expectNone(SERVER_EVENTS.typingUpdate, (payload) => payload.conversationId === 'c-old', { since: mark });
    assert.equal(await server.handle.refreshUserAccess('not-connected'), false);
  });

  test('a failed refresh keeps the last verified grants and grants nothing new', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.grant('alice', 'c1', 'c2');
    server.authorizer.grant('bob', 'c1');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    server.authorizer.grant('bob', 'c2');
    server.authorizer.conversationsMode = 'throw';
    assert.equal(await server.handle.refreshUserAccess('bob'), false);
    assert.ok(server.logger.has('realtime.access.refresh_failed'));
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c1' });
    await b.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.conversationId === 'c1');
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c2' });
    await b.expectNone(SERVER_EVENTS.typingUpdate, (payload) => payload.conversationId === 'c2');
  });

  test('a newer connection’s fresh grants replace the user’s grants on every existing connection', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.grant('alice', 'c1');
    server.authorizer.grant('bob', 'c1');
    const a = await server.connect(alice);
    const bOld = await server.connect(bob);
    server.authorizer.revoke('bob', 'c1');
    await server.connect(bob);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c1' });
    await bOld.expectNone(SERVER_EVENTS.typingUpdate);
  });

  test('a revocation during a handshake is not undone by the handshake’s stale grants', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.grant('alice', 'group-1');
    server.authorizer.grant('bob', 'group-1');
    const a = await server.connect(alice);
    const original = server.authorizer.listConversationIds.bind(server.authorizer);
    server.authorizer.listConversationIds = async (actor) => {
      const snapshot = await original(actor);   // read before the removal commits
      if (actor.userId === 'bob') await delay(120);
      return snapshot;
    };
    const connecting = server.connect(bob);
    await delay(40);
    server.authorizer.revoke('bob', 'group-1');
    assert.equal(server.handle.revokeConversationAccess('bob', 'group-1'), false, 'bob is not connected yet');
    const b = await connecting;
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await b.expectNone(SERVER_EVENTS.typingUpdate);
    assert.equal(server.handle.getStats().conversationRooms, 1);
  });

  test('an older authorizer snapshot never overwrites a newer one', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.grant('alice', 'group-1');
    server.authorizer.grant('bob', 'group-1');
    const a = await server.connect(alice);
    const b1 = await server.connect(bob);
    const original = server.authorizer.listConversationIds.bind(server.authorizer);
    let slowNext = true;
    server.authorizer.listConversationIds = async (actor) => {
      const snapshot = await original(actor);
      if (actor.userId === 'bob' && slowNext) {
        slowNext = false;
        await delay(150);
      }
      return snapshot;
    };
    const stale = server.connect(bob);   // its handshake reads the old membership slowly
    await delay(30);
    server.authorizer.revoke('bob', 'group-1');
    assert.equal(await server.handle.refreshUserAccess('bob'), true, 'the newer refresh applies first');
    const b2 = await stale;
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await b1.expectNone(SERVER_EVENTS.typingUpdate);
    await b2.expectNone(SERVER_EVENTS.typingUpdate, () => true, { ms: 0 });
  });

  test('periodic revalidation applies grant revocations without a push', async () => {
    const target = await startTestServer({ timing: { revalidationIntervalMs: 60 } });
    try {
      const alice = target.addUser('alice');
      const bob = target.addUser('bob');
      target.authorizer.grant('alice', 'c1');
      target.authorizer.grant('bob', 'c1');
      const a = await target.connect(alice);
      const b = await target.connect(bob);
      target.authorizer.revoke('bob', 'c1');
      await eventually(() => target.handle.getStats().conversationRooms === 1 && target.authorizer.conversationCalls >= 4, 2_000, 'revalidation');
      a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c1' });
      await b.expectNone(SERVER_EVENTS.typingUpdate);
    } finally {
      await target.close();
    }
  });
});

describe('blocked users', () => {
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  test('typing is not routed in either direction of a block, even in a shared group', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    const carol = server.addUser('carol');
    for (const user of ['alice', 'bob', 'carol']) server.authorizer.grant(user, 'group-1');
    server.authorizer.block('alice', 'bob');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const c = await server.connect(carol);
    b.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await c.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.userId === 'bob');
    await a.expectNone(SERVER_EVENTS.typingUpdate);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'group-1' });
    await c.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.userId === 'alice');
    await b.expectNone(SERVER_EVENTS.typingUpdate, (payload) => payload.userId === 'alice');
  });

  test('a block added through refreshUserAccess takes effect immediately', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.grant('alice', 'dm');
    server.authorizer.grant('bob', 'dm');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm' });
    await b.waitFor(SERVER_EVENTS.typingUpdate);
    server.authorizer.block('bob', 'alice');
    await server.handle.refreshUserAccess('bob');
    const mark = b.mark();
    a.emit(CLIENT_EVENTS.typingStop, { conversationId: 'dm' });
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm' });
    await b.expectNone(SERVER_EVENTS.typingUpdate, () => true, { since: mark });
  });
});

describe('event validation', () => {
  beforeEach(async () => {
    server = await startTestServer({ rates: { invalid: { capacity: 3, refillPerSecond: 0 } } });
  });
  afterEach(async () => {
    await server.close();
  });

  test('unknown events and malformed bodies exhaust the invalid budget and disconnect the socket', async () => {
    const alice = server.addUser('alice');
    server.authorizer.grant('alice', 'c1');
    const client = await server.connect(alice);
    const disconnected = client.waitForDisconnect();
    client.emit('admin:grant', { conversationId: 'c1' });
    client.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c1', extra: true });
    client.emit(CLIENT_EVENTS.typingStart, 'c1');
    client.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: 'everyone' });
    assert.equal(await disconnected, 'io server disconnect');
    assert.ok(server.logger.has('realtime.connection.invalid_budget_exhausted'));
    await eventually(() => server.handle.getStats().connections === 0, 1_000, 'cleanup');
  });

  test('acknowledged events without a callback, or with extra arguments, are rejected without processing', async () => {
    const target = await startTestServer({ withStore: true });
    try {
      const alice = target.addUser('alice');
      target.authorizer.grant('alice', 'c1');
      target.store.seed('c1', 'm1', 'bob');
      const client = await target.connect(alice);
      client.emit(CLIENT_EVENTS.messageRead, { conversationId: 'c1', messageId: 'm1' });
      client.emit(CLIENT_EVENTS.messageRead, { conversationId: 'c1', messageId: 'm1' }, 'extra', () => undefined);
      await delay(100);
      assert.equal(target.store.receiptCalls.length, 0);
      const response = await client.emitAck(CLIENT_EVENTS.messageRead, { conversationId: 'c1', messageId: 'm1', userId: 'bob' });
      assert.deepEqual(response, { status: 'error', code: 'invalid_payload' });
    } finally {
      await target.close();
    }
  });

  test('typing and presence events that carry a callback are rejected', async () => {
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.grant('alice', 'c1');
    server.authorizer.grant('bob', 'c1');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c1' }, () => undefined);
    await b.expectNone(SERVER_EVENTS.typingUpdate);
  });
});
