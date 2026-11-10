import type { AuthUser } from '@/auth/authModel';
import type { Conversation, ConversationParticipant, ConversationType } from '@/conversations/conversationModel';
import type { OutboundMessage } from '@/messaging/messageModel';
import { DEMO_REALTIME_MESSAGE_TEXT, RealtimeOperationError, type RealtimeClient, type RealtimeConnectionStatus,
  type RealtimeEvent, type RealtimePresenceStatus, type SendAcknowledgement } from './realtimeModel';
import { isBoundedText, isIdentifier, parseOutboundMessage } from './realtimeValidation';

export interface MockRealtimeClientOptions {
  user: AuthUser;
  conversations: readonly Conversation[];
  ackDelayMs?: number;
  deliveryDelayMs?: number;
  readDelayMs?: number;
  /** Automatic replies are restricted to SecureBot; person/group activity requires an explicit simulation. */
  autoReply?: boolean;
}

interface DemoConversation { id: string; type: ConversationType; participants: ConversationParticipant[] }
interface PendingConnection {
  promise: Promise<void>;
  resolve(): void;
  reject(error: RealtimeOperationError): void;
}
interface SendRecord {
  fingerprint: string;
  promise: Promise<SendAcknowledgement>;
  resolve: ((acknowledgement: SendAcknowledgement) => void) | null;
  reject: ((error: RealtimeOperationError) => void) | null;
  acknowledgement: SendAcknowledgement | null;
}

const MAX_RECENT_MESSAGES = 2_000;
const MAX_RECENT_BYTES = 16 * 1024 * 1024;
const MAX_LISTENERS = 100;

function requireDevelopment(): void {
  if (process.env.NODE_ENV === 'production') throw new RealtimeOperationError('unavailable');
}

function delay(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.min(value, 30_000) : fallback;
}

/** Session-local simulation. No socket, API, storage, plaintext echo, or real user activity exists here. */
export class MockRealtimeClient implements RealtimeClient {
  readonly mode = 'local-demo' as const;
  readonly actorId: string;
  private readonly conversations = new Map<string, DemoConversation>();
  private readonly peerIds = new Set<string>();
  private watchedConversations = new Set<string>();
  private watchedPresence = new Set<string>();
  private readonly simulatedPresence = new Map<string, RealtimePresenceStatus>();
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sends = new Map<string, SendRecord>();
  private readonly incoming = new Map<string, string>();
  private recentBytes = 0;
  private status: RealtimeConnectionStatus = 'disconnected';
  private pendingConnection: PendingConnection | null = null;
  private disposed = false;
  private generation = 0;
  private messageSequence = 0;
  private failNext = false;
  private readonly ackDelay: number;
  private readonly deliveryDelay: number;
  private readonly readDelay: number;
  private readonly autoReply: boolean;

  constructor(options: MockRealtimeClientOptions) {
    requireDevelopment();
    if (!options.user?.isDemo || !isIdentifier(options.user.id) || !isBoundedText(options.user.displayName) || options.conversations.length > 500) {
      throw new RealtimeOperationError('authentication_rejected');
    }
    this.actorId = options.user.id;
    this.ackDelay = delay(options.ackDelayMs, 20);
    this.deliveryDelay = Math.max(this.ackDelay, delay(options.deliveryDelayMs, 100));
    this.readDelay = Math.max(this.deliveryDelay, delay(options.readDelayMs, 220));
    this.autoReply = options.autoReply !== false;
    for (const conversation of options.conversations) {
      if (!conversation.isDemo || !isIdentifier(conversation.id) || this.conversations.has(conversation.id) ||
        !['bot', 'direct', 'group'].includes(conversation.type) || !Array.isArray(conversation.participants) ||
        conversation.participants.length < 2 || conversation.participants.length > 100 ||
        !conversation.participants.some((participant) => participant.id === this.actorId) ||
        conversation.participants.some((participant) => !isIdentifier(participant.id) || !isBoundedText(participant.displayName) ||
          !['person', 'bot'].includes(participant.kind)) ||
        new Set(conversation.participants.map((participant) => participant.id)).size !== conversation.participants.length) {
        throw new RealtimeOperationError('unauthorized_conversation');
      }
      const projected = { id: conversation.id, type: conversation.type, participants: conversation.participants.map((participant) => ({
        id: participant.id, displayName: participant.displayName, kind: participant.kind,
      })) };
      this.conversations.set(projected.id, projected);
      for (const participant of projected.participants) if (participant.id !== this.actorId) this.peerIds.add(participant.id);
    }
    this.watchedConversations = new Set(this.conversations.keys());
  }

