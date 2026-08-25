import type { Event, Filter, SimplePool } from 'nostr-tools';
import { withPool, QUERY_MAX_WAIT_MS, FEED_QUERY_MAX_WAIT_MS } from './pool';
import {
  acceptsEvent,
  readIsTrustworthy,
  syntheticEoseTimeoutFor,
  type ReadExpectation,
} from './read-trust';

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
  return (await fetchLatestEventDetailed(relays, filter, maxWait)).event;
}

export interface DetailedRead {
  event: Event | null;
  /** Relays that accepted a connection and stayed up long enough to answer. */
  reached: number;
  /** Of those, the ones that sent an EOSE inside the window. */
  answered: number;
  /** Whether a null `event` may be believed. See `readIsTrustworthy`. */
  trustworthy: boolean;
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
 * **This counts relays itself rather than trusting the library's aggregate
 * EOSE**, which folds two non-answers into a single "the query completed"
 * callback: a synthesized EOSE on a timer, and a failed connection. See
 * `readIsTrustworthy` for what each one costs. That is why this opens a
 * subscription per relay instead of calling `subscribeMany` — the aggregate is
 * the only thing `subscribeMany` exposes, and it is the thing that is wrong.
 *
 * The change is behaviour-compatible except where it is the fix: a relay that
 * connected and then hung already degraded the read (the 4000 ms hard timer
 * beat the 4400 ms synthetic EOSE), and a dead relay in the defaults still
 * doesn't degrade it. What changes is that **zero relays reached is no longer
 * proof of absence** — being offline used to return `trustworthy: true` in
 * about 19 ms.
 *
 * Pass `expect` to reject non-matching events at intake; see `acceptsEvent`.
 */
export async function fetchLatestEventDetailed(
  relays: string[],
  filter: Filter,
  maxWait = QUERY_MAX_WAIT_MS,
  expect?: ReadExpectation,
): Promise<DetailedRead> {
  return withPool(relays, async (pool) => {
    let best: Event | null = null;
    const { reached, answered } = await perRelayRead(
      pool,
      relays,
      filter,
      maxWait,
      FIRST_EVENT_GRACE_MS,
      (e) => {
        // Reject at intake, never on the winner: a foreign event with a newer
        // created_at would otherwise take the slot and, discarded later, take
        // the genuine event with it.
        if (expect && !acceptsEvent(expect, e)) return false;
        if (!best || e.created_at > best.created_at) best = e;
        return true;
      },
    );
    return {
      event: best,
      reached,
      answered,
      trustworthy: readIsTrustworthy({ eventInHand: best !== null, reached, answered }),
    };
  });
}

/**
 * The per-relay subscription scaffold both detailed reads run on.
 *
 * **Extracted rather than copied, because this is where the trust arithmetic
 * lives.** `reached` and `answered` feed `readIsTrustworthy`, which is the one
 * boolean every "don't write over what you couldn't read" guard in this app is
 * downstream of. Two copies of the counting is how the two come to disagree
 * about what a degraded read is — and the disagreement is silent, because both
 * return plausible numbers.
 *
 * The subtleties it owns, each of which is a way to miscount:
 *
 *  - A relay that never connects is excluded from the denominator entirely,
 *    not counted as an answer and not counted as a failure. Requiring every
 *    LISTED relay to answer would leave one dead default degrading every read
 *    forever.
 *  - A relay that connects and then closes without answering is REMOVED from
 *    `reached`: we learned nothing from it. A relay that connects and hangs —
 *    no close, no EOSE — stays counted and unanswered, which correctly
 *    degrades the read.
 *  - `eoseTimeout` is pushed past our own deadline by `syntheticEoseTimeoutFor`
 *    so the library's synthesized EOSE cannot fire inside the window and pose
 *    as a real answer.
 *  - `outstanding` hitting zero is what the aggregate EOSE used to tell us.
 *
 * `onEvent` returns whether the event COUNTED, which is what arms the grace
 * timer — so a caller filtering at intake does not start the clock on an event
 * it rejected. `graceMs <= 0` disables the early finish entirely.
 */
async function perRelayRead(
  pool: SimplePool,
  relays: string[],
  filter: Filter,
  maxWait: number,
  graceMs: number,
  onEvent: (e: Event) => boolean,
): Promise<{ reached: number; answered: number }> {
  try {
    return await new Promise<{ reached: number; answered: number }>((resolve) => {
      let settled = false;
      let reached = 0;
      let answered = 0;
      // Relays not yet in a terminal state (connect-failed, answered, or closed
      // on us). Hitting zero means there is nothing left to wait for.
      let outstanding = relays.length;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      const subs: { close: (reason?: string) => void }[] = [];

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (graceTimer) clearTimeout(graceTimer);
        for (const sub of subs) {
          try { sub.close(); } catch { /* already closed / never opened */ }
        }
        resolve({ reached, answered });
      };

      const hardTimer = setTimeout(finish, maxWait);
      if (relays.length === 0) { finish(); return; }

      const eoseTimeout = syntheticEoseTimeoutFor(maxWait);

      for (const url of relays) {
        // One terminal outcome per relay. `close()` in finish() re-enters
        // `onclose` for every sub, and the library's synthetic EOSE fires on an
        // already-closed sub ~SYNTHETIC_EOSE_MARGIN_MS later, so both paths
        // have to be idempotent per relay.
        let done = false;
        const terminal = (fn: () => void) => {
          if (done) return;
          done = true;
          fn();
          outstanding -= 1;
          if (outstanding <= 0) finish();
        };

        pool
          .ensureRelay(url)
          // No `connectionTimeout`: ensureRelay applies it only when it
          // CONSTRUCTS the relay, i.e. once per URL for the pool's lifetime, so
          // whichever caller touches a relay first would set it for everyone.
          // The 4400 ms default outlives our window anyway, which is the
          // behaviour we want — a relay that never connects simply never
          // enters `reached`.
          .then((relay) => {
            if (settled) return;
            reached += 1;
            try {
              subs.push(
                relay.subscribe([filter], {
                  eoseTimeout,
                  onevent(e: Event) {
                    if (!onEvent(e)) return;
                    if (graceMs > 0 && !graceTimer) {
                      graceTimer = setTimeout(finish, graceMs);
                    }
                  },
                  oneose() {
                    terminal(() => { answered += 1; });
                  },
                  onclose() {
                    // Closed before answering. We learned nothing from it, so
                    // drop it from the denominator rather than degrading the
                    // whole read — a hang (no close, no EOSE) is the case that
                    // stays counted and unanswered.
                    terminal(() => { reached -= 1; });
                  },
                }),
              );
            } catch {
              // send() on a socket that died between connect and REQ.
              terminal(() => { reached -= 1; });
            }
          })
          .catch(() => {
            // Never connected — excluded from the denominator entirely.
            terminal(() => {});
          });
      }
    });
  } catch {
    return { reached: 0, answered: 0 };
  }
}

