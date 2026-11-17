/**
 * TEST-ONLY full stack: the real, unmodified DATA application (DB-2 accounts and sessions, DB-3
 * social graph, DB-4A conversations, DB-4B messaging, the DB-7 key directory) on an isolated temporary
 * SQLite file, the real Socket.IO realtime server mounted on DATA's own HTTP server through
 * `attachRealtimeToData`, and real `socket.io-client` sockets. Account devices are simulated with
 * `TestDevice` (real WebCrypto, HPKE and ECDSA). Nothing here touches DATA's development database.
 */
import assert from 'node:assert/strict';
import type { webcrypto } from 'node:crypto';
import { io as connectClient } from 'socket.io-client';
import { attachRealtimeToData, type DataRealtime, type DataRealtimeOptions } from '../../../src/data/index.ts';
import { Browser, createDataFixture, ORIGIN, type DataFixture, type StartedData } from '../../e2ee/support/dataApp.ts';
import { TestDevice, type EnvelopeV2Like } from '../../e2ee/support/deviceClient.ts';
import { CapturingLogger } from '../../support/fixtures.ts';
import { delay, TestClient } from '../../support/harness.ts';

type CryptoKey = webcrypto.CryptoKey;

export { delay, ORIGIN, TestClient };

/** Why each socket was closed, recorded at the moment it happened so a test never races the close. */
const closeReasons = new WeakMap<TestClient, string>();
export const SESSION_COOKIE = 'secubuzz_session';

/** Fast timings: the production defaults are covered by unit tests; here sockets must settle quickly. */
export const STACK_TIMING = Object.freeze({
  adapterTimeoutMs: 1_500,
  handshakeTimeoutMs: 3_000,
  revalidationIntervalMs: 0,
  deliveryAckTimeoutMs: 1_000,
  shutdownTimeoutMs: 500,
});

export interface Person {
  readonly username: string;
  readonly id: string;
  readonly displayName: string;
  readonly browser: Browser;
  /** The account's primary simulated device. */
  readonly device: TestDevice;
}

export interface EpochKey {
  readonly keyId: string;
  readonly epoch: number;
  readonly key: CryptoKey;
}

export interface ConnectOptions {
  readonly origin?: string | null;
  /** Overrides the Cookie header. `null` sends none. */
  readonly cookie?: string | null;
  /** Overrides the handshake `auth` object entirely. `null` sends none. */
  readonly auth?: Record<string, unknown> | null;
  /** The CSRF token placed in `auth.csrfToken`. Defaults to the person's current session token. */
  readonly csrf?: string | null;
  readonly transports?: Array<'websocket' | 'polling'>;
  readonly query?: Record<string, string>;
}

export interface StackOptions {
  readonly messageOptions?: Record<string, unknown>;
  readonly dependencies?: Record<string, unknown>;
  readonly bridge?: DataRealtimeOptions;
}

export class DataStack {
  readonly fixture: DataFixture;
  readonly data: StartedData;
  readonly bridge: DataRealtime;
  readonly logger: CapturingLogger;
  readonly clients = new Set<TestClient>();
  #counter = 0;

  private constructor(fixture: DataFixture, data: StartedData, bridge: DataRealtime, logger: CapturingLogger) {
    this.fixture = fixture;
    this.data = data;
    this.bridge = bridge;
    this.logger = logger;
  }

  static async start(options: StackOptions = {}): Promise<DataStack> {
    const fixture = await createDataFixture();
    const logger = new CapturingLogger();
    try {
      // DATA's per-source register limit (5 per hour) would cap a test run at five accounts, so the
      // limiter DATA exposes as an injectable dependency is permissive. Everything else is DATA's own code.
      const data = await fixture.start(options.messageOptions ?? {}, { limiter: { consume: () => ({ allowed: true }) }, ...options.dependencies });
      const bridge = attachRealtimeToData(data.server, data.application, {
        logger,
        ...options.bridge,
        timing: { ...STACK_TIMING, ...options.bridge?.timing },
      });
      return new DataStack(fixture, data, bridge, logger);
    } catch (error) {
      await fixture.close();
      throw error;
    }
  }

  /** DATA's base URL. The Socket.IO endpoint is on the same server. */
  get url(): string {
    return this.data.url;
  }

  /** Registers and logs in a real account and creates its simulated device (not yet registered). */
  async person(label: string, displayName: string = label): Promise<Person> {
    this.#counter += 1;
    const username = `rt-${label.toLowerCase()}-${this.#counter}`;
    const account = await this.fixture.register(username, displayName, this.url);
    return { username, id: account.id, displayName, browser: account.browser, device: await TestDevice.create(account.id) };
  }

  async befriend(first: Person, second: Person): Promise<void> {
    const sent = await first.browser.mutate('POST', '/api/friends/requests', { userId: second.id });
    assert.equal(sent.status, 201);
    assert.equal((await second.browser.mutate('POST', `/api/friends/requests/${sent.body.request.id}/accept`)).status, 200);
  }

  async openDm(from: Person, to: Person): Promise<string> {
    const dm = await from.browser.mutate('POST', '/api/conversations/dm', { recipientId: to.id });
    assert.ok([200, 201].includes(dm.status), `dm ${dm.status}`);
    return dm.body.conversation.id as string;
  }

  async registerDevice(person: Person, device: TestDevice = person.device): Promise<void> {
    const response = await person.browser.mutate('POST', '/api/keys/devices', await device.registration());
    assert.equal(response.status, 201, `register device: ${JSON.stringify(response.body)}`);
  }

  async revokeDevice(person: Person, device: TestDevice): Promise<void> {
    const response = await person.browser.mutate('POST', `/api/keys/devices/${device.deviceId}/revoke`);
    assert.equal(response.status, 200, `revoke device: ${JSON.stringify(response.body)}`);
  }

