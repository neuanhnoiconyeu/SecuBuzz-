import { ApiError } from '@/api/sessionApi';
import { E2eeError } from '@/security/e2ee/model';
import type { DecryptedRow, SecureMessagingSession } from '@/security/e2ee/session';
import { mergeSecureRows, SecureRealtimeWorkspace } from '../SecureRealtimeWorkspace';
import { SocketFailure } from '../authenticatedProtocol';
import { ack, conversation, envelope, FakeSocket, flush, proof } from '../testing/authenticatedFixtures';
const row = (sequence = 1, own = false): DecryptedRow => ({ message: { ...envelope, id: 'wire-' + sequence, senderId: own ? 'alice' : 'bob',
  senderName: own ? 'Alice' : 'Bob', storageId: 'storage-' + sequence, storedAt: envelope.timestamp, updatedAt: envelope.timestamp,
  sequence, revision: 1, state: 'active', deletedAt: null }, text: 'Locally decrypted fixture ' + sequence, error: null });
async function setup(initial: DecryptedRow[] = []) {
  const api = { actor: { id: 'alice', username: 'alice' }, request: jest.fn(), realtimeAuth: jest.fn().mockResolvedValue(proof), dispose: jest.fn() };
  const session = { api: { session: api, conversations: jest.fn().mockResolvedValue({ items: [conversation], nextCursor: null }) },
    history: jest.fn().mockResolvedValue({ items: initial, nextCursor: null }), revalidate: jest.fn().mockResolvedValue(undefined),
    decryptIncoming: jest.fn().mockResolvedValue('Locally decrypted fixture'), send: jest.fn(), retryPending: jest.fn() };
  const sockets: FakeSocket[] = [], factory = jest.fn((_url, options) => { const socket = new FakeSocket(options); sockets.push(socket); return socket; });
  const live = new SecureRealtimeWorkspace(session as unknown as SecureMessagingSession, 'http://localhost:4177', factory);
  await live.refresh(); live.transport.start(); await flush(); return { live, session, sockets, api };
}
beforeEach(() => jest.useFakeTimers()); afterEach(() => jest.useRealTimers());

