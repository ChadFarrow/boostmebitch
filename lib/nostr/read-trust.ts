// ---------------------------------------------------------------------------
// Whether the ABSENCE of a result from a relay read can be believed.
//
// DELIBERATELY IMPORT-FREE. `scripts/check-readtrust.mjs` loads this module
// directly under plain Node to pin the decision, and every import here — even a
// type-only one, since the relative specifiers in this repo carry no extension
// — would break that. A reimplemented copy in the check script would stay green
// while the shipping rule drifted, which is the exact failure being guarded.
// Same arrangement as `favorites-merge.ts`.
//
// The rule is specified externally, alongside the wire format that leans on it:
// github.com/ChadFarrow/PC20-Nostr/specs/pc20-favorites.md — see "Never write
// on top of a read you didn't get" and "An aggregate EOSE is not automatically
// an answer".
// ---------------------------------------------------------------------------

/**
 * How far past our own deadline to push the relay library's synthetic EOSE.
 *
 * nostr-tools fakes an EOSE on a timer when a relay never sends one
 * (`Subscription.fire()` arms `setTimeout(receivedEose, eoseTimeout)`, default
 * `baseEoseTimeout` = 4400 ms). There is no way to tell that one from a real
 * EOSE at the callback — `receivedEose()` is the same function either way — so
 * the only defence is to make sure it cannot fire inside the window we are
 * counting in. A relay that accepted the socket and then went silent would
 * otherwise be indistinguishable from one that answered "I have none".
 *
 * That the app's `QUERY_MAX_WAIT_MS` (4000) currently beats 4400 by 400 ms is
 * an accident, not a design: `FEED_QUERY_MAX_WAIT_MS` is 8000 and loses the
 * race outright, which is why `collectEventsByAuthors` has been reporting
 * synthetic EOSEs as real ones.
 *
 * Kept SMALL on purpose. `Subscription.close()` does not clear
 * `eoseTimeoutHandle` — only `receivedEose()` does — so this timer outlives the
 * subscription and will call `oneose` on a closed sub after we have already
 * resolved. A large margin just leaves it pending for longer.
 */
export const SYNTHETIC_EOSE_MARGIN_MS = 750;

export function syntheticEoseTimeoutFor(maxWait: number): number {
  return maxWait + SYNTHETIC_EOSE_MARGIN_MS;
}

export interface ReadTrustInput {
  /** A matching event arrived. Proof the query worked, whatever else did. */
  eventInHand: boolean;
  /** Relays that accepted a connection AND stayed up long enough to answer. */
  reached: number;
  /** Of those, the ones that sent an EOSE inside the window. */
  answered: number;
}

/**
 * `trustworthy = event_in_hand or (reached > 0 and answered == reached)`.
 *
 * Both halves of that are load-bearing, and the old implementation — trusting
 * nostr-tools' aggregate `oneose` — got the second one exactly backwards:
 *
 *   - **`reached > 0`.** A failed connection calls `handleClose(i)`, which
 *     calls `handleEose(i)`, so with nothing reachable the aggregate fires
 *     immediately and vacuously — measured at 19 ms with no network at all.
 *     "Every reachable relay confirmed none" is trivially true when the
 *     reachable set is empty, which makes being offline read as a cleared
 *     library. In this app that meant an offline hydrate took the `'ok'` branch
 *     and replaced the store with the empty result.
 *   - **Never-connected relays are excluded from `reached`**, rather than
 *     counted as answers. Requiring every *listed* relay to answer would mean
 *     one permanently dead entry in a default list leaves every read degraded
 *     forever — and dead entries in default lists are common and long-lived,
 *     precisely because nothing surfaces them. A relay that connects and then
 *     hangs is a different thing: a genuine unknown, still in `reached`, and it
 *     correctly degrades the read.
 *
 * `>=` rather than `===` so a miscount can only ever fail open on the
 * arithmetic, never wedge every read of the session at degraded.
 */
export function readIsTrustworthy({ eventInHand, reached, answered }: ReadTrustInput): boolean {
  if (eventInHand) return true;
  return reached > 0 && answered >= reached;
}

/** The subset of a Nostr event this module needs. Structural so that pinning
 *  it costs no import — see the header. */
export interface EventShape {
  pubkey: string;
  kind: number;
  tags: string[][];
}

/** What a read was actually asking for. Every field optional: a caller pins
 *  only what it cares about, and an empty expectation accepts anything. */
export interface ReadExpectation {
  pubkey?: string;
  kinds?: number[];
  /** The `d` tag value, for addressable events. `''` matches an absent `d`. */
  dTag?: string;
}

/**
 * Does this event answer the question we asked?
 *
 * Applied at INTAKE, before the created_at comparison — never to the winner.
 * A foreign event carrying a newer `created_at` otherwise takes the `latest`
 * slot on its timestamp, and discarding it afterwards throws away the genuine
 * event it displaced, turning a good read into an empty one. That is the very
 * state this module exists to keep separate from a real absence.
 *
 * nostr-tools already runs `verifyEvent` and `matchFilters` before `onevent`,
 * so in the ordinary case this is redundant — deliberately. That check is the
 * library's invariant, not ours: it disappears silently if a relay is ever
 * added to `trustedRelayURLs` or the pool is swapped. And the moment two `d`
 * tags share one subscription — which the spec explicitly permits as the
 * efficient implementation — `matchFilters` accepts both and only a predicate
 * like this one can tell them apart.
 */
export function acceptsEvent(expect: ReadExpectation, event: EventShape): boolean {
  if (expect.pubkey !== undefined && event.pubkey !== expect.pubkey) return false;
  if (expect.kinds !== undefined && !expect.kinds.includes(event.kind)) return false;
  if (expect.dTag !== undefined) {
    const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    if (d !== expect.dTag) return false;
  }
  return true;
}
