import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/auth/AuthProvider';
import { AuthenticatedWorkspace } from '@/auth/AuthenticatedWorkspace';
import type { AuthService } from '@/auth/authService';
import * as connections from '../livekitConnection';
import { TestVoiceRoom, voiceService, voiceUser } from '@/test-support/liveVoiceFixture';

jest.mock('../livekitConnection', () => ({ ...jest.requireActual('../livekitConnection'), createSessionLiveKitConnection: jest.fn() }));

function account() {
  return { mode: 'api', getCurrentUser: async () => voiceUser, login: jest.fn(), register: jest.fn(), logout: jest.fn().mockResolvedValue(undefined) } satisfies AuthService;
}
beforeEach(() => {
  const actual = jest.requireActual<typeof connections>('../livekitConnection');
  (connections.createSessionLiveKitConnection as jest.Mock).mockReset().mockImplementation(actual.createSessionLiveKitConnection);
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('a real account can browse the room catalog while unavailable without receiving demo participants', async () => {
  const auth = account();
  render(<AuthProvider service={auth}><AuthenticatedWorkspace /></AuthProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Voice Rooms' }));
  await screen.findByRole('heading', { name: 'Lounge' });
  expect(screen.getByRole('button', { name: 'Join room' })).toBeDisabled();
  expect(screen.queryByText('Ava Morgan')).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Room participants' })).not.toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Available voice rooms' }).children).toHaveLength(3);
  expect(screen.getAllByRole('status').some(status => status.textContent?.includes('Live voice unavailable'))).toBe(true);
});

test('the account view connects the existing room UI and account navigation disposes media', async () => {
  const room = new TestVoiceRoom();
  const service = voiceService([room]);
  const factory = (connections.createSessionLiveKitConnection as jest.Mock).mockReturnValue(service);
  const { unmount } = render(<AuthProvider service={account()}><AuthenticatedWorkspace /></AuthProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Voice Rooms' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Join room' })).toBeEnabled());
  expect(factory).toHaveBeenCalledWith(expect.objectContaining({ id: voiceUser.id, isDemo: false }), 'api', expect.any(Function));
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  await screen.findByRole('button', { name: 'Mute microphone' });
  expect(room.connect).toHaveBeenCalledTimes(1);
  const microphone = room.localParticipant.trackPublications.get('audio')!.track;
  let remote!: ReturnType<TestVoiceRoom['addParticipant']>;
  act(() => { remote = room.addParticipant(); });
  expect(remote.publication.track.attach).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Back to account' }));
  await screen.findByRole('button', { name: 'Open Voice Rooms' });
  expect(room.disconnect).toHaveBeenCalledWith(true); expect(microphone.stop).toHaveBeenCalled();
  expect(remote.publication.track.detach).toHaveBeenCalled();
  expect(room.listenerCount('participantConnected')).toBe(0);
  unmount();
});

test('logout unmounts the voice session and releases microphone tracks and listeners', async () => {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  (connections.createSessionLiveKitConnection as jest.Mock).mockReturnValue(service);
  const auth = account();
  render(<AuthProvider service={auth}><AuthenticatedWorkspace /></AuthProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Voice Rooms' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Join room' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  await screen.findByRole('button', { name: 'Mute microphone' });
  const track = room.localParticipant.trackPublications.get('audio')!.track;
  fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Lounge' })).not.toBeInTheDocument());
  expect(auth.logout).toHaveBeenCalledTimes(1); expect(track.stop).toHaveBeenCalled();
  expect(room.disconnect).toHaveBeenCalledWith(true); expect(room.listenerCount('activeSpeakersChanged')).toBe(0);
});
