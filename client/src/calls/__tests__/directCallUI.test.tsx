import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { DirectCallLayer } from '@/components/calls/DirectCallLayer';
import { useDirectCallPreview, CALL_PREVIEW_CONNECT_MS, CALL_PREVIEW_RING_MS } from '../useDirectCallPreview';
import { directCallReducer, idleDirectCall, type DirectCallSession } from '../directCallMachine';

const peer = { id: 'ava', name: 'Ava Morgan', avatarUrl: '/avatars/ava.png' };
const session = {};
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
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

function Preview({ identity = session }: { identity?: object }) {
  const call = useDirectCallPreview(identity);
  return <><button onClick={() => call.start('dm-1', peer, 'voice')}>Start voice preview</button>
    <button onClick={() => call.start('dm-1', peer, 'video', 'incoming')}>Incoming preview</button>
    <DirectCallLayer state={call.state} actions={call} /></>;
}

test('outgoing UI labels preview ringing, displays the avatar and never starts a duration or enables media', () => {
  render(<Preview />);
  fireEvent.click(screen.getByRole('button', { name: 'Start voice preview' }));
  expect(screen.getByRole('dialog', { name: 'Voice call with Ava Morgan' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Ava Morgan' }).querySelector('img')).toHaveAttribute('src', '/avatars/ava.png');
  expect(screen.getByRole('status')).toHaveTextContent('Ringing · UI preview');
  expect(screen.getByText(/Ava Morgan has not been notified/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unmute call microphone' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Turn call camera on' })).toBeDisabled();
  expect(screen.queryByLabelText('Call duration')).not.toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(CALL_PREVIEW_RING_MS); });
  expect(screen.getByRole('status')).toHaveTextContent('Missed · UI preview');
  expect(screen.queryByLabelText('Call duration')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close call' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('incoming Accept opens an honest connecting preview, which times out without ever connecting', () => {
  render(<Preview />); fireEvent.click(screen.getByRole('button', { name: 'Incoming preview' }));
  expect(screen.getByRole('dialog', { name: 'Ava Morgan' })).toHaveAttribute('aria-modal', 'false');
  expect(screen.getByText(/Nobody is calling you/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
  expect(screen.getByRole('status')).toHaveTextContent('Connecting · UI preview');
  expect(screen.queryByLabelText('Call duration')).not.toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(CALL_PREVIEW_CONNECT_MS); });
  expect(screen.getByRole('status')).toHaveTextContent('Ended · UI preview');
  expect(screen.queryByText(/^Connected/)).not.toBeInTheDocument();
});

test('incoming decline and outgoing hangup end only the matching preview and release timers', () => {
  render(<Preview />); fireEvent.click(screen.getByRole('button', { name: 'Incoming preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  expect(screen.getByRole('status')).toHaveTextContent('Declined · UI preview');
  fireEvent.click(screen.getByRole('button', { name: 'Close call' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start voice preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hang up call' }));
  act(() => { jest.advanceTimersByTime(60_000); });
  expect(screen.getByRole('status')).toHaveTextContent('Ended · UI preview');
  expect(jest.getTimerCount()).toBe(0);
});

test('a replaced session or unmount clears its preview, listeners and timers', () => {
  const { result, rerender, unmount } = renderHook(({ identity }) => useDirectCallPreview(identity), { initialProps: { identity: session } });
  act(() => { result.current.start('dm-1', peer, 'voice'); });
  expect(jest.getTimerCount()).toBe(1);
  rerender({ identity: {} });
  expect(result.current.state.phase).toBe('idle'); expect(jest.getTimerCount()).toBe(0);
  act(() => { result.current.start('dm-1', peer, 'video', 'incoming'); });
  unmount(); expect(jest.getTimerCount()).toBe(0);
});

test('connected UI counts time only after media confirmation and freezes it after hangup', () => {
  const createdAt = Date.now();
  const call: DirectCallSession = { id: 'transport-call', conversationId: 'dm-1', peer, kind: 'video', direction: 'outgoing', source: 'transport', createdAt };
  let state = directCallReducer(idleDirectCall, { type: 'START', call });
  state = directCallReducer(state, { type: 'TRANSPORT', callId: call.id, signal: 'accepted', at: createdAt });
  const actions = { accept: jest.fn(), decline: jest.fn(), hangUp: jest.fn(), dismiss: jest.fn() };
  const media = { microphoneEnabled: true, cameraEnabled: false, onToggleMicrophone: jest.fn(), onToggleCamera: jest.fn() };
  const view = render(<DirectCallLayer state={state} actions={actions} media={media} />);
  expect(screen.queryByLabelText('Call duration')).not.toBeInTheDocument();
  state = directCallReducer(state, { type: 'TRANSPORT', callId: call.id, signal: 'media-connected', at: createdAt });
  view.rerender(<DirectCallLayer state={state} actions={actions} media={media} />);
  expect(screen.getByLabelText('Call duration')).toHaveTextContent('00:00');
  act(() => { jest.advanceTimersByTime(65000); });
  expect(screen.getByLabelText('Call duration')).toHaveTextContent('01:05');
  fireEvent.click(screen.getByRole('button', { name: 'Mute call microphone' })); expect(media.onToggleMicrophone).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Turn call camera on' })); expect(media.onToggleCamera).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Hang up call' })); expect(actions.hangUp).toHaveBeenCalledWith(call.id);
  state = directCallReducer(state, { type: 'HANG_UP', callId: call.id, at: Date.now() });
  view.rerender(<DirectCallLayer state={state} actions={actions} />);
  act(() => { jest.advanceTimersByTime(10000); });
  expect(screen.getByLabelText('Call duration')).toHaveTextContent('01:05'); expect(jest.getTimerCount()).toBe(0);
});

test('an active duration ticker is released when its call UI unmounts', () => {
  const call: DirectCallSession = { id: 'active-duration', conversationId: 'dm-1', peer, kind: 'voice', direction: 'outgoing', source: 'transport', createdAt: Date.now() };
  const actions = { accept: jest.fn(), decline: jest.fn(), hangUp: jest.fn(), dismiss: jest.fn() };
  const view = render(<DirectCallLayer state={{ call, phase: 'connected', connectedAt: Date.now(), endedAt: null }} actions={actions} />);
  expect(jest.getTimerCount()).toBe(1); view.unmount(); expect(jest.getTimerCount()).toBe(0);
});
