'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AuthError, copyAuthUser, type AuthUser, type LoginInput, type RegisterInput, type RegisterResult } from './authModel';
import { createConfiguredAuthService, type AuthService } from './authService';

export type AuthStatus = 'initializing' | 'authenticated' | 'unauthenticated';
export type AuthPendingAction = 'login' | 'register' | 'logout' | 'restore' | 'demo' | null;

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  mode: AuthService['mode'];
  pending: AuthPendingAction;
  error: AuthError | null;
  sessionVersion: number;
  login(input: LoginInput): Promise<boolean>;
  register(input: RegisterInput): Promise<RegisterResult | null>;
  logout(): Promise<boolean>;
  restoreSession(): Promise<void>;
  continueAsDemo(persona: 'explorer' | 'nova'): Promise<boolean>;
  clearError(): void;
}

interface AuthState {
  service: AuthService;
  status: AuthStatus;
  user: AuthUser | null;
  pending: AuthPendingAction;
  error: AuthError | null;
  sessionVersion: number;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** One provider owns identity. It never persists credentials, tokens, or demo sessions. */
export function AuthProvider({ children, service: providedService }: { children: ReactNode; service?: AuthService }) {
  const [configuredService] = useState(createConfiguredAuthService);
  const service = providedService ?? configuredService;
  const [state, setState] = useState<AuthState>(() => ({
    service, status: 'initializing', user: null, pending: 'restore', error: null, sessionVersion: 0,
  }));
  const stateRef = useRef(state);
  const currentService = useRef(service);
  currentService.current = service;
  const mounted = useRef(false);
  const operationSequence = useRef(0);
  const operationLock = useRef(false);

  const commit = useCallback((update: (previous: AuthState) => AuthState) => {
    if (!mounted.current) return;
    const next = update(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const restoreSession = useCallback(async () => {
    if (!mounted.current || operationLock.current) return;
    operationLock.current = true;
    const sequence = ++operationSequence.current;
    const active = () => mounted.current && currentService.current === service && sequence === operationSequence.current;
    commit((previous) => ({ ...previous, pending: 'restore' }));
    try {
      const user = await service.getCurrentUser();
      if (!active()) return;
      if (user && ((service.mode === 'demo') !== user.isDemo || service.mode === 'unconfigured' ||
        (process.env.NODE_ENV === 'production' && service.mode === 'demo'))) throw new AuthError('invalid_response');
      commit((previous) => {
        const changed = previous.user?.id !== user?.id;
        return {
          ...previous, service, user: user ? copyAuthUser(user) : null, status: user ? 'authenticated' : 'unauthenticated',
          sessionVersion: previous.sessionVersion + (changed ? 1 : 0),
          error: !user && previous.user ? new AuthError('unauthorized') : null,
        };
      });
    } catch (failure) {
      if (active()) commit((previous) => ({
        ...previous, service, status: 'unauthenticated', user: null,
        sessionVersion: previous.sessionVersion + (previous.user ? 1 : 0),
        error: failure instanceof AuthError ? failure : new AuthError('unavailable'),
      }));
    } finally {
      if (active()) { operationLock.current = false; commit((previous) => ({ ...previous, pending: null })); }
    }
  }, [commit, service]);

  useEffect(() => {
    mounted.current = true;
    operationLock.current = false;
    commit((previous) => ({ service, status: 'initializing', user: null, error: null,
      pending: 'restore', sessionVersion: previous.sessionVersion + 1 }));
    const unsubscribe = service.subscribeToInvalidation?.(() => {
      if (currentService.current !== service) return;
      if (stateRef.current.pending === 'logout') {
        // A successful API logout can announce invalidation before its promise resolves.
        commit((previous) => ({ ...previous, status: 'unauthenticated', user: null, error: null,
          sessionVersion: previous.sessionVersion + 1 }));
        return;
      }
      operationSequence.current += 1;
      operationLock.current = false;
      commit((previous) => ({ ...previous, status: 'unauthenticated', user: null, pending: null,
        sessionVersion: previous.sessionVersion + (previous.user ? 1 : 0),
        error: previous.user ? new AuthError('unauthorized') : null }));
    });
    void restoreSession();
    return () => {
      mounted.current = false;
      operationSequence.current += 1;
      unsubscribe?.();
    };
  }, [commit, restoreSession, service]);

  useEffect(() => {
    if (state.status !== 'authenticated' || service.mode !== 'api') return;
    const revalidate = () => {
      if (document.visibilityState !== 'hidden') void restoreSession();
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    const timer = window.setInterval(revalidate, 60_000);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
      window.clearInterval(timer);
    };
  }, [restoreSession, service.mode, state.status]);

  const run = useCallback(async <Result,>(
    pending: Exclude<AuthPendingAction, 'restore' | null>, operation: () => Promise<Result>,
    accept: (result: Result) => void,
  ): Promise<Result | null> => {
    if (!mounted.current || operationLock.current) return null;
    operationLock.current = true;
    const sequence = ++operationSequence.current;
    const active = () => mounted.current && currentService.current === service && sequence === operationSequence.current;
    commit((previous) => ({ ...previous, pending, error: null }));
    try {
      const result = await operation();
      if (!active()) return null;
      accept(result);
      return result;
    } catch (failure) {
      if (active()) commit((previous) => ({ ...previous,
        error: pending === 'logout' ? new AuthError('logout_failed') :
          failure instanceof AuthError ? failure : new AuthError('unavailable'),
      }));
      return null;
    } finally {
      if (active()) { operationLock.current = false; commit((previous) => ({ ...previous, pending: null })); }
    }
  }, [commit, service]);

  const acceptUser = useCallback((user: AuthUser) => {
    if ((service.mode === 'demo') !== user.isDemo || service.mode === 'unconfigured' ||
      (process.env.NODE_ENV === 'production' && service.mode === 'demo')) throw new AuthError('invalid_response');
    commit((previous) => ({ ...previous, service, user: copyAuthUser(user), status: 'authenticated', error: null,
      sessionVersion: previous.sessionVersion + 1 }));
  }, [commit, service]);

  const login = useCallback(async (input: LoginInput) => {
    const result = await run('login', () => service.login(input), (response) => acceptUser(response.user));
    return result !== null;
  }, [acceptUser, run, service]);

  const register = useCallback((input: RegisterInput) => run('register', () => service.register(input), (result) => {
    if (result.status === 'authenticated') acceptUser(result.user);
  }), [acceptUser, run, service]);

  const logout = useCallback(async () => {
    const result = await run('logout', () => service.logout(), () => {
      commit((previous) => ({ ...previous, status: 'unauthenticated', user: null, error: null,
        sessionVersion: previous.sessionVersion + 1 }));
    });
    return result !== null;
  }, [commit, run, service]);

  const continueAsDemo = useCallback(async (persona: 'explorer' | 'nova') => {
    if (process.env.NODE_ENV === 'production' || service.mode !== 'demo' || !service.continueAsDemo) return false;
    const result = await run('demo', () => service.continueAsDemo!(persona), (response) => acceptUser(response.user));
    return result !== null;
  }, [acceptUser, run, service]);

  const clearError = useCallback(() => { commit((previous) => ({ ...previous, error: null })); }, [commit]);
  // A replacement service never renders the previous actor while its effect initializes.
  const visible = state.service === service ? state : { ...state, status: 'initializing' as const, user: null, error: null, pending: 'restore' as const };
  const value = useMemo<AuthContextValue>(() => ({
    status: visible.status, user: visible.user, pending: visible.pending, error: visible.error,
    sessionVersion: visible.sessionVersion, mode: service.mode, login, register, logout, restoreSession,
    continueAsDemo, clearError,
  }), [clearError, continueAsDemo, login, logout, register, restoreSession, service.mode, visible.error, visible.pending, visible.sessionVersion, visible.status, visible.user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Authentication must be used inside AuthProvider.');
  return value;
}
