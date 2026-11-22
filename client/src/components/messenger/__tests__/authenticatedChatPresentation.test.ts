import { presentConnection, presentConversations, presentMessages, presentSendState } from '../authenticatedChatPresentation';
import type { DecryptedRow } from '@/security/e2ee/session';
import type { SecureLiveState } from '@/realtime/SecureRealtimeWorkspace';
import { conversation, envelope } from '@/realtime/testing/authenticatedFixtures';
import { AUTHENTICATED_CONTENT_PREFIX, encodeAuthenticatedContent } from '@/messaging/authenticatedContent';

const row = (sequence = 1): DecryptedRow => ({ message: { ...envelope, id: 'm-' + sequence, storageId: 'storage-' + sequence,
  sequence, revision: 1, state: 'active', deletedAt: null, storedAt: envelope.timestamp, updatedAt: envelope.timestamp },
  text: 'Locally decrypted ' + sequence, error: null });
const empty: SecureLiveState = { connection: 'connected', conversations: [], rows: {}, cursors: {}, unread: {}, typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 0 };

test('only decrypted text reaches message presentation; wire IDs, grouping metadata and sequence order are retained', () => {
  const result = presentMessages([row(2), row(1)]);
  expect(result.messages.map(m => m.id)).toEqual(['m-1', 'm-2']);
  expect(result.messages[0]).toMatchObject({ content: 'Locally decrypted 1', senderId: envelope.senderId, timestamp: envelope.timestamp, type: 'text', deliveryStatus: 'sent' });
  expect(JSON.stringify(result.messages)).not.toContain(envelope.encryption.ciphertext);
  expect(result.messages.every(m => !m.demoOnly && !m.encryption)).toBe(true);
  expect([...result.verifiedIds]).toEqual(['m-1', 'm-2']);
});
test('undecryptable messages and deleted tombstones never display ciphertext or claim successful verification', () => {
  const unreadable = { ...row(1), text: null, error: 'Unable to decrypt this message.' };
  const deleted = row(2); deleted.message.state = 'deleted'; deleted.message.encryption = null;
  const result = presentMessages([unreadable, deleted]);
  expect(result.messages[0]).toMatchObject({ type: 'security_alert', content: unreadable.error });
  expect(result.messages[1]).toMatchObject({ isDeleted: true, content: 'Message deleted' });
  expect(result.verifiedIds.size).toBe(0);
});
test('persistence alone is sent; delivery/read require a matching receipt', () => {
  expect(presentMessages([row()]).messages[0]?.deliveryStatus).toBe('sent');
  expect(presentMessages([row()], (cid, id) => ({ conversationId: cid, messageId: id, userId: 'bob', status: 'read', timestamp: envelope.timestamp })).messages[0]?.deliveryStatus).toBe('read');
  expect(presentMessages([row()], (_, id) => ({ conversationId: 'other', messageId: id, userId: 'bob', status: 'delivered', timestamp: envelope.timestamp })).messages[0]?.deliveryStatus).toBe('sent');
});
test('sidebar uses authenticated participants, decrypted previews, server timestamps and privacy-filtered presence', () => {
  const r = row(); r.message.conversationId = conversation.id;
  const state = { ...empty, rows: { [conversation.id]: [r] }, unread: { [conversation.id]: 3 }, presence: { bob: { userId: 'bob', status: 'unknown' as const, timestamp: envelope.timestamp } } };
  const result = presentConversations([conversation], 'alice', state, conversation.id, []);
  expect(result[0]).toMatchObject({ displayName: 'Bob', type: 'direct', unreadCount: 3, lastMessagePreview: 'Locally decrypted 1', lastActivityAt: envelope.timestamp });
  expect(result[0]).not.toHaveProperty('presence');
});
test('connection projection retains reconnect and authentication failure without asserting a connection', () => {
  expect(presentConnection('reconnecting')).toBe('reconnecting'); expect(presentConnection('connected')).toBe('connected');
  expect(presentConnection('auth_failed')).toBe('error'); expect(presentConnection()).toBe('disconnected');
});

test('switching conversations cannot use the previous REST page as another conversation’s preview', () => {
  const result = presentConversations([conversation], 'alice', empty, conversation.id, [{ ...row(), message: { ...row().message, conversationId: 'other-conversation' } }]);
  expect(result[0]?.lastMessagePreview).toBe('Open conversation');
});

