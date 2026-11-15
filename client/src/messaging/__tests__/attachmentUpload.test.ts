import { createAttachmentUploader } from '../attachmentUpload';

const attachment = {
  id: '550e8400-e29b-41d4-a716-446655440000', name: 'report.pdf', type: 'file', sizeBytes: 5,
  mimeType: 'application/pdf', url: '/api/attachments/550e8400-e29b-41d4-a716-446655440000',
};
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const requestFetch = jest.fn();
let meta: HTMLMetaElement;

beforeAll(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: requestFetch });
});
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

test('uploads actual file bytes with the cookie session and CSRF token to the same-origin API', async () => {
  requestFetch.mockResolvedValue({ ok: true, json: async () => ({ attachment }) });
  const selected = file();
  await expect(createAttachmentUploader('room-a')(selected, new AbortController().signal)).resolves.toEqual(attachment);
  expect(requestFetch).toHaveBeenCalledWith('/api/attachments', expect.objectContaining({
    body: selected, method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
    headers: expect.objectContaining({ 'X-CSRF-Token': 'session-csrf', 'X-Conversation-Id': 'room-a' }),
  }));
});

test('does not attempt an upload without a CSRF token', async () => {
  meta.remove();
  await expect(createAttachmentUploader('room-a')(file(), new AbortController().signal)).rejects.toThrow('session could not be verified');
  expect(requestFetch).not.toHaveBeenCalled();
});

test('rejects an upload response containing an external download URL', async () => {
  requestFetch.mockResolvedValue({ ok: true, json: async () => ({ attachment: { ...attachment, url: 'https://attacker.invalid/file' } }) });
  await expect(createAttachmentUploader('room-a')(file(), new AbortController().signal)).rejects.toThrow('could not be verified');
});

test('reports upload access errors without exposing server error details', async () => {
  requestFetch.mockResolvedValue({ ok: false, status: 403 });
  await expect(createAttachmentUploader('room-a')(file(), new AbortController().signal)).rejects.toThrow('no longer have access');
});
