import { act, render } from '@testing-library/react';
import { ApiRealtimeConnection } from '../ApiRealtimeConnection';
import { createSessionRealtimeClient } from '@/realtime/createRealtimeClient';
import type { AuthUser } from '@/auth/authModel';
import type { RealtimeClient, RealtimeEvent } from '@/realtime/realtimeModel';

const mockRestoreSession = jest.fn(async () => undefined);
jest.mock('@/auth/AuthProvider', () => ({ useAuth: () => ({ restoreSession: mockRestoreSession }) }));
jest.mock('@/realtime/createRealtimeClient', () => ({ createSessionRealtimeClient: jest.fn() }));
const factory = jest.mocked(createSessionRealtimeClient);
const user: AuthUser = { id: 'api-user', username: 'api-user', displayName: 'User', avatar: 'initials', isDemo: false };

beforeEach(() => { jest.clearAllMocks(); });

test('only explicit authentication rejection revalidates the existing auth provider', async () => {
  let notify!: (event: RealtimeEvent) => void;
  const unsubscribe = jest.fn(); const dispose = jest.fn();
  factory.mockReturnValue({
    connect: jest.fn(async () => undefined), getStatus: () => 'connected', dispose,
    subscribe: (listener: (event: RealtimeEvent) => void) => { notify = listener; return unsubscribe; },
  } as unknown as RealtimeClient);
  const { unmount } = render(<ApiRealtimeConnection user={user} />);
  await act(async () => {
    notify({ type: 'error', code: 'unavailable', serverCode: 'REALTIME_UNAVAILABLE' });
    notify({ type: 'error', code: 'policy_denied', serverCode: 'POLICY_DENIED' });
    notify({ type: 'connection', status: 'disconnected' });
  });
  expect(mockRestoreSession).not.toHaveBeenCalled();
  await act(async () => { notify({ type: 'error', code: 'authentication_rejected', serverCode: 'SESSION_EXPIRED' }); });
  expect(mockRestoreSession).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith(user, 'api', []);
  unmount();
  expect(dispose).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1);
  await act(async () => { notify({ type: 'error', code: 'authentication_rejected', serverCode: 'SESSION_EXPIRED' }); });
  expect(mockRestoreSession).toHaveBeenCalledTimes(1);
});

test('unavailable real initialization does not request demo transport or invalidate a valid session', () => {
  factory.mockImplementationOnce(() => { throw new Error('unavailable'); });
  render(<ApiRealtimeConnection user={user} />);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith(user, 'api', []);
  expect(mockRestoreSession).not.toHaveBeenCalled();
});
