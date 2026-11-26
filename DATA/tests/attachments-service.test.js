'use strict';

const { test }=require('node:test');
const assert=require('node:assert/strict');
const { createHash }=require('node:crypto');
const { Readable }=require('node:stream');
const { fixture }=require('./support/database');
const { groupFixture }=require('./support/groups');
const { storageRoot }=require('./support/attachments');
const { createFilesystemProvider }=require('../server/attachments/storage/filesystem');
const { StorageError }=require('../server/attachments/storage/provider');
const { createAttachmentService,ATTACHMENT_RATE_LIMITS }=require('../server/attachments/service');

const AT=Date.parse('2026-01-01T00:00:00.000Z');
const SOURCE='192.0.2.42';
const DEFAULT_SETTINGS=Object.freeze({pendingTtlSeconds:86400,purgeDelaySeconds:86400,retentionIntervalSeconds:3600,
    quotaUserBytes:1073741824,quotaConversationBytes:5368709120,maxPendingPerUser:10,uploadsPerHour:30,
    maxConcurrentUploadsPerUser:2,maxConcurrentUploadsPerSource:5,uploadTimeoutSeconds:120});
function enabled(root,overrides={}) { return {groupApi:false,groupMessaging:false,attachmentApi:true,
    attachments:{...DEFAULT_SETTINGS,...overrides,storageDir:root}}; }
function authFor(clock=()=>AT) {
    return {now:clock,checkSession({sessionId,userId}) { return sessionId===`session-${userId}`?{status:'active'}:{status:'revoked'}; },
        repository:{verifyProof(proof) { if(proof.csrfHash!=='synthetic-proof') throw new Error('invalid proof'); }}};
}
function context(userId) { return {sessionId:`session-${userId}`,userId}; }
function proof(userId) { return {type:'session',sessionId:`session-${userId}`,userId,csrfHash:'synthetic-proof'}; }
function openLimiter() { const calls=[];return {calls,consume(buckets,now) {calls.push({buckets,now});return {allowed:true};}}; }
function setup(t,{settings={},featuresEnabled=true,limiter=openLimiter(),storageWrap=null,logger=()=>{}}={}) {
    const f=groupFixture(t),root=storageRoot(t),base=createFilesystemProvider({root,repositoryRoot:require('node:path').resolve(__dirname,'../..')});
    const storage=storageWrap?storageWrap(base):base;
    const features=featuresEnabled?enabled(root,settings):{groupApi:false,groupMessaging:false,attachmentApi:false,attachments:{storageDir:root}};
    const service=createAttachmentService({db:f.db,auth:authFor(),features,settings:{...DEFAULT_SETTINGS,...settings},storage,limiter,now:()=>AT,logger});
    const actor=f.actors.owner.id;
    return {...f,root,storage,service,limiter,actor,context:context(actor),proof:proof(actor)};
}
function header(conversationId,byteSize=4,extra={}) { return {conversationId,byteSize,encryptedMetadata:'opaque-ciphertext-metadata',algorithm:'X25519-AESGCM',formatVersion:'v1',...extra}; }
function outcome(work) { try { work();return null; } catch(error) { return {code:error.code,status:error.status,fields:error.fields}; } }
function counts(db) { return {attachments:db.prepare('SELECT count(*) n FROM Attachments').get().n,
    reservations:db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,
    audit:db.prepare("SELECT count(*) n FROM AuditLogs WHERE source='attachments'").get().n}; }
function seedDirect(f,a,b,id='direct-service') {
    for(const userId of [a,b]) {
        const user=f.repositories.users.get(userId);
        f.db.prepare(`INSERT INTO AccountCredentials(user_id,username_key,email_key,password_hash,status)
            VALUES(?,?,?,?,'active')`).run(userId,user.username,`${user.username}@example.test`,'$argon2id$synthetic');
    }
    const [low,high]=[a,b].sort();
    f.repositories.conversations.create({conversation_id:id,kind:'direct',created_by:a,dm_user_low:low,dm_user_high:high,origin:'authenticated'});
    f.db.prepare("INSERT INTO Friendships(user_low,user_high,origin) VALUES(?,?,'authenticated')").run(low,high);
    return id;
}
function addPending(f,id,{conversationId=f.groupId,uploader=f.actors.owner.id,status='pending',messageId=null,byteSize=4,
    expiresAt='2026-02-01T00:00:00.000Z'}={}) {
    const storageKey=createHash('sha256').update(id).digest('hex').slice(0,48);
    return f.db.transaction(()=>f.db.prepare(`INSERT INTO Attachments(attachment_id,conversation_id,message_id,uploaded_by,storage_key,
        encrypted_metadata,media_type,byte_size,status,expires_at,integrity_digest,declared_algorithm,declared_format_version)
        VALUES(?,?,?,?,?,?,'application/octet-stream',?,?,?,?,'X25519-AESGCM','v1')`).run(id,conversationId,messageId,uploader,storageKey,'opaque',byteSize,status,expiresAt,'a'.repeat(64))).immediate();
}
function insertMessage(f,id,{conversationId=f.groupId,sender=f.actor,sequence=1,createdAt='2026-01-01T00:00:00.000Z'}={}) {
    const conversation=f.repositories.conversations.get(conversationId);
    const receiver=conversation?.kind==='direct'?(conversation.dm_user_low===sender?conversation.dm_user_high:conversation.dm_user_low):null;
    return f.repositories.messages.insertAuthenticated({message_id:id,conversation_id:conversationId,sender_id:sender,receiver_id:receiver,
        ciphertext:'opaque-ciphertext',iv:'opaque-iv',envelope_version:1,encoding:'base64',sender_name:'synthetic',
        client_timestamp:createdAt,message_type:'text',fingerprint:String(sequence).padStart(64,'0'),client_id:`client-${id}`,
        message_seq:sequence,created_at:createdAt});
}
async function storeBytes(f,id,bytes=Buffer.from('data')) {
    const row=f.db.prepare('SELECT storage_key FROM Attachments WHERE attachment_id=?').get(id);
    await f.storage.write(row.storage_key,Readable.from([bytes]),{maxBytes:bytes.length});
    return row.storage_key;
}

