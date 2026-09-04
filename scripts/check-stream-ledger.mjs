// Pins the streaming-sats accrual math.
//
// Usage:
//   npm run check:stream
//
// Run it after ANY edit to lib/v4v/stream-ledger.ts.
//
// Why this one earns a check script, alongside the key derivations and the two
// sanitizers: every OTHER payment in this app is a button someone pressed with
// an amount they typed. Streaming spends money on a timer, unattended, with no
// confirmation step and — until the wallet balance visibly drifts — no feedback
// at all. An off-by-60 here doesn't throw and doesn't fail typecheck. It either
// quietly drains a wallet at 60× the rate the user chose, or quietly pays
// nothing while the UI insists it's streaming. Both read as "working".
//
// `--experimental-strip-types` lets this .mjs import the real .ts module, so the
// pin executes production code rather than a copy of it. That's the whole
// point: a copy stays green while the shipping numbers drift, which is the
// exact failure being guarded.
//
// Two stderr warnings are expected and harmless: ExperimentalWarning (type
// stripping) and the "Reparsing as ES module" notice. Do NOT silence the second
// by adding "type": "module" to package.json — that reinterprets
// postcss.config.js / tailwind.config.js and can break the build.
//
// ---------------------------------------------------------------------------
// A vector that passes the moment it is written has proved nothing, so every
// vector added for the playback-clock / track-round-up change was replayed
// against the implementation it replaced and against the obvious wrong version
// of the new one. Reproduce either by checking out the previous
// lib/v4v/stream-ledger.ts, or by deleting FLOOR_EPSILON_MSAT from payableSats,
// and re-running.
//
// Thirteen fail against the PRE-CHANGE ledger (wall-clock gate, floor-only
// rounding): the two interval-gate vectors, "wall clock alone does not settle",
// "a track bucket rounds up to its artist", "…and the track bucket is drained,
// not carried", "…but the payout clock still advances", "before the interval
// nothing settles", "…and the ledger is returned untouched", "the batch
// consumes exactly one interval of the payout clock", "a stalled window does
// not settle short", and all four countdown vectors.
//
// One fails against a bare `Math.ceil` with no epsilon, and ONLY that one:
// "float dust above a whole sat does not round a track up". It is the single
// thing standing between an exact 100-sat window and a 101.
//
// The rest are the must-still-work half and legitimately pass against both —
// "the host bucket floors", the clean (unstalled) 100-sat window, "round-up
// does not lift a sub-floor track bucket over the gate", the two conservation
// bounds, "a batch that pays nothing consumes no clock". An input the older
// implementation also handled is a property of that input, not a hole; those
// guard the new code against the next edit, not against the last one.
// ---------------------------------------------------------------------------

import {
  accrue,
  accruedSats,
  allocationTrackBucket,
  clearCreditedRun,
  creditFixed,
  STREAM_TRACK_CREDIT_DEBOUNCE_MS,
  STREAM_TRACK_MIN_PLAY_MS,
  STREAM_ENDED_OBSERVATIONS,
  endedVerdict,
  trackBucket,
  createLedger,
  DEFAULT_STREAM_AMOUNT_PER_TRACK,
  DEFAULT_STREAM_RATE_PER_MIN,
  fundedBuckets,
  HOST_BUCKET,
  isStaleLedger,
  msUntilSettle,
  settleBatch,
  settlePlan,
  STREAM_AMOUNT_MAX_SATS,
  STREAM_MAX_TICK_MS,
  STREAM_MIN_SETTLE_SATS,
  STREAM_PENDING_MAX_AGE_MS,
  STREAM_POS_CARRY_MAX_MS,
  STREAM_RATE_MAX_PER_MIN,
  STREAM_SETTLE_INTERVAL_MS,
} from '../lib/v4v/stream-ledger.ts';

