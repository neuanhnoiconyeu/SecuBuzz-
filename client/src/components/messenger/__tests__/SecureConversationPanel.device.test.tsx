import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SecureConversationPanel } from '../SecureConversationPanel';
import { SecureMessagingSession } from '@/security/e2ee/session';
import { generateDevice } from '@/security/e2ee/devices';
import { E2eeError, type DirectConversation } from '@/security/e2ee/model';
import { ConversationHeader } from '../ConversationHeader';
import { MessageList } from '../MessageList';
import { presentMessages } from '../authenticatedChatPresentation';
import { envelope } from '@/realtime/testing/authenticatedFixtures';
import type { StoredMessage } from '@/security/e2ee/model';
import { SecureRealtimeWorkspace, type SecureLiveState } from '@/realtime/SecureRealtimeWorkspace';
import { EMOJI_CATEGORIES } from '../emojiData';
import { RECENT_EMOJI_KEY } from '../recentEmojis';
import { hideLocalMessage, LOCAL_HIDDEN_MESSAGE_PREFIX } from '@/messaging/localHiddenMessages';
import type { DecryptedRow } from '@/security/e2ee/session';
import { decodeAuthenticatedContent } from '@/messaging/authenticatedContent';
import { AuthenticatedReactions } from '@/messaging/authenticatedReactions';

const conversation: DirectConversation = { id: 'conversation', type: 'direct', interactionAllowed: true,
  createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z', participants: [
    { id: 'alice', username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: 'bob', username: 'bob', displayName: 'Bob', avatar: 'default' },
  ] };
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
beforeEach(() => {localStorage.clear();jest.spyOn(AuthenticatedReactions.prototype,'refresh').mockResolvedValue(undefined);});
afterEach(() => { jest.restoreAllMocks(); });
async function fixture(actorId = 'alice') {
  const session = new SecureMessagingSession({ actor: { id: actorId, username: actorId }, request: jest.fn().mockResolvedValue({ conversationId: conversation.id, version: 0, items: [] }), dispose() {} });
  const device = await generateDevice(actorId);
  const initialize = jest.spyOn(session, 'initialize').mockRejectedValue(new E2eeError('enrollment_required'));
  jest.spyOn(session.api, 'conversations').mockResolvedValue({ items: [conversation], nextCursor: null });
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const prepare = jest.spyOn(session, 'prepare').mockResolvedValue({ conversation, key, keyId: 'epoch', safetyNumber: '1234' });
  jest.spyOn(session, 'history').mockResolvedValue({ items: [], nextCursor: null });
  jest.spyOn(session, 'pending').mockResolvedValue(null);
  return { session, device, initialize, prepare, key };
}

test('startup and cancelled confirmation cannot enroll; confirmation permits explicit enrollment', async () => {
  const f = await fixture(), confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  render(<SecureConversationPanel session={f.session} selectedId={null} onSelect={jest.fn()} displayName="Alice" />);
  const button = await screen.findByRole('button', { name: /^Enroll this browser/ });
  expect(f.initialize.mock.calls).toEqual([[false]]);
  fireEvent.click(button); expect(confirm).toHaveBeenCalledTimes(1); expect(f.initialize).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/does not recover keys from another device/)).toBeInTheDocument();
  confirm.mockReturnValue(true); f.initialize.mockResolvedValue(f.device); fireEvent.click(button);
  await screen.findByText('Secure device ready', { exact: true });
  expect(f.initialize.mock.calls).toEqual([[false], [true]]);
});

test('real presence is announced by the original header without exposing an invisible user as online', () => {
  render(<ConversationHeader name="Bob" type="direct" presence="offline" securityStatus={null} connectionStatus="connected" transportMode="realtime" showCalls={false}
    securePresentation={{ ready: true, label: 'End-to-end encrypted', details: <p>Verified conversation keys</p> }} />);
  expect(screen.getByRole('status', { name: 'Contact presence' })).toHaveTextContent('Offline');
});

