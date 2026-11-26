import { ApiError } from '@/api/sessionApi';
import { securityMessage } from '@/security/e2ee/api';
import { E2eeError, type DirectConversation, type EnvelopeV2, type StoredMessage } from '@/security/e2ee/model';
import { SecureMessagingSession, type DecryptedRow, type SendProgress } from '@/security/e2ee/session';
import { AuthenticatedSocketIoClient, type LiveConnection } from './AuthenticatedSocketIoClient';
import { SocketFailure, type PresenceUpdate, type Receipt, type TypingUpdate } from './authenticatedProtocol';
import { AuthenticatedPins } from '@/messaging/authenticatedPins';
import { AuthenticatedReactions } from '@/messaging/authenticatedReactions';
import type { BuzzEvent } from '../../../shared/buzz';

export interface SecureLiveState {
  buzz?: BuzzEvent;
  /** Ephemeral metadata only, emitted after a new live message is verified and reconciled. */
  incomingMessage?: { id: string; conversationId: string; senderId: string; senderName: string } | undefined;
  connection: LiveConnection; conversations: DirectConversation[]; rows: Record<string, DecryptedRow[]>;
  cursors: Record<string, string | null>; unread: Record<string, number>; typing: Record<string, TypingUpdate>;
  presence: Record<string, PresenceUpdate>; receipts: Record<string, Receipt>; keyVersions: Record<string, number>;
  errors: Record<string, string>; synchronized: number;
}
const wire = (e: EnvelopeV2) => JSON.stringify([e.id, e.conversationId, e.senderId, e.senderName, e.timestamp, e.type,
  e.encryption?.version, e.encryption?.algorithm, e.encryption?.encoding, e.encryption?.keyId, e.encryption?.iv, e.encryption?.ciphertext]);
const key = (cid: string, id: string) => JSON.stringify([cid, id]);
export function mergeSecureRows(previous: readonly DecryptedRow[], incoming: readonly DecryptedRow[]): DecryptedRow[] {
  const rows = new Map(previous.map(row => [row.message.id, row]));
  for (const row of incoming) {
    const old = rows.get(row.message.id);
    if(old&&(old.message.storageId!==row.message.storageId||old.message.sequence!==row.message.sequence||old.message.storedAt!==row.message.storedAt))throw new E2eeError('invalid_message');
    if (old?.message.state === 'deleted' && row.message.state !== 'deleted') continue;
    if (old && old.message.state === 'active' && row.message.state === 'active' && wire(old.message as EnvelopeV2) !== wire(row.message as EnvelopeV2)) throw new E2eeError('invalid_message');
    if(old&&old.message.state==='active'&&row.message.state==='active'){
      const before=old.message.edit?.proofs??[],next=row.message.edit?.proofs??[];
      if(next.length<before.length||(!old.error&&row.error))continue;
      if(before.some((p,i)=>JSON.stringify(p.proof)!==JSON.stringify(next[i]?.proof))||
        (next.length===before.length&&before.length&&JSON.stringify(old.message.edit?.envelope)!==JSON.stringify(row.message.edit?.envelope)))throw new E2eeError('invalid_message');
    }
    if (!old || row.message.revision >= old.message.revision) rows.set(row.message.id, row);
  }
  return [...rows.values()].sort((a, b) => a.message.sequence - b.message.sequence);
}

/** Session-owned state. REST supplies durable ordering; live events are buffered while fetching.
 * Decrypted messages, receipts, presence and socket references are discarded on disposal. */
