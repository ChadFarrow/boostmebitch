// Pins the two halves of `/live`'s 24/7 group (lib/util.ts):
//
//   `liveItemIsAlwaysOn`  — which `<podcast:liveItem>` is a STATION rather than
//                           a broadcast, so the page can file it under 📻 24/7
//                           instead of counting it as a show on air.
//   `planLiveRosterReads` — which feeds `/api/live-shows` spends its 24 roster
//                           reads on, once it knows which feeds are stations.
//
// THE FAILURE THIS IS WRITTEN AGAINST. Measured 2026-11-14: Podcast Index listed
// 40 feeds as live, and 20 of them were 24/7 channels — 17 Stupid Potato
// old-time-radio feeds and 3 Godcaster radio stations. Not one real show was on
// air. The page counted the 19 station rows it read as LIVE, and because those
// feeds republish their live item through the day, PI's record time ranked them
// first, so they took 18 of the route's 24 reads. Eight shows with a scheduled
// broadcast (Chad and Reeds, MMO, New Music Nudge Unit…) went unread, so their
// Upcoming rows never reached the page.
//
// Nostr already splits stations out by a TITLE convention (`is247` in
// components/nostr-live-streams.tsx: "24/7 Chiptune"). No RSS station in the
// measured roster says 24/7 in its title — "Dry Gulch: live now", "88.9 Crossway
// Radio - LIVE" — so that rule is `naiveAlwaysOn()` below, and the declared span
// (`end - start`, a day or more) is what the RSS side has instead.
//
// Vectors are recorded as CALLS and the replay walks the list, so a vector
// cannot be added without also being proved against the naive version. A vector
// both implementations agree on is reported as proving nothing unless it is
// marked as a deliberate must-still-work case.
import * as util from '../lib/util.ts';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

const { liveItemIsAlwaysOn, planLiveRosterReads } = util;
for (const [name, fn] of [['liveItemIsAlwaysOn', liveItemIsAlwaysOn], ['planLiveRosterReads', planLiveRosterReads]]) {
  if (typeof fn !== 'function') fail(`lib/util.ts does not export ${name}`);
}
if (failures) {
  console.log(`\n${failures} live-always-on check(s) FAILED.\n`);
  process.exit(1);
}

const DAY = 86_400;
// 2026-11-14T00:00:00Z — the day the roster above was measured.
const MIDNIGHT = 1_794_614_400;

// Shapes taken from the wire (`/api/live-shows` items, 2026-11-14).
const item = (title, liveStatus, liveStartTime, liveEndTime) => ({
  title, liveStatus, liveStartTime, liveEndTime, enclosureUrl: 'https://ex.test/live', feedId: 1,
});

// ── The wrong version for items: the Nostr strip's title convention ─────────
function naiveAlwaysOn(e) {
  return e.liveStatus === 'live' && /\b24\s*[/\-]\s*7\b/i.test(e.title ?? '');
}

