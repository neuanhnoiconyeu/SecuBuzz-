import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageComposer } from '../MessageComposer';
import YahooChatWindow from '../../YahooChatWindow';
import { TestMediaRecorder, microphone } from '../../../../test/voiceRecordingFixture';
import type { OutboundMessage } from '@/messaging/messageModel';

const originals = [Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder'), Object.getOwnPropertyDescriptor(navigator, 'mediaDevices'),
  Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'), Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')];
const getMedia = jest.fn(), revoke = jest.fn();
let sequence = 0;
beforeAll(() => {
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: TestMediaRecorder });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: getMedia } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => `blob:voice-ui-${++sequence}` });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
beforeEach(() => { TestMediaRecorder.reset(); getMedia.mockReset(); revoke.mockClear(); getMedia.mockResolvedValue(microphone().stream); });
afterAll(() => {
  const replacements: Array<[object, string]> = [[globalThis, 'MediaRecorder'], [navigator, 'mediaDevices'], [URL, 'createObjectURL'], [URL, 'revokeObjectURL'],
    [HTMLDialogElement.prototype, 'showModal'], [HTMLDialogElement.prototype, 'close']];
  replacements.forEach(([target, key], index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); });
});
const record = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stop voice recording' }));
  return screen.findByLabelText('Recorded voice preview');
};
const props = { conversationName: 'Peer', messageCount: 0, isSending: false, buzzBusy: false };

test('recording previews retain native playback controls, survive a rejected send, and revoke on removal', async () => {
  const send = jest.fn(async () => false); render(<MessageComposer {...props} onSend={send} />);
  const preview = await record(), url = preview.getAttribute('src')!;
  expect(preview).toHaveAttribute('controls'); expect(preview).toHaveAttribute('preload', 'metadata'); expect(screen.getByText('🎤 Voice (1s)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is still here'); expect(send).toHaveBeenCalledWith('', { voice: { audioUrl: url, durationSeconds: 1 } });
  expect(revoke).not.toHaveBeenCalled(); expect(preview).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove recorded voice' }));
  expect(screen.queryByLabelText('Recorded voice preview')).not.toBeInTheDocument(); expect(revoke).toHaveBeenCalledWith(url);
});

test('cancelling a recording stops the microphone without producing a preview', async () => {
  const mic = microphone(); getMedia.mockResolvedValue(mic.stream); render(<MessageComposer {...props} onSend={async () => true} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel voice recording' }));
  expect(mic.stop).toHaveBeenCalledTimes(1); expect(screen.queryByLabelText('Recorded voice preview')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
});

test('a pending permission request can be cancelled and permission denial shows safe feedback', async () => {
  let grant!: (stream: MediaStream) => void; const mic = microphone();
  getMedia.mockReturnValueOnce(new Promise<MediaStream>(resolve => { grant = resolve; }));
  render(<MessageComposer {...props} onSend={async () => true} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
  expect(screen.getByText('Waiting for microphone permission…')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await act(async () => grant(mic.stream));
  expect(mic.stop).toHaveBeenCalledTimes(1); expect(TestMediaRecorder.instances).toHaveLength(0);
  getMedia.mockRejectedValueOnce(new DOMException('Internal denial text', 'NotAllowedError'));
  fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Allow the microphone and try again'); expect(screen.queryByText('Internal denial text')).not.toBeInTheDocument();
});

test('the composed demo chat keeps sent audio playable after clearing the draft and releases it on Unsend', async () => {
  const transport = { mode: 'local-demo' as const, connect: async () => {}, disconnect: async () => {},
    sendMessage: jest.fn(async (_message: OutboundMessage) => {}), deleteMessage: async () => {}, subscribeToConversation: () => () => {} };
  render(<YahooChatWindow conversationId="voice-room" transport={transport} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Record voice message' })).toBeEnabled());
  const preview = await record(), url = preview.getAttribute('src')!;
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const player = await screen.findByLabelText('Voice message from You');
  await waitFor(() => expect(screen.queryByLabelText('Recorded voice preview')).not.toBeInTheDocument());
  expect(player).toHaveAttribute('src', url); expect(player).toHaveAttribute('controls'); expect(revoke).not.toHaveBeenCalledWith(url);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Unsend' })); fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByLabelText('Voice message from You')).not.toBeInTheDocument());
  expect(revoke).toHaveBeenCalledWith(url);
});

test('hiding the chat cancels active capture while text-only mode exposes no recorder', async () => {
  const mic = microphone(); getMedia.mockResolvedValue(mic.stream);
  const { rerender } = render(<MessageComposer {...props} onSend={async () => true} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record voice message' })); await screen.findByRole('button', { name: 'Stop voice recording' });
  rerender(<MessageComposer {...props} active={false} onSend={async () => true} />); expect(mic.stop).toHaveBeenCalledTimes(1);
  rerender(<MessageComposer {...props} textOnly onSend={async () => true} />); expect(screen.queryByRole('button', { name: 'Record voice message' })).not.toBeInTheDocument();
});
