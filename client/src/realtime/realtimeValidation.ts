import type { DemoIncomingMessage, EncryptedIncomingMessage, OutboundMessage, TransportMode } from '@/messaging/messageModel';
import type { EncryptedMessagePayload } from '@/utils/crypto';
import { DEMO_REALTIME_MESSAGE_TEXT, RealtimeOperationError, SERVER_ACK_ERROR_CODES, SERVER_CONNECT_ERROR_CODES,
  type RealtimeErrorCode, type RealtimeEvent, type SendAcknowledgement, type ServerErrorCode } from './realtimeModel';

const delivery = new Set(['sent', 'delivered', 'read']);
const connection = new Set(['disconnected', 'connecting', 'connected', 'reconnecting', 'error']);
const presence = new Set(['online', 'offline', 'busy', 'away', 'unknown']);
const errorCodes = new Set<RealtimeErrorCode>(['unavailable', 'disconnected', 'authentication_rejected', 'ack_timeout',
  ...SERVER_ACK_ERROR_CODES, 'connection_limit', 'origin_not_allowed', 'session_ended', 'send_failed']);
const fixtureMessages = new Set<string>(Object.values(DEMO_REALTIME_MESSAGE_TEXT));

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key));
}

export function isBoundedText(value: unknown, maximum = 160): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isIdentifier(value: unknown): value is string {
  return isBoundedText(value, 256) && !/\s/u.test(value);
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]! &&
    hour! <= 23 && minute! <= 59 && second! <= 59 && Number.isFinite(Date.parse(value));
}

function canonicalBase64(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const decoded = atob(value);
    return btoa(decoded) === value ? decoded : null;
  } catch { return null; }
}

function encryptedPayload(value: unknown, outbound: boolean): EncryptedMessagePayload | null {
  if (!record(value) || !onlyKeys(value, ['version', 'algorithm', 'encoding', 'iv', 'ciphertext', ...(outbound ? ['scope'] : [])]) ||
    value.version !== 1 || value.algorithm !== 'AES-256-GCM' || value.encoding !== 'base64' ||
    (outbound && value.scope !== 'browser-demo')) return null;
  const iv = canonicalBase64(value.iv, 16);
  const ciphertext = canonicalBase64(value.ciphertext, 1_400_000);
  if (!iv || iv.length !== 12 || !ciphertext || ciphertext.length <= 16) return null;
  return { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: value.iv as string, ciphertext: value.ciphertext as string };
}

function messageHeader(value: Record<string, unknown>): boolean {
  return isIdentifier(value.id) && isIdentifier(value.conversationId) && isIdentifier(value.senderId) &&
    isBoundedText(value.senderName) && isTimestamp(value.timestamp) && value.type === 'text';
}

