import { callAdapter } from './adapterCall.ts';
import type { ResolvedRealtimeConfig } from './config.ts';
import type { EventSecurityContext } from './contracts.ts';
import { safeLog } from './logger.ts';
import type { AckCallback, ClientEventName } from './protocol.ts';
import type { Connection } from './registry.ts';
import { parseSecurityDecision } from './validation.ts';

export type RateCategory = 'typing' | 'read' | 'send' | 'presence';
export type GateDecision = 'allow' | 'deny' | 'unavailable';

export interface EventArguments {
  readonly body: unknown;
  readonly ack: AckCallback | null;
}

export interface EventMetadata {
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly subjectCount?: number;
}

function payloadBytes(body: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/** Shared admission checks for every client event: shape, rate limits, invalid budget and policy. */
export class EventGate {
  readonly #config: ResolvedRealtimeConfig;
  readonly #terminate: (connection: Connection, reason: string) => void;

  constructor(config: ResolvedRealtimeConfig, terminate: (connection: Connection, reason: string) => void) {
    this.#config = config;
    this.#terminate = terminate;
  }

  /** Exactly one body, plus a trailing callback when `ack` is `required` (and none when `forbidden`). */
  split(connection: Connection, args: readonly unknown[], ack: 'required' | 'forbidden'): EventArguments | null {
    const last = args.length > 0 ? args[args.length - 1] : undefined;
    const callback = typeof last === 'function' ? (last as AckCallback) : null;
    const bodies = callback ? args.slice(0, -1) : args;
    if (bodies.length !== 1 || (ack === 'required' && !callback) || (ack === 'forbidden' && callback)) {
      this.invalid(connection, 'arguments');
      return null;
    }
    return { body: bodies[0], ack: callback };
  }

  admit(connection: Connection, category: RateCategory): boolean {
    if (connection.closed) return false;
    return connection.buckets.events.take() && connection.buckets[category].take();
  }

  /** Charges the invalid-event budget; an exhausted budget disconnects the socket. */
  invalid(connection: Connection, reason: string): void {
    if (connection.closed || connection.buckets.invalid.take()) return;
    safeLog(this.#config.logger, 'warn', 'realtime.connection.invalid_budget_exhausted', { reason, userId: connection.actor.userId });
    this.#terminate(connection, 'invalid_events');
  }

  /** Evaluates the optional security policy. Throws and timeouts fail closed as `unavailable`. */
  async evaluate(connection: Connection, event: ClientEventName, body: unknown, metadata: EventMetadata = {}): Promise<GateDecision> {
    const policy = this.#config.securityPolicy;
    if (!policy?.evaluateEvent) return 'allow';
    const context: EventSecurityContext = Object.freeze({
      actor: connection.actor,
      event,
      conversationId: metadata.conversationId ?? null,
      messageId: metadata.messageId ?? null,
      subjectCount: metadata.subjectCount ?? null,
      payloadBytes: payloadBytes(body),
    });
    const evaluateEvent = policy.evaluateEvent.bind(policy);
    const result = await callAdapter(() => evaluateEvent(context), this.#config.timing.adapterTimeoutMs);
    if (!result.ok) {
      safeLog(this.#config.logger, 'warn', 'realtime.policy.event_failed', { event, outcome: result.reason });
      return 'unavailable';
    }
    const decision = parseSecurityDecision(result.value);
    if (decision.action === 'deny') {
      safeLog(this.#config.logger, 'info', 'realtime.policy.event_denied', { event, reason: decision.reason });
      return 'deny';
    }
    return 'allow';
  }
}

/** Wraps an acknowledgement callback so it is called at most once and never throws into the server. */
export function onceAck(callback: AckCallback): AckCallback {
  let called = false;
  return (response: unknown) => {
    if (called) return;
    called = true;
    try {
      callback(response);
    } catch {
      /* A broken callback cannot affect other connections. */
    }
  };
}