test('T-6B-23 exposes guarded read/write boundaries and fails closed with feature, session and CSRF checks',t=>{
    const f=setup(t,{featuresEnabled:false});
    assert.throws(()=>f.service.attachmentRead(f.context,()=>1),error=>error.status===503&&error.code==='FEATURE_UNAVAILABLE'&&error.fields.length===0);
    assert.throws(()=>f.service.reserve(f.context,f.proof,header(f.groupId),SOURCE),error=>error.status===503&&error.code==='FEATURE_UNAVAILABLE');
    assert.deepEqual(counts(f.db),{attachments:0,reservations:0,audit:0});
    const active=setup(t);
    assert.throws(()=>active.service.attachmentRead({sessionId:'wrong',userId:active.actor},()=>1),error=>error.status===401);
    assert.throws(()=>active.service.reserve(active.context,{...active.proof,userId:'spoof'},header(active.groupId),SOURCE),error=>error.status===403&&error.code==='CSRF_INVALID');
    assert.throws(()=>active.service.attachmentRead(active.context,()=>Promise.resolve(1)),error=>error.code==='INTERNAL_ERROR'&&error.status===500);
    assert.throws(()=>active.service.attachmentRead(active.context,()=>active.db.prepare('DELETE FROM Attachments').run()),error=>error.status===500);
    assert.equal(active.db.prepare('SELECT count(*) n FROM Attachments').get().n,0);
    assert.throws(()=>active.service.attachmentWrite(active.context,active.proof,async()=>1),error=>error.code==='INTERNAL_ERROR'&&error.status===500);
    assert.deepEqual(counts(active.db),{attachments:0,reservations:0,audit:0});
    assert.equal(ATTACHMENT_RATE_LIMITS.readUser.limit,120);
});

test('T-6B-23 preserves group and direct access refusal rules and a uniform 404 for hidden or malformed ids',t=>{
    const f=setup(t),member=f.actors.member.id,removed=f.actors.removedMember.id,outsider=f.actors.nonMember.id;
    const call=(user,id)=>outcome(()=>f.service.reserve(context(user),proof(user),header(id),SOURCE));
    const ownerMissing=call(f.actor,'missing-conversation');
    assert.deepEqual(ownerMissing,{code:'NOT_FOUND',status:404,fields:[]});
    assert.deepEqual(call(outsider,f.groupId),ownerMissing);
    assert.deepEqual(call(removed,f.groupId),ownerMissing);
    assert.deepEqual(call(f.actor,'bad/id'),ownerMissing);
    const direct=seedDirect(f,f.actor,member);
    const noFriend=f.db.prepare('DELETE FROM Friendships WHERE user_low=? AND user_high=?').run(...[f.actor,member].sort());
    assert.equal(noFriend.changes,1);
    assert.deepEqual(call(f.actor,direct),{code:'FORBIDDEN',status:403,fields:[]});
    f.db.prepare('INSERT INTO Blocks(blocker_id,blocked_id) VALUES(?,?)').run(member,f.actor);
    assert.deepEqual(call(f.actor,direct),ownerMissing);
    assert.deepEqual(counts(f.db),{attachments:0,reservations:0,audit:0});
});

test('T-6B-24 commits one hashed-source reservation and applies quotas and concurrent limits atomically',async t=>{
    const f=setup(t,{settings:{maxPendingPerUser:2,maxConcurrentUploadsPerUser:1,quotaUserBytes:20,quotaConversationBytes:20}});
    const actor={...f.context,csrfProof:f.proof,sourceAddress:SOURCE};
    const attempt=()=>Promise.resolve().then(()=>f.service.reserve(actor,header(f.groupId))).then(value=>value,error=>({code:error.code,status:error.status,fields:error.fields,retryAfterSeconds:error.retryAfterSeconds}));
    const results=await Promise.all([attempt(),attempt()]);
    assert.equal(results.filter(value=>value.reservationId).length,1);
    const refusal=results.find(value=>!value.reservationId);
    assert.deepEqual(refusal,{code:'RATE_LIMITED',status:429,fields:[],retryAfterSeconds:1});
    const row=f.db.prepare('SELECT * FROM AttachmentReservations').get();
    assert.equal(row.declared_bytes,4);assert.equal(row.source_digest,require('node:crypto').createHash('sha256').update(SOURCE).digest('hex'));
    assert.equal(JSON.stringify(row).includes(SOURCE),false);assert.equal(row.expires_at,'2026-01-02T00:00:00.000Z');
    assert.equal(counts(f.db).reservations,1);
    const uploadBucket=f.limiter.calls[0].buckets.find(bucket=>bucket.key==='attachments:upload:'+f.actor);
    assert.deepEqual({limit:uploadBucket.limit,windowMs:uploadBucket.windowMs},{limit:30,windowMs:3600000});
    assert.equal(f.limiter.calls[0].buckets.some(bucket=>bucket.key.includes(SOURCE)),false);
});

