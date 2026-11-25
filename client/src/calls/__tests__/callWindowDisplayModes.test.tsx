import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { AuthUser } from '@/auth/authModel';
import { LiveDirectCallLayer } from '@/components/calls/DirectCallsRuntime';
import { useLiveDirectCalls, type LiveDirectCallsController } from '../useLiveDirectCalls';
import { alice, bob, callId, identity, CallTestBroker, CallTestClient, callMediaService } from '@/test-support/directCallFixture';
import { deferred, TestPublication, TestVoiceRoom } from '@/test-support/liveVoiceFixture';
import type { LiveKitConnectionService } from '@/voice/livekitConnection';

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const originalRequest = Object.getOwnPropertyDescriptor(Element.prototype, 'requestFullscreen');
const originalExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
const originalElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
const originalEnabled = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled');

let fullscreenElement: Element | null;
let requestFullscreen: jest.Mock;
let exitFullscreen: jest.Mock;
const enterFullscreen = (element: Element) => {
  fullscreenElement = element;
  document.dispatchEvent(new Event('fullscreenchange'));
};

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});

afterAll(() => {
  for (const [name, original] of [['showModal', originalShow], ['close', originalClose]] as const) {
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

beforeEach(() => {
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  fullscreenElement = null;
  requestFullscreen = jest.fn(async function (this: Element) { enterFullscreen(this); });
  exitFullscreen = jest.fn(async () => {
    fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const [target, name, original] of [
    [Element.prototype, 'requestFullscreen', originalRequest],
    [document, 'exitFullscreen', originalExit],
    [document, 'fullscreenElement', originalElement],
    [document, 'fullscreenEnabled', originalEnabled],
  ] as const) {
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  }
});

function Actor({ client, service, user, result }: {
  client: CallTestClient; service: LiveKitConnectionService; user: AuthUser; result: { current: LiveDirectCallsController | null };
}) {
  const calls = useLiveDirectCalls(client.port(), service, user);
  result.current = calls;
  return <LiveDirectCallLayer calls={calls} user={user} />;
}

async function setupConnectedCall(kind: 'voice' | 'video' = 'video') {
  const broker = new CallTestBroker();
  const aClient = broker.client(alice);
  const bClient = broker.client(bob);
  const aMedia = callMediaService(alice);
  const bMedia = callMediaService(bob);
  const a: { current: LiveDirectCallsController | null } = { current: null };
  const b: { current: LiveDirectCallsController | null } = { current: null };
  const aView = render(<Actor client={aClient} service={aMedia.service} user={alice} result={a} />);
  const bView = render(<Actor client={bClient} service={bMedia.service} user={bob} result={b} />);
  await act(async () => {});
  await act(async () => { await a.current!.start('dm-ab', { id: bob.id, name: bob.displayName }, kind); });
  act(() => { b.current!.accept(callId); });
  await waitFor(() => {
    expect(aMedia.room.connect).toHaveBeenCalledTimes(1);
    expect(bMedia.room.connect).toHaveBeenCalledTimes(1);
  });
  let atA!: ReturnType<TestVoiceRoom['addParticipant']>;
  act(() => {
    atA = aMedia.room.addParticipant(identity(bob.id), bob.displayName);
    bMedia.room.addParticipant(identity(alice.id), alice.displayName);
  });
  await waitFor(() => expect(a.current!.state.phase).toBe('connected'));
  return { broker, aClient, bClient, aMedia, bMedia, a, b, aView, bView, atA };
}

test('transitions between Mini, Expanded, Fullscreen, and Minimized without disconnecting or reattaching tracks', async () => {
  const ctx = await setupConnectedCall('video');
  const panel = within(ctx.aView.container);
  const callAside = panel.getByRole('complementary', { name: `Call with ${bob.displayName}` });

  // Starts in mini mode
  expect(callAside).toHaveAttribute('data-display-mode', 'mini');
  expect(callAside).not.toHaveClass('is-expanded', 'is-fullscreen', 'is-minimized');

  const localCamera = ctx.aMedia.room.localParticipant.trackPublications.get('video')!.track;
  expect(localCamera.attach).toHaveBeenCalledTimes(1);

  // Switch to Expanded
  fireEvent.click(panel.getByRole('button', { name: 'Expand call' }));
  expect(callAside).toHaveAttribute('data-display-mode', 'expanded');
  expect(callAside).toHaveClass('is-expanded');
  expect(localCamera.attach).toHaveBeenCalledTimes(1);
  expect(localCamera.detach).not.toHaveBeenCalled();

  // Switch to Fullscreen from Expanded
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Enter fullscreen' }));
  });
  expect(requestFullscreen).toHaveBeenCalledTimes(1);
  expect(callAside).toHaveAttribute('data-display-mode', 'fullscreen');
  expect(callAside).toHaveClass('is-fullscreen');
  expect(localCamera.attach).toHaveBeenCalledTimes(1);
  expect(localCamera.detach).not.toHaveBeenCalled();

  // Exit Fullscreen returns to Expanded
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Exit fullscreen' }));
  });
  expect(exitFullscreen).toHaveBeenCalledTimes(1);
  expect(callAside).toHaveAttribute('data-display-mode', 'expanded');

  // Restore returns to Mini
  fireEvent.click(panel.getByRole('button', { name: 'Restore call' }));
  expect(callAside).toHaveAttribute('data-display-mode', 'mini');
  expect(localCamera.attach).toHaveBeenCalledTimes(1);
  expect(localCamera.detach).not.toHaveBeenCalled();

  // Minimize and Restore
  fireEvent.click(panel.getByRole('button', { name: 'Minimize call' }));
  expect(callAside).toHaveAttribute('data-display-mode', 'minimized');
  expect(callAside).toHaveClass('is-minimized');
  fireEvent.click(panel.getByRole('button', { name: 'Restore call' }));
  expect(callAside).toHaveAttribute('data-display-mode', 'mini');

  expect(ctx.aMedia.room.connect).toHaveBeenCalledTimes(1);
  expect(ctx.aMedia.room.disconnect).not.toHaveBeenCalled();
  ctx.aView.unmount();
  ctx.bView.unmount();
});

