import { decodeAttachmentContent, encodeAttachmentContent } from '../attachmentContent';
import { parseUploadedAttachment, validateAttachmentFile } from '../../../../shared/attachmentPolicy';

const attachment = {
  id: '550e8400-e29b-41d4-a716-446655440000', name: 'clip.mp4', type: 'video' as const,
  mimeType: 'video/mp4', sizeBytes: 1024, url: '/api/attachments/550e8400-e29b-41d4-a716-446655440000/download',
};

test('round-trips file references with their caption without changing plain text messages', () => {
  expect(encodeAttachmentContent('hello')).toBe('hello');
  expect(decodeAttachmentContent('hello')).toEqual({ content: 'hello' });
  expect(decodeAttachmentContent(encodeAttachmentContent('watch this', [attachment])))
    .toEqual({ content: 'watch this', attachments: [attachment] });
});

test('refuses local blob URLs and external or script URLs in remote attachment references', () => {
  for (const url of ['blob:local', 'https://attacker.invalid/file', 'javascript:alert(1)', '//attacker.invalid/file']) {
    expect(parseUploadedAttachment({ ...attachment, url })).toBeNull();
    expect(() => encodeAttachmentContent('hello', [{ ...attachment, url }])).toThrow();
  }
});

test('normalizes legacy byte URLs to DB6 downloads without fetching the metadata route', () => {
  expect(parseUploadedAttachment({ ...attachment, url: `/api/attachments/${attachment.id}` })).toEqual(attachment);
  expect(parseUploadedAttachment({ ...attachment, url: attachment.url + '?recipient_user_id=other' })).toBeNull();
});

test('rejects oversized attachment lists and malformed authenticated content', () => {
  expect(() => encodeAttachmentContent('hello', Array(6).fill(attachment))).toThrow();
  const malformed = encodeAttachmentContent('hello', [attachment]).replace('video/mp4', 'text/html');
  expect(decodeAttachmentContent(malformed)).toEqual({ content: 'This attachment message could not be read.' });
});

test('accepts generic MIME types for recognized extensions and rejects disguised unsupported files', () => {
  expect(validateAttachmentFile({ name: 'NOTES.DOCX', type: '', size: 1 })).toBeNull();
  expect(validateAttachmentFile({ name: 'NOTES.DOCX', type: 'application/octet-stream', size: 1 })).toBeNull();
  expect(validateAttachmentFile({ name: 'fake.pdf', type: 'text/plain', size: 1 })).not.toBeNull();
  expect(validateAttachmentFile({ name: 'file.exe', type: 'application/pdf', size: 1 })).not.toBeNull();
});
