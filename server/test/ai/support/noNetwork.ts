/**
 * TEST-ONLY network trap, imported first by every AI test file. The global `fetch` refuses any
 * non-loopback URL (for example generativelanguage.googleapis.com) and the file fails at the end
 * if such a request was attempted, so no test or CI run can reach Gemini or spend quota.
 */
import assert from 'node:assert/strict';
import { after } from 'node:test';

if (process.env.NODE_ENV === 'production') throw new Error('AI test support must never be loaded in production.');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const originalFetch = globalThis.fetch;
let blocked: string[] = [];

function targetOf(input: string | URL | Request): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const target = targetOf(input);
  if (!LOOPBACK_HOSTS.has(target.hostname)) {
    blocked.push(target.origin);
    return Promise.reject(new TypeError('Network access outside loopback is blocked in AI tests.'));
  }
  return originalFetch(input, init);
}) as typeof fetch;

/** Returns and clears blocked attempts, for the one test that proves the trap works. */
export function takeBlockedRequests(): string[] {
  const taken = blocked;
  blocked = [];
  return taken;
}

after(() => {
  globalThis.fetch = originalFetch;
  assert.deepEqual(blocked, [], 'An AI test attempted a non-loopback network request.');
});
