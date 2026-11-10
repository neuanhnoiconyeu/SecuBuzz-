import { appendMessage, MAX_MESSAGES_PER_CONVERSATION, updateMessageDeliveryStatus } from '../messageState';
import type { ChatMessage } from '../messageModel';

const message = (id: string, seconds: number): ChatMessage => ({ id, conversationId: 'conversation', senderId: 'peer', senderName: 'Peer',
  content: id, timestamp: new Date(1_700_000_000_000 + seconds * 1000).toISOString(), type: 'text', deliveryStatus: 'sent' });

test('orders out-of-order arrivals by timestamp and preserves arrival order for equal timestamps', () => {
  let state = appendMessage({}, message('later', 3));
  state = appendMessage(state, message('earlier', 1));
  state = appendMessage(state, message('same-time-first', 2));
  state = appendMessage(state, message('same-time-second', 2));
  expect(state.conversation?.map((entry) => entry.id)).toEqual(['earlier', 'same-time-first', 'same-time-second', 'later']);
  expect(appendMessage(state, message('later', 99))).toBe(state);
});

test('read is terminal and delayed acknowledgements cannot regress delivery receipts', () => {
  const sent = appendMessage({}, message('receipt', 1));
  const read = updateMessageDeliveryStatus(sent, 'conversation', 'receipt', 'read');
  for (const status of ['sending', 'sent', 'delivered', 'failed'] as const) {
    expect(updateMessageDeliveryStatus(read, 'conversation', 'receipt', status)).toBe(read);
  }
});

test('bounds the in-memory window to the newest messages without mixing conversations', () => {
  let state = {};
  for (let index = 0; index < MAX_MESSAGES_PER_CONVERSATION + 5; index++) state = appendMessage(state, message(String(index), index));
  const limited = appendMessage(state, { ...message('other', 0), conversationId: 'other' });
  expect(limited.conversation).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
  expect(limited.conversation?.[0]?.id).toBe('5');
  expect(limited.other).toHaveLength(1);
});
