// Group_Repository core (T-5B-22). Design: Components and Interfaces, "Group_Repository (database/groupRepository.js)",
// and Error Handling, "Repository error class mapping". Requirements: DB5-R14.14, DB5-R13.5, DB5-R11.5, ARCH-R01.6, NFR-01.
//
// This is the only runtime module with group SQL, meaning statements that name GroupExtensions, GroupMembershipIntervals,
// ConversationInvitations, GroupReadPositions or GroupCreationKeys (the migration files excepted). The tests scan the
// runtime tree for such statements, and scan this file for any prepare call that is not one plain string literal.
//
// Rules for every function of this module (the read and write functions of T-5B-24 to T-5B-28 follow them too):
// 1. Each SQL text is a single string literal written directly inside db.prepare(...). Every value is a bound parameter:
//    no template placeholder, no string concatenation and no db.exec in this file (DB5-R14.14).
// 2. Conversations, members, messages, receipts, attachments and audit rows are reached through the composed
//    createRepositories(db), as socialRepository.js does; their SQL is not repeated here (ARCH-R01.6).
// 3. A read function is defined with readFunction() and a write function with writeFunction(). A write function throws
//    TypeError unless db.inTransaction, so it runs only inside the caller's immediate transaction. It also runs in a
//    savepoint, so a write that throws leaves no change behind even when the caller catches the error (DB5-R11.5, NFR-01).
// 4. Every state-changing UPDATE is a compare-and-set: its WHERE clause names the expected previous state, and it runs
//    through compareAndSet(), which throws CONFLICT unless exactly one row changed.
// 5. Errors leave as a RepositoryError whose code is one class of ERROR_CLASSES (normaliseError). Its message is fixed
//    text that names the class only: no driver message, SQL, bound value, table, column, index, constraint or trigger name.
const { SqliteError } = require('better-sqlite3');
const { createRepositories, RepositoryError } = require('./repositories');
const { FORMER_OWNER_ROLE, HISTORY_POLICIES, INVITATION_EXPIRY_SECONDS } = require('../groups/policy');

const ERROR_CLASSES = Object.freeze(['DUPLICATE', 'CONFLICT', 'INVALID', 'REFERENCE', 'BUSY', 'UNAVAILABLE', 'DATABASE']);
const FALLBACK_CLASS = 'DATABASE';

// The repository error class mapping, kept in this one table. Keys are the SQLite result code names that the driver
// reports in error.code. An extended code (for example SQLITE_IOERR_WRITE) is looked up first, then its primary code
// (SQLITE_IOERR). A driver error that matches neither, and any error that does not come from the driver, is DATABASE.
//
// CI-12: translate() in repositories.js maps a trigger abort to INVALID; this table maps it to CONFLICT. translate()
// itself is unchanged, and errors that the composed repositories already translated pass through normaliseError as they are.
//
// OP-09 PROVISIONAL: the four UNAVAILABLE rows (cannot open, I/O error, disk full, read-only database) are the default
// recommended by Kiro and NOT approved by the Project_Owner. If the decision differs, change or delete those rows here
// and nowhere else; a deleted row falls back to DATABASE.
const ERROR_CLASS_BY_CODE = Object.freeze({
    SQLITE_CONSTRAINT_PRIMARYKEY: 'DUPLICATE',
    SQLITE_CONSTRAINT_UNIQUE: 'DUPLICATE',
    SQLITE_CONSTRAINT_TRIGGER: 'CONFLICT',
    SQLITE_CONSTRAINT_CHECK: 'INVALID',
    SQLITE_CONSTRAINT_FOREIGNKEY: 'REFERENCE',
    SQLITE_CONSTRAINT: 'INVALID', // every other constraint kind (NOT NULL, datatype, ...), classed as translate() classes it
    SQLITE_BUSY: 'BUSY',
    SQLITE_LOCKED: 'BUSY',
    SQLITE_CANTOPEN: 'UNAVAILABLE', // OP-09 PROVISIONAL
    SQLITE_IOERR: 'UNAVAILABLE', // OP-09 PROVISIONAL
    SQLITE_FULL: 'UNAVAILABLE', // OP-09 PROVISIONAL
    SQLITE_READONLY: 'UNAVAILABLE', // OP-09 PROVISIONAL
});

function errorClass(error) {
    if (!(error instanceof SqliteError) || typeof error.code !== 'string') return FALLBACK_CLASS;
    const primary = error.code.split('_', 2).join('_');
    for (const code of [error.code, primary]) {
        if (Object.hasOwn(ERROR_CLASS_BY_CODE, code)) return ERROR_CLASS_BY_CODE[code];
    }
    return FALLBACK_CLASS;
}

// Errors are normalised once. A RepositoryError (raised in this module, or by a composed repository through translate())
// passes unchanged. Any other error becomes a new RepositoryError of its class, with no cause attached.
function normaliseError(error) {
    return error instanceof RepositoryError ? error : new RepositoryError(errorClass(error));
}

const KIND = 'kind';
// Connection-scoped capability: membership primitives cannot run in an ordinary
// caller transaction. Only the owning boundary below can validate and commit.
const membershipTransactions = new WeakMap();
const requireFunction = (operation, label) => {
    if (typeof operation !== 'function') throw new TypeError(`${label} needs a function`);
};

