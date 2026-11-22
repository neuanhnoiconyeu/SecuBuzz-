import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

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

test('incoming overflow permits local removal; only the owner can edit or open the unsend review', async () => {
  const callbacks = handlers(); const { container } = render(<MessageList {...props(callbacks)} />);
  fireEvent.click(row(container, 'incoming').getByRole('button', { name: 'More actions' }));
  expect(screen.getAllByRole('menuitem').map(element => element.textContent?.trim())).toEqual(['Pin', 'Delete for me']);
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Unsend' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
  expect(callbacks.onTogglePin).toHaveBeenCalledWith(incoming.id);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(row(container, 'outgoing').getByRole('button', { name: 'More actions' }));
  expect(screen.getAllByRole('menuitem').map((element) => element.textContent?.trim())).toEqual(['Pin', 'Edit', 'Delete for me']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete for me' }));
  expect(callbacks.onDeleteMessage).not.toHaveBeenCalled();
  const review = within(screen.getByRole('dialog'));
  expect(review.queryByRole('radio', { name: /Unsend for everyone/ })).not.toBeInTheDocument();
  expect(review.getByRole('radio', { name: /Delete for me/ })).toBeChecked();
  fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  expect(callbacks.onDeleteMessage).toHaveBeenCalledWith(outgoing.id);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('reaction picker retains selection state, supports expanded reactions and forwards the original ID', () => {
  const callbacks = handlers(); const reacted = { ...incoming, reactions: [{ emoji: '👍', userIds: ['self'] }] };
  render(<MessageList {...props({ ...callbacks, messages: [reacted] })} />);
  const trigger = screen.getByRole('button', { name: 'React to message' });
  fireEvent.click(trigger);
  expect(screen.getByRole('menuitemcheckbox', { name: 'React 👍' })).toBeChecked();
  fireEvent.click(screen.getByRole('menuitem', { name: 'More reactions' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'fire' } });
  fireEvent.click(screen.getByRole('button', { name: 'React with fire 🔥' }));
  expect(callbacks.onToggleReaction).toHaveBeenCalledWith(incoming.id, '🔥');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: '👍 1' }));
  expect(callbacks.onToggleReaction).toHaveBeenLastCalledWith(incoming.id, '👍');
});

test('server-backed unpin waits for confirmation, blocks duplicate clicks and preserves the pin on failure', async () => {
  let fail!: (reason: Error) => void;
  const onTogglePin = jest.fn(() => new Promise<boolean>((_resolve, reject) => { fail = reject; }));
  render(<MessageList {...props({ messages: [{ ...outgoing, isPinned: true }], onTogglePin })} transportMode="realtime" />);
  const unpin = screen.getByRole('button', { name: 'Unpin' });
  fireEvent.click(unpin); fireEvent.click(unpin);
  expect(onTogglePin).toHaveBeenCalledTimes(1); expect(unpin).toBeDisabled(); expect(screen.getByText('Pinned (1):')).toBeInTheDocument();
  await act(async () => { fail(new Error('Service unavailable')); });
  expect(screen.getByRole('alert')).toHaveTextContent('Could not update pinned messages');
  expect(unpin).toBeEnabled(); expect(screen.getByText('Pinned (1):')).toBeInTheDocument();
});

test('authenticated reactions preserve counts while saving, block duplicates and report failures',async()=>{
  let fail!:(e:Error)=>void;const onToggleReaction=jest.fn(()=>new Promise<boolean>((_resolve,reject)=>{fail=reject;}));
  render(<MessageList {...props({messages:[{...incoming,reactions:[{emoji:'👍',userIds:['self','peer']}]}],onToggleReaction})} transportMode="realtime"/>);
  const badge=screen.getByRole('button',{name:'👍 2'});fireEvent.click(badge);fireEvent.click(badge);
  expect(onToggleReaction).toHaveBeenCalledTimes(1);expect(badge).toBeDisabled();expect(badge).toHaveTextContent('2');
  await act(async()=>{fail(new Error('Unavailable'));});expect(screen.getByRole('alert')).toHaveTextContent('previous reaction is unchanged');expect(badge).toBeEnabled();
});

