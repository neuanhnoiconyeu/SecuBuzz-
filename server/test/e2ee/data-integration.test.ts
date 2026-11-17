/**
 * Cross-owner seam test against the REAL, unmodified DATA application over REST: real DB-2 accounts
 * (Argon2, cookies, CSRF), DB-3 friendship, DB-4A DM, the DB-7 key directory and the DB-4B shared
 * write pipeline, loaded through DATA's own CommonJS `require`. DATA's normal composition installs
 * Kiro's verifier (`keys.verifier`) itself; the spy below only records what DATA hands to it.
 * Sockets are covered by `test/data/`.
 */
import assert from 'node:assert/strict';
import { randomUUID, type webcrypto } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { envelopeV2Fingerprint } from '../../src/e2ee/envelope.ts';
import { createDataFixture, type DataAccount, type DataFixture, type StartedData } from './support/dataApp.ts';
import { TestDevice, type EnvelopeV2Like } from './support/deviceClient.ts';

type CryptoKey = webcrypto.CryptoKey;

interface ClientCrypto {
  generateEncryptionKey(): Promise<CryptoKey>;
  encryptMessage(plaintext: string, key: CryptoKey, context: Record<string, string>): Promise<Record<string, unknown>>;
}

interface Call {
  readonly actor: Record<string, unknown>;
  readonly envelope: Record<string, unknown>;
  readonly context: Record<string, unknown>;
}

let fixture: DataFixture;
/** DATA composed on purpose WITHOUT a verifier. */
let unverified: StartedData;
/** DATA's normal composition, with a spy in front of its own verifier. */
let verified: StartedData;
/** Same database, DATA's clock nine hours ahead: every session is expired. */
let future: StartedData;
let alice: DataAccount;
let bob: DataAccount;
let carol: DataAccount;
let conversationId: string;
let clientCrypto: ClientCrypto;
let epoch: { keyId: string; key: CryptoKey };
let aliceDevice: TestDevice;
let bobDevice: TestDevice;
const calls: Call[] = [];
/** Every plaintext used, each with a unique marker, for the storage scan. */
const plaintexts: string[] = [];
let sequence = 0;

function marked(label: string): string {
  const text = `${label} ${randomUUID()}`;
  plaintexts.push(text);
  return text;
}

/** DATA's legacy v1 wire envelope, encrypted with the unchanged client crypto module. */
async function v1Envelope(sender: DataAccount, label: string): Promise<Record<string, unknown>> {
  const text = marked(label);
  sequence += 1;
  const id = `data-v1-${sequence}`;
  const timestamp = new Date().toISOString();
  const key = await clientCrypto.generateEncryptionKey();
  const encryption = await clientCrypto.encryptMessage(text, key, { conversationId, messageId: id, senderId: sender.id, senderName: sender.displayName, timestamp });
  return { id, conversationId, senderId: sender.id, senderName: sender.displayName, timestamp, type: 'text', encryption };
}

async function v2Envelope(label: string): Promise<EnvelopeV2Like> {
  sequence += 1;
  return aliceDevice.encrypt(epoch.key, epoch.keyId, { conversationId, id: `data-v2-${sequence}`, senderName: alice.displayName }, marked(label));
}

async function submit(account: DataAccount, url: string, envelope: unknown, target = conversationId) {
  account.browser.base = url;
  return account.browser.mutate('POST', `/api/conversations/${target}/messages`, envelope);
}

async function history(account: DataAccount, url: string) {
  account.browser.base = url;
  return account.browser.request(`/api/conversations/${conversationId}/messages`);
}

