import { ALL_EMOJIS, EMOJI_CATEGORIES, QUICK_EMOJIS, emojiOnlyCount, findEmoji, searchEmoji } from '../emojiData';

test('the installed Unicode collection covers all nine categories, names, flags and variations without duplicates', () => {
  expect(EMOJI_CATEGORIES.map(category => category.label)).toEqual(['Smileys', 'People', 'Animals', 'Food', 'Activities', 'Travel', 'Objects', 'Symbols', 'Flags']);
  expect(ALL_EMOJIS.length).toBeGreaterThan(3500);
  expect(new Set(ALL_EMOJIS.map(entry => entry.emoji)).size).toBe(ALL_EMOJIS.length);
  for (const emoji of QUICK_EMOJIS) expect(findEmoji(emoji)?.name).toBeTruthy();
  expect(findEmoji('😀')?.category).toBe('smileys'); expect(findEmoji('👋')?.category).toBe('people');
  expect(findEmoji('🐶')?.category).toBe('animals'); expect(findEmoji('🍕')?.category).toBe('food');
  expect(findEmoji('⚽')?.category).toBe('activities'); expect(findEmoji('🚗')?.category).toBe('travel');
  expect(findEmoji('💡')?.category).toBe('objects'); expect(findEmoji('✅')?.category).toBe('symbols');
  expect(findEmoji('🇻🇳')?.category).toBe('flags'); expect(findEmoji('👍🏽')?.name).toContain('medium skin tone');
});

test('search matches full names, aliases, multiple words and native characters', () => {
  expect(searchEmoji('pizza')[0]?.emoji).toBe('🍕'); // Exact names precede related keyword matches such as mushrooms.
  expect(searchEmoji('GRINNING FACE').some(entry => entry.emoji === '😀')).toBe(true);
  expect(searchEmoji('vietnam').some(entry => entry.emoji === '🇻🇳')).toBe(true);
  expect(searchEmoji('woman technologist').some(entry => entry.emoji === '👩‍💻')).toBe(true);
  expect(searchEmoji('👍🏽').some(entry => entry.emoji === '👍🏽')).toBe(true);
  expect(searchEmoji('not-an-emoji-name-zzzz')).toEqual([]);
});

test.each([['😀', 1], ['👍🏽 👩‍💻', 2], ['👨‍👩‍👧‍👦 🇻🇳 1️⃣', 3], ['❤️', 1], ['  😀  ', 1],
  ['123', 0], ['#', 0], ['Hello 😀', 0], ['😀😀😀😀', 0], ['❤\ufe0e', 0], ['\n  ', 0]])('emoji-only presentation counts graphemes: %s', (text, count) => {
  expect(emojiOnlyCount(text as string)).toBe(count);
});
