import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { io } from 'socket.io-client';
import { tsImport } from 'tsx/esm/api';
import { CALL_CLIENT_EVENTS as C } from '../../src/calls/protocol.ts';
import { TestDirectCallResolver } from '../support/callFixtures.ts';
import { startTestServer, TEST_ORIGIN, eventually, type TestServer, type TestUser } from '../support/harness.ts';

interface Client {
  connect(): Promise<void>; dispose(): void;
  calls: { getConnectionId(): string | null; request(event: string, body: unknown): Promise<any>;
    subscribe(listener: (kind: string, body: any) => void): () => void };
}
let server: TestServer;
const clients: Client[] = [];
afterEach(async () => { clients.splice(0).forEach(client => client.dispose()); await server?.close(); });
async function setup() {
  const resolver = new TestDirectCallResolver(); resolver.add('dm-ab', 'alice', 'bob');
  server = await startTestServer({ directCalls: { conversationResolver: resolver } });
  const alice = server.addUser('alice'), bob = server.addUser('bob');
  for (const user of [alice, bob]) server.authorizer.grant(user.userId, 'dm-ab');
  const module = await tsImport('../../../client/src/realtime/SocketIoRealtimeClient.ts', import.meta.url) as {
    SocketIoRealtimeClient: new (options: Record<string, unknown>) => Client;
  };
  const create = (user: TestUser) => {
    const client = new module.SocketIoRealtimeClient({ user: { id: user.userId, username: user.userId, displayName: user.displayName, avatar: 'initials', isDemo: false },
      authMode: 'api', contractReady: true, url: server.url,
      socketFactory: (url: string, options: Record<string, unknown>) => io(url, { ...options,
        extraHeaders: { origin: TEST_ORIGIN, cookie: `secubuzz_session=${user.token}` } }) });
    clients.push(client); return client;
  };
  const a = create(alice), b = create(bob); await Promise.all([a.connect(), b.connect()]);
  return { a, b, resolver };
}
test('real frontend call channels use the existing authenticated socket for invitation, acceptance, ending and sync', async () => {
  const { a, b } = await setup(); const incoming: any[] = [];
  const unsubscribe = b.calls.subscribe((kind, payload) => { if (kind === 'state') incoming.push(payload); });
  assert.ok(a.calls.getConnectionId()); assert.notEqual(a.calls.getConnectionId(), b.calls.getConnectionId());
  const result = await a.calls.request(C.initiate, { requestId: 'real-client', conversationId: 'dm-ab', recipientId: 'bob', kind: 'video' });
  assert.equal(result.status, 'ok'); await eventually(() => incoming.length === 1);
  assert.deepEqual(incoming[0], result.call);
  assert.equal((await b.calls.request(C.accept, { callId: result.call.callId })).call.status, 'accepted');
  assert.equal((await a.calls.request(C.end, { callId: result.call.callId })).call.status, 'ended');
  assert.equal((await b.calls.request(C.sync, {})).calls[0].status, 'ended');
  unsubscribe();
});
test('disposing the real frontend socket cancels pending call acknowledgements and late authorization cannot ring the peer', async () => {
  const { a, b, resolver } = await setup(); let release!: () => void;
  resolver.beforeResolve = () => new Promise<void>(resolve => { release = resolve; });
  const incoming: unknown[] = []; b.calls.subscribe((_kind, value) => incoming.push(value));
  const pending = a.calls.request(C.initiate, { requestId: 'pending', conversationId: 'dm-ab', recipientId: 'bob', kind: 'voice' });
  const rejected = assert.rejects(pending);
  await eventually(() => Boolean(release)); a.dispose(); await rejected;
  assert.equal(a.calls.getConnectionId(), null);
  await eventually(() => server.handle.getStats().connections === 1);
  release();
  await eventually(() => server.handle.getStats().pendingAcks === 0);
  assert.deepEqual(incoming, []); assert.equal(server.handle.getStats().activeCalls, 0);
});
