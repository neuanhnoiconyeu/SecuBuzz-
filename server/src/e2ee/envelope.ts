/**
 * Message envelope version 2: the version-1 envelope plus `encryption.keyId`, which names the
 * conversation-key epoch and is authenticated in the AES-GCM additional data. Version 1 parsing
 * and its fingerprint (`server/src/realtime/validation.ts`) are unchanged.
 */
import { canonicalJson, isBase64Url, sha256Hex } from './codec.ts';
import { BYTE_LENGTHS, E2EE_LIMITS, ENVELOPE_VERSION_2, LABELS } from './protocol.ts';
import { canonicalBase64Length, hasOnlyKeys, isDisplayName, isIdentifier, isIsoTimestamp, isPlainObject } from '../realtime/validation.ts';

export interface EncryptionV2 {
  readonly version: 2;
  readonly algorithm: 'AES-256-GCM';
  readonly encoding: 'base64';
  /** Epoch `keyId`: 16 bytes, base64url. */
  readonly keyId: string;
  /** Canonical padded base64 of exactly 12 bytes. */
  readonly iv: string;
  /** Canonical padded base64 of more than 16 bytes, including the 128-bit tag. */
  readonly ciphertext: string;
}

export interface MessageEnvelopeV2 {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly timestamp: string;
  readonly type: 'text';
  readonly encryption: EncryptionV2;
}

export interface EnvelopeV2Limits {
  readonly maxCiphertextLength: number;
}

const DEFAULT_LIMITS: EnvelopeV2Limits = Object.freeze({ maxCiphertextLength: E2EE_LIMITS.maxCiphertextLength });

/** Strict parser. Unknown fields, plaintext, demo markers and non-canonical encodings return `null`. */
export function parseMessageEnvelopeV2(input: unknown, limits: EnvelopeV2Limits = DEFAULT_LIMITS): MessageEnvelopeV2 | null {
  if (!isPlainObject(input) ||
    !hasOnlyKeys(input, ['id', 'conversationId', 'senderId', 'senderName', 'timestamp', 'type', 'encryption']) ||
    !isIdentifier(input.id) || !isIdentifier(input.conversationId) || !isIdentifier(input.senderId) ||
    !isDisplayName(input.senderName) || !isIsoTimestamp(input.timestamp) || input.type !== 'text') return null;
  const encryption = input.encryption;
  if (!isPlainObject(encryption) || !hasOnlyKeys(encryption, ['version', 'algorithm', 'encoding', 'keyId', 'iv', 'ciphertext']) ||
    encryption.version !== ENVELOPE_VERSION_2 || encryption.algorithm !== 'AES-256-GCM' || encryption.encoding !== 'base64' ||
    !isBase64Url(encryption.keyId, BYTE_LENGTHS.keyId)) return null;
  if (canonicalBase64Length(encryption.iv, 16) !== 12) return null;
  const ciphertextBytes = canonicalBase64Length(encryption.ciphertext, limits.maxCiphertextLength);
  if (ciphertextBytes === null || ciphertextBytes <= 16) return null;
  return Object.freeze({
    id: input.id,
    conversationId: input.conversationId,
    senderId: input.senderId,
    senderName: input.senderName,
    timestamp: input.timestamp,
    type: 'text' as const,
    encryption: Object.freeze({
      version: 2 as const,
      algorithm: 'AES-256-GCM' as const,
      encoding: 'base64' as const,
      keyId: encryption.keyId,
      iv: encryption.iv as string,
      ciphertext: encryption.ciphertext as string,
    }),
  });
}

/** Lowercase hex SHA-256 over the v2 fields in a fixed order (v1 order plus `keyId` before `iv`). */
export function envelopeV2Fingerprint(envelope: MessageEnvelopeV2): string {
  const { encryption } = envelope;
  return sha256Hex(canonicalJson([envelope.id, envelope.conversationId, envelope.senderId, envelope.senderName, envelope.timestamp,
    envelope.type, encryption.version, encryption.algorithm, encryption.encoding, encryption.keyId, encryption.iv, encryption.ciphertext]));
}

export interface MessageAadV2Fields {
  readonly conversationId: string;
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly timestamp: string;
  readonly keyId: string;
}

/** AES-GCM additional data for v2 (UTF-8 encode before use). */
export function messageAadV2(fields: MessageAadV2Fields): string {
  return canonicalJson([LABELS.messageAad, ENVELOPE_VERSION_2, fields.conversationId, fields.id, fields.senderId,
    fields.senderName, fields.timestamp, 'text', fields.keyId]);
}
