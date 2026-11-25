import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SecureLiveState, SecureRealtimeWorkspace } from '@/realtime/SecureRealtimeWorkspace';

const empty: SecureLiveState = { connection: 'offline', conversations: [], rows: {}, cursors: {}, unread: {}, typing: {}, presence: {}, receipts: {}, keyVersions: {}, errors: {}, synchronized: 0 };
const emptySnapshot = () => empty;
const noSubscription = () => () => {};
type MessageNotice = NonNullable<SecureLiveState['incomingMessage']>;

/** Consumes only the workspace's verified live-event metadata, never history or plaintext. */
export function useRealtimeNotifications(live: SecureRealtimeWorkspace | undefined, actorId: string, conversationId: string | null, chatActive: boolean,
  onIncoming?: (event: MessageNotice) => void) {
  const snapshot = useSyncExternalStore(live?.subscribe ?? noSubscription, live?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const [message, setMessage] = useState<MessageNotice | null>(null);
  const seen = useRef(new Set<string>());
  const incomingCallback = useRef(onIncoming); incomingCallback.current = onIncoming;
  useEffect(() => {
    seen.current.clear(); setMessage(null);
    const cached = live?.getSnapshot().incomingMessage;
    if (cached) seen.current.add(JSON.stringify([cached.conversationId, cached.id]));
  }, [live, actorId]);
  useEffect(() => {
    const event = snapshot.incomingMessage;
    if (!event) return;
    const id = JSON.stringify([event.conversationId, event.id]);
    if (seen.current.has(id)) return;
    seen.current.add(id);
    if (seen.current.size > 1000) seen.current.delete(seen.current.values().next().value!);
    if (event.senderId === actorId || !snapshot.conversations.some(c => c.id === event.conversationId && c.interactionAllowed)) return;
    incomingCallback.current?.(event);
    if (chatActive && conversationId === event.conversationId && !document.hidden) return;
    setMessage(event);
  }, [snapshot.incomingMessage, snapshot.conversations, actorId, chatActive, conversationId]);
  useEffect(() => {
    if (message && (!snapshot.conversations.some(c => c.id === message.conversationId && c.interactionAllowed) ||
      chatActive && conversationId === message.conversationId && !document.hidden)) setMessage(null);
  }, [message, snapshot.conversations, conversationId, chatActive]);
  useEffect(() => {
    const visible = () => { if (!document.hidden && chatActive) setMessage(current => current?.conversationId === conversationId ? null : current); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [chatActive, conversationId]);
  const dismissMessage = useCallback(() => setMessage(null), []);
  return { snapshot, message, dismissMessage };
}
