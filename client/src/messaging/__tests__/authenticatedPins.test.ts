import { webcrypto } from 'node:crypto';
import { ApiError, type ApiRequest } from '@/api/sessionApi';
import { SecureMessagingSession } from '@/security/e2ee/session';
import { E2eeError, type StoredMessage } from '@/security/e2ee/model';
import { conversation, envelope } from '@/realtime/testing/authenticatedFixtures';
import { AuthenticatedPins, type PinCollection } from '../authenticatedPins';

const message: StoredMessage = { ...envelope, storageId: 'server-storage-id', sequence: 1, revision: 0, state: 'active', deletedAt: null, storedAt: envelope.timestamp, updatedAt: envelope.timestamp };
const pin = { message, pinnedBy: 'bob', pinnedAt: envelope.timestamp };
beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); });
afterEach(() => jest.restoreAllMocks());
async function fixture(initial = false, missingKeys = false) {
  let snapshot: PinCollection = { conversationId: conversation.id, version: initial ? 1 : 0, items: initial ? [pin] : [] };
  // Responses deliberately contain only the actual contract keys.
  const post = jest.fn(async (intent: { operationId: string; pinned: boolean; expectedVersion: number }) => {
    snapshot = { ...snapshot, version: snapshot.version + 1, items: intent.pinned ? [pin] : [] };
    return { conversationId: conversation.id, storageId: message.storageId, messageId: message.id, pinned: intent.pinned, operationId: intent.operationId, version: snapshot.version };
  });
  const request = jest.fn(async (_path: string, options?: ApiRequest): Promise<unknown> => options?.method === 'POST'
    ? post(options.body as { operationId: string; pinned: boolean; expectedVersion: number }) : snapshot);
  const session = new SecureMessagingSession({ actor: { id: 'alice', username: 'alice' }, request, dispose() {} });
  const decrypt = jest.spyOn(session, 'decryptStoredMessage').mockResolvedValue({message,text:'First line 👩🏽‍💻\nTiếng Việt',error:null});
  if (missingKeys) decrypt.mockRejectedValue(new E2eeError('missing_key'));
  const store = new AuthenticatedPins(session); store.authorize([conversation]); await store.refresh(conversation.id);
  return { store, session, request, post, decrypt, snapshot: (value: PinCollection) => { snapshot = value; } };
}

test('pin uses the storage ID, accepts either participant, and decrypts references through the existing session', async () => {
  const f = await fixture(); await f.store.set(message, true);
  expect(f.request).toHaveBeenCalledWith('/api/messages/server-storage-id/pin', expect.objectContaining({ method: 'POST', body: { pinned: true, expectedVersion: 0, operationId: expect.any(String) } }));
  expect(f.store.getSnapshot().collections[conversation.id]?.items).toEqual([pin]);
  expect(f.decrypt).toHaveBeenCalledWith(message); expect(f.store.getSnapshot().rows[conversation.id]?.[0]?.text).toContain('\nTiếng Việt');
  await f.store.refresh(conversation.id); expect(f.decrypt).toHaveBeenCalledTimes(1); f.store.dispose();
});

test('duplicate clicks share one request and leave pin state unchanged until server confirmation', async () => {
  const f = await fixture(); let finish!: () => void;
  f.post.mockImplementationOnce(async intent => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { conversationId: conversation.id, storageId: message.storageId, messageId: message.id, pinned: true, operationId: intent.operationId, version: 1 };
  });
  const first = f.store.set(message, true), second = f.store.set(message, true);
  expect(first).toBe(second); expect(f.post).toHaveBeenCalledTimes(1); expect(f.store.getSnapshot().collections[conversation.id]?.items).toEqual([]);
  expect(f.store.getSnapshot().saving[conversation.id]).toBe(true);
  f.snapshot({ conversationId: conversation.id, version: 1, items: [pin] });
  finish();
  await first; expect(f.store.getSnapshot().saving[conversation.id]).toBe(false); f.store.dispose();
});

