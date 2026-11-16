const {test}=require('node:test');
const assert=require('node:assert/strict');
const {messagingFixture,encrypted,submit,worker}=require('./support/messaging');
const {mutate}=require('./support/social');

test('valid actual client encryption persists unchanged with authoritative metadata and decrypts using original AAD',async t=>{
    const f=await messagingFixture(t);const fixture=await encrypted(f.alice,f.conversationId);const made=await submit(f,f.alice,fixture.envelope);
    assert.equal(made.status,201);assert.equal(made.body.outcome,'created');const message=made.body.message;
    assert.equal(message.id,fixture.envelope.id);assert.notEqual(message.storageId,message.id);assert.equal(message.sequence,1);assert.equal(message.state,'active');assert.equal(message.revision,0);
    const row=f.db.prepare('SELECT * FROM Messages').get();assert.equal(row.origin,'authenticated');assert.equal(row.client_id,fixture.envelope.id);
    assert.equal(row.sender_id,f.alice.id);assert.equal(row.receiver_id,f.bob.id);assert.equal(row.ciphertext,fixture.envelope.encryption.ciphertext);
    assert.equal(row.iv,fixture.envelope.encryption.iv);assert.equal(row.sender_name,fixture.envelope.senderName);assert.equal(row.client_timestamp,fixture.envelope.timestamp);
    const history=await f.bob.browser.request(`/api/conversations/${f.conversationId}/messages`);assert.equal(history.status,200);assert.equal(history.body.items.length,1);
    const m=history.body.items[0];const plaintext=await fixture.client.decryptMessage(m.encryption,fixture.key,{conversationId:m.conversationId,messageId:m.id,senderId:m.senderId,senderName:m.senderName,timestamp:m.timestamp});
    assert.equal(plaintext,'Isolated encrypted fixture');assert.ok(!history.text.includes('Isolated encrypted fixture'));assert.equal(history.headers.get('Cache-Control'),'no-store');
});

test('identical retries preserve the same storage ID, sequence, envelope and first storedAt',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);const first=await submit(f,f.alice,envelope),retry=await submit(f,f.alice,envelope);
    assert.equal(first.status,201);assert.equal(retry.status,200);assert.equal(retry.body.outcome,'duplicate');assert.deepEqual(retry.body.message,first.body.message);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='message.stored'").get().n,1);
});

test('same client ID with changed envelope or another sender produces an idempotency conflict',async t=>{
    const f=await messagingFixture(t);const original=await encrypted(f.alice,f.conversationId);assert.equal((await submit(f,f.alice,original.envelope)).status,201);
    const changed=await encrypted(f.alice,f.conversationId,original.envelope.id,'Different encrypted fixture');assert.equal((await submit(f,f.alice,changed.envelope)).status,409);
    const other=await encrypted({...f.bob,displayName:'Bob'},f.conversationId,original.envelope.id);assert.equal((await submit(f,f.bob,other.envelope)).status,409);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,1);
});

test('read receipts are recipient-only, durable and idempotent, with no body identity override',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);const message=(await submit(f,f.alice,envelope)).body.message;
    const url=`/api/messages/${message.storageId}/read`;
    assert.equal((await mutate(f.alice,'POST',url)).status,403);assert.equal((await mutate(f.carol,'POST',url)).status,404);
    assert.equal((await mutate(f.bob,'POST',url,{userId:f.alice.id})).status,400);
    const first=await mutate(f.bob,'POST',url),again=await mutate(f.bob,'POST',url,{});
    assert.equal(first.status,200);assert.equal(first.body.outcome,'created');assert.equal(again.body.outcome,'duplicate');assert.deepEqual(first.body.receipt,again.body.receipt);
    assert.equal(first.body.receipt.userId,f.bob.id);assert.equal(f.db.prepare('SELECT count(*) AS n FROM MessageReceipts').get().n,1);
});

