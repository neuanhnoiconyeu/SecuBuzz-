'use strict';

const { createRepositories } = require('../database/repositories');

const BATCH_SIZE = 100;

function createRetentionJob({ db, repository, storage, now = () => new Date(), settings, logger = () => {} } = {}) {
    if (!db || typeof db.transaction !== 'function' || typeof db.inTransaction !== 'boolean') {
        throw new TypeError('createRetentionJob needs an open database connection');
    }
    for (const [name, value] of Object.entries({
        listExpiredPending: repository?.listExpiredPending,
        listPurgeCandidates: repository?.listPurgeCandidates,
        listExpiredReservations: repository?.listExpiredReservations,
        getById: repository?.getById,
        markDeleted: repository?.markDeleted,
        markPurged: repository?.markPurged,
        deleteReservation: repository?.deleteReservation,
        deleteExpiredReservation: repository?.deleteExpiredReservation,
        listForReconciliation: repository?.listForReconciliation,
        hasStorageKey: repository?.hasStorageKey
    })) if (typeof value !== 'function') throw new TypeError(`createRetentionJob needs repository.${name}`);
    for (const name of ['delete', 'listKeys', 'stat', 'sweepTemporary']) {
        if (typeof storage?.[name] !== 'function') throw new TypeError(`createRetentionJob needs storage.${name}`);
    }
    const { pendingTtlSeconds, purgeDelaySeconds, retentionIntervalSeconds } = settings || {};
    for (const [name, value] of Object.entries({ pendingTtlSeconds, purgeDelaySeconds, retentionIntervalSeconds })) {
        if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`createRetentionJob needs a valid ${name}`);
    }

    const auditRepository = createRepositories(db).audit;
    const safeLog = message => { try { logger(message); } catch { /* logging cannot stop cleanup */ } };
    const at = () => {
        const value = typeof now === 'function' ? now() : now?.current;
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) throw new TypeError('Retention clock must return a valid date');
        return date;
    };
    const audit = (row, eventType, operation, outcome, timestamp) => auditRepository.insert({
        actor_user_id: null,
        event_type: eventType,
        source: 'attachments',
        subject_id: row.attachment_id,
        metadata: { operation, outcome, target_id: row.conversation_id },
        created_at: timestamp
    });
    const immediate = operation => db.transaction(operation).immediate();

    async function markPurged(row, timestamp) {
        return immediate(() => {
            const current = repository.getById(row.attachment_id);
            if (!current || current.status !== 'deleted' || current.purge_state !== 'not_purged') return false;
            const updated = repository.markPurged(current.attachment_id);
            audit(updated, 'attachment.purged', 'purge', 'purged', timestamp);
            return true;
        });
    }

    async function expirePending(candidate, timestamp) {
        const deleted = immediate(() => {
            const current = repository.getById(candidate.attachment_id);
            if (!current || current.status !== 'pending' || Date.parse(current.expires_at) > Date.parse(timestamp)) return null;
            const updated = repository.markDeleted(current.attachment_id, timestamp);
            audit(updated, 'attachment.expired', 'expire', 'deleted', timestamp);
            return updated;
        });
        if (!deleted) return false;
        await storage.delete(deleted.storage_key);
        await markPurged(deleted, timestamp);
        return true;
    }

    async function purgeCandidate(candidate, timestamp, cutoff) {
        const current = repository.getById(candidate.attachment_id);
        if (!current || current.status !== 'deleted' || current.purge_state !== 'not_purged'
            || Date.parse(current.deleted_at) > Date.parse(cutoff)) return false;
        await storage.delete(current.storage_key);
        return markPurged(current, timestamp);
    }

    async function deleteReservation(candidate, timestamp) {
        return immediate(() => Boolean(repository.deleteExpiredReservation(candidate.reservation_id,timestamp)));
    }

    let running = null;
    let stopping = false;
    async function executeRun() {
        const timestamp = at().toISOString();
        const purgeCutoff = new Date(Date.parse(timestamp) - purgeDelaySeconds * 1000).toISOString();
        const counts = { expired: 0, purged: 0, reservations: 0, failures: 0 };
        const processRows = async (rows, operation, key) => {
            for (const row of rows) {
                if (stopping) break;
                try { if (await operation(row, timestamp, purgeCutoff)) counts[key] += 1; }
                catch { counts.failures += 1; }
            }
        };
        try { await storage.sweepTemporary(pendingTtlSeconds * 1000); }
        catch { counts.failures += 1; }
        const processQueue = async (load, operation, key) => {
            let rows;
            try { rows = load(); } catch { counts.failures += 1; return; }
            await processRows(rows, operation, key);
        };
        await processQueue(() => repository.listExpiredPending(timestamp, BATCH_SIZE), expirePending, 'expired');
        await processQueue(() => repository.listPurgeCandidates(purgeCutoff, BATCH_SIZE), purgeCandidate, 'purged');
        await processQueue(() => repository.listExpiredReservations(timestamp, BATCH_SIZE), deleteReservation, 'reservations');
        if (counts.failures) safeLog(`attachment retention failures count=${counts.failures}`);
        return Object.freeze(counts);
    }

    function runOnce() {
        if (running) return running;
        running = executeRun().finally(() => { running = null; });
        return running;
    }

    async function startupSweep() {
        const ttlMs = pendingTtlSeconds * 1000;
        try { await storage.sweepTemporary(ttlMs); }
        catch { safeLog('attachment retention startup cleanup failures count=1'); }
        let recordsWithoutBytes = 0;
        let bytesWithoutRecords = 0;
        try {
            let afterId = null;
            while (true) {
                const rows = repository.listForReconciliation(afterId, BATCH_SIZE);
                for (const row of rows) {
                    afterId = row.attachment_id;
                    if (row.status !== 'deleted' && await storage.stat(row.storage_key) === null) recordsWithoutBytes += 1;
                }
                if (rows.length < BATCH_SIZE) break;
            }
            for (const key of await storage.listKeys()) if (!repository.hasStorageKey(key)) bytesWithoutRecords += 1;
        } catch {
            // Keep the two startup diagnostics count-only, even if reconciliation itself fails.
            safeLog('attachment retention startup reconciliation failures count=1');
        }
        safeLog(`attachment retention startup records_without_bytes=${recordsWithoutBytes}`);
        safeLog(`attachment retention startup bytes_without_records=${bytesWithoutRecords}`);
    }

    let timer = null;
    let started = false;
    let stopped = true;
    let startup = null;
    const schedule = () => {
        if (stopped || !started || timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            Promise.resolve().then(runOnce).catch(() => {
                safeLog('attachment retention failures count=1');
            }).finally(schedule);
        }, retentionIntervalSeconds * 1000);
        if (typeof timer?.unref === 'function') timer.unref();
    };
    async function start() {
        if (started) return startup || undefined;
        started = true;
        stopped = false;
        stopping = false;
        startup = (async () => {
            try { await startupSweep(); }
            finally { schedule(); }
        })();
        return startup;
    }
    async function stop() {
        stopped = true;
        stopping = true;
        started = false;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        await Promise.all([startup, running].filter(Boolean));
    }

    return Object.freeze({ runOnce, start, stop });
}

module.exports = { createRetentionJob, RETENTION_BATCH_SIZE: BATCH_SIZE };
