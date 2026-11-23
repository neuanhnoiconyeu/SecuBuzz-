// T-5B-12 (DB5-R02.5, R02.6, DB5-R09.7, R09.17). Cursor codec of server/groups/cursor.js, called directly: no database,
// no HTTP, no clock and no network. First created in DB-5B; DB-5C adds the listing cases and DB-5D the history cases
// (P-14 and P-15 through the routes).
// The codec is unsigned (OP-01 provisional): these tests claim the rejection of malformed and foreign-context cursors
// only, never the detection of a well-formed altered payload.
// Replay one P-13 run: PROPERTY_SEED=<base> PROPERTY_RUN=<index> node --test tests/groups-pagination.test.js in DATA/.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { AuthError } = require('../server/auth/errors');
const cursor = require('../server/groups/cursor');
const { createRandom, forAll } = require('./support/random');
const { httpGroupFixture, snapshot, createClock, actorRequest } = require('./support/groups');

const P13_RUNS = 200; // generated cases of P-13 (at least 100)
const P13_SEED = 13013;
const CURSOR_FILE = require.resolve('../server/groups/cursor');

const { encode, decode, CursorError, CURSOR_ERROR_CODES: CODES, ROUTE_KINDS, ROUTE_BINDINGS, MAX_CURSOR_LENGTH } = cursor;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const GROUPS = Object.freeze({ route: 'groups', userId: 'user-a' });
const HISTORY = Object.freeze({ route: 'group-messages', userId: 'user-a', conversationId: 'group-1' });
const SEARCH = Object.freeze({ route: 'file-search', userId: 'user-a', filters: { conversationId: 'group-1', uploadedBy: 'user-b', minBytes: 1 } });
const raw = text => Buffer.from(text, 'utf8').toString('base64url');
const recordOf = token => JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));

function rejects(token, context, reason, label) {
    assert.throws(() => decode(token, context), error => {
        assert.ok(error instanceof CursorError && error instanceof AuthError, label);
        assert.equal(error.reason, reason, label);
        assert.deepEqual([error.code, error.status, error.fields], ['VALIDATION_ERROR', 400, ['cursor']], label);
        if (typeof token === 'string' && token.length > 8) assert.ok(!error.message.includes(token), label);
        return true;
    }, label);
}

test('encode gives the pinned canonical base64url form and decode returns the payload', () => {
    const listing = { last: ['2025-01-02T03:04:05.006Z', '7c0e2a6e-0000-4000-8000-000000000001'] };
    const listingToken = 'eyJ2IjoxLCJjb250ZXh0IjoiN2QzNzJmMjM2ZGQyYTZkOGE3ZTc0M2VlMmEyNjA1Y2VkN2UyMjAzN2RkMzNmODk0ZmZkZDVjMjM1YTc2MGJkNyIsImxhc3QiOlsiMjAyNS0wMS0wMlQwMzowNDowNS4wMDZaIiwiN2MwZTJhNmUtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIl19';
    const history = { last: [41], highWater: 57 };
    const historyToken = 'eyJ2IjoxLCJjb250ZXh0IjoiZWY4M2ZiYjE3OWM5MDk3NzI0MTVkY2VkMmQyZjlmMDcwZmZlNDJkZjBkYzVmZTM1NDJmN2JmZjE5N2MzNDA1MCIsImxhc3QiOls0MV0sImhpZ2hXYXRlciI6NTd9';
    assert.equal(encode(listing, GROUPS), listingToken);
    assert.equal(encode(history, HISTORY), historyToken);
    assert.equal(Buffer.from(historyToken, 'base64url').toString('utf8'),
        '{"v":1,"context":"ef83fbb179c909772415dced2d2f9f070ffe42df0dc5fe3542f7bff197c34050","last":[41],"highWater":57}');
    // The context digest is an unkeyed SHA-256 of the documented array: binding only, no integrity tag (OP-01).
    const digest = createHash('sha256').update(JSON.stringify(['secubuzz-group-cursor-v1', 'group-messages', 'user-a', 'group-1', null])).digest('hex');
    assert.equal(recordOf(historyToken).context, digest);
    assert.deepEqual(decode(listingToken, GROUPS), listing);
    assert.deepEqual(decode(historyToken, HISTORY), history);
    assert.ok(Object.isFrozen(decode(historyToken, HISTORY)) && Object.isFrozen(decode(historyToken, HISTORY).last));
    // The largest valid payload (3 keys of 128 three-byte characters and the largest high-water) still fits.
    const wide = '\u4e2d'.repeat(cursor.MAX_KEY_LENGTH);
    const largest = encode({ last: [wide, wide, wide], highWater: MAX_INT }, HISTORY);
    assert.equal(largest.length, 1711);
    assert.ok(largest.length <= MAX_CURSOR_LENGTH);
});

