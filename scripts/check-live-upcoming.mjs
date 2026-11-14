// Pins `mergeUpcomingSeen` (lib/util.ts) — how `/live` carries its Upcoming
// list from one poll to the next.
//
// THE FAILURE THIS IS WRITTEN AGAINST. Measured on production 2026-11-14: the
// Upcoming tab read 3, then 6, then 9 — one more copy of every scheduled show
// each minute the page stayed open. The merge cleared only the feeds the
// visitor's OWN `?feeds=` list asked about, then APPENDED every pending row in
// the response; a scheduled show from Podcast Index's roster is in no visitor's
// list, so its row was appended again on every poll and never cleared. It also
// pushed into the array the PREVIOUS state still held, which React's StrictMode
// double call made visible in development as a jump of two.
//
// `naive()` below is that merge, line for line. Vectors are recorded as calls
// and replayed against it, so a vector cannot prove nothing by accident.
import * as util from '../lib/util.ts';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

const { mergeUpcomingSeen } = util;
if (typeof mergeUpcomingSeen !== 'function') {
  fail('lib/util.ts does not export mergeUpcomingSeen');
  console.log(`\n${failures} live-upcoming check(s) FAILED.\n`);
  process.exit(1);
}

// ── The wrong version: the updater `<LivePage>` shipped with ────────────────
function naive(prev, askedIds, items) {
  const next = { ...prev };
  for (const id of askedIds) delete next[id];
  for (const s of items) {
    if (s.liveStatus !== 'pending') continue;
    (next[s.feedId] ??= []).push(s);
  }
  return next;
}

const NOW = 1_794_680_000;
const row = (feedId, guid, liveStatus = 'pending') => ({
  guid, title: `Show ${guid}`, enclosureUrl: 'https://ex.test/live.mp3', liveStatus,
  liveStartTime: NOW + 86_400, feedId, verified: true,
});
const rows = (state) => Object.values(state).flat().map((s) => `${s.feedId}:${s.guid}`).sort().join(',');
// Poll `n` times with the same answer, from an empty page.
const polls = (n, askedIds, items) => {
  const calls = [];
  for (let i = 0; i < n; i++) calls.push([askedIds, items]);
  return calls;
};

// Each vector is a SEQUENCE of polls, `[askedIds, items]`, from `start`.
const VECTORS = [
  {
    name: 'THE ONE THAT MATTERS: three polls of the same roster schedule leave ONE row per show, not three',
    // The production shape: three scheduled shows from PI's roster, no favorites.
    start: {},
    calls: polls(3, [], [row(946122, 'bab-468'), row(5350892, 'hso-nov15'), row(4432692, 'unr-68')]),
    expect: (s) => rows(s) === '4432692:unr-68,5350892:hso-nov15,946122:bab-468',
  },
  {
    name: 'a roster show that STARTED loses its Upcoming row — it is in Live now',
    start: {},
    calls: [[[], [row(946122, 'bab-468')]], [[], [row(946122, 'bab-468', 'live')]]],
    expect: (s) => rows(s) === '',
  },
  {
    name: 'a roster show that MOVED its broadcast keeps only the new one',
    start: {},
    calls: [[[], [row(4831193, 'mmo-1110')]], [[], [row(4831193, 'mmo-1117')]]],
    expect: (s) => rows(s) === '4831193:mmo-1117',
  },
  {
    name: 'an ASKED feed with nothing pending loses its rows (an item withdrawn from the feed)',
    start: { 7968805: [row(7968805, 'cr-015')] },
    calls: [[[7968805], []]],
    expect: (s) => rows(s) === '',
    alsoNaive: true,
  },
  {
    name: 'a feed this poll neither asked about nor answered for keeps its rows (the rotation)',
    start: { 7985519: [row(7985519, 'nmnu-1121')] },
    calls: [[[6611624], [row(6611624, 'hgh-159')]]],
    expect: (s) => rows(s) === '6611624:hgh-159,7985519:nmnu-1121',
    alsoNaive: true,
  },
  {
    name: 'the first poll is the response\'s schedule, as it was',
    start: {},
    calls: [[[], [row(1, 'a'), row(2, 'b'), row(2, 'live-now', 'live')]]],
    expect: (s) => rows(s) === '1:a,2:b',
    alsoNaive: true,
  },
  {
    name: 'two scheduled broadcasts on one feed are both kept',
    start: {},
    calls: [[[], [row(3, 'x'), row(3, 'y')]]],
    expect: (s) => rows(s) === '3:x,3:y',
    alsoNaive: true,
  },
];

for (const v of VECTORS) {
  const run = (fn) => {
    let state = structuredClone(v.start);
    for (const [asked, items] of v.calls) state = fn(state, structuredClone(asked), structuredClone(items));
    return state;
  };
  let real;
  try { real = run(mergeUpcomingSeen); }
  catch (e) { fail(`${v.name} — threw: ${e.message}`); continue; }
  if (!v.expect(real)) { fail(`${v.name} — wrong answer: [${rows(real)}]`); continue; }
  const naiveAgrees = v.expect(run(naive));
  if (naiveAgrees && !v.alsoNaive) fail(`${v.name} — the shipped merge passes it too, so it proves nothing`);
  else if (!naiveAgrees && v.alsoNaive) fail(`${v.name} — marked alsoNaive but the shipped merge FAILS it`);
  else ok(v.name + (v.alsoNaive ? '  (must-still-work)' : '  (the shipped merge fails it)'));
}

// React may call an updater twice with the SAME previous state (StrictMode),
// and keeps the previous state for its own comparisons — so it must not change.
{
  const prev = { 946122: [row(946122, 'bab-468')] };
  const before = JSON.stringify(prev);
  mergeUpcomingSeen(prev, [], [row(946122, 'bab-468')]);
  if (JSON.stringify(prev) !== before) fail('mergeUpcomingSeen changed the previous state in place');
  else ok('mergeUpcomingSeen leaves the previous state as it was');
  const twice = { ...prev };
  naive(twice, [], [row(946122, 'bab-468')]);
  if (JSON.stringify(prev) === before) fail('the shipped merge leaves it alone too, so this proves nothing');
  else ok('the shipped merge changes it in place  (the shipped merge fails it)');
}

const read = (await import('node:fs/promises')).readFile;
{
  const page = await read('components/live-page.tsx', 'utf8');
  if (!/mergeUpcomingSeen\(/.test(page)) fail('components/live-page.tsx does not merge Upcoming through mergeUpcomingSeen');
  else ok('components/live-page.tsx merges Upcoming through mergeUpcomingSeen');
}

console.log(failures
  ? `\n${failures} live-upcoming check(s) FAILED.\n`
  : '\nAll live-upcoming checks passed.\n');
process.exit(failures ? 1 : 0);