test('T-6B-24 refuses over-quota, archived and rate-limited uploads without inserting reservations',t=>{
    const f=setup(t,{settings:{quotaUserBytes:3,quotaConversationBytes:3}});
    const before=counts(f.db);
    assert.deepEqual(outcome(()=>f.service.reserve(f.context,f.proof,header(f.groupId),SOURCE)),{code:'QUOTA_EXCEEDED',status:409,fields:[]});
    assert.deepEqual(counts(f.db),before);
    f.repositories.conversations.archive(f.groupId,'2026-01-01T00:00:00.000Z');
    assert.deepEqual(outcome(()=>f.service.reserve(f.context,f.proof,header(f.groupId),SOURCE)),{code:'CONFLICT',status:409,fields:[]});
    assert.deepEqual(counts(f.db),before);
    const limited=setup(t,{limiter:{consume(){return {allowed:false,retryAfterSeconds:0};}}});
    assert.deepEqual(outcome(()=>limited.service.reserve(limited.context,limited.proof,header(limited.groupId),SOURCE)),{code:'RATE_LIMITED',status:429,fields:[]});
    assert.equal(limited.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);
});

test('T-6B-24 counts existing pending/ready usage, pending rows, and live reservations for each quota',t=>{
    const user=setup(t,{settings:{quotaUserBytes:4,quotaConversationBytes:100}});addPending(user,'user-usage',{byteSize:4});
    assert.deepEqual(outcome(()=>user.service.reserve(user.context,user.proof,header(user.groupId),SOURCE)),{code:'QUOTA_EXCEEDED',status:409,fields:[]});
    assert.equal(user.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);

    const conversation=setup(t,{settings:{quotaUserBytes:100,quotaConversationBytes:4}});addPending(conversation,'conversation-usage',{uploader:conversation.actors.member.id,byteSize:4});
    assert.deepEqual(outcome(()=>conversation.service.reserve(conversation.context,conversation.proof,header(conversation.groupId),SOURCE)),{code:'QUOTA_EXCEEDED',status:409,fields:[]});
    assert.equal(conversation.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);

    const pending=setup(t,{settings:{maxPendingPerUser:1,quotaUserBytes:100,quotaConversationBytes:100}});addPending(pending,'pending-count');
    assert.deepEqual(outcome(()=>pending.service.reserve(pending.context,pending.proof,header(pending.groupId),SOURCE)),{code:'QUOTA_EXCEEDED',status:409,fields:[]});
    assert.equal(pending.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);
});

