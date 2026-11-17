import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { TokenVerifier } from 'livekit-server-sdk';
import { startDevelopmentCallingHarness } from '../../dev/calling/server.ts';
import { loadDevelopmentCallingConfig } from '../../dev/calling/config.ts';
import { DevelopmentCallAdapters, DEVELOPMENT_COOKIE, DEVELOPMENT_USERS, DEVELOPMENT_CONVERSATION_ID as conversationId, SESSION_TTL_MS } from '../../dev/calling/adapters.ts';
import { CALL_CLIENT_EVENTS as C, CALL_SERVER_EVENTS as S } from '../../src/calls/protocol.ts';
import type { DirectCallRoomService } from '../../src/livekit/index.ts';
import { TestClient, eventually } from '../support/harness.ts';
import { createDevelopmentLiveKitStatus } from '../../dev/calling/livekitStatus.ts';
import { loadLiveKitConfig } from '../../src/livekit/config.ts';

const origin = 'http://localhost:3000';
const environment = { NODE_ENV: 'development', SECUBUZZ_DEV_CALLS_ENABLED: 'true', DEV_CALLS_PORT: '0',
  DEV_CALLS_APP_ORIGIN: origin, DEV_CALLS_ALICE_PASSWORD: 'alice-test-password-123', DEV_CALLS_BOB_PASSWORD: 'bob-test-password-456' };
const key = 'calling-test-key', secret = 'calling-test-secret-longer-than-32-characters';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function setup(withMedia = false) {
  const created: string[] = [], deleted: string[] = [];
  const service: DirectCallRoomService = { async createRoom(input) { created.push(input.name); return {} as Awaited<ReturnType<DirectCallRoomService['createRoom']>>; },
    async deleteRoom(name) { deleted.push(name); } };
  const harness = await startDevelopmentCallingHarness({ ...environment, ...(withMedia ? { LIVEKIT_ENABLED: 'true', LIVEKIT_URL: 'wss://media.example.invalid', LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } : {}) }, { roomService: service });
  const sockets: TestClient[] = [];
  cleanup.push(async () => { sockets.forEach(socket => socket.close()); await harness.close(); });
  const get = (path: string, cookie = '', extra: Record<string, string> = {}) => fetch(harness.url + path, { headers: { origin, cookie, ...extra } });
  const post = (path: string, value: unknown, cookie: string, csrf: string, extra: Record<string, string> = {}) => fetch(harness.url + path, {
    method: 'POST', body: JSON.stringify(value), headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', ...extra } });
  const bootstrap = async () => {
    const response = await get('/api/dev-calling/bootstrap'); assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, ...await response.json() as { csrfToken: string } };
  };
  const login = async (identifier: 'alice' | 'bob') => {
    const initial = await bootstrap();
    const response = await post('/api/auth/login', { identifier, password: identifier === 'alice' ? environment.DEV_CALLS_ALICE_PASSWORD : environment.DEV_CALLS_BOB_PASSWORD }, initial.cookie, initial.csrfToken);
    assert.equal(response.status, 200);
    return { initial, cookie: response.headers.get('set-cookie')!.split(';')[0]!, ...await response.json() as { csrfToken: string; user: { id: string; displayName: string } } };
  };
  const connect = async (cookie: string) => {
    const socket = io(harness.url, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { origin, cookie } });
    const client = new TestClient(socket); sockets.push(client);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return client;
  };
  return { harness, created, deleted, get, post, bootstrap, login, connect };
}

test('development startup requires explicit opt-in, loopback origin, loopback bind and distinct configured credentials', () => {
  for (const change of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test' }, { NODE_ENV: '' }, { SECUBUZZ_DEV_CALLS_ENABLED: 'false' },
    { DEV_CALLS_HOST: '0.0.0.0' }, { DEV_CALLS_APP_ORIGIN: 'https://external.example' }, { DEV_CALLS_APP_ORIGIN: origin + '/path' },
    { DEV_CALLS_PORT: '-1' }, { DEV_CALLS_ALICE_PASSWORD: '' }, { DEV_CALLS_BOB_PASSWORD: environment.DEV_CALLS_ALICE_PASSWORD }]) {
    assert.throws(() => loadDevelopmentCallingConfig({ ...environment, ...change }));
  }
  assert.equal(loadDevelopmentCallingConfig(environment).port, 0);
});

