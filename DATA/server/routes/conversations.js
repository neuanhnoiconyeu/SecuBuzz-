const express = require('express');
const { sendError } = require('../auth/errors');
const { query } = require('../social/validation');

function createConversationRouter(service,middleware) {
    const router=express.Router();
    router.use(middleware.requireAuth);
    router.use((req,res,next)=>{try{service.rate(['GET','HEAD'].includes(req.method)?'read':'write',req.auth,req.socket.remoteAddress || 'unknown');next();}catch(error){next(error);}});
    router.use((req,res,next)=>['GET','HEAD'].includes(req.method) ? next() : middleware.requireCsrf(req,res,next));
    router.use((req,res,next)=>{
        if (['GET','HEAD'].includes(req.method)) return next();
        if (Number(req.headers['content-length'] || 0)>8192) return sendError(res,'PAYLOAD_TOO_LARGE',413);
        if (!req.headers['transfer-encoding'] && !Number(req.headers['content-length'] || 0)) return next();
        if (!req.is('application/json')) return sendError(res,'UNSUPPORTED_MEDIA_TYPE',415);
        return express.json({limit:'8kb',strict:true,inflate:false})(req,res,next);
    });
    router.get('/',(req,res)=>res.json(service.list(req.auth,req.query)));
    router.post('/dm',(req,res)=>{
        query(req.query,['contractVersion']);
        const result=service.createDirect(req.auth,req.csrfProof,req.body,req.query);
        res.status(result.created ? 201 : 200).json({conversation:result.conversation});
    });
    router.get('/:id',(req,res)=>res.json(service.detail(req.auth,req.params.id,req.query)));
    router.patch('/:id/preferences',(req,res)=>res.json(service.updatePreferences(req.auth,req.csrfProof,req.params.id,req.body,req.query)));
    router.use((req,res)=>sendError(res,'NOT_FOUND',404));
    return router;
}
module.exports={createConversationRouter};
