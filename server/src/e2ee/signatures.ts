/**
 * Synchronous ECDSA P-256 / SHA-256 verification of IEEE P1363 (`r‖s`) signatures, the format
 * WebCrypto produces. Synchronous on purpose: DATA must be able to run checks inside one SQLite
 * transaction without awaiting.
 */
import { createHash, verify } from 'node:crypto';
import { decodeBase64Url } from './codec.ts';
import { importP256PublicKey } from './keys.ts';
import { BYTE_LENGTHS } from './protocol.ts';

const MAX_CACHED = 4_096;
/** Only successful verifications are cached; the key is a digest of key, statement and signature. */
const verified = new Set<string>();

function cacheKey(publicKey: string, statement: string, signature: string): string {
  return createHash('sha256').update(publicKey).update('\u0000').update(statement, 'utf8').update('\u0000').update(signature).digest('base64url');
}

/** True only for a valid signature by `publicKey` (encoded P-256 point) over the UTF-8 statement. */
export function verifyStatementSignature(publicKey: string, statement: string, signature: unknown): boolean {
  if (typeof signature !== 'string') return false;
  const bytes = decodeBase64Url(signature, BYTE_LENGTHS.signature);
  const key = importP256PublicKey(publicKey);
  if (!bytes || !key) return false;
  const id = cacheKey(publicKey, statement, signature);
  if (verified.has(id)) return true;
  let valid = false;
  try {
    valid = verify('sha256', Buffer.from(statement, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, bytes);
  } catch {
    valid = false;
  }
  if (valid) {
    if (verified.size >= MAX_CACHED) verified.delete(verified.values().next().value as string);
    verified.add(id);
  }
  return valid;
}
