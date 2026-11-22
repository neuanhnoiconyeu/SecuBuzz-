const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture,legacy,temporary,Database } = require('./support/database');
const { migrate,loadMigrations } = require('../server/database/migrate');
const { openDatabase } = require('../server/database/connection');
const currentVersion=loadMigrations().length;

test('fresh initialization applies ordered migrations, tracks checksums and repeats safely', t => {
    const { db } = fixture(t);
    const history = db.prepare('SELECT * FROM SchemaMigrations ORDER BY version').all();
    assert.deepEqual(history.map(row => row.version),[1,2,3,4,5,6,7,8,9,10,11]);
    assert.ok(history.every(row => /^[a-f0-9]{64}$/.test(row.checksum)));
    assert.deepEqual(migrate(db),{version:currentVersion,applied:[]});
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('legacy upgrade preserves IDs, profiles, contact directions, ciphertext, times and audit provenance', t => {
    const { db } = legacy(t);
    const insertUser = db.prepare('INSERT INTO Users(user_id,username,display_name) VALUES(?,?,?)');
    for (const id of ['a','b','c','d']) insertUser.run(id,`old-${id}`,`Old ${id}`);
    db.exec(`INSERT INTO Contacts(contact_id,user_id,friend_id,status) VALUES
        ('accepted-ab','a','b','accepted'),('accepted-ba','b','a','accepted'),
        ('pending-ac','a','c','pending'),('blocked-ad','a','d','blocked');
        INSERT INTO Messages(message_id,sender_id,receiver_id,ciphertext,iv,created_at,delivered_at,read_at)
        VALUES('old-message','a','b','UNMODIFIED-CIPHERTEXT','UNMODIFIED-IV','2026-01-01 00:00:00','2026-01-02 00:00:00','2026-01-03 00:00:00');
        INSERT INTO SecurityLogs(log_id,user_id,event_type,severity,source,description,details_json)
        VALUES('old-log','a','legacy.event','HIGH','sentinel_bot','original description','{"original":"preserved"}');`);
    const before = Object.fromEntries(['Users','Contacts','Messages','SecurityLogs'].map(table => [table,db.prepare(`SELECT * FROM ${table}`).all()]));
    migrate(db);
    for (const [table,rows] of Object.entries(before)) {
        const columns = Object.keys(rows[0]).join(',');
        assert.deepEqual(db.prepare(`SELECT ${columns} FROM ${table}`).all(),rows);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM Friendships').get().n,1);
    assert.equal(db.prepare('SELECT request_id FROM FriendRequests').get().request_id,'pending-ac');
    assert.deepEqual(db.prepare('SELECT blocker_id,blocked_id FROM Blocks').get(),{blocker_id:'a',blocked_id:'d'});
    assert.equal(db.prepare('SELECT count(*) AS n FROM UserProfiles').get().n,4);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ConversationMembers').get().n,2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM MessageReceipts').get().n,2);
    assert.equal(db.prepare('SELECT metadata_json FROM AuditLogs').get().metadata_json,'{}');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.deepEqual(migrate(db).applied,[]);
});

test('legacy DM identifiers do not collide when user IDs include separators', t => {
    const { db } = legacy(t);
    for (const id of ['a','b:c','a:b','c']) db.prepare('INSERT INTO Users(user_id,username,display_name) VALUES(?,?,?)').run(id,id,id);
    db.exec(`INSERT INTO Messages(message_id,sender_id,receiver_id,ciphertext,iv) VALUES
        ('one','a','b:c','cipher','iv'),('two','a:b','c','cipher','iv')`);
    migrate(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM Conversations').get().n,2);
});

for (const [label, setup, code] of [
    ['reversed pending requests',"INSERT INTO Contacts(contact_id,user_id,friend_id) VALUES('x','a','b'),('y','b','a')",'AMBIGUOUS_LEGACY_CONTACTS'],
    ['conflicting relationship statuses',"INSERT INTO Contacts(contact_id,user_id,friend_id,status) VALUES('x','a','b','accepted'),('y','b','a','blocked')",'AMBIGUOUS_LEGACY_CONTACTS'],
    ['self messages',"INSERT INTO Messages(message_id,sender_id,receiver_id,ciphertext,iv) VALUES('x','a','a','cipher','iv')",'INVALID_LEGACY_MESSAGE'],
    ['blank user identities',"UPDATE Users SET username='' WHERE user_id='a'",'INVALID_LEGACY_USER']
]) test(`unsafe legacy ${label} fail without partial changes`, t => {
    const { db } = legacy(t);
    db.exec("INSERT INTO Users(user_id,username,display_name) VALUES('a','a','A'),('b','b','B')");
    db.exec(setup);
    assert.throws(() => migrate(db), {code});
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='SchemaMigrations'").get().n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM Users').get().n,2);
});

test('foreign key violations in legacy data are detected without adoption', t => {
    const { db } = legacy(t);
    db.pragma('foreign_keys=OFF');
    db.exec("INSERT INTO Contacts(contact_id,user_id,friend_id) VALUES('bad','missing','also-missing')");
    db.pragma('foreign_keys=ON');
    assert.throws(() => migrate(db), {code:'LEGACY_FOREIGN_KEY_VIOLATION'});
});

test('foreign legacy schema variants and unknown tables fail safely', t => {
    const { db } = legacy(t);
    db.exec('ALTER TABLE Messages ADD COLUMN unexpected TEXT');
    assert.throws(() => migrate(db), {code:'UNSUPPORTED_LEGACY_SCHEMA'});
    assert.ok(db.prepare('PRAGMA table_info(Messages)').all().some(row => row.name === 'unexpected'));
});

test('legacy CHECK literal differences are not treated as harmless whitespace', t => {
    const { db } = fixture(t,{migrate:false});
    const baseline = loadMigrations()[0].sql.replace("'offline'","'off line'");
    db.exec(baseline);
    assert.throws(() => migrate(db),{code:'UNSUPPORTED_LEGACY_SCHEMA'});
});

test('a pre-existing empty ledger cannot bypass validation of an unknown legacy schema', t => {
    const { db } = fixture(t,{migrate:false});
    db.exec('CREATE TABLE SchemaMigrations(version INTEGER,name TEXT,checksum TEXT)');
    assert.throws(() => migrate(db),{code:'MIGRATION_HISTORY_MISMATCH'});
});

test('failed migration rolls back the complete pending batch and history, including table rebuild', t => {
    const { db } = legacy(t);
    db.exec("INSERT INTO Users(user_id,username,display_name) VALUES('a','a','A'),('b','b','B'); INSERT INTO Messages(message_id,sender_id,receiver_id,ciphertext,iv) VALUES('old','a','b','cipher','iv')");
    const directory = temporary(t);
    for (const migration of loadMigrations()) fs.writeFileSync(path.join(directory,migration.name),migration.sql);
    fs.writeFileSync(path.join(directory,`${String(currentVersion+1).padStart(4,'0')}-fail.sql`), 'CREATE TABLE MustRollback(id TEXT); INSERT INTO MissingTable VALUES(1);');
    assert.throws(() => migrate(db,{directory}), {code:'MIGRATION_FAILED'});
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('MustRollback','SchemaMigrations','Conversations')").get().n,0);
    assert.equal(db.prepare('SELECT ciphertext FROM Messages').get().ciphertext,'cipher');
    assert.ok(!db.prepare('PRAGMA table_info(Messages)').all().some(row => row.name === 'conversation_id'));
    migrate(db);
});

test('migration checksums and future versions cannot be silently changed', t => {
    const { db } = fixture(t);
    db.prepare('UPDATE SchemaMigrations SET checksum=? WHERE version=2').run('0'.repeat(64));
    assert.throws(() => migrate(db), {code:'MIGRATION_HISTORY_MISMATCH'});
});

test('a failed later migration preserves previously committed versions and user data', t => {
    const { db } = fixture(t);
    db.exec("INSERT INTO Users(user_id,username,display_name) VALUES('a','a','A')");
    const directory = temporary(t);
    for (const migration of loadMigrations()) fs.writeFileSync(path.join(directory,migration.name),migration.sql);
    fs.writeFileSync(path.join(directory,`${String(currentVersion+1).padStart(4,'0')}-fail.sql`),"CREATE TABLE MustRollback(id TEXT); UPDATE Users SET display_name='Changed'; INSERT INTO Absent VALUES(1);");
    assert.throws(() => migrate(db,{directory}),{code:'MIGRATION_FAILED'});
    assert.equal(db.prepare('SELECT display_name FROM Users').get().display_name,'A');
    assert.equal(db.prepare('SELECT count(*) AS n FROM SchemaMigrations').get().n,currentVersion);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='MustRollback'").get().n,0);
});

test('migration checksums survive Windows/Unix line-ending changes', t => {
    const { db } = fixture(t);
    const directory=temporary(t);
    for (const migration of loadMigrations()) fs.writeFileSync(path.join(directory,migration.name),migration.sql.replace(/\r?\n/g,'\r\n'));
    assert.deepEqual(migrate(db,{directory}),{version:currentVersion,applied:[]});
});

test('migration order, disabled foreign keys and nested transactions fail clearly', t => {
    const { db } = fixture(t);
    const directory = temporary(t);
    fs.writeFileSync(path.join(directory,'0002-out-of-order.sql'),'SELECT 1;');
    assert.throws(() => migrate(db,{directory}), {code:'INVALID_MIGRATION_ORDER'});
    db.pragma('foreign_keys=OFF');
    assert.throws(() => migrate(db), {code:'FOREIGN_KEYS_DISABLED'});
    db.pragma('foreign_keys=ON');
    assert.throws(() => db.transaction(() => migrate(db))(), {code:'MIGRATION_REQUIRES_OWN_TRANSACTION'});
});

test('data persists across a real process restart and CLI migrations repeat', t => {
    const { db,filename } = fixture(t);
    db.exec("INSERT INTO Users(user_id,username,display_name) VALUES('restart','restart','Restart')");
    db.close();
    const run = () => spawnSync(process.execPath,[path.join(__dirname,'../scripts/migrate.js')], {
        env:{...process.env,DB_PATH:filename}, encoding:'utf8'
    });
    for (let i=0;i<2;i++) { const result=run(); assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/0 migration\(s\) applied/); }
    const reopened = openDatabase({filename});
    try { assert.equal(reopened.prepare('SELECT username FROM Users').get().username,'restart'); }
    finally { reopened.close(); }
});

test('a process terminated during an uncommitted write leaves no partial schema after restart', t => {
    const { db,filename } = fixture(t);
    db.close();
    const source = `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);db.exec('BEGIN IMMEDIATE; CREATE TABLE Interrupted(id TEXT);');process.exit(17);`;
    const result = spawnSync(process.execPath,['-e',source,filename], {cwd:path.join(__dirname,'..'),encoding:'utf8'});
    assert.equal(result.status,17,result.stderr);
    const reopened = new Database(filename);
    try { assert.equal(reopened.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='Interrupted'").get().n,0); }
    finally { reopened.close(); }
});
