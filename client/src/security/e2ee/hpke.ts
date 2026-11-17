import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { E2eeError } from './model';
import { base64url, decode, importPoint } from './protocol';

// RFC 9180 mode_base, KEM 0x0010, KDF 0x0001, AEAD 0x0002; single shot/sequence 0.
const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const materialIds = new WeakMap<CryptoKey, string>();
/** Local nonce bookkeeping only. Not an encryption key or network field. */
export function keyMaterialId(key: CryptoKey): string { const id = materialIds.get(key); if (!id) throw new E2eeError('missing_key'); return id; }
export async function sealKey(publicKey: string, raw: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>): Promise<{ enc: string; ciphertext: string }> {
  try { const sealed = await suite.seal({ recipientPublicKey: await importPoint(publicKey, false), info }, raw);
    return { enc: base64url(new Uint8Array(sealed.enc)), ciphertext: base64url(new Uint8Array(sealed.ct)) }; }
  catch { throw new E2eeError('invalid_proof'); }
}
export async function openKey(pair: CryptoKeyPair, enc: string, ciphertext: string, info: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    // Providing BOTH keys prevents the library from attempting to export the private key.
    raw = new Uint8Array(await suite.open({ recipientKey: pair, enc: decode(enc, 65), info }, decode(ciphertext, 48)));
    if (raw.length !== 32) throw new Error();
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    materialIds.set(key, base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))); return key;
  } catch { throw new E2eeError('invalid_proof'); } finally { raw?.fill(0); }
}
