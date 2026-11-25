import { act, renderHook } from '@testing-library/react';
import { ARRIVAL_ATTENTION_MS, useArrivalAttention } from '../useArrivalAttention';
beforeEach(() => jest.useFakeTimers()); afterEach(() => jest.useRealTimers());

test('one brief effect per invitation survives revisions/disconnects without replaying', () => {
  const { result, rerender, unmount } = renderHook(({ id, connected }) => useArrivalAttention(id, connected), { initialProps: { id: 'call-1', connected: true } });
  expect(result.current).toBe(true);
  act(() => jest.advanceTimersByTime(ARRIVAL_ATTENTION_MS)); expect(result.current).toBe(false);
  rerender({ id: 'call-1', connected: true }); expect(result.current).toBe(false);
  rerender({ id: 'call-1', connected: false }); rerender({ id: 'call-1', connected: true }); expect(result.current).toBe(false);
  rerender({ id: 'call-2', connected: true }); expect(result.current).toBe(true);
  unmount(); expect(jest.getTimerCount()).toBe(0);
});

test('disabled/absent invitations never start attention and ending a call cancels cleanup timers', () => {
  const { result, rerender, unmount } = renderHook(({ id, enabled }) => useArrivalAttention(id, enabled), { initialProps: { id: null as string | null, enabled: true } });
  expect(result.current).toBe(false); expect(jest.getTimerCount()).toBe(0);
  rerender({ id: 'call', enabled: false }); expect(result.current).toBe(false);
  rerender({ id: 'call', enabled: true }); expect(result.current).toBe(true);
  rerender({ id: null, enabled: false }); expect(jest.getTimerCount()).toBe(0); unmount();
});
