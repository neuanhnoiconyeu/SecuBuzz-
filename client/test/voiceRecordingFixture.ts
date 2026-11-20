/** Controllable recorder events; tests never request a physical microphone. */
export class TestMediaRecorder {
  static instances: TestMediaRecorder[] = [];
  static failConstructor = false;
  static failStart = false;
  static deferStop = false;
  static audio = 'recorded-audio';
  static isTypeSupported = (type: string) => type.startsWith('audio/webm');
  state: RecordingState = 'inactive';
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly stream: MediaStream, options?: MediaRecorderOptions) {
    if (TestMediaRecorder.failConstructor) throw new Error('Recorder unavailable');
    this.mimeType = options?.mimeType ?? 'audio/webm'; TestMediaRecorder.instances.push(this);
  }
  start = jest.fn(() => {
    if (TestMediaRecorder.failStart) throw new Error('Recorder failed to start');
    this.state = 'recording';
  });
  stop = jest.fn(() => { this.state = 'inactive'; if (!TestMediaRecorder.deferStop) this.finish(); });
  finish() {
    this.ondataavailable?.({ data: new Blob([TestMediaRecorder.audio], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.(new Event('stop'));
  }
  fail() { this.onerror?.(new Event('error')); }
  static reset() {
    this.instances = []; this.failConstructor = false; this.failStart = false; this.deferStop = false; this.audio = 'recorded-audio';
  }
}

export function microphone() {
  const stop = jest.fn();
  return { stop, stream: { getTracks: () => [{ stop }] } as unknown as MediaStream };
}
