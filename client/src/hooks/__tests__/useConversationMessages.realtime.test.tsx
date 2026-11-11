import { act, renderHook } from '@testing-library/react';
import { useConversationMessages } from '../useConversationMessages';
import type { ConnectionStatus, EncryptedIncomingMessage, IncomingMessage, OutboundMessage, TransportMode } from '@/messaging/messageModel';
import type { MessagingTransport, MessagingTransportHandlers, TypingUpdate } from '@/messaging/transport';
import type { ConversationCryptoService } from '@/security/conversationCryptoService';
import type { ConversationKeyContext } from '@/security/keyManagement';
import type { CryptoMessageContext, EncryptedMessagePayload } from '@/utils/crypto';

const payload: EncryptedMessagePayload = {
  version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

class RealtimeTestTransport implements MessagingTransport {
  constructor(readonly mode: TransportMode = 'realtime') {}
  canSendMessages = true;
  canConfirmDelivery = false;
  readonly confirmDelivery = jest.fn(async (_message: EncryptedIncomingMessage) => undefined);
  private status: ConnectionStatus = 'connected';
  private readonly subscriptions = new Map<string, Set<MessagingTransportHandlers>>();
  readonly connect = jest.fn(async (_conversationId: string) => undefined);
  readonly disconnect = jest.fn(async (_conversationId: string) => undefined);
  readonly sendMessage = jest.fn(async (_message: OutboundMessage) => undefined);
  readonly sendTyping = jest.fn((_conversationId: string, _isTyping: boolean) => undefined);
  readonly markRead = jest.fn(async (_conversationId: string, _messageId: string) => undefined);
  readonly getConnectionStatus = () => this.status;
  readonly subscribeToConversation = jest.fn((conversationId: string, handlers: MessagingTransportHandlers) => {
    const listeners = this.subscriptions.get(conversationId) ?? new Set<MessagingTransportHandlers>();
    listeners.add(handlers); this.subscriptions.set(conversationId, listeners);
    handlers.onConnectionChange(this.status);
    return () => {
      listeners.delete(handlers);
      if (!listeners.size) this.subscriptions.delete(conversationId);
    };
  });
  message(message: IncomingMessage) {
    this.subscriptions.get(message.conversationId)?.forEach((handler) => handler.onMessage(message));
  }
  typing(update: TypingUpdate, conversationId = 'conversation-a') {
    this.subscriptions.get(conversationId)?.forEach((handler) => handler.onTypingUpdate?.(update));
  }
  connection(status: ConnectionStatus) {
    this.status = status;
    for (const listeners of this.subscriptions.values()) for (const handler of listeners) handler.onConnectionChange(status);
  }
}

function cryptoFixture() {
  return {
    prepareConversation: jest.fn(async (_context: ConversationKeyContext) => ({
      browserCryptoAvailable: true, localEncryptionAvailable: true, recipientKeyAvailable: false,
      authenticatedKeyExchangeEstablished: false,
    })),
    encrypt: jest.fn(async (_context: ConversationKeyContext, _plaintext: string, _metadata: CryptoMessageContext) => payload),
    decrypt: jest.fn(async (_context: ConversationKeyContext, _payload: unknown, _metadata: CryptoMessageContext) => 'Authenticated reply'),
  } satisfies ConversationCryptoService;
}

function encrypted(id: string, conversationId = 'conversation-a'): EncryptedIncomingMessage {
  return {
    id, conversationId, senderId: 'peer', senderName: 'Peer', timestamp: new Date().toISOString(),
    type: 'text', deliveryStatus: 'delivered', encryption: payload,
  };
}
function typing(overrides: Partial<TypingUpdate> = {}): TypingUpdate {
  return { userId: 'peer', displayName: 'Peer', isTyping: true, timestamp: new Date().toISOString(), ...overrides };
}

async function mount({ visible = true, transport = new RealtimeTestTransport(), cryptoService = cryptoFixture() } = {}) {
  const view = renderHook((props: { conversationId: string; presentationActive: boolean }) => useConversationMessages({
    ...props, currentUserId: 'actor', currentUserName: 'Actor', conversationIds: ['conversation-a', 'conversation-b'],
    transport, cryptoService,
  }), { initialProps: { conversationId: 'conversation-a', presentationActive: visible } });
  await act(async () => { await Promise.resolve(); });
  expect(view.result.current.connectionStatus).toBe('connected');
  return { ...view, transport, cryptoService };
}

let pageVisibility: DocumentVisibilityState;
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
  pageVisibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => pageVisibility });
});
afterEach(() => {
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else Reflect.deleteProperty(document, 'visibilityState');
  jest.useRealTimers();
});
function visibility(next: DocumentVisibilityState) {
  act(() => { pageVisibility = next; document.dispatchEvent(new Event('visibilitychange')); });
}

