'use strict';

// Feature_Gate configuration skeleton (T-5B-14; DB5-R16.1, R16.5, R16.7).
// Nothing reads this module at runtime yet: app.js and start.js are unchanged,
// so every function stays disabled. Value validation of the companion settings,
// features/gate.js and all wiring belong to DB-5C (T-5C-01).

// A switch is on only when its variable holds exactly this string.
const ENABLING_VALUE = 'true';

const SWITCH_VARIABLES = Object.freeze({
    groupApi: 'GROUPS_API_ENABLED',
    groupMessaging: 'GROUP_MESSAGING_ENABLED',
    attachmentApi: 'ATTACHMENTS_API_ENABLED'
});

// Required companion settings of the Group_API switch. None has a default in code.
// GROUP_MAX_MEMBERS: OD-04 decided (approved value 50, supplied as configuration).
// The two pending-Invitation maxima: OD-08 unresolved, no default.
// The Invitation expiry is the fixed constant INVITATION_EXPIRY_SECONDS of
// groups/policy.js and is not a setting; no setting exists for a re-invite delay.
const GROUP_API_SETTINGS = Object.freeze([
    'GROUP_MAX_MEMBERS',
    'GROUP_MAX_PENDING_INVITATIONS_PER_GROUP',
    'GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE'
]);

// Every setting a FeatureConfigError may name. The attachment settings join in DB-6B.
const DECLARED_SETTINGS = Object.freeze([...GROUP_API_SETTINGS]);

const DISABLED_FEATURES = Object.freeze({
    groupApi: false,
    groupMessaging: false,
    attachmentApi: false,
    groups: Object.freeze({}),
    attachments: Object.freeze({})
});

// Start failure that names missing or invalid settings. It accepts setting names
// only, never values, so its message cannot reveal a configured value.
class FeatureConfigError extends Error {
    constructor(settings) {
        if (!Array.isArray(settings) || settings.length === 0) {
            throw new TypeError('FeatureConfigError requires a non-empty list of setting names.');
        }
        if (!settings.every(name => typeof name === 'string' && DECLARED_SETTINGS.includes(name))) {
            throw new TypeError('FeatureConfigError accepts declared setting names only.');
        }
        const named = Object.freeze(DECLARED_SETTINGS.filter(name => settings.includes(name)));
        super(`Feature configuration is incomplete; set a valid value for: ${named.join(', ')}`);
        this.name = 'FeatureConfigError';
        this.code = 'FEATURE_CONFIG_INVALID';
        this.settings = named;
    }
}

function switchOn(env, variable) {
    return env[variable] === ENABLING_VALUE;
}

// Skeleton: reads the three switches only. The companion settings are not read
// or validated here until DB-5C (T-5C-01).
function loadFeatureConfig(env) {
    if (env === null || typeof env !== 'object') {
        throw new TypeError('loadFeatureConfig requires an environment object.');
    }
    return Object.freeze({
        groupApi: switchOn(env, SWITCH_VARIABLES.groupApi),
        groupMessaging: switchOn(env, SWITCH_VARIABLES.groupMessaging),
        attachmentApi: switchOn(env, SWITCH_VARIABLES.attachmentApi),
        groups: Object.freeze({}),
        attachments: Object.freeze({})
    });
}

module.exports = { DISABLED_FEATURES, GROUP_API_SETTINGS, FeatureConfigError, loadFeatureConfig };
