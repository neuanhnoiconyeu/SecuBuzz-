const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture,direct,users,encrypted } = require('./support/database');

test('all roadmap tables and lookup indexes exist; foreign keys and WAL are enabled', t => {
    const { db } = fixture(t);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const table of ['Users','UserProfiles','Sessions','FriendRequests','Friendships','Blocks','Conversations',
        'ConversationMembers','Messages','MessageReceipts','Attachments','AuditLogs','Contacts','SecurityLogs','SchemaMigrations']) assert.ok(tables.has(table),table);
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
    for (const index of ['idx_sessions_user_expiry','idx_sessions_expiry','uq_requests_pending_pair','idx_requests_recipient_status',
        'idx_requests_sender_status','idx_friendships_high','idx_blocks_blocked','idx_conversations_updated','idx_members_user_active',
        'uq_members_active_owner','idx_messages_conversation_cursor','idx_receipts_user','idx_attachments_message',
        'idx_attachments_conversation','idx_audit_actor_created','idx_audit_event_created','idx_audit_created']) assert.ok(indexes.has(index),index);
    assert.equal(db.pragma('foreign_keys',{simple:true}),1);
    assert.equal(db.pragma('journal_mode',{simple:true}),'wal');
    for (const table of [...tables].filter(name => !['SchemaMigrations','AuthChallenges','AuthRateLimits'].includes(name))) {
        if (table !== 'Users') assert.ok(db.prepare(`PRAGMA foreign_key_list(${table})`).all().length,table);
    }
});

for (const [label,sql] of [
    ['null user ID',"INSERT INTO Users(user_id,username,display_name) VALUES(NULL,'bad','Bad')"],
    ['blank username',"INSERT INTO Users(user_id,username,display_name) VALUES('bad',' ','Bad')"],
    ['null display name',"INSERT INTO Users(user_id,username,display_name) VALUES('bad','bad',NULL)"],
    ['duplicate username',"INSERT INTO Users(user_id,username,display_name) VALUES('bad','fixture-a','Bad')"],
    ['invalid presence status',"UPDATE Users SET status='invented' WHERE user_id='a'"],
    ['profile with unknown user',"INSERT INTO UserProfiles(user_id,display_name) VALUES('missing','Missing')"],
    ['invalid avatar',"UPDATE UserProfiles SET avatar='http://external' WHERE user_id='a'"],
    ['session with missing user',"INSERT INTO Sessions(session_id,user_id,token_hash,issued_at_ms,expires_at_ms) VALUES('s','missing',printf('%064d',1),1,2)"],
    ['raw session token',"INSERT INTO Sessions(session_id,user_id,token_hash,issued_at_ms,expires_at_ms) VALUES('s','a','raw-cookie-value',1,2)"],
    ['expired-before-issued session',"INSERT INTO Sessions(session_id,user_id,token_hash,issued_at_ms,expires_at_ms) VALUES('s','a',printf('%064d',1),2,1)"],
    ['fractional session expiry',"INSERT INTO Sessions(session_id,user_id,token_hash,issued_at_ms,expires_at_ms) VALUES('s','a',printf('%064d',1),1,2.5)"],
    ['self friend request',"INSERT INTO FriendRequests(request_id,sender_id,recipient_id) VALUES('r','a','a')"],
    ['unresolved accepted request',"INSERT INTO FriendRequests(request_id,sender_id,recipient_id,status) VALUES('r','a','b','accepted')"],
    ['reversed friendship',"INSERT INTO Friendships(user_low,user_high) VALUES('b','a')"],
    ['self friendship',"INSERT INTO Friendships(user_low,user_high) VALUES('a','a')"],
    ['self block',"INSERT INTO Blocks(blocker_id,blocked_id) VALUES('a','a')"],
    ['group with DM pair',"INSERT INTO Conversations(conversation_id,kind,title,dm_user_low,dm_user_high) VALUES('bad','group','Title','a','b')"],
    ['direct conversation without pair',"INSERT INTO Conversations(conversation_id,kind) VALUES('bad','direct')"],
    ['unknown conversation membership',"INSERT INTO ConversationMembers(conversation_id,user_id) VALUES('missing','a')"],
    ['third direct member',"INSERT INTO ConversationMembers(conversation_id,user_id) VALUES('dm','c')"],
    ['admin direct member',"UPDATE ConversationMembers SET role='admin' WHERE conversation_id='dm' AND user_id='a'"],
    ['changing conversation kind',"UPDATE Conversations SET kind='group',title='Changed',dm_user_low=NULL,dm_user_high=NULL WHERE conversation_id='dm'"],
    ['blank encrypted payload',"INSERT INTO Messages(message_id,conversation_id,sender_id,receiver_id,ciphertext,iv) VALUES('m','dm','a','b','','iv')"],
    ['nonmember sender',"INSERT INTO Messages(message_id,conversation_id,sender_id,receiver_id,ciphertext,iv) VALUES('m','dm','c','b','cipher','iv')"],
    ['wrong direct receiver',"INSERT INTO Messages(message_id,conversation_id,sender_id,receiver_id,ciphertext,iv) VALUES('m','dm','a','c','cipher','iv')"],
    ['negative attachment size',"INSERT INTO Attachments(attachment_id,conversation_id,uploaded_by,storage_key,byte_size) VALUES('f','dm','a','key',-1)"],
    ['nonmember attachment owner',"INSERT INTO Attachments(attachment_id,conversation_id,uploaded_by,storage_key,byte_size) VALUES('f','dm','c','key',1)"],
    ['malformed audit JSON',"INSERT INTO AuditLogs(audit_id,event_type,source,metadata_json) VALUES('log','event','test','invalid-json')"],
    ['array audit JSON',"INSERT INTO AuditLogs(audit_id,event_type,source,metadata_json) VALUES('log','event','test','[]')"]
]) test(`schema rejects ${label}`, t => {
    const { db,repositories } = fixture(t);
    direct(repositories);
    assert.throws(() => db.exec(sql),error => error.code.startsWith('SQLITE_CONSTRAINT') || /malformed JSON/.test(error.message));
});

