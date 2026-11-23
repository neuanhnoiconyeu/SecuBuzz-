/** TEST ONLY: real isolated DATA sessions/crypto, in-memory IDB; never a live browser store. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { tsImport } from 'tsx/esm/api';
import { DataStack, ORIGIN, type Person } from '../data/support/stack.ts';
import type { EnvelopeV2Like } from '../e2ee/support/deviceClient.ts';
import type { EditProof } from '../../../shared/messageRevisions.ts';

if (process.env.NODE_ENV === 'production') throw new Error('A1 test fixtures cannot run in production.');
const requireClient = createRequire(new URL('../../../client/package.json', import.meta.url));
requireClient('fake-indexeddb/auto');

export interface A1Message extends Omit<EnvelopeV2Like, 'encryption'> {
  encryption: EnvelopeV2Like['encryption'] | null;
  storageId: string; sequence: number; revision: number;
  storedAt: string; updatedAt: string; state: 'active' | 'deleted'; deletedAt: string | null;
  edit?: { v: 1; proofs: { proof: EditProof; signer: Record<string, unknown> }[]; envelope: EnvelopeV2Like };
}
export interface A1Row { message: A1Message; text: string | null; error: string | null; errorCode?: string }
export interface A1Request { method?: string; body?: unknown }
interface ClientApi {
  actor: { id: string; username: string };
  request(path: string, options?: A1Request): Promise<unknown>;
  dispose(): void;
}
interface ClientStore {
  get<T>(kind: string, id?: string): Promise<T | undefined>;
  put<T>(kind: string, id: string, value: T): Promise<void>;
  reserveNonce(material: string, nonce: string): Promise<boolean>;
  observeRevision(storageId: string, hashes: string[], deleted?: boolean): Promise<boolean>;
}
interface SecureClient {
  api: {
    session: ClientApi;
    remove(id: string): Promise<A1Message>;
    ownDevices(): Promise<Record<string, unknown>[]>;
  };
  store: ClientStore;
  initialize(explicit?: boolean): Promise<unknown>;
  prepare(cid: string): Promise<{ key: unknown }>;
  send(cid: string, name: string, text: string, submit?: undefined, progress?: undefined, id?: string): Promise<A1Message>;
  editMessage(message: A1Message, text: string): Promise<A1Row>;
  history(cid: string): Promise<{ items: A1Row[]; nextCursor: string | null }>;
  decryptStoredMessage(message: A1Message): Promise<A1Row>;
  isCachedMessageCurrent(message: A1Message): Promise<boolean>;
  pending(cid: string): Promise<EnvelopeV2Like | null>;
  retryPending(cid: string): Promise<A1Message | null>;
  dispose(): void;
}
export interface A1Peer { person: Person; api: ClientApi; session: SecureClient; databaseName: string }
export type RequestInterceptor = (path: string, options: A1Request | undefined, next: () => Promise<unknown>) => Promise<unknown>;
interface Runtime {
  Session: new (api: ClientApi, store: ClientStore) => SecureClient;
  Store: new (account: string, name: string) => ClientStore;
  HttpAuth: new (options: { fetch: typeof fetch }) => { createSessionApi(actor: unknown): ClientApi };
  decryptV2(key: unknown, envelope: EnvelopeV2Like): Promise<string>;
  verifySignature(key: string, statement: string, signature: string): Promise<void>;
}

export const invalidProof = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'invalid_proof';
export const wireOf = (message: A1Message): EnvelopeV2Like => {
  assert.equal(message.encryption?.version, 2);
  return { id: message.id, conversationId: message.conversationId, senderId: message.senderId, senderName: message.senderName,
    timestamp: message.timestamp, type: 'text', encryption: message.encryption! };
};

export class A1ClientFixture {
  private readonly sessions: SecureClient[] = [];
  private readonly apis: ClientApi[] = [];
  readonly stack: DataStack;
  readonly runtime: Runtime;
  private constructor(stack: DataStack, runtime: Runtime) { this.stack = stack; this.runtime = runtime; }
  static async start(): Promise<A1ClientFixture> {
    const stack = await DataStack.start();
    try {
      const location = relative(tmpdir(), stack.fixture.filename);
      assert(!isAbsolute(location) && location !== '..' && !location.startsWith('../') && !location.startsWith('..\\'));
      const address = new URL(stack.url); assert.equal(address.hostname, '127.0.0.1');
      assert(!['3000', '3001', '5000'].includes(address.port), 'Fixture must not target existing services');
      const options = { parentURL: import.meta.url, tsconfig: fileURLToPath(new URL('../../../client/tsconfig.json', import.meta.url)) };
      const session = await tsImport('../../../client/src/security/e2ee/session.ts', options);
      const storage = await tsImport('../../../client/src/security/e2ee/storage.ts', options);
      const auth = await tsImport('../../../client/src/auth/httpAuthService.ts', options);
      const messages = await tsImport('../../../client/src/security/e2ee/messages.ts', options);
      const protocol = await tsImport('../../../client/src/security/e2ee/protocol.ts', options);
      return new A1ClientFixture(stack, { Session: session.SecureMessagingSession, Store: storage.BrowserKeyStore,
        HttpAuth: auth.HttpAuthService, decryptV2: messages.decryptV2, verifySignature: protocol.verifySignature } as Runtime);
    } catch (error) { await stack.close(); throw error; }
  }
  async client(person: Person, databaseName: string, enroll = false, intercept?: RequestInterceptor): Promise<A1Peer> {
    assert(databaseName.startsWith('a1-fixture-'), 'Only explicit disposable IDB names are permitted');
    const cookie = [...person.browser.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    const auth = new this.runtime.HttpAuth({ fetch: async (input, options) => {
      assert(typeof input === 'string' && input.startsWith('/api/') && !input.startsWith('//'));
      const headers = new Headers(options?.headers); headers.set('Origin', ORIGIN); headers.set('Cookie', cookie);
      return fetch(this.stack.url + input, { ...options, headers });
    } });
    const api = auth.createSessionApi((await person.browser.request('/api/auth/me')).body.user); this.apis.push(api);
    const sessionApi = intercept ? { ...api, request: (path: string, options?: A1Request) => intercept(path, options, () => api.request(path, options)) } : api;
    const session = new this.runtime.Session(sessionApi, new this.runtime.Store(person.id, databaseName));
    this.sessions.push(session); await session.initialize(enroll);
    return { person, api: sessionApi, session, databaseName };
  }
  async pair(label: string, secondSenderDevice = false) {
    const alice = await this.stack.person(label + '-a', 'Alice'), bob = await this.stack.person(label + '-b', 'Bob');
    await this.stack.befriend(alice, bob); const cid = await this.stack.openDm(alice, bob);
    const name = 'a1-fixture-' + randomUUID();
    const a = await this.client(alice, name, true), b = await this.client(bob, name, true);
    const extra = secondSenderDevice ? await this.client(alice, 'a1-fixture-' + randomUUID(), true) : undefined;
    await a.session.prepare(cid); await b.session.prepare(cid); await extra?.session.prepare(cid);
    return { a, b, extra, cid };
  }
  reopen(peer: A1Peer, intercept?: RequestInterceptor): Promise<A1Peer> { return this.client(peer.person, peer.databaseName, false, intercept); }
  replay(peer: A1Peer, cid: string, message: A1Message): Promise<A1Peer> {
    return this.reopen(peer, (path, _options, next) => path.startsWith(`/api/conversations/${cid}/messages?`)
      ? Promise.resolve({ items: [structuredClone(message)], nextCursor: null }) : next());
  }
  async close(): Promise<void> {
    for (const session of this.sessions) session.dispose();
    for (const api of this.apis) api.dispose();
    await this.stack.close();
  }
}
