const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = require('../server/features/config');
const { createRandom } = require('./support/random');
const pathAtTop = require('node:path');
const osAtTop = require('node:os');

const { DISABLED_FEATURES, GROUP_API_SETTINGS, ATTACHMENT_API_SETTINGS, FeatureConfigError, loadFeatureConfig } = config;

const SWITCHES = [
    ['groupApi', 'GROUPS_API_ENABLED'],
    ['groupMessaging', 'GROUP_MESSAGING_ENABLED'],
    ['attachmentApi', 'ATTACHMENTS_API_ENABLED']
];
const REMOVED_SETTING = 'GROUP_INVITATION_TTL_SECONDS';
const ATTACHMENT_VALUES = Object.freeze({
    ATTACHMENT_PENDING_TTL_SECONDS:'86400', ATTACHMENT_PURGE_DELAY_SECONDS:'86400', ATTACHMENT_RETENTION_INTERVAL_SECONDS:'3600',
    ATTACHMENT_QUOTA_USER_BYTES:'1073741824', ATTACHMENT_QUOTA_CONVERSATION_BYTES:'5368709120', ATTACHMENT_MAX_PENDING_PER_USER:'10',
    ATTACHMENT_UPLOADS_PER_HOUR:'30', ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER:'2', ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE:'5'
});
const ATTACHMENT_ROOT = fs.mkdtempSync(pathAtTop.join(osAtTop.tmpdir(),'secubuzz-attachment-gate-'));
test.after(() => fs.rmSync(ATTACHMENT_ROOT,{recursive:true,force:true}));
const ATTACHMENT_ENV = Object.freeze({ ...ATTACHMENT_VALUES, ATTACHMENT_STORAGE_DIR:ATTACHMENT_ROOT });
// Valid companion values, so a switch test does not depend on value validation (DB-5C).
const GROUP_VALUES = Object.freeze({
    GROUP_MAX_MEMBERS: '50',
    GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: '20',
    GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: '30'
});
const settingNames = message => message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
// The start-up lines of a loaded configuration: one per switch, in declared order, on or off (T-5C-05).
const switchLines = (...onVariables) => SWITCHES.map(([, variable]) => `Feature switch ${variable}: ${onVariables.includes(variable) ? 'on' : 'off'}`);

function assertDeepFrozen(value) {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) if (child && typeof child === 'object') assertDeepFrozen(child);
}

test('DISABLED_FEATURES reports every function off with empty frozen settings', () => {
    assert.deepEqual(DISABLED_FEATURES, { groupApi: false, groupMessaging: false, attachmentApi: false, groups: {}, attachments: {} });
    assertDeepFrozen(DISABLED_FEATURES);
});

test('the Group_API companion settings are the three required names with no expiry or re-invite delay setting', () => {
    assert.deepEqual(GROUP_API_SETTINGS, ['GROUP_MAX_MEMBERS', 'GROUP_MAX_PENDING_INVITATIONS_PER_GROUP', 'GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE']);
    assert.ok(Object.isFrozen(GROUP_API_SETTINGS));
    assert.ok(!GROUP_API_SETTINGS.some(name => /TTL|EXPIR|DELAY|REINVITE|RE_INVITE/.test(name)));
});

test('a switch is on only for the exact string true', () => {
    const cases = [
        ['unset', undefined, false],
        ['true', 'true', true],
        ['TRUE', 'TRUE', false],
        ['1', '1', false],
        ['empty', '', false],
        ['spaces', '   ', false],
        ['true with spaces', ' true ', false]
    ];
    for (const [key, variable] of SWITCHES) {
        for (const [label, value, expected] of cases) {
            const env = { ...GROUP_VALUES, ...ATTACHMENT_ENV };
            if (value !== undefined) env[variable] = value;
            const features = loadFeatureConfig(env);
            assert.equal(features[key], expected, `${variable} ${label}`);
            for (const [otherKey] of SWITCHES) if (otherKey !== key) assert.equal(features[otherKey], false, `${otherKey} stays off when ${variable} is ${label}`);
        }
    }
});

test('P-26: seeded environment maps enable only the exact string true', () => {
    const seed = 0x5c2644;
    const random = createRandom(seed);
    const values = ['true','TRUE','1','','   ','-1','1.5','9007199254740992'];
    const cases = new Set();
    for (let run = 0; run < 128; run += 1) {
        const env = { ...GROUP_VALUES, ...ATTACHMENT_ENV };
        const drawn = {};
        for (const [key, variable] of SWITCHES) {
            drawn[key] = random.pick(values);
            env[variable] = drawn[key];
        }
        const actual = loadFeatureConfig(env);
        for (const [key] of SWITCHES) assert.equal(actual[key], drawn[key] === 'true', `seed=${seed} run=${run} ${key}`);
        cases.add(Object.values(drawn).join('|'));
    }
    for (const value of values) {
        const env = { ...GROUP_VALUES, ...ATTACHMENT_ENV, GROUPS_API_ENABLED:value, GROUP_MESSAGING_ENABLED:value, ATTACHMENTS_API_ENABLED:value };
        const actual = loadFeatureConfig(env);
        for (const [key] of SWITCHES) assert.equal(actual[key], value === 'true', `${key}=${JSON.stringify(value)}`);
    }
    assert.ok(cases.size > 100, 'the seeded maps cover broad switch combinations');
});

test('an empty environment yields everything disabled and no default for any setting', () => {
    const features = loadFeatureConfig({});
    assert.deepEqual(features, DISABLED_FEATURES);
    assert.deepEqual(Object.keys(features.groups), []);
});

test('loadFeatureConfig returns a frozen result and requires an explicit environment object', () => {
    const features = loadFeatureConfig({ ...GROUP_VALUES, ...ATTACHMENT_ENV, GROUPS_API_ENABLED: 'true', GROUP_MESSAGING_ENABLED: 'true', ATTACHMENTS_API_ENABLED: 'true' });
    assertDeepFrozen(features);
    assert.notEqual(features, DISABLED_FEATURES);
    assert.throws(() => Object.defineProperty(features, 'groupApi', { value: false }), TypeError);
    for (const bad of [undefined, null, 'GROUPS_API_ENABLED=true', 1]) assert.throws(() => loadFeatureConfig(bad), TypeError);
});

test('loadFeatureConfig never reads GROUP_INVITATION_TTL_SECONDS', () => {
    const read = new Set();
    const env = new Proxy({ ...GROUP_VALUES, GROUPS_API_ENABLED: 'true', [REMOVED_SETTING]: '604800' }, {
        get(target, key) { read.add(key); return target[key]; },
        has(target, key) { read.add(key); return key in target; },
        getOwnPropertyDescriptor(target, key) { read.add(key); return Object.getOwnPropertyDescriptor(target, key); },
        ownKeys(target) { read.add('*ownKeys*'); return Reflect.ownKeys(target); }
    });
    loadFeatureConfig(env);
    for (const [, variable] of SWITCHES) assert.ok(read.has(variable), `${variable} is read`);
    assert.ok(!read.has(REMOVED_SETTING));
    assert.ok(!read.has('*ownKeys*'));
});

test('FeatureConfigError names each declared setting and never a value', () => {
    for (const name of GROUP_API_SETTINGS) {
        const error = new FeatureConfigError([name]);
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'FeatureConfigError');
        assert.deepEqual(error.settings, [name]);
        assert.ok(Object.isFrozen(error.settings));
        assert.deepEqual(settingNames(error.message), [name]);
        assert.ok(!error.message.includes('\n'), 'one line');
        assert.ok(!/\d/.test(error.message), 'no value in the message');
        for (const value of Object.values(GROUP_VALUES)) assert.ok(!error.message.includes(value));
    }
});

test('T-6B-21 attachment settings are required positive whole numbers, with an optional timeout and no defaults', () => {
    assert.deepEqual(ATTACHMENT_API_SETTINGS, [
        'ATTACHMENT_PENDING_TTL_SECONDS','ATTACHMENT_PURGE_DELAY_SECONDS','ATTACHMENT_RETENTION_INTERVAL_SECONDS',
        'ATTACHMENT_QUOTA_USER_BYTES','ATTACHMENT_QUOTA_CONVERSATION_BYTES','ATTACHMENT_MAX_PENDING_PER_USER',
        'ATTACHMENT_UPLOADS_PER_HOUR','ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER','ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE'
    ]);
    const valid = loadFeatureConfig(attachmentsOn({ ATTACHMENT_UPLOAD_TIMEOUT_SECONDS:'120' }));
    assert.deepEqual(valid.attachments, {
        pendingTtlSeconds:86400,purgeDelaySeconds:86400,retentionIntervalSeconds:3600,quotaUserBytes:1073741824,
        quotaConversationBytes:5368709120,maxPendingPerUser:10,uploadsPerHour:30,maxConcurrentUploadsPerUser:2,
        maxConcurrentUploadsPerSource:5,uploadTimeoutSeconds:120,storageDir:undefined
    });
    assertDeepFrozen(valid);
    assert.deepEqual(loadFeatureConfig({ ATTACHMENTS_API_ENABLED:'false' }).attachments, {});
    for (const missing of ATTACHMENT_API_SETTINGS) {
        const env = attachmentsOn({}); delete env[missing];
        assertNamesOnly(failure(env), [missing]);
    }
    for (const name of ATTACHMENT_API_SETTINGS) for (const value of [...INVALID_NUMBERS,...NON_STRINGS]) {
        assertNamesOnly(failure(attachmentsOn({ [name]:value })), [name], typeof value==='string' ? value : undefined);
    }
    for (const value of [...INVALID_NUMBERS,...NON_STRINGS]) {
        assertNamesOnly(failure(attachmentsOn({ ATTACHMENT_UPLOAD_TIMEOUT_SECONDS:value })), ['ATTACHMENT_UPLOAD_TIMEOUT_SECONDS']);
    }
    const many = attachmentsOn({ ATTACHMENT_PENDING_TTL_SECONDS:'0',ATTACHMENT_QUOTA_USER_BYTES:'1.5' });
    assertNamesOnly(failure(many), ['ATTACHMENT_PENDING_TTL_SECONDS','ATTACHMENT_QUOTA_USER_BYTES']);
    const noRoot = loadFeatureConfig(attachmentsOn({}));
    assert.equal(noRoot.attachmentApi,true,'missing storage root is a readiness failure, not a configuration-load failure');
    assert.equal(noRoot.attachments.storageDir,undefined);
});

