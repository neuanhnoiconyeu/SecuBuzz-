// T-5B-35 (DB5-R14.7, DB5-R14.13, DB5-R14.20, DB5-R14.21, DB5-R14.23, DB5-R14.24; design "Migration plan" items 2 and
// 3 and the Docker section): the synthetic version-7 data set that T-5B-36 rehearses migration 0008 on. No real
// database, Docker volume or backup is read or copied: every row is made up in this file, and the output is a new file
// in a new folder under os.tmpdir() that is never committed (it has a database extension, see G7).
//
// buildVersionSeven(filename, { seed = DEFAULT_SEED })
//   Refuses, with the UnsafePathError of support/groups.js, a target that guardPath refuses (real path not strictly
//   inside os.tmpdir(), the canonical DATA database file name or its -wal, -shm and -journal companions, a path under
//   /var/lib/secubuzz/), a target directly in the temporary root, a target that exists or has a sidecar file, and a
//   target folder that exists and is not empty. Then it creates the file, migrates it with the real runner and
//   options.directory set to a temporary copy of 0001 to 0007 only (names and checksums pinned below; 0008 and later are
//   never copied), inserts the rows below in one immediate transaction, checks integrity_check, foreign_key_check and the
//   ledger, closes the connection and returns a summary: file (real path), seed, version, row counts of every table,
//   group counts (0008 must add one extension row per group and one interval per group member) and a content digest.
//   The file stays in rollback-journal mode, so it is one file with no -wal or -shm sidecar. A failed build removes the
//   file it created.
// node tests/support/synthetic-v7.js <output-file> [seed]     (in DATA/)
//   The same from the command line; prints the summary as JSON. Exit code 1 on a refusal or a failure, 2 on a usage error.
// tableCounts(db), contentDigest(db)
//   Row count of every table; SHA-256 of every table (rows in primary-key order) and a total. contentDigest leaves out
//   SchemaMigrations.applied_at, the only value that the runner takes from the clock.
//
// Write paths. createRepositories: users.create, conversations.create, members.insert, setRole and leave,
// messages.insertAuthenticated and tombstone, receipts.insert, attachments.insert, audit.insert, friendRequests.insert,
// friendships.insert, blocks.insert and sessions.insert and revoke. createSocialRepository: resolveRequest,
// acceptFriendship and block. createKeyRepository (e2ee): insertDevice, status and insertEpoch (epochs with wraps).
// Parameter-bound statements of this file write the rest: AccountCredentials, Contacts and SecurityLogs (no repository
// function that takes fixed values), legacy Messages (messages.insert takes no created_at and the envelope trigger
// forbids changing it later), the authenticated FriendRequests rows (insertRequest draws a random id), and "pin" updates
// that replace the column defaults the repositories leave (created_at, last_seen, updated_at, joined_at, recorded_at)
// with the fixed times of this file. The status of an attachment is set by such an update, because
// attachments.setStatus reads the clock.
//
// Determinism (NFR-07): no Math.random and no clock in any value; every opaque string (ciphertext, iv, fingerprint,
// keys, signatures, hashes, storage keys) comes from support/random.js seeded with `seed`, one stream per label. Ids,
// times and the shape of the data set are the same for every seed. For one seed every row of every table is the same
// on every run, except SchemaMigrations.applied_at; the file is therefore not byte-identical between runs.
//
// The data set (A = authenticated, L = legacy origin):
//   Users           8: ada, ben, cleo, dan, eve, finn with AccountCredentials (registered 2026-01-05), gus and hana
//                   legacy only (2025-09-01). Users times in the 'YYYY-MM-DD HH:MM:SS' form that CURRENT_TIMESTAMP writes.
//   Social          contacts gus<->hana, a legacy friendship gus-hana, a legacy pending request hana->ada, a legacy block
//                   hana->ben; A requests ada->ben, cleo->dan, ben->dan (accepted, with A friendships), eve->finn
//                   (pending), dan->eve (declined); an A block finn->ada; a security log of gus; 2 sessions (1 revoked).
//   Direct          L gus-hana (the id form and 'YYYY-MM-DD HH:MM:SS' times of a DM that 0002 migrated, 3 messages with
//                   delivered_at and read_at), L ben-cleo (2 messages), A ada-ben (envelope 1, 4 messages, one deleted,
//                   one attachment), A cleo-dan (envelope 2, one key epoch, 3 messages).
//   Groups          A alpha (owner ada; 6 members, eve and finn former; 12 envelope-1 messages, one deleted; dan joined
//                   at '2026-02-10 10:05:00' after seq 4 and finn after seq 8; 2 attachments), A beta (owner cleo;
//                   6 members, ada former before any message; 10 envelope-2 messages over 3 key epochs; ben joined after
//                   the last message), L legacy group (owner gus; hana former; 2 legacy messages).
//   Keys            7 device keys (cleo rotated: version 1 superseded, version 2 active), 4 epochs, 16 wraps.
//   Receipts        14. Attachments: 3 rows without stored bytes (the private-storage volume stays empty).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { loadMigrations, migrate } = require('../../server/database/migrate');
const { createRepositories } = require('../../server/database/repositories');
const { createSocialRepository } = require('../../server/database/socialRepository');
const { createKeyRepository } = require('../../server/e2ee/repository');
const { guardPath, UnsafePathError } = require('./groups');
const { createRandom } = require('./random');

