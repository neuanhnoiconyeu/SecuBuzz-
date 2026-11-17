import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CALL_CLIENT_EVENTS as C, CALL_SERVER_EVENTS as S } from '../../src/calls/protocol.ts';
import type { DirectCallOptions } from '../../src/calls/config.ts';
import { TestDirectCallResolver } from '../support/callFixtures.ts';
import { delay, eventually, startTestServer, type HarnessOptions, type TestClient, type TestServer } from '../support/harness.ts';

let server: TestServer;
let resolver: TestDirectCallResolver;
afterEach(async () => { await server?.close(); });
async function setup(options: Partial<Omit<DirectCallOptions, 'conversationResolver'>> = {}, harness: HarnessOptions = {}) {
  resolver = new TestDirectCallResolver();
  for (const [conversation, first, second] of [['dm-ab', 'alice', 'bob'], ['dm-ac', 'alice', 'carol'], ['dm-bc', 'bob', 'carol']]) resolver.add(conversation!, first!, second!);
  server = await startTestServer({ ...harness, directCalls: { conversationResolver: resolver, ringTimeoutMs: 2000, ...options } });
  const alice = server.addUser('alice', { displayName: 'Authenticated Alice' }), bob = server.addUser('bob'), carol = server.addUser('carol');
  for (const id of ['alice', 'bob', 'carol']) server.authorizer.grant(id, 'dm-ab', 'dm-ac', 'dm-bc', 'group');
  const a = await server.connect(alice), b = await server.connect(bob);
  return { alice, bob, carol, a, b };
}
const initiate = (client: TestClient, requestId = 'request-1', rest: Record<string, unknown> = {}) =>
  client.emitAck(C.initiate, { requestId, conversationId: 'dm-ab', recipientId: 'bob', kind: 'voice', ...rest });

test('authenticated caller identity, incoming notification and accepted/ended revisions reach both users and devices', async () => {
  const { a, b, alice, bob, carol } = await setup();
  const a2 = await server.connect(alice), b2 = await server.connect(bob), outsider = await server.connect(carol);
  const created = await initiate(a);
  assert.equal(created.status, 'ok'); assert.match(created.call.callId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created.call.caller, { userId: 'alice', displayName: 'Authenticated Alice' });
  assert.deepEqual(created.call.recipient, { userId: 'bob', displayName: 'Directory bob' });
  assert.equal(resolver.actors[0]!.sessionId, alice.sessionId);
  for (const device of [a, a2, b, b2]) assert.deepEqual(await device.waitFor(S.state), created.call);
  await outsider.expectNone(S.state, () => true, { ms: 30 });
  const accepted = await b.emitAck(C.accept, { callId: created.call.callId });
  assert.equal(accepted.call.status, 'accepted'); assert.equal(accepted.call.revision, 2);
  assert.equal('connectedAt' in accepted.call, false); assert.equal('token' in accepted.call, false);
  for (const device of [a, a2, b, b2]) await device.waitFor(S.state, call => call.status === 'accepted');
  assert.deepEqual(await b2.emitAck(C.accept, { callId: created.call.callId }), accepted);
  const ended = await a.emitAck(C.end, { callId: created.call.callId });
  assert.equal(ended.call.status, 'ended'); assert.equal(ended.call.revision, 3);
  assert.deepEqual(await b.emitAck(C.end, { callId: created.call.callId }), ended);
  assert.equal(server.handle.getStats().activeCalls, 0);
  for (const device of [a, a2, b, b2]) await device.waitFor(S.state, call => call.status === 'ended');
  assert.equal((await initiate(a, 'new-request')).status, 'ok');
});

test('payloads cannot supply caller identity, call IDs, names, timestamps or arbitrary signaling', async () => {
  const { a, b } = await setup();
  for (const extra of [{ callerId: 'carol' }, { callerName: 'Mallory' }, { callId: 'chosen-id' }, { timestamp: '2026-01-01' }, { kind: 'screen' }]) {
    assert.deepEqual(await initiate(a, 'invalid', extra), { status: 'error', code: 'invalid_payload' });
  }
  await b.expectNone(S.state, () => true, { ms: 10 });
  assert.equal(server.handle.getStats().retainedCalls, 0);
  assert.equal((await initiate(a)).call.caller.userId, 'alice');
});

