import type { DefaultEventsMap, Socket } from 'socket.io';
import type { RealtimeRates } from './config.ts';
import type { RealtimeActor } from './contracts.ts';
import { TokenBucket } from './rateLimiter.ts';

/** Result of a successful handshake, stored on `socket.data` between middleware and `connection`. */
export interface HandshakeGrant {
  readonly actor: RealtimeActor;
  readonly expiresAt: number;
  readonly conversationIds: readonly string[];
  readonly blockedUserIds: readonly string[];
  /** Access sequence taken just before the authorizer was queried (orders snapshots and revocations). */
  readonly loadedSequence: number;
}

export interface RealtimeSocketData {
  realtime?: HandshakeGrant;
}

export type RealtimeSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, RealtimeSocketData>;

export interface ConnectionBuckets {
  readonly events: TokenBucket;
  readonly typing: TokenBucket;
  readonly read: TokenBucket;
  readonly send: TokenBucket;
  readonly presence: TokenBucket;
  readonly invalid: TokenBucket;
}

/** Per-user authorization state shared by every connection of that user. */
export interface UserState {
  readonly userId: string;
  readonly connections: Set<Connection>;
  /** Server-authorized conversation IDs (the source of `conv:*` room membership). */
  conversations: Set<string>;
  /** Users with a block relationship with this user, as reported by the authorizer. */
  blocked: Set<string>;
  /** `loadedSequence` of the authorizer snapshot in effect; older snapshots are never applied over it. */
  snapshotSequence: number;
}

export interface Connection {
  readonly id: string;
  readonly socket: RealtimeSocket;
  readonly actor: RealtimeActor;
  readonly user: UserState;
  readonly connectedAt: number;
  readonly buckets: ConnectionBuckets;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout | null;
  closed: boolean;
  pendingAcks: number;
  pendingDeliveryAcks: number;
  /** Last validated `presence:subscribe` request, without the actor's own ID. */
  presenceRequested: readonly string[];
  /** Subjects this connection is currently authorized to observe. */
  readonly presenceAuthorized: Set<string>;
  presenceGeneration: number;
  /** Serializes typing events while an async security policy is configured. */
  typingChain: Promise<void>;
  /** Keeps `presence:subscribe` requests in arrival order while an async security policy is configured. */
  presenceChain: Promise<void>;
}

export function createBuckets(rates: RealtimeRates, now: () => number): ConnectionBuckets {
  return {
    events: new TokenBucket(rates.events, now),
    typing: new TokenBucket(rates.typing, now),
    read: new TokenBucket(rates.read, now),
    send: new TokenBucket(rates.send, now),
    presence: new TokenBucket(rates.presence, now),
    invalid: new TokenBucket(rates.invalid, now),
  };
}

/** In-memory indexes of authenticated connections. Single-process by design. */
export class ConnectionRegistry {
  pendingHandshakes = 0;
  readonly #connections = new Map<string, Connection>();
  readonly #users = new Map<string, UserState>();
  readonly #sessions = new Map<string, Set<Connection>>();
  /** Reverse block index: userId → connected users whose block lists contain userId. */
  readonly #blockedBy = new Map<string, Set<string>>();

  get connectionCount(): number {
    return this.#connections.size;
  }

  get userCount(): number {
    return this.#users.size;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  connection(socketId: string): Connection | undefined {
    return this.#connections.get(socketId);
  }

  user(userId: string): UserState | undefined {
    return this.#users.get(userId);
  }

  connectionsForUser(userId: string): number {
    return this.#users.get(userId)?.connections.size ?? 0;
  }

  sessionConnections(sessionId: string): Connection[] {
    return [...(this.#sessions.get(sessionId) ?? [])];
  }

  sessionReferences(): Array<{ sessionId: string; userId: string }> {
    const references: Array<{ sessionId: string; userId: string }> = [];
    for (const [sessionId, connections] of this.#sessions) {
      const first = connections.values().next();
      if (!first.done) references.push({ sessionId, userId: first.value.actor.userId });
    }
    return references;
  }

  allConnections(): Connection[] {
    return [...this.#connections.values()];
  }

  allUsers(): UserState[] {
    return [...this.#users.values()];
  }

  ensureUser(userId: string): { user: UserState; created: boolean } {
    const existing = this.#users.get(userId);
    if (existing) return { user: existing, created: false };
    const user: UserState = {
      userId,
      connections: new Set(),
      conversations: new Set(),
      blocked: new Set(),
      snapshotSequence: Number.NEGATIVE_INFINITY,
    };
    this.#users.set(userId, user);
    return { user, created: true };
  }

  attach(connection: Connection): void {
    this.#connections.set(connection.id, connection);
    connection.user.connections.add(connection);
    const session = this.#sessions.get(connection.actor.sessionId) ?? new Set<Connection>();
    session.add(connection);
    this.#sessions.set(connection.actor.sessionId, session);
  }

  /** Removes a connection. When it was the user's last, the user's state and block contributions go too. */
  detach(connection: Connection): { lastForUser: boolean } {
    if (this.#connections.get(connection.id) !== connection) return { lastForUser: false };
    this.#connections.delete(connection.id);
    const session = this.#sessions.get(connection.actor.sessionId);
    session?.delete(connection);
    if (session && session.size === 0) this.#sessions.delete(connection.actor.sessionId);
    const user = connection.user;
    user.connections.delete(connection);
    if (user.connections.size > 0) return { lastForUser: false };
    this.replaceBlocked(user, new Set());
    this.#users.delete(user.userId);
    return { lastForUser: true };
  }

  /** Replaces a user's block list and the reverse index; returns which pairs changed. */
  replaceBlocked(user: UserState, next: ReadonlySet<string>): { added: string[]; removed: string[] } {
    const added = [...next].filter((id) => !user.blocked.has(id) && id !== user.userId);
    const removed = [...user.blocked].filter((id) => !next.has(id));
    for (const id of removed) {
      const index = this.#blockedBy.get(id);
      index?.delete(user.userId);
      if (index && index.size === 0) this.#blockedBy.delete(id);
    }
    for (const id of added) {
      const index = this.#blockedBy.get(id) ?? new Set<string>();
      index.add(user.userId);
      this.#blockedBy.set(id, index);
    }
    user.blocked = new Set([...next].filter((id) => id !== user.userId));
    return { added, removed };
  }

  isBlockedPair(first: string, second: string): boolean {
    return Boolean(this.#users.get(first)?.blocked.has(second) || this.#users.get(second)?.blocked.has(first));
  }

  /** Users who must not receive this user's activity (block list plus reverse index). */
  excludedUserIds(userId: string): Set<string> {
    return new Set([...(this.#users.get(userId)?.blocked ?? []), ...(this.#blockedBy.get(userId) ?? [])]);
  }
}
