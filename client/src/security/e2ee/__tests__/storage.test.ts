/** @jest-environment node */
import { indexedDB } from 'fake-indexeddb';
import { randomUUID, webcrypto } from 'node:crypto';
import { BrowserKeyStore } from '../storage';
import { generateDevice, validateLocalDevice } from '../devices';
import { encryptV2, decryptV2 } from '../messages';
import { openKey, sealKey } from '../hpke';
import { encode } from '../protocol';
import { SecureMessagingSession } from '../session';
import { messageEditHead } from '../edits';
import { envelope } from '@/realtime/testing/authenticatedFixtures';
import type { StoredMessage } from '../model';
beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB }); });
test('actual IndexedDB structured clone restores the same non-extractable device keys across manager instances', async () => {
  const name = 'test-' + randomUUID(), a = new BrowserKeyStore('alice', name), d = await generateDevice('alice');
  await a.enroll(d); a.close(); const reopened = new BrowserKeyStore('alice', name), restored = await reopened.get<typeof d>('device');
  expect(restored?.deviceId).toBe(d.deviceId); await validateLocalDevice(restored!, 'alice'); expect(restored?.agreement.privateKey.extractable).toBe(false); reopened.close();
});
test('account namespaces cannot read each other; simultaneous enrollment stores one identity; closed stores fail', async () => {
  const name = 'test-' + randomUUID(), a = new BrowserKeyStore('alice', name), b = new BrowserKeyStore('bob', name), otherTab = new BrowserKeyStore('alice', name);
  const [first, second] = await Promise.all([a.enroll(await generateDevice('alice')), otherTab.enroll(await generateDevice('alice'))]); expect(first.deviceId).toBe(second.deviceId);
  expect(await b.get('device')).toBeUndefined(); expect(await b.get('enrolled')).toBeUndefined(); a.close(); await expect(a.get('device')).rejects.toMatchObject({ code: 'disposed' }); b.close(); otherTab.close();
});
test('nonce reservations survive restored AES keys and prevent collisions across concurrent tabs', async () => {
  const name = 'test-' + randomUUID(), a = new BrowserKeyStore('alice', name), b = new BrowserKeyStore('alice', name);
  expect((await Promise.all([a.reserveNonce('key', 'nonce'), b.reserveNonce('key', 'nonce')])).sort()).toEqual([false, true]);
  const device = await generateDevice('alice'), raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await sealKey(device.agreementPublicKey, raw, encode('test')); raw.fill(0);
  const key = await openKey(device.agreement, wrapped.enc, wrapped.ciphertext, encode('test'));
  const original = crypto.getRandomValues.bind(crypto), random = jest.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => { array.fill(1); return array; }) as typeof crypto.getRandomValues);
  try { const e = await encryptV2(key, a, { id: 'message', conversationId: 'c', senderId: 'alice', senderName: 'Alice', timestamp: new Date().toISOString(), type: 'text' }, 'AAAAAAAAAAAAAAAAAAAAAA', 'secret'); expect(await decryptV2(key, e)).toBe('secret');
    const restored = await openKey(device.agreement, wrapped.enc, wrapped.ciphertext, encode('test'));
    await expect(encryptV2(restored, b, { ...e, id: 'another', conversationId: 'different-conversation' }, 'AQEBAQEBAQEBAQEBAQEBAQ', 'secret')).rejects.toMatchObject({ code: 'nonce_failed' });
  } finally { random.mockRestore(); expect(crypto.getRandomValues).not.toBe(original); a.close(); b.close(); }
});
test('concurrent late confirmation never deletes a newer pending ciphertext', async () => {
  const store = new BrowserKeyStore('alice', 'test-' + randomUUID()); await store.put('pending', 'c', { id: 'new' }); await store.clearPending('c', 'old'); expect(await store.get('pending', 'c')).toEqual({ id: 'new' }); await store.clearPending('c', 'new'); expect(await store.get('pending', 'c')).toBeUndefined(); store.close();
});
test('corrupt or missing enrolled identity fails closed and is never replaced or uploaded', async () => {
  const store = new BrowserKeyStore('alice', 'test-' + randomUUID()); await store.put('enrolled', '', true);
  const request = jest.fn().mockResolvedValue({ items: [] }), session = new SecureMessagingSession({ actor: { id: 'alice', username: 'alice' }, request, dispose() {} }, store);
  await expect(session.initialize()).rejects.toMatchObject({ code: 'storage_corrupt' }); expect(request).toHaveBeenCalledTimes(1); expect(await store.get('device')).toBeUndefined(); session.dispose();
});
test('unavailable IndexedDB has no memory/localStorage key fallback', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')!; Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  const store = new BrowserKeyStore('alice', 'test-' + randomUUID());
  try { await expect(store.get('device')).rejects.toMatchObject({ code: 'storage_unavailable' }); } finally { store.close(); Object.defineProperty(globalThis, 'indexedDB', previous); }
});

