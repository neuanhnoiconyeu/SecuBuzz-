import { SecureMessagingSession, type DecryptedRow } from '@/security/e2ee/session';
import type { SessionApi } from '@/api/sessionApi';
import type { EnvelopeV2 } from '@/security/e2ee/model';
import { presentMessages } from '@/components/messenger/authenticatedChatPresentation';
import { envelope } from '@/realtime/testing/authenticatedFixtures';
import { makeAttachmentFile } from '../../../test/attachmentFixtures';
import { voiceWav } from '../../../test/voiceAudioFixture.cjs';
import { AuthenticatedForwarding, canForwardAuthenticatedMessage } from '../authenticatedForwarding';
import { decodeAuthenticatedContent, encodeAuthenticatedContent } from '../authenticatedContent';
import { decryptAttachment, encryptAttachment, fileDigest } from '../encryptedAttachmentCrypto';
import { readAttachmentBytes } from '../attachmentFiles';

const originalDecoder = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
const decode = jest.fn();
beforeAll(() => Object.defineProperty(globalThis, 'OfflineAudioContext', { configurable: true, value: class { decodeAudioData = decode; } }));
beforeEach(() => decode.mockReset().mockResolvedValue({ duration: 1, numberOfChannels: 1 }));
afterAll(() => { if (originalDecoder) Object.defineProperty(globalThis, 'OfflineAudioContext', originalDecoder); else Reflect.deleteProperty(globalThis, 'OfflineAudioContext'); });

async function fixture(name = 'source.pdf', mime = 'application/pdf', voice = false) {
  const file = voice ? new File([voiceWav()], 'voice.wav', { type: 'audio/wav' }) : makeAttachmentFile(name, mime);
  const encrypted = await encryptAttachment(file, { id: crypto.randomUUID(), messageId: crypto.randomUUID(), conversationId: 'source-room', senderId: 'bob' });
  const sourceRow: DecryptedRow = { message: { ...envelope, id: encrypted.manifest.messageId, conversationId: 'source-room', senderId: 'bob', senderName: 'Bob',
    storageId: crypto.randomUUID(), sequence: 1, revision: 1, state: 'active', deletedAt: null, storedAt: envelope.timestamp, updatedAt: envelope.timestamp },
    text: encodeAuthenticatedContent({ text: voice ? '' : 'Original caption', attachments: [encrypted.manifest],
      ...(voice ? { voice: { v: 1 as const, attachmentId: encrypted.manifest.id, durationSeconds: 1 } } : {}) }), error: null };
  const source = presentMessages([sourceRow]).messages[0]!;
  const rows: Record<string, DecryptedRow[]> = { 'source-room': [sourceRow] };
  const storage = new Map([[encrypted.manifest.id, encrypted.bytes]]), posts: Array<{ path: string; bytes: ArrayBuffer; type: string }> = [];
  const request = jest.fn(async (path: string) => path.includes('/limits') ? { v: 1, maxCiphertextBytes: 64 * 1024 * 1024 } : { sealed: true });
  const binary = jest.fn(async (path: string, options: Parameters<NonNullable<SessionApi['binary']>>[1]) => {
    if (options.method === 'GET') {
      const bytes = storage.get(path.split('/')[3]!); if (!bytes) throw new Error('Unavailable');
      // Node Web Crypto owns another realm; browser downloads return this window's ArrayBuffer.
      const downloaded = new ArrayBuffer(bytes.byteLength); new Uint8Array(downloaded).set(new Uint8Array(bytes)); return downloaded;
    }
    const bytes = await readAttachmentBytes(options.body!), query = new URL('http://test' + path).searchParams;
    posts.push({ path, bytes, type: options.body!.type }); storage.set(query.get('id')!, bytes);
    return { v: 1, id: query.get('id'), conversationId: query.get('conversation_id'), messageId: query.get('message_id'), senderId: 'alice', ciphertextSize: bytes.byteLength, sha256: await fileDigest(bytes) };
  });
  const api: SessionApi = { actor: { id: 'alice', username: 'alice' }, request, binary, dispose() {} };
  const session = new SecureMessagingSession(api);
  const permitted = jest.spyOn(session.api, 'getConversation').mockImplementation(async id => {
    if (id === 'invalid') throw new Error('Forbidden');
    return { id, type: 'direct' as const, interactionAllowed: true, createdAt: envelope.timestamp, updatedAt: envelope.timestamp,
      participants: [{ id: 'alice', username: 'alice', displayName: 'Alice', avatar: '' }, { id: 'bob', username: 'bob', displayName: 'Bob', avatar: '' }] };
  });
  const history = jest.spyOn(session, 'history').mockImplementation(async cid => ({ items: rows[cid] ?? [], nextCursor: null }));
  let pending: { envelope: EnvelopeV2; text: string } | null = null;
  jest.spyOn(session, 'pending').mockImplementation(async cid => pending?.envelope.conversationId === cid ? pending.envelope : null);
  jest.spyOn(session, 'decryptIncoming').mockImplementation(async () => pending!.text);
  const save = (cid: string, text: string, id = crypto.randomUUID()) => {
    const message = { ...sourceRow.message, id, conversationId: cid, senderId: 'alice', senderName: 'Alice', storageId: crypto.randomUUID() };
    (rows[cid] ??= []).push({ message, text, error: null }); return message;
  };
  const send = jest.spyOn(session, 'send').mockImplementation(async (cid, _, text, _submit, _progress, id) => save(cid, text, id));
  const retry = jest.spyOn(session, 'retryPending').mockImplementation(async cid => {
    if (!pending) return null;
    const saved = rows[cid]?.find(row => row.message.id === pending!.envelope.id)?.message ?? save(cid, pending.text, pending.envelope.id);
    pending = null; return saved;
  });
  const engine = new AuthenticatedForwarding(session);
  return { engine, source, sourceRow, encrypted, file, rows, storage, request, binary, posts, session, send, save, permitted, history, retry,
    pending(cid: string, text: string, id: string) { pending = { envelope: { ...envelope, id, conversationId: cid, senderId: 'alice' }, text }; } };
}

