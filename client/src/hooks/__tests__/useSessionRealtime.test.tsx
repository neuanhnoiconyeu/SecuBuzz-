import { act, renderHook } from '@testing-library/react';
import { PRESENCE_TTL_MS, useSessionRealtime } from '../useSessionRealtime';
import type { RealtimeClient, RealtimeConnectionStatus, RealtimeEvent } from '@/realtime/realtimeModel';

class Client implements RealtimeClient {
  readonly mode = 'local-demo' as const;
  readonly actorId = 'self';
  readonly canSendMessages = true;
  status: RealtimeConnectionStatus = 'connected';
  listeners = new Set<(event: RealtimeEvent) => void>();
  connect = jest.fn(async () => undefined);
  disconnect = jest.fn(); dispose = jest.fn();
  getStatus = () => this.status;
  sendMessage = jest.fn(); sendTyping = jest.fn(); markRead = jest.fn(async () => undefined);
  watchConversations = jest.fn(); watchPresence = jest.fn();
  subscribe(listener: (event: RealtimeEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: RealtimeEvent) { if (event.type === 'connection') this.status = event.status; this.listeners.forEach((listener) => listener(event)); }
}
const now = Date.parse('2026-11-09T12:00:00.000Z');
const presence = (userId = 'friend', offset = 0, status: 'online' | 'offline' | 'unknown' = 'online'): RealtimeEvent =>
  ({ type: 'presence', userId, status, timestamp: new Date(now + offset).toISOString() });
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(now); });
afterEach(() => jest.useRealTimers());

test('projects only watched peers and expires delayed samples from their observation time', () => {
  const client = new Client();
  const { result } = renderHook(() => useSessionRealtime(client, ['friend', 'self']));
  act(() => { client.emit(presence('stranger')); client.emit(presence('self')); client.emit(presence('friend', -40_000)); });
  expect([...result.current.presence.keys()]).toEqual(['friend']);
  act(() => { jest.advanceTimersByTime(5_000); });
  expect(result.current.presence.size).toBe(0);
});

test('equal/older timestamps and future samples cannot refresh or poison presence', () => {
  const client = new Client(); const { result } = renderHook(() => useSessionRealtime(client, ['friend']));
  act(() => { client.emit(presence()); jest.advanceTimersByTime(10_000); client.emit(presence()); client.emit(presence('friend', -1, 'offline')); });
  expect(result.current.presence.get('friend')?.status).toBe('online');
  act(() => { client.emit(presence('friend', 120_000, 'offline')); jest.advanceTimersByTime(PRESENCE_TTL_MS - 10_000); });
  expect(result.current.presence.size).toBe(0);
  act(() => { client.emit(presence('friend', PRESENCE_TTL_MS, 'offline')); });
  expect(result.current.presence.get('friend')?.status).toBe('offline');
});

test('unknown and disconnect clear status, and offline presence is ignored', () => {
  const client = new Client(); const { result } = renderHook(() => useSessionRealtime(client, ['friend']));
  act(() => { client.emit(presence()); client.emit(presence('friend', 1, 'unknown')); });
  expect(result.current.presence.size).toBe(0);
  act(() => { client.emit(presence('friend', 2)); client.emit({ type: 'connection', status: 'reconnecting' }); client.emit(presence('friend', 3)); });
  expect(result.current.status).toBe('reconnecting'); expect(result.current.presence.size).toBe(0);
});

test('removing a watched friend clears their projection and unmount unsubscribes without owning socket disposal', () => {
  const client = new Client(); const { result, rerender, unmount } = renderHook(({ ids }) => useSessionRealtime(client, ids), { initialProps: { ids: ['friend'] } });
  act(() => { client.emit(presence()); });
  rerender({ ids: [] }); expect(result.current.presence.size).toBe(0);
  expect(client.watchPresence).toHaveBeenLastCalledWith([]);
  expect(client.connect).toHaveBeenCalledTimes(1);
  unmount(); expect(client.listeners.size).toBe(0); expect(client.dispose).not.toHaveBeenCalled();
});

test('identity replacement releases old listener and old events cannot enter the new projection', () => {
  const old = new Client(), next = new Client();
  const update = jest.fn(); const { result, rerender } = renderHook(({ client }) => useSessionRealtime(client, ['friend'], update), { initialProps: { client: old } });
  act(() => { old.emit(presence()); });
  rerender({ client: next }); expect(old.listeners.size).toBe(0); expect(result.current.presence.size).toBe(0);
  act(() => { old.emit(presence()); next.emit({ type: 'conversation', conversationId: 'known', updatedAt: new Date(now).toISOString() }); });
  expect(result.current.presence.size).toBe(0); expect(update).toHaveBeenCalledTimes(1);
});
