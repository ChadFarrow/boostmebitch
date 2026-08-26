import { withPool, QUERY_MAX_WAIT_MS } from './pool';
import { storage } from '../storage';
import type { NostrIdentity } from './auth';

// Every read query in the app fans out to these, and `SimplePool.querySync` /
// `collectEventsByAuthors` resolve on AGGREGATE eose — so a relay that connects
// and then answers nothing does not cost nothing, it costs the caller's whole
// `maxWait`, on every stage, every load. `warmRelays` cannot catch it: it scores
// `pool.ensureRelay`, and a silent relay connects perfectly.
//
// `wss://relay.nostr.band` was exactly that and was measured out on 2026-08-25.
// Asked for this app's own kind:1 filter it returned 0 events and never EOSE'd,
// while pinning each query to the ceiling. Removing it changed no result:
//
//   kind:1 podcast notes   5 relays 7026ms / 227 events -> 4 relays 2403ms / 227
//   kind:30311 live        7 relays 7027ms / 229 events -> 6 relays 1682ms / 229
//   reply tree, round 0    5 relays 7029ms /  18 events -> 4 relays 2702ms /  18
//
// `docs/ops.md` carries the same table for the index service, which was trimmed
// to these four for the same reason. RE-MEASURE before trusting this list — a
// relay that is dead today may not be tomorrow, and the cost of carrying a live
// one is a socket, while the cost of carrying a dead one is five seconds a stage.
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.fountain.fm',
];

// Dedicated outbox relays for kind:0 (profile metadata) and kind:10002
// (NIP-65 relay lists). Always unioned into kind:0 / kind:10002 lookups
// so the global feed can render display names + avatars for arbitrary
// authors whose primary relays don't intersect DEFAULT_RELAYS.
//
//  - purplepag.es: the de facto standard profile outbox (Damus, Amethyst).
//
// This comment used to say a bound "caps the wall time" so extra relays "don't
// compound latency since the pool runs them in parallel". That is the belief the
// bug lived in, and it is wrong in the direction that costs the most: the bound
// caps the WORST case and a silent relay makes every query hit it, so an added
// relay that answers nothing converts the ceiling into the typical time. It is
// only free to add a relay that ANSWERS.
//
// `nostr.bitcoiner.social` and `eden.nostr.land` were dropped on 2026-08-25 for
// that reason. Measured against the live global feed, interleaved to cancel
// corpus drift:
//
//   kind:0, base + these 3   7005ms / 7001ms, 78 and 87 profiles
//   kind:0, trimmed sets     1072ms / 1132ms, 77 and 100 profiles
//
// They cost ~5.9s a stage. Be exact about what that bought: across both rounds
// they held ONE profile, of about ninety, that the trimmed set did not — not
// zero. That one is still reachable, because a profile missing from the first
// pass is exactly what `fetchProfiles`' NIP-65 outbox fallback exists to chase,
// and that fallback was itself unreachable in practice while each pass ahead of
// it burned its whole window. `fetchProfiles` runs the ladder up to three times
// in series, so the three relays cost roughly 18s of a cold homepage for it.
export const PROFILE_RELAYS = [
  'wss://purplepag.es',
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
 * - explicit localStorage override → used as-is (advanced users opt out of the
 *   default union deliberately).
 * - otherwise → the identity's NIP-65 write relays UNIONED with DEFAULT_RELAYS.
 * Capped at 20 to keep publish latency bounded.
 *
 * Why union the defaults: a user's NIP-65 write relays can be dead, unreachable,
 * or AUTH-gated, which produced "published to 0/N relays" even though the boost
 * itself paid. Always including the known-good, write-accepting defaults
 * (damus/primal/nos.lol/fountain) guarantees the note has somewhere to land.
 *
 * **An identity with no `writeRelays` falls back to this account's CACHED
 * kind:10002 write set before it falls back to the bare defaults.** `writeRelays`
 * is populated by `loadProfile`, which fetches kind:10002 in PARALLEL with the
 * favorites and mute-list hydrations, so on a cold load those two read from
 * `DEFAULT_RELAYS` alone while their own republish targeted the full union.
 *
 * **Be precise about what that does and does not cost, because the union above
 * absorbs most of it.** `DEFAULT_RELAYS` is always part of the publish set, so
 * for an event THIS APP wrote a defaults-only read is a SUBSET of where it was
 * sent, and normally finds it. The gap is real in four narrower cases:
 *
 *   1. **Another app is the writer.** Nothing guarantees a third-party client
 *      publishes to our five defaults — it publishes to the user's own outbox.
 *      This is the ORDINARY case for `kind:10000`, which Damus, Amethyst and
 *      Coracle write and this app never creates, and a live one for `kind:10333`,
 *      which is shared by design.
 *   2. **The 20 cap.** `writeRelays` are listed FIRST, so an account with 20 or
 *      more of them slices every default off the publish set entirely.
 *   3. **Partial acceptance.** `assertPublished` requires only ONE relay, so an
 *      event whose five defaults all refused (AUTH-gated, rate-limited, down)
 *      lives on a write relay alone and is still recorded as published.
 *   4. **An override.** `bmb:relays` replaces the defaults rather than joining
 *      them. Nothing in the UI sets it today, so this one is theoretical.
 *
 * So this is the invariant "read from where you write" rather than a fix for an
 * observed disappearance — see docs/nostr.md, which used to claim the latter.
 * The cache is written by `loadProfile` once the real kind:10002 lands; an
 * account that has never resolved one reads `[]` here and behaves as before.
 */
export function resolvePublishRelays(identity: NostrIdentity | null): string[] {
  const override = storage.relays.get();
  // The live NIP-65 answer wins; the cache only stands in for "not fetched
  // yet". Never the other way round — a user who narrows their write set must
  // not keep publishing to the relays they just dropped.
  const write = identity?.writeRelays ?? (identity ? storage.writeRelays.get(identity.npub) : []);
  // Sanitize regardless of source: an override or a peer's NIP-65 list can carry
  // a malformed entry. If sanitizing empties the list, fall back to defaults.
  const chosen = override
    ? sanitizeRelays(override)
    : sanitizeRelays([...write, ...DEFAULT_RELAYS]);
  return (chosen.length ? chosen : DEFAULT_RELAYS).slice(0, 20);
}

/**
 * READ-side relay set for an encrypted-to-self backup (kind:30078). Always the
 * union of the user's intended publish relays AND DEFAULT_RELAYS, deduped,
 * capped at 20.
 *
 * Why a union and not just resolvePublishRelays: on a fresh sign-in via Amber
 * on Android, NIP-65 (kind:10002) hydrates in parallel with everything else
 * inside `loadProfile`. If the user taps "Restore from Nostr" before that
 * resolves, `identity.writeRelays` is still undefined and resolvePublishRelays
 * falls back to DEFAULT_RELAYS. If the backup was originally published from a
 * session that *had* writeRelays, it might live only on the user's outbox — and
 * we'd miss it. Querying both sides covers either case without weakening the
 * publish path, which still targets only the user's intended write relays.
 *
 * Shared rather than per-module: this was duplicated byte-for-byte in
 * wallet-backup.ts and settings-backup.ts, and the second copy's comment
 * already admitted it ("Mirrors wallet-backup.ts:readRelays"). A backup read
 * that silently narrows its relay set doesn't error — it reports "no backup
 * exists", which is the one answer a restore path must never get wrong.
 */
export function backupReadRelays(identity: NostrIdentity): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of resolvePublishRelays(identity)) {
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  for (const r of DEFAULT_RELAYS) {
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out.slice(0, 20);
}