test('REST/live rows merge by wire ID, keep sequence ordering and reject conflicting bytes', () => {
  expect(mergeSecureRows([row(2), row(1)], [row(2), row(3)]).map(r => r.message.sequence)).toEqual([1, 2, 3]);
  const conflicting = row(1); conflicting.message.encryption = { ...envelope.encryption, iv: 'AQEBAQEBAQEBAQEB' };
  expect(() => mergeSecureRows([row(1)], [conflicting])).toThrow(E2eeError);
});
test('valid live event decrypts locally, merges REST and acknowledges only after acceptance', async () => {
  const h = await setup(); h.session.history.mockResolvedValue({ items: [row()], nextCursor: null }); const delivered = jest.fn();
  h.sockets[0]!.fire('message:new', { ...row().message, storageId: undefined }, delivered);
  const { storageId: _storage, storedAt: _stored, updatedAt: _updated, sequence: _sequence, revision: _revision, state: _state, deletedAt: _deleted, ...wire } = row().message;
  h.sockets[0]!.fire('message:new', { ...wire, deliveryStatus: 'sent' }, delivered); await flush();
  expect(h.session.decryptIncoming).toHaveBeenCalledWith(wire); expect(h.live.getSnapshot().rows[conversation.id]).toHaveLength(1); expect(delivered).toHaveBeenCalledTimes(1); h.live.dispose();
});
test('duplicate live events, REST overlap and multiple same-account sockets do not duplicate rows or unread', async () => {
  const h = await setup(); const incoming = { ...envelope, senderId: 'bob', senderName: 'Bob', deliveryStatus: 'sent' };
  h.session.history.mockResolvedValue({ items: [row()], nextCursor: null });
  h.sockets[0]!.fire('message:new', incoming, jest.fn()); h.sockets[0]!.fire('message:new', incoming, jest.fn()); await flush();
  expect(h.live.getSnapshot().rows[conversation.id]).toHaveLength(1); expect(h.live.getSnapshot().unread[conversation.id]).toBe(1);
  h.session.history.mockResolvedValue({ items: [row(2, true), row()], nextCursor: null });
  h.sockets[0]!.fire('message:new', { ...envelope, id: 'wire-2', deliveryStatus: 'sent' }, jest.fn()); await flush();
  expect(h.live.getSnapshot().rows[conversation.id]).toHaveLength(2); expect(h.live.getSnapshot().unread[conversation.id]).toBe(1); h.live.dispose();
});
test('message arriving during history fetch triggers a follow-up fetch and is never lost or duplicated', async () => {
  const h = await setup(); let release!: (value: unknown) => void;
  h.session.history.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const sync = h.live.sync(conversation.id);
  h.session.history.mockResolvedValue({ items: [row()], nextCursor: null });
  h.sockets[0]!.fire('message:new', { ...envelope, senderId: 'bob', senderName: 'Bob', deliveryStatus: 'sent' }, jest.fn()); await flush();
  release({ items: [], nextCursor: null }); await sync; await flush(); expect(h.live.getSnapshot().rows[conversation.id]).toHaveLength(1); h.live.dispose();
});
test('reconnect walks history cursors through an offline gap to the known anchor', async () => {
  const h = await setup([row(1)]); h.session.history.mockReset().mockResolvedValueOnce({ items: [row(4), row(3)], nextCursor: 'older' })
    .mockResolvedValueOnce({ items: [row(2), row(1)], nextCursor: null });
  await h.live.sync(conversation.id); expect(h.session.history).toHaveBeenNthCalledWith(2, conversation.id, 'older');
  expect(h.live.getSnapshot().rows[conversation.id]!.map(r => r.message.sequence)).toEqual([1, 2, 3, 4]); h.live.dispose();
});
test('failed local decryption produces no delivery confirmation and shows a safe history state', async () => {
  const h = await setup(); h.session.decryptIncoming.mockRejectedValue(new E2eeError('decryption_failed'));
  h.session.history.mockResolvedValue({ items: [{ ...row(), text: null, error: 'Unable to decrypt this message.' }], nextCursor: null }); const callback = jest.fn();
  h.sockets[0]!.fire('message:new', { ...envelope, senderId: 'bob', senderName: 'Bob', deliveryStatus: 'sent' }, callback); await flush();
  expect(callback).not.toHaveBeenCalled(); expect(h.live.getSnapshot().rows[conversation.id]![0]!.text).toBeNull(); expect(h.live.getSnapshot().errors[conversation.id]).not.toContain('fixture'); h.live.dispose();
});
test('key hint immediately invalidates UI readiness and refetches through signed-directory verification', async () => {
  const h = await setup(); h.session.revalidate.mockRejectedValue(new E2eeError('keys_changed'));
  h.sockets[0]!.fire('conversation:keys-changed', { conversationId: conversation.id, currentEpoch: null });
  expect(h.live.getSnapshot().keyVersions[conversation.id]).toBe(1); await flush();
  expect(h.live.getSnapshot().errors[conversation.id]).toContain('Review'); expect(h.session.revalidate).toHaveBeenCalledWith(conversation.id); h.live.dispose();
});
test('missed key hint is recovered by revalidation on every reconnect', async () => {
  const h = await setup([row()]); h.session.revalidate.mockClear().mockRejectedValue(new E2eeError('device_revoked'));
  h.sockets[0]!.drop(); jest.advanceTimersByTime(1000); await flush(); expect(h.session.revalidate).toHaveBeenCalledWith(conversation.id);
  expect(h.live.getSnapshot().errors[conversation.id]).toContain('revoked'); h.live.dispose();
});
test('key refusal during send refetches trusted state without retrying or re-encrypting', async () => {
  const h = await setup(); h.session.send.mockRejectedValue(new SocketFailure('recipient_keys_unavailable'));
  h.session.revalidate.mockClear().mockRejectedValue(new E2eeError('keys_changed'));
  await expect(h.live.send(conversation.id, 'Alice', 'never retried plaintext', 'live', jest.fn())).rejects.toMatchObject({ code: 'recipient_keys_unavailable' });
  expect(h.session.revalidate).toHaveBeenCalledTimes(1); expect(h.session.send).toHaveBeenCalledTimes(1); expect(h.session.retryPending).not.toHaveBeenCalled();
  expect(h.live.getSnapshot().keyVersions[conversation.id]).toBe(1); h.live.clearError(conversation.id); expect(h.live.getSnapshot().errors[conversation.id]).toBeUndefined(); h.live.dispose();
});
test('authorization removal clears rows, previews, typing, unread and grants; late decrypt cannot repopulate', async () => {
  const h = await setup([row()]); let resolve!: (value: string) => void;
  h.session.decryptIncoming.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  h.sockets[0]!.fire('message:new', { ...envelope, senderId: 'bob', deliveryStatus: 'sent' }, jest.fn());
  h.session.api.conversations.mockResolvedValue({ items: [{ ...conversation, interactionAllowed: false }], nextCursor: null }); await h.live.refresh();
  resolve('previous conversation plaintext'); await flush(); expect(h.live.getSnapshot().rows[conversation.id]).toBeUndefined();
  await expect(h.live.send(conversation.id, 'Alice', 'never sent', 'live', jest.fn())).rejects.toBeInstanceOf(ApiError); h.live.dispose();
});
test('typing expires and stops on selection change/disconnect; invisible unknown presence is removed', async () => {
  const h = await setup(); h.live.select(conversation.id, true); h.live.typing(conversation.id);
  h.sockets[0]!.fire('typing:update', { conversationId: conversation.id, userId: 'bob', displayName: 'Bob', isTyping: true, timestamp: envelope.timestamp });
  expect(h.live.getSnapshot().typing[conversation.id]?.isTyping).toBe(true); jest.advanceTimersByTime(5000); expect(h.live.getSnapshot().typing[conversation.id]).toBeUndefined();
  h.sockets[0]!.fire('presence:update', { userId: 'bob', status: 'online', timestamp: envelope.timestamp }); expect(h.live.getSnapshot().presence.bob?.status).toBe('online');
  h.sockets[0]!.fire('presence:update', { userId: 'bob', status: 'unknown', timestamp: envelope.timestamp }); expect(h.live.getSnapshot().presence.bob).toBeUndefined();
  h.live.select(null, false); h.sockets[0]!.drop(); expect(h.live.getSnapshot().typing).toEqual({}); h.live.dispose();
});
test('read and delivery observations are monotonic and never inferred from persistence', async () => {
  const h = await setup([row(1, true)]); expect(h.live.receiptFor(conversation.id, envelope.id)).toBeUndefined();
  h.sockets[0]!.fire('message:read', { ...ack, userId: 'bob', status: 'read' }); h.sockets[0]!.fire('message:delivered', { ...ack, userId: 'bob', status: 'delivered' });
  expect(h.live.receiptFor(conversation.id, envelope.id)?.status).toBe('read'); h.live.dispose();
});
test('read operation only targets decrypted incoming messages in a visible selected conversation', async () => {
  const h = await setup([row(), row(2, true)]); expect(h.sockets[0]!.emit).not.toHaveBeenCalled();
  h.live.select(conversation.id, true); const call = h.sockets[0]!.emit.mock.calls[0]!;
  expect(call.slice(0, 2)).toEqual(['message:read', { conversationId: conversation.id, messageId: envelope.id }]);
  call[2]!({ ...ack, userId: 'alice', status: 'read' }); await flush(); h.live.select(conversation.id, true); expect(h.sockets[0]!.emit).toHaveBeenCalledTimes(1); h.live.dispose();
});
test('disposal clears plaintext memory and ignores in-flight history on account switch', async () => {
  const h = await setup([row()]); let release!: (value: unknown) => void;
  h.session.history.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const task = h.live.sync(conversation.id);
  h.live.dispose(); release({ items: [row(2)], nextCursor: null }); await task; expect(h.live.getSnapshot().rows).toEqual({});
});
test('revoking an unrelated conversation does not drop a live history fetch for an authorized chat', async () => {
  const h = await setup([row()]); const other = { ...conversation, id: 'other-conversation' };
  h.session.api.conversations.mockResolvedValue({ items: [conversation, other], nextCursor: null }); await h.live.refresh(); await flush();
  let release!: (value: unknown) => void;
  h.session.history.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const syncing = h.live.sync(conversation.id);
  h.session.api.conversations.mockResolvedValue({ items: [conversation, { ...other, interactionAllowed: false }], nextCursor: null }); await h.live.refresh();
  release({ items: [row(2), row()], nextCursor: null }); await syncing;
  expect(h.live.getSnapshot().rows[conversation.id]!.map(r => r.message.id)).toEqual(['wire-1', 'wire-2']); h.live.dispose();
});
