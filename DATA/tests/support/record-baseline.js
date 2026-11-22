// Test-support recorder (T-5B-03, T-5B-04). Run by hand from DATA/: node tests/support/record-baseline.js
// Writes, from the functional baseline d7cd40a, tests/fixtures/baseline-d7cd40a.json (T-5B-03, built from git
// objects only) and tests/fixtures/direct-baseline-d7cd40a.json (T-5B-04, the masked answers of the direct-message
// scenarios below). An existing fixture is never replaced: a rerun may only confirm it.
// Never imported by application code. The manifest part opens no database and starts no process other than git.
// The direct-message scenarios use the baseline helpers (support/auth.js, social.js, messaging.js, e2ee.js): each
// opens one temporary database under os.tmpdir() and serves the real createApp on loopback with an injected clock
// and limiter. tests/dm-fixtures-replay.test.js runs the same scenarios against the current code.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const BASELINE = 'd7cd40aafcf8f432d17d3f4a85abb26d19fa9bc3';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const TESTS = 'DATA/tests';
const GUARDED_PATHS = ['DATA', 'server/src', 'shared', 'client/src'];
const OUTPUT = path.join(__dirname, '..', 'fixtures', 'baseline-d7cd40a.json');
// DC-01 (OP-06): the seven migration-ledger assertions that may change when a migration is added.
// `marker` is the ledger literal the line must hold at the baseline; it is checked, not recorded.
const DC01_LINES = [
    { file:'auth-migrations.test.js', line:24, marker:"'0007-recipient-keys.sql']" },
    { file:'conversations-migrations.test.js', line:21, marker:"'0007-recipient-keys.sql']" },
    { file:'e2ee-migrations.test.js', line:12, marker:"applied,['0007-recipient-keys.sql']" },
    { file:'e2ee-migrations.test.js', line:29, marker:"max(version) v FROM SchemaMigrations').get().v,7)" },
    { file:'messaging-migrations.test.js', line:11, marker:"'0007-recipient-keys.sql']" },
    { file:'migrations.test.js', line:14, marker:'[1,2,3,4,5,6,7]' },
    { file:'social-migrations.test.js', line:25, marker:"'0007-recipient-keys.sql']" },
];

class Refusal extends Error {}

function git(args, options = {}) {
    const result = spawnSync('git', args, { cwd:ROOT, windowsHide:true, maxBuffer:64 * 1024 * 1024, ...options });
    if (result.error) throw new Refusal(`git could not run: ${result.error.message}`);
    return result;
}
function gitOutput(args) {
    const result = git(args);
    if (result.status !== 0) throw new Refusal(`git ${args[0]} failed with status ${result.status}: ${String(result.stderr).trim()}`);
    return result.stdout;
}
// Same normalisation as the migration runner (server/database/migrate.js): UTF-8 text, CRLF -> LF.
const lfText = buffer => buffer.toString('utf8').replace(/\r\n/g, '\n');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function guard() {
    const resolved = String(gitOutput(['rev-parse', '--verify', '--quiet', `${BASELINE}^{commit}`])).trim();
    if (resolved !== BASELINE) throw new Refusal(`baseline ${BASELINE} is not a commit of this repository`);
    const diff = git(['diff', '--quiet', BASELINE, 'HEAD', '--', ...GUARDED_PATHS]);
    if (diff.status === 1) throw new Refusal(`HEAD differs from ${BASELINE} in ${GUARDED_PATHS.join(' ')}; nothing was written`);
    if (diff.status !== 0) throw new Refusal(`git diff failed with status ${diff.status}: ${String(diff.stderr).trim()}`);
}

