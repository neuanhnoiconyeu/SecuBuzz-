import { AUTHENTICATED_CONTENT_PREFIX as prefix, decodeAuthenticatedContent as decode, encodeAuthenticatedContent as encode } from '../authenticatedContent';

test('legacy text, JSON and Unicode stay literal; reserved-prefix text is escaped without recursive parsing', () => {
  for (const text of ['Hello 👩🏽‍💻\nNext line', '{"v":1,"text":"literal JSON"}', prefix + '{"v":1,"text":"literal prefixed JSON"}']) {
    expect(decode(encode({ text }))).toEqual({ text });
  }
  expect(encode({ text: 'Unchanged ordinary text' })).toBe('Unchanged ordinary text');
});
test('reply and forward metadata are versioned inside content and never include quoted plaintext or source attribution', () => {
  const reply = { text: 'Reply text', reply: { messageId: 'original-id', senderId: 'bob' } };
  expect(decode(encode(reply))).toEqual(reply); expect(encode(reply)).toContain('"v":1');
  const forward = { text: 'Forwarded text', forwarded: true as const, operation: { id: 'operation-id', part: 'message' as const } };
  expect(decode(encode(forward))).toEqual(forward);
  expect(decode(encode({ text: 'Note', operation: { id: 'operation-id', part: 'note' } }))).toEqual({ text: 'Note', operation: { id: 'operation-id', part: 'note' } });
});
test.each([
  { v: 2, text: 'unknown version' }, { v: 1, text: 'media', attachments: [] },
  { v: 1, text: 'spoof', reply: { messageId: 'id', senderId: 'bob', contentSnippet: 'forged quote' } },
  { v: 1, text: 'bad', reply: { messageId: 'white space', senderId: 'bob' } },
  { v: 1, text: 'bad', reply: { messageId: [], senderId: 'bob' } },
  { v: 1, text: 'bad', forwarded: true },
  { v: 1, text: 'bad', forwarded: true, operation: { id: 'op', part: 'note' } },
  { v: 1, text: 'bad', operation: { id: 'op', part: 'message' } },
  { v: 1, text: 'bad', reply: { messageId: 'id', senderId: 'bob' }, operation: { id: 'op', part: 'note' } },
  { v: 1, text: '', reply: { messageId: 'id', senderId: 'bob' } },
])('malformed or unsupported content fails closed (%j)', packet => expect(decode(prefix + JSON.stringify(packet))).toBeNull());
test('malformed JSON and byte limits fail before sending, without stripping line breaks or emoji', () => {
  expect(decode(prefix + '{')).toBeNull();
  expect(() => encode({ text: '😀'.repeat(13000), reply: { messageId: 'id', senderId: 'bob' } })).toThrow();
});