const VERSION = 7;
const DEFAULT_SEED = 535;
const UINT32_MAX = 0xffffffff;
const SIDECARS = Object.freeze(['-wal', '-shm', '-journal']);
// Design, Data Models: SHA-256 of the LF-normalised text of each published migration (the checksum the runner records).
const PUBLISHED = Object.freeze([
    { version:1, name:'0001-legacy.sql', checksum:'7ac0d3b5695135a3f8b2a2bc747e707b211899ee6651aff63d0aeb4ea49a006f' },
    { version:2, name:'0002-foundation.sql', checksum:'8f2e3b0bbdd09e59e85ab5c395518b816b9590804b42fcb0c84ef26a893c55c4' },
    { version:3, name:'0003-authentication.sql', checksum:'ad5b31788a95ea296a7ba908f647fbc9bc8ae91d9035a31503681a3f5199634f' },
    { version:4, name:'0004-profiles-friends.sql', checksum:'cc3e1700a5ec4b83e9fd4a72a61a6ad647108d08a0e4c816cbcdcc9f99f7bd89' },
    { version:5, name:'0005-conversation-provenance.sql', checksum:'e6129fab323e2f0576f3b30b2da3225ab0efedb4cc02c37307ea949ea81c1e0c' },
    { version:6, name:'0006-encrypted-message-lifecycle.sql', checksum:'68b73b2d80569ddb24d8e68b51de919f61fa167b93032e76012ed9af96712ef9' },
    { version:7, name:'0007-recipient-keys.sql', checksum:'6a73d3a1533a40f09546fff27639ec654363837f4e6fcb6bd23a7aef5eff06c2' },
]);
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// ---------------------------------------------------------------------------------------------------------------
// The data set. Times are fixed strings: ISO 8601 with milliseconds as the application writes them, and the
// 'YYYY-MM-DD HH:MM:SS' form of CURRENT_TIMESTAMP where the schema or a migrated legacy row has it.
// ---------------------------------------------------------------------------------------------------------------
const USERS = Object.freeze([
    { key:'ada', name:'Ada', created:'2026-01-05 10:00:00', account:true },
    { key:'ben', name:'Ben', created:'2026-01-05 10:01:00', account:true },
    { key:'cleo', name:'Cleo', created:'2026-01-05 10:02:00', account:true },
    { key:'dan', name:'Dan', created:'2026-01-05 10:03:00', account:true },
    { key:'eve', name:'Eve', created:'2026-01-05 10:04:00', account:true },
    { key:'finn', name:'Finn', created:'2026-01-05 10:05:00', account:true },
    { key:'gus', name:'Gus', created:'2025-09-01 08:00:00', account:false },
    { key:'hana', name:'Hana', created:'2025-09-01 08:05:00', account:false },
]);
const userId = key => `synthetic-${key}`;
const usernameOf = key => `syn-${key}`;
const displayName = key => `Synthetic ${USERS.find(user => user.key === key).name}`;
const SPACE_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const toIso = text => (SPACE_FORM.test(text) ? `${text.replace(' ', 'T')}.000Z` : text);
// The id that 0002 gives a migrated legacy DM: 'legacy-dm:' || hex(low) || ':' || hex(high) (upper-case hex of UTF-8).
const hexUpper = text => Buffer.from(text, 'utf8').toString('hex').toUpperCase();
const legacyDirectId = (low, high) => `legacy-dm:${hexUpper(userId(low))}:${hexUpper(userId(high))}`;

const CONTACTS = Object.freeze([
    { id:'synthetic-contact-1', from:'gus', to:'hana', status:'accepted', at:'2025-09-02 10:00:00' },
    { id:'synthetic-contact-2', from:'hana', to:'gus', status:'accepted', at:'2025-09-02 10:00:30' },
]);
const LEGACY_FRIENDSHIP = Object.freeze({ a:'gus', b:'hana', at:'2025-09-02 10:00:00' }); // 0002: min(created_at) of the contacts
const SECURITY_LOG = Object.freeze({ id:'synthetic-security-1', user:'gus', event:'login', severity:'LOW', source:'auditor_bot',
    description:'Synthetic legacy security event', at:'2025-09-03 12:00:00' });
