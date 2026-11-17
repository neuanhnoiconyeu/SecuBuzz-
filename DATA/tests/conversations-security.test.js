const { test } = require('node:test');
const assert = require('node:assert/strict');
const { socialFixture,mutate,befriend } = require('./support/social');
const dm=(a,b)=>mutate(a,'POST','/api/conversations/dm',{recipientId:b.id});
async function fixture(t,options) {
    const f=await socialFixture(t,options);await befriend(f.alice,f.bob);const created=await dm(f.alice,f.bob);
    assert.equal(created.status,201);return {...f,id:created.body.conversation.id};
}
function context(f,actor) {
    const token=actor.browser.cookies.get(f.config.sessionCookie);const row=f.application.auth.resolveToken(token).row;
    return {context:{userId:row.user_id,sessionId:row.session_id},proof:f.application.auth.csrfProof(token,null,actor.token)};
}

test('missing, revoked and expired sessions fail closed on all conversation endpoints',async t=>{
    let clock=Date.now();const f=await fixture(t,{now:()=>clock});const missing=f.browser(),revoked=f.alice.browser.clone();
    assert.equal((await f.alice.browser.post('/api/auth/logout')).status,204);
    clock+=28800001;
    for(const browser of [missing,revoked,f.bob.browser])for(const [method,url] of [['GET','/api/conversations'],['GET','/api/conversations/'+f.id],['POST','/api/conversations/dm']]){
        const response=await browser.request(url,{method,...(method==='POST'?{body:{recipientId:f.carol.id},headers:{'X-CSRF-Token':f.bob.token}}:{})});assert.equal(response.status,401);
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,1);
});

test('mutations retain CSRF, exact Origin, cookie and Fetch Metadata enforcement',async t=>{
    const f=await socialFixture(t);await befriend(f.alice,f.bob);const b=f.alice.browser;
    for(const token of [undefined,'bad-token',f.bob.token])assert.equal((await b.request('/api/conversations/dm',{method:'POST',body:{recipientId:f.bob.id},headers:token?{'X-CSRF-Token':token}:{}})).status,403);
    for(const headers of [{Origin:'https://evil.example'},{Origin:''}])assert.equal((await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.bob.id},headers)).status,403);
    const cookie=[...b.cookies].map(([key,value])=>`${key}=${value}`).join('; ');
    const crossSite=await fetch(b.origin+'/api/conversations',{headers:{Cookie:cookie,'Sec-Fetch-Site':'cross-site'}});
    assert.equal(crossSite.status,403);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,0);
    assert.equal((await dm(f.alice,f.bob)).status,201);
});

test('spoofed sender headers and owner-selecting queries never change authority',async t=>{
    const f=await fixture(t);
    assert.equal((await f.carol.browser.request('/api/conversations/'+f.id,{headers:{'X-User-Id':f.alice.id,'X-Session-Id':'spoofed'}})).status,404);
    assert.equal((await f.carol.browser.request('/api/conversations?userId='+f.alice.id)).status,400);
    assert.equal((await f.alice.browser.request('/api/conversations/'+f.id+'?senderId='+f.bob.id)).status,400);
    assert.equal((await mutate(f.alice,'POST','/api/conversations/dm?senderId='+f.carol.id,{recipientId:f.bob.id})).status,400);
    const result=await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.bob.id},{'X-User-Id':f.carol.id});assert.equal(result.status,200);
    assert.ok(result.body.conversation.participants.some(p=>p.id===f.alice.id));assert.ok(!result.body.conversation.participants.some(p=>p.id===f.carol.id));
});

test('private status, preferences, credentials, membership internals and message content never enter conversation responses',async t=>{
    const f=await fixture(t);await mutate(f.alice,'PATCH','/api/users/me',{statusMessage:'PRIVATE_STATUS',presencePreference:'invisible'});
    for(const url of ['/api/conversations','/api/conversations/'+f.id]){
        const response=await f.bob.browser.request(url);assert.equal(response.status,200);
        for(const secret of ['PRIVATE_STATUS','invisible','password_hash','email','session_id','csrf','joined_at','created_by','origin','ciphertext','preview'])assert.ok(!response.text.includes(secret),secret);
        assert.equal(response.headers.get('Cache-Control'),'no-store');
    }
    assert.equal((await f.alice.browser.request('/api/messages')).status,503);
});

