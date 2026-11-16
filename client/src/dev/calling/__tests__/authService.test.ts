import { createDevelopmentCallingAuthService } from '../authService';
import { createConfiguredAuthService } from '@/auth/authService';

const user = { id: 'call-dev-alice', username: 'alice', displayName: 'Alice', avatar: 'initials', isDemo: false };
const token = (letter: string) => letter.repeat(43);
const response = (value: unknown, status = 200) => ({ ok: status === 200, status, json: async () => value }) as Response;

beforeEach(() => {
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development', NEXT_PUBLIC_DEV_CALLS_ENABLED: 'true',
    NEXT_PUBLIC_AUTH_MODE: 'api', NEXT_PUBLIC_AUTH_API_READY: 'true' });
});
afterEach(() => { document.querySelector('meta[name="secubuzz-csrf-token"]')?.remove(); jest.restoreAllMocks(); });

test('login bootstraps CSRF, preserves the HTTP adapter checks and refreshes the token after cookie rotation', async () => {
  const request = jest.fn().mockResolvedValueOnce(response({ developmentOnly: true, csrfToken: token('a') }))
    .mockResolvedValueOnce(response({ user })).mockResolvedValueOnce(response({ developmentOnly: true, csrfToken: token('b') }));
  const service = createDevelopmentCallingAuthService(request);
  expect(await service.login({ identifier: 'alice', password: 'private-development-password' })).toEqual({ user });
  expect(request.mock.calls.map(call => call[0])).toEqual(['/api/dev-calling/bootstrap', '/api/auth/login', '/api/dev-calling/bootstrap']);
  expect(request.mock.calls[1][1]).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', headers: { 'X-CSRF-Token': token('a') } });
  expect(document.querySelector<HTMLMetaElement>('meta[name="secubuzz-csrf-token"]')?.content).toBe(token('b'));
});

test('restoration bootstraps an existing cookie and logout refreshes CSRF then clears the meta token', async () => {
  const request = jest.fn().mockResolvedValueOnce(response({ developmentOnly: true, csrfToken: token('a') }))
    .mockResolvedValueOnce(response({ user })).mockResolvedValueOnce(response({ developmentOnly: true, csrfToken: token('b') }))
    .mockResolvedValueOnce(response({ success: true }));
  const service = createDevelopmentCallingAuthService(request);
  expect(await service.getCurrentUser()).toEqual(user);
  await service.logout();
  expect(request.mock.calls[3][1].headers['X-CSRF-Token']).toBe(token('b'));
  expect(document.querySelector('meta[name="secubuzz-csrf-token"]')).toBeNull();
});

test.each([response({}, 503), response({ developmentOnly: false, csrfToken: token('a') }), response({ developmentOnly: true, csrfToken: 'invalid' })])(
  'bootstrap failures never submit credentials or retain a stale CSRF token', async badResponse => {
    const request = jest.fn().mockResolvedValue(badResponse);
    const service = createDevelopmentCallingAuthService(request);
    await expect(service.login({ identifier: 'alice', password: 'private-development-password' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(document.querySelector('meta[name="secubuzz-csrf-token"]')).toBeNull();
  });

test('registration is unavailable and production cannot instantiate development adapters', async () => {
  const request = jest.fn();
  await expect(createDevelopmentCallingAuthService(request).register({ username: 'other', email: 'other@example.test', password: 'password' })).rejects.toMatchObject({ code: 'unavailable' });
  expect(request).not.toHaveBeenCalled();
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
  expect(() => createDevelopmentCallingAuthService(request)).toThrow();
  // Production API authentication still uses the original HTTP adapter and never the fixture bootstrap.
  expect(createConfiguredAuthService().constructor.name).toBe('HttpAuthService');
});