  /** Publishes the next epoch for `conversationId` through DATA's real API, signed by `author`'s device. */
  async publishEpoch(author: Person, conversationId: string, previous: { keyId: string; epoch: number } | null = null, device: TestDevice = author.device): Promise<EpochKey> {
    const state = await author.browser.request(`/api/conversations/${conversationId}/keys`);
    assert.equal(state.status, 200);
    const created = await device.createEpoch({ conversationId, epoch: (previous?.epoch ?? 0) + 1, previousKeyId: previous?.keyId ?? null, devices: state.body.devices });
    const published = await author.browser.mutate('POST', `/api/conversations/${conversationId}/keys/epochs`, created.body);
    assert.equal(published.status, 201, `publish epoch: ${JSON.stringify(published.body)}`);
    return { keyId: created.body.keyId, epoch: created.body.epoch, key: created.key };
  }

  /** The epoch key `person`'s device unwraps from DATA's current epoch, verified as a real client does. */
  async currentKey(person: Person, conversationId: string, device: TestDevice = person.device): Promise<EpochKey> {
    const state = await person.browser.request(`/api/conversations/${conversationId}/keys`);
    assert.equal(state.status, 200);
    const current = state.body.currentEpoch as { keyId: string; epoch: number } | null;
    assert.ok(current, 'the conversation has a current epoch');
    const record = await person.browser.request(`/api/conversations/${conversationId}/keys/epochs/${current.keyId}`);
    assert.equal(record.status, 200);
    return { keyId: current.keyId, epoch: current.epoch, key: await device.openEpoch(record.body.epoch, state.body.devices) };
  }

  /** The common setup: two friends with one DM, one device each, and epoch 1 published. */
  async pair(firstLabel = 'alice', secondLabel = 'bob'): Promise<{ alice: Person; bob: Person; conversationId: string; epoch: EpochKey; bobKey: EpochKey }> {
    const alice = await this.person(firstLabel, 'Alice');
    const bob = await this.person(secondLabel, 'Bob');
    await this.befriend(alice, bob);
    const conversationId = await this.openDm(alice, bob);
    await this.registerDevice(alice);
    await this.registerDevice(bob);
    const epoch = await this.publishEpoch(alice, conversationId);
    return { alice, bob, conversationId, epoch, bobKey: await this.currentKey(bob, conversationId) };
  }

  async envelope(sender: Person, conversationId: string, epoch: EpochKey, plaintext: string, id: string = `msg-${++this.#counter}`, device: TestDevice = sender.device): Promise<EnvelopeV2Like> {
    return device.encrypt(epoch.key, epoch.keyId, { conversationId, id, senderName: sender.displayName }, plaintext);
  }

  async history(person: Person, conversationId: string, query = ''): Promise<any> {
    const response = await person.browser.request(`/api/conversations/${conversationId}/messages${query}`);
    assert.equal(response.status, 200, `history: ${JSON.stringify(response.body)}`);
    return response.body;
  }

  #socket(person: Person, options: ConnectOptions) {
    const headers: Record<string, string> = {};
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers.origin = origin;
    const sessionToken = person.browser.cookies.get(SESSION_COOKIE);
    const cookie = options.cookie !== undefined ? options.cookie : sessionToken ? `${SESSION_COOKIE}=${sessionToken}` : null;
    if (cookie !== null) headers.cookie = cookie;
    const csrf = options.csrf === undefined ? person.browser.token : options.csrf;
    const auth = options.auth !== undefined ? options.auth : csrf === null ? null : { csrfToken: csrf };
    return connectClient(this.url, {
      path: '/socket.io',
      transports: options.transports ?? ['websocket'],
      forceNew: true,
      multiplex: false,
      reconnection: false,
      timeout: 5_000,
      extraHeaders: headers,
      ...(auth ? { auth } : {}),
      ...(options.query ? { query: options.query } : {}),
    });
  }

  /** Connects a real socket as `person`; rejects with `{ code }` from the server's connect error. */
  connect(person: Person, options: ConnectOptions = {}): Promise<TestClient> {
    const socket = this.#socket(person, options);
    const client = new TestClient(socket);
    socket.on('disconnect', (reason: string) => closeReasons.set(client, reason));
    this.clients.add(client);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => {
        socket.off('connect_error');
        resolve(client);
      });
      socket.once('connect_error', (error: Error & { data?: { code?: unknown } }) => {
        socket.disconnect();
        reject(Object.assign(new Error(error.message), { data: error.data, code: error.data?.code }));
      });
    });
  }

  async connectError(person: Person, options: ConnectOptions = {}): Promise<{ code: unknown; message: string }> {
    try {
      (await this.connect(person, options)).close();
    } catch (error) {
      const failure = error as Error & { code?: unknown };
      return { code: failure.code, message: failure.message };
    }
    throw new Error('Expected the connection to be rejected.');
  }

  /** Resolves with the reason the socket was closed, whether that already happened or happens later. */
  async closed(client: TestClient, timeoutMs = 3_000): Promise<string> {
    await until(() => closeReasons.has(client), timeoutMs, 'the socket to close');
    return closeReasons.get(client)!;
  }

  /** Sends `message:send` and returns the acknowledgement. */
  send(client: TestClient, envelope: unknown, timeoutMs = 5_000): Promise<any> {
    return client.emitAck('message:send', envelope, timeoutMs);
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.close();
    await this.bridge.close();
    await this.fixture.close();
  }
}

/** Polls `predicate` until it holds. */
export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000, message = 'condition'): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${message}`);
    await delay(15);
  }
}
