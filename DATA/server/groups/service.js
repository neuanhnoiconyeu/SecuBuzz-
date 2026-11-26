'use strict';

// Group_Service (T-5C-03 infrastructure; DB5-R12.1, R12.5, R12.6, R12.8, R12.9, R13.5, DB5-R02.3, DB5-R06.2, NFR-01).
// The shared machinery is sessions, CSRF proofs, transactions, the commit-time invariant check, the uniform 404, the
// repository error mapping, the audit helper and the rate-limit numbers. Each operation (T-5C-07 and later: create, list,
// read, update, member list ...) is one method below. It has no route and no SQL, and goes through groupRead or groupWrite.
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

const { createHash, randomUUID } = require('node:crypto');
const { createSocialRepository } = require('../database/socialRepository');
const { createGroupRepository, withMembershipTransaction, normaliseError, RepositoryError } = require('../database/groupRepository');
const { createSqliteRateLimiter } = require('../auth/rateLimiter');
const { AuthError } = require('../auth/errors');
const { DISABLED_FEATURES } = require('../features/config');
const { ROLES, invitationRevalidation, removalDecision, transferDecision } = require('./policy');
const { pathId, createBody, patchBody, listQuery, membersQuery, invitationBody, memberBody, roleChangeBody, transferBody } = require('./validation');
const codec = require('./cursor');

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

// G01 idempotency (DB5-R01.10, R01.11). The label is v2 because the History_Policy joined the payload, so a key claimed before
// that change never matches. An omitted historyPolicy has already become from_joined in the validated input.
const CREATE_LABEL = 'secubuzz-group-create-v2';
const CREATION_WINDOW_MS = 24 * 60 * 60 * 1000;
function creationFingerprint(input) {
    return createHash('sha256').update(JSON.stringify([CREATE_LABEL, input.name, input.description ?? null, input.historyPolicy]), 'utf8').digest('hex');
}

// The group projection of DB5-R02.2. The name comes from Conversations.title and the description, the History_Policy and the
// revision only from the Group_Extension_Record (DB5-R02.1); the repository row already holds exactly those columns.
function projectGroup(row, role, memberCount) {
    return {
        id: row.conversation_id,
        name: row.title,
        description: row.description ?? null,
        historyPolicy: row.history_policy,
        membershipRevision: row.membership_revision,
        archived: row.archived_at !== null && row.archived_at !== undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        memberCount,
        role
    };
}

// PATCH body checks in the order of DB5-R02.15: the body (criteria 10 and 14) before historyPolicy (criterion 13). The validator
// reports every offending field at once, so a historyPolicy that comes with another fault is dropped from the list and named
// alone only when it is the only fault.
function patchInput(body) {
    try {
        return patchBody(body);
    } catch (error) {
        if (error instanceof AuthError && error.code === 'VALIDATION_ERROR' && Array.isArray(error.fields) && error.fields.includes('historyPolicy')) {
            const others = error.fields.filter(field => field !== 'historyPolicy');
            throw new AuthError('VALIDATION_ERROR', 400, others.length > 0 ? others : ['historyPolicy']);
        }
        throw error;
    }
}

// A decoded cursor of a member list is the pair (time, user id); repository paging needs exactly two strings.
function memberCursor(cursor) {
    if (cursor !== null && (cursor.last.length !== 2 || cursor.last.some(value => typeof value !== 'string'))) {
        throw new AuthError('VALIDATION_ERROR', 400, ['cursor']);
    }
    return cursor;
}

// The pending-Invitation maxima of OD-08 have no default. A missing one, or one that is not a positive whole number, answers
// 503 FEATURE_UNAVAILABLE to an invitation request (DB5-R04.18). Only an injected features object can reach this: start-up
// stops first while the Group_API switch is on.
function pendingMaxima(settings) {
    const perGroup = settings.groups.maxPendingInvitationsPerGroup;
    const perInvitee = settings.groups.maxPendingInvitationsPerInvitee;
    if (!positiveInteger(perGroup) || !positiveInteger(perInvitee)) throw new AuthError('FEATURE_UNAVAILABLE', 503, []);
    return { perGroup, perInvitee };
}

