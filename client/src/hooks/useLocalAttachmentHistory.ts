import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatMessage } from '@/messaging/messageModel';
import { appendMessage } from '@/messaging/messageState';
import { localAttachmentStore } from '@/messaging/localAttachmentStore';

type Messages = Record<string, ChatMessage[]>;
const fingerprint = (message: ChatMessage) => JSON.stringify({ ...message, encryption: undefined, voice: undefined });

export function useLocalAttachmentHistory(ownerId: string, conversationIds: readonly string[], enabled: boolean,
  messages: Messages, setMessages: Dispatch<SetStateAction<Messages>>) {
  const [loading, setLoading] = useState(enabled && typeof indexedDB !== 'undefined');
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const records = useRef(new Map<string, string>());
  const scopes = useRef(new Set<string>());
  const queue = useRef(Promise.resolve());
  const scopeKey = JSON.stringify(conversationIds);

  useEffect(() => {
    if (!enabled || typeof indexedDB === 'undefined') { setLoading(false); return; }
    let active = true;
    const ids = JSON.parse(scopeKey) as string[];
    setLoading(true);
    void localAttachmentStore.loadMessages(ownerId, ids).then((restored) => {
      if (!active) return;
      for (const message of restored) records.current.set(JSON.stringify([ownerId, message.conversationId, message.id]), fingerprint(message));
      ids.forEach((id) => scopes.current.add(JSON.stringify([ownerId, id])));
      setMessages((current) => restored.reduce(appendMessage, current));
      setRevision((value) => value + 1);
      setError(null);
    }, () => { if (active) setError('Saved attachments could not be restored. Check this site’s browser storage permissions.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [enabled, ownerId, scopeKey, setMessages]);

  useEffect(() => {
    if (!enabled || loading || typeof indexedDB === 'undefined') return;
    const currentKeys = new Set<string>();
    const schedule = (operation: () => Promise<void>) => {
      queue.current = queue.current.then(operation).catch(() => setError('Changes to saved attachments could not be stored. Check available browser storage.'));
    };
    for (const [conversationId, history] of Object.entries(messages)) {
      if (!scopes.current.has(JSON.stringify([ownerId, conversationId]))) continue;
      for (const message of history) {
        const key = JSON.stringify([ownerId, conversationId, message.id]);
        if (!records.current.has(key) && !message.attachments?.some((file) => file.storage === 'indexeddb')) continue;
        currentKeys.add(key);
        const next = fingerprint(message);
        if (records.current.get(key) === next) continue;
        records.current.set(key, next);
        schedule(() => localAttachmentStore.saveMessage(ownerId, message));
      }
    }
    for (const key of Array.from(records.current.keys())) {
      const [owner, conversation, messageId] = JSON.parse(key) as [string, string, string];
      if (owner !== ownerId || !scopes.current.has(JSON.stringify([ownerId, conversation])) || currentKeys.has(key)) continue;
      records.current.delete(key);
      schedule(() => localAttachmentStore.removeMessage(ownerId, conversation, messageId));
    }
  }, [enabled, loading, messages, ownerId, revision]);

  const persistMessage = useCallback(async (message: ChatMessage) => {
    if (!enabled || !message.attachments?.some((file) => file.storage === 'indexeddb')) return;
    try { await localAttachmentStore.saveMessage(ownerId, message); setError(null); }
    catch (failure) { setError('The attachment message could not be saved on this device. Your draft is still here.'); throw failure; }
  }, [enabled, ownerId]);
  return { loading, error, persistMessage };
}
