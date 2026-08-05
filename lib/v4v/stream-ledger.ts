// Accrual math for streaming sats — the arithmetic half of the streaming
// payment loop, split out of streaming.ts so it can be imported from plain Node.
//
// Deliberately carries NO `'use client'` directive and NO imports at all — same
// reasoning as lib/v4v/spark-derive.ts. streaming.ts touches the zustand store,
// the wallet rails and `window`, so `node --experimental-strip-types` can't load
// it; keeping the arithmetic here means `npm run check:stream` pins the REAL
// production code rather than a copy of it. A copy passes green while the
// shipping numbers drift, which is the exact failure being guarded.
//
// Why this file gets a check script at all: every other payment in this app is
// a button the user pressed with an amount they typed. Streaming spends money on
// a timer, unattended, with no confirmation step. An off-by-60 here doesn't throw
// — it silently drains a wallet, or silently pays nothing, and both look like
// "working" from the outside.

/**
 * The bucket every sat lands in when no `<podcast:valueTimeSplit>` is
 * redirecting it — i.e. the show's own value block. Empty string so it can't
 * collide with a track key.
 */
export const HOST_BUCKET = '';

/**
 * Where one tick's sats go, as fractions of the tick. Supplied by the caller
 * because *which* recipient is owed is a Podcasting 2.0 question (which
 * valueTimeSplit covers the current position, and its `remotePercentage`), not
 * an arithmetic one.
 */
export interface StreamAllocation {
  bucket: string;
  /** Share of the tick, 0–1. */
  fraction: number;
}

/** Unsent accrual for one item. Serialized into `bmb:stream_pending`. */
export interface StreamLedger {
  /** Item this accrual belongs to (see streamKey). */
  key: string;
  /**
   * Unsent balance per recipient target, in MILLIsats — see accrue().
   *
   * Keyed rather than a single number because a music show redirects payment
   * to a different artist every few minutes, while settlement is batched every
   * ten. A batch routinely spans three tracks, so one balance would have to be
   * paid to whichever artist happened to be playing when the timer fired —
   * wrong for the other two, and biased the same way every time.
   */
  buckets: Record<string, number>;
  /** Wall-clock ms at the last accrue() call. */
  lastTickMs: number;
  /** Playback position (seconds) at the last accrue() call. */
  lastPositionSec: number;
  /** Wall-clock ms of the last settle, or of ledger creation. */
  lastSettleMs: number;
}

/** How often accrued sats are actually paid out. */
export const STREAM_SETTLE_INTERVAL_MS = 600_000; // 10 minutes

/**
 * Floor for a payment run. Below this the batch is carried, not sent.
 *
 * Two reasons, and the second is the hard one. A 3-sat payment costs the same
 * routing fee as a 300-sat payment, so dust settlements burn most of what they
 * move. And `splitSats` guarantees every weighted recipient at least 1 sat by
 * pulling from the largest allocation — so a batch smaller than the recipient
 * count doesn't just round badly, it starves legs outright. The engine raises
 * this floor to the recipient count when a value block has more than this many
 * recipients.
 */
export const STREAM_MIN_SETTLE_SATS = 10;

/**
 * Upper bound on a single tick's elapsed time. Generous on purpose: it is a
 * sanity rail against a clock jump (NTP correction, timezone/DST write, a
 * suspended-then-resumed process reporting a wild delta), NOT the mechanism
 * that stops sleep from being billed — see accrue() for that.
 */
export const STREAM_MAX_TICK_MS = 300_000; // 5 minutes

/** A pending accrual older than this is dropped rather than paid. */
export const STREAM_PENDING_MAX_AGE_MS = 86_400_000; // 24 hours

export function createLedger(key: string, nowMs: number): StreamLedger {
  return { key, buckets: {}, lastTickMs: nowMs, lastPositionSec: 0, lastSettleMs: nowMs };
}

/**
 * Spread one tick's millisats over the allocation.
 *
 * **Conservation is the rule: every accrued msat lands in exactly one bucket.**
 * An allocation that doesn't add up is a bug in the caller's split handling,
 * and the tempting response — drop the shortfall — makes the meter lie about
 * what the listener is being charged. The remainder goes to the host instead,
 * which is also the correct Podcasting 2.0 default: a valueTimeSplit
 * *redirects* part of the show's value, so anything not redirected is simply
 * still the show's.
 */
