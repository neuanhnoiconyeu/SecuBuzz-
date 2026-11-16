import { callAdapter } from './adapterCall.ts';
import { mayReceive } from './authority.ts';
import type { ServerClock } from './clock.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import type { AnyMessageEnvelope, MessageStore, StoreMessageRequest } from './contracts.ts';
import type { EventGate } from './eventGate.ts';
import { safeLog } from './logger.ts';
import { classifyStoreFailure, CLIENT_EVENTS, errorAck, SERVER_EVENTS, type ErrorAck, type SendAck } from './protocol.ts';
import type { ReceiptRouter } from './receipts.ts';
import type { Connection, ConnectionRegistry } from './registry.ts';
import { conversationRoom } from './rooms.ts';
import { envelopeFingerprint, parseKeyVerification, parseStoreOutcome } from './validation.ts';
import { envelopeV2Fingerprint, type MessageEnvelopeV2 } from '../e2ee/envelope.ts';

/** The part of a namespace adapter needed for per-recipient fan-out. */
export interface RoomMembership {
  readonly rooms: Map<string, Set<string>>;
}

export type SendResult = SendAck | ErrorAck;

interface InFlightSend {
  readonly fingerprint: string;
  readonly result: Promise<SendResult>;
}

/** Called when a recipient's cached authority proved stale, so its grants can be refreshed now. */
export interface MessageRouterHooks {
  /** A store reported that this connection's session or proof is no longer valid. */
  readonly onSessionInvalid: (connection: Connection) => void;
  /** Delivery to this user was withheld because current authority is missing. */
  readonly onStaleAuthority: (userId: string) => void;
}

function freezeEnvelope(envelope: AnyMessageEnvelope): AnyMessageEnvelope {
  return Object.freeze({ ...envelope, encryption: Object.freeze({ ...envelope.encryption }) }) as AnyMessageEnvelope;
}

/** The canonical fingerprint for the envelope's own version. */
export function fingerprintOf(envelope: AnyMessageEnvelope): string {
  return envelope.encryption.version === 2
    ? envelopeV2Fingerprint(envelope as MessageEnvelopeV2)
    : envelopeFingerprint(envelope as Parameters<typeof envelopeFingerprint>[0]);
}

/**
 * The `message:send` boundary.
 *
 * Real-account mode (the connection holds a bound `store`): the envelope is version 2, the store's
 * owner (DATA) authenticates the actor, verifies recipient keys and commits the ciphertext in one
 * pipeline, and a message is acknowledged and broadcast only after that commit. The realtime layer
 * never verifies keys itself in this mode and never decrypts or rewrites the envelope.
 *
 * Legacy mode (global `messageStore` and `recipientKeyVerifier`): unchanged Phase 8.7B behavior.
 * Without either arrangement every valid send ends in `recipient_keys_unavailable`.
 */
export class MessageRouter {
  readonly #inFlight = new Map<string, InFlightSend>();
  readonly #config: ResolvedRealtimeConfig;
  readonly #registry: ConnectionRegistry;
  readonly #clock: ServerClock;
  readonly #gate: EventGate;
  readonly #receipts: ReceiptRouter;
  readonly #membership: RoomMembership;
  readonly #hooks: MessageRouterHooks;

