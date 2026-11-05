import {
  CryptoOperationError,
  decryptMessage,
  encryptMessage,
  generateEncryptionKey,
  type CryptoMessageContext,
  type EncryptedMessagePayload,
} from './crypto';

const context: CryptoMessageContext = {
  conversationId: 'conversation-a',
  messageId: 'message-a',
  senderId: 'user-a',
  senderName: 'Alice',
  timestamp: '2026-01-01T12:00:00.000Z',
};

describe('browser AES-256-GCM utilities', () => {
  test('generates a non-extractable AES-256 key with encrypt and decrypt usages', async () => {
    const key = await generateEncryptionKey();
    expect(key.type).toBe('secret');
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  test('returns versioned base64 ciphertext and round-trips Unicode and newlines', async () => {
    const key = await generateEncryptionKey();
    const plaintext = 'Hello 👋\nSecond line — café';
    const payload = await encryptMessage(plaintext, key, context);
    expect(payload).toMatchObject({ version: 1, algorithm: 'AES-256-GCM', encoding: 'base64' });
    expect(atob(payload.iv)).toHaveLength(12);
    expect(atob(payload.ciphertext).length).toBeGreaterThan(16);
    await expect(decryptMessage(payload, key, context)).resolves.toBe(plaintext);
  });

  test('uses a different nonce for each encryption under the same key', async () => {
    const key = await generateEncryptionKey();
    const first = await encryptMessage('one', key, context);
    const second = await encryptMessage('two', key, { ...context, messageId: 'message-b' });
    expect(first.iv).not.toBe(second.iv);
  });

  test('rejects empty plaintext and invalid keys with typed safe errors', async () => {
    const key = await generateEncryptionKey();
    await expect(encryptMessage('', key, context)).rejects.toMatchObject({ code: 'invalid_plaintext' });
    const extractableKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    await expect(encryptMessage('secret', extractableKey, context)).rejects.toBeInstanceOf(CryptoOperationError);
  });

  test.each([
    ['wrong conversation', { ...context, conversationId: 'conversation-b' }],
    ['wrong message id', { ...context, messageId: 'message-b' }],
    ['wrong sender', { ...context, senderId: 'attacker' }],
    ['wrong timestamp', { ...context, timestamp: '2026-01-01T12:00:01.000Z' }],
  ])('rejects authenticated metadata changes (%s)', async (_name, alteredContext) => {
    const key = await generateEncryptionKey();
    const payload = await encryptMessage('authenticated text', key, context);
    await expect(decryptMessage(payload, key, alteredContext)).rejects.toMatchObject({
      code: 'authentication_failed',
    });
  });

  test('rejects tampered ciphertext and a different key without returning plaintext', async () => {
    const key = await generateEncryptionKey();
    const otherKey = await generateEncryptionKey();
    const payload = await encryptMessage('do not reveal', key, context);
    const bytes = Uint8Array.from(atob(payload.ciphertext), (character) => character.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 1;
    const tampered: EncryptedMessagePayload = { ...payload, ciphertext: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptMessage(tampered, key, context)).rejects.toMatchObject({ code: 'authentication_failed' });
    await expect(decryptMessage(payload, otherKey, context)).rejects.toMatchObject({ code: 'authentication_failed' });
  });

  test.each([
    ['version', { version: 2 }],
    ['algorithm', { algorithm: 'AES-CBC' }],
    ['encoding', { encoding: 'hex' }],
    ['base64', { iv: '%%%=' }],
    ['IV length', { iv: btoa('short') }],
    ['empty ciphertext', { ciphertext: '' }],
  ])('rejects malformed or unsupported payload %s', async (_name, overrides) => {
    const key = await generateEncryptionKey();
    const payload = await encryptMessage('valid', key, context);
    await expect(decryptMessage({ ...payload, ...overrides }, key, context)).rejects.toBeInstanceOf(CryptoOperationError);
  });

  test('does not include native Web Crypto details in externally visible errors', async () => {
    const key = await generateEncryptionKey();
    const payload = await encryptMessage('safe', key, context);
    await expect(decryptMessage(payload, key, { ...context, messageId: '' })).rejects.toMatchObject({
      code: 'invalid_context',
      message: 'The message context is invalid.',
    });
  });
});
