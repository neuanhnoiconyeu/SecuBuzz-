import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { EMOJI_CATEGORIES, findEmoji, searchEmoji } from './emojiData';
import { rememberEmoji, useRecentEmojis } from './recentEmojis';
import './emoji-picker.css';

export function EmojiPicker({ onSelect, onClose, selected, reaction = false, disabled = false }: {
  onSelect(emoji: string): void; onClose(): void; selected?: ReadonlySet<string>; reaction?: boolean; disabled?: boolean;
}) {
  const recent = useRecentEmojis();
  const [category, setCategory] = useState(recent.length ? 'recent' : 'smileys');
  const [query, setQuery] = useState(''), [focused, setFocused] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const id = useId();
  const categories = [{ id: 'recent', label: 'Recently Used', icon: '🕘', emojis: recent }, ...EMOJI_CATEGORIES];
  const current = categories.find(candidate => candidate.id === category)!;
  const results = useMemo(() => query.trim() ? searchEmoji(query) :
    (category === 'recent' ? recent : EMOJI_CATEGORIES.find(candidate => candidate.id === category)!.emojis).map(emoji => findEmoji(emoji)!), [query, category, recent]);
  useEffect(() => { setFocused(0); if (grid.current) grid.current.scrollTop = 0; }, [query, category]);
  const focusResult = (index: number) => {
    const buttons = grid.current?.querySelectorAll<HTMLButtonElement>('[data-emoji]');
    const button = buttons?.[index]; if (!button) return;
    setFocused(index); button.focus({ preventScroll: true }); button.scrollIntoView?.({ block: 'nearest' });
  };
  const navigateGrid = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.dataset.emoji) return;
    const columns = Number.parseInt(getComputedStyle(grid.current!).getPropertyValue('--emoji-columns'), 10) || 6;
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = Math.min(results.length - 1, focused + 1);
    if (event.key === 'ArrowLeft') next = Math.max(0, focused - 1);
    if (event.key === 'ArrowDown') next = Math.min(results.length - 1, focused + columns);
    if (event.key === 'ArrowUp') next = Math.max(0, focused - columns);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = results.length - 1;
    if (next !== undefined) { event.preventDefault(); event.stopPropagation(); focusResult(next); }
  };
  return <div className="emoji-picker" onKeyDown={navigateGrid}>
    <div className="emoji-picker-search">
      <Search size={16} aria-hidden="true" />
      <input type="search" aria-label="Search emoji" placeholder="Search emoji by name" value={query} autoComplete="off" disabled={disabled}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          // This picker also lives inside the composer form. Searching must never send its draft.
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); }
          if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); event.stopPropagation(); focusResult(0); }
        }} />
      <button type="button" className="emoji-picker-close" aria-label={reaction ? 'Close reaction picker' : 'Close emoji picker'} onClick={onClose}><X size={17} aria-hidden="true" /></button>
    </div>
    <div className="emoji-picker-categories" role="tablist" aria-label="Emoji categories">
      {categories.map((item, index) => <button key={item.id} type="button" id={`${id}-${item.id}`} role="tab" aria-selected={category === item.id} disabled={disabled}
        aria-label={item.label} title={item.label} aria-controls={`${id}-results`} tabIndex={category === item.id ? 0 : -1}
        onClick={() => { setCategory(item.id); setQuery(''); }} onKeyDown={event => {
          let next: number | undefined;
          if (event.key === 'ArrowRight') next = (index + 1) % categories.length;
          if (event.key === 'ArrowLeft') next = (index + categories.length - 1) % categories.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = categories.length - 1;
          if (next !== undefined) { event.preventDefault(); event.stopPropagation(); const target = categories[next]!; setCategory(target.id); setQuery(''); document.getElementById(`${id}-${target.id}`)?.focus(); }
        }}>{item.icon}</button>)}
    </div>
    <p className="emoji-picker-caption" role="status" aria-live="polite">{query.trim() ? `${results.length} emojis found` : current.label}</p>
    <div id={`${id}-results`} ref={grid} className="emoji-picker-grid" role="tabpanel" aria-label={query.trim() ? 'Emoji search results' : current.label}>
      {results.map((entry, index) => <button key={entry.emoji} data-emoji={entry.emoji} type="button" className="emoji-picker-choice" disabled={disabled}
        aria-label={`${reaction ? 'React with' : 'Insert'} ${entry.name} ${entry.emoji}`} title={entry.name}
        aria-pressed={reaction ? Boolean(selected?.has(entry.emoji)) : undefined} tabIndex={index === Math.min(focused, results.length - 1) ? 0 : -1}
        onFocus={() => setFocused(index)} onClick={() => { rememberEmoji(entry.emoji); onSelect(entry.emoji); }}>{entry.emoji}</button>)}
      {!results.length && <p className="emoji-picker-empty">{query.trim() ? 'No matching emoji. Try another name.' : 'Choose an emoji to add it here.'}</p>}
    </div>
  </div>;
}
