import type { Conversation } from '@/conversations/conversationModel';
import type { EncryptedIncomingMessage, OutboundMessage } from '@/messaging/messageModel';
import type { MessagingTransport, MessagingTransportHandlers } from '@/messaging/transport';
import { DemoTransportDisposedError } from '@/messaging/localDemoTransport';
import { RealtimeOperationError, type RealtimeClient, type RealtimeEvent } from './realtimeModel';
import { parseErrorAcknowledgement, parseOutboundMessage, parseRealtimeEvent, parseSendAcknowledgement } from './realtimeValidation';

const MAX_TRACKED_SENDS = 2_000;
const MAX_TRACKED_BYTES = 16 * 1024 * 1024;
const MAX_SEND_ATTEMPTS = 3;
const keyFor = (conversationId: string, messageId: string) => JSON.stringify([conversationId, messageId]);

/** Adapts one session client to the existing message hook; it owns no message history. */
export class RealtimeMessagingTransport implements MessagingTransport {
  readonly mode;
  private readonly conversations: Map<string, Conversation>;
  private readonly handlers = new Map<string, Set<MessagingTransportHandlers>>();
  private readonly sends = new Map<string, { fingerprint: string; attempts: number; retryable: boolean }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private activated = false;
  private initialConnection: Promise<void> | null = null;
  private trackedBytes = 0;

  constructor(private readonly client: RealtimeClient, conversations: readonly Conversation[]) {
    this.mode = client.mode;
    this.conversations = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    client.watchConversations([...this.conversations.keys()]);
    client.watchConversationParticipants?.(conversations.map((conversation) => ({
      conversationId: conversation.id, participantIds: conversation.participants.map((user) => user.id),
    })));
    this.unsubscribe = client.subscribe((event) => this.receive(event));
  }

  get canSendMessages() { return this.client.canSendMessages; }
  get canConfirmDelivery() { return this.mode === 'realtime' && this.client.canConfirmDelivery === true; }
  getConnectionStatus() { return this.client.getStatus(); }

  private assertConversation(conversationId: string) {
    if (this.disposed) throw this.mode === 'local-demo' ? new DemoTransportDisposedError() : new RealtimeOperationError('session_ended');
    if (!this.conversations.has(conversationId)) throw new RealtimeOperationError('unauthorized_conversation');
  }

  async connect(conversationId: string) {
    this.assertConversation(conversationId);
    // Standalone consumers may start the initial connection. Once activated,
    // navigation attaches to the current session state and never reconnects an
    // intentionally offline session or bypasses its reconnect backoff.
    if (!this.activated) {
      this.activated = true;
      if (this.client.getStatus() === 'disconnected') {
        this.initialConnection = this.client.connect().finally(() => { this.initialConnection = null; });
      }
    }
    if (this.initialConnection) await this.initialConnection;
    if (this.disposed) throw new RealtimeOperationError('session_ended');
  }

  async disconnect(_conversationId: string) {
    // Conversation changes remove listeners below; only the session owns physical disconnect.
  }

  subscribeToConversation(conversationId: string, handlers: MessagingTransportHandlers) {
    this.assertConversation(conversationId);
    const listeners = this.handlers.get(conversationId) ?? new Set<MessagingTransportHandlers>();
    listeners.add(handlers);
    this.handlers.set(conversationId, listeners);
    try { handlers.onConnectionChange(this.client.getStatus()); } catch { /* The caller still receives its cleanup handle. */ }
    return () => {
      listeners.delete(handlers);
      if (!listeners.size) this.handlers.delete(conversationId);
    };
  }

