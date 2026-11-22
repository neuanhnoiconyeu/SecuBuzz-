'use strict';

// Group_Service infrastructure (T-5C-03; DB5-R12.1, R12.5, R12.6, R12.8, R12.9, R13.5, DB5-R02.3, DB5-R06.2, NFR-01).
// This module holds the shared machinery only: sessions, CSRF proofs, transactions, the commit-time invariant check,
// the uniform 404, the repository error mapping, the audit helper and the rate-limit numbers. It has no operation
// (create, invite, remove ...), no route and no SQL. Those arrive in the tasks that follow, and each of them must go
// through groupRead or groupWrite below.
//
// Trust boundaries.
// 1. The actor is the user of a verified session, read once from the context and checked by auth.checkSession. A user
//    identifier in a request body or path is a target and never an actor (R12.6). visibleGroup refuses any other actor.
// 2. Membership, role and group state are read inside the transaction that uses them, by visibleGroup, and requireRole
//    accepts only a member row that visibleGroup returned in the same transaction (R12.5). A row built from request
//    data, or kept from an earlier transaction, authorizes nothing.
// 3. A write needs a session CSRF proof bound to the same session and user (R12.2). A read runs with the connection in
//    query_only mode, so no code path can write through groupRead.
// 4. Whatever a caller does, a write commits only if every group it looked at still has exactly one active owner and one
//    open interval per active member, and only if every audit write it made succeeded.
// 5. Every failure leaves as an AuthError that carries a code and a status. No database text, name or value is forwarded.
// Nothing here reads the environment, a forwarded header or a clock other than the injected one.

const { createSocialRepository } = require('../database/socialRepository');
const { createGroupRepository, withMembershipTransaction, normaliseError, RepositoryError } = require('../database/groupRepository');
const { createSqliteRateLimiter } = require('../auth/rateLimiter');
const { AuthError } = require('../auth/errors');
const { DISABLED_FEATURES } = require('../features/config');
const { ROLES } = require('./policy');
const { pathId } = require('./validation');

// ASM-03: operational defaults copied from the existing services, not product policy. The per-source numbers are
// configurable (OP-19) through the rates option of createGroupService. No environment variable exists for them, and no
// forwarded header is trusted: the source is the string the route passes in.
const DEFAULT_RATE_LIMITS = Object.freeze({
    readUser: Object.freeze({ limit: 120, windowMs: 60000 }),
    readSource: Object.freeze({ limit: 240, windowMs: 60000 }),
    writeUser: Object.freeze({ limit: 60, windowMs: 60000 }),
    writeSource: Object.freeze({ limit: 120, windowMs: 60000 }),
    inviteUser: Object.freeze({ limit: 20, windowMs: 3600000 }),
    inviteTarget: Object.freeze({ limit: 5, windowMs: 3600000 }),
    inviteSource: Object.freeze({ limit: 60, windowMs: 3600000 }),
    createUser: Object.freeze({ limit: 20, windowMs: 3600000 }),
    createSource: Object.freeze({ limit: 60, windowMs: 3600000 })
});

// The closed list of audit events (DB5-R12.8). Anything else is refused.
const AUDIT_EVENTS = Object.freeze([
    'group.created', 'group.updated', 'group.archived',
    'group.member.added', 'group.member.removed', 'group.member.left',
    'group.role.changed', 'group.owner.transferred',
    'group.invitation.created', 'group.invitation.accepted', 'group.invitation.declined',
    'group.invitation.cancelled', 'group.invitation.expired'
]);

// The one mapping from a repository class to a response (design, Error Handling). Fields are always empty.
const REPOSITORY_ERROR_RESPONSES = Object.freeze({
    DUPLICATE: Object.freeze(['CONFLICT', 409]),
    CONFLICT: Object.freeze(['CONFLICT', 409]),
    INVALID: Object.freeze(['VALIDATION_ERROR', 400]),
    REFERENCE: Object.freeze(['VALIDATION_ERROR', 400]),
    BUSY: Object.freeze(['SERVICE_UNAVAILABLE', 503]),
    UNAVAILABLE: Object.freeze(['SERVICE_UNAVAILABLE', 503])
});

