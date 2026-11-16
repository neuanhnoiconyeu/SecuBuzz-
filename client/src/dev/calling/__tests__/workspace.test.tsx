import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DevelopmentCallingWorkspace } from '../DevelopmentCallingWorkspace';
import { useDirectCalls } from '@/components/calls/DirectCallsRuntime';
import { useAuth } from '@/auth/AuthProvider';

jest.mock('@/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/components/calls/DirectCallsRuntime', () => ({ useDirectCalls: jest.fn() }));
const user = { id: 'call-dev-alice', username: 'alice', displayName: 'Alice', avatar: 'initials' as const, isDemo: false };
const peer = { id: 'call-dev-bob', displayName: 'Bob' };
const target = { developmentOnly: true, user, peer, conversation: { id: 'calling-dev-alice-bob', type: 'direct', participants: [user, peer] } };
let start: jest.Mock;
const originalFetch = global.fetch;
beforeEach(() => {
  start = jest.fn();
  (useAuth as jest.Mock).mockReturnValue({ logout: jest.fn(), pending: null });
  (useDirectCalls as jest.Mock).mockReturnValue({ start, canStart: true, available: true, signalStatus: 'connected', state: { phase: 'idle' }, media: { connectionError: null } });
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

function responses(livekit: string, context = target) {
  global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => context })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ developmentOnly: true, livekit }) });
}
test('starts voice/video using only the authenticated target and existing call controller', async () => {
  responses('available'); render(<DevelopmentCallingWorkspace user={user} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Voice call Bob' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Voice call Bob' }));
  fireEvent.click(screen.getByRole('button', { name: 'Video call Bob' }));
  expect(start.mock.calls).toEqual([['calling-dev-alice-bob', { id: peer.id, name: peer.displayName }, 'voice'], ['calling-dev-alice-bob', { id: peer.id, name: peer.displayName }, 'video']]);
});
test('unavailable media disables calls and allows an explicit service retry', async () => {
  responses('unavailable'); render(<DevelopmentCallingWorkspace user={user} />);
  await screen.findByText('unavailable');
  expect(screen.getByRole('button', { name: 'Voice call Bob' })).toBeDisabled();
  responses('available'); fireEvent.click(screen.getByRole('button', { name: 'Retry service check' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Voice call Bob' })).toBeEnabled());
  expect(start).not.toHaveBeenCalled();
});
test('a context belonging to a different signed-in user never enables calling', async () => {
  responses('available', { ...target, user: { ...user, id: 'wrong-user' } }); render(<DevelopmentCallingWorkspace user={user} />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('group', { name: 'Direct call actions' })).not.toBeInTheDocument();
});