function distribute(
  buckets: Record<string, number>,
  msat: number,
  allocation: StreamAllocation[],
): Record<string, number> {
  const next = { ...buckets };
  const add = (bucket: string, amount: number) => {
    if (amount > 0) next[bucket] = (next[bucket] ?? 0) + amount;
  };
  const usable = allocation.filter((a) => Number.isFinite(a.fraction) && a.fraction > 0);
  const total = usable.reduce((s, a) => s + a.fraction, 0);
  if (total <= 0) {
    add(HOST_BUCKET, msat);
    return next;
  }
  // Over-allocation can only be a caller bug; scaling keeps the tick's total
  // honest rather than charging more than the rate promised.
  const scale = total > 1 ? 1 / total : 1;
  for (const a of usable) add(a.bucket, msat * a.fraction * scale);
  if (total < 1) add(HOST_BUCKET, msat * (1 - total));
  return next;
}

/**
 * Advance the ledger by however much listening happened since the last call.
 *
 * **Elapsed time is `min(wall-clock delta, playback-position delta)`.** Neither
 * signal is usable alone:
 *
 * - **Wall clock alone bills sleep and stalls.** A laptop that suspends for six
 *   hours with the tab open wakes owing six hours of sats; a stalled buffer
 *   bills silence.
 * - **Position alone bills seeking.** Dragging the scrubber forward ten minutes
 *   would charge for ten minutes nobody heard.
 *
 * Taking the smaller charges only for time that BOTH advanced through and
 * played — which is also why the tick cap can be loose. This is specifically
 * what makes backgrounded mobile listening correct: iOS suspends timers while
 * the audio keeps playing, so a tick may cover minutes rather than the nominal
 * second, and both signals agree that those minutes were genuinely listened to.
 * Counting ticks instead of measuring them would under-pay such a session by up
 * to 60×.
 *
 * Accrues in millisats, **unrounded**, so a sub-sat-per-tick rate isn't
 * distorted 3,600 times an hour; only whole sats ever leave (see settlePlan).
 * Rounding each tick looks tidier and is wrong in a way that compounds: at
 * 1 Hz it biases every tick in the same direction — up to 0.5 msat each, so
 * ~1.8 sats an hour, ~3% at a 1 sat/min rate — and it always errs against
 * whichever side the rate happens to round toward. Keeping the fraction means
 * the error is bounded by the sat the ledger is carrying anyway.
 *
 * Always returns a ledger stamped with the current tick, even when nothing
 * accrued — a paused stretch must not become a giant delta the moment playback
 * resumes.
 */
export function accrue(
  ledger: StreamLedger,
  args: {
    nowMs: number;
    positionSec: number;
    playing: boolean;
    ratePerMin: number;
    /** Where this tick's sats go. Omitted = all to the host's value block. */
    allocation?: StreamAllocation[];
  },
): StreamLedger {
  const { nowMs, positionSec, playing, ratePerMin, allocation } = args;
  const pos = Number.isFinite(positionSec) ? positionSec : ledger.lastPositionSec;
  const stamped: StreamLedger = { ...ledger, lastTickMs: nowMs, lastPositionSec: pos };
  if (!playing || !(ratePerMin > 0)) return stamped;

  const wallMs = nowMs - ledger.lastTickMs;
  const posMs = (pos - ledger.lastPositionSec) * 1000;
  const elapsedMs = Math.min(Math.max(0, Math.min(wallMs, posMs)), STREAM_MAX_TICK_MS);
  if (elapsedMs <= 0) return stamped;

  const msat = (elapsedMs / 60_000) * ratePerMin * 1000;
  return {
    ...stamped,
    buckets: distribute(ledger.buckets, msat, allocation ?? [{ bucket: HOST_BUCKET, fraction: 1 }]),
  };
}

