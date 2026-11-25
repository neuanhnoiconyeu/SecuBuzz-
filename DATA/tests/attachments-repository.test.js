'use strict';

// T-6B-04: direct SQL checks for the additive 0009 attachment lifecycle schema.
// Every fixture is a fresh disposable SQLite file under os.tmpdir(); no application database or Docker volume is opened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./support/database');

const AT = '2026-01-01T00:00:00.000Z';
const DIGEST = 'a'.repeat(64);
function attachmentFixture(t) {
    const { db } = fixture(t);
    const user = db.prepare('INSERT INTO Users(user_id,username,display_name) VALUES(?,?,?)');
    for (const id of ['a','b','c']) user.run(id, `attachment-${id}`, `Attachment ${id}`);
    db.prepare(`INSERT INTO Conversations(conversation_id,kind,dm_user_low,dm_user_high,created_at,updated_at)
        VALUES('ab','direct','a','b',?,?),('ac','direct','a','c',?,?)`).run(AT,AT,AT,AT);
    const member = db.prepare('INSERT INTO ConversationMembers(conversation_id,user_id,role,joined_at) VALUES(?,?,\'member\',?)');
    for (const [conversation, id] of [['ab','a'],['ab','b'],['ac','a'],['ac','c']]) member.run(conversation,id,AT);
    const message = db.prepare(`INSERT INTO Messages(message_id,conversation_id,sender_id,receiver_id,ciphertext,iv,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`);
    message.run('a-ab','ab','a','b','opaque','iv',AT,AT);
    message.run('b-ab','ab','b','a','opaque','iv',AT,AT);
    message.run('a-ac','ac','a','c','opaque','iv',AT,AT);
    return db;
}
function addAttachment(db, id, { conversation='ab', uploader='a', status='pending', messageId=null, deletedAt=null, purgeState='not_purged' }={}) {
    db.prepare(`INSERT INTO Attachments(attachment_id,conversation_id,message_id,uploaded_by,storage_key,encrypted_metadata,media_type,
        byte_size,status,created_at,updated_at,expires_at,deleted_at,purge_state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,conversation,messageId,uploader,`key-${id}`,'ciphertext','application/octet-stream',10,
        status,AT,AT,AT,deletedAt,purgeState);
}
function unchangedAfterRefusal(db, id, work) {
    const before = db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(id);
    assert.throws(work);
    assert.deepEqual(db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(id), before);
}

test('0009 rejects direct changes to every immutable attachment field and preserves the row', t => {
    const db = attachmentFixture(t); addAttachment(db,'immutable');
    const attempts = [
        ['attachment_id=?',['changed']], ['conversation_id=?',['ac']], ['uploaded_by=?',['b']], ['storage_key=?',['other-key']],
        ['byte_size=?',[11]], ['created_at=?',['2026-02-01T00:00:00.000Z']], ['integrity_digest=?',[DIGEST]],
        ['declared_algorithm=?',['AES-256-GCM']], ['declared_format_version=?',['v1']], ['encrypted_metadata=?',['other-ciphertext']],
        ['media_type=?',['image/png']],
    ];
    for (const [assignment, values] of attempts) unchangedAfterRefusal(db,'immutable',() =>
        db.prepare(`UPDATE Attachments SET ${assignment} WHERE attachment_id='immutable'`).run(...values));
});

test('0009 permits only the three specified attachment status transitions and requires a ready message', t => {
    const db = attachmentFixture(t); addAttachment(db,'pending'); addAttachment(db,'ready-without-message',{status:'ready'});
    unchangedAfterRefusal(db,'pending',() => db.prepare("UPDATE Attachments SET status='ready' WHERE attachment_id='pending'").run());
    unchangedAfterRefusal(db,'ready-without-message',() => db.prepare("UPDATE Attachments SET status='pending' WHERE attachment_id='ready-without-message'").run());

    addAttachment(db,'pending-to-ready');
    db.prepare("UPDATE Attachments SET status='ready',message_id='a-ab' WHERE attachment_id='pending-to-ready'").run();
    assert.deepEqual(db.prepare("SELECT status,message_id FROM Attachments WHERE attachment_id='pending-to-ready'").get(),{status:'ready',message_id:'a-ab'});

    addAttachment(db,'pending-to-deleted');
    db.prepare("UPDATE Attachments SET status='deleted',deleted_at='2026-01-02T00:00:00.000Z' WHERE attachment_id='pending-to-deleted'").run();
    assert.equal(db.prepare("SELECT status FROM Attachments WHERE attachment_id='pending-to-deleted'").get().status,'deleted');

    addAttachment(db,'ready-to-deleted');
    db.prepare("UPDATE Attachments SET status='ready',message_id='a-ab' WHERE attachment_id='ready-to-deleted'").run();
    db.prepare("UPDATE Attachments SET status='deleted',deleted_at='2026-01-02T00:00:00.000Z' WHERE attachment_id='ready-to-deleted'").run();
    assert.equal(db.prepare("SELECT status FROM Attachments WHERE attachment_id='ready-to-deleted'").get().status,'deleted');
});

test('0009 rejects invalid message association, sender, conversation, deletion-time and purge transitions atomically', t => {
    const db = attachmentFixture(t);
    addAttachment(db,'wrong-sender');
    unchangedAfterRefusal(db,'wrong-sender',() => db.prepare("UPDATE Attachments SET status='ready',message_id='b-ab' WHERE attachment_id='wrong-sender'").run());
    addAttachment(db,'wrong-conversation',{conversation:'ac'});
    unchangedAfterRefusal(db,'wrong-conversation',() => db.prepare("UPDATE Attachments SET status='ready',message_id='a-ab' WHERE attachment_id='wrong-conversation'").run());
    addAttachment(db,'message-change',{status:'ready',messageId:'a-ab'});
    unchangedAfterRefusal(db,'message-change',() => db.prepare("UPDATE Attachments SET message_id='b-ab' WHERE attachment_id='message-change'").run());
    addAttachment(db,'delete-without-time');
    unchangedAfterRefusal(db,'delete-without-time',() => db.prepare("UPDATE Attachments SET status='deleted' WHERE attachment_id='delete-without-time'").run());
    addAttachment(db,'time-without-delete');
    unchangedAfterRefusal(db,'time-without-delete',() => db.prepare("UPDATE Attachments SET deleted_at='2026-01-02T00:00:00.000Z' WHERE attachment_id='time-without-delete'").run());
    addAttachment(db,'purge-active');
    unchangedAfterRefusal(db,'purge-active',() => db.prepare("UPDATE Attachments SET purge_state='purged' WHERE attachment_id='purge-active'").run());
    addAttachment(db,'deleted',{status:'deleted',deletedAt:'2026-01-02T00:00:00.000Z'});
    for (const [sql, values] of [
        ["UPDATE Attachments SET status='ready' WHERE attachment_id=?",['deleted']],
        ["UPDATE Attachments SET deleted_at='2026-01-03T00:00:00.000Z' WHERE attachment_id=?",['deleted']],
        ["UPDATE Attachments SET message_id='a-ab' WHERE attachment_id=?",['deleted']],
    ]) unchangedAfterRefusal(db,'deleted',() => db.prepare(sql).run(...values));
    db.prepare("UPDATE Attachments SET purge_state='purged' WHERE attachment_id='deleted'").run();
    assert.equal(db.prepare("SELECT purge_state FROM Attachments WHERE attachment_id='deleted'").get().purge_state,'purged');
    unchangedAfterRefusal(db,'deleted',() => db.prepare("UPDATE Attachments SET purge_state='not_purged' WHERE attachment_id='deleted'").run());
});

test('0009 caps encrypted metadata and enforces reservation foreign keys and field checks', t => {
    const db = attachmentFixture(t);
    const before = db.prepare('SELECT count(*) AS n FROM Attachments').get().n;
    assert.throws(() => db.prepare(`INSERT INTO Attachments(attachment_id,conversation_id,uploaded_by,storage_key,byte_size,encrypted_metadata)
        VALUES('oversized','ab','a','oversized-key',1,?)`).run('x'.repeat(16385)));
    assert.equal(db.prepare('SELECT count(*) AS n FROM Attachments').get().n,before);
    const insert = db.prepare(`INSERT INTO AttachmentReservations(reservation_id,user_id,conversation_id,declared_bytes,source_digest,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?)`);
    const valid = ['r','a','ab',1,DIGEST,AT,AT];
    for (const values of [['missing-user','missing','ab',1,DIGEST,AT,AT],['missing-conversation','a','missing',1,DIGEST,AT,AT],
        ['bad-digest','a','ab',1,'z'.repeat(64),AT,AT],['zero-bytes','a','ab',0,DIGEST,AT,AT]]) {
        const count = db.prepare('SELECT count(*) AS n FROM AttachmentReservations').get().n;
        assert.throws(() => insert.run(...values));
        assert.equal(db.prepare('SELECT count(*) AS n FROM AttachmentReservations').get().n,count);
    }
    insert.run(...valid);
    assert.deepEqual(db.prepare('SELECT user_id,conversation_id,declared_bytes,source_digest FROM AttachmentReservations WHERE reservation_id=?').get('r'),
        {user_id:'a',conversation_id:'ab',declared_bytes:1,source_digest:DIGEST});
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

test('0009 rejects every actual value change after deletion except the isolated purge-state advance', t => {
    const db = attachmentFixture(t); addAttachment(db,'terminal');
    db.prepare("UPDATE Attachments SET status='deleted',deleted_at='2026-01-02T00:00:00.000Z' WHERE attachment_id='terminal'").run();
    for (const [column, value] of [['expires_at','2026-03-01T00:00:00.000Z'],['updated_at','2026-02-01T00:00:00.000Z'],
        ['encrypted_metadata','changed'],['byte_size',11],['media_type','image/png']]) {
        unchangedAfterRefusal(db,'terminal',() => db.prepare(`UPDATE Attachments SET ${column}=? WHERE attachment_id='terminal'`).run(value));
    }
    unchangedAfterRefusal(db,'terminal',() => db.prepare("UPDATE Attachments SET purge_state='purged',expires_at='2026-03-01T00:00:00.000Z' WHERE attachment_id='terminal'").run());
    db.prepare("UPDATE Attachments SET purge_state='purged' WHERE attachment_id='terminal'").run();
    assert.equal(db.prepare("SELECT purge_state FROM Attachments WHERE attachment_id='terminal'").get().purge_state,'purged');
});test('T-6B-18 reads attachment state, usage, reservation usage and bounded lifecycle queues through indexes', t => {
    const db = attachmentFixture(t);
    const { createAttachmentRepository } = require('../server/database/attachmentRepository');
    const repository = createAttachmentRepository(db);
    const pending = input => repository.insertPending(input);
    const write = work => db.transaction(work).immediate();
    const pendingInput = (id, extra = {}) => ({
        attachment_id:id, conversation_id:'ab', uploaded_by:'a', storage_key:`${id}`.padEnd(48,'a').slice(0,48),
        encrypted_metadata:'opaque-encrypted-metadata', byte_size:20, expires_at:'2026-02-01T00:00:00.000Z',
        integrity_digest:DIGEST, declared_algorithm:'AES-256-GCM', declared_format_version:'1', ...extra
    });
    assert.equal(repository.getById('missing'), null);
    assert.equal(repository.usageForUser('a'), 0);
    assert.equal(repository.usageForConversation('ab'), 0);
    assert.equal(repository.pendingCountForUser('a'), 0);

    write(() => pending(pendingInput('pending')));
    write(() => pending(pendingInput('ready', { byte_size:30 })));
    write(() => repository.associate(['ready'], 'a-ab', AT));
    write(() => pending(pendingInput('deleted', { byte_size:300 })));
    write(() => repository.markDeleted('deleted', '2026-01-02T00:00:00.000Z'));
    write(() => pending(pendingInput('other-user', { uploaded_by:'b', byte_size:5 })));
    assert.equal(repository.getById('pending').status, 'pending');
    assert.equal(repository.usageForUser('a'), 50);
    assert.equal(repository.usageForConversation('ab'), 55);
    assert.equal(repository.pendingCountForUser('a'), 1);

    const expiry = '2026-01-01T00:00:00.000Z';
    write(() => repository.insertReservation({ reservation_id:'live-a', user_id:'a', conversation_id:'ab', declared_bytes:4,
        source_digest:DIGEST, created_at:AT, expires_at:'2026-01-02T00:00:00.000Z' }));
    write(() => repository.insertReservation({ reservation_id:'live-b', user_id:'a', conversation_id:'ac', declared_bytes:6,
        source_digest:'b'.repeat(64), created_at:AT, expires_at:'2026-01-02T00:00:00.000Z' }));
    write(() => repository.insertReservation({ reservation_id:'expired', user_id:'b', conversation_id:'ab', declared_bytes:8,
        source_digest:DIGEST, created_at:AT, expires_at:AT }));
    assert.deepEqual(repository.reservationUsage(expiry), {
        byUser:[{user_id:'a',bytes:10,count:2}],
        byConversation:[{conversation_id:'ab',bytes:4,count:1},{conversation_id:'ac',bytes:6,count:1}],
        bySourceDigest:[{source_digest:DIGEST,count:1},{source_digest:'b'.repeat(64),count:1}]
    });
    assert.deepEqual(repository.listExpiredReservations(AT, 5).map(row => row.reservation_id), ['expired']);
    assert.equal(write(() => repository.deleteExpiredReservations(AT)).changes, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM AttachmentReservations WHERE reservation_id=?').get('expired').n, 0);
    assert.deepEqual(write(() => repository.deleteReservation('live-a')), {reservation_id:'live-a'});
    write(() => repository.insertReservation({ reservation_id:'expired-once', user_id:'b', conversation_id:'ab', declared_bytes:2,
        source_digest:DIGEST, created_at:AT, expires_at:AT }));
    assert.deepEqual(write(() => repository.deleteExpiredReservation('expired-once',AT)),{reservation_id:'expired-once'});
    assert.equal(write(() => repository.deleteExpiredReservation('expired-once',AT)),null,'replay releases a reservation only once');
    assert.equal(write(() => repository.deleteExpiredReservation('live-b',AT)),null,'a future reservation is not released early');

    write(() => pending(pendingInput('expired-pending', { expires_at:AT })));
    assert.deepEqual(repository.listExpiredPending(AT, 1).map(row => row.attachment_id), ['expired-pending']);
    write(() => repository.markDeleted('expired-pending', '2026-01-02T00:00:00.000Z'));
    assert.deepEqual(repository.listPurgeCandidates('2026-01-02T00:00:00.000Z', 2).map(row => row.attachment_id), ['deleted','expired-pending']);
    write(() => repository.markPurged('deleted'));
    assert.deepEqual(repository.listPurgeCandidates('2026-01-02T00:00:00.000Z', 2).map(row => row.attachment_id), ['expired-pending']);

    const plan = (sql, value) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(value).map(row => row.detail).join(' ');
    const plans = [
        [plan("SELECT sum(byte_size) FROM Attachments WHERE uploaded_by=? AND status IN ('pending','ready')", 'a'), 'idx_attachments_uploader_usage'],
        [plan("SELECT sum(byte_size) FROM Attachments WHERE conversation_id=? AND status IN ('pending','ready')", 'ab'), 'idx_attachments_conversation'],
        [plan("SELECT count(*) FROM Attachments WHERE uploaded_by=? AND status='pending'", 'a'), 'idx_attachments_uploader_usage'],
        [plan("SELECT * FROM Attachments WHERE status='pending' AND expires_at<=? ORDER BY expires_at,attachment_id LIMIT ?", [AT,5]), 'idx_attachments_pending_expiry'],
        [plan("SELECT * FROM Attachments WHERE status='deleted' AND purge_state='not_purged' AND deleted_at<=? ORDER BY deleted_at,attachment_id LIMIT ?", [AT,5]), 'idx_attachments_purge'],
        [plan('SELECT * FROM AttachmentReservations WHERE expires_at<=? ORDER BY expires_at,reservation_id LIMIT ?', [AT,5]), 'idx_reservations_expiry'],
        [plan('SELECT user_id,sum(declared_bytes),count(*) FROM AttachmentReservations WHERE expires_at>? GROUP BY user_id', AT), 'idx_reservations_user'],
        [plan('SELECT conversation_id,sum(declared_bytes) FROM AttachmentReservations WHERE expires_at>? GROUP BY conversation_id', AT), 'idx_reservations_conversation'],
        [plan('SELECT source_digest,count(*) FROM AttachmentReservations WHERE expires_at>? GROUP BY source_digest', AT), 'idx_reservations_source']
    ];
    for (const [detail, index] of plans) {
        assert.ok(detail.includes(index), `${index}: ${detail}`);
        if (detail.includes('Attachments')) assert.doesNotMatch(detail,/SCAN Attachments(?:\s|$)/,`full attachment scan: ${detail}`);
    }
});

test('T-6B-19 attachment writes require a transaction, use compare-and-set and roll back as a unit', t => {
    const db = attachmentFixture(t);
    const { createAttachmentRepository } = require('../server/database/attachmentRepository');
    const repository = createAttachmentRepository(db);
    const pendingInput = id => ({ attachment_id:id, conversation_id:'ab', uploaded_by:'a', storage_key:id.padEnd(48,'a'),
        encrypted_metadata:'encrypted', byte_size:10, expires_at:'2026-02-01T00:00:00.000Z', integrity_digest:DIGEST,
        declared_algorithm:'AES-256-GCM', declared_format_version:'1' });
    for (const method of ['insertReservation','deleteReservation','deleteExpiredReservation','deleteExpiredReservations','insertPending','associate','markDeleted','markPurged']) {
        assert.throws(() => repository[method](), TypeError, method);
    }
    assert.throws(() => repository.insertPending(), TypeError, 'write guard runs before input validation');
    assert.throws(() => db.transaction(() => repository.insertPending({ ...pendingInput('bad'), media_type:'image/png' })).immediate(), error => error.code === 'INVALID');
    assert.throws(() => db.transaction(() => {
        repository.insertPending(pendingInput('rollback'));
        repository.insertReservation({ reservation_id:'rollback-r', user_id:'a', conversation_id:'ab', declared_bytes:10,
            source_digest:DIGEST, created_at:AT, expires_at:'2026-02-01T00:00:00.000Z' });
        throw new Error('rollback');
    }).immediate(), /rollback/);
    assert.equal(repository.getById('rollback'), null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM AttachmentReservations WHERE reservation_id=?').get('rollback-r').n, 0);

    db.transaction(() => {
        repository.insertPending(pendingInput('first'));
        repository.insertPending(pendingInput('second'));
    }).immediate();
    assert.throws(() => db.transaction(() => repository.associate(['first','missing'], 'a-ab', AT)).immediate(), error => error.code === 'CONFLICT');
    assert.equal(repository.getById('first').status, 'pending', 'the successful prefix is rolled back by the repository savepoint');
    const rows = db.transaction(() => repository.associate(['first','second'], 'a-ab', AT)).immediate();
    assert.deepEqual(rows.map(row => row.status), ['ready','ready']);
    const before = repository.getById('first');
    assert.throws(() => db.transaction(() => repository.associate(['first'], 'a-ab', AT)).immediate(), error => error.code === 'CONFLICT');
    assert.deepEqual(repository.getById('first'), before);
    assert.equal(db.transaction(() => repository.markDeleted('first', '2026-01-02T00:00:00.000Z')).immediate().status, 'deleted');
    assert.throws(() => db.transaction(() => repository.markDeleted('first', AT)).immediate(), error => error.code === 'CONFLICT');
    assert.equal(db.transaction(() => repository.markPurged('first')).immediate().purge_state, 'purged');
    assert.throws(() => db.transaction(() => repository.markPurged('first')).immediate(), error => error.code === 'CONFLICT');
});

test('T-6B-20 confines attachment SQL to repository modules and uses fixed prepared SQL', t => {
    const serverRoot = require('node:path').resolve(__dirname, '../server');
    const allowed = new Set(['database/repositories.js','database/attachmentRepository.js']);
    const files = [];
    const visit = directory => {
        for (const entry of require('node:fs').readdirSync(directory, { withFileTypes:true })) {
            const full = require('node:path').join(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'migrations') visit(full);
            } else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
        }
    };
    visit(serverRoot);
    for (const file of files) {
        const relative = require('node:path').relative(serverRoot, file).replace(/\\/g, '/');
        const source = require('node:fs').readFileSync(file, 'utf8');
        if (/\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[\s\S]{0,180}\b(?:Attachments|AttachmentReservations)\b/i.test(source)) {
            assert.ok(allowed.has(relative), `attachment SQL outside approved repositories: ${relative}`);
        }
        if (relative === 'database/attachmentRepository.js') {
            assert.doesNotMatch(source,/UPDATE\s+Attachments\s+SET[^;]*(?:uploaded_by|conversation_id)/is,
                'writes never change uploader or conversation ownership');
            assert.doesNotMatch(source, /\b(?:GroupExtensions|GroupMembershipIntervals|ConversationInvitations|GroupReadPositions|GroupCreationKeys)\b/);
            const prepares = source.match(/\.prepare\s*\(/g) || [];
            const literalPrepares = source.match(/\.prepare\s*\(\s*(['"`])/g) || [];
            assert.equal(literalPrepares.length, prepares.length, 'every prepared statement starts with a fixed SQL literal');
            assert.doesNotMatch(source, /\.prepare\s*\(\s*`[^`]*\$\{/s, 'no prepared SQL interpolates values');
        }
    }
});