test('unconfirmed sends retain the draft and explicit pending reconciliation clears only that confirmed draft', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const message: StoredMessage = { ...envelope, conversationId: 'conversation', storageId: 'storage', sequence: 1, revision: 1,
    state: 'active', deletedAt: null, storedAt: envelope.timestamp, updatedAt: envelope.timestamp };
  const send = jest.spyOn(f.session, 'send').mockRejectedValue(new Error('Synthetic lost acknowledgment'));
  const pending = jest.spyOn(f.session, 'pending').mockResolvedValue(null);
  const retry = jest.spyOn(f.session, 'retryPending').mockResolvedValue(message);
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Secure message ready', { exact: true });
  pending.mockResolvedValue({ ...envelope, conversationId: 'conversation' });
  fireEvent.change(screen.getByLabelText('Message to Bob'), { target: { value: 'Retain until confirmed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('button', { name: 'Reconcile or retry pending message' });
  expect(screen.getByLabelText('Message to Bob')).toHaveValue('Retain until confirmed');
  pending.mockResolvedValue(null); fireEvent.click(screen.getByRole('button', { name: 'Reconcile or retry pending message' }));
  await waitFor(() => expect(screen.getByLabelText('Message to Bob')).toHaveValue(''));
  expect(retry).toHaveBeenCalledWith('conversation'); expect(send).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Your message was not confirmed. Your draft is still here.')).not.toBeInTheDocument();
});

test('loading older authenticated history keeps the existing viewport instead of treating it as a new arrival', () => {
  const message: StoredMessage = { ...envelope, id: 'recent', storageId: 'storage', sequence: 2, revision: 1,
    state: 'active', deletedAt: null, storedAt: envelope.timestamp, updatedAt: envelope.timestamp };
  const recent = { message, text: 'Recent message', error: null };
  const older = { message: { ...message, id: 'older', sequence: 1 }, text: 'Older message', error: null };
  const renderList = (rows: typeof recent[]) => <MessageList messages={presentMessages(rows).messages} currentUserId="alice" transportMode="realtime" onRetryMessage={jest.fn()} />;
  const view = render(renderList([recent])); const history = screen.getByRole('log');
  Object.defineProperty(history, 'scrollHeight', { configurable: true, value: 300 }); Object.defineProperty(history, 'clientHeight', { configurable: true, value: 100 });
  view.rerender(renderList([recent])); history.scrollTop = 80; fireEvent.scroll(history);
  Object.defineProperty(history, 'scrollHeight', { configurable: true, value: 450 }); view.rerender(renderList([older, recent]));
  expect(history.scrollTop).toBe(230);
});

test('real conversations reuse the original presentation without demo copy or unsupported attachment/call actions', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Secure message ready', { exact: true });
  expect(screen.getByRole('navigation', { name: 'Direct conversations' })).toHaveClass('conversation-sidebar');
  expect(screen.getByRole('button', { name: /^Bob, Direct/ })).toBeInTheDocument();
  expect(screen.getByRole('log', { name: 'Chat messages' })).toHaveClass('chat-history');
  expect(screen.getByLabelText('Message to Bob')).toHaveClass('composer-input');
  expect(screen.getByText('End-to-end encrypted', { exact: true })).toBeInTheDocument();
  expect(screen.queryByText('E2EE not established')).not.toBeInTheDocument();
  expect(screen.queryByText(/Local examples only/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Attach files or images' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Record voice message' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Direct call actions' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Insert emoji' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Refresh secure conversation', hidden: true })).not.toBeVisible();
});

test('per-conversation drafts survive selection changes, secure refresh, and a hidden workspace', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const second = { ...conversation, id: 'second', participants: [conversation.participants[0]!, { id: 'charlie', username: 'charlie', displayName: 'Charlie', avatar: 'default' }] };
  jest.spyOn(f.session.api, 'conversations').mockResolvedValue({ items: [conversation, second], nextCursor: null });
  f.prepare.mockImplementation(async cid => ({ conversation: cid === 'second' ? second : conversation, key: f.key, keyId: 'epoch', safetyNumber: '1234' }));
  function Harness({ active }: { active: boolean }) {
    const [selected, setSelected] = useState('conversation');
    return <SecureConversationPanel session={f.session} selectedId={selected} onSelect={setSelected} displayName="Alice" active={active} />;
  }
  const view = render(<Harness active />); await screen.findByText('Secure message ready', { exact: true });
  fireEvent.change(screen.getByLabelText('Message to Bob'), { target: { value: 'Bob draft' } });
  fireEvent.click(screen.getByRole('button', { name: /^Charlie, Direct/ })); await screen.findByLabelText('Message to Charlie');
  await waitFor(() => expect(screen.getByLabelText('Message to Charlie')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Message to Charlie'), { target: { value: 'Charlie draft' } });
  fireEvent.click(screen.getByRole('button', { name: /^Bob, Direct/ })); await waitFor(() => expect(screen.getByLabelText('Message to Bob')).toBeEnabled());
  expect(screen.getByLabelText('Message to Bob')).toHaveValue('Bob draft');
  fireEvent.click(screen.getByText('Advanced settings')); fireEvent.click(screen.getByRole('button', { name: 'Refresh secure conversation' }));
  await waitFor(() => expect(screen.getByLabelText('Message to Bob')).toBeEnabled());
  expect(screen.getByLabelText('Message to Bob')).toHaveValue('Bob draft');
  view.rerender(<Harness active={false} />); view.rerender(<Harness active />);
  expect(screen.getByLabelText('Message to Bob')).toHaveValue('Bob draft');
  fireEvent.click(screen.getByRole('button', { name: /^Charlie, Direct/ }));
  expect(await screen.findByLabelText('Message to Charlie')).toHaveValue('Charlie draft');
});

test('real-account advanced emoji uses shared categories, search and recents while preserving cursor selection and multiline text', async () => {
  localStorage.clear();
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const send = jest.spyOn(f.session, 'send').mockResolvedValue({ ...envelope, storageId: 'storage', sequence: 1, revision: 1,
    state: 'active', deletedAt: null, storedAt: envelope.timestamp, updatedAt: envelope.timestamp });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Secure message ready', { exact: true });
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Bob' });
  fireEvent.change(input, { target: { value: 'Hello middle text\nSecond line 👩🏽‍💻' } }); input.setSelectionRange(6, 12);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  for (const category of EMOJI_CATEGORIES) {
    expect(screen.getByRole('tab', { name: category.label })).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole('tab', { name: 'Flags' }));
  expect(screen.getByRole('tabpanel', { name: 'Flags' }).querySelector('button')).not.toBeNull();
  const search = screen.getByRole('searchbox', { name: 'Search emoji' });
  fireEvent.change(search, { target: { value: 'vietnam' } });
  fireEvent.keyDown(search, { key: 'Enter' }); expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Insert flag: Vietnam 🇻🇳' }));
  expect(input).toHaveValue('Hello 🇻🇳 text\nSecond line 👩🏽‍💻');
  await waitFor(() => expect(input.selectionStart).toBe(10)); expect(input.selectionEnd).toBe(10); expect(input).toHaveFocus();
  expect(JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY)!)).toEqual(['🇻🇳']);
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  expect(screen.getByRole('tab', { name: 'Recently Used' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Insert flag: Vietnam 🇻🇳' }));
  expect(input).toHaveValue('Hello 🇻🇳🇻🇳 text\nSecond line 👩🏽‍💻');
  expect(JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY)!)).toEqual(['🇻🇳']);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('conversation', 'Alice', 'Hello 🇻🇳🇻🇳 text\nSecond line 👩🏽‍💻', undefined, expect.any(Function)));
  await waitFor(() => expect(input).toHaveValue(''));
});

test('hiding a real-account workspace closes its emoji popup and retains its unsent draft', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const props = { session: f.session, selectedId: 'conversation', onSelect: jest.fn(), displayName: 'Alice' };
  const view = render(<SecureConversationPanel {...props} active />);
  await screen.findByText('Secure message ready', { exact: true });
  fireEvent.change(screen.getByLabelText('Message to Bob'), { target: { value: 'Retain emoji draft 💜' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
  expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
  view.rerender(<SecureConversationPanel {...props} active={false} />);
  expect(screen.queryByRole('dialog', { name: 'Emoji picker', hidden: true })).not.toBeInTheDocument();
  view.rerender(<SecureConversationPanel {...props} active />);
  expect(screen.getByLabelText('Message to Bob')).toHaveValue('Retain emoji draft 💜');
  expect(screen.getByRole('button', { name: 'Insert emoji' })).toHaveAttribute('aria-expanded', 'false');
});

function localDeleteRow(id: string, senderId = 'alice', sequence = 1): DecryptedRow {
  return { message: { ...envelope, id, conversationId: 'conversation', senderId, senderName: senderId === 'bob' ? 'Bob' : 'Alice', storageId: 'storage-' + id, sequence, revision: 1,
    state: 'active', deletedAt: null, storedAt: envelope.timestamp, updatedAt: envelope.timestamp }, text: 'Text ' + id, error: null };
}
test('an authenticated edit failure exposes the security error while preserving the multiline editor draft',async()=>{
  const f=await fixture();f.initialize.mockResolvedValue(f.device);const original=localDeleteRow('encrypted-edit');
  jest.spyOn(f.session,'history').mockResolvedValue({items:[original],nextCursor:null});
  const failure=new E2eeError('invalid_proof'),save=jest.spyOn(f.session,'editMessage').mockRejectedValue(failure);
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice"/>);
  await waitFor(()=>expect(screen.getByRole('log')).toHaveTextContent(original.text!));await waitFor(()=>expect(screen.getByLabelText('Message to Bob')).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'More actions'}));fireEvent.click(screen.getByRole('menuitem',{name:'Edit'}));
  const editor=screen.getByRole('textbox',{name:'Edit message'});fireEvent.change(editor,{target:{value:'Keep draft\n🇻🇳'}});fireEvent.click(screen.getByRole('button',{name:'Save edit'}));
  await screen.findByText(failure.message,{exact:true});expect(editor).toHaveValue('Keep draft\n🇻🇳');expect(save).toHaveBeenCalledWith(original.message,'Keep draft\n🇻🇳');
  fireEvent.click(screen.getByRole('button',{name:'Cancel edit'}));expect(screen.getByRole('log')).toHaveTextContent(original.text!);
});
function openDeleteForMe(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
  fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete for me' }));
  return within(screen.getByRole('dialog'));
}

test('real sent and received messages use device-only confirmation; refresh/sign-in preserve hiding and another account keeps both messages', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const rows = [localDeleteRow('outgoing'), localDeleteRow('incoming', 'bob', 2)], original = JSON.stringify(rows);
  jest.spyOn(f.session, 'history').mockResolvedValue({ items: rows, nextCursor: null });
  const serverDelete = jest.spyOn(f.session.api, 'remove');
  const panel = () => <SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />;
  let view = render(panel()); await screen.findByText('Text outgoing');
  let review = openDeleteForMe('outgoing');
  expect(review.queryByRole('radio', { name: /Unsend for everyone/ })).not.toBeInTheDocument();
  expect(review.getByText(/removed from your device.*visible to other chat members/)).toBeInTheDocument();
  fireEvent.click(review.getByRole('button', { name: 'Cancel' })); expect(screen.getByRole('log')).toHaveTextContent('Text outgoing');
  expect(localStorage.length).toBe(0);
  review = openDeleteForMe('outgoing'); fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('log')).not.toHaveTextContent('Text outgoing');
  review = openDeleteForMe('incoming'); expect(screen.getByRole('log')).toHaveTextContent('Text incoming');
  fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('log')).not.toHaveTextContent('Text incoming');
  expect(screen.getByText('Message deleted for you on this device.')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: 'Direct conversations' })).not.toHaveTextContent('Text incoming');
  fireEvent.click(screen.getByText('Advanced settings')); fireEvent.click(screen.getByRole('button', { name: 'Refresh secure conversation' }));
  await waitFor(() => expect(screen.getByLabelText('Message to Bob')).toBeEnabled());
  expect(screen.getByRole('log')).not.toHaveTextContent('Text outgoing');
  view.unmount(); // A new component/session after logout or refresh reads durable markers.
  const bob = await fixture('bob'); bob.initialize.mockResolvedValue(bob.device);
  jest.spyOn(bob.session, 'history').mockResolvedValue({ items: rows, nextCursor: null });
  view = render(<SecureConversationPanel session={bob.session} selectedId="conversation" onSelect={jest.fn()} displayName="Bob" />);
  await screen.findByText('Text outgoing'); expect(screen.getByRole('log')).toHaveTextContent('Text incoming'); view.unmount();
  view = render(panel()); await screen.findByText('Secure message ready', { exact: true });
  expect(screen.getByRole('log')).not.toHaveTextContent('Text outgoing'); expect(screen.getByRole('log')).not.toHaveTextContent('Text incoming');
  expect(serverDelete).not.toHaveBeenCalled(); expect(JSON.stringify(rows)).toBe(original);
});

