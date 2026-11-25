'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path');
const {Readable}=require('node:stream');
const {spawn}=require('node:child_process'),{EventEmitter}=require('node:events'),{once}=require('node:events'),{createHash}=require('node:crypto');
const {encode,FRAME_CONTENT_TYPE}=require('../server/attachments/frame'),{createFilesystemProvider}=require('../server/attachments/storage/filesystem');
const {httpGroupFixture,createClock}=require('./support/groups'),{storageRoot}=require('./support/attachments');
const {createRetentionJob}=require('../server/attachments/retention');
const {createAttachmentRepository}=require('../server/database/attachmentRepository');
const BASE={pendingTtlSeconds:86400,purgeDelaySeconds:86400,retentionIntervalSeconds:3600,quotaUserBytes:1073741824,
 quotaConversationBytes:5368709120,maxPendingPerUser:10,uploadsPerHour:30,maxConcurrentUploadsPerUser:2,
 maxConcurrentUploadsPerSource:5,uploadTimeoutSeconds:120},MAX=204800,ORIGIN='http://localhost:3000';
const RESERVATION_OBSERVATION_TIMEOUT_MS=5000,RESERVATION_POLL_INTERVAL_MS=5;
const workerPath=path.join(__dirname,'support','attachments-worker.cjs');
const rng=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const pick=(r,n)=>r()%n,feature=(root,s)=>({groupApi:true,groupMessaging:false,attachmentApi:true,groups:{},attachments:{...BASE,...s,storageDir:root}});
async function fixture(t,settings=BASE,limiter={consume:()=>({allowed:true,retryAfterSeconds:1})}){const root=storageRoot(t),storage=createFilesystemProvider({root,repositoryRoot:path.resolve(__dirname,'..')});
 const f=await httpGroupFixture(t,{features:feature(root,settings),storage,limiter});return {...f,root,storage};}
function cookie(f,a){const v=a.browser.cookies.get(f.config.sessionCookie);assert.ok(v);return f.config.sessionCookie+'='+v;}
function head(id,size){return {conversationId:id,byteSize:size,encryptedMetadata:'opaque',algorithm:'X25519-AESGCM',formatVersion:'v1'};}
function makeFile(f,name,payload,declared=payload.length){const b=encode({...head(f.groupId,declared),encryptedMetadata:'opaque-'+name},payload),p=path.join(f.directory,name+'.bin');fs.writeFileSync(p,b,{flag:'wx',mode:0o600});return {file:p,total:b.length,payload:payload.length};}
function makeRaw(f,name,b){const p=path.join(f.directory,name+'.bin');fs.writeFileSync(p,b,{flag:'wx',mode:0o600});return {file:p,total:b.length,payload:0};}
function req(f,a,file,extra={}){return {method:'POST',path:'/api/attachments',headers:{'Content-Type':FRAME_CONTENT_TYPE,...extra.headers},bodyFile:file.file,cookie:cookie(f,a),csrf:a.token,
 ...(extra.hold?{command:'hold-upload',holdAfterBytes:extra.holdBytes}:{})};}
