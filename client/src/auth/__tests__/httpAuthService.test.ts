import { HttpAuthService } from '../httpAuthService';
import type { AuthUser } from '../authModel';

const user: AuthUser = { id: 'server-user-1', username: 'person', displayName: 'Person', avatar: 'star', isDemo: false };
const login = { identifier: ' person ', password: '  keep spaces  ' };
const register = { username: 'person', email: 'person@example.test', password: '  keep spaces  ' };

function response(status: number, body?: unknown): Response {
  return { status, json: jest.fn().mockResolvedValue(body) } as unknown as Response;
}

function adapter(...responses: Response[]) {
  const request = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  for (const next of responses) request.mockResolvedValueOnce(next);
  const service = new HttpAuthService({ fetch: request as unknown as typeof fetch, getCsrfToken: () => 'test-csrf-token' });
  return { service, request };
}

afterEach(() => jest.restoreAllMocks());

test('login uses same-origin credentialed no-store requests with CSRF, exact password and identity allowlisting', async () => {
  const { service, request } = adapter(response(200, { user: { ...user, accessToken: 'never-forward', email: 'private@example.test' } }));
  expect(await service.login(login)).toEqual({ user });
  expect(request).toHaveBeenCalledWith('/api/auth/login', {
    method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
    body: JSON.stringify({ identifier: 'person', password: login.password }), signal: expect.any(AbortSignal),
  });
});

test.each([null, '', ' ', '\r\ninvalid'])('missing/invalid CSRF token fails closed without sending credentials: %s', async (token) => {
  const request = jest.fn();
  const service = new HttpAuthService({ fetch: request, getCsrfToken: () => token });
  await expect(service.login(login)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.register(register)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.logout()).rejects.toMatchObject({ code: 'unavailable' });
  expect(request).not.toHaveBeenCalled();
});

test('CSRF bootstrap failure never sends a mutation', async () => {
  const request = jest.fn();
  const service = new HttpAuthService({ fetch: request, getCsrfToken: () => { throw new Error('private bootstrap details'); } });
  await expect(service.login(login)).rejects.toMatchObject({ code: 'unavailable' });
  expect(request).not.toHaveBeenCalled();
});

test.each(['https://untrusted.example/auth', '//untrusted.example/auth', '/api/../auth', '/api/auth?next=other', '/api\\auth'])('rejects unsafe endpoint configuration: %s', (endpoint) => {
  expect(() => new HttpAuthService({ endpoints: { login: endpoint }, getCsrfToken: () => 'x' })).toThrow();
});

test('restores only a validated server identity and treats confirmed absence as signed out', async () => {
  const { service, request } = adapter(response(200, { user }), response(200, { user: null }), response(401));
  expect(await service.getCurrentUser()).toEqual(user);
  expect(await service.getCurrentUser()).toBeNull();
  expect(await service.getCurrentUser()).toBeNull();
  expect(request.mock.calls[0]?.[1]).toEqual({ method: 'GET', credentials: 'same-origin', mode: 'same-origin',
    redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) });
});

test.each([
  { ...user, id: '' }, { ...user, username: '' }, { ...user, displayName: ' ' },
  { ...user, avatar: 'remote-unknown-avatar' }, { ...user, isDemo: true }, { ...user, id: 'local-user' },
  { ...user, id: 'demo-session-nova' }, { ...user, displayName: 'bad\nname' }, null,
])('rejects malformed or demo identities returned by APIs', async (invalidUser) => {
  const { service } = adapter(response(200, { user: invalidUser }));
  await expect(service.login(login)).rejects.toMatchObject({ code: 'invalid_response' });
});

test('registration explicitly supports both authenticated and requires-login contracts', async () => {
  const { service } = adapter(response(201, { status: 'authenticated', user }), response(200, { status: 'requires-login' }));
  expect(await service.register(register)).toEqual({ status: 'authenticated', user });
  expect(await service.register(register)).toEqual({ status: 'requires-login' });
});

test('registration never assumes session establishment from an unspecified success shape', async () => {
  const { service } = adapter(response(201, { user }), response(200, { status: 'authenticated', user: null }));
  await expect(service.register(register)).rejects.toMatchObject({ code: 'invalid_response' });
  await expect(service.register(register)).rejects.toMatchObject({ code: 'invalid_response' });
});

test('invalid credentials and account conflicts use generic messages without echoing server bodies', async () => {
  const { service } = adapter(response(401, { message: 'This email exists; private secret' }), response(409, { message: 'username person exists' }));
  await expect(service.login(login)).rejects.toMatchObject({ code: 'invalid_credentials', message: 'Sign-in failed. Check your credentials and try again.' });
  await expect(service.register(register)).rejects.toMatchObject({ code: 'account_unavailable', message: 'An account could not be created with these details. Try different details or sign in.' });
});

