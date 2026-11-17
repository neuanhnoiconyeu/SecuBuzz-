
export const CALL_CLIENT_EVENTS = {
  initiate: 'call:initiate', accept: 'call:accept', decline: 'call:decline', cancel: 'call:cancel', end: 'call:end', sync: 'call:sync',
} as const;
export const CALL_CLIENT_EVENT_NAMES: ReadonlySet<string> = new Set(Object.values(CALL_CLIENT_EVENTS));
export const CALL_SERVER_EVENTS = { state: 'call:state', cleared: 'call:cleared' } as const;
export type CallClientEventName = (typeof CALL_CLIENT_EVENTS)[keyof typeof CALL_CLIENT_EVENTS];
export type CallStatus = 'ringing' | 'accepted' | 'declined' | 'cancelled' | 'missed' | 'ended';
export type CallEndReason = 'declined' | 'cancelled' | 'unanswered' | 'disconnected' | 'access_revoked' | 'ended' | 'duration_limit' | 'server_shutdown';
export interface CallParticipant { readonly userId: string; readonly displayName: string }
/** Signaling acceptance is not proof of a LiveKit/media connection. No media credentials travel here. */
export interface CallSnapshot {
  readonly callId: string;
  readonly conversationId: string;
  readonly caller: CallParticipant;
  readonly recipient: CallParticipant;
  readonly kind: 'voice' | 'video';
  readonly status: CallStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ringExpiresAt: string;
  readonly acceptedAt: string | null;
  readonly endedAt: string | null;
  readonly reason: CallEndReason | null;
}
/** Removes a known call after access changes, without revealing any new participant metadata. */
export interface CallClearedEvent {
  readonly callId: string;
  readonly revision: number;
  readonly status: 'ended';
  readonly reason: 'access_revoked';
}
export interface InitiateCallBody {
  readonly requestId: string;
  readonly conversationId: string;
  readonly recipientId: string;
  readonly kind: 'voice' | 'video';
}
export type CallErrorCode = 'invalid_payload' | 'unauthorized_conversation' | 'rate_limited' | 'unavailable' | 'message_not_found' | 'actor_mismatch' | 'idempotency_conflict' | 'recipient_keys_unavailable' | 'policy_denied' | 'call_not_found' | 'call_not_allowed' | 'call_busy' | 'invalid_call_state' | 'recipient_unavailable';
export type CallAck = { readonly status: 'ok'; readonly call: CallSnapshot } | { readonly status: 'error'; readonly code: CallErrorCode };
export type CallSyncAck = { readonly status: 'ok'; readonly calls: readonly CallSnapshot[] } | { readonly status: 'error'; readonly code: CallErrorCode };
