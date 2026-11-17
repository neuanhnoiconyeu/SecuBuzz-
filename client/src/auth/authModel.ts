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
export const AUTH_PASSWORD_MIN_CODE_POINTS = 15;
export const AUTH_PASSWORD_MAX_BYTES = 1024;

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function validPassword(value: unknown, minimum: number): value is string {
  if (typeof value !== 'string' || !validUnicode(value)) return false;
  const characters = [...value];
  const bytes = characters.reduce((total, character) => {
    const code = character.codePointAt(0)!;
    return total + (code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4);
  }, 0);
  return characters.length >= minimum && bytes <= AUTH_PASSWORD_MAX_BYTES;
}

export function validateLogin(input: LoginInput): AuthValidationResult<LoginInput> {
  const errors: AuthFieldErrors = {};
  const identifier = typeof input?.identifier === 'string' ? input.identifier.trim() : '';
  if (!identifier) errors.identifier = 'Enter your username or email.';
  else if (input.identifier.length > 254 || controlCharacters.test(identifier)) errors.identifier = 'Enter a valid username or email.';
  if (typeof input?.password !== 'string' || input.password.length === 0) errors.password = 'Enter your password.';
  else if (!validPassword(input.password, 1)) errors.password = 'Use a valid password of at most 1024 UTF-8 bytes.';
  if (Object.keys(errors).length) return { valid: false, errors };
  // Passwords remain byte-for-byte as entered, including leading/trailing spaces.
  return { valid: true, value: { identifier: identifier.toLowerCase(), password: input.password } };
}

/** Mirrors DB-2's public input policy; backend validation remains authoritative. */
export function validateRegistration(
  input: RegisterInput & { confirmPassword: string },
): AuthValidationResult<RegisterInput> {
  const errors: AuthFieldErrors = {};
  const username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : '';
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
  if (!username) errors.username = 'Enter a username.';
  else if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username) || username === 'local-user' || /^demo[-_.:]/.test(username)) {
    errors.username = 'Use 3–30 characters, starting with a letter or number. Local/demo names are reserved.';
  }
  if (!email) errors.email = 'Enter your email.';
  else if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ||
    email.includes('..') || email.startsWith('.') || email.includes('.@')) errors.email = 'Enter a valid email address.';
  if (typeof input?.password !== 'string' || input.password.length === 0) errors.password = 'Enter a password.';
  else if (!validPassword(input.password, AUTH_PASSWORD_MIN_CODE_POINTS)) errors.password = 'Use at least 15 characters and at most 1024 UTF-8 bytes. Spaces are allowed.';
  if (typeof input?.confirmPassword !== 'string' || input.confirmPassword.length === 0) errors.confirmPassword = 'Confirm your password.';
  else if (input.confirmPassword !== input.password) errors.confirmPassword = 'Passwords do not match.';
  if (input?.displayName !== undefined && typeof input.displayName !== 'string') {
    errors.displayName = 'Enter a valid display name.';
  } else if ((input?.displayName !== undefined && !displayName) || !validUnicode(displayName) || controlCharacters.test(displayName) || [...displayName].length > DISPLAY_NAME_MAX_LENGTH) {
    errors.displayName = `Use a display name of ${DISPLAY_NAME_MAX_LENGTH} characters or fewer without control characters.`;
  }
  if (Object.keys(errors).length) return { valid: false, errors };
  return {
    valid: true,
    value: { username, email, password: input.password, ...(displayName ? { displayName } : {}) },
  };
}

export type AuthErrorCode = 'invalid_credentials' | 'account_unavailable' | 'network' | 'unavailable' |
  'unauthorized' | 'invalid_response' | 'logout_failed' | 'validation' | 'rate_limited' | 'csrf_invalid' | 'service_unavailable' | 'forbidden';

const messages: Record<AuthErrorCode, string> = {
  invalid_credentials: 'Sign-in failed. Check your credentials and try again.',
  account_unavailable: 'An account could not be created with these details. Try different details or sign in.',
  network: 'The authentication service could not be reached. Check your connection and try again.',
  unavailable: 'Authentication is not configured correctly. Please check the application setup.',
  service_unavailable: 'The authentication service is temporarily unavailable. Please try again later.',
  forbidden: 'The authentication request was blocked by a security check. Reload the page and try again.',
  unauthorized: 'Your session has expired. Please sign in again.',
  invalid_response: 'The authentication service returned an unexpected response. Please try again.',
  logout_failed: 'Sign-out could not be confirmed. Your server session may still be active. Please try again.',
  validation: 'Please check the highlighted fields.',
  rate_limited: 'Too many authentication attempts. Wait before trying again.',
  csrf_invalid: 'Your security check could not be verified. Try again to request a fresh check.',
};

const fieldMessages: Record<AuthField, string> = {
  identifier: 'Check your username or email.', username: 'Check your username.', email: 'Check your email.',
  password: 'Check your password.', confirmPassword: 'Check your password confirmation.', displayName: 'Check your display name.',
};

export const AUTH_FIELDS: readonly AuthField[] = ['identifier', 'username', 'email', 'password', 'confirmPassword', 'displayName'];

/** Backend strings and exception bodies are never forwarded to the UI. */
export class AuthError extends Error {
  readonly fieldErrors: AuthFieldErrors;

  constructor(public readonly code: AuthErrorCode, fields: readonly AuthField[] = [], public readonly retryAfterSeconds?: number) {
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
