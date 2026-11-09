import type { PresenceStatus } from '@/messaging/messageModel';
import type { ProfileAvatarId } from '@/profiles/profileModel';

/** Only public discovery fields. Status messages, preferences and account data stay private. */
export interface FriendUser {
  id: string;
  username: string;
  displayName: string;
  avatar: ProfileAvatarId;
  /** A connected adapter may set this only from confirmed presence, never a local preference. */
  presence?: PresenceStatus;
}

export type RelationshipStatus = 'self' | 'none' | 'friend' | 'incoming' | 'outgoing' | 'blocked';

export interface UserSearchResult extends FriendUser {
  relationship: RelationshipStatus;
  requestId?: string;
}

export type Friend = FriendUser;
export type BlockedUser = FriendUser;

export interface FriendRequest {
  id: string;
  user: FriendUser;
  createdAt: string;
}

/** All relationship collections describe the same authoritative service revision. */
export interface FriendsSnapshot {
  friends: Friend[];
  incomingRequests: FriendRequest[];
  outgoingRequests: FriendRequest[];
  blockedUsers: BlockedUser[];
}

export interface UserRelationship {
  relationship: RelationshipStatus;
  requestId?: string;
}

export function relationshipForUser(
  snapshot: FriendsSnapshot,
  userId: string,
  currentUserId: string,
): UserRelationship {
  if (userId === currentUserId) return { relationship: 'self' };
  if (snapshot.blockedUsers.some((user) => user.id === userId)) return { relationship: 'blocked' };
  if (snapshot.friends.some((user) => user.id === userId)) return { relationship: 'friend' };
  const incoming = snapshot.incomingRequests.find((request) => request.user.id === userId);
  if (incoming) return { relationship: 'incoming', requestId: incoming.id };
  const outgoing = snapshot.outgoingRequests.find((request) => request.user.id === userId);
  if (outgoing) return { relationship: 'outgoing', requestId: outgoing.id };
  return { relationship: 'none' };
}

export type FriendsServiceErrorCode =
  | 'self_request'
  | 'duplicate_request'
  | 'blocked_user'
  | 'invalid_transition'
  | 'unavailable'
  | 'invalid_query'
  | 'identity_mismatch';

const errorMessages: Record<FriendsServiceErrorCode, string> = {
  self_request: 'You cannot send a friend request to yourself.',
  duplicate_request: 'This relationship already exists. Refresh to see its current status.',
  blocked_user: 'Unblock this user before sending a friend request.',
  invalid_transition: 'This action is no longer available. Refresh and try again.',
  unavailable: 'This action is unavailable. Refresh and try again.',
  invalid_query: 'Enter a username of 64 characters or fewer without control characters.',
  identity_mismatch: 'Your identity changed. Reload before continuing.',
};

/** Public messages deliberately exclude usernames, IDs, transport bodies and account details. */
export class FriendsServiceError extends Error {
  constructor(public readonly code: FriendsServiceErrorCode) {
    super(errorMessages[code]);
    this.name = 'FriendsServiceError';
  }
}
