import { act, renderHook, waitFor } from '@testing-library/react';
import { useConversationMessages } from '../useConversationMessages';
import type { ChatMessage, IncomingMessage, OutboundMessage } from '@/messaging/messageModel';
import type { MessagingTransport, MessagingTransportHandlers } from '@/messaging/transport';
import { BrowserConversationCryptoService, demoConversationCryptoService } from '@/security/conversationCryptoService';
import type { ConversationCryptoService } from '@/security/conversationCryptoService';
import { InMemoryDemoKeyManager } from '@/security/keyManagement';
import type { CryptoMessageContext } from '@/utils/crypto';
import type { TransportMode } from '@/messaging/messageModel';
import { useMessengerConversations } from '@/hooks/useMessengerConversations';
import { createDemoConversations } from '@/conversations/demoConversations';

class TestTransport implements MessagingTransport {
  constructor(readonly mode: TransportMode = 'realtime') {}
  readonly connect = jest.fn(async (_conversationId: string) => undefined);
  readonly disconnect = jest.fn(async (_conversationId: string) => undefined);
  readonly sendMessage = jest.fn(async (_message: OutboundMessage) => undefined);
  private readonly handlers = new Map<string, MessagingTransportHandlers>();

  subscribeToConversation = jest.fn((conversationId: string, handlers: MessagingTransportHandlers) => {
    this.handlers.set(conversationId, handlers);
    return () => { this.handlers.delete(conversationId); };
  });

  emitMessage(message: IncomingMessage) { this.handlers.get(message.conversationId)?.onMessage(message); }
  emitPresence(status: 'online' | 'offline' | 'busy' | 'away') {
    this.handlers.forEach((handlers) => handlers.onPresenceUpdate(status));
  }
  emitDelivery(messageId: string, status: 'sending' | 'sent' | 'delivered' | 'failed') {
    this.handlers.forEach((handlers) => handlers.onDeliveryStatus({ messageId, status }));
  }
  emitSecurityAlert(message: ChatMessage) { this.handlers.get(message.conversationId)?.onSecurityAlert(message); }
}

const options = (
  transport: MessagingTransport,
  conversationId = 'conversation-a',
  cryptoService: ConversationCryptoService = demoConversationCryptoService
) => ({ conversationId, currentUserId: 'user-a', currentUserName: 'You', transport, cryptoService });

async function encryptedIncoming(overrides: Partial<CryptoMessageContext> = {}) {
  const envelope = {
    id: 'incoming-1',
    conversationId: 'conversation-a',
    senderId: 'securebot',
    senderName: 'SecureBot',
    timestamp: '2026-01-01T12:00:00.000Z',
  };
  const context: CryptoMessageContext = {
    conversationId: envelope.conversationId,
    messageId: envelope.id,
    senderId: envelope.senderId,
    senderName: envelope.senderName,
    timestamp: envelope.timestamp,
    ...overrides,
  };
  const encryption = await demoConversationCryptoService.encrypt(
    { conversationId: 'conversation-a', localUserId: 'user-a' },
    'A reply',
    context
  );
  return {
    ...envelope,
    type: 'text' as const,
    deliveryStatus: 'delivered' as const,
    encryption,
  };
}

