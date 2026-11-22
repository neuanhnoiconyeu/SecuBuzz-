import { useCallback, useSyncExternalStore } from 'react';
import { emptyLocalHiddenMessages, hideLocalMessage, localHiddenMessageId, readLocalHiddenMessages, subscribeLocalHiddenMessages } from '@/messaging/localHiddenMessages';

export function useLocalHiddenMessages(accountId: string) {
  const getSnapshot = useCallback(() => readLocalHiddenMessages(accountId), [accountId]);
  const snapshot = useSyncExternalStore(subscribeLocalHiddenMessages, getSnapshot, emptyLocalHiddenMessages);
  const isHidden = useCallback((conversationId: string, messageId: string) => snapshot.hidden.has(localHiddenMessageId(conversationId, messageId)), [snapshot.hidden]);
  const hide = useCallback((conversationId: string, messageId: string) => hideLocalMessage(accountId, conversationId, messageId), [accountId]);
  return { isHidden, hide, unavailable: snapshot.unavailable };
}
