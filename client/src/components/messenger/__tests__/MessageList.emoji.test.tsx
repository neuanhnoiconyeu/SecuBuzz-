import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MessageList } from '../MessageList';
import { toggleMessageReaction } from '@/messaging/messageState';
import type { ChatMessage } from '@/messaging/messageModel';

const message: ChatMessage = { id: 'message', conversationId: 'chat', senderId: 'peer', senderName: 'Peer', content: 'Hello',
  timestamp: '2026-11-21T00:00:00.000Z', type: 'text', deliveryStatus: 'delivered' };
beforeEach(() => localStorage.clear());

test('full-picker reactions replace or remove my choice without changing other users or counts', () => {
  function Conversation() {
    const [messages, setMessages] = useState<ChatMessage[]>([{ ...message, reactions: [{ emoji: '👍', userIds: ['peer', 'self'] }] }]);
    return <MessageList messages={messages} currentUserId="self" onRetryMessage={jest.fn()}
      onToggleReaction={(id, emoji) => setMessages(previous => toggleMessageReaction({ chat: previous }, 'chat', id, emoji, 'self').chat!)} />;
  }
  render(<Conversation />);
  expect(screen.getByRole('button', { name: '👍 2' })).toHaveAttribute('aria-pressed', 'true');
  const choose = (query: string, name: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'React to message' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'More reactions' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: query } });
    fireEvent.click(screen.getByRole('button', { name }));
  };
  choose('fire', 'React with fire 🔥');
  expect(screen.getByRole('button', { name: '👍 1' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: '🔥 1' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '🔥 1' })).toHaveAccessibleDescription('fire. Your reaction; activate to remove it.');
  choose('fire', 'React with fire 🔥'); expect(screen.queryByRole('button', { name: '🔥 1' })).not.toBeInTheDocument();
  choose('thumbs up', 'React with thumbs up 👍');
  expect(screen.getByRole('button', { name: '👍 2' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '👍 2' }));
  expect(screen.getByRole('button', { name: '👍 1' })).toHaveAttribute('aria-pressed', 'false');
});

test('standalone Unicode emoji messages enlarge uniformly without changing indicators, identity, or media captions', () => {
  const { container } = render(<MessageList currentUserId="self" onRetryMessage={jest.fn()} messages={[
    { ...message, content: '👩🏽‍💻', isEdited: true, forwardedFrom: 'Friend' },
    { ...message, id: 'many', content: '😀 😀 😀 😀' },
    { ...message, id: 'mixed', content: 'Hello 😀' },
    { ...message, id: 'attachment', content: '😀', attachments: [{ id: 'file', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 1, type: 'file', url: 'blob:file' }] },
    { ...message, id: 'voice', type: 'voice', content: '😀', voice: { audioUrl: 'blob:voice', durationSeconds: 1 } },
    { ...message, id: 'deleted', content: '😀', isDeleted: true },
  ]} />);
  expect(container.querySelectorAll('.message-text--emoji')).toHaveLength(2);
  const original = container.querySelector<HTMLElement>('[data-message-id="message"]')!;
  expect(original.querySelector('.message-text--emoji')).toBeInTheDocument();
  expect(original.querySelector('.message-bubble--bare')).toBeInTheDocument();
  const many = container.querySelector<HTMLElement>('[data-message-id="many"]')!;
  expect(many.querySelector('.message-text--emoji')).toBeInTheDocument();
  expect(many.querySelector('.message-bubble--bare')).toBeInTheDocument();
  expect(within(original).getByText(/Forwarded from Friend/)).toBeInTheDocument();
  expect(within(original).getByText('(edited)')).toBeInTheDocument();
});
