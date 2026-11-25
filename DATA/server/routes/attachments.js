const express=require('express');
const fs=require('node:fs');
const {sendError}=require('../auth/errors');
function createEncryptedAttachmentRouter(service,middleware){
    const router=express.Router();router.use(middleware.requireAuth);
    router.use((req,res,next)=>{try{service.rate(req.auth,req.socket.remoteAddress||'unknown',!['GET','HEAD'].includes(req.method));next();}catch(e){next(e);}});
    router.use((req,res,next)=>['GET','HEAD'].includes(req.method)?next():middleware.requireCsrf(req,res,next));
    router.get('/limits',(req,res)=>res.json(service.limits()));
    router.post('/',(req,res,next)=>{
        if(req.headers['content-type']!=='application/octet-stream'||req.headers['content-encoding']||
            ['x-file-name','x-file-key','x-metadata-ciphertext','x-file-iv','x-file-auth-tag'].some(h=>req.headers[h]!==undefined))return sendError(res,'UNSUPPORTED_MEDIA_TYPE',415);
        service.upload(req.auth,req.csrfProof,req.query,req).then(result=>res.status(201).json(result),next);
    });
    router.post('/batches/:cid/:mid',express.json({limit:2048,strict:true,inflate:false}),(req,res)=>res.json(service.seal(req.auth,req.csrfProof,req.params.cid,req.params.mid,req.body,req.query)));
    router.get('/:id/download',(req,res)=>{
        const file=service.download(req.auth,req.params.id,req.query);
        res.set({'Content-Type':'application/octet-stream','Content-Length':String(file.size),'Content-Disposition':'attachment; filename="encrypted-attachment"'});
        const stream=fs.createReadStream(file.path);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    });
    router.delete('/:id',(req,res)=>{res.json(service.discard(req.auth,req.csrfProof,req.params.id,req.query));service.cleanup();});
    return router;
}
module.exports={createEncryptedAttachmentRouter};
