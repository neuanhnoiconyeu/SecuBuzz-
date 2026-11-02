/**
 * E2EE Crypto Utility Module
 * 
 * Provides end-to-end encryption using native browser Web Crypto API
 * Algorithm: AES-256-GCM (Advanced Encryption Standard with Galois/Counter Mode)
 * 
 * Features:
 * - 256-bit symmetric key generation
 * - Message encryption with IV (Initialization Vector)
 * - Message decryption with authentication tag verification
 * - Base64 encoding/decoding for transport
 * - Zero external dependencies (native Web Crypto API only)
 */

/**
 * Cryptographic algorithm configuration
 * GCM mode provides both encryption and authentication
 */
const ALGORITHM = 'AES-GCM' as const;
const KEY_LENGTH = 256; // bits
const IV_LENGTH = 12; // bytes (96 bits) - recommended for GCM
const TAG_LENGTH = 128; // bits - authentication tag length
const ENCODING = 'utf-8' as const;

/**
 * Converts an ArrayBuffer to a Base64 string
 * Used for transport and storage of binary data
 * 
 * @param buffer - The ArrayBuffer to convert
 * @returns Base64 encoded string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a Base64 string to an ArrayBuffer
 * Used for decoding transport data
 * 
 * @param base64 - The Base64 encoded string
 * @returns Decoded ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Generates a cryptographically secure 256-bit AES-GCM encryption key
 * 
 * This key should be:
 * - Stored securely (encrypted LocalStorage or IndexedDB)
 * - Never transmitted unencrypted
 * - Rotated periodically (every 30 days per security spec)
 * 
 * @returns Promise<CryptoKey> - The generated AES-GCM key
 * @throws Error if Web Crypto API is unavailable
 * 
 * @example
 * ```typescript
 * const key = await generateEncryptionKey();
 * // Store key securely (not shown here)
 * ```
 */