test('T-6B-24 hashes source addresses for the independent per-source concurrent-upload limit',t=>{
    const f=setup(t,{settings:{maxConcurrentUploadsPerUser:2,maxConcurrentUploadsPerSource:1,quotaUserBytes:100,quotaConversationBytes:100}});
    const ownerActor={...f.context,csrfProof:f.proof,sourceAddress:SOURCE};
    f.service.reserve(ownerActor,header(f.groupId));
    const member=f.actors.member.id,memberActor={...context(member),csrfProof:proof(member),sourceAddress:SOURCE};
    assert.deepEqual(outcome(()=>f.service.reserve(memberActor,header(f.groupId))),{code:'RATE_LIMITED',status:429,fields:[]});
    const rows=f.db.prepare('SELECT source_digest FROM AttachmentReservations').all();
    assert.equal(rows.length,1);assert.equal(rows[0].source_digest,require('node:crypto').createHash('sha256').update(SOURCE).digest('hex'));
});
test('T-6B-25 streams only declared bytes plus one, finalizes pending row and audit atomically',async t=>{
    const bytes=Buffer.from('four');let f,transactionDuringStorage=null;
    f=setup(t,{storageWrap:base=>({...base,async write(key,stream,options){transactionDuringStorage=f.db.inTransaction;return base.write(key,stream,options);}})});
    const result=await f.service.upload(f.context,f.proof,header(f.groupId,bytes.length),Readable.from([bytes.subarray(0,1),bytes.subarray(1)]),SOURCE);
    assert.deepEqual(Object.keys(result).sort(),['algorithm','byteSize','conversationId','createdAt','encryptedMetadata','expiresAt','formatVersion','id','integrityDigest','messageId','status','uploadedBy'].sort());
    assert.equal(result.status,'pending');assert.equal(result.messageId,null);assert.equal(result.byteSize,bytes.length);
    assert.equal(transactionDuringStorage,false,'the reservation transaction is committed before awaiting storage I/O');
    assert.equal(result.expiresAt,'2026-01-02T00:00:00.000Z');assert.equal(result.integrityDigest,require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
    assert.equal('storage_key' in result,false);
    const row=f.db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(result.id);
    assert.equal(row.media_type,'application/octet-stream');assert.equal(row.status,'pending');assert.equal(row.conversation_id,f.groupId);assert.equal(row.uploaded_by,f.actor);
    assert.equal(await f.storage.exists(row.storage_key),true);
    assert.equal(f.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);
    const event=f.db.prepare("SELECT * FROM AuditLogs WHERE source='attachments'").get();
    assert.equal(event.subject_id,result.id);assert.equal(event.event_type,'attachment.uploaded');
    assert.deepEqual(JSON.parse(event.metadata_json),{operation:'upload',outcome:'created',target_id:f.groupId});
});

test('T-6B-26 short, over-declared, aborted, and storage-failed streams clean files and reservations',async t=>{
    for(const kind of ['short','over','storage','stream']) {
        const f=setup(t,{storageWrap:base=>kind==='storage'?{...base,async write(){throw new StorageError('STORAGE_IO');}}:base});
        const payload=kind==='short'?Readable.from([Buffer.from('x')]):kind==='over'?Readable.from([Buffer.from('12345')]):kind==='stream'?new Readable({read(){this.destroy(new Error('synthetic stream interruption'));}}):Readable.from([Buffer.from('1234')]);
        const result=await f.service.upload(f.context,f.proof,header(f.groupId,4),payload,SOURCE).then(()=>null,error=>({code:error.code,status:error.status,fields:error.fields}));
        if(kind==='short'||kind==='over') assert.deepEqual(result,{code:'VALIDATION_ERROR',status:400,fields:[]});
        else assert.deepEqual(result,{code:'SERVICE_UNAVAILABLE',status:503,fields:[]});
        assert.deepEqual(counts(f.db),{attachments:0,reservations:0,audit:0});
        assert.deepEqual(await f.storage.listKeys(),[]);
    }
});

test('T-6B-25 caps over-limit streaming at declared bytes plus one and applies the 50 MiB refusal rule',async t=>{
    const max=50*1048576,chunk=Buffer.alloc(64*1024,0x41);let observed=0;
    const f=setup(t,{storageWrap:base=>({...base,async write(key,stream,{maxBytes}){for await(const part of stream){observed+=part.length;if(observed>maxBytes)throw new StorageError('STORAGE_SIZE');}return {byteCount:observed,sha256:'a'.repeat(64)};}})});
    const source=new Readable({read(){if(this.sent===undefined)this.sent=0;if(this.sent>=max+2){this.push(null);return;}const n=Math.min(chunk.length,max+2-this.sent);this.sent+=n;this.push(chunk.subarray(0,n));}});
    const result=await f.service.upload(f.context,f.proof,header(f.groupId,max),source,SOURCE).then(()=>null,error=>({code:error.code,status:error.status,fields:error.fields}));
    assert.deepEqual(result,{code:'PAYLOAD_TOO_LARGE',status:413,fields:[]});assert.equal(observed,max+1);
    assert.deepEqual(counts(f.db),{attachments:0,reservations:0,audit:0});assert.deepEqual(await f.storage.listKeys(),[]);
    const tooLargeHeader=header(f.groupId,max+1);
    assert.deepEqual(outcome(()=>f.service.reserve(f.context,f.proof,tooLargeHeader,SOURCE)),{code:'PAYLOAD_TOO_LARGE',status:413,fields:[]});
    assert.equal(f.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);
});
test('T-6B-26 finalize rechecks membership and archive state and rolls back audit failure',async t=>{
    let removed;
    const removeWrap=base=>{const write=base.write.bind(base);return Object.assign({},base,{async write(key,stream,options){const value=await write(key,stream,options);removed.builder.removeMember(removed.groupId,removed.actors.member.id);return value;}});};
    removed=setup(t,{storageWrap:removeWrap});
    const memberContext=context(removed.actors.member.id),memberProof=proof(removed.actors.member.id);
    const removedResult=await removed.service.upload(memberContext,memberProof,header(removed.groupId),Readable.from([Buffer.from('1234')]),SOURCE).then(()=>null,error=>({code:error.code,status:error.status}));
    assert.deepEqual(removedResult,{code:'NOT_FOUND',status:404});assert.deepEqual(counts(removed.db),{attachments:0,reservations:0,audit:0});assert.deepEqual(await removed.storage.listKeys(),[]);

    let archived;
    const archiveWrap=base=>{const write=base.write.bind(base);return Object.assign({},base,{async write(key,stream,options){const value=await write(key,stream,options);archived.repositories.conversations.archive(archived.groupId,'2026-01-01T00:01:00.000Z');return value;}});};
    archived=setup(t,{storageWrap:archiveWrap});
    const archivedResult=await archived.service.upload(archived.context,archived.proof,header(archived.groupId),Readable.from([Buffer.from('1234')]),SOURCE).then(()=>null,error=>({code:error.code,status:error.status}));
    assert.deepEqual(archivedResult,{code:'CONFLICT',status:409});assert.deepEqual(counts(archived.db),{attachments:0,reservations:0,audit:0});assert.deepEqual(await archived.storage.listKeys(),[]);

    const audit=setup(t);audit.db.exec(`CREATE TRIGGER fail_attachment_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type='attachment.uploaded' BEGIN SELECT RAISE(ABORT,'private database detail'); END;`);
    const auditError=await audit.service.upload(audit.context,audit.proof,header(audit.groupId),Readable.from([Buffer.from('1234')]),SOURCE).then(()=>null,error=>error);
    assert.equal(auditError.code,'INTERNAL_ERROR');assert.equal(auditError.status,500);assert.deepEqual(auditError.fields,[]);
    assert.doesNotMatch(JSON.stringify(auditError),/private database detail|storage|path/i);
    assert.deepEqual(counts(audit.db),{attachments:0,reservations:0,audit:0});assert.deepEqual(await audit.storage.listKeys(),[]);
});

test('T-6B-27 metadata projects only approved fields for pending uploader and ready conversation members',t=>{
    const f=setup(t),member=f.actors.member.id;
    addPending(f,'pending-meta');
    const own=f.service.metadata(f.context,'pending-meta');
    assert.equal(own.id,'pending-meta');assert.equal(own.status,'pending');assert.equal(own.uploadedBy,f.actor);
    assert.equal('storage_key' in own,false);assert.equal(JSON.stringify(own).includes('storage_key'),false);
    addPending(f,'expired-pending-meta',{expiresAt:'2025-12-31T23:59:59.999Z'});
    assert.deepEqual(outcome(()=>f.service.metadata(f.context,'expired-pending-meta')),{code:'NOT_FOUND',status:404,fields:[]});
    assert.deepEqual(outcome(()=>f.service.metadata(context(member),'pending-meta')),{code:'NOT_FOUND',status:404,fields:[]});
    const repos=f.repositories;
    const readyMessageId='attachment-ready-message';
    repos.messages.insertAuthenticated({message_id:readyMessageId,conversation_id:f.groupId,sender_id:f.actor,receiver_id:null,ciphertext:'opaque',iv:'opaque',
        envelope_version:1,encoding:'base64',sender_name:'Owner',client_timestamp:'2026-01-01T00:00:00.000Z',message_type:'text',fingerprint:'a'.repeat(64),
        client_id:'attachment-ready-client',message_seq:1,created_at:'2026-01-01T00:00:00.000Z'});
    addPending(f,'ready-meta',{status:'pending'});
    f.db.transaction(()=>f.db.prepare("UPDATE Attachments SET status='ready',message_id=? WHERE attachment_id='ready-meta'").run(readyMessageId)).immediate();
    assert.equal(f.service.metadata(context(member),'ready-meta').status,'ready');
    const before=counts(f.db);
    assert.deepEqual(outcome(()=>f.service.metadata(context(f.actors.nonMember.id),'ready-meta')),{code:'NOT_FOUND',status:404,fields:[]});
    assert.deepEqual(counts(f.db),before);
    assert.deepEqual(outcome(()=>f.service.metadata(f.context,'missing-attachment')),{code:'NOT_FOUND',status:404,fields:[]});
});

test('T-6B-26 cleanup errors are counted without replacing the response or exposing storage details',async t=>{
    const logs=[];
    const f=setup(t,{storageWrap:base=>({...base,async write(){throw new StorageError('STORAGE_IO');},async delete(){throw new Error('C:\\private\\root');}}),logger:entry=>logs.push(entry)});
    const error=await f.service.upload(f.context,f.proof,header(f.groupId),Readable.from([Buffer.from('1234')]),SOURCE).then(()=>null,e=>e);
    assert.equal(error.status,503);assert.equal(error.code,'SERVICE_UNAVAILABLE');assert.deepEqual(error.fields,[]);
    assert.deepEqual(logs,['attachment cleanup failed count=1']);assert.doesNotMatch(logs.join(' '),/private|root|[A-Z]:\\/i);
    assert.equal(f.db.prepare('SELECT count(*) n FROM AttachmentReservations').get().n,0);
});

test('T-6B-28 deletion commits status and audit before removing bytes, keeps metadata, and hides repeats and other uploaders',async t=>{
    const f=setup(t),id='delete-pending';addPending(f,id);const key=await storeBytes(f,id);
    const result=await f.service.remove(f.context,f.proof,id);
    assert.equal(result,undefined);
    const row=f.db.prepare('SELECT status,deleted_at,purge_state,storage_key FROM Attachments WHERE attachment_id=?').get(id);
    assert.deepEqual(row,{status:'deleted',deleted_at:new Date(AT).toISOString(),purge_state:'purged',storage_key:key});
    assert.equal(await f.storage.stat(key),null);
    assert.equal(f.db.prepare("SELECT count(*) n FROM Attachments WHERE attachment_id=?").get(id).n,1);
    const event=f.db.prepare("SELECT event_type,subject_id,metadata_json FROM AuditLogs WHERE source='attachments'").get();
    assert.equal(event.event_type,'attachment.deleted');assert.equal(event.subject_id,id);
    assert.deepEqual(JSON.parse(event.metadata_json),{operation:'delete',outcome:'deleted',target_id:f.groupId});
    assert.deepEqual(await f.service.remove(context(f.actors.member.id),proof(f.actors.member.id),id).then(()=>null,e=>({status:e.status,code:e.code})),
        {status:404,code:'NOT_FOUND'});
    assert.deepEqual(await f.service.remove(context(f.actors.removedMember.id),proof(f.actors.removedMember.id),id).then(()=>null,e=>({status:e.status,code:e.code})),
        {status:404,code:'NOT_FOUND'});
    assert.deepEqual(await f.service.remove(f.context,f.proof,id).then(()=>null,e=>({status:e.status,code:e.code})),
        {status:404,code:'NOT_FOUND'});
    assert.deepEqual(await f.service.download(f.context,id).then(()=>null,e=>({status:e.status,code:e.code})),
        {status:404,code:'NOT_FOUND'});
    insertMessage(f,'delete-ready-message');addPending(f,'delete-ready');
    f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'delete-ready-message',attachmentIds:['delete-ready']});
    const readyKey=await storeBytes(f,'delete-ready');await f.service.remove(f.context,f.proof,'delete-ready');
    assert.deepEqual(f.db.prepare("SELECT status,purge_state FROM Attachments WHERE attachment_id='delete-ready'").get(),
        {status:'deleted',purge_state:'purged'});
    assert.equal(await f.storage.stat(readyKey),null);
});

