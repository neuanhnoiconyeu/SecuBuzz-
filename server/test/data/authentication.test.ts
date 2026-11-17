/**
 * Handshake and session lifecycle against real DATA accounts: session cookie, Origin, session-bound
 * CSRF, rejected demo/client-supplied identities, and revocation while connected.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { attachRealtimeToData, transportSecurityFor } from '../../src/data/index.ts';
import { Browser } from '../e2ee/support/dataApp.ts';
import { DataStack, SESSION_COOKIE } from './support/stack.ts';

const clock = { skewMs: 0 };
let stack: DataStack;
/** No HTTP observer and no periodic revalidation: only DATA's own per-call checks protect the socket. */
let bare: DataStack;
/** No HTTP observer, fast revalidation: only the periodic session check ends the socket. */
let sweeping: DataStack;

describe('realtime handshake authenticates real DATA sessions', () => {
  before(async () => {
    stack = await DataStack.start({ dependencies: { now: () => Date.now() + clock.skewMs } });
    bare = await DataStack.start({ bridge: { observeChanges: false } });
    sweeping = await DataStack.start({ dependencies: { now: () => Date.now() + clock.skewMs },
      bridge: { observeChanges: false, timing: { revalidationIntervalMs: 120 } } });
  });
  after(async () => {
    await Promise.all([stack?.close(), bare?.close(), sweeping?.close()]);
  });

  test('a valid session cookie plus its own CSRF token connects, and the identity is the account\'s', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    const bobSocket = await stack.connect(bob);
    const ack = await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'identity', 'who-1'));
    assert.equal(ack.status, 'sent');
    assert.equal((await bobSocket.waitFor('message:new', (event) => event.id === 'who-1')).senderId, alice.id);
  });

  test('the handshake also works over the long-polling transport', async () => {
    const { alice } = await stack.pair();
    const client = await stack.connect(alice, { transports: ['polling'] });
    assert.equal(client.connected, true);
  });

  test('an authenticated polling connection upgrades to WebSocket without attaching a second server', async () => {
    const { alice, conversationId, epoch } = await stack.pair();
    const client = await stack.connect(alice, { transports: ['polling', 'websocket'] });
    const engine = client.socket.io.engine;
    if (engine.transport.name !== 'websocket') await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Authenticated WebSocket upgrade timed out')), 5_000);
      engine.once('upgrade', () => { clearTimeout(timer); resolve(); });
      engine.once('upgradeError', () => { clearTimeout(timer); reject(new Error('Authenticated WebSocket upgrade failed')); });
    });
    assert.equal(engine.transport.name, 'websocket');
    assert.equal((await stack.send(client, await stack.envelope(alice, conversationId, epoch, 'after upgrade', 'upgrade-1'))).status, 'sent');
    assert.throws(() => attachRealtimeToData(stack.data.server, stack.data.application), /already attached/);
    assert.equal(client.connected, true);
  });

  test('periodic DATA session expiration disconnects an already connected client and denies reconnect', async () => {
    const { alice } = await sweeping.pair();
    const client = await sweeping.connect(alice);
    const closed = client.waitForDisconnect(3_000);
    clock.skewMs = 9 * 3_600_000;
    try {
      assert.equal(await closed, 'io server disconnect');
      assert.equal((await sweeping.connectError(alice)).code, 'SESSION_EXPIRED');
    } finally { clock.skewMs = 0; }
  });

  test('no cookie, an unknown token, a malformed cookie, or the wrong cookie name is rejected', async () => {
    const { alice } = await stack.pair();
    assert.equal((await stack.connectError(alice, { cookie: null })).code, 'AUTH_REQUIRED');
    assert.equal((await stack.connectError(alice, { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` })).code, 'UNAUTHORIZED');
    assert.equal((await stack.connectError(alice, { cookie: `${SESSION_COOKIE}=not-a-token` })).code, 'UNAUTHORIZED');
    const token = alice.browser.cookies.get(SESSION_COOKIE)!;
    assert.equal((await stack.connectError(alice, { cookie: `__Host-${SESSION_COOKIE}=${token}` })).code, 'AUTH_REQUIRED');
    assert.equal((await stack.connectError(alice, { cookie: `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${'B'.repeat(43)}` })).code, 'UNAUTHORIZED', 'duplicate cookies are ambiguous');
  });

  test('an origin that is not on DATA\'s list is refused at the transport, before any session lookup', async () => {
    const { alice } = await stack.pair();
    for (const origin of [null, 'http://evil.example', 'null', 'http://localhost:3001']) {
      const failure = await stack.connectError(alice, { origin });
      assert.equal(failure.code, undefined, `origin ${String(origin)} must not reach the namespace middleware`);
    }
    assert.equal((await stack.connect(alice, { origin: 'http://localhost:3000' })).connected, true);
  });

  test('the CSRF proof is mandatory and must belong to THIS session: missing, forged, pre-login and foreign tokens fail', async () => {
    const { alice, bob } = await stack.pair();
    assert.equal((await stack.connectError(alice, { csrf: null })).code, 'UNAUTHORIZED', 'no auth object');
    assert.equal((await stack.connectError(alice, { auth: {} })).code, 'UNAUTHORIZED', 'empty auth object');
    assert.equal((await stack.connectError(alice, { csrf: 'A'.repeat(43) })).code, 'UNAUTHORIZED', 'well-formed but wrong');
    assert.equal((await stack.connectError(alice, { csrf: 'short' })).code, 'UNAUTHORIZED', 'malformed');
    // A token minted before login belongs to the pre-authentication challenge, not the session.
    const anonymous = new Browser(stack.url);
    const preLogin = await anonymous.csrf();
    assert.equal((await stack.connectError(alice, { csrf: preLogin })).code, 'UNAUTHORIZED');
    assert.equal((await stack.connectError(alice, { csrf: bob.browser.token })).code, 'UNAUTHORIZED', 'another account\'s token');
    assert.equal((await stack.connect(alice, { csrf: alice.browser.token })).connected, true);
  });

  test('a CSRF token cannot be paired with another account\'s session cookie', async () => {
    const { alice, bob } = await stack.pair();
    const bobCookie = `${SESSION_COOKIE}=${bob.browser.cookies.get(SESSION_COOKIE)}`;
    assert.equal((await stack.connectError(alice, { cookie: bobCookie, csrf: alice.browser.token })).code, 'UNAUTHORIZED');
  });

  test('extra handshake auth keys, client-supplied identities and query strings are never honoured', async () => {
    const { alice, bob, conversationId, epoch } = await stack.pair();
    const base = { csrfToken: alice.browser.token };
    for (const extra of [{ userId: bob.id }, { sessionId: 'x' }, { token: 'x' }, { displayName: 'Bob' }, { userId: 'local-user' }, { userId: 'demo-user' }]) {
      assert.equal((await stack.connectError(alice, { auth: { ...base, ...extra } })).code, 'UNAUTHORIZED', JSON.stringify(Object.keys(extra)));
    }
    assert.equal((await stack.connectError(alice, { auth: { userId: 'local-user' }, cookie: null })).code, 'AUTH_REQUIRED', 'a demo identity cannot replace a session');
    // A query string naming another account changes nothing: the socket is still Eve and sees nothing of Alice's conversation.
    const eve = await stack.person('eve', 'Eve');
    const eveSocket = await stack.connect(eve, { query: { userId: alice.id, conversationId } });
    const aliceSocket = await stack.connect(alice);
    await stack.send(aliceSocket, await stack.envelope(alice, conversationId, epoch, 'not for eve', 'q-1'));
    await eveSocket.expectNone('message:new');
  });

  test('an expired DATA session is rejected with SESSION_EXPIRED', async () => {
    const { alice } = await stack.pair();
    clock.skewMs = 9 * 3_600_000;
    try {
      assert.equal((await stack.connectError(alice)).code, 'SESSION_EXPIRED');
    } finally {
      clock.skewMs = 0;
    }
    assert.equal((await stack.connect(alice)).connected, true);
  });

  test('logout through DATA ends the account\'s sockets immediately and blocks any reconnect', async () => {
    const { alice, bob } = await stack.pair();
    const first = await stack.connect(alice);
    const second = await stack.connect(alice);
    const bobSocket = await stack.connect(bob);
    const oldCookie = alice.browser.cookies.get(SESSION_COOKIE)!;
    const oldCsrf = alice.browser.token;
    const closing = Promise.all([first.waitForDisconnect(3_000), second.waitForDisconnect(3_000)]);
    assert.equal((await alice.browser.mutate('POST', '/api/auth/logout')).status, 204);
    assert.deepEqual(await closing, ['io server disconnect', 'io server disconnect']);
    assert.equal((await stack.connectError(alice, { cookie: `${SESSION_COOKIE}=${oldCookie}`, csrf: oldCsrf })).code, 'UNAUTHORIZED');
    // Bob still works and receives nothing from the closed session.
    assert.equal(bobSocket.connected, true);
  });

  test('account switching on one browser: the new login gets its own identity, never the old one', async () => {
    const { alice, bob } = await stack.pair();
    const aliceSocket = await stack.connect(alice);
    assert.equal((await alice.browser.mutate('POST', '/api/auth/logout')).status, 204);
    await aliceSocket.waitForDisconnect(3_000);
    // The same browser jar now logs in as Bob.
    const login = await alice.browser.request('/api/auth/login', { method: 'POST', headers: { 'X-CSRF-Token': await alice.browser.csrf() },
      body: { identifier: bob.username, password: 'Synthetic passphrase for e2ee tests 2026!' } });
    assert.equal(login.status, 200);
    await alice.browser.csrf();
    assert.equal(login.body.user.id, bob.id);
    const asBob = await stack.connect(alice);
    const mark = asBob.mark();
    assert.equal(asBob.connected, true);
    assert.equal(asBob.received.length, mark);
  });

  test('without the HTTP observer DATA still refuses a revoked session on the very next send (policy_denied) and the socket is closed', async () => {
    const { alice, bob, conversationId, epoch } = await bare.pair();
    const aliceSocket = await bare.connect(alice);
    const bobSocket = await bare.connect(bob);
    assert.equal((await alice.browser.mutate('POST', '/api/auth/logout')).status, 204);
    assert.equal(aliceSocket.connected, true, 'nothing told the realtime server about the logout');
    const ack = await bare.send(aliceSocket, await bare.envelope(alice, conversationId, epoch, 'after logout', 'late-1'));
    assert.deepEqual(ack, { status: 'error', code: 'policy_denied' });
    assert.equal(await bare.closed(aliceSocket), 'io server disconnect');
    await bobSocket.expectNone('message:new');
    assert.deepEqual((await bare.history(bob, conversationId)).items, []);
  });

  test('without the HTTP observer the periodic session check closes a revoked socket', async () => {
    const { alice } = await sweeping.pair();
    const socket = await sweeping.connect(alice);
    assert.equal((await alice.browser.mutate('POST', '/api/auth/logout')).status, 204);
    assert.equal(await sweeping.closed(socket), 'io server disconnect');
  });

  test('a session that expires while connected is closed by the periodic check', async () => {
    const skewed = { ms: 0 };
    const local = await DataStack.start({ dependencies: { now: () => Date.now() + skewed.ms }, bridge: { observeChanges: false, timing: { revalidationIntervalMs: 120 } } });
    try {
      const { alice } = await local.pair();
      const socket = await local.connect(alice);
      skewed.ms = 9 * 3_600_000;
      assert.equal(await local.closed(socket), 'io server disconnect');
      assert.equal((await local.connectError(alice)).code, 'SESSION_EXPIRED');
    } finally {
      await local.close();
    }
  });

  test('transport security mirrors DATA: direct TLS, an exactly trusted proxy with https, or the explicit loopback opt-in', () => {
    const production = transportSecurityFor({ allowHttpLocal: false, trustedProxyIps: ['10.0.0.7'] });
    const evidence = (remoteAddress: string, encrypted: boolean, forwardedProto: string | null) => ({ remoteAddress, encrypted, forwardedProto });
    assert.equal(production(evidence('203.0.113.9', true, null)), true);
    assert.equal(production(evidence('203.0.113.9', false, 'https')), false, 'forwarded headers from an untrusted peer are ignored');
    assert.equal(production(evidence('10.0.0.7', false, 'https')), true);
    assert.equal(production(evidence('::ffff:10.0.0.7', false, 'https')), true);
    assert.equal(production(evidence('10.0.0.7', false, 'http')), false);
    assert.equal(production(evidence('10.0.0.7', false, null)), false);
    assert.equal(production(evidence('127.0.0.1', false, null)), false, 'loopback is not secure without the opt-in');
    const local = transportSecurityFor({ allowHttpLocal: true, trustedProxyIps: [] });
    assert.equal(local(evidence('127.0.0.1', false, null)), true);
    assert.equal(local(evidence('::1', false, null)), true);
    assert.equal(local(evidence('192.168.1.5', false, null)), false);
  });

  test('connection errors are generic: no session, token or account detail leaks', async () => {
    const { alice } = await stack.pair();
    const failure = await stack.connectError(alice, { csrf: 'A'.repeat(43) });
    assert.doesNotMatch(failure.message, new RegExp(`${alice.id}|csrf|token|${SESSION_COOKIE}`, 'i'));
    assert.doesNotMatch(stack.logger.text(), new RegExp(alice.browser.cookies.get(SESSION_COOKIE)!));
    assert.doesNotMatch(stack.logger.text(), new RegExp(alice.browser.token));
  });
});
