/**
 * The genuine RecipientKeyVerifier. It implements both existing seams:
 *
 * - DB-4B shared write service: `verifyEnvelope(actor, envelope, {conversationId, recipientIds, fingerprint})`
 *   (`DATA/server/messaging/service.js`, injected through `createApp({messageOptions})`).
 * - Realtime server: `verifyEnvelope(actor, envelope)` (`server/src/realtime/contracts.ts`).
 *
 * The decision comes only from the DATA-owned key directory. Directory failures throw, which both
 * callers turn into "unavailable" (DATA: 503 RECIPIENT_KEYS_UNAVAILABLE). There is no default,
 * no fallback and no environment switch.
 */
import { callAdapter } from '../realtime/adapterCall.ts';
import type { KeyVerification, RealtimeLogger } from '../realtime/contracts.ts';
import { safeLog, silentLogger } from '../realtime/logger.ts';
import { hasOnlyKeys, isIdentifier, isPlainObject } from '../realtime/validation.ts';
import { parseMessageEnvelopeV2 } from './envelope.ts';
import { evaluateRecipientKeys, type RecipientKeyContext } from './evaluation.ts';
import { E2EE_LIMITS } from './protocol.ts';
import { parseConversationKeyState } from './records.ts';
import { isAccountId } from './registration.ts';

/**
 * DATA-owned adapter. `loadConversationKeyState` must read, in ONE read transaction, the current
 * DB-4A participants, the active device keys of those participants, the latest epoch and the
 * epoch with `keyId` in this conversation, and return a `ConversationKeyState`-shaped object
 * (`records.ts`). Return `null` for an unknown conversation. It may be async and may throw.
 */
export interface RecipientKeyDirectory {
  /** Test doubles set this; production refuses them. */
  readonly testOnly?: boolean;
  loadConversationKeyState(request: { readonly conversationId: string; readonly keyId: string }): unknown;
}

export interface RecipientKeyVerifierOptions {
  readonly directory: RecipientKeyDirectory;
  readonly logger?: RealtimeLogger;
  /** Deadline for one directory read. Default 1,500 ms: below DATA's 2 s and the realtime 4 s deadlines. */
  readonly timeoutMs?: number;
  /** Concurrent verifications per instance. Default 64. */
  readonly maxPending?: number;
}

export interface RecipientKeyVerifierHandle {
  verifyEnvelope(actor: unknown, envelope: unknown, context?: unknown): Promise<KeyVerification>;
}

export class RecipientKeyServiceUnavailableError extends Error {
  override name = 'RecipientKeyServiceUnavailableError';
  constructor() {
    super('Recipient key verification is unavailable.');
  }
}

const FINGERPRINT = /^[a-f0-9]{64}$/;

function bounded(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

/** DATA's optional third argument, validated. `undefined` means absent; `null` means malformed. */
function parseCallerContext(input: unknown, conversationId: string): Pick<RecipientKeyContext, 'recipientIds' | 'fingerprint'> | null | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input) || !hasOnlyKeys(input, ['conversationId', 'recipientIds', 'fingerprint']) || input.conversationId !== conversationId) return null;
  const result: { recipientIds?: readonly string[]; fingerprint?: string } = {};
  if (input.recipientIds !== undefined) {
    if (!Array.isArray(input.recipientIds) || input.recipientIds.length === 0 || input.recipientIds.length >= E2EE_LIMITS.participants * 2 ||
      !(input.recipientIds as unknown[]).every(isIdentifier)) return null;
    result.recipientIds = Object.freeze([...(input.recipientIds as string[])]);
  }
  if (input.fingerprint !== undefined) {
    if (typeof input.fingerprint !== 'string' || !FINGERPRINT.test(input.fingerprint)) return null;
    result.fingerprint = input.fingerprint;
  }
  return result;
}

export function createRecipientKeyVerifier(options: RecipientKeyVerifierOptions): RecipientKeyVerifierHandle {
  if (options === null || typeof options !== 'object') throw new TypeError('Recipient key verifier options are required.');
  const { directory } = options;
  if (directory === null || typeof directory !== 'object' || typeof directory.loadConversationKeyState !== 'function') {
    throw new TypeError('A RecipientKeyDirectory with loadConversationKeyState is required; there is no default.');
  }
  if (directory.testOnly === true && process.env.NODE_ENV === 'production') {
    throw new TypeError('A test-only key directory cannot be used in production.');
  }
  const logger = options.logger ?? silentLogger;
  if (typeof logger.log !== 'function') throw new TypeError('logger.log must be a function.');
  const timeoutMs = bounded('timeoutMs', options.timeoutMs ?? 1_500, 10, 10_000);
  const maxPending = bounded('maxPending', options.maxPending ?? 64, 1, 10_000);
  const load = directory.loadConversationKeyState.bind(directory);
  let pending = 0;

  const deny = (reason: string): KeyVerification => {
    safeLog(logger, 'info', 'e2ee.verification.refused', { reason });
    return { verified: false };
  };
  const unavailable = (reason: string): never => {
    safeLog(logger, 'warn', 'e2ee.verification.unavailable', { reason });
    throw new RecipientKeyServiceUnavailableError();
  };

  return Object.freeze({
    async verifyEnvelope(actor: unknown, envelope: unknown, context?: unknown): Promise<KeyVerification> {
      if (!isPlainObject(actor) || !isAccountId(actor.userId)) return deny('actor_invalid');
      const parsed = parseMessageEnvelopeV2(envelope);
      if (!parsed) return deny('envelope_unsupported');
      const caller = parseCallerContext(context, parsed.conversationId);
      if (caller === null) return deny('context_invalid');
      if (pending >= maxPending) return unavailable('capacity');
      pending += 1;
      try {
        const request = Object.freeze({ conversationId: parsed.conversationId, keyId: parsed.encryption.keyId });
        const loaded = await callAdapter(() => load(request), timeoutMs);
        if (!loaded.ok) return unavailable(`directory_${loaded.reason}`);
        if (loaded.value === null) return deny('unknown_conversation');
        const state = parseConversationKeyState(loaded.value, request);
        if (!state) return unavailable('directory_malformed');
        const check = evaluateRecipientKeys(parsed, { actorUserId: actor.userId, conversationId: parsed.conversationId, ...caller }, state);
        return check.verified ? { verified: true } : deny(check.reason);
      } finally {
        pending -= 1;
      }
    },
  });
}
