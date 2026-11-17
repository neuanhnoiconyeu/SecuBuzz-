import { randomUUID } from 'node:crypto';
import { callAdapter } from '../realtime/adapterCall.ts';
import type { ServerClock } from '../realtime/clock.ts';
import type { ResolvedRealtimeConfig } from '../realtime/config.ts';
import type { EventGate } from '../realtime/eventGate.ts';
import type { Connection, ConnectionRegistry } from '../realtime/registry.ts';
import type { DirectCallMediaAuthorization, ResolvedDirectCallOptions } from './config.ts';
import type { RealtimeActor } from '../realtime/contracts.ts';
import { CALL_CLIENT_EVENTS, CALL_SERVER_EVENTS, callError, type CallAck, type CallClientEventName, type CallEndReason,
  type CallErrorCode, type CallParticipant, type CallSnapshot, type CallStatus, type CallSyncAck, type InitiateCallBody } from './protocol.ts';
import { parseDirectParticipants } from './validation.ts';

interface CallRecord {
  snapshot: CallSnapshot;
  readonly requestKey: string;
  readonly fingerprint: string;
  timer: NodeJS.Timeout | null;
  readonly mediaSessions: Map<string, string>;
  readonly callerConnectionId: string;
  recipientConnectionId: string | null;
  readonly mediaConnections: Set<string>;
}
const terminal = (status: CallStatus) => status !== 'ringing' && status !== 'accepted';

/** One process owns every transition. No database writes, media transport, or caller identity from payloads. */
export class DirectCallRouter {
  readonly #config: ResolvedRealtimeConfig;
  readonly #options: ResolvedDirectCallOptions | null;
  readonly #registry: ConnectionRegistry;
  readonly #clock: ServerClock;
  readonly #gate: EventGate;
  readonly #refreshAccess: (userId: string) => Promise<boolean>;
  readonly #records = new Map<string, CallRecord>();
  readonly #requests = new Map<string, string>();
  readonly #active = new Map<string, string>();
  readonly #byUser = new Map<string, Set<string>>();
  readonly #accessLoads = new Map<string, Promise<boolean>>();
  #closed = false;