test('decode refuses a token longer than 2048 characters or not canonical base64url', () => {
    rejects('A'.repeat(MAX_CURSOR_LENGTH + 1), GROUPS, CODES.TOO_LONG, '2049 characters');
    rejects(`${encode({ last: ['x'] }, GROUPS)}${'A'.repeat(MAX_CURSOR_LENGTH)}`, GROUPS, CODES.TOO_LONG, 'valid token with 2048 more characters');
    rejects('A'.repeat(MAX_CURSOR_LENGTH), GROUPS, CODES.MALFORMED, '2048 characters are base64url but not a cursor');
    const token = encode({ last: ['2025-01-02T03:04:05.006Z', 'group-9'] }, GROUPS);
    const standard = Buffer.from(token, 'base64url').toString('base64');
    assert.notEqual(standard, token, 'the standard base64 form differs from the token');
    for (const [label, value] of [['empty', ''], ['padding', `${token}=`], ['standard base64', standard], ['plus', `ab+c${token}`],
        ['slash', `ab/c${token}`], ['space', `${token.slice(0, 4)} ${token.slice(4)}`], ['dot', `${token}.`], ['non-ASCII', `${token}\u00e9`],
        ['single trailing character', 'A'], ['non-zero trailing bits', 'AB'], ['line break', `${token}\n`]]) {
        rejects(value, GROUPS, CODES.NOT_BASE64URL, label);
    }
});

test('decode refuses a malformed cursor with CURSOR_MALFORMED and never another error', () => {
    const digest = recordOf(encode({ last: ['a'] }, GROUPS)).context;
    const json = record => raw(JSON.stringify(record));
    const cases = [
        ['not JSON', raw('not json')], ['null', raw('null')], ['array', raw('[]')], ['string', raw('"x"')], ['number', raw('1')],
        ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url')], ['byte order mark', raw(`\ufeff{"v":1,"context":"${digest}","last":["a"]}`)],
        ['version 2', json({ v: 2, context: digest, last: ['a'] })], ['extra key', json({ v: 1, context: digest, last: ['a'], extra: 1 })],
        ['no last', json({ v: 1, context: digest })], ['empty last', json({ v: 1, context: digest, last: [] })],
        ['four keys', json({ v: 1, context: digest, last: ['a', 'b', 'c', 'd'] })], ['last not an array', json({ v: 1, context: digest, last: 'a' })],
        ['key of 129 units', json({ v: 1, context: digest, last: ['x'.repeat(129)] })], ['empty key', json({ v: 1, context: digest, last: [''] })],
        ['control character', json({ v: 1, context: digest, last: ['a\u0007'] })], ['C1 control', json({ v: 1, context: digest, last: ['a\u0085'] })],
        ['lone surrogate', raw(`{"v":1,"context":"${digest}","last":["\\ud800"]}`)], ['nested array', json({ v: 1, context: digest, last: [['a']] })],
        ['fraction', json({ v: 1, context: digest, last: [1.5] })], ['negative', json({ v: 1, context: digest, last: [-1] })],
        ['2^53', json({ v: 1, context: digest, last: [2 ** 53] })], ['boolean key', json({ v: 1, context: digest, last: [true] })],
        ['highWater -1', json({ v: 1, context: digest, last: ['a'], highWater: -1 })], ['highWater 2^53', json({ v: 1, context: digest, last: ['a'], highWater: 2 ** 53 })],
        ['highWater string', json({ v: 1, context: digest, last: ['a'], highWater: '1' })], ['highWater null', json({ v: 1, context: digest, last: ['a'], highWater: null })],
        ['short digest', json({ v: 1, context: digest.slice(1), last: ['a'] })], ['upper-case digest', json({ v: 1, context: digest.toUpperCase(), last: ['a'] })],
        ['__proto__ key', raw(`{"v":1,"context":"${digest}","last":["a"],"__proto__":{}}`)],
        // Not the canonical text of a valid record: re-encoding gives another token.
        ['white space', raw(`{"v": 1,"context":"${digest}","last":["a"]}`)], ['reordered keys', raw(`{"context":"${digest}","v":1,"last":["a"]}`)],
        ['-0', raw(`{"v":1,"context":"${digest}","last":[-0]}`)], ['1.0', raw(`{"v":1,"context":"${digest}","last":[1.0]}`)],
        ['exponent', raw(`{"v":1,"context":"${digest}","last":[1e3]}`)], ['duplicate key', raw(`{"v":1,"context":"${digest}","last":["b"],"last":["a"]}`)],
        ['escaped letter', raw(`{"v":1,"context":"${digest}","last":["\\u0061"]}`)],
    ];
    for (const [label, token] of cases) rejects(token, GROUPS, CODES.MALFORMED, label);
    for (const value of [undefined, null, 7, {}, [], Buffer.from('x')]) rejects(value, GROUPS, CODES.MALFORMED, String(value));
});

