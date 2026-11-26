'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { httpGroupFixture, actorRequest, createClock, snapshot, changedTables, openLimiter } = require('./support/groups');
const { AuthError } = require('../server/auth/errors');
const { MAX_BODY } = require('../server/messaging/validation');
const { createGroupMessageService } = require('../server/messaging/group');
const { forAll } = require('./support/random');

const enabled = Object.freeze({ groupApi:true, groupMessaging:true, groups:Object.freeze({ maxMembers:50,
    maxPendingInvitationsPerGroup:20, maxPendingInvitationsPerInvitee:10 }) });
const disabledMessaging = Object.freeze({ ...enabled, groupMessaging:false });
const v1Verifier = Object.freeze({ async verifyEnvelope() { return { verified:true }; } });
const testOnlyVerifier = Object.freeze({ testOnly:true, async verifyEnvelope() { return { verified:true }; } });
const envelope = (actor, groupId, id, name) => ({ id, conversationId:groupId, senderId:actor.id,
    senderName:name, timestamp:'2026-01-01T00:00:00.000Z', type:'text', encryption:{ version:1,
        algorithm:'AES-256-GCM', encoding:'base64', iv:Buffer.alloc(12,1).toString('base64'),
        ciphertext:Buffer.alloc(32,2).toString('base64') } });
const endpoint = (id, suffix = '') => `/api/groups/${id}${suffix}`;
const rows = (db, sql, ...args) => db.prepare(sql).all(...args);
function actorContext(f,actor) {
    const token=actor.browser.cookies.get(f.config.sessionCookie);
    const session=f.application.auth.resolveToken(token).row;
    return {context:{userId:session.user_id,sessionId:session.session_id},proof:f.application.auth.csrfProof(token,null,actor.token)};
}

async function fixture(t, { features = enabled, verifier = v1Verifier, verifierTimeoutMs } = {}) {
    const clock = createClock();
    return httpGroupFixture(t, { clock, features, messageOptions:{ groupRecipientKeyVerifier:verifier,
        ...(verifierTimeoutMs === undefined ? {} : { verifierTimeoutMs }) } });
}

test('T-5D-02..04 G19: authenticated v1 envelope verifies outside transactions, stores once, and replays idempotently', async t => {
    const f = await fixture(t);
    const sender = f.actors.owner;
    const body = envelope(sender, f.groupId, 'group-message-1', 'Group Owner');
    const original = f.application.groupMessages;
    assert.ok(original);
    const sent = await actorRequest(sender, 'POST', endpoint(f.groupId, '/messages'), { body });
    assert.equal(sent.status, 201);
    assert.deepEqual([sent.body.outcome, sent.body.message.sequence, sent.body.message.encryption.version], ['created', 1, 1]);
    assert.equal(f.db.prepare('SELECT receiver_id FROM Messages WHERE message_id=?').get(sent.body.message.storageId).receiver_id, null);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='message.stored'").get().n, 1);
    const replay = await actorRequest(sender, 'POST', endpoint(f.groupId, '/messages'), { body });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { outcome:'duplicate', message:sent.body.message });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages WHERE conversation_id=?').get(f.groupId).n, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE event_type='message.stored'").get().n, 1);
});

