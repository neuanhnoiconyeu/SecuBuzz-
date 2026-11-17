/**
 * Conversation-key epoch publication rules. DATA reads the key state and calls
 * `planEpochPublication` inside its `withInteraction` (BEGIN IMMEDIATE) transaction, then writes
 * the epoch only on `create`. The function is synchronous and pure.
 */
import { isCanonicalTimestamp, isFresh } from './codec.ts';
import { E2EE_LIMITS, type PublicationRefusal } from './protocol.ts';
import {
  isDeviceKeyId,
  isEpochKeyId,
  isEpochNumber,
  isSignature,
  parseWrappedKey,
  type ConversationKeyEpoch,
  type EpochSummary,
  type StoredDeviceKey,
} from './records.ts';
import { verifyStatementSignature } from './signatures.ts';
import { compareRecipients, epochStatement, recipientSetDigest, type WrappedKey } from './statements.ts';
import { isAccountId } from './registration.ts';
import { hasOnlyKeys, isIdentifier, isPlainObject } from '../realtime/validation.ts';

const PUBLICATION_KEYS = ['keyId', 'epoch', 'previousKeyId', 'creatorDeviceKeyId', 'createdAt', 'wraps', 'signature'] as const;

/** State DATA reads inside the publication transaction. */
export interface PublicationContext {
  /** The authenticated actor. The body cannot name the creator. */
  readonly actorUserId: string;
  readonly conversationId: string;
  /** Current active participants from DB-4A. */
  readonly participantIds: readonly string[];
  /** Active device keys of the participants. */
  readonly activeDevices: readonly StoredDeviceKey[];
  readonly currentEpoch: EpochSummary | null;
  /** The epoch with the same `keyId` in this conversation, if any. */
  readonly existingEpoch: ConversationKeyEpoch | null;
  readonly nowMs: number;
  readonly maxClockSkewMs?: number;
}

export interface PublishedEpoch extends ConversationKeyEpoch {
  readonly recipientSetDigest: string;
}

export type PublicationPlan =
  | { readonly action: 'create'; readonly epoch: PublishedEpoch }
  | { readonly action: 'duplicate'; readonly epoch: ConversationKeyEpoch }
  | { readonly action: 'refuse'; readonly reason: PublicationRefusal };

function refuse(reason: PublicationRefusal): PublicationPlan {
  return { action: 'refuse', reason };
}

function sameEpoch(left: ConversationKeyEpoch, right: ConversationKeyEpoch): boolean {
  return epochStatement(left) === epochStatement(right) && left.signature === right.signature;
}

function parsePublication(input: unknown, actorUserId: string, conversationId: string): ConversationKeyEpoch | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, PUBLICATION_KEYS) || !isEpochKeyId(input.keyId) || !isEpochNumber(input.epoch) ||
    !(input.previousKeyId === null || isEpochKeyId(input.previousKeyId)) || !isDeviceKeyId(input.creatorDeviceKeyId) ||
    !isCanonicalTimestamp(input.createdAt) || !isSignature(input.signature) || !Array.isArray(input.wraps) ||
    input.wraps.length === 0 || input.wraps.length > E2EE_LIMITS.maxWraps) return null;
  const wraps: WrappedKey[] = [];
  for (const entry of input.wraps as unknown[]) {
    if (!isPlainObject(entry) || !hasOnlyKeys(entry, ['recipientUserId', 'recipientDeviceKeyId', 'enc', 'ciphertext'])) return null;
    const wrap = parseWrappedKey(entry);
    if (!wrap) return null;
    // Strictly increasing order: canonical and free of duplicates.
    const previous = wraps.at(-1);
    if (previous && compareRecipients({ userId: previous.recipientUserId, deviceKeyId: previous.recipientDeviceKeyId },
      { userId: wrap.recipientUserId, deviceKeyId: wrap.recipientDeviceKeyId }) >= 0) return null;
    wraps.push(wrap);
  }
  return Object.freeze({
    conversationId,
    keyId: input.keyId,
    epoch: input.epoch,
    previousKeyId: input.previousKeyId as string | null,
    creatorUserId: actorUserId,
    creatorDeviceKeyId: input.creatorDeviceKeyId,
    createdAt: input.createdAt,
    wraps: Object.freeze(wraps),
    signature: input.signature,
  });
}

/**
 * Decides `POST /api/conversations/:id/keys/epochs`. A new epoch must follow the current one,
 * come from an active device of the actor, wrap the key for exactly the active devices of both
 * participants, and carry a valid signature by the creator device.
 */
export function planEpochPublication(input: unknown, context: PublicationContext): PublicationPlan {
  const { actorUserId, conversationId, participantIds, activeDevices, currentEpoch, existingEpoch } = context;
  if (!isAccountId(actorUserId) || !isIdentifier(conversationId)) return refuse('invalid_publication');
  const epoch = parsePublication(input, actorUserId, conversationId);
  if (!epoch) return refuse('invalid_publication');
  if (existingEpoch) {
    if (existingEpoch.keyId !== epoch.keyId || existingEpoch.conversationId !== conversationId) {
      throw new TypeError('existingEpoch must have the same conversation and keyId.');
    }
    return sameEpoch(existingEpoch, epoch) ? { action: 'duplicate', epoch: existingEpoch } : refuse('key_id_conflict');
  }
  const participants = new Set(participantIds);
  if (participants.size !== E2EE_LIMITS.participants || participantIds.length !== participants.size) return refuse('unsupported_conversation');
  if (!participants.has(actorUserId)) return refuse('not_participant');
  if (!isFresh(epoch.createdAt, context.nowMs, context.maxClockSkewMs ?? E2EE_LIMITS.maxClockSkewMs)) return refuse('stale_publication');
  if (currentEpoch === null ? epoch.epoch !== 1 || epoch.previousKeyId !== null
    : epoch.epoch !== currentEpoch.epoch + 1 || epoch.previousKeyId !== currentEpoch.keyId) return refuse('epoch_out_of_order');
  for (const device of activeDevices) {
    if (device.status !== 'active' || !participants.has(device.userId)) throw new TypeError('activeDevices must be active devices of the participants.');
  }
  const creator = activeDevices.find((device) => device.deviceKeyId === epoch.creatorDeviceKeyId);
  if (!creator || creator.userId !== actorUserId) return refuse('creator_device_unknown');
  for (const participant of participants) {
    if (!activeDevices.some((device) => device.userId === participant)) return refuse('recipient_without_devices');
  }
  const expected = activeDevices.map((device) => ({ userId: device.userId, deviceKeyId: device.deviceKeyId })).sort(compareRecipients);
  if (expected.length !== epoch.wraps.length || expected.some((device, index) => {
    const wrap = epoch.wraps[index] as WrappedKey;
    return wrap.recipientUserId !== device.userId || wrap.recipientDeviceKeyId !== device.deviceKeyId;
  })) return refuse('recipient_set_mismatch');
  if (!verifyStatementSignature(creator.signingPublicKey, epochStatement(epoch), epoch.signature)) return refuse('signature_invalid');
  return { action: 'create', epoch: Object.freeze({ ...epoch, recipientSetDigest: recipientSetDigest(conversationId, expected) }) };
}
