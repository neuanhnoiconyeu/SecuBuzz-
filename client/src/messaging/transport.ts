import type {
  ChatMessage,
  ConnectionStatus,
  DeliveryStatus,
  IncomingMessage,
  OutboundMessage,
  PresenceStatus,
  TransportMode,
} from './messageModel';

export interface DeliveryStatusUpdate {
  messageId: string;
  status: DeliveryStatus;
}

export interface MessagingTransportHandlers {
  onMessage(message: IncomingMessage): void;
  onDeliveryStatus(update: DeliveryStatusUpdate): void;
  onPresenceUpdate(status: PresenceStatus): void;
  onSecurityAlert(message: ChatMessage): void;
  onConnectionChange(status: ConnectionStatus): void;
}

/**
 * App-facing transport contract. A realtime adapter must be built only after
 * the server owner publishes its versioned event and encrypted-payload contract.
 */
export interface MessagingTransport {
  readonly mode: TransportMode;
  connect(conversationId: string): Promise<void>;
  sendMessage(message: OutboundMessage): Promise<void>;
  subscribeToConversation(
    conversationId: string,
    handlers: MessagingTransportHandlers
  ): () => void;
  disconnect(conversationId: string): Promise<void>;
}
