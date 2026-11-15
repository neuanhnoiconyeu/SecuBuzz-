import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { VoiceRoomPanel } from '@/components/voice/VoiceRoomPanel';
import { VoiceRoomsSidebar } from '@/components/voice/VoiceRoomsSidebar';
import { MessengerHarness } from '@/test-support/MessengerHarness';
import { createDemoProfile } from '@/profiles/profileModel';
import { VOICE_ROOMS } from '../voiceRooms';
import { useVoiceRooms } from '../useVoiceRooms';

const session = {};
const getUserMedia = jest.fn();
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

function deviceStream(device: 'audio' | 'video') {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop: jest.fn() });
  track.stop.mockImplementation(() => { track.readyState = 'ended'; });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => device === 'audio' ? [track] : [],
    getVideoTracks: () => device === 'video' ? [track] : [],
  } as unknown as MediaStream;
  return { stream, track };
}

function RoomHarness() {
  const controller = useVoiceRooms(session);
  return <>
    <VoiceRoomsSidebar selectedRoomId="lounge" joinedRoomId={controller.joinedRoomId} onSelect={jest.fn()} onLeave={controller.leave} />
    <VoiceRoomPanel room={VOICE_ROOMS[0]!} controller={controller} user={createDemoProfile()} onBack={jest.fn()} />
  </>;
}

beforeEach(() => {
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  getUserMedia.mockReset();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
});

test('keeps an empty catalog visible and reports unavailable voice without inventing occupancy', () => {
  render(<RoomHarness />);
  const catalog = within(screen.getByRole('list', { name: 'Available voice rooms' }));
  expect(catalog.getAllByRole('button')).toHaveLength(3);
  for (const room of VOICE_ROOMS) expect(catalog.getByRole('button', { name: `${room.name}, 0 local participants` })).toBeEnabled();
  expect(screen.getByText('Voice unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Room participants' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unmute microphone' })).toBeDisabled();
  expect(getUserMedia).not.toHaveBeenCalled();
});

test('joins alone with the current user and leaves without removing rooms or claiming a connection', () => {
  render(<RoomHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  expect(screen.getByRole('status')).toHaveTextContent('Waiting alone · Local preview');
  expect(within(screen.getByRole('list', { name: 'Room participants' })).getAllByRole('listitem')).toHaveLength(1);
  expect(within(screen.getByRole('list', { name: 'Room participants' })).getByRole('img', { name: 'Demo Explorer' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Lounge, 1 local participant' })).toBeInTheDocument();
  expect(screen.getByText('Voice unavailable')).toBeInTheDocument();
  expect(getUserMedia).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
  expect(screen.getByRole('button', { name: 'Lounge, 0 local participants' })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Available voice rooms' }).children).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Join room' })).toBeEnabled();
});

test('device buttons reflect actual granted tracks and camera shows a muted local preview', async () => {
  const audio = deviceStream('audio');
  const video = deviceStream('video');
  getUserMedia.mockResolvedValueOnce(audio.stream).mockResolvedValueOnce(video.stream);
  render(<RoomHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  fireEvent.click(screen.getByRole('button', { name: 'Unmute microphone' }));
  expect(await screen.findByRole('button', { name: 'Mute microphone' })).toHaveAttribute('aria-pressed', 'true');
  expect(getUserMedia).toHaveBeenNthCalledWith(1, { audio: true, video: false });
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' }));
  const preview = await screen.findByLabelText('Your local camera preview');
  expect(preview).toHaveProperty('srcObject', video.stream);
  expect(preview).toHaveProperty('muted', true);
  expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: false, video: true });
  fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
  expect(audio.track.stop).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
  expect(video.track.stop).toHaveBeenCalledTimes(1);
  expect(preview).toHaveProperty('srcObject', null);
});

test('denied permission leaves the microphone muted and displays the actual error', async () => {
  getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  render(<RoomHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  fireEvent.click(screen.getByRole('button', { name: 'Unmute microphone' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Microphone permission was denied');
  expect(screen.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('Voice unavailable')).toBeInTheDocument();
});

test('late device permission after leaving is released and cannot attach to another room', async () => {
  const video = deviceStream('video');
  let grant!: (stream: MediaStream) => void;
  getUserMedia.mockReturnValue(new Promise<MediaStream>((resolve) => { grant = resolve; }));
  const { result } = renderHook(() => useVoiceRooms(session));
  act(() => result.current.join('lounge'));
  let pending!: Promise<void>;
  act(() => { pending = result.current.toggleDevice('video'); });
  expect(result.current.pending.video).toBe(true);
  act(() => { result.current.leave(); result.current.join('study-room'); });
  await act(async () => { grant(video.stream); await pending; });
  expect(video.track.stop).toHaveBeenCalledTimes(1);
  expect(result.current.joinedRoomId).toBe('study-room');
  expect(result.current.streams.video).toBeNull();
  expect(result.current.pending.video).toBe(false);
});

test('switching rooms, replacing a session, and unmounting release all devices', async () => {
  const audio = deviceStream('audio');
  const camera = deviceStream('video');
  getUserMedia.mockResolvedValueOnce(audio.stream).mockResolvedValueOnce(camera.stream);
  const { result, rerender, unmount } = renderHook(({ identity }) => useVoiceRooms(identity), { initialProps: { identity: session } });
  act(() => result.current.join('lounge'));
  await act(async () => { await result.current.toggleDevice('audio'); });
  act(() => result.current.join('study-room'));
  expect(audio.track.stop).toHaveBeenCalledTimes(1);
  expect(result.current.streams.audio).toBeNull();
  await act(async () => { await result.current.toggleDevice('video'); });
  rerender({ identity: {} });
  expect(camera.track.stop).toHaveBeenCalledTimes(1);
  expect(result.current.joinedRoomId).toBeNull();
  const next = deviceStream('audio');
  getUserMedia.mockResolvedValueOnce(next.stream);
  act(() => result.current.join('dev-corner'));
  await act(async () => { await result.current.toggleDevice('audio'); });
  unmount();
  expect(next.track.stop).toHaveBeenCalledTimes(1);
});

test('device access ending externally updates controls instead of leaving a false enabled state', async () => {
  const audio = deviceStream('audio');
  getUserMedia.mockResolvedValue(audio.stream);
  render(<RoomHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  fireEvent.click(screen.getByRole('button', { name: 'Unmute microphone' }));
  await screen.findByRole('button', { name: 'Mute microphone' });
  act(() => { audio.track.dispatchEvent(new Event('ended')); });
  expect(screen.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('alert')).toHaveTextContent('Microphone access ended');
});

test('the messenger sidebar opens rooms, preserves membership while browsing chats, and keeps the catalog after leave', async () => {
  render(<MessengerHarness />);
  await screen.findByRole('textbox', { name: 'Message to SecureBot' });
  fireEvent.click(screen.getByRole('button', { name: 'Lounge, 0 local participants' }));
  expect(screen.getByRole('heading', { name: 'Lounge' })).toHaveFocus();
  expect(screen.queryByRole('textbox', { name: 'Message to SecureBot' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  fireEvent.click(screen.getByRole('button', { name: /^SecureBot, Bot/ }));
  expect(screen.getByRole('textbox', { name: 'Message to SecureBot' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Lounge, 1 local participant' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Leave Lounge' }));
  expect(screen.getByRole('button', { name: 'Lounge, 0 local participants' })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Available voice rooms' }).children).toHaveLength(3);
});
