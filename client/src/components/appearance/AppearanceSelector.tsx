'use client';

import { useId } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/theme';
import type { ThemePreference } from '@/theme';

const appearanceOptions = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

/** Browser appearance is independent of the editable profile identity. */
export function AppearanceSelector() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const controlId = useId();
  const hintId = `${controlId}-appearance-hint`;

  return (
    <fieldset className="appearance-selector" aria-describedby={hintId}>
      <legend>Appearance</legend>
      <p className="appearance-description" id={hintId}>Applies immediately. System follows your device.</p>
      <div className="appearance-options">
        {appearanceOptions.map(({ Icon, label, value }) => (
          <label className={`appearance-option ${preference === value ? 'is-selected' : ''}`} key={value}>
            <input
              type="radio"
              name={`${controlId}-appearance`}
              value={value}
              checked={preference === value}
              onChange={() => setPreference(value as ThemePreference)}
            />
            <Icon className="appearance-icon" size={17} aria-hidden="true" />
            <span className="appearance-label">{label}</span>
          </label>
        ))}
      </div>
      <p className="appearance-current" role="status" aria-live="polite" aria-atomic="true">
        {resolvedTheme === 'dark' ? 'Dark' : 'Light'} mode is active.
      </p>
    </fieldset>
  );
}
