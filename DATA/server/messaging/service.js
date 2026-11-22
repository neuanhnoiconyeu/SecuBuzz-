const { randomUUID } = require('node:crypto');
const { createSqliteRateLimiter } = require('../auth/rateLimiter');
const { AuthError } = require('../auth/errors');
const v = require('./validation');
const {createMessageEdits}=require('./edits');
const missing=()=>{throw new AuthError('NOT_FOUND',404);};
const denied=()=>{throw new AuthError('FORBIDDEN',403);};
const conflict=()=>{throw new AuthError('IDEMPOTENCY_CONFLICT',409);};
function projectBase(row) {
    return {storageId:row.message_id,id:row.client_id,conversationId:row.conversation_id,senderId:row.sender_id,senderName:row.sender_name,
        timestamp:row.client_timestamp,type:'text',encryption:row.deleted_at===null?{version:row.envelope_version,algorithm:row.algorithm,encoding:row.encoding,
            ...(row.envelope_version===2?{keyId:row.key_id}:{}),iv:row.iv,ciphertext:row.ciphertext}:null,
        storedAt:row.created_at,updatedAt:row.updated_at,sequence:row.message_seq,revision:row.revision,state:row.deleted_at===null?'active':'deleted',deletedAt:row.deleted_at};
}
function createMessageService({db,auth,conversations,attachments=null,recipientKeyVerifier=null,verifyKeysInTransaction=null,verifierTimeoutMs=2000,limiter=createSqliteRateLimiter(db)}) {
    if(!Number.isInteger(verifierTimeoutMs)||verifierTimeoutMs<10||verifierTimeoutMs>4000)throw new TypeError('Invalid verifier deadline');
    const repositories=conversations.repositories;const messages=repositories.messages;let pending=0;
    const read=(context,id,work)=>db.transaction(()=>work(conversations.authorizeInTransaction(context,id))).deferred();
    const event=(actor,operation,id)=>repositories.audit.insert({actor_user_id:actor,event_type:`message.${operation}`,source:'messaging',subject_id:id,metadata:{operation,outcome:'confirmed'}});
    const edits=createMessageEdits({db,auth,conversations,verifyKeysInTransaction,verifyEnvelope:verify,event});
    const project=row=>edits.project(projectBase(row));
    function stored(context,id,interaction,work) {
        v.identifier(id);const row=messages.getAuthenticated(id);if(!row)missing();
        const capability=conversations.authorizeInTransaction(context,row.conversation_id,{interaction});
        return work(row,capability);
    }
    async function verify(actor,envelope,capability) {
        if(!recipientKeyVerifier||typeof recipientKeyVerifier.verifyEnvelope!=='function'||(auth.config.production&&recipientKeyVerifier.testOnly===true))throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE',503);
        if(pending>=32)throw new AuthError('SERVICE_UNAVAILABLE',503);
        pending++;let timer;
        try{
            const result=await Promise.race([Promise.resolve().then(()=>recipientKeyVerifier.verifyEnvelope(actor,envelope,
                Object.freeze({conversationId:capability.conversationId,recipientIds:Object.freeze([capability.recipientId]),fingerprint:v.fingerprint(envelope)}))),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AuthError('RECIPIENT_KEYS_UNAVAILABLE',503)),verifierTimeoutMs);})]);
            if(!result||typeof result!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(result))||
                Reflect.ownKeys(result).length!==1||!Object.hasOwn(result,'verified')||result.verified!==true)throw new AuthError('RECIPIENT_KEYS_UNVERIFIED',403);
        }catch(error){if(error instanceof AuthError&&['RECIPIENT_KEYS_UNAVAILABLE','RECIPIENT_KEYS_UNVERIFIED'].includes(error.code))throw error;throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE',503);}
        finally{clearTimeout(timer);pending--;}
    }
    const service={
        repositories,
        rate(operation,context,source){
            const limits={history:120,submit:60,delete:60,read:120,edit:60};const limit=limits[operation];if(!limit)throw new TypeError('Unknown operation');
            const buckets=[{key:`messages:${operation}:${context.userId}`,limit,windowMs:60000}];
            if(operation!=='history')buckets.push({key:`messages:mutations-source:${source}`,limit:240,windowMs:60000});
            const result=limiter.consume(buckets,auth.now());if(!result.allowed){const error=new AuthError('RATE_LIMITED',429);error.retryAfterSeconds=result.retryAfterSeconds;throw error;}
        },
        async submit(context,proof,id,input){
            v.conversationId(id);const frozen=Object.freeze({userId:context.userId,sessionId:context.sessionId});const sessionProof=Object.freeze({...proof});
            const envelope=v.envelope(input,frozen,id);const fingerprint=v.fingerprint(envelope);
            const preparation=conversations.withInteraction(frozen,sessionProof,id,capability=>({capability,
                actor:Object.freeze({userId:frozen.userId,sessionId:frozen.sessionId,displayName:auth.repository.byId(frozen.sessionId).display_name})}));
            await verify(preparation.actor,envelope,preparation.capability);
            // No SQLite transaction crosses the asynchronous Security-team adapter boundary.
            return conversations.withInteraction(frozen,sessionProof,id,capability=>{
                if(envelope.encryption.version===2){
                    if(typeof verifyKeysInTransaction!=='function')throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE',503);
                    verifyKeysInTransaction(envelope,{actorUserId:frozen.userId,conversationId:id,recipientIds:[capability.recipientId],fingerprint});
                }
                const existing=messages.findAuthenticatedClient(id,envelope.id);
                if(existing){if(existing.sender_id!==frozen.userId||existing.fingerprint!==fingerprint)conflict();return {outcome:'duplicate',message:project(existing)};}
                attachments?.checkMessage(id,envelope.id,frozen.userId,envelope.encryption.version);
                if(auth.repository.byId(frozen.sessionId).display_name!==envelope.senderName)throw new AuthError('FORBIDDEN',403,['senderName']);
                const high=messages.highWater(id);if(high>=Number.MAX_SAFE_INTEGER)throw new AuthError('SERVICE_UNAVAILABLE',503);
                const at=new Date(auth.now()).toISOString();
                const row=messages.insertAuthenticated({message_id:randomUUID(),conversation_id:id,sender_id:frozen.userId,receiver_id:capability.recipientId,
                    ciphertext:envelope.encryption.ciphertext,iv:envelope.encryption.iv,envelope_version:envelope.encryption.version,
                    ...(envelope.encryption.version===2?{key_id:envelope.encryption.keyId}:{}),encoding:'base64',sender_name:envelope.senderName,
                    client_timestamp:envelope.timestamp,message_type:'text',fingerprint,client_id:envelope.id,message_seq:high+1,created_at:at});
                attachments?.attachMessage(id,envelope.id,frozen.userId,row.message_id);
                db.prepare('UPDATE Conversations SET updated_at=? WHERE conversation_id=?').run(at,id);event(frozen.userId,'stored',row.message_id);
                return {outcome:'created',message:project(row)};
            });
        },
        history(context,id,input){
            v.conversationId(id);const pagination=v.page(input,context.userId,id);
            return read(context,id,()=>{
                const highWater=pagination.highWater??messages.highWater(id);
                const rows=messages.history(id,{limit:pagination.limit,highWater,before:pagination.before});const items=rows.slice(0,pagination.limit);
                return {items:items.map(project),nextCursor:rows.length>pagination.limit?Buffer.from(JSON.stringify({v:1,context:pagination.context,highWater,before:items.at(-1).message_seq})).toString('base64url'):null};
            });
        },
        remove(context,proof,id,body){
            v.emptyBody(body);v.identifier(id);
            const original=messages.getAuthenticated(id);if(!original)missing();
            return conversations.withInteraction(context,proof,original.conversation_id,()=>stored(context,id,true,row=>{
                if(row.sender_id!==context.userId)denied();
                if(row.deleted_at===null){messages.tombstone(id,new Date(auth.now()).toISOString());event(context.userId,'deleted',id);}
                return {message:project(messages.getAuthenticated(id))};
            }));
        },
        readReceipt(context,proof,id,body){v.emptyBody(body);return service.recordReceipt(context,proof,id,'read');},
        recordReceipt(context,proof,id,status,observedAt){
            if(!['read','delivered'].includes(status)||(observedAt!==undefined&&(!(observedAt instanceof Date)||!Number.isFinite(observedAt.getTime()))))v.invalid();
            v.identifier(id);const original=messages.getAuthenticated(id);if(!original)missing();
            return conversations.withInteraction(context,proof,original.conversation_id,()=>stored(context,id,true,row=>{
                if(row.sender_id===context.userId||row.receiver_id!==context.userId)denied();
                const existing=repositories.receipts.get(row.conversation_id,id,context.userId,status);
                if(!existing&&row.deleted_at!==null)missing();
                if(!existing){repositories.receipts.insert({conversation_id:row.conversation_id,message_id:id,user_id:context.userId,status,observed_at:(observedAt??new Date(auth.now())).toISOString()});event(context.userId,status,id);}
                const receipt=existing??repositories.receipts.get(row.conversation_id,id,context.userId,status);
                return {outcome:existing?'duplicate':'created',receipt:{conversationId:row.conversation_id,storageId:id,messageId:row.client_id,userId:context.userId,status,observedAt:receipt.observed_at,recordedAt:receipt.recorded_at}};
            }));
        },
        edit(context,proof,id,body){return edits.submit(context,proof,id,body);},
        // A trusted composition must bind a DB-2 actor/proof; never infer it from envelope.senderId.
        bindStore(context,proof){
            const bound=Object.freeze({userId:context.userId,sessionId:context.sessionId});const csrf=Object.freeze({...proof});
            return {
                async storeMessage(request){
                    if(!request||Reflect.ownKeys(request).sort().join(',')!=='envelope,fingerprint,receivedAt'||!(request.receivedAt instanceof Date)||!Number.isFinite(request.receivedAt.getTime())||request.fingerprint!==v.fingerprint(v.envelope(request.envelope,bound,request.envelope?.conversationId)))throw new AuthError('VALIDATION_ERROR',400);
                    try{const result=await service.submit(bound,csrf,request.envelope.conversationId,request.envelope);return {outcome:result.outcome,storedAt:new Date(result.message.storedAt)};}
                    catch(error){if(error instanceof AuthError&&error.code==='IDEMPOTENCY_CONFLICT')return {outcome:'conflict'};throw error;}
                },
                async findMessage(conversationId,messageId){v.conversationId(conversationId);v.wireId(messageId);return read(bound,conversationId,()=>{const row=messages.findAuthenticatedClient(conversationId,messageId);return row&&row.deleted_at===null?{conversationId,messageId:row.client_id,senderId:row.sender_id}:null;});},
                async recordReceipt(receipt){
                    if(!receipt||receipt.userId!==bound.userId||!['read','delivered'].includes(receipt.status))throw new AuthError('FORBIDDEN',403);
                    const row=read(bound,receipt.conversationId,()=>messages.findAuthenticatedClient(receipt.conversationId,receipt.messageId));if(!row)missing();
                    const result=service.recordReceipt(bound,csrf,row.message_id,receipt.status,receipt.observedAt);return {outcome:result.outcome,recordedAt:new Date(result.receipt.recordedAt)};
                }
            };
        }
    };
    return service;
}
module.exports={createMessageService,projectMessage:projectBase};