const ITEM_VECTORS = [
  {
    name: 'THE ONE THAT MATTERS: a Stupid Potato channel — a live item from midnight to midnight',
    args: [item('Dry Gulch: live now', 'live', MIDNIGHT, MIDNIGHT + DAY)],
    want: true,
  },
  {
    name: 'a Godcaster station — a live item declared for a whole year',
    args: [item('88.9 Crossway Radio - LIVE', 'live', 1_793_903_375, 1_793_903_375 + 365 * DAY)],
    want: true,
  },
  {
    name: 'exactly one day is a station',
    args: [item('Laugh Track: live now', 'live', MIDNIGHT, MIDNIGHT + DAY)],
    want: true,
  },
  {
    name: 'a two-hour broadcast is a show, not a station',
    args: [item('Two Cities, One Linux', 'live', MIDNIGHT + 64_800, MIDNIGHT + 72_000)],
    want: false,
    alsoNaive: true,
  },
  {
    name: 'one second short of a day is still a show',
    // A long telethon or a marathon stream is a broadcast somebody started.
    args: [item('Bitfest marathon', 'live', MIDNIGHT, MIDNIGHT + DAY - 1)],
    want: false,
    alsoNaive: true,
  },
  {
    name: 'a "24/7" TITLE on a two-hour broadcast does not make it a station',
    // The declared span is the publisher's statement; a title is prose.
    args: [item('Why the 24/7 news cycle is broken', 'live', MIDNIGHT, MIDNIGHT + 7200)],
    want: false,
  },
  {
    name: 'a PENDING item with a day-long span is Upcoming, never 24/7',
    args: [item('Opening Night: live now', 'pending', MIDNIGHT + DAY, MIDNIGHT + 2 * DAY)],
    want: false,
    alsoNaive: true,
  },
  {
    name: 'no end declared is not a station — absent is not forever',
    args: [item('Pulse 101.7 FM - LIVE', 'live', MIDNIGHT, undefined)],
    want: false,
    alsoNaive: true,
  },
  {
    name: 'a Podcast Index 0 end is absent, not the epoch',
    // `0 - start` is negative today, but read as a stamp it is a broadcast that
    // ended in 1970 — `liveStampSecs` is the one place that decides.
    args: [item('x', 'live', MIDNIGHT, 0)],
    want: false,
    alsoNaive: true,
  },
  {
    name: 'no start declared is not a station either',
    args: [item('x', 'live', undefined, MIDNIGHT + DAY)],
    want: false,
    alsoNaive: true,
  },
  {
    name: 'an end BEFORE the start is not a span at all',
    args: [item('x', 'live', MIDNIGHT + DAY, MIDNIGHT)],
    want: false,
    alsoNaive: true,
  },
  {
    name: 'a non-finite stamp is absent',
    args: [item('x', 'live', MIDNIGHT, Number.POSITIVE_INFINITY)],
    want: false,
    alsoNaive: true,
  },
];

for (const v of ITEM_VECTORS) {
  let got;
  try { got = liveItemIsAlwaysOn(...v.args.map(clone)); }
  catch (e) { fail(`liveItemIsAlwaysOn: ${v.name} — threw: ${e.message}`); continue; }
  if (got !== v.want) {
    fail(`liveItemIsAlwaysOn: ${v.name} — got ${got}, want ${v.want}`);
    continue;
  }
  const naiveAgrees = naiveAlwaysOn(...v.args.map(clone)) === v.want;
  if (naiveAgrees && !v.alsoNaive) {
    fail(`liveItemIsAlwaysOn: ${v.name} — the title rule passes it too, so it proves nothing`);
  } else if (!naiveAgrees && v.alsoNaive) {
    fail(`liveItemIsAlwaysOn: ${v.name} — marked alsoNaive but the title rule FAILS it`);
  } else {
    ok(`liveItemIsAlwaysOn: ${v.name}` + (v.alsoNaive ? '  (must-still-work)' : '  (title rule fails it)'));
  }
}

// ── The wrong version for the plan: today's route, which has no allowance ───
function naivePlan(rosterIds, _alwaysOn, maxRoster) {
  const fromRoster = rosterIds.slice(0, maxRoster);
  return { fromRoster, fromAlwaysOn: [], truncated: rosterIds.length > fromRoster.length };
}

const station = (id) => ({ id, url: `https://ex.test/${id}/feed.xml`, alwaysOn: true, lastSeen: 1 });
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);

// The measured shape: 40 feeds, the 20 stations ranked first (freshest record
// time), the 20 regular feeds behind them.
const STATIONS = range(8_000_000, 20);
const SHOWS = range(5_000_000, 20);
const MEASURED = [...STATIONS, ...SHOWS];

// The roster production ranked on 2026-11-25 (`/episodes/live`, 40 rows, 37
// feeds), in `liveRosterFeedOrder` order, and the nine feeds whose own RSS
// carried a FUTURE `status="pending"` item that morning.
const MEASURED_2026_11_25 = [
  8106047, 8109818, 8113770, 8125249, 946122, 8101763, 8110391, 8120226, 8101550, 8107364,
  8063077, 8063078, 8063079, 8063080, 8063081, 8080084, 8080977, 8113147, 8114925, 8120311,
  7920227, 5350892, 8109888, 8108020, 8044056, 4831193, 7443578, 7111253, 5461087, 6754125,
  7156165, 8127839, 7968805, 7963427, 5904093, 7359152, 6611624,
];
const PENDING_2026_11_25 = [
  946122, 5350892, 4831193, 7443578, 5461087, 7968805, 7963427, 5904093, 6611624,
];

