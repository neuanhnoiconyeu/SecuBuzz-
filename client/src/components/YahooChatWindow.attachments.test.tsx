import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import YahooChatWindow from './YahooChatWindow';
import type { MessagingTransport } from '@/messaging/transport';
import { localAttachmentStore } from '@/messaging/localAttachmentStore';

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const ready = process.env.NEXT_PUBLIC_ATTACHMENT_API_READY;
const requestFetch = jest.fn();
let meta: HTMLMetaElement;
const id = '550e8400-e29b-41d4-a716-446655440000';
const transport = (mode: MessagingTransport['mode']): MessagingTransport => ({
  mode, async connect() {}, async disconnect() {}, sendMessage: jest.fn(async () => {}), subscribeToConversation: () => () => {},
});
beforeAll(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: requestFetch });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:composer-fixture' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
});
beforeEach(() => {
  requestFetch.mockReset(); process.env.NEXT_PUBLIC_ATTACHMENT_API_READY = 'true';
  meta = document.createElement('meta'); meta.name = 'secubuzz-csrf-token'; meta.content = 'test-csrf'; document.head.appendChild(meta);
});
afterEach(() => meta.remove());
afterAll(() => {
  if (ready === undefined) delete process.env.NEXT_PUBLIC_ATTACHMENT_API_READY; else process.env.NEXT_PUBLIC_ATTACHMENT_API_READY = ready;
  for (const [object, key, descriptor] of [[globalThis, 'fetch', originalFetch], [URL, 'createObjectURL', originalCreate], [URL, 'revokeObjectURL', originalRevoke]] as const) {
    if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key);
  }
});

test('composed realtime chat uploads to the explicit DB6 recipient and then submits its encrypted message', async () => {
  requestFetch.mockResolvedValue({ ok: true, json: async () => ({ attachment_id: id, original_name: 'report.pdf', mime_type: 'application/pdf',
    size_bytes: 5, group_id: null, recipient_user_id: 'real-recipient', encryption_algorithm: null, expires_at: null, deleted_at: null }) });
  const realtime = transport('realtime');
  const { container } = render(<YahooChatWindow conversationId="opaque-direct-conversation" conversationType="direct" currentUserId="real-owner"
    attachmentTarget={{ type: 'direct', recipientUserId: 'real-recipient' }} transport={realtime} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach files or images' })).toBeEnabled());
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['%PDF-'], 'report.pdf', { type: 'application/pdf' })] } });
  await screen.findByRole('button', { name: 'Remove report.pdf' });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(realtime.sendMessage).toHaveBeenCalled());
  expect(requestFetch.mock.calls[0]?.[0]).toBe('/api/attachments?recipient_user_id=real-recipient');
});

test('realtime chat never guesses a recipient from its conversation ID', async () => {
  render(<YahooChatWindow conversationId="opaque-direct-conversation" conversationType="direct" transport={transport('realtime')} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach files or images' })).toHaveAttribute('title', 'File uploads are not available yet.'));
  expect(screen.getByRole('button', { name: 'Attach files or images' })).toBeDisabled(); expect(requestFetch).not.toHaveBeenCalled();
});

test('demo uploads use local storage and never fall back to DB6 when local storage fails', async () => {
  const save = jest.spyOn(localAttachmentStore, 'putFile').mockRejectedValue(new Error('Local store fixture denial'));
  const local = transport('local-demo');
  try {
    const { container } = render(<YahooChatWindow conversationId="db6-demo-isolation" currentUserId="demo-attachment-owner" transport={local}
      attachmentTarget={{ type: 'direct', recipientUserId: 'real-recipient' }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach files or images' })).toBeEnabled());
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['%PDF-'], 'local.pdf', { type: 'application/pdf' })] } });
    await screen.findByRole('button', { name: 'Remove local.pdf' }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Local file storage is full or unavailable');
    expect(save).toHaveBeenCalledWith('demo-attachment-owner', 'db6-demo-isolation', expect.any(File));
    expect(screen.getByRole('button', { name: 'Remove local.pdf' })).toBeInTheDocument();
    expect(local.sendMessage).not.toHaveBeenCalled(); expect(requestFetch).not.toHaveBeenCalled();
  } finally { save.mockRestore(); }
});
