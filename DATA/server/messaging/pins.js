const { AuthError }=require('../auth/errors');
const { createSqliteRateLimiter }=require('../auth/rateLimiter');
const { createPinRepository }=require('../database/pinRepository');
const { projectMessage }=require('./service');
const {projectMessageRevisions}=require('./edits');
const v=require('./validation');
const MAX_PINS=50;
const operationId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail=(code,status)=>{throw new AuthError(code,status);};
function input(body) {
    if(!body||Object.getPrototypeOf(body)!==Object.prototype||Reflect.ownKeys(body).sort().join(',')!=='expectedVersion,operationId,pinned'||
        typeof body.pinned!=='boolean'||!operationId(body.operationId)||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<0)v.invalid();
    return body;
}
function createPinService({db,auth,conversations,limiter=createSqliteRateLimiter(db)}) {
    const pins=createPinRepository(db), messages=conversations.repositories.messages;
    const ack=(row,m)=>({conversationId:row.conversation_id,storageId:m.message_id,messageId:m.client_id,
        pinned:Boolean(row.pinned),version:row.result_version,operationId:row.operation_id});
    return {
        rate(read,context,source) {
            const buckets=[{key:`pins:${read?'read':'write'}:${context.userId}`,limit:read?120:60,windowMs:60000}];
            if(!read)buckets.push({key:`pins:source:${source}`,limit:240,windowMs:60000});
            const result=limiter.consume(buckets,auth.now());
            if(!result.allowed){const e=new AuthError('RATE_LIMITED',429);e.retryAfterSeconds=result.retryAfterSeconds;throw e;}
        },
        list(context,cid,query) {
            v.conversationId(cid);v.query(query,[]);
            return db.transaction(()=>{
                conversations.authorizeInTransaction(context,cid,{interaction:true});
                return {conversationId:cid,version:pins.version(cid),items:pins.list(cid).map(row=>({message:projectMessageRevisions(db,projectMessage(row)),pinnedBy:row.pinned_by,pinnedAt:row.pinned_at}))};
            }).deferred();
        },
        set(context,proof,id,body,query) {
            v.identifier(id);v.query(query,[]);const change=input(body);
            const original=messages.getAuthenticated(id);if(!original)fail('NOT_FOUND',404);
            return conversations.withInteraction(context,proof,original.conversation_id,()=>{
                const row=messages.getAuthenticated(id),cid=row.conversation_id;
                const previous=pins.operation(context.userId,change.operationId);
                if(previous){
                    if(previous.conversation_id!==cid||previous.message_id!==id||Boolean(previous.pinned)!==change.pinned||previous.expected_version!==change.expectedVersion)fail('IDEMPOTENCY_CONFLICT',409);
                    return ack(previous,row);
                }
                if(row.envelope_version!==2||row.message_type!=='text'||(change.pinned&&row.deleted_at!==null))fail('NOT_FOUND',404);
                const version=pins.version(cid);
                if(version!==change.expectedVersion)fail('CONFLICT',409);
                const current=pins.has(cid,id),at=new Date(auth.now()).toISOString();
                if(current!==change.pinned){
                    if(version>=Number.MAX_SAFE_INTEGER)fail('SERVICE_UNAVAILABLE',503);
                    if(change.pinned&&pins.list(cid).length>=MAX_PINS)fail('CONFLICT',409);
                    pins.ensure(cid);pins.advance(cid);
                    if(change.pinned)pins.add(cid,id,context.userId,at);else pins.remove(cid,id);
                }
                pins.record({actor:context.userId,operationId:change.operationId,cid,id,pinned:change.pinned,expectedVersion:change.expectedVersion,version:pins.version(cid),at});
                conversations.repositories.audit.insert({actor_user_id:context.userId,event_type:change.pinned?'message.pinned':'message.unpinned',source:'messaging',subject_id:id,
                    metadata:{operation:change.pinned?'pin':'unpin',outcome:'confirmed'}});
                return ack(pins.operation(context.userId,change.operationId),row);
            });
        },
    };
}
module.exports={createPinService};
