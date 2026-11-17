export interface Registration {
  deviceId: string; keyVersion: number; createdAt: string;
  agreementPublicKey: string; signingPublicKey: string; signature: string;
}
export interface DeviceRecord extends Registration {
  deviceKeyId: string; userId: string; status: 'active' | 'superseded' | 'revoked'; registeredAt: string;
}
export interface WrappedKey { recipientUserId: string; recipientDeviceKeyId: string; enc: string; ciphertext: string }
export interface EpochBody {
  keyId: string; epoch: number; previousKeyId: string | null; creatorDeviceKeyId: string;
  createdAt: string; wraps: WrappedKey[]; signature: string;
}
export interface KeyEpoch extends EpochBody { conversationId: string; creatorUserId: string; publishedAt: string }
export interface KeyState {
  conversationId: string; participantIds: string[]; devices: DeviceRecord[];
  currentEpoch: { keyId: string; epoch: number } | null; epochs: KeyEpoch[]; cursor: string | null;
}
export interface EncryptionV2 { version: 2; algorithm: 'AES-256-GCM'; encoding: 'base64'; keyId: string; iv: string; ciphertext: string }
export interface EnvelopeV2 {
  id: string; conversationId: string; senderId: string; senderName: string; timestamp: string; type: 'text'; encryption: EncryptionV2;
}
export interface StoredMessage extends Omit<EnvelopeV2, 'encryption'> {
  encryption: EncryptionV2 | null; storageId: string; storedAt: string; updatedAt: string;
  sequence: number; revision: number; state: 'active' | 'deleted'; deletedAt: string | null;
}
export interface DirectConversation {
  id: string; type: 'direct'; participants: { id: string; username: string; displayName: string; avatar: string }[];
  createdAt: string; updatedAt: string; interactionAllowed: boolean;
}
export interface DeviceIdentity {
  schema: 1; userId: string; deviceId: string; deviceKeyId: string; keyVersion: number;
  signing: CryptoKeyPair; agreement: CryptoKeyPair; agreementPublicKey: string; signingPublicKey: string;
}
export const securityMessages = {
  unavailable: 'Secure key services are unavailable. Refresh before trying again.',
  storage_unavailable: 'Secure local key storage is unavailable. No temporary key fallback was created.',
  storage_corrupt: 'Local device keys could not be restored. Existing encrypted history may be inaccessible. No replacement was created.',
  enrollment_required: 'Enroll this browser explicitly to create a new secure device. Older encrypted history may not be available here.',
  device_revoked: 'This device was revoked or superseded. It cannot prepare new secure messages.',
  recipient_missing: 'Waiting for recipient keys. Your contact must register a secure device.',
  keys_changed: 'Your contact’s device keys changed. Review and trust the current devices before sending.',
  invalid_proof: 'Key verification failed. The signed device or epoch data was rejected.',
  stale_epoch: 'Conversation keys changed. Refresh secure state before sending again.',
  missing_key: 'Unable to decrypt: this browser does not have the required historical key.',
  decryption_failed: 'Unable to decrypt: the ciphertext or authenticated metadata could not be verified.',
  nonce_failed: 'A unique encryption nonce could not be reserved. Nothing was sent.',
  invalid_message: 'The encrypted message is malformed or unsupported.',
  pending_message: 'A message is awaiting confirmation. Reconcile or retry that same encrypted message first.',
  pending_stale: 'The pending message uses older keys. Check history; it will not be re-encrypted or duplicated automatically.',
  disposed: 'This secure session has ended.',
} as const;
export type SecurityErrorCode = keyof typeof securityMessages;
export class E2eeError extends Error {
  constructor(public readonly code: SecurityErrorCode) { super(securityMessages[code]); this.name = 'E2eeError'; }
}
