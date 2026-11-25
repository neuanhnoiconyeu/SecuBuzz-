'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const http = require('node:http');
const { createFilesystemProvider } = require('../server/attachments/storage/filesystem');
const { FRAME_CONTENT_TYPE } = require('../server/attachments/frame');
const { httpGroupFixture, assertSecurityHeaders } = require('./support/groups');
const { storageRoot, frame, upload, snapshotStorage } = require('./support/attachments');

const SETTINGS = Object.freeze({
    pendingTtlSeconds:86400, purgeDelaySeconds:86400, retentionIntervalSeconds:3600,
    quotaUserBytes:1073741824, quotaConversationBytes:5368709120, maxPendingPerUser:10,
    uploadsPerHour:30, maxConcurrentUploadsPerUser:2, maxConcurrentUploadsPerSource:5, uploadTimeoutSeconds:120,
});
function observeServerFinish(server, requestPath, timeoutMs=2000) {
    const started=performance.now();
    return new Promise(resolve => {
        let timer,settled=false,requestObserved=false,responseObserved=null;
        const snapshot=event=>Object.freeze({
            event,requestObserved,requestUrlMatches:requestObserved,responseObserved:!!responseObserved,
            elapsedMs:Number((performance.now()-started).toFixed(3)),
            ...(responseObserved?{writableFinished:responseObserved.writableFinished,
                writableEnded:responseObserved.writableEnded,destroyed:responseObserved.destroyed,
                headersSent:responseObserved.headersSent}:{}),
        });
        const finish=event=>{
            if(settled)return;
            settled=true;clearTimeout(timer);server.removeListener('request',observe);
            if(responseObserved){responseObserved.removeListener('finish',onFinish);responseObserved.removeListener('close',onClose);}
            resolve(snapshot(event));
        };
        const onFinish=()=>finish('finish');
        const onClose=()=>finish('close');
        const observe=(request,response)=>{
            if(request.url!==requestPath)return;
            requestObserved=true;responseObserved=response;
            response.once('finish',onFinish);response.once('close',onClose);
        };
        timer=setTimeout(()=>finish('timeout'),timeoutMs);
        server.prependListener('request',observe);
    });
}
async function waitForAuditChange(db, previousCount, timeoutMs=2000) {
    const deadline=performance.now()+timeoutMs;
    let count;
    do {
        count=db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='attachment.downloaded'").get().n;
        if(count!==previousCount||performance.now()>=deadline)return count;
        await new Promise(resolve=>setImmediate(resolve));
    } while(true);
}
function features(root, enabled=true) {
    return Object.freeze({groupApi:false,groupMessaging:false,attachmentApi:enabled,groups:Object.freeze({}),
        attachments:Object.freeze({...SETTINGS,storageDir:root})});
}
async function fixture(t, { enabled=true, slowRead=false, failRead=false }={}) {
    const root=storageRoot(t);
    const base=createFilesystemProvider({root,repositoryRoot:path.resolve(__dirname,'../..')});
    let readTerminated=Promise.resolve();
    const storage=(slowRead||failRead)?Object.assign({},base,{read:async key=>{
        const saved=await base.read(key);let finish;readTerminated=new Promise(resolve=>{finish=resolve;});
        async function* chunks(){try{for await(const item of saved.stream){
            if(failRead){yield item.subarray(0,Math.max(1,Math.floor(item.length/2)));throw new Error('synthetic stream failure');}
            for(let offset=0;offset<item.length;offset+=4096){yield item.subarray(offset,offset+4096);await new Promise(resolve=>setTimeout(resolve,10));}
        }}finally{finish();}}
        return {stream:Readable.from(chunks()),byteCount:saved.byteCount};
    }}):base;
    const limiter={calls:[],consume(buckets,now){this.calls.push({buckets,now});return {allowed:true};}};
    const f=await httpGroupFixture(t,{features:features(root,enabled),storage,limiter});
    // Own the download sockets for this fixture. Node 24's shared fetch Agent can
    // close a replacement origin dispatcher from a stale disconnect callback.
    // Core HTTP provides real streaming and aborts without that global ownership map.
    const downloadAgent=new http.Agent();
    t.after(()=>downloadAgent.destroy());
    const download=(url,options={})=>new Promise((resolve,reject)=>{
        const outgoing=http.get(url,{...options,agent:downloadAgent},incoming=>{
            const responseHeaders=new Headers();
            for(let i=0;i<incoming.rawHeaders.length;i+=2)responseHeaders.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
            resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode,headers:responseHeaders}));
        });
        outgoing.once('error',reject);
    });
    return {...f,root,storage,limiter,download,readTerminated:()=>readTerminated};
}
const header=(conversationId,byteSize,extra={})=>({
    conversationId,byteSize,encryptedMetadata:'opaque-encrypted-metadata',
    algorithm:'X25519-AESGCM',formatVersion:'v1',...extra,
});
function request(actor, method, url, {body,rawBody,headers={}}={}) {
    return actor.browser.request(url,{method,body,rawBody,headers:{
        ...(method==='GET'||method==='HEAD'?{}:{'X-CSRF-Token':actor.token}),...headers,
    }});
}
function dbCounts(db) {
    return {
        attachments:db.prepare('SELECT count(*) AS n FROM Attachments').get().n,
        reservations:db.prepare('SELECT count(*) AS n FROM AttachmentReservations').get().n,
        audit:db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE source='attachments'").get().n,
    };
}
function assertError(response,status,code,fields=[]) {
    assert.equal(response.status,status);
    assert.deepEqual(response.body,{code,fields});
}
function insertMessage(f,id='http-committed-message',{conversationId=f.groupId,sender=f.actors.owner.id}={}) {
    const at='2026-01-01T00:00:00.000Z';
    return f.repositories.messages.insertAuthenticated({
        message_id:id,conversation_id:conversationId,sender_id:sender,receiver_id:null,
        ciphertext:'synthetic-ciphertext',iv:'synthetic-iv',envelope_version:1,encoding:'base64',
        sender_name:'Synthetic Owner',client_timestamp:at,message_type:'text',fingerprint:'a'.repeat(64),
        client_id:'client-'+id,message_seq:1,created_at:at,
    });
}
function rawActorRequest(actor,url,method,rawBody,headers={}) {
    return actor.browser.request(url,{method,rawBody,headers:{'X-CSRF-Token':actor.token,...headers}});
}

