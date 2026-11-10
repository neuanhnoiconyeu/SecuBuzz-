import type { AuthUser } from '@/auth/authModel';
import type { OutboundMessage } from '@/messaging/messageModel';
import {
  SocketIoRealtimeClient, PROPOSED_EVENT_NAMES,
  type SocketIoRealtimeClientOptions, type SocketPort, type SocketManagerPort,
} from '../SocketIoRealtimeClient';
import type { RealtimeEvent } from '../realtimeModel';
import { RealtimeMessagingTransport } from '../RealtimeMessagingTransport';
import { createDemoConversations } from '@/conversations/demoConversations';
import type { MessagingTransportHandlers } from '@/messaging/transport';

type Listener = (...args: unknown[]) => void;
class EventPort {
  readonly listeners = new Map<string, Set<Listener>>();
  on = jest.fn((event: string, listener: Listener) => {
    const entries = this.listeners.get(event) ?? new Set<Listener>();
    entries.add(listener); this.listeners.set(event, entries); return this;
  });
  off = jest.fn((event: string, listener: Listener) => {
    this.listeners.get(event)?.delete(listener);
    if (!this.listeners.get(event)?.size) this.listeners.delete(event);
    return this;
  });
  signal(event: string, ...payload: unknown[]) {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) listener(...payload);
  }
}
class FakeManager extends EventPort implements SocketManagerPort {
  reconnection = jest.fn((_enabled: boolean) => this);
}
class FakeSocket extends EventPort implements SocketPort {
  connected = false;
  active = true;
  readonly io = new FakeManager();
  readonly volatile = { emit: jest.fn((_event: string, _payload: unknown) => this) };
  connect = jest.fn(() => { this.active = true; return this; });
  disconnect = jest.fn(() => { this.connected = false; this.active = false; return this; });
  emit = jest.fn((_event: string, _payload: unknown, _acknowledge?: (payload: unknown) => void) => this);
  accepted() { this.connected = true; this.active = true; this.signal('connect'); }
  lost(reason = 'transport close') { this.connected = false; this.signal('disconnect', reason); }
}