test('T-6B-21 production attachment enablement requires only its own formatted Gate_Record', () => {
    for (const record of [undefined,...INVALID_RECORDS]) {
        const env = attachmentsOn({ NODE_ENV:'production',...(record===undefined?{}:{ATTACHMENTS_API_GATE_RECORD:record}) });
        assertNamesOnly(failure(env), ['ATTACHMENTS_API_GATE_RECORD']);
    }
    const valid = loadFeatureConfig(attachmentsOn({ NODE_ENV:'production',ATTACHMENTS_API_GATE_RECORD:'GR-ATTACHMENTS-2026-11-24' }));
    assert.equal(valid.attachmentApi,true);
    assert.ok(!JSON.stringify(valid).includes('GR-'));
});

test('a FeatureConfigError for the three Group_API settings names exactly those three', () => {
    const error = new FeatureConfigError([...GROUP_API_SETTINGS].reverse().concat(GROUP_API_SETTINGS[0]));
    assert.deepEqual(error.settings, GROUP_API_SETTINGS);
    assert.deepEqual(settingNames(error.message).sort(), [...GROUP_API_SETTINGS].sort());
    assert.ok(!error.message.includes('\n'));
});

test('FeatureConfigError refuses anything other than declared setting names and does not echo it', () => {
    for (const bad of [[], undefined, 'GROUP_MAX_MEMBERS', ['50'], ['GROUP_MAX_MEMBERS=50'], [REMOVED_SETTING], ['GROUP_MAX_MEMBERS', 'secret-value'], [50]]) {
        assert.throws(() => new FeatureConfigError(bad), error => {
            assert.ok(error instanceof TypeError);
            assert.ok(!/50|secret-value/.test(error.message));
            assert.ok(!error.message.includes(REMOVED_SETTING));
            return true;
        });
    }
});

test('no export or source line of features/config.js contains GROUP_INVITATION_TTL_SECONDS', () => {
    assert.deepEqual(Object.keys(config).sort(), ['ATTACHMENT_API_SETTINGS', 'DISABLED_FEATURES', 'FeatureConfigError', 'GROUP_API_SETTINGS', 'loadFeatureConfig']);
    assert.ok(!JSON.stringify({ DISABLED_FEATURES, GROUP_API_SETTINGS }).includes(REMOVED_SETTING));
    assert.ok(!new FeatureConfigError(GROUP_API_SETTINGS).message.includes(REMOVED_SETTING));
    const source = fs.readFileSync(require.resolve('../server/features/config'), 'utf8');
    assert.ok(!source.includes(REMOVED_SETTING));
    assert.ok(!/process\.env/.test(source), 'env is always a parameter');
    assert.ok(/^[\x00-\x7F]*$/.test(source), 'ASCII only');
});

// ---- T-5C-01: fail-closed validation of the companion settings and the production Gate_Record ----
// DB5-R16.1, R16.5, R16.7, R16.8; OD-04 (decided), OD-08 (decided in part), OD-01 (decided in part), OP-11.
const policy = require('../server/groups/policy');

const RECORD_VARIABLES = Object.freeze({ groupApi: 'GROUPS_API_GATE_RECORD', groupMessaging: 'GROUP_MESSAGING_GATE_RECORD', attachmentApi:'ATTACHMENTS_API_GATE_RECORD' });
const VALID_RECORD = 'GR-GROUP-MANAGEMENT-2026-11-22';
// Not positive whole numbers, or not exact: each must stop the start while its switch is on.
const INVALID_NUMBERS = ['', ' ', '0', '00', '-1', '-0', '+50', '1.5', '50.0', '1e3', '0x32', '050', ' 50', '50 ', '50\n', '5 0', '5_0',
    'fifty', 'NaN', 'Infinity', '9007199254740992', '99999999999999999999', '\uFF15\uFF10'];
const NON_STRINGS = [50, 1, true, null, ['50'], {}];
const INVALID_RECORDS = ['', ' ', 'GR-', 'GR-AB', 'gr-ABC', 'GR-abc', 'GR-ABC_DEF', 'GR-ABC DEF', ' GR-ABC', 'GR-ABC ', 'GR-ABC\n', 'XGR-ABC',
    'GR-' + 'A'.repeat(49), 'GR--', 'ABC', 'GR-ABC/..', 50, null, ['GR-ABC']];
const VALID_RECORDS = ['GR-ABC', 'GR-' + 'A'.repeat(48), VALID_RECORD, 'GR-A-1', 'GR-123'];

const apiOn = extra => ({ ...GROUP_VALUES, GROUPS_API_ENABLED: 'true', ...extra });
const attachmentsOn = extra => ({ ...ATTACHMENT_VALUES, ATTACHMENTS_API_ENABLED:'true', ...extra });
function failure(env) {
    try { loadFeatureConfig(env); } catch (error) { return error; }
    return assert.fail('loadFeatureConfig returned a configuration where a start failure was required');
}
function assertNamesOnly(error, names, value) {
    assert.ok(error instanceof FeatureConfigError);
    assert.equal(error.code, 'FEATURE_CONFIG_INVALID');
    assert.deepEqual(error.settings, names);
    assert.deepEqual(settingNames(error.message), names);
    assert.ok(!/\d/.test(error.message), 'no value in the message');
    assert.ok(!error.message.includes('\n'), 'one line');
    if (typeof value === 'string' && value.trim() !== '') assert.ok(!error.message.includes(value), 'the value is not echoed');
}

test('Group_API on with valid settings returns the three numbers, direct add off, and a deeply frozen result', () => {
    const features = loadFeatureConfig({ GROUPS_API_ENABLED: 'true', GROUP_MAX_MEMBERS: '50',
        GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: '7', GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: '3' });
    assert.equal(features.groupApi, true);
    assert.equal(features.groupMessaging, false);
    assert.equal(features.attachmentApi, false);
    // Distinct values show that no setting is mapped to another property.
    assert.deepEqual(features.groups, { maxMembers: 50, maxPendingInvitationsPerGroup: 7, maxPendingInvitationsPerInvitee: 3, directAdd: false });
    assert.deepEqual(features.attachments, {});
    assertDeepFrozen(features);
    assert.equal(Reflect.set(features.groups, 'maxMembers', 1), false);
    assert.equal(Reflect.set(features.groups, 'directAdd', true), false);
    assert.equal(features.groups.maxMembers, 50);
    assert.equal(features.groups.directAdd, false);
});

test('the smallest and the largest exact whole numbers are accepted', () => {
    for (const value of ['1', String(Number.MAX_SAFE_INTEGER)]) {
        const features = loadFeatureConfig(apiOn({ GROUP_MAX_MEMBERS: value, GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: value, GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: value }));
        assert.deepEqual([features.groups.maxMembers, features.groups.maxPendingInvitationsPerGroup, features.groups.maxPendingInvitationsPerInvitee],
            [Number(value), Number(value), Number(value)]);
    }
});

test('settings are neither read as requirements nor validated while their switch is off, and valid settings enable nothing', () => {
    const bad = { GROUP_MAX_MEMBERS: '0', GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: 'x', GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: '-1' };
    for (const extra of [{}, { GROUPS_API_ENABLED: 'false' }, { GROUPS_API_ENABLED: 'TRUE' }, { GROUPS_API_ENABLED: '1' },
        { GROUP_MESSAGING_ENABLED: 'true' }, { ...ATTACHMENT_ENV, ATTACHMENTS_API_ENABLED: 'true' }]) {
        const features = loadFeatureConfig({ ...bad, ...extra });
        assert.equal(features.groupApi, false);
        assert.deepEqual(features.groups, {});
    }
    assert.deepEqual(loadFeatureConfig({ ...GROUP_VALUES }), DISABLED_FEATURES);
    assert.deepEqual(loadFeatureConfig({}), DISABLED_FEATURES);
});

test('every non-empty subset of missing settings is named exactly, in declared order, with no value', () => {
    for (let mask = 1; mask < 8; mask++) {
        const env = apiOn({});
        const expected = [];
        GROUP_API_SETTINGS.forEach((name, index) => { if (mask & (1 << index)) { delete env[name]; expected.push(name); } });
        assertNamesOnly(failure(env), expected);
    }
    assertNamesOnly(failure({ GROUPS_API_ENABLED: 'true' }), [...GROUP_API_SETTINGS]);
});

test('each invalid value of each setting stops the start naming only that setting', () => {
    for (const name of GROUP_API_SETTINGS) {
        for (const value of [...INVALID_NUMBERS, ...NON_STRINGS]) {
            assertNamesOnly(failure(apiOn({ [name]: value })), [name], value);
        }
    }
});

test('several invalid settings are reported together in declared order', () => {
    const env = apiOn({ GROUP_MAX_MEMBERS: '0', GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: 'x', GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: '-1' });
    assertNamesOnly(failure(env), [...GROUP_API_SETTINGS]);
    const two = apiOn({ GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: '1.5' });
    delete two.GROUP_MAX_MEMBERS;
    assertNamesOnly(failure(two), ['GROUP_MAX_MEMBERS', 'GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE']);
});

