import { ApiError, safeApiMessage, type SessionApi } from '@/api/sessionApi';
import { exact, identifier, timestamp } from '@/security/e2ee/protocol';
import type { DirectConversation, StoredMessage } from '@/security/e2ee/model';
import { isReactionEmoji } from '../../../shared/reactionEmoji';

export interface ReactionActor { userId: string; emoji: string | null; revision: number; updatedAt: string }
export interface ReactionRecord { storageId: string; messageId: string; state: 'active' | 'deleted'; version: number; actors: ReactionActor[] }
export interface ReactionState { records: Record<string, Record<string, ReactionRecord>>; saving: Record<string, boolean>; errors: Record<string, string> }
interface Intent { emoji: string | null; expectedRevision: number; operationId: string }
const version = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const denied = (e: unknown) => e instanceof ApiError && ['unauthorized', 'forbidden', 'not_found'].includes(e.code);
const message = (e: unknown) => e instanceof ApiError && ['conflict', 'idempotency_conflict'].includes(e.code)
  ? 'Your reaction changed in another session. Try again.'
  : e instanceof ApiError && e.code==='feature_unavailable' ? 'Reactions are unavailable on this server.'
  : e instanceof ApiError && e.code==='not_found' ? 'This message is no longer available for reactions.'
  : safeApiMessage(e, 'Could not update reactions. Try again.');

