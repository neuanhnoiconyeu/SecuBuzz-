import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { DataStack } from './support/stack.ts';
import { TestDevice } from '../e2ee/support/deviceClient.ts';

let stack: DataStack;
before(async () => { stack = await DataStack.start(); });
after(async () => { await stack?.close(); });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

for (const blockingSide of ['alice', 'bob'] as const) test(`${blockingSide} blocks/unblocks: history/keys survive and interaction requires renewed friendship`, async () => {
  const pair = await stack.pair(`lifecycle-${blockingSide}-a`, `lifecycle-${blockingSide}-b`);
  const { alice, bob, conversationId: cid, epoch, bobKey } = pair, blocker = pair[blockingSide], blocked = blockingSide === 'alice' ? bob : alice;
  const originalDeviceIds = [await alice.browser.request('/api/keys/devices'), await bob.browser.request('/api/keys/devices')].map(r => r.body.items.map((d: { deviceKeyId: string }) => d.deviceKeyId));
  const a = await stack.connect(alice), b = await stack.connect(bob);
  const first = await stack.envelope(alice, cid, epoch, 'Alice before block\n🔒', 'before-a');
  const second = await stack.envelope(bob, cid, bobKey, 'Bob before block', 'before-b');
  assert.equal((await stack.send(a, first)).status, 'sent'); assert.equal((await stack.send(b, second)).status, 'sent');
  const before = (await stack.history(alice, cid)).items;
  const stored = () => stack.data.application.db.prepare('SELECT * FROM Messages WHERE conversation_id=? ORDER BY message_seq').all(cid);
  const originalRows = digest(stored());
  assert.equal((await blocker.browser.mutate('POST', '/api/blocks', { userId: blocked.id })).status, 204);
  for (const actor of [alice, bob]) assert.equal((await actor.browser.request(`/api/conversations/${cid}/messages`)).status, 404);
  assert.equal((await stack.send(a, await stack.envelope(alice, cid, epoch, 'blocked send', 'blocked'))).status, 'error');
  assert.equal(digest(stored()), originalRows);
  assert.equal((await blocker.browser.mutate('DELETE', `/api/blocks/${blocked.id}`)).status, 204);
  for (const actor of [alice, bob]) {
    assert.equal((await actor.browser.request(`/api/conversations/${cid}`)).body.conversation.interactionAllowed, false);
    assert.equal(digest((await stack.history(actor, cid)).items), digest(before));
    assert.equal((await actor.browser.request(`/api/conversations/${cid}/keys`)).status, 200);
    assert.equal((await actor.browser.request('/api/friends')).body.items.length, 0);
  }
  assert.equal(await TestDevice.decrypt(bobKey.key, before.find((m: { id: string }) => m.id === first.id)), 'Alice before block\n🔒');
  assert.equal((await stack.send(a, await stack.envelope(alice, cid, epoch, 'read-only send', 'readonly'))).status, 'error');
  assert.equal(digest(stored()), originalRows);
  await stack.befriend(alice, bob);
  for (const actor of [alice, bob]) assert.equal((await actor.browser.request(`/api/conversations/${cid}`)).body.conversation.interactionAllowed, true);
  // Fresh connections/directory verification use the same device records and existing epoch.
  a.socket.disconnect(); b.socket.disconnect();
  const reloadedA = await stack.connect(alice), reloadedB = await stack.connect(bob), recoveredKey = await stack.currentKey(bob, cid);
  assert.equal(recoveredKey.keyId, epoch.keyId);
  const mark = reloadedB.mark(), next = await stack.envelope(alice, cid, epoch, 'After unblock and friendship renewal', 'after-a');
  assert.equal((await stack.send(reloadedA, next)).status, 'sent');
  const received = await reloadedB.waitFor('message:new', m => m.id === next.id, { since: mark });
  assert.equal(await TestDevice.decrypt(recoveredKey.key, received as never), 'After unblock and friendship renewal');
  assert.equal((await stack.send(reloadedB, await stack.envelope(bob, cid, bobKey, 'Reply after unblock', 'after-b'))).status, 'sent');
  assert.equal((await stack.history(alice, cid)).items.length, 4);
  assert.equal(digest(stored().slice(0, 2)), originalRows);
  const finalDeviceIds = [await alice.browser.request('/api/keys/devices'), await bob.browser.request('/api/keys/devices')].map(r => r.body.items.map((d: { deviceKeyId: string }) => d.deviceKeyId));
  assert.deepEqual(finalDeviceIds, originalDeviceIds);
});
