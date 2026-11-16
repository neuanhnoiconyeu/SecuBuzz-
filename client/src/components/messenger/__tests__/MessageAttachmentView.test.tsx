import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageAttachmentView } from '../MessageAttachmentView';
import type { MessageAttachment } from '@/messaging/messageModel';

const base: MessageAttachment = { id: 'file-1', name: 'report.pdf', type: 'file', url: 'blob:example', sizeBytes: 1024 };
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalCreateUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
});
afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch); else Reflect.deleteProperty(globalThis, 'fetch');
  if (originalCreateUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateUrl); else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeUrl); else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

test('provides a named document download with its file size', () => {
  render(<MessageAttachmentView attachment={base} />);
  expect(screen.getByRole('link', { name: 'Download report.pdf' })).toHaveAttribute('download', 'report.pdf');
  expect(screen.getByText('1 KB')).toBeInTheDocument();
});

test('opens an image lightbox and restores keyboard focus after closing it', async () => {
  render(<MessageAttachmentView attachment={{ ...base, name: 'image.png', type: 'image' }} />);
  const trigger = screen.getByRole('button', { name: 'Preview image.png' });
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'image.png' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close attachment preview' }));
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('previews verified PDF bytes using the native viewer with open and download controls', async () => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: jest.fn(async () => ({ ok: true, blob: async () => new Blob(['%PDF-1.7\n'], { type: 'application/pdf' }) })) });
  render(<MessageAttachmentView attachment={base} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview report.pdf' }));
  expect(await screen.findByTitle('PDF preview: report.pdf')).toHaveAttribute('src', 'blob:preview');
  expect(screen.getByRole('link', { name: 'Open PDF' })).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('link', { name: 'Download original' })).toHaveAttribute('download', 'report.pdf');
});

test('never embeds HTML disguised as a PDF', async () => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: jest.fn(async () => ({ ok: true, blob: async () => new Blob(['<script>alert(1)</script>'], { type: 'text/html' }) })) });
  render(<MessageAttachmentView attachment={base} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview report.pdf' }));
  expect(screen.queryByTitle('PDF preview: report.pdf')).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('not a readable PDF');
  expect(screen.queryByTitle('PDF preview: report.pdf')).not.toBeInTheDocument();
});

test('renders video and audio players with native playback controls', () => {
  const { rerender } = render(<MessageAttachmentView attachment={{ ...base, type: 'video', name: 'clip.mp4' }} />);
  expect(screen.getByLabelText('Video: clip.mp4')).toHaveAttribute('controls');
  expect(screen.getByLabelText('Video: clip.mp4')).toHaveAttribute('preload', 'metadata');
  rerender(<MessageAttachmentView attachment={{ ...base, type: 'audio', name: 'track.mp3' }} />);
  expect(screen.getByLabelText('Audio: track.mp3')).toHaveAttribute('controls');
});
