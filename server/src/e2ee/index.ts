/**
 * Public entry point of the SecuBuzz recipient-key protocol (`secubuzz-realtime-server/e2ee`).
 *
 * DATA hosts the verifier in its own process:
 *
 *   const { createRecipientKeyVerifier } = require('../server/src/e2ee/index.ts');
 *   createApp({ db, messageOptions: { recipientKeyVerifier: createRecipientKeyVerifier({ directory }) } });
 *
 * and calls the synchronous planners inside its write transactions. Test doubles (in-memory
 * directory, HPKE reference, simulated devices) live in `server/test/e2ee/` and are not exported.
 * Specification: docs/e2ee-recipient-key-integration.md.
 */
export { ALGORITHMS, BYTE_LENGTHS, E2EE_LIMITS, E2EE_PROTOCOL, ENVELOPE_VERSION_2, HPKE_SUITE, LABELS } from './protocol.ts';
export type { PublicationRefusal, RegistrationRefusal, RevocationRefusal, VerificationRefusal } from './protocol.ts';
export { canonicalJson, decodeBase64Url, isCanonicalTimestamp } from './codec.ts';
export { deviceKeyIdFor, isP256PublicKey } from './keys.ts';
export { epochStatement, recipientSetDigest, registrationStatement, wrapInfo } from './statements.ts';
export type { WrappedKey } from './statements.ts';
export { envelopeV2Fingerprint, messageAadV2, parseMessageEnvelopeV2 } from './envelope.ts';
export type { EncryptionV2, MessageEnvelopeV2 } from './envelope.ts';
export { parseConversationKeyState, parseStoredDeviceKey, parseStoredEpoch } from './records.ts';
export type { ConversationKeyEpoch, ConversationKeyState, DeviceKeyRecord, DeviceKeyStatus, EpochSummary, StoredDeviceKey } from './records.ts';
export { planDeviceRegistration, planDeviceRevocation, validateDeviceRegistration } from './registration.ts';
export type { RegistrationLookup, RegistrationPlan, RegistrationPolicy, RevocationPlan } from './registration.ts';
export { planEpochPublication } from './epochs.ts';
export type { PublicationContext, PublicationPlan, PublishedEpoch } from './epochs.ts';
export { evaluateRecipientKeys, verifyRecipientKeysSync } from './evaluation.ts';
export type { RecipientKeyCheck, RecipientKeyContext } from './evaluation.ts';
export { createRecipientKeyVerifier, RecipientKeyServiceUnavailableError } from './verifier.ts';
export type { RecipientKeyDirectory, RecipientKeyVerifierHandle, RecipientKeyVerifierOptions } from './verifier.ts';
