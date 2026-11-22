import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BUZZ_COOLDOWN_MS, BUZZ_RECEIVED_EVENT, BUZZ_SEND_EVENT } from '../../../shared/buzz.ts';
import { DataStack, delay } from './support/stack.ts';

describe('authenticated ephemeral Buzz (real DATA and Socket.IO)', () => {
  let stack: DataStack;
  before(async () => { stack = await DataStack.start(); });
  after(async () => { await stack?.close(); });
  test('authorized delivery has server identity, no history writes, and account-wide cooldown across tabs/reconnect', async () => {
    const { alice, bob, conversationId } = await stack.pair('buzz-a', 'buzz-b');
    const a = await stack.connect(alice), tab = await stack.connect(alice), b = await stack.connect(bob);
    const before = await stack.history(alice, conversationId);
    const results = await Promise.all([a.emitAck(BUZZ_SEND_EVENT, { conversationId }), tab.emitAck(BUZZ_SEND_EVENT, { conversationId })]);
    const sent = results.find(value => value.id);
    assert.ok(sent); assert.equal(results.filter(value => value.code === 'rate_limited').length, 1);
    assert.equal(sent.userId, alice.id); assert.equal(sent.displayName, alice.displayName);
    assert.deepEqual(Object.keys(sent).sort(), ['conversationId', 'displayName', 'id', 'timestamp', 'userId']);
    assert.deepEqual(await b.waitFor(BUZZ_RECEIVED_EVENT), sent);
    await a.expectNone(BUZZ_RECEIVED_EVENT); await tab.expectNone(BUZZ_RECEIVED_EVENT);
    a.close(); const reconnected = await stack.connect(alice);
    assert.equal((await reconnected.emitAck(BUZZ_SEND_EVENT, { conversationId })).code, 'rate_limited');
    const reply = await b.emitAck(BUZZ_SEND_EVENT, { conversationId }); assert.equal(reply.userId, bob.id);
    assert.deepEqual(await reconnected.waitFor(BUZZ_RECEIVED_EVENT), reply);
    await delay(BUZZ_COOLDOWN_MS + 30);
    assert.ok((await reconnected.emitAck(BUZZ_SEND_EVENT, { conversationId })).id);
    assert.deepEqual(await stack.history(alice, conversationId), before);
  });
  test('rejects identity/recipient claims, unrelated conversations, missing cookie and missing CSRF', async () => {
    const { alice, bob, conversationId } = await stack.pair('buzz-c', 'buzz-d');
    const outsider = await stack.person('buzz-outsider');
    const a = await stack.connect(alice), b = await stack.connect(bob), outside = await stack.connect(outsider);
    for (const body of [null, {}, { conversationId, userId: bob.id }, { conversationId, recipientId: bob.id }, { conversationId, content: 'not a message' }]) {
      assert.equal((await a.emitAck(BUZZ_SEND_EVENT, body)).code, 'invalid_payload');
    }
    assert.equal((await outside.emitAck(BUZZ_SEND_EVENT, { conversationId })).code, 'unauthorized_conversation');
    assert.equal((await a.emitAck(BUZZ_SEND_EVENT, { conversationId: 'not-a-conversation' })).code, 'unauthorized_conversation');
    assert.equal((await stack.connectError(alice, { cookie: null })).code, 'AUTH_REQUIRED');
    assert.equal((await stack.connectError(alice, { auth: null })).code, 'UNAUTHORIZED');
    await b.expectNone(BUZZ_RECEIVED_EVENT);
  });
  test('offline contacts fail without queuing a Buzz for later delivery', async () => {
    const { alice, bob, conversationId } = await stack.pair('buzz-off-a', 'buzz-off-b');
    const a = await stack.connect(alice);
    assert.equal((await a.emitAck(BUZZ_SEND_EVENT, { conversationId })).code, 'unavailable');
    const b = await stack.connect(bob); await b.expectNone(BUZZ_RECEIVED_EVENT);
  });
  test('a committed block invalidates cached sender/recipient room grants immediately', async () => {
    const { alice, bob, conversationId } = await stack.pair('buzz-block-a', 'buzz-block-b');
    const a = await stack.connect(alice), b = await stack.connect(bob);
    const blocked = await bob.browser.mutate('POST', '/api/blocks', { userId: alice.id });
    assert.equal(blocked.status, 204);
    assert.equal((await a.emitAck(BUZZ_SEND_EVENT, { conversationId })).code, 'unauthorized_conversation');
    await b.expectNone(BUZZ_RECEIVED_EVENT);
  });
});

test('Buzz honors the existing event security policy', async () => {
  const stack = await DataStack.start({ bridge: { securityPolicy: { evaluateEvent: async context =>
    context.event === BUZZ_SEND_EVENT ? { action: 'deny', reason: 'test' } : { action: 'allow' } } } });
  try {
    const { alice, bob, conversationId } = await stack.pair('buzz-policy-a', 'buzz-policy-b');
    const a = await stack.connect(alice), b = await stack.connect(bob);
    assert.equal((await a.emitAck(BUZZ_SEND_EVENT, { conversationId })).code, 'policy_denied'); await b.expectNone(BUZZ_RECEIVED_EVENT);
  } finally { await stack.close(); }
});
