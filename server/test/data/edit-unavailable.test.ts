import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Browser } from '../e2ee/support/dataApp.ts';
import { TestDevice } from '../e2ee/support/deviceClient.ts';
import { DataStack, delay } from './support/stack.ts';

describe('legacy ciphertext-overwrite attempts remain refused by the signed revision contract', () => {
  let stack: DataStack;
  before(async () => { stack = await DataStack.start(); });
  after(async () => { await stack?.close(); });

  test('valid V2 replacement and concurrent PATCH attempts preserve original multiline Unicode content for both accounts', async () => {
    const { alice, bob, conversationId, epoch, bobKey } = await stack.pair();
    const originalText = 'Original first line 👩🏽‍💻\nTiếng Việt 🇻🇳\nLast line';
    const envelope = await stack.envelope(alice, conversationId, epoch, originalText);
    const stored = await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope);
    assert.equal(stored.status, 201); const original = stored.body.message;
    const replacement = await alice.device.encrypt(epoch.key, epoch.keyId, envelope, 'Updated first line 🍕\nUpdated second line');
    assert.notEqual(replacement.encryption.iv, envelope.encryption.iv);
    const aliceSocket = await stack.connect(alice), bobSocket = await stack.connect(bob);
    const aMark = aliceSocket.mark(), bMark = bobSocket.mark();
    const route = `/api/messages/${original.storageId}`;
    // A proposed edit request is deliberately not treated as a supported contract.
    const candidate = { expectedRevision: original.revision, envelope: replacement };
    const attempts = await Promise.all([alice.browser.mutate('PATCH', route, candidate), alice.browser.mutate('PATCH', route, candidate)]);
    for (const result of attempts) { assert.equal(result.status, 400); assert.equal(result.body.code, 'VALIDATION_ERROR'); }
    // Reposting changed encrypted bytes under the same wire ID cannot bypass PATCH.
    const resubmitted = await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, replacement);
    assert.equal(resubmitted.status, 409); assert.equal(resubmitted.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual((await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope)).body.message, original);
    await delay(100);
    for (const [socket, mark] of [[aliceSocket, aMark], [bobSocket, bMark]] as const) {
      for (const event of ['message:new', 'message:updated', 'message:deleted']) assert.equal(socket.events(event, mark).length, 0);
    }
    bobSocket.close();
    assert.equal((await alice.browser.mutate('PATCH', route, candidate)).status, 400);
    await stack.connect(bob);
    for (const person of [alice, bob]) {
      const history = await stack.history(person, conversationId);
      assert.deepEqual(history.items, [original]);
      assert.equal(await TestDevice.decrypt(person === alice ? epoch.key : bobKey.key, history.items[0]), originalText);
    }
  });

  test('PATCH retains session, CSRF, sender and membership checks and cannot revive an unsent message', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair('owner', 'recipient');
    const stranger = await stack.person('outsider'), anonymous = new Browser(stack.url);
    const envelope = await stack.envelope(alice, conversationId, epoch, 'Sender-owned encrypted text');
    const original = (await alice.browser.mutate('POST', `/api/conversations/${conversationId}/messages`, envelope)).body.message;
    const route = `/api/messages/${original.storageId}`;
    assert.equal((await bob.browser.mutate('PATCH', route, {})).status, 403);
    assert.equal((await stranger.browser.mutate('PATCH', route, {})).status, 404);
    assert.equal((await anonymous.request(route, { method: 'PATCH', body: {} })).status, 401);
    assert.equal((await alice.browser.request(route, { method: 'PATCH', body: {} })).status, 403);
    assert.equal((await alice.browser.mutate('PATCH', `/api/messages/${original.id}`, {})).status, 404);
    assert.deepEqual((await stack.history(bob, conversationId)).items, [original]);
    const removed = await alice.browser.mutate('DELETE', route);
    assert.equal(removed.status, 200);
    const refused = await alice.browser.mutate('PATCH', route, { envelope });
    assert.equal(refused.status, 404); assert.equal(refused.body.code, 'NOT_FOUND');
    for (const person of [alice, bob]) assert.deepEqual((await stack.history(person, conversationId)).items, [removed.body.message]);
  });
});
