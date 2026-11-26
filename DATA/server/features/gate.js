'use strict';

// Feature_Gate runtime (T-5C-02; DB5-R16.1, R16.2, R16.4, R16.5, R16.13).
// Consumes a configuration from features/config.js (or an injected features object,
// which is plain per-app data). It holds no module state: each gate keeps its own
// snapshot, so two application instances in one process never share a switch.
//
// Fail closed. The gate refuses a malformed configuration instead of enabling
// anything, names only switch names in its errors, and never reads, logs or echoes
// a configured value. Nothing here touches the request, the response, the database
// or the rate limiter: a disabled function answers before any of them is used.
// The Gate_Record and setting checks belong to features/config.js (T-5C-01); the
// ATTACHMENTS_API_GATE_RECORD check is deferred to T-6B-22 (owner decision).

const path = require('node:path');
const { DISABLED_FEATURES, ATTACHMENT_API_SETTINGS } = require('./config');
const { createFilesystemProvider } = require('../attachments/storage/filesystem');
const { AuthError } = require('../auth/errors');

const FEATURE_NAMES = Object.freeze(['groupApi', 'groupMessaging', 'attachmentApi']);

function requireConfig(config) {
    if (config === null || typeof config !== 'object') {
        throw new TypeError('createFeatureGate requires a feature configuration object.');
    }
    for (const name of FEATURE_NAMES) {
        // A missing or non-boolean switch is a start error, never an implicit "on".
        if (typeof config[name] !== 'boolean') {
            throw new TypeError(`createFeatureGate requires the switch ${name} to be a boolean.`);
        }
    }
}

function featureKey(name) {
    if (name === 'attachments') return 'attachmentApi';
    if (!FEATURE_NAMES.includes(name)) throw new TypeError('Unknown feature name.');
    return name;
}

const ATTACHMENT_KEYS = Object.freeze({
    ATTACHMENT_PENDING_TTL_SECONDS:'pendingTtlSeconds', ATTACHMENT_PURGE_DELAY_SECONDS:'purgeDelaySeconds',
    ATTACHMENT_RETENTION_INTERVAL_SECONDS:'retentionIntervalSeconds', ATTACHMENT_QUOTA_USER_BYTES:'quotaUserBytes',
    ATTACHMENT_QUOTA_CONVERSATION_BYTES:'quotaConversationBytes', ATTACHMENT_MAX_PENDING_PER_USER:'maxPendingPerUser',
    ATTACHMENT_UPLOADS_PER_HOUR:'uploadsPerHour', ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_USER:'maxConcurrentUploadsPerUser',
    ATTACHMENT_MAX_CONCURRENT_UPLOADS_PER_SOURCE:'maxConcurrentUploadsPerSource'
});
function attachmentReady(config, { providerFactory=createFilesystemProvider, repositoryRoot=path.resolve(__dirname, '../..') } = {}) {
    if (config.attachmentApi !== true || !config.attachments || typeof config.attachments !== 'object') return false;
    for (const name of ATTACHMENT_API_SETTINGS) {
        const value = config.attachments[ATTACHMENT_KEYS[name]];
        if (!Number.isSafeInteger(value) || value < 1) return false;
    }
    const timeout = config.attachments.uploadTimeoutSeconds;
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1)) return false;
    if (typeof config.attachments.storageDir !== 'string' || config.attachments.storageDir.length === 0) return false;
    try {
        providerFactory({ root:config.attachments.storageDir, repositoryRoot });
        return true;
    } catch {
        return false;
    }
}

function unavailable() {
    return new AuthError('FEATURE_UNAVAILABLE', 503, []);
}

// Builds a gate from a configuration. Without an argument the gate is entirely off.
// The switches are copied at creation, so a later change to the source object has no effect.
function createFeatureGate(config = DISABLED_FEATURES) {
    requireConfig(config);
    // groupMessaging is reported only while the Group_API switch is on (DB5-R16.13).
    const snapshot = Object.freeze({
        groupApi: config.groupApi === true,
        groupMessaging: config.groupApi === true && config.groupMessaging === true,
        attachmentApi: config.attachmentApi === true && attachmentReady(config)
    });

    function enabled(name) {
        return snapshot[featureKey(name)];
    }

    return Object.freeze({
        // A fresh frozen object each call, with exactly the three booleans.
        status() {
            return Object.freeze({ groupApi: snapshot.groupApi, groupMessaging: snapshot.groupMessaging, attachmentApi: snapshot.attachmentApi });
        },
        enabled,
        // Throws the existing AuthError with code FEATURE_UNAVAILABLE, status 503 and no fields.
        assertEnabled(name) {
            if (!enabled(name)) throw unavailable();
        },
        // Express-style middleware. A disabled function passes an AuthError to next, which the
        // application's error handler turns into 503 FEATURE_UNAVAILABLE. It reads neither the
        // request nor the response, so no rate-limit write or group read happens first.
        middleware(name) {
            featureKey(name);
            return function featureGate(request, response, next) {
                if (snapshot[featureKey(name)]) return next();
                return next(unavailable());
            };
        }
    });
}

module.exports = { createFeatureGate, FEATURE_NAMES, attachmentReady };