test('hidden wire IDs remain filtered during older history loading and stay scoped to their conversation', async () => {
  hideLocalMessage('alice', 'conversation', 'old-hidden'); hideLocalMessage('alice', 'other-conversation', 'recent');
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const hidden = localDeleteRow('old-hidden'), older = localDeleteRow('old-visible', 'bob', 2), recent = localDeleteRow('recent', 'bob', 3);
  jest.spyOn(f.session, 'history').mockImplementation(async (_, cursor) => cursor ? { items: [hidden, older], nextCursor: null } : { items: [recent], nextCursor: 'older' });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text recent'); fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  await screen.findByText('Text old-visible'); expect(screen.queryByText('Text old-hidden')).not.toBeInTheDocument();
  expect(screen.getByRole('log')).toHaveTextContent('Text recent');
});

test('replayed realtime rows and reconnect reconciliation cannot resurrect local hides or mutate workspace history', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const hidden = localDeleteRow('hidden'), incoming = localDeleteRow('new-live', 'bob', 2);
  const live = new SecureRealtimeWorkspace(f.session, 'http://localhost:4177');
  let state: SecureLiveState = { connection: 'connected', conversations: [conversation], rows: { conversation: [hidden] }, cursors: {}, unread: {}, typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 1 };
  const listeners = new Set<() => void>();
  jest.spyOn(live, 'getSnapshot').mockImplementation(() => state);
  jest.spyOn(live, 'subscribe').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  jest.spyOn(live, 'refresh').mockResolvedValue(undefined); jest.spyOn(live, 'sync').mockResolvedValue(undefined);
  const view = render(<SecureConversationPanel session={f.session} live={live} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text hidden'); fireEvent.click(openDeleteForMe('hidden').getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  act(() => { state = { ...state, rows: { conversation: [{ ...hidden, message: { ...hidden.message, storageId: 'different-storage-projection', revision: 2 } }, incoming] }, synchronized: 2 }; listeners.forEach(listener => listener()); });
  await within(screen.getByRole('log')).findByText('Text new-live'); await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Text hidden')).not.toBeInTheDocument(); expect(state.rows.conversation).toHaveLength(2);
  view.unmount(); live.dispose();
});

