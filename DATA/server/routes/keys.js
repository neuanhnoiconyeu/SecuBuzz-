const express=require('express');
const {sendError}=require('../auth/errors');
const {query}=require('../social/validation');
function createKeyRouters(service,middleware){
    function router(scope){const r=express.Router();r.use((req,res,next)=>scope(req)?next():next('router'));r.use(middleware.requireAuth);
        r.use((req,res,next)=>{try{service.rate(!['GET','HEAD'].includes(req.method),req.auth,req.socket.remoteAddress||'unknown');next();}catch(e){next(e);}});
        r.use((req,res,next)=>['GET','HEAD'].includes(req.method)?next():middleware.requireCsrf(req,res,next));
        r.use((req,res,next)=>{if(['GET','HEAD'].includes(req.method))return next();const limit=/\/epochs\/?$/.test(req.path)?16384:8192;
            if(Number(req.headers['content-length']||0)>limit)return sendError(res,'PAYLOAD_TOO_LARGE',413);
            if(!req.headers['transfer-encoding']&&!Number(req.headers['content-length']||0))return next();
            if(!req.is('application/json'))return sendError(res,'UNSUPPORTED_MEDIA_TYPE',415);
            return express.json({limit,strict:true,inflate:false})(req,res,next);});return r;}
    const devices=router(req=>['GET','HEAD','POST'].includes(req.method)&&(/^\/devices\/?$/.test(req.path)||(req.method==='POST'&&/^\/devices\/[^/]+\/revoke\/?$/.test(req.path))));
    devices.get('/devices',(req,res)=>res.json(service.list(req.auth,req.query)));
    devices.post('/devices',(req,res)=>{query(req.query,[]);const r=service.register(req.auth,req.csrfProof,req.body);res.status(r.created?201:200).json({device:r.device});});
    devices.post('/devices/:deviceId/revoke',(req,res)=>{query(req.query,[]);res.json(service.revoke(req.auth,req.csrfProof,req.params.deviceId,req.body));});
    const conversations=router(req=>['GET','HEAD','POST'].includes(req.method)&&(/^\/[^/]+\/keys\/?$/.test(req.path)&&req.method!=='POST'||/^\/[^/]+\/keys\/epochs\/?$/.test(req.path)&&req.method==='POST'||/^\/[^/]+\/keys\/epochs\/[^/]+\/?$/.test(req.path)&&req.method!=='POST'));
    conversations.get('/:id/keys',(req,res)=>res.json(service.state(req.auth,req.params.id,req.query)));
    conversations.get('/:id/keys/epochs/:keyId',(req,res)=>res.json(service.epoch(req.auth,req.params.id,req.params.keyId,req.query)));
    conversations.post('/:id/keys/epochs',(req,res)=>{query(req.query,[]);const r=service.publish(req.auth,req.csrfProof,req.params.id,req.body);res.status(r.created?201:200).json({epoch:r.epoch});});
    return {devices,conversations};
}
module.exports={createKeyRouters};
