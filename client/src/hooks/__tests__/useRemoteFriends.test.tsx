import { act, renderHook, waitFor } from '@testing-library/react';
import { useFriends } from '../useFriends';
import type { FriendsService } from '@/friends/friendsService';
import type { FriendsSnapshot, UserSearchResult } from '@/friends/friendsModel';
import { ApiError } from '@/api/sessionApi';

const empty: FriendsSnapshot = { friends: [], incomingRequests: [], outgoingRequests: [], blockedUsers: [] };
const bob: UserSearchResult = { id: 'bob-id', username: 'bob', displayName: 'Bob', avatar: 'star', relationship: 'none' };
const bonnie: UserSearchResult = { ...bob, id: 'bonnie-id', username: 'bonnie', displayName: 'Bonnie' };
function setup() {
  const service: FriendsService = { mode: 'remote', getSnapshot: jest.fn(async () => empty), searchUsers: jest.fn(async () => []),
    searchPage: jest.fn(async () => ({ items: [bob], nextCursor: 'next' as string | null })),
    listFriends: jest.fn(), listIncomingRequests: jest.fn(), listOutgoingRequests: jest.fn(), listBlockedUsers: jest.fn(),
    sendRequest: jest.fn(), acceptRequest: jest.fn(), declineRequest: jest.fn(), cancelRequest: jest.fn(), removeFriend: jest.fn(), blockUser: jest.fn(), unblockUser: jest.fn(),
    subscribeToChanges: () => () => {}, };
  return service;
}

test('remote search waits for a valid two-character prefix and cancels the old request when query changes', async () => {
  const service = setup(); const { result } = renderHook(() => useFriends(service));
  await waitFor(() => expect(result.current.isStale).toBe(false));
  act(() => result.current.setQuery('b'));
  expect(result.current.searchError).toContain('2–64'); expect(service.searchPage).not.toHaveBeenCalled();
  act(() => result.current.setQuery('bo'));
  await waitFor(() => expect(result.current.searchResults).toEqual([bob]));
  const signal = jest.mocked(service.searchPage!).mock.calls[0]?.[2];
  act(() => result.current.setQuery('ali'));
  expect(signal?.aborted).toBe(true); expect(result.current.searchResults).toEqual([]);
});

test('load more appends deduplicated results without hiding the first page and serializes duplicate clicks', async () => {
  const service = setup(); let resolve!: (page: { items: UserSearchResult[]; nextCursor: null }) => void;
  jest.mocked(service.searchPage!).mockResolvedValueOnce({ items: [bob], nextCursor: 'next' }).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { result } = renderHook(() => useFriends(service));
  await waitFor(() => expect(result.current.isStale).toBe(false)); act(() => result.current.setQuery('bo'));
  await waitFor(() => expect(result.current.searchHasMore).toBe(true));
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadMoreSearch!(); void result.current.loadMoreSearch!(); });
  expect(result.current.searchResults).toEqual([bob]); expect(result.current.searchLoadingMore).toBe(true);
  await act(async () => { resolve({ items: [bob, bonnie], nextCursor: null }); await pending; });
  expect(result.current.searchResults).toEqual([bob, bonnie]); expect(result.current.searchHasMore).toBe(false); expect(service.searchPage).toHaveBeenCalledTimes(2);
});

test('late pagination from a previous query cannot populate a newer search', async () => {
  const service = setup(); let resolve!: (page: { items: UserSearchResult[]; nextCursor: null }) => void;
  jest.mocked(service.searchPage!).mockResolvedValueOnce({ items: [bob], nextCursor: 'next' }).mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  const { result } = renderHook(() => useFriends(service)); await waitFor(() => expect(result.current.isStale).toBe(false));
  act(() => result.current.setQuery('bo')); await waitFor(() => expect(result.current.searchHasMore).toBe(true));
  let pending!: Promise<void>; act(() => { pending = result.current.loadMoreSearch!(); });
  act(() => result.current.setQuery('zz')); await waitFor(() => expect(result.current.hasSearched).toBe(true));
  await act(async () => { resolve({ items: [bonnie], nextCursor: null }); await pending; }); expect(result.current.searchResults).toEqual([]);
});

test('rate limiting is actionable and never reports an unconfirmed mutation as successful', async () => {
  const service = setup(); jest.mocked(service.sendRequest).mockRejectedValue(new ApiError('rate_limited', [], 12));
  const { result } = renderHook(() => useFriends(service)); await waitFor(() => expect(result.current.isStale).toBe(false));
  await act(async () => { expect(await result.current.perform({ type: 'send', id: bob.id })).toBe(false); });
  expect(result.current.error).toContain('12 seconds'); expect(result.current.notice).toBe(''); expect(service.sendRequest).toHaveBeenCalledTimes(1);
});
