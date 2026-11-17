const {test}=require('node:test');
const assert=require('node:assert/strict');
const {messagingFixture,encrypted,submit,actorContext,fixtureVerifier}=require('./support/messaging');
const {childBackend}=require('./support/auth');
const {mutate}=require('./support/social');
const {createMessageService}=require('../server/messaging/service');

test('normal DATA entrypoint refuses v1 as unverified after genuine key-directory integration',async t=>{
    const f=await messagingFixture(t);const server=await childBackend(f);const browser=f.alice.browser.clone();browser.origin=server.browser.origin;
    const {envelope}=await encrypted(f.alice,f.conversationId);const response=await submit(f,{...f.alice,browser},envelope);
    assert.equal(response.status,403);assert.equal(response.body.code,'RECIPIENT_KEYS_UNVERIFIED');assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});
test('production rejects an explicitly test-only verifier even when injected by a trusted composition',async t=>{
    const f=await messagingFixture(t);const actor=actorContext(f,f.alice);const {envelope}=await encrypted(f.alice,f.conversationId);
    const service=createMessageService({db:f.db,auth:{...f.application.auth,config:{...f.config,production:true}},conversations:f.application.conversations,recipientKeyVerifier:fixtureVerifier});
    await assert.rejects(service.submit(actor.context,actor.proof,f.conversationId,envelope),{code:'RECIPIENT_KEYS_UNAVAILABLE'});
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});
test('message adapter options cannot replace the authoritative database, auth or conversation service',async t=>{
    const f=await messagingFixture(t,{messageOptions:{db:null,auth:null,conversations:null}});const {envelope}=await encrypted(f.alice,f.conversationId);
    assert.equal((await submit(f,f.alice,envelope)).status,201);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,1);
});
for(const [name,answer] of [['false',{verified:false}],['missing',null],['malformed',{}],['extra fields',{verified:true,extra:true}],
    ['array',Object.assign([],{verified:true})],['function',Object.assign(()=>{},{verified:true})],
    ['class instance',new class {verified=true;}()],['symbol field',{verified:true,[Symbol('extra')]:true}]]){
    test('unverified or malformed recipient attestation fails closed: '+name,async t=>{
        const f=await messagingFixture(t,{messageOptions:{recipientKeyVerifier:{verifyEnvelope:async()=>answer}}});const {envelope}=await encrypted(f.alice,f.conversationId);
        const result=await submit(f,f.alice,envelope);assert.equal(result.status,403);assert.equal(result.body.code,'RECIPIENT_KEYS_UNVERIFIED');assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
    });
}
test('verifier exceptions and timeouts are sanitized and never cause a late write',async t=>{
    const f=await messagingFixture(t,{messageOptions:{recipientKeyVerifier:{verifyEnvelope:async()=>{throw new Error('PRIVATE_KEY_DIAGNOSTIC');}}}});const {envelope}=await encrypted(f.alice,f.conversationId);
    const failure=await submit(f,f.alice,envelope);assert.equal(failure.status,503);assert.ok(!failure.text.includes('PRIVATE_KEY_DIAGNOSTIC'));
    let resolve;const verifier={verifyEnvelope:()=>new Promise(done=>{resolve=done;})};
    const service=createMessageService({db:f.db,auth:f.application.auth,conversations:f.application.conversations,recipientKeyVerifier:verifier,verifierTimeoutMs:20});const a=actorContext(f,f.alice);
    await assert.rejects(service.submit(a.context,a.proof,f.conversationId,envelope),{code:'RECIPIENT_KEYS_UNAVAILABLE'});resolve({verified:true});await new Promise(done=>setImmediate(done));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});
test('a block committed during key verification is rechecked and prevents storage without holding a transaction open',async t=>{
    let entered,finish;const started=new Promise(resolve=>{entered=resolve;});const held=new Promise(resolve=>{finish=resolve;});
    const f=await messagingFixture(t,{messageOptions:{recipientKeyVerifier:{verifyEnvelope:()=>{entered();return held;}}}});const {envelope}=await encrypted(f.alice,f.conversationId);
    const sending=submit(f,f.alice,envelope);await started;assert.equal(f.db.inTransaction,false);await mutate(f.bob,'POST','/api/blocks',{userId:f.alice.id});finish({verified:true});
    assert.equal((await sending).status,404);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});
test('logout during key verification invalidates the pending submit before commit',async t=>{
    let entered,finish;const started=new Promise(resolve=>{entered=resolve;});const held=new Promise(resolve=>{finish=resolve;});
    const f=await messagingFixture(t,{messageOptions:{recipientKeyVerifier:{verifyEnvelope:()=>{entered();return held;}}}});const {envelope}=await encrypted(f.alice,f.conversationId);
    const sending=submit(f,f.alice,envelope);await started;assert.equal((await f.alice.browser.post('/api/auth/logout')).status,204);finish({verified:true});
    assert.equal((await sending).status,401);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});