describe('useConversationMessages', () => {
  test('encrypts before adding local state and sends only a versioned encrypted envelope', async () => {
    const transport = new TestTransport();
    const { result } = renderHook(() => useConversationMessages(options(transport)));
    await waitFor(() => expect(result.current.securityStatus?.localEncryptionAvailable).toBe(true));
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));

    let accepted = false;
    await act(async () => { accepted = await result.current.sendMessage('hello'); });

    expect(accepted).toBe(true);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      conversationId: 'conversation-a', senderId: 'user-a', senderName: 'You', content: 'hello',
      type: 'text', deliveryStatus: 'sent',
      encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', scope: 'browser-demo' },
    });
    expect(transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: result.current.messages[0]?.id,
      conversationId: 'conversation-a',
      encryption: expect.objectContaining({ version: 1, algorithm: 'AES-256-GCM' }),
    }));
    expect(transport.sendMessage.mock.calls[0]?.[0]).not.toHaveProperty('content');
  });

  test('decrypts incoming envelopes, deduplicates them, and applies presence and delivery updates', async () => {
    const transport = new TestTransport();
    const { result } = renderHook(() => useConversationMessages(options(transport)));
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    await act(async () => { await result.current.sendMessage('outgoing'); });
    await waitFor(() => expect(result.current.messages[0]?.deliveryStatus).toBe('sent'));
    const incoming = await encryptedIncoming();
    const alert: ChatMessage = {
      id: 'alert-1', conversationId: 'conversation-a', senderId: 'security', senderName: 'Security notice',
      content: 'Security event', timestamp: '2026-01-01T12:00:01.000Z', type: 'security_alert', deliveryStatus: 'delivered',
    };

    await act(async () => {
      transport.emitMessage(incoming);
      transport.emitMessage(incoming);
      transport.emitMessage({ ...incoming, id: 'wrong-conversation', conversationId: 'conversation-b' });
      transport.emitSecurityAlert(alert);
      transport.emitPresence('online');
      transport.emitDelivery(result.current.messages[0]!.id, 'delivered');
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(3));
    expect(result.current.messages.find((message) => message.senderId === 'securebot')).toMatchObject({
      senderId: 'securebot', content: 'A reply',
    });
    expect(result.current.messages.find((message) => message.id === 'alert-1')).toMatchObject({
      type: 'security_alert', content: 'Security event',
    });
    expect(result.current.messages[0]?.deliveryStatus).toBe('delivered');
    expect(result.current.presence).toBe('online');
  });

  test('discards ciphertext with bad authentication and shows a safe deduplicated security alert', async () => {
    const transport = new TestTransport();
    const { result } = renderHook(() => useConversationMessages(options(transport)));
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    const incoming = await encryptedIncoming();
    await act(async () => {
      transport.emitMessage({ ...incoming, senderId: 'attacker' });
      transport.emitMessage({ ...incoming, senderId: 'attacker' });
      transport.emitMessage({ ...incoming, id: 'tampered-message-id' });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'security_alert',
        content: 'An encrypted message failed authentication and was discarded.',
      }),
    ]));
    expect(result.current.messages.every((message) => message.type === 'security_alert')).toBe(true);
    expect(result.current.messages[0]).toMatchObject({
      type: 'security_alert',
      content: 'An encrypted message failed authentication and was discarded.',
    });
    expect(result.current.messages[0]?.content).not.toContain('A reply');
  });

  test('rejects plaintext demo replies from a non-demo transport', async () => {
    const transport = new TestTransport();
    const { result } = renderHook(() => useConversationMessages(options(transport)));
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    await act(async () => {
      transport.emitMessage({
        id: 'spoofed-demo',
        conversationId: 'conversation-a',
        senderId: 'securebot',
        senderName: 'SecureBot',
        content: 'Unencrypted remote text',
        timestamp: '2026-01-01T12:00:00.000Z',
        type: 'text',
        deliveryStatus: 'delivered',
        demoOnly: true,
      });
    });
    expect(result.current.messages).toHaveLength(0);
  });

  test('does not display or transport plaintext when encryption fails', async () => {
    const transport = new TestTransport();
    const cryptoService: ConversationCryptoService = {
      prepareConversation: async () => ({
        browserCryptoAvailable: true, localEncryptionAvailable: true,
        recipientKeyAvailable: false, authenticatedKeyExchangeEstablished: false,
      }),
      encrypt: async () => { throw new Error('provider details must not leak'); },
      decrypt: async () => { throw new Error('unused'); },
    };
    const { result } = renderHook(() => useConversationMessages(options(transport, 'conversation-a', cryptoService)));
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    let accepted = true;
    await act(async () => { accepted = await result.current.sendMessage('secret draft'); });
    expect(accepted).toBe(false);
    expect(result.current.messages).toHaveLength(0);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('represents a failed transport send and retries the exact encrypted payload', async () => {
    const transport = new TestTransport();
    transport.sendMessage.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useConversationMessages(options(transport)));
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    let accepted = true;
    await act(async () => { accepted = await result.current.sendMessage('keep this draft'); });
    expect(accepted).toBe(false);
    expect(result.current.messages[0]?.deliveryStatus).toBe('failed');
    const payload = result.current.messages[0]?.encryption;
    await act(async () => { accepted = await result.current.retryMessage(result.current.messages[0]!.id); });
    expect(accepted).toBe(true);
    expect(result.current.messages[0]?.deliveryStatus).toBe('sent');
    expect(transport.sendMessage.mock.calls[1]?.[0].encryption).toEqual(payload);
  });

  test('updates display names without replacing keys or rewriting authenticated sender metadata', async () => {
    const transport = new TestTransport();
    transport.sendMessage.mockRejectedValueOnce(new Error('offline'));
    const cryptoService = new BrowserConversationCryptoService(new InMemoryDemoKeyManager());
    const prepareConversation = jest.spyOn(cryptoService, 'prepareConversation');
    const { result, rerender } = renderHook(
      ({ displayName }) => useConversationMessages({
        ...options(transport, 'conversation-a', cryptoService),
        currentUserName: displayName,
      }),
      { initialProps: { displayName: 'Original Name' } }
    );
    await waitFor(() => expect(result.current.securityStatus?.localEncryptionAvailable).toBe(true));
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    await act(async () => { expect(await result.current.sendMessage('original message')).toBe(false); });
    const original = transport.sendMessage.mock.calls[0]![0];

    rerender({ displayName: 'Updated Name' });
    expect(prepareConversation).toHaveBeenCalledTimes(1);
    await act(async () => { expect(await result.current.retryMessage(original.id)).toBe(true); });
    expect(transport.sendMessage.mock.calls[1]?.[0]).toEqual(original);
    expect(transport.sendMessage.mock.calls[1]?.[0].senderName).toBe('Original Name');
    await expect(cryptoService.decrypt(
      { conversationId: 'conversation-a', localUserId: 'user-a' },
      original.encryption,
      {
        conversationId: original.conversationId,
        messageId: original.id,
        senderId: original.senderId,
        senderName: original.senderName,
        timestamp: original.timestamp,
      }
    )).resolves.toBe('original message');

    await act(async () => { expect(await result.current.sendMessage('new message')).toBe(true); });
    expect(transport.sendMessage.mock.calls[2]?.[0]).toMatchObject({ senderId: 'user-a', senderName: 'Updated Name' });
    expect(result.current.messages.map((message) => message.senderName)).toEqual(['Original Name', 'Updated Name']);
    expect(prepareConversation).toHaveBeenCalledTimes(1);
  });

  test('keeps separate state per conversation', async () => {
    const transport = new TestTransport();
    const { result, rerender } = renderHook(
      ({ conversationId }) => useConversationMessages(options(transport, conversationId)),
      { initialProps: { conversationId: 'conversation-a' } }
    );
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    await act(async () => { await result.current.sendMessage('A message'); });
    rerender({ conversationId: 'conversation-b' });
    expect(result.current.messages).toHaveLength(0);
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    rerender({ conversationId: 'conversation-a' });
    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.messages.map((message) => message.content)).toEqual(['A message']);
  });

  test('tracks inactive arrivals as unread, clears on selection, and keeps message lists isolated', async () => {
    const transport = new TestTransport('local-demo');
    const demos = createDemoConversations(Date.parse('2026-02-01T12:00:00.000Z'));
    const { result } = renderHook(() => {
      const conversationState = useMessengerConversations(demos);
      const messageState = useConversationMessages({
        conversationId: conversationState.activeConversationId ?? '',
        currentUserId: 'local-user',
        currentUserName: 'You',
        conversationIds: conversationState.conversations.map((conversation) => conversation.id),
        transport,
        onMessageActivity: conversationState.recordMessageActivity,
      });
      return { conversationState, messageState };
    });
    await waitFor(() => expect(result.current.messageState.connectionStatus).toBe('connected'));
    const inactiveId = 'demo-direct-ava';
    const inactiveMessage: IncomingMessage = {
      id: 'inactive-message-1',
      conversationId: inactiveId,
      senderId: 'demo-ava',
      senderName: 'Ava Morgan',
      content: 'A local preview message',
      timestamp: '2026-02-01T12:05:00.000Z',
      type: 'text',
      deliveryStatus: 'delivered',
      demoOnly: true,
    };

    await act(async () => {
      transport.emitMessage(inactiveMessage);
      transport.emitMessage(inactiveMessage);
    });
    expect(result.current.conversationState.conversations.find((conversation) => conversation.id === inactiveId))
      .toMatchObject({ unreadCount: 1, lastMessagePreview: 'A local preview message' });
    expect(result.current.messageState.messages).toHaveLength(0);

    act(() => { result.current.conversationState.selectConversation(inactiveId); });
    await waitFor(() => expect(result.current.messageState.connectionStatus).toBe('connected'));
    expect(result.current.conversationState.conversations.find((conversation) => conversation.id === inactiveId)?.unreadCount).toBe(0);
    expect(result.current.messageState.messages.map((message) => message.id)).toEqual(['inactive-message-1']);

    await act(async () => {
      transport.emitMessage({ ...inactiveMessage, id: 'active-message-2', content: 'Active conversation message' });
    });
    expect(result.current.conversationState.conversations.find((conversation) => conversation.id === inactiveId)?.unreadCount).toBe(0);
    expect(result.current.messageState.messages.map((message) => message.content)).toEqual([
      'A local preview message',
      'Active conversation message',
    ]);
  });
});
