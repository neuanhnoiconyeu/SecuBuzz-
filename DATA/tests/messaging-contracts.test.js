const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {messagingFixture,encrypted,submit,actorContext,loadTypeScript}=require('./support/messaging');
const {mutate}=require('./support/social');const {fingerprint}=require('../server/messaging/validation');

test('DATA validation/fingerprint and bound outcomes match the actual read-only Kiro module',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);
    const kiro=await loadTypeScript(path.resolve(__dirname,'../../server/src/realtime/validation.ts'));
    assert.deepEqual(kiro.parseMessageEnvelope(envelope,{maxCiphertextLength:65536}),envelope);
    assert.equal(fingerprint(envelope),kiro.envelopeFingerprint(envelope));const actor=actorContext(f,f.alice);
    const store=f.application.messaging.bindStore(actor.context,actor.proof);const request={envelope,fingerprint:kiro.envelopeFingerprint(envelope),receivedAt:new Date()};
    const made=await store.storeMessage(request);assert.equal(made.outcome,'created');assert.ok(made.storedAt instanceof Date);
    const repeated=await store.storeMessage(request);assert.equal(repeated.outcome,'duplicate');assert.equal(repeated.storedAt.toISOString(),made.storedAt.toISOString());
    const restRetry=await submit(f,f.alice,envelope);assert.equal(restRetry.body.outcome,'duplicate');assert.equal(restRetry.body.message.storedAt,made.storedAt.toISOString());
    assert.deepEqual(await store.findMessage(f.conversationId,envelope.id),{conversationId:f.conversationId,messageId:envelope.id,senderId:f.alice.id});
    const changed=await encrypted(f.alice,f.conversationId,envelope.id,'Changed fixture');
    assert.deepEqual(await store.storeMessage({envelope:changed.envelope,fingerprint:fingerprint(changed.envelope),receivedAt:new Date()}),{outcome:'conflict'});
});
test('actor-bound receipt adapter records eligible read and delivery acknowledgements without accepting a forged observer',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);await submit(f,f.alice,envelope);
    const actor=actorContext(f,f.bob);const bound=f.application.messaging.bindStore(actor.context,actor.proof);const receipt={conversationId:f.conversationId,messageId:envelope.id,userId:f.bob.id,status:'delivered',observedAt:new Date()};
    const result=await bound.recordReceipt(receipt);assert.equal(result.outcome,'created');assert.ok(result.recordedAt instanceof Date);
    assert.equal((await bound.recordReceipt(receipt)).recordedAt.toISOString(),result.recordedAt.toISOString());
    assert.equal((await bound.recordReceipt({...receipt,status:'read'})).outcome,'created');
    await assert.rejects(bound.recordReceipt({...receipt,userId:f.alice.id}),{code:'FORBIDDEN'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM MessageReceipts').get().n,2);
});
test('identical receipt retries remain idempotent after a tombstone without creating new receipts',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);const message=(await submit(f,f.alice,envelope)).body.message;
    const before=await mutate(f.bob,'POST',`/api/messages/${message.storageId}/read`);await mutate(f.alice,'DELETE','/api/messages/'+message.storageId);
    const after=await mutate(f.bob,'POST',`/api/messages/${message.storageId}/read`);assert.equal(after.status,200);assert.equal(after.body.outcome,'duplicate');assert.deepEqual(after.body.receipt,before.body.receipt);
});
test('client timestamp and sender name AAD remain original on a duplicate after a profile rename',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);const first=await submit(f,f.alice,envelope);
    await mutate(f.alice,'PATCH','/api/users/me',{displayName:'Renamed Alice'});const again=await submit(f,f.alice,envelope);assert.equal(again.status,200);assert.deepEqual(again.body.message,first.body.message);
    const fresh=await encrypted(f.alice,f.conversationId,'new-old-name');assert.equal((await submit(f,f.alice,fresh.envelope)).status,403);
});
