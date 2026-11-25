const express=require('express');
const path=require('node:path');
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
const { createGroupMessageService }=require('./messaging/group');
const { createMessageRouters }=require('./routes/messaging');
const { createKeyService }=require('./e2ee/service');
const { createKeyRouters }=require('./routes/keys');
const { createGroupService }=require('./groups/service');
const { createGroupRouter }=require('./routes/groups');
const { createAttachmentRouters }=require('./routes/attachments');
const { createAttachmentService }=require('./attachments/service');
const { createFilesystemProvider }=require('./attachments/storage/filesystem');
const { DISABLED_FEATURES }=require('./features/config');
const { createFeatureGate }=require('./features/gate');

function isPlainFeatureObject(value) {
    if (value===null || typeof value!=='object' || Array.isArray(value)) return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype || prototype===null;
}

function createApp({db,config=loadAuthConfig(),messageOptions={},features=DISABLED_FEATURES,...dependencies}) {
    if (!isPlainFeatureObject(features)) throw new TypeError('features must be a plain object.');
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
    const social=createSocialService({db,auth,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const socialRouters=createSocialRouters(social,middleware);
    app.use('/api/users',socialRouters.users);
    app.use('/api/friends',socialRouters.friends);
    app.use('/api/blocks',socialRouters.blocks);
    const conversations=createConversationService({db,auth,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const keys=createKeyService({db,auth,conversations,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const keyRouters=createKeyRouters(keys,middleware);
    app.use('/api/keys',keyRouters.devices);
    app.use('/api/conversations',keyRouters.conversations);
    const messaging=createMessageService({recipientKeyVerifier:keys.verifier,...messageOptions,db,auth,conversations,
        verifyKeysInTransaction:keys.verifyInTransaction,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const messageRouters=createMessageRouters(messaging,middleware);
    // Exact history routes precede the metadata router; every other path falls through.
    app.use('/api/conversations',messageRouters.history);
    app.use('/api/conversations',createConversationRouter(conversations,middleware));
    app.use('/api/messages',messageRouters.lifecycle);
    // DB5-R16.2: mounted while every switch is off, so a disabled function answers 503 and not 404.
    const featureGate=createFeatureGate({
        groupApi:features?.groupApi===true,
        groupMessaging:features?.groupMessaging===true,
        attachmentApi:features?.attachmentApi===true,
        attachments:features?.attachments
    });
    const runtimeFeatures=Object.freeze({ ...features, attachmentApi:featureGate.enabled('attachmentApi') });
    const groups=createGroupService({db,auth,features:runtimeFeatures,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    const groupMessages=createGroupMessageService({db,auth,groups,
        ...(messageOptions.groupRecipientKeyVerifier ? {groupRecipientKeyVerifier:messageOptions.groupRecipientKeyVerifier} : {}),
        ...(dependencies.limiter ? {limiter:dependencies.limiter} : {})});
    app.use('/api/groups',createGroupRouter({groups,groupMessages,features:groups.features},middleware));
    const attachmentStorage=dependencies.storage || (featureGate.enabled('attachmentApi')
        ? createFilesystemProvider({root:features.attachments.storageDir,repositoryRoot:path.resolve(__dirname,'../..')}) : null);
    const attachments=featureGate.enabled('attachmentApi') ? createAttachmentService({db,auth,features:runtimeFeatures,
        storage:attachmentStorage,settings:features.attachments,...(dependencies.limiter ? {limiter:dependencies.limiter} : {})}) : null;
    const attachmentRouters=createAttachmentRouters(attachments,middleware);
    app.use('/api/attachments',attachmentRouters.attachments);
    app.use('/api/files',attachmentRouters.files);
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
    return {app,auth,social,conversations,keys,messaging,groups,groupMessages,attachments,features:groups.features,adapters:createAuthAdapters(auth),middleware};
}
module.exports={createApp};
