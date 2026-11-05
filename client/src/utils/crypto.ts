/** Browser-native AES-256-GCM primitives for the local messaging demo. */

export const ENCRYPTION_ALGORITHM = 'AES-256-GCM' as const;
export const ENCRYPTION_VERSION = 1 as const;
export const ENCRYPTION_ENCODING = 'base64' as const;

const WEB_CRYPTO_ALGORITHM = 'AES-GCM' as const;
const KEY_LENGTH_BITS = 256;
const IV_LENGTH_BYTES = 12;
const AUTHENTICATION_TAG_LENGTH_BITS = 128;
const AUTHENTICATION_TAG_LENGTH_BYTES = AUTHENTICATION_TAG_LENGTH_BITS / 8;
const MAX_IV_GENERATION_ATTEMPTS = 16;

export interface EncryptedMessagePayload {
  version: typeof ENCRYPTION_VERSION;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  encoding: typeof ENCRYPTION_ENCODING;
  /** Base64-encoded 96-bit nonce. */
  iv: string;
  /** Base64 AES-GCM output, including the 128-bit authentication tag. */
  ciphertext: string;
}

/** Metadata authenticated as AES-GCM additional authenticated data. */
export interface CryptoMessageContext {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  timestamp: string;
}

export type CryptoErrorCode =
  | 'web_crypto_unavailable'
  | 'key_generation_failed'
  | 'missing_key'
  | 'invalid_key'
  | 'invalid_plaintext'
  | 'invalid_context'
  | 'iv_generation_failed'
  | 'invalid_payload'
  | 'unsupported_version'
  | 'unsupported_algorithm'
  | 'invalid_base64'
  | 'invalid_iv'
  | 'encryption_failed'
  | 'authentication_failed'
  | 'invalid_plaintext_encoding';

const SAFE_ERROR_MESSAGES: Record<CryptoErrorCode, string> = {
  web_crypto_unavailable: 'Browser cryptography is unavailable.',
  key_generation_failed: 'A local encryption key could not be created.',
  missing_key: 'No local encryption key is available for this conversation.',
  invalid_key: 'The encryption key is invalid for this operation.',
  invalid_plaintext: 'The message must contain non-empty text.',
  invalid_context: 'The message context is invalid.',
  iv_generation_failed: 'A unique encryption nonce could not be generated.',
  invalid_payload: 'The encrypted message payload is malformed.',
  unsupported_version: 'The encrypted message version is unsupported.',
  unsupported_algorithm: 'The encrypted message algorithm is unsupported.',
  invalid_base64: 'The encrypted message encoding is invalid.',
  invalid_iv: 'The encrypted message nonce is invalid.',
  encryption_failed: 'The message could not be encrypted.',
  authentication_failed: 'The message could not be authenticated and was rejected.',
  invalid_plaintext_encoding: 'The authenticated message text is invalid.',
};

export class CryptoOperationError extends Error {
  constructor(public readonly code: CryptoErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'CryptoOperationError';
  }
}

const usedIvsByKey = new WeakMap<CryptoKey, Set<string>>();

export function isWebCryptoAvailable(): boolean {
  return Boolean(
    globalThis.crypto?.subtle &&
    typeof globalThis.crypto.getRandomValues === 'function' &&
    typeof TextEncoder !== 'undefined' &&
    typeof TextDecoder !== 'undefined' &&
    typeof btoa === 'function' &&
    typeof atob === 'function'
  );
}

function requireWebCrypto(): Crypto {
  if (!isWebCryptoAvailable()) throw new CryptoOperationError('web_crypto_unavailable');
  return globalThis.crypto;
}

function validateKey(key: CryptoKey, usage: KeyUsage): void {
  if (!key || typeof key !== 'object') throw new CryptoOperationError('invalid_key');
  const algorithm = key.algorithm as AesKeyAlgorithm | undefined;
  if (
    key.type !== 'secret' ||
    !algorithm ||
    algorithm.name !== WEB_CRYPTO_ALGORITHM ||
    algorithm.length !== KEY_LENGTH_BITS ||
    key.extractable ||
    !Array.isArray(key.usages) ||
    !key.usages.includes(usage)
  ) {
    throw new CryptoOperationError('invalid_key');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const isCanonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!value || !isCanonicalBase64.test(value)) throw new CryptoOperationError('invalid_base64');

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (bytesToBase64(bytes) !== value) throw new CryptoOperationError('invalid_base64');
    return bytes;
  } catch (error) {
    if (error instanceof CryptoOperationError) throw error;
    throw new CryptoOperationError('invalid_base64');
  }
}

