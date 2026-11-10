import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canonicalBase64Length,
  envelopeFingerprint,
  isDeliveryAck,
  isDemoIdentity,
  isDisplayName,
  isIdentifier,
  isIsoTimestamp,
  parseIdentifierList,
  parseKeyVerification,
  parseMessageEnvelope,
  parsePresenceBody,
  parseReadBody,
  parseReceiptOutcome,
  parseSecurityDecision,
  parseSessionCheck,
  parseSessionResolution,
  parseStoreOutcome,
  parseStoredMessageRef,
  parseTypingBody,
} from '../../src/realtime/validation.ts';

const iv = Buffer.alloc(12, 7).toString('base64');
const ciphertext = Buffer.alloc(40, 9).toString('base64');
const limits = { maxCiphertextLength: 65_536 };

function envelope(overrides: Record<string, unknown> = {}, encryption: Record<string, unknown> = {}) {
  return {
    id: 'message-1', conversationId: 'conversation-1', senderId: 'user-a', senderName: 'Ava',
    timestamp: new Date().toISOString(), type: 'text',
    encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv, ciphertext, ...encryption },
    ...overrides,
  };
}

describe('primitive validators', () => {
  test('identifiers are bounded, non-empty and free of whitespace, control characters and lone surrogates', () => {
    assert.equal(isIdentifier('conversation-1'), true);
    assert.equal(isIdentifier('x'.repeat(256)), true);
    for (const value of ['', ' ', 'x'.repeat(257), 'has space', 'tab\t', 'nul\u0000', 'c1\u0085', '\ud800', 42, null, undefined, {}]) {
      assert.equal(isIdentifier(value), false, JSON.stringify(value));
    }
  });

  test('display names allow spaces but not control characters or more than 160 characters', () => {
    assert.equal(isDisplayName('Ava Morgan'), true);
    assert.equal(isDisplayName('x'.repeat(160)), true);
    assert.equal(isDisplayName('x'.repeat(161)), false);
    assert.equal(isDisplayName('   '), false);
    assert.equal(isDisplayName('line\nbreak'), false);
  });

  test('timestamps require ISO-8601 with an explicit timezone and a real calendar date', () => {
    assert.equal(isIsoTimestamp('2026-11-09T10:11:12.345Z'), true);
    assert.equal(isIsoTimestamp('2026-11-09T10:11:12+07:00'), true);
    assert.equal(isIsoTimestamp('2028-02-29T00:00:00Z'), true);
    for (const value of ['2026-11-09 10:11:12', '2026-11-09T10:11:12', '2026-02-30T00:00:00Z', '2027-02-29T00:00:00Z',
      '2026-13-01T00:00:00Z', '2026-11-09T24:00:00Z', 1_700_000_000_000, '']) {
      assert.equal(isIsoTimestamp(value), false, String(value));
    }
  });

  test('reserved demo identities are recognized case-insensitively', () => {
    for (const id of ['local-user', 'LOCAL-USER', 'demo-session-nova', 'demo_user', 'Demo:abc']) assert.equal(isDemoIdentity(id), true, id);
    for (const id of ['user-1', 'demonstration', 'ademo-1']) assert.equal(isDemoIdentity(id), false, id);
  });

  test('canonical base64 rejects padding errors, non-zero pad bits, whitespace and oversize input', () => {
    assert.equal(canonicalBase64Length(iv, 16), 12);
    assert.equal(canonicalBase64Length('QUJD', 16), 3);
    assert.equal(canonicalBase64Length('QUI=', 16), 2);
    for (const value of ['QUJ', 'QUJD====', 'QUJ\nD', 'QU JD', '', '****']) assert.equal(canonicalBase64Length(value, 64), null, value);
    assert.equal(canonicalBase64Length('QUJD', 3), null);
    assert.equal(canonicalBase64Length('QUJ=', 64), null, 'non-zero padding bits are not canonical');
  });
});