test('no combination of switch and setting values enables the Group_API with an unusable setting', () => {
    const switches = [undefined, 'true', 'TRUE', '1', '', ' true'];
    const values = [undefined, '50', '1', '0', '-1', '1.5', 'abc', '', ' 50', '9007199254740993'];
    const usable = new Set(['50', '1']);
    let enabled = 0, refused = 0, off = 0;
    for (const sw of switches) for (const a of values) for (const b of values) for (const c of values) {
        const env = {};
        if (sw !== undefined) env.GROUPS_API_ENABLED = sw;
        if (a !== undefined) env.GROUP_MAX_MEMBERS = a;
        if (b !== undefined) env.GROUP_MAX_PENDING_INVITATIONS_PER_GROUP = b;
        if (c !== undefined) env.GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE = c;
        let features, error;
        try { features = loadFeatureConfig(env); } catch (caught) { error = caught; }
        if (sw !== 'true') {
            assert.equal(error, undefined);
            assert.equal(features.groupApi, false);
            assert.deepEqual(features.groups, {});
            off++;
        } else if ([a, b, c].every(value => usable.has(value))) {
            assert.equal(error, undefined);
            assert.equal(features.groupApi, true);
            assert.deepEqual([features.groups.maxMembers, features.groups.maxPendingInvitationsPerGroup, features.groups.maxPendingInvitationsPerInvitee], [Number(a), Number(b), Number(c)]);
            enabled++;
        } else {
            assert.ok(error instanceof FeatureConfigError, 'an unusable setting stops the start');
            assert.equal(features, undefined, 'no configuration is returned');
            refused++;
        }
    }
    assert.ok(enabled > 0 && refused > 0 && off > 0);
});

test('in production a switch that is on needs a well-formed Gate_Record id and the error names the variable only', () => {
    for (const record of INVALID_RECORDS) {
        assertNamesOnly(failure(apiOn({ NODE_ENV: 'production', [RECORD_VARIABLES.groupApi]: record })), [RECORD_VARIABLES.groupApi], record);
        assertNamesOnly(failure({ NODE_ENV: 'production', GROUP_MESSAGING_ENABLED: 'true', [RECORD_VARIABLES.groupMessaging]: record }),
            [RECORD_VARIABLES.groupMessaging], record);
    }
    assertNamesOnly(failure(apiOn({ NODE_ENV: 'production' })), [RECORD_VARIABLES.groupApi]);
    assertNamesOnly(failure({ NODE_ENV: 'production', GROUP_MESSAGING_ENABLED: 'true' }), [RECORD_VARIABLES.groupMessaging]);
    for (const record of VALID_RECORDS) {
        const api = loadFeatureConfig(apiOn({ NODE_ENV: 'production', [RECORD_VARIABLES.groupApi]: record }));
        assert.equal(api.groupApi, true);
        assert.ok(!JSON.stringify(api).includes('GR-'), 'the record id is not carried into the configuration');
        const messaging = loadFeatureConfig({ NODE_ENV: 'production', GROUP_MESSAGING_ENABLED: 'true', [RECORD_VARIABLES.groupMessaging]: record });
        assert.equal(messaging.groupMessaging, true);
        assert.deepEqual(messaging.groups, {}, 'group messaging alone needs no numeric setting');
    }
});

test('a Gate_Record satisfies only its own switch, and every failing setting is named together in declared order', () => {
    const both = { NODE_ENV: 'production', GROUPS_API_ENABLED: 'true', GROUP_MESSAGING_ENABLED: 'true', ...GROUP_VALUES };
    assertNamesOnly(failure({ ...both, [RECORD_VARIABLES.groupApi]: VALID_RECORD }), [RECORD_VARIABLES.groupMessaging]);
    assertNamesOnly(failure({ ...both, [RECORD_VARIABLES.groupMessaging]: VALID_RECORD }), [RECORD_VARIABLES.groupApi]);
    const features = loadFeatureConfig({ ...both, [RECORD_VARIABLES.groupApi]: VALID_RECORD, [RECORD_VARIABLES.groupMessaging]: VALID_RECORD });
    assert.equal(features.groupApi && features.groupMessaging, true);
    assertNamesOnly(failure({ NODE_ENV: 'production', GROUPS_API_ENABLED: 'true', GROUP_MESSAGING_ENABLED: 'true' }),
        [...GROUP_API_SETTINGS, RECORD_VARIABLES.groupApi, RECORD_VARIABLES.groupMessaging]);
});

test('outside production no Gate_Record is needed, a switch that is off never needs one, and a bad record is ignored', () => {
    for (const environment of [undefined, 'development', 'test']) {
        const env = apiOn({ GROUP_MESSAGING_ENABLED: 'true', [RECORD_VARIABLES.groupApi]: 'not-a-record' });
        if (environment !== undefined) env.NODE_ENV = environment;
        const features = loadFeatureConfig(env);
        assert.equal(features.groupApi && features.groupMessaging, true);
    }
    assert.deepEqual(loadFeatureConfig({ NODE_ENV: 'production' }), DISABLED_FEATURES);
    assert.deepEqual(loadFeatureConfig({ NODE_ENV: 'production', ...GROUP_VALUES, [RECORD_VARIABLES.groupApi]: 'bad', GROUPS_API_ENABLED: 'false' }), DISABLED_FEATURES);
});

