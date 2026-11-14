/**
 * Extracts the session cookie from a handshake `Cookie` header.
 *
 * Only the configured cookie is returned; other cookies never reach the session resolver.
 * Duplicate occurrences are rejected because a sibling subdomain or path can plant a second
 * cookie with the same name (cookie tossing), and picking one would be a guess.
 */

export const MAX_COOKIE_HEADER_LENGTH = 16_384;
export const MAX_SESSION_COOKIE_LENGTH = 4_096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
/** RFC 6265 cookie-name token characters. */
export const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;

export type CookieExtraction =
  | { readonly status: 'present'; readonly value: string }
  | { readonly status: 'absent' }
  | { readonly status: 'malformed' };

export function extractSessionCookie(header: unknown, name: string): CookieExtraction {
  if (header === undefined || header === '') return { status: 'absent' };
  if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER_LENGTH) return { status: 'malformed' };
  let found: string | undefined;
  let occurrences = 0;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue;
    occurrences += 1;
    let raw = part.slice(separator + 1).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    found = raw;
  }
  if (occurrences > 1) return { status: 'malformed' };
  if (found === undefined || found === '') return { status: 'absent' };
  let value = found;
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return { status: 'malformed' };
    }
  }
  if (value.length === 0 || value.length > MAX_SESSION_COOKIE_LENGTH || CONTROL_CHARACTERS.test(value)) {
    return { status: 'malformed' };
  }
  return { status: 'present', value };
}
