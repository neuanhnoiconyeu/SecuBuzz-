const { originAllowed }=require('./security');
const { loopback }=require('./config');
function createAuthAdapters(service) {
    const sessionResolver={
        async resolveSession(context) {
            if (!context || !originAllowed(context.origin,service.config) ||
                (context.secure!==true && !(service.config.allowHttpLocal && loopback(context.remoteAddress)))) return {status:'invalid'};
            const resolved=service.resolveToken(context.sessionToken);
            if (resolved.status!=='authenticated') return {status:resolved.status};
            const row=resolved.row;
            return {status:'authenticated',session:{sessionId:row.session_id,userId:row.user_id,displayName:row.display_name,expiresAt:new Date(row.expires_at_ms)}};
        },
        async checkSession(reference) { return service.checkSession(reference); }
    };
    return {sessionResolver,csrfVerifier:{verify:input=>service.verifyCsrf(input)}};
}
module.exports={ createAuthAdapters };
