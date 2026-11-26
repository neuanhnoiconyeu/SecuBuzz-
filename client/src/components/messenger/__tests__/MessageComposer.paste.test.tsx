import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageComposer } from '../MessageComposer';
import { extractClipboardImages } from '@/messaging/clipboardImages';
import { encryptAttachment, decryptAttachment } from '@/messaging/encryptedAttachmentCrypto';
import { readAttachmentBytes } from '@/messaging/attachmentFiles';
import { REAL_ACCOUNT_MESSAGING_CAPABILITIES } from '@/messaging/messagingCapabilities';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  URL.createObjectURL = jest.fn(() => 'blob:pasted-preview');
  URL.revokeObjectURL = jest.fn();
});

afterAll(() => {
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
});

function makePng(name = 'image.png', extra = 0): File {
  const bytes = new Uint8Array(PNG_HEADER.length + extra);
  bytes.set(PNG_HEADER);
  bytes.fill(0x41, PNG_HEADER.length);
  return new File([bytes], name, { type: 'image/png', lastModified: 1700000000000 + extra });
}

function makeJpeg(name = 'photo.jpg'): File {
  return new File([JPEG_HEADER], name, { type: 'image/jpeg', lastModified: 1700000001000 });
}

function clipboardWith({ items = [], files = [] }: {
  items?: Array<{ kind: string; type: string; file?: File }>;
  files?: File[];
}): DataTransfer {
  return {
    items: items.map((entry) => ({
      kind: entry.kind,
      type: entry.type,
      getAsFile: () => entry.file ?? null,
    })) as unknown as DataTransferItemList,
    files: files as unknown as FileList,
  } as DataTransfer;
}

const baseProps = {
  conversationName: 'Peer',
  messageCount: 0,
  isSending: false,
  buzzBusy: false,
  capabilities: { ...REAL_ACCOUNT_MESSAGING_CAPABILITIES, attachments: true },
};

test('extractClipboardImages deduplicates items/files and normalizes unnamed screenshots', () => {
  const shot = makePng('');
  const dup = clipboardWith({
    items: [
      { kind: 'string', type: 'text/html' },
      { kind: 'file', type: 'image/png', file: shot },
      { kind: 'file', type: 'image/png', file: shot },
    ],
    files: [shot],
  });
  const extracted = extractClipboardImages(dup);
  expect(extracted).toHaveLength(1);
  expect(extracted[0]!.name).toMatch(/^pasted-image-\d+-1\.png$/);
  expect(extracted[0]!.type).toBe('image/png');

  const fallback = extractClipboardImages(clipboardWith({ files: [makeJpeg('copied.jpg')] }));
  expect(fallback).toHaveLength(1);
  expect(fallback[0]!.name).toBe('copied.jpg');
});

test('pasting a screenshot stages preview without auto-uploading, supports caption, and sends through attachment pipeline', async () => {
  const uploadAttachment = jest.fn(async (file: File) => ({
    id: `att-${file.name}`,
    name: file.name,
    type: 'image' as const,
    url: '',
    mimeType: file.type,
    sizeBytes: file.size,
  }));
  const onSend = jest.fn(async () => true);

  render(<MessageComposer {...baseProps} uploadAttachment={uploadAttachment} onSend={onSend} />);
  const input = screen.getByRole('textbox', { name: 'Message to Peer' });

  const screenshot = makePng('image.png', 8);
  const notPrevented = fireEvent.paste(input, {
    clipboardData: clipboardWith({ items: [{ kind: 'file', type: 'image/png', file: screenshot }] }),
  });
  expect(notPrevented).toBe(false);

  const removeBtn = await screen.findByRole('button', { name: /^Remove pasted-image-/ });
  expect(removeBtn).toBeInTheDocument();
  expect(uploadAttachment).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: 'Check this screenshot' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  });

  expect(uploadAttachment).toHaveBeenCalledTimes(1);
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(onSend).toHaveBeenCalledWith('Check this screenshot', expect.objectContaining({
    attachments: [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
  }));
});

test('text-only paste is not intercepted and outside paste events are ignored', () => {
  const uploadAttachment = jest.fn();
  render(
    <>
      <textarea aria-label="Outside input" />
      <MessageComposer {...baseProps} uploadAttachment={uploadAttachment} onSend={jest.fn(async () => true)} />
    </>
  );

  const input = screen.getByRole('textbox', { name: 'Message to Peer' });
  const textResult = fireEvent.paste(input, {
    clipboardData: clipboardWith({ items: [{ kind: 'string', type: 'text/plain' }] }),
  });
  expect(textResult).toBe(true);
  expect(uploadAttachment).not.toHaveBeenCalled();

  const outside = screen.getByRole('textbox', { name: 'Outside input' });
  const outsideResult = fireEvent.paste(outside, {
    clipboardData: clipboardWith({ items: [{ kind: 'file', type: 'image/png', file: makePng() }] }),
  });
  expect(outsideResult).toBe(true);
  expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
});

test('supports multiple pasted images, individual removal, and preserves draft on send failure', async () => {
  const uploadAttachment = jest.fn(async (file: File) => ({
    id: `att-${file.name}`,
    name: file.name,
    type: 'image' as const,
    url: '',
    mimeType: file.type,
    sizeBytes: file.size,
  }));
  const onSend = jest.fn(async () => false);

  render(<MessageComposer {...baseProps} uploadAttachment={uploadAttachment} onSend={onSend} />);
  const input = screen.getByRole('textbox', { name: 'Message to Peer' });

  fireEvent.paste(input, {
    clipboardData: clipboardWith({
      items: [
        { kind: 'file', type: 'image/png', file: makePng('image.png', 1) },
        { kind: 'file', type: 'image/jpeg', file: makeJpeg('snap.jpg') },
      ],
    }),
  });

  await screen.findByRole('button', { name: 'Remove snap.jpg' });
  expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);

  // Remove one pasted image before sending
  fireEvent.click(screen.getByRole('button', { name: 'Remove snap.jpg' }));
  expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);

  // Send fails -> attachment & error preserved
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('not accepted');
  expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);

  // Retry succeeds
  onSend.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument());
});

test('pasted clipboard image encrypts and decrypts cleanly with E2EE attachment crypto', async () => {
  const shot = makePng('image.png', 16);
  const [normalized] = extractClipboardImages(clipboardWith({ items: [{ kind: 'file', type: 'image/png', file: shot }] }));
  const { manifest, bytes } = await encryptAttachment(normalized!, {
    id: '11111111-1111-4111-8111-111111111111',
    conversationId: 'conv-1',
    messageId: '22222222-2222-4222-8222-222222222222',
    senderId: 'alice',
  });
  const decrypted = await decryptAttachment(manifest, bytes);
  expect(new Uint8Array(await readAttachmentBytes(decrypted))).toEqual(new Uint8Array(await readAttachmentBytes(normalized!)));
});
