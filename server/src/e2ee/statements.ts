/**
 * Canonical statements of the key protocol. Clients sign or HPKE-bind exactly these UTF-8 strings;
 * the server rebuilds them from validated fields and never trusts a client-supplied statement.
 */
import { canonicalJson, sha256Base64Url } from './codec.ts';
import { LABELS } from './protocol.ts';

export interface RegistrationStatementFields {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly agreementPublicKey: string;
  readonly signingPublicKey: string;
}

/** `["secubuzz-device-key",1,userId,deviceId,keyVersion,createdAt,agreementPublicKey,signingPublicKey]` */
export function registrationStatement(fields: RegistrationStatementFields): string {
  return canonicalJson([LABELS.deviceKey, 1, fields.userId, fields.deviceId, fields.keyVersion, fields.createdAt,
    fields.agreementPublicKey, fields.signingPublicKey]);
}

export interface WrappedKey {
  readonly recipientUserId: string;
  readonly recipientDeviceKeyId: string;
  /** HPKE encapsulated key: uncompressed P-256 point, base64url. */
  readonly enc: string;
  /** HPKE ciphertext of the 32-byte epoch key, base64url (48 bytes). */
  readonly ciphertext: string;
}

export interface EpochStatementFields {
  readonly conversationId: string;
  readonly keyId: string;
  readonly epoch: number;
  readonly previousKeyId: string | null;
  readonly creatorUserId: string;
  readonly creatorDeviceKeyId: string;
  readonly createdAt: string;
  readonly wraps: readonly WrappedKey[];
}

/**
 * `["secubuzz-conversation-key",1,conversationId,keyId,epoch,previousKeyId,creatorUserId,
 * creatorDeviceKeyId,createdAt,[[recipientUserId,recipientDeviceKeyId,enc,ciphertext],…]]`
 */
export function epochStatement(fields: EpochStatementFields): string {
  return canonicalJson([LABELS.conversationKey, 1, fields.conversationId, fields.keyId, fields.epoch, fields.previousKeyId,
    fields.creatorUserId, fields.creatorDeviceKeyId, fields.createdAt,
    fields.wraps.map((wrap) => [wrap.recipientUserId, wrap.recipientDeviceKeyId, wrap.enc, wrap.ciphertext])]);
}

export interface WrapInfoFields {
  readonly conversationId: string;
  readonly keyId: string;
  readonly epoch: number;
  readonly creatorUserId: string;
  readonly creatorDeviceKeyId: string;
  readonly recipientUserId: string;
  readonly recipientDeviceKeyId: string;
}

/** HPKE `info` for one wrap. The HPKE `aad` is empty. */
export function wrapInfo(fields: WrapInfoFields): string {
  return canonicalJson([LABELS.conversationKeyWrap, 1, fields.conversationId, fields.keyId, fields.epoch,
    fields.creatorUserId, fields.creatorDeviceKeyId, fields.recipientUserId, fields.recipientDeviceKeyId]);
}

export interface RecipientDevice {
  readonly userId: string;
  readonly deviceKeyId: string;
}

/** Code-unit order by user, then device key: the required order of wraps. */
export function compareRecipients(left: RecipientDevice, right: RecipientDevice): number {
  if (left.userId !== right.userId) return left.userId < right.userId ? -1 : 1;
  if (left.deviceKeyId !== right.deviceKeyId) return left.deviceKeyId < right.deviceKeyId ? -1 : 1;
  return 0;
}

/** Digest of a sorted recipient set; DATA may store it to compare sets cheaply. */
export function recipientSetDigest(conversationId: string, devices: readonly RecipientDevice[]): string {
  const sorted = [...devices].sort(compareRecipients);
  return sha256Base64Url(canonicalJson([LABELS.recipientSet, 1, conversationId, sorted.map((device) => [device.userId, device.deviceKeyId])]));
}
