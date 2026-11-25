// T-5B-21 (DB5-R15.1, DB5-R15.2, DB5-R11.6, DB5-R14.17, NFR-07, NFR-08): tests of the shared group helpers in
// tests/support/groups.js. T-5B-22 to T-5B-28 extend this file with the Group_Repository tests.
// - snapshot(db) hashes each P-21 table that exists (rows in primary-key order, columns sorted) plus a total, leaves out
//   AuthRateLimits, names the changed table, and fails when a table created after 0007 is missing from its list.
// - The group fixture holds every actor class; the HTTP fixture gives each class its session state; assertSecurityHeaders
//   checks the createApp headers; guardPath refuses real paths outside os.tmpdir() and under /var/lib/secubuzz/.
// - A static check: no new test file or helper has the database file literal in code outside the guard helper.
// Every database lives in a new folder under os.tmpdir(); no test opens the database file of DATA/server/database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { migrate, loadMigrations } = require('../server/database/migrate');
const {
    SNAPSHOT_TABLES, SNAPSHOT_EXCLUDED, snapshot, changedTables, snapshotCompleteness,
    UnsafePathError, guardPath, temporaryDirectory, groupDatabase,
    INVITATION_EXPIRY_MS, ACTOR_CLASSES, groupFixture, httpGroupFixture, actorRequest,
    SECURITY_HEADERS, assertSecurityHeaders,
} = require('./support/groups');

const HEX64 = /^[0-9a-f]{64}$/;
const DATA_ROOT = path.join(__dirname, '..');
// Design, Correctness Properties, P-21: the twelve snapshot tables, in the order of the design.
const GROUP_SNAPSHOT_TABLES = ['Conversations', 'ConversationMembers', 'GroupExtensions', 'GroupMembershipIntervals', 'ConversationInvitations',
    'GroupReadPositions', 'GroupCreationKeys', 'Messages', 'MessageReceipts', 'Attachments', 'AttachmentReservations', 'AuditLogs'];
const MESSAGING_SNAPSHOT_TABLES = ['ConversationPinVersions','MessagePins','MessagePinOperations','MessageReactionVersions',
    'MessageReactionActors','MessageReactionOperations','EncryptedAttachmentBatches','MessageEditRevisions'];
const CUSTOMIZATION_SNAPSHOT_TABLES = ['ConversationNicknames','ConversationThemes','UserProfileAvatars'];
const P21_TABLES = [...GROUP_SNAPSHOT_TABLES,...MESSAGING_SNAPSHOT_TABLES,'VoiceRooms',...CUSTOMIZATION_SNAPSHOT_TABLES];
const TABLES_0012 = ['GroupExtensions', 'GroupMembershipIntervals', 'ConversationInvitations', 'GroupReadPositions', 'GroupCreationKeys'];
// The headers app.js sets on every response (NFR-08), transcribed independently of the helper.
const EXPECTED_HEADERS = {
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; frame-ancestors 'none'",
    'referrer-policy':'no-referrer',
};
const tablesOf = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// snapshot(db)
// ---------------------------------------------------------------------------------------------------------------
test('snapshot hashes each P-21 table that exists at the current version and a total, and leaves out AuthRateLimits', t => {
    assert.deepEqual(SNAPSHOT_TABLES, P21_TABLES);
    assert.deepEqual(SNAPSHOT_EXCLUDED, ['AuthRateLimits']);
    const f = groupFixture(t);
    const present = tablesOf(f.db);
    const before = snapshot(f.db);
    assert.deepEqual(Object.keys(before.tables), P21_TABLES.filter(table => present.has(table)));
    for (const table of TABLES_0012) assert.ok(table in before.tables, `${table} is hashed from version 12 on`);
    for (const table of CUSTOMIZATION_SNAPSHOT_TABLES) assert.ok(table in before.tables, `${table} is hashed from version 15 on`);
    assert.ok(present.has('AuthRateLimits') && !('AuthRateLimits' in before.tables));
    assert.ok(Object.values(before.tables).every(hash => HEX64.test(hash)), 'every table hash is SHA-256 hex');
    assert.match(before.total, HEX64);
    assert.deepEqual(snapshot(f.db), before, 'the same state gives the same snapshot');
    // P-21 allows the limiter counters to change on a refused request; they never reach the snapshot.
    f.db.prepare('INSERT INTO AuthRateLimits(bucket_hash, window_start_ms, expires_at_ms, attempts) VALUES(?, ?, ?, ?)').run('a'.repeat(64), 0, 60000, 1);
    assert.deepEqual(snapshot(f.db), before);
});

test('snapshot detects customization changes and returns to the original state after rollback', t => {
    const f = groupFixture(t);
    const { db, repositories, actors } = f;
    const [low, high] = [actors.owner.id, actors.member.id].sort();
    const conversationId = 'snapshot-customization-dm';
    repositories.conversations.create({ conversation_id:conversationId, kind:'direct', dm_user_low:low, dm_user_high:high, origin:'authenticated' });
    const before = snapshot(db);
    assert.throws(() => db.transaction(() => {
        db.prepare(`INSERT INTO UserProfileAvatars(user_id,storage_key,mime_type,byte_size,sha256)
            VALUES(?,?,?,?,?)`).run(actors.owner.id,'snapshot-avatar.png','image/png',8,'a'.repeat(64));
        repositories.conversations.setTheme(conversationId,'ocean',actors.owner.id,'2026-01-01T00:00:00.000Z');
        repositories.conversations.setNickname(conversationId,actors.member.id,'Member',actors.owner.id,'2026-01-01T00:00:00.000Z');
        assert.deepEqual(changedTables(before,snapshot(db)),CUSTOMIZATION_SNAPSHOT_TABLES);
        throw new Error('rollback snapshot fixture');
    })(),/rollback snapshot fixture/);
    assert.deepEqual(snapshot(db),before);
});

test('snapshot orders rows by primary key and sorts columns, so the insertion order does not change a hash', t => {
    const rows = ['audit-c', 'audit-a', 'audit-b'].map((id, index) => [id, `fixture.event.${index}`, `2026-01-01T00:00:0${index}.000Z`]);
    const insert = (db, row) => db.prepare('INSERT INTO AuditLogs(created_at, event_type, audit_id, source) VALUES(?, ?, ?, ?)')
        .run(row[2], row[1], row[0], 'groups-repository-test');
    const first = groupDatabase(t);
    const second = groupDatabase(t);
    for (const row of rows) insert(first.db, row);
    for (const row of [...rows].reverse()) insert(second.db, row);
    assert.equal(snapshot(first.db).tables.AuditLogs, snapshot(second.db).tables.AuditLogs);
    // Format: one JSON line per row in key order; keys sorted; each value as [SQLite type, value].
    const one = groupDatabase(t);
    insert(one.db, rows[1]);
    const line = JSON.stringify({ actor_user_id:['null', null], audit_id:['text', 'audit-a'], created_at:['text', rows[1][2]],
        event_type:['text', rows[1][1]], legacy_log_id:['null', null], metadata_json:['text', '{}'], severity:['text', 'info'],
        source:['text', 'groups-repository-test'], subject_id:['null', null] });
    assert.equal(snapshot(one.db).tables.AuditLogs, sha256(`${line}\n`));
    assert.equal(snapshot(groupDatabase(t).db).tables.AuditLogs, sha256(''), 'an empty table hashes the empty text');
});

test('a change confined to one P-21 table changes that hash and the total, and no other hash', t => {
    const f = groupFixture(t);
    const { builder, repositories, groupId, actors, clock } = f;
    const extra = id => repositories.users.create({ user_id:id, username:id, display_name:id }).user_id;
    const invitee = extra('grp-extra-invitee');
    const joiner = extra('grp-extra-joiner');
    const steps = [
        ['invitation', () => builder.invite(groupId, actors.admin.id, invitee), ['ConversationInvitations']],
        ['read position', () => builder.setReadPosition(groupId, actors.member.id, 0), ['GroupReadPositions']],
        ['direct add', () => builder.addMember(groupId, joiner), ['ConversationMembers', 'GroupExtensions', 'GroupMembershipIntervals']],
        ['removal', () => builder.removeMember(groupId, joiner), ['ConversationMembers', 'GroupExtensions', 'GroupMembershipIntervals']],
        ['second group', () => builder.createGroup({ ownerId:actors.nonMember.id, idempotencyKey:'fixture-second-group' }),
            ['Conversations', 'ConversationMembers', 'GroupExtensions', 'GroupMembershipIntervals', 'GroupCreationKeys']],
        ['message', () => repositories.messages.insert({ message_id:'grp-message-1', conversation_id:groupId, sender_id:actors.member.id,
            ciphertext:'opaque ciphertext, not plaintext', iv:'opaque-iv' }), ['Messages']],
        ['receipt', () => repositories.receipts.insert({ conversation_id:groupId, message_id:'grp-message-1', user_id:actors.admin.id,
            status:'delivered', observed_at:clock.iso() }), ['MessageReceipts']],
        ['attachment', () => repositories.attachments.insert({ attachment_id:'grp-attachment-1', conversation_id:groupId,
            uploaded_by:actors.member.id, storage_key:'grp-storage-key-1', byte_size:3 }), ['Attachments']],
        ['audit row', () => repositories.audit.insert({ audit_id:'grp-audit-1', event_type:'fixture.event', source:'groups-repository-test' }), ['AuditLogs']],
        ['role', () => repositories.members.setRole(groupId, actors.member.id, 'admin'), ['ConversationMembers']],
        ['archive', () => repositories.conversations.archive(groupId, clock.iso()), ['Conversations']],
    ];
    for (const [label, step, expected] of steps) {
        const before = snapshot(f.db);
        step();
        const after = snapshot(f.db);
        assert.deepEqual(changedTables(before, after), expected, label);
        for(const table of MESSAGING_SNAPSHOT_TABLES)assert.equal(after.tables[table],before.tables[table],`${label} preserves ${table}`);
        assert.notEqual(after.total, before.total, `${label} changes the total`);
    }
    const covered = new Set(steps.flatMap(([, , expected]) => expected));
    assert.deepEqual([...covered].sort(), GROUP_SNAPSHOT_TABLES.filter(table => table !== 'AttachmentReservations').sort(), 'the steps reach every group-owned table; messaging metadata stays unchanged');
});

test('the completeness check fails when a table created after 0007 is missing from the snapshot list', t => {
    const current = groupDatabase(t);
    const report = snapshotCompleteness(current.db);
    for (const table of TABLES_0012) assert.ok(report.created.includes(table), `${table} is created after version 7`);
    assert.ok(report.created.every(table => P21_TABLES.includes(table)), 'every table created after version 7 is on the list');
    assert.deepEqual(report.missing, []);
    // Copies of every migration plus one more file in a temporary folder; its table is not on the list.
    const directory = temporaryDirectory(t);
    const migrations = loadMigrations();
    for (const migration of migrations) fs.writeFileSync(path.join(directory, migration.name), migration.sql);
    const probeFile = `${String(migrations.length + 1).padStart(4, '0')}-unlisted-probe.sql`;
    fs.writeFileSync(path.join(directory, probeFile), 'CREATE TABLE UnlistedProbe (probe_id TEXT NOT NULL PRIMARY KEY);\n');
    const probe = groupDatabase(t, { migrate:false });
    assert.equal(migrate(probe.db, { directory }).applied.at(-1), probeFile);
    assert.deepEqual(snapshotCompleteness(probe.db).missing, ['UnlistedProbe']);
    assert.throws(() => snapshot(probe.db), error => error instanceof assert.AssertionError && /UnlistedProbe/.test(error.message));
});

// ---------------------------------------------------------------------------------------------------------------
// Group fixture and actor classes
// ---------------------------------------------------------------------------------------------------------------
test('groupFixture builds one group that holds every actor class through the repository', t => {
    const f = groupFixture(t);
    const { db, repositories, groupId, invitationId, actors, clock } = f;
    assert.deepEqual(ACTOR_CLASSES, ['unauthenticated', 'nonMember', 'pendingInvitee', 'member', 'admin', 'owner', 'removedMember']);
    assert.deepEqual(Object.keys(actors), ACTOR_CLASSES);
    assert.equal(actors.unauthenticated.id, null);
    assert.equal(guardPath(f.filename), f.filename, 'the database file passes the guard');
    const group = repositories.conversations.get(groupId);
    assert.deepEqual({ kind:group.kind, origin:group.origin, createdBy:group.created_by, archivedAt:group.archived_at },
        { kind:'group', origin:'authenticated', createdBy:actors.owner.id, archivedAt:null });
    const members = Object.fromEntries(repositories.members.list(groupId).map(row => [row.user_id, row]));
    assert.deepEqual(Object.keys(members).sort(), [actors.owner.id, actors.admin.id, actors.member.id, actors.removedMember.id].sort());
    for (const [actorClass, role] of [['owner', 'owner'], ['admin', 'admin'], ['member', 'member']]) {
        assert.equal(members[actors[actorClass].id].role, role, actorClass);
        assert.equal(members[actors[actorClass].id].left_at, null, `${actorClass} is active`);
    }
    assert.notEqual(members[actors.removedMember.id].left_at, null, 'the removed member has left_at');
    assert.equal(db.prepare("SELECT count(*) AS n FROM ConversationMembers WHERE conversation_id = ? AND role = 'owner' AND left_at IS NULL").get(groupId).n, 1);
    // create (revision 1), add admin (+1), role admin (+1), add member (+1), add removed member (+1), removal (+1)
    assert.deepEqual(db.prepare('SELECT description, history_policy, membership_revision FROM GroupExtensions WHERE conversation_id = ?').get(groupId),
        { description:null, history_policy:'from_joined', membership_revision:6 });
    const intervals = db.prepare('SELECT * FROM GroupMembershipIntervals WHERE conversation_id = ?').all(groupId);
    assert.equal(intervals.length, 4);
    for (const interval of intervals) {
        const removed = interval.user_id === actors.removedMember.id;
        assert.deepEqual({ no:interval.interval_no, first:interval.first_seq, last:interval.last_seq, joinedAt:interval.joined_at, leftAt:interval.left_at },
            { no:1, first:1, last:removed ? 0 : null, joinedAt:members[interval.user_id].joined_at, leftAt:members[interval.user_id].left_at }, interval.user_id);
    }
    const invitation = db.prepare('SELECT * FROM ConversationInvitations WHERE invitation_id = ?').get(invitationId);
    assert.deepEqual({ state:invitation.state, invitee:invitation.invitee_id, inviter:invitation.inviter_id, resolvedAt:invitation.resolved_at, createdAt:invitation.created_at },
        { state:'pending', invitee:actors.pendingInvitee.id, inviter:actors.owner.id, resolvedAt:null, createdAt:clock.iso() });
    assert.equal(Date.parse(invitation.expires_at) - Date.parse(invitation.created_at), INVITATION_EXPIRY_MS);
    assert.equal(db.prepare('SELECT conversation_id FROM GroupCreationKeys WHERE user_id = ?').get(actors.owner.id).conversation_id, groupId);
    for (const actorClass of ['nonMember', 'pendingInvitee']) assert.equal(repositories.members.get(groupId, actors[actorClass].id), null, actorClass);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('httpGroupFixture gives each actor class its session state, and every response carries the security headers', async t => {
    const f = await httpGroupFixture(t);
    assert.deepEqual(Object.keys(f.actors), ACTOR_CLASSES);
    assert.equal(f.repositories.members.get(f.groupId, f.actors.owner.id).role, 'owner');
    assert.notEqual(f.repositories.members.get(f.groupId, f.actors.removedMember.id).left_at, null);
    const before = snapshot(f.db);
    for (const actorClass of ACTOR_CLASSES) {
        const actor = f.actors[actorClass];
        const me = await actorRequest(actor, 'GET', '/api/auth/me');
        assertSecurityHeaders(me, `${actorClass} GET /api/auth/me`);
        if (actorClass === 'unauthenticated') {
            assert.equal(me.status, 401);
            assert.deepEqual(me.body, { code:'UNAUTHENTICATED', fields:[] });
        } else {
            assert.equal(me.status, 200, actorClass);
            assert.equal(me.body.user.id, actor.id, actorClass);
        }
        const unknown = await actorRequest(actor, 'POST', '/api/fixture-unknown-route', { body:{} });
        assertSecurityHeaders(unknown, `${actorClass} unknown route`);
        assert.equal(unknown.status, 404, actorClass);
    }
    assert.deepEqual(changedTables(before, snapshot(f.db)), [], 'reads and refused requests change no snapshot table');
});

test('assertSecurityHeaders fails when a header is missing or differs, or X-Powered-By is sent', () => {
    assert.deepEqual(SECURITY_HEADERS, EXPECTED_HEADERS);
    assert.doesNotThrow(() => assertSecurityHeaders({ headers:new Headers(EXPECTED_HEADERS) }));
    for (const name of Object.keys(EXPECTED_HEADERS)) {
        const missing = { ...EXPECTED_HEADERS };
        delete missing[name];
        assert.throws(() => assertSecurityHeaders({ headers:new Headers(missing) }), assert.AssertionError, `${name} missing`);
        assert.throws(() => assertSecurityHeaders({ headers:new Headers({ ...EXPECTED_HEADERS, [name]:'changed' }) }), assert.AssertionError, `${name} changed`);
    }
    assert.throws(() => assertSecurityHeaders({ headers:new Headers({ ...EXPECTED_HEADERS, 'X-Powered-By':'Express' }) }), assert.AssertionError);
    assert.throws(() => assertSecurityHeaders({}), TypeError);
});

// ---------------------------------------------------------------------------------------------------------------
// Path guard
// ---------------------------------------------------------------------------------------------------------------
const refusedAs = reason => error => error instanceof UnsafePathError && error.code === 'UNSAFE_TEST_PATH' && error.reason === reason;
// The database file name, built from fragments so that the static check below does not match this file.
const DATABASE_NAME = ['database', 'sqlite'].join('.');

test('guardPath accepts a path inside a new temporary folder and returns its real path', t => {
    const directory = temporaryDirectory(t);
    assert.ok(path.basename(directory).startsWith('secubuzz-db5-'));
    const file = path.join(directory, 'probe.txt');
    fs.writeFileSync(file, 'probe');
    assert.equal(guardPath(file), fs.realpathSync.native(file));
    assert.equal(guardPath(path.join(directory, 'not-yet', 'groups.sqlite')), path.join(fs.realpathSync.native(directory), 'not-yet', 'groups.sqlite'));
});

test('guardPath refuses the database file names, paths outside os.tmpdir() and the Docker_Environment volumes', t => {
    const fromTemporary = path.relative(path.resolve(os.tmpdir()), DATA_ROOT);
    assert.ok(fromTemporary.startsWith('..') || path.isAbsolute(fromTemporary), 'the repository lies outside os.tmpdir()');
    const canonical = path.join(DATA_ROOT, 'server', 'database', DATABASE_NAME);
    for (const suffix of ['', '-wal', '-shm', '-journal']) assert.throws(() => guardPath(canonical + suffix), refusedAs('database-file'), suffix);
    const directory = temporaryDirectory(t);
    assert.throws(() => guardPath(path.join(directory, DATABASE_NAME)), refusedAs('database-file'), 'the name is refused in a temporary folder too');
    assert.throws(() => guardPath(path.join(directory, DATABASE_NAME.toUpperCase())), refusedAs('database-file'));
    assert.throws(() => guardPath(DATA_ROOT), refusedAs('outside-temporary'));
    assert.throws(() => guardPath(path.join(DATA_ROOT, 'tests', 'probe.sqlite')), refusedAs('outside-temporary'));
    assert.throws(() => guardPath(os.tmpdir()), refusedAs('outside-temporary'), 'the temporary root itself is not a new folder');
    assert.throws(() => guardPath(path.join(directory, '..', '..', 'probe.sqlite')), refusedAs('outside-temporary'));
    for (const candidate of ['/var/lib/secubuzz', '/var/lib/secubuzz/sqlite-data/app.sqlite', '/var/lib/secubuzz/private-storage/key']) {
        assert.throws(() => guardPath(candidate), refusedAs('docker-volume'), candidate);
    }
    assert.throws(() => guardPath('/var/lib/secubuzzer/app.sqlite'), refusedAs('outside-temporary'), 'a sibling name is not the volume root');
    for (const bad of [undefined, null, '', 42, 'a\0b']) assert.throws(() => guardPath(bad), TypeError);
});

test('guardPath refuses a path under /var/lib/secubuzz/ even when the temporary folder lies there', () => {
    const names = ['TMPDIR', 'TMP', 'TEMP'];
    const saved = names.map(name => [name, process.env[name]]);
    const candidate = '/var/lib/secubuzz/tmp/secubuzz-db5-probe/groups.sqlite';
    try {
        for (const name of names) process.env[name] = '/var/lib/secubuzz/tmp';
        const root = path.resolve(os.tmpdir());
        assert.ok(root.replace(/\\/g, '/').endsWith('/var/lib/secubuzz/tmp'), 'os.tmpdir() follows the variables');
        assert.ok(!path.relative(root, path.resolve(candidate)).startsWith('..'), 'the candidate lies inside the temporary folder');
        assert.throws(() => guardPath(candidate), refusedAs('docker-volume'));
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('guardPath resolves links: a link inside the temporary folder that leads outside it is refused', t => {
    const directory = temporaryDirectory(t);
    const target = path.join(__dirname, 'fixtures');
    const link = path.join(directory, 'outside-link');
    fs.symlinkSync(target, link, 'junction');
    try {
        assert.throws(() => guardPath(link), refusedAs('outside-temporary'));
        assert.throws(() => guardPath(path.join(link, 'groups.sqlite')), refusedAs('outside-temporary'));
    } finally {
        fs.unlinkSync(link); // removes the link only
    }
    assert.ok(fs.existsSync(path.join(target, 'baseline-d7cd40a.json')), 'the link target is untouched');
});

// ---------------------------------------------------------------------------------------------------------------
// Static check (design, Testing Strategy section 10): no new test file or helper names the database file outside the
// guard helper. Scope: every file under tests/ that the baseline manifest does not list. A whole-line comment cannot
// open a file, so comment lines of script files are prose and are not reported (groups-migrations.test.js names the
// file in its header comment); every other line is. Two explicit exceptions:
// - support/groups.js is the guard helper; it refuses the file by name.
// - support/record-baseline.js names the three files once, in the NEVER_READ list that turns them into git
//   ':(exclude)' pathspecs of its working-tree guard, so the recorder never reads them. Only that line is permitted.
// ---------------------------------------------------------------------------------------------------------------
const GUARD_HELPER = 'support/groups.js';
const PERMITTED_LINES = Object.freeze({
    'support/record-baseline.js':line => line.startsWith('const NEVER_READ = [') && line.includes(':(exclude)DATA/server/database/'),
});
const SCRIPT = /\.[cm]?[jt]s$/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
function literalHits(file, text) {
    if (file === GUARD_HELPER) return [];
    const permitted = PERMITTED_LINES[file] || (() => false);
    return text.split(/\r?\n/).flatMap((line, index) => (line.toLowerCase().includes(DATABASE_NAME) && !permitted(line)
        && !(SCRIPT.test(file) && COMMENT_LINE.test(line)) ? [`${file}:${index + 1}`] : []));
}
function filesUnder(directory, prefix = '') {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes:true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) found.push(...filesUnder(path.join(directory, entry.name), `${relative}/`));
        else if (entry.isFile()) found.push(relative);
    }
    return found;
}

test('no new test file or helper contains the database file literal in code outside the guard helper', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'baseline-d7cd40a.json'), 'utf8'));
    const baseline = new Set([...Object.keys(manifest.tests), ...Object.keys(manifest.support)]);
    const scanned = filesUnder(__dirname).filter(file => !baseline.has(file));
    for (const file of [path.basename(__filename), GUARD_HELPER, 'support/record-baseline.js', 'fixtures/baseline-d7cd40a.json']) {
        assert.ok(scanned.includes(file), `${file} is scanned`);
    }
    assert.ok(!scanned.includes('repositories.test.js') && !scanned.includes('support/auth.js'), 'baseline files are not scanned');
    const hits = scanned.flatMap(file => literalHits(file, fs.readFileSync(path.join(__dirname, ...file.split('/')), 'utf8')));
    assert.deepEqual(hits, []);
    // The matcher: code in any other new file is reported in any letter case; comment lines, the guard helper and the
    // recorder's exclusion line are not; a second line of the recorder is.
    const code = `const target = path.join('server', 'database', '${DATABASE_NAME}');`;
    assert.deepEqual(literalHits('support/new-helper.js', `// header\n${code}\n`), ['support/new-helper.js:2']);
    assert.deepEqual(literalHits('new.test.js', code.toUpperCase()), ['new.test.js:1']);
    assert.deepEqual(literalHits('fixtures/new.json', `{"path": "// ${DATABASE_NAME}"}`), ['fixtures/new.json:1']);
    assert.deepEqual(literalHits('new.test.js', `// never opens ${DATABASE_NAME}\n * or ${DATABASE_NAME}`), []);
    assert.deepEqual(literalHits(GUARD_HELPER, code), []);
    const exclusion = `const NEVER_READ = ['${DATABASE_NAME}'].map(name => \`:(exclude)DATA/server/database/\${name}\`);`;
    assert.deepEqual(literalHits('support/record-baseline.js', `${exclusion}\n${code}`), ['support/record-baseline.js:2']);
});

