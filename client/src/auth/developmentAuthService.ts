import { createDemoProfile } from '@/profiles/profileModel';
import { AuthError, copyAuthUser, validateLogin, validateRegistration, type AuthResult, type AuthUser, type LoginInput, type RegisterInput, type RegisterResult } from './authModel';
import type { AuthService, DemoPersona } from './authService';

function requireDevelopment(): void {
  if (process.env.NODE_ENV === 'production') throw new AuthError('unavailable');
}

/** Memory-only synthetic sessions; no account directory, credential verification, or secret storage. */
export class DevelopmentAuthService implements AuthService {
  readonly mode = 'demo' as const;
  private user: AuthUser | null = null;

  constructor() { requireDevelopment(); }

  async getCurrentUser(): Promise<AuthUser | null> {
    requireDevelopment();
    return this.user ? copyAuthUser(this.user) : null;
  }

  async continueAsDemo(persona: DemoPersona): Promise<AuthResult> {
    requireDevelopment();
    if (persona !== 'explorer' && persona !== 'nova') throw new AuthError('validation');
    this.user = persona === 'explorer' ? copyAuthUser(createDemoProfile()) : {
      id: 'demo-session-nova', username: 'nova-explorer', displayName: 'Nova Explorer', avatar: 'rocket', isDemo: true,
    };
    return { user: copyAuthUser(this.user) };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    requireDevelopment();
    const validation = validateLogin(input);
    if (!validation.valid) throw new AuthError('validation', Object.keys(validation.errors) as (keyof typeof validation.errors)[]);
    const username = validation.value.identifier.split('@')[0]!.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 30) || 'demo-user';
    // Each synthetic sign-in is isolated; an identifier is never treated as a verified account.
    this.user = { id: `demo-login-${crypto.randomUUID()}`, username, displayName: username, avatar: 'initials', isDemo: true };
    return { user: copyAuthUser(this.user) };
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    requireDevelopment();
    const validation = validateRegistration({ ...input, confirmPassword: input.password });
    if (!validation.valid) throw new AuthError('validation', Object.keys(validation.errors) as (keyof typeof validation.errors)[]);
    const { username, displayName } = validation.value;
    this.user = {
      id: `demo-account-${username.toLowerCase()}`, username, displayName: displayName ?? username, avatar: 'initials', isDemo: true,
    };
    // Submitted email/password are discarded, not persisted or retained in an account registry.
    return { status: 'authenticated', user: copyAuthUser(this.user) };
  }

  async logout(): Promise<void> {
    requireDevelopment();
    this.user = null;
  }
}
