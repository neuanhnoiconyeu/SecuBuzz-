import type { ChatMessage, DeliveryStatus, MessageEncryptionMetadata } from './messageModel';

export type ConversationMessages = Record<string, ChatMessage[]>;
export const MAX_MESSAGES_PER_CONVERSATION = 1_000;

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
    [message.conversationId]: [...messages, message]
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-MAX_MESSAGES_PER_CONVERSATION),
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
  if (current.deliveryStatus === 'read') return messagesByConversation;
  if (deliveryStatus === 'sending' && current.deliveryStatus !== 'failed') return messagesByConversation;
  if (current.deliveryStatus === 'delivered' && deliveryStatus !== 'read') return messagesByConversation;
  if (deliveryStatus === 'sent' && current.deliveryStatus === 'failed') return messagesByConversation;
  if (deliveryStatus === 'failed' && current.deliveryStatus !== 'sending') return messagesByConversation;

  return {
    ...messagesByConversation,
    [conversationId]: messages.map((message) =>
      message.id === messageId ? { ...message, deliveryStatus } : message
    ),
  };
}

export function editMessageContent(
  messagesByConversation: ConversationMessages,
  conversationId: string,
  messageId: string,
  newContent: string
): ConversationMessages {
  const messages = messagesByConversation[conversationId];
  const trimmed = newContent.trim();
  if (!messages || !trimmed) return messagesByConversation;

  return {
    ...messagesByConversation,
    [conversationId]: messages.map((message) =>
      message.id === messageId && !message.isDeleted
        ? { ...message, content: trimmed, isEdited: true, editedAt: new Date().toISOString() }
        : message
    ),
  };
}

export function deleteMessageById(
  messagesByConversation: ConversationMessages,
  conversationId: string,
  messageId: string
): ConversationMessages {
  const messages = messagesByConversation[conversationId];
  if (!messages) return messagesByConversation;

  return {
    ...messagesByConversation,
    [conversationId]: messages.map((message) =>
      message.id === messageId
        ? { ...message, content: 'This message was deleted.', isDeleted: true, isPinned: false, reactions: [], attachments: [], voice: undefined, forwardedFrom: undefined, replyTo: undefined }
        : message
    ),
  };
}

export function toggleMessagePin(
  messagesByConversation: ConversationMessages,
  conversationId: string,
  messageId: string
): ConversationMessages {
  const messages = messagesByConversation[conversationId];
  if (!messages) return messagesByConversation;

  return {
    ...messagesByConversation,
    [conversationId]: messages.map((message) =>
      message.id === messageId && !message.isDeleted && (message.isPinned || (['text', 'voice'].includes(message.type) &&
        message.deliveryStatus !== 'sending' && message.deliveryStatus !== 'failed'))
        ? { ...message, isPinned: !message.isPinned }
        : message
    ),
  };
}

export function toggleMessageReaction(
  messagesByConversation: ConversationMessages,
  conversationId: string,
  messageId: string,
  emoji: string,
  userId: string
): ConversationMessages {
  const messages = messagesByConversation[conversationId];
  if (!messages || !emoji) return messagesByConversation;

  return {
    ...messagesByConversation,
    [conversationId]: messages.map((message) => {
      if (message.id !== messageId || message.isDeleted || !['text', 'voice'].includes(message.type) ||
        message.deliveryStatus === 'sending' || message.deliveryStatus === 'failed') return message;

      const existingReactions = message.reactions ?? [];
      const selected = existingReactions.some(r => r.emoji === emoji && r.userIds.includes(userId));
      // Remove this user's previous choice, including older local snapshots with multiple choices.
      const updatedReactions = existingReactions.map(r => ({
        emoji: r.emoji, userIds: [...new Set(r.userIds)].filter(id => id !== userId),
      })).filter(r => r.userIds.length > 0);
      if (!selected) {
        const target = updatedReactions.find(r => r.emoji === emoji);
        if (target) target.userIds.push(userId);
        else updatedReactions.push({ emoji, userIds: [userId] });
      }

      return { ...message, reactions: updatedReactions };
    }),
  };
}

export function removeMessageById(
  messagesByConversation: ConversationMessages,
  conversationId: string,
  messageId: string
): ConversationMessages {
  const messages = messagesByConversation[conversationId];
  if (!messages?.some((message) => message.id === messageId)) return messagesByConversation;
  return {
    ...messagesByConversation,
    [conversationId]: messages.filter((message) => message.id !== messageId),
  };
}

export function deleteMessageBySender(
  messagesByConversation: ConversationMessages,
  conversationId: string,
  messageId: string,
  senderId: string
): ConversationMessages {
  const messages = messagesByConversation[conversationId];
  const target = messages?.find((message) => message.id === messageId);
  if (!messages || !target || target.senderId !== senderId || target.isDeleted) return messagesByConversation;
  return deleteMessageById(messagesByConversation, conversationId, messageId);
}

export function editMessageBySender(
  messagesByConversation: ConversationMessages,
  conversationId: string,
  messageId: string,
  senderId: string,
  content: string,
  encryption: MessageEncryptionMetadata | undefined,
  editedAt: string
): ConversationMessages {
  const messages = messagesByConversation[conversationId];
  const target = messages?.find((m) => m.id === messageId);
  if (!messages || !target || !content.trim()) return messagesByConversation;
  if (target.senderId !== senderId || target.isDeleted) return messagesByConversation;
  if (target.editedAt && Date.parse(editedAt) < Date.parse(target.editedAt)) return messagesByConversation;

  return {
    ...messagesByConversation,
    [conversationId]: messages.map((m) =>
      m.id === messageId
        ? { ...m, content, isEdited: true, editedAt, ...(encryption ? { encryption } : {}) }
        : m
    ),
  };
}