test('canonical attachment API is not mounted while disabled and leaves main encrypted attachments authoritative',async t=>{
    const f=await fixture(t,{enabled:false}),owner=f.actors.owner;
    assert.equal(f.application.canonicalAttachments,null,'the canonical DB-6B service stays unset when disabled');
    assert.equal(f.application.features.attachmentApi,false,'the canonical switch is off');
    assert.ok(f.application.encryptedAttachments,'main encrypted attachments remain mounted');
    const before=f.limiter.calls.length;
    assertError(await request(owner,'GET','/api/files/search'),404,'NOT_FOUND');
    assert.equal(f.limiter.calls.length,before,'disabled canonical requests do not write limiter buckets');
});

test('A01 streams a framed upload and A03/A05 preserve uploader-only pending access and deletion',async t=>{
    const f=await fixture(t),owner=f.actors.owner,member=f.actors.member,bytes=Buffer.from('opaque ciphertext');
    const response=await upload(owner.browser,header(f.groupId,bytes.length),bytes,owner.token);
    assert.equal(response.status,201);assert.equal(response.body.attachment.status,'pending');
    assert.equal(response.body.attachment.byteSize,bytes.length);
    assert.equal(response.body.attachment.integrityDigest,createHash('sha256').update(bytes).digest('hex'));
    assert.equal('storageKey' in response.body.attachment,false);
    assertSecurityHeaders(response);
    const id=response.body.attachment.id;
    const metadata=await request(owner,'GET','/api/attachments/'+id);
    assert.equal(metadata.status,200);assert.deepEqual(metadata.body,{attachment:response.body.attachment});
    assertSecurityHeaders(metadata);
    const hidden=await request(member,'GET','/api/attachments/'+id);
    assertError(hidden,404,'NOT_FOUND');assertSecurityHeaders(hidden);
    const deniedDelete=await request(member,'DELETE','/api/attachments/'+id);
    assertError(deniedDelete,404,'NOT_FOUND');
    const deleted=await request(owner,'DELETE','/api/attachments/'+id);
    assert.equal(deleted.status,204);assert.equal(deleted.text,'');assertSecurityHeaders(deleted);
    assertError(await request(owner,'DELETE','/api/attachments/'+id),404,'NOT_FOUND');
    for(const item of [response.body,metadata.body,hidden.body,deniedDelete.body,deleted.body]) {
        assert.doesNotMatch(JSON.stringify(item),/storage_key|storageKey/i);
    }
    assert.deepEqual(dbCounts(f.db),{attachments:1,reservations:0,audit:2});
    assert.deepEqual(snapshotStorage(f.root),[]);
});

