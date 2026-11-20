import { act, renderHook } from '@testing-library/react';
import { useAttachmentDrafts } from '../useAttachmentDrafts';
import type { MessageAttachment } from '@/messaging/messageModel';
import * as files from '@/messaging/attachmentFiles';
import { makeAttachmentFile } from '../../../test/attachmentFixtures';

jest.mock('@/messaging/attachmentFiles', () => {
  const actual = jest.requireActual('@/messaging/attachmentFiles');
  return { ...actual, prepareAttachmentFile: jest.fn(actual.prepareAttachmentFile) };
});
const prepare = jest.mocked(files.prepareAttachmentFile);

const originals = [Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')];
const create = jest.fn(), revoke = jest.fn(); let sequence = 0;
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
});
beforeEach(() => {
  create.mockReset().mockImplementation(() => `blob:attachment-draft-${++sequence}`); revoke.mockClear();
  prepare.mockReset().mockImplementation(jest.requireActual<typeof files>('@/messaging/attachmentFiles').prepareAttachmentFile);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  ['createObjectURL', 'revokeObjectURL'].forEach((key, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(URL, key, descriptor); else Reflect.deleteProperty(URL, key); });
});

test('a failure creating the sanitized SVG preview releases the already-created original URL', async () => {
  const file = new File(['<svg/>'], 'drawing.svg', { type: 'image/svg+xml' });
  prepare.mockResolvedValue({ file, svgPreview: new Blob(['<svg/>'], { type: 'image/svg+xml' }) });
  create.mockReturnValueOnce('blob:svg-original').mockImplementationOnce(() => { throw new Error('Preview unavailable'); });
  const h = renderHook(() => useAttachmentDrafts({ disabled: false }));
  await act(async () => h.result.current.addFiles([file]));
  expect(h.result.current.drafts).toEqual([]); expect(h.result.current.error).toBe('Preview unavailable'); expect(revoke).toHaveBeenCalledWith('blob:svg-original');
});

test('late validation after unmount does not create object URLs or publish a draft', async () => {
  const file = makeAttachmentFile('report.pdf', 'application/pdf'); let finish!: (value: { file: File }) => void;
  prepare.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const h = renderHook(() => useAttachmentDrafts({ disabled: false })); let preparing!: Promise<void>;
  act(() => { preparing = h.result.current.addFiles([file]); }); h.unmount();
  await act(async () => { finish({ file }); await preparing; }); expect(create).not.toHaveBeenCalled();
});

test('partial upload failure retries only the unsaved file and preserves selections', async () => {
  const upload = jest.fn(async (file: File): Promise<MessageAttachment> => ({ id: file.name, name: file.name, type: 'file', sizeBytes: file.size, url: `blob:saved-${file.name}` }));
  upload.mockImplementationOnce(async file => ({ id: file.name, name: file.name, type: 'file', sizeBytes: file.size, url: 'blob:saved-first' }))
    .mockRejectedValueOnce(new Error('Second upload failed'));
  const h = renderHook(() => useAttachmentDrafts({ disabled: false, uploadAttachment: upload }));
  await act(async () => h.result.current.addFiles([makeAttachmentFile('one.pdf', 'application/pdf'), makeAttachmentFile('two.pdf', 'application/pdf')]));
  await act(async () => { await expect(h.result.current.prepareForSend()).rejects.toThrow('Second upload failed'); });
  expect(h.result.current.drafts).toHaveLength(2);
  await act(async () => { expect(await h.result.current.prepareForSend()).toHaveLength(2); });
  expect(upload.mock.calls.map(call => call[0].name)).toEqual(['one.pdf', 'two.pdf', 'two.pdf']);
});

test('unmount aborts an upload and discards a late unaccepted file instead of sending it', async () => {
  let finish!: (file: MessageAttachment) => void, signal!: AbortSignal;
  const discard = jest.fn(async () => {}), upload = jest.fn((_file: File, abort: AbortSignal) => { signal = abort; return new Promise<MessageAttachment>(resolve => { finish = resolve; }); });
  const h = renderHook(() => useAttachmentDrafts({ disabled: false, uploadAttachment: upload, discardAttachment: discard }));
  await act(async () => h.result.current.addFiles([makeAttachmentFile('report.pdf', 'application/pdf')]));
  let sending!: Promise<MessageAttachment[]>; act(() => { sending = h.result.current.prepareForSend(); });
  const outcome = expect(sending).rejects.toThrow('cancelled'); h.unmount(); expect(signal.aborted).toBe(true);
  const saved: MessageAttachment = { id: 'saved', name: 'report.pdf', type: 'file', sizeBytes: 20, url: '', storage: 'indexeddb' };
  await act(async () => { finish(saved); await outcome; }); expect(discard).toHaveBeenCalledWith(saved); expect(revoke).toHaveBeenCalledTimes(1);
});

test('a removed staged file releases its previews while an accepted file is not discarded on unmount', async () => {
  const discard = jest.fn(async () => {}), upload = jest.fn(async (): Promise<MessageAttachment> => ({ id: 'saved', name: 'report.pdf', type: 'file', sizeBytes: 20, url: '', storage: 'indexeddb' }));
  const h = renderHook(() => useAttachmentDrafts({ disabled: false, uploadAttachment: upload, discardAttachment: discard }));
  await act(async () => h.result.current.addFiles([makeAttachmentFile('remove.pdf', 'application/pdf')]));
  const url = h.result.current.drafts[0]!.attachment.url; act(() => h.result.current.remove(h.result.current.drafts[0]!.attachment.id)); expect(revoke).toHaveBeenCalledWith(url);
  await act(async () => h.result.current.addFiles([makeAttachmentFile('report.pdf', 'application/pdf')]));
  await act(async () => { await h.result.current.prepareForSend(); }); act(() => h.result.current.clearAccepted()); h.unmount(); expect(discard).not.toHaveBeenCalled();
});
