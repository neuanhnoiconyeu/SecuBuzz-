const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { fixture,temporary }=require('./support/database');
const { migrate,loadMigrations }=require('../server/database/migrate');
const { createRepositories }=require('../server/database/repositories');
const { createAuthService }=require('../server/auth/service');
const { loadAuthConfig }=require('../server/auth/config');
const { envDefaults,PASSWORD }=require('./support/auth');

function versionThree(t) {
    const f=fixture(t,{migrate:false});const directory=temporary(t);
    for(const migration of loadMigrations().slice(0,3))fs.writeFileSync(path.join(directory,migration.name),migration.sql);
    migrate(f.db,{directory});return f;
}
test('DB-3 upgrade preserves users, sessions, Contacts and prior migration checksums and labels existing projections legacy',t=>{
    const {db}=versionThree(t);const r=createRepositories(db);
    for(const id of ['a','b','c'])r.users.create({user_id:id,username:'legacy-'+id,display_name:'Legacy '+id});
    r.legacy.addContact('a','b');r.friendships.insert('a','c');r.blocks.insert('b','c');
    r.sessions.insert({session_id:'session',user_id:'a',token_hash:'a'.repeat(64),issued_at_ms:1,expires_at_ms:9999999999999});
    const tables=['Users','UserProfiles','Sessions','Contacts','FriendRequests','Friendships','Blocks'];
    const before=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
    const history=db.prepare('SELECT * FROM SchemaMigrations ORDER BY version').all();
    assert.deepEqual(migrate(db).applied,['0004-profiles-friends.sql','0005-conversation-provenance.sql','0006-encrypted-message-lifecycle.sql','0007-recipient-keys.sql','0008-authenticated-message-pins.sql','0009-authenticated-message-reactions.sql','0010-encrypted-attachments.sql','0011-encrypted-message-revisions.sql','0012-groups.sql','0013-attachment-lifecycle.sql','0014-voice-rooms.sql','0015-conversation-customization.sql','0016-customization-retention.sql']);
    for(const table of tables) {
        const columns=Object.keys(before[table][0]).join(',');assert.deepEqual(db.prepare(`SELECT ${columns} FROM ${table}`).all(),before[table]);
    }
    for(const table of ['FriendRequests','Friendships','Blocks'])assert.equal(db.prepare(`SELECT origin FROM ${table}`).get().origin,'legacy');
    assert.deepEqual(db.prepare('SELECT * FROM SchemaMigrations WHERE version<=3 ORDER BY version').all(),history);
    assert.deepEqual(migrate(db).applied,[]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    const indexes=db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row=>row.name);
    for(const name of ['idx_social_requests_incoming','idx_social_requests_outgoing','idx_social_friends_low','idx_social_friends_high','idx_social_discovery'])assert.ok(indexes.includes(name));
});

test('failed DB-3 migration rolls back additive columns and history without resetting any data',t=>{
    const {db}=versionThree(t);const directory=temporary(t);
    for(const migration of loadMigrations())fs.writeFileSync(path.join(directory,migration.name),migration.sql+(migration.version===4 ? '\nINSERT INTO MissingTable VALUES(1);' : ''));
    db.exec("INSERT INTO Users(user_id,username,display_name) VALUES('preserved','preserved','Preserved')");
    assert.throws(()=>migrate(db,{directory}),{code:'MIGRATION_FAILED'});
    assert.equal(db.prepare('SELECT max(version) AS version FROM SchemaMigrations').get().version,3);
    assert.ok(!db.prepare('PRAGMA table_info(Friendships)').all().some(row=>row.name==='origin'));
    assert.equal(db.prepare('SELECT display_name FROM Users').get().display_name,'Preserved');
});

test('a real credential-verified version-3 session and its CSRF proof stay valid after upgrade',async t=>{
    const {db}=versionThree(t);const auth=createAuthService({db,config:loadAuthConfig(envDefaults)});await auth.ready;
    const proof=()=>{const bootstrap=auth.bootstrap(null,null);return auth.csrfProof(null,bootstrap.preToken,bootstrap.csrfToken);};
    await auth.register({username:'upgrade-user',email:'upgrade@example.test',password:PASSWORD},proof());
    const login=await auth.login({identifier:'upgrade-user',password:PASSWORD},proof());
    const sessionBefore=db.prepare('SELECT * FROM Sessions').all();const credentialsBefore=db.prepare('SELECT * FROM AccountCredentials').all();
    const csrf=auth.bootstrap(login.token,null).csrfToken;
    const before=auth.resolveToken(login.token);assert.equal(before.status,'authenticated');
    migrate(db);
    assert.deepEqual(db.prepare('SELECT * FROM Sessions').all(),sessionBefore);
    assert.deepEqual(db.prepare('SELECT * FROM AccountCredentials').all(),credentialsBefore);
    assert.equal(auth.resolveToken(login.token).status,'authenticated');
    assert.ok(auth.verifyCsrf({sessionId:before.row.session_id,userId:before.row.user_id,token:csrf}));
});
