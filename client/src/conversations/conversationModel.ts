import type { ChatMessage, IncomingMessage, PresenceStatus } from '@/messaging/messageModel';

export type ConversationType = 'bot' | 'direct' | 'group';
export type ConversationSecurityState = 'local-demo' | 'recipient-key-unavailable' | 'not-established';

export interface ConversationParticipant {
  id: string;
  displayName: string;
  kind: 'person' | 'bot';
}

export interface Conversation {
  id: string;
  displayName: string;
  type: ConversationType;
  avatarUrl?: string;
  participants: ConversationParticipant[];
  /** Omitted for local demos so they are not presented as real online users. */
  presence?: PresenceStatus;
  lastMessagePreview: string;
  lastActivityAt: string;
  unreadCount: number;
  securityState: ConversationSecurityState;
  isDemo: boolean;
}

export interface ConversationMessageActivity {
  conversationId: string;
  messageId: string;
  direction: 'incoming' | 'outgoing';
  preview: string;
  timestamp: string;
  /** Presentation only: an active conversation can be hidden behind Friends or Security. */
  isViewed?: boolean;
}

/** Frontend contract for a future database or API backed conversation provider. */
export interface ConversationDataProvider {
  loadConversations(): Promise<Conversation[]>;
  createConversation(input: Omit<Conversation, 'id'>): Promise<Conversation>;
  updateConversation(conversationId: string, updates: Partial<Conversation>): Promise<void>;
  loadMessages(conversationId: string): Promise<ChatMessage[]>;
}

/** Domain events only; a realtime adapter must map its own confirmed protocol to these. */
export interface ConversationRealtimeHandlers {
  onMessage(message: IncomingMessage): void;
  onConversationUpdated(conversation: Conversation): void;
  onUnreadUpdated(conversationId: string, unreadCount: number): void;
  onReadUpdated(conversationId: string, lastReadAt: string): void;
  onPresenceUpdated(conversationId: string, presence: PresenceStatus): void;
}

export interface ConversationRealtimeProvider {
  subscribe(conversationIds: string[], handlers: ConversationRealtimeHandlers): () => void;
}