describe('gated, authenticated delivery is separate from read', () => {
  test('confirms only after decryption, including hidden conversations; visibility controls reads separately', async () => {
    const transport = new RealtimeTestTransport(); transport.canConfirmDelivery = true;
    const cryptoService = cryptoFixture();
    let release!: (text: string) => void;
    cryptoService.decrypt.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { rerender } = await mount({ visible: false, transport, cryptoService });
    const incoming = encrypted('verified');
    act(() => transport.message(incoming));
    expect(transport.confirmDelivery).not.toHaveBeenCalled();
    await act(async () => { release('Authenticated reply'); });
    expect(transport.confirmDelivery).toHaveBeenCalledTimes(1);
    expect(transport.confirmDelivery).toHaveBeenCalledWith(incoming);
    expect(JSON.stringify(transport.confirmDelivery.mock.calls)).not.toContain('Authenticated reply');
    expect(transport.markRead).not.toHaveBeenCalled();
    await act(async () => { transport.message(incoming); rerender({ conversationId: 'conversation-a', presentationActive: true }); });
    expect(transport.confirmDelivery).toHaveBeenCalledTimes(1);
    expect(transport.markRead).toHaveBeenCalledWith('conversation-a', 'verified');
  });

  test('failed authentication displays only a safe notice, without delivery or read confirmation', async () => {
    const transport = new RealtimeTestTransport(); transport.canConfirmDelivery = true;
    const cryptoService = cryptoFixture(); cryptoService.decrypt.mockRejectedValueOnce(new Error('unverified sensitive content'));
    const { result } = await mount({ transport, cryptoService });
    await act(async () => { transport.message(encrypted('tampered')); });
    expect(transport.confirmDelivery).not.toHaveBeenCalled();
    expect(transport.markRead).not.toHaveBeenCalled();
    expect(result.current.messages.every((message) => message.type === 'security_alert')).toBe(true);
    expect(JSON.stringify(result.current.messages)).not.toContain('sensitive');
  });

  test('confirmation failure does not erase authenticated text, produce a receipt, or retry', async () => {
    const transport = new RealtimeTestTransport(); transport.canConfirmDelivery = true;
    transport.confirmDelivery.mockRejectedValueOnce(new Error('unavailable'));
    const { result } = await mount({ visible: false, transport });
    await act(async () => { transport.message(encrypted('failure')); });
    expect(result.current.messages.find((message) => message.id === 'failure')?.content).toBe('Authenticated reply');
    expect(transport.confirmDelivery).toHaveBeenCalledTimes(1);
    expect(transport.markRead).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(transport.confirmDelivery).toHaveBeenCalledTimes(1);
  });

  test('unmount/session replacement discards late decryption and does not confirm it', async () => {
    const transport = new RealtimeTestTransport(); transport.canConfirmDelivery = true;
    const cryptoService = cryptoFixture();
    let release!: (text: string) => void;
    cryptoService.decrypt.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { unmount } = await mount({ transport, cryptoService });
    act(() => transport.message(encrypted('stale'))); unmount();
    await act(async () => { release('old identity text'); });
    expect(transport.confirmDelivery).not.toHaveBeenCalled();
  });

  test.each(['realtime', 'local-demo'] as const)('does not confirm through the default or demo transport: %s', async (mode) => {
    const transport = new RealtimeTestTransport(mode);
    if (mode === 'local-demo') transport.canConfirmDelivery = true;
    await mount({ transport });
    await act(async () => { transport.message(encrypted('not-enabled')); });
    expect(transport.confirmDelivery).not.toHaveBeenCalled();
  });
});

