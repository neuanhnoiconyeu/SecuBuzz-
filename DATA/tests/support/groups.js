// T-5B-21 (DB5-R15.1, DB5-R15.2, DB5-R11.6, DB5-R14.17, NFR-07, NFR-08): shared helpers of the group test files.
//
// snapshot(db)          SHA-256 of each table of the P-21 list that exists at the current version (rows in primary-key
//                       order, columns sorted, one JSON line per row, each value tagged with its SQLite type) and a total.
//                       AuthRateLimits is left out. Every call first runs the completeness check: a table that a migration
//                       after 0007 created (0008, 0009, ...) and that SNAPSHOT_TABLES lacks fails the call.
// guardPath(candidate)  Refuses a path whose real path is not strictly inside os.tmpdir(), a path under
//                       /var/lib/secubuzz/ (the volumes of a Docker_Environment project) and any file named like the
//                       canonical DATA/server/database/database.sqlite or its -wal, -shm and -journal companions. This
//                       file is the guard helper: the static check of groups-repository.test.js lets no other new file
//                       under tests/ contain that literal, apart from the git exclusion list of support/record-baseline.js.
//                       Every directory and database made here passes the guard.
// createGroupBuilder,   One group that holds every actor class (unauthenticated, non-member, pending invitee, member,
// groupFixture,         admin, owner, removed member), on a repository-level database (groupFixture) or behind the
// httpGroupFixture      loopback createApp of support/auth.js with a logged-in session per user (httpGroupFixture).
// assertSecurityHeaders The headers createApp sets on every response (NFR-08).
//
// TEMPORARY until T-5B-22: the Group_Repository does not exist yet. The builder writes Conversations and
// ConversationMembers through repositories.conversations.create and repositories.members.*, and writes the 0008 rows
// (GroupExtensions, GroupMembershipIntervals, ConversationInvitations, GroupReadPositions, GroupCreationKeys) with
// parameter-bound INSERT and UPDATE statements that exist in this helper and nowhere else. T-5B-22 and later tasks switch
// these writes to createGroupRepository(db) (insertGroup, addMember, openIntervalAt, closeInterval, bumpRevision,
// changeRole, endMembership, cancelPendingFor, insertInvitation, upsertReadPosition, claimCreationKey).
//
// Determinism (NFR-07): no Math.random and no wall clock in the helper. createClock is a fixed clock that the test
// advances; group creation, initial membership and intervals use that same timestamp. No network beyond loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { openDatabase } = require('../../server/database/connection');
const { createRepositories } = require('../../server/database/repositories');
const { loadMigrations } = require('../../server/database/migrate');
const { setup } = require('./contract');

// ---------------------------------------------------------------------------------------------------------------
// Snapshot (P-21; design, Testing Strategy section 3).
// ---------------------------------------------------------------------------------------------------------------
// The twelve tables of P-21, in the order of the design. AttachmentReservations is created by 0009 (DB-6B).
const SNAPSHOT_TABLES = Object.freeze(['Conversations', 'ConversationMembers', 'GroupExtensions', 'GroupMembershipIntervals',
    'ConversationInvitations', 'GroupReadPositions', 'GroupCreationKeys', 'Messages', 'MessageReceipts', 'Attachments',
    'AttachmentReservations', 'AuditLogs']);
// Limiter counters may change on a refused request (P-21), so they are never hashed.
const SNAPSHOT_EXCLUDED = Object.freeze(['AuthRateLimits']);
const LAST_PUBLISHED_VERSION = 7;
const RUNNER_TABLES = Object.freeze(['SchemaMigrations']); // created by the migration runner, not by a migration file

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const quoteName = name => `"${String(name).replace(/"/g, '""')}"`;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const tableNameQueries = new WeakMap();
const digestQueries = new WeakMap();
function tableNames(db) {
    let query = tableNameQueries.get(db);
    if (!query) {
        query = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        tableNameQueries.set(db, query);
    }
    return query.all().map(row => row.name);
}

