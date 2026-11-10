import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthProvider';
import { AuthError, type AuthResult, type AuthUser, type LoginInput, type RegisterInput, type RegisterResult } from '../authModel';
import type { AuthService, DemoPersona } from '../authService';

const alice: AuthUser = { id: 'server-alice', username: 'alice', displayName: 'Alice', avatar: 'star', isDemo: false };
const bob: AuthUser = { id: 'server-bob', username: 'bob', displayName: 'Bob', avatar: 'rocket', isDemo: false };
const demoAlice: AuthUser = { ...alice, id: 'demo-alice', isDemo: true };
const loginInput: LoginInput = { identifier: 'alice', password: 'not-a-real-password' };
const registerInput: RegisterInput = { username: 'alice', email: 'alice@example.test', password: 'not-a-real-password' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeService(mode: AuthService['mode'] = 'api') {
  const listeners = new Set<() => void>();
  const user = mode === 'demo' ? demoAlice : alice;
  const service = {
    mode,
    getCurrentUser: jest.fn<Promise<AuthUser | null>, []>().mockResolvedValue(null),
    login: jest.fn<Promise<AuthResult>, [LoginInput]>().mockResolvedValue({ user }),
    register: jest.fn<Promise<RegisterResult>, [RegisterInput]>().mockResolvedValue({ status: 'authenticated', user }),
    logout: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    continueAsDemo: jest.fn<Promise<AuthResult>, [DemoPersona]>().mockResolvedValue({ user: demoAlice }),
    subscribeToInvalidation: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  } satisfies AuthService;
  return { service, listeners, invalidate: () => listeners.forEach((listener) => listener()) };
}

function mount(service: AuthService) {
  return renderHook(useAuth, { wrapper: ({ children }: { children: ReactNode }) => <AuthProvider service={service}>{children}</AuthProvider> });
}

afterEach(() => jest.restoreAllMocks());

describe('AuthProvider identity and session state', () => {
  test('withholds identity while restoring and resolves an absent session explicitly', async () => {
    const { service } = fakeService();
    const pending = deferred<AuthUser | null>();
    service.getCurrentUser.mockReturnValueOnce(pending.promise);
    const { result } = mount(service);
    expect(result.current.status).toBe('initializing');
    expect(result.current.pending).toBe('restore');
    expect(result.current.user).toBeNull();
    await act(async () => { pending.resolve(null); });
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.pending).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test('restores a current API user and updates the same identity without resetting session generation', async () => {
    const { service } = fakeService();
    service.getCurrentUser.mockResolvedValue(alice);
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    const generation = result.current.sessionVersion;
    service.getCurrentUser.mockResolvedValue({ ...alice, displayName: 'Alice Updated' });
    await act(async () => { await result.current.restoreSession(); });
    expect(result.current.user?.displayName).toBe('Alice Updated');
    expect(result.current.sessionVersion).toBe(generation);
    service.getCurrentUser.mockResolvedValue(bob);
    await act(async () => { await result.current.restoreSession(); });
    expect(result.current.user?.id).toBe(bob.id);
    expect(result.current.sessionVersion).toBe(generation + 1);
  });

  test('restoration failure fails closed and maps unknown errors to safe copy', async () => {
    const { service } = fakeService();
    service.getCurrentUser.mockRejectedValue(new Error('private internal token/stack'));
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.user).toBeNull();
    expect(result.current.error?.code).toBe('unavailable');
    expect(result.current.error?.message).not.toContain('private');
    expect(result.current.pending).toBeNull();
  });

  test('an initial confirmed 401 invalidation does not claim an existing session expired', async () => {
    const { service, invalidate } = fakeService();
    service.getCurrentUser.mockImplementationOnce(async () => { invalidate(); return null; });
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBeNull();
  });

  test('stores a detached identity so an adapter response cannot mutate an active actor', async () => {
    const { service } = fakeService();
    const identity = { ...alice };
    service.getCurrentUser.mockResolvedValue(identity);
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    identity.id = 'different-user'; identity.displayName = 'Changed outside provider';
    expect(result.current.user).toEqual(alice);
  });

  test('login establishes identity once, exposes pending state and prevents concurrent mutations', async () => {
    const { service } = fakeService();
    const login = deferred<AuthResult>();
    service.login.mockReturnValueOnce(login.promise);
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    const generation = result.current.sessionVersion;
    let first!: Promise<boolean>;
    act(() => { first = result.current.login(loginInput); });
    expect(result.current.pending).toBe('login');
    await act(async () => {
      expect(await result.current.login(loginInput)).toBe(false);
      expect(await result.current.register(registerInput)).toBeNull();
      expect(await result.current.logout()).toBe(false);
      await result.current.restoreSession();
    });
    expect(service.login).toHaveBeenCalledTimes(1);
    expect(service.register).not.toHaveBeenCalled();
    expect(service.logout).not.toHaveBeenCalled();
    expect(service.getCurrentUser).toHaveBeenCalledTimes(1);
    await act(async () => { login.resolve({ user: alice }); expect(await first).toBe(true); });
    expect(result.current.user).toEqual(alice);
    expect(result.current.status).toBe('authenticated');
    expect(result.current.sessionVersion).toBe(generation + 1);
    expect(result.current.pending).toBeNull();
  });

  test('initial restoration also blocks a premature login', async () => {
    const { service } = fakeService();
    const pending = deferred<AuthUser | null>();
    service.getCurrentUser.mockReturnValueOnce(pending.promise);
    const { result } = mount(service);
    await act(async () => { expect(await result.current.login(loginInput)).toBe(false); });
    expect(service.login).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(null); });
  });

  test('preserves safe invalid-credential errors without authenticating or announcing success', async () => {
    const { service } = fakeService();
    service.login.mockRejectedValue(new AuthError('invalid_credentials'));
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    const generation = result.current.sessionVersion;
    await act(async () => { expect(await result.current.login(loginInput)).toBe(false); });
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.user).toBeNull();
    expect(result.current.sessionVersion).toBe(generation);
    expect(result.current.error?.code).toBe('invalid_credentials');
    act(() => { result.current.clearError(); });
    expect(result.current.error).toBeNull();
  });

  test('registration distinguishes account-created/sign-in-required from an established session', async () => {
    const { service } = fakeService();
    service.register.mockResolvedValueOnce({ status: 'requires-login' });
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    const generation = result.current.sessionVersion;
    await act(async () => { expect(await result.current.register(registerInput)).toEqual({ status: 'requires-login' }); });
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.user).toBeNull();
    expect(result.current.sessionVersion).toBe(generation);
    await act(async () => { expect(await result.current.register(registerInput)).toEqual({ status: 'authenticated', user: alice }); });
    expect(result.current.status).toBe('authenticated');
    expect(result.current.user).toEqual(alice);
    expect(result.current.sessionVersion).toBe(generation + 1);
  });

  test('confirmed logout clears identity only when its promise succeeds', async () => {
    const { service } = fakeService();
    service.getCurrentUser.mockResolvedValue(alice);
    const pending = deferred<void>();
    service.logout.mockReturnValueOnce(pending.promise);
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    const generation = result.current.sessionVersion;
    let operation!: Promise<boolean>;
    act(() => { operation = result.current.logout(); });
    expect(result.current.pending).toBe('logout');
    expect(result.current.user).toEqual(alice);
    expect(result.current.sessionVersion).toBe(generation);
    await act(async () => { pending.resolve(); expect(await operation).toBe(true); });
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.user).toBeNull();
    expect(result.current.sessionVersion).toBe(generation + 1);
    expect(result.current.error).toBeNull();
  });

  test('failed logout preserves user and session generation and reports unconfirmed revocation', async () => {
    const { service } = fakeService();
    service.getCurrentUser.mockResolvedValue(alice);
    service.logout.mockRejectedValue(new Error('private transport stack'));
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    const generation = result.current.sessionVersion;
    await act(async () => { expect(await result.current.logout()).toBe(false); });
    expect(result.current.user).toEqual(alice);
    expect(result.current.status).toBe('authenticated');
    expect(result.current.sessionVersion).toBe(generation);
    expect(result.current.error?.code).toBe('logout_failed');
    expect(result.current.error?.message).toMatch(/server session may still be active/);
    expect(result.current.pending).toBeNull();
  });

  test('API logout invalidation before promise completion still returns confirmed success', async () => {
    const { service, invalidate } = fakeService();
    service.getCurrentUser.mockResolvedValue(alice);
    const pending = deferred<void>();
    service.logout.mockImplementationOnce(async () => { invalidate(); await pending.promise; });
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    let operation!: Promise<boolean>;
    act(() => { operation = result.current.logout(); });
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.user).toBeNull();
    await act(async () => { pending.resolve(); expect(await operation).toBe(true); });
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBeNull();
  });

  test('confirmed expiration clears identity and ignores an older restore still in flight', async () => {
    const { service, invalidate } = fakeService();
    service.getCurrentUser.mockResolvedValueOnce(alice);
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    const generation = result.current.sessionVersion;
    const oldRestore = deferred<AuthUser | null>();
    service.getCurrentUser.mockReturnValueOnce(oldRestore.promise);
    let operation!: Promise<void>;
    act(() => { operation = result.current.restoreSession(); });
    act(() => { invalidate(); });
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.error?.code).toBe('unauthorized');
    expect(result.current.sessionVersion).toBe(generation + 1);
    await act(async () => { oldRestore.resolve(alice); await operation; });
    expect(result.current.user).toBeNull();
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.pending).toBeNull();
  });

  test('a null restored session is expiration only when there was a previous user', async () => {
    const { service } = fakeService();
    service.getCurrentUser.mockResolvedValueOnce(alice).mockResolvedValueOnce(null);
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    await act(async () => { await result.current.restoreSession(); });
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.error?.code).toBe('unauthorized');
  });

  test('service replacement immediately hides the prior actor and ignores its late login', async () => {
    const first = fakeService(), next = fakeService();
    first.service.getCurrentUser.mockResolvedValue(alice);
    const lateLogin = deferred<AuthResult>();
    first.service.login.mockReturnValueOnce(lateLogin.promise);
    const restoreNext = deferred<AuthUser | null>();
    next.service.getCurrentUser.mockReturnValueOnce(restoreNext.promise);
    let selected: AuthService = first.service;
    const observed: { status: string; id: string | null }[] = [];
    const { result, rerender } = renderHook(() => {
      const auth = useAuth(); observed.push({ status: auth.status, id: auth.user?.id ?? null }); return auth;
    }, { wrapper: ({ children }: { children: ReactNode }) => <AuthProvider service={selected}>{children}</AuthProvider> });
    await waitFor(() => expect(result.current.user?.id).toBe(alice.id));
    let login!: Promise<boolean>;
    act(() => { login = result.current.login(loginInput); });
    observed.length = 0;
    selected = next.service;
    rerender();
    expect(result.current.status).toBe('initializing');
    expect(result.current.user).toBeNull();
    expect(observed.every((sample) => sample.id === null)).toBe(true);
    expect(first.listeners.size).toBe(0);
    await act(async () => { restoreNext.resolve(bob); });
    await act(async () => { lateLogin.resolve({ user: alice }); expect(await login).toBe(false); });
    expect(result.current.user).toEqual(bob);
    expect(result.current.status).toBe('authenticated');
  });

  test('service replacement ignores a late restore and unmount removes invalidation subscriptions', async () => {
    const first = fakeService(), next = fakeService();
    const old = deferred<AuthUser | null>();
    first.service.getCurrentUser.mockReturnValueOnce(old.promise);
    next.service.getCurrentUser.mockResolvedValue(bob);
    let selected: AuthService = first.service;
    const { result, rerender, unmount } = renderHook(useAuth, {
      wrapper: ({ children }: { children: ReactNode }) => <AuthProvider service={selected}>{children}</AuthProvider>,
    });
    selected = next.service;
    rerender();
    await waitFor(() => expect(result.current.user?.id).toBe(bob.id));
    await act(async () => { old.resolve(alice); });
    expect(result.current.user).toEqual(bob);
    unmount();
    expect(next.listeners.size).toBe(0);
  });

  test('demo personas use the central identity path and changing actor advances session generation', async () => {
    const { service } = fakeService('demo');
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    await act(async () => { expect(await result.current.continueAsDemo('explorer')).toBe(true); });
    const generation = result.current.sessionVersion;
    service.continueAsDemo.mockResolvedValueOnce({ user: { ...demoAlice, id: 'demo-nova', displayName: 'Nova' } });
    await act(async () => { expect(await result.current.continueAsDemo('nova')).toBe(true); });
    expect(result.current.user?.id).toBe('demo-nova');
    expect(result.current.sessionVersion).toBe(generation + 1);
  });

  test('API adapters cannot introduce demo identity or fall back to demo actions', async () => {
    const { service } = fakeService();
    service.getCurrentUser.mockResolvedValue(demoAlice);
    service.login.mockResolvedValue({ user: demoAlice });
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.error?.code).toBe('invalid_response');
    await act(async () => {
      expect(await result.current.login(loginInput)).toBe(false);
      expect(await result.current.continueAsDemo('explorer')).toBe(false);
    });
    expect(result.current.user).toBeNull();
    expect(service.continueAsDemo).not.toHaveBeenCalled();
  });

  test('production rejects even an injected demo adapter for restoration, login, registration and personas', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    const { service } = fakeService('demo');
    service.getCurrentUser.mockResolvedValue(demoAlice);
    const { result } = mount(service);
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.user).toBeNull();
    await act(async () => {
      expect(await result.current.login(loginInput)).toBe(false);
      expect(await result.current.register(registerInput)).toBeNull();
      expect(await result.current.continueAsDemo('explorer')).toBe(false);
    });
    expect(result.current.user).toBeNull();
    expect(result.current.status).toBe('unauthenticated');
    expect(service.continueAsDemo).not.toHaveBeenCalled();
  });
});
