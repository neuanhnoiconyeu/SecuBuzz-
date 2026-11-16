/**
 * The realtime side of the DATA composition, driven by in-memory doubles: per-connection binding,
 * handshake CSRF shape, store failure classification, post-commit fan-out rules, optional authorizer
 * capabilities and key-change events. Real DATA is covered by `test/data/`; these tests pin the
 * contract of the seam itself, including cases real DATA cannot produce on demand.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { resolveRealtimeConfig, RealtimeConfigError } from '../../src/realtime/config.ts';
import type { BoundConnection, ConnectionBinder, ConnectionCredentials, KeyEpochSummary, RealtimeActor } from '../../src/realtime/contracts.ts';
import { ACK_ERROR_CODES, classifyStoreFailure } from '../../src/realtime/protocol.ts';
import { TestMessageStore } from '../support/fixtures.ts';
import { delay, eventually, startTestServer, TEST_CIPHERTEXT, TEST_IV, TEST_ORIGIN, type TestClient, type TestServer, type TestUser } from '../support/harness.ts';

const KEY_ID = Buffer.alloc(16, 9).toString('base64url');

function v2(sender: TestUser, conversationId: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, conversationId, senderId: sender.userId, senderName: sender.displayName, timestamp: new Date().toISOString(), type: 'text',
    encryption: { version: 2, algorithm: 'AES-256-GCM', encoding: 'base64', keyId: KEY_ID, iv: TEST_IV, ciphertext: TEST_CIPHERTEXT },
    ...overrides,
  };
}

/** What DATA's `AuthError` looks like to the adapter wrapper: a code, optional fields, and a message that must never leak. */
class DataLikeError extends Error {
  readonly code: string;
  readonly fields: string[];
  constructor(code: string, fields: string[] = []) {
    super('secret detail: password=hunter2 session=abc');
    this.code = code;
    this.fields = fields;
  }
}

class FakeBinder implements ConnectionBinder {
  readonly calls: Array<{ userId: string; sessionToken: string; csrfToken: string | null }> = [];
  readonly stores = new Map<string, TestMessageStore>();
  mode: 'ok' | 'null' | 'throw' | 'hang' | 'malformed' = 'ok';

  storeOf(userId: string): TestMessageStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = new TestMessageStore();
      this.stores.set(userId, store);
    }
    return store;
  }

  async bind(actor: RealtimeActor, credentials: ConnectionCredentials): Promise<BoundConnection | null> {
    this.calls.push({ userId: actor.userId, sessionToken: credentials.sessionToken, csrfToken: credentials.csrfToken });
    if (this.mode === 'throw') throw new Error('binder failure with secret detail: password=hunter2');
    if (this.mode === 'hang') return new Promise(() => undefined);
    if (this.mode === 'malformed') return { store: 'not a store' } as unknown as BoundConnection;
    if (this.mode === 'null' || credentials.csrfToken !== `csrf-${actor.userId}`) return null;
    return { store: this.storeOf(actor.userId) };
  }
}

let server: TestServer;
let binder: FakeBinder;

async function boot(extra: Record<string, unknown> = {}): Promise<void> {
  binder = new FakeBinder();
  // The send bucket (10 burst) would throttle the failure-mapping table below, which is not what it tests.
  server = await startTestServer({ connectionBinder: binder, rates: { send: { capacity: 200, refillPerSecond: 200 } }, ...extra });
}

const auth = (user: TestUser) => ({ csrfToken: `csrf-${user.userId}` });

async function pair(conversationId = 'conv-1'): Promise<{ alice: TestUser; bob: TestUser; aliceSocket: TestClient; bobSocket: TestClient }> {
  const alice = server.addUser('alice', { displayName: 'Alice' });
  const bob = server.addUser('bob', { displayName: 'Bob' });
  server.authorizer.grant('alice', conversationId);
  server.authorizer.grant('bob', conversationId);
  const aliceSocket = await server.connect(alice, { auth: auth(alice) });
  const bobSocket = await server.connect(bob, { auth: auth(bob) });
  return { alice, bob, aliceSocket, bobSocket };
}