// One 404 for an unknown id, a Direct_Conversation, a legacy-origin group, a group without an extension record and a
// non-member (DB5-R02.3, DB5-R12.7, DB5-R14.18). The response never says which case applied.
function notFound() {
    throw new AuthError('NOT_FOUND', 404, []);
}

function forbidden() {
    throw new AuthError('FORBIDDEN', 403, []);
}

// AuthError passes through unchanged. A RepositoryError, or a driver error, maps by class. Anything else is a 500 with no
// text, no cause and no fields (the class DATABASE, a TypeError of a guard, a failed invariant, any unknown error).
function toAuthError(error) {
    if (error instanceof AuthError) return error;
    const repositoryError = error instanceof RepositoryError ? error : normaliseError(error);
    const code = repositoryError.code;
    const response = typeof code === 'string' && Object.hasOwn(REPOSITORY_ERROR_RESPONSES, code) ? REPOSITORY_ERROR_RESPONSES[code] : null;
    return response ? new AuthError(response[0], response[1], []) : new AuthError('INTERNAL_ERROR', 500, []);
}

const internalError = () => new AuthError('INTERNAL_ERROR', 500, []);
const csrfInvalid = () => new AuthError('CSRF_INVALID', 403, []);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

// Overrides replace single numbers of DEFAULT_RATE_LIMITS. An unknown name or a number that is not a positive whole number
// stops the construction, so a mistake can neither switch a limit off nor invent one.
function resolveRates(overrides) {
    if (overrides === undefined) return DEFAULT_RATE_LIMITS;
    if (!isPlainObject(overrides)) throw new TypeError('rates must be a plain object.');
    const resolved = {};
    for (const name of Object.keys(DEFAULT_RATE_LIMITS)) resolved[name] = DEFAULT_RATE_LIMITS[name];
    for (const name of Object.keys(overrides)) {
        if (!Object.hasOwn(DEFAULT_RATE_LIMITS, name)) throw new TypeError('rates names an unknown limit.');
        const override = overrides[name];
        if (!isPlainObject(override) || Object.keys(override).length === 0
            || Object.keys(override).some(key => key !== 'limit' && key !== 'windowMs')) {
            throw new TypeError('A rate limit override holds only limit and windowMs.');
        }
        const merged = { ...DEFAULT_RATE_LIMITS[name], ...override };
        if (!positiveInteger(merged.limit) || !positiveInteger(merged.windowMs)) {
            throw new TypeError('A rate limit and its window are positive whole numbers.');
        }
        resolved[name] = Object.freeze({ limit: merged.limit, windowMs: merged.windowMs });
    }
    return Object.freeze(resolved);
}

// The settings later operations read. A copy, so a test cannot change one service through an object it shares with another.
function snapshotFeatures(features) {
    if (features === undefined) return DISABLED_FEATURES;
    if (!isPlainObject(features)) throw new TypeError('features must be a plain object.');
    const groups = features.groups === undefined ? {} : features.groups;
    const attachments = features.attachments === undefined ? {} : features.attachments;
    if (!isPlainObject(groups) || !isPlainObject(attachments)) throw new TypeError('features.groups and features.attachments must be plain objects.');
    return Object.freeze({
        groupApi: features.groupApi === true,
        groupMessaging: features.groupMessaging === true,
        attachmentApi: features.attachmentApi === true,
        groups: Object.freeze({ ...groups }),
        attachments: Object.freeze({ ...attachments })
    });
}

function requireSynchronousWork(work) {
    if (typeof work !== 'function' || work.constructor?.name === 'AsyncFunction') throw new TypeError('Group work must be synchronous.');
    return work;
}

function synchronousResult(result) {
    if (result && typeof result.then === 'function') throw new TypeError('Group work must be synchronous.');
    return result;
}

function requireText(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`rate needs ${label}.`);
    return value;
}

