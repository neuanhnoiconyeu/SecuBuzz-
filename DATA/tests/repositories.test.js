const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture,direct,encrypted,users,Database,temporary } = require('./support/database');
const { openDatabase } = require('../server/database/connection');
const { createRepositories,RepositoryError } = require('../server/database/repositories');
const { databaseConfig } = require('../server/database/config');

test('users and profiles remain synchronized across legacy and profile updates', t => {
    const { db,repositories:r } = fixture(t); users(r);
    assert.equal(r.profiles.get('a').display_name,'Fixture a');
    r.profiles.update('a',{display_name:'Updated',avatar:'cat',custom_status:'Busy testing',presence_preference:'busy'});
    assert.equal(r.users.get('a').display_name,'Updated');
    db.prepare('UPDATE Users SET display_name=? WHERE user_id=?').run('Legacy update','a');
    assert.equal(r.profiles.get('a').display_name,'Legacy update');
    assert.equal(r.profiles.get('a').avatar,'cat');
    assert.equal(r.users.setStatus('a','online').changes,1);
    assert.equal(r.users.setStatus('missing','online').changes,0);
    assert.equal(r.users.get('missing'),null);
    assert.equal(r.users.list().length,3);
});

test('session repository stores supplied hashes and lifecycle metadata without issuing credentials', t => {
    const { repositories:r } = fixture(t); users(r);
    const input={session_id:'s',user_id:'a',token_hash:'b'.repeat(64),csrf_token_hash:'c'.repeat(64),issued_at_ms:100,expires_at_ms:200};
    r.sessions.insert(input);
    assert.equal(r.sessions.findByHash(input.token_hash).session_id,'s');
    r.sessions.touch('s',110);
    r.sessions.revoke('s',120); r.sessions.revoke('s',130);
    assert.equal(r.sessions.get('s').last_seen_at_ms,110);
    assert.equal(r.sessions.get('s').revoked_at_ms,120);
    assert.throws(() => r.sessions.insert({...input,session_id:'second'}),{code:'DUPLICATE'});
    assert.throws(() => r.sessions.insert({...input,session_id:'other',token:'RAW_SECRET'}),{code:'INVALID'});
});

test('all relationship foundations support insert, read, update and remove operations', t => {
    const { repositories:r } = fixture(t); users(r);
    const request=r.friendRequests.insert({sender_id:'a',recipient_id:'b'});
    assert.equal(r.friendRequests.listForUser('b')[0].request_id,request.request_id);
    assert.equal(r.friendRequests.setStatus(request.request_id,'accepted',new Date().toISOString()).status,'accepted');
    r.friendships.insert('b','a'); assert.equal(r.friendships.listForUser('a').length,1);
    r.blocks.insert('c','a'); assert.equal(r.blocks.listForUser('c').length,1);
    r.blocks.remove('c','a'); assert.equal(r.blocks.get('c','a'),null);
});

test('direct and group messages share one encrypted store with unchanged authenticated metadata', t => {
    const { repositories:r } = fixture(t); direct(r);
    const payload=encrypted();
    const stored=r.messages.insert(payload);
    for (const [key,value] of Object.entries(payload)) assert.equal(stored[key],value,key);
    assert.equal(r.messages.list('dm')[0].message_id,'message');
    assert.throws(() => r.messages.insert({...payload,message_id:'retry'}),{code:'DUPLICATE'});
    r.conversations.create({conversation_id:'group',kind:'group',title:'Group',created_by:'a'});
    r.members.insert({conversation_id:'group',user_id:'b'});
    const groupMessage=r.messages.insert(encrypted({message_id:'group-message',conversation_id:'group',receiver_id:null}));
    assert.equal(groupMessage.receiver_id,null);
    assert.equal(r.conversations.listForUser('b').length,2);
    assert.equal(r.members.list('group').length,2);
    r.conversations.archive('group',new Date().toISOString());
    assert.ok(r.conversations.get('group').archived_at);
});

test('receipt duplicates preserve the first observed and recorded times', t => {
    const { repositories:r } = fixture(t); direct(r); r.messages.insert(encrypted());
    const input={conversation_id:'dm',message_id:'message',user_id:'b',status:'read',observed_at:'2026-01-02T00:00:00Z'};
    const first=r.receipts.insert(input);
    assert.deepEqual(r.receipts.insert({...input,observed_at:'2026-01-03T00:00:00Z'}),first);
    assert.equal(r.receipts.list('dm','message').length,1);
});

test('attachment metadata is durable, scoped to its message and independent of byte storage', t => {
    const { repositories:r } = fixture(t); direct(r); r.messages.insert(encrypted());
    const file=r.attachments.insert({conversation_id:'dm',message_id:'message',uploaded_by:'a',storage_key:'opaque/test-key',byte_size:123,encrypted_metadata:'opaque-metadata'});
    assert.equal(file.status,'pending');
    r.attachments.setStatus(file.attachment_id,'ready'); assert.equal(r.attachments.get(file.attachment_id).status,'ready');
    r.conversations.create({conversation_id:'other',kind:'group',title:'Other',created_by:'a'});
    assert.throws(() => r.attachments.insert({conversation_id:'other',message_id:'message',uploaded_by:'a',storage_key:'other',byte_size:1}),{code:'REFERENCE'});
});

