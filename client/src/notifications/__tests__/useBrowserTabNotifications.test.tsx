import { StrictMode, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BRAND_NAME } from '@/components/branding/brandConstants';
import type { DirectCallKind } from '@/calls/directCallMachine';
import { useBrowserTabNotifications } from '../useBrowserTabNotifications';

const artwork = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Original branding</title><path d="M1 1h20v20Z" fill="purple"/></svg>';
const originalFetch = global.fetch;
let previousTitle: string, icons: HTMLLinkElement[], originals: string[];
beforeEach(() => {
  previousTitle = document.title; document.title = BRAND_NAME;
  icons = [
    '<link rel="icon" href="/branding/favicon.svg" type="image/svg+xml" sizes="any">',
    '<link rel="icon" href="/branding/favicon-32.png" type="image/png" sizes="32x32">',
    '<link rel="shortcut icon" href="/branding/favicon-32.png">',
    '<link rel="apple-touch-icon" href="/branding/apple-touch-icon.png" sizes="180x180">',
  ].map(html => { const template = document.createElement('template'); template.innerHTML = html; const link = template.content.firstElementChild as HTMLLinkElement; document.head.append(link); return link; });
  originals = icons.map(icon => icon.outerHTML);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => artwork });
});
afterEach(() => { icons.forEach(icon => icon.remove()); document.title = previousTitle; global.fetch = originalFetch; });

test('title follows aggregate unread across conversations, caps at 99+, and clears only the counts supplied by the workspace', () => {
  const { rerender } = renderHook(({ unread }) => useBrowserTabNotifications(unread, null), { initialProps: { unread: {} as Record<string, number> } });
  expect(document.title).toBe(BRAND_NAME);
  rerender({ unread: { alice: 1 } }); expect(document.title).toBe(`(1) ${BRAND_NAME}`);
  rerender({ unread: { alice: 1, bob: 2 } }); expect(document.title).toBe(`(3) ${BRAND_NAME}`);
  rerender({ unread: { alice: 0, bob: 2 } }); expect(document.title).toBe(`(2) ${BRAND_NAME}`);
  rerender({ unread: { alice: 99 } }); expect(document.title).toBe(`(99) ${BRAND_NAME}`);
  rerender({ unread: { alice: 99, bob: 1 } }); expect(document.title).toBe(`(99+) ${BRAND_NAME}`);
  rerender({ unread: { alice: 0, bob: 0 } }); expect(document.title).toBe(BRAND_NAME);
});

test('invalid counts cannot break the title or invent negative unread', () => {
  renderHook(() => useBrowserTabNotifications({ bad: NaN, negative: -2, infinite: Infinity, valid: 2 }, null));
  expect(document.title).toBe(`(2) ${BRAND_NAME}`);
});

test.each(['voice', 'video'] as const)('incoming %s call takes title precedence without consuming unread messages', kind => {
  const { rerender } = renderHook(({ unread, call }) => useBrowserTabNotifications(unread, call),
    { initialProps: { unread: { alice: 2 }, call: null as DirectCallKind | null } });
  rerender({ unread: { alice: 2 }, call: kind }); expect(document.title).toBe(`(2) Incoming ${kind} call · ${BRAND_NAME}`);
  rerender({ unread: { alice: 3 }, call: kind }); expect(document.title).toBe(`(3) Incoming ${kind} call · ${BRAND_NAME}`);
  rerender({ unread: { alice: 0 }, call: kind }); expect(document.title).toBe(`Incoming ${kind} call · ${BRAND_NAME}`);
  rerender({ unread: { alice: 3 }, call: null }); expect(document.title).toBe(`(3) ${BRAND_NAME}`);
});

