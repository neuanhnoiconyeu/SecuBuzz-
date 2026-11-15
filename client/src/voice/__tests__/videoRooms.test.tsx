import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { VoiceRoomPanel } from '@/components/voice/VoiceRoomPanel';
import { VoiceRoomAudio } from '@/components/voice/VoiceMedia';
import { useLiveVoiceRoom } from '../useLiveVoiceRoom';
import type { LiveKitConnectionService } from '../livekitConnection';
import { VOICE_ROOMS } from '../voiceRooms';
import { deferred, TestVoiceRoom, TestPublication, TestTrack, voiceService, voiceUser } from '@/test-support/liveVoiceFixture';

const originalRequest = Object.getOwnPropertyDescriptor(Element.prototype, 'requestFullscreen');
const originalExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
const originalElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
const originalEnabled = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled');
const nativeNames = ['webkitEnterFullscreen', 'webkitExitFullscreen', 'webkitSupportsFullscreen'] as const;
const originalNative = nativeNames.map((name) => Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, name));
let fullscreenElement: Element | null;
let requestFullscreen: jest.Mock;
let exitFullscreen: jest.Mock;
const enterFullscreen = (element: Element) => { fullscreenElement = element; document.dispatchEvent(new Event('fullscreenchange')); };

beforeEach(() => {
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  fullscreenElement = null;
  requestFullscreen = jest.fn(async function (this: Element) { enterFullscreen(this); });
  exitFullscreen = jest.fn(async () => { fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange')); });
  Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [target, name, original] of [[Element.prototype, 'requestFullscreen', originalRequest], [document, 'exitFullscreen', originalExit],
    [document, 'fullscreenElement', originalElement], [document, 'fullscreenEnabled', originalEnabled],
    ...nativeNames.map((name, index) => [HTMLVideoElement.prototype, name, originalNative[index]] as const)] as const) {
    if (original) Object.defineProperty(target, name, original); else Reflect.deleteProperty(target, name);
  }
});

function RoomUI({ service }: { service: LiveKitConnectionService }) {
  const controller = useLiveVoiceRoom(service, voiceUser);
  return <><VoiceRoomPanel room={VOICE_ROOMS[0]!} controller={controller} user={voiceUser} onBack={() => {}} /><VoiceRoomAudio controller={controller} /></>;
}
async function joined() {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  const view = render(<RoomUI service={service} />);
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
  await screen.findByRole('button', { name: 'Mute microphone' });
  return { room, service, ...view };
}
const tile = (id: string) => document.querySelector<HTMLElement>(`[data-participant-id="${id}"]`)!;

test('camera toggles publish/unpublish video on the same connection without interrupting microphone or remote audio', async () => {
  const { room, service } = await joined();
  let remote!: ReturnType<TestVoiceRoom['addParticipant']>;
  act(() => { remote = room.addParticipant(); });
  const audio = document.querySelector('audio');
  const microphone = room.localParticipant.trackPublications.get('audio')!.track;
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' }));
  const video = await screen.findByLabelText('Your camera');
  expect(video).toHaveProperty('muted', true); expect(video).toHaveClass('is-local');
  expect(tile('local-identity')).toHaveAttribute('data-camera', 'loading');
  fireEvent.loadedData(video);
  expect(tile('local-identity')).toHaveAttribute('data-camera', 'live');
  expect(within(tile('local-identity')).queryByRole('img')).not.toBeInTheDocument();
  const camera = room.localParticipant.trackPublications.get('video')!.track;
  expect(camera.attach).toHaveBeenCalledWith(video);
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera off' }));
  await waitFor(() => expect(tile('local-identity')).toHaveAttribute('data-camera', 'off'));
  expect(within(tile('local-identity')).getByRole('img', { name: voiceUser.displayName })).toBeInTheDocument();
  expect(camera.detach).toHaveBeenCalledWith(video); expect(video).toHaveProperty('srcObject', null);
  expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(false);
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1); expect(microphone.stop).not.toHaveBeenCalled();
  expect(document.querySelector('audio')).toBe(audio); expect(remote.publication.track.attach).toHaveBeenCalledTimes(1);
  expect(remote.publication.track.detach).not.toHaveBeenCalled(); expect(room.connect).toHaveBeenCalledTimes(1);
  expect(room.disconnect).not.toHaveBeenCalled(); expect(service.getSnapshot().status).toBe('connected');
});

