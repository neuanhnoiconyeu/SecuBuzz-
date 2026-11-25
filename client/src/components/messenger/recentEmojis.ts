import { useSyncExternalStore } from 'react';
import { findEmoji } from './emojiData';

export const RECENT_EMOJI_KEY = 'secubuzz:recent-emojis:v1';
export const MAX_RECENT_EMOJIS = 24;
const empty: string[] = [];
let recent: string[] = empty, stored: string | null | undefined;
const listeners = new Set<() => void>();
const parse = (value: string | null): string[] => {
  try {
    if (!value || value.length > 4096) return [];
    const input: unknown = JSON.parse(value);
    return Array.isArray(input) ? [...new Set(input.filter((emoji): emoji is string => typeof emoji === 'string' && Boolean(findEmoji(emoji))))].slice(0, MAX_RECENT_EMOJIS) : [];
  } catch { return []; }
};
function snapshot(): string[] {
  if (typeof window === 'undefined') return empty;
  try {
    const value = window.localStorage.getItem(RECENT_EMOJI_KEY);
    if (value !== stored) { stored = value; recent = parse(value); }
  } catch { /* Restricted storage keeps the in-memory preference usable. */ }
  return recent;
}
export function rememberEmoji(emoji: string): void {
  if (!findEmoji(emoji)) return;
  recent = [emoji, ...snapshot().filter(previous => previous !== emoji)].slice(0, MAX_RECENT_EMOJIS);
  try { const value = JSON.stringify(recent); window.localStorage.setItem(RECENT_EMOJI_KEY, value); stored = value; }
  catch { /* Only known emoji are stored; no message or account content is retained. */ }
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  const update = (event: StorageEvent) => {
    if (event.key === RECENT_EMOJI_KEY || event.key === null) { stored = undefined; snapshot(); listeners.forEach(notify => notify()); }
  };
  listeners.add(listener); window.addEventListener('storage', update);
  return () => { listeners.delete(listener); window.removeEventListener('storage', update); };
}
export const useRecentEmojis = () => useSyncExternalStore(subscribe, snapshot, () => empty);
