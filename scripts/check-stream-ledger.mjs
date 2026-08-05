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

import {
  accrue,
  accruedSats,
  createLedger,
  fundedBuckets,
  HOST_BUCKET,
  isStaleLedger,
  msUntilSettle,
  settlePlan,
  STREAM_MAX_TICK_MS,
  STREAM_MIN_SETTLE_SATS,
  STREAM_PENDING_MAX_AGE_MS,
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

// --- Settlement ------------------------------------------------------------

console.log('\nsettlePlan — thresholds');
{
  const l = listen(createLedger('k', T0), { seconds: 600, ratePerMin: 10 });
  const now = T0 + 600_000;
  check(
    'below the interval, no settle',
    settlePlan({ ...l, lastSettleMs: now - 1000 }, { bucket: HOST_BUCKET, nowMs: now, recipientCount: 3 }),
    null,
  );
  const plan = settlePlan(l, { bucket: HOST_BUCKET, nowMs: now, recipientCount: 3 });
  check('interval elapsed → settles', plan?.sats, 100);
  // Spent to zero, so the key is dropped rather than left as a 0 entry — a
  // fifty-track show would otherwise persist fifty dead buckets.
  check('…and the emptied bucket is dropped', plan?.nextLedger.buckets[HOST_BUCKET], undefined);
  check('…leaving nothing owed', accruedSats(plan.nextLedger), 0);
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
  // 16.666 sats accrued, 16 sent — the remainder is the user's, not the void.
  checkClose('…and carries the sub-sat remainder', plan?.nextLedger.buckets[HOST_BUCKET], l.buckets[HOST_BUCKET] - 16_000);
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

console.log('\nreadouts');
{
  const l = createLedger('k', T0);
  check('countdown starts at the full interval', msUntilSettle(l, T0), STREAM_SETTLE_INTERVAL_MS);
  check('countdown floors at 0 when overdue', msUntilSettle(l, T0 + 900_000), 0);
  check('fresh ledger is not stale', isStaleLedger(l, T0 + 3600_000), false);
  check('a day-old ledger is stale', isStaleLedger(l, T0 + 86_400_001), true);
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
