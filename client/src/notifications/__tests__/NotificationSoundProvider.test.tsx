import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NotificationSoundProvider, NotificationSoundToggle, notificationSoundKey, useNotificationAudio } from '../NotificationSoundProvider';
import type { NotificationAudio } from '../notificationAudio';
import { useIncomingRingtone } from '../useIncomingRingtone';
import { FakeAudioContext } from '../testing/fakeAudio';

let engine: NotificationAudio | null, contexts: FakeAudioContext[];
const original = Object.getOwnPropertyDescriptor(window, 'AudioContext');
function Probe({ id = null, ringing = false, expiresAt = null }: { id?: string | null; ringing?: boolean; expiresAt?: number | null }) {
  engine = useNotificationAudio(); useIncomingRingtone(id, expiresAt, ringing); return <NotificationSoundToggle />;
}
beforeEach(() => {
  jest.useFakeTimers(); localStorage.clear(); contexts = []; engine = null;
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: function () { const context = new FakeAudioContext(); contexts.push(context); return context; } });
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); if (original) Object.defineProperty(window, 'AudioContext', original); else Reflect.deleteProperty(window, 'AudioContext'); });

test('StrictMode owns live resources, persists mute per account and closes the context on unmount', async () => {
  const view = render(<StrictMode><NotificationSoundProvider accountId="alice"><Probe /></NotificationSoundProvider></StrictMode>);
  expect(screen.getByRole('button', { name: 'Notification sounds: Sound On' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Notification sounds: Sound On' }));
  expect(localStorage.getItem(notificationSoundKey('alice'))).toBe('muted');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Notification sounds: Muted' })));
  act(() => engine!.notify('message', 'one')); expect(contexts[0].oscillators).toHaveLength(2);
  view.unmount(); expect(contexts[0].close).toHaveBeenCalledTimes(1);
  render(<NotificationSoundProvider accountId="alice"><Probe /></NotificationSoundProvider>);
  expect(screen.getByRole('button', { name: 'Notification sounds: Sound On' })).toBeVisible();
});

test('saved mute survives remount, is account-scoped, and storage events mute another open tab', async () => {
  localStorage.setItem(notificationSoundKey('alice'), 'muted');
  const view = render(<NotificationSoundProvider accountId="alice"><Probe /></NotificationSoundProvider>);
  expect(screen.getByRole('button', { name: 'Notification sounds: Muted' })).toBeVisible();
  view.rerender(<NotificationSoundProvider accountId="bob"><Probe /></NotificationSoundProvider>);
  expect(screen.getByRole('button', { name: 'Notification sounds: Sound On' })).toBeVisible();
  await act(() => engine!.unlock());
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: notificationSoundKey('alice'), newValue: 'muted' })));
  expect(engine!.getSnapshot().enabled).toBe(true);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: notificationSoundKey('bob'), newValue: 'muted' })));
  expect(contexts[0].close).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Notification sounds: Muted' })).toBeVisible();
});

test('autoplay-blocked hint requires explicit interaction and clears only when the browser allows audio', async () => {
  render(<NotificationSoundProvider accountId="alice"><Probe id="ring" ringing expiresAt={Date.now() + 30_000} /></NotificationSoundProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('user interaction'); expect(contexts).toHaveLength(0);
  // First browser resume attempt remains suspended; no fabricated autoplay success.
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: function () {
    const context = new FakeAudioContext(); context.resume.mockResolvedValueOnce(undefined); contexts.push(context); return context;
  } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enable sound' })));
  expect(screen.getByRole('status')).toHaveTextContent('user interaction'); expect(contexts[0].oscillators).toHaveLength(0);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enable sound' })));
  expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(contexts[0].oscillators).toHaveLength(4);
});

test('losing ringtone eligibility cleans up immediately without a new loop on replay', async () => {
    const expiresAt = Date.now() + 30_000;
    const view = render(<NotificationSoundProvider accountId="alice"><Probe id="ring" ringing expiresAt={expiresAt} /></NotificationSoundProvider>);
    await act(() => engine!.unlock()); expect(contexts[0].oscillators).toHaveLength(4);
    view.rerender(<NotificationSoundProvider accountId="alice"><Probe id="ring" ringing={false} expiresAt={expiresAt} /></NotificationSoundProvider>);
    expect(jest.getTimerCount()).toBe(0);
    view.rerender(<NotificationSoundProvider accountId="alice"><Probe id="ring" ringing expiresAt={expiresAt} /></NotificationSoundProvider>);
    act(() => jest.advanceTimersByTime(2500)); expect(contexts[0].oscillators).toHaveLength(4);
    view.unmount(); expect(contexts[0].close).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('failed preference persistence retains the functional toggle and reports the limitation', () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  render(<NotificationSoundProvider accountId="alice"><Probe /></NotificationSoundProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Notification sounds: Sound On' }));
  expect(screen.getByRole('button', { name: 'Notification sounds: Muted' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('could not be saved');
});