export async function generateEncryptionKey(): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'Web Crypto API not available. This feature requires a secure context (HTTPS).'
    );
  }

  try {
    const key = await globalThis.crypto.subtle.generateKey(
      {
        name: ALGORITHM,
        length: KEY_LENGTH,
      },
      true, // extractable (for storage/export if needed)
      ['encrypt', 'decrypt']
    );

    return key;
  } catch (error) {
    throw new Error(`Failed to generate encryption key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Encrypts a plaintext message using AES-256-GCM
 * 
 * Process:
 * 1. Generates a random 96-bit IV
 * 2. Encrypts the message with the IV and key
 * 3. Returns both IV and ciphertext as Base64 strings (IV is needed for decryption)
 * 
 * @param text - The plaintext message to encrypt
 * @param key - The AES-GCM CryptoKey (must be 256-bit)
 * @returns Promise<{ciphertext: string, iv: string}> - Base64 encoded ciphertext and IV
 * @throws Error if encryption fails or invalid inputs
 * 
 * @example
 * ```typescript
 * const key = await generateEncryptionKey();
 * const message = "Hello, Yahoo! Security Messenger";
 * const { ciphertext, iv } = await encryptMessage(message, key);
 * 
 * // Send ciphertext and iv to recipient over the network
 * // (they have the same key via secure key exchange)
 * ```
 */
export async function encryptMessage(
  text: string,
  key: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API not available.');
  }

  if (!text || typeof text !== 'string') {
    throw new Error('Invalid message: text must be a non-empty string.');
  }

  if (!key) {
    throw new Error('Invalid encryption key provided.');
  }

  try {
    // Generate a random IV (Initialization Vector)
    // 96 bits (12 bytes) is the recommended size for GCM
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    // Convert message text to bytes using UTF-8 encoding
    const encoder = new TextEncoder();
    const messageBuffer = encoder.encode(text);

    // Encrypt the message
    // The result includes the authentication tag automatically appended by GCM
    const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
      {
        name: ALGORITHM,
        iv: iv,
        tagLength: TAG_LENGTH,
      },
      key,
      messageBuffer
    );

    // Convert results to Base64 for transport/storage
    const ciphertext = arrayBufferToBase64(encryptedBuffer);
    const ivBase64 = arrayBufferToBase64(iv.buffer);

    return {
      ciphertext,
      iv: ivBase64,
    };
  } catch (error) {
    throw new Error(`Encryption failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Decrypts a message encrypted with encryptMessage()
 * 
 * Process:
 * 1. Decodes Base64 ciphertext and IV back to binary
 * 2. Decrypts using the IV and key
 * 3. GCM mode verifies the authentication tag
 * 4. Returns plaintext message
 * 
 * Security guarantees:
 * - Detects if ciphertext has been tampered with (authentication tag verification)
 * - Verifies message integrity and authenticity
 * - Fails if authentication tag is invalid
 * 
 * @param ciphertext - Base64 encoded encrypted message
 * @param iv - Base64 encoded Initialization Vector (from encryptMessage)
 * @param key - The same AES-GCM CryptoKey used for encryption
 * @returns Promise<string> - The decrypted plaintext message
 * @throws Error if decryption fails or message is tampered with
 * 
 * @example
 * ```typescript
 * const key = await generateEncryptionKey();
 * const message = "Secret message";
 * const { ciphertext, iv } = await encryptMessage(message, key);
 * 
 * // Later, decrypt:
 * const decrypted = await decryptMessage(ciphertext, iv, key);
 * console.log(decrypted); // "Secret message"
 * ```
 */
export async function decryptMessage(
  ciphertext: string,
  iv: string,
  key: CryptoKey
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API not available.');
  }

  if (!ciphertext || typeof ciphertext !== 'string') {
    throw new Error('Invalid ciphertext: must be a non-empty Base64 string.');
  }

  if (!iv || typeof iv !== 'string') {
    throw new Error('Invalid IV: must be a non-empty Base64 string.');
  }

  if (!key) {
    throw new Error('Invalid decryption key provided.');
  }

  try {
    // Decode Base64 back to binary
    const ciphertextBuffer = base64ToArrayBuffer(ciphertext);
    const ivBuffer = base64ToArrayBuffer(iv);

    // Verify IV length
    if (ivBuffer.byteLength !== IV_LENGTH) {
      throw new Error(`Invalid IV length. Expected ${IV_LENGTH} bytes, got ${ivBuffer.byteLength}`);
    }

    // Decrypt the message
    // GCM mode will verify the authentication tag and throw if verification fails
    const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: ALGORITHM,
        iv: ivBuffer,
        tagLength: TAG_LENGTH,
      },
      key,
      ciphertextBuffer
    );

    // Convert decrypted bytes back to UTF-8 string
    const decoder = new TextDecoder(ENCODING);
    const plaintext = decoder.decode(decryptedBuffer);

    return plaintext;
  } catch (error) {
    // Distinguish between authentication failures and other errors
    if (error instanceof Error) {
      if (error.message.includes('authentication')) {
        throw new Error(
          'Message authentication failed. The message may have been tampered with.'
        );
      }
      throw new Error(`Decryption failed: ${error.message}`);
    }
    throw new Error(`Decryption failed: ${String(error)}`);
  }
}

/**
 * Exports a CryptoKey to raw bytes (for storage)
 * Note: Only works if the key was created with extractable: true
 * 
 * @param key - The CryptoKey to export
 * @returns Promise<string> - Base64 encoded key material
 */
export async function exportKey(key: CryptoKey): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API not available.');
  }

  try {
    const exported = await globalThis.crypto.subtle.exportKey('raw', key);
    return arrayBufferToBase64(exported);
  } catch (error) {
    throw new Error(`Failed to export key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Imports raw key bytes back into a CryptoKey
 * 
 * @param keyData - Base64 encoded key material (from exportKey)
 * @returns Promise<CryptoKey> - The imported AES-GCM key
 */
export async function importKey(keyData: string): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API not available.');
  }

  try {
    const buffer = base64ToArrayBuffer(keyData);
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      buffer,
      { name: ALGORITHM },
      true,
      ['encrypt', 'decrypt']
    );
    return key;
  } catch (error) {
    throw new Error(`Failed to import key: ${error instanceof Error ? error.message : String(error)}`);
  }
}
