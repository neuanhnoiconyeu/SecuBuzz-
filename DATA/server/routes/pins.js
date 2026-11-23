const express=require('express');
const { sendError }=require('../auth/errors');
function createPinRouters(service,middleware) {
    const make=read=>{
        const r=express.Router();
        r.use((req,res,next)=>((read&&['GET','HEAD'].includes(req.method)&&/^\/[^/]+\/pins\/?$/.test(req.path))||
            (!read&&req.method==='POST'&&/^\/[^/]+\/pin\/?$/.test(req.path)))?next():next('router'));
        r.use(middleware.requireAuth);
        r.use((req,res,next)=>{try{service.rate(read,req.auth,req.socket.remoteAddress||'unknown');next();}catch(e){next(e);}});
        if(!read){
            r.use(middleware.requireCsrf);
            r.use((req,res,next)=>req.is('application/json')?next():sendError(res,'UNSUPPORTED_MEDIA_TYPE',415));
            r.use(express.json({limit:1024,strict:true,inflate:false}));
        }
        return r;
    };
    const conversations=make(true),messages=make(false);
    conversations.get('/:id/pins',(req,res)=>res.json(service.list(req.auth,req.params.id,req.query)));
    messages.post('/:id/pin',(req,res)=>res.json(service.set(req.auth,req.csrfProof,req.params.id,req.body,req.query)));
    return {conversations,messages};
}
module.exports={createPinRouters};
