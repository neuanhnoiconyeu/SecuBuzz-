import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageComposer,type MessageComposerSendExtras } from '../MessageComposer';
import YahooChatWindow from '../../YahooChatWindow';
import { TestMediaRecorder, microphone } from '../../../../test/voiceRecordingFixture';
import {makeAttachmentFile} from '../../../../test/attachmentFixtures';
import type { OutboundMessage,VoiceMessageMetadata,RecordedVoiceDraft } from '@/messaging/messageModel';

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

test('voice counts toward the existing attachment limit before any encrypted uploads start',async()=>{
  const prepareVoice=jest.fn(),uploadAttachment=jest.fn(),onSend=jest.fn(async()=>true);
  render(<MessageComposer {...props} prepareVoice={prepareVoice} uploadAttachment={uploadAttachment} onSend={onSend}/>);
  fireEvent.change(screen.getByLabelText('Select attachments'),{target:{files:Array.from({length:5},(_,i)=>makeAttachmentFile(`file-${i}.pdf`,'application/pdf'))}});
  await screen.findByRole('button',{name:'Remove file-4.pdf'});await record();fireEvent.click(screen.getByRole('button',{name:'Send'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('up to four other files');expect(prepareVoice).not.toHaveBeenCalled();expect(uploadAttachment).not.toHaveBeenCalled();expect(onSend).not.toHaveBeenCalled();
});

test('authenticated preparation receives the recording bytes and sends no local URL or Blob as message metadata',async()=>{
  const prepared:VoiceMessageMetadata={audioUrl:'',durationSeconds:1,attachment:{id:'file',name:'voice.weba',type:'audio',url:'',sizeBytes:32}};
  const prepareVoice=jest.fn(async(_draft:RecordedVoiceDraft,_signal:AbortSignal)=>prepared),onSend=jest.fn(async(_text:string,_extras?:MessageComposerSendExtras)=>false);
  render(<MessageComposer {...props} prepareVoice={prepareVoice} onSend={onSend}/>);const preview=await record();
  fireEvent.click(screen.getByRole('button',{name:'Send'}));await waitFor(()=>expect(onSend).toHaveBeenCalledWith('',{voice:prepared}));
  expect(prepareVoice.mock.calls[0]?.[0]).toMatchObject({audioUrl:preview.getAttribute('src'),blob:expect.any(Blob)});
  expect(onSend.mock.calls[0]?.[1]).not.toHaveProperty('voice.blob');expect(preview).toBeInTheDocument();
});
test('an encrypted voice preparation completing after unmount is cancelled and safely discarded',async()=>{
  let finish!:(voice:VoiceMessageMetadata)=>void;
  const prepareVoice=jest.fn((_draft:unknown,_signal:AbortSignal)=>new Promise<VoiceMessageMetadata>(resolve=>{finish=resolve;})),onSend=jest.fn(async()=>true),discardAttachment=jest.fn(async()=>{});
  const view=render(<MessageComposer {...props} prepareVoice={prepareVoice} onSend={onSend} discardAttachment={discardAttachment}/>);await record();
  fireEvent.click(screen.getByRole('button',{name:'Send'}));await waitFor(()=>expect(prepareVoice).toHaveBeenCalled());view.unmount();
  const attachment={id:'file',name:'voice.weba',type:'audio' as const,url:'',sizeBytes:32};
  await act(async()=>finish({audioUrl:'',durationSeconds:1,attachment}));
  expect(prepareVoice.mock.calls[0]?.[1].aborted).toBe(true);expect(discardAttachment).toHaveBeenCalledWith(attachment);expect(onSend).not.toHaveBeenCalled();
});

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
  fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' })); fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
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
