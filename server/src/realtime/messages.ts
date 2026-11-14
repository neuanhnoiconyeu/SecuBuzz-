import { callAdapter } from './adapterCall.ts';
import type { ServerClock } from './clock.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import type { MessageEnvelope, StoreMessageRequest } from './contracts.ts';
import type { EventGate } from './eventGate.ts';
import { safeLog } from './logger.ts';
import { CLIENT_EVENTS, errorAck, SERVER_EVENTS, type ErrorAck, type SendAck } from './protocol.ts';
import type { ReceiptRouter } from './receipts.ts';
import type { Connection, ConnectionRegistry } from './registry.ts';
import { conversationRoom } from './rooms.ts';
import { envelopeFingerprint, parseKeyVerification, parseStoreOutcome } from './validation.ts';

/** The part of a namespace adapter needed for per-recipient fan-out. */
export interface RoomMembership {
  readonly rooms: Map<string, Set<string>>;
}

export type SendResult = SendAck | ErrorAck;

interface InFlightSend {
  readonly fingerprint: string;
  readonly result: Promise<SendResult>;
}

function freezeEnvelope(envelope: MessageEnvelope): MessageEnvelope {
  return Object.freeze({ ...envelope, encryption: Object.freeze({ ...envelope.encryption }) });
}

/**
 * The `message:send` boundary. Without both a MessageStore and a RecipientKeyVerifier (the
 * production state in Phase 8.7B) every valid send ends in `recipient_keys_unavailable` and nothing
 * is persisted or broadcast. When both exist, a message is emitted only after durable storage.
 */
export class MessageRouter {
  readonly #inFlight = new Map<string, InFlightSend>();
  readonly #config: ResolvedRealtimeConfig;
  readonly #registry: ConnectionRegistry;
  readonly #clock: ServerClock;
  readonly #gate: EventGate;
  readonly #receipts: ReceiptRouter;
  readonly #membership: RoomMembership;

  constructor(
    config: ResolvedRealtimeConfig,
    registry: ConnectionRegistry,
    clock: ServerClock,
    gate: EventGate,
    receipts: ReceiptRouter,
    membership: RoomMembership,
  ) {
    this.#config = config;
    this.#registry = registry;
    this.#clock = clock;
    this.#gate = gate;
    this.#receipts = receipts;
    this.#membership = membership;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  get deliveryEnabled(): boolean {
    return Boolean(this.#config.messageStore && this.#config.recipientKeyVerifier);
  }

  /** `envelope` is already strictly parsed; this enforces identity, access, capability and idempotency. */
  async handleSend(connection: Connection, envelope: MessageEnvelope, raw: unknown): Promise<SendResult> {
    const actor = connection.actor;
    if (envelope.senderId !== actor.userId || envelope.senderName !== actor.displayName) return errorAck('actor_mismatch');
    if (!connection.user.conversations.has(envelope.conversationId)) return errorAck('unauthorized_conversation');
    if (Math.abs(Date.parse(envelope.timestamp) - this.#clock.nowMs()) > this.#config.timing.maxClockSkewMs) {
      return errorAck('invalid_payload');
    }
    const decision = await this.#gate.evaluate(connection, CLIENT_EVENTS.messageSend, raw,
      { conversationId: envelope.conversationId, messageId: envelope.id });
    if (decision === 'deny') return errorAck('policy_denied');
    if (decision === 'unavailable') return errorAck('unavailable');

    const store = this.#config.messageStore;
    const verifier = this.#config.recipientKeyVerifier;
    if (!store || !verifier) return errorAck('recipient_keys_unavailable');

    const frozen = freezeEnvelope(envelope);
    const verifyEnvelope = verifier.verifyEnvelope.bind(verifier);
    const verified = await callAdapter(() => verifyEnvelope(actor, frozen), this.#config.timing.adapterTimeoutMs);
    if (!verified.ok) {
      safeLog(this.#config.logger, 'warn', 'realtime.message.verification_failed', { outcome: verified.reason });
      return errorAck('unavailable');
    }
    if (!parseKeyVerification(verified.value).verified) return errorAck('recipient_keys_unavailable');
    if (connection.closed || !connection.user.conversations.has(envelope.conversationId)) return errorAck('unauthorized_conversation');

    const fingerprint = envelopeFingerprint(frozen);
    const key = JSON.stringify([actor.userId, frozen.conversationId, frozen.id]);
    const existing = this.#inFlight.get(key);
    if (existing) return existing.fingerprint === fingerprint ? existing.result : errorAck('idempotency_conflict');
    const result = this.#store(connection, frozen, fingerprint);
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

  async #store(sender: Connection, envelope: MessageEnvelope, fingerprint: string): Promise<SendResult> {
    const store = this.#config.messageStore;
    if (!store) return errorAck('recipient_keys_unavailable');
    const request: StoreMessageRequest = Object.freeze({ envelope, fingerprint, receivedAt: new Date(this.#clock.nowMs()) });
    const storeMessage = store.storeMessage.bind(store);
    const stored = await callAdapter(() => storeMessage(request), this.#config.timing.adapterTimeoutMs);
    const outcome = stored.ok ? parseStoreOutcome(stored.value) : null;
    if (!outcome) {
      // Ambiguous: the store may have committed. A retry with the same ID is safe because it is idempotent.
      safeLog(this.#config.logger, 'warn', 'realtime.message.store_failed', { outcome: stored.ok ? 'malformed' : stored.reason });
      return errorAck('unavailable');
    }
    if (outcome.outcome === 'conflict') return errorAck('idempotency_conflict');
    if (outcome.outcome === 'created') this.#fanOut(sender, envelope);
    return { conversationId: envelope.conversationId, messageId: envelope.id, status: 'sent', timestamp: outcome.storedAt.toISOString() };
  }

  /** Durable-first fan-out to current room members, with a delivery callback per recipient connection. */
  #fanOut(sender: Connection, envelope: MessageEnvelope): void {
    const members = this.#membership.rooms.get(conversationRoom(envelope.conversationId));
    if (!members) return;
    const payload = { ...envelope, encryption: { ...envelope.encryption }, deliveryStatus: 'sent' as const };
    const senderId = sender.actor.userId;
    const { deliveryAckTimeoutMs } = this.#config.timing;
    const { maxPendingDeliveryAcksPerConnection } = this.#config.limits;
    for (const socketId of [...members]) {
      if (socketId === sender.id) continue;
      const target = this.#registry.connection(socketId);
      if (!target || target.closed) continue;
      const ownDevice = target.actor.userId === senderId;
      if (!ownDevice && this.#registry.isBlockedPair(senderId, target.actor.userId)) continue;
      if (ownDevice || target.pendingDeliveryAcks >= maxPendingDeliveryAcksPerConnection) {
        target.socket.emit(SERVER_EVENTS.messageNew, payload);
        continue;
      }
      target.pendingDeliveryAcks += 1;
      target.socket.timeout(deliveryAckTimeoutMs).emit(SERVER_EVENTS.messageNew, payload, (error: Error | null, ...responses: unknown[]) => {
        target.pendingDeliveryAcks -= 1;
        if (error || responses.length !== 1) return;
        void this.#receipts.handleDeliveryAck(target, envelope, responses[0]);
      });
    }
  }
}