test('direct add has no environment variable and stays off whatever the environment holds', () => {
    const read = new Set();
    const env = new Proxy(apiOn({ GROUP_DIRECT_ADD: 'true', GROUPS_DIRECT_ADD: 'true', DIRECT_ADD: 'true', GROUPS_DIRECT_ADD_ENABLED: 'true' }), {
        get(target, key) { read.add(String(key)); return target[key]; }
    });
    assert.equal(loadFeatureConfig(env).groups.directAdd, false);
    assert.deepEqual([...read].filter(key => /DIRECT/i.test(key)), []);
    const source = fs.readFileSync(require.resolve('../server/features/config'), 'utf8');
    assert.ok(!/['"][A-Z0-9_]*DIRECT[A-Z0-9_]*['"]/.test(source), 'no quoted environment variable name for direct add');
});

test('the Invitation expiry stays the fixed constant and nothing in the configuration carries an expiry or delay', () => {
    assert.equal(policy.INVITATION_EXPIRY_SECONDS, 604800);
    const distractors = { [REMOVED_SETTING]: '60', GROUP_INVITATION_TTL: '60', INVITATION_EXPIRY_SECONDS: '60', GROUP_REINVITE_DELAY_SECONDS: '60' };
    const features = loadFeatureConfig(apiOn(distractors));
    assert.deepEqual(Object.keys(features.groups).sort(), ['directAdd', 'maxMembers', 'maxPendingInvitationsPerGroup', 'maxPendingInvitationsPerInvitee']);
    assert.ok(!Object.keys(features.groups).some(key => /ttl|expir|delay/i.test(key)));
    const env = apiOn(distractors);
    delete env.GROUP_MAX_MEMBERS;
    const error = failure(env);
    assertNamesOnly(error, ['GROUP_MAX_MEMBERS']);
    assert.ok(!error.message.includes(REMOVED_SETTING));
    assert.equal(policy.INVITATION_EXPIRY_SECONDS, 604800, 'loading a configuration leaves the constant unchanged');
});

test('loading never changes the environment and accepts a frozen one', () => {
    const env = Object.freeze(apiOn({ NODE_ENV: 'production', [RECORD_VARIABLES.groupApi]: VALID_RECORD, EXTRA: 'kept' }));
    const before = JSON.stringify(env);
    loadFeatureConfig(env);
    assert.equal(JSON.stringify(env), before);
    const broken = Object.freeze({ GROUPS_API_ENABLED: 'true' });
    assert.ok(failure(broken) instanceof FeatureConfigError);
    assert.equal(JSON.stringify(broken), '{"GROUPS_API_ENABLED":"true"}');
});
test('T-6B-22 root readiness fails closed for relative, in-tree, parent, link, file and missing roots', t => {
    const { createFeatureGate } = require('../server/features/gate');
    const gateFor = storageDir => createFeatureGate({ groupApi:false,groupMessaging:false,attachmentApi:true,
        attachments:{ ...readyFeatures().attachments,storageDir } });
    const roots = [
        ['relative','attachments-private'],
        ['inside working tree',path.join(DATA_ROOT,'private-attachment-test')],
        ['through parent',path.join(DATA_ROOT,'tests','..','server','private-attachment-test')],
        ['file',path.join(ATTACHMENT_ROOT,'not-a-directory')],
        ['missing',path.join(ATTACHMENT_ROOT,'not-created')]
    ];
    fs.writeFileSync(roots[3][1],'synthetic');
    t.after(() => { try { fs.unlinkSync(roots[3][1]); } catch {} });
    for (const [label,root] of roots) {
        assert.equal(gateFor(root).status().attachmentApi,false,`${label} root is not ready`);
    }
    const alias=path.join(ATTACHMENT_ROOT,'repository-alias');
    try {
        fs.symlinkSync(DATA_ROOT,alias,process.platform==='win32'?'junction':'dir');
        t.after(() => { try { fs.rmSync(alias,{recursive:true,force:true}); } catch {} });
        assert.equal(gateFor(alias).status().attachmentApi,false,'a link resolving inside the working tree is refused');
    } catch (error) {
        assert.ok(['EPERM','EACCES','ENOTSUP'].includes(error.code),`link setup failed for an unexpected reason: ${error.code}`);
        const { createFilesystemProvider }=require('../server/attachments/storage/filesystem');
        const denied=Object.create(fs);
        denied.realpathSync=fs.realpathSync.bind(fs); denied.statSync=fs.statSync.bind(fs);
        denied.accessSync=() => { throw Object.assign(new Error(),{code:'EACCES'}); };
        denied.chmodSync=fs.chmodSync.bind(fs); denied.writeFileSync=fs.writeFileSync.bind(fs);
        denied.linkSync=fs.linkSync.bind(fs); denied.unlinkSync=fs.unlinkSync.bind(fs);
        assert.throws(() => createFilesystemProvider({root:ATTACHMENT_ROOT,repositoryRoot:DATA_ROOT,fsImpl:denied}),error => error.code==='STORAGE_IO');
    }
});

test('T-6B-22 a valid external directory enables only the attachment boolean and the Docker root is ready outside /workspace', () => {
    const { createFeatureGate, attachmentReady } = require('../server/features/gate');
    const { rootDecision } = require('../server/attachments/storage/filesystem');
    const configured=createFeatureGate({groupApi:false,groupMessaging:true,attachmentApi:true,attachments:readyFeatures().attachments});
    assert.deepEqual(configured.status(),{groupApi:false,groupMessaging:false,attachmentApi:true});
    assert.deepEqual(Object.keys(configured.status()),SWITCH_KEYS);
    assert.equal(configured.enabled('attachments'),true);
    configured.assertEnabled('attachments');
    let attachmentPassed=false;
    configured.middleware('attachments')({}, {}, () => { attachmentPassed=true; });
    assert.equal(attachmentPassed,true,'enabled attachment middleware uses the alias');
    const posixPath=require('node:path').posix;
    const dockerRoot='/var/lib/secubuzz/attachments';
    assert.equal(rootDecision(dockerRoot,'/workspace',posixPath.posix),null);
    assert.equal(attachmentReady({attachmentApi:true,attachments:{...READY_ATTACHMENTS,storageDir:dockerRoot}}, {
        repositoryRoot:'/workspace',providerFactory:options=>{
            assert.equal(options.root,dockerRoot);
            assert.equal(options.repositoryRoot,'/workspace');
            assert.equal(rootDecision(options.root,options.repositoryRoot,posixPath.posix),null);
            return {};
        }
    }),true,'the Docker volume path is accepted when its provider root check succeeds');
    assert.equal(attachmentReady({attachmentApi:true,attachments:READY_ATTACHMENTS},{providerFactory:()=>{throw new Error('not writable');}}),false,
        'provider refusal, including a non-writable directory, keeps the switch closed');
    const missingRoot=createFeatureGate({groupApi:false,groupMessaging:false,attachmentApi:true,attachments:{...readyFeatures().attachments,storageDir:undefined}});
    assert.deepEqual(missingRoot.status(),{groupApi:false,groupMessaging:false,attachmentApi:false});
    assert.throws(() => missingRoot.assertEnabled('attachments'),error => error instanceof AuthError && error.code==='FEATURE_UNAVAILABLE' && error.status===503 && error.fields.length===0);
    let passed;
    const touched=() => assert.fail('disabled attachment middleware must not inspect request or response');
    const proxy=new Proxy({}, {get:touched,has:touched,ownKeys:touched,getOwnPropertyDescriptor:touched,set:touched});
    missingRoot.middleware('attachments')(proxy,proxy,error => { passed=error; });
    assert.ok(passed instanceof AuthError);
    assert.deepEqual([passed.code,passed.status,passed.fields],['FEATURE_UNAVAILABLE',503,[]]);
});

// ---- T-5C-02: the Feature_Gate runtime (DB5-R16.1, R16.2, R16.4, R16.5, R16.13) ----
const { createFeatureGate, FEATURE_NAMES } = require('../server/features/gate');
const { AuthError } = require('../server/auth/errors');

const SWITCH_KEYS = ['groupApi', 'groupMessaging', 'attachmentApi'];
const SENTINEL = 'SENTINEL-CONFIG-VALUE-7d1f';
function allSwitchCombinations() {
    const out = [];
    for (let mask = 0; mask < 8; mask++) out.push({ groupApi: !!(mask & 1), groupMessaging: !!(mask & 2), attachmentApi: !!(mask & 4) });
    return out;
}
function expectedStatus(switches) {
    return { groupApi: switches.groupApi, groupMessaging: switches.groupApi && switches.groupMessaging, attachmentApi: switches.attachmentApi };
}
function thrownBy(work) {
    try { work(); } catch (error) { return error; }
    return assert.fail('expected a throw');
}
const READY_ATTACHMENTS = Object.freeze({
    pendingTtlSeconds:86400,purgeDelaySeconds:86400,retentionIntervalSeconds:3600,quotaUserBytes:1073741824,
    quotaConversationBytes:5368709120,maxPendingPerUser:10,uploadsPerHour:30,maxConcurrentUploadsPerUser:2,
    maxConcurrentUploadsPerSource:5,storageDir:ATTACHMENT_ROOT
});
const readyFeatures = (switches = {}) => ({ groupApi:false,groupMessaging:false,attachmentApi:false,...switches,attachments:READY_ATTACHMENTS });

test('no injected configuration means every function is off, with exactly the three booleans', () => {
    const gate = createFeatureGate();
    assert.deepEqual(gate.status(), { groupApi: false, groupMessaging: false, attachmentApi: false });
    assert.deepEqual(Object.keys(gate.status()), SWITCH_KEYS);
    assert.deepEqual(createFeatureGate(DISABLED_FEATURES).status(), gate.status());
    for (const name of FEATURE_NAMES) assert.equal(gate.enabled(name), false);
});

test('FEATURE_NAMES are the three switches in a fixed order, frozen, and a status is frozen', () => {
    assert.deepEqual([...FEATURE_NAMES], SWITCH_KEYS);
    assert.ok(Object.isFrozen(FEATURE_NAMES));
    assert.ok(Object.isFrozen(createFeatureGate().status()));
});

test('status reports the three booleans for all eight switch assignments, and groupMessaging only while groupApi is on', () => {
    for (const switches of allSwitchCombinations()) {
        const gate = createFeatureGate({ ...switches, attachments:{
            pendingTtlSeconds:86400,purgeDelaySeconds:86400,retentionIntervalSeconds:3600,quotaUserBytes:1073741824,
            quotaConversationBytes:5368709120,maxPendingPerUser:10,uploadsPerHour:30,maxConcurrentUploadsPerUser:2,
            maxConcurrentUploadsPerSource:5,storageDir:ATTACHMENT_ROOT
        } });
        assert.deepEqual(gate.status(), expectedStatus(switches));
        assert.deepEqual(Object.keys(gate.status()), SWITCH_KEYS);
        for (const name of FEATURE_NAMES) assert.equal(gate.enabled(name), expectedStatus(switches)[name]);
    }
});

test('a status object cannot be changed by the caller, and each call returns a new object', () => {
    const gate = createFeatureGate(readyFeatures({ groupApi:true,groupMessaging:true,attachmentApi:true }));
    const first = gate.status();
    assert.equal(Reflect.set(first, 'groupApi', false), false);
    assert.equal(gate.status().groupApi, true);
    assert.notEqual(gate.status(), gate.status());
});

test('the gate consumes the output of features/config.js: a valid environment enables, and a bad one never reaches the gate', () => {
    const valid = loadFeatureConfig({ ...GROUP_VALUES, GROUPS_API_ENABLED: 'true', GROUP_MESSAGING_ENABLED: 'true' });
    assert.deepEqual(createFeatureGate(valid).status(), { groupApi: true, groupMessaging: true, attachmentApi: false });
    const messagingOnly = loadFeatureConfig({ ...GROUP_VALUES, GROUP_MESSAGING_ENABLED: 'true' });
    assert.deepEqual(createFeatureGate(messagingOnly).status(), { groupApi: false, groupMessaging: false, attachmentApi: false });
    const bad = { GROUPS_API_ENABLED: 'true', GROUP_MAX_MEMBERS: '0' };
    assert.ok(thrownBy(() => loadFeatureConfig(bad)) instanceof FeatureConfigError);
});

test('a missing or non-object configuration is refused, never treated as enabled', () => {
    for (const bad of [null, 'true', 1, true, () => {}, []]) {
        assert.ok(thrownBy(() => createFeatureGate(bad)) instanceof TypeError, `refuses ${typeof bad}`);
    }
});

test('a missing or non-boolean switch is refused and never read as on, and the value is not echoed', () => {
    const variants = [
        { groupApi: true, groupMessaging: true },
        { groupApi: 'true', groupMessaging: false, attachmentApi: false },
        { groupApi: 1, groupMessaging: false, attachmentApi: false },
        { groupApi: false, groupMessaging: null, attachmentApi: false },
        { groupApi: false, groupMessaging: false, attachmentApi: undefined },
        { groupApi: false, groupMessaging: false, attachmentApi: SENTINEL },
        { groupApi: true, groupMessaging: true, attachmentApi: 'TRUE' }
    ];
    for (const variant of variants) {
        const error = thrownBy(() => createFeatureGate(variant));
        assert.ok(error instanceof TypeError);
        assert.ok(!error.message.includes(SENTINEL), 'the value is not echoed');
    }
});

test('extra keys in the configuration are ignored and cannot enable anything', () => {
    const gate = createFeatureGate({ groupApi: false, groupMessaging: false, attachmentApi: false, groups: { directAdd: true }, attachments: {}, groupApiOverride: true });
    assert.deepEqual(gate.status(), { groupApi: false, groupMessaging: false, attachmentApi: false });
});

test('the gate copies the switches at creation: changing the source object later changes nothing', () => {
    const source = { groupApi: false, groupMessaging: false, attachmentApi: false };
    const gate = createFeatureGate(source);
    source.groupApi = true;
    source.attachmentApi = true;
    assert.deepEqual(gate.status(), { groupApi: false, groupMessaging: false, attachmentApi: false });
    assert.equal(gate.enabled('attachmentApi'), false);
});

test('assertEnabled throws the existing AuthError with code FEATURE_UNAVAILABLE, status 503 and no fields when off', () => {
    const gate = createFeatureGate({ groupApi: false, groupMessaging: true, attachmentApi: false });
    for (const name of FEATURE_NAMES) {
        const error = thrownBy(() => gate.assertEnabled(name));
        assert.ok(error instanceof AuthError);
        assert.equal(error.code, 'FEATURE_UNAVAILABLE');
        assert.equal(error.status, 503);
        assert.deepEqual(error.fields, []);
        assert.equal(error.message, 'FEATURE_UNAVAILABLE');
    }
});

test('assertEnabled passes for enabled switches, and groupMessaging fails while groupApi is off', () => {
    const gate = createFeatureGate(readyFeatures({ groupApi:true,groupMessaging:true,attachmentApi:true }));
    for (const name of FEATURE_NAMES) assert.equal(gate.assertEnabled(name), undefined);
    const messagingOnly = createFeatureGate({ groupApi: false, groupMessaging: true, attachmentApi: false });
    assert.ok(thrownBy(() => messagingOnly.assertEnabled('groupMessaging')) instanceof AuthError);
});

test('an unknown feature name is refused by every method and never answered as enabled', () => {
    const gate = createFeatureGate(readyFeatures({ groupApi:true,groupMessaging:true,attachmentApi:true }));
    for (const name of ['groups', 'GROUPAPI', '', undefined, null, 1, 'constructor', '__proto__', 'hasOwnProperty']) {
        assert.ok(thrownBy(() => gate.enabled(name)) instanceof TypeError, String(name));
        assert.ok(thrownBy(() => gate.assertEnabled(name)) instanceof TypeError, String(name));
        assert.ok(thrownBy(() => gate.middleware(name)) instanceof TypeError, String(name));
    }
});

test('middleware passes an enabled request on with no argument and a disabled one with an AuthError 503', () => {
    const enabledGate = createFeatureGate(readyFeatures({ groupApi:true,groupMessaging:true,attachmentApi:true }));
    const disabledGate = createFeatureGate({ groupApi: false, groupMessaging: true, attachmentApi: false });
    const calls = [];
    const next = (...args) => calls.push(args);
    for (const name of FEATURE_NAMES) enabledGate.middleware(name)({}, {}, next);
    assert.deepEqual(calls, [[], [], []]);
    calls.length = 0;
    for (const name of FEATURE_NAMES) disabledGate.middleware(name)({}, {}, next);
    assert.equal(calls.length, 3);
    for (const [error] of calls) {
        assert.ok(error instanceof AuthError);
        assert.equal(error.code, 'FEATURE_UNAVAILABLE');
        assert.equal(error.status, 503);
        assert.deepEqual(error.fields, []);
    }
});

test('middleware reads neither the request nor the response before answering, so a refused request touches no state', () => {
    const gate = createFeatureGate({ groupApi: false, groupMessaging: false, attachmentApi: false });
    const touched = () => assert.fail('the request or response must not be read');
    const request = new Proxy({}, { get: touched, has: touched, ownKeys: touched, getOwnPropertyDescriptor: touched });
    const response = new Proxy({}, { get: touched, has: touched, set: touched, ownKeys: touched });
    let received;
    gate.middleware('groupApi')(request, response, error => { received = error; });
    assert.ok(received instanceof AuthError);
});

test('two gates from different configurations keep separate state, and the implicit default does not leak', () => {
    const on = createFeatureGate(readyFeatures({ groupApi:true,groupMessaging:true,attachmentApi:true }));
    const off = createFeatureGate({ groupApi: false, groupMessaging: false, attachmentApi: false });
    const implicit = createFeatureGate();
    assert.deepEqual(on.status(), { groupApi: true, groupMessaging: true, attachmentApi: true });
    assert.deepEqual(off.status(), { groupApi: false, groupMessaging: false, attachmentApi: false });
    assert.deepEqual(implicit.status(), off.status());
    assert.notEqual(on.status(), off.status());
});

test('no error or status ever contains a configured value', () => {
    const config = { groupApi: false, groupMessaging: false, attachmentApi: false, groups: { maxMembers: SENTINEL, directAdd: false }, attachments: { quota: SENTINEL } };
    const gate = createFeatureGate(config);
    assert.ok(!JSON.stringify(gate.status()).includes(SENTINEL));
    for (const name of FEATURE_NAMES) {
        const error = thrownBy(() => gate.assertEnabled(name));
        assert.ok(!error.message.includes(SENTINEL));
        assert.ok(!JSON.stringify(error.fields).includes(SENTINEL));
    }
});

test('gate.js has no environment access, logging, randomness or clock, and only its declared imports', () => {
    const source = fs.readFileSync(require.resolve('../server/features/gate'), 'utf8');
    assert.ok(!/process\.env|console\.|Math\.random|Date\.now|new Date\(|setTimeout/.test(source), 'no forbidden call');
    const requires = source.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || [];
    assert.deepEqual(requires.map(text => text.replace(/\s/g, '')), ["require('node:path')", "require('./config')", "require('../attachments/storage/filesystem')", "require('../auth/errors')"]);
    assert.ok(/^[\x00-\x7F]*$/.test(source), 'ASCII only');
});

// ---- T-5C-05: feature configuration at start-up (DB5-R16.7, R14.10, R14.17, R13.3, ARCH-R01.10) ----
// The load happens in startServer before openDatabase. An injected features object is test-harness data and is refused in
// production. A start failure names settings only. The child-process tests run server.js on a temporary database file under
// os.tmpdir(), never on DATA/server/database/database.sqlite or a Docker volume (DB5-R14.17).
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./support/contract');
const { envDefaults } = require('./support/auth');
const { snapshot, temporaryDirectory } = require('./support/groups');
const { openDatabase } = require('../server/database/connection');
const { migrate } = require('../server/database/migrate');
const { startServer, describeStartFailure, FeatureProvenanceError } = require('../server/start');
const { GROUP_ROUTES } = require('../server/routes/groups');

const DATA_ROOT = path.join(__dirname, '..');
const PRODUCTION_ENV = Object.freeze({ NODE_ENV: 'production', AUTH_ALLOW_HTTP_LOCAL: 'false', AUTH_ALLOWED_ORIGINS: 'https://app.example.test' });
const ENABLED_ENV = Object.freeze({ ...GROUP_VALUES, GROUPS_API_ENABLED: 'true' });
const INJECTED_ON = Object.freeze({ groupApi: true, groupMessaging: true, attachmentApi: false, groups: Object.freeze({ maxMembers: 50 }) });
const OFF_STATUS = Object.freeze({ groupApi: false, groupMessaging: false, attachmentApi: false });
const FAILURE_VALUES = Object.freeze({ GROUP_MAX_MEMBERS: '47', GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: '11', GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: '13' });
const error503 = Object.freeze({ code: 'FEATURE_UNAVAILABLE', fields: [] });

function memoryDatabase(t) {
    const db = openDatabase({ filename: ':memory:' });
    t.after(() => { if (db.open) db.close(); });
    return db;
}
// startServer on an in-memory database, with the log lines collected. Returns the application, the database and the lines.
async function boot(t, env, extra = {}) {
    const db = memoryDatabase(t);
    const lines = [];
    const application = await startServer({ db, env: { ...envDefaults, ...env }, log: line => lines.push(line), ...extra });
    t.after(() => application.close());
    return { db, application, lines };
}
async function refusal(work) {
    try { await work(); } catch (error) { return error; }
    return assert.fail('expected the start to be refused');
}
async function underProcessEnvironment(value, work) {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try { return await work(); } finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
}
// A start that must fail. DB_PATH points at a new file that must never appear, so a configuration error opened no database.
async function failedStart(t, env, extra = {}) {
    const directory = temporaryDirectory(t);
    const file = path.join(directory, 'never-opened.sqlite');
    const lines = [];
    const error = await refusal(() => startServer({ env: { ...envDefaults, ...env, DB_PATH: file }, log: line => lines.push(line), ...extra }));
    assert.deepEqual(fs.readdirSync(directory), [], 'no database file, journal or migration was created');
    return { error, lines };
}
async function session(f, name) {
    const browser = f.browser();
    assert.equal((await browser.register(name)).status, 201);
    assert.equal((await browser.login(name)).status, 200);
    return { browser, token: await browser.csrf() };
}
const call = (actor, method, url, body) => actor.browser.request(url, { method, body, headers: ['GET', 'HEAD'].includes(method) ? {} : { 'X-CSRF-Token': actor.token } });

test('the default start has every function off, prints one off line per switch, and reports off through feature-status', async t => {
    const { application, lines } = await boot(t, {});
    assert.deepEqual({ groupApi: application.features.groupApi, groupMessaging: application.features.groupMessaging, attachmentApi: application.features.attachmentApi }, OFF_STATUS);
    assert.ok(Object.isFrozen(application.features));
    assert.deepEqual(lines, switchLines(), 'every switch prints a line, and an unset one is off');
    const f = await setup(t);
    const alice = await session(f, 'cfg-default-alice');
    const status = await call(alice, 'GET', '/api/groups/feature-status');
    assert.deepEqual([status.status, status.body], [200, OFF_STATUS]);
});

test('every environment switch reaches the router, and its start-up line names the variable and the state, never the value', async t => {
    for (const [key, variable] of SWITCHES) {
        const { application, lines } = await boot(t, { [variable]: 'true', ...(key === 'groupApi' ? GROUP_VALUES : {}), ...(key === 'attachmentApi' ? ATTACHMENT_ENV : {}) });
        assert.equal(application.features[key], true, `${variable} turns ${key} on`);
        assert.deepEqual(lines, [...switchLines(variable), ...(key==='attachmentApi'
            ? ['attachment retention startup records_without_bytes=0','attachment retention startup bytes_without_records=0'] : [])]);
    }
    const typos = ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'false', '', 'tru'];
    for (const value of typos) {
        const { application, lines } = await boot(t, { GROUPS_API_ENABLED: value, GROUP_MESSAGING_ENABLED: value, ATTACHMENTS_API_ENABLED: value });
        assert.deepEqual([application.features.groupApi, application.features.groupMessaging, application.features.attachmentApi], [false, false, false], JSON.stringify(value));
        assert.deepEqual(lines, SWITCHES.map(([, variable]) => `Feature switch ${variable}: off`), JSON.stringify(value));
        assert.ok(!lines.join('\n').includes(`: ${value}`) || value === '', 'the value is not echoed');
    }
    const { lines } = await boot(t, { GROUPS_API_ENABLED: 'true', ...GROUP_VALUES, GROUP_MESSAGING_ENABLED: 'yes' });
    assert.deepEqual(lines, switchLines('GROUPS_API_ENABLED'));
});

test('T-6B-22 a missing attachment storage root leaves startup healthy, reports disabled and logs only its setting name', async t => {
    const settingsOnly={...ATTACHMENT_VALUES,ATTACHMENTS_API_ENABLED:'true'};
    const {application,lines}=await boot(t,settingsOnly);
    assert.equal(application.features.attachmentApi,false);
    assert.deepEqual(lines,[...switchLines('ATTACHMENTS_API_ENABLED'),'Attachment_API disabled: ATTACHMENT_STORAGE_DIR is unavailable']);
    assert.ok(!lines.join(' ').includes('undefined'));
    const fixture=await setup(t);
    const actor=await session(fixture,'attachment-root-missing-status');
    assert.deepEqual((await call(actor,'GET','/api/groups/feature-status')).body,OFF_STATUS);
});

test('with the Group_API on, feature-status reports it and a group that cannot be seen ends in the uniform 404', async t => {
    const f = await setup(t, { env: ENABLED_ENV });
    const alice = await session(f, 'cfg-on-alice');
    const status = await call(alice, 'GET', '/api/groups/feature-status');
    assert.deepEqual([status.status, status.body], [200, { groupApi: true, groupMessaging: false, attachmentApi: false }]);
    const other = await call(alice, 'GET', '/api/groups/some-group');
    assert.deepEqual([other.status, other.body], [404, { code: 'NOT_FOUND', fields: [] }]);
    const alone = await setup(t, { env: { GROUP_MESSAGING_ENABLED: 'true' } });
    const bob = await session(alone, 'cfg-messaging-bob');
    const reported = await call(bob, 'GET', '/api/groups/feature-status');
    assert.deepEqual(reported.body, OFF_STATUS, 'group messaging is reported only while the Group_API is on');
});

test('a valid production configuration starts, carries the settings into the application, and never carries the record id', async t => {
    const { application, lines } = await boot(t, { ...PRODUCTION_ENV, ...ENABLED_ENV, GROUPS_API_GATE_RECORD: VALID_RECORD });
    assert.equal(application.features.groupApi, true);
    assert.deepEqual({ ...application.features.groups }, { maxMembers: 50, maxPendingInvitationsPerGroup: 20, maxPendingInvitationsPerInvitee: 30, directAdd: false });
    assert.ok(!JSON.stringify(application.features).includes('GR-'));
    assert.deepEqual(lines, switchLines('GROUPS_API_ENABLED'));
    assert.ok(!lines.join('\n').includes(VALID_RECORD));
    const both = await boot(t, { ...PRODUCTION_ENV, ...ENABLED_ENV, GROUP_MESSAGING_ENABLED: 'true', GROUPS_API_GATE_RECORD: VALID_RECORD, GROUP_MESSAGING_GATE_RECORD: 'GR-GROUP-MESSAGING-2026-12-01' });
    assert.deepEqual([both.application.features.groupApi, both.application.features.groupMessaging], [true, true]);
    const off = await boot(t, { ...PRODUCTION_ENV });
    assert.equal(off.application.features.groupApi, false, 'production with no switch needs no record');
});

test('in production a missing or invalid Gate_Record stops the start before any database is opened, naming the variable only', async t => {
    const records = [undefined, ...INVALID_RECORDS.slice(0, 12), 'GR-secret-looking-value'];
    for (const record of records) {
        const env = { ...PRODUCTION_ENV, ...ENABLED_ENV, ...(record === undefined ? {} : { GROUPS_API_GATE_RECORD: record }) };
        const { error, lines } = await failedStart(t, env);
        assert.ok(error instanceof FeatureConfigError, JSON.stringify(record));
        assert.deepEqual([...error.settings], ['GROUPS_API_GATE_RECORD']);
        assert.ok(record === undefined || record === '' || !JSON.stringify([error.message, describeStartFailure(error)]).includes(record.trim() || '\u0000'), 'the record value is not echoed');
        assert.deepEqual(lines, [], 'no switch line is printed for a start that fails');
    }
    const messaging = await failedStart(t, { ...PRODUCTION_ENV, GROUP_MESSAGING_ENABLED: 'true', GROUP_MESSAGING_GATE_RECORD: 'bad' });
    assert.deepEqual([...messaging.error.settings], ['GROUP_MESSAGING_GATE_RECORD']);
    const wrongRecord = await failedStart(t, { ...PRODUCTION_ENV, ...ENABLED_ENV, GROUP_MESSAGING_ENABLED: 'true', GROUPS_API_GATE_RECORD: VALID_RECORD });
    assert.deepEqual([...wrongRecord.error.settings], ['GROUP_MESSAGING_GATE_RECORD'], 'a record satisfies only its own switch');
    const missingSettings = await failedStart(t, { ...PRODUCTION_ENV, GROUPS_API_ENABLED: 'true' });
    assert.deepEqual([...missingSettings.error.settings], [...GROUP_API_SETTINGS, 'GROUPS_API_GATE_RECORD']);
});

test('a missing setting outside production stops the start before any database is opened and names every offending setting', async t => {
    for (const missing of GROUP_API_SETTINGS) {
        const values = { ...FAILURE_VALUES };
        delete values[missing];
        const { error } = await failedStart(t, { GROUPS_API_ENABLED: 'true', ...values });
        assert.ok(error instanceof FeatureConfigError);
        assert.deepEqual([...error.settings], [missing]);
        assert.ok(!Object.values(FAILURE_VALUES).some(value => describeStartFailure(error).includes(value)));
    }
    const all = await failedStart(t, { GROUPS_API_ENABLED: 'true' });
    assert.deepEqual([...all.error.settings], [...GROUP_API_SETTINGS]);
    assert.ok(!describeStartFailure(all.error).includes(REMOVED_SETTING));
});

test('an injected features object is refused in production, whatever it enables, and no database is opened', async t => {
    for (const injected of [INJECTED_ON, DISABLED_FEATURES, { ...INJECTED_ON, groupMessaging: false }, Object.freeze({ ...DISABLED_FEATURES })]) {
        const { error } = await failedStart(t, { ...PRODUCTION_ENV, ...ENABLED_ENV, GROUPS_API_GATE_RECORD: VALID_RECORD }, { features: injected });
        assert.ok(error instanceof FeatureProvenanceError);
        assert.equal(error.code, 'FEATURE_PROVENANCE_REFUSED');
        assert.deepEqual(settingNames(error.message), [], 'the error names no setting');
        assert.equal(describeStartFailure(error), error.message);
    }
    const noRecord = await failedStart(t, { ...PRODUCTION_ENV }, { features: INJECTED_ON });
    assert.ok(noRecord.error instanceof FeatureProvenanceError, 'an injected object is no substitute for the Gate_Record or for the load');
    // A production process is production whatever env object it is handed.
    await underProcessEnvironment('production', async () => {
        const refused = await failedStart(t, {}, { features: INJECTED_ON });
        assert.ok(refused.error instanceof FeatureProvenanceError);
        const needsRecord = await failedStart(t, { ...ENABLED_ENV });
        assert.ok(needsRecord.error instanceof FeatureConfigError);
        assert.deepEqual([...needsRecord.error.settings], ['GROUPS_API_GATE_RECORD'], 'the Gate_Record applies although the env object says test');
    });
});

test('outside production an injected object skips the load and is that application only; a malformed one stops the start', async t => {
    const injected = await boot(t, { GROUPS_API_ENABLED: 'true' }, { features: INJECTED_ON });
    assert.deepEqual([injected.application.features.groupApi, injected.application.features.groupMessaging], [true, true]);
    assert.deepEqual(injected.lines, [], 'the load is skipped, so the incomplete environment stops nothing and prints nothing');
    const off = await boot(t, { ...ENABLED_ENV }, { features: DISABLED_FEATURES });
    assert.equal(off.application.features.groupApi, false, 'the injected object, not the environment, decides');
    for (const malformed of [null, 'true', 7, [], () => ({})]) {
        const db = memoryDatabase(t);
        const error = await refusal(() => startServer({ db, env: { ...envDefaults }, features: malformed }));
        assert.ok(error instanceof Error, String(malformed));
        assert.ok(db.open, 'an injected database stays open');
    }
    // The Group_Service reads an object switch by switch, and only the boolean true turns one on: a string, a number or a
    // missing switch is off. (Production never reaches this: an injected object is refused there.)
    for (const partial of [{ groupApi: 'true', groupMessaging: 1, attachmentApi: 'yes' }, { groupApi: 1 }, {}, { groupApi: null, attachmentApi: {} }]) {
        const { application } = await boot(t, {}, { features: partial });
        assert.deepEqual([application.features.groupApi, application.features.groupMessaging, application.features.attachmentApi], [false, false, false], JSON.stringify(partial));
    }
});

test('two applications in one process keep separate configuration, and the environment is read once at start', async t => {
    const on = await boot(t, { ...ENABLED_ENV });
    const off = await boot(t, {});
    const injected = await boot(t, {}, { features: INJECTED_ON });
    assert.deepEqual([on.application.features.groupApi, off.application.features.groupApi, injected.application.features.groupApi], [true, false, true]);
    assert.notEqual(on.application.features, off.application.features);
    assert.notEqual(on.application.features.groups, injected.application.features.groups);
    const before = process.env.GROUPS_API_ENABLED;
    process.env.GROUPS_API_ENABLED = 'true';
    try {
        const later = await boot(t, {});
        assert.equal(later.application.features.groupApi, false, 'startServer reads the env it is given, not a changed process.env');
    } finally { if (before === undefined) delete process.env.GROUPS_API_ENABLED; else process.env.GROUPS_API_ENABLED = before; }
    // The same over HTTP, with two real servers: one app answering for one database cannot enable the other.
    const first = await setup(t, { env: ENABLED_ENV });
    const second = await setup(t);
    const third = await setup(t, { features: INJECTED_ON });
    const answers = [];
    for (const [index, fixture] of [first, second, third, second].entries()) {
        const actor = await session(fixture, `cfg-isolated-${index}`);
        answers.push((await call(actor, 'GET', '/api/groups/feature-status')).body.groupApi);
    }
    assert.deepEqual(answers, [true, false, true, false]);
});

test('with every switch off no group operation is reachable, and no table changes', async t => {
    const f = await setup(t);
    const alice = await session(f, 'cfg-closed-alice');
    const before = snapshot(f.db);
    const paths = ['/api/groups', '/api/groups/', '/api/groups/some-group', '/api/groups/some-group/members', '/api/groups/some-group/members/some-user',
        '/api/groups/invitations', '/api/groups/invitations/some-invitation/accept', '/api/groups/some-group/messages', '/api/groups/some-group/unarchive'];
    for (const url of paths) {
        for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
            const response = await call(alice, method, url, ['POST', 'PUT', 'PATCH'].includes(method) ? { name: 'x' } : undefined);
            assert.equal(response.status, 503, `${method} ${url}`);
            if (method !== 'HEAD') assert.deepEqual(response.body, error503, `${method} ${url}`);
        }
    }
    const withoutSession = await f.browser().request('/api/groups/some-group');
    assert.equal(withoutSession.status, 401, 'the session check still comes first');
    assert.deepEqual(snapshot(f.db), before);
});

test('P-25: generated disabled-route requests and a disable/restart cycle preserve every table', { timeout:120000 }, async t => {
    const random = createRandom(0x5c2543);
    const paths = Object.freeze({
        G01:['POST','/api/groups',{name:'Synthetic gated group',historyPolicy:'from_joined'}],
        G02:['GET','/api/groups'],G03:['GET','/api/groups/gated-group'],G04:['PATCH','/api/groups/gated-group',{name:'Changed'}],
        G05:['GET','/api/groups/gated-group/members'],G06:['POST','/api/groups/gated-group/members',{userId:'synthetic-target'}],
        G07:['DELETE','/api/groups/gated-group/members/synthetic-target'],G08:['PATCH','/api/groups/gated-group/members/synthetic-target',{role:'admin'}],
        G09:['POST','/api/groups/gated-group/leave',{}],G10:['POST','/api/groups/gated-group/transfer',{userId:'synthetic-target'}],
        G11:['POST','/api/groups/gated-group/archive',{}],G12:['POST','/api/groups/gated-group/invitations',{userId:'synthetic-target'}],
        G13:['GET','/api/groups/gated-group/invitations'],G14:['DELETE','/api/groups/gated-group/invitations/synthetic-invitation'],
        G15:['GET','/api/groups/invitations'],G16:['POST','/api/groups/invitations/synthetic-invitation/accept',{}],
        G17:['POST','/api/groups/invitations/synthetic-invitation/decline',{}],
        G18:['GET','/api/groups/gated-group/messages'],
        G19:['POST','/api/groups/gated-group/messages',{
            id:'synthetic-message',conversationId:'gated-group',senderId:'synthetic-sender',senderName:'Synthetic Sender',
            timestamp:'2033-01-01T00:00:00.000Z',type:'text',
            encryption:{version:1,algorithm:'AES-256-GCM',encoding:'base64',
                iv:Buffer.alloc(12,1).toString('base64'),ciphertext:Buffer.alloc(32,2).toString('base64')},
        }],
        G20:['GET','/api/groups/gated-group/messages/synthetic-message'],
        G21:['DELETE','/api/groups/gated-group/messages/synthetic-message'],
        G22:['GET','/api/groups/gated-group/read-position'],
        G23:['PUT','/api/groups/gated-group/read-position',{position:1}],
        G24:['POST','/api/groups/gated-group/messages/synthetic-message/receipts',{status:'read'}],
        G25:['GET','/api/groups/gated-group/messages/synthetic-message/receipts'],
    });
    assert.equal(GROUP_ROUTES.filter(route => route.gated).length, Object.keys(paths).length,
        'every frozen gated route has a valid request template');
    for (const groupMessaging of ['false','true']) for (const attachmentApi of ['false','true']) {
        const label = `disabled-${groupMessaging}-${attachmentApi}`;
        const f = await setup(t, { env:{ GROUPS_API_ENABLED:'false', GROUP_MESSAGING_ENABLED:groupMessaging,
            ...(attachmentApi==='true' ? ATTACHMENT_ENV : {}), ATTACHMENTS_API_ENABLED:attachmentApi } });
        const alice = await session(f, `p25-${label}`);
        const before = snapshot(f.db);
        const count = random.int(10,40);
        for (let index = 0; index < count; index += 1) {
            const [method,url,body] = paths[random.pick(Object.keys(paths))];
            const response = await call(alice, method, url, ['GET','HEAD'].includes(method) ? undefined : body);
            assert.equal(response.status,503,`${label} ${method} ${url}`);
            assert.deepEqual(response.body,error503,`${label} ${method} ${url} response`);
            assert.deepEqual(snapshot(f.db),before,`${label} ${method} ${url} changed a table`);
        }
        const status = await call(alice,'GET','/api/groups/feature-status');
        assert.equal(status.status,200,'feature-status remains outside the disabled route family');
        assert.deepEqual(snapshot(f.db),before,'feature-status is read-only');
        t.diagnostic(`P-25 ${label}: ${count} valid-CSRF route requests refused without table changes`);
    }

    // Data created while enabled survives a same-file restart; disabling after restart restores the fail-closed route set.
    const enabled = { ...GROUP_VALUES, GROUPS_API_ENABLED:'true' };
    const f = await setup(t,{ env:enabled });
    const alice = await session(f,'p25-restart-owner');
    const created = await call(alice,'POST','/api/groups',{name:'Persisted gated group'});
    assert.equal(created.status,201);
    const before = snapshot(f.db);
    const ledger = f.db.prepare('SELECT version,name,checksum FROM SchemaMigrations ORDER BY version').all();
    await f.application.close();
    f.db.close();
    const restarted = await startServer({ env:{ ...envDefaults, DB_PATH:f.filename, GROUPS_API_ENABLED:'false',
        GROUP_MESSAGING_ENABLED:'false', ATTACHMENTS_API_ENABLED:'false' }, config:f.config, log:()=>{} });
    f.applications.push(restarted);
    assert.deepEqual(restarted.db.prepare('SELECT version,name,checksum FROM SchemaMigrations ORDER BY version').all(),ledger,
        'restart applies no migration or ledger change');
    assert.equal(restarted.db.prepare('SELECT count(*) AS n FROM Conversations WHERE conversation_id=?').get(created.body.group.id).n,1,
        'the synthetic group remains stored');
    assert.deepEqual(snapshot(restarted.db),before,'the stored database is unchanged by restart');
    alice.browser.origin=`http://127.0.0.1:${restarted.server.address().port}`;
    for (const [method,url,body] of Object.values(paths)) {
        const response = await call(alice,method,url,['GET','HEAD'].includes(method) ? undefined : body);
        assert.equal(response.status,503,`${method} ${url} after disable/restart`);
        assert.deepEqual(response.body,error503);
        assert.deepEqual(snapshot(restarted.db),before,`${method} ${url} changed persisted tables after restart`);
    }
});

test('T-5D-20/21 P-25/P-26: messaging gate, verifier states and feature-status combinations', { timeout:180000 }, async t => {
    const {httpGroupFixture,actorRequest,snapshot}=require('./support/groups');
    const values={maxMembers:50,maxPendingInvitationsPerGroup:20,maxPendingInvitationsPerInvitee:20};
    const ready=Object.freeze({async verifyEnvelope(){return {verified:true};}});
    const testOnly=Object.freeze({testOnly:true,async verifyEnvelope(){return {verified:true};}});
    const states=[['none',undefined],['test-only',testOnly],['ready',ready]];
    const envelope=(actor,id)=>({id:'gate-message',conversationId:id,senderId:actor.id,senderName:'Group Owner',timestamp:'2033-01-01T00:00:00.000Z',
        type:'text',encryption:{version:1,algorithm:'AES-256-GCM',encoding:'base64',iv:Buffer.alloc(12,1).toString('base64'),
            ciphertext:Buffer.alloc(32,2).toString('base64')}});
    const coverage=new Set();
    for(let mask=0;mask<4;mask++)for(const [state,verifier] of states) {
        const groupApi=Boolean(mask&1),groupMessaging=Boolean(mask&2);
        const f=await httpGroupFixture(t,{features:{groupApi,groupMessaging,attachmentApi:false,groups:values},
            ...(verifier?{messageOptions:{groupRecipientKeyVerifier:verifier}}:{})});
        const actor=f.actors.owner;
        const status=await actorRequest(actor,'GET','/api/groups/feature-status');
        assert.deepEqual(status.body,{groupApi,groupMessaging:groupApi&&groupMessaging,attachmentApi:false},`P-26 ${mask}/${state} exact status`);
        const anonymous=await f.browser().request('/api/groups/feature-status');
        assert.equal(anonymous.status,401,`P-26 ${mask}/${state} session required`);
        const before=snapshot(f.db);
        const write=await actorRequest(actor,'POST',`/api/groups/${f.groupId}/messages`,{body:envelope(actor,f.groupId)});
        if(!groupApi||!groupMessaging)assert.deepEqual([write.status,write.body.code],[503,'FEATURE_UNAVAILABLE'],`P-25 ${mask}/${state}`);
        else if(!verifier)assert.deepEqual([write.status,write.body.code],[503,'RECIPIENT_KEYS_UNAVAILABLE'],`P-25 ${mask}/${state} missing verifier`);
        else assert.deepEqual([write.status,write.body.outcome],[201,'created'],`P-25 ${mask}/${state} ready verifier`);
        if(write.status>=400)assert.deepEqual(snapshot(f.db),before,`P-25 ${mask}/${state} refusal changes no table`);
        if(groupApi&&!groupMessaging)assert.equal((await actorRequest(actor,'GET',`/api/groups/${f.groupId}`)).status,200,
            `P-25 Group_API reads remain available when only messaging is off (${state})`);
        coverage.add(`${mask}/${state}`);
        t.diagnostic(`P-25/P-26 groupApi=${groupApi} groupMessaging=${groupMessaging} verifier=${state}: ${write.status}/${write.body.code||write.body.outcome}`);
    }
    assert.equal(coverage.size,12,'all four switch assignments crossed with three verifier states');
});

// ---- the process boundary: server.js on a temporary database, stdout and stderr, exit code ----
function childEnvironment(overrides) {
    const kept = {};
    for (const [key, value] of Object.entries(process.env)) if (!/^(NODE_ENV|HOST|PORT|DB_|AUTH_|GROUPS?_|ATTACHMENTS?_)/.test(key)) kept[key] = value;
    return { ...kept, NODE_ENV: 'test', AUTH_ALLOW_HTTP_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: 'http://localhost:3000', HOST: '127.0.0.1', PORT: '0', ...overrides };
}
// Runs server.js to its end. A child that starts listening is stopped, and the result says so.
function runServer(overrides) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], { cwd: DATA_ROOT, env: childEnvironment(overrides), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let listening = false;
        const timeout = setTimeout(() => { child.kill(); reject(new Error('server.js neither listened nor stopped in time')); }, 20000);
        child.stdout.on('data', piece => {
            stdout += piece;
            if (/listening on port/.test(stdout) && !listening) { listening = true; child.kill(); }
        });
        child.stderr.on('data', piece => { stderr += piece; });
        child.once('error', reject);
        child.once('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr, listening }); });
    });
}
function emptyDatabaseFile(t) {
    const directory = temporaryDirectory(t);
    const file = path.join(directory, 'child.sqlite');
    fs.writeFileSync(file, '');
    return { directory, file };
}
const assertUnmigrated = ({ directory, file }) => {
    assert.deepEqual(fs.readdirSync(directory), ['child.sqlite'], 'no journal, WAL or other file appeared');
    assert.equal(fs.statSync(file).size, 0, 'the database file was not migrated');
};

