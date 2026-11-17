/**
 * Real full-stack message pipeline: Socket.IO → DATA (session, CSRF, membership, key verification,
 * transactional persistence) → ack → broadcast. DATA, SQLite, Socket.IO, WebCrypto and the v2
 * envelopes are real; only the browsers are simulated.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TestDevice, type EnvelopeV2Like } from '../e2ee/support/deviceClient.ts';
import { DataStack, delay, until, type Person, type TestClient } from './support/stack.ts';

type VerifierMode = 'real' | 'fail' | 'hang';
const verifier = { mode: 'real' as VerifierMode, hangMs: 2_500, calls: 0, real: null as null | { verifyEnvelope(...args: unknown[]): Promise<unknown> } };

let stack: DataStack;
/** DATA's injectable limiter, counting what DATA is asked to charge and able to refuse on demand. */
const limiter = {
  keys: [] as string[],
  deny: false,
  consume(buckets: ReadonlyArray<{ key: string }>) {
    for (const bucket of buckets) this.keys.push(bucket.key);
    return this.deny ? { allowed: false, retryAfterSeconds: 1 } : { allowed: true };
  },
};

const pairs = new Set<TestClient>();

/** A client that, like the real one, confirms each received `message:new` through its Socket.IO ack. */
function acknowledging(client: TestClient): TestClient {
  client.socket.on('message:new', (payload: { conversationId: string; id: string }, ack?: (value: unknown) => void) => {
    ack?.({ conversationId: payload.conversationId, messageId: payload.id, status: 'delivered' });
  });
  pairs.add(client);
  return client;
}

const refusedWith = (code: string) => stack.logger.entries.some((entry) => entry.event === 'realtime.message.refused' && entry.fields.code === code);

async function stored(conversationId: string, person: Person) {
  return (await stack.history(person, conversationId)).items as Array<{ id: string; sequence: number; storedAt: string; encryption: EnvelopeV2Like['encryption'] }>;
}