test('A01 rejects malformed, oversize and size-mismatched frames without rows, reservations or files',async t=>{
    const f=await fixture(t),owner=f.actors.owner,base=header(f.groupId,4),oversize=header(f.groupId,50*1024*1024+1);
    const cases=[
        {name:'oversize declaration',raw:frame(oversize,Buffer.alloc(0)),status:413,code:'PAYLOAD_TOO_LARGE'},
        {name:'Content-Length differs from declared byteSize',raw:frame(base,Buffer.from('abc')),status:400,code:'VALIDATION_ERROR'},
        {name:'missing byteSize declaration',raw:frame({conversationId:f.groupId,encryptedMetadata:'opaque',algorithm:'X',formatVersion:'v1'},Buffer.alloc(0)),status:400,code:'VALIDATION_ERROR',fields:['byteSize']},
        {name:'missing algorithm declaration',raw:frame({conversationId:f.groupId,byteSize:4,encryptedMetadata:'opaque',formatVersion:'v1'},Buffer.alloc(0)),status:400,code:'VALIDATION_ERROR',fields:['algorithm']},
        {name:'missing format declaration',raw:frame({conversationId:f.groupId,byteSize:4,encryptedMetadata:'opaque',algorithm:'X'},Buffer.alloc(0)),status:400,code:'VALIDATION_ERROR',fields:['formatVersion']},
        {name:'frame cut during header',raw:Buffer.from([0,0,0,20,123,125]),status:400,code:'VALIDATION_ERROR'},
        {name:'missing encrypted metadata',raw:frame({conversationId:f.groupId,byteSize:4,algorithm:'X',formatVersion:'v1'},Buffer.alloc(0)),status:400,code:'VALIDATION_ERROR',fields:['encryptedMetadata']},
        {name:'metadata over 16384 bytes',raw:frame(header(f.groupId,4,{encryptedMetadata:'x'.repeat(16385)}),Buffer.alloc(0)),status:400,code:'VALIDATION_ERROR',fields:['encryptedMetadata']},
        {name:'truncated frame prefix',raw:Buffer.from([0,0]),status:400,code:'VALIDATION_ERROR'},
        {name:'wrong frame content type',raw:frame(base,Buffer.from('data')),contentType:'application/json',status:400,code:'VALIDATION_ERROR'},
    ];
    for(const item of cases){
        const response=await rawActorRequest(owner,'/api/attachments','POST',item.raw,{'Content-Type':item.contentType||FRAME_CONTENT_TYPE});
        assertError(response,item.status,item.code,item.fields||[]);assertSecurityHeaders(response);
        assert.deepEqual(dbCounts(f.db),{attachments:0,reservations:0,audit:0},item.name);
        assert.deepEqual(snapshotStorage(f.root),[],item.name);
    }
});