test('only the intended recipient accepts/declines and only the caller cancels; third parties cannot inspect or control a call', async () => {
  const { a, b, carol } = await setup(); const c = await server.connect(carol);
  const { call } = await initiate(a);
  for (const event of [C.accept, C.decline]) assert.deepEqual(await a.emitAck(event, { callId: call.callId }), { status: 'error', code: 'call_not_allowed' });
  assert.deepEqual(await b.emitAck(C.cancel, { callId: call.callId }), { status: 'error', code: 'call_not_allowed' });
  assert.deepEqual(await c.emitAck(C.end, { callId: call.callId }), { status: 'error', code: 'call_not_found' });
  assert.deepEqual(await c.emitAck(C.sync, {}), { status: 'ok', calls: [] });
  assert.deepEqual(await a.emitAck(C.end, { callId: call.callId }), { status: 'error', code: 'invalid_call_state' });
  const declined = await b.emitAck(C.decline, { callId: call.callId });
  assert.equal(declined.call.status, 'declined');
  assert.deepEqual(await b.emitAck(C.decline, { callId: call.callId }), declined);
  assert.deepEqual(await b.emitAck(C.accept, { callId: call.callId }), { status: 'error', code: 'invalid_call_state' });
  assert.equal(server.handle.getStats().activeCalls, 0);
});

test('outgoing cancel is idempotent, synchronizes both parties and cannot revive a terminal call', async () => {
  const { a, b } = await setup(); const { call } = await initiate(a);
  const cancelled = await a.emitAck(C.cancel, { callId: call.callId });
  assert.equal(cancelled.call.status, 'cancelled'); assert.equal(cancelled.call.revision, 2);
  await b.waitFor(S.state, value => value.status === 'cancelled');
  assert.deepEqual(await a.emitAck(C.cancel, { callId: call.callId }), cancelled);
  assert.deepEqual(await b.emitAck(C.accept, { callId: call.callId }), { status: 'error', code: 'invalid_call_state' });
});

test('unanswered ringing becomes missed on the server and retained state is available for synchronization', async () => {
  const { a, b } = await setup({ ringTimeoutMs: 80 }); const { call } = await initiate(a);
  const missed = await b.waitFor(S.state, value => value.status === 'missed');
  assert.equal(missed.callId, call.callId); assert.equal(missed.reason, 'unanswered'); assert.equal(missed.acceptedAt, null);
  assert.deepEqual((await a.emitAck(C.sync, {})).calls, [missed]);
  assert.equal(server.handle.getStats().activeCalls, 0);
});

test('accepting cancels the ringing deadline; accepted state remains separate from media connection', async () => {
  const { a, b } = await setup({ ringTimeoutMs: 120, maxAcceptedMs: 2000 }); const { call } = await initiate(a);
  await b.emitAck(C.accept, { callId: call.callId }); await delay(150);
  assert.equal((await a.emitAck(C.sync, {})).calls[0].status, 'accepted');
  await b.expectNone(S.state, value => value.status === 'missed', { ms: 0 });
});

test('accepted duration bound and terminal TTL release timers, call indexes and idempotency keys', async () => {
  const { a, b } = await setup({ maxAcceptedMs: 80, terminalTtlMs: 80, maxCalls: 1 }); const { call } = await initiate(a);
  await b.emitAck(C.accept, { callId: call.callId });
  await a.waitFor(S.state, value => value.reason === 'duration_limit');
  await eventually(() => server.handle.getStats().retainedCalls === 0);
  assert.deepEqual((await a.emitAck(C.sync, {})).calls, []);
  const restarted = await initiate(a);
  assert.equal(restarted.status, 'ok'); assert.notEqual(restarted.call.callId, call.callId);
});

test('initiate retries across devices return one call and conflicting reuse of request IDs fails', async () => {
  const { a, b, alice } = await setup(); const a2 = await server.connect(alice);
  const [one, two] = await Promise.all([initiate(a), initiate(a2)]);
  assert.equal(one.status, 'ok'); assert.deepEqual(one, two);
  assert.equal(server.handle.getStats().activeCalls, 1);
  await b.waitFor(S.state, (event: any) => event.callId === one.call.callId);
  assert.equal(b.events(S.state).filter((event: any) => event.status === 'ringing').length, 1);
  assert.deepEqual(await initiate(a, 'request-1', { kind: 'video' }), { status: 'error', code: 'idempotency_conflict' });
  const ended = await a.emitAck(C.cancel, { callId: one.call.callId });
  assert.deepEqual(await initiate(a2), ended);
});

test('simultaneous cross-calls and a third caller cannot put either user in two calls', async () => {
  const { a, b, carol } = await setup(); const c = await server.connect(carol);
  const results = await Promise.all([initiate(a), initiate(b, 'opposite', { recipientId: 'alice' })]);
  assert.equal(results.filter(result => result.status === 'ok').length, 1);
  assert.equal(results.find(result => result.status === 'error').code, 'call_busy');
  assert.equal(server.handle.getStats().activeCalls, 1);
  assert.deepEqual(await initiate(c, 'third', { conversationId: 'dm-bc' }), { status: 'error', code: 'call_busy' });
  assert.deepEqual(await initiate(a, 'also', { conversationId: 'dm-ac', recipientId: 'carol' }), { status: 'error', code: 'call_busy' });
});

