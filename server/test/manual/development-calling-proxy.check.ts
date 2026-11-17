// Opt-in integration check: starts Next.js, the harness and a local LiveKit HTTP protocol double.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { TokenVerifier } from 'livekit-server-sdk';
import { startDevelopmentCallingHarness } from '../../dev/calling/server.ts';
import { CALL_CLIENT_EVENTS as C, CALL_SERVER_EVENTS as S, type CallSnapshot } from '../../src/calls/protocol.ts';

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const stop = (server: Server) => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); };

test('Next same-origin HTTP, polling and WebSocket upgrades preserve cookie/CSRF and accepted-call authorization', async () => {
  const key = 'proxy-test-key', secret = 'proxy-test-secret-longer-than-32-characters';
  const serviceRequests: string[] = [];
  const media = createServer((request, response) => {
    assert.match(request.headers.authorization ?? '', /^Bearer /);
    serviceRequests.push(request.url ?? ''); request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url?.endsWith('/ListRooms') ? { rooms: [] } : {}));
  });
  const mediaPort = await listen(media);
  const reservation = createServer(); const port = await listen(reservation); await stop(reservation);
  const origin = `http://127.0.0.1:${port}`;
  const harness = await startDevelopmentCallingHarness({ NODE_ENV: 'development', SECUBUZZ_DEV_CALLS_ENABLED: 'true',
    DEV_CALLS_PORT: '0', DEV_CALLS_APP_ORIGIN: origin, DEV_CALLS_ALICE_PASSWORD: 'alice-proxy-test-password', DEV_CALLS_BOB_PASSWORD: 'bob-proxy-test-password',
    LIVEKIT_ENABLED: 'true', LIVEKIT_URL: `ws://127.0.0.1:${mediaPort}`, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret });
  const clientDirectory = fileURLToPath(new URL('../../../client/', import.meta.url));
  const next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: clientDirectory, windowsHide: true, env: { ...process.env, NODE_ENV: 'development', SECUBUZZ_DEV_CALLS_PROXY: 'true',
      DEV_CALLS_BACKEND_URL: harness.url, NEXT_PUBLIC_DEV_CALLS_ENABLED: 'true', NEXT_PUBLIC_AUTH_MODE: 'api', NEXT_PUBLIC_AUTH_API_READY: 'true',
      NEXT_PUBLIC_REALTIME_CONTRACT_READY: 'true', NEXT_PUBLIC_REALTIME_URL: origin, NEXT_PUBLIC_REALTIME_PATH: '/socket.io',
      NEXT_PUBLIC_LIVEKIT_ENABLED: 'true', NEXT_PUBLIC_LIVEKIT_URL: `ws://127.0.0.1:${mediaPort}`, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; next.stdout.on('data', chunk => { logs = (logs + String(chunk)).slice(-4000); }); next.stderr.on('data', chunk => { logs = (logs + String(chunk)).slice(-4000); });
  const sockets: Socket[] = [];
  const get = (path: string, cookie = '') => fetch(origin + path, { headers: { origin, cookie } });
  const post = (path: string, value: unknown, cookie: string, csrf: string) => fetch(origin + path, { method: 'POST',
    headers: { origin, cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await get('/api/dev-calling/bootstrap')).ok; } catch { /* Next is starting. */ }
      if (ready) break;
      if (next.exitCode !== null) throw new Error(`Next exited before readiness: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(ready, 'Next proxy did not start.');
    const login = async (identifier: 'alice' | 'bob') => {
      const initial = await get('/api/dev-calling/bootstrap');
      const initialCookie = initial.headers.get('set-cookie')!.split(';')[0]!;
      const initialCsrf = (await initial.json() as { csrfToken: string }).csrfToken;
      assert.equal((await post('/api/auth/login', { identifier, password: `${identifier}-proxy-test-password` }, initialCookie, 'wrong-csrf')).status, 403);
      const response = await post('/api/auth/login', { identifier, password: `${identifier}-proxy-test-password` }, initialCookie, initialCsrf);
      assert.equal(response.status, 200);
      return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, ...await response.json() as { csrfToken: string; user: { id: string } } };
    };
    const alice = await login('alice'), bob = await login('bob');
    assert.notEqual(alice.cookie, bob.cookie); assert.notEqual(alice.csrfToken, bob.csrfToken); assert.notEqual(alice.user.id, bob.user.id);
    assert.equal((await (await get('/api/auth/me', alice.cookie)).json() as { user: { id: string } }).user.id, alice.user.id);
    assert.equal((await get('/api/dev-calling/context')).status, 401);
    const context = await (await get('/api/dev-calling/context', alice.cookie)).json() as { conversation: { id: string } };
    assert.equal((await (await get('/api/auth/me', bob.cookie)).json() as { user: { id: string } }).user.id, bob.user.id);
    assert.equal((await (await get('/api/dev-calling/status', alice.cookie)).json() as { livekit: string }).livekit, 'available');
    const polling = await fetch(origin + '/socket.io/?EIO=4&transport=polling', { redirect: 'manual', headers: { origin, cookie: alice.cookie } });
    assert.equal(polling.status, 200, `Socket.IO polling returned ${polling.status} ${polling.headers.get('location') ?? ''}`);
    assert.ok((await polling.text()).startsWith('0'));
    const connect = async (cookie: string, polling: boolean) => {
      const socket = io(origin, { transports: polling ? ['polling', 'websocket'] : ['websocket'], reconnection: false, forceNew: true, extraHeaders: { origin, cookie } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      if (socket.io.engine.transport.name !== 'websocket') await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket upgrade failed.')), 7000);
        socket.io.engine.once('upgrade', () => { clearTimeout(timer); resolve(); });
      });
      assert.equal(socket.io.engine.transport.name, 'websocket'); return socket;
    };
    const a = await connect(alice.cookie, true), b = await connect(bob.cookie, false);
    const nextState = (socket: Socket, status: CallSnapshot['status']) => new Promise<CallSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => { socket.off(S.state, listener); reject(new Error(`Missing call status: ${status}`)); }, 5000);
      const listener = (call: CallSnapshot) => { if (call.status === status) { clearTimeout(timer); socket.off(S.state, listener); resolve(call); } };
      socket.on(S.state, listener);
    });
    const incoming = nextState(b, 'ringing');
    const ringing = await a.timeout(4000).emitWithAck(C.initiate, { requestId: 'proxy-check', conversationId: context.conversation.id, recipientId: bob.user.id, kind: 'voice' });
    assert.equal(ringing.status, 'ok');
    const invitation = await incoming;
    assert.equal(invitation.callId, ringing.call.callId); assert.equal(invitation.caller.userId, alice.user.id); assert.equal(invitation.recipient.userId, bob.user.id);
    const payload = { callId: ringing.call.callId, connectionId: a.id };
    assert.equal((await post('/api/calls/token', payload, alice.cookie, alice.csrfToken)).status, 403);
    const acceptance = nextState(a, 'accepted');
    assert.equal((await b.timeout(4000).emitWithAck(C.accept, { callId: ringing.call.callId })).status, 'ok');
    assert.equal((await acceptance).callId, ringing.call.callId);
    assert.equal((await post('/api/calls/token', payload, alice.cookie, bob.csrfToken)).status, 403);
    const response = await post('/api/calls/token', payload, alice.cookie, alice.csrfToken);
    assert.equal(response.status, 200);
    const details = await response.json() as { token: string; roomName: string };
    assert.equal((await new TokenVerifier(key, secret).verify(details.token)).video?.room, details.roomName);
    const peerResponse = await post('/api/calls/token', { callId: ringing.call.callId, connectionId: b.id }, bob.cookie, bob.csrfToken);
    assert.equal(peerResponse.status, 200);
    const peerDetails = await peerResponse.json() as { token: string; roomName: string };
    const firstClaims = await new TokenVerifier(key, secret).verify(details.token), peerClaims = await new TokenVerifier(key, secret).verify(peerDetails.token);
    assert.equal(peerDetails.roomName, details.roomName); assert.notEqual(firstClaims.sub, peerClaims.sub);
    const ended = nextState(b, 'ended');
    assert.equal((await a.timeout(4000).emitWithAck(C.end, { callId: ringing.call.callId })).status, 'ok');
    assert.equal((await ended).callId, ringing.call.callId);

    const declinedIncoming = nextState(b, 'ringing');
    const declinedCall = await a.timeout(4000).emitWithAck(C.initiate, { requestId: 'proxy-decline', conversationId: context.conversation.id, recipientId: bob.user.id, kind: 'video' });
    assert.equal((await declinedIncoming).kind, 'video');
    const declined = nextState(a, 'declined');
    assert.equal((await b.timeout(4000).emitWithAck(C.decline, { callId: declinedCall.call.callId })).status, 'ok');
    assert.equal((await declined).callId, declinedCall.call.callId);

    const cancelledCall = await a.timeout(4000).emitWithAck(C.initiate, { requestId: 'proxy-cancel', conversationId: context.conversation.id, recipientId: bob.user.id, kind: 'voice' });
    const cancelled = nextState(b, 'cancelled');
    assert.equal((await a.timeout(4000).emitWithAck(C.cancel, { callId: cancelledCall.call.callId })).status, 'ok');
    assert.equal((await cancelled).callId, cancelledCall.call.callId);

    const interrupted = await a.timeout(4000).emitWithAck(C.initiate, { requestId: 'proxy-disconnect', conversationId: context.conversation.id, recipientId: bob.user.id, kind: 'voice' });
    await b.timeout(4000).emitWithAck(C.accept, { callId: interrupted.call.callId });
    const disconnected = nextState(b, 'ended');
    a.disconnect();
    assert.equal((await disconnected).reason, 'disconnected');
    await new Promise<void>((resolve, reject) => { a.once('connect', resolve); a.once('connect_error', reject); a.connect(); });
    const synchronized = await a.timeout(4000).emitWithAck(C.sync, {});
    assert.equal(synchronized.status, 'ok');
    assert.ok(synchronized.calls.some((call: CallSnapshot) => call.callId === interrupted.call.callId && call.status === 'ended'));

    assert.equal((await post('/api/auth/logout', {}, alice.cookie, alice.csrfToken)).status, 200);
    assert.equal((await post('/api/calls/token', payload, alice.cookie, alice.csrfToken)).status, 401);
    assert.ok(serviceRequests.some(path => path.endsWith('/CreateRoom')));
    assert.ok(serviceRequests.some(path => path.endsWith('/DeleteRoom')));
    await stop(media);
    // Unavailable RoomService fails through the existing endpoint without leaking SDK errors.
    // Use a fresh call to avoid the completed call's terminal authorization rejection.
    const again = await login('alice'); const a2 = await connect(again.cookie, false);
    const nextCall = await a2.timeout(4000).emitWithAck(C.initiate, { requestId: 'service-down', conversationId: context.conversation.id, recipientId: bob.user.id, kind: 'video' });
    await b.timeout(4000).emitWithAck(C.accept, { callId: nextCall.call.callId });
    const failed = await post('/api/calls/token', { callId: nextCall.call.callId, connectionId: a2.id }, again.cookie, again.csrfToken);
    assert.equal(failed.status, 503);
    assert.equal(JSON.stringify(await failed.json()).includes(secret), false);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (next.pid && next.exitCode === null) {
      if (process.platform === 'win32') await new Promise<void>(resolve => {
        const kill = spawn('taskkill', ['/PID', String(next.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); kill.once('exit', () => resolve());
      });
      else next.kill('SIGTERM');
    }
    await harness.close(); await stop(media);
  }
});
