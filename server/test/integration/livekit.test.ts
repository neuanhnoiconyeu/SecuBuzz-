import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { TokenVerifier } from 'livekit-server-sdk';
import { createLiveKitHttpHandler, loadLiveKitConfig, liveKitParticipantIdentity, type LiveKitHttpOptions } from '../../src/livekit/index.ts';
import type { RealtimeActor } from '../../src/realtime/contracts.ts';
import type { LiveKitConnectionDetails } from '../../../shared/livekit.ts';

const origin = 'http://localhost:3000';
const apiKey = 'test-livekit-key';
const apiSecret = 'test-only-livekit-signing-secret-32-plus';
const environment = { NODE_ENV: 'production', LIVEKIT_ENABLED: 'true', LIVEKIT_URL: 'wss://media.example.invalid',
  LIVEKIT_API_KEY: apiKey, LIVEKIT_API_SECRET: apiSecret, LIVEKIT_ROOM_CONVERSATIONS: '{"lounge":"group-one"}' };
const actor: RealtimeActor = { userId: 'user-one', sessionId: 'session-one', displayName: 'Current User' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function start(overrides: Partial<LiveKitHttpOptions> = {}, omit: readonly (keyof LiveKitHttpOptions)[] = []) {
  const expiry = new Date(Date.now() + 90_000);
  const options: LiveKitHttpOptions = { config: loadLiveKitConfig(environment), allowedOrigins: [origin],
    sessionResolver: { async resolveSession(context) {
      return context.sessionToken === 'test-session-cookie' ? { status: 'authenticated', session: { ...actor, expiresAt: expiry } } : { status: 'invalid' };
    } },
    authorizer: { async listConversationIds() { return ['group-one']; }, async listBlockedUserIds() { return []; }, async filterPresenceSubjects() { return []; } },
    verifyCsrf: async (request) => request.headers['x-csrf-token'] === 'test-csrf',
    authorizeRoom: async () => true, ...overrides };
  for (const key of omit) Reflect.deleteProperty(options, key);
  const handler = createLiveKitHttpHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/token`;
  const post = (body: unknown = { roomId: 'lounge' }, headers: Record<string, string> = {}) => fetch(url, {
    method: 'POST', body: JSON.stringify(body), headers: { origin, cookie: 'secubuzz_session=test-session-cookie',
      'x-csrf-token': 'test-csrf', 'content-type': 'application/json', ...headers } });
  return { post, url, expiry };
}

test('issues a signed, room-scoped, session-bounded token using only authenticated server identity', async () => {
  const server = await start();
  const response = await server.post();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const details = await response.json() as LiveKitConnectionDetails;
  const claims = await new TokenVerifier(apiKey, apiSecret).verify(details.token);
  assert.equal(details.participantIdentity, liveKitParticipantIdentity(actor));
  assert.equal(claims.sub, details.participantIdentity);
  assert.equal(claims.iss, apiKey);
  assert.equal(claims.video?.room, details.roomName);
  assert.equal(claims.video?.roomJoin, true);
  assert.equal(claims.video?.canPublishData, false);
  assert.deepEqual(claims.video?.canPublishSources, ['microphone', 'camera']);
  assert.ok(!claims.video?.roomAdmin && !claims.video?.roomCreate && !claims.video?.roomList);
  assert.ok((claims.exp as number) * 1_000 <= server.expiry.getTime());
  assert.ok(Date.parse(details.expiresAt) <= server.expiry.getTime());
  assert.equal(details.serverUrl, 'wss://media.example.invalid/');
  const serialized = JSON.stringify(details);
  for (const privateValue of [apiSecret, actor.sessionId, 'test-session-cookie', actor.displayName]) assert.ok(!serialized.includes(privateValue));
});

test('missing adapters never issue production tokens even with valid LiveKit credentials', async () => {
  for (const adapter of ['sessionResolver', 'authorizer', 'verifyCsrf', 'authorizeRoom'] as const) {
    const server = await start({}, [adapter]);
    assert.equal((await server.post()).status, 503, adapter);
  }
});

test('disabled, missing, and invalid configuration fail closed without leaking credentials', async () => {
  for (const env of [{}, { ...environment, LIVEKIT_ENABLED: 'false' }, { ...environment, LIVEKIT_API_SECRET: '' },
    { ...environment, LIVEKIT_URL: 'ws://media.example.invalid' }, { ...environment, LIVEKIT_ROOM_CONVERSATIONS: '{}' },
    { ...environment, LIVEKIT_ROOM_CONVERSATIONS: '{"lounge":"demo-group"}' }, { ...environment, LIVEKIT_ROOM_CONVERSATIONS: 'broken-json' }]) {
    const config = loadLiveKitConfig(env);
    assert.notEqual(config.status, 'ready');
    assert.ok(!JSON.stringify(config).includes(apiSecret));
    assert.ok(!inspect(config).includes(apiSecret));
    assert.ok(!inspect(config).includes(apiKey));
    const server = await start({ config });
    assert.deepEqual(await (await server.post()).json(), { error: 'livekit_unavailable' });
  }
});

test('rejects anonymous, invalid, duplicate-cookie, cross-origin, and CSRF-free requests', async () => {
  const server = await start();
  for (const [headers, status] of [
    [{ cookie: '' }, 401], [{ cookie: 'secubuzz_session=invalid' }, 401],
    [{ cookie: 'secubuzz_session=test-session-cookie; secubuzz_session=other' }, 401],
    [{ origin: 'https://attacker.invalid' }, 403], [{ origin: '' }, 403], [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'x-csrf-token': '' }, 403], [{ 'x-csrf-token': 'wrong' }, 403],
  ] as const) assert.equal((await server.post(undefined, headers)).status, status);
});

test('rejects demo and expired sessions even when a resolver labels them authenticated', async () => {
  for (const session of [{ ...actor, userId: 'demo-ava', expiresAt: new Date(Date.now() + 60_000) },
    { ...actor, expiresAt: new Date(Date.now() - 1) }]) {
    const server = await start({ sessionResolver: { async resolveSession() { return { status: 'authenticated', session }; } } });
    assert.equal((await server.post()).status, 401);
  }
});

test('checks current conversation membership and the owner-supplied media policy', async () => {
  const stranger = await start({ authorizer: { async listConversationIds() { return ['another-group']; },
    async listBlockedUserIds() { return []; }, async filterPresenceSubjects() { return []; } } });
  assert.equal((await stranger.post()).status, 403);
  const policy = await start({ authorizeRoom: async () => false });
  assert.equal((await policy.post()).status, 403);
});

test('does not accept arbitrary rooms, caller-supplied identity, or oversized payloads', async () => {
  const server = await start();
  for (const body of [{ roomId: 'other' }, { roomId: 'voice:group-one' }, { roomId: 'lounge', identity: 'admin' },
    { roomId: 'lounge', userId: 'user-two' }, {}, [], 'invalid', { roomId: 'x'.repeat(2_000) }]) {
    const response = await server.post(body);
    assert.ok([400, 403, 413].includes(response.status));
    assert.ok(!JSON.stringify(await response.json()).includes('token'));
  }
  assert.equal((await fetch(server.url)).status, 405);
});

test('adapter failures and timeouts return fixed errors; revocation during authorization prevents signing', async () => {
  for (const authorizeRoom of [async () => { throw new Error(apiSecret); }, () => new Promise<boolean>(() => {})]) {
    const server = await start({ authorizeRoom, adapterTimeoutMs: 15 });
    const response = await server.post();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'authorization_unavailable' });
  }
  let reads = 0;
  const revoked = await start({ sessionResolver: { async resolveSession() {
    return ++reads === 1 ? { status: 'authenticated', session: { ...actor, expiresAt: new Date(Date.now() + 60_000) } } : { status: 'invalid' };
  } } });
  assert.equal((await revoked.post()).status, 401);
});

test('loopback WS is development-only and room identifiers remain stable between config loads', () => {
  assert.equal(loadLiveKitConfig({ ...environment, NODE_ENV: 'development', LIVEKIT_URL: 'ws://127.0.0.1:7880' }).status, 'ready');
  assert.equal(loadLiveKitConfig({ ...environment, LIVEKIT_URL: 'ws://127.0.0.1:7880' }).status, 'unconfigured');
  assert.deepEqual(loadLiveKitConfig(environment).room('lounge'), loadLiveKitConfig(environment).room('lounge'));
});

test('the host transport decision reaches session verification without trusting arbitrary forwarded headers',async()=>{
  for(const secure of [true,false]){
    const instance=await start({resolveTransportSecurity:()=>secure,sessionResolver:{async resolveSession(context){
      return context.secure?{status:'authenticated',session:{...actor,expiresAt:new Date(Date.now()+90_000)}}:{status:'invalid'};
    }}});
    assert.equal((await instance.post(undefined,{'x-forwarded-proto':'https'})).status,secure?200:401);
  }
});