const LEGACY_REQUEST = Object.freeze({ id:'synthetic-request-legacy-1', from:'hana', to:'ada', at:'2026-01-06T09:00:00.000Z' });
const LEGACY_BLOCK = Object.freeze({ blocker:'hana', blocked:'ben', at:'2026-01-06T09:30:00.000Z' });
const REQUESTS = Object.freeze([
    { id:'synthetic-request-1', from:'ada', to:'ben', at:'2026-01-14T18:00:00.000Z', status:'accepted', resolved:'2026-01-15T09:00:00.000Z' },
    { id:'synthetic-request-2', from:'cleo', to:'dan', at:'2026-01-19T08:00:00.000Z', status:'accepted', resolved:'2026-01-19T09:00:00.000Z' },
    { id:'synthetic-request-3', from:'ben', to:'dan', at:'2026-01-21T10:00:00.000Z', status:'accepted', resolved:'2026-01-21T11:00:00.000Z' },
    { id:'synthetic-request-4', from:'eve', to:'finn', at:'2026-01-22T10:00:00.000Z', status:'pending', resolved:null },
    { id:'synthetic-request-5', from:'dan', to:'eve', at:'2026-01-22T11:00:00.000Z', status:'declined', resolved:'2026-01-22T12:00:00.000Z' },
]);
const BLOCK = Object.freeze({ blocker:'finn', blocked:'ada', at:'2026-01-23T08:00:00.000Z' });
const DEVICES = Object.freeze([
    { user:'ada', device:'ada', version:1, at:'2026-01-10T12:00:00.000Z' },
    { user:'ben', device:'ben', version:1, at:'2026-01-10T12:01:00.000Z' },
    { user:'cleo', device:'cleo', version:1, at:'2026-01-10T12:02:00.000Z' },
    { user:'dan', device:'dan', version:1, at:'2026-01-10T12:03:00.000Z' },
    { user:'eve', device:'eve', version:1, at:'2026-01-10T12:04:00.000Z' },
    { user:'finn', device:'finn', version:1, at:'2026-01-10T12:05:00.000Z' },
]);
const ROTATION = Object.freeze({ user:'cleo', device:'cleo', version:2, at:'2026-02-01T09:00:00.000Z' });
const SESSIONS = Object.freeze([
    { id:'synthetic-session-ada', user:'ada', issued:'2026-02-12T08:00:00.000Z', revoked:null },
    { id:'synthetic-session-cleo', user:'cleo', issued:'2026-02-12T08:05:00.000Z', revoked:'2026-02-12T09:05:00.000Z' },
]);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Conversation events, applied in the order listed (the order of time).
const join = (user, at, role = 'member') => ({ type:'join', user, at, role });
const leave = (user, at) => ({ type:'leave', user, at });
const message = (n, from, at, legacyStatus = {}) => ({ type:'message', n, from, at, ...legacyStatus });
const remove = (n, at) => ({ type:'delete', n, at });
const receipt = (n, user, status, at) => ({ type:'receipt', n, user, status, at });
const epoch = (at, to) => ({ type:'epoch', at, to });
const attachment = (name, user, at, { n = null, readyAt = null, bytes }) => ({ type:'attachment', name, user, at, n, readyAt, bytes });

const LEGACY_PERIOD = Object.freeze([
    { key:'legacy-dm-1', id:legacyDirectId('gus', 'hana'), kind:'direct', origin:'legacy', pair:['gus', 'hana'],
        created:'2025-09-05 10:00:00', updated:'2025-09-05 10:20:00', events:[
            message(1, 'gus', '2025-09-05 10:00:00', { delivered:'2025-09-05 10:00:05', read:'2025-09-05 10:01:00' }),
            message(2, 'hana', '2025-09-05 10:10:00', { delivered:'2025-09-05 10:10:03' }),
            message(3, 'gus', '2025-09-05 10:20:00'),
        ] },
    { key:'legacy-group', id:'synthetic-group-legacy', kind:'group', origin:'legacy', title:'Synthetic legacy group', creator:'gus',
        created:'2025-11-20T09:00:00.000Z', updated:'2025-11-20T09:45:00.000Z', events:[
            join('hana', '2025-11-20T09:00:00.000Z'),
            message(1, 'gus', '2025-11-20T09:30:00.000Z'),
            message(2, 'hana', '2025-11-20T09:45:00.000Z'),
            leave('hana', '2025-11-21T09:00:00.000Z'),
        ] },
]);
const LEGACY_DIRECT_AFTER_ACCOUNTS = Object.freeze({ key:'legacy-dm-2', id:'synthetic-legacy-dm-ben-cleo', kind:'direct', origin:'legacy',
    pair:['ben', 'cleo'], created:'2026-01-06T14:00:00.000Z', updated:'2026-01-06T14:05:00.000Z', events:[
        message(1, 'ben', '2026-01-06T14:00:00.000Z', { delivered:'2026-01-06T14:01:00.000Z' }),
        message(2, 'cleo', '2026-01-06T14:05:00.000Z'),
    ] });
