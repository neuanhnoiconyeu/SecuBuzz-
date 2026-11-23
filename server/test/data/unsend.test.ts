import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DataStack, delay } from './support/stack.ts';

describe('sender-authorized Unsend REST changes reach authenticated realtime recipients', () => {
  let stack: DataStack;
  before(async () => { stack = await DataStack.start(); });
  after(async () => { await stack?.close(); });

  test('post-commit hint uses wire IDs, reaches both participants, and preserves a stable durable tombstone', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice), bobSocket = await stack.connect(bob);
    const envelope = await stack.envelope(alice, conversationId, epoch, 'Encrypted before Unsend', 'wire/with+é');
    const submitted = await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope);
    assert.equal(submitted.status, 201); const original = submitted.body.message;
    assert.notEqual(original.storageId, original.id);
    const aMark = aliceSocket.mark(), bMark = bobSocket.mark();
    const removed = await alice.browser.mutate('DELETE', `/api/messages/${original.storageId}`);
    assert.equal(removed.status, 200);
    const expected = { conversationId, messageId: envelope.id };
    assert.deepEqual(await aliceSocket.waitFor('message:deleted', () => true, { since: aMark }), expected);
    assert.deepEqual(await bobSocket.waitFor('message:deleted', () => true, { since: bMark }), expected);
    assert.equal(removed.body.message.id, original.id); assert.equal(removed.body.message.storageId, original.storageId);
    assert.equal(removed.body.message.sequence, original.sequence); assert.equal(removed.body.message.encryption, null);
    assert.equal(removed.body.message.state, 'deleted'); assert.equal(removed.body.message.revision, original.revision + 1);
    const again = await alice.browser.mutate('DELETE', `/api/messages/${original.storageId}`);
    assert.deepEqual(again.body, removed.body);
    const history = await stack.history(bob, conversationId);
    assert.deepEqual(history.items.find((m: { id: string }) => m.id === original.id), removed.body.message);
    const duplicate = await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope);
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.message.state, 'deleted');
  });

  test('recipient and stranger deletion, missing CSRF, and forged socket deletion are refused without notifications', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const socket = await stack.connect(bob), stranger = await stack.person('stranger');
    const outsider = await stack.connect(stranger);
    const envelope = await stack.envelope(alice, conversationId, epoch, 'Must remain unchanged');
    const original = (await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope)).body.message;
    const mark = socket.mark(), outsiderMark = outsider.mark();
    assert.equal((await bob.browser.mutate('DELETE', `/api/messages/${original.storageId}`)).status, 403);
    assert.equal((await stranger.browser.mutate('DELETE', `/api/messages/${original.storageId}`)).status, 404);
    const noCsrf = await alice.browser.request(`/api/messages/${original.storageId}`, { method: 'DELETE' });
    assert.equal(noCsrf.status, 403);
    await assert.rejects(socket.emitAck('message:deleted', { conversationId, messageId: envelope.id }), /timed out/);
    await delay(100);
    assert.equal(socket.events('message:deleted', mark).length, 0); assert.equal(outsider.events('message:deleted', outsiderMark).length, 0);
    assert.equal((await stack.history(alice, conversationId)).items[0].state, 'active');
  });
});

test('a stale room grant never overrides current block or session authorization for a deletion hint', async () => {
  const stack = await DataStack.start({ bridge: { observeChanges: false } });
  try {
    const { alice, bob, conversationId } = await stack.pair();
    const socket = await stack.connect(bob), mark = socket.mark();
    assert.equal((await alice.browser.mutate('POST', '/api/blocks', { userId: bob.id })).status, 204);
    assert.equal(await stack.bridge.realtime.notifyMessageDeleted(conversationId, 'wire-id'), 0);
    await delay(100); assert.equal(socket.events('message:deleted', mark).length, 0);
    const next = await stack.pair('session-alice', 'session-bob'), loggedOut = await stack.connect(next.bob), sessionMark = loggedOut.mark();
    assert.equal((await next.bob.browser.mutate('POST', '/api/auth/logout')).status, 204);
    assert.equal(await stack.bridge.realtime.notifyMessageDeleted(next.conversationId, 'wire-id'), 0);
    await delay(100); assert.equal(loggedOut.events('message:deleted', sessionMark).length, 0);
  } finally { await stack.close(); }
});
