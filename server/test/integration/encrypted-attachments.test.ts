import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readdir,unlink,rmdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {request as httpRequest} from 'node:http';
import {tsImport} from 'tsx/esm/api';
import {DataStack,type Person} from '../data/support/stack.ts';
import {TestDevice} from '../e2ee/support/deviceClient.ts';

let stack:DataStack,directory:string,files:any,content:any,cryptoFiles:any;
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'secubuzz-encrypted-files-'));
  stack=await DataStack.start({dependencies:{attachmentOptions:{directory}}});
  files=await tsImport('../../../client/src/messaging/authenticatedAttachments.ts',import.meta.url);
  content=await tsImport('../../../client/src/messaging/authenticatedContent.ts',import.meta.url);
  cryptoFiles=await tsImport('../../../client/src/messaging/encryptedAttachmentCrypto.ts',import.meta.url);
});
after(async()=>{await stack?.close();if(directory){for(const name of await readdir(directory))await unlink(join(directory,name));await rmdir(directory);}});
const headers=(p:Person)=>({Origin:'http://localhost:3000',Cookie:[...p.browser.cookies].map(([k,v])=>`${k}=${v}`).join('; ')});
const captured:{body:Buffer;headers:Record<string,string>}[]=[];
function session(p:Person){return {actor:{id:p.id,username:p.username},dispose(){},
  async request(path:string,options:any={}){
    const r=options.method&&options.method!=='GET'?await p.browser.mutate(options.method,path,options.body):await p.browser.request(path);
    if(r.status>=400)throw Object.assign(new Error('HTTP '+r.status),{status:r.status});return r.body;
  },
  async binary(path:string,options:any){
    const body=options.body?Buffer.from(await options.body.arrayBuffer()):undefined;
    if(body)captured.push({body,headers:{...headers(p),'X-CSRF-Token':p.browser.token,'Content-Type':'application/octet-stream'}});
    const response=await fetch(stack.url+path,{method:options.method,headers:{...headers(p),...(body?{'X-CSRF-Token':p.browser.token,'Content-Type':'application/octet-stream'}:{})},...(body?{body}:{})});
    if(!response.ok)throw Object.assign(new Error('HTTP '+response.status),{status:response.status});
    return body?response.json():response.arrayBuffer();
  },
};}
const fixture=(name:string,mime:string)=>{
  const header=name.endsWith('.png')?Buffer.from('89504e470d0a1a0a','hex'):name.endsWith('.mp4')?Buffer.from('0000ftypisom'):name.endsWith('.docx')?Buffer.from('504b0304','hex'):Buffer.from('%PDF-1.7\n');
  return new File([header,Buffer.from('Private file bytes, never plaintext at the server '+name)],name,{type:mime});
};
test('two enrolled accounts upload only ciphertext, deliver a V2 manifest in realtime and decrypt images, video, PDF and Word after history recovery',async()=>{
  const {alice,bob,conversationId,epoch,bobKey}=await stack.pair(),sender=new files.AuthenticatedAttachments(session(alice),conversationId),receiver=new files.AuthenticatedAttachments(session(bob),conversationId);
  const selected=[fixture('private.png','image/png'),fixture('private.mp4','video/mp4'),fixture('private.pdf','application/pdf'),fixture('private.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')];
  const attachments=await Promise.all(selected.map(file=>sender.upload(file))),batch=await sender.seal(attachments);
  for(const item of attachments)await assert.rejects(receiver.read(item,new AbortController().signal),{status:404});
  const wire=await stack.envelope(alice,conversationId,epoch,content.encodeAuthenticatedContent({text:'Encrypted files',attachments:batch.manifests}),batch.messageId);
  const a=await stack.connect(alice),b=await stack.connect(bob),mark=b.mark();
  assert.equal((await stack.send(a,wire)).status,'sent');
  const arrived=await b.waitFor('message:new',e=>e.id===wire.id,{since:mark});
  const decoded=content.decodeAuthenticatedContent(await TestDevice.decrypt(bobKey.key,arrived as never));
  assert.deepEqual(decoded.attachments,batch.manifests);
  for(let i=0;i<attachments.length;i++){
    const item=attachments[i],source=selected[i]!;
    assert.deepEqual(Buffer.from(await (await receiver.read(item,new AbortController().signal)).arrayBuffer()),Buffer.from(await source.arrayBuffer()));
    const capture=captured.find(c=>createHash('sha256').update(c.body).digest('hex')===batch.manifests[i].sha256)!;
    assert.ok(!capture.body.includes(Buffer.from('Private file bytes')));assert.ok(!JSON.stringify(capture.headers).includes(source.name));
    assert.ok(!capture.body.includes(Buffer.from(batch.manifests[i].key)));
  }
  b.socket.disconnect();await stack.connect(bob);
  const history=await stack.history(bob,conversationId),reloaded=content.decodeAuthenticatedContent(await TestDevice.decrypt((await stack.currentKey(bob,conversationId)).key,history.items[0]));
  assert.deepEqual(reloaded.attachments,batch.manifests);
  const fresh=new files.AuthenticatedAttachments(session(bob),conversationId);
  assert.deepEqual(Buffer.from(await (await fresh.read(attachments[0],new AbortController().signal)).arrayBuffer()),Buffer.from(await selected[0]!.arrayBuffer()));
  const db=stack.data.application.db;
  const rows=db.prepare('SELECT * FROM Attachments WHERE conversation_id=?').all(conversationId);
  for(const row of rows){assert.equal(row.media_type,'application/octet-stream');assert.equal(row.encrypted_metadata,null);assert.equal(row.status,'ready');assert.ok(row.message_id);}
  for(const manifest of batch.manifests){assert.ok(!stack.fixture.databaseText().includes(manifest.key));assert.ok(!stack.fixture.databaseText().includes(manifest.name));}
});
test('uploads and message retries are idempotent; authorization, CSRF, corrupt ciphertext and Unsend fail closed',async()=>{
  const {alice,bob,conversationId,epoch}=await stack.pair('retry-a','retry-b'),outsider=await stack.person('outsider');
  const sender=new files.AuthenticatedAttachments(session(alice),conversationId),file=fixture('safe.pdf','application/pdf'),item=await sender.upload(file);
  assert.deepEqual(await sender.upload(file),item);
  const unauthorized=await fetch(stack.url+`/api/attachments/${item.id}/download`,{headers:headers(outsider)});assert.equal(unauthorized.status,404);
  const bytes=captured.at(-1)!.body,path=`/api/attachments?conversation_id=${conversationId}&message_id=${item.encrypted.messageId}&id=${item.id}`;
  assert.equal((await fetch(stack.url+path,{method:'POST',headers:{...headers(alice),'Content-Type':'application/octet-stream'},body:bytes})).status,403);
  assert.equal((await fetch(stack.url+path,{method:'POST',headers:{...headers(outsider),'Content-Type':'application/octet-stream','X-CSRF-Token':outsider.browser.token},body:bytes})).status,404);
  const changed=Buffer.from(bytes);changed[0]=changed[0]!^1;
  assert.equal((await fetch(stack.url+path,{method:'POST',headers:{...headers(alice),'Content-Type':'application/octet-stream','X-CSRF-Token':alice.browser.token},body:changed})).status,409);
  const batch=await sender.seal([item]);assert.deepEqual(await sender.seal([item]),batch);
  await sender.discard(item); // Component cleanup must not revoke a possibly committed, sealed send.
  const wire=await stack.envelope(alice,conversationId,epoch,content.encodeAuthenticatedContent({text:'',attachments:batch.manifests}),batch.messageId);
  const first=await alice.browser.mutate('POST',`/api/conversations/${conversationId}/messages`,wire);assert.equal(first.status,201);
  assert.equal((await alice.browser.mutate('POST',`/api/conversations/${conversationId}/messages`,wire)).status,200);
  assert.equal((await stack.history(bob,conversationId)).items.length,1);
  const db=stack.data.application.db,row=db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(item.id);
  assert.equal(db.prepare('SELECT count(*) n FROM Attachments WHERE attachment_id=?').get(item.id).n,1);
  const stored=join(directory,row.storage_key),original=await readFile(stored);await writeFile(stored,changed);
  const receiver=new files.AuthenticatedAttachments(session(bob),conversationId);
  await assert.rejects(receiver.read(item,new AbortController().signal),/integrity/);
  await writeFile(stored,original);
  const foreign=new files.AuthenticatedAttachments(session(outsider),conversationId);await assert.rejects(foreign.read(item,new AbortController().signal),{status:404});
  await assert.rejects(cryptoFiles.decryptAttachment({...item.encrypted,messageId:randomUUID()},original.buffer.slice(original.byteOffset,original.byteOffset+original.byteLength)),/integrity/);
  assert.equal((await bob.browser.mutate('DELETE',`/api/messages/${first.body.message.storageId}`)).status,403);
  assert.equal((await alice.browser.mutate('DELETE',`/api/messages/${first.body.message.storageId}`)).status,200);
  await assert.rejects(receiver.read(item,new AbortController().signal),{status:404});
  assert.equal(db.prepare('SELECT status FROM Attachments WHERE attachment_id=?').get(item.id).status,'deleted');
  assert.equal(db.prepare('SELECT status FROM EncryptedAttachmentBatches WHERE conversation_id=? AND client_message_id=?').get(conversationId,batch.messageId).status,'revoked');
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal((await stack.history(bob,conversationId)).items[0].state,'deleted');
});
test('revoking a genuine session after bytes stream prevents finalization and removes the uncommitted binary',async()=>{
  const owned=await mkdtemp(join(tmpdir(),'secubuzz-revoked-upload-'));
  const storage=createRequire(import.meta.url)('../../src/storage/attachmentStorage.cjs').createAttachmentStorage({directory:owned,maxBytes:1024});
  let afterWrite=async()=>{};
  const isolated=await DataStack.start({dependencies:{attachmentOptions:{storage:{...storage,async storeRequestStream(request:any){const saved=await storage.storeRequestStream(request);await afterWrite();return saved;}}}}});
  try{
    const {alice,bob,conversationId}=await isolated.pair('revoked-a','revoked-b');
    afterWrite=async()=>{assert.equal((await alice.browser.mutate('POST','/api/auth/logout')).status,204);};
    const id=randomUUID(),mid=randomUUID();
    const r=await fetch(isolated.url+`/api/attachments?conversation_id=${conversationId}&message_id=${mid}&id=${id}`,{method:'POST',headers:{...headers(alice),'Content-Type':'application/octet-stream','X-CSRF-Token':alice.browser.token},body:Buffer.alloc(64,0x41)});
    assert.equal(r.status,401);assert.deepEqual(await readdir(owned),[]);
    assert.equal(isolated.data.application.db.prepare('SELECT count(*) n FROM Attachments').get().n,0);
    assert.equal((await bob.browser.request('/api/auth/me')).status,200);
  }finally{await isolated.close();for(const name of await readdir(owned))await unlink(join(owned,name));await rmdir(owned);}
});
test('server size limits and seven-day staging retention reject unsafe uploads and purge abandoned/sealed ciphertext without touching messages',async()=>{
  const owned=await mkdtemp(join(tmpdir(),'secubuzz-upload-retention-'));
  const storage=createRequire(import.meta.url)('../../src/storage/attachmentStorage.cjs').createAttachmentStorage({directory:owned,maxBytes:128});
  let clock=Date.now();const isolated=await DataStack.start({dependencies:{now:()=>clock,attachmentOptions:{storage}}});
  try{
    const {alice,conversationId}=await isolated.pair('expired-a','expired-b'),id=randomUUID(),mid=randomUUID();
    const path=isolated.url+`/api/attachments?conversation_id=${conversationId}&message_id=${mid}&id=${id}`;
    const options={method:'POST',headers:{...headers(alice),'Content-Type':'application/octet-stream','X-CSRF-Token':alice.browser.token}};
    assert.equal((await fetch(path,{...options,body:Buffer.alloc(129)})).status,413);
    assert.equal((await fetch(path,{...options,headers:{...options.headers,Origin:'http://untrusted.test'},body:Buffer.alloc(64)})).status,403);
    assert.deepEqual(await readdir(owned),[]);
    assert.equal((await fetch(path,{...options,body:Buffer.alloc(64,0x61)})).status,201);
    assert.equal((await alice.browser.mutate('POST',`/api/attachments/batches/${conversationId}/${mid}`,{ids:[id]})).status,200);
    clock+=8*86400000;isolated.data.application.attachments.cleanup();
    const db=isolated.data.application.db;
    assert.equal(db.prepare('SELECT status FROM EncryptedAttachmentBatches').get().status,'revoked');
    const row=db.prepare('SELECT status,purged_at FROM Attachments').get();assert.equal(row.status,'deleted');assert.ok(row.purged_at);
    assert.deepEqual(await readdir(owned),[]);assert.equal(db.prepare('SELECT count(*) n FROM Messages').get().n,0);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }finally{await isolated.close();for(const name of await readdir(owned))await unlink(join(owned,name));await rmdir(owned);}
});
test('an interrupted authenticated binary stream removes partial files and creates no attachment row',async()=>{
  const {alice,conversationId}=await stack.pair('interrupt-a','interrupt-b'),id=randomUUID(),mid=randomUUID();
  const upload=httpRequest(stack.url+`/api/attachments?conversation_id=${conversationId}&message_id=${mid}&id=${id}`,{method:'POST',headers:{...headers(alice),'Content-Type':'application/octet-stream','X-CSRF-Token':alice.browser.token}});
  upload.on('error',()=>{});upload.write(Buffer.alloc(1024,0x42));
  try{
    for(let i=0;i<200&&!(await readdir(directory)).some(name=>name.endsWith('.part'));i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok((await readdir(directory)).some(name=>name.endsWith('.part')),'the authorized stream actually reached private staging');
  }finally{upload.destroy();}
  for(let i=0;i<200&&(await readdir(directory)).some(name=>name.endsWith('.part'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(!(await readdir(directory)).some(name=>name.endsWith('.part')));
  assert.equal(stack.data.application.db.prepare('SELECT count(*) n FROM Attachments WHERE attachment_id=?').get(id).n,0);
});
test('voice content reuses encrypted attachment ownership, realtime/history, ciphertext-only storage and Unsend without a migration',async()=>{
  const {alice,bob,conversationId,epoch,bobKey}=await stack.pair('voice-a','voice-b');
  const {voiceWav}=createRequire(import.meta.url)('../../../client/test/voiceAudioFixture.cjs'),plain:Buffer=voiceWav();
  const sender=new files.AuthenticatedAttachments(session(alice),conversationId),receiver=new files.AuthenticatedAttachments(session(bob),conversationId);
  const file=new File([plain],'voice.wav',{type:'audio/wav'}),attachment=await sender.upload(file),batch=await sender.seal([attachment]);
  const text=content.encodeAuthenticatedContent({text:'',attachments:batch.manifests,voice:{v:1,attachmentId:attachment.id,durationSeconds:1}});
  const wire=await stack.envelope(alice,conversationId,epoch,text,batch.messageId),a=await stack.connect(alice),b=await stack.connect(bob),mark=b.mark();
  assert.equal((await stack.send(a,wire)).status,'sent');const arrived=await b.waitFor('message:new',m=>m.id===wire.id,{since:mark});
  const decoded=content.decodeAuthenticatedContent(await TestDevice.decrypt(bobKey.key,arrived as never));
  assert.equal(decoded.voice.durationSeconds,1);assert.equal(decoded.voice.attachmentId,attachment.id);
  assert.deepEqual(Buffer.from(await (await receiver.read(attachment,new AbortController().signal)).arrayBuffer()),plain);
  const upload=captured.at(-1)!;assert.equal(upload.body.length,plain.length+16);assert.ok(!upload.body.equals(plain));assert.ok(!JSON.stringify(upload.headers).includes(batch.manifests[0].key));
  assert.ok(!stack.fixture.databaseText().includes(batch.manifests[0].key));
  const reloaded=(await stack.history(bob,conversationId)).items[0];assert.deepEqual(content.decodeAuthenticatedContent(await TestDevice.decrypt(bobKey.key,reloaded)),decoded);
  assert.equal((await alice.browser.mutate('DELETE',`/api/messages/${reloaded.storageId}`)).status,200);await assert.rejects(receiver.read(attachment,new AbortController().signal),{status:404});
});