const AUTHENTICATED_DIRECT = Object.freeze([
    { key:'dm-1', id:'synthetic-dm-ada-ben', kind:'direct', origin:'authenticated', envelope:1, pair:['ada', 'ben'], creator:'ada',
        created:'2026-01-15T10:00:00.000Z', updated:'2026-01-15T10:30:00.000Z', events:[
            message(1, 'ada', '2026-01-15T10:05:00.000Z'),
            attachment('photo', 'ada', '2026-01-15T10:05:01.000Z', { n:1, readyAt:'2026-01-15T10:05:02.000Z', bytes:20480 }),
            receipt(1, 'ben', 'delivered', '2026-01-15T10:05:30.000Z'),
            receipt(1, 'ben', 'read', '2026-01-15T10:06:00.000Z'),
            message(2, 'ben', '2026-01-15T10:06:30.000Z'),
            message(3, 'ada', '2026-01-15T10:07:00.000Z'),
            receipt(2, 'ada', 'read', '2026-01-15T10:08:00.000Z'),
            remove(3, '2026-01-15T10:20:00.000Z'),
            message(4, 'ben', '2026-01-15T10:30:00.000Z'),
        ] },
    { key:'dm-2', id:'synthetic-dm-cleo-dan', kind:'direct', origin:'authenticated', envelope:2, keyCreator:'cleo', pair:['cleo', 'dan'],
        creator:'cleo', created:'2026-01-20T08:00:00.000Z', updated:'2026-01-20T08:15:00.000Z', events:[
            epoch('2026-01-20T08:01:00.000Z', ['cleo', 'dan']),
            message(1, 'cleo', '2026-01-20T08:05:00.000Z'),
            receipt(1, 'dan', 'read', '2026-01-20T08:06:00.000Z'),
            message(2, 'dan', '2026-01-20T08:10:00.000Z'),
            message(3, 'cleo', '2026-01-20T08:15:00.000Z'),
        ] },
]);
const GROUPS = Object.freeze([
    { key:'alpha', id:'synthetic-group-alpha', kind:'group', origin:'authenticated', envelope:1, title:'Synthetic alpha', creator:'ada',
        created:'2026-02-10T08:00:00.000Z', updated:'2026-02-10T14:00:00.000Z', events:[
            join('ben', '2026-02-10T08:01:00.000Z', 'admin'),
            join('cleo', '2026-02-10T08:02:00.000Z'),
            join('eve', '2026-02-10T08:03:00.000Z'),
            message(1, 'ada', '2026-02-10T08:30:00.000Z'),
            receipt(1, 'ben', 'read', '2026-02-10T08:31:00.000Z'),
            receipt(1, 'cleo', 'read', '2026-02-10T08:35:00.000Z'),
            message(2, 'ben', '2026-02-10T09:00:00.000Z'),
            message(3, 'cleo', '2026-02-10T09:30:00.000Z'),
            message(4, 'eve', '2026-02-10T10:00:00.000Z'),
            join('dan', '2026-02-10 10:05:00'), // the CURRENT_TIMESTAMP form; a plain text comparison would place it before seq 1
            message(5, 'dan', '2026-02-10T10:30:00.000Z'),
            receipt(5, 'ada', 'delivered', '2026-02-10T10:31:00.000Z'),
            message(6, 'ada', '2026-02-10T11:00:00.000Z'),
            leave('eve', '2026-02-10T11:15:00.000Z'),
            message(7, 'ben', '2026-02-10T11:30:00.000Z'),
            remove(7, '2026-02-10T11:45:00.000Z'),
            message(8, 'dan', '2026-02-10T12:00:00.000Z'),
            join('finn', '2026-02-10T12:10:00.000Z'),
            message(9, 'finn', '2026-02-10T12:30:00.000Z'),
            message(10, 'cleo', '2026-02-10T13:00:00.000Z'),
            attachment('report', 'cleo', '2026-02-10T13:00:01.000Z', { n:10, readyAt:'2026-02-10T13:00:02.000Z', bytes:65536 }),
            leave('finn', '2026-02-10T13:20:00.000Z'),
            message(11, 'ada', '2026-02-10T13:30:00.000Z'),
            attachment('draft', 'cleo', '2026-02-10T13:50:00.000Z', { bytes:4096 }),
            message(12, 'ben', '2026-02-10T14:00:00.000Z'),
            receipt(12, 'dan', 'read', '2026-02-10T14:05:00.000Z'),
        ] },
    { key:'beta', id:'synthetic-group-beta', kind:'group', origin:'authenticated', envelope:2, keyCreator:'cleo', title:'Synthetic beta',
        creator:'cleo', created:'2026-02-11T09:00:00.000Z', updated:'2026-02-11T16:01:00.000Z', events:[
            join('dan', '2026-02-11T09:01:00.000Z', 'admin'),
            join('eve', '2026-02-11T09:02:00.000Z'),
            join('ada', '2026-02-11T09:03:00.000Z'),
            join('finn', '2026-02-11T09:04:00.000Z'),
            epoch('2026-02-11T09:05:00.000Z', ['cleo', 'dan', 'eve', 'ada', 'finn']),
            leave('ada', '2026-02-11T09:10:00.000Z'),
            epoch('2026-02-11T09:15:00.000Z', ['cleo', 'dan', 'eve', 'finn']),
            message(1, 'cleo', '2026-02-11T09:30:00.000Z'),
            receipt(1, 'eve', 'read', '2026-02-11T09:31:00.000Z'),
            message(2, 'dan', '2026-02-11T10:00:00.000Z'),
            message(3, 'eve', '2026-02-11T10:30:00.000Z'),
            message(4, 'finn', '2026-02-11T11:00:00.000Z'),
            message(5, 'cleo', '2026-02-11T11:30:00.000Z'),
            message(6, 'dan', '2026-02-11T12:00:00.000Z'),
            message(7, 'eve', '2026-02-11T12:30:00.000Z'),
            message(8, 'finn', '2026-02-11T13:00:00.000Z'),
            message(9, 'cleo', '2026-02-11T13:30:00.000Z'),
            message(10, 'dan', '2026-02-11T14:00:00.000Z'),
            receipt(10, 'finn', 'delivered', '2026-02-11T14:01:00.000Z'),
            join('ben', '2026-02-11T16:00:00.000Z'),
            epoch('2026-02-11T16:01:00.000Z', ['cleo', 'dan', 'eve', 'finn', 'ben']),
        ] },
]);