test('server.js with the Group_API on and one setting missing exits 1 before listening, names it on stderr, and leaves the database unmigrated', async t => {
    for (const missing of GROUP_API_SETTINGS) {
        const target = emptyDatabaseFile(t);
        const values = { ...FAILURE_VALUES };
        delete values[missing];
        const result = await runServer({ DB_PATH: target.file, GROUPS_API_ENABLED: 'true', ...values });
        assert.equal(result.listening, false);
        assert.equal(result.code, 1, missing);
        assert.deepEqual(result.stderr.trim().split(/\r?\n/), [`Feature configuration is incomplete; set a valid value for: ${missing}`]);
        assert.deepEqual(settingNames(result.stderr), [missing], 'names the missing setting and no other');
        assert.ok(!result.stderr.includes(REMOVED_SETTING));
        for (const value of Object.values(FAILURE_VALUES)) assert.ok(!result.stderr.includes(value) && !result.stdout.includes(value), 'no value is printed');
        assert.ok(!result.stdout.includes('listening'));
        assertUnmigrated(target);
    }
    const target = emptyDatabaseFile(t);
    const result = await runServer({ DB_PATH: target.file, GROUPS_API_ENABLED: 'true' });
    assert.equal(result.code, 1);
    assert.deepEqual(settingNames(result.stderr), [...GROUP_API_SETTINGS]);
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1, 'one line for every offending setting');
    assertUnmigrated(target);
});

