import type { Connection, UserState } from './registry.ts';

/** Socket IDs never contain ':', so these prefixed names cannot collide with per-socket rooms. */
export const conversationRoom = (conversationId: string): string => `conv:${conversationId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
export const isConversationRoom = (room: string): boolean => room.startsWith('conv:');

/**
 * The only code that joins or leaves Socket.IO rooms. Room membership always mirrors the
 * authorizer's grants in `UserState.conversations`; clients cannot select rooms.
 */
export class RoomManager {
  readonly #onConversationLeft: (user: UserState, conversationId: string) => void;

  constructor(onConversationLeft: (user: UserState, conversationId: string) => void) {
    this.#onConversationLeft = onConversationLeft;
  }

  joinConnection(connection: Connection): void {
    if (connection.closed) return;
    void connection.socket.join([
      userRoom(connection.actor.userId),
      ...[...connection.user.conversations].map(conversationRoom),
    ]);
  }

  /** Applies a fresh grant set to every connection of the user. */
  applyGrants(user: UserState, next: ReadonlySet<string>): { added: string[]; removed: string[] } {
    const removed = [...user.conversations].filter((id) => !next.has(id));
    const added = [...next].filter((id) => !user.conversations.has(id));
    user.conversations = new Set(next);
    for (const connection of user.connections) {
      if (connection.closed) continue;
      for (const id of removed) void connection.socket.leave(conversationRoom(id));
      if (added.length > 0) void connection.socket.join(added.map(conversationRoom));
    }
    for (const id of removed) this.#onConversationLeft(user, id);
    return { added, removed };
  }

  /** Immediate, in-memory revocation of one conversation for one user. */
  revoke(user: UserState, conversationId: string): boolean {
    if (!user.conversations.has(conversationId)) return false;
    const next = new Set(user.conversations);
    next.delete(conversationId);
    this.applyGrants(user, next);
    return true;
  }
}
