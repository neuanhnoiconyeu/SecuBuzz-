import { act, fireEvent, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { ThemeProvider, THEME_BROWSER_COLORS, THEME_STORAGE_KEY, useTheme } from '..';
import { THEME_BOOTSTRAP_SCRIPT } from '../themeScript';

function ThemeControls() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  return <div>
    <p data-testid="theme-state">{preference}:{resolvedTheme}</p>
    <button onClick={() => setPreference('light')}>Light</button>
    <button onClick={() => setPreference('dark')}>Dark</button>
    <button onClick={() => setPreference('system')}>System</button>
  </div>;
}

describe('theme initialization and preference state', () => {
  let originalMedia: PropertyDescriptor | undefined;
  let originalStorage: PropertyDescriptor | undefined;
  let systemDark: boolean;
  let listeners: Set<(event: MediaQueryListEvent) => void>;
  let themeColorMeta: HTMLMetaElement;

  beforeEach(() => {
    originalMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('color-scheme');
    themeColorMeta = document.createElement('meta');
    themeColorMeta.name = 'theme-color';
    themeColorMeta.content = THEME_BROWSER_COLORS.light;
    document.head.appendChild(themeColorMeta);
    systemDark = false;
    listeners = new Set();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({
        get matches() { return systemDark; },
        media: '(prefers-color-scheme: dark)',
        addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => listeners.add(callback),
        removeEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => listeners.delete(callback),
      })),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalMedia) Object.defineProperty(window, 'matchMedia', originalMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
    if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage);
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('color-scheme');
    themeColorMeta.remove();
  });

  const changeSystem = (dark: boolean) => {
    systemDark = dark;
    act(() => listeners.forEach((callback) => callback({ matches: dark } as MediaQueryListEvent)));
  };
  const bootstrap = () => new Function('window', 'document', THEME_BOOTSTRAP_SCRIPT)(window, document);

  test('defaults to the operating system and updates its resolved theme without persisting an unsolicited preference', () => {
    systemDark = true;
    const { unmount } = render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(themeColorMeta.content).toBe(THEME_BROWSER_COLORS.dark);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    changeSystem(false);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(themeColorMeta.content).toBe(THEME_BROWSER_COLORS.light);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });

  test('updates and persists explicit preferences, ignores OS overrides, and resumes the latest OS preference in System mode', () => {
    render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByTestId('theme-state')).toHaveTextContent('dark:dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    changeSystem(true);
    changeSystem(false);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('dark:dark');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    changeSystem(true);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('light:light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  test('restores a persisted preference in a fresh provider mount', () => {
    const first = render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    first.unmount();
    render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('dark:dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  test('rejects invalid stored values and consistently uses System in the head script and provider', () => {
    systemDark = true;
    window.localStorage.setItem(THEME_STORAGE_KEY, '<script>not-a-theme</script>');
    bootstrap();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:dark');
  });

  test('continues working when access to browser storage is blocked', () => {
    systemDark = true;
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    expect(bootstrap).not.toThrow();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(screen.getByTestId('theme-state')).toHaveTextContent('light:light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    changeSystem(false);
    changeSystem(true);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('light:light');
  });

  test('keeps an immediate in-session update when a storage write fails', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByTestId('theme-state')).toHaveTextContent('dark:dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  test.each(['unavailable', 'throws', 'malformed'] as const)('safely initializes without usable matchMedia (%s)', (mode) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: mode === 'unavailable' ? undefined : mode === 'malformed'
        ? () => ({ matches: 'dark', addEventListener: 'invalid listener method' })
        : () => { throw new Error('No media API'); },
    });
    expect(bootstrap).not.toThrow();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:light');
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  test('supports legacy media listeners and cleans them up', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({
      matches: false,
      addListener: (callback: (event: MediaQueryListEvent) => void) => listeners.add(callback),
      removeListener: (callback: (event: MediaQueryListEvent) => void) => listeners.delete(callback),
    }) });
    const { unmount } = render(<ThemeProvider><ThemeControls /></ThemeProvider>);
    changeSystem(true);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    unmount();
    expect(listeners.size).toBe(0);
  });

  test('bootstraps a stored dark preference before hydration while keeping server/client markup compatible', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const component = <ThemeProvider><ThemeControls /></ThemeProvider>;
    const serverMarkup = renderToString(component);
    expect(serverMarkup).toContain('system');
    const container = document.createElement('div');
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);
    bootstrap();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(themeColorMeta.content).toBe(THEME_BROWSER_COLORS.dark);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    let root: Root | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, component); });
      expect(container).toHaveTextContent('dark:dark');
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      act(() => root?.unmount());
      container.remove();
    }
  });

  test('standalone components outside the provider have a safe default', () => {
    render(<ThemeControls />);
    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:light');
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Dark' }))).not.toThrow();
  });
});
