import type { Event, Filter } from 'nostr-tools';
import { withPool, QUERY_MAX_WAIT_MS } from './pool';

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