test('multiple remote cameras and avatars update as people publish, mute their cameras and leave', async () => {
  const { room } = await joined();
  let first!: ReturnType<TestVoiceRoom['addParticipant']>;
  let second!: ReturnType<TestVoiceRoom['addParticipant']>;
  let firstVideo!: TestPublication; let secondVideo!: TestPublication;
  act(() => {
    first = room.addParticipant('one', 'First User'); second = room.addParticipant('two', 'Second User');
    firstVideo = room.addCamera(first.person); secondVideo = room.addCamera(second.person);
  });
  expect(document.querySelector('.voice-stage')).toHaveAttribute('data-participant-count', '3');
  expect(document.querySelectorAll('.voice-participant-tile')).toHaveLength(3);
  const firstElement = screen.getByLabelText("First User's camera");
  const secondElement = screen.getByLabelText("Second User's camera");
  expect(firstElement).toHaveProperty('muted', true); expect(firstElement).not.toHaveClass('is-local');
  expect(firstVideo.track.attach).toHaveBeenCalledWith(firstElement); expect(secondVideo.track.attach).toHaveBeenCalledWith(secondElement);
  fireEvent.playing(firstElement); fireEvent.playing(secondElement);
  expect(tile('one')).toHaveAttribute('data-camera', 'live');
  act(() => { firstVideo.isMuted = true; room.emit('trackMuted', firstVideo, first.person); });
  expect(tile('one')).toHaveAttribute('data-camera', 'off');
  expect(within(tile('one')).getByRole('img', { name: 'First User' })).toBeInTheDocument();
  expect(firstVideo.track.detach).toHaveBeenCalledWith(firstElement);
  act(() => { room.removeParticipant(second.person); });
  expect(tile('two')).toBeNull(); expect(document.querySelector('.voice-stage')).toHaveAttribute('data-participant-count', '2');
  expect(secondVideo.track.detach).toHaveBeenCalledWith(secondElement); expect(secondVideo.track.stop).not.toHaveBeenCalled();
  expect(room.connect).toHaveBeenCalledTimes(1); expect(room.disconnect).not.toHaveBeenCalled();
});

test.each(['NotAllowedError', 'NotFoundError', 'NotReadableError'])('camera failure %s preserves voice and allows a camera retry', async (name) => {
  const { room, service } = await joined();
  room.localParticipant.setCameraEnabled.mockRejectedValueOnce(new DOMException('private-device-details', name));
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Voice stays connected.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private-device-details');
  expect(tile('local-identity')).toHaveAttribute('data-camera', 'off');
  expect(service.getSnapshot().status).toBe('connected'); expect(room.disconnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' }));
  await screen.findByLabelText('Your camera');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1); expect(room.connect).toHaveBeenCalledTimes(1);
});

test('a video playback failure shows an avatar and recovers on a replacement track without touching audio', async () => {
  const { room } = await joined();
  let remote!: ReturnType<TestVoiceRoom['addParticipant']>; let camera!: TestPublication;
  act(() => { remote = room.addParticipant(); camera = new TestPublication('video', 'remote-video');
    camera.track.attach.mockImplementationOnce(() => { throw new Error('private decoder failure'); });
    remote.person.trackPublications.set('video', camera); room.emit('trackSubscribed'); });
  expect(tile(remote.person.identity)).toHaveAttribute('data-camera', 'error');
  expect(within(tile(remote.person.identity)).getByRole('img', { name: 'Remote User' })).toBeInTheDocument();
  const audio = document.querySelector('audio');
  const replacement = new TestTrack('video');
  act(() => { camera.track = replacement; room.emit('trackSubscribed'); });
  const video = screen.getByLabelText("Remote User's camera"); fireEvent.playing(video);
  expect(tile(remote.person.identity)).toHaveAttribute('data-camera', 'live');
  expect(document.querySelector('audio')).toBe(audio); expect(room.disconnect).not.toHaveBeenCalled();
});