test('sender deletion creates a stable global tombstone, keeps ciphertext in storage and never resurrects on retry',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);const original=(await submit(f,f.alice,envelope)).body.message;
    const url='/api/messages/'+original.storageId;
    assert.equal((await mutate(f.bob,'DELETE',url)).status,403);assert.equal((await mutate(f.carol,'DELETE',url)).status,404);
    const removed=await mutate(f.alice,'DELETE',url),duplicate=await mutate(f.alice,'DELETE',url);
    assert.equal(removed.status,200);assert.equal(removed.body.message.state,'deleted');assert.equal(removed.body.message.encryption,null);assert.equal(removed.body.message.revision,1);
    assert.deepEqual(removed.body,duplicate.body);assert.equal(f.db.prepare('SELECT ciphertext FROM Messages').get().ciphertext,envelope.encryption.ciphertext);
    const history=await f.bob.browser.request(`/api/conversations/${f.conversationId}/messages`);assert.equal(history.body.items[0].state,'deleted');assert.equal(history.body.items[0].encryption,null);
    const retried=await submit(f,f.alice,envelope);assert.equal(retried.status,200);assert.equal(retried.body.message.state,'deleted');assert.equal(retried.body.message.storedAt,original.storedAt);
    assert.equal((await mutate(f.bob,'POST',url+'/read')).status,404);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,1);
});

test('editing is explicitly deferred after sender authorization; unauthorized access does not reveal it',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);const original=(await submit(f,f.alice,envelope)).body.message;
    const url='/api/messages/'+original.storageId;
    assert.equal((await mutate(f.bob,'PATCH',url,{})).status,403);assert.equal((await mutate(f.carol,'PATCH',url,{})).status,404);
    const own=await mutate(f.alice,'PATCH',url,{});assert.equal(own.status,503);assert.equal(own.body.code,'FEATURE_UNAVAILABLE');
    assert.equal(f.db.prepare('SELECT ciphertext FROM Messages').get().ciphertext,envelope.encryption.ciphertext);
});

test('isolated real HTTP storage scenario persists ciphertext, idempotency and receipts across native backend restart',async t=>{
    const f=await messagingFixture(t);const first=await worker(f);
    const actors=[f.alice,f.bob,f.carol].map(actor=>{const browser=actor.browser.clone();browser.origin=first.browser.origin;return {...actor,browser};});const [alice,bob,charlie]=actors;
    for(const actor of [alice,bob])assert.equal((await actor.browser.request('/api/conversations/'+f.conversationId)).status,200);
    const {envelope}=await encrypted(alice,f.conversationId);const made=await submit(f,alice,envelope);assert.equal(made.status,201);const storageId=made.body.message.storageId;
    assert.equal((await submit(f,alice,envelope)).status,200);assert.equal((await charlie.browser.request(`/api/conversations/${f.conversationId}/messages`)).status,404);
    assert.equal((await mutate(bob,'POST',`/api/messages/${storageId}/read`)).status,200);await first.stop();
    const second=await worker(f);for(const actor of actors)actor.browser.origin=second.browser.origin;
    const history=await bob.browser.request(`/api/conversations/${f.conversationId}/messages?limit=1`);assert.equal(history.body.items[0].storageId,storageId);assert.deepEqual(history.body.items[0].encryption,envelope.encryption);
    const again=await submit(f,alice,envelope);assert.equal(again.body.outcome,'duplicate');assert.equal(again.body.message.storedAt,made.body.message.storedAt);
    assert.equal((await mutate(bob,'POST',`/api/messages/${storageId}/read`)).body.outcome,'duplicate');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM MessageReceipts').get().n,1);
    await mutate(bob,'POST','/api/blocks',{userId:alice.id});assert.equal((await submit(f,alice,envelope)).status,404);
    assert.equal((await bob.browser.request(`/api/conversations/${f.conversationId}/messages`)).status,404);
});
