import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import type { AttachmentMetadata } from '../../../shared/attachmentPolicy.ts';
import { createDb6AttachmentTransport } from '../../src/attachments/db6Transport.ts';

type Target = { type: 'direct'; recipientUserId: string } | { type: 'group'; groupId: string };
interface Client { createAttachmentUploader(target: Target): (file: File, signal: AbortSignal) => Promise<AttachmentMetadata> }
interface Reader { readRemoteAttachment(file: AttachmentMetadata, signal: AbortSignal): Promise<Blob> }
type Authenticate = (request: IncomingMessage & { user?: { user_id: string } }, response: ServerResponse, next: () => void) => void;

const require = createRequire(import.meta.url);
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const nativeFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const ids = { owner: randomUUID(), recipient: randomUUID(), outsider: randomUUID() };
const groupId = randomUUID();
const pdf = Buffer.from('%PDF-1.4\nDB6 integration');
const sessions = new Map([['owner-session', ids.owner], ['recipient-session', ids.recipient], ['outsider-session', ids.outsider]]);
const previousEnvironment = Object.fromEntries(['DB_FILE', 'BASE_SCHEMA_FILE', 'ATTACHMENT_STORAGE_DIR', 'MAX_ATTACHMENT_BYTES'].map(key => [key, process.env[key]]));
let directory: string, storage: string, base: string;
let activeSession = 'owner-session';
let client: Client, reader: Reader;
// Load the actual DB6 CommonJS modules only after configuring isolated temporary storage.
let db: ReturnType<typeof require>;
let server: ReturnType<typeof createServer>;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'secubuzz-db6-attachments-')); storage = join(directory, 'private-files');
  process.env.DB_FILE = join(directory, 'test.sqlite');
  process.env.BASE_SCHEMA_FILE = join(serverRoot, 'database', 'schema.sql');
  process.env.ATTACHMENT_STORAGE_DIR = storage; process.env.MAX_ATTACHMENT_BYTES = '1048576';
  db = require('../../src/db5db6/db.cjs');
  const { createApiApp } = require('../../src/api-app.cjs') as { createApiApp(authenticate: Authenticate): RequestListener };
  const authenticate: Authenticate = (request, response, next) => {
    const token = /^secubuzz_session=([a-z-]+)$/.exec(request.headers.cookie ?? '')?.[1];
    const userId = token ? sessions.get(token) : undefined;
    if (!userId) { response.writeHead(401); response.end(); return; }
    request.user = { user_id: userId }; next();
  };
  for (const [username, id] of Object.entries(ids)) db.prepare('INSERT INTO Users(user_id,username,display_name) VALUES(?,?,?)').run(id, username, username);
  db.prepare('INSERT INTO Groups(group_id,name,created_by,history_visibility) VALUES(?,?,?,?)').run(groupId, 'Attachment integration', ids.owner, 'from_joined');
  for (const [userId, role] of [[ids.owner, 'owner'], [ids.recipient, 'member']]) {
    db.prepare('INSERT INTO GroupMembers(group_id,user_id,role,status,joined_at) VALUES(?,?,?,?,?)').run(groupId, userId, role, 'active', '2000-01-01T00:00:00.000Z');
  }
  server = createServer(createDb6AttachmentTransport(createApiApp(authenticate)));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = await tsImport('../../../client/src/messaging/attachmentUpload.ts', import.meta.url) as Client;
  reader = await tsImport('../../../client/src/messaging/attachmentDownload.ts', import.meta.url) as Reader;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => ({ content: 'integration-csrf' }) } });
  // Test-only browser URL/cookie transport; authorization and storage still run in the real DB6 API.
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers); headers.set('cookie', `secubuzz_session=${activeSession}`);
    return nativeFetch(new URL(String(input), base), { ...init, headers });
  };
});