const PLAN_VECTORS = [
  {
    name: 'THE ONE THAT MATTERS: 20 known stations no longer push regular feeds past the 24-feed cap',
    args: [MEASURED, STATIONS.map(station), 24, 24],
    expect: (r) => SHOWS.every((id) => r.fromRoster.includes(id)) && !r.truncated,
  },
  {
    name: 'every listed station is still read — through its own allowance, so the 24/7 tab keeps it',
    args: [MEASURED, STATIONS.map(station), 24, 24],
    expect: (r) => r.fromAlwaysOn.length === 20 && r.fromAlwaysOn.every((f) => STATIONS.includes(f.id)),
  },
  {
    name: 'a station is read ONCE — never in both lists',
    args: [MEASURED, STATIONS.map(station), 24, 24],
    expect: (r) => !r.fromRoster.some((id) => STATIONS.includes(id)),
  },
  {
    name: 'a remembered station Podcast Index does NOT list today is not read',
    // The allowance is for PI's own public answer; memory alone never adds a row.
    args: [SHOWS, [station(9_999_999)], 24, 24],
    expect: (r) => r.fromAlwaysOn.length === 0 && r.fromRoster.length === 20,
    alsoNaive: true,
  },
  {
    name: 'a station past its allowance competes for a roster slot as before — never dropped by the plan',
    args: [[1, 2, 3, 4], [station(1), station(2), station(3)], 10, 2],
    expect: (r) => r.fromAlwaysOn.map((f) => f.id).join(',') === '1,2' && r.fromRoster.join(',') === '3,4',
  },
  {
    name: 'truncated counts the REGULAR feeds the cap cut, not the stations',
    args: [[...range(1, 30), ...range(100, 5)], range(100, 5).map(station), 30, 24],
    expect: (r) => r.truncated === false && r.fromRoster.length === 30,
  },
  {
    name: 'the roster keeps its ranked order once the stations leave it',
    args: [[7, 100, 3, 101, 9], [station(100), station(101)], 24, 24],
    expect: (r) => r.fromRoster.join(',') === '7,3,9',
  },
  // REPLACED 2026-11-25. Two vectors here pinned the COLD slice — "no
  // remembered stations: the plan is today's slice, unchanged" (30 feeds, no
  // memory, read 24, truncated) and "more regular feeds than the cap is still
  // reported as truncated" (26 + one known station, read 24, truncated). That
  // slice WAS the bug: Vercel runs several instances, each with its own memory,
  // so the instance that answered decided what a new visitor saw. Measured on
  // production that day, a cold instance answered 2 Upcoming rows and a warm
  // one 9, for the same roster. The intent of the second — truncation is still
  // reported past the bound — is kept below, against the new bound.
  {
    name: 'THE ONE THAT MATTERS NOW: the measured roster of 2026-11-25 with an EMPTY memory reads every feed',
    // Podcast Index's 37 feeds, in `liveRosterFeedOrder` order exactly as
    // production ranked them: 22 stations republished that morning sort first.
    // The cold slice read 24 — Bowl After Bowl, Hyper SpaceOut and 22 stations
    // — and cut the other 13, among them Chad and Reeds (index 32) and seven
    // more shows with a pending item.
    args: [MEASURED_2026_11_25, [], 24, 24],
    expect: (r) => PENDING_2026_11_25.every((id) => r.fromRoster.includes(id)) && !r.truncated,
  },
  {
    name: 'a cold plan reads as many feeds as a warm one — the unspent station allowance goes to the roster',
    args: [range(1, 30), [], 24, 24],
    expect: (r) => r.fromRoster.join(',') === range(1, 30).join(',') && !r.truncated && r.fromAlwaysOn.length === 0,
  },
  {
    name: 'more regular feeds than BOTH allowances is still reported as truncated',
    args: [range(1, 60), [], 24, 24],
    expect: (r) => r.truncated && r.fromRoster.join(',') === range(1, 48).join(','),
  },
  {
    name: 'a full station allowance leaves the roster its own cap, and truncation past it is reported',
    args: [[...range(1, 26), ...range(500, 24)], range(500, 24).map(station), 24, 24],
    expect: (r) => r.truncated && r.fromRoster.length === 24 && r.fromAlwaysOn.length === 24,
  },
  {
    name: 'one plan never reads more than the two allowances together',
    args: [range(1, 100), range(3, 5).map(station), 24, 24],
    expect: (r) => r.fromRoster.length + r.fromAlwaysOn.length <= 48,
    alsoNaive: true,
  },
  {
    name: 'an empty roster is an empty plan, not a throw',
    args: [[], [station(1)], 24, 24],
    expect: (r) => r.fromRoster.length === 0 && r.fromAlwaysOn.length === 0 && !r.truncated,
    alsoNaive: true,
  },
];

