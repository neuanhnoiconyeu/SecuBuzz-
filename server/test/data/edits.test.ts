import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,after,describe,test} from 'node:test';
import {DataStack,type Person} from './support/stack.ts';
import {Browser} from '../e2ee/support/dataApp.ts';
import {TestDevice} from '../e2ee/support/deviceClient.ts';
import {editStatement,editCore,EDIT_CONTENT_PREFIX} from '../../../shared/messageRevisions.ts';
import {envelopeV2Fingerprint,parseMessageEnvelopeV2,editProofHash} from '../../src/e2ee/index.ts';

describe('authenticated append-only encrypted edits',()=>{
  let stack:DataStack;
  before(async()=>{stack=await DataStack.start();});after(async()=>{await stack?.close();});
  async function original(a:Person,cid:string,epoch:Awaited<ReturnType<DataStack['publishEpoch']>>,text='Original text\nUnicode 🇻🇳'){
    const r=await a.browser.mutate('POST',`/api/conversations/${cid}/messages`,await stack.envelope(a,cid,epoch,text));assert.equal(r.status,201);return r.body.message;
  }
  async function candidate(a:Person,m:any,key:Awaited<ReturnType<DataStack['publishEpoch']>>,text:string,overrides:Record<string,unknown>={}){
    const previous=m.edit?.proofs.at(-1)?.proof;
    const core={v:1 as const,storageId:m.storageId,messageId:m.id,conversationId:m.conversationId,senderId:a.id,revision:(previous?.revision??0)+1,
      operationId:randomUUID(),previousHash:previous?editProofHash(previous):envelopeV2Fingerprint(m),
      keyId:key.keyId,signerDeviceKeyId:a.device.deviceKeyId,editedAt:new Date().toISOString(),...overrides};
    const e=await a.device.encrypt(key.key,key.keyId,{conversationId:m.conversationId,id:core.operationId,senderName:m.senderName,timestamp:core.editedAt},EDIT_CONTENT_PREFIX+JSON.stringify({core:editCore(core),content:text}));
    const p={...core,envelopeHash:envelopeV2Fingerprint(parseMessageEnvelopeV2(e)!)};
    return {proof:{...p,signature:await a.device.sign(editStatement(p))},envelope:e};
  }
  test('two accounts receive authorized edit hints and immutable history with a signed encrypted Unicode revision',async()=>{
    const {alice,bob,conversationId,epoch,bobKey}=await stack.pair(),m=await original(alice,conversationId,epoch);
    const a=await stack.connect(alice),b=await stack.connect(bob),mark=b.mark();
    const body=await candidate(alice,m,epoch,'Edited first line 👩🏽‍💻\nTiếng Việt 🇻🇳'),response=await alice.browser.mutate('PATCH',`/api/messages/${m.storageId}`,body);
    assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.outcome,'created');assert.equal(response.body.edit.revision,1);
    assert.deepEqual(await b.waitFor('message:edited',()=>true,{since:mark}),{conversationId,messageId:m.id});
    assert.deepEqual(await a.waitFor('message:edited'),{conversationId,messageId:m.id});
    for(const person of [alice,bob]){
      const latest=(await stack.history(person,conversationId)).items[0],{edit,...base}=latest;
      assert.deepEqual(base,m);assert.deepEqual(edit.envelope,body.envelope);assert.deepEqual(edit.proofs[0].proof,body.proof);
      const decoded=JSON.parse((await TestDevice.decrypt(person===alice?epoch.key:bobKey.key,edit.envelope)).slice(EDIT_CONTENT_PREFIX.length));
      assert.equal(decoded.content,'Edited first line 👩🏽‍💻\nTiếng Việt 🇻🇳');assert.deepEqual(decoded.core,editCore(body.proof));
    }
    assert.ok(!stack.fixture.databaseText().includes('Edited first line'));assert.ok(!JSON.stringify(response.body).includes(body.envelope.encryption.ciphertext));
    const retry=await alice.browser.mutate('PATCH',`/api/messages/${m.storageId}`,body);assert.equal(retry.body.outcome,'duplicate');assert.deepEqual(retry.body.edit,response.body.edit);
  });
  test('original sender, session, CSRF and membership are authoritative; tampering and invalid sequences fail',async()=>{
    const {alice,bob,conversationId,epoch}=await stack.pair('permissions-a','permissions-b'),m=await original(alice,conversationId,epoch),stranger=await stack.person('outsider');
    const body=await candidate(alice,m,epoch,'Changed'),route=`/api/messages/${m.storageId}`;
    assert.equal((await bob.browser.mutate('PATCH',route,body)).status,403);
    assert.equal((await stranger.browser.mutate('PATCH',route,body)).status,404);
    assert.equal((await new Browser(stack.url).request(route,{method:'PATCH',body})).status,401);
    assert.equal((await alice.browser.request(route,{method:'PATCH',body})).status,403);
    assert.equal((await alice.browser.mutate('PATCH',`/api/messages/${m.id}`,body)).status,404);
    for(const bad of [
      {...body,proof:{...body.proof,revision:2}},
      {...body,proof:{...body.proof,storageId:randomUUID()}},
      {...body,proof:{...body.proof,senderId:bob.id}},
      {...body,envelope:{...body.envelope,encryption:{...body.envelope.encryption,ciphertext:Buffer.alloc(32).toString('base64')}}},
      {...body,proof:{...body.proof,signerDeviceKeyId:bob.device.deviceKeyId}},
      {...body,userId:alice.id},
    ])assert.equal((await alice.browser.mutate('PATCH',route,bad)).status,400);
    for(const overrides of [{revision:2},{previousHash:'0'.repeat(64)}])assert.equal((await alice.browser.mutate('PATCH',route,await candidate(alice,m,epoch,'Gap',overrides))).status,409);
    assert.deepEqual((await stack.history(bob,conversationId)).items,[m]);
  });
  test('concurrent edits use compare-and-swap, preserve idempotency and cannot overwrite the base envelope',async()=>{
    const {alice,bob,conversationId,epoch}=await stack.pair('cas-a','cas-b'),m=await original(alice,conversationId,epoch),route=`/api/messages/${m.storageId}`;
    const one=await candidate(alice,m,epoch,'First'),two=await candidate(alice,m,epoch,'Second');
    const results=await Promise.all([alice.browser.mutate('PATCH',route,one),alice.browser.mutate('PATCH',route,two)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const winner=results[0]!.status===200?one:two;
    const latest=(await stack.history(bob,conversationId)).items[0];assert.equal(latest.edit.proofs.length,1);
    const next=await candidate(alice,latest,epoch,'Third\nline');assert.equal((await alice.browser.mutate('PATCH',route,next)).status,200);
    assert.equal((await alice.browser.mutate('PATCH',route,winner)).body.outcome,'duplicate');
    assert.equal((await alice.browser.mutate('PATCH',route,await candidate(alice,m,epoch,'Replay new operation'))).status,409);
    const changed=await candidate(alice,m,epoch,'Conflict',{operationId:winner.proof.operationId});assert.equal((await alice.browser.mutate('PATCH',route,changed)).status,409);
    const replay=await alice.browser.mutate('POST',`/api/conversations/${conversationId}/messages`,{...m,encryption:next.envelope.encryption});assert.ok([400,409].includes(replay.status));
    const db=stack.data.application.db;assert.ok(db);
    assert.throws(()=>db.prepare("UPDATE Messages SET ciphertext='overwrite' WHERE message_id=?").run(m.storageId),/immutable/);
    assert.throws(()=>db.prepare('DELETE FROM MessageEditRevisions WHERE message_id=?').run(m.storageId),/immutable/);
    assert.throws(()=>db.prepare("UPDATE MessageEditRevisions SET proof_hash=? WHERE message_id=?").run('f'.repeat(64),m.storageId),/immutable/);
  });
  test('Unsend remains terminal, removes edit presentation, blocks replay and invalidates post-unsend edits',async()=>{
    const {alice,bob,conversationId,epoch}=await stack.pair('terminal-a','terminal-b'),m=await original(alice,conversationId,epoch),route=`/api/messages/${m.storageId}`;
    const body=await candidate(alice,m,epoch,'Before unsend');assert.equal((await alice.browser.mutate('PATCH',route,body)).status,200);
    const removed=await alice.browser.mutate('DELETE',route);assert.equal(removed.status,200);assert.equal(removed.body.message.edit,undefined);
    assert.equal((await alice.browser.mutate('PATCH',route,body)).status,404);
    assert.deepEqual((await stack.history(bob,conversationId)).items,[removed.body.message]);
  });
  test('audit failures roll back revisions and never emit a success hint; exact encrypted retries remain valid',async()=>{
    const {alice,bob,conversationId,epoch}=await stack.pair('audit-a','audit-b'),m=await original(alice,conversationId,epoch),route=`/api/messages/${m.storageId}`;
    const body=await candidate(alice,m,epoch,'Audit protected'),socket=await stack.connect(bob),mark=socket.mark(),db=stack.data.application.db;
    db.exec("CREATE TRIGGER test_edit_audit_failure BEFORE INSERT ON AuditLogs WHEN NEW.event_type='message.edited' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    try{assert.equal((await alice.browser.mutate('PATCH',route,body)).status,500);}finally{db.exec('DROP TRIGGER test_edit_audit_failure');}
    assert.equal(db.prepare('SELECT count(*) AS n FROM MessageEditRevisions WHERE message_id=?').get(m.storageId).n,0);
    assert.deepEqual((await stack.history(bob,conversationId)).items,[m]);assert.equal(socket.events('message:edited',mark).length,0);
    assert.equal((await alice.browser.mutate('PATCH',route,body)).status,200);
  });
  test('key rotation and signer revocation refuse new stale edits while exact committed receipts stay idempotent',async()=>{
    const {alice,bob,conversationId,epoch}=await stack.pair('rotation-a','rotation-b'),m=await original(alice,conversationId,epoch),route=`/api/messages/${m.storageId}`;
    const body=await candidate(alice,m,epoch,'Before rotation');assert.equal((await alice.browser.mutate('PATCH',route,body)).status,200);
    const replacement=await TestDevice.create(alice.id);await stack.registerDevice(alice,replacement);await stack.revokeDevice(alice,alice.device);
    await stack.publishEpoch(alice,conversationId,epoch,replacement);
    assert.equal((await alice.browser.mutate('PATCH',route,body)).body.outcome,'duplicate');
    const latest=(await stack.history(bob,conversationId)).items[0];
    assert.equal((await alice.browser.mutate('PATCH',route,await candidate(alice,latest,epoch,'Revoked signer'))).status,400);
    assert.equal((await stack.history(bob,conversationId)).items[0].edit.proofs.length,1);
  });
  test('Edit racing Unsend cannot create an active revision after a tombstone',async()=>{
    const {alice,bob,conversationId,epoch}=await stack.pair('race-a','race-b'),m=await original(alice,conversationId,epoch),route=`/api/messages/${m.storageId}`;
    const body=await candidate(alice,m,epoch,'Race edit');const result=await Promise.all([alice.browser.mutate('PATCH',route,body),alice.browser.mutate('DELETE',route)]);
    assert.ok([200,404].includes(result[0]!.status));assert.equal(result[1]!.status,200);
    const latest=(await stack.history(bob,conversationId)).items[0];assert.equal(latest.state,'deleted');assert.equal(latest.edit,undefined);
    assert.equal((await alice.browser.mutate('PATCH',route,body)).status,404);
  });
});