describe('outgoing ephemeral typing', () => {
  test('starts once, throttles bursts, refreshes a sustained session, and stops after inactivity', async () => {
    const { result, transport } = await mount();
    act(() => { result.current.notifyTypingActivity(); result.current.notifyTypingActivity(); });
    expect(transport.sendTyping.mock.calls).toEqual([['conversation-a', true]]);
    for (let index = 0; index < 3; index += 1) {
      act(() => { jest.advanceTimersByTime(700); result.current.notifyTypingActivity(); });
    }
    expect(transport.sendTyping.mock.calls).toEqual([['conversation-a', true], ['conversation-a', true]]);
    act(() => jest.advanceTimersByTime(1_499));
    expect(transport.sendTyping).toHaveBeenCalledTimes(2);
    act(() => jest.advanceTimersByTime(1));
    expect(transport.sendTyping).toHaveBeenLastCalledWith('conversation-a', false);
    act(() => jest.advanceTimersByTime(10_000));
    expect(transport.sendTyping).toHaveBeenCalledTimes(3);
  });

  test('the explicit stop used for empty input and blur is immediate and idempotent', async () => {
    const { result, transport } = await mount();
    act(() => { result.current.notifyTypingActivity(); result.current.stopTyping(); result.current.stopTyping(); });
    expect(transport.sendTyping.mock.calls).toEqual([['conversation-a', true], ['conversation-a', false]]);
    act(() => jest.advanceTimersByTime(5_000));
    expect(transport.sendTyping).toHaveBeenCalledTimes(2);
    act(() => result.current.notifyTypingActivity());
    expect(transport.sendTyping).toHaveBeenLastCalledWith('conversation-a', true);
  });

  test('hiding the conversation or page stops typing and suppresses further activity without reinitializing crypto', async () => {
    const { result, transport, rerender, cryptoService } = await mount();
    act(() => result.current.notifyTypingActivity());
    rerender({ conversationId: 'conversation-a', presentationActive: false });
    expect(transport.sendTyping).toHaveBeenLastCalledWith('conversation-a', false);
    const count = transport.sendTyping.mock.calls.length;
    act(() => result.current.notifyTypingActivity());
    expect(transport.sendTyping).toHaveBeenCalledTimes(count);
    rerender({ conversationId: 'conversation-a', presentationActive: true });
    act(() => result.current.notifyTypingActivity());
    visibility('hidden');
    expect(transport.sendTyping).toHaveBeenLastCalledWith('conversation-a', false);
    const hiddenCount = transport.sendTyping.mock.calls.length;
    act(() => result.current.notifyTypingActivity());
    expect(transport.sendTyping).toHaveBeenCalledTimes(hiddenCount);
    expect(cryptoService.prepareConversation).toHaveBeenCalledTimes(1);
  });

  test('conversation switches stop the previous signal; disconnect and unmount cancel pending activity', async () => {
    const { result, transport, rerender, unmount } = await mount();
    act(() => result.current.notifyTypingActivity());
    await act(async () => { rerender({ conversationId: 'conversation-b', presentationActive: true }); });
    expect(transport.sendTyping).toHaveBeenLastCalledWith('conversation-a', false);
    act(() => { result.current.notifyTypingActivity(); transport.typing(typing(), 'conversation-b'); });
    expect(result.current.typingUsers).toHaveLength(1);
    expect(result.current.typingUsers[0]).toMatchObject({ userId: 'peer', displayName: 'Peer' });
    act(() => transport.connection('reconnecting'));
    expect(transport.sendTyping).toHaveBeenLastCalledWith('conversation-b', false);
    expect(result.current.typingUsers).toEqual([]);
    const offlineCount = transport.sendTyping.mock.calls.length;
    act(() => result.current.notifyTypingActivity());
    expect(transport.sendTyping).toHaveBeenCalledTimes(offlineCount);
    act(() => transport.connection('connected'));
    act(() => result.current.notifyTypingActivity());
    unmount();
    expect(transport.sendTyping).toHaveBeenLastCalledWith('conversation-b', false);
    const unmountedCount = transport.sendTyping.mock.calls.length;
    act(() => jest.advanceTimersByTime(10_000));
    expect(transport.sendTyping).toHaveBeenCalledTimes(unmountedCount);
  });
});

