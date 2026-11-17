/**
 * The recipient-key decision for one message. Pure and synchronous, so DATA can run it both in the
 * asynchronous verifier call and again inside its `BEGIN IMMEDIATE` write transaction.
 *
 * What it proves: the envelope names the current epoch of this conversation; that epoch was signed
 * by an active device of a participant and wraps the key for exactly the active, self-signed device
 * keys of both participants. What it cannot prove: that the ciphertext really used that key (only
 * key holders can check the GCM tag), or that the directory itself was not given substituted keys.
 */
import { parseMessageEnvelopeV2, envelopeV2Fingerprint, type MessageEnvelopeV2 } from './envelope.ts';
import { deviceKeyIdFor } from './keys.ts';
import { E2EE_LIMITS, type VerificationRefusal } from './protocol.ts';
import { parseConversationKeyState, type ConversationKeyState } from './records.ts';
import { verifyStatementSignature } from './signatures.ts';
import { compareRecipients, epochStatement, registrationStatement } from './statements.ts';
import { isAccountId } from './registration.ts';
import { isIdentifier } from '../realtime/validation.ts';

/** Authoritative facts from the caller. DATA supplies `recipientIds` and `fingerprint`. */
export interface RecipientKeyContext {
  readonly actorUserId: string;
  readonly conversationId: string;
  readonly recipientIds?: readonly string[];
  /** Lowercase hex SHA-256 computed by the caller's own canonicalization. */
  readonly fingerprint?: string;
}

export type RecipientKeyCheck =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: VerificationRefusal };

const FINGERPRINT = /^[a-f0-9]{64}$/;

function refused(reason: VerificationRefusal): RecipientKeyCheck {
  return { verified: false, reason };
}

export function evaluateRecipientKeys(envelope: MessageEnvelopeV2, context: RecipientKeyContext, state: ConversationKeyState): RecipientKeyCheck {
  if (!isAccountId(context.actorUserId) || !isIdentifier(context.conversationId)) return refused('context_invalid');
  if (envelope.conversationId !== context.conversationId || state.conversationId !== context.conversationId) return refused('conversation_mismatch');
  if (envelope.senderId !== context.actorUserId) return refused('actor_mismatch');
  if (state.participantIds.length !== E2EE_LIMITS.participants) return refused('unsupported_conversation');
  if (!state.participantIds.includes(context.actorUserId)) return refused('not_participant');
  const others = state.participantIds.filter((id) => id !== context.actorUserId);
  if (context.recipientIds !== undefined) {
    const supplied = new Set(context.recipientIds);
    if (supplied.size !== context.recipientIds.length || supplied.size !== others.length || others.some((id) => !supplied.has(id))) {
      return refused('recipient_mismatch');
    }
  }
  if (context.fingerprint !== undefined && context.fingerprint !== envelopeV2Fingerprint(envelope)) return refused('fingerprint_mismatch');

  const epoch = state.epoch;
  if (!epoch || epoch.keyId !== envelope.encryption.keyId || epoch.conversationId !== context.conversationId) return refused('unknown_key');
  if (!state.currentEpoch || state.currentEpoch.keyId !== epoch.keyId || state.currentEpoch.epoch !== epoch.epoch) return refused('stale_key');

  for (const participant of state.participantIds) {
    if (!state.activeDevices.some((device) => device.userId === participant)) return refused('recipient_without_devices');
  }
  for (const device of state.activeDevices) {
    if (device.deviceKeyId !== deviceKeyIdFor(device.agreementPublicKey, device.signingPublicKey) ||
      !verifyStatementSignature(device.signingPublicKey, registrationStatement(device), device.signature)) return refused('device_record_invalid');
  }
  const expected = state.activeDevices.map((device) => ({ userId: device.userId, deviceKeyId: device.deviceKeyId })).sort(compareRecipients);
  if (expected.length !== epoch.wraps.length || expected.some((device, index) => {
    const wrap = epoch.wraps[index];
    return !wrap || wrap.recipientUserId !== device.userId || wrap.recipientDeviceKeyId !== device.deviceKeyId;
  })) return refused('recipient_keys_changed');
  const creator = state.activeDevices.find((device) => device.deviceKeyId === epoch.creatorDeviceKeyId);
  if (!creator || creator.userId !== epoch.creatorUserId) return refused('recipient_keys_changed');
  if (!verifyStatementSignature(creator.signingPublicKey, epochStatement(epoch), epoch.signature)) return refused('epoch_signature_invalid');
  return { verified: true };
}

/**
 * Boolean form for DATA's in-transaction recheck: parses the raw envelope and the raw directory
 * snapshot read on the same connection, then evaluates. Anything malformed is `false`.
 */
export function verifyRecipientKeysSync(envelope: unknown, context: RecipientKeyContext, state: unknown): boolean {
  const parsed = parseMessageEnvelopeV2(envelope);
  if (!parsed || (context.fingerprint !== undefined && !FINGERPRINT.test(context.fingerprint))) return false;
  const snapshot = parseConversationKeyState(state, { conversationId: parsed.conversationId, keyId: parsed.encryption.keyId });
  return snapshot !== null && evaluateRecipientKeys(parsed, context, snapshot).verified;
}