test('A01 applies archived-group and direct block/friend refusals before reserving or writing bytes',async t=>{
    const archived=await fixture(t),owner=archived.actors.owner,bytes=Buffer.from('data');
    archived.db.prepare('UPDATE Conversations SET archived_at=?,updated_at=? WHERE conversation_id=?')
        .run('2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z',archived.groupId);
    const archivedResponse=await upload(owner.browser,header(archived.groupId,bytes.length),bytes,owner.token);
    assertError(archivedResponse,409,'CONFLICT');
    assert.deepEqual(dbCounts(archived.db),{attachments:0,reservations:0,audit:0});
    assert.deepEqual(snapshotStorage(archived.root),[]);

    const direct=await fixture(t),a=direct.actors.owner.id,b=direct.actors.member.id,c=direct.actors.nonMember.id;
    const blocked=direct.repositories.conversations.createAuthenticatedDirect(a,b).conversation_id;
    direct.repositories.blocks.insert(b,a);
    const blockedResult=await upload(direct.actors.owner.browser,header(blocked,bytes.length),bytes,direct.actors.owner.token);
    assertError(blockedResult,404,'NOT_FOUND');
    const nonFriend=direct.repositories.conversations.createAuthenticatedDirect(a,c).conversation_id;
    const nonFriendResult=await upload(direct.actors.owner.browser,header(nonFriend,bytes.length),bytes,direct.actors.owner.token);
    assertError(nonFriendResult,403,'FORBIDDEN');
    const removedResult=await upload(direct.actors.removedMember.browser,header(direct.groupId,bytes.length),bytes,direct.actors.removedMember.token);
    assertError(removedResult,404,'NOT_FOUND');
    assert.deepEqual(dbCounts(direct.db),{attachments:0,reservations:0,audit:0});
    assert.deepEqual(snapshotStorage(direct.root),[]);
});