test('storage write failure preserves the message and confirmation until durable hiding can succeed', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  jest.spyOn(f.session, 'history').mockResolvedValue({ items: [localDeleteRow('failure', 'bob')], nextCursor: null });
  const serverDelete = jest.spyOn(f.session.api, 'remove');
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text failure'); const review = openDeleteForMe('failure');
  const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(review.getByRole('alert')).toHaveTextContent('Your message is unchanged'));
  expect(screen.getByText(/Delete for Me could not be saved on this device/)).toBeInTheDocument();
  expect(screen.getByRole('log')).toHaveTextContent('Text failure'); expect(localStorage.length).toBe(0);
  write.mockRestore(); fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByText('Text failure')).not.toBeInTheDocument(); expect(serverDelete).not.toHaveBeenCalled();
  expect(Object.keys(localStorage).filter(key => key.startsWith(LOCAL_HIDDEN_MESSAGE_PREFIX))).toHaveLength(1);
});

test('authenticated reply uses the shared preview, encrypted content adapter and loaded-original navigation; hiding removes the quote', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const rows = [localDeleteRow('own'), localDeleteRow('original', 'bob', 2)];
  jest.spyOn(f.session, 'history').mockImplementation(async () => ({ items: [...rows], nextCursor: null }));
  const send = jest.spyOn(f.session, 'send').mockImplementation(async (_, __, text) => { const row = localDeleteRow('reply', 'alice', 3); row.text = text; rows.push(row); return row.message; });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text own');
  const selectReply = (id: string) => fireEvent.click(within(document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!).getByRole('button', { name: 'Reply' }));
  selectReply('own'); expect(document.querySelector('.reply-preview-banner')).toHaveTextContent('Text own');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
  selectReply('original'); expect(document.querySelector('.reply-preview-banner')).toHaveTextContent('Replying to Bob');
  fireEvent.change(screen.getByLabelText('Message to Bob'), { target: { value: 'Reply 👩🏽‍💻\nMultiline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await within(screen.getByRole('log')).findByText('Reply 👩🏽‍💻 Multiline');
  expect(decodeAuthenticatedContent(send.mock.calls[0]![2])).toEqual({ text: 'Reply 👩🏽‍💻\nMultiline', reply: { messageId: 'original', senderId: 'bob' } });
  expect(screen.queryByRole('button', { name: 'Cancel reply' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Go to original message from Bob' }));
  expect(document.querySelector('[data-message-id="original"]')).toHaveAttribute('data-message-highlighted', 'true');
  fireEvent.click(openDeleteForMe('original').getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByText('Original message unavailable.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Go to original message from a message' }));
  expect(screen.getByText('The original message is unavailable in the loaded history.')).toBeInTheDocument();
});

test('authenticated ForwardDialog lists permitted destinations and keeps partial note failure open until only its retry succeeds', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const blocked = { ...conversation, id: 'blocked', interactionAllowed: false, participants: [conversation.participants[0]!, { ...conversation.participants[1]!, id: 'charlie', displayName: 'Charlie' }] };
  jest.spyOn(f.session.api, 'conversations').mockResolvedValue({ items: [conversation, blocked], nextCursor: null });
  jest.spyOn(f.session.api, 'getConversation').mockResolvedValue(conversation);
  const rows = [localDeleteRow('source', 'bob')];
  jest.spyOn(f.session, 'history').mockImplementation(async () => ({ items: [...rows], nextCursor: null }));
  let attempts = 0;
  const send = jest.spyOn(f.session, 'send').mockImplementation(async (_, __, text) => {
    if (++attempts === 2) throw new Error('Note failed');
    const row = localDeleteRow('forward-' + attempts, 'alice', attempts + 1); row.text = text; rows.push(row); return row.message;
  });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text source');
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Forward' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.queryByRole('button', { name: 'Charlie' })).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: 'Bob' })); fireEvent.change(dialog.getByLabelText('Optional message'), { target: { value: 'Optional private note' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('optional note was not confirmed'));
  expect(dialog.getByLabelText('Optional message')).toBeDisabled();
  fireEvent.click(dialog.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls.filter(call => decodeAuthenticatedContent(call[2])?.forwarded)).toHaveLength(1);
  expect(within(screen.getByRole('log')).getByText('Forwarded', { exact: true })).toBeInTheDocument();
  expect(within(screen.getByRole('log')).getByText('Optional private note')).toBeInTheDocument();
});

test('replying to an older loaded original preserves its history row and pagination position after sending', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const original = localDeleteRow('older-original', 'bob', 1), recent = localDeleteRow('recent-head', 'alice', 2);
  const head = [recent];
  jest.spyOn(f.session, 'history').mockImplementation(async (_, cursor) => cursor === 'older' ? { items: [original], nextCursor: null } : { items: [...head], nextCursor: 'older' });
  jest.spyOn(f.session, 'send').mockImplementation(async (_, __, text) => { const row = localDeleteRow('reply-to-old', 'alice', 3); row.text = text; head.push(row); return row.message; });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text recent-head'); fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  await screen.findByText('Text older-original');
  fireEvent.click(within(document.querySelector<HTMLElement>('[data-message-id="older-original"]')!).getByRole('button', { name: 'Reply' }));
  fireEvent.change(screen.getByLabelText('Message to Bob'), { target: { value: 'Reply to the older page' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await within(screen.getByRole('log')).findByText('Reply to the older page');
  expect(document.querySelector('[data-message-id="older-original"]')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Go to original message from Bob' }));
  expect(document.querySelector('[data-message-id="older-original"]')).toHaveAttribute('data-message-highlighted', 'true');
});

test('reconciling an unconfirmed reply keeps a newer reply selection and never submits another message', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const rows = [localDeleteRow('first-reference', 'bob'), localDeleteRow('new-reference', 'alice', 2)];
  jest.spyOn(f.session, 'history').mockResolvedValue({ items: rows, nextCursor: null });
  let uncertain = false;
  jest.spyOn(f.session, 'pending').mockImplementation(async () => uncertain ? { ...envelope, conversationId: 'conversation' } : null);
  const send = jest.spyOn(f.session, 'send').mockImplementation(async () => { uncertain = true; throw new Error('Lost ack'); });
  const retry = jest.spyOn(f.session, 'retryPending').mockImplementation(async () => { uncertain = false; return localDeleteRow('confirmed-reply').message; });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text first-reference');
  const choose = (id: string) => fireEvent.click(within(document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!).getByRole('button', { name: 'Reply' }));
  choose('first-reference'); fireEvent.change(screen.getByLabelText('Message to Bob'), { target: { value: 'Uncertain reply' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('button', { name: 'Reconcile or retry pending message' });
  expect(document.querySelector('.reply-preview-banner')).toHaveTextContent('Text first-reference');
  choose('new-reference'); fireEvent.click(screen.getByRole('button', { name: 'Reconcile or retry pending message' }));
  await waitFor(() => expect(screen.getByLabelText('Message to Bob')).toHaveValue(''));
  expect(document.querySelector('.reply-preview-banner')).toHaveTextContent('Text new-reference');
  expect(retry).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
});

function openUnsend(id: string) {
  fireEvent.click(within(document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!).getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Unsend' }));
  return within(screen.getByRole('dialog'));
}
const unsent = (row: DecryptedRow): StoredMessage => ({ ...row.message, state: 'deleted', encryption: null, revision: row.message.revision + 1, deletedAt: envelope.timestamp });

test('real Unsend is sender-only, uses storage ID, and waits for confirmation while Delete for Me stays separate', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const own = localDeleteRow('own-unsend'), incoming = localDeleteRow('received', 'bob', 2);
  jest.spyOn(f.session, 'history').mockResolvedValue({ items: [own, incoming], nextCursor: null });
  let confirm!: (message: StoredMessage) => void;
  const remove = jest.spyOn(f.session.api, 'remove').mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text own-unsend');
  fireEvent.click(within(document.querySelector<HTMLElement>('[data-message-id="received"]')!).getByRole('button', { name: 'More actions' }));
  expect(screen.queryByRole('menuitem', { name: 'Unsend' })).not.toBeInTheDocument(); fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  const local = openDeleteForMe('own-unsend'); expect(local.queryByRole('radio', { name: /Unsend for everyone/ })).not.toBeInTheDocument();
  fireEvent.click(local.getByRole('button', { name: 'Cancel' }));
  const review = openUnsend('own-unsend');
  expect(review.getByRole('radio', { name: /Unsend for everyone/ })).toBeChecked();
  expect(review.queryByRole('radio', { name: /Delete for me/ })).not.toBeInTheDocument();
  fireEvent.click(review.getByRole('button', { name: 'Remove' })); fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  expect(remove).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledWith('storage-own-unsend');
  expect(screen.getByRole('log')).toHaveTextContent('Text own-unsend'); expect(screen.queryByText('Message unsent for everyone.')).not.toBeInTheDocument();
  await act(async () => { confirm(unsent(own)); });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByText('Message unsent for everyone.')).toBeInTheDocument();
  expect(document.querySelector('[data-message-id="own-unsend"]')).toBeInTheDocument();
  expect(screen.getByRole('log')).not.toHaveTextContent('Text own-unsend'); expect(screen.getByRole('log')).toHaveTextContent('Message deleted');
  expect(own.message.state).toBe('active'); expect(localStorage.length).toBe(0);
});

test('failed Unsend leaves the original visible and the confirmation open; retry shows the server tombstone', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device); const own = localDeleteRow('failure-unsend');
  jest.spyOn(f.session, 'history').mockResolvedValue({ items: [own], nextCursor: null });
  jest.spyOn(f.session.api, 'history').mockResolvedValue({ items: [own.message], nextCursor: null });
  const remove = jest.spyOn(f.session.api, 'remove').mockRejectedValueOnce(new Error('Private transport details')).mockResolvedValue(unsent(own));
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text failure-unsend'); const review = openUnsend('failure-unsend');
  fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(review.getByRole('alert')).toHaveTextContent('Your message is unchanged'));
  expect(screen.getByRole('log')).toHaveTextContent('Text failure-unsend'); expect(screen.queryByText('Message unsent for everyone.')).not.toBeInTheDocument();
  expect(screen.queryByText('Private transport details')).not.toBeInTheDocument();
  fireEvent.click(review.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(remove).toHaveBeenCalledTimes(2); expect(screen.getByRole('log')).toHaveTextContent('Message deleted');
});

test('a stale REST refresh cannot resurrect a confirmed tombstone', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device); const own = localDeleteRow('refresh-unsend');
  const history = jest.spyOn(f.session, 'history').mockResolvedValue({ items: [own], nextCursor: null });
  jest.spyOn(f.session.api, 'remove').mockResolvedValue(unsent(own));
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await within(screen.getByRole('log')).findByText('Text refresh-unsend'); fireEvent.click(openUnsend('refresh-unsend').getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(screen.getByText('Advanced settings')); fireEvent.click(screen.getByRole('button', { name: 'Refresh secure conversation' }));
  await waitFor(() => expect(screen.getByLabelText('Message to Bob')).toBeEnabled());
  expect(history).toHaveBeenCalledTimes(2); expect(screen.getByRole('log')).toHaveTextContent('Message deleted');
  expect(screen.getByRole('log')).not.toHaveTextContent('Text refresh-unsend');
});

test('changed contact keys lock sending, preserve the draft, and require explicit review', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const review = jest.spyOn(f.session, 'acceptKeyChange').mockResolvedValue(undefined);
  const keys = jest.spyOn(f.session, 'getKeyReview').mockReturnValue(null);
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Secure message ready', { exact: true });
  fireEvent.change(screen.getByLabelText('Message to Bob'), { target: { value: 'Keep this private draft' } });
  f.prepare.mockRejectedValueOnce(new E2eeError('keys_changed')); keys.mockReturnValue({ oldIds: ['old'], newIds: ['new'] });
  fireEvent.click(screen.getByText('Advanced settings')); fireEvent.click(screen.getByRole('button', { name: 'Refresh secure conversation' }));
  const warning = await screen.findByText('Contact device keys changed');
  expect(screen.getByLabelText('Message to Bob')).toHaveValue('Keep this private draft');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled(); expect(review).not.toHaveBeenCalled();
  fireEvent.click(within(warning.closest('[role=alert]')!).getByRole('button', { name: 'Trust these device changes' }));
  await waitFor(() => expect(screen.getByLabelText('Message to Bob')).toBeEnabled());
  expect(review).toHaveBeenCalledWith('conversation'); expect(screen.getByLabelText('Message to Bob')).toHaveValue('Keep this private draft');
});

test('revocation discovered during a conversation refresh locks sending and exposes safe enrollment guidance', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const send = jest.spyOn(f.session, 'send');
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Secure message ready', { exact: true });
  f.prepare.mockRejectedValue(new E2eeError('device_revoked'));
  fireEvent.click(screen.getByText('Advanced settings')); fireEvent.click(screen.getByRole('button', { name: 'Refresh secure conversation' }));
  await screen.findByText('Device revoked', { exact: true });
  expect(screen.getByLabelText('Message to Bob')).toBeDisabled();
  expect(screen.getByText(/fresh browser profile/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Enroll this browser/ })).not.toBeInTheDocument(); expect(send).not.toHaveBeenCalled();
});

test('an already reconciled live connection prepares once on selection and still rechecks actual key-change hints', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const live = new SecureRealtimeWorkspace(f.session, 'http://localhost:4177');
  let state: SecureLiveState = { connection: 'connected', conversations: [conversation], rows: {}, cursors: {}, unread: {}, typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 1 };
  const listeners = new Set<() => void>();
  jest.spyOn(live, 'getSnapshot').mockImplementation(() => state);
  jest.spyOn(live, 'subscribe').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  jest.spyOn(live, 'refresh').mockResolvedValue(undefined); jest.spyOn(live, 'sync').mockResolvedValue(undefined);
  const reconnect = jest.spyOn(live, 'reconnect').mockImplementation(() => {});
  const view = render(<SecureConversationPanel session={f.session} live={live} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Secure message ready', { exact: true });
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(reconnect).not.toHaveBeenCalled();
  f.prepare.mockRejectedValueOnce(new E2eeError('keys_changed'));
  jest.spyOn(f.session, 'getKeyReview').mockReturnValue({ oldIds: ['old'], newIds: ['new'] });
  act(() => { state = { ...state, keyVersions: { conversation: 1 } }; listeners.forEach(listener => listener()); });
  await screen.findByText('Contact device keys changed'); expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  view.unmount(); live.dispose();
});

test('a later successful initialization clears the earlier revoked UI flag and allows verified preparation', async () => {
  const f = await fixture(); f.initialize.mockRejectedValueOnce(new E2eeError('device_revoked')).mockResolvedValue(f.device);
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Device revoked', { exact: true });
  expect(screen.getByLabelText('Message to Bob', { exact: true })).toBeDisabled();
  expect(screen.getByText(/fresh browser profile/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry secure device' }));
  await screen.findByText('Secure message ready', { exact: true });
  await waitFor(() => expect(screen.getByLabelText('Message to Bob', { exact: true })).toBeEnabled());
  expect(f.prepare).toHaveBeenCalled(); expect(f.initialize.mock.calls).toEqual([[false], [false]]);
});

test('missing historical keys are explained without marking ciphertext verified or disabling new secure messages', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const message: StoredMessage = { ...envelope, conversationId: conversation.id, encryption: { ...envelope.encryption, version: 2, keyId: 'epoch' },
    storageId: 'historical-storage', sequence: 1, revision: 0, state: 'active', deletedAt: null,
    storedAt: envelope.timestamp, updatedAt: envelope.timestamp };
  const missing = { message, text: null, error: new E2eeError('missing_key').message, errorCode: 'missing_key' as const };
  jest.spyOn(f.session, 'history').mockResolvedValue({ items: [missing], nextCursor: null });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Secure message ready', { exact: true });
  const notice = await screen.findByRole('status', { name: 'Historical message keys' });
  expect(notice).toHaveTextContent('original browser profile');
  expect(notice).toHaveTextContent('New messages');
  expect(screen.getByRole('log')).toHaveTextContent(missing.error);
  expect(presentMessages([missing]).verifiedIds.has(message.id)).toBe(false);
  await waitFor(() => expect(screen.getByLabelText('Message to Bob')).toBeEnabled());
});

test('ciphertext verification failures are not mislabeled as missing historical keys', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const message: StoredMessage = { ...envelope, conversationId: conversation.id, encryption: { ...envelope.encryption, version: 2, keyId: 'epoch' },
    storageId: 'invalid-storage', sequence: 1, revision: 0, state: 'active', deletedAt: null,
    storedAt: envelope.timestamp, updatedAt: envelope.timestamp };
  const invalid = { message, text: null, error: new E2eeError('decryption_failed').message, errorCode: 'decryption_failed' as const };
  jest.spyOn(f.session, 'history').mockResolvedValue({ items: [invalid], nextCursor: null });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByText('Secure message ready', { exact: true });
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent(invalid.error));
  expect(screen.queryByRole('status', { name: 'Historical message keys' })).not.toBeInTheDocument();
  expect(presentMessages([invalid]).verifiedIds.has(message.id)).toBe(false);
});

