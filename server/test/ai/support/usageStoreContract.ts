/**
 * Reusable `AiUsageStore` contract tests. The Database Team can run them against a durable store:
 *
 *   usageStoreContract('sqlite', () => new SqliteAiUsageStore(...));
 *
 * Limits here are test values, not Google quotas.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AiReservation, AiUsageLimits, AiUsageStore } from '../../../src/ai/usage.ts';

const LIMITS: AiUsageLimits = Object.freeze({ userPerMinute: 2, userPerDay: 3, scopePerMinute: 4, scopePerDay: 6, maxConcurrentPerScope: 2 });
/** 04:00 Pacific Standard Time on 2026-11-09. */
const T0 = Date.parse('2026-11-09T12:00:00.000Z');
const MINUTE = 60_000;

interface ReserveOptions {
  readonly scope?: string;
  readonly leaseMs?: number;
  readonly limits?: Partial<AiUsageLimits>;
  readonly id?: string;
}

let sequence = 0;

function reserve(store: AiUsageStore, userId: string, at: number, options: ReserveOptions = {}): Promise<AiReservation> {
  sequence += 1;
  return store.reserve({
    scope: options.scope ?? 'contract:model',
    userId,
    reservationId: options.id ?? `reservation-${sequence}`,
    now: new Date(at),
    leaseExpiresAt: new Date(at + (options.leaseMs ?? 1)),
    limits: { ...LIMITS, ...options.limits },
  });
}

