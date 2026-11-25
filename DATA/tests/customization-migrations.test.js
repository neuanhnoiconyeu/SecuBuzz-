const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture,temporary } = require('./support/database');
const { migrate,loadMigrations } = require('../server/database/migrate');
const { createRepositories } = require('../server/database/repositories');

const migrationList=loadMigrations();
function directoryThrough(t,version) {
    const directory=temporary(t);
    for(const migration of migrationList.filter(entry=>entry.version<=version))
        fs.writeFileSync(path.join(directory,migration.name),migration.sql);
    return directory;
}
function rows(db,table) {
    return db.prepare(`SELECT * FROM "${table}"`).all().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function foreignKeys(db,table) {
    return db.pragma(`foreign_key_list("${table}")`).map(row=>[row.from,row.table,row.to,row.on_delete]).sort();
}

test('fresh empty database migrates through customization retention with integrity and idempotence',t=>{
    const {db}=fixture(t,{migrate:false});
    assert.deepEqual(migrate(db),{version:15,applied:migrationList.map(entry=>entry.name)});
    assert.deepEqual(migrate(db),{version:15,applied:[]});
    assert.equal(db.pragma('foreign_keys',{simple:true}),1);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
    for(const table of ['UserProfileAvatars','ConversationThemes','ConversationNicknames'])
        assert.deepEqual(foreignKeys(db,table).map(row=>row[3]),Array(foreignKeys(db,table).length).fill('RESTRICT'),table);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name GLOB 'social_revision_avatar_*'").get().n,3);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%_v15'").get().n,0);
});

test('upgrade from version 13 preserves existing rows, customization, ownership, triggers and referential integrity',t=>{
    const {db}=fixture(t,{migrate:false});
    assert.equal(migrate(db,{directory:directoryThrough(t,13)}).version,13);
    const repositories=createRepositories(db);
    repositories.users.create({user_id:'custom-a',username:'custom-a',display_name:'Custom A'});
    repositories.users.create({user_id:'custom-b',username:'custom-b',display_name:'Custom B'});
    repositories.friendships.insert('custom-a','custom-b');
    db.prepare("UPDATE Friendships SET origin='authenticated' WHERE user_low='custom-a' AND user_high='custom-b'").run();
    repositories.conversations.create({conversation_id:'custom-dm',kind:'direct',dm_user_low:'custom-a',dm_user_high:'custom-b',origin:'authenticated'});
    repositories.messages.insert({message_id:'custom-message',conversation_id:'custom-dm',sender_id:'custom-a',receiver_id:'custom-b',
        ciphertext:'preserved opaque ciphertext',iv:'preserved opaque iv'});
    repositories.attachments.insert({attachment_id:'custom-attachment',conversation_id:'custom-dm',message_id:'custom-message',
        uploaded_by:'custom-a',storage_key:'opaque-custom-file',byte_size:37});
    const deviceKeyId='K'.repeat(43),keyId='E'.repeat(22),at='2026-01-01T00:00:00.000Z';
    db.prepare(`INSERT INTO DeviceKeys(device_key_id,user_id,device_id,key_version,created_at,agreement_public_key,signing_public_key,signature,registered_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(deviceKeyId,'custom-a','D'.repeat(22),1,at,'A'.repeat(87),'S'.repeat(87),'G'.repeat(86),at);
    db.prepare(`INSERT INTO ConversationKeyEpochs(conversation_id,key_id,epoch,previous_key_id,creator_user_id,creator_device_key_id,
        created_at,signature,recipient_set_digest,published_at)
        VALUES(?,?,1,NULL,?,?,?,?,?,?)`).run('custom-dm',keyId,'custom-a',deviceKeyId,at,'G'.repeat(86),'R'.repeat(43),at);
    db.prepare(`INSERT INTO ConversationKeyWraps(conversation_id,key_id,position,recipient_user_id,recipient_device_key_id,enc,ciphertext)
        VALUES(?,?,0,?,?,?,?)`).run('custom-dm',keyId,'custom-a',deviceKeyId,'N'.repeat(87),'C'.repeat(64));
    const preservedTables=['Users','Friendships','Conversations','ConversationMembers','Messages','Attachments','DeviceKeys',
        'ConversationKeyEpochs','ConversationKeyWraps','VoiceRooms'];
    const preservedBefore=Object.fromEntries(preservedTables.map(table=>[table,rows(db,table)]));

    assert.deepEqual(migrate(db,{directory:directoryThrough(t,14)}).applied,['0014-conversation-customization.sql']);
    db.prepare(`INSERT INTO UserProfileAvatars(user_id,storage_key,mime_type,byte_size,sha256,updated_at)
        VALUES(?,?,?,?,?,?)`).run('custom-a','custom-avatar.png','image/png',8,'a'.repeat(64),at);
    db.prepare(`INSERT INTO ConversationThemes(conversation_id,theme_id,updated_by,updated_at)
        VALUES(?,?,?,?)`).run('custom-dm','ocean','custom-a',at);
    db.prepare(`INSERT INTO ConversationNicknames(conversation_id,target_user_id,nickname,updated_by,updated_at)
        VALUES(?,?,?,?,?)`).run('custom-dm','custom-b','Bobby','custom-a',at);
    const customizationBefore=Object.fromEntries(['UserProfileAvatars','ConversationThemes','ConversationNicknames']
        .map(table=>[table,rows(db,table)]));
    const revisionBefore=db.prepare("SELECT revision FROM SocialRevisions WHERE user_id='custom-b'").get().revision;

    assert.deepEqual(migrate(db).applied,['0015-customization-retention.sql']);
    for(const table of preservedTables)assert.deepEqual(rows(db,table),preservedBefore[table],`${table} is preserved`);
    for(const table of Object.keys(customizationBefore))
        assert.deepEqual(rows(db,table),customizationBefore[table],`${table} customization is preserved`);
    assert.deepEqual(migrate(db),{version:15,applied:[]});
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
    assert.deepEqual(db.pragma('foreign_key_check'),[]);

    const actions=table=>foreignKeys(db,table).map(row=>[row[0],row[1],row[2],row[3]]);
    assert.deepEqual(actions('UserProfileAvatars'),[['user_id','Users','user_id','RESTRICT']]);
    assert.deepEqual(actions('ConversationThemes'),[['conversation_id','Conversations','conversation_id','RESTRICT'],
        ['updated_by','Users','user_id','RESTRICT']].sort());
    assert.deepEqual(actions('ConversationNicknames'),[['conversation_id','Conversations','conversation_id','RESTRICT'],
        ['target_user_id','Users','user_id','RESTRICT'],['updated_by','Users','user_id','RESTRICT']].sort());
    assert.throws(()=>db.prepare("DELETE FROM Users WHERE user_id='custom-a'").run(),/FOREIGN KEY constraint failed/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM UserProfileAvatars WHERE user_id='custom-a'").get().n,1);

    db.prepare("UPDATE UserProfileAvatars SET sha256=? WHERE user_id='custom-a'").run('b'.repeat(64));
    assert.equal(db.prepare("SELECT revision FROM SocialRevisions WHERE user_id='custom-b'").get().revision,revisionBefore+1);
});