test('T-6B-28 deletion audit failure rolls back; byte-removal failure leaves a retryable tombstone',async t=>{
    const audit=setup(t),auditId='delete-audit-failure';addPending(audit,auditId);const auditKey=await storeBytes(audit,auditId);
    audit.db.exec("CREATE TRIGGER fail_attachment_delete_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type='attachment.deleted' BEGIN SELECT RAISE(ABORT,'private detail'); END;");
    const failed=await audit.service.remove(audit.context,audit.proof,auditId).then(()=>null,e=>e);
    assert.equal(failed.code,'INTERNAL_ERROR');assert.equal(failed.status,500);
    assert.equal(audit.db.prepare('SELECT status FROM Attachments WHERE attachment_id=?').get(auditId).status,'pending');
    assert.equal(await audit.storage.stat(auditKey),4);assert.equal(audit.db.prepare("SELECT count(*) n FROM AuditLogs WHERE source='attachments'").get().n,0);

    const logs=[],storage=setup(t,{storageWrap:base=>({...base,async delete(){throw new Error('private path');}}),logger:x=>logs.push(x)});
    const failedBytes='delete-storage-failure';addPending(storage,failedBytes);await storeBytes(storage,failedBytes);
    await storage.service.remove(storage.context,storage.proof,failedBytes);
    const retry=storage.db.prepare('SELECT status,purge_state FROM Attachments WHERE attachment_id=?').get(failedBytes);
    assert.deepEqual(retry,{status:'deleted',purge_state:'not_purged'});
    assert.deepEqual(logs,['attachment deletion failed count=1']);assert.doesNotMatch(logs.join(' '),/private|path/i);
});

