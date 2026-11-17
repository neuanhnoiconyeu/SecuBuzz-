import { ApiError } from '@/api/sessionApi';
import { securityMessage } from '@/security/e2ee/api';
import { E2eeError, type DirectConversation, type EnvelopeV2 } from '@/security/e2ee/model';
import { SecureMessagingSession, type DecryptedRow, type SendProgress } from '@/security/e2ee/session';
import { AuthenticatedSocketIoClient, type LiveConnection } from './AuthenticatedSocketIoClient';
import { SocketFailure, type PresenceUpdate, type Receipt, type TypingUpdate } from './authenticatedProtocol';

export interface SecureLiveState {
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
    if (old && old.message.state === 'active' && row.message.state === 'active' && wire(old.message as EnvelopeV2) !== wire(row.message as EnvelopeV2)) throw new E2eeError('invalid_message');
    if (!old || row.message.revision >= old.message.revision) rows.set(row.message.id, row);
  }
  return [...rows.values()].sort((a, b) => a.message.sequence - b.message.sequence);
}

/** Session-owned state. REST supplies durable ordering; live events are buffered while fetching.
 * Decrypted messages, receipts, presence and socket references are discarded on disposal. */
export class SecureRealtimeWorkspace {
  readonly transport: AuthenticatedSocketIoClient;
  private active = true;
  private listeners = new Set<() => void>();
  private selected: string | null = null;
  private visible = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private typingExpiry = new Map<string, ReturnType<typeof setTimeout>>();
  private syncing = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  private refreshing: Promise<void> | undefined;
  private readDone = new Set<string>();
  private readInFlight = new Set<string>();
  private liveSeen = new Set<string>();
  private accessVersions = new Map<string, number>();
  private accessVersion(cid: string): number { return this.accessVersions.get(cid) ?? 0; }
  private state: SecureLiveState = { connection: 'offline', conversations: [], rows: {}, cursors: {}, unread: {},
    typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 0 };
  constructor(readonly session: SecureMessagingSession, origin: string,
    factory?: ConstructorParameters<typeof AuthenticatedSocketIoClient>[3]) {
    this.transport = new AuthenticatedSocketIoClient(session.api.session, {
      connection: status => {
        this.update({ connection: status, ...(status !== 'connected' ? { typing: {}, presence: {} } : {}) });
        if (status === 'connected') void this.reconcile().catch(e => this.fail('', e));
      },
      message: envelope => this.receive(envelope), keys: e => {
        this.update({ keyVersions: { ...this.state.keyVersions, [e.conversationId]: (this.state.keyVersions[e.conversationId] ?? 0) + 1 } });
        void this.session.revalidate(e.conversationId).catch(error => this.fail(e.conversationId, error));
      },
      receipt: e => this.observeReceipt(e), typing: e => this.observeTyping(e), presence: e => this.observePresence(e),
      updated: () => { void this.refresh().catch(e => this.fail('', e)); },
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
      const added = conversations.some(c => c.interactionAllowed && !this.state.conversations.some(old => old.id === c.id && old.interactionAllowed));
      for (const c of this.state.conversations) if (c.interactionAllowed && !authorized.has(c.id)) {
        this.accessVersions.set(c.id, this.accessVersion(c.id) + 1);
      }
      const retain = <T,>(entries: Record<string, T>) => Object.fromEntries(Object.entries(entries).filter(([id]) => authorized.has(id)));
      const receipts = Object.fromEntries(Object.entries(this.state.receipts).filter(([, r]) => authorized.has(r.conversationId)));
      const peers = new Set(conversations.filter(c => c.interactionAllowed).flatMap(c => c.participants.map(p => p.id)));
      this.update({ conversations, rows: retain(this.state.rows), cursors: retain(this.state.cursors), unread: retain(this.state.unread),
        typing: retain(this.state.typing), receipts, presence: Object.fromEntries(Object.entries(this.state.presence).filter(([id]) => peers.has(id))) });
      this.transport.setScopes(conversations);
      // A newly granted room has no client join event. A new handshake provides the room-ready
      // barrier; the following reconciliation includes anything sent during this transition.
      if (added && this.transport.connected) this.transport.refreshRooms();
    };
    this.refreshing = run().finally(() => { this.refreshing = undefined; }); return this.refreshing;
  }
  private async reconcile() {
    await this.refresh(); if (!this.active || !this.transport.connected) return;
    for (const conversation of this.state.conversations) {
      if (!conversation.interactionAllowed) continue;
      try { await this.session.revalidate(conversation.id); } catch (e) { this.fail(conversation.id, e); }
      await this.sync(conversation.id).catch(() => { /* One unavailable history must not prevent other authorized conversations from recovering. */ });
    }
    this.update({ synchronized: this.state.synchronized + 1 });
  }
  select(cid: string | null, visible: boolean) {
    if (this.selected !== cid || !visible) this.stopTyping(); this.selected = cid; this.visible = visible;
    if (cid && visible) { this.update({ unread: { ...this.state.unread, [cid]: 0 } }); this.markVisibleRead(cid); }
  }
  sync(cid: string): Promise<void> {
    const inFlight = this.syncing.get(cid);
    if (inFlight) { inFlight.dirty = true; return inFlight.promise; }
    const job = { dirty: false, promise: Promise.resolve() };
    const run = async () => {
      do {
        job.dirty = false;
        const version = this.accessVersion(cid), known = this.state.rows[cid] ?? [], anchors = new Set(known.map(r => r.message.id));
        let cursor: string | undefined, headCursor: string | null = null, fetched: DecryptedRow[] = [], completed = false;
        for (let page = 0; page < 200; page++) {
          const history = await this.session.history(cid, cursor);
          if (!this.active || version !== this.accessVersion(cid) || !this.allowed(cid)) return;
          if (page === 0) headCursor = history.nextCursor;
          fetched = mergeSecureRows(fetched, history.items);
          if (!known.length || !history.nextCursor || history.items.some(r => anchors.has(r.message.id))) { completed = true; break; }
          cursor = history.nextCursor;
        }
        if (!completed) throw new ApiError('resource_limit');
        const current = this.state.rows[cid] ?? [], rows = mergeSecureRows(current, fetched);
        const newPeerRows = fetched.filter(r => r.message.senderId !== this.session.api.session.actor.id && !anchors.has(r.message.id));
        const unread = this.visible && this.selected === cid ? 0 : (this.state.unread[cid] ?? 0) +
          (current.length === 0 ? 0 : newPeerRows.filter(r => !this.liveSeen.has(key(cid, r.message.id))).length);
        this.update({ rows: { ...this.state.rows, [cid]: rows }, cursors: { ...this.state.cursors,
          [cid]: Object.prototype.hasOwnProperty.call(this.state.cursors, cid) ? this.state.cursors[cid]! : headCursor },
          unread: { ...this.state.unread, [cid]: unread } });
        this.markVisibleRead(cid);
      } while (job.dirty && this.active && this.allowed(cid));
    };
    job.promise = run().catch(e => { this.fail(cid, e); throw e; }).finally(() => this.syncing.delete(cid));
    this.syncing.set(cid, job); return job.promise;
  }
  async older(cid: string): Promise<void> {
    const cursor = this.state.cursors[cid]; if (!cursor || !this.allowed(cid)) return;
    const version = this.accessVersion(cid), result = await this.session.history(cid, cursor);
    if (!this.active || version !== this.accessVersion(cid) || !this.allowed(cid)) return;
    this.update({ rows: { ...this.state.rows, [cid]: mergeSecureRows(this.state.rows[cid] ?? [], result.items) },
      cursors: { ...this.state.cursors, [cid]: result.nextCursor } });
  }
  private async receive(envelope: EnvelopeV2): Promise<boolean> {
    const cid = envelope.conversationId, version = this.accessVersion(cid); if (!this.allowed(cid)) return false;
    try {
      await this.session.decryptIncoming(envelope);
      if (!this.active || version !== this.accessVersion(cid) || !this.allowed(cid)) return false;
      const id = key(cid, envelope.id), first = !this.liveSeen.has(id);
      this.liveSeen.add(id); if (this.liveSeen.size > 10000) this.liveSeen.delete(this.liveSeen.values().next().value!);
      if (first && envelope.senderId !== this.session.api.session.actor.id && !(this.selected === cid && this.visible) &&
        !this.state.rows[cid]?.some(r => r.message.id === envelope.id)) this.update({ unread: { ...this.state.unread, [cid]: (this.state.unread[cid] ?? 0) + 1 } });
      await this.sync(cid);
      const found = this.state.rows[cid]?.find(r => r.message.id === envelope.id);
      return this.active && version === this.accessVersion(cid) && this.allowed(cid) && !!found && found.text !== null &&
        found.message.state === 'active' && wire(found.message as EnvelopeV2) === wire(envelope);
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
  async send(cid: string, name: string, text: string, mode: 'live' | 'rest', progress: SendProgress) {
    if (!this.allowed(cid)) throw new ApiError('forbidden'); this.stopTyping();
    try {
      const result = await this.session.send(cid, name, text, mode === 'live' ? this.transport.send : undefined, progress);
      progress('Persisted — delivery pending'); await this.sync(cid); return result;
    } catch (e) { await this.sendFailure(cid, e); throw e; }
  }
  async retry(cid: string, mode: 'live' | 'rest', progress: SendProgress) {
    try { const result = await this.session.retryPending(cid, mode === 'live' ? this.transport.send : undefined, progress); await this.sync(cid); return result; }
    catch (e) { await this.sendFailure(cid, e); throw e; }
  }
  dispose() {
    this.stopTyping(); this.active = false; this.transport.dispose();
    if (this.interval) clearInterval(this.interval); for (const timer of this.typingExpiry.values()) clearTimeout(timer);
    this.accessVersions.clear(); this.typingExpiry.clear(); this.listeners.clear(); this.liveSeen.clear(); this.readDone.clear(); this.readInFlight.clear();
    this.state = { connection: 'offline', rows: {}, conversations: [], cursors: {}, typing: {}, presence: {}, receipts: {},
      errors: {}, unread: {}, keyVersions: {}, synchronized: 0 };
  }
}
