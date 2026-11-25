const {AuthError}=require('../auth/errors');
const {createSqliteRateLimiter}=require('../auth/rateLimiter');
const {createReactionRepository}=require('../database/reactionRepository');
const {isReactionEmoji}=require('../../../shared/reactionEmoji.ts');
const v=require('./validation');
const fail=(code,status)=>{throw new AuthError(code,status);};
function input(body){
    if(!body||Object.getPrototypeOf(body)!==Object.prototype||Reflect.ownKeys(body).sort().join(',')!=='emoji,expectedRevision,operationId'||
        (body.emoji!==null&&!isReactionEmoji(body.emoji))||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||
        typeof body.operationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.operationId))v.invalid();
    return body;
}
function createReactionService({db,auth,conversations,limiter=createSqliteRateLimiter(db)}){
    const reactions=createReactionRepository(db),messages=conversations.repositories.messages;
    const ack=(r,m)=>({conversationId:r.conversation_id,storageId:m.message_id,messageId:m.client_id,userId:r.actor_user_id,emoji:r.emoji,
        revision:r.result_revision,version:r.result_version,operationId:r.operation_id});
    return {
        rate(read,context,source){
            const buckets=[{key:`reactions:${read?'read':'write'}:${context.userId}`,limit:read?240:60,windowMs:60000}];
            if(!read)buckets.push({key:`reactions:source:${source}`,limit:240,windowMs:60000});
            const r=limiter.consume(buckets,auth.now());if(!r.allowed){const e=new AuthError('RATE_LIMITED',429);e.retryAfterSeconds=r.retryAfterSeconds;throw e;}
        },
        list(context,cid,query){
            v.conversationId(cid);v.query(query,['ids']);
            if(typeof query.ids!=='string'||query.ids.length>2000)v.invalid();
            const ids=query.ids.split(',');if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)v.invalid();ids.forEach(id=>v.identifier(id));
            return db.transaction(()=>{
                conversations.authorizeInTransaction(context,cid,{interaction:true});
                return {conversationId:cid,items:ids.map(id=>{
                    const m=messages.getAuthenticated(id);if(!m||m.conversation_id!==cid||m.envelope_version!==2)fail('NOT_FOUND',404);
                    return {storageId:id,messageId:m.client_id,state:m.deleted_at===null?'active':'deleted',version:reactions.version(cid,id),
                        actors:m.deleted_at===null?reactions.actors(cid,id).map(r=>({userId:r.user_id,emoji:r.emoji,revision:r.revision,updatedAt:r.updated_at})):[]};
                })};
            }).deferred();
        },
        set(context,proof,id,body,query){
            v.identifier(id);v.query(query,[]);const change=input(body),original=messages.getAuthenticated(id);if(!original)fail('NOT_FOUND',404);
            return conversations.withInteraction(context,proof,original.conversation_id,()=>{
                const m=messages.getAuthenticated(id),cid=m.conversation_id,previous=reactions.operation(context.userId,change.operationId);
                if(previous){
                    if(previous.conversation_id!==cid||previous.message_id!==id||previous.emoji!==change.emoji||previous.expected_revision!==change.expectedRevision)fail('IDEMPOTENCY_CONFLICT',409);
                    return ack(previous,m);
                }
                if(m.envelope_version!==2||m.message_type!=='text'||m.deleted_at!==null)fail('NOT_FOUND',404);
                const own=reactions.actor(cid,id,context.userId),revision=own?.revision??0,version=reactions.version(cid,id);
                if(revision!==change.expectedRevision)fail('CONFLICT',409);
                const changed=(own?.emoji??null)!==change.emoji,at=new Date(auth.now()).toISOString();
                if(changed){
                    if(revision>=Number.MAX_SAFE_INTEGER||version>=Number.MAX_SAFE_INTEGER)fail('SERVICE_UNAVAILABLE',503);
                    reactions.ensure(cid,id);reactions.advance(cid,id);reactions.set(cid,id,context.userId,change.emoji,revision+1,at);
                }
                reactions.record({user:context.userId,operationId:change.operationId,cid,id,emoji:change.emoji,expectedRevision:change.expectedRevision,
                    revision:revision+Number(changed),version:version+Number(changed),at});
                conversations.repositories.audit.insert({actor_user_id:context.userId,event_type:'message.reaction.changed',source:'messaging',subject_id:id,metadata:{operation:'reaction',outcome:'confirmed'}});
                return ack(reactions.operation(context.userId,change.operationId),m);
            });
        },
    };
}
module.exports={createReactionService};
