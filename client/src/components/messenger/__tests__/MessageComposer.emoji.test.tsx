import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  expect(input).toHaveValue('Hello 🍕 world\nNext line'); await waitFor(() => expect(input.selectionStart).toBe(8)); expect(input.selectionEnd).toBe(8);
  expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument(); expect(input).not.toHaveFocus();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'rocket' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert rocket 🚀' })); expect(input).toHaveValue('Hello 🍕🚀 world\nNext line');
  expect(input.selectionStart).toBe(10); expect(input.selectionEnd).toBe(10);
  fireEvent.click(screen.getByRole('button', { name: 'Insert rocket 🚀' })); expect(input).toHaveValue('Hello 🍕🚀🚀 world\nNext line');
  expect(input.selectionStart).toBe(12); expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
});

test('search leaves the latest controlled draft intact and Escape restores composer focus', async () => {
  const change = jest.fn(); const { rerender } = render(<MessageComposer {...props} draftValue="Hello old" onDraftChange={change} />);
  const input = screen.getByRole('textbox', { name: 'Message to Peer' }) as HTMLTextAreaElement; input.setSelectionRange(6, 6);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  rerender(<MessageComposer {...props} draftValue="Hello fresh" onDraftChange={change} />);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'pizza' } }); fireEvent.click(screen.getByRole('button', { name: 'Insert pizza 🍕' }));
  expect(change).toHaveBeenCalledWith('Hello 🍕fresh'); expect(input).not.toHaveFocus();
  fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search emoji' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument(); expect(input).toHaveFocus();
});

test('controlled drafts accept rapid repeated selections without losing Unicode or other text', () => {
  const send = jest.fn(async () => true);
  function Controlled() { const [draft, setDraft] = useState('A 👩🏽‍💻 B'); return <MessageComposer {...props} onSend={send} draftValue={draft} onDraftChange={setDraft} />; }
  render(<Controlled />);
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Peer' }); input.setSelectionRange(2, 2);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'pizza' } });
  const emoji = screen.getByRole('button', { name: 'Insert pizza 🍕' });
  act(() => { fireEvent.click(emoji); fireEvent.click(emoji); fireEvent.click(emoji); });
  expect(input).toHaveValue('A 🍕🍕🍕👩🏽‍💻 B'); expect(input.selectionStart).toBe(8); expect(input.selectionEnd).toBe(8);
  expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument(); expect(send).not.toHaveBeenCalled();
});

test('selection keeps category, scroll and keyboard focus; the trigger does not close or reset insertion', () => {
  render(<MessageComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  const grid = screen.getByRole('tabpanel', { name: 'Smileys' }); grid.scrollTop = 120;
  const choices = within(grid).getAllByRole('button'); choices[0]!.focus(); fireEvent.click(choices[0]!);
  expect(choices[0]).toHaveFocus(); expect(grid.scrollTop).toBe(120);
  fireEvent.keyDown(choices[0]!, { key: 'ArrowRight' }); expect(choices[1]).toHaveFocus(); fireEvent.click(choices[1]!);
  expect(choices[1]).toHaveFocus(); expect(screen.getByRole('tab', { name: 'Smileys' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument(); expect(screen.getByRole('searchbox')).toHaveFocus();
});

test('Close and Escape restore the insertion caret; outside touch and focus dismiss without erasing the draft', () => {
  render(<><MessageComposer {...props} /><button>Outside control</button></>);
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Peer' });
  fireEvent.change(input, { target: { value: 'Before after' } }); input.setSelectionRange(7, 7);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'pizza' } }); fireEvent.click(screen.getByRole('button', { name: 'Insert pizza 🍕' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close emoji picker' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(input).toHaveFocus(); expect(input.selectionStart).toBe(9);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(input).toHaveFocus(); expect(input.selectionStart).toBe(9);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); fireEvent.pointerDown(document.body, { pointerType: 'touch' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); act(() => screen.getByRole('button', { name: 'Outside control' }).focus());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(input).toHaveValue('Before 🍕after');
});

test.each(['accepted', 'declined', 'error'] as const)('%s sending closes only on success and never loses a failed-send draft', async result => {
  let resolve!: (value: boolean) => void, reject!: (error: Error) => void;
  const send = jest.fn(() => new Promise<boolean>((done, fail) => { resolve = done; reject = fail; }));
  const view = render(<MessageComposer {...props} onSend={send} />);
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Peer' }); fireEvent.change(input, { target: { value: 'Keep this draft' } }); input.setSelectionRange(15, 15);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'pizza' } }); fireEvent.click(screen.getByRole('button', { name: 'Insert pizza 🍕' }));
  // No outside click: a programmatic/keyboard submission must not preempt confirmation.
  fireEvent.submit(screen.getByRole('form', { name: 'Message composer for Peer' }));
  view.rerender(<MessageComposer {...props} onSend={send} isSending disabled />);
  expect(screen.getByRole('dialog')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Insert pizza 🍕' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Close emoji picker' })).toBeEnabled(); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { if (result === 'error') reject(new Error('Synthetic failure')); else resolve(result === 'accepted'); });
  view.rerender(<MessageComposer {...props} onSend={send} />);
  if (result === 'accepted') { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(input).toHaveValue(''); }
  else { expect(screen.getByRole('dialog')).toBeInTheDocument(); expect(screen.getByRole('searchbox')).toHaveValue('pizza'); expect(input).toHaveValue('Keep this draft🍕'); expect(screen.getByRole('alert')).toHaveTextContent('draft is still here'); }
});

test('conversation changes, hiding and unmounting remove the popup and its event listeners', () => {
  const view = render(<MessageComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); view.rerender(<MessageComposer {...props} conversationName="Another peer" />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); view.rerender(<MessageComposer {...props} conversationName="Another peer" active={false} />);
  expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
  view.rerender(<MessageComposer {...props} conversationName="Another peer" active />); fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' })); view.unmount();
  expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(); expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
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
