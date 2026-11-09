import { DEMO_USER_ID, PROFILE_AVATARS } from '@/profiles/profileModel';
import { AUTH_FIELDS, AuthError, validateLogin, validateRegistration, type AuthField, type AuthResult, type AuthUser, type LoginInput, type RegisterInput, type RegisterResult } from './authModel';
import type { AuthService } from './authService';

export interface AuthEndpoints { login: string; register: string; logout: string; me: string }
export interface HttpAuthServiceOptions {
  endpoints?: Partial<AuthEndpoints>;
  getCsrfToken: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

export const PROPOSED_AUTH_ENDPOINTS: Readonly<AuthEndpoints> = {
  login: '/api/auth/login', register: '/api/auth/register', logout: '/api/auth/logout', me: '/api/auth/me',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function authUser(value: unknown): AuthUser {
  if (!isRecord(value) || value.isDemo !== false ||
    !['id', 'username', 'displayName'].every((key) => typeof value[key] === 'string' &&
      (value[key] as string).trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value[key] as string)) ||
    !PROFILE_AVATARS.some((avatar) => avatar.id === value.avatar) ||
    value.id === DEMO_USER_ID || /^demo[-_:]/i.test(value.id as string)) {
    throw new AuthError('invalid_response');
  }
  return { id: value.id as string, username: value.username as string, displayName: value.displayName as string,
    avatar: value.avatar as AuthUser['avatar'], isDemo: false };
}

/** Proposed cookie-session adapter. No endpoints are enabled without explicit contract configuration. */
export class HttpAuthService implements AuthService {
  readonly mode = 'api' as const;
  private readonly endpoints: AuthEndpoints;
  private readonly requestFetch: typeof fetch;
  private readonly invalidationListeners = new Set<() => void>();

  constructor(private readonly options: HttpAuthServiceOptions) {
    this.endpoints = { ...PROPOSED_AUTH_ENDPOINTS, ...options.endpoints };
    if (!Object.values(this.endpoints).every((endpoint) => typeof endpoint === 'string' && /^\/(?!\/)[A-Za-z0-9/_-]+$/.test(endpoint))) {
      throw new AuthError('unavailable');
    }
    this.requestFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  private async request<T>(
    operation: keyof AuthEndpoints,
    body: unknown,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new AuthError('network')); }, 15_000);
    });
    const execute = async () => {
      const mutation = operation !== 'me';
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (mutation) {
        let token: string | null;
        try { token = await this.options.getCsrfToken(); } catch { throw new AuthError('unavailable'); }
        if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new AuthError('unavailable');
        headers['X-CSRF-Token'] = token;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
      }
      if (controller.signal.aborted) throw new AuthError('network');
      let response: Response;
      try {
        response = await this.requestFetch(this.endpoints[operation], {
          method: mutation ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
          signal: controller.signal, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw new AuthError('network'); }
      if (controller.signal.aborted) throw new AuthError('network');
      return consume(response, controller.signal);
    };
    try { return await Promise.race([execute(), timedOut]); }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
  }

  private async json(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const body: unknown = await response.json();
      if (signal.aborted) throw new AuthError('network');
      if (!isRecord(body)) throw new Error();
      return body;
    } catch { throw new AuthError(signal.aborted ? 'network' : 'invalid_response'); }
  }

  private invalidate(): void {
    for (const listener of this.invalidationListeners) {
      try { listener(); } catch { /* Consumers must not interrupt session invalidation. */ }
    }
  }

  private async failure(response: Response, operation: keyof AuthEndpoints, signal: AbortSignal): Promise<never> {
    if (response.status === 401) {
      if (operation !== 'login') this.invalidate();
      throw new AuthError(operation === 'login' ? 'invalid_credentials' : 'unauthorized');
    }
    if (operation === 'logout') throw new AuthError('logout_failed');
    if (operation === 'register' && response.status === 409) throw new AuthError('account_unavailable');
    if (response.status === 400 || response.status === 422) {
      let fields: AuthField[] = [];
      try {
        const body = await this.json(response, signal);
        if (Array.isArray(body.fields)) fields = body.fields.filter((field): field is AuthField =>
          typeof field === 'string' && AUTH_FIELDS.includes(field as AuthField));
      } catch { /* Backend diagnostics are optional and never displayed. */ }
      throw new AuthError('validation', fields);
    }
    if (response.status === 403) throw new AuthError('unauthorized');
    throw new AuthError('unavailable');
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const validation = validateLogin(input);
    if (!validation.valid) throw new AuthError('validation', Object.keys(validation.errors) as AuthField[]);
    return this.request('login', validation.value, async (response, signal) => {
      if (response.status !== 200) return this.failure(response, 'login', signal);
      return { user: authUser((await this.json(response, signal)).user) };
    });
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const validation = validateRegistration({ ...input, confirmPassword: input.password });
    if (!validation.valid) throw new AuthError('validation', Object.keys(validation.errors) as AuthField[]);
    return this.request('register', validation.value, async (response, signal) => {
      if (response.status !== 200 && response.status !== 201) return this.failure(response, 'register', signal);
      const body = await this.json(response, signal);
      if (body.status === 'requires-login') return { status: 'requires-login' };
      if (body.status === 'authenticated') return { status: 'authenticated', user: authUser(body.user) };
      throw new AuthError('invalid_response');
    });
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    return this.request('me', undefined, async (response, signal) => {
      if (response.status === 401) { this.invalidate(); return null; }
      if (response.status !== 200) return this.failure(response, 'me', signal);
      const body = await this.json(response, signal);
      return body.user === null ? null : authUser(body.user);
    });
  }

  async logout(): Promise<void> {
    return this.request('logout', undefined, async (response, signal) => {
      if (response.status === 204 || response.status === 401) { this.invalidate(); return; }
      if (response.status !== 200) return this.failure(response, 'logout', signal);
      if ((await this.json(response, signal)).success !== true) throw new AuthError('logout_failed');
      this.invalidate();
    });
  }

  subscribeToInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => { this.invalidationListeners.delete(listener); };
  }
}