test('decode refuses a cursor bound to another user, route, conversation or filter digest', () => {
    const fromGroups = encode({ last: ['2025-01-02T03:04:05.006Z', 'group-9'] }, GROUPS);
    rejects(fromGroups, { ...GROUPS, userId: 'user-b' }, CODES.CONTEXT_MISMATCH, 'other user');
    rejects(fromGroups, { route: 'own-invitations', userId: 'user-a' }, CODES.CONTEXT_MISMATCH, 'other user-bound route');
    const members = { route: 'group-members', userId: 'user-a', conversationId: 'group-1' };
    const fromMembers = encode({ last: ['2025-01-02T03:04:05.006Z', 'user-c'] }, members);
    rejects(fromMembers, { ...members, conversationId: 'group-2' }, CODES.CONTEXT_MISMATCH, 'other conversation');
    rejects(fromMembers, { ...members, route: 'group-former-members' }, CODES.CONTEXT_MISMATCH, 'members cursor on the former-member route');
    rejects(fromMembers, { ...members, route: 'group-messages' }, CODES.CONTEXT_MISMATCH, 'other conversation-bound route');
    rejects(fromMembers, { ...members, userId: 'user-b' }, CODES.CONTEXT_MISMATCH, 'other member of the same group');
    const fromSearch = encode({ last: ['2025-01-02T03:04:05.006Z', 'file-1'] }, SEARCH);
    const filters = SEARCH.filters;
    for (const [label, other] of [['changed value', { ...filters, minBytes: 2 }], ['added filter', { ...filters, maxBytes: 9 }],
        ['removed filter', { conversationId: 'group-1', uploadedBy: 'user-b' }], ['string instead of number', { ...filters, minBytes: '1' }],
        ['decomposed accent', { ...filters, uploadedBy: 'e\u0301' }], ['other conversation filter', { ...filters, conversationId: 'group-2' }]]) {
        rejects(fromSearch, { ...SEARCH, filters: other }, CODES.CONTEXT_MISMATCH, label);
    }
    const accented = { ...SEARCH, filters: { uploadedBy: '\u00e9' } };
    rejects(encode({ last: ['k'] }, accented), { ...SEARCH, filters: { uploadedBy: 'e\u0301' } }, CODES.CONTEXT_MISMATCH, 'NFC and NFD differ');
    // The filter set enters the digest in name order: the order of the object keys does not change the binding.
    assert.deepEqual(decode(fromSearch, { ...SEARCH, filters: { minBytes: 1, uploadedBy: 'user-b', conversationId: 'group-1' } }).last, ['2025-01-02T03:04:05.006Z', 'file-1']);
    // A cursor of the existing direct conversation listing has the same key layout but another context digest.
    const directContext = createHash('sha256').update(JSON.stringify({ kind: 'direct-conversations-v1', actor: 'user-a' })).digest('hex');
    rejects(raw(JSON.stringify({ v: 1, context: directContext, last: ['2025-01-02T03:04:05.006Z', 'group-9'] })), GROUPS, CODES.CONTEXT_MISMATCH, 'direct listing cursor');
});

