'use strict';

        // T-6B-18/19/29/31: attachment persistence facade. SQL belongs in this module and the
// composed repositories.js only; callers own the surrounding immediate transaction.
const { createRepositories, RepositoryError } = require('./repositories');
const { readFunction, writeFunction, compareAndSet } = require('./groupRepository');

function database(db) {
    if (!db || typeof db.transaction !== 'function' || typeof db.inTransaction !== 'boolean') {
        throw new TypeError('createAttachmentRepository needs an open database connection');
    }
}
function identifier(value) {
    if (typeof value !== 'string' || value.length === 0) throw new RepositoryError('INVALID');
    return value;
}
function isoTime(value) {
    if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) throw new RepositoryError('INVALID');
    return value;
}
function positiveInteger(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RepositoryError('INVALID');
    return value;
}
function inputFields(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(name => !allowed.includes(name))) throw new RepositoryError('INVALID');
}
function digest(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new RepositoryError('INVALID');
    return value;
}
function boundedLimit(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RepositoryError('INVALID');
    return value;
}

function createAttachmentRepository(db) {
    database(db);
    const repositories = createRepositories(db);
    const read = operation => readFunction(operation);
    const write = name => operation => writeFunction(db, name, operation);
    const expiredPending = db.prepare(`SELECT * FROM Attachments
        WHERE status='pending' AND expires_at<=? ORDER BY expires_at,attachment_id LIMIT ?`);
    const purgeCandidates = db.prepare(`SELECT * FROM Attachments
        WHERE status='deleted' AND purge_state='not_purged' AND deleted_at<=?
        ORDER BY deleted_at,attachment_id LIMIT ?`);
    const expiredReservations = db.prepare(`SELECT * FROM AttachmentReservations
        WHERE expires_at<=? ORDER BY expires_at,reservation_id LIMIT ?`);
    const deleteExpiredReservation = db.prepare(`DELETE FROM AttachmentReservations
        WHERE reservation_id=? AND expires_at<=? RETURNING reservation_id`);
    const reconciliationRows = db.prepare(`SELECT attachment_id,storage_key,status FROM Attachments
        WHERE (? IS NULL OR attachment_id>?) ORDER BY attachment_id LIMIT ?`);
    const storageKeyExists = db.prepare('SELECT 1 AS present FROM Attachments WHERE storage_key=? LIMIT 1');

    return Object.freeze({
        getById: read(id => repositories.attachments.get(identifier(id))),
        messageUsage: read(messageId => {
            identifier(messageId);
            return db.prepare(`SELECT count(*) AS count,coalesce(sum(byte_size),0) AS bytes FROM Attachments
                WHERE message_id=?`).get(messageId);
        }),
        searchHighWater: read(() => db.prepare("SELECT coalesce(max(rowid),0) AS value FROM Attachments WHERE status='ready'").get().value),
        searchPage: read((filters, options) => {
            inputFields(filters, ['conversationId','uploadedBy','minBytes','maxBytes','createdAfter','createdBefore']);
            inputFields(options, ['after','highWater','limit']);
            const parameters={highWater:options.highWater,take:boundedLimit(options.limit),
                conversationId:null,uploadedBy:null,minBytes:null,maxBytes:null,createdAfter:null,createdBefore:null,
                afterTime:null,afterId:null};
            if(!Number.isSafeInteger(parameters.highWater)||parameters.highWater<0||parameters.take>100)throw new RepositoryError('INVALID');
            if(options.after!==null){
                if(!Array.isArray(options.after)||options.after.length!==2)throw new RepositoryError('INVALID');
                parameters.afterTime=isoTime(options.after[0]);parameters.afterId=identifier(options.after[1]);
            }
            if(filters.conversationId!==undefined)parameters.conversationId=identifier(filters.conversationId);
            if(filters.uploadedBy!==undefined)parameters.uploadedBy=identifier(filters.uploadedBy);
            if(filters.minBytes!==undefined){if(!Number.isSafeInteger(filters.minBytes)||filters.minBytes<0)throw new RepositoryError('INVALID');parameters.minBytes=filters.minBytes;}
            if(filters.maxBytes!==undefined){if(!Number.isSafeInteger(filters.maxBytes)||filters.maxBytes<0)throw new RepositoryError('INVALID');parameters.maxBytes=filters.maxBytes;}
            if(filters.createdAfter!==undefined)parameters.createdAfter=isoTime(filters.createdAfter);
            if(filters.createdBefore!==undefined)parameters.createdBefore=isoTime(filters.createdBefore);
            return db.prepare(`SELECT a.*
                FROM Attachments AS a INDEXED BY idx_attachments_search
                WHERE a.status='ready' AND a.rowid<=@highWater
                    AND (@afterTime IS NULL OR a.created_at<@afterTime OR (a.created_at=@afterTime AND a.attachment_id<@afterId))
                    AND (@conversationId IS NULL OR a.conversation_id=@conversationId)
                    AND (@uploadedBy IS NULL OR a.uploaded_by=@uploadedBy)
                    AND (@minBytes IS NULL OR a.byte_size>=@minBytes)
                    AND (@maxBytes IS NULL OR a.byte_size<=@maxBytes)
                    AND (@createdAfter IS NULL OR a.created_at>@createdAfter)
                    AND (@createdBefore IS NULL OR a.created_at<@createdBefore)
                ORDER BY a.created_at DESC,a.attachment_id DESC LIMIT @take`).all(parameters);
        }),
        usageForUser: read(userId => {
            identifier(userId);
            return db.prepare(`SELECT coalesce(sum(byte_size),0) AS bytes FROM Attachments
                WHERE uploaded_by=? AND status IN ('pending','ready')`).get(userId).bytes;
        }),
        usageForConversation: read(conversationId => {
            identifier(conversationId);
            return db.prepare(`SELECT coalesce(sum(byte_size),0) AS bytes FROM Attachments
                WHERE conversation_id=? AND status IN ('pending','ready')`).get(conversationId).bytes;
        }),
        pendingCountForUser: read(userId => {
            identifier(userId);
            return db.prepare("SELECT count(*) AS count FROM Attachments WHERE uploaded_by=? AND status='pending'").get(userId).count;
        }),
        reservationUsage: read(nowIso => {
            isoTime(nowIso);
            return {
                byUser: db.prepare(`SELECT user_id,coalesce(sum(declared_bytes),0) AS bytes,count(*) AS count
                    FROM AttachmentReservations WHERE expires_at>? GROUP BY user_id ORDER BY user_id`).all(nowIso),
                byConversation: db.prepare(`SELECT conversation_id,coalesce(sum(declared_bytes),0) AS bytes,count(*) AS count
                    FROM AttachmentReservations WHERE expires_at>? GROUP BY conversation_id ORDER BY conversation_id`).all(nowIso),
                bySourceDigest: db.prepare(`SELECT source_digest,count(*) AS count FROM AttachmentReservations
                    WHERE expires_at>? GROUP BY source_digest ORDER BY source_digest`).all(nowIso)
            };
        }),
        listExpiredPending: read((nowIso, limit) => expiredPending.all(isoTime(nowIso), boundedLimit(limit))),
        listPurgeCandidates: read((beforeIso, limit) => purgeCandidates.all(isoTime(beforeIso), boundedLimit(limit))),
        listExpiredReservations: read((nowIso, limit) => expiredReservations.all(isoTime(nowIso), boundedLimit(limit))),
        listForReconciliation: read((afterId, limit) => {
            if (afterId !== null) identifier(afterId);
            return reconciliationRows.all(afterId,afterId,boundedLimit(limit));
        }),
        hasStorageKey: read(key => storageKeyExists.get(identifier(key)) !== undefined),

        insertReservation: write('insertReservation')(input => {
            inputFields(input, ['reservation_id','user_id','conversation_id','declared_bytes','source_digest','created_at','expires_at']);
            identifier(input.reservation_id); identifier(input.user_id); identifier(input.conversation_id);
            positiveInteger(input.declared_bytes); digest(input.source_digest); isoTime(input.created_at); isoTime(input.expires_at);
            db.prepare(`INSERT INTO AttachmentReservations(reservation_id,user_id,conversation_id,declared_bytes,source_digest,created_at,expires_at)
                VALUES(?,?,?,?,?,?,?)`).run(input.reservation_id,input.user_id,input.conversation_id,input.declared_bytes,input.source_digest,input.created_at,input.expires_at);
            return db.prepare('SELECT * FROM AttachmentReservations WHERE reservation_id=?').get(input.reservation_id);
        }),
        deleteReservation: write('deleteReservation')(id => compareAndSet(
            db.prepare('DELETE FROM AttachmentReservations WHERE reservation_id=? RETURNING reservation_id'), identifier(id))),
        deleteExpiredReservation: write('deleteExpiredReservation')((id, nowIso) => {
            identifier(id); isoTime(nowIso);
            return deleteExpiredReservation.get(id,nowIso) || null;
        }),
        deleteExpiredReservations: write('deleteExpiredReservations')(nowIso => {
            isoTime(nowIso);
            return { changes: db.prepare('DELETE FROM AttachmentReservations WHERE expires_at<=?').run(nowIso).changes };
        }),
        insertPending: write('insertPending')(input => {
            inputFields(input, ['attachment_id','conversation_id','uploaded_by','storage_key','encrypted_metadata','byte_size',
                'expires_at','integrity_digest','declared_algorithm','declared_format_version']);
            if (input.attachment_id !== undefined) identifier(input.attachment_id);
            identifier(input.conversation_id); identifier(input.uploaded_by); identifier(input.storage_key);
            if (typeof input.encrypted_metadata !== 'string' || input.encrypted_metadata.length === 0
                || Buffer.byteLength(input.encrypted_metadata, 'utf8') > 16384) throw new RepositoryError('INVALID');
            positiveInteger(input.byte_size); isoTime(input.expires_at); digest(input.integrity_digest);
            for (const name of ['declared_algorithm','declared_format_version']) {
                if (typeof input[name] !== 'string' || input[name].length < 1 || input[name].length > 64) throw new RepositoryError('INVALID');
            }
            return repositories.attachments.insertPending({ ...input, media_type:'application/octet-stream' });
        }),
        associate: write('associate')((ids, messageId, at) => {
            if (!Array.isArray(ids) || ids.length === 0) throw new RepositoryError('INVALID');
            ids.forEach(identifier); identifier(messageId); isoTime(at);
            const associateOne = db.prepare(`UPDATE Attachments SET status='ready',message_id=?,updated_at=?
                WHERE attachment_id=? AND status='pending' AND message_id IS NULL RETURNING *`);
            const rows = [];
            for (const id of ids) rows.push(compareAndSet(associateOne, messageId, at, id));
            return rows;
        }),
        markDeleted: write('markDeleted')((id, at) => {
            identifier(id); isoTime(at);
            return compareAndSet(db.prepare(`UPDATE Attachments SET status='deleted',deleted_at=?,updated_at=?
                WHERE attachment_id=? AND status IN ('pending','ready') RETURNING *`), at, at, id);
        }),
        markPurged: write('markPurged')(id => {
            identifier(id);
            return compareAndSet(db.prepare(`UPDATE Attachments SET purge_state='purged'
                WHERE attachment_id=? AND status='deleted' AND purge_state='not_purged' RETURNING *`), id);
        })
    });
}

module.exports = { createAttachmentRepository };
