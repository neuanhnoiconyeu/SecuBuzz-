const express=require('express');
const { setCookie,clearCookie }=require('../auth/security');
function createAuthRouter(service,middleware) {
    const router=express.Router();
    const config=service.config;
    router.use((req,res,next)=>Number(req.headers['content-length'] || 0)>8192
        ? res.status(413).json({code:'PAYLOAD_TOO_LARGE',fields:[]}) : next());
    const rate=operation=>(req,res,next)=>{
        try { service.rateSource(operation,req.socket.remoteAddress || 'unknown'); next(); } catch (error) { next(error); }
    };
    const json=(req,res,next)=>{
        if (!req.is('application/json')) return res.status(415).json({code:'UNSUPPORTED_MEDIA_TYPE',fields:[]});
        return express.json({limit:'8kb',strict:true,inflate:false})(req,res,next);
    };
    router.get('/csrf',rate('csrf'),(req,res)=>{
        const cookies=middleware.cookies(req);
        const result=service.bootstrap(cookies.session,cookies.pre);
        if (result.preToken) {
            clearCookie(res,config.sessionCookie,config);
            setCookie(res,config.preCookie,result.preToken,Math.max(0,result.expiresAt-service.now()),config);
        }
        res.json({csrfToken:result.csrfToken,expiresAt:new Date(result.expiresAt).toISOString()});
    });
    router.post('/register',rate('register'),middleware.requireCsrf,json,async(req,res)=>{
        const result=await service.register(req.body,req.csrfProof);
        clearCookie(res,config.preCookie,config);
        res.status(201).json(result);
    });
    router.post('/login',rate('login'),middleware.requireCsrf,json,async(req,res)=>{
        const result=await service.login(req.body,req.csrfProof);
        clearCookie(res,config.preCookie,config);
        setCookie(res,config.sessionCookie,result.token,config.sessionTtlMs,config);
        res.json({user:result.user});
    });
    router.get('/me',middleware.requireAuth,(req,res)=>res.json({user:req.auth.user}));
    router.post('/logout',rate('logout'),middleware.requireCsrf,(req,res)=>{
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0)>0) {
            return res.status(400).json({code:'VALIDATION_ERROR',fields:[]});
        }
        service.logout(req.csrfProof);
        clearCookie(res,config.sessionCookie,config);
        clearCookie(res,config.preCookie,config);
        res.status(204).end();
    });
    return router;
}
module.exports={createAuthRouter};