test.each([
  ['photo.png', 'image/png', false], ['clip.mp4', 'video/mp4', false], ['manual.pdf', 'application/pdf', false],
  ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', false], ['data.txt', 'text/plain', false],
  ['backup.zip', 'application/zip', false], ['voice.wav', 'audio/wav', true],
] as const)('%s is independently encrypted per destination and recipients recover the original bytes', async (name, mime, voice) => {
  const f = await fixture(name, mime, voice); expect(canForwardAuthenticatedMessage(f.source)).toBe(true);
  expect(await f.engine.forward(f.source, ['target-a', 'target-b'], '', 'op', 'Alice', 'rest')).toEqual({ failed: [], noteFailed: [] });
  const manifests = ['target-a', 'target-b'].map(cid => decodeAuthenticatedContent(f.rows[cid]![0]!.text!)!.attachments![0]!);
  for (const [index, manifest] of manifests.entries()) {
    expect(manifest).toMatchObject({ conversationId: index ? 'target-b' : 'target-a', senderId: 'alice', name: f.file.name, mimeType: mime, size: f.file.size });
    expect(manifest.key).not.toBe(f.encrypted.manifest.key); expect(manifest.id).not.toBe(f.encrypted.manifest.id);
    expect(manifest.messageId).toBe(f.rows[manifest.conversationId]![0]!.message.id);
    const ciphertext = f.storage.get(manifest.id)!;
    expect(Array.from(new Uint8Array(ciphertext))).not.toEqual(Array.from(new Uint8Array(await readAttachmentBytes(f.file))));
    expect(Array.from(new Uint8Array(ciphertext))).not.toEqual(Array.from(new Uint8Array(f.encrypted.bytes)));
    expect(await fileDigest(await readAttachmentBytes(await decryptAttachment(manifest, ciphertext)))).toBe(await fileDigest(await readAttachmentBytes(f.file)));
    await expect(decryptAttachment({ ...manifest, conversationId: 'wrong-destination' }, ciphertext)).rejects.toThrow('integrity');
    const content = decodeAuthenticatedContent(f.rows[manifest.conversationId]![0]!.text!)!;
    expect(content.forwarded).toBe(true); expect(content.reply).toBeUndefined();
    const presented = presentMessages(f.rows[manifest.conversationId]!);
    expect(presented.verifiedIds.has(manifest.messageId)).toBe(true);
    if (voice) expect(presented.messages[0]!.voice).toMatchObject({ durationSeconds: 1, audioUrl: '', attachment: { encrypted: manifest } });
  }
  expect(manifests[0]!.key).not.toBe(manifests[1]!.key); expect(manifests[0]!.iv).not.toBe(manifests[1]!.iv);
  for (const post of f.posts) { expect(post.type).toBe('application/octet-stream'); expect(post.path).not.toContain(f.file.name); expect(post.path).not.toContain(f.encrypted.manifest.key); }
  expect(f.binary.mock.calls.filter(([, options]) => options.method === 'GET')).toHaveLength(1);
  f.engine.dispose();
});

