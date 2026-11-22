// T-5B-09 (DB5-R04.1, R04.8, DB5-R05.1, R05.3, R05.4, DB5-R06.7, R06.8, R06.13, DB5-R08.1, R08.12).
// Example tests of the pure group rules in server/groups/policy.js. They pin the rules independently of the services
// that later use them as an oracle: the role matrix is compared with the literal table of DB5-R06.13 (copied below,
// because the Validation_Runner image holds no .kiro folder) and the ranges of DB5-R08.12 are printed and compared with
// a direct reading of the criterion. No database, HTTP, clock or network is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const policy = require('../server/groups/policy');

const POLICY_FILE = require.resolve('../server/groups/policy');
const {
    ROLES, HISTORY_POLICIES, INVITATION_EXPIRY_SECONDS, FORMER_OWNER_ROLE, DECISIONS, ROLE_MATRIX, ACTIONS,
    ARCHIVE_REFUSED, INVITATION_CHECKS, roleMatrix, removalDecision, transferDecision, permittedRanges, inRanges,
    invitationRevalidation,
} = policy;

// T-5B-10 (DB5-R15.6, NFR-07): the seeded generator and property runner of support/random.js. The case counts of its
// checks are these constants (OP-07 provisional); the checks pass env: {} so a replay variable set for another property
// leaves them unchanged, except the one check that reads the process environment on purpose.
const RANDOM_FILE = require.resolve('./support/random');
const { DEFAULT_RUNS, createRandom, deriveRunSeed, seedLine, forAll, PropertyFailure } = require('./support/random');
const DETERMINISM_SEEDS = [0, 1, 42, 20250101, 0xffffffff];
const DETERMINISM_DRAWS = 200; // rounds of drawSequence per seed
const REFERENCE_OUTPUTS = 1000; // raw outputs compared with the mulberry32 reference
const RANGE_DRAWS = 400; // draws per seed in the range checks
const HARNESS_RUNS = 12; // runs of the forAll checks
const HARNESS_SEED = 51017;
const HARNESS_FAILING_RUN = 7;

// DB5-R06.13 as printed in requirements.md.
const PRINTED_TABLE = [
    '| Action | Owner | Admin | Member |',
    '| --- | --- | --- | --- |',
    '| Read group, members, permitted history | allowed | allowed | allowed |',
    '| Change name or description | allowed | refused | refused |',
    '| Change History_Policy | refused (OD-05: chosen at creation only) | refused | refused |',
    '| Invite or add a user (OD-01, OD-02, OD-03) | allowed | allowed | refused |',
    '| Cancel an Invitation | allowed | allowed (OD-03) | refused |',
    '| Remove a member | allowed | allowed | refused |',
    '| Remove an admin | allowed | refused | refused |',
    '| Change a role or transfer ownership | allowed | refused | refused |',
    '| Leave the group | refused until transfer | allowed | allowed |',
    '| Archive the group (DB5-R07) | allowed | refused | refused |',
];
// OD items each cell depends on: the printed flags plus those the OD table and DB5-R05.7 attach to a cell.
const INVITE = ['OD-01', 'OD-02', 'OD-03'];
const EXPECTED_FLAGS = {
    'Read group, members, permitted history': { owner: [], admin: [], member: [] },
    'Change name or description': { owner: [], admin: ['OD-03'], member: [] },
    'Change History_Policy': { owner: ['OD-05'], admin: ['OD-05'], member: ['OD-05'] },
    'Invite or add a user (OD-01, OD-02, OD-03)': { owner: INVITE, admin: INVITE, member: INVITE },
    'Cancel an Invitation': { owner: [], admin: ['OD-03'], member: [] },
    'Remove a member': { owner: [], admin: [], member: [] },
    'Remove an admin': { owner: [], admin: ['OD-03'], member: [] },
    'Change a role or transfer ownership': { owner: [], admin: [], member: [] },
    'Leave the group': { owner: ['OD-10'], admin: [], member: [] },
    'Archive the group (DB5-R07)': { owner: ['OD-09'], admin: [], member: [] },
    'Tombstone another member\'s message': { owner: ['OD-13'], admin: ['OD-13'], member: ['OD-13'] },
    'Delete another member\'s attachment': { owner: ['OD-13'], admin: ['OD-03', 'OD-13'], member: ['OD-13'] },
};
const OPEN_ITEMS = ['OD-01', 'OD-02', 'OD-03', 'OD-06', 'OD-07', 'OD-09', 'OD-10', 'OD-11', 'OD-13'];
// DB5-R07.2 (message submission, member addition, Invitation creation, role change, transfer, upload, name or
// description) and DB5-R07.10 (archive of an archived group); only the matrix actions of that list appear here.
const ARCHIVED_REFUSALS = ['updateMetadata', 'invite', 'addMember', 'changeRole', 'transferOwnership', 'archive'];

const flagText = entry => entry.od.length ? `${entry.od.join(', ')} ${entry.provisional ? 'provisional' : 'decided'}` : '-';
function assertDeepFrozen(value) {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) if (child && typeof child === 'object') assertDeepFrozen(child);
}

