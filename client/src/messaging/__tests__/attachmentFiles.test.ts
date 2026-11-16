import { createSafeSvgPreview, prepareAttachmentFile, readAttachmentBytes } from '../attachmentFiles';
import { sanitizeAttachmentName } from '../../../../shared/attachmentPolicy';
import { makeAttachmentFile } from '../../../test/attachmentFixtures';

test('strips executable SVG content while preserving static drawing elements and original bytes', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div>HTML</div></foreignObject><image href="https://example.invalid/track"/><rect width="10" height="10" fill="red" onclick="alert(1)"/><path fill="url(https://example.invalid/x)" d="M0 0"/></svg>';
  const file = new File([svg], 'drawing.svg', { type: 'image/svg+xml' });
  const safe = new TextDecoder().decode(await readAttachmentBytes(await createSafeSvgPreview(file)));
  expect(safe).toContain('<rect');
  expect(safe).not.toMatch(/script|foreignObject|onload|onclick|https:\/\/example|<image/);
  expect(new TextDecoder().decode(await readAttachmentBytes(file))).toBe(svg);
});

test('rejects entity declarations, malformed SVG, and mismatched file contents', async () => {
  await expect(createSafeSvgPreview(new Blob(['<!DOCTYPE svg><svg/>']))).rejects.toThrow('entities');
  await expect(createSafeSvgPreview(new Blob(['<svg><bad></svg>']))).rejects.toThrow('could not be read');
  await expect(prepareAttachmentFile(new File(['not a PDF'], 'fake.pdf', { type: 'application/pdf' }))).rejects.toThrow('corrupted');
});

test('sanitizes filenames without changing the extension or original file bytes', async () => {
  expect(sanitizeAttachmentName('../name\u202e.pdf')).toBe('.._name_.pdf');
  expect(sanitizeAttachmentName('x'.repeat(210) + '.pdf')).toHaveLength(200);
  const original = makeAttachmentFile('a\\b.pdf', 'application/pdf');
  const { file } = await prepareAttachmentFile(original);
  expect(file.name).toBe('a_b.pdf');
  expect(await readAttachmentBytes(file)).toEqual(await readAttachmentBytes(original));
});