let publishedTables = null;
// The tables of version 7: 0001 to 0007 run in order, as the runner runs them, on an in-memory database. The published
// files are immutable (baseline-checksums.test.js), so the list is computed once per process.
function tablesAtVersion7() {
    if (!publishedTables) {
        const published = loadMigrations().filter(migration => migration.version <= LAST_PUBLISHED_VERSION);
        if (published.length !== LAST_PUBLISHED_VERSION) throw new Error('migrations 0001 to 0007 are needed to derive the version-7 tables');
        const reference = new Database(':memory:');
        try {
            reference.pragma('foreign_keys = ON');
            reference.transaction(() => { for (const migration of published) reference.exec(migration.sql); })();
            publishedTables = Object.freeze(tableNames(reference));
        } finally {
            reference.close();
        }
    }
    return publishedTables;
}

// created: the tables of db that did not exist at version 7; missing: those of them that SNAPSHOT_TABLES lacks.
function missingSnapshotTables(names) {
    const known = new Set([...tablesAtVersion7(), ...RUNNER_TABLES]);
    const created = names.filter(name => !known.has(name));
    return { created, missing: created.filter(name => !SNAPSHOT_TABLES.includes(name)) };
}
function snapshotCompleteness(db) {
    return missingSnapshotTables(tableNames(db));
}
function assertSnapshotNamesComplete(names) {
    const { missing } = missingSnapshotTables(names);
    if (missing.length) {
        throw new assert.AssertionError({ actual: missing, expected: [], operator: 'snapshotComplete',
            message: `the snapshot list lacks ${missing.join(', ')}, created by a migration after 0007; add it to SNAPSHOT_TABLES in tests/support/groups.js (design P-21)` });
    }
}
function assertSnapshotComplete(db) {
    assertSnapshotNamesComplete(tableNames(db));
}

// typeof() keeps 1, 1.0, '1' and x'01' apart; integers are read as BigInt, so no value loses precision.
const encodeValue = value => (typeof value === 'bigint' ? value.toString() : Buffer.isBuffer(value) ? value.toString('hex') : value);
function tableDigest(db, table, queries) {
    let query = queries.get(table);
    if (!query) {
        const columns = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table);
        if (!columns.length) throw new Error(`table ${table} has no columns`);
        const names = columns.map(column => column.name).sort(byCodeUnit);
        const key = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => quoteName(column.name));
        const select = names.map(name => `typeof(${quoteName(name)}), ${quoteName(name)}`).join(', ');
        query = {names, statement:db.prepare(`SELECT ${select} FROM ${quoteName(table)} ORDER BY ${key.length ? key.join(', ') : 'rowid'}`)
            .raw(true).safeIntegers(true)};
        queries.set(table, query);
    }
    const hash = createHash('sha256');
    for (const row of query.statement.iterate()) {
        const record = {};
        query.names.forEach((name, index) => { record[name] = [row[2 * index], encodeValue(row[2 * index + 1])]; });
        hash.update(`${JSON.stringify(record)}\n`);
    }
    return hash.digest('hex');
}
// One read transaction, so every hash sees the same database state.
function snapshot(db) {
    return db.transaction(() => {
        const names = tableNames(db);
        assertSnapshotNamesComplete(names);
        const schemaVersion = db.pragma('schema_version', {simple:true});
        let cache = digestQueries.get(db);
        if (!cache || cache.schemaVersion !== schemaVersion) {
            cache = {schemaVersion, queries:new Map()};
            digestQueries.set(db, cache);
        }
        const present = new Set(names);
        const tables = {};
        for (const table of SNAPSHOT_TABLES) if (present.has(table)) tables[table] = tableDigest(db, table, cache.queries);
        return Object.freeze({ tables:Object.freeze(tables), total:sha256(JSON.stringify(Object.entries(tables))) });
    })();
}
// The tables whose hash differs, in SNAPSHOT_TABLES order, so a failure names the table.
function changedTables(before, after) {
    return SNAPSHOT_TABLES.filter(table => (table in before.tables || table in after.tables) && before.tables[table] !== after.tables[table]);
}

