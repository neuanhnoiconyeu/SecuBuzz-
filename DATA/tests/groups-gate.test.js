const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = require('../server/features/config');

const { DISABLED_FEATURES, GROUP_API_SETTINGS, FeatureConfigError, loadFeatureConfig } = config;

const SWITCHES = [
    ['groupApi', 'GROUPS_API_ENABLED'],
    ['groupMessaging', 'GROUP_MESSAGING_ENABLED'],
    ['attachmentApi', 'ATTACHMENTS_API_ENABLED']
];
const REMOVED_SETTING = 'GROUP_INVITATION_TTL_SECONDS';
// Valid companion values, so a switch test does not depend on value validation (DB-5C).
const GROUP_VALUES = Object.freeze({
    GROUP_MAX_MEMBERS: '50',
    GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: '20',
    GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: '30'
});
const settingNames = message => message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];

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
            const env = { ...GROUP_VALUES };
            if (value !== undefined) env[variable] = value;
            const features = loadFeatureConfig(env);
            assert.equal(features[key], expected, `${variable} ${label}`);
            for (const [otherKey] of SWITCHES) if (otherKey !== key) assert.equal(features[otherKey], false, `${otherKey} stays off when ${variable} is ${label}`);
        }
    }
});

test('an empty environment yields everything disabled and no default for any setting', () => {
    const features = loadFeatureConfig({});
    assert.deepEqual(features, DISABLED_FEATURES);
    assert.deepEqual(Object.keys(features.groups), []);
});

test('loadFeatureConfig returns a frozen result and requires an explicit environment object', () => {
    const features = loadFeatureConfig({ ...GROUP_VALUES, GROUPS_API_ENABLED: 'true', GROUP_MESSAGING_ENABLED: 'true', ATTACHMENTS_API_ENABLED: 'true' });
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
    assert.deepEqual(Object.keys(config).sort(), ['DISABLED_FEATURES', 'FeatureConfigError', 'GROUP_API_SETTINGS', 'loadFeatureConfig']);
    assert.ok(!JSON.stringify({ DISABLED_FEATURES, GROUP_API_SETTINGS }).includes(REMOVED_SETTING));
    assert.ok(!new FeatureConfigError(GROUP_API_SETTINGS).message.includes(REMOVED_SETTING));
    const source = fs.readFileSync(require.resolve('../server/features/config'), 'utf8');
    assert.ok(!source.includes(REMOVED_SETTING));
    assert.ok(!/process\.env/.test(source), 'env is always a parameter');
    assert.ok(/^[\x00-\x7F]*$/.test(source), 'ASCII only');
});