test('T-6B-29 association is atomic, binds only the requester\'s committed message, and counts existing message attachments',async t=>{
    const f=setup(t);insertMessage(f,'assoc-message');addPending(f,'assoc-one');addPending(f,'assoc-two');
    const associated=f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-message',attachmentIds:['assoc-one','assoc-two']});
    assert.deepEqual(associated.map(row=>[row.id,row.status,row.messageId]),[
        ['assoc-one','ready','assoc-message'],['assoc-two','ready','assoc-message']]);
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-message',attachmentIds:['assoc-one']})),
        {code:'CONFLICT',status:409,fields:[]});
    assert.equal(f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE source='attachments' AND event_type='attachment.associated'").get().n,1);
    const associationAudit=f.db.prepare("SELECT metadata_json FROM AuditLogs WHERE event_type='attachment.associated'").get();
    assert.deepEqual(JSON.parse(associationAudit.metadata_json),{operation:'associate',outcome:'ready',count:2,target_id:f.groupId});
    addPending(f,'assoc-three');addPending(f,'assoc-four');addPending(f,'assoc-five');
    assert.equal(f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-message',
        attachmentIds:['assoc-three','assoc-four','assoc-five']}).length,3);
    await f.service.remove(f.context,f.proof,'assoc-one');
    assert.deepEqual(f.db.prepare("SELECT status,message_id FROM Attachments WHERE attachment_id='assoc-one'").get(),
        {status:'deleted',message_id:'assoc-message'});
    addPending(f,'assoc-six');const before=f.db.prepare('SELECT attachment_id,status,message_id FROM Attachments ORDER BY attachment_id').all();
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-message',attachmentIds:['assoc-six']})),
        {code:'VALIDATION_ERROR',status:400,fields:['attachmentIds']});
    assert.deepEqual(f.db.prepare('SELECT attachment_id,status,message_id FROM Attachments ORDER BY attachment_id').all(),before);
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'not-committed',attachmentIds:['assoc-six']})),
        {code:'CONFLICT',status:409,fields:[]});
    const member=f.actors.member.id;
    assert.deepEqual(outcome(()=>f.service.associate(context(member),proof(member),{conversationId:f.groupId,messageId:'assoc-message',attachmentIds:['assoc-six']})),
        {code:'CONFLICT',status:409,fields:[]});
});

