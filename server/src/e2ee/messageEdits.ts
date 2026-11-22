import {createHash} from 'node:crypto';
import {parseEditProof,editStatement,editProofStatement,type EditProof} from '../../../shared/messageRevisions.ts';
import {parseMessageEnvelopeV2,envelopeV2Fingerprint,type MessageEnvelopeV2} from './envelope.ts';
import {verifyStatementSignature} from './signatures.ts';
import {parseStoredDeviceKey} from './records.ts';

export const editProofHash=(p:EditProof):string=>createHash('sha256').update(editProofStatement(p)).digest('hex');
/** Syntax and signature validation only; DATA separately enforces active sender device/session/membership/CAS. */
export function validateMessageEdit(input:unknown,device:unknown,allowHistoricalDevice=false):{proof:EditProof;envelope:MessageEnvelopeV2;hash:string}|null{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='envelope,proof')return null;
  const r=input as {proof:unknown;envelope:unknown},p=parseEditProof(r.proof),e=parseMessageEnvelopeV2(r.envelope),d=parseStoredDeviceKey(device);
  if(!p||!e||!d||(!allowHistoricalDevice&&d.status!=='active')||d.userId!==p.senderId||d.deviceKeyId!==p.signerDeviceKeyId||e.id!==p.operationId||e.conversationId!==p.conversationId||
    e.senderId!==p.senderId||e.timestamp!==p.editedAt||e.encryption.keyId!==p.keyId||envelopeV2Fingerprint(e)!==p.envelopeHash||
    !verifyStatementSignature(d.signingPublicKey,editStatement(p),p.signature))return null;
  return {proof:Object.freeze({...p}),envelope:e,hash:editProofHash(p)};
}
