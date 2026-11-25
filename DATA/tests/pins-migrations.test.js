const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {fixture,temporary,direct,encrypted}=require('./support/database');
const {loadMigrations,migrate}=require('../server/database/migrate');

test('migration 8 is additive, preserves encrypted rows and original protection triggers, and repeats safely',t=>{
    const {db,repositories}=fixture(t,{migrate:false}),directory=temporary(t);
    for(const m of loadMigrations().filter(m=>m.version<=7))fs.writeFileSync(path.join(directory,m.name),m.sql);
    migrate(db,{directory});direct(repositories);repositories.messages.insert(encrypted());
    const messages=db.prepare('SELECT * FROM Messages').all();
    const protectedObjects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    assert.deepEqual(migrate(db).applied,['0008-authenticated-message-pins.sql','0009-authenticated-message-reactions.sql','0010-encrypted-attachments.sql','0011-encrypted-message-revisions.sql','0012-groups.sql','0013-attachment-lifecycle.sql']);
    assert.deepEqual(db.prepare('SELECT * FROM Messages').all(),messages);
    // Migration 10 adds columns to Attachments; its existing columns/FKs are checked in attachments-migrations.
    for(const object of protectedObjects.filter(o=>o.name!=='Attachments'))assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=? AND type=?').get(object.name,object.type),object);
    for(const table of ['MessagePins','MessagePinOperations','ConversationPinVersions'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
    assert.throws(()=>db.prepare("UPDATE Messages SET ciphertext='changed' WHERE message_id='message'").run(),/message_envelope_immutable/);
    assert.throws(()=>db.prepare("UPDATE Messages SET revision=revision+1 WHERE message_id='message'").run(),/invalid_message_lifecycle/);
    assert.throws(()=>db.prepare("INSERT INTO MessagePins VALUES('dm','message','a','2026-11-21T00:00:00.000Z')").run(),/invalid_message_pin/);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
    assert.deepEqual(migrate(db).applied,[]);
});
