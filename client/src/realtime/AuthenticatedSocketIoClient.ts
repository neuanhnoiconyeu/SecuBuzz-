import { io } from 'socket.io-client';
import { ApiError, type SessionApi } from '@/api/sessionApi';
import type { DirectConversation, EnvelopeV2 } from '@/security/e2ee/model';
import { exact, parseEnvelope } from '@/security/e2ee/protocol';
import type { PersistenceAck } from '@/security/e2ee/session';
import type { SocketPort } from './SocketIoRealtimeClient';
import {CALL_CLIENT_EVENT_NAMES,CALL_SERVER_EVENTS} from '../../../shared/directCalls';
import {parseCallSnapshot,parseCallCleared,type CallSignalingPort} from '@/calls/callSignaling';
import type {RealtimeEvent,RealtimeConnectionStatus} from './realtimeModel';
import { BUZZ_SEND_EVENT, BUZZ_RECEIVED_EVENT, type BuzzEvent } from '../../../shared/buzz';
import { buzzEvent } from './authenticatedProtocol';
import { errorAck, incomingEnvelope, keysChanged, messageDeleted, pinsChanged, persistenceAck, presenceUpdate, receipt, SocketFailure, typingUpdate,
  type KeysChanged, type PresenceUpdate, type Receipt, type TypingUpdate } from './authenticatedProtocol';

export type LiveConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'auth_failed';
export interface AuthenticatedSocketOptions {
  autoConnect: false; forceNew: true; multiplex: false; withCredentials: true; reconnection: false;
  retries: 0; path: '/socket.io'; addTrailingSlash: false; transports: ['websocket', 'polling']; tryAllTransports: true; timeout: number;
  auth: { csrfToken: string };
}
export interface LiveHandlers {
  buzz?(event: BuzzEvent): void;
  connection(state: LiveConnection): void;
  message(envelope: EnvelopeV2): Promise<boolean>;
  keys(event: KeysChanged): void;
  receipt(event: Receipt): void;
  typing(event: TypingUpdate): void;
  presence(event: PresenceUpdate): void;
  updated(conversationId: string): void;
  deleted?(event: { conversationId: string; messageId: string }): void;
  edited?(event:{conversationId:string;messageId:string}):void;
  pins?(event: { conversationId: string }): void;
  reactions?(event: { conversationId: string; messageId: string }): void;
}
type Factory = (url: string, options: AuthenticatedSocketOptions) => SocketPort;
const defaultFactory: Factory = (url, options) => io(url, options) as unknown as SocketPort;
const ACK_TIMEOUT = 10_000;
const MAX_ATTEMPTS = 6;

/** Real-account v2 adapter. Every attempt uses a new manager and fresh scoped CSRF proof.
 * No Socket.IO offline buffer, automatic message retries, client room joins or identity claims. */
