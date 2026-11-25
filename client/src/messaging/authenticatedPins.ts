import { ApiError, safeApiMessage } from '@/api/sessionApi';
import { E2eeError, type DirectConversation, type StoredMessage } from '@/security/e2ee/model';
import { exact, identifier, timestamp } from '@/security/e2ee/protocol';
import { SecureMessagingSession, type DecryptedRow } from '@/security/e2ee/session';

export interface AuthenticatedPin { message: StoredMessage; pinnedBy: string; pinnedAt: string }
export interface PinCollection { conversationId: string; version: number; items: AuthenticatedPin[] }
export interface AuthenticatedPinState {
  collections: Record<string, PinCollection>; rows: Record<string, DecryptedRow[]>;
  saving: Record<string, boolean>; errors: Record<string, string>;
}
interface Intent { operationId: string; pinned: boolean; expectedVersion: number }
const safeVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const part = (v: string) => encodeURIComponent(identifier(v));
const errorText = (e: unknown) => e instanceof ApiError && ['conflict', 'idempotency_conflict'].includes(e.code)
  ? 'Pins changed in another session, or the pin limit was reached. Refresh and try again.'
  : e instanceof ApiError && e.code === 'feature_unavailable' ? 'Pinning is unavailable on this server.'
  : e instanceof ApiError && e.code === 'not_found' ? 'This message is no longer available for pinning.'
  : safeApiMessage(e, 'Could not update pinned messages. Try again.');

