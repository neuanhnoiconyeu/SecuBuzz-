import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ForwardDialog } from '../ForwardDialog';
import type { ChatMessage } from '@/messaging/messageModel';

const message: ChatMessage = { id: 'source', conversationId: 'origin', senderId: 'peer', senderName: 'Peer',
  content: 'Keep this message', timestamp: '2026-11-21T00:00:00.000Z', type: 'text', deliveryStatus: 'sent' };
const conversations = [{ id: 'a', displayName: 'Alice' }, { id: 'b', displayName: 'Bob' }, { id: 'c', displayName: 'Carol' },
  { id: 'd', displayName: 'Dan' }, { id: 'e', displayName: 'Eve' }, { id: 'f', displayName: 'Frank' }];
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterAll(() => {
  for (const [name, descriptor] of [['showModal', originalShowModal], ['close', originalClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

test('partial results clearly identify a failed note and retry only failed recipients with the same operation', async () => {
  const close = jest.fn(), confirm = jest.fn().mockResolvedValueOnce({ failed: ['b'], noteFailed: ['b'] }).mockResolvedValue({ failed: [] });
  render(<ForwardDialog message={message} conversations={conversations} onClose={close} onConfirm={confirm} />);
  fireEvent.click(screen.getByRole('button', { name: 'Alice' })); fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Optional message' }), { target: { value: 'Note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send (2)' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('forwarded to Bob, but the optional note was not sent');
  expect(close).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Alice Sent' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Optional message' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(confirm.mock.calls[0]!.slice(0, 2)).toEqual([['a', 'b'], 'Note']);
  expect(confirm.mock.calls[1]).toEqual([['b'], 'Note', confirm.mock.calls[0]![2]]);
});

test('recipient search and the five-recipient limit remain available', () => {
  render(<ForwardDialog message={message} conversations={conversations} onClose={jest.fn()} onConfirm={jest.fn()} />);
  for (const person of conversations) fireEvent.click(screen.getByRole('button', { name: person.displayName }));
  expect(screen.getByRole('button', { name: 'Send (5)' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Frank' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search conversations' }), { target: { value: 'bob' } });
  expect(screen.getByRole('button', { name: 'Bob' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Alice' })).not.toBeInTheDocument();
});

test('a new dialog gets a fresh operation and unexpected errors preserve the pending selection', async () => {
  const confirm = jest.fn().mockRejectedValueOnce(new Error('Internal detail')).mockResolvedValue({ failed: [] });
  const props = { conversations, onClose: jest.fn(), onConfirm: confirm };
  const { rerender } = render(<ForwardDialog {...props} message={message} />);
  fireEvent.click(screen.getByRole('button', { name: 'Alice' })); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Retry to resume');
  expect(screen.queryByText('Internal detail')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Alice' })).toHaveAttribute('aria-pressed', 'true');
  const operation = confirm.mock.calls[0]![2];
  rerender(<ForwardDialog {...props} message={null} />); rerender(<ForwardDialog {...props} message={message} />);
  fireEvent.click(screen.getByRole('button', { name: 'Alice' })); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
  expect(confirm.mock.calls[1]![2]).not.toBe(operation);
});

test('pending forwarding locks submission, recipient changes, closing and native Escape', async () => {
  let finish!: (value: { failed: string[] }) => void;
  const confirm = jest.fn(() => new Promise<{ failed: string[] }>(resolve => { finish = resolve; }));
  const close = jest.fn();
  render(<ForwardDialog message={message} conversations={conversations} onClose={close} onConfirm={confirm} />);
  fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
  const send = screen.getByRole('button', { name: 'Send' }); fireEvent.click(send); fireEvent.click(send);
  expect(confirm).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Bob' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  const cancel = new Event('cancel', { cancelable: true }); fireEvent(screen.getByRole('dialog'), cancel); expect(cancel.defaultPrevented).toBe(true);
  await act(async () => finish({ failed: [] })); expect(close).toHaveBeenCalledTimes(1);
});