after(async () => {
  globalThis.fetch = nativeFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  db?.close();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function upload(name = 'report.pdf', type = 'application/pdf', bytes: Uint8Array = pdf, target: Target = { type: 'direct', recipientUserId: ids.recipient }) {
  activeSession = 'owner-session';
  return client.createAttachmentUploader(target)(new File([Uint8Array.from(bytes)], name, { type }), new AbortController().signal);
}
const request = (path: string, session: string, init: Parameters<typeof nativeFetch>[1] = {}) => nativeFetch(base + path, {
  ...init, headers: { ...init.headers, cookie: `secubuzz_session=${session}` },
});

test('actual frontend uploader maps flat DB6 rows, persists bytes once and reads canonical downloads', async () => {
  const file = await upload();
  assert.equal(file.url, `/api/attachments/${file.id}/download`);
  const row = db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(file.id);
  assert.equal(row.recipient_user_id, ids.recipient); assert.equal(row.group_id, null); assert.equal(row.uploader_user_id, ids.owner);
  assert.match(row.sha256, /^[a-f0-9]{64}$/); assert.deepEqual(await readFile(join(storage, row.storage_key)), pdf);
  assert.ok((await readdir(storage)).every(name => !name.endsWith('.json')));
  const metadata = await request(`/api/attachments/${file.id}`, 'recipient-session');
  const body = await metadata.json() as Record<string, unknown>;
  assert.equal(body.attachment_id, file.id); assert.equal('storage_key' in body, false);
  activeSession = 'recipient-session';
  const blob = await reader.readRemoteAttachment(file, new AbortController().signal);
  assert.equal(blob.type, 'application/pdf'); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), pdf);
});

test('preserves images, video, Word, PDF, SVG, audio, spreadsheets and archives using DB6 binary transport', async () => {
  const fixtures: Array<[string, string, Buffer]> = [
    ['photo.png', 'image/png', Buffer.from('89504e470d0a1a0a00000000', 'hex')],
    ['clip.mp4', 'video/mp4', Buffer.from('0000ftypisom0000video')],
    ['report.pdf', 'application/pdf', pdf],
    ['notes.doc', 'application/msword', Buffer.from('d0cf11e0a1b11ae100000000', 'hex')],
    ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('504b030400000000', 'hex')],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from('504b030400000000', 'hex')],
    ['image.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')],
    ['sound.mp3', 'audio/mpeg', Buffer.from('ID3sound')],
    ['archive.7z', 'application/x-7z-compressed', Buffer.from('377abcaf271c', 'hex')],
  ];
  for (const [name, mime, bytes] of fixtures) {
    const file = await upload(name, mime, bytes); activeSession = 'recipient-session';
    const received = await reader.readRemoteAttachment(file, new AbortController().signal);
    assert.equal(received.type, mime, name); assert.deepEqual(Buffer.from(await received.arrayBuffer()), bytes, name);
  }
});

for (const name of ['quarterly report.pdf', 'budget 100%.pdf', 'báo cáo 📄.pdf', 'literal%20name.pdf', '中文 résumé.pdf']) {
  test(`DB6 stores, searches and downloads the exact filename: ${name}`, async () => {
    const file = await upload(name);
    assert.equal(file.name, name);
    assert.equal(db.prepare('SELECT original_name FROM Attachments WHERE attachment_id=?').get(file.id).original_name, name);
    const search = await request(`/api/files/search?q=${encodeURIComponent(name)}`, 'recipient-session');
    assert.equal(search.status, 200);
    const matches = await search.json() as Array<{ attachment_id: string; original_name: string }>;
    assert.ok(matches.some(row => row.attachment_id === file.id && row.original_name === name));
    const download = await request(file.url, 'recipient-session');
    assert.equal(download.status, 200);
    const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    assert.ok(download.headers.get('content-disposition')?.includes(`filename*=UTF-8''${encoded}`));
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
    if (name === 'literal%20name.pdf') {
      const literal = await request(`/api/files/search?q=${encodeURIComponent('literal name.pdf')}`, 'recipient-session');
      assert.ok(!(await literal.json() as Array<{ attachment_id: string }>).some(row => row.attachment_id === file.id));
    }
  });
}

test('preserves unmarked legacy percent-containing filenames and the /api/files alias', async () => {
  const name = 'legacy%20 literal%.pdf';
  const uploaded = await request(`/api/files?recipient_user_id=${ids.recipient}`, 'owner-session', { method: 'POST', body: pdf,
    headers: { 'content-type': 'application/pdf', 'x-file-name': name } });
  assert.equal(uploaded.status, 201);
  const row = await uploaded.json() as { attachment_id: string; original_name: string };
  assert.equal(row.original_name, name);
  const downloaded = await request(`/api/files/${row.attachment_id}/download`, 'recipient-session');
  assert.equal(downloaded.status, 200); await downloaded.arrayBuffer();
});