test('A02 validates each canonical HTTP refusal class and associates atomically',async t=>{
    const f=await fixture(t),owner=f.actors.owner,member=f.actors.member,bytes=Buffer.from('data'),url='/api/attachments/associations';
    const uploaded=await upload(owner.browser,header(f.groupId,bytes.length),bytes,owner.token);assert.equal(uploaded.status,201);
    const otherUpload=await upload(member.browser,header(f.groupId,bytes.length),bytes,member.token);assert.equal(otherUpload.status,201);
    const expiredUpload=await upload(owner.browser,header(f.groupId,bytes.length),bytes,owner.token);assert.equal(expiredUpload.status,201);
    const deletedUpload=await upload(owner.browser,header(f.groupId,bytes.length),bytes,owner.token);assert.equal(deletedUpload.status,201);
    insertMessage(f);
    const otherConversation=f.builder.createGroup({ownerId:owner.id,title:'Synthetic other group',idempotencyKey:'http-other-group'});
    insertMessage(f,'other-committed-message',{conversationId:otherConversation});
    const valid={conversationId:f.groupId,messageId:'http-committed-message',attachmentIds:[uploaded.body.attachment.id]};
    const unknown=await request(owner,'POST',url,{body:{...valid,extraField:true}});assertError(unknown,400,'VALIDATION_ERROR',['extraField']);
    const nonObject=await request(owner,'POST',url,{body:['not','an','object']});assertError(nonObject,400,'VALIDATION_ERROR',['body']);
    const hiddenInvalid=await request(f.actors.nonMember,'POST',url,{body:{...valid,extraField:true}});assertError(hiddenInvalid,404,'NOT_FOUND');
    const duplicate=await request(owner,'POST',url,{body:{...valid,attachmentIds:[uploaded.body.attachment.id,uploaded.body.attachment.id]}});assertError(duplicate,400,'VALIDATION_ERROR',['attachmentIds']);
    const tooMany=await request(owner,'POST',url,{body:{...valid,attachmentIds:['a1','a2','a3','a4','a5','a6']}});assertError(tooMany,400,'VALIDATION_ERROR',['attachmentIds']);
    const tooManyBytes=Array.from({length:3},(_,index)=>'quota-attachment-'+index);
    for(const id of tooManyBytes)f.db.prepare("INSERT INTO Attachments(attachment_id,conversation_id,uploaded_by,storage_key,encrypted_metadata,byte_size,status,expires_at,integrity_digest,declared_algorithm,declared_format_version) VALUES(?,?,?,?,?,?,'pending',?,?,?,?)")
        .run(id,f.groupId,owner.id,require('node:crypto').createHash('sha256').update(id).digest('hex').slice(0,48),'opaque',50*1024*1024,'2026-12-01T00:00:00.000Z','b'.repeat(64),'X25519-AESGCM','v1');
    const aggregate=await request(owner,'POST',url,{body:{...valid,attachmentIds:tooManyBytes}});assertError(aggregate,400,'VALIDATION_ERROR',['attachmentIds']);
    const missing=await request(owner,'POST',url,{body:{...valid,attachmentIds:['missing-http-attachment']}});assertError(missing,404,'NOT_FOUND');
    const otherConversationResult=await request(owner,'POST',url,{body:{conversationId:otherConversation,messageId:'other-committed-message',attachmentIds:[uploaded.body.attachment.id]}});
    assertError(otherConversationResult,404,'NOT_FOUND');
    const otherUploader=await request(owner,'POST',url,{body:{...valid,attachmentIds:[otherUpload.body.attachment.id]}});assertError(otherUploader,404,'NOT_FOUND');
    const uncommitted=await request(owner,'POST',url,{body:{...valid,messageId:'not-committed'}});assertError(uncommitted,409,'CONFLICT');
    const expiredId=expiredUpload.body.attachment.id;
    f.db.prepare('UPDATE Attachments SET expires_at=? WHERE attachment_id=?').run('2025-12-31T23:59:59.000Z',expiredId);
    const expired=await request(owner,'POST',url,{body:{...valid,attachmentIds:[expiredId]}});assertError(expired,409,'CONFLICT');
    const deletedId=deletedUpload.body.attachment.id;assert.equal((await request(owner,'DELETE','/api/attachments/'+deletedId)).status,204);
    const deleted=await request(owner,'POST',url,{body:{...valid,attachmentIds:[deletedId]}});assertError(deleted,409,'CONFLICT');
    const associated=await request(owner,'POST',url,{body:valid});assert.equal(associated.status,200);
    assert.equal(associated.body.attachments.length,1);assert.equal(associated.body.attachments[0].status,'ready');assertSecurityHeaders(associated);
    assert.equal('storageKey' in associated.body.attachments[0],false);
    const replay=await request(owner,'POST',url,{body:valid});assertError(replay,409,'CONFLICT');
});

