// Pins the four pure decisions behind "new episodes from your favorites".
//
// Usage:
//   npm run check:favnew
//
// Run it after ANY edit to the mark helpers in lib/util.ts.
//
// THE MEASUREMENT THIS WHOLE FEATURE RESTS ON, taken against the live API on
// 2026-09-12, because none of it is in Podcast Index's documentation:
//
//   - `/episodes/byfeedid` accepts a COMMA-SEPARATED list of feed ids together
//     with `since`, so ONE call answers "what came out on these shows since
//     this moment" and returns the episode records. There is no detect-then-
//     fetch step, and no freshness field of ours to keep warm.
//   - `since` filters `datePublished` and is EXCLUSIVE. Storing the exact
//     `datePublished` of the newest row shown is therefore the right mark.
//   - **PI truncates the id list at exactly 200, SILENTLY, with a 200 OK.**
//     A feed at position 201 is absent from the answer; move it to position 1
//     of the same list and it is answered. Nothing on the wire says so.
//   - `max` is GLOBAL across the batch and applied after a newest-first sort,
//     so truncation drops the oldest rows across every feed at once.
//
// WHY THIS EARNS A CHECK SCRIPT. Three of the four fail by showing a reader
// either too much or too little, and nobody reports either as a bug — they just
// stop opening the section.
//
// `sinceForBatch` has one load-bearing half: the FLOOR. One never-checked feed
// would otherwise drag the batch back to the epoch, and because `max` is global
// the truncation would then eat the newest episodes of every other feed in the
// same call.
//
// `selectNewEpisodes` compares each row against ITS OWN feed's mark, never the
// batch floor. Trusting the floor is the obvious shortcut and it re-shows
// everything back to the least-recently-checked feed's mark, for every feed, on
// every refresh — a list that grows instead of draining. It also drops UNDATED
// rows, which are routinely a feed's oldest: treat a missing date as new and
// the first open is a decade of back catalogue.
//
// `advanceMarks` has to tell three states apart, and the one-liner everybody
// writes — stamp `now` on every feed asked — is three separate silent bugs.
//
// `pruneMarks` is the bound.
//
// `mergeNewEpisodeRows` and `pruneNewRows` came later, with the list itself.
// The rows used to live only in React state while the marks went to disk, so
// the CHECK consumed the list rather than the reader: a pass advanced every
// mark and the rows died with the component. The list is the persisted thing
// now, and these two are what carry it — a pass ADDS to it, and a row leaves
// by its show being unfavorited, by CLEAR or ✕, or by the cap (no longer by age:
// see the 2026-10-01 note below).
//
// The `merge → advance` pipeline is pinned as a vector of its own, because the
// bug it fixes lives BETWEEN two functions that are each correct. Handing
// `advanceMarks` the FETCHED rows rather than the kept ones marks episodes as
// seen that the cap had already dropped, and nothing downstream can tell: the
// reader is simply never offered them again.
//
// All four live in lib/util.ts, whose only import is type-only, so this script
// imports the REAL module under `--experimental-strip-types`. It does NOT run
// `importFreeProblems`: that scan rejects type-only relative imports and
// lib/util.ts has one — `check:vts` and `check:queue` import it on the same
// terms.
//
// THE 2026-10-01 CHANGE, which deliberately REVERSES two vectors below. The
// owner chose: on a show's first check, show its LATEST episode (if it is under
// 90 days old) instead of only what came out in the last seven days, and keep
// every row until the reader clears it. So `selectLatestEpisodes` is new, and
// `mergeNewEpisodeRows` no longer retires a row by age — the two "past the
// horizon is retired" vectors now assert that it STAYS. That is a requirement
// change, not a vector edited to match a bug. The list is bounded by
// `FAV_NEW_CAP` (raised to 250, so a 221-show library fits) and by CLEAR / ✕.
// `capDismissed` is the fix for the cap on the dismissed keys, which kept the
// OLDEST and so let the row just removed come back.
//
// EVERY VECTOR IS A RECORDED CALL, replayed against the `naive*` versions at the
// foot. Exemptions are named one at a time with `alsoNaive: true`.

