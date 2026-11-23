import {inspectVoiceAudio,verifyVoicePlayback} from '../voiceAudio';
import {encodeAuthenticatedContent,decodeAuthenticatedContent} from '../authenticatedContent';
import {AuthenticatedAttachments} from '../authenticatedAttachments';
import type {SessionApi} from '@/api/sessionApi';
import {fileDigest} from '../encryptedAttachmentCrypto';
import {presentMessages} from '@/components/messenger/authenticatedChatPresentation';
import {envelope} from '@/realtime/testing/authenticatedFixtures';
import type {StoredMessage} from '@/security/e2ee/model';
import {voiceWav} from '../../../test/voiceAudioFixture.cjs';
const original=Object.getOwnPropertyDescriptor(globalThis,'OfflineAudioContext');
const decode=jest.fn();
beforeAll(()=>Object.defineProperty(globalThis,'OfflineAudioContext',{configurable:true,value:class{decodeAudioData=decode;}}));
beforeEach(()=>decode.mockReset().mockResolvedValue({duration:1,numberOfChannels:1}));
afterAll(()=>{if(original)Object.defineProperty(globalThis,'OfflineAudioContext',original);else Reflect.deleteProperty(globalThis,'OfflineAudioContext');});
const blob=()=>new Blob([voiceWav()],{type:'audio/wav'});
const manifest={v:1 as const,id:crypto.randomUUID(),conversationId:'chat',messageId:crypto.randomUUID(),senderId:'alice',name:'voice.wav',mimeType:'audio/wav',size:32044,key:'A'.repeat(43),iv:'A'.repeat(16),sha256:'a'.repeat(64)};
test('recorded audio is decoded for its actual duration and scoped voice metadata survives protected content encoding',async()=>{
  expect(await inspectVoiceAudio(blob())).toEqual({durationSeconds:1,mimeType:'audio/wav',extension:'wav'});
  const content={text:'',attachments:[manifest],voice:{v:1 as const,attachmentId:manifest.id,durationSeconds:1}};
  expect(decodeAuthenticatedContent(encodeAuthenticatedContent(content))).toEqual(content);
  await expect(verifyVoicePlayback(blob(),1)).resolves.toBeUndefined();
});
test('voice presentation uses verified encrypted files and Unsend removes the player metadata',()=>{
  const message:StoredMessage={...envelope,id:manifest.messageId,conversationId:manifest.conversationId,senderId:manifest.senderId,storageId:'storage',sequence:1,revision:0,state:'active',deletedAt:null,storedAt:envelope.timestamp,updatedAt:envelope.timestamp};
  const text=encodeAuthenticatedContent({text:'',attachments:[manifest],voice:{v:1,attachmentId:manifest.id,durationSeconds:1}});
  const visible=presentMessages([{message,text,error:null}]);expect(visible.messages[0]?.type).toBe('voice');expect(visible.messages[0]?.attachments).toEqual([]);
  expect(visible.messages[0]?.voice).toMatchObject({audioUrl:'',durationSeconds:1,attachment:{encrypted:manifest}});expect(visible.verifiedIds.has(message.id)).toBe(true);
  const removed=presentMessages([{message:{...message,state:'deleted',encryption:null,deletedAt:envelope.timestamp,revision:1},text:null,error:null}]);
  expect(removed.messages[0]?.voice).toBeUndefined();expect(removed.messages[0]?.attachments).toBeUndefined();
});
test('unsupported audio verification does not create a fallback',async()=>{
  const constructor=globalThis.OfflineAudioContext;Object.defineProperty(globalThis,'OfflineAudioContext',{configurable:true,value:undefined});
  try{await expect(inspectVoiceAudio(blob())).rejects.toThrow('cannot verify');}finally{Object.defineProperty(globalThis,'OfflineAudioContext',{configurable:true,value:constructor});}
});
test.each([0,301,Infinity,NaN])('rejects unsafe decoded duration %s before upload or playback',async duration=>{
  decode.mockResolvedValue({duration,numberOfChannels:1});await expect(inspectVoiceAudio(blob())).rejects.toThrow('5 minutes');
});
test('rejects invalid type, bytes, size, undecodable audio, cancellation and protected duration mismatch',async()=>{
  await expect(inspectVoiceAudio(new Blob(['private'],{type:'video/webm'}))).rejects.toThrow('supported audio');
  await expect(inspectVoiceAudio(new Blob(['invalid'],{type:'audio/wav'}))).rejects.toThrow('valid audio');
  await expect(inspectVoiceAudio(new Blob([new Uint8Array(20*1024*1024+1)],{type:'audio/wav'}))).rejects.toThrow('20 MB');
  decode.mockRejectedValueOnce(new Error('private decoder details'));await expect(inspectVoiceAudio(blob())).rejects.toThrow('could not be decoded');
  await expect(verifyVoicePlayback(blob(),10)).rejects.toThrow('duration');
  const controller=new AbortController();controller.abort();await expect(inspectVoiceAudio(blob(),controller.signal)).rejects.toThrow('cancelled');
});
test.each([{attachmentId:crypto.randomUUID()},{durationSeconds:-1},{durationSeconds:301},{v:2}])('rejects invalid protected voice references %j',patch=>{
  expect(()=>encodeAuthenticatedContent({text:'',attachments:[manifest],voice:{v:1,attachmentId:manifest.id,durationSeconds:1,...patch}} as never)).toThrow();
});
test('a voice upload retry reuses the exact ciphertext and identifiers, with no local URL or key in the storage request',async()=>{
  const attempts:{path:string;bytes:ArrayBuffer}[]=[];let fail=true;
  const api:SessionApi={actor:{id:'alice',username:'alice'},dispose(){},request:jest.fn(async()=>({v:1,maxCiphertextBytes:25*1024*1024})),binary:jest.fn(async(path,options)=>{
    const bytes=await (await import('../attachmentFiles')).readAttachmentBytes(options.body!);attempts.push({path,bytes});
    if(fail){fail=false;throw new Error('Response lost');}
    const query=new URL('http://local'+path).searchParams;
    return {v:1,id:query.get('id'),conversationId:query.get('conversation_id'),messageId:query.get('message_id'),senderId:'alice',ciphertextSize:bytes.byteLength,sha256:await fileDigest(bytes)};
  })};
  const uploader=new AuthenticatedAttachments(api,'chat'),draft={audioUrl:'blob:local-only',durationSeconds:999,blob:blob()},signal=new AbortController().signal;
  await expect(uploader.uploadVoice(draft,signal)).rejects.toThrow('Response lost');const result=await uploader.uploadVoice(draft,signal);
  expect(result.audioUrl).toBe('');expect(result.durationSeconds).toBe(1);expect(result.attachment?.encrypted?.key).toBeTruthy();
  expect(attempts[0]).toEqual(attempts[1]);expect(attempts[0]!.bytes.byteLength).toBe(draft.blob.size+16);
  expect(attempts[0]!.path).not.toContain('blob:');expect(attempts[0]!.path).not.toContain(result.attachment!.encrypted!.key);
  expect(decode).toHaveBeenCalledTimes(1);
});