const actor: AuthUser = { id: 'user-a', username: 'person.a', displayName: 'Person A', avatar: 'initials', isDemo: false };
const timestamp = '2026-11-09T12:00:00.000Z';
const encrypted = {
  version: 1, algorithm: 'AES-256-GCM', encoding: 'base64',
  iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.alloc(24).toString('base64'),
};
const incoming = (id = 'message-1', conversationId = 'conversation-1', at = timestamp) => ({
  id, conversationId, senderId: 'user-b', senderName: 'Person B', timestamp: at,
  type: 'text', deliveryStatus: 'delivered', encryption: { ...encrypted },
});
const outbound: OutboundMessage = {
  id: 'outgoing-1', conversationId: 'conversation-1', senderId: actor.id, senderName: actor.displayName,
  timestamp, type: 'text', encryption: { ...encrypted, version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', scope: 'browser-demo' },
};
const clients: SocketIoRealtimeClient[] = [];

function setup(overrides: Partial<SocketIoRealtimeClientOptions> = {}) {
  const socket = new FakeSocket();
  const factory = jest.fn(() => socket);
  const client = new SocketIoRealtimeClient({ user: actor, authMode: 'api', contractReady: true,
    url: 'https://realtime.example.test', socketFactory: factory, ...overrides });
  clients.push(client);
  client.watchConversations(['conversation-1', 'group-1']);
  client.watchPresence(['user-b', 'user-c']);
  return { client, socket, factory };
}
async function connected(overrides: Partial<SocketIoRealtimeClientOptions> = {}) {
  const entry = setup(overrides);
  const connecting = entry.client.connect();
  entry.socket.accepted();
  await connecting;
  return entry;
}
function acknowledgement(socket: FakeSocket) {
  const call = [...socket.emit.mock.calls].reverse().find((args) => args[0] === PROPOSED_EVENT_NAMES.messageRead);
  expect(call?.[2]).toEqual(expect.any(Function));
  return call![2]!;
}
function readAcknowledgement(messageId = 'message-1') {
  return { conversationId: 'conversation-1', messageId, status: 'read', timestamp };
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('real-session construction and cookie-only Socket.IO options', () => {
  test.each([
    { authMode: 'demo' as const }, { authMode: 'unconfigured' as const }, { contractReady: false },
    { user: { ...actor, isDemo: true } }, { user: { ...actor, id: 'local-user' } },
    { user: { ...actor, id: 'demo-session-nova' } }, { user: { ...actor, id: 'demo_user' } },
    { user: { ...actor, id: 'demo:user' } }, { user: { ...actor, id: '' } },
  ])('rejects an unapproved or demo identity before socket construction %#', (overrides) => {
    const socketFactory = jest.fn();
    expect(() => setup({ ...overrides, socketFactory })).toThrow('Realtime messaging is not available yet.');
    expect(socketFactory).not.toHaveBeenCalled();
  });

  test.each([
    'http://realtime.example.test', 'ws://realtime.example.test', 'wss://realtime.example.test',
    'https://user:secret@realtime.example.test', 'https://realtime.example.test?token=private',
    'https://realtime.example.test#private', '//realtime.example.test', ' https://realtime.example.test',
    'https:\\realtime.example.test', 'javascript:alert(1)',
  ])('rejects unsafe or unapproved URL %s', (url) => {
    const socketFactory = jest.fn();
    expect(() => setup({ url, socketFactory })).toThrow('Realtime messaging is not available yet.');
    expect(socketFactory).not.toHaveBeenCalled();
  });

  test('allows HTTP loopback only outside production and never allows a production demo actor', () => {
    expect(() => setup({ url: 'http://127.0.0.1:3100' })).not.toThrow();
    const environment = jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    try {
      expect(() => setup({ url: 'http://127.0.0.1:3100' })).toThrow();
      expect(() => setup({ user: { ...actor, isDemo: true } })).toThrow();
      expect(() => setup()).not.toThrow();
    } finally { environment.restore(); }
  });

  test('constructs lazily, uses a private manager, bounds reconnects, and sends no client-auth identity or token', async () => {
    const { client, socket, factory } = setup();
    expect(factory).not.toHaveBeenCalled();
    expect(client.getStatus()).toBe('disconnected');
    const first = client.connect(), duplicate = client.connect();
    expect(first).toBe(duplicate);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]).toEqual(['https://realtime.example.test/', {
      autoConnect: false, forceNew: true, multiplex: false, withCredentials: true, path: '/socket.io',
      transports: ['websocket', 'polling'], timeout: 10_000, reconnection: true,
      reconnectionAttempts: 5, reconnectionDelay: 500, reconnectionDelayMax: 4_000, retries: 0,
    }]);
    socket.accepted(); await first;
    await client.connect();
    expect(client.actorId).toBe(actor.id);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  test('event mapping can be adapted centrally and rejects reserved/colliding names or unsafe paths', async () => {
    expect(() => setup({ eventNames: { messageNew: 'connect' } })).toThrow();
    expect(() => setup({ eventNames: { messageNew: 'presence:update' } })).toThrow();
    expect(() => setup({ path: '//untrusted/socket' })).toThrow();
    const { client, socket } = await connected({ eventNames: { messageNew: 'v2:message' }, path: '/realtime/socket' });
    const listener = jest.fn(); client.subscribe(listener);
    socket.signal('v2:message', incoming());
    expect(listener).toHaveBeenCalledWith({ type: 'message', message: incoming() });
  });
});

describe('connection lifecycle, stale callbacks, and listener cleanup', () => {
  test('reconnects through the existing manager without creating sockets or accumulating listeners', async () => {
    const { client, socket, factory } = await connected();
    const events: RealtimeEvent[] = [];
    client.subscribe((event) => events.push(event));
    const count = socket.on.mock.calls.length;
    socket.lost();
    expect(client.getStatus()).toBe('reconnecting');
    socket.io.signal('reconnect_attempt', 1);
    socket.io.signal('reconnect_error', new Error('private detail'));
    socket.accepted();
    expect(client.getStatus()).toBe('connected');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(socket.on.mock.calls).toHaveLength(count);
    expect(events.filter((event) => event.type === 'connection')).toEqual([
      { type: 'connection', status: 'reconnecting' }, { type: 'connection', status: 'connected' },
    ]);
    expect(socket.emit.mock.calls.filter((args) => args[0] === PROPOSED_EVENT_NAMES.presenceSubscribe)).toHaveLength(2);
  });

  test('reconnect exhaustion settles initial connection and requires an explicit reconnect', async () => {
    const { client, socket } = setup();
    const promise = client.connect();
    const rejection = expect(promise).rejects.toMatchObject({ code: 'unavailable' });
    socket.io.signal('reconnect_failed');
    await rejection;
    expect(client.getStatus()).toBe('error');
    expect(socket.io.reconnection).toHaveBeenLastCalledWith(false);
    const again = client.connect(); socket.accepted(); await again;
    expect(client.getStatus()).toBe('connected');
    expect(socket.connect).toHaveBeenCalledTimes(2);
  });

  test.each(['UNAUTHORIZED', 'SESSION_EXPIRED', 'AUTH_REQUIRED'])('permanently stops reconnection after explicit %s rejection', async (code) => {
    const { client, socket, factory } = setup();
    const events: RealtimeEvent[] = []; client.subscribe((event) => events.push(event));
    const promise = client.connect();
    const rejected = expect(promise).rejects.toMatchObject({ code: 'authentication_rejected' });
    socket.signal('connect_error', { data: { code }, message: 'private credential/stack' });
    await rejected;
    expect(client.getStatus()).toBe('error');
    expect(socket.io.reconnection).toHaveBeenLastCalledWith(false);
    expect(socket.listeners.size).toBe(0);
    expect(socket.io.listeners.size).toBe(0);
    await expect(client.connect()).rejects.toMatchObject({ code: 'authentication_rejected' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain('private');
  });

  test('a failed server-auth handshake without automatic retry settles safely', async () => {
    const { client, socket } = setup();
    const promise = client.connect();
    const rejection = expect(promise).rejects.toMatchObject({ code: 'unavailable' });
    socket.active = false;
    socket.signal('connect_error', { data: { code: {} }, message: 'untrusted string' });
    await rejection;
    expect(client.getStatus()).toBe('error');
  });

  test('explicit disconnect cancels connects, removes owned listeners, and rejects callbacks from older generations', async () => {
    const { client, socket, factory } = setup();
    const pending = client.connect();
    const rejection = expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    const oldMessage = Array.from(socket.listeners.get(PROPOSED_EVENT_NAMES.messageNew) ?? [])[0]!;
    client.disconnect(); await rejection;
    expect(client.getStatus()).toBe('disconnected');
    expect(socket.listeners.size).toBe(0); expect(socket.io.listeners.size).toBe(0);
    const next = client.connect(); socket.accepted(); await next;
    const listener = jest.fn(); client.subscribe(listener);
    oldMessage(incoming());
    expect(listener).not.toHaveBeenCalled();
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('disposing during a connection-status notification cannot open a connection afterward', async () => {
    const { client, socket } = setup();
    client.subscribe((event) => { if (event.type === 'connection' && event.status === 'connecting') client.dispose(); });
    await expect(client.connect()).rejects.toMatchObject({ code: 'session_ended' });
    expect(socket.connect).not.toHaveBeenCalled();
    await expect(client.connect()).rejects.toMatchObject({ code: 'session_ended' });
  });

  test('unsubscription isolates consumers and disposal is repeatable with no retained callbacks', async () => {
    const { client, socket } = await connected();
    const first = jest.fn(), second = jest.fn();
    const unsubscribe = client.subscribe(first); client.subscribe(second);
    unsubscribe();
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming());
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
    client.dispose(); client.dispose();
    second.mockClear();
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming('late'));
    client.watchPresence(['user-b']);
    expect(second).not.toHaveBeenCalled();
    expect(socket.listeners.size).toBe(0); expect(socket.io.listeners.size).toBe(0);
  });

  test('an absolute connection deadline prevents unresolved or stalled managers from running forever', async () => {
    jest.useFakeTimers();
    const { client, socket } = setup();
    const promise = client.connect();
    const rejection = expect(promise).rejects.toMatchObject({ code: 'unavailable' });
    jest.advanceTimersByTime(90_001); await rejection;
    expect(client.getStatus()).toBe('error');
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('projected incoming events, scope, deduplication, and stale metadata', () => {
  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(Date.parse(timestamp)); });
  test('receives encrypted envelopes once, ignores unwatched conversations, and leaves out-of-order sorting to message state', async () => {
    const { client, socket } = await connected();
    const events: RealtimeEvent[] = []; client.subscribe((event) => events.push(event));
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, { message: incoming('later', 'conversation-1', '2026-11-09T12:02:00.000Z') });
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming('earlier', 'conversation-1', timestamp));
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming('earlier', 'conversation-1', timestamp));
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming('unknown', 'not-watched'));
    expect(events.map((event) => event.type === 'message' ? event.message.id : null)).toEqual(['later', 'earlier']);
  });

  test('never accepts plaintext, demo-only envelopes, browser-demo scope, invalid IVs, or extra private state', async () => {
    const { client, socket } = await connected();
    const listener = jest.fn(); client.subscribe(listener);
    for (const payload of [null, {}, { ...incoming(), content: 'private plaintext' },
      { ...incoming(), demoOnly: true, content: 'private plaintext' },
      { ...incoming(), encryption: { ...encrypted, scope: 'browser-demo' } },
      { ...incoming(), encryption: { ...encrypted, iv: 'bad' } },
      { ...incoming(), profile: { role: 'admin' } },
    ]) socket.signal(PROPOSED_EVENT_NAMES.messageNew, payload);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'error', code: 'invalid_payload' });
    expect(JSON.stringify(listener.mock.calls)).not.toContain('private plaintext');
  });

  test('ignores all unsolicited send acknowledgements and validates receipt event kind and scope', async () => {
    const { client, socket } = await connected();
    const listener = jest.fn(); client.subscribe(listener);
    const receipt = { conversationId: 'conversation-1', messageId: 'known-or-unknown', userId: 'user-b', status: 'delivered', timestamp };
    socket.signal(PROPOSED_EVENT_NAMES.messageAck, { conversationId: 'conversation-1', messageId: 'invented', status: 'sent', timestamp });
    socket.signal(PROPOSED_EVENT_NAMES.messageDelivered, { ...receipt, status: 'read' });
    socket.signal(PROPOSED_EVENT_NAMES.messageDelivered, { ...receipt, conversationId: 'not-watched' });
    expect(listener).not.toHaveBeenCalled();
    socket.signal(PROPOSED_EVENT_NAMES.messageDelivered, receipt);
    socket.signal(PROPOSED_EVENT_NAMES.messageReadReceipt, { ...receipt, status: 'read' });
    expect(listener.mock.calls.map((args) => args[0].status)).toEqual(['delivered', 'read']);
  });

  test('filters own or unwatched-conversation typing, unwatched presence, duplicates, and older timestamps', async () => {
    const { client, socket } = await connected();
    const listener = jest.fn(); client.subscribe(listener);
    const typing = { conversationId: 'group-1', userId: 'user-b', displayName: 'Person B', isTyping: true, timestamp };
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, { ...typing, userId: actor.id });
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, { ...typing, conversationId: 'not-watched' });
    socket.signal(PROPOSED_EVENT_NAMES.presenceUpdate, { userId: 'not-public', status: 'online', timestamp });
    expect(listener).not.toHaveBeenCalled();
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, typing);
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, typing);
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, { ...typing, isTyping: false, timestamp: '2026-11-09T11:59:00.000Z' });
    socket.signal(PROPOSED_EVENT_NAMES.presenceUpdate, { userId: 'user-b', status: 'offline', timestamp });
    socket.signal(PROPOSED_EVENT_NAMES.presenceUpdate, { userId: 'user-b', status: 'online', timestamp: '2026-11-09T11:59:00.000Z' });
    expect(listener).toHaveBeenCalledTimes(2);
    client.watchPresence(['user-c']);
    socket.signal(PROPOSED_EVENT_NAMES.presenceUpdate, { userId: 'user-b', status: 'online', timestamp: '2026-11-09T12:03:00.000Z' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('group typing follows conversation membership independently of the Friends presence list', async () => {
    const { client, socket } = await connected();
    client.watchPresence(['user-b']);
    const group = createDemoConversations(Date.parse(timestamp), actor)[2]!;
    const bridge = new RealtimeMessagingTransport(client, [{ ...group, id: 'group-1', isDemo: false, participants: [
      { id: actor.id, displayName: actor.displayName, kind: 'person' },
      { id: 'user-b', displayName: 'Person B', kind: 'person' },
      { id: 'user-c', displayName: 'Nonfriend group member', kind: 'person' },
    ] }]);
    const handlers: MessagingTransportHandlers = {
      onMessage: jest.fn(), onDeliveryStatus: jest.fn(), onPresenceUpdate: jest.fn(), onSecurityAlert: jest.fn(),
      onConnectionChange: jest.fn(), onTypingUpdate: jest.fn(),
    };
    bridge.subscribeToConversation('group-1', handlers);
    const typing = { conversationId: 'group-1', userId: 'user-c', displayName: 'Nonfriend group member', isTyping: true, timestamp };
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, typing);
    expect(handlers.onTypingUpdate).toHaveBeenCalledWith({ type: 'typing', ...typing });
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, { ...typing, userId: 'not-a-group-member' });
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, { ...typing, userId: actor.id });
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, { ...typing, conversationId: 'not-watched' });
    socket.signal(PROPOSED_EVENT_NAMES.presenceUpdate, { userId: 'user-c', status: 'online', timestamp });
    expect(handlers.onTypingUpdate).toHaveBeenCalledTimes(1);
    expect(handlers.onPresenceUpdate).not.toHaveBeenCalled();
    bridge.dispose();
  });

  test('future metadata cannot poison ordering and suppress subsequent current presence, typing or conversation updates', async () => {
    const { client, socket } = await connected();
    const events: RealtimeEvent[] = []; client.subscribe((event) => events.push(event));
    const future = '2099-11-09T12:00:00.000Z';
    const typing = { conversationId: 'group-1', userId: 'user-b', displayName: 'Person B', isTyping: true, timestamp };
    const presence = { userId: 'user-b', status: 'online', timestamp };
    const conversation = { conversationId: 'group-1', displayName: 'Current title', updatedAt: timestamp };
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, { ...typing, timestamp: future });
    socket.signal(PROPOSED_EVENT_NAMES.presenceUpdate, { ...presence, timestamp: future });
    socket.signal(PROPOSED_EVENT_NAMES.conversationUpdated, { ...conversation, updatedAt: future });
    expect(events).toEqual([]);
    socket.signal(PROPOSED_EVENT_NAMES.typingUpdate, typing);
    socket.signal(PROPOSED_EVENT_NAMES.presenceUpdate, presence);
    socket.signal(PROPOSED_EVENT_NAMES.conversationUpdated, conversation);
    expect(events.map((event) => event.type)).toEqual(['typing', 'presence', 'conversation']);
  });

  test('updates only watched conversation metadata and bounds replay history', async () => {
    const { client, socket } = await connected();
    const listener = jest.fn(); client.subscribe(listener);
    const update = { conversationId: 'group-1', displayName: 'Approved display title', updatedAt: timestamp };
    socket.signal(PROPOSED_EVENT_NAMES.conversationUpdated, update);
    socket.signal(PROPOSED_EVENT_NAMES.conversationUpdated, { ...update, displayName: 'stale', updatedAt: '2026-11-09T11:59:00.000Z' });
    expect(listener).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 1_001; index += 1) socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming(`message-${index}`));
    const count = listener.mock.calls.length;
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming('message-1000'));
    expect(listener).toHaveBeenCalledTimes(count);
    socket.signal(PROPOSED_EVENT_NAMES.messageNew, incoming('message-0'));
    expect(listener).toHaveBeenCalledTimes(count + 1);
  });
});

