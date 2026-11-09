import { AuthError, validateLogin, validateRegistration } from '../authModel';

const registration = { username: 'demo.person', email: 'person@example.test', password: '  not-a-real-password  ', confirmPassword: '  not-a-real-password  ' };

test('login validates required fields and trims only the identifier', () => {
  expect(validateLogin({ identifier: ' ', password: '' })).toEqual({ valid: false, errors: {
    identifier: 'Enter your username or email.', password: 'Enter your password.',
  } });
  expect(validateLogin({ identifier: ' person@example.test ', password: '  password  ' })).toEqual({
    valid: true, value: { identifier: 'person@example.test', password: '  password  ' },
  });
  expect(validateLogin({ identifier: 'a\nname', password: 'x' }).valid).toBe(false);
});

test('registration normalizes public fields without trimming password or retaining confirmation', () => {
  expect(validateRegistration({ ...registration, username: ' demo.person ', email: ' person@example.test ', displayName: ' Demo Person ' })).toEqual({
    valid: true, value: { username: 'demo.person', email: 'person@example.test', displayName: 'Demo Person', password: registration.password },
  });
});

test.each(['ab', 'a'.repeat(31), 'not a name', 'name!'])('validates provisional username rules: %s', (username) => {
  const result = validateRegistration({ ...registration, username });
  expect(result.valid).toBe(false);
  if (!result.valid) expect(result.errors.username).toBeDefined();
});

test.each(['missing-at.test', 'name@example', 'a b@example.test', 'name@@example.test'])('validates email structure: %s', (email) => {
  const result = validateRegistration({ ...registration, email });
  expect(result.valid).toBe(false);
  if (!result.valid) expect(result.errors.email).toBeDefined();
});

test('registration reports missing fields and exact password confirmation mismatch', () => {
  const missing = validateRegistration({ username: '', email: '', password: '', confirmPassword: '' });
  expect(missing.valid).toBe(false);
  if (!missing.valid) expect(Object.keys(missing.errors)).toEqual(['username', 'email', 'password', 'confirmPassword']);
  const mismatch = validateRegistration({ ...registration, confirmPassword: registration.password.trim() });
  expect(mismatch.valid).toBe(false);
  if (!mismatch.valid) expect(mismatch.errors.confirmPassword).toBe('Passwords do not match.');
});

test('does not invent password complexity or maximum length rules', () => {
  expect(validateRegistration({ ...registration, password: ' ', confirmPassword: ' ' }).valid).toBe(true);
  expect(validateRegistration({ ...registration, password: 'x'.repeat(10_000), confirmPassword: 'x'.repeat(10_000) }).valid).toBe(true);
});

test('reuses the profile display-name limit and excludes empty optional display name', () => {
  expect(validateRegistration({ ...registration, displayName: 'x'.repeat(41) }).valid).toBe(false);
  expect(validateRegistration({ ...registration, displayName: 'line\nbreak' }).valid).toBe(false);
  const valid = validateRegistration({ ...registration, displayName: ' ' });
  if (valid.valid) expect(valid.value).not.toHaveProperty('displayName');
});

test('auth errors expose only fixed safe messages and allowlisted field names', () => {
  const error = new AuthError('validation', ['username', 'password', 'server-private-token' as 'username']);
  expect(error.message).toBe('Please check the highlighted fields.');
  expect(error.fieldErrors).toEqual({ username: 'Check your username.', password: 'Check your password.' });
});
