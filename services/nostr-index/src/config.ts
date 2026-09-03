// Environment parsing, in one place, fail-closed.
//
// Every optional feature here is off when its variable is unset — the same
// shape the main app uses for SITE_NOSTR_SK and ANDROID_CERT_SHA256. An unset
// value must never become a guess.

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const out = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return out.length ? out : fallback;
}

// These four, and the omission is the point. A relay that connects and then
// answers nothing does not cost nothing: every query here resolves on AGGREGATE
// eose, so it pins each stage to the ceiling instead. `wss://relay.nostr.band`
// was exactly that and was measured out on 2026-08-25 — asked for this corpus's
// own filters it returned 0 events and never EOSE'd. It sat in this default for
// another week regardless, because INDEX_RELAYS overrode it in Railway and the
// running service was fine; a fresh environment with that variable unset would
// have inherited the relay the measurement removed. Keep this list equal to the
// app's `DEFAULT_RELAYS` (lib/nostr/relays.ts), which carries the numbers.
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.fountain.fm',
];

// Profile outboxes, unioned in for kind:0. Duplicated rather than imported so
// this service stays decoupled from lib/ — which is deliberate, and is also why
// it drifted: this said "same three the app already uses" while the app had been
// down to one since 2026-08-25. `nostr.bitcoiner.social` and `eden.nostr.land`
// cost ~5.9s a stage there and between them held ONE profile of about ninety
// that the trimmed set did not — and that one is reachable anyway, through the
// NIP-65 outbox fallback the wasted window was starving. Decoupled means the
// lists may differ for a reason, never that a claim about the other one can go
// unchecked.
export const PROFILE_RELAYS = [
  'wss://purplepag.es',
];

export const config = {
  databaseUrl: req('DATABASE_URL'),
  // The shared secret every read request must carry. Required even though the
  // data is public: without it this is an uncapped query surface onto our own
  // Postgres, reachable by anyone who finds the hostname.
  apiKey: req('INDEX_API_KEY'),
  port: num('PORT', 8080),
  // 'all' runs the API and the indexer in one process (cheapest). Split into
  // two Railway services later by setting this per service.
  role: (process.env.INDEX_ROLE?.trim() || 'all') as 'all' | 'api' | 'indexer',

  relays: list('INDEX_RELAYS', DEFAULT_RELAYS),
  profileRelays: list('INDEX_PROFILE_RELAYS', PROFILE_RELAYS),

  // How far back the first backfill walks. Older notes still arrive if a
  // relay serves them; this only bounds the initial history sweep.
  backfillDays: num('INDEX_BACKFILL_DAYS', 180),

  // Podcast Index warm-fill. Absent means the pi_* tables are only filled by
  // client requests, never proactively — the service still works.
  piKey: process.env.PODCAST_INDEX_KEY?.trim() || '',
  piSecret: process.env.PODCAST_INDEX_SECRET?.trim() || '',
  appName: process.env.APP_NAME?.trim() || 'boostmebitch-index/0.1',

  // How stale a pi_* row may be before the warm-fill refreshes it.
  piTtlHours: num('INDEX_PI_TTL_HOURS', 24 * 7),

  // How often tracked-pubkey subscriptions are reconsidered. Exposed mainly so
  // verify/check-indexer.mjs can drive it in milliseconds instead of minutes.
  resubscribeIntervalMs: num('INDEX_RESUBSCRIBE_MS', 60_000),

  // How often relay connectivity is checked, and how many all-dead checks in a
  // row rebuild every subscription. Same reason as above: the reconnect test
  // in verify/check-indexer.mjs cannot wait two minutes per assertion.
  connectivityCheckMs: num('INDEX_CONNECTIVITY_MS', 60_000),

  // How often the kind:30311 subscription is re-issued so its `since` window
  // does not go stale. Hourly; a filter is evaluated once, at REQ time.
  liveResubscribeMs: num('INDEX_LIVE_RESUBSCRIBE_MS', 3_600_000),
};

export type Config = typeof config;
