import { decode, exact, identifier, parseEnvelope, timestamp } from '@/security/e2ee/protocol';
import type { EnvelopeV2 } from '@/security/e2ee/model';
import type { PersistenceAck } from '@/security/e2ee/session';

export const ACK_CODES = ['invalid_payload', 'unauthorized_conversation', 'rate_limited', 'unavailable',
  'message_not_found', 'actor_mismatch', 'idempotency_conflict', 'recipient_keys_unavailable', 'policy_denied'] as const;
export type SocketFailureCode = typeof ACK_CODES[number];
const failures: Record<SocketFailureCode, string> = {
  invalid_payload: 'Permanently rejected: the encrypted payload was invalid.',
  unauthorized_conversation: 'Conversation access changed. Refresh your conversations.',
  rate_limited: 'Retryable: wait before retrying the same encrypted message.',
  unavailable: 'Retryable: persistence is unconfirmed. Reconcile the same encrypted message.',
  message_not_found: 'The message is no longer available.',
  actor_mismatch: 'Permanently rejected: the message does not match this session.',
  idempotency_conflict: 'Permanently rejected: this message ID has conflicting content. Check history.',
  recipient_keys_unavailable: 'Recipient keys changed or are unavailable. Verify keys and reconcile history before retrying.',
  policy_denied: 'Your session security check failed. Sign in again.',
};
export class SocketFailure extends Error {
  readonly retryable: boolean;
  readonly permanent: boolean;
  constructor(readonly code: SocketFailureCode) {
    super(failures[code]); this.name = 'SocketFailure'; this.retryable = code === 'unavailable' || code === 'rate_limited';
    this.permanent = ['invalid_payload', 'actor_mismatch', 'idempotency_conflict'].includes(code);
  }
}
export interface Receipt { conversationId: string; messageId: string; userId: string; status: 'delivered' | 'read'; timestamp: string }
export interface TypingUpdate { conversationId: string; userId: string; displayName: string; isTyping: boolean; timestamp: string }
export interface PresenceUpdate { userId: string; status: 'online' | 'away' | 'busy' | 'offline' | 'unknown'; timestamp: string }
export interface KeysChanged { conversationId: string; currentEpoch: { keyId: string; epoch: number } | null }

export function errorAck(input: unknown): void {
  if (input && typeof input === 'object' && 'status' in input && input.status === 'error') {
    const r = exact(input, ['status', 'code']);
    if (!ACK_CODES.includes(r.code as SocketFailureCode)) throw new SocketFailure('unavailable');
    throw new SocketFailure(r.code as SocketFailureCode);
  }
}
export function persistenceAck(input: unknown, sent: EnvelopeV2): PersistenceAck {
  errorAck(input); const r = exact(input, ['conversationId', 'messageId', 'status', 'timestamp']);
  if (r.conversationId !== sent.conversationId || r.messageId !== sent.id || r.status !== 'sent') throw new SocketFailure('unavailable');
  timestamp(r.timestamp); return r as unknown as PersistenceAck;
}
export function incomingEnvelope(input: unknown): EnvelopeV2 {
  const r = exact(input, ['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'encryption', 'deliveryStatus']);
  if (r.deliveryStatus !== 'sent') throw new Error('Invalid event');
  const { deliveryStatus: _status, ...envelope } = r; return parseEnvelope(envelope);
}
export function receipt(input: unknown, status: Receipt['status']): Receipt {
  const r = exact(input, ['conversationId', 'messageId', 'userId', 'status', 'timestamp']);
  identifier(r.conversationId); identifier(r.messageId); identifier(r.userId); timestamp(r.timestamp);
  if (r.status !== status) throw new Error('Invalid receipt'); return r as unknown as Receipt;
}
export function typingUpdate(input: unknown): TypingUpdate {
  const r = exact(input, ['conversationId', 'userId', 'displayName', 'isTyping', 'timestamp']);
  identifier(r.conversationId); identifier(r.userId); timestamp(r.timestamp);
  if (typeof r.isTyping !== 'boolean' || typeof r.displayName !== 'string' || !r.displayName.trim() || r.displayName.length > 160 || /[\u0000-\u001f\u007f-\u009f]/u.test(r.displayName)) throw new Error('Invalid typing');
  return r as unknown as TypingUpdate;
}
export function presenceUpdate(input: unknown): PresenceUpdate {
  const r = exact(input, ['userId', 'status', 'timestamp']); identifier(r.userId); timestamp(r.timestamp);
  if (!['online', 'away', 'busy', 'offline', 'unknown'].includes(r.status as string)) throw new Error('Invalid presence');
  return r as unknown as PresenceUpdate;
}
export function keysChanged(input: unknown): KeysChanged {
  const r = exact(input, ['conversationId', 'currentEpoch']); identifier(r.conversationId);
  if (r.currentEpoch !== null) { const e = exact(r.currentEpoch, ['keyId', 'epoch']); decode(e.keyId, 16);
    if (!Number.isSafeInteger(e.epoch) || (e.epoch as number) < 1 || (e.epoch as number) > 1e9) throw new Error('Invalid epoch'); }
  return r as unknown as KeysChanged;
}