describe('DATA DB-4B pipeline with the Kiro recipient-key verifier', () => {
  before(async () => {
    clientCrypto = await tsImport('../../../client/src/utils/crypto.ts', import.meta.url) as unknown as ClientCrypto;
    let real: { verifyEnvelope(...args: unknown[]): Promise<unknown> };
    const spy = { async verifyEnvelope(actor: Record<string, unknown>, envelope: Record<string, unknown>, context: Record<string, unknown>) {
      calls.push({ actor, envelope, context });
      return real.verifyEnvelope(actor, envelope, context);
    } };
    fixture = await createDataFixture();
    unverified = await fixture.start({ recipientKeyVerifier: null });
    verified = await fixture.start({ recipientKeyVerifier: spy });
    real = verified.application.keys.verifier;
    future = await fixture.start({ recipientKeyVerifier: spy }, { now: () => Date.now() + 9 * 3_600_000 });
    alice = await fixture.register('e2ee-alice', 'Alice', verified.url);
    bob = await fixture.register('e2ee-bob', 'Bob', verified.url);
    carol = await fixture.register('e2ee-carol', 'Carol', verified.url);
    const request = await alice.browser.mutate('POST', '/api/friends/requests', { userId: bob.id });
    assert.equal(request.status, 201);
    assert.equal((await bob.browser.mutate('POST', `/api/friends/requests/${request.body.request.id}/accept`)).status, 200);
    const dm = await alice.browser.mutate('POST', '/api/conversations/dm', { recipientId: bob.id });
    assert.equal(dm.status, 201);
    conversationId = dm.body.conversation.id;

    // Real key state: signed devices and a signed epoch, published through DATA's own API.
    aliceDevice = await TestDevice.create(alice.id);
    bobDevice = await TestDevice.create(bob.id);
    assert.equal((await alice.browser.mutate('POST', '/api/keys/devices', await aliceDevice.registration())).status, 201);
    assert.equal((await bob.browser.mutate('POST', '/api/keys/devices', await bobDevice.registration())).status, 201);
    const state = await alice.browser.request(`/api/conversations/${conversationId}/keys`);
    const created = await aliceDevice.createEpoch({ conversationId, epoch: 1, previousKeyId: null, devices: state.body.devices });
    assert.equal((await alice.browser.mutate('POST', `/api/conversations/${conversationId}/keys/epochs`, created.body)).status, 201);
    epoch = { keyId: created.body.keyId, key: created.key };
  });
  after(async () => {
    await fixture?.close();
  });

  test('a DATA composed without a verifier keeps returning 503 RECIPIENT_KEYS_UNAVAILABLE and stores nothing', async () => {
    const response = await submit(alice, unverified.url, await v1Envelope(alice, 'no verifier configured'));
    assert.deepEqual([response.status, response.body.code], [503, 'RECIPIENT_KEYS_UNAVAILABLE']);
    const v2 = await submit(alice, unverified.url, await v2Envelope('no verifier, v2'));
    assert.deepEqual([v2.status, v2.body.code], [503, 'RECIPIENT_KEYS_UNAVAILABLE']);
    assert.deepEqual((await history(alice, verified.url)).body.items, []);
  });

  test('a version-1 envelope is refused (403) after DATA authenticated the real actor and supplied the real context', async () => {
    const before = calls.length;
    const envelope = await v1Envelope(alice, 'v1 cannot bind a key');
    const response = await submit(alice, verified.url, envelope);
    assert.deepEqual([response.status, response.body.code], [403, 'RECIPIENT_KEYS_UNVERIFIED']);
    assert.equal(calls.length, before + 1);
    const call = calls.at(-1)!;
    assert.equal(call.actor.userId, alice.id, 'actor comes from the DB-2 session');
    assert.equal(call.actor.displayName, 'Alice');
    assert.match(String(call.actor.sessionId), /^[0-9a-f-]{36}$/, 'internal session UUID, never the cookie');
    assert.ok(!Object.values(call.actor).includes(alice.browser.cookies.get(fixture.config.sessionCookie)));
    assert.deepEqual(call.context.conversationId, conversationId);
    assert.deepEqual(call.context.recipientIds, [bob.id], 'DATA supplies the authoritative recipient');
    assert.match(String(call.context.fingerprint), /^[a-f0-9]{64}$/);
    assert.deepEqual((await history(alice, verified.url)).body.items, []);
  });

  test('a valid version-2 envelope is verified by Kiro for DATA\'s actor and context, then stored by DATA and returned unchanged', async () => {
    const envelope = await v2Envelope('v2 binds the epoch key');
    const before = calls.length;
    const response = await submit(alice, verified.url, envelope);
    assert.deepEqual([response.status, response.body.outcome], [201, 'created']);
    assert.equal(calls.length, before + 1);
    const call = calls.at(-1)!;
    assert.equal(call.actor.userId, alice.id);
    assert.deepEqual(call.context.recipientIds, [bob.id]);
    assert.equal(call.context.fingerprint, envelopeV2Fingerprint(envelope as never), 'DATA fingerprints with Kiro\'s own v2 function');
    const stored = (await history(bob, verified.url)).body.items;
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].encryption, envelope.encryption, 'ciphertext, IV and keyId are stored and returned exactly as sent');
    const bobKey = await bobDevice.openEpoch((await bob.browser.request(`/api/conversations/${conversationId}/keys/epochs/${epoch.keyId}`)).body.epoch,
      (await bob.browser.request(`/api/conversations/${conversationId}/keys`)).body.devices);
    assert.match(await TestDevice.decrypt(bobKey, stored[0]), /^v2 binds the epoch key /);
    // Idempotent retry: same bytes, same outcome, nothing new stored.
    const retry = await submit(alice, verified.url, envelope);
    assert.deepEqual([retry.status, retry.body.outcome], [200, 'duplicate']);
    assert.equal((await history(bob, verified.url)).body.items.length, 1);
  });

  test('DATA authorization runs before verification: blocked, unrelated, unauthenticated, expired and logged-out callers never reach it', async () => {
    const before = calls.length;
    const envelope = await v1Envelope(alice, 'authorization first');
    const anonymous = { ...alice, browser: Object.assign(Object.create(Object.getPrototypeOf(alice.browser)), alice.browser, { cookies: new Map() }) };
    assert.equal((await submit(anonymous as DataAccount, verified.url, envelope)).status, 401);
    const badCsrf = await (alice.browser.base = verified.url, alice.browser.request(`/api/conversations/${conversationId}/messages`,
      { method: 'POST', body: envelope, headers: { 'X-CSRF-Token': 'A'.repeat(43) } }));
    assert.equal(badCsrf.status, 403);
    // A copy of Bob's browser: DATA clears the cookie of an expired session, and the real Bob continues below.
    const laterBob = { ...bob, browser: Object.assign(Object.create(Object.getPrototypeOf(bob.browser)), bob.browser, { cookies: new Map(bob.browser.cookies) }) };
    const expired = await submit(laterBob as DataAccount, future.url, await v1Envelope(bob, 'expired session'));
    assert.deepEqual([expired.status, expired.body.code], [401, 'SESSION_EXPIRED']);
    assert.equal((await submit(carol, verified.url, { ...(await v1Envelope(carol, 'not a participant')) })).status, 404);
    bob.browser.base = verified.url;
    assert.equal((await bob.browser.mutate('POST', '/api/blocks', { userId: alice.id })).status, 204);
    assert.equal((await submit(alice, verified.url, await v1Envelope(alice, 'blocked'))).status, 404);
    assert.equal((await bob.browser.mutate('DELETE', `/api/blocks/${alice.id}`)).status, 204);
    // Blocking removed the friendship; unblocking does not restore it, so interaction stays refused.
    const unfriended = await submit(alice, verified.url, await v1Envelope(alice, 'unfriended'));
    assert.deepEqual([unfriended.status, unfriended.body.code], [403, 'FORBIDDEN']);
    const stale = new Map(alice.browser.cookies);
    assert.equal((await alice.browser.mutate('POST', '/api/auth/logout')).status, 204);
    alice.browser.cookies.clear();
    for (const [name, value] of stale) alice.browser.cookies.set(name, value);
    assert.equal((await submit(alice, verified.url, envelope)).status, 401, 'a revoked session cannot submit');
    assert.equal(calls.length, before, 'the verifier was never consulted');
  });

  test('the DATA database holds no plaintext from any attempt', () => {
    const text = fixture.databaseText();
    assert.ok(plaintexts.length >= 6);
    for (const value of plaintexts) assert.ok(!text.includes(value.split(' ').at(-1) as string), value);
  });
});
