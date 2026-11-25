// T-5B-20 (DB5-R12.8, DB5-R13.5, ARCH-R01.6, NFR-06; design Group_Repository and the repositories.js row).
// Allow-list clause of P-30: audit.insert accepts the metadata keys target_id and role when the value matches
// ^[a-zA-Z0-9_.:-]{1,64}$, rejects every other value and every key outside the allow-list, and a rejected insert
// writes no row. The full P-30 property (service operations and canary scans) lands in T-5C-40.
// translate() is exported with unchanged behaviour: a trigger abort maps to INVALID (the Group_Repository maps it
// to CONFLICT itself, CI-12) and a foreign key error to REFERENCE.
// Databases live in new folders under os.tmpdir() (support/database.js); no unseeded random source, clock or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createFilesystemProvider } = require('../server/attachments/storage/filesystem');
const { storageRoot } = require('./support/attachments');
const { fixture, temporary, users, Database } = require('./support/database');
const { RepositoryError, translate } = require('../server/database/repositories');
const { httpGroupFixture, createClock, openLimiter, actorRequest, snapshot } = require('./support/groups');
const { createGroupService } = require('../server/groups/service');

const ALLOWED_KEYS = ['reason_code', 'operation', 'outcome', 'count', 'duration_ms', 'target_id', 'role'];
const NEW_KEYS = ['target_id', 'role'];
const VALUE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-';
// Spaces, quotes, path separators, control characters, markup and non-ASCII letters (escaped: the file is ASCII).
const HOSTILE_CHARACTERS = [' ', "'", '"', '`', '/', '\\', '\n', '\r', '\t', '\u0000', '<', '>', ';', '%', '\u00e9', '\u2028'];
// Seeded property run of the allow-list clause. Replay with PROPERTY_SEED=<seed> node --test tests/audit-metadata.test.js
const P30_RUNS = 200;
const P30_DEFAULT_SEED = 30120;

const auditRows = db => db.prepare('SELECT count(*) AS n FROM AuditLogs').get().n;
const event = metadata => ({ actor_user_id:'a', event_type:'group.member.role_changed', source:'groups', subject_id:'group-1', metadata });
const isInvalid = error => error instanceof RepositoryError && error.code === 'INVALID' &&
    error.message === 'Database operation failed: INVALID' && error.cause === undefined;

// mulberry32, a 32-bit seeded generator (the same as baseline-checksums.test.js until T-5B-10 adds support/random.js).
function createRandom(seed) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min, max) => min + Math.floor(next() * (max - min + 1));
    return { int, pick:list => list[int(0, list.length - 1)] };
}
function seedSetting() {
    const raw = process.env.PROPERTY_SEED;
    if (raw === undefined || raw === '') return P30_DEFAULT_SEED;
    if (!/^\d{1,10}$/.test(raw) || Number(raw) > 0xffffffff) throw new Error('PROPERTY_SEED must be an integer from 0 to 4294967295');
    return Number(raw);
}
const validValue = (random, length) => Array.from({ length }, () => random.pick([...VALUE_ALPHABET])).join('');

test('audit.insert stores target_id and role with valid values beside the existing keys', t => {
    const { repositories:r } = fixture(t); users(r);
    const metadata = { operation:'member.role_change', outcome:'ok', reason_code:'owner_transfer', count:1, duration_ms:0,
        target_id:'6f1c0e9a-2b4d-4c8e-9a10-3f5e7d9b1c2a', role:'admin' };
    const stored = r.audit.insert(event(metadata));
    assert.deepEqual(JSON.parse(stored.metadata_json), metadata);
    assert.equal(stored.source, 'groups');
    assert.equal(stored.subject_id, 'group-1');
    for (const value of ['b', 'owner', 'member', 'A.b_c:d-9', 'x'.repeat(64)]) {
        for (const key of NEW_KEYS) {
            assert.deepEqual(JSON.parse(r.audit.insert(event({ [key]:value })).metadata_json), { [key]:value }, `${key}=${value}`);
        }
    }
});