test('A04 streams exact bytes with completion-only audit; A06 returns paginated authorized metadata',async t=>{
    const f=await fixture(t),owner=f.actors.owner,bytes=Buffer.from('synthetic encrypted bytes'),secondBytes=Buffer.from('second encrypted payload');
    const uploaded=await upload(owner.browser,header(f.groupId,bytes.length),bytes,owner.token);
    const uploadedSecond=await upload(owner.browser,header(f.groupId,secondBytes.length),secondBytes,owner.token);
    insertMessage(f);
    const associated=await request(owner,'POST','/api/attachments/associations',{
        body:{conversationId:f.groupId,messageId:'http-committed-message',attachmentIds:[uploaded.body.attachment.id,uploadedSecond.body.attachment.id]},
    });
    assert.equal(associated.status,200);
    const before=f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='attachment.downloaded'").get().n;
    const cookie=[...owner.browser.cookies].map(([k,v])=>k+'='+v).join('; ');
    const downloadPath='/api/attachments/'+uploaded.body.attachment.id+'/download';
    const serverFinished=observeServerFinish(f.application.server,downloadPath);
    const response=await f.download(owner.browser.origin+downloadPath,{
        headers:{Origin:owner.browser.sourceOrigin,Cookie:cookie},
    });
    assert.equal(response.status,200);assertSecurityHeaders(response);
    assert.equal(response.headers.get('content-type'),'application/octet-stream');
    assert.equal(response.headers.get('content-disposition'),'attachment');
    assert.equal(response.headers.get('content-length'),String(bytes.length));
    const received=Buffer.from(await response.arrayBuffer());
    assert.deepEqual(received,bytes);
    assert.equal(createHash('sha256').update(received).digest('hex'),uploaded.body.attachment.integrityDigest);
    const completion=await serverFinished;
    const auditWaitStarted=performance.now();
    const completedAuditCount=await waitForAuditChange(f.db,before);
    const auditWaitMs=Number((performance.now()-auditWaitStarted).toFixed(3));
    t.diagnostic('A04 completion='+JSON.stringify(completion)+' auditCount='+completedAuditCount+
        ' expectedAuditCount='+(before+1)+' auditWaitMs='+auditWaitMs);
    assert.equal(completion.requestObserved,true,'download request reached the observed server');
    assert.equal(completion.event,'finish','server completed the download response');
    assert.equal(completion.writableFinished,true,'server response reached writableFinished');
    assert.equal(completedAuditCount,before+1,
        'completed response records exactly one download');

    const page=await request(owner,'GET','/api/files/search?conversationId='+encodeURIComponent(f.groupId)+'&limit=1');
    assert.equal(page.status,200);assert.equal(page.body.items.length,1);
    assert.ok(page.body.nextCursor,'first search page exposes a continuation cursor');assertSecurityHeaders(page);
    const next=await request(owner,'GET','/api/files/search?conversationId='+encodeURIComponent(f.groupId)+'&limit=1&cursor='+encodeURIComponent(page.body.nextCursor));
    assert.equal(next.status,200);assert.equal(next.body.items.length,1);assert.equal(next.body.nextCursor,null);assertSecurityHeaders(next);
    assert.deepEqual(new Set([page.body.items[0].id,next.body.items[0].id]),new Set([uploaded.body.attachment.id,uploadedSecond.body.attachment.id]));
    const outsider=await request(f.actors.nonMember,'GET','/api/attachments/'+uploaded.body.attachment.id);
    const absent=await request(owner,'GET','/api/attachments/no-such-attachment');
    const malformed=await request(owner,'GET','/api/attachments/not%20a%20valid%20id');
    assert.deepEqual([outsider.status,outsider.body],[absent.status,absent.body]);
    assert.deepEqual([malformed.status,malformed.body],[absent.status,absent.body]);
    const deniedDownload=await request(f.actors.nonMember,'GET','/api/attachments/'+uploaded.body.attachment.id+'/download');
    const absentDownload=await request(owner,'GET','/api/attachments/no-such-attachment/download');
    assert.deepEqual([deniedDownload.status,deniedDownload.body],[absentDownload.status,absentDownload.body]);
});

test('A04 missing and truncated stored bytes return 503 before a successful response and are not completed downloads',async t=>{
    const f=await fixture(t),owner=f.actors.owner,bytes=Buffer.from('integrity-check');
    const uploaded=await upload(owner.browser,header(f.groupId,bytes.length),bytes,owner.token);
    insertMessage(f);
    const associated=await request(owner,'POST','/api/attachments/associations',{
        body:{conversationId:f.groupId,messageId:'http-committed-message',attachmentIds:[uploaded.body.attachment.id]},
    });
    assert.equal(associated.status,200);
    const row=f.db.prepare('SELECT storage_key FROM Attachments WHERE attachment_id=?').get(uploaded.body.attachment.id);
    const filename=f.storage.resolve(row.storage_key);
    fs.writeFileSync(filename,Buffer.from('short'));
    const truncated=await request(owner,'GET','/api/attachments/'+uploaded.body.attachment.id+'/download');
    assertError(truncated,503,'SERVICE_UNAVAILABLE');
    assertSecurityHeaders(truncated);
    fs.unlinkSync(filename);
    const missing=await request(owner,'GET','/api/attachments/'+uploaded.body.attachment.id+'/download');
    assertError(missing,503,'SERVICE_UNAVAILABLE');
    assertSecurityHeaders(missing);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='attachment.downloaded'").get().n,0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='attachment.download.unavailable'").get().n,2);
});

