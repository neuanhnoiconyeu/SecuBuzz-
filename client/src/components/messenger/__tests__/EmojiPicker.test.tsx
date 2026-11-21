import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { EmojiPicker } from '../EmojiPicker';
import { ALL_EMOJIS } from '../emojiData';
import { MAX_RECENT_EMOJIS, RECENT_EMOJI_KEY, rememberEmoji } from '../recentEmojis';

beforeEach(() => localStorage.clear());
afterEach(() => jest.restoreAllMocks());

test('search, category navigation and Recently Used share named, native Unicode selections', () => {
  const select = jest.fn(); const { unmount } = render(<EmojiPicker onSelect={select} onClose={jest.fn()} />);
  expect(screen.getAllByRole('tab')).toHaveLength(10);
  fireEvent.click(screen.getByRole('tab', { name: 'Flags' }));
  expect(screen.getByRole('tabpanel', { name: 'Flags' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'vietnam' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert flag: Vietnam 🇻🇳' }));
  expect(select).toHaveBeenCalledWith('🇻🇳');
  fireEvent.click(screen.getByRole('tab', { name: 'Recently Used' }));
  expect(within(screen.getByRole('tabpanel', { name: 'Recently Used' })).getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Insert flag: Vietnam 🇻🇳' }));
  expect(JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY)!)).toEqual(['🇻🇳']);
  unmount(); render(<EmojiPicker onSelect={select} onClose={jest.fn()} />);
  expect(screen.getByRole('tab', { name: 'Recently Used' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: 'Insert flag: Vietnam 🇻🇳' })).toBeInTheDocument();
});

test('keyboard navigation supports search-to-results, arrows, Home/End and roving categories', () => {
  render(<EmojiPicker onSelect={jest.fn()} onClose={jest.fn()} />);
  const search = screen.getByRole('searchbox', { name: 'Search emoji' }); search.focus();
  expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true);
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  const buttons = within(screen.getByRole('tabpanel', { name: 'Smileys' })).getAllByRole('button');
  expect(buttons[0]).toHaveFocus(); fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }); expect(buttons[1]).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }); expect(buttons[7]).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'End' }); expect(buttons.at(-1)).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Home' }); expect(buttons[0]).toHaveFocus();
  expect(buttons.filter(button => button.tabIndex === 0)).toHaveLength(1);
  const smileys = screen.getByRole('tab', { name: 'Smileys' }); smileys.focus();
  fireEvent.keyDown(smileys, { key: 'ArrowRight' }); expect(screen.getByRole('tab', { name: 'People' })).toHaveFocus();
  expect(screen.getByRole('tab', { name: 'People' })).toHaveAttribute('aria-selected', 'true');
});

test('empty results, selected reactions and closing have accessible controls', () => {
  const select = jest.fn(), close = jest.fn(); render(<EmojiPicker reaction selected={new Set(['👍'])} onSelect={select} onClose={close} />);
  const search = screen.getByRole('searchbox', { name: 'Search emoji' });
  fireEvent.change(search, { target: { value: 'thumbs up' } });
  const selected = screen.getByRole('button', { name: 'React with thumbs up 👍' }); expect(selected).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(selected); expect(select).toHaveBeenCalledWith('👍');
  fireEvent.change(search, { target: { value: 'zzzz-no-result' } }); expect(screen.getByText('No matching emoji. Try another name.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close reaction picker' })); expect(close).toHaveBeenCalledTimes(1);
});

test('recent preferences reject unrelated content and stay bounded across tabs', () => {
  localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(['private message', '<script>', '😀', '😀']));
  render(<EmojiPicker onSelect={jest.fn()} onClose={jest.fn()} />);
  expect(screen.getByRole('button', { name: 'Insert grinning face 😀' })).toBeInTheDocument(); expect(screen.queryByText('private message')).not.toBeInTheDocument();
  act(() => { ALL_EMOJIS.slice(0, 40).forEach(entry => rememberEmoji(entry.emoji)); });
  const saved: string[] = JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY)!); expect(saved).toHaveLength(MAX_RECENT_EMOJIS); expect(new Set(saved).size).toBe(saved.length);
  act(() => { localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(['🍕'])); window.dispatchEvent(new StorageEvent('storage', { key: RECENT_EMOJI_KEY })); });
  expect(screen.getByRole('button', { name: 'Insert pizza 🍕' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Insert grinning face 😀' })).not.toBeInTheDocument();
});

test('unavailable browser storage keeps emoji selection and recent history usable in memory', () => {
  render(<EmojiPicker onSelect={jest.fn()} onClose={jest.fn()} />);
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  fireEvent.click(screen.getByRole('button', { name: 'Insert grinning face 😀' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Recently Used' })); expect(screen.getByRole('button', { name: 'Insert grinning face 😀' })).toBeInTheDocument();
});