test('screen-share stage becomes primary in Expanded and Fullscreen while keeping thumbnails and controls accessible', async () => {
  const ctx = await setupConnectedCall('video');
  const panel = within(ctx.aView.container);
  const share = new TestPublication('video', 'remote-screen');
  share.source = 'screen_share';
  act(() => {
    ctx.atA.person.trackPublications.set('screen', share);
    ctx.aMedia.room.emit('trackSubscribed', share.track, share, ctx.atA.person);
  });

  const mediaStage = ctx.aView.container.querySelector('.direct-call-media-content')!;
  expect(mediaStage).toHaveClass('has-screen-share');
  expect(mediaStage).toHaveAttribute('data-has-screen-share', 'true');
  expect(panel.getByLabelText("Bob's shared screen")).toBeInTheDocument();
  expect(share.track.attach).toHaveBeenCalledTimes(1);

  fireEvent.click(panel.getByRole('button', { name: 'Expand call' }));
  expect(panel.getByLabelText("Bob's shared screen")).toBeInTheDocument();
  expect(panel.getByRole('button', { name: 'Mute call microphone' })).toBeEnabled();
  expect(panel.getByRole('button', { name: 'Turn call camera off' })).toBeEnabled();
  expect(panel.getByRole('button', { name: 'Hang up call' })).toBeEnabled();
  expect(panel.getByRole('button', { name: 'Share screen' })).toBeEnabled();
  expect(share.track.attach).toHaveBeenCalledTimes(1);

  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Enter fullscreen' }));
  });
  expect(panel.getByLabelText("Bob's shared screen")).toBeInTheDocument();
  expect(panel.getByRole('button', { name: 'Hang up call' })).toBeEnabled();
  expect(share.track.attach).toHaveBeenCalledTimes(1);
  expect(share.track.detach).not.toHaveBeenCalled();

  ctx.aView.unmount();
  ctx.bView.unmount();
});

