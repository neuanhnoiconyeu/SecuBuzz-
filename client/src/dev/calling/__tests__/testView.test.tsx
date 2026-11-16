import { render, screen } from '@testing-library/react';
import { DevelopmentCallingTestView } from '../DevelopmentCallingTestView';
import { useAuth } from '@/auth/AuthProvider';
import { ApiRealtimeConnection } from '@/components/messenger/ApiRealtimeConnection';

jest.mock('@/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/components/messenger/ApiRealtimeConnection', () => ({ ApiRealtimeConnection: jest.fn(() => <p>Authenticated call runtime</p>) }));
const user = { id: 'call-dev-alice', username: 'alice', displayName: 'Alice', avatar: 'initials' as const, isDemo: false };
beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development', NEXT_PUBLIC_DEV_CALLS_ENABLED: 'true' });
  (useAuth as jest.Mock).mockReturnValue({ user, mode: 'api', status: 'authenticated', sessionVersion: 1 });
});
afterEach(() => jest.restoreAllMocks());

test('mounts exactly the existing API connection boundary for the authenticated development user', () => {
  render(<DevelopmentCallingTestView user={user} />);
  expect(screen.getByText('Authenticated call runtime')).toBeInTheDocument();
  expect(ApiRealtimeConnection).toHaveBeenCalledWith(expect.objectContaining({ user }), expect.anything());
});

test.each(['production', 'no-opt-in', 'demo', 'anonymous', 'wrong-user'])('%s cannot activate the real test view', mode => {
  if (mode === 'production') jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
  if (mode === 'no-opt-in') jest.replaceProperty(process, 'env', { ...process.env, NEXT_PUBLIC_DEV_CALLS_ENABLED: 'false' });
  if (mode === 'demo') (useAuth as jest.Mock).mockReturnValue({ user: { ...user, isDemo: true }, mode: 'demo', status: 'authenticated' });
  if (mode === 'anonymous') (useAuth as jest.Mock).mockReturnValue({ user: null, mode: 'api', status: 'unauthenticated' });
  if (mode === 'wrong-user') (useAuth as jest.Mock).mockReturnValue({ user: { ...user, id: 'other-user' }, mode: 'api', status: 'authenticated' });
  const { container } = render(<DevelopmentCallingTestView user={user} />);
  expect(container).toBeEmptyDOMElement(); expect(ApiRealtimeConnection).not.toHaveBeenCalled();
});