describe('incoming typing lifetime and ordering', () => {
  test('equal/older starts do not extend a five-second lifetime; equal-time stop wins over replayed start', async () => {
    const { result, transport } = await mount();
    const first = typing();
    act(() => transport.typing(first));
    expect(result.current.typingUsers).toHaveLength(1);
    act(() => jest.advanceTimersByTime(4_000));
    act(() => {
      transport.typing(first);
      transport.typing({ ...first, isTyping: false, timestamp: new Date(Date.parse(first.timestamp) - 1).toISOString() });
    });
    expect(result.current.typingUsers).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1_001));
    expect(result.current.typingUsers).toEqual([]);
    const second = typing();
    act(() => { transport.typing(second); transport.typing({ ...second, isTyping: false }); transport.typing(second); });
    expect(result.current.typingUsers).toEqual([]);
    act(() => transport.typing({ ...second, timestamp: new Date(Date.parse(second.timestamp) + 1).toISOString() }));
    expect(result.current.typingUsers).toHaveLength(1);
    act(() => transport.typing({ ...second, isTyping: false }));
    expect(result.current.typingUsers).toHaveLength(1);
  });

  test('own, hidden, wrong-conversation, malformed, too-old and excessive-future signals do not appear', async () => {
    const { result, transport, rerender } = await mount();
    act(() => {
      transport.typing(typing({ userId: 'actor', displayName: 'Actor' }));
      transport.typing(typing(), 'conversation-b');
      transport.typing(typing({ timestamp: 'not-a-timestamp' }));
      transport.typing(typing({ timestamp: new Date(Date.now() - 5_001).toISOString() }));
      transport.typing(typing({ timestamp: new Date(Date.now() + 60_001).toISOString() }));
    });
    expect(result.current.typingUsers).toEqual([]);
    rerender({ conversationId: 'conversation-a', presentationActive: false });
    act(() => transport.typing(typing()));
    expect(result.current.typingUsers).toEqual([]);
    rerender({ conversationId: 'conversation-a', presentationActive: true });
    visibility('hidden');
    act(() => transport.typing(typing()));
    expect(result.current.typingUsers).toEqual([]);
  });
});

