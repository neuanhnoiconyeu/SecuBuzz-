import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAuth } from '@/auth/AuthProvider';
import { useSafeReturnTo } from '@/auth/authNavigation';
import { AuthError } from '@/auth/authModel';
import { AuthForm } from '../AuthForm';
import { AuthLoading } from '../AuthShell';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
jest.mock('@/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/auth/authNavigation', () => ({ useSafeReturnTo: jest.fn() }));

type AuthState = ReturnType<typeof useAuth>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockReturnTo = useSafeReturnTo as jest.MockedFunction<typeof useSafeReturnTo>;

function createAuth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    status: 'unauthenticated', user: null, mode: 'api', pending: null, error: null, sessionVersion: 0,
    login: jest.fn().mockResolvedValue(true), register: jest.fn().mockResolvedValue({ status: 'requires-login' }),
    logout: jest.fn().mockResolvedValue(true), restoreSession: jest.fn().mockResolvedValue(undefined),
    continueAsDemo: jest.fn().mockResolvedValue(true), clearError: jest.fn(), ...overrides,
  };
}

beforeEach(() => {
  replace.mockClear();
  mockUseAuth.mockReturnValue(createAuth());
  mockReturnTo.mockReturnValue('/#friends');
  window.history.replaceState({}, '', '/login');
});

function loginFields(identifier = '  explorer@example.com  ', password = '  sample password  ') {
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: identifier } });
  fireEvent.change(screen.getByLabelText('Password', { exact: true }), { target: { value: password } });
}

function registrationFields(password = 'sample password', confirmation = password) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: '  sample-explorer  ' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  explorer@example.com  ' } });
  fireEvent.change(screen.getByLabelText('Password', { exact: true }), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirmation } });
}

