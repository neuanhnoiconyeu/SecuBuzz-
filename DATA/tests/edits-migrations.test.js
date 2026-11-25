const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,temporary,direct,encrypted}=require('./support/database'),{loadMigrations,migrate}=require('../server/database/migrate');
test('migration 11 preserves all existing data, schema objects and encryption guards; repeats safely',t=>{
 const {db,repositories}=fixture(t,{migrate:false}),directory=temporary(t);
 for(const m of loadMigrations().filter(m=>m.version<=10))fs.writeFileSync(path.join(directory,m.name),m.sql);
 migrate(db,{directory});direct(repositories);repositories.messages.insert(encrypted());
 const rows=db.prepare('SELECT * FROM Messages').all(),objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
 assert.deepEqual(migrate(db).applied,['0011-encrypted-message-revisions.sql','0012-groups.sql','0013-attachment-lifecycle.sql']);
 assert.deepEqual(db.prepare('SELECT * FROM Messages').all(),rows);
 // 0013 extends the shared Attachments table; every other version-10 object stays byte-identical.
 for(const o of objects)if(o.name!=='Attachments')assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=?').get(o.type,o.name),o);
 assert.throws(()=>db.prepare("UPDATE Messages SET ciphertext='overwrite'").run(),/immutable/);
 assert.deepEqual(migrate(db).applied,[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
test('a failed revision migration rolls back the entire batch without touching existing rows or protection triggers',t=>{
 const {db}=fixture(t,{migrate:false}),directory=temporary(t),migrations=loadMigrations();
 for(const m of migrations.filter(m=>m.version<=10))fs.writeFileSync(path.join(directory,m.name),m.sql);
 migrate(db,{directory});const before=db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
 const revision=migrations.find(m=>m.version===11);fs.writeFileSync(path.join(directory,revision.name),revision.sql+'\nSELECT * FROM deliberately_missing_revision_table;');
 assert.throws(()=>migrate(db,{directory}),e=>e.code==='MIGRATION_FAILED');
 assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(),before);
 assert.equal(db.prepare('SELECT max(version) AS n FROM SchemaMigrations').get().n,10);
 fs.writeFileSync(path.join(directory,revision.name),revision.sql);assert.equal(migrate(db,{directory}).version,11);
});
