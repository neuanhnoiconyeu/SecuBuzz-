const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { fixture,temporary }=require('./support/database');
const { loadMigrations,migrate }=require('../server/database/migrate');
const { createRepositories }=require('../server/database/repositories');

function versionTwo(t) {
    const f=fixture(t,{migrate:false});const directory=temporary(t);
    for(const migration of loadMigrations().slice(0,2)) fs.writeFileSync(path.join(directory,migration.name),migration.sql);
    migrate(f.db,{directory});return f;
}
test('version 2 upgrades without altering applied checksums, legacy users, contacts, ciphertext or logs',t=>{
    const {db}=versionTwo(t);const r=createRepositories(db);
    r.users.create({user_id:'old-a',username:'Legacy-A',display_name:'Legacy A'});
    r.users.create({user_id:'old-b',username:'Legacy-B',display_name:'Legacy B'});
    r.legacy.addContact('old-a','old-b');r.legacy.saveMessage('old-a','old-b','original-opaque-ciphertext','original-iv');
    r.legacy.createSecurityLog('old-a','legacy.event','LOW','auditor_bot','Legacy description',{preserved:true});
    db.prepare('INSERT INTO Sessions(session_id,user_id,token_hash,issued_at_ms,expires_at_ms) VALUES(?,?,?,?,?)').run('old-session','old-a','a'.repeat(64),1,9999999999999);
    const tables=['Users','Contacts','Messages','SecurityLogs'];
    const before=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
    const history=db.prepare('SELECT * FROM SchemaMigrations ORDER BY version').all();
    assert.deepEqual(migrate(db).applied,['0003-authentication.sql','0004-profiles-friends.sql','0005-conversation-provenance.sql','0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql']);
    for(const table of tables) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),table==='Messages'
        ? before[table].map(row=>({...row,origin:'legacy',message_seq:null,deleted_at:null,revision:0,key_id:null})) : before[table]);
    assert.deepEqual(db.prepare('SELECT * FROM SchemaMigrations WHERE version<=2 ORDER BY version').all(),history);
    assert.equal(db.prepare('SELECT count(*) AS n FROM AccountCredentials').get().n,0);
    assert.equal(db.prepare('SELECT auth_version FROM Sessions').get().auth_version,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.deepEqual(migrate(db).applied,[]);
});

test('case-ambiguous legacy usernames survive upgrade but cannot be registered again',t=>{
    const {db}=versionTwo(t);const r=createRepositories(db);
    r.users.create({user_id:'upper',username:'Case-User',display_name:'Upper'});
    r.users.create({user_id:'lower',username:'case-user',display_name:'Lower'});
    migrate(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM Users').get().n,2);
    assert.throws(()=>r.users.create({username:'CASE-USER',display_name:'New'}),{code:'DUPLICATE'});
    assert.equal(db.prepare('SELECT count(*) AS n FROM AccountCredentials').get().n,0);
});

test('failed DB-2 migration rolls back its new tables and session column without changing DB-1',t=>{
    const {db}=versionTwo(t);
    db.exec('CREATE TABLE AuthChallenges(custom_column TEXT)');
    assert.throws(()=>migrate(db),{code:'MIGRATION_FAILED'});
    assert.equal(db.prepare('SELECT max(version) AS version FROM SchemaMigrations').get().version,2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='AccountCredentials'").get().n,0);
    assert.ok(!db.prepare('PRAGMA table_info(Sessions)').all().some(row=>row.name==='auth_version'));
    assert.ok(db.prepare('PRAGMA table_info(AuthChallenges)').all().some(row=>row.name==='custom_column'));
});
