import { createDemoProfile } from '@/profiles/profileModel';
import {
  FriendsServiceError,
  relationshipForUser,
  type BlockedUser,
  type Friend,
  type FriendRequest,
  type FriendsSnapshot,
  type FriendUser,
  type UserSearchResult,
} from './friendsModel';

/**
 * Authenticated adapters bind the actor to their session, never a mutation argument.
 * Failed remote calls must reject; they must never substitute demo results.
 */
export interface FriendsService {
  readonly mode: 'local-demo' | 'remote';
  /** An atomic snapshot prevents mismatched request/friend lists during refresh. */
  getSnapshot(): Promise<FriendsSnapshot>;
  searchUsers(query: string): Promise<UserSearchResult[]>;
  listFriends(): Promise<Friend[]>;
  listIncomingRequests(): Promise<FriendRequest[]>;
  listOutgoingRequests(): Promise<FriendRequest[]>;
  sendRequest(userId: string): Promise<void>;
  acceptRequest(requestId: string): Promise<void>;
  declineRequest(requestId: string): Promise<void>;
  cancelRequest(requestId: string): Promise<void>;
  removeFriend(userId: string): Promise<void>;
  listBlockedUsers(): Promise<BlockedUser[]>;
  blockUser(userId: string): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  /** Notify after confirmed state changes, including permission/presence changes when supported. */
  subscribeToChanges(listener: () => void): () => void;
}

function publicUser(user: FriendUser): FriendUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    ...(user.presence ? { presence: user.presence } : {}),
  };
}

const demoUsers: readonly FriendUser[] = [
  { id: 'demo-ava', username: 'ava.morgan', displayName: 'Ava Morgan', avatar: 'initials' },
  { id: 'demo-jules', username: 'jules.park', displayName: 'Jules Park', avatar: 'star' },
  { id: 'demo-kai', username: 'kai.chen', displayName: 'Kai Chen', avatar: 'rocket' },
  { id: 'demo-rowan', username: 'rowan.blake', displayName: 'Rowan Blake', avatar: 'cat' },
  { id: 'demo-mina', username: 'mina.patel', displayName: 'Mina Patel', avatar: 'smile' },
];

/**
 * Explicitly fictional fixtures in page memory. A new instance starts a fresh demo;
 * it does not contact accounts, broadcast presence, authorize users, or enforce server blocks.
 */
export class LocalDemoFriendsService implements FriendsService {
  readonly mode = 'local-demo' as const;
  private currentUser: FriendUser;
  private readonly users = new Map<string, FriendUser>();
  private readonly friends = new Set<string>(['demo-ava']);
  private readonly blocked = new Set<string>(['demo-rowan']);
  private readonly incoming = new Map<string, { userId: string; createdAt: string }>();
  private readonly outgoing = new Map<string, { userId: string; createdAt: string }>();
  private readonly listeners = new Set<() => void>();
  private nextRequest = 0;

  constructor(currentUser: FriendUser = createDemoProfile()) {
    // Never allow a demo actor to alias one of the fixture targets.
    if (!currentUser.id || demoUsers.some((user) => user.id === currentUser.id)) {
      throw new FriendsServiceError('identity_mismatch');
    }
    this.currentUser = publicUser(currentUser);
    for (const user of demoUsers) this.users.set(user.id, publicUser(user));
    this.users.set(this.currentUser.id, publicUser(this.currentUser));
    const createdAt = new Date().toISOString();
    this.incoming.set('demo-request-incoming-jules', { userId: 'demo-jules', createdAt });
    this.outgoing.set('demo-request-outgoing-kai', { userId: 'demo-kai', createdAt });
  }

  /** Mirrors local profile presentation only; this is never a remote authorization mechanism. */
  updateCurrentUser(user: FriendUser): void {
    if (user.id !== this.currentUser.id) throw new FriendsServiceError('identity_mismatch');
    const next = publicUser(user);
    if (JSON.stringify(next) === JSON.stringify(this.currentUser)) return;
    this.currentUser = next;
    this.users.set(next.id, publicUser(next));
    this.notify();
  }

