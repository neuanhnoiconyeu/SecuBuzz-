import { DevelopmentAuthService } from '../developmentAuthService';
import { AuthError } from '../authModel';

afterEach(() => jest.restoreAllMocks());

test('starts signed out, provides explicit personas, returns detached identity and logs out', async () => {
  const service = new DevelopmentAuthService();
  expect(service.mode).toBe('demo');
  expect(await service.getCurrentUser()).toBeNull();
  const { user } = await service.continueAsDemo('explorer');
  expect(user).toEqual({ id: 'local-user', username: 'demo-explorer', displayName: 'Demo Explorer', avatar: 'initials', isDemo: true });
  user.displayName = 'External mutation';
  expect((await service.getCurrentUser())?.displayName).toBe('Demo Explorer');
  expect((await service.continueAsDemo('nova')).user.id).toBe('demo-session-nova');
  await service.logout();
  expect(await service.getCurrentUser()).toBeNull();
  expect(await new DevelopmentAuthService().getCurrentUser()).toBeNull();
});

test('synthetic sign-in discards credentials, never verifies a password, and isolates sessions', async () => {
  const service = new DevelopmentAuthService();
  const first = await service.login({ identifier: 'person@example.test', password: 'not-a-real-secret' });
  const second = await service.login({ identifier: 'person@example.test', password: 'a-different-demo-value' });
  expect(first.user.isDemo).toBe(true);
  expect(first.user.id).toMatch(/^demo-login-/);
  expect(second.user.id).not.toBe(first.user.id);
  expect((await service.getCurrentUser())?.id).toBe(second.user.id);
  expect(JSON.stringify(service)).not.toContain('not-a-real-secret');
  expect(JSON.stringify(service)).not.toContain('a-different-demo-value');
  expect(JSON.stringify(service)).not.toContain('person@example.test');
});

test('temporary registration reuses profile identity without retaining email or password', async () => {
  const service = new DevelopmentAuthService();
  const result = await service.register({ username: 'Demo.Person', email: 'private@example.test', password: 'not-a-real-secret', displayName: ' Demo Person ' });
  expect(result).toEqual({ status: 'authenticated', user: {
    id: 'demo-account-demo.person', username: 'Demo.Person', displayName: 'Demo Person', avatar: 'initials', isDemo: true,
  } });
  expect(JSON.stringify(service)).not.toContain('private@example.test');
  expect(JSON.stringify(service)).not.toContain('not-a-real-secret');
});

test('invalid form data never creates a synthetic session', async () => {
  const service = new DevelopmentAuthService();
  await expect(service.login({ identifier: '', password: '' })).rejects.toMatchObject({ code: 'validation' });
  await expect(service.register({ username: 'a', email: 'invalid', password: '' })).rejects.toMatchObject({ code: 'validation' });
  expect(await service.getCurrentUser()).toBeNull();
});

test('does not persist secrets or write credentials to diagnostic logs', async () => {
  const storage = [jest.spyOn(Storage.prototype, 'setItem'), jest.spyOn(Storage.prototype, 'getItem')];
  const logging = [jest.spyOn(console, 'log'), jest.spyOn(console, 'error'), jest.spyOn(console, 'debug'), jest.spyOn(console, 'warn')];
  const service = new DevelopmentAuthService();
  await service.login({ identifier: 'example', password: 'not-a-real-secret' });
  await service.register({ username: 'example', email: 'private@example.test', password: 'not-a-real-secret' });
  await service.logout();
  for (const spy of [...storage, ...logging]) expect(spy).not.toHaveBeenCalled();
});

test('production cannot construct or operate a development authentication adapter', async () => {
  const service = new DevelopmentAuthService();
  await service.continueAsDemo('explorer');
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
  expect(() => new DevelopmentAuthService()).toThrow(AuthError);
  await expect(service.getCurrentUser()).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.continueAsDemo('explorer')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.login({ identifier: 'example', password: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.register({ username: 'example', email: 'private@example.test', password: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  await expect(service.logout()).rejects.toMatchObject({ code: 'unavailable' });
});