test('encode and decode refuse an invalid payload or context as a server fault (TypeError)', () => {
    const badPayloads = [null, [], 'x', {}, { last: [] }, { last: ['a', 'b', 'c', 'd'] }, { last: ['a'], extra: 1 }, { last: ['a'], highWater: undefined },
        { last: [''] }, { last: ['x'.repeat(129)] }, { last: ['\ud800'] }, { last: ['a\u0000'] }, { last: [-0] }, { last: [-1] }, { last: [1.5] },
        { last: [2 ** 53] }, { last: [true] }, { last: [null] }, { last: ['a'], highWater: -1 }, { last: ['a'], highWater: 2 ** 53 },
        { last: [, 'a'] }, { last: Object.assign(['a'], { extra: 1 }) }, { last: [new String('a')] }];
    for (const payload of badPayloads) assert.throws(() => encode(payload, GROUPS), TypeError, JSON.stringify(payload));
    const badContexts = [null, [], 'groups', {}, { route: 'unknown', userId: 'u' }, { route: 'toString', userId: 'u' }, { route: 'groups' },
        { route: 'groups', userId: '' }, { route: 'groups', userId: 'x'.repeat(1025) }, { route: 'groups', userId: 7 },
        { route: 'groups', userId: 'u', conversationId: 'g' }, { route: 'group-messages', userId: 'u' },
        { route: 'group-messages', userId: 'u', conversationId: '' }, { route: 'group-messages', userId: 'u', conversationId: 'g', filters: {} },
        { route: 'file-search', userId: 'u' }, { route: 'file-search', userId: 'u', filters: [] }, { route: 'file-search', userId: 'u', filters: { '1x': 'a' } },
        { route: 'file-search', userId: 'u', filters: { a: undefined } }, { route: 'file-search', userId: 'u', filters: { a: 1.5 } },
        { route: 'file-search', userId: 'u', filters: { a: {} } }, { route: 'file-search', userId: 'u', filters: { a: 'x'.repeat(1025) } },
        { route: 'file-search', userId: 'u', filters: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, i])) }];
    const token = encode({ last: ['a'] }, GROUPS);
    for (const context of badContexts) {
        assert.throws(() => encode({ last: ['a'] }, context), TypeError, JSON.stringify(context));
        assert.throws(() => decode(token, context), TypeError, JSON.stringify(context));
    }
});

test('cursor.js is an unsigned codec: no key, secret, setting, clock or randomness (OP-01 provisional)', () => {
    const source = fs.readFileSync(CURSOR_FILE, 'utf8');
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(source), 'ASCII only');
    assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['node:crypto', '../auth/errors']);
    for (const banned of [/createHmac|createSign|createCipher|randomBytes|randomUUID|getRandomValues|subtle/, /process\.env/, /Math\.random/, /Date\b/]) {
        assert.ok(!banned.test(source), String(banned));
    }
    // The header comment as one line of text.
    const header = source.split(/\r?\n/).slice(0, 20).map(line => line.replace(/^\/\/\s?/, '')).join(' ');
    for (const phrase of ['OP-01 provisional', 'UNSIGNED', 'NOT approved by the Project_Owner', 'NO integrity claim for a well-formed altered payload',
        'foreign-context cursor', 'permitted-range predicate', 'same query']) {
        assert.ok(header.includes(phrase), phrase);
    }
    assert.deepEqual(Object.keys(ROUTE_BINDINGS), [...ROUTE_KINDS]);
    assert.deepEqual(Object.values(CODES), ['CURSOR_TOO_LONG', 'CURSOR_NOT_BASE64URL', 'CURSOR_MALFORMED', 'CURSOR_CONTEXT_MISMATCH']);
});

