import { io } from 'socket.io-client';
import type { AuthUser } from '@/auth/authModel';
import type { EncryptedIncomingMessage, OutboundMessage } from '@/messaging/messageModel';
import {
  PROPOSED_EVENT_NAMES, RealtimeOperationError,
  type RealtimeClient, type RealtimeConnectionStatus, type RealtimeEvent, type RealtimeErrorCode,
  type SendAcknowledgement, type ConversationParticipantScope,
} from './realtimeModel';
import { isIdentifier, parseConnectionError, parseErrorAcknowledgement, parseReadAcknowledgement, parseRealtimeEvent } from './realtimeValidation';
import { DeliveryConfirmations, type DeliveryConfirmationVerifier } from './deliveryConfirmations';

export { PROPOSED_EVENT_NAMES } from './realtimeModel';

type SocketListener = (...args: unknown[]) => void;
export interface SocketManagerPort {
  on(event: string, listener: SocketListener): unknown;
  off(event: string, listener: SocketListener): unknown;
  reconnection(enabled: boolean): unknown;
}

/** Small Socket.IO boundary so client lifecycle tests need no server or browser socket. */
export interface SocketPort {
  readonly connected: boolean;
  readonly active?: boolean;
  readonly io: SocketManagerPort;
  readonly volatile: { emit(event: string, payload: unknown): unknown };
  on(event: string, listener: SocketListener): unknown;
  off(event: string, listener: SocketListener): unknown;
  connect(): unknown;
  disconnect(): unknown;
  emit(event: string, payload: unknown, acknowledge?: (payload: unknown) => void): unknown;
}

export interface SocketClientOptions {
  autoConnect: false;
  forceNew: true;
  multiplex: false;
  withCredentials: true;
  path: string;
  transports: ('websocket' | 'polling')[];
  timeout: number;
  reconnection: true;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
  retries: 0;
}

export type SocketFactory = (url: string, options: SocketClientOptions) => SocketPort;
export type RealtimeEventNameMapping = { [Key in keyof typeof PROPOSED_EVENT_NAMES]: string };
export interface SocketIoRealtimeClientOptions {
  user: AuthUser;
  authMode: 'api' | 'demo' | 'unconfigured';
  contractReady: boolean;
  url: string;
  path?: string;
  eventNames?: Partial<RealtimeEventNameMapping>;
  socketFactory?: SocketFactory;
  /** Omitted by the production factory until authenticated recipient key distribution exists. */
  deliveryConfirmationVerifier?: DeliveryConfirmationVerifier;
}

const MAX_WATCHED = 1_000;
const MAX_CACHE = 1_000;
const MAX_PENDING_READS = 100;
const ACK_TIMEOUT = 5_000;
const CONNECT_DEADLINE = 90_000;
const defaultSocketFactory: SocketFactory = (url, options) => io(url, options) as unknown as SocketPort;
const reservedEvents = new Set(['connect', 'disconnect', 'connect_error', 'reconnect_attempt', 'reconnect_failed', 'reconnect_error']);

function validateOptions(options: SocketIoRealtimeClientOptions): { url: string; path: string; names: RealtimeEventNameMapping } {
  if (!options || options.authMode !== 'api' || options.contractReady !== true || options.user?.isDemo !== false ||
    !isIdentifier(options.user.id) || options.user.id === 'local-user' || /^demo[-_:]/i.test(options.user.id)) {
    throw new RealtimeOperationError('unavailable');
  }
  let url: URL;
  try {
    if (typeof options.url !== 'string' || options.url !== options.url.trim() || /[\\\u0000-\u0020\u007f]/u.test(options.url)) throw new Error();
    url = new URL(options.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && loopback))) throw new Error();
  } catch { throw new RealtimeOperationError('unavailable'); }
  const path = options.path ?? '/socket.io';
  if (typeof path !== 'string' || !/^\/(?!\/)[A-Za-z0-9/._-]+$/u.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')) throw new RealtimeOperationError('unavailable');
  const names = { ...PROPOSED_EVENT_NAMES, ...options.eventNames };
  if (!Object.values(names).every((name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9:._-]{0,79}$/u.test(name) && !reservedEvents.has(name))) {
    throw new RealtimeOperationError('unavailable');
  }
  const incoming = [names.messageNew, names.messageAck, names.messageDelivered, names.messageReadReceipt,
    names.typingUpdate, names.presenceUpdate, names.conversationUpdated];
  if (new Set(incoming).size !== incoming.length) throw new RealtimeOperationError('unavailable');
  return { url: url.href, path, names };
}