test('T-5D-02..04 G19: gate, envelope, membership, verifier and refusal atomicity', async t => {
    const f = await fixture(t, { verifier:null });
    const owner = f.actors.owner;
    const invalid = await actorRequest(owner, 'POST', endpoint(f.groupId, '/messages'), { body:{ plaintext:'no' } });
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'VALIDATION_ERROR']);
    const before = snapshot(f.db);
    const valid = envelope(owner, f.groupId, 'no-verifier', 'Group Owner');
    const unavailable = await actorRequest(owner, 'POST', endpoint(f.groupId, '/messages'), { body:valid });
    assert.deepEqual([unavailable.status, unavailable.body.code], [503, 'RECIPIENT_KEYS_UNAVAILABLE']);
    assert.deepEqual(changedTables(before, snapshot(f.db)), []);
    const outsiderBefore = snapshot(f.db);
    const outsider = await actorRequest(f.actors.nonMember, 'POST', endpoint(f.groupId, '/messages'), { body:envelope(f.actors.nonMember, f.groupId, 'outsider', 'Group Outsider') });
    assert.deepEqual([outsider.status, outsider.body.code], [404, 'NOT_FOUND']);
    assert.deepEqual(changedTables(outsiderBefore, snapshot(f.db)), []);
    const v2 = { ...valid, id:'group-v2', encryption:{ version:2, algorithm:'AES-256-GCM', encoding:'base64',
        keyId:'AAAAAAAAAAAAAAAAAAAAAA', iv:Buffer.alloc(12,3).toString('base64'), ciphertext:Buffer.alloc(32,4).toString('base64') } };
    const refusedV2 = await actorRequest(owner, 'POST', endpoint(f.groupId, '/messages'), { body:v2 });
    assert.deepEqual([refusedV2.status, refusedV2.body.code], [503, 'RECIPIENT_KEYS_UNAVAILABLE']);

    const off = await fixture(t, { features:disabledMessaging, verifier:v1Verifier });
    const offBefore = snapshot(off.db);
    const offResponse = await actorRequest(off.actors.owner, 'POST', endpoint(off.groupId, '/messages'), { rawBody:'{ malformed', headers:{ 'Content-Type':'application/json' } });
    assert.deepEqual([offResponse.status, offResponse.body.code], [503, 'FEATURE_UNAVAILABLE']);
    assert.deepEqual(changedTables(offBefore, snapshot(off.db)), []);
});

test('T-5D-22 AF-08: non-envelope bodies and unavailable or refusing verifiers persist no message or receipt', async t => {
    const canary='AF08-CANARY-DO-NOT-STORE';
    const f=await fixture(t);
    const owner=f.actors.owner;
    const malformed=[
        [{content:canary},[400,'VALIDATION_ERROR']],
        [{...envelope(owner,f.groupId,'af08-plain','Group Owner'),encryption:{...envelope(owner,f.groupId,'af08-plain','Group Owner').encryption,ciphertext:canary}},[400,'VALIDATION_ERROR']],
        [{...envelope(owner,f.groupId,'af08-extra','Group Owner'),plaintext:canary},[400,'VALIDATION_ERROR']],
        [{...envelope(owner,f.groupId,'af08-sender','Group Owner'),senderId:f.actors.member.id},[403,'FORBIDDEN']]
    ];
    let stderr='';
    const originalWrite=process.stderr.write;
    process.stderr.write=function(chunk,...args){stderr+=String(chunk);return true;};
    try {
        for(const [body,expected] of malformed) {
            const before=snapshot(f.db);
            const response=await actorRequest(owner,'POST',endpoint(f.groupId,'/messages'),{body});
            assert.deepEqual([response.status,response.body.code],expected);
            assert.deepEqual(snapshot(f.db),before,'AF-08 invalid envelope changes no table');
            assert.ok(!JSON.stringify(response.body).includes(canary));
        }
        const noVerifier=await fixture(t,{verifier:null});
        const noBefore=snapshot(noVerifier.db);
        const noResponse=await actorRequest(noVerifier.actors.owner,'POST',endpoint(noVerifier.groupId,'/messages'),
            {body:envelope(noVerifier.actors.owner,noVerifier.groupId,canary,'Group Owner')});
        assert.deepEqual([noResponse.status,noResponse.body.code],[503,'RECIPIENT_KEYS_UNAVAILABLE']);
        assert.deepEqual(snapshot(noVerifier.db),noBefore);
        assert.ok(!JSON.stringify(noResponse.body).includes(canary));

        const off=await fixture(t,{features:disabledMessaging});
        const offBefore=snapshot(off.db);
        const offResponse=await actorRequest(off.actors.owner,'POST',endpoint(off.groupId,'/messages'),
            {body:envelope(off.actors.owner,off.groupId,canary,'Group Owner')});
        assert.deepEqual([offResponse.status,offResponse.body.code],[503,'FEATURE_UNAVAILABLE']);
        assert.deepEqual(snapshot(off.db),offBefore);
        assert.ok(!JSON.stringify(offResponse.body).includes(canary));

        const productionAuth={...f.application.auth,config:Object.freeze({...f.application.auth.config,production:true})};
        const productionOnly=createGroupMessageService({db:f.db,auth:productionAuth,groups:f.application.groups,
            groupRecipientKeyVerifier:testOnlyVerifier,limiter:openLimiter()});
        const context=actorContext(f,owner);
        const productionBefore=snapshot(f.db);
        await assert.rejects(productionOnly.submit(context.context,context.proof,f.groupId,envelope(owner,f.groupId,canary,'Group Owner')),
            error=>error instanceof AuthError&&error.status===503&&error.code==='RECIPIENT_KEYS_UNAVAILABLE');
        assert.deepEqual(snapshot(f.db),productionBefore,'production rejects test-only verifier before write');

        const refusing=await fixture(t,{verifier:{async verifyEnvelope(){return {verified:false};}}});
        const refusingBefore=snapshot(refusing.db);
        const refused=await actorRequest(refusing.actors.owner,'POST',endpoint(refusing.groupId,'/messages'),
            {body:envelope(refusing.actors.owner,refusing.groupId,canary,'Group Owner')});
        assert.deepEqual([refused.status,refused.body.code],[403,'RECIPIENT_KEYS_UNVERIFIED']);
        assert.deepEqual(snapshot(refusing.db),refusingBefore);
        assert.ok(!JSON.stringify(refused.body).includes(canary));
        for(const database of [f.db,noVerifier.db,off.db,refusing.db]) {
            assert.ok(!JSON.stringify(rows(database,"SELECT event_type,metadata_json FROM AuditLogs WHERE event_type LIKE 'message.%'")).includes(canary));
            assert.equal(database.prepare('SELECT count(*) AS n FROM Messages').get().n,0);
            assert.equal(database.prepare('SELECT count(*) AS n FROM MessageReceipts').get().n,0);
        }
    } finally { process.stderr.write=originalWrite; }
    assert.ok(!stderr.includes(canary),'AF-08 canary never appears on stderr');
});

