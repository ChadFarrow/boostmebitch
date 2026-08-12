import type { Event, Filter, SimplePool } from 'nostr-tools';
import { withPool, QUERY_MAX_WAIT_MS, FEED_QUERY_MAX_WAIT_MS } from './pool';

// After the first matching event arrives, wait this long for a newer
// version from the remaining relays, then resolve. Replaceable events
// propagate to all healthy relays within ~a second of each other, so the
// grace window keeps last-write-wins correctness in practice without
// paying for the slowest relay in the set.
const FIRST_EVENT_GRACE_MS = 1500;

// Per-relay connect budget, deliberately well under any caller's maxWait: a
// dead relay must not be able to spend the whole window failing before the
// live ones are even asked. Dead entries in default relay lists are common and
// long-lived, because nothing surfaces them.
const CONNECT_TIMEOUT_MS = 2000;

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
  return (await fetchLatestEventDetailed(relays, filter, maxWait)).event;
}

/**
 * As {@link fetchLatestEvent}, but also reports whether the *absence* of a
 * result can be trusted.
 *
 * A null event has two very different meanings that the plain function can't
 * distinguish: "every relay answered and none had it" versus "nothing answered
 * before the timeout". Callers that write a negative cache MUST tell them
 * apart — `fetchProfile` didn't, and a relay wobble during sign-in
 * (damus 503, two others refusing connections) negative-cached a kind:0 that
 * existed on five relays, pinning a bare npub for the full 15-minute miss TTL.
 * Same discipline `fetchFollowList` applies with its `ok` flag and
 * `resolveProfilesForNotes` with `firstHealthy`.
 *
 * `trustworthy` is true when an event arrived, or when every relay we actually
 * REACHED sent a real EOSE and there was at least one of them.
 *
 * It used to be `best !== null || aggregate oneose fired`, and that aggregate
 * cannot carry the weight — two different non-answers are folded into it and
 * both report as an answered query:
 *
 *   - nostr-tools SYNTHESIZES an eose on a timer (`AbstractRelay`'s
 *     `baseEoseTimeout`, 4400ms) when a relay never sends one. This function's
 *     4000ms default happens to sit just under that, so it escaped — by 400ms,
 *     and by accident. Any caller passing a longer `maxWait` did not.
 *   - A failed connection also counts toward the aggregate, so with nothing
 *     reachable it fires immediately and vacuously: measured at 19ms with no
 *     network in the sibling implementation. The old note above — "an EOSE
 *     means every *reachable* relay confirmed none" — is true and is not
 *     enough, because it is vacuously true when the reachable set is EMPTY.
 *     Offline therefore read as proof of absence, which is exactly what this
 *     flag exists to prevent.
 *
 * That mattered most for the two callers that write on the strength of it:
 * `fetchProfile`'s negative cache (the incident described above), and
 * `fetchRawProfile`, whose result decides whether an editor may safely publish
 * over the user's existing kind:0 — a falsely-trustworthy empty read there is
 * how profile fields get silently dropped.
 *
 * So relays are subscribed to individually and counted. A relay that never
 * connects drops out of the denominator rather than blocking the read (a
 * permanently dead default would otherwise degrade every read forever); a
 * relay that connects and then hangs is a genuine unknown and degrades it.
 *
 * See github.com/ChadFarrow/PC20-Nostr/specs/pc20-favorites.md
 * ("An aggregate EOSE is not automatically an answer").
 */
export async function fetchLatestEventDetailed(
  relays: string[],
  filter: Filter,
  maxWait = QUERY_MAX_WAIT_MS,
): Promise<{ event: Event | null; trustworthy: boolean }> {
  return withPool(relays, async (pool) => {
    const deadline = Date.now() + maxWait;
    let best: Event | null = null;
    let reached = 0; // relays that accepted a connection
    let answered = 0; // ...of those, the ones that sent a REAL eose in time
    // Set once the first matching event arrives, so the remaining relays get a
    // short grace window to offer a newer version rather than the full maxWait.
    let graceDeadline = Infinity;

    try {
      await Promise.all(
        relays.map(async (url) => {
          let relay: Awaited<ReturnType<typeof pool.ensureRelay>>;
          try {
            relay = await pool.ensureRelay(url, {
              // Capped below the overall deadline: sized to the whole remaining
              // budget, one dead relay spends the entire window failing.
              connectionTimeout: Math.min(CONNECT_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
            });
          } catch {
            // Never connected. NOT an answer — counting it as one is what made
            // an offline device look trustworthy.
            return;
          }
          reached += 1;

          await new Promise<void>((resolveOne) => {
            let done = false;
            let sub: { close: () => void } | null = null;
            const finish = () => {
              if (done) return;
              done = true;
              clearInterval(ticker);
              try { sub?.close(); } catch { /* already closed / never opened */ }
              resolveOne();
            };
            // Polled rather than a single timer because `graceDeadline` is set
            // by whichever relay answers first, which may not be this one.
            const ticker = setInterval(() => {
              if (Date.now() >= Math.min(deadline, graceDeadline)) finish();
            }, 50);
            try {
              sub = relay.subscribe([filter], {
                // Past our own deadline so the library's synthetic eose can
                // never fire inside the window and pose as an answer. Kept
                // small: closing a subscription does not clear this timer, so a
                // large value leaves it pending long after we've returned.
                eoseTimeout: maxWait + 1_000,
                onevent(e: Event) {
                  if (e.pubkey && filter.authors && !filter.authors.includes(e.pubkey)) return;
                  if (!best || e.created_at > best.created_at) best = e;
                  if (graceDeadline === Infinity) {
                    graceDeadline = Date.now() + FIRST_EVENT_GRACE_MS;
                  }
                },
                oneose() {
                  answered += 1;
                  finish();
                },
              });
            } catch {
              finish();
            }
          });
        }),
      );
    } catch {
      return { event: null, trustworthy: false };
    }

    // An event in hand is its own proof the query worked. Otherwise every relay
    // we could reach must have said "I have none", and there must have been at
    // least one — a bare timeout, a hung relay, or no connectivity is not
    // evidence of anything.
    return { event: best, trustworthy: best !== null || (reached > 0 && answered === reached) };
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
 *   - `quietMs` after the last event arrived (set > 0 to enable — backstops a
 *     connected-but-stalled relay that never sends EOSE; leave 0 for the
 *     profile path, which relies on the all-found exit + EOSE),
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
  quietMs = 0,
): Promise<CollectResult> {
  const byId = new Map<string, Event>();
  const seenAuthors = new Set<string>();
  const want = new Set(expectedAuthors);
  let allEosed = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      try { sub?.close(); } catch { /* already closed */ }
      resolve();
    };
    // (Re)arm the quiet-period timer on each event so the scan resolves once
    // the live relays stop trickling, rather than waiting out the slowest one.
    const bumpQuiet = () => {
      if (quietMs <= 0) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
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
          bumpQuiet();
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