// ---------------------------------------------------------------------------------------------------------------
// Group_Repository core (T-5B-22; DB5-R14.14, DB5-R13.5, DB5-R11.5, ARCH-R01.6, ARCH-R01.8, NFR-01): composition with
// createRepositories, the write-transaction guard, compare-and-set, the error normaliser and its class table (UNAVAILABLE
// is the provisional default of OP-09), the static scans of group SQL and of prepare calls, and the 404 of the routers
// that are not mounted yet. Every database is a temporary one; the busy and read-only cases open a second connection to
// the same temporary file.
// ---------------------------------------------------------------------------------------------------------------
const http = require('node:http');
const Database = require('better-sqlite3');
const { openDatabase } = require('../server/database/connection');
const { createRepositories, RepositoryError, translate } = require('../server/database/repositories');
const {
    createGroupRepository, withMembershipTransaction, readFunction, writeFunction, compareAndSet, normaliseError, ERROR_CLASSES, ERROR_CLASS_BY_CODE,
} = require('../server/database/groupRepository');
const { openLimiter } = require('./support/groups');
const { setup } = require('./support/auth');

const { SqliteError } = Database;
const SERVER_ROOT = path.join(DATA_ROOT, 'server');
const GROUP_REPOSITORY_FILE = 'server/database/groupRepository.js';
const readDataFile = file => fs.readFileSync(path.join(DATA_ROOT, ...file.split('/')), 'utf8');

// The thrown error is a RepositoryError of the class, with the fixed message and no other own property (no cause).
const classed = code => error => error instanceof RepositoryError && error.code === code
    && error.message === `Database operation failed: ${code}` && Object.keys(error).sort().join(',') === 'code,name';
function caught(work) {
    try {
        work();
    } catch (error) {
        return error;
    }
    return assert.fail('the statement was expected to fail');
}
// No fragment of the driver error (message, code, table, column, index, constraint or trigger name) reaches the
// normalised error: not its message, its text form, the first line of its stack or any own property.
function assertNoLeak(error, fragments) {
    const exposed = [error.message, String(error), String(error.stack).split('\n', 1)[0], JSON.stringify(error),
        ...Object.values(error).map(String)].map(text => text.toLowerCase());
    for (const fragment of fragments) {
        const needle = String(fragment).toLowerCase();
        assert.ok(needle.length > 0 && exposed.every(text => !text.includes(needle)), `"${fragment}" does not reach the error`);
    }
    assert.equal(error.cause, undefined);
}
const revisionOf = (db, groupId) => db.prepare('SELECT membership_revision AS n FROM GroupExtensions WHERE conversation_id = ?').get(groupId).n;
const descriptionOf = (db, groupId) => db.prepare('SELECT description FROM GroupExtensions WHERE conversation_id = ?').get(groupId).description;

