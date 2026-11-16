/**
 * Device-key registration and revocation rules.
 *
 * `validateDeviceRegistration` is stateless (shape, encodings, proof of possession).
 * `planDeviceRegistration` and `planDeviceRevocation` are pure decisions over records that DATA
 * reads and then writes inside ONE `BEGIN IMMEDIATE` transaction, so concurrent requests cannot
 * both pass a check. All functions are synchronous.
 */
import { isCanonicalTimestamp, isFresh } from './codec.ts';
import { deviceKeyIdFor, isP256PublicKey } from './keys.ts';
import { E2EE_LIMITS, type RegistrationRefusal, type RevocationRefusal } from './protocol.ts';
import { isDeviceId, isKeyVersion, isSignature, type DeviceKeyRecord, type StoredDeviceKey } from './records.ts';
import { verifyStatementSignature } from './signatures.ts';
import { registrationStatement } from './statements.ts';
import { hasOnlyKeys, isDemoIdentity, isIdentifier, isPlainObject } from '../realtime/validation.ts';

export type Decision<Value, Reason extends string> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: Reason };

const REGISTRATION_KEYS = ['deviceId', 'keyVersion', 'createdAt', 'agreementPublicKey', 'signingPublicKey', 'signature'] as const;

function refuse<Reason extends string>(reason: Reason): { readonly ok: false; readonly reason: Reason } {
  return { ok: false, reason };
}

/** True for an identifier accepted as an authenticated account: never a reserved demo identity. */
export function isAccountId(value: unknown): value is string {
  return isIdentifier(value) && !isDemoIdentity(value);
}

/**
 * Validates `POST /api/keys/devices` for the authenticated `userId`. The body cannot name a user.
 * Checks canonical encodings, valid distinct P-256 points and the self-signature over the
 * registration statement. Freshness is checked by the planner, after duplicate detection.
 */
export function validateDeviceRegistration(input: unknown, context: { readonly userId: string }): Decision<DeviceKeyRecord, RegistrationRefusal> {
  if (!isAccountId(context?.userId)) return refuse('invalid_registration');
  if (!isPlainObject(input) || !hasOnlyKeys(input, REGISTRATION_KEYS) || !isDeviceId(input.deviceId) || !isKeyVersion(input.keyVersion) ||
    !isCanonicalTimestamp(input.createdAt) || !isP256PublicKey(input.agreementPublicKey) || !isP256PublicKey(input.signingPublicKey) ||
    !isSignature(input.signature)) return refuse('invalid_registration');
  // One key pair must never serve both ECDSA and ECDH.
  if (input.agreementPublicKey === input.signingPublicKey) return refuse('invalid_registration');
  const fields = {
    userId: context.userId,
    deviceId: input.deviceId,
    keyVersion: input.keyVersion,
    createdAt: input.createdAt,
    agreementPublicKey: input.agreementPublicKey,
    signingPublicKey: input.signingPublicKey,
  };
  if (!verifyStatementSignature(fields.signingPublicKey, registrationStatement(fields), input.signature)) return refuse('signature_invalid');
  return {
    ok: true,
    value: Object.freeze({ deviceKeyId: deviceKeyIdFor(fields.agreementPublicKey, fields.signingPublicKey), ...fields, signature: input.signature }),
  };
}

/** Records DATA reads inside the registration transaction. */
export interface RegistrationLookup {
  /** The record with the same `deviceKeyId`, any user, any status. */
  readonly existingKey: StoredDeviceKey | null;
  /** Every version of the same `deviceId`, any user, any status. */
  readonly deviceHistory: readonly StoredDeviceKey[];
  /** The user's active devices. */
  readonly activeDevicesOfUser: readonly StoredDeviceKey[];
}

export type RegistrationPlan =
  | { readonly action: 'duplicate'; readonly record: StoredDeviceKey }
  | { readonly action: 'create'; readonly record: DeviceKeyRecord; readonly supersede: readonly string[] }
  | { readonly action: 'refuse'; readonly reason: RegistrationRefusal };

