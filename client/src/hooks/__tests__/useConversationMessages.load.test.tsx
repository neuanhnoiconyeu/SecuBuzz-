import { act, renderHook } from '@testing-library/react';
import { useConversationMessages } from '../useConversationMessages';
import type { EncryptedIncomingMessage, IncomingMessage, OutboundMessage } from '@/messaging/messageModel';
import type { MessagingTransport, MessagingTransportHandlers } from '@/messaging/transport';
import type { ConversationCryptoService } from '@/security/conversationCryptoService';
import type { ConversationKeyContext } from '@/security/keyManagement';
import type { CryptoMessageContext, EncryptedMessagePayload } from '@/utils/crypto';

const payload: EncryptedMessagePayload = {
  version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAA=',
};

class IncomingTransport implements MessagingTransport {
  readonly mode = 'realtime' as const;
  readonly subscriptions = new Map<string, MessagingTransportHandlers>();
  readonly connect = jest.fn(async (_conversationId: string) => undefined);
  readonly disconnect = jest.fn(async (_conversationId: string) => undefined);
  readonly sendMessage = jest.fn(async (_message: OutboundMessage) => undefined);
  readonly getConnectionStatus = () => 'connected' as const;
  readonly subscribeToConversation = jest.fn((conversationId: string, handlers: MessagingTransportHandlers) => {
    this.subscriptions.set(conversationId, handlers);
    return () => { this.subscriptions.delete(conversationId); };
  });
  emit(message: IncomingMessage) { this.subscriptions.get(message.conversationId)?.onMessage(message); }
}

interface PendingDecrypt {
  metadata: CryptoMessageContext;
  settled: boolean;
  resolve(value: string): void;
  reject(error: unknown): void;
}

function controlledCrypto() {
  const pending: PendingDecrypt[] = [];
  const service = {
    prepareConversation: jest.fn(async (_context: ConversationKeyContext) => ({ browserCryptoAvailable: true,
      localEncryptionAvailable: true, recipientKeyAvailable: false, authenticatedKeyExchangeEstablished: false })),
    encrypt: jest.fn(async (_context: ConversationKeyContext, _content: string, _metadata: CryptoMessageContext) => payload),
    decrypt: jest.fn((_context: ConversationKeyContext, _payload: unknown, metadata: CryptoMessageContext) =>
      new Promise<string>((resolve, reject) => {
        const entry: PendingDecrypt = { metadata: { ...metadata }, settled: false,
          resolve: (value) => { entry.settled = true; resolve(value); },
          reject: (error) => { entry.settled = true; reject(error); } };
        pending.push(entry);
      })),
  } satisfies ConversationCryptoService;
  return { service, pending };
}

function encrypted(index: number, ciphertext = payload.ciphertext): EncryptedIncomingMessage {
  return { id: `burst-${index}`, conversationId: 'conversation-a', senderId: 'peer', senderName: 'Peer',
    timestamp: new Date().toISOString(), type: 'text', deliveryStatus: 'delivered', encryption: { ...payload, ciphertext } };
}

async function mount() {
  const transport = new IncomingTransport();
  const crypto = controlledCrypto();
  const activity = jest.fn();
  const view = renderHook((props: { conversationId: string; presentationActive: boolean }) => useConversationMessages({
    ...props, currentUserId: 'actor', currentUserName: 'Actor', conversationIds: ['conversation-a', 'conversation-b'],
    transport, cryptoService: crypto.service, onMessageActivity: activity,
  }), { initialProps: { conversationId: 'conversation-a', presentationActive: false } });
  await act(async () => { await Promise.resolve(); });
  return { ...view, transport, crypto, activity };
}

async function drain(crypto: ReturnType<typeof controlledCrypto>) {
  let batches = 0;
  while (crypto.pending.some((entry) => !entry.settled)) {
    if (++batches > 10) throw new Error('The bounded queue did not finish');
    const current = crypto.pending.filter((entry) => !entry.settled);
    await act(async () => {
      for (const entry of current) entry.resolve(`Authenticated ${entry.metadata.messageId}`);
      await Promise.resolve();
    });
  }
}

