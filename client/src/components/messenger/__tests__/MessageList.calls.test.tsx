import { fireEvent, render, screen, within } from '@testing-library/react';
import { MessageList } from '../MessageList';
import type { ChatMessage } from '@/messaging/messageModel';
import type { DirectCallSummary } from '@/calls/directCallHistory';

const timestamp = (seconds: number) => Date.parse('2026-11-23T12:00:00Z') + seconds * 1000;
const call = (id: string, seconds: number): DirectCallSummary => ({ id, conversationId: 'dm', kind: 'video',
  endedAt: timestamp(seconds), durationMs: 4000, outcome: 'completed', confirmed: true });
const message = (id: string, seconds: number, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id, conversationId: 'dm', senderId: 'peer', senderName: 'Peer', content: id,
  timestamp: new Date(timestamp(seconds)).toISOString(), type: 'text', deliveryStatus: 'delivered', ...overrides,
});
const props = { currentUserId: 'self', onRetryMessage: jest.fn() };
const order = () => Array.from(screen.getByRole('log').querySelectorAll<HTMLElement>('[data-call-id], [data-message-id]'))
  .map(row => row.dataset.callId ?? row.dataset.messageId);

test('call events are inside MessageList, interleaved by end timestamp with text and attachments', () => {
  const messages = [message('text', 10), message('attachment', 30, { attachments: [
    { id: 'pdf', type: 'file', name: 'notes.pdf', sizeBytes: 32, url: 'blob:notes', mimeType: 'application/pdf' },
  ] })];
  const { container } = render(<MessageList {...props} messages={messages}
    callEvents={[call('last', 40), call('first', 5), call('middle', 20)]} />);
  expect(order()).toEqual(['first', 'text', 'middle', 'attachment', 'last']);
  expect(within(screen.getByRole('log')).getAllByRole('note', { name: 'Video call · 00:04' })).toHaveLength(3);
  expect(screen.getByText('notes.pdf')).toBeInTheDocument();
  expect(container.querySelectorAll('.message-list > [data-call-id]')).toHaveLength(3);
  expect(container.querySelector('.conversation-call-history, details, summary')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Recent calls in this conversation' })).not.toBeInTheDocument();
});

test('calls alone render the conversation timeline instead of the empty-message state', () => {
  render(<MessageList {...props} messages={[]} callEvents={[call('only', 20)]} />);
  expect(order()).toEqual(['only']);
  expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
});

test('ties have deterministic order and call IDs cannot collide with message IDs', () => {
  const { rerender } = render(<MessageList {...props} messages={[message('same-id', 20)]}
    callEvents={[call('z', 20), call('same-id', 20)]} />);
  expect(order()).toEqual(['same-id', 'z', 'same-id']);
  rerender(<MessageList {...props} messages={[message('same-id', 20)]}
    callEvents={[call('same-id', 20), call('z', 20)]} />);
  expect(order()).toEqual(['same-id', 'z', 'same-id']);
  expect(screen.getByText('same-id')).toBeInTheDocument();
});

test('message sequence is preserved and message grouping stops at an intervening call', () => {
  const { container, rerender } = render(<MessageList {...props} messages={[message('before', 10), message('after', 30)]}
    callEvents={[call('between', 20)]} />);
  expect(order()).toEqual(['before', 'between', 'after']);
  expect(container.querySelector('.message-row-grouped')).toBeNull();
  expect(screen.getAllByText('Peer')).toHaveLength(2);
  rerender(<MessageList {...props} messages={[message('server-first', 30), message('server-second', 10)]} callEvents={[call('between', 20)]} />);
  expect(order()).toEqual(['between', 'server-first', 'server-second']);
});

test('confirmation updates, duplicate observations and conversation remounts do not duplicate events', () => {
  const entry = call('once', 20);
  const { container, rerender } = render(<MessageList key="dm" {...props} messages={[]} callEvents={[{ ...entry, confirmed: false }]} />);
  const row = container.querySelector('[data-call-id]');
  expect(screen.getByText('End not confirmed')).toBeInTheDocument();
  rerender(<MessageList key="dm" {...props} messages={[]} callEvents={[entry, entry]} />);
  expect(container.querySelectorAll('[data-call-id]')).toHaveLength(1);
  expect(container.querySelector('[data-call-id]')).toBe(row);
  expect(screen.queryByText('End not confirmed')).not.toBeInTheDocument();
  rerender(<MessageList key="other" {...props} messages={[]} />);
  expect(order()).toEqual([]);
  rerender(<MessageList key="dm" {...props} messages={[]} callEvents={[entry]} />);
  expect(order()).toEqual(['once']);
});

function scrollGeometry() {
  const log = screen.getByRole('log');
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 600 });
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
  return log;
}

test('new calls follow the viewport only when near the bottom; confirmation changes do not scroll again', () => {
  const messages = [message('text', 10)];
  const { rerender } = render(<MessageList {...props} messages={messages} />);
  const log = scrollGeometry(); log.scrollTop = 390; fireEvent.scroll(log);
  rerender(<MessageList {...props} messages={messages} callEvents={[call('new', 20)]} />);
  expect(log.scrollTop).toBe(600);
  log.scrollTop = 300;
  rerender(<MessageList {...props} messages={messages} callEvents={[{ ...call('new', 20), confirmed: false }]} />);
  expect(log.scrollTop).toBe(300);
});

test('readers scrolled up keep their position and can jump to the new call event', () => {
  const messages = [message('text', 10)];
  const { rerender } = render(<MessageList {...props} messages={messages} />);
  const log = scrollGeometry(); log.scrollTop = 0; fireEvent.scroll(log);
  rerender(<MessageList {...props} messages={messages} callEvents={[call('new', 20)]} />);
  expect(log.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: '1 new message — latest' }));
  expect(log.scrollTop).toBe(600);
});

test('the 50-event bound does not prevent a newly appended call from scrolling into view', () => {
  const calls = Array.from({ length: 50 }, (_, i) => call(`call-${i}`, i));
  const { rerender } = render(<MessageList {...props} messages={[]} callEvents={calls} />);
  const log = scrollGeometry(); log.scrollTop = 390; fireEvent.scroll(log);
  rerender(<MessageList {...props} messages={[]} callEvents={[...calls.slice(1), call('call-50', 50)]} />);
  expect(log.scrollTop).toBe(600);
  expect(log.querySelectorAll('[data-call-id]')).toHaveLength(50);
});

test('prepending older messages preserves the scroll offset with call events present', () => {
  const entry = call('call', 30);
  const { rerender } = render(<MessageList {...props} messages={[message('text', 20)]} callEvents={[entry]} />);
  const log = scrollGeometry(); log.scrollTop = 100; fireEvent.scroll(log);
  // First establish the measured height without adding any entries.
  rerender(<MessageList {...props} messages={[message('text', 20)]} callEvents={[entry]} />);
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 800 });
  rerender(<MessageList {...props} messages={[message('older', 10), message('text', 20)]} callEvents={[entry]} />);
  expect(order()).toEqual(['older', 'text', 'call']);
  expect(log.scrollTop).toBe(300);
  expect(screen.queryByRole('button', { name: /new message/ })).not.toBeInTheDocument();
});
