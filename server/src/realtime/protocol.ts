/**
 * Wire protocol for the SecuBuzz realtime server.
 *
 * Event names are the canonical Phase 8.7A names (`docs/realtime-client-contract.md`,
 * `client/src/realtime/realtimeModel.ts` PROPOSED_EVENT_NAMES). They are defined once here;
 * handlers and emitters must import these constants instead of repeating string literals.
 */

import type { CallClientEventName } from '../calls/protocol.ts';

export const CLIENT_EVENTS = {
  messageSend: 'message:send',
  messageRead: 'message:read',
  typingStart: 'typing:start',
  typingStop: 'typing:stop',
  presenceSubscribe: 'presence:subscribe',
} as const;

export const SERVER_EVENTS = {
  messageNew: 'message:new',
  /** Post-commit hint only. Clients confirm the tombstone through authorized history. */
  messageDeleted: 'message:deleted',
  messageEdited: 'message:edited',
  /** Pin metadata changed; recipients fetch an authorized snapshot. */
  pinsChanged: 'conversation:pins-changed',
  reactionsChanged: 'message:reactions-changed',
  /**
   * Reserved by the client contract and never emitted. Send acknowledgements are returned through
   * the Socket.IO callback of `message:send`, which binds them to the exact request.
   */
  messageAck: 'message:ack',
  messageDelivered: 'message:delivered',
  messageRead: 'message:read',
  typingUpdate: 'typing:update',
  presenceUpdate: 'presence:update',
  conversationUpdated: 'conversation:updated',
  /**
   * A hint that a conversation's key state may have changed. Never proof: the client must fetch and
   * verify the key directory. Payload `{ conversationId, currentEpoch }` (see {@link KeysChangedEvent}).
   */
  conversationKeysChanged: 'conversation:keys-changed',
} as const;

export type ClientEventName = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS] | CallClientEventName | 'call:media';
export type ServerEventName = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

export const CLIENT_EVENT_NAMES: ReadonlySet<string> = new Set<string>(Object.values(CLIENT_EVENTS));

/** `connect_error.data.code` values. The first three are the client's authentication rejections. */
export const CONNECT_ERROR_CODES = [
  'AUTH_REQUIRED',
  'UNAUTHORIZED',
  'SESSION_EXPIRED',
  'REALTIME_UNAVAILABLE',
  'CONNECTION_LIMIT',
  'ORIGIN_NOT_ALLOWED',
  'POLICY_DENIED',
] as const;
export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number];

/** Fixed, generic messages. They never contain session, account or internal error details. */
const CONNECT_ERROR_MESSAGES: Readonly<Record<ConnectErrorCode, string>> = {
  AUTH_REQUIRED: 'Authentication required.',
  UNAUTHORIZED: 'Authentication failed.',
  SESSION_EXPIRED: 'Session expired.',
  REALTIME_UNAVAILABLE: 'Realtime service unavailable.',
  CONNECTION_LIMIT: 'Connection limit reached.',
  ORIGIN_NOT_ALLOWED: 'Origin not allowed.',
  POLICY_DENIED: 'Connection denied.',
};

export interface RealtimeConnectError extends Error {
  readonly data: { readonly code: ConnectErrorCode };
}

/** Builds the error passed to Socket.IO middleware `next()`. Socket.IO sends only `message` and `data`. */
export function connectError(code: ConnectErrorCode): RealtimeConnectError {
  const error = new Error(CONNECT_ERROR_MESSAGES[code]) as Error & { data: { code: ConnectErrorCode } };
  error.name = 'RealtimeConnectError';
  error.data = { code };
  return error;
}

/** Error codes returned in `{ status: 'error', code }` acknowledgements. */
export const ACK_ERROR_CODES = [
  'invalid_payload',
  'unauthorized_conversation',
  'rate_limited',
  'unavailable',
  'message_not_found',
  'actor_mismatch',
  'idempotency_conflict',
  'recipient_keys_unavailable',
  'policy_denied',
] as const;
export type AckErrorCode = (typeof ACK_ERROR_CODES)[number];

