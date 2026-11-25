import {attachmentAad,parseEncryptedAttachment,type EncryptedAttachmentManifest} from '../../../shared/encryptedAttachments';
import {getAttachmentRule,validateAttachmentFile} from '../../../shared/attachmentPolicy';
import {matchesAttachmentSignature} from '../../../shared/attachmentSignatures';
import {readAttachmentBytes} from './attachmentFiles';
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
export async function fileDigest(bytes:ArrayBuffer):Promise<string>{return hex(await crypto.subtle.digest('SHA-256',bytes));}
export async function encryptAttachment(file:File,scope:{conversationId:string;messageId:string;senderId:string;id:string}):Promise<{manifest:EncryptedAttachmentManifest;bytes:ArrayBuffer}>{
  const rule=getAttachmentRule(file.name),invalid=validateAttachmentFile(file);
  if(invalid||!rule)throw new Error(invalid??'Unsupported file.');
  const plain=await readAttachmentBytes(file);
  if(!matchesAttachmentSignature(file.name,new Uint8Array(plain.slice(0,4096))))throw new Error('The file content does not match its type.');
  const raw=crypto.getRandomValues(new Uint8Array(32));
  try{
    const fields={v:1 as const,...scope,name:file.name,mimeType:rule.mimeTypes[0]!,size:file.size,iv:b64(crypto.getRandomValues(new Uint8Array(12)))};
    const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
    const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv:unb64(fields.iv),additionalData:attachmentAad(fields),tagLength:128},key,plain);
    const manifest={...fields,key:b64(raw),sha256:await fileDigest(bytes)};
    if(!parseEncryptedAttachment(manifest))throw new Error('Invalid encrypted attachment.');
    return {manifest,bytes};
  }finally{raw.fill(0);new Uint8Array(plain).fill(0);}
}
export async function decryptAttachment(manifest:EncryptedAttachmentManifest,bytes:ArrayBuffer):Promise<Blob>{
  if(!parseEncryptedAttachment(manifest)||bytes.byteLength!==manifest.size+16||await fileDigest(bytes)!==manifest.sha256)throw new Error('Attachment integrity verification failed.');
  const raw=unb64(manifest.key);
  let plain:ArrayBuffer;
  try{
    const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
    plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(manifest.iv),additionalData:attachmentAad(manifest),tagLength:128},key,bytes);
  }catch{throw new Error('Attachment integrity verification failed.');}finally{raw.fill(0);}
  if(plain.byteLength!==manifest.size||!matchesAttachmentSignature(manifest.name,new Uint8Array(plain.slice(0,4096)))){
    new Uint8Array(plain).fill(0);throw new Error('The decrypted file does not match its declared type.');
  }
  const blob=new Blob([plain],{type:manifest.mimeType});new Uint8Array(plain).fill(0);return blob;
}
