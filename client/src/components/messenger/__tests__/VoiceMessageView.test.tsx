import {render,screen,waitFor,cleanup,fireEvent} from '@testing-library/react';
import {VoiceMessageView} from '../VoiceMessageView';
import {EncryptedAttachmentContext} from '@/messaging/EncryptedAttachmentContext';
import type {VoiceMessageMetadata} from '@/messaging/messageModel';
import {voiceWav} from '../../../../test/voiceAudioFixture.cjs';
const saved=[Object.getOwnPropertyDescriptor(globalThis,'OfflineAudioContext'),Object.getOwnPropertyDescriptor(URL,'createObjectURL'),Object.getOwnPropertyDescriptor(URL,'revokeObjectURL')];
const create=jest.fn(()=> 'blob:verified-voice'),revoke=jest.fn(),decode=jest.fn();
const id=crypto.randomUUID(),voice:VoiceMessageMetadata={audioUrl:'',durationSeconds:1,attachment:{id,name:'voice.wav',type:'audio',url:'',mimeType:'audio/wav',sizeBytes:32044,
  encrypted:{v:1,id,conversationId:'chat',messageId:crypto.randomUUID(),senderId:'alice',name:'voice.wav',mimeType:'audio/wav',size:32044,key:'A'.repeat(43),iv:'A'.repeat(16),sha256:'a'.repeat(64)}}};
beforeAll(()=>{
  Object.defineProperty(globalThis,'OfflineAudioContext',{configurable:true,value:class{decodeAudioData=decode;}});
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke});
});
beforeEach(()=>{decode.mockReset().mockResolvedValue({duration:1,numberOfChannels:1});create.mockClear();revoke.mockClear();});
afterEach(()=>{cleanup();jest.restoreAllMocks();});
afterAll(()=>{([[globalThis,'OfflineAudioContext'],[URL,'createObjectURL'],[URL,'revokeObjectURL']] as const).forEach(([target,key],i)=>{const descriptor=saved[i];if(descriptor)Object.defineProperty(target,key,descriptor);else Reflect.deleteProperty(target,key);});});
const read=async()=>new Blob([voiceWav()],{type:'audio/wav'});
test('verified encrypted voice keeps native playback controls and releases playback and Blob resources on unmount',async()=>{
  const pause=jest.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{}),load=jest.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
  const view=render(<EncryptedAttachmentContext.Provider value={read}><VoiceMessageView voice={voice} senderName="Alice" ownerId="bob" conversationId="chat"/></EncryptedAttachmentContext.Provider>);
  const player=await screen.findByLabelText('Voice message from Alice');expect(player).toHaveAttribute('src','blob:verified-voice');expect(player).toHaveAttribute('controls');
  view.unmount();expect(pause).toHaveBeenCalled();expect(load).toHaveBeenCalled();expect(player).not.toHaveAttribute('src');expect(revoke).toHaveBeenCalledWith('blob:verified-voice');
});
test('invalid protected duration cannot expose a playback URL',async()=>{
  decode.mockResolvedValue({duration:20,numberOfChannels:1});
  render(<EncryptedAttachmentContext.Provider value={read}><VoiceMessageView voice={voice} senderName="Alice" ownerId="bob" conversationId="chat"/></EncryptedAttachmentContext.Provider>);
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('duration'));expect(screen.queryByLabelText('Voice message from Alice')).not.toBeInTheDocument();expect(create).not.toHaveBeenCalled();
});
test('a failed voice download can be retried through the authorized loader without exposing unverified bytes',async()=>{
  const loader=jest.fn().mockRejectedValueOnce(new Error('Temporary download failure')).mockImplementation(read);
  const pause=jest.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{}),load=jest.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
  render(<EncryptedAttachmentContext.Provider value={loader}><VoiceMessageView voice={voice} senderName="Alice" ownerId="bob" conversationId="chat"/></EncryptedAttachmentContext.Provider>);
  await screen.findByRole('button',{name:'Retry voice message'});expect(create).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Retry voice message'}));
  expect(await screen.findByLabelText('Voice message from Alice')).toHaveAttribute('src','blob:verified-voice');expect(loader).toHaveBeenCalledTimes(2);
  cleanup();expect(pause).toHaveBeenCalled();expect(load).toHaveBeenCalled();
});
