const { createAuthRepository }=require('../database/authRepository');
const { createPasswordHasher }=require('./passwords');
const { createSqliteRateLimiter }=require('./rateLimiter');
const { AuthError }=require('./errors');
const { digest,freshToken,csrfFor,isToken,isDemo,matchesHash }=require('./security');
const { validate }=require('./validation');
// One budget across service instances in this process; durable auth authority stays in SQLite.
let hashOperations=0;

function publicUser(row) {
    return Object.freeze({id:row.user_id,username:row.username,displayName:row.display_name,avatar:row.avatar,
        ...(row.avatar_sha256 ? {avatarUrl:`/api/users/${row.user_id}/avatar?v=${row.avatar_sha256.slice(0,12)}`} : {}),isDemo:false});
}
function createAuthService({db,config,now=Date.now,passwordHasher=createPasswordHasher(),limiter=createSqliteRateLimiter(db)}) {
    const repository=createAuthRepository(db);
    function classify(row) {
        if (!row || isDemo(row.user_id) || row.account_status!=='active' || row.auth_version!==row.account_version || row.revoked_at_ms!==null ||
            !row.display_name || [...row.display_name].length>160 || /[\u0000-\u001f\u007f-\u009f]/u.test(row.display_name)) return {status:'invalid'};
        if (row.expires_at_ms<=now()) return {status:'expired'};
        return {status:'authenticated',row};
    }
    function rate(buckets) {
        const result=limiter.consume(buckets,now());
        if (!result.allowed) { const error=new AuthError('RATE_LIMITED',429); error.retryAfterSeconds=result.retryAfterSeconds; throw error; }
    }
    async function hashWork(work) {
        if (hashOperations>=2) { const error=new AuthError('RATE_LIMITED',429); error.retryAfterSeconds=1; throw error; }
        hashOperations++;
        try { return await work(); } finally { hashOperations--; }
    }
    const service={
        config,repository,ready:passwordHasher.ready,now,
        rateSource(operation,source) {
            const limits={register:[5,3600000],login:[20,900000],csrf:[60,60000],logout:[60,60000]};
            const [limit,windowMs]=limits[operation];
            rate([{key:`${operation}:source:${source}`,limit,windowMs}]);
        },
        resolveToken(token) {
            if (!token) return {status:'missing'};
            if (!isToken(token)) return {status:'invalid'};
            return classify(repository.byHash(digest(token)));
        },
        bootstrap(sessionToken,preToken) {
            const session=service.resolveToken(sessionToken);
            if (session.status==='authenticated') {
                const token=csrfFor(sessionToken,'session');
                if (!matchesHash(token,session.row.csrf_token_hash)) throw new AuthError('UNAUTHENTICATED',401);
                return {csrfToken:token,expiresAt:session.row.expires_at_ms};
            }
            const challenge=isToken(preToken) ? repository.challenge(digest(preToken)) : null;
            if (challenge && challenge.expires_at_ms>now()) {
                return {csrfToken:csrfFor(preToken,'preauth'),expiresAt:challenge.expires_at_ms,preToken};
            }
            const nonce=freshToken();
            const csrfToken=csrfFor(nonce,'preauth');
            const expiresAt=now()+config.challengeTtlMs;
            repository.addChallenge(digest(nonce),digest(csrfToken),now(),expiresAt,config.maxChallenges);
            return {csrfToken,expiresAt,preToken:nonce};
        },
        csrfProof(sessionToken,preToken,token) {
            if (!isToken(token)) throw new AuthError('CSRF_INVALID',403);
            const session=service.resolveToken(sessionToken);
            if (session.status==='authenticated') {
                if (!matchesHash(token,session.row.csrf_token_hash)) throw new AuthError('CSRF_INVALID',403);
                return {type:'session',sessionId:session.row.session_id,userId:session.row.user_id,csrfHash:digest(token)};
            }
            const challenge=isToken(preToken) ? repository.challenge(digest(preToken)) : null;
            if (!challenge || challenge.expires_at_ms<=now() || !matchesHash(token,challenge.csrf_hash)) throw new AuthError('CSRF_INVALID',403);
            return {type:'preauth',hash:digest(preToken),csrfHash:digest(token)};
        },
        async register(body,proof) {
            const input=validate(body,true);
            rate([{key:`register:username:${input.username}`,limit:5,windowMs:3600000},{key:`register:email:${input.email}`,limit:5,windowMs:3600000}]);
            const passwordHash=await hashWork(()=>passwordHasher.hash(input.password));
            repository.register({...input,passwordHash},proof,now());
            return {status:'requires-login'};
        },
        async login(body,proof) {
            const input=validate(body,false);
            const account=repository.findCredential(input.identifier);
            rate([{key:`login:identifier:${input.identifier}`,limit:10,windowMs:900000},
                ...(account ? [{key:`login:account:${account.user_id}`,limit:10,windowMs:900000}] : [])]);
            return hashWork(async ()=>{
                const valid=await passwordHasher.verify(account?.password_hash,input.password);
                if (!valid || !account || account.status!=='active' || isDemo(account.user_id)) throw new AuthError('INVALID_CREDENTIALS',401);
                const upgradedHash=passwordHasher.needsRehash(account.password_hash) ? await passwordHasher.hash(input.password) : null;
                const token=freshToken();
                const row=repository.issueSession({userId:account.user_id,verifiedHash:account.password_hash,upgradedHash,
                    tokenHash:digest(token),csrfHash:digest(csrfFor(token,'session'))},proof,now(),config);
                return {user:publicUser(row),token,expiresAt:row.expires_at_ms};
            });
        },
        logout:proof=>repository.logout(proof,now()),
        publicUser,
        checkSession(reference) {
            if (!reference || typeof reference.sessionId!=='string' || typeof reference.userId!=='string') return {status:'revoked'};
            const result=classify(repository.byId(reference.sessionId));
            if (result.status==='authenticated' && result.row.user_id===reference.userId) return {status:'active',expiresAt:new Date(result.row.expires_at_ms)};
            if (result.status==='expired' && repository.byId(reference.sessionId)?.user_id===reference.userId) return {status:'expired'};
            return {status:'revoked'};
        },
        verifyCsrf({sessionId,userId,token}={}) {
            if (!isToken(token) || typeof sessionId!=='string' || typeof userId!=='string') return false;
            const resolved=classify(repository.byId(sessionId));
            return resolved.status==='authenticated' && resolved.row.user_id===userId && matchesHash(token,resolved.row.csrf_token_hash);
        }
    };
    return service;
}
module.exports={ createAuthService };