test('unsupported encryption cannot become plaintext presentation or an encrypted badge', () => {
  const unsupported = row(); unsupported.message.encryption = null;
  const result = presentMessages([unsupported]);
  expect(result.messages[0]?.type).toBe('security_alert'); expect(result.messages[0]?.content).not.toBe(unsupported.text);
  expect(result.verifiedIds.size).toBe(0);
});
test('send progress uses user-facing wording without inferring delivery from persistence', () => {
  expect(presentSendState('Persisted — delivery pending')).toBe('Message sent');
  expect(presentSendState('Awaiting persistence acknowledgment')).toBe('Sending encrypted message…');
  expect(presentSendState('Message not confirmed. Your draft is preserved.')).toBe('Message not confirmed. Your draft is preserved.');
});

test('local hiding filters message bodies, encrypted badges and sidebar previews without changing raw history', () => {
  const visible = row(1), hidden = row(2);
  visible.message.conversationId = conversation.id; hidden.message.conversationId = conversation.id;
  const rows = [visible, hidden], original = JSON.stringify(rows);
  const isHidden = (cid: string, id: string) => cid === conversation.id && id === hidden.message.id;
  expect(presentMessages(rows, undefined, isHidden).messages.map(m => m.id)).toEqual([visible.message.id]);
  expect(presentMessages(rows, undefined, isHidden).verifiedIds.has(hidden.message.id)).toBe(false);
  const state = { ...empty, rows: { [conversation.id]: rows } };
  expect(presentConversations([conversation], 'alice', state, conversation.id, [], isHidden)[0]?.lastMessagePreview).toBe(visible.text);
  expect(presentConversations([conversation], 'alice', empty, conversation.id, rows, () => true)[0]?.lastMessagePreview).toBe('Open conversation');
  expect(presentMessages([{ ...hidden, message: { ...hidden.message, conversationId: 'another-conversation' } }], undefined, isHidden).messages).toHaveLength(1);
  expect(presentMessages(rows).messages).toHaveLength(2); expect(JSON.stringify(rows)).toBe(original);
});

test('reply labels and quotes come from verified originals, and hidden/deleted/unavailable originals disclose no snippets', () => {
  const original = row(1), reply = row(2);
  reply.text = encodeAuthenticatedContent({ text: 'Reply body', reply: { messageId: original.message.id, senderId: original.message.senderId } });
  expect(presentMessages([reply, original]).messages[1]).toMatchObject({ content: 'Reply body', replyTo: { messageId: 'm-1', senderName: original.message.senderName, contentSnippet: original.text } });
  for (const rows of [[reply], [reply, { ...original, error: 'Unavailable', text: null }], [reply, { ...original, message: { ...original.message, state: 'deleted' as const, encryption: null } }]]) {
    expect(presentMessages(rows).messages.find(m => m.id === reply.message.id)?.replyTo).toMatchObject({ senderName: 'a message', contentSnippet: 'Original message unavailable.' });
  }
  expect(presentMessages([original, reply], undefined, (_, id) => id === original.message.id).messages[0]?.replyTo).toMatchObject({ senderName: 'a message', contentSnippet: 'Original message unavailable.' });
  const otherRoom = { ...original, message: { ...original.message, conversationId: 'another-room' } };
  expect(presentMessages([otherRoom, reply]).messages[1]?.replyTo?.contentSnippet).toBe('Original message unavailable.');
  reply.text = encodeAuthenticatedContent({ text: 'Spoofed attribution', reply: { messageId: original.message.id, senderId: 'wrong-person' } });
  expect(presentMessages([original, reply]).messages[1]?.replyTo).toBeUndefined();
});

test('forward/note presentation and sidebar decode application text without showing wire metadata', () => {
  const forwarded = row(1); forwarded.message.conversationId = conversation.id;
  forwarded.text = encodeAuthenticatedContent({ text: 'Forwarded body', forwarded: true, operation: { id: 'op', part: 'message' } });
  expect(presentMessages([forwarded]).messages[0]).toMatchObject({ content: 'Forwarded body', isForwarded: true });
  expect(presentMessages([forwarded]).messages[0]?.forwardedFrom).toBeUndefined();
  expect(presentConversations([conversation], 'alice', empty, conversation.id, [forwarded])[0]?.lastMessagePreview).toBe('Forwarded body');
  const invalid = { ...forwarded, text: AUTHENTICATED_CONTENT_PREFIX + '{"v":999,"text":"Unsupported"}' };
  expect(presentMessages([invalid]).messages[0]).toMatchObject({ type: 'security_alert', content: 'Message unavailable on this device.' });
  expect(presentMessages([invalid]).verifiedIds.size).toBe(0);
});
