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
  /**
   * Per-track mode: the bucket already paid for the run currently in progress,
   * cleared by the engine as soon as a different target becomes current.
   *
   * **On the LEDGER, not the context, because the money is on the ledger.** The
   * context is rebuilt on every reload, Fast Refresh and item change while the
   * balance is restored from `bmb:stream_pending` — so a guard living there
   * meant a refresh mid-song wiped "already paid" and charged the same track
   * again thirty seconds later. Reported as an accrual that emptied on settle
   * and then climbed straight back.
   *
   * Exact rather than time-based: a reload two minutes into a five-minute song
   * is still the same run, and any time window short enough to allow a genuine
   * replay is short enough to let that through.
   */
  creditedRun?: string;
  /**
   * Per-track mode: when each bucket was last credited, across runs.
   *
   * Does the job `creditedRun` can't — a *slow* socket flap (A→B→A over more
   * than the minimum-play window) ends the run legitimately and would otherwise
   * pay the same song twice. Persisted for the same reason as `creditedRun`.
   */
  creditedAt?: Record<string, number>;
  /**
   * Playback time (ms) that advanced but hasn't been billed yet — see accrue().
   *
   * Position arrives as a floored whole second pushed from `timeupdate`, while
   * the engine ticks on its own 1 Hz timer. The two drift, so a tick sometimes
   * spans two position steps and sometimes none. Without this field the
   * `min(wall, position)` rule discards the surplus from the double step and
   * bills nothing for the empty one — a permanent, one-directional
   * under-payment that never self-corrects.
   */
  posCarryMs: number;
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

/**
 * The rate a user gets when they flip streaming on without ever having typed a
 * number. It exists because the control is a switch, not a form: "on" has to
 * mean something immediately.
 *
 * Pinned here rather than left inline in the UI because it is a number the user
 * never chose and never saw before money started moving — 10 sats/min is
 * 600 sats an hour, which is roughly what people actually stream. Changing it
 * silently changes what "on" costs everyone who never touched the field.
 */
export const DEFAULT_STREAM_RATE_PER_MIN = 10;

/**
 * Upper bound on a streaming rate, in sats per minute. A guard rail, not a
 * product limit: the rate is multiplied by elapsed time and paid on a timer
 * with no confirmation, so an implausible stored value has to be treated as
 * corruption rather than as an instruction. Anyone who wants to send more than
 * this in a minute wants the boost button, which asks first.
 *
 * Lives here beside the other money bounds so `check:stream` freezes it —
 * it used to sit in lib/storage.ts, outside anything that pins it.
 */
export const STREAM_RATE_MAX_PER_MIN = 10_000;

/**
 * The per-track amount a user gets when they switch the unit to "track" without
 * ever having typed a number — the `DEFAULT_STREAM_RATE_PER_MIN` of that mode,
 * and pinned for the same reason: money moves on a number the user never chose.
 *
 * 100 sats is roughly what one track earned under the default rate, so flipping
 * the unit doesn't silently change the order of magnitude of a session. It is a
 * starting point, not a recommendation — the whole point of per-track is that
 * the listener picks what a song is worth to them.
 */
export const DEFAULT_STREAM_AMOUNT_PER_TRACK = 100;

/**
 * Upper bound on a per-track amount, in sats. Same argument as
 * `STREAM_RATE_MAX_PER_MIN`: corruption protection, not a product limit, because
 * this number is paid on a track change with no confirmation step.
 *
 * Deliberately generous relative to the rate ceiling rather than tighter — at
 * 10,000 sats/min a four-minute track already clears 40,000, so a per-track
 * ceiling below that would reject amounts the rate path permits for the same
 * song. Anyone wanting to send more than this to one artist wants the boost
 * button, which asks first.
 */
export const STREAM_AMOUNT_MAX_SATS = 100_000;

/**
 * How long a target must be the current one before it earns a per-track credit.
 *
 * A live show's payment target changes for things that are not songs — the host
 * shares a photo, puts a phone number on screen, flips to a promo — and each is
 * its own block. Those SHOULD earn: they are the show, and the host is who the
 * listener chose. What must not earn is a target nobody actually spent any time
 * on. Two photos landed 16 seconds apart on a real broadcast and fired two full
 * payments; this is the line between "the host moved on" and "the host flicked
 * past".
 *
 * Thirty seconds is short enough that nothing real misses out and long enough
 * that paging through images costs nothing. It is a floor on ATTENTION, not a
 * spending cap: a block that clears it earns the full amount however long it
 * then runs, which is the whole point of the mode.
 *
 * **Deliberately NOT a filter on Split Kit's block `type`.** Refusing
 * `chapter`/`podcast` blocks was built and then removed: it would have cut a
 * show's own segments out of a mode whose amount the listener chose for the
 * show. The kind is still carried for diagnostics (`bmbLive().target.blockType`)
 * — it just doesn't gate payment.
 */
