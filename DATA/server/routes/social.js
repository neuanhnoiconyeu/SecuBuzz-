const express=require('express');
const fs=require('node:fs');
const { sendError }=require('../auth/errors');
const { query }=require('../social/validation');

function createSocialRouters(service,middleware) {
    function router() {
        const value=express.Router();
        value.use(middleware.requireAuth);
        value.use((req,res,next)=>{try{service.rate(['GET','HEAD'].includes(req.method)?'read':'write',req.auth,req.socket.remoteAddress || 'unknown');next();}catch(error){next(error);}});
        value.use((req,res,next)=>['GET','HEAD'].includes(req.method) ? next() : middleware.requireCsrf(req,res,next));
        value.use((req,res,next)=>{
            if(['GET','HEAD'].includes(req.method) || req.path==='/me/avatar')return next();
            if(Number(req.headers['content-length'] || 0)>8192)return sendError(res,'PAYLOAD_TOO_LARGE',413);
            if(!req.headers['transfer-encoding'] && !Number(req.headers['content-length'] || 0))return next();
            if(!req.is('application/json'))return sendError(res,'UNSUPPORTED_MEDIA_TYPE',415);
            return express.json({limit:'8kb',strict:true,inflate:false})(req,res,next);
        });
        return value;
    }
    const noQuery=(req,res,next)=>{try{query(req.query,[]);next();}catch(error){next(error);}};
    const source=req=>req.socket.remoteAddress || 'unknown';
    const users=router(),friends=router(),blocks=router();
    users.get('/search',(req,res)=>res.json(service.search(req.auth,req.query,source(req))));
    users.get('/me',noQuery,(req,res)=>res.json(service.ownProfile(req.auth)));
    users.patch('/me',noQuery,(req,res)=>res.json(service.updateProfile(req.auth,req.csrfProof,req.body)));
    users.post('/me/avatar',noQuery,(req,res,next)=>{service.uploadAvatar(req.auth,req.csrfProof,req).then(result=>res.json(result),next);});
    users.delete('/me/avatar',noQuery,(req,res)=>res.json(service.removeAvatar(req.auth,req.csrfProof,req.body)));
    users.get('/:id/avatar',(req,res)=>{
        const avatar=service.getAvatar(req.auth,req.params.id,req.query);
        res.set({'Content-Type':avatar.mimeType,'Content-Length':String(avatar.byteSize),'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'});
        const stream=fs.createReadStream(avatar.filePath);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    });
    users.patch('/:id',noQuery,(req,res)=>sendError(res,'NOT_FOUND',404));
    users.get('/:id',noQuery,(req,res)=>res.json(service.profile(req.auth,req.params.id)));
    // Retain the closed legacy CRUD paths without mounting their unauthorised handlers.
    users.use((req,res)=>sendError(res,'FEATURE_UNAVAILABLE',503));
    friends.get('/',(req,res)=>res.json(service.listFriends(req.auth,req.query)));
    friends.get('/requests',(req,res)=>res.json(service.listRequests(req.auth,req.query)));
    friends.post('/requests',noQuery,(req,res)=>res.status(201).json(service.send(req.auth,req.csrfProof,req.body,source(req))));
    friends.post('/requests/:id/accept',noQuery,(req,res)=>res.json(service.resolve(req.auth,req.csrfProof,req.params.id,'accept',req.body)));
    friends.post('/requests/:id/decline',noQuery,(req,res)=>res.json(service.resolve(req.auth,req.csrfProof,req.params.id,'decline',req.body)));
    friends.delete('/requests/:id',noQuery,(req,res)=>{service.resolve(req.auth,req.csrfProof,req.params.id,'cancel',req.body);res.status(204).end();});
    friends.delete('/:id',noQuery,(req,res)=>{service.removeFriend(req.auth,req.csrfProof,req.params.id,req.body);res.status(204).end();});
    blocks.get('/',(req,res)=>res.json(service.listBlocks(req.auth,req.query)));
    blocks.post('/',noQuery,(req,res)=>{service.block(req.auth,req.csrfProof,req.body);res.status(204).end();});
    blocks.delete('/:userId',noQuery,(req,res)=>{service.unblock(req.auth,req.csrfProof,req.params.userId,req.body);res.status(204).end();});
    return {users,friends,blocks};
}
module.exports={createSocialRouters};