function watched(ids: readonly string[]): Set<string> {
  if (!Array.isArray(ids) || ids.length > MAX_WATCHED || !ids.every(isIdentifier)) throw new RealtimeOperationError('invalid_payload');
  return new Set(ids);
}

function boundedSet<Value>(map: Map<string, Value>, key: string, value: Value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHE) map.delete(map.keys().next().value as string);
}

interface PendingConnect {
  promise: Promise<void>;
  resolve(): void;
  reject(error: RealtimeOperationError): void;
  timer: ReturnType<typeof setTimeout>;
}
interface PendingRead {
  promise: Promise<void>;
  cancel(error: RealtimeOperationError): void;
}

/**
 * Cookie-session transport compatible with Phase 8.7B. Production adapters,
 * authorization, CORS and session integration remain prerequisites for readiness.
 * No recipient-authenticated envelope exists yet, so real message sending stays disabled.
 */
export class SocketIoRealtimeClient implements RealtimeClient {
  readonly mode = 'realtime' as const;
  readonly canSendMessages = false;
  readonly actorId: string;
  private readonly configuration: ReturnType<typeof validateOptions>;
  private readonly socketFactory: SocketFactory;
  private socket: SocketPort | null = null;
  private status: RealtimeConnectionStatus = 'disconnected';
  private disposed = false;
  private rejected = false;
  private generation = 0;
  private pendingConnect: PendingConnect | null = null;
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private readonly bindings: Array<{ port: Pick<SocketPort, 'off'>; event: string; listener: SocketListener }> = [];
  private conversations = new Set<string>();
  private publicUsers = new Set<string>();
  private readonly pendingReads = new Map<string, PendingRead>();
  private readonly seen = new Map<string, true>();
  private readonly metadataTimes = new Map<string, number>();
  private readonly typingSent = new Map<string, { isTyping: boolean; at: number }>();
  private malformedReported = false;
  private readonly delivery: DeliveryConfirmations;
  private participants = new Map<string, Set<string>>();
  private rejection: RealtimeOperationError | null = null;

  constructor(options: SocketIoRealtimeClientOptions) {
    this.configuration = validateOptions(options);
    this.actorId = options.user.id;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.delivery = new DeliveryConfirmations(this.actorId, options.deliveryConfirmationVerifier, (message) =>
      !this.disposed && !this.rejected && this.status === 'connected' && this.socket?.connected === true &&
      this.conversations.has(message.conversationId) && message.senderId !== this.actorId &&
      this.participants.get(message.conversationId)?.has(message.senderId) === true);
  }

  get canConfirmDelivery() { return this.delivery.enabled; }

  getStatus(): RealtimeConnectionStatus { return this.status; }

  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(event: RealtimeEvent) {
    for (const listener of Array.from(this.listeners)) {
      if (!this.listeners.has(listener)) continue;
      try { listener(event); } catch { /* One consumer cannot interrupt other subscribers. */ }
    }
  }

  private setStatus(status: RealtimeConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.publish({ type: 'connection', status });
  }

  private error(code: RealtimeErrorCode) { this.publish({ type: 'error', code }); }

