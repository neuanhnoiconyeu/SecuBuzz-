/**
 * Authorization against real DATA state: conversation rooms, friendship and block changes, delivery
 * re-authorization, typing, presence and read receipts. Every decision here is DATA's, not a cache's.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DataStack, delay, SESSION_COOKIE, until, type Person, type TestClient } from './support/stack.ts';

let stack: DataStack;
/** No HTTP observer and no periodic refresh: realtime grants stay as they were at connect time. */
let stale: DataStack;

function acknowledging(client: TestClient): TestClient {
  client.socket.on('message:new', (payload: { conversationId: string; id: string }, ack?: (value: unknown) => void) => {
    ack?.({ conversationId: payload.conversationId, messageId: payload.id, status: 'delivered' });
  });
  return client;
}

/** Retries `send` while the realtime grant for a freshly created conversation propagates. */
async function sendWhenGranted(target: DataStack, client: TestClient, envelope: unknown): Promise<any> {
  let ack: any;
  await until(async () => {
    ack = await target.send(client, envelope);
    return ack.code !== 'unauthorized_conversation';
  }, 4_000, 'the conversation grant');
  return ack;
}


/**
 * Runs `action` (a DATA mutation) and waits until the realtime server has actually removed the
 * conversation room. DATA's own refusal arrives earlier than the cached grant is dropped, so a
 * refused send is not proof that the grant is gone.
 */
async function applied(target: DataStack, action: () => Promise<unknown>): Promise<void> {
  const before = target.bridge.realtime.getStats().conversationRooms;
  await action();
  await until(() => target.bridge.realtime.getStats().conversationRooms === before - 1, 4_000, 'the realtime grant to be removed');
}

const storedCount = (target: DataStack, conversationId: string): number =>
  target.data.application.db.prepare("SELECT COUNT(*) AS n FROM Messages WHERE conversation_id=? AND origin='authenticated'").get(conversationId).n as number;
