import { appendMessage, createClientMessageId, updateMessageDeliveryStatus } from '../messageState';
import type { ChatMessage } from '../messageModel';

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message-1',
  conversationId: 'conversation-a',
  senderId: 'user-a',
  senderName: 'Ari',
  content: 'Hello',
  timestamp: '2026-01-01T12:00:00.000Z',
  type: 'text',
  deliveryStatus: 'sending',
  ...overrides,
});

describe('conversation message state', () => {
  test('generates unique client IDs', () => {
    expect(createClientMessageId()).not.toBe(createClientMessageId());
  });

  test('adds messages to their conversation and ignores duplicate IDs', () => {
    const first = message();
    const withFirst = appendMessage({}, first);
    const withDuplicate = appendMessage(withFirst, { ...first, content: 'duplicate' });
    const withOtherConversation = appendMessage(withDuplicate, message({
      id: 'message-2',
      conversationId: 'conversation-b',
    }));

    expect(withDuplicate).toBe(withFirst);
    expect(withOtherConversation['conversation-a']).toEqual([first]);
    expect(withOtherConversation['conversation-b']).toHaveLength(1);
  });

  test('updates delivery state without changing other messages or conversations', () => {
    const first = message();
    const second = message({ id: 'message-2' });
    const state = appendMessage(appendMessage({}, first), second);
    const updated = updateMessageDeliveryStatus(state, 'conversation-a', 'message-1', 'failed');

    expect(updated['conversation-a']?.[0].deliveryStatus).toBe('failed');
    expect(updated['conversation-a']?.[1]).toBe(second);
    expect(updateMessageDeliveryStatus(updated, 'conversation-b', 'missing', 'sent')).toBe(updated);
  });

  test('does not let a stale sent acknowledgement replace a delivered state', () => {
    const state = appendMessage({}, message());
    const delivered = updateMessageDeliveryStatus(state, 'conversation-a', 'message-1', 'delivered');
    expect(updateMessageDeliveryStatus(delivered, 'conversation-a', 'message-1', 'sent')).toBe(delivered);
  });
});