  private settleConnect(error?: RealtimeOperationError) {
    const pending = this.pendingConnect;
    this.pendingConnect = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private cancelReads(code: RealtimeErrorCode) {
    for (const request of Array.from(this.pendingReads.values())) request.cancel(new RealtimeOperationError(code));
    this.pendingReads.clear();
  }

  private attach(socket: SocketPort) {
    if (this.bindings.length) return;
    const generation = this.generation;
    const active = () => !this.disposed && !this.rejected && generation === this.generation;
    const bind = (port: SocketPort | SocketManagerPort, event: string, handle: SocketListener) => {
      const listener: SocketListener = (...args) => { if (active()) handle(...args); };
      port.on(event, listener);
      this.bindings.push({ port, event, listener });
    };
    bind(socket, 'connect', () => {
      if (!socket.connected) return;
      this.malformedReported = false;
      this.setStatus('connected');
      this.settleConnect();
      this.subscribePresence();
    });
    bind(socket, 'disconnect', (reason) => {
      this.cancelReads('disconnected');
      this.delivery.clear('disconnected');
      this.typingSent.clear();
      const terminal = reason === 'io server disconnect' || socket.active === false;
      this.setStatus(terminal ? 'disconnected' : 'reconnecting');
      if (terminal) this.settleConnect(new RealtimeOperationError('disconnected'));
    });
    bind(socket, 'connect_error', (failure) => {
      const error = parseConnectionError(failure);
      if (error.code === 'authentication_rejected') {
        this.rejected = true;
        this.rejection = error;
        this.stop(error.code, 'error', error);
      } else {
        this.setStatus(socket.active === false ? 'error' : 'reconnecting');
        if (socket.active === false) this.settleConnect(error);
      }
      this.publish({ type: 'error', code: error.code, ...(error.serverCode ? { serverCode: error.serverCode } : {}) });
    });
    bind(socket.io, 'reconnect_attempt', () => this.setStatus('reconnecting'));
    bind(socket.io, 'reconnect_error', () => this.setStatus('reconnecting'));
    bind(socket.io, 'reconnect_failed', () => {
      socket.io.reconnection(false);
      this.cancelReads('disconnected');
      this.delivery.clear('disconnected');
      this.setStatus('error');
      this.settleConnect(new RealtimeOperationError('unavailable'));
      this.error('unavailable');
    });
    const names = this.configuration.names;
    bind(socket, names.messageNew, (payload, acknowledge) => this.receive('message', payload, undefined, acknowledge));
    // No outgoing IDs can be acknowledged while message sending is disabled.
    bind(socket, names.messageAck, () => undefined);
    bind(socket, names.messageDelivered, (payload) => this.receive('receipt', payload, 'delivered'));
    bind(socket, names.messageReadReceipt, (payload) => this.receive('receipt', payload, 'read'));
    bind(socket, names.typingUpdate, (payload) => this.receive('typing', payload));
    bind(socket, names.presenceUpdate, (payload) => this.receive('presence', payload));
    bind(socket, names.conversationUpdated, (payload) => this.receive('conversation', payload));
  }

  private receive(kind: RealtimeEvent['type'], payload: unknown, expectedReceipt?: 'delivered' | 'read', acknowledge?: unknown) {
    if (this.status !== 'connected' || !this.socket?.connected) return;
    let event: RealtimeEvent | null;
    try { event = parseRealtimeEvent(kind, payload, 'realtime'); } catch { event = null; }
    if (!event) {
      if (!this.malformedReported) { this.malformedReported = true; this.error('invalid_payload'); }
      return;
    }
    const conversationId = event.type === 'message' ? event.message.conversationId :
      'conversationId' in event ? event.conversationId : undefined;
    if (conversationId !== undefined && !this.conversations.has(conversationId)) return;
    // Typing is scoped to a watched conversation, not the separate Friends
    // presence subscription. The conversation bridge validates membership.
    if (event.type === 'typing' && event.userId === this.actorId) return;
    if (event.type === 'presence' && !this.publicUsers.has(event.userId)) return;
    if (event.type === 'receipt' && event.status !== expectedReceipt) return;
    if (event.type === 'presence' || event.type === 'typing' || event.type === 'conversation') {
      const key = event.type === 'typing' ? JSON.stringify([event.type, event.conversationId, event.userId]) :
        event.type === 'presence' ? JSON.stringify([event.type, event.userId]) : JSON.stringify([event.type, event.conversationId]);
      const timestamp = Date.parse(event.type === 'conversation' ? event.updatedAt : event.timestamp);
      // Reject clock-poisoning before storing an ordering watermark. Downstream
      // views may impose shorter freshness windows, but cannot repair this cache.
      if (timestamp > Date.now() + 60_000) return;
      const previous = this.metadataTimes.get(key);
      if (previous !== undefined && timestamp <= previous) return;
      boundedSet(this.metadataTimes, key, timestamp);
    }
    const key = event.type === 'message' ? JSON.stringify(['message', event.message.conversationId, event.message.id]) : JSON.stringify(event);
    if (this.seen.has(key)) return;
    boundedSet(this.seen, key, true);
    if (event.type === 'message' && 'encryption' in event.message) this.delivery.capture(event.message, acknowledge);
    this.publish(event);
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new RealtimeOperationError('session_ended'));
    if (this.rejected) return Promise.reject(this.rejection ?? new RealtimeOperationError('authentication_rejected'));
    if (this.status === 'connected' && this.socket?.connected) return Promise.resolve();
    if (this.pendingConnect) return this.pendingConnect.promise;
    try {
      if (!this.socket) this.socket = this.socketFactory(this.configuration.url, {
        autoConnect: false, forceNew: true, multiplex: false, withCredentials: true, path: this.configuration.path,
        transports: ['websocket', 'polling'], timeout: 10_000, reconnection: true,
        reconnectionAttempts: 5, reconnectionDelay: 500, reconnectionDelayMax: 4_000, retries: 0,
      });
      this.socket.io.reconnection(true);
      this.attach(this.socket);
    } catch {
      this.stop('unavailable', 'error');
      return Promise.reject(new RealtimeOperationError('unavailable'));
    }
    let resolve!: () => void;
    let reject!: (error: RealtimeOperationError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => { this.stop('unavailable', 'error'); this.error('unavailable'); }, CONNECT_DEADLINE);
    this.pendingConnect = { promise, resolve, reject, timer };
    this.setStatus('connecting');
    try { if (this.pendingConnect?.promise === promise) this.socket.connect(); }
    catch { this.stop('unavailable', 'error'); }
    return promise;
  }

