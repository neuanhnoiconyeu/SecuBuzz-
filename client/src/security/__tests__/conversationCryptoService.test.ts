import { BrowserConversationCryptoService } from '../conversationCryptoService';
import { InMemoryDemoKeyManager } from '../keyManagement';
import type { ConversationKeyContext } from '../keyManagement';
import type { CryptoMessageContext } from '@/utils/crypto';

const keyContext: ConversationKeyContext = { conversationId: 'room-a', localUserId: 'user-a' };
const messageContext = (messageId: string): CryptoMessageContext => ({
  conversationId: keyContext.conversationId,
  messageId,
  senderId: 'user-a',
  senderName: 'Alice',
  timestamp: '2026-01-01T12:00:00.000Z',
});

async function withNonceBytes<T>(values: number[], operation: (calls: () => number) => Promise<T>): Promise<T> {
  const cryptoObject = globalThis.crypto;
  const originalDescriptor = Object.getOwnPropertyDescriptor(cryptoObject, 'getRandomValues');
  let count = 0;
  Object.defineProperty(cryptoObject, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: (array: Uint8Array<ArrayBufferLike>) => {
      const fill = values[Math.min(count, values.length - 1)] ?? 0;
      count += 1;
      array.fill(fill);
      return array;
    },
  });

  try {
    return await operation(() => count);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(cryptoObject, 'getRandomValues', originalDescriptor);
    } else {
      Reflect.deleteProperty(cryptoObject, 'getRandomValues');
    }
  }
}

describe('BrowserConversationCryptoService', () => {
  test('shares nonce tracking across service instances and retries a collision', async () => {
    const keyManager = new InMemoryDemoKeyManager();
    await keyManager.getConversationKey(keyContext);
    const firstService = new BrowserConversationCryptoService(keyManager);
    const secondService = new BrowserConversationCryptoService(keyManager);

    await withNonceBytes([7, 7, 8], async (calls) => {
      const first = await firstService.encrypt(keyContext, 'first', messageContext('message-1'));
      const second = await secondService.encrypt(keyContext, 'second', messageContext('message-2'));
      expect(first.iv).not.toBe(second.iv);
      expect(calls()).toBe(3);
    });
  });

  test('associates nonce tracking with each key and accepts a nonce again after key rotation', async () => {
    const keyManager = new InMemoryDemoKeyManager();
    await keyManager.getConversationKey(keyContext);
    const service = new BrowserConversationCryptoService(keyManager);

    await withNonceBytes([9, 9], async (calls) => {
      const beforeRotation = await service.encrypt(keyContext, 'before', messageContext('message-1'));
      await keyManager.rotateConversationKey(keyContext);
      const afterRotation = await service.encrypt(keyContext, 'after', messageContext('message-2'));
      expect(afterRotation.iv).toBe(beforeRotation.iv);
      expect(calls()).toBe(2);
    });
  });

  test('fails clearly when no local conversation key exists for decryption', async () => {
    const senderKeys = new InMemoryDemoKeyManager();
    const sender = new BrowserConversationCryptoService(senderKeys);
    const payload = await sender.encrypt(keyContext, 'ciphertext only', messageContext('message-1'));

    const receiver = new BrowserConversationCryptoService(new InMemoryDemoKeyManager());
    await expect(receiver.decrypt(keyContext, payload, messageContext('message-1'))).rejects.toMatchObject({
      code: 'missing_key',
      message: 'No local encryption key is available for this conversation.',
    });
  });

  test('keeps keys scoped to their conversation when the active chat changes', async () => {
    const keyManager = new InMemoryDemoKeyManager();
    const service = new BrowserConversationCryptoService(keyManager);
    const secondConversation = { ...keyContext, conversationId: 'room-b' };
    await service.prepareConversation(keyContext);
    await service.prepareConversation(secondConversation);
    const payload = await service.encrypt(keyContext, 'room A secret', messageContext('message-1'));

    await expect(service.decrypt(
      secondConversation,
      payload,
      { ...messageContext('message-1'), conversationId: secondConversation.conversationId }
    )).rejects.toMatchObject({ code: 'authentication_failed' });
    await expect(service.decrypt(keyContext, payload, messageContext('message-1'))).resolves.toBe('room A secret');
  });
});
