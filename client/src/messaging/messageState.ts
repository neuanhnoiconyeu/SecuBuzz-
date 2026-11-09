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
        ? { ...message, content: 'This message was deleted.', isDeleted: true, reactions: [], attachments: [] }
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
      message.id === messageId
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
  if (!messages) return messagesByConversation;

  return {
    ...messagesByConversation,
    [conversationId]: messages.map((message) => {
      if (message.id !== messageId || message.isDeleted) return message;

      const existingReactions = message.reactions ?? [];
      const targetReaction = existingReactions.find((r) => r.emoji === emoji);

      let updatedReactions;

      if (!targetReaction) {
        updatedReactions = [...existingReactions, { emoji, userIds: [userId] }];
      } else {
        const hasReacted = targetReaction.userIds.includes(userId);
        const nextUserIds = hasReacted
          ? targetReaction.userIds.filter((id) => id !== userId)
          : [...targetReaction.userIds, userId];

        updatedReactions = existingReactions
          .map((r) => (r.emoji === emoji ? { ...r, userIds: nextUserIds } : r))
          .filter((r) => r.userIds.length > 0);
      }

      return { ...message, reactions: updatedReactions };
    }),
  };
}