// ---------------------------------------------------------------------------------------------------------------
// Writers.
// ---------------------------------------------------------------------------------------------------------------
function exactlyOne(result, step) {
    if (!result || result.changes !== 1) throw new Error(`synthetic fixture step "${step}" changed ${result ? result.changes : 'no'} rows`);
}

// One independent stream per label, so a value depends only on the seed and its label.
function createValues(seed) {
    const random = createRandom(seed);
    return Object.freeze({
        token:(label, length) => random.fork(label).string(BASE64URL, length, length),
        hex:(label, bytes) => random.fork(label).bytes(bytes).toString('hex'),
        base64:(label, bytes) => random.fork(label).bytes(bytes).toString('base64'),
    });
}

function insertUsers({ db, repositories }) {
    for (const user of USERS) {
        const id = userId(user.key);
        repositories.users.create({ user_id:id, username:usernameOf(user.key), display_name:displayName(user.key) });
        // users.create leaves CURRENT_TIMESTAMP in created_at and last_seen; the update of last_seen makes the trigger
        // users_timestamp_update write the clock into updated_at, so updated_at is pinned in a second statement.
        exactlyOne(db.prepare('UPDATE Users SET created_at = ?, last_seen = ? WHERE user_id = ?').run(user.created, user.created, id), 'user times');
        exactlyOne(db.prepare('UPDATE Users SET updated_at = ? WHERE user_id = ?').run(user.created, id), 'user updated_at');
        // Account users got their profile from users_profile_insert (ISO default); legacy users as 0002 copied it from Users.
        const profileTime = user.account ? toIso(user.created) : user.created;
        exactlyOne(db.prepare('UPDATE UserProfiles SET created_at = ?, updated_at = ? WHERE user_id = ?').run(profileTime, profileTime, id), 'profile times');
    }
}

