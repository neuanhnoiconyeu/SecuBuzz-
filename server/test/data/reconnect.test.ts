/**
 * Reconnection and history reconciliation against real DATA. Realtime events are hints; DATA history
 * is authoritative. The client subscribes first (socket connect), then reads history, and dedupes by
 * the wire message `id`. Delivery is not claimed to be exactly-once.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TestDevice, type EnvelopeV2Like } from '../e2ee/support/deviceClient.ts';
import { DataStack, delay, SESSION_COOKIE, until, type TestClient } from './support/stack.ts';

let stack: DataStack;

function acknowledging(client: TestClient): TestClient {
  client.socket.on('message:new', (payload: { conversationId: string; id: string }, ack?: (value: unknown) => void) => {
    ack?.({ conversationId: payload.conversationId, messageId: payload.id, status: 'delivered' });
  });
  return client;
}

async function waitForSocketCount(expected: number): Promise<void> {
  await until(() => stack.bridge.realtime.getStats().connections === expected, 3_000, `${expected} connection(s)`);
}

describe('reconnection and history reconciliation', () => {
  before(async () => {
    // The realtime send bucket (10 burst, 1 per second) would throttle the 14-message stream below.
    stack = await DataStack.start({ bridge: { rates: { send: { capacity: 100, refillPerSecond: 100 } } } });
  });
  after(async () => {
    await stack?.close();
  });

  test('messages sent while a recipient is offline are not replayed over the socket; DATA history returns them in order and they decrypt', async () => {
    const { alice, bob, conversationId, epoch, bobKey } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const first = acknowledging(await stack.connect(bob));
    first.close();
    await until(() => !first.connected);
    for (const n of [1, 2, 3]) assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, `offline ${n}`, `off-${n}`))).status, 'sent');
    const returning = acknowledging(await stack.connect(bob));
    await returning.expectNone('message:new', () => true, { ms: 300 });
    const { items } = await stack.history(bob, conversationId);
    assert.deepEqual(items.map((item: { id: string }) => item.id).reverse(), ['off-1', 'off-2', 'off-3']);
    assert.deepEqual(items.map((item: { sequence: number }) => item.sequence).reverse(), [1, 2, 3]);
    const plaintexts = await Promise.all(items.map((item: EnvelopeV2Like & { storedAt: string }) => TestDevice.decrypt(bobKey.key, item)));
    assert.deepEqual(plaintexts.reverse(), ['offline 1', 'offline 2', 'offline 3']);
  });

  test('subscribe-then-fetch leaves no gap: a message sent while the client reconnects is either live, in history, or both', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const before = acknowledging(await stack.connect(bob));
    const total = 14;
    const sender = (async () => {
      for (let n = 1; n <= total; n += 1) {
        const ack = await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, `stream ${n}`, `gap-${n}`));
        assert.equal(ack.status, 'sent');
        await delay(25);
      }
    })();
    await until(() => before.events('message:new').length >= 3, 3_000, 'the first live messages');
    before.close();
    await until(() => !before.connected);
    // Reconnect mid-stream: the room is joined before the client can issue the history request.
    const returning = acknowledging(await stack.connect(bob));
    const snapshot = (await stack.history(bob, conversationId)).items.map((item: { id: string }) => item.id);
    await sender;
    await delay(400);
    const live = (returning.events('message:new') as Array<{ id: string }>).map((event) => event.id);
    const seen = new Set<string>([...snapshot, ...live]);
    const wanted = Array.from({ length: total }, (_, index) => `gap-${index + 1}`);
    assert.deepEqual(wanted.filter((id) => !seen.has(id)), [], 'nothing fell between the history read and the subscription');
    // Dedupe by the authoritative wire id: the overlap, if any, collapses to one message.
    assert.equal(seen.size, total);
    const final = (await stack.history(bob, conversationId)).items;
    assert.equal(final.length, total);
  });

  test('a retry after a lost ack is a duplicate: the recipient is not told twice and history has exactly one copy', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const bobSocket = acknowledging(await stack.connect(bob));
    const envelope = await stack.envelope(alice, conversationId, epoch, 'ack lost', 'lost-ack-1');
    assert.equal((await stack.send(aliceSocket, envelope)).status, 'sent');
    aliceSocket.close();
    const reconnected = await stack.connect(alice);
    const mark = bobSocket.mark();
    const retried = await stack.send(reconnected, envelope);
    assert.equal(retried.status, 'sent');
    await bobSocket.expectNone('message:new', () => true, { since: mark, ms: 250 });
    assert.equal(bobSocket.events('message:new').filter((event) => (event as { id: string }).id === 'lost-ack-1').length, 1);
    assert.equal((await stack.history(bob, conversationId)).items.length, 1);
  });

  test('reconnect re-authenticates with the NEW session: the old cookie and CSRF token are dead, the new ones work and rejoin the rooms', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const bobSocket = acknowledging(await stack.connect(bob));
    const original = await stack.connect(alice);
    const oldCookie = `${SESSION_COOKIE}=${alice.browser.cookies.get(SESSION_COOKIE)}`;
    const oldCsrf = alice.browser.token;
    assert.equal((await alice.browser.mutate('POST', '/api/auth/logout')).status, 204);
    await original.waitForDisconnect(3_000);
    const login = await alice.browser.request('/api/auth/login', { method: 'POST', headers: { 'X-CSRF-Token': await alice.browser.csrf() },
      body: { identifier: alice.username, password: 'Synthetic passphrase for e2ee tests 2026!' } });
    assert.equal(login.status, 200);
    await alice.browser.csrf();
    assert.equal((await stack.connectError(alice, { cookie: oldCookie, csrf: oldCsrf })).code, 'UNAUTHORIZED');
    assert.equal((await stack.connectError(alice, { csrf: oldCsrf })).code, 'UNAUTHORIZED', 'the new cookie with the old CSRF token');
    const fresh = await stack.connect(alice);
    assert.equal((await stack.send(fresh, await stack.envelope(alice, conversationId, epoch, 'back again', 'again-1'))).status, 'sent');
    assert.equal((await bobSocket.waitFor('message:new', (event) => event.id === 'again-1')).senderId, alice.id);
  });

  test('a reconnect rejoins only the rooms DATA still allows: a conversation lost while offline is not rejoined', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const bobSocket = await stack.connect(bob);
    bobSocket.close();
    await until(() => !bobSocket.connected);
    assert.equal((await alice.browser.mutate('DELETE', `/api/friends/${bob.id}`)).status, 204);
    const returning = acknowledging(await stack.connect(bob));
    const aliceSocket = await stack.connect(alice);
    assert.deepEqual(await stack.send(returning, await stack.envelope(bob, conversationId, await stack.currentKey(bob, conversationId), 'not allowed', 'rejoin-1')), { status: 'error', code: 'unauthorized_conversation' });
    assert.deepEqual(await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'also not allowed', 'rejoin-2')), { status: 'error', code: 'unauthorized_conversation' });
    returning.emit('typing:start', { conversationId });
    await aliceSocket.expectNone('typing:update');
  });

  test('when DATA cannot answer at handshake the connection is refused as REALTIME_UNAVAILABLE and no rooms are granted', async () => {
    const { alice } = await stack.pair();
    const app = stack.data.application;
    const list = app.conversations.list;
    app.conversations.list = () => { throw new Error('database is locked'); };
    try {
      assert.equal((await stack.connectError(alice)).code, 'REALTIME_UNAVAILABLE');
    } finally {
      app.conversations.list = list;
    }
    const csrfProof = app.auth.csrfProof;
    app.auth.csrfProof = () => { throw new Error('database is locked'); };
    try {
      assert.equal((await stack.connectError(alice)).code, 'REALTIME_UNAVAILABLE', 'a CSRF check that cannot run is not a CSRF pass');
    } finally {
      app.auth.csrfProof = csrfProof;
    }
    assert.equal((await stack.connect(alice)).connected, true);
  });

  test('a refresh failure mid-connection never adds access: the last verified grants stay and the failure is logged', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const bobSocket = acknowledging(await stack.connect(bob));
    const app = stack.data.application;
    const list = app.conversations.list;
    app.conversations.list = () => { throw new Error('database is locked'); };
    try {
      assert.equal(await stack.bridge.realtime.refreshUserAccess(alice.id), false);
    } finally {
      app.conversations.list = list;
    }
    assert.ok(stack.logger.has('realtime.access.refresh_failed'));
    assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'still granted', 'keep-1'))).status, 'sent');
    await bobSocket.waitFor('message:new', (event) => event.id === 'keep-1');
    await waitForSocketCount(stack.bridge.realtime.getStats().connections);
  });
});
