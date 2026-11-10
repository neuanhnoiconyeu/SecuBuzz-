import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import {
  delay,
  eventually,
  startTestServer,
  TEST_CIPHERTEXT,
  TEST_IV,
  testEnvelope,
  type HarnessOptions,
  type TestServer,
  type TestUser,
} from '../support/harness.ts';

let server: TestServer;

async function setup(options: HarnessOptions = {}) {
  server = await startTestServer(options);
  const alice = server.addUser('alice', { displayName: 'Alice' });
  const bob = server.addUser('bob', { displayName: 'Bob' });
  const carol = server.addUser('carol', { displayName: 'Carol' });
  server.authorizer.grant('alice', 'dm-ab', 'group-1');
  server.authorizer.grant('bob', 'dm-ab', 'group-1');
  server.authorizer.grant('carol', 'group-1');
  return { alice, bob, carol };
}

const send = (user: TestUser, conversationId: string, id: string, overrides: Record<string, unknown> = {}) =>
  testEnvelope(user, conversationId, id, overrides);
const enabled: HarnessOptions = { withStore: true, withVerifier: true };

describe('message send boundary in the production configuration (no store, no verifier)', () => {
  afterEach(async () => {
    await server.close();
  });

  test('rejects every valid send with recipient_keys_unavailable and persists or emits nothing', async () => {
    const { alice, bob } = await setup();
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1')), { status: 'error', code: 'recipient_keys_unavailable' });
    await b.expectNone(SERVER_EVENTS.messageNew);
    assert.equal(server.store.storeCalls, 0);
    assert.equal(server.handle.getStats().messageDelivery, 'disabled');
  });

  test('rejects plaintext, demo-only and browser-demo envelopes before anything else', async () => {
    const { alice } = await setup();
    const a = await server.connect(alice);
    const base = send(alice, 'dm-ab', 'm1');
    const plaintextOnly = { ...base, content: 'hello' };
    delete (plaintextOnly as Record<string, unknown>).encryption;
    for (const body of [
      { ...base, content: 'hello in the clear' },
      plaintextOnly,
      { ...base, demoOnly: true },
      { ...base, encryption: { ...(base.encryption as object), scope: 'browser-demo' } },
      { ...base, deliveryStatus: 'sent' },
    ]) {
      assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, body), { status: 'error', code: 'invalid_payload' });
    }
  });

  test('rejects malformed encrypted envelopes', async () => {
    const { alice } = await setup({ rates: { send: { capacity: 50, refillPerSecond: 0 }, invalid: { capacity: 50, refillPerSecond: 0 } } });
    const a = await server.connect(alice);
    const encryption = (changes: Record<string, unknown>) => ({ encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: TEST_IV, ciphertext: TEST_CIPHERTEXT, ...changes } });
    for (const overrides of [
      encryption({ version: 2 }), encryption({ algorithm: 'AES-128-CBC' }), encryption({ encoding: 'hex' }),
      encryption({ iv: Buffer.alloc(16).toString('base64') }), encryption({ iv: 'not-base64' }),
      encryption({ ciphertext: Buffer.alloc(16).toString('base64') }), encryption({ ciphertext: `${TEST_CIPHERTEXT} ` }),
      encryption({ ciphertext: Buffer.alloc(60_000).toString('base64') }),
      { type: 'voice' }, { timestamp: '2026-11-09 10:00:00' }, { id: 'has space' }, { senderName: '' },
    ]) {
      assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1', overrides)),
        { status: 'error', code: 'invalid_payload' }, JSON.stringify(overrides).slice(0, 80));
    }
  });

  test('rejects sender identity that differs from the session', async () => {
    const { alice } = await setup();
    const a = await server.connect(alice);
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1', { senderId: 'bob' })), { status: 'error', code: 'actor_mismatch' });
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1', { senderName: 'Administrator' })), { status: 'error', code: 'actor_mismatch' });
  });

  test('rejects unauthorized conversations and skewed timestamps', async () => {
    const { carol } = await setup();
    const c = await server.connect(carol);
    assert.deepEqual(await c.emitAck(CLIENT_EVENTS.messageSend, send(carol, 'dm-ab', 'm1')), { status: 'error', code: 'unauthorized_conversation' });
    const old = new Date(Date.now() - 3_600_000).toISOString();
    assert.deepEqual(await c.emitAck(CLIENT_EVENTS.messageSend, send(carol, 'group-1', 'm1', { timestamp: old })), { status: 'error', code: 'invalid_payload' });
  });

  test('a verifier without a message store still cannot enable delivery', async () => {
    const { alice, bob } = await setup({ withVerifier: true });
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1')), { status: 'error', code: 'recipient_keys_unavailable' });
    assert.equal(server.verifier.calls, 0);
    await b.expectNone(SERVER_EVENTS.messageNew);
  });

  test('a message store without a verifier keeps delivery disabled (no plaintext or structural-only E2EE)', async () => {
    const { alice, bob } = await setup({ withStore: true });
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1')), { status: 'error', code: 'recipient_keys_unavailable' });
    assert.equal(server.store.storeCalls, 0);
    await b.expectNone(SERVER_EVENTS.messageNew);
  });

  test('rate limits sends', async () => {
    const { alice } = await setup({ rates: { send: { capacity: 1, refillPerSecond: 0 } } });
    const a = await server.connect(alice);
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1'));
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm2')), { status: 'error', code: 'rate_limited' });
  });
});

