import {ATTACHMENT_LIMITS,getAttachmentRule,sanitizeAttachmentName,validateAttachmentFile} from './attachmentPolicy.ts';

/** Version 1 is protected inside V2 message content. None of these private fields are upload headers. */
export interface EncryptedAttachmentManifest {
  v: 1; id: string; conversationId: string; messageId: string; senderId: string;
  name: string; mimeType: string; size: number; key: string; iv: string; sha256: string;
}
export const isFileId=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
export function parseEncryptedAttachment(value:unknown):EncryptedAttachmentManifest|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const m=value as Record<string,unknown>;
  if(Object.keys(m).sort().join(',')!=='conversationId,id,iv,key,messageId,mimeType,name,senderId,sha256,size,v'||m.v!==1||
      !isFileId(m.id)||!isFileId(m.messageId)||typeof m.conversationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/.test(m.conversationId)||
      typeof m.senderId!=='string'||!m.senderId||m.senderId.length>256||/[\s\u0000-\u001f]/u.test(m.senderId)||
      typeof m.name!=='string'||sanitizeAttachmentName(m.name)!==m.name||typeof m.mimeType!=='string'||
      typeof m.size!=='number'||validateAttachmentFile({name:m.name,type:m.mimeType,size:m.size})||
      m.mimeType!==getAttachmentRule(m.name)?.mimeTypes[0]||
      typeof m.key!=='string'||!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(m.key)||
      typeof m.iv!=='string'||!/^[A-Za-z0-9_-]{16}$/.test(m.iv)||typeof m.sha256!=='string'||!/^[0-9a-f]{64}$/.test(m.sha256))return null;
  return m as unknown as EncryptedAttachmentManifest;
}
export function validAttachmentSet(items:unknown):items is EncryptedAttachmentManifest[]{
  return Array.isArray(items)&&items.length>0&&items.length<=ATTACHMENT_LIMITS.maxCount&&items.every(parseEncryptedAttachment)&&
    new Set(items.map(i=>i.id)).size===items.length&&items.reduce((n,i)=>n+i.size,0)<=ATTACHMENT_LIMITS.maxTotalSizeMb*1024*1024;
}
/** Canonical UTF-8 AES-GCM additionalData. The digest is verified separately to avoid a circular dependency. */
export function attachmentAad(m:Omit<EncryptedAttachmentManifest,'sha256'|'key'>):Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(['SecuBuzz:encrypted-file',1,m.conversationId,m.messageId,m.senderId,m.id,m.name,m.mimeType,m.size,m.iv]));
}