  constructor(deps: { config: ResolvedRealtimeConfig; options: ResolvedDirectCallOptions | null; registry: ConnectionRegistry;
    clock: ServerClock; gate: EventGate; refreshAccess(userId: string): Promise<boolean> }) {
    this.#config = deps.config; this.#options = deps.options; this.#registry = deps.registry;
    this.#clock = deps.clock; this.#gate = deps.gate; this.#refreshAccess = deps.refreshAccess;
  }
  get enabled(): boolean { return Boolean(this.#options && this.#config.sessionResolver && this.#config.authorizer); }
  get activeCount(): number { return this.#active.size / 2; }
  get retainedCount(): number { return this.#records.size; }
  #alive(connection: Connection): boolean {
    return !connection.closed && connection.expiresAt > this.#clock.nowMs() && this.#registry.connection(connection.id) === connection;
  }
  #eligible(connection: Connection, call: CallSnapshot): boolean {
    const id = connection.actor.userId;
    return this.#alive(connection) && (id === call.caller.userId || id === call.recipient.userId) &&
      connection.user.conversations.has(call.conversationId) && !this.#registry.isBlockedPair(call.caller.userId, call.recipient.userId);
  }
  #online(userId: string, conversationId: string): boolean {
    return [...(this.#registry.user(userId)?.connections ?? [])].some(connection => this.#alive(connection) && connection.user.conversations.has(conversationId));
  }
  #refresh(userId: string): Promise<boolean> {
    const existing = this.#accessLoads.get(userId);
    if (existing) return existing;
    const pending = this.#refreshAccess(userId).finally(() => { if (this.#accessLoads.get(userId) === pending) this.#accessLoads.delete(userId); });
    this.#accessLoads.set(userId, pending);
    return pending;
  }
  async #authorize(connection: Connection, event: CallClientEventName | 'call:media', raw: unknown, conversationId: string, peerId: string, requirePeer: boolean):
    Promise<{ people: readonly CallParticipant[]; current(): boolean } | { error: CallErrorCode }> {
    if (!this.enabled || this.#closed) return { error: 'unavailable' };
    if (!this.#alive(connection) || !connection.user.conversations.has(conversationId) || peerId === connection.actor.userId) return { error: 'call_not_allowed' };
    const peer = this.#registry.user(peerId);
    const [policy, selfFresh, peerFresh] = await Promise.all([
      this.#gate.evaluate(connection, event, raw, { conversationId }), this.#refresh(connection.actor.userId),
      peer ? this.#refresh(peerId) : Promise.resolve(true),
    ]);
    if (policy !== 'allow') return { error: policy === 'deny' ? 'policy_denied' : 'unavailable' };
    if (!selfFresh || !peerFresh || this.#closed || !this.#alive(connection)) return { error: 'unavailable' };
    if (!connection.user.conversations.has(conversationId) || this.#registry.isBlockedPair(connection.actor.userId, peerId)) return { error: 'call_not_allowed' };
    if (requirePeer && !this.#online(peerId, conversationId)) return { error: 'recipient_unavailable' };
    const selfSequence = connection.user.snapshotSequence, peerSequence = peer?.snapshotSequence;
    const resolver = this.#options!.conversationResolver;
    const result = await callAdapter(() => resolver.resolveDirectConversation(connection.actor, conversationId), this.#config.timing.adapterTimeoutMs);
    if (!result.ok) return { error: 'unavailable' };
    const people = parseDirectParticipants(result.value, conversationId, connection.actor.userId, peerId);
    if (!people) return { error: 'call_not_allowed' };
    if (this.#closed || !this.#alive(connection) || selfSequence !== connection.user.snapshotSequence ||
      this.#registry.user(peerId) !== peer || peerSequence !== peer?.snapshotSequence) return { error: 'unavailable' };
    if (!connection.user.conversations.has(conversationId) || this.#registry.isBlockedPair(connection.actor.userId, peerId)) return { error: 'call_not_allowed' };
    if (requirePeer && !this.#online(peerId, conversationId)) return { error: 'recipient_unavailable' };
    return { people, current: () => !this.#closed && this.#alive(connection) && selfSequence === connection.user.snapshotSequence &&
      this.#registry.user(peerId) === peer && peerSequence === peer?.snapshotSequence && connection.user.conversations.has(conversationId) &&
      !this.#registry.isBlockedPair(connection.actor.userId, peerId) && (!requirePeer || this.#online(peerId, conversationId)) };
  }
  #broadcast(call: CallSnapshot): void {
    for (const id of [call.caller.userId, call.recipient.userId]) {
      for (const connection of this.#registry.user(id)?.connections ?? []) {
        if (this.#eligible(connection, call)) connection.socket.emit(CALL_SERVER_EVENTS.state, call);
      }
    }
  }
  #schedule(record: CallRecord, delay: number, operation: () => void): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => { record.timer = null; if (!this.#closed) operation(); }, delay);
    record.timer.unref();
  }
  #finish(record: CallRecord, status: 'declined' | 'cancelled' | 'missed' | 'ended', reason: CallEndReason): void {
    if (terminal(record.snapshot.status)) return;
    const now = this.#clock.nowIso();
    record.snapshot = Object.freeze({ ...record.snapshot, status, reason, endedAt: now, updatedAt: now, revision: record.snapshot.revision + 1 });
    for (const id of [record.snapshot.caller.userId, record.snapshot.recipient.userId]) {
      if (this.#active.get(id) === record.snapshot.callId) this.#active.delete(id);
    }
    this.#schedule(record, this.#options!.terminalTtlMs, () => this.#forget(record));
    if (this.#options?.media) void Promise.resolve().then(() => this.#options!.media!.finish(record.snapshot.callId)).catch(() => {});
    if (reason === 'access_revoked') {
      // Clear an already-known call without disclosing fresh peer metadata after access changes.
      for (const id of [record.snapshot.caller.userId, record.snapshot.recipient.userId]) {
        for (const connection of this.#registry.user(id)?.connections ?? []) if (this.#alive(connection)) {
          connection.socket.emit(CALL_SERVER_EVENTS.cleared, { callId: record.snapshot.callId, revision: record.snapshot.revision, status: 'ended', reason });
        }
      }
    } else this.#broadcast(record.snapshot);
  }
  #forget(record: CallRecord): void {
    const call = record.snapshot;
    if (record.timer) clearTimeout(record.timer);
    this.#records.delete(call.callId); this.#requests.delete(record.requestKey);
    for (const id of [call.caller.userId, call.recipient.userId]) {
      const calls = this.#byUser.get(id); calls?.delete(call.callId); if (calls?.size === 0) this.#byUser.delete(id);
    }
  }
  #expireIfDue(record: CallRecord): void {
    if (record.snapshot.status === 'ringing' && Date.parse(record.snapshot.ringExpiresAt) <= this.#clock.nowMs()) this.#finish(record, 'missed', 'unanswered');
    else if (record.snapshot.status === 'accepted' && Date.parse(record.snapshot.acceptedAt!) + this.#options!.maxAcceptedMs <= this.#clock.nowMs()) this.#finish(record, 'ended', 'duration_limit');
  }
  async initiate(connection: Connection, body: InitiateCallBody, raw: unknown): Promise<CallAck> {
    if (!this.enabled || this.#closed) return callError('unavailable');
    const key = JSON.stringify([connection.actor.userId, body.requestId]);
    const fingerprint = JSON.stringify([body.conversationId, body.recipientId, body.kind]);
    const lookup = () => this.#records.get(this.#requests.get(key) ?? '');
    const previous = lookup();
    if (previous && previous.fingerprint !== fingerprint) return callError('idempotency_conflict');
    const access = await this.#authorize(connection, CALL_CLIENT_EVENTS.initiate, raw, body.conversationId, body.recipientId, !previous || !terminal(previous.snapshot.status));
    if ('error' in access) return callError(access.error);
    if (!access.current()) return callError('unavailable');
    // No awaits below: conflicts, duplicate requests and cross-calls commit atomically in this process.
    const existing = lookup();
    if (existing) {
      if (existing.fingerprint !== fingerprint) return callError('idempotency_conflict');
      this.#expireIfDue(existing); return { status: 'ok', call: existing.snapshot };
    }
    if (this.#active.has(connection.actor.userId) || this.#active.has(body.recipientId)) return callError('call_busy');
    if (this.#records.size >= this.#options!.maxCalls) return callError('unavailable');
    const now = this.#clock.nowMs();
    const call: CallSnapshot = Object.freeze({ callId: randomUUID(), conversationId: body.conversationId,
      caller: Object.freeze({ userId: connection.actor.userId, displayName: connection.actor.displayName }),
      recipient: access.people.find(person => person.userId === body.recipientId)!, kind: body.kind, status: 'ringing', revision: 1,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), ringExpiresAt: new Date(now + this.#options!.ringTimeoutMs).toISOString(),
      acceptedAt: null, endedAt: null, reason: null });
    const record: CallRecord = { snapshot: call, requestKey: key, fingerprint, timer: null,
      mediaSessions: new Map([[connection.actor.userId, connection.actor.sessionId]]), callerConnectionId: connection.id,
      recipientConnectionId: null, mediaConnections: new Set() };
    this.#records.set(call.callId, record); this.#requests.set(key, call.callId);
    for (const id of [call.caller.userId, call.recipient.userId]) {
      this.#active.set(id, call.callId); const calls = this.#byUser.get(id) ?? new Set<string>(); calls.add(call.callId); this.#byUser.set(id, calls);
    }
    this.#schedule(record, this.#options!.ringTimeoutMs, () => this.#finish(record, 'missed', 'unanswered'));
    this.#broadcast(call);
    return { status: 'ok', call };
  }
  async action(connection: Connection, event: Exclude<CallClientEventName, 'call:initiate' | 'call:sync'>, callId: string, raw: unknown): Promise<CallAck> {
    if (!this.enabled || this.#closed) return callError('unavailable');
    const record = this.#records.get(callId), id = connection.actor.userId;
    if (!record || (record.snapshot.caller.userId !== id && record.snapshot.recipient.userId !== id)) return callError('call_not_found');
    const isCaller = record.snapshot.caller.userId === id;
    if ((event === CALL_CLIENT_EVENTS.accept || event === CALL_CLIENT_EVENTS.decline) && isCaller || event === CALL_CLIENT_EVENTS.cancel && !isCaller) return callError('call_not_allowed');
    const other = isCaller ? record.snapshot.recipient.userId : record.snapshot.caller.userId;
    const access = await this.#authorize(connection, event, raw, record.snapshot.conversationId, other, !terminal(record.snapshot.status));
    if ('error' in access) return callError(access.error);
    if (!access.current()) return callError('unavailable');
    if (this.#records.get(callId) !== record) return callError('call_not_found');
    this.#expireIfDue(record);
    const state = record.snapshot.status;
    if (event === CALL_CLIENT_EVENTS.accept) {
      if (state === 'accepted') return { status: 'ok', call: record.snapshot };
      if (state !== 'ringing') return callError('invalid_call_state');
      record.mediaSessions.set(id, connection.actor.sessionId); record.recipientConnectionId = connection.id;
      const now = this.#clock.nowIso();
      record.snapshot = Object.freeze({ ...record.snapshot, status: 'accepted', acceptedAt: now, updatedAt: now, revision: record.snapshot.revision + 1 });
      this.#schedule(record, this.#options!.maxAcceptedMs, () => this.#finish(record, 'ended', 'duration_limit'));
      this.#broadcast(record.snapshot);
    } else {
      const target = event === CALL_CLIENT_EVENTS.decline ? 'declined' : event === CALL_CLIENT_EVENTS.cancel ? 'cancelled' : 'ended';
      if (state === target) return { status: 'ok', call: record.snapshot };
      if ((target === 'ended' ? state !== 'accepted' : state !== 'ringing')) return callError('invalid_call_state');
      this.#finish(record, target, target);
    }
    return { status: 'ok', call: record.snapshot };
  }
  async sync(connection: Connection, raw: unknown): Promise<CallSyncAck> {
    if (!this.enabled || this.#closed) return callError('unavailable');
    const [policy, fresh] = await Promise.all([this.#gate.evaluate(connection, CALL_CLIENT_EVENTS.sync, raw), this.#refresh(connection.actor.userId)]);
    if (policy !== 'allow') return callError(policy === 'deny' ? 'policy_denied' : 'unavailable');
    if (!fresh || this.#closed || !this.#alive(connection)) return callError('unavailable');
    const calls: CallSnapshot[] = [];
    for (const id of this.#byUser.get(connection.actor.userId) ?? []) {
      const record = this.#records.get(id); if (!record) continue;
      this.#expireIfDue(record);
      if (this.#eligible(connection, record.snapshot)) calls.push(record.snapshot);
    }
    // Newest first; active records always precede terminal history. Omitted history is ephemeral.
    calls.sort((a, b) => Number(terminal(a.status)) - Number(terminal(b.status)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { status: 'ok', calls: calls.slice(0, 20) };
  }
  recheckUser(userId: string): void {
    // Called by the existing membership/block lifecycle.
    const record = this.#records.get(this.#active.get(userId) ?? '');
    if (!record) return;
    const call = record.snapshot;
    if (this.#registry.isBlockedPair(call.caller.userId, call.recipient.userId) ||
      !this.#registry.user(userId)?.conversations.has(call.conversationId)) this.#finish(record, 'ended', 'access_revoked');
  }
  /** Only an accepted call and its live authenticated signaling session may obtain media. */
  async authorizeMedia(actor: RealtimeActor, callId: string, connectionId: string): Promise<DirectCallMediaAuthorization> {
    if (!this.enabled || this.#closed || !this.#options?.media) return null;
    const record = this.#records.get(callId);
    const connection = this.#registry.connection(connectionId);
    if (!record || !connection || connection.actor.sessionId !== actor.sessionId || connection.actor.userId !== actor.userId || !this.#alive(connection) || record.snapshot.status !== 'accepted') return null;
    const call = record.snapshot;
    if (actor.userId !== call.caller.userId && actor.userId !== call.recipient.userId) return null;
    const peer = actor.userId === call.caller.userId ? call.recipient.userId : call.caller.userId;
    const access = await this.#authorize(connection, 'call:media', { callId }, call.conversationId, peer, true);
    if ('error' in access || !access.current()) return null;
    this.#expireIfDue(record);
    if (record.snapshot.status !== 'accepted') return null;
    const claimed = record.mediaSessions.get(actor.userId);
    const endpoint = actor.userId === call.caller.userId ? record.callerConnectionId : record.recipientConnectionId;
    if (claimed !== actor.sessionId || endpoint !== connection.id) return { status: 'media_in_use' };
    record.mediaConnections.add(connection.id);
    const current = () => !this.#closed && this.#records.get(callId) === record && record.snapshot.status === 'accepted' &&
      this.#eligible(connection, record.snapshot) && this.#online(peer, call.conversationId) && record.mediaSessions.get(actor.userId) === actor.sessionId;
    const prepared = await callAdapter(() => this.#options!.media!.prepare(callId), this.#config.timing.adapterTimeoutMs);
    if (!prepared.ok || !current()) {
      if (record.snapshot.status !== 'accepted') void Promise.resolve().then(() => this.#options!.media!.finish(callId)).catch(() => {});
      if (!prepared.ok && current()) return { status: 'media_unavailable' };
      return null;
    }
    return { call: record.snapshot, current };
  }
  connectionClosed(connection: Connection): void {
    const record = this.#records.get(this.#active.get(connection.actor.userId) ?? '');
    if (!record || !record.mediaConnections.has(connection.id) && this.#online(connection.actor.userId, record.snapshot.conversationId)) return;
    const status = record.snapshot.status === 'ringing' ? connection.actor.userId === record.snapshot.caller.userId ? 'cancelled' : 'missed' : 'ended';
    this.#finish(record, status, 'disconnected');
  }
  close(): void {
    this.#closed = true;
    for (const record of this.#records.values()) {
      if (!terminal(record.snapshot.status)) this.#finish(record, 'ended', 'server_shutdown');
      if (record.timer) clearTimeout(record.timer);
    }
    this.#records.clear(); this.#requests.clear(); this.#active.clear(); this.#byUser.clear(); this.#accessLoads.clear();
  }
}
