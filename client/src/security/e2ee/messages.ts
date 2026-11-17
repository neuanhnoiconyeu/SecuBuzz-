import { E2eeError, type EnvelopeV2 } from './model';
import { base64, decode, encode, messageAad, parseEnvelope } from './protocol';
import type { BrowserKeyStore } from './storage';
import { keyMaterialId } from './hpke';

function validKey(key: CryptoKey): void { if (key?.type !== 'secret' || key.extractable || key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256) throw new E2eeError('missing_key'); }
export async function encryptV2(key: CryptoKey, store: BrowserKeyStore, header: Omit<EnvelopeV2, 'encryption'>, keyId: string, text: string): Promise<EnvelopeV2> {
  validKey(key); if (!text.length || encode(text).length > 49136) throw new E2eeError('invalid_message');
  for (let attempt = 0; attempt < 16; attempt++) {
    const iv = crypto.getRandomValues(new Uint8Array(12)), encoded = base64(iv);
    if (!await store.reserveNonce(keyMaterialId(key), encoded)) continue;
    const e: EnvelopeV2 = { ...header, encryption: { version: 2, algorithm: 'AES-256-GCM', encoding: 'base64', keyId, iv: encoded, ciphertext: '' } };
    e.encryption.ciphertext = base64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: messageAad(e), tagLength: 128 }, key, encode(text))));
    return parseEnvelope(e);
  }
  throw new E2eeError('nonce_failed');
}
export async function decryptV2(key: CryptoKey, input: unknown): Promise<string> {
  validKey(key); const e = parseEnvelope(input);
  try {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(e.encryption.iv, 12, false), additionalData: messageAad(e), tagLength: 128 }, key, decode(e.encryption.ciphertext, undefined, false));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw new E2eeError('decryption_failed'); }
}