describe('client event bodies', () => {
  test('typing accepts exactly a conversation ID and rejects identity fields', () => {
    assert.deepEqual(parseTypingBody({ conversationId: 'c1' }), { conversationId: 'c1' });
    assert.equal(parseTypingBody({ conversationId: 'c1', userId: 'victim' }), null);
    assert.equal(parseTypingBody({ conversationId: 'c1', displayName: 'Admin' }), null);
    assert.equal(parseTypingBody({ conversationId: 'c1', type: 'typing' }), null);
    assert.equal(parseTypingBody({}), null);
    assert.equal(parseTypingBody(['c1']), null);
    assert.equal(parseTypingBody(Object.assign(Object.create({ inherited: true }), { conversationId: 'c1' })), null);
    assert.equal(parseTypingBody({ conversationId: 'c1', [Symbol('hidden')]: 1 }), null);
  });

  test('read requests require exactly conversation and message IDs', () => {
    assert.deepEqual(parseReadBody({ conversationId: 'c1', messageId: 'm1' }), { conversationId: 'c1', messageId: 'm1' });
    assert.equal(parseReadBody({ conversationId: 'c1', messageId: 'm1', userId: 'forged-reader' }), null);
    assert.equal(parseReadBody({ conversationId: 'c1' }), null);
    assert.equal(parseReadBody({ conversationId: 'c1', messageId: 'bad id' }), null);
  });

  test('presence subscriptions are bounded, validated and de-duplicated in order', () => {
    assert.deepEqual(parsePresenceBody({ userIds: ['b', 'a', 'b'] }, 10), { userIds: ['b', 'a'] });
    assert.deepEqual(parsePresenceBody({ userIds: [] }, 10), { userIds: [] });
    assert.equal(parsePresenceBody({ userIds: ['a', 'b', 'c'] }, 2), null);
    assert.equal(parsePresenceBody({ userIds: ['a', ''] }, 10), null);
    assert.equal(parsePresenceBody({ userIds: 'a' }, 10), null);
    assert.equal(parsePresenceBody({ userIds: ['a'], all: true }, 10), null);
  });

  test('identifier lists from adapters fail closed on any invalid entry', () => {
    assert.deepEqual(parseIdentifierList(['c1', 'c2', 'c1'], 5), ['c1', 'c2']);
    assert.equal(parseIdentifierList(['c1', 7], 5), null);
    assert.equal(parseIdentifierList(new Array(6).fill('c'), 5), null, 'length is checked before de-duplication');
    assert.equal(parseIdentifierList(undefined, 5), null);
  });
});

describe('message envelopes', () => {
  test('accepts the contract envelope and returns a detached copy', () => {
    const input = envelope();
    const parsed = parseMessageEnvelope(input, limits);
    assert.ok(parsed);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed.encryption, input.encryption);
  });

  test('rejects plaintext, demo markers and unknown fields', () => {
    assert.equal(parseMessageEnvelope(envelope({ content: 'hello' }), limits), null);
    assert.equal(parseMessageEnvelope(envelope({ demoOnly: true }), limits), null);
    assert.equal(parseMessageEnvelope(envelope({}, { scope: 'browser-demo' }), limits), null);
    assert.equal(parseMessageEnvelope(envelope({ deliveryStatus: 'sent' }), limits), null);
    assert.equal(parseMessageEnvelope(envelope({}, { keyId: 'k1' }), limits), null);
    const withoutEncryption: Record<string, unknown> = envelope();
    delete withoutEncryption.encryption;
    assert.equal(parseMessageEnvelope({ ...withoutEncryption, content: 'plaintext' }, limits), null);
  });

  test('rejects malformed encryption metadata', () => {
    const cases: Array<Record<string, unknown>> = [
      { version: 2 }, { algorithm: 'AES-128-GCM' }, { encoding: 'hex' },
      { iv: Buffer.alloc(16).toString('base64') }, { iv: 'not base64!' },
      { ciphertext: Buffer.alloc(16).toString('base64') }, { ciphertext: `${ciphertext.slice(0, -4)}====` },
      { ciphertext: '' },
    ];
    for (const encryption of cases) assert.equal(parseMessageEnvelope(envelope({}, encryption), limits), null, JSON.stringify(encryption));
    assert.equal(parseMessageEnvelope(envelope({ type: 'system' }), limits), null);
    assert.equal(parseMessageEnvelope(envelope({ timestamp: 'yesterday' }), limits), null);
    assert.equal(parseMessageEnvelope(envelope({ senderName: '' }), limits), null);
  });

  test('enforces the operational ciphertext limit', () => {
    const large = Buffer.alloc(3_000, 1).toString('base64');
    assert.ok(parseMessageEnvelope(envelope({}, { ciphertext: large }), { maxCiphertextLength: large.length }));
    assert.equal(parseMessageEnvelope(envelope({}, { ciphertext: large }), { maxCiphertextLength: large.length - 4 }), null);
  });

  test('fingerprints are stable and change with any authenticated field or ciphertext', () => {
    const base = parseMessageEnvelope(envelope({ timestamp: '2026-11-09T10:00:00.000Z' }), limits)!;
    assert.match(envelopeFingerprint(base), /^[0-9a-f]{64}$/);
    assert.equal(envelopeFingerprint(base), envelopeFingerprint({ ...base, encryption: { ...base.encryption } }));
    const changed = Buffer.alloc(40, 8).toString('base64');
    assert.notEqual(envelopeFingerprint(base), envelopeFingerprint({ ...base, encryption: { ...base.encryption, ciphertext: changed } }));
    assert.notEqual(envelopeFingerprint(base), envelopeFingerprint({ ...base, senderName: 'Ava M' }));
  });

  test('delivery acknowledgements must match the emitted message exactly', () => {
    assert.equal(isDeliveryAck({ conversationId: 'c1', messageId: 'm1', status: 'delivered' }, 'c1', 'm1'), true);
    assert.equal(isDeliveryAck({ conversationId: 'c1', messageId: 'm2', status: 'delivered' }, 'c1', 'm1'), false);
    assert.equal(isDeliveryAck({ conversationId: 'c1', messageId: 'm1', status: 'read' }, 'c1', 'm1'), false);
    assert.equal(isDeliveryAck({ conversationId: 'c1', messageId: 'm1', status: 'delivered', userId: 'x' }, 'c1', 'm1'), false);
  });
});

