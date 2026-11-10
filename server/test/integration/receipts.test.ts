import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import { delay, startTestServer, type HarnessOptions, type TestServer } from '../support/harness.ts';

let server: TestServer;

async function setup(options: HarnessOptions = { withStore: true }) {
  server = await startTestServer(options);
  const alice = server.addUser('alice');
  const bob = server.addUser('bob');
  const carol = server.addUser('carol');
  server.authorizer.grant('alice', 'dm-ab', 'group-1');
  server.authorizer.grant('bob', 'dm-ab', 'group-1');
  server.authorizer.grant('carol', 'group-1');
  server.store.seed('dm-ab', 'm1', 'alice');
  server.store.seed('group-1', 'g1', 'alice');
  server.store.seed('group-1', 'from-bob', 'bob');
  return { alice, bob, carol };
}

const read = (conversationId: string, messageId: string) => ({ conversationId, messageId });

describe('read receipts', () => {
  afterEach(async () => {
    await server.close();
  });

  test('acknowledges an authorized read and notifies the sender separately', async () => {
    const { alice, bob } = await setup();
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const ack = await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1'));
    assert.deepEqual(Object.keys(ack).sort(), ['conversationId', 'messageId', 'status', 'timestamp', 'userId']);
    assert.equal(ack.conversationId, 'dm-ab');
    assert.equal(ack.messageId, 'm1');
    assert.equal(ack.status, 'read');
    assert.equal(ack.userId, 'bob');
    const receipt = await a.waitFor(SERVER_EVENTS.messageRead);
    assert.deepEqual(receipt, { conversationId: 'dm-ab', messageId: 'm1', status: 'read', userId: 'bob', timestamp: ack.timestamp });
    assert.ok(server.store.hasReceipt('dm-ab', 'm1', 'bob', 'read'));
    await b.expectNone(SERVER_EVENTS.messageRead, () => true, { ms: 50 });
  });

  test('a duplicate read returns the original time and does not notify again', async () => {
    const { alice, bob } = await setup();
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const first = await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1'));
    await a.waitFor(SERVER_EVENTS.messageRead);
    await delay(5);
    const second = await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1'));
    assert.deepEqual(second, first);
    await a.expectNone(SERVER_EVENTS.messageRead, () => true, { since: 1 });
    assert.equal(a.events(SERVER_EVENTS.messageRead).length, 1);
  });

  test('rejects reads for conversations the reader is not authorized for without touching the store', async () => {
    const { carol } = await setup();
    const c = await server.connect(carol);
    assert.deepEqual(await c.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1')), { status: 'error', code: 'unauthorized_conversation' });
    assert.equal(server.store.receiptCalls.length, 0);
  });

  test('rejects a forged reader identity and always records the authenticated reader', async () => {
    const { alice, bob } = await setup();
    await server.connect(alice);
    const b = await server.connect(bob);
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, { ...read('dm-ab', 'm1'), userId: 'carol' }),
      { status: 'error', code: 'invalid_payload' });
    await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1'));
    assert.deepEqual(server.store.receiptCalls.map((receipt) => receipt.userId), ['bob']);
  });

  test('reports unknown messages, including IDs that exist only in another conversation, as message_not_found', async () => {
    const { bob } = await setup();
    const b = await server.connect(bob);
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'missing')), { status: 'error', code: 'message_not_found' });
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'g1')), { status: 'error', code: 'message_not_found' });
  });

  test('rejects reading one’s own message', async () => {
    const { bob } = await setup();
    const b = await server.connect(bob);
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, read('group-1', 'from-bob')), { status: 'error', code: 'invalid_payload' });
  });

  test('fails closed with unavailable when no message store is configured (production today)', async () => {
    const { alice, bob } = await setup({});
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1')), { status: 'error', code: 'unavailable' });
    await a.expectNone(SERVER_EVENTS.messageRead);
  });

  test('fails closed when the store throws, hangs or returns malformed data, and fabricates no receipt', async () => {
    const { alice, bob } = await setup();
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    for (const mode of ['throw', 'hang', 'malformed'] as const) {
      server.store.findMode = mode;
      assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1')), { status: 'error', code: 'unavailable' }, `find ${mode}`);
    }
    server.store.findMode = 'normal';
    for (const mode of ['throw', 'malformed'] as const) {
      server.store.receiptMode = mode;
      assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1')), { status: 'error', code: 'unavailable' }, `record ${mode}`);
    }
    await a.expectNone(SERVER_EVENTS.messageRead);
    assert.ok(!server.logger.text().includes('hunter2'));
  });

  test('answers within the deadline when the store hangs, before the client’s 5 s acknowledgement timeout', async () => {
    const { bob } = await setup({ withStore: true, timing: { adapterTimeoutMs: 1_000, handshakeTimeoutMs: 2_000 } });
    const b = await server.connect(bob);
    server.store.findMode = 'hang';
    const started = Date.now();
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1'), 5_000), { status: 'error', code: 'unavailable' });
    assert.ok(Date.now() - started < 1_800);
  });

  test('rate limits read requests and bounds pending acknowledgements', async () => {
    const { bob } = await setup({ withStore: true, rates: { read: { capacity: 2, refillPerSecond: 0 } } });
    const b = await server.connect(bob);
    await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1'));
    await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1'));
    assert.deepEqual(await b.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1')), { status: 'error', code: 'rate_limited' });
    await server.close();

    await setup({ withStore: true, limits: { maxPendingAcksPerConnection: 1 } });
    const slow = await server.connect(server.addUser('bob', { sessionId: 'bob-2' }));
    const original = server.store.findMessage.bind(server.store);
    server.store.findMessage = async (conversationId, messageId) => {
      await delay(100);
      return original(conversationId, messageId);
    };
    const [first, second] = await Promise.all([
      slow.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1')),
      delay(10).then(() => slow.emitAck(CLIENT_EVENTS.messageRead, read('dm-ab', 'm1'))),
    ]);
    assert.equal(first.status, 'read');
    assert.deepEqual(second, { status: 'error', code: 'rate_limited' });
  });

  test('group receipts are per reader and reach every connection of the sender', async () => {
    const { alice, bob, carol } = await setup();
    const a1 = await server.connect(alice);
    const a2 = await server.connect(alice);
    const b = await server.connect(bob);
    const c = await server.connect(carol);
    await b.emitAck(CLIENT_EVENTS.messageRead, read('group-1', 'g1'));
    await c.emitAck(CLIENT_EVENTS.messageRead, read('group-1', 'g1'));
    for (const sender of [a1, a2]) {
      await sender.waitFor(SERVER_EVENTS.messageRead, (payload) => payload.userId === 'carol');
      assert.deepEqual(sender.events(SERVER_EVENTS.messageRead).map((payload) => (payload as { userId: string }).userId).sort(), ['bob', 'carol']);
    }
    await c.expectNone(SERVER_EVENTS.messageRead, () => true, { ms: 0 });
  });

  test('a blocked reader’s receipt is recorded but not sent to the sender', async () => {
    const { alice, bob } = await setup();
    server.authorizer.block('alice', 'bob');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    assert.equal((await b.emitAck(CLIENT_EVENTS.messageRead, read('group-1', 'g1'))).status, 'read');
    await a.expectNone(SERVER_EVENTS.messageRead);
  });

  test('a sender who lost access to the conversation receives no receipt', async () => {
    const { alice, bob } = await setup();
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    server.handle.revokeConversationAccess('alice', 'group-1');
    assert.equal((await b.emitAck(CLIENT_EVENTS.messageRead, read('group-1', 'g1'))).status, 'read');
    await a.expectNone(SERVER_EVENTS.messageRead);
  });
});