test('server pins reuse original rows and navigation beyond loaded history while local hides remain private', async () => {
  const f = await fixture(); f.initialize.mockResolvedValue(f.device);
  const older = localDeleteRow('older-pin', 'bob'), recent = localDeleteRow('head', 'alice', 100); older.message.revision = 0;
  jest.spyOn(f.session, 'history').mockResolvedValue({ items: [recent], nextCursor: null });
  jest.spyOn(f.session, 'decryptStoredMessage').mockResolvedValue(older);
  const request = f.session.api.session.request as jest.Mock;
  request.mockResolvedValue({ conversationId: conversation.id, version: 1, items: [{ message: older.message, pinnedBy: 'bob', pinnedAt: envelope.timestamp }] });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice" />);
  await screen.findByRole('button', { name: 'View pinned messages' });
  expect(document.querySelectorAll('[data-message-id="older-pin"]')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'View pinned messages' }));
  fireEvent.click(within(screen.getByRole('region', { name: 'Pinned messages' })).getByRole('button', { name: /Bob.*Text older-pin/ }));
  expect(document.querySelector('[data-message-id="older-pin"]')).toHaveAttribute('data-message-highlighted', 'true');
  openDeleteForMe('older-pin'); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(document.querySelector('[data-message-id="older-pin"]')).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'View pinned messages' })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