test('audit repository accepts only bounded operational metadata and logs no sensitive values', t => {
    const { repositories:r } = fixture(t); users(r);
    const output=[];
    t.mock.method(console,'log',(...args)=>output.push(args));
    t.mock.method(console,'error',(...args)=>output.push(args));
    const event=r.audit.insert({actor_user_id:'a',event_type:'database.operation',source:'test',metadata:{operation:'insert',outcome:'ok',count:1}});
    assert.equal(r.audit.listForActor('a')[0].audit_id,event.audit_id);
    for (const metadata of [{password:'SECRET'},{prompt:'PRIVATE'},{ciphertext:'PRIVATE'},{reason_code:'private words with spaces'}]) {
        assert.throws(() => r.audit.insert({event_type:'rejected',source:'test',metadata}),{code:'INVALID'});
    }
    assert.throws(() => r.messages.insert({plaintext:'PRIVATE'}),{code:'INVALID'});
    assert.throws(() => r.users.create({username:'fixture-a',display_name:'SECRET'}),error =>
        error instanceof RepositoryError && error.code === 'DUPLICATE' && !error.message.includes('SECRET') && !error.cause);
    assert.deepEqual(output,[]);
});

test('multi-record operations roll back on error including nested repository calls', t => {
    const { repositories:r } = fixture(t);
    assert.throws(() => r.transaction(() => {
        r.users.create({user_id:'rollback',username:'rollback',display_name:'Rollback'});
        r.blocks.insert('rollback','missing');
    }),{code:'REFERENCE'});
    assert.equal(r.users.get('rollback'),null);
    assert.equal(r.profiles.get('rollback'),null);
    assert.throws(() => r.transaction(() => Promise.resolve('async is forbidden')),{code:'INVALID'});
});

test('conversation creation rolls back when initial membership fails', t => {
    const { repositories:r } = fixture(t); users(r);
    assert.throws(() => r.conversations.create({conversation_id:'bad',kind:'direct',dm_user_low:'a',dm_user_high:'missing'}),{code:'REFERENCE'});
    assert.equal(r.conversations.get('bad'),null);
});

test('legacy contact writes are atomic with foundation requests', t => {
    const { db,repositories:r } = fixture(t); users(r);
    const contact=r.legacy.addContact('a','b');
    assert.equal(r.friendRequests.get(contact.contact_id).status,'pending');
    assert.equal(r.legacy.getContacts('a')[0].user_id,'b');
    assert.throws(() => r.legacy.addContact('b','a'),{code:'DUPLICATE'});
    assert.equal(db.prepare('SELECT count(*) AS n FROM Contacts').get().n,1);
});

test('legacy messages and security logs remain compatible and populate new metadata', t => {
    const { repositories:r } = fixture(t); users(r);
    const message=r.legacy.saveMessage('a','b','legacy-ciphertext','legacy-iv');
    r.messages.setLegacyStatus(message.message_id,'delivered'); r.messages.setLegacyStatus(message.message_id,'delivered');
    r.messages.setLegacyStatus(message.message_id,'read');
    assert.equal(r.receipts.list(message.conversation_id,message.message_id).length,2);
    assert.equal(r.legacy.getConversation('a','b').length,1);
    const log=r.legacy.createSecurityLog('a','legacy.event','HIGH','auditor_bot','Legacy description',{legacy:'preserved'});
    assert.equal(r.audit.get(log.log_id).legacy_log_id,log.log_id);
    assert.equal(r.audit.get(log.log_id).metadata_json,'{}');
    assert.equal(r.legacy.getSecurityLogs().length,1);
});

test('parameterized queries treat SQL syntax as data', t => {
    const { repositories:r } = fixture(t);
    const username="x'); DROP TABLE Users; --";
    const user=r.users.create({username,display_name:'SQL is data'});
    assert.equal(r.users.get(user.user_id).username,username);
    assert.equal(r.users.list().length,1);
});

test('repository canonical pairs use SQLite UTF-8 binary order for non-ASCII legacy IDs', t => {
    const { repositories:r } = fixture(t);
    const [a,b]=['\uE000','\u{10000}'];
    for (const id of [a,b]) r.users.create({user_id:id,username:id,display_name:'Unicode fixture'});
    assert.equal(r.friendships.insert(b,a).user_low,a);
    assert.equal(r.friendships.get(a,b).user_high,b);
    const message=r.legacy.saveMessage(a,b,'cipher','iv');
    assert.equal(r.conversations.get(message.conversation_id).dm_user_low,a);
});

test('native async transaction callbacks are rejected before any writes occur', t => {
    const { repositories:r } = fixture(t);
    let invoked=false;
    assert.throws(() => r.transaction(async () => { invoked=true; }),{code:'INVALID'});
    assert.equal(invoked,false);
});

test('competing SQLite writers return BUSY without partial changes, then succeed after lock release', t => {
    const { db,filename,repositories:r,connections } = fixture(t);
    const second=openDatabase({filename,timeout:25});
    connections.push(second);
    const r2=createRepositories(second);
    db.exec('BEGIN IMMEDIATE');
    r.users.create({user_id:'uncommitted',username:'uncommitted',display_name:'Uncommitted'});
    assert.equal(r2.users.get('uncommitted'),null);
    assert.throws(() => r2.users.create({user_id:'second',username:'second',display_name:'Second'}),{code:'BUSY'});
    db.exec('ROLLBACK');
    assert.equal(r2.users.get('uncommitted'),null);
    r2.users.create({user_id:'second',username:'second',display_name:'Second'});
    assert.equal(r.users.get('second').username,'second');
});

test('database configuration resolves DATA-relative defaults and validates timeout without creating files', () => {
    const config=databaseConfig({});
    assert.equal(config.filename,path.resolve(__dirname,'../server/database/database.sqlite'));
    assert.equal(databaseConfig({DB_PATH:':memory:'}).filename,':memory:');
    for (const DB_BUSY_TIMEOUT_MS of ['-1','NaN','2.5','60001']) assert.throws(() => databaseConfig({DB_BUSY_TIMEOUT_MS}));
});

test('fresh setup never inserts production demo data', t => {
    const { db } = fixture(t);
    for (const table of ['Users','Sessions','Conversations','Messages','AuditLogs']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
});
