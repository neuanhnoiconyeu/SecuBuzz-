const oscillatorNode = () => ({ type: 'sine', frequency: { setValueAtTime: jest.fn() }, onended: null as (() => void) | null,
  connect: jest.fn(), disconnect: jest.fn(), start: jest.fn(), stop: jest.fn() });
const gainNode = () => ({ gain: { setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn() },
  connect: jest.fn(), disconnect: jest.fn() });
/** Disposable Web Audio fixture; never used by application code. */
export class FakeAudioContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  oscillators: Array<ReturnType<typeof oscillatorNode>> = [];
  gains: Array<ReturnType<typeof gainNode>> = [];
  resume = jest.fn(async () => { this.changeState('running'); });
  close = jest.fn(async () => { this.changeState('closed'); });
  changeState(state: AudioContextState) { this.state = state; this.onstatechange?.(); }
  createOscillator() {
    const oscillator = oscillatorNode();
    this.oscillators.push(oscillator); return oscillator;
  }
  createGain() {
    const gain = gainNode();
    this.gains.push(gain); return gain;
  }
  port() { return this as unknown as AudioContext; }
}