  get canSendMessages(): boolean { return !this.disposed && process.env.NODE_ENV !== 'production'; }

  private active(): void {
    requireDevelopment();
    if (this.disposed) throw new RealtimeOperationError('session_ended');
  }

  private connected(): void {
    this.active();
    if (this.status !== 'connected') throw new RealtimeOperationError('disconnected', true);
  }

  private conversation(id: string): DemoConversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new RealtimeOperationError('unauthorized_conversation');
    return conversation;
  }

  private emit(event: RealtimeEvent): void {
    if (this.disposed || process.env.NODE_ENV === 'production') return;
    for (const listener of Array.from(this.listeners)) {
      if (this.disposed) break;
      if (!this.listeners.has(listener)) continue;
      try {
        // Every consumer gets a detached projection; one view cannot mutate another view's event.
        listener(JSON.parse(JSON.stringify(event)) as RealtimeEvent);
      } catch { /* A failed view must not disrupt other subscribers or a confirmed operation. */ }
    }
  }

  private schedule(milliseconds: number, callback: () => void): void {
    if (this.disposed || this.status === 'disconnected' || this.status === 'error') return;
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed || generation !== this.generation || this.status === 'disconnected' || this.status === 'error') return;
      if (process.env.NODE_ENV === 'production') { this.cancelWork('unavailable'); return; }
      callback();
    }, milliseconds);
    this.timers.add(timer);
  }

  private setStatus(status: RealtimeConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: 'connection', status });
  }

  private startConnection(status: 'connecting' | 'reconnecting'): Promise<void> {
    try { this.active(); } catch (error) { return Promise.reject(error); }
    if (this.status === 'connected') return Promise.resolve();
    if (this.pendingConnection) return this.pendingConnection.promise;
    let resolve!: () => void;
    let reject!: (error: RealtimeOperationError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.pendingConnection = { promise, resolve, reject };
    this.setStatus(status);
    if (!this.pendingConnection || this.status !== status) return promise;
    this.schedule(20, () => {
      const pending = this.pendingConnection;
      this.pendingConnection = null;
      this.setStatus('connected');
      pending?.resolve();
      if (this.status === 'connected') this.emitWatchedPresence();
    });
    return promise;
  }

  connect(): Promise<void> { return this.startConnection('connecting'); }

  getStatus(): RealtimeConnectionStatus { requireDevelopment(); return this.status; }

  private cancelWork(code: 'disconnected' | 'session_ended' | 'unavailable'): void {
    this.generation += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pendingConnection?.reject(new RealtimeOperationError(code, code === 'disconnected'));
    this.pendingConnection = null;
    for (const [id, entry] of this.sends) {
      if (!entry.reject) continue;
      entry.reject(new RealtimeOperationError(code, code === 'disconnected'));
      this.recentBytes -= entry.fingerprint.length * 2;
      this.sends.delete(id);
    }
  }

  disconnect(): void {
    // Cleanup remains usable even if an environment is switched after construction.
    this.cancelWork('disconnected');
    this.setStatus('disconnected');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelWork('session_ended');
    this.status = 'disconnected';
    this.listeners.clear();
    this.sends.clear();
    this.incoming.clear();
    this.watchedConversations.clear();
    this.watchedPresence.clear();
    this.simulatedPresence.clear();
    this.recentBytes = 0;
  }

  private reserve(fingerprint: string): void {
    // Keep exact encrypted-envelope comparisons within a bounded recent-id window.
    for (const [id, entry] of this.sends) {
      if (this.sends.size < MAX_RECENT_MESSAGES && this.recentBytes + fingerprint.length * 2 <= MAX_RECENT_BYTES) break;
      if (entry.reject) continue;
      this.recentBytes -= entry.fingerprint.length * 2;
      this.sends.delete(id);
    }
    if (this.sends.size >= MAX_RECENT_MESSAGES || this.recentBytes + fingerprint.length * 2 > MAX_RECENT_BYTES) {
      throw new RealtimeOperationError('unavailable', true);
    }
    this.recentBytes += fingerprint.length * 2;
  }

  sendMessage(input: OutboundMessage): Promise<SendAcknowledgement> {
    try {
      this.connected();
      const message = parseOutboundMessage(input);
      if (!message) throw new RealtimeOperationError('invalid_payload');
      if (message.senderId !== this.actorId) throw new RealtimeOperationError('authentication_rejected');
      const conversation = this.conversation(message.conversationId);
      const fingerprint = JSON.stringify(message);
      const existing = this.sends.get(message.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new RealtimeOperationError('invalid_payload');
        return existing.promise.then((acknowledgement) => ({ ...acknowledgement }));
      }
      if (this.failNext) {
        this.failNext = false;
        this.emit({ type: 'error', code: 'send_failed', conversationId: message.conversationId });
        throw new RealtimeOperationError('send_failed', true);
      }
      this.reserve(fingerprint);
      let resolve!: (acknowledgement: SendAcknowledgement) => void;
      let reject!: (error: RealtimeOperationError) => void;
      const promise = new Promise<SendAcknowledgement>((yes, no) => { resolve = yes; reject = no; });
      const entry: SendRecord = { fingerprint, promise, resolve, reject, acknowledgement: null };
      this.sends.set(message.id, entry);
      this.schedule(this.ackDelay, () => {
        const acknowledgement: SendAcknowledgement = { conversationId: message.conversationId, messageId: message.id,
          status: 'sent', timestamp: new Date().toISOString() };
        entry.acknowledgement = { ...acknowledgement };
        const complete = entry.resolve;
        entry.resolve = null; entry.reject = null;
        complete?.({ ...acknowledgement });
        if (this.watchedConversations.has(conversation.id)) this.emit({ type: 'receipt', ...acknowledgement, userId: this.actorId });
        this.schedule(this.deliveryDelay - this.ackDelay, () => this.emitReceipts(conversation, message.id, 'delivered'));
        this.schedule(this.readDelay - this.ackDelay, () => this.emitReceipts(conversation, message.id, 'read'));
        if (this.autoReply && conversation.type === 'bot' && conversation.participants.some((peer) => peer.id === 'securebot-demo')) {
          this.schedule(Math.max(0, 300 - this.ackDelay), () => this.emitTyping(conversation, true));
          this.schedule(Math.max(0, 600 - this.ackDelay), () => {
            this.emitTyping(conversation, false);
            this.emitIncoming(conversation);
          });
        }
      });
      return promise.then((acknowledgement) => ({ ...acknowledgement }));
    } catch (error) { return Promise.reject(error); }
  }

  private emitReceipts(conversation: DemoConversation, messageId: string, status: 'delivered' | 'read'): void {
    if (this.status !== 'connected' || !this.watchedConversations.has(conversation.id)) return;
    for (const peer of conversation.participants) {
      if (this.status !== 'connected' || this.disposed) break;
      if (peer.id !== this.actorId) this.emit({ type: 'receipt', conversationId: conversation.id, messageId,
        status, userId: peer.id, timestamp: new Date().toISOString() });
    }
  }

  sendTyping(conversationId: string, isTyping: boolean): void {
    this.connected(); this.conversation(conversationId);
    if (typeof isTyping !== 'boolean') throw new RealtimeOperationError('invalid_payload');
    // The actor's own typing is not reflected as another person's activity.
  }

  async markRead(conversationId: string, messageId: string): Promise<void> {
    this.connected(); this.conversation(conversationId);
    if (!isIdentifier(messageId) || this.incoming.get(messageId) !== conversationId) throw new RealtimeOperationError('invalid_payload');
    this.emit({ type: 'receipt', conversationId, messageId, status: 'read', userId: this.actorId, timestamp: new Date().toISOString() });
  }

  watchConversations(ids: readonly string[]): void {
    this.active();
    if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => !isIdentifier(id))) throw new RealtimeOperationError('invalid_payload');
    for (const id of ids) this.conversation(id);
    this.watchedConversations = new Set(ids);
  }

  watchPresence(userIds: readonly string[]): void {
    this.active();
    if (!Array.isArray(userIds) || userIds.length > 500 || userIds.some((id) => !isIdentifier(id))) throw new RealtimeOperationError('invalid_payload');
    const previous = this.watchedPresence;
    this.watchedPresence = new Set(userIds.filter((id) => id !== this.actorId && this.peerIds.has(id)));
    if (this.status === 'connected') this.emitWatchedPresence(previous);
  }

  private emitWatchedPresence(previous: ReadonlySet<string> = new Set()): void {
    for (const userId of this.watchedPresence) {
      if (!previous.has(userId)) this.emit({ type: 'presence', userId,
        status: this.simulatedPresence.get(userId) ?? (userId === 'demo-ava' ? 'online' : 'unknown'), timestamp: new Date().toISOString() });
    }
  }

  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.active();
    if (typeof listener !== 'function' || (!this.listeners.has(listener) && this.listeners.size >= MAX_LISTENERS)) throw new RealtimeOperationError('unavailable');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emitTyping(conversation: DemoConversation, isTyping: boolean): void {
    if (this.status !== 'connected' || !this.watchedConversations.has(conversation.id)) return;
    for (const peer of conversation.participants) {
      if (this.status !== 'connected' || this.disposed) break;
      if (peer.id !== this.actorId) this.emit({ type: 'typing', conversationId: conversation.id, userId: peer.id,
        displayName: peer.displayName, isTyping, timestamp: new Date().toISOString() });
    }
  }

  private emitIncoming(conversation: DemoConversation): void {
    if (this.status !== 'connected' || !this.watchedConversations.has(conversation.id)) return;
    const peer = conversation.participants.find((participant) => participant.id !== this.actorId);
    if (!peer) return;
    const id = `demo-realtime-${++this.messageSequence}`;
    this.incoming.set(id, conversation.id);
    if (this.incoming.size > MAX_RECENT_MESSAGES) this.incoming.delete(this.incoming.keys().next().value!);
    this.emit({ type: 'message', message: { id, conversationId: conversation.id, senderId: peer.id, senderName: peer.displayName,
      timestamp: new Date().toISOString(), type: 'text', deliveryStatus: 'delivered', demoOnly: true,
      content: DEMO_REALTIME_MESSAGE_TEXT[conversation.type] } });
  }

  simulateIncoming(conversationId: string): void { this.connected(); this.emitIncoming(this.conversation(conversationId)); }

  simulateTyping(conversationId: string): void {
    this.connected();
    const conversation = this.conversation(conversationId);
    this.emitTyping(conversation, true);
    this.schedule(1_200, () => this.emitTyping(conversation, false));
  }

  simulatePresence(userId: string, status: RealtimePresenceStatus): void {
    this.connected();
    if (!this.peerIds.has(userId) || !['online', 'offline', 'busy', 'away', 'unknown'].includes(status)) throw new RealtimeOperationError('invalid_payload');
    this.simulatedPresence.set(userId, status);
    if (this.watchedPresence.has(userId)) this.emit({ type: 'presence', userId, status, timestamp: new Date().toISOString() });
  }

  simulateNetworkFailure(): void {
    this.active();
    this.cancelWork('disconnected');
    this.setStatus('disconnected');
    this.emit({ type: 'error', code: 'disconnected' });
  }

  simulateReconnect(): Promise<void> { return this.startConnection('reconnecting'); }

  failNextSend(): void { this.active(); this.failNext = true; }
}
