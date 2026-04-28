import { SimplePool } from 'nostr-tools';

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
