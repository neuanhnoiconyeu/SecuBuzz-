/** @jest-environment node */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { HttpAuthService } from '@/auth/httpAuthService';
import { ApiError } from '@/api/sessionApi';
import { SecureMessagingSession } from '../session';
import { BrowserKeyStore } from '../storage';
import { encryptV2 } from '../messages';
let directory: string;
const password = 'Isolated client E2EE integration passphrase 2026!';
let child: ChildProcess, origin: string;
const sessions: SecureMessagingSession[] = [];
async function start(): Promise<void> {
  fs.mkdirSync(directory, { recursive: true });
  child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(process.cwd(), '../DATA'), windowsHide: true,
    env: { ...process.env, NODE_ENV: 'test', AUTH_ALLOW_HTTP_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: 'http://localhost:4177', DB_PATH: path.join(directory, 'isolated.sqlite'), HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  origin = await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Isolated DATA startup timeout')), 15000);
    child.stdout!.on('data', chunk => { output += String(chunk); const m = /listening on port (\d+)/.exec(output); if (m) { clearTimeout(timer); resolve('http://127.0.0.1:' + m[1]); } });
    child.once('error', reject); child.stderr!.on('data', () => {});
  });
}
async function stop(): Promise<void> { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB }); });
beforeEach(async () => { directory = path.resolve(process.cwd(), 'tmp/e2ee-node-' + randomUUID()); await start(); });
afterEach(async () => { sessions.forEach(s => s.dispose()); sessions.length = 0; await stop();
  if (!directory.startsWith(path.resolve(process.cwd(), 'tmp') + path.sep)) throw new Error('Invalid fixture path');
  for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory);
});
async function actor(name: string) {
  const cookies = new Map<string, string>(), bodies: unknown[] = []; let dropNextMessage = false, failKeys = false;
  const service = new HttpAuthService({ fetch: (async (input, options = {}) => {
    const route = String(input), headers = new Headers(options.headers); headers.set('Origin', 'http://localhost:4177'); if (cookies.size) headers.set('Cookie', [...cookies].map(([k, v]) => k + '=' + v).join('; '));
    if (options.body) bodies.push(JSON.parse(String(options.body)));
    if (failKeys && /\/keys(?:\?|$)/.test(route)) return new Response(JSON.stringify({ code: 'RECIPIENT_KEYS_UNAVAILABLE', fields: [] }), { status: 503 });
    const r = await fetch(origin + route, { ...options, headers });
    for (const c of r.headers.getSetCookie()) { const pair = c.split(';')[0]!, index = pair.indexOf('='); if (pair.slice(index + 1)) cookies.set(pair.slice(0, index), pair.slice(index + 1)); else cookies.delete(pair.slice(0, index)); }
    if (dropNextMessage && route.endsWith('/messages') && options.method === 'POST') { dropNextMessage = false; throw new Error('Synthetic lost acknowledgement'); } return r;
  }) as typeof fetch });
  const username = 'e2ee-' + name + '-' + randomUUID().slice(0, 8);
  await service.register({ username, email: username + '@example.test', password, displayName: name });
  const loggedIn = await service.login({ identifier: username, password }), api = service.createSessionApi(loggedIn.user);
  const storageName = 'keys-' + randomUUID(), secure = new SecureMessagingSession(api, new BrowserKeyStore(loggedIn.user.id, storageName)); sessions.push(secure);
  return { service, api, secure, storageName, user: loggedIn.user, bodies, drop: () => { dropNextMessage = true; }, unavailable: (on: boolean) => { failKeys = on; } };
}
async function pair() {
  const a = await actor('Alice'), b = await actor('Bob');
  const request = await a.api.request('/api/friends/requests', { method: 'POST', body: { userId: b.user.id }, status: 201 }) as { request: { id: string } };
  await b.api.request(`/api/friends/requests/${request.request.id}/accept`, { method: 'POST' });
  const c = await a.secure.api.createDirect(b.user.id); return { a, b, c };
}

