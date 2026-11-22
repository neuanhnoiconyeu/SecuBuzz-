import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import YahooChatWindow from './YahooChatWindow';
import type { OutboundMessage } from '@/messaging/messageModel';
import { QUICK_EMOJIS } from './messenger/emojiData';

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});
afterAll(() => {
  for (const [name, descriptor] of [['showModal', originalShowModal], ['close', originalClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

function transport() {
  return { mode: 'local-demo' as const, connect: async () => {}, disconnect: async () => {},
    sendMessage: jest.fn(async (_message: OutboundMessage) => {}), editMessage: jest.fn(async () => {}),
    deleteMessage: jest.fn(async (_conversationId: string, _messageId: string) => {}), subscribeToConversation: () => () => {} };
}

test('existing reply sending and cancellation survive navigation and multiline editing in the composed demo chat', async () => {
  const local = transport();
  const { container } = render(<YahooChatWindow conversationId="origin" transport={local} />);
  const composer = screen.getByRole('textbox');
  await waitFor(() => expect(composer).toBeEnabled());
  fireEvent.change(composer, { target: { value: 'First line\nSecond line' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(local.sendMessage).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(composer).toHaveValue(''));
  const original = container.querySelector<HTMLElement>(`[data-message-id="${local.sendMessage.mock.calls[0]![0].id}"]`)!;
  fireEvent.click(within(original).getByRole('button', { name: 'Reply' }));
  expect(screen.getByRole('button', { name: 'Cancel reply' })).toBeInTheDocument();
  fireEvent.change(composer, { target: { value: 'My reply' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const quote = await screen.findByRole('button', { name: 'Go to original message from You' });
  expect(screen.queryByRole('button', { name: 'Cancel reply' })).not.toBeInTheDocument();
  original.scrollIntoView = jest.fn(); fireEvent.click(quote);
  expect(original).toHaveAttribute('data-message-highlighted', 'true'); expect(original).toHaveFocus();
  fireEvent.click(within(original).getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  const editor = screen.getByRole('textbox', { name: 'Edit message' }); expect(editor).toHaveValue('First line\nSecond line');
  fireEvent.change(editor, { target: { value: '\nUpdated\n\nSecond line\n' } }); fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument());
  expect(original.querySelector('.message-bubble')?.textContent).toBe('\nUpdated\n\nSecond line\n');
  expect(within(original).getByText('(edited)')).toBeInTheDocument();
  fireEvent.click(within(original).getByRole('button', { name: 'Reply' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
  expect(screen.queryByRole('button', { name: 'Cancel reply' })).not.toBeInTheDocument();
  expect(container.querySelectorAll('[data-message-id]')).toHaveLength(2);
});

test('forward dialog retries the failed note through the composed chat without forwarding its message again', async () => {
  const local = transport();
  render(<YahooChatWindow conversationId="origin" transport={local} forwardTargets={[{ id: 'a', displayName: 'Alice' }]} />);
  const composer = screen.getByRole('textbox'); await waitFor(() => expect(composer).toBeEnabled());
  fireEvent.change(composer, { target: { value: 'Forward me' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(composer).toHaveValue(''));
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Forward' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Forward to' }));
  fireEvent.click(dialog.getByRole('button', { name: 'Alice' })); fireEvent.change(dialog.getByRole('textbox', { name: 'Optional message' }), { target: { value: 'Keep this note' } });
  local.sendMessage.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Note failed'));
  fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
  expect(await dialog.findByRole('alert')).toHaveTextContent('optional note was not confirmed');
  const note = local.sendMessage.mock.calls[2]![0];
  fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Forward to' })).not.toBeInTheDocument());
  expect(local.sendMessage).toHaveBeenCalledTimes(4); expect(local.sendMessage.mock.calls[3]![0]).toEqual(note);
});

test('composed demo chat replaces reactions and preserves a pinned message until Unsend succeeds', async () => {
  const local = transport();
  const { container } = render(<YahooChatWindow conversationId="origin" transport={local} />);
  const composer = screen.getByRole('textbox'); await waitFor(() => expect(composer).toBeEnabled());
  fireEvent.change(composer, { target: { value: 'Keep until confirmed' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(composer).toHaveValue(''));
  const id = local.sendMessage.mock.calls[0]![0].id;
  const original = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
  const react = (emoji: string) => {
    fireEvent.click(within(original).getByRole('button', { name: 'React to message' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: `React ${emoji}` }));
  };
  react(QUICK_EMOJIS[0]!); react(QUICK_EMOJIS[1]!);
  expect(within(original).queryByRole('button', { name: `${QUICK_EMOJIS[0]} 1` })).not.toBeInTheDocument();
  const reaction = within(original).getByRole('button', { name: `${QUICK_EMOJIS[1]} 1` }); expect(reaction).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(reaction); expect(original.querySelector('.rx-summary')).not.toBeInTheDocument();
  react(QUICK_EMOJIS[0]!);
  fireEvent.click(within(original).getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
  expect(screen.getByText('Pinned (1):')).toBeInTheDocument();
  fireEvent.click(within(original).getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Unsend' }));
  local.deleteMessage.mockRejectedValueOnce(new Error('Backend detail'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your message is unchanged');
  expect(original.querySelector('.message-bubble')?.textContent).toBe('Keep until confirmed');
  expect(screen.getByText('Pinned (1):')).toBeInTheDocument(); expect(original.querySelector('.rx-summary')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(original.querySelector('.message-bubble')?.textContent).toBe('This message was deleted.');
  expect(screen.queryByText('Pinned (1):')).not.toBeInTheDocument(); expect(original.querySelector('.rx-summary')).not.toBeInTheDocument();
  expect(local.deleteMessage).toHaveBeenCalledTimes(2); expect(local.deleteMessage).toHaveBeenLastCalledWith('origin', id);
});

test('Delete for Me removes an outgoing message locally without invoking Unsend', async () => {
  const local = transport(); render(<YahooChatWindow conversationId="origin" transport={local} />);
  const composer = screen.getByRole('textbox'); await waitFor(() => expect(composer).toBeEnabled());
  fireEvent.change(composer, { target: { value: 'Remove only here' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(composer).toHaveValue(''));
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Unsend' }));
  fireEvent.click(screen.getByRole('radio', { name: /Delete for me/ })); fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByText('Remove only here')).not.toBeInTheDocument(); expect(local.deleteMessage).not.toHaveBeenCalled();
});

test('the legacy realtime view does not expose local-only pin, reaction, deletion or edit controls', async () => {
  const realtime = { ...transport(), mode: 'realtime' as const };
  render(<YahooChatWindow conversationId="origin" transport={realtime} />);
  const composer = screen.getByRole('textbox'); await waitFor(() => expect(composer).toBeEnabled());
  fireEvent.change(composer, { target: { value: 'Real transport preview' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(composer).toHaveValue(''));
  expect(screen.queryByRole('button', { name: 'React to message' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument(); expect(realtime.deleteMessage).not.toHaveBeenCalled();
});
