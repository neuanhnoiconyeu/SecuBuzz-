import type { RealtimeActor } from '../realtime/contracts.ts';
import type { CallParticipant, CallSnapshot } from './protocol.ts';

export interface DirectCallMediaLifecycle {
  prepare(callId: string): Promise<void>;
  finish(callId: string): Promise<void>;
}
export interface DirectCallMediaGrant {
  readonly call: CallSnapshot;
  current(): boolean;
}
export type DirectCallMediaAuthorization = DirectCallMediaGrant | { readonly status: 'media_in_use' | 'media_unavailable' } | null;

/** Read-only host integration. A group membership or presence grant does not authorize a direct call. */
export interface DirectCallConversationResolver {
  /**
   * Return only an actual one-to-one conversation containing the actor and eligible for calls
   * under the host's current relationship policy. Null denies access. Never use client metadata.
   */
  resolveDirectConversation(actor: RealtimeActor, conversationId: string): Promise<{
    readonly conversationId: string;
    readonly type: 'direct';
    readonly participants: readonly [CallParticipant, CallParticipant];
  } | null>;
}
export interface DirectCallOptions {
  readonly media?: DirectCallMediaLifecycle;
  readonly conversationResolver: DirectCallConversationResolver;
  readonly ringTimeoutMs?: number;
  /** Safety bound for an accepted signaling session, independent of media readiness. */
  readonly maxAcceptedMs?: number;
  readonly terminalTtlMs?: number;
  /** Active plus retained terminal records. Full capacity rejects new calls without eviction. */
  readonly maxCalls?: number;
}
export interface ResolvedDirectCallOptions {
  readonly media: DirectCallMediaLifecycle | null;
  readonly conversationResolver: DirectCallConversationResolver;
  readonly ringTimeoutMs: number;
  readonly maxAcceptedMs: number;
  readonly terminalTtlMs: number;
  readonly maxCalls: number;
}
export function resolveDirectCallOptions(options: DirectCallOptions | undefined): ResolvedDirectCallOptions | null {
  if (options === undefined) return null;
  if (!options || typeof options.conversationResolver?.resolveDirectConversation !== 'function') throw new TypeError('Direct calls require a conversation resolver.');
  if (options.media && (typeof options.media.prepare !== 'function' || typeof options.media.finish !== 'function')) throw new TypeError('Invalid direct call media lifecycle.');
  const number = (key: 'ringTimeoutMs' | 'maxAcceptedMs' | 'terminalTtlMs' | 'maxCalls', fallback: number, min: number, max: number) => {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid directCalls.${key}.`);
    return value;
  };
  return Object.freeze({ conversationResolver: options.conversationResolver, media: options.media ?? null,
    ringTimeoutMs: number('ringTimeoutMs', 30_000, 50, 120_000),
    maxAcceptedMs: number('maxAcceptedMs', 14_400_000, 50, 86_400_000),
    terminalTtlMs: number('terminalTtlMs', 300_000, 50, 3_600_000),
    maxCalls: number('maxCalls', 10_000, 1, 100_000) });
}