describe('connection binder (handshake)', () => {
  afterEach(async () => {
    await server?.close();
  });

  test('the binder receives the cookie value and the handshake CSRF token and nothing else; the resolved actor is the identity', async () => {
    await boot();
    const alice = server.addUser('alice', { displayName: 'Alice' });
    await server.connect(alice, { auth: auth(alice) });
    assert.deepEqual(binder.calls, [{ userId: 'alice', sessionToken: alice.token, csrfToken: 'csrf-alice' }]);
  });

  test('a missing, wrong or empty CSRF token is UNAUTHORIZED and never connects', async () => {
    await boot();
    const alice = server.addUser('alice');
    assert.equal((await server.connectError(alice)).code, 'UNAUTHORIZED');
    assert.equal((await server.connectError(alice, { auth: {} })).code, 'UNAUTHORIZED');
    assert.equal((await server.connectError(alice, { auth: { csrfToken: 'csrf-someone-else' } })).code, 'UNAUTHORIZED');
    assert.equal((await server.connectError(alice, { auth: { csrfToken: '' } })).code, 'UNAUTHORIZED');
    assert.equal(server.handle.getStats().connections, 0);
  });

  test('extra auth keys or non-string tokens are rejected before the binder runs', async () => {
    await boot();
    const alice = server.addUser('alice');
    for (const body of [{ csrfToken: 'csrf-alice', userId: 'bob' }, { csrfToken: 5 }, { csrfToken: 'a b' }, { csrfToken: 'x'.repeat(2_000) }, { token: 'csrf-alice' }]) {
      assert.equal((await server.connectError(alice, { auth: body as Record<string, unknown> })).code, 'UNAUTHORIZED', JSON.stringify(Object.keys(body)));
    }
    assert.deepEqual(binder.calls, []);
  });

  test('a binder that throws, hangs or returns something else fails the handshake closed as REALTIME_UNAVAILABLE', async () => {
    await boot();
    const alice = server.addUser('alice');
    for (const mode of ['throw', 'hang', 'malformed'] as const) {
      binder.mode = mode;
      const failure = await server.connectError(alice, { auth: auth(alice) });
      assert.equal(failure.code, 'REALTIME_UNAVAILABLE', mode);
      assert.doesNotMatch(failure.message, /hunter2|secret/);
    }
    binder.mode = 'null';
    assert.equal((await server.connectError(alice, { auth: auth(alice) })).code, 'UNAUTHORIZED');
    assert.doesNotMatch(server.logger.text(), /hunter2|secret detail/);
  });

  test('without a binder the handshake auth payload is ignored (legacy mode is unchanged)', async () => {
    server = await startTestServer({});
    const alice = server.addUser('alice');
    assert.equal((await server.connect(alice, { auth: { csrfToken: 'whatever', userId: 'bob' } })).connected, true);
  });

  test('the transport verdict comes from resolveTransportSecurity, never from raw forwarded headers', async () => {
    await boot({ resolveTransportSecurity: () => true });
    const alice = server.addUser('alice');
    await server.connect(alice, { auth: auth(alice) });
    assert.equal(server.sessions.contexts.at(-1)?.secure, true);
    await server.close();
    await boot();
    const bob = server.addUser('bob');
    await server.connect(bob, { auth: auth(bob) });
    assert.equal(server.sessions.contexts.at(-1)?.secure, false, 'plain HTTP is not secure by default');
  });
});

describe('configuration', () => {
  test('a binder needs a session resolver and an authorizer; optional authorizer methods must be functions', () => {
    const binderOnly = { allowedOrigins: [TEST_ORIGIN], connectionBinder: { bind: async () => null } };
    assert.throws(() => resolveRealtimeConfig(binderOnly), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...binderOnly, sessionResolver: { resolveSession: async () => ({ status: 'missing' as const }) } }), RealtimeConfigError);
    const authorizer = { listConversationIds: async () => [], listBlockedUserIds: async () => [], filterPresenceSubjects: async () => [] };
    const complete = { ...binderOnly, sessionResolver: { resolveSession: async () => ({ status: 'missing' as const }) }, authorizer };
    assert.doesNotThrow(() => resolveRealtimeConfig(complete));
    assert.throws(() => resolveRealtimeConfig({ ...complete, authorizer: { ...authorizer, canReceive: 'yes' } as never }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...complete, resolveTransportSecurity: 'yes' as never }), RealtimeConfigError);
    assert.throws(() => resolveRealtimeConfig({ ...complete, connectionBinder: {} as never }), RealtimeConfigError);
  });
});

