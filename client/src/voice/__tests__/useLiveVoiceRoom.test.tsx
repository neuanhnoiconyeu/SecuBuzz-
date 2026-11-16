import { useState } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { VoiceRoomPanel } from '@/components/voice/VoiceRoomPanel';
import { VoiceRoomsSidebar } from '@/components/voice/VoiceRoomsSidebar';
import { VoiceRoomAudio } from '@/components/voice/VoiceMedia';
import { VOICE_ROOMS } from '../voiceRooms';
import { useLiveVoiceRoom } from '../useLiveVoiceRoom';
import { LiveKitConnectionService } from '../livekitConnection';
import { deferred, TestVoiceRoom, TestPublication, voiceService, voiceUser } from '@/test-support/liveVoiceFixture';

beforeEach(() => {
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function RoomUI({ service }: { service: LiveKitConnectionService }) {
  const controller = useLiveVoiceRoom(service, voiceUser);
  const [selected, setSelected] = useState('lounge');
  return <>
    <VoiceRoomsSidebar live={controller} selectedRoomId={selected} joinedRoomId={controller.joinedRoomId} onSelect={setSelected} onLeave={() => void controller.leave()} />
    <VoiceRoomPanel room={VOICE_ROOMS.find((room) => room.id === selected)!} controller={controller} user={voiceUser} onBack={() => {}} />
    <VoiceRoomAudio controller={controller} />
  </>;
}

test('joins an empty room directly, publishes the microphone and waits alone without a host', async () => {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  const { result, unmount } = renderHook(() => useLiveVoiceRoom(service, voiceUser));
  await act(async () => { await result.current.join('lounge'); });
  expect(result.current.status).toBe('connected'); expect(result.current.joinedRoomId).toBe('lounge');
  expect(result.current.participants).toHaveLength(1);
  expect(result.current.microphoneEnabled).toBe(true);
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ echoCancellation: true }));
  expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  expect(room.connect).toHaveBeenCalledTimes(1);
  unmount(); expect(room.listenerCount('participantConnected')).toBe(0);
});

test('denied microphone access keeps the user joined and listening, with an actionable error', async () => {
  const room = new TestVoiceRoom(); room.localParticipant.setMicrophoneEnabled.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  const service = voiceService([room]);
  const { result, unmount } = renderHook(() => useLiveVoiceRoom(service, voiceUser));
  await act(async () => { await result.current.join('lounge'); });
  expect(result.current.status).toBe('connected'); expect(result.current.microphoneEnabled).toBe(false);
  expect(result.current.errors.audio).toMatch(/permission was denied/);
  act(() => { room.addParticipant(); });
  expect(result.current.audio).toHaveLength(1);
  expect(result.current.pending.audio).toBe(false);
  unmount();
});

test('SDK participant, track, mute and active-speaker events update the roster truthfully', async () => {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  const { result, unmount } = renderHook(() => useLiveVoiceRoom(service, voiceUser));
  await act(async () => { await result.current.join('lounge'); });
  let remote!: ReturnType<TestVoiceRoom['addParticipant']>;
  act(() => { remote = room.addParticipant(); room.speaking([remote.person]); });
  expect(result.current.participants).toHaveLength(2); expect(result.current.audio[0]?.track).toBe(remote.publication.track);
  expect(result.current.participants.find((person) => !person.isLocal)?.speaking).toBe(true);
  act(() => { remote.publication.isMuted = true; room.emit('trackMuted', remote.publication, remote.person); });
  expect(result.current.participants.find((person) => !person.isLocal)?.microphoneEnabled).toBe(false);
  expect(result.current.participants.find((person) => !person.isLocal)?.speaking).toBe(false);
  act(() => { room.removeParticipant(remote.person); });
  expect(result.current.participants).toHaveLength(1); expect(result.current.audio).toHaveLength(0);
  unmount();
});

test('mute/unmute uses SDK publication controls and reconnecting clears stale speaking indicators', async () => {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  const { result, unmount } = renderHook(() => useLiveVoiceRoom(service, voiceUser));
  await act(async () => { await result.current.join('lounge'); await result.current.toggleDevice('audio'); });
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false, expect.anything());
  expect(result.current.microphoneEnabled).toBe(false);
  await act(async () => { await result.current.toggleDevice('audio'); });
  act(() => { room.speaking([room.localParticipant]); });
  expect(result.current.participants[0]?.speaking).toBe(true);
  act(() => { room.changeState('reconnecting'); });
  expect(result.current.status).toBe('reconnecting'); expect(result.current.participants[0]?.speaking).toBe(false);
  act(() => { room.changeState('connected'); });
  expect(result.current.status).toBe('connected'); expect(result.current.participants[0]?.speaking).toBe(false);
  act(() => { room.speaking([room.localParticipant]); });
  expect(result.current.participants[0]?.speaking).toBe(true);
  unmount();
});