function buildManifest() {
    const listed = String(gitOutput(['ls-tree', '-r', '--name-only', '-z', BASELINE, '--', TESTS])).split('\0').filter(Boolean);
    const tests = {};
    const support = {};
    const texts = new Map();
    for (const full of listed.sort(byName)) {
        if (!full.startsWith(`${TESTS}/`)) throw new Refusal(`unexpected path from git ls-tree: ${full}`);
        const relative = full.slice(TESTS.length + 1);
        const text = lfText(gitOutput(['show', `${BASELINE}:${full}`]));
        texts.set(relative, text);
        (relative.startsWith('support/') ? support : tests)[relative] = sha256(text);
    }
    const dc01 = DC01_LINES.map(({ file, line, marker }) => {
        const text = texts.get(file);
        if (text === undefined) throw new Refusal(`DC-01 file ${file} is not in the baseline`);
        const baselineText = text.split('\n')[line - 1];
        if (baselineText === undefined || baselineText.split(marker).length !== 2 || !/\bassert\.(deepEqual|equal)\(/.test(baselineText)) {
            throw new Refusal(`DC-01 ${file} line ${line} is not the expected migration-ledger assertion`);
        }
        return { file, line, text:baselineText };
    });
    return {
        baseline:BASELINE,
        root:TESTS,
        source:'git show <baseline>:<root>/<file>',
        normalisation:'UTF-8 text with every CRLF replaced by LF',
        digest:'sha256 hex of the normalised text',
        counts:{ tests:Object.keys(tests).length, support:Object.keys(support).length, dc01:dc01.length },
        tests,
        support,
        dc01,
    };
}

// Two-space JSON, LF line endings, trailing newline, ASCII only (any non-ASCII character escaped).
const asciiOnly = json => json.replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
function serialise(manifest) {
    const json = asciiOnly(JSON.stringify(manifest, null, 2));
    return `${json}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// T-5B-04: direct-message fixtures (ARCH-R02.3, ARCH-R02.4, DB5-R15.4).
// ---------------------------------------------------------------------------------------------------------------
const DIRECT_OUTPUT = path.join(__dirname, '..', 'fixtures', 'direct-baseline-d7cd40a.json');
const DIRECT_FAMILIES = Object.freeze(['conversations', 'send', 'history', 'receipts', 'lifecycle', 'keys']);
// The direct-message scenarios execute the working tree, so the executed code must equal the baseline as well.
// The database files tracked under DATA/server/database are excluded from the comparison and never read.
const EXECUTED_PATHS = ['DATA/server', 'DATA/server.js', 'DATA/package.json', 'DATA/package-lock.json', 'DATA/tests/support',
    'server/src', 'server/test/e2ee/support', 'shared', 'client/src'];
const NEVER_READ = ['database.sqlite', 'database.sqlite-shm', 'database.sqlite-wal'].map(name => `:(exclude)DATA/server/database/${name}`);
const RECORDER = 'DATA/tests/support/record-baseline.js';
const CLOCK = Object.freeze({ start:'2026-01-01T00:00:00.000Z', stepMs:1000 });
const LIMITER = 'allows every bucket, except that a scenario may arm one refusal for a bucket key prefix; the armed refusal answers retryAfterSeconds 42 and disarms';
const RETRY_AFTER_SECONDS = 42;
const STALE_MS = 600000; // twice the 300 s freshness window of device registrations and epoch publications
const FOREIGN_ORIGIN = 'http://foreign.example.test';
const GROUP_ID = 'fixture-group-conversation';
const UNKNOWN_CONVERSATION = 'fixture-unknown-conversation';
const UNKNOWN_MESSAGE = 'fixture-unknown-message';
const ZERO_KEY_ID = Buffer.alloc(16).toString('base64url');
const ZERO_IV = Buffer.alloc(12).toString('base64');
const DISPLAY = Object.freeze({ alice:'Alice', bob:'Bob', carol:'Carol' });
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const OPAQUE_FIELDS = Object.freeze(['agreementPublicKey', 'ciphertext', 'cursor', 'enc', 'iv', 'nextCursor', 'signature', 'signingPublicKey']);
const UNORDERED_FIELDS = Object.freeze(['devices', 'participantIds', 'participants', 'wraps']);
// Shapes of random values that must never reach the fixture: UUIDs and 16- or 32-byte base64url identifiers.
// Constant-style names such as the error code UNSUPPORTED_MEDIA_TYPE are not random values.
const RANDOM_SHAPES = [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /^[A-Za-z0-9_-]{22}$/, /^[A-Za-z0-9_-]{43}$/];
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
const randomLooking = value => !CONSTANT_NAME.test(value) && RANDOM_SHAPES.some(shape => shape.test(value));
const MASKING = Object.freeze([
    'A string equal to a value that the scenario registered when it created or received it is replaced by its label: user ids <user:name>, the direct conversation id <conversation:alice-bob>, message storage ids <storage:name>, device ids <device:name>, device key ids <device-key:name>, public keys <agreement-key:name> and <signing-key:name>, epoch key ids <key:name>, the iv and ciphertext of each submitted envelope <iv:name> and <ciphertext:name>, and history cursors <cursor:name>.',
    'Any other string in ISO 8601 date-time form is replaced by <timestamp>.',
    'Any other string under the key agreementPublicKey, ciphertext, cursor, enc, iv, nextCursor, signature or signingPublicKey is replaced by that key in angle brackets, for example <signature>.',
    'Request paths are masked per path segment and per query value with the same labels; a cursor query value without a label becomes <cursor>.',
    'Object keys are sorted. Arrays under devices, participantIds, participants and wraps, which d7cd40a orders by random identifiers, are sorted by their masked JSON text; every other array keeps its order.',
    'Numbers, booleans, null and every other string are kept unchanged.',
]);

function fixtureClock() {
    let ms = Date.parse(CLOCK.start);
    return { now:() => ms, tick() { ms += CLOCK.stepMs; }, iso:(offset = 0) => new Date(ms + offset).toISOString() };
}
function fixtureLimiter() {
    let armed = null;
    return {
        arm(prefix) { armed = prefix; },
        consume(buckets) {
            if (armed !== null && buckets.some(bucket => bucket.key.startsWith(armed))) {
                armed = null;
                return { allowed:false, retryAfterSeconds:RETRY_AFTER_SECONDS };
            }
            return { allowed:true };
        },
    };
}
function expectStatus(response, status, step) {
    if (response.status !== status) throw new Error(`fixture setup step "${step}" answered ${response.status}, expected ${status}`);
    return response;
}
// The same group row as conversations-http.test.js: a Group_Conversation with Alice as owner and Bob as member.
function groupRow(f) {
    const repositories = f.application.conversations.repositories;
    repositories.conversations.create({ conversation_id:GROUP_ID, kind:'group', title:'Fixture group', created_by:f.alice.id, origin:'authenticated' });
    repositories.members.insert({ conversation_id:GROUP_ID, user_id:f.bob.id });
}

class DirectRecorder {
    constructor(scenario, prefix, f, clock, expected) {
        this.scenario = scenario;
        this.prefix = prefix;
        this.f = f;
        this.clock = clock;
        this.expected = expected;
        this.labels = new Map();
        this.entries = [];
    }
    label(value, label) {
        if (typeof value !== 'string' || !value) throw new TypeError(`${this.prefix}: ${label} has no value to register`);
        const known = this.labels.get(value);
        if (known !== undefined && known !== label) throw new Error(`${this.prefix}: ${label} has the value of ${known}`);
        for (const [other, name] of this.labels) if (name === label && other !== value) throw new Error(`${this.prefix}: ${label} is registered twice`);
        this.labels.set(value, label);
        return value;
    }
    users() {
        for (const name of Object.keys(DISPLAY)) this.label(this.f[name].id, `<user:${name}>`);
    }
    envelope(name, envelope) {
        this.label(envelope.encryption.iv, `<iv:${name}>`);
        this.label(envelope.encryption.ciphertext, `<ciphertext:${name}>`);
        return envelope;
    }
    device(name, device) {
        this.label(device.deviceId, `<device:${name}>`);
        this.label(device.deviceKeyId, `<device-key:${name}>`);
        this.label(device.agreementPublicKey, `<agreement-key:${name}>`);
        this.label(device.signingPublicKey, `<signing-key:${name}>`);
        return device;
    }
    mask(value, key) {
        if (Array.isArray(value)) {
            const items = value.map(item => this.mask(item, key));
            return UNORDERED_FIELDS.includes(key) ? items.sort((a, b) => byName(JSON.stringify(a), JSON.stringify(b))) : items;
        }
        if (value !== null && typeof value === 'object') {
            const masked = {};
            for (const name of Object.keys(value).sort(byName)) masked[name] = this.mask(value[name], name);
            return masked;
        }
        if (typeof value !== 'string') return value;
        if (this.labels.has(value)) return this.labels.get(value);
        if (TIMESTAMP.test(value)) return '<timestamp>';
        if (OPAQUE_FIELDS.includes(key)) return `<${key}>`;
        return value;
    }
    maskPath(url) {
        const [pathname, search] = url.split('?');
        const masked = pathname.split('/').map(part => this.labels.get(part) ?? part).join('/');
        if (search === undefined) return masked;
        const query = search.split('&').map(pair => {
            const [name, value = ''] = pair.split('=');
            return `${name}=${this.labels.get(value) ?? (name === 'cursor' ? '<cursor>' : value)}`;
        });
        return `${masked}?${query.join('&')}`;
    }
    // Fails when a registered value or a value of a random shape would reach the fixture.
    check(entry) {
        const text = JSON.stringify(entry);
        for (const [raw, label] of this.labels) if (raw.length >= 12 && text.includes(raw)) throw new Error(`${entry.id}: ${label} is not masked`);
        const visit = value => {
            if (Array.isArray(value)) return value.forEach(visit);
            if (value !== null && typeof value === 'object') return Object.values(value).forEach(visit);
            if (typeof value === 'string' && randomLooking(value)) throw new Error(`${entry.id}: an unregistered random value is not masked`);
            return undefined;
        };
        visit(entry);
    }
    async call(family, name, actor, { method = 'GET', path:url, body, rawBody, csrf = true, origin, contentType } = {}, learn) {
        if (!DIRECT_FAMILIES.includes(family)) throw new TypeError(`unknown route family ${family}`);
        this.clock.tick();
        const mutation = !['GET', 'HEAD'].includes(method);
        const headers = {};
        if (mutation && csrf && actor !== 'anonymous') headers['X-CSRF-Token'] = this.f[actor].token;
        if (contentType) headers['Content-Type'] = contentType;
        let browser = actor === 'anonymous' ? this.f.browser() : this.f[actor].browser;
        if (origin === 'foreign') {
            browser = browser.clone();
            browser.sourceOrigin = FOREIGN_ORIGIN;
        }
        const response = await browser.request(url, { method, body, rawBody, headers });
        if (learn && response.status < 300) {
            // During a replay a changed answer is reported by the comparison below, not by the learn step.
            try { learn(response.body); } catch (error) { if (!this.expected) throw error; }
        }
        const request = { actor, method, path:this.maskPath(url) };
        if (mutation) request.csrf = 'X-CSRF-Token' in headers;
        if (origin) request.origin = origin;
        if (contentType) request.contentType = contentType;
        if (body !== undefined) request.body = this.mask(body, 'body');
        if (rawBody !== undefined) request.rawBody = rawBody;
        const entry = { scenario:this.scenario, id:`${this.prefix}.${family}.${name}`, family, request, status:response.status,
            code:typeof response.body?.code === 'string' ? response.body.code : null, body:this.mask(response.body, 'body') };
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null) entry.retryAfter = retryAfter;
        this.check(entry);
        if (this.expected) {
            const index = this.entries.length;
            assert.deepStrictEqual(entry, this.expected[index], `${entry.id} (entry ${index + 1} of ${this.scenario}) differs from the d7cd40a recording`);
        }
        this.entries.push(entry);
        return response;
    }
}

// Version 1 envelopes through the composition of support/messaging.js (recipientKeyVerifier = fixtureVerifier).
async function directV1(t, { expected, populate } = {}) {
    const { messagingFixture, encrypted } = require('./messaging');
    const { befriend, mutate } = require('./social');
    const clock = fixtureClock();
    const limiter = fixtureLimiter();
    const f = await messagingFixture(t, { now:clock.now, limiter });
    const r = new DirectRecorder('v1-fixture-verifier', 'v1', f, clock, expected);
    const dm = f.conversationId;
    r.users();
    r.label(dm, '<conversation:alice-bob>');
    groupRow(f);
    if (populate) await populate(f, { conversationId:dm }); // T-5B-31 isolated population, before recorded requests
    const ids = {};
    let cursor = null;
    const v1 = async (name, { sender = 'alice', id = `dm-v1-${name}`, conversationId = dm, displayName = DISPLAY[sender] } = {}) =>
        r.envelope(name, (await encrypted({ ...f[sender], displayName }, conversationId, id)).envelope);
    const stored = name => body => { ids[name] = r.label(body.message.storageId, `<storage:${name}>`); };
    const messages = id => `/api/conversations/${id}/messages`;
    const item = name => `/api/messages/${ids[name]}`;
    const read = name => `${item(name)}/read`;
    const post = (url, body, extra = {}) => ({ method:'POST', path:url, body, ...extra });

    await r.call('conversations', 'list', 'alice', { path:'/api/conversations' });
    await r.call('conversations', 'detail', 'bob', { path:`/api/conversations/${dm}` });
    await r.call('conversations', 'detail-group-conversation', 'alice', { path:`/api/conversations/${GROUP_ID}` });
    await r.call('conversations', 'detail-non-participant', 'carol', { path:`/api/conversations/${dm}` });
    await r.call('conversations', 'create-existing', 'bob', post('/api/conversations/dm', { recipientId:f.alice.id }));

    const m1 = await v1('m1');
    await r.call('send', 'created', 'alice', post(messages(dm), m1), stored('m1'));
    await r.call('send', 'duplicate', 'alice', post(messages(dm), m1));
    await r.call('send', 'same-id-changed-envelope', 'alice', post(messages(dm), await v1('m1-changed', { id:m1.id })));
    await r.call('send', 'same-id-other-sender', 'bob', post(messages(dm), await v1('m1-bob', { sender:'bob', id:m1.id })));
    await r.call('send', 'unauthenticated', 'anonymous', post(messages(dm), m1));
    await r.call('send', 'csrf-missing', 'alice', post(messages(dm), m1, { csrf:false }));
    await r.call('send', 'foreign-origin', 'alice', post(messages(dm), m1, { origin:'foreign' }));
    await r.call('send', 'non-participant', 'carol', post(messages(dm), await v1('outsider', { sender:'carol' })));
    await r.call('send', 'sender-id-of-peer', 'alice', post(messages(dm), await v1('spoofed', { sender:'bob', displayName:'Alice' })));
    await r.call('send', 'sender-name-mismatch', 'alice', post(messages(dm), await v1('renamed', { displayName:'Mallory' })));
    const untyped = { ...m1 };
    delete untyped.type;
    await r.call('send', 'envelope-field-missing', 'alice', post(messages(dm), untyped));
    await r.call('send', 'envelope-iv-invalid', 'alice', post(messages(dm), { ...m1, encryption:{ ...m1.encryption, iv:'AAAA' } }));
    await r.call('send', 'envelope-conversation-mismatch', 'alice', post(messages(dm), { ...m1, conversationId:UNKNOWN_CONVERSATION }));
    await r.call('send', 'unknown-conversation', 'alice', post(messages(UNKNOWN_CONVERSATION), await v1('unknown', { conversationId:UNKNOWN_CONVERSATION })));
    await r.call('send', 'group-conversation', 'alice', post(messages(GROUP_ID), await v1('group', { conversationId:GROUP_ID })));
    await r.call('send', 'query-not-allowed', 'alice', post(`${messages(dm)}?debug=1`, m1));
    await r.call('send', 'unsupported-media-type', 'alice', { method:'POST', path:messages(dm), rawBody:'plain text body', contentType:'text/plain' });
    await r.call('send', 'malformed-json', 'alice', { method:'POST', path:messages(dm), rawBody:'{"id":' });
    limiter.arm('messages:submit:');
    await r.call('send', 'rate-limited', 'alice', post(messages(dm), m1));
    const m2 = await v1('m2');
    await r.call('send', 'second-message', 'alice', post(messages(dm), m2), stored('m2'));
    await r.call('send', 'reply', 'bob', post(messages(dm), await v1('m3', { sender:'bob' })), stored('m3'));

    await r.call('history', 'recipient', 'bob', { path:messages(dm) });
    await r.call('history', 'first-page', 'alice', { path:`${messages(dm)}?limit=1` }, body => { cursor = r.label(body.nextCursor, '<cursor:alice-page-1>'); });
    await r.call('history', 'next-page', 'alice', { path:`${messages(dm)}?limit=1&cursor=${cursor}` });
    await r.call('history', 'cursor-of-other-actor', 'bob', { path:`${messages(dm)}?limit=1&cursor=${cursor}` });
    await r.call('history', 'limit-invalid', 'alice', { path:`${messages(dm)}?limit=0` });
    await r.call('history', 'query-not-allowed', 'alice', { path:`${messages(dm)}?userId=${f.bob.id}` });
    await r.call('history', 'unauthenticated', 'anonymous', { path:messages(dm) });
    await r.call('history', 'non-participant', 'carol', { path:messages(dm) });
    await r.call('history', 'unknown-conversation', 'alice', { path:messages(UNKNOWN_CONVERSATION) });
    await r.call('history', 'group-conversation', 'alice', { path:messages(GROUP_ID) });

    await r.call('receipts', 'by-sender', 'alice', post(read('m1')));
    await r.call('receipts', 'non-participant', 'carol', post(read('m1')));
    await r.call('receipts', 'identity-in-body', 'bob', post(read('m1'), { userId:f.alice.id }));
    await r.call('receipts', 'csrf-missing', 'bob', post(read('m1'), undefined, { csrf:false }));
    await r.call('receipts', 'unauthenticated', 'anonymous', post(read('m1')));
    await r.call('receipts', 'created', 'bob', post(read('m1')));
    await r.call('receipts', 'duplicate', 'bob', post(read('m1'), {}));
    await r.call('receipts', 'unknown-message', 'bob', post(`/api/messages/${UNKNOWN_MESSAGE}/read`));
    await r.call('receipts', 'message-id-invalid', 'bob', post('/api/messages/-invalid/read'));
    await r.call('receipts', 'reply-read-by-sender-of-m1', 'alice', post(read('m3')));

    await r.call('lifecycle', 'edit-by-recipient', 'bob', { method:'PATCH', path:item('m1'), body:{} });
    await r.call('lifecycle', 'edit-non-participant', 'carol', { method:'PATCH', path:item('m1'), body:{} });
    await r.call('lifecycle', 'edit-by-sender', 'alice', { method:'PATCH', path:item('m1'), body:{} });
    await r.call('lifecycle', 'delete-by-recipient', 'bob', { method:'DELETE', path:item('m2') });
    await r.call('lifecycle', 'delete-non-participant', 'carol', { method:'DELETE', path:item('m2') });
    await r.call('lifecycle', 'delete-with-body', 'alice', { method:'DELETE', path:item('m2'), body:{ reason:'cleanup' } });
    await r.call('lifecycle', 'delete-unknown', 'alice', { method:'DELETE', path:`/api/messages/${UNKNOWN_MESSAGE}` });
    await r.call('lifecycle', 'delete-csrf-missing', 'alice', { method:'DELETE', path:item('m2'), csrf:false });
    await r.call('lifecycle', 'delete-by-sender', 'alice', { method:'DELETE', path:item('m2') });
    await r.call('lifecycle', 'delete-repeated', 'alice', { method:'DELETE', path:item('m2') });
    await r.call('receipts', 'deleted-without-receipt', 'bob', post(read('m2')));
    await r.call('send', 'resend-after-delete', 'alice', post(messages(dm), m2));
    await r.call('history', 'with-tombstone', 'bob', { path:messages(dm) });
    await r.call('lifecycle', 'delete-read-message', 'alice', { method:'DELETE', path:item('m1') });
    await r.call('receipts', 'deleted-with-receipt', 'bob', post(read('m1')));
    await r.call('lifecycle', 'legacy-list', 'alice', { path:'/api/messages' });
    await r.call('lifecycle', 'legacy-item', 'alice', { path:item('m3') });
    await r.call('lifecycle', 'legacy-send', 'alice', post('/api/messages', {}));
    await r.call('lifecycle', 'legacy-send-unauthenticated', 'anonymous', post('/api/messages', {}));

    expectStatus(await mutate(f.alice, 'DELETE', `/api/friends/${f.bob.id}`), 204, 'unfriend');
    await r.call('conversations', 'detail-after-unfriend', 'bob', { path:`/api/conversations/${dm}` });
    await r.call('send', 'after-unfriend', 'alice', post(messages(dm), await v1('m4')));
    await r.call('history', 'after-unfriend', 'bob', { path:messages(dm) });
    await r.call('receipts', 'after-unfriend', 'alice', post(read('m3')));
    await r.call('lifecycle', 'delete-after-unfriend', 'bob', { method:'DELETE', path:item('m3') });
    await befriend(f.alice, f.bob);
    expectStatus(await mutate(f.bob, 'POST', '/api/blocks', { userId:f.alice.id }), 204, 'block');
    await r.call('conversations', 'list-after-block', 'alice', { path:'/api/conversations' });
    await r.call('conversations', 'detail-after-block', 'alice', { path:`/api/conversations/${dm}` });
    await r.call('send', 'after-block', 'alice', post(messages(dm), await v1('m5')));
    await r.call('history', 'after-block', 'bob', { path:messages(dm) });
    await r.call('receipts', 'after-block', 'bob', post(read('m1')));
    await r.call('lifecycle', 'delete-after-block', 'bob', { method:'DELETE', path:item('m3') });
    await r.call('lifecycle', 'edit-after-block', 'alice', { method:'PATCH', path:item('m2'), body:{} });
    return r.entries;
}

// Device keys, epochs and version 2 envelopes through the real recipient-key verifier of createApp.
async function directV2(t, { expected, populate } = {}) {
    const { socialFixture, befriend, mutate } = require('./social');
    const { encrypted } = require('./messaging');
    const { TestDevice } = require('./e2ee');
    const clock = fixtureClock();
    const limiter = fixtureLimiter();
    const f = await socialFixture(t, { now:clock.now, limiter });
    await befriend(f.alice, f.bob);
    const dm = expectStatus(await mutate(f.alice, 'POST', '/api/conversations/dm', { recipientId:f.bob.id }), 201, 'direct conversation').body.conversation.id;
    const r = new DirectRecorder('v2-key-directory', 'v2', f, clock, expected);
    r.users();
    r.label(dm, '<conversation:alice-bob>');
    r.label(ZERO_KEY_ID, '<key:zero>');
    groupRow(f);
    if (populate) await populate(f, { conversationId:dm }); // T-5B-31 isolated population, before recorded requests
    const ids = {};
    const device = async name => r.device(name, await TestDevice.create(f[name].id));
    const epoch = async (name, number, previous, offset = 0) => {
        const made = await f.alice.device.createEpoch({ conversationId:dm, epoch:number, previousKeyId:previous ? previous.body.keyId : null,
            devices:f.application.keys.repository.active([f.alice.id, f.bob.id]), createdAt:clock.iso(offset) });
        r.label(made.body.keyId, `<key:${name}>`);
        return made;
    };
    const v2 = async (name, made, id = `dm-v2-${name}`) => r.envelope(name, await f.alice.device.encrypt(made.key, made.body.keyId,
        { conversationId:dm, id, senderName:DISPLAY.alice, timestamp:clock.iso() }, `Direct fixture ${name}`));
    const stored = name => body => { ids[name] = r.label(body.message.storageId, `<storage:${name}>`); };
    const keys = id => `/api/conversations/${id}/keys`;
    const epochs = id => `${keys(id)}/epochs`;
    const messages = id => `/api/conversations/${id}/messages`;
    const revoke = name => `/api/keys/devices/${f[name].device.deviceId}/revoke`;
    const post = (url, body, extra = {}) => ({ method:'POST', path:url, body, ...extra });

    await r.call('keys', 'devices-list-empty', 'alice', { path:'/api/keys/devices' });
    await r.call('keys', 'state-without-devices', 'alice', { path:keys(dm) });
    f.alice.device = await device('alice');
    const aliceRegistration = await f.alice.device.registration(clock.iso());
    await r.call('keys', 'device-register', 'alice', post('/api/keys/devices', aliceRegistration));
    await r.call('keys', 'device-register-duplicate', 'alice', post('/api/keys/devices', aliceRegistration));
    await r.call('keys', 'device-register-invalid', 'alice', post('/api/keys/devices', {}));
    await r.call('keys', 'device-register-signed-for-peer', 'alice', post('/api/keys/devices', await f.alice.device.signRegistrationAs(f.bob.id, clock.iso())));
    const carolDevice = await device('carol');
    await r.call('keys', 'device-register-stale', 'carol', post('/api/keys/devices', await carolDevice.registration(clock.iso(-STALE_MS))));
    await r.call('keys', 'device-register-unauthenticated', 'anonymous', post('/api/keys/devices', aliceRegistration));
    await r.call('keys', 'device-register-csrf-missing', 'alice', post('/api/keys/devices', aliceRegistration, { csrf:false }));
    f.bob.device = await device('bob');
    const bobRegistration = await f.bob.device.registration(clock.iso());
    await r.call('keys', 'device-register-peer', 'bob', post('/api/keys/devices', bobRegistration));
    await r.call('keys', 'devices-list', 'alice', { path:'/api/keys/devices' });
    await r.call('keys', 'devices-list-query-not-allowed', 'alice', { path:'/api/keys/devices?limit=1' });
    await r.call('keys', 'devices-list-unauthenticated', 'anonymous', { path:'/api/keys/devices' });
    await r.call('keys', 'state-before-epoch', 'bob', { path:keys(dm) });

    const e1 = await epoch('e1', 1, null);
    await r.call('keys', 'epoch-publish-csrf-missing', 'alice', post(epochs(dm), e1.body, { csrf:false }));
    await r.call('keys', 'epoch-publish-invalid', 'alice', post(epochs(dm), {}));
    await r.call('keys', 'epoch-publish-stale', 'alice', post(epochs(dm), (await epoch('stale', 1, null, -STALE_MS)).body));
    await r.call('keys', 'epoch-publish-out-of-order', 'alice', post(epochs(dm), (await epoch('out-of-order', 2, null)).body));
    await r.call('keys', 'epoch-publish-non-participant', 'carol', post(epochs(dm), e1.body));
    await r.call('keys', 'epoch-publish-group-conversation', 'alice', post(epochs(GROUP_ID), e1.body));
    await r.call('keys', 'epoch-publish', 'alice', post(epochs(dm), e1.body));
    await r.call('keys', 'epoch-publish-duplicate', 'alice', post(epochs(dm), e1.body));
    await r.call('keys', 'epoch-read', 'bob', { path:`${epochs(dm)}/${e1.body.keyId}` });
    await r.call('keys', 'epoch-read-unknown', 'bob', { path:`${epochs(dm)}/${ZERO_KEY_ID}` });
    await r.call('keys', 'epoch-read-key-id-invalid', 'bob', { path:`${epochs(dm)}/not-a-key-id` });
    await r.call('keys', 'epoch-read-non-participant', 'carol', { path:`${epochs(dm)}/${e1.body.keyId}` });
    await r.call('keys', 'state', 'bob', { path:keys(dm) });
    await r.call('keys', 'state-non-participant', 'carol', { path:keys(dm) });
    await r.call('keys', 'state-group-conversation', 'alice', { path:keys(GROUP_ID) });
    await r.call('keys', 'state-unknown-conversation', 'alice', { path:keys(UNKNOWN_CONVERSATION) });
    await r.call('keys', 'state-cursor-invalid', 'alice', { path:`${keys(dm)}?cursor=bad` });
    await r.call('keys', 'state-unauthenticated', 'anonymous', { path:keys(dm) });

    const m1 = await v2('m1', e1);
    await r.call('send', 'created', 'alice', post(messages(dm), m1), stored('m1'));
    await r.call('send', 'duplicate', 'alice', post(messages(dm), m1));
    await r.call('send', 'same-id-changed-iv', 'alice', post(messages(dm), { ...m1, encryption:{ ...m1.encryption, iv:ZERO_IV } }));
    await r.call('send', 'version-1-refused', 'alice', post(messages(dm), r.envelope('legacy', (await encrypted(f.alice, dm, 'dm-v2-legacy')).envelope)));
    await r.call('send', 'unknown-key-id', 'alice', post(messages(dm), { ...m1, id:'dm-v2-unknown-key', encryption:{ ...m1.encryption, keyId:ZERO_KEY_ID } }));
    await r.call('send', 'key-id-malformed', 'alice', post(messages(dm), { ...m1, id:'dm-v2-bad-key', encryption:{ ...m1.encryption, keyId:'bad' } }));
    await r.call('history', 'version-2', 'bob', { path:messages(dm) });
    await r.call('receipts', 'version-2', 'bob', post(`/api/messages/${ids.m1}/read`));
    const e2 = await epoch('e2', 2, e1);
    await r.call('keys', 'epoch-publish-next', 'alice', post(epochs(dm), e2.body));
    await r.call('keys', 'state-two-epochs', 'alice', { path:keys(dm) });
    await r.call('send', 'stale-epoch', 'alice', post(messages(dm), await v2('stale', e1)));
    await r.call('send', 'current-epoch', 'alice', post(messages(dm), await v2('m2', e2)), stored('m2'));
    await r.call('lifecycle', 'delete-version-2', 'alice', { method:'DELETE', path:`/api/messages/${ids.m2}` });
    await r.call('history', 'version-2-with-tombstone', 'bob', { path:messages(dm) });

    await r.call('keys', 'device-revoke-not-owner', 'carol', post(revoke('alice')));
    await r.call('keys', 'device-revoke-with-body', 'bob', post(revoke('bob'), { reason:'lost' }));
    await r.call('keys', 'device-revoke', 'bob', post(revoke('bob')));
    await r.call('keys', 'device-revoke-repeated', 'bob', post(revoke('bob')));
    await r.call('keys', 'device-register-revoked-key', 'bob', post('/api/keys/devices', bobRegistration));
    await r.call('keys', 'state-after-revoke', 'alice', { path:keys(dm) });
    await r.call('send', 'recipient-device-revoked', 'alice', post(messages(dm), await v2('m3', e2)));
    const e3 = await epoch('e3', 3, e2);
    await r.call('keys', 'epoch-publish-recipient-without-devices', 'alice', post(epochs(dm), e3.body));
    limiter.arm('keys:write:');
    await r.call('keys', 'rate-limited', 'alice', post(epochs(dm), e3.body));
    expectStatus(await mutate(f.bob, 'POST', '/api/blocks', { userId:f.alice.id }), 204, 'block');
    await r.call('keys', 'state-after-block', 'alice', { path:keys(dm) });
    await r.call('keys', 'epoch-publish-after-block', 'alice', post(epochs(dm), e3.body));
    await r.call('keys', 'devices-list-after-block', 'alice', { path:'/api/keys/devices' });
    await r.call('send', 'after-block', 'alice', post(messages(dm), await v2('m4', e2)));
    await r.call('history', 'after-block', 'bob', { path:messages(dm) });
    return r.entries;
}

const DIRECT_SCENARIOS = Object.freeze([
    Object.freeze({ name:'v1-fixture-verifier', run:directV1,
        composition:'createApp through messagingFixture of support/messaging.js, whose recipientKeyVerifier is fixtureVerifier; version 1 envelopes from encrypted() of support/messaging.js' }),
    Object.freeze({ name:'v2-key-directory', run:directV2,
        composition:'createApp through socialFixture of support/social.js with the real recipient-key verifier; device keys, epochs and version 2 envelopes from TestDevice of support/e2ee.js' }),
]);

function directHeader(entries) {
    const count = select => Object.fromEntries(select.map(([name, test]) => [name, entries.filter(test).length]));
    return {
        baseline:BASELINE,
        recorder:RECORDER,
        replay:'DATA/tests/dm-fixtures-replay.test.js',
        requirements:['ARCH-R02.3', 'ARCH-R02.4', 'DB5-R15.4'],
        entry:'scenario, id, family, request {actor, method, path, csrf for a mutation, origin, contentType, body or rawBody when sent}, status, code (the error code or null), body (the masked response body with all fields), retryAfter when the answer has a Retry-After header',
        clock:CLOCK,
        limiter:LIMITER,
        masking:MASKING,
        scenarios:DIRECT_SCENARIOS.map(({ name, composition }) => ({ name, composition })),
        counts:{
            entries:entries.length,
            families:count(DIRECT_FAMILIES.map(family => [family, entry => entry.family === family])),
            scenarios:count(DIRECT_SCENARIOS.map(({ name }) => [name, entry => entry.scenario === name])),
        },
    };
}

// The header as two-space JSON, then one entry per line; LF line endings, trailing newline, ASCII only.
function serialiseDirect({ entries, ...header }) {
    const head = JSON.stringify(header, null, 2);
    const lines = entries.map(entry => `    ${JSON.stringify(entry)}`);
    return `${asciiOnly(`${head.slice(0, -2)},\n  "entries": [\n${lines.join(',\n')}\n  ]\n}`)}\n`;
}

// Runs every scenario outside node:test; `after` mirrors the hook that support/auth.js setup registers.
async function recordDirect() {
    const entries = [];
    for (const scenario of DIRECT_SCENARIOS) {
        const hooks = [];
        try {
            entries.push(...await scenario.run({ after:hook => { hooks.push(hook); } }));
        } finally {
            for (const hook of hooks) await hook();
        }
    }
    return { ...directHeader(entries), entries };
}

function workingTreeGuard() {
    const diff = git(['diff', '--quiet', BASELINE, '--', ...EXECUTED_PATHS, ...NEVER_READ]);
    if (diff.status === 1) throw new Refusal(`the working tree differs from ${BASELINE} in code that the direct-message scenarios execute; nothing was written`);
    if (diff.status !== 0) throw new Refusal(`git diff failed with status ${diff.status}: ${String(diff.stderr).trim()}`);
    const untracked = String(gitOutput(['ls-files', '--others', '--exclude-standard', '-z', '--', ...EXECUTED_PATHS])).split('\0')
        .filter(name => name && name !== RECORDER);
    if (untracked.length) throw new Refusal(`untracked files in code that the direct-message scenarios execute: ${untracked.join(', ')}; nothing was written`);
}

// The recorded fixtures are read-only: a rerun may only confirm them, never replace them.
// A CRLF checkout (core.autocrlf) of a committed LF file is accepted as the same text.
function settle(file, text) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (!fs.existsSync(file)) return { file, text, relative, write:true, message:`${relative} written` };
    const existing = fs.readFileSync(file);
    if (lfText(existing) !== text) throw new Refusal(`${relative} exists and differs from a fresh recording; nothing was written`);
    const same = existing.equals(Buffer.from(text, 'utf8')) ? 'byte-identical to' : 'same text, after CRLF to LF, as';
    return { file, text, relative, write:false, message:`${relative} unchanged (${same} a fresh recording)` };
}

async function main() {
    guard();
    workingTreeGuard();
    if (process.env.NODE_ENV === 'production') throw new Refusal('NODE_ENV is production; the direct-message scenarios load test-only devices; nothing was written');
    const manifest = buildManifest();
    const text = serialise(manifest);
    const direct = await recordDirect();
    const directText = serialiseDirect(direct);
    assert.deepStrictEqual(JSON.parse(directText), direct, 'the direct fixture text must parse back to the recording');
    // Both outputs are settled before either is written, so a refusal writes nothing.
    const outputs = [settle(OUTPUT, text), settle(DIRECT_OUTPUT, directText)];
    for (const output of outputs.filter(item => item.write)) {
        fs.mkdirSync(path.dirname(output.file), { recursive:true });
        fs.writeFileSync(output.file, output.text, { encoding:'utf8', flag:'wx' });
    }
    console.log(outputs[0].message);
    console.log(`baseline ${BASELINE}: ${manifest.counts.tests} test files, ${manifest.counts.support} support files, ${manifest.counts.dc01} DC-01 lines`);
    console.log(`manifest sha256 ${sha256(text)}`);
    console.log(outputs[1].message);
    const families = Object.entries(direct.counts.families).map(([family, n]) => `${family} ${n}`).join(', ');
    console.log(`direct fixtures: ${direct.counts.entries} entries (${families})`);
    console.log(`direct sha256 ${sha256(directText)}`);
}

if (require.main === module) {
    main().catch(error => {
        if (!(error instanceof Refusal)) throw error;
        console.error(`record-baseline refused: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { BASELINE, DC01_LINES, buildManifest, serialise,
    DIRECT_OUTPUT, DIRECT_FAMILIES, DIRECT_SCENARIOS, directHeader, serialiseDirect, recordDirect };
