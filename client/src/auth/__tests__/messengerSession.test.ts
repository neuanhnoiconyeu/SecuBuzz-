import type { AuthUser } from '../authModel';
import { createDemoMessengerSession, DemoMessengerSessionError } from '../messengerSession';
import { existingDirectConversationAdapter } from '@/friends/conversationAdapter';
import { createLocalDemoTransport, DemoTransportDisposedError } from '@/messaging/localDemoTransport';
import type { OutboundMessage } from '@/messaging/messageModel';
import type { MessagingTransportHandlers } from '@/messaging/transport';
import { BrowserConversationCryptoService } from '@/security/conversationCryptoService';
import type { CryptoMessageContext, EncryptedMessagePayload } from '@/utils/crypto';

const alice: AuthUser = { id: 'demo-alice-session', username: 'alice.demo', displayName: 'Alice Demo', avatar: 'cat', isDemo: true };
const bob: AuthUser = { id: 'demo-bob-session', username: 'bob.demo', displayName: 'Bob Demo', avatar: 'rocket', isDemo: true };
const context = { localUserId: alice.id, conversationId: 'securebot-demo' };
const message: CryptoMessageContext = {
  conversationId: context.conversationId, messageId: 'session-test-message', senderId: alice.id,
  senderName: alice.displayName, timestamp: '2026-11-08T12:00:00.000Z',
};
const payload: EncryptedMessagePayload = {
  version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
};
const outbound: OutboundMessage = {
  id: message.messageId, conversationId: message.conversationId, senderId: alice.id,
  senderName: alice.displayName, timestamp: message.timestamp, type: 'text',
  encryption: { ...payload, scope: 'browser-demo' },
};
const handlers = (): MessagingTransportHandlers => ({
  onMessage: jest.fn(), onDeliveryStatus: jest.fn(), onPresenceUpdate: jest.fn(),
  onSecurityAlert: jest.fn(), onConnectionChange: jest.fn(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('development messenger session identity and isolation', () => {
  test('seeds profile, friends and existing conversation participants from one actor without duplicating DM IDs', async () => {
    const session = createDemoMessengerSession(alice);
    try {
      expect(await session.profileService.getCurrentProfile()).toMatchObject(alice);
      expect(await session.friendsService.searchUsers('alice.demo')).toEqual([expect.objectContaining({ id: alice.id, relationship: 'self' })]);
      expect(session.conversations.map((conversation) => conversation.id)).toEqual(['securebot-demo', 'demo-direct-ava', 'demo-group-security']);
      for (const conversation of session.conversations) {
        expect(conversation.participants).toContainEqual({ id: alice.id, displayName: alice.displayName, kind: 'person' });
        expect(conversation.participants.some((participant) => participant.id === 'local-user')).toBe(false);
      }
      const adapter = existingDirectConversationAdapter(session.conversations, alice.id);
      await expect(adapter.openDirectConversation('demo-ava')).resolves.toBe('demo-direct-ava');
      await expect(adapter.openDirectConversation('demo-ava')).resolves.toBe('demo-direct-ava');
      expect(session.conversations).toHaveLength(3);
    } finally { session.dispose(); }
  });

  test('profile edits and friends mutations cannot appear in another actor bundle', async () => {
    const first = createDemoMessengerSession(alice), second = createDemoMessengerSession(bob);
    try {
      await first.profileService.updateProfile({ displayName: 'Edited Alice' });
      await first.friendsService.removeFriend('demo-ava');
      expect(await second.profileService.getCurrentProfile()).toMatchObject(bob);
      expect(await first.friendsService.listFriends()).toEqual([]);
      expect(await second.friendsService.listFriends()).toHaveLength(1);
      expect(await second.friendsService.searchUsers('alice.demo')).toEqual([]);
      expect(await second.friendsService.searchUsers('bob.demo')).toEqual([expect.objectContaining({ id: bob.id, relationship: 'self' })]);
    } finally { first.dispose(); second.dispose(); }
  });

  test('copies the auth identity so caller mutation cannot rebind an existing session', async () => {
    const input = { ...alice };
    const session = createDemoMessengerSession(input);
    try {
      input.id = bob.id;
      input.username = bob.username;
      expect(session.user).toEqual(alice);
      expect(await session.profileService.getCurrentProfile()).toMatchObject(alice);
    } finally { session.dispose(); }
  });

  test('fresh login for the same actor has independent encryption keys', async () => {
    const first = createDemoMessengerSession(alice), second = createDemoMessengerSession(alice);
    try {
      const encrypted = await first.cryptoService.encrypt(context, 'first session only', message);
      await second.cryptoService.prepareConversation(context);
      await expect(second.cryptoService.decrypt(context, encrypted, message)).rejects.toMatchObject({ code: 'authentication_failed' });
      await expect(first.cryptoService.decrypt(context, encrypted, message)).resolves.toBe('first session only');
    } finally { first.dispose(); second.dispose(); }
  });

  test('rejects a context bound to a different local actor', async () => {
    const session = createDemoMessengerSession(alice);
    try {
      await expect(session.cryptoService.prepareConversation({ ...context, localUserId: bob.id }))
        .rejects.toMatchObject({ code: 'identity_mismatch' });
    } finally { session.dispose(); }
  });

  test('disposal is repeatable and disables crypto and sends without deleting conversation metadata', async () => {
    const session = createDemoMessengerSession(alice);
    const ids = session.conversations.map((conversation) => conversation.id);
    session.dispose(); session.dispose();
    await expect(session.cryptoService.prepareConversation(context)).rejects.toMatchObject({ code: 'session_ended' });
    await expect(session.cryptoService.encrypt(context, 'do not send', message)).rejects.toMatchObject({ code: 'session_ended' });
    await expect(session.cryptoService.decrypt(context, payload, message)).rejects.toMatchObject({ code: 'session_ended' });
    await expect(session.transport.connect(context.conversationId)).rejects.toBeInstanceOf(DemoTransportDisposedError);
    await expect(session.transport.sendMessage(outbound)).rejects.toBeInstanceOf(DemoTransportDisposedError);
    await expect(session.transport.disconnect(context.conversationId)).resolves.toBeUndefined();
    expect(session.conversations.map((conversation) => conversation.id)).toEqual(ids);
  });

  test('an encryption finishing after disposal cannot invoke the transport', async () => {
    const pending = deferred<EncryptedMessagePayload>();
    jest.spyOn(BrowserConversationCryptoService.prototype, 'encrypt').mockImplementationOnce(() => pending.promise);
    const session = createDemoMessengerSession(alice);
    const send = jest.spyOn(session.transport, 'sendMessage');
    const operation = session.cryptoService.encrypt(context, 'old session text', message)
      .then((encrypted) => session.transport.sendMessage({ ...outbound, encryption: { ...encrypted, scope: 'browser-demo' } }));
    session.dispose(); pending.resolve(payload);
    await expect(operation).rejects.toMatchObject({ code: 'session_ended' });
    expect(send).not.toHaveBeenCalled();
  });

  test('a decryption finishing after disposal cannot expose plaintext to a new view', async () => {
    const pending = deferred<string>();
    jest.spyOn(BrowserConversationCryptoService.prototype, 'decrypt').mockImplementationOnce(() => pending.promise);
    const session = createDemoMessengerSession(alice);
    const displayed: string[] = [];
    const operation = session.cryptoService.decrypt(context, payload, message).then((text) => displayed.push(text));
    session.dispose(); pending.resolve('old unmounted session plaintext');
    await expect(operation).rejects.toMatchObject({ code: 'session_ended' });
    expect(displayed).toEqual([]);
  });

  test('never creates demo services for a real API user', () => {
    expect(() => createDemoMessengerSession({ ...alice, isDemo: false })).toThrow(DemoMessengerSessionError);
  });

  test('cannot create a demo messenger bundle in production', () => {
    const environment = jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    try { expect(() => createDemoMessengerSession(alice)).toThrow(DemoMessengerSessionError); }
    finally { environment.restore(); }
  });
});

describe('isolated local demo transports', () => {
  test('only notifies listeners belonging to its own session, even with identical conversation IDs', async () => {
    const first = createLocalDemoTransport(), second = createLocalDemoTransport();
    const firstHandlers = handlers(), secondHandlers = handlers();
    first.subscribeToConversation(context.conversationId, firstHandlers);
    second.subscribeToConversation(context.conversationId, secondHandlers);
    await first.sendMessage(outbound);
    expect(firstHandlers.onMessage).toHaveBeenCalledTimes(1);
    expect(secondHandlers.onMessage).not.toHaveBeenCalled();
    first.dispose();
    await second.sendMessage(outbound);
    expect(firstHandlers.onMessage).toHaveBeenCalledTimes(1);
    expect(secondHandlers.onMessage).toHaveBeenCalledTimes(1);
    second.dispose();
  });

  test('clears subscriptions and cannot start new callbacks after disposal during dispatch', async () => {
    const transport = createLocalDemoTransport();
    const firstHandlers = handlers(), lateHandlers = handlers();
    firstHandlers.onMessage = jest.fn(() => transport.dispose());
    transport.subscribeToConversation(context.conversationId, firstHandlers);
    const unsubscribe = transport.subscribeToConversation(context.conversationId, lateHandlers);
    await expect(transport.sendMessage(outbound)).rejects.toBeInstanceOf(DemoTransportDisposedError);
    expect(lateHandlers.onMessage).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
    expect(() => transport.subscribeToConversation(context.conversationId, lateHandlers)()).not.toThrow();
    await expect(transport.sendMessage(outbound)).rejects.toBeInstanceOf(DemoTransportDisposedError);
    expect(lateHandlers.onMessage).not.toHaveBeenCalled();
  });
});
