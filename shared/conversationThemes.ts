export const CONVERSATION_THEMES = [
  { id: 'default', label: 'Default', quickEmoji: '👍' },
  { id: 'ocean', label: 'Ocean', quickEmoji: '🌊' },
  { id: 'sunset', label: 'Sunset', quickEmoji: '🌅' },
  { id: 'forest', label: 'Forest', quickEmoji: '🌿' },
  { id: 'berry', label: 'Berry', quickEmoji: '🫐' },
  { id: 'midnight', label: 'Midnight', quickEmoji: '🌙' },
] as const;

export type ConversationThemeId = typeof CONVERSATION_THEMES[number]['id'];

export function isConversationThemeId(value: unknown): value is ConversationThemeId {
  return typeof value === 'string' && CONVERSATION_THEMES.some((theme) => theme.id === value);
}

export function getConversationTheme(id?: string | null) {
  return CONVERSATION_THEMES.find((theme) => theme.id === id) ?? CONVERSATION_THEMES[0];
}