  private stop(code: RealtimeErrorCode, status: RealtimeConnectionStatus, error = new RealtimeOperationError(code)) {
    this.generation += 1;
    for (const { port, event, listener } of this.bindings.splice(0)) port.off(event, listener);
    this.settleConnect(error);
    this.cancelReads(code);
    this.delivery.clear(code);
    this.typingSent.clear();
    this.metadataTimes.clear();
    this.seen.clear();
    this.socket?.io.reconnection(false);
    this.socket?.disconnect();
    this.setStatus(status);
  }

  disconnect(): void { this.stop('disconnected', 'disconnected'); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop('session_ended', 'disconnected');
    this.conversations.clear();
    this.publicUsers.clear();
    this.participants.clear();
    this.listeners.clear();
  }

  async sendMessage(_message: OutboundMessage): Promise<SendAcknowledgement> {
    throw new RealtimeOperationError('recipient_keys_unavailable');
  }

  watchConversations(ids: readonly string[]): void {
    if (this.disposed) return;
    this.conversations = watched(ids);
    for (const id of this.participants.keys()) if (!this.conversations.has(id)) this.participants.delete(id);
    this.delivery.prune();
    for (const id of this.typingSent.keys()) if (!this.conversations.has(id)) this.typingSent.delete(id);
    // An access-scope change must not leave pending metadata writes for removed conversations.
    for (const [key, request] of Array.from(this.pendingReads.entries())) {
      if (!this.conversations.has(JSON.parse(key)[0] as string)) request.cancel(new RealtimeOperationError('unauthorized_conversation'));
    }
  }

  watchConversationParticipants(scopes: readonly ConversationParticipantScope[]): void {
    if (this.disposed) return;
    if (!Array.isArray(scopes) || scopes.length > MAX_WATCHED) throw new RealtimeOperationError('invalid_payload');
    const next = new Map<string, Set<string>>();
    let count = 0;
    for (const scope of scopes) {
      if (!scope || !isIdentifier(scope.conversationId) || !this.conversations.has(scope.conversationId) || next.has(scope.conversationId)) {
        throw new RealtimeOperationError('invalid_payload');
      }
      const peers = watched(scope.participantIds);
      count += peers.size;
      if (count > 10_000) throw new RealtimeOperationError('invalid_payload');
      next.set(scope.conversationId, peers);
    }
    this.participants = next;
    this.delivery.prune();
  }

