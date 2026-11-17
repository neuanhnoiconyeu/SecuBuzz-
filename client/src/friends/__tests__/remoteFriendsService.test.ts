import { RemoteFriendsService } from '../remoteFriendsService';
import { ApiError, type SessionApi } from '@/api/sessionApi';

const user = { id: 'bob-id', username: 'bob', displayName: 'Bob', avatar: 'star' };
const actor = { id: 'alice-id', username: 'alice' };
const empty = { items: [], nextCursor: null, revision: '7' };
const pending = { id: 'request-1', user, direction: 'incoming', status: 'pending', createdAt: '2026-11-01T00:00:00.000Z', resolvedAt: null };
function setup() {
  const request = jest.fn(); const api: SessionApi = { actor, request, dispose: jest.fn() };
  return { request, service: new RemoteFriendsService(api) };
}

test('exhausts pages with one revision before publishing all four collections', async () => {
  const { service, request } = setup();
  request.mockResolvedValueOnce({ ...empty, items: [user], nextCursor: 'cursor2' })
    .mockResolvedValueOnce({ ...empty, items: [{ ...user, id: 'carol-id', username: 'carol' }] })
    .mockResolvedValueOnce({ ...empty, items: [{ ...pending, user: { ...user, id: 'dave-id', username: 'dave' } }] })
    .mockResolvedValueOnce({ ...empty, items: [{ ...user, id: 'eve-id', username: 'eve' }] });
  const result = await service.getSnapshot();
  expect(result.friends).toHaveLength(2); expect(result.incomingRequests).toHaveLength(1); expect(result.blockedUsers).toHaveLength(1);
  expect(request.mock.calls[1]?.[0]).toContain('revision=7&cursor=cursor2');
  expect(request.mock.calls[2]?.[0]).toContain('direction=all&status=pending&limit=50&revision=7');
});
test('discards all partial pages on STALE_STATE then retries only the complete read', async () => {
  const { service, request } = setup();
  request.mockResolvedValueOnce({ ...empty, items: [user] }).mockRejectedValueOnce(new ApiError('stale_state'))
    .mockResolvedValue({ ...empty, revision: '8' });
  const result = await service.getSnapshot(); expect(result.friends).toEqual([]); expect(request).toHaveBeenCalledTimes(5);
  expect(request.mock.calls[2]?.[0]).toBe('/api/friends?limit=50');
});
test('bounded stale read retries fail visibly without publishing a partial snapshot', async () => {
  const { service, request } = setup(); request.mockRejectedValue(new ApiError('stale_state'));
  await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'stale_state' }); expect(request).toHaveBeenCalledTimes(3);
});
test.each([{ ...empty, revision: 7 }, { ...empty, items: 'bad' }, { ...empty, nextCursor: 'bad/secret' }])(
  'rejects malformed pages', async body => {
    const { service, request } = setup(); request.mockResolvedValue(body); await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'invalid_response' });
  });
test('rejects overlaps and own-account relationships', async () => {
  const { service, request } = setup(); request.mockResolvedValue({ ...empty, items: [user] });
  await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'invalid_response' });
});
test('rejects a repeated cursor rather than looping', async () => {
  const { service, request } = setup(); request.mockResolvedValue({ ...empty, nextCursor: 'same' });
  await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'invalid_response' }); expect(request).toHaveBeenCalledTimes(2);
});
test('prefix search normalizes case, preserves pagination, and strips private fields and false presence', async () => {
  const { service, request } = setup(); request.mockResolvedValue({ items: [{ ...user, relationship: 'none', presence: 'online', email: 'secret', statusMessage: 'private' }], nextCursor: 'next' });
  const result = await service.searchPage(' BO ', 'previous');
  expect(request.mock.calls[0]?.[0]).toBe('/api/users/search?q=bo&limit=20&cursor=previous');
  expect(result).toEqual({ items: [{ ...user, relationship: 'none' }], nextCursor: 'next' });
});
test.each(['b', 'a'.repeat(65), 'Bob Smith', 'bob@example.test', '@bob'])('invalid remote prefix makes no request: %s', async query => {
  const { service, request } = setup(); await expect(service.searchUsers(query)).rejects.toMatchObject({ code: 'validation' }); expect(request).not.toHaveBeenCalled();
});
test.each([{ ...user, relationship: 'outgoing' }, { ...user, relationship: 'none', requestId: 'request-1' },
  { ...user, relationship: 'self' }, { ...user, relationship: 'blocked' }])('rejects invalid public relationship projections', async value => {
    const { service, request } = setup(); request.mockResolvedValue({ items: [value], nextCursor: null });
    await expect(service.searchUsers('bo')).rejects.toMatchObject({ code: 'invalid_response' });
  });
test('public profile uses GET by immutable ID and cannot return a different person', async () => {
  const { service, request } = setup(); request.mockResolvedValue({ user: { ...user, relationship: 'none' } });
  expect(await service.getPublicProfile(user.id)).toEqual({ ...user, relationship: 'none' });
  await expect(service.getPublicProfile('other-id')).rejects.toMatchObject({ code: 'invalid_response' });
});
test('all mutations use exact DB-3 verbs, target fields and statuses', async () => {
  const { service, request } = setup(); request.mockResolvedValue(undefined);
  request.mockResolvedValueOnce({ request: { ...pending, direction: 'outgoing' } }); await service.sendRequest(user.id);
  request.mockResolvedValueOnce({ request: { ...pending, status: 'accepted' } }); await service.acceptRequest('request-1');
  request.mockResolvedValueOnce({ request: { ...pending, status: 'declined' } }); await service.declineRequest('request-1');
  await service.cancelRequest('request-1'); await service.removeFriend(user.id); await service.blockUser(user.id); await service.unblockUser(user.id);
  expect(request.mock.calls.map(([path, options]) => [path, options.method, options.body, options.status])).toEqual([
    ['/api/friends/requests', 'POST', { userId: user.id }, 201], ['/api/friends/requests/request-1/accept', 'POST', undefined, 200],
    ['/api/friends/requests/request-1/decline', 'POST', undefined, 200], ['/api/friends/requests/request-1', 'DELETE', undefined, 204],
    ['/api/friends/bob-id', 'DELETE', undefined, 204], ['/api/blocks', 'POST', { userId: user.id }, 204], ['/api/blocks/bob-id', 'DELETE', undefined, 204],
  ]);
});
test('write conflicts are never automatically retried', async () => {
  const { service, request } = setup(); request.mockRejectedValue(new ApiError('conflict'));
  await expect(service.blockUser(user.id)).rejects.toMatchObject({ code: 'conflict' }); expect(request).toHaveBeenCalledTimes(1);
});
