const {test}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {keyFixture,TestDevice,mutate,actorContext}=require('./support/e2ee');const {createMessageService}=require('../server/messaging/service');
test('missing or incompatible Kiro runtime exports leave key APIs and v2 parsing unavailable without a success fallback',()=>{
    const {execFileSync}=require('node:child_process');
    for(const mode of ['missing','incomplete']){
        const source=`const assert=require('node:assert/strict');const Module=require('node:module');const original=Module._load;
            Module._load=function(request,...args){if(request==='../../../server/src/e2ee/index.ts'){${mode==='missing'?"throw new Error('missing');":"return {};"}}return original.call(this,request,...args);};
            const {openDatabase}=require('./server/database/connection');const {createApp}=require('./server/app');const {loadAuthConfig}=require('./server/auth/config');
            const db=openDatabase({filename:':memory:'});try{const a=createApp({db,config:loadAuthConfig({NODE_ENV:'test',AUTH_ALLOW_HTTP_LOCAL:'true',AUTH_ALLOWED_ORIGINS:'http://localhost:3000'})});
            assert.equal(a.keys.verifier,null);assert.throws(()=>a.keys.list({},{}),{code:'RECIPIENT_KEYS_UNAVAILABLE',status:503});
            assert.throws(()=>require('./server/messaging/validation').envelope({id:'m',conversationId:'c',senderId:'u',senderName:'U',timestamp:'2026-11-14T00:00:00.000Z',type:'text',encryption:{version:2}},{userId:'u'},'c'),{code:'RECIPIENT_KEYS_UNAVAILABLE',status:503});}finally{db.close();}`;
        execFileSync(process.execPath,['-e',source],{cwd:require('node:path').join(__dirname,'..'),windowsHide:true,stdio:['ignore','pipe','pipe']});
    }
});
test('genuine persisted-key verification remains usable under production service policy without a test-only adapter',async t=>{
    const f=await keyFixture(t),epoch=await f.makeEpoch();await f.publish(epoch);const envelope=await f.message(epoch),actor=actorContext(f,f.alice);
    const service=createMessageService({db:f.db,auth:{...f.application.auth,config:{...f.config,production:true}},conversations:f.application.conversations,
        recipientKeyVerifier:f.application.keys.verifier,verifyKeysInTransaction:f.application.keys.verifyInTransaction});
    assert.equal((await service.submit(actor.context,actor.proof,f.conversationId,envelope)).outcome,'created');
});
test('device proofs reject unknown fields, private keys, forged account/device IDs, signatures and stale registration times',async t=>{
    const f=await keyFixture(t),body=f.alice.registration;
    for(const b of [{...body,userId:f.bob.id},{...body,privateKey:'PRIVATE_KEY_DO_NOT_ECHO'}, {...body,deviceId:Buffer.alloc(16).toString('base64url')}, {...body,signature:Buffer.alloc(64).toString('base64url')}]){
        const r=await mutate(f.alice,'POST','/api/keys/devices',b);assert.ok([400,409].includes(r.status));assert.ok(!r.text.includes('PRIVATE_KEY_DO_NOT_ECHO'));}
    assert.equal((await mutate(f.bob,'POST','/api/keys/devices',body)).status,400);
    assert.equal((await mutate(f.bob,'POST','/api/keys/devices',await f.alice.device.signRegistrationAs(f.bob.id))).body.code,'KEY_CONFLICT');
    const stolen=await TestDevice.create(f.bob.id,{deviceId:f.alice.device.deviceId,keyVersion:2});assert.equal((await mutate(f.bob,'POST','/api/keys/devices',await stolen.registration())).status,409);
    const old=await TestDevice.create(f.alice.id);assert.equal((await mutate(f.alice,'POST','/api/keys/devices',await old.registration('2020-01-01T00:00:00.000Z'))).body.code,'KEY_PROOF_INVALID');
    assert.equal(f.db.prepare('SELECT count(*) n FROM DeviceKeys').get().n,2);
});
test('rotation supersedes immutable records, revocation is owner-only and permanent, and device coverage must be renewed',async t=>{
    const f=await keyFixture(t),e=await f.makeEpoch();await f.publish(e);const message=await f.message(e);assert.equal((await f.submit(message)).status,201);
    const rotated=await f.bob.device.rotate();assert.equal((await mutate(f.bob,'POST','/api/keys/devices',await rotated.registration())).status,201);
    assert.equal((await f.submit(message)).status,403);assert.equal((await mutate(f.bob,'POST','/api/keys/devices',f.bob.registration)).status,409);
    const records=(await f.bob.browser.request('/api/keys/devices')).body.items;assert.deepEqual(records.map(d=>d.status).sort(),['active','superseded']);
    const second=await f.makeEpoch();assert.equal((await f.publish(second)).status,201);assert.equal((await f.submit(await f.message(second))).status,201);
    assert.equal((await mutate(f.alice,'POST',`/api/keys/devices/${rotated.deviceId}/revoke`)).status,404);
    assert.equal((await mutate(f.bob,'POST',`/api/keys/devices/${rotated.deviceId}/revoke`)).body.outcome,'revoked');assert.equal((await mutate(f.bob,'POST',`/api/keys/devices/${rotated.deviceId}/revoke`)).body.outcome,'unchanged');
    assert.equal((await mutate(f.bob,'POST','/api/keys/devices',await (await rotated.rotate()).registration())).status,409);
    assert.ok((await f.bob.browser.request('/api/keys/devices')).body.items.every(d=>d.status==='revoked'));
    assert.throws(()=>f.db.prepare("UPDATE DeviceKeys SET agreement_public_key=? WHERE device_key_id=?").run('A'.repeat(87),rotated.deviceKeyId));
    assert.throws(()=>f.db.prepare('DELETE FROM DeviceKeys WHERE device_key_id=?').run(rotated.deviceKeyId));
});
test('epoch publication rejects missing/extra recipients, foreign creator, tampering, stale ordering and signature proofs',async t=>{
    const f=await keyFixture(t),epoch=await f.makeEpoch();const partial=await f.makeEpoch(f.alice,{devices:f.devices.slice(0,1)});
    assert.equal((await f.publish(partial)).body.code,'RECIPIENT_KEYS_CHANGED');
    const outsider=await TestDevice.create(f.carol.id);const outBody=await outsider.registration();await mutate(f.carol,'POST','/api/keys/devices',outBody);
    const extra=await f.makeEpoch(f.alice,{devices:[...f.devices,{...outBody,userId:f.carol.id,deviceKeyId:outsider.deviceKeyId}]});assert.equal((await f.publish(extra)).body.code,'RECIPIENT_KEYS_CHANGED');
    assert.equal((await f.publish(epoch,f.bob)).body.code,'RECIPIENT_KEYS_CHANGED');assert.equal((await f.publish(epoch,f.carol)).status,404);
    assert.equal((await f.publish({body:{...epoch.body,signature:Buffer.alloc(64).toString('base64url')}})).body.code,'KEY_PROOF_INVALID');
    assert.equal((await f.publish({body:{...epoch.body,creatorUserId:f.alice.id}})).status,400);
    assert.equal((await f.publish(epoch)).status,201);assert.equal((await f.publish(await f.makeEpoch(f.alice,{epoch:5}))).body.code,'RECIPIENT_KEYS_CHANGED');
    assert.throws(()=>f.db.prepare('UPDATE ConversationKeyWraps SET ciphertext=?').run('B'.repeat(64)));assert.throws(()=>f.db.prepare('DELETE FROM ConversationKeyEpochs').run());
});
test('public directory, epochs, device management and sending retain session, Origin, CSRF, block and friendship policies',async t=>{
    const f=await keyFixture(t),epoch=await f.makeEpoch();await f.publish(epoch);const envelope=await f.message(epoch);
    assert.equal((await f.browser().request('/api/keys/devices')).status,401);assert.equal((await f.carol.browser.request(f.keysPath)).status,404);assert.equal((await f.carol.browser.request(f.keysPath+'/epochs/'+epoch.body.keyId)).status,404);
    assert.ok((await f.alice.browser.request('/api/keys/devices')).body.items.every(d=>d.userId===f.alice.id));
    for(const url of ['/api/keys/devices',`/api/keys/devices/${f.alice.device.deviceId}/revoke`,f.keysPath+'/epochs']){
        assert.equal((await f.alice.browser.request(url,{method:'POST',body:{}})).status,403);
        assert.equal((await mutate(f.alice,'POST',url,{}, {Origin:'https://evil.example'})).status,403);}
    await mutate(f.alice,'DELETE','/api/friends/'+f.bob.id);assert.equal((await f.bob.browser.request(f.keysPath)).status,200);assert.equal((await f.publish(await f.makeEpoch())).status,403);assert.equal((await f.submit(envelope)).status,403);
    await mutate(f.bob,'POST','/api/blocks',{userId:f.alice.id});assert.equal((await f.alice.browser.request(f.keysPath)).status,404);assert.equal((await f.bob.browser.request(f.keysPath+'/epochs/'+epoch.body.keyId)).status,404);
    const browser=f.alice.browser.clone();await f.alice.browser.post('/api/auth/logout');assert.equal((await browser.request('/api/keys/devices')).status,401);
    f.db.prepare('UPDATE Sessions SET expires_at_ms=? WHERE user_id=?').run(Date.now()-1,f.bob.id);
    assert.equal((await f.bob.browser.request('/api/keys/devices')).status,401);assert.equal((await f.bob.browser.request(f.keysPath)).status,401);
});
test('missing verifier, directory failures and standalone v2 writes without an atomic key recheck fail closed',async t=>{
    const f=await keyFixture(t),epoch=await f.makeEpoch();await f.publish(epoch);const envelope=await f.message(epoch),actor=actorContext(f,f.alice);
    const options={db:f.db,auth:f.application.auth,conversations:f.application.conversations};
    await assert.rejects(createMessageService(options).submit(actor.context,actor.proof,f.conversationId,envelope),{code:'RECIPIENT_KEYS_UNAVAILABLE'});
    await assert.rejects(createMessageService({...options,recipientKeyVerifier:f.application.keys.verifier}).submit(actor.context,actor.proof,f.conversationId,envelope),{code:'RECIPIENT_KEYS_UNAVAILABLE'});
    const {protocol}=require('../server/e2ee/protocol');const bad=protocol.createRecipientKeyVerifier({directory:{loadConversationKeyState(){throw Error('PRIVATE_DIAGNOSTIC');}}});
    await assert.rejects(createMessageService({...options,recipientKeyVerifier:bad}).submit(actor.context,actor.proof,f.conversationId,envelope),{code:'RECIPIENT_KEYS_UNAVAILABLE'});
    assert.equal(f.db.prepare('SELECT count(*) n FROM Messages').get().n,0);
});
test('key HTTP payload limits, type/encoding errors, query spoofing and shared rate limits fail safely',async t=>{
    const f=await keyFixture(t);const headers={'X-CSRF-Token':f.alice.token};
    assert.equal((await f.alice.browser.request('/api/keys/devices',{method:'POST',rawBody:'x'.repeat(8193),headers})).status,413);
    assert.equal((await f.alice.browser.request(f.keysPath+'/epochs',{method:'POST',rawBody:'x'.repeat(16385),headers})).status,413);
    assert.equal((await mutate(f.alice,'POST',f.keysPath+'/epochs/',{padding:'x'.repeat(10000)})).status,400);
    assert.equal((await f.alice.browser.request('/api/keys/devices',{method:'POST',rawBody:'x',headers:{...headers,'Content-Type':'text/plain'}})).status,415);
    assert.equal((await f.alice.browser.request('/api/keys/devices?userId='+f.bob.id)).status,400);
    for(let i=0;i<119;i++)f.application.keys.rate(false,{userId:f.alice.id},'fixture');const other=await f.anotherServer();const browser=f.alice.browser.clone();browser.origin=other.origin;
    assert.equal((await browser.request('/api/keys/devices',{headers:{'X-Forwarded-For':'1.2.3.4'}})).status,429);
});
