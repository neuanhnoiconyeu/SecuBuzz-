import { useCallback, useEffect, useRef, useState } from 'react';
import { FriendsServiceError, type FriendsSnapshot, type UserSearchResult } from '@/friends/friendsModel';
import type { FriendsService } from '@/friends/friendsService';
import { safeApiMessage } from '@/api/sessionApi';

export type FriendAction = {
  type: 'send' | 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock';
  id: string;
};

export interface FriendsController {
  snapshot: FriendsSnapshot;
  isLoading: boolean;
  isStale: boolean;
  error: string | null;
  notice: string;
  isPending: boolean;
  query: string;
  searchResults: UserSearchResult[];
  searchLoading: boolean;
  searchError: string | null;
  hasSearched: boolean;
  mode: FriendsService['mode'];
  setQuery(query: string): void;
  refresh(): Promise<void>;
  perform(action: FriendAction): Promise<boolean>;
  searchHasMore?: boolean;
  searchLoadingMore?: boolean;
  loadMoreSearch?(): Promise<void>;
}

const emptySnapshot = (): FriendsSnapshot => ({
  friends: [], incomingRequests: [], outgoingRequests: [], blockedUsers: [],
});

const notices: Record<FriendAction['type'], string> = {
  send: 'Friend request sent.', accept: 'Friend request accepted.', decline: 'Friend request declined.',
  cancel: 'Friend request canceled.', remove: 'Friend removed. Chat history is unchanged.',
  block: 'User blocked. Chat history is unchanged.', unblock: 'User unblocked. Friendship was not restored.',
};

/** One controller is shared by Friends, public profiles, and chat relationship notices.
 * The injected service is the sole source of relationship data; failures never select a demo adapter.
 */