describe('adapter results', () => {
  const expiresAt = new Date(Date.now() + 60_000);

  test('session resolutions are projected and validated', () => {
    assert.deepEqual(parseSessionResolution({ status: 'missing' }), { status: 'missing' });
    assert.deepEqual(parseSessionResolution({ status: 'invalid' }), { status: 'invalid' });
    assert.deepEqual(parseSessionResolution({ status: 'expired' }), { status: 'expired' });
    const parsed = parseSessionResolution({ status: 'authenticated', session: { sessionId: 's1', userId: 'u1', displayName: 'Ava', expiresAt, token: 'secret' } });
    assert.deepEqual(parsed, { status: 'authenticated', session: { sessionId: 's1', userId: 'u1', displayName: 'Ava', expiresAt } });
    for (const session of [
      { sessionId: 's1', userId: 'u1', displayName: 'Ava', expiresAt: expiresAt.toISOString() },
      { sessionId: 's1', userId: 'u 1', displayName: 'Ava', expiresAt },
      { sessionId: 's1', userId: 'u1', displayName: '', expiresAt },
      { sessionId: 's1', userId: 'u1', displayName: 'Ava', expiresAt: new Date(Number.NaN) },
    ]) assert.equal(parseSessionResolution({ status: 'authenticated', session }), null);
    assert.equal(parseSessionResolution({ status: 'ok' }), null);
    assert.equal(parseSessionResolution(null), null);
  });

  test('session checks, stored message references and outcomes are validated', () => {
    assert.deepEqual(parseSessionCheck({ status: 'revoked' }), { status: 'revoked' });
    assert.deepEqual(parseSessionCheck({ status: 'active', expiresAt }), { status: 'active', expiresAt });
    assert.equal(parseSessionCheck({ status: 'active' }), null);
    assert.equal(parseStoredMessageRef(null, 'c1', 'm1'), null);
    assert.deepEqual(parseStoredMessageRef({ conversationId: 'c1', messageId: 'm1', senderId: 'u1' }, 'c1', 'm1'),
      { conversationId: 'c1', messageId: 'm1', senderId: 'u1' });
    assert.equal(parseStoredMessageRef({ conversationId: 'c2', messageId: 'm1', senderId: 'u1' }, 'c1', 'm1'), undefined);
    assert.deepEqual(parseReceiptOutcome({ outcome: 'created', recordedAt: expiresAt }), { outcome: 'created', recordedAt: expiresAt });
    assert.equal(parseReceiptOutcome({ outcome: 'created' }), null);
    assert.deepEqual(parseStoreOutcome({ outcome: 'conflict' }), { outcome: 'conflict' });
    assert.deepEqual(parseStoreOutcome({ outcome: 'duplicate', storedAt: expiresAt }), { outcome: 'duplicate', storedAt: expiresAt });
    assert.equal(parseStoreOutcome({ outcome: 'stored', storedAt: expiresAt }), null);
  });

  test('verification and security decisions fail closed unless explicitly positive', () => {
    assert.deepEqual(parseKeyVerification({ verified: true }), { verified: true });
    for (const value of [{ verified: 'true' }, {}, null, true]) assert.deepEqual(parseKeyVerification(value), { verified: false });
    assert.deepEqual(parseSecurityDecision({ action: 'allow' }), { action: 'allow' });
    assert.deepEqual(parseSecurityDecision({ action: 'deny', reason: 'sentinel.flood' }), { action: 'deny', reason: 'sentinel.flood' });
    assert.deepEqual(parseSecurityDecision({ action: 'deny', reason: 'contains spaces' }), { action: 'deny', reason: 'unspecified' });
    assert.deepEqual(parseSecurityDecision(undefined), { action: 'deny', reason: 'unspecified' });
  });
});