test.each(['body','draft'])('async reaction focus restoration respects the current focus: %s',async focus=>{
  let finish!:(value:boolean)=>void;const onToggleReaction=jest.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  render(<><MessageList {...props({messages:[incoming],onToggleReaction})} transportMode="realtime"/><input aria-label="Next draft"/></>);
  const trigger=screen.getByRole('button',{name:'React to message'});trigger.focus();fireEvent.click(trigger);fireEvent.click(screen.getByRole('menuitemcheckbox',{name:'React 👍'}));
  expect(trigger).toBeDisabled();trigger.blur();
  const draft=screen.getByRole('textbox',{name:'Next draft'});if(focus==='draft')draft.focus();
  await act(async()=>{finish(true);});
  if(focus==='body')await waitFor(()=>expect(trigger).toHaveFocus());else{await new Promise(resolve=>setTimeout(resolve,30));expect(draft).toHaveFocus();}
});

test('only one popover is open; Escape restores focus and touch pointer outside dismisses it', () => {
  const { container } = render(<MessageList {...props()} />);
  const more = row(container, 'outgoing').getByRole('button', { name: 'More actions' });
  fireEvent.click(more);
  expect(screen.getByRole('menuitem', { name: 'Pin' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(screen.getByRole('menuitem', { name: 'Delete for me' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(more).toHaveFocus();
  fireEvent.click(more);
  fireEvent.click(row(container, 'incoming').getByRole('button', { name: 'React to message' }));
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  expect(screen.getByRole('menu', { name: 'Choose a reaction' })).toBeInTheDocument();
  fireEvent.pointerDown(document.body, { pointerType: 'touch' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('Reply and editing reuse existing callbacks; edit has accessible save/cancel controls', async () => {
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
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument());
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
  expect(screen.getByRole('menuitem', { name: 'Delete for me' })).toBeDisabled();
  // Native activation honors disabled fieldsets; dispatchEvent bypasses that browser check.
  screen.getByRole('menuitem', { name: 'Delete for me' }).click();
  expect(callbacks.onDeleteMessage).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

test('reply preview scrolls to, focuses and temporarily highlights the original message', () => {
  jest.useFakeTimers();
  const reply: ChatMessage = { ...outgoing, id: 'reply', replyTo: {
    messageId: incoming.id, senderName: incoming.senderName, contentSnippet: incoming.content,
  } };
  const { container, unmount } = render(<MessageList {...props({ messages: [incoming, reply] })} />);
  try {
    const original = container.querySelector<HTMLElement>('[data-message-id="incoming"]')!;
    const scroll = jest.fn(); original.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole('button', { name: 'Go to original message from Peer' }));
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
    expect(original).toHaveFocus(); expect(original).toHaveAttribute('data-message-highlighted', 'true');
    act(() => jest.advanceTimersByTime(2000));
    expect(original).not.toHaveAttribute('data-message-highlighted');
  } finally { unmount(); jest.useRealTimers(); }
});

test.each(['deleted', 'unavailable'] as const)('reply handles an %s original without showing its stale snippet', state => {
  const reply: ChatMessage = { ...outgoing, id: 'reply', replyTo: {
    messageId: incoming.id, senderName: incoming.senderName, contentSnippet: 'Old private snippet',
  } };
  const { container } = render(<MessageList {...props({ messages: state === 'deleted' ? [{ ...incoming, isDeleted: true }, reply] : [reply] })} />);
  expect(screen.queryByText('Old private snippet')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Go to original message from Peer' }));
  expect(screen.getByRole('status')).toHaveTextContent(state === 'deleted' ? 'The original message was deleted.' : 'unavailable in the loaded history');
  expect(container.querySelector('[data-message-highlighted]')).not.toBeInTheDocument();
});

test('multiline editing retains blank lines and uses explicit Save or Ctrl+Enter', async () => {
  const original = { ...outgoing, content: '\nFirst line\n\nLast line\n' };
  const edited = '\nUpdated first line\n\nLast line\n';
  const edit = jest.fn(async () => true);
  const { container, rerender } = render(<MessageList {...props({ messages: [original], onEditMessage: edit })} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  const editor = screen.getByRole('textbox', { name: 'Edit message' });
  expect(editor.tagName).toBe('TEXTAREA'); expect(editor).toHaveValue(original.content);
  fireEvent.change(editor, { target: { value: edited } });
  fireEvent.keyDown(editor, { key: 'Enter' }); expect(edit).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument());
  expect(edit).toHaveBeenCalledWith(original.id, edited);
  rerender(<MessageList {...props({ messages: [{ ...original, content: edited, isEdited: true }], onEditMessage: edit })} />);
  expect(container.querySelector('[data-message-id="outgoing"] .message-bubble')?.textContent).toBe(edited);
  expect(screen.getByText('(edited)')).toBeInTheDocument();
});

test('Cancel discards multiline edits and failed Save preserves the editor draft', async () => {
  const edit = jest.fn(async () => false);
  render(<MessageList {...props({ onEditMessage: edit })} />);
  const open = () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[1]!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  };
  open(); fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), { target: { value: 'New\nlines' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
  expect(edit).not.toHaveBeenCalled(); expect(screen.getByText(outgoing.content)).toBeInTheDocument();
  open(); const editor = screen.getByRole('textbox', { name: 'Edit message' });
  expect(editor).toHaveValue(outgoing.content);
  fireEvent.change(editor, { target: { value: 'Keep\nthis draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('original message is unchanged');
  expect(editor).toHaveValue('Keep\nthis draft');
});

test('pending edits cannot be submitted twice and rejected saves show a safe error', async () => {
  let reject!: (error: Error) => void;
  const edit = jest.fn(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
  render(<MessageList {...props({ messages: [outgoing], onEditMessage: edit })} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  const editor = screen.getByRole('textbox', { name: 'Edit message' });
  fireEvent.change(editor, { target: { value: 'Changed\nmessage' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true }); expect(edit).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Raw transport error')));
  expect(screen.getByRole('alert')).toHaveTextContent('original message is unchanged');
  expect(screen.queryByText('Raw transport error')).not.toBeInTheDocument(); expect(editor).toHaveValue('Changed\nmessage');
});

test.each(['unsupported', 'sending', 'failed'] as const)('Edit remains unavailable when %s', state => {
  render(<MessageList {...props({ messages: [{ ...outgoing, ...(state !== 'unsupported' ? { deliveryStatus: state } : {}) }], canEditMessage: state !== 'unsupported' })} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
});

test('Unsend awaits confirmation, prevents duplicate submissions and preserves the message on failure', async () => {
  let finish!: (success: boolean) => void;
  const unsend = jest.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<MessageList {...props({ messages: [outgoing], onUnsendMessage: unsend })} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Unsend' }));
  const review = within(screen.getByRole('dialog'));
  expect(review.getByRole('radio', { name: /Unsend for everyone/ })).toBeChecked();
  fireEvent.click(review.getByRole('button', { name: 'Remove' })); fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  expect(unsend).toHaveBeenCalledTimes(1); expect(screen.getByText(outgoing.content)).toBeInTheDocument();
  expect(review.getByRole('button', { name: 'Cancel' })).toBeDisabled(); expect(review.getByRole('radio', { name: /Delete for me/ })).toBeDisabled();
  const cancel = new Event('cancel', { cancelable: true }); fireEvent(screen.getByRole('dialog'), cancel); expect(cancel.defaultPrevented).toBe(true);
  expect(screen.queryByText('Message unsent in this local demo only.')).not.toBeInTheDocument();
  await act(async () => finish(false));
  expect(review.getByRole('alert')).toHaveTextContent('Your message is unchanged. Try again.');
  expect(screen.getByText(outgoing.content)).toBeInTheDocument();
  fireEvent.click(review.getByRole('button', { name: 'Remove' })); await act(async () => finish(true));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent('local demo only');
});

test('an authoritative realtime tombstone arriving while confirmation is open closes idempotently without another request', async () => {
  const unsend = jest.fn(), initial = props({ messages: [outgoing], transportMode: 'realtime', onUnsendMessage: unsend });
  const view = render(<MessageList {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Unsend' }));
  view.rerender(<MessageList {...initial} messages={[{ ...outgoing, isDeleted: true, content: 'Message deleted' }]} />);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(unsend).not.toHaveBeenCalled(); expect(screen.getByText('Message unsent for everyone.')).toBeInTheDocument();
});

test('an incoming message exposes Delete for me when it is its only capability, and reports asynchronous failure safely', async () => {
  const remove = jest.fn(async () => { throw new Error('Private backend details'); });
  render(<MessageList messages={[incoming]} currentUserId="self" onRetryMessage={jest.fn()} onDeleteMessage={remove} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete for me' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your message is unchanged');
  expect(screen.getByText(incoming.content)).toBeInTheDocument(); expect(screen.queryByText('Private backend details')).not.toBeInTheDocument();
});

test('an outgoing message with only Unsend support has a menu and no unsupported Delete-for-me option', async () => {
  render(<MessageList messages={[outgoing]} currentUserId="self" onRetryMessage={jest.fn()} onUnsendMessage={async () => false} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Unsend' }));
  expect(screen.getByRole('radio', { name: /Unsend for everyone/ })).toBeChecked(); expect(screen.queryByRole('radio', { name: /Delete for me/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' })); expect(await screen.findByRole('alert')).toHaveTextContent('Could not unsend');
});

test.each(['sending', 'failed', 'voice', 'incoming'] as const)('message actions reflect support and ownership for %s messages', state => {
  const message: ChatMessage = state === 'incoming' ? incoming : { ...outgoing, ...(state === 'voice' ? { type: 'voice' } : { deliveryStatus: state }) };
  render(<MessageList {...props({ messages: [message], onUnsendMessage: async () => true })} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const names = screen.getAllByRole('menuitem').map(element => element.textContent?.trim());
  expect(names).toEqual(state === 'voice' ? ['Pin', 'Unsend'] : state === 'incoming' ? ['Pin', 'Delete for me'] : ['Delete for me']);
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
  if (state === 'sending' || state === 'failed') expect(screen.queryByRole('button', { name: 'React to message' })).not.toBeInTheDocument();
});

test('all pinned messages are discoverable, navigable, and reflect updates, unpinning and deletion', () => {
  const pin = jest.fn();
  const initial = props({ messages: [{ ...incoming, isPinned: true }, { ...outgoing, isPinned: true }], onTogglePin: pin });
  const { container, rerender } = render(<MessageList {...initial} />);
  const original = container.querySelector<HTMLElement>('[data-message-id="incoming"]')!; original.scrollIntoView = jest.fn();
  fireEvent.click(screen.getByRole('button', { name: 'View pinned messages' }));
  expect(screen.getByRole('region', { name: 'Pinned messages' })).toHaveTextContent('Pins apply only to this local demo.');
  expect(within(screen.getByRole('region', { name: 'Pinned messages' })).getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Peer Incoming message' }));
  expect(original).toHaveFocus(); expect(original).toHaveAttribute('data-message-highlighted', 'true'); expect(original.scrollIntoView).toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Pinned messages' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View pinned messages' }));
  rerender(<MessageList {...initial} messages={[{ ...incoming, content: 'Updated pin', isPinned: true }, { ...outgoing, isPinned: true }]} />);
  expect(screen.getByRole('button', { name: 'Peer Updated pin' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Unpin message: Updated pin' })); expect(pin).toHaveBeenCalledWith(incoming.id);
  rerender(<MessageList {...initial} messages={[incoming, { ...outgoing, isPinned: true }]} />);
  expect(within(screen.getByRole('region', { name: 'Pinned messages' })).getAllByRole('listitem')).toHaveLength(1);
  rerender(<MessageList {...initial} messages={[incoming, { ...outgoing, isPinned: true, isDeleted: true }]} />);
  expect(screen.queryByRole('button', { name: 'View pinned messages' })).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Pinned messages' })).not.toBeInTheDocument();
  expect(screen.getByRole('log')).toHaveFocus();
});

test('Escape closes the pinned list and restores keyboard focus; the existing banner navigates directly', () => {
  const { container } = render(<MessageList {...props({ messages: [{ ...incoming, isPinned: true }] })} />);
  const original = container.querySelector<HTMLElement>('[data-message-id="incoming"]')!; original.scrollIntoView = jest.fn();
  const view = screen.getByRole('button', { name: 'View pinned messages' }); fireEvent.click(view);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Peer Incoming message' }), { key: 'Escape' });
  expect(view).toHaveFocus(); expect(view).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Go to latest pinned message' })); expect(original).toHaveFocus();
});
