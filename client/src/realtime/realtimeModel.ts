import type { IncomingMessage, OutboundMessage, PresenceStatus, TransportMode } from '@/messaging/messageModel';

export type RealtimeConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type RealtimePresenceStatus = PresenceStatus | 'unknown';
export type RealtimeErrorCode = 'unavailable' | 'disconnected' | 'authentication_rejected' | 'ack_timeout' |
  'invalid_payload' | 'unauthorized_conversation' | 'recipient_keys_unavailable' | 'session_ended' | 'send_failed';

export type RealtimeEvent =
  | { type: 'connection'; status: RealtimeConnectionStatus }
  | { type: 'message'; message: IncomingMessage }
  | { type: 'receipt'; conversationId: string; messageId: string; status: 'sent' | 'delivered' | 'read'; userId: string; timestamp: string }
  | { type: 'typing'; conversationId: string; userId: string; displayName: string; isTyping: boolean; timestamp: string }
  | { type: 'presence'; userId: string; status: RealtimePresenceStatus; timestamp: string }
  | { type: 'conversation'; conversationId: string; displayName?: string; updatedAt: string }
  | { type: 'error'; code: RealtimeErrorCode; conversationId?: string };

export interface SendAcknowledgement {
  conversationId: string;
  messageId: string;
  status: 'sent';
  timestamp: string;
}

export interface RealtimeClient {
  readonly mode: TransportMode;
  readonly actorId: string;
  readonly canSendMessages: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  dispose(): void;
  getStatus(): RealtimeConnectionStatus;
  sendMessage(message: OutboundMessage): Promise<SendAcknowledgement>;
  sendTyping(conversationId: string, isTyping: boolean): void;
  markRead(conversationId: string, messageId: string): Promise<void>;
  watchConversations(ids: readonly string[]): void;
  watchPresence(userIds: readonly string[]): void;
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
}

const messages: Record<RealtimeErrorCode, string> = {
  unavailable: 'Realtime messaging is not available yet.',
  disconnected: 'The connection is unavailable. Reconnect before trying again.',
  authentication_rejected: 'Your realtime session could not be verified. Sign in again.',
  ack_timeout: 'The send could not be confirmed. Check its status before retrying.',
  invalid_payload: 'This realtime event is invalid and was rejected.',
  unauthorized_conversation: 'This conversation is unavailable for the current session.',
  recipient_keys_unavailable: 'Recipient encryption keys are unavailable. Remote sending is disabled.',
  session_ended: 'This realtime session has ended.',
  send_failed: 'The message could not be sent. Please try again.',
};

export class RealtimeOperationError extends Error {
  constructor(public readonly code: RealtimeErrorCode, public readonly retryable = false) {
    super(messages[code]);
    this.name = 'RealtimeOperationError';
  }
}

/** Proposed names only: the realtime owner must approve routing, authorization and payload semantics. */
export const PROPOSED_EVENT_NAMES = {
  messageSend: 'message:send', messageRead: 'message:read', typingStart: 'typing:start', typingStop: 'typing:stop',
  presenceSubscribe: 'presence:subscribe', messageNew: 'message:new', messageAck: 'message:ack',
  messageDelivered: 'message:delivered', messageReadReceipt: 'message:read', typingUpdate: 'typing:update',
  presenceUpdate: 'presence:update', conversationUpdated: 'conversation:updated',
} as const;

/** The demo never decrypts/echoes outbound text or fabricates live participant activity. */
export const DEMO_REALTIME_MESSAGE_TEXT = {
  bot: 'Demo reply: your message was received locally. No AI service is connected.',
  direct: 'Demo message: this activity is simulated locally. No remote participant is connected.',
  group: 'Demo group message: this activity is simulated locally. No remote participant is connected.',
} as const;