  confirmDelivery(untrusted: EncryptedIncomingMessage): Promise<void> {
    if (this.disposed) return Promise.reject(new RealtimeOperationError('session_ended'));
    if (this.rejected) return Promise.reject(this.rejection ?? new RealtimeOperationError('authentication_rejected'));
    if (this.status !== 'connected' || !this.socket?.connected) return Promise.reject(new RealtimeOperationError('disconnected'));
    const event = parseRealtimeEvent('message', untrusted, 'realtime');
    if (event?.type !== 'message' || !('encryption' in event.message)) return Promise.reject(new RealtimeOperationError('invalid_payload'));
    return this.delivery.confirm(event.message);
  }

  watchPresence(userIds: readonly string[]): void {
    if (this.disposed) return;
    this.publicUsers = watched(userIds);
    this.subscribePresence();
  }

  private subscribePresence() {
    if (this.disposed || this.rejected || this.status !== 'connected' || !this.socket?.connected) return;
    try { this.socket.emit(this.configuration.names.presenceSubscribe, { userIds: Array.from(this.publicUsers) }); }
    catch { this.error('unavailable'); }
  }

  sendTyping(conversationId: string, isTyping: boolean): void {
    if (this.disposed || this.rejected || this.status !== 'connected' || !this.socket?.connected ||
      !this.conversations.has(conversationId) || typeof isTyping !== 'boolean') return;
    const previous = this.typingSent.get(conversationId);
    const at = Date.now();
    if (previous && previous.isTyping === isTyping && (!isTyping || at - previous.at < 1_000)) return;
    if (!previous && !isTyping) return;
    boundedSet(this.typingSent, conversationId, { isTyping, at });
    try { this.socket.volatile.emit(isTyping ? this.configuration.names.typingStart : this.configuration.names.typingStop, { conversationId }); }
    catch { this.error('unavailable'); }
  }

  markRead(conversationId: string, messageId: string): Promise<void> {
    if (this.disposed) return Promise.reject(new RealtimeOperationError('session_ended'));
    if (this.rejected) return Promise.reject(this.rejection ?? new RealtimeOperationError('authentication_rejected'));
    if (!isIdentifier(conversationId) || !isIdentifier(messageId)) return Promise.reject(new RealtimeOperationError('invalid_payload'));
    if (!this.conversations.has(conversationId)) return Promise.reject(new RealtimeOperationError('unauthorized_conversation'));
    if (this.status !== 'connected' || !this.socket?.connected) return Promise.reject(new RealtimeOperationError('disconnected'));
    const key = JSON.stringify([conversationId, messageId]);
    const existing = this.pendingReads.get(key);
    if (existing) return existing.promise;
    if (this.pendingReads.size >= MAX_PENDING_READS) return Promise.reject(new RealtimeOperationError('unavailable'));
    const generation = this.generation;
    let resolve!: () => void;
    let reject!: (error: RealtimeOperationError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    let settled = false;
    const finish = (error?: RealtimeOperationError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.pendingReads.delete(key);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new RealtimeOperationError('ack_timeout')), ACK_TIMEOUT);
    this.pendingReads.set(key, { promise, cancel: finish });
    try {
      this.socket.emit(this.configuration.names.messageRead, { conversationId, messageId }, (payload) => {
        if (settled || this.disposed || generation !== this.generation) return;
        let valid = false;
        try {
          const error = parseErrorAcknowledgement(payload);
          if (error) { finish(error); return; }
          valid = parseReadAcknowledgement(payload, conversationId, messageId) &&
            (!payload || typeof payload !== 'object' || !('userId' in payload) || payload.userId === this.actorId);
        } catch { /* Reject unknown acknowledgements. */ }
        finish(valid ? undefined : new RealtimeOperationError('invalid_payload'));
      });
    } catch { finish(new RealtimeOperationError('send_failed')); }
    return promise;
  }
}
