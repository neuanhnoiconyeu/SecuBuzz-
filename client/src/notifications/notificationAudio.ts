export type NotificationAudioState = Readonly<{ enabled: boolean; status: 'locked' | 'ready' | 'blocked' | 'unavailable' }>;
type Voice = { oscillator: OscillatorNode; gain: GainNode };

function createContext(): AudioContext {
  const browser = window as Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Constructor = browser.AudioContext ?? browser.webkitAudioContext;
  if (!Constructor) throw new Error('Web Audio is unavailable');
  return new Constructor();
}

/** Original synthesized tones only. One audio owner per authenticated workspace. */
export class NotificationAudio {
  private state: NotificationAudioState = { enabled: true, status: 'locked' };
  private listeners = new Set<() => void>();
  private context: AudioContext | null = null;
  private unlocking: Promise<void> | null = null;
  private voices = new Set<Voice>();
  private seen = new Set<string>();
  private endedCalls = new Set<string>();
  private desiredRing: { id: string; expiresAt: number } | null = null;
  private ringTimer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private lastMessage = -Infinity;
  private lastBuzz = -Infinity;
  private disposed = false;
  constructor(private readonly factory: () => AudioContext = createContext) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<NotificationAudioState>) {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    if (next.enabled === this.state.enabled && next.status === this.state.status) return;
    this.state = next; this.listeners.forEach(listener => listener());
  }
  private remember(set: Set<string>, id: string) {
    set.add(id); if (set.size > 1000) set.delete(set.values().next().value!);
  }
  setEnabled(enabled: boolean) {
    if (this.disposed || enabled === this.state.enabled) return;
    this.update({ enabled, status: 'locked' });
    if (!enabled) this.closeContext(); // Keep only an unexpired invitation's intent, never queued one-shots.
  }
  /** Called from a real user interaction; the browser alone decides whether resume is allowed. */
  unlock = (): Promise<void> => {
    if (this.disposed || !this.state.enabled) return Promise.resolve();
    if (this.unlocking) return this.unlocking;
    let context = this.context;
    if (!context || context.state === 'closed') {
      try { context = this.factory(); this.context = context; }
      catch { this.update({ status: 'unavailable' }); return Promise.resolve(); }
      const owned = context;
      context.onstatechange = () => {
        if (owned !== this.context || this.disposed || !this.state.enabled) return;
        if (owned.state === 'running') { this.update({ status: 'ready' }); this.startRing(); }
        else { this.stopPlayback(); this.update({ status: 'blocked' }); }
      };
    }
    if (context.state === 'running') { this.update({ status: 'ready' }); this.startRing(); return Promise.resolve(); }
    this.update({ status: 'blocked' });
    const owned = context;
    let pending: Promise<void>;
    try {
      pending = owned.resume().then(() => {
        if (owned !== this.context || this.disposed || !this.state.enabled) return;
        this.update({ status: owned.state === 'running' ? 'ready' : 'blocked' });
        if (owned.state === 'running') this.startRing();
      }).catch(() => { if (owned === this.context) this.update({ status: 'blocked' }); })
        .finally(() => { if (this.unlocking === pending) this.unlocking = null; });
    } catch { this.update({ status: 'blocked' }); return Promise.resolve(); }
    this.unlocking = pending; return pending;
  };
  notify(kind: 'message' | 'buzz', id: string) {
    const key = `${kind}:${id}`;
    if (this.disposed || this.seen.has(key)) return;
    this.remember(this.seen, key); // Muted/blocked events must never play later as catch-up audio.
    if (!this.state.enabled || this.desiredRing) return;
    if (this.context?.state !== 'running') { this.update({ status: 'blocked' }); return; }
    const now = Date.now();
    if (kind === 'message') {
      if (now - this.lastMessage < 400 || now - this.lastBuzz < 650) return;
      this.lastMessage = now;
      this.tone(880, 0, .09, .055); this.tone(1320, .1, .12, .045);
    } else {
      if (now - this.lastBuzz < 1500) return;
      this.lastBuzz = now; this.stopVoices();
      [170, 130, 190, 150].forEach((frequency, index) => this.tone(frequency, index * .09, .075, .055, 'square'));
    }
  }
  ring(id: string, expiresAt: number) {
    if (this.disposed || this.endedCalls.has(id) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    if (this.desiredRing?.id === id) return;
    if (this.desiredRing) this.stopRinging(this.desiredRing.id);
    this.desiredRing = { id, expiresAt };
    this.deadline = setTimeout(() => this.stopRinging(id), expiresAt - Date.now());
    if (!this.state.enabled) return;
    if (this.context?.state !== 'running') { this.update({ status: 'blocked' }); return; }
    this.startRing();
  }
  stopRinging(id: string) {
    this.remember(this.endedCalls, id);
    if (this.desiredRing?.id !== id) return;
    this.desiredRing = null; clearTimeout(this.deadline); this.deadline = undefined;
    this.stopPlayback();
  }
  private startRing() {
    const ring = this.desiredRing;
    if (!ring || this.ringTimer || !this.state.enabled || this.context?.state !== 'running' || this.disposed) return;
    if (ring.expiresAt <= Date.now()) { this.stopRinging(ring.id); return; }
    const pulse = () => {
      if (!this.desiredRing || this.desiredRing.expiresAt <= Date.now()) { this.stopRinging(ring.id); return; }
      this.stopVoices();
      [523.25, 659.25, 783.99, 659.25].forEach((frequency, index) => this.tone(frequency, index * .18, .14, .07));
    };
    pulse(); if (this.state.status === 'ready' && this.desiredRing) this.ringTimer = setInterval(pulse, 2400);
  }
  private tone(frequency: number, offset: number, duration: number, volume: number, type: OscillatorType = 'sine') {
    const context = this.context;
    if (!context || context.state !== 'running' || !this.state.enabled || this.disposed) return;
    try {
      const oscillator = context.createOscillator(), gain = context.createGain(), at = context.currentTime + .01 + offset;
      const voice = { oscillator, gain }; this.voices.add(voice);
      oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(volume, at + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.voices.delete(voice); };
      oscillator.start(at); oscillator.stop(at + duration + .01);
    } catch { this.stopPlayback(); this.update({ status: 'blocked' }); }
  }
  private stopVoices() {
    for (const voice of this.voices) {
      voice.oscillator.onended = null;
      try { voice.oscillator.stop(); } catch { /* Already ended. */ }
      voice.oscillator.disconnect(); voice.gain.disconnect();
    }
    this.voices.clear();
  }
  private stopPlayback() { clearInterval(this.ringTimer); this.ringTimer = undefined; this.stopVoices(); }
  private closeContext() {
    this.stopPlayback(); const context = this.context; this.context = null; this.unlocking = null;
    if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.deadline); this.desiredRing = null; this.closeContext();
    this.listeners.clear(); this.seen.clear(); this.endedCalls.clear();
  }
}
