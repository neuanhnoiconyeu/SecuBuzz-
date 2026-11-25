import { LiveKitConnectionService, createSessionLiveKitConnection, type LiveKitRoomPort, type LiveKitStatus } from '../livekitConnection';
import { createDemoProfile } from '@/profiles/profileModel';
import {ApiError,type SessionApi} from '@/api/sessionApi';

const user = { ...createDemoProfile(), id: 'user-one', isDemo: false };
const details = () => ({ roomId: 'lounge', roomName: `voice:${'a'.repeat(64)}`, participantIdentity: 'b'.repeat(64),
  serverUrl: 'wss://media.example.invalid/', token: 'header.payload.signature', expiresAt: new Date(Date.now() + 60_000).toISOString() });
const reply = (status = 200, body: unknown = details()) => ({ status, ok: status === 200, text: async () => JSON.stringify(body) }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class FakeRoom implements LiveKitRoomPort {
  state = 'disconnected';
  listener: ((state: string) => void) | null = null;
  connect = jest.fn(async () => { this.state = 'connected'; });
  disconnect = jest.fn(async () => { this.state = 'disconnected'; });
  on(_event: 'connectionStateChanged', listener: (state: string) => void) { this.listener = listener; }
  off(_event: 'connectionStateChanged', listener: (state: string) => void) { if (this.listener === listener) this.listener = null; }
  change(state: string) { this.state = state; this.listener?.(state); }
}
function create(overrides: Partial<ConstructorParameters<typeof LiveKitConnectionService>[0]> = {}) {
  const room = new FakeRoom();
  const fetcher = jest.fn().mockResolvedValue(reply());
  const createRoom = jest.fn().mockResolvedValue(room);
  const service = new LiveKitConnectionService({ user, authMode: 'api', enabled: true, serverUrl: 'wss://media.example.invalid',
    getCsrfToken: () => 'csrf-token', fetch: fetcher, createRoom, ...overrides });
  return { service, room, fetcher, createRoom };
}

test('authenticated direct calls use SessionApi instead of a static CSRF meta tag or a parallel fetch',async()=>{
  const previousEnabled=process.env.NEXT_PUBLIC_LIVEKIT_ENABLED,previousUrl=process.env.NEXT_PUBLIC_LIVEKIT_URL;
  process.env.NEXT_PUBLIC_LIVEKIT_ENABLED='true';process.env.NEXT_PUBLIC_LIVEKIT_URL='wss://media.example.invalid';
  const api={actor:user,request:jest.fn().mockResolvedValue({}),dispose:jest.fn()} as unknown as SessionApi;
  const id='11111111-2222-4333-8444-555555555555';
  try{
    const service=createSessionLiveKitConnection(user,'api',undefined,'direct-call',()=> 'owned-socket',{api,enabled:true});
    await expect(service.connect(id)).rejects.toMatchObject({code:'invalid_response'});
    expect(api.request).toHaveBeenCalledWith('/api/calls/token',{method:'POST',body:{callId:id,connectionId:'owned-socket'},signal:expect.any(AbortSignal)});
    await service.dispose();(api.request as jest.Mock).mockClear();
    const disabled=createSessionLiveKitConnection(user,'api',undefined,'direct-call',()=> 'owned-socket',{api,enabled:false});
    await expect(disabled.connect(id)).rejects.toMatchObject({code:'disabled'});expect(api.request).not.toHaveBeenCalled();await disabled.dispose();
  }finally{
    if(previousEnabled===undefined)delete process.env.NEXT_PUBLIC_LIVEKIT_ENABLED;else process.env.NEXT_PUBLIC_LIVEKIT_ENABLED=previousEnabled;
    if(previousUrl===undefined)delete process.env.NEXT_PUBLIC_LIVEKIT_URL;else process.env.NEXT_PUBLIC_LIVEKIT_URL=previousUrl;
  }
});

test('scoped token cancellation and authorization failures never create a media room',async()=>{
  const id='11111111-2222-4333-8444-555555555555';
  for(const [failure,expected]of [['unauthorized','authentication_required'],['csrf_invalid','csrf_unavailable'],['forbidden','room_forbidden'],['conflict','media_in_use'],['cancelled','cancelled'],['unavailable','unavailable']] as const){
    const {service,fetcher,createRoom}=create({purpose:'direct-call',getConnectionId:()=> 'owned-socket',requestToken:jest.fn().mockRejectedValue(new ApiError(failure))});
    await expect(service.connect(id)).rejects.toMatchObject({code:expected});expect(fetcher).not.toHaveBeenCalled();expect(createRoom).not.toHaveBeenCalled();await service.dispose();
  }
});

test('authenticated scoped tokens connect the existing SDK room and clean up without publishing devices',async()=>{
  const id='11111111-2222-4333-8444-555555555555',room=new FakeRoom();
  Object.assign(room,{media:{localParticipant:{identity:'b'.repeat(64)}}});
  const requestToken=jest.fn().mockResolvedValue({...details(),roomId:id,roomName:`direct:${'a'.repeat(64)}`,peerIdentity:'c'.repeat(64)});
  const h=create({purpose:'direct-call',getConnectionId:()=> 'owned-socket',requestToken,createRoom:async()=>room});
  await h.service.connect(id);expect(requestToken).toHaveBeenCalledWith(id,'owned-socket',expect.any(AbortSignal));
  expect(h.service.getParticipantIds()).toEqual(new Set(['b'.repeat(64),'c'.repeat(64)]));expect(h.fetcher).not.toHaveBeenCalled();
  await h.service.dispose();expect(room.disconnect).toHaveBeenCalledWith(true);expect(h.service.getParticipantIds()).toBeNull();
});

test('disabled configuration, demo identities, and missing URLs never fetch a token or construct the SDK', async () => {
  for (const [options, error] of [[{ enabled: false }, 'disabled'], [{ user: createDemoProfile() }, 'authentication_required'],
    [{ user: null }, 'authentication_required'], [{ authMode: 'demo' as const }, 'authentication_required'],
    [{ serverUrl: undefined }, 'configuration_missing'], [{ serverUrl: 'ws://remote.invalid' }, 'configuration_missing']] as const) {
    const { service, fetcher, createRoom } = create(options);
    expect(service.getSnapshot().status).toBe('disabled');
    await expect(service.connect('lounge')).rejects.toMatchObject({ code: error });
    expect(fetcher).not.toHaveBeenCalled(); expect(createRoom).not.toHaveBeenCalled();
    await service.dispose();
  }
});

test('uses the session cookie/CSRF contract and connects without publishing devices', async () => {
  const { service, room, fetcher } = create();
  const states: LiveKitStatus[] = [];
  service.subscribe((snapshot) => states.push(snapshot.status));
  await service.connect('lounge');
  expect(fetcher).toHaveBeenCalledWith('/api/voice/token', expect.objectContaining({ method: 'POST',
    credentials: 'same-origin', redirect: 'error', body: '{"roomId":"lounge"}',
    headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }) }));
  expect(room.connect).toHaveBeenCalledWith('wss://media.example.invalid/', 'header.payload.signature');
  expect(states).toEqual(['requesting-token', 'connecting', 'connected']);
  room.change('reconnecting'); expect(service.getSnapshot().status).toBe('reconnecting');
  room.change('connected'); expect(service.getSnapshot().status).toBe('connected');
  room.change('disconnected'); expect(service.getSnapshot().roomId).toBeNull();
  await service.dispose(); expect(room.disconnect).toHaveBeenCalledWith(true); expect(room.listener).toBeNull();
});

