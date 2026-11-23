import { SecureMessagingSession, type DecryptedRow } from '@/security/e2ee/session';
import type { SecureRealtimeWorkspace } from '@/realtime/SecureRealtimeWorkspace';
import type { EnvelopeV2, DirectConversation } from '@/security/e2ee/model';
import type { ChatMessage } from '../messageModel';
import { AuthenticatedForwarding } from '../authenticatedForwarding';
import { decodeAuthenticatedContent, encodeAuthenticatedContent } from '../authenticatedContent';
import { envelope } from '@/realtime/testing/authenticatedFixtures';

const source: ChatMessage = { id: 'source', conversationId: 'source-room', senderId: 'bob', senderName: 'Bob', content: 'Forward this\n👩🏽‍💻', type: 'text', timestamp: envelope.timestamp, deliveryStatus: 'read' };
function fixture() {
  const session = new SecureMessagingSession({ actor: { id: 'alice', username: 'alice' }, request: jest.fn(), dispose() {} });
  const rows: Record<string, DecryptedRow[]> = {};
  let outstanding: EnvelopeV2 | null = null, pendingText = '';
  const conversation = (id: string): DirectConversation => ({ id, type: 'direct', interactionAllowed: true, createdAt: envelope.timestamp, updatedAt: envelope.timestamp,
    participants: [{ id: 'alice', username: 'alice', displayName: 'Alice', avatar: '' }, { id: 'bob', username: 'bob', displayName: 'Bob', avatar: '' }] });
  const permitted = jest.spyOn(session.api, 'getConversation').mockImplementation(async id => {
    if (id === 'invalid') throw new Error('Forbidden'); return conversation(id);
  });
  const history = jest.spyOn(session, 'history').mockImplementation(async cid => ({ items: rows[cid] ?? [], nextCursor: null }));
  jest.spyOn(session, 'pending').mockImplementation(async cid => outstanding?.conversationId === cid ? outstanding : null);
  jest.spyOn(session, 'decryptIncoming').mockImplementation(async () => pendingText);
  const save = (cid: string, text: string) => {
    const message = { ...envelope, id: 'wire-' + (rows[cid]?.length ?? 0), conversationId: cid, senderId: 'alice', storageId: 'storage', sequence: 1, revision: 1,
      state: 'active' as const, deletedAt: null, storedAt: envelope.timestamp, updatedAt: envelope.timestamp };
    (rows[cid] ??= []).push({ message, text, error: null }); return message;
  };
  const send = jest.spyOn(session, 'send').mockImplementation(async (cid, _, text) => save(cid, text));
  const retry = jest.spyOn(session, 'retryPending').mockImplementation(async cid => {
    if (!outstanding) return null;
    const result = rows[cid]?.find(row => row.text === pendingText)?.message ?? save(cid, pendingText);
    outstanding = null; return result;
  });
  return { session, rows, send, retry, history, permitted, save, engine: new AuthenticatedForwarding(session),
    pending(cid: string, text: string, wireId = 'pending') { pendingText = text; outstanding = { ...envelope, id: wireId, conversationId: cid, senderId: 'alice' }; } };
}