describe('read signals and the real-send security boundary', () => {
  test('a valid encrypted incoming envelope with read delivery status still authenticates and renders', async () => {
    const { result, transport, cryptoService } = await mount();
    await act(async () => {
      transport.message({ ...encrypted('already-read-encrypted'), deliveryStatus: 'read' });
      await Promise.resolve();
    });
    expect(cryptoService.decrypt).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toEqual([expect.objectContaining({
      id: 'already-read-encrypted', content: 'Authenticated reply', deliveryStatus: 'read',
      encryption: expect.objectContaining({ scope: 'browser-demo' }),
    })]);
  });

  test('an explicit local demo incoming message with read delivery status renders without remote decryption', async () => {
    const transport = new RealtimeTestTransport('local-demo');
    const { result, cryptoService } = await mount({ transport });
    await act(async () => {
      transport.message({ id: 'already-read-demo', conversationId: 'conversation-a', senderId: 'peer',
        senderName: 'Peer', timestamp: new Date().toISOString(), type: 'text', deliveryStatus: 'read',
        demoOnly: true, content: 'Explicit local demo reply' });
      await Promise.resolve();
    });
    expect(cryptoService.decrypt).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([expect.objectContaining({
      id: 'already-read-demo', content: 'Explicit local demo reply', deliveryStatus: 'read', demoOnly: true,
    })]);
  });

  test('authenticates before requesting read and sends it only while the conversation is visible and connected', async () => {
    const { result, transport, rerender } = await mount({ visible: false });
    await act(async () => { transport.message(encrypted('read-after-show')); await Promise.resolve(); });
    expect(result.current.messages).toHaveLength(1);
    expect(transport.markRead).not.toHaveBeenCalled();
    rerender({ conversationId: 'conversation-a', presentationActive: true });
    expect(transport.markRead).toHaveBeenCalledWith('conversation-a', 'read-after-show');
    rerender({ conversationId: 'conversation-a', presentationActive: false });
    await act(async () => { transport.message(encrypted('read-after-reconnect')); await Promise.resolve(); });
    act(() => transport.connection('disconnected'));
    rerender({ conversationId: 'conversation-a', presentationActive: true });
    expect(transport.markRead).toHaveBeenCalledTimes(1);
    act(() => transport.connection('connected'));
    expect(transport.markRead).toHaveBeenCalledTimes(2);
    expect(transport.markRead).toHaveBeenLastCalledWith('conversation-a', 'read-after-reconnect');
    await act(async () => { transport.message(encrypted('read-after-reconnect')); await Promise.resolve(); });
    expect(transport.markRead).toHaveBeenCalledTimes(2);
  });

  test('a hidden document defers read until foreground visibility returns', async () => {
    const { transport } = await mount();
    visibility('hidden');
    await act(async () => { transport.message(encrypted('background')); await Promise.resolve(); });
    expect(transport.markRead).not.toHaveBeenCalled();
    visibility('visible');
    expect(transport.markRead).toHaveBeenCalledWith('conversation-a', 'background');
  });

  test('authentication failure exposes no plaintext and never generates a read acknowledgement', async () => {
    const cryptoService = cryptoFixture();
    cryptoService.decrypt.mockRejectedValueOnce(new Error('unverified plaintext must remain private'));
    const { result, transport } = await mount({ cryptoService });
    await act(async () => { transport.message(encrypted('bad-auth')); await Promise.resolve(); });
    expect(result.current.messages).toEqual([expect.objectContaining({ type: 'security_alert',
      content: 'An encrypted message failed authentication and was discarded.' })]);
    expect(transport.markRead).not.toHaveBeenCalled();
    expect(JSON.stringify(result.current.messages)).not.toContain('unverified plaintext');
  });

  test('an unconfirmed read write is not automatically retried by rerender or reconnect', async () => {
    const transport = new RealtimeTestTransport();
    transport.markRead.mockRejectedValue(new Error('unconfirmed write'));
    const { rerender } = await mount({ transport });
    await act(async () => { transport.message(encrypted('ambiguous-read')); await Promise.resolve(); });
    expect(transport.markRead).toHaveBeenCalledTimes(1);
    rerender({ conversationId: 'conversation-a', presentationActive: false });
    act(() => transport.connection('reconnecting'));
    rerender({ conversationId: 'conversation-a', presentationActive: true });
    act(() => transport.connection('connected'));
    expect(transport.markRead).toHaveBeenCalledTimes(1);
  });

  test('a real transport with sending disabled rejects before encryption, local message state, or dispatch', async () => {
    const transport = new RealtimeTestTransport();
    transport.canSendMessages = false;
    const { result, cryptoService } = await mount({ transport });
    let accepted = true;
    await act(async () => { accepted = await result.current.sendMessage('must not leave the browser'); });
    expect(accepted).toBe(false);
    expect(cryptoService.encrypt).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.isSending).toBe(false);
    await act(async () => { expect(await result.current.retryMessage('unavailable-id')).toBe(false); });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });
});
