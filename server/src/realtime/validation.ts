/**
 * Strict validation for client event bodies and adapter results.
 *
 * Rules mirror the Phase 8.7A client parsers (`client/src/realtime/realtimeValidation.ts`):
 * plain objects only, unknown fields fail closed, identifiers are 1–256 characters without
 * whitespace or control characters, timestamps are ISO-8601 with an explicit timezone.
 * The server is slightly stricter: it also rejects unpaired UTF-16 surrogates.
 */
import { createHash } from 'node:crypto';
import type {
  AuthenticatedSession,
  KeyVerification,
  MessageEnvelope,
  ReceiptOutcome,
  SecurityDecision,
  SessionCheck,
  SessionResolution,
  StoreMessageOutcome,
  StoredMessageRef,
} from './contracts.ts';

export const MAX_IDENTIFIER_LENGTH = 256;
export const MAX_DISPLAY_NAME_LENGTH = 160;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const WHITESPACE = /\s/u;
const LONE_SURROGATE = /\p{Cs}/u;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DEMO_IDENTITY = /^demo[-_:]/i;
const AUDIT_REASON = /^[A-Za-z0-9._:-]{1,64}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True when every own key (including symbols) is in `keys`. Required keys are checked by callers. */
export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key));
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim().length > 0 &&
    !CONTROL_CHARACTERS.test(value) && !LONE_SURROGATE.test(value);
}

export function isIdentifier(value: unknown): value is string {
  return isBoundedText(value, MAX_IDENTIFIER_LENGTH) && !WHITESPACE.test(value);
}

export function isDisplayName(value: unknown): value is string {
  return isBoundedText(value, MAX_DISPLAY_NAME_LENGTH);
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = ISO_TIMESTAMP.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) &&
    hour <= 23 && minute <= 59 && second <= 59 && Number.isFinite(Date.parse(value));
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Reserved client demo identities (`client/src/auth/INTEGRATION.md`). Never valid for production sessions. */
export function isDemoIdentity(userId: string): boolean {
  return userId.toLowerCase() === 'local-user' || DEMO_IDENTITY.test(userId);
}

/** Decoded byte length of canonical, padded base64, or `null` when the value is not canonical. */
export function canonicalBase64Length(value: unknown, maximumLength: number): number | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded.length : null;
}

export interface ConversationBody { readonly conversationId: string }
export interface ReadBody { readonly conversationId: string; readonly messageId: string }
export interface PresenceBody { readonly userIds: readonly string[] }

/** `typing:start` / `typing:stop`: exactly `{ conversationId }`. Any identity field is rejected. */
export function parseTypingBody(input: unknown): ConversationBody | null {
  return isPlainObject(input) && hasOnlyKeys(input, ['conversationId']) && isIdentifier(input.conversationId)
    ? { conversationId: input.conversationId } : null;
}

/** `message:read`: exactly `{ conversationId, messageId }`. */
export function parseReadBody(input: unknown): ReadBody | null {
  return isPlainObject(input) && hasOnlyKeys(input, ['conversationId', 'messageId']) &&
    isIdentifier(input.conversationId) && isIdentifier(input.messageId)
    ? { conversationId: input.conversationId, messageId: input.messageId } : null;
}

/** `presence:subscribe`: exactly `{ userIds }`, at most `maximum` identifiers; duplicates removed in order. */
export function parsePresenceBody(input: unknown, maximum: number): PresenceBody | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ['userIds'])) return null;
  const userIds = parseIdentifierList(input.userIds, maximum);
  return userIds ? { userIds } : null;
}

/** An array of at most `maximum` identifiers, de-duplicated in order; `null` when anything is invalid. */
export function parseIdentifierList(input: unknown, maximum: number): string[] | null {
  if (!Array.isArray(input) || input.length > maximum) return null;
  const unique = new Set<string>();
  for (const value of input as unknown[]) {
    if (!isIdentifier(value)) return null;
    unique.add(value);
  }
  return [...unique];
}

export interface EnvelopeLimits { readonly maxCiphertextLength: number }

/**
 * `message:send` body. Rejects plaintext (`content`), demo markers (`demoOnly`, `encryption.scope`),
 * unknown fields, non-canonical base64, an IV other than 12 bytes, and ciphertext of 16 bytes or less
 * (no room for the 128-bit tag) or above the operational limit.
 */
