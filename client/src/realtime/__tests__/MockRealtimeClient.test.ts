import { createDemoConversations } from '@/conversations/demoConversations';
import { createDemoProfile } from '@/profiles/profileModel';
import type { OutboundMessage } from '@/messaging/messageModel';
import { MockRealtimeClient, type MockRealtimeClientOptions } from '../MockRealtimeClient';
import { DEMO_REALTIME_MESSAGE_TEXT, type RealtimeEvent } from '../realtimeModel';

const user = createDemoProfile();
const timestamp = '2026-11-09T12:00:00.000Z';
const message: OutboundMessage = { id: 'message-1', conversationId: 'securebot-demo', senderId: user.id,
  senderName: user.displayName, timestamp, type: 'text', encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64',
    iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAA=', scope: 'browser-demo' } };
const clients: MockRealtimeClient[] = [];

function client(options: Partial<MockRealtimeClientOptions> = {}) {
  const created = new MockRealtimeClient({ user, conversations: createDemoConversations(Date.parse(timestamp), user), ...options });
  clients.push(created);
  return created;
}

async function connect(created: MockRealtimeClient) {
  const operation = created.connect();
  jest.advanceTimersByTime(20);
  await operation;
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(timestamp)); });
afterEach(() => { for (const created of clients.splice(0)) created.dispose(); jest.restoreAllMocks(); jest.useRealTimers(); });

