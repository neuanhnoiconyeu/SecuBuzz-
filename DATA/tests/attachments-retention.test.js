'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const http = require('node:http');
const { groupFixture } = require('./support/groups');
const { storageRoot, frame } = require('./support/attachments');
const { httpGroupFixture } = require('./support/groups');
const { createAttachmentRepository } = require('../server/database/attachmentRepository');
const { createFilesystemProvider } = require('../server/attachments/storage/filesystem');
const { createRetentionJob } = require('../server/attachments/retention');
const { startServer } = require('../server/start');
const { envDefaults } = require('./support/auth');
const { FRAME_CONTENT_TYPE } = require('../server/attachments/frame');

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const SETTINGS = Object.freeze({ pendingTtlSeconds:86400, purgeDelaySeconds:86400, retentionIntervalSeconds:3600 });
const HASH = 'a'.repeat(64);
const iso = ms => new Date(ms).toISOString();

function setup(t, { clock = null, storageOverride = null, repositoryOverride = null, settings = SETTINGS } = {}) {
    const f = groupFixture(t);
    const root = storageRoot(t);
    const baseStorage = createFilesystemProvider({ root, repositoryRoot:path.resolve(__dirname,'../..') });
    const storage = storageOverride ? storageOverride(baseStorage) : baseStorage;
    const baseRepository = createAttachmentRepository(f.db);
    const repository = repositoryOverride ? repositoryOverride(baseRepository) : baseRepository;
    const current = clock || { value:BASE };
    const job = createRetentionJob({ db:f.db, repository, storage, now:() => new Date(current.value), settings, logger:line => f.logs.push(line) });
    f.logs = [];
    t.after(() => job.stop());
    return { ...f, root, storage:baseStorage, job, repository, current };
}

function keyFor(id) { return createHash('sha256').update(id).digest('hex').slice(0,48); }
function addPending(f, id, expiresAt, { byteSize=4 } = {}) {
    return f.db.transaction(() => f.repository.insertPending({ attachment_id:id, conversation_id:f.groupId,
        uploaded_by:f.actors.owner.id, storage_key:keyFor(id), encrypted_metadata:'opaque-ciphertext', byte_size:byteSize,
        expires_at:expiresAt, integrity_digest:HASH, declared_algorithm:'X25519-AESGCM', declared_format_version:'v1' })).immediate();
}
function addReady(f, id) {
    addPending(f,id,iso(f.current.value+86400000));
    const messageId=`message-${id}`;
    f.repositories.messages.insertAuthenticated({ message_id:messageId, conversation_id:f.groupId, sender_id:f.actors.owner.id,
        receiver_id:null, ciphertext:'opaque', iv:'opaque-iv', envelope_version:1, encoding:'base64', sender_name:'Fixture owner',
        client_timestamp:iso(f.current.value), message_type:'text', fingerprint:keyFor(id).padEnd(64,'a').slice(0,64),
        client_id:`client-${messageId}`, message_seq:f.db.prepare('SELECT coalesce(max(message_seq),0)+1 AS n FROM Messages WHERE conversation_id=?').get(f.groupId).n,
        created_at:iso(f.current.value) });
    f.db.transaction(() => f.repository.associate([id],messageId,iso(f.current.value))).immediate();
}
function markDeleted(f, id, deletedAt, purged=false) {
    f.db.transaction(() => f.repository.markDeleted(id,deletedAt)).immediate();
    if (purged) f.db.transaction(() => f.repository.markPurged(id)).immediate();
}
async function store(f, id, bytes=Buffer.from('synthetic')) {
    await f.storage.write(keyFor(id),Readable.from([bytes]),{maxBytes:bytes.length});
}
function row(f,id) { return f.repository.getById(id); }