test('createGroupRepository composes createRepositories(db) on the same connection, as socialRepository.js does', t => {
    const f = groupDatabase(t);
    const groups = createGroupRepository(f.db);
    assert.deepEqual(Object.keys(groups.repositories), Object.keys(createRepositories(f.db)));
    const user = groups.repositories.users.create({ user_id:'grp-composed', username:'grp-composed', display_name:'Composed User' });
    assert.deepEqual(f.db.prepare('SELECT user_id FROM Users WHERE user_id = ?').get('grp-composed'), { user_id:user.user_id });
    assert.ok(Object.isFrozen(groups));
    for (const bad of [undefined, null, {}, 'db']) assert.throws(() => createGroupRepository(bad), TypeError);
    // The module reuses the injected connection: it opens none and composes the existing repository layer.
    const source = readDataFile(GROUP_REPOSITORY_FILE);
    assert.match(source, /require\('\.\/repositories'\)/);
    assert.match(source, /createRepositories\(db\)/);
    assert.doesNotMatch(source, /new\s+Database\s*\(|openDatabase|require\('\.\/connection'\)/);
});

test('every Group_Repository function is a read or a write, and every write throws TypeError outside a transaction and changes nothing', t => {
    const f = groupFixture(t);
    const groups = createGroupRepository(f.db);
    const functions = Object.entries(groups).filter(([, value]) => typeof value === 'function');
    assert.ok(functions.length >= 1);
    for (const [name, fn] of functions) assert.ok(['read', 'write'].includes(fn.kind), `${name} is defined through readFunction or writeFunction`);
    const writes = functions.filter(([, fn]) => fn.kind === 'write');
    assert.ok(writes.some(([name]) => name === 'bumpRevision'));
    const before = snapshot(f.db);
    for (const [name, fn] of writes) {
        assert.equal(f.db.inTransaction, false);
        assert.throws(() => fn(f.groupId), error => error instanceof TypeError && !(error instanceof RepositoryError)
            && error.message === `Group_Repository.${name} needs an open write transaction`, name);
    }
    assert.deepEqual(changedTables(before, snapshot(f.db)), []);
});

test('bumpRevision adds exactly 1 inside a transaction and returns the new value; without an extension record it is a CONFLICT', t => {
    const f = groupFixture(t);
    const groups = createGroupRepository(f.db);
    const start = revisionOf(f.db, f.groupId);
    assert.equal(f.db.transaction(() => groups.bumpRevision(f.groupId)).immediate(), start + 1);
    assert.equal(revisionOf(f.db, f.groupId), start + 1);
    assert.deepEqual(f.db.transaction(() => [groups.bumpRevision(f.groupId), groups.bumpRevision(f.groupId)]).immediate(), [start + 2, start + 3]);
    assert.throws(() => f.db.transaction(() => {
        groups.bumpRevision(f.groupId);
        throw new Error('caller rolls back');
    }).immediate(), /caller rolls back/);
    assert.equal(revisionOf(f.db, f.groupId), start + 3, 'a rolled-back transaction leaves no trace');
    const direct = f.repositories.conversations.createAuthenticatedDirect(f.actors.owner.id, f.actors.member.id);
    const before = snapshot(f.db);
    for (const id of ['grp-unknown-group', direct.conversation_id]) {
        assert.throws(() => f.db.transaction(() => groups.bumpRevision(id)).immediate(), classed('CONFLICT'), id);
    }
    for (const bad of [undefined, null, '', 7, {}]) {
        assert.throws(() => f.db.transaction(() => groups.bumpRevision(bad)).immediate(), classed('INVALID'), String(bad));
    }
    assert.deepEqual(changedTables(before, snapshot(f.db)), []);
});

test('compareAndSet changes exactly one row or throws CONFLICT and leaves every row as it was', t => {
    const f = groupFixture(t);
    const { db, groupId } = f;
    const second = f.builder.createGroup({ ownerId:f.actors.nonMember.id, idempotencyKey:null });
    const everyNull = db.prepare('UPDATE GroupExtensions SET description = ? WHERE description IS NULL');
    const oneNull = db.prepare('UPDATE GroupExtensions SET description = ? WHERE conversation_id = ? AND description IS NULL');
    const returning = db.prepare('UPDATE GroupExtensions SET description = ? WHERE conversation_id = ? AND description = ? RETURNING description');
    db.transaction(() => {
        // Two rows match: refused, and both rows are restored while the caller's transaction goes on.
        assert.throws(() => compareAndSet(everyNull, 'both groups'), classed('CONFLICT'));
        assert.deepEqual([descriptionOf(db, groupId), descriptionOf(db, second)], [null, null]);
        assert.deepEqual(compareAndSet(oneNull, 'first', groupId), { changes:1 });
        assert.throws(() => compareAndSet(oneNull, 'stale', groupId), classed('CONFLICT'), 'a stale expectation changes nothing');
        assert.deepEqual(compareAndSet(returning, 'second', groupId, 'first'), { description:'second' });
        assert.throws(() => compareAndSet(returning, 'third', groupId, 'first'), classed('CONFLICT'));
    }).immediate();
    assert.deepEqual([descriptionOf(db, groupId), descriptionOf(db, second)], ['second', null]);
    const before = snapshot(db);
    assert.throws(() => compareAndSet(oneNull, 'outside', second), TypeError, 'outside a transaction');
    db.transaction(() => {
        assert.throws(() => compareAndSet(db.prepare('SELECT description FROM GroupExtensions')), TypeError, 'a statement that changes no row');
        for (const bad of [undefined, null, {}, 'UPDATE GroupExtensions SET description = NULL']) assert.throws(() => compareAndSet(bad), TypeError);
    }).immediate();
    assert.deepEqual(changedTables(before, snapshot(db)), []);
});

test('writeFunction runs in a savepoint and normalises errors; readFunction normalises errors and needs no transaction', t => {
    const f = groupFixture(t);
    const { db, groupId } = f;
    const twoSteps = writeFunction(db, 'twoSteps', (id, text) => {
        db.prepare('UPDATE GroupExtensions SET description = ? WHERE conversation_id = ?').run(text, id);
        db.prepare("UPDATE GroupExtensions SET history_policy = 'all' WHERE conversation_id = ?").run(id); // trigger abort
    });
    assert.equal(twoSteps.kind, 'write');
    db.transaction(() => {
        assert.throws(() => twoSteps(groupId, 'not kept'), classed('CONFLICT'));
        assert.equal(descriptionOf(db, groupId), null, 'the first statement is undone with the savepoint');
        db.prepare('UPDATE GroupExtensions SET description = ? WHERE conversation_id = ?').run('after the refusal', groupId);
    }).immediate();
    assert.equal(descriptionOf(db, groupId), 'after the refusal', 'the caller transaction goes on and commits');
    assert.throws(() => twoSteps(groupId, 'outside'), error => error instanceof TypeError && /twoSteps needs an open write transaction/.test(error.message));
    const lookup = readFunction(id => db.prepare('SELECT description FROM GroupExtensions WHERE conversation_id = ?').get(id));
    assert.equal(lookup.kind, 'read');
    assert.deepEqual(lookup(groupId), { description:'after the refusal' }, 'a read needs no transaction');
    assert.throws(() => readFunction(() => db.prepare('SELECT * FROM GroupNoSuchTable').all())(), classed('DATABASE'));
    assert.throws(() => readFunction(() => db.prepare('SELECT ? AS n').get())(), classed('DATABASE'), 'a binding error of the driver');
    const known = new RepositoryError('INVALID');
    assert.throws(() => readFunction(() => { throw known; })(), error => error === known, 'a RepositoryError passes unchanged');
    for (const bad of [undefined, 'not a function']) {
        assert.throws(() => readFunction(bad), TypeError);
        assert.throws(() => writeFunction(db, 'bad', bad), TypeError);
    }
    assert.throws(() => writeFunction(db, '', () => {}), TypeError);
});

test('normaliseError maps real constraint and statement errors to one class each, and no driver text reaches the error', t => {
    const f = groupFixture(t);
    const { db, groupId, actors, clock } = f;
    const insertKey = db.prepare('INSERT INTO GroupCreationKeys(user_id, idempotency_key, fingerprint, conversation_id, created_at) VALUES(?, ?, ?, ?, ?)');
    const cases = [
        ['DUPLICATE', 'unique index', () => db.prepare(`INSERT INTO ConversationInvitations(invitation_id, conversation_id, invitee_id,
            inviter_id, state, created_at, expires_at) VALUES('grp-second-pending', ?, ?, ?, 'pending', ?, ?)`)
            .run(groupId, actors.pendingInvitee.id, actors.admin.id, clock.iso(), clock.iso(INVITATION_EXPIRY_MS)),
        ['ConversationInvitations', 'invitee_id']],
        ['DUPLICATE', 'primary key', () => db.prepare('INSERT INTO GroupExtensions(conversation_id) VALUES(?)').run(groupId), ['GroupExtensions', 'conversation_id']],
        ['CONFLICT', 'trigger', () => db.prepare("UPDATE GroupExtensions SET history_policy = 'all' WHERE conversation_id = ?").run(groupId),
            ['group_extension_immutable']],
        ['INVALID', 'check', () => db.prepare('UPDATE GroupExtensions SET description = ? WHERE conversation_id = ?').run('d'.repeat(1001), groupId),
            ['CHECK constraint', 'length(description)']],
        ['INVALID', 'not null', () => insertKey.run(actors.member.id, 'grp-key', null, groupId, clock.iso()), ['GroupCreationKeys', 'fingerprint']],
        ['REFERENCE', 'foreign key', () => insertKey.run('grp-ghost-user', 'grp-key', 'a'.repeat(64), groupId, clock.iso()), ['FOREIGN KEY']],
        ['DATABASE', 'unknown table', () => db.prepare('SELECT * FROM GroupNoSuchTable').all(), ['GroupNoSuchTable']],
    ];
    const before = snapshot(db);
    for (const [expected, label, work, names] of cases) {
        const original = caught(work);
        assert.ok(original instanceof SqliteError, label);
        for (const name of names) assert.ok(original.message.includes(name), `${label}: the driver message names ${name}`);
        const normalised = normaliseError(original);
        assert.ok(classed(expected)(normalised), `${label} -> ${expected}`);
        assertNoLeak(normalised, [original.message, original.code, ...names]);
    }
    assert.deepEqual(changedTables(before, snapshot(db)), []);
});

test('busy, read-only and cannot-open errors of the driver become BUSY and UNAVAILABLE, also through a write function', t => {
    const f = groupFixture(t);
    const { db, groupId } = f;
    const start = revisionOf(db, groupId);
    const update = 'UPDATE GroupExtensions SET description = ? WHERE conversation_id = ?';
    // BUSY: a second connection without a busy timeout meets the write lock that the first connection holds.
    const other = openDatabase({ filename:f.filename, migrate:false, timeout:0 });
    f.connections.push(other);
    const otherGroups = createGroupRepository(other);
    let busy;
    db.prepare('BEGIN IMMEDIATE').run();
    try {
        busy = caught(() => other.prepare(update).run('blocked', groupId));
        assert.throws(() => other.transaction(() => otherGroups.bumpRevision(groupId)).deferred(), classed('BUSY'));
    } finally {
        db.prepare('ROLLBACK').run();
    }
    assert.ok(busy instanceof SqliteError && busy.code.startsWith('SQLITE_BUSY'), 'the driver reports busy');
    assert.ok(classed('BUSY')(normaliseError(busy)));
    assertNoLeak(normaliseError(busy), [busy.message, busy.code]);
    // UNAVAILABLE (OP-09, provisional): a read-only connection, and a database file that cannot be opened.
    const reader = new Database(guardPath(f.filename), { readonly:true, fileMustExist:true });
    f.connections.push(reader);
    const readOnly = caught(() => reader.prepare(update).run('read-only', groupId));
    assert.equal(readOnly.code, 'SQLITE_READONLY');
    assert.throws(() => reader.transaction(() => createGroupRepository(reader).bumpRevision(groupId))(), classed('UNAVAILABLE'));
    const directory = temporaryDirectory(t);
    const cannotOpen = caught(() => new Database(guardPath(path.join(directory, 'absent.sqlite')), { fileMustExist:true }));
    assert.equal(cannotOpen.code, 'SQLITE_CANTOPEN');
    for (const error of [readOnly, cannotOpen]) {
        const normalised = normaliseError(error);
        assert.ok(classed('UNAVAILABLE')(normalised), error.code);
        assertNoLeak(normalised, [error.message, error.code]);
    }
    assert.equal(revisionOf(db, groupId), start);
    assert.equal(descriptionOf(db, groupId), null);
});

// SQLite result codes and the class of the design's mapping table, written down independently of ERROR_CLASS_BY_CODE.
// Primary codes first, then extended codes, which take the class of their primary code unless the table names them.
const EXPECTED_CLASSES = Object.freeze({
    SQLITE_ERROR:'DATABASE', SQLITE_INTERNAL:'DATABASE', SQLITE_PERM:'DATABASE', SQLITE_ABORT:'DATABASE', SQLITE_BUSY:'BUSY',
    SQLITE_LOCKED:'BUSY', SQLITE_NOMEM:'DATABASE', SQLITE_READONLY:'UNAVAILABLE', SQLITE_INTERRUPT:'DATABASE',
    SQLITE_IOERR:'UNAVAILABLE', SQLITE_CORRUPT:'DATABASE', SQLITE_NOTFOUND:'DATABASE', SQLITE_FULL:'UNAVAILABLE',
    SQLITE_CANTOPEN:'UNAVAILABLE', SQLITE_PROTOCOL:'DATABASE', SQLITE_EMPTY:'DATABASE', SQLITE_SCHEMA:'DATABASE',
    SQLITE_TOOBIG:'DATABASE', SQLITE_CONSTRAINT:'INVALID', SQLITE_MISMATCH:'DATABASE', SQLITE_MISUSE:'DATABASE',
    SQLITE_NOLFS:'DATABASE', SQLITE_AUTH:'DATABASE', SQLITE_FORMAT:'DATABASE', SQLITE_RANGE:'DATABASE', SQLITE_NOTADB:'DATABASE',
    SQLITE_NOTICE:'DATABASE', SQLITE_WARNING:'DATABASE',
    SQLITE_CONSTRAINT_PRIMARYKEY:'DUPLICATE', SQLITE_CONSTRAINT_UNIQUE:'DUPLICATE', SQLITE_CONSTRAINT_TRIGGER:'CONFLICT',
    SQLITE_CONSTRAINT_CHECK:'INVALID', SQLITE_CONSTRAINT_NOTNULL:'INVALID', SQLITE_CONSTRAINT_DATATYPE:'INVALID',
    SQLITE_CONSTRAINT_FOREIGNKEY:'REFERENCE', SQLITE_BUSY_RECOVERY:'BUSY', SQLITE_BUSY_SNAPSHOT:'BUSY', SQLITE_BUSY_TIMEOUT:'BUSY',
    SQLITE_LOCKED_SHAREDCACHE:'BUSY', SQLITE_LOCKED_VTAB:'BUSY', SQLITE_READONLY_DBMOVED:'UNAVAILABLE',
    SQLITE_READONLY_RECOVERY:'UNAVAILABLE', SQLITE_READONLY_DIRECTORY:'UNAVAILABLE', SQLITE_IOERR_READ:'UNAVAILABLE',
    SQLITE_IOERR_WRITE:'UNAVAILABLE', SQLITE_IOERR_FSYNC:'UNAVAILABLE', SQLITE_IOERR_SHORT_READ:'UNAVAILABLE',
    SQLITE_CANTOPEN_ISDIR:'UNAVAILABLE', SQLITE_CANTOPEN_FULLPATH:'UNAVAILABLE', SQLITE_CORRUPT_INDEX:'DATABASE',
    SQLITE_ERROR_RETRY:'DATABASE', SQLITE_ABORT_ROLLBACK:'DATABASE',
});

test('the error class table gives each SQLite result code one class, UNAVAILABLE only for the four OP-09 kinds', () => {
    assert.deepEqual(ERROR_CLASSES, ['DUPLICATE', 'CONFLICT', 'INVALID', 'REFERENCE', 'BUSY', 'UNAVAILABLE', 'DATABASE']);
    assert.ok(Object.isFrozen(ERROR_CLASS_BY_CODE));
    assert.ok(Object.values(ERROR_CLASS_BY_CODE).every(errorClass => ERROR_CLASSES.includes(errorClass)));
    assert.deepEqual(Object.keys(ERROR_CLASS_BY_CODE).filter(code => ERROR_CLASS_BY_CODE[code] === 'UNAVAILABLE').sort(),
        ['SQLITE_CANTOPEN', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_READONLY']);
    for (const [code, expected] of Object.entries(EXPECTED_CLASSES)) {
        const text = `driver text for ${code.toLowerCase()}`;
        const normalised = normaliseError(new SqliteError(text, code));
        assert.ok(classed(expected)(normalised), `${code} -> ${expected}`);
        assertNoLeak(normalised, [text, code]);
    }
    // Only driver errors are classed; anything else is DATABASE, and a RepositoryError passes as it is.
    for (const other of [new Error('SQLITE_BUSY: database is locked'), Object.assign(new Error('locked'), { code:'SQLITE_BUSY' }),
        new TypeError('type'), new RangeError('range'), 'text', null, undefined]) assert.ok(classed('DATABASE')(normaliseError(other)), String(other));
    for (const errorClass of ERROR_CLASSES) {
        const known = new RepositoryError(errorClass);
        assert.equal(normaliseError(known), known);
    }
});

test('CI-12: normaliseError differs from the unchanged translate() only for trigger aborts and the OP-09 codes', t => {
    const f = groupFixture(t);
    const trigger = caught(() => f.db.prepare("UPDATE GroupExtensions SET history_policy = 'all' WHERE conversation_id = ?").run(f.groupId));
    assert.equal(trigger.code, 'SQLITE_CONSTRAINT_TRIGGER');
    assert.deepEqual([translate(trigger).code, normaliseError(trigger).code], ['INVALID', 'CONFLICT']);
    const differs = {};
    for (const code of Object.keys(EXPECTED_CLASSES)) {
        const error = new SqliteError('driver text', code);
        if (translate(error).code !== normaliseError(error).code) differs[code] = [translate(error).code, normaliseError(error).code];
    }
    assert.deepEqual(differs, {
        SQLITE_CONSTRAINT_TRIGGER:['INVALID', 'CONFLICT'], SQLITE_LOCKED_SHAREDCACHE:['DATABASE', 'BUSY'], SQLITE_LOCKED_VTAB:['DATABASE', 'BUSY'],
        SQLITE_READONLY:['DATABASE', 'UNAVAILABLE'], SQLITE_IOERR:['DATABASE', 'UNAVAILABLE'], SQLITE_FULL:['DATABASE', 'UNAVAILABLE'],
        SQLITE_CANTOPEN:['DATABASE', 'UNAVAILABLE'], SQLITE_READONLY_DBMOVED:['DATABASE', 'UNAVAILABLE'],
        SQLITE_READONLY_RECOVERY:['DATABASE', 'UNAVAILABLE'], SQLITE_READONLY_DIRECTORY:['DATABASE', 'UNAVAILABLE'],
        SQLITE_IOERR_READ:['DATABASE', 'UNAVAILABLE'], SQLITE_IOERR_WRITE:['DATABASE', 'UNAVAILABLE'], SQLITE_IOERR_FSYNC:['DATABASE', 'UNAVAILABLE'],
        SQLITE_IOERR_SHORT_READ:['DATABASE', 'UNAVAILABLE'], SQLITE_CANTOPEN_ISDIR:['DATABASE', 'UNAVAILABLE'],
        SQLITE_CANTOPEN_FULLPATH:['DATABASE', 'UNAVAILABLE'],
    });
    // An error that a composed repository already translated passes unchanged, so a trigger abort raised inside
    // repositories.* (here members_direct_insert) stays INVALID and is not re-classed as CONFLICT.
    const direct = f.repositories.conversations.createAuthenticatedDirect(f.actors.owner.id, f.actors.member.id);
    const composed = caught(() => f.repositories.members.insert({ conversation_id:direct.conversation_id, user_id:f.actors.nonMember.id }));
    assert.ok(classed('INVALID')(composed));
    assert.equal(normaliseError(composed), composed);
});

// ---------------------------------------------------------------------------------------------------------------
// Static scans (DB5-R14.14). Group SQL is any code line that names one of the five 0012 tables; a whole-line comment
// is prose (as in the database-file check above), and a .sql file comments with --. Scope: the runtime files of DATA
// (server/, scripts/ and server.js) except the migrations directory and groupRepository.js itself. Only script and SQL
// files are read, so no database file is ever opened. In groupRepository.js every prepare call takes exactly one string
// literal with no template placeholder and nothing after it, and db.exec is not used.
// ---------------------------------------------------------------------------------------------------------------
const RUNTIME_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.sql']);
const MIGRATIONS_DIRECTORY = 'server/database/migrations/';
const GROUP_SQL = new RegExp(`\\b(?:${TABLES_0012.join('|')})\\b`, 'i');
const SQL_COMMENT_LINE = /^\s*--/;
function groupSqlHits(file, text) {
    const comment = file.endsWith('.sql') ? SQL_COMMENT_LINE : COMMENT_LINE;
    return text.split(/\r?\n/).flatMap((line, index) => (GROUP_SQL.test(line) && !comment.test(line) ? [`${file}:${index + 1}`] : []));
}
function runtimeFiles() {
    const files = [...filesUnder(SERVER_ROOT, 'server/'), ...filesUnder(path.join(DATA_ROOT, 'scripts'), 'scripts/')];
    if (fs.existsSync(path.join(DATA_ROOT, 'server.js'))) files.push('server.js');
    return files.filter(file => RUNTIME_EXTENSIONS.has(path.extname(file)) && !file.startsWith(MIGRATIONS_DIRECTORY));
}
function prepareViolations(file, source) {
    const text = source.replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const lineOf = index => text.slice(0, index).split('\n').length;
    const violations = [];
    let calls = 0;
    const report = (index, reason) => violations.push(`${file}:${lineOf(index)} ${reason}`);
    const skipSpace = index => { let next = index; while (/\s/.test(text[next] ?? '')) next += 1; return next; };
    for (const match of text.matchAll(/\bprepare\b|\b(?:db|database)\s*\.\s*exec\b/g)) {
        if (COMMENT_LINE.test(lines[lineOf(match.index) - 1])) continue;
        if (match[0] !== 'prepare') { report(match.index, 'exec'); continue; }
        let index = skipSpace(match.index + match[0].length);
        if (text[index] !== '(') { report(match.index, 'not a call'); continue; }
        index = skipSpace(index + 1);
        const quote = text[index];
        if (!["'", '"', '`'].includes(quote)) { report(match.index, 'argument is not a string literal'); continue; }
        let end = -1;
        let interpolated = false;
        for (let position = index + 1; position < text.length; position += 1) {
            if (text[position] === '\\') { position += 1; continue; }
            if (quote === '`' && text[position] === '$' && text[position + 1] === '{') { interpolated = true; break; }
            if (text[position] === quote) { end = position; break; }
        }
        if (interpolated) { report(match.index, 'template placeholder'); continue; }
        if (end < 0) { report(match.index, 'unterminated literal'); continue; }
        if (text[skipSpace(end + 1)] !== ')') { report(match.index, 'concatenation or a second argument'); continue; }
        calls += 1;
    }
    return { calls, violations };
}

test('group SQL occurs in no runtime file of DATA but groupRepository.js, the migrations excepted', () => {
    const files = runtimeFiles();
    for (const file of [GROUP_REPOSITORY_FILE, 'server/app.js', 'server/groups/policy.js', 'server/database/schema.sql', 'server.js']) {
        assert.ok(files.includes(file), `${file} is scanned`);
    }
    assert.ok(!files.some(file => file.startsWith(MIGRATIONS_DIRECTORY)), 'the migrations directory is excluded');
    assert.ok(!files.some(file => /\.sqlite/i.test(file)), 'no database file is read');
    assert.ok(groupSqlHits(GROUP_REPOSITORY_FILE, readDataFile(GROUP_REPOSITORY_FILE)).length > 0, 'the scan sees the group SQL of groupRepository.js');
    const hits = files.filter(file => file !== GROUP_REPOSITORY_FILE).flatMap(file => groupSqlHits(file, readDataFile(file)));
    assert.deepEqual(hits, []);
    // The matcher: a code line naming a table is reported in any letter case; comment lines and longer names are not.
    const statement = "db.prepare('UPDATE GroupExtensions SET description = ? WHERE conversation_id = ?').run(text, id);";
    assert.deepEqual(groupSqlHits('server/groups/service.js', `// GroupExtensions holds the policy\n${statement}\n`), ['server/groups/service.js:2']);
    for (const table of TABLES_0012) {
        assert.deepEqual(groupSqlHits('server/messaging/service.js', `const sql = \`SELECT * FROM ${table.toLowerCase()}\`;`), ['server/messaging/service.js:1'], table);
    }
    assert.deepEqual(groupSqlHits('server/database/extra.sql', '-- GroupReadPositions\nSELECT 1 FROM GroupReadPositions;'), ['server/database/extra.sql:2']);
    assert.deepEqual(groupSqlHits('server/x.js', ' * GroupCreationKeys in a block comment\n/* ConversationInvitations */'), []);
    assert.deepEqual(groupSqlHits('server/x.js', 'const view = "MyGroupExtensionsView";'), []);
});

test('every prepare call of groupRepository.js binds its values: one string literal, no template placeholder, no concatenation', () => {
    const { calls, violations } = prepareViolations(GROUP_REPOSITORY_FILE, readDataFile(GROUP_REPOSITORY_FILE));
    assert.ok(calls >= 1, 'the scan finds the prepare calls');
    assert.deepEqual(violations, []);
    // The matcher.
    const reasons = source => prepareViolations('probe.js', source).violations.map(entry => entry.replace(/^probe\.js:\d+ /, ''));
    const accepted = "db.prepare('SELECT 1 WHERE a = ?').get(a);\ndb.prepare(\n    `SELECT n + 1 || ?\n    FROM t WHERE b = @b`\n).all({ b });\ndb.prepare('a \\' b');";
    assert.deepEqual(prepareViolations('probe.js', accepted), { calls:3, violations:[] });
    assert.deepEqual(reasons('db.prepare(`SELECT * FROM t WHERE a = ${a}`).get();'), ['template placeholder']);
    assert.deepEqual(reasons("db.prepare('SELECT * FROM t WHERE a = ' + a).get();"), ['concatenation or a second argument']);
    assert.deepEqual(reasons("db.prepare('SELECT 1', extra);"), ['concatenation or a second argument']);
    assert.deepEqual(reasons('db.prepare(sql).run();'), ['argument is not a string literal']);
    assert.deepEqual(reasons('db.prepare(String.raw`SELECT 1`);'), ['argument is not a string literal']);
    assert.deepEqual(reasons('const statement = db.prepare;'), ['not a call']);
    assert.deepEqual(reasons("db.exec('DELETE FROM t');"), ['exec']);
    assert.deepEqual(reasons("db.prepare('SELECT 1"), ['unterminated literal']);
    assert.deepEqual(reasons('// db.prepare(sql) in a comment\n * db.prepare(`${x}`)'), []);
});

// ---------------------------------------------------------------------------------------------------------------
// ARCH-R01.8: while a router file is absent, its path prefixes answer every method with the 404 NOT_FOUND of any
// unmatched /api path. Keyed to file existence, so the check ends by itself when DB-5C adds routes/groups.js or
// DB-6B adds routes/attachments.js. The real createApp runs on loopback over a temporary database (support/auth.js).
// ---------------------------------------------------------------------------------------------------------------
const UNMOUNTED_ROUTERS = Object.freeze([
    { file:'routes/groups.js', paths:['/api/groups', '/api/groups/', '/api/groups/probe-group', '/api/groups/probe-group/members',
        '/api/groups/invitations?limit=1'] },
    { file:'routes/attachments.js', paths:['/api/attachments', '/api/attachments/probe-file/download', '/api/files', '/api/files/search?q=probe'] },
]);
// fetch refuses CONNECT, TRACE and TRACK; every other method of the Node HTTP parser is sent.
const PROBE_METHODS = Object.freeze(http.METHODS.filter(method => !['CONNECT', 'TRACE', 'TRACK'].includes(method)));

test('while a router file is absent, every method on its path prefixes answers the 404 of an unmatched /api path', async t => {
    const absent = UNMOUNTED_ROUTERS.filter(router => !fs.existsSync(path.join(SERVER_ROOT, ...router.file.split('/'))));
    for (const router of UNMOUNTED_ROUTERS) if (!absent.includes(router)) t.diagnostic(`server/${router.file} exists; its routes are tested by their own tasks`);
    if (!absent.length) return;
    assert.ok(PROBE_METHODS.length > 7 && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].every(method => PROBE_METHODS.includes(method)));
    const f = await setup(t, { limiter:openLimiter() });
    const anonymous = f.browser();
    const user = f.browser();
    assert.equal((await user.register('grp-route-probe')).status, 201);
    assert.equal((await user.login('grp-route-probe')).status, 200);
    const token = await user.csrf();
    const before = snapshot(f.db);
    const shape = response => ({ status:response.status, text:response.text, type:response.headers.get('content-type') });
    for (const method of PROBE_METHODS) {
        for (const [label, browser, csrf] of [['unauthenticated', anonymous, null], ['authenticated', user, token]]) {
            const headers = csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'X-CSRF-Token':csrf } : {};
            const unmatched = await browser.request('/api/fixture-unmatched-route', { method, headers });
            assert.equal(unmatched.status, 404, `${method} /api/fixture-unmatched-route (${label})`);
            if (method !== 'HEAD') assert.deepEqual(unmatched.body, { code:'NOT_FOUND', fields:[] }, method);
            for (const router of absent) {
                for (const url of router.paths) {
                    const response = await browser.request(url, { method, headers });
                    assertSecurityHeaders(response, `${method} ${url} (${label})`);
                    assert.deepEqual(shape(response), shape(unmatched), `${method} ${url} (${label})`);
                }
            }
        }
    }
    assert.deepEqual(changedTables(before, snapshot(f.db)), [], 'the probes change no snapshot table');
});

// ---------------------------------------------------------------------------------------------------------------
// Direct-SQL constraint tests of 0012 (T-5B-23; DB5-R14.12, DB5-R04.2, R04.17, DB5-R06.2, DB5-R07.6, DB5-R08.1, R08.3,
// R08.4, DB5-R10.1, R10.2, DB5-R02.13). Each attempt is one plain INSERT, UPDATE or DELETE that bypasses the repository,
// on a temporary database. It must fail with the SQLite constraint code of the object that enforces the rule (design,
// "Constraint to requirement map"), its driver message must name that object, and snapshot(db) must be identical
// before and after the attempt.
// Approved Option A is exercised in groups-hardening.test.js with executable REPLACE/UPSERT and interval cases,
// including recursive_triggers OFF. The static scan below is additional defence, not the integrity mechanism.
// A second open interval now aborts in group_intervals_insert (CONFLICT), before its unique index (DUPLICATE).
// ---------------------------------------------------------------------------------------------------------------
// [driver code, text of the driver message that names the enforcing object]
const REJECTED = Object.freeze({
    pendingUnique:['SQLITE_CONSTRAINT_UNIQUE', 'ConversationInvitations.conversation_id, ConversationInvitations.invitee_id'],
    openIntervalConflict:['SQLITE_CONSTRAINT_TRIGGER', 'invalid_group_interval'],
    activeOwnerUnique:['SQLITE_CONSTRAINT_UNIQUE', 'ConversationMembers.conversation_id'],
    readPositionKey:['SQLITE_CONSTRAINT_PRIMARYKEY', 'GroupReadPositions.conversation_id, GroupReadPositions.user_id'],
    intervalInsert:['SQLITE_CONSTRAINT_TRIGGER', 'invalid_group_interval'],
    intervalImmutable:['SQLITE_CONSTRAINT_TRIGGER', 'group_interval_immutable'],
    intervalRetained:['SQLITE_CONSTRAINT_TRIGGER', 'group_interval_retained'],
    invitationTransition:['SQLITE_CONSTRAINT_TRIGGER', 'invalid_invitation_transition'],
    invitationRetained:['SQLITE_CONSTRAINT_TRIGGER', 'invitation_retained'],
    extensionImmutable:['SQLITE_CONSTRAINT_TRIGGER', 'group_extension_immutable'],
    extensionRetained:['SQLITE_CONSTRAINT_TRIGGER', 'group_extension_retained'],
    extensionGroupOnly:['SQLITE_CONSTRAINT_TRIGGER', 'invalid_group_extension'],
    readPositionMonotonic:['SQLITE_CONSTRAINT_TRIGGER', 'read_position_monotonic'],
    // ON DELETE RESTRICT fails at once, and SQLite reports it with the trigger code and its foreign-key text.
    deleteRestrict:['SQLITE_CONSTRAINT_TRIGGER', 'FOREIGN KEY constraint failed'],
    policyCheck:['SQLITE_CONSTRAINT_CHECK', "history_policy IN ('all','from_joined')"],
});

function assertRejected(db, label, [code, names], work) {
    const before = snapshot(db);
    let error = null;
    try {
        work();
    } catch (thrown) {
        error = thrown;
    }
    assert.ok(error, `${label}: the statement was expected to fail`);
    assert.ok(error instanceof SqliteError, `${label}: a driver error`);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    assert.ok(error.message.includes(names), `${label}: the driver message "${error.message}" names ${names}`);
    const after = snapshot(db);
    assert.deepEqual(changedTables(before, after), [], `${label}: no snapshot table changed`);
    assert.equal(after.total, before.total, `${label}: the snapshot total is unchanged`);
}
const run = (db, sql, ...parameters) => () => db.prepare(sql).run(...parameters);
const intervalsOf = (db, groupId, userId) => db.prepare(`SELECT interval_no, first_seq, last_seq FROM GroupMembershipIntervals
    WHERE conversation_id = ? AND user_id = ? ORDER BY interval_no`).all(groupId, userId);
const insertInterval = (db, row) => () => db.prepare(`INSERT INTO GroupMembershipIntervals(conversation_id, user_id, interval_no, first_seq,
    last_seq, joined_at, left_at) VALUES(@conversation_id, @user_id, @interval_no, @first_seq, @last_seq, @joined_at, @left_at)`).run(row);
const insertInvitation = (db, row) => () => db.prepare(`INSERT INTO ConversationInvitations(invitation_id, conversation_id, invitee_id,
    inviter_id, state, created_at, expires_at, resolved_at) VALUES(@invitation_id, @conversation_id, @invitee_id, @inviter_id, 'pending',
    @created_at, @expires_at, NULL)`).run(row);
const policyOf = (db, groupId) => db.prepare('SELECT history_policy FROM GroupExtensions WHERE conversation_id = ?').get(groupId).history_policy;
const positionOf = (db, groupId, userId) => db.prepare('SELECT position FROM GroupReadPositions WHERE conversation_id = ? AND user_id = ?')
    .get(groupId, userId).position;
const activeOwners = (db, groupId) => db.prepare(`SELECT user_id FROM ConversationMembers WHERE conversation_id = ? AND role = 'owner'
    AND left_at IS NULL ORDER BY user_id`).all(groupId).map(row => row.user_id);

// Authenticated group messages with the next message_seq, stored as the Message_Service stores them (opaque ciphertext).
function sendGroupMessages(f, senderId, count) {
    for (let index = 0; index < count; index += 1) {
        const seq = f.repositories.messages.highWater(f.groupId) + 1;
        f.repositories.messages.insertAuthenticated({ message_id:`grp-constraint-message-${seq}`, conversation_id:f.groupId, sender_id:senderId,
            receiver_id:null, ciphertext:'opaque ciphertext, not plaintext', iv:'opaque-iv', envelope_version:1, encoding:'base64',
            sender_name:'Group Member', client_timestamp:f.clock.iso(), message_type:'text', fingerprint:'a'.repeat(64),
            client_id:`grp-constraint-client-${seq}`, message_seq:seq, created_at:f.clock.iso() });
    }
}
// The group fixture with history: the member sends messages 1 to 3, a joiner is added (interval 1 opens at 4), the
// member sends 4 and 5, and the joiner is removed (interval 1 closes at 5). The member's interval 1 stays open from 1.
function intervalFixture(t) {
    const f = groupFixture(t);
    sendGroupMessages(f, f.actors.member.id, 3);
    const joinerId = f.repositories.users.create({ user_id:'grp-joiner', username:'grp-joiner', display_name:'Group Joiner' }).user_id;
    f.builder.addMember(f.groupId, joinerId);
    sendGroupMessages(f, f.actors.member.id, 2);
    f.clock.advance(1000);
    f.builder.removeMember(f.groupId, joinerId);
    assert.deepEqual(intervalsOf(f.db, f.groupId, joinerId), [{ interval_no:1, first_seq:4, last_seq:5 }]);
    assert.deepEqual(intervalsOf(f.db, f.groupId, f.actors.member.id), [{ interval_no:1, first_seq:1, last_seq:null }]);
    return { ...f, joinerId };
}

test('T-5B-23: uq_invitations_pending rejects a second pending Invitation for one group and invitee and changes no row', t => {
    const f = groupFixture(t);
    const { db, groupId, invitationId, actors, clock } = f;
    const second = { conversation_id:groupId, invitee_id:actors.pendingInvitee.id, created_at:clock.iso(), expires_at:clock.iso(INVITATION_EXPIRY_MS) };
    assertRejected(db, 'the same inviter', REJECTED.pendingUnique,
        insertInvitation(db, { ...second, invitation_id:'grp-second-pending-owner', inviter_id:actors.owner.id }));
    assertRejected(db, 'another manager', REJECTED.pendingUnique,
        insertInvitation(db, { ...second, invitation_id:'grp-second-pending-admin', inviter_id:actors.admin.id }));
    // The index covers pending rows only: once the first row is resolved, a new pending row for the pair is stored.
    assert.equal(db.prepare("UPDATE ConversationInvitations SET state = 'declined', resolved_at = ? WHERE invitation_id = ? AND state = 'pending'")
        .run(clock.iso(1000), invitationId).changes, 1);
    insertInvitation(db, { ...second, invitation_id:'grp-after-decline', inviter_id:actors.admin.id })();
    assert.equal(db.prepare("SELECT count(*) AS n FROM ConversationInvitations WHERE conversation_id = ? AND invitee_id = ? AND state = 'pending'")
        .get(groupId, actors.pendingInvitee.id).n, 1);
});

test('T-5B-23: a second open interval, an overlapping interval and a gap in the interval numbers are rejected and change no row', t => {
    const f = intervalFixture(t);
    const { db, groupId, actors, joinerId, clock } = f;
    const open = { conversation_id:groupId, last_seq:null, joined_at:clock.iso(2000), left_at:null };
    // An existing unbounded interval is rejected by the trigger even on a REPLACE path.
    assertRejected(db, 'a second open interval', REJECTED.openIntervalConflict,
        insertInterval(db, { ...open, user_id:actors.member.id, interval_no:2, first_seq:6 }));
    for (const firstSeq of [1, 4, 5]) {
        assertRejected(db, `an open interval 2 from ${firstSeq} overlaps the closed interval 4 to 5`, REJECTED.intervalInsert,
            insertInterval(db, { ...open, user_id:joinerId, interval_no:2, first_seq:firstSeq }));
    }
    assertRejected(db, 'a closed interval 2 from 5 to 6 overlaps the closed interval 4 to 5', REJECTED.intervalInsert,
        insertInterval(db, { ...open, user_id:joinerId, interval_no:2, first_seq:5, last_seq:6, left_at:clock.iso(3000) }));
    for (const intervalNo of [1, 3, 4]) {
        assertRejected(db, `interval number ${intervalNo} after interval 1`, REJECTED.intervalInsert,
            insertInterval(db, { ...open, user_id:joinerId, interval_no:intervalNo, first_seq:6 }));
    }
    f.repositories.members.insert({ conversation_id:groupId, user_id:actors.nonMember.id, role:'member' });
    assertRejected(db, 'a first interval numbered 2', REJECTED.intervalInsert,
        insertInterval(db, { ...open, user_id:actors.nonMember.id, interval_no:2, first_seq:6 }));
    // The rejoin shape passes: the next number, starting above the closed bound.
    db.transaction(() => {
        assert.equal(db.prepare('UPDATE ConversationMembers SET left_at = NULL WHERE conversation_id = ? AND user_id = ?').run(groupId, joinerId).changes, 1);
        insertInterval(db, { ...open, user_id:joinerId, interval_no:2, first_seq:6 })();
    }).immediate();
    assert.deepEqual(intervalsOf(db, groupId, joinerId), [{ interval_no:1, first_seq:4, last_seq:5 }, { interval_no:2, first_seq:6, last_seq:null }]);
});

test('T-5B-23: a closed interval cannot be edited or reopened, and an open interval changes only by closing', t => {
    const f = intervalFixture(t);
    const { db, groupId, actors, joinerId } = f;
    const later = '2099-01-01T00:00:00.000Z';
    const where = 'WHERE conversation_id = ? AND user_id = ? AND interval_no = 1';
    const closedEdits = [
        ['extend last_seq', `UPDATE GroupMembershipIntervals SET last_seq = 6 ${where}`, []],
        ['shrink last_seq', `UPDATE GroupMembershipIntervals SET last_seq = 4 ${where}`, []],
        ['move left_at', `UPDATE GroupMembershipIntervals SET left_at = ? ${where}`, [later]],
        ['move first_seq', `UPDATE GroupMembershipIntervals SET first_seq = 3 ${where}`, []],
        ['move joined_at', `UPDATE GroupMembershipIntervals SET joined_at = ? ${where}`, [later]],
        ['reopen', `UPDATE GroupMembershipIntervals SET last_seq = NULL, left_at = NULL ${where}`, []],
        ['renumber', `UPDATE GroupMembershipIntervals SET interval_no = 2 ${where}`, []],
        ['move to another member', `UPDATE GroupMembershipIntervals SET user_id = ? ${where}`, [actors.admin.id]],
    ];
    for (const [label, sql, values] of closedEdits) {
        assertRejected(db, `closed interval: ${label}`, REJECTED.intervalImmutable, run(db, sql, ...values, groupId, joinerId));
    }
    for (const [label, sql, values] of [
        ['move first_seq', `UPDATE GroupMembershipIntervals SET first_seq = 2 ${where}`, []],
        ['move joined_at', `UPDATE GroupMembershipIntervals SET joined_at = ? ${where}`, [later]],
        ['close without last_seq', `UPDATE GroupMembershipIntervals SET left_at = ? ${where}`, [later]],
    ]) {
        assertRejected(db, `open interval: ${label}`, REJECTED.intervalImmutable, run(db, sql, ...values, groupId, actors.member.id));
    }
    // Closing is the one change: last_seq and left_at once. Afterwards the interval is closed and immutable.
    assert.equal(db.prepare(`UPDATE GroupMembershipIntervals SET last_seq = 5, left_at = ? ${where}`).run(later, groupId, actors.member.id).changes, 1);
    assertRejected(db, 'a just-closed interval', REJECTED.intervalImmutable,
        run(db, `UPDATE GroupMembershipIntervals SET last_seq = 6 ${where}`, groupId, actors.member.id));
});

test('T-5B-23: an Invitation never leaves a terminal state, and its identity columns never change', t => {
    const f = groupFixture(t);
    const { db, groupId, invitationId, actors, clock, builder, repositories } = f;
    const otherGroup = builder.createGroup({ ownerId:actors.owner.id, idempotencyKey:null }); // the inviter is a member there too
    const set = (column, value, id) => run(db, `UPDATE ConversationInvitations SET ${column} = ? WHERE invitation_id = ?`, value, id);
    const identityChanges = id => [
        ['invitation_id', 'grp-renamed-invitation'], ['conversation_id', otherGroup], ['invitee_id', actors.nonMember.id],
        ['inviter_id', actors.admin.id], ['created_at', clock.iso(-1000)], ['expires_at', clock.iso(2 * INVITATION_EXPIRY_MS)],
    ].map(([column, value]) => [`change ${column}`, set(column, value, id)]);
    for (const [label, work] of [...identityChanges(invitationId), ['pending to pending', set('state', 'pending', invitationId)]]) {
        assertRejected(db, `pending row: ${label}`, REJECTED.invitationTransition, work);
    }
    const states = ['pending', 'accepted', 'declined', 'cancelled', 'expired'];
    for (const terminal of states.slice(1)) {
        const inviteeId = repositories.users.create({ user_id:`grp-${terminal}-invitee`, username:`grp-${terminal}-invitee`, display_name:terminal }).user_id;
        const id = builder.invite(groupId, actors.owner.id, inviteeId);
        const resolvedAt = clock.iso(1000);
        assert.equal(db.prepare("UPDATE ConversationInvitations SET state = ?, resolved_at = ? WHERE invitation_id = ? AND state = 'pending'")
            .run(terminal, resolvedAt, id).changes, 1, `pending to ${terminal} is allowed once`);
        for (const next of states.filter(state => state !== terminal)) {
            const work = next === 'pending'
                ? run(db, "UPDATE ConversationInvitations SET state = 'pending', resolved_at = NULL WHERE invitation_id = ?", id)
                : set('state', next, id);
            assertRejected(db, `${terminal} to ${next}`, REJECTED.invitationTransition, work);
        }
        assertRejected(db, `${terminal}: change resolved_at`, REJECTED.invitationTransition, set('resolved_at', clock.iso(2000), id));
        for (const [label, work] of identityChanges(id)) assertRejected(db, `${terminal}: ${label}`, REJECTED.invitationTransition, work);
    }
});

test('T-5B-23: no retained row can be deleted: the *_keep triggers and ON DELETE RESTRICT refuse it', t => {
    const f = intervalFixture(t);
    const { db, groupId, invitationId, actors, joinerId, clock } = f;
    const declinedId = f.builder.invite(groupId, actors.admin.id, actors.nonMember.id);
    db.prepare("UPDATE ConversationInvitations SET state = 'declined', resolved_at = ? WHERE invitation_id = ?").run(clock.iso(1000), declinedId);
    const member = 'DELETE FROM ConversationMembers WHERE conversation_id = ? AND user_id = ?';
    const interval = 'DELETE FROM GroupMembershipIntervals WHERE conversation_id = ? AND user_id = ?';
    for (const [label, expected, work] of [
        ['the extension record', REJECTED.extensionRetained, run(db, 'DELETE FROM GroupExtensions WHERE conversation_id = ?', groupId)],
        ['every extension record', REJECTED.extensionRetained, run(db, 'DELETE FROM GroupExtensions')],
        ['an open interval', REJECTED.intervalRetained, run(db, interval, groupId, actors.member.id)],
        ['a closed interval', REJECTED.intervalRetained, run(db, interval, groupId, joinerId)],
        ['every interval of the group', REJECTED.intervalRetained, run(db, 'DELETE FROM GroupMembershipIntervals WHERE conversation_id = ?', groupId)],
        ['a pending Invitation', REJECTED.invitationRetained, run(db, 'DELETE FROM ConversationInvitations WHERE invitation_id = ?', invitationId)],
        ['a declined Invitation', REJECTED.invitationRetained, run(db, 'DELETE FROM ConversationInvitations WHERE invitation_id = ?', declinedId)],
        ['the group conversation', REJECTED.deleteRestrict, run(db, 'DELETE FROM Conversations WHERE conversation_id = ?', groupId)],
        ['the owner row', REJECTED.deleteRestrict, run(db, member, groupId, actors.owner.id)],
        ['an active member row', REJECTED.deleteRestrict, run(db, member, groupId, actors.member.id)],
        ['a removed member row', REJECTED.deleteRestrict, run(db, member, groupId, joinerId)],
    ]) {
        assertRejected(db, `delete ${label}`, expected, work);
    }
});

test('T-5B-23: one Read_Position per group and member, and a stored position never decreases', t => {
    const f = groupFixture(t);
    const { db, groupId, actors, clock } = f;
    f.builder.setReadPosition(groupId, actors.member.id, 3);
    assertRejected(db, 'a second row for the pair', REJECTED.readPositionKey,
        run(db, 'INSERT INTO GroupReadPositions(conversation_id, user_id, position, updated_at) VALUES(?, ?, 5, ?)', groupId, actors.member.id, clock.iso()));
    for (const position of [2, 0]) {
        assertRejected(db, `UPDATE from 3 to ${position}`, REJECTED.readPositionMonotonic,
            run(db, 'UPDATE GroupReadPositions SET position = ? WHERE conversation_id = ? AND user_id = ?', position, groupId, actors.member.id));
    }
    assertRejected(db, 'an upsert that assigns a lower value', REJECTED.readPositionMonotonic,
        run(db, `INSERT INTO GroupReadPositions(conversation_id, user_id, position, updated_at) VALUES(?, ?, 1, ?)
            ON CONFLICT(conversation_id, user_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
        groupId, actors.member.id, clock.iso()));
    // The design's upsert keeps the larger value: a lower report leaves 3, a higher one stores it.
    f.builder.setReadPosition(groupId, actors.member.id, 1);
    assert.equal(positionOf(db, groupId, actors.member.id), 3);
    f.builder.setReadPosition(groupId, actors.member.id, 4);
    assert.equal(positionOf(db, groupId, actors.member.id), 4);
    assert.equal(db.prepare('SELECT count(*) AS n FROM GroupReadPositions WHERE conversation_id = ? AND user_id = ?').get(groupId, actors.member.id).n, 1);
});

test('T-5B-23: the Membership_Revision moves by exactly +1; any other step is rejected and changes no row', t => {
    const f = groupFixture(t);
    const { db, groupId } = f;
    const start = revisionOf(db, groupId);
    for (const [label, expression] of [['+2', 'membership_revision + 2'], ['-1', 'membership_revision - 1'], ['reset to 1', '1'],
        ['+100', 'membership_revision + 100'], ['+0.5', 'membership_revision + 0.5']]) {
        assertRejected(db, `revision step ${label}`, REJECTED.extensionImmutable,
            run(db, `UPDATE GroupExtensions SET membership_revision = ${expression} WHERE conversation_id = ?`, groupId));
    }
    const before = snapshot(db);
    assert.equal(db.prepare('UPDATE GroupExtensions SET membership_revision = membership_revision WHERE conversation_id = ?').run(groupId).changes, 1);
    assert.deepEqual(changedTables(before, snapshot(db)), [], 'assigning the stored revision is no change');
    assert.equal(db.prepare('UPDATE GroupExtensions SET membership_revision = membership_revision + 1 WHERE conversation_id = ?').run(groupId).changes, 1);
    assert.equal(revisionOf(db, groupId), start + 1);
});

test('T-5B-23: group_extensions_update rejects a history_policy change in either direction; a same-value and a description UPDATE pass', t => {
    const f = groupFixture(t);
    const { db, groupId, actors, builder, repositories, clock } = f;
    const create = (historyPolicy, archived) => {
        const id = builder.createGroup({ ownerId:actors.owner.id, historyPolicy, idempotencyKey:null });
        if (archived) assert.equal(repositories.conversations.archive(id, clock.iso()).changes, 1);
        return id;
    };
    const groups = [['from_joined', groupId], ['all', create('all', false)], ['from_joined', create('from_joined', true)], ['all', create('all', true)]];
    const policy = run.bind(null, db, 'UPDATE GroupExtensions SET history_policy = ? WHERE conversation_id = ?');
    for (const [stored, id] of groups) {
        const other = stored === 'all' ? 'from_joined' : 'all';
        const state = repositories.conversations.get(id).archived_at === null ? 'unarchived' : 'archived';
        assertRejected(db, `${state} group: ${stored} to ${other}`, REJECTED.extensionImmutable, policy(other, id));
        assertRejected(db, `${state} group: ${stored} to ${other} together with the description`, REJECTED.extensionImmutable,
            run(db, 'UPDATE GroupExtensions SET description = ?, history_policy = ? WHERE conversation_id = ?', 'not stored', other, id));
        const before = snapshot(db);
        assert.equal(policy(stored, id)().changes, 1, `${state} group: assigning the stored ${stored} passes`);
        assert.deepEqual(changedTables(before, snapshot(db)), [], `${state} group: the same-value UPDATE changes no row`);
        assert.equal(policyOf(db, id), stored);
    }
    for (const [label, column, value] of [['created_at', 'created_at', '2000-01-01T00:00:00.000Z'], ['conversation_id', 'conversation_id', groups[1][1]]]) {
        assertRejected(db, `change ${label}`, REJECTED.extensionImmutable,
            run(db, `UPDATE GroupExtensions SET ${column} = ? WHERE conversation_id = ?`, value, groupId));
    }
    const before = snapshot(db);
    assert.equal(db.prepare('UPDATE GroupExtensions SET description = ? WHERE conversation_id = ?').run('A new description', groupId).changes, 1);
    assert.deepEqual(changedTables(before, snapshot(db)), ['GroupExtensions']);
    assert.deepEqual([descriptionOf(db, groupId), policyOf(db, groupId)], ['A new description', 'from_joined']);
});

test('T-5B-23: a GroupExtensions row for a direct or unknown conversation is rejected, and a policy outside all and from_joined fails the CHECK', t => {
    const f = groupFixture(t);
    const { db, actors, repositories } = f;
    const direct = repositories.conversations.createAuthenticatedDirect(actors.owner.id, actors.member.id).conversation_id;
    const insert = 'INSERT INTO GroupExtensions(conversation_id, description, history_policy, membership_revision) VALUES(?, NULL, ?, 1)';
    for (const historyPolicy of ['from_joined', 'all']) {
        assertRejected(db, `direct conversation with ${historyPolicy}`, REJECTED.extensionGroupOnly, run(db, insert, direct, historyPolicy));
    }
    assertRejected(db, 'unknown conversation', REJECTED.extensionGroupOnly, run(db, insert, 'grp-unknown-conversation', 'from_joined'));
    // A group conversation without an extension record, as older code paths create it (DB5-R14.18).
    const bare = repositories.conversations.create({ kind:'group', title:'Bare group', created_by:actors.owner.id, origin:'authenticated' }).conversation_id;
    for (const historyPolicy of ['none', 'ALL', 'From_Joined', '', 'all ']) {
        assertRejected(db, `history_policy ${JSON.stringify(historyPolicy)}`, REJECTED.policyCheck, run(db, insert, bare, historyPolicy));
    }
    assert.equal(run(db, insert, bare, 'all')().changes, 1);
    assert.equal(policyOf(db, bare), 'all');
});

test('T-5B-23: the active-owner index uq_members_active_owner rejects a second active owner', t => {
    const f = groupFixture(t);
    const { db, groupId, actors } = f;
    const promote = 'UPDATE ConversationMembers SET role = ? WHERE conversation_id = ? AND user_id = ?';
    assertRejected(db, 'insert a second owner', REJECTED.activeOwnerUnique,
        run(db, "INSERT INTO ConversationMembers(conversation_id, user_id, role) VALUES(?, ?, 'owner')", groupId, actors.nonMember.id));
    assertRejected(db, 'promote the admin', REJECTED.activeOwnerUnique, run(db, promote, 'owner', groupId, actors.admin.id));
    assertRejected(db, 'promote the member', REJECTED.activeOwnerUnique, run(db, promote, 'owner', groupId, actors.member.id));
    assertRejected(db, 'reactivate the removed member as owner', REJECTED.activeOwnerUnique,
        run(db, "UPDATE ConversationMembers SET role = 'owner', left_at = NULL WHERE conversation_id = ? AND user_id = ?", groupId, actors.removedMember.id));
    // A transfer passes only in the order demote first, then promote (policy.js transferDecision).
    assertRejected(db, 'promote before demote', REJECTED.activeOwnerUnique, () => db.transaction(() => {
        db.prepare(promote).run('owner', groupId, actors.admin.id);
        db.prepare(promote).run('admin', groupId, actors.owner.id);
    }).immediate());
    db.transaction(() => {
        db.prepare(promote).run('admin', groupId, actors.owner.id);
        db.prepare(promote).run('owner', groupId, actors.admin.id);
    }).immediate();
    assert.deepEqual(activeOwners(db, groupId), [actors.admin.id]);
});

// ---------------------------------------------------------------------------------------------------------------
// Static scan (T-5B-23 mitigation): no runtime file writes a 0012 table through a REPLACE conflict path (REPLACE INTO,
// INSERT OR REPLACE, UPDATE OR REPLACE) or through INSERT OR IGNORE. Scope and comment rule as in the group SQL scan
// above: server/ without the migrations, scripts/ and server.js; whole-line comments are prose. A statement may span
// lines, use any letter case, a schema prefix and a quoted table name. The keywords are built from fragments, so this
// file does not match its own patterns.
// ---------------------------------------------------------------------------------------------------------------
const REPLACE_KEYWORD = ['REP', 'LACE'].join('');
const IGNORE_KEYWORD = ['IGN', 'ORE'].join('');
const OPEN_QUOTE = '["\'`\\[]?';
const CLOSE_QUOTE = '["\'`\\]]?';
const TABLE_0012_REFERENCE = `(?:${OPEN_QUOTE}(?:main|temp)${CLOSE_QUOTE}\\s*\\.\\s*)?${OPEN_QUOTE}(?:${TABLES_0012.join('|')})${CLOSE_QUOTE}(?![\\w$])`;
const CONFLICT_PATHS = Object.freeze([
    new RegExp(`\\b(?:INSERT\\s+OR\\s+)?${REPLACE_KEYWORD}\\s+INTO\\s+${TABLE_0012_REFERENCE}`, 'gi'),
    new RegExp(`\\bUPDATE\\s+OR\\s+${REPLACE_KEYWORD}\\s+${TABLE_0012_REFERENCE}`, 'gi'),
    new RegExp(`\\bINSERT\\s+OR\\s+${IGNORE_KEYWORD}\\s+INTO\\s+${TABLE_0012_REFERENCE}`, 'gi'),
]);
function conflictPathHits(file, text) {
    const comment = file.endsWith('.sql') ? SQL_COMMENT_LINE : COMMENT_LINE;
    const code = text.split(/\r?\n/).map(line => (comment.test(line) ? '' : line)).join('\n');
    const lineOf = index => code.slice(0, index).split('\n').length;
    return CONFLICT_PATHS.flatMap(pattern => [...code.matchAll(pattern)]).sort((a, b) => a.index - b.index)
        .map(match => `${file}:${lineOf(match.index)} ${match[0].replace(/\s+/g, ' ')}`);
}

test('T-5B-23: no runtime file of DATA writes a 0012 table through a REPLACE conflict path or INSERT OR IGNORE', () => {
    const files = runtimeFiles();
    for (const file of [GROUP_REPOSITORY_FILE, 'server/database/repositories.js', 'scripts/migrate.js', 'server.js']) assert.ok(files.includes(file), `${file} is scanned`);
    assert.ok(!files.some(file => file.startsWith(MIGRATIONS_DIRECTORY)), 'the migrations directory is excluded');
    assert.deepEqual(files.flatMap(file => conflictPathHits(file, readDataFile(file))), []);
    assert.deepEqual(conflictPathHits(path.basename(__filename), fs.readFileSync(__filename, 'utf8')), [], 'this file does not match itself');
    // The matcher: each form and each 0012 table is reported with the line of its first keyword.
    const R = REPLACE_KEYWORD;
    const I = IGNORE_KEYWORD;
    for (const table of TABLES_0012) {
        for (const statement of [`${R} INTO ${table}`, `INSERT OR ${R} INTO ${table}`, `UPDATE OR ${R} ${table}`, `INSERT OR ${I} INTO ${table}`]) {
            assert.deepEqual(conflictPathHits('server/probe.js', `const sql = '${statement} (a) VALUES (?)';`), [`server/probe.js:1 ${statement}`], statement);
        }
    }
    assert.deepEqual(conflictPathHits('server/probe.js', `// header\nconst sql = \`insert or ${R.toLowerCase()}\n    into main."GroupReadPositions"(position) VALUES(?)\`;`),
        [`server/probe.js:2 insert or ${R.toLowerCase()} into main."GroupReadPositions"`]);
    assert.deepEqual(conflictPathHits('scripts/probe.js', `db.prepare('Update Or ${R} [GroupExtensions] SET description = ?');`),
        [`scripts/probe.js:1 Update Or ${R} [GroupExtensions]`]);
    assert.deepEqual(conflictPathHits('server/probe.sql', `-- ${R} INTO GroupExtensions\n${R} INTO GroupExtensions(conversation_id) VALUES('x');`),
        [`server/probe.sql:2 ${R} INTO GroupExtensions`]);
    // Not reported: comment lines, other tables, longer names, the replace() method and SQL function, and the upsert.
    for (const text of [
        `// never ${R} INTO GroupExtensions\n * nor INSERT OR ${I} INTO ConversationInvitations`,
        `const sql = 'INSERT OR ${R} INTO AuthRateLimits(bucket_hash) VALUES(?)';`,
        `const sql = '${R} INTO GroupExtensionsArchive(conversation_id) VALUES(?)';`,
        `const name = title.${R.toLowerCase()}(/a/g, 'b');`,
        `const sql = 'SELECT ${R.toLowerCase()}(title, ?, ?) FROM Conversations';`,
        `const sql = 'INSERT INTO GroupReadPositions(conversation_id, user_id, position, updated_at) VALUES(?, ?, ?, ?)
            ON CONFLICT(conversation_id, user_id) DO UPDATE SET position = max(position, excluded.position)';`,
    ]) {
        assert.deepEqual(conflictPathHits('server/probe.js', text), [], text);
    }
});

// T-5B-24: repository reads only. Internal list methods return limit+1 raw rows,
// like socialRepository; DTOs, cursor encoding and authorization remain service work.
test('T-5B-24: visible group and composed membership reads fail closed and do not write', t => {
    const f = groupFixture(t), groups = createGroupRepository(f.db);
    const visible = groups.getVisibleGroup(f.groupId);
    assert.equal(visible.conversation_id, f.groupId);
    assert.equal(visible.title, 'Fixture group');
    assert.equal(visible.history_policy, 'from_joined');
    assert.equal(groups.getMember(f.groupId, f.actors.owner.id).role, 'owner');
    assert.equal(groups.getMember(f.groupId, f.actors.removedMember.id).left_at !== null, true);
    assert.equal(groups.getMember(f.groupId, f.actors.nonMember.id), null);
    assert.equal(groups.countActiveMembers(f.groupId), 3);
    const direct = f.repositories.conversations.create({ conversation_id:'t24-direct', kind:'direct',
        dm_user_low:f.actors.admin.id, dm_user_high:f.actors.member.id, origin:'authenticated' });
    const bare = f.repositories.conversations.create({ conversation_id:'t24-bare', kind:'group', title:'Bare',
        created_by:f.actors.owner.id, origin:'authenticated' });
    const legacy = f.builder.createGroup({ ownerId:f.actors.owner.id, conversationId:'t24-legacy', idempotencyKey:null });
    f.db.prepare("UPDATE Conversations SET origin='legacy' WHERE conversation_id=?").run(legacy);
    for (const id of [direct.conversation_id, bare.conversation_id, legacy, 'unknown', "' OR 1=1 --"]) {
        assert.equal(groups.getVisibleGroup(id), null);
        assert.equal(groups.getMember(id, f.actors.owner.id), null);
        assert.equal(groups.countActiveMembers(id), 0);
        assert.deepEqual(groups.listMembers(id), []);
    }
    const before = snapshot(f.db);
    for (const name of ['getVisibleGroup', 'getMember', 'countActiveMembers', 'listGroupsForUser', 'listMembers', 'getCreationKey', 'invariantReport']) {
        assert.equal(groups[name].kind, 'read', name);
    }
    groups.getVisibleGroup(f.groupId);
    groups.getMember(f.groupId, f.actors.member.id);
    groups.countActiveMembers(f.groupId);
    groups.listGroupsForUser(f.actors.owner.id);
    groups.listMembers(f.groupId);
    groups.invariantReport(f.groupId);
    groups.getCreationKey(f.actors.owner.id, 'fixture-group-create');
    assert.deepEqual(snapshot(f.db), before);
});

test('T-5B-24: group pagination is descending, scoped to active membership and includes archived groups', t => {
    const f = groupFixture(t), groups = createGroupRepository(f.db), actor = f.actors.member.id;
    f.db.prepare("UPDATE Conversations SET updated_at='2020-01-01',archived_at='2024-01-01' WHERE conversation_id=?").run(f.groupId);
    for (const id of ['t24-a', 't24-b', 't24-c']) {
        f.builder.createGroup({ ownerId:actor, conversationId:id, idempotencyKey:null });
        f.db.prepare("UPDATE Conversations SET updated_at='2026-06-01' WHERE conversation_id=?").run(id);
    }
    const hidden = f.builder.createGroup({ ownerId:actor, conversationId:'t24-hidden', idempotencyKey:null });
    f.db.prepare("UPDATE Conversations SET origin='legacy' WHERE conversation_id=?").run(hidden);
    f.repositories.conversations.create({ conversation_id:'t24-without-extension', kind:'group', title:'Bare', created_by:actor, origin:'authenticated' });
    const first = groups.listGroupsForUser(actor, { limit:2 });
    assert.deepEqual(first.map(row => row.conversation_id), ['t24-c', 't24-b', 't24-a']);
    assert.equal(first[0].role, 'owner');
    assert.equal(first[0].member_count, 1);
    assert.equal(first[0].unread_count, 0);
    const second = groups.listGroupsForUser(actor, { limit:2, after:[first[1].updated_at, first[1].conversation_id] });
    assert.deepEqual(second.map(row => row.conversation_id), ['t24-a', f.groupId]);
    assert.equal(second[1].role, 'member');
    assert.equal(second[1].member_count, 3);
    assert.equal(second[1].archived_at, '2024-01-01');
    assert.deepEqual(groups.listGroupsForUser(actor, { limit:2, after:{ last:[second[1].updated_at, f.groupId] } }), []);
    assert.deepEqual(groups.listGroupsForUser(f.actors.pendingInvitee.id), []);
    assert.deepEqual(groups.listGroupsForUser(f.actors.removedMember.id), []);
    assert.deepEqual(groups.listGroupsForUser("' OR 1=1 --"), []);
});

test('T-5B-24: unread counts obey both history policies, rejoin gaps, positions, tombstones and sender identity', t => {
    for (const historyPolicy of ['from_joined', 'all']) {
        const f = groupFixture(t, { group:{ historyPolicy } }), groups = createGroupRepository(f.db);
        const actor = f.actors.nonMember.id;
        sendGroupMessages(f, f.actors.owner.id, 4);
        f.clock.advance(); f.builder.addMember(f.groupId, actor);
        sendGroupMessages(f, f.actors.owner.id, 2);
        f.clock.advance(); f.builder.removeMember(f.groupId, actor);
        sendGroupMessages(f, f.actors.owner.id, 2);
        f.clock.advance();
        f.db.transaction(() => {
            f.db.prepare('UPDATE ConversationMembers SET left_at=NULL WHERE conversation_id=? AND user_id=?').run(f.groupId, actor);
            insertInterval(f.db, { conversation_id:f.groupId, user_id:actor, interval_no:2, first_seq:9,
                last_seq:null, joined_at:f.clock.iso(), left_at:null })();
        }).immediate();
        sendGroupMessages(f, f.actors.owner.id, 2);
        sendGroupMessages(f, actor, 2);
        f.db.prepare('UPDATE Messages SET deleted_at=?,revision=revision+1 WHERE conversation_id=? AND message_seq=6').run(f.clock.iso(), f.groupId);
        const unread = () => groups.listGroupsForUser(actor)[0].unread_count;
        assert.equal(unread(), historyPolicy === 'all' ? 7 : 3, historyPolicy);
        f.builder.setReadPosition(f.groupId, actor, 5); assert.equal(unread(), 2);
        f.builder.setReadPosition(f.groupId, actor, 9); assert.equal(unread(), 1);
        f.builder.removeMember(f.groupId, actor);
        assert.deepEqual(groups.listGroupsForUser(actor), []);
    }
});

test('T-5B-24: member pages use the current interval join, public profile fields and separate former ordering', t => {
    const f = groupFixture(t), groups = createGroupRepository(f.db);
    // Pin join-time ties independently of the real clock used by the baseline
    // repository defaults. The later rejoin must actually be later than these.
    f.clock.advance(Date.parse('2030-01-01T00:00:00.000Z') - f.clock.now());
    f.groupId = f.repositories.conversations.create({ conversation_id:'t24-member-order', kind:'group', title:'Ordered', origin:'authenticated' }).conversation_id;
    f.db.prepare('INSERT INTO GroupExtensions(conversation_id) VALUES(?)').run(f.groupId);
    for (const [actor, role, former] of [['owner','owner',false], ['admin','admin',false], ['member','member',false], ['removedMember','member',true]]) {
        f.db.prepare('INSERT INTO ConversationMembers(conversation_id,user_id,role,joined_at,left_at) VALUES(?,?,?,?,?)')
            .run(f.groupId, f.actors[actor].id, role, f.clock.iso(), former ? f.clock.iso() : null);
        insertInterval(f.db, { conversation_id:f.groupId, user_id:f.actors[actor].id, interval_no:1, first_seq:1,
            last_seq:former ? 0 : null, joined_at:f.clock.iso(), left_at:former ? f.clock.iso() : null })();
    }
    f.clock.advance(); f.builder.removeMember(f.groupId, f.actors.member.id); f.clock.advance();
    f.db.transaction(() => {
        f.db.prepare('UPDATE ConversationMembers SET left_at=NULL WHERE conversation_id=? AND user_id=?').run(f.groupId, f.actors.member.id);
        insertInterval(f.db, { conversation_id:f.groupId, user_id:f.actors.member.id, interval_no:2, first_seq:1,
            last_seq:null, joined_at:f.clock.iso(), left_at:null })();
    }).immediate();
    const first = groups.listMembers(f.groupId, { limit:1 });
    assert.deepEqual(first.map(row => row.user_id), [f.actors.admin.id, f.actors.owner.id]);
    const later = groups.listMembers(f.groupId, { limit:1, after:[first[0].joined_at, first[0].user_id] });
    assert.deepEqual(later.map(row => row.user_id), [f.actors.owner.id, f.actors.member.id]);
    const last = groups.listMembers(f.groupId, { after:[later[0].joined_at, later[0].user_id] });
    assert.equal(last[0].user_id, f.actors.member.id);
    assert.notEqual(last[0].joined_at, groups.getMember(f.groupId, f.actors.member.id).joined_at);
    assert.deepEqual(Object.keys(last[0]).sort(), ['avatar','display_name','joined_at','left_at','role','user_id','username']);
    assert.equal(last[0].username, f.actors.member.username);
    f.clock.advance(); f.builder.addMember(f.groupId, f.actors.nonMember.id);
    f.clock.advance(); f.builder.removeMember(f.groupId, f.actors.nonMember.id);
    const former = groups.listMembers(f.groupId, { former:true, limit:1 });
    assert.deepEqual(former.map(row => row.user_id), [f.actors.removedMember.id, f.actors.nonMember.id]);
    assert.ok(former.every(row => row.left_at !== null));
    assert.deepEqual(groups.listMembers(f.groupId, { former:true, after:[former[0].left_at, former[0].user_id] }).map(row => row.user_id), [f.actors.nonMember.id]);
});

test('T-5B-24: creation keys are scoped to their user and visible group', t => {
    const f = groupFixture(t), groups = createGroupRepository(f.db);
    const key = groups.getCreationKey(f.actors.owner.id, 'fixture-group-create');
    assert.equal(key.conversation_id, f.groupId);
    assert.match(key.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(groups.getCreationKey(f.actors.member.id, 'fixture-group-create'), null);
    assert.equal(groups.getCreationKey(f.actors.owner.id, 'absent'), null);
    assert.equal(groups.getCreationKey(f.actors.owner.id, "' OR 1=1 --"), null);
    f.db.prepare("UPDATE Conversations SET origin='legacy' WHERE conversation_id=?").run(f.groupId);
    assert.equal(groups.getCreationKey(f.actors.owner.id, 'fixture-group-create'), null);
});

test('T-5B-24: invariantReport finds mismatches even when total active and open counts coincide', t => {
    const f = groupFixture(t), groups = createGroupRepository(f.db);
    assert.deepEqual(groups.invariantReport(f.groupId), { activeOwners:1, activeMembers:3, openIntervals:3, mismatches:0 });
    f.repositories.members.leave(f.groupId, f.actors.member.id, f.clock.iso());
    f.repositories.members.insert({ conversation_id:f.groupId, user_id:f.actors.nonMember.id, role:'member' });
    assert.deepEqual(groups.invariantReport(f.groupId), { activeOwners:1, activeMembers:3, openIntervals:3, mismatches:2 });
    assert.deepEqual(groups.invariantReport('absent'), { activeOwners:0, activeMembers:0, openIntervals:0, mismatches:0 });
});

test('T-5B-24: pagination bounds and malformed internal keys produce normalised INVALID errors', t => {
    const f = groupFixture(t), groups = createGroupRepository(f.db), before = snapshot(f.db);
    for (const limit of [0, 51, -1, 1.5, '2', null]) {
        assert.throws(() => groups.listGroupsForUser(f.actors.owner.id, { limit }), classed('INVALID'));
        assert.throws(() => groups.listMembers(f.groupId, { limit }), classed('INVALID'));
    }
    for (const after of [[], ['x'], [null, 'x'], ['x', 1], 'cursor']) {
        assert.throws(() => groups.listGroupsForUser(f.actors.owner.id, { after }), classed('INVALID'));
    }
    assert.throws(() => groups.listMembers(f.groupId, { former:'true' }), classed('INVALID'));
    assert.deepEqual(snapshot(f.db), before);
});

test('T-5B-24: list query plans use indexes without full message or membership scans', t => {
    const f = groupFixture(t), original = f.db.prepare, captured = [];
    f.db.prepare = function(sql) { captured.push(sql); return original.call(this, sql); };
    try {
        const groups = createGroupRepository(f.db);
        for (const work of [() => groups.listGroupsForUser(f.actors.member.id), () => groups.listMembers(f.groupId),
            () => groups.listMembers(f.groupId, { former:true })]) {
            captured.length = 0; work();
            const sql = captured.at(-1);
            const plan = original.call(f.db, 'EXPLAIN QUERY PLAN ' + sql).all({ actor:f.actors.member.id, id:f.groupId,
                take:21, lastTime:null, lastId:null }).map(row => row.detail).join('\n');
            assert.match(plan, /USING (?:COVERING )?INDEX/);
            const aliases = [...sql.matchAll(/(?:FROM|JOIN)\s+(?:Messages|ConversationMembers)\s+(\w+)/g)].map(match => match[1]);
            assert.ok(aliases.length > 0, 'the plan check identifies the message/membership aliases');
            for (const alias of aliases) assert.doesNotMatch(plan, new RegExp('\\bSCAN '+alias+'\\b'), plan);
            t.diagnostic(plan);
        }
    } finally { f.db.prepare = original; }
});

// T-5B-25 primitives are paired in one immediate transaction, as design.md's
// Group_Service/groupWrite and Concurrency sections require. Membership rows
// and intervals can differ between the two primitives; no such state commits.
const T25_WRITES = ['addMember','reactivateMember','endMembership','changeRole','transferOwnership','openIntervalAt','closeInterval'];
const t25Healthy = (groups, id) => {
    const report = groups.invariantReport(id);
    assert.equal(report.activeOwners, 1);
    assert.equal(report.openIntervals, report.activeMembers);
    assert.equal(report.mismatches, 0);
};
function t25Fixture(t) {
    const { createClock } = require('./support/groups');
    const f = groupFixture(t, { clock:createClock('2030-01-01T00:00:00.000Z') });
    return { ...f, groups:createGroupRepository(f.db) };
}
function t25Refused(f, work, code = 'CONFLICT') {
    const before = snapshot(f.db);
    assert.throws(() => withMembershipTransaction(f.db, work), classed(code));
    assert.deepEqual(snapshot(f.db), before);
    t25Healthy(f.groups, f.groupId);
}

test('T-5B-25: all seven writes require the caller transaction before validating arguments', t => {
    const f = t25Fixture(t), before = snapshot(f.db);
    for (const name of T25_WRITES) {
        assert.equal(f.groups[name].kind, 'write', name);
        assert.throws(() => f.groups[name](f.groupId), error => error instanceof TypeError
            && error.message === `Group_Repository.${name} needs an open write transaction`, name);
    }
    assert.deepEqual(snapshot(f.db), before);
});

test('T-5B-25: add and open use the supplied join time and the current high-water plus one', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f;
    sendGroupMessages(f, actors.owner.id, 3);
    const revision = revisionOf(db, groupId), at = clock.iso();
    withMembershipTransaction(db, () => {
        const member = groups.addMember(groupId, actors.nonMember.id, at);
        assert.equal(member.role, 'member');
        assert.equal(member.joined_at, at);
        assert.equal(member.left_at, null);
        const opened = groups.openIntervalAt(groupId, actors.nonMember.id, at, 4);
        assert.deepEqual([opened.interval_no, opened.first_seq, opened.last_seq, opened.joined_at], [1, 4, null, at]);
        t25Healthy(groups, groupId);
    });
    assert.equal(revisionOf(db, groupId), revision, 'service owns the once-per-operation revision/audit work');
    t25Healthy(groups, groupId);
});

test('T-5B-25: end, close, reactivate and rejoin preserve original joined_at and every closed interval', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f;
    const originalJoin = groups.getMember(groupId, actors.member.id).joined_at;
    sendGroupMessages(f, actors.owner.id, 3);
    withMembershipTransaction(db, () => {
        groups.changeRole(groupId, actors.member.id, 'member', 'admin');
        t25Healthy(groups, groupId);
        const ended = groups.endMembership(groupId, actors.member.id, clock.iso());
        assert.equal(ended.left_at, clock.iso());
        const closed = groups.closeInterval(groupId, actors.member.id, clock.iso(), 3);
        assert.deepEqual([closed.first_seq, closed.last_seq], [1, 3]);
        t25Healthy(groups, groupId);
    });
    const first = db.prepare('SELECT * FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=? AND interval_no=1').get(groupId, actors.member.id);
    sendGroupMessages(f, actors.owner.id, 2); clock.advance();
    withMembershipTransaction(db, () => {
        const member = groups.reactivateMember(groupId, actors.member.id, clock.iso());
        assert.equal(member.role, 'member');
        assert.equal(member.joined_at, originalJoin);
        const opened = groups.openIntervalAt(groupId, actors.member.id, clock.iso(), 6);
        assert.equal(opened.interval_no, 2);
        t25Healthy(groups, groupId);
    });
    assert.deepEqual(db.prepare('SELECT * FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=? AND interval_no=1').get(groupId, actors.member.id), first);
    // No message during this membership: [6,5] is a valid empty closed period.
    clock.advance();
    withMembershipTransaction(db, () => {
        groups.endMembership(groupId, actors.member.id, clock.iso());
        assert.equal(groups.closeInterval(groupId, actors.member.id, clock.iso()).last_seq, 5);
        t25Healthy(groups, groupId);
    });
    clock.advance();
    withMembershipTransaction(db, () => {
        groups.reactivateMember(groupId, actors.member.id, clock.iso());
        assert.equal(groups.openIntervalAt(groupId, actors.member.id, clock.iso()).first_seq, 6);
        t25Healthy(groups, groupId);
    });
    assert.equal(groups.getMember(groupId, actors.member.id).joined_at, originalJoin);
    assert.deepEqual(intervalsOf(db, groupId, actors.member.id), [
        { interval_no:1, first_seq:1, last_seq:3 }, { interval_no:2, first_seq:6, last_seq:5 }, { interval_no:3, first_seq:6, last_seq:null },
    ]);
});

test('T-5B-25: stale membership expectations cannot overwrite an active owner or retained member', t => {
    const f = t25Fixture(t), { groups, groupId, actors, clock } = f;
    for (const actor of [actors.owner, actors.member, actors.removedMember]) {
        t25Refused(f, () => groups.addMember(groupId, actor.id, clock.iso()));
    }
    for (const actor of [actors.owner, actors.admin, actors.member, actors.nonMember]) {
        t25Refused(f, () => groups.reactivateMember(groupId, actor.id, clock.iso()));
    }
    for (const actor of [actors.owner, actors.removedMember, actors.nonMember]) {
        t25Refused(f, () => groups.endMembership(groupId, actor.id, clock.iso()));
    }
});

test('T-5B-25: role CAS requires the expected active non-owner role and preserves membership intervals', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors } = f;
    const before = intervalsOf(db, groupId, actors.member.id);
    withMembershipTransaction(db, () => {
        assert.equal(groups.changeRole(groupId, actors.member.id, 'member', 'admin').role, 'admin');
        t25Healthy(groups, groupId);
        assert.equal(groups.changeRole(groupId, actors.member.id, 'admin', 'member').role, 'member');
        t25Healthy(groups, groupId);
    });
    assert.deepEqual(intervalsOf(db, groupId, actors.member.id), before);
    for (const work of [() => groups.changeRole(groupId, actors.member.id, 'admin', 'member'),
        () => groups.changeRole(groupId, actors.member.id, 'member', 'member'),
        () => groups.changeRole(groupId, actors.owner.id, 'owner', 'admin'),
        () => groups.changeRole(groupId, actors.removedMember.id, 'member', 'admin')]) t25Refused(f, work);
    t25Refused(f, () => groups.changeRole(groupId, actors.member.id, 'member', 'owner'), 'INVALID');
});

test('T-5B-25: ownership transfer demotes first, promotes an active member/admin and preserves intervals', t => {
    for (const target of ['member', 'admin']) {
        const f = t25Fixture(t), { groups, db, groupId, actors } = f;
        const before = db.prepare('SELECT * FROM GroupMembershipIntervals ORDER BY conversation_id,user_id,interval_no').all();
        withMembershipTransaction(db, () => {
            groups.transferOwnership(groupId, actors.owner.id, actors[target].id);
            assert.equal(groups.getMember(groupId, actors.owner.id).role, 'admin');
            assert.equal(groups.getMember(groupId, actors[target].id).role, 'owner');
            t25Healthy(groups, groupId);
        });
        assert.deepEqual(db.prepare('SELECT * FROM GroupMembershipIntervals ORDER BY conversation_id,user_id,interval_no').all(), before);
        t25Refused(f, () => groups.transferOwnership(groupId, actors.owner.id, actors.nonMember.id));
    }
});

test('T-5B-25: failed second transfer step restores the owner even when the caller catches and commits', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors } = f;
    withMembershipTransaction(db, () => {
        const before = snapshot(db);
        for (const target of [actors.removedMember.id, actors.nonMember.id, actors.owner.id]) {
            assert.throws(() => groups.transferOwnership(groupId, actors.owner.id, target), classed('CONFLICT'));
            assert.deepEqual(snapshot(db), before);
            t25Healthy(groups, groupId);
        }
        db.prepare("CREATE TEMP TRIGGER t25_fail_promotion BEFORE UPDATE OF role ON ConversationMembers WHEN NEW.role='owner' BEGIN SELECT RAISE(ABORT,'synthetic promotion failure'); END").run();
        assert.throws(() => groups.transferOwnership(groupId, actors.owner.id, actors.member.id), classed('CONFLICT'));
        assert.deepEqual(snapshot(db), before);
        t25Healthy(groups, groupId);
        groups.changeRole(groupId, actors.member.id, 'member', 'admin');
    });
    assert.equal(groups.getMember(groupId, actors.owner.id).role, 'owner');
    assert.equal(groups.getMember(groupId, actors.member.id).role, 'admin');
    t25Healthy(groups, groupId);
});