test('membership, friendship and blocks are enforced for submits, history and lifecycle mutations',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);const original=(await submit(f,f.alice,envelope)).body.message;
    const history=`/api/conversations/${f.conversationId}/messages`,item='/api/messages/'+original.storageId;
    assert.equal((await f.carol.browser.request(history)).status,404);assert.equal((await submit(f,f.carol,{...envelope,senderId:f.carol.id,senderName:'Carol'})).status,404);
    assert.equal((await submit(f,f.alice,{...envelope,id:'forged-sender',senderId:f.bob.id})).status,403);
    await mutate(f.alice,'DELETE','/api/friends/'+f.bob.id);
    assert.equal((await f.bob.browser.request(history)).status,200);assert.equal((await submit(f,f.alice,envelope)).status,403);assert.equal((await mutate(f.bob,'POST',item+'/read')).status,403);
    await mutate(f.bob,'POST','/api/blocks',{userId:f.alice.id});assert.equal((await f.alice.browser.request(history)).status,404);assert.equal((await mutate(f.alice,'DELETE',item)).status,404);
});
test('revoked sessions, invalid CSRF and invalid Origin cannot read or mutate message state',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId),url=`/api/conversations/${f.conversationId}/messages`;
    assert.equal((await f.alice.browser.request(url,{method:'POST',body:envelope})).status,403);
    for(const headers of [{'X-CSRF-Token':'invalid'},{'X-CSRF-Token':f.bob.token},{Origin:'https://evil.example'}])assert.equal((await mutate(f.alice,'POST',url,envelope,headers)).status,403);
    const replay=f.alice.browser.clone();await f.alice.browser.post('/api/auth/logout');
    assert.equal((await replay.request(url)).status,401);assert.equal((await replay.request(url,{method:'POST',body:envelope,headers:{'X-CSRF-Token':f.alice.token}})).status,401);
    assert.equal((await f.browser().request(url)).status,401);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});
test('plaintext-only, extra fields, demo markers and invalid encrypted payloads are rejected without echoing data',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);
    const invalid=[{content:'PRIVATE_PLAINTEXT'}, {...envelope,content:'PRIVATE_PLAINTEXT'}, {...envelope,demoOnly:true},
        {...envelope,encryption:{...envelope.encryption,scope:'browser-demo'}}, {...envelope,encryption:{...envelope.encryption,key:'PRIVATE_KEY'}},
        {...envelope,encryption:{...envelope.encryption,version:2}}, {...envelope,encryption:{...envelope.encryption,algorithm:'AES-CBC'}},
        {...envelope,encryption:{...envelope.encryption,encoding:'hex'}}, {...envelope,encryption:{...envelope.encryption,iv:'bad'}},
        {...envelope,encryption:{...envelope.encryption,ciphertext:Buffer.alloc(16).toString('base64')}},
        {...envelope,encryption:{...envelope.encryption,ciphertext:'a'.repeat(65540)}}, {...envelope,id:''},
        {...envelope,id:'space id'}, {...envelope,timestamp:'2026-02-31T12:00:00Z'}, {...envelope,senderName:'bad\nname'},
        {...envelope,conversationId:'another-conversation'}];
    for(const body of invalid){const result=await submit(f,f.alice,body);assert.equal(result.status,400);assert.ok(!result.text.includes('PRIVATE_PLAINTEXT')&&!result.text.includes('PRIVATE_KEY'));}
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
});
test('request byte limits, JSON errors, media types and unknown query fields fail safely',async t=>{
    const f=await messagingFixture(t);const url=`/api/conversations/${f.conversationId}/messages`,headers={'X-CSRF-Token':f.alice.token};
    assert.equal((await f.alice.browser.request(url,{method:'POST',rawBody:'x'.repeat(131073),headers})).status,413);
    assert.equal((await f.alice.browser.request(url,{method:'POST',rawBody:'{bad json',headers})).status,400);
    assert.equal((await f.alice.browser.request(url,{method:'POST',rawBody:'a=b',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'}})).status,415);
    const {envelope}=await encrypted(f.alice,f.conversationId);assert.equal((await mutate(f.alice,'POST',url+'?senderId='+f.bob.id,envelope)).status,400);
    assert.equal((await f.alice.browser.request(url+'?userId='+f.bob.id)).status,400);
});
test('message rate limits use shared SQLite actor buckets and ignore forwarded IP spoofing',async t=>{
    const f=await messagingFixture(t);const server=await f.anotherServer();const browser=f.alice.browser.clone();browser.origin=server.origin;
    for(let n=0;n<120;n++)f.application.messaging.rate('history',{userId:f.alice.id},'direct-peer');
    const response=await browser.request(`/api/conversations/${f.conversationId}/messages`,{headers:{'X-Forwarded-For':'198.51.100.9'}});
    assert.equal(response.status,429);assert.ok(Number(response.headers.get('Retry-After'))>0);
});