test('T-6B-37 expires pending rows transactionally, purges eligible tombstones, releases reservations and is bounded', async t => {
    const f=setup(t);
    addPending(f,'expired-equal',iso(BASE)); await store(f,'expired-equal');
    addPending(f,'pending-live',iso(BASE+1)); await store(f,'pending-live');
    addReady(f,'ready-never-purge'); await store(f,'ready-never-purge');
    addPending(f,'old-deleted',iso(BASE+86400000)); markDeleted(f,'old-deleted',iso(BASE-86400001)); await store(f,'old-deleted');
    addPending(f,'young-deleted',iso(BASE+86400000)); markDeleted(f,'young-deleted',iso(BASE-1)); await store(f,'young-deleted');
    const reservation = { reservation_id:'expired-reservation',user_id:f.actors.owner.id,conversation_id:f.groupId,
        declared_bytes:4,source_digest:HASH,created_at:iso(BASE-1000),expires_at:iso(BASE) };
    const futureReservation={...reservation,reservation_id:'future-reservation',expires_at:iso(BASE+1)};
    f.db.transaction(()=>{f.repository.insertReservation(reservation);f.repository.insertReservation(futureReservation);}).immediate();

    const result=await f.job.runOnce();
    assert.deepEqual(result,{expired:1,purged:1,reservations:1,failures:0});
    assert.equal(row(f,'expired-equal').status,'deleted');
    assert.equal(row(f,'expired-equal').deleted_at,iso(BASE));
    assert.equal(row(f,'expired-equal').purge_state,'purged');
    assert.equal(await f.storage.stat(keyFor('expired-equal')),null);
    assert.equal(row(f,'pending-live').status,'pending');
    assert.equal(await f.storage.stat(keyFor('pending-live')),9);
    assert.equal(row(f,'ready-never-purge').status,'ready');
    assert.equal(row(f,'ready-never-purge').purge_state,'not_purged');
    assert.notEqual(await f.storage.stat(keyFor('ready-never-purge')),null);
    assert.equal(row(f,'old-deleted').purge_state,'purged');
    assert.equal(await f.storage.stat(keyFor('old-deleted')),null);
    assert.equal(row(f,'young-deleted').purge_state,'not_purged');
    assert.notEqual(await f.storage.stat(keyFor('young-deleted')),null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations WHERE reservation_id=?').get('expired-reservation').n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations WHERE reservation_id=?').get('future-reservation').n,1);
    const events=f.db.prepare("SELECT event_type,actor_user_id,source,subject_id,metadata_json FROM AuditLogs WHERE subject_id IN ('expired-equal','old-deleted') ORDER BY event_type,subject_id").all();
    assert.deepEqual(events.map(event=>[event.event_type,event.actor_user_id,event.source,event.subject_id]),[
        ['attachment.expired',null,'attachments','expired-equal'],['attachment.purged',null,'attachments','expired-equal'],
        ['attachment.purged',null,'attachments','old-deleted']
    ]);
    assert.ok(events.every(event=>JSON.parse(event.metadata_json).target_id===f.groupId));
    assert.deepEqual(await f.job.runOnce(),{expired:0,purged:0,reservations:0,failures:0});
});