test('an accept/cancel race commits one authoritative transition and all endpoints see the same revision', async () => {
  const { a, b } = await setup(); const { call } = await initiate(a);
  const replies = await Promise.all([b.emitAck(C.accept, { callId: call.callId }), a.emitAck(C.cancel, { callId: call.callId })]);
  assert.equal(replies.filter(reply => reply.status === 'ok').length, 1);
  assert.equal(replies.find(reply => reply.status === 'error').code, 'invalid_call_state');
  const [caller, recipient] = await Promise.all([a.emitAck(C.sync, {}), b.emitAck(C.sync, {})]);
  assert.deepEqual(caller, recipient); assert.equal(caller.calls[0].revision, 2);
});

test('self calls, offline recipients, non-direct conversations and mismatched directory members are rejected', async () => {
  const { a } = await setup();
  assert.deepEqual(await initiate(a, 'self', { recipientId: 'alice' }), { status: 'error', code: 'call_not_allowed' });
  assert.deepEqual(await initiate(a, 'offline', { conversationId: 'dm-ac', recipientId: 'carol' }), { status: 'error', code: 'recipient_unavailable' });
  resolver.entries.set('group', { conversationId: 'group', type: 'group', participants: [{ userId: 'alice', displayName: 'A' }, { userId: 'bob', displayName: 'B' }] });
  assert.deepEqual(await initiate(a, 'group', { conversationId: 'group' }), { status: 'error', code: 'call_not_allowed' });
  resolver.add('dm-ab', 'alice', 'carol');
  assert.deepEqual(await initiate(a, 'mismatch'), { status: 'error', code: 'call_not_allowed' });
});

test('missing call or identity integrations stay disabled', async () => {
  server = await startTestServer(); const user = server.addUser('alice'); server.authorizer.grant('alice', 'dm-ab'); const a = await server.connect(user);
  assert.equal(server.handle.getStats().callSignaling, 'disabled');
  assert.deepEqual(await initiate(a), { status: 'error', code: 'unavailable' });
  await server.close(); server = await startTestServer({ withSessionResolver: false, directCalls: { conversationResolver: new TestDirectCallResolver() } });
  assert.equal(server.handle.getStats().callSignaling, 'disabled');
  assert.equal((await server.connectError(null)).code, 'REALTIME_UNAVAILABLE');
});

test('directory failures and malformed records never create a call or return private error details', async () => {
  const { a, b } = await setup({}, { timing: { adapterTimeoutMs: 30 } });
  for (const mode of ['throw', 'hang'] as const) {
    resolver.mode = mode; assert.deepEqual(await initiate(a, mode), { status: 'error', code: 'unavailable' });
  }
  resolver.mode = 'normal'; resolver.entries.set('dm-ab', { conversationId: 'dm-ab', type: 'direct', participants: [{ userId: 'alice' }, { userId: 'bob' }] });
  assert.equal((await initiate(a, 'malformed')).status, 'error');
  await b.expectNone(S.state, () => true, { ms: 10 });
  assert.equal(server.logger.text().includes('do-not-return'), false); assert.equal(server.handle.getStats().retainedCalls, 0);
});

test('fresh memberships and block decisions are required, and revocation clears an existing call without new peer metadata', async () => {
  const { a, b } = await setup(); const { call } = await initiate(a);
  server.authorizer.block('alice', 'bob'); await server.handle.refreshUserAccess('alice');
  const cleared = { callId: call.callId, revision: 2, status: 'ended', reason: 'access_revoked' };
  assert.deepEqual(await a.waitFor(S.cleared), cleared); assert.deepEqual(await b.waitFor(S.cleared), cleared);
  assert.equal(server.handle.getStats().activeCalls, 0);
  assert.deepEqual((await a.emitAck(C.sync, {})).calls, []);
  assert.deepEqual(await initiate(a, 'blocked'), { status: 'error', code: 'call_not_allowed' });
  server.authorizer.unblock('alice', 'bob'); await server.handle.refreshUserAccess('alice'); await server.handle.refreshUserAccess('bob');
  const next = await initiate(a, 'next'); assert.equal(next.status, 'ok');
  server.handle.revokeConversationAccess('bob', 'dm-ab');
  assert.equal((await a.waitFor(S.cleared, value => value.callId === next.call.callId)).status, 'ended');
  assert.equal(server.handle.getStats().activeCalls, 0);
});

