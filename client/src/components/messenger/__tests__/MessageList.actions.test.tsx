import { fireEvent, render, screen, within } from '@testing-library/react';
import { MessageList } from '../MessageList';
import type { MessageListProps } from '../MessageList';
import type { ChatMessage } from '@/messaging/messageModel';

const incoming: ChatMessage = { id: 'incoming', conversationId: 'conversation', senderId: 'peer', senderName: 'Peer',
  content: 'Incoming message', timestamp: '2026-11-10T12:00:00.000Z', type: 'text', deliveryStatus: 'delivered' };
const outgoing: ChatMessage = { ...incoming, id: 'outgoing', senderId: 'self', senderName: 'You', content: 'Outgoing message',
  encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: 'iv', ciphertext: 'ciphertext', scope: 'browser-demo' } };
const handlers = () => ({ onReplyMessage: jest.fn(), onEditMessage: jest.fn(), onDeleteMessage: jest.fn(),
  onTogglePin: jest.fn(), onToggleReaction: jest.fn(), onRetryMessage: jest.fn() });
const props = (overrides: Partial<MessageListProps> = {}): MessageListProps => ({
  messages: [incoming, outgoing], currentUserId: 'self', ...handlers(), ...overrides,
});
const row = (container: HTMLElement, id: string) => within(container.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!);

test('the active message renderer has compact icon controls and no duplicate inline toolbar', () => {
  const { container } = render(<MessageList {...props()} />);
  expect(container.querySelector('.message-actions-bar')).toBeNull();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  for (const id of ['incoming', 'outgoing']) {
    const controls = row(container, id);
    for (const name of ['React to message', 'Reply', 'More actions']) {
      expect(controls.getByRole('button', { name })).toHaveTextContent('');
      expect(controls.getByRole('button', { name }).querySelector('svg')).toBeInTheDocument();
    }
  }
  expect(screen.getByText('Encrypted locally')).toBeInTheDocument();
  expect(screen.queryByText('Edit', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText('Delete', { exact: true })).not.toBeInTheDocument();
});

test('incoming overflow permits pinning but reserves Edit and Delete for the message owner', () => {
  const callbacks = handlers(); const { container } = render(<MessageList {...props(callbacks)} />);
  fireEvent.click(row(container, 'incoming').getByRole('button', { name: 'More actions' }));
  expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
  expect(callbacks.onTogglePin).toHaveBeenCalledWith(incoming.id);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(row(container, 'outgoing').getByRole('button', { name: 'More actions' }));
  expect(screen.getAllByRole('menuitem').map((element) => element.textContent?.trim())).toEqual(['Pin', 'Edit', 'Delete']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(callbacks.onDeleteMessage).toHaveBeenCalledWith(outgoing.id);
});

test('reaction picker retains selection state, supports expanded reactions and forwards the original ID', () => {
  const callbacks = handlers(); const reacted = { ...incoming, reactions: [{ emoji: '👍', userIds: ['self'] }] };
  render(<MessageList {...props({ ...callbacks, messages: [reacted] })} />);
  const trigger = screen.getByRole('button', { name: 'React to message' });
  fireEvent.click(trigger);
  expect(screen.getByRole('menuitemcheckbox', { name: 'React 👍' })).toBeChecked();
  fireEvent.click(screen.getByRole('menuitem', { name: 'More reactions' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'React 🔥' }));
  expect(callbacks.onToggleReaction).toHaveBeenCalledWith(incoming.id, '🔥');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: '👍 1' }));
  expect(callbacks.onToggleReaction).toHaveBeenLastCalledWith(incoming.id, '👍');
});

test('only one popover is open; Escape restores focus and touch pointer outside dismisses it', () => {
  const { container } = render(<MessageList {...props()} />);
  const more = row(container, 'outgoing').getByRole('button', { name: 'More actions' });
  fireEvent.click(more);
  expect(screen.getByRole('menuitem', { name: 'Pin' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(more).toHaveFocus();
  fireEvent.click(more);
  fireEvent.click(row(container, 'incoming').getByRole('button', { name: 'React to message' }));
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  expect(screen.getByRole('menu', { name: 'Choose a reaction' })).toBeInTheDocument();
  fireEvent.pointerDown(document.body, { pointerType: 'touch' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('Reply and editing reuse existing callbacks; edit has accessible save/cancel controls', () => {
  const callbacks = handlers(); const { container } = render(<MessageList {...props(callbacks)} />);
  fireEvent.click(row(container, 'incoming').getByRole('button', { name: 'Reply' }));
  expect(callbacks.onReplyMessage).toHaveBeenCalledWith(incoming);
  fireEvent.click(row(container, 'outgoing').getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  const editor = screen.getByRole('textbox', { name: 'Edit message' });
  expect(editor).toHaveFocus();
  fireEvent.change(editor, { target: { value: 'Updated text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  expect(callbacks.onEditMessage).toHaveBeenCalledWith(outgoing.id, 'Updated text');
  fireEvent.click(row(container, 'outgoing').getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
  expect(callbacks.onEditMessage).toHaveBeenCalledTimes(1);
});

test('missing callbacks, deleted messages, and system/security notices do not acquire extra actions', () => {
  const retry = jest.fn();
  const { container } = render(<MessageList currentUserId="self" onRetryMessage={retry} messages={[
    { ...outgoing, isDeleted: true }, { ...incoming, type: 'system' }, { ...incoming, id: 'security', type: 'security_alert' },
  ]} />);
  expect(container.querySelectorAll('.msg-toolbar button')).toHaveLength(0);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('disabled conversation controls keep toolbar and open-menu actions disabled', () => {
  const callbacks = handlers();
  const element = (disabled: boolean) => <fieldset disabled={disabled}><MessageList {...props(callbacks)} /></fieldset>;
  const { rerender } = render(element(false));
  fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[1]!);
  rerender(element(true));
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
  // Native activation honors disabled fieldsets; dispatchEvent bypasses that browser check.
  screen.getByRole('menuitem', { name: 'Delete' }).click();
  expect(callbacks.onDeleteMessage).not.toHaveBeenCalled();
});

test('external deletion, hidden conversation, scroll and resize dismiss stale popovers', () => {
  const initial = props({ messages: [outgoing] });
  const { rerender } = render(<MessageList {...initial} />);
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  open(); fireEvent.scroll(screen.getByRole('log')); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  open(); fireEvent.resize(window); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  open(); rerender(<MessageList {...initial} active={false} />); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  rerender(<MessageList {...initial} />);
  open(); rerender(<MessageList {...initial} messages={[{ ...outgoing, isDeleted: true }]} />);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(screen.getByRole('log')).toHaveFocus();
});
