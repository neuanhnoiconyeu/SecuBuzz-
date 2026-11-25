import { NotificationAudio } from '../notificationAudio';
import { FakeAudioContext } from '../testing/fakeAudio';

let context: FakeAudioContext, audio: NotificationAudio;
beforeEach(() => { jest.useFakeTimers(); context = new FakeAudioContext(); audio = new NotificationAudio(() => context.port()); });
afterEach(() => { audio.dispose(); expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });

test('original message and Buzz tones play once per ID, coalesce bursts and release nodes', async () => {
  await audio.unlock();
  audio.notify('message', 'one'); audio.notify('message', 'one'); audio.notify('message', 'burst');
  expect(context.oscillators).toHaveLength(2);
  expect(context.oscillators.map(node => node.frequency.setValueAtTime.mock.calls[0][0])).toEqual([880, 1320]);
  context.oscillators.forEach(node => node.onended?.());
  expect(context.gains.every(node => node.disconnect.mock.calls.length === 1)).toBe(true);
  jest.advanceTimersByTime(500); audio.notify('buzz', 'buzz'); audio.notify('buzz', 'buzz'); audio.notify('buzz', 'burst');
  expect(context.oscillators).toHaveLength(6);
  expect(context.oscillators.slice(2).every(node => node.type === 'square')).toBe(true);
  audio.notify('message', 'during-buzz'); expect(context.oscillators).toHaveLength(6);
});

test('a single ringtone repeats, supersedes one-shots, and cannot restart after stopping', async () => {
  await audio.unlock();
  audio.ring('call', Date.now() + 30_000); audio.ring('call', Date.now() + 30_000);
  audio.notify('message', 'quiet-during-ring'); audio.notify('buzz', 'quiet-during-ring');
  expect(context.oscillators).toHaveLength(4); expect(jest.getTimerCount()).toBe(2);
  jest.advanceTimersByTime(2400); expect(context.oscillators).toHaveLength(8);
  audio.stopRinging('call'); expect(jest.getTimerCount()).toBe(0);
  expect(context.oscillators.every(node => node.disconnect.mock.calls.length > 0)).toBe(true);
  audio.ring('call', Date.now() + 30_000); jest.advanceTimersByTime(10_000);
  expect(context.oscillators).toHaveLength(8);
});

test('invitation deadline, replacement, invalid expiry and disposal clean up all loops', async () => {
  await audio.unlock(); audio.ring('invalid', NaN); audio.ring('expired', Date.now());
  expect(jest.getTimerCount()).toBe(0);
  audio.ring('first', Date.now() + 30_000); audio.ring('second', Date.now() + 1000);
  expect(jest.getTimerCount()).toBe(2); audio.stopRinging('first');
  jest.advanceTimersByTime(1000); expect(jest.getTimerCount()).toBe(0);
  const count = context.oscillators.length; jest.advanceTimersByTime(10_000); expect(context.oscillators).toHaveLength(count);
  audio.ring('third', Date.now() + 30_000); audio.dispose();
  expect(context.close).toHaveBeenCalledTimes(1); expect(context.onstatechange).toBeNull();
});

test('muted and blocked one-shots are consumed without catch-up audio', async () => {
  audio.notify('message', 'blocked'); expect(audio.getSnapshot().status).toBe('blocked');
  audio.setEnabled(false); audio.notify('buzz', 'muted'); audio.setEnabled(true); await audio.unlock();
  audio.notify('message', 'blocked'); audio.notify('buzz', 'muted'); expect(context.oscillators).toHaveLength(0);
  audio.notify('message', 'new'); expect(context.oscillators).toHaveLength(2);
});

test('explicit unmute resumes only an unexpired invitation with a fresh context', async () => {
  const contexts: FakeAudioContext[] = [];
  audio.dispose(); audio = new NotificationAudio(() => { const value = new FakeAudioContext(); contexts.push(value); return value.port(); });
  await audio.unlock(); audio.ring('call', Date.now() + 30_000);
  audio.setEnabled(false); expect(contexts[0].close).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(3000); audio.setEnabled(true); await audio.unlock();
  expect(contexts[1].oscillators).toHaveLength(4); expect(jest.getTimerCount()).toBe(2);
  audio.stopRinging('call'); audio.setEnabled(false); audio.setEnabled(true); await audio.unlock();
  expect(contexts[2].oscillators).toHaveLength(0);
});

test('autoplay refusal is visible and a later allowed user interaction starts only the current ringtone', async () => {
  context.resume.mockRejectedValueOnce(new DOMException('User interaction required', 'NotAllowedError'));
  audio.ring('call', Date.now() + 30_000); await audio.unlock();
  expect(audio.getSnapshot().status).toBe('blocked'); expect(context.oscillators).toHaveLength(0);
  await audio.unlock(); expect(audio.getSnapshot().status).toBe('ready'); expect(context.oscillators).toHaveLength(4);
  context.changeState('suspended'); expect(jest.getTimerCount()).toBe(1);
  context.changeState('running'); expect(jest.getTimerCount()).toBe(2);
});

test.each(['mute', 'dispose'] as const)('late resume cannot revive audio after %s', async action => {
  let release!: () => void;
  context.resume.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  audio.ring('call', Date.now() + 30_000); const pending = audio.unlock(); expect(audio.unlock()).toBe(pending);
  if (action === 'mute') audio.setEnabled(false); else audio.dispose();
  context.state = 'running'; release(); await pending;
  expect(context.oscillators).toHaveLength(0); expect(jest.getTimerCount()).toBe(action === 'mute' ? 1 : 0);
});

test('unsupported browser and audio-node failures do not throw or leave repeating timers', async () => {
  const unavailable = new NotificationAudio(() => { throw new Error('Unsupported'); });
  await unavailable.unlock(); expect(unavailable.getSnapshot().status).toBe('unavailable'); unavailable.dispose();
  await audio.unlock(); jest.spyOn(context, 'createOscillator').mockImplementation(() => { throw new Error('Device failure'); });
  audio.ring('call', Date.now() + 3000);
  expect(audio.getSnapshot().status).toBe('blocked'); expect(jest.getTimerCount()).toBe(1);
});
