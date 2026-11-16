const { createSocialRepository } = require('../database/socialRepository');
const { createSqliteRateLimiter } = require('../auth/rateLimiter');
const { AuthError } = require('../auth/errors');
const v = require('./validation');
const notFound = () => { throw new AuthError('NOT_FOUND',404); };
const forbidden = () => { throw new AuthError('FORBIDDEN',403); };

function timestamp(value) {
    const text=typeof value==='string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ','T')+'Z' : value;
    const parsed=Date.parse(text);
    if (!Number.isFinite(parsed)) throw new AuthError('INTERNAL_ERROR',500);
    return new Date(parsed).toISOString();
}
function project(row) {
    return {id:row.conversation_id,type:'direct',participants:[
        {id:row.dm_user_low,username:row.low_username,displayName:row.low_display_name,avatar:row.low_avatar},
        {id:row.dm_user_high,username:row.high_username,displayName:row.high_display_name,avatar:row.high_avatar}],
    createdAt:timestamp(row.created_at),updatedAt:timestamp(row.updated_at),interactionAllowed:Boolean(row.interaction_allowed)};
}

/** Conversation policy over the existing injected DAL; no messages, sockets or second store. */
function createConversationService({db,auth,limiter=createSqliteRateLimiter(db)}) {
    const social=createSocialRepository(db);
    const repositories=social.repositories;
    const conversations=repositories.conversations;
    function activeContext(context) {
        const result=auth.checkSession({sessionId:context.sessionId,userId:context.userId});
        if (result.status!=='active') throw new AuthError(result.status==='expired' ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED',401);
    }
    function read(context,work) { return social.read(()=>{activeContext(context);return work(context.userId);}); }
    function write(context,proof,work) {
        return social.write(()=>{
            activeContext(context);
            if (!proof || proof.type!=='session' || proof.sessionId!==context.sessionId || proof.userId!==context.userId) throw new AuthError('CSRF_INVALID',403);
            auth.repository.verifyProof(proof,auth.now());
            return work(context.userId);
        });
    }
    function authorized(actor,id,interaction=false) {
        const row=conversations.getDirectForUser(actor,id);
        if (!row) notFound();
        if (interaction && !row.interaction_allowed) forbidden();
        return row;
    }
    function authorizeInTransaction(context,id,{interaction=false}={}) {
        if (!db.inTransaction) throw new TypeError('Conversation authorization requires the caller transaction.');
        v.conversationId(id); activeContext(context);
        const row=authorized(context.userId,id,interaction);
        return {conversationId:row.conversation_id,type:'direct',participantIds:[row.dm_user_low,row.dm_user_high],
            recipientId:row.dm_user_low===context.userId ? row.dm_user_high : row.dm_user_low,interactionAllowed:Boolean(row.interaction_allowed)};
    }
    function synchronous(work,...args) {
        if (typeof work!=='function' || work.constructor?.name==='AsyncFunction') throw new TypeError('Conversation work must be synchronous.');
        const result=work(...args);
        if (result && typeof result.then==='function') throw new TypeError('Conversation work must be synchronous.');
        return result;
    }
    return {
        repositories,
        // DB-4B can re-use this policy within its own immediate message transaction.
        authorizeInTransaction,
        withInteraction(context,proof,id,work) {
            if (typeof work!=='function' || work.constructor?.name==='AsyncFunction') throw new TypeError('Conversation work must be synchronous.');
            return write(context,proof,()=>synchronous(work,authorizeInTransaction(context,id,{interaction:true}),repositories));
        },
        rate(operation,context,source) {
            const buckets=operation==='read' ? [{key:`conversations:read:${context.userId}`,limit:120,windowMs:60000}] :
                [{key:`conversations:write:${context.userId}`,limit:60,windowMs:60000},{key:`conversations:write-source:${source}`,limit:120,windowMs:60000}];
            const result=limiter.consume(buckets,auth.now());
            if (!result.allowed) {const error=new AuthError('RATE_LIMITED',429);error.retryAfterSeconds=result.retryAfterSeconds;throw error;}
        },
        createDirect(context,proof,body) {
            const recipient=v.recipient(body);
            if (recipient===context.userId) v.invalid('recipientId');
            return write(context,proof,actor=>{
                if (!social.active(recipient) || social.isBlocked(actor,recipient)) notFound();
                let existing=conversations.findDirect(actor,recipient);
                const created=!existing;
                const authenticated=existing?.origin==='authenticated';
                if (!authenticated && !social.friendship(actor,recipient)) forbidden();
                if (existing) {
                    // Never repair missing/left members or revive an archive through creation.
                    const members=repositories.members.list(existing.conversation_id);
                    if (existing.archived_at!==null || members.length!==2 || members.some(member=>member.left_at!==null || member.role!=='member') ||
                        !members.some(member=>member.user_id===actor) || !members.some(member=>member.user_id===recipient)) notFound();
                    v.conversationId(existing.conversation_id);
                    if (!authenticated) conversations.activateDirect(existing.conversation_id,new Date(auth.now()).toISOString());
                } else {
                    existing=conversations.createAuthenticatedDirect(actor,recipient);
                }
                if (!authenticated) repositories.audit.insert({actor_user_id:actor,event_type:'conversation.direct.ready',source:'conversations',subject_id:existing.conversation_id,
                    metadata:{operation:'direct.ready',outcome:'confirmed'}});
                return {created,conversation:project(authorized(actor,existing.conversation_id))};
            });
        },
        detail(context,id,input={}) {
            v.query(input,[]);v.conversationId(id);
            return read(context,actor=>({conversation:project(authorized(actor,id))}));
        },
        list(context,input) {
            const pagination=v.page(input,context.userId);
            return read(context,actor=>{
                const rows=conversations.listDirectForUser(actor,pagination);
                const visible=rows.slice(0,pagination.limit);
                const last=visible.at(-1);
                return {items:visible.map(project),nextCursor:rows.length>pagination.limit ? Buffer.from(JSON.stringify({v:1,context:pagination.context,
                    last:[last.updated_at,last.conversation_id]})).toString('base64url') : null};
            });
        }
    };
}
module.exports={createConversationService};
