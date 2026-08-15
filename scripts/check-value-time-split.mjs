#!/usr/bin/env node --experimental-strip-types --no-warnings
/**
 * Pins the two pure functions that decide, for a boost pressed mid-episode,
 * WHICH artist is paid and HOW MUCH of the amount leaves the show.
 *
 *   splitAtPosition  — which <podcast:valueTimeSplit> window covers this second
 *   splitTrackAndHost — how the amount divides between the track and the show
 *
 * Both live in lib/util.ts and both are imported by more than one caller, which
 * is the entire reason they are pinned. `splitAtPosition` is shared by the boost
 * modal and lib/v4v/streaming.ts: if those two disagree about which window a
 * position falls in — by one second, at a boundary — a boost pays one artist
 * while streaming credits a different one, for the same moment of the same
 * episode, and nothing on screen says so. `splitTrackAndHost` is shared by the
 * single boost modal and BoostAllModal: two copies of "97% to the track, 3% to
 * the show" is how the same feed comes to be paid two different ways depending
 * on which button was pressed.
 *
 * The window arithmetic is half-open on purpose — [start, start+duration) — and
 * that is not a style choice. Adjacent splits in a real music show abut exactly
 * (track 2 starts on the second track 1 ends), so an inclusive end puts one
 * second inside TWO windows; `splitAtPosition` returns the first match, so the
 * boundary second would silently pay the OUTGOING artist. See naive() at the
 * foot of this file: a vector that passes the moment it is written has proved
 * nothing, so every vector here is run against the obvious wrong implementation
 * first and the run fails if naive() survives them.
 *
 * The wire vectors are lifted verbatim from a live feed rather than invented —
 * Chad and Reeds Podcast ep. 002 "Idea Economy"
 * (feedGuid 7c6f7875-2b73-491e-b32c-e2c8d6e91d53), whose single split redirects
 * 97% to Matt Finlay's "Copenhagen Time" for the last 281 seconds of a 6135
 * second episode. That split is the reason this file exists: the boost button
 * ignored it and paid the show.
 */
import { splitAtPosition, splitTrackAndHost } from '../lib/util.ts';

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`  ✗ ${name}\n      expected ${e}\n      actual   ${a}`);
    failures++;
  } else {
    console.log(`  ✓ ${name}`);
  }
}

// ── Wire vectors ────────────────────────────────────────────────────────────
// The real split, exactly as Podcast Index returns it in `timesplits[0]` and as
// lib/pi.ts:parseRawValueTimeSplits reshapes it. Episode duration is 6135, so
// this window runs to the last second of the enclosure.
const COPENHAGEN = {
  startTime: 5854,
  duration: 281,
  remoteStartTime: 0,
  remotePercentage: 97,
  remoteItem: {
    feedGuid: 'e88a4a67-877c-5e03-b8fd-a70cebc821af',
    itemGuid: '9f515f93-eda1-4146-8637-7def160879b5',
  },
};

// Two abutting windows, the shape a music show actually authors: track B starts
// on the exact second track A's duration runs out. This is what makes the
// half-open interval load-bearing rather than cosmetic.
const TRACK_A = { startTime: 100, duration: 60, remotePercentage: 100, id: 'A' };
const TRACK_B = { startTime: 160, duration: 60, remotePercentage: 100, id: 'B' };

// A live block. lib/v4v/live-value.ts synthesises these with duration 0 because
// a live stream has no time base to anchor a window to — the target is resolved
// by polling the feed, not by position. It must never match a position lookup;
// allocationAt() handles live above this call, and a zero-length window matching
// anything would route a pre-recorded position to a live artist.
const LIVE = { startTime: 0, duration: 0, remotePercentage: 90, id: 'live' };

// ── splitAtPosition ─────────────────────────────────────────────────────────
console.log('splitAtPosition — which window covers this second');

