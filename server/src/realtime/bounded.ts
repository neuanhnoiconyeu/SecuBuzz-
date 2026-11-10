/** Inserts or refreshes `key` as the newest entry and evicts the oldest entries above `maximum`. */
export function rememberBounded<Key, Value>(map: Map<Key, Value>, key: Key, value: Value, maximum: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
