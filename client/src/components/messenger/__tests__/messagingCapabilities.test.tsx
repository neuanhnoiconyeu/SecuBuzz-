import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessageComposer } from '../MessageComposer';
import { MessageList } from '../MessageList';
import { DEMO_MESSAGING_CAPABILITIES, REAL_ACCOUNT_MESSAGING_CAPABILITIES } from '@/messaging/messagingCapabilities';
import type { ChatMessage } from '@/messaging/messageModel';

const message: ChatMessage = { id: 'message', conversationId: 'chat', senderId: 'self', senderName: 'You',
  content: 'Keep this message', timestamp: '2026-11-21T00:00:00.000Z', type: 'text', deliveryStatus: 'sent' };
const composer = { conversationName: 'Peer', messageCount: 0, isSending: false, buzzBusy: false };

test('the real-account profile prevents unsupported actions even if callbacks are supplied', () => {
  const callbacks = { onReplyMessage: jest.fn(), onForwardMessage: jest.fn(), onEditMessage: jest.fn(),
    onDeleteMessage: jest.fn(), onUnsendMessage: jest.fn(), onTogglePin: jest.fn(), onToggleReaction: jest.fn() };
  const { container } = render(<MessageList messages={[
    { ...message, isPinned: true, reactions: [{ emoji: '👍', userIds: ['peer'] }] },
    { ...message, id: 'incoming', senderId: 'peer' },
  ]} currentUserId="self" transportMode="realtime" capabilities={{...REAL_ACCOUNT_MESSAGING_CAPABILITIES,edit:false}} onRetryMessage={jest.fn()} {...callbacks} />);
  expect(container.querySelectorAll('.msg-toolbar button')).toHaveLength(6);
  fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
  expect(screen.getAllByRole('menuitem').map(item => item.textContent?.trim())).toEqual(['Forward', 'Unpin', 'Delete for me', 'Unsend']);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  expect(screen.getByRole('button', { name: '👍 1' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '👍 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'View pinned messages' }));
  expect(within(screen.getByRole('region', { name: 'Pinned messages' })).getByRole('button', { name: /Unpin/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Unpin' })).toBeEnabled();
  expect(callbacks.onToggleReaction).toHaveBeenCalledWith(message.id,'👍');
  Object.entries(callbacks).filter(([name])=>name!=='onToggleReaction').forEach(([,callback])=>expect(callback).not.toHaveBeenCalled());
});

test('capabilities narrow actions independently without overriding per-message eligibility', () => {
  const onForwardMessage = jest.fn(), onEditMessage = jest.fn();
  render(<MessageList messages={[message]} currentUserId="self" onRetryMessage={jest.fn()}
    capabilities={{ ...REAL_ACCOUNT_MESSAGING_CAPABILITIES, forward: true, edit: true, pin: false }} canEditMessage={false}
    onForwardMessage={onForwardMessage} onEditMessage={onEditMessage} onTogglePin={jest.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Forward' }));
  expect(onForwardMessage).toHaveBeenCalledWith(message);
  expect(onEditMessage).not.toHaveBeenCalled();
});

test('disabling Edit during a transport change closes an editor and cannot submit its draft', () => {
  const onEditMessage = jest.fn(), content = 'Original first line 👩🏽‍💻\nTiếng Việt 🇻🇳';
  const props = { messages: [{ ...message, content }], currentUserId: 'self', onRetryMessage: jest.fn(), onEditMessage };
  const view = render(<MessageList {...props} capabilities={DEMO_MESSAGING_CAPABILITIES} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  expect(screen.getByRole('textbox', { name: 'Edit message' })).toHaveValue(content);
  fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'An unsaved draft\nSecond line' } });
  view.rerender(<MessageList {...props} transportMode="realtime" capabilities={{...REAL_ACCOUNT_MESSAGING_CAPABILITIES,edit:false}} />);
  expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save edit' })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
  expect(view.container.querySelector('.message-text')?.textContent).toBe(content);
  expect(onEditMessage).not.toHaveBeenCalled();
});

test('retry availability requires both transport support and pending-message eligibility', () => {
  const onRetryMessage = jest.fn();
  const props = { messages: [{ ...message, deliveryStatus: 'failed' as const }], currentUserId: 'self', onRetryMessage };
  const view = render(<MessageList {...props} capabilities={REAL_ACCOUNT_MESSAGING_CAPABILITIES} canRetryMessage={() => false} />);
  expect(screen.getByRole('button', { name: 'Retry unavailable' })).toBeDisabled();
  view.rerender(<MessageList {...props} capabilities={{ ...REAL_ACCOUNT_MESSAGING_CAPABILITIES, retryMessages: false }} canRetryMessage={() => true} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry unavailable' })); expect(onRetryMessage).not.toHaveBeenCalled();
  view.rerender(<MessageList {...props} capabilities={REAL_ACCOUNT_MESSAGING_CAPABILITIES} canRetryMessage={() => true} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(onRetryMessage).toHaveBeenCalledWith(message.id);
});

test.each(['profile', 'textOnly'] as const)('%s prevents dropped files from becoming unencrypted local attachments', async mode => {
  const uploadAttachment = jest.fn(), onSend = jest.fn(async () => true);
  render(<MessageComposer {...composer} onSend={onSend} onBuzz={jest.fn()} uploadAttachment={uploadAttachment}
    droppedFiles={[new File(['private'], 'private.txt', { type: 'text/plain' })]}
    {...(mode === 'profile' ? { capabilities: {...REAL_ACCOUNT_MESSAGING_CAPABILITIES,attachments:false,voiceMessages:false} } : { textOnly: true })} />);
  expect(screen.queryByRole('button', { name: 'Attach files or images' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Record voice message' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send BUZZ alert' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Insert emoji' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Text only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('Text only'));
  expect(uploadAttachment).not.toHaveBeenCalled();
  expect(screen.queryByText('private.txt')).not.toBeInTheDocument();
});

test('changing capabilities closes the emoji picker and prevents form and keyboard sends without losing text', () => {
  const onSend = jest.fn(async () => true);
  const view = render(<MessageComposer {...composer} onSend={onSend} capabilities={REAL_ACCOUNT_MESSAGING_CAPABILITIES} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
  view.rerender(<MessageComposer {...composer} onSend={onSend} capabilities={{ ...REAL_ACCOUNT_MESSAGING_CAPABILITIES, emoji: false, sendMessages: false }} />);
  expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Insert emoji' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  fireEvent.submit(screen.getByRole('form'));
  expect(onSend).not.toHaveBeenCalled(); expect(screen.getByRole('textbox')).toHaveValue('Keep my draft');
});

test('demo controls retain their existing defaults', () => {
  render(<MessageComposer {...composer} onSend={jest.fn()} onBuzz={jest.fn()} />);
  for (const name of ['Insert emoji', 'Attach files or images', 'Record voice message', 'Send BUZZ alert']) {
    expect(screen.getByRole('button', { name })).toBeEnabled();
  }
  expect(Object.isFrozen(DEMO_MESSAGING_CAPABILITIES)).toBe(true);
  expect(Object.isFrozen(REAL_ACCOUNT_MESSAGING_CAPABILITIES)).toBe(true);
});