// ---------------------------------------------------------------------------------------------------------------
// P-13 generators. Characters are written as escapes so this file stays ASCII: ASCII including the JSON specials quote
// and backslash, Latin-1, Greek, CJK, Arabic (right to left), a combining accent, zero width joiner, line and paragraph
// separators, byte order mark, replacement character, the last BMP code point and astral characters (surrogate pairs).
// ---------------------------------------------------------------------------------------------------------------
const KEY_TEXT = Object.freeze([...'abcXYZ019-_.:/+= ', '"', '\\', '\u00e9', '\u00df', '\u03a9', '\u4e2d', '\u0627', '\u0301', '\u200d',
    '\u2028', '\u2029', '\ufeff', '\ufffd', '\uffff', '\u{1f600}', '\u{10ffff}', '\u{1d11e}']);
// Filter strings and identifiers only enter the digest, so they may hold any code unit: controls and lone surrogates too.
const ANY_TEXT = Object.freeze([...KEY_TEXT, '\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\ud800', '\udfff']);
const WIDE = Object.freeze(['\u4e2d', '\u20ac', '\uffff', '\u2028']); // three UTF-8 bytes each: the length bound
const FILTER_NAMES = Object.freeze(['conversationId', 'uploadedBy', 'minBytes', 'maxBytes', 'createdAfter', 'createdBefore', 'q', 'Zeta9']);

// A string of min to max UTF-16 code units (a surrogate pair counts two).
function text(random, alphabet, min, max) {
    const length = random.weighted([[min, 1], [max, 1], [null, 2]]) ?? random.int(min, max);
    let value = '';
    while (value.length < length) {
        const next = random.pick(alphabet);
        value += value.length + next.length <= length ? next : 'a';
    }
    return value;
}
const integer = random => random.weighted([[0, 1], [1, 1], [MAX_INT, 1], [MAX_INT - 1, 1], [null, 4]]) ?? random.int(0, MAX_INT);
const uuid = random => random.bytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const identifier = random => random.weighted([[uuid(random), 6], [text(random, ANY_TEXT, 1, 64), 3], [text(random, ANY_TEXT, 1024, 1024), 1]]);

function filterSet(random) {
    const filters = {};
    for (const name of random.shuffle(FILTER_NAMES).slice(0, random.int(0, FILTER_NAMES.length))) {
        filters[name] = random.weighted([[text(random, ANY_TEXT, 0, 64), 5], [integer(random), 2], [random.bool(), 1], [null, 1]]);
    }
    return filters;
}

function generateCase(random) {
    const route = random.pick(ROUTE_KINDS);
    const context = { route, userId: identifier(random) };
    if (ROUTE_BINDINGS[route] === 'conversation') context.conversationId = identifier(random);
    if (ROUTE_BINDINGS[route] === 'filters') context.filters = filterSet(random);
    const largest = random.bool(0.2); // one case in five has the largest payload
    const keys = largest ? cursor.MAX_KEYS : random.int(1, cursor.MAX_KEYS);
    const last = Array.from({ length: keys }, () => largest ? text(random, WIDE, cursor.MAX_KEY_LENGTH, cursor.MAX_KEY_LENGTH)
        : random.bool() ? integer(random) : text(random, KEY_TEXT, 1, cursor.MAX_KEY_LENGTH));
    const payload = largest || random.bool() ? { last, highWater: largest ? MAX_INT : integer(random) } : { last };
    return { context, payload };
}

// Feature: db5-db6-canonical-integration, Property P-13: Cursor round trip
// **Validates: Requirements DB5-R02.5, DB5-R09.7**
test('P-13: decode(encode(payload, context), context) equals the payload; the token is canonical base64url of at most 2048 characters', async t => {
    let longest = 0;
    const summary = await forAll('P-13', { runs: P13_RUNS, seed: P13_SEED }, generateCase, ({ context, payload }, info) => {
        const token = encode(payload, context);
        assert.match(token, /^[A-Za-z0-9_-]+$/, 'base64url alphabet, no padding');
        assert.ok(token.length <= MAX_CURSOR_LENGTH, `length ${token.length}`);
        longest = Math.max(longest, token.length);
        // Deterministic: equal inputs give one token, whatever the object identity or the order of the filter keys.
        const copy = structuredClone(context);
        if (copy.filters) copy.filters = Object.fromEntries(info.random.shuffle(Object.entries(copy.filters)));
        assert.equal(encode(structuredClone(payload), copy), token);
        assert.equal(encode(payload, context), token);
        assert.deepEqual(decode(token, context), payload);
        assert.deepEqual(decode(token, copy), payload);
    });
    t.diagnostic(`P-13 seed=${summary.seed} runs=${summary.runs} longest token ${longest} characters`);
});