let failures = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ok   ${label}`);
    return true;
  }
  console.error(`  FAIL ${label}\n       expected: ${expected}\n       actual:   ${actual}`);
  failures++;
  return false;
}

// The ledger carries UNROUNDED msat on purpose (see accrue), so sub-sat
// expectations are compared with a tolerance far tighter than a millisat.
// Anything that fails this is a real arithmetic change, not float noise.
function checkClose(label, actual, expected) {
  if (Math.abs(actual - expected) < 1e-6) {
    console.log(`  ok   ${label}`);
    return true;
  }
  console.error(`  FAIL ${label}\n       expected: ~${expected}\n       actual:   ${actual}`);
  failures++;
  return false;
}

const T0 = 1_700_000_000_000; // fixed epoch — nothing here may read the clock

/** Play `seconds` of audio in `stepSec` ticks, wall clock and position in step.
 *  `allocate(position)` mimics the engine's allocationAt() when given. */
function listen(ledger, { seconds, ratePerMin, stepSec = 1, startMs = T0, startPos = 0, allocate }) {
  let l = ledger;
  for (let s = stepSec; s <= seconds; s += stepSec) {
    const positionSec = startPos + s;
    l = accrue(l, {
      nowMs: startMs + s * 1000,
      positionSec,
      playing: true,
      ratePerMin,
      allocation: allocate ? allocate(positionSec) : undefined,
    });
  }
  return l;
}

/**
 * Play `steps.length` one-second wall-clock ticks where the POSITION advances
 * by a caller-chosen amount each tick.
 *
 * This is the real-world shape `listen()` can't produce: position reaches the
 * store as a floored whole second pushed from `timeupdate`, while the engine
 * ticks on its own 1 Hz timer, so the two drift and a tick sometimes sees two
 * position steps and sometimes none. `steps` is that sequence in seconds.
 */
function driftListen(ledger, { steps, ratePerMin, startMs = T0, startPos = 0 }) {
  let l = ledger;
  let pos = startPos;
  let ms = startMs;
  for (const step of steps) {
    pos += step;
    ms += 1000;
    l = accrue(l, { nowMs: ms, positionSec: pos, playing: true, ratePerMin });
  }
  return l;
}

/**
 * A ledger with the payout clock parked at `billedMs`.
 *
 * The clock counts PLAYBACK, so a vector can no longer fake an un-elapsed
 * interval by rewinding `lastSettleMs` or by choosing a small `nowMs` — those
 * gate nothing now. This is the knob that does.
 */
function withBilled(ledger, billedMs) {
  return { ...ledger, billedMs };
}

/** Stand-in for the engine's allocationAt over a fixed track list. */
function tracksAllocator(tracks) {
  return (positionSec) => {
    const t = tracks.find((x) => positionSec >= x.start && positionSec < x.start + x.duration);
    if (!t) return [{ bucket: HOST_BUCKET, fraction: 1 }];
    const pct = t.remotePct ?? 100;
    return [
      { bucket: t.bucket, fraction: pct / 100 },
      { bucket: HOST_BUCKET, fraction: 1 - pct / 100 },
    ];
  };
}

// --- Constants are part of the contract ------------------------------------
// A settle interval or floor that silently changed is a behaviour change users
// feel in their wallet, so they're pinned like any other vector.

console.log('constants');
check('settle interval is 10 min', STREAM_SETTLE_INTERVAL_MS, 600_000);
check('minimum settle is 10 sats', STREAM_MIN_SETTLE_SATS, 10);
check('max single tick is 5 min', STREAM_MAX_TICK_MS, 300_000);
check('pending accrual expires after 24 h', STREAM_PENDING_MAX_AGE_MS, 86_400_000);
// The rate a user gets by flipping a switch, having typed nothing. It is the
// only number in this file that spends money without the user ever having seen
// it, so it is pinned twice — once as itself, once as what it costs per hour.
check('default rate is 10 sats/min', DEFAULT_STREAM_RATE_PER_MIN, 10);
check('…which is 600 sats/hour', DEFAULT_STREAM_RATE_PER_MIN * 60, 600);
check('rate ceiling is 10,000 sats/min', STREAM_RATE_MAX_PER_MIN, 10_000);
// The per-track pair is the same promise in the other unit, and it is the one
// that shipped unpinned: the amount a user gets by switching the unit to
// "track" having typed nothing. Its hourly cost depends on how fast the show
// changes target, which is exactly why the number itself has to be deliberate —
// on a Split Kit broadcast every promo and shared photo is a target of its own.
check('default is 100 sats/track', DEFAULT_STREAM_AMOUNT_PER_TRACK, 100);
check('…so a 12-track hour costs 1,200 sats', DEFAULT_STREAM_AMOUNT_PER_TRACK * 12, 1_200);
check('per-track ceiling is 100,000 sats', STREAM_AMOUNT_MAX_SATS, 100_000);
check('position carry is capped at 2 s', STREAM_POS_CARRY_MAX_MS, 2_000);

// --- Accrual ---------------------------------------------------------------

console.log('\naccrue — the headline case');
{
  // Ten minutes at 10 sats/min is exactly 100 sats. If this line ever fails,
  // read the number before touching anything: 6000 means per-second is being
  // treated as per-minute, 1.67 means the reverse.
  const l = listen(createLedger('k', T0), { seconds: 600, ratePerMin: 10 });
  check('10 min @ 10 sats/min = 100 sats', accruedSats(l), 100);
  checkClose('…and no msat dust left over', accruedSats(l) * 1000, 100_000);
}
{
  const l = listen(createLedger('k', T0), { seconds: 60, ratePerMin: 1 });
  check('1 min @ 1 sat/min = 1 sat', accruedSats(l), 1);
}
{
  // Sub-sat-per-tick rates are why the ledger is denominated in msat. Rounding
  // each tick to whole sats would floor 3,600 times an hour and pay nothing.
  const l = listen(createLedger('k', T0), { seconds: 3600, ratePerMin: 1 });
  check('1 hour @ 1 sat/min = 60 sats (no per-tick rounding loss)', accruedSats(l), 60);
}

console.log('\naccrue — a backgrounded tab is real listening');
{
  // iOS suspends timers while the audio keeps playing, so one tick can cover
  // minutes. Wall clock AND position both advanced, so it must be paid in full.
  // Counting ticks instead of measuring them under-pays this by 60×.
  const l = accrue(createLedger('k', T0), {
    nowMs: T0 + 60_000,
    positionSec: 60,
    playing: true,
    ratePerMin: 10,
  });
  check('one 60 s tick accrues a full minute', accruedSats(l), 10);
}

console.log('\naccrue — what must NOT be billed');
{
  // A suspended laptop: hours of wall clock, but the audio never advanced.
  const l = accrue(createLedger('k', T0), {
    nowMs: T0 + 6 * 3600_000,
    positionSec: 0,
    playing: true,
    ratePerMin: 10,
  });
  check('6 h asleep (position frozen) accrues nothing', accruedSats(l), 0);
}
{
  // Dragging the scrubber forward 10 minutes in one second of real time.
  const l = accrue(createLedger('k', T0), {
    nowMs: T0 + 1000,
    positionSec: 600,
    playing: true,
    ratePerMin: 10,
  });
  checkClose('seeking forward bills only elapsed wall time', (l.buckets[HOST_BUCKET] ?? 0), 10 * 1000 / 60);
}
{
  const seeked = accrue(
    { ...createLedger('k', T0), lastPositionSec: 600 },
    { nowMs: T0 + 1000, positionSec: 0, playing: true, ratePerMin: 10 },
  );
  check('seeking backward never accrues negative', (seeked.buckets[HOST_BUCKET] ?? 0), 0);
}
{
  const paused = accrue(createLedger('k', T0), {
    nowMs: T0 + 60_000,
    positionSec: 60,
    playing: false,
    ratePerMin: 10,
  });
  check('paused accrues nothing', (paused.buckets[HOST_BUCKET] ?? 0), 0);
  check('…but still stamps the clock', paused.lastTickMs, T0 + 60_000);
  // If a pause didn't re-stamp, resuming would bill the entire pause as one
  // giant delta.
  const resumed = accrue(paused, {
    nowMs: T0 + 61_000,
    positionSec: 61,
    playing: true,
    ratePerMin: 10,
  });
  checkClose('…so resuming bills one second, not the whole pause', (resumed.buckets[HOST_BUCKET] ?? 0), 10 * 1000 / 60);
}
{
  const off = listen(createLedger('k', T0), { seconds: 600, ratePerMin: 0 });
  check('rate 0 accrues nothing', (off.buckets[HOST_BUCKET] ?? 0), 0);
}
{
  // A clock jump (NTP correction, DST write) with position agreeing is the one
  // case the cap exists for.
  const jumped = accrue(createLedger('k', T0), {
    nowMs: T0 + 24 * 3600_000,
    positionSec: 24 * 3600,
    playing: true,
    ratePerMin: 10,
  });
  checkClose('a 24 h delta is capped at 5 min', (jumped.buckets[HOST_BUCKET] ?? 0), 10 * STREAM_MAX_TICK_MS / 60);
}
{
  // Media that hasn't loaded reports NaN — it must not poison the ledger.
  const nan = accrue(createLedger('k', T0), {
    nowMs: T0 + 1000,
    positionSec: NaN,
    playing: true,
    ratePerMin: 10,
  });
  check('NaN position accrues nothing', (nan.buckets[HOST_BUCKET] ?? 0), 0);
  check('…and leaves the last position intact', nan.lastPositionSec, 0);
}

// --- The position carry ----------------------------------------------------
// Position reaches the ledger as a floored whole second pushed from
// `timeupdate`; the engine ticks on its own 1 Hz timer. They drift, so a tick
// sometimes spans two position steps and the next spans none. min(wall, pos)
// clips the double and bills nothing for the empty one, and because min() only
// ever clips upward the error never cancels — it is a permanent, always-under
// payment. These pin the carry that fixes it, and the bound that keeps it from
// becoming the "wall clock alone bills sleep" failure it sits next to.

console.log('\naccrue — the position carry');
{
  // The pathological sequence: a tick spanning two position steps, then one
  // spanning none, over four wall seconds. Without a carry this bills 2 s
  // instead of 4 — a 50% loss in the worst case.
  const drift = driftListen(createLedger('k', T0), { steps: [2, 0, 2, 0], ratePerMin: 60 });
  const steady = driftListen(createLedger('k', T0), { steps: [1, 1, 1, 1], ratePerMin: 60 });
  checkClose(
    'a tick that sees two position steps banks one for the tick that sees none',
    (drift.buckets[HOST_BUCKET] ?? 0),
    4 * 1000,   // 4 s at 60 sats/min = 4 sats = 4000 msat
  );
  checkClose(
    '…billing exactly what the same four seconds bill with no drift at all',
    (drift.buckets[HOST_BUCKET] ?? 0),
    (steady.buckets[HOST_BUCKET] ?? 0),
  );
}
{
  // The carry only reaches FORWARD, so an empty tick with nothing yet banked is
  // lost — there is no backward carry and adding one would mean billing time
  // before observing it. That costs ONE step per session, at the head, and is
  // pinned here so it stays a bounded head loss and never becomes per-tick
  // again: 60 s of the worst-case alternation bills 59, not 30.
  const steps = [];
  for (let i = 0; i < 30; i++) steps.push(0, 2);
  const l = driftListen(createLedger('k', T0), { steps, ratePerMin: 60 });
  checkClose('a session-long drift loses one step at the head and nothing after',
    (l.buckets[HOST_BUCKET] ?? 0), 59 * 1000);
}
{
  // THE bound, and the reason every "must NOT be billed" pin above survives:
  // the carry is added BEFORE the wall clip, so no run of ticks can ever bill
  // more time than actually passed. Here five seconds of position arrive in one
  // wall second — which the tolerance reads as a seek — and four wall seconds
  // buy at most four seconds of listening no matter what.
  const l = driftListen(createLedger('k', T0), { steps: [0, 0, 0, 5], ratePerMin: 60 });
  check('the carry never lets a run of ticks bill more than its wall clock',
    (l.buckets[HOST_BUCKET] ?? 0) <= 4 * 1000, true);
  checkClose('…and a 5 s jump in one wall second bills that one second', (l.buckets[HOST_BUCKET] ?? 0), 1000);
}
{
  const carried = driftListen(createLedger('k', T0), { steps: [0, 2], ratePerMin: 60 });
  check('a carry is left behind for the next tick', carried.posCarryMs > 0, true);
  // A jump is not drift. Letting a forward seek fund later idle ticks would
  // reintroduce exactly what min(wall, position) exists to prevent.
  const seeked = accrue(carried, {
    nowMs: T0 + 3000, positionSec: 600, playing: true, ratePerMin: 60,
  });
  check('a forward seek clears the carry', seeked.posCarryMs, 0);
  const paused = accrue(carried, {
    nowMs: T0 + 3000, positionSec: 2, playing: false, ratePerMin: 60,
  });
  check('a pause clears the carry', paused.posCarryMs, 0);
  const nan = accrue(carried, {
    nowMs: T0 + 3000, positionSec: NaN, playing: true, ratePerMin: 60,
  });
  check('a non-finite position clears the carry', nan.posCarryMs, 0);
}
{
  // Ten seconds of position arriving in one tick is a seek by the tolerance
  // rule, so nothing banks — the cap is belt-and-braces on top of that.
  const l = driftListen(createLedger('k', T0), { steps: [0, 0, 0, 0, 0, 10], ratePerMin: 60 });
  check('the carry never exceeds its cap', l.posCarryMs <= STREAM_POS_CARRY_MAX_MS, true);
}
{
  // The ONE semantic the carry genuinely changes, pinned so changing it back is
  // deliberate: a ledger already holding a carry, that then sleeps, spends the
  // carry. That is correct — it is time genuinely played and not yet billed —
  // and it is bounded at 2 s, i.e. a third of a sat at 10 sats/min. Compare
  // with the "6 h asleep accrues nothing" pin above, which is a FRESH ledger
  // and still bills exactly zero.
  const carried = driftListen(createLedger('k', T0), { steps: [0, 2], ratePerMin: 60 });
  const slept = accrue(carried, {
    nowMs: T0 + 2000 + 6 * 3600_000,
    positionSec: 2,
    playing: true,
    ratePerMin: 60,
  });
  const billed = (slept.buckets[HOST_BUCKET] ?? 0) - (carried.buckets[HOST_BUCKET] ?? 0);
  check(
    '6 h asleep holding a carry bills the carry and not one ms more',
    billed <= 60 * STREAM_POS_CARRY_MAX_MS / 60 && billed >= 0,
    true,
  );
}

// --- Live shows: metering against a live clock -----------------------------
//
// A live item is metered by the SAME accrue() as an on-demand episode — there
// is no live mode, deliberately. What makes that safe is that a live source's
// currentTime is a monotonically growing clock, so `min(wall, position)` reads
// the same as wall time. These pin the two shapes a live stream actually
// produces, because the failure they'd hide is silent in both directions: a
// live path that bills nothing looks identical to one that's working, and one
// that bills wall-clock unchecked would charge a sleeping laptop.
console.log('\naccrue — a live stream\'s clock');
{
  // 1. The ordinary case: an icecast/HLS clock ticking in step with the wall.
  const l = listen(createLedger('live', T0), { seconds: 600, ratePerMin: 10 });
  check('a live clock in step with the wall bills the wall', accruedSats(l), 100);
}
{
  // 2. hls.js catching up to the live edge after a background: position jumps
  //    far past the wall. This must bill the WALL, never the jump — the same
  //    protection a forward scrub gets, arriving by a different route.
  let l = createLedger('live', T0);
  l = accrue(l, { nowMs: T0 + 1_000, positionSec: 1, playing: true, ratePerMin: 60 });
  const before = l.buckets[HOST_BUCKET] ?? 0;
  l = accrue(l, { nowMs: T0 + 2_000, positionSec: 61, playing: true, ratePerMin: 60 });
  const billed = (l.buckets[HOST_BUCKET] ?? 0) - before;
  check('a 60 s jump to the live edge bills one tick, not sixty', billed, 1000);
  check('…and clears the carry, so the jump cannot fund later idle ticks', l.posCarryMs, 0);
}
{
  // 3. A source that re-sources and resets its clock to 0. Bills nothing for
  //    that tick rather than going negative or wrapping.
  let l = createLedger('live', T0);
  l = accrue(l, { nowMs: T0 + 1_000, positionSec: 30, playing: true, ratePerMin: 60 });
  const before = l.buckets[HOST_BUCKET] ?? 0;
  l = accrue(l, { nowMs: T0 + 2_000, positionSec: 0, playing: true, ratePerMin: 60 });
  check('a live re-source resetting to 0 bills nothing', (l.buckets[HOST_BUCKET] ?? 0), before);
  check('…and stamps the new position, so the next tick is not a giant delta',
    l.lastPositionSec, 0);
}
{
  // 4. The one that would be silent: a source whose clock never advances at
  //    all. This bills NOTHING, and that is the documented behaviour — pinned
  //    so it's a known limitation rather than a surprise. <StreamMeter> showing
  //    a stuck 0 is the tell.
  let l = createLedger('live', T0);
  for (let s = 1; s <= 60; s += 1) {
    l = accrue(l, { nowMs: T0 + s * 1000, positionSec: 0, playing: true, ratePerMin: 60 });
  }
  check('a live clock pinned at 0 bills nothing (known limitation)', accruedSats(l), 0);
}

// --- Settlement ------------------------------------------------------------

console.log('\nsettlePlan — thresholds');
{
  const l = listen(createLedger('k', T0), { seconds: 600, ratePerMin: 10 });
  const now = T0 + 600_000;
  check(
    'below the interval, no settle',
    settlePlan(withBilled(l, STREAM_SETTLE_INTERVAL_MS - 1000), {
      bucket: HOST_BUCKET, nowMs: now, recipientCount: 3,
    }),
    null,
  );
  // The gate is PLAYBACK time, so ten minutes of wall clock with the clock
  // unmoved settles nothing. This is the whole 97-instead-of-100 fix: a window
  // that stalled has not earned its payout yet, and waiting is the honest
  // answer. Rewinding lastSettleMs, which is how this vector used to fake an
  // un-elapsed interval, now gates nothing at all.
  check(
    'wall clock alone does not settle — only playback does',
    settlePlan(withBilled(l, 0), { bucket: HOST_BUCKET, nowMs: now + 3_600_000, recipientCount: 3 }),
    null,
  );
  const plan = settlePlan(l, { bucket: HOST_BUCKET, nowMs: now, recipientCount: 3 });
  check('interval elapsed → settles', plan?.sats, 100);
  // Spent to zero, so the key is dropped rather than left as a 0 entry — a
  // fifty-track show would otherwise persist fifty dead buckets.
  check('…and the emptied bucket is dropped', plan?.nextLedger.buckets[HOST_BUCKET], undefined);
  check('…leaving nothing owed', plan && accruedSats(plan.nextLedger), 0);
  check('…and the settle clock resets', plan?.nextLedger.lastSettleMs, now);
}
{
  // 5 sats is under STREAM_MIN_SETTLE_SATS — carry, don't send dust.
  const l = listen(createLedger('k', T0), { seconds: 30, ratePerMin: 10 });
  check('under the minimum carries even when forced', settlePlan(l, {
    bucket: HOST_BUCKET, nowMs: T0 + 30_000, recipientCount: 2, force: true,
  }), null);
  check('…and the accrual is untouched', accruedSats(l), 5);
}
{
  // More recipients than STREAM_MIN_SETTLE_SATS: splitSats guarantees 1 sat
  // each by pulling from the largest allocation, so a 12-sat batch across 20
  // recipients starves legs. The floor has to rise with the recipient count.
  const l = listen(createLedger('k', T0), { seconds: 72, ratePerMin: 10 });
  check('12 sats across 20 recipients carries', settlePlan(l, {
    bucket: HOST_BUCKET, nowMs: T0 + 72_000, recipientCount: 20, force: true,
  }), null);
  check('12 sats across 5 recipients settles', settlePlan(l, {
    bucket: HOST_BUCKET, nowMs: T0 + 72_000, recipientCount: 5, force: true,
  })?.sats, 12);
}
{
  const l = listen(createLedger('k', T0), { seconds: 100, ratePerMin: 10 });
  const plan = settlePlan(l, { bucket: HOST_BUCKET, nowMs: T0 + 100_000, recipientCount: 1, force: true });
  check('forced settle skips the interval wait', plan?.sats, 16);
  // 16.666 sats accrued, 16 sent — the HOST bucket carries the remainder,
  // because it accumulates all episode and is paid again and again.
  checkClose('…and the host carries the sub-sat remainder', plan?.nextLedger.buckets[HOST_BUCKET], l.buckets[HOST_BUCKET] - 16_000);
}

// The two bucket kinds get OPPOSITE rounding, because they have opposite
// lifetimes. Getting this backwards is worth real money in both directions: a
// flooring track bucket drops its remainder at the next item change (six tracks
// sharing a clean 100 sent 96), and a rounding host bucket turns an exact
// 100-sat window into 101 for every listener on an ordinary podcast.
console.log('\nsettlePlan — a track rounds up, the host floors');
{
  // The identical balance, 16.666 sats, in each kind of bucket.
  const track = 't:feed-a:item-1';
  const l = {
    ...createLedger('k', T0),
    buckets: { [HOST_BUCKET]: 16_666.6667, [track]: 16_666.6667 },
    billedMs: STREAM_SETTLE_INTERVAL_MS,
  };
  const host = settlePlan(l, { bucket: HOST_BUCKET, nowMs: T0, recipientCount: 1, force: true });
  const trk = settlePlan(l, { bucket: track, nowMs: T0, recipientCount: 1, force: true });
  check('the host bucket floors', host?.sats, 16);
  check('a track bucket rounds up to its artist', trk?.sats, 17);
  // A track plays once. "Carry the remainder" means "drop it when the item
  // changes", so the bucket is drained to nothing and its key goes.
  check('…and the track bucket is drained, not carried', trk?.nextLedger.buckets[track], undefined);
  // storage.streamPending rejects the WHOLE ledger over one negative balance,
  // which would discard every other bucket's real sats along with it.
  check(
    'a rounded-up bucket never leaves a negative balance',
    !!trk && Object.values(trk.nextLedger.buckets).every((v) => v >= 0),
    true,
  );
  // The epsilon, on the round-up side. A clean window holds a few parts in 10¹³
  // ABOVE its whole sat, so a bare Math.ceil returns 101 for an exact 100 and
  // destroys the property the payout clock exists to give.
  const clean = listen(createLedger('k', T0), { seconds: 600, ratePerMin: 10 });
  const exact = {
    ...clean,
    buckets: { [track]: clean.buckets[HOST_BUCKET] },
    billedMs: STREAM_SETTLE_INTERVAL_MS,
  };
  check(
    'float dust above a whole sat does not round a track up',
    settlePlan(exact, { bucket: track, nowMs: T0, recipientCount: 1, force: true })?.sats,
    100,
  );
}
{
  // The round-up must not be applied to the ELIGIBILITY test. 9.5 sats ceils to
  // 10, and testing the payable figure instead of the honest one would lift it
  // over a floor that exists because a 3-sat payment costs the same routing fee
  // as a 300-sat one.
  const l = {
    ...createLedger('k', T0),
    buckets: { 't:short:1': 9_500 },
    billedMs: STREAM_SETTLE_INTERVAL_MS,
  };
  check('round-up does not lift a sub-floor track bucket over the gate', settlePlan(l, {
    bucket: 't:short:1', nowMs: T0, recipientCount: 2, force: true,
  }), null);
}

// --- valueTimeSplits: a music show that changes artist mid-batch ------------
// The case this whole bucketing scheme exists for. Settlement is batched every
// ten minutes; a V4V music show hands payment to a different artist every three
// or four. One balance would have to pay whoever happened to be playing when
// the timer fired — wrong for every other artist in the window, and wrong the
// same way every time.

console.log('\nvalueTimeSplits — a batch spanning three tracks');
{
  const tracks = [
    { bucket: 't:feed-a:item-1', start: 0, duration: 200 },
    { bucket: 't:feed-b:item-2', start: 200, duration: 200 },
    { bucket: 't:feed-c:item-3', start: 400, duration: 200 },
  ];
  const l = listen(createLedger('k', T0), {
    seconds: 600,
    ratePerMin: 10,
    allocate: tracksAllocator(tracks),
  });
  check('each track is credited its own window', accruedSats(l, 't:feed-a:item-1'), 33);
  check('…the second too', accruedSats(l, 't:feed-b:item-2'), 33);
  check('…and the third', accruedSats(l, 't:feed-c:item-3'), 33);
  check('nothing leaks to the host at 100%', accruedSats(l, HOST_BUCKET), 0);
  check('the total still adds up to the rate charged', accruedSats(l), 100);
}

console.log('\nvalueTimeSplits — remotePercentage and the host share');
{
  // 90/10: the publisher keeps a tenth of each track's window.
  const tracks = [
    { bucket: 't:a:1', start: 0, duration: 300, remotePct: 90 },
    { bucket: 't:b:2', start: 300, duration: 300, remotePct: 90 },
  ];
  const l = listen(createLedger('k', T0), {
    seconds: 600,
    ratePerMin: 10,
    allocate: tracksAllocator(tracks),
  });
  // 44 and not 45 is the boundary rule below, not a rounding bug: the tick that
  // straddles 300 s is classified by where playback IS, so it lands on B.
  check('track A gets 90% of its window', accruedSats(l, 't:a:1'), 44);
  check('track B gets 90% of its window', accruedSats(l, 't:b:2'), 45);
  // The host's 10% accrues into ONE bucket across both tracks — that's what
  // makes it a single payment instead of one per track.
  check('the host share pools across tracks', accruedSats(l, HOST_BUCKET), 10);
  check('and the total is unchanged', accruedSats(l), 100);
}

console.log('\nvalueTimeSplits — gaps, floors and conservation');
{
  // Talk breaks between tracks belong to the show, not to whichever artist
  // played last.
  const tracks = [{ bucket: 't:a:1', start: 0, duration: 300 }];
  const l = listen(createLedger('k', T0), {
    seconds: 600,
    ratePerMin: 10,
    allocate: tracksAllocator(tracks),
  });
  check('an uncovered stretch pays the show', accruedSats(l, HOST_BUCKET), 50);
  check('…and the covered stretch pays the artist', accruedSats(l, 't:a:1'), 49);
}
{
  // A track that hasn't yet earned its floor must CARRY, not vanish — and must
  // still be there to top up as the same track keeps playing. This is what
  // stops a per-track scheme from rounding short tracks away every batch.
  const tracks = [{ bucket: 't:short:1', start: 0, duration: 200 }];
  const first = listen(createLedger('k', T0), {
    seconds: 30, ratePerMin: 10, allocate: tracksAllocator(tracks),
  });
  check('30 s of a track accrues 5 sats', accruedSats(first, 't:short:1'), 5);
  check('…which is under the floor, so it carries', settlePlan(first, {
    bucket: 't:short:1', nowMs: T0 + 30_000, recipientCount: 1, force: true,
  }), null);
  const more = listen(first, {
    seconds: 60, ratePerMin: 10, startMs: T0 + 30_000, startPos: 30,
    allocate: tracksAllocator(tracks),
  });
  check('playing on tops the same bucket up', accruedSats(more, 't:short:1'), 15);
  check('…and now it settles', settlePlan(more, {
    bucket: 't:short:1', nowMs: T0 + 90_000, recipientCount: 1, force: true,
  })?.sats, 15);
}
{
  // ── The boundary rule, pinned deliberately ──────────────────────────────
  // A tick is credited to whichever split covers the position playback has
  // REACHED, so the one tick straddling a track change goes entirely to the
  // incoming track. At 1 Hz that misattributes at most one second per change
  // — under 0.2 sats at a 10 sats/min rate — and it is not biased: every
  // track loses a tick at its end and gains one at its start.
  //
  // Sub-dividing the straddling tick would be exact, and is not worth the
  // complexity. But it IS a choice, so it's pinned here: if these numbers
  // move, someone changed how boundaries are attributed, and that should be
  // on purpose.
  const tracks = [
    { bucket: 't:a:1', start: 0, duration: 10 },
    { bucket: 't:b:2', start: 10, duration: 10 },
  ];
  const l = listen(createLedger('k', T0), {
    seconds: 20, ratePerMin: 60, allocate: tracksAllocator(tracks),
  });
  check('the outgoing track keeps its whole seconds', accruedSats(l, 't:a:1'), 9);
  check('the straddling tick goes to the incoming track', accruedSats(l, 't:b:2'), 10);
  check('and the tick past the last window pays the show', accruedSats(l, HOST_BUCKET), 1);
  check('nothing is created or destroyed at a boundary', accruedSats(l), 20);
}
{
  // Conservation: an allocation that doesn't add up must not quietly bill the
  // listener for sats nobody receives. The shortfall is the show's.
  const short = accrue(createLedger('k', T0), {
    nowMs: T0 + 60_000, positionSec: 60, playing: true, ratePerMin: 10,
    allocation: [{ bucket: 't:a:1', fraction: 0.5 }],
  });
  check('an under-allocated tick sends the rest to the host', accruedSats(short, HOST_BUCKET), 5);
  check('…and still totals the full minute', accruedSats(short), 10);

  const over = accrue(createLedger('k', T0), {
    nowMs: T0 + 60_000, positionSec: 60, playing: true, ratePerMin: 10,
    allocation: [{ bucket: 't:a:1', fraction: 1 }, { bucket: 't:b:2', fraction: 1 }],
  });
  check('an over-allocated tick is scaled, never inflated', accruedSats(over), 10);

  const empty = accrue(createLedger('k', T0), {
    nowMs: T0 + 60_000, positionSec: 60, playing: true, ratePerMin: 10,
    allocation: [],
  });
  check('an empty allocation falls back to the host', accruedSats(empty, HOST_BUCKET), 10);
}
{
  const l = listen(createLedger('k', T0), {
    seconds: 600,
    ratePerMin: 10,
    allocate: tracksAllocator([
      { bucket: 't:a:1', start: 0, duration: 300, remotePct: 90 },
      { bucket: 't:b:2', start: 300, duration: 300, remotePct: 90 },
    ]),
  });
  // Host first: it's the bucket that accumulates across every track, so on a
  // force-settle it's both likeliest to clear the floor and the one the
  // listener would most expect to have gone out.
  check('funded buckets list the host first', fundedBuckets(l)[0], HOST_BUCKET);
  check('…and include every credited track', fundedBuckets(l).length, 3);
}

// --- allocationTrackBucket: the track-boundary settle edge ------------------
// The engine settles when this value CHANGES, so what counts as a change is a
// money decision, not a labelling one. A track ending into a gap has to read as
// a boundary (the track is over and its bucket should go out), and a zero-weight
// entry must not read as a track — a valueTimeSplit at remotePercentage 0 sends
// everything to the host, and treating it as a track would fire a settle on
// every such window while naming an artist owed nothing.
{
  check(
    'a covered position names its track',
    allocationTrackBucket([{ bucket: 't:a:1', fraction: 0.99 }, { bucket: HOST_BUCKET, fraction: 0.01 }]),
    't:a:1',
  );
  check(
    'a gap between tracks is host-only, so no track',
    allocationTrackBucket([{ bucket: HOST_BUCKET, fraction: 1 }]),
    null,
  );
  check(
    'an ordinary podcast never names a track',
    allocationTrackBucket([]),
    null,
  );
  check(
    'a zero-weight track is not a track',
    allocationTrackBucket([{ bucket: 't:a:1', fraction: 0 }, { bucket: HOST_BUCKET, fraction: 1 }]),
    null,
  );
  // Consecutive tracks must differ, or the boundary between them is invisible
  // and the first one's bucket rides on into the second one's window.
  const a = allocationTrackBucket([{ bucket: 't:a:1', fraction: 1 }]);
  const b = allocationTrackBucket([{ bucket: 't:b:2', fraction: 1 }]);
  check('consecutive tracks are distinguishable', a !== b, true);
}

// --- creditFixed: the per-track payment mode --------------------------------
// The rate path pays `rate × time`, so a six-minute song earns three times what
// a two-minute one does. Per-track pays both the same. It shares `distribute`
// with accrue() on purpose, so the conservation guarantee and the host remainder
// have to behave identically — a divergence here would pay a different set of
// people than the rate path does for the same block.
console.log('\ncreditFixed — a fixed sum per track');
{
  const l0 = createLedger('ep', T0);
  const l = creditFixed(l0, { msat: 500_000, allocation: [{ bucket: 't:a:1', fraction: 1 }] });
  check('the whole amount lands in the track bucket', l.buckets['t:a:1'], 500_000);
  check('…and nothing leaks to the host', l.buckets[HOST_BUCKET] ?? 0, 0);
  check('500 sats credited reads as 500 sats owed', accruedSats(l), 500);
}
{
  // remotePercentage 90: the block redirects 90% and the show keeps the rest.
  // Same rule the rate path applies, because it is the same `distribute`.
  const l = creditFixed(createLedger('ep', T0), {
    msat: 500_000,
    allocation: [{ bucket: 't:a:1', fraction: 0.9 }, { bucket: HOST_BUCKET, fraction: 0.1 }],
  });
  check('a partial redirect splits the fixed sum', l.buckets['t:a:1'], 450_000);
  check('…and the host keeps the remainder', l.buckets[HOST_BUCKET], 50_000);
  check('the split conserves the whole amount',
    l.buckets['t:a:1'] + l.buckets[HOST_BUCKET], 500_000);
}
{
  // An allocation that doesn't add to 1 sends the shortfall to the host rather
  // than dropping it — dropping would make the meter overstate what was charged.
  const l = creditFixed(createLedger('ep', T0), {
    msat: 100_000,
    allocation: [{ bucket: 't:a:1', fraction: 0.25 }],
  });
  check('an under-allocation gives the shortfall to the host',
    l.buckets[HOST_BUCKET], 75_000);
  check('…conserving the total', l.buckets['t:a:1'] + l.buckets[HOST_BUCKET], 100_000);
}
{
  const l0 = createLedger('ep', T0);
  check('no allocation credits the host', creditFixed(l0, { msat: 1000 }).buckets[HOST_BUCKET], 1000);
  // A NaN or negative amount must leave the ledger ALONE. A poisoned bucket can
  // never be settled and never cleared — it would sit in bmb:stream_pending
  // forever, blocking every later settle for that item.
  check('NaN is refused outright', creditFixed(l0, { msat: NaN }), l0);
  check('Infinity is refused outright', creditFixed(l0, { msat: Infinity }), l0);
  check('a negative amount is refused', creditFixed(l0, { msat: -5000 }), l0);
  check('zero is refused', creditFixed(l0, { msat: 0 }), l0);
}
{
  // Time bookkeeping is accrue()'s job, not this one's. The engine still runs
  // accrue with ratePerMin 0 every tick in this mode precisely because these
  // fields have to keep advancing — otherwise switching the unit back to
  // per-minute mid-show bills one enormous catch-up tick.
  const l0 = createLedger('ep', T0);
  const l = creditFixed(l0, { msat: 1000 });
  check('the tick clock is untouched', l.lastTickMs, l0.lastTickMs);
  check('the position stamp is untouched', l.lastPositionSec, l0.lastPositionSec);
  check('the settle clock is untouched', l.lastSettleMs, l0.lastSettleMs);
}
{
  // Two tracks in one batch accumulate independently, exactly as the rate path's
  // buckets do — this is what lets settleBatch pay each artist their own sum.
  let l = createLedger('ep', T0);
  l = creditFixed(l, { msat: 100_000, allocation: [{ bucket: 't:a:1', fraction: 1 }] });
  l = creditFixed(l, { msat: 100_000, allocation: [{ bucket: 't:b:2', fraction: 1 }] });
  l = creditFixed(l, { msat: 100_000, allocation: [{ bucket: 't:a:1', fraction: 1 }] });
  check('a repeated track tops up its own bucket', l.buckets['t:a:1'], 200_000);
  check('…without touching the other one', l.buckets['t:b:2'], 100_000);
}

// --- per-track guards -------------------------------------------------------
// From a real 71-minute Homegrown Hits broadcast: 17 payment-target changes, and
// two of them were shared photos that landed 16 SECONDS apart, firing two full
// payments. EVERY kind of block earns — songs and the host's own segments alike,
// because the listener chose an amount for the show and a promo is the show.
// What must not earn is a target nobody spent any time on, and that is entirely
// what these two numbers do.
console.log('\nper-track guard constants');
{
  check('minimum play before a track earns is 30 s', STREAM_TRACK_MIN_PLAY_MS, 30_000);
  check('a bucket is immune from a second credit for 60 s',
    STREAM_TRACK_CREDIT_DEBOUNCE_MS, 60_000);
  // The ordering is the contract: the debounce must outlast the minimum, or a
  // socket flap could restart a run AND clear the debounce, paying one song
  // twice. Assert the relationship rather than just the two numbers.
  check('the debounce outlasts the minimum, so a flap cannot double-pay',
    STREAM_TRACK_CREDIT_DEBOUNCE_MS > STREAM_TRACK_MIN_PLAY_MS, true);
}

// --- the double-pay guards live on the LEDGER ------------------------------
// THIS SECTION EXISTS BECAUSE ITS ABSENCE LET A BUG SHIP. The guards started on
// the StreamContext, which is rebuilt on every reload, Fast Refresh and item
// change — while the balance is restored from bmb:stream_pending. So refreshing
// mid-song wiped "already paid" and charged the same track again 30 s later.
// Observed as an accrual that emptied on settle and climbed straight back.
console.log('\ncreditFixed — the markers that survive a reload');
{
  const l0 = createLedger('ep', T0);
  const l = creditFixed(l0, {
    msat: 200_000,
    allocation: [{ bucket: 't:a:1', fraction: 1 }],
    bucket: 't:a:1',
    nowMs: T0,
  });
  check('the paid bucket is marked for its run', l.creditedRun, 't:a:1');
  check('…and stamped with when it paid', l.creditedAt['t:a:1'], T0);
  // Simulate a reload: the ledger is what persists, so this is exactly what the
  // engine gets back. It must still read as paid however long ago that was.
  const reloaded = { ...l, lastTickMs: T0 + 120_000, lastSettleMs: T0 + 120_000 };
  check('two minutes later it is STILL marked paid for this run',
    reloaded.creditedRun === 't:a:1', true);
  // A settle empties the bucket but must not forget that it paid, or the very
  // next tick credits it again.
  const settled = settlePlan(l, { bucket: 't:a:1', nowMs: T0 + 1000, recipientCount: 3, force: true });
  check('a settle empties the bucket', (settled.nextLedger.buckets['t:a:1'] ?? 0), 0);
  check('…but the run marker survives it', settled.nextLedger.creditedRun, 't:a:1');
}
{
  // Without a bucket the markers are untouched — the host-only credit path.
  const l = creditFixed(createLedger('ep', T0), { msat: 1000 });
  check('a credit with no bucket sets no run marker', l.creditedRun, undefined);
}
console.log('\nclearCreditedRun — the same song must earn again later');
{
  const paid = creditFixed(createLedger('ep', T0), {
    msat: 200_000, allocation: [{ bucket: 't:a:1', fraction: 1 }], bucket: 't:a:1', nowMs: T0,
  });
  check('while the same track is current the marker stays',
    clearCreditedRun(paid, 't:a:1').creditedRun, 't:a:1');
  check('…and the ledger object is returned untouched',
    clearCreditedRun(paid, 't:a:1') === paid, true);
  check('a different track clears it', clearCreditedRun(paid, 't:b:2').creditedRun, undefined);
  check('back to the host clears it', clearCreditedRun(paid, null).creditedRun, undefined);
  // The time stamp OUTLIVES the run marker: that is what stops a slow socket
  // flap (A→B→A over more than the minimum play) paying one song twice.
  check('…but the timestamp survives, for the flap guard',
    clearCreditedRun(paid, 't:b:2').creditedAt['t:a:1'], T0);
}

// --- accrue in track mode: rate 0 must stamp but not charge ------------------
// The engine calls accrue with ratePerMin 0 on every tick in per-track mode.
// If that ever started accruing, a track-mode listener would be paying BOTH the
// fixed amount and a per-minute rate.
console.log('\naccrue — rate 0 is the per-track mode\'s clock');
{
  let l = createLedger('ep', T0);
  l = accrue(l, { nowMs: T0 + 60_000, positionSec: 60, playing: true, ratePerMin: 0 });
  check('a rate of 0 charges nothing', accruedSats(l), 0);
  // …but the payout CLOCK still runs. Per-track mode ticks accrue() with a rate
  // of 0, so a clock gated on the rate never reaches an interval settle at all:
  // a show sitting on one long track would wait for a boundary that never
  // comes, and everything would bunch into the force settle at the end.
  checkClose('…but the payout clock still advances, which is track mode\'s timer', l.billedMs, 60_000);
  check('…and no bucket was created', Object.keys(l.buckets).length, 0);
  check('…but still stamps the wall clock', l.lastTickMs, T0 + 60_000);
  check('…and still stamps the position', l.lastPositionSec, 60);
}

// --- trackBucket: which bucket a track's sats land in -----------------------
// One definition, two callers — the streaming engine and the live-value watcher
// (which is imported BY the engine, so it can't reach back into it). If those
// two ever disagree about a key, sats accrue into one bucket and settle out of
// another.
//
// `fallbackId` exists for a live target that names no remote item: a Split Kit
// block for a track that is in no feed. It must NOT be smuggled in as a fake
// remoteItem.feedGuid — both boostagram builders copy that field onto the wire
// as `remote_feed_guid`, which is specified as an RSS <podcast:guid>.
console.log('\ntrackBucket — a track\'s identity');
{
  check(
    'a real remote item keys on feed + item guid',
    trackBucket({ remoteItem: { feedGuid: 'feed-1', itemGuid: 'item-9' } }),
    't:feed-1:item-9',
  );
  check(
    'the historical format is unchanged when only a feed guid is named',
    trackBucket({ remoteItem: { feedGuid: 'feed-1' } }),
    't:feed-1:',
  );
  check(
    'a real remote item IGNORES the fallback, so existing keys never move',
    trackBucket({ remoteItem: { feedGuid: 'feed-1', itemGuid: 'item-9' } }, 'sk:block-a'),
    't:feed-1:item-9',
  );
  check(
    'with no remote item the fallback carries the identity',
    trackBucket({}, 'sk:block-a'),
    't:sk:block-a',
  );
  // THE ONE THAT MATTERS ON A LIVE SHOW. An artist playing two tracks back to
  // back pushes two blocks with IDENTICAL payees. Keyed on the payees alone the
  // second reads as "no change": no settle edge fires, both tracks accrue into
  // one bucket, and the payment credits the first track's guid. The blockGuid is
  // what tells them apart.
  check(
    'two blocks with the same payees but different ids are different buckets',
    trackBucket({}, 'sk:block-a') !== trackBucket({}, 'sk:block-b'),
    true,
  );
  check(
    'a live bucket is never the host bucket',
    trackBucket({}, 'sk:block-a') === HOST_BUCKET,
    false,
  );
  // No remote item AND no fallback is the degenerate case: it must still be a
  // stable string rather than throwing mid-broadcast.
  check('no remote item and no fallback is still a key', trackBucket({}), 't::');
}

// --- settleBatch: the whole batch settles, or none of it does ---------------
// THIS SECTION EXISTS BECAUSE ITS ABSENCE LET A BUG SHIP. The engine used to
// loop settlePlan() itself, feeding each result in as the next call's input.
// settlePlan stamps lastSettleMs on the ledger it returns, so bucket 2 was
// checked against a stamp bucket 1 had written microseconds earlier and failed
// the interval gate — as did every bucket after it. A music show with a host
// bucket plus fifteen tracks drained ONE bucket per ten minutes; in practice
// nothing settled during the episode and it all bunched into the force-settle
// at the end. Invisible on an ordinary podcast, which has one bucket.
//
// The interval now belongs to the BATCH and the floor belongs to the BUCKET.
// Keep it that way.

console.log('\nsettleBatch — every funded bucket settles together');

/** Four buckets, each well clear of any floor. */
function batchLedger() {
  return listen(createLedger('k', T0), {
    seconds: 600,
    ratePerMin: 60,
    allocate: tracksAllocator([
      { bucket: 't:a:1', start: 0, duration: 200, remotePct: 90 },
      { bucket: 't:b:2', start: 200, duration: 200, remotePct: 90 },
      { bucket: 't:c:3', start: 400, duration: 200, remotePct: 90 },
    ]),
  });
}
const anyRecipients = () => 2;

{
  // One minute of playback into a ten-minute window. `nowMs` is deliberately
  // far in the future: the gate is the payout clock, not the wall clock.
  const l = withBilled(batchLedger(), 60_000);
  const early = settleBatch(l, { nowMs: T0 + 3_600_000, recipientCountFor: anyRecipients });
  check('before the interval nothing settles', early.runs.length, 0);
  // Reference identity: an untouched batch must not churn the ledger, or the
  // engine would persist a new object every tick.
  check('…and the ledger is returned untouched', early.nextLedger, l);
}
{
  const l = batchLedger();
  const due = settleBatch(l, {
    nowMs: T0 + STREAM_SETTLE_INTERVAL_MS,
    recipientCountFor: anyRecipients,
  });
  // The pin the bug walked straight past.
  check('past the interval EVERY funded bucket settles in one batch', due.runs.length, 4);
  check('…the host is settled first', due.runs[0]?.bucket, HOST_BUCKET);
  check(
    '…and the second bucket is NOT blocked by the first bucket\'s settle stamp',
    due.runs[1] !== undefined && due.runs[1].sats > 0,
    true,
  );
  check('…the settle clock is stamped once, for the whole batch',
    due.nextLedger.lastSettleMs, T0 + STREAM_SETTLE_INTERVAL_MS);
  // Conservation across the batch, in the one direction that can still hold.
  // Nothing is paid twice and nothing vanishes, but a track bucket rounds UP,
  // so the batch may pay a little more than accrued — bounded at one sat per
  // track bucket, and never more.
  const before = Object.values(l.buckets).reduce((s, v) => s + v, 0);
  const after = Object.values(due.nextLedger.buckets).reduce((s, v) => s + v, 0);
  const paid = due.runs.reduce((s, r) => s + r.sats, 0) * 1000;
  const trackRuns = due.runs.filter((r) => r.bucket !== HOST_BUCKET).length;
  check('the batch never pays LESS than it accrued', paid + after >= before - 1e-6, true);
  check(
    '…and never more than one sat per track bucket over it',
    paid + after < before + trackRuns * 1000,
    true,
  );
  // The clock is consumed by the batch, exactly one interval of it, so the
  // overshoot from the tick that crossed the mark carries into the next window
  // instead of being discarded. Discarding it makes every window bill a little
  // over ten minutes, which surfaces as an occasional 101 among the 100s.
  checkClose(
    'the batch consumes exactly one interval of the payout clock',
    due.nextLedger.billedMs,
    l.billedMs - STREAM_SETTLE_INTERVAL_MS,
  );
}
{
  // A short track under its floor must be LEFT BEHIND while its siblings pay,
  // not drag the batch down and not be rounded away. It tops up next time.
  const l = {
    ...createLedger('k', T0),
    buckets: { [HOST_BUCKET]: 90_000, 't:short:1': 4_000 },
    billedMs: STREAM_SETTLE_INTERVAL_MS,
  };
  const due = settleBatch(l, {
    nowMs: T0 + STREAM_SETTLE_INTERVAL_MS,
    recipientCountFor: anyRecipients,
  });
  check('a bucket under its floor is left behind while its siblings settle', due.runs.length, 1);
  check('…and it is the funded one that paid', due.runs[0]?.bucket, HOST_BUCKET);
  check('…with the short bucket still carrying its balance',
    due.nextLedger.buckets['t:short:1'], 4_000);
}
{
  const l = batchLedger();
  const forced = settleBatch(l, { nowMs: T0 + 1000, force: true, recipientCountFor: anyRecipients });
  check('force settles every funded bucket regardless of the interval', forced.runs.length, 4);
}
{
  // Force does NOT override the floor: a 2-sat run across five recipients is
  // strictly worse than carrying it, which bmb:stream_pending exists to allow.
  const l = { ...createLedger('k', T0), buckets: { [HOST_BUCKET]: 2_000 } };
  const forced = settleBatch(l, { nowMs: T0 + 1000, force: true, recipientCountFor: () => 5 });
  check('force still respects the per-bucket floor', forced.runs.length, 0);
}
{
  // A due batch where every bucket sits under its floor is a genuine no-op, so
  // it must NOT consume the payout clock. Spending the clock on a batch that
  // paid nobody pushes the real payout ten more minutes of listening away,
  // every time, and the accrual just keeps climbing.
  const l = {
    ...createLedger('k', T0),
    buckets: { [HOST_BUCKET]: 2_000 },
    billedMs: STREAM_SETTLE_INTERVAL_MS + 900,
  };
  const dry = settleBatch(l, { nowMs: T0 + 1000, recipientCountFor: () => 5 });
  check('a batch that pays nothing consumes no clock', dry.runs.length, 0);
  check('…and returns the ledger untouched', dry.nextLedger, l);
}
{
  // Two windows back to back each pay exactly the rate x the interval. This is
  // the headline property of the whole change, and the reason the clock is
  // SUBTRACTED rather than zeroed — a zeroing version alternates 100/101.
  let l = createLedger('k', T0);
  const sent = [];
  for (let w = 0; w < 2; w++) {
    l = listen(l, {
      seconds: 600,
      ratePerMin: DEFAULT_STREAM_RATE_PER_MIN,
      startMs: T0 + w * 600_000,
      startPos: w * 600,
    });
    const batch = settleBatch(l, { nowMs: T0 + (w + 1) * 600_000, recipientCountFor: () => 2 });
    sent.push(batch.runs.reduce((sum, r) => sum + r.sats, 0));
    l = batch.nextLedger;
  }
  check('ten minutes of playback at the default rate settles exactly 100', sent[0], 100);
  check('…and so does the next ten minutes, with no 99/101 drift', sent[1], 100);
  check('…leaving the host bucket drained', l.buckets[HOST_BUCKET], undefined);
}
{
  // A stalled window is the case that used to pay 97. The wall clock runs the
  // whole ten minutes while the position sticks, so the ledger holds less than
  // a full window — and the payout now WAITS rather than paying short.
  const stalled = driftListen(createLedger('k', T0), {
    // 582 seconds of real playback, then 18 seconds where the position does not
    // move: a buffer stall, an HLS re-source, a hidden-tab gap.
    steps: [...Array(582).fill(1), ...Array(18).fill(0)],
    ratePerMin: DEFAULT_STREAM_RATE_PER_MIN,
  });
  const batch = settleBatch(stalled, { nowMs: T0 + 600_000, recipientCountFor: () => 2 });
  check('a stalled window does not settle short', batch.runs.length, 0);
  // Play the missing 18 seconds and it pays the full 100, not 97.
  const finished = listen(stalled, {
    seconds: 18,
    ratePerMin: DEFAULT_STREAM_RATE_PER_MIN,
    startMs: T0 + 600_000,
    startPos: 582,
  });
  const paid = settleBatch(finished, { nowMs: T0 + 618_000, recipientCountFor: () => 2 });
  check('…it settles 100 once the listening is actually done', paid.runs[0]?.sats, 100);
}

console.log('\nreadouts');
{
  const l = createLedger('k', T0);
  check('countdown starts at the full interval', msUntilSettle(l), STREAM_SETTLE_INTERVAL_MS);
  check('countdown floors at 0 when overdue',
    msUntilSettle(withBilled(l, STREAM_SETTLE_INTERVAL_MS + 300_000)), 0);
  // It counts LISTENING, so wall clock does not move it. On screen this means
  // the countdown freezes while playback is paused, which is the honest answer:
  // a paused window accrues nothing and its payout is not approaching.
  check('wall clock alone does not move the countdown',
    msUntilSettle(withBilled(l, 0)), STREAM_SETTLE_INTERVAL_MS);
  check('half a window listened leaves half the countdown',
    msUntilSettle(withBilled(l, 300_000)), 300_000);
  check('fresh ledger is not stale', isStaleLedger(l, T0 + 3600_000), false);
  check('a day-old ledger is stale', isStaleLedger(l, T0 + 86_400_001), true);
}

// ---------------------------------------------------------------------------
// endedVerdict — when a live broadcast is believed to be OVER.
//
// It gates a SETTLE, and both directions cost something real. Concluding too
// early stops paying an artist somebody is still listening to; never
// concluding leaves the remainder unsettled until the listener happens to
// pause. It lived inline inside an async fetch handler, where no check script
// could reach it, which is why it is a pure function now.
//
// Recorded as CALLS so the naive replay below is total.
// ---------------------------------------------------------------------------

console.log('\nendedVerdict — believing a broadcast is over');

const ENDED_VECTORS = [
  // The ordinary life of a healthy broadcast.
  { args: [0, 'live'], expect: { seen: 0, ended: false }, alsoNaive: true, why: 'still on air' },
  // Exempt: the naive version resets on 'live' too. Kept because the RESET is
  // the whole reason a one-regeneration dropout heals, and a future rewrite
  // that dropped it would be caught by expectation even though not by replay.
  { args: [1, 'live'], expect: { seen: 0, ended: false }, alsoNaive: true, why: 'one dropout, then back — RESETS, so a feed that skips its liveItem for one regeneration heals' },

  // Two strikes, not one.
  { args: [0, 'ended'], expect: { seen: 1, ended: false }, why: 'FIRST ended answer must not conclude' },
  { args: [1, 'ended'], expect: { seen: 2, ended: true }, alsoNaive: true, why: 'second consecutive ended concludes' },
  { args: [2, 'ended'], expect: { seen: 3, ended: true }, alsoNaive: true, why: 'stays concluded once past the threshold' },

  // 'pending' is not broadcasting either, and streaming.ts already refuses to
  // meter a pending item — so it must count, or the two disagree.
  { args: [0, 'pending'], expect: { seen: 1, ended: false }, why: 'pending counts toward ended' },
  // Exempt: both versions land on seen 2 / ended here, by coincidence — the
  // naive one concluded a poll earlier. The vector above ({args:[0,'pending']})
  // is the one that proves the difference.
  { args: [1, 'pending'], expect: { seen: 2, ended: true }, alsoNaive: true, why: 'pending can conclude it' },

  // ABSENCE IS NOT EVIDENCE. A response that omits the field says nothing:
  // it must not advance the count and must not reset one already earned.
  { args: [0, null], expect: { seen: 0, ended: false }, alsoNaive: true, why: 'null is silence, not an ending' },
  { args: [1, null], expect: { seen: 1, ended: false }, why: 'null must NOT advance a count' },
  { args: [1, undefined], expect: { seen: 1, ended: false }, why: 'undefined behaves as null' },
  { args: [2, null], expect: { seen: 2, ended: true }, why: 'null must NOT erase a verdict already reached' },
];

for (const v of ENDED_VECTORS) {
  const got = endedVerdict(...v.args);
  const want = v.expect;
  check(
    `endedVerdict(${v.args[0]}, ${JSON.stringify(v.args[1])}) — ${v.why}`,
    `${got.seen}/${got.ended}`,
    `${want.seen}/${want.ended}`,
  );
}

check('STREAM_ENDED_OBSERVATIONS is 2', STREAM_ENDED_OBSERVATIONS, 2);

// The obvious wrong version: treat any non-'live' answer as an immediate end,
// and let a missing field reset. It passes every healthy-broadcast vector and
// ends a live show on one dropped regeneration.
function naiveEnded(seen, status) {
  if (status === 'live' || status == null) return { seen: 0, ended: false };
  return { seen: seen + 1, ended: true };
}

console.log('\n  naive replay (each vector must fail against the obvious version)');
{
  let proved = 0;
  let exempt = 0;
  for (const v of ENDED_VECTORS) {
    const real = endedVerdict(...v.args);
    const naive = naiveEnded(...v.args);
    const same = real.seen === naive.seen && real.ended === naive.ended;
    if (v.alsoNaive) { exempt++; continue; }
    if (same) {
      console.error(`  FAIL vector proves nothing — naive agrees: endedVerdict(${v.args[0]}, ${JSON.stringify(v.args[1])})`);
      failures++;
    } else proved++;
  }
  console.log(`        ${proved} vector(s) proved, ${exempt} exempted as must-still-work`);
}

if (failures > 0) {
  console.error(
    `\n${failures} check(s) FAILED — THE STREAMING MATH CHANGED.\n\n` +
      'This code spends money on a timer with no confirmation step. A wrong\n' +
      'number here either drains a wallet far faster than the user chose, or\n' +
      'pays nothing while the meter claims otherwise — neither throws, and\n' +
      'neither shows up in typecheck, lint or the build.\n\n' +
      'Do not update the vectors to match. Fix the code, or if the change is\n' +
      'genuinely intended, change it deliberately and rewrite the affected\n' +
      'expectation with a comment saying why.\n' +
      'See the header of lib/v4v/stream-ledger.ts.',
  );
  process.exitCode = 1;
} else {
  console.log('\nAll streaming-ledger checks passed.');
}