function insertLegacyRows({ db, repositories }) {
    for (const contact of CONTACTS) {
        db.prepare('INSERT INTO Contacts(contact_id, user_id, friend_id, status, created_at) VALUES(?, ?, ?, ?, ?)')
            .run(contact.id, userId(contact.from), userId(contact.to), contact.status, contact.at);
    }
    const { a, b, at } = LEGACY_FRIENDSHIP;
    repositories.friendships.insert(userId(a), userId(b));
    exactlyOne(db.prepare('UPDATE Friendships SET created_at = ? WHERE user_low = ? AND user_high = ?').run(at, userId(a), userId(b)), 'legacy friendship');
    const log = SECURITY_LOG; // security_audit_insert copies it into AuditLogs with the same created_at
    db.prepare(`INSERT INTO SecurityLogs(log_id, user_id, event_type, severity, source, description, details_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(log.id, userId(log.user), log.event, log.severity, log.source, log.description, '{}', log.at);
}

function insertLegacySocialAfterAccounts({ db, repositories }) {
    const request = LEGACY_REQUEST;
    repositories.friendRequests.insert({ request_id:request.id, sender_id:userId(request.from), recipient_id:userId(request.to) });
    exactlyOne(db.prepare('UPDATE FriendRequests SET created_at = ? WHERE request_id = ?').run(request.at, request.id), 'legacy request');
    const block = LEGACY_BLOCK;
    repositories.blocks.insert(userId(block.blocker), userId(block.blocked));
    exactlyOne(db.prepare('UPDATE Blocks SET created_at = ? WHERE blocker_id = ? AND blocked_id = ?')
        .run(block.at, userId(block.blocker), userId(block.blocked)), 'legacy block');
}

function insertAccounts({ db, repositories, values }) {
    for (const user of USERS.filter(entry => entry.account)) {
        const id = userId(user.key);
        const at = toIso(user.created);
        // A well-formed Argon2id string over seeded bytes: no password verifies against it.
        const salt = values.base64(`password-salt:${user.key}`, 16).replace(/=+$/, '');
        const hash = values.base64(`password-hash:${user.key}`, 32).replace(/=+$/, '');
        db.prepare(`INSERT INTO AccountCredentials(user_id, username_key, email_key, password_hash, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?)`).run(id, usernameOf(user.key), `${usernameOf(user.key)}@synthetic.invalid`,
            `$argon2id$v=19$m=19456,t=2,p=1$${salt}$${hash}`, at, at);
        const auditId = `synthetic-audit-registered-${user.key}`;
        repositories.audit.insert({ audit_id:auditId, actor_user_id:id, event_type:'auth.registered', source:'auth', metadata:{ outcome:'created' } });
        exactlyOne(db.prepare('UPDATE AuditLogs SET created_at = ? WHERE audit_id = ?').run(at, auditId), 'audit time');
    }
}

function deviceRecord(values, { user, device, version, at }) {
    return { deviceKeyId:values.token(`device-key:${device}:${version}`, 43), userId:userId(user), deviceId:values.token(`device:${device}`, 22),
        keyVersion:version, createdAt:at, agreementPublicKey:values.token(`agreement:${device}:${version}`, 87),
        signingPublicKey:values.token(`signing:${device}:${version}`, 87), signature:values.token(`device-signature:${device}:${version}`, 86) };
}
function insertDevices({ keys, values, devices }) {
    for (const entry of DEVICES) {
        const record = deviceRecord(values, entry);
        keys.insertDevice(record, entry.at);
        devices[entry.user] = record.deviceKeyId;
    }
}
function rotateDevice({ keys, values, devices }) {
    keys.status([devices[ROTATION.user]], 'superseded', ROTATION.at);
    const record = deviceRecord(values, ROTATION);
    keys.insertDevice(record, ROTATION.at);
    devices[ROTATION.user] = record.deviceKeyId;
}

function insertAuthenticatedSocial({ db, social }) {
    for (const request of REQUESTS) {
        db.prepare("INSERT INTO FriendRequests(request_id, sender_id, recipient_id, created_at, origin) VALUES(?, ?, ?, ?, 'authenticated')")
            .run(request.id, userId(request.from), userId(request.to), request.at);
        if (request.status !== 'pending') social.resolveRequest(request.id, request.status, request.resolved);
        if (request.status === 'accepted') social.acceptFriendship(userId(request.from), userId(request.to), request.resolved);
    }
    social.block(userId(BLOCK.blocker), userId(BLOCK.blocked), BLOCK.at);
}

function insertSessions({ db, repositories, values }) {
    for (const session of SESSIONS) {
        const issued = Date.parse(session.issued);
        repositories.sessions.insert({ session_id:session.id, user_id:userId(session.user), token_hash:values.hex(`session-token:${session.id}`, 32),
            csrf_token_hash:values.hex(`session-csrf:${session.id}`, 32), issued_at_ms:issued, expires_at_ms:issued + SESSION_TTL_MS, auth_version:1 });
        if (session.revoked) exactlyOne(repositories.sessions.revoke(session.id, Date.parse(session.revoked)), 'session revoke');
        exactlyOne(db.prepare('UPDATE Sessions SET created_at = ? WHERE session_id = ?').run(session.issued, session.id), 'session time');
    }
}

function insertReceipt({ db, repositories }, conversationId, messageId, user, status, at) {
    repositories.receipts.insert({ conversation_id:conversationId, message_id:messageId, user_id:user, status, observed_at:at });
    exactlyOne(db.prepare('UPDATE MessageReceipts SET recorded_at = ? WHERE conversation_id = ? AND message_id = ? AND user_id = ? AND status = ?')
        .run(at, conversationId, messageId, user, status), 'receipt time');
}

function insertMessage(context, spec, state, event) {
    const { db, repositories, values } = context;
    const id = `synthetic-${spec.key}-msg-${String(event.n).padStart(2, '0')}`;
    const sender = userId(event.from);
    const receiver = spec.kind === 'direct' ? userId(spec.pair.find(key => key !== event.from)) : null;
    const ciphertext = values.base64(`ciphertext:${id}`, 96);
    const iv = values.base64(`iv:${id}`, 12);
    if (spec.origin === 'authenticated') {
        repositories.messages.insertAuthenticated({ message_id:id, conversation_id:spec.id, sender_id:sender, receiver_id:receiver,
            ciphertext, iv, envelope_version:spec.envelope, encoding:'base64', sender_name:displayName(event.from), client_timestamp:event.at,
            message_type:'text', fingerprint:values.hex(`fingerprint:${id}`, 32), client_id:`synthetic-client-${spec.key}-${event.n}`,
            message_seq:event.n, created_at:event.at, ...(spec.envelope === 2 ? { key_id:state.key } : {}) });
    } else {
        db.prepare(`INSERT INTO Messages(message_id, conversation_id, sender_id, receiver_id, ciphertext, iv, created_at, updated_at, delivered_at, read_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, spec.id, sender, receiver, ciphertext, iv, event.at, event.at,
            event.delivered ?? null, event.read ?? null);
        // The receipts 0002 derives from delivered_at and read_at (observed_at = recorded_at = that time).
        if (event.delivered) insertReceipt(context, spec.id, id, receiver, 'delivered', event.delivered);
        if (event.read) insertReceipt(context, spec.id, id, receiver, 'read', event.read);
    }
    state.messages.set(event.n, id);
}

function insertEpoch({ keys, values, devices }, spec, state, event) {
    const number = state.epochs + 1;
    const label = `${spec.key}:${number}`;
    const keyId = values.token(`epoch-key:${label}`, 22);
    keys.insertEpoch({ conversationId:spec.id, keyId, epoch:number, previousKeyId:state.key, creatorUserId:userId(spec.keyCreator),
        creatorDeviceKeyId:devices[spec.keyCreator], createdAt:event.at, signature:values.token(`epoch-signature:${label}`, 86),
        recipientSetDigest:values.token(`epoch-recipients:${label}`, 43),
        wraps:event.to.map(key => ({ recipientUserId:userId(key), recipientDeviceKeyId:devices[key],
            enc:values.token(`wrap-enc:${label}:${key}`, 87), ciphertext:values.token(`wrap:${label}:${key}`, 64) })) }, event.at);
    state.epochs = number;
    state.key = keyId;
}

