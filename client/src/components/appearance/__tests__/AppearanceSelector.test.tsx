import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, THEME_STORAGE_KEY } from '@/theme';
import { AppearanceSelector } from '../AppearanceSelector';

beforeEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
});

afterEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
});

describe('AppearanceSelector', () => {
  test('uses one native radio group and applies a selected preference without replacing its focused control', () => {
    render(<ThemeProvider><AppearanceSelector /></ThemeProvider>);
    const group = screen.getByRole('group', { name: 'Appearance' });
    const light = screen.getByRole('radio', { name: 'Light' });
    const dark = screen.getByRole('radio', { name: 'Dark' });
    const system = screen.getByRole('radio', { name: 'System' });
    expect(group).toHaveAccessibleDescription('Applies immediately. System follows your device.');
    expect(system).toBeChecked();
    expect(light).not.toBeChecked();
    expect(dark).not.toBeChecked();
    expect(light).toHaveAttribute('name', dark.getAttribute('name'));
    expect(system).toHaveAttribute('name', dark.getAttribute('name'));

    dark.focus();
    fireEvent.click(dark);

    expect(screen.getByRole('radio', { name: 'Dark' })).toBe(dark);
    expect(dark).toHaveFocus();
    expect(dark).toBeChecked();
    expect(system).not.toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('status')).toHaveTextContent('Dark mode is active.');

    fireEvent.click(light);
    expect(light).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(screen.getByRole('status')).toHaveTextContent('Light mode is active.');
  });

  test('remains safe when rendered outside the application provider', () => {
    render(<AppearanceSelector />);

    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('Light mode is active.');
  });
});