test('optional-note failure retries only the note, including after controller recreation', async () => {
  const f = await fixture(); const normal = f.send.getMockImplementation()!;
  f.send.mockImplementationOnce(normal).mockRejectedValueOnce(new Error('Note offline'));
  expect(await f.engine.forward(f.source, ['target-a'], 'note', 'op', 'Alice', 'rest')).toMatchObject({ failed: ['target-a'], noteFailed: ['target-a'] });
  const recreated = new AuthenticatedForwarding(f.session);
  expect(await recreated.forward(f.source, ['target-a'], 'note', 'op', 'Alice', 'rest')).toEqual({ failed: [], noteFailed: [] });
  expect(f.posts).toHaveLength(1); expect(f.rows['target-a']).toHaveLength(2); expect(f.send).toHaveBeenCalledTimes(3);
  f.engine.dispose(); recreated.dispose();
});

test.each([true, false])('lost message acknowledgement (committed=%s) reuses pending ciphertext after controller recreation', async committed => {
  const f = await fixture(); f.send.mockImplementationOnce(async (cid, _, text, _submit, _progress, id) => {
    f.pending(cid, text, id!); if (committed) f.save(cid, text, id); throw new Error('Lost acknowledgement');
  });
  expect((await f.engine.forward(f.source, ['target-a'], '', 'op', 'Alice', 'rest')).failed).toEqual(['target-a']);
  const recreated = new AuthenticatedForwarding(f.session);
  expect(await recreated.forward(f.source, ['target-a'], '', 'op', 'Alice', 'rest')).toEqual({ failed: [], noteFailed: [] });
  expect(f.posts).toHaveLength(1); expect(f.send).toHaveBeenCalledTimes(1); expect(f.retry).toHaveBeenCalledTimes(1); expect(f.rows['target-a']).toHaveLength(1);
  f.engine.dispose(); recreated.dispose();
});

test('lost upload acknowledgement retries the identical encrypted object and sends once', async () => {
  const f = await fixture(), binary = f.binary.getMockImplementation()!; let fail = true;
  f.binary.mockImplementation(async (path, options) => { const result = await binary(path, options); if (options.method === 'POST' && fail) { fail = false; throw new Error('Lost upload acknowledgement'); } return result; });
  expect((await f.engine.forward(f.source, ['target-a'], '', 'op', 'Alice', 'rest')).failed).toEqual(['target-a']);
  expect(await f.engine.forward(f.source, ['target-a'], '', 'op', 'Alice', 'rest')).toEqual({ failed: [], noteFailed: [] });
  expect(f.posts[0]).toEqual(f.posts[1]); expect(f.send).toHaveBeenCalledTimes(1); f.engine.dispose();
});

test.each(['invalid-destination', 'source-unsent', 'missing-source', 'missing-key', 'corrupt', 'server-limit', 'foreign-pending'] as const)('%s fails without a forwarded message or plaintext upload', async failure => {
  const f = await fixture(); let target = 'target-a';
  if (failure === 'invalid-destination') target = 'invalid';
  if (failure === 'source-unsent') f.sourceRow.message.state = 'deleted';
  if (failure === 'missing-source') f.rows['source-room'] = [];
  if (failure === 'missing-key') f.sourceRow.text = null;
  if (failure === 'corrupt') { const bytes = f.encrypted.bytes.slice(0); new Uint8Array(bytes)[0] ^= 1; f.storage.set(f.encrypted.manifest.id, bytes); }
  if (failure === 'server-limit') f.request.mockResolvedValue({ v: 1, maxCiphertextBytes: 17 } as never);
  if (failure === 'foreign-pending') f.pending(target, 'another composer draft', crypto.randomUUID());
  expect((await f.engine.forward(f.source, [target], '', 'op', 'Alice', 'rest')).failed).toEqual([target]);
  expect(f.send).not.toHaveBeenCalled(); expect(f.posts).toHaveLength(0); f.engine.dispose();
});

