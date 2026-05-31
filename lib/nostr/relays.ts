import { withPool, QUERY_MAX_WAIT_MS } from './pool';
import { storage } from '../storage';
import type { NostrIdentity } from './auth';

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.fountain.fm',
];

// Dedicated outbox relays for kind:0 (profile metadata) and kind:10002
// (NIP-65 relay lists). Always unioned into kind:0 / kind:10002 lookups
// so the global feed can render display names + avatars for arbitrary
// authors whose primary relays don't intersect DEFAULT_RELAYS.
//
//  - purplepag.es: the de facto standard profile outbox (Damus, Amethyst).
//  - nostr.bitcoiner.social: Bitcoin-community relay; many podcast/V4V
//    authors publish their metadata here (e.g. Jupiter Broadcasting hosts).
//  - eden.nostr.land: broadly-mirrored aggregator; catches profiles whose
//    publisher only chose niche relays.
//
// querySync calls in this codebase pass a QUERY_MAX_WAIT_MS bound (4s) so
// the wall time is capped — added relays don't compound latency since the
// pool runs them in parallel and we resolve when EOSE arrives or the bound
// fires, whichever comes first.
export const PROFILE_RELAYS = [
  'wss://purplepag.es',
  'wss://nostr.bitcoiner.social',
  'wss://eden.nostr.land',
];

// Drop relay entries that aren't valid `ws://` / `wss://` URLs. Corrupt NIP-65
// tags, stray text, or user typos (e.g. an `r` tag value of
// `"avatar wss://purplerelay.com"`) otherwise reach nostr-tools' `normalizeURL`,
// which throws `Invalid URL` synchronously inside `pool.querySync` — that
// rejection escapes our per-call try/catch and aborts the whole flow (e.g. the
// Spark "Create new" backup check). A survivor here is guaranteed to parse, so
// `normalizeURL` can't throw on it. Also dedupes and strips trailing slashes.
export function sanitizeRelays(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim().replace(/\/$/, '');
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.protocol !== 'wss:' && u.protocol !== 'ws:') continue;
    } catch {
      continue;
    }
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

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
      }, { maxWait: QUERY_MAX_WAIT_MS });
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
      return { write: sanitizeRelays(Array.from(write)) };
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
  const chosen = override ?? (identity?.writeRelays?.length ? identity.writeRelays : DEFAULT_RELAYS);
  // Sanitize regardless of source: a localStorage override or a peer's NIP-65
  // list can carry a malformed entry. If sanitizing empties the list (every
  // entry was garbage), fall back to the known-good defaults rather than
  // returning zero relays.
  const clean = sanitizeRelays(chosen);
  return (clean.length ? clean : DEFAULT_RELAYS).slice(0, 20);
}