// A read function: errors are normalised; no transaction is required.
function readFunction(operation) {
    requireFunction(operation, 'readFunction');
    const read = (...args) => {
        try {
            return operation(...args);
        } catch (error) {
            throw normaliseError(error);
        }
    };
    return Object.defineProperty(read, KIND, { value:'read' });
}

// A write function: TypeError unless db.inTransaction (the guard error is not normalised), then the operation runs in a
// savepoint of the caller's transaction and its errors are normalised.
function writeFunction(db, name, operation, transactionGuard) {
    if (typeof name !== 'string' || !name.length) throw new TypeError('writeFunction needs a function name');
    requireFunction(operation, 'writeFunction');
    const inSavepoint = db.transaction(operation);
    const write = (...args) => {
        if (!db.inTransaction) throw new TypeError(`Group_Repository.${name} needs an open write transaction`);
        if (transactionGuard) transactionGuard();
        try {
            return inSavepoint(...args);
        } catch (error) {
            throw normaliseError(error);
        }
    };
    return Object.defineProperty(write, KIND, { value:'write' });
}

// T-5B-25 paired-operation boundary. Own the outer immediate transaction so a
// caller cannot catch a validation error inside an ambient transaction and
// commit partial work. All touched groups, including writes through another
// repository on this connection, are checked after synchronous work returns.
// This is an internal repository boundary, not the later authenticated groupWrite
// service: it performs no session, CSRF, revision, audit or API work.
function withMembershipTransaction(db, work) {
    if (!db || typeof db.transaction !== 'function' || typeof db.inTransaction !== 'boolean') {
        throw new TypeError('withMembershipTransaction needs an open database connection');
    }
    if (db.inTransaction || membershipTransactions.has(db)) {
        throw new TypeError('withMembershipTransaction must own the outer transaction');
    }
    if (typeof work !== 'function' || work.constructor?.name === 'AsyncFunction') throw new RepositoryError('INVALID');
    const groups = createGroupRepository(db);
    try {
        return db.transaction(() => {
            const context = { groups:new Set() };
            membershipTransactions.set(db, context);
            try {
                const result = work();
                if (result && typeof result.then === 'function') throw new RepositoryError('INVALID');
                for (const id of context.groups) {
                    const report = groups.invariantReport(id);
                    if (report.activeOwners !== 1 || report.openIntervals !== report.activeMembers || report.mismatches !== 0) {
                        throw new RepositoryError('DATABASE');
                    }
                }
                // Nothing may write between validation and the driver's COMMIT.
                return result;
            } finally {
                membershipTransactions.delete(db);
            }
        }).immediate();
    } catch (error) {
        // Preserve caller exceptions; driver diagnostics still never escape.
        throw error instanceof SqliteError ? normaliseError(error) : error;
    }
}

// Compare-and-set: runs a statement that changes rows, whose WHERE clause names the expected previous state, and throws
// CONFLICT unless exactly one row changed. The statement runs in its own savepoint, so a refused change (zero rows, or
// more than one) leaves every row as it was. A statement with RETURNING gives its one row; any other gives {changes: 1}.
function compareAndSet(statement, ...parameters) {
    if (!statement || typeof statement.run !== 'function' || !statement.database) throw new TypeError('compareAndSet needs a prepared statement');
    if (statement.readonly) throw new TypeError('compareAndSet needs a statement that changes rows');
    const db = statement.database;
    if (!db.inTransaction) throw new TypeError('compareAndSet needs an open write transaction');
    return db.transaction(() => {
        const rows = statement.reader ? statement.all(...parameters) : null;
        const changes = rows ? rows.length : statement.run(...parameters).changes;
        if (changes !== 1) throw new RepositoryError('CONFLICT');
        return rows ? rows[0] : { changes };
    })();
}

// Repository input guard: an identifier is a non-empty string (INVALID otherwise).
function identifier(value) {
    if (typeof value !== 'string' || !value.length) throw new RepositoryError('INVALID');
    return value;
}

function writeTime(value) {
    if (typeof value !== 'string' || !value.length || !Number.isFinite(Date.parse(value))) throw new RepositoryError('INVALID');
    return value;
}
function writeSequence(value, minimum) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new RepositoryError('INVALID');
    return value;
}

function writeFields(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !allowed.includes(key))) throw new RepositoryError('INVALID');
}

// Internal keyset pagination follows socialRepository: raw rows include one
// lookahead item; the service owns DTOs and cursor encoding. Accept the ordering
// tuple directly or a decoded codec payload's last tuple. All values stay bound.
function readPage(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new RepositoryError('INVALID');
    const { limit = 20, after = null } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RepositoryError('INVALID');
    const last = after === null ? [null, null] : Array.isArray(after) ? after : after.last;
    if (!Array.isArray(last) || last.length !== 2 || (after !== null && last.some(value => typeof value !== 'string' || !value.length))) {
        throw new RepositoryError('INVALID');
    }
    return { take:limit + 1, lastTime:last[0], lastId:last[1] };
}