test('T-5B-25: stale high-water, duplicate open and repeated close attempts leave no partial membership', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f;
    sendGroupMessages(f, actors.owner.id, 2);
    for (const seq of [1, 2, 4]) t25Refused(f, () => {
        groups.addMember(groupId, actors.nonMember.id, clock.iso());
        groups.openIntervalAt(groupId, actors.nonMember.id, clock.iso(), seq);
    });
    t25Refused(f, () => groups.openIntervalAt(groupId, actors.member.id, clock.iso(), 3));
    t25Refused(f, () => groups.openIntervalAt(groupId, actors.nonMember.id, clock.iso(), 3));
    t25Refused(f, () => groups.closeInterval(groupId, actors.owner.id, clock.iso(), 2));
    for (const seq of [0, 1, 3]) t25Refused(f, () => {
        groups.endMembership(groupId, actors.member.id, clock.iso());
        groups.closeInterval(groupId, actors.member.id, clock.iso(), seq);
    });
    withMembershipTransaction(db, () => {
        groups.endMembership(groupId, actors.member.id, clock.iso());
        groups.closeInterval(groupId, actors.member.id, clock.iso(), 2);
        const before = snapshot(db);
        assert.throws(() => groups.closeInterval(groupId, actors.member.id, clock.iso(), 2), classed('CONFLICT'));
        assert.deepEqual(snapshot(db), before);
        t25Healthy(groups, groupId);
    });
});