test('T-6B-37 processes only one bounded batch from each queue per run', async t => {
    const f=setup(t);
    for(let index=0;index<101;index++)addPending(f,`bounded-${index}`,iso(BASE));
    const first=await f.job.runOnce();
    assert.equal(first.expired,100);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM Attachments WHERE status='pending'").get().n,1);
    const second=await f.job.runOnce();
    assert.equal(second.expired,1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM Attachments WHERE status='pending'").get().n,0);
});

test('T-6B-37 rolls back the expiry state and audit together when audit insertion fails', async t => {
    const f=setup(t);
    addPending(f,'audit-failure',iso(BASE)); await store(f,'audit-failure');
    f.db.exec("CREATE TRIGGER test_retention_audit_failure BEFORE INSERT ON AuditLogs WHEN NEW.event_type='attachment.expired' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
    const result=await f.job.runOnce();
    assert.equal(result.failures,1);
    assert.equal(row(f,'audit-failure').status,'pending');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE subject_id='audit-failure'").get().n,0);
    assert.notEqual(await f.storage.stat(keyFor('audit-failure')),null);
});

test('T-6B-37 leaves failed storage purges retryable and continues other rows', async t => {
    const failing=new Set();
    const f=setup(t,{storageOverride:base=>({...base,async delete(key){if(failing.has(key))throw new Error('synthetic storage failure');return base.delete(key);}})});
    for(const id of ['retry-a','retry-b','works']){
        addPending(f,id,iso(BASE+86400000));markDeleted(f,id,iso(BASE-86400001));await store(f,id);
    }
    failing.add(keyFor('retry-a'));failing.add(keyFor('retry-b'));
    const first=await f.job.runOnce();
    assert.equal(first.purged,1);assert.equal(first.failures,2);
    for(const id of ['retry-a','retry-b']){assert.equal(row(f,id).purge_state,'not_purged');assert.notEqual(await f.storage.stat(keyFor(id)),null);}
    assert.equal(row(f,'works').purge_state,'purged');assert.equal(await f.storage.stat(keyFor('works')),null);
    failing.clear();
    const second=await f.job.runOnce();
    assert.equal(second.purged,2);assert.equal(second.failures,0);
    assert.equal(row(f,'retry-a').purge_state,'purged');assert.equal(row(f,'retry-b').purge_state,'purged');
});

test('T-6B-37 startup sweep removes stale part files and reports only orphan counts without deleting final orphan bytes', async t => {
    const f=setup(t);
    addPending(f,'record-without-bytes',iso(BASE+86400000));
    const orphanKey=keyFor('file-without-record');await f.storage.write(orphanKey,Readable.from([Buffer.from('x')]),{maxBytes:1});
    const oldPart=path.join(f.root,'old-upload.part');const youngPart=path.join(f.root,'young-upload.part');
    fs.writeFileSync(oldPart,'old');fs.writeFileSync(youngPart,'young');
    const stale=Date.now()-SETTINGS.pendingTtlSeconds*1000-1000;fs.utimesSync(oldPart,stale/1000,stale/1000);
    await f.job.start();
    assert.equal(fs.existsSync(oldPart),false);assert.equal(fs.existsSync(youngPart),true);
    assert.notEqual(await f.storage.stat(orphanKey),null);
    assert.deepEqual(f.logs.filter(line=>line.includes('startup records_without_bytes')||line.includes('startup bytes_without_records')),[
        'attachment retention startup records_without_bytes=1','attachment retention startup bytes_without_records=1'
    ]);
    await f.job.stop();
});

test('P-38: 100 deterministic generated retention states preserve status, bytes, reservation and idempotency invariants', async t => {
    let seed=0x6b38cafe;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
    const choose=max=>random()%max;
    const failing=new Set();
    const f=setup(t,{storageOverride:base=>({...base,async delete(key){if(failing.has(key))throw new Error('synthetic storage failure');return base.delete(key);}})});
    let messages=0;const coverage={pendingExpired:0,pendingLive:0,ready:0,deleted:0,failedWithBytes:0,failedWithoutBytes:0,
        failureCounts:new Set(),stateSizes:new Set()};
    for(let run=0;run<100;run++){
        const caseSeed=seed;const desiredFailures=run%4;const count=run===0?0:run===1?20:Math.max(choose(21),desiredFailures);const own=[];const failureIds=[];
        coverage.failureCounts.add(desiredFailures);coverage.stateSizes.add(count);
        const now=f.current.value;
        for(let index=0;index<count;index++){
            const id=`p38-${run}-${index}`;const forcedFailure=index<desiredFailures;
            const status=forcedFailure?'deleted':index%4===0||index%4===3?'pending':index%4===1?'ready':'deleted';
            const pendingOrdinal=Math.floor(index/4);
            const expiry=iso(now+(pendingOrdinal%3-1));
            if(status==='ready'){
                addReady(f,id);messages++;coverage.ready++;
            }else addPending(f,id,expiry);
            const shouldHaveBytes=choose(5)!==0;
            if(shouldHaveBytes)await store(f,id,Buffer.from(`bytes-${id}`));
            if(status==='deleted'){
                coverage.deleted++;
                const eligible=forcedFailure||choose(2)===0;
                const purged=!forcedFailure&&choose(2)===0;
                markDeleted(f,id,iso(eligible?now-86400001:now-1),purged);
                if(purged&&shouldHaveBytes)await f.storage.delete(keyFor(id));
                if(forcedFailure){failureIds.push(id);if(shouldHaveBytes)coverage.failedWithBytes++;else coverage.failedWithoutBytes++;}
            }
            if(status==='pending'&&Date.parse(expiry)<=now)coverage.pendingExpired++;
            if(status==='pending'&&Date.parse(expiry)>now)coverage.pendingLive++;
            own.push({id,status,expiry,shouldHaveBytes});
        }
        const expiredReservation=`p38-r-expired-${run}`;const liveReservation=`p38-r-live-${run}`;
        const reserve=(id,expiry)=>f.repository.insertReservation({reservation_id:id,user_id:f.actors.owner.id,conversation_id:f.groupId,
            declared_bytes:1,source_digest:HASH,created_at:iso(now-1),expires_at:expiry});
        f.db.transaction(()=>{reserve(expiredReservation,iso(now));reserve(liveReservation,iso(now+1));}).immediate();
        const oldName=`p38-${run}-old.part`;const youngName=`p38-${run}-young.part`;
        const oldPath=path.join(f.root,oldName);const youngPath=path.join(f.root,youngName);
        fs.writeFileSync(oldPath,'stale');fs.writeFileSync(youngPath,'fresh');
        const stale=Date.now()-SETTINGS.pendingTtlSeconds*1000-1000;fs.utimesSync(oldPath,stale/1000,stale/1000);
        for(const id of failureIds)failing.add(keyFor(id));
        const first=await f.job.runOnce();
        for(const item of own){
            const stored=row(f,item.id);
            if(item.status==='ready'){
                assert.equal(stored.status,'ready',`seed=${caseSeed} run=${run} id=${item.id}`);
                assert.equal(await f.storage.stat(keyFor(item.id))!==null,item.shouldHaveBytes);
            }else if(item.status==='pending'&&Date.parse(item.expiry)<=now){
                assert.equal(stored.status,'deleted',`seed=${caseSeed} run=${run} id=${item.id}`);
                assert.equal(stored.deleted_at,iso(now));
                assert.equal(stored.purge_state,'purged');
                assert.equal(await f.storage.stat(keyFor(item.id)),null);
            }else if(item.status==='pending'){
                assert.equal(stored.status,'pending',`seed=${caseSeed} run=${run} id=${item.id}`);
                assert.equal(stored.expires_at,item.expiry);
            }else if(stored.purge_state==='purged'){
                assert.equal(await f.storage.stat(keyFor(item.id)),null);
            }else if(failureIds.includes(item.id)){
                assert.equal(stored.purge_state,'not_purged');
                assert.equal(await f.storage.stat(keyFor(item.id))!==null,item.shouldHaveBytes);
            }
        }
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations WHERE reservation_id=?').get(expiredReservation).n,0);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations WHERE reservation_id=?').get(liveReservation).n,1);
        assert.equal(fs.existsSync(oldPath),false);assert.equal(fs.existsSync(youngPath),true);
        assert.ok(first.failures<=failureIds.length+1,`seed=${caseSeed} run=${run} unexpected failures=${first.failures}`);
        const beforeSecond={attachments:f.db.prepare('SELECT * FROM Attachments ORDER BY attachment_id').all(),
            reservations:f.db.prepare('SELECT * FROM AttachmentReservations ORDER BY reservation_id').all(),
            audit:f.db.prepare('SELECT * FROM AuditLogs ORDER BY audit_id').all(),files:(await f.storage.listKeys()).sort(),
            parts:fs.readdirSync(f.root).filter(name=>name.endsWith('.part')).sort()};
        const second=await f.job.runOnce();
        assert.equal(second.expired,0,`seed=${caseSeed} run=${run} second expiry`);
        assert.equal(second.reservations,0,`seed=${caseSeed} run=${run} second reservation cleanup`);
        assert.deepEqual({attachments:f.db.prepare('SELECT * FROM Attachments ORDER BY attachment_id').all(),
            reservations:f.db.prepare('SELECT * FROM AttachmentReservations ORDER BY reservation_id').all(),
            audit:f.db.prepare('SELECT * FROM AuditLogs ORDER BY audit_id').all(),files:(await f.storage.listKeys()).sort(),
            parts:fs.readdirSync(f.root).filter(name=>name.endsWith('.part')).sort()},beforeSecond,`seed=${caseSeed} run=${run} idempotence`);
        for(const id of failureIds)failing.delete(keyFor(id));
        if(failureIds.length){
            const retry=await f.job.runOnce();
            for(const id of failureIds){assert.equal(row(f,id).purge_state,'purged');assert.equal(await f.storage.stat(keyFor(id)),null);}
            assert.equal(retry.failures,0,`seed=${caseSeed} run=${run} retry`);
        }
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages WHERE conversation_id=?').get(f.groupId).n,messages);
    }
    assert.ok(coverage.pendingExpired>0&&coverage.pendingLive>0&&coverage.ready>0&&coverage.deleted>0);
    assert.ok(coverage.failedWithBytes>0&&coverage.failedWithoutBytes>0);
    assert.deepEqual([...coverage.failureCounts].sort(),[0,1,2,3]);
    assert.ok(coverage.stateSizes.has(0)&&coverage.stateSizes.has(20));
});

