import { randomUUID } from 'node:crypto';
import { BUZZ_COOLDOWN_MS, type BuzzEvent } from '../../../shared/buzz.ts';
import type { DirectCallConversationResolver } from '../calls/config.ts';
import { parseDirectParticipants } from '../calls/validation.ts';
import { callAdapter } from './adapterCall.ts';
import type { ServerClock } from './clock.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import type { EventGate } from './eventGate.ts';
import { CLIENT_EVENTS, SERVER_EVENTS, errorAck } from './protocol.ts';
import type { Connection, ConnectionRegistry } from './registry.ts';

/** Uses DATA's current direct-conversation policy, independently of LiveKit readiness.
 * No message store, durable queue, identity claims or attachment/E2EE operations. */
export class BuzzRouter {
  private readonly cooldowns = new Map<string, number>();
  private readonly config: ResolvedRealtimeConfig;
  private readonly registry: ConnectionRegistry;
  private readonly clock: ServerClock;
  private readonly gate: EventGate;
  private readonly resolver: DirectCallConversationResolver | undefined;
  constructor(config: ResolvedRealtimeConfig, registry: ConnectionRegistry, clock: ServerClock,
    gate: EventGate, resolver: DirectCallConversationResolver | undefined) {
    this.config = config; this.registry = registry; this.clock = clock; this.gate = gate; this.resolver = resolver;
  }

  private current(connection: Connection, cid: string): boolean {
    return !connection.closed && connection.expiresAt > this.clock.nowMs() && connection.user.conversations.has(cid);
  }
  async handle(connection: Connection, cid: string): Promise<unknown> {
    if (!this.resolver) return errorAck('unavailable');
    if (!this.current(connection, cid)) return errorAck('unauthorized_conversation');
    const now = this.clock.nowMs();
    for (const [user, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(user);
    if (this.cooldowns.has(connection.actor.userId) || this.cooldowns.size >= this.config.limits.maxRevokedSessions) return errorAck('rate_limited');
    // Reserve before any await: concurrent tabs/reconnects cannot race the account cooldown.
    // Failed attempts also consume this short window; no automatic delivery retries.
    this.cooldowns.set(connection.actor.userId, now + BUZZ_COOLDOWN_MS);
    const decision = await this.gate.evaluate(connection, CLIENT_EVENTS.buzzSend, { conversationId: cid }, { conversationId: cid });
    if (decision !== 'allow') return errorAck(decision === 'deny' ? 'policy_denied' : 'unavailable');
    const result = await callAdapter(() => this.resolver!.resolveDirectConversation(connection.actor, cid), this.config.timing.adapterTimeoutMs);
    if (!result.ok) return errorAck('unavailable');
    if (!result.value) return errorAck('unauthorized_conversation');
    const peerId = result.value.participants?.find(p => p.userId !== connection.actor.userId)?.userId;
    const participants = peerId && parseDirectParticipants(result.value, cid, connection.actor.userId, peerId);
    if (!participants || !this.current(connection, cid) || this.registry.isBlockedPair(connection.actor.userId, peerId!)) return errorAck('unauthorized_conversation');
    const senderSequence = connection.user.snapshotSequence;
    const targets: Array<{ connection: Connection; sequence: number }> = [];
    for (const target of this.registry.user(peerId!)?.connections ?? []) {
      if (!this.current(target, cid)) continue;
      const sequence = target.user.snapshotSequence;
      // Recheck each recipient session through DATA. Cached room membership alone is insufficient.
      const access = await callAdapter(() => this.resolver!.resolveDirectConversation(target.actor, cid), this.config.timing.adapterTimeoutMs);
      if (access.ok && access.value && parseDirectParticipants(access.value, cid, target.actor.userId, connection.actor.userId) &&
        sequence === target.user.snapshotSequence && this.current(target, cid)) targets.push({ connection: target, sequence });
    }
    if (!this.current(connection, cid) || senderSequence !== connection.user.snapshotSequence || this.registry.isBlockedPair(connection.actor.userId, peerId!)) return errorAck('unauthorized_conversation');
    const event: BuzzEvent = { id: randomUUID(), conversationId: cid, userId: connection.actor.userId,
      displayName: participants.find(p => p.userId === connection.actor.userId)!.displayName, timestamp: this.clock.nowIso() };
    let delivered = false;
    for (const { connection: target, sequence } of targets) if (this.current(target, cid) && target.user.snapshotSequence === sequence) {
      target.socket.volatile.emit(SERVER_EVENTS.buzzReceived, event); delivered = true;
    }
    return delivered ? event : errorAck('unavailable');
  }
  clear(): void { this.cooldowns.clear(); }
}
