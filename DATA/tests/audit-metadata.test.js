// T-5B-20 (DB5-R12.8, DB5-R13.5, ARCH-R01.6, NFR-06; design Group_Repository and the repositories.js row).
// Allow-list clause of P-30: audit.insert accepts the metadata keys target_id and role when the value matches
// ^[a-zA-Z0-9_.:-]{1,64}$, rejects every other value and every key outside the allow-list, and a rejected insert
// writes no row. The full P-30 property (service operations and canary scans) lands in T-5C-40.
// translate() is exported with unchanged behaviour: a trigger abort maps to INVALID (the Group_Repository maps it
// to CONFLICT itself, CI-12) and a foreign key error to REFERENCE.
// Databases live in new folders under os.tmpdir() (support/database.js); no unseeded random source, clock or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, temporary, users, Database } = require('./support/database');
const { RepositoryError, translate } = require('../server/database/repositories');

const ALLOWED_KEYS = ['reason_code', 'operation', 'outcome', 'count', 'duration_ms', 'target_id', 'role'];
const NEW_KEYS = ['target_id', 'role'];
const VALUE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-';
// Spaces, quotes, path separators, control characters, markup and non-ASCII letters (escaped: the file is ASCII).
const HOSTILE_CHARACTERS = [' ', "'", '"', '`', '/', '\\', '\n', '\r', '\t', '\u0000', '<', '>', ';', '%', '\u00e9', '\u2028'];
// Seeded property run of the allow-list clause. Replay with PROPERTY_SEED=<seed> node --test tests/audit-metadata.test.js
const P30_RUNS = 200;
const P30_DEFAULT_SEED = 30120;

const auditRows = db => db.prepare('SELECT count(*) AS n FROM AuditLogs').get().n;
const event = metadata => ({ actor_user_id:'a', event_type:'group.member.role_changed', source:'groups', subject_id:'group-1', metadata });
const isInvalid = error => error instanceof RepositoryError && error.code === 'INVALID' &&
    error.message === 'Database operation failed: INVALID' && error.cause === undefined;

// mulberry32, a 32-bit seeded generator (the same as baseline-checksums.test.js until T-5B-10 adds support/random.js).
function createRandom(seed) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min, max) => min + Math.floor(next() * (max - min + 1));
    return { int, pick:list => list[int(0, list.length - 1)] };
}
function seedSetting() {
    const raw = process.env.PROPERTY_SEED;
    if (raw === undefined || raw === '') return P30_DEFAULT_SEED;
    if (!/^\d{1,10}$/.test(raw) || Number(raw) > 0xffffffff) throw new Error('PROPERTY_SEED must be an integer from 0 to 4294967295');
    return Number(raw);
}
const validValue = (random, length) => Array.from({ length }, () => random.pick([...VALUE_ALPHABET])).join('');

test('audit.insert stores target_id and role with valid values beside the existing keys', t => {
    const { repositories:r } = fixture(t); users(r);
    const metadata = { operation:'member.role_change', outcome:'ok', reason_code:'owner_transfer', count:1, duration_ms:0,
        target_id:'6f1c0e9a-2b4d-4c8e-9a10-3f5e7d9b1c2a', role:'admin' };
    const stored = r.audit.insert(event(metadata));
    assert.deepEqual(JSON.parse(stored.metadata_json), metadata);
    assert.equal(stored.source, 'groups');
    assert.equal(stored.subject_id, 'group-1');
    for (const value of ['b', 'owner', 'member', 'A.b_c:d-9', 'x'.repeat(64)]) {
        for (const key of NEW_KEYS) {
            assert.deepEqual(JSON.parse(r.audit.insert(event({ [key]:value })).metadata_json), { [key]:value }, `${key}=${value}`);
        }
    }
});

test('audit.insert rejects target_id and role values with spaces, quotes, path separators or more than 64 characters', t => {
    const { db, repositories:r } = fixture(t); users(r);
    const hostile = ['user b', ' b', 'b ', "o'brien", 'say"hi"', '`b`', '../etc', 'a/b', '/var/lib/secubuzz', 'C:\\Users\\b',
        'a\\b', 'line\nbreak', 'tab\there', '', 'x'.repeat(65), 'x'.repeat(200), 'caf\u00e9', 1, true, null, {}, ['admin']];
    const before = auditRows(db);
    for (const key of NEW_KEYS) {
        for (const value of hostile) {
            assert.throws(() => r.audit.insert(event({ [key]:value })), isInvalid, `${key}=${JSON.stringify(value)}`);
            assert.throws(() => r.audit.insert(event({ operation:'member.add', [key]:value })), isInvalid, `${key}=${JSON.stringify(value)} with a valid key`);
        }
    }
    assert.equal(auditRows(db), before, 'a rejected insert writes no AuditLogs row');
});

