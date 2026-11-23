import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tsImport} from 'tsx/esm/api';
import {io} from 'socket.io-client';
import {DataStack,until} from '../data/support/stack.ts';

const requireClient=createRequire(new URL('../../../client/package.json',import.meta.url));requireClient('fake-indexeddb/auto');
let stack:DataStack,Session:any,HttpAuth:any,Workspace:any,Content:any,Pins:any,Forwarding:any;
const sessions:any[]=[],lives:any[]=[],apis:any[]=[];
before(async()=>{
 stack=await DataStack.start();const options={parentURL:import.meta.url,tsconfig:fileURLToPath(new URL('../../../client/tsconfig.json',import.meta.url))};
 Session=(await tsImport('../../../client/src/security/e2ee/session.ts',options)).SecureMessagingSession;
 HttpAuth=(await tsImport('../../../client/src/auth/httpAuthService.ts',options)).HttpAuthService;
 Workspace=(await tsImport('../../../client/src/realtime/SecureRealtimeWorkspace.ts',options)).SecureRealtimeWorkspace;
 Content=await tsImport('../../../client/src/messaging/authenticatedContent.ts',options);
 Pins=(await tsImport('../../../client/src/messaging/authenticatedPins.ts',options)).AuthenticatedPins;
 Forwarding=(await tsImport('../../../client/src/messaging/authenticatedForwarding.ts',options)).AuthenticatedForwarding;
});
after(async()=>{for(const live of lives)live.dispose();for(const s of sessions)s.dispose();for(const api of apis)api.dispose();await stack?.close();});
async function pair(label:string){
 const a=await stack.person(label+'-a','Alice'),b=await stack.person(label+'-b','Bob');await stack.befriend(a,b);const cid=await stack.openDm(a,b);
 const clients=[];
 for(const person of [a,b]){
  const headers={Origin:'http://localhost:3000',Cookie:[...person.browser.cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
  const auth=new HttpAuth({fetch:(path:string,options:RequestInit)=>fetch(stack.url+path,{...options,headers:{...options.headers,...headers}})});
  const api=auth.createSessionApi((await person.browser.request('/api/auth/me')).body.user);apis.push(api);
  const session=new Session(api);sessions.push(session);await session.initialize(true);
  const live=new Workspace(session,stack.url,(url:string,options:any)=>io(url,{...options,withCredentials:false,addTrailingSlash:true,extraHeaders:headers}));lives.push(live);
  clients.push({session,live,api,person});
 }
 await clients[0]!.session.prepare(cid);await clients[1]!.session.prepare(cid);
 return {a:clients[0]!,b:clients[1]!,cid};
}
for (const operation of ['edit', 'unsend'] as const) {
 test(`pin refresh rejects cached plaintext after another client verifies ${operation}, and recovers from honest history`, async () => {
  const {a,b,cid}=await pair('pin-watermark-'+operation);
  const m=await a.session.send(cid,'Alice','ORIGINAL_PIN_WATERMARK_FIXTURE');
  await a.api.request(`/api/messages/${m.storageId}/pin`,{method:'POST',body:{pinned:true,expectedVersion:0,operationId:crypto.randomUUID()}});
  const saved=await b.api.request(`/api/conversations/${cid}/pins`);let replay=false;
  const reader=new Session({...b.api,request:(path:string,options:any)=>replay&&path===`/api/conversations/${cid}/pins`
   ?Promise.resolve(structuredClone(saved)):b.api.request(path,options)});sessions.push(reader);
  const pins=new Pins(reader);pins.authorize([await reader.api.getConversation(cid)]);
  try{
   await pins.refresh(cid);assert.equal(pins.getSnapshot().rows[cid][0].text,'ORIGINAL_PIN_WATERMARK_FIXTURE');
   await a.session.editMessage(m,'UPDATED_PIN_WATERMARK_FIXTURE\nUnicode: \u{1f1fb}\u{1f1f3}');
   if(operation==='unsend')await a.session.api.remove(m.storageId);
   const verified=(await b.session.history(cid)).items[0];
   assert.equal(verified.message.state,operation==='unsend'?'deleted':'active');
   replay=true;
   for(const retryUnavailable of [false,true]){
    await pins.refresh(cid,retryUnavailable);
    const row=pins.getSnapshot().rows[cid][0];
    assert.equal(row.text,null);assert.equal(typeof row.error,'string');
   }
   const restored=new Session(reader.api.session);sessions.push(restored);
   await assert.rejects(restored.decryptStoredMessage(m),(error:any)=>error.code==='invalid_proof');
   replay=false;await pins.refresh(cid,true);
   const current=pins.getSnapshot().rows[cid];
   if(operation==='unsend')assert.deepEqual(current,[]);
   else{
    assert.equal(current[0].text,'UPDATED_PIN_WATERMARK_FIXTURE\nUnicode: \u{1f1fb}\u{1f1f3}');
    assert.equal(current[0].message.id,m.id);assert.equal(current[0].message.storageId,m.storageId);
    assert.equal(pins.getSnapshot().collections[cid].version,saved.version,'Editing must not require a pin-version change');
   }
  }finally{pins.dispose();}
 });
}

test('actual client E2EE encrypts, authenticates and synchronizes Unicode edits; reload, rollback and terminal Unsend are consistent',async()=>{
 const {a,b,cid}=await pair('live-edits');const m=await a.session.send(cid,'Alice','Original 👩🏽‍💻\nsecond line');
 a.live.start();b.live.start();await until(()=>a.live.getSnapshot().connection==='connected'&&b.live.getSnapshot().connection==='connected',10000);
 await a.live.sync(cid);await b.live.sync(cid);
 const edited=await a.session.editMessage(m,'Edited 🇻🇳\nline two');a.live.acceptEdit(edited);
 assert.equal(edited.text,'Edited 🇻🇳\nline two');assert.equal(edited.message.id,m.id);assert.equal(edited.message.sequence,m.sequence);
 await until(()=>b.live.getSnapshot().rows[cid]?.find((r:any)=>r.message.id===m.id)?.text==='Edited 🇻🇳\nline two',10000);
 const history=await b.session.history(cid);assert.equal(history.items[0].text,'Edited 🇻🇳\nline two');
 b.live.dispose();b.session.dispose();const restored=new Session(b.api);sessions.push(restored);
 assert.equal((await restored.history(cid)).items[0].text,'Edited 🇻🇳\nline two');
 const rollback=new Session({...b.api,request:async(path:string,opts:any)=>path.includes('/messages?')?{items:[m],nextCursor:null}:b.api.request(path,opts)});sessions.push(rollback);
 const rejected=(await rollback.history(cid)).items[0];assert.equal(rejected.text,null);assert.equal(rejected.errorCode,'invalid_proof');
 await a.session.api.remove(m.storageId);const tombstone=(await restored.history(cid)).items[0];assert.equal(tombstone.message.state,'deleted');
 assert.equal((await rollback.history(cid)).items[0].text,null);
 await assert.rejects(a.session.editMessage(edited.message,'Cannot revive'));
});
test('failed and uncertain requests preserve exact encrypted edit bytes and never create duplicate revisions',async()=>{
 const {a,b,cid}=await pair('retry-edits'),m=await a.session.send(cid,'Alice','Original');
 const request=a.api.request.bind(a.api),captured:any[]=[];let failBefore=true;
 const proxy={...a.api,request:async(path:string,opts:any)=>{
  if(opts?.method==='PATCH'){captured.push(JSON.stringify(opts.body));if(failBefore){failBefore=false;throw new Error('Test-only interrupted upload');}}
  return request(path,opts);
 }};
 const sender=new Session(proxy);sessions.push(sender);
 await assert.rejects(sender.editMessage(m,'Retry multiline\n🍕'));assert.equal((await b.session.history(cid)).items[0].text,'Original');
 const saved=await sender.editMessage(m,'Retry multiline\n🍕');assert.equal(saved.text,'Retry multiline\n🍕');assert.equal(captured[0],captured[1]);
 let lose=true,patches=0;const uncertain=new Session({...a.api,request:async(path:string,opts:any)=>{
  const r=await request(path,opts);if(opts?.method==='PATCH'){patches++;if(lose){lose=false;throw new Error('Test-only lost response');}}return r;
 }});sessions.push(uncertain);
 await assert.rejects(uncertain.editMessage(saved.message,'Committed but response lost'));
 const recovered=await uncertain.editMessage(saved.message,'Committed but response lost');assert.equal(recovered.text,'Committed but response lost');assert.equal(patches,1);
 assert.equal((await b.session.history(cid)).items[0].message.edit.proofs.length,2);
});
test('the recipient rejects forged revision signatures, modified ciphertext and altered ownership without plaintext fallback',async()=>{
 const {a,b,cid}=await pair('tampered-edits'),m=await a.session.send(cid,'Alice','Original protected');
 const saved=await a.session.editMessage(m,'Legitimate edit');await b.session.history(cid);
 for(const mutate of [
  (x:any)=>{x.edit.envelope.encryption.ciphertext=Buffer.alloc(64).toString('base64');},
  (x:any)=>{x.edit.proofs[0].proof.signature='A'.repeat(86);},
  (x:any)=>{x.edit.proofs[0].signer.userId=b.person.id;},
  (x:any)=>{x.edit.proofs[0].proof.previousHash='0'.repeat(64);},
 ]){
  const bad=structuredClone(saved.message);mutate(bad);
  const reader=new Session({...b.api,request:async(path:string,opts:any)=>path.includes('/messages?')?{items:[bad],nextCursor:null}:b.api.request(path,opts)});sessions.push(reader);
  const result=(await reader.history(cid)).items[0];assert.equal(result.text,null);assert.ok(result.error);
 }
 assert.equal((await b.session.history(cid)).items[0].text,'Legitimate edit');
});
test('both senders can edit; reply/forward metadata, pinned content and reactions survive revisions',async()=>{
 const {a,b,cid}=await pair('metadata-edits'),target=await b.session.send(cid,'Bob','Reply target');
 const reply={messageId:target.id,senderId:b.person.id};
 const m=await a.session.send(cid,'Alice',Content.encodeAuthenticatedContent({text:'Reply original',reply}));
 const pins=new Pins(a.session);pins.authorize([await a.session.api.getConversation(cid)]);
 try{
  await pins.set(m,true);assert.equal((await b.person.browser.mutate('POST',`/api/messages/${m.storageId}/reaction`,{emoji:'👍',expectedRevision:0,operationId:crypto.randomUUID()})).status,200);
  const edited=await a.session.editMessage(m,'Reply edited\n🇻🇳');assert.deepEqual(Content.decodeAuthenticatedContent(edited.text).reply,reply);
  await pins.refresh(cid);assert.equal(Content.decodeAuthenticatedContent(pins.getSnapshot().rows[cid][0].text).text,'Reply edited\n🇻🇳');
  const reactions=await b.person.browser.request(`/api/conversations/${cid}/reactions?ids=${m.storageId}`);assert.equal(reactions.body.items[0].actors[0].emoji,'👍');
  const result=await new Forwarding(a.session).forward({id:m.id,conversationId:cid,senderId:a.person.id,senderName:'Alice',type:'text',content:'Reply edited\n🇻🇳',timestamp:m.timestamp,deliveryStatus:'sent'},[cid],'',crypto.randomUUID(),'Alice','rest');
  assert.deepEqual(result.failed,[]);
  const forwarded=(await b.session.history(cid)).items.find((r:any)=>Content.decodeAuthenticatedContent(r.text??'')?.forwarded);
  assert.ok(forwarded);assert.equal(Content.decodeAuthenticatedContent(forwarded.text).reply,undefined);
  const updatedForward=await a.session.editMessage(forwarded.message,'Forward edited');assert.equal(Content.decodeAuthenticatedContent(updatedForward.text).forwarded,true);
  assert.deepEqual(Content.decodeAuthenticatedContent(updatedForward.text).operation,Content.decodeAuthenticatedContent(forwarded.text).operation);
  const changedTarget=await b.session.editMessage(target,'Bob edited target');assert.equal(changedTarget.text,'Bob edited target');
  assert.equal((await a.session.history(cid)).items.find((r:any)=>r.message.id===target.id).text,'Bob edited target');
  // Phase 12A: exercise the combined revision/pin/reaction tombstone lifecycle and FK guards.
  const db=stack.data.application.db;
  const original=db.prepare('SELECT message_id,ciphertext,iv,key_id,fingerprint FROM Messages WHERE message_id=?').get(m.storageId);
  await a.session.api.remove(m.storageId);
  assert.equal((await b.session.history(cid)).items.find((r:any)=>r.message.id===m.id).message.state,'deleted');
  assert.deepEqual((await b.api.request(`/api/conversations/${cid}/pins`)).items,[]);
  const afterUnsend=(await b.api.request(`/api/conversations/${cid}/reactions?ids=${m.storageId}`)).items[0];
  assert.equal(afterUnsend.state,'deleted');assert.deepEqual(afterUnsend.actors,[]);
  assert.equal(db.prepare('SELECT count(*) n FROM MessageReactionOperations WHERE message_id=?').get(m.storageId).n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM MessageEditRevisions WHERE message_id=?').get(m.storageId).n,1);
  assert.deepEqual(db.prepare('SELECT message_id,ciphertext,iv,key_id,fingerprint FROM Messages WHERE message_id=?').get(m.storageId),original);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
 }finally{pins.dispose();}
});