test('T-5B-25: the caller rollback restores a completed join, removal, role change and transfer', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f, before = snapshot(db);
    assert.throws(() => withMembershipTransaction(db, () => {
        groups.addMember(groupId, actors.nonMember.id, clock.iso());
        groups.openIntervalAt(groupId, actors.nonMember.id, clock.iso()); t25Healthy(groups, groupId);
        groups.endMembership(groupId, actors.member.id, clock.iso());
        groups.closeInterval(groupId, actors.member.id, clock.iso()); t25Healthy(groups, groupId);
        groups.changeRole(groupId, actors.nonMember.id, 'member', 'admin'); t25Healthy(groups, groupId);
        groups.transferOwnership(groupId, actors.owner.id, actors.admin.id); t25Healthy(groups, groupId);
        throw new Error('synthetic caller rollback');
    }), /synthetic caller rollback/);
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-25: writes reject hidden/direct groups and invalid values without changing any row', t => {
    const f = t25Fixture(t), { groups, db, actors, clock } = f;
    const direct = f.repositories.conversations.create({ conversation_id:'t25-direct', kind:'direct', origin:'authenticated',
        dm_user_low:actors.admin.id, dm_user_high:actors.member.id });
    const bare = f.repositories.conversations.create({ conversation_id:'t25-bare', kind:'group', origin:'authenticated', title:'Bare', created_by:actors.owner.id });
    for (const id of ['unknown', direct.conversation_id, bare.conversation_id]) {
        for (const work of [() => groups.addMember(id, actors.nonMember.id, clock.iso()),
            () => groups.reactivateMember(id, actors.removedMember.id, clock.iso()),
            () => groups.endMembership(id, actors.member.id, clock.iso()),
            () => groups.changeRole(id, actors.member.id, 'member', 'admin'),
            () => groups.transferOwnership(id, actors.owner.id, actors.admin.id),
            () => groups.openIntervalAt(id, actors.member.id, clock.iso()),
            () => groups.closeInterval(id, actors.member.id, clock.iso())]) t25Refused(f, work);
    }
    for (const at of [undefined, null, '', 'not-a-time']) t25Refused(f, () => groups.addMember(f.groupId, actors.nonMember.id, at), 'INVALID');
    t25Refused(f, () => groups.addMember(f.groupId, 'missing-user', clock.iso()), 'REFERENCE');
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) t25Refused(f, () => groups.openIntervalAt(f.groupId, actors.member.id, clock.iso(), seq), 'INVALID');
    assert.equal(db.inTransaction, false);
});

