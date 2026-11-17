const {test}=require('node:test');const assert=require('node:assert/strict');
const {messagingFixture,encrypted,submit,worker}=require('./support/messaging');const {mutate}=require('./support/social');

test('six identical retries through independent native processes commit one ciphertext and one audit event',async t=>{
    const f=await messagingFixture(t);const a=await worker(f),b=await worker(f);const first=f.alice.browser.clone(),second=f.alice.browser.clone();first.origin=a.browser.origin;second.origin=b.browser.origin;
    const actors=[{...f.alice,browser:first},{...f.alice,browser:second}],{envelope}=await encrypted(f.alice,f.conversationId);
    const responses=await Promise.all(Array.from({length:6},(_,i)=>submit(f,actors[i%2],envelope)));
    assert.equal(responses.filter(r=>r.status===201).length,1);assert.equal(responses.filter(r=>r.status===200).length,5);assert.equal(new Set(responses.map(r=>r.body.message.storageId)).size,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,1);assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='message.stored'").get().n,1);
});
test('racing changed-content retries create one message and one deterministic conflict',async t=>{
    const f=await messagingFixture(t);const remote=await worker(f);const browser=f.alice.browser.clone();browser.origin=remote.browser.origin;
    const a=await encrypted(f.alice,f.conversationId,'race'),b=await encrypted(f.alice,f.conversationId,'race','Different fixture');
    const results=await Promise.all([submit(f,f.alice,a.envelope),submit(f,{...f.alice,browser},b.envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,1);
});
test('audit failure rolls back message, sequence and conversation timestamp with no partial receipt',async t=>{
    const f=await messagingFixture(t);const before=f.db.prepare('SELECT updated_at FROM Conversations').get().updated_at;
    f.db.exec("CREATE TRIGGER reject_message_audit BEFORE INSERT ON AuditLogs WHEN NEW.source='messaging' BEGIN SELECT RAISE(ABORT,'PRIVATE_AUDIT_FAILURE'); END;");
    const {envelope}=await encrypted(f.alice,f.conversationId);const failed=await submit(f,f.alice,envelope);assert.equal(failed.status,500);assert.ok(!failed.text.includes('PRIVATE_AUDIT_FAILURE'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM MessageReceipts').get().n,0);assert.equal(f.db.prepare('SELECT updated_at FROM Conversations').get().updated_at,before);
    f.db.exec('DROP TRIGGER reject_message_audit');const good=await submit(f,f.alice,envelope);assert.equal(good.status,201);assert.equal(good.body.message.sequence,1);
});
test('tombstone and read-receipt audit failures roll back lifecycle state completely',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);const message=(await submit(f,f.alice,envelope)).body.message;
    f.db.exec("CREATE TRIGGER reject_message_lifecycle BEFORE INSERT ON AuditLogs WHEN NEW.source='messaging' BEGIN SELECT RAISE(ABORT,'rollback'); END;");
    assert.equal((await mutate(f.alice,'DELETE','/api/messages/'+message.storageId)).status,500);assert.equal(f.db.prepare('SELECT deleted_at FROM Messages').get().deleted_at,null);
    assert.equal((await mutate(f.bob,'POST',`/api/messages/${message.storageId}/read`)).status,500);assert.equal(f.db.prepare('SELECT count(*) AS n FROM MessageReceipts').get().n,0);
});
