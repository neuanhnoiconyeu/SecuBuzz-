export interface RateSetting {
  /** Maximum burst. */
  readonly capacity: number;
  /** Sustained rate. `0` means the budget never refills during the connection. */
  readonly refillPerSecond: number;
}

/** Classic token bucket with lazy refill; one instance per connection and category. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  #tokens: number;
  #updatedAt: number;

  constructor(setting: RateSetting, now: () => number = Date.now) {
    this.#capacity = setting.capacity;
    this.#refillPerMs = setting.refillPerSecond / 1_000;
    this.#now = now;
    this.#tokens = setting.capacity;
    this.#updatedAt = now();
  }

  take(cost = 1): boolean {
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#updatedAt);
    this.#updatedAt = now;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