test('fullscreen enter, exit and browser Escape preserve the room and media attachments', async () => {
  const { room } = await joined();
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' }));
  const video = await screen.findByLabelText('Your camera'); fireEvent.playing(video);
  fireEvent.click(screen.getByRole('button', { name: `Fullscreen video for ${voiceUser.displayName}` }));
  const exit = await screen.findByRole('button', { name: `Exit fullscreen for ${voiceUser.displayName}` });
  expect(document.fullscreenElement).toBe(tile('local-identity'));
  fireEvent.click(exit);
  await screen.findByRole('button', { name: `Fullscreen video for ${voiceUser.displayName}` });
  fireEvent.click(screen.getByRole('button', { name: `Fullscreen video for ${voiceUser.displayName}` }));
  await screen.findByRole('button', { name: `Exit fullscreen for ${voiceUser.displayName}` });
  act(() => { fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange')); });
  expect(screen.getByRole('button', { name: `Fullscreen video for ${voiceUser.displayName}` })).toBeInTheDocument();
  expect(room.localParticipant.trackPublications.get('video')!.track.attach).toHaveBeenCalledTimes(1);
  expect(room.connect).toHaveBeenCalledTimes(1); expect(room.disconnect).not.toHaveBeenCalled();
});

test('fullscreen rejection reports an error while keeping voice connected', async () => {
  const { room, service } = await joined();
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' })); await screen.findByLabelText('Your camera');
  requestFullscreen.mockRejectedValueOnce(new TypeError('Browser denied fullscreen'));
  fireEvent.click(screen.getByRole('button', { name: `Fullscreen video for ${voiceUser.displayName}` }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fullscreen could not be opened. Voice stays connected.');
  expect(service.getSnapshot().status).toBe('connected'); expect(room.disconnect).not.toHaveBeenCalled();
});

test('native video fullscreen is used when container fullscreen is unavailable', async () => {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
  const enter = jest.fn(function (this: HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) {
    this.webkitDisplayingFullscreen = true; this.dispatchEvent(new Event('webkitbeginfullscreen'));
  });
  const exit = jest.fn(function (this: HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) {
    this.webkitDisplayingFullscreen = false; this.dispatchEvent(new Event('webkitendfullscreen'));
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { configurable: true, value: enter });
  Object.defineProperty(HTMLVideoElement.prototype, 'webkitExitFullscreen', { configurable: true, value: exit });
  Object.defineProperty(HTMLVideoElement.prototype, 'webkitSupportsFullscreen', { configurable: true, value: true });
  const { room } = await joined();
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' })); await screen.findByLabelText('Your camera');
  fireEvent.click(screen.getByRole('button', { name: `Fullscreen video for ${voiceUser.displayName}` }));
  fireEvent.click(await screen.findByRole('button', { name: `Exit fullscreen for ${voiceUser.displayName}` }));
  expect(enter).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledTimes(1); expect(requestFullscreen).not.toHaveBeenCalled();
  expect(room.disconnect).not.toHaveBeenCalled();
});

test('a departing participant closes its fullscreen video and detaches only its media', async () => {
  const { room } = await joined();
  let remote!: ReturnType<TestVoiceRoom['addParticipant']>;
  act(() => { remote = room.addParticipant(); room.addCamera(remote.person); });
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen video for Remote User' }));
  await screen.findByRole('button', { name: 'Exit fullscreen for Remote User' });
  act(() => { room.removeParticipant(remote.person); });
  expect(exitFullscreen).toHaveBeenCalled(); expect(document.fullscreenElement).toBeNull();
  expect(screen.getByRole('button', { name: 'Mute microphone' })).toBeEnabled(); expect(room.disconnect).not.toHaveBeenCalled();
});

test('turning the camera off exits fullscreen without leaving voice', async () => {
  const { room } = await joined();
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' })); await screen.findByLabelText('Your camera');
  fireEvent.click(screen.getByRole('button', { name: `Fullscreen video for ${voiceUser.displayName}` }));
  await screen.findByRole('button', { name: `Exit fullscreen for ${voiceUser.displayName}` });
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera off' }));
  await waitFor(() => expect(tile('local-identity')).toHaveAttribute('data-camera', 'off'));
  expect(document.fullscreenElement).toBeNull(); expect(exitFullscreen).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Mute microphone' })).toBeEnabled(); expect(room.disconnect).not.toHaveBeenCalled();
});

test('a fullscreen request completed after leaving is closed without reattaching video', async () => {
  const fullscreenGrant = deferred<void>();
  requestFullscreen.mockImplementation(function (this: Element) {
    return fullscreenGrant.promise.then(() => { enterFullscreen(this); });
  });
  const { room } = await joined();
  fireEvent.click(screen.getByRole('button', { name: 'Turn camera on' })); await screen.findByLabelText('Your camera');
  const camera = room.localParticipant.trackPublications.get('video')!.track;
  fireEvent.click(screen.getByRole('button', { name: `Fullscreen video for ${voiceUser.displayName}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
  await screen.findByRole('button', { name: 'Join room' });
  await act(async () => { fullscreenGrant.resolve(); });
  expect(document.fullscreenElement).toBeNull(); expect(exitFullscreen).toHaveBeenCalledTimes(1);
  expect(camera.detach).toHaveBeenCalledTimes(1); expect(camera.attach).toHaveBeenCalledTimes(1);
  expect(room.connect).toHaveBeenCalledTimes(1);
});

test('a late camera permission grant after leaving stops the track and never rejoins', async () => {
  const room = new TestVoiceRoom(); const service = voiceService([room]);
  const grant = deferred<TestPublication>();
  room.localParticipant.setCameraEnabled.mockReturnValue(grant.promise);
  const { result, unmount } = renderHook(() => useLiveVoiceRoom(service, voiceUser));
  await act(async () => { await result.current.join('lounge'); });
  let pending!: Promise<void>;
  act(() => { pending = result.current.toggleDevice('video'); });
  await act(async () => { await result.current.leave(); });
  const camera = new TestPublication('video', 'late-camera');
  await act(async () => { grant.resolve(camera); await pending; });
  expect(camera.track.stop).toHaveBeenCalled(); expect(result.current.cameraEnabled).toBe(false); expect(result.current.joinedRoomId).toBeNull();
  expect(room.connect).toHaveBeenCalledTimes(1); unmount();
});
