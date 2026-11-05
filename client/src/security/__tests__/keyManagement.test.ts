import { InMemoryDemoKeyManager, KeyManagementError } from '../keyManagement';

const context = { conversationId: 'room-a', localUserId: 'user-a' };

describe('InMemoryDemoKeyManager', () => {
  test('reuses a non-extractable key only for its local user and conversation', async () => {
    const manager = new InMemoryDemoKeyManager();
    const original = await manager.getConversationKey(context);
    expect(await manager.getConversationKey(context)).toBe(original);
    expect(original.extractable).toBe(false);
    expect(await manager.getConversationKey({ ...context, conversationId: 'room-b' })).not.toBe(original);
    expect(await manager.getConversationKey({ ...context, localUserId: 'user-b' })).not.toBe(original);
  });

  test('coalesces concurrent key creation and keeps delimiter-like IDs distinct', async () => {
    const manager = new InMemoryDemoKeyManager();
    const [first, concurrent] = await Promise.all([
      manager.getConversationKey(context),
      manager.getConversationKey(context),
    ]);
    expect(first).toBe(concurrent);

    const delimiterContext = { conversationId: 'b\u0000c', localUserId: 'a' };
    const alternateDelimiterContext = { conversationId: 'c', localUserId: 'a\u0000b' };
    expect(await manager.getConversationKey(delimiterContext))
      .not.toBe(await manager.getConversationKey(alternateDelimiterContext));
  });

  test('distinguishes an absent key from a key created for local encryption', async () => {
    const manager = new InMemoryDemoKeyManager();
    expect(await manager.getExistingConversationKey(context)).toBeNull();
    const created = await manager.getConversationKey(context);
    expect(await manager.getExistingConversationKey(context)).toBe(created);
  });

  test('rotates the key and never exports recipient key material', async () => {
    const manager = new InMemoryDemoKeyManager();
    const original = await manager.getConversationKey(context);
    const rotated = await manager.rotateConversationKey(context);
    expect(rotated).not.toBe(original);
    expect(await manager.getConversationKey(context)).toBe(rotated);
    expect(await manager.getRecipientPublicKeyMetadata(context)).toBeNull();
  });

  test('does not pretend to establish an unconfigured authenticated key exchange', async () => {
    const manager = new InMemoryDemoKeyManager();
    await expect(manager.establishAuthenticatedKeyExchange(context)).rejects.toBeInstanceOf(KeyManagementError);
    await expect(manager.establishAuthenticatedKeyExchange(context)).rejects.toMatchObject({
      code: 'key_exchange_not_configured',
      message: 'Authenticated recipient key exchange is not configured.',
    });
  });

  test('reports local crypto separately from recipient keys and authenticated exchange', async () => {
    const manager = new InMemoryDemoKeyManager();
    await expect(manager.getSecurityStatus(context)).resolves.toEqual({
      browserCryptoAvailable: true,
      localEncryptionAvailable: true,
      recipientKeyAvailable: false,
      authenticatedKeyExchangeEstablished: false,
    });
  });
});
