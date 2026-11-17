const { cookieValue,clearCookie }=require('./security');
const { AuthError }=require('./errors');
function createAuthMiddleware(service) {
    const config=service.config;
    const cookies=req=>({session:cookieValue(req.headers.cookie,config.sessionCookie),pre:cookieValue(req.headers.cookie,config.preCookie)});
    function requireAuth(req,res,next) {
        try {
            const result=service.resolveToken(cookies(req).session);
            if (result.status!=='authenticated') {
                clearCookie(res,config.sessionCookie,config);
                throw new AuthError(result.status==='expired' ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED',401);
            }
            const row=result.row;
            Object.defineProperty(req,'auth',{value:Object.freeze({userId:row.user_id,sessionId:row.session_id,
                user:service.publicUser(row),expiresAt:new Date(row.expires_at_ms)}),enumerable:false});
            next();
        } catch (error) { next(error); }
    }
    function requireCsrf(req,res,next) {
        try {
            const values=cookies(req);
            req.csrfProof=service.csrfProof(values.session,values.pre,req.headers['x-csrf-token']);
            next();
        } catch (error) { next(error); }
    }
    return {requireAuth,requireCsrf,cookies};
}
module.exports={createAuthMiddleware};
