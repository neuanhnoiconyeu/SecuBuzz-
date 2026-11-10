import { createConfiguredAuthService, UnconfiguredAuthService } from '../authService';

afterEach(() => jest.restoreAllMocks());

test('unconfigured mode leaves auth reachable and rejects all authentication actions', async () => {
  const service = new UnconfiguredAuthService();
  expect(await service.getCurrentUser()).toBeNull();
  await expect(service.login({ identifier: 'person', password: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.register({ username: 'person', email: 'p@example.test', password: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.logout()).rejects.toMatchObject({ code: 'logout_failed' });
});

test.each([
  ['development', undefined, undefined, 'demo'],
  ['development', 'demo', undefined, 'demo'],
  ['production', undefined, undefined, 'unconfigured'],
  ['production', 'demo', undefined, 'unconfigured'],
  ['production', 'api', undefined, 'unconfigured'],
  ['development', 'api', 'false', 'unconfigured'],
  ['production', 'api', 'true', 'api'],
  ['development', 'api', 'true', 'api'],
  ['development', 'unknown-mode', 'true', 'unconfigured'],
])('configuration %s/%s/%s creates %s without silent fallback', (nodeEnv, mode, ready, expected) => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv as NodeJS.ProcessEnv['NODE_ENV'] };
  if (mode === undefined) delete env.NEXT_PUBLIC_AUTH_MODE;
  else env.NEXT_PUBLIC_AUTH_MODE = mode;
  if (ready === undefined) delete env.NEXT_PUBLIC_AUTH_API_READY;
  else env.NEXT_PUBLIC_AUTH_API_READY = ready;
  jest.replaceProperty(process, 'env', env);
  expect(createConfiguredAuthService().mode).toBe(expected);
});