  constructor(
    config: ResolvedRealtimeConfig,
    registry: ConnectionRegistry,
    clock: ServerClock,
    gate: EventGate,
    receipts: ReceiptRouter,
    membership: RoomMembership,
    hooks: MessageRouterHooks,
  ) {
    this.#config = config;
    this.#registry = registry;
    this.#clock = clock;
    this.#gate = gate;
    this.#receipts = receipts;
    this.#membership = membership;
    this.#hooks = hooks;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  get deliveryEnabled(): boolean {
    return Boolean(this.#config.connectionBinder) || Boolean(this.#config.messageStore && this.#config.recipientKeyVerifier);
  }

  /** `envelope` is already strictly parsed; this enforces identity, access, capability and idempotency. */
  async handleSend(connection: Connection, envelope: AnyMessageEnvelope, raw: unknown): Promise<SendResult> {
    const actor = connection.actor;
    const bound = connection.store;
    // In real-account mode the display name is checked by DATA against the CURRENT profile; the name
    // captured at handshake would wrongly refuse a message sent after a rename.
    if (envelope.senderId !== actor.userId || (!bound && envelope.senderName !== actor.displayName)) return errorAck('actor_mismatch');
    if (!connection.user.conversations.has(envelope.conversationId)) return errorAck('unauthorized_conversation');
    // Persisted retries keep their original timestamp, so freshness is only a legacy-mode rule; DATA
    // records the authoritative `storedAt`.
    if (!bound && Math.abs(Date.parse(envelope.timestamp) - this.#clock.nowMs()) > this.#config.timing.maxClockSkewMs) {
      return errorAck('invalid_payload');
    }
    const decision = await this.#gate.evaluate(connection, CLIENT_EVENTS.messageSend, raw,
      { conversationId: envelope.conversationId, messageId: envelope.id });
    if (decision === 'deny') return errorAck('policy_denied');
    if (decision === 'unavailable') return errorAck('unavailable');

    const store = bound ?? this.#config.messageStore;
    if (!store) return errorAck('recipient_keys_unavailable');

    const frozen = freezeEnvelope(envelope);
    if (!bound) {
      const verifier = this.#config.recipientKeyVerifier;
      if (!verifier) return errorAck('recipient_keys_unavailable');
      const verifyEnvelope = verifier.verifyEnvelope.bind(verifier);
      const verified = await callAdapter(() => verifyEnvelope(actor, frozen as Parameters<typeof verifyEnvelope>[1]), this.#config.timing.adapterTimeoutMs);
      if (!verified.ok) {
        safeLog(this.#config.logger, 'warn', 'realtime.message.verification_failed', { outcome: verified.reason });
        return errorAck('unavailable');
      }
      if (!parseKeyVerification(verified.value).verified) return errorAck('recipient_keys_unavailable');
    }
    if (connection.closed || !connection.user.conversations.has(envelope.conversationId)) return errorAck('unauthorized_conversation');

    const fingerprint = fingerprintOf(frozen);
    const key = JSON.stringify([actor.userId, frozen.conversationId, frozen.id]);
    const existing = this.#inFlight.get(key);
    if (existing) return existing.fingerprint === fingerprint ? existing.result : errorAck('idempotency_conflict');
    const result = this.#store(connection, store, frozen, fingerprint);
    this.#inFlight.set(key, { fingerprint, result });
    try {
      return await result;
    } finally {
      if (this.#inFlight.get(key)?.result === result) this.#inFlight.delete(key);
    }
  }

  clear(): void {
    this.#inFlight.clear();
  }

  async #store(sender: Connection, store: MessageStore, envelope: AnyMessageEnvelope, fingerprint: string): Promise<SendResult> {
    const request: StoreMessageRequest = Object.freeze({ envelope, fingerprint, receivedAt: new Date(this.#clock.nowMs()) });
    const storeMessage = store.storeMessage.bind(store);
    const stored = await callAdapter(() => storeMessage(request), this.#config.timing.adapterTimeoutMs);
    const outcome = stored.ok ? parseStoreOutcome(stored.value) : null;
    if (!outcome) {
      if (!stored.ok && stored.reason === 'error' && stored.code !== undefined) {
        // A definite refusal by the store's owner (not a timeout): classify it, never expose it.
        const action = classifyStoreFailure(stored.code, stored.fields);
        safeLog(this.#config.logger, 'info', 'realtime.message.refused', { code: stored.code, ack: action.ack });
        if (action.terminate) setImmediate(() => this.#hooks.onSessionInvalid(sender));
        return errorAck(action.ack);
      }
      // Ambiguous: the store may have committed. A retry with the same ID is safe because it is idempotent.
      safeLog(this.#config.logger, 'warn', 'realtime.message.store_failed', { outcome: stored.ok ? 'malformed' : stored.reason });
      return errorAck('unavailable');
    }
    if (outcome.outcome === 'conflict') return errorAck('idempotency_conflict');
    // Committed. Fan out only a CREATED message: a duplicate is not a new delivery grant.
    if (outcome.outcome === 'created') void this.#fanOut(sender, envelope).catch(() => undefined);
    return { conversationId: envelope.conversationId, messageId: envelope.id, status: 'sent', timestamp: outcome.storedAt.toISOString() };
  }

  /**
   * Post-commit fan-out. Each target is re-authorized immediately before its emit, so a block,
   * unfriend, logout or membership change committed after the room grant was cached still wins.
   */
  async #fanOut(sender: Connection, envelope: AnyMessageEnvelope): Promise<void> {
    const members = this.#membership.rooms.get(conversationRoom(envelope.conversationId));
    if (!members) return;
    const payload = { ...envelope, encryption: { ...envelope.encryption }, deliveryStatus: 'sent' as const };
    const senderId = sender.actor.userId;
    const targets: Connection[] = [];
    for (const socketId of [...members]) {
      if (socketId === sender.id) continue;
      const target = this.#registry.connection(socketId);
      if (!target || target.closed) continue;
      if (target.actor.userId !== senderId && this.#registry.isBlockedPair(senderId, target.actor.userId)) continue;
      targets.push(target);
    }
    await Promise.all(targets.map((target) => this.#deliver(target, senderId, envelope, payload)));
  }

  async #deliver(target: Connection, senderId: string, envelope: AnyMessageEnvelope, payload: object): Promise<void> {
    if (!(await mayReceive(this.#config, target, envelope.conversationId))) {
      safeLog(this.#config.logger, 'info', 'realtime.delivery.withheld', {});
      this.#hooks.onStaleAuthority(target.actor.userId);
      return;
    }
    if (target.closed || (target.actor.userId !== senderId && this.#registry.isBlockedPair(senderId, target.actor.userId))) return;
    const ownDevice = target.actor.userId === senderId;
    const { deliveryAckTimeoutMs } = this.#config.timing;
    const { maxPendingDeliveryAcksPerConnection } = this.#config.limits;
    if (ownDevice || target.pendingDeliveryAcks >= maxPendingDeliveryAcksPerConnection) {
      target.socket.emit(SERVER_EVENTS.messageNew, payload);
      return;
    }
    target.pendingDeliveryAcks += 1;
    target.socket.timeout(deliveryAckTimeoutMs).emit(SERVER_EVENTS.messageNew, payload, (error: Error | null, ...responses: unknown[]) => {
      target.pendingDeliveryAcks -= 1;
      if (error || responses.length !== 1) return;
      void this.#receipts.handleDeliveryAck(target, envelope, responses[0]);
    });
  }
}
