export type AdapterFailure = 'error' | 'timeout';
export type AdapterResult<Value> =
  | { readonly ok: true; readonly value: Value }
  /**
   * `code` is the thrown error's `code` property and `fields` its `fields` list; each is kept only
   * when it is a short allowlisted token (UPPER_SNAKE code, lower camelCase field names).
   */
  | { readonly ok: false; readonly reason: AdapterFailure; readonly code?: string; readonly fields?: readonly string[] };

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,47}$/;
const SAFE_FIELD_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;

/** The only parts of a thrown error that survive: allowlisted classification tokens, never a message. */
function classification(error: unknown): { readonly code?: string; readonly fields?: readonly string[] } {
  if (error === null || typeof error !== 'object') return {};
  const { code, fields } = error as { code?: unknown; fields?: unknown };
  const safeCode = typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? { code } : {};
  const safeFields = Array.isArray(fields) && fields.length <= 8 && fields.every((field) => typeof field === 'string' && SAFE_FIELD_NAME.test(field))
    ? { fields: Object.freeze([...fields] as string[]) } : {};
  return { ...safeCode, ...safeFields };
}

/**
 * Calls an adapter with a deadline. Throws (sync or async) become `error`, a missed deadline becomes
 * `timeout`, and a result that arrives after the deadline is ignored. Error objects are discarded
 * so their messages, which may echo query parameters, are never logged. Only an allowlisted `code`
 * token is kept, so callers can tell an authorization failure from an infrastructure failure.
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
    } catch (error) {
      finish({ ok: false, reason: 'error', ...classification(error) });
      return;
    }
    pending.then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, reason: 'error', ...classification(error) }),
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