test('authenticated presentation aggregates both users and removes only the current user reaction',async()=>{
  jest.spyOn(AuthenticatedReactions.prototype,'refresh').mockRestore();
  const f=await fixture();f.initialize.mockResolvedValue(f.device);const original=localDeleteRow('shared-reaction','bob');original.message.revision=0;
  jest.spyOn(f.session,'history').mockResolvedValue({items:[original],nextCursor:null});
  const actors=[{userId:'alice',emoji:'👍' as string|null,revision:1,updatedAt:envelope.timestamp},{userId:'bob',emoji:'👍' as string|null,revision:1,updatedAt:envelope.timestamp}];let version=2;
  const request=f.session.api.session.request as jest.Mock;
  request.mockImplementation(async(path,options)=>{
    if(options?.method==='POST'){
      const intent=options.body;actors[0]!.emoji=intent.emoji;actors[0]!.revision++;version++;
      return{conversationId:conversation.id,storageId:original.message.storageId,messageId:original.message.id,userId:'alice',emoji:intent.emoji,revision:actors[0]!.revision,version,operationId:intent.operationId};
    }
    if(path.includes('/reactions?'))return{conversationId:conversation.id,items:[{storageId:original.message.storageId,messageId:original.message.id,state:'active',version,actors:actors.map(a=>({...a}))}]};
    return{conversationId:conversation.id,version:0,items:[]};
  });
  render(<SecureConversationPanel session={f.session} selectedId="conversation" onSelect={jest.fn()} displayName="Alice"/>);
  const shared=await screen.findByRole('button',{name:'👍 2'});expect(shared).toHaveAttribute('aria-pressed','true');fireEvent.click(shared);
  const remaining=await screen.findByRole('button',{name:'👍 1'});expect(remaining).toHaveAttribute('aria-pressed','false');
  expect(request).toHaveBeenCalledWith('/api/messages/storage-shared-reaction/reaction',expect.objectContaining({method:'POST',body:expect.objectContaining({emoji:null,expectedRevision:1})}));
  expect(screen.getByRole('log')).toHaveTextContent('Text shared-reaction');
});
