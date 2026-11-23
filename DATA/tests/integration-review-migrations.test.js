const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, temporary } = require('./support/database');
const { migrate, loadMigrations } = require('../server/database/migrate');

function migrationDirectory(t, version, failVersion) {
    const directory = temporary(t);
    for (const m of loadMigrations().filter(m => m.version <= version)) {
        fs.writeFileSync(path.join(directory, m.name), m.sql +
            (m.version === failVersion ? '\nSELECT * FROM deliberately_missing_review_table;' : ''));
    }
    return directory;
}
function seed(f) {
    const r = f.repositories;
    for (const id of ['a', 'b']) r.users.create({ user_id: id, username: `review-${id}`, display_name: id });
    const legacy = r.legacy.saveMessage('a', 'b', 'PRESERVED_CIPHERTEXT', 'PRESERVED_IV');
    r.messages.insertAuthenticated({ message_id: 'review-original', conversation_id: legacy.conversation_id,
        sender_id: 'a', receiver_id: 'b', ciphertext: 'PRESERVED_V1_CIPHERTEXT', iv: 'PRESERVED_V1_IV',
        envelope_version: 1, encoding: 'base64', sender_name: 'a', client_timestamp: '2026-01-01T00:00:00.000Z',
        message_type: 'text', fingerprint: 'a'.repeat(64), client_id: 'review-wire', message_seq: 1,
        created_at: '2026-01-01T00:00:00.000Z' });
    f.db.prepare(`INSERT INTO Attachments(attachment_id,conversation_id,message_id,uploaded_by,storage_key,byte_size)
        VALUES(?,?,?,?,?,?)`).run('review-existing-file', legacy.conversation_id, legacy.message_id, 'a', 'preserved-private-storage-key', 123);
    r.receipts.insert({ conversation_id: legacy.conversation_id, message_id: 'review-original', user_id: 'b',
        status: 'read', observed_at: '2026-01-01T01:00:00.000Z' });
}
function snapshot(db) {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(names.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
}
function preserved(db, rows) {
    for (const [name, expected] of Object.entries(rows)) {
        if (name === 'SchemaMigrations') {
            assert.deepEqual(db.prepare('SELECT * FROM SchemaMigrations WHERE version<=7 ORDER BY version').all(), expected);
        } else if (expected.length) {
            assert.deepEqual(db.prepare(`SELECT ${Object.keys(expected[0]).join(',')} FROM ${name}`).all(), expected);
        } else assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(), expected);
    }
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.throws(() => db.prepare("UPDATE Messages SET ciphertext='overwrite' WHERE message_id='review-original'").run(), /immutable/);
}

test('review: upgrade 7 through 8, 9, 10 and 11 individually preserves existing messages, receipts, attachment references and triggers', t => {
    const f = fixture(t, { migrate: false });
    migrate(f.db, { directory: migrationDirectory(t, 7) });
    seed(f);
    const before = snapshot(f.db);
    const guards = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    for (const version of [8, 9, 10, 11]) {
        const directory = migrationDirectory(t, version);
        assert.equal(migrate(f.db, { directory }).applied.length, 1);
        assert.equal(migrate(f.db, { directory }).version, version);
        assert.deepEqual(migrate(f.db, { directory }).applied, []);
        preserved(f.db, before);
        for (const guard of guards) assert.deepEqual(f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(guard.name), guard);
    }
});

for (const version of [8, 9, 10, 11]) {
    test(`review: failure in migration ${version} rolls the entire 8-11 batch back to 7 and safely recovers`, t => {
        const f = fixture(t, { migrate: false });
        migrate(f.db, { directory: migrationDirectory(t, 7) });
        seed(f);
        const before = snapshot(f.db), schema = f.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
        assert.throws(() => migrate(f.db, { directory: migrationDirectory(t, 11, version) }), { code: 'MIGRATION_FAILED' });
        assert.deepEqual(snapshot(f.db), before);
        assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schema);
        preserved(f.db, before);
        assert.equal(migrate(f.db).applied.length, loadMigrations().length - 7);
        preserved(f.db, before);
        assert.deepEqual(migrate(f.db).applied, []);
    });
}
