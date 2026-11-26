// Native Unicode data from the existing emoji-picker-react dependency (MIT), without image/CDN assets.
import unicodeData from 'emoji-picker-react/src/data/emojis.json';

export const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡'];
export type EmojiCategoryId = 'smileys' | 'people' | 'animals' | 'food' | 'activities' | 'travel' | 'objects' | 'symbols' | 'flags';
export interface EmojiEntry { emoji: string; name: string; keywords: string[]; category: EmojiCategoryId }
interface DataEmoji { u: string; n: string[]; v?: string[] }
const groups = unicodeData.emojis as Record<string, DataEmoji[]>;
const categoryDefinitions: Array<{ id: EmojiCategoryId; label: string; icon: string; source: string }> = [
  { id: 'smileys', label: 'Smileys', icon: '😀', source: 'smileys_people' },
  { id: 'people', label: 'People', icon: '👋', source: 'smileys_people' },
  { id: 'animals', label: 'Animals', icon: '🐶', source: 'animals_nature' },
  { id: 'food', label: 'Food', icon: '🍕', source: 'food_drink' },
  { id: 'activities', label: 'Activities', icon: '⚽', source: 'activities' },
  { id: 'travel', label: 'Travel', icon: '🚗', source: 'travel_places' },
  { id: 'objects', label: 'Objects', icon: '💡', source: 'objects' },
  { id: 'symbols', label: 'Symbols', icon: '💜', source: 'symbols' },
  { id: 'flags', label: 'Flags', icon: '🏁', source: 'flags' },
];
const native = (unified: string) => String.fromCodePoint(...unified.split('-').map(code => parseInt(code, 16)));
const tones: Record<string, string> = { '1f3fb': 'light', '1f3fc': 'medium-light', '1f3fd': 'medium', '1f3fe': 'medium-dark', '1f3ff': 'dark' };
// CLDR orders Smileys & Emotion before People & Body; waving hand starts the latter group.
const peopleStart = groups.smileys_people!.findIndex(entry => entry.u === '1f44b');
const entries = new Map<string, EmojiEntry>();
export const EMOJI_CATEGORIES = categoryDefinitions.map(category => {
  let data = groups[category.source] ?? [];
  if (category.id === 'smileys') data = data.slice(0, peopleStart);
  if (category.id === 'people') data = data.slice(peopleStart);
  const emojis: string[] = [];
  for (const entry of data) {
    for (const unified of [entry.u, ...(Array.isArray(entry.v) ? entry.v : [])]) {
      const emoji = native(unified);
      if (entries.has(emoji)) continue;
      const tone = unified !== entry.u ? unified.split('-').filter(code => tones[code]).map(code => tones[code]).join(' and ') : '';
      const name = `${entry.n.at(-1) ?? emoji}${tone ? `: ${tone} skin tone` : ''}`;
      entries.set(emoji, { emoji, name, keywords: [...entry.n, name], category: category.id });
      emojis.push(emoji);
    }
  }
  return { id: category.id, label: category.label, icon: category.icon, emojis };
});
export const ALL_EMOJIS = [...entries.values()];
const withoutPresentation = (text: string) => text.replace(/\ufe0f/g, '');
const presentationEntries = new Map(ALL_EMOJIS.map(entry => [withoutPresentation(entry.emoji), entry]));
export const findEmoji = (emoji: string): EmojiEntry | undefined => entries.get(emoji) ?? presentationEntries.get(withoutPresentation(emoji));
export const emojiName = (emoji: string): string => findEmoji(emoji)?.name ?? emoji;
const normalize = (text: string) => text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[_:-]/g, ' ');
const searchable = ALL_EMOJIS.map(entry => ({ entry, name: normalize(entry.name), text: normalize(entry.keywords.join(' ')) }));
export function searchEmoji(query: string): EmojiEntry[] {
  const normalized = normalize(query).trim(), words = normalized.split(/\s+/u).filter(Boolean);
  const rank = ({ entry, name }: typeof searchable[number]) => name === normalized || entry.emoji === query.trim() ? 2 : words.every(word => name.includes(word)) ? 1 : 0;
  return searchable.filter(({ entry, text }) => words.every(word => text.includes(word) || entry.emoji.includes(word)))
    .sort((left, right) => rank(right) - rank(left)).map(({ entry }) => entry);
}

type GraphemeSegmenter = { segment(text: string): Iterable<{ segment: string }> };
const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locale: string, options: { granularity: 'grapheme' }) => GraphemeSegmenter }).Segmenter;
const segmenter = Segmenter ? new Segmenter('en', { granularity: 'grapheme' }) : null;
const MAX_EMOJI_ONLY_TEXT_LENGTH = 8192;
function emojiGraphemes(text: string): string[] | null {
  if (!segmenter || !text.trim() || text.includes('\ufe0e')) return null;
  const parts = [...segmenter.segment(text.trim())].map(part => part.segment).filter(part => !/^\s+$/u.test(part));
  return parts.length > 0 && parts.every(part => Boolean(findEmoji(part))) ? parts : null;
}
/** Enlarge short, standalone emoji messages; never treat plain digits, punctuation or text as emoji. */
export function emojiOnlyCount(text: string): number {
  if (text.length > 128) return 0;
  const parts = emojiGraphemes(text);
  return parts && parts.length <= 3 ? parts.length : 0;
}
/** Detect any non-empty message composed exclusively of Unicode emojis and optional whitespace. */
export function isEmojiOnlyMessage(text: string): boolean {
  if (text.length > MAX_EMOJI_ONLY_TEXT_LENGTH) return false;
  return emojiGraphemes(text) !== null;
}
