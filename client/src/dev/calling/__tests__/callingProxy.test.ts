import { callingRewrites } from '../../../../dev/callingProxy.cjs';

test('proxy is opt-in and refuses production or external upstreams', () => {
  expect(callingRewrites({ NODE_ENV: 'production' })).toEqual([]);
  for (const change of [{ NODE_ENV: 'production' }, { DEV_CALLS_BACKEND_URL: 'https://example.com' },
    { DEV_CALLS_BACKEND_URL: 'http://user:password@127.0.0.1:5101' }, { DEV_CALLS_BACKEND_URL: 'http://127.0.0.1:5101/path' }]) {
    expect(() => callingRewrites({ NODE_ENV: 'development', SECUBUZZ_DEV_CALLS_PROXY: 'true', ...change })).toThrow();
  }
});

test('only development auth, context, call tokens and Socket.IO are routed to loopback', () => {
  const rules = callingRewrites({ NODE_ENV: 'development', SECUBUZZ_DEV_CALLS_PROXY: 'true' });
  expect(rules.map((rule: { source: string }) => rule.source)).toEqual([
    '/api/auth/login', '/api/auth/me', '/api/auth/logout', '/api/dev-calling/:path*', '/api/calls/token', '/socket.io',
  ]);
  expect(rules.every((rule: { destination: string }) => rule.destination.startsWith('http://127.0.0.1:5101/'))).toBe(true);
});