export class SecureRealtimeWorkspace {
  readonly transport: AuthenticatedSocketIoClient;
  readonly pins: AuthenticatedPins;
  readonly reactions: AuthenticatedReactions;
  private active = true;
  private listeners = new Set<() => void>();
  private selected: string | null = null;
  private visible = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private typingExpiry = new Map<string, ReturnType<typeof setTimeout>>();
  private syncing = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  private deletionHints = new Map<string, Set<string>>();
  private editHints = new Map<string,Set<string>>();
  private refreshLoaded = new Set<string>();
  private refreshing: Promise<void> | undefined;
  private readDone = new Set<string>();
  private readInFlight = new Set<string>();
  private liveSeen = new Set<string>();
  private notificationEpoch = 0;
  private notificationRun = 0;
  private notificationsReady = false;
  private accessVersions = new Map<string, number>();
  private accessVersion(cid: string): number { return this.accessVersions.get(cid) ?? 0; }
  private state: SecureLiveState = { connection: 'offline', conversations: [], rows: {}, cursors: {}, unread: {},
    typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 0 };
  constructor(readonly session: SecureMessagingSession, origin: string,
    factory?: ConstructorParameters<typeof AuthenticatedSocketIoClient>[3]) {
    this.pins = new AuthenticatedPins(session);
    this.reactions = new AuthenticatedReactions(session.api.session);
    this.transport = new AuthenticatedSocketIoClient(session.api.session, {
      connection: status => {
        this.notificationsReady = false; this.notificationEpoch++;
        this.update({ connection: status, ...(status !== 'connected' ? { typing: {}, presence: {}, incomingMessage: undefined } : {}) });
        if (status === 'connected') void this.reconcile().catch(e => this.fail('', e));
      },
      message: envelope => this.receive(envelope), keys: e => {
        this.update({ keyVersions: { ...this.state.keyVersions, [e.conversationId]: (this.state.keyVersions[e.conversationId] ?? 0) + 1 } });
        void this.session.revalidate(e.conversationId).catch(error => this.fail(e.conversationId, error));
      },
      receipt: e => this.observeReceipt(e), typing: e => this.observeTyping(e), presence: e => this.observePresence(e),
      buzz: event => { if (this.allowed(event.conversationId)) this.update({ buzz: event }); },
      updated: () => { void this.refresh().catch(e => this.fail('', e)); },
      deleted: event => {
        if (!this.allowed(event.conversationId)) return;
        const hints = this.deletionHints.get(event.conversationId) ?? new Set<string>();
        hints.add(event.messageId); this.deletionHints.set(event.conversationId, hints);
        void this.sync(event.conversationId).catch(e => this.fail(event.conversationId, e));
        void this.pins.refresh(event.conversationId).catch(() => {});
        void this.reactions.refresh(event.conversationId).catch(() => {});
      },
      edited:event=>{
        if(!this.allowed(event.conversationId))return;
        const hints=this.editHints.get(event.conversationId)??new Set<string>();hints.add(event.messageId);this.editHints.set(event.conversationId,hints);
        this.refreshLoaded.add(event.conversationId);void this.sync(event.conversationId).catch(e=>this.fail(event.conversationId,e));
        void this.pins.refresh(event.conversationId).catch(()=>{});
      },
      pins: event => { if (this.allowed(event.conversationId)) void this.pins.refresh(event.conversationId).catch(() => {}); },
      reactions: event => { if (this.allowed(event.conversationId)) void this.reactions.refresh(event.conversationId).catch(() => {}); },
    }, origin, factory);
  }
  getSnapshot = (): SecureLiveState => this.state;
  clearError(cid: string): void {
    const errors = { ...this.state.errors }; delete errors[cid]; this.update({ errors });
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<SecureLiveState>) {
    if (!this.active) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  private allowed(cid: string): boolean { return this.active && this.state.conversations.some(c => c.id === cid && c.interactionAllowed); }
  /** DATA lists unblocked member conversations even when renewed friendship is required to write. */
  private readable(cid: string): boolean { return this.active && this.state.conversations.some(c => c.id === cid); }
  private fail(cid: string, e: unknown) {
    if (!this.active) return;
    this.update({ errors: { ...this.state.errors, [cid]: e instanceof SocketFailure ? e.message : securityMessage(e) } });
    if (e instanceof ApiError && ['forbidden', 'not_found'].includes(e.code)) void this.refresh().catch(() => {});
  }
  start() {
    this.transport.start(); void this.refresh().catch(e => this.fail('', e));
    this.interval = setInterval(() => { if (this.active) void this.refresh().catch(e => this.fail('', e)); }, 15000);
  }
  reconnect() { this.transport.reconnect(); if (this.transport.connected) void this.reconcile().catch(e => this.fail('', e)); }
  buzz(cid: string): Promise<BuzzEvent> {
    if (!this.allowed(cid)) return Promise.reject(new SocketFailure('unauthorized_conversation'));
    return this.transport.buzz(cid);
  }
  applyConversation(updated: DirectConversation): void {
    if (!this.active) return;
    const exists = this.state.conversations.some(c => c.id === updated.id);
    if (!exists) return;
    this.update({ conversations: this.state.conversations.map(c => c.id === updated.id ? updated : c) });
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const run = async () => {
      const conversations: DirectConversation[] = []; let cursor: string | undefined;
      for (let page = 0; page < 40; page++) {
        const result = await this.session.api.conversations(cursor); if (!this.active) return;
        conversations.push(...result.items); if (!result.nextCursor) { cursor = undefined; break; } cursor = result.nextCursor;
      }
      if (cursor) throw new ApiError('resource_limit');
      const authorized = new Set(conversations.filter(c => c.interactionAllowed).map(c => c.id));
      const readable = new Set(conversations.map(c => c.id));
      const readOnlyAdded = conversations.filter(c => !c.interactionAllowed && !this.state.conversations.some(old => old.id === c.id));
      const added = conversations.some(c => c.interactionAllowed && !this.state.conversations.some(old => old.id === c.id && old.interactionAllowed));
      for (const c of this.state.conversations) if (!readable.has(c.id) || c.interactionAllowed !== authorized.has(c.id)) {
        this.accessVersions.set(c.id, this.accessVersion(c.id) + 1);
        this.deletionHints.delete(c.id);this.editHints.delete(c.id); this.refreshLoaded.delete(c.id);
      }
      const retain = <T,>(entries: Record<string, T>, scopes = authorized) => Object.fromEntries(Object.entries(entries).filter(([id]) => scopes.has(id)));
      const receipts = Object.fromEntries(Object.entries(this.state.receipts).filter(([, r]) => authorized.has(r.conversationId)));
      const peers = new Set(conversations.filter(c => c.interactionAllowed).flatMap(c => c.participants.map(p => p.id)));
      this.pins.authorize(conversations);
      this.reactions.authorize(conversations);
      this.update({ conversations, rows: retain(this.state.rows, readable), cursors: retain(this.state.cursors, readable), unread: retain(this.state.unread),
        typing: retain(this.state.typing), receipts, presence: Object.fromEntries(Object.entries(this.state.presence).filter(([id]) => peers.has(id))) });
      this.transport.setScopes(conversations);
      // A newly granted room has no client join event. A new handshake provides the room-ready
      // barrier; the following reconciliation includes anything sent during this transition.
      if (added && this.transport.connected) this.transport.refreshRooms();
      for (const c of readOnlyAdded) void this.sync(c.id).catch(() => {});
    };
    this.refreshing = run().finally(() => { this.refreshing = undefined; }); return this.refreshing;
  }
  private async reconcile() {
    const epoch = this.notificationEpoch, run = ++this.notificationRun;
    this.notificationsReady = false;
    await this.refresh(); if (!this.active || !this.transport.connected) return;
    for (const conversation of this.state.conversations) {
      if (conversation.interactionAllowed) try { await this.session.revalidate(conversation.id); } catch (e) { this.fail(conversation.id, e); }
      this.refreshLoaded.add(conversation.id);
      await this.sync(conversation.id).catch(() => { /* One unavailable history must not prevent other authorized conversations from recovering. */ });
      await this.pins.refresh(conversation.id, true).catch(() => {});
      await this.reactions.refresh(conversation.id).catch(() => {});
    }
    this.update({ synchronized: this.state.synchronized + 1 });
    if (this.active && this.transport.connected && epoch === this.notificationEpoch && run === this.notificationRun) this.notificationsReady = true;
  }
  select(cid: string | null, visible: boolean) {
    if (this.selected !== cid || !visible) this.stopTyping(); this.selected = cid; this.visible = visible;
    if (cid && visible) { this.update({ unread: { ...this.state.unread, [cid]: 0 } }); this.markVisibleRead(cid); }
  }
  sync(cid: string): Promise<void> {
    if (!this.readable(cid)) return Promise.reject(new ApiError('not_found'));
    const inFlight = this.syncing.get(cid);
    if (inFlight) { inFlight.dirty = true; return inFlight.promise; }
    const job = { dirty: false, promise: Promise.resolve() };
    const run = async () => {
      do {
        job.dirty = false;
        const version = this.accessVersion(cid), known = this.state.rows[cid] ?? [], anchors = new Set(known.map(r => r.message.id));
        const targets = new Set([...(this.deletionHints.get(cid)??[]),...(this.editHints.get(cid)??[])]), refreshLoaded = this.refreshLoaded.has(cid);
        const oldest = known.length ? Math.min(...known.map(row => row.message.sequence)) : undefined;
        let cursor: string | undefined, headCursor: string | null = null, fetched: DecryptedRow[] = [], completed = false, stale = false;
        for (let page = 0; page < 200; page++) {
          let history: Awaited<ReturnType<SecureMessagingSession['history']>>;
          try { history = await this.session.history(cid, cursor); }
          catch (e) {
            if (!this.readable(cid)) return;
            if (version !== this.accessVersion(cid)) { stale = true; job.dirty = true; break; }
            throw e;
          }
          if (!this.readable(cid)) return;
          if (version !== this.accessVersion(cid)) { stale = true; job.dirty = true; break; }
          if (page === 0) headCursor = history.nextCursor;
          fetched = mergeSecureRows(fetched, history.items);
          const targetReached = [...targets].every(id => fetched.some(row => row.message.id === id));
          const loadedReached = !refreshLoaded || oldest === undefined || history.items.some(row => row.message.sequence <= oldest);
          if (!history.nextCursor || (targetReached && loadedReached && (!known.length || history.items.some(r => anchors.has(r.message.id))))) { completed = true; break; }
          cursor = history.nextCursor;
        }
        if (stale) continue;
        if (!completed) throw new ApiError('resource_limit');
        for (const id of targets) if (fetched.some(row => row.message.id === id && row.message.state === 'deleted')) this.deletionHints.get(cid)?.delete(id);
        for(const id of targets)if(fetched.some(row=>row.message.id===id&&!row.error))this.editHints.get(cid)?.delete(id);
        if (refreshLoaded && !job.dirty) this.refreshLoaded.delete(cid);
        const current = this.state.rows[cid] ?? [], rows = mergeSecureRows(current, fetched);
        const newest = known.length ? Math.max(...known.map(row => row.message.sequence)) : 0;
        const newPeerRows = fetched.filter(r => r.message.state === 'active' && r.message.senderId !== this.session.api.session.actor.id && !anchors.has(r.message.id) && r.message.sequence > newest);
        const unread = !this.allowed(cid) || this.visible && this.selected === cid ? 0 : (this.state.unread[cid] ?? 0) +
          (current.length === 0 ? 0 : newPeerRows.filter(r => !this.liveSeen.has(key(cid, r.message.id))).length);
        this.update({ rows: { ...this.state.rows, [cid]: rows }, cursors: { ...this.state.cursors,
          [cid]: Object.prototype.hasOwnProperty.call(this.state.cursors, cid) ? this.state.cursors[cid]! : headCursor },
          unread: { ...this.state.unread, [cid]: unread } });
        this.markVisibleRead(cid);
      } while (job.dirty && this.active && this.readable(cid));
    };
    job.promise = run().catch(e => { this.fail(cid, e); throw e; }).finally(() => this.syncing.delete(cid));
    this.syncing.set(cid, job); return job.promise;
  }
  /** Only called with a validated tombstone returned by the existing authenticated Unsend API. */
  acceptUnsend(message: StoredMessage): void {
    if (!this.allowed(message.conversationId) || message.state !== 'deleted' || message.encryption !== null) return;
    const cid = message.conversationId, rows = mergeSecureRows(this.state.rows[cid] ?? [], [{ message, text: null, error: null }]);
    this.deletionHints.get(cid)?.delete(message.id);
    this.update({ rows: { ...this.state.rows, [cid]: rows } });
  }
  acceptEdit(row:DecryptedRow):void{
    if(!this.allowed(row.message.conversationId)||row.message.state!=='active'||row.error)return;
    const cid=row.message.conversationId;this.update({rows:{...this.state.rows,[cid]:mergeSecureRows(this.state.rows[cid]??[],[row])}});
  }
  async older(cid: string): Promise<void> {
    const cursor = this.state.cursors[cid]; if (!cursor || !this.readable(cid)) return;
    const version = this.accessVersion(cid), result = await this.session.history(cid, cursor);
    if (!this.active || version !== this.accessVersion(cid) || !this.readable(cid)) return;
    this.update({ rows: { ...this.state.rows, [cid]: mergeSecureRows(this.state.rows[cid] ?? [], result.items) },
      cursors: { ...this.state.cursors, [cid]: result.nextCursor } });
  }
  private async receive(envelope: EnvelopeV2): Promise<boolean> {
    const cid = envelope.conversationId, version = this.accessVersion(cid); if (!this.allowed(cid)) return false;
    const epoch = this.notificationEpoch, notify = this.notificationsReady;
    const baseline = Object.prototype.hasOwnProperty.call(this.state.rows, cid)
      ? Math.max(0, ...(this.state.rows[cid] ?? []).map(row => row.message.sequence)) : null;
    try {
      await this.session.decryptIncoming(envelope);
      if (!this.active || version !== this.accessVersion(cid) || !this.allowed(cid)) return false;
      const id = key(cid, envelope.id), first = !this.liveSeen.has(id);
      this.liveSeen.add(id); if (this.liveSeen.size > 10000) this.liveSeen.delete(this.liveSeen.values().next().value!);
      if (first && envelope.senderId !== this.session.api.session.actor.id && !(this.selected === cid && this.visible) &&
        !this.state.rows[cid]?.some(r => r.message.id === envelope.id)) this.update({ unread: { ...this.state.unread, [cid]: (this.state.unread[cid] ?? 0) + 1 } });
      await this.sync(cid);
      const found = this.state.rows[cid]?.find(r => r.message.id === envelope.id);
      const accepted = this.active && version === this.accessVersion(cid) && this.allowed(cid) && !!found && found.text !== null &&
        found.message.state === 'active' && wire(found.message as EnvelopeV2) === wire(envelope);
      if (accepted && found && !found.error && first && notify && this.notificationsReady && epoch === this.notificationEpoch &&
        baseline !== null && found.message.sequence > baseline && envelope.senderId !== this.session.api.session.actor.id) {
        this.update({ incomingMessage: { id: envelope.id, conversationId: cid, senderId: envelope.senderId,
          senderName: this.state.conversations.find(c => c.id === cid)?.participants.find(p => p.id === envelope.senderId)?.displayName ?? 'Your contact' } });
      }
      return accepted;
    } catch (e) { this.fail(cid, e); if (this.allowed(cid)) await this.sync(cid).catch(() => {}); return false; }
  }
  private observeReceipt(event: Receipt) {
    const id = key(event.conversationId, event.messageId), old = this.state.receipts[id];
    if (old?.status === 'read' || (old?.status === event.status && old.timestamp >= event.timestamp)) return;
    this.update({ receipts: { ...this.state.receipts, [id]: event } });
  }
  receiptFor(cid: string, id: string): Receipt | undefined { return this.state.receipts[key(cid, id)]; }
  private markVisibleRead(cid: string) {
    if (!this.visible || this.selected !== cid || !this.allowed(cid) || !this.transport.connected) return;
    for (const row of (this.state.rows[cid] ?? []).slice(-50)) {
      const id = key(cid, row.message.id);
      if (row.message.senderId === this.session.api.session.actor.id || row.text === null || row.message.state !== 'active' || this.readDone.has(id) || this.readInFlight.has(id)) continue;
      this.readInFlight.add(id);
      void this.transport.read(cid, row.message.id).then(() => { if (this.active) this.readDone.add(id); }).catch(() => {}).finally(() => this.readInFlight.delete(id));
    }
  }
  private observeTyping(event: TypingUpdate) {
    const old = this.state.typing[event.conversationId]; if (old && old.timestamp > event.timestamp) return;
    const typing = { ...this.state.typing }; if (event.isTyping) typing[event.conversationId] = event; else delete typing[event.conversationId];
    const timer = this.typingExpiry.get(event.conversationId); if (timer) clearTimeout(timer);
    if (event.isTyping) this.typingExpiry.set(event.conversationId, setTimeout(() => {
      const current = { ...this.state.typing }; delete current[event.conversationId]; this.update({ typing: current });
    }, 5000)); this.update({ typing });
  }
  private observePresence(event: PresenceUpdate) {
    const old = this.state.presence[event.userId]; if (old && old.timestamp > event.timestamp) return;
    const presence = { ...this.state.presence }; if (event.status === 'unknown') delete presence[event.userId]; else presence[event.userId] = event;
    this.update({ presence });
  }
  typing(cid: string) {
    if (this.selected !== cid || !this.visible || !this.allowed(cid)) return;
    this.transport.typing(cid); if (this.typingTimer) clearTimeout(this.typingTimer); this.typingTimer = setTimeout(() => this.stopTyping(), 2000);
  }
  stopTyping() { if (this.typingTimer) clearTimeout(this.typingTimer); if (this.selected) this.transport.stopTyping(this.selected); }
  private async sendFailure(cid: string, error: unknown): Promise<void> {
    this.fail(cid, error);
    if ((error instanceof SocketFailure && error.code === 'recipient_keys_unavailable') ||
      (error instanceof ApiError && ['recipient_keys_changed', 'recipient_keys_unverified', 'recipient_keys_missing'].includes(error.code))) {
      // Re-read the directory and expose TOFU review, but never re-encrypt/retry automatically.
      try { await this.session.revalidate(cid); } catch (e) { this.fail(cid, e); }
      this.update({ keyVersions: { ...this.state.keyVersions, [cid]: (this.state.keyVersions[cid] ?? 0) + 1 } });
    } else if (error instanceof SocketFailure && error.code === 'unauthorized_conversation') await this.refresh().catch(() => {});
  }
  async send(cid: string, name: string, text: string, mode: 'live' | 'rest', progress: SendProgress,messageId?:string) {
    if (!this.allowed(cid)) throw new ApiError('forbidden'); this.stopTyping();
    try {
      const result = messageId ? await this.session.send(cid,name,text,mode==='live'?this.transport.send:undefined,progress,messageId) : await this.session.send(cid, name, text, mode === 'live' ? this.transport.send : undefined, progress);
      progress('Persisted — delivery pending'); await this.sync(cid).catch(e=>this.fail(cid,e)); return result;
    } catch (e) { await this.sendFailure(cid, e); throw e; }
  }
  async retry(cid: string, mode: 'live' | 'rest', progress: SendProgress) {
    try { const result = await this.session.retryPending(cid, mode === 'live' ? this.transport.send : undefined, progress); await this.sync(cid).catch(e=>this.fail(cid,e)); return result; }
    catch (e) { await this.sendFailure(cid, e); throw e; }
  }
  dispose() {
    this.stopTyping(); this.active = false; this.transport.dispose(); this.pins.dispose(); this.reactions.dispose();
    if (this.interval) clearInterval(this.interval); for (const timer of this.typingExpiry.values()) clearTimeout(timer);
    this.accessVersions.clear(); this.deletionHints.clear();this.editHints.clear(); this.refreshLoaded.clear(); this.typingExpiry.clear(); this.listeners.clear(); this.liveSeen.clear(); this.readDone.clear(); this.readInFlight.clear();
    this.state = { connection: 'offline', rows: {}, conversations: [], cursors: {}, typing: {}, presence: {}, receipts: {},
      errors: {}, unread: {}, keyVersions: {}, synchronized: 0 };
  }
}