describe('bound sends', () => {
  afterEach(async () => {
    await server?.close();
  });

  test('each connection uses ITS OWN store: a send is committed only in the sender\'s bound store', async () => {
    await boot();
    const { alice, bob, aliceSocket, bobSocket } = await pair();
    assert.equal((await aliceSocket.emitAck('message:send', v2(alice, 'conv-1', 'a-1'))).status, 'sent');
    assert.equal((await bobSocket.emitAck('message:send', v2(bob, 'conv-1', 'b-1'))).status, 'sent');
    assert.equal(binder.storeOf('alice').messageCount, 1);
    assert.equal(binder.storeOf('bob').messageCount, 1);
    assert.equal(binder.storeOf('alice').storeCalls, 1);
    assert.equal(binder.storeOf('bob').storeCalls, 1);
  });

  test('version 1 and plaintext are refused on a bound connection; version 2 is not accepted on a legacy connection', async () => {
    await boot();
    const { alice, aliceSocket } = await pair();
    const v1 = { ...v2(alice, 'conv-1', 'v1-1'), encryption: { version: 1, algorithm: 'AES-256-GCM', encoding: 'base64', iv: TEST_IV, ciphertext: TEST_CIPHERTEXT } };
    assert.deepEqual(await aliceSocket.emitAck('message:send', v1), { status: 'error', code: 'invalid_payload' });
    assert.deepEqual(await aliceSocket.emitAck('message:send', { ...v2(alice, 'conv-1', 'v1-2'), content: 'plain' }), { status: 'error', code: 'invalid_payload' });
    assert.equal(binder.storeOf('alice').storeCalls, 0);
    await server.close();

    server = await startTestServer({ withStore: true, withVerifier: true });
    const legacy = server.addUser('carol');
    server.authorizer.grant('carol', 'conv-1');
    const socket = await server.connect(legacy);
    assert.deepEqual(await socket.emitAck('message:send', v2(legacy, 'conv-1', 'v2-legacy')), { status: 'error', code: 'invalid_payload' });
    assert.equal(server.store.storeCalls, 0);
  });

  test('every store failure maps to a code in the client\'s closed set; the store\'s message never reaches the client or the logs', async () => {
    await boot();
    const { alice, aliceSocket } = await pair();
    const table: Array<[string | undefined, string[], string, boolean]> = [
      ['VALIDATION_ERROR', [], 'invalid_payload', false],
      ['PAYLOAD_TOO_LARGE', [], 'invalid_payload', false],
      ['FORBIDDEN', ['senderId'], 'actor_mismatch', false],
      ['FORBIDDEN', ['senderName'], 'actor_mismatch', false],
      ['FORBIDDEN', [], 'unauthorized_conversation', false],
      ['NOT_FOUND', [], 'unauthorized_conversation', false],
      ['RECIPIENT_KEYS_UNVERIFIED', [], 'recipient_keys_unavailable', false],
      ['RATE_LIMITED', [], 'rate_limited', false],
      ['RECIPIENT_KEYS_UNAVAILABLE', [], 'unavailable', false],
      ['SERVICE_UNAVAILABLE', [], 'unavailable', false],
      ['INTERNAL_ERROR', [], 'unavailable', false],
      ['lowercase_code', [], 'unavailable', false],
      [undefined, [], 'unavailable', false],
    ];
    const store = binder.storeOf('alice');
    let sequence = 0;
    for (const [code, fields, expected] of table) {
      sequence += 1;
      store.storeMode = 'normal';
      const original = store.storeMessage.bind(store);
      store.storeMessage = async () => { throw code === undefined ? new Error('plain failure password=hunter2') : new DataLikeError(code, fields); };
      const ack = await aliceSocket.emitAck('message:send', v2(alice, 'conv-1', `map-${sequence}`));
      store.storeMessage = original;
      assert.deepEqual(ack, { status: 'error', code: expected }, String(code));
      assert.ok((ACK_ERROR_CODES as readonly string[]).includes(ack.code));
    }
    assert.doesNotMatch(server.logger.text(), /hunter2|secret detail/);
    assert.equal(store.messageCount, 0);
  });

  test('a session or CSRF failure from the store answers policy_denied and closes the connection', async () => {
    for (const code of ['CSRF_INVALID', 'UNAUTHENTICATED', 'SESSION_EXPIRED']) {
      await boot();
      const { alice, aliceSocket, bobSocket } = await pair();
      binder.storeOf('alice').storeMessage = async () => { throw new DataLikeError(code); };
      assert.deepEqual(await aliceSocket.emitAck('message:send', v2(alice, 'conv-1', `dead-${code}`)), { status: 'error', code: 'policy_denied' });
      await eventually(() => !aliceSocket.connected, 2_000, `the socket to close after ${code}`);
      assert.equal(bobSocket.connected, true);
      await bobSocket.expectNone('message:new');
      await server.close();
    }
  });

  test('classifyStoreFailure is total and never maps to a code outside the closed set', () => {
    for (const code of ['VALIDATION_ERROR', 'FORBIDDEN', 'NOT_FOUND', 'x', '', undefined, 'RATE_LIMITED', 'CSRF_INVALID']) {
      const action = classifyStoreFailure(code, ['senderId']);
      assert.ok((ACK_ERROR_CODES as readonly string[]).includes(action.ack));
    }
  });

  test('only a CREATED message is fanned out; a duplicate, a conflict and a failure are not', async () => {
    await boot();
    const { alice, aliceSocket, bobSocket } = await pair();
    const envelope = v2(alice, 'conv-1', 'once-1');
    assert.equal((await aliceSocket.emitAck('message:send', envelope)).status, 'sent');
    await bobSocket.waitFor('message:new', (event) => event.id === 'once-1');
    const mark = bobSocket.mark();
    const retry = await aliceSocket.emitAck('message:send', envelope);
    assert.equal(retry.status, 'sent');
    assert.deepEqual(await aliceSocket.emitAck('message:send', { ...envelope, encryption: { ...(envelope.encryption as object), ciphertext: Buffer.alloc(60, 8).toString('base64') } }), { status: 'error', code: 'idempotency_conflict' });
    binder.storeOf('alice').storeMode = 'throw';
    assert.deepEqual(await aliceSocket.emitAck('message:send', v2(alice, 'conv-1', 'fail-1')), { status: 'error', code: 'unavailable' });
    await bobSocket.expectNone('message:new', () => true, { since: mark });
    assert.deepEqual(bobSocket.events('message:new').map((event) => (event as { id: string }).id), ['once-1']);
  });

  test('nothing is broadcast before the store answers: a slow commit delays both the ack and the delivery', async () => {
    await boot();
    const { alice, aliceSocket, bobSocket } = await pair();
    binder.storeOf('alice').storeDelayMs = 250;
    const pending = aliceSocket.emitAck('message:send', v2(alice, 'conv-1', 'slow-1'));
    await delay(120);
    assert.equal(bobSocket.events('message:new').length, 0, 'no delivery while the commit is outstanding');
    assert.equal((await pending).status, 'sent');
    await bobSocket.waitFor('message:new', (event) => event.id === 'slow-1');
  });

  test('the relayed envelope is the submitted one, byte for byte, with only deliveryStatus added', async () => {
    await boot();
    const { alice, aliceSocket, bobSocket } = await pair();
    const envelope = v2(alice, 'conv-1', 'bytes-1');
    await aliceSocket.emitAck('message:send', envelope);
    assert.deepEqual(await bobSocket.waitFor('message:new', (event) => event.id === 'bytes-1'), { ...envelope, deliveryStatus: 'sent' });
  });
});