test('audit.insert rejects target_id and role values with spaces, quotes, path separators or more than 64 characters', t => {
    const { db, repositories:r } = fixture(t); users(r);
    const hostile = ['user b', ' b', 'b ', "o'brien", 'say"hi"', '`b`', '../etc', 'a/b', '/var/lib/secubuzz', 'C:\\Users\\b',
        'a\\b', 'line\nbreak', 'tab\there', '', 'x'.repeat(65), 'x'.repeat(200), 'caf\u00e9', 1, true, null, {}, ['admin']];
    const before = auditRows(db);
    for (const key of NEW_KEYS) {
        for (const value of hostile) {
            assert.throws(() => r.audit.insert(event({ [key]:value })), isInvalid, `${key}=${JSON.stringify(value)}`);
            assert.throws(() => r.audit.insert(event({ operation:'member.add', [key]:value })), isInvalid, `${key}=${JSON.stringify(value)} with a valid key`);
        }
    }
    assert.equal(auditRows(db), before, 'a rejected insert writes no AuditLogs row');
});

test('audit.insert still rejects password, prompt, ciphertext, other keys and a reason_code with spaces', t => {
    const { db, repositories:r } = fixture(t); users(r);
    const before = auditRows(db);
    const rejected = [{ password:'SECRET' }, { prompt:'PRIVATE' }, { ciphertext:'PRIVATE' }, { reason_code:'private words with spaces' },
        { plaintext:'PRIVATE' }, { name:'Group' }, { description:'Text' }, { file_name:'report.pdf' }, { path:'a' }, { token:'a' },
        { key:'a' }, { targetId:'b' }, { TARGET_ID:'b' }, { 'target_id ':'b' }, { target_id:'b', password:'SECRET' }, { role:'admin', title:'Group' }];
    for (const metadata of rejected) assert.throws(() => r.audit.insert(event(metadata)), isInvalid, JSON.stringify(metadata));
    for (const metadata of [[], 'target_id', 1]) assert.throws(() => r.audit.insert(event(metadata)), isInvalid, JSON.stringify(metadata));
    assert.equal(auditRows(db), before, 'a rejected insert writes no AuditLogs row');
});

test('P-30 allow-list clause: generated values and keys are accepted exactly when the key is allowed and the value matches', t => {
    // **Validates: Requirements DB5-R12.8, NFR-06**
    const { db, repositories:r } = fixture(t); users(r);
    const seed = seedSetting();
    t.diagnostic(`P-30 allow-list seed=${seed} runs=${P30_RUNS}`);
    const random = createRandom(seed);
    for (let run = 0; run < P30_RUNS; run++) {
        const label = `seed=${seed} run=${run}`;
        const key = random.pick(NEW_KEYS);
        const value = validValue(random, random.int(1, 64));
        const stored = r.audit.insert(event({ [key]:value }));
        assert.deepEqual(JSON.parse(stored.metadata_json), { [key]:value }, `${label} accepted ${key}=${value}`);

        const rows = auditRows(db);
        let bad;
        if (random.int(0, 2) === 0) {
            bad = value + validValue(random, random.int(65 - value.length, 200 - value.length));
        } else {
            const at = random.int(0, value.length);
            bad = value.slice(0, at) + random.pick(HOSTILE_CHARACTERS) + value.slice(at);
        }
        assert.throws(() => r.audit.insert(event({ [key]:bad })), isInvalid, `${label} value ${key}=${JSON.stringify(bad)}`);
        let other = validValue(random, random.int(1, 24));
        if (ALLOWED_KEYS.includes(other)) other += '_x';
        assert.throws(() => r.audit.insert(event({ [other]:value })), isInvalid, `${label} key ${JSON.stringify(other)}`);
        assert.equal(auditRows(db), rows, `${label} a rejected insert writes no AuditLogs row`);
    }
});

