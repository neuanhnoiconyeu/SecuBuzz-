import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Browser } from '../e2ee/support/dataApp.ts';
import { DataStack, delay } from './support/stack.ts';

describe('shared authenticated message pins', () => {
  let stack: DataStack;
  before(async () => { stack = await DataStack.start(); });
  after(async () => { await stack?.close(); });
  const change = (pinned: boolean, expectedVersion: number) => ({ pinned, expectedVersion, operationId: randomUUID() });

  test('either participant can pin/unpin with durable idempotence and identifier-only authorized hints', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const text = 'Private pinned text 👩🏽‍💻\nTiếng Việt';
    const envelope = await stack.envelope(alice, conversationId, epoch, text);
    const original = (await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope)).body.message;
    const a = await stack.connect(alice), b = await stack.connect(bob), stranger = await stack.person('stranger'), c = await stack.connect(stranger);
    const aMark = a.mark(), bMark = b.mark(), cMark = c.mark();
    const route = `/api/messages/${original.storageId}/pin`, intent = change(true, 0);
    const first = await bob.browser.mutate('POST', route, intent);
    assert.equal(first.status, 200); assert.equal(first.body.messageId, original.id); assert.equal(first.body.version, 1);
    assert.deepEqual(await a.waitFor('conversation:pins-changed', () => true, { since: aMark }), { conversationId });
    assert.deepEqual(await b.waitFor('conversation:pins-changed', () => true, { since: bMark }), { conversationId });
    const snapshot = await alice.browser.request(`/api/conversations/${conversationId}/pins`);
    assert.equal(snapshot.status, 200); assert.equal(snapshot.body.version, 1); assert.equal(snapshot.body.items[0].pinnedBy, bob.id);
    assert.deepEqual(snapshot.body.items[0].message, original); assert.ok(!JSON.stringify(snapshot.body).includes(text));
    assert.deepEqual((await bob.browser.mutate('POST', route, intent)).body, first.body);
    assert.equal((await alice.browser.mutate('POST', route, change(false, 1))).status, 200);
    // Replaying a previously confirmed pin cannot undo a later unpin.
    assert.deepEqual((await bob.browser.mutate('POST', route, intent)).body, first.body);
    const unpinned = await bob.browser.request(`/api/conversations/${conversationId}/pins`);
    assert.deepEqual(unpinned.body, { conversationId, version: 2, items: [] });
    assert.equal((await bob.browser.mutate('POST', route, { ...intent, pinned: false })).status, 409);
    assert.deepEqual((await stack.history(alice, conversationId)).items, [original]);
    await delay(100); assert.equal(c.events('conversation:pins-changed', cMark).length, 0);
  });

  test('concurrent changes use compare-and-swap; Unsend removes pins atomically and never revives ciphertext', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair('concurrent-a', 'concurrent-b');
    const envelope = await stack.envelope(alice, conversationId, epoch, 'Keep encryption immutable');
    const original = (await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope)).body.message;
    const route = `/api/messages/${original.storageId}/pin`;
    const results = await Promise.all([alice.browser.mutate('POST', route, change(true, 0)), bob.browser.mutate('POST', route, change(true, 0))]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const duplicate = change(true, 1);
    const repeats = await Promise.all([bob.browser.mutate('POST', route, duplicate), bob.browser.mutate('POST', route, duplicate)]);
    assert.equal(repeats[0].status, 200); assert.deepEqual(repeats[0].body, repeats[1].body); assert.equal(repeats[0].body.version, 1);
    const removed = await alice.browser.mutate('DELETE', `/api/messages/${original.storageId}`); assert.equal(removed.status, 200);
    for (const person of [alice, bob]) assert.deepEqual((await person.browser.request(`/api/conversations/${conversationId}/pins`)).body, { conversationId, version: 2, items: [] });
    assert.equal((await bob.browser.mutate('POST', route, change(true, 2))).status, 404);
    assert.deepEqual((await stack.history(bob, conversationId)).items, [removed.body.message]);
  });

  test('session, CSRF, membership, blocked interaction and body validation cannot be spoofed', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair('auth-a', 'auth-b');
    const envelope = await stack.envelope(alice, conversationId, epoch, 'Authorized metadata only');
    const original = (await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope)).body.message;
    const stranger = await stack.person('outsider'), anonymous = new Browser(stack.url), route = `/api/messages/${original.storageId}/pin`;
    assert.equal((await anonymous.request(route, { method: 'POST', body: change(true, 0) })).status, 401);
    assert.equal((await alice.browser.request(route, { method: 'POST', body: change(true, 0) })).status, 403);
    assert.equal((await stranger.browser.mutate('POST', route, change(true, 0))).status, 404);
    assert.equal((await stranger.browser.request(`/api/conversations/${conversationId}/pins`)).status, 404);
    assert.equal((await alice.browser.mutate('POST', route, { ...change(true, 0), pinnedBy: bob.id })).status, 400);
    assert.equal((await alice.browser.mutate('POST', route + '?userId=' + bob.id, change(true, 0))).status, 400);
    const socket = await stack.connect(bob), mark = socket.mark();
    assert.equal((await alice.browser.mutate('POST', '/api/blocks', { userId: bob.id })).status, 204);
    assert.equal((await bob.browser.mutate('POST', route, change(true, 0))).status, 404);
    assert.equal((await bob.browser.request(`/api/conversations/${conversationId}/pins`)).status, 404);
    assert.equal(await stack.bridge.realtime.notifyPinsChanged(conversationId), 0);
    await delay(100); assert.equal(socket.events('conversation:pins-changed', mark).length, 0);
  });
});
