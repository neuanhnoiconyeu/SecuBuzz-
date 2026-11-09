import { createDemoProfile } from '@/profiles/profileModel';
import { FriendsServiceError, relationshipForUser } from '../friendsModel';
import { LocalDemoFriendsService } from '../friendsService';

describe('LocalDemoFriendsService', () => {
  test('uses explicit isolated demo fixtures with unknown presence and no persistence', async () => {
    const first = new LocalDemoFriendsService();
    expect(first.mode).toBe('local-demo');
    expect((await first.listFriends()).map((user) => user.id)).toEqual(['demo-ava']);
    expect((await first.listIncomingRequests())[0]?.user.id).toBe('demo-jules');
    expect((await first.listOutgoingRequests())[0]?.user.id).toBe('demo-kai');
    expect((await first.listBlockedUsers())[0]?.id).toBe('demo-rowan');
    await first.removeFriend('demo-ava');
    expect(await first.listFriends()).toHaveLength(0);
    expect(await new LocalDemoFriendsService().listFriends()).toHaveLength(1);
    expect(await first.searchUsers('mina')).toEqual([{
      id: 'demo-mina', username: 'mina.patel', displayName: 'Mina Patel', avatar: 'smile', relationship: 'none',
    }]);
  });

  test.each([
    ['@AvA.MoRgAn', 'friend', 'demo-ava'],
    ['jules', 'incoming', 'demo-jules'],
    ['kai', 'outgoing', 'demo-kai'],
    ['rowan', 'blocked', 'demo-rowan'],
    ['demo-explorer', 'self', 'local-user'],
  ])('searches usernames with current relationship: %s', async (query, relationship, id) => {
    const service = new LocalDemoFriendsService();
    expect(await service.searchUsers(query)).toEqual([expect.objectContaining({ id, relationship })]);
  });

  test('does not expose a whole directory, invent unknown users or search private profile text', async () => {
    const service = new LocalDemoFriendsService({ ...createDemoProfile(), displayName: 'Private display match' });
    expect(await service.searchUsers('')).toEqual([]);
    expect(await service.searchUsers(' @ ')).toEqual([]);
    expect(await service.searchUsers('not-a-demo-account')).toEqual([]);
    expect(await service.searchUsers('Private display match')).toEqual([]);
    const [self] = await service.searchUsers('demo-explorer');
    expect(Object.keys(self!).sort()).toEqual(['avatar', 'displayName', 'id', 'relationship', 'username']);
    expect(self).not.toHaveProperty('statusMessage');
    expect(self).not.toHaveProperty('presencePreference');
    expect(self).not.toHaveProperty('isDemo');
    expect(self).not.toHaveProperty('presence');
  });

  test.each(['a'.repeat(65), 'a\u0000', 'line\nbreak'])('rejects malformed search safely', async (query) => {
    const service = new LocalDemoFriendsService();
    await expect(service.searchUsers(query)).rejects.toMatchObject({ code: 'invalid_query' });
  });

  test('sends one request and returns its outgoing relationship and request ID', async () => {
    const service = new LocalDemoFriendsService();
    await service.sendRequest('demo-mina');
    const requests = await service.listOutgoingRequests();
    const request = requests.find((item) => item.user.id === 'demo-mina');
    expect(request).toBeDefined();
    expect(Number.isNaN(Date.parse(request!.createdAt))).toBe(false);
    expect(await service.searchUsers('mina')).toEqual([
      expect.objectContaining({ relationship: 'outgoing', requestId: request!.id }),
    ]);
  });

  test.each(['demo-ava', 'demo-jules', 'demo-kai'])('prevents duplicate or crossed requests to %s', async (userId) => {
    const service = new LocalDemoFriendsService();
    const before = await service.getSnapshot();
    await expect(service.sendRequest(userId)).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(await service.getSnapshot()).toEqual(before);
  });

  test('cannot send to self, a blocked user or an unavailable user', async () => {
    const service = new LocalDemoFriendsService();
    await expect(service.sendRequest('local-user')).rejects.toMatchObject({ code: 'self_request' });
    await expect(service.sendRequest('demo-rowan')).rejects.toMatchObject({ code: 'blocked_user' });
    await expect(service.sendRequest('private-account-name')).rejects.toMatchObject({ code: 'unavailable' });
  });

  test('simultaneous duplicate sends create exactly one request', async () => {
    const service = new LocalDemoFriendsService();
    const outcomes = await Promise.allSettled([service.sendRequest('demo-mina'), service.sendRequest('demo-mina')]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await service.listOutgoingRequests()).filter((request) => request.user.id === 'demo-mina')).toHaveLength(1);
  });

  test('accepts an incoming request once without duplicate friendships', async () => {
    const service = new LocalDemoFriendsService();
    const incoming = (await service.listIncomingRequests())[0]!;
    const outcomes = await Promise.allSettled([service.acceptRequest(incoming.id), service.acceptRequest(incoming.id)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await service.listIncomingRequests()).toHaveLength(0);
    expect((await service.listFriends()).filter((friend) => friend.id === incoming.user.id)).toHaveLength(1);
    expect((await service.searchUsers('jules'))[0]?.relationship).toBe('friend');
  });

  test('declines an incoming request and rejects accepting the stale request', async () => {
    const service = new LocalDemoFriendsService();
    const incoming = (await service.listIncomingRequests())[0]!;
    await service.declineRequest(incoming.id);
    await expect(service.acceptRequest(incoming.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(service.declineRequest(incoming.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    expect((await service.searchUsers('jules'))[0]?.relationship).toBe('none');
  });

  test('cancels an outgoing request without affecting incoming requests', async () => {
    const service = new LocalDemoFriendsService();
    const outgoing = (await service.listOutgoingRequests())[0]!;
    await service.cancelRequest(outgoing.id);
    await expect(service.cancelRequest(outgoing.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await service.listOutgoingRequests()).toHaveLength(0);
    expect(await service.listIncomingRequests()).toHaveLength(1);
    expect((await service.searchUsers('kai'))[0]?.relationship).toBe('none');
  });

  test('rejects wrong-direction request operations and unknown or terminal request IDs', async () => {
    const service = new LocalDemoFriendsService();
    const incoming = (await service.listIncomingRequests())[0]!;
    const outgoing = (await service.listOutgoingRequests())[0]!;
    const before = await service.getSnapshot();
    await expect(service.acceptRequest(outgoing.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(service.declineRequest(outgoing.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(service.cancelRequest(incoming.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(service.acceptRequest('missing')).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await service.getSnapshot()).toEqual(before);
  });

  test('removes a friend idempotently and permits a new request without restoring friendship', async () => {
    const service = new LocalDemoFriendsService();
    await service.removeFriend('demo-ava');
    await service.removeFriend('demo-ava');
    expect(await service.listFriends()).toHaveLength(0);
    await service.sendRequest('demo-ava');
    expect((await service.searchUsers('ava'))[0]?.relationship).toBe('outgoing');
    expect(await service.listFriends()).toHaveLength(0);
  });

  test.each(['demo-ava', 'demo-jules', 'demo-kai'])('blocking %s removes conflicting relationship state', async (userId) => {
    const service = new LocalDemoFriendsService();
    await service.blockUser(userId);
    await service.blockUser(userId);
    const snapshot = await service.getSnapshot();
    expect(snapshot.friends.some((user) => user.id === userId)).toBe(false);
    expect(snapshot.incomingRequests.some((request) => request.user.id === userId)).toBe(false);
    expect(snapshot.outgoingRequests.some((request) => request.user.id === userId)).toBe(false);
    expect(snapshot.blockedUsers.filter((user) => user.id === userId)).toHaveLength(1);
    await expect(service.sendRequest(userId)).rejects.toMatchObject({ code: 'blocked_user' });
    await service.unblockUser(userId);
    await service.unblockUser(userId);
    expect(relationshipForUser(await service.getSnapshot(), userId, 'local-user').relationship).toBe('none');
  });

  test('cannot block self or create hidden records for unavailable users', async () => {
    const service = new LocalDemoFriendsService();
    await expect(service.blockUser('local-user')).rejects.toMatchObject({ code: 'self_request' });
    await expect(service.blockUser('unavailable')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(service.unblockUser('unavailable')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(service.removeFriend('unavailable')).rejects.toMatchObject({ code: 'unavailable' });
  });

  test('notifies all subscribers only after transitions and isolates a failing listener', async () => {
    const service = new LocalDemoFriendsService();
    const bad = jest.fn(() => { throw new Error('UI failure'); });
    const listener = jest.fn();
    service.subscribeToChanges(bad);
    const unsubscribe = service.subscribeToChanges(listener);
    await service.blockUser('demo-ava');
    expect(listener).toHaveBeenCalledTimes(1);
    await service.blockUser('demo-ava');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await service.unblockUser('demo-ava');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  test('returns detached public objects so callers cannot mutate relationship state', async () => {
    const service = new LocalDemoFriendsService();
    const snapshot = await service.getSnapshot();
    snapshot.friends[0]!.displayName = 'Changed';
    snapshot.incomingRequests[0]!.user.id = 'malicious-id';
    snapshot.outgoingRequests.length = 0;
    snapshot.blockedUsers[0]!.username = 'Changed';
    const [searchResult] = await service.searchUsers('mina');
    searchResult!.id = 'changed';
    const next = await service.getSnapshot();
    expect(next.friends[0]?.displayName).toBe('Ava Morgan');
    expect(next.incomingRequests[0]?.user.id).toBe('demo-jules');
    expect(next.outgoingRequests).toHaveLength(1);
    expect(next.blockedUsers[0]?.username).toBe('rowan.blake');
    await expect(service.sendRequest('demo-mina')).resolves.toBeUndefined();
  });

  test('mirrors local profile presentation while preserving identity and excluding preferences', async () => {
    const profile = createDemoProfile();
    const service = new LocalDemoFriendsService(profile);
    profile.displayName = 'External mutation';
    expect((await service.searchUsers('demo-explorer'))[0]?.displayName).toBe('Demo Explorer');
    service.updateCurrentUser({ ...profile, displayName: 'Nova', avatar: 'rocket' });
    const [self] = await service.searchUsers('demo-explorer');
    expect(self).toEqual({
      id: 'local-user', username: 'demo-explorer', displayName: 'Nova', avatar: 'rocket', relationship: 'self',
    });
    expect(() => service.updateCurrentUser({ ...profile, id: 'another-user' })).toThrow(FriendsServiceError);
    expect((await service.searchUsers('demo-explorer'))[0]?.id).toBe('local-user');
    expect(() => new LocalDemoFriendsService({ ...profile, id: 'demo-ava' })).toThrow(FriendsServiceError);
  });

  test('uses safe public failure messages without echoing target IDs or internal details', async () => {
    const service = new LocalDemoFriendsService();
    try {
      await service.sendRequest('private-account-identifier');
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(FriendsServiceError);
      expect((error as Error).message).not.toMatch(/private-account-identifier/);
    }
  });
});
