import { RealtimeMessagingTransport } from '../RealtimeMessagingTransport';
import { DEMO_REALTIME_MESSAGE_TEXT, RealtimeOperationError, type RealtimeClient, type RealtimeConnectionStatus, type RealtimeEvent } from '../realtimeModel';
import type { OutboundMessage, TransportMode } from '@/messaging/messageModel';
import type { MessagingTransportHandlers } from '@/messaging/transport';
import { createDemoConversations } from '@/conversations/demoConversations';

const timestamp = '2026-11-09T12:00:00.000Z';
const outbound: OutboundMessage = {
  id: 'client-message-1', conversationId: 'demo-direct-ava', senderId: 'local-user', senderName: 'You', timestamp,
  type: 'text', encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', scope: 'browser-demo',
    iv: btoa('123456789012'), ciphertext: btoa('12345678901234567') },
};
function handlers(): MessagingTransportHandlers {
  return { onMessage: jest.fn(), onDeliveryStatus: jest.fn(), onPresenceUpdate: jest.fn(), onSecurityAlert: jest.fn(),
    onConnectionChange: jest.fn(), onTypingUpdate: jest.fn() };
}
class Client implements RealtimeClient {
  mode: TransportMode = 'local-demo';
  actorId = 'local-user';
  canSendMessages = true;
  status: RealtimeConnectionStatus = 'connected';
  private listeners = new Set<(event: RealtimeEvent) => void>();
  connect = jest.fn(async () => { this.status = 'connected'; });
  disconnect = jest.fn();
  dispose = jest.fn();
  getStatus = () => this.status;
  sendMessage = jest.fn(async (message: OutboundMessage) => ({ conversationId: message.conversationId, messageId: message.id, status: 'sent' as const, timestamp }));
  sendTyping = jest.fn();
  markRead = jest.fn(async () => undefined);
  watchConversations = jest.fn();
  watchPresence = jest.fn();
  subscribe(listener: (event: RealtimeEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: RealtimeEvent) { for (const listener of this.listeners) listener(event); }
}

describe('RealtimeMessagingTransport', () => {
  test('adapts canonical conversations without owning or disconnecting the session client', async () => {
    const client = new Client();
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    expect(client.watchConversations).toHaveBeenCalledWith(['securebot-demo', 'demo-direct-ava', 'demo-group-security']);
    const listener = handlers();
    const unsubscribe = bridge.subscribeToConversation(outbound.conversationId, listener);
    await bridge.connect(outbound.conversationId);
    await bridge.disconnect(outbound.conversationId);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(listener.onConnectionChange).toHaveBeenCalledWith('connected');
    unsubscribe();
    client.emit({ type: 'typing', conversationId: outbound.conversationId, userId: 'demo-ava', displayName: 'Ava Morgan', isTyping: true, timestamp });
    expect(listener.onTypingUpdate).not.toHaveBeenCalled();
    bridge.dispose();
  });

  test('starts only the first disconnected activation and never reconnects an offline session during navigation', async () => {
    const client = new Client(); client.status = 'disconnected';
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    await bridge.connect(outbound.conversationId);
    expect(client.connect).toHaveBeenCalledTimes(1);
    client.status = 'disconnected';
    await bridge.disconnect(outbound.conversationId);
    await bridge.connect('securebot-demo');
    await bridge.connect('demo-group-security');
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(bridge.getConnectionStatus()).toBe('disconnected');
    bridge.dispose();
  });

  test('does not bypass a connecting or reconnecting session owner when first attaching', async () => {
    for (const status of ['connecting', 'reconnecting'] as const) {
      const client = new Client(); client.status = status;
      const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
      await bridge.connect(outbound.conversationId);
      await bridge.connect('securebot-demo');
      expect(client.connect).not.toHaveBeenCalled();
      expect(bridge.getConnectionStatus()).toBe(status);
      bridge.dispose();
    }
  });

  test('concurrent first activations share the same physical connection attempt', async () => {
    const client = new Client(); client.status = 'disconnected';
    let resolve!: () => void;
    client.connect.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    const first = bridge.connect(outbound.conversationId), second = bridge.connect('securebot-demo');
    expect(client.connect).toHaveBeenCalledTimes(1);
    client.status = 'connected'; resolve();
    await Promise.all([first, second]);
    bridge.dispose();
  });

  test('routes only validated known-participant messages and rejects fake plaintext from a real transport', () => {
    const client = new Client();
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    const listener = handlers();
    bridge.subscribeToConversation(outbound.conversationId, listener);
    const message = { id: 'incoming', conversationId: outbound.conversationId, senderId: 'demo-ava', senderName: 'Ava Morgan', timestamp,
      type: 'text' as const, deliveryStatus: 'delivered' as const, demoOnly: true as const, content: DEMO_REALTIME_MESSAGE_TEXT.direct };
    client.emit({ type: 'message', message });
    expect(listener.onMessage).toHaveBeenCalledTimes(1);
    client.emit({ type: 'message', message: { ...message, senderId: 'unrelated' } });
    client.emit({ type: 'message', message: { ...message, content: '<untrusted>' } });
    expect(listener.onMessage).toHaveBeenCalledTimes(1);
    bridge.dispose();
    client.mode = 'realtime';
    const real = new RealtimeMessagingTransport(client, createDemoConversations());
    real.subscribeToConversation(outbound.conversationId, listener);
    client.emit({ type: 'message', message });
    expect(listener.onMessage).toHaveBeenCalledTimes(1);
    real.dispose();
  });

  test('does not settle a send until a matching acknowledgement; receipts require a known send and peer', async () => {
    const client = new Client();
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    const listener = handlers();
    bridge.subscribeToConversation(outbound.conversationId, listener);
    const receipt = { type: 'receipt' as const, conversationId: outbound.conversationId, messageId: outbound.id, status: 'read' as const, userId: 'demo-ava', timestamp };
    client.emit(receipt);
    expect(listener.onDeliveryStatus).not.toHaveBeenCalled();
    let resolve!: (value: { conversationId: string; messageId: string; status: 'sent'; timestamp: string }) => void;
    client.sendMessage.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    let accepted = false;
    const first = bridge.sendMessage(outbound).then(() => { accepted = true; });
    const second = bridge.sendMessage(outbound);
    await Promise.resolve();
    expect(accepted).toBe(false);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    resolve({ conversationId: outbound.conversationId, messageId: outbound.id, status: 'sent', timestamp });
    await Promise.all([first, second]);
    client.emit({ ...receipt, userId: 'unrelated' });
    client.emit({ ...receipt, userId: client.actorId });
    expect(listener.onDeliveryStatus).not.toHaveBeenCalled();
    client.emit(receipt);
    expect(listener.onDeliveryStatus).toHaveBeenCalledWith({ messageId: outbound.id, status: 'read' });
    bridge.dispose();
  });

  test('rejects changed metadata or ciphertext for a pending duplicate instead of sharing its success', async () => {
    const client = new Client();
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    let resolve!: (value: { conversationId: string; messageId: string; status: 'sent'; timestamp: string }) => void;
    client.sendMessage.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const original = bridge.sendMessage(outbound);
    const identical = bridge.sendMessage({ ...outbound, encryption: { ...outbound.encryption } });
    await expect(bridge.sendMessage({ ...outbound, senderName: 'Changed name' })).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(bridge.sendMessage({ ...outbound, encryption: { ...outbound.encryption, ciphertext: btoa('different encrypted bytes') } })).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    resolve({ conversationId: outbound.conversationId, messageId: outbound.id, status: 'sent', timestamp });
    await Promise.all([original, identical]);
    bridge.dispose();
  });

  test('an explicit retry preserves the exact original encrypted envelope and authenticated metadata', async () => {
    const client = new Client();
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    client.sendMessage.mockRejectedValueOnce(new RealtimeOperationError('send_failed', true));
    await expect(bridge.sendMessage(outbound)).rejects.toMatchObject({ code: 'send_failed' });
    await expect(bridge.sendMessage({ ...outbound, timestamp: '2026-11-09T12:00:01.000Z' })).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    await expect(bridge.sendMessage({ ...outbound, encryption: { ...outbound.encryption } })).resolves.toBeUndefined();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls[1]?.[0]).toEqual(outbound);
    bridge.dispose();
  });

  test('a throwing initial or event subscriber cannot interrupt another view or prevent cleanup', async () => {
    const client = new Client();
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    const bad = handlers(), good = handlers();
    const fail = () => { throw new Error('View failure'); };
    bad.onConnectionChange = fail; bad.onPresenceUpdate = fail; bad.onDeliveryStatus = fail; bad.onTypingUpdate = fail;
    bad.onMessage = (message) => { message.senderName = 'Mutated by a view'; throw new Error('View failure'); };
    let unsubscribe!: () => void;
    expect(() => { unsubscribe = bridge.subscribeToConversation(outbound.conversationId, bad); }).not.toThrow();
    bridge.subscribeToConversation(outbound.conversationId, good);
    good.onConnectionChange = jest.fn();
    await bridge.sendMessage(outbound);
    expect(() => {
      client.emit({ type: 'message', message: { id: 'incoming-isolated', conversationId: outbound.conversationId,
        senderId: 'demo-ava', senderName: 'Ava Morgan', timestamp, type: 'text', deliveryStatus: 'delivered', demoOnly: true,
        content: DEMO_REALTIME_MESSAGE_TEXT.direct } });
      client.emit({ type: 'receipt', conversationId: outbound.conversationId, messageId: outbound.id, status: 'delivered', userId: 'demo-ava', timestamp });
      client.emit({ type: 'typing', conversationId: outbound.conversationId, userId: 'demo-ava', displayName: 'Ava Morgan', isTyping: true, timestamp });
      client.emit({ type: 'presence', userId: 'demo-ava', status: 'away', timestamp });
      client.emit({ type: 'connection', status: 'disconnected' });
    }).not.toThrow();
    expect(good.onMessage).toHaveBeenCalledWith(expect.objectContaining({ senderName: 'Ava Morgan' }));
    expect(good.onDeliveryStatus).toHaveBeenCalledWith({ messageId: outbound.id, status: 'delivered' });
    expect(good.onTypingUpdate).toHaveBeenCalledTimes(1);
    expect(good.onConnectionChange).toHaveBeenCalledWith('disconnected');
    expect(good.onPresenceUpdate).toHaveBeenCalledWith('away');
    expect(good.onPresenceUpdate).toHaveBeenCalledWith(undefined);
    unsubscribe(); bridge.dispose();
  });

  test('retries only definitely retryable failures, at most three attempts, and rejects mismatched acknowledgements', async () => {
    const client = new Client();
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    client.sendMessage.mockRejectedValue(new RealtimeOperationError('send_failed', true));
    for (let attempt = 0; attempt < 3; attempt++) await expect(bridge.sendMessage(outbound)).rejects.toMatchObject({ code: 'send_failed' });
    expect(bridge.canRetryMessage(outbound.conversationId, outbound.id)).toBe(false);
    await expect(bridge.sendMessage(outbound)).rejects.toMatchObject({ code: 'send_failed' });
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    client.sendMessage.mockRejectedValueOnce(new RealtimeOperationError('ack_timeout'));
    await expect(bridge.sendMessage({ ...outbound, id: 'ambiguous' })).rejects.toMatchObject({ code: 'ack_timeout' });
    expect(bridge.canRetryMessage(outbound.conversationId, 'ambiguous')).toBe(false);
    client.sendMessage.mockResolvedValueOnce({ conversationId: 'another-conversation', messageId: outbound.id, status: 'sent', timestamp });
    await expect(bridge.sendMessage({ ...outbound, id: 'mismatch' })).rejects.toMatchObject({ code: 'invalid_payload' });
    bridge.dispose();
  });

  test('blocks real sends and stale sessions without forwarding plaintext or browser-demo ciphertext', async () => {
    const client = new Client();
    client.mode = 'realtime'; client.canSendMessages = false;
    const bridge = new RealtimeMessagingTransport(client, createDemoConversations());
    await expect(bridge.sendMessage(outbound)).rejects.toMatchObject({ code: 'recipient_keys_unavailable' });
    await expect(bridge.sendMessage({ ...outbound, conversationId: 'unknown' })).rejects.toMatchObject({ code: 'unauthorized_conversation' });
    expect(client.sendMessage).not.toHaveBeenCalled();
    bridge.dispose(); bridge.dispose();
    await expect(bridge.sendMessage(outbound)).rejects.toMatchObject({ code: 'session_ended' });
    await expect(bridge.connect(outbound.conversationId)).rejects.toMatchObject({ code: 'session_ended' });
  });
});