test('P-14: altered or foreign real listing cursors and bad list parameters are refused without writes', { timeout: 240000 }, async t => {
    const f = await httpGroupFixture(t, { clock: createClock(), features: { groupApi: true, groups: { maxMembers: 50,
        maxPendingInvitationsPerGroup: 50, maxPendingInvitationsPerInvitee: 50 } } }), b = f.builder, owner = f.actors.owner, admin = f.actors.admin;
    const second = b.createGroup({ ownerId: owner.id, title: 'P14 second group', idempotencyKey: null });
    b.addMember(second, admin.id);
    // Distinct recipients need registered accounts because the database foreign key is real.
    for (let index = 0; index < 3; index++) {
        const user = f.repositories.users.create({ user_id: `p14-user-${index}`, username: `p14-user-${index}`, display_name: `P14 ${index}` });
        b.invite(f.groupId, owner.id, user.user_id);
    }
    const ownGroup = b.createGroup({ ownerId: admin.id, title: 'P14 invite group', idempotencyKey: null });
    b.invite(ownGroup, admin.id, f.actors.pendingInvitee.id);
    const paths = [
        { key: 'G02', actor: owner, path: '/api/groups?limit=1' },
        { key: 'G05', actor: owner, path: `/api/groups/${f.groupId}/members?limit=1` },
        { key: 'G13', actor: owner, path: `/api/groups/${f.groupId}/invitations?limit=1` },
        { key: 'G15', actor: f.actors.pendingInvitee, path: '/api/groups/invitations?limit=1' },
    ];
    const pages = new Map();
    for (const row of paths) {
        const page = await actorRequest(row.actor, 'GET', row.path);
        assert.equal(page.status, 200, `${row.key} first page`);
        assert.ok(page.body.nextCursor, `${row.key} has a real next cursor`);
        pages.set(row.key, { ...row, cursor: page.body.nextCursor });
    }
    const targets = [...pages.values()];
    const mutate = (token, kind) => {
        if (kind === 'overlong') return `${token}${'A'.repeat(2049)}`;
        if (kind === 'truncate') return token.slice(0, -1);
        if (kind === 'append') return `${token}!`;
        if (kind === 'outside') return `!${token.slice(1)}`;
        if (kind === 'context') {
            const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
            payload.context = `${payload.context.slice(0, -1)}${payload.context.endsWith('0') ? '1' : '0'}`;
            return Buffer.from(JSON.stringify(payload)).toString('base64url');
        }
        if (kind === 'insert') return `${token.slice(0, 2)}!${token.slice(2)}`;
        if (kind === 'delete') return token.slice(0, 2) + token.slice(3);
        if (kind === 'change-case') return token.replace(/[A-Za-z]/, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
        return `${token}A`;
    };
    const mutationKinds = ['overlong', 'truncate', 'append', 'outside', 'context', 'insert', 'delete', 'change-case'];
    const coverage = new Set();
    await forAll('P-14', { runs: 64, seed: 0x5c140034, onRun: line => t.diagnostic(line), describe: item => `${item.source}:${item.kind}` },
        (_random, info) => ({ source: ['G02', 'G05', 'G13', 'G15'][Math.floor(info.run / 16)], kind: mutationKinds[info.run % mutationKinds.length] }), async (item, info) => {
            const source = pages.get(item.source), url = source.path.replace(/([?&])limit=1/, `$1limit=1&cursor=${encodeURIComponent(mutate(source.cursor, item.kind))}`);
            const before = snapshot(f.db), response = await actorRequest(source.actor, 'GET', url);
            assert.deepEqual([response.status, response.body], [400, { code: 'VALIDATION_ERROR', fields: ['cursor'] }],
                `P-14 seed=${info.seed} run=${info.run} ${item.source}/${item.kind}`);
            assert.deepEqual(snapshot(f.db), before, 'invalid cursor changes no row'); coverage.add(`${item.source}:${item.kind}`);
        });
    for (const [sourceName, other] of [['G02 as another user', { ...pages.get('G02'), actor: admin }],
        ['G05 on another group', { ...pages.get('G05'), path: `/api/groups/${second}/members?limit=1` }],
        ['G13 on another group', { ...pages.get('G13'), actor: admin, path: `/api/groups/${ownGroup}/invitations?limit=1` }],
        ['G15 as another user', { ...pages.get('G15'), actor: owner }]]) {
        const before = snapshot(f.db), url = other.path.replace(/([?&])limit=1/, `$1limit=1&cursor=${encodeURIComponent(other.cursor)}`);
        const response = await actorRequest(other.actor, 'GET', url);
        assert.deepEqual([response.status, response.body], [400, { code: 'VALIDATION_ERROR', fields: ['cursor'] }], sourceName);
        assert.deepEqual(snapshot(f.db), before, `${sourceName} changes no row`);
    }
    for (const source of pages.values()) for (const query of ['&unknown=1', '&limit=0', '&limit=51', '&limit=1.5']) {
        const before = snapshot(f.db), response = await actorRequest(source.actor, 'GET', `${source.path}${query}`);
        const field = query.startsWith('&unknown') ? 'unknown' : 'limit';
        assert.deepEqual([response.status, response.body], [400, { code: 'VALIDATION_ERROR', fields: [field] }]);
        assert.deepEqual(snapshot(f.db), before, 'bad list parameters change no row');
    }
    assert.equal(coverage.size, 32, 'eight deterministic mutation kinds ran against all four real cursor sources');
});

test('P-15: paged listings concatenate to the independent sorted oracle', { timeout: 240000 }, async t => {
    const f = await httpGroupFixture(t, { clock: createClock(), features: { groupApi: true, groups: { maxMembers: 50,
        maxPendingInvitationsPerGroup: 1000, maxPendingInvitationsPerInvitee: 1000 } } });
    const { builder, db, actors, groupId } = f, owner = actors.owner, invitee = actors.pendingInvitee;
    const emptyGroup = builder.createGroup({ ownerId: actors.admin.id, conversationId: 'p15-empty-group', title: 'P15 empty', idempotencyKey: null });
    const population = 150;
    // Groups and own invitations have exactly 150 rows; one separate actor and group provide empty-list boundaries.
    for (let index = 0; index < population - 1; index++) {
        const id = `p15-group-${String(index).padStart(3, '0')}`;
        builder.createGroup({ ownerId: owner.id, conversationId: id, title: `P15 ${index}`, idempotencyKey: null });
        builder.invite(id, owner.id, invitee.id);
    }
    // The default group is the 150th group and holds 150 pending group Invitations for distinct synthetic users.
    for (let index = 0; index < population - 1; index++) {
        const userId = `p15-target-${String(index).padStart(3, '0')}`;
        f.repositories.users.create({ user_id: userId, username: userId, display_name: `P15 target ${index}` });
        builder.invite(groupId, owner.id, userId);
    }
    // Create exactly 150 active and 150 former rows in the listing group without using API limits as a fixture shortcut.
    for (let index = 0; index < population - 3; index++) {
        const userId = `p15-active-${String(index).padStart(3, '0')}`;
        f.repositories.users.create({ user_id: userId, username: userId, display_name: `P15 active ${index}` });
        builder.addMember(groupId, userId);
    }
    for (let index = 0; index < population - 1; index++) {
        const userId = `p15-former-${String(index).padStart(3, '0')}`;
        f.repositories.users.create({ user_id: userId, username: userId, display_name: `P15 former ${index}` });
        builder.addMember(groupId, userId); builder.removeMember(groupId, userId);
    }

    const random = createRandom(0x5c150035), traversal = async (actor, path, key, expected) => {
        const items = [], seen = new Set(); let cursorValue = null, pages = 0;
        do {
            const limit = random.int(1, 50), query = new URLSearchParams({ limit: String(limit) });
            if (cursorValue !== null) query.set('cursor', cursorValue);
            const response = await actorRequest(actor, 'GET', `${path}${path.includes('?') ? '&' : '?'}${query}`);
            assert.equal(response.status, 200, `${key} page ${pages}`);
            assert.ok(response.body.items.length <= limit);
            for (const item of response.body.items) {
                assert.ok(!seen.has(item.id), `${key} duplicate ${item.id}`); seen.add(item.id); items.push(item);
            }
            cursorValue = response.body.nextCursor;
            pages++;
            assert.ok(pages <= population + 1, `${key} cursor traversal terminates`);
            if (cursorValue === null) assert.equal(response.body.nextCursor, null, `${key} final page has no cursor`);
        } while (cursorValue !== null);
        assert.deepEqual(items.map(item => item.id), expected, `${key} pages equal the SQL-derived sorted oracle`);
        return items;
    };
    const expectedGroups = db.prepare(`SELECT conversation.conversation_id AS id FROM ConversationMembers member
        JOIN Conversations conversation ON conversation.conversation_id=member.conversation_id JOIN GroupExtensions extension ON extension.conversation_id=conversation.conversation_id
        WHERE member.user_id=? AND member.left_at IS NULL AND conversation.kind='group' AND conversation.origin='authenticated'
        ORDER BY conversation.updated_at DESC,conversation.conversation_id DESC`).all(owner.id).map(row => row.id);
    assert.equal(expectedGroups.length, population, 'the owner has exactly 150 populated groups');
    const groupRows = await traversal(owner, '/api/groups', 'G02', expectedGroups);
    assert.equal(groupRows.length, population);
    assert.deepEqual(await traversal(actors.nonMember, '/api/groups', 'G02 empty', []), []);

    const expectedActive = db.prepare(`SELECT member.user_id AS id FROM GroupMembershipIntervals period JOIN ConversationMembers member
        ON member.conversation_id=period.conversation_id AND member.user_id=period.user_id WHERE period.conversation_id=? AND period.left_at IS NULL AND member.left_at IS NULL
        ORDER BY period.joined_at,member.user_id`).all(groupId).map(row => row.id);
    assert.equal(expectedActive.length, population);
    await traversal(owner, `/api/groups/${groupId}/members`, 'G05 active', expectedActive);
    const expectedFormer = db.prepare(`SELECT user_id AS id FROM ConversationMembers WHERE conversation_id=? AND left_at IS NOT NULL ORDER BY left_at,user_id`).all(groupId).map(row => row.id);
    assert.equal(expectedFormer.length, population);
    await traversal(owner, `/api/groups/${groupId}/members?former=true`, 'G05 former', expectedFormer);
    assert.deepEqual(await traversal(actors.admin, `/api/groups/${emptyGroup}/members?former=true`, 'G05 former empty', []), []);

    const expectedGroupInvites = db.prepare(`SELECT invitation_id AS id FROM ConversationInvitations WHERE conversation_id=? AND state='pending'
        AND julianday(expires_at)>julianday(?) ORDER BY created_at DESC,invitation_id DESC`).all(groupId, f.clock.iso()).map(row => row.id);
    assert.equal(expectedGroupInvites.length, population);
    await traversal(owner, `/api/groups/${groupId}/invitations`, 'G13', expectedGroupInvites);
    const expectedOwnInvites = db.prepare(`SELECT invitation_id AS id FROM ConversationInvitations WHERE invitee_id=? AND state='pending'
        AND julianday(expires_at)>julianday(?) ORDER BY created_at DESC,invitation_id DESC`).all(invitee.id, f.clock.iso()).map(row => row.id);
    assert.equal(expectedOwnInvites.length, population);
    await traversal(invitee, '/api/groups/invitations', 'G15', expectedOwnInvites);
    assert.deepEqual(await traversal(actors.nonMember, '/api/groups/invitations', 'G15 empty', []), []);
    assert.ok(groupRows.length >= 150 && expectedActive.length === 150 && expectedFormer.length === 150 && expectedGroupInvites.length === 150 && expectedOwnInvites.length === 150);
});