export function parseMessageEnvelope(input: unknown, limits: EnvelopeLimits): MessageEnvelope | null {
  if (!isPlainObject(input) ||
    !hasOnlyKeys(input, ['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'encryption']) ||
    !isIdentifier(input.id) || !isIdentifier(input.conversationId) || !isIdentifier(input.senderId) ||
    !isDisplayName(input.senderName) || !isIsoTimestamp(input.timestamp) || input.type !== 'text') return null;
  const encryption = input.encryption;
  if (!isPlainObject(encryption) || !hasOnlyKeys(encryption, ['version', 'algorithm', 'encoding', 'iv', 'ciphertext']) ||
    encryption.version !== 1 || encryption.algorithm !== 'AES-256-GCM' || encryption.encoding !== 'base64') return null;
  if (canonicalBase64Length(encryption.iv, 16) !== 12) return null;
  const ciphertextBytes = canonicalBase64Length(encryption.ciphertext, limits.maxCiphertextLength);
  if (ciphertextBytes === null || ciphertextBytes <= 16) return null;
  return {
    id: input.id,
    conversationId: input.conversationId,
    senderId: input.senderId,
    senderName: input.senderName,
    timestamp: input.timestamp,
    type: 'text',
    encryption: {
      version: 1,
      algorithm: 'AES-256-GCM',
      encoding: 'base64',
      iv: encryption.iv as string,
      ciphertext: encryption.ciphertext as string,
    },
  };
}

/** Lowercase hex SHA-256 over the envelope fields in a fixed order. Used for idempotency. */
export function envelopeFingerprint(envelope: MessageEnvelope): string {
  const canonical = JSON.stringify([
    envelope.id, envelope.conversationId, envelope.senderId, envelope.senderName, envelope.timestamp, envelope.type,
    envelope.encryption.version, envelope.encryption.algorithm, envelope.encryption.encoding,
    envelope.encryption.iv, envelope.encryption.ciphertext,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Recipient confirmation for a `message:new` emission: exactly the message's IDs and `status: 'delivered'`. */
export function isDeliveryAck(input: unknown, conversationId: string, messageId: string): boolean {
  return isPlainObject(input) && hasOnlyKeys(input, ['conversationId', 'messageId', 'status']) &&
    input.conversationId === conversationId && input.messageId === messageId && input.status === 'delivered';
}

function parseAuthenticatedSession(input: unknown): AuthenticatedSession | null {
  if (!isPlainObject(input) || !isIdentifier(input.sessionId) || !isIdentifier(input.userId) ||
    !isDisplayName(input.displayName) || !isValidDate(input.expiresAt)) return null;
  return {
    sessionId: input.sessionId,
    userId: input.userId,
    displayName: input.displayName,
    expiresAt: new Date(input.expiresAt.getTime()),
  };
}

/** Validates a resolver result. Extra fields are ignored (projection), malformed results return `null`. */
export function parseSessionResolution(input: unknown): SessionResolution | null {
  if (!isPlainObject(input)) return null;
  switch (input.status) {
    case 'missing':
    case 'invalid':
    case 'expired':
      return { status: input.status };
    case 'authenticated': {
      const session = parseAuthenticatedSession(input.session);
      return session ? { status: 'authenticated', session } : null;
    }
    default:
      return null;
  }
}

export function parseSessionCheck(input: unknown): SessionCheck | null {
  if (!isPlainObject(input)) return null;
  if (input.status === 'expired' || input.status === 'revoked') return { status: input.status };
  if (input.status === 'active' && isValidDate(input.expiresAt)) {
    return { status: 'active', expiresAt: new Date(input.expiresAt.getTime()) };
  }
  return null;
}

/** `undefined` means malformed; `null` means "not found in that conversation". */
export function parseStoredMessageRef(input: unknown, conversationId: string, messageId: string): StoredMessageRef | null | undefined {
  if (input === null) return null;
  if (!isPlainObject(input) || input.conversationId !== conversationId || input.messageId !== messageId ||
    !isIdentifier(input.senderId)) return undefined;
  return { conversationId, messageId, senderId: input.senderId };
}

export function parseReceiptOutcome(input: unknown): ReceiptOutcome | null {
  if (!isPlainObject(input) || (input.outcome !== 'created' && input.outcome !== 'duplicate') ||
    !isValidDate(input.recordedAt)) return null;
  return { outcome: input.outcome, recordedAt: new Date(input.recordedAt.getTime()) };
}

export function parseStoreOutcome(input: unknown): StoreMessageOutcome | null {
  if (!isPlainObject(input)) return null;
  if (input.outcome === 'conflict') return { outcome: 'conflict' };
  if ((input.outcome === 'created' || input.outcome === 'duplicate') && isValidDate(input.storedAt)) {
    return { outcome: input.outcome, storedAt: new Date(input.storedAt.getTime()) };
  }
  return null;
}

/** Anything other than an explicit `{ verified: true }` is treated as unverified. */
export function parseKeyVerification(input: unknown): KeyVerification {
  return isPlainObject(input) && input.verified === true ? { verified: true } : { verified: false };
}

/** Anything other than an explicit allow is a denial. */
export function parseSecurityDecision(input: unknown): SecurityDecision {
  if (isPlainObject(input) && input.action === 'allow') return { action: 'allow' };
  const reason = isPlainObject(input) && typeof input.reason === 'string' && AUDIT_REASON.test(input.reason)
    ? input.reason : 'unspecified';
  return { action: 'deny', reason };
}