export const STREAM_TRACK_MIN_PLAY_MS = 30_000;

/**
 * How long a bucket is immune from a SECOND per-track credit.
 *
 * Distinct from the minimum above, and both are needed. The minimum stops a
 * target that never really settled; this stops one that settled twice. The live
 * target can oscillate without the music changing — a dropped socket hands
 * ownership back to the RSS poller and the reconnect hands it back again — and
 * a flap slower than the minimum would otherwise re-credit the same song.
 */
export const STREAM_TRACK_CREDIT_DEBOUNCE_MS = 60_000;


/**
 * Ceiling on the unbilled position surplus a ledger may carry.
 *
 * Two seconds is comfortably more than the sub-second phase drift this is meant
 * to absorb, and small enough that the one case where the carry changes an
 * outcome — a ledger holding a carry that then sleeps — is bounded at a third
 * of a sat. Bigger would start to look like the "wall clock alone bills sleep"
 * failure that `min(wall, position)` exists to prevent.
 */
export const STREAM_POS_CARRY_MAX_MS = 2_000;

/**
 * How far a position delta may exceed its wall-clock delta before it's read as
 * a seek rather than drift. Anything at or beyond this discards the carry: a
 * jump is not drift, and letting a forward seek fund later idle ticks would
 * reintroduce exactly what the min() rule prevents.
 */
export const STREAM_SEEK_TOLERANCE_MS = 2_000;

export function createLedger(key: string, nowMs: number): StreamLedger {
  return {
    key,
    buckets: {},
    lastTickMs: nowMs,
    lastPositionSec: 0,
    lastSettleMs: nowMs,
    posCarryMs: 0,
  };
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
 * **The surplus from a double position step is carried, not discarded**
 * (`posCarryMs`). Position is a floored whole second pushed by `timeupdate`;
 * the engine ticks on its own 1 Hz timer. The two drift, so a tick occasionally
 * spans two position steps and the next spans none. Taking `min()` per tick
 * clips the double and bills nothing for the empty one, and because `min()`
 * only ever clips upward, the error never cancels — it is a permanent
 * one-directional under-payment (0.1–2.5% depending on how jittery `timeupdate`
 * delivery is). Carrying the surplus lets the empty tick spend what the double
 * tick genuinely observed.
 *
 * **The carry can never make a tick bill more than its own wall clock** — the
 * `min(wallMs, …)` clip is applied after the carry is added, which is what
 * keeps every rule above intact. It is discarded outright on a seek, a pause, a
 * non-finite position, or a delta past the tick cap: a jump is not drift, and a
 * forward seek funding later idle ticks would reintroduce the exact failure the
 * min() rule exists to prevent.
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
  const finite = Number.isFinite(positionSec);
  const pos = finite ? positionSec : ledger.lastPositionSec;
  const wallMs = nowMs - ledger.lastTickMs;
  const posMs = (pos - ledger.lastPositionSec) * 1000;

  // A seek (either direction), a non-finite position, or a delta past the tick
  // cap invalidates the carry. Only sub-second drift is drift.
  const seeked =
    !finite
    || posMs < 0
    || posMs - wallMs > STREAM_SEEK_TOLERANCE_MS
    || posMs > STREAM_MAX_TICK_MS;
  const carryIn = seeked || !playing ? 0 : ledger.posCarryMs;

  // Every non-accruing exit clears the carry: it represents playback time, and
  // a pause or a stall means there wasn't any.
  const stamped: StreamLedger = {
    ...ledger,
    lastTickMs: nowMs,
    lastPositionSec: pos,
    posCarryMs: 0,
  };
  if (!playing || !(ratePerMin > 0) || !finite) return stamped;

  // The carry is added BEFORE the wall clip, never after — that ordering is
  // what guarantees a tick can't bill more time than actually passed.
  const elapsedMs = Math.min(Math.max(0, Math.min(wallMs, posMs + carryIn)), STREAM_MAX_TICK_MS);
  // A seek zeroes the carry on the way OUT as well as on the way in. Zeroing
  // only `carryIn` still banks the seek's own excess — a 10-minute scrub would
  // leave a full carry behind for the next idle ticks to spend, which is the
  // precise failure min(wall, position) exists to prevent.
  const posCarryMs = seeked
    ? 0
    : Math.min(Math.max(0, carryIn + posMs - elapsedMs), STREAM_POS_CARRY_MAX_MS);
  if (elapsedMs <= 0) return { ...stamped, posCarryMs };

  const msat = (elapsedMs / 60_000) * ratePerMin * 1000;
  return {
    ...stamped,
    posCarryMs,
    buckets: distribute(ledger.buckets, msat, allocation ?? [{ bucket: HOST_BUCKET, fraction: 1 }]),
  };
}

