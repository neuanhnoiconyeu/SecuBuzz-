import { AuthError, validateLogin, validateRegistration } from '../authModel';

const registration = { username: 'sample.person', email: 'person@example.test', password: '  not-a-real-password  ', confirmPassword: '  not-a-real-password  ' };

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
  expect(validateRegistration({ ...registration, username: ' Sample.Person ', email: ' Person@example.test ', displayName: ' Demo Person ' })).toEqual({
    valid: true, value: { username: 'sample.person', email: 'person@example.test', displayName: 'Demo Person', password: registration.password },
  });
});

test.each(['ab', 'a'.repeat(31), 'not a name', 'name!', '.name', 'demo.person', 'local-user'])('validates DB-2 username rules: %s', (username) => {
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

test('matches DB-2 Unicode length/byte bounds without adding composition or trimming rules', () => {
  for (const password of ['x'.repeat(15), ' '.repeat(15), '😀'.repeat(15), 'x'.repeat(1024)]) {
    expect(validateRegistration({ ...registration, password, confirmPassword: password }).valid).toBe(true);
  }
  for (const password of ['x'.repeat(14), '😀'.repeat(14), 'x'.repeat(1025), '😀'.repeat(257), '\ud800'.repeat(15), '\udc00'.repeat(15)]) {
    expect(validateRegistration({ ...registration, password, confirmPassword: password }).valid).toBe(false);
  }
  expect(validateLogin({ identifier: 'person', password: 'x' }).valid).toBe(true);
  expect(validateLogin({ identifier: 'person', password: 'x'.repeat(1025) }).valid).toBe(false);
});

test('reuses the profile display-name limit and rejects explicitly empty optional display name', () => {
  expect(validateRegistration({ ...registration, displayName: 'x'.repeat(41) }).valid).toBe(false);
  expect(validateRegistration({ ...registration, displayName: 'line\nbreak' }).valid).toBe(false);
  expect(validateRegistration({ ...registration, displayName: ' ' }).valid).toBe(false);
  const valid = validateRegistration(registration);
  if (valid.valid) expect(valid.value).not.toHaveProperty('displayName');
});

test('auth errors expose only fixed safe messages and allowlisted field names', () => {
  const error = new AuthError('validation', ['username', 'password', 'server-private-token' as 'username']);
  expect(error.message).toBe('Please check the highlighted fields.');
  expect(error.fieldErrors).toEqual({ username: 'Check your username.', password: 'Check your password.' });
});
