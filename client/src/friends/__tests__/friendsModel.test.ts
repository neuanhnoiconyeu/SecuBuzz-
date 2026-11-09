import { relationshipForUser, type FriendsSnapshot } from '../friendsModel';

const user = { id: 'user-1', username: 'public.name', displayName: 'Public Name', avatar: 'initials' as const };
const empty: FriendsSnapshot = { friends: [], incomingRequests: [], outgoingRequests: [], blockedUsers: [] };

test('resolves all relationship states from a shared snapshot', () => {
  expect(relationshipForUser(empty, 'self', 'self')).toEqual({ relationship: 'self' });
  expect(relationshipForUser(empty, user.id, 'self')).toEqual({ relationship: 'none' });
  expect(relationshipForUser({ ...empty, friends: [user] }, user.id, 'self')).toEqual({ relationship: 'friend' });
  const request = { id: 'incoming-1', user, createdAt: '2026-11-08T00:00:00.000Z' };
  expect(relationshipForUser({ ...empty, incomingRequests: [request] }, user.id, 'self'))
    .toEqual({ relationship: 'incoming', requestId: request.id });
  expect(relationshipForUser({ ...empty, outgoingRequests: [request] }, user.id, 'self'))
    .toEqual({ relationship: 'outgoing', requestId: request.id });
  expect(relationshipForUser({ ...empty, blockedUsers: [user] }, user.id, 'self')).toEqual({ relationship: 'blocked' });
});

test('blocked state takes precedence over stale friendship or request records', () => {
  const request = { id: 'request-1', user, createdAt: '2026-11-08T00:00:00.000Z' };
  expect(relationshipForUser({
    friends: [user], incomingRequests: [request], outgoingRequests: [request], blockedUsers: [user],
  }, user.id, 'self')).toEqual({ relationship: 'blocked' });
});
