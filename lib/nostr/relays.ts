import { withPool } from './pool';
import { storage } from '../storage';
import type { NostrIdentity } from './auth';

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.fountain.fm',
];

// NIP-65 relay list (kind:10002). We only consume the write side — we never
// read events from arbitrary relays based on someone's read list, so the
// parser drops it.
export async function fetchRelayList(
  pubkey: string,
  queryRelays?: string[],
): Promise<{ write: string[] } | null> {
  const useRelays = queryRelays ?? DEFAULT_RELAYS;
  return withPool(useRelays, async (pool) => {
    try {
      const events = await pool.querySync(useRelays, {
        kinds: [10002],
        authors: [pubkey],
        limit: 1,
      });
      if (!events.length) return null;
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const write = new Set<string>();
      for (const tag of newest.tags) {
        if (tag[0] !== 'r' || !tag[1]) continue;
        const url = tag[1].trim().replace(/\/$/, '');
        if (!url) continue;
        const marker = tag[2];
        if (!marker || marker === 'write') write.add(url);
      }
      return { write: Array.from(write) };
    } catch {
      return null;
    }
  });
}

/**
 * Effective relay set for publishing the user's events.
 * Priority: explicit localStorage override → identity NIP-65 write relays → DEFAULT_RELAYS.
 * Capped at 20 to keep publish latency bounded.
 */
export function resolvePublishRelays(identity: NostrIdentity | null): string[] {
  const override = storage.relays.get();
  if (override) return override.slice(0, 20);
  if (identity?.writeRelays?.length) return identity.writeRelays.slice(0, 20);
  return DEFAULT_RELAYS;
}