test('policy.js loads no module and reads no environment variable, clock or random source', () => {
    const source = fs.readFileSync(POLICY_FILE, 'utf8');
    assert.match(source, /^[\x00-\x7f]*$/, 'policy.js is ASCII only');
    assert.doesNotMatch(source, /\brequire\s*\(/);
    assert.doesNotMatch(source, /\bimport\b/);
    assert.doesNotMatch(source, /process\.env/);
    assert.doesNotMatch(source, /\bprocess\b/);
    assert.doesNotMatch(source, /Date\.now|new Date|hrtime|performance|Math\.random|setTimeout|setInterval|globalThis/);
    assert.equal(require.cache[POLICY_FILE].children.length, 0);
});

test('INVITATION_EXPIRY_SECONDS is the fixed constant 604800 and no setting overrides it', () => {
    assert.equal(INVITATION_EXPIRY_SECONDS, 604800);
    assert.equal(INVITATION_EXPIRY_SECONDS, 7 * 24 * 60 * 60);
    assert.ok(Object.isFrozen(policy));
    assert.throws(() => { 'use strict'; policy.INVITATION_EXPIRY_SECONDS = 60; }, TypeError);
    assert.doesNotMatch(fs.readFileSync(POLICY_FILE, 'utf8'), /process\.env|GROUP_INVITATION_TTL_SECONDS/);
    // A fresh load with the removed setting present still gives the constant.
    const saved = process.env.GROUP_INVITATION_TTL_SECONDS;
    const original = require.cache[POLICY_FILE];
    process.env.GROUP_INVITATION_TTL_SECONDS = '60';
    delete require.cache[POLICY_FILE];
    try {
        assert.equal(require(POLICY_FILE).INVITATION_EXPIRY_SECONDS, 604800);
    } finally {
        require.cache[POLICY_FILE] = original;
        if (saved === undefined) delete process.env.GROUP_INVITATION_TTL_SECONDS;
        else process.env.GROUP_INVITATION_TTL_SECONDS = saved;
    }
});

test('the role matrix prints the literal table of DB5-R06.13 with its OD flags', t => {
    assertDeepFrozen(ROLE_MATRIX);
    assert.deepEqual(ROLES, ['owner', 'admin', 'member']);
    const printed = ROLE_MATRIX.filter(row => row.printed);
    const lines = ['| Action | Owner | Admin | Member |', '| --- | --- | --- | --- |',
        ...printed.map(row => `| ${row.label} | ${ROLES.map(role => row.cells[role].text).join(' | ')} |`)];
    for (const line of lines) t.diagnostic(line);
    assert.deepEqual(lines, PRINTED_TABLE);

    t.diagnostic('OD flags per cell (provisional = open Project_Owner decision, default applied):');
    t.diagnostic('| Action | Owner | Admin | Member |');
    for (const row of ROLE_MATRIX) {
        t.diagnostic(`| ${row.label}${row.printed ? '' : ' (not a printed row)'} | ${ROLES.map(role => flagText(row.cells[role])).join(' | ')} |`);
        for (const role of ROLES) {
            const entry = row.cells[role];
            assert.deepEqual(entry.od, EXPECTED_FLAGS[row.label][role], `${row.label} / ${role}`);
            assert.equal(entry.provisional, entry.od.some(id => OPEN_ITEMS.includes(id)), `${row.label} / ${role}`);
            assert.equal(entry.allowed, entry.text.startsWith('allowed'));
            // Every OD item printed in the label or the cell text is one of the cell's flags.
            for (const id of `${row.label} ${entry.text}`.match(/OD-\d\d/g) || []) assert.ok(entry.od.includes(id), `${row.label} / ${role} / ${id}`);
            for (const action of row.actions) assert.equal(roleMatrix(role, action).allowed, entry.allowed, `${action} / ${role}`);
        }
    }
    assert.equal(Object.keys(EXPECTED_FLAGS).length, ROLE_MATRIX.length);
    for (const row of ROLE_MATRIX.filter(item => !item.printed)) for (const role of ROLES) assert.equal(row.cells[role].allowed, false);
});

test('every OD flag of the matrix is a recorded decision and only OD-05 and OD-08 count as decided', () => {
    assertDeepFrozen(DECISIONS);
    for (const row of ROLE_MATRIX) for (const role of ROLES) for (const id of row.cells[role].od) assert.ok(DECISIONS[id], id);
    for (const [id, entry] of Object.entries(DECISIONS)) {
        assert.equal(entry.provisional, OPEN_ITEMS.includes(id), id);
        assert.ok(entry.rule.length > 0, id);
    }
    assert.equal(DECISIONS['OD-05'].state, 'decided');
    assert.equal(DECISIONS['OD-08'].state, 'decided in part');
    assert.equal(DECISIONS['OD-01'].state, 'decided in part');
});

test('Change History_Policy is refused for the owner, the admin and the member, archived or not (OD-05)', () => {
    assert.deepEqual(HISTORY_POLICIES, ['all', 'from_joined']);
    for (const archived of [false, true]) {
        for (const role of ROLES) {
            const entry = roleMatrix(role, 'changeHistoryPolicy', { archived });
            assert.equal(entry.allowed, false, `${role} archived=${archived}`);
            assert.equal(entry.refusal, role === 'owner' ? 'immutable' : 'role');
            assert.deepEqual(entry.od, ['OD-05']);
            assert.equal(entry.provisional, false);
        }
    }
});

test('roleMatrix applies the archive refusals of DB5-R07.2 after the role check and refuses a non-member', () => {
    assert.deepEqual([...ARCHIVE_REFUSED].sort(), [...ARCHIVED_REFUSALS].sort());
    for (const action of ACTIONS) {
        for (const role of ROLES) {
            const open = roleMatrix(role, action);
            const archived = roleMatrix(role, action, { archived: true });
            if (!open.allowed) assert.equal(archived.refusal, open.refusal, `${action} / ${role}`);
            else if (ARCHIVED_REFUSALS.includes(action)) assert.equal(archived.refusal, 'archived', `${action} / ${role}`);
            else assert.equal(archived.allowed, true, `${action} / ${role}`);
        }
        for (const role of [null, undefined, 'former', 'Owner', '']) {
            const entry = roleMatrix(role, action);
            assert.equal(entry.allowed, false);
            assert.equal(entry.refusal, 'notMember');
        }
    }
    for (const role of ROLES) {
        assert.equal(roleMatrix(role, 'read', { archived: true }).allowed, true); // DB5-R07.3
    }
    assert.equal(roleMatrix('admin', 'leave', { archived: true }).allowed, true); // DB5-R07.11
    assert.equal(roleMatrix('owner', 'leave', { archived: true }).refusal, 'role'); // OD-10 default, as unarchived
    assert.throws(() => roleMatrix('owner', 'deleteGroup'), TypeError); // OD-09: no deletion action
    assert.throws(() => roleMatrix('owner', 'unarchive'), TypeError);
    assert.throws(() => roleMatrix('owner', 'read', { archived: 'yes' }), TypeError);
});

test('removalDecision: admin removing an admin is forbidden and removing the owner is a conflict', t => {
    const expected = {
        owner: { owner: 'conflict', admin: 'allow', member: 'allow' }, // R05.4, R05.1
        admin: { owner: 'forbidden', admin: 'forbidden', member: 'allow' }, // R05.3, R05.2
        member: { owner: 'forbidden', admin: 'forbidden', member: 'forbidden' }, // R05.16
    };
    t.diagnostic('| actor \\ target | owner | admin | member |');
    for (const actor of ROLES) {
        t.diagnostic(`| ${actor} | ${ROLES.map(target => removalDecision(actor, target)).join(' | ')} |`);
        for (const target of ROLES) assert.equal(removalDecision(actor, target), expected[actor][target], `${actor} -> ${target}`);
    }
    assert.equal(removalDecision('admin', 'admin'), 'forbidden');
    assert.equal(removalDecision('owner', 'owner'), 'conflict');
    for (const [actor, target] of [[null, 'member'], ['owner', null], ['former', 'member'], ['owner', 'guest']]) {
        assert.equal(removalDecision(actor, target), 'forbidden');
    }
});

test('transferDecision demotes the former owner to admin and refuses in the order of DB5-R06.17', () => {
    const base = { actorId: 'u-owner', actorRole: 'owner', targetId: 'u-member', targetRole: 'member', revision: 4 };
    const allowed = transferDecision(base);
    assert.equal(allowed.decision, 'allow');
    assert.equal(allowed.formerOwnerRole, 'admin');
    assert.equal(FORMER_OWNER_ROLE, 'admin');
    assert.deepEqual(allowed.steps, [
        { userId: 'u-owner', from: 'owner', to: 'admin' },
        { userId: 'u-member', from: 'member', to: 'owner' },
    ]);
    assert.equal(allowed.revisionIncrement, 1);
    assert.deepEqual(allowed.od, ['OD-03']);
    assert.equal(allowed.provisional, true);
    assertDeepFrozen(allowed);
    assert.equal(transferDecision({ ...base, targetRole: 'admin' }).steps[1].from, 'admin');
    assert.equal(transferDecision({ ...base, precondition: 4 }).decision, 'allow');

    const cases = [
        [{ actorRole: null }, 'notFound'], // R06.14
        [{ actorRole: 'admin' }, 'forbidden'], // R06.6, R06.10
        [{ actorRole: 'member' }, 'forbidden'],
        [{ actorRole: 'admin', archived: true, targetId: undefined }, 'forbidden'],
        [{ archived: true }, 'conflict'], // DB5-R07.2
        [{ archived: true, targetId: undefined }, 'conflict'],
        [{ targetId: undefined }, 'invalid'], // R06.9
        [{ targetId: '' }, 'invalid'],
        [{ targetRole: null }, 'invalid'],
        [{ targetId: 'u-owner', targetRole: 'owner' }, 'invalid'],
        [{ targetRole: 'owner' }, 'invalid'],
        [{ targetRole: null, precondition: 3 }, 'invalid'],
        [{ precondition: 3 }, 'stale'], // R06.12
        [{ precondition: '4' }, 'stale'],
    ];
    for (const [change, decision] of cases) assert.equal(transferDecision({ ...base, ...change }).decision, decision, JSON.stringify(change));
    assert.throws(() => transferDecision({ ...base, actorId: undefined }), TypeError);
    assert.throws(() => transferDecision(null), TypeError);
});

const interval = (first, last) => ({ first_seq: first, last_seq: last });
const range = (from, to) => ({ from, to });
const showIntervals = list => list.length ? list.map(({ first_seq: first, last_seq: last }) =>
    `[${first}..${last === null ? 'open' : last}${last === first - 1 ? ' empty' : ''}]`).join(' ') : '(none)';
const showRanges = list => list.length ? list.map(({ from, to }) => `[${from}..${to === null ? 'open' : to}]`).join(' ') : '(none)';
// DB5-R08.12 read directly: inside an interval (no upper bound when open), or, under all, below the earliest first_seq.
function permittedByDefinition(seq, intervals, historyPolicy) {
    if (intervals.some(({ first_seq: first, last_seq: last }) => seq >= first && (last === null || seq <= last))) return true;
    return historyPolicy === 'all' && intervals.length > 0 && seq >= 1 && seq < Math.min(...intervals.map(item => item.first_seq));
}
const RANGE_CASES = [
    { intervals: [], from_joined: [], all: [] },
    { intervals: [interval(5, null)], from_joined: [range(5, null)], all: [range(1, null)] },
    { intervals: [interval(1, null)], from_joined: [range(1, null)], all: [range(1, null)] },
    { intervals: [interval(3, 4), interval(7, null)], from_joined: [range(3, 4), range(7, null)], all: [range(1, 4), range(7, null)] },
    { intervals: [interval(5, 4), interval(9, null)], from_joined: [range(9, null)], all: [range(1, 4), range(9, null)] },
    { intervals: [interval(6, 5)], from_joined: [], all: [range(1, 5)] },
    { intervals: [interval(1, 0)], from_joined: [], all: [] },
    { intervals: [interval(5, 4), interval(5, null)], from_joined: [range(5, null)], all: [range(1, null)] },
    { intervals: [interval(3, 4), interval(5, 6)], from_joined: [range(3, 6)], all: [range(1, 6)] },
    { intervals: [interval(12, null), interval(2, 4), interval(8, 9)], from_joined: [range(2, 4), range(8, 9), range(12, null)],
        all: [range(1, 4), range(8, 9), range(12, null)] },
];

test('permittedRanges prints the ranges of DB5-R08.12, with an empty and an open interval', t => {
    t.diagnostic('| intervals | from_joined | all |');
    for (const item of RANGE_CASES) {
        const fromJoined = permittedRanges(item.intervals, 'from_joined');
        const all = permittedRanges(item.intervals, 'all');
        t.diagnostic(`| ${showIntervals(item.intervals)} | ${showRanges(fromJoined)} | ${showRanges(all)} |`);
        assert.deepEqual(fromJoined, item.from_joined, showIntervals(item.intervals));
        assert.deepEqual(all, item.all, showIntervals(item.intervals));
        assertDeepFrozen(all);
        for (let seq = 1; seq <= 15; seq += 1) {
            for (const historyPolicy of HISTORY_POLICIES) {
                const ranges = historyPolicy === 'all' ? all : fromJoined;
                assert.equal(inRanges(seq, ranges), permittedByDefinition(seq, item.intervals, historyPolicy), `${showIntervals(item.intervals)} ${historyPolicy} ${seq}`);
            }
        }
    }
});

test('under all the ranges add the sequences below the earliest first_seq; under from_joined they do not', () => {
    // The AF-14 scenario: member during 3 and 4, removed during 5 and 6, rejoined from 7.
    const intervals = [interval(3, 4), interval(7, null)];
    const fromJoined = permittedRanges(intervals, 'from_joined');
    const all = permittedRanges(intervals, 'all');
    const visible = ranges => [1, 2, 3, 4, 5, 6, 7, 8].filter(seq => inRanges(seq, ranges));
    assert.deepEqual(visible(fromJoined), [3, 4, 7, 8]);
    assert.deepEqual(visible(all), [1, 2, 3, 4, 7, 8]);
    // An empty earliest interval still sets the boundary: messages 5 to 8 of the gap stay hidden under all.
    const emptyFirst = [interval(5, 4), interval(9, null)];
    assert.deepEqual([1, 4, 5, 8, 9].filter(seq => inRanges(seq, permittedRanges(emptyFirst, 'all'))), [1, 4, 9]);
    assert.deepEqual([1, 4, 5, 8, 9].filter(seq => inRanges(seq, permittedRanges(emptyFirst, 'from_joined'))), [9]);
});

test('permittedRanges refuses malformed intervals and policies, and inRanges admits only sequences', () => {
    const refused = [
        [[interval(3, 6), interval(5, null)], RangeError], // overlap
        [[interval(3, null), interval(8, null)], RangeError], // two open intervals
        [[interval(3, null), interval(8, 9)], RangeError], // open interval before a closed one
        [[interval(3, 6), interval(6, 7)], RangeError], // shared boundary
        [[interval(0, null)], RangeError],
        [[interval(5, 3)], RangeError], // last_seq below first_seq - 1
        [[interval(1.5, null)], RangeError],
        [[{ first_seq: 3 }], TypeError], // a missing last_seq is never read as open
        [[{ firstSeq: 3, lastSeq: null }], TypeError],
        [[null], TypeError],
    ];
    for (const [intervals, kind] of refused) {
        for (const historyPolicy of HISTORY_POLICIES) assert.throws(() => permittedRanges(intervals, historyPolicy), kind, JSON.stringify(intervals));
    }
    for (const bad of ['ALL', 'From_joined', null, undefined, '']) assert.throws(() => permittedRanges([], bad), TypeError);
    assert.throws(() => permittedRanges('3..4', 'all'), TypeError);

    const open = permittedRanges([interval(2, null)], 'from_joined');
    assert.equal(inRanges(Number.MAX_SAFE_INTEGER, open), true);
    for (const seq of [0, -1, 1.5, '3', NaN, null, undefined, Number.MAX_SAFE_INTEGER + 1]) assert.equal(inRanges(seq, permittedRanges([interval(1, null)], 'all')), false);
    assert.equal(inRanges(1, []), false);
    assert.throws(() => inRanges(1, null), TypeError);
});

const CREATED = '2025-01-01T00:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);
const EXPIRY_MS = INVITATION_EXPIRY_SECONDS * 1000;
const acceptable = () => ({
    now: CREATED_MS + 1000,
    invitation: { state: 'pending', createdAt: CREATED, expiresAt: '2025-01-08T00:00:00.000Z' },
    group: { archived: false },
    inviter: { role: 'admin' },
    invitee: { active: false, leftAt: null },
    blocked: false,
    activeMembers: 49,
    maxMembers: 50,
});
// One change per re-validation check of DB5-R04.8 and R04.10 that fails it, in the order of INVITATION_CHECKS.
const FAILURES = [
    ['inviteeNotMember', state => { state.invitee.active = true; }],
    ['groupExists', state => { state.group = null; }],
    ['groupNotArchived', state => { state.group.archived = true; }],
    ['inviterActive', state => { state.inviter = null; }],
    ['inviterMayInvite', state => { state.inviter.role = 'member'; }],
    ['noBlock', state => { state.blocked = true; }],
    ['memberMaximum', state => { state.activeMembers = 50; }],
    ['inviteeNotRemovedSinceCreation', state => { state.invitee.leftAt = CREATED; }],
];

test('invitationRevalidation names the failing check and answers expired or cancelled (DB5-R04.8 to R04.10)', t => {
    t.diagnostic(`checks in order: ${INVITATION_CHECKS.join(', ')}`);
    assert.deepEqual(INVITATION_CHECKS.slice(2), FAILURES.map(([check]) => check));
    assert.deepEqual(invitationRevalidation(acceptable()), { ok: true, check: null, outcome: 'accepted' });
    t.diagnostic('| failing check | before the expiry | at the expiry |');
    for (const [check, change] of FAILURES) {
        const early = acceptable();
        change(early);
        const late = acceptable();
        change(late);
        late.now = CREATED_MS + EXPIRY_MS;
        const before = invitationRevalidation(early);
        const after = invitationRevalidation(late);
        t.diagnostic(`| ${check} | ${before.check} -> ${before.outcome} | ${after.check} -> ${after.outcome} |`);
        assert.deepEqual(before, { ok: false, check, outcome: 'cancelled' });
        assert.deepEqual(after, { ok: false, check: 'unexpired', outcome: 'expired' });
    }
    for (const state of ['accepted', 'declined', 'cancelled', 'expired', 'PENDING']) {
        const input = acceptable();
        input.invitation.state = state;
        assert.deepEqual(invitationRevalidation(input), { ok: false, check: 'pending', outcome: 'unchanged' }, state);
    }
    const owner = acceptable();
    owner.inviter.role = 'owner';
    assert.equal(invitationRevalidation(owner).ok, true);
    const removedBefore = acceptable();
    removedBefore.invitee.leftAt = CREATED_MS - 1;
    assert.equal(invitationRevalidation(removedBefore).ok, true);
    const removedAfter = acceptable();
    removedAfter.invitee.leftAt = '2025-01-02T00:00:00.000Z';
    assert.equal(invitationRevalidation(removedAfter).check, 'inviteeNotRemovedSinceCreation');
    for (const value of [1, 'false', undefined, null]) {
        const blocked = acceptable();
        blocked.blocked = value;
        assert.equal(invitationRevalidation(blocked).check, 'noBlock', String(value));
    }
});

test('the expiry is the creation time plus INVITATION_EXPIRY_SECONDS with the injected time as a parameter', () => {
    const at = (now, expiresAt) => {
        const state = acceptable();
        state.now = now;
        state.invitation.expiresAt = expiresAt;
        return invitationRevalidation(state);
    };
    for (const expiresAt of ['2025-01-08T00:00:00.000Z', null, undefined, CREATED_MS + EXPIRY_MS]) {
        assert.equal(at(CREATED_MS + EXPIRY_MS - 1, expiresAt).ok, true, String(expiresAt));
        assert.equal(at(CREATED_MS + EXPIRY_MS, expiresAt).outcome, 'expired', String(expiresAt)); // R04.15: at or after
        assert.equal(at('2025-01-08T00:00:00.000Z', expiresAt).outcome, 'expired', String(expiresAt));
    }
    // A stored expiry later than the fixed duration does not extend it; an earlier one applies.
    assert.equal(at(CREATED_MS + EXPIRY_MS, '2025-01-09T00:00:00.000Z').outcome, 'expired');
    assert.equal(at(CREATED_MS + 2000, CREATED_MS + 2000).outcome, 'expired');
    const missing = acceptable();
    delete missing.now;
    assert.throws(() => invitationRevalidation(missing), TypeError);
    for (const now of ['2025-01-01', '2025-01-01T00:00:00+01:00', 1.5, NaN, {}]) assert.throws(() => at(now, null), TypeError, String(now));
    const noLeftAt = acceptable();
    delete noLeftAt.invitee.leftAt;
    assert.throws(() => invitationRevalidation(noLeftAt), TypeError);
    assert.throws(() => invitationRevalidation(null), TypeError);
});

// ---------------------------------------------------------------------------------------------------------------
// T-5B-10 (DB5-R15.6, NFR-07): support/random.js, the seeded generator and the forAll runner.
// ---------------------------------------------------------------------------------------------------------------
// Every drawing function once per round, then a fork.
function drawSequence(random) {
    const draws = [];
    for (let round = 0; round < DETERMINISM_DRAWS; round += 1) {
        draws.push(random.int(0, 0xffffffff), random.int(-5, 5), random.int(0, Number.MAX_SAFE_INTEGER), random.bool(0.3),
            random.pick(['owner', 'admin', 'member']), random.weighted([['invite', 3], ['never', 0], ['remove', 1]]),
            random.shuffle([1, 2, 3, 4, 5]), random.string('ab\u00e9\u{1f600}', 0, 6), random.bytes(7).toString('hex'));
    }
    draws.push(random.fork('child').int(0, 0xffffffff));
    return draws;
}
// mulberry32 as published (Tommy Ettinger, public domain), transcribed independently of support/random.js.
function referenceMulberry32(a) {
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (t ^ (t >>> 14)) >>> 0;
    };
}
const outputs = (random, length) => Array.from({ length }, () => random.int(0, 0xffffffff));
// A generated operation list for the forAll checks: labels only.
const harnessCase = random => Array.from({ length: random.int(1, 4) }, () => ({
    op: random.weighted([['invite', 3], ['accept', 2], ['remove', 1]]),
    actor: `user-${random.int(1, 6)}`,
}));
const opLine = (op, index) => `  ${index}: { op: '${op.op}', actor: '${op.actor}' }`;
const badArgument = error => error instanceof TypeError || error instanceof RangeError;

