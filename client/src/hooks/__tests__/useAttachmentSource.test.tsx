import { renderHook, waitFor } from '@testing-library/react';
import { useAttachmentSource } from '../useAttachmentSource';
import { readRemoteAttachment } from '@/messaging/attachmentDownload';
import type { MessageAttachment } from '@/messaging/messageModel';

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const requestFetch = jest.fn();
const create = jest.fn((_blob: Blob) => 'blob:db6-preview');
const revoke = jest.fn();
const id = '550e8400-e29b-41d4-a716-446655440000';
const url = `/api/attachments/${id}/download`;
const file = (name: string, type: MessageAttachment['type'], mimeType: string, bytes: string | Uint8Array): [MessageAttachment, Blob] => {
  const blob = new Blob([typeof bytes === 'string' ? bytes : Uint8Array.from(bytes)], { type: 'application/octet-stream' });
  return [{ id, name, type, mimeType, sizeBytes: blob.size, url }, blob];
};

beforeAll(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: requestFetch });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
});
beforeEach(() => { requestFetch.mockReset(); create.mockClear(); revoke.mockClear(); });
afterAll(() => {
  for (const [object, key, descriptor] of [[globalThis, 'fetch', originalFetch], [URL, 'createObjectURL', originalCreate], [URL, 'revokeObjectURL', originalRevoke]] as const) {
    if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key);
  }
});

test.each([
  file('photo.png', 'image', 'image/png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
  file('clip.mp4', 'video', 'video/mp4', '0000ftypisomvideo'),
  file('report.pdf', 'file', 'application/pdf', '%PDF-1.4'),
])('previews DB6 download bytes with a local typed Blob (%s)', async (attachment, blob) => {
  requestFetch.mockResolvedValue({ ok: true, blob: async () => blob });
  const { result, unmount } = renderHook(() => useAttachmentSource(attachment, { previewPdf: true }));
  await waitFor(() => expect(result.current.previewUrl).toBe('blob:db6-preview'));
  expect(result.current.downloadUrl).toBe(url);
  expect(requestFetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' }));
  expect((create.mock.calls[0] as unknown as [Blob])[0].type).toBe(attachment.mimeType);
  unmount(); expect(revoke).toHaveBeenCalledWith('blob:db6-preview');
});

test('keeps Word downloads lazy and validates binary bytes when downloading', async () => {
  const [attachment, blob] = file('notes.docx', 'file', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Uint8Array([80, 75, 3, 4]));
  const { result } = renderHook(() => useAttachmentSource(attachment));
  expect(result.current.downloadUrl).toBe(url); expect(requestFetch).not.toHaveBeenCalled();
  requestFetch.mockResolvedValue({ ok: true, blob: async () => blob });
  expect((await readRemoteAttachment(attachment, new AbortController().signal)).type).toBe(attachment.mimeType);
});

test('sanitizes DB6 SVG previews while retaining the authenticated original download URL', async () => {
  const [attachment, blob] = file('drawing.svg', 'image', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1"/></svg>');
  requestFetch.mockResolvedValue({ ok: true, blob: async () => blob });
  const { result } = renderHook(() => useAttachmentSource(attachment));
  await waitFor(() => expect(result.current.previewUrl).toBe('blob:db6-preview'));
  expect(result.current.downloadUrl).toBe(url);
  const preview = (create.mock.calls[0] as unknown as [Blob])[0];
  const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(preview); });
  expect(text).not.toContain('<script'); expect(text).toContain('<rect');
});

test.each([404, 410, 401])('does not persist or preview files denied by DB6 (%s)', async (status) => {
  const [attachment] = file('report.pdf', 'file', 'application/pdf', '%PDF-1.4');
  requestFetch.mockResolvedValue({ ok: false, status });
  const { result } = renderHook(() => useAttachmentSource(attachment, { previewPdf: true }));
  await waitFor(() => expect(result.current.error).not.toBe(''));
  expect(result.current.previewUrl).toBe(''); expect(create).not.toHaveBeenCalled();
});

test('rejects changed bytes and keeps local demo/blob references away from the remote reader', async () => {
  const [attachment] = file('report.pdf', 'file', 'application/pdf', '%PDF-1.4');
  requestFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['bad']) });
  await expect(readRemoteAttachment(attachment, new AbortController().signal)).rejects.toThrow('does not match');
  requestFetch.mockClear();
  await expect(readRemoteAttachment({ ...attachment, storage: 'indexeddb' }, new AbortController().signal)).rejects.toThrow('unavailable');
  await expect(readRemoteAttachment({ ...attachment, url: 'blob:demo' }, new AbortController().signal)).rejects.toThrow('unavailable');
  expect(requestFetch).not.toHaveBeenCalled();
});