test('rejects malformed encoded filename headers without writing DB6 rows or file bytes', async () => {
  const beforeRows = db.prepare('SELECT COUNT(*) AS total FROM Attachments').get().total;
  const beforeFiles = (await readdir(storage)).sort();
  for (const headers of [
    { 'x-file-name': '%ZZ.pdf', 'x-file-name-encoding': 'percent-utf8' },
    { 'x-file-name': 'bad%0D%0Aname.pdf', 'x-file-name-encoding': 'percent-utf8' },
    { 'x-file-name': 'name.pdf', 'x-file-name-encoding': 'base64' },
    { 'x-file-name': encodeURIComponent('文'.repeat(181)), 'x-file-name-encoding': 'percent-utf8' },
  ]) {
    const result = await request(`/api/attachments?recipient_user_id=${ids.recipient}`, 'owner-session', { method: 'POST', body: pdf,
      headers: { 'content-type': 'application/pdf', ...headers } });
    assert.equal(result.status, 400); assert.deepEqual(await result.json(), { error: 'invalid_filename' });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM Attachments').get().total, beforeRows);
  assert.deepEqual((await readdir(storage)).sort(), beforeFiles);
});

test('DB6 denies outsiders, invalid sessions and unauthorized groups without trusting identity headers', async () => {
  const file = await upload();
  assert.equal((await request(file.url, 'outsider-session')).status, 404);
  assert.equal((await request(file.url, 'unknown-session', { headers: { 'x-test-user': ids.owner } })).status, 401);
  activeSession = 'outsider-session';
  await assert.rejects(client.createAttachmentUploader({ type: 'group', groupId })(new File([pdf], 'report.pdf', { type: 'application/pdf' }), new AbortController().signal), /no longer have access/);
});

test('group downloads preserve DB6 history visibility and active membership', async () => {
  const file = await upload('group.pdf', 'application/pdf', pdf, { type: 'group', groupId });
  assert.equal((await request(file.url, 'recipient-session')).status, 200);
  db.prepare('UPDATE GroupMembers SET joined_at=? WHERE group_id=? AND user_id=?').run('2999-01-01T00:00:00.000Z', groupId, ids.recipient);
  assert.equal((await request(file.url, 'recipient-session')).status, 404);
  db.prepare('UPDATE Groups SET history_visibility=? WHERE group_id=?').run('all', groupId);
  assert.equal((await request(file.url, 'recipient-session')).status, 200);
  db.prepare('UPDATE GroupMembers SET status=? WHERE group_id=? AND user_id=?').run('removed', groupId, ids.recipient);
  assert.equal((await request(file.url, 'recipient-session')).status, 404);
  assert.equal((await request(file.url, 'owner-session')).status, 200);
});

test('DB6 size limits remain authoritative and failed transfers create no rows or private files', async () => {
  const beforeRows = db.prepare('SELECT COUNT(*) AS total FROM Attachments').get().total;
  const beforeFiles = (await readdir(storage)).sort();
  await assert.rejects(upload('large.mp4', 'video/mp4', Buffer.alloc(1048577)), /server's upload size limit/);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM Attachments').get().total, beforeRows);
  assert.deepEqual((await readdir(storage)).sort(), beforeFiles);
});

test('DB6 expiry, soft deletion and its existing cleanup job apply to integrated files', async () => {
  const expired = await upload('expired.pdf'), deleted = await upload('deleted.pdf');
  const files = [expired, deleted].map(file => ({ id: file.id, key: db.prepare('SELECT storage_key FROM Attachments WHERE attachment_id=?').get(file.id).storage_key as string }));
  db.prepare('UPDATE Attachments SET expires_at=? WHERE attachment_id=?').run('2000-01-01T00:00:00.000Z', expired.id);
  assert.equal((await request(expired.url, 'recipient-session')).status, 404); activeSession = 'recipient-session';
  await assert.rejects(reader.readRemoteAttachment(expired, new AbortController().signal), /expired, was removed/);
  assert.equal((await request(`/api/attachments/${deleted.id}`, 'owner-session', { method: 'DELETE' })).status, 204);
  assert.equal((await request(deleted.url, 'recipient-session')).status, 404);
  const cleaned = spawnSync(process.execPath, ['src/db5db6/cleanup.cjs'], { cwd: serverRoot, env: { ...process.env, ATTACHMENT_PURGE_AFTER_DAYS: '0' }, encoding: 'utf8' });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  for (const file of files) {
    assert.equal(db.prepare('SELECT 1 FROM Attachments WHERE attachment_id=?').get(file.id), undefined);
    await assert.rejects(readFile(join(storage, file.key)), { code: 'ENOENT' });
  }
});
