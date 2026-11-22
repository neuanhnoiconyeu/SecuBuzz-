/** Signed append-only edits; the original V2 wire envelope is never replaced. */
export const MAX_MESSAGE_EDITS = 20;
export const EDIT_CONTENT_PREFIX = '\u001eSecuBuzz:edit:1\n';
export interface EditCore {
  v:1; storageId:string; messageId:string; conversationId:string; senderId:string;
  revision:number; operationId:string; previousHash:string; keyId:string; signerDeviceKeyId:string; editedAt:string;
}
export interface EditProof extends EditCore { envelopeHash:string; signature:string }
const identifier=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(s);
export const editUuid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
export const editHash=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
export function parseEditCore(input:unknown):EditCore|null{
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const r=input as Record<string,unknown>;
  if(Object.keys(r).sort().join(',')!=='conversationId,editedAt,keyId,messageId,operationId,previousHash,revision,senderId,signerDeviceKeyId,storageId,v'||
    r.v!==1||!identifier(r.storageId)||typeof r.messageId!=='string'||!r.messageId||r.messageId.length>256||/[\s\u0000-\u001f\u007f]/u.test(r.messageId)||
    !identifier(r.conversationId)||!identifier(r.senderId)||!editUuid(r.operationId)||!editHash(r.previousHash)||
    !Number.isInteger(r.revision)||(r.revision as number)<1||(r.revision as number)>MAX_MESSAGE_EDITS||
    typeof r.keyId!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(r.keyId)||typeof r.signerDeviceKeyId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.signerDeviceKeyId)||
    typeof r.editedAt!=='string'||!Number.isFinite(Date.parse(r.editedAt))||new Date(r.editedAt).toISOString()!==r.editedAt)return null;
  return r as unknown as EditCore;
}
export function editCore(p:EditCore):EditCore{
  const {v,storageId,messageId,conversationId,senderId,revision,operationId,previousHash,keyId,signerDeviceKeyId,editedAt}=p;
  return {v,storageId,messageId,conversationId,senderId,revision,operationId,previousHash,keyId,signerDeviceKeyId,editedAt};
}
export function parseEditProof(input:unknown):EditProof|null{
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const r=input as Record<string,unknown>,{envelopeHash,signature,...core}=r;
  if(!parseEditCore(core)||!editHash(envelopeHash)||typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))return null;
  return r as unknown as EditProof;
}
export const editStatement=(p:EditCore&{envelopeHash:string}):string=>JSON.stringify(['SecuBuzz:message-edit',1,p.storageId,p.messageId,p.conversationId,p.senderId,p.revision,p.operationId,p.previousHash,p.keyId,p.signerDeviceKeyId,p.editedAt,p.envelopeHash]);
export const editProofStatement=(p:EditProof):string=>JSON.stringify([editStatement(p),p.signature]);
export function revisionEnvelopeStatement(e:{id:string;conversationId:string;senderId:string;senderName:string;timestamp:string;type:string;encryption:{version:number;algorithm:string;encoding:string;keyId:string;iv:string;ciphertext:string}}):string{
  const c=e.encryption;return JSON.stringify([e.id,e.conversationId,e.senderId,e.senderName,e.timestamp,e.type,c.version,c.algorithm,c.encoding,c.keyId,c.iv,c.ciphertext]);
}
