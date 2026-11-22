'use strict';

// Feature_Gate configuration (DB5-R16.1, R16.5, R16.7, R16.8).
// T-5B-14 added the three switches. T-5C-01 adds the validation of the required
// companion settings and the production Gate_Record acknowledgement.
// Nothing reads this module at runtime yet: app.js and start.js are unchanged, so
// every function stays disabled until features/gate.js and the start-up wiring
// exist (T-5C-02, T-5C-05).
//
// Fail closed. A switch that is on with a missing or invalid required setting makes
// loadFeatureConfig throw FeatureConfigError. It never returns a partial or enabled
// result, and the error names settings only, never values.

// A switch is on only when its variable holds exactly this string.
const ENABLING_VALUE = 'true';
const PRODUCTION = 'production';

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

// Property of the `groups` object that carries each setting. An injected
// features.groups object (test harness, DB5-R16.5) uses the same property names.
// The property names of the two pending maxima are chosen here (T-5C-01).
const GROUP_SETTING_KEYS = Object.freeze({
    GROUP_MAX_MEMBERS: 'maxMembers',
    GROUP_MAX_PENDING_INVITATIONS_PER_GROUP: 'maxPendingInvitationsPerGroup',
    GROUP_MAX_PENDING_INVITATIONS_PER_INVITEE: 'maxPendingInvitationsPerInvitee'
});

// OP-11: in production a switch that is on also needs a Gate_Record id. The server
// checks the format only; it does not look the record up. The attachment record
// variable joins with the attachment settings in DB-6B (T-6B-22).
const GATE_RECORD_VARIABLES = Object.freeze({
    groupApi: 'GROUPS_API_GATE_RECORD',
    groupMessaging: 'GROUP_MESSAGING_GATE_RECORD'
});
const GATE_RECORD_FORMAT = /^GR-[A-Z0-9-]{3,48}$/;

// A positive whole number is plain ASCII digits with no sign, no leading zero, no
// fraction, no exponent and no padding. Anything else is invalid.
const POSITIVE_WHOLE_NUMBER = /^[1-9][0-9]*$/;

// Every setting a FeatureConfigError may name. The attachment settings join in DB-6B.
const DECLARED_SETTINGS = Object.freeze([...GROUP_API_SETTINGS, ...Object.values(GATE_RECORD_VARIABLES)]);

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

// Returns the number, or null for anything that is not a positive whole number a
// double holds exactly (a string only; a number or any other type is invalid).
function positiveWholeNumber(value) {
    if (typeof value !== 'string' || !POSITIVE_WHOLE_NUMBER.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
}

function validGateRecord(value) {
    return typeof value === 'string' && GATE_RECORD_FORMAT.test(value);
}

// Reads the switches and, for a switch that is on, its required settings. The settings
// of a switch that is off are not read, so they can neither stop the start nor enable
// anything. Group messaging and the Attachment_API need no Group_API setting here;
// reporting group messaging only while the Group_API is on belongs to gate.js.
function loadFeatureConfig(env) {
    if (env === null || typeof env !== 'object') {
        throw new TypeError('loadFeatureConfig requires an environment object.');
    }
    const groupApi = switchOn(env, SWITCH_VARIABLES.groupApi);
    const groupMessaging = switchOn(env, SWITCH_VARIABLES.groupMessaging);
    const attachmentApi = switchOn(env, SWITCH_VARIABLES.attachmentApi);

    const problems = new Set();
    const groups = {};
    if (groupApi) {
        for (const name of GROUP_API_SETTINGS) {
            const value = positiveWholeNumber(env[name]);
            if (value === null) problems.add(name);
            else groups[GROUP_SETTING_KEYS[name]] = value;
        }
        // OD-01 (decided in part): direct add stays disabled. No environment variable
        // exists for it; only an injected features object enables it, in tests.
        groups.directAdd = false;
    }
    if (env.NODE_ENV === PRODUCTION) {
        if (groupApi && !validGateRecord(env[GATE_RECORD_VARIABLES.groupApi])) problems.add(GATE_RECORD_VARIABLES.groupApi);
        if (groupMessaging && !validGateRecord(env[GATE_RECORD_VARIABLES.groupMessaging])) problems.add(GATE_RECORD_VARIABLES.groupMessaging);
    }
    if (problems.size > 0) throw new FeatureConfigError([...problems]);

    return Object.freeze({
        groupApi,
        groupMessaging,
        attachmentApi,
        groups: Object.freeze(groups),
        attachments: Object.freeze({})
    });
}

module.exports = { DISABLED_FEATURES, GROUP_API_SETTINGS, FeatureConfigError, loadFeatureConfig };