test('server.js in production with a switch on and no Gate_Record exits 1 naming the variable, and an invalid setting is named the same way', async t => {
    const production = { ...PRODUCTION_ENV, ...FAILURE_VALUES, GROUPS_API_ENABLED: 'true' };
    const target = emptyDatabaseFile(t);
    const result = await runServer({ ...production, DB_PATH: target.file });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stderr.trim().split(/\r?\n/), ['Feature configuration is incomplete; set a valid value for: GROUPS_API_GATE_RECORD']);
    assert.equal(result.listening, false);
    assertUnmigrated(target);
    const invalid = emptyDatabaseFile(t);
    const bad = await runServer({ ...production, GROUPS_API_GATE_RECORD: VALID_RECORD, GROUP_MAX_MEMBERS: '0', DB_PATH: invalid.file });
    assert.equal(bad.code, 1);
    assert.deepEqual(settingNames(bad.stderr), ['GROUP_MAX_MEMBERS']);
    assert.ok(!bad.stderr.includes(VALID_RECORD));
    assertUnmigrated(invalid);
});

test('server.js with a complete configuration starts, migrates the database and prints one line per switch (the control of the failure tests)', async t => {
    const target = emptyDatabaseFile(t);
    const result = await runServer({ DB_PATH: target.file, ...ENABLED_ENV });
    assert.equal(result.listening, true);
    for (const line of switchLines('GROUPS_API_ENABLED')) assert.ok(result.stdout.includes(line), line);
    assert.equal(result.stderr.trim(), '');
    assert.ok(fs.statSync(target.file).size > 0, 'the control did migrate, so the empty file of the failure tests is meaningful');
    const plain = emptyDatabaseFile(t);
    const quiet = await runServer({ DB_PATH: plain.file });
    assert.equal(quiet.listening, true);
    for (const line of switchLines()) assert.ok(quiet.stdout.includes(line), line);
});

