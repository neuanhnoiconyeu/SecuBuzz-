const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,temporary,direct,encrypted}=require('./support/database');const {loadMigrations,migrate}=require('../server/database/migrate');
test('migration 10 preserves existing envelopes, pins, reactions and all security triggers',t=>{
    const {db,repositories}=fixture(t,{migrate:false}),directory=temporary(t);
    for(const m of loadMigrations().filter(m=>m.version<=9))fs.writeFileSync(path.join(directory,m.name),m.sql);
    migrate(db,{directory});direct(repositories);repositories.messages.insert(encrypted());
    const rows=db.prepare('SELECT * FROM Messages').all(),triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    const columns=db.prepare('PRAGMA table_info(Attachments)').all(),fks=db.prepare('PRAGMA foreign_key_list(Attachments)').all();
    assert.deepEqual(migrate(db).applied,['0010-encrypted-attachments.sql','0011-encrypted-message-revisions.sql','0012-groups.sql']);
    assert.deepEqual(db.prepare('SELECT * FROM Messages').all(),rows);
    assert.deepEqual(db.prepare('PRAGMA table_info(Attachments)').all().slice(0,columns.length),columns);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(Attachments)').all(),fks);
    for(const trigger of triggers)assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger.name),trigger);
    assert.throws(()=>db.prepare("UPDATE Messages SET ciphertext='changed'").run(),/message_envelope_immutable/);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.deepEqual(migrate(db).applied,[]);
});