function incomingMessage(input: unknown, mode: TransportMode): EncryptedIncomingMessage | DemoIncomingMessage | null {
  if (!record(input) || !messageHeader(input) || !delivery.has(input.deliveryStatus as string)) return null;
  const common = { id: input.id as string, conversationId: input.conversationId as string, senderId: input.senderId as string,
    senderName: input.senderName as string, timestamp: input.timestamp as string, type: 'text' as const,
    deliveryStatus: input.deliveryStatus as 'sent' | 'delivered' | 'read' };
  if ('demoOnly' in input || 'content' in input) {
    if (mode !== 'local-demo' || !onlyKeys(input, ['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'deliveryStatus', 'demoOnly', 'content']) ||
      input.demoOnly !== true || typeof input.content !== 'string' || !fixtureMessages.has(input.content)) return null;
    return { ...common, demoOnly: true, content: input.content };
  }
  if (!onlyKeys(input, ['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'deliveryStatus', 'encryption'])) return null;
  const encryption = encryptedPayload(input.encryption, false);
  return encryption ? { ...common, encryption } : null;
}

/** Validates the existing browser-demo envelope; this does not authorize remote sending. */
export function parseOutboundMessage(input: unknown): OutboundMessage | null {
  if (!record(input) || !messageHeader(input) ||
    !onlyKeys(input, ['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'encryption'])) return null;
  const encryption = encryptedPayload(input.encryption, true);
  return encryption ? {
    id: input.id as string, conversationId: input.conversationId as string, senderId: input.senderId as string,
    senderName: input.senderName as string, timestamp: input.timestamp as string, type: 'text',
    encryption: { ...encryption, scope: 'browser-demo' },
  } : null;
}

/** Payloads are event bodies without `type`; a matching optional discriminator is accepted.
 * Message bodies may be `{ message }` or the raw incoming envelope. Unknown fields fail closed.
 */
export function parseRealtimeEvent(kind: RealtimeEvent['type'], input: unknown, mode: TransportMode): RealtimeEvent | null {
  if (!record(input)) return null;
  if (kind === 'message') {
    if ('message' in input && (!onlyKeys(input, ['type', 'message']) || ('type' in input && input.type !== 'message'))) return null;
    const message = incomingMessage('message' in input ? input.message : input, mode);
    return message ? { type: 'message', message } : null;
  }
  if ('type' in input && input.type !== kind) return null;
  switch (kind) {
    case 'connection':
      return onlyKeys(input, ['type', 'status']) && connection.has(input.status as string)
        ? { type: 'connection', status: input.status as Extract<RealtimeEvent, { type: 'connection' }>['status'] } : null;
    case 'receipt':
      return onlyKeys(input, ['type', 'conversationId', 'messageId', 'status', 'userId', 'timestamp']) &&
        isIdentifier(input.conversationId) && isIdentifier(input.messageId) && isIdentifier(input.userId) &&
        delivery.has(input.status as string) && isTimestamp(input.timestamp)
        ? { type: 'receipt', conversationId: input.conversationId, messageId: input.messageId, userId: input.userId,
          status: input.status as 'sent' | 'delivered' | 'read', timestamp: input.timestamp } : null;
    case 'typing':
      return onlyKeys(input, ['type', 'conversationId', 'userId', 'displayName', 'isTyping', 'timestamp']) &&
        isIdentifier(input.conversationId) && isIdentifier(input.userId) && isBoundedText(input.displayName) &&
        typeof input.isTyping === 'boolean' && isTimestamp(input.timestamp)
        ? { type: 'typing', conversationId: input.conversationId, userId: input.userId, displayName: input.displayName,
          isTyping: input.isTyping, timestamp: input.timestamp } : null;
    case 'presence':
      return onlyKeys(input, ['type', 'userId', 'status', 'timestamp']) && isIdentifier(input.userId) &&
        presence.has(input.status as string) && isTimestamp(input.timestamp)
        ? { type: 'presence', userId: input.userId, status: input.status as Extract<RealtimeEvent, { type: 'presence' }>['status'], timestamp: input.timestamp } : null;
    case 'conversation':
      return onlyKeys(input, ['type', 'conversationId', 'displayName', 'updatedAt']) && isIdentifier(input.conversationId) &&
        isTimestamp(input.updatedAt) && (!('displayName' in input) || isBoundedText(input.displayName))
        ? { type: 'conversation', conversationId: input.conversationId, updatedAt: input.updatedAt,
          ...(typeof input.displayName === 'string' ? { displayName: input.displayName } : {}) } : null;
    case 'error':
      return onlyKeys(input, ['type', 'code', 'serverCode', 'conversationId']) && errorCodes.has(input.code as RealtimeErrorCode) &&
        (!('serverCode' in input) || serverError(input.serverCode)?.code === input.code) &&
        (!('conversationId' in input) || isIdentifier(input.conversationId))
        ? { type: 'error', code: input.code as RealtimeErrorCode,
          ...(typeof input.serverCode === 'string' ? { serverCode: input.serverCode as ServerErrorCode } : {}),
          ...(typeof input.conversationId === 'string' ? { conversationId: input.conversationId } : {}) } : null;
  }
}

/** Only allowlisted codes survive; backend messages, details and stacks never enter UI state. */
function serverError(code: unknown): RealtimeOperationError | null {
  if (SERVER_ACK_ERROR_CODES.some((known) => known === code)) {
    return new RealtimeOperationError(code as typeof SERVER_ACK_ERROR_CODES[number], false, code as ServerErrorCode);
  }
  const normalized: Record<typeof SERVER_CONNECT_ERROR_CODES[number], RealtimeErrorCode> = {
    AUTH_REQUIRED: 'authentication_rejected', UNAUTHORIZED: 'authentication_rejected', SESSION_EXPIRED: 'authentication_rejected',
    REALTIME_UNAVAILABLE: 'unavailable', CONNECTION_LIMIT: 'connection_limit', ORIGIN_NOT_ALLOWED: 'origin_not_allowed',
    POLICY_DENIED: 'policy_denied',
  };
  return SERVER_CONNECT_ERROR_CODES.some((known) => known === code)
    ? new RealtimeOperationError(normalized[code as typeof SERVER_CONNECT_ERROR_CODES[number]], false, code as ServerErrorCode) : null;
}

export function parseErrorAcknowledgement(input: unknown): RealtimeOperationError | null {
  return record(input) && onlyKeys(input, ['status', 'code']) && input.status === 'error' &&
    SERVER_ACK_ERROR_CODES.some((code) => code === input.code) ? serverError(input.code) : null;
}

export function parseConnectionError(input: unknown): RealtimeOperationError {
  // Socket.IO supplies an Error instance, with an ordinary data object from the server.
  const data = input && typeof input === 'object' ? (input as { data?: unknown }).data : undefined;
  return record(data) && onlyKeys(data, ['code']) && SERVER_CONNECT_ERROR_CODES.some((code) => code === data.code)
    ? serverError(data.code)! : new RealtimeOperationError('unavailable');
}

export function parseSendAcknowledgement(input: unknown): SendAcknowledgement | null {
  return record(input) && onlyKeys(input, ['conversationId', 'messageId', 'status', 'timestamp']) &&
    isIdentifier(input.conversationId) && isIdentifier(input.messageId) && input.status === 'sent' && isTimestamp(input.timestamp)
    ? { conversationId: input.conversationId, messageId: input.messageId, status: 'sent', timestamp: input.timestamp } : null;
}

export function parseReadAcknowledgement(input: unknown, conversationId: string, messageId: string): boolean {
  return record(input) && onlyKeys(input, ['conversationId', 'messageId', 'status', 'timestamp', 'userId']) &&
    input.conversationId === conversationId && input.messageId === messageId && isIdentifier(input.conversationId) &&
    isIdentifier(input.messageId) && input.status === 'read' && isTimestamp(input.timestamp) &&
    (!('userId' in input) || isIdentifier(input.userId));
}
