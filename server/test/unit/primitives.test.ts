import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { callAdapter, forEachLimited } from '../../src/realtime/adapterCall.ts';
import { rememberBounded } from '../../src/realtime/bounded.ts';
import { ServerClock } from '../../src/realtime/clock.ts';
import { createConsoleLogger, safeLog, sanitizeLogFields } from '../../src/realtime/logger.ts';
import { TokenBucket } from '../../src/realtime/rateLimiter.ts';

describe('ServerClock', () => {
  test('returns strictly increasing timestamps per key within the same millisecond', () => {
    const clock = new ServerClock(100, () => 1_700_000_000_000);
    const first = clock.next('typing:c1:u1');
    const second = clock.next('typing:c1:u1');
    const other = clock.next('typing:c1:u2');
    assert.ok(Date.parse(second) > Date.parse(first));
    assert.equal(other, first, 'keys are independent');
  });

  test('follows real time when it moves forward and bounds tracked keys', () => {
    let now = 1_000;
    const clock = new ServerClock(2, () => now);
    assert.equal(clock.next('a'), new Date(1_000).toISOString());
    now = 5_000;
    assert.equal(clock.next('a'), new Date(5_000).toISOString());
    clock.next('b');
    clock.next('c');
    assert.equal(clock.trackedKeys, 2);
  });
});

describe('TokenBucket', () => {
  test('allows a burst, refills over time and never exceeds capacity', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 2 }, () => now);
    assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false]);
    now = 499;
    assert.equal(bucket.take(), false);
    now = 500;
    assert.equal(bucket.take(), true);
    now = 60_000;
    assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false]);
  });

  test('a zero refill rate is a fixed lifetime budget', () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0 }, () => now);
    assert.equal(bucket.take(), true);
    now = 1_000_000;
    assert.equal(bucket.take(), false);
  });
});

describe('callAdapter', () => {
  test('returns values, converts sync and async throws, and times out', async () => {
    assert.deepEqual(await callAdapter(async () => 7, 100), { ok: true, value: 7 });
    assert.deepEqual(await callAdapter(() => 'sync', 100), { ok: true, value: 'sync' });
    assert.deepEqual(await callAdapter(() => { throw new Error('secret token abc'); }, 100), { ok: false, reason: 'error' });
    assert.deepEqual(await callAdapter(async () => { throw new Error('db said: password=x'); }, 100), { ok: false, reason: 'error' });
    assert.deepEqual(await callAdapter(() => new Promise(() => undefined), 20), { ok: false, reason: 'timeout' });
  });

  test('ignores results that arrive after the deadline', async () => {
    let resolveLate!: (value: string) => void;
    const result = await callAdapter(() => new Promise<string>((resolve) => { resolveLate = resolve; }), 10);
    resolveLate('too late');
    assert.deepEqual(result, { ok: false, reason: 'timeout' });
  });

  test('forEachLimited bounds concurrency and isolates failures', async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await forEachLimited([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (item === 3) throw new Error('isolated');
      done.push(item);
    });
    assert.equal(peak, 2);
    assert.deepEqual(done.sort(), [1, 2, 4, 5]);
  });
});

describe('logging', () => {
  test('keeps primitive fields only, bounds strings and neutralizes control characters', () => {
    const fields = sanitizeLogFields({ code: 'AUTH_REQUIRED', count: 2, ok: true, none: null, nan: Number.NaN,
      injected: 'line1\nline2', long: 'x'.repeat(500), 'bad key': 'dropped' } as never);
    assert.deepEqual(Object.keys(fields).sort(), ['code', 'count', 'injected', 'long', 'nan', 'none', 'ok']);
    assert.equal(fields.injected, 'line1?line2');
    assert.equal((fields.long as string).length, 200);
    assert.equal(fields.nan, null);
  });

  test('writes JSON lines and survives a throwing logger', () => {
    const out: string[] = [];
    const err: string[] = [];
    const logger = createConsoleLogger({ write: (line) => out.push(line) }, { write: (line) => err.push(line) });
    logger.log('info', 'realtime.test', { value: 1 });
    logger.log('warn', 'realtime.warn');
    assert.equal(out.length, 1);
    assert.equal(err.length, 1);
    assert.deepEqual({ ...JSON.parse(out[0]!), time: 'x' }, { time: 'x', level: 'info', event: 'realtime.test', value: 1 });
    assert.doesNotThrow(() => safeLog({ log() { throw new Error('logger down'); } }, 'error', 'realtime.event'));
  });

  test('rememberBounded keeps the newest entries', () => {
    const map = new Map<string, number>();
    for (const [index, key] of ['a', 'b', 'c', 'a', 'd'].entries()) rememberBounded(map, key, index, 3);
    assert.deepEqual([...map.keys()], ['c', 'a', 'd']);
  });
});
