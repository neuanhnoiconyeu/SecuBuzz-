import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { envelopeV2Fingerprint, messageAadV2, parseMessageEnvelopeV2 } from '../../src/e2ee/envelope.ts';
import { envelopeFingerprint, parseMessageEnvelope } from '../../src/realtime/validation.ts';

const keyId = randomBytes(16).toString('base64url');
const v2 = () => ({
  id: 'client-message-1', conversationId: 'conversation-1', senderId: 'user-a', senderName: 'Alice', timestamp: '2026-11-14T12:00:00.000Z', type: 'text',
  encryption: { version: 2, algorithm: 'AES-256-GCM', encoding: 'base64', keyId, iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(40, 2).toString('base64') },
});

describe('envelope v2', () => {
  test('parses the exact v2 shape into a frozen copy', () => {
    const parsed = parseMessageEnvelopeV2(v2());
    assert.deepEqual(parsed, v2());
    assert.ok(parsed && Object.isFrozen(parsed) && Object.isFrozen(parsed.encryption));
  });

  test('rejects v1, unknown fields, plaintext, demo markers and bad encodings', () => {
    const bad: Array<(value: any) => void> = [
      (value) => { value.encryption.version = 1; },
      (value) => { delete value.encryption.keyId; },
      (value) => { value.encryption.keyId = `${keyId}=`; },
      (value) => { value.encryption.keyId = randomBytes(32).toString('base64url'); },
      (value) => { value.encryption.scope = 'browser-demo'; },
      (value) => { value.content = 'plaintext'; },
      (value) => { value.encryption.iv = Buffer.alloc(16).toString('base64'); },
      (value) => { value.encryption.iv = Buffer.alloc(12, 0xfb).toString('base64url'); },
      (value) => { value.encryption.ciphertext = Buffer.alloc(16).toString('base64'); },
      (value) => { value.encryption.ciphertext = 'not base64!'; },
      (value) => { value.encryption.algorithm = 'AES-128-GCM'; },
      (value) => { value.type = 'image'; },
      (value) => { value.senderId = 'has space'; },
      (value) => { value.timestamp = '2026-13-01T00:00:00.000Z'; },
    ];
    for (const [index, mutate] of bad.entries()) {
      const value = v2();
      mutate(value);
      assert.equal(parseMessageEnvelopeV2(value), null, `case ${index}`);
    }
    assert.equal(parseMessageEnvelopeV2({ ...v2(), encryption: { ...v2().encryption, ciphertext: Buffer.alloc(70_000).toString('base64') } }), null);
  });

  test('fingerprint and AAD bind keyId in fixed order', () => {
    const envelope = parseMessageEnvelopeV2(v2())!;
    const expected = createHash('sha256').update(JSON.stringify(['client-message-1', 'conversation-1', 'user-a', 'Alice', '2026-11-14T12:00:00.000Z', 'text',
      2, 'AES-256-GCM', 'base64', keyId, envelope.encryption.iv, envelope.encryption.ciphertext])).digest('hex');
    assert.equal(envelopeV2Fingerprint(envelope), expected);
    const otherKey = parseMessageEnvelopeV2({ ...v2(), encryption: { ...v2().encryption, keyId: randomBytes(16).toString('base64url') } })!;
    assert.notEqual(envelopeV2Fingerprint(otherKey), expected);
    assert.equal(messageAadV2({ ...envelope, keyId }),
      JSON.stringify(['yahoo-security-messenger', 2, 'conversation-1', 'client-message-1', 'user-a', 'Alice', '2026-11-14T12:00:00.000Z', 'text', keyId]));
  });

  test('version-1 parsing and fingerprint are unchanged and still refuse v2', () => {
    const v1 = { ...v2(), encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: v2().encryption.iv, ciphertext: v2().encryption.ciphertext } };
    const parsed = parseMessageEnvelope(v1, { maxCiphertextLength: 65_536 });
    assert.deepEqual(parsed, v1);
    assert.equal(envelopeFingerprint(parsed!), createHash('sha256').update(JSON.stringify(['client-message-1', 'conversation-1', 'user-a', 'Alice',
      '2026-11-14T12:00:00.000Z', 'text', 1, 'AES-256-GCM', 'base64', v1.encryption.iv, v1.encryption.ciphertext])).digest('hex'));
    assert.equal(parseMessageEnvelope(v2(), { maxCiphertextLength: 65_536 }), null);
    assert.equal(parseMessageEnvelopeV2(v1), null);
  });
});
