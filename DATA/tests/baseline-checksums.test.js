// T-5B-05 (DB5-R14.2, DB5-R15.11, ARCH-R02.1; design DC-01; decision OP-06 in DATA/docs/db5-db6-handoff.md).
// The file reads only files under DATA/ and never git, so it runs unchanged in the Validation_Runner (no .git there).
// 1. Published migrations 0001 to 0007 keep the SHA-256 pinned in the design (Data Models), the runner records the
//    same checksum, and a single-byte change of an applied copy makes the runner refuse and change nothing (P-29).
// 2. The 29 baseline test files and 6 support files of tests/fixtures/baseline-d7cd40a.json keep their digests. The
//    seven DC-01 lines may differ only by the change OP-06 permits, and that change must match the migrations after
//    0007 that exist in server/database/migrations. The guard undoes it and then requires the manifest digest.
// 3. Script files under tests/ that the manifest does not list carry none of the five skip markers of command G5a.
// The manifest and the migration files are only read. Databases and copies live in new folders under os.tmpdir().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fixture, temporary } = require('./support/database');
const { migrate, loadMigrations } = require('../server/database/migrate');

const BASELINE = 'd7cd40aafcf8f432d17d3f4a85abb26d19fa9bc3';
const TESTS_ROOT = __dirname;
const MIGRATIONS = path.join(__dirname, '..', 'server', 'database', 'migrations');
const MANIFEST_FILE = path.join(__dirname, 'fixtures', 'baseline-d7cd40a.json');
// SHA-256 of the LF-normalised manifest as T-5B-03 recorded it; the recorder never replaces an existing manifest.
const MANIFEST_SHA256 = 'fa6d3c1d72d8f5d8bce227341952ef3ca71fa963a99f4f3ea0431fbefd7e76ab';
// Design, Data Models: SHA-256 of the LF-normalised text of each published migration at d7cd40a.
const PUBLISHED = Object.freeze([
    { version:1, name:'0001-legacy.sql', sha256:'7ac0d3b5695135a3f8b2a2bc747e707b211899ee6651aff63d0aeb4ea49a006f' },
    { version:2, name:'0002-foundation.sql', sha256:'8f2e3b0bbdd09e59e85ab5c395518b816b9590804b42fcb0c84ef26a893c55c4' },
    { version:3, name:'0003-authentication.sql', sha256:'ad5b31788a95ea296a7ba908f647fbc9bc8ae91d9035a31503681a3f5199634f' },
    { version:4, name:'0004-profiles-friends.sql', sha256:'cc3e1700a5ec4b83e9fd4a72a61a6ad647108d08a0e4c816cbcdcc9f99f7bd89' },
    { version:5, name:'0005-conversation-provenance.sql', sha256:'e6129fab323e2f0576f3b30b2da3225ab0efedb4cc02c37307ea949ea81c1e0c' },
    { version:6, name:'0006-encrypted-message-lifecycle.sql', sha256:'68b73b2d80569ddb24d8e68b51de919f61fa167b93032e76012ed9af96712ef9' },
    { version:7, name:'0007-recipient-keys.sql', sha256:'6a73d3a1533a40f09546fff27639ec654363837f4e6fcb6bd23a7aef5eff06c2' },
]);
const LAST_PUBLISHED = PUBLISHED[PUBLISHED.length - 1];
// P-29 generator. A failure prints property, seed, run and runSeed; replay one run with
// PROPERTY_SEED=<seed> PROPERTY_RUN=<run> node --test tests/baseline-checksums.test.js
const P29_RUNS = 105; // run r mutates the applied copy of file r mod 7, so each of the seven files gets 15 cases
const P29_DEFAULT_SEED = 23301;

// Same normalisation as the migration runner (server/database/migrate.js) and the recorder: UTF-8, CRLF -> LF.
const lfText = buffer => buffer.toString('utf8').replace(/\r\n/g, '\n');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const readText = file => lfText(fs.readFileSync(file));
const manifestText = readText(MANIFEST_FILE);
const manifest = JSON.parse(manifestText);
const manifestFiles = () => [...Object.entries(manifest.tests), ...Object.entries(manifest.support)];
const laterMigrations = () => loadMigrations().filter(m => m.version > LAST_PUBLISHED.version).map(({ version, name }) => ({ version, name }));

