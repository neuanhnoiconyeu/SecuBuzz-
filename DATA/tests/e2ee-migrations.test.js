const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {fixture,temporary}=require('./support/database');const {loadMigrations,migrate}=require('../server/database/migrate');const {createRepositories}=require('../server/database/repositories');
function atSix(t){const f=fixture(t,{migrate:false}),dir=temporary(t);for(const m of loadMigrations().slice(0,6))fs.writeFileSync(path.join(dir,m.name),m.sql);migrate(f.db,{directory:dir});return f;}
function seed(db){const r=createRepositories(db);for(const id of ['a','b'])r.users.create({user_id:id,username:'retained-'+id,display_name:id});
    const m=r.legacy.saveMessage('a','b','PRESERVE_CIPHERTEXT','PRESERVE_IV');r.messages.setLegacyStatus(m.message_id,'read');
    r.messages.insertAuthenticated({message_id:'approved-v1',conversation_id:m.conversation_id,sender_id:'a',receiver_id:'b',ciphertext:'V1_CIPHERTEXT',iv:'V1_IV',envelope_version:1,encoding:'base64',sender_name:'a',client_timestamp:'2026-01-01T00:00:00.000Z',message_type:'text',fingerprint:'a'.repeat(64),client_id:'original-wire-id',message_seq:1,created_at:'2026-01-01T00:00:00.000Z'});
    r.messages.tombstone('approved-v1','2026-01-02T00:00:00.000Z');r.receipts.insert({conversation_id:m.conversation_id,message_id:'approved-v1',user_id:'b',status:'read',observed_at:'2026-01-01T01:00:00.000Z'});
    db.prepare('INSERT INTO Attachments(attachment_id,conversation_id,message_id,uploaded_by,storage_key,byte_size) VALUES(?,?,?,?,?,?)').run('preserved-attachment',m.conversation_id,m.message_id,'a','opaque-reference',0);return m;}
test('migration 6 to 7 preserves every existing value, receipt, attachment, index, trigger, checksum and FK with enforcement on',t=>{
    const {db}=atSix(t);seed(db);const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
    const before=Object.fromEntries(names.map(n=>[n,db.prepare('SELECT * FROM '+n).all()]));const objects=db.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(migrate(db).applied,['0007-recipient-keys.sql']);assert.equal(db.pragma('foreign_keys',{simple:true}),1);
    for(const [name,rows]of Object.entries(before)){
        if(name==='SchemaMigrations')assert.deepEqual(db.prepare('SELECT * FROM SchemaMigrations WHERE version<=6 ORDER BY version').all(),rows);
        else if(name==='Messages')assert.deepEqual(db.prepare(`SELECT ${Object.keys(rows[0]).join(',')} FROM Messages`).all(),rows);
        else assert.deepEqual(db.prepare('SELECT * FROM '+name).all(),rows);
    }
    for(const o of objects)assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=? AND type=?').get(o.name,o.type),o.name);
    assert.ok(db.prepare('SELECT * FROM Messages').all().every(r=>r.key_id===null));assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(migrate(db).applied,[]);
    assert.throws(()=>db.prepare("UPDATE Messages SET ciphertext='different' WHERE message_id='approved-v1'").run());assert.throws(()=>db.prepare("UPDATE Messages SET key_id='AAAAAAAAAAAAAAAAAAAAAA' WHERE message_id='approved-v1'").run());
});
test('failed migration 7 rolls back the whole rebuild including dependent tables, original schema and migration ledger',t=>{
    const {db}=atSix(t);seed(db);const schema=db.prepare("SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),rows=db.prepare('SELECT * FROM Messages').all(),receipts=db.prepare('SELECT * FROM MessageReceipts').all(),attachments=db.prepare('SELECT * FROM Attachments').all();
    const dir=temporary(t);for(const m of loadMigrations())fs.writeFileSync(path.join(dir,m.name),m.sql+(m.version===7?'\nINSERT INTO MissingTable VALUES(1);':''));
    assert.throws(()=>migrate(db,{directory:dir}),{code:'MIGRATION_FAILED'});assert.deepEqual(db.prepare("SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),schema);
    assert.deepEqual(db.prepare('SELECT * FROM Messages').all(),rows);assert.deepEqual(db.prepare('SELECT * FROM MessageReceipts').all(),receipts);assert.deepEqual(db.prepare('SELECT * FROM Attachments').all(),attachments);assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
test('fresh migration 7 enforces key ownership, immutable history, monotonic states and epoch foreign keys',t=>{
    const {db}=fixture(t);assert.equal(db.prepare('SELECT max(version) v FROM SchemaMigrations').get().v,7);assert.deepEqual(db.pragma('foreign_key_check'),[]);
    for(const name of ['DeviceKeys','ConversationKeyEpochs','ConversationKeyWraps'])assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    assert.throws(()=>db.prepare('INSERT INTO DeviceKeys(device_key_id,user_id,device_id,key_version,created_at,agreement_public_key,signing_public_key,signature,registered_at) VALUES(?,?,?,?,?,?,?,?,?)').run('k'.repeat(43),'missing','d'.repeat(22),1,'time','p'.repeat(87),'q'.repeat(87),'s'.repeat(86),'time'));
});
