const { createSocialRepository }=require('../database/socialRepository');
const { createSqliteRateLimiter }=require('../auth/rateLimiter');
const { AuthError }=require('../auth/errors');
const v=require('./validation');
const notFound=()=>{throw new AuthError('NOT_FOUND',404);};
const conflict=()=>{throw new AuthError('CONFLICT',409);};
const user=row=>({id:row.user_id,username:row.username,displayName:row.display_name,avatar:row.avatar});
const searchUser=row=>({...user(row),relationship:row.relationship,...(row.request_id ? {requestId:row.request_id} : {})});
const request=row=>({id:row.request_id,user:user(row),direction:row.direction,status:row.status,createdAt:row.created_at,resolvedAt:row.resolved_at});
const position=row=>[row.username_key,row.user_id];

function createSocialService({db,auth,limiter=createSqliteRateLimiter(db)}) {
    const repository=createSocialRepository(db);const now=auth.now;
    function rate(buckets) {
        const result=limiter.consume(buckets,now());
        if(!result.allowed) {const error=new AuthError('RATE_LIMITED',429);error.retryAfterSeconds=result.retryAfterSeconds;throw error;}
    }
    function activeContext(context) {
        const result=auth.checkSession({sessionId:context.sessionId,userId:context.userId});
        if(result.status!=='active') throw new AuthError(result.status==='expired' ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED',401);
    }
    function read(context,work) {return repository.read(()=>{activeContext(context);return work(context.userId);});}
    function collection(context,pagination,load,project,sortPosition) {
        return read(context,actor=>{
            const revision=repository.revision(actor);
            if(pagination.revision!==null && pagination.revision!==revision)throw new AuthError('STALE_STATE',409);
            return v.resultPage(load(actor),pagination,project,sortPosition,revision);
        });
    }
    function write(context,proof,work) {
        return repository.write(()=>{
            if(!proof || proof.type!=='session' || proof.sessionId!==context.sessionId || proof.userId!==context.userId) throw new AuthError('CSRF_INVALID',403);
            auth.repository.verifyProof(proof,now());
            return work(context.userId,new Date(now()).toISOString());
        });
    }
    function target(actor,id,{allowBlocked=false}={}) {
        const other=repository.active(id);
        if(!other || (!allowBlocked && repository.isBlocked(actor,id)))notFound();
        return other;
    }
    function event(actor,operation,id) {
        repository.repositories.audit.insert({actor_user_id:actor,event_type:`social.${operation}`,source:'social',subject_id:id,
            metadata:{operation,outcome:'confirmed'}});
    }
    function ownProfile(actor) {
        const row=repository.ownProfile(actor);if(!row)notFound();
        return {...user(row),statusMessage:row.custom_status,presencePreference:row.presence_preference,isDemo:false};
    }
    function requestFor(id,actor) {
        const row=repository.request(id);if(!row || (row.sender_id!==actor && row.recipient_id!==actor))notFound();
        const other=target(actor,row.sender_id===actor ? row.recipient_id : row.sender_id);
        return request({...other,...row,direction:row.sender_id===actor ? 'outgoing' : 'incoming'});
    }
    return {
        repository,
        rate(operation,context,source) {
            const actor=context.userId;
            const buckets=operation==='read' ? [{key:`social:read:${actor}`,limit:120,windowMs:60000}]
                : [{key:`social:write:${actor}`,limit:60,windowMs:60000},{key:`social:write-source:${source}`,limit:120,windowMs:60000}];
            rate(buckets);
        },
        search(context,input,source) {
            v.query(input,['q','limit','cursor']);
            const prefix=typeof input.q==='string' ? input.q.trim().toLowerCase() : '';
            if(!/^[a-z0-9._-]{2,64}$/.test(prefix))v.invalid('q');
            rate([{key:`social:search:${context.userId}`,limit:30,windowMs:60000},{key:`social:search-source:${source}`,limit:60,windowMs:60000}]);
            const pagination=v.page(input,'search',context.userId,{q:prefix});
            return read(context,actor=>v.resultPage(repository.search(actor,prefix,pagination),pagination,searchUser,position));
        },
        profile(context,id) {
            v.identifier(id);
            return read(context,actor=>{const row=repository.publicProfile(actor,id);if(!row)notFound();return {user:searchUser(row)};});
        },
        ownProfile:context=>read(context,actor=>({profile:ownProfile(actor)})),
        updateProfile(context,proof,body) {
            const patch=v.profilePatch(body);
            return write(context,proof,actor=>{
                repository.repositories.profiles.update(actor,patch);event(actor,'profile.updated',actor);
                return {profile:ownProfile(actor)};
            });
        },
        listFriends(context,input) {
            v.query(input,['limit','cursor','revision']);const pagination=v.page(input,'friends',context.userId);
            return collection(context,pagination,actor=>repository.friends(actor,pagination),user,position);
        },
        listBlocks(context,input) {
            v.query(input,['limit','cursor','revision']);const pagination=v.page(input,'blocks',context.userId);
            return collection(context,pagination,actor=>repository.blocks(actor,pagination),user,position);
        },
        listRequests(context,input) {
            v.query(input,['direction','status','limit','cursor','revision']);
            const direction=input.direction ?? 'all',status=input.status ?? 'pending';
            if(!['incoming','outgoing','all'].includes(direction))v.invalid('direction');
            if(!['pending','accepted','declined','cancelled','all'].includes(status))v.invalid('status');
            const pagination=v.page(input,'requests',context.userId,{direction,status});
            return collection(context,pagination,actor=>repository.requests(actor,direction,status,pagination),request,row=>[row.created_at,row.request_id]);
        },
        send(context,proof,body,source) {
            const id=v.target(body);if(id===context.userId)v.invalid('userId');
            rate([{key:`social:request:${context.userId}`,limit:20,windowMs:3600000},
                {key:`social:request-pair:${context.userId}:${id}`,limit:5,windowMs:3600000},
                {key:`social:request-source:${source}`,limit:60,windowMs:3600000}]);
            return write(context,proof,(actor,at)=>{
                target(actor,id);
                if(repository.friendship(actor,id) || repository.pending(actor,id))conflict();
                repository.retireLegacyPending(actor,id,at);
                const requestId=repository.insertRequest(actor,id,at);event(actor,'request.sent',requestId);
                return {request:requestFor(requestId,actor)};
            });
        },
        resolve(context,proof,id,action,body) {
            v.identifier(id);v.emptyBody(body);
            return write(context,proof,(actor,at)=>{
                const row=repository.request(id);
                if(!row || (action==='cancel' ? row.sender_id!==actor : row.recipient_id!==actor))notFound();
                target(actor,row.sender_id===actor ? row.recipient_id : row.sender_id);
                if(action==='cancel' && row.status==='cancelled')return null;
                if(row.status!=='pending')conflict();
                const status={accept:'accepted',decline:'declined',cancel:'cancelled'}[action];
                if(!status)v.invalid();
                if(action==='accept')repository.acceptFriendship(row.sender_id,row.recipient_id,at);
                repository.resolveRequest(id,status,at);event(actor,`request.${status}`,id);
                return action==='cancel' ? null : {request:requestFor(id,actor)};
            });
        },
        removeFriend(context,proof,id,body) {
            v.identifier(id);v.emptyBody(body);if(id===context.userId)v.invalid('id');
            return write(context,proof,actor=>{repository.removeFriendship(actor,id);event(actor,'friend.removed',id);});
        },
        block(context,proof,body) {
            const id=v.target(body);if(id===context.userId)v.invalid('userId');
            return write(context,proof,(actor,at)=>{
                target(actor,id,{allowBlocked:true});repository.block(actor,id,at);repository.removeFriendship(actor,id);event(actor,'user.blocked',id);
            });
        },
        unblock(context,proof,id,body) {
            v.identifier(id);v.emptyBody(body);if(id===context.userId)v.invalid('userId');
            return write(context,proof,actor=>{repository.unblock(actor,id);event(actor,'user.unblocked',id);});
        }
    };
}
module.exports={createSocialService};
