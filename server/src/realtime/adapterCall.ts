export type AdapterFailure = 'error' | 'timeout';
export type AdapterResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: AdapterFailure };

/**
 * Calls an adapter with a deadline. Throws (sync or async) become `error`, a missed deadline becomes
 * `timeout`, and a result that arrives after the deadline is ignored. Error objects are discarded
 * so their messages, which may echo query parameters, are never logged.
 */
export function callAdapter<Value>(operation: () => Value | Promise<Value>, timeoutMs: number): Promise<AdapterResult<Value>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AdapterResult<Value>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), Math.max(0, timeoutMs));
    timer.unref();
    let pending: Promise<Value>;
    try {
      pending = Promise.resolve(operation());
    } catch {
      finish({ ok: false, reason: 'error' });
      return;
    }
    pending.then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false, reason: 'error' }),
    );
  });
}

/** Runs `worker` over `items` with at most `limit` concurrent calls. Worker errors are swallowed. */
export async function forEachLimited<Item>(items: readonly Item[], limit: number, worker: (item: Item) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++] as Item;
      try {
        await worker(item);
      } catch {
        /* Each item is independent. */
      }
    }
  });
  await Promise.all(runners);
}