test('changed retry contents, source binding and unsupported demo media are rejected', async () => {
  const f = await fixture();
  const unencrypted = { ...f.source.attachments![0]! }; delete unencrypted.encrypted;
  for (const source of [{ ...f.source, demoOnly: true as const }, { ...f.source, type: 'voice' as const },
    { ...f.source, attachments: [unencrypted] }]) expect(canForwardAuthenticatedMessage(source)).toBe(false);
  await f.engine.forward(f.source, ['invalid'], '', 'op', 'Alice', 'rest');
  expect((await f.engine.forward({ ...f.source, content: 'changed' }, ['target-a'], '', 'op', 'Alice', 'rest')).failed).toEqual(['target-a']);
  const wrong = { ...f.source, attachments: [{ ...f.source.attachments![0]!, encrypted: { ...f.encrypted.manifest, messageId: crypto.randomUUID() } }] };
  expect(canForwardAuthenticatedMessage(wrong)).toBe(false); expect(f.send).not.toHaveBeenCalled(); f.engine.dispose();
});

test('invalid protected voice duration cannot be forwarded', async () => {
  const f = await fixture('voice.wav', 'audio/wav', true); decode.mockResolvedValue({ duration: 10, numberOfChannels: 1 });
  expect((await f.engine.forward(f.source, ['target-a'], '', 'op', 'Alice', 'rest')).failed).toEqual(['target-a']);
  expect(f.posts).toHaveLength(0); f.engine.dispose();
});

test('closing an operation during source download aborts delivery and releases its resources', async () => {
  const f = await fixture(), normal = f.binary.getMockImplementation()!;
  let complete!: () => void, observed: AbortSignal | undefined;
  f.binary.mockImplementationOnce((path, options) => { observed = options.signal; return new Promise(resolve => { complete = async () => resolve(await normal(path, options)); }); });
  const pending = f.engine.forward(f.source, ['target-a'], '', 'op', 'Alice', 'rest');
  for (let i = 0; i < 50 && !complete; i++) await Promise.resolve();
  expect(complete).toBeDefined(); f.engine.release('op'); expect(observed?.aborted).toBe(true);
  complete(); expect((await pending).failed).toEqual(['target-a']); expect(f.send).not.toHaveBeenCalled(); expect(f.posts).toHaveLength(0);
});

test('concurrent duplicate submissions cannot create two uploads/messages for one destination', async () => {
  const f = await fixture();
  const results = await Promise.all([f.engine.forward(f.source, ['target-a'], '', 'op', 'Alice', 'rest'), f.engine.forward(f.source, ['target-a'], '', 'op', 'Alice', 'rest')]);
  expect(results.filter(result => !result.failed.length)).toHaveLength(1);
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.posts).toHaveLength(1); f.engine.dispose();
});

test('a received forwarded attachment can be forwarded again without copying its previous operation or file key', async () => {
  const f = await fixture(); await f.engine.forward(f.source, ['target-a'], '', 'first', 'Alice', 'rest');
  const forwarded = presentMessages(f.rows['target-a']!).messages[0]!;
  expect(await f.engine.forward(forwarded, ['target-b'], '', 'second', 'Alice', 'rest')).toEqual({ failed: [], noteFailed: [] });
  const first = decodeAuthenticatedContent(f.rows['target-a']![0]!.text!)!, second = decodeAuthenticatedContent(f.rows['target-b']![0]!.text!)!;
  expect(second.operation?.id).toBe('second'); expect(second.attachments![0]!.key).not.toBe(first.attachments![0]!.key);
  expect(await fileDigest(await readAttachmentBytes(await decryptAttachment(second.attachments![0]!, f.storage.get(second.attachments![0]!.id)!)))).toBe(await fileDigest(await readAttachmentBytes(f.file)));
  f.engine.dispose();
});
