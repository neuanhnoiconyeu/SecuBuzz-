type Route = { source: string; destination: string };
function load(overrides: Record<string, string>) {
  jest.resetModules();
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development', AUTH_BACKEND_URL: 'http://127.0.0.1:5100',
    NEXT_PUBLIC_AUTH_API_BASE_PATH: '/api/auth', SECUBUZZ_DEV_CALLS_PROXY: 'false', ...overrides });
  return jest.requireActual('../../../next.config.js');
}
afterEach(() => jest.restoreAllMocks());

test('normal routing retains DATA cookie/CSRF, encrypted persistence and Socket.IO destinations', async () => {
  const config = load({});
  const routes: Route[] = await config.rewrites();
  for (const source of ['/api/auth/csrf', '/api/auth/login', '/api/auth/logout', '/api/keys/devices',
    '/api/conversations/:id/messages', '/api/friends/requests']) {
    expect(routes).toContainEqual({ source, destination: 'http://127.0.0.1:5100' + source });
  }
  expect(routes).toContainEqual({ source: '/socket.io', destination: 'http://127.0.0.1:5100/socket.io/' });
  const headers = (await config.headers())[0].headers;
  expect(headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value).toContain("object-src 'none'");
  expect(config.typescript.tsconfigPath).toBe('./tsconfig.json');
});

test('explicit local calling overrides only its own paths while retaining DATA routes', async () => {
  const config = load({ SECUBUZZ_DEV_CALLS_PROXY: 'true', DEV_CALLS_BACKEND_URL: 'http://127.0.0.1:5101' });
  const routes = await config.rewrites();
  expect(routes.beforeFiles).toContainEqual({ source: '/api/auth/login', destination: 'http://127.0.0.1:5101/api/auth/login' });
  expect(routes.beforeFiles).toContainEqual({ source: '/socket.io', destination: 'http://127.0.0.1:5101/socket.io/' });
  expect(routes.afterFiles.some((r: Route) => ['/api/auth/login', '/socket.io'].includes(r.source))).toBe(false);
  expect(routes.afterFiles).toContainEqual({ source: '/api/conversations/:id/messages', destination: 'http://127.0.0.1:5100/api/conversations/:id/messages' });
  expect(config.skipTrailingSlashRedirect).toBe(true);
});

test('calling proxy still rejects production activation and non-loopback destinations', () => {
  expect(() => load({ NODE_ENV: 'production', SECUBUZZ_DEV_CALLS_PROXY: 'true' })).toThrow('Calling proxy requires next dev');
  expect(() => load({ SECUBUZZ_DEV_CALLS_PROXY: 'true', DEV_CALLS_BACKEND_URL: 'http://remote.example.test' })).toThrow();
});
