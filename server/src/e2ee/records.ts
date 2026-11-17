/**
 * Records exchanged with the DATA-owned key directory, and strict parsers for them. Parsers project
 * known fields (extra storage metadata is ignored) and return `null` for anything malformed, so an
 * adapter bug can only fail closed.
 */
import { isBase64Url, isCanonicalTimestamp } from './codec.ts';
import { isP256PublicKey } from './keys.ts';
import { BYTE_LENGTHS, E2EE_LIMITS } from './protocol.ts';
import type { WrappedKey } from './statements.ts';
import { isIdentifier, isPlainObject } from '../realtime/validation.ts';

export type DeviceKeyStatus = 'active' | 'superseded' | 'revoked';

/** A validated registration. `userId` always comes from the authenticated session. */
export interface DeviceKeyRecord {
  readonly deviceKeyId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly agreementPublicKey: string;
  readonly signingPublicKey: string;
  readonly signature: string;
}

export interface StoredDeviceKey extends DeviceKeyRecord {
  readonly status: DeviceKeyStatus;
}

export interface ConversationKeyEpoch {
  readonly conversationId: string;
  readonly keyId: string;
  readonly epoch: number;
  readonly previousKeyId: string | null;
  readonly creatorUserId: string;
  readonly creatorDeviceKeyId: string;
  readonly createdAt: string;
  readonly wraps: readonly WrappedKey[];
  readonly signature: string;
}

export interface EpochSummary {
  readonly keyId: string;
  readonly epoch: number;
}

/**
 * One consistent snapshot of a conversation's key state, read in a single transaction:
 * the current participants, the active device keys of those participants only, the latest epoch,
 * and the epoch named by the requested `keyId` (or `null` when it does not exist in this conversation).
 */
export interface ConversationKeyState {
  readonly conversationId: string;
  readonly participantIds: readonly string[];
  readonly activeDevices: readonly StoredDeviceKey[];
  readonly currentEpoch: EpochSummary | null;
  readonly epoch: ConversationKeyEpoch | null;
}

const STATUSES: ReadonlySet<string> = new Set(['active', 'superseded', 'revoked']);
const MAX_PARTICIPANTS_READ = 64;
const MAX_DEVICES_READ = E2EE_LIMITS.maxActiveDevicesPerUser * E2EE_LIMITS.participants;

export function isKeyVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= E2EE_LIMITS.maxKeyVersion;
}

export function isEpochNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= E2EE_LIMITS.maxEpoch;
}

export const isDeviceId = (value: unknown): value is string => isBase64Url(value, BYTE_LENGTHS.deviceId);
export const isEpochKeyId = (value: unknown): value is string => isBase64Url(value, BYTE_LENGTHS.keyId);
export const isDeviceKeyId = (value: unknown): value is string => isBase64Url(value, BYTE_LENGTHS.deviceKeyId);
export const isSignature = (value: unknown): value is string => isBase64Url(value, BYTE_LENGTHS.signature);
export const isWrappedKeyCiphertext = (value: unknown): value is string => isBase64Url(value, BYTE_LENGTHS.wrappedKey);

/** Structure only. Signatures and key IDs are verified by the evaluator. */
export function parseStoredDeviceKey(input: unknown): StoredDeviceKey | null {
  if (!isPlainObject(input) || !isDeviceKeyId(input.deviceKeyId) || !isIdentifier(input.userId) || !isDeviceId(input.deviceId) ||
    !isKeyVersion(input.keyVersion) || !isCanonicalTimestamp(input.createdAt) || !isP256PublicKey(input.agreementPublicKey) ||
    !isP256PublicKey(input.signingPublicKey) || !isSignature(input.signature) ||
    typeof input.status !== 'string' || !STATUSES.has(input.status)) return null;
  return Object.freeze({
    deviceKeyId: input.deviceKeyId,
    userId: input.userId,
    deviceId: input.deviceId,
    keyVersion: input.keyVersion,
    createdAt: input.createdAt,
    agreementPublicKey: input.agreementPublicKey,
    signingPublicKey: input.signingPublicKey,
    signature: input.signature,
    status: input.status as DeviceKeyStatus,
  });
}