// ---------------------------------------------------------------------------------------------------------------
// P-29 (checksum clauses): seeded generator, single-byte mutation and database snapshot.
// ---------------------------------------------------------------------------------------------------------------
// mulberry32, a 32-bit seeded generator: no Math.random and no clock (NFR-07). T-5B-10 adds support/random.js later.
function createRandom(seed) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    return { int:(min, max) => min + Math.floor(next() * (max - min + 1)) };
}
const runSeedOf = (seed, run) => (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(run + 1, 0xc2b2ae35)) >>> 0;
function integerSetting(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d{1,10}$/.test(raw) || Number(raw) > 0xffffffff) throw new Error(`${name} must be an integer from 0 to 4294967295`);
    return Number(raw);
}
// One byte at a random offset replaced by a different random byte. A draw that leaves the LF-normalised text
// unchanged is no change for the runner and is drawn again.
function mutateOneByte(random, bytes) {
    const original = sha256(lfText(bytes));
    for (let attempt = 0; attempt < 32; attempt++) {
        const offset = random.int(0, bytes.length - 1);
        const drawn = random.int(0, 254);
        const value = drawn >= bytes[offset] ? drawn + 1 : drawn;
        const mutated = Buffer.from(bytes);
        mutated[offset] = value;
        if (sha256(lfText(mutated)) !== original) return { offset, from:bytes[offset], to:value, bytes:mutated };
    }
    throw new Error('no drawn single-byte mutation changed the normalised text');
}
// Schema objects, every row of every table, and the schema and user version counters.
function snapshot(db) {
    const objects = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    const rows = {};
    for (const { type, name } of objects) if (type === 'table') rows[name] = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
    return { objects, rows, schemaVersion:db.pragma('schema_version', { simple:true }), userVersion:db.pragma('user_version', { simple:true }) };
}

