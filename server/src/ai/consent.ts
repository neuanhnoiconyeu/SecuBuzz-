/**
 * Server-enforced consent for sending text to the Gemini free tier.
 *
 * `POST /api/ai/consent` issues a token for one authenticated session, one payload digest and the
 * current disclosure version. The token expires after 60 seconds and its nonce is consumed once
 * through the usage store, so it cannot be replayed, moved to another session or reused for
 * different text. The client computes the same digest (`client/src/ai/remoteAIProvider.ts`).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hasOnlyKeys, isPlainObject } from '../realtime/validation.ts';
import type { AiGenerationRequest } from './validation.ts';

/** Changing the text requires a new version; older clients then receive AI_CONSENT_REQUIRED. */
export const AI_DISCLOSURE = Object.freeze({
  version: 'gemini-free-tier-2026-11-v1',
  text: 'This request sends the submitted text to Google Gemini for processing. Free-tier data may be used by Google ' +
    'to improve its products, and human reviewers may read it. Do not submit private messages, passwords, or confidential information.',
});

export const CONSENT_TTL_SECONDS = 60;
const MAX_FUTURE_SKEW_SECONDS = 5;
const DIGEST_DOMAIN = 'secubuzz-ai-consent-v1';
const TOKEN_DOMAIN = 'secubuzz-ai-consent-v1.';
const SESSION_DOMAIN = 'secubuzz-ai-session-v1.';
const TOKEN = /^v1\.([A-Za-z0-9_-]{16,1024})\.([A-Za-z0-9_-]{43})$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/** HMAC-SHA256 under the consent secret (implemented by `AiConfig.consentMac`). */
export interface ConsentSigner {
  consentMac(data: string): Buffer;
}

/** base64url(SHA-256(UTF-8(JSON array))) over the raw request strings, without normalization. */
export function computePayloadDigest(request: AiGenerationRequest): string {
  const canonical = JSON.stringify([
    DIGEST_DOMAIN,
    request.task,
    request.input,
    request.tone ?? null,
    request.targetLanguage ?? null,
    request.conversationId ?? null,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function sessionBinding(signer: ConsentSigner, sessionId: string): string {
  return signer.consentMac(`${SESSION_DOMAIN}${sessionId}`).toString('base64url');
}

function sameText(first: string, second: string): boolean {
  const left = Buffer.from(first, 'utf8');
  const right = Buffer.from(second, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface IssuedConsent {
  readonly token: string;
  readonly expiresAtMs: number;
}

export function issueConsentToken(signer: ConsentSigner, input: {
  readonly sessionId: string;
  readonly payloadDigest: string;
  readonly nowMs: number;
  readonly nonce?: string;
}): IssuedConsent {
  if (!DIGEST.test(input.payloadDigest)) throw new Error('Invalid payload digest.');
  const iat = Math.floor(input.nowMs / 1000);
  const exp = iat + CONSENT_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    sid: sessionBinding(signer, input.sessionId),
    dig: input.payloadDigest,
    dv: AI_DISCLOSURE.version,
    iat,
    exp,
    n: input.nonce ?? randomBytes(16).toString('base64url'),
  }), 'utf8').toString('base64url');
  const mac = signer.consentMac(`${TOKEN_DOMAIN}${payload}`).toString('base64url');
  return { token: `v1.${payload}.${mac}`, expiresAtMs: exp * 1000 };
}

export type ConsentVerification =
  | { readonly ok: true; readonly nonce: string; readonly expiresAtMs: number }
  | { readonly ok: false; readonly reason: string };

function rejected(reason: string): ConsentVerification {
  return { ok: false, reason };
}

/** Stateless checks only. The caller must then consume the nonce in the usage store. */
export function verifyConsentToken(signer: ConsentSigner, token: string, expected: {
  readonly sessionId: string;
  readonly payloadDigest: string;
  readonly nowMs: number;
}): ConsentVerification {
  const parts = TOKEN.exec(token);
  if (!parts) return rejected('consent_format');
  const [, payloadText, macText] = parts as unknown as [string, string, string];
  // Compare canonical encodings so a token has exactly one valid spelling.
  const expectedMac = signer.consentMac(`${TOKEN_DOMAIN}${payloadText}`).toString('base64url');
  if (!sameText(macText, expectedMac)) return rejected('consent_signature');

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8'));
  } catch {
    return rejected('consent_payload');
  }
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, ['v', 'sid', 'dig', 'dv', 'iat', 'exp', 'n']) || payload.v !== 1 ||
    typeof payload.sid !== 'string' || typeof payload.dig !== 'string' || typeof payload.dv !== 'string' ||
    !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || typeof payload.n !== 'string' || !NONCE.test(payload.n)) {
    return rejected('consent_payload');
  }
  if (payload.dv !== AI_DISCLOSURE.version) return rejected('consent_disclosure');
  if (!sameText(payload.sid, sessionBinding(signer, expected.sessionId))) return rejected('consent_session');
  if (!sameText(payload.dig, expected.payloadDigest)) return rejected('consent_payload_mismatch');
  const now = Math.floor(expected.nowMs / 1000);
  const iat = payload.iat as number;
  const exp = payload.exp as number;
  if (exp - iat > CONSENT_TTL_SECONDS || exp <= iat || iat > now + MAX_FUTURE_SKEW_SECONDS) return rejected('consent_time');
  if (exp <= now) return rejected('consent_expired');
  return { ok: true, nonce: payload.n, expiresAtMs: exp * 1000 };
}
