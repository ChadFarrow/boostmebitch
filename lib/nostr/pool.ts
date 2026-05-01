import { SimplePool } from 'nostr-tools';

// Default wall-time bound on `pool.querySync` — without this, a relay that
// never sends EOSE keeps the subscription open indefinitely, the pool can't
// close, and the browser tab keeps showing the loading spinner. Pass to
// every querySync as `{ maxWait: QUERY_MAX_WAIT_MS }`.
export const QUERY_MAX_WAIT_MS = 4000;

// Wraps `new SimplePool()` + `pool.close()` so callers can't forget the
// teardown. Used for every kind:0 / 10002 / 30003 query and every publish.
export async function withPool<T>(
  relays: string[],
  fn: (pool: SimplePool) => Promise<T>,
): Promise<T> {
  const pool = new SimplePool();
  try {
    return await fn(pool);
  } finally {
    pool.close(relays);
  }
}