test('failed unpin retains the confirmed pin and retries an uncertain request using the same operation ID', async () => {
  const f = await fixture(true); f.post.mockRejectedValueOnce(new ApiError('service_unavailable'));
  await expect(f.store.set(message, false)).rejects.toThrow(); expect(f.store.getSnapshot().collections[conversation.id]?.items).toEqual([pin]);
  await f.store.set(message, false);
  expect(f.post.mock.calls[0]![0]).toEqual(f.post.mock.calls[1]![0]); expect(f.store.getSnapshot().collections[conversation.id]?.items).toEqual([]); f.store.dispose();
});

test('lost acknowledgments reconcile authoritative state without repeating the mutation', async () => {
  const f = await fixture(); f.post.mockImplementationOnce(async () => {
    f.snapshot({ conversationId: conversation.id, version: 1, items: [pin] }); throw new ApiError('unavailable');
  });
  await f.store.set(message, true); expect(f.post).toHaveBeenCalledTimes(1); expect(f.store.getSnapshot().collections[conversation.id]?.version).toBe(1); f.store.dispose();
});

test('concurrent conflict refreshes shared state and reports failure without overwriting the other participant', async () => {
  const f = await fixture(); f.post.mockImplementationOnce(async () => {
    f.snapshot({ conversationId: conversation.id, version: 1, items: [pin] }); throw new ApiError('conflict');
  });
  await expect(f.store.set(message, true)).rejects.toThrow('Pins changed');
  expect(f.store.getSnapshot().collections[conversation.id]?.items).toEqual([pin]); expect(f.post).toHaveBeenCalledTimes(1); f.store.dispose();
});

test('older snapshots cannot restore an unpinned message', async () => {
  const f = await fixture(true);
  await f.store.set(message, false); const version = f.store.getSnapshot().collections[conversation.id]?.version;
  f.snapshot({ conversationId: conversation.id, version: 1, items: [pin] }); await f.store.refresh(conversation.id);
  expect(f.store.getSnapshot().collections[conversation.id]?.version).toBe(version); expect(f.store.getSnapshot().collections[conversation.id]?.items).toEqual([]); f.store.dispose();
});

test('missing historical keys show an unavailable pin without preventing authorized unpin', async () => {
  const f = await fixture(true, true);
  expect(f.store.getSnapshot().rows[conversation.id]?.[0]).toMatchObject({ text: null, errorCode: 'missing_key' });
  await f.store.set(message, false); expect(f.store.getSnapshot().collections[conversation.id]?.items).toEqual([]); f.store.dispose();
});

test('revoked scope and disposal clear pin plaintext and reject mutations', async () => {
  const f = await fixture(true); f.store.authorize([]);
  expect(f.store.getSnapshot().rows).toEqual({}); expect(f.store.getSnapshot().collections).toEqual({});
  await expect(f.store.set(message, false)).rejects.toThrow(); f.store.dispose();
  expect(f.store.getSnapshot().rows).toEqual({});
});

test('late metadata after authorization removal cannot repopulate pin state', async () => {
  const f = await fixture(); let finish!: (value: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.store.refresh(conversation.id); f.store.authorize([]);
  finish({ conversationId: conversation.id, version: 1, items: [pin] }); await pending.catch(() => {});
  expect(f.store.getSnapshot().collections).toEqual({}); expect(f.store.getSnapshot().rows).toEqual({}); f.store.dispose();
});

test('unsent and unsupported messages cannot be pinned and malformed snapshots never replace confirmed state', async () => {
  const f = await fixture();
  await expect(f.store.set({ ...message, state: 'deleted', encryption: null }, true)).rejects.toThrow();
  f.snapshot({ conversationId: conversation.id, version: 1, items: [{ ...pin, pinnedBy: 'outsider' }] });
  await expect(f.store.refresh(conversation.id)).rejects.toThrow(); expect(f.store.getSnapshot().collections[conversation.id]?.items).toEqual([]); f.store.dispose();
});