test('T-5B-10: support/random.js uses no Math.random, no Date.now or other clock and no network', () => {
    const source = fs.readFileSync(RANDOM_FILE, 'utf8');
    assert.match(source, /^[\x00-\x7f]*$/, 'random.js is ASCII only');
    assert.doesNotMatch(source, /Math\.random|\bcrypto\b|randomBytes|randomUUID|getRandomValues/);
    assert.doesNotMatch(source, /Date\.now|\bDate\b|performance|hrtime|setTimeout|setInterval|setImmediate/);
    assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket|\b(net|http|https|http2|dgram|dns|tls|child_process|worker_threads|cluster)\b/);
    assert.doesNotMatch(source, /\bimport\b|\beval\b|\bFunction\s*\(/);
    const required = [...source.matchAll(/\brequire\s*\(\s*'([^']+)'\s*\)/g)].map(match => match[1]);
    assert.deepEqual(required, ['node:util'], 'the only module is node:util');
    assert.equal((source.match(/\brequire\s*\(/g) || []).length, required.length, 'every require names a literal module');
    assert.equal(require.cache[RANDOM_FILE].children.length, 0, 'random.js loads no file module');
});

test('T-5B-10: one seed gives one sequence twice and different seeds give different sequences', t => {
    const sequences = new Set();
    for (const seed of DETERMINISM_SEEDS) {
        const first = drawSequence(createRandom(seed));
        const second = drawSequence(createRandom(seed));
        assert.deepEqual(second, first, `seed=${seed}`);
        t.diagnostic(`seed=${seed} first draws ${first.slice(0, 4).join(' ')} (twice)`);
        sequences.add(JSON.stringify(first));
    }
    assert.equal(sequences.size, DETERMINISM_SEEDS.length);

    // fork(label) depends on the seed and the label only and does not advance the parent.
    const parent = createRandom(HARNESS_SEED);
    const users = outputs(parent.fork('users'), 5);
    assert.deepEqual(outputs(parent.fork('users'), 5), users);
    assert.notDeepEqual(outputs(parent.fork('groups'), 5), users);
    assert.notDeepEqual(outputs(createRandom(HARNESS_SEED + 1).fork('users'), 5), users);
    assert.deepEqual(outputs(parent, 5), outputs(createRandom(HARNESS_SEED), 5));
    assert.equal(parent.seed, HARNESS_SEED);
    assert.ok(Object.isFrozen(parent));
});

test('T-5B-10: createRandom is mulberry32 and int(0, 2^32 - 1) returns its raw 32-bit output', () => {
    for (const seed of DETERMINISM_SEEDS) {
        const reference = referenceMulberry32(seed);
        const random = createRandom(seed);
        for (let index = 0; index < REFERENCE_OUTPUTS; index += 1) assert.equal(random.int(0, 0xffffffff), reference(), `seed=${seed} output ${index}`);
    }
});

test('T-5B-10: the drawing functions stay in range and refuse bad arguments', () => {
    const alphabet = 'xy\u00e9\u{1f600}';
    for (const seed of DETERMINISM_SEEDS) {
        const random = createRandom(seed);
        const small = new Set();
        for (let index = 0; index < RANGE_DRAWS; index += 1) {
            const value = random.int(-2, 1);
            assert.ok(Number.isInteger(value) && value >= -2 && value <= 1, String(value));
            small.add(value);
            const wide = random.int(-1, Number.MAX_SAFE_INTEGER - 1);
            assert.ok(Number.isSafeInteger(wide) && wide >= -1 && wide <= Number.MAX_SAFE_INTEGER - 1, String(wide));
            assert.equal(random.int(9, 9), 9);
            assert.equal(random.bool(0), false);
            assert.equal(random.bool(1), true);
            assert.ok(['a', 'b'].includes(random.weighted([['never', 0], ['a', 1], ['b', 2.5], ['also never', 0]])));
            assert.deepEqual([...random.shuffle(['a', 'b', 'c', 'd'])].sort(), ['a', 'b', 'c', 'd']);
            const characters = Array.from(random.string(alphabet, 2, 5));
            assert.ok(characters.length >= 2 && characters.length <= 5);
            assert.ok(characters.every(character => Array.from(alphabet).includes(character)));
            assert.equal(random.string(['ab', 'c'], 3, 3).replace(/ab|c/g, ''), '');
            const bytes = random.bytes(index % 9);
            assert.ok(Buffer.isBuffer(bytes));
            assert.equal(bytes.length, index % 9);
        }
        assert.deepEqual([...small].sort((a, b) => a - b), [-2, -1, 0, 1]);
    }
    const frozen = Object.freeze([1, 2, 3]);
    assert.deepEqual([...createRandom(1).shuffle(frozen)].sort(), [1, 2, 3]); // the input list is not changed
    const random = createRandom(1);
    const refused = [
        () => random.int(1, 0), () => random.int(0.5, 1), () => random.int(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        () => random.bool(1.5), () => random.bool('0.5'), () => random.pick([]), () => random.pick('abc'),
        () => random.weighted([['a', 0]]), () => random.weighted([['a', -1]]), () => random.weighted([['a']]), () => random.weighted([]),
        () => random.string('', 0, 1), () => random.string('ab', 3, 2), () => random.string(['a', ''], 0, 1), () => random.bytes(-1),
        () => random.fork(7), () => createRandom(-1), () => createRandom(2 ** 32), () => createRandom(1.5), () => createRandom('1'),
        () => deriveRunSeed(1, -1), () => deriveRunSeed(1, 2 ** 32 - 1), () => deriveRunSeed(2 ** 32, 0),
    ];
    for (const call of refused) assert.throws(call, badArgument, call.toString());
});

test('T-5B-10: forAll derives each run seed from the base seed and the run index and awaits async checks', async () => {
    const collect = async () => {
        const seen = [];
        const lines = [];
        let active = 0;
        const summary = await forAll('T-5B-10-derive', { runs: HARNESS_RUNS, seed: HARNESS_SEED, env: {}, onRun: line => lines.push(line) },
            harnessCase, async (ops, info) => {
                active += 1;
                await Promise.resolve();
                assert.equal(active, 1, 'runs are sequential');
                seen.push({ run: info.run, runSeed: info.runSeed, ops });
                active -= 1;
            });
        return { seen, lines, summary };
    };
    const first = await collect();
    assert.deepEqual(await collect(), first, 'one seed gives one sequence of cases twice');
    assert.deepEqual(first.summary, { property: 'T-5B-10-derive', seed: HARNESS_SEED, runs: HARNESS_RUNS, replay: null });
    assert.deepEqual(first.seen.map(item => item.run), Array.from({ length: HARNESS_RUNS }, (_, run) => run));
    for (const { run, runSeed, ops } of first.seen) {
        assert.equal(runSeed, deriveRunSeed(HARNESS_SEED, run));
        assert.deepEqual(ops, harnessCase(createRandom(runSeed)));
        assert.equal(first.lines[run], `property=T-5B-10-derive seed=${HARNESS_SEED} run=${run} runSeed=${runSeed}`);
        assert.equal(first.lines[run], seedLine('T-5B-10-derive', HARNESS_SEED, run, runSeed));
    }
    assert.equal(new Set(first.seen.map(item => item.runSeed)).size, HARNESS_RUNS);

    let count = 0;
    await forAll('T-5B-10-default', { seed: HARNESS_SEED, env: {} }, random => random.int(0, 9), () => { count += 1; });
    assert.equal(DEFAULT_RUNS, 100);
    assert.equal(count, DEFAULT_RUNS, 'runs defaults to 100');
});

test('T-5B-10: a failing run prints one seed line and the operation list, and PROPERTY_SEED with PROPERTY_RUN replays it', async t => {
    const planted = (ops, info) => assert.notEqual(info.run, HARNESS_FAILING_RUN, 'planted failure');
    const runSeed = deriveRunSeed(HARNESS_SEED, HARNESS_FAILING_RUN);
    const line = `property=P-demo seed=${HARNESS_SEED} run=${HARNESS_FAILING_RUN} runSeed=${runSeed}`;
    const ops = harnessCase(createRandom(runSeed));
    const printed = [];
    const checked = [];
    let failure;
    await assert.rejects(forAll('P-demo', { runs: HARNESS_RUNS, seed: HARNESS_SEED, env: {}, log: entry => printed.push(entry) }, harnessCase,
        (value, info) => { checked.push(info.run); planted(value, info); }), error => { failure = error; return true; });
    for (const entry of printed) t.diagnostic(entry);
    assert.ok(failure instanceof PropertyFailure);
    assert.deepEqual(printed, [line, ...ops.map(opLine)]);
    assert.equal(printed.filter(entry => entry.startsWith('property=')).length, 1);
    assert.deepEqual(checked, Array.from({ length: HARNESS_FAILING_RUN + 1 }, (_, run) => run), 'forAll stops at the first failure');
    assert.deepEqual({ property: failure.property, seed: failure.seed, run: failure.run, runSeed: failure.runSeed, line: failure.line },
        { property: 'P-demo', seed: HARNESS_SEED, run: HARNESS_FAILING_RUN, runSeed, line });
    assert.deepEqual(failure.message.split('\n').slice(0, printed.length), printed);
    assert.match(failure.message, /planted failure/);
    assert.equal(failure.cause.code, 'ERR_ASSERTION');

    // Replay through options.env: PROPERTY_SEED replaces the file seed 999 and PROPERTY_RUN runs only that index.
    const replayed = [];
    const replayPrinted = [];
    const env = { PROPERTY_SEED: String(HARNESS_SEED), PROPERTY_RUN: String(HARNESS_FAILING_RUN) };
    await assert.rejects(forAll('P-demo', { runs: HARNESS_RUNS, seed: 999, env, log: entry => replayPrinted.push(entry) }, harnessCase,
        (value, info) => { replayed.push({ run: info.run, runSeed: info.runSeed, value }); planted(value, info); }), PropertyFailure);
    assert.deepEqual(replayed, [{ run: HARNESS_FAILING_RUN, runSeed, value: ops }]);
    assert.deepEqual(replayPrinted, printed);

    // Replay through the process environment, as `PROPERTY_SEED=<base> PROPERTY_RUN=<index> node --test` does.
    const saved = { PROPERTY_SEED: process.env.PROPERTY_SEED, PROPERTY_RUN: process.env.PROPERTY_RUN };
    Object.assign(process.env, env);
    try {
        const cases = [];
        const summary = await forAll('P-demo', { runs: HARNESS_RUNS, seed: 999 }, harnessCase, value => { cases.push(value); });
        assert.deepEqual(summary, { property: 'P-demo', seed: HARNESS_SEED, runs: 1, replay: HARNESS_FAILING_RUN });
        assert.deepEqual(cases, [ops]);
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }

    // PROPERTY_SEED alone replaces the base seed of every run; an empty value counts as unset.
    const runSeeds = [];
    const summary = await forAll('P-demo', { runs: 3, seed: 999, env: { PROPERTY_SEED: '5', PROPERTY_RUN: '' } }, harnessCase,
        (value, info) => { runSeeds.push(info.runSeed); });
    assert.deepEqual(runSeeds, [0, 1, 2].map(run => deriveRunSeed(5, run)));
    assert.deepEqual(summary, { property: 'P-demo', seed: 5, runs: 3, replay: null });
});

test('T-5B-10: forAll refuses bad settings before any run and fails on false, a rejection or a generator error', async () => {
    let calls = 0;
    const count = () => { calls += 1; };
    for (const PROPERTY_SEED of ['abc', '-1', '1.5', ' 7', '4294967296']) {
        await assert.rejects(forAll('P-x', { seed: 1, env: { PROPERTY_SEED } }, count, count), RangeError, PROPERTY_SEED);
    }
    for (const PROPERTY_RUN of ['x', '-2', '4294967295']) {
        await assert.rejects(forAll('P-x', { seed: 1, env: { PROPERTY_RUN } }, count, count), RangeError, PROPERTY_RUN);
    }
    const badOptions = [{ env: {} }, { seed: -1, env: {} }, { seed: 2 ** 32, env: {} }, { seed: '1', env: {} }, { seed: 1, runs: 0, env: {} },
        { seed: 1, runs: 1.5, env: {} }, { seed: 1, env: {}, log: 'stderr' }, { seed: 1, env: null }, null];
    for (const options of badOptions) await assert.rejects(forAll('P-x', options, count, count), badArgument, JSON.stringify(options));
    for (const id of ['', 'P x', 'P-\u00e9', 'P-1\n', 7]) await assert.rejects(forAll(id, { seed: 1, env: {} }, count, count), TypeError, String(id));
    await assert.rejects(forAll('P-x', { seed: 1, env: {} }, count), TypeError);
    assert.equal(calls, 0, 'nothing ran');

    const printed = [];
    const log = entry => printed.push(entry);
    await assert.rejects(forAll('P-false', { seed: 1, runs: 3, env: {}, log, describe: value => `value=${value}` }, random => random.int(0, 9), () => false),
        error => error instanceof PropertyFailure && error.run === 0 && /check returned false/.test(error.message));
    assert.deepEqual(printed, [`property=P-false seed=1 run=0 runSeed=${deriveRunSeed(1, 0)}`, `  value=${createRandom(deriveRunSeed(1, 0)).int(0, 9)}`]);
    await assert.rejects(forAll('P-reject', { seed: 1, runs: 3, env: {}, log: () => {} }, random => random.int(0, 9), async (value, info) => {
        if (info.run === 2) throw new Error('async refusal');
    }), error => error instanceof PropertyFailure && error.run === 2 && error.cause.message === 'async refusal');
    printed.length = 0;
    await assert.rejects(forAll('P-generate', { seed: 1, env: {}, log }, () => { throw new Error('no case'); }, count),
        error => error instanceof PropertyFailure && error.cause.message === 'no case');
    assert.deepEqual(printed, [`property=P-generate seed=1 run=0 runSeed=${deriveRunSeed(1, 0)}`, '  (generation failed)']);
    assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// T-5B-13 (DB5-R01.4 to R01.7, R01.12, R01.15, DB5-R02.5 to R02.7, R02.10, R02.13, R02.14, DB5-R03.7, DB5-R06.4,
// R06.9, DB5-R10.4, DB5-R13.4): the request validators of server/groups/validation.js, each at its limits. No
// database, HTTP, clock or network is used. The refusal order between layers is the Group_Service's (DB-5C) and is
// not tested here.
// ---------------------------------------------------------------------------------------------------------------
const querystring = require('node:querystring');
const VALIDATION_FILE = require.resolve('../server/groups/validation');
const groupValidation = require('../server/groups/validation');
const groupCursor = require('../server/groups/cursor');
const { AuthError } = require('../server/auth/errors');
const {
    FIELD_NAME, NAME_MAX, DESCRIPTION_MAX, IDEMPOTENCY_KEY_MAX, LIMIT_DEFAULT, LIMIT_MAX, DEFAULT_HISTORY_POLICY,
    ASSIGNABLE_ROLES, CURSOR_SHAPES, createBody, patchBody, pathId, listQuery, membersQuery, memberBody, invitationBody,
    roleChangeBody, transferBody, readPositionBody,
} = groupValidation;
// The field-name pattern of the task, written here independently of the module.
const FIELD_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
const SMILE = '\u{1f600}'; // one code point, two UTF-16 code units
const times = (text, count) => text.repeat(count);
const GROUPS_CONTEXT = Object.freeze({ route: 'groups', userId: 'user-1' });
const STAMP = '2025-01-02T03:04:05.678Z';
const token = (last, context = GROUPS_CONTEXT, highWater) => groupCursor.encode(highWater === undefined ? { last } : { last, highWater }, context);
// Bodies that are not a plain object of enumerable data properties with string keys.
const NOT_PLAIN = () => [
    undefined, null, 'Team', 7, true, [], [{ name: 'Team' }], new Map([['name', 'Team']]), Object.create({ name: 'Team' }),
    new (class Body { constructor() { this.name = 'Team'; } })(),
    { get name() { return 'Team'; } },
    Object.defineProperty({}, 'name', { value: 'Team', enumerable: false }),
    { name: 'Team', [Symbol('extra')]: 1 },
];

// The fields of the VALIDATION_ERROR that call throws. Fails when the call returns or throws anything else, and when a
// named field does not match the field-name pattern.
function fieldsOf(call) {
    let error = null;
    try {
        call();
    } catch (caught) {
        error = caught;
    }
    assert.ok(error, 'expected a VALIDATION_ERROR, the call returned');
    assert.ok(error instanceof AuthError, `expected an AuthError, got ${error && error.name}`);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.status, 400);
    assert.ok(Array.isArray(error.fields));
    for (const field of error.fields) assert.match(field, FIELD_PATTERN);
    return error.fields;
}
function cursorFault(call) {
    let error = null;
    try {
        call();
    } catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof groupCursor.CursorError, `expected a CursorError, got ${error && error.name}`);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.status, 400);
    assert.deepEqual(error.fields, ['cursor']);
    return error.reason;
}

test('T-5B-13: validation.js is ASCII, loads only the error, social, cursor and policy modules and reads no clock or environment', () => {
    const source = fs.readFileSync(VALIDATION_FILE, 'utf8');
    assert.match(source, /^[\x00-\x7f]*$/, 'validation.js is ASCII only');
    const required = [...source.matchAll(/\brequire\s*\(\s*'([^']+)'\s*\)/g)].map(match => match[1]);
    assert.deepEqual(required, ['../auth/errors', '../social/validation', './cursor', './policy']);
    assert.equal((source.match(/\brequire\s*\(/g) || []).length, required.length, 'every require names a literal module');
    assert.doesNotMatch(source, /\bprocess\b|\bDate\b|Math\.random|performance|hrtime|setTimeout|setInterval|\bimport\b|\beval\b/);
    assert.ok(Object.isFrozen(groupValidation));
    assert.equal(FIELD_NAME.source, FIELD_PATTERN.source);
    assert.deepEqual([NAME_MAX, DESCRIPTION_MAX, IDEMPOTENCY_KEY_MAX, LIMIT_DEFAULT, LIMIT_MAX], [100, 1000, 256, 20, 50]);
    assert.equal(DEFAULT_HISTORY_POLICY, 'from_joined');
    assert.ok(HISTORY_POLICIES.includes(DEFAULT_HISTORY_POLICY));
    assert.deepEqual(ASSIGNABLE_ROLES, ['admin', 'member']);
    assertDeepFrozen(CURSOR_SHAPES);
    for (const route of Object.keys(CURSOR_SHAPES)) assert.ok(groupCursor.ROUTE_KINDS.includes(route), route);
});

test('T-5B-13: createBody trims the name, applies the defaults and accepts every field at its limit', () => {
    const minimal = createBody({ name: 'Team' });
    assert.deepEqual(minimal, { name: 'Team', description: null, historyPolicy: 'from_joined', idempotencyKey: null });
    assert.ok(Object.isFrozen(minimal));
    assert.deepEqual(createBody({ name: ' Club ', description: 'About us', historyPolicy: 'all', idempotencyKey: 'key-1' }),
        { name: 'Club', description: 'About us', historyPolicy: 'all', idempotencyKey: 'key-1' });
    assert.equal(createBody({ name: ' \t Team \r\n\u3000' }).name, 'Team');
    assert.equal(createBody({ name: 'a' }).name, 'a');
    for (const name of [times('n', NAME_MAX), times(SMILE, NAME_MAX), `  ${times('n', NAME_MAX)}\t`, `${times(SMILE, NAME_MAX - 1)}n`]) {
        assert.equal([...createBody({ name }).name].length, NAME_MAX);
    }
    for (const description of ['', 'line one\nline two\r\n\tindented', times('d', DESCRIPTION_MAX), times(SMILE, DESCRIPTION_MAX), '  kept as sent  ']) {
        assert.equal(createBody({ name: 'T', description }).description, description); // not trimmed
    }
    assert.equal(createBody({ name: 'T', description: null }).description, null);
    for (const historyPolicy of ['all', 'from_joined']) assert.equal(createBody({ name: 'T', historyPolicy }).historyPolicy, historyPolicy);
    for (const idempotencyKey of ['k', times('k', IDEMPOTENCY_KEY_MAX), times(SMILE, IDEMPOTENCY_KEY_MAX), ' ']) {
        assert.equal(createBody({ name: 'T', idempotencyKey }).idempotencyKey, idempotencyKey);
    }
    assert.equal(createBody(Object.assign(Object.create(null), { name: 'T' })).name, 'T'); // a null-prototype object is plain
    assert.equal(createBody(JSON.parse('{"name":"T","historyPolicy":"all"}')).historyPolicy, 'all');
});

test('T-5B-13: createBody refuses each field past its limit, names it and names unknown fields', () => {
    for (const name of ['', '   ', '\t\n', times('n', NAME_MAX + 1), times(SMILE, NAME_MAX + 1), `${times(SMILE, NAME_MAX)}n`, 'Te\nam',
        'Te\u0007am', 'Te\u007fam', '\u0085Team', 'Te\u009fam', '\u0000', 'a\ud800', '\udc00a', 7, null, true, ['Team'], { name: 'Team' },
        new String('Team')]) {
        assert.deepEqual(fieldsOf(() => createBody({ name })), ['name'], JSON.stringify(name));
    }
    assert.deepEqual(fieldsOf(() => createBody({})), ['name']);
    assert.deepEqual(fieldsOf(() => createBody({ description: 'x' })), ['name']);
    for (const description of [times('d', DESCRIPTION_MAX + 1), times(SMILE, DESCRIPTION_MAX + 1), 'a\u0000b', 'a\u000bb', 'a\u000cb',
        'a\u001fb', 'a\u007fb', 'a\u0080b', 'a\u0085b', 'a\u009fb', 'a\ud800', 5, false, [], {}]) {
        assert.deepEqual(fieldsOf(() => createBody({ name: 'T', description })), ['description'], JSON.stringify(description));
    }
    // DB5-R01.15: exactly all or from_joined; null counts as supplied.
    for (const historyPolicy of [null, 'ALL', 'All', 'From_joined', 'FROM_JOINED', 'from-joined', 'fromJoined', '', ' all', 'all ',
        'none', 0, 1, true, ['all'], { all: true }, new String('all')]) {
        assert.deepEqual(fieldsOf(() => createBody({ name: 'T', historyPolicy })), ['historyPolicy'], JSON.stringify(historyPolicy));
    }
    assert.deepEqual(fieldsOf(() => createBody({ name: 'T', historyPolicy: undefined })), ['historyPolicy']); // the key is present
    for (const idempotencyKey of ['', times('k', IDEMPOTENCY_KEY_MAX + 1), times(SMILE, IDEMPOTENCY_KEY_MAX + 1), 'key\ud800', null, 5, [], {}]) {
        assert.deepEqual(fieldsOf(() => createBody({ name: 'T', idempotencyKey })), ['idempotencyKey'], JSON.stringify(idempotencyKey));
    }
    assert.deepEqual(fieldsOf(() => createBody({ name: 'T', role: 'owner' })), ['role']);
    assert.deepEqual(fieldsOf(() => createBody({ name: 'T', membershipRevision: 1 })), ['membershipRevision']);
    const longest = `a${times('b', 63)}`;
    assert.deepEqual(fieldsOf(() => createBody({ name: 'T', [longest]: 1 })), [longest]);
    // A key that does not match the field-name pattern is refused and never reflected.
    for (const key of ['a b', `${longest}c`, '1abc', 'a_b', 'a-b', 'na\u00efve', '']) {
        assert.deepEqual(fieldsOf(() => createBody({ name: 'T', [key]: 1 })), [], JSON.stringify(key));
    }
    assert.deepEqual(fieldsOf(() => createBody(JSON.parse('{"name":"T","__proto__":{"name":"x"}}'))), []);
    // Every offending field at once: documented order first, then unknown keys in key order.
    assert.deepEqual(fieldsOf(() => createBody({ zeta: 1, idempotencyKey: '', historyPolicy: null, description: 1, name: '', alpha: 2 })),
        ['name', 'description', 'historyPolicy', 'idempotencyKey', 'zeta', 'alpha']);
    for (const body of NOT_PLAIN()) assert.deepEqual(fieldsOf(() => createBody(body)), []);
});

test('T-5B-13: patchBody accepts name, description and the revision precondition and refuses historyPolicy whatever its value', () => {
    const renamed = patchBody({ name: ' New name ' });
    assert.deepEqual(renamed, { changes: { name: 'New name' }, membershipRevision: null });
    assert.ok(Object.isFrozen(renamed) && Object.isFrozen(renamed.changes));
    assert.deepEqual(patchBody({ description: null }), { changes: { description: null }, membershipRevision: null });
    assert.deepEqual(patchBody({ name: 'N', description: 'D', membershipRevision: 1 }), { changes: { name: 'N', description: 'D' }, membershipRevision: 1 });
    assert.equal(patchBody({ description: '', membershipRevision: Number.MAX_SAFE_INTEGER }).membershipRevision, Number.MAX_SAFE_INTEGER);
    assert.equal(patchBody({ name: times(SMILE, NAME_MAX) }).changes.name, times(SMILE, NAME_MAX));
    assert.equal(patchBody({ description: times('d', DESCRIPTION_MAX) }).changes.description.length, DESCRIPTION_MAX);
    // DB5-R02.14: the limits of DB5-R01.4 to R01.6.
    assert.deepEqual(fieldsOf(() => patchBody({ name: times('n', NAME_MAX + 1) })), ['name']);
    assert.deepEqual(fieldsOf(() => patchBody({ name: '  ' })), ['name']);
    assert.deepEqual(fieldsOf(() => patchBody({ name: null })), ['name']);
    assert.deepEqual(fieldsOf(() => patchBody({ description: times('d', DESCRIPTION_MAX + 1) })), ['description']);
    assert.deepEqual(fieldsOf(() => patchBody({ description: 'a\u0000' })), ['description']);
    // DB5-R02.13: historyPolicy is named for every value, alone or beside a valid change.
    for (const historyPolicy of ['all', 'from_joined', null, 'ALL', '', 0, false, [], {}, undefined]) {
        const label = JSON.stringify(historyPolicy) ?? 'undefined';
        assert.deepEqual(fieldsOf(() => patchBody({ historyPolicy })), ['historyPolicy'], label);
        assert.deepEqual(fieldsOf(() => patchBody({ name: 'N', historyPolicy })), ['historyPolicy'], label);
        assert.deepEqual(fieldsOf(() => patchBody({ name: 'N', description: 'D', membershipRevision: 2, historyPolicy })), ['historyPolicy'], label);
        assert.deepEqual(fieldsOf(() => patchBody({ name: '', historyPolicy })), ['name', 'historyPolicy'], label);
    }
    // DB5-R02.10: neither name nor description.
    assert.deepEqual(fieldsOf(() => patchBody({})), []);
    assert.deepEqual(fieldsOf(() => patchBody({ membershipRevision: 4 })), []);
    for (const membershipRevision of [0, -1, -0, 1.5, '3', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, [3]]) {
        assert.deepEqual(fieldsOf(() => patchBody({ name: 'N', membershipRevision })), ['membershipRevision'], String(membershipRevision));
    }
    assert.deepEqual(fieldsOf(() => patchBody({ name: 'N', idempotencyKey: 'k' })), ['idempotencyKey']);
    assert.deepEqual(fieldsOf(() => patchBody({ name: 'N', role: 'admin' })), ['role']);
    assert.deepEqual(fieldsOf(() => patchBody({ extra: 1, membershipRevision: 'x', historyPolicy: 'all', description: 1, name: 7 })),
        ['name', 'description', 'historyPolicy', 'membershipRevision', 'extra']);
    for (const body of NOT_PLAIN()) assert.deepEqual(fieldsOf(() => patchBody(body)), []);
});

test('T-5B-13: pathId returns the id for the lookup or null and never throws, so a malformed id meets the one NOT_FOUND', () => {
    for (const id of ['a', 'group-1', '4d3c1f0e-8d2a-4b3c-9e1f-0a1b2c3d4e5f', 'legacy:alice:bob', 'a.b_c', times('a', 1024)]) assert.equal(pathId(id), id);
    for (const value of ['', times('a', 1025), '-a', '.a', 'a b', 'a/b', '../a', 'a%2F', 'gr\u00f6up', 'a\u0000', 'a\ud800', 7, null, undefined,
        {}, [], ['a'], new String('a')]) {
        assert.equal(pathId(value), null, JSON.stringify(value));
    }
});

test('T-5B-13: listQuery bounds limit to 1 to 50 with default 20 and names every unknown parameter', () => {
    const first = listQuery({}, GROUPS_CONTEXT);
    assert.deepEqual(first, { limit: LIMIT_DEFAULT, cursor: null });
    assert.ok(Object.isFrozen(first));
    for (const limit of ['1', '9', '10', '49', '50']) assert.equal(listQuery({ limit }, GROUPS_CONTEXT).limit, Number(limit));
    assert.equal(listQuery(querystring.parse('limit=7'), GROUPS_CONTEXT).limit, 7); // the null-prototype object of the query parser
    for (const limit of ['0', '51', '99', '100', '05', '007', '+1', '-1', '1.0', '1e1', ' 1', '1 ', '', 'ten', '\u0661', ['1', '2'], 5, null]) {
        assert.deepEqual(fieldsOf(() => listQuery({ limit }, GROUPS_CONTEXT)), ['limit'], JSON.stringify(limit));
    }
    assert.deepEqual(fieldsOf(() => listQuery({ offset: '1' }, GROUPS_CONTEXT)), ['offset']);
    assert.deepEqual(fieldsOf(() => listQuery({ limit: '5', former: 'true' }, GROUPS_CONTEXT)), ['former']); // former is G05 only
    assert.deepEqual(fieldsOf(() => listQuery(querystring.parse('limit=5&page=2&sort=name'), GROUPS_CONTEXT)), ['page', 'sort']);
    assert.deepEqual(fieldsOf(() => listQuery({ 'a b': '1', 'x-y': '2' }, GROUPS_CONTEXT)), []);
    assert.deepEqual(fieldsOf(() => listQuery({ zeta: '1', cursor: '!', limit: '0' }, GROUPS_CONTEXT)), ['limit', 'cursor', 'zeta']);
    for (const input of [null, undefined, [], 'limit=1', 5]) assert.deepEqual(fieldsOf(() => listQuery(input, GROUPS_CONTEXT)), []);
});

test('T-5B-13: listQuery decodes the cursor through groups/cursor.js and reports every cursor fault as cursor', () => {
    const last = [STAMP, 'group-9'];
    const page = listQuery({ limit: '5', cursor: token(last) }, GROUPS_CONTEXT);
    assert.deepEqual(page, { limit: 5, cursor: { last } });
    assert.ok(Object.isFrozen(page.cursor));
    const faults = [
        [times('A', groupCursor.MAX_CURSOR_LENGTH + 1), 'TOO_LONG'],
        ['', 'NOT_BASE64URL'],
        ['not base64!', 'NOT_BASE64URL'],
        [`${token(last)}=`, 'NOT_BASE64URL'],
        [Buffer.from('{"v":1}').toString('base64url'), 'MALFORMED'],
        [['a', 'b'], 'MALFORMED'], // a repeated parameter
        [token(last, { route: 'groups', userId: 'user-2' }), 'CONTEXT_MISMATCH'], // issued to another user (DB5-R02.6)
        [token(last, { route: 'own-invitations', userId: 'user-1' }), 'CONTEXT_MISMATCH'], // issued for another route
    ];
    for (const [cursor, reason] of faults) {
        assert.equal(cursorFault(() => listQuery({ cursor }, GROUPS_CONTEXT)), groupCursor.CURSOR_ERROR_CODES[reason], reason);
    }
    // Well-formed tokens of this context that do not hold the cursor structure of GET /api/groups (DB5-R02.6).
    for (const wrong of [[5, 'group-9'], [STAMP], [STAMP, 'group-9', 'extra'], ['2025-01-02T03:04:05Z', 'group-9'],
        ['2025-02-30T00:00:00.000Z', 'group-9'], ['2023-02-29T00:00:00.000Z', 'group-9'], ['2025-01-02T24:00:00.000Z', 'group-9'],
        [STAMP, 'a b'], [STAMP, 7]]) {
        assert.equal(cursorFault(() => listQuery({ cursor: token(wrong) }, GROUPS_CONTEXT)), groupCursor.CURSOR_ERROR_CODES.MALFORMED, JSON.stringify(wrong));
    }
    assert.equal(cursorFault(() => listQuery({ cursor: token(last, GROUPS_CONTEXT, 10) }, GROUPS_CONTEXT)), groupCursor.CURSOR_ERROR_CODES.MALFORMED);
    assert.deepEqual(listQuery({ cursor: token(['2024-02-29T23:59:59.999Z', 'g']) }, GROUPS_CONTEXT).cursor.last, ['2024-02-29T23:59:59.999Z', 'g']);
    // A cursor fault beside another fault is one VALIDATION_ERROR that lists both.
    const mixed = fieldsOf(() => listQuery({ limit: '0', cursor: token(last, { route: 'groups', userId: 'user-2' }) }, GROUPS_CONTEXT));
    assert.deepEqual(mixed, ['limit', 'cursor']);

    // G18 (DB5-R09.6): the message cursor carries a sequence and the high-water.
    const messages = { route: 'group-messages', userId: 'user-1', conversationId: 'group-1' };
    assert.deepEqual(listQuery({ cursor: token([7], messages, 9) }, messages).cursor, { last: [7], highWater: 9 });
    for (const [lastKeys, highWater] of [[[7], undefined], [[0], 9], [['7'], 9], [[7, 8], 9]]) {
        assert.equal(cursorFault(() => listQuery({ cursor: token(lastKeys, messages, highWater) }, messages)), groupCursor.CURSOR_ERROR_CODES.MALFORMED);
    }
    assert.equal(cursorFault(() => listQuery({ cursor: token([7], { ...messages, conversationId: 'group-2' }, 9) }, messages)),
        groupCursor.CURSOR_ERROR_CODES.CONTEXT_MISMATCH);
    // A route kind without a fixed shape is checked by the codec only; a shape argument replaces the table entry.
    const own = { route: 'own-invitations', userId: 'user-1' };
    assert.deepEqual(listQuery({ cursor: token([5, 'x'], own) }, own).cursor, { last: [5, 'x'] });
    assert.equal(cursorFault(() => listQuery({ cursor: token([5, 'x'], own) }, own, { last: ['time', 'id'], highWater: false })),
        groupCursor.CURSOR_ERROR_CODES.MALFORMED);
    assert.deepEqual(listQuery({ cursor: token([5]) }, GROUPS_CONTEXT, null).cursor, { last: [5] });
    // A bad context or shape is a server fault, not a client one.
    assert.throws(() => listQuery({}, { route: 'nope', userId: 'user-1' }), TypeError);
    assert.throws(() => listQuery({}, null), TypeError);
    assert.throws(() => listQuery({ cursor: token(last) }, { route: 'groups' }), TypeError);
    for (const shape of [{ last: ['date'], highWater: false }, { last: [], highWater: false }, { last: ['id'] }, { last: 'time', highWater: false },
        { last: ['seq', 'seq', 'seq', 'seq'], highWater: true }, 'time']) {
        assert.throws(() => listQuery({}, own, shape), TypeError, JSON.stringify(shape));
    }
});

test('T-5B-13: membersQuery reads former as true or false and binds the cursor to the active or the former member list', () => {
    const context = { userId: 'user-1', conversationId: 'group-1' };
    const first = membersQuery({}, context);
    assert.deepEqual(first, { limit: 20, former: false, cursor: null });
    assert.ok(Object.isFrozen(first));
    assert.deepEqual(membersQuery({ former: 'true', limit: '50' }, context), { limit: 50, former: true, cursor: null });
    assert.equal(membersQuery({ former: 'false' }, context).former, false);
    for (const former of ['TRUE', 'True', '1', 'yes', '', ['true', 'true']]) {
        assert.deepEqual(fieldsOf(() => membersQuery({ former }, context)), ['former'], JSON.stringify(former));
    }
    const last = [STAMP, 'user-2'];
    const active = token(last, { route: 'group-members', ...context });
    const former = token([5, 'user-2'], { route: 'group-former-members', ...context }); // no fixed shape yet
    assert.deepEqual(membersQuery({ cursor: active }, context).cursor, { last });
    assert.deepEqual(membersQuery({ cursor: former, former: 'true' }, context).cursor, { last: [5, 'user-2'] });
    const mismatch = groupCursor.CURSOR_ERROR_CODES.CONTEXT_MISMATCH;
    assert.equal(cursorFault(() => membersQuery({ cursor: former }, context)), mismatch);
    assert.equal(cursorFault(() => membersQuery({ cursor: active, former: 'true' }, context)), mismatch);
    assert.equal(cursorFault(() => membersQuery({ cursor: active }, { ...context, conversationId: 'group-2' })), mismatch);
    assert.equal(cursorFault(() => membersQuery({ cursor: token([5, 'user-2'], { route: 'group-members', ...context }) }, context)),
        groupCursor.CURSOR_ERROR_CODES.MALFORMED);
    assert.deepEqual(fieldsOf(() => membersQuery({ former: 'x', cursor: '!' }, context)), ['former']); // the route kind is unknown
    assert.deepEqual(fieldsOf(() => membersQuery({ extra: '1', former: 'x', limit: '51' }, context)), ['limit', 'former', 'extra']);
    assert.throws(() => membersQuery({}, null), TypeError);
});

test('T-5B-13: memberBody and invitationBody accept userId only and name a role field', () => {
    for (const validate of [memberBody, invitationBody]) {
        const result = validate({ userId: 'user-2' });
        assert.deepEqual(result, { userId: 'user-2' });
        assert.ok(Object.isFrozen(result));
        assert.equal(validate({ userId: times('u', 128) }).userId.length, 128);
        assert.deepEqual(fieldsOf(() => validate({ userId: 'user-2', role: 'admin' })), ['role']); // DB5-R03.7
        assert.deepEqual(fieldsOf(() => validate({ role: 'member' })), ['userId', 'role']);
        assert.deepEqual(fieldsOf(() => validate({})), ['userId']);
        for (const userId of ['', times('u', 129), '-user', 'user 2', 'us\u00e9r', 7, null, ['user-2'], { id: 'user-2' }]) {
            assert.deepEqual(fieldsOf(() => validate({ userId })), ['userId'], JSON.stringify(userId));
        }
        assert.deepEqual(fieldsOf(() => validate({ userId: 'user-2', groupId: 'g', message: 'hi' })), ['groupId', 'message']);
        for (const body of NOT_PLAIN()) assert.deepEqual(fieldsOf(() => validate(body)), []);
    }
});

test('T-5B-13: roleChangeBody accepts the role admin or member only and the revision precondition', () => {
    for (const role of ASSIGNABLE_ROLES) assert.deepEqual(roleChangeBody({ role }), { role, membershipRevision: null });
    assert.deepEqual(roleChangeBody({ role: 'admin', membershipRevision: 3 }), { role: 'admin', membershipRevision: 3 });
    assert.ok(Object.isFrozen(roleChangeBody({ role: 'member' })));
    for (const role of ['owner', 'Admin', 'MEMBER', '', ' admin', 'moderator', null, 1, ['admin'], { role: 'admin' }]) {
        assert.deepEqual(fieldsOf(() => roleChangeBody({ role })), ['role'], JSON.stringify(role)); // DB5-R06.4
    }
    assert.deepEqual(fieldsOf(() => roleChangeBody({})), ['role']);
    assert.deepEqual(fieldsOf(() => roleChangeBody({ membershipRevision: 2 })), ['role']);
    assert.deepEqual(fieldsOf(() => roleChangeBody({ role: 'admin', membershipRevision: 0 })), ['membershipRevision']);
    assert.deepEqual(fieldsOf(() => roleChangeBody({ userId: 'u', membershipRevision: '1', role: 'owner' })), ['role', 'membershipRevision', 'userId']);
    for (const body of NOT_PLAIN()) assert.deepEqual(fieldsOf(() => roleChangeBody(body)), []);
});

test('T-5B-13: transferBody needs a userId and accepts the revision precondition', () => {
    assert.deepEqual(transferBody({ userId: 'user-2' }), { userId: 'user-2', membershipRevision: null });
    assert.deepEqual(transferBody({ userId: 'user-2', membershipRevision: Number.MAX_SAFE_INTEGER }),
        { userId: 'user-2', membershipRevision: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(fieldsOf(() => transferBody({})), ['userId']); // DB5-R06.9: target missing
    assert.deepEqual(fieldsOf(() => transferBody({ membershipRevision: 3 })), ['userId']);
    assert.deepEqual(fieldsOf(() => transferBody({ userId: '', membershipRevision: -1 })), ['userId', 'membershipRevision']);
    assert.deepEqual(fieldsOf(() => transferBody({ userId: 'user-2', role: 'owner' })), ['role']);
    for (const body of NOT_PLAIN()) assert.deepEqual(fieldsOf(() => transferBody(body)), []);
});

test('T-5B-13: readPositionBody accepts an integer from 0 and, with bounds, only the high-water and permitted positions', () => {
    assert.deepEqual(readPositionBody({ position: 0 }), { position: 0 });
    assert.equal(readPositionBody({ position: Number.MAX_SAFE_INTEGER }).position, Number.MAX_SAFE_INTEGER);
    assert.ok(Object.is(readPositionBody({ position: -0 }).position, 0));
    assert.ok(Object.isFrozen(readPositionBody({ position: 1 })));
    for (const position of [-1, 1.5, '3', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, [3], {}]) {
        assert.deepEqual(fieldsOf(() => readPositionBody({ position })), ['position'], String(position));
    }
    assert.deepEqual(fieldsOf(() => readPositionBody({})), ['position']);
    assert.deepEqual(fieldsOf(() => readPositionBody({ position: 1, sequence: 1 })), ['sequence']);
    for (const body of NOT_PLAIN()) assert.deepEqual(fieldsOf(() => readPositionBody(body)), []);

    // DB5-R10.4 with the bounds the service reads: member during 3 and 4 and again from 7, high-water 9.
    const intervals = [interval(3, 4), interval(7, null)];
    const fromJoined = { highWater: 9, ranges: permittedRanges(intervals, 'from_joined') };
    for (const position of [0, 3, 4, 7, 9]) assert.equal(readPositionBody({ position }, fromJoined).position, position);
    for (const position of [1, 2, 5, 6, 10]) assert.deepEqual(fieldsOf(() => readPositionBody({ position }, fromJoined)), ['position'], String(position));
    const all = { highWater: 9, ranges: permittedRanges(intervals, 'all') };
    for (const position of [1, 2]) assert.equal(readPositionBody({ position }, all).position, position);
    assert.equal(readPositionBody({ position: 0 }, { highWater: 0, ranges: [] }).position, 0);
    assert.deepEqual(fieldsOf(() => readPositionBody({ position: 1 }, { highWater: 0, ranges: [] })), ['position']);
    assert.deepEqual(fieldsOf(() => readPositionBody({ position: 'x' }, fromJoined)), ['position']);
    for (const bounds of [null, 9, { highWater: -1, ranges: [] }, { highWater: 1 }, { highWater: '1', ranges: [] }, { highWater: 1.5, ranges: [] }]) {
        assert.throws(() => readPositionBody({ position: 0 }, bounds), TypeError, JSON.stringify(bounds));
    }
});

test('T-5B-13: no validator throws anything but VALIDATION_ERROR on hostile input, and no hostile key is reflected', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    // Every trap of this proxy throws: the handler is itself a proxy that answers each trap name with a throwing function.
    const trapped = new Proxy({}, new Proxy({}, { get: () => () => { throw new Error('trap'); } }));
    const cyclic = { name: 'T' };
    cyclic.self = cyclic;
    const values = [
        undefined, null, true, false, 0, -0, 1, -1, 1.5, NaN, Infinity, 2 ** 53, 1n, '', ' ', 'all', 'true', 'admin', times('x', 100000),
        '\ud800', '\u0000', Symbol('s'), () => 'T', [], ['T'], new Map(), new String('T'), new Number(1), Buffer.from('T'),
        Object.create(null), Object.create({ name: 'T' }), revoked.proxy, trapped, cyclic,
        Object.defineProperty({}, 'name', { enumerable: true, get() { throw new Error('getter'); } }),
        Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`k${index}`, index])),
        { [Symbol('k')]: 1 }, JSON.parse('{"__proto__":{"name":"T"}}'),
    ];
    const keys = ['name', 'description', 'historyPolicy', 'idempotencyKey', 'membershipRevision', 'userId', 'role', 'position', 'limit',
        'cursor', 'former', 'unknownKey', 'a b', '__proto__', times('k', 65)];
    const bodies = [
        [createBody, { name: 'T' }], [patchBody, { name: 'T' }], [memberBody, { userId: 'u' }], [invitationBody, { userId: 'u' }],
        [roleChangeBody, { role: 'admin' }], [transferBody, { userId: 'u' }], [readPositionBody, { position: 0 }],
    ];
    const queries = [
        [input => listQuery(input, GROUPS_CONTEXT), { limit: '5' }],
        [input => listQuery(input, { route: 'group-messages', userId: 'u', conversationId: 'g' }), {}],
        [input => membersQuery(input, { userId: 'u', conversationId: 'g' }), { former: 'true' }],
    ];
    let calls = 0;
    const outcome = call => {
        calls += 1;
        try {
            call();
        } catch (error) {
            assert.ok(error instanceof AuthError, `unexpected ${error && error.name}: ${error && error.message}`);
            assert.equal(error.code, 'VALIDATION_ERROR');
            assert.equal(error.status, 400);
            for (const field of error.fields) assert.match(field, FIELD_PATTERN);
        }
    };
    for (const value of values) {
        const id = pathId(value);
        assert.ok(id === null || id === value);
        for (const [validate, base] of [...bodies, ...queries]) {
            outcome(() => validate(value));
            for (const key of keys) {
                outcome(() => validate({ [key]: value }));
                outcome(() => validate({ ...base, [key]: value }));
            }
        }
    }
    assert.ok(calls > 3000, String(calls));
});
