import { ApiError, type SessionApi } from '@/api/sessionApi';
import { cursor, publicUser, record, resourceId, revision, searchUser } from '@/api/socialValidation';
import type { FriendRequest, FriendUser, FriendsSnapshot, UserSearchResult } from './friendsModel';
import type { FriendsService } from './friendsService';

type RemoteRequest = FriendRequest & { direction: 'incoming' | 'outgoing' };
function pendingRequest(value: unknown): RemoteRequest {
  const request = record(value);
  if (!['incoming', 'outgoing'].includes(request.direction as string) || request.status !== 'pending' ||
    typeof request.createdAt !== 'string' || !Number.isFinite(Date.parse(request.createdAt)) || request.resolvedAt !== null) throw new ApiError('invalid_response');
  return { id: resourceId(request.id), user: publicUser(request.user), createdAt: request.createdAt, direction: request.direction as RemoteRequest['direction'] };
}

/** Every collection is read at one DB-3 revision; incomplete lists never reach the UI. */
export class RemoteFriendsService implements FriendsService {
  readonly mode = 'remote' as const;
  private reading: AbortController | null = null;
  private mutation = false;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly api: SessionApi) {}

  async getSnapshot(): Promise<FriendsSnapshot> {
    this.reading?.abort();
    const controller = new AbortController(); this.reading = controller;
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let expected: string | undefined;
        const collection = async <T,>(path: string, parse: (item: unknown) => T): Promise<T[]> => {
          const items: T[] = []; const seen = new Set<string>(); let next: string | null = null;
          for (let page = 0; page < 20; page += 1) {
            const params = new URLSearchParams({ limit: '50' });
            if (expected) params.set('revision', expected);
            if (next) params.set('cursor', next);
            const body = record(await this.api.request(`${path}${path.includes('?') ? '&' : '?'}${params}`, { signal: controller.signal }));
            const actual = revision(body.revision);
            if (expected && actual !== expected) throw new ApiError('stale_state');
            expected = actual;
            if (!Array.isArray(body.items) || body.items.length > 50) throw new ApiError('invalid_response');
            items.push(...body.items.map(parse));
            next = cursor(body.nextCursor);
            if (!next) return items;
            if (seen.has(next)) throw new ApiError('invalid_response');
            seen.add(next);
          }
          throw new ApiError('resource_limit');
        };
        try {
          const friends = await collection('/api/friends', publicUser);
          const requests = await collection('/api/friends/requests?direction=all&status=pending', pendingRequest);
          const blockedUsers = await collection('/api/blocks', publicUser);
          const ids = [...friends, ...blockedUsers, ...requests.map(request => request.user)].map(user => user.id);
          if (ids.includes(this.api.actor.id) || new Set(ids).size !== ids.length ||
            new Set(requests.map(request => request.id)).size !== requests.length) throw new ApiError('invalid_response');
          return { friends, blockedUsers,
            incomingRequests: requests.filter(request => request.direction === 'incoming').map(({ direction: _direction, ...request }) => request),
            outgoingRequests: requests.filter(request => request.direction === 'outgoing').map(({ direction: _direction, ...request }) => request) };
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.code !== 'stale_state' || attempt === 2) throw failure;
        }
      }
      throw new ApiError('stale_state');
    } finally { clearTimeout(deadline); if (this.reading === controller) this.reading = null; }
  }
  async searchPage(query: string, next?: string | null, signal?: AbortSignal): Promise<{ items: UserSearchResult[]; nextCursor: string | null }> {
    const q = query.trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,64}$/.test(q)) throw new ApiError('validation', ['q']);
    const params = new URLSearchParams({ q, limit: '20' });
    if (next) params.set('cursor', cursor(next)!);
    const body = record(await this.api.request(`/api/users/search?${params}`, { signal }));
    if (!Array.isArray(body.items) || body.items.length > 20) throw new ApiError('invalid_response');
    const items = body.items.map(searchUser);
    if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => !item.username.startsWith(q) ||
      (item.relationship === 'self') !== (item.id === this.api.actor.id))) throw new ApiError('invalid_response');
    return { items, nextCursor: cursor(body.nextCursor) };
  }
  async searchUsers(query: string) { return (await this.searchPage(query)).items; }
  async getPublicProfile(id: string, signal?: AbortSignal): Promise<UserSearchResult> {
    const user = searchUser(record(await this.api.request(`/api/users/${encodeURIComponent(resourceId(id))}`, { signal })).user);
    if (user.id !== id || (user.relationship === 'self') !== (id === this.api.actor.id)) throw new ApiError('invalid_response');
    return user;
  }
  async listFriends(): Promise<FriendUser[]> { return (await this.getSnapshot()).friends; }
  async listIncomingRequests(): Promise<FriendRequest[]> { return (await this.getSnapshot()).incomingRequests; }
  async listOutgoingRequests(): Promise<FriendRequest[]> { return (await this.getSnapshot()).outgoingRequests; }
  async listBlockedUsers(): Promise<FriendUser[]> { return (await this.getSnapshot()).blockedUsers; }
  private async write(path: string, method: 'POST' | 'DELETE', body?: unknown, status: 200 | 201 | 204 = 204): Promise<void> {
    if (this.mutation) throw new ApiError('conflict');
    this.mutation = true; this.reading?.abort();
    try {
      const result = await this.api.request(path, { method, body, status });
      if (status !== 204) {
        const request = record(record(result).request);
        resourceId(request.id); publicUser(request.user);
        if (!['incoming', 'outgoing'].includes(request.direction as string) ||
          request.status !== (status === 201 ? 'pending' : path.endsWith('/accept') ? 'accepted' : 'declined')) throw new ApiError('invalid_response');
      }
      for (const listener of this.listeners) {
        try { listener(); } catch { /* A view cannot change the confirmed transition. */ }
      }
    } finally { this.mutation = false; }
  }
  sendRequest(userId: string) {
    if (userId === this.api.actor.id) return Promise.reject(new ApiError('conflict'));
    return this.write('/api/friends/requests', 'POST', { userId: resourceId(userId) }, 201);
  }
  acceptRequest(id: string) { return this.write(`/api/friends/requests/${encodeURIComponent(resourceId(id))}/accept`, 'POST', undefined, 200); }
  declineRequest(id: string) { return this.write(`/api/friends/requests/${encodeURIComponent(resourceId(id))}/decline`, 'POST', undefined, 200); }
  cancelRequest(id: string) { return this.write(`/api/friends/requests/${encodeURIComponent(resourceId(id))}`, 'DELETE'); }
  removeFriend(id: string) { return this.write(`/api/friends/${encodeURIComponent(resourceId(id))}`, 'DELETE'); }
  blockUser(id: string) { return this.write('/api/blocks', 'POST', { userId: resourceId(id) }); }
  unblockUser(id: string) { return this.write(`/api/blocks/${encodeURIComponent(resourceId(id))}`, 'DELETE'); }
  subscribeToChanges(listener: () => void): () => void {
    this.listeners.add(listener);
    const refresh = () => { if (document.visibilityState !== 'hidden' && !this.mutation) listener(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => { this.listeners.delete(listener); window.clearInterval(timer); window.removeEventListener('focus', refresh); this.reading?.abort(); };
  }
}