export function usageStoreContract(name: string, create: () => AiUsageStore): void {
  describe(`AiUsageStore contract: ${name}`, () => {
    test('counts each reservation in a sliding minute per user and reports when capacity returns', async () => {
      const store = create();
      assert.deepEqual(await reserve(store, 'u1', T0), { status: 'reserved' });
      assert.deepEqual(await reserve(store, 'u1', T0 + 10_000), { status: 'reserved' });
      assert.deepEqual(await reserve(store, 'u1', T0 + 20_000), { status: 'user_minute', retryAfterSeconds: 40 });
      assert.deepEqual(await reserve(store, 'u1', T0 + MINUTE + 1), { status: 'reserved' });
    });

    test('limits each user per Pacific calendar day, not per UTC day', async () => {
      const store = create();
      for (const offset of [0, 2, 4]) assert.equal((await reserve(store, 'u1', T0 + offset * MINUTE)).status, 'reserved');
      // 00:30 UTC on 2026-11-10 is still 2026-11-09 in Los Angeles; the day resets at 08:00 UTC.
      const afterUtcMidnight = Date.parse('2026-11-10T00:30:00.000Z');
      assert.deepEqual(await reserve(store, 'u1', afterUtcMidnight), { status: 'user_day', retryAfterSeconds: 27_000 });
      assert.equal((await reserve(store, 'u1', Date.parse('2026-11-10T08:00:01.000Z'))).status, 'reserved');
    });

    test('applies scope minute and day limits across users', async () => {
      const store = create();
      // 10 ms apart so the 1 ms leases never overlap; concurrency is covered separately.
      for (const [index, user] of ['a', 'b', 'c', 'd'].entries()) assert.equal((await reserve(store, user, T0 + index * 10)).status, 'reserved');
      const limited = await reserve(store, 'e', T0 + 1_000);
      assert.equal(limited.status, 'scope_minute');
      assert.equal((limited as { retryAfterSeconds: number }).retryAfterSeconds, 59);
      for (const [index, user] of ['e', 'f'].entries()) assert.equal((await reserve(store, user, T0 + 2 * MINUTE + index * 10)).status, 'reserved');
      assert.equal((await reserve(store, 'g', T0 + 4 * MINUTE)).status, 'scope_day');
    });

    test('allows one active lease per user and a bounded number per scope; release keeps the counts', async () => {
      const store = create();
      const long = { leaseMs: 30_000 };
      assert.equal((await reserve(store, 'u1', T0, { ...long, id: 'lease-u1' })).status, 'reserved');
      assert.deepEqual(await reserve(store, 'u1', T0 + 1, long), { status: 'user_busy' });
      assert.equal((await reserve(store, 'u2', T0 + 2, long)).status, 'reserved');
      assert.deepEqual(await reserve(store, 'u3', T0 + 3, long), { status: 'scope_busy' });
      await store.release('contract:model', 'lease-u1');
      assert.equal((await reserve(store, 'u1', T0 + 4, { ...long, id: 'lease-u1-again' })).status, 'reserved');
      await store.release('contract:model', 'lease-u1-again');
      // Released leases free concurrency only: u1 has used both of its minute slots.
      assert.equal((await reserve(store, 'u1', T0 + 5)).status, 'user_minute');
      assert.equal((await reserve(store, 'u3', T0 + 6)).status, 'reserved');
    });

    test('ignores expired leases', async () => {
      const store = create();
      assert.equal((await reserve(store, 'u1', T0, { leaseMs: 1_000 })).status, 'reserved');
      assert.deepEqual(await reserve(store, 'u1', T0 + 500), { status: 'user_busy' });
      assert.equal((await reserve(store, 'u1', T0 + 1_001)).status, 'reserved');
    });

    test('refusals consume nothing', async () => {
      const store = create();
      const strict = { limits: { userPerMinute: 1 } };
      assert.equal((await reserve(store, 'u1', T0, strict)).status, 'reserved');
      for (let index = 0; index < 5; index += 1) assert.equal((await reserve(store, 'u1', T0 + 10 + index, strict)).status, 'user_minute');
      for (const [index, user] of ['b', 'c', 'd'].entries()) assert.equal((await reserve(store, user, T0 + 100 + index * 10, strict)).status, 'reserved');
      assert.equal((await reserve(store, 'e', T0 + 200, strict)).status, 'scope_minute');
    });

    test('keeps scopes independent', async () => {
      const store = create();
      for (const [index, user] of ['a', 'b', 'c', 'd'].entries()) {
        assert.equal((await reserve(store, user, T0 + index * 10, { scope: 'project-a:model' })).status, 'reserved');
      }
      assert.equal((await reserve(store, 'e', T0 + 100, { scope: 'project-a:model' })).status, 'scope_minute');
      assert.equal((await reserve(store, 'e', T0 + 100, { scope: 'project-b:model' })).status, 'reserved');
    });

    test('never exceeds concurrency limits under simultaneous calls', async () => {
      const store = create();
      const sameUser = await Promise.all(Array.from({ length: 10 }, () => reserve(store, 'same', T0, { leaseMs: 30_000 })));
      assert.equal(sameUser.filter((result) => result.status === 'reserved').length, 1);
      const manyUsers = await Promise.all(Array.from({ length: 10 }, (_, index) => reserve(store, `user-${index}`, T0, { leaseMs: 30_000 })));
      assert.equal(manyUsers.filter((result) => result.status === 'reserved').length, 1);
      assert.ok(manyUsers.every((result) => result.status === 'reserved' || result.status === 'scope_busy'));
    });

    test('consumes each consent nonce once per scope until it expires', async () => {
      const store = create();
      const expires = new Date(T0 + MINUTE);
      assert.equal(await store.consumeConsentNonce('contract:model', 'nonce-1', expires, new Date(T0)), true);
      assert.equal(await store.consumeConsentNonce('contract:model', 'nonce-1', expires, new Date(T0 + 1_000)), false);
      assert.equal(await store.consumeConsentNonce('other:model', 'nonce-1', expires, new Date(T0 + 1_000)), true);
      const results = await Promise.all(Array.from({ length: 5 }, () => store.consumeConsentNonce('contract:model', 'nonce-2', expires, new Date(T0))));
      assert.equal(results.filter(Boolean).length, 1);
    });
  });
}
