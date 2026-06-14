import type { Event, Filter, SimplePool } from 'nostr-tools';
import { withPool, QUERY_MAX_WAIT_MS, FEED_QUERY_MAX_WAIT_MS } from './pool';

// After the first matching event arrives, wait this long for a newer
// version from the remaining relays, then resolve. Replaceable events
// propagate to all healthy relays within ~a second of each other, so the
// grace window keeps last-write-wins correctness in practice without
// paying for the slowest relay in the set.
const FIRST_EVENT_GRACE_MS = 1500;

/**
 * Fetch the single newest Nostr event matching the given filter.
 * Returns null when no events are found or the query throws.
 *
 * Resolves at the earliest of: all relays EOSE'd, `FIRST_EVENT_GRACE_MS`
 * after the first matching event, or `maxWait`. The old `querySync`
 * implementation waited for EVERY relay to EOSE (or the full `maxWait`),
 * so one dead relay in a 20-relay union pinned every wallet/settings
 * restore at the timeout even when the event arrived in 300ms.
 */
export async function fetchLatestEvent(
  relays: string[],
  filter: Filter,
  maxWait = QUERY_MAX_WAIT_MS,
): Promise<Event | null> {
  return withPool(relays, async (pool) => {
    try {
      return await new Promise<Event | null>((resolve) => {
        let best: Event | null = null;
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(hardTimer);
          if (graceTimer) clearTimeout(graceTimer);
          try { sub.close(); } catch { /* already closed */ }
          resolve(best);
        };

        const hardTimer = setTimeout(finish, maxWait);
        const sub = pool.subscribeMany(relays, filter, {
          onevent(e: Event) {
            if (!best || e.created_at > best.created_at) best = e;
            if (!graceTimer) graceTimer = setTimeout(finish, FIRST_EVENT_GRACE_MS);
          },
          oneose() {
            // Fires once all relays have EOSE'd — nothing more is coming.
            finish();
          },
        });
      });
    } catch {
      return null;
    }
  });
}

export interface CollectResult {
  /** Every matching event collected across the relay union, deduped by id. */
  events: Event[];
  /** Aggregate EOSE fired — every queried relay reached end-of-stored-events
   *  within the window (vs. resolving on the maxWait hard timeout). When true
   *  an author's absence is trustworthy; when false the query was degraded. */
  allEosed: boolean;
  /** At least one event arrived. A false here on a multi-author batch means a
   *  network blackout, not "none of these authors has a profile". */
  gotAnyEvent: boolean;
}

/**
 * Stream-collect every event matching `filter` across `relays`, deduping by id.
 * Resolves at the earliest of:
 *   - every pubkey in `expectedAuthors` seen at least once (all-found early exit),
 *   - aggregate EOSE (every relay reached end-of-stored-events),
 *   - `maxWait`.
 *
 * Unlike `pool.querySync` (which waits for the slowest relay or the full maxWait
 * and can return empty when one relay stalls), this returns as soon as the data
 * we need is in hand — so one dead relay in the union can't pin or empty the
 * batch. `allEosed`/`gotAnyEvent` let callers gate negative-caching: an empty
 * result with `allEosed=false` means "degraded, don't trust the absence",
 * whereas `allEosed=true` means "genuinely not on these relays".
 *
 * The CALLER owns the pool (unlike `fetchLatestEvent`, which uses `withPool`):
 * `fetchProfiles` runs inside `withExtraRelays(pool, …)` and the helper must
 * reuse that pool so the extra profile-outbox sockets are torn down by the
 * surrounding scope. Pass an empty `expectedAuthors` to disable the early exit
 * (collect until EOSE/maxWait).
 */
export async function collectEventsByAuthors(
  pool: SimplePool,
  relays: string[],
  filter: Filter,
  expectedAuthors: string[],
  maxWait = FEED_QUERY_MAX_WAIT_MS,
): Promise<CollectResult> {
  const byId = new Map<string, Event>();
  const seenAuthors = new Set<string>();
  const want = new Set(expectedAuthors);
  let allEosed = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { sub?.close(); } catch { /* already closed */ }
      resolve();
    };

    const hardTimer = setTimeout(finish, maxWait);
    // Defense in depth: a malformed relay URL in `relays` makes nostr-tools'
    // normalizeURL throw synchronously inside subscribeMany. Callers should
    // sanitizeRelays their hint sets, but if one slips through we resolve with
    // whatever we have rather than let the throw abort the whole feed/profile
    // load. `finish` tolerates an undefined `sub`.
    let sub: { close: () => void } | undefined;
    try {
      sub = pool.subscribeMany(relays, filter, {
        onevent(e: Event) {
          if (!byId.has(e.id)) byId.set(e.id, e);
          seenAuthors.add(e.pubkey);
          // All-found early exit: stop the moment every requested author has a
          // matching event in hand — no reason to wait on slow relays.
          if (want.size > 0 && seenAuthors.size >= want.size) {
            let all = true;
            for (const a of want) if (!seenAuthors.has(a)) { all = false; break; }
            if (all) finish();
          }
        },
        oneose() {
          // Fires once all relays have EOSE'd — nothing more is coming.
          allEosed = true;
          finish();
        },
      });
    } catch {
      finish();
    }
  });

  return { events: Array.from(byId.values()), allEosed, gotAnyEvent: byId.size > 0 };
}