describe('fail-closed real sending and ephemeral metadata writes', () => {
  test('real message sending remains disabled regardless of connection or payload and never emits message:send', async () => {
    const { client, socket } = await connected();
    expect(client.canSendMessages).toBe(false);
    await expect(client.sendMessage(outbound)).rejects.toMatchObject({ code: 'recipient_keys_unavailable' });
    await expect(client.sendMessage({ content: 'private plaintext' } as unknown as OutboundMessage)).rejects.toMatchObject({ code: 'recipient_keys_unavailable' });
    client.disconnect();
    await expect(client.sendMessage(outbound)).rejects.toMatchObject({ code: 'recipient_keys_unavailable' });
    expect(socket.emit.mock.calls.some((args) => args[0] === PROPOSED_EVENT_NAMES.messageSend)).toBe(false);
  });

  test('typing is volatile, bounded, and emits no content, identity, or offline buffer', async () => {
    jest.useFakeTimers();
    const { client, socket } = setup();
    client.sendTyping('conversation-1', true);
    expect(socket.volatile.emit).not.toHaveBeenCalled();
    const connecting = client.connect(); socket.accepted(); await connecting;
    client.sendTyping('not-watched', true);
    client.sendTyping('conversation-1', true); client.sendTyping('conversation-1', true);
    expect(socket.volatile.emit).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1_001);
    client.sendTyping('conversation-1', true);
    client.sendTyping('conversation-1', false); client.sendTyping('conversation-1', false);
    expect(socket.volatile.emit.mock.calls).toEqual([
      ['typing:start', { conversationId: 'conversation-1' }], ['typing:start', { conversationId: 'conversation-1' }],
      ['typing:stop', { conversationId: 'conversation-1' }],
    ]);
    socket.lost(); client.sendTyping('conversation-1', true);
    expect(socket.volatile.emit).toHaveBeenCalledTimes(3);
  });

  test('markRead requires connection, validated identifiers, and an allowed conversation before emit', async () => {
    const { client, socket } = setup();
    await expect(client.markRead('conversation-1', 'message-1')).rejects.toMatchObject({ code: 'disconnected' });
    await expect(client.markRead('not-watched', 'message-1')).rejects.toMatchObject({ code: 'unauthorized_conversation' });
    await expect(client.markRead('conversation-1', '')).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('markRead coalesces duplicate requests and waits for a matching explicit acknowledgement', async () => {
    const { client, socket } = await connected();
    const pending = client.markRead('conversation-1', 'message-1');
    expect(client.markRead('conversation-1', 'message-1')).toBe(pending);
    expect(socket.emit).toHaveBeenLastCalledWith('message:read', { conversationId: 'conversation-1', messageId: 'message-1' }, expect.any(Function));
    acknowledgement(socket)(readAcknowledgement());
    await expect(pending).resolves.toBeUndefined();
    expect(socket.emit.mock.calls.filter((args) => args[0] === 'message:read')).toHaveLength(1);
  });

  test('wrong or malformed read acknowledgements fail safely without automatic retry', async () => {
    const { client, socket } = await connected();
    const pending = client.markRead('conversation-1', 'message-1');
    const rejection = expect(pending).rejects.toMatchObject({ code: 'invalid_payload' });
    acknowledgement(socket)(readAcknowledgement('mismatched-id'));
    await rejection;
    expect(socket.emit.mock.calls.filter((args) => args[0] === 'message:read')).toHaveLength(1);
  });

  test('an explicit read-acknowledgement actor must match the authenticated session', async () => {
    const { client, socket } = await connected();
    const pending = client.markRead('conversation-1', 'message-1');
    const rejection = expect(pending).rejects.toMatchObject({ code: 'invalid_payload' });
    acknowledgement(socket)({ ...readAcknowledgement(), userId: 'another-actor' });
    await rejection;
  });

  test('read acknowledgement timeout remains ambiguous and never retries the write', async () => {
    jest.useFakeTimers();
    const { client, socket } = await connected();
    const pending = client.markRead('conversation-1', 'message-1');
    const rejection = expect(pending).rejects.toMatchObject({ code: 'ack_timeout', retryable: false });
    jest.advanceTimersByTime(5_001); await rejection;
    acknowledgement(socket)(readAcknowledgement());
    expect(socket.emit.mock.calls.filter((args) => args[0] === 'message:read')).toHaveLength(1);
  });

  test('disconnect and access removal cancel pending reads and ignore late acknowledgements', async () => {
    const { client, socket } = await connected();
    let pending = client.markRead('conversation-1', 'message-1');
    let rejection = expect(pending).rejects.toMatchObject({ code: 'unauthorized_conversation' });
    const old = acknowledgement(socket);
    client.watchConversations(['group-1']); await rejection; old(readAcknowledgement());
    client.watchConversations(['conversation-1']);
    pending = client.markRead('conversation-1', 'message-2');
    rejection = expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    socket.lost(); await rejection;
    acknowledgement(socket)(readAcknowledgement('message-2'));
  });
});
