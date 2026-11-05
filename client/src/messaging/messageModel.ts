import type { EncryptedMessagePayload } from '@/utils/crypto';

/** Message contracts used by the UI, local state, and future transports. */
export type MessageType = 'text' | 'system' | 'security_alert';

export type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'failed';

export type PresenceStatus = 'online' | 'offline' | 'busy' | 'away';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';

export type TransportMode = 'local-demo' | 'realtime';

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
