import { fireEvent, render, screen, within } from '@testing-library/react';
import { MessageList } from '@/components/messenger/MessageList';
import { AIChatHistory } from '../AIChatHistory';
import { AI_MAX_INPUT, type AIMessageAction } from '@/ai/aiModel';
import type { ChatMessage } from '@/messaging/messageModel';

const message: ChatMessage = { id: 'chosen', conversationId: 'conversation-a', senderId: 'peer', senderName: 'Peer',
  content: 'Chosen text only', timestamp: new Date().toISOString(), type: 'text', deliveryStatus: 'delivered' };

test.each([
  ['chat', 'Ask @Secu'], ['summarize', 'Summarize selected message'], ['translate', 'Translate selected message'], ['explain', 'Explain selected message'],
] as const)('offers explicit %s selection for the chosen message only', (task: AIMessageAction, label) => {
  const request = jest.fn();
  render(<MessageList messages={[message, { ...message, id: 'unrelated', content: 'Unrelated text' }]} currentUserId="actor" onRetryMessage={jest.fn()} onAIMessage={request} />);
  expect(request).not.toHaveBeenCalled();
  const row = screen.getByText('Chosen text only').closest('article')!;
  fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
  expect(request.mock.calls).toEqual([[task, 'chosen']]);
});

test('never offers AI selection for alerts, deleted messages, unsupported media or oversized content', () => {
  render(<MessageList messages={[
    { ...message, id: 'alert', type: 'security_alert' }, { ...message, id: 'system', type: 'system' },
    { ...message, id: 'deleted', isDeleted: true }, { ...message, id: 'voice', type: 'voice' },
    { ...message, id: 'long', content: 'x'.repeat(AI_MAX_INPUT + 1) },
  ]} currentUserId="actor" onRetryMessage={jest.fn()} onAIMessage={jest.fn()} />);
  expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
});

test('AI chat preserves a reader’s scroll position, offers latest, and resets the notice', () => {
  const messages = [{ id: 1, role: 'user' as const, text: 'Earlier text', status: 'completed' as const }];
  const view = render(<AIChatHistory messages={messages} loading={false} />);
  const log = screen.getByRole('log', { name: '@Secu messages' });
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 });
  log.scrollTop = 100; fireEvent.scroll(log);
  view.rerender(<AIChatHistory messages={[...messages, { id: 2, role: 'assistant', text: 'New example', kind: 'example' }]} loading={false} />);
  expect(log.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
  expect(log.scrollTop).toBe(1000);
  log.scrollTop = 100; fireEvent.scroll(log);
  view.rerender(<AIChatHistory messages={[]} loading={false} />);
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
});