import {
  advanceMarks,
  capDismissed,
  FAV_NEW_CAP,
  FAV_NEW_SEED_WINDOW_MS,
  FAV_NEW_WINDOW_MS,
  mergeNewEpisodeRows,
  NEW_EPISODES_LATEST_MAX_FEEDS,
  PI_FEED_IDS_MAX,
  pruneMarks,
  pruneNewRows,
  seedMarks,
  selectLatestEpisodes,
  selectNewEpisodes,
  sinceForBatch,
} from '../lib/util.ts';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${label}`); return; }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

function section(name) { console.log(`\n${name}`); }

function checkSince(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, sinceForBatch(...args), expected);
  vectors.push({ label, kind: 'since', args, alsoNaive });
}
/** Asserts on the TITLES that survive, in order — what a reader actually sees. */
function checkSelect(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, selectNewEpisodes(...args).map((e) => e.title), expected);
  vectors.push({ label, kind: 'select', args, alsoNaive });
}
function checkAdvance(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, advanceMarks(...args), expected);
  vectors.push({ label, kind: 'advance', args, alsoNaive });
}
function checkPrune(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, pruneMarks(...args), expected);
  vectors.push({ label, kind: 'prune', args, alsoNaive });
}
/** Titles again, in order — the list as the reader reads it. */
function checkMerge(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, mergeNewEpisodeRows(...args).map((e) => e.title), expected);
  vectors.push({ label, kind: 'merge', args, alsoNaive });
}
/** Titles, in order — the first-check list as the reader reads it. */
function checkLatest(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, selectLatestEpisodes(...args).map((e) => e.title), expected);
  vectors.push({ label, kind: 'latest', args, alsoNaive });
}
function checkSeedMarks(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, seedMarks(...args), expected);
  vectors.push({ label, kind: 'seedMarks', args, alsoNaive });
}
function checkDismissed(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, capDismissed(...args), expected);
  vectors.push({ label, kind: 'dismissed', args, alsoNaive });
}
function checkPruneRows(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, pruneNewRows(...args).map((e) => e.title), expected);
  vectors.push({ label, kind: 'pruneRows', args, alsoNaive });
}
/**
 * The COMPOSITION, which is where the bug was: merge first, then let
 * `advanceMarks` see only what the merge kept.
 */
const markPipeline = (prev, prevRows, found, covered, byId) =>
  advanceMarks(prev, mergeNewEpisodeRows(prevRows, found), covered, byId, false);
function checkPipeline(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, markPipeline(...args), expected);
  vectors.push({ label, kind: 'pipeline', args, alsoNaive });
}

// A fixed clock, so the window is arithmetic rather than a race.
const NOW_MS = 1_789_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const DAY = 24 * 60 * 60;
const HORIZON = Math.floor((NOW_MS - FAV_NEW_WINDOW_MS) / 1000);

const ep = (title, feedId, datePublished, extra = {}) => ({
  id: Math.random(), guid: title, feedId, title,
  enclosureUrl: 'https://x/a.mp3', datePublished, ...extra,
});
const BY_ID = { 1: 'guid-a', 2: 'guid-b' };

// ---------------------------------------------------------------------------
section('sinceForBatch: one floor for the whole call, and it must BE a floor');
// ---------------------------------------------------------------------------
checkSince('the earliest mark wins',
  [{ 'guid-a': NOW_S - 2 * DAY, 'guid-b': NOW_S - 1 * DAY }, ['guid-a', 'guid-b'], NOW_MS],
  NOW_S - 2 * DAY, { alsoNaive: true });

// THE ONE THIS FUNCTION EXISTS FOR. An unmarked feed must not drag the batch to
// the epoch — `max` is global, so that truncation eats every other feed's
// newest rows.
checkSince('a never-checked feed does NOT drag the batch to the epoch',
  [{ 'guid-a': NOW_S - 2 * DAY }, ['guid-a', 'guid-b'], NOW_MS], HORIZON);
checkSince('an ancient mark is floored at the horizon too',
  [{ 'guid-a': 1000 }, ['guid-a'], NOW_MS], HORIZON);
checkSince('no marks at all is the horizon, not zero',
  [{}, ['guid-a', 'guid-b'], NOW_MS], HORIZON);
checkSince('no feeds asked is still the horizon, never Infinity',
  [{}, [], NOW_MS], HORIZON);

// ---------------------------------------------------------------------------
section('selectNewEpisodes: each row against ITS OWN feed mark');
// ---------------------------------------------------------------------------
const MARKS = { 'guid-a': NOW_S - 2 * DAY, 'guid-b': NOW_S - 6 * DAY };
const ROWS = [
  ep('a-old', 1, NOW_S - 3 * DAY),   // older than A's mark — already shown
  ep('a-new', 1, NOW_S - 1 * DAY),
  ep('b-new', 2, NOW_S - 5 * DAY),   // newer than B's mark, older than A's
  ep('undated', 1, undefined),
  ep('stranger', 9, NOW_S - 1 * DAY),
];

// THE ONE THE BATCH FLOOR GETS WRONG. `a-old` is newer than the batch `since`
// (B's mark) and older than A's own — it must not come back.
checkSelect('a row older than its OWN mark is dropped, though the batch floor lets it through',
  [ROWS, MARKS, BY_ID, NOW_MS], ['a-new', 'b-new']);
checkSelect('an UNDATED row is dropped, never treated as new',
  [[ep('undated', 1, undefined)], MARKS, BY_ID, NOW_MS], []);
checkSelect('a row for a feed we did not ask about is not ours to show',
  [[ep('stranger', 9, NOW_S)], MARKS, BY_ID, NOW_MS], []);
checkSelect('an unplayable row never reaches the list',
  [[ep('dead', 1, NOW_S, { enclosureUrl: '' })], MARKS, BY_ID, NOW_MS], []);
checkSelect('nor does a live broadcast',
  [[ep('onair', 1, NOW_S, { liveStatus: 'live' })], MARKS, BY_ID, NOW_MS], []);
checkSelect('a feed with no mark uses the horizon',
  [[ep('within', 1, NOW_S - 3 * DAY), ep('beyond', 1, NOW_S - 9 * DAY)], {}, BY_ID, NOW_MS],
  ['within']);
checkSelect('duplicates by epKey collapse',
  [[ep('dup', 1, NOW_S), ep('dup', 1, NOW_S)], MARKS, BY_ID, NOW_MS], ['dup']);

const MANY = Array.from({ length: FAV_NEW_CAP + 20 }, (_, i) => ep(`e${i}`, 1, NOW_S - i));
checkSelect('the cap holds however many arrived',
  [MANY, MARKS, BY_ID, NOW_MS], MANY.slice(0, FAV_NEW_CAP).map((e) => e.title));

// ---------------------------------------------------------------------------
section('advanceMarks: three states, and the one-liner gets all three wrong');
// ---------------------------------------------------------------------------
const PREV = { 'guid-a': NOW_S - 2 * DAY, 'guid-b': NOW_S - 6 * DAY };

checkAdvance('a covered feed advances to its newest row',
  [PREV, [ep('a-new', 1, NOW_S - 1 * DAY)], ['guid-a', 'guid-b'], BY_ID, false],
  { 'guid-a': NOW_S - 1 * DAY, 'guid-b': NOW_S - 6 * DAY });

// 1. Not covered — PI could not be asked. Advancing skips whatever it published.
checkAdvance('a feed NOT covered keeps its mark',
  [PREV, [ep('a-new', 1, NOW_S)], ['guid-b'], BY_ID, false],
  { 'guid-a': NOW_S - 2 * DAY, 'guid-b': NOW_S - 6 * DAY });

// 2. Covered with no rows — `since` is exclusive, so there is nothing to
//    advance TO, and stamping `now` hides a back-dated item for ever.
checkAdvance('a covered feed with NO rows keeps its mark',
  [PREV, [], ['guid-a', 'guid-b'], BY_ID, false], PREV);

// 3. Truncated — the rows we did not see are BETWEEN the mark and the ones we
//    did, because `max` drops the oldest globally.
checkAdvance('a TRUNCATED answer advances nothing at all',
  [PREV, [ep('a-new', 1, NOW_S)], ['guid-a', 'guid-b'], BY_ID, true], PREV);

checkAdvance('a mark never moves backwards',
  [PREV, [ep('a-old', 1, NOW_S - 9 * DAY)], ['guid-a'], BY_ID, false], PREV);
checkAdvance('an undated row cannot become a mark',
  [PREV, [ep('undated', 1, undefined)], ['guid-a'], BY_ID, false], PREV);

// ---------------------------------------------------------------------------
section('pruneMarks: an unfavorited show keeps no memory');
// ---------------------------------------------------------------------------
checkPrune('a mark for a show no longer favorited is dropped',
  [{ 'guid-a': 5, 'guid-gone': 9 }, ['guid-a']], { 'guid-a': 5 });
checkPrune('everything still favorited survives',
  [{ 'guid-a': 5, 'guid-b': 9 }, ['guid-a', 'guid-b']], { 'guid-a': 5, 'guid-b': 9 },
  { alsoNaive: true });
checkPrune('over the cap, the most recent marks are the ones kept',
  [{ a: 1, b: 2, c: 3 }, ['a', 'b', 'c'], 2], { c: 3, b: 2 });

// ---------------------------------------------------------------------------
section('mergeNewEpisodeRows: a pass ADDS to the list, it does not replace it');
// ---------------------------------------------------------------------------
// THE ONE THIS FUNCTION EXISTS FOR. One pass covers MAX_FEEDS shows and a
// library can be larger, so a replace makes pass 2 delete what pass 1 found —
// and the marks have already moved past it, so it is gone for good.
checkMerge('a row from an earlier pass survives a pass that did not find it',
  [[ep('carried', 1, NOW_S - 2 * DAY)], [ep('fresh', 2, NOW_S - 1 * DAY)]],
  ['fresh', 'carried']);
// REVERSED on 2026-10-01, by the owner's decision (see the header): age no
// longer retires a row. A show's latest episode is routinely older than seven
// days, and the reader clears what they have seen.
checkMerge('an OLD carried row stays until it is cleared',
  [[ep('stale', 1, NOW_S - 9 * DAY), ep('carried', 1, NOW_S - 2 * DAY)], []],
  ['carried', 'stale']);
checkMerge('an old FOUND row stays too — a show\'s latest can be weeks old',
  [[], [ep('stale', 1, NOW_S - 40 * DAY)]], ['stale'], { alsoNaive: true });
checkMerge('a re-fetched episode updates in place rather than appearing twice',
  [[ep('dup', 1, NOW_S - 1 * DAY)], [ep('dup', 1, NOW_S - 1 * DAY)]],
  ['dup'], { alsoNaive: true });
checkMerge('an undated row cannot ride in on the carry',
  [[ep('undated', 1, undefined), ep('carried', 1, NOW_S - 2 * DAY)], []],
  ['carried']);
{
  // The CAP is now the only bound besides CLEAR and ✕, so it is asserted with
  // a carry that is already full.
  const carried = Array.from({ length: FAV_NEW_CAP }, (_, i) => ep(`c${i}`, 1, NOW_S - 100 - i));
  const found = Array.from({ length: 40 }, (_, i) => ep(`f${i}`, 2, NOW_S - i));
  const expected = [...found.map((e) => e.title), ...carried.map((e) => e.title)]
    .slice(0, FAV_NEW_CAP);
  checkMerge('the cap holds across the carry, newest first — the oldest go', [carried, found], expected);
}

// ---------------------------------------------------------------------------
section('mergeNewEpisodeRows: a dismissed row does not come back');
// ---------------------------------------------------------------------------
// THE ONE N2 EXISTS FOR. A truncated batch's marks cannot advance, so a
// dismissed row from that batch reappears on the next pass unless the merge
// itself filters it. The `dismissed` set is persisted exactly for this.
checkMerge('a dismissed row is filtered out of the merge',
  [[ep('kept', 1, NOW_S - 1 * DAY)], [ep('gone', 2, NOW_S - 2 * DAY)], new Set(['gone'])],
  ['kept']);
checkMerge('a dismissed row on the carry is filtered too',
  [[ep('gone', 1, NOW_S - 1 * DAY), ep('kept', 2, NOW_S - 2 * DAY)], [], new Set(['gone'])],
  ['kept']);
checkMerge('an empty dismissed set changes nothing',
  [[], [ep('a', 1, NOW_S), ep('b', 2, NOW_S - 1 * DAY)], new Set()],
  ['a', 'b'], { alsoNaive: true });
checkMerge('undefined dismissed changes nothing',
  [[], [ep('a', 1, NOW_S), ep('b', 2, NOW_S - 1 * DAY)], undefined],
  ['a', 'b'], { alsoNaive: true });

// ---------------------------------------------------------------------------
section('capDismissed: over the cap, the NEWEST removals are the ones kept');
// ---------------------------------------------------------------------------
// THE ONE THIS EXISTS FOR. The end of a pass wrote `[...dismissed].slice(0,
// cap)`, and the read did the same: over the cap that keeps the OLDEST keys, so
// the row the reader had just removed was the one forgotten — and it came back.
{
  const keys = Array.from({ length: FAV_NEW_CAP + 5 }, (_, i) => `k${i}`);
  checkDismissed('the row removed LAST is never the one forgotten', [keys], keys.slice(-FAV_NEW_CAP));
}
checkDismissed('under the cap nothing is dropped', [['a', 'b']], ['a', 'b'], { alsoNaive: true });

// ---------------------------------------------------------------------------
section('selectLatestEpisodes: a show\'s first check shows its LATEST episode');
// ---------------------------------------------------------------------------
// The owner's 2026-10-01 rule: one row per show, its newest, if that is under
// 90 days old — so a monthly show is not missing, and a show that stopped
// publishing does not put an old episode on the list.
const D90 = Math.floor((NOW_MS - FAV_NEW_SEED_WINDOW_MS) / 1000);
checkLatest('one row per show, and it is the NEWEST',
  [[ep('a1', 1, NOW_S - 1 * DAY), ep('a2', 1, NOW_S - 3 * DAY), ep('b1', 2, NOW_S - 10 * DAY)], BY_ID, NOW_MS],
  ['a1', 'b1']);
checkLatest('a monthly show is NOT missing — 89 days old is shown',
  [[ep('b89', 2, NOW_S - 89 * DAY)], BY_ID, NOW_MS], ['b89']);
checkLatest('a latest older than 90 days is not shown',
  [[ep('b-old', 2, D90 - 1)], BY_ID, NOW_MS], [], { alsoNaive: true });
checkLatest('an unplayable newest row gives way to the next playable one',
  [[ep('a-dead', 1, NOW_S - 1 * DAY, { enclosureUrl: '' }), ep('a-ok', 1, NOW_S - 20 * DAY)], BY_ID, NOW_MS],
  ['a-ok']);
checkLatest('a live broadcast is never a show\'s latest',
  [[ep('onair', 1, NOW_S, { liveStatus: 'live' })], BY_ID, NOW_MS], [], { alsoNaive: true });
checkLatest('an undated row is never a show\'s latest',
  [[ep('undated', 1, undefined)], BY_ID, NOW_MS], [], { alsoNaive: true });
checkLatest('a row for a feed we did not ask about is not ours to show',
  [[ep('stranger', 9, NOW_S)], BY_ID, NOW_MS], [], { alsoNaive: true });
// ---------------------------------------------------------------------------
section('seedMarks: a first check marks a NEW show at its newest episode, and nothing else');
// ---------------------------------------------------------------------------
// Measured 2026-10-01 in the browser: with the ordinary 7-day check also run
// for never-checked shows, daily news shows filled all 250 places, and that
// request was TRUNCATED, so no mark advanced and the next pass flooded again.
// So a show with no mark gets ONLY the first check, and its mark comes from
// that answer: the newest date the feed has. Episodes before it are, by the
// owner's rule, not shown.
checkSeedMarks('a show with no mark is marked at its newest episode',
  [{}, [ep('a2', 1, NOW_S - 3 * DAY), ep('a1', 1, NOW_S - 1 * DAY)], ['guid-a'], BY_ID],
  { 'guid-a': NOW_S - 1 * DAY }, { alsoNaive: true });
// A latest past 90 days is not SHOWN, but it is still the feed's newest — so the
// mark moves past it, and only what comes after is new.
checkSeedMarks('...even when that episode is too old to show',
  [{}, [ep('old', 1, NOW_S - 200 * DAY)], ['guid-a'], BY_ID], { 'guid-a': NOW_S - 200 * DAY },
  { alsoNaive: true });
// THE ONE THE NAIVE VERSION BREAKS. A show that HAS a mark is moved only by its
// ordinary check, which honours truncation. Moving it here would skip whatever
// lies between its mark and its latest episode when that check was truncated.
checkSeedMarks('a show that ALREADY has a mark is never moved by the first check',
  [{ 'guid-a': NOW_S - 9 * DAY }, [ep('a1', 1, NOW_S - 1 * DAY)], ['guid-a'], BY_ID],
  { 'guid-a': NOW_S - 9 * DAY });
checkSeedMarks('a show the first check did not cover gets no mark',
  [{}, [ep('b1', 2, NOW_S - 1 * DAY)], ['guid-a'], BY_ID], {}, { alsoNaive: true });
checkSeedMarks('an undated row cannot become a mark',
  [{}, [ep('undated', 1, undefined)], ['guid-a'], BY_ID], {}, { alsoNaive: true });

checkLatest('newest first across shows',
  [[ep('a', 1, NOW_S - 5 * DAY), ep('b', 2, NOW_S - 2 * DAY)], BY_ID, NOW_MS], ['b', 'a'],
  { alsoNaive: true });

// ---------------------------------------------------------------------------
section('pruneNewRows: unfavoriting a show takes its rows off the list too');
// ---------------------------------------------------------------------------
checkPruneRows('a row whose show is no longer favorited is dropped',
  [[ep('kept', 1, NOW_S), ep('gone', 9, NOW_S)], [1]], ['kept']);
checkPruneRows('everything still favorited survives',
  [[ep('kept', 1, NOW_S), ep('also', 2, NOW_S)], [1, 2]], ['kept', 'also'],
  { alsoNaive: true });

// ---------------------------------------------------------------------------
section('merge → advance: a mark may only describe a row on the LIST');
// ---------------------------------------------------------------------------
{
  // A pass returns more rows than the list can hold. Feed B's are the newest,
  // so they fill the cap and feed A's single old row is dropped — and feed A's
  // mark must therefore NOT move. Handing `advanceMarks` the fetched rows
  // instead marks that episode as seen, and the reader is never offered it.
  const bRows = Array.from({ length: FAV_NEW_CAP }, (_, i) => ep(`b${i}`, 2, NOW_S - i));
  // Above feed A's mark, so it is a genuinely new episode — and below every
  // feed-B row, so the cap drops it. Exactly the row the old wiring consumed.
  const aRow = ep('a-dropped', 1, NOW_S - 1 * DAY);
  checkPipeline('a row the cap dropped does NOT advance its feed mark',
    [PREV, [], [...bRows, aRow], ['guid-a', 'guid-b'], BY_ID, NOW_MS],
    { 'guid-a': NOW_S - 2 * DAY, 'guid-b': NOW_S });
}
checkPipeline('a row that survives DOES advance it',
  [PREV, [], [ep('a-new', 1, NOW_S - 1 * DAY)], ['guid-a', 'guid-b'], BY_ID, NOW_MS],
  { 'guid-a': NOW_S - 1 * DAY, 'guid-b': NOW_S - 6 * DAY }, { alsoNaive: true });
// The carry is not inert. A truncated pass advances NOTHING, so a row it found
// sits on the list above its own mark — and the next untruncated pass must
// settle it, even though that pass found nothing itself.
checkPipeline('a carried row still above its mark settles it on a later pass',
  [PREV, [ep('carried', 1, NOW_S - 1 * DAY)], [], ['guid-a', 'guid-b'], BY_ID, NOW_MS],
  { 'guid-a': NOW_S - 1 * DAY, 'guid-b': NOW_S - 6 * DAY });

// ---------------------------------------------------------------------------
section('The constants this repo states rather than passes around');
// ---------------------------------------------------------------------------
compare('FAV_NEW_WINDOW_MS is seven days', FAV_NEW_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
compare('FAV_NEW_CAP is 250 — a 221-show library\'s latest episodes fit', FAV_NEW_CAP, 250);
compare('FAV_NEW_SEED_WINDOW_MS is ninety days', FAV_NEW_SEED_WINDOW_MS, 90 * 24 * 60 * 60 * 1000);
// Sized against the clock: one PI call per feed, 6 at a time, 8 s each at worst.
compare('NEW_EPISODES_LATEST_MAX_FEEDS is 24 — five 8-second rounds at worst', NEW_EPISODES_LATEST_MAX_FEEDS, 24);
// The measured ceiling. PI answers 200 OK and drops the rest in silence, so
// nothing downstream can catch this being wrong.
compare('PI_FEED_IDS_MAX is 200', PI_FEED_IDS_MAX, 200);

// ---------------------------------------------------------------------------
section('Every vector above is replayed against the obvious wrong version');
// ---------------------------------------------------------------------------
{
  // No floor. Correct whenever every feed already has a mark, and catastrophic
  // the first time one does not.
  const naiveSince = (marks, guids) => {
    let min = Infinity;
    for (const g of guids) min = Math.min(min, marks[g] ?? 0);
    return Number.isFinite(min) ? min : 0;
  };

  // Trust the batch floor, and take a missing date as new. Both are the
  // shortcuts the real version exists to refuse.
  const naiveSelect = (rows, marks, byId, _nowMs) => {
    const floor = naiveSince(marks, Object.values(byId));
    return rows
      .filter((e) => (e.datePublished ?? Infinity) > floor)
      .sort((a, b) => (b.datePublished ?? 0) - (a.datePublished ?? 0));
  };

  // The one-liner: stamp every feed we asked about with now.
  const naiveAdvance = (prev, _rows, covered) => {
    const next = { ...prev };
    for (const g of covered) next[g] = Math.floor(Date.now() / 1000);
    return next;
  };

  // No prune at all.
  const naivePrune = (marks) => ({ ...marks });

  // REPLACE rather than merge — what the section shipped with. Correct on a
  // library that fits in one pass, and it deletes pass 1's rows on every
  // library that does not.
  const naiveMerge = (_prev, found) => [...found]
    .sort((a, b) => (b.datePublished ?? 0) - (a.datePublished ?? 0))
    .slice(0, FAV_NEW_CAP);

  // No prune at all, again — a row for an unfavorited show the reader cannot
  // get rid of.
  const naivePruneRows = (rows) => [...rows];

  // The obvious reuse: a first check is just the new-episodes rule with no
  // marks — so the seven-day horizon, and every row inside it, not one per show.
  const naiveLatest = (rows, byId, nowMs) => selectNewEpisodes(rows, {}, byId, nowMs);

  // The obvious reuse: advance over the first-check answer like any other. It
  // moves a mark that already exists, which a truncated ordinary check forbade.
  const naiveSeedMarks = (prev, rows, covered, byId) => advanceMarks(prev, rows, covered, byId, false);

  // What shipped: keep the FIRST `cap` keys.
  const naiveDismissed = (keys) => keys.slice(0, FAV_NEW_CAP);

  // THE ORIGINAL BUG: advance over what was FETCHED rather than what was kept.
  const naivePipeline = (prev, _prevRows, found, covered, byId) =>
    advanceMarks(prev, found, covered, byId, false);

  const call = (impl, v) => {
    try {
      const real = impl === 'real';
      switch (v.kind) {
        case 'since':
          return JSON.stringify(real ? sinceForBatch(...v.args) : naiveSince(...v.args));
        case 'select':
          return JSON.stringify((real ? selectNewEpisodes(...v.args) : naiveSelect(...v.args)).map((e) => e.title));
        case 'advance':
          return JSON.stringify(real ? advanceMarks(...v.args) : naiveAdvance(...v.args));
        case 'prune':
          return JSON.stringify(real ? pruneMarks(...v.args) : naivePrune(...v.args));
        case 'merge':
          return JSON.stringify((real ? mergeNewEpisodeRows(...v.args) : naiveMerge(...v.args)).map((e) => e.title));
        case 'latest':
          return JSON.stringify((real ? selectLatestEpisodes(...v.args) : naiveLatest(...v.args)).map((e) => e.title));
        case 'seedMarks':
          return JSON.stringify(real ? seedMarks(...v.args) : naiveSeedMarks(...v.args));
        case 'dismissed':
          return JSON.stringify(real ? capDismissed(...v.args) : naiveDismissed(...v.args));
        case 'pruneRows':
          return JSON.stringify((real ? pruneNewRows(...v.args) : naivePruneRows(...v.args)).map((e) => e.title));
        case 'pipeline':
          return JSON.stringify(real ? markPipeline(...v.args) : naivePipeline(...v.args));
        default: throw new Error(`unknown vector kind ${v.kind}`);
      }
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
    } catch (e) {
      return `threw ${(e && e.message) || e}`;
    }
  };

  // THE SHARED REPLAY. See `scripts/replay-vectors.mjs` — an
  // `{ alsoNaive: true }` vector used to have its `differs` result discarded, so
  // the exemption hid exactly what it was granted to protect.
  replayVectors({ vectors, invoke: call, fail: (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); } });
}

if (failures) {
  console.error(`\n${failures} favourites-new check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll favourites-new checks passed.');
