import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser } from '@/auth/authModel';
import { LiveDirectCallLayer } from '@/components/calls/DirectCallsRuntime';
import { useLiveDirectCalls, type LiveDirectCallsController } from '../useLiveDirectCalls';
import { alice, bob, callId, identity, CallTestBroker, CallTestClient, callMediaService } from '@/test-support/directCallFixture';
import { deferred, TestPublication, TestVoiceRoom } from '@/test-support/liveVoiceFixture';
import type { LiveKitConnectionService } from '@/voice/livekitConnection';
import { CALL_CLIENT_EVENTS as C } from '../../../../shared/directCalls';

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterAll(() => {
  for (const [name, original] of [['showModal', originalShow], ['close', originalClose]] as const) {
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
beforeEach(() => { jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(); jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

function Actor({ client, service, user, result }: { client: CallTestClient; service: LiveKitConnectionService; user: AuthUser; result: { current: LiveDirectCallsController | null } }) {
  const calls = useLiveDirectCalls(client.port(), service, user); result.current = calls;
  return <LiveDirectCallLayer calls={calls} user={user} />;
}
async function pair(kind: 'voice' | 'video' = 'voice', configure?: (first: ReturnType<typeof callMediaService>, second: ReturnType<typeof callMediaService>) => void) {
  const broker = new CallTestBroker(), aClient = broker.client(alice), bClient = broker.client(bob);
  const aMedia = callMediaService(alice), bMedia = callMediaService(bob); configure?.(aMedia, bMedia);
  const a: { current: LiveDirectCallsController | null } = { current: null }, b: typeof a = { current: null };
  const aView = render(<Actor client={aClient} service={aMedia.service} user={alice} result={a} />);
  const bView = render(<Actor client={bClient} service={bMedia.service} user={bob} result={b} />);
  await act(async () => {});
  await act(async () => { await a.current!.start('dm-ab', { id: bob.id, name: bob.displayName }, kind); });
  return { broker, aClient, bClient, aMedia, bMedia, a, b, aView, bView };
}
async function acceptAndJoin(context: Awaited<ReturnType<typeof pair>>) {
  act(() => { context.b.current!.accept(callId); });
  await waitFor(() => { expect(context.aMedia.room.connect).toHaveBeenCalledTimes(1); expect(context.bMedia.room.connect).toHaveBeenCalledTimes(1); });
  await waitFor(() => { expect(context.a.current!.media.microphoneEnabled).toBe(true); expect(context.b.current!.media.microphoneEnabled).toBe(true); });
}
function connectPeers(context: Awaited<ReturnType<typeof pair>>) {
  let atA!: ReturnType<TestVoiceRoom['addParticipant']>, atB!: ReturnType<TestVoiceRoom['addParticipant']>;
  act(() => { atA = context.aMedia.room.addParticipant(identity(bob.id), bob.displayName); atB = context.bMedia.room.addParticipant(identity(alice.id), alice.displayName); });
  return { atA, atB };
}

test('invitations do not capture or connect; acceptance joins a private session and duration waits for the actual peer', async () => {
  const context = await pair(); const { a, b, aMedia, bMedia } = context;
  expect(aMedia.room.connect).not.toHaveBeenCalled(); expect(bMedia.room.connect).not.toHaveBeenCalled();
  expect(a.current!.state.phase).toBe('ringing'); expect(b.current!.state.phase).toBe('ringing');
  await acceptAndJoin(context);
  expect(a.current!.state.phase).toBe('connecting'); expect(b.current!.state.phase).toBe('connecting');
  expect(screen.queryByLabelText('Call duration')).not.toBeInTheDocument();
  expect(aMedia.fetchToken).toHaveBeenCalledWith('/api/calls/token', expect.objectContaining({ body: JSON.stringify({ callId, connectionId: 'alice-socket' }), credentials: 'same-origin' }));
  connectPeers(context);
  await waitFor(() => { expect(a.current!.state.phase).toBe('connected'); expect(b.current!.state.phase).toBe('connected'); });
  expect(screen.getAllByLabelText('Call duration')).toHaveLength(2);
});

test('mute and voice-to-video upgrades reuse the room; remote audio/video render once and hangup stops both users', async () => {
  const context = await pair(); await acceptAndJoin(context); const { atA, atB } = connectPeers(context);
  await waitFor(() => expect(context.a.current!.state.phase).toBe('connected'));
  expect(document.querySelectorAll('audio')).toHaveLength(2);
  await act(async () => { await context.a.current!.media.toggleDevice('audio'); });
  expect(context.a.current!.media.microphoneEnabled).toBe(false);
  await act(async () => { await context.a.current!.media.toggleDevice('audio'); await context.a.current!.media.toggleDevice('video'); });
  expect(context.a.current!.media.cameraEnabled).toBe(true); expect(context.bMedia.room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  act(() => { context.bMedia.room.addCamera(atB.person); });
  expect(screen.getByLabelText('Your camera')).toHaveProperty('muted', true);
  expect(screen.getByLabelText("Alice's camera")).toHaveProperty('muted', true);
  expect(atA.publication.track.attach).toHaveBeenCalledTimes(1); expect(atB.publication.track.attach).toHaveBeenCalledTimes(1);
  expect(context.aMedia.room.connect).toHaveBeenCalledTimes(1); expect(context.bMedia.room.connect).toHaveBeenCalledTimes(1);
  await act(async () => { context.a.current!.hangUp(callId); });
  await waitFor(() => { expect(context.a.current!.state.phase).toBe('ended'); expect(context.b.current!.state.phase).toBe('ended'); });
  expect(context.aMedia.room.disconnect).toHaveBeenCalled(); expect(context.bMedia.room.disconnect).toHaveBeenCalled();
  expect(document.querySelectorAll('audio,video')).toHaveLength(0);
  expect(atA.publication.track.detach).toHaveBeenCalled(); expect(atA.publication.track.stop).not.toHaveBeenCalled();
});

test('video acceptance enables each camera, and denied camera permission preserves the real voice connection and retry', async () => {
  const context = await pair('video', first => { first.room.localParticipant.setCameraEnabled.mockRejectedValueOnce(new DOMException('private device detail', 'NotAllowedError')); });
  await acceptAndJoin(context); connectPeers(context);
  await waitFor(() => expect(context.b.current!.media.cameraEnabled).toBe(true));
  expect(context.a.current!.media.errors.video).toMatch(/Camera permission was denied/);
  expect(context.aMedia.room.disconnect).not.toHaveBeenCalled(); expect(context.a.current!.media.microphoneEnabled).toBe(true);
  await act(async () => { await context.a.current!.media.toggleDevice('video'); });
  expect(context.a.current!.media.cameraEnabled).toBe(true); expect(context.a.current!.media.errors.video).toBeNull();
  expect(context.aMedia.room.connect).toHaveBeenCalledTimes(1);
});

test('terminal signaling detaches media, and delayed/stale acceptance cannot reopen it', async () => {
  const context = await pair(); await acceptAndJoin(context); connectPeers(context);
  const accepted = context.broker.call!;
  await act(async () => { context.b.current!.hangUp(callId); });
  await waitFor(() => expect(context.a.current!.state.phase).toBe('ended'));
  act(() => { context.aClient.state({ ...accepted, revision: 50 }); });
  expect(context.a.current!.state.phase).toBe('ended'); expect(context.aMedia.room.connect).toHaveBeenCalledTimes(1);
});

test('media connection failure ends signaling for both users without leaking SDK diagnostics', async () => {
  const context = await pair('voice', first => { first.room.connect.mockRejectedValueOnce(new Error('secret token content')); });
  act(() => { context.b.current!.accept(callId); });
  await waitFor(() => { expect(context.a.current!.state.phase).toBe('ended'); expect(context.b.current!.state.phase).toBe('ended'); });
  expect(context.aMedia.room.disconnect).toHaveBeenCalled(); expect(document.body).not.toHaveTextContent('secret token');
  expect(context.aClient.calls.request).toHaveBeenCalledWith(C.end, { callId });
});

test('late camera permission after hangup is released and cannot rejoin the call', async () => {
  const context = await pair(); await acceptAndJoin(context); connectPeers(context);
  const permission = deferred<TestPublication>(); context.aMedia.room.localParticipant.setCameraEnabled.mockReturnValueOnce(permission.promise);
  let opening!: Promise<void>; act(() => { opening = context.a.current!.media.toggleDevice('video'); });
  await act(async () => { context.a.current!.hangUp(callId); });
  const camera = new TestPublication('video', 'late-camera');
  await act(async () => { permission.resolve(camera); await opening; });
  expect(camera.track.stop).toHaveBeenCalled(); expect(context.aMedia.room.connect).toHaveBeenCalledTimes(1);
});

test('only the authorized peer is rendered; media reconnection preserves the original call duration', async () => {
  const context = await pair(); await acceptAndJoin(context); connectPeers(context);
  await waitFor(() => expect(context.a.current!.state.phase).toBe('connected'));
  const connectedAt = context.a.current!.state.phase === 'connected' ? context.a.current!.state.connectedAt : null;
  let outsider!: ReturnType<TestVoiceRoom['addParticipant']>;
  act(() => { outsider = context.aMedia.room.addParticipant('c'.repeat(64), 'Wrong participant'); });
  expect(context.a.current!.media.participants).toHaveLength(2); expect(outsider.publication.track.attach).not.toHaveBeenCalled();
  act(() => { context.aMedia.room.changeState('reconnecting'); });
  expect(context.a.current!.state.phase).toBe('reconnecting');
  act(() => { context.aMedia.room.changeState('connected'); });
  expect(context.a.current!.state).toMatchObject({ phase: 'connected', connectedAt });
  expect(context.aMedia.room.connect).toHaveBeenCalledTimes(1);
});

test('an endpoint claimed on another device never captures media or hangs up the other device’s call', async () => {
  const broker = new CallTestBroker(), client = broker.client(bob), media = callMediaService(bob);
  media.fetchToken.mockResolvedValue({ status: 409, ok: false, text: async () => '{}' } as Response);
  const { result } = renderHook(() => useLiveDirectCalls(client.port(), media.service, bob));
  await act(async () => { await broker.request(alice.id, C.initiate, { kind: 'voice' }); });
  act(() => { result.current.accept(callId); });
  await waitFor(() => expect(result.current.error).toBe('Call media is active on another device.'));
  expect(media.room.connect).not.toHaveBeenCalled(); expect(media.room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  expect(client.calls.request).not.toHaveBeenCalledWith(C.end, expect.anything());
});

test('losing signaling stops local capture immediately and reconnect synchronizes the end', async () => {
  const context = await pair(); await acceptAndJoin(context); connectPeers(context);
  act(() => { context.aClient.changeStatus('reconnecting'); });
  await waitFor(() => expect(context.aMedia.room.disconnect).toHaveBeenCalled());
  expect(context.a.current!.state.phase).toBe('ended');
  await act(async () => { context.aClient.changeStatus('connected'); });
  await waitFor(() => expect(context.b.current!.state.phase).toBe('ended'));
});

test('acceptance on another device does not start capture on this device', async () => {
  const broker = new CallTestBroker(), client = broker.client(bob), media = callMediaService(bob);
  const { result } = renderHook(() => useLiveDirectCalls(client.port(), media.service, bob));
  await act(async () => { await broker.request(alice.id, C.initiate, { kind: 'video' }); await broker.request(bob.id, C.accept, { callId }); });
  expect(result.current.state.phase).toBe('connecting'); expect(media.fetchToken).not.toHaveBeenCalled(); expect(media.room.connect).not.toHaveBeenCalled();
});

test('minimizing preserves connection and messaging interaction; screen sharing can stop from the mini panel', async () => {
  const context = await pair(); await acceptAndJoin(context); connectPeers(context);
  await waitFor(() => expect(context.a.current!.state.phase).toBe('connected'));
  const panel = within(context.aView.container);
  const chat = render(<textarea aria-label="Conversation draft" />);
  fireEvent.click(panel.getByRole('button', { name: 'Share screen' }));
  await waitFor(() => expect(context.a.current!.media.screenShareEnabled).toBe(true));
  expect(context.aMedia.room.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true, { audio: false });
  expect(panel.getByLabelText("Alice's shared screen")).not.toHaveClass('is-local');
  const screenTrack = context.aMedia.room.localParticipant.trackPublications.get('screen')!.track;
  fireEvent.click(panel.getByRole('button', { name: 'Minimize call' }));
  fireEvent.change(within(chat.container).getByRole('textbox'), { target: { value: 'Message while calling' } });
  expect(within(chat.container).getByRole('textbox')).toHaveValue('Message while calling');
  expect(context.aMedia.room.disconnect).not.toHaveBeenCalled(); expect(screenTrack.stop).not.toHaveBeenCalled();
  expect(panel.getByLabelText('Call duration')).toBeInTheDocument();
  fireEvent.click(panel.getByRole('button', { name: 'Stop sharing screen' }));
  await waitFor(() => expect(context.a.current!.media.screenShareEnabled).toBe(false));
  expect(context.aMedia.room.localParticipant.setScreenShareEnabled).toHaveBeenLastCalledWith(false, { audio: false });
  fireEvent.click(panel.getByRole('button', { name: 'Expand call' }));
  expect(context.aMedia.room.connect).toHaveBeenCalledTimes(1);
});

test('screen picker rejection preserves voice and a late screen grant is stopped after hangup', async () => {
  const context = await pair(); await acceptAndJoin(context); connectPeers(context);
  context.aMedia.room.localParticipant.setScreenShareEnabled.mockRejectedValueOnce(new DOMException('cancelled', 'NotAllowedError'));
  await act(async () => { await context.a.current!.media.toggleDevice('screen'); });
  expect(context.a.current!.media.errors.screen).toMatch(/could not start or was cancelled/);
  expect(context.a.current!.media.microphoneEnabled).toBe(true); expect(context.aMedia.room.disconnect).not.toHaveBeenCalled();
  const picker = deferred<TestPublication>(); context.aMedia.room.localParticipant.setScreenShareEnabled.mockReturnValueOnce(picker.promise);
  let opening!: Promise<void>; act(() => { opening = context.a.current!.media.toggleDevice('screen'); });
  await act(async () => { context.a.current!.hangUp(callId); });
  const publication = new TestPublication('video', 'late-screen'); publication.source = 'screen_share';
  await act(async () => { picker.resolve(publication); await opening; });
  expect(publication.track.stop).toHaveBeenCalled(); expect(context.aMedia.room.connect).toHaveBeenCalledTimes(1);
});

test('remote screen publication and browser stop-sharing update the same media controller', async () => {
  const context = await pair(); await acceptAndJoin(context); const { atA } = connectPeers(context);
  const share = new TestPublication('video', 'remote-screen'); share.source = 'screen_share';
  act(() => { atA.person.trackPublications.set('screen', share); context.aMedia.room.emit('trackSubscribed', share.track, share, atA.person); });
  expect(within(context.aView.container).getByLabelText("Bob's shared screen")).toBeInTheDocument();
  act(() => { atA.person.trackPublications.delete('screen'); context.aMedia.room.emit('trackUnsubscribed', share.track, share, atA.person); });
  expect(within(context.aView.container).queryByLabelText("Bob's shared screen")).not.toBeInTheDocument();
  expect(share.track.detach).toHaveBeenCalled(); expect(share.track.stop).not.toHaveBeenCalled();
});

test('dismissing an active call or a different call cannot detach its authoritative state', async () => {
  const context = await pair(); await acceptAndJoin(context); connectPeers(context);
  await waitFor(() => expect(context.a.current!.state.phase).toBe('connected'));
  act(() => { context.a.current!.dismiss(callId); context.a.current!.dismiss('different-call'); });
  expect(context.a.current!.state.phase).toBe('connected');
  await act(async () => { context.a.current!.hangUp(callId); });
  await waitFor(() => expect(context.b.current!.state.phase).toBe('ended'));
  expect(context.aClient.calls.request).toHaveBeenCalledWith(C.end, { callId });
});

test('a confirmed accepted broadcast survives a stale error acknowledgement without orphaning media', async () => {
  const context = await pair();
  context.bClient.calls.request.mockImplementationOnce(async () => {
    await context.broker.request(bob.id, C.accept, { callId });
    return { status: 'error', code: 'invalid_call_state' };
  });
  await acceptAndJoin(context); connectPeers(context);
  await waitFor(() => expect(context.b.current!.state.phase).toBe('connected'));
  expect(context.b.current!.ownedId).toBe(callId);
  await act(async () => { context.b.current!.hangUp(callId); });
  await waitFor(() => expect(context.a.current!.state.phase).toBe('ended'));
});
