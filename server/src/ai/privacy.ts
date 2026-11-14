/**
 * Privacy rules for the Gemini free tier, where Google may use submitted text and responses to
 * improve its products and human reviewers may read them.
 *
 * - Messenger content: every request carrying `conversationId` (selected messages and drafts) is
 *   refused. Client flags such as `isDemo` are never trusted; the server has no way to verify them.
 * - Credentials: common secret formats are refused as a safety net for accidental pastes. This is
 *   not a data-loss-prevention system; private text typed into AI Hub cannot be detected.
 */
import type { AiGenerationRequest } from './validation.ts';

export type PrivacyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'messenger_context' | 'credential' };

/** Bounded quantifiers only, so matching stays linear on the 8,000-character input. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /\bAIza[0-9A-Za-z_-]{35}/u,
  /\bAQ\.Ab[0-9A-Za-z_.-]{20,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}/u,
  /\bgithub_pat_[0-9A-Za-z_]{30,}/u,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/u,
  /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/u,
  /\bsk-[0-9A-Za-z_-]{20,}/u,
  /\b(?:Bearer|Basic)\s{1,8}[A-Za-z0-9._~+/-]{16,}={0,2}/iu,
  /\b(?:password|passwd|pwd|passphrase)\s{0,8}=\s{0,8}["']?[^\s"']{3,}/iu,
  /\b(?:password|passwd|pwd|passphrase)\s{0,8}:\s{0,8}["']?(?=[^\s"']{0,128}[0-9!@#$%^&*_+=?~])[^\s"']{6,}/iu,
  /\bsecubuzz_session\s{0,8}=/iu,
];

/** Both parts must appear: an AES-256-GCM message envelope or a private JSON Web Key. */
const COMPOUND_PATTERNS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/"algorithm"\s{0,8}:\s{0,8}"AES-256-GCM"/iu, /"ciphertext"\s{0,8}:/u],
  [/"kty"\s{0,8}:/u, /"d"\s{0,8}:\s{0,8}"[A-Za-z0-9_-]{16,}"/u],
];

export function containsCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)) ||
    COMPOUND_PATTERNS.some(([first, second]) => first.test(text) && second.test(text));
}

export function assessPrivacy(request: AiGenerationRequest): PrivacyDecision {
  if (request.conversationId !== undefined) return { allowed: false, reason: 'messenger_context' };
  if (containsCredential(request.input)) return { allowed: false, reason: 'credential' };
  return { allowed: true };
}