test('T-5B-25 contract: ordinary transactions cannot commit standalone primitives', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors, clock } = f;
    const calls = [
        () => groups.addMember(groupId, actors.nonMember.id, clock.iso()),
        () => groups.reactivateMember(groupId, actors.removedMember.id, clock.iso()),
        () => groups.endMembership(groupId, actors.member.id, clock.iso()),
        () => groups.changeRole(groupId, actors.member.id, 'member', 'admin'),
        () => groups.transferOwnership(groupId, actors.owner.id, actors.admin.id),
        () => groups.openIntervalAt(groupId, actors.member.id, clock.iso()),
        () => groups.closeInterval(groupId, actors.member.id, clock.iso()),
    ];
    const before = snapshot(db);
    for (const call of calls) db.transaction(() => {
        assert.throws(call, error => error instanceof TypeError && /withMembershipTransaction/.test(error.message));
    }).immediate();
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-25 contract: incomplete joins, rejoins and removals roll back the entire transaction', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors, clock } = f;
    for (const incomplete of [
        () => groups.addMember(groupId, actors.nonMember.id, clock.iso()),
        () => groups.reactivateMember(groupId, actors.removedMember.id, clock.iso()),
        () => groups.endMembership(groupId, actors.member.id, clock.iso()),
    ]) {
        const before = snapshot(db);
        assert.throws(() => withMembershipTransaction(db, () => {
            groups.bumpRevision(groupId);
            groups.changeRole(groupId, actors.admin.id, 'admin', 'member');
            incomplete();
            assert.equal(groups.invariantReport(groupId).mismatches, 1, 'temporary mismatch is inside the transaction only');
        }), classed('DATABASE'));
        assert.equal(db.inTransaction, false);
        assert.deepEqual(snapshot(db), before, 'the unrelated successful writes in the same transaction roll back too');
    }
});

test('T-5B-25 contract: catching a failed second write cannot commit its incomplete first write', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors, clock } = f;
    const before = snapshot(db);
    assert.throws(() => withMembershipTransaction(db, () => {
        groups.addMember(groupId, actors.nonMember.id, clock.iso());
        assert.throws(() => groups.openIntervalAt(groupId, actors.nonMember.id, clock.iso(), 99), classed('CONFLICT'));
    }), classed('DATABASE'));
    assert.deepEqual(snapshot(db), before);
    withMembershipTransaction(db, () => {
        groups.addMember(groupId, actors.nonMember.id, clock.iso());
        assert.throws(() => groups.openIntervalAt(groupId, actors.nonMember.id, clock.iso(), 99), classed('CONFLICT'));
        groups.openIntervalAt(groupId, actors.nonMember.id, clock.iso());
    });
    t25Healthy(groups, groupId);
});

test('T-5B-25 contract: mandatory validation follows all work while the transaction is still open', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors, clock } = f;
    const prepare = db.prepare;
    let workFinished = false, validations = 0;
    db.prepare = function(sql) {
        if (sql.includes('AS activeOwners')) {
            assert.equal(workFinished, true);
            assert.equal(this.inTransaction, true);
            validations += 1;
        }
        return prepare.call(this, sql);
    };
    try {
        const result = withMembershipTransaction(db, () => {
            assert.throws(() => db.prepare('BEGIN IMMEDIATE').run(), /within a transaction/);
            groups.addMember(groupId, actors.nonMember.id, clock.iso());
            groups.openIntervalAt(groupId, actors.nonMember.id, clock.iso());
            workFinished = true;
            return 'completed';
        });
        assert.equal(result, 'completed');
        assert.equal(validations, 1, 'the caller never requested validation');
        assert.equal(db.inTransaction, false);
    } finally { db.prepare = prepare; }
    t25Healthy(groups, groupId);
});

test('T-5B-25 contract: failed validation and a missing owner both fail closed and roll back', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors } = f;
    const before = snapshot(db), prepare = db.prepare;
    db.prepare = function(sql) {
        if (sql.includes('AS activeOwners')) throw new Error('synthetic validation failure');
        return prepare.call(this, sql);
    };
    try {
        assert.throws(() => withMembershipTransaction(db, () => groups.changeRole(groupId, actors.member.id, 'member', 'admin')), classed('DATABASE'));
    } finally { db.prepare = prepare; }
    assert.deepEqual(snapshot(db), before);
    assert.throws(() => withMembershipTransaction(db, () => {
        groups.changeRole(groupId, actors.member.id, 'member', 'admin');
        db.prepare("UPDATE ConversationMembers SET role='admin' WHERE conversation_id=? AND user_id=?").run(groupId, actors.owner.id);
    }), classed('DATABASE'));
    assert.deepEqual(snapshot(db), before);
    withMembershipTransaction(db, () => groups.changeRole(groupId, actors.member.id, 'member', 'admin'));
    t25Healthy(groups, groupId);
});

test('T-5B-25 contract: every touched group is validated across repository instances', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors, builder, clock } = f;
    const secondId = builder.createGroup({ ownerId:actors.owner.id, idempotencyKey:'t25-contract-second-group' });
    const secondRepository = createGroupRepository(db), before = snapshot(db);
    assert.throws(() => withMembershipTransaction(db, () => {
        groups.changeRole(groupId, actors.member.id, 'member', 'admin');
        secondRepository.addMember(secondId, actors.nonMember.id, clock.iso());
    }), classed('DATABASE'));
    assert.deepEqual(snapshot(db), before, 'a later group failure rolls back earlier groups too');
    withMembershipTransaction(db, () => {
        groups.changeRole(groupId, actors.member.id, 'member', 'admin');
        secondRepository.addMember(secondId, actors.nonMember.id, clock.iso());
        secondRepository.openIntervalAt(secondId, actors.nonMember.id, clock.iso());
    });
    t25Healthy(groups, groupId);
    t25Healthy(secondRepository, secondId);
});

test('T-5B-25 contract: partial operations are invisible to another connection until validated commit', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors, clock } = f;
    const reader = new Database(guardPath(f.filename), { readonly:true, fileMustExist:true });
    f.connections.push(reader);
    const other = createGroupRepository(reader);
    withMembershipTransaction(db, () => {
        groups.addMember(groupId, actors.nonMember.id, clock.iso());
        assert.equal(groups.invariantReport(groupId).mismatches, 1);
        assert.equal(other.getMember(groupId, actors.nonMember.id), null);
        t25Healthy(other, groupId);
        groups.openIntervalAt(groupId, actors.nonMember.id, clock.iso());
        assert.equal(other.getMember(groupId, actors.nonMember.id), null);
    });
    assert.equal(other.getMember(groupId, actors.nonMember.id).role, 'member');
    t25Healthy(other, groupId);
});

test('T-5B-25 contract: async work, thenables and ambient or nested transactions cannot bypass the boundary', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors, clock } = f, before = snapshot(db);
    let invoked = false;
    assert.throws(() => withMembershipTransaction(db, async () => { invoked = true; }), classed('INVALID'));
    assert.equal(invoked, false);
    assert.throws(() => withMembershipTransaction(db, () => {
        groups.addMember(groupId, actors.nonMember.id, clock.iso());
        return Promise.resolve('not synchronous');
    }), classed('INVALID'));
    db.transaction(() => {
        assert.throws(() => withMembershipTransaction(db, () => { invoked = true; }), TypeError);
    }).immediate();
    assert.equal(invoked, false);
    assert.throws(() => withMembershipTransaction(db, () => {
        groups.changeRole(groupId, actors.member.id, 'member', 'admin');
        withMembershipTransaction(db, () => {});
    }), TypeError);
    assert.deepEqual(snapshot(db), before);
    assert.throws(() => db.transaction(() => groups.addMember(groupId, actors.nonMember.id, clock.iso())).immediate(), TypeError,
        'a rejected callback leaves no reusable transaction capability');
});

// T-5B-26: creation uses the approved membership boundary. Metadata and key
// writes also run in caller transactions; each function retains its savepoint.
const t26Create = (f, input = {}) => withMembershipTransaction(f.db, () => f.groups.insertGroup({
    created_by:f.actors.owner.id, title:'Synthetic group', ...input,
}));
const t26Atomic = (f, work) => f.db.transaction(work).immediate();

test('T-5B-26: creation composes the conversation owner and stores each policy only in the extension', t => {
    const f = t25Fixture(t), { db, groups, actors } = f;
    for (const input of [{}, { historyPolicy:'all', description:'Bound description' }, { historyPolicy:'from_joined' }]) {
        const group = t26Create(f, { title:"Synthetic ' group", ...input });
        assert.equal(group.kind, 'group');
        assert.equal(group.origin, 'authenticated');
        assert.equal(group.created_by, actors.owner.id);
        assert.equal(group.title, "Synthetic ' group");
        assert.equal(group.description, input.description ?? null);
        assert.equal(group.history_policy, input.historyPolicy ?? 'from_joined');
        assert.equal(group.membership_revision, 1);
        const base = f.repositories.conversations.get(group.conversation_id);
        for (const column of ['description','history_policy','membership_revision']) assert.equal(Object.hasOwn(base, column), false);
        const owner = groups.getMember(group.conversation_id, actors.owner.id);
        assert.equal(owner.role, 'owner');
        assert.equal(owner.left_at, null);
        const interval = db.prepare('SELECT * FROM GroupMembershipIntervals WHERE conversation_id=?').get(group.conversation_id);
        assert.deepEqual([interval.user_id, interval.interval_no, interval.first_seq, interval.last_seq, interval.joined_at, interval.left_at],
            [actors.owner.id, 1, 1, null, owner.joined_at, null]);
        assert.equal(db.prepare('SELECT created_at FROM GroupExtensions WHERE conversation_id=?').get(group.conversation_id).created_at, group.created_at);
        t25Healthy(groups, group.conversation_id);
    }
    assert.match(readDataFile(GROUP_REPOSITORY_FILE), /repositories\.conversations\.create\(\{[^}]*kind:'group', origin:'authenticated', created_by/);
});

test('T-5B-26: invalid creation inputs create no rows and cannot choose another kind or origin', t => {
    const f = t25Fixture(t), before = snapshot(f.db);
    for (const historyPolicy of ['invalid','ALL','',null,0,{}]) {
        assert.throws(() => t26Create(f, { historyPolicy }), classed('INVALID'));
        assert.deepEqual(snapshot(f.db), before);
    }
    for (const input of [{ created_by:null }, { title:null }, { description:17 }, { description:'d'.repeat(1001) },
        { kind:'direct' }, { origin:'legacy' }, { membership_revision:2 }, { conversation_id:'' }]) {
        assert.throws(() => t26Create(f, input), classed('INVALID'));
        assert.deepEqual(snapshot(f.db), before);
    }
    assert.throws(() => t26Create(f, { created_by:'t26-missing-user' }), classed('REFERENCE'));
    assert.deepEqual(snapshot(f.db), before);
});

test('T-5B-26: a late creation failure restores all rows even when caught before other work commits', t => {
    const f = t25Fixture(t), { db, groups, groupId, actors } = f;
    db.prepare("CREATE TEMP TRIGGER t26_fail_first_interval BEFORE INSERT ON GroupMembershipIntervals WHEN NEW.conversation_id='t26-refused' BEGIN SELECT RAISE(ABORT,'synthetic first interval failure'); END").run();
    const before = snapshot(db), revision = revisionOf(db, groupId);
    withMembershipTransaction(db, () => {
        assert.throws(() => groups.insertGroup({ conversation_id:'t26-refused', created_by:actors.owner.id, title:'Refused group' }), classed('CONFLICT'));
        assert.deepEqual(snapshot(db), before);
        groups.bumpRevision(groupId);
    });
    assert.equal(revisionOf(db, groupId), revision + 1);
    assert.equal(f.repositories.conversations.get('t26-refused'), null);
    assert.equal(groups.getVisibleGroup('t26-refused'), null);
    db.prepare('DROP TRIGGER t26_fail_first_interval').run();
    assert.equal(t26Create(f, { conversation_id:'t26-refused' }).conversation_id, 't26-refused');
});

test('T-5B-26: creation cannot bypass the guarded boundary and the new group must pass final validation', t => {
    const f = t25Fixture(t), { db, groups, actors } = f, before = snapshot(db);
    assert.throws(() => t26Atomic(f, () => groups.insertGroup({ created_by:actors.owner.id, title:'Unvalidated' })), TypeError);
    assert.throws(() => withMembershipTransaction(db, () => {
        const group = groups.insertGroup({ created_by:actors.owner.id, title:'Must roll back' });
        db.prepare("UPDATE ConversationMembers SET role='admin' WHERE conversation_id=? AND user_id=?").run(group.conversation_id, actors.owner.id);
    }), classed('DATABASE'));
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-26: settings patch only the requested fields, preserve policy and bind the operation time', t => {
    const f = t25Fixture(t), { groups, db, clock } = f;
    for (const historyPolicy of ['all','from_joined']) {
        const group = t26Create(f, { historyPolicy, description:'Original description' });
        const id = group.conversation_id, before = snapshot(db);
        let result = t26Atomic(f, () => groups.updateSettings(id, { title:"New ' title", description:'New description' }, clock.iso()));
        assert.deepEqual(changedTables(before, snapshot(db)), ['Conversations','GroupExtensions']);
        assert.equal(result.title, "New ' title");
        assert.equal(result.description, 'New description');
        assert.equal(result.updated_at, clock.iso());
        assert.equal(result.membership_revision, 1);
        clock.advance();
        result = t26Atomic(f, () => groups.updateSettings(id, { description:null }, clock.iso()));
        assert.equal(result.title, "New ' title");
        assert.equal(result.description, null);
        result = t26Atomic(f, () => groups.updateSettings(id, { title:'Title only' }, clock.iso()));
        assert.equal(result.description, null);
        assert.equal(result.history_policy, historyPolicy);
        assert.equal(result.created_at, group.created_at);
        t25Healthy(groups, id);
    }
});

test('T-5B-26: forbidden settings fields and a failed extension update cannot leave a title change', t => {
    const f = t25Fixture(t), { groups, db, groupId, clock } = f, before = snapshot(db);
    const original = groups.getVisibleGroup(groupId);
    for (const patch of [{ historyPolicy:'from_joined' }, { historyPolicy:'all' }, { history_policy:'all' }, { historyPolicy:null },
        { membership_revision:9 }, {}, null, [], { title:null }, { description:0 }]) {
        assert.throws(() => t26Atomic(f, () => groups.updateSettings(groupId, patch, clock.iso())), classed('INVALID'));
        assert.deepEqual(snapshot(db), before);
    }
    t26Atomic(f, () => {
        assert.throws(() => groups.updateSettings(groupId, { title:'Rolled back', description:'d'.repeat(1001) }, clock.iso()), classed('INVALID'));
        assert.deepEqual(snapshot(db), before, 'the title/time change is restored by the function savepoint');
        groups.bumpRevision(groupId);
    });
    assert.deepEqual(groups.getVisibleGroup(groupId), { ...original, membership_revision:original.membership_revision + 1 });
});

test('T-5B-26: archive is a one-time CAS and retains all group data', t => {
    const f = t25Fixture(t), { groups, db, groupId, clock } = f, before = snapshot(db);
    const archived = t26Atomic(f, () => groups.archiveGroup(groupId, clock.iso()));
    assert.equal(archived.archived_at, clock.iso());
    assert.equal(archived.updated_at, clock.iso());
    assert.deepEqual(changedTables(before, snapshot(db)), ['Conversations']);
    const after = snapshot(db);
    clock.advance();
    assert.throws(() => t26Atomic(f, () => groups.archiveGroup(groupId, clock.iso())), classed('CONFLICT'));
    assert.throws(() => t26Atomic(f, () => groups.updateSettings(groupId, { title:'Refused' }, clock.iso())), classed('CONFLICT'));
    assert.deepEqual(snapshot(db), after);
    assert.equal(groups.getVisibleGroup(groupId).archived_at, archived.archived_at);
    t25Healthy(groups, groupId);
});

test('T-5B-26: touching a conversation changes only updated_at and does not increment its revision', t => {
    const f = t25Fixture(t), { groups, db, groupId, clock } = f;
    const original = f.repositories.conversations.get(groupId), before = snapshot(db), revision = revisionOf(db, groupId);
    const result = t26Atomic(f, () => groups.touchConversation(groupId, clock.iso()));
    assert.deepEqual(result, { ...original, updated_at:clock.iso() });
    assert.deepEqual(changedTables(before, snapshot(db)), ['Conversations']);
    assert.equal(revisionOf(db, groupId), revision);
    assert.deepEqual(t26Atomic(f, () => groups.touchConversation(groupId, clock.iso())), result, 'the same operation time is valid');
    for (const at of [null, '', 'invalid']) {
        const unchanged = snapshot(db);
        assert.throws(() => t26Atomic(f, () => groups.touchConversation(groupId, at)), classed('INVALID'));
        assert.deepEqual(snapshot(db), unchanged);
    }
});

test('T-5B-26: creation keys are per-user and cannot be replaced within or exactly at 24 hours', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f, fingerprint = 'a'.repeat(64), at = clock.iso();
    const original = t26Atomic(f, () => groups.claimCreationKey(actors.owner.id, 't26-key', fingerprint, groupId, at));
    assert.deepEqual(original, { user_id:actors.owner.id, idempotency_key:'t26-key', fingerprint, conversation_id:groupId, created_at:at });
    t26Atomic(f, () => groups.claimCreationKey(actors.admin.id, 't26-key', fingerprint, groupId, at));
    const before = snapshot(db);
    for (const elapsed of [-1, 0, 24 * 60 * 60 * 1000 - 1, 24 * 60 * 60 * 1000]) {
        for (const nextFingerprint of [fingerprint, 'b'.repeat(64)]) {
            const now = new Date(Date.parse(at) + elapsed).toISOString();
            assert.throws(() => t26Atomic(f, () => groups.claimCreationKey(actors.owner.id, 't26-key', nextFingerprint, groupId, now)), classed('DUPLICATE'));
            assert.deepEqual(snapshot(db), before);
        }
    }
    assert.deepEqual(groups.getCreationKey(actors.owner.id, 't26-key'), original);
});

test('T-5B-26: a key older than 24 hours is explicitly renewed without deleting either group or other keys', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors } = f;
    const second = t26Create(f), oldAt = '2030-01-01T01:00:00.000+01:00', newAt = '2030-01-02T00:00:00.001Z';
    for (const [user, key] of [[actors.owner.id,'t26-expired'], [actors.admin.id,'t26-expired'], [actors.owner.id,'t26-other']]) {
        t26Atomic(f, () => groups.claimCreationKey(user, key, 'a'.repeat(64), groupId, oldAt));
    }
    const before = snapshot(db);
    const renewed = t26Atomic(f, () => groups.claimCreationKey(actors.owner.id, 't26-expired', 'b'.repeat(64), second.conversation_id, newAt));
    assert.deepEqual(renewed, { user_id:actors.owner.id, idempotency_key:'t26-expired', fingerprint:'b'.repeat(64), conversation_id:second.conversation_id, created_at:newAt });
    assert.deepEqual(changedTables(before, snapshot(db)), ['GroupCreationKeys']);
    for (const [user, key] of [[actors.admin.id,'t26-expired'], [actors.owner.id,'t26-other']]) {
        assert.equal(groups.getCreationKey(user, key).created_at, oldAt);
        assert.equal(groups.getCreationKey(user, key).conversation_id, groupId);
    }
    t25Healthy(groups, groupId); t25Healthy(groups, second.conversation_id);
});

test('T-5B-26: a failed renewal insert restores the expired key even when the caller catches and commits', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors } = f;
    const original = t26Atomic(f, () => groups.claimCreationKey(actors.owner.id, 't26-renew-fails', 'a'.repeat(64), groupId, '2030-01-01T00:00:00.000Z'));
    db.prepare("CREATE TEMP TRIGGER t26_fail_key BEFORE INSERT ON GroupCreationKeys WHEN NEW.idempotency_key='t26-renew-fails' AND substr(NEW.fingerprint,1,1)='b' BEGIN SELECT RAISE(ABORT,'synthetic renewal insert failure'); END").run();
    const before = snapshot(db), revision = revisionOf(db, groupId);
    t26Atomic(f, () => {
        assert.throws(() => groups.claimCreationKey(actors.owner.id, 't26-renew-fails', 'b'.repeat(64), groupId, '2030-01-02T00:00:00.001Z'), classed('CONFLICT'));
        assert.deepEqual(snapshot(db), before);
        groups.bumpRevision(groupId);
    });
    assert.deepEqual(groups.getCreationKey(actors.owner.id, 't26-renew-fails'), original);
    assert.equal(revisionOf(db, groupId), revision + 1);
});

