import { createAttachmentUploader } from '../attachmentUpload';
import { db6UploadName } from '../db6Attachments';

const id = '550e8400-e29b-41d4-a716-446655440000';
const target = { type: 'direct' as const, recipientUserId: 'user-b' };
const attachment = { id, name: 'report.pdf', type: 'file', sizeBytes: 5,
  mimeType: 'application/pdf', url: `/api/attachments/${id}/download` };
const row = { attachment_id: id, original_name: 'report.pdf', mime_type: 'application/pdf', size_bytes: 5,
  group_id: null, recipient_user_id: 'user-b', encryption_algorithm: null, expires_at: null, deleted_at: null };
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const requestFetch = jest.fn();
let meta: HTMLMetaElement;

beforeAll(() => { Object.defineProperty(globalThis, 'fetch', { configurable: true, value: requestFetch }); });
beforeEach(() => {
  requestFetch.mockReset();
  meta = document.createElement('meta');
  meta.name = 'secubuzz-csrf-token'; meta.content = 'session-csrf'; document.head.appendChild(meta);
});
afterEach(() => meta.remove());
afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
});
const file = () => new File(['%PDF-'], 'report.pdf', { type: 'application/pdf' });
const respond = (value: unknown = row) => requestFetch.mockResolvedValue({ ok: true, json: async () => value });

test('uploads raw bytes to DB6 recipient scope and maps its flat response to a download reference', async () => {
  respond(); const selected = file();
  await expect(createAttachmentUploader(target)(selected, new AbortController().signal)).resolves.toEqual(attachment);
  expect(requestFetch).toHaveBeenCalledWith('/api/attachments?recipient_user_id=user-b', expect.objectContaining({
    body: selected, method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/pdf', 'X-CSRF-Token': 'session-csrf', 'X-File-Name': 'report.pdf', 'X-File-Name-Encoding': 'percent-utf8' },
  }));
});

test('uses group scope without a recipient or legacy conversation header', async () => {
  respond({ ...row, group_id: 'group-a', recipient_user_id: null });
  await expect(createAttachmentUploader({ type: 'group', groupId: 'group-a' })(file(), new AbortController().signal)).resolves.toEqual(attachment);
  expect(requestFetch.mock.calls[0]?.[0]).toBe('/api/attachments?group_id=group-a');
  expect(requestFetch.mock.calls[0]?.[1].headers).not.toHaveProperty('X-Conversation-Id');
});

test.each([['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['clip.mp4', 'video/mp4'],
  ['drawing.svg', 'image/svg+xml'], ['music.mp3', 'audio/mpeg']])('preserves %s using DB6 generic binary transport', async (name, mime) => {
  respond({ ...row, original_name: name, mime_type: 'application/octet-stream' });
  const selected = new File(['bytes'], name, { type: mime });
  await expect(createAttachmentUploader(target)(selected, new AbortController().signal)).resolves.toMatchObject({ name, mimeType: mime });
  expect(requestFetch.mock.calls[0]?.[1].headers['Content-Type']).toBe('application/octet-stream');
});

test.each(['quarterly report.pdf', 'budget 100%.pdf', 'báo cáo 📄.pdf', 'literal%20name.pdf', '中文 résumé.pdf'])('uses an explicit encoding marker and verifies decoded DB6 names (%s)', async (name) => {
  respond({ ...row, original_name: name });
  await expect(createAttachmentUploader(target)(new File(['%PDF-'], name, { type: 'application/pdf' }), new AbortController().signal))
    .resolves.toMatchObject({ name });
  expect(requestFetch.mock.calls[0]?.[1].headers['X-File-Name']).toBe(encodeURIComponent(name));
  expect(requestFetch.mock.calls[0]?.[1].headers['X-File-Name-Encoding']).toBe('percent-utf8');
  expect(db6UploadName(name)).toBe(encodeURIComponent(name));
});

test('applies the DB6 filename cap to the decoded name rather than UTF-8 header expansion', async () => {
  const name = '文'.repeat(176) + '.pdf'; respond({ ...row, original_name: name });
  await expect(createAttachmentUploader(target)(new File(['%PDF-'], name, { type: 'application/pdf' }), new AbortController().signal)).resolves.toMatchObject({ name });
});

test('rejects a host that has not mounted the filename transport adapter', async () => {
  const name = 'quarterly report.pdf'; respond({ ...row, original_name: encodeURIComponent(name) });
  await expect(createAttachmentUploader(target)(new File(['%PDF-'], name, { type: 'application/pdf' }), new AbortController().signal)).rejects.toThrow('could not be verified');
});

test('requires a CSRF bootstrap, explicit valid target and a filename DB6 will not truncate', async () => {
  meta.remove();
  await expect(createAttachmentUploader(target)(file(), new AbortController().signal)).rejects.toThrow('session could not be verified');
  meta.content = 'session-csrf'; document.head.appendChild(meta);
  await expect(createAttachmentUploader({ type: 'group', groupId: '' })(file(), new AbortController().signal)).rejects.toThrow('verified file upload target');
  await expect(createAttachmentUploader(target)(new File(['%PDF-'], 'x'.repeat(180) + '.pdf'), new AbortController().signal)).rejects.toThrow('Shorten this filename');
  expect(requestFetch).not.toHaveBeenCalled();
});

test('binds returned metadata to the file and requested scope, rejecting encrypted, deleted or expired rows', async () => {
  for (const change of [{ size_bytes: 100 }, { original_name: 'other.pdf' }, { recipient_user_id: 'other-user' },
    { group_id: 'other-group' }, { encryption_algorithm: 'AES-256-GCM' }, { deleted_at: '2020-01-01' }, { expires_at: '2020-01-01' }, { attachment_id: '../unsafe' }]) {
    respond({ ...row, ...change });
    await expect(createAttachmentUploader(target)(file(), new AbortController().signal)).rejects.toThrow('could not be verified');
  }
});

test('derives its own download URL and never retains backend storage paths or extra URLs', async () => {
  respond({ ...row, url: 'https://attacker.invalid/file', storage_key: 'private-storage-key' });
  await expect(createAttachmentUploader(target)(file(), new AbortController().signal)).resolves.toEqual(attachment);
});

test.each([401, 403, 404, 413, 415, 503])('keeps failures actionable and does not expose DB6 diagnostics (%s)', async (status) => {
  requestFetch.mockResolvedValue({ ok: false, status, json: async () => ({ error: 'private database detail' }) });
  await expect(createAttachmentUploader(target)(file(), new AbortController().signal)).rejects.not.toThrow('private database detail');
});

test('does not upload a cancelled operation', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(createAttachmentUploader(target)(file(), controller.signal)).rejects.toThrow('cancelled');
  expect(requestFetch).not.toHaveBeenCalled();
});