// ---------------------------------------------------------------------------------------------------------------
// DC-01 guard (OP-06). The seven lines and the kind of change permitted on each:
// names: migration file names appended after the last element '0007-recipient-keys.sql' of the applied list;
// versions: version numbers appended after the last element 7 of the ledger list;
// highest: the single version literal 7 replaced by the highest version.
// ---------------------------------------------------------------------------------------------------------------
const DC01_RULES = Object.freeze([
    { file:'auth-migrations.test.js', line:24, kind:'names' },
    { file:'conversations-migrations.test.js', line:21, kind:'names' },
    { file:'e2ee-migrations.test.js', line:12, kind:'names' },
    { file:'e2ee-migrations.test.js', line:29, kind:'highest' },
    { file:'messaging-migrations.test.js', line:11, kind:'names' },
    { file:'migrations.test.js', line:14, kind:'versions' },
    { file:'social-migrations.test.js', line:25, kind:'names' },
]);
const LIST_START = 'migrate(db).applied,[';
// Exact, reviewed Phase 11 fixture changes from checkpoint 92c07ce. DC-01 tails
// are restored before hashing; every other byte remains pinned. The original
// manifest and published SQL checksums are unchanged.
const MESSAGING_CHECKPOINT_DIGESTS = Object.freeze({
    'e2ee-migrations.test.js':'5485f3f4e84488f8e55c3ee5ee16309f71ac3a8f2bee7d3c07c63457ca294e27',
    'messaging-http.test.js':'625c8502513384d0e16c4a80040c5b4b7137488823def7e4157fdf2bc09283a4',
    'support/messaging.js':'02c93a4489a588c5941a5f32d68d7e3a42695a9ac49fc68a127ed01fda59e9ed',
});
const LAST_NAME = `'${LAST_PUBLISHED.name}'`;
const VERSION_LIST = `[${PUBLISHED.map(m => m.version).join(',')}]`;
const KINDS = Object.freeze({
    names:{ shape:/^(?:,'\d{4}-[a-z0-9-]+\.sql')*$/, what:'comma-prefixed migration file names in single quotes', verb:'appends',
        numbers:text => (text.match(/'[^']*'/g) || []).map(item => Number(item.slice(1, 5))) },
    versions:{ shape:/^(?:,[1-9]\d*)*$/, what:'comma-prefixed version numbers', verb:'appends',
        numbers:text => text.split(',').slice(1).map(Number) },
    highest:{ shape:/^[1-9]\d*$/, what:'a single version number', verb:'holds the version',
        numbers:text => [Number(text)] },
});
function kindOf(entry) {
    const rule = DC01_RULES.find(r => r.file === entry.file && r.line === entry.line);
    if (!rule) throw new Error(`manifest DC-01 entry ${entry.file}:${entry.line} is not one of the seven OP-06 lines`);
    return rule.kind;
}
const dc01Entries = file => manifest.dc01.filter(entry => entry.file === file).map(entry => ({ ...entry, kind:kindOf(entry) }));
const firstDifference = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

// Where the permitted change sits in the baseline text: [start, end) is replaced; an empty span is an insertion.
function permittedSpan(kind, baseline) {
    const once = needle => { const at = baseline.indexOf(needle); return at !== -1 && baseline.indexOf(needle, at + 1) === -1 ? at : -1; };
    if (kind === 'names') {
        const at = once(`${LAST_NAME}]`);
        const list = at === -1 ? -1 : baseline.lastIndexOf(LIST_START, at);
        if (list !== -1 && !baseline.slice(list + LIST_START.length, at).includes(']')) return { start:at + LAST_NAME.length, end:at + LAST_NAME.length };
    } else if (kind === 'versions') {
        const at = once(VERSION_LIST);
        if (at !== -1) return { start:at + VERSION_LIST.length - 1, end:at + VERSION_LIST.length - 1 };
    } else if (kind === 'highest') {
        const numbers = [...baseline.matchAll(/\d+/g)];
        if (numbers.length === 1 && numbers[0][0] === String(LAST_PUBLISHED.version)) return { start:numbers[0].index, end:numbers[0].index + numbers[0][0].length };
    }
    throw new Error(`the DC-01 baseline text does not hold the expected ${kind} literal`);
}
// The exact text OP-06 permits at the span for the migrations after 0007 (ascending { version, name } list).
function permittedChange(kind, later) {
    if (kind === 'names') return later.map(m => `,'${m.name}'`).join('');
    if (kind === 'versions') return later.map(m => `,${m.version}`).join('');
    return String(later.length ? later[later.length - 1].version : LAST_PUBLISHED.version);
}
// { text } holds the baseline text when `current` differs from it only by the permitted change for `later`;
// otherwise { error } describes the difference.
function undoPermittedChange(entry, current, later) {
    const baseline = entry.text;
    const { start, end } = permittedSpan(entry.kind, baseline);
    const head = baseline.slice(0, start);
    const tail = baseline.slice(end);
    if (current.length < head.length + tail.length || !current.startsWith(head) || !current.endsWith(tail)) {
        return { error:`differs from the d7cd40a text at column ${firstDifference(baseline, current) + 1}, outside the change OP-06 permits` };
    }
    const changed = current.slice(head.length, current.length - tail.length);
    const kind = KINDS[entry.kind];
    if (!kind.shape.test(changed)) return { error:`${kind.verb} ${JSON.stringify(changed)}, but OP-06 permits only ${kind.what} there` };
    const versions = kind.numbers(changed);
    const floor = LAST_PUBLISHED.version;
    const ascending = entry.kind === 'highest' ? versions[0] >= floor : versions.every((v, i) => v > (i ? versions[i - 1] : floor));
    if (!ascending) return { error:`${kind.verb} ${JSON.stringify(changed)}, which is not ascending after version ${floor}` };
    const expected = permittedChange(entry.kind, later);
    if (changed !== expected) {
        return { error:`${kind.verb} ${JSON.stringify(changed)}, but the migrations after ${LAST_PUBLISHED.name} in server/database/migrations require ${JSON.stringify(expected)}` };
    }
    return { text:baseline };
}
// Problems of one manifest file; `entries` are its DC-01 entries and `later` the migrations after 0007. A problem
// on a DC-01 line names file and line. The manifest holds whole-file digests only, so a difference on any other
// line names the file and says so; G5b on the host shows that line.
function checkBaselineFile({ file, text, digest, entries, later }) {
    const lines = text.split('\n');
    const restored = lines.slice();
    const problems = [];
    for (const entry of entries) {
        const index = entry.line - 1;
        if (index >= lines.length) {
            problems.push(`${file}:${entry.line}: the DC-01 line is missing; the file has ${lines.length} lines`);
            continue;
        }
        const result = undoPermittedChange(entry, lines[index], later);
        if (result.error) {
            const moved = lines.findIndex((other, at) => at !== index && undoPermittedChange(entry, other, later).text !== undefined);
            const hint = moved === -1 ? '' : `; the DC-01 assertion is now on line ${moved + 1}, so lines were added or removed before it`;
            problems.push(`${file}:${entry.line}: ${result.error}${hint}`);
        }
        restored[index] = entry.text;
    }
    const restoredDigest = sha256(restored.join('\n'));
    if (restoredDigest !== digest && restoredDigest !== MESSAGING_CHECKPOINT_DIGESTS[file]) {
        const where = entries.length ? `a line other than DC-01 line ${entries.map(e => e.line).join(' and ')}` : 'a line';
        problems.push(`${file}: ${where} differs from the d7cd40a manifest digest (the file now has ${lines.length} lines; the manifest holds whole-file digests, G5b shows the line)`);
    }
    return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Skip markers of command G5a, built from fragments so that this file does not match itself. Matching ignores
// case, as Select-String does, and allows white space between the fragments.
// ---------------------------------------------------------------------------------------------------------------
const MARKERS = Object.freeze([['.', 'skip', '('], ['.', 'todo', '('], ['.', 'only', '('], ['skip', ':'], ['todo', ':']].map(parts => ({
    parts,
    label:parts.join(''),
    pattern:new RegExp(parts.map(part => part.replace(/[.(]/g, c => `\\${c}`)).join('\\s*'), 'i'),
})));
const SCRIPT = /\.[cm]?[jt]s$/;
function markerHits(file, text) {
    const hits = [];
    text.split('\n').forEach((line, index) => {
        for (const { label, pattern } of MARKERS) if (pattern.test(line)) hits.push(`${file}:${index + 1}: skip marker ${label}`);
    });
    return hits;
}
function scriptFiles(directory, prefix = '') {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes:true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) found.push(...scriptFiles(path.join(directory, entry.name), `${relative}/`));
        else if (entry.isFile() && SCRIPT.test(entry.name)) found.push(relative);
    }
    return found;
}

// ---------------------------------------------------------------------------------------------------------------
// Guards on the real files.
// ---------------------------------------------------------------------------------------------------------------
// Feature: db5-db6-canonical-integration, Property P-29: Published migrations are immutable (checksum clauses)
// **Validates: Requirements DB5-R14.2, DB5-R15.11**
test('P-29 published migrations 0001 to 0007 keep the pinned SHA-256, the runner records it, and a single-byte change of an applied copy is refused without change', t => {
    const directory = temporary(t);
    const originals = PUBLISHED.map(({ name, sha256:pinned }) => {
        const bytes = fs.readFileSync(path.join(MIGRATIONS, name));
        assert.equal(sha256(lfText(bytes)), pinned, `${name} keeps its d7cd40a checksum`);
        fs.writeFileSync(path.join(directory, name), bytes);
        return { name, bytes };
    });
    const ledger = PUBLISHED.map(({ version, name, sha256:checksum }) => ({ version, name, checksum }));
    assert.deepEqual(loadMigrations().slice(0, PUBLISHED.length).map(({ version, name, checksum }) => ({ version, name, checksum })), ledger);
    const { db } = fixture(t, { migrate:false });
    assert.deepEqual(migrate(db, { directory }), { version:LAST_PUBLISHED.version, applied:PUBLISHED.map(m => m.name) });
    assert.deepEqual(db.prepare('SELECT version, name, checksum FROM SchemaMigrations ORDER BY version').all(), ledger);
    db.prepare('INSERT INTO Users(user_id,username,display_name) VALUES(?,?,?)').run('p29-user', 'p29-user', 'P-29 user');
    const before = snapshot(db);

    const seed = integerSetting('PROPERTY_SEED', P29_DEFAULT_SEED);
    const only = integerSetting('PROPERTY_RUN', null);
    const runs = only === null ? Array.from({ length:P29_RUNS }, (_, run) => run) : [only];
    for (const run of runs) {
        const runSeed = runSeedOf(seed, run);
        const original = originals[run % originals.length];
        const mutation = mutateOneByte(createRandom(runSeed), original.bytes);
        const label = `property=P-29 seed=${seed} run=${run} runSeed=${runSeed} file=${original.name} offset=${mutation.offset} byte=${mutation.from}->${mutation.to}`;
        const target = path.join(directory, original.name);
        fs.writeFileSync(target, mutation.bytes);
        try {
            assert.throws(() => migrate(db, { directory }), { code:'MIGRATION_HISTORY_MISMATCH' });
            assert.deepEqual(snapshot(db), before);
        } catch (error) {
            throw new Error(`${label}\n${error.message}`, { cause:error });
        } finally {
            fs.writeFileSync(target, original.bytes);
        }
    }
    // The unchanged copies are accepted again, so each refusal above came from the mutated byte.
    assert.deepEqual(migrate(db, { directory }), { version:LAST_PUBLISHED.version, applied:[] });
    assert.deepEqual(snapshot(db), before);
});

test('the manifest is the T-5B-03 recording of d7cd40a: 29 test files, 6 support files and the seven DC-01 lines', () => {
    assert.equal(sha256(manifestText), MANIFEST_SHA256, 'the manifest is unchanged since T-5B-03');
    assert.equal(manifest.baseline, BASELINE);
    assert.equal(manifest.root, 'DATA/tests');
    assert.deepEqual(manifest.counts, { tests:29, support:6, dc01:7 });
    const tests = Object.keys(manifest.tests);
    const support = Object.keys(manifest.support);
    assert.equal(tests.length, 29);
    assert.equal(support.length, 6);
    assert.ok(tests.every(file => /^[a-z0-9-]+\.test\.js$/.test(file)), 'test files sit directly in tests/');
    assert.ok(support.every(file => /^support\/[a-z0-9-]+\.c?js$/.test(file)), 'support files sit in tests/support/');
    assert.ok(manifestFiles().every(([, digest]) => /^[0-9a-f]{64}$/.test(digest)), 'every digest is SHA-256 hex');
    assert.deepEqual(manifest.dc01.map(({ file, line }) => ({ file, line })), DC01_RULES.map(({ file, line }) => ({ file, line })));
    for (const entry of manifest.dc01) {
        assert.ok(tests.includes(entry.file), `${entry.file} is a manifest test file`);
        assert.doesNotThrow(() => permittedSpan(kindOf(entry), entry.text), `${entry.file}:${entry.line} holds its ledger literal`);
    }
});

test('baseline test and support files hash to the manifest once the permitted DC-01 change is undone', () => {
    const later = laterMigrations();
    const problems = [];
    let checked = 0;
    for (const [file, digest] of manifestFiles()) {
        const full = path.join(TESTS_ROOT, ...file.split('/'));
        if (!fs.existsSync(full)) {
            problems.push(`${file}: missing; a baseline file is never deleted or renamed`);
            continue;
        }
        problems.push(...checkBaselineFile({ file, text:readText(full), digest, entries:dc01Entries(file), later }));
        checked++;
    }
    assert.deepEqual(problems, []);
    assert.equal(checked, 35);
});

test('script files under tests/ that the manifest does not list carry no skip marker', () => {
    const listed = new Set(manifestFiles().map(([file]) => file));
    const scanned = scriptFiles(TESTS_ROOT).filter(file => !listed.has(file));
    assert.ok(scanned.includes(path.basename(__filename)), 'this guard scans its own file');
    const hits = scanned.flatMap(file => markerHits(file, readText(path.join(TESTS_ROOT, ...file.split('/')))));
    assert.deepEqual(hits, []);
});

test('messaging checkpoint exceptions stay exact and reject an additional fixture edit', () => {
    const later = laterMigrations();
    for (const file of Object.keys(MESSAGING_CHECKPOINT_DIGESTS)) {
        const text = readText(path.join(TESTS_ROOT, ...file.split('/'))), digest = [...manifestFiles()].find(([name]) => name === file)[1];
        const input = { file, text, digest, entries:dc01Entries(file), later };
        assert.deepEqual(checkBaselineFile(input), []);
        assert.ok(checkBaselineFile({ ...input, text:text+'\n// unexpected fixture change\n' }).length > 0);
    }
});

// ---------------------------------------------------------------------------------------------------------------
// Self-tests of the guard logic on in-memory files: filler lines around the manifest's baseline DC-01 text.
// The expected edits are written by hand with String.replace, independently of permittedSpan.
// ---------------------------------------------------------------------------------------------------------------
const M8 = Object.freeze([{ version:8, name:'0008-example.sql' }]);
const M9 = Object.freeze([...M8, { version:9, name:'0009-attachment-lifecycle.sql' }]);
const DC01_FILES = [...new Set(DC01_RULES.map(rule => rule.file))];
function synthetic(file) {
    const entries = dc01Entries(file);
    const lines = Array.from({ length:Math.max(...entries.map(e => e.line)) + 2 }, (_, i) => `    assert.equal(synthetic(${i + 1}),true);`);
    for (const entry of entries) lines[entry.line - 1] = entry.text;
    return { file, entries, lines, digest:sha256(lines.join('\n')) };
}
const check = (base, lines, later) => checkBaselineFile({ file:base.file, text:lines.join('\n'), digest:base.digest, entries:base.entries, later });
function edit(base, changes) {
    const lines = base.lines.slice();
    for (const [line, text] of Object.entries(changes)) lines[Number(line) - 1] = text;
    return lines;
}
function byHand(entry, later) {
    if (entry.kind === 'versions') return entry.text.replace('6,7]', `6,7${later.map(m => `,${m.version}`).join('')}]`);
    if (entry.kind === 'highest') return entry.text.replace('.v,7)', `.v,${later[later.length - 1].version})`);
    return entry.text.replace("'0007-recipient-keys.sql']", `'0007-recipient-keys.sql'${later.map(m => `,'${m.name}'`).join('')}]`);
}
const updated = (base, later) => edit(base, Object.fromEntries(base.entries.map(entry => [entry.line, byHand(entry, later)])));
const problemsAt = (problems, file, line) => problems.filter(problem => problem.startsWith(`${file}:${line}: `));

test('DC-01 guard self-test: the baseline passes and a permitted append of later migrations passes', () => {
    for (const file of DC01_FILES) {
        const base = synthetic(file);
        assert.deepEqual(check(base, base.lines, []), [], `${file} unchanged without later migrations`);
        assert.deepEqual(check(base, updated(base, M8), M8), [], `${file} with 0008 appended`);
        assert.deepEqual(check(base, updated(base, M9), M9), [], `${file} with 0008 and 0009 appended`);
    }
    const auth = synthetic('auth-migrations.test.js');
    assert.ok(updated(auth, M9)[23].endsWith("'0007-recipient-keys.sql','0008-example.sql','0009-attachment-lifecycle.sql']);"));
    assert.ok(updated(synthetic('migrations.test.js'), M9)[13].endsWith('[1,2,3,4,5,6,7,8,9]);'));
});

test('DC-01 guard self-test: the permitted replacement of the version literal on e2ee-migrations line 29 passes', () => {
    const base = synthetic('e2ee-migrations.test.js');
    const line12 = later => byHand(base.entries[0], later);
    const line29 = version => base.entries[1].text.replace('.v,7)', `.v,${version})`);
    assert.deepEqual(check(base, edit(base, { 12:line12(M8), 29:line29('8') }), M8), []);
    assert.deepEqual(check(base, edit(base, { 12:line12(M9), 29:line29('9') }), M9), []);
    for (const [version, later] of [['9', M8], ['8', M9], ['8', []], ['08', M8], ['8,9', M9], ['7', M8]]) {
        const problems = check(base, edit(base, { 12:later.length ? line12(later) : base.entries[0].text, 29:line29(version) }), later);
        assert.equal(problemsAt(problems, base.file, 29).length, 1, `line 29 with ${version} and ${later.length} later migrations fails`);
    }
    const changedCheck = line29('8').replace("'foreign_key_check'),[]", "'foreign_key_check'),[1]");
    assert.equal(problemsAt(check(base, edit(base, { 12:line12(M8), 29:changedCheck }), M8), base.file, 29).length, 1);
});

test('DC-01 guard self-test: a changed assertion fails and names the file and line', () => {
    const auth = synthetic('auth-migrations.test.js');
    const negated = auth.entries[0].text.replace('assert.deepEqual(', 'assert.notDeepEqual(');
    const problems = check(auth, edit(auth, { 24:negated }), []);
    assert.equal(problemsAt(problems, 'auth-migrations.test.js', 24).length, 1, problems.join('\n'));
    const ledger = synthetic('migrations.test.js');
    assert.equal(problemsAt(check(ledger, edit(ledger, { 14:ledger.entries[0].text.replace('5,6,7]', '5,7]') }), []), 'migrations.test.js', 14).length, 1);
    const messaging = synthetic('messaging-migrations.test.js');
    const loop = byHand(messaging.entries[0], M8).replace('if(rows.length)', 'if(false)');
    assert.equal(problemsAt(check(messaging, edit(messaging, { 11:loop }), M8), 'messaging-migrations.test.js', 11).length, 1);
    const other = check(auth, edit(auth, { 1:auth.lines[0].replace(',true)', ',false)') }), []);
    assert.deepEqual(other.map(problem => problem.split(':')[0]), ['auth-migrations.test.js']);
    assert.match(other[0], /a line other than DC-01 line 24 differs/);
});

test('DC-01 guard self-test: an extra line fails', () => {
    const auth = synthetic('auth-migrations.test.js');
    const before = auth.lines.slice();
    before.splice(10, 0, '    assert.ok(true);');
    const shifted = check(auth, before, []);
    assert.equal(problemsAt(shifted, 'auth-migrations.test.js', 24).length, 1, shifted.join('\n'));
    assert.match(problemsAt(shifted, 'auth-migrations.test.js', 24)[0], /now on line 25/);
    const after = [...auth.lines, '    assert.ok(true);'];
    assert.deepEqual(check(auth, after, []).map(problem => problem.split(':')[0]), ['auth-migrations.test.js']);
    const split = synthetic('e2ee-migrations.test.js');
    const joined = edit(split, { 12:split.entries[0].text.replace(';assert.equal(', ';\n    assert.equal(') });
    assert.ok(check(split, joined.join('\n').split('\n'), []).length > 0, 'a split DC-01 line fails');
});

test('DC-01 guard self-test: an edit that does not match the existing migrations fails', () => {
    const auth = synthetic('auth-migrations.test.js');
    const entry = auth.entries[0];
    const cases = [
        ['an append without a new migration file', byHand(entry, M8), []],
        ['no append although 0008 exists', entry.text, M8],
        ['an append in descending order', entry.text.replace("'0007-recipient-keys.sql']", "'0007-recipient-keys.sql','0009-attachment-lifecycle.sql','0008-example.sql']"), M9],
        ['a different file name', entry.text.replace("'0007-recipient-keys.sql']", "'0007-recipient-keys.sql','0008-other.sql']"), M8],
        ['a space after the comma', entry.text.replace("'0007-recipient-keys.sql']", "'0007-recipient-keys.sql', '0008-example.sql']"), M8],
        ['a name inserted before the last element', entry.text.replace("'0007-recipient-keys.sql']", "'0008-example.sql','0007-recipient-keys.sql']"), M8],
        ['a repeated name', entry.text.replace("'0007-recipient-keys.sql']", "'0007-recipient-keys.sql','0008-example.sql','0008-example.sql']"), M8],
    ];
    for (const [label, text, later] of cases) {
        assert.equal(problemsAt(check(auth, edit(auth, { 24:text }), later), 'auth-migrations.test.js', 24).length, 1, label);
    }
    const ledger = synthetic('migrations.test.js');
    const named = ledger.entries[0].text.replace('6,7]', "6,7,'0008-example.sql']");
    assert.equal(problemsAt(check(ledger, edit(ledger, { 14:named }), M8), 'migrations.test.js', 14).length, 1, 'a name in the version list');
});

test('skip-marker self-test: each marker fails with file and line, and plain words in a title pass', () => {
    for (const { parts, label } of MARKERS) {
        const line = parts[0] === '.' ? `test${label}'case', () => {});` : `test('case', { ${label} true }, () => {});`;
        assert.deepEqual(markerHits('new.test.js', `const value = 1;\n${line}\n`), [`new.test.js:2: skip marker ${label}`]);
        assert.equal(markerHits('new.test.js', `test${parts.join(' ').toUpperCase()}`).length, 1, `${label} in upper case with spaces`);
    }
    assert.deepEqual(markerHits('new.test.js', "test('does not skip, todo or only anything', () => {});\n"), []);
});
