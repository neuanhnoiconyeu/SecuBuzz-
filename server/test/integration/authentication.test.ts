import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:http';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { attachRealtimeServer } from '../../src/realtime/server.ts';
import { silentLogger } from '../../src/realtime/logger.ts';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import { delay, SESSION_COOKIE, startTestServer, TEST_ORIGIN, type TestServer } from '../support/harness.ts';

let server: TestServer;

function pollingHandshake(target: TestServer, origin: string | null): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${target.url}${target.path}/?EIO=4&transport=polling`, { headers: origin ? { origin } : {} }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('authentication', () => {
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  test('accepts a valid session and passes only the cookie value and handshake metadata to the resolver', async () => {
    const alice = server.addUser('alice');
    const client = await server.connect(alice, { auth: { userId: 'mallory', token: 'forged' }, query: { userId: 'mallory' } });
    assert.equal(client.connected, true);
    assert.equal(server.sessions.contexts.length, 1);
    const context = server.sessions.contexts[0]!;
    assert.deepEqual(Object.keys(context).sort(), ['origin', 'receivedAt', 'remoteAddress', 'secure', 'sessionToken', 'userAgent']);
    assert.equal(context.sessionToken, alice.token);
    assert.equal(context.origin, TEST_ORIGIN);
    assert.ok(!JSON.stringify(context).includes('mallory'), 'handshake auth and query never reach the resolver');
    assert.equal(server.handle.getStats().connections, 1);
  });

  test('binds the session identity and ignores identity claims in auth, query and event bodies', async () => {
    const alice = server.addUser('alice', { displayName: 'Alice A.' });
    const carol = server.addUser('carol');
    server.authorizer.grant('alice', 'c1');
    server.authorizer.grant('carol', 'c1');
    const impostor = await server.connect(alice, { auth: { userId: 'carol' }, query: { userId: 'carol' } });
    const observer = await server.connect(carol);
    impostor.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c1' });
    const update = await observer.waitFor(SERVER_EVENTS.typingUpdate);
    assert.equal(update.userId, 'alice');
    assert.equal(update.displayName, 'Alice A.');
    const mark = observer.mark();
    impostor.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c1', userId: 'carol', displayName: 'Carol' });
    await observer.expectNone(SERVER_EVENTS.typingUpdate, () => true, { since: mark });
  });

  test('rejects a missing session cookie with AUTH_REQUIRED without calling the resolver', async () => {
    const error = await server.connectError(null);
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.equal(error.message, 'Authentication required.');
    assert.deepEqual(error.data, { code: 'AUTH_REQUIRED' });
    assert.equal(server.sessions.contexts.length, 0);
  });

  test('treats an empty cookie and a resolver "missing" result as AUTH_REQUIRED', async () => {
    assert.equal((await server.connectError(null, { cookie: `${SESSION_COOKIE}=` })).code, 'AUTH_REQUIRED');
    server.sessions.markMissing('ghost');
    assert.equal((await server.connectError('ghost')).code, 'AUTH_REQUIRED');
  });

  test('rejects unknown, duplicated and malformed session cookies with UNAUTHORIZED', async () => {
    const alice = server.addUser('alice');
    assert.equal((await server.connectError('not-a-real-session')).code, 'UNAUTHORIZED');
    const duplicate = await server.connectError(null, { cookie: `${SESSION_COOKIE}=${alice.token}; ${SESSION_COOKIE}=other` });
    assert.equal(duplicate.code, 'UNAUTHORIZED');
    assert.equal((await server.connectError(null, { cookie: `${SESSION_COOKIE}=%E0%A4%A` })).code, 'UNAUTHORIZED');
    assert.equal(server.sessions.contexts.length, 1, 'only the well-formed unknown token reached the resolver');
  });

  test('rejects expired sessions with SESSION_EXPIRED', async () => {
    server.sessions.markExpired('stale-token');
    assert.equal((await server.connectError('stale-token')).code, 'SESSION_EXPIRED');
    const lapsed = server.addUser('alice', { ttlMs: -1_000 });
    assert.equal((await server.connectError(lapsed)).code, 'SESSION_EXPIRED');
  });

  test('rejects reserved demo identities returned by a resolver', async () => {
    for (const userId of ['local-user', 'demo-session-nova', 'DEMO_explorer']) {
      server.sessions.override = { status: 'authenticated', session: { sessionId: 's-demo', userId, displayName: 'Demo', expiresAt: new Date(Date.now() + 60_000) } };
      assert.equal((await server.connectError('any-token')).code, 'UNAUTHORIZED', userId);
    }
    assert.ok(server.logger.has('realtime.connection.demo_identity_rejected'));
  });

  test('fails closed with REALTIME_UNAVAILABLE when the resolver throws, hangs or returns malformed data', async () => {
    const alice = server.addUser('alice');
    for (const mode of ['throw', 'malformed'] as const) {
      server.sessions.mode = mode;
      assert.equal((await server.connectError(alice)).code, 'REALTIME_UNAVAILABLE', mode);
    }
    server.sessions.mode = 'hang';
    const started = Date.now();
    assert.equal((await server.connectError(alice)).code, 'REALTIME_UNAVAILABLE');
    assert.ok(Date.now() - started < 1_500, 'the handshake deadline bounds a hanging resolver');
    assert.equal(server.handle.getStats().pendingHandshakes, 0);
  });

  test('never exposes resolver error text, cookies or tokens in errors or logs', async () => {
    const alice = server.addUser('alice');
    server.sessions.mode = 'throw';
    const error = await server.connectError(alice);
    assert.equal(error.message, 'Realtime service unavailable.');
    const logs = server.logger.text();
    assert.ok(!logs.includes('hunter2'), 'adapter error messages are not logged');
    assert.ok(!logs.includes(alice.token), 'session tokens are not logged');
    assert.ok(!logs.includes(alice.sessionId), 'session IDs are not logged');
    assert.ok(server.logger.has('realtime.connection.rejected'));
  });

  test('rejects handshakes without an allowlisted Origin before any session lookup', async () => {
    const alice = server.addUser('alice');
    for (const origin of [null, 'https://evil.example', 'http://localhost:3001']) {
      const error = await server.connectError(alice, { origin });
      assert.equal(error.code, undefined, 'rejected at the transport, before the namespace middleware');
    }
    assert.equal(server.sessions.contexts.length, 0);
    assert.equal(server.handle.getStats().connections, 0);
  });

  test('answers polling CORS only for exact allowlisted origins, with credentials', async () => {
    const allowed = await pollingHandshake(server, TEST_ORIGIN);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], TEST_ORIGIN);
    assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
    const denied = await pollingHandshake(server, 'https://evil.example');
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    const missing = await pollingHandshake(server, null);
    assert.equal(missing.status, 403);
  });

  test('does not serve the Socket.IO client bundle', async () => {
    const response = await fetch(`${server.url}/socket.io/socket.io.js`);
    await response.arrayBuffer();
    assert.notEqual(response.status, 200);
  });

  test('a rejected handshake joins no room and receives no events', async () => {
    const alice = server.addUser('alice');
    server.authorizer.grant('alice', 'c1');
    server.authorizer.grant('mallory', 'c1');
    const member = await server.connect(alice);
    await server.connectError('forged-mallory-token');
    member.emit(CLIENT_EVENTS.typingStart, { conversationId: 'c1' });
    await delay(50);
    const stats = server.handle.getStats();
    assert.equal(stats.connections, 1);
    assert.equal(stats.users, 1);
    assert.equal(stats.conversationRooms, 1);
    assert.equal(stats.pendingHandshakes, 0);
  });

  test('rejects a session revoked while its handshake was being authenticated', async () => {
    const alice = server.addUser('alice');
    server.authorizer.conversationsMode = 'normal';
    const original = server.authorizer.listConversationIds.bind(server.authorizer);
    server.authorizer.listConversationIds = async (actor) => {
      server.handle.revokeSession(alice.sessionId);
      return original(actor);
    };
    assert.equal((await server.connectError(alice)).code, 'UNAUTHORIZED');
  });
});

describe('fail-closed modes and limits', () => {
  after(async () => {
    await delay(0);
  });

  test('without a session resolver every connection is rejected with REALTIME_UNAVAILABLE', async () => {
    const target = await startTestServer({ withSessionResolver: false });
    try {
      const user = target.addUser('alice');
      assert.equal((await target.connectError(user)).code, 'REALTIME_UNAVAILABLE');
      const started = target.logger.entries.find((entry) => entry.event === 'realtime.started');
      assert.equal(started?.level, 'warn');
      assert.equal(started?.fields.mode, 'fail-closed');
      assert.equal(started?.fields.messageDelivery, 'disabled');
      assert.equal(target.handle.getStats().mode, 'fail-closed');
    } finally {
      await target.close();
    }
  });

  test('without an authorizer every connection is rejected with REALTIME_UNAVAILABLE', async () => {
    const target = await startTestServer({ withAuthorizer: false });
    try {
      assert.equal((await target.connectError(target.addUser('alice'))).code, 'REALTIME_UNAVAILABLE');
      assert.equal(target.sessions.contexts.length, 0, 'no session lookup when authorization is impossible');
    } finally {
      await target.close();
    }
  });

  test('enforces per-user and global connection limits with CONNECTION_LIMIT', async () => {
    const target = await startTestServer({ limits: { maxConnectionsPerUser: 2, maxConnections: 3 } });
    try {
      const alice = target.addUser('alice');
      await target.connect(alice);
      await target.connect(alice);
      assert.equal((await target.connectError(alice)).code, 'CONNECTION_LIMIT');
      await target.connect(target.addUser('bob'));
      assert.equal((await target.connectError(target.addUser('carol'))).code, 'CONNECTION_LIMIT');
    } finally {
      await target.close();
    }
  });

  test('bounds concurrent handshakes with CONNECTION_LIMIT', async () => {
    const target = await startTestServer({ limits: { maxPendingHandshakes: 1 }, timing: { adapterTimeoutMs: 400, handshakeTimeoutMs: 800 } });
    try {
      const alice = target.addUser('alice');
      const bob = target.addUser('bob');
      const original = target.sessions.resolveSession.bind(target.sessions);
      target.sessions.resolveSession = async (context) => {
        await delay(150);
        return original(context);
      };
      const [first, second] = await Promise.allSettled([target.connect(alice), delay(30).then(() => target.connect(bob))]);
      assert.equal(first.status, 'fulfilled');
      assert.equal(second.status, 'rejected');
      assert.equal((second as PromiseRejectedResult).reason.code, 'CONNECTION_LIMIT');
    } finally {
      await target.close();
    }
  });

  test('a custom namespace rejects the default namespace and a custom path is honored', async () => {
    const target = await startTestServer({ namespace: '/realtime', path: '/rt' });
    try {
      const alice = target.addUser('alice');
      assert.equal((await target.connectError(alice)).code, 'REALTIME_UNAVAILABLE');
      const client = await target.connect(alice, { namespace: '/realtime' });
      assert.equal(client.connected, true);
    } finally {
      await target.close();
    }
  });

  test('refuses to attach twice to the same HTTP server', () => {
    const httpServer = createServer();
    const handle = attachRealtimeServer(httpServer, { allowedOrigins: [TEST_ORIGIN], logger: silentLogger });
    assert.throws(() => attachRealtimeServer(httpServer, { allowedOrigins: [TEST_ORIGIN], logger: silentLogger }), /already attached/);
    void handle.close();
  });

  test('refuses invalid configuration at startup', () => {
    assert.throws(() => attachRealtimeServer(createServer(), { allowedOrigins: ['*'], logger: silentLogger }), /origin/i);
    assert.throws(() => attachRealtimeServer(createServer(), { allowedOrigins: [TEST_ORIGIN], sessionResolver: {} as never, logger: silentLogger }),
      /sessionResolver/);
  });
});
