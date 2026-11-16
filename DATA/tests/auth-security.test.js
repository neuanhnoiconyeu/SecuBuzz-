const { test }=require('node:test');
const assert=require('node:assert/strict');
const argon2=require('argon2');
const { setup,PASSWORD,envDefaults }=require('./support/auth');
const { loadAuthConfig }=require('../server/auth/config');
const { createSqliteRateLimiter }=require('../server/auth/rateLimiter');
const { createPasswordHasher,parameters }=require('../server/auth/passwords');
const { digest,csrfFor,freshToken }=require('../server/auth/security');
const { createRepositories }=require('../server/database/repositories');

for(const [label,overrides] of [
    ['missing origins',{AUTH_ALLOWED_ORIGINS:''}],['wildcard origins',{AUTH_ALLOWED_ORIGINS:'*'}],
    ['noncanonical origin',{AUTH_ALLOWED_ORIGINS:'https://app.example.test/'}],
    ['production HTTP override',{NODE_ENV:'production'}],['unverified network origin',{AUTH_ALLOWED_ORIGINS:'http://192.168.1.1:3000'}],
    ['production typo',{NODE_ENV:'Production'}],['bad proxy list',{AUTH_TRUST_PROXY_IPS:'true'}],
    ['oversize session TTL',{AUTH_SESSION_TTL_SECONDS:'99999999'}]
]) test(`auth config fails closed for ${label}`,()=>assert.throws(()=>loadAuthConfig({...envDefaults,...overrides})));

test('pre-session CSRF bootstrap is stable, expires, and cannot be used as authentication',async t=>{
    let clock=Date.now();const f=await setup(t,{now:()=>clock});const b=f.browser();
    const first=await b.csrf();assert.equal(await b.csrf(),first);
    assert.equal((await b.request('/api/auth/me')).status,401);
    const pre=b.cookies.get(f.config.preCookie);assert.ok(pre);
    const stored=f.db.prepare('SELECT * FROM AuthChallenges').get();
    assert.equal(stored.challenge_hash,digest(pre));assert.equal(stored.csrf_hash,digest(first));
    assert.ok(!JSON.stringify(stored).includes(pre));
    clock+=f.config.challengeTtlMs+1;
    assert.equal((await b.post('/api/auth/login',{identifier:'unknown',password:PASSWORD},first)).status,403);
    assert.notEqual(await b.csrf(),first);
});

test('login and registration require valid bootstrap cookie and CSRF header',async t=>{
    const f=await setup(t);const b=f.browser();const csrf=await b.csrf();
    for(const route of ['/api/auth/register','/api/auth/login']) {
        assert.equal((await b.request(route,{method:'POST',body:{}})).status,403);
        assert.equal((await b.request(route,{method:'POST',body:{},headers:{'X-CSRF-Token':freshToken()}})).status,403);
        assert.equal((await f.browser().request(route,{method:'POST',body:{},headers:{'X-CSRF-Token':csrf}})).status,403);
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,0);
});

test('CSRF proofs are isolated across pre-sessions, authenticated sessions and users',async t=>{
    const f=await setup(t);const a=f.browser(),b=f.browser();
    const preA=await a.csrf(),preB=await b.csrf();assert.notEqual(preA,preB);
    assert.equal((await b.post('/api/auth/register',{username:'csrf-user',email:'csrf@example.test',password:PASSWORD},preA)).status,403);
    await a.register('alice-user');await a.login('alice-user');
    await b.register('bob-user');await b.login('bob-user');
    const tokenA=await a.csrf(),tokenB=await b.csrf();
    assert.notEqual(tokenA,tokenB);assert.equal(await a.csrf(),tokenA);
    assert.equal((await b.post('/api/auth/logout',undefined,tokenA)).status,403);
    assert.equal((await a.post('/api/auth/logout',undefined,preA)).status,403);
    assert.equal((await a.request('/api/auth/me')).status,200);assert.equal((await b.request('/api/auth/me')).status,200);
});

