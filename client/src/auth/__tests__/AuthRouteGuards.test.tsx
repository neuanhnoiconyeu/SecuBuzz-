import { render, screen, renderHook, act } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { RequireAuth, AuthOnlyRoute } from '../AuthRouteGuards';
import { useAuth, type AuthContextValue } from '../AuthProvider';
import { safeReturnTo, useSafeReturnTo } from '../authNavigation';

jest.mock('next/navigation', () => ({ useRouter: jest.fn() }));
jest.mock('../AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/components/auth/AuthShell', () => ({ AuthLoading: ({ message }: { message: string }) => <p role="status">{message}</p> }));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseRouter = useRouter as jest.MockedFunction<typeof useRouter>;
const replace = jest.fn();

function auth(status: AuthContextValue['status']): AuthContextValue {
  return {
    status, user: status === 'authenticated' ? { id: 'server-user', username: 'person', displayName: 'Person', avatar: 'initials', isDemo: false } : null,
    mode: 'api', pending: status === 'initializing' ? 'restore' : null, error: null, sessionVersion: 1,
    login: jest.fn(), register: jest.fn(), logout: jest.fn(), restoreSession: jest.fn(), continueAsDemo: jest.fn(), clearError: jest.fn(),
  };
}

beforeEach(() => {
  replace.mockReset();
  window.history.replaceState({}, '', '/');
  mockUseRouter.mockReturnValue({ replace } as unknown as ReturnType<typeof useRouter>);
});

describe('safe intended destinations', () => {
  test.each(['/', '/#chats', '/#friends', '/#security'])('allows only existing Messenger destination %s', (destination) => {
    expect(safeReturnTo(destination)).toBe(destination);
  });

  test.each([
    'https://untrusted.example/', '//untrusted.example/', '/\\untrusted.example', 'javascript:alert(1)',
    '/login', '/signup', '/login?next=/', '/unknown', '/?next=https://untrusted.example/', '/#unknown',
    '%2F%2Funtrusted.example', ' /#friends', '/#friends ', null, undefined, {}, 42,
  ])('rejects unsafe or unsupported destination %#', (destination) => {
    expect(safeReturnTo(destination)).toBe('/');
  });

  test('return-to hook updates only to safe destinations on navigation', () => {
    window.history.replaceState({}, '', '/login?next=%2F%23friends');
    const { result, unmount } = renderHook(useSafeReturnTo);
    expect(result.current).toBe('/#friends');
    act(() => {
      window.history.replaceState({}, '', '/login?next=https%3A%2F%2Funtrusted.example');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current).toBe('/');
    unmount();
  });
});

describe('protected and public auth routes', () => {
  test('initialization never mounts protected content or redirects before session resolution', () => {
    mockUseAuth.mockReturnValue(auth('initializing'));
    const mounted = jest.fn();
    function PrivateContent() { mounted(); return <p>Private content</p>; }
    render(<RequireAuth><PrivateContent /></RequireAuth>);
    expect(screen.getByRole('status')).toHaveTextContent('Restoring your session');
    expect(screen.queryByText('Private content')).not.toBeInTheDocument();
    expect(mounted).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  test('unauthenticated protected navigation preserves a safe destination and redirects once', () => {
    window.history.replaceState({}, '', '/#friends');
    mockUseAuth.mockReturnValue(auth('unauthenticated'));
    const view = render(<RequireAuth><p>Private content</p></RequireAuth>);
    expect(replace).toHaveBeenCalledWith('/login?next=%2F%23friends');
    expect(screen.queryByText('Private content')).not.toBeInTheDocument();
    mockUseRouter.mockReturnValue({ replace } as unknown as ReturnType<typeof useRouter>);
    view.rerender(<RequireAuth><p>Private content changed</p></RequireAuth>);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  test('authenticated access renders protected children and a later expiry redirects once', () => {
    mockUseAuth.mockReturnValue(auth('authenticated'));
    const view = render(<RequireAuth><p>Private content</p></RequireAuth>);
    expect(screen.getByText('Private content')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    mockUseAuth.mockReturnValue(auth('unauthenticated'));
    view.rerender(<RequireAuth><p>Private content</p></RequireAuth>);
    expect(screen.queryByText('Private content')).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledTimes(1);
    view.rerender(<RequireAuth><p>Private content</p></RequireAuth>);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  test('auth pages remain hidden during initialization and render only for signed-out users', () => {
    mockUseAuth.mockReturnValue(auth('initializing'));
    const mounted = jest.fn();
    function LoginForm() { mounted(); return <p>Login form</p>; }
    const view = render(<AuthOnlyRoute><LoginForm /></AuthOnlyRoute>);
    expect(mounted).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    mockUseAuth.mockReturnValue(auth('unauthenticated'));
    view.rerender(<AuthOnlyRoute><LoginForm /></AuthOnlyRoute>);
    expect(screen.getByText('Login form')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  test('authenticated login route returns to Messenger once without mounting the form or looping', () => {
    window.history.replaceState({}, '', '/login?next=%2F%23security');
    mockUseAuth.mockReturnValue(auth('authenticated'));
    const mounted = jest.fn();
    function LoginForm() { mounted(); return <p>Login form</p>; }
    const view = render(<AuthOnlyRoute><LoginForm /></AuthOnlyRoute>);
    expect(replace).toHaveBeenCalledWith('/#security');
    expect(mounted).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Opening Messenger');
    mockUseRouter.mockReturnValue({ replace } as unknown as ReturnType<typeof useRouter>);
    view.rerender(<AuthOnlyRoute><LoginForm /></AuthOnlyRoute>);
    expect(replace).toHaveBeenCalledTimes(1);
    window.history.replaceState({}, '', '/#security');
    view.rerender(<AuthOnlyRoute><LoginForm /></AuthOnlyRoute>);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  test.each(['https://untrusted.example', '//untrusted.example', '/login', '/signup', '%2F%2Funtrusted.example'])('auth redirect rejects %s', (next) => {
    window.history.replaceState({}, '', `/login?next=${encodeURIComponent(next)}`);
    mockUseAuth.mockReturnValue(auth('authenticated'));
    render(<AuthOnlyRoute><p>Login form</p></AuthOnlyRoute>);
    expect(replace).toHaveBeenCalledWith('/');
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
