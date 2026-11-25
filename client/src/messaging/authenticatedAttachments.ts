import type {SessionApi} from '@/api/sessionApi';
import type {MessageAttachment,RecordedVoiceDraft,VoiceMessageMetadata} from './messageModel';
import {inspectVoiceAudio} from './voiceAudio';
import {getAttachmentRule} from '../../../shared/attachmentPolicy';
import {validAttachmentSet,type EncryptedAttachmentManifest} from '../../../shared/encryptedAttachments';
import {encryptAttachment,decryptAttachment} from './encryptedAttachmentCrypto';

/** A composer batch owns a stable wire ID and exact ciphertext across uncertain upload retries. */
export class AuthenticatedAttachments {
  private messageId=crypto.randomUUID();
  private uploads=new WeakMap<File,Promise<{manifest:EncryptedAttachmentManifest;bytes:ArrayBuffer}>>();
  private voiceFiles=new WeakMap<Blob,Promise<{file:File;durationSeconds:number}>>();
  constructor(private readonly api:SessionApi,private readonly conversationId:string){}
  upload=async(file:File,signal?:AbortSignal):Promise<MessageAttachment>=>{
    if(!this.api.binary)throw new Error('Encrypted attachment transport is unavailable.');
    const limits=await this.api.request('/api/attachments/limits',{signal}) as {v:number;maxCiphertextBytes:number};
    if(limits?.v!==1||!Number.isSafeInteger(limits.maxCiphertextBytes))throw new Error('Invalid encrypted storage limits.');
    if(file.size+16>limits.maxCiphertextBytes)throw new Error(`This server accepts encrypted files up to ${Math.floor(limits.maxCiphertextBytes/1024/1024)} MB including encryption overhead.`);
    let pending=this.uploads.get(file);
    if(!pending){pending=encryptAttachment(file,{id:crypto.randomUUID(),conversationId:this.conversationId,messageId:this.messageId,senderId:this.api.actor.id});this.uploads.set(file,pending);}
    const {manifest:m,bytes}=await pending;
    if(signal?.aborted)throw new Error('Saving was cancelled.');
    const ack=await this.api.binary(`/api/attachments?conversation_id=${encodeURIComponent(m.conversationId)}&message_id=${m.messageId}&id=${m.id}`,
      {method:'POST',body:new Blob([bytes],{type:'application/octet-stream'}),...(signal?{signal}:{})}) as Record<string,unknown>;
    if(ack?.v!==1||ack.id!==m.id||ack.messageId!==m.messageId||ack.conversationId!==m.conversationId||ack.senderId!==m.senderId||ack.ciphertextSize!==bytes.byteLength||ack.sha256!==m.sha256)throw new Error('The encrypted upload could not be verified. Retry with the same files.');
    return {id:m.id,name:m.name,type:getAttachmentRule(m.name)!.kind,url:'',mimeType:m.mimeType,sizeBytes:m.size,encrypted:m};
  };
  seal=async(items:readonly MessageAttachment[]):Promise<{messageId:string;manifests:EncryptedAttachmentManifest[]}>=>{
    const manifests=items.map(item=>item.encrypted);
    if(!validAttachmentSet(manifests)||manifests.some(m=>m.conversationId!==this.conversationId||m.messageId!==this.messageId||m.senderId!==this.api.actor.id))throw new Error('These encrypted files belong to a different message. Select them again.');
    const ack=await this.api.request(`/api/attachments/batches/${this.conversationId}/${this.messageId}`,{method:'POST',body:{ids:manifests.map(m=>m.id)}}) as {sealed?:boolean};
    if(ack?.sealed!==true)throw new Error('The encrypted files could not be associated with this message.');
    return {messageId:this.messageId,manifests};
  };
  uploadVoice=async(draft:RecordedVoiceDraft,signal:AbortSignal):Promise<VoiceMessageMetadata>=>{
    let preparation=this.voiceFiles.get(draft.blob);
    if(!preparation){
      preparation=inspectVoiceAudio(draft.blob).then(info=>({durationSeconds:info.durationSeconds,
        file:new File([draft.blob],`voice-${crypto.randomUUID()}.${info.extension}`,{type:info.mimeType})}));
      this.voiceFiles.set(draft.blob,preparation);
    }
    const {file,durationSeconds}=await preparation;
    if(signal.aborted)throw new Error('Voice upload was cancelled.');
    const attachment=await this.upload(file,signal);
    return {audioUrl:'',durationSeconds,attachment};
  };
  accepted=(messageId?:string)=>{if(!messageId||this.messageId===messageId){this.messageId=crypto.randomUUID();this.uploads=new WeakMap();this.voiceFiles=new WeakMap();}};
  discard=async(item:MessageAttachment):Promise<void>=>{
    if(item.encrypted?.senderId!==this.api.actor.id||item.encrypted.conversationId!==this.conversationId)return;
    await this.api.request(`/api/attachments/${item.id}`,{method:'DELETE'});
  };
  read=async(item:MessageAttachment,signal:AbortSignal):Promise<Blob>=>{
    if(!item.encrypted||!this.api.binary)throw new Error('Encrypted attachment unavailable.');
    const bytes=await this.api.binary(`/api/attachments/${item.encrypted.id}/download`,{method:'GET',signal});
    if(!(bytes instanceof ArrayBuffer)||signal.aborted)throw new Error('The encrypted file could not be loaded.');
    const blob=await decryptAttachment(item.encrypted,bytes);
    if(signal.aborted)throw new Error('The file request was cancelled.');
    return blob;
  };
}
