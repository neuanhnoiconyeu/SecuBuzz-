/**
 * Canonical encodings shared by every statement, identifier and digest in the key protocol.
 * A value has exactly one valid spelling, so signatures and IDs cannot be re-encoded.
 */
import { createHash } from 'node:crypto';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Unpadded base64url length of `bytes` bytes. */
export function base64UrlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/** Decodes canonical, unpadded base64url of exactly `bytes` bytes; `null` otherwise. */
export function decodeBase64Url(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length !== base64UrlLength(bytes) || !BASE64URL.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value ? decoded : null;
}

export function isBase64Url(value: unknown, bytes: number): value is string {
  return decodeBase64Url(value, bytes) !== null;
}

/** `YYYY-MM-DDTHH:mm:ss.sssZ` that round-trips through `Date#toISOString`. */
export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function isFresh(timestamp: string, nowMs: number, maxSkewMs: number): boolean {
  return Math.abs(Date.parse(timestamp) - nowMs) <= maxSkewMs;
}

export type CanonicalItem = string | number | null | readonly CanonicalItem[];

function assertCanonical(item: CanonicalItem): void {
  if (item === null || typeof item === 'string') return;
  if (typeof item === 'number') {
    if (!Number.isSafeInteger(item)) throw new TypeError('Canonical numbers must be safe integers.');
    return;
  }
  if (!Array.isArray(item)) throw new TypeError('Canonical items must be strings, integers, null or arrays.');
  for (const nested of item) assertCanonical(nested);
}

/**
 * `JSON.stringify` of a fixed-order array: the method used by the existing AES-GCM AAD and
 * envelope fingerprint. Arrays avoid any object-key ordering ambiguity.
 */
export function canonicalJson(items: readonly CanonicalItem[]): string {
  assertCanonical(items);
  return JSON.stringify(items);
}

export function sha256Base64Url(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64url');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
