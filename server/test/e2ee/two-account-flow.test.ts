/**
 * Two independent accounts (Alice, Bob) with their own device keys exchange encrypted messages
 * through the protocol: registration, discovery, TOFU pinning, HPKE key delivery, envelope v2,
 * server verification and recipient decryption. A third account (Charlie) must fail everywhere.
 * Devices are simulated with real WebCrypto; the directory is the in-memory reference, so this is
 * a protocol test, not a browser or DATA end-to-end test.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { createRecipientKeyVerifier } from '../../src/e2ee/verifier.ts';
import { CapturingLogger } from '../support/fixtures.ts';
import { MemoryKeyDirectory } from './support/memoryKeyDirectory.ts';
import { ALICE, BOB, CHARLIE, publicRecord, Scenario } from './support/scenario.ts';
import { TestDevice, TrustStore, verifyDeviceRecord } from './support/deviceClient.ts';

const actor = (userId: string) => Object.freeze({ userId, sessionId: `session-${userId}`, displayName: 'Name' });

describe('two-account encrypted direct messaging', () => {
  test('Alice and Bob exchange messages that only their devices can decrypt; Charlie cannot', async () => {
    const scenario = new Scenario();
    const logger = new CapturingLogger();
    const verifier = createRecipientKeyVerifier({ directory: scenario.directory, logger });
    const a1 = await scenario.addDevice('a1', ALICE);
    const b1 = await scenario.addDevice('b1', BOB);
    const c1 = await TestDevice.create(CHARLIE);
    assert.deepEqual(scenario.directory.registerDevice(CHARLIE, await c1.registration()), { status: 'created' });

    // Discovery and TOFU: Alice verifies and pins Bob's device keys before wrapping anything.
    const aliceTrust = new TrustStore();
    const devices = scenario.activeDevices();
    for (const device of devices) assert.equal(await verifyDeviceRecord(device), true);
    const bobKeys = devices.filter((device) => device.userId === BOB).map((device) => device.deviceKeyId);
    assert.equal(aliceTrust.observe(BOB, bobKeys).status, 'first_use');
    assert.ok(!devices.some((device) => device.userId === CHARLIE), 'only participants appear in the conversation key state');

    let raw: Uint8Array = new Uint8Array(0);
    const current = scenario.directory.currentEpoch(scenario.conversationId);
    assert.equal(current, null);
    const created = await a1.createEpoch({ conversationId: scenario.conversationId, epoch: 1, previousKeyId: null, devices, revealRawKey: (copy) => { raw = copy; } });
    assert.deepEqual(scenario.directory.publishEpoch(ALICE, scenario.conversationId, created.body), { status: 'created' });
    const keyId = created.body.keyId;

    const hello = await scenario.message('a1', created.key, keyId, 'Hello Bob, this is end-to-end encrypted.', 'Alice');
    assert.deepEqual(await verifier.verifyEnvelope(actor(ALICE), hello, { conversationId: scenario.conversationId, recipientIds: [BOB] }), { verified: true });

    const bobKey = await scenario.open('b1', keyId);
    assert.equal(await TestDevice.decrypt(bobKey, hello), 'Hello Bob, this is end-to-end encrypted.');
    const reply = await b1.encrypt(bobKey, keyId, { conversationId: scenario.conversationId, id: 'reply-1', senderName: 'Bob' }, 'Hi Alice!');
    assert.deepEqual(await verifier.verifyEnvelope(actor(BOB), reply, { conversationId: scenario.conversationId, recipientIds: [ALICE] }), { verified: true });
    assert.equal(await TestDevice.decrypt(await scenario.open('a1', keyId), reply), 'Hi Alice!');

    // Charlie: no wrap, cannot open someone else's wrap, cannot decrypt, cannot publish, cannot impersonate.
    const epoch = scenario.epoch(keyId);
    assert.ok(!epoch.wraps.some((wrap) => wrap.recipientUserId === CHARLIE));
    await assert.rejects(c1.openEpoch(epoch, scenario.directory.devices()), /No wrap for this device/);
    const bobWrap = epoch.wraps.find((wrap) => wrap.recipientUserId === BOB)!;
    await assert.rejects(c1.openWrapOf(epoch, bobWrap, publicRecord(scenario.directory.devices(BOB)[0]!)));
    const guess = await webcryptoKey();
    await assert.rejects(TestDevice.decrypt(guess, hello));
    const charlieEpoch = await c1.createEpoch({ conversationId: scenario.conversationId, epoch: 2, previousKeyId: keyId, devices });
    assert.deepEqual(scenario.directory.publishEpoch(CHARLIE, scenario.conversationId, charlieEpoch.body), { status: 'refused', reason: 'not_participant' });
    assert.deepEqual(scenario.directory.registerDevice(CHARLIE, await a1.signRegistrationAs(CHARLIE)), { status: 'refused', reason: 'key_in_use' });

    // Tampering with authenticated metadata breaks decryption.
    await assert.rejects(TestDevice.decrypt(bobKey, { ...hello, senderName: 'Mallory' }));
    await assert.rejects(TestDevice.decrypt(bobKey, { ...hello, encryption: { ...hello.encryption, keyId: randomBytes(16).toString('base64url') } }));

    // The backend holds no plaintext, private key or raw epoch key, in storage or logs.
    const stored = scenario.directory.export();
    const forbidden = ['Hello Bob', 'Hi Alice', Buffer.from(raw).toString('base64'), Buffer.from(raw).toString('base64url'), Buffer.from(raw).toString('hex'),
      '"d":', 'privateKey', 'PRIVATE KEY'];
    for (const value of forbidden) {
      assert.ok(!stored.includes(value), `stored ${value.slice(0, 16)}`);
      assert.ok(!logger.text().includes(value), `logged ${value.slice(0, 16)}`);
    }
    assert.equal(raw.length, 32);
  });

  test('multiple browsers, rotation on device changes, revocation and restart', async () => {
    const scenario = new Scenario();
    const verifier = () => createRecipientKeyVerifier({ directory: scenario.directory });
    await scenario.addDevice('a1', ALICE);
    await scenario.addDevice('b1', BOB);
    const first = await scenario.rotate('a1', ALICE);

    // Bob signs in on a second browser. Alice's client sees a changed key set and must not send on the old epoch.
    const aliceTrust = new TrustStore();
    aliceTrust.observe(BOB, scenario.activeDevices().filter((device) => device.userId === BOB).map((device) => device.deviceKeyId));
    await scenario.addDevice('b2', BOB);
    const changed = aliceTrust.observe(BOB, scenario.activeDevices().filter((device) => device.userId === BOB).map((device) => device.deviceKeyId));
    assert.equal(changed.status, 'changed');
    assert.deepEqual(changed.added, [scenario.device('b2').deviceKeyId]);
    const stale = await scenario.message('a1', first.key, first.keyId, 'stale epoch');
    assert.deepEqual(await verifier().verifyEnvelope(actor(ALICE), stale), { verified: false });

    // Bob's new browser publishes epoch 2; every active device of both accounts can read it.
    const second = await scenario.rotate('b2', BOB);
    const toBob = await scenario.message('a1', await scenario.open('a1', second.keyId), second.keyId, 'to both of Bob\'s browsers');
    assert.deepEqual(await verifier().verifyEnvelope(actor(ALICE), toBob), { verified: true });
    for (const name of ['b1', 'b2']) assert.equal(await TestDevice.decrypt(await scenario.open(name, second.keyId), toBob), 'to both of Bob\'s browsers');
    // A reload re-derives the same key from the directory records alone.
    assert.equal(await TestDevice.decrypt(await scenario.open('b1', second.keyId), toBob), 'to both of Bob\'s browsers');

    // Bob revokes the second browser: sends stay blocked until a new epoch excludes it.
    assert.deepEqual(scenario.directory.revokeDevice(BOB, scenario.device('b2').deviceId), { status: 'revoked' });
    assert.deepEqual(await verifier().verifyEnvelope(actor(ALICE), toBob), { verified: false });
    const third = await scenario.rotate('a1', ALICE);
    const afterRevocation = await scenario.message('a1', third.key, third.keyId, 'b2 must not read this');
    assert.deepEqual(await verifier().verifyEnvelope(actor(ALICE), afterRevocation), { verified: true });
    assert.equal(await TestDevice.decrypt(await scenario.open('b1', third.keyId), afterRevocation), 'b2 must not read this');
    await assert.rejects(scenario.open('b2', third.keyId), /No wrap for this device/);
    // Documented limitation: a revoked device keeps what it already received.
    assert.equal(await TestDevice.decrypt(await scenario.open('b2', second.keyId), toBob), 'to both of Bob\'s browsers');

    // Restart: the persisted records alone are enough to verify and decrypt.
    const restarted = MemoryKeyDirectory.restore(scenario.directory.export());
    assert.deepEqual(await createRecipientKeyVerifier({ directory: restarted }).verifyEnvelope(actor(ALICE), afterRevocation), { verified: true });
    const fromRestart = restarted.epochRecord(scenario.conversationId, third.keyId)!;
    assert.equal(await TestDevice.decrypt(await scenario.device('b1').openEpoch(fromRestart, restarted.devices()), afterRevocation), 'b2 must not read this');
  });

  test('server trust: a substituted device key passes server verification; only client TOFU warnings reveal it', async () => {
    const scenario = new Scenario();
    await scenario.addDevice('a1', ALICE);
    await scenario.addDevice('b1', BOB);
    const aliceTrust = new TrustStore();
    aliceTrust.observe(BOB, [scenario.device('b1').deviceKeyId]);

    // A malicious operator registers its own key under Bob's account. The server cannot tell.
    const rogue = await TestDevice.create(BOB);
    assert.deepEqual(scenario.directory.registerDevice(BOB, await rogue.registration()), { status: 'created' });
    const warning = aliceTrust.observe(BOB, scenario.activeDevices().filter((device) => device.userId === BOB).map((device) => device.deviceKeyId));
    assert.equal(warning.status, 'changed', 'the client must surface this change to Alice');
    assert.deepEqual(warning.added, [rogue.deviceKeyId]);

    // If Alice's client ignores the warning, the rogue device reads her messages and the server verifies them.
    const epoch = await scenario.rotate('a1', ALICE);
    const message = await scenario.message('a1', epoch.key, epoch.keyId, 'visible to a substituted key');
    assert.deepEqual(await createRecipientKeyVerifier({ directory: scenario.directory }).verifyEnvelope(actor(ALICE), message), { verified: true });
    assert.equal(await TestDevice.decrypt(await rogue.openEpoch(scenario.epoch(epoch.keyId), scenario.directory.devices()), message), 'visible to a substituted key');
  });
});

async function webcryptoKey() {
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
