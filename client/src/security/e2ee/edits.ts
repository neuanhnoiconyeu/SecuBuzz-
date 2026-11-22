import {EDIT_CONTENT_PREFIX,editCore,editProofStatement,editStatement,revisionEnvelopeStatement,type EditCore} from '../../../../shared/messageRevisions';
import {decodeAuthenticatedContent,encodeAuthenticatedContent} from '@/messaging/authenticatedContent';
import {E2eeError,type StoredMessage,type EnvelopeV2,type DirectConversation,type KeyEpoch,type DeviceRecord} from './model';
import {parseEnvelope,parseEpoch,verifyDevice,verifySignature,encode,exact} from './protocol';
import {decryptV2} from './messages';
import type {BrowserKeyStore} from './storage';

export const editDigest=async(text:string):Promise<string>=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export const originalWire=(m:StoredMessage):EnvelopeV2=>parseEnvelope({id:m.id,conversationId:m.conversationId,senderId:m.senderId,senderName:m.senderName,timestamp:m.timestamp,type:m.type,encryption:m.encryption});
export const messageEditVersion=(m:StoredMessage):number=>m.edit?.proofs.length??0;
export async function messageEditHead(m:StoredMessage):Promise<string>{return m.edit?editDigest(editProofStatement(m.edit.proofs.at(-1)!.proof)):editDigest(revisionEnvelopeStatement(originalWire(m)));}
export function editedContent(previous:string,text:string):string{
  const content=decodeAuthenticatedContent(previous);
  if(!content||content.attachments?.length||content.voice||!text.trim())throw new E2eeError('invalid_message');
  return encodeAuthenticatedContent({...content,text});
}
function sameMetadata(original:string,next:string):boolean{
  const a=decodeAuthenticatedContent(original),b=decodeAuthenticatedContent(next);
  if(!a||!b||a.attachments?.length||a.voice||b.attachments?.length||b.voice)return false;
  const {text:_a,...am}=a,{text:_b,...bm}=b;return JSON.stringify(am)===JSON.stringify(bm);
}
export const protectedEditContent=(core:EditCore,content:string):string=>EDIT_CONTENT_PREFIX+JSON.stringify({core:editCore(core),content});

/** Verifies signed history, epoch/device ownership and AEAD content before persisting a monotonic head. */
export async function verifyEditedContent(message:StoredMessage,original:string,conversation:DirectConversation,store:BrowserKeyStore,keyFor:(keyId:string)=>Promise<CryptoKey>):Promise<string>{
  const hashes=[await editDigest(revisionEnvelopeStatement(originalWire(message)))];let text=original;
  const snapshot=message.edit;
  if(snapshot){
    for(const [i,{proof:p,signer:raw} ]of snapshot.proofs.entries()){
      if(p.revision!==i+1||p.previousHash!==hashes.at(-1)||p.storageId!==message.storageId||p.messageId!==message.id||p.conversationId!==message.conversationId||p.senderId!==message.senderId)throw new E2eeError('invalid_proof');
      const signer=await verifyDevice(raw);if(signer.userId!==message.senderId||signer.deviceKeyId!==p.signerDeviceKeyId)throw new E2eeError('invalid_proof');
      await keyFor(p.keyId);
      const cached=await store.get<{epoch:KeyEpoch;creator:DeviceRecord}>('epoch',JSON.stringify([conversation.id,p.keyId]));
      if(!cached)throw new E2eeError('missing_key');const epoch=parseEpoch(cached.epoch,conversation.id);
      if(!epoch.wraps.some(w=>w.recipientUserId===message.senderId&&w.recipientDeviceKeyId===signer.deviceKeyId))throw new E2eeError('invalid_proof');
      await verifySignature(signer.signingPublicKey,editStatement(p),p.signature);hashes.push(await editDigest(editProofStatement(p)));
    }
    const p=snapshot.proofs.at(-1)!.proof,e=parseEnvelope(snapshot.envelope);
    if(e.id!==p.operationId||e.conversationId!==message.conversationId||e.senderId!==message.senderId||e.senderName!==message.senderName||e.timestamp!==p.editedAt||e.encryption.keyId!==p.keyId||await editDigest(revisionEnvelopeStatement(e))!==p.envelopeHash)throw new E2eeError('invalid_proof');
    const plain=await decryptV2(await keyFor(p.keyId),e);
    if(!plain.startsWith(EDIT_CONTENT_PREFIX))throw new E2eeError('invalid_message');
    let payload:Record<string,unknown>;try{payload=exact(JSON.parse(plain.slice(EDIT_CONTENT_PREFIX.length)),['core','content']);}catch{throw new E2eeError('invalid_message');}
    if(JSON.stringify(payload.core)!==JSON.stringify(editCore(p))||typeof payload.content!=='string'||!sameMetadata(original,payload.content))throw new E2eeError('invalid_proof');
    text=payload.content;
  }
  if(!await store.observeRevision(message.storageId,hashes))throw new E2eeError('invalid_proof');return text;
}
