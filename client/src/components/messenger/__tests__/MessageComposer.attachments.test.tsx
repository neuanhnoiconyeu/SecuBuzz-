import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageComposer } from '../MessageComposer';
import type { MessageComposerProps } from '../MessageComposer';
import { AttachmentUploadError } from '@/messaging/attachmentUpload';
import type { MessageAttachment } from '@/messaging/messageModel';
import {DEMO_MESSAGING_CAPABILITIES,REAL_ACCOUNT_MESSAGING_CAPABILITIES} from '@/messaging/messagingCapabilities';
import { makeAttachmentFile as makeFile } from '../../../../test/attachmentFixtures';

const megabyte = 1024 * 1024;
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const createObjectURL = jest.fn((file: Blob) => `blob:test-${(file as File).name}`);

function renderComposer(props: Partial<MessageComposerProps> = {}) {
  const onSend = jest.fn(async (_content: string, _extras?: unknown) => true);
  render(
    <MessageComposer conversationName="Peer" messageCount={0} isSending={false}
      buzzBusy={false} onSend={onSend} onBuzz={jest.fn()} {...props} />
  );
  const input = screen.getByLabelText('Select attachments') as HTMLInputElement;
  return { onSend, input };
}

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
});

beforeEach(() => {
  createObjectURL.mockClear();
});

