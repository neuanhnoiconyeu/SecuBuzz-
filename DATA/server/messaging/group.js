'use strict';

const { randomUUID } = require('node:crypto');
const { createSqliteRateLimiter } = require('../auth/rateLimiter');
const { AuthError } = require('../auth/errors');
const { createRepositories } = require('../database/repositories');
const { createGroupRepository } = require('../database/groupRepository');
const { permittedRanges } = require('../groups/policy');
const groupValidation = require('../groups/validation');
const v = require('./validation');

// Group projections share the wire shape of direct messages without changing
// the direct-message service contract or its exports.
function project(row) {
    return {storageId:row.message_id,id:row.client_id,conversationId:row.conversation_id,senderId:row.sender_id,senderName:row.sender_name,
        timestamp:row.client_timestamp,type:'text',encryption:row.deleted_at===null?{version:row.envelope_version,algorithm:row.algorithm,encoding:row.encoding,
            ...(row.envelope_version===2?{keyId:row.key_id}:{}),iv:row.iv,ciphertext:row.ciphertext}:null,
        storedAt:row.created_at,updatedAt:row.updated_at,sequence:row.message_seq,revision:row.revision,state:row.deleted_at===null?'active':'deleted',deletedAt:row.deleted_at};
}

const notFound = () => { throw new AuthError('NOT_FOUND', 404); };
const forbidden = fields => { throw new AuthError('FORBIDDEN', 403, fields); };
const conflict = code => { throw new AuthError(code || 'CONFLICT', 409); };
const featureUnavailable = () => { throw new AuthError('FEATURE_UNAVAILABLE', 503); };