export interface RegistrationPolicy {
  readonly nowMs: number;
  readonly maxActiveDevicesPerUser?: number;
  readonly maxClockSkewMs?: number;
}

function sameRegistration(record: DeviceKeyRecord, stored: StoredDeviceKey): boolean {
  return stored.userId === record.userId && stored.deviceId === record.deviceId && stored.keyVersion === record.keyVersion &&
    stored.agreementPublicKey === record.agreementPublicKey && stored.signingPublicKey === record.signingPublicKey;
}

/**
 * Decides one registration. A new version supersedes the device's active version. Revocation and
 * supersession are permanent: old statements cannot be replayed to re-activate a key.
 */
export function planDeviceRegistration(record: DeviceKeyRecord, lookup: RegistrationLookup, policy: RegistrationPolicy): RegistrationPlan {
  const maxDevices = policy.maxActiveDevicesPerUser ?? E2EE_LIMITS.maxActiveDevicesPerUser;
  const { existingKey, deviceHistory, activeDevicesOfUser } = lookup;
  if (existingKey) {
    if (existingKey.deviceKeyId !== record.deviceKeyId) throw new TypeError('existingKey must have the same deviceKeyId.');
    if (existingKey.status !== 'active') return { action: 'refuse', reason: 'key_revoked' };
    if (!sameRegistration(record, existingKey)) return { action: 'refuse', reason: 'key_in_use' };
    return { action: 'duplicate', record: existingKey };
  }
  if (!isFresh(record.createdAt, policy.nowMs, policy.maxClockSkewMs ?? E2EE_LIMITS.maxClockSkewMs)) {
    return { action: 'refuse', reason: 'stale_registration' };
  }
  let highestVersion = 0;
  for (const stored of deviceHistory) {
    if (stored.deviceId !== record.deviceId) throw new TypeError('deviceHistory must contain only the same deviceId.');
    if (stored.userId !== record.userId) return { action: 'refuse', reason: 'device_owned_by_another_user' };
    if (stored.status === 'revoked') return { action: 'refuse', reason: 'device_revoked' };
    highestVersion = Math.max(highestVersion, stored.keyVersion);
  }
  if (record.keyVersion <= highestVersion) return { action: 'refuse', reason: 'stale_key_version' };
  const otherActive = activeDevicesOfUser.filter((device) => {
    if (device.userId !== record.userId || device.status !== 'active') throw new TypeError('activeDevicesOfUser must contain only active devices of the user.');
    return device.deviceId !== record.deviceId;
  });
  if (otherActive.length + 1 > maxDevices) return { action: 'refuse', reason: 'device_limit' };
  const supersede = deviceHistory.filter((stored) => stored.status === 'active').map((stored) => stored.deviceKeyId);
  return { action: 'create', record, supersede: Object.freeze(supersede) };
}

export type RevocationPlan =
  | { readonly action: 'revoke'; readonly deviceKeyIds: readonly string[] }
  | { readonly action: 'unchanged' }
  | { readonly action: 'refuse'; readonly reason: RevocationRefusal };

/**
 * Owner-only, permanent revocation of every version of `deviceId`. Unknown devices and devices of
 * other users get the same `not_found`.
 */
export function planDeviceRevocation(userId: string, deviceId: unknown, deviceHistory: readonly StoredDeviceKey[]): RevocationPlan {
  if (!isAccountId(userId) || !isDeviceId(deviceId) || deviceHistory.length === 0) return { action: 'refuse', reason: 'not_found' };
  for (const stored of deviceHistory) {
    if (stored.deviceId !== deviceId) throw new TypeError('deviceHistory must contain only the same deviceId.');
    if (stored.userId !== userId) return { action: 'refuse', reason: 'not_found' };
  }
  const pending = deviceHistory.filter((stored) => stored.status !== 'revoked').map((stored) => stored.deviceKeyId);
  return pending.length === 0 ? { action: 'unchanged' } : { action: 'revoke', deviceKeyIds: Object.freeze(pending) };
}
