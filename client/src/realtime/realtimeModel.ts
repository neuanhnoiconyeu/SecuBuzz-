import type { EncryptedIncomingMessage, IncomingMessage, OutboundMessage, PresenceStatus, TransportMode } from '@/messaging/messageModel';

/** Phase 8.7B protocol.ts: failure callbacks and handshake errors are different contracts. */
export const SERVER_ACK_ERROR_CODES = ['invalid_payload', 'unauthorized_conversation', 'rate_limited', 'unavailable',
  'message_not_found', 'actor_mismatch', 'idempotency_conflict', 'recipient_keys_unavailable', 'policy_denied'] as const;
export const SERVER_CONNECT_ERROR_CODES = ['AUTH_REQUIRED', 'UNAUTHORIZED', 'SESSION_EXPIRED', 'REALTIME_UNAVAILABLE',
  'CONNECTION_LIMIT', 'ORIGIN_NOT_ALLOWED', 'POLICY_DENIED'] as const;
export type ServerErrorCode = typeof SERVER_ACK_ERROR_CODES[number] | typeof SERVER_CONNECT_ERROR_CODES[number];

export type RealtimeConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type RealtimePresenceStatus = PresenceStatus | 'unknown';
export type RealtimeErrorCode = 'unavailable' | 'disconnected' | 'authentication_rejected' | 'ack_timeout' |
  typeof SERVER_ACK_ERROR_CODES[number] | 'connection_limit' | 'origin_not_allowed' | 'session_ended' | 'send_failed';

export type RealtimeEvent =
  | { type: 'connection'; status: RealtimeConnectionStatus }
  | { type: 'message'; message: IncomingMessage }
  | { type: 'receipt'; conversationId: string; messageId: string; status: 'sent' | 'delivered' | 'read'; userId: string; timestamp: string }
  | { type: 'typing'; conversationId: string; userId: string; displayName: string; isTyping: boolean; timestamp: string }
  | { type: 'presence'; userId: string; status: RealtimePresenceStatus; timestamp: string }
  | { type: 'conversation'; conversationId: string; displayName?: string; updatedAt: string }
  | { type: 'error'; code: RealtimeErrorCode; serverCode?: ServerErrorCode; conversationId?: string };

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
  readonly canConfirmDelivery?: boolean;
  /** Called only after incoming authentication. Resolves on local callback submission, not server persistence. */
  confirmDelivery?(message: EncryptedIncomingMessage): Promise<void>;
  watchConversationParticipants?(scopes: readonly ConversationParticipantScope[]): void;
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

export interface ConversationParticipantScope {
  conversationId: string;
  participantIds: readonly string[];
}

const messages: Record<RealtimeErrorCode, string> = {
  unavailable: 'Realtime messaging is not available yet.',
  disconnected: 'The connection is unavailable. Reconnect before trying again.',
  authentication_rejected: 'Your realtime session could not be verified. Sign in again.',
  ack_timeout: 'The operation could not be confirmed. Check its status before retrying.',
  invalid_payload: 'This realtime event is invalid and was rejected.',
  unauthorized_conversation: 'This conversation is unavailable for the current session.',
  recipient_keys_unavailable: 'Recipient encryption keys are unavailable. Remote sending is disabled.',
  session_ended: 'This realtime session has ended.',
  send_failed: 'The message could not be sent. Please try again.',
  rate_limited: 'Too many requests. Please wait before trying again.',
  message_not_found: 'This message is not available on the server.',
  actor_mismatch: 'This operation does not match the authenticated account.',
  idempotency_conflict: 'This message identifier is already in use. The operation was rejected.',
  policy_denied: 'This operation is not permitted by the server policy.',
  connection_limit: 'The realtime connection limit has been reached. Please try again later.',
  origin_not_allowed: 'Realtime connections from this application are not permitted.',
};

export class RealtimeOperationError extends Error {
  constructor(public readonly code: RealtimeErrorCode, public readonly retryable = false,
    public readonly serverCode?: ServerErrorCode) {
    super(serverCode === 'SESSION_EXPIRED' ? 'Your session has expired. Please sign in again.' : messages[code]);
    this.name = 'RealtimeOperationError';
  }
}

/** Historical export name, matched by the Phase 8.7B protocol and cross-package parity tests. */
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