// The invitee named in a request body, for the per-target rate bucket only. It reads one own data property of a plain object
// and nothing else; the body is validated later, in the transaction.
function bodyTarget(body) {
    if (!isPlainObject(body)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(body, 'userId');
    return descriptor && typeof descriptor.value === 'string' && descriptor.value.length > 0 && descriptor.value.length <= 1024 ? descriptor.value : null;
}
// The manager projection of an Invitation (design, API contracts: Projections).
function projectManagerInvitation(row, invitee) {
    return { id: row.invitation_id, groupId: row.conversation_id, invitee, inviterId: row.inviter_id, state: row.state, createdAt: row.created_at, expiresAt: row.expires_at };
}
// Both Invitation lists are ordered by (created time, id), newest first, so their cursors carry that pair.
const TIME_ID_SHAPE = Object.freeze({ last: Object.freeze(['time', 'id']), highWater: false });
const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');

// An Invitation is expired at or after its expiry time, whether or not a row was ever updated (DB5-R04.15).
const isExpired = (invitation, at) => Date.parse(invitation.expires_at) <= Date.parse(at);

/** Group service over the existing injected DAL; no route and no SQL of its own. */
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

    // One limiter call over a list of [bucket name, subject, limit]. A malformed answer is a server fault, and only
    // allowed === true passes.
    function consume(buckets) {
        let result;
        try {
            result = bucketLimiter.consume(buckets.map(([bucket, subject, limit]) => ({ key: `groups:${bucket}:${subject}`, limit: limit.limit, windowMs: limit.windowMs })), clock());
        } catch (error) {
            throw toAuthError(error);
        }
        if (!result || typeof result !== 'object') throw internalError();
        if (result.allowed !== true) {
            const error = new AuthError('RATE_LIMITED', 429, []);
            error.retryAfterSeconds = positiveInteger(result.retryAfterSeconds) ? result.retryAfterSeconds : 1;
            throw error;
        }
    }

    // Public fields of a user for an Invitation projection, from the user and profile records (no e-mail, no credential data).
    const people = groups.repositories;
    function person(userId) {
        const user = people.users.get(userId);
        const profile = people.profiles.get(userId);
        return { id: userId, username: user ? user.username : null, displayName: (profile && profile.display_name) ?? (user ? user.display_name : null) ?? null, avatar: (profile && profile.avatar) ?? null };
    }

    const service = Object.freeze({
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
                const at = token.at = iso();
                const result = synchronousResult(run(session.userId, at));
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
                groups.repositories.audit.insert({ actor_user_id: actor, event_type: eventType, source: 'groups', subject_id: groupId,
                    metadata, created_at: current.at });
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
            if (operation === 'read') consume([['read', actor, limits.readUser], ['read-source', from, limits.readSource]]);
            else consume([['write', actor, limits.writeUser], ['write-source', from, limits.writeSource]]);
        },

        // G01 POST /api/groups (T-5C-07; DB5-R01). The creation buckets (20 per hour per user, 60 per hour per source) are
        // consumed first, outside the transaction, as the limiter keeps its own. The order inside the transaction is the
        // design's: body (400), idempotency key (200 replay, 409 conflict), create. Returns {created, group}.
        createGroup(context, proof, body, source) {
            const actor = requireText(context && typeof context === 'object' ? context.userId : undefined, 'a user identifier');
            consume([['create', actor, limits.createUser], ['create-source', requireText(source, 'a request source'), limits.createSource]]);
            return service.groupWrite(context, proof, (user, at) => {
                const input = createBody(body);
                const fingerprint = creationFingerprint(input);
                if (input.idempotencyKey !== null) {
                    const claimed = groups.getCreationKey(user, input.idempotencyKey);
                    if (claimed && Date.parse(claimed.created_at) >= Date.parse(at) - CREATION_WINDOW_MS) {
                        if (claimed.fingerprint !== fingerprint) throw new AuthError('IDEMPOTENCY_CONFLICT', 409, []);
                        // The original group is returned only to a user who is still an Active_Member of it. A creator who has left
                        // would otherwise read the current name of a group they cannot see; that case answers as a conflict.
                        const original = groups.getVisibleGroup(claimed.conversation_id);
                        const mine = original ? groups.getMember(claimed.conversation_id, user) : null;
                        if (!original || !mine || mine.left_at !== null) throw new AuthError('IDEMPOTENCY_CONFLICT', 409, []);
                        const seen = service.visibleGroup(user, claimed.conversation_id);
                        return { created: false, group: projectGroup(seen.group, seen.member.role, groups.countActiveMembers(claimed.conversation_id)) };
                    }
                }
                const inserted = groups.insertGroup({ created_by: user, title: input.name, description: input.description,
                    historyPolicy: input.historyPolicy, at });
                const id = inserted.conversation_id;
                if (input.idempotencyKey !== null) groups.claimCreationKey(user, input.idempotencyKey, fingerprint, id, at);
                service.audit(user, 'group.created', id);
                // visibleGroup also registers the new group for the commit-time invariant check.
                const seen = service.visibleGroup(user, id);
                return { created: true, group: projectGroup(seen.group, seen.member.role, groups.countActiveMembers(id)) };
            });
        },

        // G02 GET /api/groups (T-5C-08; DB5-R02.4 to R02.7). Only groups of which the requester is an Active_Member, archived
        // ones included; the page is selected by the repository query, so a crafted cursor only moves inside the visible set.
        listGroups(context, query) {
            return service.groupRead(context, actor => {
                const page = listQuery(query, { route: 'groups', userId: actor });
                const rows = groups.listGroupsForUser(actor, { limit: page.limit, after: page.cursor });
                const items = rows.slice(0, page.limit).map(row => ({ ...projectGroup(row, row.role, row.member_count), unreadCount: row.unread_count }));
                const last = rows.length > page.limit ? rows[page.limit - 1] : null;
                const nextCursor = last ? codec.encode({ last: [last.updated_at, last.conversation_id] }, { route: 'groups', userId: actor }) : null;
                return { items, nextCursor };
            });
        },

        // G03 GET /api/groups/:id (T-5C-08; DB5-R02.2, R02.3): the one 404 of visibleGroup for every case that is not a member.
        getGroup(context, id) {
            return service.groupRead(context, actor => {
                const seen = service.visibleGroup(actor, id);
                return projectGroup(seen.group, seen.member.role, groups.countActiveMembers(seen.group.conversation_id));
            });
        },

        // G04 PATCH /api/groups/:id (T-5C-09; DB5-R02.9 to R02.15). Refusal order: 404, 403, archived 409, body 400,
        // historyPolicy 400, stale revision 409. A patch that changes nothing writes nothing and audits nothing.
        updateGroup(context, proof, id, body) {
            return service.groupWrite(context, proof, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                service.requireRole(seen.member, ['owner']);
                const groupId = seen.group.conversation_id;
                if (seen.group.archived_at !== null && seen.group.archived_at !== undefined) throw new AuthError('CONFLICT', 409, []);
                const input = patchInput(body);
                if (input.membershipRevision !== null && input.membershipRevision !== seen.group.membership_revision) throw new AuthError('STALE_STATE', 409, []);
                const patch = {};
                if (Object.hasOwn(input.changes, 'name') && input.changes.name !== seen.group.title) patch.title = input.changes.name;
                if (Object.hasOwn(input.changes, 'description') && input.changes.description !== (seen.group.description ?? null)) patch.description = input.changes.description;
                let row = seen.group;
                if (Object.keys(patch).length > 0) {
                    row = groups.updateSettings(groupId, patch, at);
                    service.audit(actor, 'group.updated', groupId);
                }
                return projectGroup(row, seen.member.role, groups.countActiveMembers(groupId));
            });
        },

        // G05 GET /api/groups/:id/members (T-5C-10; DB5-R03.1 to R03.4, R03.15). 404 for a non-member, then 403 for a member who
        // asks for former members, then the query checks. With former=true the page holds the former members only, each with
        // leftAt, paged by (left time, user id); without it the Active_Members, paged by (joined time, user id).
        listMembers(context, id, query) {
            return service.groupRead(context, actor => {
                const seen = service.visibleGroup(actor, id);
                const groupId = seen.group.conversation_id;
                const askedForFormer = query !== null && typeof query === 'object' && query.former === 'true';
                if (askedForFormer) service.requireRole(seen.member, ['owner', 'admin']);
                const page = membersQuery(query, { userId: actor, conversationId: groupId });
                const rows = groups.listMembers(groupId, { limit: page.limit, after: memberCursor(page.cursor), former: page.former });
                const items = rows.slice(0, page.limit).map(row => ({
                    id: row.user_id,
                    username: row.username,
                    displayName: row.display_name,
                    avatar: row.avatar ?? null,
                    role: row.role,
                    joinedAt: row.joined_at,
                    ...(page.former ? { leftAt: row.left_at } : {})
                }));
                const last = rows.length > page.limit ? rows[page.limit - 1] : null;
                const route = page.former ? 'group-former-members' : 'group-members';
                const nextCursor = last
                    ? codec.encode({ last: [page.former ? last.left_at : last.joined_at, last.user_id] }, { route, userId: actor, conversationId: groupId })
                    : null;
                return { items, nextCursor };
            });
        },

        // G06 is disabled by the approved OD-01 decision in every real configuration. The directAdd
        // switch is accepted only through injected service features for focused tests.
        addMember(context, proof, id, body) {
            if (settings.groups.directAdd !== true) throw new AuthError('FEATURE_UNAVAILABLE', 503, []);
            const maximum = settings.groups.maxMembers;
            if (!positiveInteger(maximum)) throw new AuthError('FEATURE_UNAVAILABLE', 503, []);
            return service.groupWrite(context, proof, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                service.requireRole(seen.member, ['owner', 'admin']);
                if (seen.group.archived_at !== null && seen.group.archived_at !== undefined) throw new AuthError('CONFLICT', 409, []);
                const { userId: target } = memberBody(body);
                if (!social.active(target)) notFound();
                if (social.isBlocked(actor, target)) notFound();
                const old = groups.getMember(seen.group.conversation_id, target);
                if (old && old.left_at === null) throw new AuthError('CONFLICT', 409, []);
                if (groups.countActiveMembers(seen.group.conversation_id) >= maximum) throw new AuthError('CONFLICT', 409, []);
                if (old) groups.reactivateMember(seen.group.conversation_id, target, at);
                else groups.addMember(seen.group.conversation_id, target, at);
                groups.openIntervalAt(seen.group.conversation_id, target, at);
                groups.bumpRevision(seen.group.conversation_id);
                service.audit(actor, 'group.member.added', seen.group.conversation_id, { targetId: target, role: 'member' });
                const member = groups.getMember(seen.group.conversation_id, target);
                const profile = groups.repositories.profiles.get(target);
                const user = groups.repositories.users.get(target);
                if (!member || !user) throw internalError();
                return { member: { id: target, username: user.username, displayName: profile?.display_name ?? user.display_name ?? null,
                    avatar: profile?.avatar ?? null, role: member.role, joinedAt: member.joined_at } };
            });
        },

        // G07 removes another active member; G09 lets a non-owner leave. All four writes
        // and the audit row share groupWrite's immediate transaction and commit guard.
        removeMember(context, proof, id, targetId) {
            return service.groupWrite(context, proof, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                // DB5-R05.16: an active member cannot remove anyone. Check this
                // before target lookup so unknown and former targets do not turn
                // the member's forbidden operation into a target-dependent 404.
                if (seen.member.role === 'member') forbidden();
                const target = pathId(targetId);
                if (target === null) notFound();
                const targetMember = groups.getMember(seen.group.conversation_id, target);
                if (!targetMember || targetMember.left_at !== null) notFound();
                const decision = removalDecision(seen.member.role, targetMember.role);
                if (decision === 'forbidden') forbidden();
                if (decision === 'conflict') throw new AuthError('CONFLICT', 409, []);
                groups.endMembership(seen.group.conversation_id, target, at);
                groups.closeInterval(seen.group.conversation_id, target, at);
                groups.cancelPendingFor(seen.group.conversation_id, target, at);
                groups.bumpRevision(seen.group.conversation_id);
                service.audit(actor, 'group.member.removed', seen.group.conversation_id, { targetId: target });
            });
        },

        leaveGroup(context, proof, id) {
            return service.groupWrite(context, proof, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                if (seen.member.role === 'owner') throw new AuthError('CONFLICT', 409, []);
                groups.endMembership(seen.group.conversation_id, actor, at);
                groups.closeInterval(seen.group.conversation_id, actor, at);
                groups.cancelPendingFor(seen.group.conversation_id, actor, at);
                groups.bumpRevision(seen.group.conversation_id);
                service.audit(actor, 'group.member.left', seen.group.conversation_id);
            });
        },

        // G08 changes a role without changing membership intervals. The requester's role, body,
        // target, revision and final conflict checks follow DB5-R06.17 inside the write transaction.
        changeMemberRole(context, proof, id, targetId, body) {
            return service.groupWrite(context, proof, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                service.requireRole(seen.member, ['owner']);
                const groupId = seen.group.conversation_id;
                if (seen.group.archived_at !== null && seen.group.archived_at !== undefined) throw new AuthError('CONFLICT', 409, []);
                const input = roleChangeBody(body);
                const target = pathId(targetId);
                const member = target === null ? null : groups.getMember(groupId, target);
                if (!member || member.left_at !== null) notFound();
                if (input.membershipRevision !== null && input.membershipRevision !== seen.group.membership_revision) throw new AuthError('STALE_STATE', 409, []);
                if (member.role === 'owner' || member.role === input.role) throw new AuthError('CONFLICT', 409, []);
                groups.changeRole(groupId, target, member.role, input.role);
                groups.bumpRevision(groupId);
                service.audit(actor, 'group.role.changed', groupId, { targetId: target, role: input.role });
                const changed = groups.getMember(groupId, target);
                const user = groups.repositories.users.get(target);
                const profile = groups.repositories.profiles.get(target);
                if (!changed || !user) throw internalError();
                const interval = groups.openInterval(groupId, target);
                if (!interval) throw internalError();
                return { member: { id: target, username: user.username, displayName: profile?.display_name ?? user.display_name ?? null,
                    avatar: profile?.avatar ?? null, role: changed.role, joinedAt: interval.joined_at } };
            });
        },

        // G10 applies the repository's demote-first transfer primitive under one immediate transaction.
        transferOwnership(context, proof, id, body) {
            return service.groupWrite(context, proof, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                service.requireRole(seen.member, ['owner']);
                const groupId = seen.group.conversation_id;
                const archived = seen.group.archived_at !== null && seen.group.archived_at !== undefined;
                if (archived) throw new AuthError('CONFLICT', 409, []);
                const input = transferBody(body);
                const target = pathId(input.userId);
                const member = target === null ? null : groups.getMember(groupId, target);
                const decision = transferDecision({ actorId: actor, actorRole: seen.member.role, targetId: target,
                    targetRole: member && member.left_at === null ? member.role : null, archived,
                    precondition: input.membershipRevision, revision: seen.group.membership_revision });
                if (decision.decision === 'forbidden') forbidden();
                if (decision.decision === 'conflict') throw new AuthError('CONFLICT', 409, []);
                if (decision.decision === 'invalid') throw new AuthError('VALIDATION_ERROR', 400, ['userId']);
                if (decision.decision === 'stale') throw new AuthError('STALE_STATE', 409, []);
                groups.transferOwnership(groupId, actor, target);
                groups.bumpRevision(groupId);
                service.audit(actor, 'group.owner.transferred', groupId, { targetId: target, role: 'owner' });
                const current = service.visibleGroup(actor, groupId);
                return { group: projectGroup(current.group, current.member.role, groups.countActiveMembers(groupId)) };
            });
        },

        // G11 is archive-only: the row and its related data remain, while repository CAS and
        // groupWrite make the archived timestamp and audit event atomic.
        archiveGroup(context, proof, id) {
            return service.groupWrite(context, proof, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                service.requireRole(seen.member, ['owner']);
                if (seen.group.archived_at !== null && seen.group.archived_at !== undefined) throw new AuthError('CONFLICT', 409, []);
                const archived = groups.archiveGroup(seen.group.conversation_id, at);
                service.audit(actor, 'group.archived', seen.group.conversation_id);
                return { group: projectGroup(archived, seen.member.role, groups.countActiveMembers(seen.group.conversation_id)) };
            });
        },

        // G12 POST /api/groups/:id/invitations (T-5C-11; DB5-R04.1 to R04.5, R04.18 to R04.21). Returns {invitation}, the manager
        // projection of the new pending Invitation. The refusal order is: 503 for an unset maximum, 429 from the three buckets
        // (20 per hour per user, 5 per hour per user, group and invitee, 60 per hour per source; the limiter keeps its own
        // transaction, so they are consumed first), then inside one immediate transaction 404 (not an Active_Member), 403 (role),
        // 409 (archived), 400 (body), 404 (invitee unknown, disabled, without credential or blocked, one answer), 409 (already
        // an Active_Member), 409 (a pending Invitation exists, or a maximum is reached), then the insert and its audit row.
        createInvitation(context, proof, id, body, source) {
            const maxima = pendingMaxima(settings);
            const actor = requireText(context && typeof context === 'object' ? context.userId : undefined, 'a user identifier');
            const from = requireText(source, 'a request source');
            const named = bodyTarget(body);
            const buckets = [['invite', actor, limits.inviteUser]];
            if (named !== null) buckets.push(['invite-target', sha256Hex(JSON.stringify([actor, String(id), named])), limits.inviteTarget]);
            buckets.push(['invite-source', from, limits.inviteSource]);
            consume(buckets);
            return service.groupWrite(context, proof, (user, at) => {
                const seen = service.visibleGroup(user, id);
                service.requireRole(seen.member, ['owner', 'admin']);
                const groupId = seen.group.conversation_id;
                if (seen.group.archived_at !== null && seen.group.archived_at !== undefined) throw new AuthError('CONFLICT', 409, []);
                const { userId: target } = invitationBody(body);
                if (!social.active(target) || social.isBlocked(user, target)) notFound();
                const existing = groups.getMember(groupId, target);
                if (existing && existing.left_at === null) throw new AuthError('CONFLICT', 409, []);
                // A past-expiry pending row of this pair becomes expired first, so it neither blocks the insert nor counts.
                if (groups.expirePast(groupId, target, at) > 0) service.audit(user, 'group.invitation.expired', groupId, { targetId: target });
                if (groups.findPending(groupId, target) !== null) throw new AuthError('CONFLICT', 409, []);
                if (groups.countPendingForGroup(groupId, at) >= maxima.perGroup || groups.countPendingForInvitee(target, at) >= maxima.perInvitee) {
                    throw new AuthError('CONFLICT', 409, []);
                }
                const created = groups.insertInvitation({ invitation_id: randomUUID(), conversation_id: groupId, invitee_id: target, inviter_id: user, created_at: at });
                service.audit(user, 'group.invitation.created', groupId, { targetId: target });
                return { invitation: projectManagerInvitation(created, person(target)) };
            });
        },

        // G13 GET /api/groups/:id/invitations (T-5C-11). Owner and admin only: 404, 403, then the query checks (400). Pending
        // Invitations whose expiry time is later than the server time, newest first, with the manager projection.
        listInvitations(context, id, query) {
            return service.groupRead(context, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                service.requireRole(seen.member, ['owner', 'admin']);
                const groupId = seen.group.conversation_id;
                const route = { route: 'group-invitations', userId: actor, conversationId: groupId };
                const page = listQuery(query, route, TIME_ID_SHAPE);
                const rows = groups.listPendingForGroup(groupId, at, { limit: page.limit, after: page.cursor });
                const items = rows.slice(0, page.limit).map(row => projectManagerInvitation(row, person(row.invitee_id)));
                const last = rows.length > page.limit ? rows[page.limit - 1] : null;
                return { items, nextCursor: last ? codec.encode({ last: [last.created_at, last.invitation_id] }, route) : null };
            });
        },

        // G14 DELETE /api/groups/:id/invitations/:invitationId (T-5C-12; DB5-R04.14, R04.17, R04.21, R04.22). The inviter, the
        // owner or an admin cancels a pending Invitation. 404 for a requester who is not an Active_Member, and for an owner or
        // admin whose group has no such Invitation; 403 for any other Active_Member (the same answer whether or not the
        // Invitation exists, so a member learns nothing about it); 409 when the Invitation is no longer pending or its expiry
        // time has passed. Returns {id, state: 'cancelled'}.
        cancelInvitation(context, proof, id, invitationId) {
            return service.groupWrite(context, proof, (actor, at) => {
                const seen = service.visibleGroup(actor, id);
                const groupId = seen.group.conversation_id;
                const key = pathId(invitationId);
                const found = key === null ? null : groups.getInvitation(key);
                const invitation = found && found.conversation_id === groupId ? found : null;
                const manager = seen.member.role === 'owner' || seen.member.role === 'admin';
                if (!manager && !(invitation && invitation.inviter_id === actor)) forbidden();
                if (!invitation) notFound();
                if (invitation.state !== 'pending' || isExpired(invitation, at)) throw new AuthError('CONFLICT', 409, []);
                groups.resolveInvitation(invitation.invitation_id, 'cancelled', at);
                service.audit(actor, 'group.invitation.cancelled', groupId, { targetId: invitation.invitee_id });
                return { id: invitation.invitation_id, state: 'cancelled' };
            });
        },

        // G15 GET /api/groups/invitations (T-5C-12; DB5-R04.6). The caller's own unexpired pending Invitations, newest first,
        // with the group name and the inviter's display name and nothing about the members or the messages of the group.
        listOwnInvitations(context, query) {
            return service.groupRead(context, (actor, at) => {
                const route = { route: 'own-invitations', userId: actor };
                const page = listQuery(query, route, TIME_ID_SHAPE);
                const rows = groups.listPendingForInvitee(actor, at, { limit: page.limit, after: page.cursor });
                const items = rows.slice(0, page.limit).map(row => ({
                    id: row.invitation_id,
                    groupId: row.conversation_id,
                    groupName: row.group_name,
                    inviterDisplayName: row.inviter_display_name,
                    createdAt: row.created_at,
                    expiresAt: row.expires_at
                }));
                const last = rows.length > page.limit ? rows[page.limit - 1] : null;
                return { items, nextCursor: last ? codec.encode({ last: [last.created_at, last.invitation_id] }, route) : null };
            });
        },

        // G17 POST /api/groups/invitations/:invitationId/decline (T-5C-12; DB5-R04.13, R04.15, R04.16, R04.17, R04.22). Only the
        // invitee: 404 for an unknown id and for any other user, with one answer; 409 when the Invitation is no longer pending
        // or its expiry time has passed. No membership, revision or re-invite delay changes. Returns {id, state: 'declined'}.
        declineInvitation(context, proof, invitationId) {
            return service.groupWrite(context, proof, (actor, at) => {
                const key = pathId(invitationId);
                const invitation = key === null ? null : groups.getInvitation(key);
                if (!invitation || invitation.invitee_id !== actor) notFound();
                if (invitation.state !== 'pending' || isExpired(invitation, at)) throw new AuthError('CONFLICT', 409, []);
                groups.resolveInvitation(invitation.invitation_id, 'declined', at);
                service.audit(actor, 'group.invitation.declined', invitation.conversation_id);
                return { id: invitation.invitation_id, state: 'declined' };
            });
        },

        // G16 POST /api/groups/invitations/:invitationId/accept (T-5C-13; DB5-R04.8 to R04.11, R04.15, R04.16, R04.22, R03.12 to
        // R03.14). One immediate transaction, decided from rows read inside it. 404 for an unknown id and for any user but the
        // invitee (one answer); 409 with no change when the Invitation is no longer pending. The checks of policy.js
        // invitationRevalidation then run in their fixed order. A failed check is a committed refusal (DC-09): the Invitation
        // becomes expired (the expiry time has passed) or cancelled (every other check, an invitee who is already an Active_Member
        // included, whose member row is left alone), one audit row is written, the transaction commits, and only then the 409 is
        // thrown. Membership, role, revision and intervals stay as they were. On success the Invitation becomes accepted, the invitee
        // is added (or the former member row reactivated with the role member), a new interval opens, the revision goes up by 1 and
        // one audit row is written; the answer is {group}. An audit failure rolls everything back (500). The member maximum comes
        // from the configuration (features.groups.maxMembers); when it is not a positive whole number nothing is read or changed
        // and the answer is 503 FEATURE_UNAVAILABLE, so a configuration fault never cancels an Invitation.
        acceptInvitation(context, proof, invitationId) {
            const maxMembers = settings.groups.maxMembers;
            if (!positiveInteger(maxMembers)) throw new AuthError('FEATURE_UNAVAILABLE', 503, []);
            const result = service.groupWrite(context, proof, (actor, at) => {
                const key = pathId(invitationId);
                const invitation = key === null ? null : groups.getInvitation(key);
                if (!invitation || invitation.invitee_id !== actor) notFound();
                const groupId = invitation.conversation_id;
                const group = groups.getVisibleGroup(groupId);
                const inviter = groups.getMember(groupId, invitation.inviter_id);
                const mine = groups.getMember(groupId, actor);
                const verdict = invitationRevalidation({
                    now: at,
                    invitation: { state: invitation.state, createdAt: invitation.created_at, expiresAt: invitation.expires_at },
                    group: group ? { archived: group.archived_at !== null && group.archived_at !== undefined } : null,
                    inviter: inviter && inviter.left_at === null ? { role: inviter.role } : null,
                    invitee: { active: Boolean(mine && mine.left_at === null), leftAt: mine ? mine.left_at : null },
                    blocked: social.isBlocked(invitation.inviter_id, actor),
                    activeMembers: groups.countActiveMembers(groupId),
                    maxMembers
                });
                if (verdict.outcome === 'unchanged') throw new AuthError('CONFLICT', 409, []);
                if (!verdict.ok) {
                    groups.resolveInvitation(invitation.invitation_id, verdict.outcome, at);
                    service.audit(actor, verdict.outcome === 'expired' ? 'group.invitation.expired' : 'group.invitation.cancelled', groupId);
                    return { refused: true };
                }
                groups.resolveInvitation(invitation.invitation_id, 'accepted', at);
                if (mine) groups.reactivateMember(groupId, actor, at); else groups.addMember(groupId, actor, at);
                groups.openIntervalAt(groupId, actor, at);
                groups.bumpRevision(groupId);
                service.audit(actor, 'group.invitation.accepted', groupId, { role: 'member' });
                // visibleGroup also registers the group for the commit-time invariant check.
                const seen = service.visibleGroup(actor, groupId);
                return { group: projectGroup(seen.group, seen.member.role, groups.countActiveMembers(groupId)) };
            });
            if (result.refused) throw new AuthError('CONFLICT', 409, []);
            return result;
        }
    });
    return service;
}

module.exports = { createGroupService, notFound, toAuthError, DEFAULT_RATE_LIMITS, AUDIT_EVENTS };
