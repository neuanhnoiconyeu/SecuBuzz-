import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HandshakeAuthenticator } from '../../src/realtime/authentication.ts';
import { ServerClock } from '../../src/realtime/clock.ts';
import { resolveRealtimeConfig } from '../../src/realtime/config.ts';
import { silentLogger } from '../../src/realtime/logger.ts';
import { ConnectionRegistry, type RealtimeSocket } from '../../src/realtime/registry.ts';
import { TestAuthorizer, TestSessionResolver } from '../support/fixtures.ts';

const ORIGIN = 'http://localhost:3000';

function fakeSocket(headers: Record<string, string>): RealtimeSocket {
  return { handshake: { headers, address: '127.0.0.1', secure: false }, data: {} } as unknown as RealtimeSocket;
}

function authenticator(options: { closing?: boolean } = {}) {
  const sessions = new TestSessionResolver();
  sessions.add('t1', { sessionId: 's1', userId: 'alice', displayName: 'Alice', expiresAt: new Date(Date.now() + 60_000) });
  const config = resolveRealtimeConfig({ allowedOrigins: [ORIGIN], logger: silentLogger, sessionResolver: sessions, authorizer: new TestAuthorizer() });
  const registry = new ConnectionRegistry();
  let sequence = 0;
  const subject = new HandshakeAuthenticator({
    config, registry, clock: new ServerClock(100), isClosing: () => options.closing === true, isSessionRevoked: () => false,
    beginAccessLoad: () => ++sequence,
  });
  return { subject, sessions, registry };
}

test('the namespace middleware re-checks Origin as defense in depth (ORIGIN_NOT_ALLOWED)', async () => {
  const { subject, sessions } = authenticator();
  const outcome = await subject.authenticate(fakeSocket({ origin: 'https://evil.example', cookie: 'secubuzz_session=t1' }));
  assert.deepEqual(outcome, { ok: false, code: 'ORIGIN_NOT_ALLOWED', reason: 'origin' });
  assert.equal(sessions.contexts.length, 0);
});

test('rejects new handshakes while the server is closing', async () => {
  const { subject } = authenticator({ closing: true });
  const outcome = await subject.authenticate(fakeSocket({ origin: ORIGIN, cookie: 'secubuzz_session=t1' }));
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'REALTIME_UNAVAILABLE');
});

test('produces a frozen grant bound to the resolved session and releases the pending counter', async () => {
  const { subject, registry } = authenticator();
  const outcome = await subject.authenticate(fakeSocket({ origin: ORIGIN, cookie: 'secubuzz_session=t1' }));
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.grant.actor, { userId: 'alice', sessionId: 's1', displayName: 'Alice' });
  assert.ok(Object.isFrozen(outcome.grant) && Object.isFrozen(outcome.grant.actor));
  assert.equal(outcome.grant.loadedSequence, 1, 'the access sequence is taken before the authorizer is queried');
  assert.equal(registry.pendingHandshakes, 0);
});