test('T-5D-03 G19: verifier receives active recipients and verified revision, with bounded failure mapping', async t => {
    let captured;
    const verifier = { async verifyEnvelope(actor, value, context) {
        captured = { actor, value, context, transaction:false };
        return { verified:false };
    } };
    const f = await fixture(t, { verifier });
    const sender = f.actors.owner;
    const response = await actorRequest(sender, 'POST', endpoint(f.groupId, '/messages'), { body:envelope(sender, f.groupId, 'bad-verifier', 'Group Owner') });
    assert.deepEqual([response.status, response.body.code], [403, 'RECIPIENT_KEYS_UNVERIFIED']);
    assert.equal(captured.actor.userId, sender.id);
    assert.equal(captured.context.conversationId, f.groupId);
    assert.equal(captured.context.membershipRevision,
        f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(f.groupId).membership_revision);
    assert.deepEqual([...captured.context.recipientIds].sort(), [f.actors.admin.id, f.actors.member.id].sort());
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n, 0);
    const timeoutFixture = await fixture(t, { verifier:{ verifyEnvelope:() => new Promise(() => {}) }, verifierTimeoutMs:15 });
    const timeout = await actorRequest(timeoutFixture.actors.owner, 'POST', endpoint(timeoutFixture.groupId, '/messages'),
        { body:envelope(timeoutFixture.actors.owner, timeoutFixture.groupId, 'timeout', 'Group Owner') });
    assert.deepEqual([timeout.status, timeout.body.code], [503, 'RECIPIENT_KEYS_UNAVAILABLE']);
});