test('backend validation maps only known field names to fixed text', async () => {
  const { service } = adapter(response(422, { fields: ['email', 'password', 'private-token'], message: 'sensitive raw details' }));
  await expect(service.register(register)).rejects.toMatchObject({ code: 'validation', fieldErrors: {
    email: 'Check your email.', password: 'Check your password.',
  } });
});

test('network and backend failures never manufacture identities or switch to a demo adapter', async () => {
  const { service, request } = adapter(response(503, { user }));
  await expect(service.login(login)).rejects.toMatchObject({ code: 'unavailable' });
  request.mockRejectedValueOnce(new Error('private network stack'));
  await expect(service.login(login)).rejects.toMatchObject({ code: 'network' });
  expect(service.mode).toBe('api');
  expect(service).not.toHaveProperty('continueAsDemo');
});

test('malformed/non-JSON responses fail closed', async () => {
  const malformed = { status: 200, json: jest.fn().mockRejectedValue(new Error('sensitive parser data')) } as unknown as Response;
  const { service } = adapter(malformed, response(200, []));
  await expect(service.login(login)).rejects.toMatchObject({ code: 'invalid_response' });
  await expect(service.getCurrentUser()).rejects.toMatchObject({ code: 'invalid_response' });
});

test('logout only confirms explicit success or an already-absent session', async () => {
  const { service } = adapter(response(204), response(200, { success: true }), response(401), response(200, { success: false }), response(500));
  await expect(service.logout()).resolves.toBeUndefined();
  await expect(service.logout()).resolves.toBeUndefined();
  await expect(service.logout()).resolves.toBeUndefined();
  await expect(service.logout()).rejects.toMatchObject({ code: 'logout_failed' });
  await expect(service.logout()).rejects.toMatchObject({ code: 'logout_failed' });
});

test('session invalidation notifies subscribers safely and does not treat wrong login credentials as expiry', async () => {
  const { service } = adapter(response(401), response(401), response(204), response(401));
  service.subscribeToInvalidation(() => { throw new Error('subscriber failure'); });
  const listener = jest.fn();
  const unsubscribe = service.subscribeToInvalidation(listener);
  await expect(service.login(login)).rejects.toMatchObject({ code: 'invalid_credentials' });
  expect(listener).not.toHaveBeenCalled();
  expect(await service.getCurrentUser()).toBeNull();
  expect(listener).toHaveBeenCalledTimes(1);
  await service.logout();
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  expect(await service.getCurrentUser()).toBeNull();
  expect(listener).toHaveBeenCalledTimes(2);
});

test('invalid inputs never enter transport and no storage or credential logs are used', async () => {
  const { service, request } = adapter();
  const spies = [jest.spyOn(Storage.prototype, 'setItem'), jest.spyOn(console, 'error'), jest.spyOn(console, 'log'), jest.spyOn(console, 'debug')];
  await expect(service.login({ identifier: '', password: '' })).rejects.toMatchObject({ code: 'validation' });
  await expect(service.register({ username: '', email: '', password: '' })).rejects.toMatchObject({ code: 'validation' });
  expect(request).not.toHaveBeenCalled();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test('bounds slow fetches and body parsing to 15 seconds without retrying or confirming a late logout', async () => {
  jest.useFakeTimers();
  try {
    const request = jest.fn().mockImplementation(() => new Promise(() => undefined));
    const service = new HttpAuthService({ fetch: request, getCsrfToken: () => 'test-csrf' });
    const loginAttempt = service.login(login);
    const rejectedLogin = expect(loginAttempt).rejects.toMatchObject({ code: 'network' });
    await Promise.resolve();
    jest.advanceTimersByTime(15_000);
    await rejectedLogin;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.signal.aborted).toBe(true);

    let finishBody!: (value: unknown) => void;
    const slowBody = new Promise((resolve) => { finishBody = resolve; });
    const bodyRequest = jest.fn().mockResolvedValue({ status: 200, json: () => slowBody });
    const bodyService = new HttpAuthService({ fetch: bodyRequest, getCsrfToken: () => 'test-csrf' });
    const invalidated = jest.fn();
    bodyService.subscribeToInvalidation(invalidated);
    const logoutAttempt = bodyService.logout();
    const rejectedLogout = expect(logoutAttempt).rejects.toMatchObject({ code: 'network' });
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(15_000);
    await rejectedLogout;
    finishBody({ success: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidated).not.toHaveBeenCalled();
    expect(bodyRequest).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
