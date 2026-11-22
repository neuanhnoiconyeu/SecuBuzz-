// T-5B-16 (DB5-R14.13, DB5-R14.7, DB5-R08.3, COMP-03; design Data Models, "Backfill of existing rows").
// Upgrade example of migration 0008: a version-7 database is built from temporary copies of 0001 to 0007 (the runner's
// options.directory), populated with an authenticated group (active and former members, messages, a receipt, a key
// epoch and an attachment), a legacy-origin group, a group without members, authenticated and legacy direct
// conversations with messages and receipts, key rows, social rows, legacy rows and attachments, and is then upgraded
// with the real migration directory.
//
// Isolation (DB5-R14.17): every database is a file that support/database.js fixture() creates in a new folder under
// os.tmpdir() and removes after the test, and the migration copies go to a second temporary folder made by
// temporary(). No test opens server/database/database.sqlite, a Docker volume or any file under /var/lib/secubuzz/,
// and none starts a container. All timestamps are fixed strings; nothing reads the clock or a random source.
//
// T-5B-17 (DB5-R14.6, R14.9, R14.10, R14.11, R14.16, R14.17, R14.19, R14.21, DB5-R11.2, DB5-R02.13, DB5-R08.1,
// ARCH-R01.10, NFR-04; design "Migration plan" and Testing Strategy section 7) appends the structural cases (a), (c),
// (d), (g), (h), (i), the one-way check and the static scan of DATA for the Standalone_Implementation. Their databases
// and migration copies live in folders made by support/groups.js (groupDatabase, temporaryDirectory), and guardPath
// checks every database path before it is opened. No case starts a container or a child process.
//
// T-5B-18 (DB5-R14.3, R14.6, R14.7, R14.8, R14.11, R14.13, DB5-R09.15, DB5-R08.3, ARCH-R01.11, ARCH-R02.5, COMP-03;
// design Correctness Properties P-27 and Testing Strategy section 7 case (b)) appends property P-27: P27_RUNS generated
// version-7 databases, each in a new guarded folder, are upgraded with the real migration directory. The generator
// (support/random.js, seed P27_SEED) moves its own clock; no value comes from Math.random or the wall clock.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fixture, temporary } = require('./support/database');
const { guardPath, temporaryDirectory, groupDatabase } = require('./support/groups');
const { loadMigrations, migrate } = require('../server/database/migrate');
const { openDatabase } = require('../server/database/connection');
const { permittedRanges, inRanges } = require('../server/groups/policy');
const { createKeyRepository } = require('../server/e2ee/repository');
const { splitStatements } = require('./support/migration-lint');
const { forAll } = require('./support/random');

// OP-07 (provisional default, reported in the DB-5B handoff): generated version-7 databases of P-27 (at least 100).
// Replay one case with PROPERTY_SEED=<seed> PROPERTY_RUN=<run> node --test tests/groups-migrations.test.js in DATA/.
const P27_RUNS = 100;
const P27_SEED = 27118;
// P-28 is a fuzz property: 100 cases for each branch, replayable through support/random.js.
const P28_RUNS = 100;
const P28_SEED = 28119;

const MIGRATIONS = path.join(__dirname, '..', 'server', 'database', 'migrations');
const PUBLISHED = Object.freeze(['0001-legacy.sql', '0002-foundation.sql', '0003-authentication.sql', '0004-profiles-friends.sql',
    '0005-conversation-provenance.sql', '0006-encrypted-message-lifecycle.sql', '0007-recipient-keys.sql']);
const NEW_TABLES = Object.freeze(['ConversationInvitations', 'GroupCreationKeys', 'GroupExtensions', 'GroupMembershipIntervals',
    'GroupReadPositions']);

// A version-7 database: the runner applies copies of 0001 to 0007 from a temporary directory.
function atVersionSeven(t) {
    const f = fixture(t, { migrate: false });
    guardPath(f.filename);
    const directory = temporary(t);
    const published = loadMigrations().filter(migration => migration.version <= 7);
    assert.deepEqual(published.map(migration => migration.name), PUBLISHED);
    for (const migration of published) fs.writeFileSync(path.join(directory, migration.name), migration.sql);
    assert.deepEqual(migrate(f.db, { directory }), { version: 7, applied: PUBLISHED });
    return f;
}

// Test-only insert; table and column names are literals of this file, every value is a bound parameter.
function insert(db, table, row) {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(row));
}

const DAY = '2026-03-01T';
const SETUP = '2026-01-01T00:00:00.000Z';
const LEGACY_TIME = '2025-12-01 10:00:00'; // the CURRENT_TIMESTAMP format of 0001
const DEVICE_KEY = 'K'.repeat(43);
const envelope = (id, conversation, sender, receiver, seq, createdAt) => ({
    message_id: id, conversation_id: conversation, sender_id: sender, receiver_id: receiver,
    ciphertext: `OPAQUE_${id}`, iv: `IV_${id}`, envelope_version: 1, encoding: 'base64', sender_name: sender,
    client_timestamp: createdAt, message_type: 'text', fingerprint: 'a'.repeat(64), client_id: `client-${id}`,
    origin: 'authenticated', message_seq: seq, created_at: createdAt, updated_at: createdAt,
});

// Authenticated group grp-team. Members are inserted active, the messages are sent, then the former members leave
// (messages_member_insert accepts only an active sender).
const TEAM_MEMBERS = Object.freeze([
    { user_id: 'u-alice', role: 'owner', joined_at: `${DAY}08:00:00.000Z`, left_at: null },
    { user_id: 'u-bob', role: 'admin', joined_at: `${DAY}08:00:00.000Z`, left_at: null },
    { user_id: 'u-carol', role: 'member', joined_at: `${DAY}09:00:00.000Z`, left_at: `${DAY}11:00:00.000Z` },
    { user_id: 'u-dave', role: 'member', joined_at: '2026-03-01 10:00:00', left_at: null }, // another timestamp format
    { user_id: 'u-erin', role: 'member', joined_at: `${DAY}12:00:00.000Z`, left_at: `${DAY}12:30:00.000Z` },
    { user_id: 'u-frank', role: 'member', joined_at: `${DAY}08:00:00.000Z`, left_at: `${DAY}08:05:00.000Z` },
]);
const TEAM_MESSAGES = Object.freeze([
    [1, 'u-alice', `${DAY}08:10:00.000Z`], [2, 'u-bob', `${DAY}08:40:00.000Z`], [3, 'u-alice', `${DAY}09:00:00.000Z`],
    [4, 'u-carol', `${DAY}09:30:00.000Z`], [5, 'u-dave', `${DAY}10:30:00.000Z`], [6, 'u-alice', `${DAY}11:00:00.000Z`],
    [7, 'u-bob', `${DAY}11:30:00.000Z`],
]);
// Hand-derived intervals of grp-team after the upgrade, one per boundary case of the rule.
const TEAM_INTERVALS = Object.freeze({
    'u-alice': [1, null], // joined before the first message, active
    'u-bob': [1, null],
    'u-carol': [3, 6], // joined at the instant of seq 3 (at or after), left at the instant of seq 6 (at or before)
    'u-dave': [5, null], // joined at 10:00 in the format 'YYYY-MM-DD HH:MM:SS'; seq 1 to 4 are older
    'u-erin': [8, 7], // joined after the last message: first_seq = 7 + 1; empty period, last_seq = first_seq - 1
    'u-frank': [1, 0], // no message at or before left_at: last_seq = first_seq - 1
});