test('T-5D-04 G19: stale revision, idempotency conflict, and audit failure roll back atomically', async t => {
    let changedDuringVerification = false;
    const f = await fixture(t, { verifier:{ async verifyEnvelope() {
        if (!changedDuringVerification) {
            changedDuringVerification = true;
            const userId = 'during-verify-synthetic';
            f.repositories.users.create({ user_id:userId, username:userId, display_name:'Synthetic concurrent member' });
            f.builder.addMember(f.groupId, userId);
        }
        return { verified:true };
    } } });
    const owner = f.actors.owner;
    const stale = await actorRequest(owner, 'POST', endpoint(f.groupId, '/messages'), { body:envelope(owner, f.groupId, 'stale', 'Group Owner') });
    assert.deepEqual([stale.status, stale.body.code], [409, 'STALE_STATE']);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n, 0);

    f.db.exec(`CREATE TRIGGER reject_group_message_audit BEFORE INSERT ON AuditLogs
        WHEN NEW.event_type='message.stored' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    const before = snapshot(f.db);
    const rejected = await actorRequest(owner, 'POST', endpoint(f.groupId, '/messages'),
        { body:envelope(owner, f.groupId, 'audit-failure', 'Group Owner') });
    assert.deepEqual([rejected.status, rejected.body.code], [500, 'INTERNAL_ERROR']);
    assert.deepEqual(changedTables(before, snapshot(f.db)), []);
});

test('T-5D-05 G18/G20/G21: history cursor, permitted single reads, sender tombstone and uniform 404', async t => {
    const f = await fixture(t);
    const owner = f.actors.owner;
    const posted = [];
    for (let i=0;i<3;i++) {
        const response = await actorRequest(owner, 'POST', endpoint(f.groupId, '/messages'),
            { body:envelope(owner, f.groupId, `history-${i}`, 'Group Owner') });
        assert.equal(response.status, 201);
        posted.push(response.body.message);
        f.clock.advance(1000);
    }
    const page = await actorRequest(f.actors.member, 'GET', endpoint(f.groupId, '/messages?limit=2'));
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.items.map(item => item.sequence), [3,2]);
    assert.ok(page.body.nextCursor);
    const next = await actorRequest(f.actors.member, 'GET', endpoint(f.groupId, `/messages?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`));
    assert.deepEqual(next.body.items.map(item => item.sequence), [1]);
    const single = await actorRequest(f.actors.member, 'GET', endpoint(f.groupId, `/messages/${posted[0].storageId}`));
    assert.deepEqual(single.body.message, posted[0]);
    const removedByOther = await actorRequest(f.actors.member, 'DELETE', endpoint(f.groupId, `/messages/${posted[0].storageId}`));
    assert.deepEqual([removedByOther.status, removedByOther.body.code], [403, 'FORBIDDEN']);
    const tombstone = await actorRequest(owner, 'DELETE', endpoint(f.groupId, `/messages/${posted[0].storageId}`));
    assert.deepEqual([tombstone.status, tombstone.body.message.state], [200, 'deleted']);
    const repeated = await actorRequest(owner, 'DELETE', endpoint(f.groupId, `/messages/${posted[0].storageId}`));
    assert.deepEqual(repeated.body, tombstone.body);
    for (const actor of [f.actors.nonMember, f.actors.removedMember]) {
        const hidden = await actorRequest(actor, 'GET', endpoint(f.groupId, '/messages'));
        assert.deepEqual([hidden.status, hidden.body.code], [404, 'NOT_FOUND']);
    }
    const badQuery = await actorRequest(f.actors.member, 'GET', endpoint(f.groupId, '/messages?limit=51&unknown=x'));
    assert.deepEqual([badQuery.status, badQuery.body.code], [400, 'VALIDATION_ERROR']);
});

test('T-5D-06/G22-G24: private monotonic read position, receipt deduplication, and G25 remains unavailable', async t => {
    const f = await fixture(t);
    const owner = f.actors.owner, member = f.actors.member;
    const sent = await actorRequest(owner, 'POST', endpoint(f.groupId, '/messages'), { body:envelope(owner, f.groupId, 'receipt-msg', 'Group Owner') });
    const id = sent.body.message.storageId;
    const receipt = await actorRequest(member, 'POST', endpoint(f.groupId, `/messages/${id}/receipts`), { body:{ status:'read' } });
    assert.deepEqual([receipt.status, receipt.body.outcome, receipt.body.receipt.userId], [201, 'created', member.id]);
    const duplicate = await actorRequest(member, 'POST', endpoint(f.groupId, `/messages/${id}/receipts`), { body:{ status:'read' } });
    assert.deepEqual([duplicate.status, duplicate.body.outcome], [200, 'duplicate']);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM MessageReceipts WHERE message_id=? AND user_id=? AND status=\'read\'').get(id, member.id).n, 1);
    const own = await actorRequest(owner, 'POST', endpoint(f.groupId, `/messages/${id}/receipts`), { body:{ status:'delivered' } });
    assert.deepEqual([own.status, own.body.code], [404, 'NOT_FOUND']);
    const setPosition = await actorRequest(member, 'PUT', endpoint(f.groupId, '/read-position'), { body:{ position:1 } });
    assert.deepEqual([setPosition.status, setPosition.body.readPosition], [200, 1]);
    const lower = await actorRequest(member, 'PUT', endpoint(f.groupId, '/read-position'), { body:{ position:0 } });
    assert.equal(lower.body.readPosition, 1);
    const invalid = await actorRequest(member, 'PUT', endpoint(f.groupId, '/read-position'), { body:{ position:2 } });
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'VALIDATION_ERROR']);
    const position = await actorRequest(member, 'GET', endpoint(f.groupId, '/read-position'));
    assert.deepEqual(position.body, { readPosition:1 });
    const receipts = await actorRequest(member, 'GET', endpoint(f.groupId, `/messages/${id}/receipts`));
    assert.deepEqual([receipts.status, receipts.body.code], [503, 'FEATURE_UNAVAILABLE']);
    const hidden = await actorRequest(f.actors.pendingInvitee, 'GET', endpoint(f.groupId, `/messages/${id}/receipts`));
    assert.deepEqual([hidden.status, hidden.body.code], [404, 'NOT_FOUND']);

    const disabled = await fixture(t, { features:disabledMessaging });
    const disabledMember = await actorRequest(disabled.actors.owner, 'GET', endpoint(disabled.groupId, '/messages/unknown/receipts'));
    assert.deepEqual([disabledMember.status, disabledMember.body.code], [503, 'FEATURE_UNAVAILABLE']);
    const disabledOutsider = await actorRequest(disabled.actors.nonMember, 'GET', endpoint(disabled.groupId, '/messages/unknown/receipts'));
    assert.deepEqual([disabledOutsider.status, disabledOutsider.body.code], [404, 'NOT_FOUND']);
    const removed = await actorRequest(disabled.actors.removedMember, 'GET', endpoint(disabled.groupId, '/messages/unknown/receipts'));
    assert.deepEqual([removed.status, removed.body.code], [404, 'NOT_FOUND']);
});

test('T-5D-07 bindStore enforces the same verifier and message authorization boundary', async t => {
    const f = await fixture(t);
    const owner = f.actors.owner;
    const token = owner.browser.cookies.get(f.config.sessionCookie);
    const session = f.application.auth.resolveToken(token).row;
    const context = { userId:session.user_id, sessionId:session.session_id };
    const proof = f.application.auth.csrfProof(token, null, owner.token);
    const store = f.application.groupMessages.bindStore(context, proof);
    const value = envelope(owner, f.groupId, 'bound-store', 'Group Owner');
    const fingerprint = require('../server/messaging/validation').fingerprint(require('../server/messaging/validation').envelope(value, context, f.groupId));
    const result = await store.storeMessage({ envelope:value, fingerprint, receivedAt:new Date(f.clock.now()) });
    assert.equal(result.outcome, 'created');
    assert.deepEqual(await store.findMessage(f.groupId, value.id), { conversationId:f.groupId, messageId:value.id, senderId:owner.id });
    const hidden = f.application.groupMessages.bindStore({ userId:f.actors.nonMember.id,
        sessionId:f.application.auth.resolveToken(f.actors.nonMember.browser.cookies.get(f.config.sessionCookie)).row.session_id }, proof);
    await assert.rejects(() => hidden.findMessage(f.groupId, value.id), error => error instanceof AuthError && error.status === 404);
});

test('T-5D-08..10: routes keep CSRF, message body limit, fixed errors and disabled messaging gate before parsing', async t => {
    const f = await fixture(t);
    const owner = f.actors.owner;
    const withoutCsrf = await actorRequest(owner, 'PUT', endpoint(f.groupId, '/read-position'), { body:{ position:0 }, csrf:false });
    assert.deepEqual([withoutCsrf.status, withoutCsrf.body.code], [403, 'CSRF_INVALID']);
    const tooLarge = await actorRequest(owner, 'POST', endpoint(f.groupId, '/messages'),
        { rawBody:JSON.stringify({ x:'x'.repeat(MAX_BODY) }), headers:{ 'Content-Type':'application/json' } });
    assert.deepEqual([tooLarge.status, tooLarge.body.code], [413, 'PAYLOAD_TOO_LARGE']);
    assert.ok(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n === 0);
});

test('T-5D-11 P-16: generated duplicate submissions preserve the stored message across intervening writes and revisions', async t => {
    const property = await forAll('P-16-group-message-idempotency', { runs:30, seed:0x5d160016 },
        random => {
            const idLength = random.bool() ? 1 : 256;
            return { rosterSize:random.int(2,5), idLength,
                id:random.string('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_', idLength, idLength) };
        }, async (sample, info) => {
            // Use lengths chosen explicitly at the boundaries; the generated string remains the only id source.
            const clientId = sample.id;
            const f = await fixture(t);
            const owner = f.actors.owner;
            const candidates = [f.actors.admin, f.actors.member, f.actors.pendingInvitee, f.actors.nonMember];
            const id = f.builder.createGroup({ ownerId:owner.id, title:`P16 ${info.run}`, historyPolicy:'from_joined', idempotencyKey:`p16-${info.run}` });
            const members = [owner];
            for (const actor of candidates.slice(0, sample.rosterSize - 1)) {
                f.builder.addMember(id, actor.id);
                members.push(actor);
            }
            const sender = members[0];
            const body = envelope(sender, id, clientId, 'Group Owner');
            const created = await actorRequest(sender, 'POST', endpoint(id, '/messages'), { body });
            assert.equal(created.status, 201, info.line);
            const firstSnapshot = snapshot(f.db);
            const replay = await actorRequest(sender, 'POST', endpoint(id, '/messages'), { body });
            assert.deepEqual([replay.status,replay.body.outcome,replay.body.message], [200,'duplicate',created.body.message], info.line);
            assert.deepEqual(changedTables(firstSnapshot, snapshot(f.db)), [], `${info.line}: exact replay changed persistent state`);

            const secondSender = members[1];
            const other = await actorRequest(secondSender, 'POST', endpoint(id, '/messages'),
                { body:envelope(secondSender, id, `other-${info.run}`, secondSender.actorClass === 'admin' ? 'Group Admin' : 'Group Member') });
            assert.equal(other.status, 201, info.line);
            f.builder.addMember(id, f.actors.removedMember.id);
            const afterRevisionChange = snapshot(f.db);
            const timestampBeforeRevisionReplay = f.db.prepare('SELECT updated_at FROM Conversations WHERE conversation_id=?').get(id).updated_at;
            const afterRevisionReplay = await actorRequest(sender, 'POST', endpoint(id, '/messages'), { body });
            assert.deepEqual([afterRevisionReplay.status,afterRevisionReplay.body.outcome], [200,'duplicate'], info.line);
            assert.deepEqual(changedTables(afterRevisionChange, snapshot(f.db)), [], `${info.line}: revision replay changed persistent state`);
            assert.equal(f.db.prepare('SELECT updated_at FROM Conversations WHERE conversation_id=?').get(id).updated_at, timestampBeforeRevisionReplay,
                `${info.line}: duplicate altered the conversation timestamp`);

            const wrongSender = envelope(secondSender, id, clientId, secondSender.actorClass === 'admin' ? 'Group Admin' : 'Group Member');
            const conflictBySenderBefore = snapshot(f.db);
            const senderConflict = await actorRequest(secondSender, 'POST', endpoint(id, '/messages'), { body:wrongSender });
            assert.deepEqual([senderConflict.status,senderConflict.body.code], [409,'IDEMPOTENCY_CONFLICT'], info.line);
            assert.deepEqual(changedTables(conflictBySenderBefore, snapshot(f.db)), [], `${info.line}: sender conflict changed persistent state`);

            const changedFingerprint = { ...body, timestamp:'2026-01-02T00:00:00.000Z' };
            const conflictByFingerprintBefore = snapshot(f.db);
            const fingerprintConflict = await actorRequest(sender, 'POST', endpoint(id, '/messages'), { body:changedFingerprint });
            assert.deepEqual([fingerprintConflict.status,fingerprintConflict.body.code], [409,'IDEMPOTENCY_CONFLICT'], info.line);
            assert.deepEqual(changedTables(conflictByFingerprintBefore, snapshot(f.db)), [], `${info.line}: fingerprint conflict changed persistent state`);
        });
    t.diagnostic(`P-16 property=${property.property} seed=${property.seed} runs=${property.runs}`);
});

test('T-5D-13 P-18: generated read positions are monotonic and unread counts follow membership intervals', { timeout:240000 }, async t => {
    const f = await fixture(t);
    const property = await forAll('P-18-group-read-state', { runs:30, seed:0x5d180018, onRun:line=>t.diagnostic(line),
        describe:sample=>`policy=${sample.policy},reports=${sample.reportCount},pre=${sample.preCount},active=${sample.activeCount},gap=${sample.gapCount},rejoin=${sample.rejoinCount}` },
        random => ({ policy:random.pick(['all','from_joined']), reportCount:random.int(1,30),
            preCount:random.int(1,3), activeCount:random.int(1,3), gapCount:random.int(1,3), rejoinCount:random.int(1,3) }),
        async (sample, info) => {
            const owner=f.actors.owner, reader=f.actors.member, admin=f.actors.admin;
            const id=f.builder.createGroup({ownerId:owner.id,title:`P18 ${info.run}`,historyPolicy:sample.policy,
                idempotencyKey:`p18-${info.run}`});
            const events=[];let nextSequence=0;
            async function send(actor,label){
                const result=await actorRequest(actor,'POST',endpoint(id,'/messages'),
                    {body:envelope(actor,id,`p18-${info.run}-${label}`,actor.actorClass==='admin'?'Group Admin':'Group Owner')});
                assert.equal(result.status,201,`${info.line}: ${label} send`);
                nextSequence++;
                assert.equal(result.body.message.sequence,nextSequence,`${info.line}: independent sequence oracle`);
                const event={sequence:nextSequence,storageId:result.body.message.storageId,senderId:actor.id,deleted:false,phase:label};
                events.push(event);return event;
            }
            for(let index=0;index<sample.preCount;index++)await send(owner,`pre-${index}`);
            const preJoinEnd=nextSequence;
            f.builder.addMember(id,reader.id);
            f.builder.addMember(id,admin.id,{role:'admin'});
            const permittedSequences=[];
            if(sample.policy==='all')for(let sequence=1;sequence<=preJoinEnd;sequence++)permittedSequences.push(sequence);
            for(let index=0;index<sample.activeCount;index++){
                const event=await send(index%2?admin:owner,`active-${index}`);permittedSequences.push(event.sequence);
            }
            const firstIntervalEnd=nextSequence;
            const removal=await actorRequest(owner,'DELETE',endpoint(id,`/members/${reader.id}`));
            assert.equal(removal.status,204,`${info.line}: interval closes`);
            for(let index=0;index<sample.gapCount;index++)await send(index%2?admin:owner,`gap-${index}`);
            const gapStart=firstIntervalEnd+1,gapEnd=nextSequence;
            f.clock.advance(1000); // New invitations must be strictly later than the removed member's left_at.
            const invitation=f.builder.invite(id,owner.id,reader.id);
            const accepted=await actorRequest(reader,'POST',`/api/groups/invitations/${invitation}/accept`);
            assert.equal(accepted.status,200,`${info.line}: rejoin through invitation (${JSON.stringify(accepted.body)})`);
            for(let index=0;index<sample.rejoinCount;index++){
                const event=await send(index%2?admin:owner,`rejoin-${index}`);permittedSequences.push(event.sequence);
            }
            const highWater=nextSequence;
            const invalidSequence=gapStart<=gapEnd?gapStart:highWater+1;

            // Tombstone one permitted message when possible; unread calculations must exclude it.
            const tombstoneTarget=events.find(event=>permittedSequences.includes(event.sequence)&&event.senderId!==reader.id);
            if(tombstoneTarget){
                const response=await actorRequest(owner,'DELETE',endpoint(id,`/messages/${tombstoneTarget.storageId}`));
                assert.equal(response.status,200,`${info.line}: permitted message tombstone`);tombstoneTarget.deleted=true;
            }

            const readPositions=new Set([0,...permittedSequences]);
            const validPositions=[...readPositions].sort((a,b)=>a-b);
            const secondConnection={...reader,browser:reader.browser.clone()};
            let expectedPosition=0;
            for(let index=0;index<sample.reportCount;index++){
                const invalid=index===1||index>1&&info.random.bool(0.22);
                const actor=index%2===0?reader:secondConnection;
                const requestPosition=invalid?(info.random.bool()?invalidSequence:highWater+1):info.random.pick(validPositions);
                const before=snapshot(f.db);
                const response=await actorRequest(actor,'PUT',endpoint(id,'/read-position'),{body:{position:requestPosition}});
                if(invalid){
                    assert.deepEqual([response.status,response.body.code],[400,'VALIDATION_ERROR'],`${info.line}: invalid report ${index}`);
                    assert.deepEqual(changedTables(before,snapshot(f.db)),[],`${info.line}: invalid report changed state`);
                    continue;
                }
                assert.equal(response.status,200,`${info.line}: valid report ${index}`);
                expectedPosition=Math.max(expectedPosition,requestPosition);
                assert.equal(response.body.readPosition,expectedPosition,`${info.line}: monotonic response`);
                assert.equal(f.db.prepare('SELECT position FROM GroupReadPositions WHERE conversation_id=? AND user_id=?').get(id,reader.id).position,
                    expectedPosition,`${info.line}: persisted read position`);
                const repeatedBefore=snapshot(f.db);
                const repeated=await actorRequest(actor,'PUT',endpoint(id,'/read-position'),{body:{position:requestPosition}});
                assert.deepEqual([repeated.status,repeated.body.readPosition],[200,expectedPosition],`${info.line}: repeat response`);
                assert.deepEqual(changedTables(repeatedBefore,snapshot(f.db)),[],`${info.line}: repeated report changed state`);
            }

            const permitted=event=>sample.policy==='all'&&event.sequence<=preJoinEnd
                ||event.phase.startsWith('active-')||event.phase.startsWith('rejoin-');
            const expectedUnread=events.filter(event=>permitted(event)&&!event.deleted&&event.senderId!==reader.id
                &&event.sequence>expectedPosition).length;
            const listing=await actorRequest(reader,'GET','/api/groups');
            assert.equal(listing.status,200,`${info.line}: group list`);
            assert.equal(listing.body.items.find(item=>item.id===id)?.unreadCount,expectedUnread,`${info.line}: independent unread oracle`);

            const receiptCandidates=events.filter(event=>permitted(event)&&!event.deleted&&event.senderId!==reader.id);
            for(const event of receiptCandidates.slice(0,2)){
                const status=info.random.pick(['read','delivered']);
                const first=await actorRequest(reader,'POST',endpoint(id,`/messages/${event.storageId}/receipts`),{body:{status}});
                assert.deepEqual([first.status,first.body.outcome],[201,'created'],`${info.line}: permitted receipt`);
                const duplicateBefore=snapshot(f.db);
                const duplicate=await actorRequest(secondConnection,'POST',endpoint(id,`/messages/${event.storageId}/receipts`),{body:{status}});
                assert.deepEqual([duplicate.status,duplicate.body.outcome],[200,'duplicate'],`${info.line}: receipt repeat`);
                assert.deepEqual(changedTables(duplicateBefore,snapshot(f.db)),[],`${info.line}: duplicate receipt changed state`);
            }
            const gapMessage=events.find(event=>event.sequence===gapStart);
            const receiptBefore=snapshot(f.db);
            const hiddenReceipt=await actorRequest(reader,'POST',endpoint(id,`/messages/${gapMessage.storageId}/receipts`),{body:{status:'read'}});
            assert.deepEqual([hiddenReceipt.status,hiddenReceipt.body.code],[404,'NOT_FOUND'],`${info.line}: gap receipt hidden`);
            assert.deepEqual(changedTables(receiptBefore,snapshot(f.db)),[],`${info.line}: hidden receipt changed state`);
            const violations=f.db.prepare(`SELECT count(*) AS n FROM MessageReceipts receipt JOIN Messages message USING(message_id)
                WHERE receipt.conversation_id=? AND (receipt.user_id<>? OR receipt.user_id=message.sender_id
                    OR NOT (${sample.policy==='all'?'message.message_seq <= ? OR ':''}EXISTS(
                        SELECT 1 FROM GroupMembershipIntervals period WHERE period.conversation_id=receipt.conversation_id
                            AND period.user_id=receipt.user_id AND message.message_seq>=period.first_seq
                            AND (period.last_seq IS NULL OR message.message_seq<=period.last_seq))))`)
                .get(...(sample.policy==='all'?[id,reader.id,preJoinEnd]:[id,reader.id])).n;
            assert.equal(violations,0,`${info.line}: every receipt is for an authorized other-sender message`);
            const receiptCounts=f.db.prepare(`SELECT count(*) AS total,count(DISTINCT message_id||':'||user_id||':'||status) AS unique_count
                FROM MessageReceipts WHERE conversation_id=?`).get(id);
            assert.equal(receiptCounts.total,receiptCounts.unique_count,`${info.line}: at most one receipt per message, observer and status`);
        });
    t.diagnostic(`P-18 property=${property.property} seed=${property.seed} runs=${property.runs} reports=1..30 two connections policies=all/from_joined rejoin=invitation`);
});