test('authorization refresh failure does not fall back to cached grants', async () => {
  const { a, b } = await setup(); server.authorizer.blocksMode = 'throw';
  assert.deepEqual(await initiate(a), { status: 'error', code: 'unavailable' });
  await b.expectNone(S.state, () => true, { ms: 10 }); assert.equal(server.handle.getStats().activeCalls, 0);
});

test('losing one device preserves the call; losing a user’s last device ends it and a reconnect can synchronize terminal state', async () => {
  const { a, b, alice, bob } = await setup(); const a2 = await server.connect(alice); const { call } = await initiate(a);
  a.close(); await eventually(() => server.handle.getStats().connections === 2);
  assert.equal(server.handle.getStats().activeCalls, 1);
  await b.emitAck(C.accept, { callId: call.callId }); b.close();
  const ended = await a2.waitFor(S.state, value => value.status === 'ended'); assert.equal(ended.reason, 'disconnected');
  const reconnected = await server.connect(bob);
  assert.deepEqual((await reconnected.emitAck(C.sync, {})).calls, [ended]);
});

test('ringing recipient disconnect is missed, and caller session revocation cancels ringing', async () => {
  const { a, b, alice, bob } = await setup(); await initiate(a); b.close();
  assert.equal((await a.waitFor(S.state, value => value.status === 'missed')).reason, 'disconnected');
  const b2 = await server.connect(bob); const second = await initiate(a, 'second');
  server.handle.revokeSession(alice.sessionId);
  const cancelled = await b2.waitFor(S.state, value => value.callId === second.call.callId && value.status === 'cancelled');
  assert.equal(cancelled.reason, 'disconnected'); assert.equal(server.handle.getStats().activeCalls, 0);
});

test('a late directory response after caller disconnect cannot create or deliver a call', async () => {
  const { a, b } = await setup(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  resolver.beforeResolve = () => held;
  a.emit(C.initiate, { requestId: 'late', conversationId: 'dm-ab', recipientId: 'bob', kind: 'voice' }, () => {});
  await eventually(() => resolver.actors.length === 1); a.close(); await eventually(() => server.handle.getStats().connections === 1);
  release(); await b.expectNone(S.state, () => true, { ms: 40 }); assert.equal(server.handle.getStats().retainedCalls, 0);
});

test('acceptance that finishes after the ringing deadline cannot revive a missed call', async () => {
  const { a, b } = await setup({ ringTimeoutMs: 100 }); const { call } = await initiate(a);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); resolver.beforeResolve = () => held;
  const pending = b.emitAck(C.accept, { callId: call.callId }); await a.waitFor(S.state, value => value.status === 'missed');
  release(); assert.deepEqual(await pending, { status: 'error', code: 'invalid_call_state' });
  assert.equal(server.handle.getStats().activeCalls, 0);
});

test('existing security event policy applies to call events without exposing call bodies', async () => {
  const contexts: unknown[] = [];
  const { a, b } = await setup({}, { securityPolicy: { async evaluateEvent(context) { contexts.push(context); return { action: 'deny', reason: 'test.denied' }; } } });
  assert.deepEqual(await initiate(a), { status: 'error', code: 'policy_denied' });
  await b.expectNone(S.state, () => true, { ms: 10 });
  assert.equal((contexts[0] as { event: string }).event, C.initiate);
  assert.equal('body' in (contexts[0] as object), false); assert.equal(server.handle.getStats().retainedCalls, 0);
});

test('call events share existing rate and invalid-payload limits, with bounded retained storage', async () => {
  const { a } = await setup({ maxCalls: 1 }, { rates: { send: { capacity: 4, refillPerSecond: 0 } } });
  const created = await initiate(a); assert.equal(created.status, 'ok');
  await a.emitAck(C.cancel, { callId: created.call.callId });
  assert.deepEqual(await initiate(a, 'capacity'), { status: 'error', code: 'unavailable' });
  assert.deepEqual(await a.emitAck(C.sync, { callerId: 'bob' }), { status: 'error', code: 'invalid_payload' });
  assert.deepEqual(await a.emitAck(C.sync, {}), { status: 'error', code: 'rate_limited' });
  assert.equal(server.handle.getStats().retainedCalls, 1);
});

test('shutdown clears active calls and timers', async () => {
  const { a, b } = await setup(); await initiate(a);
  await server.handle.close();
  assert.equal(server.handle.getStats().activeCalls, 0); assert.equal(server.handle.getStats().retainedCalls, 0);
  await eventually(() => !a.connected && !b.connected);
  assert.equal(a.connected, false); assert.equal(b.connected, false);
});
