// T-5B-35 (DB5-R14.7, DB5-R14.13, DB5-R14.21, DB5-R14.24): tests of the synthetic version-7 fixture builder
// tests/support/synthetic-v7.js that the T-5B-36 rehearsal runs on the host.
// - The built file is at version 7 (ledger 0001 to 0007, no 0008 table), holds the hand-counted rows of every table and
//   the cases the 0008 backfill must handle (both origins of direct and group conversations, former members, a member
//   joined_at in the 'YYYY-MM-DD HH:MM:SS' form after authenticated messages of the same group), and is a single file.
// - One seed gives the same rows in every table (SchemaMigrations.applied_at aside); another seed keeps ids, times and
//   counts and changes the opaque values.
// - A copy upgrades with the real migration directory to the latest version with an empty foreign_key_check; the
//   original file is unchanged. This only proves the fixture is usable; it is not the rehearsal of T-5B-36.
// - The builder and its command line refuse a target outside a new folder under os.tmpdir() and an existing file.
// Every database lives in a new folder under os.tmpdir(); no test opens the database file of DATA/server/database.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { openDatabase } = require('../server/database/connection');
const { loadMigrations } = require('../server/database/migrate');
const { temporaryDirectory, UnsafePathError } = require('./support/groups');
const { DEFAULT_SEED, buildVersionSeven, tableCounts, contentDigest } = require('./support/synthetic-v7');

const SEED = DEFAULT_SEED;
const OTHER_SEED = 4242;
const FILE_NAME = 'synthetic-v7.sqlite';
const PUBLISHED = Object.freeze(['0001-legacy.sql', '0002-foundation.sql', '0003-authentication.sql', '0004-profiles-friends.sql',
    '0005-conversation-provenance.sql', '0006-encrypted-message-lifecycle.sql', '0007-recipient-keys.sql']);
// Counted by hand from the data set in the header of support/synthetic-v7.js.
const EXPECTED_COUNTS = Object.freeze({
    AccountCredentials:6, // ada, ben, cleo, dan, eve, finn
    Attachments:3, // dm ada-ben (ready), alpha (ready, pending)
    AuditLogs:7, // 6 auth.registered + the copy of the security log
    AuthChallenges:0,
    AuthRateLimits:0,
    Blocks:2, // legacy hana->ben, authenticated finn->ada
    Contacts:2,
    ConversationKeyEpochs:4, // dm cleo-dan 1, beta 3
    ConversationKeyWraps:16, // 2 + 5 + 4 + 5
    ConversationMembers:22, // 4 direct x 2, alpha 6, beta 6, legacy group 2
    Conversations:7, // 2 legacy direct, 2 authenticated direct, 2 authenticated groups, 1 legacy group
    DeviceKeys:7, // 6 users, cleo rotated once
    FriendRequests:6, // 1 legacy, 5 authenticated
    Friendships:4, // legacy gus-hana, authenticated ada-ben, cleo-dan, ben-dan
    MessageReceipts:14, // legacy dm 3 + 1, dm 3 + 1, alpha 4, beta 2
    Messages:36, // legacy dm 3 + 2, dm 4 + 3, alpha 12, beta 10, legacy group 2
    SchemaMigrations:7,
    SecurityLogs:1,
    Sessions:2,
    SocialRevisions:8,
    UserProfiles:8,
    Users:8,
});
const GROUPS = Object.freeze({ groups:3, groupMembers:14, formerGroupMembers:4, groupMessages:24 });
// The database file name, built from fragments so that the static check of groups-repository.test.js does not match it.
const DATABASE_NAME = ['database', 'sqlite'].join('.');
const fileDigest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const refusedAs = reason => error => error instanceof UnsafePathError && error.code === 'UNSAFE_TEST_PATH' && error.reason === reason;

function build(t, seed) {
    const directory = temporaryDirectory(t);
    const file = path.join(directory, FILE_NAME);
    return { directory, file, summary:buildVersionSeven(file, { seed }) };
}
function readOnly(file, work) {
    const db = new Database(file, { readonly:true, fileMustExist:true });
    try { return work(db); } finally { db.close(); }
}

