import {isFileId,type EncryptedAttachmentManifest} from './encryptedAttachments.ts';
import {getAttachmentRule} from './attachmentPolicy.ts';
export const VOICE_LIMITS=Object.freeze({maxSeconds:300,maxBytes:20*1024*1024});
export interface EncryptedVoiceReference {v:1;attachmentId:string;durationSeconds:number}
export function parseEncryptedVoice(value:unknown,files:readonly EncryptedAttachmentManifest[]):EncryptedVoiceReference|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const voice=value as Record<string,unknown>;
  if(Object.keys(voice).sort().join(',')!=='attachmentId,durationSeconds,v'||voice.v!==1||!isFileId(voice.attachmentId)||
      typeof voice.durationSeconds!=='number'||!Number.isFinite(voice.durationSeconds)||voice.durationSeconds<=0||voice.durationSeconds>VOICE_LIMITS.maxSeconds)return null;
  const file=files.find(file=>file.id===voice.attachmentId);
  if(!file||getAttachmentRule(file.name)?.kind!=='audio'||!file.mimeType.startsWith('audio/')||file.size>VOICE_LIMITS.maxBytes)return null;
  return {v:1,attachmentId:voice.attachmentId,durationSeconds:voice.durationSeconds};
}
