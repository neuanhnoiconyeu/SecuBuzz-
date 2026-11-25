const {AuthError}=require('../auth/errors');
const {protocol}=require('../e2ee/protocol');
const {createKeyRepository}=require('../e2ee/repository');
const {identifier,invalid}=require('./validation');
const fail=(code,status)=>{throw new AuthError(code,status);};
function projectMessageRevisions(db,message){
    if(message.state!=='active')return message;
    const rows=db.prepare('SELECT * FROM MessageEditRevisions WHERE message_id=? ORDER BY revision').all(message.storageId);
    if(!rows.length)return message;const keys=createKeyRepository(db);
    return {...message,edit:{v:1,proofs:rows.map(r=>({proof:JSON.parse(r.proof_json),signer:keys.device(r.signer_device_key_id)})),envelope:JSON.parse(rows.at(-1).envelope_json)}};
}
function createMessageEdits({db,auth,conversations,verifyKeysInTransaction,verifyEnvelope,event}){
    const keys=createKeyRepository(db),messages=conversations.repositories.messages;
    const list=id=>db.prepare('SELECT * FROM MessageEditRevisions WHERE message_id=? ORDER BY revision').all(id);
    const receipt=r=>({storageId:r.message_id,messageId:JSON.parse(r.proof_json).messageId,conversationId:JSON.parse(r.proof_json).conversationId,
        senderId:r.sender_id,revision:r.revision,operationId:r.operation_id,proofHash:r.proof_hash});
    const authorize=(context,proof,id,work)=>{
        identifier(id);const original=messages.getAuthenticated(id);if(!original)fail('NOT_FOUND',404);
        return conversations.withInteraction(context,proof,original.conversation_id,capability=>{
            const row=messages.getAuthenticated(id);if(row.sender_id!==context.userId)fail('FORBIDDEN',403);
            if(row.deleted_at!==null||row.envelope_version!==2||db.prepare('SELECT 1 FROM Attachments WHERE message_id=? AND e2ee_version=1').get(id))fail('NOT_FOUND',404);
            return work(row,capability);
        });
    };
    return {
        project(message){return projectMessageRevisions(db,message);},
        async submit(context,proof,id,body){
            const actor=Object.freeze({...context}),csrf=Object.freeze({...proof});
            const initial=authorize(actor,csrf,id,(row,capability)=>{
                if(!protocol?.validateMessageEdit||!protocol.parseMessageEditProof)fail('FEATURE_UNAVAILABLE',503);
                const supplied=protocol.parseMessageEditProof(body?.proof);if(!supplied)invalid();
                const replay=db.prepare('SELECT * FROM MessageEditRevisions WHERE operation_id=?').get(supplied.operationId);
                const parsed=protocol.validateMessageEdit(body,keys.device(supplied.signerDeviceKeyId),Boolean(replay));if(!parsed)invalid();
                const p=parsed.proof;
                if(p.storageId!==id||p.messageId!==row.client_id||p.conversationId!==row.conversation_id||p.senderId!==row.sender_id||parsed.envelope.senderName!==row.sender_name)invalid();
                if(replay&&(replay.message_id!==id||replay.proof_hash!==parsed.hash))fail('IDEMPOTENCY_CONFLICT',409);
                return {parsed,capability,duplicate:replay?receipt(replay):null,actor:{userId:actor.userId,sessionId:actor.sessionId,displayName:row.sender_name}};
            });
            if(initial.duplicate)return {outcome:'duplicate',edit:initial.duplicate};
            await verifyEnvelope(initial.actor,initial.parsed.envelope,initial.capability);
            return authorize(actor,csrf,id,row=>{
                const {proof:p,envelope,hash}=initial.parsed;
                // Recheck signer and current key/device coverage after the asynchronous verifier boundary.
                if(!protocol.validateMessageEdit({proof:p,envelope},keys.device(p.signerDeviceKeyId)))fail('KEY_PROOF_INVALID',403);
                if(typeof verifyKeysInTransaction!=='function')fail('RECIPIENT_KEYS_UNAVAILABLE',503);
                verifyKeysInTransaction(envelope,{actorUserId:actor.userId,conversationId:row.conversation_id,
                    recipientIds:[row.receiver_id],fingerprint:p.envelopeHash});
                const replay=db.prepare('SELECT * FROM MessageEditRevisions WHERE operation_id=?').get(p.operationId);
                if(replay){if(replay.message_id!==id||replay.proof_hash!==hash)fail('IDEMPOTENCY_CONFLICT',409);return {outcome:'duplicate',edit:receipt(replay)};}
                const history=list(id),last=history.at(-1);
                if(p.revision!==(last?.revision??0)+1||p.previousHash!==(last?.proof_hash??row.fingerprint))fail('STALE_STATE',409);
                if(db.prepare('SELECT 1 FROM MessageEditRevisions WHERE key_id=? AND iv=?').get(p.keyId,envelope.encryption.iv)||
                    db.prepare('SELECT 1 FROM Messages WHERE envelope_version=2 AND key_id=? AND iv=?').get(p.keyId,envelope.encryption.iv))fail('KEY_PROOF_INVALID',400);
                const at=new Date(auth.now()).toISOString();
                db.prepare(`INSERT INTO MessageEditRevisions(message_id,revision,operation_id,sender_id,signer_device_key_id,previous_hash,proof_hash,key_id,iv,proof_json,envelope_json,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,p.revision,p.operationId,actor.userId,p.signerDeviceKeyId,p.previousHash,hash,p.keyId,envelope.encryption.iv,JSON.stringify(p),JSON.stringify(envelope),at);
                event(actor.userId,'edited',id);
                return {outcome:'created',edit:receipt(db.prepare('SELECT * FROM MessageEditRevisions WHERE operation_id=?').get(p.operationId))};
            });
        }
    };
}
module.exports={createMessageEdits,projectMessageRevisions};