describe('secure realtime messaging against real DATA', () => {
  before(async () => {
    stack = await DataStack.start({
      dependencies: { limiter },
      messageOptions: {
        verifierTimeoutMs: 4_000,
        recipientKeyVerifier: {
          async verifyEnvelope(...args: unknown[]) {
            verifier.calls += 1;
            if (verifier.mode === 'fail') throw new Error('key directory is down');
            if (verifier.mode === 'hang') await delay(verifier.hangMs);
            return verifier.real!.verifyEnvelope(...args);
          },
        },
      },
    });
    verifier.real = stack.data.application.keys.verifier;
  });
  after(async () => {
    for (const client of pairs) client.close();
    await stack?.close();
  });

  test('Alice sends encrypted v2 text to Bob: persisted by DATA first, then acknowledged and delivered, and Bob decrypts it', async () => {
    const { alice, bob, conversationId, epoch, bobKey } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const plaintext = `hello bob ${Math.random()}`;
    const envelope = await stack.envelope(alice, conversationId, epoch, plaintext, 'm-first');

    // Bob's client looks DATA up the moment the event arrives: the message is already committed.
    let committedWhenDelivered: unknown[] = [];
    bobSocket.socket.on('message:new', () => {
      void stack.history(bob, conversationId).then((body) => { committedWhenDelivered = body.items; });
    });
    const ack = await stack.send(aliceSocket, envelope);
    const received = await bobSocket.waitFor('message:new', (event) => event.id === 'm-first');

    const [row] = await stored(conversationId, alice);
    assert.deepEqual(ack, { conversationId, messageId: 'm-first', status: 'sent', timestamp: row!.storedAt }, 'the ack carries DATA\'s authoritative storedAt');
    assert.deepEqual(received, { ...envelope, deliveryStatus: 'sent' }, 'the committed envelope is relayed byte for byte');
    assert.equal(received.encryption.ciphertext, row!.encryption.ciphertext);
    assert.equal(received.encryption.keyId, epoch.keyId);
    assert.equal(await TestDevice.decrypt(bobKey.key, received), plaintext);
    await until(() => committedWhenDelivered.length === 1, 2_000, 'history read by Bob');
    assert.equal((committedWhenDelivered[0] as { id: string }).id, 'm-first');
    assert.ok(!stack.fixture.databaseText().includes(plaintext), 'the database never contains plaintext');
  });

  test('Bob replies, both directions work, and each side sees DATA\'s committed order', async () => {
    const { alice, bob, conversationId, epoch, bobKey } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'one', 'r-1'))).status, 'sent');
    await bobSocket.waitFor('message:new', (event) => event.id === 'r-1');
    const reply = await stack.envelope(bob, conversationId, bobKey, 'two', 'r-2');
    assert.equal((await stack.send(bobSocket, reply)).status, 'sent');
    const toAlice = await aliceSocket.waitFor('message:new', (event) => event.id === 'r-2');
    assert.equal(await TestDevice.decrypt(epoch.key, toAlice), 'two');
    assert.deepEqual((await stored(conversationId, bob)).map((item) => [item.id, item.sequence]), [['r-2', 2], ['r-1', 1]]);
  });

  test('every socket of an authorized account receives the message, including the sender\'s other devices', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceOne = acknowledging(await stack.connect(alice));
    const aliceTwo = acknowledging(await stack.connect(alice));
    const bobOne = acknowledging(await stack.connect(bob));
    const bobTwo = acknowledging(await stack.connect(bob));
    const ack = await stack.send(aliceOne, await stack.envelope(alice, conversationId, epoch, 'to every socket', 'multi-1'));
    assert.equal(ack.status, 'sent');
    for (const socket of [bobOne, bobTwo, aliceTwo]) assert.equal((await socket.waitFor('message:new', (event) => event.id === 'multi-1')).senderId, alice.id);
    await aliceOne.expectNone('message:new', (event) => event.id === 'multi-1');
    assert.equal((await stored(conversationId, alice)).length, 1);
  });

  test('a retry of an already stored message returns the original timestamp and never delivers twice', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const envelope = await stack.envelope(alice, conversationId, epoch, 'once only', 'dup-1');
    const first = await stack.send(aliceSocket, envelope);
    await bobSocket.waitFor('message:new', (event) => event.id === 'dup-1');
    const mark = bobSocket.mark();
    const retry = await stack.send(aliceSocket, envelope);
    assert.deepEqual(retry, first);
    await bobSocket.expectNone('message:new', () => true, { since: mark, ms: 250 });
    assert.equal((await stored(conversationId, alice)).length, 1);
    const conflicting = await stack.envelope(alice, conversationId, epoch, 'different bytes, same id', 'dup-1');
    assert.deepEqual(await stack.send(aliceSocket, conflicting), { status: 'error', code: 'idempotency_conflict' });
    await bobSocket.expectNone('message:new', () => true, { since: mark, ms: 150 });
  });

  test('envelope version 1 is refused on a real-account connection: no fallback, nothing stored or delivered', async () => {
    const { alice, bob, conversationId } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const v1 = {
      id: 'legacy-1', conversationId, senderId: alice.id, senderName: alice.displayName, timestamp: new Date().toISOString(), type: 'text',
      encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.alloc(40, 2).toString('base64') },
    };
    assert.deepEqual(await stack.send(aliceSocket, v1), { status: 'error', code: 'invalid_payload' });
    const plaintextLike = { ...v1, content: 'plaintext must never pass' };
    assert.deepEqual(await stack.send(aliceSocket, plaintextLike), { status: 'error', code: 'invalid_payload' });
    await bobSocket.expectNone('message:new');
    assert.deepEqual(await stored(conversationId, alice), []);
  });

  test('DATA refuses an envelope encrypted for a stale epoch, or for a recipient without a device, before anything is committed', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    // A new epoch supersedes the one Alice still holds.
    const next = await stack.publishEpoch(alice, conversationId, epoch);
    const stale = await stack.envelope(alice, conversationId, epoch, 'old key', 'stale-1');
    assert.deepEqual(await stack.send(aliceSocket, stale), { status: 'error', code: 'recipient_keys_unavailable' });
    assert.ok(refusedWith('RECIPIENT_KEYS_UNVERIFIED'), 'the refusal is DATA\'s own verdict, not a local guess');
    await bobSocket.expectNone('message:new');
    assert.deepEqual(await stored(conversationId, alice), []);
    // Re-encrypting for the current epoch with the SAME message id is the documented recovery.
    const fresh = await stack.envelope(alice, conversationId, next, 'current key', 'stale-1');
    assert.equal((await stack.send(aliceSocket, fresh)).status, 'sent');
    assert.equal((await bobSocket.waitFor('message:new', (event) => event.id === 'stale-1')).encryption.keyId, next.keyId);

    const carol = await stack.person('carol', 'Carol');
    const dave = await stack.person('dave', 'Dave');
    await stack.befriend(carol, dave);
    const other = await stack.openDm(carol, dave);
    await stack.registerDevice(carol);
    const carolSocket = await stack.connect(carol);
    const forged = await carol.device.encrypt(epoch.key, epoch.keyId, { conversationId: other, id: 'nodevice-1', senderName: carol.displayName }, 'nobody can read this');
    assert.deepEqual(await stack.send(carolSocket, forged), { status: 'error', code: 'recipient_keys_unavailable' }, 'no epoch exists and Dave has no device');
    assert.deepEqual(await stored(other, carol), []);
  });

  test('sender identity is bound to the DATA session: a spoofed sender or display name is refused', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const spoofed = await bob.device.encrypt(epoch.key, epoch.keyId, { conversationId, id: 'spoof-1', senderName: bob.displayName }, 'as bob');
    assert.deepEqual(await stack.send(aliceSocket, spoofed), { status: 'error', code: 'actor_mismatch' });
    const renamed = await alice.device.encrypt(epoch.key, epoch.keyId, { conversationId, id: 'spoof-2', senderName: 'Not Alice' }, 'wrong name');
    assert.deepEqual(await stack.send(aliceSocket, renamed), { status: 'error', code: 'actor_mismatch' }, 'DATA compares the CURRENT profile name');
    assert.ok(refusedWith('FORBIDDEN'));
    await bobSocket.expectNone('message:new');
    assert.deepEqual(await stored(conversationId, alice), []);
  });

  test('a stranger cannot send into a conversation and receives nothing from it', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const eve = await stack.person('eve', 'Eve');
    await stack.registerDevice(eve);
    const eveSocket = acknowledging(await stack.connect(eve));
    const aliceSocket = acknowledging(await stack.connect(alice));
    const forged = await eve.device.encrypt(epoch.key, epoch.keyId, { conversationId, id: 'eve-1', senderName: eve.displayName }, 'let me in');
    assert.deepEqual(await stack.send(eveSocket, forged), { status: 'error', code: 'unauthorized_conversation' });
    await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'private', 'private-1'));
    await eveSocket.expectNone('message:new');
    await eveSocket.expectNone('typing:update');
    void bob;
  });

  test('when DATA\'s key service is down the send fails closed: nothing stored, nothing broadcast; the same id succeeds after recovery', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const envelope = await stack.envelope(alice, conversationId, epoch, 'will be retried', 'retry-1');
    verifier.mode = 'fail';
    try {
      assert.deepEqual(await stack.send(aliceSocket, envelope), { status: 'error', code: 'unavailable' });
    } finally {
      verifier.mode = 'real';
    }
    await bobSocket.expectNone('message:new');
    assert.deepEqual(await stored(conversationId, alice), []);
    assert.equal((await stack.send(aliceSocket, envelope)).status, 'sent');
    assert.equal((await bobSocket.waitFor('message:new', (event) => event.id === 'retry-1')).id, 'retry-1');
    assert.equal((await stored(conversationId, alice)).length, 1);
  });

  test('an ack that times out while DATA still commits: the retry is a duplicate (no second delivery) and Bob reconciles from history', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const envelope = await stack.envelope(alice, conversationId, epoch, 'slow commit', 'slow-1');
    verifier.mode = 'hang';
    verifier.hangMs = 2_200;
    let first: unknown;
    try {
      first = await stack.send(aliceSocket, envelope);
    } finally {
      verifier.mode = 'real';
    }
    assert.deepEqual(first, { status: 'error', code: 'unavailable' }, 'the realtime deadline expired before DATA answered');
    assert.ok(stack.logger.entries.some((entry) => entry.event === 'realtime.message.store_failed' && entry.fields.outcome === 'timeout'));
    // DATA finishes the commit that the realtime layer had given up on.
    await until(async () => (await stored(conversationId, alice)).length === 1, 4_000, 'the late commit');
    const retry = await stack.send(aliceSocket, envelope);
    assert.equal(retry.status, 'sent');
    assert.equal(retry.timestamp, (await stored(conversationId, alice))[0]!.storedAt);
    await bobSocket.expectNone('message:new', (event) => event.id === 'slow-1', { ms: 250 });
    assert.equal((await stored(conversationId, bob)).length, 1, 'DATA history is authoritative for Bob');
    assert.equal((await stored(conversationId, bob))[0]!.id, 'slow-1');
  });

  test('delivery and read receipts are persisted by DATA and relayed to the sender', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'receipts', 'rc-1'));
    const delivered = await aliceSocket.waitFor('message:delivered', (event) => event.messageId === 'rc-1');
    assert.deepEqual([delivered.conversationId, delivered.status, delivered.userId], [conversationId, 'delivered', bob.id]);
    const db = stack.data.application.db;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM MessageReceipts WHERE status='delivered' AND user_id=?").get(bob.id).n, 1);

    const read = await bobSocket.emitAck('message:read', { conversationId, messageId: 'rc-1' });
    assert.deepEqual([read.status, read.userId, read.messageId], ['read', bob.id, 'rc-1']);
    const relayed = await aliceSocket.waitFor('message:read', (event) => event.messageId === 'rc-1');
    assert.equal(relayed.userId, bob.id);
    assert.equal(relayed.timestamp, read.timestamp);
    const mark = aliceSocket.mark();
    const again = await bobSocket.emitAck('message:read', { conversationId, messageId: 'rc-1' });
    assert.equal(again.timestamp, read.timestamp, 'a repeated read keeps the original time');
    await aliceSocket.expectNone('message:read', () => true, { since: mark });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM MessageReceipts WHERE status='read' AND user_id=?").get(bob.id).n, 1);
    // The sender cannot mark their own message read; a stranger cannot read at all.
    assert.equal((await aliceSocket.emitAck('message:read', { conversationId, messageId: 'rc-1' })).status, 'error');
  });

  test('socket writes are charged to DATA\'s own per-user budget, so extra sockets cannot multiply it', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = acknowledging(await stack.connect(alice));
    const aliceOther = acknowledging(await stack.connect(alice));
    const bobSocket = acknowledging(await stack.connect(bob));
    const budget = (userId: string, operation: string) => limiter.keys.filter((key) => key === `messages:${operation}:${userId}`).length;
    const before = budget(alice.id, 'submit');
    assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'one', 'budget-1'))).status, 'sent');
    assert.equal((await stack.send(aliceOther, await stack.envelope(alice, conversationId, epoch, 'two', 'budget-2'))).status, 'sent');
    assert.equal(budget(alice.id, 'submit'), before + 2, 'each socket write consumed DATA\'s account-wide submit budget');
    await bobSocket.waitFor('message:new', (event) => event.id === 'budget-2');
    const reads = budget(bob.id, 'read');
    await bobSocket.emitAck('message:read', { conversationId, messageId: 'budget-1' });
    assert.ok(budget(bob.id, 'read') > reads, 'receipts consume DATA\'s read budget');
    // DATA's limiter refuses: the realtime answer is rate_limited and nothing is stored or delivered.
    limiter.deny = true;
    let refused: unknown;
    try {
      refused = await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'three', 'budget-3'));
    } finally {
      limiter.deny = false;
    }
    assert.deepEqual(refused, { status: 'error', code: 'rate_limited' });
    await bobSocket.expectNone('message:new', (event) => event.id === 'budget-3');
    assert.deepEqual((await stored(conversationId, alice)).map((item) => item.id).sort(), ['budget-1', 'budget-2']);
    assert.equal((await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'three', 'budget-3'))).status, 'sent');
  });
  test('nothing sensitive reaches the logs', async () => {
    const text = stack.logger.text();
    assert.ok(stack.logger.entries.length > 0);
    assert.doesNotMatch(text, /ciphertext|csrfToken|secubuzz_session|"iv"|wrap|BEGIN/i);
  });
});
