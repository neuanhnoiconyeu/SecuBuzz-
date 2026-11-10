import { useCallback, useRef, useState } from 'react';
import type { Conversation, ConversationMessageActivity } from '@/conversations/conversationModel';
import { createDemoConversations, uniqueConversations } from '@/conversations/demoConversations';

export interface UseMessengerConversationsResult {
  conversations: Conversation[];
  activeConversationId: string | null;
  activeConversation: Conversation | null;
  drafts: Record<string, string>;
  isEmpty: boolean;
  selectConversation(conversationId: string | null): boolean;
  setDraft(conversationId: string, draft: string): void;
  recordMessageActivity(activity: ConversationMessageActivity): void;
  updateConversationMetadata(update: { conversationId: string; displayName?: string; updatedAt: string }): void;
}

export function useMessengerConversations(
  initialConversations: Conversation[] = createDemoConversations()
): UseMessengerConversationsResult {
  const [conversations, setConversations] = useState(() => uniqueConversations(initialConversations));
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    () => uniqueConversations(initialConversations)[0]?.id ?? null
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const activeIdRef = useRef(activeConversationId);
  const conversationIdsRef = useRef(new Set(conversations.map((conversation) => conversation.id)));
  const seenIncomingIds = useRef(new Set<string>());
  activeIdRef.current = activeConversationId;
  conversationIdsRef.current = new Set(conversations.map((conversation) => conversation.id));

  const selectConversation = useCallback((conversationId: string | null) => {
    if (conversationId !== null && !conversationIdsRef.current.has(conversationId)) return false;
    activeIdRef.current = conversationId;
    setActiveConversationId(conversationId);
    if (conversationId !== null) {
      setConversations((current) => current.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation
      ));
    }
    return true;
  }, []);

  const setDraft = useCallback((conversationId: string, draft: string) => {
    if (!conversationIdsRef.current.has(conversationId)) return;
    setDrafts((current) => {
      if (!draft) {
        if (!(conversationId in current)) return current;
        const next = { ...current };
        delete next[conversationId];
        return next;
      }
      if (current[conversationId] === draft) return current;
      return { ...current, [conversationId]: draft };
    });
  }, []);

  const recordMessageActivity = useCallback((activity: ConversationMessageActivity) => {
    if (!conversationIdsRef.current.has(activity.conversationId)) return;
    const activityId = JSON.stringify([activity.conversationId, activity.messageId]);
    const isDuplicateIncoming = activity.direction === 'incoming' && seenIncomingIds.current.has(activityId);
    if (activity.direction === 'incoming') seenIncomingIds.current.add(activityId);
    while (seenIncomingIds.current.size > 2_000) seenIncomingIds.current.delete(seenIncomingIds.current.values().next().value!);
    const preview = activity.preview.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Message';
    setConversations((current) => current.map((conversation) => {
      if (conversation.id !== activity.conversationId) return conversation;
      const isNewer = Date.parse(activity.timestamp) >= Date.parse(conversation.lastActivityAt);
      const shouldCountUnread = activity.direction === 'incoming' &&
        (activeIdRef.current !== activity.conversationId || activity.isViewed === false) && !isDuplicateIncoming;
      return {
        ...conversation,
        ...(isNewer ? { lastMessagePreview: preview, lastActivityAt: activity.timestamp } : {}),
        ...(shouldCountUnread ? { unreadCount: conversation.unreadCount + 1 } : {}),
      };
    }));
  }, []);

  const metadataTimestamps = useRef(new Map<string, number>());
  const updateConversationMetadata = useCallback((update: { conversationId: string; displayName?: string; updatedAt: string }) => {
    const timestamp = Date.parse(update.updatedAt);
    if (!conversationIdsRef.current.has(update.conversationId) || !Number.isFinite(timestamp) ||
      timestamp <= (metadataTimestamps.current.get(update.conversationId) ?? -Infinity)) return;
    metadataTimestamps.current.set(update.conversationId, timestamp);
    setConversations((current) => current.map((conversation) => conversation.id === update.conversationId
      ? { ...conversation, ...(update.displayName ? { displayName: update.displayName } : {}) } : conversation));
  }, []);

  return {
    conversations,
    activeConversationId,
    activeConversation: conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    drafts,
    isEmpty: conversations.length === 0,
    selectConversation,
    setDraft,
    recordMessageActivity,
    updateConversationMetadata,
  };
}