test('T-6B-38 disabled startup creates no storage root or retention timer; enabled startup applies the upload timeout and close drains a row', async t => {
    const f=groupFixture(t);const directory=f.directory;
    const disabledRoot=path.join(directory,'must-not-be-created');
    const disabled=await startServer({db:f.db,config:require('../server/auth/config').loadAuthConfig(envDefaults),
        env:{...envDefaults,PORT:'0',ATTACHMENTS_API_ENABLED:'false',ATTACHMENT_STORAGE_DIR:disabledRoot,ATTACHMENT_UPLOAD_TIMEOUT_SECONDS:'120'},log:()=>{}});
    assert.equal(disabled.features.attachmentApi,false);assert.equal(disabled.retentionJob,null);assert.equal(disabled.server.requestTimeout,15000);
    assert.equal(fs.existsSync(disabledRoot),false);
    await disabled.close();

    const unsetTimeoutRoot=storageRoot(t);
    const unsetTimeoutFeatures={groupApi:false,groupMessaging:false,attachmentApi:true,groups:{},attachments:{...SETTINGS,
        quotaUserBytes:1073741824,quotaConversationBytes:5368709120,maxPendingPerUser:10,uploadsPerHour:30,
        maxConcurrentUploadsPerUser:2,maxConcurrentUploadsPerSource:5,storageDir:unsetTimeoutRoot}};
    const unsetTimeout=await startServer({db:f.db,config:require('../server/auth/config').loadAuthConfig(envDefaults),
        env:{...envDefaults,PORT:'0'},features:unsetTimeoutFeatures,log:()=>{}});
    assert.equal(unsetTimeout.server.requestTimeout,15000);
    await unsetTimeout.close();

    const root=storageRoot(t);const storage=createFilesystemProvider({root,repositoryRoot:path.resolve(__dirname,'../..')});
    let finishDelete;let deletionStarted;const deleting=new Promise(resolve=>{deletionStarted=resolve;});
    const delayed={...storage,async delete(key){deletionStarted();await new Promise(resolve=>{finishDelete=resolve;});return storage.delete(key);}};
    const env={...envDefaults,PORT:'0',ATTACHMENTS_API_ENABLED:'true',ATTACHMENT_STORAGE_DIR:root,
        ATTACHMENT_PENDING_TTL_SECONDS:'86400',ATTACHMENT_PURGE_DELAY_SECONDS:'86400',ATTACHMENT_RETENTION_INTERVAL_SECONDS:'3600',
        ATTACHMENT_QUOTA_USER_BYTES:'1073741824',ATTACHMENT_QUOTA_CONVERSATION_BYTES:'5368709120',ATTACHMENT_MAX_PENDING_PER_USER:'10',
        ATTACHMENT_UPLOADS_PER_HOUR:'30',ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER:'2',ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE:'5',
        ATTACHMENT_UPLOAD_TIMEOUT_SECONDS:'120'};
    const running=await startServer({db:f.db,config:require('../server/auth/config').loadAuthConfig(env),env,storage:delayed,log:()=>{}});
    t.after(()=>running.server.listening?running.close():undefined);
    assert.equal(running.features.attachmentApi,true);assert.equal(running.server.requestTimeout,120000);
    addPending({...f,repository:createAttachmentRepository(f.db)},'close-in-flight',iso(BASE));await store({storage},'close-in-flight');
    const operation=running.retentionJob.runOnce();await deleting;
    let closed=false;const closing=running.close().then(()=>{closed=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
    finishDelete();await Promise.all([operation,closing]);
    assert.equal(row({...f,repository:createAttachmentRepository(f.db)},'close-in-flight').purge_state,'purged');
    assert.equal(await storage.stat(keyFor('close-in-flight')),null);
    assert.equal(running.db.open,true); // injected database remains caller-owned
});

test('T-6B-38 missing required retention configuration exits before opening or migrating a database', t => {
    const directory=require('./support/groups').temporaryDirectory(t);
    const database=path.join(directory,'must-not-open.sqlite');const marker='secret-retention-value';
    const env={...process.env,...envDefaults,PORT:'0',DB_PATH:database,ATTACHMENTS_API_ENABLED:'true',ATTACHMENT_STORAGE_DIR:path.join(directory,marker),
        ATTACHMENT_PENDING_TTL_SECONDS:'86400',ATTACHMENT_PURGE_DELAY_SECONDS:'86400',ATTACHMENT_RETENTION_INTERVAL_SECONDS:undefined,
        ATTACHMENT_QUOTA_USER_BYTES:'1073741824',ATTACHMENT_QUOTA_CONVERSATION_BYTES:'5368709120',ATTACHMENT_MAX_PENDING_PER_USER:'10',
        ATTACHMENT_UPLOADS_PER_HOUR:'30',ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER:'2',ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE:'5',
        ATTACHMENT_UPLOAD_TIMEOUT_SECONDS:undefined};
    delete env.ATTACHMENT_RETENTION_INTERVAL_SECONDS;
    delete env.ATTACHMENT_UPLOAD_TIMEOUT_SECONDS;
    const result=require('node:child_process').spawnSync(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env,encoding:'utf8',timeout:10000});
    assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,/ATTACHMENT_RETENTION_INTERVAL_SECONDS/);
    assert.equal(result.stderr.includes(marker),false);
    assert.equal(fs.existsSync(database),false);
});

