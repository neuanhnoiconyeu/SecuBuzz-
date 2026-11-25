const express=require('express');
const { loadAuthConfig }=require('./auth/config');
const { createAuthService }=require('./auth/service');
const { createAuthMiddleware }=require('./auth/middleware');
const { createAuthAdapters }=require('./auth/adapters');
const { createAuthRouter }=require('./routes/auth');
const { requestAllowed }=require('./auth/security');
const { AuthError,sendError }=require('./auth/errors');
const { createSocialService }=require('./social/service');
const { createSocialRouters }=require('./routes/social');
const { createConversationService }=require('./conversations/service');
const { createConversationRouter }=require('./routes/conversations');
const { createMessageService }=require('./messaging/service');
const { createMessageRouters }=require('./routes/messaging');
const { createPinService }=require('./messaging/pins');
const { createPinRouters }=require('./routes/pins');
const { createReactionService }=require('./messaging/reactions');
const { createReactionRouters }=require('./routes/reactions');
const { createKeyService }=require('./e2ee/service');
const { createKeyRouters }=require('./routes/keys');
const {createEncryptedAttachmentService}=require('./messaging/attachments');
const {createEncryptedAttachmentRouter}=require('./routes/attachments');
const {createVoiceRooms,createVoiceRoomRouter}=require('./voice/rooms');

function createApp({db,config=loadAuthConfig(),messageOptions={},...dependencies}) {
    const app=express();
    app.disable('x-powered-by');
    app.set('trust proxy',false); // Rate limits always use the direct peer, never forwarded user input.
    const auth=createAuthService({db,config,...dependencies});
    const middleware=createAuthMiddleware(auth);
    app.use((req,res,next)=>{
        res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
            'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});
        next();
    });
    app.get(['/', '/healthz'],(req,res)=>res.json({status:'ok'}));
    app.use('/api',(req,res,next)=>requestAllowed(req,config) ? next() : sendError(res,'FORBIDDEN',403));
    app.use('/api/auth',createAuthRouter(auth,middleware));
    // The combined DATA/realtime host installs the existing LiveKit handler here, before body parsing.
    // DATA still enforces its own Origin/transport/session/CSRF policy on every request.
    let directCallTokens=null;
    app.all(['/api/calls/token','/api/voice/token'],middleware.requireAuth,(req,res,next)=>['GET','HEAD'].includes(req.method)?next():middleware.requireCsrf(req,res,next),(req,res,next)=>{
        if(!directCallTokens)return sendError(res,'FEATURE_UNAVAILABLE',503);
        Promise.resolve(directCallTokens(req,res)).then(handled=>{if(!handled&&!res.headersSent)sendError(res,'FEATURE_UNAVAILABLE',503);},next);
    });
    const voiceRooms=createVoiceRooms({db,auth,...(dependencies.limiter?{limiter:dependencies.limiter}:{})});
    app.use('/api/voice/rooms',createVoiceRoomRouter(voiceRooms,middleware));
    const social=createSocialService({db,auth,options:dependencies.socialOptions,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const socialRouters=createSocialRouters(social,middleware);
    app.use('/api/users',socialRouters.users);
    app.use('/api/friends',socialRouters.friends);
    app.use('/api/blocks',socialRouters.blocks);
    const conversations=createConversationService({db,auth,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const keys=createKeyService({db,auth,conversations,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const keyRouters=createKeyRouters(keys,middleware);
    app.use('/api/keys',keyRouters.devices);
    app.use('/api/conversations',keyRouters.conversations);
    const attachments=createEncryptedAttachmentService({db,auth,conversations,options:dependencies.attachmentOptions,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    app.use('/api/attachments',createEncryptedAttachmentRouter(attachments,middleware));
    const messaging=createMessageService({recipientKeyVerifier:keys.verifier,...messageOptions,db,auth,conversations,attachments,
        verifyKeysInTransaction:keys.verifyInTransaction,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const messageRouters=createMessageRouters(messaging,middleware);
    const pins=createPinService({db,auth,conversations,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const pinRouters=createPinRouters(pins,middleware);
    app.use('/api/conversations',pinRouters.conversations);
    app.use('/api/messages',pinRouters.messages);
    const reactions=createReactionService({db,auth,conversations,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const reactionRouters=createReactionRouters(reactions,middleware);
    app.use('/api/conversations',reactionRouters.conversations);
    app.use('/api/messages',reactionRouters.messages);
    // Exact history routes precede the metadata router; every other path falls through.
    app.use('/api/conversations',messageRouters.history);
    app.use('/api/conversations',createConversationRouter(conversations,middleware));
    app.use('/api/messages',messageRouters.lifecycle);
    // The legacy APIs have no object-level authorization. Do not expose them merely because
    // authentication now exists. DB-3/4/7 must replace/adapt them before mounting real data routes.
    app.use(['/api/messages','/api/logs'],middleware.requireAuth,(req,res,next)=>{
        if (['GET','HEAD'].includes(req.method)) return next();
        return middleware.requireCsrf(req,res,next);
    },(req,res)=>sendError(res,'FEATURE_UNAVAILABLE',503));
    app.use((req,res)=>sendError(res,'NOT_FOUND',404));
    app.use((error,req,res,next)=>{
        if (res.headersSent) { res.destroy(); return; }
        if (error instanceof AuthError) {
            if (error.retryAfterSeconds) res.set('Retry-After',String(error.retryAfterSeconds));
            return sendError(res,error.code,error.status,error.fields);
        }
        const mapped={DUPLICATE:['CONFLICT',409],CSRF:['CSRF_INVALID',403],CREDENTIALS:['INVALID_CREDENTIALS',401],
            BUSY:['SERVICE_UNAVAILABLE',503],SQLITE_BUSY:['SERVICE_UNAVAILABLE',503],SQLITE_BUSY_SNAPSHOT:['SERVICE_UNAVAILABLE',503],
            SQLITE_LOCKED:['SERVICE_UNAVAILABLE',503],CAPACITY:['RATE_LIMITED',429]};
        if (mapped[error.code]) return sendError(res,...mapped[error.code]);
        if (error.type==='entity.too.large') return sendError(res,'PAYLOAD_TOO_LARGE',413);
        if (['encoding.unsupported','charset.unsupported'].includes(error.type)) return sendError(res,'UNSUPPORTED_MEDIA_TYPE',415);
        if (error.type==='entity.parse.failed' || error.type==='request.aborted') return sendError(res,'VALIDATION_ERROR',400);
        // Never log raw errors, bodies, cookies, SQL, password hashes or session/CSRF material.
        return sendError(res,'INTERNAL_ERROR',500);
    });
    return {app,auth,social,conversations,keys,messaging,attachments,voiceRooms,adapters:createAuthAdapters(auth),middleware,
        setDirectCallTokenHandler(handler){
            if(handler!==null&&typeof handler!=='function')throw new TypeError('Invalid direct call token handler');
            if(handler&&directCallTokens)throw new TypeError('Direct call token handler is already installed');
            directCallTokens=handler;
        }};
}
module.exports={createApp};
