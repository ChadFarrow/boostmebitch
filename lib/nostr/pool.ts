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

// Quiet-period early-resolve for broad feed scans. Once events have started
// arriving, if none of the live relays sends a new one for this long, the scan
// resolves rather than waiting out FEED_QUERY_MAX_WAIT_MS for a connected-but-
// stalled relay that never sends EOSE. Generous enough not to truncate normal
// trickle from a slow-but-healthy relay; far under the hard ceiling. Paired
// with warmRelays (relay-health.ts), which has already dropped dead relays, so
// the remaining set should go quiet quickly when genuinely done.
export const FEED_QUIET_MS = 2500;

// A single long-lived pool reused across every read query and publish. Relay
// WebSockets live inside the pool keyed by URL, so a second query to the same
// relay rides the already-open socket instead of paying a fresh TLS+WS
// handshake — the dominant, variable latency on flaky networks. (This is
// nostr-tools' intended usage: a SimplePool is built once and kept; it
// reconnects dropped relays on the next query on its own.) Lazily constructed
// so importing this module during SSR doesn't build a pool the server never
// uses.
let sharedPool: SimplePool | null = null;
function getSharedPool(): SimplePool {
  if (!sharedPool) sharedPool = new SimplePool();
  return sharedPool;
}

// Runs `fn` against the shared pool. Used for every kind:0 / 10002 / 30003
// query and every publish. Deliberately does NOT close the pool's relays
// afterwards — that's what the old create-per-query version did, throwing away
// every warm connection on each call. The only sockets still torn down are the
// one-off extras opened by `withExtraRelays`, which bounds the persistent set
// to the relays we actually want to keep warm. `relays` is now unused here
// (callers pass their own relay list to querySync/subscribeMany inside `fn`),
// but the signature is kept so callers read unchanged.
export async function withPool<T>(
  _relays: string[],
  fn: (pool: SimplePool) => Promise<T>,
): Promise<T> {
  return fn(getSharedPool());
}

/**
 * Run `fn` with the union of `baseRelays` + `extraRelays` (deduped),
 * closing only the newly-opened extras when done. Use inside a `withPool`
 * scope when a sub-query needs extra relays beyond the outer base set. The
 * shared pool is never closed, so these one-off extras (quote-ref hints,
 * other authors' write relays, nevent hints) MUST be torn down here or they
 * accumulate open sockets for the life of the tab — closing them keeps the
 * persistent connection set bounded to the relays we actually reuse. Close
 * errors are swallowed since extras going down mid-query is a normal
 * condition we never want to propagate.
 */
export async function withExtraRelays<T>(
  pool: SimplePool,
  baseRelays: string[],
  extraRelays: string[],
  fn: (relays: string[]) => Promise<T>,
): Promise<T> {
  const baseSet = new Set(baseRelays);
  const merged = [...baseRelays];
  const opened: string[] = [];
  for (const r of extraRelays) {
    if (!baseSet.has(r)) {
      merged.push(r);
      opened.push(r);
    }
  }
  try {
    return await fn(merged);
  } finally {
    if (opened.length) {
      try { pool.close(opened); } catch { /* ignore */ }
    }
  }
}