describe('bounded transient encrypted-message processing', () => {
  test('queues the 65th arrival, deduplicates it while waiting and preserves its ciphertext/AAD snapshot', async () => {
    const { result, transport, crypto } = await mount();
    const last = encrypted(64);
    act(() => {
      for (let index = 0; index < 64; index++) transport.emit(encrypted(index));
      transport.emit(last); transport.emit(last);
    });
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(64);
    expect(result.current.messages).toEqual([]);
    last.senderName = 'Mutated after enqueue'; last.encryption.ciphertext = 'changed after enqueue';
    await act(async () => { crypto.pending[0]!.resolve('Authenticated burst-0'); await Promise.resolve(); });
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(65);
    expect(crypto.service.decrypt.mock.calls[64]?.[1]).toEqual(payload);
    expect(crypto.service.decrypt.mock.calls[64]?.[2]).toMatchObject({ messageId: 'burst-64', senderName: 'Peer' });
    await drain(crypto);
    expect(result.current.messages).toHaveLength(65);
    expect(new Set(result.current.messages.map((message) => message.id)).size).toBe(65);
    expect(result.current.messages.every((message) => message.type === 'text')).toBe(true);
  });

  test('drains after an authentication failure without exposing exception text or losing the queued message', async () => {
    const { result, transport, crypto } = await mount();
    act(() => { for (let index = 0; index < 65; index++) transport.emit(encrypted(index)); });
    await act(async () => { crypto.pending[0]!.reject(new Error('Unverified private material')); await Promise.resolve(); });
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(65);
    await drain(crypto);
    expect(result.current.messages.filter((message) => message.type === 'text')).toHaveLength(64);
    expect(result.current.messages.filter((message) => message.type === 'security_alert')).toHaveLength(1);
    expect(JSON.stringify(result.current.messages)).not.toContain('Unverified private material');
    expect(result.current.messages.find((message) => message.id === 'burst-64')?.content).toBe('Authenticated burst-64');
  });

  test('bounds pending work to 256 after 64 active decrypts and reports overflow once with safe copy', async () => {
    const { result, transport, crypto } = await mount();
    act(() => { for (let index = 0; index < 330; index++) transport.emit(encrypted(index)); });
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(64);
    expect(result.current.messages).toEqual([expect.objectContaining({ type: 'security_alert',
      content: 'Some encrypted messages exceeded the local processing limit and were discarded. No unverified message content was displayed.' })]);
    await drain(crypto);
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(320);
    expect(result.current.messages.filter((message) => message.type === 'text')).toHaveLength(320);
    expect(result.current.messages.filter((message) => message.type === 'security_alert')).toHaveLength(1);
  });

  test('applies the 16MiB ciphertext queue budget before the entry count limit', async () => {
    const { result, transport, crypto } = await mount();
    const largeCiphertext = 'A'.repeat(1_000_000);
    act(() => {
      for (let index = 0; index < 64; index++) transport.emit(encrypted(index));
      for (let index = 64; index < 73; index++) transport.emit(encrypted(index, largeCiphertext));
    });
    expect(result.current.messages.filter((message) => message.type === 'security_alert')).toHaveLength(1);
    await drain(crypto);
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(72);
    expect(result.current.messages.filter((message) => message.type === 'text')).toHaveLength(72);
  });

  test('navigation and hidden presentation keep the same ciphertext queue and display only the selected conversation', async () => {
    const { result, transport, crypto, rerender } = await mount();
    act(() => { for (let index = 0; index < 70; index++) transport.emit(encrypted(index)); });
    await act(async () => { rerender({ conversationId: 'conversation-b', presentationActive: true }); await Promise.resolve(); });
    await drain(crypto);
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(70);
    expect(transport.subscribeToConversation).toHaveBeenCalledTimes(2);
    expect(result.current.messages).toEqual([]);
    await act(async () => { rerender({ conversationId: 'conversation-a', presentationActive: true }); await Promise.resolve(); });
    expect(result.current.messages).toHaveLength(70);
  });

  test('unmount cancels queued work and discards late authenticated results from active native promises', async () => {
    const { transport, crypto, activity, unmount } = await mount();
    act(() => { for (let index = 0; index < 70; index++) transport.emit(encrypted(index)); });
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(64);
    unmount();
    await drain(crypto);
    expect(crypto.service.decrypt).toHaveBeenCalledTimes(64);
    expect(activity).not.toHaveBeenCalled();
    expect(transport.subscriptions.size).toBe(0);
  });
});