test('missing CSRF and rejected token requests cannot start a media connection', async () => {
  const missing = create({ getCsrfToken: () => null });
  await expect(missing.service.connect('lounge')).rejects.toMatchObject({ code: 'csrf_unavailable' });
  expect(missing.fetcher).not.toHaveBeenCalled();
  for (const [status, code] of [[401, 'authentication_required'], [403, 'room_forbidden'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
    const revalidate = jest.fn();
    const result = create({ fetch: jest.fn().mockResolvedValue(reply(status)), onAuthenticationRequired: revalidate });
    await expect(result.service.connect('lounge')).rejects.toMatchObject({ code });
    expect(result.createRoom).not.toHaveBeenCalled();
    expect(result.service.getSnapshot().status).toBe('error');
    expect(revalidate).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    await result.service.dispose();
  }
  await missing.service.dispose();
});

test('rejects malformed, expired, mismatched-room, and unexpected-host connection details', async () => {
  for (const body of [{}, { ...details(), roomId: 'other' }, { ...details(), serverUrl: 'wss://attacker.invalid/' },
    { ...details(), expiresAt: new Date(0).toISOString() }, { ...details(), token: 'not-a-jwt' }]) {
    const { service, createRoom } = create({ fetch: jest.fn().mockResolvedValue(reply(200, body)) });
    await expect(service.connect('lounge')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(createRoom).not.toHaveBeenCalled();
    await service.dispose();
  }
});

test('disposal cancels a pending token fetch and a late response cannot start the SDK', async () => {
  const token = deferred<Response>();
  const started = deferred<void>();
  let signal: AbortSignal | undefined;
  const { service, createRoom } = create({ fetch: jest.fn((_url, options) => {
    signal = options?.signal ?? undefined; started.resolve(); return token.promise;
  }) });
  const connecting = service.connect('lounge');
  const rejected = expect(connecting).rejects.toMatchObject({ code: 'cancelled' });
  await started.promise;
  await service.dispose();
  await rejected;
  expect(signal?.aborted).toBe(true);
  token.resolve(reply()); await Promise.resolve(); await Promise.resolve();
  expect(createRoom).not.toHaveBeenCalled();
});

test('connection failures use fixed errors and dispose SDK resources', async () => {
  const { service, room } = create();
  room.connect.mockRejectedValue(new Error('private-sdk-detail token=secret'));
  await expect(service.connect('lounge')).rejects.toMatchObject({ code: 'connection_failed', message: 'The voice connection failed. Check your connection and try again.' });
  expect(service.getSnapshot()).toEqual({ status: 'error', roomId: null, error: 'connection_failed' });
  expect(room.disconnect).toHaveBeenCalledWith(true);
  await service.dispose();
});

test('a timed-out dynamic SDK load is cleaned up when it eventually resolves', async () => {
  const sdk = deferred<LiveKitRoomPort>();
  const room = new FakeRoom();
  const { service } = create({ timeoutMs: 15, createRoom: () => sdk.promise });
  await expect(service.connect('lounge')).rejects.toMatchObject({ code: 'connection_failed' });
  sdk.resolve(room); await Promise.resolve(); await Promise.resolve();
  expect(room.connect).not.toHaveBeenCalled(); expect(room.disconnect).toHaveBeenCalledWith(true);
  await service.dispose();
});

test('the configured factory refuses the current demo even if public readiness is enabled', async () => {
  const previousFlag = process.env.NEXT_PUBLIC_LIVEKIT_ENABLED;
  const previousUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  try {
    process.env.NEXT_PUBLIC_LIVEKIT_ENABLED = 'true'; process.env.NEXT_PUBLIC_LIVEKIT_URL = 'wss://media.example.invalid';
    const service = createSessionLiveKitConnection(createDemoProfile(), 'demo');
    expect(service.getSnapshot().status).toBe('disabled');
    await expect(service.connect('lounge')).rejects.toMatchObject({ code: 'authentication_required' });
    await service.dispose();
  } finally {
    if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_LIVEKIT_ENABLED; else process.env.NEXT_PUBLIC_LIVEKIT_ENABLED = previousFlag;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_LIVEKIT_URL; else process.env.NEXT_PUBLIC_LIVEKIT_URL = previousUrl;
  }
});

test('switching rooms cancels an old SDK attempt and ignores its late completion', async () => {
  const first = new FakeRoom();
  const second = new FakeRoom();
  const started = deferred<void>();
  const complete = deferred<void>();
  first.connect.mockImplementation(async () => { started.resolve(); await complete.promise; first.state = 'connected'; });
  const { service } = create({
    fetch: jest.fn(async (_url, options) => reply(200, { ...details(), roomId: JSON.parse(options?.body as string).roomId })),
    createRoom: jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
  });
  const old = service.connect('lounge');
  const cancelled = expect(old).rejects.toMatchObject({ code: 'cancelled' });
  await started.promise;
  await service.connect('study-room'); await cancelled;
  complete.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(first.disconnect).toHaveBeenCalledWith(true);
  expect(first.state).toBe('disconnected');
  expect(service.getSnapshot()).toEqual({ status: 'connected', roomId: 'study-room', error: null });
  await service.dispose();
});

test('slow cleanup of a failed connection cannot overwrite a newer successful connection', async () => {
  const first = new FakeRoom();
  const second = new FakeRoom();
  const cleaning = deferred<void>();
  const release = deferred<void>();
  first.connect.mockRejectedValue(new Error('SDK failed'));
  first.disconnect.mockImplementation(async () => { cleaning.resolve(); await release.promise; first.state = 'disconnected'; });
  const { service } = create({
    fetch: jest.fn(async (_url, options) => reply(200, { ...details(), roomId: JSON.parse(options?.body as string).roomId })),
    createRoom: jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
  });
  const failed = expect(service.connect('lounge')).rejects.toMatchObject({ code: 'connection_failed' });
  await cleaning.promise;
  await service.connect('study-room');
  release.resolve(); await failed;
  expect(service.getSnapshot()).toEqual({ status: 'connected', roomId: 'study-room', error: null });
  await service.dispose();
});


test('authenticated voice rooms use the session API for fresh CSRF without requiring a direct-call socket id', async () => {
  const previousEnabled=process.env.NEXT_PUBLIC_LIVEKIT_ENABLED, previousUrl=process.env.NEXT_PUBLIC_LIVEKIT_URL;
  process.env.NEXT_PUBLIC_LIVEKIT_ENABLED='true'; process.env.NEXT_PUBLIC_LIVEKIT_URL='wss://media.example.invalid';
  const api={actor:user,request:jest.fn().mockResolvedValue({}),dispose:jest.fn()} as unknown as SessionApi;
  try {
    const service=createSessionLiveKitConnection(user,'api',undefined,'voice-room',undefined,{api,enabled:true});
    await expect(service.connect('lounge')).rejects.toMatchObject({code:'invalid_response'});
    expect(api.request).toHaveBeenCalledWith('/api/voice/token',{method:'POST',body:{roomId:'lounge'},signal:expect.any(AbortSignal)});
    await service.dispose();
  } finally {
    if(previousEnabled===undefined)delete process.env.NEXT_PUBLIC_LIVEKIT_ENABLED;else process.env.NEXT_PUBLIC_LIVEKIT_ENABLED=previousEnabled;
    if(previousUrl===undefined)delete process.env.NEXT_PUBLIC_LIVEKIT_URL;else process.env.NEXT_PUBLIC_LIVEKIT_URL=previousUrl;
  }
});