test('describeStartFailure builds one line from setting names or the migration file name, and nothing else', async t => {
    const config = new FeatureConfigError(['GROUP_MAX_MEMBERS', 'GROUPS_API_GATE_RECORD']);
    assert.equal(describeStartFailure(config), config.message);
    const forged = { code: 'FEATURE_CONFIG_INVALID', settings: ['GROUP_MAX_MEMBERS', 'lower_case', 'GROUP_MAX_MEMBERS=50', 'A B', 7], message: SENTINEL };
    assert.equal(describeStartFailure(forged), 'Feature configuration is incomplete; set a valid value for: GROUP_MAX_MEMBERS');
    assert.equal(describeStartFailure({ code: 'FEATURE_CONFIG_INVALID', settings: ['x y', 3] }), null);
    assert.equal(describeStartFailure({ code: 'FEATURE_CONFIG_INVALID', settings: 'GROUP_MAX_MEMBERS' }), null);
    assert.equal(describeStartFailure(new FeatureProvenanceError()), new FeatureProvenanceError().message);
    for (const other of [null, undefined, 'text', 7, new Error('boom'), new TypeError('x'), { code: 'MIGRATION_HISTORY_MISMATCH', message: SENTINEL }, { code: 'SQLITE_BUSY' }]) {
        assert.equal(describeStartFailure(other), null, 'every other failure keeps the generic line');
    }
    // A real MIGRATION_FAILED from the runner: the line carries the code and the file name, never the cause or a path.
    const directory = temporaryDirectory(t);
    fs.writeFileSync(path.join(directory, '0001-broken-by-test.sql'), `THIS IS NOT SQL ${SENTINEL};`);
    const db = openDatabase({ filename: ':memory:', migrate: false });
    t.after(() => db.close());
    const failed = await refusal(() => migrate(db, { directory }));
    assert.equal(failed.code, 'MIGRATION_FAILED');
    assert.ok(failed.cause, 'the runner keeps a cause');
    const line = describeStartFailure(failed);
    assert.ok(/^MIGRATION_FAILED: Migration 0001-broken-by-test\.sql failed; the entire batch was rolled back\.$/.test(line), line);
    assert.ok(!line.includes(SENTINEL) && !line.includes(directory) && !line.includes(failed.cause.message) && !/\n/.test(line));
    const hostile = Object.assign(new Error(`Migration C:\\secret\\0001-a.sql failed; ${SENTINEL}`), { code: 'MIGRATION_FAILED' });
    assert.equal(describeStartFailure(hostile), 'MIGRATION_FAILED: a migration failed and the batch was rolled back.');
});

