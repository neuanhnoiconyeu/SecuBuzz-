/**
 * Usage accounting that protects the Gemini free-tier quota.
 *
 * A reservation is taken atomically before every provider call and is never refunded, so failed,
 * timed-out and cancelled calls still count. Google applies limits per project (not per key) and
 * resets requests-per-day at midnight Pacific time; the store mirrors both rules.
 *
 * Production needs a durable store shared by every process and key of one Google project
 * (Database Team handoff, docs/phase9b-gemini-integration.md). `MemoryAiUsageStore` is for explicit
 * local development only: it forgets everything on restart and is invisible to other processes.
 */
import { isPlainObject } from '../realtime/validation.ts';
import type { AiErrorCode } from './protocol.ts';

export interface AiUsageLimits {
  readonly userPerMinute: number;
  readonly userPerDay: number;
  readonly scopePerMinute: number;
  readonly scopePerDay: number;
  /** Active reservations per scope. One per user is fixed policy. */
  readonly maxConcurrentPerScope: number;
}

export interface AiReservationRequest {
  /** Quota bucket: `AI_QUOTA_SCOPE` plus the model, for example `default:gemini-3.5-flash-lite`. */
  readonly scope: string;
  readonly userId: string;
  /** Random and unique; identifies the concurrency lease. */
  readonly reservationId: string;
  readonly now: Date;
  /** The lease ends here even if `release` is never called (crash safety). */
  readonly leaseExpiresAt: Date;
  readonly limits: AiUsageLimits;
}

export type AiReservation =
  | { readonly status: 'reserved' }
  | { readonly status: 'user_busy' | 'scope_busy' }
  | { readonly status: 'user_minute' | 'scope_minute' | 'user_day' | 'scope_day'; readonly retryAfterSeconds: number };

/**
 * Contract for the Database Team's durable implementation:
 *
 * - `reserve` is one atomic step across processes and restarts (for example a SQLite
 *   `BEGIN IMMEDIATE` transaction or a Redis Lua script). It ignores expired leases, refuses when
 *   the user already holds a lease or the scope holds `maxConcurrentPerScope` leases, then checks
 *   the user and scope counts for the current Pacific day and the sliding last 60 seconds, and only
 *   then records the lease and increments every counter. Refusals change nothing.
 * - `release` deletes the lease only. Counters are never decremented.
 * - `consumeConsentNonce` is an atomic insert-if-absent of (scope, nonce) kept until `expiresAt`;
 *   it returns `true` only for the first use.
 * - Methods may be async and may throw; the AI service applies deadlines and fails closed.
 */
export interface AiUsageStore {
  readonly kind: 'memory' | 'durable';
  reserve(request: AiReservationRequest): Promise<AiReservation>;
  release(scope: string, reservationId: string): Promise<void>;
  consumeConsentNonce(scope: string, nonce: string, expiresAt: Date, now: Date): Promise<boolean>;
}

const RESERVATION_STATUSES = new Set(['reserved', 'user_busy', 'scope_busy', 'user_minute', 'scope_minute', 'user_day', 'scope_day']);
const MAX_RETRY_AFTER_SECONDS = 90_000;

/** Validates a store result; `null` means malformed. */
export function parseReservation(input: unknown): AiReservation | null {
  if (!isPlainObject(input) || typeof input.status !== 'string' || !RESERVATION_STATUSES.has(input.status)) return null;
  const status = input.status as AiReservation['status'];
  if (status === 'reserved' || status === 'user_busy' || status === 'scope_busy') return { status };
  const seconds = input.retryAfterSeconds;
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_RETRY_AFTER_SECONDS) return null;
  return { status, retryAfterSeconds: seconds };
}