const one = [COPENHAGEN];
check('one second before the window → no redirect', splitAtPosition(one, 5853), null);
check('first second of the window → the track', splitAtPosition(one, 5854)?.remoteItem.itemGuid,
  '9f515f93-eda1-4146-8637-7def160879b5');
check('mid-window → the track', splitAtPosition(one, 5990)?.remoteItem.itemGuid,
  '9f515f93-eda1-4146-8637-7def160879b5');
check('last second of the window → the track', splitAtPosition(one, 6134)?.remoteItem.itemGuid,
  '9f515f93-eda1-4146-8637-7def160879b5');
// 5854 + 281 = 6135, which is also the episode duration. Inclusive-end would
// hand the final second to the artist AND leave nothing for the show; more
// importantly it is the same off-by-one that double-covers abutting tracks.
check('the second the window ends → no redirect', splitAtPosition(one, 6135), null);
check('well past the window → no redirect', splitAtPosition(one, 6200), null);
check('start of the episode → no redirect', splitAtPosition(one, 0), null);

const two = [TRACK_A, TRACK_B];
check('inside A', splitAtPosition(two, 120)?.id, 'A');
check('A last second', splitAtPosition(two, 159)?.id, 'A');
// The vector this whole interval convention exists for: 160 belongs to B alone.
check('boundary second belongs to the INCOMING track', splitAtPosition(two, 160)?.id, 'B');
check('inside B', splitAtPosition(two, 200)?.id, 'B');
check('after B', splitAtPosition(two, 220), null);
check('before A', splitAtPosition(two, 99), null);

check('zero-duration live block never matches its own start', splitAtPosition([LIVE], 0), null);
check('zero-duration live block never matches anything', splitAtPosition([LIVE], 5), null);

// Feeds are third-party data; none of these may throw.
check('empty list', splitAtPosition([], 100), null);
check('undefined list', splitAtPosition(undefined, 100), null);
check('null list', splitAtPosition(null, 100), null);
check('negative duration never matches', splitAtPosition([{ startTime: 10, duration: -5 }], 10), null);
check('negative position', splitAtPosition(one, -1), null);
check('NaN position never matches', splitAtPosition(one, NaN), null);

// ── splitTrackAndHost ───────────────────────────────────────────────────────
console.log('\nsplitTrackAndHost — how much leaves the show');

const at = (totalSats, remotePercentage, hostRecipientCount) =>
  splitTrackAndHost({ totalSats, remotePercentage, hostRecipientCount });

// The live case. 100 sats at 97% is 97 to Matt Finlay; the show's own block on
// that feed has FOUR recipients, and 3 sats cannot give each of them one. The
// host leg is dropped and its sats ride with the track rather than being
// silently discarded — splitSats would otherwise allocate a 0-sat leg, which
// payOne reports as ok:true, i.e. a ✓ next to a recipient who received nothing.
check('100 @ 97% with a 4-payee show → host leg cannot fund, folds into track',
  at(100, 97, 4), { trackSats: 100, hostSats: 0 });
// Same split, same percentage, a show whose block has one recipient: 3 sats is
// payable, so the show keeps its share.
check('100 @ 97% with a 1-payee show → 97/3', at(100, 97, 1), { trackSats: 97, hostSats: 3 });
check('100 @ 97% with a 3-payee show → 97/3', at(100, 97, 3), { trackSats: 97, hostSats: 3 });
check('1000 @ 97% with a 4-payee show → 970/30', at(1000, 97, 4), { trackSats: 970, hostSats: 30 });

// Floor, never round: rounding up hands out a sat the user did not authorise
// and makes the two legs sum to more than the boost.
check('333 @ 97% floors the track share', at(333, 97, 1), { trackSats: 323, hostSats: 10 });
check('101 @ 50% floors', at(101, 50, 1), { trackSats: 50, hostSats: 51 });
// 350 × 97% is 339.5 exactly — the case where floor and round disagree, and so
// the only kind of vector that can tell them apart. Rounding would pay the
// track 340 and leave the show 10, i.e. hand out a sat from the show's share.
check('350 @ 97% floors rather than rounds up', at(350, 97, 1), { trackSats: 339, hostSats: 11 });