test('the branded favicon gets a dot without replacing nodes or Apple icons and is restored exactly at zero', async () => {
  const { rerender } = renderHook(({ unread }) => useBrowserTabNotifications(unread, null), { initialProps: { unread: {} as Record<string, number> } });
  expect(global.fetch).not.toHaveBeenCalled();
  rerender({ unread: { alice: 1 } });
  await waitFor(() => expect(icons[0].getAttribute('href')).toMatch(/^data:image\/svg\+xml/));
  const badge = icons[0].getAttribute('href')!;
  const decoded = decodeURIComponent(badge.slice(badge.indexOf(',') + 1));
  expect(decoded).toContain('Original branding'); expect(decoded).toContain('fill="purple"'); expect(decoded).toContain('data-notification-dot="true"');
  expect(icons.slice(0, 3).every(icon => icon.getAttribute('href') === badge && icon.type === 'image/svg+xml')).toBe(true);
  expect(icons[3].outerHTML).toBe(originals[3]);
  rerender({ unread: { alice: 1, bob: 5 } }); expect(global.fetch).toHaveBeenCalledTimes(1);
  rerender({ unread: {} }); expect(icons.map(icon => icon.outerHTML)).toEqual(originals);
  expect(icons.every(icon => icon.isConnected)).toBe(true);
});

test('focus/visibility changes and repeated snapshots neither clear nor increment unread', async () => {
  const counts = { alice: 1, bob: 2 };
  const { rerender } = renderHook(({ unread }) => useBrowserTabNotifications(unread, null), { initialProps: { unread: counts } });
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  rerender({ unread: { ...counts } }); rerender({ unread: { ...counts } });
  expect(document.title).toBe(`(3) ${BRAND_NAME}`); expect(counts).toEqual({ alice: 1, bob: 2 }); expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('unmount restores the original title/favicon and aborts a pending static asset request', async () => {
  const { unmount } = renderHook(() => useBrowserTabNotifications({ alice: 1 }, 'voice'));
  await waitFor(() => expect(icons[0].href).toMatch(/^data:/));
  const signal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal;
  unmount(); expect(document.title).toBe(BRAND_NAME); expect(icons.map(icon => icon.outerHTML)).toEqual(originals); expect(signal.aborted).toBe(true);
});

test.each(['read', 'unmount'] as const)('late favicon loading after %s cannot reapply a badge', async action => {
  let complete!: () => void;
  global.fetch = jest.fn(() => new Promise<Response>(resolve => { complete = () => resolve({ ok: true, text: async () => artwork } as Response); }));
  const { rerender, unmount } = renderHook(({ count }) => useBrowserTabNotifications({ alice: count }, null), { initialProps: { count: 1 } });
  if (action === 'read') rerender({ count: 0 }); else unmount();
  await act(async () => { complete(); });
  expect(icons.map(icon => icon.outerHTML)).toEqual(originals); expect(document.title).toBe(BRAND_NAME);
});

test('StrictMode cleanup, remount and new route metadata preserve ownership', async () => {
  const { unmount } = renderHook(() => useBrowserTabNotifications({ alice: 1 }, null), { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
  await waitFor(() => expect(icons[0].href).toMatch(/^data:/));
  document.title = 'Next route'; icons[0].setAttribute('href', '/next-route-icon.svg');
  unmount(); expect(document.title).toBe('Next route'); expect(icons[0]).toHaveAttribute('href', '/next-route-icon.svg');
  expect(icons[1].outerHTML).toBe(originals[1]);
});

test.each(['network', 'invalid-svg'] as const)('%s failure preserves the favicon while unread titles continue to work', async failure => {
  global.fetch = failure === 'network' ? jest.fn().mockRejectedValue(new Error('offline')) : jest.fn().mockResolvedValue({ ok: true, text: async () => '<html>not an icon</html>' });
  await act(async () => { renderHook(() => useBrowserTabNotifications({ alice: 2 }, null)); });
  expect(document.title).toBe(`(2) ${BRAND_NAME}`); expect(icons.map(icon => icon.outerHTML)).toEqual(originals);
});