/** Group policy infrastructure over the existing injected DAL; no operation, route or SQL of its own. */
function createGroupService({ db, auth, limiter, features, now, rates } = {}) {
    const groups = createGroupRepository(db);
    const social = createSocialRepository(db);
    if (!auth || typeof auth.checkSession !== 'function' || !auth.repository || typeof auth.repository.verifyProof !== 'function') {
        throw new TypeError('createGroupService needs the authentication service.');
    }
    const clock = now === undefined ? auth.now : now;
    if (typeof clock !== 'function') throw new TypeError('createGroupService needs a clock.');
    const bucketLimiter = limiter === undefined ? createSqliteRateLimiter(db) : limiter;
    if (!bucketLimiter || typeof bucketLimiter.consume !== 'function') throw new TypeError('createGroupService needs a rate limiter.');
    const limits = resolveRates(rates);
    const settings = snapshotFeatures(features);

    // The transaction this service is running, or null. Work is synchronous, so there is never more than one.
    let current = null;
    // Member rows that visibleGroup returned, each tied to its transaction. requireRole accepts nothing else.
    const verifiedMembers = new WeakMap();

    const iso = () => new Date(clock()).toISOString();

    function transaction(kind, body) {
        if (current !== null || db.inTransaction) throw new TypeError('Group service transactions cannot be nested.');
        const token = { kind, actor: null, groups: new Set(), auditFailed: false };
        current = token;
        try {
            return body(token);
        } catch (error) {
            throw toAuthError(error);
        } finally {
            current = null;
        }
    }

    // The session is read once, so a context with changing properties cannot pass as one user and act as another.
    function authenticate(context, token) {
        if (!context || typeof context !== 'object') throw new AuthError('UNAUTHENTICATED', 401, []);
        const sessionId = context.sessionId;
        const userId = context.userId;
        const result = auth.checkSession({ sessionId, userId });
        if (result.status !== 'active') throw new AuthError(result.status === 'expired' ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED', 401, []);
        token.actor = userId;
        return { sessionId, userId };
    }

    function verifyCsrf(proof, session) {
        if (!proof || typeof proof !== 'object') throw csrfInvalid();
        const copy = Object.freeze({ type: proof.type, sessionId: proof.sessionId, userId: proof.userId, csrfHash: proof.csrfHash });
        if (copy.type !== 'session' || copy.sessionId !== session.sessionId || copy.userId !== session.userId) throw csrfInvalid();
        try {
            auth.repository.verifyProof(copy, auth.now());
        } catch (error) {
            if (error instanceof RepositoryError && error.code === 'CSRF') throw csrfInvalid();
            throw error;
        }
    }

    // Reads run with the connection in query_only mode, so a write attempted inside a read fails and nothing commits.
    function readOnly(work) {
        const before = db.pragma('query_only', { simple: true });
        db.pragma('query_only = ON');
        try {
            return work();
        } finally {
            db.pragma(before ? 'query_only = ON' : 'query_only = OFF');
        }
    }

    // Exactly one active owner, and one open interval per active member (DB5-R06.2). A group that is not visible fails too.
    function assertGroupInvariants(groupId) {
        if (!db.inTransaction) throw new TypeError('assertGroupInvariants needs the caller transaction.');
        const report = groups.invariantReport(groupId);
        if (report.activeOwners !== 1 || report.openIntervals !== report.activeMembers || report.mismatches !== 0) throw internalError();
    }

    return Object.freeze({
        features: settings,
        rates: limits,

        // Session check, then the work in a deferred transaction with the connection read-only (DB5-R12.1).
        groupRead(context, work) {
            const run = requireSynchronousWork(work);
            return transaction('read', token => social.read(() => {
                const session = authenticate(context, token);
                const stamp = iso();
                return readOnly(() => synchronousResult(run(session.userId, stamp)));
            }));
        },

        // Session check, CSRF proof, then the work in an immediate transaction that also owns the commit-time check of
        // every group the work touched (DB5-R12.1, R12.2, R12.5). Nothing is written after the commit.
        groupWrite(context, proof, work) {
            const run = requireSynchronousWork(work);
            return transaction('write', token => withMembershipTransaction(db, () => {
                const session = authenticate(context, token);
                verifyCsrf(proof, session);
                const result = synchronousResult(run(session.userId, iso()));
                if (token.auditFailed) throw internalError();
                for (const groupId of token.groups) assertGroupInvariants(groupId);
                return result;
            }));
        },

        // Returns {group, member} for an Active_Member of a visible group, and otherwise the one 404 (DB5-R02.3, R14.18).
        visibleGroup(actor, id) {
            if (current === null || !db.inTransaction) throw new TypeError('visibleGroup needs a group service transaction.');
            if (typeof actor !== 'string' || actor !== current.actor) throw new TypeError('visibleGroup accepts only the authenticated actor.');
            const groupId = pathId(id);
            if (groupId === null) notFound();
            const group = groups.getVisibleGroup(groupId);
            if (!group) notFound();
            const row = groups.getMember(groupId, actor);
            if (!row || row.left_at !== null || row.user_id !== actor || row.conversation_id !== groupId) notFound();
            const member = Object.freeze({ ...row });
            verifiedMembers.set(member, current);
            if (current.kind === 'write') current.groups.add(groupId);
            return Object.freeze({ group: Object.freeze({ ...group }), member });
        },

        // Authorizes from a member row read in this transaction. Anything else is refused as a programming error.
        requireRole(member, roles) {
            if (!Array.isArray(roles) || roles.length === 0 || !roles.every(role => ROLES.includes(role))) {
                throw new TypeError('requireRole needs a list of known roles.');
            }
            if (current === null || verifiedMembers.get(member) !== current) {
                throw new TypeError('requireRole needs the member that visibleGroup returned in this transaction.');
            }
            if (!roles.includes(member.role)) forbidden();
        },

        assertGroupInvariants,

        // One AuditLogs row in the caller's transaction. Only the event code, actor, group and optional target and role are
        // written. A failure of any kind becomes a 500 that rolls the transaction back, and is remembered so that a caller
        // that catches it still cannot commit (DB5-R12.8, R12.9).
        audit(actor, eventType, groupId, details = {}) {
            if (!db.inTransaction) throw new TypeError('audit needs the caller transaction.');
            try {
                if (typeof actor !== 'string' || actor.length === 0 || pathId(groupId) === null) throw new TypeError('audit identifiers');
                if (!AUDIT_EVENTS.includes(eventType)) throw new TypeError('audit event');
                if (!isPlainObject(details) || Object.keys(details).some(key => key !== 'targetId' && key !== 'role')) throw new TypeError('audit details');
                const metadata = { operation: eventType.slice('group.'.length), outcome: 'confirmed' };
                if (details.targetId !== undefined) metadata.target_id = details.targetId;
                if (details.role !== undefined) {
                    if (!ROLES.includes(details.role)) throw new TypeError('audit role');
                    metadata.role = details.role;
                }
                groups.repositories.audit.insert({ actor_user_id: actor, event_type: eventType, source: 'groups', subject_id: groupId, metadata });
            } catch (error) {
                if (current !== null) current.auditFailed = true;
                throw internalError();
            }
        },

        // The read and write bucket pairs of DB5-R12.4. The source is the string the route passes; a forwarded header is
        // never read here. Other buckets (invitations, creation) are used by the operations that need them.
        rate(operation, context, source) {
            if (operation !== 'read' && operation !== 'write') throw new TypeError('rate knows the operations read and write.');
            const actor = requireText(context && typeof context === 'object' ? context.userId : undefined, 'a user identifier');
            const from = requireText(source, 'a request source');
            const pair = operation === 'read' ? [['read', actor, limits.readUser], ['read-source', from, limits.readSource]]
                : [['write', actor, limits.writeUser], ['write-source', from, limits.writeSource]];
            let result;
            try {
                result = bucketLimiter.consume(pair.map(([name, subject, limit]) => ({ key: `groups:${name}:${subject}`, limit: limit.limit, windowMs: limit.windowMs })), clock());
            } catch (error) {
                throw toAuthError(error);
            }
            // Only an explicit allowed === true passes. A malformed answer is a server fault, and any other value is a refusal.
            if (!result || typeof result !== 'object') throw internalError();
            if (result.allowed !== true) {
                const error = new AuthError('RATE_LIMITED', 429, []);
                error.retryAfterSeconds = positiveInteger(result.retryAfterSeconds) ? result.retryAfterSeconds : 1;
                throw error;
            }
        }
    });
}

module.exports = { createGroupService, notFound, toAuthError, DEFAULT_RATE_LIMITS, AUDIT_EVENTS };