for (const v of PLAN_VECTORS) {
  let real;
  try { real = planLiveRosterReads(...v.args.map(clone)); }
  catch (e) { fail(`planLiveRosterReads: ${v.name} — threw: ${e.message}`); continue; }
  if (!v.expect(real)) {
    fail(`planLiveRosterReads: ${v.name} — wrong answer: ${JSON.stringify({ ...real, fromAlwaysOn: real.fromAlwaysOn.map((f) => f.id) })}`);
    continue;
  }
  let naiveAgrees;
  try { naiveAgrees = v.expect(naivePlan(...v.args.map(clone))); }
  catch { naiveAgrees = false; }
  if (naiveAgrees && !v.alsoNaive) {
    fail(`planLiveRosterReads: ${v.name} — today's slice passes it too, so it proves nothing`);
  } else if (!naiveAgrees && v.alsoNaive) {
    fail(`planLiveRosterReads: ${v.name} — marked alsoNaive but today's slice FAILS it`);
  } else {
    ok(`planLiveRosterReads: ${v.name}` + (v.alsoNaive ? '  (must-still-work)' : '  (today\'s slice fails it)'));
  }
}

// Nothing may be mutated: the route reads the remembered list again.
{
  const roster = [1, 2, 3];
  const remembered = [station(2)];
  const before = JSON.stringify([roster, remembered]);
  planLiveRosterReads(roster, remembered, 24, 24);
  if (JSON.stringify([roster, remembered]) !== before) fail('planLiveRosterReads mutated an argument');
  else ok('planLiveRosterReads mutates nothing');
}

const read = (await import('node:fs/promises')).readFile;

// The wiring a behavioural pin cannot see: the route and the page using them.
{
  const route = await read('app/api/live-shows/route.ts', 'utf8');
  const wiring = [
    ['the route plans its reads through planLiveRosterReads', /planLiveRosterReads\(/],
    ['the route marks each row through liveItemIsAlwaysOn', /liveItemIsAlwaysOn\(/],
    ['the route sends `alwaysOn` on each row', /alwaysOn:/],
  ];
  for (const [name, re] of wiring) {
    if (!re.test(route)) fail(`app/api/live-shows/route.ts: ${name} — not found`);
    else ok(`app/api/live-shows/route.ts: ${name}`);
  }
  const page = await read('components/live-page.tsx', 'utf8');
  if (!/s\.alwaysOn/.test(page) || !/'radio'/.test(page)) {
    fail('components/live-page.tsx does not split `alwaysOn` rows into the 24/7 tab');
  } else {
    ok('components/live-page.tsx splits `alwaysOn` rows into the 24/7 tab');
  }
}

// `lib/util.ts` must keep only TYPE imports, or this script cannot load the
// shipping functions at all.
{
  const src = await read('lib/util.ts', 'utf8');
  const bad = [...src.matchAll(/^\s*import\s+(?!type\b)[^\n]*$/gm)].map((m) => m[0].trim());
  if (bad.length) fail(`lib/util.ts has a value import:\n          ${bad.join('\n          ')}`);
  else ok('lib/util.ts still has only type-only imports');
}

function clone(v) {
  // JSON drops `undefined` and turns Infinity into null; keep both, they are vectors.
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

console.log(failures
  ? `\n${failures} live-always-on check(s) FAILED.\n`
  : '\nAll live-always-on checks passed.\n');
process.exit(failures ? 1 : 0);