// ---------------------------------------------------------------------------------------------------------------
// Path guard and temporary databases (design, Testing Strategy section 10).
// ---------------------------------------------------------------------------------------------------------------
const DOCKER_VOLUME_ROOT = '/var/lib/secubuzz';
const DATABASE_FILE = /^database\.sqlite(?:-wal|-shm|-journal)?$/i;
const TEMPORARY_PREFIX = 'secubuzz-db5-';

class UnsafePathError extends Error {
    constructor(reason, candidate) {
        super(`refused test path (${reason}): ${candidate}`);
        this.name = 'UnsafePathError';
        this.code = 'UNSAFE_TEST_PATH';
        this.reason = reason;
    }
}
const refuse = (reason, candidate) => { throw new UnsafePathError(reason, candidate); };
// The volume root is a POSIX path; on Windows the drive letter is dropped and the comparison ignores case.
function underDockerVolumes(absolute) {
    const posix = absolute.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    const folded = process.platform === 'win32' ? posix.toLowerCase() : posix;
    return folded === DOCKER_VOLUME_ROOT || folded.startsWith(`${DOCKER_VOLUME_ROOT}/`);
}
function strictlyInside(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
// The real path of the nearest existing ancestor (links resolved) joined with the segments that do not exist yet.
function realPathOf(absolute) {
    const pending = [];
    let current = absolute;
    for (;;) {
        try { fs.lstatSync(current); break; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
        const parent = path.dirname(current);
        if (parent === current) break;
        pending.unshift(path.basename(current));
        current = parent;
    }
    return path.join(fs.realpathSync.native(current), ...pending);
}
function checkResolved(resolved, temporaryRoot, candidate) {
    if (DATABASE_FILE.test(path.basename(resolved))) refuse('database-file', candidate);
    if (underDockerVolumes(resolved)) refuse('docker-volume', candidate);
    if (!strictlyInside(temporaryRoot, resolved)) refuse('outside-temporary', candidate);
}
// Returns the real path of an accepted candidate. The lexical checks run first, so a refused path outside the
// temporary directory is never touched on disk.
function guardPath(candidate) {
    if (typeof candidate !== 'string' || !candidate.length || candidate.includes('\0')) throw new TypeError('guardPath needs a non-empty path string');
    const lexical = path.resolve(candidate);
    const temporaryRoot = path.resolve(os.tmpdir());
    checkResolved(lexical, temporaryRoot, candidate);
    let real;
    let realRoot;
    try {
        real = realPathOf(lexical);
        realRoot = realPathOf(temporaryRoot);
    } catch {
        refuse('unresolved', candidate);
    }
    checkResolved(real, realRoot, candidate);
    return real;
}

// A new guarded directory under os.tmpdir(); its files are removed one by one in t.after, as temporary() does.
function temporaryDirectory(t, beforeCleanup = () => {}) {
    const directory = guardPath(fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX)));
    t.after(() => {
        beforeCleanup();
        // Unlink only the entries of this directory (a link is removed, never followed); no recursive removal.
        for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
        fs.rmdirSync(directory);
    });
    return directory;
}
// A database file in a new guarded directory, migrated to the latest version unless migrate is false.
function groupDatabase(t, { migrate = true } = {}) {
    const connections = [];
    const directory = temporaryDirectory(t, () => {
        for (const connection of [...connections].reverse()) if (connection.open) connection.close();
    });
    const filename = guardPath(path.join(directory, 'groups.sqlite'));
    const db = openDatabase({ filename, migrate });
    connections.push(db);
    return { db, filename, directory, connections, repositories:createRepositories(db) };
}