/**
 * Credit a FIXED sum, independent of elapsed time — the per-track payment mode.
 *
 * The rate path pays `rate × time`, so a six-minute song earns three times what
 * a two-minute one does for the same attention. Per-track mode pays the same
 * amount for either, which is how a listener actually thinks about what a song
 * is worth. This is a different payment *policy*, not a different payment path:
 * the sum lands in the ordinary per-bucket ledger and settles through the same
 * `settleBatch`, boundary edge and boostagram as everything else.
 *
 * It shares `distribute` with `accrue` deliberately, so a block with a
 * `remotePercentage` below 100 splits the fixed amount between track and host
 * on exactly the same rule — and the conservation guarantee (every msat lands
 * in exactly one bucket, shortfall to the host) holds identically.
 *
 * **Time bookkeeping is NOT touched here.** The engine still runs `accrue` with
 * `ratePerMin: 0` on every tick in this mode, which stamps `lastTickMs` /
 * `lastPositionSec` and clears the carry without accruing. Skipping that would
 * leave the clock fields stale, and switching the unit back to per-minute
 * mid-show would then bill one enormous catch-up tick.
 *
 * A non-finite or non-positive `msat` returns the ledger untouched rather than
 * poisoning a bucket with NaN — a bucket that can never be settled or cleared.
 */
export function creditFixed(
  ledger: StreamLedger,
  args: {
    msat: number;
    /** Where the fixed sum goes. Omitted = all to the host's value block. */
    allocation?: StreamAllocation[];
    /** The track bucket being paid. Recorded on the ledger so the guards
     *  against paying it twice survive a reload — see `creditedRun`. */
    bucket?: string;
    nowMs?: number;
  },
): StreamLedger {
  const { msat, allocation, bucket, nowMs } = args;
  if (!Number.isFinite(msat) || msat <= 0) return ledger;
  const next: StreamLedger = {
    ...ledger,
    buckets: distribute(ledger.buckets, msat, allocation ?? [{ bucket: HOST_BUCKET, fraction: 1 }]),
  };
  if (bucket && typeof nowMs === 'number' && Number.isFinite(nowMs)) {
    next.creditedRun = bucket;
    next.creditedAt = { ...ledger.creditedAt, [bucket]: nowMs };
  }
  return next;
}

/**
 * Forget the credited-run marker once a different target is current.
 *
 * Called every tick with whatever is playing now. Returns the ledger UNTOUCHED
 * when there is nothing to clear, so it can't churn object identity 60 times a
 * minute — the ledger is persisted to localStorage on a schedule and compared
 * by the UI's change signature.
 */
