import { AuthError, type LoginInput } from '@/auth/authModel';
import type { AuthService } from '@/auth/authService';
import { DevelopmentCallingHttpAuthService } from './httpAuthService';
import { developmentCallingEnabled } from './developmentCalling';

const selector = 'meta[name="secubuzz-csrf-token"]';

/** Only the opt-in local harness supplies this synchronizer-token bootstrap. */
export function createDevelopmentCallingAuthService(request: typeof fetch = (...args) => globalThis.fetch(...args)): AuthService {
  if (!developmentCallingEnabled()) throw new AuthError('unavailable');
  let pending: Promise<string> | null = null;
  const bootstrap = (): Promise<string> => pending ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await request('/api/dev-calling/bootstrap', { credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new AuthError('unavailable');
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('developmentOnly' in value) || value.developmentOnly !== true ||
          !('csrfToken' in value) || typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) throw new AuthError('invalid_response');
      let meta = document.querySelector<HTMLMetaElement>(selector);
      if (!meta) { meta = document.createElement('meta'); meta.name = 'secubuzz-csrf-token'; document.head.append(meta); }
      meta.content = value.csrfToken;
      return value.csrfToken;
    } catch (error) {
      document.querySelector(selector)?.remove();
      throw error instanceof AuthError ? error : new AuthError('unavailable');
    } finally { clearTimeout(timer); }
  })().finally(() => { pending = null; });
  const service = new DevelopmentCallingHttpAuthService({ fetch: request, getCsrfToken: bootstrap });
  return {
    mode: 'api',
    async login(input: LoginInput) {
      const result = await service.login(input);
      // Rotate the frontend token before mounting media for the newly authenticated cookie.
      await bootstrap();
      return result;
    },
    async getCurrentUser() { await bootstrap(); return service.getCurrentUser(); },
    async logout() { await service.logout(); document.querySelector(selector)?.remove(); },
    async register() { throw new AuthError('unavailable'); },
    subscribeToInvalidation: listener => service.subscribeToInvalidation(listener),
  };
}