function insertAttachment({ db, repositories, values }, spec, state, event) {
    const id = `synthetic-${spec.key}-attachment-${event.name}`;
    repositories.attachments.insert({ attachment_id:id, conversation_id:spec.id, message_id:event.n === null ? null : state.messages.get(event.n),
        uploaded_by:userId(event.user), storage_key:`synthetic/${values.hex(`storage-key:${id}`, 16)}`,
        encrypted_metadata:values.base64(`metadata:${id}`, 48), media_type:'application/octet-stream', byte_size:event.bytes });
    exactlyOne(db.prepare('UPDATE Attachments SET status = ?, created_at = ?, updated_at = ? WHERE attachment_id = ?')
        .run(event.readyAt ? 'ready' : 'pending', event.at, event.readyAt ?? event.at, id), 'attachment');
}

function insertConversation(context, spec) {
    const { db, repositories } = context;
    const input = { conversation_id:spec.id, kind:spec.kind };
    if (spec.kind === 'direct') {
        const [low, high] = spec.pair.map(userId);
        if (!(low < high)) throw new Error(`synthetic fixture pair ${spec.key} is not in byte order`);
        Object.assign(input, { dm_user_low:low, dm_user_high:high });
    } else {
        input.title = spec.title;
    }
    if (spec.creator) input.created_by = userId(spec.creator);
    if (spec.origin === 'authenticated') input.origin = 'authenticated'; // without it the column default 'legacy' applies
    repositories.conversations.create(input);
    exactlyOne(db.prepare('UPDATE Conversations SET created_at = ?, updated_at = ? WHERE conversation_id = ?')
        .run(spec.created, spec.updated, spec.id), 'conversation times');
    for (const member of repositories.members.list(spec.id)) {
        exactlyOne(db.prepare('UPDATE ConversationMembers SET joined_at = ? WHERE conversation_id = ? AND user_id = ?')
            .run(spec.created, spec.id, member.user_id), 'creator joined_at');
    }
    const state = { messages:new Map(), epochs:0, key:null };
    for (const event of spec.events) {
        if (event.type === 'join') {
            repositories.members.insert({ conversation_id:spec.id, user_id:userId(event.user), role:'member' });
            exactlyOne(db.prepare('UPDATE ConversationMembers SET joined_at = ? WHERE conversation_id = ? AND user_id = ?')
                .run(event.at, spec.id, userId(event.user)), 'joined_at');
            if (event.role !== 'member') exactlyOne(repositories.members.setRole(spec.id, userId(event.user), event.role), 'role');
        } else if (event.type === 'leave') {
            exactlyOne(repositories.members.leave(spec.id, userId(event.user), event.at), 'leave');
        } else if (event.type === 'message') {
            insertMessage(context, spec, state, event);
        } else if (event.type === 'delete') {
            exactlyOne(repositories.messages.tombstone(state.messages.get(event.n), event.at), 'tombstone');
        } else if (event.type === 'receipt') {
            insertReceipt(context, spec.id, state.messages.get(event.n), userId(event.user), event.status, event.at);
        } else if (event.type === 'epoch') {
            insertEpoch(context, spec, state, event);
        } else if (event.type === 'attachment') {
            insertAttachment(context, spec, state, event);
        } else {
            throw new Error(`unknown synthetic fixture event ${event.type}`);
        }
    }
}