function seed(db) {
    for (const name of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
        insert(db, 'Users', { user_id: `u-${name}`, username: name, display_name: `Fixture ${name}`, last_seen: SETUP, created_at: SETUP });
    }
    db.prepare('UPDATE UserProfiles SET created_at=?, updated_at=?').run(SETUP, SETUP);
    insert(db, 'AccountCredentials', { user_id: 'u-alice', username_key: 'alice', email_key: 'alice@example.test',
        password_hash: '$argon2id$fixture-not-a-hash', created_at: SETUP, updated_at: SETUP });
    insert(db, 'Sessions', { session_id: 'session-alice', user_id: 'u-alice', token_hash: 'ab'.repeat(32), issued_at_ms: 1000,
        expires_at_ms: 2000, auth_version: 1, created_at: SETUP });
    insert(db, 'AuditLogs', { audit_id: 'audit-1', actor_user_id: 'u-alice', event_type: 'fixture', source: 'test', created_at: SETUP });

    // Social rows and legacy rows.
    insert(db, 'FriendRequests', { request_id: 'request-carol-erin', sender_id: 'u-carol', recipient_id: 'u-erin',
        created_at: SETUP, origin: 'authenticated' });
    insert(db, 'Friendships', { user_low: 'u-alice', user_high: 'u-bob', created_at: SETUP, origin: 'authenticated' });
    insert(db, 'Blocks', { blocker_id: 'u-frank', blocked_id: 'u-erin', created_at: SETUP, origin: 'authenticated' });
    insert(db, 'Contacts', { contact_id: 'contact-dave-frank', user_id: 'u-dave', friend_id: 'u-frank', status: 'accepted',
        created_at: LEGACY_TIME });
    insert(db, 'SecurityLogs', { log_id: 'security-1', user_id: 'u-alice', event_type: 'login', severity: 'LOW',
        source: 'auditor_bot', description: 'fixture', details_json: '{}', created_at: LEGACY_TIME });

    // Authenticated direct conversation. Its sequences 1 to 3 fall inside erin's period in grp-team, so a backfill that
    // read another conversation's messages would give erin a different interval.
    insert(db, 'Conversations', { conversation_id: 'dm-alice-bob', kind: 'direct', dm_user_low: 'u-alice', dm_user_high: 'u-bob',
        created_at: '2026-01-10T00:00:00.000Z', updated_at: '2026-01-10T00:00:00.000Z', origin: 'authenticated' });
    for (const user of ['u-alice', 'u-bob']) {
        insert(db, 'ConversationMembers', { conversation_id: 'dm-alice-bob', user_id: user, joined_at: '2026-01-10T00:00:00.000Z' });
    }
    insert(db, 'Messages', envelope('dm-1', 'dm-alice-bob', 'u-alice', 'u-bob', 1, `${DAY}12:10:00.000Z`));
    insert(db, 'Messages', envelope('dm-2', 'dm-alice-bob', 'u-bob', 'u-alice', 2, `${DAY}12:15:00.000Z`));
    insert(db, 'Messages', envelope('dm-3', 'dm-alice-bob', 'u-alice', 'u-bob', 3, `${DAY}12:20:00.000Z`));
    insert(db, 'MessageReceipts', { conversation_id: 'dm-alice-bob', message_id: 'dm-1', user_id: 'u-bob', status: 'read',
        observed_at: `${DAY}12:11:00.000Z`, recorded_at: `${DAY}12:11:00.000Z` });

    // Legacy direct conversation with a legacy message and receipt.
    insert(db, 'Conversations', { conversation_id: 'dm-carol-dave-legacy', kind: 'direct', dm_user_low: 'u-carol',
        dm_user_high: 'u-dave', created_at: LEGACY_TIME, updated_at: LEGACY_TIME });
    for (const user of ['u-carol', 'u-dave']) {
        insert(db, 'ConversationMembers', { conversation_id: 'dm-carol-dave-legacy', user_id: user, joined_at: LEGACY_TIME });
    }
    insert(db, 'Messages', { message_id: 'legacy-1', conversation_id: 'dm-carol-dave-legacy', sender_id: 'u-carol',
        receiver_id: 'u-dave', ciphertext: 'LEGACY_CIPHERTEXT', iv: 'LEGACY_IV', created_at: LEGACY_TIME, updated_at: LEGACY_TIME,
        delivered_at: '2025-12-01 10:05:00' });
    insert(db, 'MessageReceipts', { conversation_id: 'dm-carol-dave-legacy', message_id: 'legacy-1', user_id: 'u-dave',
        status: 'delivered', observed_at: '2025-12-01 10:05:00', recorded_at: '2025-12-01 10:05:00' });

    // Authenticated group grp-team with active and former members.
    insert(db, 'Conversations', { conversation_id: 'grp-team', kind: 'group', title: 'Team', created_by: 'u-alice',
        created_at: `${DAY}08:00:00.000Z`, updated_at: `${DAY}11:30:00.000Z`, origin: 'authenticated' });
    for (const { user_id, role, joined_at } of TEAM_MEMBERS) {
        insert(db, 'ConversationMembers', { conversation_id: 'grp-team', user_id, role, joined_at });
    }
    for (const [seq, sender, createdAt] of TEAM_MESSAGES) {
        insert(db, 'Messages', envelope(`team-${seq}`, 'grp-team', sender, null, seq, createdAt));
    }
    db.prepare("UPDATE Messages SET deleted_at=?, updated_at=?, revision=1 WHERE message_id='team-2'")
        .run(`${DAY}08:50:00.000Z`, `${DAY}08:50:00.000Z`);
    insert(db, 'MessageReceipts', { conversation_id: 'grp-team', message_id: 'team-1', user_id: 'u-bob', status: 'read',
        observed_at: `${DAY}08:20:00.000Z`, recorded_at: `${DAY}08:20:00.000Z` });
    for (const { user_id, left_at } of TEAM_MEMBERS) {
        if (left_at !== null) db.prepare("UPDATE ConversationMembers SET left_at=? WHERE conversation_id='grp-team' AND user_id=?").run(left_at, user_id);
    }

    // Key rows (one device, one epoch with one wrap in the direct conversation and in grp-team) and attachments.
    insert(db, 'DeviceKeys', { device_key_id: DEVICE_KEY, user_id: 'u-alice', device_id: 'D'.repeat(22), key_version: 1,
        created_at: SETUP, agreement_public_key: 'A'.repeat(87), signing_public_key: 'S'.repeat(87), signature: 'G'.repeat(86),
        registered_at: SETUP });
    for (const [conversation, keyId] of [['dm-alice-bob', 'E'.repeat(22)], ['grp-team', 'F'.repeat(22)]]) {
        insert(db, 'ConversationKeyEpochs', { conversation_id: conversation, key_id: keyId, epoch: 1, previous_key_id: null,
            creator_user_id: 'u-alice', creator_device_key_id: DEVICE_KEY, created_at: SETUP, signature: 'G'.repeat(86),
            recipient_set_digest: 'R'.repeat(43), published_at: SETUP });
        insert(db, 'ConversationKeyWraps', { conversation_id: conversation, key_id: keyId, position: 0, recipient_user_id: 'u-alice',
            recipient_device_key_id: DEVICE_KEY, enc: 'N'.repeat(87), ciphertext: 'C'.repeat(64) });
    }
    insert(db, 'Attachments', { attachment_id: 'attachment-dm', conversation_id: 'dm-alice-bob', message_id: 'dm-1',
        uploaded_by: 'u-alice', storage_key: 'opaque-dm', byte_size: 10, status: 'ready', created_at: SETUP, updated_at: SETUP });
    insert(db, 'Attachments', { attachment_id: 'attachment-team', conversation_id: 'grp-team', message_id: 'team-1',
        uploaded_by: 'u-bob', storage_key: 'opaque-team', byte_size: 20, created_at: SETUP, updated_at: SETUP });

    // Legacy-origin group (origin defaults to legacy) with a legacy message, and an authenticated group without members.
    insert(db, 'Conversations', { conversation_id: 'grp-old', kind: 'group', title: 'Old group', created_by: 'u-carol',
        created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z' });
    insert(db, 'ConversationMembers', { conversation_id: 'grp-old', user_id: 'u-carol', role: 'owner', joined_at: '2026-02-01T00:00:00.000Z' });
    insert(db, 'ConversationMembers', { conversation_id: 'grp-old', user_id: 'u-dave', role: 'member', joined_at: '2026-02-01T00:00:00.000Z' });
    insert(db, 'Messages', { message_id: 'old-1', conversation_id: 'grp-old', sender_id: 'u-carol', receiver_id: null,
        ciphertext: 'OLD_CIPHERTEXT', iv: 'OLD_IV', created_at: '2026-02-01T01:00:00.000Z', updated_at: '2026-02-01T01:00:00.000Z' });
    db.prepare("UPDATE ConversationMembers SET left_at=? WHERE conversation_id='grp-old' AND user_id='u-dave'").run('2026-02-02T00:00:00.000Z');
    insert(db, 'Conversations', { conversation_id: 'grp-empty', kind: 'group', title: 'Empty', created_at: '2026-03-02T00:00:00.000Z',
        updated_at: '2026-03-02T00:00:00.000Z', origin: 'authenticated' });
}

// 'YYYY-MM-DD HH:MM:SS' (UTC, the CURRENT_TIMESTAMP format) and ISO strings, as instants in milliseconds.
function instant(text) {
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
    const value = Date.parse(iso);
    assert.ok(Number.isFinite(value), `fixture timestamp ${text} parses`);
    return value;
}

// The rule of the design, computed from the version-7 rows: first_seq is the lowest sequence of an authenticated
// message created at or after joined_at, otherwise the highest sequence plus 1; for a member with left_at, last_seq is
// the highest sequence created at or before left_at, otherwise first_seq - 1; an active member has an open interval.
function expectedInterval(member, messages) {
    const highest = messages.reduce((max, message) => Math.max(max, message.message_seq), 0);
    const joined = instant(member.joined_at);
    const fromJoin = messages.filter(message => instant(message.created_at) >= joined).map(message => message.message_seq);
    const first = fromJoin.length ? Math.min(...fromJoin) : highest + 1;
    let last = null;
    if (member.left_at !== null) {
        const left = instant(member.left_at);
        const untilLeave = messages.filter(message => instant(message.created_at) <= left).map(message => message.message_seq);
        last = untilLeave.length ? Math.max(...untilLeave) : first - 1;
    }
    return { conversation_id: member.conversation_id, user_id: member.user_id, interval_no: 1, first_seq: first, last_seq: last,
        joined_at: member.joined_at, left_at: member.left_at };
}

const tableNames = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
function digest(db, table, where = '') {
    const rows = db.prepare(`SELECT * FROM ${table} ${where} ORDER BY rowid`).all();
    return { rows: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}
const laterNames = () => loadMigrations().filter(migration => migration.version > 7).map(migration => migration.name);

test('upgrade from version 7: every group of any origin gets one from_joined extension row and each member one interval by the sequence rule', t => {
    const { db } = atVersionSeven(t);
    seed(db);
    const groups = db.prepare("SELECT conversation_id, created_at FROM Conversations WHERE kind='group' ORDER BY conversation_id").all();
    const members = db.prepare(`SELECT cm.conversation_id, cm.user_id, cm.joined_at, cm.left_at FROM ConversationMembers cm
        JOIN Conversations c ON c.conversation_id = cm.conversation_id WHERE c.kind='group' ORDER BY cm.conversation_id, cm.user_id`).all();
    const messagesOf = conversation => db.prepare(`SELECT message_seq, created_at FROM Messages
        WHERE conversation_id=? AND origin='authenticated' ORDER BY message_seq`).all(conversation);
    const groupMessages = Object.fromEntries(groups.map(group => [group.conversation_id, messagesOf(group.conversation_id)]));
    assert.deepEqual(groups.map(group => group.conversation_id), ['grp-empty', 'grp-old', 'grp-team']);
    assert.equal(db.prepare("SELECT origin FROM Conversations WHERE conversation_id='grp-old'").get().origin, 'legacy');
    assert.equal(members.filter(member => member.left_at !== null).length, 4, 'former members of both origins');

    const result = migrate(db);
    assert.deepEqual(result.applied, laterNames());
    assert.equal(result.applied[0], '0008-groups.sql');

    // DB5-R14.13: one extension row per group conversation of any origin, never for a direct conversation.
    const extensions = db.prepare('SELECT * FROM GroupExtensions ORDER BY conversation_id').all();
    assert.deepEqual(extensions, groups.map(group => ({ conversation_id: group.conversation_id, description: null,
        history_policy: 'from_joined', membership_revision: 1, created_at: group.created_at })));
    assert.ok(extensions.every(row => row.history_policy === 'from_joined'));

    // DB5-R08.3: one interval per existing group member, by the rule; none for a direct member.
    const intervals = db.prepare('SELECT * FROM GroupMembershipIntervals ORDER BY conversation_id, user_id, interval_no').all();
    assert.deepEqual(intervals, members.map(member => expectedInterval(member, groupMessages[member.conversation_id])));
    const pinned = Object.fromEntries(intervals.filter(row => row.conversation_id === 'grp-team')
        .map(row => [row.user_id, [row.first_seq, row.last_seq]]));
    assert.deepEqual(pinned, TEAM_INTERVALS);
    assert.deepEqual(intervals.filter(row => row.conversation_id === 'grp-old').map(row => [row.user_id, row.first_seq, row.last_seq]),
        [['u-carol', 1, null], ['u-dave', 1, 0]], 'a group without authenticated messages starts at sequence 1');

    // No member's permitted range includes a message created before joining (or, for a former member, after leaving).
    const policyOf = Object.fromEntries(extensions.map(row => [row.conversation_id, row.history_policy]));
    let beforeJoin = 0;
    for (const member of members) {
        const own = intervals.filter(row => row.conversation_id === member.conversation_id && row.user_id === member.user_id);
        const ranges = permittedRanges(own, policyOf[member.conversation_id]);
        for (const message of groupMessages[member.conversation_id]) {
            const label = `${member.conversation_id} ${member.user_id} seq ${message.message_seq}`;
            if (instant(message.created_at) < instant(member.joined_at)) {
                beforeJoin += 1;
                assert.equal(inRanges(message.message_seq, ranges), false, `${label} was created before joining`);
            }
            if (member.left_at !== null && instant(message.created_at) > instant(member.left_at)) {
                assert.equal(inRanges(message.message_seq, ranges), false, `${label} was created after leaving`);
            }
        }
    }
    assert.ok(beforeJoin >= 10, `messages created before joining were checked (${beforeJoin})`);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});

test('upgrade from version 7 keeps every row and value of every version-7 table (row digests before and after)', t => {
    const { db } = atVersionSeven(t);
    seed(db);
    const tables = tableNames(db);
    const snapshot = () => Object.fromEntries(tables.map(table =>
        [table, table === 'SchemaMigrations' ? digest(db, table, 'WHERE version <= 7') : digest(db, table)]));
    const before = snapshot();
    for (const table of ['Users', 'UserProfiles', 'AccountCredentials', 'Sessions', 'SocialRevisions', 'FriendRequests', 'Friendships',
        'Blocks', 'Contacts', 'SecurityLogs', 'AuditLogs', 'Conversations', 'ConversationMembers', 'Messages', 'MessageReceipts',
        'DeviceKeys', 'ConversationKeyEpochs', 'ConversationKeyWraps', 'Attachments']) {
        assert.ok(before[table].rows > 0, `${table} holds rows before the upgrade`);
    }

    assert.deepEqual(migrate(db).applied, laterNames());
    assert.deepEqual(snapshot(), before);
    const added = tableNames(db).filter(name => !tables.includes(name));
    assert.deepEqual(added.filter(name => NEW_TABLES.includes(name)), NEW_TABLES, 'the five tables of 0008 are added');
    assert.deepEqual(db.prepare('SELECT version FROM SchemaMigrations ORDER BY version').all().map(row => row.version),
        loadMigrations().map(migration => migration.version));
});

test('the 0008 backfill is two INSERT ... SELECT statements that read only Conversations, ConversationMembers and Messages', t => {
    const { db } = atVersionSeven(t);
    const versionSeven = tableNames(db).map(name => name.toUpperCase());
    const sql = fs.readFileSync(path.join(MIGRATIONS, '0008-groups.sql'), 'utf8');
    const { statements, problems } = splitStatements(sql);
    assert.deepEqual(problems, []);
    // Outside trigger bodies the file only creates objects and inserts: no UPDATE, DELETE, DROP, ALTER or REPLACE.
    assert.deepEqual([...new Set(statements.map(statement => statement.keyword))].sort(), ['CREATE', 'INSERT']);
    const inserts = statements.filter(statement => statement.keyword === 'INSERT');
    assert.deepEqual(inserts.map(statement => /^INSERT INTO (\w+) \( [^()]* \) SELECT /.exec(statement.text)?.[1]),
        ['GroupExtensions', 'GroupMembershipIntervals']);
    // The version-7 tables named by each statement: no receipt, key, social, legacy, account or attachment table.
    const named = inserts.map(statement => {
        const tokens = new Set(statement.text.split(' ').map(token => token.toUpperCase()));
        return versionSeven.filter(name => tokens.has(name)).sort();
    });
    assert.deepEqual(named, [['CONVERSATIONS'], ['CONVERSATIONMEMBERS', 'CONVERSATIONS', 'MESSAGES']]);
});

// ---------------------------------------------------------------------------------------------------------------
// T-5B-17: structural cases (a), (c), (d), (g), (h), (i), the one-way check and the static scan.
// ---------------------------------------------------------------------------------------------------------------
const MIGRATION_FILE = /^\d{4}-[a-z0-9-]+\.sql$/;

// The migration files as the directory lists them, in runner order, with the SHA-256 of the LF-normalised text.
// Computed here from the listing and the bytes, independently of loadMigrations.
function listedMigrations() {
    return fs.readdirSync(MIGRATIONS).filter(name => MIGRATION_FILE.test(name)).sort().map((name, index) => ({
        version: index + 1,
        name,
        checksum: createHash('sha256').update(fs.readFileSync(path.join(MIGRATIONS, name), 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
    }));
}
// A database file in a new folder of support/groups.js; groupDatabase passes the path through guardPath before it
// opens it, and closes and removes everything in t.after. migrate:false leaves the file empty.
function guardedDatabase(t, options = {}) {
    const f = groupDatabase(t, options);
    guardPath(f.filename);
    return f;
}
// A new guarded folder holding copies of 0001 to 0007, the runner's options.directory for a version-7 database.
function publishedDirectory(t) {
    const directory = temporaryDirectory(t);
    const published = loadMigrations().filter(migration => migration.version <= PUBLISHED.length);
    assert.deepEqual(published.map(migration => migration.name), PUBLISHED);
    for (const migration of published) fs.writeFileSync(path.join(directory, migration.name), migration.sql);
    return directory;
}
function guardedVersionSeven(t) {
    const f = guardedDatabase(t, { migrate: false });
    const published = publishedDirectory(t);
    assert.deepEqual(migrate(f.db, { directory: published }), { version: 7, applied: PUBLISHED });
    return { ...f, published };
}
// The seeded version-7 database of the upgrade example, upgraded with the real migration directory.
function seededLatest(t) {
    const f = guardedVersionSeven(t);
    seed(f.db);
    assert.deepEqual(migrate(f.db).applied, laterNames());
    return f;
}
// Closes the connection and opens the file again as the application does at start (openDatabase migrates on open).
// The new connection joins the fixture's list, so t.after closes it before the folder is removed.
function reopen(f) {
    if (f.db.open) f.db.close();
    const db = openDatabase({ filename: guardPath(f.filename) });
    f.connections.push(db);
    return db;
}

// Schema objects, the ledger, and a digest of every row of every table (rowid, then SQLite type and value of each
// column; integers as BigInt), so any change of a value, a type or a row order shows.
const quoted = name => `"${name.replace(/"/g, '""')}"`;
function databaseState(db) {
    const tables = {};
    for (const table of tableNames(db)) {
        const select = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(table)
            .map(column => `typeof(${quoted(column.name)}), ${quoted(column.name)}`).join(', ');
        const rows = db.prepare(`SELECT rowid, ${select} FROM ${quoted(table)} ORDER BY rowid`).raw(true).safeIntegers(true).all();
        const text = JSON.stringify(rows, (key, value) => (typeof value === 'bigint' ? value.toString() : value));
        tables[table] = { rows: rows.length, sha256: createHash('sha256').update(text).digest('hex') };
    }
    return {
        schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
        ledger: db.prepare('SELECT * FROM SchemaMigrations ORDER BY version').all(),
        tables,
    };
}

// The runner's message names the migration file at most, never a folder or a file path.
function assertNoPath(message, ...folders) {
    for (const folder of [...folders, os.tmpdir(), MIGRATIONS, path.join(__dirname, '..')]) {
        assert.ok(!message.toLowerCase().includes(folder.toLowerCase()), `the message names no folder: ${message}`);
    }
    assert.doesNotMatch(message, /[A-Za-z]:[\\/]|\\|(?:^|[\s(])\/\S/, 'the message holds no absolute path');
}

test('(a) a fresh database gets one ledger row per listed migration file in order with its SHA-256, an empty foreign key check and integrity ok; a repeat run applies nothing (DB5-R14.6, DB5-R14.9)', t => {
    const listed = listedMigrations();
    assert.ok(listed.length > PUBLISHED.length, 'the directory holds migrations after 0007');
    for (const { name, version } of listed) assert.equal(Number(name.slice(0, 4)), version, `${name} carries version ${version}`);
    assert.ok(listed.every(entry => /^[0-9a-f]{64}$/.test(entry.checksum)));

    const f = guardedDatabase(t, { migrate: false });
    assert.deepEqual(f.db.prepare('SELECT name FROM sqlite_master').all(), [], 'the database starts empty');
    assert.deepEqual(migrate(f.db), { version: listed.length, applied: listed.map(entry => entry.name) });
    // In insertion order (rowid) and in version order the ledger equals the listing, with a 64-hex checksum per row.
    assert.deepEqual(f.db.prepare('SELECT version, name, checksum FROM SchemaMigrations ORDER BY rowid').all(), listed);
    assert.deepEqual(f.db.prepare('SELECT version, name, checksum FROM SchemaMigrations ORDER BY version').all(), listed);
    assert.ok(f.db.prepare('SELECT checksum FROM SchemaMigrations').all().every(row => /^[0-9a-f]{64}$/.test(row.checksum)));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');

    // (c) on the fresh database.
    const before = databaseState(f.db);
    assert.deepEqual(migrate(f.db), { version: listed.length, applied: [] });
    assert.deepEqual(databaseState(f.db), before);
});

test('(c) repeat runs and a restart on a populated latest-version database apply zero migrations and leave ledger and rows identical (DB5-R14.9, DB5-R11.2)', t => {
    const f = seededLatest(t);
    const latest = listedMigrations().length;
    const before = databaseState(f.db);
    assert.equal(before.ledger.length, latest);
    for (const table of ['Conversations', 'ConversationMembers', 'Messages', 'GroupExtensions', 'GroupMembershipIntervals']) {
        assert.ok(before.tables[table].rows > 0, `${table} holds rows`);
    }
    for (let run = 1; run <= 3; run += 1) assert.deepEqual(migrate(f.db), { version: latest, applied: [] }, `run ${run}`);
    assert.deepEqual(databaseState(f.db), before);
    const db = reopen(f);
    assert.deepEqual(databaseState(db), before, 'the start (openDatabase) applied nothing and changed nothing');
    assert.deepEqual(migrate(db), { version: latest, applied: [] });
});

// Copies of 0008 with one failing statement: a syntax error, a CHECK failure and a foreign key failure. The middle one
// sits right after the first statement, so the failure comes before most of the file has run.
const FAILING_COPIES = Object.freeze([
    { label: 'syntax error after the last statement', cause: 'SQLITE_ERROR', edit: sql => `${sql}\nCREATE TABLE GroupBroken (;\n` },
    { label: 'CHECK failure after the first statement', cause: 'SQLITE_CONSTRAINT_CHECK', edit: sql => {
        const start = sql.indexOf('CREATE TABLE GroupExtensions (');
        const end = sql.indexOf(';', start) + 1;
        assert.ok(start >= 0 && end > start && sql.slice(start, end).endsWith(');'), 'the first statement of 0008 is found');
        return `${sql.slice(0, end)}\nINSERT INTO GroupExtensions(conversation_id, history_policy) SELECT conversation_id, 'everyone' FROM Conversations WHERE kind = 'group';\n${sql.slice(end)}`;
    } },
    { label: 'foreign key failure after the last statement', cause: 'SQLITE_CONSTRAINT_FOREIGNKEY', edit: sql => `${sql}
INSERT INTO GroupCreationKeys(user_id, idempotency_key, fingerprint, conversation_id, created_at)
    VALUES('no-such-user', 'fixture-key', '${'0'.repeat(64)}', 'no-such-group', '2026-01-01T00:00:00.000Z');\n` },
]);

test('(d) a copy of 0008 with a failing statement in a temporary folder gives MIGRATION_FAILED naming the file and no path, and leaves schema, ledger and rows unchanged (DB5-R14.10, DB5-R14.17)', t => {
    const f = guardedVersionSeven(t);
    seed(f.db);
    const before = databaseState(f.db);
    const original = fs.readFileSync(path.join(MIGRATIONS, '0008-groups.sql'), 'utf8');
    for (const { label, cause, edit } of FAILING_COPIES) {
        const directory = publishedDirectory(t);
        fs.writeFileSync(path.join(directory, '0008-groups.sql'), edit(original));
        for (const migration of loadMigrations().filter(entry => entry.version > 8)) fs.writeFileSync(path.join(directory, migration.name), migration.sql);
        assert.throws(() => migrate(f.db, { directory }), error => {
            assert.equal(error.code, 'MIGRATION_FAILED', label);
            assert.match(error.message, /\b0008-groups\.sql\b/, `${label}: the message names the file`);
            assertNoPath(error.message, directory);
            assert.equal(error.cause && error.cause.code, cause, `${label}: ${error.cause && error.cause.message}`);
            return true;
        });
        assert.equal(f.db.inTransaction, false, label);
        assert.deepEqual(databaseState(f.db), before, `${label}: schema, ledger and rows are unchanged`);
    }
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'GroupExtensions'").get().n, 0);
    assert.deepEqual(migrate(f.db).applied, laterNames(), 'the published files still apply afterwards');
});

test('(g) every foreign key added after version 7 reports ON DELETE RESTRICT and every new table has at least one (DB5-R14.11, DC-06)', t => {
    const seven = guardedVersionSeven(t).db;
    const latest = guardedDatabase(t).db;
    const keys = (db, table) => db.prepare('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(table);
    const existing = new Set(tableNames(seven));
    const created = tableNames(latest).filter(name => !existing.has(name));
    assert.deepEqual(NEW_TABLES.filter(name => created.includes(name)), NEW_TABLES, 'the five tables of 0008 are new');
    const added = [];
    for (const table of tableNames(latest)) {
        const old = existing.has(table) ? keys(seven, table).map(row => JSON.stringify(row)) : [];
        if (!existing.has(table)) assert.ok(keys(latest, table).length >= 1, `${table} has a foreign key`);
        added.push(...keys(latest, table).filter(row => !old.includes(JSON.stringify(row))).map(row => ({ owner: table, ...row })));
    }
    assert.ok(added.length >= created.length, 'the new foreign keys are listed');
    for (const key of added) assert.equal(key.on_delete, 'RESTRICT', `${key.owner}(${key.from}) REFERENCES ${key.table}(${key.to})`);
});

// The direct history statements of server/database/repositories.js (messages.history and messages.highWater), kept
// as literals; the test first shows that repositories.js still runs exactly these texts (white space aside).
const DIRECT_HISTORY = "SELECT * FROM Messages WHERE conversation_id=@conversation AND origin='authenticated' AND message_seq<=@highWater AND (@before IS NULL OR message_seq<@before) ORDER BY message_seq DESC LIMIT @take";
const DIRECT_HIGH_WATER = "SELECT coalesce(max(message_seq),0) AS n FROM Messages WHERE conversation_id=? AND origin='authenticated'";
const DIRECT_STATEMENTS = Object.freeze([
    ['history, first page', DIRECT_HISTORY, { conversation: 'dm-alice-bob', highWater: 3, before: null, take: 51 }],
    ['history, next page', DIRECT_HISTORY, { conversation: 'dm-alice-bob', highWater: 3, before: 3, take: 51 }],
    ['high-water', DIRECT_HIGH_WATER, ['dm-alice-bob']],
]);
// The detail text of each plan step, with its parent given as the index of the parent step (-1 for the root).
function directPlans(db) {
    return DIRECT_STATEMENTS.map(([label, sql, parameters]) => {
        const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
        const rows = Array.isArray(parameters) ? statement.all(...parameters) : statement.all(parameters);
        const position = new Map(rows.map((row, index) => [row.id, index]));
        return { label, plan: rows.map(row => ({ parent: row.parent === 0 ? -1 : position.get(row.parent), detail: row.detail })) };
    });
}

test('(h) EXPLAIN QUERY PLAN of the direct history statements is identical at version 7 and at the latest version (NFR-04)', t => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'database', 'repositories.js'), 'utf8').replace(/\s+/g, ' ');
    for (const sql of [DIRECT_HISTORY, DIRECT_HIGH_WATER]) assert.ok(source.includes(sql), `repositories.js runs: ${sql}`);

    const emptySeven = directPlans(guardedVersionSeven(t).db);
    const populated = guardedVersionSeven(t);
    seed(populated.db);
    const populatedSeven = directPlans(populated.db);
    assert.deepEqual(migrate(populated.db).applied, laterNames());
    const upgraded = directPlans(populated.db);
    const fresh = directPlans(guardedDatabase(t).db);
    for (const { label, plan } of emptySeven) {
        assert.ok(plan.length >= 1, `${label} has a plan`);
        assert.ok(plan.every(step => !/\bSCAN Messages\b/.test(step.detail)), `${label} searches an index: ${JSON.stringify(plan)}`);
    }
    assert.deepEqual(populatedSeven, emptySeven, 'version 7 with and without rows');
    assert.deepEqual(upgraded, emptySeven, 'upgraded from version 7');
    assert.deepEqual(fresh, emptySeven, 'fresh at the latest version');
});

test('one-way: a latest-version database opened with a folder of only 0001 to 0007 (or any shorter prefix) gives MIGRATION_HISTORY_MISMATCH and changes nothing (DB5-R14.16)', t => {
    const f = seededLatest(t);
    const before = databaseState(f.db);
    const listed = listedMigrations();
    assert.equal(before.ledger.length, listed.length);
    const prefixes = [f.published];
    for (let count = 1; count < listed.length; count += 1) {
        if (count === PUBLISHED.length) continue; // f.published is that folder
        const directory = temporaryDirectory(t);
        for (const migration of loadMigrations().slice(0, count)) fs.writeFileSync(path.join(directory, migration.name), migration.sql);
        prefixes.push(directory);
    }
    assert.deepEqual(fs.readdirSync(f.published).sort(), PUBLISHED);
    for (const directory of prefixes) {
        assert.throws(() => migrate(f.db, { directory }), error => {
            assert.equal(error.code, 'MIGRATION_HISTORY_MISMATCH');
            assertNoPath(error.message, directory);
            return true;
        }, `${fs.readdirSync(directory).length} files`);
        assert.equal(f.db.inTransaction, false);
        assert.deepEqual(databaseState(f.db), before, 'ledger, schema and rows are unchanged');
    }
    assert.deepEqual(migrate(f.db), { version: listed.length, applied: [] }, 'the current files still accept the database');
});

test('(i) history_policy on a latest-version database: group_extensions_update aborts a change in either direction for archived and unarchived groups, description stays editable, other values fail at insert, backfilled rows hold from_joined and an inserted value persists (DB5-R08.1, DB5-R02.13)', t => {
    const f = seededLatest(t);
    let { db } = f;
    const AT = '2026-04-01T00:00:00.000Z';
    const backfilled = Object.fromEntries(db.prepare("SELECT conversation_id FROM Conversations WHERE kind = 'group' ORDER BY conversation_id")
        .all().map(row => [row.conversation_id, 'from_joined']));
    const policies = () => Object.fromEntries(db.prepare('SELECT conversation_id, history_policy FROM GroupExtensions ORDER BY conversation_id')
        .all().map(row => [row.conversation_id, row.history_policy]));
    assert.deepEqual(Object.keys(backfilled), ['grp-empty', 'grp-old', 'grp-team']);
    assert.deepEqual(policies(), backfilled, 'every backfilled row holds from_joined');

    // The trigger names history_policy in its column list and its condition, and only it raises its abort message.
    const triggerSql = database => database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'group_extensions_update'").get().sql;
    assert.match(triggerSql(db), /BEFORE UPDATE OF [^;]*\bhistory_policy\b[^;]* ON GroupExtensions BEGIN/);
    assert.match(triggerSql(db), /NEW\.history_policy IS NOT OLD\.history_policy/);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%group_extension_immutable%'").all()
        .map(row => row.name), ['group_extensions_update']);
    assert.equal(triggerSql(guardedDatabase(t).db), triggerSql(db), 'the same trigger text on a fresh database');

    // Groups created at the latest version with the policy chosen at insert (or the default), and three archived groups.
    const chosen = { 'grp-all-open': 'all', 'grp-all-archived': 'all', 'grp-joined-archived': 'from_joined', 'grp-default': undefined };
    for (const [id, policy] of Object.entries(chosen)) {
        insert(db, 'Conversations', { conversation_id: id, kind: 'group', title: id, created_by: 'u-alice', created_at: AT, updated_at: AT,
            origin: 'authenticated' });
        insert(db, 'GroupExtensions', policy === undefined ? { conversation_id: id, created_at: AT } : { conversation_id: id, history_policy: policy, created_at: AT });
    }
    for (const id of ['grp-old', 'grp-joined-archived', 'grp-all-archived']) {
        assert.equal(db.prepare('UPDATE Conversations SET archived_at = ?, updated_at = ? WHERE conversation_id = ?').run(AT, AT, id).changes, 1);
    }
    const expected = { ...backfilled, 'grp-all-open': 'all', 'grp-all-archived': 'all', 'grp-joined-archived': 'from_joined', 'grp-default': 'from_joined' };
    assert.deepEqual(policies(), expected);

    const row = id => db.prepare('SELECT * FROM GroupExtensions WHERE conversation_id = ?').get(id);
    const archived = id => db.prepare('SELECT archived_at FROM Conversations WHERE conversation_id = ?').get(id).archived_at !== null;
    const immutable = error => error.code === 'SQLITE_CONSTRAINT_TRIGGER' && error.message === 'group_extension_immutable';
    const covered = new Set();
    for (const id of ['grp-team', 'grp-old', 'grp-default', 'grp-joined-archived', 'grp-all-open', 'grp-all-archived']) {
        const before = row(id);
        const other = before.history_policy === 'all' ? 'from_joined' : 'all';
        const label = `${id} (${archived(id) ? 'archived' : 'unarchived'}): ${before.history_policy} to ${other}`;
        covered.add(`${before.history_policy} to ${other}, ${archived(id) ? 'archived' : 'unarchived'}`);
        assert.throws(() => db.prepare('UPDATE GroupExtensions SET history_policy = ? WHERE conversation_id = ?').run(other, id), immutable, label);
        assert.deepEqual(row(id), before, `${label}: the row is unchanged`);
        assert.throws(() => db.prepare('UPDATE GroupExtensions SET description = ?, history_policy = ? WHERE conversation_id = ?')
            .run('changed together with the policy', other, id), immutable, `${label}, with the description`);
        assert.deepEqual(row(id), before, `${label}: the description is unchanged too`);
        assert.equal(db.prepare('UPDATE GroupExtensions SET history_policy = ? WHERE conversation_id = ?').run(before.history_policy, id).changes, 1,
            `${id}: assigning the stored value passes`);
        assert.deepEqual(row(id), before);
        const description = `Description of ${id}`;
        assert.equal(db.prepare('UPDATE GroupExtensions SET description = ? WHERE conversation_id = ?').run(description, id).changes, 1, `${id}: description`);
        assert.deepEqual(row(id), { ...before, description });
    }
    assert.deepEqual([...covered].sort(), ['all to from_joined, archived', 'all to from_joined, unarchived', 'from_joined to all, archived',
        'from_joined to all, unarchived']);

    // An INSERT with any other value fails (NOT NULL for NULL, the CHECK otherwise) and adds no row.
    const OTHER_VALUES = [null, 'ALL', 'All', 'FROM_JOINED', 'From_Joined', 'from-joined', 'fromJoined', 'none', '', ' all', 'all ', 'from_joined '];
    OTHER_VALUES.forEach((value, index) => {
        const id = `grp-other-${index + 1}`;
        insert(db, 'Conversations', { conversation_id: id, kind: 'group', title: id, created_by: 'u-alice', created_at: AT, updated_at: AT,
            origin: 'authenticated' });
        const code = value === null ? 'SQLITE_CONSTRAINT_NOTNULL' : 'SQLITE_CONSTRAINT_CHECK';
        assert.throws(() => insert(db, 'GroupExtensions', { conversation_id: id, history_policy: value, created_at: AT }),
            error => error.code === code && /history_policy/.test(error.message), JSON.stringify(value));
        assert.equal(row(id), undefined, `${JSON.stringify(value)} added no row`);
    });
    assert.deepEqual(policies(), expected);

    // The values persist across a restart (openDatabase migrates on open and applies nothing).
    const state = databaseState(db);
    db = reopen(f);
    assert.deepEqual(databaseState(db), state);
    assert.deepEqual(policies(), expected);
    for (const id of Object.keys(backfilled)) assert.equal(row(id).history_policy, 'from_joined', `${id} still holds from_joined`);
});

// ---------------------------------------------------------------------------------------------------------------
// Static scan (DB5-R14.19, ARCH-R01.10; design Testing Strategy section 10): no runtime file of DATA (server/,
// server.js, scripts/, package.json) opens or imports the standalone database or server/src/db5db6, names the
// standalone database file, its DB_FILE variable or the standalone host, or loads the SQLite driver outside the two
// connection modules of Canonical_DATA. SQLite files are listed by name only and never read.
// ---------------------------------------------------------------------------------------------------------------
const DATA_ROOT = path.join(__dirname, '..');
const REPOSITORY_ROOT = path.join(DATA_ROOT, '..');
// The Standalone_Implementation (command G2 of tasks.md) and its legacy base schema module (server/database).
const STANDALONE_TARGETS = Object.freeze(['server/src/db5db6', 'server/database', 'server/api-main.cjs', 'server/src/api-app.cjs',
    'server/src/routes/groups.cjs', 'server/src/routes/attachment.cjs', 'server/src/storage/attachmentStorage.cjs',
    'server/src/middleware/requireAuth.cjs'].map(target => path.join(REPOSITORY_ROOT, ...target.split('/'))));
const STANDALONE_MARKERS = Object.freeze([/db5db6/i, /yahoo_messenger/i, /\bDB_FILE\b/, /api-main/i, /start:api/i, /\bAPI_PORT\b/]);
const SQLITE_FILE = /\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?$/i;
const SPECIFIER = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)|\bimport\s*\(\s*(['"`])([^'"`]+)\3\s*\)|\bfrom\s+(['"])([^'"]+)\5/g;
// Binding the driver's default export (the class that opens a SQLite file), or calling it directly. A named import
// such as { SqliteError } opens nothing and is allowed (the Group_Repository uses it to classify driver errors).
const DRIVER = String.raw`require\(\s*['"\x60]better-sqlite3['"\x60]\s*\)`;
const CONNECTION_CLASS = new RegExp(String.raw`\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*${DRIVER}|${DRIVER}\s*\(|\bimport\s+[A-Za-z_$][\w$]*\s*(?:,|from)`
    + String.raw`[^;]*['"]better-sqlite3['"]`);
const DRIVER_MODULES = Object.freeze(['server/database/connection.js', 'server/database/migrate.js']);
const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
const inside = (target, root) => fold(target) === fold(root) || fold(target).startsWith(fold(root + path.sep));

// A whole-line comment (// /* * in scripts, -- in SQL) cannot open or import a file, so it is prose and is not read.
const commentLine = relative => (/\.sql$/i.test(relative) ? /^\s*--/ : /\.[cm]?[jt]s$/.test(relative) ? /^\s*(?:\/\/|\/\*|\*)/ : /^(?!)/);
function standaloneHits(relative, text) {
    const directory = path.dirname(path.join(DATA_ROOT, ...relative.split('/')));
    const comment = commentLine(relative);
    const hits = [];
    text.split(/\r?\n/).forEach((line, index) => {
        if (comment.test(line)) return;
        const place = `${relative}:${index + 1}`;
        for (const marker of STANDALONE_MARKERS) if (marker.test(line)) hits.push(`${place} names ${marker.source}`);
        if (CONNECTION_CLASS.test(line) && !DRIVER_MODULES.includes(relative)) hits.push(`${place} binds the SQLite connection class`);
        for (const match of line.matchAll(SPECIFIER)) {
            const specifier = match[2] ?? match[4] ?? match[6];
            if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) continue;
            const target = path.resolve(directory, specifier);
            if (STANDALONE_TARGETS.some(root => inside(target, root))) hits.push(`${place} imports ${specifier}`);
        }
    });
    return hits;
}
// Regular files under the folders, as paths relative to DATA with "/"; SQLite files go to `unread` by name.
function runtimeFiles() {
    const files = [];
    const unread = [];
    const walk = relative => {
        const entries = fs.readdirSync(path.join(DATA_ROOT, ...relative.split('/')), { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const child = `${relative}/${entry.name}`;
            if (entry.isDirectory()) walk(child);
            else if (SQLITE_FILE.test(entry.name)) unread.push(child);
            else if (entry.isFile()) files.push(child);
        }
    };
    walk('server');
    walk('scripts');
    files.push('server.js', 'package.json');
    return { files, unread };
}

test('static scan: no runtime file of DATA opens or imports the standalone database or server/src/db5db6 (DB5-R14.19, ARCH-R01.10)', () => {
    const { files, unread } = runtimeFiles();
    for (const file of ['server.js', 'package.json', 'server/app.js', 'server/start.js', 'server/database/connection.js',
        'server/database/migrate.js', 'server/database/migrations/0008-groups.sql', 'server/e2ee/protocol.js', 'scripts/migrate.js']) {
        assert.ok(files.includes(file), `${file} is scanned`);
    }
    assert.deepEqual(unread.filter(file => /yahoo_messenger/i.test(file)), [], 'no standalone database file under DATA');
    assert.ok(unread.every(file => file.startsWith('server/database/')), `SQLite files only beside the canonical database: ${unread.join(', ')}`);
    const hits = files.flatMap(file => standaloneHits(file, fs.readFileSync(path.join(DATA_ROOT, ...file.split('/')), 'utf8')));
    assert.deepEqual(hits, []);
    // Only the two connection modules bind the connection class (ARCH-R01.2), and migrate.js opens only an in-memory
    // reference database; connection.js opens the configured Canonical_DATA file.
    const connectionModules = files.filter(file => /\.[cm]?js$/.test(file)
        && fs.readFileSync(path.join(DATA_ROOT, ...file.split('/')), 'utf8').split(/\r?\n/).some(line => CONNECTION_CLASS.test(line)));
    assert.deepEqual(connectionModules.sort(), [...DRIVER_MODULES].sort());
    const migrateSource = fs.readFileSync(path.join(DATA_ROOT, 'server', 'database', 'migrate.js'), 'utf8');
    assert.deepEqual(migrateSource.match(/new Database\([^)]*\)/g), ["new Database(':memory:')"]);

    // Self-test of the matcher on hand-written lines.
    const sample = (file, line) => standaloneHits(file, `'use strict';\n${line}\n`);
    assert.deepEqual(sample('server/groups/x.js', "const db = require('../../../server/src/db5db6/db.cjs');").length, 2, 'import and marker');
    assert.deepEqual(sample('server/x.js', "const s = require('../../server/src/db5db6');").length, 2);
    assert.deepEqual(sample('server/database/x.js', "const legacy = require('../../../server/database/db.js');"),
        ['server/database/x.js:2 imports ../../../server/database/db.js']);
    assert.deepEqual(sample('server/x.js', "import host from '../../server/api-main.cjs';").length, 2);
    assert.deepEqual(sample('server/x.js', "const file = path.join('data', 'yahoo_messenger.db');"), ['server/x.js:2 names yahoo_messenger']);
    assert.deepEqual(sample('scripts/x.js', 'const file = process.env.DB_FILE;'), ['scripts/x.js:2 names \\bDB_FILE\\b']);
    assert.deepEqual(sample('server/routes/x.js', "const Database = require('better-sqlite3');"), ['server/routes/x.js:2 binds the SQLite connection class']);
    assert.deepEqual(sample('server/routes/x.js', "const db = require('better-sqlite3')('second.sqlite3');"), ['server/routes/x.js:2 binds the SQLite connection class']);
    assert.deepEqual(sample('server/routes/x.js', "import Database from 'better-sqlite3';"), ['server/routes/x.js:2 binds the SQLite connection class']);
    assert.deepEqual(sample('server/database/x.js', "const { SqliteError } = require('better-sqlite3');"), [], 'the error class opens nothing');
    assert.deepEqual(sample('server/database/connection.js', "const Database = require('better-sqlite3');"), []);
    assert.deepEqual(sample('server/e2ee/x.js', "const shared = require('../../../server/src/e2ee/index.ts');"), [], 'the shared protocol is allowed');
    assert.deepEqual(sample('server/x.js', "const policy = require('./groups/policy'); const dbPath = process.env.DB_PATH;"), []);
    assert.deepEqual(sample('server/x.js', '// unlike server/src/db5db6, this module opens no second database'), [], 'a comment line is prose');
    assert.deepEqual(sample('server/database/migrations/0099-x.sql', "-- not yahoo_messenger.db\nATTACH 'yahoo_messenger.db' AS s;"),
        ['server/database/migrations/0099-x.sql:3 names yahoo_messenger']);
});

// ---------------------------------------------------------------------------------------------------------------
// T-5B-18: property P-27, upgrade from version 7 (design Correctness Properties P-27; Testing Strategy section 7,
// case (b)). Each run draws a version-7 data set, writes it into a new guarded database that the runner brought to
// version 7 from a temporary copy of 0001 to 0007, upgrades it with the real directory, and compares a row-by-row
// digest of every version-7 table, the schema of a fresh database and the backfill rule.
//
// Generator (one operation list per run, labels only; printed by forAll with the seed line on failure):
//   users        0 to 5 Users (a 'YYYY-MM-DD HH:MM:SS' or ISO created_at), their UserProfiles, AccountCredentials
//                for some, Sessions (some revoked through repositories.sessions.revoke), AuthChallenges, AuthRateLimits
//   legacy and   Contacts, SecurityLogs (copied into AuditLogs by trigger), AuditLogs, FriendRequests, Friendships and
//   social rows  Blocks of both origins; legacy users without credentials
//   keys         0 to 2 DeviceKeys per user (some superseded by a version 2 or revoked), ConversationKeyEpochs with
//                ConversationKeyWraps in authenticated conversations whose active members hold a device key
//   direct       0 to 3 direct conversations, legacy (some with the 0002 'legacy-dm:' id) or authenticated, with
//                legacy messages (some with pre-0006 envelope fields, delivered_at and read_at) and authenticated
//                envelope 1 and 2 messages, receipts, tombstones and attachments
//   groups       0 to 4 groups of both origins, the creator as owner (or not a member), other members that join at a
//                random point of 0 to 30 message slots and some leave (the owner too, rarely); joined_at and left_at
//                mix the ISO form, the 'YYYY-MM-DD HH:MM:SS' form and sub-second times; authenticated and legacy
//                messages from an active member, receipts, tombstones, attachments and key epochs
// The clock only moves forward and may stand still, so times tie with join and leave times; message times never
// decrease with message_seq and left_at is never before joined_at, as the application writes them. The rows are
// written with the parameter-bound insert of this file and with repositories.sessions.revoke, members.leave,
// messages.insertAuthenticated and messages.tombstone, and the e2ee key repository (insertDevice, status, insertEpoch).
// ---------------------------------------------------------------------------------------------------------------
const P27_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const P27_START = Date.UTC(2025, 8, 1, 8, 0, 0); // 2025-09-01T08:00:00.000Z, the generator's first instant
const P27_MAX_USERS = 5;
const P27_MAX_GROUPS = 4;
const P27_MAX_GROUP_MESSAGES = 30;
const P27_SPACE_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// Tables that the generic row operation writes with insert() above; the table name is a literal of this file.
const P27_ROW_TABLES = new Set(['AccountCredentials', 'Sessions', 'AuthChallenges', 'AuthRateLimits', 'Contacts', 'SecurityLogs',
    'AuditLogs', 'FriendRequests', 'Friendships', 'Blocks', 'Conversations', 'ConversationMembers', 'Messages', 'MessageReceipts',
    'Attachments']);
// Columns that define a conversation, a membership role, a message or an attachment. A table added after version 7
// that holds one of them, or every column of the canonical table, would duplicate it (ARCH-R01.11, DB5-R09.15).
const P27_DEFINING_COLUMNS = Object.freeze({
    Conversations: ['kind', 'title', 'dm_user_low', 'dm_user_high'],
    ConversationMembers: ['role'],
    Messages: ['ciphertext', 'iv', 'message_seq', 'sender_id'],
    Attachments: ['storage_key', 'byte_size', 'encrypted_metadata'],
});

function p27Generate(random) {
    const ops = [];
    let clock = P27_START;
    // Forward only: the same instant, one second, one minute, up to two hours, or a fraction of a second.
    const tick = () => {
        const step = random.weighted([['same', 2], ['second', 2], ['minute', 3], ['later', 3], ['fraction', 1]]);
        if (step === 'fraction') clock += random.int(1, 999);
        else if (step !== 'same') clock = Math.ceil(clock / 1000) * 1000 + (step === 'second' ? 1000 : step === 'minute' ? 60000 : random.int(2, 7200) * 1000);
        return clock;
    };
    const iso = ms => new Date(ms).toISOString();
    // The 'YYYY-MM-DD HH:MM:SS' form (CURRENT_TIMESTAMP) only for a whole second, so every stored text is the exact instant.
    const stamp = (ms, spaceShare) => (ms % 1000 === 0 && random.bool(spaceShare) ? iso(ms).slice(0, 19).replace('T', ' ') : iso(ms));
    const token = length => random.string(P27_ALPHABET, length, length);
    const hex = bytes => random.bytes(bytes).toString('hex');
    const count = max => random.int(0, max);
    const row = (table, values, label) => { ops.push({ op: 'row', table, row: values, label: `${table} ${label}` }); };

    const users = [];
    for (let index = 0, total = count(P27_MAX_USERS); index < total; index += 1) {
        const at = tick();
        const id = `p27-user-${index}`;
        const username = random.pick([`user${index}`, `User${index}`, `legacy_${index}`]);
        const created = stamp(at, 0.7);
        ops.push({ op: 'user', label: `Users ${id} created ${created}`, row: { user_id: id, username, display_name: `P27 user ${index}`,
            status: random.pick(['online', 'offline', 'away']), created_at: created, last_seen: created },
        profile: { avatar: random.pick(['initials', 'smile', 'star', 'rocket', 'cat']), custom_status: random.bool(0.3) ? `status ${index}` : '', at: iso(at) } });
        users.push({ id, username, name: `P27 user ${index}`, devices: [] });
    }

    // Accounts and sessions; legacy users keep no credentials.
    for (const user of users) {
        if (!random.bool(0.6)) continue;
        const at = iso(tick());
        const key = user.username.toLowerCase();
        const authVersion = random.int(1, 3);
        row('AccountCredentials', { user_id: user.id, username_key: key, email_key: `${key}@p27.invalid`,
            password_hash: `$argon2id$v=19$m=19456,t=2,p=1$${token(22)}$${token(43)}`, status: random.bool(0.85) ? 'active' : 'disabled',
            auth_version: authVersion, created_at: at, updated_at: at }, user.id);
        for (let index = 0, total = count(2); index < total; index += 1) {
            const issued = tick();
            const id = `p27-session-${user.id}-${index}`;
            row('Sessions', { session_id: id, user_id: user.id, token_hash: hex(32), csrf_token_hash: random.bool(0.7) ? hex(32) : null,
                issued_at_ms: issued, expires_at_ms: issued + 604800000, last_seen_at_ms: random.bool(0.5) ? issued + random.int(0, 3600000) : null,
                auth_version: authVersion, created_at: iso(issued) }, id);
            if (random.bool(0.3)) ops.push({ op: 'revokeSession', sessionId: id, atMs: issued + random.int(0, 86400000), label: `revoke ${id}` });
        }
    }
    for (let index = 0, total = count(2); index < total; index += 1) {
        const issued = tick();
        row('AuthChallenges', { challenge_hash: hex(32), csrf_hash: hex(32), issued_at_ms: issued, expires_at_ms: issued + 300000 }, `challenge ${index}`);
    }
    for (let index = 0, total = count(2); index < total; index += 1) {
        const start = tick();
        row('AuthRateLimits', { bucket_hash: hex(32), window_start_ms: start, expires_at_ms: start + 900000, attempts: random.int(1, 10) }, `bucket ${index}`);
    }

    // Legacy and social rows. pairs hold [low, high] in byte order (the ids differ only in their last digit).
    const pairs = [];
    for (let low = 0; low < users.length; low += 1) for (let high = low + 1; high < users.length; high += 1) pairs.push([users[low], users[high]]);
    const ordered = pairs.flatMap(([a, b]) => [[a, b], [b, a]]);
    random.shuffle(ordered).slice(0, count(Math.min(3, ordered.length))).forEach(([from, to], index) => {
        row('Contacts', { contact_id: `p27-contact-${index}`, user_id: from.id, friend_id: to.id, status: random.pick(['pending', 'accepted', 'blocked']),
            created_at: stamp(tick(), 0.8) }, `${from.id} -> ${to.id}`);
    });
    for (let index = 0, total = count(2); index < total; index += 1) {
        row('SecurityLogs', { log_id: `p27-log-${index}`, user_id: users.length && random.bool(0.8) ? random.pick(users).id : null,
            event_type: random.pick(['login', 'logout', 'alert']), severity: random.pick(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
            source: random.pick(['auditor_bot', 'sentinel_bot', 'buzz_guard']), description: `P27 legacy event ${index}`,
            details_json: random.bool() ? '{}' : null, created_at: stamp(tick(), 0.8), resolved: random.int(0, 1) }, `p27-log-${index}`);
    }
    for (let index = 0, total = count(2); index < total; index += 1) {
        row('AuditLogs', { audit_id: `p27-audit-${index}`, actor_user_id: users.length && random.bool(0.7) ? random.pick(users).id : null,
            event_type: random.pick(['auth.login', 'social.request', 'fixture']), severity: random.pick(['info', 'low', 'medium', 'high', 'critical']),
            source: random.pick(['auth', 'social', 'test']), subject_id: random.bool(0.5) ? `subject-${index}` : null,
            metadata_json: random.pick(['{}', '{"outcome":"ok"}', '{"count":2}']), created_at: iso(tick()) }, `p27-audit-${index}`);
    }
    const pendingPairs = new Set();
    random.shuffle(ordered).slice(0, count(Math.min(3, ordered.length))).forEach(([from, to], index) => {
        const pair = [from.id, to.id].sort().join(' ');
        const status = random.pick(pendingPairs.has(pair) ? ['accepted', 'declined', 'cancelled'] : ['pending', 'accepted', 'declined', 'cancelled']);
        if (status === 'pending') pendingPairs.add(pair);
        const at = tick();
        const origin = random.pick(['legacy', 'authenticated']);
        row('FriendRequests', { request_id: `p27-request-${index}`, sender_id: from.id, recipient_id: to.id, status, created_at: iso(at),
            resolved_at: status === 'pending' ? null : iso(at + random.int(1, 86400) * 1000), origin }, `${from.id} -> ${to.id} ${status} ${origin}`);
    });
    random.shuffle(pairs).slice(0, count(Math.min(2, pairs.length))).forEach(([low, high]) => {
        const origin = random.pick(['legacy', 'authenticated']);
        row('Friendships', { user_low: low.id, user_high: high.id, created_at: stamp(tick(), 0.5), origin }, `${low.id} ${high.id} ${origin}`);
    });
    random.shuffle(ordered).slice(0, count(Math.min(2, ordered.length))).forEach(([blocker, blocked]) => {
        const origin = random.pick(['legacy', 'authenticated']);
        row('Blocks', { blocker_id: blocker.id, blocked_id: blocked.id, created_at: iso(tick()), origin }, `${blocker.id} -> ${blocked.id} ${origin}`);
    });

    // Device keys: a device may be rotated (version 1 superseded, version 2 active) or revoked.
    const device = (user, deviceId, version, index) => {
        const at = iso(tick());
        const record = { deviceKeyId: token(43), userId: user.id, deviceId, keyVersion: version, createdAt: at, agreementPublicKey: token(87),
            signingPublicKey: token(87), signature: token(86) };
        ops.push({ op: 'device', record, at, label: `DeviceKeys ${user.id} device ${index} version ${version}` });
        return record.deviceKeyId;
    };
    for (const user of users) {
        for (let index = 0, total = random.weighted([[0, 4], [1, 4], [2, 2]]); index < total; index += 1) {
            const deviceId = token(22);
            let current = device(user, deviceId, 1, index);
            if (random.bool(0.25)) {
                ops.push({ op: 'deviceStatus', deviceKeyId: current, status: 'superseded', at: iso(tick()), label: `DeviceKeys ${user.id} device ${index} version 1 superseded` });
                current = device(user, deviceId, 2, index);
            }
            if (random.bool(0.1)) ops.push({ op: 'deviceStatus', deviceKeyId: current, status: 'revoked', at: iso(tick()), label: `DeviceKeys ${user.id} device ${index} revoked` });
            else user.devices.push(current);
        }
    }

    // Conversation helpers.
    const activeMembers = conversation => [...conversation.members.values()].filter(entry => entry.active).map(entry => entry.user);
    const member = (conversation, user, role, joinedAt) => {
        row('ConversationMembers', { conversation_id: conversation.id, user_id: user.id, role, joined_at: joinedAt },
            `${conversation.id} ${user.id} ${role} joined ${joinedAt}`);
        conversation.members.set(user.id, { user, active: true });
    };
    const leave = (conversation, user, leftAt) => {
        ops.push({ op: 'leave', conversationId: conversation.id, userId: user.id, at: leftAt, label: `leave ${conversation.id} ${user.id} at ${leftAt}` });
        conversation.members.get(user.id).active = false;
    };
    const epoch = conversation => {
        const keyed = activeMembers(conversation).filter(user => user.devices.length);
        if (!keyed.length) return;
        const creator = random.pick(keyed);
        const at = iso(tick());
        const wraps = keyed.filter(user => user === creator || random.bool(0.8))
            .flatMap(user => user.devices.map(deviceKeyId => ({ recipientUserId: user.id, recipientDeviceKeyId: deviceKeyId, enc: token(87), ciphertext: token(64) })));
        const number = conversation.epochs.length + 1;
        const keyId = token(22);
        ops.push({ op: 'epoch', at, label: `ConversationKeyEpochs ${conversation.id} epoch ${number} by ${creator.id}, ${wraps.length} wraps`, epoch: {
            conversationId: conversation.id, keyId, epoch: number, previousKeyId: number === 1 ? null : conversation.epochs[number - 2],
            creatorUserId: creator.id, creatorDeviceKeyId: random.pick(creator.devices), createdAt: at, signature: token(86),
            recipientSetDigest: token(43), wraps } });
        conversation.epochs.push(keyId);
    };
    const attachment = (conversation, uploader, messageId, at) => {
        conversation.attachments += 1;
        const id = `${conversation.id}-attachment-${conversation.attachments}`;
        const status = random.pick(['pending', 'ready', 'deleted']);
        row('Attachments', { attachment_id: id, conversation_id: conversation.id, message_id: random.bool(0.75) ? messageId : null, uploaded_by: uploader.id,
            storage_key: `p27/${hex(16)}`, encrypted_metadata: random.bool(0.7) ? token(64) : null, media_type: random.pick(['application/octet-stream', 'image/png']),
            byte_size: random.int(0, 5000000), status, created_at: iso(at), updated_at: iso(at) }, `${id} ${status} by ${uploader.id}`);
    };
    const send = (conversation, sender, authenticated) => {
        const at = tick();
        const number = conversation.messages + 1;
        conversation.messages = number;
        const id = `${conversation.id}-message-${number}`;
        const receiver = conversation.kind === 'direct' ? conversation.pair.find(user => user !== sender).id : null;
        if (authenticated) {
            conversation.seq += 1;
            const keyId = conversation.epochs.length && random.bool(0.5) ? conversation.epochs[conversation.epochs.length - 1] : null;
            const input = { message_id: id, conversation_id: conversation.id, sender_id: sender.id, receiver_id: receiver, ciphertext: token(random.int(24, 160)),
                iv: token(16), envelope_version: keyId ? 2 : 1, encoding: 'base64', sender_name: sender.name, client_timestamp: iso(at), message_type: 'text',
                fingerprint: hex(32), client_id: `p27-client-${number}`, message_seq: conversation.seq, created_at: stamp(at, 0.15) };
            if (keyId) input.key_id = keyId;
            ops.push({ op: 'message', input, label: `Messages ${id} seq ${conversation.seq} envelope ${input.envelope_version} from ${sender.id} at ${input.created_at}` });
            if (random.bool(0.08)) ops.push({ op: 'tombstone', messageId: id, at: iso(tick()), label: `tombstone ${id}` });
        } else {
            const createdAt = stamp(at, 0.6);
            const values = { message_id: id, conversation_id: conversation.id, sender_id: sender.id, receiver_id: receiver, ciphertext: token(random.int(24, 160)),
                iv: token(16), created_at: createdAt, updated_at: createdAt };
            if (random.bool(0.3)) { // a pre-0006 envelope row: envelope fields with origin legacy and no message_seq
                Object.assign(values, { envelope_version: 1, encoding: 'base64', sender_name: sender.name, client_timestamp: iso(at), message_type: 'text',
                    fingerprint: hex(32), client_id: `p27-legacy-client-${number}` });
            }
            if (receiver !== null && random.bool(0.5)) {
                values.delivered_at = stamp(at + random.int(1, 600) * 1000, 0.6);
                if (random.bool(0.5)) values.read_at = stamp(at + random.int(601, 1200) * 1000, 0.6);
            }
            row('Messages', values, `${id} legacy from ${sender.id} at ${createdAt}`);
        }
        for (const user of activeMembers(conversation)) {
            if (user === sender) continue;
            for (const status of ['delivered', 'read']) {
                if (!random.bool(0.15)) continue;
                const observed = iso(at + random.int(0, 900) * 1000);
                row('MessageReceipts', { conversation_id: conversation.id, message_id: id, user_id: user.id, status, observed_at: observed, recorded_at: observed },
                    `${id} ${user.id} ${status}`);
            }
        }
        if (random.bool(0.08)) attachment(conversation, sender, id, at);
    };
    const upperHex = text => Buffer.from(text, 'utf8').toString('hex').toUpperCase();

    // Direct conversations, legacy or authenticated.
    random.shuffle(pairs).slice(0, count(Math.min(3, pairs.length))).forEach(([low, high], index) => {
        const origin = random.bool() ? 'authenticated' : 'legacy';
        const id = origin === 'legacy' && random.bool() ? `legacy-dm:${upperHex(low.id)}:${upperHex(high.id)}` : `p27-direct-${index}`;
        const at = tick();
        const created = stamp(at, origin === 'legacy' ? 0.6 : 0.1);
        const values = { conversation_id: id, kind: 'direct', dm_user_low: low.id, dm_user_high: high.id, created_at: created, updated_at: created,
            archived_at: random.bool(0.1) ? iso(at) : null };
        if (origin === 'authenticated') Object.assign(values, { created_by: random.pick([low, high]).id, origin });
        else if (random.bool()) values.origin = 'legacy'; // otherwise the column default 'legacy' applies
        row('Conversations', values, `${id} ${origin} direct created ${created}`);
        const conversation = { id, kind: 'direct', pair: [low, high], members: new Map(), messages: 0, seq: 0, epochs: [], attachments: 0 };
        member(conversation, low, 'member', created);
        member(conversation, high, 'member', created);
        for (let message = 0, total = count(origin === 'legacy' ? 6 : 2); message < total; message += 1) send(conversation, random.pick([low, high]), false);
        if (origin === 'authenticated') {
            if (random.bool(0.5)) epoch(conversation);
            for (let message = 0, total = count(8); message < total; message += 1) {
                if (random.bool(0.15)) epoch(conversation);
                send(conversation, random.pick([low, high]), true);
            }
        }
    });

    // Groups of both origins with active and former members.
    for (let index = 0, total = count(P27_MAX_GROUPS); index < total; index += 1) {
        const origin = random.bool(0.55) ? 'authenticated' : 'legacy';
        const id = `p27-group-${index}`;
        const at = tick();
        const created = stamp(at, origin === 'legacy' ? 0.5 : 0.1);
        const creator = users.length && random.bool(0.85) ? random.pick(users) : null;
        const values = { conversation_id: id, kind: 'group', title: `P27 group ${index}`, created_by: creator ? creator.id : null, created_at: created,
            updated_at: created, archived_at: random.bool(0.15) ? iso(at) : null };
        if (origin === 'authenticated') values.origin = origin;
        else if (random.bool()) values.origin = 'legacy';
        row('Conversations', values, `${id} ${origin} group created ${created}`);
        const conversation = { id, kind: 'group', members: new Map(), messages: 0, seq: 0, epochs: [], attachments: 0 };
        const slots = count(P27_MAX_GROUP_MESSAGES);
        const others = users.filter(user => user !== creator);
        // join: the slot before which the member joins (slot = slots is after the last message); leave: the slot after
        // which the member leaves, never before the join.
        const plans = random.shuffle(others).slice(0, count(others.length)).map(user => {
            const join = random.int(0, slots);
            return { user, role: random.bool(0.3) ? 'admin' : 'member', join, leave: random.bool(0.35) ? random.int(join, slots) : null };
        });
        if (creator && random.bool(0.9)) {
            member(conversation, creator, 'owner', random.bool(0.7) ? created : stamp(at, 0.4));
            if (random.bool(0.1)) plans.push({ user: creator, join: -1, leave: random.int(0, slots) });
        }
        for (let slot = 0; slot <= slots; slot += 1) {
            for (const plan of plans) if (plan.join === slot) member(conversation, plan.user, plan.role, stamp(tick(), 0.4));
            for (const plan of plans) if (plan.leave === slot) leave(conversation, plan.user, stamp(tick(), 0.4));
            if (origin === 'authenticated' && random.bool(0.08)) epoch(conversation);
            if (slot === slots) break;
            const active = activeMembers(conversation);
            if (active.length) send(conversation, random.pick(active), origin === 'authenticated' ? random.bool(0.9) : random.bool(0.3));
        }
    }
    return ops;
}

const p27Describe = ops => (ops.length ? ops.map((op, index) => `${index}: ${op.label}`) : ['(no rows: an empty version-7 database)']);

function p27One(result, label) {
    assert.equal(result && result.changes, 1, `${label} changed one row`);
}
function p27Apply({ db, repositories, keys }, op, index) {
    try {
        if (op.op === 'row') {
            assert.ok(P27_ROW_TABLES.has(op.table), `a generated row for ${op.table}`);
            insert(db, op.table, op.row);
        } else if (op.op === 'user') {
            insert(db, 'Users', op.row);
            const { avatar, custom_status: customStatus, at } = op.profile;
            p27One(db.prepare('UPDATE UserProfiles SET avatar = ?, custom_status = ?, created_at = ?, updated_at = ? WHERE user_id = ?')
                .run(avatar, customStatus, at, at, op.row.user_id), 'the profile update');
        } else if (op.op === 'revokeSession') {
            p27One(repositories.sessions.revoke(op.sessionId, op.atMs), 'sessions.revoke');
        } else if (op.op === 'device') {
            keys.insertDevice(op.record, op.at);
        } else if (op.op === 'deviceStatus') {
            keys.status([op.deviceKeyId], op.status, op.at);
        } else if (op.op === 'leave') {
            p27One(repositories.members.leave(op.conversationId, op.userId, op.at), 'members.leave');
        } else if (op.op === 'message') {
            repositories.messages.insertAuthenticated(op.input);
        } else if (op.op === 'tombstone') {
            p27One(repositories.messages.tombstone(op.messageId, op.at), 'messages.tombstone');
        } else if (op.op === 'epoch') {
            keys.insertEpoch(op.epoch, op.at);
        } else {
            throw new Error(`unknown operation ${op.op}`);
        }
    } catch (error) {
        throw new Error(`generated operation ${index} (${op.label}) failed: ${error.message}`, { cause: error });
    }
}

// Row-by-row digest of the given columns (the version-7 columns of the table), rows in primary-key order: one entry
// per row, the primary-key values and the SHA-256 of the SQLite type and value of every column. The ledger is limited to
// the version-7 rows; every other table is read in full, so an added or removed row shows too.
function p27RowDigests(db, table, columns) {
    const key = columns.map((column, index) => ({ ...column, index })).filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
    const select = columns.map(column => `typeof(${quoted(column.name)}), ${quoted(column.name)}`).join(', ');
    const where = table === 'SchemaMigrations' ? `WHERE version <= ${PUBLISHED.length}` : '';
    const order = key.length ? key.map(column => quoted(column.name)).join(', ') : 'rowid';
    const text = value => JSON.stringify(value, (name, item) => (typeof item === 'bigint' ? item.toString() : item));
    return db.prepare(`SELECT ${select} FROM ${quoted(table)} ${where} ORDER BY ${order}`).raw(true).safeIntegers(true).all()
        .map(row => `${text(key.map(column => row[2 * column.index + 1]))} ${createHash('sha256').update(text(row)).digest('hex')}`);
}

// Tables, columns (type, nullability, default, key), indexes with their key columns, foreign keys, and the type, name,
// table and SQL text of every index and trigger.
function p27Schema(db) {
    const pragma = (name, argument) => db.prepare(`SELECT * FROM pragma_${name}(?)`).all(argument);
    const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const tables = objects.filter(object => object.type === 'table').map(object => ({
        table: object.name,
        sql: object.sql,
        columns: pragma('table_xinfo', object.name),
        indexes: pragma('index_list', object.name).map(({ seq, ...index }) => ({ ...index, keys: pragma('index_xinfo', index.name) }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        foreignKeys: pragma('foreign_key_list', object.name),
    }));
    return { tables, objects: objects.filter(object => object.type !== 'table') };
}
const p27Trigger = (schema, name) => schema.objects.find(object => object.type === 'trigger' && object.name === name);

// The version-7 state that the checks compare with: tables, row digests, schema and the group rows of the backfill.
function p27VersionSeven(db) {
    const tables = tableNames(db);
    const rows = Object.fromEntries(tables.map(table => {
        const columns = db.prepare('SELECT name, pk FROM pragma_table_info(?) ORDER BY cid').all(table);
        return [table, { columns, digests: p27RowDigests(db, table, columns) }];
    }));
    const groups = db.prepare("SELECT conversation_id, created_at, origin FROM Conversations WHERE kind = 'group' ORDER BY conversation_id").all();
    const members = db.prepare(`SELECT cm.conversation_id, cm.user_id, cm.joined_at, cm.left_at FROM ConversationMembers cm
        JOIN Conversations c ON c.conversation_id = cm.conversation_id WHERE c.kind = 'group' ORDER BY cm.conversation_id, cm.user_id`).all();
    const messagesOf = db.prepare(`SELECT message_seq, created_at FROM Messages WHERE conversation_id = ? AND origin = 'authenticated'
        ORDER BY message_seq`);
    const groupMessages = Object.fromEntries(groups.map(group => [group.conversation_id, messagesOf.all(group.conversation_id)]));
    const scalar = sql => db.prepare(sql).get().n;
    const stats = {
        legacyGroupMessages: scalar(`SELECT count(*) AS n FROM Messages m JOIN Conversations c ON c.conversation_id = m.conversation_id
            WHERE c.kind = 'group' AND m.origin = 'legacy'`),
        legacyDirects: scalar("SELECT count(*) AS n FROM Conversations WHERE kind = 'direct' AND origin = 'legacy'"),
        envelopeTwo: scalar('SELECT count(*) AS n FROM Messages WHERE envelope_version = 2'),
        legacyUsers: scalar('SELECT count(*) AS n FROM Users u WHERE NOT EXISTS(SELECT 1 FROM AccountCredentials a WHERE a.user_id = u.user_id)'),
    };
    return { tables, rows, schema: p27Schema(db), groups, members, groupMessages, stats };
}

// Feature: db5-db6-canonical-integration, Property P-27: Upgrade from version 7 keeps every row and matches a fresh schema
// **Validates: Requirements DB5-R14.3, DB5-R14.6, DB5-R14.7, DB5-R14.8, DB5-R14.11, DB5-R14.13, DB5-R09.15, DB5-R08.3, ARCH-R01.11, ARCH-R02.5, COMP-03**
test('P-27: for generated version-7 databases the upgrade keeps every row and value of every version-7 table, gives the schema of a fresh database, one from_joined extension per group and intervals by the sequence rule', { timeout: 900000 }, async t => {
    const listed = listedMigrations();
    // DB5-R14.6: the fresh reference, built from an empty file with the real directory.
    const fresh = guardedDatabase(t).db;
    assert.deepEqual(fresh.prepare('SELECT version, name, checksum FROM SchemaMigrations ORDER BY version').all(), listed);
    assert.deepEqual(fresh.pragma('foreign_key_check'), []);
    const freshSchema = p27Schema(fresh);
    fresh.close();
    const freshTrigger = p27Trigger(freshSchema, 'group_extensions_update');
    assert.ok(freshTrigger, 'a fresh database has group_extensions_update');
    assert.match(freshTrigger.sql, /BEFORE UPDATE OF [^;]*\bhistory_policy\b[^;]* ON GroupExtensions BEGIN/);
    assert.match(freshTrigger.sql, /NEW\.history_policy IS NOT OLD\.history_policy/);

    const published = publishedDirectory(t); // the temporary copy of 0001 to 0007 that every run migrates with
    const coverage = { tables: {}, runs: 0, rows: 0, noUsers: 0, authenticatedGroups: 0, legacyGroups: 0, groupsWithoutMembers: 0,
        groupMembers: 0, formerMembers: 0, spaceJoins: 0, subSecondJoins: 0, emptyIntervals: 0, joinedAfterLast: 0, boundaryTies: 0,
        legacyGroupMessages: 0, legacyDirects: 0, envelopeTwo: 0, legacyUsers: 0, mostGroupMessages: 0 };

    const summary = await forAll('P-27', { runs: P27_RUNS, seed: P27_SEED, describe: p27Describe }, p27Generate, ops => {
        const f = guardedDatabase(t, { migrate: false }); // a new guarded folder for this run
        try {
            const { db } = f;
            assert.deepEqual(migrate(db, { directory: published }), { version: PUBLISHED.length, applied: PUBLISHED });
            const context = { db, repositories: f.repositories, keys: createKeyRepository(db) };
            db.transaction(() => ops.forEach((op, index) => p27Apply(context, op, index))).immediate();
            assert.deepEqual(db.pragma('foreign_key_check'), [], 'the generated version-7 database passes the foreign key check');
            const seven = p27VersionSeven(db);
            // Preconditions of the generator, as the application writes rows: message times do not decrease with
            // message_seq, and a former member left at or after joining.
            for (const [group, messages] of Object.entries(seven.groupMessages)) {
                messages.forEach((message, index) => assert.ok(index === 0 || instant(message.created_at) >= instant(messages[index - 1].created_at),
                    `generator: ${group} seq ${message.message_seq} is not older than the previous message`));
            }
            for (const member of seven.members) {
                assert.ok(member.left_at === null || instant(member.left_at) >= instant(member.joined_at), `generator: ${member.conversation_id} ${member.user_id}`);
            }

            assert.deepEqual(migrate(db), { version: listed.length, applied: laterNames() });

            // DB5-R14.3, R14.7, ARCH-R02.5, COMP-03: every row of every version-7 table keeps every version-7 column value,
            // and no row is added to or removed from a version-7 table (the ledger gains exactly the later files).
            for (const table of seven.tables) {
                assert.deepEqual(p27RowDigests(db, table, seven.rows[table].columns), seven.rows[table].digests, `${table}: rows and values are kept`);
            }
            assert.deepEqual(db.prepare(`SELECT version, name, checksum FROM SchemaMigrations WHERE version > ${PUBLISHED.length} ORDER BY version`).all(),
                listed.slice(PUBLISHED.length));

            // DB5-R14.8: the upgraded schema equals the fresh one, the text of group_extensions_update included.
            const upgraded = p27Schema(db);
            assert.deepEqual(upgraded, freshSchema, 'the upgraded schema equals a fresh database');
            assert.equal(p27Trigger(upgraded, 'group_extensions_update').sql, freshTrigger.sql);
            // DB5-R14.3: the version-7 objects are unchanged; a column added to a version-7 table is nullable or has a default.
            for (const object of seven.schema.objects) {
                assert.deepEqual(upgraded.objects.find(entry => entry.type === object.type && entry.name === object.name), object, `${object.type} ${object.name}`);
            }
            for (const before of seven.schema.tables) {
                const after = upgraded.tables.find(entry => entry.table === before.table);
                assert.ok(after, `${before.table} still exists`);
                assert.deepEqual(after.columns.slice(0, before.columns.length), before.columns, `${before.table}: the version-7 columns`);
                for (const column of after.columns.slice(before.columns.length)) {
                    assert.ok(column.notnull === 0 || column.dflt_value !== null, `${before.table}.${column.name} is nullable or has a default`);
                }
                for (const index of before.indexes) assert.deepEqual(after.indexes.find(entry => entry.name === index.name), index, `${before.table}: ${index.name}`);
                assert.deepEqual(after.foreignKeys, before.foreignKeys, `${before.table}: foreign keys`);
            }
            // DB5-R14.11: every table added after version 7 has a foreign key, and each one is ON DELETE RESTRICT.
            const added = upgraded.tables.filter(entry => !seven.tables.includes(entry.table));
            assert.deepEqual(NEW_TABLES.filter(name => added.some(entry => entry.table === name)), NEW_TABLES);
            for (const entry of added) {
                assert.ok(entry.foreignKeys.length >= 1, `${entry.table} has a foreign key`);
                for (const key of entry.foreignKeys) assert.equal(key.on_delete, 'RESTRICT', `${entry.table}(${key.from}) REFERENCES ${key.table}(${key.to})`);
            }
            // ARCH-R01.11, DB5-R09.15: Messages has no group_id and no added table duplicates a canonical table.
            const columnsOf = name => upgraded.tables.find(entry => entry.table === name).columns.map(column => column.name);
            assert.ok(!columnsOf('Messages').includes('group_id'), 'Messages has no group_id column');
            for (const [canonical, defining] of Object.entries(P27_DEFINING_COLUMNS)) {
                const canonicalColumns = columnsOf(canonical);
                assert.deepEqual(defining.filter(name => !canonicalColumns.includes(name)), [], `the defining columns belong to ${canonical}`);
                for (const entry of added) {
                    const names = entry.columns.map(column => column.name);
                    assert.ok(!canonicalColumns.every(name => names.includes(name)), `${entry.table} holds every column of ${canonical}`);
                    assert.deepEqual(defining.filter(name => names.includes(name)), [], `${entry.table} holds no column that defines ${canonical}`);
                }
            }
            assert.deepEqual(db.pragma('foreign_key_check'), []);
            assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');

            // DB5-R14.13: one extension row per group of any origin, from_joined, revision 1, description NULL, created_at copied.
            assert.deepEqual(db.prepare('SELECT * FROM GroupExtensions ORDER BY conversation_id').all(), seven.groups.map(group => ({
                conversation_id: group.conversation_id, description: null, history_policy: 'from_joined', membership_revision: 1, created_at: group.created_at })));
            // DB5-R08.3: one interval per group member, by the rule computed in JavaScript from the version-7 rows.
            const intervals = db.prepare('SELECT * FROM GroupMembershipIntervals ORDER BY conversation_id, user_id, interval_no').all();
            assert.deepEqual(intervals, seven.members.map(member => expectedInterval(member, seven.groupMessages[member.conversation_id])));
            // Under from_joined a member reads exactly the messages created while a member: none before joining and,
            // for a former member, none after leaving.
            seven.members.forEach((member, index) => {
                const ranges = permittedRanges([intervals[index]], 'from_joined');
                const joined = instant(member.joined_at);
                const left = member.left_at === null ? null : instant(member.left_at);
                const messages = seven.groupMessages[member.conversation_id];
                for (const message of messages) {
                    const at = instant(message.created_at);
                    const during = at >= joined && (left === null || at <= left);
                    assert.equal(inRanges(message.message_seq, ranges), during,
                        `${member.conversation_id} ${member.user_id} seq ${message.message_seq} (${message.created_at}; joined ${member.joined_at}, left ${member.left_at})`);
                    if (at === joined || at === left) coverage.boundaryTies += 1;
                }
                const { first_seq: first, last_seq: last } = intervals[index];
                if (last !== null && last === first - 1) coverage.emptyIntervals += 1;
                if (messages.length && first === messages[messages.length - 1].message_seq + 1) coverage.joinedAfterLast += 1;
            });

            coverage.runs += 1;
            for (const table of seven.tables) {
                coverage.tables[table] = (coverage.tables[table] || 0) + (seven.rows[table].digests.length ? 1 : 0);
                coverage.rows += seven.rows[table].digests.length;
            }
            if (!seven.rows.Users.digests.length) coverage.noUsers += 1;
            coverage.authenticatedGroups += seven.groups.filter(group => group.origin === 'authenticated').length;
            coverage.legacyGroups += seven.groups.filter(group => group.origin === 'legacy').length;
            coverage.groupsWithoutMembers += seven.groups.filter(group => !seven.members.some(member => member.conversation_id === group.conversation_id)).length;
            coverage.groupMembers += seven.members.length;
            coverage.formerMembers += seven.members.filter(member => member.left_at !== null).length;
            coverage.spaceJoins += seven.members.filter(member => P27_SPACE_FORM.test(member.joined_at)).length;
            coverage.subSecondJoins += seven.members.filter(member => instant(member.joined_at) % 1000 !== 0).length;
            for (const name of ['legacyGroupMessages', 'legacyDirects', 'envelopeTwo', 'legacyUsers']) coverage[name] += seven.stats[name];
            coverage.mostGroupMessages = Math.max(coverage.mostGroupMessages, ...Object.values(seven.groupMessages).map(messages => messages.length));
        } finally {
            if (f.db.open) f.db.close();
        }
    });

    assert.deepEqual(fs.readdirSync(published).sort(), PUBLISHED, 'the temporary copy still holds 0001 to 0007 only');
    const { tables, ...counts } = coverage;
    t.diagnostic(`P-27 seed=${summary.seed} runs=${summary.runs} ${JSON.stringify(counts)}`);
    t.diagnostic(`P-27 runs with rows per version-7 table ${JSON.stringify(tables)}`);
    if (summary.replay === null) {
        // The generator reached every version-7 table and every case of the backfill rule in this set of runs.
        assert.equal(coverage.runs, P27_RUNS);
        for (const [table, runs] of Object.entries(tables)) assert.ok(runs > 0, `some run holds rows in ${table}`);
        for (const [name, value] of Object.entries(counts)) assert.ok(value > 0, `the generated databases cover ${name}`);
    }
});

// T-5B-33: documentation derives its inventory from a real disposable upgrade,
// not a scan that could mistake comments for schema objects. SQLite's implicit
// sqlite_* indexes are implementation details; named objects and PKs are documented.
const DOCS = path.join(__dirname,'..','docs');
const GROUP_VERSION_HEADING = '## Version 8 group migration';
const ONE_WAY_WARNING = 'A database migrated to 0008 or higher cannot start under code without that migration, because the runner rejects extra ledger rows with `MIGRATION_HISTORY_MISMATCH`.';
const COLD_PRECONDITION = 'Before running the Migration_Runner on an existing database, take a cold backup while no process has the database open (every connection is closed).';
const COLD_CITATION = '[Cold backup commands](../../docs/docker-development.md#cold-backup-commands-powershell)';
const RESTORE_CITATION = '[Restore into new volumes first](../../docs/docker-development.md#restore-into-new-volumes-first-powershell)';
// Host filenames are prose tokens only, never paths passed to a database opener.
const DOCUMENTED_HOST_FILE = ['database','sqlite'].join('.');
const prose = text => text.replace(/`/g,'').replace(/\s+/g,' ').trim();
const documentation = () => ({ schema:fs.readFileSync(path.join(DOCS,'schema.md'),'utf8'),
    migrations:fs.readFileSync(path.join(DOCS,'migrations.md'),'utf8') });

function documentationInventory(t) {
    const f = atVersionSeven(t);
    const objects = () => f.db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const before = new Set(objects().map(row => `${row.type}:${row.name}`));
    const directory = temporaryDirectory(t), listed = loadMigrations();
    for (const entry of listed.filter(entry => entry.version <= 8)) fs.writeFileSync(path.join(directory,entry.name),entry.sql);
    assert.deepEqual(migrate(f.db,{ directory }).applied,['0008-groups.sql']);
    return { db:f.db, objects:objects().filter(row => !before.has(`${row.type}:${row.name}`)), files:listed.map(entry => entry.name) };
}

function documentationProblems(docs, inventory) {
    const problems = [];
    for (const [name,text] of Object.entries(docs)) {
        if (!/version\s+8\b/i.test(text)) problems.push(`${name}: version 8`);
        for (const file of inventory.files) if (!text.includes('`'+file+'`')) problems.push(`${name}: migration ${file}`);
        for (const object of inventory.objects) if (!text.includes('`'+object.name+'`')) problems.push(`${name}: object ${object.name}`);
        for (const token of ['first_seq','last_seq','strftime','from_joined']) if (!text.includes('`'+token+'`')) problems.push(`${name}: backfill ${token}`);
    }
    const operations = docs.migrations.slice(docs.migrations.indexOf(GROUP_VERSION_HEADING));
    if (!prose(operations).includes(prose(ONE_WAY_WARNING))) problems.push('migrations: one-way warning');
    if (!prose(operations).includes(prose(COLD_PRECONDITION))) problems.push('migrations: cold precondition');
    if (!operations.includes(COLD_CITATION)) problems.push('migrations: cold-backup citation');
    if (!operations.includes(RESTORE_CITATION)) problems.push('migrations: fresh-volume restore citation');
    for (const token of ['sqlite-data','private-storage',DOCUMENTED_HOST_FILE,DOCUMENTED_HOST_FILE+'-wal',DOCUMENTED_HOST_FILE+'-shm']) {
        if (!operations.includes('`'+token+'`')) problems.push(`migrations: cold-backup ${token}`);
    }
    if (!/first start[\s\S]*0008[\s\S]*migrates[\s\S]*sqlite-data[\s\S]*permanent/i.test(operations)) problems.push('migrations: first-start warning');
    if (!/failed migration stops startup/i.test(operations)) problems.push('migrations: failed-start warning');
    if (!/Compose Watch is not used while a migration file is a draft/.test(operations)) problems.push('migrations: draft Watch warning');
    if (/(?:npm run db:(?:backup|restore)|scripts\/[^\s)]*(?:backup|restore)|\b(?:backup|restore)\.(?:js|cjs|mjs|ps1|sh)\b)/i.test(docs.migrations)) problems.push('migrations: unsupported backup script');
    if (/^\s*docker (?:compose|run)\b/m.test(operations)) problems.push('migrations: copied Docker procedure');
    return problems;
}

test('T-5B-33: schema and migration documentation cover every named SQLite object, migration and operational precondition', t => {
    const inventory = documentationInventory(t);
    assert.deepEqual(inventory.objects.reduce((counts,row) => { counts[row.type]=(counts[row.type] ?? 0)+1; return counts; },{}),
        { index:7, table:5, trigger:26 });
    assert.deepEqual(documentationProblems(documentation(),inventory),[]);
    const guide = fs.readFileSync(path.join(__dirname,'../../docs/docker-development.md'),'utf8');
    assert.match(guide,/^### Cold backup commands \(PowerShell\)$/m);
    assert.match(guide,/^### Restore into new volumes first \(PowerShell\)$/m);
});

test('T-5B-33: deleting any documented object or migration filename makes the documentation guard fail', t => {
    const inventory = documentationInventory(t), original = documentation();
    assert.deepEqual(documentationProblems(original,inventory),[]);
    let mutations = 0;
    for (const name of ['schema','migrations']) {
        for (const [kind,items] of [['object',inventory.objects.map(row => row.name)],['migration',inventory.files]]) {
            for (const value of items) {
                const modified = { ...original, [name]:original[name].replaceAll('`'+value+'`','`omitted`') };
                assert.ok(documentationProblems(modified,inventory).includes(`${name}: ${kind} ${value}`),`${name}: ${value}`);
                mutations += 1;
            }
        }
    }
    assert.equal(mutations,2*(inventory.objects.length+inventory.files.length));
    t.diagnostic(`documentation omission checks=${mutations}`);
});

test('T-5B-33: missing one-way/cold-backup warnings or citations and unsupported backup scripts are rejected', t => {
    const inventory = documentationInventory(t), original = documentation();
    assert.deepEqual(documentationProblems(original,inventory),[]);
    for (const [text,expected] of [[ONE_WAY_WARNING,'one-way warning'],[COLD_PRECONDITION,'cold precondition'],
        [COLD_CITATION,'cold-backup citation'],[RESTORE_CITATION,'fresh-volume restore citation']]) {
        assert.ok(original.migrations.includes(text));
        const modified = { ...original, migrations:original.migrations.replace(text,'omitted') };
        assert.ok(documentationProblems(modified,inventory).includes('migrations: '+expected),expected);
    }
    const modified = { ...original, migrations:original.migrations+'\nRun npm run db:backup.\n' };
    assert.ok(documentationProblems(modified,inventory).includes('migrations: unsupported backup script'));
});

test('T-5B-33: repository additions document every implemented group function and the existing error/security boundary', t => {
    const { createGroupRepository } = require('../server/database/groupRepository');
    const f = groupDatabase(t), groups = createGroupRepository(f.db);
    const text = fs.readFileSync(path.join(DOCS,'repositories.md'),'utf8');
    const added = text.slice(text.indexOf('## DB-5B group repository additions'));
    for (const [name,value] of Object.entries(groups)) if (typeof value === 'function') assert.match(added,new RegExp('\\b'+name+'\\('),name);
    for (const name of ['target_id','role','translate','withMembershipTransaction','OP-09','UNAVAILABLE']) assert.ok(added.includes(name),name);
    assert.match(added,/before COMMIT/);
    assert.match(added,/not an authorization boundary/);
    assert.match(added,/does not change.*E2EE/);
});

// T-5B-19, Property P-28 (DB5-R11.2, DB5-R14.9, DB5-R14.10, DB5-R15.7).
// Reuse P-27's generated version-7 operations and the complete, type-aware databaseState oracle above.
// All fault SQL is written only to copies under temporaryDirectory(); published and draft migration files stay intact.
const P28_FAULTS = Object.freeze([
    { label:'syntax', code:'SQLITE_ERROR', sql:'CREATE TABLE P28Broken (;' },
    { label:'constraint', code:'SQLITE_CONSTRAINT_CHECK', sql:'INSERT INTO P28RollbackProbe VALUES(2, -1, NULL);' },
    { label:'foreign-key', code:'SQLITE_CONSTRAINT_FOREIGNKEY', sql:"INSERT INTO P28RollbackProbe VALUES(2, 0, 'p28-missing-user');" },
]);

function p28Generate(random) {
    const ops = p27Generate(random);
    // The repeat property requires populated databases, including draws where P-27 generated no users.
    if (!ops.some(op => op.op === 'user')) ops.unshift({ op:'user', label:'P28 fallback user',
        row:{ user_id:'p28-fallback', username:'p28fallback', display_name:'P28 fallback', status:'offline', created_at:SETUP, last_seen:SETUP },
        profile:{ avatar:'initials', custom_status:'', at:SETUP } });
    return { ops, repeats:random.int(1, 6), policy:random.pick(['all', 'from_joined']) };
}

function p28Populate(f, ops) {
    const context = { db:f.db, repositories:f.repositories, keys:createKeyRepository(f.db) };
    f.db.transaction(() => ops.forEach((op, index) => p27Apply(context, op, index))).immediate();
    assert.ok(f.db.prepare('SELECT count(*) AS n FROM Users').get().n > 0);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
}

const p28Describe = value => [`repeats=${value.repeats} policy=${value.policy}`,
    ...(value.faults || []).map(({ label, position }) => `${label} before statement ${position}`), ...p27Describe(value.ops)];

test('P-28: generated populated fresh and upgraded databases remain identical after repeated migrations and restart', { timeout:900000 }, async t => {
    const { groupFixture, createClock } = require('./support/groups');
    const { createGroupRepository } = require('../server/database/groupRepository');
    const published = publishedDirectory(t), latest = listedMigrations().length;
    const coverage = { cases:0, databases:0, repeatCalls:0, restarts:0 };
    const summary = await forAll('P-28-repeat', { runs:P28_RUNS, seed:P28_SEED, describe:p28Describe }, p28Generate, value => {
        const upgraded = guardedDatabase(t, { migrate:false });
        let fresh;
        try {
            migrate(upgraded.db, { directory:published });
            p28Populate(upgraded, value.ops);
            assert.deepEqual(migrate(upgraded.db), { version:latest, applied:laterNames() });
            // Fresh schema uses the existing valid actor fixture, including a pending invitation, former member and
            // creation key. Add a read position so every new table holds rows in the fresh-schema branch.
            fresh = groupFixture(t, { clock:createClock('2030-01-01T00:00:00.000Z'), group:{ historyPolicy:value.policy } });
            const groups = createGroupRepository(fresh.db);
            assert.equal(fresh.db.transaction(() => groups.upsertReadPosition(fresh.groupId, fresh.actors.owner.id, 0, fresh.clock.iso())).immediate(), 0);
            for (const table of NEW_TABLES) assert.ok(fresh.db.prepare(`SELECT count(*) AS n FROM ${quoted(table)}`).get().n > 0, table);
            for (const f of [fresh, upgraded]) {
                const before = databaseState(f.db);
                assert.equal(before.ledger.length, latest);
                for (let run = 0; run < value.repeats; run += 1) {
                    assert.deepEqual(migrate(f.db), { version:latest, applied:[] });
                    assert.equal(f.db.inTransaction, false);
                    assert.deepEqual(databaseState(f.db), before, `repeat ${run}: schema, ledger and every row`);
                    coverage.repeatCalls += 1;
                }
                f.db = reopen(f);
                assert.deepEqual(databaseState(f.db), before, 'migrate-on-open changes nothing');
                assert.deepEqual(migrate(f.db), { version:latest, applied:[] });
                assert.deepEqual(databaseState(f.db), before, 'repeat after restart changes nothing');
                assert.deepEqual(f.db.pragma('foreign_key_check'), []);
                assert.equal(f.db.pragma('integrity_check', { simple:true }), 'ok');
                coverage.databases += 1; coverage.restarts += 1;
            }
            coverage.cases += 1;
        } finally {
            for (const f of [fresh, upgraded]) if (f?.db.open) f.db.close();
        }
    });
    assert.equal(coverage.cases, summary.runs);
    assert.equal(coverage.databases, summary.runs * 2);
    t.diagnostic(`P-28-repeat seed=${summary.seed} ${JSON.stringify(coverage)}`);
});

function p28StatementChunks(sql) {
    const { statements, problems } = splitStatements(sql);
    assert.deepEqual(problems, []);
    const lines = sql.split('\n'), offsets = [0];
    for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
    // Insert only at top-level statement boundaries, never at a semicolon inside a trigger or string.
    statements.forEach((statement, index) => {
        if (index) assert.ok(statements[index - 1].endLine < statement.line, 'separate top-level statement lines');
    });
    const starts = statements.map(statement => offsets[statement.line - 1]);
    return { prefix:sql.slice(0, starts[0]), chunks:starts.map((start, index) => sql.slice(start, starts[index + 1] ?? sql.length)) };
}

function p28FailingCopy(parts, fault) {
    // The probe adds both DDL and DML and changes an existing user inside the real runner transaction. The SQLite
    // callback below witnesses these writes before the fault, avoiding a vacuous pass where nothing was executed.
    const probe = `CREATE TABLE P28RollbackProbe(id INTEGER PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0), user_id TEXT REFERENCES Users(user_id));
INSERT INTO P28RollbackProbe VALUES(1, 0, NULL);
UPDATE Users SET display_name='P28 pending' WHERE user_id=(SELECT user_id FROM Users ORDER BY user_id LIMIT 1);\n`;
    const checkpoint = index => `\nSELECT p28_checkpoint(${index}, (SELECT count(*) FROM P28RollbackProbe),
        (SELECT display_name FROM Users ORDER BY user_id LIMIT 1), (SELECT count(*) FROM SchemaMigrations));\n`;
    let copy = probe + parts.prefix + checkpoint(0);
    parts.chunks.forEach((chunk, index) => {
        if (fault.position === index) copy += fault.sql + '\n';
        copy += chunk + checkpoint(index + 1);
    });
    if (fault.position === parts.chunks.length) copy += fault.sql + '\n';
    return copy;
}

function p28AssertRollback(f, directory, parts, fault, pendingLedger = 7) {
    const before = databaseState(f.db), trace = [];
    f.db.function('p28_checkpoint', (index, rows, displayName, ledger) => {
        trace.push({ index, rows, displayName, ledger, inTransaction:f.db.inTransaction });
        return 1;
    });
    fs.writeFileSync(path.join(directory, '0008-groups.sql'), p28FailingCopy(parts, fault));
    assert.throws(() => migrate(f.db, { directory }), error => {
        assert.equal(error.code, 'MIGRATION_FAILED');
        assert.match(error.message, /\b0008-groups\.sql\b/);
        assertNoPath(error.message, directory, f.directory);
        assert.equal(error.cause?.code, fault.code, `${fault.label}: actual injected failure`);
        return true;
    });
    assert.deepEqual(trace, Array.from({ length:fault.position + 1 }, (_, index) =>
        ({ index, rows:1, displayName:'P28 pending', ledger:pendingLedger, inTransaction:true })), 'the selected prefix executed inside the transaction');
    assert.equal(f.db.inTransaction, false, 'the complete transaction ended');
    assert.deepEqual(databaseState(f.db), before, 'all schema, ledger and typed row digests rolled back');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal(f.db.pragma('integrity_check', { simple:true }), 'ok');
    f.db = reopenWithoutMigration(f);
    assert.deepEqual(databaseState(f.db), before, 'rollback persisted after reopening without migration');
}

function reopenWithoutMigration(f) {
    f.db.close();
    const db = openDatabase({ filename:guardPath(f.filename), migrate:false });
    f.connections.push(db);
    return db;
}

test('P-28: generated syntax, constraint and foreign-key failures at random 0008 boundaries roll back all schema, ledger and rows', { timeout:900000 }, async t => {
    const parts = p28StatementChunks(fs.readFileSync(path.join(MIGRATIONS, '0008-groups.sql'), 'utf8'));
    const published = publishedDirectory(t), coverage = { cases:0, failures:0 }, positions = new Set();
    const summary = await forAll('P-28-rollback', { runs:P28_RUNS, seed:P28_SEED, describe:p28Describe }, random => ({
        ...p28Generate(random), faults:random.shuffle(P28_FAULTS).map(fault => ({ ...fault, position:random.int(0, parts.chunks.length) })),
    }), value => {
        const f = guardedDatabase(t, { migrate:false }), directory = publishedDirectory(t);
        try {
            migrate(f.db, { directory:published });
            p28Populate(f, value.ops);
            for (const fault of value.faults) {
                p28AssertRollback(f, directory, parts, fault);
                coverage.failures += 1; positions.add(fault.position);
            }
            assert.deepEqual(migrate(f.db).applied, laterNames(), 'the unmodified migration still applies after failures');
            coverage.cases += 1;
        } finally { if (f.db.open) f.db.close(); }
    });
    assert.equal(coverage.cases, summary.runs);
    assert.equal(coverage.failures, summary.runs * P28_FAULTS.length);
    if (summary.replay === null) assert.ok(positions.size > 2, 'the generated positions vary');
    t.diagnostic(`P-28-rollback seed=${summary.seed} ${JSON.stringify(coverage)} positions=${[...positions].sort((a,b) => a-b).join(',')}`);
});

test('P-28: faults before the first and after the last 0008 statement also roll back an earlier pending migration', t => {
    const f = guardedDatabase(t, { migrate:false }), six = publishedDirectory(t), directory = publishedDirectory(t);
    // Only this newly created temporary copy is shortened. The published migration remains untouched.
    fs.unlinkSync(guardPath(path.join(six, PUBLISHED.at(-1))));
    assert.equal(migrate(f.db, { directory:six }).version, 6);
    insert(f.db, 'Users', { user_id:'p28-batch-owner', username:'p28batchowner', display_name:'P28 batch owner',
        status:'offline', created_at:SETUP, last_seen:SETUP });
    insert(f.db, 'Conversations', { conversation_id:'p28-batch-group', kind:'group', title:'P28 batch group', created_by:'p28-batch-owner',
        created_at:SETUP, updated_at:SETUP, origin:'authenticated' });
    insert(f.db, 'ConversationMembers', { conversation_id:'p28-batch-group', user_id:'p28-batch-owner', role:'owner', joined_at:SETUP });
    const parts = p28StatementChunks(fs.readFileSync(path.join(MIGRATIONS, '0008-groups.sql'), 'utf8'));
    for (const fault of P28_FAULTS) for (const position of [0, parts.chunks.length]) {
        p28AssertRollback(f, directory, parts, { ...fault, position });
        assert.equal(f.db.prepare('SELECT max(version) AS n FROM SchemaMigrations').get().n, 6, 'pending 0007 ledger insertion rolled back too');
    }
    assert.deepEqual(migrate(f.db).applied, ['0007-recipient-keys.sql', ...laterNames()]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM GroupExtensions').get().n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM GroupMembershipIntervals').get().n, 1);
    t.diagnostic('P-28-boundaries failures=6; pending 0007 and 0008 rolled back together');
});