describe('AuthForm', () => {
  test('validates required login fields and focuses the first invalid field', () => {
    const auth = createAuth();
    mockUseAuth.mockReturnValue(auth);
    render(<AuthForm variant="login" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Please check the highlighted fields.');
    expect(screen.getByText('Enter your username or email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Username or email')).toHaveFocus();
    expect(screen.getByLabelText('Username or email')).toHaveAttribute('aria-invalid', 'true');
    expect(auth.login).not.toHaveBeenCalled();
  });

  test('trims the login identifier, preserves password bytes, and leaves successful navigation to the guard', async () => {
    const auth = createAuth();
    mockUseAuth.mockReturnValue(auth);
    render(<AuthForm variant="login" />);
    loginFields();
    expect(screen.getByLabelText('Username or email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith({ identifier: 'explorer@example.com', password: '  sample password  ' }));
    await waitFor(() => expect(screen.getByLabelText('Password', { exact: true })).toHaveValue(''));
    expect(replace).not.toHaveBeenCalled();
  });

  test('prevents duplicate login submissions and disables controls during the pending request', async () => {
    let finish!: (accepted: boolean) => void;
    const auth = createAuth({ login: jest.fn(() => new Promise<boolean>((resolve) => { finish = resolve; })) });
    mockUseAuth.mockReturnValue(auth);
    render(<AuthForm variant="login" />);
    loginFields();
    const form = screen.getByRole('form', { name: 'Sign in' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(auth.login).toHaveBeenCalledTimes(1);
    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Password', { exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeDisabled();
    await act(async () => { finish(true); });
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled();
  });

  test('shows safe invalid-credential feedback and clears submitted passwords after failure', async () => {
    const auth = createAuth();
    auth.login = jest.fn(async () => { auth.error = new AuthError('invalid_credentials'); return false; });
    mockUseAuth.mockImplementation(() => auth);
    render(<AuthForm variant="login" />);
    loginFields();
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed. Check your credentials and try again.'));
    expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('');
    expect(screen.getByLabelText('Username or email')).toHaveValue('  explorer@example.com  ');
    expect(replace).not.toHaveBeenCalled();
  });

  test('validates signup fields, email structure, and password confirmation before transport', () => {
    const auth = createAuth();
    mockUseAuth.mockReturnValue(auth);
    render(<AuthForm variant="signup" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(screen.getByLabelText('Username')).toHaveFocus();
    expect(screen.getByText('Enter a username.')).toBeInTheDocument();
    expect(screen.getByText('Enter your email.')).toBeInTheDocument();
    expect(screen.getByText('Confirm your password.')).toBeInTheDocument();
    registrationFields('sample password', 'different');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bad-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(auth.register).not.toHaveBeenCalled();
  });

  test('handles registration requiring login and preserves the sanitized intended destination once', async () => {
    const auth = createAuth();
    mockUseAuth.mockReturnValue(auth);
    render(<AuthForm variant="signup" />);
    registrationFields('  sample password  ');
    expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('autocomplete', 'new-password');
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?registered=1&next=%2F%23friends'));
    expect(auth.register).toHaveBeenCalledWith({ username: 'sample-explorer', email: 'explorer@example.com', password: '  sample password  ' });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('');
    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
  });

  test('authenticated registration leaves its single navigation to AuthOnlyRoute', async () => {
    const auth = createAuth({ register: jest.fn().mockResolvedValue({
      status: 'authenticated', user: { id: 'sample-user', username: 'sample-explorer', displayName: 'Sample Explorer', avatar: 'initials', isDemo: false },
    }) });
    mockUseAuth.mockReturnValue(auth);
    render(<AuthForm variant="signup" />);
    registrationFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(screen.getByLabelText('Password', { exact: true })).toHaveValue(''));
    expect(auth.register).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  test('maps registration errors to safe field feedback and focuses the affected field', async () => {
    const auth = createAuth();
    auth.register = jest.fn(async () => { auth.error = new AuthError('account_unavailable', ['email']); return null; });
    mockUseAuth.mockImplementation(() => auth);
    render(<AuthForm variant="signup" />);
    registrationFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('An account could not be created with these details.'));
    expect(await screen.findByText('Check your email.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
    expect(replace).not.toHaveBeenCalled();
  });

  test('keeps credentials out of persistence, logs, raw errors, and successful navigation on exceptions', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const storage = jest.spyOn(Storage.prototype, 'setItem');
    try {
      const auth = createAuth({ login: jest.fn().mockRejectedValue(new Error('private-password-and-transport-detail')) });
      mockUseAuth.mockReturnValue(auth);
      render(<AuthForm variant="login" />);
      loginFields('sample', 'private-password-and-transport-detail');
      fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Sign-in could not be completed.'));
      expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('');
      expect(screen.queryByText('private-password-and-transport-detail')).not.toBeInTheDocument();
      expect(storage).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); storage.mockRestore(); }
  });

  test('demo actions are explicitly labeled, require no credentials, and choose the requested persona', async () => {
    const auth = createAuth({ mode: 'demo' });
    mockUseAuth.mockReturnValue(auth);
    render(<AuthForm variant="login" />);
    expect(screen.getByText(/Use sample values, never a real password/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue as Demo User' }));
    await waitFor(() => expect(auth.continueAsDemo).toHaveBeenCalledWith('explorer'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try Nova Demo User' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Try Nova Demo User' }));
    await waitFor(() => expect(auth.continueAsDemo).toHaveBeenCalledWith('nova'));
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.register).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  test('unconfigured production builds show the backend gap and expose no demo authentication', () => {
    mockUseAuth.mockReturnValue(createAuth({ mode: 'unconfigured' }));
    render(<AuthForm variant="login" />);
    expect(screen.getByText('Sign-in is not connected yet.')).toBeInTheDocument();
    expect(screen.getByLabelText('Username or email')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Continue as Demo User' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try Nova Demo User' })).not.toBeInTheDocument();
  });

  test('auth links preserve the intended destination and post-registration notice is explicit', () => {
    window.history.replaceState({}, '', '/login?registered=1&next=%2F%23friends');
    render(<AuthForm variant="login" />);
    expect(screen.getByText('Account created. Sign in to continue.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign Up' })).toHaveAttribute('href', '/signup?next=%2F%23friends');
  });

  test('branded restoration does not depend on or reveal authenticated state', () => {
    render(<AuthLoading message="Checking your session…" />);
    expect(screen.getByRole('heading', { name: 'One moment.' })).toHaveClass('display-heading');
    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });
});