test('T-6B-29 association refusals preserve every requested row and audit state, including a valid row paired with a missing one',t=>{
    const f=setup(t);insertMessage(f,'assoc-atomic-message');addPending(f,'assoc-atomic-valid');
    const before=f.db.prepare('SELECT attachment_id,status,message_id FROM Attachments ORDER BY attachment_id').all();
    const audits=f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE source='attachments'").get().n;
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-atomic-message',
        attachmentIds:['assoc-atomic-valid','missing-association']})),{code:'NOT_FOUND',status:404,fields:[]});
    assert.deepEqual(outcome(()=>f.service.associate(context(f.actors.nonMember.id),proof(f.actors.nonMember.id),
        {conversationId:f.groupId,messageId:17,attachmentIds:17})),{code:'NOT_FOUND',status:404,fields:[]});
    assert.deepEqual(f.db.prepare('SELECT attachment_id,status,message_id FROM Attachments ORDER BY attachment_id').all(),before);
    assert.equal(f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE source='attachments'").get().n,audits);
    addPending(f,'assoc-expired',{expiresAt:'2025-12-31T23:59:59.999Z'});
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-atomic-message',attachmentIds:['assoc-expired']})),
        {code:'CONFLICT',status:409,fields:[]});
    const other=f.actors.member.id;addPending(f,'assoc-other-uploader',{uploader:other});
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-atomic-message',attachmentIds:['assoc-other-uploader']})),
        {code:'NOT_FOUND',status:404,fields:[]});
    const direct=seedDirect(f,f.actor,other,'association-other-conversation');addPending(f,'assoc-other-conversation',{conversationId:direct});
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-atomic-message',attachmentIds:['assoc-other-conversation']})),
        {code:'NOT_FOUND',status:404,fields:[]});
    insertMessage(f,'assoc-foreign-conversation-message',{conversationId:direct,sequence:1});addPending(f,'assoc-message-mismatch');
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,
        messageId:'assoc-foreign-conversation-message',attachmentIds:['assoc-message-mismatch']})),{code:'CONFLICT',status:409,fields:[]});
    f.db.prepare("INSERT INTO Blocks(blocker_id,blocked_id,origin,created_at) VALUES(?,?,'authenticated',?)").run(other,f.actor,new Date(AT).toISOString());
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:direct,messageId:17,attachmentIds:17})),
        {code:'NOT_FOUND',status:404,fields:[]});
    f.db.exec("CREATE TRIGGER fail_association_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type='attachment.associated' BEGIN SELECT RAISE(ABORT,'private detail'); END;");
    const failed=outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-atomic-message',attachmentIds:['assoc-atomic-valid']}));
    assert.deepEqual(failed,{code:'INTERNAL_ERROR',status:500,fields:[]});
    assert.equal(f.db.prepare("SELECT status FROM Attachments WHERE attachment_id='assoc-atomic-valid'").get().status,'pending');
});

test('T-6B-29 association enforces the whole-message 100 MiB byte limit including prior associations',t=>{
    const f=setup(t);insertMessage(f,'assoc-size-message');
    addPending(f,'assoc-size-a',{byteSize:52428800});addPending(f,'assoc-size-b',{byteSize:52428800});
    f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-size-message',attachmentIds:['assoc-size-a','assoc-size-b']});
    addPending(f,'assoc-size-c',{byteSize:1});
    assert.deepEqual(outcome(()=>f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'assoc-size-message',attachmentIds:['assoc-size-c']})),
        {code:'VALIDATION_ERROR',status:400,fields:['attachmentIds']});
    assert.equal(f.db.prepare("SELECT status FROM Attachments WHERE attachment_id='assoc-size-c'").get().status,'pending');
    assert.equal(f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE event_type='attachment.associated'").get().n,1);
});

test('T-6B-30 download checks ready visibility and byte length before returning a stream, then audits only completed streams',async t=>{
    const f=setup(t);addPending(f,'download-pending');
    assert.deepEqual(await f.service.download(f.context,'download-pending').then(()=>null,e=>({status:e.status,code:e.code})),
        {status:404,code:'NOT_FOUND'});
    insertMessage(f,'download-message');addPending(f,'download-ready',{byteSize:10});
    f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'download-message',attachmentIds:['download-ready']});
    const key=await storeBytes(f,'download-ready',Buffer.from('ciphertext'));
    const result=await f.service.download(f.context,'download-ready');
    assert.deepEqual(result.headers,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment',
        'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Length':'10'});
    assert.equal(f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE event_type='attachment.downloaded'").get().n,0);
    const chunks=[];for await(const chunk of result.stream)chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(),'ciphertext');
    result.onSent();result.onSent();
    assert.equal(f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE event_type='attachment.downloaded'").get().n,1);
    assert.equal((await f.storage.stat(key)),10);
    assert.deepEqual(await f.service.download(context(f.actors.nonMember.id),'download-ready').then(()=>null,e=>({status:e.status,code:e.code})),
        {status:404,code:'NOT_FOUND'});
    assert.deepEqual(await f.service.download(f.context,'unknown-download').then(()=>null,e=>({status:e.status,code:e.code})),
        {status:404,code:'NOT_FOUND'});
});

