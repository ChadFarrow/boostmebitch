import type { Event, Filter } from 'nostr-tools';
import { withPool, QUERY_MAX_WAIT_MS } from './pool';

/**
 * Fetch the single newest Nostr event matching the given filter.
 * Returns null when no events are found or the query throws.
 */
export async function fetchLatestEvent(
  relays: string[],
  filter: Filter,
  maxWait = QUERY_MAX_WAIT_MS,
): Promise<Event | null> {
  return withPool(relays, async (pool) => {
    try {
      const events = await pool.querySync(relays, filter, { maxWait });
      if (!events.length) return null;
      return events.sort((a, b) => b.created_at - a.created_at)[0];
    } catch {
      return null;
    }
  });
}
