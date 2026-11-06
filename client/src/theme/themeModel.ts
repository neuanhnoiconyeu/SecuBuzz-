export const THEME_STORAGE_KEY = 'secubuzz-theme';
export const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';
// Browser chrome needs concrete colors before the stylesheet has loaded.
export const THEME_BROWSER_COLORS = { light: '#e9e4ef', dark: '#14151c' } as const;

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? systemDark ? 'dark' : 'light' : preference;
}

/** Only a non-sensitive appearance preference is read from browser storage. */
export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked or full storage area must not prevent an in-session theme change.
  }
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_BROWSER_COLORS[theme]);
}
