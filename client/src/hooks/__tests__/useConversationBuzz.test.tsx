import { act, renderHook } from '@testing-library/react';
import { useConversationBuzz } from '../useConversationBuzz';
import { SocketFailure } from '@/realtime/authenticatedProtocol';
import { BUZZ_COOLDOWN_MS, BUZZ_EFFECT_MS, type BuzzEvent } from '../../../../shared/buzz';

const event: BuzzEvent = { id: 'buzz-1', conversationId: 'conversation-1', userId: 'bob', displayName: 'Bob', timestamp: new Date().toISOString() };
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
test('awaits acknowledgement, prevents repeated sends, shows a brief effect and releases cooldown', async () => {
  let resolve!: (value: BuzzEvent) => void;
  const send = jest.fn(() => new Promise<BuzzEvent>(r => { resolve = r; }));
  const { result } = renderHook(() => useConversationBuzz(undefined, true, send));
  let pending!: Promise<void>;
  act(() => { pending = result.current.sendBuzz(event.conversationId); });
  expect(result.current.busy).toBe(true); expect(result.current.notice).toBe('');
  await act(() => result.current.sendBuzz(event.conversationId)); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(event); await pending; });
  expect(result.current.notice).toBe('BUZZ! sent.'); expect(result.current.effectConversation).toBe(event.conversationId);
  act(() => jest.advanceTimersByTime(BUZZ_EFFECT_MS)); expect(result.current.effectConversation).toBeNull(); expect(result.current.busy).toBe(true);
  act(() => jest.advanceTimersByTime(BUZZ_COOLDOWN_MS)); expect(result.current.busy).toBe(false);
});
test('receives once, ignores an old cached signal and never replays it on selection/activity changes', () => {
  const { result, rerender } = renderHook(({ incoming, active }) => useConversationBuzz(incoming, active, undefined), { initialProps: { incoming: event, active: true } });
  expect(result.current.notice).toBe('');
  rerender({ incoming: { ...event, id: 'buzz-2' }, active: true }); expect(result.current.notice).toBe('Bob sent you a BUZZ!');
  act(() => jest.advanceTimersByTime(BUZZ_EFFECT_MS)); rerender({ incoming: { ...event, id: 'buzz-2' }, active: true });
  expect(result.current.effectConversation).toBeNull();
  rerender({ incoming: { ...event, id: 'buzz-3' }, active: false });
  rerender({ incoming: { ...event, id: 'buzz-3' }, active: true }); expect(result.current.effectConversation).toBeNull();
});
test.each(['unavailable', 'rate_limited'] as const)('failed %s sends show useful feedback without success', async code => {
  const send = jest.fn().mockRejectedValue(new SocketFailure(code));
  const { result } = renderHook(() => useConversationBuzz(undefined, true, send));
  await act(() => result.current.sendBuzz(event.conversationId)); expect(result.current.effectConversation).toBeNull();
  expect(result.current.notice).toMatch(code === 'rate_limited' ? /Please wait/ : /Could not send/);
});
test('unmount cancels timers and ignores a late acknowledgement', async () => {
  let resolve!: (value: BuzzEvent) => void;
  const send = jest.fn(() => new Promise<BuzzEvent>(r => { resolve = r; }));
  const { result, unmount } = renderHook(() => useConversationBuzz(undefined, true, send));
  let pending!: Promise<void>; act(() => { pending = result.current.sendBuzz(event.conversationId); }); unmount();
  await act(async () => { resolve(event); await pending; }); expect(jest.getTimerCount()).toBe(0);
});