test('T-6B-38 request timeout abort cleans the partial upload file and reservation', async t => {
    const root=storageRoot(t);const settings={pendingTtlSeconds:86400,purgeDelaySeconds:86400,retentionIntervalSeconds:3600,
        quotaUserBytes:1073741824,quotaConversationBytes:5368709120,maxPendingPerUser:10,uploadsPerHour:30,
        maxConcurrentUploadsPerUser:2,maxConcurrentUploadsPerSource:5,uploadTimeoutSeconds:1};
    const features={groupApi:false,groupMessaging:false,attachmentApi:true,groups:{},attachments:{...settings,storageDir:root}};
    const storage=createFilesystemProvider({root,repositoryRoot:path.resolve(__dirname,'../..')});
    const f=await httpGroupFixture(t,{features,storage,log:()=>{}});
    assert.equal(f.application.server.requestTimeout,1000);
    const owner=f.actors.owner;const content=Buffer.alloc(64,0x41);
    const body=frame({conversationId:f.groupId,byteSize:content.length,encryptedMetadata:'opaque',algorithm:'X25519-AESGCM',formatVersion:'v1'},content);
    const cookie=[...owner.browser.cookies].map(([name,value])=>`${name}=${value}`).join('; ');
    const response=new Promise((resolve,reject)=>{
        const request=http.request({host:'127.0.0.1',port:f.application.server.address().port,path:'/api/attachments/',method:'POST',headers:{
            Origin:owner.browser.sourceOrigin,Cookie:cookie,'X-CSRF-Token':owner.token,'Content-Type':FRAME_CONTENT_TYPE,'Content-Length':body.length
        }},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
        request.once('error',error=>{if(['ECONNRESET','ERR_STREAM_PREMATURE_CLOSE'].includes(error.code))resolve(null);else reject(error);});
        request.write(body.subarray(0,body.length-16));
    });
    for(let spin=0;f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations').get().n===0&&spin<1000;spin++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations').get().n,1,'upload entered streaming after committing its reservation');
    let deadline;const timeoutFailure=new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('request timeout did not close the partial upload')),5000);});
    const status=await Promise.race([response,timeoutFailure]);clearTimeout(deadline);
    assert.ok(status===null||status===408,`expected a timed-out connection or 408, received ${status}`);
    for(let spin=0;f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations').get().n!==0&&spin<1000;spin++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM AttachmentReservations').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Attachments').get().n,0);
    assert.equal((await storage.listKeys()).length,0);
    assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.part')),false);
});

