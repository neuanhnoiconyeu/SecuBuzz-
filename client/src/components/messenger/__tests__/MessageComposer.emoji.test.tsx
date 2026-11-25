import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageComposer } from '../MessageComposer';
import { MessageList } from '../MessageList';
import type { ChatMessage } from '@/messaging/messageModel';

const props = { conversationName: 'Peer', messageCount: 0, isSending: false, buzzBusy: false, onSend: jest.fn(async () => true) };
const message: ChatMessage = { id: 'message', conversationId: 'chat', senderId: 'peer', senderName: 'Peer', content: 'Hello',
  timestamp: '2026-11-21T00:00:00.000Z', type: 'text', deliveryStatus: 'sent' };
beforeEach(() => localStorage.clear());

test('pressing Enter in emoji search cannot submit the composer draft', () => {
  const send = jest.fn(async () => true); render(<MessageComposer {...props} onSend={send} />);
  const input = screen.getByRole('textbox', { name: 'Message to Peer' });
  fireEvent.change(input, { target: { value: 'Keep this unsent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  const search = screen.getByRole('searchbox', { name: 'Search emoji' });
  fireEvent.change(search, { target: { value: 'pizza' } });
  expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false);
  expect(send).not.toHaveBeenCalled(); expect(input).toHaveValue('Keep this unsent');
  expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
});

test('emoji insertion replaces the saved selection without losing text or cursor position', async () => {
  render(<MessageComposer {...props} />);
  const input = screen.getByRole('textbox', { name: 'Message to Peer' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Hello brave world\nNext line' } }); input.setSelectionRange(6, 11); input.focus();
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); expect(screen.getByRole('searchbox', { name: 'Search emoji' })).toHaveFocus();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'pizza' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert pizza 🍕' }));
  expect(input).toHaveValue('Hello 🍕 world\nNext line'); await waitFor(() => expect(input).toHaveFocus()); expect(input.selectionStart).toBe(8); expect(input.selectionEnd).toBe(8);
  expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'rocket' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert rocket 🚀' })); expect(input).toHaveValue('Hello 🍕🚀 world\nNext line');
});

test('search leaves the latest controlled draft intact and Escape restores composer focus', async () => {
  const change = jest.fn(); const { rerender } = render(<MessageComposer {...props} draftValue="Hello old" onDraftChange={change} />);
  const input = screen.getByRole('textbox', { name: 'Message to Peer' }) as HTMLTextAreaElement; input.setSelectionRange(6, 6);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  rerender(<MessageComposer {...props} draftValue="Hello fresh" onDraftChange={change} />);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'pizza' } }); fireEvent.click(screen.getByRole('button', { name: 'Insert pizza 🍕' }));
  expect(change).toHaveBeenCalledWith('Hello 🍕fresh'); await waitFor(() => expect(input).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search emoji' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument(); expect(input).toHaveFocus();
});

test('composer picker, reaction picker and message menu never overlap, including keyboard activation', () => {
  render(<><MessageList messages={[message]} currentUserId="self" onRetryMessage={jest.fn()} onTogglePin={jest.fn()} onToggleReaction={jest.fn()} /><MessageComposer {...props} /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument(); expect(screen.getByRole('menu', { name: 'Message actions' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'React to message' })); expect(screen.queryByRole('menu', { name: 'Message actions' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'More reactions' })); expect(screen.getByRole('dialog', { name: 'Choose a reaction' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); expect(screen.queryByRole('dialog', { name: 'Choose a reaction' })).not.toBeInTheDocument();
  fireEvent.pointerDown(document.body, { pointerType: 'touch' }); expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
});