function serializeContext(context: CryptoMessageContext): Uint8Array<ArrayBuffer> {
  const contextValues = context && typeof context === 'object'
    ? [context.conversationId, context.messageId, context.senderId, context.senderName, context.timestamp]
    : [];
  if (
    !context ||
    typeof context !== 'object' ||
    contextValues.some((value) => typeof value !== 'string' || value.length === 0) ||
    !Number.isFinite(Date.parse(context.timestamp))
  ) {
    throw new CryptoOperationError('invalid_context');
  }

  // Fixed-order JSON serialization binds message routing metadata to the GCM tag.
  const serialized = JSON.stringify([
    'yahoo-security-messenger',
    ENCRYPTION_VERSION,
    context.conversationId,
    context.messageId,
    context.senderId,
    context.senderName,
    context.timestamp,
    'text',
  ]);
  return new TextEncoder().encode(serialized);
}

function generateUniqueIv(key: CryptoKey, crypto: Crypto): Uint8Array<ArrayBuffer> {
  let usedIvs = usedIvsByKey.get(key);
  if (!usedIvs) {
    usedIvs = new Set<string>();
    usedIvsByKey.set(key, usedIvs);
  }

  for (let attempt = 0; attempt < MAX_IV_GENERATION_ATTEMPTS; attempt += 1) {
    let iv: Uint8Array<ArrayBuffer>;
    try {
      iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    } catch {
      throw new CryptoOperationError('iv_generation_failed');
    }
    const encodedIv = bytesToBase64(iv);
    if (!usedIvs.has(encodedIv)) {
      usedIvs.add(encodedIv);
      return iv;
    }
  }

  throw new CryptoOperationError('iv_generation_failed');
}

/** Generate an ephemeral, non-extractable AES-256-GCM key. */
export async function generateEncryptionKey(): Promise<CryptoKey> {
  const crypto = requireWebCrypto();
  try {
    return await crypto.subtle.generateKey(
      { name: WEB_CRYPTO_ALGORITHM, length: KEY_LENGTH_BITS },
      false,
      ['encrypt', 'decrypt']
    );
  } catch {
    throw new CryptoOperationError('key_generation_failed');
  }
}

/** Encrypt non-empty text and authenticate its conversation/message metadata. */
export async function encryptMessage(
  plaintext: string,
  key: CryptoKey,
  context: CryptoMessageContext
): Promise<EncryptedMessagePayload> {
  const crypto = requireWebCrypto();
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new CryptoOperationError('invalid_plaintext');
  }
  validateKey(key, 'encrypt');
  const additionalData = serializeContext(context);
  try {
    const iv = generateUniqueIv(key, crypto);
    const encrypted = await crypto.subtle.encrypt(
      {
        name: WEB_CRYPTO_ALGORITHM,
        iv,
        additionalData,
        tagLength: AUTHENTICATION_TAG_LENGTH_BITS,
      },
      key,
      new TextEncoder().encode(plaintext)
    );

    return {
      version: ENCRYPTION_VERSION,
      algorithm: ENCRYPTION_ALGORITHM,
      encoding: ENCRYPTION_ENCODING,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    };
  } catch (error) {
    // A nonce stays reserved even if encryption fails; it is never reused with this key.
    if (error instanceof CryptoOperationError) throw error;
    throw new CryptoOperationError('encryption_failed');
  }
}

function validatePayload(payload: unknown): EncryptedMessagePayload {
  if (!payload || typeof payload !== 'object') throw new CryptoOperationError('invalid_payload');
  const candidate = payload as Partial<EncryptedMessagePayload>;
  if (candidate.version !== ENCRYPTION_VERSION) throw new CryptoOperationError('unsupported_version');
  if (candidate.algorithm !== ENCRYPTION_ALGORITHM) throw new CryptoOperationError('unsupported_algorithm');
  if (candidate.encoding !== ENCRYPTION_ENCODING || typeof candidate.iv !== 'string' || typeof candidate.ciphertext !== 'string') {
    throw new CryptoOperationError('invalid_payload');
  }

  const iv = base64ToBytes(candidate.iv);
  if (iv.length !== IV_LENGTH_BYTES) throw new CryptoOperationError('invalid_iv');
  const ciphertext = base64ToBytes(candidate.ciphertext);
  if (ciphertext.length <= AUTHENTICATION_TAG_LENGTH_BYTES) {
    throw new CryptoOperationError('invalid_payload');
  }

  return candidate as EncryptedMessagePayload;
}

/** Validate, authenticate, and decrypt. Plaintext is returned only on success. */
export async function decryptMessage(
  untrustedPayload: unknown,
  key: CryptoKey,
  context: CryptoMessageContext
): Promise<string> {
  const crypto = requireWebCrypto();
  const payload = validatePayload(untrustedPayload);
  validateKey(key, 'decrypt');
  const additionalData = serializeContext(context);
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      {
        name: WEB_CRYPTO_ALGORITHM,
        iv,
        additionalData,
        tagLength: AUTHENTICATION_TAG_LENGTH_BITS,
      },
      key,
      ciphertext
    );
  } catch {
    throw new CryptoOperationError('authentication_failed');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
  } catch {
    throw new CryptoOperationError('invalid_plaintext_encoding');
  }
}
