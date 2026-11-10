import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../src/realtime/protocol.ts';
import { delay, eventually, startTestServer, type HarnessOptions, type TestServer } from '../support/harness.ts';

let server: TestServer;

async function setup(options: HarnessOptions = {}) {
  server = await startTestServer(options);
  const alice = server.addUser('alice');
  const bob = server.addUser('bob');
  const carol = server.addUser('carol');
  server.authorizer.befriend('alice', 'bob');
  return { alice, bob, carol };
}

const about = (userId: string) => (payload: { userId: string }) => payload.userId === userId;

describe('presence', () => {
  afterEach(async () => {
    await server.close();
  });

  test('emits an authorized snapshot on subscribe and offline after the last connection closes', async () => {
    const { alice, bob } = await setup();
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    const before = Date.now();
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    const snapshot = await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'));
    assert.deepEqual(Object.keys(snapshot).sort(), ['status', 'timestamp', 'userId']);
    assert.equal(snapshot.status, 'online');
    assert.ok(Math.abs(Date.parse(snapshot.timestamp) - before) < 2_000);
    a.close();
    const offline = await b.waitFor(SERVER_EVENTS.presenceUpdate, (payload) => payload.userId === 'alice' && payload.status === 'offline');
    assert.ok(Date.parse(offline.timestamp) > Date.parse(snapshot.timestamp));
  });

  test('reports an offline friend as offline and announces when they connect', async () => {
    const { alice, bob } = await setup();
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    assert.equal((await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'))).status, 'offline');
    await server.connect(alice);
    await b.waitFor(SERVER_EVENTS.presenceUpdate, (payload) => payload.userId === 'alice' && payload.status === 'online');
  });

  test('keeps a user online while another of their connections remains', async () => {
    const { alice, bob } = await setup();
    const a1 = await server.connect(alice);
    const a2 = await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'));
    const mark = b.mark();
    a1.close();
    await b.expectNone(SERVER_EVENTS.presenceUpdate, (payload) => payload.status === 'offline', { since: mark, ms: 200 });
    a2.close();
    await b.waitFor(SERVER_EVENTS.presenceUpdate, (payload) => payload.status === 'offline', { since: mark });
  });

  test('filters subscriptions through the authorizer and never reveals unauthorized presence', async () => {
    const { alice, bob, carol } = await setup();
    await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice', 'carol', 'bob', 'alice'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'));
    assert.deepEqual(server.authorizer.presenceCalls.at(-1), { viewer: 'bob', subjects: ['alice', 'carol'] }, 'self and duplicates removed');
    const c = await server.connect(carol);
    c.close();
    await b.expectNone(SERVER_EVENTS.presenceUpdate, about('carol'), { ms: 200 });
    await b.expectNone(SERVER_EVENTS.presenceUpdate, about('bob'), { ms: 0 });
  });

  test('ignores extra subjects an authorizer returns that were not requested', async () => {
    const { alice, bob } = await setup();
    server.authorizer.befriend('bob', 'carol');
    await server.connect(alice);
    const b = await server.connect(bob);
    const original = server.authorizer.filterPresenceSubjects.bind(server.authorizer);
    server.authorizer.filterPresenceSubjects = async (viewer, subjects) => [...(await original(viewer, subjects)), 'carol'];
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'));
    await b.expectNone(SERVER_EVENTS.presenceUpdate, about('carol'));
  });

  test('authorizes nothing when the presence filter fails, hangs or returns malformed data', async () => {
    const { alice, bob } = await setup();
    await server.connect(alice);
    const b = await server.connect(bob);
    for (const mode of ['throw', 'malformed', 'hang'] as const) {
      server.authorizer.presenceMode = mode;
      b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
      await b.expectNone(SERVER_EVENTS.presenceUpdate, () => true, { ms: mode === 'hang' ? 450 : 120 });
    }
    assert.ok(server.logger.has('realtime.presence.filter_failed'));
    assert.equal(server.handle.getStats().presenceSubscriptions, 0);
  });

  test('blocked users never observe each other; an unblock needs both sides refreshed; a new block emits unknown once', async () => {
    const { alice, bob } = await setup();
    server.authorizer.block('alice', 'bob');
    await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.expectNone(SERVER_EVENTS.presenceUpdate);

    server.authorizer.unblock('alice', 'bob');
    await server.handle.refreshUserAccess('alice');
    // Bob's own (stale) block entry still applies: an unblock fails closed until both sides refresh.
    await b.expectNone(SERVER_EVENTS.presenceUpdate, about('alice'), { ms: 100 });
    await server.handle.refreshUserAccess('bob');
    assert.equal((await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'))).status, 'online');

    server.authorizer.block('alice', 'bob');
    const mark = b.mark();
    await server.handle.refreshUserAccess('alice');
    assert.equal((await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'), { since: mark })).status, 'unknown');
    const afterUnknown = b.mark();
    server.handle.setPresencePreference('alice', 'busy');
    await b.expectNone(SERVER_EVENTS.presenceUpdate, about('alice'), { since: afterUnknown });
  });

  test('an unfriended subject becomes unknown after a relationship refresh', async () => {
    const { alice, bob } = await setup();
    await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'));
    server.authorizer.unfriend('alice', 'bob');
    const mark = b.mark();
    await server.handle.refreshUserAccess('bob');
    assert.equal((await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'), { since: mark })).status, 'unknown');
    assert.equal(server.handle.getStats().presenceSubscriptions, 0);
  });

  test('re-emits current presence on the refresh interval with strictly increasing timestamps', async () => {
    const { alice, bob } = await setup({ timing: { presenceRefreshIntervalMs: 60 } });
    await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await eventually(() => b.events(SERVER_EVENTS.presenceUpdate).length >= 4, 2_000, 'refreshes');
    const samples = b.events(SERVER_EVENTS.presenceUpdate) as Array<{ status: string; timestamp: string }>;
    assert.ok(samples.every((sample) => sample.status === 'online'));
    for (let index = 1; index < samples.length; index += 1) {
      assert.ok(Date.parse(samples[index]!.timestamp) > Date.parse(samples[index - 1]!.timestamp));
    }
  });

  test('replacing the scope stops updates for dropped subjects without announcing them', async () => {
    const { alice, bob, carol } = await setup();
    server.authorizer.befriend('bob', 'carol');
    const a = await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'));
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['carol'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('carol'));
    const mark = b.mark();
    a.close();
    await b.expectNone(SERVER_EVENTS.presenceUpdate, about('alice'), { since: mark, ms: 200 });
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: [] });
    await delay(50);
    assert.equal(server.handle.getStats().presenceSubscriptions, 0);
    await server.connect(carol);
    await b.expectNone(SERVER_EVENTS.presenceUpdate, about('carol'), { since: mark + 1, ms: 150 });
  });

  test('applies server-side presence preferences, with invisible shown as offline', async () => {
    const { alice, bob } = await setup();
    await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'));
    for (const [preference, status] of [['away', 'away'], ['busy', 'busy'], ['invisible', 'offline'], ['available', 'online']] as const) {
      const mark = b.mark();
      server.handle.setPresencePreference('alice', preference);
      assert.equal((await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'), { since: mark })).status, status, preference);
    }
    assert.throws(() => server.handle.setPresencePreference('alice', 'hidden' as never), TypeError);
  });

  test('rejects oversized subscription requests and cleans up subscriptions on disconnect', async () => {
    const { alice, bob } = await setup();
    await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: Array.from({ length: 1_001 }, (_, index) => `user-${index}`) });
    await b.expectNone(SERVER_EVENTS.presenceUpdate);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('alice'));
    assert.equal(server.handle.getStats().presenceSubscriptions, 1);
    b.close();
    await eventually(() => server.handle.getStats().presenceSubscriptions === 0, 1_000, 'subscription cleanup');
  });

  test('applies only the newest of overlapping subscription requests', async () => {
    const { alice, bob, carol } = await setup();
    server.authorizer.befriend('bob', 'carol');
    await server.connect(alice);
    await server.connect(carol);
    const b = await server.connect(bob);
    const original = server.authorizer.filterPresenceSubjects.bind(server.authorizer);
    server.authorizer.filterPresenceSubjects = async (viewer, subjects) => {
      if (subjects.includes('alice')) await delay(150);
      return original(viewer, subjects);
    };
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await delay(20);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['carol'] });
    await b.waitFor(SERVER_EVENTS.presenceUpdate, about('carol'));
    await b.expectNone(SERVER_EVENTS.presenceUpdate, about('alice'), { ms: 250 });
  });

  test('presence subscriptions are rate limited', async () => {
    const { alice, bob } = await setup({ rates: { presence: { capacity: 1, refillPerSecond: 0 } } });
    await server.connect(alice);
    const b = await server.connect(bob);
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: [] });
    b.emit(CLIENT_EVENTS.presenceSubscribe, { userIds: ['alice'] });
    await b.expectNone(SERVER_EVENTS.presenceUpdate);
  });
});