test('socket transport seam shares real encryption and DATA persistence; a lost ack reconciles without REST resubmission', async () => {
  const { a, b, c } = await pair(); await a.secure.initialize(true); await b.secure.initialize(true);
  const posted: unknown[] = [];
  const submit = jest.fn(async (envelope: Parameters<typeof a.secure.api.submit>[0]) => {
    posted.push(structuredClone(envelope)); await a.secure.api.submit(envelope); throw new Error('Synthetic dropped socket ack');
  });
  await expect(a.secure.send(c.id, 'Alice', 'Socket seam private plaintext', submit)).rejects.toThrow('Synthetic dropped');
  const pending = await a.secure.pending(c.id); expect(pending).toEqual(posted[0]); expect(JSON.stringify(posted)).not.toContain('private plaintext');
  const recovered = await a.secure.retryPending(c.id); expect(recovered?.id).toBe(pending?.id); expect(await a.secure.pending(c.id)).toBeNull();
  expect(submit).toHaveBeenCalledTimes(1); expect((await a.secure.api.history(c.id)).items).toHaveLength(1); expect((await b.secure.history(c.id)).items[0]?.text).toBe('Socket seam private plaintext');
});

test('verified socket ack reads the committed row; rejected send preserves exact pending bytes for an explicit REST retry', async () => {
  const { a, b, c } = await pair(); await a.secure.initialize(true); await b.secure.initialize(true);
  const submit = jest.fn(async (envelope: Parameters<typeof a.secure.api.submit>[0]) => {
    const row = await a.secure.api.submit(envelope); return { conversationId: c.id, messageId: row.id, status: 'sent' as const, timestamp: row.storedAt };
  });
  const progress = jest.fn(); const sent = await a.secure.send(c.id, 'Alice', 'Acknowledged socket seam', submit, progress);
  expect(sent.sequence).toBe(1); expect(await a.secure.pending(c.id)).toBeNull(); expect(progress.mock.calls.map(c => c[0])).toContain('Awaiting persistence acknowledgment');
  const unavailable = jest.fn(async () => { throw new ApiError('unavailable'); });
  await expect(a.secure.send(c.id, 'Alice', 'Explicit fallback retains encrypted bytes', unavailable)).rejects.toMatchObject({ code: 'unavailable' });
  const pending = await a.secure.pending(c.id); const retried = await a.secure.retryPending(c.id);
  expect(retried?.id).toBe(pending?.id); expect(retried?.encryption).toEqual(pending?.encryption); expect((await a.secure.api.history(c.id)).items).toHaveLength(2);
});
test('two actual authenticated DATA accounts register, publish HPKE epoch, exchange v2, refresh keys and survive a backend restart', async () => {
  const { a, b, c } = await pair(); await a.secure.initialize(true); await expect(a.secure.prepare(c.id)).rejects.toMatchObject({ code: 'recipient_missing' }); await b.secure.initialize(true);
  await a.secure.send(c.id, 'Alice', 'Alice private integration text'); const received = await b.secure.history(c.id); expect(received.items[0]?.text).toBe('Alice private integration text');
  await b.secure.send(c.id, 'Bob', 'Bob private integration text'); expect((await a.secure.history(c.id)).items[0]?.text).toBe('Bob private integration text');
  const before = (await a.secure.initialize()).deviceId; a.secure.dispose(); const restored = new SecureMessagingSession(a.api, new BrowserKeyStore(a.user.id, a.storageName)); sessions.push(restored);
  expect((await restored.initialize()).deviceId).toBe(before); expect((await restored.history(c.id)).items).toHaveLength(2);
  await stop(); await start(); expect((await restored.history(c.id)).items[0]?.text).toBe('Bob private integration text');
  const messageBodies = [...a.bodies, ...b.bodies].filter((v: unknown) => Boolean(v && typeof v === 'object' && 'encryption' in v));
  expect(messageBodies).toHaveLength(2); expect(JSON.stringify(messageBodies)).not.toContain('private integration text');
  const charlie = await actor('Charlie'); await charlie.secure.initialize(true); await expect(charlie.secure.api.getConversation(c.id)).rejects.toMatchObject({ code: 'not_found' });
  const encrypted = received.items[0]!.message; const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const { decryptV2 } = await import('../messages'); await expect(decryptV2(wrongKey, { id: encrypted.id, conversationId: c.id, senderId: encrypted.senderId, senderName: encrypted.senderName, timestamp: encrypted.timestamp, type: 'text', encryption: encrypted.encryption })).rejects.toMatchObject({ code: 'decryption_failed' });
}, 30000);
test('TOFU changes require review; new devices lack old keys; revocation, unavailable directory and stale epochs fail closed', async () => {
  const { a, b, c } = await pair(); await a.secure.initialize(true); await b.secure.initialize(true); await a.secure.send(c.id, 'Alice', 'Previously authorized history');
  const old = await a.secure.prepare(c.id), b2 = new SecureMessagingSession(b.api, new BrowserKeyStore(b.user.id, 'new-browser-' + randomUUID())); sessions.push(b2);
  await expect(b2.initialize()).rejects.toMatchObject({ code: 'enrollment_required' }); await b2.initialize(true);
  await expect(a.secure.prepare(c.id)).rejects.toMatchObject({ code: 'keys_changed' }); expect(a.secure.getKeyReview()?.newIds).toHaveLength(2);
  await a.secure.store.remove('epoch', JSON.stringify([c.id, old.keyId]));
  expect((await a.secure.history(c.id)).items[0]?.text).toBe('Previously authorized history'); await a.secure.acceptKeyChange(c.id); const current = await a.secure.prepare(c.id); expect(current.keyId).not.toBe(old.keyId);
  expect((await b2.history(c.id)).items[0]?.text).toBeNull(); await a.secure.send(c.id, 'Alice', 'Current devices only'); expect((await b2.history(c.id)).items[0]?.text).toBe('Current devices only');
  const stale = await encryptV2(old.key, a.secure.store, { id: randomUUID(), conversationId: c.id, senderId: a.user.id, senderName: 'Alice', timestamp: new Date().toISOString(), type: 'text' }, old.keyId, 'never persisted');
  await expect(a.secure.api.submit(stale)).rejects.toMatchObject({ code: 'recipient_keys_unverified' });
  await expect(b.secure.revokeCurrentDevice()).rejects.toMatchObject({ code: 'device_revoked' }); await expect(b.secure.prepare(c.id)).rejects.toMatchObject({ code: 'device_revoked' });
  await expect(a.secure.prepare(c.id)).rejects.toMatchObject({ code: 'keys_changed' });
  a.unavailable(true); await expect(a.secure.send(c.id, 'Alice', 'must not use cached keys')).rejects.toMatchObject({ code: 'key_service_unavailable' }); a.unavailable(false);
}, 30000);
test('an account with only revoked devices explicitly enrolls in a fresh profile without restoring or replacing old keys', async () => {
  const { a, b, c } = await pair();
  await expect(a.secure.initialize()).rejects.toMatchObject({ code: 'enrollment_required' });
  expect(await a.secure.api.ownDevices()).toHaveLength(0);
  const old = await a.secure.initialize(true); await b.secure.initialize(true);
  await a.secure.send(c.id, 'Alice', 'History for the original device only'); await b.secure.prepare(c.id);
  await expect(a.secure.revokeCurrentDevice()).rejects.toMatchObject({ code: 'device_revoked' });
  await expect(a.secure.send(c.id, 'Alice', 'Must not be sent')).rejects.toMatchObject({ code: 'device_revoked' });
  await expect(a.secure.initialize(true)).rejects.toMatchObject({ code: 'device_revoked' });
  const fresh = new SecureMessagingSession(a.api, new BrowserKeyStore(a.user.id, 'fresh-profile-' + randomUUID())); sessions.push(fresh);
  await expect(fresh.initialize()).rejects.toMatchObject({ code: 'enrollment_required' });
  expect((await fresh.api.ownDevices()).map(d => d.status)).toEqual(['revoked']);
  const enrolled = await fresh.initialize(true);
  expect(enrolled.deviceId).not.toBe(old.deviceId); expect(enrolled.deviceKeyId).not.toBe(old.deviceKeyId);
  expect(enrolled.agreement.privateKey.extractable).toBe(false); expect(enrolled.signing.privateKey.extractable).toBe(false);
  const directory = await fresh.api.ownDevices(); expect(directory).toHaveLength(2);
  expect(directory.find(d => d.deviceKeyId === old.deviceKeyId)?.status).toBe('revoked');
  expect(directory.find(d => d.deviceKeyId === enrolled.deviceKeyId)?.status).toBe('active');
  expect((await a.secure.store.get<typeof old>('device'))?.deviceKeyId).toBe(old.deviceKeyId);
  expect((await a.secure.history(c.id)).items[0]?.text).toBe('History for the original device only');
  const historical = (await fresh.history(c.id)).items[0]; expect(historical?.text).toBeNull(); expect(historical?.error).toBeTruthy();
  await expect(b.secure.prepare(c.id)).rejects.toMatchObject({ code: 'keys_changed' });
  await b.secure.acceptKeyChange(c.id);
  await fresh.send(c.id, 'Alice', 'Message from the explicitly enrolled device');
  expect((await b.secure.history(c.id)).items[0]?.text).toBe('Message from the explicitly enrolled device');
});

