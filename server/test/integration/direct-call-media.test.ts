import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { TokenVerifier } from 'livekit-server-sdk';
import { attachRealtimeServer } from '../../src/realtime/server.ts';
import { createLiveKitHttpHandler, createDirectCallMediaLifecycle, loadLiveKitConfig, type DirectCallRoomService } from '../../src/livekit/index.ts';
import { directCallParticipantIdentity, directCallRoomName } from '../../src/livekit/config.ts';
import { CALL_CLIENT_EVENTS as C, CALL_SERVER_EVENTS as S } from '../../src/calls/protocol.ts';
import { TestDirectCallResolver } from '../support/callFixtures.ts';
import { CapturingLogger, TestAuthorizer, TestKeyVerifier, TestMessageStore, TestSessionResolver } from '../support/fixtures.ts';
import { TestServer, eventually, TEST_ORIGIN, FAST_TIMING } from '../support/harness.ts';

const key = 'test-key', secret = 'test-only-call-secret-more-than-32-characters';
const config = loadLiveKitConfig({ NODE_ENV: 'production', LIVEKIT_ENABLED: 'true', LIVEKIT_URL: 'wss://media.example.invalid', LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret });
let server: TestServer;
afterEach(async () => { await server?.close(); });

async function setup(options: { holdCreation?: Promise<void>; noMedia?: boolean; failDeletes?: number; failCreate?: boolean } = {}) {
  const sessions = new TestSessionResolver(), authorizer = new TestAuthorizer(), resolver = new TestDirectCallResolver(); resolver.add('dm-ab', 'alice', 'bob');
  const created: Array<Record<string, unknown>> = [], removed: string[] = [];
  let failures = options.failDeletes ?? 0;
  const roomService: DirectCallRoomService = {
    async createRoom(input) { created.push({ ...input }); if (options.failCreate) throw new Error(secret); if (options.holdCreation) await options.holdCreation; return {} as Awaited<ReturnType<DirectCallRoomService['createRoom']>>; },
    async deleteRoom(name) { if (failures-- > 0) throw new Error('private failure'); removed.push(name); },
  };
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  const http = createServer((request, response) => { void handler(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  const handle = attachRealtimeServer(http, { allowedOrigins: [TEST_ORIGIN], sessionResolver: sessions, authorizer, logger: new CapturingLogger(),
    timing: FAST_TIMING, directCalls: { conversationResolver: resolver, ...(options.noMedia ? {} : { media: createDirectCallMediaLifecycle(config, roomService) }) } });
  handler = createLiveKitHttpHandler({ config, allowedOrigins: [TEST_ORIGIN], sessionResolver: sessions, authorizer,
    verifyCsrf: async request => request.headers['x-csrf-token'] === 'csrf', directCalls: handle });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  server = new TestServer(http, handle, { sessions, authorizer, store: new TestMessageStore(), verifier: new TestKeyVerifier(), logger: new CapturingLogger() }, '/socket.io');
  server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const alice = server.addUser('alice'), bob = server.addUser('bob'), carol = server.addUser('carol');
  for (const user of ['alice', 'bob', 'carol']) authorizer.grant(user, 'dm-ab');
  const a = await server.connect(alice), b = await server.connect(bob), c = await server.connect(carol);
  const post = (token: string, callId: string, connectionId: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => fetch(`${server.url}/api/calls/token`, {
    method: 'POST', headers: { origin: TEST_ORIGIN, cookie: `secubuzz_session=${token}`, 'x-csrf-token': 'csrf', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ callId, connectionId, ...extra }),
  });
  const start = await a.emitAck(C.initiate, { requestId: 'first', conversationId: 'dm-ab', recipientId: 'bob', kind: 'voice' });
  assert.equal(start.status, 'ok');
  return { alice, bob, carol, a, b, c, post, callId: start.call.callId as string, created, removed, authorizer, resolver };
}

test('tokens require accepted signaling and give only the two authenticated endpoints the same private media room', async () => {
  const ctx = await setup();
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!)).status, 403); assert.equal(ctx.created.length, 0);
  await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  const [a, b] = await Promise.all([ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!), ctx.post(ctx.bob.token, ctx.callId, ctx.b.socket.id!)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const first = await a.json() as Record<string, string>, second = await b.json() as Record<string, string>;
  assert.equal(first.roomName, directCallRoomName(ctx.callId)); assert.equal(first.roomName, second.roomName); assert.match(first.roomName!, /^direct:[a-f0-9]{64}$/);
  assert.equal(first.peerIdentity, second.participantIdentity); assert.equal(second.peerIdentity, first.participantIdentity);
  assert.equal(first.participantIdentity, directCallParticipantIdentity(ctx.callId, 'alice'));
  assert.equal(ctx.created.length, 1); assert.equal(ctx.created[0]!.maxParticipants, 2);
  const claims = await new TokenVerifier(key, secret).verify(first.token!);
  assert.equal(claims.video?.roomJoin, true); assert.equal(claims.video?.room, first.roomName);
  assert.equal(claims.video?.canPublish, true); assert.equal(claims.video?.canSubscribe, true); assert.equal(claims.video?.canPublishData, false);
  assert.deepEqual(claims.video?.canPublishSources, ['microphone', 'camera', 'screen_share']); assert.ok(!claims.video?.roomAdmin && !claims.video?.roomList && !claims.video?.roomCreate);
  assert.ok((claims.exp as number) * 1000 <= Date.now() + 30_000);
  assert.ok(!JSON.stringify(first).includes(secret)); assert.ok(!JSON.stringify(first).includes(ctx.alice.sessionId));
  assert.equal(a.headers.get('cache-control'), 'private, no-store');
});

test('LiveKit room creation failure is unavailable only after accepted-call authorization, without exposing SDK diagnostics', async () => {
  const ctx = await setup({ failCreate: true });
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!)).status, 403);
  await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  assert.equal((await ctx.post(ctx.carol.token, ctx.callId, ctx.c.socket.id!)).status, 403);
  const response = await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'livekit_unavailable' });
});

