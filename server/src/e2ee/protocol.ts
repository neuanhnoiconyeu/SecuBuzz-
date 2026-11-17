/**
 * SecuBuzz direct-message key protocol `secubuzz-dm-keys` version 1.
 *
 * Specification: .kiro/specs/e2ee-recipient-keys/design.md and docs/e2ee-recipient-key-integration.md.
 * Every primitive is standard (ECDSA/ECDH P-256, HPKE RFC 9180, HKDF-SHA256, AES-256-GCM, SHA-256)
 * and available in WebCrypto and node:crypto. The server only verifies public data: it never sees
 * private keys, unwrapped conversation keys or plaintext.
 */

export const E2EE_PROTOCOL = Object.freeze({ name: 'secubuzz-dm-keys', version: 1 } as const);

/** Domain-separation labels; the first item of every canonical statement. */
export const LABELS = Object.freeze({
  deviceKey: 'secubuzz-device-key',
  deviceKeyId: 'secubuzz-device-key-id',
  conversationKey: 'secubuzz-conversation-key',
  conversationKeyWrap: 'secubuzz-conversation-key-wrap',
  recipientSet: 'secubuzz-recipient-set',
  /** Unchanged from the version-1 AAD so both envelope versions share one namespace. */
  messageAad: 'yahoo-security-messenger',
} as const);

/** RFC 9180: mode_base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. */
export const HPKE_SUITE = Object.freeze({ mode: 0x00, kemId: 0x0010, kdfId: 0x0001, aeadId: 0x0002 } as const);

export const ALGORITHMS = Object.freeze({
  signature: 'ECDSA P-256 SHA-256 (IEEE P1363)',
  agreement: 'ECDH P-256',
  wrap: 'HPKE base DHKEM(P-256, HKDF-SHA256) HKDF-SHA256 AES-256-GCM',
  message: 'AES-256-GCM',
} as const);

export const ENVELOPE_VERSION_2 = 2;

/** Decoded byte lengths of base64url fields. */
export const BYTE_LENGTHS = Object.freeze({
  deviceId: 16,
  keyId: 16,
  deviceKeyId: 32,
  publicKey: 65,
  signature: 64,
  /** 32-byte epoch key plus the 16-byte AES-GCM tag. */
  wrappedKey: 48,
} as const);

export const E2EE_LIMITS = Object.freeze({
  maxActiveDevicesPerUser: 10,
  /** Direct messages only. Group key management is out of scope. */
  participants: 2,
  maxWraps: 20,
  maxKeyVersion: 1_000_000,
  maxEpoch: 1_000_000_000,
  /** Freshness window for `createdAt` on new registrations and publications. */
  maxClockSkewMs: 300_000,
  maxCiphertextLength: 65_536,
} as const);

export type RegistrationRefusal =
  | 'invalid_registration'
  | 'stale_registration'
  | 'signature_invalid'
  | 'key_in_use'
  | 'key_revoked'
  | 'device_owned_by_another_user'
  | 'device_revoked'
  | 'stale_key_version'
  | 'device_limit';

export type RevocationRefusal = 'not_found';

export type PublicationRefusal =
  | 'invalid_publication'
  | 'stale_publication'
  | 'signature_invalid'
  | 'not_participant'
  | 'unsupported_conversation'
  | 'creator_device_unknown'
  | 'epoch_out_of_order'
  | 'recipient_without_devices'
  | 'recipient_set_mismatch'
  | 'key_id_conflict';

export type VerificationRefusal =
  | 'actor_invalid'
  | 'context_invalid'
  | 'envelope_unsupported'
  | 'conversation_mismatch'
  | 'actor_mismatch'
  | 'not_participant'
  | 'recipient_mismatch'
  | 'unsupported_conversation'
  | 'unknown_key'
  | 'stale_key'
  | 'recipient_without_devices'
  | 'device_record_invalid'
  | 'recipient_keys_changed'
  | 'epoch_signature_invalid'
  | 'fingerprint_mismatch';
