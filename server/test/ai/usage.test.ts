import './support/noNetwork.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  MemoryAiUsageStore,
  pacificDayKey,
  parseReservation,
  ProviderBreaker,
  secondsUntilNextPacificMidnight,
  type AiUsageLimits,
} from '../../src/ai/usage.ts';
import { SharedTestUsageStore, SharedUsageBackend } from './support/aiFixtures.ts';
import { usageStoreContract } from './support/usageStoreContract.ts';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));

usageStoreContract('MemoryAiUsageStore (development only)', () => new MemoryAiUsageStore());
usageStoreContract('SharedTestUsageStore (durable-semantics test double)', () => new SharedTestUsageStore());

const LIMITS: AiUsageLimits = { userPerMinute: 5, userPerDay: 2, scopePerMinute: 10, scopePerDay: 10, maxConcurrentPerScope: 5 };
const T0 = Date.parse('2026-11-09T12:00:00.000Z');
const request = (userId: string, at: number, id: string) => ({
  scope: 'default:gemini-3.5-flash-lite', userId, reservationId: id, now: new Date(at), leaseExpiresAt: new Date(at + 1), limits: LIMITS,
});

describe('Pacific day helpers', () => {
  test('use the America/Los_Angeles calendar day', () => {
    assert.equal(pacificDayKey(Date.parse('2026-11-09T12:00:00Z')), '2026-11-09');
    assert.equal(pacificDayKey(Date.parse('2026-11-10T07:59:59Z')), '2026-11-09');
    assert.equal(pacificDayKey(Date.parse('2026-11-10T08:00:00Z')), '2026-11-10');
  });

  test('count down to the next Pacific midnight across daylight-saving changes', () => {
    assert.equal(secondsUntilNextPacificMidnight(Date.parse('2026-11-09T12:00:00Z')), 20 * 3_600);
    assert.equal(secondsUntilNextPacificMidnight(Date.parse('2026-11-10T07:59:59Z')), 1);
    // 2026-11-01 lasts 25 hours in Los Angeles; 2026-03-08 lasts 23 hours.
    assert.equal(secondsUntilNextPacificMidnight(Date.parse('2026-11-01T07:00:00Z')), 25 * 3_600);
    assert.equal(secondsUntilNextPacificMidnight(Date.parse('2026-03-08T08:00:00Z')), 23 * 3_600);
  });
});

describe('usage store results and lifecycle', () => {
  test('store results are validated strictly', () => {
    assert.deepEqual(parseReservation({ status: 'reserved' }), { status: 'reserved' });
    assert.deepEqual(parseReservation({ status: 'user_day', retryAfterSeconds: 60 }), { status: 'user_day', retryAfterSeconds: 60 });
    for (const value of [null, {}, { status: 'ok' }, { status: 'user_minute' }, { status: 'user_minute', retryAfterSeconds: 0 },
      { status: 'scope_day', retryAfterSeconds: 1.5 }, { status: 'user_minute', retryAfterSeconds: 'soon' }, 'reserved']) {
      assert.equal(parseReservation(value), null, JSON.stringify(value));
    }
  });

  test('the memory store forgets everything on restart, which is why production refuses it', async () => {
    const first = new MemoryAiUsageStore();
    assert.equal((await first.reserve(request('u1', T0, 'a'))).status, 'reserved');
    assert.equal((await first.reserve(request('u1', T0 + 1_000, 'b'))).status, 'reserved');
    assert.equal((await first.reserve(request('u1', T0 + 2_000, 'c'))).status, 'user_day');
    const restarted = new MemoryAiUsageStore();
    assert.equal((await restarted.reserve(request('u1', T0 + 3_000, 'd'))).status, 'reserved');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const { MemoryAiUsageStore } = await import('./src/ai/usage.ts'); new MemoryAiUsageStore();"], {
      cwd: serverRoot, env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local development only/);
  });

  test('a shared durable store keeps counts across restarts and is shared by workers', async () => {
    const backend = new SharedUsageBackend();
    const workerA = new SharedTestUsageStore(backend);
    const workerB = new SharedTestUsageStore(backend);
    assert.equal((await workerA.reserve(request('u1', T0, 'a'))).status, 'reserved');
    assert.equal((await workerB.reserve(request('u1', T0 + 1_000, 'b'))).status, 'reserved');
    assert.equal((await workerA.reserve(request('u1', T0 + 2_000, 'c'))).status, 'user_day');
    const restarted = new SharedTestUsageStore(backend);
    assert.equal((await restarted.reserve(request('u1', T0 + 3_000, 'd'))).status, 'user_day');
    assert.equal(await workerA.consumeConsentNonce('s', 'n', new Date(T0 + 60_000), new Date(T0)), true);
    assert.equal(await workerB.consumeConsentNonce('s', 'n', new Date(T0 + 60_000), new Date(T0)), false);
  });

  test('the memory store bounds its own state', async () => {
    const store = new MemoryAiUsageStore();
    for (let index = 0; index < 200; index += 1) {
      await store.reserve({ ...request(`user-${index}`, T0 + index * 61_000, `r-${index}`), limits: { ...LIMITS, userPerDay: 10, scopePerDay: 1_000, scopePerMinute: 1_000 } });
    }
    assert.equal(store.activeLeases(T0 + 200 * 61_000), 0);
  });
});

describe('provider breaker', () => {
  test('stays closed until opened, then reports the remaining time', () => {
    const breaker = new ProviderBreaker();
    assert.deepEqual(breaker.state(T0), { open: false });
    breaker.open('AI_RATE_LIMITED', T0, 30);
    assert.deepEqual(breaker.state(T0 + 10_000), { open: true, code: 'AI_RATE_LIMITED', retryAfterSeconds: 20 });
    assert.deepEqual(breaker.state(T0 + 30_000), { open: false });
  });

  test('keeps the longest outage and never shortens it', () => {
    const breaker = new ProviderBreaker();
    breaker.open('AI_DAILY_QUOTA_EXHAUSTED', T0, 3_600);
    breaker.open('AI_RATE_LIMITED', T0, 30);
    assert.deepEqual(breaker.state(T0 + 60_000), { open: true, code: 'AI_DAILY_QUOTA_EXHAUSTED', retryAfterSeconds: 3_540 });
  });
});