describe('delivery authorization and optional capabilities', () => {
  afterEach(async () => {
    await server?.close();
  });

  test('canReceive is asked before every delivery: false and failures withhold it, true delivers', async () => {
    await boot();
    const { alice, aliceSocket, bobSocket } = await pair();
    const asked: string[] = [];
    let answer: 'yes' | 'no' | 'throw' | 'hang' = 'no';
    server.authorizer.canReceive = async (actor: RealtimeActor) => {
      asked.push(actor.userId);
      if (answer === 'throw') throw new Error('database is locked');
      if (answer === 'hang') return new Promise<boolean>(() => undefined);
      return answer === 'yes';
    };
    for (const [index, mode] of (['no', 'throw', 'hang'] as const).entries()) {
      answer = mode;
      assert.equal((await aliceSocket.emitAck('message:send', v2(alice, 'conv-1', `deny-${index}`))).status, 'sent', 'the commit already happened');
    }
    await bobSocket.expectNone('message:new', () => true, { ms: 500 });
    answer = 'yes';
    await aliceSocket.emitAck('message:send', v2(alice, 'conv-1', 'allow-1'));
    assert.equal((await bobSocket.waitFor('message:new', (event) => event.id === 'allow-1')).id, 'allow-1');
    assert.ok(asked.every((id) => id === 'bob'), 'the sender is not re-authorized for its own message');
  });

  test('a withheld delivery makes the server re-read the recipient\'s grants', async () => {
    await boot();
    const { alice, aliceSocket, bobSocket } = await pair();
    server.authorizer.canReceive = async () => false;
    server.authorizer.revoke('bob', 'conv-1');
    await aliceSocket.emitAck('message:send', v2(alice, 'conv-1', 'stale-1'));
    await bobSocket.expectNone('message:new');
    await delay(100);
    const rejected = await bobSocket.emitAck('message:send', v2({ userId: 'bob', displayName: 'Bob' } as TestUser, 'conv-1', 'bob-after'));
    assert.deepEqual(rejected, { status: 'error', code: 'unauthorized_conversation' });
  });

  test('presencePreference "invisible" is applied before the first publish; an unreadable preference rejects the handshake', async () => {
    await boot();
    server.authorizer.presencePreference = async (actor: RealtimeActor) => (actor.userId === 'bob' ? 'invisible' : 'available');
    const alice = server.addUser('alice');
    const bob = server.addUser('bob');
    server.authorizer.befriend('alice', 'bob');
    const aliceSocket = await server.connect(alice, { auth: auth(alice) });
    aliceSocket.emit('presence:subscribe', { userIds: ['bob'] });
    await server.connect(bob, { auth: auth(bob) });
    assert.equal((await aliceSocket.waitFor('presence:update', (event) => event.userId === 'bob')).status, 'offline');
    await aliceSocket.expectNone('presence:update', (event) => event.status === 'online');

    server.authorizer.presencePreference = async () => { throw new Error('profile unavailable'); };
    assert.equal((await server.connectError(alice, { auth: auth(alice) })).code, 'REALTIME_UNAVAILABLE');
    server.authorizer.presencePreference = async () => 'sleeping' as never;
    assert.equal((await server.connectError(alice, { auth: auth(alice) })).code, 'REALTIME_UNAVAILABLE');
  });

  test('notifyKeysChanged reaches only room members the key owner allows, and forwards nothing but the two fields', async () => {
    await boot();
    const { aliceSocket, bobSocket } = await pair();
    const carol = server.addUser('carol');
    const carolSocket = await server.connect(carol, { auth: auth(carol) });
    const epoch: KeyEpochSummary = { keyId: KEY_ID, epoch: 3 };
    const answers = new Map<string, unknown>([['alice', { ...epoch, wraps: ['secret'], signature: 'x' }], ['bob', undefined], ['carol', epoch]]);
    server.authorizer.currentKeyEpoch = async (actor: RealtimeActor) => answers.get(actor.userId) as KeyEpochSummary | null | undefined;
    assert.equal(await server.handle.notifyKeysChanged('conv-1'), 1);
    assert.deepEqual(await aliceSocket.waitFor('conversation:keys-changed'), { conversationId: 'conv-1', currentEpoch: epoch });
    await bobSocket.expectNone('conversation:keys-changed');
    await carolSocket.expectNone('conversation:keys-changed');
    answers.set('bob', null);
    answers.set('alice', { keyId: 'x', epoch: 0 });
    assert.equal(await server.handle.notifyKeysChanged('conv-1'), 1, 'a malformed summary is dropped, null is a real answer');
    assert.deepEqual(await bobSocket.waitFor('conversation:keys-changed'), { conversationId: 'conv-1', currentEpoch: null });
    answers.set('bob', 'oops');
    assert.equal(await server.handle.notifyKeysChanged('conv-1'), 0);
    assert.equal(await server.handle.notifyKeysChanged('no-such-room'), 0);
    assert.throws(() => void server.handle.notifyKeysChanged(''), TypeError);
  });

  test('without currentKeyEpoch support no key event is ever emitted', async () => {
    await boot();
    await pair();
    assert.equal(await server.handle.notifyKeysChanged('conv-1'), 0);
  });

  test('refreshAllAccess re-reads every connected user and applies a revoked conversation', async () => {
    await boot();
    const { alice, aliceSocket, bobSocket } = await pair();
    server.authorizer.revoke('bob', 'conv-1');
    assert.equal(await server.handle.refreshAllAccess(), 2);
    assert.deepEqual(await bobSocket.emitAck('message:send', v2({ userId: 'bob', displayName: 'Bob' } as TestUser, 'conv-1', 'b-late')), { status: 'error', code: 'unauthorized_conversation' });
    assert.equal((await aliceSocket.emitAck('message:send', v2(alice, 'conv-1', 'a-late'))).status, 'sent');
    await bobSocket.expectNone('message:new');
  });
});
