import type { ChatMessage, DeliveryStatus } from './messageModel';

export type ConversationMessages = Record<string, ChatMessage[]>;

let fallbackIdSequence = 0;

export function createClientMessageId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  fallbackIdSequence += 1;
  return `${Date.now()}-${fallbackIdSequence}-${Math.random().toString(36).slice(2)}`;
}

export function appendMessage(
  messagesByConversation: ConversationMessages,
  message: ChatMessage
): ConversationMessages {
  const messages = messagesByConversation[message.conversationId] ?? [];
  if (messages.some((existing) => existing.id === message.id)) return messagesByConversation;

  return {
    ...messagesByConversation,
    [message.conversationId]: [...messages, message],
  };
}

export function updateMessageDeliveryStatus(
  messagesByConversation: ConversationMessages,
  conversationId: string,
  messageId: string,
  deliveryStatus: DeliveryStatus
): ConversationMessages {
  const messages = messagesByConversation[conversationId];
  const current = messages?.find((message) => message.id === messageId);
  if (!messages || !current || current.deliveryStatus === deliveryStatus) {
    return messagesByConversation;
  }

  // Ignore stale acknowledgements; retries are the only transition back to sending.
  if (deliveryStatus === 'sending' && current.deliveryStatus !== 'failed') return messagesByConversation;
  if (current.deliveryStatus === 'delivered') return messagesByConversation;
  if (deliveryStatus === 'sent' && current.deliveryStatus === 'failed') return messagesByConversation;
  if (deliveryStatus === 'failed' && current.deliveryStatus !== 'sending') return messagesByConversation;

  return {
    ...messagesByConversation,
    [conversationId]: messages.map((message) =>
      message.id === messageId ? { ...message, deliveryStatus } : message
    ),
  };
}