  private user(userId: string): FriendUser {
    const user = this.users.get(userId);
    if (!user) throw new FriendsServiceError('unavailable');
    return publicUser(user);
  }

  private target(userId: string): FriendUser {
    if (userId === this.currentUser.id) throw new FriendsServiceError('self_request');
    return this.user(userId);
  }

  private requests(source: Map<string, { userId: string; createdAt: string }>): FriendRequest[] {
    return Array.from(source, ([id, request]) => ({ id, user: this.user(request.userId), createdAt: request.createdAt }));
  }

  private snapshot(): FriendsSnapshot {
    return {
      friends: Array.from(this.friends, (id) => this.user(id)),
      incomingRequests: this.requests(this.incoming),
      outgoingRequests: this.requests(this.outgoing),
      blockedUsers: Array.from(this.blocked, (id) => this.user(id)),
    };
  }

  async getSnapshot(): Promise<FriendsSnapshot> {
    return this.snapshot();
  }

  async listFriends(): Promise<Friend[]> {
    return this.snapshot().friends;
  }

  async listIncomingRequests(): Promise<FriendRequest[]> {
    return this.requests(this.incoming);
  }

  async listOutgoingRequests(): Promise<FriendRequest[]> {
    return this.requests(this.outgoing);
  }

  async listBlockedUsers(): Promise<BlockedUser[]> {
    return this.snapshot().blockedUsers;
  }

  async searchUsers(query: string): Promise<UserSearchResult[]> {
    if (typeof query !== 'string' || query.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(query)) {
      throw new FriendsServiceError('invalid_query');
    }
    const normalized = query.trim().replace(/^@/, '').toLowerCase();
    if (!normalized) return [];
    const snapshot = this.snapshot();
    return Array.from(this.users.values())
      .filter((user) => user.username.toLowerCase().includes(normalized))
      .map((user) => ({ ...publicUser(user), ...relationshipForUser(snapshot, user.id, this.currentUser.id) }));
  }

  async sendRequest(userId: string): Promise<void> {
    this.target(userId);
    const { relationship } = relationshipForUser(this.snapshot(), userId, this.currentUser.id);
    if (relationship === 'blocked') throw new FriendsServiceError('blocked_user');
    if (relationship !== 'none') throw new FriendsServiceError('duplicate_request');
    this.outgoing.set(`demo-request-${++this.nextRequest}`, { userId, createdAt: new Date().toISOString() });
    this.notify();
  }

  async acceptRequest(requestId: string): Promise<void> {
    const request = this.incoming.get(requestId);
    if (!request || this.blocked.has(request.userId) || this.friends.has(request.userId)) {
      throw new FriendsServiceError('invalid_transition');
    }
    this.incoming.delete(requestId);
    this.friends.add(request.userId);
    this.notify();
  }

  async declineRequest(requestId: string): Promise<void> {
    if (!this.incoming.delete(requestId)) throw new FriendsServiceError('invalid_transition');
    this.notify();
  }

  async cancelRequest(requestId: string): Promise<void> {
    if (!this.outgoing.delete(requestId)) throw new FriendsServiceError('invalid_transition');
    this.notify();
  }

  async removeFriend(userId: string): Promise<void> {
    this.target(userId);
    if (this.friends.delete(userId)) this.notify();
  }

  async blockUser(userId: string): Promise<void> {
    this.target(userId);
    if (this.blocked.has(userId)) return;
    this.friends.delete(userId);
    for (const [id, request] of this.incoming) if (request.userId === userId) this.incoming.delete(id);
    for (const [id, request] of this.outgoing) if (request.userId === userId) this.outgoing.delete(id);
    this.blocked.add(userId);
    this.notify();
  }

  async unblockUser(userId: string): Promise<void> {
    this.target(userId);
    // Unblocking never restores a previous request or friendship implicitly.
    if (this.blocked.delete(userId)) this.notify();
  }

  subscribeToChanges(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A view failure must not change a confirmed relationship transition. */ }
    }
  }
}
