'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  applyResolvedTheme,
  isThemePreference,
  persistThemePreference,
  readThemePreference,
  resolveTheme,
  SYSTEM_THEME_QUERY,
} from './themeModel';
import type { ResolvedTheme, ThemePreference } from './themeModel';

export interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
}

interface ThemeState {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
}

// Standalone shared-component renders have a safe, hydration-compatible default.
const ThemeContext = createContext<ThemeContextValue>({
  preference: 'system',
  resolvedTheme: 'light',
  setPreference: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Browser preferences are read after hydration. The head bootstrap already
  // applies the correct CSS theme before paint without changing component markup.
  const [state, setState] = useState<ThemeState>({ preference: 'system', resolvedTheme: 'light' });
  const preferenceRef = useRef<ThemePreference>('system');
  const systemDarkRef = useRef(false);

  const setPreference = useCallback((preference: ThemePreference) => {
    if (!isThemePreference(preference)) return;
    preferenceRef.current = preference;
    const resolvedTheme = resolveTheme(preference, systemDarkRef.current);
    applyResolvedTheme(resolvedTheme);
    setState((current) => current.preference === preference && current.resolvedTheme === resolvedTheme
      ? current
      : { preference, resolvedTheme });
    persistThemePreference(preference);
  }, []);

  useEffect(() => {
    let systemPreference: MediaQueryList | null = null;
    try {
      if (typeof window.matchMedia === 'function') systemPreference = window.matchMedia(SYSTEM_THEME_QUERY);
    } catch {
      // Older or restricted environments retain a usable light system fallback.
    }

    systemDarkRef.current = systemPreference?.matches === true;
    const preference = readThemePreference();
    preferenceRef.current = preference;
    const resolvedTheme = resolveTheme(preference, systemDarkRef.current);
    applyResolvedTheme(resolvedTheme);
    setState((current) => current.preference === preference && current.resolvedTheme === resolvedTheme
      ? current
      : { preference, resolvedTheme });

    const onSystemThemeChange = (event: MediaQueryListEvent) => {
      systemDarkRef.current = event.matches === true;
      if (preferenceRef.current !== 'system') return;
      const nextTheme = resolveTheme('system', systemDarkRef.current);
      applyResolvedTheme(nextTheme);
      setState((current) => current.resolvedTheme === nextTheme
        ? current
        : { preference: 'system', resolvedTheme: nextTheme });
    };

    if (typeof systemPreference?.addEventListener === 'function') systemPreference.addEventListener('change', onSystemThemeChange);
    else if (typeof systemPreference?.addListener === 'function') systemPreference.addListener(onSystemThemeChange);
    return () => {
      if (typeof systemPreference?.removeEventListener === 'function') systemPreference.removeEventListener('change', onSystemThemeChange);
      else if (typeof systemPreference?.removeListener === 'function') systemPreference.removeListener(onSystemThemeChange);
    };
  }, []);

  const value = useMemo(() => ({ ...state, setPreference }), [setPreference, state]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
