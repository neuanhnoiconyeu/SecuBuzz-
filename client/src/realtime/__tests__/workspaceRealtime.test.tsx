import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Home from '@/app/page';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { DevelopmentAuthService } from '@/auth/developmentAuthService';
import { createDemoMessengerSession, type DemoMessengerSession } from '@/auth/messengerSession';
import { MessengerApp } from '@/components/messenger/MessengerApp';
import { createDemoProfile } from '@/profiles/profileModel';
import { MockRealtimeClient } from '../MockRealtimeClient';
import { DEMO_REALTIME_MESSAGE_TEXT, type RealtimeEvent } from '../realtimeModel';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const sessions: DemoMessengerSession[] = [];

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
beforeEach(() => { replace.mockClear(); window.history.replaceState({}, '', '/'); });
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); jest.restoreAllMocks(); });

function SessionHarness({ session }: { session: DemoMessengerSession }) {
  useEffect(() => () => session.dispose(), [session]);
  return <MessengerApp session={session} />;
}
async function renderSession() {
  const session = createDemoMessengerSession(createDemoProfile());
  sessions.push(session);
  const view = render(<SessionHarness session={session} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeEnabled());
  await screen.findByText('Connected · demo');
  return { session, ...view };
}
async function selectConversation(name: 'Ava Morgan' | 'Security Study Group' | 'SecureBot') {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name},`) }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: `Message to ${name}` })).toBeEnabled());
}
async function friends() {
  const navigation = within(screen.getByRole('navigation', { name: 'Main navigation' }));
  fireEvent.click(navigation.getByRole('button', { name: /^Friends/ }));
  await screen.findByRole('list', { name: 'Your friends' });
}
function demoControls() {
  const logSummary = screen.getByText('System log').closest('summary')!;
  if (!logSummary.parentElement!.hasAttribute('open')) fireEvent.click(logSummary);
  const controlsSummary = screen.getByText('Realtime demo controls').closest('summary')!;
  if (!controlsSummary.parentElement!.hasAttribute('open')) fireEvent.click(controlsSummary);
}
function captureClientListeners() {
  const original = MockRealtimeClient.prototype.subscribe;
  const captured = new Map<MockRealtimeClient, Array<(event: RealtimeEvent) => void>>();
  jest.spyOn(MockRealtimeClient.prototype, 'subscribe').mockImplementation(function (this: MockRealtimeClient, listener) {
    const callbacks = captured.get(this) ?? [];
    callbacks.push(listener); captured.set(this, callbacks);
    return original.call(this, listener);
  });
  return {
    clients: () => Array.from(captured.keys()),
    deliver(client: MockRealtimeClient, event: RealtimeEvent) {
      // A deterministic wire seam, including callbacks captured before unsubscribe/disposal.
      for (const callback of captured.get(client) ?? []) callback(event);
    },
  };
}
function incoming(id: string, at = new Date().toISOString()): Extract<RealtimeEvent, { type: 'message' }> {
  return { type: 'message', message: {
    id, conversationId: 'demo-direct-ava', senderId: 'demo-ava', senderName: 'Ava Morgan', timestamp: at,
    type: 'text', deliveryStatus: 'delivered', demoOnly: true, content: DEMO_REALTIME_MESSAGE_TEXT.direct,
  } };
}

test('auth login owns one client and logout/user switching discard messages, typing, presence, and stale callbacks', async () => {
  const captured = captureClientListeners();
  function AuthControls() {
    const auth = useAuth();
    return <><button onClick={() => void auth.continueAsDemo('explorer')}>Enter Explorer</button>
      <button onClick={() => void auth.continueAsDemo('nova')}>Enter Nova</button></>;
  }
  render(<AuthProvider service={new DevelopmentAuthService()}><AuthControls /><Home /></AuthProvider>);
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?next=%2F'));
  expect(captured.clients()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Enter Explorer' }));
  await screen.findByText('Connected · demo');
  await selectConversation('Ava Morgan');
  const first = captured.clients()[0]!;
  const dispose = jest.spyOn(first, 'dispose');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message to Ava Morgan' }), { target: { value: 'Explorer session only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await within(screen.getByRole('log')).findByText('Explorer session only');
  act(() => { first.simulatePresence('demo-ava', 'away'); first.simulateTyping('demo-direct-ava'); });
  expect(screen.getByText('Ava Morgan is typing… · simulated')).toBeInTheDocument();
  expect(captured.clients()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /Open profile for Demo Explorer/ }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Your profile' })).getByRole('button', { name: 'Sign Out' }));
  await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument());
  expect(dispose).toHaveBeenCalled();
  expect(first.getStatus()).toBe('disconnected');
  expect(() => first.simulateIncoming('demo-direct-ava')).toThrow('This realtime session has ended.');
  fireEvent.click(screen.getByRole('button', { name: 'Enter Nova' }));
  await screen.findByText('Connected · demo');
  expect(captured.clients()).toHaveLength(2);
  expect(captured.clients()[1]).not.toBe(first);
  act(() => captured.deliver(first, incoming('old-session-message')));
  expect(screen.queryByText('Explorer session only')).not.toBeInTheDocument();
  expect(within(screen.getByRole('log')).queryByText(DEMO_REALTIME_MESSAGE_TEXT.direct)).not.toBeInTheDocument();
  expect(screen.queryByText(/Ava Morgan is typing/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Open profile for Nova Explorer/ })).toBeInTheDocument();
  await friends();
  expect(within(screen.getByRole('list', { name: 'Your friends' })).getByText('Online · simulated')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Your friends' })).queryByText('Away · simulated')).not.toBeInTheDocument();
});

test('existing DM and group views consume explicit demo incoming controls without additional physical connections', async () => {
  const { session } = await renderSession();
  const connectionEvents: RealtimeEvent[] = [];
  session.realtime.subscribe((event) => { if (event.type === 'connection') connectionEvents.push(event); });
  await selectConversation('Ava Morgan');
  demoControls();
  expect(screen.getByRole('combobox', { name: 'Demo conversation' })).toHaveValue('demo-direct-ava');
  fireEvent.click(screen.getByRole('button', { name: 'Simulate incoming' }));
  expect(await within(screen.getByRole('log')).findByText(DEMO_REALTIME_MESSAGE_TEXT.direct)).toBeInTheDocument();
  await selectConversation('Security Study Group');
  expect(screen.getByRole('combobox', { name: 'Demo conversation' })).toHaveValue('demo-group-security');
  fireEvent.click(screen.getByRole('button', { name: 'Simulate incoming' }));
  expect(await within(screen.getByRole('log')).findByText(DEMO_REALTIME_MESSAGE_TEXT.group)).toBeInTheDocument();
  expect(within(screen.getByRole('log')).queryByText(DEMO_REALTIME_MESSAGE_TEXT.direct)).not.toBeInTheDocument();
  await selectConversation('Ava Morgan');
  expect(within(screen.getByRole('log')).getAllByText(DEMO_REALTIME_MESSAGE_TEXT.direct)).toHaveLength(1);
  expect(connectionEvents).toEqual([]);
  expect(session.realtime.getStatus()).toBe('connected');
});

test('outgoing UI progresses through sending, acknowledgement, delivered and read with honest simulated labels', async () => {
  const { session } = await renderSession();
  await selectConversation('Ava Morgan');
  const send = jest.spyOn(session.realtime, 'sendMessage');
  const log = screen.getByRole('log');
  const labels = new Set<string>();
  const observer = new MutationObserver(() => {
    for (const label of Array.from(log.querySelectorAll('.message-delivery'))) labels.add(label.textContent ?? '');
  });
  observer.observe(log, { subtree: true, childList: true, characterData: true });
  try {
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to Ava Morgan' }), { target: { value: 'Acknowledgements matter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await within(log).findByText('Read · simulated');
    expect(Array.from(labels)).toEqual(expect.arrayContaining(['Sending', 'Accepted by local demo', 'Delivered · simulated', 'Read · simulated']));
    expect(within(log).getAllByText('Acknowledgements matter')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).not.toHaveProperty('content');
    expect(send.mock.calls[0]![0]).toMatchObject({ senderId: session.user.id, encryption: { scope: 'browser-demo' } });
  } finally { observer.disconnect(); }
});

test('typing expires, supports group peers, clears on navigation/disconnect, and never reflects the local actor', async () => {
  const captured = captureClientListeners();
  const { session } = await renderSession();
  await selectConversation('Ava Morgan');
  const typing: RealtimeEvent = { type: 'typing', conversationId: 'demo-direct-ava', userId: 'demo-ava',
    displayName: 'Ava Morgan', isTyping: true, timestamp: new Date().toISOString() };
  act(() => captured.deliver(session.realtime, typing));
  expect(screen.getByText('Ava Morgan is typing… · simulated')).toBeInTheDocument();
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 6_000);
  try {
    await waitFor(() => expect(screen.queryByText(/Ava Morgan is typing/)).not.toBeInTheDocument(), { timeout: 1_200 });
  } finally { clock.mockRestore(); }
  await selectConversation('Security Study Group');
  act(() => session.realtime.simulateTyping('demo-group-security'));
  expect(screen.getByText('Ava Morgan, Jules Park are typing… · simulated')).toBeInTheDocument();
  await selectConversation('Ava Morgan');
  expect(screen.queryByText(/are typing/)).not.toBeInTheDocument();
  act(() => captured.deliver(session.realtime, { ...typing, userId: session.user.id, displayName: session.user.displayName }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message to Ava Morgan' }), { target: { value: 'Typing locally' } });
  expect(screen.queryByText(/Demo Explorer is typing/)).not.toBeInTheDocument();
  act(() => { session.realtime.simulateTyping('demo-direct-ava'); session.realtime.simulateNetworkFailure(); });
  expect(screen.queryByText(/Ava Morgan is typing/)).not.toBeInTheDocument();
  expect(screen.getByText('Offline · demo')).toBeInTheDocument();
});

test('Friends presence is simulated, updates from the shared session, and becomes unknown while disconnected', async () => {
  const { session } = await renderSession();
  await friends();
  const list = within(screen.getByRole('list', { name: 'Your friends' }));
  expect(list.getByText('Online · simulated')).toBeInTheDocument();
  act(() => session.realtime.simulatePresence('demo-ava', 'away'));
  expect(list.getByText('Away · simulated')).toBeInTheDocument();
  act(() => session.realtime.simulateNetworkFailure());
  expect(list.getByText('Presence unknown')).toBeInTheDocument();
  expect(list.queryByText('Away · simulated')).not.toBeInTheDocument();
  await act(async () => { await session.realtime.simulateReconnect(); });
  expect(list.getByText('Away · simulated')).toBeInTheDocument();
});

test('inactive and hidden active conversations update previews/unread while read signals wait for visible chat', async () => {
  const { session, container } = await renderSession();
  const read = jest.spyOn(session.realtime, 'markRead');
  act(() => { session.realtime.simulateIncoming('demo-direct-ava'); session.realtime.simulateIncoming('demo-group-security'); });
  expect(screen.getByRole('button', { name: /^Ava Morgan, Direct, 1 unread/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Security Study Group, Group, 1 unread/ })).toBeInTheDocument();
  expect(within(screen.getByRole('button', { name: /^Ava Morgan, Direct/ })).getByText(DEMO_REALTIME_MESSAGE_TEXT.direct)).toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
  await selectConversation('Ava Morgan');
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: /^Ava Morgan, Direct, No unread messages/ })).toBeInTheDocument();
  await friends();
  act(() => session.realtime.simulateIncoming('demo-direct-ava'));
  expect(container.querySelector('button[aria-label^="Ava Morgan, Direct"]')).toHaveAttribute('aria-label', expect.stringContaining('1 unread'));
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: /^Ava Morgan, Direct, No unread messages/ })).toBeInTheDocument();
  expect(within(screen.getByRole('log')).getAllByText(DEMO_REALTIME_MESSAGE_TEXT.direct)).toHaveLength(2);
});

test('offline sends preserve drafts without an automatic queue and explicit retry reuses one message identifier', async () => {
  const { session } = await renderSession();
  await selectConversation('Ava Morgan');
  demoControls();
  const send = jest.spyOn(session.realtime, 'sendMessage');
  fireEvent.click(screen.getByRole('button', { name: 'Go offline' }));
  const input = screen.getByRole('textbox', { name: 'Message to Ava Morgan' });
  fireEvent.change(input, { target: { value: 'Keep until explicitly retried' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await within(screen.getByRole('log')).findByText('Not sent')).toBeInTheDocument();
  expect(input).toHaveValue('Keep until explicitly retried');
  expect(screen.getByRole('button', { name: 'Retry unavailable' })).toBeDisabled();
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  await screen.findByText('Connected · demo');
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await within(screen.getByRole('log')).findByText('Read · simulated');
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![0].id).toBe(send.mock.calls[0]![0].id);
  expect(send.mock.calls[1]![0].encryption).toEqual(send.mock.calls[0]![0].encryption);
  expect(within(screen.getByRole('log')).getAllByText('Keep until explicitly retried')).toHaveLength(1);
});

test('malformed and unauthorized events never display, while duplicate and out-of-order incoming IDs reconcile in existing message state', async () => {
  const captured = captureClientListeners();
  const { session } = await renderSession();
  await selectConversation('Ava Morgan');
  const later = incoming('later-message', new Date().toISOString());
  const earlier = incoming('earlier-message', new Date(Date.now() - 60_000).toISOString());
  act(() => {
    captured.deliver(session.realtime, { type: 'message', message: { ...incoming('bad').message, content: 'Unverified private body' } } as RealtimeEvent);
    captured.deliver(session.realtime, { type: 'message', message: { ...incoming('wrong-conversation').message, conversationId: 'unauthorized-conversation' } } as RealtimeEvent);
    captured.deliver(session.realtime, { type: 'message', message: { ...incoming('wrong-sender').message, senderId: 'unrelated-person' } } as RealtimeEvent);
    captured.deliver(session.realtime, later);
    captured.deliver(session.realtime, earlier);
    captured.deliver(session.realtime, earlier);
  });
  const log = screen.getByRole('log');
  expect(within(log).queryByText('Unverified private body')).not.toBeInTheDocument();
  expect(within(log).getAllByText(DEMO_REALTIME_MESSAGE_TEXT.direct)).toHaveLength(2);
  expect(Array.from(log.querySelectorAll('[data-message-id]'), (element) => element.getAttribute('data-message-id')))
    .toEqual(['earlier-message', 'later-message']);
});

test('an encrypted arrival authenticating during navigation is retained but stays unread until its chat is visible', async () => {
  const captured = captureClientListeners();
  const { session, container } = await renderSession();
  await selectConversation('Ava Morgan');
  const header = { id: 'deferred-encrypted-message', conversationId: 'demo-direct-ava', senderId: 'demo-ava',
    senderName: 'Ava Morgan', timestamp: new Date().toISOString(), type: 'text' as const, deliveryStatus: 'delivered' as const };
  const metadata = { ...header, messageId: header.id };
  const context = { localUserId: session.user.id, conversationId: header.conversationId };
  const encrypted = await session.cryptoService.encrypt(context, 'Verified after navigation', metadata);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const decrypt = session.cryptoService.decrypt.bind(session.cryptoService);
  let pending!: Promise<string>;
  const decryptSpy = jest.spyOn(session.cryptoService, 'decrypt').mockImplementation((...args) => {
    pending = gate.then(() => decrypt(...args));
    return pending;
  });
  const read = jest.spyOn(session.realtime, 'markRead');
  act(() => captured.deliver(session.realtime, { type: 'message', message: { ...header, encryption: encrypted } }));
  expect(decryptSpy).toHaveBeenCalledTimes(1);
  expect(within(screen.getByRole('log')).queryByText('Verified after navigation')).not.toBeInTheDocument();
  await friends();
  await act(async () => { release(); await pending; });
  expect(container.querySelector('button[aria-label^="Ava Morgan, Direct"]')).toHaveAttribute('aria-label', expect.stringContaining('1 unread'));
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
  expect(await within(screen.getByRole('log')).findByText('Verified after navigation')).toBeInTheDocument();
  await waitFor(() => expect(read).toHaveBeenCalledWith('demo-direct-ava', header.id));
  expect(screen.getByRole('textbox', { name: 'Message to Ava Morgan' })).toBeEnabled();
  expect(screen.getByRole('button', { name: /^Ava Morgan, Direct, No unread messages/ })).toBeInTheDocument();
});