  sendMessage(untrusted: OutboundMessage): Promise<void> {
    if (this.disposed) return Promise.reject(this.mode === 'local-demo' ? new DemoTransportDisposedError() : new RealtimeOperationError('session_ended'));
    const message = parseOutboundMessage(untrusted);
    if (!message || message.senderId !== this.client.actorId) return Promise.reject(new RealtimeOperationError('invalid_payload'));
    try { this.assertConversation(message.conversationId); } catch (error) { return Promise.reject(error); }
    if (!this.client.canSendMessages) return Promise.reject(new RealtimeOperationError('recipient_keys_unavailable'));
    const key = keyFor(message.conversationId, message.id);
    const fingerprint = JSON.stringify(message);
    const previous = this.sends.get(key);
    if (previous && previous.fingerprint !== fingerprint) return Promise.reject(new RealtimeOperationError('invalid_payload'));
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (previous && (!previous.retryable || previous.attempts >= MAX_SEND_ATTEMPTS)) {
      return Promise.reject(new RealtimeOperationError('send_failed'));
    }
    if (!previous) {
      for (const [oldKey, record] of this.sends) {
        if (this.sends.size < MAX_TRACKED_SENDS && this.trackedBytes + fingerprint.length * 2 <= MAX_TRACKED_BYTES) break;
        if (this.pending.has(oldKey)) continue;
        this.sends.delete(oldKey);
        this.trackedBytes -= record.fingerprint.length * 2;
      }
      if (this.sends.size >= MAX_TRACKED_SENDS || this.trackedBytes + fingerprint.length * 2 > MAX_TRACKED_BYTES) {
        return Promise.reject(new RealtimeOperationError('unavailable', true));
      }
      this.trackedBytes += fingerprint.length * 2;
    }
    this.sends.set(key, { fingerprint, attempts: (previous?.attempts ?? 0) + 1, retryable: false });
    const operation: Promise<void> = (async () => {
      try {
        const result = await this.client.sendMessage(message);
        const error = parseErrorAcknowledgement(result);
        if (error) throw error;
        const acknowledgement = parseSendAcknowledgement(result);
        if (this.disposed) throw new RealtimeOperationError('session_ended');
        if (!acknowledgement || acknowledgement.messageId !== message.id || acknowledgement.conversationId !== message.conversationId) {
          throw new RealtimeOperationError('invalid_payload');
        }
      } catch (failure) {
        const tracked = this.sends.get(key);
        if (tracked) tracked.retryable = failure instanceof RealtimeOperationError && failure.retryable && tracked.attempts < MAX_SEND_ATTEMPTS;
        throw failure;
      }
    })().finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); });
    this.pending.set(key, operation);
    return operation;
  }

  canRetryMessage(conversationId: string, messageId: string) {
    const record = this.sends.get(keyFor(conversationId, messageId));
    return !this.disposed && this.client.canSendMessages && this.client.getStatus() === 'connected' &&
      Boolean(record?.retryable && record.attempts < MAX_SEND_ATTEMPTS);
  }

  sendTyping(conversationId: string, isTyping: boolean) {
    this.assertConversation(conversationId);
    this.client.sendTyping(conversationId, isTyping);
  }

  async markRead(conversationId: string, messageId: string) {
    this.assertConversation(conversationId);
    await this.client.markRead(conversationId, messageId);
  }

  async confirmDelivery(untrusted: EncryptedIncomingMessage) {
    this.assertConversation(untrusted.conversationId);
    if (!this.canConfirmDelivery || !this.client.confirmDelivery) throw new RealtimeOperationError('recipient_keys_unavailable');
    const event = parseRealtimeEvent('message', untrusted, 'realtime');
    if (event?.type !== 'message' || !('encryption' in event.message)) throw new RealtimeOperationError('invalid_payload');
    const message = event.message;
    if (message.senderId === this.client.actorId ||
      !this.conversations.get(message.conversationId)?.participants.some((user) => user.id === message.senderId)) {
      throw new RealtimeOperationError('unauthorized_conversation');
    }
    await this.client.confirmDelivery(message);
  }

  private notify(conversationId: string, operation: (handlers: MessagingTransportHandlers) => void) {
    const listeners = this.handlers.get(conversationId);
    for (const handlers of Array.from(listeners ?? [])) {
      if (this.disposed) break;
      if (!listeners?.has(handlers)) continue;
      try { operation(handlers); } catch { /* A view failure cannot interrupt other subscribers. */ }
    }
  }

  private receive(raw: RealtimeEvent) {
    if (this.disposed) return;
    const event = parseRealtimeEvent(raw.type, raw, this.mode);
    if (!event) return;
    if (event.type === 'connection') {
      for (const id of Array.from(this.handlers.keys())) {
        this.notify(id, (handlers) => handlers.onConnectionChange(event.status));
        if (event.status !== 'connected') this.notify(id, (handlers) => handlers.onPresenceUpdate(undefined));
      }
      return;
    }
    if (event.type === 'presence') {
      for (const id of Array.from(this.handlers.keys())) {
        const conversation = this.conversations.get(id)!;
        if (event.userId === this.client.actorId || !conversation.participants.some((user) => user.id === event.userId)) continue;
        this.notify(id, (handlers) => handlers.onPresenceUpdate(event.status === 'unknown' ? undefined : event.status));
      }
      return;
    }
    if (event.type === 'message') {
      const message = event.message;
      const conversation = this.conversations.get(message.conversationId);
      if (!conversation?.participants.some((user) => user.id === message.senderId)) return;
      this.notify(message.conversationId, (handlers) => handlers.onMessage({ ...message,
        ...('encryption' in message ? { encryption: { ...message.encryption } } : {}) }));
    } else if (event.type === 'receipt') {
      const conversation = this.conversations.get(event.conversationId);
      if (!this.sends.has(keyFor(event.conversationId, event.messageId)) ||
        !conversation?.participants.some((user) => user.id === event.userId && user.id !== this.client.actorId)) return;
      this.notify(event.conversationId, (handlers) => handlers.onDeliveryStatus({ messageId: event.messageId, status: event.status }));
    } else if (event.type === 'typing') {
      const conversation = this.conversations.get(event.conversationId);
      if (event.userId === this.client.actorId || !conversation?.participants.some((user) => user.id === event.userId)) return;
      this.notify(event.conversationId, (handlers) => handlers.onTypingUpdate?.({ ...event }));
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.client.watchConversationParticipants?.([]);
    this.handlers.clear();
    this.sends.clear();
    this.pending.clear();
    this.trackedBytes = 0;
    this.initialConnection = null;
  }
}