function createGroupRepository(db) {
    if (!db || typeof db.transaction !== 'function' || typeof db.inTransaction !== 'boolean') {
        throw new TypeError('createGroupRepository needs an open database connection');
    }
    const repositories = createRepositories(db);
    const write = (name, operation) => writeFunction(db, name, operation);
    const membershipWrite = (name, operation) => writeFunction(db, name, operation, () => {
        if (!membershipTransactions.has(db)) throw new TypeError(`Group_Repository.${name} needs withMembershipTransaction`);
    });
    const getVisibleGroup = readFunction(id => {
        const conversation = repositories.conversations.get(identifier(id));
        if (!conversation || conversation.kind !== 'group' || conversation.origin !== 'authenticated') return null;
        const extension = db.prepare('SELECT description,history_policy,membership_revision FROM GroupExtensions WHERE conversation_id=?').get(id);
        return extension ? { ...conversation, ...extension } : null;
    });
    const requireGroup = id => {
        if (!getVisibleGroup(id)) throw new RepositoryError('CONFLICT');
        membershipTransactions.get(db).groups.add(id);
        return id;
    };
    const expectedBoundary = (id, value, joining) => {
        if (value !== undefined) writeSequence(value, joining ? 1 : 0);
        const actual = repositories.messages.highWater(id) + (joining ? 1 : 0);
        if (!Number.isSafeInteger(actual) || (value !== undefined && value !== actual)) throw new RepositoryError('CONFLICT');
        return actual;
    };
    const getInvitation = readFunction(invitationId => db.prepare(`
        SELECT invitation.* FROM ConversationInvitations invitation
            JOIN Conversations c ON c.conversation_id=invitation.conversation_id
            JOIN GroupExtensions g ON g.conversation_id=c.conversation_id
        WHERE invitation.invitation_id=? AND c.kind='group' AND c.origin='authenticated'
    `).get(identifier(invitationId)) ?? null);
    const getPermittedMessage = readFunction((id, user, policy, messageId) => {
        identifier(id); identifier(user); identifier(messageId);
        if (!HISTORY_POLICIES.includes(policy)) throw new RepositoryError('INVALID');
        return db.prepare(`
            SELECT msg.* FROM Messages msg JOIN Conversations c ON c.conversation_id=msg.conversation_id
                JOIN GroupExtensions g ON g.conversation_id=c.conversation_id
                JOIN ConversationMembers mine ON mine.conversation_id=c.conversation_id AND mine.user_id=@user AND mine.left_at IS NULL
            WHERE msg.conversation_id=@id AND msg.message_id=@messageId AND msg.origin='authenticated'
                AND c.kind='group' AND c.origin='authenticated' AND g.history_policy=@policy
                AND (EXISTS(SELECT 1 FROM GroupMembershipIntervals period WHERE period.conversation_id=@id AND period.user_id=@user
                        AND msg.message_seq>=period.first_seq AND (period.last_seq IS NULL OR msg.message_seq<=period.last_seq))
                    OR (@policy='all' AND msg.message_seq<(SELECT min(first_seq) FROM GroupMembershipIntervals earliest
                        WHERE earliest.conversation_id=@id AND earliest.user_id=@user)))
        `).get({ id, user, policy, messageId }) ?? null;
    });
    return Object.freeze({
        repositories,
        getVisibleGroup,
        getMember:readFunction((id, user) => {
            identifier(user);
            return getVisibleGroup(id) ? repositories.members.get(id, user) ?? null : null;
        }),
        countActiveMembers:readFunction(id => getVisibleGroup(id) ? db.prepare(
            'SELECT count(*) AS n FROM ConversationMembers WHERE conversation_id=? AND left_at IS NULL').get(id).n : 0),
        listGroupsForUser:readFunction((actor, options) => db.prepare(`
            SELECT c.*,g.description,g.history_policy,g.membership_revision,mine.role,
                (SELECT count(*) FROM ConversationMembers counted
                    WHERE counted.conversation_id=c.conversation_id AND counted.left_at IS NULL) AS member_count,
                (SELECT count(*) FROM Messages msg
                    WHERE msg.conversation_id=c.conversation_id AND msg.origin='authenticated'
                    AND msg.deleted_at IS NULL AND msg.sender_id<>@actor
                    AND msg.message_seq>coalesce((SELECT position FROM GroupReadPositions rp
                        WHERE rp.conversation_id=c.conversation_id AND rp.user_id=@actor),0)
                    AND (EXISTS(SELECT 1 FROM GroupMembershipIntervals period
                            WHERE period.conversation_id=c.conversation_id AND period.user_id=@actor
                            AND msg.message_seq>=period.first_seq AND (period.last_seq IS NULL OR msg.message_seq<=period.last_seq))
                        OR (g.history_policy='all' AND msg.message_seq<(SELECT min(first_seq) FROM GroupMembershipIntervals earliest
                            WHERE earliest.conversation_id=c.conversation_id AND earliest.user_id=@actor)))) AS unread_count
            FROM ConversationMembers mine JOIN Conversations c ON c.conversation_id=mine.conversation_id
                JOIN GroupExtensions g ON g.conversation_id=c.conversation_id
            WHERE mine.user_id=@actor AND mine.left_at IS NULL AND c.kind='group' AND c.origin='authenticated'
                AND (@lastTime IS NULL OR (c.updated_at,c.conversation_id)<(@lastTime,@lastId))
            ORDER BY c.updated_at DESC,c.conversation_id DESC LIMIT @take
        `).all({ actor:identifier(actor), ...readPage(options) })),
        listMembers:readFunction((id, options = {}) => {
            const page = readPage(options);
            const { former = false } = options;
            if (typeof former !== 'boolean') throw new RepositoryError('INVALID');
            if (!getVisibleGroup(id)) return [];
            const parameters = { id, ...page };
            return former ? db.prepare(`
                SELECT member.user_id,u.username,coalesce(p.display_name,u.display_name) AS display_name,p.avatar,
                    member.role,period.joined_at,member.left_at
                FROM ConversationMembers member
                    JOIN GroupMembershipIntervals period ON period.conversation_id=member.conversation_id AND period.user_id=member.user_id
                        AND period.interval_no=(SELECT max(interval_no) FROM GroupMembershipIntervals latest
                            WHERE latest.conversation_id=member.conversation_id AND latest.user_id=member.user_id AND latest.left_at IS NOT NULL)
                    JOIN Users u ON u.user_id=member.user_id LEFT JOIN UserProfiles p ON p.user_id=member.user_id
                WHERE member.conversation_id=@id AND member.left_at IS NOT NULL AND period.left_at IS NOT NULL
                    AND (@lastTime IS NULL OR (member.left_at,member.user_id)>(@lastTime,@lastId))
                ORDER BY member.left_at,member.user_id LIMIT @take
            `).all(parameters) : db.prepare(`
                SELECT member.user_id,u.username,coalesce(p.display_name,u.display_name) AS display_name,p.avatar,
                    member.role,period.joined_at,member.left_at
                FROM GroupMembershipIntervals period
                    JOIN ConversationMembers member ON member.conversation_id=period.conversation_id AND member.user_id=period.user_id
                    JOIN Users u ON u.user_id=member.user_id LEFT JOIN UserProfiles p ON p.user_id=member.user_id
                WHERE period.conversation_id=@id AND period.left_at IS NULL AND member.left_at IS NULL
                    AND (@lastTime IS NULL OR (period.joined_at,member.user_id)>(@lastTime,@lastId))
                ORDER BY period.joined_at,member.user_id LIMIT @take
            `).all(parameters);
        }),
        getCreationKey:readFunction((user, key) => db.prepare(`
            SELECT creation.* FROM GroupCreationKeys creation JOIN Conversations c ON c.conversation_id=creation.conversation_id
                JOIN GroupExtensions g ON g.conversation_id=c.conversation_id
            WHERE creation.user_id=? AND creation.idempotency_key=? AND c.kind='group' AND c.origin='authenticated'
        `).get(identifier(user), identifier(key)) ?? null),
        invariantReport:readFunction(id => {
            if (!getVisibleGroup(id)) return { activeOwners:0, activeMembers:0, openIntervals:0, mismatches:0 };
            return db.prepare(`
                SELECT (SELECT count(*) FROM ConversationMembers owner WHERE owner.conversation_id=@id AND owner.left_at IS NULL AND owner.role='owner') AS activeOwners,
                    (SELECT count(*) FROM ConversationMembers active WHERE active.conversation_id=@id AND active.left_at IS NULL) AS activeMembers,
                    (SELECT count(*) FROM GroupMembershipIntervals opened WHERE opened.conversation_id=@id AND opened.left_at IS NULL) AS openIntervals,
                    (SELECT count(*) FROM ConversationMembers member WHERE member.conversation_id=@id
                        AND (CASE WHEN member.left_at IS NULL THEN 1 ELSE 0 END)<>
                            (SELECT count(*) FROM GroupMembershipIntervals opened WHERE opened.conversation_id=member.conversation_id
                                AND opened.user_id=member.user_id AND opened.left_at IS NULL)) AS mismatches
            `).get({ id });
        }),
        // T-5B-26. Creation participates in the approved membership boundary;
        // the other writes preserve membership and can share that transaction.
        insertGroup:membershipWrite('insertGroup', input => {
            writeFields(input, ['conversation_id','created_by','title','description','historyPolicy','at']);
            const { conversation_id, created_by, title, description = null, historyPolicy = 'from_joined' } = input;
            const at = input.at === undefined ? undefined : writeTime(input.at);
            identifier(created_by); identifier(title);
            if (conversation_id !== undefined) identifier(conversation_id);
            if ((description !== null && typeof description !== 'string') || !HISTORY_POLICIES.includes(historyPolicy)) {
                throw new RepositoryError('INVALID');
            }
            const conversation = repositories.conversations.create({ conversation_id, kind:'group', origin:'authenticated', created_by, title,
                ...(at === undefined ? {} : {created_at:at,updated_at:at,member_joined_at:at}) });
            const id = conversation.conversation_id;
            compareAndSet(db.prepare(`
                INSERT INTO GroupExtensions(conversation_id,description,history_policy,membership_revision,created_at)
                VALUES(?,?,?,1,?) RETURNING *
            `), id, description, historyPolicy, conversation.created_at);
            const owner = repositories.members.get(id, created_by);
            compareAndSet(db.prepare(`
                INSERT INTO GroupMembershipIntervals(conversation_id,user_id,interval_no,first_seq,joined_at)
                VALUES(?,?,1,?,?) RETURNING *
            `), id, created_by, expectedBoundary(id, undefined, true), owner.joined_at);
            const group = getVisibleGroup(id);
            // Register only after the complete savepoint succeeds: a refused
            // creation must not leave a phantom validation target if caught.
            membershipTransactions.get(db).groups.add(id);
            return group;
        }),
        updateSettings:write('updateSettings', (id, patch, at) => {
            writeFields(patch, ['title','description']);
            if (!Object.keys(patch).length) throw new RepositoryError('INVALID');
            if (Object.hasOwn(patch, 'title')) identifier(patch.title);
            if (Object.hasOwn(patch, 'description') && patch.description !== null && typeof patch.description !== 'string') {
                throw new RepositoryError('INVALID');
            }
            writeTime(at);
            const group = getVisibleGroup(id);
            if (!group) throw new RepositoryError('CONFLICT');
            // The composed repository has no settings/touch operation; archive
            // is unconditional and uses its own clock. These extensions bind
            // the operation time and compare the expected previous state.
            compareAndSet(db.prepare(`
                UPDATE Conversations SET title=@title,updated_at=@at
                WHERE conversation_id=@id AND title IS @previous AND archived_at IS NULL RETURNING *
            `), { id, title:Object.hasOwn(patch, 'title') ? patch.title : group.title, at, previous:group.title });
            if (Object.hasOwn(patch, 'description')) compareAndSet(db.prepare(`
                UPDATE GroupExtensions SET description=@description
                WHERE conversation_id=@id AND description IS @previous RETURNING *
            `), { id, description:patch.description, previous:group.description });
            return getVisibleGroup(id);
        }),
        archiveGroup:write('archiveGroup', (id, at) => {
            if (!getVisibleGroup(id)) throw new RepositoryError('CONFLICT');
            writeTime(at);
            compareAndSet(db.prepare(`
                UPDATE Conversations SET archived_at=@at,updated_at=@at
                WHERE conversation_id=@id AND archived_at IS NULL RETURNING *
            `), { id, at });
            return getVisibleGroup(id);
        }),
        touchConversation:write('touchConversation', (id, at) => {
            const group = getVisibleGroup(id);
            if (!group) throw new RepositoryError('CONFLICT');
            writeTime(at);
            return compareAndSet(db.prepare(`
                UPDATE Conversations SET updated_at=@at
                WHERE conversation_id=@id AND updated_at IS @previous AND archived_at IS NULL RETURNING *
            `), { id, at, previous:group.updated_at });
        }),
        claimCreationKey:write('claimCreationKey', (user, key, fingerprint, id, at) => {
            identifier(user); identifier(key); writeTime(at);
            if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new RepositoryError('INVALID');
            if (!getVisibleGroup(id)) throw new RepositoryError('CONFLICT');
            const expired = db.prepare(`
                SELECT created_at FROM GroupCreationKeys WHERE user_id=@user AND idempotency_key=@key
                    AND julianday(created_at)<julianday(@at,'-24 hours')
            `).get({ user, key, at });
            if (expired) compareAndSet(db.prepare(`
                DELETE FROM GroupCreationKeys WHERE user_id=@user AND idempotency_key=@key AND created_at=@previous
                    AND julianday(created_at)<julianday(@at,'-24 hours') RETURNING *
            `), { user, key, previous:expired.created_at, at });
            // Migration 0008 makes key rows immutable. Explicitly
            // delete an expired row, then insert within this write's savepoint;
            // no implicit replacement or UPDATE bypass is used. Live key
            // collisions keep the existing primary-key DUPLICATE class.
            return compareAndSet(db.prepare(`
                INSERT INTO GroupCreationKeys(user_id,idempotency_key,fingerprint,conversation_id,created_at)
                VALUES(?,?,?,?,?) RETURNING *
            `), user, key, fingerprint, id, at);
        }),
        // T-5B-27. Trusted invitation persistence primitives. Authorization,
        // limits, revalidation and API outcomes remain service responsibilities.
        getInvitation,
        findPending:readFunction((id, invitee) => {
            identifier(invitee);
            if (!getVisibleGroup(id)) return null;
            // Include past-expiry pending rows so the caller can expire them
            // before inserting a replacement under the unique pending index.
            return db.prepare(`
                SELECT * FROM ConversationInvitations WHERE conversation_id=? AND invitee_id=? AND state='pending'
            `).get(id, invitee) ?? null;
        }),
        countPendingForGroup:readFunction((id, nowIso) => {
            writeTime(nowIso);
            return getVisibleGroup(id) ? db.prepare(`
                SELECT count(*) AS n FROM ConversationInvitations WHERE conversation_id=? AND state='pending'
                    AND julianday(expires_at)>julianday(?)
            `).get(id, nowIso).n : 0;
        }),
        countPendingForInvitee:readFunction((user, nowIso) => {
            identifier(user); writeTime(nowIso);
            return db.prepare(`
                SELECT count(*) AS n FROM ConversationInvitations invitation
                    JOIN Conversations c ON c.conversation_id=invitation.conversation_id
                    JOIN GroupExtensions g ON g.conversation_id=c.conversation_id
                WHERE invitation.invitee_id=? AND invitation.state='pending' AND julianday(invitation.expires_at)>julianday(?)
                    AND c.kind='group' AND c.origin='authenticated'
            `).get(user, nowIso).n;
        }),
        listPendingForInvitee:readFunction((user, nowIso, options) => {
            identifier(user); writeTime(nowIso);
            return db.prepare(`
                SELECT invitation.*,c.title AS group_name,coalesce(p.display_name,u.display_name) AS inviter_display_name
                FROM ConversationInvitations invitation JOIN Conversations c ON c.conversation_id=invitation.conversation_id
                    JOIN GroupExtensions g ON g.conversation_id=c.conversation_id
                    JOIN Users u ON u.user_id=invitation.inviter_id LEFT JOIN UserProfiles p ON p.user_id=u.user_id
                WHERE invitation.invitee_id=@user AND invitation.state='pending' AND julianday(invitation.expires_at)>julianday(@nowIso)
                    AND c.kind='group' AND c.origin='authenticated'
                    AND (@lastTime IS NULL OR (invitation.created_at,invitation.invitation_id)<(@lastTime,@lastId))
                ORDER BY invitation.created_at DESC,invitation.invitation_id DESC LIMIT @take
            `).all({ user, nowIso, ...readPage(options) });
        }),
        listPendingForGroup:readFunction((id, nowIso, options) => {
            writeTime(nowIso);
            const page = readPage(options);
            if (!getVisibleGroup(id)) return [];
            return db.prepare(`
                SELECT * FROM ConversationInvitations WHERE conversation_id=@id AND state='pending'
                    AND julianday(expires_at)>julianday(@nowIso)
                    AND (@lastTime IS NULL OR (created_at,invitation_id)<(@lastTime,@lastId))
                ORDER BY created_at DESC,invitation_id DESC LIMIT @take
            `).all({ id, nowIso, ...page });
        }),
        closedIntervalSince:readFunction((id, user, sinceIso) => {
            identifier(user); writeTime(sinceIso);
            return getVisibleGroup(id) ? Boolean(db.prepare(`
                SELECT 1 FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=?
                    AND left_at IS NOT NULL AND julianday(left_at)>=julianday(?) LIMIT 1
            `).get(id, user, sinceIso)) : false;
        }),
        insertInvitation:write('insertInvitation', input => {
            writeFields(input, ['invitation_id','conversation_id','invitee_id','inviter_id','created_at','expires_at']);
            const { invitation_id, conversation_id, invitee_id, inviter_id, created_at } = input;
            identifier(invitation_id); identifier(invitee_id); identifier(inviter_id); writeTime(created_at);
            const expiry = new Date(Date.parse(created_at) + INVITATION_EXPIRY_SECONDS * 1000);
            if (!Number.isFinite(expiry.getTime())) throw new RepositoryError('INVALID');
            const expires_at = input.expires_at === undefined ? expiry.toISOString() : writeTime(input.expires_at);
            if (Date.parse(expires_at) !== expiry.getTime()) throw new RepositoryError('INVALID');
            if (!getVisibleGroup(conversation_id)) throw new RepositoryError('CONFLICT');
            return compareAndSet(db.prepare(`
                INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at)
                VALUES(?,?,?,?,'pending',?,?,NULL) RETURNING *
            `), invitation_id, conversation_id, invitee_id, inviter_id, created_at, expires_at);
        }),
        resolveInvitation:write('resolveInvitation', (id, to, at) => {
            if (!['accepted','declined','cancelled','expired'].includes(to)) throw new RepositoryError('INVALID');
            writeTime(at);
            if (!getInvitation(id)) throw new RepositoryError('CONFLICT');
            return compareAndSet(db.prepare(`
                UPDATE ConversationInvitations SET state=?,resolved_at=? WHERE invitation_id=? AND state='pending' RETURNING *
            `), to, at, id);
        }),
        cancelPendingFor:write('cancelPendingFor', (id, user, at) => {
            identifier(user); writeTime(at);
            if (!getVisibleGroup(id)) throw new RepositoryError('CONFLICT');
            const pending = db.prepare(`
                SELECT invitation_id FROM ConversationInvitations WHERE conversation_id=? AND state='pending'
                    AND (invitee_id=? OR inviter_id=?) ORDER BY invitation_id
            `).all(id, user, user);
            const cancel = db.prepare(`
                UPDATE ConversationInvitations SET state='cancelled',resolved_at=@at
                WHERE invitation_id=@invitation AND conversation_id=@id AND state='pending'
                    AND (invitee_id=@user OR inviter_id=@user) RETURNING *
            `);
            for (const row of pending) compareAndSet(cancel, { invitation:row.invitation_id, id, user, at });
            return pending.length;
        }),
        expirePast:write('expirePast', (id, invitee, nowIso) => {
            identifier(invitee); writeTime(nowIso);
            if (!getVisibleGroup(id)) throw new RepositoryError('CONFLICT');
            const expired = db.prepare(`
                SELECT invitation_id FROM ConversationInvitations WHERE conversation_id=? AND invitee_id=? AND state='pending'
                    AND julianday(expires_at)<=julianday(?)
            `).get(id, invitee, nowIso);
            if (!expired) return 0;
            compareAndSet(db.prepare(`
                UPDATE ConversationInvitations SET state='expired',resolved_at=@nowIso
                WHERE invitation_id=@invitation AND conversation_id=@id AND invitee_id=@invitee AND state='pending'
                    AND julianday(expires_at)<=julianday(@nowIso) RETURNING *
            `), { invitation:expired.invitation_id, id, invitee, nowIso });
            return 1;
        }),
        // T-5B-28. Range predicates run before LIMIT in the same SQL query.
        // Raw rows include one lookahead item; the service owns projection and
        // cursors, including the first page's fixed high-water mark. The policy
        // argument must match stored policy, so it cannot widen visibility.
        intervalsFor:readFunction((id, user) => {
            identifier(user);
            return getVisibleGroup(id) ? db.prepare(`
                SELECT * FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=? ORDER BY interval_no
            `).all(id, user) : [];
        }),
        openInterval:readFunction((id, user) => {
            identifier(user);
            return getVisibleGroup(id) ? db.prepare(`
                SELECT * FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=? AND left_at IS NULL
            `).get(id, user) ?? null : null;
        }),
        activeMemberIds:readFunction(id => {
            identifier(id);
            return getVisibleGroup(id) ? db.prepare(`
                SELECT user_id FROM ConversationMembers WHERE conversation_id=? AND left_at IS NULL ORDER BY user_id
            `).all(id).map(row => row.user_id) : [];
        }),
        historyPage:readFunction((id, user, options = {}) => {
            identifier(id); identifier(user);
            writeFields(options, ['policy','limit','highWater','before']);
            const { policy, limit = 20, highWater, before = null } = options;
            if (!HISTORY_POLICIES.includes(policy) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new RepositoryError('INVALID');
            writeSequence(highWater, 0);
            if (before !== null) writeSequence(before, 1);
            return db.prepare(`
                SELECT msg.* FROM Messages msg JOIN Conversations c ON c.conversation_id=msg.conversation_id
                    JOIN GroupExtensions g ON g.conversation_id=c.conversation_id
                    JOIN ConversationMembers mine ON mine.conversation_id=c.conversation_id AND mine.user_id=@user AND mine.left_at IS NULL
                WHERE msg.conversation_id=@id AND msg.origin='authenticated' AND msg.message_seq<=@highWater
                    AND (@before IS NULL OR msg.message_seq<@before)
                    AND c.kind='group' AND c.origin='authenticated' AND g.history_policy=@policy
                    AND (EXISTS(SELECT 1 FROM GroupMembershipIntervals period WHERE period.conversation_id=@id AND period.user_id=@user
                            AND msg.message_seq>=period.first_seq AND (period.last_seq IS NULL OR msg.message_seq<=period.last_seq))
                        OR (@policy='all' AND msg.message_seq<(SELECT min(first_seq) FROM GroupMembershipIntervals earliest
                            WHERE earliest.conversation_id=@id AND earliest.user_id=@user)))
                ORDER BY msg.message_seq DESC LIMIT @take
            `).all({ id, user, policy, highWater, before, take:limit + 1 });
        }),
        getPermittedMessage,
        unreadCount:readFunction((id, user, policy) => {
            identifier(id); identifier(user);
            if (!HISTORY_POLICIES.includes(policy)) throw new RepositoryError('INVALID');
            return db.prepare(`
                SELECT count(*) AS n FROM Messages msg JOIN Conversations c ON c.conversation_id=msg.conversation_id
                    JOIN GroupExtensions g ON g.conversation_id=c.conversation_id
                    JOIN ConversationMembers mine ON mine.conversation_id=c.conversation_id AND mine.user_id=@user AND mine.left_at IS NULL
                WHERE msg.conversation_id=@id AND msg.origin='authenticated' AND msg.deleted_at IS NULL AND msg.sender_id<>@user
                    AND msg.message_seq>coalesce((SELECT position FROM GroupReadPositions rp WHERE rp.conversation_id=@id AND rp.user_id=@user),0)
                    AND c.kind='group' AND c.origin='authenticated' AND g.history_policy=@policy
                    AND (EXISTS(SELECT 1 FROM GroupMembershipIntervals period WHERE period.conversation_id=@id AND period.user_id=@user
                            AND msg.message_seq>=period.first_seq AND (period.last_seq IS NULL OR msg.message_seq<=period.last_seq))
                        OR (@policy='all' AND msg.message_seq<(SELECT min(first_seq) FROM GroupMembershipIntervals earliest
                            WHERE earliest.conversation_id=@id AND earliest.user_id=@user)))
            `).get({ id, user, policy }).n;
        }),
        getReadPosition:readFunction((id, user) => {
            identifier(user);
            if (!getVisibleGroup(id)) return 0;
            return db.prepare(`
                SELECT rp.position FROM GroupReadPositions rp JOIN ConversationMembers mine
                    ON mine.conversation_id=rp.conversation_id AND mine.user_id=rp.user_id AND mine.left_at IS NULL
                WHERE rp.conversation_id=? AND rp.user_id=?
            `).get(id, user)?.position ?? 0;
        }),
        upsertReadPosition:write('upsertReadPosition', (id, user, n, at) => {
            identifier(user); writeSequence(n, 0); writeTime(at);
            const group = getVisibleGroup(id), member = group ? repositories.members.get(id, user) : null;
            if (!member || member.left_at !== null) throw new RepositoryError('CONFLICT');
            if (n > repositories.messages.highWater(id)) throw new RepositoryError('INVALID');
            if (n > 0 && !db.prepare(`
                SELECT 1 FROM GroupMembershipIntervals period WHERE period.conversation_id=@id AND period.user_id=@user
                    AND ((@n>=period.first_seq AND (period.last_seq IS NULL OR @n<=period.last_seq))
                        OR (@policy='all' AND @n<(SELECT min(first_seq) FROM GroupMembershipIntervals earliest
                            WHERE earliest.conversation_id=@id AND earliest.user_id=@user))) LIMIT 1
            `).get({ id, user, n, policy:group.history_policy })) throw new RepositoryError('INVALID');
            return compareAndSet(db.prepare(`
                INSERT INTO GroupReadPositions(conversation_id,user_id,position,updated_at) VALUES(@id,@user,@n,@at)
                ON CONFLICT(conversation_id,user_id) DO UPDATE SET position=max(GroupReadPositions.position,excluded.position),
                    updated_at=CASE WHEN excluded.position>GroupReadPositions.position THEN excluded.updated_at ELSE GroupReadPositions.updated_at END
                RETURNING position
            `), { id, user, n, at }).position;
        }),
        // T-5B-25 transaction primitives. Pair membership and interval writes in
        // withMembershipTransaction; its mandatory checks run before commit
        // (design: groupWrite / Concurrency). Revision and audit remain service work.
        addMember:membershipWrite('addMember', (id, user, at) => {
            requireGroup(id); identifier(user); writeTime(at);
            // Persist the transaction clock as the member's first-join instant.
            return compareAndSet(db.prepare(`
                INSERT INTO ConversationMembers(conversation_id,user_id,role,joined_at)
                SELECT @id,@user,'member',@at WHERE NOT EXISTS(
                    SELECT 1 FROM ConversationMembers WHERE conversation_id=@id AND user_id=@user)
                RETURNING *
            `), { id, user, at });
        }),
        reactivateMember:membershipWrite('reactivateMember', (id, user, at) => {
            requireGroup(id); identifier(user); writeTime(at);
            // at is used by the following openIntervalAt; the retained first
            // joined_at is deliberately not assigned during a rejoin.
            return compareAndSet(db.prepare(`
                UPDATE ConversationMembers SET left_at=NULL,role='member'
                WHERE conversation_id=? AND user_id=? AND left_at IS NOT NULL RETURNING *
            `), id, user);
        }),
        endMembership:membershipWrite('endMembership', (id, user, at) => {
            requireGroup(id); identifier(user); writeTime(at);
            return compareAndSet(db.prepare(`
                UPDATE ConversationMembers SET left_at=?
                WHERE conversation_id=? AND user_id=? AND left_at IS NULL AND role<>'owner' RETURNING *
            `), at, id, user);
        }),
        changeRole:membershipWrite('changeRole', (id, user, from, to) => {
            requireGroup(id); identifier(user);
            if (!['owner','admin','member'].includes(from) || !['admin','member'].includes(to)) throw new RepositoryError('INVALID');
            if (from === to) throw new RepositoryError('CONFLICT');
            return compareAndSet(db.prepare(`
                UPDATE ConversationMembers SET role=@to WHERE conversation_id=@id AND user_id=@user
                    AND left_at IS NULL AND role=@from AND role<>'owner' RETURNING *
            `), { id, user, from, to });
        }),
        transferOwnership:membershipWrite('transferOwnership', (id, from, to) => {
            requireGroup(id); identifier(from); identifier(to);
            if (from === to) throw new RepositoryError('CONFLICT');
            // The outer write savepoint restores this demotion if promotion fails,
            // including when the caller catches the error and commits other work.
            const formerOwner = compareAndSet(db.prepare(`
                UPDATE ConversationMembers SET role=@demotedRole
                WHERE conversation_id=@id AND user_id=@from AND role='owner' AND left_at IS NULL RETURNING *
            `), { id, from, demotedRole:FORMER_OWNER_ROLE });
            const owner = compareAndSet(db.prepare(`
                UPDATE ConversationMembers SET role='owner'
                WHERE conversation_id=? AND user_id=? AND left_at IS NULL AND role IN ('admin','member') RETURNING *
            `), id, to);
            return { formerOwner, owner };
        }),
        openIntervalAt:membershipWrite('openIntervalAt', (id, user, at, firstSeq) => {
            requireGroup(id); identifier(user); writeTime(at);
            const first = expectedBoundary(id, firstSeq, true);
            const member = repositories.members.get(id, user);
            if (!member || member.left_at !== null) throw new RepositoryError('CONFLICT');
            return compareAndSet(db.prepare(`
                INSERT INTO GroupMembershipIntervals(conversation_id,user_id,interval_no,first_seq,last_seq,joined_at,left_at)
                SELECT @id,@user,coalesce(max(interval_no),0)+1,@first,NULL,@at,NULL
                FROM GroupMembershipIntervals WHERE conversation_id=@id AND user_id=@user RETURNING *
            `), { id, user, first, at });
        }),
        closeInterval:membershipWrite('closeInterval', (id, user, at, lastSeq) => {
            requireGroup(id); identifier(user); writeTime(at);
            const last = expectedBoundary(id, lastSeq, false);
            // End membership first. The same operation timestamp ties the closed
            // interval to that leave/removal and prevents closing an active owner.
            return compareAndSet(db.prepare(`
                UPDATE GroupMembershipIntervals SET last_seq=@last,left_at=@at
                WHERE conversation_id=@id AND user_id=@user AND left_at IS NULL AND last_seq IS NULL
                    AND EXISTS(SELECT 1 FROM ConversationMembers member WHERE member.conversation_id=@id
                        AND member.user_id=@user AND member.left_at=@at) RETURNING *
            `), { id, user, last, at });
        }),
        // Membership_Revision plus exactly 1 (DB5-R03.14, R05.10, R06.3); returns the new value. The expected previous
        // state is that the group has its extension record: an unknown id or a direct conversation gives CONFLICT.
        bumpRevision:write('bumpRevision', id => compareAndSet(
            db.prepare('UPDATE GroupExtensions SET membership_revision = membership_revision + 1 WHERE conversation_id = ? RETURNING membership_revision'),
            identifier(id)).membership_revision),
    });
}

module.exports = {
    createGroupRepository, withMembershipTransaction, readFunction, writeFunction, compareAndSet, normaliseError,
    ERROR_CLASSES, ERROR_CLASS_BY_CODE, RepositoryError,
};