test('successful registration consumes the pre-session proof; concurrent reuse cannot create two accounts',async t=>{
    const f=await setup(t);const b=f.browser();const csrf=await b.csrf();const replay=b.clone();
    const body={username:'nonce-user',email:'nonce@example.test',password:PASSWORD};
    assert.equal((await b.post('/api/auth/register',body,csrf)).status,201);
    assert.equal((await replay.post('/api/auth/register',{...body,username:'nonce-other',email:'other@example.test'},csrf)).status,403);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,1);
});

test('disallowed or missing mutation Origin, cross-site bootstrap and CORS preflight are rejected',async t=>{
    const f=await setup(t);const b=f.browser();const csrf=await b.csrf();
    for(const origin of ['https://evil.example','null','']) {
        const result=await b.request('/api/auth/login',{method:'POST',body:{},headers:{Origin:origin,'X-CSRF-Token':csrf}});
        assert.equal(result.status,403);assert.equal(result.headers.get('access-control-allow-origin'),null);
    }
    assert.equal((await b.request('/api/auth/csrf',{headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await b.request('/api/auth/login',{method:'OPTIONS',headers:{Origin:'https://evil.example'}})).status,403);
    const original=f.application.app;
    assert.equal(original.get('trust proxy'),false);
});

test('same-origin browser bootstrap works without Origin; cross-site GET does not',async t=>{
    const f=await setup(t);const origin=`http://127.0.0.1:${f.application.server.address().port}`;
    const allowed=await fetch(origin+'/api/auth/csrf',{headers:{Referer:'http://localhost:3000/login','Sec-Fetch-Site':'same-origin'}});
    assert.equal(allowed.status,200);
    const crossSite=await fetch(origin+'/api/auth/csrf',{headers:{'Sec-Fetch-Site':'cross-site'}});
    assert.equal(crossSite.status,403);
});

test('local-development cookies are host-only, HttpOnly and Lax with explicit lifetime',async t=>{
    const f=await setup(t);const b=f.browser();const bootstrap=await b.request('/api/auth/csrf');
    const pre=bootstrap.setCookies.find(cookie=>cookie.startsWith(f.config.preCookie+'='));
    assert.match(pre,/HttpOnly/);assert.match(pre,/SameSite=Lax/);assert.match(pre,/Path=\//);
    const maxAge=Number(/Max-Age=(\d+)/.exec(pre)[1]);assert.ok(maxAge>0 && maxAge<=600);
    assert.ok(!pre.includes('Domain='));assert.ok(!pre.includes('Secure'));
    await b.register();const login=await b.login();const cookie=login.setCookies.find(value=>value.startsWith(f.config.sessionCookie+'='));
    assert.match(cookie,/Max-Age=28800/);assert.match(cookie,/HttpOnly/);assert.ok(!cookie.includes('Domain='));
});

test('production rejects plain HTTP and untrusted forwarded headers; secure cookies use __Host-',async t=>{
    const env={NODE_ENV:'production',AUTH_ALLOW_HTTP_LOCAL:'false',AUTH_ALLOWED_ORIGINS:'https://app.example.test'};
    const f=await setup(t,{env});const b=f.browser();
    assert.equal((await b.request('/api/auth/csrf')).status,403);
    assert.equal((await b.request('/api/auth/csrf',{headers:{'X-Forwarded-Proto':'https','X-Forwarded-For':'127.0.0.1'}})).status,403);
    const proxied=await setup(t,{env:{...env,AUTH_TRUST_PROXY_IPS:'127.0.0.1'}});
    const browser=proxied.browser();
    const bootstrap=await browser.request('/api/auth/csrf',{headers:{'X-Forwarded-Proto':'https'}});
    assert.equal(bootstrap.status,200);
    const cookie=bootstrap.setCookies.find(value=>value.startsWith('__Host-secubuzz_preauth='));
    assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/Path=\//);assert.ok(!cookie.includes('Domain='));
    const headers={'X-Forwarded-Proto':'https','X-CSRF-Token':bootstrap.body.csrfToken};
    assert.equal((await browser.request('/api/auth/register',{method:'POST',headers,body:{username:'secure-user',email:'secure@example.test',password:PASSWORD}})).status,201);
    const boot2=await browser.request('/api/auth/csrf',{headers:{'X-Forwarded-Proto':'https'}});
    const login=await browser.request('/api/auth/login',{method:'POST',headers:{...headers,'X-CSRF-Token':boot2.body.csrfToken},body:{identifier:'secure-user',password:PASSWORD}});
    assert.equal(login.status,200);assert.ok(login.setCookies.some(value=>value.startsWith('__Host-secubuzz_session=') && value.includes('; Secure')));
});

test('registration and bootstrap source limits cannot be bypassed by forwarded IP headers',async t=>{
    const f=await setup(t);const b=f.browser();const csrf=await b.csrf();
    for(let i=0;i<5;i++) assert.equal((await b.request('/api/auth/register',{method:'POST',body:{},headers:{'X-CSRF-Token':csrf,'X-Forwarded-For':`192.0.2.${i+1}`}})).status,400);
    const limited=await b.request('/api/auth/register',{method:'POST',body:{},headers:{'X-CSRF-Token':csrf,'X-Forwarded-For':'192.0.2.99'}});
    assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
    for(let i=0;i<59;i++) assert.equal((await b.request('/api/auth/csrf')).status,200);
    assert.equal((await b.request('/api/auth/csrf')).status,429);
});

test('login account limits count failures independently of source and survive a new server instance',async t=>{
    const f=await setup(t);const b=f.browser();await b.register();
    for(let i=0;i<10;i++) assert.equal((await b.login('fixture-user','incorrect fixture password')).status,401);
    const another=await f.anotherServer();
    const limited=await another.login();assert.equal(limited.status,429);assert.equal(limited.body.code,'RATE_LIMITED');
    const buckets=f.db.prepare('SELECT bucket_hash FROM AuthRateLimits').all();
    assert.ok(buckets.every(bucket=>/^[a-f0-9]{64}$/.test(bucket.bucket_hash)));
});

test('login source rate limit counts malformed attempts before validation',async t=>{
    const f=await setup(t);const b=f.browser();const token=await b.csrf();
    for(let i=0;i<20;i++) assert.equal((await b.post('/api/auth/login',{},token)).status,400);
    assert.equal((await b.post('/api/auth/login',{},token)).status,429);
});

test('SQLite limiter enforces shared buckets atomically and recovers after expiry',async t=>{
    const f=await setup(t);await f.anotherServer();
    const first=createSqliteRateLimiter(f.db),second=createSqliteRateLimiter(f.connections[1]);
    const bucket=[{key:'fixture-account',limit:2,windowMs:1000}];const now=Date.now();
    assert.ok(first.consume(bucket,now).allowed);assert.ok(second.consume(bucket,now).allowed);
    assert.equal(second.consume(bucket,now).allowed,false);assert.ok(first.consume(bucket,now+1001).allowed);
});

test('hash concurrency is bounded without issuing partial accounts',async t=>{
    const hasher=createPasswordHasher();let release,entered=0,bothEntered;
    const gate=new Promise(resolve=>{release=resolve;});
    const both=new Promise(resolve=>{bothEntered=resolve;});
    const f=await setup(t,{passwordHasher:{...hasher,hash:async password=>{if(++entered===2)bothEntered();await gate;return hasher.hash(password);}}});
    const browsers=[f.browser(),await f.anotherServer(),f.browser()];const tokens=await Promise.all(browsers.map(b=>b.csrf()));
    const body=i=>({username:`parallel-${i}`,email:`parallel-${i}@example.test`,password:PASSWORD});
    const pending=[browsers[0].post('/api/auth/register',body(0),tokens[0]),browsers[1].post('/api/auth/register',body(1),tokens[1])];
    await both;
    try { assert.equal((await browsers[2].post('/api/auth/register',body(2),tokens[2])).status,429); }
    finally { release(); }
    assert.deepEqual((await Promise.all(pending)).map(result=>result.status),[201,201]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AccountCredentials').get().n,2);
});

test('password salts differ; weaker stored hashes upgrade on successful login and stronger hashes are retained',async t=>{
    const f=await setup(t);const a=f.browser(),b=f.browser();await a.register('hash-user-a');await b.register('hash-user-b');
    const accounts=f.db.prepare('SELECT * FROM AccountCredentials ORDER BY username_key').all();
    assert.notEqual(accounts[0].password_hash,accounts[1].password_hash);
    const weak=await argon2.hash(PASSWORD,{...parameters,memoryCost:8192,timeCost:1});
    f.db.prepare('UPDATE AccountCredentials SET password_hash=? WHERE user_id=?').run(weak,accounts[0].user_id);
    assert.equal((await a.login('hash-user-a')).status,200);
    const updated=f.db.prepare('SELECT password_hash FROM AccountCredentials WHERE user_id=?').get(accounts[0].user_id);
    assert.match(updated.password_hash,/m=19456,t=2,p=1/);
    const stronger=await argon2.hash(PASSWORD,{...parameters,memoryCost:32768,timeCost:3});
    f.db.prepare('UPDATE AccountCredentials SET password_hash=? WHERE user_id=?').run(stronger,accounts[1].user_id);
    assert.equal((await b.login('hash-user-b')).status,200);
    assert.equal(f.db.prepare('SELECT password_hash FROM AccountCredentials WHERE user_id=?').get(accounts[1].user_id).password_hash,stronger);
});

test('resolver and CSRF verifier match Kiro contracts without mounting realtime or Gemini',async t=>{
    let clock=Date.now();const f=await setup(t,{now:()=>clock});const b=f.browser();await b.register();const login=await b.login();
    const token=b.cookies.get(f.config.sessionCookie);const csrf=await b.csrf();
    const {sessionResolver,csrfVerifier}=f.application.adapters;
    const context={sessionToken:token,origin:f.config.origins[0],remoteAddress:'127.0.0.1',userAgent:null,secure:false,receivedAt:new Date(clock)};
    const resolved=await sessionResolver.resolveSession(context);assert.equal(resolved.status,'authenticated');
    assert.ok(resolved.session.expiresAt instanceof Date);assert.equal(resolved.session.userId,login.body.user.id);
    assert.notEqual(resolved.session.sessionId,token);
    const reference={sessionId:resolved.session.sessionId,userId:resolved.session.userId};
    assert.equal((await sessionResolver.checkSession(reference)).status,'active');
    assert.equal((await sessionResolver.checkSession({...reference,userId:'other-user'})).status,'revoked');
    assert.ok(await csrfVerifier.verify({...reference,token:csrf}));
    assert.equal(await csrfVerifier.verify({...reference,userId:'other-user',token:csrf}),false);
    assert.equal(await csrfVerifier.verify({...reference,token:freshToken()}),false);
    assert.equal((await sessionResolver.resolveSession({...context,origin:'https://evil.example'})).status,'invalid');
    assert.equal((await sessionResolver.resolveSession({...context,sessionToken:''})).status,'missing');
    assert.equal((await sessionResolver.resolveSession({...context,sessionToken:'malformed'})).status,'invalid');
    clock+=f.config.sessionTtlMs+1;
    assert.equal((await sessionResolver.resolveSession(context)).status,'expired');
    assert.equal((await sessionResolver.checkSession(reference)).status,'expired');
    assert.equal(await csrfVerifier.verify({...reference,token:csrf}),false);
    clock-=f.config.sessionTtlMs+1;
    await b.post('/api/auth/logout');
    assert.equal((await sessionResolver.checkSession(reference)).status,'revoked');
});

test('DB-1 sessions with version zero and demo identities cannot become authenticated accounts',async t=>{
    const f=await setup(t);const r=createRepositories(f.db);const token=freshToken();
    r.users.create({user_id:'local-user',username:'legacy-local',display_name:'Legacy'});
    r.sessions.insert({session_id:'legacy-session',user_id:'local-user',token_hash:digest(token),issued_at_ms:Date.now(),expires_at_ms:Date.now()+60000});
    assert.equal(f.application.auth.resolveToken(token).status,'invalid');
    assert.throws(()=>f.db.prepare('INSERT INTO AccountCredentials(user_id,username_key,email_key,password_hash) VALUES(?,?,?,?)')
        .run('local-user','legacy-local','legacy@example.test','$argon2id$invalid'));
    const b=f.browser();await b.register();const login=await b.login();
    f.db.prepare('UPDATE Sessions SET auth_version=0 WHERE user_id=?').run(login.body.user.id);
    assert.equal((await b.request('/api/auth/me')).status,401);
});

test('SQL injection input remains data and produces generic authentication failure',async t=>{
    const f=await setup(t);const b=f.browser();await b.register();
    assert.equal((await b.login("' OR 1=1 --",PASSWORD)).status,401);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AccountCredentials').get().n,1);
});

test('password/database failures never return or log credentials, tokens or diagnostics',async t=>{
    const f=await setup(t);const b=f.browser();await b.register();await b.login();const output=[];
    t.mock.method(console,'log',(...args)=>output.push(args));t.mock.method(console,'error',(...args)=>output.push(args));
    t.mock.method(f.application.auth.repository,'byHash',()=>{throw new Error('DO_NOT_EXPOSE_CREDENTIALS');});
    const response=await b.request('/api/auth/me');assert.equal(response.status,500);
    assert.deepEqual(response.body,{code:'INTERNAL_ERROR',fields:[]});assert.deepEqual(output,[]);
});

test('password hashing failure returns a safe error with no partial account or sensitive log',async t=>{
    const hasher=createPasswordHasher();const f=await setup(t,{passwordHasher:{...hasher,hash:async()=>{throw new Error('PRIVATE_PASSWORD_DIAGNOSTIC');}}});
    const output=[];t.mock.method(console,'error',(...args)=>output.push(args));
    const result=await f.browser().register();assert.equal(result.status,500);
    assert.deepEqual(result.body,{code:'INTERNAL_ERROR',fields:[]});assert.deepEqual(output,[]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,0);
});

test('limiter storage failure cannot issue a proof or allow an authentication request',async t=>{
    const f=await setup(t,{limiter:{consume(){throw new Error('private storage diagnostic');}}});
    const result=await f.browser().request('/api/auth/csrf');assert.equal(result.status,500);
    assert.deepEqual(result.body,{code:'INTERNAL_ERROR',fields:[]});
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AuthChallenges').get().n,0);
});

test('account disable during password verification is rechecked before issuing any session',async t=>{
    const hasher=createPasswordHasher();let release,entered;
    const gate=new Promise(resolve=>{release=resolve;});const verifying=new Promise(resolve=>{entered=resolve;});
    const f=await setup(t,{passwordHasher:{...hasher,verify:async(hash,password)=>{
        const valid=await hasher.verify(hash,password);entered();await gate;return valid;
    }}});
    const b=f.browser();await b.register();const pending=b.login();await verifying;
    try {const id=f.db.prepare('SELECT user_id FROM AccountCredentials').get().user_id;f.application.auth.repository.disableAccount(id);}
    finally {release();}
    assert.equal((await pending).status,401);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Sessions').get().n,0);
});

test('proof expiry during password work rolls back account creation',async t=>{
    const hasher=createPasswordHasher();let clock=Date.now(),release,entered;
    const gate=new Promise(resolve=>{release=resolve;});const hashing=new Promise(resolve=>{entered=resolve;});
    const f=await setup(t,{now:()=>clock,passwordHasher:{...hasher,hash:async password=>{
        entered();await gate;return hasher.hash(password);
    }}});
    const pending=f.browser().register();await hashing;clock+=f.config.challengeTtlMs+1;release();
    assert.equal((await pending).status,403);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,0);
});

test('a readable CSRF proof is not accepted as the bearer session cookie',async t=>{
    const f=await setup(t);const b=f.browser();await b.register();await b.login();const csrf=await b.csrf();
    const response=await f.browser().request('/api/auth/me',{headers:{cookie:`${f.config.sessionCookie}=${csrf}`}});
    assert.equal(response.status,401);
});

test('expired/revoked cleanup preserves active and unrelated sessions',async t=>{
    const f=await setup(t);const b=f.browser();await b.register();await b.login();
    const active=f.db.prepare('SELECT session_id,user_id FROM Sessions').get();const now=Date.now();
    f.application.auth.repository.repositories.sessions.insert({session_id:'old-session',user_id:active.user_id,token_hash:'b'.repeat(64),issued_at_ms:0,expires_at_ms:1});
    const removed=f.application.auth.repository.cleanup(now);assert.equal(removed.sessions,1);
    assert.ok(f.db.prepare('SELECT 1 FROM Sessions WHERE session_id=?').get(active.session_id));
    assert.equal((await b.request('/api/auth/me')).status,200);
});