test('audit.insert still rejects password, prompt, ciphertext, other keys and a reason_code with spaces', t => {
    const { db, repositories:r } = fixture(t); users(r);
    const before = auditRows(db);
    const rejected = [{ password:'SECRET' }, { prompt:'PRIVATE' }, { ciphertext:'PRIVATE' }, { reason_code:'private words with spaces' },
        { plaintext:'PRIVATE' }, { name:'Group' }, { description:'Text' }, { file_name:'report.pdf' }, { path:'a' }, { token:'a' },
        { key:'a' }, { targetId:'b' }, { TARGET_ID:'b' }, { 'target_id ':'b' }, { target_id:'b', password:'SECRET' }, { role:'admin', title:'Group' }];
    for (const metadata of rejected) assert.throws(() => r.audit.insert(event(metadata)), isInvalid, JSON.stringify(metadata));
    for (const metadata of [[], 'target_id', 1]) assert.throws(() => r.audit.insert(event(metadata)), isInvalid, JSON.stringify(metadata));
    assert.equal(auditRows(db), before, 'a rejected insert writes no AuditLogs row');
});

test('P-30 allow-list clause: generated values and keys are accepted exactly when the key is allowed and the value matches', t => {
    // **Validates: Requirements DB5-R12.8, NFR-06**
    const { db, repositories:r } = fixture(t); users(r);
    const seed = seedSetting();
    t.diagnostic(`P-30 allow-list seed=${seed} runs=${P30_RUNS}`);
    const random = createRandom(seed);
    for (let run = 0; run < P30_RUNS; run++) {
        const label = `seed=${seed} run=${run}`;
        const key = random.pick(NEW_KEYS);
        const value = validValue(random, random.int(1, 64));
        const stored = r.audit.insert(event({ [key]:value }));
        assert.deepEqual(JSON.parse(stored.metadata_json), { [key]:value }, `${label} accepted ${key}=${value}`);

        const rows = auditRows(db);
        let bad;
        if (random.int(0, 2) === 0) {
            bad = value + validValue(random, random.int(65 - value.length, 200 - value.length));
        } else {
            const at = random.int(0, value.length);
            bad = value.slice(0, at) + random.pick(HOSTILE_CHARACTERS) + value.slice(at);
        }
        assert.throws(() => r.audit.insert(event({ [key]:bad })), isInvalid, `${label} value ${key}=${JSON.stringify(bad)}`);
        let other = validValue(random, random.int(1, 24));
        if (ALLOWED_KEYS.includes(other)) other += '_x';
        assert.throws(() => r.audit.insert(event({ [other]:value })), isInvalid, `${label} key ${JSON.stringify(other)}`);
        assert.equal(auditRows(db), rows, `${label} a rejected insert writes no AuditLogs row`);
    }
});

test('translate is exported and keeps its error classes for real SQLite errors without driver text', t => {
    assert.equal(typeof translate, 'function');
    const connections = [];
    const directory = temporary(t, () => { for (const connection of connections.reverse()) if (connection.open) connection.close(); });
    const filename = path.join(directory, 'translate.sqlite');
    const db = new Database(filename); connections.push(db);
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE parent(id TEXT PRIMARY KEY, name TEXT UNIQUE, size INTEGER CHECK(size >= 0), note TEXT NOT NULL DEFAULT '');
        CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
        CREATE TRIGGER parent_guard BEFORE UPDATE OF note ON parent BEGIN
            SELECT RAISE(ABORT, 'group_conflict') WHERE NEW.note = 'conflict';
            SELECT RAISE(ABORT, 'username_unavailable') WHERE NEW.note = 'taken';
        END;
        INSERT INTO parent(id, name, size) VALUES('p', 'unique-name', 1);`);
    const raised = work => { try { work(); } catch (error) { return error; } throw new Error('expected a database error'); };
    const cases = [
        ['primary key', () => db.prepare("INSERT INTO parent(id) VALUES('p')").run(), 'DUPLICATE'],
        ['unique', () => db.prepare("INSERT INTO parent(id, name) VALUES('q', 'unique-name')").run(), 'DUPLICATE'],
        ['trigger username_unavailable', () => db.prepare("UPDATE parent SET note='taken'").run(), 'DUPLICATE'],
        ['other trigger', () => db.prepare("UPDATE parent SET note='conflict'").run(), 'INVALID'],
        ['check', () => db.prepare("INSERT INTO parent(id, size) VALUES('q', -1)").run(), 'INVALID'],
        ['not null', () => db.prepare("INSERT INTO parent(id, note) VALUES('q', NULL)").run(), 'INVALID'],
        ['foreign key', () => db.prepare("INSERT INTO child(id, parent_id) VALUES('c', 'missing')").run(), 'REFERENCE'],
        ['syntax', () => db.prepare('SELEC 1'), 'DATABASE'],
        ['no code', () => { throw new Error('/var/lib/secubuzz/private driver text'); }, 'DATABASE']
    ];
    const second = new Database(filename, { timeout:0 }); connections.push(second);
    db.exec('BEGIN IMMEDIATE');
    cases.push(['busy', () => second.prepare("INSERT INTO parent(id) VALUES('busy')").run(), 'BUSY']);
    for (const [label, work, code] of cases) {
        const error = raised(work);
        const mapped = translate(error);
        assert.ok(mapped instanceof RepositoryError, label);
        assert.equal(mapped.code, code, `${label}: ${error.code}`);
        assert.equal(mapped.message, `Database operation failed: ${code}`, label);
        assert.equal(mapped.cause, undefined, label);
        assert.equal(translate(mapped), mapped, `${label}: a RepositoryError passes through unchanged`);
    }
    db.exec('ROLLBACK');
});
