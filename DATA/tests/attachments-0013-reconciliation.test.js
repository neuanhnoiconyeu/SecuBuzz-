'use strict';

// DB-6B migration reconciliation. main owns 0008-0012 and the encrypted attachment
// lifecycle (e2ee_version=1). DB-6B's forward migration is 0013 and its triggers only
// apply to canonical rows (e2ee_version IS NULL).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, temporary, direct } = require('./support/database');
const { loadMigrations, migrate } = require('../server/database/migrate');

const MIGRATIONS = path.join(__dirname, '..', 'server', 'database', 'migrations');

test('fresh database applies main 0008-0012 and DB-6B 0013 with canonical attachment schema', (t) => {
    const { db } = fixture(t);
    const versions = db.prepare('SELECT version FROM SchemaMigrations ORDER BY version').all().map(({ version }) => version);
    assert.deepEqual(versions, [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
    const columns = db.prepare('PRAGMA table_info(Attachments)').all().map(({ name }) => name);
    for (const name of ['expires_at','integrity_digest','deleted_at','purge_state','declared_algorithm','declared_format_version']) {
        assert.ok(columns.includes(name), `Attachments.${name} exists`);
    }
    assert.ok(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='AttachmentReservations'").get());
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('attachments_immutable','attachments_lifecycle','attachments_metadata_insert') ORDER BY name").all();
    assert.deepEqual(triggers.map(({ name }) => name), ['attachments_immutable','attachments_lifecycle','attachments_metadata_insert']);
    for (const trigger of triggers) {
        assert.match(trigger.sql, /WHEN NEW\.e2ee_version IS NULL/, `${trigger.name} is scoped to canonical rows`);
    }
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple:true }), 'ok');
});

test('version 12 to 13 upgrade preserves canonical attachment rows and enforces the lifecycle once', (t) => {
    const { db, repositories } = fixture(t, { migrate:false });
    const directory = temporary(t);
    for (const migration of loadMigrations().filter(({ version }) => version <= 12)) {
        fs.writeFileSync(path.join(directory, migration.name), migration.sql);
    }
    assert.deepEqual(migrate(db, { directory }).applied, [
        '0001-legacy.sql','0002-foundation.sql','0003-authentication.sql','0004-profiles-friends.sql',
        '0005-conversation-provenance.sql','0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql',
        '0008-authenticated-message-pins.sql','0009-authenticated-message-reactions.sql','0010-encrypted-attachments.sql',
        '0011-encrypted-message-revisions.sql','0012-groups.sql'
    ]);
    direct(repositories);
    const inserted = repositories.attachments.insert({
        attachment_id:'pre-0013', conversation_id:'dm', uploaded_by:'a', storage_key:'pre-0013-key',
        encrypted_metadata:'opaque metadata', byte_size:4
    });
    assert.equal(inserted.attachment_id, 'pre-0013');
    const before = db.prepare('SELECT * FROM Attachments').all();
    assert.deepEqual(migrate(db).applied, [
        '0013-attachment-lifecycle.sql','0014-voice-rooms.sql',
        '0015-conversation-customization.sql','0016-customization-retention.sql'
    ]);
    assert.deepEqual(db.prepare('SELECT attachment_id,conversation_id,uploaded_by,storage_key,encrypted_metadata,media_type,byte_size,status FROM Attachments ORDER BY attachment_id').all(),
        before.map(({ attachment_id, conversation_id, uploaded_by, storage_key, encrypted_metadata, media_type, byte_size, status }) =>
            ({ attachment_id, conversation_id, uploaded_by, storage_key, encrypted_metadata, media_type, byte_size, status })));
    const row = db.prepare('SELECT purge_state,deleted_at,integrity_digest,declared_algorithm,declared_format_version FROM Attachments WHERE attachment_id=?').get('pre-0013');
    assert.deepEqual(row, { purge_state:'not_purged', deleted_at:null, integrity_digest:null, declared_algorithm:null, declared_format_version:null });
    db.prepare("UPDATE Attachments SET status='deleted',deleted_at=?,updated_at=? WHERE attachment_id=?").run('2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z','pre-0013');
    assert.throws(() => db.prepare("UPDATE Attachments SET storage_key='changed' WHERE attachment_id=?").run('pre-0013'), /attachment_identity_immutable|invalid_attachment_lifecycle/);
    const encrypted = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='encrypted_attachment_immutable'").get();
    assert.ok(encrypted && /e2ee_version=1/.test(encrypted.sql), "main's encrypted attachment trigger remains in place");
});

test('0013 is idempotent for the runner after a successful apply', (t) => {
    const { db } = fixture(t);
    assert.deepEqual(migrate(db), { version: 16, applied: [] });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
});
