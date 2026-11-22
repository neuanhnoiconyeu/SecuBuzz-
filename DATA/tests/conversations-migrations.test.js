const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture,temporary } = require('./support/database');
const { migrate,loadMigrations } = require('../server/database/migrate');
const { createRepositories } = require('../server/database/repositories');
const { socialFixture,mutate,befriend } = require('./support/social');
function versionFour(t) {
    const f=fixture(t,{migrate:false});const directory=temporary(t);
    for(const migration of loadMigrations().slice(0,4))fs.writeFileSync(path.join(directory,migration.name),migration.sql);
    migrate(f.db,{directory});return f;
}

test('DB-4A additive upgrade preserves all version-4 records, ciphertext and applied migration history',t=>{
    const {db}=versionFour(t);const r=createRepositories(db);
    for(const id of ['a','b'])r.users.create({user_id:id,username:'old-'+id,display_name:id});
    r.legacy.saveMessage('a','b','ORIGINAL_CIPHERTEXT','ORIGINAL_IV');
    const names=['Users','UserProfiles','Conversations','ConversationMembers','Messages','FriendRequests','Friendships','Blocks','Sessions','AccountCredentials','AuditLogs'];
    const before=Object.fromEntries(names.map(name=>[name,db.prepare(`SELECT * FROM ${name}`).all()]));const history=db.prepare('SELECT * FROM SchemaMigrations ORDER BY version').all();
    assert.deepEqual(migrate(db).applied,['0005-conversation-provenance.sql','0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql','0008-authenticated-message-pins.sql','0009-authenticated-message-reactions.sql','0010-encrypted-attachments.sql','0011-encrypted-message-revisions.sql']);
    for(const [name,rows] of Object.entries(before)){
        if(rows.length)assert.deepEqual(db.prepare(`SELECT ${Object.keys(rows[0]).join(',')} FROM ${name}`).all(),rows);
        else assert.equal(db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n,0);
    }
    assert.equal(db.prepare('SELECT origin FROM Conversations').get().origin,'legacy');
    assert.deepEqual(db.prepare('SELECT * FROM SchemaMigrations WHERE version<=4 ORDER BY version').all(),history);
    assert.deepEqual(migrate(db).applied,[]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
});

test('failed DB-4A migration restores version 4 and rolls back additive columns and indexes',t=>{
    const {db}=versionFour(t);db.exec("INSERT INTO Users(user_id,username,display_name) VALUES('retained','retained','Retained')");
    const directory=temporary(t);for(const migration of loadMigrations())fs.writeFileSync(path.join(directory,migration.name),migration.sql+(migration.version===5?'\nINSERT INTO MissingTable VALUES(1);':''));
    assert.throws(()=>migrate(db,{directory}),{code:'MIGRATION_FAILED'});
    assert.equal(db.prepare('SELECT max(version) AS v FROM SchemaMigrations').get().v,4);
    assert.ok(!db.prepare('PRAGMA table_info(Conversations)').all().some(column=>column.name==='origin'));
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='idx_conversations_authenticated_direct_updated'").get().n,0);
    assert.equal(db.prepare('SELECT display_name FROM Users').get().display_name,'Retained');
});

test('legacy DM metadata stays hidden until explicit current friendship approval reuses its ID and preserves ciphertext',async t=>{
    const f=await socialFixture(t);const r=f.application.conversations.repositories;
    const [low,high]=[f.alice.id,f.bob.id].sort();
    const id='legacy-dm:'+Buffer.from(low).toString('hex').toUpperCase()+':'+Buffer.from(high).toString('hex').toUpperCase();
    r.conversations.create({conversation_id:id,kind:'direct',dm_user_low:low,dm_user_high:high});
    const message=r.legacy.saveMessage(f.alice.id,f.bob.id,'KEEP_CIPHERTEXT','KEEP_IV');
    const original=r.conversations.findDirect(f.alice.id,f.bob.id);assert.equal(original.origin,'legacy');assert.ok(original.conversation_id.length>128);
    assert.deepEqual((await f.alice.browser.request('/api/conversations')).body.items,[]);
    assert.equal((await f.alice.browser.request('/api/conversations/'+original.conversation_id)).status,404);
    assert.equal((await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.bob.id})).status,403);
    await befriend(f.alice,f.bob);const enabled=await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.bob.id});assert.equal(enabled.status,200);
    assert.equal(enabled.body.conversation.id,original.conversation_id);assert.equal((await f.bob.browser.request('/api/conversations/'+original.conversation_id)).status,200);
    assert.deepEqual(r.messages.get(message.message_id),message);assert.equal(f.db.prepare('SELECT count(*) AS n FROM Conversations').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,2);
});

test('failed legacy activation leaves provenance, metadata, memberships and ciphertext unchanged',async t=>{
    const f=await socialFixture(t);const r=f.application.conversations.repositories;r.legacy.saveMessage(f.alice.id,f.bob.id,'KEEP','IV');await befriend(f.alice,f.bob);
    const before=r.conversations.findDirect(f.alice.id,f.bob.id);
    f.db.exec("CREATE TRIGGER activation_audit BEFORE INSERT ON AuditLogs WHEN NEW.source='conversations' BEGIN SELECT RAISE(ABORT,'rollback'); END;");
    assert.equal((await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.bob.id})).status,500);
    assert.deepEqual(r.conversations.findDirect(f.alice.id,f.bob.id),before);
    assert.deepEqual((await f.alice.browser.request('/api/conversations')).body.items,[]);
});
