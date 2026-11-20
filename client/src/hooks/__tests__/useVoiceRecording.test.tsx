import { act, cleanup, renderHook } from '@testing-library/react';
import { useVoiceRecording } from '../useVoiceRecording';
import { TestMediaRecorder, microphone } from '../../../test/voiceRecordingFixture';

const originals = [Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder'), Object.getOwnPropertyDescriptor(navigator, 'mediaDevices'),
  Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')];
const getMedia = jest.fn(), create = jest.fn(), revoke = jest.fn();
let sequence = 0;
beforeAll(() => {
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: TestMediaRecorder });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: getMedia } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
});
beforeEach(() => {
  jest.useFakeTimers(); TestMediaRecorder.reset(); getMedia.mockReset(); create.mockReset(); revoke.mockClear();
  create.mockImplementation(() => `blob:voice-${++sequence}`);
});
afterEach(() => { cleanup(); jest.useRealTimers(); });
afterAll(() => {
  const replacements: Array<[object, string]> = [[globalThis, 'MediaRecorder'], [navigator, 'mediaDevices'], [URL, 'createObjectURL'], [URL, 'revokeObjectURL']];
  replacements.forEach(([target, key], index) => {
    const descriptor = originals[index]; if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
  });
});
const setup = () => renderHook(({ active, disabled }) => useVoiceRecording(active, disabled), { initialProps: { active: true, disabled: false } });

test('records, stops tracks, measures capture duration and releases replaced, cancelled and unmounted draft URLs', async () => {
  const mic = microphone(); getMedia.mockResolvedValue(mic.stream);
  const h = setup(); await act(async () => h.result.current.start());
  expect(h.result.current.recording).toBe(true);
  act(() => jest.advanceTimersByTime(3500)); expect(h.result.current.seconds).toBe(4);
  act(() => h.result.current.stop());
  const first = h.result.current.draft!;
  expect(first.durationSeconds).toBe(4); expect(mic.stop).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  expect(revoke).not.toHaveBeenCalled();
  await act(async () => h.result.current.start()); expect(revoke).toHaveBeenCalledWith(first.audioUrl);
  act(() => h.result.current.stop()); const second = h.result.current.draft!;
  act(() => h.result.current.clearDraft()); expect(h.result.current.draft).toBeNull(); expect(revoke).toHaveBeenCalledWith(second.audioUrl);
  await act(async () => h.result.current.start()); act(() => h.result.current.stop()); const third = h.result.current.draft!;
  h.unmount(); expect(revoke).toHaveBeenCalledWith(third.audioUrl);
});

test('duration excludes delayed encoder completion and microphone tracks stop immediately', async () => {
  const mic = microphone(); getMedia.mockResolvedValue(mic.stream); TestMediaRecorder.deferStop = true;
  const h = setup(); await act(async () => h.result.current.start()); act(() => jest.advanceTimersByTime(2200));
  act(() => h.result.current.stop()); expect(mic.stop).toHaveBeenCalledTimes(1); expect(h.result.current.draft).toBeNull();
  act(() => jest.advanceTimersByTime(5000)); act(() => TestMediaRecorder.instances[0]!.finish());
  expect(h.result.current.draft?.durationSeconds).toBe(2);
});

test.each(['unmount', 'hide', 'disable', 'cancel'] as const)('a permission grant arriving after %s stops tracks without starting a recorder', async action => {
  const mic = microphone(); let grant!: (stream: MediaStream) => void;
  getMedia.mockReturnValue(new Promise<MediaStream>(resolve => { grant = resolve; }));
  const h = setup(); let request!: Promise<void>;
  act(() => { request = h.result.current.start(); }); expect(h.result.current.requesting).toBe(true);
  if (action === 'unmount') h.unmount();
  else if (action === 'cancel') act(() => h.result.current.cancel());
  else h.rerender({ active: action !== 'hide', disabled: action === 'disable' });
  await act(async () => { grant(mic.stream); await request; });
  expect(mic.stop).toHaveBeenCalledTimes(1); expect(TestMediaRecorder.instances).toHaveLength(0); expect(create).not.toHaveBeenCalled();
});

test('cancellation and navigation stop active capture without creating a discarded preview', async () => {
  const mic = microphone(); getMedia.mockResolvedValue(mic.stream); const h = setup();
  await act(async () => h.result.current.start()); act(() => h.result.current.cancel());
  expect(mic.stop).toHaveBeenCalledTimes(1); expect(h.result.current.recording).toBe(false); expect(h.result.current.draft).toBeNull();
  await act(async () => h.result.current.start()); h.rerender({ active: false, disabled: false });
  expect(mic.stop).toHaveBeenCalledTimes(2); expect(create).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
});

test.each(['constructor', 'start', 'recorder'] as const)('a %s error releases the microphone and timer', async kind => {
  const mic = microphone(); getMedia.mockResolvedValue(mic.stream);
  TestMediaRecorder.failConstructor = kind === 'constructor'; TestMediaRecorder.failStart = kind === 'start';
  const h = setup(); await act(async () => h.result.current.start());
  if (kind === 'recorder') act(() => TestMediaRecorder.instances[0]!.fail());
  expect(mic.stop).toHaveBeenCalledTimes(1); expect(h.result.current.error).toMatch(/Check your microphone/);
  expect(h.result.current.recording).toBe(false); expect(h.result.current.requesting).toBe(false); expect(jest.getTimerCount()).toBe(0);
});

test('permission denial is actionable and empty audio does not create a preview URL', async () => {
  getMedia.mockRejectedValueOnce(new DOMException('Private platform detail', 'NotAllowedError'));
  const h = setup(); await act(async () => h.result.current.start());
  expect(h.result.current.error).toBe('Microphone access was blocked. Allow the microphone and try again.');
  const mic = microphone(); getMedia.mockResolvedValue(mic.stream); TestMediaRecorder.audio = '';
  await act(async () => h.result.current.start()); act(() => h.result.current.stop());
  expect(h.result.current.error).toMatch(/No audio was captured/); expect(create).not.toHaveBeenCalled(); expect(mic.stop).toHaveBeenCalled();
});

test('an old pending permission request cannot interfere with a newer capture', async () => {
  const old = microphone(), latest = microphone(); let grant!: (stream: MediaStream) => void;
  getMedia.mockImplementationOnce(() => new Promise<MediaStream>(resolve => { grant = resolve; })).mockResolvedValue(latest.stream);
  const h = setup(); let request!: Promise<void>; act(() => { request = h.result.current.start(); });
  act(() => h.result.current.cancel()); await act(async () => h.result.current.start());
  await act(async () => { grant(old.stream); await request; });
  expect(old.stop).toHaveBeenCalledTimes(1); expect(latest.stop).not.toHaveBeenCalled(); expect(h.result.current.recording).toBe(true);
  expect(TestMediaRecorder.instances).toHaveLength(1);
});