export interface DetailedCollect {
  /** Every matching event across the relay union, deduped by id. */
  events: Event[];
  reached: number;
  answered: number;
  /**
   * Every relay we reached actually answered, so this is the WHOLE set those
   * relays hold — not merely "some arrived".
   *
   * **This is a stricter question than `DetailedRead.trustworthy`, and the
   * difference is the point of this function.** `readIsTrustworthy` short-
   * circuits on `eventInHand`, which is right for its question — *may I believe
   * this absence* — because one matching event proves the query worked. For a
   * SUM it is wrong: one receipt arriving out of eighty-four is an event in
   * hand and a badly incomplete total, and a caller that published it would
   * state a figure far below the truth.
   *
   * So this calls the same pinned predicate with `eventInHand: false` forced,
   * reducing it to `reached > 0 && answered >= reached`. Reuse the function,
   * decline the shortcut. Do not "simplify" it by passing
   * `events.length > 0` — that restores exactly the shortcut this exists to
   * avoid.
   */
  complete: boolean;
}

/**
 * Collect EVERY event matching `filter`, and report whether the set is whole.
 *
 * For callers that must sum or count rather than pick a winner. Unlike
 * {@link collectEventsByAuthors} this does per-relay accounting instead of
 * trusting nostr-tools' aggregate EOSE, which fires vacuously when nothing is
 * reachable — an aggregate that says "everyone answered" about an empty
 * reachable set is how an offline device comes to believe a total is zero.
 *
 * **There is deliberately no early exit.** `fetchLatestEventDetailed` finishes
 * a grace period after the first event because it only wants the newest one;
 * doing that here would truncate the set every time, systematically and
 * silently undercounting. This waits for EOSE or `maxWait`.
 */
export async function collectEventsDetailed(
  relays: string[],
  filter: Filter,
  maxWait = FEED_QUERY_MAX_WAIT_MS,
  expect?: ReadExpectation,
): Promise<DetailedCollect> {
  return withPool(relays, async (pool) => {
    const byId = new Map<string, Event>();
    const { reached, answered } = await perRelayRead(
      pool,
      relays,
      filter,
      maxWait,
      0, // no grace exit — see above
      (e) => {
        if (expect && !acceptsEvent(expect, e)) return false;
        if (!byId.has(e.id)) byId.set(e.id, e);
        return true;
      },
    );
    return {
      events: Array.from(byId.values()),
      reached,
      answered,
      complete: readIsTrustworthy({ eventInHand: false, reached, answered }),
    };
  });
}

export interface CollectResult {
  /** Every matching event collected across the relay union, deduped by id. */
  events: Event[];
  /**
   * Aggregate EOSE fired — every queried relay either reached
   * end-of-stored-events within the window or failed to connect (nostr-tools
   * folds a failed connection into the aggregate). When true an author's
   * absence is *probably* trustworthy; when false the query was degraded.
   *
   * **Weaker than `fetchLatestEventDetailed`'s `trustworthy`, on purpose.**
   * This path collects across many authors and relays, where per-relay
   * accounting buys much less, so it keeps the aggregate — but the aggregate
   * still fires vacuously when nothing is reachable. Callers gating a negative
   * cache on this should pair it with `gotAnyEvent`.
   *
   * It used to be worse than that: with no `maxWait` passed to the library,
   * every connected relay got a SYNTHESIZED EOSE at 4400 ms, and this path's
   * 8000 ms window meant those fake EOSEs always won the race — so `allEosed`
   * was reporting "everyone answered" for relays that had said nothing at all.
   */
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
        // subscribeMany's `maxWait` is used for ONE thing — it becomes each
        // subscription's `eoseTimeout` — so this pushes the library's
        // synthesized EOSE past our own deadline instead of letting it fire
        // inside the window and pose as an answer. It does not close anything.
        maxWait: syntheticEoseTimeoutFor(maxWait),
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