test('start.js is the one place that composes the load: it reads no feature switch itself and has no bypass', () => {
    const source = fs.readFileSync(require.resolve('../server/start'), 'utf8');
    assert.ok(source.indexOf('resolveFeatures(env,features)') < source.indexOf('openDatabase(databaseConfig(env))'), 'the load comes before openDatabase');
    const environmentReads = source.match(/process\.env[.\[][A-Za-z_'"]*/g) || [];
    assert.deepEqual([...new Set(environmentReads)], ['process.env.NODE_ENV'], 'start.js reads NODE_ENV only; every switch goes through loadFeatureConfig');
    assert.ok(!/GROUPS?_[A-Z_]*ENABLED|ATTACHMENTS_API_ENABLED/.test(source.replace(/SWITCH_VARIABLES=Object\.freeze\(\{[^}]*\}\)/, '')), 'a switch variable is named only in the report list');
    assert.ok(!/features\s*=\s*(?:DISABLED_FEATURES|\{)|JSON\.parse|require\(\s*env/.test(source.replace(/const SWITCH_VARIABLES[^\n]*/, '')), 'no default, parsed or env-named configuration');
    const server = fs.readFileSync(require.resolve('../server'), 'utf8');
    assert.ok(/describeStartFailure\(error\)/.test(server) && !/GROUPS?_|process\.env\.[A-Z_]*ENABLED/.test(server), 'server.js prints the line and reads no switch');
});
