import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { ConnectionSecurityContext, EventSecurityContext, RealtimeSecurityPolicy, SecurityDecision } from '../../src/realtime/contracts.ts';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import { delay, startTestServer, TEST_CIPHERTEXT, TEST_IV, testEnvelope, type TestServer } from '../support/harness.ts';

let server: TestServer;

/** Test-only stand-in for a future Phase 10 policy. It makes no AI calls. */
class ScriptedPolicy implements RealtimeSecurityPolicy {
  connections: ConnectionSecurityContext[] = [];
  events: EventSecurityContext[] = [];
  connectionDecision: SecurityDecision | 'throw' | 'hang' = { action: 'allow' };
  eventDecision: (context: EventSecurityContext) => SecurityDecision | 'throw' | Promise<SecurityDecision> = () => ({ action: 'allow' });

  async evaluateConnection(context: ConnectionSecurityContext): Promise<SecurityDecision> {
    this.connections.push(context);
    if (this.connectionDecision === 'throw') throw new Error('policy exploded');
    if (this.connectionDecision === 'hang') return new Promise(() => undefined);
    return this.connectionDecision;
  }

  async evaluateEvent(context: EventSecurityContext): Promise<SecurityDecision> {
    this.events.push(context);
    const decision = await this.eventDecision(context);
    if (decision === 'throw') throw new Error('policy exploded');
    return decision;
  }
}

async function setup(policy: ScriptedPolicy) {
  server = await startTestServer({ securityPolicy: policy, withStore: true, withVerifier: true });
  const alice = server.addUser('alice', { displayName: 'Alice' });
  const bob = server.addUser('bob');
  for (const user of ['alice', 'bob']) server.authorizer.grant(user, 'dm-ab');
  server.authorizer.befriend('alice', 'bob');
  server.store.seed('dm-ab', 'm1', 'alice');
  return { alice, bob };
}

describe('security policy extension point', () => {
  afterEach(async () => {
    await server.close();
  });

  test('a denied handshake is rejected with POLICY_DENIED and the audit reason stays server-side', async () => {
    const policy = new ScriptedPolicy();
    const { alice } = await setup(policy);
    policy.connectionDecision = { action: 'deny', reason: 'sentinel.geo_anomaly' };
    const error = await server.connectError(alice);
    assert.deepEqual(error.data, { code: 'POLICY_DENIED' });
    assert.equal(error.message, 'Connection denied.');
    assert.ok(server.logger.text().includes('policy_sentinel.geo_anomaly'));
    assert.deepEqual(Object.keys(policy.connections[0]!).sort(), ['actor', 'origin', 'remoteAddress', 'userAgent']);
    assert.equal(policy.connections[0]!.actor.userId, 'alice');
  });

  test('a throwing or hanging connection policy fails closed', async () => {
    const policy = new ScriptedPolicy();
    const { alice } = await setup(policy);
    for (const decision of ['throw', 'hang'] as const) {
      policy.connectionDecision = decision;
      assert.equal((await server.connectError(alice)).code, 'REALTIME_UNAVAILABLE', decision);
    }
  });

  test('denied or failing event evaluations stop the event', async () => {
    const policy = new ScriptedPolicy();
    const { alice, bob } = await setup(policy);
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    policy.eventDecision = () => ({ action: 'deny', reason: 'auditor.blocked' });
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, { conversationId: 'dm-ab', messageId: 'm1' }), { status: 'error', code: 'policy_denied' });
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(alice, 'dm-ab', 'n1')), { status: 'error', code: 'policy_denied' });
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.expectNone(SERVER_EVENTS.typingUpdate);
    await b.expectNone(SERVER_EVENTS.presenceUpdate, () => true, { ms: 0 });
    policy.eventDecision = () => 'throw';
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, { conversationId: 'dm-ab', messageId: 'm1' }), { status: 'error', code: 'unavailable' });
    assert.equal(server.store.receiptCalls.length, 0);
    assert.equal(server.store.storeCalls, 0);
    await a.expectNone(SERVER_EVENTS.messageRead);
  });

  test('event contexts carry metadata only, never ciphertext or IVs', async () => {
    const policy = new ScriptedPolicy();
    const { alice } = await setup(policy);
    const a = await server.connect(alice);
    assert.equal((await a.emitAck(CLIENT_EVENTS.messageSend, testEnvelope(alice, 'dm-ab', 'n1'))).status, 'sent');
    const context = policy.events.find((entry) => entry.event === CLIENT_EVENTS.messageSend)!;
    assert.deepEqual(Object.keys(context).sort(), ['actor', 'conversationId', 'event', 'messageId', 'payloadBytes', 'subjectCount']);
    assert.equal(context.conversationId, 'dm-ab');
    assert.equal(context.messageId, 'n1');
    assert.ok(context.payloadBytes > TEST_CIPHERTEXT.length);
    const serialized = JSON.stringify(policy.events);
    assert.ok(!serialized.includes(TEST_CIPHERTEXT) && !serialized.includes(TEST_IV));
  });

  test('the latest presence:subscribe wins even when an earlier policy decision is slower', async () => {
    const policy = new ScriptedPolicy();
    const { alice, bob } = await setup(policy);
    const carol = server.addUser('carol');
    server.authorizer.befriend('bob', 'carol');
    await server.connect(alice);
    await server.connect(carol);
    const b = await server.connect(bob);
    policy.eventDecision = async (context) => {
      await delay(context.subjectCount === 1 && policy.events.length === 1 ? 80 : 5);
      return { action: 'allow' };
    };
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['carol'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, (payload) => payload.userId === 'carol');
    const mark = b.mark();
    server.handle.setPresencePreference('alice', 'away');
    server.handle.setPresencePreference('carol', 'busy');
    await b.waitFor(SERVER_EVENTS.presenceUpdate, (payload) => payload.userId === 'carol' && payload.status === 'busy', { since: mark });
    await b.expectNone(SERVER_EVENTS.presenceUpdate, (payload) => payload.userId === 'alice', { since: mark });
    assert.equal(server.handle.getStats().presenceSubscriptions, 1);
  });

  test('typing start/stop keep their order while an asynchronous policy decides', async () => {
    const policy = new ScriptedPolicy();
    const { alice, bob } = await setup(policy);
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    policy.eventDecision = async (context) => {
      await delay(context.event === CLIENT_EVENTS.typingStart ? 80 : 5);
      return { action: 'allow' };
    };
    a.emit(CLIENT_EVENTS.typingStart, { conversationId: 'dm-ab' });
    a.emit(CLIENT_EVENTS.typingStop, { conversationId: 'dm-ab' });
    await b.waitFor(SERVER_EVENTS.typingUpdate, (payload) => payload.isTyping === false);
    assert.deepEqual(b.events(SERVER_EVENTS.typingUpdate).map((payload) => (payload as { isTyping: boolean }).isTyping), [true, false]);
  });
});