test('anonymous users, outsiders, forged signaling endpoints, extra identity fields and missing CSRF never receive tokens', async () => {
  const ctx = await setup(); await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  assert.equal((await ctx.post('invalid', ctx.callId, ctx.a.socket.id!)).status, 401);
  assert.equal((await ctx.post(ctx.carol.token, ctx.callId, ctx.c.socket.id!)).status, 403);
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.b.socket.id!)).status, 403);
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!, { callerId: 'bob' })).status, 400);
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!, { roomName: 'selected-room' })).status, 400);
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!, {}, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!, {}, { origin: 'https://evil.invalid' })).status, 403);
  assert.equal(ctx.created.length, 0);
});

test('a second device cannot take over an accepted media endpoint, including a tab sharing the same cookie session', async () => {
  const ctx = await setup(); const b2 = await server.connect(ctx.bob);
  await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  await b2.emitAck(C.accept, { callId: ctx.callId });
  const conflict = await ctx.post(ctx.bob.token, ctx.callId, b2.socket.id!);
  assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { error: 'media_in_use' });
  assert.equal((await ctx.post(ctx.bob.token, ctx.callId, ctx.b.socket.id!)).status, 200);
  const otherSession = server.addUser('alice'); const a2 = await server.connect(otherSession);
  assert.equal((await ctx.post(otherSession.token, ctx.callId, ctx.a.socket.id!)).status, 403);
  assert.equal((await ctx.post(otherSession.token, ctx.callId, a2.socket.id!)).status, 409);
});

test('hangup deletes the private LiveKit room, synchronizes terminal state and prevents new tokens', async () => {
  const ctx = await setup({ failDeletes: 2 }); await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!)).status, 200);
  const ended = await ctx.b.emitAck(C.end, { callId: ctx.callId }); assert.equal(ended.call.status, 'ended');
  await ctx.a.waitFor(S.state, call => call.status === 'ended');
  await eventually(() => ctx.removed.includes(directCallRoomName(ctx.callId)));
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!)).status, 403);
});

test('revocation deletes an active room without issuing more tokens', async () => {
  const ctx = await setup(); await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!);
  ctx.authorizer.block('alice', 'bob'); await server.handle.refreshUserAccess('alice');
  await eventually(() => ctx.removed.includes(directCallRoomName(ctx.callId)));
  assert.equal((await ctx.post(ctx.bob.token, ctx.callId, ctx.b.socket.id!)).status, 403);
});

test('an owning signaling connection disconnect ends media even while another device of that user stays online', async () => {
  const ctx = await setup(); await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!);
  await server.connect(ctx.alice); ctx.a.close();
  await ctx.b.waitFor(S.state, call => call.status === 'ended');
  await eventually(() => ctx.removed.includes(directCallRoomName(ctx.callId)));
  assert.equal(server.handle.getStats().activeCalls, 0);
});

test('ending during a slow room creation cleans up the late room and never returns a usable token', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const ctx = await setup({ holdCreation: held }); await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  const pending = ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!);
  await eventually(() => ctx.created.length === 1);
  await ctx.b.emitAck(C.end, { callId: ctx.callId }); release();
  assert.equal((await pending).status, 403);
  await eventually(() => ctx.removed.length >= 2);
  assert.equal(server.handle.getStats().activeCalls, 0);
});

test('missing media lifecycle never turns an accepted invitation into a production token', async () => {
  const ctx = await setup({ noMedia: true }); await ctx.b.emitAck(C.accept, { callId: ctx.callId });
  assert.equal((await ctx.post(ctx.alice.token, ctx.callId, ctx.a.socket.id!)).status, 403); assert.equal(ctx.created.length, 0);
});
