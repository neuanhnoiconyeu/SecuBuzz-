import { EventEmitter } from 'events';
import type { Room } from 'livekit-client';
import { LiveKitConnectionService, type LiveKitRoomPort } from '@/voice/livekitConnection';
import { createDemoProfile } from '@/profiles/profileModel';

export const voiceUser = { ...createDemoProfile(), id: 'real-user', isDemo: false };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
export class TestTrack {
  readonly kind: 'audio' | 'video';
  stop = jest.fn();
  attach = jest.fn((element: HTMLMediaElement) => { element.srcObject = {} as MediaStream; return element; });
  detach = jest.fn((element: HTMLMediaElement) => { element.srcObject = null; return element; });
  constructor(kind: 'audio' | 'video') { this.kind = kind; }
}
export class TestPublication {
  track: TestTrack;
  trackSid: string;
  isMuted = false;
  source: 'microphone' | 'camera' | 'screen_share';
  constructor(kind: 'audio' | 'video', id: string) { this.track = new TestTrack(kind); this.trackSid = id; this.source = kind === 'audio' ? 'microphone' : 'camera'; }
}
export class TestParticipant {
  identity: string;
  name: string;
  trackPublications = new Map<string, TestPublication>();
  constructor(identity: string, name: string) { this.identity = identity; this.name = name; }
  get audioTrackPublications() { return new Map([...this.trackPublications].filter(([, publication]) => publication.track.kind === 'audio')); }
  get videoTrackPublications() { return new Map([...this.trackPublications].filter(([, publication]) => publication.track.kind === 'video')); }
  get isMicrophoneEnabled() { return [...this.audioTrackPublications.values()].some((publication) => !publication.isMuted); }
  get isCameraEnabled() { return [...this.videoTrackPublications.values()].some((publication) => publication.source === 'camera' && !publication.isMuted); }
  get isScreenShareEnabled() { return [...this.videoTrackPublications.values()].some(publication => publication.source === 'screen_share' && !publication.isMuted); }
}

/** SDK event/track double only. Never imported by application code. */
export class TestVoiceRoom extends EventEmitter {
  state = 'disconnected';
  localParticipant: TestParticipant & {
    setMicrophoneEnabled: jest.Mock<Promise<TestPublication>, [boolean, unknown?]>;
    setCameraEnabled: jest.Mock<Promise<TestPublication>, [boolean]>;
    setScreenShareEnabled: jest.Mock<Promise<TestPublication>, [boolean, unknown?]>;
  };
  remoteParticipants = new Map<string, TestParticipant>();
  activeSpeakers: TestParticipant[] = [];
  canPlaybackAudio = true;
  startAudio = jest.fn(async () => { this.canPlaybackAudio = true; this.emit('audioPlaybackChanged', true); });
  connect = jest.fn(async () => this.changeState('connected'));
  disconnect = jest.fn(async () => { this.localParticipant.trackPublications.forEach((publication) => publication.track.stop()); this.changeState('disconnected'); });
  constructor() {
    super();
    this.localParticipant = Object.assign(new TestParticipant('local-identity', voiceUser.displayName), {
      setMicrophoneEnabled: jest.fn(async (enabled: boolean, _options?: unknown) => this.device('audio', enabled)),
      setCameraEnabled: jest.fn(async (enabled: boolean) => this.device('video', enabled)),
      setScreenShareEnabled: jest.fn(async (enabled: boolean) => {
        let publication = this.localParticipant.trackPublications.get('screen');
        if (!publication) { publication = new TestPublication('video', 'local-screen'); publication.source = 'screen_share'; this.localParticipant.trackPublications.set('screen', publication); }
        publication.isMuted = !enabled; this.emit('localTrackPublished', publication, this.localParticipant); return publication;
      }),
    });
  }
  device(kind: 'audio' | 'video', enabled: boolean) {
    let publication = this.localParticipant.trackPublications.get(kind);
    if (!publication) {
      publication = new TestPublication(kind, `local-${kind}`);
      this.localParticipant.trackPublications.set(kind, publication);
    }
    publication.isMuted = !enabled;
    this.emit(enabled ? 'localTrackPublished' : 'trackMuted', publication, this.localParticipant);
    return publication;
  }
  changeState(state: string) { this.state = state; this.emit('connectionStateChanged', state); }
  addParticipant(id = 'remote-one', name = 'Remote User') {
    const person = new TestParticipant(id, name);
    const publication = new TestPublication('audio', `${id}-audio`);
    person.trackPublications.set('audio', publication);
    this.remoteParticipants.set(id, person);
    this.emit('participantConnected', person); this.emit('trackSubscribed', publication.track, publication, person);
    return { person, publication };
  }
  removeParticipant(person: TestParticipant) {
    this.remoteParticipants.delete(person.identity);
    this.emit('participantDisconnected', person);
  }
  addCamera(person: TestParticipant) {
    const publication = new TestPublication('video', `${person.identity}-camera`);
    person.trackPublications.set('video', publication);
    this.emit('trackPublished', publication, person); this.emit('trackSubscribed', publication.track, publication, person);
    return publication;
  }
  speaking(people: TestParticipant[]) { this.activeSpeakers = people; this.emit('activeSpeakersChanged', people); }
  port(): LiveKitRoomPort {
    return { media: this as unknown as Room, get state() { return this.media!.state; },
      connect: this.connect, disconnect: this.disconnect,
      on: (event, listener) => this.on(event, listener), off: (event, listener) => this.off(event, listener) };
  }
}
export function voiceService(rooms = [new TestVoiceRoom()]) {
  let index = 0;
  return new LiveKitConnectionService({ user: voiceUser, authMode: 'api', enabled: true, serverUrl: 'wss://media.example.invalid',
    getCsrfToken: () => 'test-csrf', createRoom: async () => rooms[index++]!.port(),
    fetch: jest.fn(async (_url, options) => ({ status: 200, ok: true, text: async () => JSON.stringify({
      roomId: JSON.parse(options?.body as string).roomId, roomName: `voice:${'a'.repeat(64)}`, participantIdentity: 'b'.repeat(64),
      serverUrl: 'wss://media.example.invalid/', token: 'header.payload.signature', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }) } as Response)) });
}
