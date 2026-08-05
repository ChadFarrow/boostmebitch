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

/** Play `seconds` of audio in `stepSec` ticks, wall clock and position in step. */
function listen(ledger, { seconds, ratePerMin, stepSec = 1, startMs = T0, startPos = 0 }) {
  let l = ledger;
  for (let s = stepSec; s <= seconds; s += stepSec) {
    l = accrue(l, {
      nowMs: startMs + s * 1000,
      positionSec: startPos + s,
      playing: true,
      ratePerMin,
    });
  }
  return l;
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
  checkClose('…and no msat dust left over', l.accruedMsat, 100_000);
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
  check('6 h asleep (position frozen) accrues nothing', l.accruedMsat, 0);
}
{
  // Dragging the scrubber forward 10 minutes in one second of real time.
  const l = accrue(createLedger('k', T0), {
    nowMs: T0 + 1000,
    positionSec: 600,
    playing: true,
    ratePerMin: 10,
  });
  checkClose('seeking forward bills only elapsed wall time', l.accruedMsat, 10 * 1000 / 60);
}
{
  const seeked = accrue(
    { ...createLedger('k', T0), lastPositionSec: 600 },
    { nowMs: T0 + 1000, positionSec: 0, playing: true, ratePerMin: 10 },
  );
  check('seeking backward never accrues negative', seeked.accruedMsat, 0);
}
{
  const paused = accrue(createLedger('k', T0), {
    nowMs: T0 + 60_000,
    positionSec: 60,
    playing: false,
    ratePerMin: 10,
  });
  check('paused accrues nothing', paused.accruedMsat, 0);
  check('…but still stamps the clock', paused.lastTickMs, T0 + 60_000);
  // If a pause didn't re-stamp, resuming would bill the entire pause as one
  // giant delta.
  const resumed = accrue(paused, {
    nowMs: T0 + 61_000,
    positionSec: 61,
    playing: true,
    ratePerMin: 10,
  });
  checkClose('…so resuming bills one second, not the whole pause', resumed.accruedMsat, 10 * 1000 / 60);
}
{
  const off = listen(createLedger('k', T0), { seconds: 600, ratePerMin: 0 });
  check('rate 0 accrues nothing', off.accruedMsat, 0);
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
  checkClose('a 24 h delta is capped at 5 min', jumped.accruedMsat, 10 * STREAM_MAX_TICK_MS / 60);
}
{
  // Media that hasn't loaded reports NaN — it must not poison the ledger.
  const nan = accrue(createLedger('k', T0), {
    nowMs: T0 + 1000,
    positionSec: NaN,
    playing: true,
    ratePerMin: 10,
  });
  check('NaN position accrues nothing', nan.accruedMsat, 0);
  check('…and leaves the last position intact', nan.lastPositionSec, 0);
}

// --- Settlement ------------------------------------------------------------

console.log('\nsettlePlan — thresholds');
{
  const l = listen(createLedger('k', T0), { seconds: 600, ratePerMin: 10 });
  const now = T0 + 600_000;
  check(
    'below the interval, no settle',
    settlePlan({ ...l, lastSettleMs: now - 1000 }, { nowMs: now, recipientCount: 3 }),
    null,
  );
  const plan = settlePlan(l, { nowMs: now, recipientCount: 3 });
  check('interval elapsed → settles', plan?.sats, 100);
  checkClose('…and the ledger is debited by exactly that', plan?.nextLedger.accruedMsat, 0);
  check('…and the settle clock resets', plan?.nextLedger.lastSettleMs, now);
}
{
  // 5 sats is under STREAM_MIN_SETTLE_SATS — carry, don't send dust.
  const l = listen(createLedger('k', T0), { seconds: 30, ratePerMin: 10 });
  check('under the minimum carries even when forced', settlePlan(l, {
    nowMs: T0 + 30_000, recipientCount: 2, force: true,
  }), null);
  check('…and the accrual is untouched', accruedSats(l), 5);
}
{
  // More recipients than STREAM_MIN_SETTLE_SATS: splitSats guarantees 1 sat
  // each by pulling from the largest allocation, so a 12-sat batch across 20
  // recipients starves legs. The floor has to rise with the recipient count.
  const l = listen(createLedger('k', T0), { seconds: 72, ratePerMin: 10 });
  check('12 sats across 20 recipients carries', settlePlan(l, {
    nowMs: T0 + 72_000, recipientCount: 20, force: true,
  }), null);
  check('12 sats across 5 recipients settles', settlePlan(l, {
    nowMs: T0 + 72_000, recipientCount: 5, force: true,
  })?.sats, 12);
}
{
  const l = listen(createLedger('k', T0), { seconds: 100, ratePerMin: 10 });
  const plan = settlePlan(l, { nowMs: T0 + 100_000, recipientCount: 1, force: true });
  check('forced settle skips the interval wait', plan?.sats, 16);
  // 16.666 sats accrued, 16 sent — the remainder is the user's, not the void.
  checkClose('…and carries the sub-sat remainder', plan?.nextLedger.accruedMsat, l.accruedMsat - 16_000);
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
