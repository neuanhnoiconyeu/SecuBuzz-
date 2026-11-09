import { act, renderHook, waitFor } from '@testing-library/react';
import { useFriends } from '../useFriends';
import { LocalDemoFriendsService, type FriendsService } from '@/friends/friendsService';
import type { FriendsSnapshot, UserSearchResult } from '@/friends/friendsModel';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('useFriends', () => {
  test('shares confirmed request updates and prevents concurrent duplicate operations', async () => {
    const service = new LocalDemoFriendsService();
    const send = jest.spyOn(service, 'sendRequest');
    const { result } = renderHook(() => useFriends(service));
    await waitFor(() => expect(result.current.isStale).toBe(false));
    await act(async () => {
      const first = result.current.perform({ type: 'send', id: 'demo-mina' });
      const second = result.current.perform({ type: 'send', id: 'demo-mina' });
      expect(await first).toBe(true);
      expect(await second).toBe(false);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.outgoingRequests).toHaveLength(2);
    expect(result.current.notice).toBe('Friend request sent.');
    await act(async () => { await service.acceptRequest('demo-request-incoming-jules'); });
    await waitFor(() => expect(result.current.snapshot.friends.map((friend) => friend.id)).toContain('demo-jules'));
    expect(result.current.snapshot.incomingRequests).toHaveLength(0);
  });

  test('remote failure never substitutes demo users or exposes transport error details', async () => {
    const service = new LocalDemoFriendsService();
    Object.defineProperty(service, 'mode', { value: 'remote' });
    jest.spyOn(service, 'getSnapshot').mockRejectedValue(new Error('private-token/server body'));
    const { result } = renderHook(() => useFriends(service));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.mode).toBe('remote');
    expect(result.current.snapshot.friends).toEqual([]);
    expect(result.current.isStale).toBe(true);
    expect(result.current.error).not.toContain('private-token');
    const send = jest.spyOn(service, 'sendRequest');
    await act(async () => { expect(await result.current.perform({ type: 'send', id: 'demo-mina' })).toBe(false); });
    expect(send).not.toHaveBeenCalled();
  });

  test('failed mutations preserve confirmed data, report failure and never announce success', async () => {
    const service = new LocalDemoFriendsService();
    jest.spyOn(service, 'removeFriend').mockRejectedValue(new Error('sensitive API payload'));
    const { result } = renderHook(() => useFriends(service));
    await waitFor(() => expect(result.current.isStale).toBe(false));
    await act(async () => { expect(await result.current.perform({ type: 'remove', id: 'demo-ava' })).toBe(false); });
    expect(result.current.snapshot.friends[0]?.id).toBe('demo-ava');
    expect(result.current.notice).toBe('');
    expect(result.current.error).toMatch(/could not be confirmed/);
    expect(result.current.error).not.toContain('sensitive');
    expect(result.current.isPending).toBe(false);
  });

  test('accepted mutations with a failed reconciliation require a refresh before further changes', async () => {
    const service = new LocalDemoFriendsService();
    const { result } = renderHook(() => useFriends(service));
    await waitFor(() => expect(result.current.isStale).toBe(false));
    const load = jest.spyOn(service, 'getSnapshot').mockRejectedValue(new Error('offline'));
    await act(async () => { expect(await result.current.perform({ type: 'remove', id: 'demo-ava' })).toBe(true); });
    expect(result.current.isStale).toBe(true);
    expect(result.current.notice).toMatch(/Update accepted/);
    await act(async () => { expect(await result.current.perform({ type: 'send', id: 'demo-mina' })).toBe(false); });
    load.mockRestore();
    await act(async () => { await result.current.refresh(); });
    expect(result.current.snapshot.friends).toEqual([]);
    expect(result.current.isStale).toBe(false);
  });

  test('debounces remote search and ignores obsolete responses, including errors', async () => {
    jest.useFakeTimers();
    try {
      const service = new LocalDemoFriendsService();
      Object.defineProperty(service, 'mode', { value: 'remote' });
      const old = deferred<UserSearchResult[]>();
      const search = jest.spyOn(service, 'searchUsers').mockImplementation((query) =>
        query === 'ava' ? old.promise : Promise.resolve([]));
      const { result } = renderHook(() => useFriends(service));
      await act(async () => { await Promise.resolve(); });
      act(() => { result.current.setQuery('a'); });
      await act(async () => { jest.advanceTimersByTime(200); });
      expect(search).not.toHaveBeenCalled();
      act(() => { result.current.setQuery('ava'); });
      await act(async () => { jest.advanceTimersByTime(299); });
      expect(search).not.toHaveBeenCalled();
      await act(async () => { jest.advanceTimersByTime(1); });
      expect(search).toHaveBeenCalledWith('ava');
      act(() => { result.current.setQuery('unknown'); });
      await act(async () => { jest.advanceTimersByTime(300); });
      expect(result.current.hasSearched).toBe(true);
      expect(result.current.searchResults).toEqual([]);
      await act(async () => { old.reject(new Error('obsolete private result')); });
      expect(result.current.searchError).toBeNull();
      expect(result.current.query).toBe('unknown');
    } finally { jest.useRealTimers(); }
  });

  test('search errors are explicit and retry does not silently switch adapters', async () => {
    const service = new LocalDemoFriendsService();
    const search = jest.spyOn(service, 'searchUsers').mockRejectedValue(new Error('private search response'));
    const { result } = renderHook(() => useFriends(service));
    await waitFor(() => expect(result.current.isStale).toBe(false));
    act(() => { result.current.setQuery('mina'); });
    await waitFor(() => expect(result.current.searchError).toBe('Search is unavailable. Try again.'));
    expect(result.current.searchResults).toEqual([]);
    search.mockRestore();
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.searchResults[0]?.id).toBe('demo-mina'));
  });

  test('service replacement ignores old loads and unsubscribes from previous identity', async () => {
    const original = new LocalDemoFriendsService();
    const pending = deferred<FriendsSnapshot>();
    jest.spyOn(original, 'getSnapshot').mockReturnValue(pending.promise);
    const next = new LocalDemoFriendsService();
    await next.removeFriend('demo-ava');
    const { result, rerender, unmount } = renderHook(({ service }: { service: FriendsService }) => useFriends(service), {
      initialProps: { service: original as FriendsService },
    });
    rerender({ service: next });
    await waitFor(() => expect(result.current.isStale).toBe(false));
    await act(async () => { pending.resolve({ friends: [{ id: 'private-old-actor', displayName: 'Old', username: 'old', avatar: 'initials' }], incomingRequests: [], outgoingRequests: [], blockedUsers: [] }); });
    expect(result.current.snapshot.friends).toEqual([]);
    const load = jest.spyOn(next, 'getSnapshot');
    unmount();
    await act(async () => { await next.unblockUser('demo-rowan'); });
    expect(load).not.toHaveBeenCalled();
  });
});