afterAll(() => {
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

test('accepts images and PDFs at their size limits and sends both attachments', async () => {
  const { input, onSend } = renderComposer();
  fireEvent.change(input, { target: { files: [
    makeFile('photo.png', 'image/png', 5 * megabyte),
    makeFile('document.pdf', 'application/pdf', 10 * megabyte),
  ] } });

  await screen.findByRole('button', { name: 'Remove photo.png' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('', {
    attachments: [
      expect.objectContaining({ name: 'photo.png', type: 'image', sizeBytes: 5 * megabyte }),
      expect.objectContaining({ name: 'document.pdf', type: 'file', sizeBytes: 10 * megabyte }),
    ],
  }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove photo.png' })).not.toBeInTheDocument());
});

test('disabling attachment capability on an existing draft cannot invoke its uploader',async()=>{
  const uploadAttachment=jest.fn(),onSend=jest.fn(async()=>true);
  const props={conversationName:'Peer',messageCount:0,isSending:false,buzzBusy:false,onSend,uploadAttachment};
  const view=render(<MessageComposer {...props} capabilities={DEMO_MESSAGING_CAPABILITIES}/>);
  fireEvent.change(screen.getByLabelText('Select attachments'),{target:{files:[makeFile('private.pdf','application/pdf',32)]}});
  await screen.findByRole('button',{name:'Remove private.pdf'});
  view.rerender(<MessageComposer {...props} capabilities={{...REAL_ACCOUNT_MESSAGING_CAPABILITIES,attachments:false}}/>);
  expect(screen.queryByRole('button',{name:'Attach files or images'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'Send'})).toBeDisabled();
  fireEvent.submit(screen.getByRole('form'));expect(uploadAttachment).not.toHaveBeenCalled();expect(onSend).not.toHaveBeenCalled();
});

test.each([
  ['photo.png', 'image/png', 5 * megabyte + 1, '5 MB image limit'],
  ['document.pdf', 'application/pdf', 10 * megabyte + 1, '10 MB PDF limit'],
  ['program.exe', 'application/octet-stream', 1, 'Supported files:'],
  ['fake.pdf', 'text/plain', 1, 'Supported files:'],
  ['movie.mp4', 'video/mp4', 50 * megabyte + 1, '50 MB video limit'],
])('rejects %s before creating a preview', (name, type, size, error) => {
  const { input } = renderComposer();
  fireEvent.change(input, { target: { files: [makeFile(name, type, size)] } });

  expect(screen.getByRole('alert')).toHaveTextContent(error);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(input.value).toBe('');
});

test('preserves earlier attachments and rejects the whole new batch if any file is invalid', async () => {
  const { input } = renderComposer();
  fireEvent.change(input, { target: { files: [makeFile('kept.png', 'image/png')] } });
  await screen.findByRole('button', { name: 'Remove kept.png' });
  fireEvent.change(input, { target: { files: [
    makeFile('new.png', 'image/png'), makeFile('program.exe', 'application/octet-stream'),
  ] } });

  expect(screen.getByRole('button', { name: 'Remove kept.png' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove new.png' })).not.toBeInTheDocument();
  expect(createObjectURL).toHaveBeenCalledTimes(1);

  fireEvent.change(input, { target: { files: [makeFile('new.png', 'image/png')] } });
  await screen.findByRole('button', { name: 'Remove new.png' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove new.png' })).toBeInTheDocument();
});

test.each([
  ['notes.doc', 'application/msword', 'file'],
  ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file'],
  ['sheet.xlsx', '', 'file'],
  ['movie.mp4', 'video/mp4', 'video'],
  ['recording.mp3', 'audio/mpeg', 'audio'],
  ['archive.zip', 'application/zip', 'file'],
  ['archive.rar', 'application/vnd.rar', 'file'],
  ['archive.7z', 'application/x-7z-compressed', 'file'],
  ['notes.rtf', 'application/rtf', 'file'],
  ['drawing.svg', 'image/svg+xml', 'image'],
])('accepts %s and preserves its attachment type', async (name, mimeType, type) => {
  const { input, onSend } = renderComposer();
  fireEvent.change(input, { target: { files: [makeFile(name, mimeType)] } });
  await screen.findByRole('button', { name: `Remove ${name}` });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('', {
    attachments: [expect.objectContaining({ name, type })],
  }));
});

const uploaded: MessageAttachment = {
  id: '550e8400-e29b-41d4-a716-446655440000', name: 'document.pdf', type: 'file', sizeBytes: 64,
  mimeType: 'application/pdf', url: '/api/attachments/550e8400-e29b-41d4-a716-446655440000/download',
};

test('waits for upload before sending and reuses the uploaded file after a rejected message', async () => {
  let finish!: (value: MessageAttachment) => void;
  const uploadAttachment = jest.fn(() => new Promise<MessageAttachment>((resolve) => { finish = resolve; }));
  const send = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { input } = renderComposer({ uploadAttachment, onSend: send });
  fireEvent.change(input, { target: { files: [makeFile('document.pdf', 'application/pdf')] } });
  await screen.findByRole('button', { name: 'Remove document.pdf' });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(screen.getByRole('button', { name: 'Uploading 1/1' })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();

  finish(uploaded);
  await waitFor(() => expect(send).toHaveBeenCalledWith('', { attachments: [uploaded] }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is still here');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(uploadAttachment).toHaveBeenCalledTimes(1);
});

test('keeps the draft and selected file when an upload fails without sending the message', async () => {
  const uploadAttachment = jest.fn(async () => { throw new AttachmentUploadError('Upload failed. Try again.'); });
  const { input, onSend } = renderComposer({ uploadAttachment });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this caption' } });
  fireEvent.change(input, { target: { files: [makeFile('document.pdf', 'application/pdf')] } });
  await screen.findByRole('button', { name: 'Remove document.pdf' });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed');
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('keep this caption');
  expect(screen.getByRole('button', { name: 'Remove document.pdf' })).toBeInTheDocument();
});

test('enforces the five-file limit across selections and allows a replacement after removal', async () => {
  const { input } = renderComposer();
  fireEvent.change(input, { target: { files: Array.from({ length: 4 }, (_, index) =>
    makeFile(`photo-${index}.png`, 'image/png')) } });
  await screen.findByRole('button', { name: 'Remove photo-3.png' });
  fireEvent.change(input, { target: { files: [makeFile('fifth.pdf', 'application/pdf')] } });
  await screen.findByRole('button', { name: 'Remove fifth.pdf' });
  expect(createObjectURL).toHaveBeenCalledTimes(5);

  const replacement = makeFile('replacement.png', 'image/png');
  fireEvent.change(input, { target: { files: [replacement] } });
  expect(screen.getByRole('alert')).toHaveTextContent('up to 5 files per message');
  expect(createObjectURL).toHaveBeenCalledTimes(5);

  fireEvent.click(screen.getByRole('button', { name: 'Remove photo-0.png' }));
  fireEvent.change(input, { target: { files: [replacement] } });
  await screen.findByRole('button', { name: 'Remove replacement.png' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove replacement.png' })).toBeInTheDocument();
});

test('accepts a dropped batch once and disables sending while file validation is pending', async () => {
  renderComposer({ droppedFiles: [makeFile('dropped.pdf', 'application/pdf')] });
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  await screen.findByRole('button', { name: 'Remove dropped.pdf' });
  expect(screen.getAllByRole('button', { name: 'Remove dropped.pdf' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('rejects corrupted files without replacing an existing valid attachment', async () => {
  const { input } = renderComposer();
  fireEvent.change(input, { target: { files: [makeFile('kept.pdf', 'application/pdf')] } });
  await screen.findByRole('button', { name: 'Remove kept.pdf' });
  fireEvent.change(input, { target: { files: [new File(['invalid'], 'broken.png', { type: 'image/png' })] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('corrupted');
  expect(screen.getByRole('button', { name: 'Remove kept.pdf' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove broken.png' })).not.toBeInTheDocument();
});