test('pending requests prevent reversed duplicates and allow a later request after resolution', t => {
    const { repositories:r } = fixture(t); users(r);
    const request = r.friendRequests.insert({sender_id:'a',recipient_id:'b'});
    assert.throws(() => r.friendRequests.insert({sender_id:'b',recipient_id:'a'}),{code:'DUPLICATE'});
    r.friendRequests.setStatus(request.request_id,'declined',new Date().toISOString());
    assert.equal(r.friendRequests.insert({sender_id:'b',recipient_id:'a'}).status,'pending');
});

test('canonical friendships, directional blocks and DM pairs reject duplicates', t => {
    const { repositories:r } = fixture(t); direct(r);
    r.friendships.insert('b','a');
    assert.throws(() => r.friendships.insert('a','b'),{code:'DUPLICATE'});
    r.blocks.insert('a','b');
    assert.throws(() => r.blocks.insert('a','b'),{code:'DUPLICATE'});
    assert.equal(r.blocks.insert('b','a').blocker_id,'b');
    assert.throws(() => r.conversations.create({kind:'direct',dm_user_low:'a',dm_user_high:'b'}),{code:'DUPLICATE'});
});

test('group ownership has at most one active owner; membership IDs are immutable', t => {
    const { db,repositories:r } = fixture(t); users(r);
    r.conversations.create({conversation_id:'group',kind:'group',title:'Test group',created_by:'a'});
    r.members.insert({conversation_id:'group',user_id:'b'});
    assert.throws(() => r.members.setRole('group','b','owner'),{code:'DUPLICATE'});
    assert.throws(() => db.exec("UPDATE ConversationMembers SET user_id='c' WHERE conversation_id='group' AND user_id='b'"));
    r.transaction(() => { r.members.setRole('group','a','member'); r.members.setRole('group','b','owner'); });
    assert.equal(r.members.get('group','b').role,'owner');
});

test('inactive members cannot send; encrypted envelope identity cannot be overwritten', t => {
    const { db,repositories:r } = fixture(t); direct(r);
    r.messages.insert(encrypted());
    assert.throws(() => db.exec("UPDATE Messages SET ciphertext='changed' WHERE message_id='message'"));
    r.members.leave('dm','a',new Date().toISOString());
    assert.throws(() => r.messages.insert(encrypted({message_id:'next',client_id:'next'})),{code:'INVALID'});
});

test('receipt references are scoped to the message conversation and observer membership', t => {
    const { repositories:r } = fixture(t); direct(r);
    r.messages.insert(encrypted());
    for (const user_id of ['a','c','missing']) {
        assert.throws(() => r.receipts.insert({conversation_id:'dm',message_id:'message',user_id,status:'read',observed_at:new Date().toISOString()}));
    }
    r.conversations.create({conversation_id:'other',kind:'group',title:'Other',created_by:'b'});
    assert.throws(() => r.receipts.insert({conversation_id:'other',message_id:'message',user_id:'b',status:'read',observed_at:new Date().toISOString()}),{code:'REFERENCE'});
});

test('parent deletion is restricted and never silently cascades message history', t => {
    const { db,repositories:r } = fixture(t); direct(r);
    r.messages.insert(encrypted());
    for (const sql of ["DELETE FROM Users WHERE user_id='a'","DELETE FROM Conversations WHERE conversation_id='dm'",
        "DELETE FROM ConversationMembers WHERE conversation_id='dm' AND user_id='a'"]) assert.throws(() => db.exec(sql));
    assert.equal(r.messages.get('message').ciphertext,encrypted().ciphertext);
});
