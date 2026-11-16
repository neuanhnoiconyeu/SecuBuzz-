import { callAdapter, type AdapterResult } from './adapterCall.ts';
import { mayReceive } from './authority.ts';
import type { ServerClock } from './clock.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import type { AnyMessageEnvelope, ReceiptRecord } from './contracts.ts';
import type { EventGate } from './eventGate.ts';
import { safeLog } from './logger.ts';
import { classifyStoreFailure, CLIENT_EVENTS, errorAck, SERVER_EVENTS, type ErrorAck, type ReadAck, type ReceiptEvent } from './protocol.ts';
import type { Connection, ConnectionRegistry } from './registry.ts';
import { isDeliveryAck, parseReceiptOutcome, parseStoredMessageRef, type ReadBody } from './validation.ts';

/**
 * Read and delivery receipt boundary. A receipt is emitted to the sender only after the
 * MessageStore durably records it for the first time; the reader's acknowledgement is separate.
 * Each connection uses its own bound store when it has one, so the observer is always that
 * connection's authenticated actor and DATA re-checks its session on every call.
 */
export class ReceiptRouter {
  readonly #config: ResolvedRealtimeConfig;
  readonly #registry: ConnectionRegistry;
  readonly #clock: ServerClock;
  readonly #gate: EventGate;
  readonly #onSessionInvalid: (connection: Connection) => void;

  constructor(config: ResolvedRealtimeConfig, registry: ConnectionRegistry, clock: ServerClock, gate: EventGate,
    onSessionInvalid: (connection: Connection) => void = () => undefined) {
    this.#config = config;
    this.#registry = registry;
    this.#clock = clock;
    this.#gate = gate;
    this.#onSessionInvalid = onSessionInvalid;
  }

  /** Maps a failed store call: a definite refusal is classified, anything else is "unavailable". */
  #failed(connection: Connection, result: Extract<AdapterResult<unknown>, { ok: false }>, operation: string): ErrorAck {
    if (result.reason === 'error' && result.code !== undefined) {
      const action = classifyStoreFailure(result.code, result.fields);
      safeLog(this.#config.logger, 'info', 'realtime.receipt.refused', { operation, code: result.code, ack: action.ack });
      if (action.terminate) setImmediate(() => this.#onSessionInvalid(connection));
      return errorAck(action.ack);
    }
    safeLog(this.#config.logger, 'warn', 'realtime.receipt.lookup_failed', { operation, outcome: result.reason });
    return errorAck('unavailable');
  }

  /** `message:read` from an authenticated reader. The reader is always the connection's actor. */
  async handleRead(connection: Connection, body: ReadBody, raw: unknown): Promise<ReadAck | ErrorAck> {
    const { conversationId, messageId } = body;
    const reader = connection.actor.userId;
    if (!connection.user.conversations.has(conversationId)) return errorAck('unauthorized_conversation');
    const decision = await this.#gate.evaluate(connection, CLIENT_EVENTS.messageRead, raw, { conversationId, messageId });
    if (decision === 'deny') return errorAck('policy_denied');
    if (decision === 'unavailable') return errorAck('unavailable');
    const store = connection.store ?? this.#config.messageStore;
    if (!store) return errorAck('unavailable');
    const timeout = this.#config.timing.adapterTimeoutMs;

    const findMessage = store.findMessage.bind(store);
    const found = await callAdapter(() => findMessage(conversationId, messageId), timeout);
    if (!found.ok) return this.#failed(connection, found, 'lookup');
    const message = parseStoredMessageRef(found.value, conversationId, messageId);
    if (message === undefined) {
      safeLog(this.#config.logger, 'warn', 'realtime.receipt.lookup_failed', { outcome: 'malformed' });
      return errorAck('unavailable');
    }
    if (message === null) return errorAck('message_not_found');
    if (message.senderId === reader) return errorAck('invalid_payload');
    // Access may have been revoked while the lookup was in flight.
    if (connection.closed || !connection.user.conversations.has(conversationId)) return errorAck('unauthorized_conversation');

    const receipt: ReceiptRecord = Object.freeze({
      conversationId, messageId, userId: reader, status: 'read', observedAt: new Date(this.#clock.nowMs()),
    });
    const recordReceipt = store.recordReceipt.bind(store);
    const recorded = await callAdapter(() => recordReceipt(receipt), timeout);
    if (!recorded.ok) return this.#failed(connection, recorded, 'record_read');
    const outcome = parseReceiptOutcome(recorded.value);
    if (!outcome) {
      safeLog(this.#config.logger, 'warn', 'realtime.receipt.record_failed', { status: 'read', outcome: 'malformed' });
      return errorAck('unavailable');
    }
    const timestamp = outcome.recordedAt.toISOString();
    if (outcome.outcome === 'created') {
      void this.#notifySender(message.senderId, reader, SERVER_EVENTS.messageRead,
        { conversationId, messageId, status: 'read', userId: reader, timestamp });
    }
    return { conversationId, messageId, status: 'read', timestamp, userId: reader };
  }

  /**
   * A recipient connection invoked the `message:new` callback. The observer is that connection's
   * actor, so the receipt actor and the message association cannot be forged.
   */
  async handleDeliveryAck(recipient: Connection, envelope: AnyMessageEnvelope, response: unknown): Promise<void> {
    if (recipient.closed) return;
    const { conversationId, id: messageId, senderId } = envelope;
    if (!isDeliveryAck(response, conversationId, messageId)) {
      this.#gate.invalid(recipient, 'delivery_ack');
      return;
    }
    const observer = recipient.actor.userId;
    const store = recipient.store ?? this.#config.messageStore;
    if (!store || observer === senderId || !recipient.user.conversations.has(conversationId)) return;
    const receipt: ReceiptRecord = Object.freeze({
      conversationId, messageId, userId: observer, status: 'delivered', observedAt: new Date(this.#clock.nowMs()),
    });
    const recordReceipt = store.recordReceipt.bind(store);
    const recorded = await callAdapter(() => recordReceipt(receipt), this.#config.timing.adapterTimeoutMs);
    if (!recorded.ok) {
      this.#failed(recipient, recorded, 'record_delivered');
      return;
    }
    const outcome = parseReceiptOutcome(recorded.value);
    if (!outcome) {
      safeLog(this.#config.logger, 'warn', 'realtime.receipt.record_failed', { status: 'delivered', outcome: 'malformed' });
      return;
    }
    if (outcome.outcome !== 'created' || recipient.closed || !recipient.user.conversations.has(conversationId)) return;
    await this.#notifySender(senderId, observer, SERVER_EVENTS.messageDelivered,
      { conversationId, messageId, status: 'delivered', userId: observer, timestamp: outcome.recordedAt.toISOString() });
  }

  /** Sends a receipt to the sender's connections that still hold, and currently pass, the conversation authority. */
  async #notifySender(senderId: string, observerId: string, event: string, payload: ReceiptEvent): Promise<void> {
    const sender = this.#registry.user(senderId);
    if (!sender || !sender.conversations.has(payload.conversationId) || this.#registry.isBlockedPair(senderId, observerId)) return;
    await Promise.all([...sender.connections].map(async (connection) => {
      if (connection.closed || !(await mayReceive(this.#config, connection, payload.conversationId))) return;
      if (this.#registry.isBlockedPair(senderId, observerId)) return;
      connection.socket.emit(event, payload);
    }));
  }
}
