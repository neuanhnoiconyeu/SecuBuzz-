import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/messaging/messageModel';

const ENTRY_CLEANUP_MS = 300;
// Set entry flags before the browser paints, while keeping server rendering quiet.
const usePresentationEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function messageIdentity(message: ChatMessage): string {
  return JSON.stringify([message.conversationId, message.id]);
}

/** Presentation only: already displayed/history messages never replay their entrance. */
export function useMessageEntryMotion(messages: ChatMessage[], active: boolean) {
  const previousIds = useRef(messages.map(messageIdentity));
  const seenIds = useRef(new Set(previousIds.current));
  const reducedMotion = useRef(true);
  const cleanupTimers = useRef(new Set<number>());
  const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(() => new Set());

  const finishEntries = useCallback((ids: readonly string[]) => {
    setEnteringIds((current) => {
      if (!ids.some((id) => current.has(id))) return current;
      const next = new Set(current);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const clearEntries = useCallback(() => {
    cleanupTimers.current.forEach((timer) => window.clearTimeout(timer));
    cleanupTimers.current.clear();
    setEnteringIds((current) => current.size > 0 ? new Set() : current);
  }, []);

  usePresentationEffect(() => {
    const preference = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    reducedMotion.current = preference?.matches ?? false;
    const onPreferenceChange = (event: MediaQueryListEvent) => {
      reducedMotion.current = event.matches;
      if (event.matches) clearEntries();
    };

    if (preference?.addEventListener) preference.addEventListener('change', onPreferenceChange);
    else preference?.addListener?.(onPreferenceChange);

    return () => {
      if (preference?.removeEventListener) preference.removeEventListener('change', onPreferenceChange);
      else preference?.removeListener?.(onPreferenceChange);
      cleanupTimers.current.forEach((timer) => window.clearTimeout(timer));
      cleanupTimers.current.clear();
    };
  }, [clearEntries]);

  usePresentationEffect(() => {
    const currentIds = messages.map(messageIdentity);
    const isAppend = currentIds.length >= previousIds.current.length
      && previousIds.current.every((id, index) => currentIds[index] === id);
    const freshIds = isAppend
      ? messages.slice(previousIds.current.length)
        .filter((message) => message.type === 'text' && !seenIds.current.has(messageIdentity(message)))
        .map((message) => message.id)
      : [];

    // Hidden/reduced-motion arrivals and prepended history are still seen, never deferred.
    currentIds.forEach((id) => seenIds.current.add(id));
    previousIds.current = currentIds;

    if (!active || reducedMotion.current || !isAppend) {
      clearEntries();
      return;
    }
    if (freshIds.length === 0) return;

    setEnteringIds((current) => new Set([...current, ...freshIds]));
    const timer = window.setTimeout(() => {
      cleanupTimers.current.delete(timer);
      finishEntries(freshIds);
    }, ENTRY_CLEANUP_MS);
    cleanupTimers.current.add(timer);
  }, [active, clearEntries, finishEntries, messages]);

  return {
    enteringIds,
    finishEntry: (id: string) => finishEntries([id]),
  };
}