test('aborted A04 responses do not record completed downloads',async t=>{
    const f=await fixture(t,{slowRead:true}),owner=f.actors.owner,bytes=Buffer.alloc(1024*1024,0x5a);
    const uploaded=await upload(owner.browser,header(f.groupId,bytes.length),bytes,owner.token);assert.equal(uploaded.status,201);
    insertMessage(f);
    const associated=await request(owner,'POST','/api/attachments/associations',{body:{conversationId:f.groupId,messageId:'http-committed-message',attachmentIds:[uploaded.body.attachment.id]}});
    assert.equal(associated.status,200);
    const cookie=[...owner.browser.cookies].map(([k,v])=>k+'='+v).join('; '),controller=new AbortController();
    const response=await fetch(owner.browser.origin+'/api/attachments/'+uploaded.body.attachment.id+'/download',{
        headers:{Origin:owner.browser.sourceOrigin,Cookie:cookie},signal:controller.signal});
    assert.equal(response.status,200);
    const reader=response.body.getReader(),first=await reader.read();assert.ok(first.value&&first.value.length>0);
    controller.abort();await assert.rejects(reader.read(),error=>error.name==='AbortError');
    await f.readTerminated();
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='attachment.downloaded'").get().n,0);
});

test('attachment JSON routes retain the 8 KiB, JSON-only and UTF-8 parser contract',async t=>{
    const f=await fixture(t),owner=f.actors.owner,url='/api/attachments/associations';
    const cases=[
        {body:'{bad',type:'application/json',status:400,code:'VALIDATION_ERROR'},
        {body:'{}',type:'text/plain',status:400,code:'VALIDATION_ERROR'},
        {body:'{}',type:'application/json; charset=utf-7',status:415,code:'UNSUPPORTED_MEDIA_TYPE'},
        {body:' '.repeat(8193),type:'application/json',status:413,code:'PAYLOAD_TOO_LARGE'},
    ];
    for(const item of cases){
        const response=await rawActorRequest(owner,url,'POST',Buffer.from(item.body),{'Content-Type':item.type});
        assertError(response,item.status,item.code);assertSecurityHeaders(response);
        assert.deepEqual(dbCounts(f.db),{attachments:0,reservations:0,audit:0});
        assert.deepEqual(snapshotStorage(f.root),[]);
    }
});

test('failed A04 response streams never record a completed download',async t=>{
    const f=await fixture(t,{failRead:true}),owner=f.actors.owner,bytes=Buffer.from('response stream must fail before its declared length');
    const uploaded=await upload(owner.browser,header(f.groupId,bytes.length),bytes,owner.token);assert.equal(uploaded.status,201);
    insertMessage(f);
    const associated=await request(owner,'POST','/api/attachments/associations',{body:{conversationId:f.groupId,messageId:'http-committed-message',attachmentIds:[uploaded.body.attachment.id]}});
    assert.equal(associated.status,200);
    const cookie=[...owner.browser.cookies].map(([k,v])=>k+'='+v).join('; ');
    const response=await fetch(owner.browser.origin+'/api/attachments/'+uploaded.body.attachment.id+'/download',{headers:{Origin:owner.browser.sourceOrigin,Cookie:cookie}});
    assert.equal(response.status,200);assertSecurityHeaders(response);
    await assert.rejects(response.arrayBuffer());await f.readTerminated();
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='attachment.downloaded'").get().n,0);
});