// ---------------------------------------------------------------------------------------------------------------
// Clock, limiter and the group builder.
// ---------------------------------------------------------------------------------------------------------------
const CLOCK_START = '2026-01-01T00:00:00.000Z';
const INVITATION_EXPIRY_MS = 604800 * 1000; // OD-08: the fixed Invitation expiry of 7 days

function createClock(start = CLOCK_START) {
    let ms = Date.parse(start);
    if (!Number.isSafeInteger(ms)) throw new TypeError('createClock needs an ISO 8601 time');
    return Object.freeze({
        now:() => ms,
        iso:(offsetMs = 0) => new Date(ms + offsetMs).toISOString(),
        advance(stepMs = 1000) {
            if (!Number.isSafeInteger(stepMs) || stepMs < 0) throw new TypeError('advance needs a non-negative integer of milliseconds');
            ms += stepMs;
            return ms;
        },
    });
}
// Allows every bucket, so fixture set-up never meets a per-source limit. A test that checks limits injects its own.
const openLimiter = () => Object.freeze({ consume:() => ({ allowed:true }) });

const later = (a, b) => (a > b ? a : b); // ISO 8601 UTC strings of one format sort by time

function createGroupBuilder({ db, repositories = createRepositories(db), clock = createClock() }) {
    const write = work => db.transaction(work).immediate();
    const exactlyOne = (result, step) => {
        if (result.changes !== 1) throw new Error(`group fixture step "${step}" changed ${result.changes} rows`);
    };
    const highWater = groupId => repositories.messages.highWater(groupId);
    const bumpRevision = groupId => exactlyOne(db.prepare(
        'UPDATE GroupExtensions SET membership_revision = membership_revision + 1 WHERE conversation_id = ?').run(groupId), 'revision');
    // First interval of a member: first_seq is the high-water plus 1, joined_at equals the member row.
    function openFirstInterval(groupId, userId) {
        const member = repositories.members.get(groupId, userId);
        db.prepare(`INSERT INTO GroupMembershipIntervals(conversation_id, user_id, interval_no, first_seq, last_seq, joined_at, left_at)
            VALUES(?, ?, 1, ?, NULL, ?, NULL)`).run(groupId, userId, highWater(groupId) + 1, member.joined_at);
    }
    return Object.freeze({
        clock,
        // Owner row through conversations.create, extension record at revision 1, the owner's first interval and,
        // unless idempotencyKey is null, the creation key. Returns the group id.
        createGroup({ ownerId, conversationId, title = 'Fixture group', description = null, historyPolicy = 'from_joined',
            idempotencyKey = 'fixture-group-create' } = {}) {
            return write(() => {
                const group = repositories.conversations.create({ conversation_id:conversationId, kind:'group', title,
                    created_by:ownerId, origin:'authenticated',created_at:clock.iso(),updated_at:clock.iso(),member_joined_at:clock.iso() });
                const groupId = group.conversation_id;
                db.prepare(`INSERT INTO GroupExtensions(conversation_id, description, history_policy, membership_revision, created_at)
                    VALUES(?, ?, ?, 1, ?)`).run(groupId, description, historyPolicy, group.created_at);
                openFirstInterval(groupId, ownerId);
                if (idempotencyKey !== null) {
                    db.prepare(`INSERT INTO GroupCreationKeys(user_id, idempotency_key, fingerprint, conversation_id, created_at)
                        VALUES(?, ?, ?, ?, ?)`).run(ownerId, idempotencyKey, sha256(JSON.stringify([title.trim(), description, historyPolicy])),
                        groupId, clock.iso());
                }
                return groupId;
            });
        },
        // A direct add as member (+1 revision), then a role change to admin when asked (+1 revision).
        addMember(groupId, userId, { role = 'member' } = {}) {
            write(() => {
                repositories.members.insert({ conversation_id:groupId, user_id:userId, role:'member',joined_at:clock.iso() });
                openFirstInterval(groupId, userId);
                bumpRevision(groupId);
                if (role !== 'member') {
                    exactlyOne(repositories.members.setRole(groupId, userId, role), 'role');
                    bumpRevision(groupId);
                }
            });
        },
        // Removal of an active admin or member: left_at set, interval closed at the high-water, pending Invitations
        // addressed to or issued by the user cancelled, +1 revision.
        removeMember(groupId, userId) {
            write(() => {
                const member = repositories.members.get(groupId, userId);
                if (!member || member.left_at !== null || member.role === 'owner') throw new Error('the group fixture removes only an active admin or member');
                const at = later(clock.iso(), member.joined_at);
                exactlyOne(repositories.members.leave(groupId, userId, at), 'leave');
                exactlyOne(db.prepare(`UPDATE GroupMembershipIntervals SET last_seq = ?, left_at = ?
                    WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`).run(highWater(groupId), at, groupId, userId), 'interval');
                db.prepare(`UPDATE ConversationInvitations SET state = 'cancelled', resolved_at = ?
                    WHERE conversation_id = ? AND state = 'pending' AND (invitee_id = ? OR inviter_id = ?)`).run(at, groupId, userId, userId);
                bumpRevision(groupId);
            });
        },
        // A pending Invitation created now that expires after 7 days. Returns the invitation id.
        invite(groupId, inviterId, inviteeId) {
            return write(() => {
                const number = db.prepare('SELECT count(*) + 1 AS n FROM ConversationInvitations').get().n;
                const invitationId = `fixture-invitation-${number}`;
                db.prepare(`INSERT INTO ConversationInvitations(invitation_id, conversation_id, invitee_id, inviter_id, state, created_at, expires_at, resolved_at)
                    VALUES(?, ?, ?, ?, 'pending', ?, ?, NULL)`).run(invitationId, groupId, inviteeId, inviterId, clock.iso(), clock.iso(INVITATION_EXPIRY_MS));
                return invitationId;
            });
        },
        // Read_Position upsert that never lowers the stored value.
        setReadPosition(groupId, userId, position) {
            write(() => {
                db.prepare(`INSERT INTO GroupReadPositions(conversation_id, user_id, position, updated_at) VALUES(?, ?, ?, ?)
                    ON CONFLICT(conversation_id, user_id) DO UPDATE SET position = max(position, excluded.position), updated_at = excluded.updated_at`)
                    .run(groupId, userId, position, clock.iso());
            });
        },
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Actor classes (design, Testing Strategy section 3; DB5-R15.2).
// ---------------------------------------------------------------------------------------------------------------
const ACTOR_CLASSES = Object.freeze(['unauthenticated', 'nonMember', 'pendingInvitee', 'member', 'admin', 'owner', 'removedMember']);
const USER_CLASSES = Object.freeze(ACTOR_CLASSES.filter(actorClass => actorClass !== 'unauthenticated'));
const USERNAMES = Object.freeze({ nonMember:'grp-outsider', pendingInvitee:'grp-invitee', member:'grp-member', admin:'grp-admin',
    owner:'grp-owner', removedMember:'grp-removed' });
const DISPLAY_NAMES = Object.freeze({ nonMember:'Group Outsider', pendingInvitee:'Group Invitee', member:'Group Member',
    admin:'Group Admin', owner:'Group Owner', removedMember:'Group Removed' });

// The owner creates the group, adds the admin, the member and the removed member, removes the last one and invites the
// pending invitee. The non-member has no row in the group.
function buildActorGroup(builder, actors, group) {
    const groupId = builder.createGroup({ ...group, ownerId:actors.owner.id });
    builder.addMember(groupId, actors.admin.id, { role:'admin' });
    builder.addMember(groupId, actors.member.id);
    builder.addMember(groupId, actors.removedMember.id);
    builder.removeMember(groupId, actors.removedMember.id);
    const invitationId = builder.invite(groupId, actors.owner.id, actors.pendingInvitee.id);
    return { groupId, invitationId };
}
// Repository level: users through repositories.users.create; the unauthenticated class has no user.
function groupFixture(t, { clock = createClock(), group = {} } = {}) {
    const f = groupDatabase(t);
    const actors = { unauthenticated:Object.freeze({ actorClass:'unauthenticated', id:null, username:null }) };
    for (const actorClass of USER_CLASSES) {
        const user = f.repositories.users.create({ user_id:USERNAMES[actorClass], username:USERNAMES[actorClass], display_name:DISPLAY_NAMES[actorClass] });
        actors[actorClass] = Object.freeze({ actorClass, id:user.user_id, username:user.username });
    }
    const builder = createGroupBuilder({ db:f.db, repositories:f.repositories, clock });
    return { ...f, clock, builder, ...buildActorGroup(builder, actors, group), actors:Object.freeze(actors) };
}
// HTTP level: the createApp of support/auth.js on loopback with the injected clock and limiter. Every user class is
// registered and logged in, so it holds a session cookie and a session CSRF token; the unauthenticated class is a
// browser without cookies.
async function httpGroupFixture(t, { clock = createClock(), limiter = openLimiter(), group = {}, ...options } = {}) {
    const f = await setup(t, { now:clock.now, limiter, ...options });
    guardPath(f.directory);
    guardPath(f.filename);
    const actors = { unauthenticated:Object.freeze({ actorClass:'unauthenticated', id:null, username:null, browser:f.browser(), token:null }) };
    for (const actorClass of USER_CLASSES) {
        const browser = f.browser();
        const username = USERNAMES[actorClass];
        assert.equal((await browser.register(username, { displayName:DISPLAY_NAMES[actorClass] })).status, 201, `register ${actorClass}`);
        const login = await browser.login(username);
        assert.equal(login.status, 200, `login ${actorClass}`);
        actors[actorClass] = Object.freeze({ actorClass, id:login.body.user.id, username, browser, token:await browser.csrf() });
    }
    const repositories = createRepositories(f.db);
    const builder = createGroupBuilder({ db:f.db, repositories, clock });
    return { ...f, clock, limiter, repositories, builder, ...buildActorGroup(builder, actors, group), actors:Object.freeze(actors) };
}

// A request as one actor; a state-changing method carries the actor's CSRF token unless csrf is false.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function actorRequest(actor, method, url, { body, rawBody, headers = {}, csrf = true } = {}) {
    const proof = csrf && actor.token && !SAFE_METHODS.has(method) ? { 'X-CSRF-Token':actor.token } : {};
    return actor.browser.request(url, { method, body, rawBody, headers:{ ...proof, ...headers } }).then(response => {
        require('./contract').assertGroupResponse(method,url,response);
        return response;
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Response headers (NFR-08): the values createApp sets for every response, and no X-Powered-By.
// ---------------------------------------------------------------------------------------------------------------
const SECURITY_HEADERS = Object.freeze({
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; frame-ancestors 'none'",
    'referrer-policy':'no-referrer',
});
function assertSecurityHeaders(response, label = 'response') {
    const headers = response && response.headers;
    if (!headers || typeof headers.get !== 'function') throw new TypeError('assertSecurityHeaders needs a response with fetch headers');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers.get(name), value, `${label}: ${name}`);
    assert.equal(headers.get('x-powered-by'), null, `${label}: x-powered-by is not sent`);
}

module.exports = {
    SNAPSHOT_TABLES, SNAPSHOT_EXCLUDED, snapshot, changedTables, snapshotCompleteness, assertSnapshotComplete,
    UnsafePathError, guardPath, temporaryDirectory, groupDatabase,
    CLOCK_START, INVITATION_EXPIRY_MS, createClock, openLimiter, createGroupBuilder,
    ACTOR_CLASSES, groupFixture, httpGroupFixture, actorRequest,
    SECURITY_HEADERS, assertSecurityHeaders,
};