// In the order of time: the legacy period, registration, keys and friendships, direct conversations, a key rotation,
// the groups and the sessions.
function populate(db, values) {
    const context = { db, values, repositories:createRepositories(db), social:createSocialRepository(db), keys:createKeyRepository(db), devices:{} };
    insertUsers(context);
    insertLegacyRows(context);
    for (const spec of LEGACY_PERIOD) insertConversation(context, spec);
    insertAccounts(context);
    insertLegacySocialAfterAccounts(context);
    insertConversation(context, LEGACY_DIRECT_AFTER_ACCOUNTS);
    insertDevices(context);
    insertAuthenticatedSocial(context);
    for (const spec of AUTHENTICATED_DIRECT) insertConversation(context, spec);
    rotateDevice(context);
    for (const spec of GROUPS) insertConversation(context, spec);
    insertSessions(context);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading helpers.
// ---------------------------------------------------------------------------------------------------------------
const quoteName = name => `"${String(name).replace(/"/g, '""')}"`;
const tableNames = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function tableCounts(db) {
    return Object.fromEntries(tableNames(db).map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${quoteName(table)}`).get().n]));
}

const encodeValue = value => (typeof value === 'bigint' ? value.toString() : Buffer.isBuffer(value) ? value.toString('hex') : value);
function contentDigest(db) {
    const tables = {};
    for (const table of tableNames(db)) {
        const columns = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table);
        const names = columns.map(column => column.name).filter(name => !(table === 'SchemaMigrations' && name === 'applied_at'));
        const key = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => quoteName(column.name));
        const statement = db.prepare(`SELECT ${names.map(name => `typeof(${quoteName(name)}), ${quoteName(name)}`).join(', ')}
            FROM ${quoteName(table)} ORDER BY ${key.length ? key.join(', ') : 'rowid'}`).raw(true).safeIntegers(true);
        const hash = createHash('sha256');
        for (const row of statement.iterate()) {
            hash.update(`${JSON.stringify(names.map((name, index) => [name, row[2 * index], encodeValue(row[2 * index + 1])]))}\n`);
        }
        tables[table] = hash.digest('hex');
    }
    return { tables, total:sha256(JSON.stringify(Object.entries(tables))) };
}

function groupSummary(db) {
    const members = db.prepare(`SELECT count(*) AS n, coalesce(sum(cm.left_at IS NOT NULL), 0) AS former FROM ConversationMembers cm
        JOIN Conversations c ON c.conversation_id = cm.conversation_id WHERE c.kind = 'group'`).get();
    return {
        groups:db.prepare("SELECT count(*) AS n FROM Conversations WHERE kind = 'group'").get().n,
        groupMembers:members.n,
        formerGroupMembers:members.former,
        groupMessages:db.prepare(`SELECT count(*) AS n FROM Messages m JOIN Conversations c ON c.conversation_id = m.conversation_id
            WHERE c.kind = 'group'`).get().n,
    };
}

function verify(db) {
    assert.equal(db.pragma('integrity_check', { simple:true }), 'ok', 'synthetic fixture integrity_check');
    assert.deepEqual(db.pragma('foreign_key_check'), [], 'synthetic fixture foreign_key_check');
    assert.deepEqual(db.prepare('SELECT version, name, checksum FROM SchemaMigrations ORDER BY version').all(), PUBLISHED.map(entry => ({ ...entry })),
        'synthetic fixture ledger is 0001 to 0007');
}

// ---------------------------------------------------------------------------------------------------------------
// Paths and migrations.
// ---------------------------------------------------------------------------------------------------------------
function prepareTarget(filename) {
    const target = guardPath(filename);
    const folder = path.dirname(target);
    guardPath(folder); // a folder strictly inside os.tmpdir(): the temporary root itself is refused
    for (const candidate of [target, ...SIDECARS.map(suffix => target + suffix)]) {
        if (fs.existsSync(candidate)) throw new UnsafePathError('target-exists', candidate);
    }
    let createdFolder = false;
    if (fs.existsSync(folder)) {
        if (!fs.statSync(folder).isDirectory()) throw new UnsafePathError('folder-not-directory', folder);
        if (fs.readdirSync(folder).length) throw new UnsafePathError('folder-not-empty', folder);
    } else {
        fs.mkdirSync(folder, { recursive:true });
        createdFolder = true;
    }
    return { target:guardPath(target), folder, createdFolder };
}

// A temporary copy of 0001 to 0007 for the runner's options.directory; removed file by file afterwards.
function withPublishedMigrations(work) {
    const published = loadMigrations().filter(migration => migration.version <= VERSION);
    assert.deepEqual(published.map(({ version, name, checksum }) => ({ version, name, checksum })), PUBLISHED.map(entry => ({ ...entry })),
        'migrations 0001 to 0007 keep their published names and checksums');
    const directory = guardPath(fs.mkdtempSync(path.join(os.tmpdir(), 'secubuzz-db5-v7-migrations-')));
    const written = [];
    try {
        for (const migration of published) {
            const file = path.join(directory, migration.name);
            fs.writeFileSync(file, migration.sql, { flag:'wx' });
            written.push(file);
        }
        return work(directory);
    } finally {
        for (const file of written) fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
}

function buildVersionSeven(filename, { seed = DEFAULT_SEED } = {}) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > UINT32_MAX) throw new RangeError(`seed must be an integer from 0 to ${UINT32_MAX}`);
    const { target, folder, createdFolder } = prepareTarget(filename);
    const values = createValues(seed);
    let db = null;
    try {
        db = new Database(target);
        db.pragma('foreign_keys = ON');
        db.pragma('journal_mode = DELETE');
        const result = withPublishedMigrations(directory => migrate(db, { directory }));
        assert.deepEqual(result, { version:VERSION, applied:PUBLISHED.map(entry => entry.name) }, 'a fresh file migrated to version 7');
        db.transaction(() => populate(db, values)).immediate();
        verify(db);
        const summary = { file:target, seed, version:VERSION, counts:tableCounts(db), groups:groupSummary(db), digest:contentDigest(db).total };
        db.close();
        return summary;
    } catch (error) {
        if (db && db.open) db.close();
        // Remove only what this call created: the target, its sidecars and an empty folder it made.
        for (const candidate of [target, ...SIDECARS.map(suffix => target + suffix)]) if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
        if (createdFolder && fs.existsSync(folder) && !fs.readdirSync(folder).length) fs.rmdirSync(folder);
        throw error;
    }
}

function main(argv) {
    if (argv.length < 1 || argv.length > 2 || (argv.length === 2 && !/^\d{1,10}$/.test(argv[1]))) {
        process.stderr.write('usage: node tests/support/synthetic-v7.js <output-file-in-a-new-folder-under-os.tmpdir()> [seed]\n');
        return 2;
    }
    const seed = argv.length === 2 ? Number(argv[1]) : DEFAULT_SEED;
    const summary = buildVersionSeven(argv[0], { seed });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`synthetic-v7: ${error && error.message ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

module.exports = { DEFAULT_SEED, VERSION, buildVersionSeven, tableCounts, contentDigest };
