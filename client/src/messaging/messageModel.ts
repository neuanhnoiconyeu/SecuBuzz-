import type { EncryptedMessagePayload } from '@/utils/crypto';

/** Message contracts used by the UI, local state, and future transports. */
export type MessageType = 'text' | 'system' | 'security_alert' | 'voice';

export type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'failed' | 'read';

export type PresenceStatus = 'online' | 'offline' | 'busy' | 'away';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';

export type TransportMode = 'local-demo' | 'realtime';

export interface MessageReaction {
  emoji: string;
  userIds: string[];
}

export interface MessageReplyReference {
  messageId: string;
  senderName: string;
  contentSnippet: string;
}

export interface MessageAttachment {
  id: string;
  name: string;
  type: 'image' | 'file';
  url: string;
  sizeBytes: number;
}

export interface VoiceMessageMetadata {
  audioUrl: string;
  durationSeconds: number;
}

export interface MessageEncryptionMetadata extends EncryptedMessagePayload {
  /** Indicates browser-only demo encryption, not multi-user E2EE. */
  scope: 'browser-demo';
}

export interface EncryptedIncomingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  timestamp: string;
  type: 'text';
  deliveryStatus: DeliveryStatus;
  encryption: EncryptedMessagePayload;
}

/** Plaintext is accepted only from the explicitly local demo transport. */
export interface DemoIncomingMessage extends Omit<ChatMessage, 'encryption'> {
  demoOnly: true;
}

export type IncomingMessage = EncryptedIncomingMessage | DemoIncomingMessage;

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  type: MessageType;
  deliveryStatus: DeliveryStatus;
  encryption?: MessageEncryptionMetadata;
  demoOnly?: true;
  replyTo?: MessageReplyReference | undefined;
  reactions?: MessageReaction[] | undefined;
  isEdited?: boolean | undefined;
  isDeleted?: boolean | undefined;
  isPinned?: boolean | undefined;
  forwardedFrom?: string | undefined;
  attachments?: MessageAttachment[] | undefined;
  voice?: VoiceMessageMetadata | undefined;
}

/** Transport payload deliberately excludes plaintext message content. */
export interface OutboundMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  timestamp: string;
  type: 'text';
  encryption: MessageEncryptionMetadata;
}
