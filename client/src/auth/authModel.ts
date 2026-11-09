import { DISPLAY_NAME_MAX_LENGTH, type UserProfile } from '@/profiles/profileModel';

/** Authentication reuses the existing profile identity; account/private fields are excluded. */
export type AuthUser = Pick<UserProfile, 'id' | 'username' | 'displayName' | 'avatar' | 'isDemo'>;

export interface LoginInput {
  identifier: string;
  password: string;
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  displayName?: string;
}

export interface AuthResult { user: AuthUser }
export type RegisterResult = { status: 'authenticated'; user: AuthUser } | { status: 'requires-login' };
export type AuthField = 'identifier' | 'username' | 'email' | 'password' | 'confirmPassword' | 'displayName';
export type AuthFieldErrors = Partial<Record<AuthField, string>>;
export type AuthValidationResult<T> = { valid: true; value: T } | { valid: false; errors: AuthFieldErrors };

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

export function validateLogin(input: LoginInput): AuthValidationResult<LoginInput> {
  const errors: AuthFieldErrors = {};
  const identifier = typeof input?.identifier === 'string' ? input.identifier.trim() : '';
  if (!identifier) errors.identifier = 'Enter your username or email.';
  else if (controlCharacters.test(identifier)) errors.identifier = 'Enter a valid username or email.';
  if (typeof input?.password !== 'string' || input.password.length === 0) errors.password = 'Enter your password.';
  if (Object.keys(errors).length) return { valid: false, errors };
  // Passwords remain byte-for-byte as entered, including leading/trailing spaces.
  return { valid: true, value: { identifier, password: input.password } };
}

/** Username/email checks are provisional UX rules until the backend contract is ratified.
 * Password policy currently requires a value only; no invented complexity or maximum length.
 */
export function validateRegistration(
  input: RegisterInput & { confirmPassword: string },
): AuthValidationResult<RegisterInput> {
  const errors: AuthFieldErrors = {};
  const username = typeof input?.username === 'string' ? input.username.trim() : '';
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
  if (!username) errors.username = 'Enter a username.';
  else if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) {
    errors.username = 'Use 3–30 letters, numbers, periods, underscores, or hyphens.';
  }
  if (!email) errors.email = 'Enter your email.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || controlCharacters.test(email)) errors.email = 'Enter a valid email address.';
  if (typeof input?.password !== 'string' || input.password.length === 0) errors.password = 'Enter a password.';
  if (typeof input?.confirmPassword !== 'string' || input.confirmPassword.length === 0) errors.confirmPassword = 'Confirm your password.';
  else if (input.confirmPassword !== input.password) errors.confirmPassword = 'Passwords do not match.';
  if (input?.displayName !== undefined && typeof input.displayName !== 'string') {
    errors.displayName = 'Enter a valid display name.';
  } else if (controlCharacters.test(displayName) || [...displayName].length > DISPLAY_NAME_MAX_LENGTH) {
    errors.displayName = `Use a display name of ${DISPLAY_NAME_MAX_LENGTH} characters or fewer without control characters.`;
  }
  if (Object.keys(errors).length) return { valid: false, errors };
  return {
    valid: true,
    value: { username, email, password: input.password, ...(displayName ? { displayName } : {}) },
  };
}

export type AuthErrorCode = 'invalid_credentials' | 'account_unavailable' | 'network' | 'unavailable' |
  'unauthorized' | 'invalid_response' | 'logout_failed' | 'validation';

const messages: Record<AuthErrorCode, string> = {
  invalid_credentials: 'Sign-in failed. Check your credentials and try again.',
  account_unavailable: 'An account could not be created with these details. Try different details or sign in.',
  network: 'The authentication service could not be reached. Check your connection and try again.',
  unavailable: 'Authentication is not available yet. Please try again later.',
  unauthorized: 'Your session has expired. Please sign in again.',
  invalid_response: 'The authentication service returned an unexpected response. Please try again.',
  logout_failed: 'Sign-out could not be confirmed. Your server session may still be active. Please try again.',
  validation: 'Please check the highlighted fields.',
};

const fieldMessages: Record<AuthField, string> = {
  identifier: 'Check your username or email.', username: 'Check your username.', email: 'Check your email.',
  password: 'Check your password.', confirmPassword: 'Check your password confirmation.', displayName: 'Check your display name.',
};

export const AUTH_FIELDS: readonly AuthField[] = ['identifier', 'username', 'email', 'password', 'confirmPassword', 'displayName'];

/** Backend strings and exception bodies are never forwarded to the UI. */
export class AuthError extends Error {
  readonly fieldErrors: AuthFieldErrors;

  constructor(public readonly code: AuthErrorCode, fields: readonly AuthField[] = []) {
    super(messages[code]);
    this.name = 'AuthError';
    this.fieldErrors = {};
    for (const field of fields) {
      if (AUTH_FIELDS.includes(field)) this.fieldErrors[field] = fieldMessages[field];
    }
  }
}

export function copyAuthUser(user: AuthUser): AuthUser {
  return { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar, isDemo: user.isDemo };
}