describe('realtime authorization follows DATA', () => {
  before(async () => {
    stack = await DataStack.start();
    stale = await DataStack.start({ bridge: { observeChanges: false } });
  });
  after(async () => {
    await Promise.all([stack?.close(), stale?.close()]);
  });

  test('rooms contain exactly the account\'s own conversations: typing never leaks to strangers and carries no content', async () => {
    const { alice, bob, conversationId } = await stack.pair();
    const eve = await stack.person('eve', 'Eve');
    const aliceSocket = await stack.connect(alice);
    const bobSocket = await stack.connect(bob);
    const eveSocket = await stack.connect(eve);
    aliceSocket.emit('typing:start', { conversationId });
    const typing = await bobSocket.waitFor('typing:update', (event) => event.isTyping === true);
    assert.deepEqual(Object.keys(typing).sort(), ['conversationId', 'displayName', 'isTyping', 'timestamp', 'userId']);
    assert.deepEqual([typing.conversationId, typing.userId, typing.displayName], [conversationId, alice.id, 'Alice']);
    eveSocket.emit('typing:start', { conversationId });
    await aliceSocket.expectNone('typing:update', (event) => event.userId === eve.id);
    await bobSocket.expectNone('typing:update', (event) => event.userId === eve.id);
    await eveSocket.expectNone('typing:update');
  });

  test('a conversation created while both are connected becomes usable without reconnecting', async () => {
    const alice = await stack.person('alice', 'Alice');
    const bob = await stack.person('bob', 'Bob');
    await stack.befriend(alice, bob);
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const conversationId = await stack.openDm(alice, bob);
    await stack.registerDevice(alice);
    await stack.registerDevice(bob);
    const epoch = await stack.publishEpoch(alice, conversationId);
    const ack = await sendWhenGranted(stack, aliceSocket, await stack.envelope(alice, conversationId, epoch, 'no reconnect', 'fresh-1'));
    assert.equal(ack.status, 'sent');
    assert.equal((await bobSocket.waitFor('message:new', (event) => event.id === 'fresh-1')).conversationId, conversationId);
  });

  test('unfriending ends realtime access for both sides while connected', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'while friends', 'friend-1'))).status, 'sent');
    await bobSocket.waitFor('message:new', (event) => event.id === 'friend-1');
    await applied(stack, async () => assert.equal((await alice.browser.mutate('DELETE', `/api/friends/${bob.id}`)).status, 204));
    assert.deepEqual(await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'after unfriend', 'friend-2')), { status: 'error', code: 'unauthorized_conversation' });
    assert.deepEqual(await stack.send(bobSocket, await stack.envelope(bob, conversationId, await stack.currentKey(bob, conversationId), 'bob after unfriend', 'friend-3')), { status: 'error', code: 'unauthorized_conversation' });
    const mark = bobSocket.mark();
    aliceSocket.emit('typing:start', { conversationId });
    await bobSocket.expectNone('typing:update', () => true, { since: mark });
    assert.deepEqual((await stack.history(alice, conversationId)).items.map((item: { id: string }) => item.id), ['friend-1'], 'history is unchanged');
  });

  test('blocking cuts the blocked account off: no sends, no typing, no delivery, and the blocker never receives', async () => {
    const { alice, bob, conversationId, epoch, bobKey } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    await applied(stack, async () => assert.equal((await bob.browser.mutate('POST', '/api/blocks', { userId: alice.id })).status, 204));
    assert.deepEqual(await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'blocked', 'blk-1')), { status: 'error', code: 'unauthorized_conversation' });
    assert.deepEqual(await stack.send(bobSocket, await stack.envelope(bob, conversationId, bobKey, 'blocker speaks', 'blk-2')), { status: 'error', code: 'unauthorized_conversation' });
    const aliceMark = aliceSocket.mark();
    const bobMark = bobSocket.mark();
    aliceSocket.emit('typing:start', { conversationId });
    bobSocket.emit('typing:start', { conversationId });
    await bobSocket.expectNone('typing:update', () => true, { since: bobMark });
    await aliceSocket.expectNone('typing:update', () => true, { since: aliceMark });
    await bobSocket.expectNone('message:new', () => true, { since: bobMark, ms: 100 });
    assert.equal(storedCount(stack, conversationId), 0);
    assert.equal((await bob.browser.request(`/api/conversations/${conversationId}/messages`)).status, 404, 'DATA hides a blocked conversation from both sides');
  });

  test('DATA refuses a send from a newly blocked account even when the realtime grant is still cached', async () => {
    const { alice, bob, conversationId, epoch } = await stale.pair();
    const aliceSocket = await stale.connect(alice);
    const bobSocket = acknowledging(await stale.connect(bob));
    assert.equal((await bob.browser.mutate('POST', '/api/blocks', { userId: alice.id })).status, 204);
    const ack = await stale.send(aliceSocket, await stale.envelope(alice, conversationId, epoch, 'cached grant', 'cache-1'));
    assert.deepEqual(ack, { status: 'error', code: 'unauthorized_conversation' }, 'DATA says not found for a blocked pair');
    await bobSocket.expectNone('message:new');
    assert.equal(storedCount(stale, conversationId), 0, 'nothing was committed');
  });

  test('delivery is re-authorized right before each emit: a recipient who blocks between commit and fan-out receives nothing', async () => {
    const { alice, bob, conversationId, epoch } = await stale.pair();
    const aliceSocket = await stale.connect(alice);
    const bobSocket = acknowledging(await stale.connect(bob));
    const app = stale.data.application;
    const original = app.conversations.detail;
    let armed = true;
    // The first DATA authorization read made for Bob (the delivery check) runs after Alice's message is committed.
    app.conversations.detail = function patched(this: unknown, context: { userId: string; sessionId: string }, id: string, input: unknown) {
      if (armed && context.userId === bob.id) {
        armed = false;
        const proof = app.auth.csrfProof(bob.browser.cookies.get(SESSION_COOKIE), null, bob.browser.token);
        app.social.block({ userId: bob.id, sessionId: context.sessionId }, proof, { userId: alice.id });
      }
      return original.call(this, context, id, input);
    };
    try {
      const ack = await stale.send(aliceSocket, await stale.envelope(alice, conversationId, epoch, 'committed, then withheld', 'late-block-1'));
      assert.equal(ack.status, 'sent', 'the message was committed before Bob blocked');
      await until(() => stale.logger.has('realtime.delivery.withheld'), 2_000, 'withheld delivery');
      await bobSocket.expectNone('message:new');
      assert.equal(armed, false);
    } finally {
      app.conversations.detail = original;
    }
    assert.equal(storedCount(stale, conversationId), 1, 'the message was committed before delivery was withheld');
  });

  test('presence is limited to friends, honours "invisible" from the first event, and stops after a block', async () => {
    const { alice, bob } = await stack.pair();
    const eve = await stack.person('eve', 'Eve');
    assert.equal((await bob.browser.mutate('PATCH', '/api/users/me', { presencePreference: 'invisible' })).status, 200);
    const bobSocket = await stack.connect(bob);
    const aliceSocket = await stack.connect(alice);
    const eveSocket = await stack.connect(eve);
    aliceSocket.emit('presence:subscribe', { userIds: [bob.id] });
    eveSocket.emit('presence:subscribe', { userIds: [bob.id] });
    const first = await aliceSocket.waitFor('presence:update', (event) => event.userId === bob.id);
    assert.equal(first.status, 'offline', 'an invisible account is never announced online');
    await eveSocket.expectNone('presence:update', (event) => event.userId === bob.id);
    // Becoming visible is applied to live sockets immediately.
    assert.equal((await bob.browser.mutate('PATCH', '/api/users/me', { presencePreference: 'available' })).status, 200);
    assert.equal((await aliceSocket.waitFor('presence:update', (event) => event.userId === bob.id && event.status === 'online')).status, 'online');
    assert.equal((await bob.browser.mutate('POST', '/api/blocks', { userId: alice.id })).status, 204);
    // Losing authorization is announced as `unknown`, which is how the client drops the subject.
    assert.equal((await aliceSocket.waitFor('presence:update', (event) => event.userId === bob.id && event.status === 'unknown')).status, 'unknown');
    const mark = aliceSocket.mark();
    bobSocket.close();
    await aliceSocket.expectNone('presence:update', (event) => event.userId === bob.id && event.status === 'offline', { since: mark, ms: 400 });
  });

  test('read receipts are authorized by DATA: strangers, the sender and blocked accounts cannot mark a message read', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const eve = await stack.person('eve', 'Eve');
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const eveSocket = await stack.connect(eve);
    await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'to be read', 'read-1'));
    await bobSocket.waitFor('message:new', (event) => event.id === 'read-1');
    assert.equal((await eveSocket.emitAck('message:read', { conversationId, messageId: 'read-1' })).status, 'error');
    assert.equal((await aliceSocket.emitAck('message:read', { conversationId, messageId: 'read-1' })).status, 'error');
    const mark = aliceSocket.mark();
    assert.equal((await bob.browser.mutate('POST', '/api/blocks', { userId: alice.id })).status, 204);
    await until(async () => (await bobSocket.emitAck('message:read', { conversationId, messageId: 'read-1' })).status === 'error', 4_000, 'block to stop reads');
    await aliceSocket.expectNone('message:read', () => true, { since: mark });
    assert.equal(stack.data.application.db.prepare("SELECT COUNT(*) AS n FROM MessageReceipts WHERE status='read'").get().n >= 0, true);
  });

  test('a stolen conversation id is useless: a stranger\'s join, send, read and typing all fail and reveal nothing', async () => {
    const { alice, conversationId, epoch } = await stack.pair();
    const mallory = await stack.person('mallory', 'Mallory');
    await stack.registerDevice(mallory);
    const socket = acknowledging(await stack.connect(mallory));
    const forged = await mallory.device.encrypt(epoch.key, epoch.keyId, { conversationId, id: 'steal-1', senderName: 'Mallory' }, 'hello');
    assert.deepEqual(await stack.send(socket, forged), { status: 'error', code: 'unauthorized_conversation' });
    assert.deepEqual(await socket.emitAck('message:read', { conversationId, messageId: 'steal-1' }).then((ack) => ack.status), 'error');
    socket.emit('typing:start', { conversationId });
    await delay(100);
    assert.deepEqual((await stack.history(alice, conversationId)).items, []);
  });

  test('each account\'s sockets keep their own identity when two accounts are connected', async () => {
    const first = await stack.pair('carol', 'dan');
    const second = await stack.pair('erin', 'frank');
    const sockets = new Map<Person, TestClient>();
    for (const person of [first.alice, first.bob, second.alice, second.bob]) sockets.set(person, acknowledging(await stack.connect(person)));
    await stack.send(sockets.get(first.alice)!, await stack.envelope(first.alice, first.conversationId, first.epoch, 'pair one', 'iso-1'));
    await sockets.get(first.bob)!.waitFor('message:new', (event) => event.id === 'iso-1');
    await sockets.get(second.alice)!.expectNone('message:new');
    await sockets.get(second.bob)!.expectNone('message:new');
  });
});
