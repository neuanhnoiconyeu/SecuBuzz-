const {createHash}=require('node:crypto');
const {protocol}=require('./protocol');
const {createKeyRepository}=require('./repository');
const {createSqliteKeyDirectory}=require('./directory');
const {createSqliteRateLimiter}=require('../auth/rateLimiter');
const {AuthError}=require('../auth/errors');
const {query,emptyBody,invalid}=require('../social/validation');
const {conversationId}=require('../conversations/validation');
const unavailable=()=>{throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE',503);};
const notFound=()=>{throw new AuthError('NOT_FOUND',404);};
const errors={invalid_registration:['VALIDATION_ERROR',400],invalid_publication:['VALIDATION_ERROR',400],
    stale_registration:['KEY_PROOF_INVALID',400],stale_publication:['KEY_PROOF_INVALID',400],signature_invalid:['KEY_PROOF_INVALID',400],
    device_limit:['DEVICE_LIMIT',409],epoch_out_of_order:['RECIPIENT_KEYS_CHANGED',409],recipient_set_mismatch:['RECIPIENT_KEYS_CHANGED',409],
    creator_device_unknown:['RECIPIENT_KEYS_CHANGED',409],key_id_conflict:['RECIPIENT_KEYS_CHANGED',409],recipient_without_devices:['RECIPIENT_KEYS_UNAVAILABLE',409],
    not_participant:['NOT_FOUND',404],unsupported_conversation:['NOT_FOUND',404],not_found:['NOT_FOUND',404]};
function refuse(reason){const error=new AuthError(...(errors[reason]??['KEY_CONFLICT',409]));error.protocolReason=reason;throw error;}
function createKeyService({db,auth,conversations,limiter=createSqliteRateLimiter(db)}){
    const repository=createKeyRepository(db),directory=createSqliteKeyDirectory(db);
    const ready=()=>{if(!protocol)unavailable();};
    const active=context=>{const result=auth.checkSession(context);if(result.status!=='active')throw new AuthError(result.status==='expired'?'SESSION_EXPIRED':'UNAUTHENTICATED',401);};
    function write(context,proof,work){ready();return db.transaction(()=>{
        active(context);if(!proof||proof.type!=='session'||proof.sessionId!==context.sessionId||proof.userId!==context.userId)throw new AuthError('CSRF_INVALID',403);
        auth.repository.verifyProof(proof,auth.now());return work();
    }).immediate();}
    const audit=(user,operation,subject)=>conversations.repositories.audit.insert({actor_user_id:user,event_type:'keys.'+operation,source:'e2ee',subject_id:subject,metadata:{operation,outcome:'confirmed'}});
    const verifier=protocol?protocol.createRecipientKeyVerifier({directory}):null;
    return {
        repository,directory,verifier,
        verifyInTransaction(envelope,context){ready();if(!db.inTransaction)throw new TypeError('Key recheck requires a transaction');
            let state;try{state=directory.read(context.conversationId,envelope.encryption.keyId);}catch{unavailable();}
            if(!protocol.verifyRecipientKeysSync(envelope,context,state))throw new AuthError('RECIPIENT_KEYS_UNVERIFIED',403);
        },
        rate(mutation,context,source){const buckets=[{key:'keys:'+(mutation?'write:':'read:')+context.userId,limit:mutation?30:120,windowMs:60000}];
            if(mutation)buckets.push({key:'keys:write-source:'+source,limit:120,windowMs:60000});
            const result=limiter.consume(buckets,auth.now());if(!result.allowed){const e=new AuthError('RATE_LIMITED',429);e.retryAfterSeconds=result.retryAfterSeconds;throw e;}},
        register(context,proof,body){ready();const validated=protocol.validateDeviceRegistration(body,{userId:context.userId});if(!validated.ok)refuse(validated.reason);
            return write(context,proof,()=>{const r=validated.value,plan=protocol.planDeviceRegistration(r,{existingKey:repository.device(r.deviceKeyId),deviceHistory:repository.history(r.deviceId),activeDevicesOfUser:repository.active([context.userId])},{nowMs:auth.now()});
                if(plan.action==='refuse')refuse(plan.reason);if(plan.action==='duplicate')return {created:false,device:repository.device(r.deviceKeyId)};
                const at=new Date(auth.now()).toISOString();repository.status(plan.supersede,'superseded',at);const device=repository.insertDevice(plan.record,at);audit(context.userId,'device.registered',r.deviceKeyId);return {created:true,device};});},
        list(context,input){ready();query(input,[]);return db.transaction(()=>{active(context);return {items:repository.list(context.userId)};}).deferred();},
        revoke(context,proof,id,body){emptyBody(body);return write(context,proof,()=>{const plan=protocol.planDeviceRevocation(context.userId,id,repository.history(id));if(plan.action==='refuse')refuse(plan.reason);
            if(plan.action==='unchanged')return {outcome:'unchanged'};repository.status(plan.deviceKeyIds,'revoked',new Date(auth.now()).toISOString());audit(context.userId,'device.revoked',id);return {outcome:'revoked'};});},
        state(context,id,input){ready();conversationId(id);query(input,['cursor']);
            const scope=createHash('sha256').update(JSON.stringify(['keys',context.userId,id])).digest('hex');let before=1000000001;
            if(input.cursor!==undefined){const raw=input.cursor;if(raw.length>512||!/^[A-Za-z0-9_-]+$/.test(raw)||Buffer.from(raw,'base64url').toString('base64url')!==raw)invalid('cursor');
                let p;try{p=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{invalid('cursor');}
                if(!p||Object.keys(p).sort().join(',')!=='before,context,v'||p.v!==1||p.context!==scope||!Number.isSafeInteger(p.before)||p.before<1||p.before>1000000000)invalid('cursor');before=p.before;}
            return db.transaction(()=>{const c=conversations.authorizeInTransaction(context,id),epochs=repository.epochs(id,before),visible=epochs.slice(0,20);
                return {conversationId:id,participantIds:c.participantIds,devices:repository.active(c.participantIds),currentEpoch:repository.current(id),epochs:visible,
                    cursor:epochs.length>20?Buffer.from(JSON.stringify({v:1,context:scope,before:visible.at(-1).epoch})).toString('base64url'):null};}).deferred();},
        epoch(context,id,key,input){ready();conversationId(id);query(input,[]);if(!/^[A-Za-z0-9_-]{22}$/.test(key)||Buffer.from(key,'base64url').toString('base64url')!==key)invalid('keyId');
            return db.transaction(()=>{conversations.authorizeInTransaction(context,id);const epoch=repository.epoch(id,key);if(!epoch)notFound();return {epoch};}).deferred();},
        publish(context,proof,id,body){ready();conversationId(id);return conversations.withInteraction(context,proof,id,c=>{
            const plan=protocol.planEpochPublication(body,{actorUserId:context.userId,conversationId:id,participantIds:c.participantIds,activeDevices:repository.active(c.participantIds),currentEpoch:repository.current(id),existingEpoch:repository.epoch(id,typeof body?.keyId==='string'?body.keyId:''),nowMs:auth.now()});
            if(plan.action==='refuse')refuse(plan.reason);if(plan.action==='duplicate')return {created:false,epoch:repository.epoch(id,plan.epoch.keyId)};
            const epoch=repository.insertEpoch(plan.epoch,new Date(auth.now()).toISOString());audit(context.userId,'epoch.published',epoch.keyId);return {created:true,epoch};});}
    };
}
module.exports={createKeyService};