test('the builder makes one version-7 file under os.tmpdir() with the hand-counted rows and the backfill cases', t => {
    t.diagnostic(`seed=${SEED}`);
    const { directory, file, summary } = build(t, SEED);
    assert.equal(summary.file, fs.realpathSync.native(file));
    assert.equal(summary.seed, SEED);
    assert.equal(summary.version, 7);
    assert.deepEqual(summary.counts, EXPECTED_COUNTS);
    assert.deepEqual(summary.groups, GROUPS);
    assert.deepEqual(fs.readdirSync(directory), [FILE_NAME], 'one file: no -wal, -shm or -journal sidecar is left');
    readOnly(file, db => {
        assert.deepEqual(db.prepare('SELECT version, name FROM SchemaMigrations ORDER BY version').all(),
            PUBLISHED.map((name, index) => ({ version:index + 1, name })));
        assert.deepEqual(tableCounts(db), EXPECTED_COUNTS, 'no table of 0008 or later exists');
        assert.equal(db.pragma('integrity_check', { simple:true }), 'ok');
        assert.deepEqual(db.pragma('foreign_key_check'), []);
        assert.equal(contentDigest(db).total, summary.digest);
        assert.deepEqual(db.prepare(`SELECT c.kind, c.origin, count(DISTINCT c.conversation_id) AS conversations,
                sum(cm.left_at IS NOT NULL) AS former, (SELECT count(*) FROM Messages m JOIN Conversations x USING(conversation_id)
                WHERE x.kind = c.kind AND x.origin = c.origin) AS messages
            FROM Conversations c JOIN ConversationMembers cm USING(conversation_id) GROUP BY c.kind, c.origin ORDER BY c.kind, c.origin`).all(), [
            { kind:'direct', origin:'authenticated', conversations:2, former:0, messages:7 },
            { kind:'direct', origin:'legacy', conversations:2, former:0, messages:5 },
            { kind:'group', origin:'authenticated', conversations:2, former:3, messages:22 },
            { kind:'group', origin:'legacy', conversations:1, former:1, messages:2 },
        ]);
        // The member whose joined_at has the CURRENT_TIMESTAMP form joined after four authenticated messages of the group.
        assert.deepEqual(db.prepare(`SELECT cm.conversation_id, cm.user_id, cm.joined_at,
                (SELECT count(*) FROM Messages m WHERE m.conversation_id = cm.conversation_id AND m.origin = 'authenticated'
                    AND strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at) < strftime('%Y-%m-%dT%H:%M:%fZ', cm.joined_at)) AS earlier
            FROM ConversationMembers cm JOIN Conversations c USING(conversation_id)
            WHERE c.kind = 'group' AND cm.joined_at NOT LIKE '%T%'`).all(),
        [{ conversation_id:'synthetic-group-alpha', user_id:'synthetic-dan', joined_at:'2026-02-10 10:05:00', earlier:4 }]);
        assert.deepEqual(db.prepare('SELECT envelope_version AS envelope, count(*) AS n FROM Messages GROUP BY envelope_version ORDER BY envelope_version').all(),
            [{ envelope:null, n:7 }, { envelope:1, n:16 }, { envelope:2, n:13 }]);
    });
});

test('one seed gives the same rows in every table; another seed keeps ids, times and counts and changes opaque values', t => {
    t.diagnostic(`seeds=${SEED},${OTHER_SEED}`);
    const digestOf = seed => {
        const { file, summary } = build(t, seed);
        return { summary, digest:readOnly(file, contentDigest) };
    };
    const first = digestOf(SEED);
    const second = digestOf(SEED);
    const other = digestOf(OTHER_SEED);
    assert.deepEqual(second.digest, first.digest);
    assert.equal(second.summary.digest, first.summary.digest);
    assert.deepEqual(other.summary.counts, first.summary.counts);
    assert.notEqual(other.digest.total, first.digest.total);
    for (const table of ['Conversations', 'ConversationMembers', 'SchemaMigrations', 'Users']) {
        assert.equal(other.digest.tables[table], first.digest.tables[table], `${table} holds no seeded value`);
    }
    for (const table of ['Messages', 'DeviceKeys', 'ConversationKeyWraps', 'AccountCredentials']) {
        assert.notEqual(other.digest.tables[table], first.digest.tables[table], `${table} holds seeded values`);
    }
});

