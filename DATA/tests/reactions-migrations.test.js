const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,temporary,direct,encrypted}=require('./support/database');const {loadMigrations,migrate}=require('../server/database/migrate');
test('migration 9 preserves phase 6 and all encrypted storage protections and is repeatable',t=>{
    const {db,repositories}=fixture(t,{migrate:false}),directory=temporary(t);
    for(const m of loadMigrations().filter(m=>m.version<=8))fs.writeFileSync(path.join(directory,m.name),m.sql);
    migrate(db,{directory});direct(repositories);repositories.messages.insert(encrypted());
    const rows=db.prepare('SELECT * FROM Messages').all(),objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    assert.deepEqual(migrate(db).applied,['0009-authenticated-message-reactions.sql','0010-encrypted-attachments.sql','0011-encrypted-message-revisions.sql']);
    assert.deepEqual(db.prepare('SELECT * FROM Messages').all(),rows);
    // Migration 10 adds columns to Attachments; its existing columns/FKs are checked in attachments-migrations.
    for(const object of objects.filter(o=>o.name!=='Attachments'))assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=? AND type=?').get(object.name,object.type),object);
    assert.throws(()=>db.prepare("UPDATE Messages SET ciphertext='changed'").run(),/message_envelope_immutable/);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(migrate(db).applied,[]);
});
