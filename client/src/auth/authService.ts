import { AuthError, type AuthResult, type AuthUser, type LoginInput, type RegisterInput, type RegisterResult } from './authModel';
import { DevelopmentAuthService } from './developmentAuthService';
import { HttpAuthService } from './httpAuthService';

export type DemoPersona = 'explorer' | 'nova';
export interface AuthService {
  readonly mode: 'demo' | 'api' | 'unconfigured';
  login(input: LoginInput): Promise<AuthResult>;
  register(input: RegisterInput): Promise<RegisterResult>;
  logout(): Promise<void>;
  getCurrentUser(): Promise<AuthUser | null>;
  continueAsDemo?(persona: DemoPersona): Promise<AuthResult>;
  subscribeToInvalidation?(listener: () => void): () => void;
}

/** A missing contract leaves the auth UI reachable but never fabricates an authenticated user. */
export class UnconfiguredAuthService implements AuthService {
  readonly mode = 'unconfigured' as const;
  async login(_input: LoginInput): Promise<AuthResult> { throw new AuthError('unavailable'); }
  async register(_input: RegisterInput): Promise<RegisterResult> { throw new AuthError('unavailable'); }
  async logout(): Promise<void> { throw new AuthError('logout_failed'); }
  async getCurrentUser(): Promise<null> { return null; }
}

export function createConfiguredAuthService(): AuthService {
  const mode = process.env.NEXT_PUBLIC_AUTH_MODE;
  if (mode === 'api') {
    if (process.env.NEXT_PUBLIC_AUTH_API_READY !== 'true') return new UnconfiguredAuthService();
    return new HttpAuthService({
      getCsrfToken: () => typeof document === 'undefined' ? null :
        document.querySelector<HTMLMetaElement>('meta[name="secubuzz-csrf-token"]')?.content ?? null,
    });
  }
  if ((mode === undefined || mode === 'demo') && process.env.NODE_ENV !== 'production') return new DevelopmentAuthService();
  return new UnconfiguredAuthService();
}