test('valid destinations use separate authenticated sends; unauthorized targets never receive a message', async () => {
  const f = fixture();
  expect(await f.engine.forward(source, ['one', 'invalid', 'two'], '', 'op', 'Alice', 'rest')).toEqual({ failed: ['invalid'], noteFailed: [] });
  expect(f.send.mock.calls.map(call => call[0])).toEqual(['one', 'two']);
  for (const call of f.send.mock.calls) expect(decodeAuthenticatedContent(call[2])).toMatchObject({ text: source.content, forwarded: true, operation: { id: 'op', part: 'message' } });
});
test('optional-note failure reports partial completion and retries only the unfinished note', async () => {
  const f = fixture(); f.send.mockImplementationOnce(async (cid, _, text) => f.save(cid, text)).mockRejectedValueOnce(new Error('Note failed'));
  expect(await f.engine.forward(source, ['one'], 'note', 'op', 'Alice', 'rest')).toEqual({ failed: ['one'], noteFailed: ['one'] });
  expect(await f.engine.forward(source, ['one'], 'note', 'op', 'Alice', 'rest')).toEqual({ failed: [], noteFailed: [] });
  expect(f.send).toHaveBeenCalledTimes(3); expect(f.rows.one).toHaveLength(2);
  expect(f.rows.one?.map(row => decodeAuthenticatedContent(row.text!)?.operation?.part)).toEqual(['message', 'note']);
});
test('a lost acknowledgment reconciles an already committed forward and its pending envelope after controller recreation', async () => {
  const f = fixture(); f.send.mockImplementationOnce(async (cid, _, text) => {
    const saved = f.save(cid, text); f.pending(cid, text, saved.id); throw new Error('Lost ack');
  });
  expect((await f.engine.forward(source, ['one'], 'note', 'op', 'Alice', 'rest')).failed).toEqual(['one']);
  const recreated = new AuthenticatedForwarding(f.session);
  expect(await recreated.forward(source, ['one'], 'note', 'op', 'Alice', 'rest')).toEqual({ failed: [], noteFailed: [] });
  expect(f.retry).toHaveBeenCalledTimes(1); expect(f.send).toHaveBeenCalledTimes(2); expect(f.rows.one).toHaveLength(2);
});
test('an uncommitted pending forward retries the same envelope instead of creating a new send', async () => {
  const f = fixture(); f.send.mockImplementationOnce(async (cid, _, text) => { f.pending(cid, text); throw new Error('Offline'); });
  await f.engine.forward(source, ['one'], '', 'op', 'Alice', 'rest');
  expect(await f.engine.forward(source, ['one'], '', 'op', 'Alice', 'rest')).toEqual({ failed: [], noteFailed: [] });
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.retry).toHaveBeenCalledTimes(1); expect(f.rows.one).toHaveLength(1);
});
test('a post-persistence workspace refresh failure cannot create another forward', async () => {
  const f = fixture();
  const live = { send: jest.fn(async (cid: string, name: string, text: string) => { await f.session.send(cid, name, text); throw new Error('History refresh failed'); }), retry: jest.fn() };
  await new AuthenticatedForwarding(f.session, live as unknown as SecureRealtimeWorkspace).forward(source, ['one'], '', 'op', 'Alice', 'live');
  expect(await new AuthenticatedForwarding(f.session, live as unknown as SecureRealtimeWorkspace).forward(source, ['one'], '', 'op', 'Alice', 'live')).toEqual({ failed: [], noteFailed: [] });
  expect(live.send).toHaveBeenCalledTimes(1); expect(f.rows.one).toHaveLength(1);
});
test('foreign pending drafts, media, changed retry contents and inaccessible source conversations fail safely', async () => {
  const f = fixture(); f.pending('one', 'Unrelated draft');
  expect((await f.engine.forward(source, ['one'], '', 'op', 'Alice', 'rest')).failed).toEqual(['one']); expect(f.retry).not.toHaveBeenCalled();
  expect((await f.engine.forward({ ...source, type: 'voice' }, ['two'], '', 'voice', 'Alice', 'rest')).failed).toEqual(['two']);
  expect((await f.engine.forward({ ...source, content: 'Changed retry' }, ['two'], '', 'op', 'Alice', 'rest')).failed).toEqual(['two']);
  expect((await f.engine.forward({ ...source, conversationId: 'invalid' }, ['two'], '', 'invalid-source', 'Alice', 'rest')).failed).toEqual(['two']);
  expect(f.send).not.toHaveBeenCalled();
});
test('both operations validate destination permissions, including revocation between forward and note', async () => {
  const f = fixture(), permitted = f.permitted.getMockImplementation()!;
  f.send.mockImplementationOnce(async (cid, _, text) => {
    const saved = f.save(cid, text); f.permitted.mockImplementation(async id => { if (id === cid) throw new Error('Access revoked'); return permitted(id); }); return saved;
  });
  expect(await f.engine.forward(source, ['one'], 'note', 'op', 'Alice', 'rest')).toEqual({ failed: ['one'], noteFailed: ['one'] });
  expect(f.send).toHaveBeenCalledTimes(1);
});
test('reconciliation looks beyond the first history page and never sends when history cannot be fully checked', async () => {
  const f = fixture(), text = encodeAuthenticatedContent({ text: source.content, forwarded: true, operation: { id: 'op', part: 'message' } });
  const old = f.save('one', text); f.history.mockImplementation(async (_, cursor) => cursor ? { items: [{ message: old, text, error: null }], nextCursor: null } : { items: [], nextCursor: 'older' });
  expect((await f.engine.forward(source, ['one'], '', 'op', 'Alice', 'rest')).failed).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  f.history.mockResolvedValue({ items: [], nextCursor: 'more' });
  expect((await f.engine.forward(source, ['two'], '', 'other', 'Alice', 'rest')).failed).toEqual(['two']); expect(f.send).not.toHaveBeenCalled();
});

test('another participant cannot spoof completed operation metadata, and conflicting own operations never resend', async () => {
  const f = fixture(), text = encodeAuthenticatedContent({ text: source.content, forwarded: true, operation: { id: 'op', part: 'message' } });
  f.save('one', text).senderId = 'bob';
  expect((await f.engine.forward(source, ['one'], '', 'op', 'Alice', 'rest')).failed).toEqual([]);
  expect(f.send).toHaveBeenCalledTimes(1);
  const recreated = new AuthenticatedForwarding(f.session);
  expect((await recreated.forward({ ...source, content: 'Conflicting operation body' }, ['one'], '', 'op', 'Alice', 'rest')).failed).toEqual(['one']);
  expect(f.send).toHaveBeenCalledTimes(1);
});
