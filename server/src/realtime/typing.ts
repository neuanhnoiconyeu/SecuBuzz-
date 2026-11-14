import type { ServerClock } from './clock.ts';
import type { RealtimeActor } from './contracts.ts';
import { SERVER_EVENTS, type TypingUpdateEvent } from './protocol.ts';
import type { Connection, ConnectionRegistry } from './registry.ts';
import { conversationRoom, userRoom } from './rooms.ts';

/** Minimal broadcast surface of a Socket.IO namespace, so the router stays testable. */
export interface RoomBroadcaster {
  to(room: string): { except(rooms: string[]): { emit(event: string, payload: unknown): unknown } };
}

/**
 * Ephemeral typing relay. State lives only in memory, keyed by conversation → user → connection,
 * so a user counts as typing while any of their connections is typing there.
 */
export class TypingRouter {
  readonly #active = new Map<string, Map<string, Map<string, number>>>();
  readonly #broadcaster: RoomBroadcaster;
  readonly #registry: ConnectionRegistry;
  readonly #clock: ServerClock;
  readonly #ttlMs: number;

  constructor(broadcaster: RoomBroadcaster, registry: ConnectionRegistry, clock: ServerClock, ttlMs: number) {
    this.#broadcaster = broadcaster;
    this.#registry = registry;
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  get entryCount(): number {
    let count = 0;
    for (const users of this.#active.values()) for (const connections of users.values()) count += connections.size;
    return count;
  }

  /** Called after validation. Drops the event unless the connection holds the conversation grant. */
  handle(connection: Connection, conversationId: string, isTyping: boolean): void {
    if (connection.closed || !connection.user.conversations.has(conversationId)) return;
    const userId = connection.actor.userId;
    if (isTyping) {
      const users = this.#active.get(conversationId) ?? new Map<string, Map<string, number>>();
      const connections = users.get(userId) ?? new Map<string, number>();
      connections.set(connection.id, this.#clock.nowMs() + this.#ttlMs);
      users.set(userId, connections);
      this.#active.set(conversationId, users);
      this.#broadcast(connection.actor, conversationId, true);
      return;
    }
    const connections = this.#active.get(conversationId)?.get(userId);
    if (!connections?.delete(connection.id)) return;
    this.#prune(conversationId, userId);
    if (!this.#isTyping(conversationId, userId)) this.#broadcast(connection.actor, conversationId, false);
  }

  /** Disconnect cleanup: stop indicators this connection was holding. Call before the registry detaches it. */
  clearConnection(connection: Connection): void {
    const userId = connection.actor.userId;
    for (const [conversationId, users] of [...this.#active]) {
      const connections = users.get(userId);
      if (!connections) continue;
      const expiresAt = connections.get(connection.id);
      if (expiresAt === undefined) continue;
      connections.delete(connection.id);
      this.#prune(conversationId, userId);
      if (expiresAt > this.#clock.nowMs() && !this.#isTyping(conversationId, userId)) {
        this.#broadcast(connection.actor, conversationId, false);
      }
    }
  }

  /** Revocation cleanup: the user no longer belongs to the conversation. */
  clearUserInConversation(actor: RealtimeActor, conversationId: string): void {
    const users = this.#active.get(conversationId);
    const connections = users?.get(actor.userId);
    if (!users || !connections) return;
    const wasTyping = this.#isTyping(conversationId, actor.userId);
    users.delete(actor.userId);
    if (users.size === 0) this.#active.delete(conversationId);
    if (wasTyping) this.#broadcast(actor, conversationId, false);
  }

  /** Drops expired entries. Clients already expire remote typing after 5 s, so nothing is emitted. */
  sweep(): void {
    const now = this.#clock.nowMs();
    for (const [conversationId, users] of [...this.#active]) {
      for (const [userId, connections] of [...users]) {
        for (const [connectionId, expiresAt] of [...connections]) if (expiresAt <= now) connections.delete(connectionId);
        if (connections.size === 0) users.delete(userId);
      }
      if (users.size === 0) this.#active.delete(conversationId);
    }
  }

  clear(): void {
    this.#active.clear();
  }

  #isTyping(conversationId: string, userId: string): boolean {
    const now = this.#clock.nowMs();
    for (const expiresAt of this.#active.get(conversationId)?.get(userId)?.values() ?? []) if (expiresAt > now) return true;
    return false;
  }

  #prune(conversationId: string, userId: string): void {
    const users = this.#active.get(conversationId);
    if (!users) return;
    if (users.get(userId)?.size === 0) users.delete(userId);
    if (users.size === 0) this.#active.delete(conversationId);
  }

  #broadcast(actor: RealtimeActor, conversationId: string, isTyping: boolean): void {
    const excluded = [userRoom(actor.userId), ...[...this.#registry.excludedUserIds(actor.userId)].map(userRoom)];
    const payload: TypingUpdateEvent = {
      conversationId,
      userId: actor.userId,
      displayName: actor.displayName,
      isTyping,
      timestamp: this.#clock.next(JSON.stringify(['typing', conversationId, actor.userId])),
    };
    this.#broadcaster.to(conversationRoom(conversationId)).except(excluded).emit(SERVER_EVENTS.typingUpdate, payload);
  }
}