test('translate is exported and keeps its error classes for real SQLite errors without driver text', t => {
    assert.equal(typeof translate, 'function');
    const connections = [];
    const directory = temporary(t, () => { for (const connection of connections.reverse()) if (connection.open) connection.close(); });
    const filename = path.join(directory, 'translate.sqlite');
    const db = new Database(filename); connections.push(db);
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE parent(id TEXT PRIMARY KEY, name TEXT UNIQUE, size INTEGER CHECK(size >= 0), note TEXT NOT NULL DEFAULT '');
        CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
        CREATE TRIGGER parent_guard BEFORE UPDATE OF note ON parent BEGIN
            SELECT RAISE(ABORT, 'group_conflict') WHERE NEW.note = 'conflict';
            SELECT RAISE(ABORT, 'username_unavailable') WHERE NEW.note = 'taken';
        END;
        INSERT INTO parent(id, name, size) VALUES('p', 'unique-name', 1);`);
    const raised = work => { try { work(); } catch (error) { return error; } throw new Error('expected a database error'); };
    const cases = [
        ['primary key', () => db.prepare("INSERT INTO parent(id) VALUES('p')").run(), 'DUPLICATE'],
        ['unique', () => db.prepare("INSERT INTO parent(id, name) VALUES('q', 'unique-name')").run(), 'DUPLICATE'],
        ['trigger username_unavailable', () => db.prepare("UPDATE parent SET note='taken'").run(), 'DUPLICATE'],
        ['other trigger', () => db.prepare("UPDATE parent SET note='conflict'").run(), 'INVALID'],
        ['check', () => db.prepare("INSERT INTO parent(id, size) VALUES('q', -1)").run(), 'INVALID'],
        ['not null', () => db.prepare("INSERT INTO parent(id, note) VALUES('q', NULL)").run(), 'INVALID'],
        ['foreign key', () => db.prepare("INSERT INTO child(id, parent_id) VALUES('c', 'missing')").run(), 'REFERENCE'],
        ['syntax', () => db.prepare('SELEC 1'), 'DATABASE'],
        ['no code', () => { throw new Error('/var/lib/secubuzz/private driver text'); }, 'DATABASE']
    ];
    const second = new Database(filename, { timeout:0 }); connections.push(second);
    db.exec('BEGIN IMMEDIATE');
    cases.push(['busy', () => second.prepare("INSERT INTO parent(id) VALUES('busy')").run(), 'BUSY']);
    for (const [label, work, code] of cases) {
        const error = raised(work);
        const mapped = translate(error);
        assert.ok(mapped instanceof RepositoryError, label);
        assert.equal(mapped.code, code, `${label}: ${error.code}`);
        assert.equal(mapped.message, `Database operation failed: ${code}`, label);
        assert.equal(mapped.cause, undefined, label);
        assert.equal(translate(mapped), mapped, `${label}: a RepositoryError passes through unchanged`);
    }
    db.exec('ROLLBACK');
});

test('P-30: committed group operations write one safe audit row and refusals write none', {timeout:120000}, async t => {
    const f=await httpGroupFixture(t,{clock:createClock(),features:{groupApi:true,groups:{directAdd:true,maxMembers:50,
        maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}}});
    const service=createGroupService({db:f.db,auth:f.application.auth,limiter:openLimiter(),features:{groupApi:true,
        groups:{directAdd:true,maxMembers:50,maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}},now:f.clock.now});
    const context=actor=>{
        const token=actor.browser.cookies.get(f.config.sessionCookie),row=f.application.auth.resolveToken(token).row;
        return{context:{userId:row.user_id,sessionId:row.session_id},proof:f.application.auth.csrfProof(token,null,actor.token)};
    };
    const actors=Object.fromEntries(['owner','admin','member','nonMember','pendingInvitee','removedMember'].map(name=>[name,context(f.actors[name])]));
    const canary='P30 hostile ../quoted" group name';
    const stderr=[];const originalWrite=process.stderr.write;
    process.stderr.write=function(chunk,...args){stderr.push(String(chunk));return originalWrite.call(this,chunk,...args);};
    let groupId;
    const groupRows=id=>f.db.prepare("SELECT * FROM AuditLogs WHERE source='groups' AND subject_id=? ORDER BY rowid").all(id);
    const record=async(label,action)=>{
        const before=groupId?groupRows(groupId).length:0,result=await action();
        if(!groupId&&result?.group?.id)groupId=result.group.id;
        assert.ok(groupId,`${label}: operation produced group id`);
        const rows=groupRows(groupId);assert.equal(rows.length,before+1,`${label}: one committed audit row`);
        const row=rows.at(-1);assert.equal(row.source,'groups');assert.equal(row.subject_id,groupId);
        const metadata=JSON.parse(row.metadata_json);assert.ok(Object.keys(metadata).every(key=>ALLOWED_KEYS.includes(key)),`${label}: allow-listed metadata keys`);
        for(const value of Object.values(metadata)){
            if(typeof value==='string')assert.match(value,/^[a-zA-Z0-9_.:-]{1,64}$/,`${label}: safe metadata string`);
            else assert.ok(typeof value==='number'&&Number.isFinite(value)&&value>=0,`${label}: safe metadata number`);
        }
        return result;
    };
    try{
        const created=await record('create',()=>service.createGroup(actors.owner.context,actors.owner.proof,{name:canary,description:canary,historyPolicy:'all'},'203.0.113.9'));
        groupId=created.group.id;
        await record('update',()=>service.updateGroup(actors.owner.context,actors.owner.proof,groupId,{name:`${canary} updated`,description:canary}));
        await record('direct add admin',()=>service.addMember(actors.owner.context,actors.owner.proof,groupId,{userId:f.actors.admin.id}));
        await record('direct add member',()=>service.addMember(actors.owner.context,actors.owner.proof,groupId,{userId:f.actors.member.id}));
        await record('direct add target',()=>service.addMember(actors.owner.context,actors.owner.proof,groupId,{userId:f.actors.nonMember.id}));
        await record('role change',()=>service.changeMemberRole(actors.owner.context,actors.owner.proof,groupId,f.actors.admin.id,{role:'admin'}));
        const cancelled=await record('invitation create for cancel',()=>service.createInvitation(actors.owner.context,actors.owner.proof,groupId,{userId:f.actors.removedMember.id},'203.0.113.9'));
        await record('invitation cancel',()=>service.cancelInvitation(actors.owner.context,actors.owner.proof,groupId,cancelled.invitation.id));
        const accepted=await record('invitation create for accept',()=>service.createInvitation(actors.owner.context,actors.owner.proof,groupId,{userId:f.actors.removedMember.id},'203.0.113.9'));
        await record('invitation accept',()=>service.acceptInvitation(actors.removedMember.context,actors.removedMember.proof,accepted.invitation.id));
        const declined=await record('invitation create for decline',()=>service.createInvitation(actors.owner.context,actors.owner.proof,groupId,{userId:f.actors.pendingInvitee.id},'203.0.113.9'));
        await record('invitation decline',()=>service.declineInvitation(actors.pendingInvitee.context,actors.pendingInvitee.proof,declined.invitation.id));
        await record('ownership transfer',()=>service.transferOwnership(actors.owner.context,actors.owner.proof,groupId,{userId:f.actors.admin.id}));
        await record('member removal',()=>service.removeMember(actors.admin.context,actors.admin.proof,groupId,f.actors.nonMember.id));
        await record('member leave',()=>service.leaveGroup(actors.removedMember.context,actors.removedMember.proof,groupId));
        await record('archive',()=>service.archiveGroup(actors.admin.context,actors.admin.proof,groupId));
        const beforeRefusal=groupRows(groupId).length;
        assert.throws(()=>service.changeMemberRole(actors.member.context,actors.member.proof,groupId,f.actors.owner.id,{role:'admin'}));
        assert.equal(groupRows(groupId).length,beforeRefusal,'refusal writes no audit row');
    }finally{process.stderr.write=originalWrite;}
    const all=groupRows(groupId),serialized=JSON.stringify(all);
    assert.ok(!serialized.includes(canary),'audit metadata and event rows exclude hostile canary text');
    assert.ok(!stderr.join('').includes(canary),'stderr excludes hostile canary text');
    t.diagnostic(`P-30 committedOperations=${all.length} refusedOperations=1`);
});

test('P-30: stored group messages write one safe audit row and refused canaries write none',{timeout:60000},async t=>{
    const canary='P30-MESSAGE-CANARY ../" hostile';
    const verifier=Object.freeze({async verifyEnvelope(){return {verified:true};}});
    const f=await httpGroupFixture(t,{clock:createClock(),features:{groupApi:true,groupMessaging:true,groups:{directAdd:false,maxMembers:50,
        maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}},messageOptions:{groupRecipientKeyVerifier:verifier}});
    const rows=()=>f.db.prepare("SELECT event_type,metadata_json FROM AuditLogs WHERE source='groups' AND subject_id=? AND event_type LIKE 'message.%' ORDER BY rowid").all(f.groupId);
    const owner=f.actors.owner,body={id:'p30-message-audit',conversationId:f.groupId,senderId:owner.id,senderName:'Group Owner',
        timestamp:f.clock.iso(),type:'text',encryption:{version:1,algorithm:'AES-256-GCM',encoding:'base64',iv:Buffer.alloc(12,1).toString('base64'),
            ciphertext:Buffer.from(canary).toString('base64')}};
    const stderr=[],write=process.stderr.write;process.stderr.write=function(chunk,...args){stderr.push(String(chunk));return write.call(this,chunk,...args);};
    try{
        const stored=await actorRequest(owner,'POST',`/api/groups/${f.groupId}/messages`,{body});assert.equal(stored.status,201);
        const committed=rows();assert.equal(committed.length,1);assert.equal(committed[0].event_type,'message.stored');
        const metadata=JSON.parse(committed[0].metadata_json);assert.ok(Object.keys(metadata).every(key=>ALLOWED_KEYS.includes(key)));
        const before=snapshot(f.db),refused=await actorRequest(owner,'POST',`/api/groups/${f.groupId}/messages`,{body:{content:canary}});
        assert.equal(refused.status,400);assert.deepEqual(snapshot(f.db),before);assert.equal(rows().length,1,'refused message emits no audit row');
    }finally{process.stderr.write=write;}
    assert.ok(!JSON.stringify(rows()).includes(canary),'audit excludes plaintext canary');assert.ok(!stderr.join('').includes(canary),'stderr excludes plaintext canary');
    t.diagnostic('P-30 group message committed=1 refused=1 safeAudit=1 canaryLeaks=0');
});

test('P-30: attachment state changes audit once, retention uses an empty actor, and private canaries never reach audit/logs', {timeout:120000}, async t => {
    const root=storageRoot(t),clock=createClock(),logs=[];
    const storage=createFilesystemProvider({root,repositoryRoot:path.resolve(__dirname,'../..')});
    const settings={pendingTtlSeconds:86400,purgeDelaySeconds:86400,retentionIntervalSeconds:3600,
        quotaUserBytes:1073741824,quotaConversationBytes:5368709120,maxPendingPerUser:10,uploadsPerHour:30,
        maxConcurrentUploadsPerUser:2,maxConcurrentUploadsPerSource:5};
    const features={groupApi:true,groupMessaging:false,attachmentApi:true,groups:{maxMembers:50,maxPendingInvitationsPerGroup:20,
        maxPendingInvitationsPerInvitee:20,directAdd:false},attachments:{...settings,storageDir:root}};
    const f=await httpGroupFixture(t,{clock,features,storage,env:{AUTH_SESSION_TTL_SECONDS:'172800'},log:line=>logs.push(line),logger:line=>logs.push(line)});
    const owner=f.actors.owner,sessionToken=owner.browser.cookies.get(f.config.sessionCookie),session=f.application.auth.resolveToken(sessionToken);
    const context={userId:session.row.user_id,sessionId:session.row.session_id};
    const proof=f.application.auth.csrfProof(sessionToken,null,owner.token),service=f.application.attachments;
    const canary='P30-CANARY\n../secret\\C:\\private';
    const bytes=Buffer.from('synthetic encrypted bytes');
    const upload=metadata=>service.upload(context,proof,{conversationId:f.groupId,byteSize:bytes.length,encryptedMetadata:metadata,
        algorithm:'X25519-AESGCM',formatVersion:'v1'},Readable.from([bytes]),'127.0.0.1');
    const audits=()=>f.db.prepare("SELECT actor_user_id,event_type,source,subject_id,metadata_json FROM AuditLogs WHERE source='attachments' ORDER BY rowid").all();
    const checkNew=(count,eventType,subject,actor=owner.id)=>{
        const rows=audits();assert.equal(rows.length,count,`${eventType} adds exactly one audit row`);
        const row=rows.at(-1);assert.equal(row.event_type,eventType);assert.equal(row.source,'attachments');assert.equal(row.subject_id,subject);
        assert.equal(row.actor_user_id,actor);
        const metadata=JSON.parse(row.metadata_json);
        assert.ok(Object.keys(metadata).every(key=>ALLOWED_KEYS.includes(key)));
        for(const value of Object.values(metadata))if(typeof value==='string')assert.match(value,/^[a-zA-Z0-9_.:-]{1,64}$/);
    };
    const stderr=[],originalWrite=process.stderr.write;
    process.stderr.write=function(chunk,...args){stderr.push(String(chunk));return originalWrite.call(this,chunk,...args);};
    try{
        const first=await upload(canary);checkNew(1,'attachment.uploaded',first.id);
        const messageId='p30-attachment-audit-message',at=clock.iso();
        f.repositories.messages.insertAuthenticated({message_id:messageId,conversation_id:f.groupId,sender_id:owner.id,receiver_id:null,
            ciphertext:'opaque',iv:'opaque',envelope_version:1,encoding:'base64',sender_name:'Synthetic owner',client_timestamp:at,
            message_type:'text',fingerprint:'c'.repeat(64),client_id:'p30-attachment-audit-client',message_seq:1,created_at:at});
        service.associate(context,proof,{conversationId:f.groupId,messageId,attachmentIds:[first.id]});
        checkNew(2,'attachment.associated',first.id);
        const downloaded=await service.download(context,first.id);let byteCount=0;
        for await(const chunk of downloaded.stream)byteCount+=chunk.length;
        assert.equal(byteCount,bytes.length);downloaded.onSent();downloaded.onSent();checkNew(3,'attachment.downloaded',first.id);
        await service.remove(context,proof,first.id);checkNew(4,'attachment.deleted',first.id);

        const expired=await upload(canary);clock.advance(settings.pendingTtlSeconds*1000+1);
        const beforeRetention=audits().length,result=await f.application.retentionJob.runOnce();
        assert.equal(result.expired,1);assert.equal(result.failures,0);
        const retentionEvents=audits().slice(beforeRetention);
        assert.equal(retentionEvents.length,2,'expiry and the previously eligible purge each write one audit row');
        assert.deepEqual(retentionEvents.map(row=>row.event_type).sort(),['attachment.expired','attachment.purged']);
        assert.ok(retentionEvents.every(row=>row.actor_user_id===null));
        assert.equal(retentionEvents.find(row=>row.event_type==='attachment.expired').subject_id,expired.id);
        const unavailable=await upload(canary),row=f.db.prepare('SELECT storage_key FROM Attachments WHERE attachment_id=?').get(unavailable.id);
        const unavailableMessage='p30-missing-bytes-message',now=clock.iso();
        f.repositories.messages.insertAuthenticated({message_id:unavailableMessage,conversation_id:f.groupId,sender_id:owner.id,receiver_id:null,
            ciphertext:'opaque',iv:'opaque',envelope_version:1,encoding:'base64',sender_name:'Synthetic owner',client_timestamp:now,
            message_type:'text',fingerprint:'d'.repeat(64),client_id:'p30-missing-bytes-client',message_seq:2,created_at:now});
        service.associate(context,proof,{conversationId:f.groupId,messageId:unavailableMessage,attachmentIds:[unavailable.id]});
        assert.equal(await storage.delete(row.storage_key),true);
        await assert.rejects(service.download(context,unavailable.id),error=>error.status===503&&error.code==='SERVICE_UNAVAILABLE');
        checkNew(10,'attachment.download.unavailable',unavailable.id);
        const beforeRefusal=audits().length;
        assert.throws(()=>service.associate(context,proof,{conversationId:f.groupId,messageId:'missing-message',attachmentIds:[unavailable.id]}),error=>error.status===409);
        assert.equal(audits().length,beforeRefusal,'refused association adds no audit row');
    }finally{process.stderr.write=originalWrite;}
    const serialized=JSON.stringify(audits());
    assert.doesNotMatch(serialized,/P30-CANARY|\.\.\/secret|C:\\\\private/i);
    assert.doesNotMatch(logs.join('\n'),/P30-CANARY|\.\.\/secret|C:\\\\private/i);
    assert.doesNotMatch(stderr.join(''),/P30-CANARY|\.\.\/secret|C:\\\\private/i);
});
