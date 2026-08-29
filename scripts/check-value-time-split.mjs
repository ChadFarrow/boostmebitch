#!/usr/bin/env node --experimental-strip-types --no-warnings
/**
 * Pins the pure functions that decide, for a boost pressed mid-episode, WHICH
 * artist is paid and HOW MUCH of the amount leaves the show.
 *
 *   splitAtPosition   — which <podcast:valueTimeSplit> window covers this second
 *   splitTrackAndHost — how the amount divides between the track and the show
 *   payableSplit      — who a leg can actually pay once it is that small
 *   mergeEpisodeContents — which rows of the one contents list may carry a heart
 *   streamAction      — 'auto' for a leg paying a song, 'stream' for the show
 *
 * `streamAction` is the odd one out: it labels a payment rather than aiming or
 * sizing one, so breaking it costs a mislabel and not a sat. It is pinned here
 * anyway because the label is permanent in a receiver's own statistics, it is
 * carried by every leg of every unattended payment, and three separate obvious
 * implementations of it are wrong — each rejected by a vector below.
 *
 * All live in lib/util.ts and all are imported by more than one caller, which
 * is the entire reason they are pinned. `splitAtPosition` is shared by the boost
 * modal and lib/v4v/streaming.ts: if those two disagree about which window a
 * position falls in — by one second, at a boundary — a boost pays one artist
 * while streaming credits a different one, for the same moment of the same
 * episode, and nothing on screen says so. `splitTrackAndHost` is shared by the
 * single boost modal and BoostAllModal: two copies of "97% to the track, 3% to
 * the show" is how the same feed comes to be paid two different ways depending
 * on which button was pressed. `payableSplit` guards the seam between them:
 * `splitSats` honestly returns 0 for a recipient it cannot reach, and `payOne`
 * short-circuits `sats <= 0` to `ok: true` without contacting anyone — so a leg
 * small enough to strand a payee renders a ✓ and writes a boost-log entry for a
 * payment that never happened. Both facts are individually reasonable; together
 * they invent money.
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
import {
  mergeEpisodeContents, payableSplit, splitAtPosition, splitSats, splitTrackAndHost,
  streamAction,
} from '../lib/util.ts';

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

// The live case, and the shape of the whole feature: 100 sats at 97% is 97 to
// Matt Finlay and 3 to the show. The show's block on that feed has FOUR
// recipients and 3 sats cannot give each of them one — that is `payableSplit`'s
// problem to solve (below), NOT a reason to redirect the money somewhere else.
// An earlier version folded the remainder back into the track, which fixed a
// display bug by changing where sats went and made a 100-sat boost pay the show
// nothing at all.
check('100 @ 97% with a 4-payee show → 97/3, small share still paid',
  at(100, 97, 4), { trackSats: 97, hostSats: 3 });
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
check('7 @ 90% with a 3-payee show → 6/1, not folded', at(7, 90, 3), { trackSats: 6, hostSats: 1 });
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

// ── payableSplit ────────────────────────────────────────────────────────────
// The rule that lets a 3-sat share exist without lying about who received it.
console.log('\npayableSplit — who a small leg can actually pay');

// The show's own block, lifted from the same feed: <podcast:valueRecipient>
// weights as authored, not the percentages the modal renders from them.
const SHOW = [
  { name: 'candr show', address: 'greyturkey26@primal.net', type: 'lnaddress', split: 33 },
  { name: 'ChadF', address: 'chadf@getalby.com', type: 'lnaddress', split: 32 },
  { name: 'Reed', address: 'reed@getalby.com', type: 'lnaddress', split: 32 },
  { name: 'Podcastindex.org', address: 'podcastindex@getalby.com', type: 'lnaddress', split: 1, fee: true },
];
const names = (r) => r.recipients.map((x) => x.name);

// 3 sats, 4 payees. splitSats alone returns [1,1,1,0] and payOne turns that
// last 0 into `ok: true` — a ✓ in the modal and a line in the boost log for a
// recipient who was never contacted. Drop them from the leg instead.
const three = payableSplit(3, SHOW);
check('3 sats over 4 payees → three legs, not four', three.splits.length, 3);
check('3 sats pays the three largest', names(three), ['candr show', 'ChadF', 'Reed']);
check('3 sats: one each', three.splits, [1, 1, 1]);
check('3 sats: nothing dropped on the floor', three.splits.reduce((a, b) => a + b, 0), 3);
// No zero survives, at any size. That is the whole postcondition.
for (const n of [1, 2, 3, 4, 5, 11, 30, 97, 1000]) {
  const r = payableSplit(n, SHOW);
  const bad = r.splits.filter((s) => s <= 0).length;
  check(`payableSplit(${n}) emits no zero-sat leg`, bad, 0);
  check(`payableSplit(${n}) spends the whole leg`, r.splits.reduce((a, b) => a + b, 0), n);
}
// Big enough for everyone: nobody is dropped, and the fee recipient keeps its
// place — trimming must not become a way to quietly stop paying the 1% payee.
const thirty = payableSplit(30, SHOW);
check('30 sats keeps all four', names(thirty),
  ['candr show', 'ChadF', 'Reed', 'Podcastindex.org']);
// Feed order, not display order — <SplitsPreview> renders through
// recipientOrder, so the screen lists these biggest-first while the array does
// not. Largest-remainder gives idx1/idx2 the two leftover sats, then the
// one-sat floor pulls Podcastindex's sat out of the largest allocation.
check('30 sats over all four', thirty.splits, [9, 10, 10, 1]);
// The 3% of a real 1,328-sat boost, as it actually went out.
check('10 sats reproduces the observed live host leg',
  payableSplit(10, SHOW).splits, [3, 3, 3, 1]);
// One sat, four payees: exactly one leg, the largest.
check('1 sat pays exactly one payee', names(payableSplit(1, SHOW)), ['candr show']);
// Degenerate inputs must not throw or invent legs.
check('0 sats pays nobody', payableSplit(0, SHOW).splits.every((s) => s === 0), true);
check('no recipients', payableSplit(10, []), { recipients: [], splits: [] });
// A zero-weight recipient can never be paid by largest-remainder, so it must
// not survive into the leg either.
check('zero-weight recipient is dropped, not paid 0',
  names(payableSplit(10, [...SHOW, { name: 'ghost', address: 'g@x.com', type: 'lnaddress', split: 0 }])),
  ['candr show', 'ChadF', 'Reed', 'Podcastindex.org']);

// ── The obvious wrong implementations ───────────────────────────────────────
// A vector that passes the moment it is written has proved nothing. When there
// is no prior implementation to run against, run against the version someone
// would plausibly write instead — if these survive the vectors above, the
// vectors are not testing what this file claims to test.
// ── mergeEpisodeContents ────────────────────────────────────────────────────
// The tracks a show played and its chapters render as ONE list. The merge is by
// timestamp and nothing else — a chapter is never mapped to a window — because
// the row built from a window is the row allowed to carry a <FavTrackHeart>, and
// a favorite is an irreversible write to a kind:10333 list other apps read.
//
// The wire arrays below are lifted verbatim from Homegrown Hits ep. 146 (feed
// 6611624, episode 59021623364): `valueTimeSplits` exactly as Podcast Index
// returns it, and the chapters JSON exactly as
// feed.homegrownhits.xyz/assets/chapters/ch-episode-146.json serves it. They are
// real for a reason invention would have missed — PI hands back INTEGER
// startTimes while the chapters file is fractional, so 13 of the 14 pairs that
// name the same moment differ by a fraction of a second and only ONE matches
// exactly. A hand-built fixture would have used round numbers and made
// exact-equality dedupe look correct forever.
console.log('\nmergeEpisodeContents — one list, and which rows may carry a heart');

const HGH_WINDOWS = [
  { startTime: 34, duration: 209, remotePercentage: 99, remoteItem: { feedGuid: '606dd394-6294-53cd-ba85-9ea5ca59407b', itemGuid: 'indiesats:npub13jml82yy69370amnfl0tfsreyg5hjqwxsmnttxv7g27usl8w5h5qnvtmat:b776fda162d2f3b4b000b2f0951acee134bdbabb0610dd0db495fb9269a962fa' } },
  { startTime: 351, duration: 197, remotePercentage: 99, remoteItem: { feedGuid: '048d73a2-5ca3-4593-8d8d-bca7d9e72d4a', itemGuid: '50b9894e-b189-4fba-a076-9f61684ee433' } },
  { startTime: 1149, duration: 232, remotePercentage: 99, remoteItem: { feedGuid: '19215795-6853-5a12-8f84-8fe4d877ed53', itemGuid: 'b85d2b40-e19a-4843-89e6-eed6dec0177a' } },
  { startTime: 1919, duration: 285, remotePercentage: 99, remoteItem: { feedGuid: 'de54dc36-3eda-4c19-8749-367cf5aeec76', itemGuid: 'c92a2add-6af3-4ead-a8fa-fd82d33a23a3' } },
  { startTime: 2192, duration: 252, remotePercentage: 99, remoteItem: { feedGuid: '9bc0816d-338e-5b22-ad06-bf26459b4e12', itemGuid: '92f511a1-3faf-4895-8c20-5f9b87ee6f59' } },
  { startTime: 2977, duration: 224, remotePercentage: 99, remoteItem: { feedGuid: '18e5f71e-e3b1-4799-b603-57b18ca944b9', itemGuid: 'efc0fe9c-5917-4961-aa07-5cd877ff17f7' } },
  // PI has not crawled this one — no title comes back for it, which is what
  // makes it the vector for the absorbed-title rule below ("Shanti").
  { startTime: 5046, duration: 247, remotePercentage: 99, remoteItem: { feedGuid: '66c9200e-f218-51a1-a7b2-1bed8a7868b0', itemGuid: '574af3df-ef69-4cf9-bbe8-d4439fb2cbc8' } },
  { startTime: 5288, duration: 191, remotePercentage: 99, remoteItem: { feedGuid: '629d9247-dd36-5d78-87a6-bb614bffe106', itemGuid: '98fdca72-0362-4a85-927f-b5dbcf76f307' } },
  { startTime: 5872, duration: 182, remotePercentage: 99, remoteItem: { feedGuid: 'fc815bcf-3639-5395-ba7d-fa217ec93d32', itemGuid: 'b2a61b9f-4dc8-40e3-a849-e7fe96d4e843' } },
  { startTime: 6056, duration: 248, remotePercentage: 99, remoteItem: { feedGuid: 'c989830b-49a1-572f-9f0e-0fec994a6d5a', itemGuid: 'a8f3468a-d12c-429e-b96b-fcc6a6494e86' } },
  { startTime: 6303, duration: 213, remotePercentage: 99, remoteItem: { feedGuid: 'a71b097b-4cf0-5e74-b6a9-1271373bb396', itemGuid: 'a45376c3-c8b3-4173-80c4-4cdfa266e0db' } },
  // Two windows with NO itemGuid. They still get rows; <FavTrackHeart> declines
  // to render on them for want of an identifier, which is its own rule and not
  // this one's — the merge must not start filtering rows on favoritability.
  { startTime: 6530, duration: 177, remotePercentage: 99, remoteItem: { feedGuid: '7c6f7875-2b73-491e-b32c-e2c8d6e91d53' } },
  { startTime: 6746, duration: 31, remotePercentage: 99, remoteItem: { feedGuid: 'ab6cfe0a-4311-4569-85e0-eaff9b11e5ea' } },
  { startTime: 7089, duration: 213, remotePercentage: 99, remoteItem: { feedGuid: 'a2d2e313-9cbd-5169-b89c-ab07b33ecc33', itemGuid: '9ff8f18b-cc79-474c-a3e9-2948113b8bf5' } },
];

const HGH_CHAPTERS = [
  { startTime: 0.001, title: 'Homegrown Hits Episode 146 LIVE' },
  { startTime: 33.778, title: 'Casino Cumrag' },
  { startTime: 239.429, title: 'HGH 146 ⚡︎ 08-13-26' },
  { startTime: 350.981, title: 'Please Stand By' },
  { startTime: 545.046, title: 'What Do You Desire?' },
  { startTime: 1148.691, title: 'Temple' },
  { startTime: 1379.986, title: 'In the Hitter!' },
  { startTime: 1918.814, title: 'Victim [432Hz]' },
  { startTime: 2192.022, title: 'Cloud Burst' },
  { startTime: 2439.672, title: 'Decentralize!' },
  { startTime: 2674.202, title: 'Pre-Boosts' },
  { startTime: 2813.202, title: 'Homegrown Hits PayPal' },
  { startTime: 2976.739, title: '03. Crypto Phonics' },
  { startTime: 3199.561, title: '(213) 839-8668' },
  { startTime: 4850.202, title: 'Text Pic 1' },
  { startTime: 4880.202, title: 'Text Pic 2' },
  { startTime: 4895.202, title: 'Text Pic 3' },
  { startTime: 5045.605, title: 'Shanti' },
  { startTime: 5287.783, title: 'Eurydice' },
  { startTime: 5478.537, title: '(213) 839-8668' },
  { startTime: 5695.202, title: 'Text Pic 4' },
  { startTime: 5798.202, title: 'Tiddicate a song' },
  { startTime: 5871.555, title: 'The Devil Never Change' },
  { startTime: 6055.914, title: 'January Shock' },
  { startTime: 6303.055, title: 'The Wait Is Over' },
  { startTime: 6516.202, title: 'New to DeMu!' },
  { startTime: 6530.202, title: 'Chad and Reeds Podcast' },
  { startTime: 6707.202, title: 'Live Boostagrams' },
  { startTime: 6746, title: 'Rollz Radio' },
  { startTime: 6777.202, title: 'Live Boostagrams' },
  { startTime: 7088.762, title: 'Luv Song 4 U' },
];

const hgh = mergeEpisodeContents(HGH_WINDOWS, HGH_CHAPTERS);
const hghTracks = hgh.filter((r) => r.kind === 'track');

// Rule 1, the one that costs a heart if it breaks: every window is present, in
// order, and identity-equal to the input element — the row hands that very
// object to <FavTrackHeart>.
check('every window survives the merge', hghTracks.length, HGH_WINDOWS.length);
check('window rows are the input objects, in feed order',
  hghTracks.every((r, i) => r.split === HGH_WINDOWS[i]), true);
// 14 windows + the 17 chapters that name a moment no window does.
check('HGH 146 merges 14 windows and 31 chapters into 31 rows', hgh.length, 31);
check('17 chapters survive as chapter rows', hgh.length - hghTracks.length, 17);
// Rule 2's direction, stated as the thing that would be silently wrong.
check('no chapter row carries a split',
  hgh.every((r) => r.kind === 'chapter' ? !('split' in r) : true), true);
check('rows come out in ascending time',
  hgh.every((r, i) => i === 0 || hgh[i - 1].startTime <= r.startTime), true);

// The songs the host chaptered AND published a window for are one row, not two.
const rowsAt = (t) => hgh.filter((r) => Math.abs(r.startTime - t) < 3);
check('"Casino Cumrag" is one row, the window', rowsAt(34).map((r) => r.kind), ['track']);
check('"Rollz Radio" (the exact-match pair) is one row', rowsAt(6746).map((r) => r.kind), ['track']);
// ...and a talk break the host chaptered with no window keeps its own row.
check('a talk break with no window survives',
  rowsAt(2674).map((r) => r.kind === 'chapter' ? r.chapter.title : 'track'), ['Pre-Boosts']);
check('the 0.001s intro chapter survives',
  rowsAt(0).map((r) => r.kind === 'chapter' ? r.chapter.title : 'track'),
  ['Homegrown Hits Episode 146 LIVE']);
// 6516.202 "New to DeMu!" sits 13.8s from the 6530 window — outside tolerance,
// so BOTH rows stand. This is the vector that stops the tolerance being widened
// to something like 15s to "clean up" the list.
check('a chapter 13.8s from a window is NOT absorbed',
  hgh.filter((r) => r.startTime >= 6516 && r.startTime <= 6531).map((r) => r.kind),
  ['chapter', 'track']);

// Rule 5 — the absorbed title, and its guard.
const shanti = hghTracks.find((r) => r.split.startTime === 5046);
check('an uncrawled window borrows its absorbed chapter\'s title', shanti.absorbedTitle, 'Shanti');
check('the borrow does not touch the identifiers',
  shanti.split.remoteItem.itemGuid, '574af3df-ef69-4cf9-bbe8-d4439fb2cbc8');
// The Mutton, Mead & Music shape: two chapters tied on one start, one a talk
// break and one the song, so any pick is a coin flip and none is made.
const tied = mergeEpisodeContents(
  [{ startTime: 1701, duration: 200, remoteItem: { feedGuid: 'f', itemGuid: 'i' } }],
  [{ startTime: 1700, title: 'Mutton, Mead & Music' }, { startTime: 1700, title: '10. Reefer Gladness' }],
);
check('a window that absorbed TWO chapters borrows no title', tied[0].absorbedTitle, undefined);
check('...and still absorbed them both', tied.length, 1);

// Ordering at an exact tie: the heart-bearing row leads.
const tie = mergeEpisodeContents(
  [{ startTime: 100, duration: 60, remoteItem: { feedGuid: 'f', itemGuid: 'i' } }],
  [{ startTime: 130, title: 'later chapter' }],
  0, // tolerance 0 so the chapter is not absorbed
);
check('tolerance 0 keeps both rows', tie.map((r) => r.kind), ['track', 'chapter']);

// Feeds are third-party; none of these may throw.
check('no windows, chapters only',
  mergeEpisodeContents([], [{ startTime: 5, title: 'a' }]).map((r) => r.kind), ['chapter']);
check('no chapters, windows only',
  mergeEpisodeContents(HGH_WINDOWS, null).length, 14);
check('both empty', mergeEpisodeContents(null, undefined), []);
const nan = mergeEpisodeContents(
  [{ startTime: 10, duration: 5, remoteItem: { feedGuid: 'f' } }],
  [{ startTime: NaN, title: 'malformed' }, { startTime: 3, title: 'early' }],
);
check('a NaN chapter start is kept and sorts last',
  nan.map((r) => (r.kind === 'track' ? 'track' : r.chapter.title)), ['early', 'track', 'malformed']);

// ── streamAction — 'auto' for a song, 'stream' for the show ─────────────────
// Which word an unattended streaming payment carries. Wrong here is not a money
// fault; it is a permanent mislabel in a host's own stats, and every leg of
// every talk show carries it.
//
// The mediums below are what the live feeds actually declare, read 2026-08-28:
// Bowl After Bowl ships no <podcast:medium> at all, so Podcast Index answers
// with the default 'podcast'; Homegrown Hits — a live music show — declares
// 'podcast' outright, as do Red Bar Radio and Behind the Sch3m3s. That is why
// the feed's medium cannot be the test.
console.log('\nstreamAction — which action word a streaming leg carries');
const TALK = { medium: 'podcast' };   // Bowl After Bowl, Homegrown Hits, Red Bar
const ALBUM = { medium: 'music' };
const PLAYLIST = { medium: 'musicL' };

check('a talk show\'s own leg streams', streamAction(TALK), 'stream');
check('a feed declaring no medium at all streams', streamAction({}), 'stream');
check('an album is auto', streamAction(ALBUM), 'auto');
check('a musicL playlist is auto', streamAction(PLAYLIST), 'auto');
check('medium case is ignored', streamAction({ medium: 'MusicL' }), 'auto');

// Split Kit stamps every block it pushes. These three kinds were observed live.
check('a live Split Kit music block is auto',
  streamAction(TALK, { blockType: 'music' }), 'auto');
check('a live chapter block is the SHOW, so it streams',
  streamAction(TALK, { blockType: 'chapter' }), 'stream');
check('a live default block streams',
  streamAction(TALK, { blockType: 'podcast' }), 'stream');
check('blockType case is ignored',
  streamAction(TALK, { blockType: 'MUSIC' }), 'auto');

// The two valueTimeSplit windows Podcast Index actually returns for Bowl After
// Bowl. Neither is a song: one is a 7220s cross-promotion to the Podcasting 2.0
// show at 33%, and it says so; the other declares nothing.
check('a window declaring medium="podcast" streams',
  streamAction(TALK, { remoteItemMedium: 'podcast' }), 'stream');
check('a window declaring no medium streams',
  streamAction(TALK, { remoteItemMedium: undefined }), 'stream');
check('a window that DOES declare music is auto',
  streamAction(TALK, { remoteItemMedium: 'music' }), 'auto');

// An album never loses its word, whatever a leg carries.
check('an album leg stays auto under a chapter block',
  streamAction(ALBUM, { blockType: 'chapter' }), 'auto');

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

// Dedupe the wrong way round: when a chapter and a window name the same moment,
// keep the CHAPTER. Reads just as naturally ("the chapter list, with hearts on
// it") and silently strips the heart off every song the host also chaptered.
function naiveChapterWins(splits, chapters, tol = 2) {
  const rows = (chapters ?? []).map((chapter) => ({ kind: 'chapter', startTime: chapter.startTime, chapter }));
  for (const split of splits ?? []) {
    if (!(chapters ?? []).some((c) => Math.abs(c.startTime - split.startTime) <= tol)) {
      rows.push({ kind: 'track', startTime: split.startTime, split });
    }
  }
  return rows.sort((a, b) => a.startTime - b.startTime);
}

// Dedupe on exact equality. Correct-looking, and on any hand-built fixture with
// round numbers it passes — which is exactly why the vectors above are the real
// integer-vs-fractional wire arrays.
function naiveExactDedupe(splits, chapters) {
  const starts = new Set((splits ?? []).map((s) => s.startTime));
  return [
    ...(splits ?? []).map((split) => ({ kind: 'track', startTime: split.startTime, split })),
    ...(chapters ?? []).filter((c) => !starts.has(c.startTime))
      .map((chapter) => ({ kind: 'chapter', startTime: chapter.startTime, chapter })),
  ].sort((a, b) => a.startTime - b.startTime);
}

// "The window covering this chapter's start" — the mapping docs/ui.md measured
// as wrong, and HGH 146 is more damning than the write-up there. The windows
// OVERLAP by a second or two (1919 + 285 = 2204, past the 2192 window's start),
// so the covering-window rule hands the "Cloud Burst" chapter the identifiers of
// "Victim [432Hz]" — despite Cloud Burst having a window of its own, right
// there, at its own start. It does the same to "Eurydice" (given Shanti's
// window) and "The Wait Is Over" (given January Shock's). Three named songs,
// one episode, each favoritable as the wrong track with nothing on screen
// saying so.
function naiveCoveringWindow(splits, chapters) {
  return (chapters ?? []).map((chapter) => ({
    kind: 'chapter',
    startTime: chapter.startTime,
    chapter,
    split: (splits ?? []).find(
      (s) => chapter.startTime >= s.startTime && chapter.startTime < s.startTime + s.duration,
    ),
  }));
}

// Three rejected designs for streamAction, in the order they were proposed.

// 1. "The feed says what it is." It does not: every V4V music show declares
//    <podcast:medium>podcast</podcast:medium>, so this streams the songs.
function naiveActionByMedium(podcast) {
  const m = podcast?.medium?.toLowerCase();
  return m === 'music' || m === 'musicl' ? 'auto' : 'stream';
}

// 2. "An open valueTimeSplit window means a song." A window means somebody
//    other than the show is paid, which is not the same claim.
function naiveActionByWindow(podcast, leg = {}) {
  if (naiveActionByMedium(podcast) === 'auto') return 'auto';
  return leg.remoteItemMedium !== undefined || leg.blockType ? 'auto' : 'stream';
}

// 3. "Split Kit is running, so it is a music show." On one 71-minute Homegrown
//    Hits broadcast 10 of 17 block changes were 'chapter' — the host's own
//    promos, photos and phone numbers.
function naiveActionBySplitKit(podcast, leg = {}) {
  if (naiveActionByMedium(podcast) === 'auto') return 'auto';
  return leg.blockType ? 'auto' : 'stream';
}

const naiveCaught = [
  ['chapter-wins dedupe strips the heart off a song the host also chaptered',
    naiveChapterWins(HGH_WINDOWS, HGH_CHAPTERS).filter((r) => r.kind === 'track').length
      < HGH_WINDOWS.length],
  ['exact-equality dedupe leaves 13 duplicate pairs standing',
    naiveExactDedupe(HGH_WINDOWS, HGH_CHAPTERS).length === 44],
  ['"the window covering this chapter" gives Cloud Burst the Victim [432Hz] window',
    naiveCoveringWindow(HGH_WINDOWS, HGH_CHAPTERS)
      .find((r) => r.chapter.startTime === 2192.022)?.split?.startTime === 1919],
  ['inclusive end lets the window match its own end second',
    naiveSplitAt(one, 6135) !== null],
  ['inclusive end gives the boundary second to the OUTGOING track',
    naiveSplitAt(two, 160)?.id === 'A'],
  ['zero-duration live block matches its start',
    naiveSplitAt([LIVE], 0) !== null],
  ['a bare splitSats leaves a zero-sat leg that payOne reports as paid',
    splitSats(3, SHOW).filter((s) => s <= 0).length > 0],
  ['rounding hands the track a sat out of the show\'s share',
    naiveTrackAndHost({ totalSats: 350, remotePercentage: 97 }).trackSats === 340],
  ['no clamp lets a malformed percentage produce a negative host leg',
    naiveTrackAndHost({ totalSats: 100, remotePercentage: 150 }).hostSats < 0],
  ['medium alone streams a live Split Kit song, because Homegrown Hits declares "podcast"',
    naiveActionByMedium(TALK, { blockType: 'music' }) === 'stream'],
  ['"a window is a song" files the Podcasting 2.0 cross-promo as music',
    naiveActionByWindow(TALK, { remoteItemMedium: 'podcast' }) === 'auto'],
  ['"Split Kit is running" files the host\'s own promo block as music',
    naiveActionBySplitKit(TALK, { blockType: 'chapter' }) === 'auto'],
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