export interface ErrorAck {
  readonly status: 'error';
  readonly code: AckErrorCode;
}

export function errorAck(code: AckErrorCode): ErrorAck {
  return { status: 'error', code };
}

/** Read-request callback body (client contract "Read-request callback"). */
export interface ReadAck {
  readonly conversationId: string;
  readonly messageId: string;
  readonly status: 'read';
  readonly timestamp: string;
  readonly userId: string;
}

/** Accepted-send callback body (client contract "Accepted-send promise acknowledgement"). */
export interface SendAck {
  readonly conversationId: string;
  readonly messageId: string;
  readonly status: 'sent';
  readonly timestamp: string;
}

/** `message:delivered` and server-to-client `message:read` body. `userId` is the observing peer. */
export interface ReceiptEvent {
  readonly conversationId: string;
  readonly messageId: string;
  readonly status: 'delivered' | 'read';
  readonly userId: string;
  readonly timestamp: string;
}

export interface TypingUpdateEvent {
  readonly conversationId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly isTyping: boolean;
  readonly timestamp: string;
}

export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline' | 'unknown';

export interface PresenceUpdateEvent {
  readonly userId: string;
  readonly status: PresenceStatus;
  readonly timestamp: string;
}

export interface ConversationUpdatedEvent {
  readonly conversationId: string;
  readonly displayName?: string;
  readonly updatedAt: string;
}

/** `conversation:keys-changed`. Exactly these two fields; no keys, wraps, signatures or timestamps. */
export interface KeysChangedEvent {
  readonly conversationId: string;
  readonly currentEpoch: { readonly keyId: string; readonly epoch: number } | null;
}

/**
 * What to do with a failure reported by a bound DATA store. Only an allowlisted `code` token is
 * ever inspected (see `adapterCall.ts`); messages and details never leave the adapter.
 *
 * | DATA code                                  | Ack code                     | Retry the same envelope?        |
 * | ------------------------------------------ | ---------------------------- | ------------------------------- |
 * | VALIDATION_ERROR, PAYLOAD_TOO_LARGE        | invalid_payload              | no                              |
 * | FORBIDDEN (senderId/senderName fields)     | actor_mismatch               | no                              |
 * | FORBIDDEN, NOT_FOUND                       | unauthorized_conversation    | no                              |
 * | RECIPIENT_KEYS_UNVERIFIED                  | recipient_keys_unavailable   | no: refresh keys, re-encrypt    |
 * | RATE_LIMITED                               | rate_limited                 | later                           |
 * | CSRF_INVALID, UNAUTHENTICATED, SESSION_*   | policy_denied + disconnect   | no: re-authenticate             |
 * | RECIPIENT_KEYS_UNAVAILABLE, SERVICE_*, any other or timeout | unavailable | yes: infrastructure           |
 */
export type StoreFailureAction =
  | { readonly ack: AckErrorCode; readonly terminate: false }
  | { readonly ack: 'policy_denied'; readonly terminate: true };

export function classifyStoreFailure(code: string | undefined, fields: readonly string[] = []): StoreFailureAction {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'PAYLOAD_TOO_LARGE':
      return { ack: 'invalid_payload', terminate: false };
    case 'FORBIDDEN':
      return { ack: fields.some((field) => field === 'senderId' || field === 'senderName') ? 'actor_mismatch' : 'unauthorized_conversation', terminate: false };
    case 'NOT_FOUND':
      return { ack: 'unauthorized_conversation', terminate: false };
    case 'RECIPIENT_KEYS_UNVERIFIED':
      return { ack: 'recipient_keys_unavailable', terminate: false };
    case 'RATE_LIMITED':
      return { ack: 'rate_limited', terminate: false };
    case 'CSRF_INVALID':
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
      return { ack: 'policy_denied', terminate: true };
    default:
      return { ack: 'unavailable', terminate: false };
  }
}

export type AckCallback = (response: unknown) => void;