export class AuthenticatedSocketIoClient {
  readonly mode='realtime' as const;
  get actorId(){return this.api.actor.id;}
  private readonly callListeners=new Set<(event:'state'|'cleared',value:unknown)=>void>();
  private readonly statusListeners=new Set<(event:RealtimeEvent)=>void>();
  getStatus=():RealtimeConnectionStatus=>this.state==='offline'?'disconnected':this.state==='auth_failed'?'error':this.state;
  subscribe=(listener:(event:RealtimeEvent)=>void)=>{if(this.disposed)return()=>{};this.statusListeners.add(listener);return()=>{this.statusListeners.delete(listener);};};
  readonly calls:CallSignalingPort={
    getConnectionId:()=>this.connected?this.socket?.id??null:null,
    request:(event,body)=>{
      if(!CALL_CLIENT_EVENT_NAMES.has(event)||this.pending.size>=20)return Promise.reject(new SocketFailure('unavailable'));
      return this.operation(event,body,value=>value);
    },
    subscribe:listener=>{if(this.disposed)return()=>{};this.callListeners.add(listener);return()=>{this.callListeners.delete(listener);};},
  };
  private socket: SocketPort | undefined;
  private disposed = false;
  private generation = 0;
  private attempts = 0;
  private unauthorizedRetry = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private scopes = new Map<string, Set<string>>();
  private peers = new Set<string>();
  private buzzSeen = new Set<string>();
  private pending = new Set<() => void>();
  private bindings: Array<[string, (...args: unknown[]) => void]> = [];
  private typingAt = new Map<string, number>();
  private retryNotBefore = 0;
  state: LiveConnection = 'offline';
  constructor(readonly api: SessionApi, private readonly handlers: LiveHandlers,
    private readonly origin: string, private readonly factory: Factory = defaultFactory) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' &&
      !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new ApiError('unavailable');
  }
  get connected(): boolean { return !this.disposed && this.state === 'connected' && this.socket?.connected === true; }
  private setState(state: LiveConnection) { this.state = state; if (!this.disposed) {
    this.handlers.connection(state);for(const listener of this.statusListeners){try{listener({type:'connection',status:this.getStatus()});}catch{/* Isolate call consumers. */}}
  } }
  setScopes(conversations: readonly DirectConversation[]): void {
    const previous = this.scopes;
    this.scopes = new Map(conversations.filter(c => c.interactionAllowed && c.participants.some(p => p.id === this.api.actor.id))
      .map(c => [c.id, new Set(c.participants.map(p => p.id))]));
    for (const id of previous.keys()) if (!this.scopes.has(id)) this.stopTyping(id);
    this.peers = new Set([...this.scopes.values()].flatMap(ids => [...ids].filter(id => id !== this.api.actor.id)));
    this.subscribePresence();
  }
  private allowed(cid: string, user?: string): boolean { return this.scopes.has(cid) && (user === undefined || this.scopes.get(cid)!.has(user)); }
  private subscribePresence() {
    if (this.connected) this.socket!.volatile.emit('presence:subscribe', { userIds: [...this.peers].slice(0, 200) });
  }
  private clearSocket() {
    if (this.deadline) clearTimeout(this.deadline); this.deadline = undefined;
    for (const cancel of this.pending) cancel(); this.pending.clear();
    if (this.socket) { for (const [event, fn] of this.bindings) this.socket.off(event, fn); this.socket.disconnect(); }
    this.bindings = []; this.socket = undefined; this.typingAt.clear();
  }
  private authFailure() {
    this.generation++; if (this.timer) clearTimeout(this.timer); this.clearSocket();
    this.setState('auth_failed'); this.api.invalidateSession?.();
  }
  start(): void { if (!this.disposed && this.state !== 'auth_failed' && !this.connected && !this.timer) void this.attempt(); }
  reconnect(): void {
    if (this.disposed || this.state === 'auth_failed' || this.connected || this.state === 'connecting' || this.state === 'reconnecting') return;
    this.attempts = 0; this.start();
  }
  refreshRooms(): void {
    if (this.disposed || this.state === 'auth_failed') return;
    this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.clearSocket(); this.attempts = 0; void this.attempt();
  }
  private schedule() {
    if (this.disposed || this.state === 'auth_failed' || this.timer) return;
    if (this.attempts >= MAX_ATTEMPTS) { this.setState('offline'); return; }
    this.setState('reconnecting');
    this.timer = setTimeout(() => { this.timer = undefined; void this.attempt(); }, Math.min(1000 * 2 ** Math.max(0, this.attempts - 1), 15000));
  }
  private async attempt() {
    if (this.disposed) return;
    this.clearSocket(); const version = ++this.generation; this.attempts++;
    this.setState(this.attempts === 1 ? 'connecting' : 'reconnecting');
    try {
      if (!this.api.realtimeAuth) throw new ApiError('csrf_invalid');
      const rawProof = await this.api.realtimeAuth();
      let proof: Record<string, unknown>;
      try { proof = exact(rawProof, ['csrfToken']); } catch { throw new ApiError('csrf_invalid'); }
      if (typeof proof.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof.csrfToken)) throw new ApiError('csrf_invalid');
      if (this.disposed || version !== this.generation) return;
      const socket = this.factory(this.origin, { autoConnect: false, forceNew: true, multiplex: false,
        withCredentials: true, reconnection: false, retries: 0, path: '/socket.io', addTrailingSlash: false, transports: ['websocket', 'polling'],
        tryAllTransports: true, timeout: 10000, auth: { csrfToken: proof.csrfToken } });
      this.socket = socket;
      const bind = (event: string, fn: (...args: unknown[]) => void) => {
        const guarded = (...args: unknown[]) => { if (!this.disposed && version === this.generation) fn(...args); };
        socket.on(event, guarded); this.bindings.push([event, guarded]);
      };
      bind('connect', () => { if (this.deadline) clearTimeout(this.deadline); this.deadline = undefined;
        this.attempts = 0; this.unauthorizedRetry = false; this.setState('connected'); this.subscribePresence(); });
      bind('disconnect', () => { this.clearSocket(); this.schedule(); });
      bind('connect_error', e => {
        const code = e && typeof e === 'object' && 'data' in e && e.data && typeof e.data === 'object' && 'code' in e.data ? e.data.code : undefined;
        this.clearSocket();
        if (code === 'UNAUTHORIZED' && !this.unauthorizedRetry) { this.unauthorizedRetry = true; this.schedule(); }
        else if (['AUTH_REQUIRED', 'UNAUTHORIZED', 'SESSION_EXPIRED'].includes(code as string)) this.authFailure();
        else this.schedule();
      });
      const validated = <T,>(event: string, parse: (value: unknown) => T, accept: (event: T) => void) =>
        bind(event, input => { if (!this.connected) return; try { accept(parse(input)); } catch { /* Reject malformed, unsolicited data without reflecting it in logs. */ } });
      bind('message:new', (input, acknowledge) => {
        if (!this.connected) return;
        let envelope: EnvelopeV2;
        try { envelope = incomingEnvelope(input); if (!this.allowed(envelope.conversationId, envelope.senderId)) return; } catch { return; }
        void this.handlers.message(envelope).then(accepted => {
          if (accepted && this.connected && version === this.generation && this.allowed(envelope.conversationId, envelope.senderId) &&
            envelope.senderId !== this.api.actor.id && typeof acknowledge === 'function') {
            acknowledge({ conversationId: envelope.conversationId, messageId: envelope.id, status: 'delivered' });
          }
        }).catch(() => { /* No delivery claim after a failed decrypt or authorization check. */ });
      });
      validated('conversation:keys-changed', keysChanged, e => { if (this.allowed(e.conversationId)) this.handlers.keys(e); });
      for(const event of ['state','cleared'] as const)bind(CALL_SERVER_EVENTS[event],value=>{
        if(!this.connected)return;const parsed=event==='state'?parseCallSnapshot(value,this.api.actor.id):parseCallCleared(value);if(!parsed)return;
        for(const listener of this.callListeners){try{listener(event,parsed);}catch{/* Isolate consumers. */}}
      });
      validated('message:deleted', messageDeleted, e => { if (this.allowed(e.conversationId)) this.handlers.deleted?.(e); });
      validated('message:edited',messageDeleted,e=>{if(this.allowed(e.conversationId))this.handlers.edited?.(e);});
      validated('conversation:pins-changed', pinsChanged, e => { if (this.allowed(e.conversationId)) this.handlers.pins?.(e); });
      validated('message:reactions-changed', messageDeleted, e => { if (this.allowed(e.conversationId)) this.handlers.reactions?.(e); });
      validated('typing:update', typingUpdate, e => { if (e.userId !== this.api.actor.id && this.allowed(e.conversationId, e.userId)) this.handlers.typing(e); });
      validated(BUZZ_RECEIVED_EVENT, buzzEvent, e => {
        if (e.userId === this.api.actor.id || !this.allowed(e.conversationId, e.userId) || this.buzzSeen.has(e.id) || Math.abs(Date.now() - Date.parse(e.timestamp)) > 30_000) return;
        this.buzzSeen.add(e.id); if (this.buzzSeen.size > 100) this.buzzSeen.delete(this.buzzSeen.values().next().value!);
        this.handlers.buzz?.(e);
      });
      validated('presence:update', presenceUpdate, e => { if (this.peers.has(e.userId)) this.handlers.presence(e); });
      for (const status of ['delivered', 'read'] as const) validated('message:' + status, r => receipt(r, status), e => {
        if (e.userId !== this.api.actor.id && this.allowed(e.conversationId, e.userId)) this.handlers.receipt(e);
      });
      validated('conversation:updated', input => {
        if (!input || typeof input !== 'object') throw new Error();
        const r = input as Record<string, unknown>;
        exact(r, r.displayName === undefined ? ['conversationId', 'updatedAt'] : ['conversationId', 'displayName', 'updatedAt']);
        if (typeof r.conversationId !== 'string') throw new Error(); return r.conversationId;
      }, cid => { if (this.allowed(cid)) this.handlers.updated(cid); });
      this.deadline = setTimeout(() => { if (version !== this.generation || this.connected) return; this.clearSocket(); this.schedule(); }, 20000);
      socket.connect();
    } catch (e) {
      if (this.disposed || version !== this.generation) return;
      if (e instanceof ApiError && ['unauthorized', 'cancelled', 'csrf_invalid'].includes(e.code)) this.authFailure(); else this.schedule();
    }
  }
  private operation<T>(event: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
    if (!this.connected || Date.now() < this.retryNotBefore) return Promise.reject(new SocketFailure('unavailable'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value?: unknown, canceled = false) => {
        if (settled) return; settled = true; clearTimeout(timer); this.pending.delete(cancel);
        if (canceled) { reject(new SocketFailure('unavailable')); return; }
        try { resolve(parse(value)); } catch (e) {
          const failure = e instanceof SocketFailure ? e : new SocketFailure('unavailable');
          if (failure.code === 'rate_limited') this.retryNotBefore = Date.now() + 5000;
          if (failure.code === 'policy_denied') this.authFailure(); reject(failure);
        }
      };
      const cancel = () => finish(undefined, true), timer = setTimeout(cancel, ACK_TIMEOUT);
      this.pending.add(cancel);
      try { this.socket!.emit(event, body, value => finish(value)); } catch { cancel(); }
    });
  }
  send = (input: EnvelopeV2): Promise<PersistenceAck> => {
    let envelope: EnvelopeV2; try { envelope = parseEnvelope(input); } catch { return Promise.reject(new SocketFailure('invalid_payload')); }
    if (envelope.senderId !== this.api.actor.id) return Promise.reject(new SocketFailure('actor_mismatch'));
    if (!this.allowed(envelope.conversationId)) return Promise.reject(new SocketFailure('unauthorized_conversation'));
    return this.operation('message:send', envelope, value => persistenceAck(value, envelope));
  };
  read(cid: string, id: string): Promise<Receipt> {
    if (!this.allowed(cid)) return Promise.reject(new SocketFailure('unauthorized_conversation'));
    return this.operation('message:read', { conversationId: cid, messageId: id }, value => {
      errorAck(value); const r = receipt(value, 'read');
      if (r.conversationId !== cid || r.messageId !== id || r.userId !== this.api.actor.id) throw new SocketFailure('unavailable'); return r;
    });
  }
  buzz(cid: string): Promise<BuzzEvent> {
    if (!this.allowed(cid)) return Promise.reject(new SocketFailure('unauthorized_conversation'));
    return this.operation(BUZZ_SEND_EVENT, { conversationId: cid }, value => {
      errorAck(value); const event = buzzEvent(value);
      if (event.conversationId !== cid || event.userId !== this.api.actor.id) throw new SocketFailure('unavailable');
      return event;
    });
  }
  typing(cid: string): void {
    if (!this.connected || !this.allowed(cid)) return;
    const prior = this.typingAt.get(cid);
    if (prior === undefined || Date.now() - prior >= 1500) { this.typingAt.set(cid, Date.now()); this.socket!.volatile.emit('typing:start', { conversationId: cid }); }
  }
  stopTyping(cid: string): void {
    if (this.typingAt.has(cid) && this.connected) this.socket!.volatile.emit('typing:stop', { conversationId: cid });
    this.typingAt.delete(cid);
  }
  dispose(): void {
    if (this.disposed) return;
    for (const cid of this.typingAt.keys()) this.stopTyping(cid);
    this.disposed = true; this.generation++; if (this.timer) clearTimeout(this.timer); this.clearSocket();
    this.scopes.clear(); this.peers.clear();
    this.buzzSeen.clear();
    this.callListeners.clear();this.statusListeners.clear();
  }
}
