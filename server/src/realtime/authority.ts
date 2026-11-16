import { callAdapter } from './adapterCall.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import { safeLog } from './logger.ts';
import type { Connection } from './registry.ts';

/**
 * Whether a connection may receive protected events for a conversation RIGHT NOW. A cached room
 * grant can be stale (a block, an unfriend or a logout committed moments ago), so when the
 * authorizer offers `canReceive` it is consulted immediately before each delivery. Without that
 * method the room grant is the only authority (legacy behavior). A failure or timeout withholds
 * delivery: the recipient reconciles from authorized history instead.
 */
export async function mayReceive(config: ResolvedRealtimeConfig, connection: Connection, conversationId: string): Promise<boolean> {
  const authorizer = config.authorizer;
  if (!authorizer?.canReceive) return !connection.closed && connection.user.conversations.has(conversationId);
  const canReceive = authorizer.canReceive.bind(authorizer);
  const result = await callAdapter(() => canReceive(connection.actor, conversationId), config.timing.adapterTimeoutMs);
  if (!result.ok) {
    safeLog(config.logger, 'warn', 'realtime.delivery.authorization_failed', { outcome: result.reason });
    return false;
  }
  // The grant may have been revoked, or the socket closed, while the check was in flight.
  return result.value === true && !connection.closed && connection.user.conversations.has(conversationId);
}