test('lost acknowledgements retain original ciphertext and reconcile one durable message; logout/disposal denies stale operations', async () => {
  const { a, b, c } = await pair(); await a.secure.initialize(true); await b.secure.initialize(true); a.drop();
  await expect(a.secure.send(c.id, 'Alice', 'ambiguous outcome')).rejects.toMatchObject({ code: 'unavailable' }); const pending = await a.secure.pending(c.id); expect(pending).not.toBeNull();
  await expect(a.secure.send(c.id, 'Alice', 'do not duplicate')).rejects.toMatchObject({ code: 'pending_message' }); const reconciled = await a.secure.retryPending(c.id);
  expect(reconciled?.id).toBe(pending?.id); expect(await a.secure.pending(c.id)).toBeNull(); expect((await b.secure.history(c.id)).items).toHaveLength(1);
  await a.service.logout(); await expect(a.secure.prepare(c.id)).rejects.toMatchObject({ code: 'cancelled' }); a.secure.dispose(); await expect(a.secure.history(c.id)).rejects.toMatchObject({ code: 'disposed' });
}, 30000);

test('later enrollment in a shared browser namespace cannot recover old wraps, but new bidirectional messages and account restoration work', async () => {
  const { a, b, c } = await pair();
  const originalA = await a.secure.initialize(true), originalB = await b.secure.initialize(true);
  const historical = await a.secure.send(c.id, 'Alice', 'Original recipient device only');
  const switched = new SecureMessagingSession(b.api, new BrowserKeyStore(b.user.id, a.storageName)); sessions.push(switched);
  await expect(switched.initialize()).rejects.toMatchObject({ code: 'enrollment_required' });
  expect(await switched.store.get('device')).toBeUndefined();
  expect(await switched.api.ownDevices()).toHaveLength(1);
  const laterB = await switched.initialize(true);
  expect(laterB.deviceKeyId).not.toBe(originalA.deviceKeyId);
  expect(laterB.deviceKeyId).not.toBe(originalB.deviceKeyId);
  expect(laterB.userId).toBe(b.user.id);
  expect(laterB.agreement.privateKey.extractable).toBe(false);
  expect(laterB.signing.privateKey.extractable).toBe(false);
  const old = (await switched.history(c.id)).items.find(row => row.message.id === historical.id);
  expect(old).toMatchObject({ text: null, error: expect.any(String), errorCode: 'missing_key' });
  await expect(a.secure.send(c.id, 'Alice', 'Unreviewed device must block')).rejects.toMatchObject({ code: 'keys_changed' });
  await a.secure.acceptKeyChange(c.id);
  const sent = [];
  for (let i = 0; i < 3; i++) sent.push(await a.secure.send(c.id, 'Alice', 'Current recipient message ' + i));
  const received = await switched.history(c.id);
  expect(received.items.slice(0, 3).map(row => row.text)).toEqual(['Current recipient message 2', 'Current recipient message 1', 'Current recipient message 0']);
  expect(received.items.slice(0, 3).every(row => row.error === null)).toBe(true);
  expect(new Set(sent.map(row => row.id)).size).toBe(3);
  expect(sent.map(row => row.sequence)).toEqual([2, 3, 4]);
  const reply = await switched.send(c.id, 'Bob', 'Reply from the later enrolled browser');
  expect((await a.secure.history(c.id)).items[0]?.text).toBe('Reply from the later enrolled browser');
  expect(reply.sequence).toBe(5);
  const unchanged = (await switched.api.history(c.id)).items.find(row => row.id === historical.id);
  expect(unchanged?.encryption).toEqual(historical.encryption);
  expect((await b.secure.history(c.id)).items.find(row => row.message.id === historical.id)?.text).toBe('Original recipient device only');
  expect((await b.secure.api.ownDevices()).every(d => d.status === 'active')).toBe(true);
  switched.dispose(); a.secure.dispose(); await a.service.logout();
  const signedBackIn = await a.service.login({ identifier: a.user.username, password });
  const restoredApi = a.service.createSessionApi(signedBackIn.user);
  const restoredA = new SecureMessagingSession(restoredApi, new BrowserKeyStore(a.user.id, a.storageName)); sessions.push(restoredA);
  expect((await restoredA.initialize()).deviceKeyId).toBe(originalA.deviceKeyId);
  expect((await restoredA.api.ownDevices()).map(d => d.deviceKeyId)).toEqual([originalA.deviceKeyId]);
  expect((await restoredA.history(c.id)).items[0]?.text).toBe('Reply from the later enrolled browser');
  const restoredB = new BrowserKeyStore(b.user.id, a.storageName);
  expect((await restoredB.get<typeof laterB>('device'))?.deviceKeyId).toBe(laterB.deviceKeyId); restoredB.close();
}, 30000);
