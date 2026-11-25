// Browser-profile preferences only. Never remove encrypted history or call a message API.
export const LOCAL_HIDDEN_MESSAGE_PREFIX = 'secubuzz:real-hidden-message:v1:';
const changedEvent = 'secubuzz:local-hidden-messages-changed';
export interface LocalHiddenMessagesSnapshot {
  readonly hidden: ReadonlySet<string>;
  readonly unavailable: boolean;
}
const empty: LocalHiddenMessagesSnapshot = { hidden: new Set(), unavailable: false };
const snapshots = new Map<string, LocalHiddenMessagesSnapshot>();
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512;
// JSON tuples avoid delimiter collisions; wire IDs are unique within a server conversation.
export const localHiddenMessageId = (conversationId: string, messageId: string) => JSON.stringify([conversationId, messageId]);

export function readLocalHiddenMessages(accountId: string): LocalHiddenMessagesSnapshot {
  if (typeof window === 'undefined') return empty;
  const previous = snapshots.get(accountId);
  try {
    const storage = window.localStorage, hidden = new Set<string>();
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(LOCAL_HIDDEN_MESSAGE_PREFIX) || storage.getItem(key) !== '1') continue;
      try {
        const tuple: unknown = JSON.parse(key.slice(LOCAL_HIDDEN_MESSAGE_PREFIX.length));
        if (Array.isArray(tuple) && tuple.length === 3) {
          const [owner, conversationId, messageId] = tuple;
          if (owner === accountId && validId(owner) && validId(conversationId) && validId(messageId)) hidden.add(localHiddenMessageId(conversationId, messageId));
        }
      } catch { /* Ignore malformed preferences; never interpret message content. */ }
    }
    if (previous && !previous.unavailable && hidden.size === previous.hidden.size && [...hidden].every(id => previous.hidden.has(id))) return previous;
    const snapshot = { hidden, unavailable: false };
    snapshots.set(accountId, snapshot); return snapshot;
  } catch {
    // Keep already loaded preferences when storage becomes unavailable during a session.
    if (previous?.unavailable) return previous;
    const snapshot = { hidden: previous?.hidden ?? empty.hidden, unavailable: true };
    snapshots.set(accountId, snapshot); return snapshot;
  }
}

export function hideLocalMessage(accountId: string, conversationId: string, messageId: string): void {
  if (![accountId, conversationId, messageId].every(validId) || typeof window === 'undefined') throw new Error('Invalid local message identity.');
  const previous = readLocalHiddenMessages(accountId);
  if (previous.unavailable) throw new Error('Browser storage is unavailable.');
  // One atomic marker per message avoids lost updates between tabs hiding different messages.
  window.localStorage.setItem(LOCAL_HIDDEN_MESSAGE_PREFIX + JSON.stringify([accountId, conversationId, messageId]), '1');
  snapshots.set(accountId, { hidden: new Set([...previous.hidden, localHiddenMessageId(conversationId, messageId)]), unavailable: false });
  window.dispatchEvent(new Event(changedEvent));
}

export function subscribeLocalHiddenMessages(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(LOCAL_HIDDEN_MESSAGE_PREFIX)) listener(); };
  window.addEventListener(changedEvent, listener);
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', listener);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', listener);
  };
}
export const emptyLocalHiddenMessages = () => empty;
