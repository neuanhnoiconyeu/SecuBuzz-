const { test }=require('node:test');
const assert=require('node:assert/strict');
const { setup,childBackend,PASSWORD }=require('./support/auth');
const { digest,freshToken }=require('../server/auth/security');

test('real registration hashes credentials, normalizes identifiers, returns requires-login and exposes only public identity',async t=>{
    const f=await setup(t);const b=f.browser();
    const registered=await b.register('Fixture-User',{email:'Mixed.Email@EXAMPLE.test'});
    assert.equal(registered.status,201);assert.deepEqual(registered.body,{status:'requires-login'});
    assert.equal((await b.request('/api/auth/me')).status,401);
    const credential=f.db.prepare('SELECT * FROM AccountCredentials').get();
    assert.equal(credential.username_key,'fixture-user');assert.equal(credential.email_key,'mixed.email@example.test');
    assert.match(credential.password_hash,/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.ok(!JSON.stringify(credential).includes(PASSWORD));
    const login=await b.login('MIXED.EMAIL@example.test');assert.equal(login.status,200);
    assert.deepEqual(Object.keys(login.body.user).sort(),['avatar','displayName','id','isDemo','username']);
    assert.equal(login.body.user.isDemo,false);
    const me=await b.request('/api/auth/me');assert.deepEqual(me.body,login.body);
    assert.ok(!me.text.includes('password'));assert.ok(!me.text.includes('email'));assert.ok(!me.text.includes('token'));
    const session=f.db.prepare('SELECT * FROM Sessions').get();
    const token=b.cookies.get(f.config.sessionCookie);
    assert.equal(session.token_hash,digest(token));assert.notEqual(session.session_id,token);
    assert.equal(session.auth_version,credential.auth_version);
    assert.ok(!JSON.stringify(session).includes(token));
});

test('duplicate username and email use identical safe conflict responses without partial users',async t=>{
    const f=await setup(t);const a=f.browser();assert.equal((await a.register()).status,201);
    const duplicateName=await f.browser().register('FIXTURE-USER',{email:'different@example.test'});
    const duplicateEmail=await f.browser().register('different-user',{email:'fixture-user@EXAMPLE.test'});
    assert.equal(duplicateName.status,409);assert.equal(duplicateEmail.status,409);
    assert.deepEqual(duplicateName.body,duplicateEmail.body);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM UserProfiles').get().n,1);
});

test('two real HTTP servers racing duplicate registration create exactly one account',async t=>{
    const f=await setup(t);const a=f.browser();const b=await f.anotherServer();
    const [ta,tb]=await Promise.all([a.csrf(),b.csrf()]);
    const body={username:'racing-user',email:'racing@example.test',password:PASSWORD};
    const results=await Promise.all([a.post('/api/auth/register',body,ta),b.post('/api/auth/register',body,tb)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AccountCredentials').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,1);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

for (const [label,overrides,field] of [
    ['short password',{password:'short'},'password'],['oversize password',{password:'x'.repeat(1025)},'password'],
    ['unpaired surrogate',{password:'long-password-'+String.fromCharCode(0xD800)},'password'],
    ['invalid username',{username:'invalid username'},'username'],['reserved demo username',{username:'demo-user'},'username'],
    ['invalid email',{email:'not-an-email'},'email'],['control display name',{displayName:'bad\nname'},'displayName']
]) test(`registration rejects ${label}`,async t=>{
    const f=await setup(t);const response=await f.browser().register('valid-user',overrides);
    assert.equal(response.status,400);assert.ok(response.body.fields.includes(field));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AccountCredentials').get().n,0);
});

test('client identity or demo flags cannot be injected into registration/login',async t=>{
    const f=await setup(t);const b=f.browser();
    for (const extra of [{userId:'local-user'},{isDemo:true}]) assert.equal((await b.register('valid-user',extra)).status,400);
    assert.equal((await b.post('/api/auth/login',{identifier:'x',password:PASSWORD,userId:'victim'})).status,400);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Users').get().n,0);
});

test('password whitespace and Unicode are preserved without normalization or truncation',async t=>{
    const f=await setup(t);const b=f.browser();const password='  synthetic e\u0301 password with spaces  ';
    assert.equal((await b.register('unicode-user',{password})).status,201);
    assert.equal((await b.login('unicode-user',password.trim())).status,401);
    assert.equal((await b.login('unicode-user',password.normalize('NFC'))).status,401);
    assert.equal((await b.login('unicode-user',password)).status,200);
});

test('invalid, unknown and disabled credentials return the same generic failure',async t=>{
    const f=await setup(t);const b=f.browser();await b.register();
    const wrong=await b.login('fixture-user','not the correct password');
    const unknown=await b.login('nonexistent-user',PASSWORD);
    const id=f.db.prepare('SELECT user_id FROM AccountCredentials').get().user_id;
    f.application.auth.repository.disableAccount(id);
    const disabled=await b.login();
    assert.deepEqual([wrong.status,unknown.status,disabled.status],[401,401,401]);
    assert.deepEqual(wrong.body,unknown.body);assert.deepEqual(unknown.body,disabled.body);
});

test('legacy users remain intact, reserved and unable to authenticate',async t=>{
    const f=await setup(t);
    const user=f.application.auth.repository.repositories.users.create({user_id:'legacy-id',username:'Legacy-User',display_name:'Legacy Name'});
    const b=f.browser();assert.equal((await b.login('legacy-user')).status,401);
    assert.equal((await b.register('legacy-user')).status,409);
    assert.equal(f.application.auth.repository.repositories.users.get('legacy-id').display_name,user.display_name);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AccountCredentials').get().n,0);
});

test('missing, malformed and unknown cookies and identity headers never authenticate',async t=>{
    const f=await setup(t);const b=f.browser();
    for (const cookie of ['',`${f.config.sessionCookie}=invalid`,`${f.config.sessionCookie}=${freshToken()}`]) {
        const response=await b.request('/api/auth/me?userId=victim',{headers:{cookie,'x-user-id':'victim',authorization:'Bearer unverified'}});
        assert.equal(response.status,401);
    }
    await b.register();const login=await b.login();const cookie=b.cookies.get(f.config.sessionCookie);
    const me=await b.request('/api/auth/me?userId=someone-else',{headers:{'x-user-id':'someone-else'}});
    assert.equal(me.body.user.id,login.body.user.id);
    assert.equal((await b.request('/api/auth/me',{headers:{cookie:`${f.config.sessionCookie}=${cookie}; ${f.config.sessionCookie}=${cookie}`}})).status,401);
});

test('expired and revoked sessions cannot access protected endpoints',async t=>{
    let clock=Date.now();const f=await setup(t,{now:()=>clock});const b=f.browser();await b.register();await b.login();
    const replay=b.clone();clock+=f.config.sessionTtlMs+1;
    const expired=await b.request('/api/auth/me');assert.equal(expired.status,401);assert.equal(expired.body.code,'SESSION_EXPIRED');
    clock-=f.config.sessionTtlMs+1;
    const row=f.db.prepare('SELECT session_id FROM Sessions').get();f.application.auth.repository.repositories.sessions.revoke(row.session_id,clock);
    assert.equal((await replay.request('/api/auth/me')).status,401);
    assert.equal((await replay.request('/api/users')).status,401);
});

test('logout requires CSRF, revokes only the current session and supports safe logged-out retries',async t=>{
    const f=await setup(t);const a=f.browser();const b=f.browser();await a.register();await a.login();await b.login();
    const replay=a.clone();const token=await a.csrf();
    assert.equal((await a.request('/api/auth/logout',{method:'POST'})).status,403);
    assert.equal((await a.request('/api/auth/me')).status,200);
    const loggedOut=await a.post('/api/auth/logout',undefined,token);assert.equal(loggedOut.status,204);
    assert.ok(loggedOut.setCookies.some(value=>value.startsWith(f.config.sessionCookie+'=;')));
    assert.equal((await replay.request('/api/auth/me')).status,401);
    assert.equal((await b.request('/api/auth/me')).status,200);
    assert.equal((await a.request('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':token}})).status,403);
    assert.equal((await a.post('/api/auth/logout')).status,204);
});

test('native server processes persist sessions across restart then reject replay after logout',async t=>{
    const f=await setup(t);const first=await childBackend(f);const b=first.browser;
    assert.equal((await b.register()).status,201);assert.equal((await b.login()).status,200);
    const before=(await b.request('/api/auth/me')).body.user;
    await first.stop();const second=await childBackend(f);b.origin=second.browser.origin;
    assert.deepEqual((await b.request('/api/auth/me')).body.user,before);
    const replay=b.clone();assert.equal((await b.post('/api/auth/logout')).status,204);
    assert.equal((await replay.request('/api/auth/me')).status,401);
    assert.equal((await replay.request('/api/messages')).status,401);
    await second.stop();
});

test('account disabling, reenabling or deletion cannot revive old sessions',async t=>{
    const f=await setup(t);const b=f.browser();await b.register();const login=await b.login();const replay=b.clone();
    f.application.auth.repository.disableAccount(login.body.user.id);
    assert.equal((await b.request('/api/auth/me')).status,401);
    f.db.prepare("UPDATE AccountCredentials SET status='active' WHERE user_id=?").run(login.body.user.id);
    assert.equal((await replay.request('/api/auth/me')).status,401);
    assert.equal((await b.login()).status,200);
    f.db.prepare('DELETE FROM AccountCredentials WHERE user_id=?').run(login.body.user.id);
    assert.equal((await b.request('/api/auth/me')).status,401);
});

test('login always rotates its bearer and limits concurrent sessions without affecting other accounts',async t=>{
    const f=await setup(t);const a=f.browser();await a.register();await a.login();const old=a.clone();
    await a.login();assert.equal((await old.request('/api/auth/me')).status,401);
    const sessions=[a];for(let i=0;i<5;i++){const next=f.browser();assert.equal((await next.login()).status,200);sessions.push(next);}
    assert.equal((await sessions[0].request('/api/auth/me')).status,401);
    assert.equal((await sessions[5].request('/api/auth/me')).status,200);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Sessions WHERE revoked_at_ms IS NULL').get().n,5);
});

test('legacy APIs fail closed in the actual application until object authorization exists',async t=>{
    const f=await setup(t);const b=f.browser();
    for(const route of ['/api/users','/api/messages','/api/logs']) assert.equal((await b.request(route)).status,401);
    await b.register();await b.login();
    for(const route of ['/api/users','/api/messages','/api/logs']) {
        assert.equal((await b.request(route)).status,503);
        assert.equal((await b.request(route,{method:'POST',body:{user_id:'victim'}})).status,403);
        assert.equal((await b.post(route,{user_id:'victim'})).status,503);
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});

test('malformed JSON, oversized bodies and unsupported content types have safe errors',async t=>{
    const f=await setup(t);const b=f.browser();const csrf=await b.csrf();
    const headers={'X-CSRF-Token':csrf};
    const malformed=await b.request('/api/auth/login',{method:'POST',rawBody:'{"password":"DO_NOT_ECHO",',headers});
    assert.equal(malformed.status,400);assert.ok(!malformed.text.includes('DO_NOT_ECHO'));
    assert.equal((await b.request('/api/auth/login',{method:'POST',rawBody:'x'.repeat(9000),headers})).status,413);
    assert.equal((await b.request('/api/auth/login',{method:'POST',rawBody:'a=b',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'}})).status,415);
});
