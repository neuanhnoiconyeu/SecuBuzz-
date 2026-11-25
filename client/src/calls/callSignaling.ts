import type { CallClientEventName, CallClearedEvent, CallSnapshot } from '../../../shared/directCalls';
import { LIVEKIT_CALL_ID } from '../../../shared/livekit';
import { isBoundedText, isIdentifier, isTimestamp } from '@/realtime/realtimeValidation';
import type {RealtimeClient} from '@/realtime/realtimeModel';
export type DirectCallSignalingClient=Pick<RealtimeClient,'calls'|'mode'|'actorId'|'getStatus'|'subscribe'>;

export interface CallSignalingPort {
  getConnectionId(): string | null;
  request(event: CallClientEventName, body: unknown): Promise<unknown>;
  subscribe(listener: (event: 'state' | 'cleared', payload: unknown) => void): () => void;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const person = (value: unknown): value is { userId: string; displayName: string } => object(value) && isIdentifier(value.userId) &&
  value.userId !== 'local-user' && !/^demo[-_:]/i.test(value.userId) && isBoundedText(value.displayName);
export function parseCallSnapshot(value: unknown, actorId: string): CallSnapshot | null {
  if (!object(value) || typeof value.callId !== 'string' || !LIVEKIT_CALL_ID.test(value.callId) || !isIdentifier(value.conversationId) ||
    !person(value.caller) || !person(value.recipient) || value.caller.userId === value.recipient.userId ||
    ![value.caller.userId, value.recipient.userId].includes(actorId) || (value.kind !== 'voice' && value.kind !== 'video') ||
    !['ringing', 'accepted', 'declined', 'cancelled', 'missed', 'ended'].includes(value.status as string) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
    !isTimestamp(value.ringExpiresAt) || (value.acceptedAt !== null && !isTimestamp(value.acceptedAt)) ||
    (value.endedAt !== null && !isTimestamp(value.endedAt))) return null;
  const terminal = !['ringing', 'accepted'].includes(value.status as string);
  if (terminal ? !isTimestamp(value.endedAt) || !['declined', 'cancelled', 'unanswered', 'disconnected', 'access_revoked', 'ended', 'duration_limit', 'server_shutdown'].includes(value.reason as string)
    : value.endedAt !== null || value.reason !== null) return null;
  if (value.status === 'accepted' && !isTimestamp(value.acceptedAt) || value.status === 'ringing' && value.acceptedAt !== null) return null;
  return { ...value, caller: { ...value.caller }, recipient: { ...value.recipient } } as unknown as CallSnapshot;
}
export function parseCallCleared(value: unknown): CallClearedEvent | null {
  return object(value) && typeof value.callId === 'string' && LIVEKIT_CALL_ID.test(value.callId) && Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 1 && value.status === 'ended' && value.reason === 'access_revoked' ? value as unknown as CallClearedEvent : null;
}
export const callFailureMessage = (payload?: unknown): string => {
  const code = object(payload) ? payload.code : '';
  return code === 'call_busy' ? 'One of you is already in another call.' : code === 'recipient_unavailable' ? 'This person is unavailable for a call.'
    : code === 'call_not_allowed' || code === 'call_not_found' || code === 'policy_denied' ? 'This call is no longer available to your session.'
      : 'The call could not be confirmed. Check your connection and try again.';
};