describe('MockRealtimeClient lifecycle and explicit simulations', () => {
  test('coalesces repeated connection attempts and emits no redundant connected updates', async () => {
    const created = client();
    const listener = jest.fn(); created.subscribe(listener);
    const first = created.connect(), second = created.connect();
    expect(first).toBe(second);
    expect(created.getStatus()).toBe('connecting');
    jest.advanceTimersByTime(20);
    await first; await created.connect();
    expect(listener.mock.calls.map(([event]: [RealtimeEvent]) => event)).toEqual([
      { type: 'connection', status: 'connecting' }, { type: 'connection', status: 'connected' },
    ]);
  });

  test('acknowledges once before separate simulated delivery/read receipts and a static SecureBot reply', async () => {
    const created = client(); await connect(created);
    const events: RealtimeEvent[] = []; created.subscribe((event) => events.push(event));
    const sent = created.sendMessage(message);
    const duplicate = created.sendMessage({ ...message, encryption: { ...message.encryption } });
    jest.advanceTimersByTime(19);
    expect(events).toEqual([]);
    jest.advanceTimersByTime(1);
    const acknowledgement = await sent;
    expect(acknowledgement.status).toBe('sent');
    expect(await duplicate).toEqual(acknowledgement);
    expect(events.filter((event) => event.type === 'receipt').map((event) => event.status)).toEqual(['sent']);
    jest.advanceTimersByTime(80);
    expect(events.filter((event) => event.type === 'receipt').map((event) => event.status)).toEqual(['sent', 'delivered']);
    jest.advanceTimersByTime(120);
    expect(events.filter((event) => event.type === 'receipt').map((event) => event.status)).toEqual(['sent', 'delivered', 'read']);
    jest.advanceTimersByTime(380);
    const replies = events.filter((event) => event.type === 'message');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.message).toMatchObject({ demoOnly: true, senderId: 'securebot-demo', content: DEMO_REALTIME_MESSAGE_TEXT.bot });
    expect(JSON.stringify(events)).not.toContain(message.encryption.ciphertext);
    const eventCount = events.length;
    acknowledgement.messageId = 'external-mutation';
    expect((await created.sendMessage(message)).messageId).toBe(message.id);
    expect(events).toHaveLength(eventCount);
  });

  test('rejects duplicate IDs with changed payloads instead of treating them as another send', async () => {
    const created = client({ autoReply: false }); await connect(created);
    const pending = created.sendMessage(message);
    await expect(created.sendMessage({ ...message, senderName: 'Different authenticated metadata' })).rejects.toMatchObject({ code: 'invalid_payload' });
    jest.advanceTimersByTime(20); await pending;
    await expect(created.sendMessage({ ...message, encryption: { ...message.encryption, iv: 'AQEBAQEBAQEBAQEB' } })).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  test('validates actor, conversation, encrypted envelope, and connection before scheduling work', async () => {
    const created = client();
    await expect(created.sendMessage(message)).rejects.toMatchObject({ code: 'disconnected' });
    await connect(created);
    await expect(created.sendMessage({ ...message, senderId: 'another-actor' })).rejects.toMatchObject({ code: 'authentication_rejected' });
    await expect(created.sendMessage({ ...message, conversationId: 'unavailable' })).rejects.toMatchObject({ code: 'unauthorized_conversation' });
    await expect(created.sendMessage({ ...message, content: 'not-allowed' } as OutboundMessage)).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ordinary person and group sends never fabricate automatic remote replies', async () => {
    const created = client(); await connect(created);
    const events: RealtimeEvent[] = []; created.subscribe((event) => events.push(event));
    const first = created.sendMessage({ ...message, id: 'direct-message', conversationId: 'demo-direct-ava' });
    const second = created.sendMessage({ ...message, id: 'group-message', conversationId: 'demo-group-security' });
    jest.advanceTimersByTime(1_000); await first; await second;
    expect(events.filter((event) => event.type === 'message')).toEqual([]);
    created.simulateIncoming('demo-direct-ava');
    created.simulateIncoming('demo-group-security');
    const incoming = events.filter((event) => event.type === 'message');
    expect(incoming.map((event) => 'content' in event.message ? event.message.content : '')).toEqual([DEMO_REALTIME_MESSAGE_TEXT.direct, DEMO_REALTIME_MESSAGE_TEXT.group]);
    expect(incoming.every((event) => 'demoOnly' in event.message && event.message.demoOnly)).toBe(true);
  });

  test('multiple group peers can type with an explicit stop and own typing never appears as a peer', async () => {
    const created = client(); await connect(created);
    const events: RealtimeEvent[] = []; created.subscribe((event) => events.push(event));
    created.sendTyping('demo-group-security', true);
    expect(events).toEqual([]);
    created.simulateTyping('demo-group-security');
    const starts = events.filter((event) => event.type === 'typing');
    expect(starts.map((event) => event.userId)).toEqual(['demo-ava', 'demo-jules']);
    expect(starts.every((event) => event.isTyping && event.userId !== user.id)).toBe(true);
    jest.advanceTimersByTime(1_200);
    expect(events.filter((event) => event.type === 'typing' && !event.isTyping)).toHaveLength(2);
  });

  test('presence is emitted only for watched known demo peers and never the actor', async () => {
    const created = client();
    const events: RealtimeEvent[] = []; created.subscribe((event) => events.push(event));
    created.watchPresence(['demo-ava', user.id, 'unrelated-private-user']);
    expect(events).toEqual([]);
    await connect(created);
    expect(events.filter((event) => event.type === 'presence')).toEqual([
      expect.objectContaining({ userId: 'demo-ava', status: 'online' }),
    ]);
    created.simulatePresence('demo-ava', 'away');
    expect(events.filter((event) => event.type === 'presence').at(-1)).toMatchObject({ userId: 'demo-ava', status: 'away' });
    expect(() => created.simulatePresence('unrelated-private-user', 'online')).toThrow();
  });

  test('conversation watches filter arrivals without admitting unknown conversations', async () => {
    const created = client(); await connect(created);
    const listener = jest.fn(); created.subscribe(listener);
    created.watchConversations(['securebot-demo']);
    created.simulateIncoming('demo-direct-ava');
    created.simulateTyping('demo-group-security');
    expect(listener).not.toHaveBeenCalled();
    expect(() => created.watchConversations(['unknown'])).toThrow();
    created.simulateIncoming('securebot-demo');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('markRead only acknowledges an actual incoming message in the matching conversation', async () => {
    const created = client(); await connect(created);
    const events: RealtimeEvent[] = []; created.subscribe((event) => events.push(event));
    created.simulateIncoming('demo-direct-ava');
    const incoming = events.find((event) => event.type === 'message');
    if (incoming?.type !== 'message') throw new Error('Expected demo message');
    await created.markRead('demo-direct-ava', incoming.message.id);
    expect(events.at(-1)).toMatchObject({ type: 'receipt', messageId: incoming.message.id, status: 'read', userId: user.id });
    await expect(created.markRead('securebot-demo', incoming.message.id)).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(created.markRead('demo-direct-ava', 'unknown')).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  test('simulated failure rejects one send with no success receipt and allows an explicit retry', async () => {
    const created = client({ autoReply: false }); await connect(created);
    const events: RealtimeEvent[] = []; created.subscribe((event) => events.push(event));
    created.failNextSend();
    await expect(created.sendMessage(message)).rejects.toMatchObject({ code: 'send_failed', retryable: true });
    expect(events.filter((event) => event.type === 'receipt')).toEqual([]);
    const retry = created.sendMessage(message); jest.advanceTimersByTime(20);
    await expect(retry).resolves.toMatchObject({ messageId: message.id, status: 'sent' });
  });

  test('network failure rejects unacknowledged sends, cancels old work and reconnects only explicitly', async () => {
    const created = client(); await connect(created);
    const events: RealtimeEvent[] = []; created.subscribe((event) => events.push(event));
    const first = created.sendMessage(message);
    const rejected = expect(first).rejects.toMatchObject({ code: 'disconnected', retryable: true });
    created.simulateNetworkFailure(); await rejected;
    const count = events.length; jest.advanceTimersByTime(10_000);
    expect(events).toHaveLength(count);
    expect(created.getStatus()).toBe('disconnected');
    expect(jest.getTimerCount()).toBe(0);
    const reconnect = created.simulateReconnect();
    expect(created.getStatus()).toBe('reconnecting');
    jest.advanceTimersByTime(20); await reconnect;
    const retry = created.sendMessage(message); jest.advanceTimersByTime(20);
    await expect(retry).resolves.toMatchObject({ messageId: message.id });
  });

  test('manual disconnect rejects a pending connect and never schedules an automatic reconnect', async () => {
    const created = client();
    const pending = created.connect(); const rejected = expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    created.disconnect(); await rejected;
    jest.advanceTimersByTime(10_000);
    expect(created.getStatus()).toBe('disconnected');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('disposal cancels sends, receipts, typing and replies and makes repeated cleanup safe', async () => {
    const created = client(); await connect(created);
    const listener = jest.fn(); created.subscribe(listener);
    created.simulateTyping('demo-group-security');
    const pending = created.sendMessage(message); const rejected = expect(pending).rejects.toMatchObject({ code: 'session_ended' });
    created.dispose(); created.dispose(); await rejected;
    const count = listener.mock.calls.length;
    jest.advanceTimersByTime(10_000);
    expect(listener).toHaveBeenCalledTimes(count);
    expect(jest.getTimerCount()).toBe(0);
    expect(created.canSendMessages).toBe(false);
    await expect(created.connect()).rejects.toMatchObject({ code: 'session_ended' });
    await expect(created.sendMessage(message)).rejects.toMatchObject({ code: 'session_ended' });
  });

  test('a disconnect from a subscriber cannot leave timers or later receipts behind', async () => {
    const created = client(); await connect(created);
    const events: RealtimeEvent[] = [];
    created.subscribe((event) => { events.push(event); if (event.type === 'receipt' && event.status === 'sent') created.disconnect(); });
    const pending = created.sendMessage(message); jest.advanceTimersByTime(20); await pending;
    const count = events.length; jest.advanceTimersByTime(5_000);
    expect(events).toHaveLength(count);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a disconnect during the connecting event cannot resurrect a connection', async () => {
    const created = client();
    created.subscribe((event) => { if (event.type === 'connection' && event.status === 'connecting') created.disconnect(); });
    await expect(created.connect()).rejects.toMatchObject({ code: 'disconnected' });
    jest.advanceTimersByTime(5_000);
    expect(created.getStatus()).toBe('disconnected');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('subscribers are detached, removable and isolated from exceptions and event mutation', async () => {
    const created = client(); await connect(created);
    created.subscribe((event) => { if (event.type === 'message') event.message.senderName = 'Mutated'; throw new Error('UI failure'); });
    const listener = jest.fn(); const unsubscribe = created.subscribe(listener);
    created.simulateIncoming('demo-direct-ava');
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ type: 'message', message: { senderName: 'Ava Morgan' } });
    unsubscribe(); created.simulateIncoming('demo-direct-ava');
    expect(listener).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 99; i += 1) created.subscribe(() => undefined);
    expect(() => created.subscribe(() => undefined)).toThrow();
  });

  test('identical conversation/message IDs cannot cross independent session clients', async () => {
    const first = client(), second = client(); await connect(first); await connect(second);
    const oldListener = jest.fn(), nextListener = jest.fn();
    first.subscribe(oldListener); second.subscribe(nextListener);
    first.simulateIncoming('demo-direct-ava');
    expect(oldListener).toHaveBeenCalledTimes(1); expect(nextListener).not.toHaveBeenCalled();
    first.dispose(); second.simulateIncoming('demo-direct-ava');
    expect(oldListener).toHaveBeenCalledTimes(1); expect(nextListener).toHaveBeenCalledTimes(1);
    expect(() => first.simulateIncoming('demo-direct-ava')).toThrow();
  });

  test('bounds pending and recently seen message IDs without evicting an unacknowledged operation', async () => {
    const created = client({ autoReply: false, ackDelayMs: 0, deliveryDelayMs: 0, readDelayMs: 0 }); await connect(created);
    const pending = Array.from({ length: 2_000 }, (_, index) => created.sendMessage({ ...message, id: `bounded-${index}` }));
    await expect(created.sendMessage({ ...message, id: 'over-capacity' })).rejects.toMatchObject({ code: 'unavailable' });
    jest.advanceTimersByTime(0); await Promise.all(pending);
    const next = created.sendMessage({ ...message, id: 'after-acknowledgement' }); jest.advanceTimersByTime(0);
    await expect(next).resolves.toMatchObject({ messageId: 'after-acknowledgement' });
  });

  test('no credentials, storage writes, diagnostic logs or real user fixtures are used', async () => {
    const persistence = jest.spyOn(Storage.prototype, 'setItem');
    const logging = [jest.spyOn(console, 'log'), jest.spyOn(console, 'error'), jest.spyOn(console, 'debug')];
    expect(() => client({ user: { ...user, isDemo: false } })).toThrow();
    const created = client({ autoReply: false }); await connect(created);
    created.simulateIncoming('securebot-demo');
    expect(persistence).not.toHaveBeenCalled();
    for (const spy of logging) expect(spy).not.toHaveBeenCalled();
  });

  test('production denies construction and every activity operation while cleanup remains safe', async () => {
    const created = client(); await connect(created);
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    expect(() => client()).toThrow();
    expect(created.canSendMessages).toBe(false);
    await expect(created.connect()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(created.sendMessage(message)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(created.markRead('demo-direct-ava', 'message')).rejects.toMatchObject({ code: 'unavailable' });
    expect(() => created.sendTyping('demo-direct-ava', true)).toThrow();
    expect(() => created.watchPresence(['demo-ava'])).toThrow();
    expect(() => created.watchConversations(['demo-direct-ava'])).toThrow();
    expect(() => created.simulateIncoming('demo-direct-ava')).toThrow();
    created.disconnect(); created.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });
});
