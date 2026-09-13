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
// All four live in lib/util.ts, whose only import is type-only, so this script
// imports the REAL module under `--experimental-strip-types`. It does NOT run
// `importFreeProblems`: that scan rejects type-only relative imports and
// lib/util.ts has one — `check:vts` and `check:queue` import it on the same
// terms.
//
// EVERY VECTOR IS A RECORDED CALL, replayed against the `naive*` versions at the
// foot. Exemptions are named one at a time with `alsoNaive: true`.

import {
  advanceMarks,
  FAV_NEW_CAP,
  FAV_NEW_WINDOW_MS,
  PI_FEED_IDS_MAX,
  pruneMarks,
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
section('The constants this repo states rather than passes around');
// ---------------------------------------------------------------------------
compare('FAV_NEW_WINDOW_MS is seven days', FAV_NEW_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
compare('FAV_NEW_CAP is 50', FAV_NEW_CAP, 50);
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