export function parseWrappedKey(input: unknown): WrappedKey | null {
  if (!isPlainObject(input) || !isIdentifier(input.recipientUserId) || !isDeviceKeyId(input.recipientDeviceKeyId) ||
    !isP256PublicKey(input.enc) || !isWrappedKeyCiphertext(input.ciphertext)) return null;
  return Object.freeze({
    recipientUserId: input.recipientUserId,
    recipientDeviceKeyId: input.recipientDeviceKeyId,
    enc: input.enc,
    ciphertext: input.ciphertext,
  });
}

export function parseStoredEpoch(input: unknown): ConversationKeyEpoch | null {
  if (!isPlainObject(input) || !isIdentifier(input.conversationId) || !isEpochKeyId(input.keyId) || !isEpochNumber(input.epoch) ||
    !(input.previousKeyId === null || isEpochKeyId(input.previousKeyId)) || !isIdentifier(input.creatorUserId) ||
    !isDeviceKeyId(input.creatorDeviceKeyId) || !isCanonicalTimestamp(input.createdAt) || !isSignature(input.signature) ||
    !Array.isArray(input.wraps) || input.wraps.length === 0 || input.wraps.length > E2EE_LIMITS.maxWraps) return null;
  if ((input.epoch === 1) !== (input.previousKeyId === null)) return null;
  const wraps: WrappedKey[] = [];
  for (const entry of input.wraps as unknown[]) {
    const wrap = parseWrappedKey(entry);
    if (!wrap) return null;
    wraps.push(wrap);
  }
  return Object.freeze({
    conversationId: input.conversationId,
    keyId: input.keyId,
    epoch: input.epoch,
    previousKeyId: input.previousKeyId as string | null,
    creatorUserId: input.creatorUserId,
    creatorDeviceKeyId: input.creatorDeviceKeyId,
    createdAt: input.createdAt,
    wraps: Object.freeze(wraps),
    signature: input.signature,
  });
}

function parseEpochSummary(input: unknown): EpochSummary | null {
  if (!isPlainObject(input) || !isEpochKeyId(input.keyId) || !isEpochNumber(input.epoch)) return null;
  return Object.freeze({ keyId: input.keyId, epoch: input.epoch });
}

/** Validates a directory snapshot for the requested conversation and `keyId`. */
export function parseConversationKeyState(input: unknown, expected: { readonly conversationId: string; readonly keyId: string }): ConversationKeyState | null {
  if (!isPlainObject(input) || input.conversationId !== expected.conversationId || !Array.isArray(input.participantIds) ||
    input.participantIds.length > MAX_PARTICIPANTS_READ || !Array.isArray(input.activeDevices) || input.activeDevices.length > MAX_DEVICES_READ) return null;
  const participants = new Set<string>();
  for (const id of input.participantIds as unknown[]) {
    if (!isIdentifier(id) || participants.has(id)) return null;
    participants.add(id);
  }
  const devices: StoredDeviceKey[] = [];
  const seen = new Set<string>();
  for (const entry of input.activeDevices as unknown[]) {
    const device = parseStoredDeviceKey(entry);
    if (!device || device.status !== 'active' || !participants.has(device.userId) || seen.has(device.deviceKeyId)) return null;
    seen.add(device.deviceKeyId);
    devices.push(device);
  }
  let currentEpoch: EpochSummary | null = null;
  if (input.currentEpoch !== null) {
    currentEpoch = parseEpochSummary(input.currentEpoch);
    if (!currentEpoch) return null;
  }
  let epoch: ConversationKeyEpoch | null = null;
  if (input.epoch !== null) {
    epoch = parseStoredEpoch(input.epoch);
    if (!epoch || epoch.conversationId !== expected.conversationId || epoch.keyId !== expected.keyId || !currentEpoch ||
      currentEpoch.epoch < epoch.epoch || ((currentEpoch.keyId === epoch.keyId) !== (currentEpoch.epoch === epoch.epoch))) return null;
  }
  return Object.freeze({
    conversationId: expected.conversationId,
    participantIds: Object.freeze([...participants]),
    activeDevices: Object.freeze(devices),
    currentEpoch,
    epoch,
  });
}
