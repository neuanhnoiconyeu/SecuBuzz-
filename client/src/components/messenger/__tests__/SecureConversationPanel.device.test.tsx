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

const conversation: DirectConversation = { id: 'conversation', type: 'direct', interactionAllowed: true,
  createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z', participants: [
    { id: 'alice', username: 'alice', displayName: 'Alice', avatar: 'default' },
    { id: 'bob', username: 'bob', displayName: 'Bob', avatar: 'default' },
  ] };
beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); });
afterEach(() => { jest.restoreAllMocks(); });
async function fixture() {
  const session = new SecureMessagingSession({ actor: { id: 'alice', username: 'alice' }, request: jest.fn(), dispose() {} });
  const device = await generateDevice('alice');
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
