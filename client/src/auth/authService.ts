import { AuthError, type AuthResult, type AuthUser, type LoginInput, type RegisterInput, type RegisterResult } from './authModel';
import { HttpAuthService } from './httpAuthService';
import type { SessionApi } from '@/api/sessionApi';

export type DemoPersona = 'explorer' | 'nova';
export interface AuthService {
  readonly mode: 'demo' | 'api' | 'unconfigured';
  login(input: LoginInput): Promise<AuthResult>;
  register(input: RegisterInput): Promise<RegisterResult>;
  logout(): Promise<void>;
  getCurrentUser(): Promise<AuthUser | null>;
  continueAsDemo?(persona: DemoPersona): Promise<AuthResult>;
  subscribeToInvalidation?(listener: () => void): () => void;
  createSessionApi?(actor: AuthUser): SessionApi;
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
  const mode = process.env.NEXT_PUBLIC_AUTH_MODE ?? 'api';
  // Demo credentials/personas cannot be enabled through deployed configuration, even in dev.
  if (mode !== 'api' || process.env.NEXT_PUBLIC_AUTH_API_READY === 'false') return new UnconfiguredAuthService();
  try { return new HttpAuthService({ basePath: process.env.NEXT_PUBLIC_AUTH_API_BASE_PATH ?? '/api/auth' }); }
  catch { return new UnconfiguredAuthService(); }
}