/** Server-confirmed, session-owned metadata. This store never receives decrypted message text. */
export class AuthenticatedReactions {
  private state: ReactionState = { records: {}, saving: {}, errors: {} };
  private listeners = new Set<() => void>();
  private allowed = new Map<string, DirectConversation>();
  private targets = new Map<string, Map<string, StoredMessage>>();
  private generations = new Map<string, number>();
  private loads = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  private changes = new Map<string, { storageId: string; emoji: string | null; promise: Promise<void> }>();
  private unresolved = new Map<string, Intent>();
  private active = true;
  private abort = new AbortController();
  constructor(private readonly api: SessionApi) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ReactionState>) { if (this.active) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); } }
  authorize(conversations: readonly DirectConversation[]) {
    const next = new Map(conversations.filter(c => c.interactionAllowed).map(c => [c.id, c]));
    const removed = [...this.allowed.keys()].filter(id => !next.has(id)); this.allowed = next;
    if (!removed.length) return;
    for (const id of removed) { this.generations.set(id, (this.generations.get(id) ?? 0) + 1); this.targets.delete(id); }
    const retain = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([id]) => next.has(id)));
    this.update({ records: retain(this.state.records), saving: retain(this.state.saving), errors: retain(this.state.errors) });
  }
  watch(cid: string, rows: readonly StoredMessage[]) {
    if (!this.active || !this.allowed.has(cid)) return;
    this.targets.set(cid, new Map(rows.filter(m => m.conversationId === cid && m.state === 'active' && m.encryption?.version === 2).map(m => [m.storageId, m])));
    const records=Object.assign(Object.create(null) as Record<string,ReactionRecord>,this.state.records[cid]);let changed=false;
    for(const m of rows)if(m.conversationId===cid&&m.state==='deleted'&&records[m.id]?.state!=='deleted'&&records[m.id]){
      records[m.id]={...records[m.id]!,state:'deleted',actors:[]};changed=true;
    }
    if(changed)this.update({records:{...this.state.records,[cid]:records}});
  }
  private current(cid: string, generation: number) { return this.active && this.allowed.has(cid) && (this.generations.get(cid) ?? 0) === generation; }
  private parse(cid: string, ids: string[], input: unknown): ReactionRecord[] {
    const body = exact(input, ['conversationId', 'items']);
    if (body.conversationId !== cid || !Array.isArray(body.items) || body.items.length !== ids.length) throw new ApiError('invalid_response');
    const seen = new Set<string>(), peers = new Set(this.allowed.get(cid)?.participants.map(p => p.id));
    return body.items.map(input => {
      const r = exact(input, ['storageId', 'messageId', 'state', 'version', 'actors']);
      identifier(r.storageId); identifier(r.messageId);
      const target = this.targets.get(cid)?.get(r.storageId as string);
      if (!ids.includes(r.storageId as string) || seen.has(r.storageId as string) || !target || target.id !== r.messageId || !version(r.version) || !['active', 'deleted'].includes(r.state as string) || !Array.isArray(r.actors) || r.actors.length > peers.size) throw new ApiError('invalid_response');
      seen.add(r.storageId as string); const users = new Set<string>();
      const actors = r.actors.map(input => {
        const a = exact(input, ['userId', 'emoji', 'revision', 'updatedAt']); identifier(a.userId); timestamp(a.updatedAt);
        if (!peers.has(a.userId as string) || users.has(a.userId as string) || !version(a.revision) || a.revision < 1 || (a.emoji !== null && !isReactionEmoji(a.emoji))) throw new ApiError('invalid_response');
        users.add(a.userId as string); return a as unknown as ReactionActor;
      });
      if (r.state === 'deleted' && actors.length) throw new ApiError('invalid_response');
      return { storageId: r.storageId as string, messageId: r.messageId as string, state: r.state as 'active' | 'deleted', version: r.version, actors };
    });
  }
  refresh(cid: string): Promise<void> {
    if (!this.active || !this.allowed.has(cid)) return Promise.resolve();
    const old = this.loads.get(cid); if (old) { old.dirty = true; return old.promise; }
    const generation = this.generations.get(cid) ?? 0, job = { dirty: false, promise: Promise.resolve() };
    const run = async () => {
      do {
        job.dirty = false; const ids = [...this.targets.get(cid)?.keys() ?? []];
        for (let offset = 0; offset < ids.length; offset += 50) {
          const batch = ids.slice(offset, offset + 50);
          const input = await this.api.request(`/api/conversations/${encodeURIComponent(cid)}/reactions?ids=${encodeURIComponent(batch.join(','))}`, { signal: this.abort.signal });
          if (!this.current(cid, generation)) return;
          // A view change can remove watched targets while its request is in flight.
          if (batch.some(id => !this.targets.get(cid)?.has(id))) { job.dirty = true; continue; }
          const records = Object.assign(Object.create(null) as Record<string,ReactionRecord>,this.state.records[cid]);
          for (const r of this.parse(cid, batch, input)) {
            const previous = records[r.messageId];
            if ((!previous || r.version >= previous.version) && !(previous?.state === 'deleted' && r.state === 'active')) records[r.messageId] = r;
          }
          this.update({ records: { ...this.state.records, [cid]: records }, errors: { ...this.state.errors, [cid]: '' } });
        }
      } while (job.dirty && this.current(cid, generation));
    };
    job.promise = run().catch(e => {
      if (this.current(cid, generation)) {
        if (denied(e)) { const records = { ...this.state.records }; delete records[cid]; this.update({ records }); }
        this.update({ errors: { ...this.state.errors, [cid]: message(e) } });
      }
      throw e;
    }).finally(() => { if (this.loads.get(cid) === job) this.loads.delete(cid); });
    this.loads.set(cid, job); return job.promise;
  }
  set(m: StoredMessage, emoji: string | null): Promise<void> {
    const cid = m.conversationId, key = JSON.stringify([cid, m.storageId]);
    if (!this.active || !this.allowed.has(cid) || m.state !== 'active' || m.encryption?.version !== 2 || (emoji !== null && !isReactionEmoji(emoji))) return Promise.reject(new Error('This message cannot receive reactions.'));
    const old = this.changes.get(cid); if (old) return old.storageId === m.storageId && old.emoji === emoji ? old.promise : Promise.reject(new Error('A reaction is still awaiting confirmation.'));
    const generation = this.generations.get(cid) ?? 0;
    this.update({ saving: { ...this.state.saving, [cid]: true }, errors: { ...this.state.errors, [cid]: '' } });
    const run = async () => {
      const targets=this.targets.get(cid)??new Map<string,StoredMessage>(); targets.set(m.storageId,m); this.targets.set(cid,targets);
      if (!this.state.records[cid]?.[m.id]) await this.refresh(cid);
      if (!this.current(cid, generation)) throw new ApiError('cancelled');
      const record = this.state.records[cid]?.[m.id]; if (!record || record.state !== 'active') throw new Error('This message is no longer available.');
      const mine = record.actors.find(a => a.userId === this.api.actor.id);
      if ((mine?.emoji ?? null) === emoji) { this.unresolved.delete(key); return; }
      let intent = this.unresolved.get(key);
      if (!intent || intent.emoji !== emoji) { intent = { emoji, expectedRevision: mine?.revision ?? 0, operationId: crypto.randomUUID() }; this.unresolved.set(key, intent); }
      try {
        const ack = exact(await this.api.request(`/api/messages/${encodeURIComponent(m.storageId)}/reaction`, { method: 'POST', body: intent, signal: this.abort.signal }), ['conversationId', 'storageId', 'messageId', 'userId', 'emoji', 'revision', 'version', 'operationId']);
        if (ack.conversationId !== cid || ack.storageId !== m.storageId || ack.messageId !== m.id || ack.userId !== this.api.actor.id || ack.emoji !== emoji || ack.operationId !== intent.operationId || !version(ack.revision) || ack.revision <= intent.expectedRevision || !version(ack.version)) throw new ApiError('invalid_response');
        await this.refresh(cid); if (!this.current(cid, generation)) throw new ApiError('cancelled');
        if ((this.state.records[cid]?.[m.id]?.version ?? -1) < ack.version) throw new ApiError('invalid_response');
        this.unresolved.delete(key);
      } catch (e) {
        const uncertain = !(e instanceof ApiError) || ['unavailable', 'service_unavailable', 'invalid_response', 'cancelled'].includes(e.code);
        await this.refresh(cid).catch(() => {});
        const current = this.state.records[cid]?.[m.id], own = current?.actors.find(a => a.userId === this.api.actor.id);
        if (uncertain && this.current(cid, generation) && current?.state === 'active' && (own?.revision ?? 0) > intent.expectedRevision && (own?.emoji ?? null) === emoji) { this.unresolved.delete(key); return; }
        if (!uncertain) this.unresolved.delete(key); throw new Error(message(e));
      }
    };
    const promise = run().catch(e => { if (this.current(cid, generation)) this.update({ errors: { ...this.state.errors, [cid]: e instanceof Error ? e.message : message(e) } }); throw e; })
      .finally(() => { this.changes.delete(cid); if (this.current(cid, generation)) this.update({ saving: { ...this.state.saving, [cid]: false } }); });
    this.changes.set(cid, { storageId: m.storageId, emoji, promise }); return promise;
  }
  dispose() { this.active = false; this.abort.abort(); this.allowed.clear(); this.targets.clear(); this.unresolved.clear(); this.listeners.clear(); this.state = { records: {}, saving: {}, errors: {} }; }
}