test('production refuses even importing development adapters and the executable never starts in production', () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  for (const module of ['./dev/calling/adapters.ts', './dev/calling/main.ts']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('${module}')`], {
      cwd, env: { ...process.env, ...environment, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 5000,
    });
    assert.notEqual(child.status, 0); assert.match(child.stderr, /refuses production/);
    assert.ok(!child.stderr.includes(environment.DEV_CALLS_ALICE_PASSWORD));
  }
});

test('production sources never import the development harness or its adapters', () => {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts')) assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s+|import\s*\()['"][^'"]*dev\/calling/);
    }
  };
  visit(root);
});

test('bootstrap creates an anonymous cookie and login requires both its CSRF token and the configured account password', async () => {
  const ctx = await setup(); const initial = await ctx.bootstrap();
  assert.deepEqual(await (await ctx.get('/api/auth/me', initial.cookie)).json(), { user: null });
  const input = { identifier: 'alice', password: environment.DEV_CALLS_ALICE_PASSWORD };
  assert.equal((await ctx.post('/api/auth/login', input, '', initial.csrfToken)).status, 403);
  assert.equal((await ctx.post('/api/auth/login', input, initial.cookie, '')).status, 403);
  const another = await ctx.bootstrap();
  assert.equal((await ctx.post('/api/auth/login', input, initial.cookie, another.csrfToken)).status, 403);
  assert.equal((await ctx.post('/api/auth/login', { ...input, password: 'wrong-password' }, initial.cookie, initial.csrfToken)).status, 401);
  assert.equal((await ctx.post('/api/auth/login', { ...input, identifier: 'arbitrary-user' }, initial.cookie, initial.csrfToken)).status, 401);
  assert.equal((await ctx.post('/api/auth/login', { ...input, callerId: 'call-dev-bob' }, initial.cookie, initial.csrfToken)).status, 400);
  const response = await ctx.post('/api/auth/login', input, initial.cookie, initial.csrfToken);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//);
  assert.notEqual(cookie.split(';')[0], initial.cookie);
  const value = await response.json() as { user: typeof DEVELOPMENT_USERS[number]; csrfToken: string };
  assert.equal(value.user.id, DEVELOPMENT_USERS[0].id); assert.equal(value.user.isDemo, false); assert.notEqual(value.csrfToken, initial.csrfToken);
  assert.equal(JSON.stringify(value).includes(environment.DEV_CALLS_ALICE_PASSWORD), false);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await (await ctx.get('/api/auth/me', initial.cookie)).json(), { user: null });
});

test('two server-owned users receive only the fixed conversation and authenticated signaling derives caller identity', async () => {
  const ctx = await setup(); const alice = await ctx.login('alice'), bob = await ctx.login('bob');
  const target = await (await ctx.get('/api/dev-calling/context', alice.cookie)).json() as { peer: { id: string }; conversation: { id: string } };
  assert.equal(target.peer.id, bob.user.id); assert.equal(target.conversation.id, conversationId);
  assert.equal((await ctx.get('/api/dev-calling/context')).status, 401);
  const a = await ctx.connect(alice.cookie), b = await ctx.connect(bob.cookie);
  const input = { requestId: 'test', conversationId, recipientId: bob.user.id, kind: 'voice' };
  assert.deepEqual(await a.emitAck(C.initiate, { ...input, callerId: bob.user.id }), { status: 'error', code: 'invalid_payload' });
  assert.deepEqual(await a.emitAck(C.initiate, { ...input, conversationId: 'other-conversation' }), { status: 'error', code: 'call_not_allowed' });
  const result = await a.emitAck(C.initiate, input);
  assert.equal(result.call.caller.userId, alice.user.id);
  assert.equal((await b.waitFor(S.state)).caller.displayName, alice.user.displayName);
  const accepted = await b.emitAck(C.accept, { callId: result.call.callId }); assert.equal(accepted.call.status, 'accepted');
  assert.equal((await a.emitAck(C.end, { callId: result.call.callId })).call.status, 'ended');
  assert.equal((await b.emitAck(C.sync, {})).calls[0].status, 'ended');
  assert.equal(ctx.harness.mediaConfigured, false);
  assert.equal((await ctx.post('/api/calls/token', { callId: result.call.callId, connectionId: a.socket.id }, alice.cookie, alice.csrfToken)).status, 503);
});

test('anonymous and duplicate-cookie sessions cannot authenticate a realtime connection', async () => {
  const ctx = await setup(); const initial = await ctx.bootstrap(); const alice = await ctx.login('alice');
  for (const cookie of ['', initial.cookie, `${alice.cookie}; ${alice.cookie}`]) await assert.rejects(ctx.connect(cookie));
  assert.equal(ctx.harness.realtime.getStats().connections, 0);
});

test('cross-site origins and non-loopback Host values cannot use the development HTTP endpoints', async () => {
  const ctx = await setup();
  assert.equal((await ctx.get('/api/dev-calling/bootstrap', '', { origin: 'https://evil.example' })).status, 403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(ctx.harness.url + '/api/dev-calling/bootstrap', { headers: { host: 'evil.example', origin } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await ctx.get('/api/dev-calling/bootstrap', '', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await ctx.get('/api/dev-calling/bootstrap')).headers.get('access-control-allow-origin'), null);
});

test('the harness mounts real token authorization and signs only accepted, session-bound calls', async () => {
  const ctx = await setup(true); const alice = await ctx.login('alice'), bob = await ctx.login('bob');
  const a = await ctx.connect(alice.cookie), b = await ctx.connect(bob.cookie);
  const result = await a.emitAck(C.initiate, { requestId: 'media', conversationId, recipientId: bob.user.id, kind: 'video' });
  const payload = { callId: result.call.callId, connectionId: a.socket.id };
  assert.equal((await ctx.post('/api/calls/token', payload, alice.cookie, alice.csrfToken)).status, 403);
  await b.emitAck(C.accept, { callId: result.call.callId });
  assert.equal((await ctx.post('/api/calls/token', payload, alice.cookie, bob.csrfToken)).status, 403);
  assert.equal((await ctx.post('/api/calls/token', { ...payload, connectionId: b.socket.id }, alice.cookie, alice.csrfToken)).status, 403);
  const response = await ctx.post('/api/calls/token', payload, alice.cookie, alice.csrfToken);
  assert.equal(response.status, 200);
  const details = await response.json() as { token: string; roomName: string };
  const claims = await new TokenVerifier(key, secret).verify(details.token); assert.equal(claims.video?.room, details.roomName);
  assert.equal(ctx.created.length, 1); assert.equal(JSON.stringify(details).includes(secret), false);
  const gone = a.waitForDisconnect();
  assert.equal((await ctx.post('/api/auth/logout', {}, alice.cookie, alice.csrfToken)).status, 200); await gone;
  assert.equal((await b.waitFor(S.state, call => call.status === 'ended')).reason, 'disconnected');
  await eventually(() => ctx.deleted.includes(details.roomName));
  assert.deepEqual(await (await ctx.get('/api/auth/me', alice.cookie)).json(), { user: null });
  assert.equal((await ctx.post('/api/calls/token', payload, alice.cookie, alice.csrfToken)).status, 401);
});

test('in-memory session expiry, revocation and actor matching deny stale or forged membership', async () => {
  let now = Date.now(); const adapters = new DevelopmentCallAdapters(loadDevelopmentCallingConfig(environment), () => now);
  const session = adapters.create(DEVELOPMENT_USERS[0]);
  const actor = { sessionId: session.sessionId, userId: DEVELOPMENT_USERS[0].id, displayName: DEVELOPMENT_USERS[0].displayName };
  assert.deepEqual(await adapters.listConversationIds(actor), [conversationId]);
  assert.deepEqual(await adapters.listConversationIds({ ...actor, userId: DEVELOPMENT_USERS[1].id }), []);
  assert.equal(await adapters.resolveDirectConversation(actor, 'unknown'), null);
  const request = { headers: { cookie: `${DEVELOPMENT_COOKIE}=${session.token}`, 'x-csrf-token': session.csrf } } as unknown as IncomingMessage;
  assert.equal(adapters.verifyCsrf(request, actor), true);
  now += SESSION_TTL_MS + 1;
  assert.equal((await adapters.checkSession(actor)).status, 'expired'); assert.deepEqual(await adapters.listConversationIds(actor), []);
  assert.equal(adapters.verifyCsrf(request, actor), false);
  adapters.revoke(actor.sessionId); assert.equal((await adapters.checkSession(actor)).status, 'revoked'); adapters.clear();
});

test('service status is authenticated and distinguishes disabled media from configuration readiness', async () => {
  const ctx = await setup();
  assert.equal((await ctx.get('/api/dev-calling/status')).status, 401);
  const alice = await ctx.login('alice');
  assert.deepEqual(await (await ctx.get('/api/dev-calling/status', alice.cookie)).json(), { developmentOnly: true, mediaConfigured: false, livekit: 'disabled' });
});

test('read-only LiveKit probe reports failures safely, coalesces checks and never exposes SDK diagnostics', async () => {
  const config = loadLiveKitConfig({ ...environment, LIVEKIT_ENABLED: 'true', LIVEKIT_URL: 'wss://media.example.invalid', LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret });
  let checks = 0;
  const failure = createDevelopmentLiveKitStatus(config, true, { async listRooms() { ++checks; throw new Error(secret); } });
  assert.deepEqual(await Promise.all([failure(), failure()]), ['unavailable', 'unavailable']);
  assert.equal(await failure(), 'unavailable'); assert.equal(checks, 1);
  const success = createDevelopmentLiveKitStatus(config, true, { async listRooms() { return ['private room names never returned']; } });
  assert.equal(await success(), 'available');
  assert.equal(await createDevelopmentLiveKitStatus(loadLiveKitConfig({}), true)(), 'unconfigured');
});