const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` in America/Los_Angeles, the reset boundary of Gemini requests-per-day. */
export function pacificDayKey(at: Date | number): string {
  return PACIFIC_DAY.format(at);
}

/** Seconds until the next midnight in America/Los_Angeles (handles 23- and 25-hour days). */
export function secondsUntilNextPacificMidnight(at: Date | number): number {
  const start = typeof at === 'number' ? at : at.getTime();
  const today = pacificDayKey(start);
  let low = start;
  let high = start + 26 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (pacificDayKey(middle) === today) low = middle;
    else high = middle;
  }
  return Math.max(1, Math.ceil((high - start) / 1_000));
}

const WINDOW_MS = 60_000;
const PRUNE_INTERVAL_MS = 1_000;

interface Lease {
  readonly scope: string;
  readonly userId: string;
  readonly expiresAt: number;
}

/**
 * Development-only store. Refuses to construct when NODE_ENV=production. Single process only:
 * restarts reset every counter, and other processes cannot see its counters or nonces.
 */
export class MemoryAiUsageStore implements AiUsageStore {
  readonly kind = 'memory' as const;
  readonly #minute = new Map<string, number[]>();
  readonly #day = new Map<string, { day: string; count: number }>();
  readonly #leases = new Map<string, Lease>();
  readonly #nonces = new Map<string, number>();
  #lastPrune = Number.NEGATIVE_INFINITY;

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MemoryAiUsageStore is for local development only and must never be used in production.');
    }
  }

  #prune(now: number): void {
    if (now - this.#lastPrune < PRUNE_INTERVAL_MS && now >= this.#lastPrune) return;
    this.#lastPrune = now;
    const today = pacificDayKey(now);
    for (const [key, times] of this.#minute) {
      const recent = times.filter((time) => time > now - WINDOW_MS);
      if (recent.length === 0) this.#minute.delete(key);
      else this.#minute.set(key, recent);
    }
    for (const [key, entry] of this.#day) if (entry.day !== today) this.#day.delete(key);
    for (const [id, lease] of this.#leases) if (lease.expiresAt <= now) this.#leases.delete(id);
    for (const [key, expiresAt] of this.#nonces) if (expiresAt <= now) this.#nonces.delete(key);
  }

  #recent(key: string, now: number): number[] {
    const recent = (this.#minute.get(key) ?? []).filter((time) => time > now - WINDOW_MS);
    this.#minute.set(key, recent);
    return recent;
  }

  #dayCount(key: string, day: string): number {
    const entry = this.#day.get(key);
    return entry && entry.day === day ? entry.count : 0;
  }

  #increment(key: string, day: string): void {
    this.#day.set(key, { day, count: this.#dayCount(key, day) + 1 });
  }

  async reserve(request: AiReservationRequest): Promise<AiReservation> {
    const now = request.now.getTime();
    const { limits } = request;
    this.#prune(now);
    let active = 0;
    for (const lease of this.#leases.values()) {
      if (lease.scope !== request.scope || lease.expiresAt <= now) continue;
      if (lease.userId === request.userId) return { status: 'user_busy' };
      active += 1;
    }
    if (active >= limits.maxConcurrentPerScope) return { status: 'scope_busy' };

    const userKey = JSON.stringify([request.scope, request.userId]);
    const scopeKey = JSON.stringify([request.scope]);
    const day = pacificDayKey(now);
    if (this.#dayCount(userKey, day) >= limits.userPerDay) return { status: 'user_day', retryAfterSeconds: secondsUntilNextPacificMidnight(now) };
    if (this.#dayCount(scopeKey, day) >= limits.scopePerDay) return { status: 'scope_day', retryAfterSeconds: secondsUntilNextPacificMidnight(now) };
    const userRecent = this.#recent(userKey, now);
    const scopeRecent = this.#recent(scopeKey, now);
    const wait = (times: number[]) => Math.max(1, Math.ceil(((times[0] ?? now) + WINDOW_MS - now) / 1_000));
    if (userRecent.length >= limits.userPerMinute) return { status: 'user_minute', retryAfterSeconds: wait(userRecent) };
    if (scopeRecent.length >= limits.scopePerMinute) return { status: 'scope_minute', retryAfterSeconds: wait(scopeRecent) };

    userRecent.push(now);
    scopeRecent.push(now);
    this.#increment(userKey, day);
    this.#increment(scopeKey, day);
    this.#leases.set(request.reservationId, { scope: request.scope, userId: request.userId, expiresAt: request.leaseExpiresAt.getTime() });
    return { status: 'reserved' };
  }

  async release(_scope: string, reservationId: string): Promise<void> {
    this.#leases.delete(reservationId);
  }

  async consumeConsentNonce(scope: string, nonce: string, expiresAt: Date, now: Date): Promise<boolean> {
    this.#prune(now.getTime());
    const key = JSON.stringify([scope, nonce]);
    const existing = this.#nonces.get(key);
    if (existing !== undefined && existing > now.getTime()) return false;
    this.#nonces.set(key, expiresAt.getTime());
    return true;
  }

  /** Test and diagnostics helper: number of unexpired leases. */
  activeLeases(now: number = Date.now()): number {
    return [...this.#leases.values()].filter((lease) => lease.expiresAt > now).length;
  }
}

export type BreakerCode = Extract<AiErrorCode, 'AI_RATE_LIMITED' | 'AI_DAILY_QUOTA_EXHAUSTED' | 'AI_PROVIDER_UNAVAILABLE'>;
export type BreakerState =
  | { readonly open: false }
  | { readonly open: true; readonly code: BreakerCode; readonly retryAfterSeconds: number };

/**
 * In-process circuit breaker. After a provider 429 or a configuration failure it stops provider
 * calls in this process until the stated time. It never schedules a retry.
 */
export class ProviderBreaker {
  #openUntil = 0;
  #code: BreakerCode = 'AI_RATE_LIMITED';

  open(code: BreakerCode, nowMs: number, seconds: number): void {
    const until = nowMs + Math.max(1, seconds) * 1_000;
    if (until <= this.#openUntil) return;
    this.#openUntil = until;
    this.#code = code;
  }

  state(nowMs: number): BreakerState {
    if (nowMs >= this.#openUntil) return { open: false };
    return { open: true, code: this.#code, retryAfterSeconds: Math.max(1, Math.ceil((this.#openUntil - nowMs) / 1_000)) };
  }
}