// Conservation, on every vector above and these: the two legs are the whole
// boost. A shortfall is sats the user was charged for and nobody received.
for (const [total, pct, hosts] of [
  [100, 97, 4], [100, 97, 1], [1000, 97, 4], [333, 97, 1], [101, 50, 1],
  [100, 100, 4], [100, 0, 2], [7, 90, 3], [100, 50, 0],
]) {
  const r = at(total, pct, hosts);
  check(`conservation ${total} @ ${pct}% / ${hosts} host payees`,
    r.trackSats + r.hostSats, total);
}

// remotePercentage is optional in the spec; absent means the whole redirect.
check('missing remotePercentage defaults to 100% to the track',
  at(100, undefined, 4), { trackSats: 100, hostSats: 0 });
check('100% leaves no host leg', at(100, 100, 1), { trackSats: 100, hostSats: 0 });
// A show with no value block of its own has nobody to pay the remainder to.
check('no host recipients → everything to the track', at(100, 50, 0), { trackSats: 100, hostSats: 0 });

// Malformed feeds. A negative or >100 percentage must clamp, not invert the
// split or produce a negative leg.
check('percentage above 100 clamps', at(100, 150, 1), { trackSats: 100, hostSats: 0 });
check('negative percentage clamps to 0', at(100, -20, 1), { trackSats: 0, hostSats: 100 });
check('zero percentage sends nothing to the track', at(100, 0, 1), { trackSats: 0, hostSats: 100 });
check('zero sats', at(0, 97, 1), { trackSats: 0, hostSats: 0 });
check('negative sats', at(-5, 97, 1), { trackSats: 0, hostSats: 0 });
check('NaN percentage falls back to the whole redirect', at(100, NaN, 2), { trackSats: 100, hostSats: 0 });

// ── The obvious wrong implementations ───────────────────────────────────────
// A vector that passes the moment it is written has proved nothing. When there
// is no prior implementation to run against, run against the version someone
// would plausibly write instead — if these survive the vectors above, the
// vectors are not testing what this file claims to test.
console.log('\nnaive() — the vectors must reject the obvious wrong versions');

function naiveSplitAt(splits, pos) {
  // Inclusive end: reads naturally, double-covers every boundary between
  // abutting tracks, and pays the outgoing artist for the incoming one's second.
  for (const s of splits ?? []) {
    if (pos >= s.startTime && pos <= s.startTime + s.duration) return s;
  }
  return null;
}

function naiveTrackAndHost({ totalSats, remotePercentage }) {
  // No clamp, no floor, no host-payability rule.
  const pct = remotePercentage ?? 100;
  const trackSats = Math.round((totalSats * pct) / 100);
  return { trackSats, hostSats: totalSats - trackSats };
}

const naiveCaught = [
  ['inclusive end lets the window match its own end second',
    naiveSplitAt(one, 6135) !== null],
  ['inclusive end gives the boundary second to the OUTGOING track',
    naiveSplitAt(two, 160)?.id === 'A'],
  ['zero-duration live block matches its start',
    naiveSplitAt([LIVE], 0) !== null],
  ['unpayable host leg is emitted instead of folded into the track',
    naiveTrackAndHost({ totalSats: 100, remotePercentage: 97 }).hostSats === 3],
  ['rounding hands the track a sat out of the show\'s share',
    naiveTrackAndHost({ totalSats: 350, remotePercentage: 97 }).trackSats === 340],
  ['no clamp lets a malformed percentage produce a negative host leg',
    naiveTrackAndHost({ totalSats: 100, remotePercentage: 150 }).hostSats < 0],
];
for (const [name, caught] of naiveCaught) {
  if (!caught) {
    console.error(`  ✗ naive() survived: ${name}`);
    failures++;
  } else {
    console.log(`  ✓ rejected: ${name}`);
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nvalueTimeSplit targeting + track/host arithmetic OK');
