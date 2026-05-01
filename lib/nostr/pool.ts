import { SimplePool } from 'nostr-tools';

// Wall-time bounds on `pool.querySync`. Without these, a relay that never
// sends EOSE keeps the subscription open indefinitely, the pool can't close,
// and the browser tab keeps showing the loading spinner.
//
// QUERY_MAX_WAIT_MS — single-author / single-event / replaceable-event
// lookups (kind:0, kind:10000, kind:10002, kind:30003, NIP-78 backup, viewer
// reposts). These EOSE quickly because the relay scans by `authors` index;
// 4s is comfortably above the typical sub-second response.
//
// FEED_QUERY_MAX_WAIT_MS — broad lookups that scan many events across many
// relays (the global / per-podcast feed kind:1 queries, the reply-tree BFS,
// profile bulk fetches, quoted-event resolution). These need more breathing
// room or the result is incomplete and the cached version (which had a
// successful prior load) gets replaced with a smaller set on revisit.
export const QUERY_MAX_WAIT_MS = 4000;
export const FEED_QUERY_MAX_WAIT_MS = 8000;

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