/** Session-owned metadata, independent of message encryption and local Delete for Me preferences. */
export class AuthenticatedPins {
  private state: AuthenticatedPinState = { collections: {}, rows: {}, saving: {}, errors: {} };
  private listeners = new Set<() => void>();
  private allowed = new Map<string, DirectConversation>();
  private generations = new Map<string, number>();
  private loads = new Map<string, { dirty: boolean; retryUnavailable: boolean; promise: Promise<void> }>();
  private changes = new Map<string, { id: string; pinned: boolean; promise: Promise<void> }>();
  private unresolved = new Map<string, Intent>();
  private abort = new AbortController();
  private active = true;
  constructor(private readonly session: SecureMessagingSession) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<AuthenticatedPinState>) {
    if (!this.active) return; this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  authorize(conversations: readonly DirectConversation[]) {
    const next = new Map(conversations.filter(c => c.interactionAllowed).map(c => [c.id, c]));
    const removed = [...this.allowed.keys()].filter(id => !next.has(id)); this.allowed = next;
    if (!removed.length) return;
    for (const id of removed) this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const retain = <T,>(rows: Record<string, T>) => Object.fromEntries(Object.entries(rows).filter(([id]) => next.has(id)));
    this.update({ collections: retain(this.state.collections), rows: retain(this.state.rows), errors: retain(this.state.errors), saving: retain(this.state.saving) });
  }
  private current(cid: string, generation: number) { return this.active && this.allowed.has(cid) && (this.generations.get(cid) ?? 0) === generation; }
  private parse(cid: string, input: unknown): PinCollection {
    const v = exact(input, ['conversationId', 'version', 'items']);
    if (v.conversationId !== cid || !safeVersion(v.version) || !Array.isArray(v.items) || v.items.length > 50) throw new ApiError('invalid_response');
    const seen = new Set<string>(), participants = this.allowed.get(cid)?.participants ?? [];
    const items = v.items.map(item => {
      const pin = exact(item, ['message', 'pinnedBy', 'pinnedAt']); identifier(pin.pinnedBy); timestamp(pin.pinnedAt);
      const message = this.session.api.stored(pin.message, cid);
      if (message.state !== 'active' || message.encryption?.version !== 2 || seen.has(message.id) || !participants.some(p => p.id === pin.pinnedBy) || !participants.some(p => p.id === message.senderId)) throw new ApiError('invalid_response');
      seen.add(message.id); return { message, pinnedBy: pin.pinnedBy as string, pinnedAt: pin.pinnedAt as string };
    });
    return { conversationId: cid, version: v.version, items };
  }
  refresh(cid: string, retryUnavailable = false): Promise<void> {
    if (!this.active || !this.allowed.has(cid)) return Promise.resolve();
    const existing = this.loads.get(cid); if (existing) { existing.dirty = true; existing.retryUnavailable ||= retryUnavailable; return existing.promise; }
    const generation = this.generations.get(cid) ?? 0, job = { dirty: false, retryUnavailable, promise: Promise.resolve() };
    const run = async () => {
      do {
        job.dirty = false;
        const retry = job.retryUnavailable; job.retryUnavailable = false;
        const collection = this.parse(cid, await this.session.api.session.request(`/api/conversations/${part(cid)}/pins`, { signal: this.abort.signal }));
        if (!this.current(cid, generation)) return;
        const rows = await Promise.all(collection.items.map(async (pin): Promise<DecryptedRow> => {
          const m = pin.message;
          const cached = this.state.rows[cid]?.find(row => row.message.id === m.id && JSON.stringify(row.message) === JSON.stringify(m));
          if (m.encryption?.version !== 2) throw new ApiError('invalid_response');
          try {
            if (cached && cached.text === null && !retry) return cached;
            // DTO equality does not establish freshness across sessions/tabs. Reuse
            // verified plaintext only while its exact persisted head is still current.
            if (cached && cached.text !== null && await this.session.isCachedMessageCurrent(cached.message)) return cached;
            return await this.session.decryptStoredMessage(m);
          } catch (e) {
            if (e instanceof ApiError && ['unauthorized', 'forbidden', 'not_found'].includes(e.code)) throw e;
            return { message: m, text: null, error: e instanceof E2eeError ? e.message : 'Pinned message unavailable on this device.', ...(e instanceof E2eeError ? { errorCode: e.code } : {}) };
          }
        }));
        if (!this.current(cid, generation)) return;
        if (collection.version >= (this.state.collections[cid]?.version ?? -1)) {
          this.update({ collections: { ...this.state.collections, [cid]: collection }, rows: { ...this.state.rows, [cid]: rows }, errors: { ...this.state.errors, [cid]: '' } });
        }
      } while (job.dirty && this.current(cid, generation));
    };
    job.promise = run().catch(e => {
      if (this.current(cid, generation)) {
        if (e instanceof ApiError && ['unauthorized', 'forbidden', 'not_found'].includes(e.code)) {
          const collections = { ...this.state.collections }, rows = { ...this.state.rows }; delete collections[cid]; delete rows[cid];
          this.update({ collections, rows });
        }
        this.update({ errors: { ...this.state.errors, [cid]: errorText(e) } });
      }
      throw e;
    }).finally(() => { if (this.loads.get(cid) === job) this.loads.delete(cid); });
    this.loads.set(cid, job); return job.promise;
  }
  set(message: StoredMessage, pinned: boolean): Promise<void> {
    const cid = message.conversationId, key = JSON.stringify([cid, message.storageId]);
    if (!this.active || !this.allowed.has(cid) || message.encryption?.version !== 2 || (pinned && message.state !== 'active')) return Promise.reject(new Error('This message cannot be pinned.'));
    const existing = this.changes.get(cid);
    if (existing) return existing.id === message.storageId && existing.pinned === pinned ? existing.promise : Promise.reject(new Error('A pin change is still awaiting confirmation.'));
    const generation = this.generations.get(cid) ?? 0;
    this.update({ saving: { ...this.state.saving, [cid]: true }, errors: { ...this.state.errors, [cid]: '' } });
    const run = async () => {
      if (!this.state.collections[cid]) await this.refresh(cid);
      if (!this.current(cid, generation)) throw new ApiError('cancelled');
      const before = this.state.collections[cid]!;
      if (before.items.some(pin => pin.message.id === message.id) === pinned) { this.unresolved.delete(key); return; }
      let intent = this.unresolved.get(key);
      if (!intent || intent.pinned !== pinned) { intent = { pinned, operationId: crypto.randomUUID(), expectedVersion: before.version }; this.unresolved.set(key, intent); }
      try {
        const ack = exact(await this.session.api.session.request(`/api/messages/${part(message.storageId)}/pin`, { method: 'POST', body: intent, signal: this.abort.signal }),
          ['conversationId', 'storageId', 'messageId', 'pinned', 'version', 'operationId']);
        if (ack.conversationId !== cid || ack.storageId !== message.storageId || ack.messageId !== message.id || ack.pinned !== pinned || ack.operationId !== intent.operationId || !safeVersion(ack.version) || ack.version < intent.expectedVersion) throw new ApiError('invalid_response');
        await this.refresh(cid);
        if (!this.current(cid, generation)) throw new ApiError('cancelled');
        if ((this.state.collections[cid]?.version ?? -1) < ack.version) throw new ApiError('invalid_response');
        this.unresolved.delete(key);
      } catch (e) {
        const uncertain = !(e instanceof ApiError) || ['unavailable', 'service_unavailable', 'invalid_response', 'cancelled'].includes(e.code);
        await this.refresh(cid).catch(() => {});
        if (uncertain && this.current(cid, generation)) {
          const current = this.state.collections[cid];
          if (current && current.version > intent.expectedVersion && current.items.some(pin => pin.message.id === message.id) === pinned) { this.unresolved.delete(key); return; }
        }
        if (!uncertain) this.unresolved.delete(key);
        throw new Error(errorText(e));
      }
    };
    const operation = run().catch(e => { if (this.current(cid, generation)) this.update({ errors: { ...this.state.errors, [cid]: errorText(e) } }); throw e; })
      .finally(() => { this.changes.delete(cid); if (this.current(cid, generation)) this.update({ saving: { ...this.state.saving, [cid]: false } }); });
    this.changes.set(cid, { id: message.storageId, pinned, promise: operation }); return operation;
  }
  dispose() {
    this.active = false; this.abort.abort(); this.allowed.clear(); this.generations.clear(); this.unresolved.clear(); this.listeners.clear();
    this.state = { collections: {}, rows: {}, saving: {}, errors: {} };
  }
}