test('malformed JSON, non-JSON, compressed and oversized bodies cannot create records or expose raw input',async t=>{
    const f=await socialFixture(t);const headers={'X-CSRF-Token':f.alice.token};const b=f.alice.browser;
    const malformed=await b.request('/api/conversations/dm',{method:'POST',rawBody:'{"recipientId":"PRIVATE_INPUT",',headers});assert.equal(malformed.status,400);assert.ok(!malformed.text.includes('PRIVATE_INPUT'));
    assert.equal((await b.request('/api/conversations/dm',{method:'POST',rawBody:'x'.repeat(9000),headers})).status,413);
    assert.equal((await b.request('/api/conversations/dm',{method:'POST',rawBody:'recipientId=b',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'}})).status,415);
    assert.equal((await b.request('/api/conversations/dm',{method:'POST',rawBody:'{}',headers:{...headers,'Content-Encoding':'gzip'}})).status,415);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,0);
});

test('shared DB-4B authorization rechecks session, membership, blocks and friendship inside the caller transaction',async t=>{
    const f=await fixture(t),service=f.application.conversations;const alice=context(f,f.alice),carol=context(f,f.carol);
    assert.throws(()=>service.authorizeInTransaction(alice.context,f.id),/requires the caller transaction/);
    const capability=service.withInteraction(alice.context,alice.proof,f.id,value=>value);
    assert.equal(capability.recipientId,f.bob.id);assert.deepEqual(capability.participantIds.slice().sort(),[f.alice.id,f.bob.id].sort());
    assert.throws(()=>service.withInteraction(carol.context,carol.proof,f.id,()=>{}),{code:'NOT_FOUND'});
    assert.throws(()=>service.withInteraction(alice.context,{...alice.proof,userId:f.bob.id},f.id,()=>{}),{code:'CSRF_INVALID'});
    await mutate(f.bob,'POST','/api/blocks',{userId:f.alice.id});
    assert.throws(()=>service.withInteraction(alice.context,alice.proof,f.id,()=>{}),{code:'NOT_FOUND'});
    f.application.auth.repository.disableAccount(f.alice.id);
    assert.throws(()=>f.db.transaction(()=>service.authorizeInTransaction(alice.context,f.id)).immediate(),{code:'UNAUTHENTICATED'});
});

test('future synchronous interaction work rolls back on failure and rejects async work before invoking it',async t=>{
    const f=await fixture(t),service=f.application.conversations;const alice=context(f,f.alice);
    assert.throws(()=>service.withInteraction(alice.context,alice.proof,f.id,()=>{
        f.db.prepare("UPDATE UserProfiles SET custom_status='MUST_ROLL_BACK' WHERE user_id=?").run(f.alice.id);throw new Error('test rollback');
    }),/test rollback/);
    assert.notEqual(f.db.prepare('SELECT custom_status FROM UserProfiles WHERE user_id=?').get(f.alice.id).custom_status,'MUST_ROLL_BACK');
    let invoked=false;assert.throws(()=>service.withInteraction(alice.context,alice.proof,f.id,async()=>{invoked=true;}),/must be synchronous/);assert.equal(invoked,false);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});

test('conversation abuse limits are shared across connections and cannot be bypassed by forwarding headers',async t=>{
    const f=await fixture(t);const second=await f.anotherServer();const b=f.alice.browser.clone();b.origin=second.origin;
    for(let i=0;i<120;i++)f.application.conversations.rate('read',{userId:f.alice.id},'one');
    const limited=await b.request('/api/conversations',{headers:{'X-Forwarded-For':'198.51.100.1'}});
    assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('Retry-After'))>0);
});
