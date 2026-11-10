import { rememberBounded } from './bounded.ts';

/**
 * Server-authoritative time.
 *
 * The 8.7A client ignores typing, presence and conversation metadata whose timestamp is not newer
 * than the last one it saw for the same key, so `next(key)` returns strictly increasing
 * millisecond timestamps per key, even for several events in the same millisecond.
 */
export class ServerClock {
  readonly #now: () => number;
  readonly #maximumKeys: number;
  readonly #latest = new Map<string, number>();

  constructor(maximumKeys: number, now: () => number = Date.now) {
    this.#maximumKeys = maximumKeys;
    this.#now = now;
  }

  nowMs(): number {
    return this.#now();
  }

  nowIso(): string {
    return new Date(this.#now()).toISOString();
  }

  next(key: string): string {
    const now = this.#now();
    const previous = this.#latest.get(key);
    const value = previous !== undefined && previous >= now ? previous + 1 : now;
    rememberBounded(this.#latest, key, value, this.#maximumKeys);
    return new Date(value).toISOString();
  }

  get trackedKeys(): number {
    return this.#latest.size;
  }

  clear(): void {
    this.#latest.clear();
  }
}