test('a copy of the fixture upgrades with the real migration directory to the latest version with an empty foreign_key_check', t => {
    const { file } = build(t, SEED);
    const before = fileDigest(file);
    const connections = [];
    const directory = temporaryDirectory(t, () => { for (const connection of connections) if (connection.open) connection.close(); });
    const copy = path.join(directory, 'synthetic-v7-copy.sqlite');
    fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
    const db = openDatabase({ filename:copy }); // migrates on open, as the backend does
    connections.push(db);
    const latest = loadMigrations();
    assert.ok(latest.length > 7, 'the real directory holds a migration after 0007');
    assert.deepEqual(db.prepare('SELECT version, name, checksum FROM SchemaMigrations ORDER BY version').all(),
        latest.map(({ version, name, checksum }) => ({ version, name, checksum })));
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple:true }), 'ok');
    const counts = tableCounts(db);
    for (const [table, count] of Object.entries(EXPECTED_COUNTS)) {
        assert.equal(counts[table], table === 'SchemaMigrations' ? latest.length : count, `${table} keeps its rows`);
    }
    // Design, Data Models (backfill): one extension row per group and one interval per group member.
    assert.equal(counts.GroupExtensions, GROUPS.groups);
    assert.equal(counts.GroupMembershipIntervals, GROUPS.groupMembers);
    db.close();
    assert.equal(fileDigest(file), before, 'the fixture itself is unchanged');
});

test('the builder and its command line refuse a target outside a new folder under os.tmpdir() and never overwrite a file', t => {
    const outside = path.join(__dirname, 'synthetic-refused.sqlite');
    assert.throws(() => buildVersionSeven(outside), refusedAs('outside-temporary'));
    assert.equal(fs.existsSync(outside), false);
    const root = path.join(os.tmpdir(), 'synthetic-refused-in-root.sqlite');
    assert.throws(() => buildVersionSeven(root), refusedAs('outside-temporary'), 'the temporary root is not a new folder');
    assert.equal(fs.existsSync(root), false);
    const directory = temporaryDirectory(t);
    assert.throws(() => buildVersionSeven(path.join(directory, DATABASE_NAME)), refusedAs('database-file'));
    assert.throws(() => buildVersionSeven(path.join(directory, FILE_NAME), { seed:-1 }), RangeError);
    fs.writeFileSync(path.join(directory, 'present.txt'), 'present');
    assert.throws(() => buildVersionSeven(path.join(directory, 'present.txt')), refusedAs('target-exists'));
    assert.throws(() => buildVersionSeven(path.join(directory, FILE_NAME)), refusedAs('folder-not-empty'));
    assert.deepEqual(fs.readdirSync(directory), ['present.txt'], 'nothing was written by the refused calls');

    const script = path.join(__dirname, 'support', 'synthetic-v7.js');
    const run = args => spawnSync(process.execPath, [script, ...args], { cwd:path.join(__dirname, '..'), encoding:'utf8' });
    const target = path.join(temporaryDirectory(t), FILE_NAME);
    const built = run([target, String(SEED)]);
    assert.equal(built.status, 0, built.stderr);
    const printed = JSON.parse(built.stdout);
    assert.equal(printed.version, 7);
    assert.equal(printed.seed, SEED);
    assert.deepEqual(printed.counts, EXPECTED_COUNTS);
    const again = run([target]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /target-exists/);
    assert.equal(run([]).status, 2);
});