describe('message send pipeline with test-only store and verifier', () => {
  afterEach(async () => {
    await server.close();
  });

  test('stores first, acknowledges with the stored time, then emits message:new to other members only', async () => {
    const { alice, bob } = await setup(enabled);
    const a = await server.connect(alice);
    const aOther = await server.connect(alice);
    const b = await server.connect(bob);
    const envelope = send(alice, 'dm-ab', 'm1');
    const ack = await a.emitAck(CLIENT_EVENTS.messageSend, envelope);
    assert.deepEqual(Object.keys(ack).sort(), ['conversationId', 'messageId', 'status', 'timestamp']);
    assert.equal(ack.conversationId, 'dm-ab');
    assert.equal(ack.messageId, 'm1');
    assert.equal(ack.status, 'sent');
    const incoming = await b.waitFor(SERVER_EVENTS.messageNew);
    assert.deepEqual(incoming, { ...envelope, deliveryStatus: 'sent' });
    assert.deepEqual(await aOther.waitFor(SERVER_EVENTS.messageNew), { ...envelope, deliveryStatus: 'sent' });
    await a.expectNone(SERVER_EVENTS.messageNew);
    assert.equal(server.store.messageCount, 1);
    assert.equal(server.verifier.calls, 1);
    await b.expectNone(SERVER_EVENTS.messageAck, () => true, { ms: 0 });
    await a.expectNone(SERVER_EVENTS.messageAck, () => true, { ms: 0 });
  });

  test('a duplicate with the same payload returns the original acknowledgement and is not re-broadcast', async () => {
    const { alice, bob } = await setup(enabled);
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const envelope = send(alice, 'dm-ab', 'm1');
    const first = await a.emitAck(CLIENT_EVENTS.messageSend, envelope);
    await b.waitFor(SERVER_EVENTS.messageNew);
    await delay(5);
    const second = await a.emitAck(CLIENT_EVENTS.messageSend, envelope);
    assert.deepEqual(second, first);
    assert.equal(server.store.messageCount, 1);
    await b.expectNone(SERVER_EVENTS.messageNew, () => true, { since: 1 });
  });

  test('rejects reuse of a message ID with a changed payload', async () => {
    const { alice, bob } = await setup(enabled);
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1'));
    await b.waitFor(SERVER_EVENTS.messageNew);
    const changed = send(alice, 'dm-ab', 'm1', { encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: TEST_IV, ciphertext: Buffer.alloc(48, 9).toString('base64') } });
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, changed), { status: 'error', code: 'idempotency_conflict' });
    await b.expectNone(SERVER_EVENTS.messageNew, () => true, { since: 1 });
  });

  test('another sender cannot reuse an existing message ID in the same conversation', async () => {
    const { alice, bob } = await setup(enabled);
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'group-1', 'shared-id'));
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageSend, send(bob, 'group-1', 'shared-id')), { status: 'error', code: 'idempotency_conflict' });
  });

  test('coalesces concurrent identical sends into one store call and rejects a concurrent changed payload', async () => {
    const { alice, bob } = await setup(enabled);
    server.store.storeDelayMs = 100;
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const envelope = send(alice, 'dm-ab', 'm1');
    const changed = { ...envelope, encryption: { ...(envelope.encryption as object), ciphertext: Buffer.alloc(48, 1).toString('base64') } };
    const [first, second, conflict] = await Promise.all([
      a.emitAck(CLIENT_EVENTS.messageSend, envelope),
      a.emitAck(CLIENT_EVENTS.messageSend, envelope),
      delay(20).then(() => a.emitAck(CLIENT_EVENTS.messageSend, changed)),
    ]);
    assert.equal(first.status, 'sent');
    assert.deepEqual(second, first);
    assert.deepEqual(conflict, { status: 'error', code: 'idempotency_conflict' });
    assert.equal(server.store.storeCalls, 1);
    await b.waitFor(SERVER_EVENTS.messageNew);
    await delay(50);
    assert.equal(b.events(SERVER_EVENTS.messageNew).length, 1);
    assert.equal(server.handle.getStats().inFlightSends, 0);
  });

  test('an unverified envelope is refused and a failing verifier fails closed', async () => {
    const { alice, bob } = await setup(enabled);
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    server.verifier.verified = false;
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1')), { status: 'error', code: 'recipient_keys_unavailable' });
    server.verifier.verified = true;
    server.verifier.mode = 'malformed';
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm2')), { status: 'error', code: 'recipient_keys_unavailable' });
    server.verifier.mode = 'throw';
    assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm3')), { status: 'error', code: 'unavailable' });
    assert.equal(server.store.storeCalls, 0);
    await b.expectNone(SERVER_EVENTS.messageNew);
  });

  test('store failures are reported as unavailable and nothing is broadcast; a retry is idempotent', async () => {
    const { alice, bob } = await setup(enabled);
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const envelope = send(alice, 'dm-ab', 'm1');
    for (const mode of ['throw', 'malformed', 'hang'] as const) {
      server.store.storeMode = mode;
      assert.deepEqual(await a.emitAck(CLIENT_EVENTS.messageSend, envelope), { status: 'error', code: 'unavailable' }, mode);
    }
    await b.expectNone(SERVER_EVENTS.messageNew);
    server.store.storeMode = 'normal';
    assert.equal((await a.emitAck(CLIENT_EVENTS.messageSend, envelope)).status, 'sent');
    assert.ok(!server.logger.text().includes(TEST_CIPHERTEXT), 'ciphertext is never logged');
  });

  test('blocked recipients do not receive messages', async () => {
    const { alice, bob, carol } = await setup(enabled);
    server.authorizer.block('carol', 'alice');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const c = await server.connect(carol);
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'group-1', 'g1'));
    await b.waitFor(SERVER_EVENTS.messageNew);
    await c.expectNone(SERVER_EVENTS.messageNew);
  });
});