test('T-5B-26: invalid key input and references cannot modify an existing key', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f, fingerprint = 'a'.repeat(64);
    t26Atomic(f, () => groups.claimCreationKey(actors.owner.id, 'key', fingerprint, groupId, clock.iso()));
    const before = snapshot(db);
    const invalid = [
        ['', 'key', fingerprint, groupId, clock.iso()], [actors.owner.id, '', fingerprint, groupId, clock.iso()],
        [actors.owner.id, 'x'.repeat(257), fingerprint, groupId, clock.iso()],
        [actors.owner.id, 'key', 'A'.repeat(64), groupId, clock.iso()], [actors.owner.id, 'key', 'a'.repeat(63), groupId, clock.iso()],
        [actors.owner.id, 'key', null, groupId, clock.iso()], [actors.owner.id, 'key', fingerprint, groupId, 'invalid'],
    ];
    for (const args of invalid) {
        assert.throws(() => t26Atomic(f, () => groups.claimCreationKey(...args)), classed('INVALID'));
        assert.deepEqual(snapshot(db), before);
    }
    assert.throws(() => t26Atomic(f, () => groups.claimCreationKey('t26-no-user', 'key', fingerprint, groupId, clock.iso())), classed('REFERENCE'));
    assert.deepEqual(snapshot(db), before);
    assert.equal(t26Atomic(f, () => groups.claimCreationKey(actors.owner.id, 'x'.repeat(256), fingerprint, groupId, clock.iso())).idempotency_key.length, 256);
});

test('T-5B-26: every group-level write rolls back with the complete coordinated operation', t => {
    const f = t25Fixture(t), { groups, db, actors, clock } = f, before = snapshot(db);
    assert.throws(() => withMembershipTransaction(db, () => {
        const group = groups.insertGroup({ conversation_id:'t26-rollback', created_by:actors.owner.id, title:'Rollback group' });
        const id = group.conversation_id;
        groups.updateSettings(id, { title:'Rollback settings', description:'Synthetic description' }, clock.iso());
        groups.touchConversation(id, clock.iso());
        assert.equal(groups.bumpRevision(id), 2);
        groups.claimCreationKey(actors.owner.id, 't26-rollback', 'c'.repeat(64), id, clock.iso());
        groups.archiveGroup(id, clock.iso());
        throw new Error('synthetic group-level rollback');
    }), /synthetic group-level rollback/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(groups.getVisibleGroup('t26-rollback'), null);
    assert.equal(groups.getCreationKey(actors.owner.id, 't26-rollback'), null);
});

test('T-5B-26: metadata and creation-key writes refuse non-visible group namespaces', t => {
    const f = t25Fixture(t), { groups, db, actors, clock } = f;
    const direct = f.repositories.conversations.createAuthenticatedDirect(actors.admin.id, actors.member.id);
    const bare = f.repositories.conversations.create({ kind:'group', origin:'authenticated', title:'Bare', created_by:actors.owner.id });
    const legacy = f.repositories.conversations.create({ kind:'group', origin:'legacy', title:'Legacy', created_by:actors.owner.id });
    db.prepare('INSERT INTO GroupExtensions(conversation_id) VALUES(?)').run(legacy.conversation_id);
    const before = snapshot(db);
    for (const id of ['t26-unknown', direct.conversation_id, bare.conversation_id, legacy.conversation_id]) {
        for (const work of [() => groups.updateSettings(id, { title:'Refused' }, clock.iso()),
            () => groups.archiveGroup(id, clock.iso()), () => groups.touchConversation(id, clock.iso()),
            () => groups.claimCreationKey(actors.owner.id, 't26-hidden', 'a'.repeat(64), id, clock.iso())]) {
            assert.throws(() => t26Atomic(f, work), classed('CONFLICT'));
            assert.deepEqual(snapshot(db), before);
        }
    }
});

test('T-5B-26: no prepared statement updates history_policy', () => {
    const sql = [...readDataFile(GROUP_REPOSITORY_FILE).matchAll(/\bdb\.prepare\(\s*(['"`])([\s\S]*?)\1\s*\)/g)].map(match => match[2]);
    assert.ok(sql.length > 0);
    assert.ok(sql.some(text => /\bINSERT\s+INTO\s+GroupExtensions\b[\s\S]*\bhistory_policy\b/i.test(text)), 'the scan includes the creation statement');
    for (const text of sql) assert.doesNotMatch(text, /\bUPDATE\b[\s\S]*\bhistory_policy\b/i);
});

// T-5B-27 repository primitives: service authorization and configured maxima
// remain outside this task. Every row and connection below is synthetic.
const t27Invite = (f, invitationId, input = {}) => t26Atomic(f, () => f.groups.insertInvitation({
    invitation_id:invitationId, conversation_id:f.groupId, inviter_id:f.actors.owner.id,
    invitee_id:f.actors.nonMember.id, created_at:f.clock.iso(), ...input,
}));
const t27After = (at, elapsed) => new Date(Date.parse(at) + elapsed).toISOString();

test('T-5B-27: lookups retain expired pending rows while counts and lists exclude expiry inclusively', t => {
    const f = t25Fixture(t), { groups, db, groupId, invitationId, actors } = f, before = snapshot(db);
    const invitation = groups.getInvitation(invitationId);
    assert.deepEqual(groups.findPending(groupId, actors.pendingInvitee.id), invitation);
    assert.equal(groups.getInvitation('t27-missing'), null);
    assert.equal(groups.findPending(groupId, actors.nonMember.id), null);
    for (const [now, expected] of [[t27After(invitation.expires_at, -1), 1], [invitation.expires_at, 0], [t27After(invitation.expires_at, 1), 0]]) {
        assert.equal(groups.countPendingForGroup(groupId, now), expected);
        assert.equal(groups.countPendingForInvitee(actors.pendingInvitee.id, now), expected);
        assert.equal(groups.listPendingForGroup(groupId, now).length, expected);
        assert.equal(groups.listPendingForInvitee(actors.pendingInvitee.id, now).length, expected);
    }
    const equivalentExpiry = t27After(invitation.expires_at, 3600000).replace('Z', '+01:00');
    assert.equal(groups.countPendingForInvitee(actors.pendingInvitee.id, equivalentExpiry), 0);
    assert.equal(groups.findPending(groupId, actors.pendingInvitee.id).state, 'pending');
    assert.deepEqual(snapshot(db), before, 'expiry reads never mutate a pending row');
});

test('T-5B-27: insertion binds identity and the fixed seven-day expiry without changing membership', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f, before = snapshot(db);
    const row = t27Invite(f, "t27-bound-'id");
    assert.deepEqual(row, { invitation_id:"t27-bound-'id", conversation_id:groupId, invitee_id:actors.nonMember.id,
        inviter_id:actors.owner.id, state:'pending', created_at:clock.iso(), expires_at:clock.iso(INVITATION_EXPIRY_MS), resolved_at:null });
    assert.deepEqual(groups.getInvitation(row.invitation_id), row);
    assert.deepEqual(changedTables(before, snapshot(db)), ['ConversationInvitations']);
    assert.equal(groups.getMember(groupId, actors.nonMember.id), null);
    assert.equal(groups.listGroupsForUser(actors.nonMember.id).length, 0, 'an invitation grants no group membership');
    const explicit = t27Invite(f, 't27-explicit-expiry', { invitee_id:actors.removedMember.id, expires_at:clock.iso(INVITATION_EXPIRY_MS) });
    assert.equal(explicit.expires_at, row.expires_at);
    t25Healthy(groups, groupId);
});

test('T-5B-27: AF-05 duplicate pending invitations remain DUPLICATE, including a past-expiry pending row', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, invitationId } = f, before = snapshot(db);
    for (const inviter of [actors.owner.id, actors.admin.id]) {
        assert.throws(() => t27Invite(f, 't27-duplicate', { inviter_id:inviter, invitee_id:actors.pendingInvitee.id }), classed('DUPLICATE'));
    }
    const expires = groups.getInvitation(invitationId).expires_at;
    assert.throws(() => t27Invite(f, 't27-expired-duplicate', { invitee_id:actors.pendingInvitee.id, created_at:expires }), classed('DUPLICATE'));
    assert.throws(() => t27Invite(f, invitationId), classed('DUPLICATE'), 'a primary-key collision cannot replace the original row');
    assert.deepEqual(snapshot(db), before);
    assert.equal(groups.findPending(groupId, actors.pendingInvitee.id).invitation_id, invitationId);
});

test('T-5B-27: lazy expiry at the exact boundary permits a new pending row and retains immutable history', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, invitationId } = f;
    const original = groups.getInvitation(invitationId), now = original.expires_at;
    assert.equal(t26Atomic(f, () => groups.expirePast(groupId, actors.pendingInvitee.id, t27After(now, -1))), 0);
    assert.equal(t26Atomic(f, () => groups.expirePast(groupId, actors.nonMember.id, now)), 0);
    t26Atomic(f, () => {
        assert.equal(groups.expirePast(groupId, actors.pendingInvitee.id, now), 1);
        groups.insertInvitation({ invitation_id:'t27-renewed', conversation_id:groupId, inviter_id:actors.admin.id,
            invitee_id:actors.pendingInvitee.id, created_at:now });
    });
    assert.deepEqual(groups.getInvitation(invitationId), { ...original, state:'expired', resolved_at:now });
    assert.equal(groups.findPending(groupId, actors.pendingInvitee.id).invitation_id, 't27-renewed');
    assert.equal(groups.countPendingForGroup(groupId, now), 1);
    const before = snapshot(db);
    assert.equal(t26Atomic(f, () => groups.expirePast(groupId, actors.pendingInvitee.id, now)), 0);
    assert.throws(() => t26Atomic(f, () => groups.resolveInvitation(invitationId, 'accepted', now)), classed('CONFLICT'));
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-27: every terminal transition is pending-only and terminal rows never change afterward', t => {
    for (const state of ['accepted','declined','cancelled','expired']) {
        const f = t25Fixture(t), { groups, db, invitationId, clock } = f;
        const original = groups.getInvitation(invitationId), before = snapshot(db);
        assert.deepEqual(t26Atomic(f, () => groups.resolveInvitation(invitationId, state, clock.iso())), { ...original, state, resolved_at:clock.iso() });
        assert.deepEqual(changedTables(before, snapshot(db)), ['ConversationInvitations']);
        const after = snapshot(db);
        for (const next of ['accepted','declined','cancelled','expired']) {
            assert.throws(() => t26Atomic(f, () => groups.resolveInvitation(invitationId, next, clock.iso(1))), classed('CONFLICT'));
            assert.deepEqual(snapshot(db), after);
        }
        assert.equal(groups.findPending(f.groupId, f.actors.pendingInvitee.id), null);
        assert.equal(groups.countPendingForGroup(f.groupId, clock.iso()), 0);
    }
});

test('T-5B-27: cancellation covers incoming and outgoing pending rows only in the requested group', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock, invitationId } = f;
    const incoming = t27Invite(f, 't27-incoming', { invitee_id:actors.admin.id });
    const outgoing = t27Invite(f, 't27-outgoing', { inviter_id:actors.admin.id });
    const past = t27Invite(f, 't27-past-outgoing', { inviter_id:actors.admin.id, invitee_id:actors.removedMember.id,
        created_at:clock.iso(-2 * INVITATION_EXPIRY_MS) });
    const terminal = t27Invite(f, 't27-terminal', { inviter_id:actors.admin.id, invitee_id:actors.member.id });
    t26Atomic(f, () => groups.resolveInvitation(terminal.invitation_id, 'declined', clock.iso()));
    const other = t26Create(f), otherRow = t27Invite(f, 't27-other-group', { conversation_id:other.conversation_id, invitee_id:actors.admin.id });
    const unchanged = [groups.getInvitation(invitationId), groups.getInvitation(terminal.invitation_id), otherRow], before = snapshot(db);
    assert.equal(t26Atomic(f, () => groups.cancelPendingFor(groupId, actors.admin.id, clock.iso())), 3);
    assert.deepEqual(changedTables(before, snapshot(db)), ['ConversationInvitations']);
    for (const row of [incoming, outgoing, past]) assert.deepEqual(groups.getInvitation(row.invitation_id), { ...row, state:'cancelled', resolved_at:clock.iso() });
    for (const row of unchanged) assert.deepEqual(groups.getInvitation(row.invitation_id), row);
    const after = snapshot(db);
    assert.equal(t26Atomic(f, () => groups.cancelPendingFor(groupId, actors.admin.id, clock.iso(1))), 0);
    assert.deepEqual(snapshot(db), after);
});

test('T-5B-27: a mid-batch cancellation failure restores earlier rows even when caught and other work commits', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f;
    t27Invite(f, 't27-a-first', { invitee_id:actors.admin.id });
    t27Invite(f, 't27-z-fail', { inviter_id:actors.admin.id });
    db.prepare("CREATE TEMP TRIGGER t27_fail_cancel BEFORE UPDATE ON ConversationInvitations WHEN OLD.invitation_id='t27-z-fail' BEGIN SELECT RAISE(ABORT,'synthetic batch failure'); END").run();
    const before = snapshot(db), revision = revisionOf(db, groupId);
    t26Atomic(f, () => {
        assert.throws(() => groups.cancelPendingFor(groupId, actors.admin.id, clock.iso()), classed('CONFLICT'));
        assert.deepEqual(snapshot(db), before);
        groups.bumpRevision(groupId);
    });
    assert.equal(revisionOf(db, groupId), revision + 1);
    assert.equal(groups.getInvitation('t27-a-first').state, 'pending');
    assert.equal(groups.getInvitation('t27-z-fail').state, 'pending');
});

test('T-5B-27: expiry, replacement, acceptance and paired membership writes commit or roll back together', t => {
    for (const rollback of [true, false]) {
        const f = t25Fixture(t), { groups, db, groupId, actors, invitationId } = f, before = snapshot(db);
        const at = groups.getInvitation(invitationId).expires_at, revision = revisionOf(db, groupId);
        const work = () => withMembershipTransaction(db, () => {
            assert.equal(groups.expirePast(groupId, actors.pendingInvitee.id, at), 1);
            groups.insertInvitation({ invitation_id:'t27-atomic', conversation_id:groupId, invitee_id:actors.pendingInvitee.id,
                inviter_id:actors.owner.id, created_at:at });
            groups.resolveInvitation('t27-atomic', 'accepted', at);
            groups.addMember(groupId, actors.pendingInvitee.id, at);
            groups.openIntervalAt(groupId, actors.pendingInvitee.id, at);
            groups.bumpRevision(groupId);
            if (rollback) throw new Error('synthetic invitation operation rollback');
        });
        if (rollback) {
            assert.throws(work, /synthetic invitation operation rollback/);
            assert.deepEqual(snapshot(db), before);
        } else {
            work();
            assert.equal(groups.getInvitation('t27-atomic').state, 'accepted');
            assert.equal(groups.getInvitation(invitationId).state, 'expired');
            assert.equal(groups.getMember(groupId, actors.pendingInvitee.id).role, 'member');
            assert.equal(revisionOf(db, groupId), revision + 1);
        }
        t25Healthy(groups, groupId);
    }
});

test('T-5B-27: pending listings paginate by descending creation/id and own listings expose only their projection', t => {
    const f = t25Fixture(t), { groups, groupId, actors, clock, invitationId } = f;
    const groupRows = [groups.getInvitation(invitationId)], ownRows = [groups.getInvitation(invitationId)];
    for (const [index, actor] of [actors.nonMember,actors.removedMember,actors.admin,actors.member].entries()) {
        groupRows.push(t27Invite(f, `t27-group-${index}`, { invitee_id:actor.id, created_at:clock.iso(index % 2 ? -1000 : 0) }));
    }
    for (let index = 0; index < 3; index += 1) {
        const group = t26Create(f);
        ownRows.push(t27Invite(f, `t27-own-${index}`, { conversation_id:group.conversation_id,
            invitee_id:actors.pendingInvitee.id, created_at:clock.iso(index % 2 ? -1000 : 0) }));
    }
    const expiredGroup = t26Create(f);
    t27Invite(f, 't27-own-expired', { conversation_id:expiredGroup.conversation_id, invitee_id:actors.pendingInvitee.id,
        created_at:clock.iso(-2 * INVITATION_EXPIRY_MS) });
    const terminalGroup = t26Create(f);
    t27Invite(f, 't27-own-terminal', { conversation_id:terminalGroup.conversation_id, invitee_id:actors.pendingInvitee.id });
    t26Atomic(f, () => groups.resolveInvitation('t27-own-terminal', 'cancelled', clock.iso()));
    const sortedIds = rows => [...rows].sort((a, b) => a.created_at === b.created_at
        ? (a.invitation_id < b.invitation_id ? 1 : -1) : (a.created_at < b.created_at ? 1 : -1)).map(row => row.invitation_id);
    const walk = read => {
        const collected = []; let after = null;
        for (let page = 0; page < 10; page += 1) {
            const rows = read({ limit:2, after });
            assert.ok(rows.length <= 3, 'one lookahead row at most');
            collected.push(...rows.slice(0, 2));
            if (rows.length <= 2) return collected;
            const last = [rows[1].created_at, rows[1].invitation_id];
            after = page % 2 ? { last } : last;
        }
        return assert.fail('bounded traversal must finish');
    };
    assert.deepEqual(walk(options => groups.listPendingForGroup(groupId, clock.iso(), options)).map(row => row.invitation_id), sortedIds(groupRows));
    const own = walk(options => groups.listPendingForInvitee(actors.pendingInvitee.id, clock.iso(), options));
    assert.deepEqual(own.map(row => row.invitation_id), sortedIds(ownRows));
    assert.equal(groups.countPendingForInvitee(actors.pendingInvitee.id, clock.iso()), ownRows.length);
    for (const row of own) {
        assert.equal(row.invitee_id, actors.pendingInvitee.id);
        assert.equal(row.group_name, groups.getVisibleGroup(row.conversation_id).title);
        assert.equal(row.inviter_display_name, 'Group Owner');
        assert.deepEqual(Object.keys(row).sort(), [...Object.keys(groups.getInvitation(row.invitation_id)), 'group_name','inviter_display_name'].sort());
    }
    assert.deepEqual(groups.listPendingForInvitee(actors.nonMember.id, clock.iso()).map(row => row.invitation_id), ['t27-group-0']);
});

test('T-5B-27: closedIntervalSince is inclusive and retains removal evidence after rejoining', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f;
    const closed = db.prepare('SELECT left_at FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=? AND left_at IS NOT NULL').get(groupId, actors.removedMember.id).left_at;
    assert.equal(groups.closedIntervalSince(groupId, actors.removedMember.id, closed), true);
    assert.equal(groups.closedIntervalSince(groupId, actors.removedMember.id, t27After(closed, -1)), true);
    assert.equal(groups.closedIntervalSince(groupId, actors.removedMember.id, t27After(closed, 1)), false);
    assert.equal(groups.closedIntervalSince(groupId, actors.member.id, closed), false);
    assert.equal(groups.closedIntervalSince(groupId, actors.nonMember.id, closed), false);
    clock.advance();
    withMembershipTransaction(db, () => {
        groups.reactivateMember(groupId, actors.removedMember.id, clock.iso());
        groups.openIntervalAt(groupId, actors.removedMember.id, clock.iso());
    });
    assert.equal(groups.closedIntervalSince(groupId, actors.removedMember.id, closed), true);
    t25Healthy(groups, groupId);
});

test('T-5B-27: hidden group namespaces are excluded from invitation reads, counts and writes', t => {
    const f = t25Fixture(t), { groups, db, actors, clock } = f;
    const hidden = [];
    for (const origin of ['legacy','authenticated']) {
        const group = f.repositories.conversations.create({ kind:'group', origin, title:'Synthetic hidden group', created_by:actors.owner.id });
        if (origin === 'legacy') db.prepare('INSERT INTO GroupExtensions(conversation_id) VALUES(?)').run(group.conversation_id);
        const invitation = 't27-hidden-' + origin;
        db.prepare('INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,created_at,expires_at) VALUES(?,?,?,?,?,?)')
            .run(invitation, group.conversation_id, actors.pendingInvitee.id, actors.owner.id, clock.iso(), clock.iso(INVITATION_EXPIRY_MS));
        hidden.push([group.conversation_id, invitation]);
    }
    const direct = f.repositories.conversations.createAuthenticatedDirect(actors.admin.id, actors.member.id);
    hidden.push([direct.conversation_id, 't27-missing-direct'], ['t27-unknown', 't27-missing']);
    const before = snapshot(db);
    for (const [id, invitation] of hidden) {
        assert.equal(groups.getInvitation(invitation), null);
        assert.equal(groups.findPending(id, actors.pendingInvitee.id), null);
        assert.equal(groups.countPendingForGroup(id, clock.iso()), 0);
        assert.deepEqual(groups.listPendingForGroup(id, clock.iso()), []);
        assert.equal(groups.closedIntervalSince(id, actors.pendingInvitee.id, clock.iso()), false);
        for (const work of [() => groups.insertInvitation({ invitation_id:'t27-refused-hidden', conversation_id:id,
            invitee_id:actors.nonMember.id, inviter_id:actors.owner.id, created_at:clock.iso() }),
            () => groups.resolveInvitation(invitation, 'cancelled', clock.iso()),
            () => groups.cancelPendingFor(id, actors.owner.id, clock.iso()),
            () => groups.expirePast(id, actors.pendingInvitee.id, clock.iso())]) {
            assert.throws(() => t26Atomic(f, work), classed('CONFLICT'));
        }
    }
    assert.equal(groups.countPendingForInvitee(actors.pendingInvitee.id, clock.iso()), 1);
    assert.equal(groups.listPendingForInvitee(actors.pendingInvitee.id, clock.iso()).length, 1);
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-27: invalid invitation input and foreign references fail without changing rows', t => {
    const f = t25Fixture(t), { db, actors, clock } = f, before = snapshot(db);
    for (const input of [{ invitation_id:' ' }, { state:'accepted' }, { resolved_at:clock.iso() }, { created_at:'invalid' },
        { expires_at:'invalid' }, { expires_at:clock.iso() }, { expires_at:clock.iso(INVITATION_EXPIRY_MS + 1) },
        { invitee_id:actors.owner.id }, { invitee_id:null }]) {
        assert.throws(() => t27Invite(f, 't27-invalid', input), classed('INVALID'));
        assert.deepEqual(snapshot(db), before);
    }
    for (const input of [{ invitee_id:'t27-missing-user' }, { inviter_id:actors.nonMember.id, invitee_id:actors.removedMember.id }]) {
        assert.throws(() => t27Invite(f, 't27-bad-reference', input), classed('REFERENCE'));
        assert.deepEqual(snapshot(db), before);
    }
});