test('T-6B-30 missing or mismatched bytes return 503 before streaming and audit the unavailable reason without changing attachment rows',async t=>{
    const missing=setup(t);insertMessage(missing,'missing-download-message');addPending(missing,'missing-download');
    missing.service.associate(missing.context,missing.proof,{conversationId:missing.groupId,messageId:'missing-download-message',attachmentIds:['missing-download']});
    const before=missing.db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get('missing-download');
    assert.deepEqual(await missing.service.download(missing.context,'missing-download').then(()=>null,e=>({status:e.status,code:e.code,fields:e.fields})),
        {status:503,code:'SERVICE_UNAVAILABLE',fields:[]});
    assert.deepEqual(missing.db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get('missing-download'),before);
    const absent=missing.db.prepare("SELECT event_type,metadata_json FROM AuditLogs WHERE event_type='attachment.download.unavailable'").get();
    assert.equal(absent.event_type,'attachment.download.unavailable');assert.deepEqual(JSON.parse(absent.metadata_json),{reason_code:'missing',target_id:'missing-download'});

    const mismatch=setup(t,{storageWrap:base=>({...base,async stat(){return 99;}})});
    insertMessage(mismatch,'mismatch-download-message');addPending(mismatch,'mismatch-download');
    mismatch.service.associate(mismatch.context,mismatch.proof,{conversationId:mismatch.groupId,messageId:'mismatch-download-message',attachmentIds:['mismatch-download']});
    assert.deepEqual(await mismatch.service.download(mismatch.context,'mismatch-download').then(()=>null,e=>({status:e.status,code:e.code})),
        {status:503,code:'SERVICE_UNAVAILABLE'});
    assert.deepEqual(JSON.parse(mismatch.db.prepare("SELECT metadata_json FROM AuditLogs WHERE event_type='attachment.download.unavailable'").get().metadata_json),
        {reason_code:'length_mismatch',target_id:'mismatch-download'});

    const logs=[],audit=setup(t,{logger:entry=>logs.push(entry)});insertMessage(audit,'audit-download-message');addPending(audit,'audit-download');
    audit.service.associate(audit.context,audit.proof,{conversationId:audit.groupId,messageId:'audit-download-message',attachmentIds:['audit-download']});
    audit.db.exec("CREATE TRIGGER fail_download_audit BEFORE INSERT ON AuditLogs WHEN NEW.event_type='attachment.download.unavailable' BEGIN SELECT RAISE(ABORT,'private detail'); END;");
    assert.deepEqual(await audit.service.download(audit.context,'audit-download').then(()=>null,e=>({status:e.status,code:e.code})),
        {status:503,code:'SERVICE_UNAVAILABLE'});
    assert.deepEqual(logs,['attachment audit failed count=1']);
});

test('T-6B-30 a stream failure after bytes begin is sanitized, incomplete and never audited as downloaded',async t=>{
    const f=setup(t,{storageWrap:base=>({...base,async read(){return {byteCount:10,stream:Readable.from((async function*(){
        yield Buffer.from('first');await new Promise(resolve=>setTimeout(resolve,20));throw new Error('private filesystem detail');
    })())};}})});
    insertMessage(f,'broken-download-message');addPending(f,'broken-download',{byteSize:10});await storeBytes(f,'broken-download',Buffer.from('0123456789'));
    f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId:'broken-download-message',attachmentIds:['broken-download']});
    const result=await f.service.download(f.context,'broken-download');const chunks=[];
    await assert.rejects(async()=>{for await(const chunk of result.stream)chunks.push(chunk);});
    assert.ok(Buffer.concat(chunks).length>0&&Buffer.concat(chunks).length<10);
    assert.equal(f.db.prepare("SELECT count(*) n FROM AuditLogs WHERE event_type='attachment.downloaded'").get().n,0);
});

test('T-6B-31 file search validates the filter allowlist and returns cursor-bound indexed ready results',t=>{
    const f=setup(t);
    for(let index=1;index<=3;index++){
        const messageId=`search-message-${index}`;insertMessage(f,messageId,{sequence:index,createdAt:`2026-01-01T00:00:0${index}.000Z`});
        const id=`search-attachment-${index}`;addPending(f,id,{byteSize:index});
        f.service.associate(f.context,f.proof,{conversationId:f.groupId,messageId,attachmentIds:[id]});
    }
    const first=f.service.search(f.context,{limit:'1'});
    assert.equal(first.items.length,1);assert.equal(first.items[0].id,'search-attachment-3');assert.equal(typeof first.nextCursor,'string');
    const second=f.service.search(f.context,{limit:'1',cursor:first.nextCursor});
    assert.equal(second.items.length,1);assert.equal(second.items[0].id,'search-attachment-2');assert.notEqual(second.items[0].id,first.items[0].id);
    const third=f.service.search(f.context,{limit:'1',cursor:second.nextCursor});
    assert.equal(third.items[0].id,'search-attachment-1');assert.equal(third.nextCursor,null);
    assert.equal('storage_key' in first.items[0],false);
    assert.equal(f.service.search(f.context,{conversationId:'hidden-conversation'}).items.length,0);
    assert.equal(f.service.search(context(f.actors.removedMember.id),{}).items.length,0);
    for(const query of [{name:'secret.txt'},{content:'secret'},{mediaType:'image'},{maxBytes:'1',minBytes:'2'},{limit:'51'}]){
        assert.equal(outcome(()=>f.service.search(f.context,query))?.code,'VALIDATION_ERROR');
    }
    assert.deepEqual(outcome(()=>f.service.search(f.context,{typo:'x'})),{code:'VALIDATION_ERROR',status:400,fields:['typo']});
    assert.equal(outcome(()=>f.service.search(context(f.actors.member.id),{limit:'1',cursor:first.nextCursor}))?.code,'VALIDATION_ERROR');
    assert.equal(outcome(()=>f.service.search(f.context,{minBytes:'2',cursor:first.nextCursor}))?.code,'VALIDATION_ERROR');
    assert.equal(f.service.search(f.context,{limit:'2',cursor:first.nextCursor}).items.length,2);
    assert.equal(outcome(()=>f.service.search(f.context,{cursor:'not-a-cursor!'}))?.code,'VALIDATION_ERROR');
    const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT a.* FROM Attachments AS a INDEXED BY idx_attachments_search WHERE a.status='ready' AND a.rowid<=? ORDER BY a.created_at DESC,a.attachment_id DESC LIMIT ?").all(100,50);
    assert.match(plan.map(row=>row.detail).join(' '),/idx_attachments_search/);
});












