const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {keyFixture,TestDevice,mutate,actorContext}=require('./support/e2ee');
const {childBackend}=require('./support/auth');const {encrypted}=require('./support/messaging');
const {protocol}=require('../server/e2ee/protocol');
test('six actual HTTP key APIs persist public records and verified v2 ciphertext decryptable by an independent recipient',async t=>{
    const f=await keyFixture(t),epoch=await f.makeEpoch();const first=await f.publish(epoch);assert.equal(first.status,201);assert.deepEqual((await f.publish(epoch)).body,first.body);
    const state=await f.bob.browser.request(f.keysPath);assert.equal(state.status,200);assert.equal(state.body.devices.length,2);assert.equal(state.body.epochs.length,1);
    assert.deepEqual((await f.bob.browser.request(f.keysPath+'/epochs/'+epoch.body.keyId)).body,first.body);
    const recipientKey=await f.bob.device.openEpoch(first.body.epoch,state.body.devices),plain='NEVER_STORE_THIS_PRIVATE_TEXT';
    const envelope=await f.message(epoch,'stable-v2-id',plain);assert.deepEqual(protocol.parseMessageEnvelopeV2(envelope),envelope);
    const created=await f.submit(envelope);assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.message.encryption.keyId,epoch.body.keyId);
    assert.deepEqual((await f.submit(envelope)).body.message,created.body.message);assert.equal((await f.submit({...envelope,encryption:{...envelope.encryption,iv:Buffer.alloc(12).toString('base64')}})).status,409);
    assert.equal(await TestDevice.decrypt(recipientKey,envelope),plain);
    const stored=await f.bob.browser.request(`/api/conversations/${f.conversationId}/messages`);assert.deepEqual(stored.body.items[0].encryption,envelope.encryption);
    assert.equal((await mutate(f.bob,'POST','/api/messages/'+created.body.message.storageId+'/read')).status,200);
    const token=actorContext(f,f.alice),store=f.application.messaging.bindStore(token.context,token.proof);
    assert.equal((await store.storeMessage({envelope,fingerprint:protocol.envelopeV2Fingerprint(envelope),receivedAt:new Date()})).outcome,'duplicate');
    assert.equal((await f.alice.browser.request('/api/keys/devices')).body.items.length,1);
    assert.equal((await f.carol.browser.request(f.keysPath)).status,404);
    for(const name of ['DeviceKeys','ConversationKeyEpochs','ConversationKeyWraps','Messages','AuditLogs'])assert.ok(!JSON.stringify(f.db.prepare(`SELECT * FROM ${name}`).all()).includes(plain));
    for(const file of fs.readdirSync(f.directory))assert.ok(!fs.readFileSync(require('node:path').join(f.directory,file)).includes(Buffer.from(plain)));
    const item='/api/messages/'+created.body.message.storageId;assert.equal((await mutate(f.alice,'DELETE',item)).status,200);assert.equal((await f.submit(envelope)).body.message.state,'deleted');
    assert.equal((await mutate(f.bob,'POST',item+'/read')).body.outcome,'duplicate');
});
test('native DATA restart retains device keys, signed epochs, wraps, v2 history, receipts and idempotency',async t=>{
    const f=await keyFixture(t),epoch=await f.makeEpoch();await f.publish(epoch);const envelope=await f.message(epoch);
    await f.application.close(); // The fixture connection remains an observer; its HTTP service stops.
    const first=await childBackend(f),writer={...f.alice,browser:f.alice.browser.clone()},reader={...f.bob,browser:f.bob.browser.clone()};
    writer.browser.origin=first.browser.origin;reader.browser.origin=first.browser.origin;
    const saved=await mutate(writer,'POST',`/api/conversations/${f.conversationId}/messages`,envelope);assert.equal(saved.status,201);const original=saved.body.message;
    const receipt=await mutate(reader,'POST','/api/messages/'+original.storageId+'/read');assert.equal(receipt.status,200);
    assert.equal((await reader.browser.request(f.keysPath)).body.currentEpoch.keyId,epoch.body.keyId);await first.stop();
    const server=await childBackend(f);const alice={...f.alice,browser:f.alice.browser.clone()},bob={...f.bob,browser:f.bob.browser.clone()};alice.browser.origin=server.browser.origin;bob.browser.origin=server.browser.origin;
    const state=await bob.browser.request(f.keysPath);assert.equal(state.body.currentEpoch.keyId,epoch.body.keyId);assert.equal(state.body.devices.length,2);
    assert.equal((await mutate(alice,'POST','/api/keys/devices',f.alice.registration)).status,200);
    const response=await mutate(alice,'POST',`/api/conversations/${f.conversationId}/messages`,envelope);assert.equal(response.status,200);assert.deepEqual(response.body.message,original);
    assert.deepEqual((await mutate(bob,'POST','/api/messages/'+original.storageId+'/read')).body.receipt,receipt.body.receipt);
    assert.deepEqual((await bob.browser.request(`/api/conversations/${f.conversationId}/messages`)).body.items[0],original);
    assert.equal((await mutate(bob,'POST',`/api/keys/devices/${f.bob.device.deviceId}/revoke`)).body.outcome,'revoked');
    assert.equal((await mutate(alice,'POST',`/api/conversations/${f.conversationId}/messages`,envelope)).status,403);
});
test('real verifier refuses v1, unknown keyIds and stale epochs while authorized historical v1 and v2 remain readable',async t=>{
    const f=await keyFixture(t),epoch=await f.makeEpoch();await f.publish(epoch);const envelope=await f.message(epoch);assert.equal((await f.submit(envelope)).status,201);
    const v1=await encrypted(f.alice,f.conversationId);assert.equal((await f.submit(v1.envelope)).status,403);
    const old=v1.envelope;f.application.messaging.repositories.messages.insertAuthenticated({message_id:'historical-v1',conversation_id:f.conversationId,sender_id:f.alice.id,receiver_id:f.bob.id,
        ciphertext:old.encryption.ciphertext,iv:old.encryption.iv,envelope_version:1,encoding:'base64',sender_name:old.senderName,client_timestamp:old.timestamp,
        message_type:'text',fingerprint:require('../server/messaging/validation').fingerprint(old),client_id:'historical-wire-id',message_seq:2,created_at:old.timestamp});
    assert.equal((await f.submit({...envelope,id:'unknown-key',encryption:{...envelope.encryption,keyId:Buffer.alloc(16).toString('base64url')}})).status,403);
    const next=await f.makeEpoch();assert.equal((await f.publish(next)).status,201);assert.equal((await f.submit(envelope)).status,403);
    assert.equal((await f.bob.browser.request(f.keysPath+'/epochs/'+epoch.body.keyId)).status,200);const history=(await f.bob.browser.request(`/api/conversations/${f.conversationId}/messages`)).body.items;assert.equal(history.length,2);assert.equal(history[0].encryption.version,1);
    assert.equal((await f.submit(await f.message(next))).status,201);
});
test('epoch lists paginate at 20 with actor-bound cursors and include complete signed device wraps',async t=>{
    const f=await keyFixture(t);for(let i=0;i<22;i++){const e=await f.makeEpoch();assert.equal((await f.publish(e)).status,201);}
    const first=(await f.alice.browser.request(f.keysPath)).body;assert.equal(first.epochs.length,20);assert.ok(first.cursor);assert.equal(first.epochs[0].epoch,22);
    const next=(await f.alice.browser.request(f.keysPath+'?cursor='+first.cursor)).body;assert.deepEqual(next.epochs.map(e=>e.epoch),[2,1]);assert.equal(next.cursor,null);
    assert.equal((await f.bob.browser.request(f.keysPath+'?cursor='+first.cursor)).status,400);assert.equal((await f.alice.browser.request(f.keysPath+'?cursor=bad')).status,400);
    assert.ok(first.epochs.every(e=>e.wraps.length===2));
});
