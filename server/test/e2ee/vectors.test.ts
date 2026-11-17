/**
 * Fixed interoperability vector (`vectors/protocol-v1.json`, synthetic keys). The client must
 * reproduce every statement byte-for-byte, open the wraps and decrypt the message with the same
 * inputs; this file proves the server agrees with the recorded values.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { envelopeV2Fingerprint, messageAadV2, parseMessageEnvelopeV2 } from '../../src/e2ee/envelope.ts';
import { planEpochPublication } from '../../src/e2ee/epochs.ts';
import { evaluateRecipientKeys } from '../../src/e2ee/evaluation.ts';
import { deviceKeyIdFor } from '../../src/e2ee/keys.ts';
import { parseConversationKeyState, type StoredDeviceKey } from '../../src/e2ee/records.ts';
import { validateDeviceRegistration } from '../../src/e2ee/registration.ts';
import { verifyStatementSignature } from '../../src/e2ee/signatures.ts';
import { epochStatement, registrationStatement, wrapInfo } from '../../src/e2ee/statements.ts';
import { importEcdhPrivateKey, openBase } from './support/hpke.ts';

const vector = JSON.parse(readFileSync(new URL('./vectors/protocol-v1.json', import.meta.url), 'utf8'));
const devices = [vector.devices.alice, vector.devices.bob];
const stored = (device: typeof vector.devices.alice): StoredDeviceKey => ({ deviceKeyId: device.deviceKeyId, userId: device.userId, deviceId: device.deviceId,
  keyVersion: device.keyVersion, createdAt: device.createdAt, agreementPublicKey: device.agreementPublicKey, signingPublicKey: device.signingPublicKey,
  signature: device.signature, status: 'active' });
const epochRecord = { ...vector.epoch.body, conversationId: vector.conversationId, creatorUserId: vector.epoch.creatorUserId };

describe('protocol v1 interoperability vector', () => {
  test('device statements, key IDs, signatures and registration validation match', () => {
    for (const device of devices) {
      assert.equal(registrationStatement(device), device.registrationStatement);
      assert.equal(deviceKeyIdFor(device.agreementPublicKey, device.signingPublicKey), device.deviceKeyId);
      assert.equal(verifyStatementSignature(device.signingPublicKey, device.registrationStatement, device.signature), true);
    }
    for (const name of ['alice', 'bob'] as const) {
      const result = validateDeviceRegistration(vector.registrations[name], { userId: vector.devices[name].userId });
      assert.ok(result.ok && result.value.deviceKeyId === vector.devices[name].deviceKeyId, name);
    }
  });

  test('epoch statement, wrap info, signature and publication rules match', () => {
    assert.equal(epochStatement(epochRecord), vector.epoch.statement);
    for (const wrap of epochRecord.wraps) {
      assert.equal(wrapInfo({ ...epochRecord, recipientUserId: wrap.recipientUserId, recipientDeviceKeyId: wrap.recipientDeviceKeyId }),
        vector.epoch.wrapInfos[wrap.recipientDeviceKeyId]);
    }
    assert.equal(verifyStatementSignature(vector.devices.alice.signingPublicKey, vector.epoch.statement, epochRecord.signature), true);
    const plan = planEpochPublication(vector.epoch.body, { actorUserId: vector.epoch.creatorUserId, conversationId: vector.conversationId,
      participantIds: devices.map((device) => device.userId), activeDevices: devices.map(stored), currentEpoch: null, existingEpoch: null,
      nowMs: Date.parse(vector.epoch.body.createdAt) });
    assert.equal(plan.action, 'create');
  });

  test('each device opens its HPKE wrap to the same epoch key, which decrypts the v2 message', async () => {
    for (const device of devices) {
      const wrap = epochRecord.wraps.find((entry: { recipientDeviceKeyId: string }) => entry.recipientDeviceKeyId === device.deviceKeyId);
      const publicKey = new Uint8Array(Buffer.from(device.agreementPublicKey, 'base64url'));
      const privateKey = await importEcdhPrivateKey(new Uint8Array(Buffer.from(device.privateKeys.agreementD, 'base64url')), publicKey);
      const opened = await openBase({ enc: new Uint8Array(Buffer.from(wrap.enc, 'base64url')), recipientPrivateKey: privateKey, recipientPublicKey: publicKey,
        info: new TextEncoder().encode(vector.epoch.wrapInfos[device.deviceKeyId]), aad: new Uint8Array(0), ciphertext: new Uint8Array(Buffer.from(wrap.ciphertext, 'base64url')) });
      assert.equal(Buffer.from(opened).toString('hex'), vector.epoch.epochKeyHex);
    }
    const envelope = parseMessageEnvelopeV2(vector.message.envelope);
    assert.ok(envelope);
    assert.equal(messageAadV2({ ...envelope, keyId: envelope.encryption.keyId }), vector.message.aad);
    assert.equal(envelopeV2Fingerprint(envelope), vector.message.fingerprint);
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(vector.epoch.epochKeyHex, 'hex'), 'AES-GCM', false, ['decrypt']);
    const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.encryption.iv, 'base64'),
      additionalData: new TextEncoder().encode(vector.message.aad), tagLength: 128 }, key, Buffer.from(envelope.encryption.ciphertext, 'base64'));
    assert.equal(new TextDecoder().decode(plaintext), vector.message.plaintext);
  });

  test('the server verifies the vector message for the vector state', () => {
    const state = parseConversationKeyState({ conversationId: vector.conversationId, participantIds: devices.map((device) => device.userId),
      activeDevices: devices.map(stored), currentEpoch: { keyId: epochRecord.keyId, epoch: 1 }, epoch: epochRecord },
    { conversationId: vector.conversationId, keyId: epochRecord.keyId });
    assert.ok(state);
    const envelope = parseMessageEnvelopeV2(vector.message.envelope)!;
    assert.deepEqual(evaluateRecipientKeys(envelope, { actorUserId: vector.devices.alice.userId, conversationId: vector.conversationId,
      recipientIds: [vector.devices.bob.userId], fingerprint: vector.message.fingerprint }, state), { verified: true });
  });
});
