const express = require('express');
const { sendError } = require('../auth/errors');
const { MAX_BODY,query } = require('../messaging/validation');
function createMessageRouters(service,middleware){
    function router(operation,scope){const r=express.Router();
        r.use((req,res,next)=>scope(req)?next():next('router'));
        r.use(middleware.requireAuth);
        r.use((req,res,next)=>{try{service.rate(operation(req),req.auth,req.socket.remoteAddress||'unknown');next();}catch(error){next(error);}});
        r.use((req,res,next)=>['GET','HEAD'].includes(req.method)?next():middleware.requireCsrf(req,res,next));
        r.use((req,res,next)=>{if(['GET','HEAD'].includes(req.method))return next();
            if(Number(req.headers['content-length']||0)>MAX_BODY)return sendError(res,'PAYLOAD_TOO_LARGE',413);
            if(!req.headers['transfer-encoding']&&!Number(req.headers['content-length']||0))return next();
            if(!req.is('application/json'))return sendError(res,'UNSUPPORTED_MEDIA_TYPE',415);
            return express.json({limit:MAX_BODY,strict:true,inflate:false})(req,res,next);});return r;}
    const history=router(req=>['GET','HEAD'].includes(req.method)?'history':'submit',
        req=>['GET','HEAD','POST'].includes(req.method)&&/^\/[^/]+\/messages\/?$/.test(req.path));
    history.get('/:id/messages',(req,res)=>res.json(service.history(req.auth,req.params.id,req.query)));
    history.post('/:id/messages',async(req,res)=>{query(req.query,[]);const result=await service.submit(req.auth,req.csrfProof,req.params.id,req.body);res.status(result.outcome==='created'?201:200).json(result);});
    const lifecycle=router(req=>req.method==='DELETE'?'delete':req.method==='PATCH'?'edit':'read',
        req=>req.method==='POST'?/^\/[^/]+\/read\/?$/.test(req.path):['DELETE','PATCH'].includes(req.method)&&/^\/[^/]+\/?$/.test(req.path));
    lifecycle.post('/:id/read',(req,res)=>{query(req.query,[]);res.json(service.readReceipt(req.auth,req.csrfProof,req.params.id,req.body));});
    lifecycle.delete('/:id',(req,res)=>{query(req.query,[]);res.json(service.remove(req.auth,req.csrfProof,req.params.id,req.body));});
    lifecycle.patch('/:id',async(req,res)=>{query(req.query,[]);res.json(await service.edit(req.auth,req.csrfProof,req.params.id,req.body));});
    return {history,lifecycle};
}
module.exports={createMessageRouters};