test('T-5B-27: guards and malformed read or transition arguments preserve all rows', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock, invitationId } = f, before = snapshot(db);
    for (const name of ['getInvitation','findPending','countPendingForGroup','countPendingForInvitee','listPendingForInvitee','listPendingForGroup','closedIntervalSince']) {
        assert.equal(groups[name].kind, 'read');
    }
    for (const state of ['pending','invalid',null]) assert.throws(() => t26Atomic(f, () => groups.resolveInvitation(invitationId, state, clock.iso())), classed('INVALID'));
    for (const read of [() => groups.getInvitation(''), () => groups.findPending(groupId, null),
        () => groups.countPendingForGroup(groupId, 'invalid'), () => groups.countPendingForInvitee(actors.pendingInvitee.id, null),
        () => groups.listPendingForInvitee(actors.pendingInvitee.id, clock.iso(), { limit:0 }),
        () => groups.listPendingForGroup(groupId, clock.iso(), { after:[] }),
        () => groups.closedIntervalSince(groupId, actors.removedMember.id, 'invalid')]) assert.throws(read, classed('INVALID'));
    for (const write of [() => groups.resolveInvitation(invitationId, 'cancelled', 'invalid'),
        () => groups.cancelPendingFor(groupId, actors.owner.id, 'invalid'),
        () => groups.expirePast(groupId, actors.pendingInvitee.id, 'invalid')]) assert.throws(() => t26Atomic(f, write), classed('INVALID'));
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-27: failed membership validation also rolls back invitation cancellations', t => {
    const f = t25Fixture(t), { groups, db, groupId, actors, clock } = f;
    t27Invite(f, 't27-cancel-on-removal', { inviter_id:actors.admin.id });
    const before = snapshot(db);
    assert.throws(() => withMembershipTransaction(db, () => {
        assert.equal(groups.cancelPendingFor(groupId, actors.admin.id, clock.iso()), 1);
        groups.endMembership(groupId, actors.admin.id, clock.iso());
        // Deliberately omit the paired close: the existing boundary must abort.
    }), classed('DATABASE'));
    assert.deepEqual(snapshot(db), before);
    t25Healthy(groups, groupId);
});

test('T-5B-27: invitation transitions remain invisible on a second connection until commit', t => {
    const f = t25Fixture(t), { groups, db, invitationId, clock } = f;
    const reader = new Database(guardPath(f.filename), { readonly:true, fileMustExist:true });
    f.connections.push(reader);
    const other = createGroupRepository(reader);
    t26Atomic(f, () => {
        groups.resolveInvitation(invitationId, 'declined', clock.iso());
        assert.equal(groups.getInvitation(invitationId).state, 'declined');
        assert.equal(other.getInvitation(invitationId).state, 'pending');
    });
    assert.equal(other.getInvitation(invitationId).state, 'declined');
});

// T-5B-28: fixed synthetic histories exercise range boundaries without the
// generated property suite belonging to Task 1.29.
function t28Send(f, sender, count) {
    for (let index = 0; index < count; index += 1) {
        const seq = f.repositories.messages.highWater(f.groupId) + 1;
        f.repositories.messages.insertAuthenticated({ message_id:`t28-${f.groupId}-${seq}`, conversation_id:f.groupId, sender_id:sender,
            receiver_id:null, ciphertext:'opaque ciphertext', iv:'opaque-iv', envelope_version:1, encoding:'base64', sender_name:'Synthetic sender',
            client_timestamp:f.clock.iso(), message_type:'text', fingerprint:'a'.repeat(64), client_id:`t28-client-${seq}`, message_seq:seq, created_at:f.clock.iso() });
    }
}
function t28Fixture(t, policy = 'from_joined') {
    const base = t25Fixture(t), group = t26Create(base, { historyPolicy:policy });
    const f = { ...base, groupId:group.conversation_id, user:base.actors.nonMember.id, policy };
    t28Send(f, f.actors.owner.id, 4);
    withMembershipTransaction(f.db, () => {
        f.groups.addMember(f.groupId, f.user, f.clock.iso());
        f.groups.openIntervalAt(f.groupId, f.user, f.clock.iso());
    });
    t28Send(f, f.actors.owner.id, 3);
    f.clock.advance();
    withMembershipTransaction(f.db, () => {
        f.groups.endMembership(f.groupId, f.user, f.clock.iso());
        f.groups.closeInterval(f.groupId, f.user, f.clock.iso());
    });
    t28Send(f, f.actors.owner.id, 6);
    f.clock.advance();
    withMembershipTransaction(f.db, () => {
        f.groups.reactivateMember(f.groupId, f.user, f.clock.iso());
        f.groups.openIntervalAt(f.groupId, f.user, f.clock.iso());
    });
    t28Send(f, f.actors.owner.id, 3);
    return f;
}
const t28Page = (f, options = {}) => f.groups.historyPage(f.groupId, f.user, { policy:f.policy, highWater:16, ...options });
const t28Seq = rows => rows.map(row => row.message_seq);
const t28Message = (f, seq) => `t28-${f.groupId}-${seq}`;

test('T-5B-28: interval reads retain ordered closed intervals and identify only the current open interval', t => {
    const f = t28Fixture(t), { groups, db, groupId, user } = f, before = snapshot(db);
    const intervals = groups.intervalsFor(groupId, user);
    assert.deepEqual(intervals.map(row => [row.interval_no,row.first_seq,row.last_seq]), [[1,5,7],[2,14,null]]);
    assert.deepEqual(groups.openInterval(groupId, user), intervals[1]);
    assert.equal(groups.openInterval(groupId, f.actors.pendingInvitee.id), null);
    assert.deepEqual(groups.intervalsFor(groupId, f.actors.pendingInvitee.id), []);
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-28: history and single-message reads preserve both policies and always exclude absence gaps', t => {
    for (const policy of ['from_joined','all']) {
        const f = t28Fixture(t, policy), before = snapshot(f.db);
        const expected = policy === 'all' ? [16,15,14,7,6,5,4,3,2,1] : [16,15,14,7,6,5];
        assert.deepEqual(t28Seq(t28Page(f, { limit:50 })), expected);
        assert.equal(f.groups.unreadCount(f.groupId, f.user, policy), expected.length);
        assert.equal(f.groups.listGroupsForUser(f.user).find(row => row.conversation_id === f.groupId).unread_count, expected.length);
        for (let seq = 1; seq <= 16; seq += 1) {
            const row = f.groups.getPermittedMessage(f.groupId, f.user, policy, t28Message(f, seq));
            assert.equal(row?.message_seq ?? null, expected.includes(seq) ? seq : null, `sequence ${seq} under ${policy}`);
        }
        assert.equal(f.groups.getPermittedMessage(f.groupId, f.user, policy, 't28-unknown'), null);
        assert.deepEqual(snapshot(f.db), before);
    }
});

test('T-5B-28: range filtering precedes LIMIT and pagination keeps the original high-water across a new send', t => {
    for (const policy of ['from_joined','all']) {
        const f = t28Fixture(t, policy), actual = [];
        let before = null;
        for (let page = 0; page < 10; page += 1) {
            const rows = t28Page(f, { limit:2, before });
            assert.ok(rows.length <= 3);
            if (page === 0) {
                assert.deepEqual(t28Seq(rows), [16,15,14]);
                t28Send(f, f.actors.owner.id, 1);
            }
            const items = rows.slice(0,2);
            actual.push(...t28Seq(items));
            if (rows.length <= 2) break;
            assert.equal(items.length, 2);
            before = items.at(-1).message_seq;
        }
        assert.deepEqual(actual, policy === 'all' ? [16,15,14,7,6,5,4,3,2,1] : [16,15,14,7,6,5]);
        assert.equal(f.groups.getPermittedMessage(f.groupId, f.user, policy, t28Message(f,17)).message_seq, 17);
    }
});

test('T-5B-28: default/max page sizes and exclusive before bounds follow existing lookahead conventions', t => {
    const f = t25Fixture(t), { groups, groupId, actors } = f;
    t28Send(f, actors.owner.id, 65);
    const read = options => groups.historyPage(groupId, actors.owner.id, { policy:'from_joined', highWater:65, ...options });
    assert.equal(read({}).length, 21);
    assert.equal(read({ limit:50 }).length, 51);
    assert.deepEqual(t28Seq(read({ limit:50, before:13 })), [12,11,10,9,8,7,6,5,4,3,2,1]);
    assert.deepEqual(read({ highWater:0 }), []);
    assert.deepEqual(read({ before:1 }), []);
});

test('T-5B-28: empty membership intervals return an empty page and all adds only the pre-first-join prefix', t => {
    for (const policy of ['from_joined','all']) {
        const base = t25Fixture(t), group = t26Create(base, { historyPolicy:policy });
        const f = { ...base, groupId:group.conversation_id, user:base.actors.nonMember.id, policy };
        t28Send(f, f.actors.owner.id, 4);
        withMembershipTransaction(f.db, () => {
            f.groups.addMember(f.groupId, f.user, f.clock.iso());
            f.groups.openIntervalAt(f.groupId, f.user, f.clock.iso());
            f.groups.endMembership(f.groupId, f.user, f.clock.iso());
            f.groups.closeInterval(f.groupId, f.user, f.clock.iso());
        });
        t28Send(f, f.actors.owner.id, 3);
        withMembershipTransaction(f.db, () => {
            f.groups.reactivateMember(f.groupId, f.user, f.clock.iso());
            f.groups.openIntervalAt(f.groupId, f.user, f.clock.iso());
        });
        assert.deepEqual(t28Seq(t28Page(f, { highWater:7 })), policy === 'all' ? [4,3,2,1] : []);
        assert.equal(Object.hasOwn(t28Page(f, { highWater:7 }), 'nextCursor'), false, 'raw empty results carry no cursor');
        t25Healthy(f.groups, f.groupId);
    }
});

test('T-5B-28: history retains permitted tombstones but unread excludes tombstones, own sends and legacy rows', t => {
    const f = t28Fixture(t), { groups, groupId, user, actors, clock } = f;
    assert.equal(groups.unreadCount(groupId, user, f.policy), 6);
    f.repositories.messages.tombstone(t28Message(f,6), clock.iso());
    t28Send(f, user, 1);
    f.repositories.messages.insert({ message_id:'t28-legacy', conversation_id:groupId, sender_id:actors.owner.id, ciphertext:'opaque legacy', iv:'iv' });
    assert.deepEqual(t28Seq(t28Page(f, { highWater:17 })), [17,16,15,14,7,6,5]);
    assert.equal(groups.getPermittedMessage(groupId, user, f.policy, t28Message(f,6)).deleted_at, clock.iso());
    assert.equal(groups.getPermittedMessage(groupId, user, f.policy, 't28-legacy'), null);
    assert.equal(groups.unreadCount(groupId, user, f.policy), 5);
    assert.equal(groups.listGroupsForUser(user).find(row => row.conversation_id === groupId).unread_count, 5);
});

test('T-5B-28: removal hides history and read position; a rejoin restores only retained permitted intervals', t => {
    const f = t28Fixture(t), { groups, db, groupId, user, clock } = f;
    t26Atomic(f, () => groups.upsertReadPosition(groupId, user, 7, clock.iso()));
    withMembershipTransaction(db, () => {
        groups.endMembership(groupId, user, clock.iso()); groups.closeInterval(groupId, user, clock.iso());
    });
    const removed = snapshot(db);
    assert.deepEqual(t28Page(f), []);
    assert.equal(groups.getPermittedMessage(groupId, user, f.policy, t28Message(f,5)), null);
    assert.equal(groups.unreadCount(groupId, user, f.policy), 0);
    assert.equal(groups.getReadPosition(groupId, user), 0);
    assert.equal(groups.openInterval(groupId, user), null);
    assert.equal(groups.intervalsFor(groupId, user).length, 2, 'internal interval metadata remains retained');
    assert.throws(() => t26Atomic(f, () => groups.upsertReadPosition(groupId, user, 0, clock.iso())), classed('CONFLICT'));
    assert.deepEqual(snapshot(db), removed);
    t28Send(f, f.actors.owner.id, 2);
    withMembershipTransaction(db, () => {
        groups.reactivateMember(groupId, user, clock.iso()); groups.openIntervalAt(groupId, user, clock.iso());
    });
    assert.deepEqual(t28Seq(t28Page(f, { highWater:18 })), [16,15,14,7,6,5]);
    assert.equal(groups.getReadPosition(groupId, user), 7);
    assert.equal(groups.unreadCount(groupId, user, f.policy), 3);
});

test('T-5B-28: a caller policy cannot override the immutable stored policy', t => {
    for (const policy of ['from_joined','all']) {
        const f = t28Fixture(t, policy), override = policy === 'all' ? 'from_joined' : 'all', before = snapshot(f.db);
        assert.deepEqual(t28Page(f, { policy:override }), []);
        assert.equal(f.groups.getPermittedMessage(f.groupId, f.user, override, t28Message(f,1)), null);
        assert.equal(f.groups.unreadCount(f.groupId, f.user, override), 0);
        assert.deepEqual(snapshot(f.db), before);
    }
});

test('T-5B-28: read positions increase by maximum and equal/lower reports preserve the complete stored row', t => {
    const f = t28Fixture(t), { groups, db, groupId, user, clock } = f;
    assert.equal(groups.getReadPosition(groupId, user), 0);
    for (const n of [0,5,7]) {
        assert.equal(t26Atomic(f, () => groups.upsertReadPosition(groupId, user, n, clock.iso())), n);
        assert.equal(groups.getReadPosition(groupId, user), n);
        assert.equal(db.prepare('SELECT updated_at FROM GroupReadPositions WHERE conversation_id=? AND user_id=?').get(groupId,user).updated_at, clock.iso());
        clock.advance();
    }
    const before = snapshot(db);
    for (const n of [7,6,0]) assert.equal(t26Atomic(f, () => groups.upsertReadPosition(groupId, user, n, clock.iso())), 7);
    assert.deepEqual(snapshot(db), before);
    assert.equal(groups.unreadCount(groupId, user, f.policy), 3);
    assert.equal(t26Atomic(f, () => groups.upsertReadPosition(groupId, f.actors.owner.id, 2, clock.iso())), 2);
    assert.equal(groups.getReadPosition(groupId, user), 7, 'another member has an independent position');
    assert.equal(t26Atomic(f, () => groups.upsertReadPosition(groupId, user, 16, clock.iso())), 16);
    assert.equal(groups.unreadCount(groupId, user, f.policy), 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM GroupReadPositions WHERE conversation_id=? AND user_id=?').get(groupId,user).n, 1);
});

test('T-5B-28: position validation rejects gaps, pre-join history and values beyond high-water even for a lower report', t => {
    const f = t28Fixture(t), { groups, db, groupId, user, clock } = f;
    t26Atomic(f, () => groups.upsertReadPosition(groupId, user, 16, clock.iso()));
    const before = snapshot(db);
    for (const n of [-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1,'5',null,1,4,8,13,17]) {
        assert.throws(() => t26Atomic(f, () => groups.upsertReadPosition(groupId, user, n, clock.iso())), classed('INVALID'));
        assert.deepEqual(snapshot(db), before);
    }
    const all = t28Fixture(t, 'all');
    assert.equal(t26Atomic(all, () => all.groups.upsertReadPosition(all.groupId, all.user, 4, all.clock.iso())), 4);
    assert.throws(() => t26Atomic(all, () => all.groups.upsertReadPosition(all.groupId, all.user, 8, all.clock.iso())), classed('INVALID'));
    const empty = t25Fixture(t);
    assert.equal(t26Atomic(empty, () => empty.groups.upsertReadPosition(empty.groupId, empty.actors.owner.id, 0, empty.clock.iso())), 0);
    assert.throws(() => t26Atomic(empty, () => empty.groups.upsertReadPosition(empty.groupId, empty.actors.owner.id, 1, empty.clock.iso())), classed('INVALID'));
});

test('T-5B-28: history selects ranges and the page in one query using the authenticated history index', t => {
    const f = t28Fixture(t), { db } = f, prepare = db.prepare, captured = [];
    db.prepare = function(sql) {
        captured.push(sql);
        return prepare.call(this, sql);
    };
    try { assert.deepEqual(t28Seq(t28Page(f, { limit:2 })), [16,15,14]); }
    finally { db.prepare = prepare; }
    assert.equal(captured.length, 1, 'no separate interval query or application-side page filtering');
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + captured[0]).all({ id:f.groupId, user:f.user, policy:f.policy, highWater:16, before:null, take:3 })
        .map(row => row.detail).join('\n');
    assert.match(plan, /idx_messages_authenticated_history/);
    assert.doesNotMatch(plan, /\bSCAN\s+(?:msg|Messages)\b/i);
    t.diagnostic(plan);
});

test('T-5B-28: history and read state fail closed for hidden namespaces, other groups and non-members', t => {
    const f = t28Fixture(t), { groups, db, actors, clock } = f;
    const direct = f.repositories.conversations.createAuthenticatedDirect(actors.admin.id, actors.member.id);
    const bare = f.repositories.conversations.create({ kind:'group', origin:'authenticated', title:'Bare', created_by:actors.owner.id });
    const legacy = f.repositories.conversations.create({ kind:'group', origin:'legacy', title:'Legacy', created_by:actors.owner.id });
    db.prepare('INSERT INTO GroupExtensions(conversation_id) VALUES(?)').run(legacy.conversation_id);
    const otherGroup = t26Create(f), other = { ...f, groupId:otherGroup.conversation_id };
    t28Send(other, actors.owner.id, 1);
    const before = snapshot(db);
    for (const id of ['t28-unknown', direct.conversation_id, bare.conversation_id, legacy.conversation_id]) {
        assert.deepEqual(groups.historyPage(id, actors.owner.id, { policy:f.policy, highWater:16 }), []);
        assert.equal(groups.getPermittedMessage(id, actors.owner.id, f.policy, t28Message(f,5)), null);
        assert.equal(groups.unreadCount(id, actors.owner.id, f.policy), 0);
        assert.deepEqual(groups.intervalsFor(id, actors.owner.id), []);
        assert.equal(groups.openInterval(id, actors.owner.id), null);
        assert.equal(groups.getReadPosition(id, actors.owner.id), 0);
        assert.throws(() => t26Atomic(f, () => groups.upsertReadPosition(id, actors.owner.id, 0, clock.iso())), classed('CONFLICT'));
    }
    assert.deepEqual(groups.historyPage(f.groupId, actors.pendingInvitee.id, { policy:f.policy, highWater:16 }), []);
    assert.equal(groups.getPermittedMessage(f.groupId, actors.pendingInvitee.id, f.policy, t28Message(f,5)), null);
    assert.equal(groups.unreadCount(f.groupId, actors.pendingInvitee.id, f.policy), 0);
    assert.equal(groups.getReadPosition(f.groupId, actors.pendingInvitee.id), 0);
    assert.throws(() => t26Atomic(f, () => groups.upsertReadPosition(f.groupId, actors.pendingInvitee.id, 0, clock.iso())), classed('CONFLICT'));
    assert.equal(groups.getPermittedMessage(f.groupId, f.user, f.policy, t28Message(other,1)), null);
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-28: malformed history options and write arguments retain repository guards and do not change data', t => {
    const f = t28Fixture(t), { groups, db, groupId, user, clock } = f, before = snapshot(db);
    for (const name of ['intervalsFor','openInterval','historyPage','getPermittedMessage','unreadCount','getReadPosition']) assert.equal(groups[name].kind, 'read');
    assert.equal(groups.upsertReadPosition.kind, 'write');
    assert.throws(() => groups.upsertReadPosition(groupId,user,0,clock.iso()), TypeError);
    for (const options of [{ policy:'invalid' }, { limit:0 }, { limit:51 }, { limit:1.5 }, { highWater:-1 },
        { highWater:undefined }, { highWater:Number.MAX_SAFE_INTEGER+1 }, { before:0 }, { before:'5' }, { unknown:true }]) {
        assert.throws(() => t28Page(f, options), classed('INVALID'));
    }
    assert.throws(() => groups.getPermittedMessage(groupId,user,'invalid',t28Message(f,5)), classed('INVALID'));
    assert.throws(() => groups.unreadCount(groupId,user,null), classed('INVALID'));
    assert.throws(() => groups.getReadPosition(groupId,''), classed('INVALID'));
    assert.throws(() => groups.intervalsFor(groupId,null), classed('INVALID'));
    assert.throws(() => t26Atomic(f, () => groups.upsertReadPosition(groupId,user,0,'invalid')), classed('INVALID'));
    assert.deepEqual(snapshot(db), before);
});

test('T-5B-28: failed position writes and failed coordinated operations restore all earlier state', t => {
    const f = t28Fixture(t), { groups, db, groupId, user, clock } = f;
    t26Atomic(f, () => groups.upsertReadPosition(groupId,user,5,clock.iso()));
    db.prepare('CREATE TEMP TRIGGER t28_fail_read BEFORE UPDATE ON GroupReadPositions WHEN NEW.position=16 BEGIN SELECT RAISE(ABORT,\'synthetic read failure\'); END').run();
    const before = snapshot(db), revision = revisionOf(db,groupId);
    t26Atomic(f, () => {
        assert.throws(() => groups.upsertReadPosition(groupId,user,16,clock.iso()), classed('CONFLICT'));
        assert.deepEqual(snapshot(db), before);
        groups.bumpRevision(groupId);
    });
    assert.equal(revisionOf(db,groupId), revision+1);
    db.prepare('DROP TRIGGER t28_fail_read').run();
    const after = snapshot(db);
    assert.throws(() => t26Atomic(f, () => { groups.upsertReadPosition(groupId,user,16,clock.iso()); throw new Error('synthetic read rollback'); }), /synthetic read rollback/);
    assert.deepEqual(snapshot(db), after);
    assert.throws(() => withMembershipTransaction(db, () => {
        groups.upsertReadPosition(groupId,user,16,clock.iso()); groups.endMembership(groupId,user,clock.iso());
    }), classed('DATABASE'));
    assert.deepEqual(snapshot(db), after);
});

test('T-5B-28: concurrent connections serialize reports and a later lower report cannot overwrite the maximum', t => {
    const f = t28Fixture(t), { groups, db, groupId, user, clock } = f;
    const otherDb = openDatabase({ filename:guardPath(f.filename), migrate:false, timeout:0 });
    f.connections.push(otherDb);
    const other = createGroupRepository(otherDb);
    t26Atomic(f, () => {
        assert.equal(groups.upsertReadPosition(groupId,user,14,clock.iso()), 14);
        assert.equal(other.getReadPosition(groupId,user), 0);
        assert.throws(() => otherDb.transaction(() => other.upsertReadPosition(groupId,user,7,clock.iso())).immediate(), error => error.code === 'SQLITE_BUSY');
    });
    const before = snapshot(db);
    assert.equal(otherDb.transaction(() => other.upsertReadPosition(groupId,user,7,clock.iso(1))).immediate(), 14);
    assert.deepEqual(snapshot(db), before);
    assert.equal(groups.getReadPosition(groupId,user), 14);
});