/**
 * Decide whether to pay now, and for how much.
 *
 * Returns null to keep accruing. On a settle, `nextLedger` has the paid sats
 * REMOVED (the sub-sat remainder is carried, never dropped) and the settle
 * clock reset — the caller must adopt it before awaiting the payment, or a
 * second tick spends the same sats again.
 *
 * `force` (pause, item change, tab close) skips the interval wait but NOT the
 * minimum: forcing a 2-sat run across five recipients is strictly worse than
 * carrying it to the next session, which `bmb:stream_pending` exists to allow.
 */
export function settlePlan(
  ledger: StreamLedger,
  args: { bucket: string; nowMs: number; recipientCount: number; force?: boolean },
): { sats: number; nextLedger: StreamLedger } | null {
  const { bucket, nowMs, recipientCount, force = false } = args;
  const sats = accruedSats(ledger, bucket);
  const floor = Math.max(STREAM_MIN_SETTLE_SATS, Math.max(1, recipientCount));
  if (sats < floor) return null;
  if (!force && nowMs - ledger.lastSettleMs < STREAM_SETTLE_INTERVAL_MS) return null;
  // Clamped at 0: the epsilon in accruedSats can round the last sat up out of a
  // balance a hair under it, and a negative accrual would be read back as a
  // corrupt ledger (storage.streamPending rejects one) and dropped.
  const left = Math.max(0, (ledger.buckets[bucket] ?? 0) - sats * 1000);
  const buckets = { ...ledger.buckets };
  // Drop the key once it's spent, so a fifty-track show doesn't persist fifty
  // dead entries for the rest of the episode. The threshold is the flooring
  // epsilon, not zero: an exactly-drained bucket lands a few parts in 10¹³
  // above it in binary, and `> 0` would keep that float dust — and its key —
  // alive forever.
  if (left > FLOOR_EPSILON_MSAT) buckets[bucket] = left;
  else delete buckets[bucket];
  return { sats, nextLedger: { ...ledger, buckets, lastSettleMs: nowMs } };
}

/**
 * Buckets currently holding something, host first.
 *
 * Host-first matters on a force-settle: it's the one bucket that accumulates
 * across every track, so it's both the most likely to clear the floor and the
 * one whose payment the listener would most expect to have gone through.
 */
export function fundedBuckets(ledger: StreamLedger): string[] {
  return Object.keys(ledger.buckets)
    .filter((b) => (ledger.buckets[b] ?? 0) > 0)
    .sort((a, b) => (a === HOST_BUCKET ? -1 : b === HOST_BUCKET ? 1 : a.localeCompare(b)));
}

/**
 * Whole sats currently owed — the single flooring rule, used by both the UI
 * meter and settlePlan so they can never disagree about what's payable.
 *
 * The epsilon is not decoration. Accrual sums an unrounded fraction thousands
 * of times, so a balance that is exactly 1000 msat in decimal lands a few parts
 * in 10¹³ below it in binary — and a bare floor turns that into **zero sats**.
 * Left alone it doesn't cost a rounding error, it costs a whole sat at every
 * boundary: an hour at 1 sat/min settles 59 instead of 60, forever, in the same
 * direction. The epsilon is nine orders of magnitude below a sat and nine above
 * the error it absorbs.
 */
const FLOOR_EPSILON_MSAT = 1e-6;

/** Pass a bucket for one recipient's balance; omit it for the item total. */
export function accruedSats(ledger: StreamLedger, bucket?: string): number {
  const msat =
    bucket === undefined
      ? Object.values(ledger.buckets).reduce((s, v) => s + v, 0)
      : ledger.buckets[bucket] ?? 0;
  return Math.floor((msat + FLOOR_EPSILON_MSAT) / 1000);
}

/** Ms until the next scheduled settle; 0 once it's due. For the UI readout. */
export function msUntilSettle(ledger: StreamLedger, nowMs: number): number {
  return Math.max(0, ledger.lastSettleMs + STREAM_SETTLE_INTERVAL_MS - nowMs);
}

/**
 * Whether a restored pending accrual is too old to pay. A ledger from last
 * week belongs to a listening session the user has forgotten; charging for it
 * out of nowhere is worse than dropping the sats.
 */
export function isStaleLedger(ledger: StreamLedger, nowMs: number): boolean {
  return nowMs - ledger.lastTickMs > STREAM_PENDING_MAX_AGE_MS;
}
