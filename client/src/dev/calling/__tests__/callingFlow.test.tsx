import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DirectCallsRuntime } from '@/components/calls/DirectCallsRuntime';
import { useAuth } from '@/auth/AuthProvider';
import { createSessionLiveKitConnection } from '@/voice/livekitConnection';
import { DevelopmentCallingWorkspace } from '../DevelopmentCallingWorkspace';
import { alice, bob, identity, callId, CallTestBroker, callMediaService } from '@/test-support/directCallFixture';
import { CALL_CLIENT_EVENTS as C } from '../../../../../shared/directCalls';

jest.mock('@/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/voice/livekitConnection', () => ({ ...jest.requireActual('@/voice/livekitConnection'), createSessionLiveKitConnection: jest.fn() }));
const originalFetch = global.fetch;
beforeEach(() => {
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

async function view(user = alice) {
  const peer = user.id === alice.id ? bob : alice;
  const broker = new CallTestBroker(), client = broker.client(user), media = callMediaService(user);
  (useAuth as jest.Mock).mockReturnValue({ user, mode: 'api', sessionVersion: 1, logout: jest.fn(), restoreSession: jest.fn() });
  jest.mocked(createSessionLiveKitConnection).mockReturnValue(media.service);
  // Only transport and SDK boundaries are doubled; the actual runtime, state machine and UI are composed here.
  global.fetch = jest.fn(async input => ({ ok: true, json: async () => String(input).endsWith('/context')
    ? { developmentOnly: true, user, peer, conversation: { id: 'dm-ab', type: 'direct', participants: [user, peer] } }
    : { developmentOnly: true, livekit: 'available' } } as Response));
  const result = render(<DirectCallsRuntime client={client.port()} user={user}>
    <DevelopmentCallingWorkspace user={user} /><textarea aria-label="Conversation draft" />
  </DirectCallsRuntime>);
  await waitFor(() => expect(screen.getByRole('button', { name: `Voice call ${peer.displayName}` })).toBeEnabled());
  return { ...result, broker, client, media, user, peer };
}
async function accept(context: Awaited<ReturnType<typeof view>>) {
  await act(async () => { await context.broker.request(context.peer.id, C.accept, { callId }); });
  await waitFor(() => expect(context.media.room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything()));
}

test('outgoing UI waits for media and the authorized peer; minimizing preserves the same connection and draft', async () => {
  const context = await view();
  fireEvent.click(screen.getByRole('button', { name: 'Voice call Bob' }));
  await screen.findByText('Ringing');
  expect(context.media.room.connect).not.toHaveBeenCalled();
  expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  expect(screen.queryByText(/UI preview/)).not.toBeInTheDocument();
  await accept(context);
  expect(screen.getByText('Connecting')).toBeInTheDocument();
  expect(screen.queryByLabelText('Call duration')).not.toBeInTheDocument();
  act(() => { context.media.room.addParticipant('c'.repeat(64), 'Outsider'); });
  expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  act(() => { context.media.room.addParticipant(identity(bob.id), bob.displayName); });
  await screen.findByText('Connected');
  expect(screen.getByLabelText('Call duration')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Minimize call' }));
  fireEvent.change(screen.getByLabelText('Conversation draft'), { target: { value: 'Keep messaging' } });
  expect(screen.getByLabelText('Conversation draft')).toHaveValue('Keep messaging');
  expect(context.media.room.connect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Hang up call' }));
  await screen.findByText('Ended');
  expect(context.client.calls.request).toHaveBeenCalledWith(C.end, { callId });
  expect(context.media.room.disconnect).toHaveBeenCalled();
});

test('incoming notification uses real call actions to decline or accept and keeps media off before acceptance', async () => {
  const context = await view(bob);
  await act(async () => { await context.broker.request(alice.id, C.initiate, { kind: 'voice' }); });
  let notification = within(screen.getByRole('dialog', { name: 'Alice' }));
  expect(context.media.room.connect).not.toHaveBeenCalled();
  fireEvent.click(notification.getByRole('button', { name: 'Decline' }));
  await screen.findByText('Declined');
  expect(context.client.calls.request).toHaveBeenCalledWith(C.decline, { callId });
  expect(context.media.room.connect).not.toHaveBeenCalled();
  // Use a fresh view/broker, since real calls always receive a new server-owned ID.
  context.unmount();
  const fresh = await view(bob);
  await act(async () => { await fresh.broker.request(alice.id, C.initiate, { kind: 'voice' }); });
  notification = within(screen.getByRole('dialog', { name: 'Alice' }));
  fireEvent.click(notification.getByRole('button', { name: 'Accept' }));
  await screen.findByText('Connecting');
  await waitFor(() => expect(fresh.media.room.connect).toHaveBeenCalledTimes(1));
  expect(fresh.client.calls.request).toHaveBeenCalledWith(C.accept, { callId });
  expect(screen.queryByText('Connected')).not.toBeInTheDocument();
});

test('video connects existing media controls and tracks, with one room and cleanup on hangup', async () => {
  const context = await view();
  fireEvent.click(screen.getByRole('button', { name: 'Video call Bob' }));
  await screen.findByText('Ringing'); await accept(context);
  await waitFor(() => expect(context.media.room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true));
  act(() => { const remote = context.media.room.addParticipant(identity(bob.id), bob.displayName); context.media.room.addCamera(remote.person); });
  await screen.findByText('Connected');
  expect(screen.getByLabelText('Your camera')).toBeInTheDocument();
  expect(screen.getByLabelText("Bob's camera")).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Turn call camera off' }));
  await waitFor(() => expect(screen.queryByLabelText('Your camera')).not.toBeInTheDocument());
  expect(context.media.room.connect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Hang up call' }));
  await screen.findByText('Ended');
  expect(document.querySelectorAll('video,audio')).toHaveLength(0);
});

test('outgoing hangup cancels the invitation without ever starting capture', async () => {
  const context = await view();
  fireEvent.click(screen.getByRole('button', { name: 'Voice call Bob' }));
  await screen.findByText('Ringing');
  fireEvent.click(screen.getByRole('button', { name: 'Hang up call' }));
  await screen.findByText('Ended');
  expect(context.client.calls.request).toHaveBeenCalledWith(C.cancel, { callId });
  expect(context.media.room.connect).not.toHaveBeenCalled();
  expect(context.media.room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
});