export function clearCreditedRun(ledger: StreamLedger, currentBucket: string | null): StreamLedger {
  if (!ledger.creditedRun || ledger.creditedRun === currentBucket) return ledger;
  const next = { ...ledger };
  delete next.creditedRun;
  return next;
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
 * Which track an allocation is crediting, or null when it's all going to the
 * host — no valueTimeSplit covers this position, or the show has none.
 *
 * Exists so the engine can notice a track BOUNDARY and settle there. Batching
 * straight through one isn't merely a worse label on the payment: a track that
 * straddles the ten-minute mark is paid TWICE — a partial run at the mark, the
 * remainder in a later batch — so on a 111-minute playlist of ~4-minute tracks
 * the window boundaries cost roughly twice the payments they save. Settling at
 * the boundary makes it exactly one payment per track, which is cheaper AND the
 * thing a listener would describe.
 *
 * Forcing here is safe because `settleBatch` still applies the per-bucket floor
 * and returns the ledger UNTOUCHED when nothing clears it — so a boundary that
 * arrives with dust in the bucket is a genuine no-op and doesn't restamp the
 * interval the host bucket is still waiting on.
 *
 * A host-only allocation returns null rather than HOST_BUCKET, so the gap
 * between two tracks reads as "the track ended" — which it did.
 */
export function allocationTrackBucket(allocation: StreamAllocation[]): string | null {
  for (const a of allocation) {
    if (a.bucket !== HOST_BUCKET && a.fraction > 0) return a.bucket;
  }
  return null;
}

/**
 * Stable key for a track across replays.
 *
 * Lives here rather than in streaming.ts because a live target needs the same
 * key and `lib/v4v/live-value.ts` is imported BY streaming.ts — a second copy
 * of the format string is how two callers silently stop agreeing on which
 * bucket a track's sats are in.
 *
 * `fallbackId` is for a target that names no remote item at all: a Split Kit
 * block for a track that isn't in any feed still needs a stable identity, or
 * every push mints a new bucket and strands the last one's accrual. It is used
 * ONLY when there is no remote item, so a real one produces a byte-identical
 * key to before. The `t:` prefix is shared, so `fundedBuckets`' host-first sort
 * and every `bucket !== HOST_BUCKET` test are unaffected.
 */
export function trackBucket(
  // Structural, not `ValueTimeSplit`, so this file keeps its no-imports rule and
  // stays loadable by `node --experimental-strip-types` (see the header).
  split: { remoteItem?: { feedGuid?: string; itemGuid?: string } },
  fallbackId?: string,
): string {
  const feedGuid = split.remoteItem?.feedGuid;
  const itemGuid = split.remoteItem?.itemGuid;
  if (!feedGuid && !itemGuid && fallbackId) return `t:${fallbackId}`;
  return `t:${feedGuid ?? ''}:${itemGuid ?? ''}`;
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

/** One bucket's payment, produced by settleBatch. */
export interface SettleRun {
  bucket: string;
  sats: number;
}

/**
 * Decide the whole batch: which buckets pay now, and what the ledger looks like
 * afterwards.
 *
 * **The settle interval is evaluated ONCE, here, for the entire batch — never
 * per bucket.** That is the entire reason this function exists rather than the
 * caller looping over `settlePlan`. `settlePlan` stamps `lastSettleMs` on the
 * ledger it returns, so a loop that adopts each result as the input to the next
 * checks bucket 2 against a stamp bucket 1 wrote microseconds earlier — and
 * bucket 2, and every bucket after it, silently fails the gate. It shipped that
 * way: a music show with a host bucket plus fifteen tracks drained ONE bucket
 * per ten minutes, so in practice nothing settled during the episode at all and
 * everything bunched into the force-settle at the end. The bug is invisible on
 * an ordinary podcast, which only ever has one bucket.
 *
 * The per-bucket FLOOR is still enforced, inside `settlePlan` — a bucket under
 * it carries to the next batch, across tracks and across replays.
 *
 * `recipientCountFor` is a callback for the same reason `accrue` takes an
 * `allocation`: which recipients a bucket pays is a Podcasting 2.0 question,
 * and this module deliberately imports nothing.
 */
export function settleBatch(
  ledger: StreamLedger,
  args: {
    nowMs: number;
    force?: boolean;
    recipientCountFor: (bucket: string) => number;
  },
): { runs: SettleRun[]; nextLedger: StreamLedger } {
  const { nowMs, force = false, recipientCountFor } = args;
  const due = force || nowMs - ledger.lastSettleMs >= STREAM_SETTLE_INTERVAL_MS;
  if (!due) return { runs: [], nextLedger: ledger };

  let next = ledger;
  const runs: SettleRun[] = [];
  // Iterate the SNAPSHOT, not `next`: settlePlan deletes drained keys, and
  // host-first ordering has to stay stable across the batch.
  for (const bucket of fundedBuckets(ledger)) {
    // force: true — the interval was already decided above, for all of them.
    const plan = settlePlan(next, {
      bucket,
      nowMs,
      recipientCount: recipientCountFor(bucket),
      force: true,
    });
    if (!plan) continue;
    next = plan.nextLedger;
    runs.push({ bucket, sats: plan.sats });
  }
  return { runs, nextLedger: next };
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
