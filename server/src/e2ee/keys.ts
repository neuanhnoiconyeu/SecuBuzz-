/**
 * P-256 public keys as uncompressed points (`04‖X‖Y`, 65 bytes, base64url). This is the format of
 * WebCrypto `exportKey('raw', publicKey)` for EC keys and of the HPKE DHKEM(P-256) `enc` value.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { canonicalJson, decodeBase64Url, sha256Base64Url } from './codec.ts';
import { BYTE_LENGTHS, LABELS } from './protocol.ts';

/** Field prime of P-256. Coordinates must be reduced modulo p. */
const P256_PRIME = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const MAX_CACHED_KEYS = 4_096;
const cache = new Map<string, KeyObject>();

function belowPrime(coordinate: Buffer): boolean {
  return BigInt(`0x${coordinate.toString('hex')}`) < P256_PRIME;
}

/**
 * Validates an encoded P-256 public key and returns a `KeyObject`, or `null` when the value is
 * not canonical base64url, not uncompressed, has unreduced coordinates or is not on the curve.
 */
export function importP256PublicKey(encoded: unknown): KeyObject | null {
  if (typeof encoded !== 'string') return null;
  const cached = cache.get(encoded);
  if (cached) return cached;
  const raw = decodeBase64Url(encoded, BYTE_LENGTHS.publicKey);
  if (!raw || raw[0] !== 0x04) return null;
  const x = raw.subarray(1, 33);
  const y = raw.subarray(33, 65);
  if (!belowPrime(x) || !belowPrime(y)) return null;
  let key: KeyObject;
  try {
    // JWK import rejects points that are not on the curve (ERR_CRYPTO_INVALID_JWK).
    key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' });
  } catch {
    return null;
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
  if (cache.size >= MAX_CACHED_KEYS) cache.delete(cache.keys().next().value as string);
  cache.set(encoded, key);
  return key;
}

export function isP256PublicKey(encoded: unknown): encoded is string {
  return importP256PublicKey(encoded) !== null;
}

/** Content-addressed device key identifier: base64url SHA-256 over both public keys. */
export function deviceKeyIdFor(agreementPublicKey: string, signingPublicKey: string): string {
  return sha256Base64Url(canonicalJson([LABELS.deviceKeyId, 1, agreementPublicKey, signingPublicKey]));
}
