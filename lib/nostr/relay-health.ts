import type { SimplePool } from 'nostr-tools';

// Passive relay-health tracking for the read-query paths. A relay in the
// 20-relay union that's unreachable or AUTH-gated otherwise pads every feed
// query out to the full FEED_QUERY_MAX_WAIT_MS, because querySync/subscribeMany
// wait on the slowest relay. Here we record connection outcomes and put a
// chronically-failing relay in a penalty box so it's skipped entirely for a
// cooldown — a single dead relay stops taxing every navigation.
//
// The signal is connection success/failure via `pool.ensureRelay` (see
// `warmRelays`), which is the only per-relay outcome SimplePool exposes
// cleanly; a successful connect resets a relay's score. Module-level state, so
// it's shared across every query for the life of the tab (alongside the shared
// pool in pool.ts). Browser-only — `Date.now()` is fine here.

interface RelayHealth {
  /** Consecutive connection failures since the last success. */
  fails: number;
  /** Unix-ms; while `Date.now() < until` the relay is penalty-boxed (skipped). */
  until: number;
}

// Two strikes before benching — a single transient blip (relay restart, a
// flaky socket on app-switch) shouldn't sideline an otherwise-good relay.
const FAIL_THRESHOLD = 2;
// Cooldown grows with each failure past the threshold so a truly-dead relay is
// retried rarely, but a recovering one comes back within a minute.
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
// Per-relay connection probe budget. Comfortably under the feed query's own
// maxWait so warming a cold/slow relay never dominates, but long enough that a
// healthy-but-distant relay isn't falsely benched.
const CONNECT_TIMEOUT_MS = 3000;

const health = new Map<string, RelayHealth>();

/** Record a connection outcome for `url`. Success clears the score; failure
 *  increments it and, past the threshold, extends the penalty box with
 *  exponential backoff (capped). */
export function markRelay(url: string, ok: boolean): void {
  if (ok) {
    if (health.has(url)) health.delete(url);
    return;
  }
  const prev = health.get(url) ?? { fails: 0, until: 0 };
  const fails = prev.fails + 1;
  let until = prev.until;
  if (fails >= FAIL_THRESHOLD) {
    const cooldown = Math.min(
      BASE_COOLDOWN_MS * 2 ** (fails - FAIL_THRESHOLD),
      MAX_COOLDOWN_MS,
    );
    until = Date.now() + cooldown;
  }
  health.set(url, { fails, until });
}

/** Drop relays currently in the penalty box. Never returns empty: if every
 *  candidate is benched (total outage / offline), returns the original list so
 *  the query still attempts and the caller's own timeout governs — being
 *  pessimistic to the point of querying nothing would be worse than trying. */
export function healthyRelays(relays: string[]): string[] {
  const now = Date.now();
  const ok = relays.filter((r) => (health.get(r)?.until ?? 0) <= now);
  return ok.length ? ok : relays;
}

/**
 * Connect (or reuse an existing connection to) each non-benched relay in
 * parallel, record the outcome, and return the relays that are live. With the
 * shared persistent pool, already-open sockets resolve instantly, so this
 * mostly costs time only for relays that are actually down — and that cost is
 * bounded by CONNECT_TIMEOUT_MS (well under the query's maxWait it would
 * otherwise stall) and paid at most once before the relay is benched.
 *
 * The returned set is what the caller should query: dead relays are excluded
 * so subscribeMany's aggregate EOSE fires on the live relays alone instead of
 * waiting out the timeout. Never returns empty (same fallback as
 * `healthyRelays`).
 */
export async function warmRelays(
  pool: SimplePool,
  relays: string[],
): Promise<string[]> {
  const candidates = healthyRelays(relays);
  const outcomes = await Promise.all(
    candidates.map(async (url) => {
      try {
        await pool.ensureRelay(url, { connectionTimeout: CONNECT_TIMEOUT_MS });
        markRelay(url, true);
        return url;
      } catch {
        markRelay(url, false);
        return null;
      }
    }),
  );
  const live = outcomes.filter((u): u is string => u !== null);
  return live.length ? live : candidates;
}
