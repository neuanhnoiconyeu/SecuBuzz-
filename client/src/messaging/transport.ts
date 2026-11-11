import type {
  ChatMessage,
  ConnectionStatus,
  DeliveryStatus,
  EncryptedIncomingMessage,
  IncomingMessage,
  OutboundMessage,
  PresenceStatus,
  TransportMode,
} from './messageModel';

export interface DeliveryStatusUpdate {
  messageId: string;
  status: DeliveryStatus;
}

export interface TypingUpdate {
  userId: string;
  displayName: string;
  isTyping: boolean;
  timestamp: string;
}

export interface MessagingTransportHandlers {
  onMessage(message: IncomingMessage): void;
  onDeliveryStatus(update: DeliveryStatusUpdate): void;
  onPresenceUpdate(status: PresenceStatus | undefined): void;
  onSecurityAlert(message: ChatMessage): void;
  onConnectionChange(status: ConnectionStatus): void;
  onTypingUpdate?(update: TypingUpdate): void;
}

/**
 * App-facing transport contract. A realtime adapter must be built only after
 * the server owner publishes its versioned event and encrypted-payload contract.
 */
export interface MessagingTransport {
  readonly mode: TransportMode;
  readonly canSendMessages?: boolean;
  readonly canConfirmDelivery?: boolean;
  confirmDelivery?(message: EncryptedIncomingMessage): Promise<void>;
  getConnectionStatus?(): ConnectionStatus;
  connect(conversationId: string): Promise<void>;
  sendMessage(message: OutboundMessage): Promise<void>;
  subscribeToConversation(
    conversationId: string,
    handlers: MessagingTransportHandlers
  ): () => void;
  disconnect(conversationId: string): Promise<void>;
  sendTyping?(conversationId: string, isTyping: boolean): void;
  markRead?(conversationId: string, messageId: string): Promise<void>;
  canRetryMessage?(conversationId: string, messageId: string): boolean;
}