test('T-6B-37/38 chained timer does not overlap, is unreferenced, reschedules after failure and stop waits for the current row only', async t => {
    let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});let release;
    const blockedKey=keyFor('timer-first');
    let failList=true;let active=0;let maxActive=0;
    const f=setup(t,{storageOverride:base=>({...base,async delete(key){if(key===blockedKey){enteredResolve();await new Promise(resolve=>{release=resolve;});}return base.delete(key);}}),
        repositoryOverride:base=>({...base,listExpiredPending(...args){active++;maxActive=Math.max(active,maxActive);if(failList){failList=false;active--;throw new Error('synthetic query failure');}active--;return base.listExpiredPending(...args);}})});
    addPending(f,'timer-first',iso(BASE));addPending(f,'timer-second',iso(BASE));await store(f,'timer-first');await store(f,'timer-second');
    const originalSet=global.setTimeout;const originalClear=global.clearTimeout;const handles=[];
    global.setTimeout=(callback,delay)=>{const handle={callback:()=>{handle.fired=true;callback();},delay,cleared:false,fired:false,unrefCalled:false,unref(){this.unrefCalled=true;return this;}};handles.push(handle);return handle;};
    global.clearTimeout=handle=>{if(handle)handle.cleared=true;};
    try{
        await f.job.start();assert.equal(handles.length,1);assert.equal(handles[0].delay,3600000);assert.equal(handles[0].unrefCalled,true);
        handles[0].callback();
        for(let spin=0;handles.length<2&&spin<20;spin++)await new Promise(resolve=>setImmediate(resolve));
        assert.equal(handles.length,2,'a failed run reschedules in its finally path');
        handles[1].callback();await entered;
        assert.equal(handles.length,2,'no timer is scheduled while a run is active');
        const secondCall=f.job.runOnce();
        let stopped=false;const stop=f.job.stop().then(()=>{stopped=true;});
        await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
        release();await Promise.all([secondCall,stop]);
        assert.equal(maxActive,1);
        assert.equal(handles.length,2,'stop prevents the completed run from scheduling another timer');
        assert.equal(row(f,'timer-first').purge_state,'purged');assert.equal(row(f,'timer-second').status,'pending');
        assert.equal(handles.some(handle=>!handle.fired&&!handle.cleared),false,'stop leaves no active timer');
    }finally{global.setTimeout=originalSet;global.clearTimeout=originalClear;}
});