function createGroupMessageService({ db, auth, groups, groupRecipientKeyVerifier = null, verifierTimeoutMs = 2000,
    limiter = createSqliteRateLimiter(db) } = {}) {
    if (!db || !auth || !groups || typeof groups.groupRead !== 'function' || typeof groups.groupWrite !== 'function') {
        throw new TypeError('createGroupMessageService needs db, auth and the group service.');
    }
    if (!Number.isInteger(verifierTimeoutMs) || verifierTimeoutMs < 10 || verifierTimeoutMs > 4000) {
        throw new TypeError('Invalid verifier deadline');
    }
    if (!limiter || typeof limiter.consume !== 'function') throw new TypeError('Invalid message limiter');

    const repositories = createRepositories(db);
    const groupRepository = createGroupRepository(db);
    const messages = repositories.messages;
    let pendingVerifiers = 0;

    function assertEnabled() {
        if (groups.features.groupMessaging !== true) featureUnavailable();
    }
    function authorize(context, id, work) {
        return groups.groupRead(context, actor => {
            const visible = groups.visibleGroup(actor, id);
            return work(actor, visible);
        });
    }
    function assertVerifierAvailable() {
        if (!groupRecipientKeyVerifier || typeof groupRecipientKeyVerifier.verifyEnvelope !== 'function'
            || (auth.config.production === true && groupRecipientKeyVerifier.testOnly === true)) {
            throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE', 503);
        }
        if (pendingVerifiers >= 32) throw new AuthError('SERVICE_UNAVAILABLE', 503);
    }
    async function verify(prepared) {
        assertVerifierAvailable();
        pendingVerifiers++;
        let timer;
        let released = false;
        let callSettled = false;
        const release = () => {
            if (!released) {
                released = true;
                pendingVerifiers--;
            }
        };
        const call = Promise.resolve().then(() => groupRecipientKeyVerifier.verifyEnvelope(prepared.actor, prepared.envelope,
            Object.freeze({ conversationId: prepared.groupId, recipientIds: Object.freeze([...prepared.recipientIds]),
                membershipRevision: prepared.membershipRevision, fingerprint: prepared.fingerprint })));
        call.then(() => { callSettled = true; release(); }, () => { callSettled = true; release(); });
        try {
            const result = await Promise.race([
                call,
                new Promise((_, reject) => { timer = setTimeout(() => reject(new AuthError('RECIPIENT_KEYS_UNAVAILABLE', 503)), verifierTimeoutMs); })
            ]);
            if (!result || typeof result !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(result))
                || Reflect.ownKeys(result).length !== 1 || !Object.hasOwn(result, 'verified') || result.verified !== true) {
                throw new AuthError('RECIPIENT_KEYS_UNVERIFIED', 403);
            }
        } catch (error) {
            if (error instanceof AuthError && ['RECIPIENT_KEYS_UNAVAILABLE', 'RECIPIENT_KEYS_UNVERIFIED'].includes(error.code)) throw error;
            throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE', 503);
        } finally {
            clearTimeout(timer);
            // A timed-out verifier may continue running. Keep its slot occupied until the call itself settles.
            if (callSettled) release();
        }
    }
    function audit(actor, operation, groupId, at) {
        try {
            repositories.audit.insert({ actor_user_id: actor, event_type: `message.${operation}`, source: 'groups',
                subject_id: groupId, metadata: { operation, outcome: 'confirmed' }, created_at: at });
        } catch {
            throw new AuthError('INTERNAL_ERROR', 500);
        }
    }
    function storedAt(row) {
        return { conversationId: row.conversation_id, storageId: row.message_id, messageId: row.client_id,
            userId: row.user_id, status: row.status, observedAt: row.observed_at, recordedAt: row.recorded_at };
    }
    function messageReadPosition(context, id) {
        assertEnabled();
        return authorize(context, id, actor => groupRepository.getReadPosition(id, actor));
    }

    const service = {
        rate(operation, context, source) {
            const limits = { history: [120, false], submit: [60, true], delete: [60, true], read: [120, true] };
            const selected = limits[operation];
            if (!selected) throw new TypeError('Unknown group message rate operation.');
            const buckets = [{ key: `messages:${operation}:${context.userId}`, limit: selected[0], windowMs: 60000 }];
            if (selected[1]) buckets.push({ key: `messages:mutations-source:${source}`, limit: 240, windowMs: 60000 });
            const result = limiter.consume(buckets, auth.now());
            if (!result || typeof result !== 'object') throw new AuthError('INTERNAL_ERROR', 500);
            if (result.allowed !== true) {
                const error = new AuthError('RATE_LIMITED', 429);
                error.retryAfterSeconds = Number.isInteger(result.retryAfterSeconds) && result.retryAfterSeconds > 0 ? result.retryAfterSeconds : 1;
                throw error;
            }
        },

        async submit(context, proof, id, input) {
            assertEnabled();
            const preparation = groups.groupWrite(context, proof, (actor, at) => {
                // The session actor comes from the authenticated group boundary; validation precedes membership lookup.
                const envelope = v.envelope(input, { userId: actor }, id);
                const fingerprint = v.fingerprint(envelope);
                const visible = groups.visibleGroup(actor, id);
                if (visible.group.archived_at !== null && visible.group.archived_at !== undefined) conflict();
                const recipients = groupRepository.activeMemberIds(id).filter(userId => userId !== actor);
                return { actor: Object.freeze({ userId: actor, sessionId: context.sessionId,
                    displayName: auth.repository.byId(context.sessionId).display_name }), envelope, fingerprint,
                    groupId: id, membershipRevision: visible.group.membership_revision, recipientIds: recipients,
                    policy: visible.group.history_policy };
            });

            // Version 2 needs group key material that OD-19 has not selected. It is never passed to a default verifier.
            if (preparation.envelope.encryption.version === 2) throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE', 503);
            await verify(preparation);

            return groups.groupWrite(context, proof, (actor, at) => {
                const visible = groups.visibleGroup(actor, id);
                if (visible.group.archived_at !== null && visible.group.archived_at !== undefined) conflict();
                const existing = messages.findAuthenticatedClient(id, preparation.envelope.id);
                if (existing) {
                    if (existing.sender_id !== actor || existing.fingerprint !== preparation.fingerprint) conflict('IDEMPOTENCY_CONFLICT');
                    return { outcome: 'duplicate', message: project(existing) };
                }
                if (visible.group.membership_revision !== preparation.membershipRevision) conflict('STALE_STATE');
                if (auth.repository.byId(context.sessionId).display_name !== preparation.envelope.senderName) forbidden(['senderName']);
                const highWater = messages.highWater(id);
                if (highWater >= Number.MAX_SAFE_INTEGER) throw new AuthError('SERVICE_UNAVAILABLE', 503);
                const row = messages.insertAuthenticated({ message_id: randomUUID(), conversation_id: id, sender_id: actor,
                    receiver_id: null, ciphertext: preparation.envelope.encryption.ciphertext, iv: preparation.envelope.encryption.iv,
                    envelope_version: preparation.envelope.encryption.version, encoding: 'base64',
                    sender_name: preparation.envelope.senderName, client_timestamp: preparation.envelope.timestamp,
                    message_type: 'text', fingerprint: preparation.fingerprint, client_id: preparation.envelope.id,
                    message_seq: highWater + 1, created_at: at });
                groupRepository.touchConversation(id, at);
                audit(actor, 'stored', id, at);
                return { outcome: 'created', message: project(row) };
            });
        },

        history(context, id, query) {
            assertEnabled();
            return authorize(context, id, (actor, visible) => {
                v.conversationId(id);
                const page = v.groupPage(query, context.userId, id);
                const highWater = page.highWater ?? messages.highWater(id);
                const rows = groupRepository.historyPage(id, actor, { policy: visible.group.history_policy,
                    limit: page.limit, highWater, before: page.before });
                const items = rows.slice(0, page.limit).map(project);
                const nextCursor = rows.length > page.limit ? Buffer.from(JSON.stringify({ v: 1, context: page.context, highWater,
                    before: items.at(-1).sequence })).toString('base64url') : null;
                return { items, nextCursor };
            });
        },

        get(context, id, messageId) {
            assertEnabled();
            return authorize(context, id, (actor, visible) => {
                v.conversationId(id); v.identifier(messageId);
                const row = groupRepository.getPermittedMessage(id, actor, visible.group.history_policy, messageId);
                return row ? { message: project(row) } : notFound();
            });
        },

        remove(context, proof, id, messageId, body) {
            assertEnabled();
            return groups.groupWrite(context, proof, (actor, at) => {
                const visible = groups.visibleGroup(actor, id);
                v.conversationId(id); v.emptyBody(body); v.identifier(messageId);
                const row = groupRepository.getPermittedMessage(id, actor, visible.group.history_policy, messageId);
                if (!row) notFound();
                if (row.sender_id !== actor) forbidden();
                if (row.deleted_at === null) {
                    messages.tombstone(messageId, at);
                    audit(actor, 'deleted', id, at);
                }
                return { message: project(messages.getAuthenticated(messageId)) };
            });
        },

        readPosition: messageReadPosition,

        updateReadPosition(context, proof, id, body) {
            assertEnabled();
            return groups.groupWrite(context, proof, (actor, at) => {
                const visible = groups.visibleGroup(actor, id);
                v.conversationId(id);
                const ranges = permittedRanges(groupRepository.intervalsFor(id, actor), visible.group.history_policy);
                const highWater = messages.highWater(id);
                const input = groupValidation.readPositionBody(body, { highWater, ranges });
                return { readPosition: groupRepository.upsertReadPosition(id, actor, input.position, at) };
            });
        },

        recordReceipt(context, proof, id, messageId, body) {
            assertEnabled();
            return groups.groupWrite(context, proof, (actor, at) => {
                const visible = groups.visibleGroup(actor, id);
                v.conversationId(id); v.identifier(messageId);
                if (!body || typeof body !== 'object' || Array.isArray(body) || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
                    || Reflect.ownKeys(body).some(key => key !== 'status') || Object.keys(body).length !== 1) v.invalid();
                const status = body.status;
                if (!['delivered', 'read'].includes(status)) v.invalid('status');
                const row = groupRepository.getPermittedMessage(id, actor, visible.group.history_policy, messageId);
                if (!row || row.sender_id === actor) notFound();
                const existing = repositories.receipts.get(id, messageId, actor, status);
                if (!existing) {
                    repositories.receipts.insert({ conversation_id: id, message_id: messageId, user_id: actor, status, observed_at: at });
                    audit(actor, status, id, at);
                }
                const receipt = existing || repositories.receipts.get(id, messageId, actor, status);
                return { outcome: existing ? 'duplicate' : 'created', receipt: storedAt(receipt) };
            });
        },

        receipts(context, id, messageId, query = {}) {
            return authorize(context, id, (actor, visible) => {
                v.conversationId(id); v.identifier(messageId);
                v.query(query, []);
                assertEnabled();
                throw new AuthError('FEATURE_UNAVAILABLE', 503);
            });
        },

        unreadCount(context, id) {
            assertEnabled();
            return authorize(context, id, (actor, visible) => {
                v.conversationId(id);
                return groupRepository.unreadCount(id, actor, visible.group.history_policy);
            });
        },

        bindStore(context, proof) {
            const bound = Object.freeze({ userId: context.userId, sessionId: context.sessionId });
            const csrf = Object.freeze({ ...proof });
            return Object.freeze({
                async storeMessage(request) {
                    if (!request || Reflect.ownKeys(request).sort().join(',') !== 'envelope,fingerprint,receivedAt'
                        || !(request.receivedAt instanceof Date) || !Number.isFinite(request.receivedAt.getTime())
                        || request.fingerprint !== v.fingerprint(v.envelope(request.envelope, bound, request.envelope?.conversationId))) {
                        throw new AuthError('VALIDATION_ERROR', 400);
                    }
                    const result = await service.submit(bound, csrf, request.envelope.conversationId, request.envelope);
                    return { outcome: result.outcome, storedAt: new Date(result.message.storedAt) };
                },
                async findMessage(conversationId, messageId) {
                    return authorize(bound, conversationId, (actor, visible) => {
                        v.conversationId(conversationId); v.wireId(messageId);
                        const row = messages.findAuthenticatedClient(conversationId, messageId);
                        if (!row || row.deleted_at !== null || !groupRepository.getPermittedMessage(conversationId, actor,
                            visible.group.history_policy, row.message_id)) return null;
                        return { conversationId, messageId: row.client_id, senderId: row.sender_id };
                    });
                },
                async recordReceipt(receipt) {
                    if (!receipt || receipt.userId !== bound.userId || !['read', 'delivered'].includes(receipt.status)) forbidden();
                    const row = authorize(bound, receipt.conversationId, () => messages.findAuthenticatedClient(receipt.conversationId, receipt.messageId));
                    if (!row) notFound();
                    const result = service.recordReceipt(bound, csrf, receipt.conversationId, row.message_id, receipt.status);
                    return { outcome: result.outcome, recordedAt: new Date(result.receipt.recordedAt) };
                }
            });
        }
    };
    return Object.freeze(service);
}

module.exports = { createGroupMessageService };