test('call duration timer continues without resetting across display-mode transitions', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const ctx = await setupConnectedCall('voice');
  const panel = within(ctx.aView.container);

  expect(panel.getByLabelText('Call duration')).toHaveTextContent('00:00');
  act(() => { jest.advanceTimersByTime(12_000); });
  expect(panel.getByLabelText('Call duration')).toHaveTextContent('00:12');

  fireEvent.click(panel.getByRole('button', { name: 'Expand call' }));
  act(() => { jest.advanceTimersByTime(15_000); });
  expect(panel.getByLabelText('Call duration')).toHaveTextContent('00:27');

  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Enter fullscreen' }));
  });
  act(() => { jest.advanceTimersByTime(33_000); });
  expect(panel.getByLabelText('Call duration')).toHaveTextContent('01:00');

  fireEvent.click(panel.getByRole('button', { name: 'Minimize call' }));
  act(() => { jest.advanceTimersByTime(5_000); });
  expect(panel.getByLabelText('Call duration')).toHaveTextContent('01:05');

  ctx.aView.unmount();
  ctx.bView.unmount();
});

test('handles Fullscreen API rejection, unsupported fullscreen, Escape key, call termination, and unmount safely', async () => {
  const ctx = await setupConnectedCall('voice');
  const panel = within(ctx.aView.container);
  const callAside = panel.getByRole('complementary', { name: `Call with ${bob.displayName}` });

  // Escape exits Expanded mode back to Mini
  fireEvent.click(panel.getByRole('button', { name: 'Expand call' }));
  expect(callAside).toHaveAttribute('data-display-mode', 'expanded');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(callAside).toHaveAttribute('data-display-mode', 'mini');

  // Fullscreen rejection shows alert without dropping call
  requestFullscreen.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Enter fullscreen' }));
  });
  expect(callAside).toHaveAttribute('data-display-mode', 'mini');
  expect(panel.getByRole('alert')).toHaveTextContent('Fullscreen could not be opened. Your call stays connected.');
  expect(ctx.aMedia.room.disconnect).not.toHaveBeenCalled();

  // Browser-initiated fullscreen exit (Escape) syncs back cleanly
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Enter fullscreen' }));
  });
  expect(callAside).toHaveAttribute('data-display-mode', 'fullscreen');
  act(() => {
    fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  expect(callAside).toHaveAttribute('data-display-mode', 'mini');

  // Call termination while in fullscreen exits fullscreen and shows Close call
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Enter fullscreen' }));
  });
  expect(callAside).toHaveAttribute('data-display-mode', 'fullscreen');
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Hang up call' }));
  });
  await waitFor(() => expect(ctx.a.current!.state.phase).toBe('ended'));
  expect(exitFullscreen).toHaveBeenCalled();
  expect(panel.getByRole('button', { name: 'Close call' })).toBeInTheDocument();

  ctx.aView.unmount();
  ctx.bView.unmount();
});

test('disables fullscreen button when Fullscreen API is unavailable and cleans up in-flight fullscreen on unmount', async () => {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
  const ctx = await setupConnectedCall('voice');
  const panel = within(ctx.aView.container);
  expect(panel.getByRole('button', { name: 'Enter fullscreen' })).toBeDisabled();

  // Re-enable and test in-flight fullscreen on unmount
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  ctx.aView.unmount();
  ctx.bView.unmount();

  const ctx2 = await setupConnectedCall('voice');
  const panel2 = within(ctx2.aView.container);
  const callAside2 = panel2.getByRole('complementary', { name: `Call with ${bob.displayName}` });
  const pending = deferred<void>();
  requestFullscreen.mockImplementationOnce(function (this: Element) {
    return pending.promise.then(() => enterFullscreen(this));
  });
  fireEvent.click(panel2.getByRole('button', { name: 'Enter fullscreen' }));
  ctx2.aView.unmount();
  await act(async () => { pending.resolve(); });
  expect(exitFullscreen).toHaveBeenCalled();
  expect(fullscreenElement).toBeNull();
  expect(callAside2).not.toBeInTheDocument();
  ctx2.bView.unmount();
});
