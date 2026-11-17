/**
 * The real Socket.IO server with the genuine verifier and a store configured still refuses every
 * send today: version 1 cannot be verified, and the realtime parser does not accept version 2 until
 * the Socket.IO integration step (per-actor DATA store, envelope v2, key-change events).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createRecipientKeyVerifier } from '../../src/e2ee/verifier.ts';
import { startTestServer, testEnvelope, type TestServer } from '../support/harness.ts';
import { TestDevice } from './support/deviceClient.ts';
import { MemoryKeyDirectory } from './support/memoryKeyDirectory.ts';
import { publicRecord } from './support/scenario.ts';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('realtime message:send with the genuine verifier', () => {
  test('stays fail-closed: v1 is unverifiable and v2 is not yet accepted on the socket', async () => {
    const directory = new MemoryKeyDirectory();
    server = await startTestServer({ withStore: true, recipientKeyVerifier: createRecipientKeyVerifier({ directory }) });
    const alice = server.addUser('alice-user', { displayName: 'Alice' });
    const bob = server.addUser('bob-user', { displayName: 'Bob' });
    server.authorizer.grant(alice.userId, 'dm-1');
    server.authorizer.grant(bob.userId, 'dm-1');
    directory.addConversation('dm-1', [alice.userId, bob.userId]);
    const aliceDevice = await TestDevice.create(alice.userId);
    assert.deepEqual(directory.registerDevice(alice.userId, await aliceDevice.registration()), { status: 'created' });
    assert.deepEqual(directory.registerDevice(bob.userId, await (await TestDevice.create(bob.userId)).registration()), { status: 'created' });
    const { body, key } = await aliceDevice.createEpoch({ conversationId: 'dm-1', epoch: 1, previousKeyId: null, devices: directory.activeDevicesOf('dm-1').map(publicRecord) });
    assert.deepEqual(directory.publishEpoch(alice.userId, 'dm-1', body), { status: 'created' });

    const sender = await server.connect(alice);
    const receiver = await server.connect(bob);
    const mark = receiver.mark();
    assert.deepEqual(await sender.emitAck('message:send', testEnvelope(alice, 'dm-1', 'v1-message')), { status: 'error', code: 'recipient_keys_unavailable' });
    const v2 = await aliceDevice.encrypt(key, body.keyId, { conversationId: 'dm-1', id: 'v2-message', senderName: 'Alice' }, 'not yet on sockets');
    assert.deepEqual(await sender.emitAck('message:send', v2), { status: 'error', code: 'invalid_payload' });
    await receiver.expectNone('message:new', () => true, { since: mark });
    assert.equal(server.store.storeCalls, 0, 'nothing reaches the message store');
    assert.equal(directory.loadCalls, 0, 'v1 is refused without a directory read');
  });
});