const cachedMessage: StoredMessage = { ...envelope, storageId: 'cached-storage', storedAt: envelope.timestamp, updatedAt: envelope.timestamp,
  sequence: 1, revision: 0, state: 'active', deletedAt: null };

test('cache freshness reads the exact shared account watermark without network requests or creating missing records', async () => {
  const name = 'cache-head-' + randomUUID(), store = new BrowserKeyStore('alice', name), otherTab = new BrowserKeyStore('alice', name);
  const request = jest.fn().mockRejectedValue(new Error('Cache freshness must not make network requests'));
  const session = new SecureMessagingSession({ actor: { id: 'alice', username: 'alice' }, request, dispose() {} }, store);
  const root = await messageEditHead(cachedMessage);
  try {
    expect(await session.isCachedMessageCurrent(cachedMessage)).toBe(false);
    expect(await store.get('message-revision', cachedMessage.storageId)).toBeUndefined();
    await otherTab.observeRevision(cachedMessage.storageId, [root]);
    expect(await session.isCachedMessageCurrent(cachedMessage)).toBe(true);
    const bobStore = new BrowserKeyStore('bob', name);
    const bob = new SecureMessagingSession({ actor: { id: 'bob', username: 'bob' }, request, dispose() {} }, bobStore);
    try { expect(await bob.isCachedMessageCurrent(cachedMessage)).toBe(false); } finally { bob.dispose(); }
    await otherTab.observeRevision(cachedMessage.storageId, [root, 'f'.repeat(64)]);
    expect(await session.isCachedMessageCurrent(cachedMessage)).toBe(false);
    expect(await store.get('message-revision', cachedMessage.storageId)).toEqual({ revision: 1, hash: 'f'.repeat(64), deleted: false });
    expect(request).not.toHaveBeenCalled();
  } finally { otherTab.close(); session.dispose(); }
});

test('cache freshness refuses terminal, corrupt and unavailable watermark storage without resetting observations', async () => {
  const name = 'cache-terminal-' + randomUUID(), store = new BrowserKeyStore('alice', name), otherTab = new BrowserKeyStore('alice', name);
  const session = new SecureMessagingSession({ actor: { id: 'alice', username: 'alice' }, request: jest.fn(), dispose() {} }, store);
  try {
    await otherTab.observeRevision(cachedMessage.storageId, [], true);
    expect(await session.isCachedMessageCurrent(cachedMessage)).toBe(false);
    expect(await store.get('message-revision', cachedMessage.storageId)).toEqual({ revision: 0, hash: '', deleted: true });
    const corrupt = { revision: '0', hash: await messageEditHead(cachedMessage), deleted: false };
    await otherTab.put('message-revision', cachedMessage.storageId, corrupt);
    expect(await session.isCachedMessageCurrent(cachedMessage)).toBe(false);
    expect(await store.get('message-revision', cachedMessage.storageId)).toEqual(corrupt);
    store.close();
    await expect(session.isCachedMessageCurrent(cachedMessage)).rejects.toMatchObject({ code: 'disposed' });
  } finally { otherTab.close(); session.dispose(); }
});
