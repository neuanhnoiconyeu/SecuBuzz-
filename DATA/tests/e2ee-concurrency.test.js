const {test}=require('node:test');const assert=require('node:assert/strict');
const {keyFixture,TestDevice,mutate}=require('./support/e2ee');const {childBackend}=require('./support/auth');
async function peers(f){const servers=await Promise.all([childBackend(f),childBackend(f)]);return servers.map(s=>{const actor={...f.alice,browser:f.alice.browser.clone()};actor.browser.origin=s.browser.origin;return actor;});}
test('two independent DATA processes racing device registration insert one record with one audit event',async t=>{
    const f=await keyFixture(t),actors=await peers(f),d=await TestDevice.create(f.alice.id),body=await d.registration();
    const results=await Promise.all(actors.map(a=>mutate(a,'POST','/api/keys/devices',body)));assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
    assert.equal(f.db.prepare('SELECT count(*) n FROM DeviceKeys WHERE device_key_id=?').get(d.deviceKeyId).n,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM AuditLogs WHERE subject_id=?').get(d.deviceKeyId).n,1);
});
test('concurrent different epochs at the same version serialize across native processes',async t=>{
    const f=await keyFixture(t),actors=await peers(f),epochs=await Promise.all([f.makeEpoch(),f.makeEpoch()]);
    const results=await Promise.all(actors.map((a,i)=>mutate(a,'POST',f.keysPath+'/epochs',epochs[i].body)));
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(results.find(r=>r.status===409).body.code,'RECIPIENT_KEYS_CHANGED');
    assert.equal(f.db.prepare('SELECT count(*) n FROM ConversationKeyEpochs').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ConversationKeyWraps').get().n,2);
});
test('six verified v2 retries through two native processes store one ciphertext with stable metadata',async t=>{
    const f=await keyFixture(t),e=await f.makeEpoch();await f.publish(e);const envelope=await f.message(e),actors=await peers(f);
    const results=await Promise.all(Array.from({length:6},(_,i)=>mutate(actors[i%2],'POST',`/api/conversations/${f.conversationId}/messages`,envelope)));
    assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===200).length,5);
    for(const r of results)assert.deepEqual(r.body.message,results[0].body.message);
    assert.equal(f.db.prepare('SELECT count(*) n FROM Messages').get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE event_type='message.stored'").get().n,1);
});
for(const change of ['revoke','rotate epoch','new device'])test('atomic key recheck refuses a '+change+' committed after genuine async verification',async t=>{
    let f,entered,release;const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
    f=await keyFixture(t,{messageOptions:{recipientKeyVerifier:{async verifyEnvelope(...args){const result=await f.application.keys.verifier.verifyEnvelope(...args);assert.deepEqual(result,{verified:true});entered();await held;return result;}}}});
    const e=await f.makeEpoch();await f.publish(e);const sending=f.submit(await f.message(e));await started;assert.equal(f.db.inTransaction,false);
    if(change==='revoke')assert.equal((await mutate(f.bob,'POST',`/api/keys/devices/${f.bob.device.deviceId}/revoke`)).status,200);
    else if(change==='rotate epoch')assert.equal((await f.publish(await f.makeEpoch())).status,201);
    else assert.equal((await mutate(f.bob,'POST','/api/keys/devices',await (await TestDevice.create(f.bob.id)).registration())).status,201);
    release();const result=await sending;assert.equal(result.status,403);assert.equal(result.body.code,'RECIPIENT_KEYS_UNVERIFIED');assert.equal(f.db.prepare('SELECT count(*) n FROM Messages').get().n,0);
});
test('key registration, revocation and epoch audit failures roll back their complete transitions',async t=>{
    const f=await keyFixture(t),d=await f.bob.device.rotate();
    f.db.exec("CREATE TRIGGER fail_key_audit BEFORE INSERT ON AuditLogs WHEN NEW.source='e2ee' BEGIN SELECT RAISE(ABORT,'PRIVATE_FAILURE'); END");
    const result=await mutate(f.bob,'POST','/api/keys/devices',await d.registration());assert.equal(result.status,500);assert.ok(!result.text.includes('PRIVATE_FAILURE'));
    assert.equal(f.application.keys.repository.device(f.bob.device.deviceKeyId).status,'active');assert.equal(f.application.keys.repository.device(d.deviceKeyId),null);
    assert.equal((await mutate(f.bob,'POST',`/api/keys/devices/${f.bob.device.deviceId}/revoke`)).status,500);assert.equal(f.application.keys.repository.device(f.bob.device.deviceKeyId).status,'active');
    assert.equal((await f.publish(await f.makeEpoch())).status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM ConversationKeyEpochs').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ConversationKeyWraps').get().n,0);
});
