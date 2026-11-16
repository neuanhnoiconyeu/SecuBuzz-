/**
 * Key-change handling against the real DATA key directory. `conversation:keys-changed` is a
 * process-local HINT derived from committed DATA mutations; the safety property is that DATA refuses
 * any send encrypted for a stale device set or epoch, whether or not the hint reached the client.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TestDevice } from '../e2ee/support/deviceClient.ts';
import { DataStack, until, type TestClient } from './support/stack.ts';

let stack: DataStack;

const changes = (client: TestClient, since = 0) => client.events('conversation:keys-changed', since) as Array<{ conversationId: string; currentEpoch: { keyId: string; epoch: number } | null }>;

async function nextChange(client: TestClient, since: number, predicate: (event: { currentEpoch: { keyId: string; epoch: number } | null }) => boolean = () => true) {
  return client.waitFor('conversation:keys-changed', predicate, { since, timeoutMs: 3_000 });
}

describe('conversation:keys-changed from real DATA key mutations', () => {
  before(async () => {
    stack = await DataStack.start();
  });
  after(async () => {
    await stack?.close();
  });

  test('registering a device notifies both participants with exactly {conversationId, currentEpoch}; no keys, wraps or signatures', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const bobSocket = await stack.connect(bob);
    const aliceMark = aliceSocket.mark();
    const bobMark = bobSocket.mark();
    const second = await TestDevice.create(bob.id);
    await stack.registerDevice(bob, second);
    const seen = await nextChange(aliceSocket, aliceMark);
    assert.deepEqual(seen, { conversationId, currentEpoch: { keyId: epoch.keyId, epoch: 1 } });
    assert.deepEqual(await nextChange(bobSocket, bobMark), seen);
    const wire = JSON.stringify(seen);
    assert.doesNotMatch(wire, /wrap|signature|PublicKey|enc|ciphertext/i);
  });

  test('a conversation that has no epoch yet reports currentEpoch: null', async () => {
    const alice = await stack.person('alice', 'Alice');
    const bob = await stack.person('bob', 'Bob');
    await stack.befriend(alice, bob);
    const conversationId = await stack.openDm(alice, bob);
    const aliceSocket = await stack.connect(alice);
    const mark = aliceSocket.mark();
    await stack.registerDevice(alice);
    assert.deepEqual(await nextChange(aliceSocket, mark), { conversationId, currentEpoch: null });
  });

  test('publishing an epoch notifies both participants with the new keyId and epoch number', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const bobSocket = await stack.connect(bob);
    const mark = bobSocket.mark();
    const next = await stack.publishEpoch(alice, conversationId, epoch);
    assert.deepEqual(await nextChange(bobSocket, mark), { conversationId, currentEpoch: { keyId: next.keyId, epoch: 2 } });
    assert.equal((await nextChange(aliceSocket, 0, (event) => event.currentEpoch?.epoch === 2)).currentEpoch.keyId, next.keyId);
  });

  test('revoking a device notifies the conversation; DATA then refuses sends for the old device set until a new epoch exists', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const bobSecond = await TestDevice.create(bob.id);
    await stack.registerDevice(bob, bobSecond);
    // Epoch 2 covers both of Bob's devices.
    const covering = await stack.publishEpoch(alice, conversationId, epoch);
    const aliceSocket = await stack.connect(alice);
    const bobSocket = await stack.connect(bob);
    assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, covering, 'both devices', 'rot-1'))).status, 'sent');
    await bobSocket.waitFor('message:new', (event) => event.id === 'rot-1');

    const mark = aliceSocket.mark();
    await stack.revokeDevice(bob, bobSecond);
    assert.deepEqual(await nextChange(aliceSocket, mark), { conversationId, currentEpoch: { keyId: covering.keyId, epoch: 2 } });
    // The old epoch still wraps the revoked device, so DATA refuses to let anyone keep encrypting to it.
    const refused = await stack.send(aliceSocket, await stack.envelope(alice, conversationId, covering, 'to a revoked device', 'rot-2'));
    assert.deepEqual(refused, { status: 'error', code: 'recipient_keys_unavailable' });
    const rotated = await stack.publishEpoch(alice, conversationId, covering);
    assert.equal((await nextChange(bobSocket, 0, (event) => event.currentEpoch?.epoch === 3)).currentEpoch.keyId, rotated.keyId);
    assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, rotated, 'rotated', 'rot-2'))).status, 'sent');
    assert.equal((await bobSocket.waitFor('message:new', (event) => event.id === 'rot-2')).encryption.keyId, rotated.keyId);
  });

  test('a new device on either side makes the current epoch insufficient: DATA refuses until the epoch covers it', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const bobSocket = await stack.connect(bob);
    const mark = aliceSocket.mark();
    const bobPhone = await TestDevice.create(bob.id);
    await stack.registerDevice(bob, bobPhone);
    await nextChange(aliceSocket, mark);
    assert.deepEqual(await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'phone cannot read this', 'dev-1')),
      { status: 'error', code: 'recipient_keys_unavailable' });
    await bobSocket.expectNone('message:new');
    const next = await stack.publishEpoch(alice, conversationId, epoch);
    assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, next, 'now it can', 'dev-1'))).status, 'sent');
    const delivered = await bobSocket.waitFor('message:new', (event) => event.id === 'dev-1');
    // Both of Bob's devices can open the new epoch and read the message.
    for (const device of [bob.device, bobPhone]) {
      const key = await stack.currentKey(bob, conversationId, device);
      assert.equal(await TestDevice.decrypt(key.key, delivered), 'now it can');
    }
  });

  test('accounts DATA refuses never receive the event: strangers, and a pair that has been unfriended', async () => {
    const { alice, bob, conversationId } = await stack.pair();
    const eve = await stack.person('eve', 'Eve');
    const eveSocket = await stack.connect(eve);
    const bobSocket = await stack.connect(bob);
    const mark = bobSocket.mark();
    await stack.registerDevice(alice, await TestDevice.create(alice.id));
    await nextChange(bobSocket, mark);
    await eveSocket.expectNone('conversation:keys-changed');
    // After unfriending DATA no longer grants Bob the conversation, so he is not told about it.
    const before = stack.bridge.realtime.getStats().conversationRooms;
    assert.equal((await alice.browser.mutate('DELETE', `/api/friends/${bob.id}`)).status, 204);
    await until(() => stack.bridge.realtime.getStats().conversationRooms < before, 3_000, 'grant removal');
    const after = bobSocket.mark();
    await stack.registerDevice(alice, await TestDevice.create(alice.id));
    await bobSocket.expectNone('conversation:keys-changed', (event) => event.conversationId === conversationId, { since: after, ms: 400 });
  });

  test('a repeated registration (200) or a refused registration emits nothing', async () => {
    const { alice, bob } = await stack.pair();
    const bobSocket = await stack.connect(bob);
    const mark = bobSocket.mark();
    const repeat = await alice.browser.mutate('POST', '/api/keys/devices', await alice.device.registration());
    assert.equal(repeat.status, 200, 'the same signed record again is idempotent');
    const forged = await (await TestDevice.create(alice.id)).signRegistrationAs(bob.id);
    assert.ok([400, 403, 409, 422].includes((await alice.browser.mutate('POST', '/api/keys/devices', forged)).status));
    await bobSocket.expectNone('conversation:keys-changed', () => true, { since: mark, ms: 400 });
  });

  test('the hint is not durable: a client that was offline gets no replay, and DATA still fails closed on its stale view', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const bobSocket = await stack.connect(bob);
    const connected = stack.bridge.realtime.getStats().connections;
    bobSocket.close();
    await until(() => stack.bridge.realtime.getStats().connections === connected - 1, 2_000, 'Bob to leave');
    await stack.registerDevice(bob, await TestDevice.create(bob.id));
    const returning = await stack.connect(bob);
    await returning.expectNone('conversation:keys-changed', () => true, { ms: 300 });
    assert.equal(changes(returning).length, 0);
    // Alice never learned either, but her stale epoch cannot be used.
    assert.deepEqual(await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'stale view', 'off-1')), { status: 'error', code: 'recipient_keys_unavailable' });
    // The directory is the source of truth: fetching it shows the new device.
    const state = await alice.browser.request(`/api/conversations/${conversationId}/keys`);
    assert.equal(state.body.devices.filter((device: { userId: string }) => device.userId === bob.id).length, 2);
  });

  test('a failure to read DATA key state is dropped, never forwarded: malformed or failing authorizer results produce no event', async () => {
    const { alice, bob } = await stack.pair();
    const bobSocket = await stack.connect(bob);
    const app = stack.data.application;
    const original = app.keys.state;
    app.keys.state = () => { throw new Error('directory unavailable'); };
    try {
      const mark = bobSocket.mark();
      await stack.registerDevice(alice, await TestDevice.create(alice.id));
      await bobSocket.expectNone('conversation:keys-changed', () => true, { since: mark, ms: 400 });
      await until(() => stack.logger.has('realtime.keys_changed.unavailable'), 2_000, 'a logged failure');
    } finally {
      app.keys.state = original;
    }
  });
});