describe('delivery receipts', () => {
  afterEach(async () => {
    await server.close();
  });

  test('emits message:delivered only after the recipient confirms and the store records it', async () => {
    const { alice, bob } = await setup(enabled);
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1'));
    const entry = await b.waitForEntry(SERVER_EVENTS.messageNew);
    await a.expectNone(SERVER_EVENTS.messageDelivered, () => true, { ms: 80 });
    const confirm = entry.args[1] as (response: unknown) => void;
    assert.equal(typeof confirm, 'function', 'message:new carries a delivery callback');
    confirm({ conversationId: 'dm-ab', messageId: 'm1', status: 'delivered' });
    const receipt = await a.waitFor(SERVER_EVENTS.messageDelivered);
    assert.deepEqual(Object.keys(receipt).sort(), ['conversationId', 'messageId', 'status', 'timestamp', 'userId']);
    assert.equal(receipt.userId, 'bob');
    assert.equal(receipt.status, 'delivered');
    assert.ok(server.store.hasReceipt('dm-ab', 'm1', 'bob', 'delivered'));
  });

  test('never claims delivery when the recipient does not confirm or confirms with the wrong body', async () => {
    const { alice, bob } = await setup({ ...enabled, timing: { deliveryAckTimeoutMs: 100 } });
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1'));
    await b.waitFor(SERVER_EVENTS.messageNew);
    await a.expectNone(SERVER_EVENTS.messageDelivered, () => true, { ms: 250 });
    await eventually(() => server.handle.getStats().pendingDeliveryAcks === 0, 1_000, 'delivery ack timeout');

    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm2'));
    const entry = await b.waitForEntry(SERVER_EVENTS.messageNew, (payload) => payload.id === 'm2');
    (entry.args[1] as (response: unknown) => void)({ conversationId: 'dm-ab', messageId: 'm1', status: 'delivered', userId: 'carol' });
    await a.expectNone(SERVER_EVENTS.messageDelivered, () => true, { ms: 150 });
    assert.equal(server.store.hasReceipt('dm-ab', 'm2', 'bob', 'delivered'), false);
  });

  test('group delivery receipts are per recipient and a second device does not duplicate them', async () => {
    const { alice, bob, carol } = await setup(enabled);
    const a = await server.connect(alice);
    const b1 = await server.connect(bob);
    const b2 = await server.connect(bob);
    const c = await server.connect(carol);
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'group-1', 'g1'));
    for (const recipient of [b1, b2, c]) {
      const entry = await recipient.waitForEntry(SERVER_EVENTS.messageNew);
      (entry.args[1] as (response: unknown) => void)({ conversationId: 'group-1', messageId: 'g1', status: 'delivered' });
    }
    await eventually(() => a.events(SERVER_EVENTS.messageDelivered).length >= 2, 1_000, 'two receipts');
    await delay(100);
    const observers = a.events(SERVER_EVENTS.messageDelivered).map((payload) => (payload as { userId: string }).userId).sort();
    assert.deepEqual(observers, ['bob', 'carol']);
  });

  test('bounds pending delivery acknowledgements per connection', async () => {
    const { alice, bob } = await setup({ ...enabled, limits: { maxPendingDeliveryAcksPerConnection: 1 } });
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm1'));
    await a.emitAck(CLIENT_EVENTS.messageSend, send(alice, 'dm-ab', 'm2'));
    const first = await b.waitForEntry(SERVER_EVENTS.messageNew, (payload) => payload.id === 'm1');
    const second = await b.waitForEntry(SERVER_EVENTS.messageNew, (payload) => payload.id === 'm2');
    assert.equal(typeof first.args[1], 'function');
    assert.equal(second.args.length, 1, 'over the bound, message:new is sent without a delivery callback');
  });
});