export function useFriends(service: FriendsService): FriendsController {
  const [snapshot, setSnapshot] = useState<FriendsSnapshot>(emptySnapshot);
  const [isLoading, setIsLoading] = useState(true);
  const [isStale, setIsStale] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [query, setQueryState] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);
  const moreLock = useRef(false);
  const mounted = useRef(false);
  const currentService = useRef(service);
  currentService.current = service;
  const generation = useRef(0);
  const loadSequence = useRef(0);
  const searchSequence = useRef(0);
  const mutationLock = useRef(false);

  const load = useCallback(async (): Promise<boolean> => {
    const request = ++loadSequence.current;
    const epoch = generation.current;
    const current = () => mounted.current && currentService.current === service &&
      epoch === generation.current && request === loadSequence.current;
    if (mounted.current) { setIsLoading(true); setError(null); }
    try {
      const next = await service.getSnapshot();
      if (!current()) return false;
      setSnapshot(next);
      setIsStale(false);
      setSearchRevision((value) => value + 1);
      return true;
    } catch (failure) {
      if (current()) {
        setIsStale(true);
        setError(safeApiMessage(failure, 'Friends could not be refreshed. Try again before making changes.'));
      }
      return false;
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [service]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    mutationLock.current = false;
    setSnapshot(emptySnapshot());
    setIsStale(true);
    setIsPending(false);
    setNotice('');
    setQueryState('');
    const unsubscribe = service.subscribeToChanges(() => {
      // A mutation reloads once after its confirmed result, including any emitted change.
      if (!mutationLock.current) void load();
    });
    void load();
    return () => {
      mounted.current = false;
      generation.current += 1;
      loadSequence.current += 1;
      searchSequence.current += 1;
      unsubscribe();
    };
  }, [load, service]);

  const setQuery = useCallback((value: string) => {
    searchAbort.current?.abort();
    searchSequence.current += 1;
    setQueryState(value);
    setSearchResults([]);
    setSearchError(null);
    setHasSearched(false);
    setSearchLoading(Boolean(value.trim()));
    setNextCursor(null);
  }, []);

  useEffect(() => {
    searchAbort.current?.abort();
    const controller = new AbortController(); searchAbort.current = controller;
    setNextCursor(null); setSearchLoadingMore(false); moreLock.current = false;
    const request = ++searchSequence.current;
    const epoch = generation.current;
    const current = () => mounted.current && currentService.current === service &&
      epoch === generation.current && request === searchSequence.current;
    setSearchResults([]);
    setSearchError(null);
    setHasSearched(false);
    if (!query.trim() || isPending) { setSearchLoading(false); return; }
    if (service.mode === 'remote' && !/^[a-z0-9._-]{2,64}$/i.test(query.trim())) {
      setSearchLoading(false);
      setSearchError('Enter a username prefix of 2–64 letters, digits, dots, underscores or hyphens.');
      return;
    }
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const page = service.searchPage ? await service.searchPage(query, null, controller.signal) :
            { items: await service.searchUsers(query), nextCursor: null };
          if (current()) { setSearchResults(page.items); setNextCursor(page.nextCursor); setHasSearched(true); }
        } catch (failure) {
          if (current()) {
            setSearchError(safeApiMessage(failure, 'Search is unavailable. Try again.'));
            setHasSearched(true);
          }
        } finally {
          if (current()) setSearchLoading(false);
        }
      })();
    }, service.mode === 'remote' ? 300 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); searchSequence.current += 1; };
  }, [isPending, query, searchRevision, service]);

  const refresh = useCallback(async () => { await load(); }, [load]);
  const loadMoreSearch = useCallback(async () => {
    if (!service.searchPage || !nextCursor || moreLock.current || isPending || searchLoading) return;
    moreLock.current = true; setSearchLoadingMore(true); setSearchError(null);
    const sequence = searchSequence.current; const epoch = generation.current;
    const current = () => mounted.current && currentService.current === service && sequence === searchSequence.current && epoch === generation.current;
    try {
      const page = await service.searchPage(query, nextCursor, searchAbort.current?.signal);
      if (current()) {
        if (page.nextCursor === nextCursor) throw new Error('Repeated cursor');
        setSearchResults(previous => [...previous, ...page.items.filter(item => !previous.some(user => user.id === item.id))]);
        setNextCursor(page.nextCursor);
      }
    } catch (failure) { if (current()) setSearchError(safeApiMessage(failure, 'More results could not be loaded. Try again.')); }
    finally { if (current()) { moreLock.current = false; setSearchLoadingMore(false); } }
  }, [isPending, nextCursor, query, searchLoading, service]);

  const perform = useCallback(async (action: FriendAction): Promise<boolean> => {
    if (!mounted.current || mutationLock.current || isStale || isLoading) return false;
    const epoch = generation.current;
    const current = () => mounted.current && currentService.current === service && epoch === generation.current;
    mutationLock.current = true;
    loadSequence.current += 1;
    searchAbort.current?.abort();
    searchSequence.current += 1;
    setSearchResults([]);
    setIsPending(true);
    setError(null);
    setNotice('');
    try {
      switch (action.type) {
        case 'send': await service.sendRequest(action.id); break;
        case 'accept': await service.acceptRequest(action.id); break;
        case 'decline': await service.declineRequest(action.id); break;
        case 'cancel': await service.cancelRequest(action.id); break;
        case 'remove': await service.removeFriend(action.id); break;
        case 'block': await service.blockUser(action.id); break;
        case 'unblock': await service.unblockUser(action.id); break;
      }
      if (!current()) return false;
      const refreshed = await load();
      if (current()) setNotice(refreshed ? notices[action.type] : 'Update accepted. Refresh Friends to see the latest relationship.');
      return true;
    } catch (failure) {
      if (!current()) return false;
      // Reconcile rejected/stale requests with the authoritative adapter before enabling another action.
      await load();
      if (current()) setError(failure instanceof FriendsServiceError ? failure.message : safeApiMessage(failure,
        'The action could not be confirmed. Refresh Friends before trying again.'));
      return false;
    } finally {
      if (current()) { mutationLock.current = false; setIsPending(false); }
    }
  }, [isLoading, isStale, load, service]);

  return { snapshot, isLoading, isStale, error, notice, isPending, query, searchResults,
    searchLoading, searchError, hasSearched, mode: service.mode, setQuery, refresh, perform,
    searchHasMore: Boolean(nextCursor), searchLoadingMore, loadMoreSearch };
}
