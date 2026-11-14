import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSessionCookie, MAX_COOKIE_HEADER_LENGTH, MAX_SESSION_COOKIE_LENGTH } from '../../src/realtime/cookies.ts';

const NAME = 'secubuzz_session';

test('returns only the configured cookie value', () => {
  assert.deepEqual(extractSessionCookie(`theme=dark; ${NAME}=abc123; other=1`, NAME), { status: 'present', value: 'abc123' });
  assert.deepEqual(extractSessionCookie(`${NAME}="quoted-value"`, NAME), { status: 'present', value: 'quoted-value' });
});

test('decodes percent-encoded values such as signed session cookies', () => {
  assert.deepEqual(extractSessionCookie(`${NAME}=s%3Aabc.def`, NAME), { status: 'present', value: 's:abc.def' });
});

test('treats a missing header, missing cookie or empty value as absent', () => {
  for (const header of [undefined, '', 'theme=dark', `${NAME}=`, `${NAME}=""`, `x${NAME}=abc`, `${NAME}x=abc`]) {
    assert.deepEqual(extractSessionCookie(header, NAME), { status: 'absent' }, String(header));
  }
});

test('rejects duplicate session cookies instead of guessing', () => {
  assert.deepEqual(extractSessionCookie(`${NAME}=a; ${NAME}=b`, NAME), { status: 'malformed' });
  assert.deepEqual(extractSessionCookie(`${NAME}=a; ${NAME}=a`, NAME), { status: 'malformed' });
});

test('rejects malformed encoding, control characters, oversize values and non-string headers', () => {
  assert.deepEqual(extractSessionCookie(`${NAME}=%E0%A4%A`, NAME), { status: 'malformed' });
  assert.deepEqual(extractSessionCookie(`${NAME}=a%00b`, NAME), { status: 'malformed' });
  assert.deepEqual(extractSessionCookie(`${NAME}=${'a'.repeat(MAX_SESSION_COOKIE_LENGTH + 1)}`, NAME), { status: 'malformed' });
  assert.deepEqual(extractSessionCookie(`x=${'a'.repeat(MAX_COOKIE_HEADER_LENGTH)}`, NAME), { status: 'malformed' });
  assert.deepEqual(extractSessionCookie(['a', 'b'], NAME), { status: 'malformed' });
});

test('ignores unrelated malformed cookie pairs', () => {
  assert.deepEqual(extractSessionCookie(`junk; =nameless; ${NAME}=ok`, NAME), { status: 'present', value: 'ok' });
});