test('late microphone permission after leaving stops captured tracks and cannot resurrect membership', async () => {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  const grant = deferred<TestPublication>(); const requested = deferred<void>();
  room.localParticipant.setMicrophoneEnabled.mockImplementation(async () => { requested.resolve(); return grant.promise; });
  const { result, unmount } = renderHook(() => useLiveVoiceRoom(service, voiceUser));
  let joining!: Promise<void>;
  await act(async () => { joining = result.current.join('lounge'); await requested.promise; });
  await act(async () => { await result.current.leave(); });
  const publication = new TestPublication('audio', 'late-microphone');
  await act(async () => { grant.resolve(publication); await joining; });
  expect(publication.track.stop).toHaveBeenCalled();
  expect(result.current.joinedRoomId).toBeNull(); expect(result.current.pending.audio).toBe(false);
  expect(room.disconnect).toHaveBeenCalledWith(true);
  unmount();
});

test('switching rooms invalidates device requests and disposes the previous room listeners', async () => {
  const first = new TestVoiceRoom(); const second = new TestVoiceRoom(); const service = voiceService([first, second]);
  const pending = deferred<TestPublication>(); const requested = deferred<void>();
  first.localParticipant.setMicrophoneEnabled.mockImplementation(async () => { requested.resolve(); return pending.promise; });
  const { result, unmount } = renderHook(() => useLiveVoiceRoom(service, voiceUser));
  let joining!: Promise<void>;
  await act(async () => { joining = result.current.join('lounge'); await requested.promise; });
  await act(async () => { await result.current.join('study-room'); });
  const old = new TestPublication('audio', 'old');
  await act(async () => { pending.resolve(old); await joining; });
  expect(old.track.stop).toHaveBeenCalled(); expect(first.listenerCount('activeSpeakersChanged')).toBe(0);
  expect(result.current.joinedRoomId).toBe('study-room'); expect(result.current.microphoneEnabled).toBe(true);
  unmount(); expect(second.disconnect).toHaveBeenCalledWith(true);
});

test('the UI attaches remote audio, preserves playback while browsing, and detaches on departure', async () => {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  const { unmount } = render(<RoomUI service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected · Waiting alone'));
  let remote!: ReturnType<TestVoiceRoom['addParticipant']>;
  act(() => { remote = room.addParticipant(); room.speaking([remote.person]); });
  const audio = document.querySelector('audio')!;
  expect(remote.publication.track.attach).toHaveBeenCalledWith(audio);
  expect(within(screen.getByRole('list', { name: 'Room participants' })).getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByLabelText('Remote User, speaking')).toHaveClass('is-speaking');
  fireEvent.click(screen.getByRole('button', { name: 'Study Room, participant count unavailable' }));
  expect(document.querySelector('audio')).toBe(audio); expect(remote.publication.track.detach).not.toHaveBeenCalled();
  act(() => { room.removeParticipant(remote.person); });
  expect(remote.publication.track.detach).toHaveBeenCalledWith(audio); expect(audio.srcObject).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Leave Lounge' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Lounge, participant count unavailable' })).toBeInTheDocument());
  expect(screen.getByRole('list', { name: 'Available voice rooms' }).children).toHaveLength(3);
  unmount();
});

test('blocked autoplay offers a user-gesture playback action', async () => {
  const room = new TestVoiceRoom(); room.canPlaybackAudio = false;
  room.startAudio.mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'));
  const service = voiceService([room]);
  render(<RoomUI service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  const enable = await screen.findByRole('button', { name: 'Enable sound' });
  room.startAudio.mockImplementation(async () => { room.canPlaybackAudio = true; room.emit('audioPlaybackChanged', true); });
  fireEvent.click(enable);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Enable sound' })).not.toBeInTheDocument());
  expect(room.startAudio).toHaveBeenCalledTimes(2);
});

test('a terminal disconnect stops media and clears participants without removing the catalog', async () => {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  render(<RoomUI service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  await screen.findByRole('button', { name: 'Mute microphone' });
  const track = room.localParticipant.trackPublications.get('audio')!.track;
  act(() => { room.addParticipant(); room.changeState('disconnected'); });
  expect(track.stop).toHaveBeenCalled(); expect(document.querySelector('audio')).toBeNull();
  expect(screen.queryByRole('list', { name: 'Room participants' })).not.toBeInTheDocument();
  expect(room.listenerCount('participantConnected')).toBe(0);
  expect(screen.getByRole('list', { name: 'Available voice rooms' }).children).toHaveLength(3);
});
