import type { Conversation } from '@/conversations/conversationModel';

/** A live implementation must get-or-create a DM idempotently using authenticated identity,
 * then register the returned conversation with the existing conversation store before resolving.
 * This boundary does not send messages, distribute keys, or invent conversation IDs.
 */
export interface FriendsConversationAdapter {
  canOpenDirectConversation(userId: string): boolean;
  openDirectConversation(userId: string): Promise<string>;
}

export class DirectConversationUnavailableError extends Error {
  constructor() {
    super('No direct conversation is connected for this user. Creating a new DM requires the conversation service.');
    this.name = 'DirectConversationUnavailableError';
  }
}

/** Opens only existing one-to-one threads; never mistakes a shared group for a DM. */
export function existingDirectConversationAdapter(
  conversations: readonly Conversation[], currentUserId: string,
): FriendsConversationAdapter {
  const find = (userId: string) => conversations.find((conversation) =>
    userId !== currentUserId && conversation.type === 'direct' &&
    conversation.participants.length === 2 &&
    conversation.participants.some((person) => person.id === currentUserId && person.kind === 'person') &&
    conversation.participants.some((person) => person.id === userId && person.kind === 'person'));
  return {
    canOpenDirectConversation: (userId) => Boolean(find(userId)),
    async openDirectConversation(userId) {
      const conversation = find(userId);
      if (!conversation) throw new DirectConversationUnavailableError();
      return conversation.id;
    },
  };
}
