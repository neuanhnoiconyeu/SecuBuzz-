const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {fixture,temporary}=require('./support/database');const {migrate,loadMigrations}=require('../server/database/migrate');const {createRepositories}=require('../server/database/repositories');
const {messagingFixture}=require('./support/messaging');const {encrypted,submit}=require('./support/messaging');
function versionFive(t){const f=fixture(t,{migrate:false});const directory=temporary(t);for(const m of loadMigrations().slice(0,5))fs.writeFileSync(path.join(directory,m.name),m.sql);migrate(f.db,{directory});return f;}

test('DB-4B migration preserves old messages, receipts, identities, metadata and all prior migration checksums',t=>{
    const {db}=versionFive(t);const r=createRepositories(db);for(const id of ['a','b'])r.users.create({user_id:id,username:'older-'+id,display_name:id});
    const message=r.legacy.saveMessage('a','b','ORIGINAL_CIPHERTEXT','ORIGINAL_IV');r.messages.setLegacyStatus(message.message_id,'read');
    const names=['Users','UserProfiles','Conversations','ConversationMembers','Messages','MessageReceipts','Sessions','Friendships','Blocks'];
    const before=Object.fromEntries(names.map(name=>[name,db.prepare(`SELECT * FROM ${name}`).all()])),history=db.prepare('SELECT * FROM SchemaMigrations ORDER BY version').all();
    assert.deepEqual(migrate(db).applied,['0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql','0008-authenticated-message-pins.sql','0009-authenticated-message-reactions.sql','0010-encrypted-attachments.sql','0011-encrypted-message-revisions.sql','0012-groups.sql','0013-voice-rooms.sql','0014-conversation-customization.sql','0015-customization-retention.sql']);for(const [name,rows]of Object.entries(before)){if(rows.length)assert.deepEqual(db.prepare(`SELECT ${Object.keys(rows[0]).join(',')} FROM ${name}`).all(),rows);else assert.equal(db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n,0);}
    assert.equal(db.prepare('SELECT origin FROM Messages').get().origin,'legacy');assert.deepEqual(db.prepare('SELECT * FROM SchemaMigrations WHERE version<=5 ORDER BY version').all(),history);
    assert.deepEqual(migrate(db).applied,[]);assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
});
test('failed DB-4B migration rolls back columns, indexes and ledger without changing existing ciphertext',t=>{
    const {db}=versionFive(t);const r=createRepositories(db);for(const id of ['a','b'])r.users.create({user_id:id,username:'kept-'+id,display_name:id});r.legacy.saveMessage('a','b','KEEP_CIPHERTEXT','IV');
    const directory=temporary(t);for(const m of loadMigrations())fs.writeFileSync(path.join(directory,m.name),m.sql+(m.version===6?'\nINSERT INTO MissingTable VALUES(1);':''));
    assert.throws(()=>migrate(db,{directory}),{code:'MIGRATION_FAILED'});assert.equal(db.prepare('SELECT max(version) AS v FROM SchemaMigrations').get().v,5);
    assert.ok(!db.pragma('table_info(Messages)').some(column=>column.name==='origin'));assert.equal(db.prepare('SELECT ciphertext FROM Messages').get().ciphertext,'KEEP_CIPHERTEXT');
});
test('legacy ciphertext never becomes approved encrypted history through conversation activation alone',async t=>{
    const f=await messagingFixture(t);const r=f.application.messaging.repositories;r.legacy.saveMessage(f.alice.id,f.bob.id,'OLD_OPAQUE_BYTES','OLD_IV');
    const history=await f.bob.browser.request(`/api/conversations/${f.conversationId}/messages`);assert.deepEqual(history.body.items,[]);
    const {envelope}=await encrypted(f.alice,f.conversationId);assert.equal((await submit(f,f.alice,envelope)).status,201);const current=await f.bob.browser.request(`/api/conversations/${f.conversationId}/messages`);
    assert.equal(current.body.items.length,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,2);assert.ok(!current.text.includes('OLD_OPAQUE_BYTES'));
});
test('database uniqueness and immutable ciphertext/sequence guarantees hold beneath service idempotency',async t=>{
    const f=await messagingFixture(t);const {envelope}=await encrypted(f.alice,f.conversationId);await submit(f,f.alice,envelope);const row=f.db.prepare("SELECT * FROM Messages WHERE origin='authenticated'").get();
    assert.throws(()=>f.db.prepare("UPDATE Messages SET ciphertext='changed' WHERE message_id=?").run(row.message_id));
    assert.throws(()=>f.db.prepare('UPDATE Messages SET message_seq=2 WHERE message_id=?').run(row.message_id));
    f.application.messaging.repositories.messages.tombstone(row.message_id,new Date().toISOString());
    assert.throws(()=>f.db.prepare('UPDATE Messages SET deleted_at=NULL,revision=2 WHERE message_id=?').run(row.message_id));
    const {message_id,...copy}=row;const columns=Object.keys(copy);assert.throws(()=>f.db.prepare(`INSERT INTO Messages(message_id,${columns.join(',')}) VALUES(?,${columns.map(()=>'?').join(',')})`).run('different-storage-id',...columns.map(column=>copy[column])));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM Messages').get().n,1);
});