function worker(t,f,index,settings,{failStorage=false,openLimiter=false,batch=0}={}){
 const env={...process.env,NODE_ENV:'test',AUTH_ALLOW_HTTP_LOCAL:'true',AUTH_ALLOWED_ORIGINS:ORIGIN,HOST:'127.0.0.1',PORT:'0',DB_PATH:f.filename,
  SECUBUZZ_ISOLATED_ATTACHMENT_WORKER:'1',SECUBUZZ_ATTACHMENT_WORKER_STORAGE:f.root,SECUBUZZ_ATTACHMENT_WORKER_BARRIER:f.directory,
  SECUBUZZ_ATTACHMENT_WORKER_FEATURES:JSON.stringify(feature(f.root,settings)),SECUBUZZ_ATTACHMENT_WORKER_INDEX:String(index),SECUBUZZ_ATTACHMENT_WORKER_BATCH:String(batch),SECUBUZZ_ATTACHMENT_WORKER_NOW:String(f.clock.now()),
  SECUBUZZ_ATTACHMENT_WORKER_FAIL_STORAGE:failStorage?'1':'0',SECUBUZZ_ATTACHMENT_WORKER_OPEN_LIMITER:openLimiter?'1':'0'};
 delete env.SECUBUZZ_DOCKER_VALIDATION;
 const child=spawn(process.execPath,[workerPath],{cwd:path.resolve(__dirname,'..'),env,stdio:['pipe','pipe','pipe']});
 const e=new EventEmitter(),q=[];let rest='',stderr='';
 child.stdout.setEncoding('utf8');child.stdout.on('data',d=>{rest+=d;for(;;){const n=rest.indexOf('\n');if(n<0)break;const s=rest.slice(0,n).trim();rest=rest.slice(n+1);if(s){q.push(s);e.emit('line');}}});
 child.stderr.setEncoding('utf8');child.stderr.on('data',d=>{stderr+=d;});
 function wait(pred,label,ms=20000){const n=q.findIndex(pred);if(n>=0)return Promise.resolve(q.splice(n,1)[0]);return new Promise((resolve,reject)=>{
  let done=false;const end=(err,v)=>{if(done)return;done=true;clearTimeout(timer);e.off('line',check);child.off('exit',ex);err?reject(err):resolve(v);};
  const check=()=>{const i=q.findIndex(pred);if(i>=0)end(null,q.splice(i,1)[0]);},ex=code=>end(new Error('worker exit before '+label+': '+code+' '+stderr));
  const timer=setTimeout(()=>{const detail='attachment worker '+index+' timeout '+label+' queue='+q.join('|')+' stderr='+stderr;end(new Error(detail));},ms);e.on('line',check);child.once('exit',ex);check();});}
 const w={child,index,batch,seq:0,ready:wait(s=>s.startsWith('READY '),'ready'),
  send(x){const n=this.seq++;child.stdin.write(JSON.stringify(x)+'\n');return n;},
  armed(n){return wait(s=>s==='ARMED '+n||(typeof s==='string'&&s.startsWith('{')&&(()=>{try{return Boolean(JSON.parse(s).workerError);}catch{return false;}})()),'armed').then(s=>{if(s!=='ARMED '+n)throw new Error('worker failed before barrier: '+s);});},
  event(name,n){return wait(s=>{try{const x=JSON.parse(s);return x.event===name&&x.sequence===n;}catch{return false;}},name);},
  result(){return wait(s=>{try{const x=JSON.parse(s);return 'status'in x||'workerError'in x;}catch{return false;}},'result').then(JSON.parse);},
  async stop(kill=false){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');if(kill)child.kill('SIGKILL');else child.stdin.end();await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('attachment worker did not exit after bounded shutdown')),10000))]);assert.ok(child.exitCode!==null||child.signalCode!==null,'worker process exited');}};
 child.once('exit',c=>e.emit('line','EXIT '+c));t.after(()=>w.stop(true));return w;
}
async function startWorkers(t,f,n,s,o={}){const ws=[];for(let i=0;i<n;i++)ws.push(worker(t,f,i,s,{failStorage:o.failWorker===i,openLimiter:o.openLimiter,batch:o.batch||0}));
 try{await Promise.all(ws.map(w=>w.ready));}catch(error){process.stderr.write('attachment worker startup failed: '+error.message+'\n');throw error;}return ws;}
function release(f,w,n){fs.writeFileSync(path.join(f.directory,'go-'+w.batch+'-'+w.index+'-'+n),'go',{flag:'wx',mode:0o600});}
async function waitForReservation(f,userId,{batch,operation,worker}={}){
 const started=performance.now(),deadline=started+RESERVATION_OBSERVATION_TIMEOUT_MS;let attempts=0,last=null;
 while(true){
  attempts++;last=userId===null||userId===undefined?f.db.prepare('SELECT reservation_id,user_id,conversation_id,declared_bytes FROM AttachmentReservations LIMIT 1').get():f.db.prepare('SELECT reservation_id,user_id,conversation_id,declared_bytes FROM AttachmentReservations WHERE user_id=? AND conversation_id=? LIMIT 1').get(userId,f.groupId);
  if(last)return {row:last,attempts,elapsedMs:Number((performance.now()-started).toFixed(3))};
  const elapsedMs=performance.now()-started,workerState=worker?{index:worker.index,exitCode:worker.child.exitCode,signalCode:worker.child.signalCode}:null;
  if(worker&&(worker.child.exitCode!==null||worker.child.signalCode!==null))throw new Error('worker exited before reservation was observed: '+JSON.stringify({batch,operation,worker:workerState,userId,conversationId:f.groupId,attempts,elapsedMs:Number(elapsedMs.toFixed(3))}));
  if(elapsedMs>=RESERVATION_OBSERVATION_TIMEOUT_MS){const active=f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations').get().n;throw new Error('reservation was not observed before the 5000ms monotonic deadline: '+JSON.stringify({batch,operation,worker:workerState,userId,conversationId:f.groupId,attempts,elapsedMs:Number(elapsedMs.toFixed(3)),activeReservations:active,lastReservation:last}));}
  await new Promise(resolve=>setTimeout(resolve,Math.min(RESERVATION_POLL_INTERVAL_MS,Math.max(1,deadline-performance.now()))));
 }
}
function snapshotUsage(f,s){const at=new Date(f.clock.now()).toISOString();return f.db.transaction(()=>{const rows=f.db.prepare("SELECT uploaded_by,conversation_id,byte_size FROM Attachments WHERE status IN ('pending','ready')").all(),rs=f.db.prepare('SELECT user_id,conversation_id,declared_bytes FROM AttachmentReservations WHERE expires_at>?').all(at),group=rows.filter(x=>x.conversation_id===f.groupId).reduce((a,x)=>a+x.byte_size,0)+rs.filter(x=>x.conversation_id===f.groupId).reduce((a,x)=>a+x.declared_bytes,0);assert.ok(group<=s.quotaConversationBytes);for(const actor of Object.values(f.actors).filter(x=>x.id)){const user=rows.filter(x=>x.uploaded_by===actor.id).reduce((a,x)=>a+x.byte_size,0)+rs.filter(x=>x.user_id===actor.id).reduce((a,x)=>a+x.declared_bytes,0),pending=f.db.prepare("SELECT count(*) n FROM Attachments WHERE uploaded_by=? AND status='pending'").get(actor.id).n+rs.filter(x=>x.user_id===actor.id).length;assert.ok(user<=s.quotaUserBytes);assert.ok(pending<=s.maxPendingPerUser,JSON.stringify({actor:actor.actorClass,pending,max:s.maxPendingPerUser,at}));}return {group};}).deferred();}
async function expireWorkerCrash(f,expected=1){const rows=f.db.prepare('SELECT reservation_id FROM AttachmentReservations WHERE expires_at>?').all(new Date(f.clock.now()).toISOString()),parts=fs.readdirSync(f.root).filter(x=>x.endsWith('.part'));assert.equal(rows.length,expected);assert.ok(parts.length>0);const old=new Date(Date.now()-((BASE.pendingTtlSeconds*1000)+1000));for(const name of parts)fs.utimesSync(path.join(f.root,name),old,old);f.clock.advance(BASE.pendingTtlSeconds*1000);const job=createRetentionJob({db:f.db,repository:createAttachmentRepository(f.db),storage:f.storage,now:()=>new Date(f.clock.now()),settings:BASE});const result=await job.runOnce();assert.equal(result.reservations,expected);assert.equal(result.failures,0,JSON.stringify(result));await job.stop();assert.equal(f.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);const remaining=fs.readdirSync(f.root).filter(x=>x.endsWith('.part'));assert.equal(remaining.length,0,JSON.stringify({remaining,stats:remaining.map(name=>fs.statSync(path.join(f.root,name)).mtimeMs)}));assert.equal((await job.runOnce()).reservations,0);}
function intents(f,r,n,b){const kinds=['valid','valid','short','long','malformed','oversize'];return Array.from({length:n},(_,i)=>{
 const kind=kinds[(i+b)%kinds.length],size=1+pick(r,MAX),bytes=Buffer.alloc(size,(b+i+1)&255),tag='p34-'+b+'-'+i;
 if(kind==='malformed')return {kind,size:0,file:makeRaw(f,tag,Buffer.from([0,0,0,20,123,125]))};
 if(kind==='oversize')return {kind,size:0,file:makeFile(f,tag,Buffer.alloc(0),52428801)};
 if(kind==='short')return {kind,size,file:makeFile(f,tag,bytes,size+1)};
 if(kind==='long'){const actualSize=Math.max(2,size),longBytes=Buffer.alloc(actualSize,(b+i+1)&255);return {kind,size:actualSize,file:makeFile(f,tag,longBytes,actualSize-1)};}
 return {kind,size,file:makeFile(f,tag,bytes)};});}
function checkResult(item,out,flags,workerIndex){assert.equal(out.workerError,undefined);assert.doesNotMatch(JSON.stringify(out),/storage_key|storageKey|private filesystem/i);
 if(item.kind==='malformed')return assert.deepEqual(out,{status:400,body:{code:'VALIDATION_ERROR',fields:[]}});
 if(item.kind==='oversize')return assert.deepEqual(out,{status:413,body:{code:'PAYLOAD_TOO_LARGE',fields:[]}});
 const admissionRefusal=()=>{assert.ok([409,429].includes(out.status),JSON.stringify({kind:item.kind,out}));assert.ok(['QUOTA_EXCEEDED','RATE_LIMITED'].includes(out.body.code),JSON.stringify({kind:item.kind,out}));};
 if(flags.storage&&workerIndex===0){if(out.status===503)return assert.deepEqual(out,{status:503,body:{code:'SERVICE_UNAVAILABLE',fields:[]}});return admissionRefusal();}
 if(item.kind==='short'||item.kind==='long'){if(out.status===400)return assert.deepEqual(out,{status:400,body:{code:'VALIDATION_ERROR',fields:[]}});return admissionRefusal();}
 if(flags.audit&&item.kind==='valid'){if(out.status===500)return assert.deepEqual(out,{status:500,body:{code:'INTERNAL_ERROR',fields:[]}});return admissionRefusal();}
 if(out.status===201){assert.equal(out.body.attachment.status,'pending');assert.equal(out.body.attachment.byteSize,item.size);}
 else admissionRefusal();}
async function runBatch(t,f,b,r,flags={}){
 const count=4+pick(r,9),nworkers=2+pick(r,3),qfiles=1+pick(r,6),pmax=1+pick(r,6);
 const s={...BASE,quotaUserBytes:qfiles*MAX,quotaConversationBytes:qfiles*MAX,maxPendingPerUser:pmax,
  maxConcurrentUploadsPerUser:1+pick(r,6),maxConcurrentUploadsPerSource:1+pick(r,6)};
 const list=intents(f,r,count,b);
 if(flags.storage){list[0]={kind:'valid',size:32,file:makeFile(f,'storage-'+b,Buffer.alloc(32,0x55)),storage:true};
  list[1]={kind:'malformed',size:0,file:makeRaw(f,'storage-bad-'+b,Buffer.from([0,0]))};}
 if(flags.audit){list[0]={kind:'valid',size:24,file:makeFile(f,'audit-'+b,Buffer.alloc(24,0x41)),audit:true};
  list[1]={kind:'malformed',size:0,file:makeRaw(f,'audit-bad-'+b,Buffer.from([0,0]))};}
 if(flags.remove){list[0]={kind:'hold',size:64,file:makeFile(f,'removed-'+b,Buffer.alloc(64,0x6b))};}
 const before=new Set(f.db.prepare("SELECT attachment_id FROM Attachments WHERE status IN ('pending','ready')").all().map(x=>x.attachment_id));
 const audits=f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE source='attachments'").get().n;
 if(flags.audit)f.db.exec("CREATE TRIGGER p34_fail_audit BEFORE INSERT ON AuditLogs WHEN NEW.source='attachments' AND NEW.event_type='attachment.uploaded' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 const ws=await startWorkers(t,f,nworkers,s,{failWorker:flags.storage?0:-1,openLimiter:true,batch:b}),items=[];
 for(let i=0;i<list.length;i++){const hold=flags.remove&&i===0,actor=hold?f.actors.member:f.actors.owner,w=hold?ws[0]:ws[flags.remove?1+(i%(ws.length-1)):i%ws.length];
  const ent=list[i],cmd=req(f,actor,ent.file,hold?{hold:true,holdBytes:ent.file.total-ent.file.payload+1+pick(r,ent.size)}:{});
  const seq=w.send(cmd);await w.armed(seq);items.push({w,seq,entry:ent,hold});}
 for(const x of items)release(f,x.w,x.seq);
 if(flags.remove){const h=items.shift();await h.w.event('upload-in-flight',h.seq);const observed=await waitForReservation(f,f.actors.member.id,{batch:b,operation:h.seq,worker:h.w});assert.equal(observed.row.user_id,f.actors.member.id);assert.equal(observed.row.conversation_id,f.groupId);t.diagnostic('P-34 reservation observed batch='+b+' operation='+h.seq+' worker='+h.w.index+' attempts='+observed.attempts+' elapsedMs='+observed.elapsedMs);
  const rm=await f.actors.owner.browser.request('/api/groups/'+f.groupId+'/members/'+f.actors.member.id,{method:'DELETE',headers:{'X-CSRF-Token':f.actors.owner.token}});
  assert.equal(rm.status,204);await h.w.stop(true);assert.equal(f.db.prepare('SELECT count(*) n FROM Attachments WHERE uploaded_by=?').get(f.actors.member.id).n,0);}
 let left=items.length;const done=Promise.all(items.map(async x=>{try{const result=await x.w.result();return {x,result};}finally{left--;}}));let bad;
 while(left){try{snapshotUsage(f,s);}catch(e){bad=e;break;}await new Promise(r=>setTimeout(r,2));}
 const results=await done;if(bad)throw bad;snapshotUsage(f,s);
 t.diagnostic('P-34 seed=1802750534 batch='+b+' operations='+count+' workers='+nworkers+' quotaFiles='+qfiles+' pendingMax='+pmax);
 for(const x of results)checkResult(x.x.entry,x.result,flags,x.x.w.index);
 if(flags.audit)f.db.exec('DROP TRIGGER IF EXISTS p34_fail_audit');
 const pending=f.db.prepare("SELECT attachment_id FROM Attachments WHERE status='pending'").all(),reservations=f.db.prepare('SELECT reservation_id,user_id,declared_bytes,expires_at FROM AttachmentReservations').all();
 const successes=results.filter(x=>x.result.status===201).length;
 assert.equal(pending.length,successes,'failures and refusals leave no attachment row');
 assert.equal(reservations.length,b===19?1:0,'only killed final-batch worker may retain a reservation until TTL cleanup');if(b===19){assert.equal(reservations[0].user_id,f.actors.member.id);assert.equal(reservations[0].expires_at,f.clock.iso(BASE.pendingTtlSeconds*1000));}
 assert.equal((await f.storage.listKeys()).length,successes,'each pending row has its exact stored object');
 if(b<19)assert.equal(fs.readdirSync(f.root).some(x=>x.endsWith('.part')),false,'no upload temporary files remain');
 const committed=f.db.prepare("SELECT coalesce(sum(byte_size),0) n FROM Attachments WHERE status IN ('pending','ready')").get().n;
 const reserved=f.db.prepare('SELECT coalesce(sum(declared_bytes),0) n FROM AttachmentReservations WHERE expires_at>?').get(new Date(f.clock.now()).toISOString()).n;
 const sum=pending.reduce((a,x)=>a+f.db.prepare('SELECT byte_size FROM Attachments WHERE attachment_id=?').get(x.attachment_id).byte_size,0);
 assert.equal(committed+reserved,sum+reservations.reduce((a,x)=>a+x.declared_bytes,0));
 assert.equal(f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE source='attachments'").get().n-audits,successes,'audit and row commits are atomic');
 for(const row of pending){const d=await f.actors.owner.browser.request('/api/attachments/'+row.attachment_id,{method:'DELETE',headers:{'X-CSRF-Token':f.actors.owner.token}});assert.equal(d.status,204);}
 assert.equal((await f.storage.listKeys()).length,0);if(b===19)await expireWorkerCrash(f,1);
 await Promise.all(ws.filter(w=>w.child.exitCode===null&&w.child.signalCode===null).map(w=>w.stop(false)));
}
test('P-34: 20 deterministic upload batches across independent worker processes',async t=>{const f=await fixture(t),r=rng(0x6b34cafe);
 try{for(let b=0;b<20;b++)await runBatch(t,f,b,r,{storage:b===4,audit:b===8,remove:b===19});}
 catch(error){process.stderr.write('P-34 failure: '+(error&&error.stack||error)+'\n');throw error;}
});

test('T-6B-42: separate workers enforce concurrent upload limits for one user',async t=>{
 const s={...BASE,maxConcurrentUploadsPerUser:1,maxConcurrentUploadsPerSource:5,quotaUserBytes:1048576,quotaConversationBytes:1048576};
 const f=await fixture(t,s),ws=await startWorkers(t,f,2,s);
 const held=makeFile(f,'held-user',Buffer.alloc(4096,0x7a)),seq=ws[0].send(req(f,f.actors.owner,held,{hold:true,holdBytes:held.total-held.payload+1}));
 await ws[0].armed(seq);release(f,ws[0],seq);await ws[0].event('upload-in-flight',seq);
 assert.ok(await waitForReservation(f));
 const body=makeFile(f,'header-only-user',Buffer.alloc(0),1024),n=ws[1].send(req(f,f.actors.owner,body,{headers:{'X-Forwarded-For':'203.0.113.9'}}));
 await ws[1].armed(n);release(f,ws[1],n);assert.deepEqual(await ws[1].result(),{status:429,body:{code:'RATE_LIMITED',fields:[]}});
 await ws[0].stop(true);assert.equal(f.db.prepare('SELECT count(*) n FROM Attachments').get().n,0);assert.equal((await f.storage.listKeys()).length,0);await expireWorkerCrash(f,1);await ws[1].stop(false);
});

test('T-6B-42: separate workers share source cap across users despite spoofed forwarding headers',async t=>{
 const s={...BASE,maxConcurrentUploadsPerUser:3,maxConcurrentUploadsPerSource:1,quotaUserBytes:1048576,quotaConversationBytes:1048576};
 const f=await fixture(t,s),ws=await startWorkers(t,f,2,s);
 const held=makeFile(f,'held-source',Buffer.alloc(4096,0x7b)),seq=ws[0].send(req(f,f.actors.owner,held,{hold:true,holdBytes:held.total-held.payload+1}));
 await ws[0].armed(seq);release(f,ws[0],seq);await ws[0].event('upload-in-flight',seq);
 assert.ok(await waitForReservation(f));
 const body=makeFile(f,'header-only-source',Buffer.alloc(0),1024),n=ws[1].send(req(f,f.actors.member,body,{headers:{
  'X-Forwarded-For':'198.51.100.9','Forwarded':'for=203.0.113.7','X-Real-IP':'192.0.2.3'}}));
 await ws[1].armed(n);release(f,ws[1],n);assert.deepEqual(await ws[1].result(),{status:429,body:{code:'RATE_LIMITED',fields:[]}});
 await ws[0].stop(true);assert.equal(f.db.prepare('SELECT count(*) n FROM Attachments').get().n,0);assert.equal((await f.storage.listKeys()).length,0);await expireWorkerCrash(f,1);await ws[1].stop(false);
});

test('T-6B-42: injected read, mutation and upload buckets are separate and upload refusal precedes payload reads',async t=>{
 const calls=[],limiter={consume(buckets,now){calls.push({buckets,now});return buckets.some(row=>row.key.startsWith('attachments:upload:'))?{allowed:false,retryAfterSeconds:2}:{allowed:true,retryAfterSeconds:1};}};
 const f=await fixture(t,BASE,limiter),owner=f.actors.owner;
 const read=await owner.browser.request('/api/files/search');assert.equal(read.status,200);
 const mutation=await owner.browser.request('/api/attachments/unknown',{method:'DELETE',headers:{'X-CSRF-Token':owner.token}});assert.equal(mutation.status,404);
 const upload=makeFile(f,'rate-limited',Buffer.alloc(1024,0x5a));
 const denied=await owner.browser.request('/api/attachments',{method:'POST',rawBody:fs.readFileSync(upload.file),headers:{'Content-Type':FRAME_CONTENT_TYPE,'X-CSRF-Token':owner.token}});
 assert.deepEqual(denied.body,{code:'RATE_LIMITED',fields:[]});assert.equal(denied.status,429);
 assert.ok(Number(denied.headers.get('retry-after'))>=1);
 const keys=calls.map(call=>call.buckets.map(bucket=>bucket.key));
 assert.ok(keys.some(set=>set.some(key=>key.startsWith('attachments:read:'))));
 assert.ok(keys.some(set=>set.some(key=>key.startsWith('attachments:write:'))));
 assert.ok(keys.some(set=>set.some(key=>key.startsWith('attachments:upload:'))));
 assert.ok(keys.every(set=>new Set(set).size===set.length));
 assert.equal(f.db.prepare('SELECT count(*) n FROM Attachments').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);
 assert.equal((await f.storage.listKeys()).length,0);

 const sessionToken=owner.browser.cookies.get(f.config.sessionCookie),session=f.application.auth.resolveToken(sessionToken);
 assert.equal(session.status,'authenticated');let consumed=0;
 const body=Readable.from((async function*(){consumed++;yield Buffer.alloc(1024,0x58);})());
 await assert.rejects(f.application.attachments.upload({sessionId:session.row.session_id,userId:session.row.user_id},
  f.application.auth.csrfProof(sessionToken,null,owner.token),head(f.groupId,1024),body,'127.0.0.1'),error=>error.status===429&&error.code==='RATE_LIMITED');
 assert.equal(consumed,0,'the payload stream is not read after the upload limiter refuses');
 assert.equal(f.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);
});
