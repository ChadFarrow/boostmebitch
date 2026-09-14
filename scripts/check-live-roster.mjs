// Pins `liveRosterFeedOrder` (lib/util.ts) — which feeds `/api/live-shows`
// spends its RSS verification budget on, and in what order.
//
// THE FAILURE THIS IS WRITTEN AGAINST. The route can only read so many feeds
// inside one function's time budget, so it slices the roster to
// `MAX_LIVE_FEEDS` (24) — and a feed past that slice is dropped with Podcast
// Index's own row included, so it is invisible on /live for the whole
// broadcast. The obvious implementation is `[...byFeed.keys()]`, which is
// `naive()` below: it ranks nothing, because `Map` insertion order here is
// whatever order PI answered `/episodes/live` in.
//
// That endpoint is documented as "all episodes that have been found in the
// podcast:liveitem", and `getGlobalLiveItems` keeps `pending` rows beside
// `live` ones — so a roster of scheduled broadcasts can spend the entire
// budget while a show on air right now sits past the cap and never gets read.
// Reported as "X is live right now via RSS but I don't see it in the live tab",
// which is indistinguishable on screen from PI never having heard of the show.
//
// `<LivePage>` already told the reader, on `truncated`, that the ones on air
// are checked first. Nothing made that true. This does.
//
// THE MUST-STILL-WORK HALF IS NOT DECORATION. Over-ranking is a regression too:
// the order must stay DETERMINISTIC across two requests a second apart (or the
// two halves of one roster alternate, and a show flickers on and off the page),
// and it must never promote a row on the strength of a start time it does not
// have — `?? 0` would make an unstamped row the newest broadcast in the world.
//
// Vectors are recorded as CALLS and the replay walks the list, so a vector
// cannot be added without also being proved against naive(). A vector both
// implementations agree on is reported as proving nothing.
import { liveRosterFeedOrder } from '../lib/util.ts';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

// ── The wrong version: the feed ids in the order PI happened to answer in ───
function naive(roster) {
  const seen = new Map();
  for (const e of roster) {
    const id = Number(e.feedId);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!seen.has(id)) seen.set(id, true);
  }
  return [...seen.keys()];
}

// Shapes taken from the wire. `getGlobalLiveItems` output is `buildEpisode`
// with `liveStatus`/`liveStartTime`/`liveEndTime` hand-added, and PI does not
// reliably send `feedId` as a number — `buildEpisode` copies it through
// unconverted, which is why some vectors below carry it as a string.
const row = (feedId, liveStatus, liveStartTime) => ({
  id: 1 + (Number(feedId) % 997),
  guid: `g-${feedId}-${liveStartTime ?? 'x'}`,
  title: 'Live from the barn',
  enclosureUrl: 'https://ex.test/s.mp3',
  feedId,
  feedTitle: 'Mutton, Mead & Music',
  liveStatus,
  liveStartTime,
  value: null,
});

const NOW = 1_757_000_000;

// ── Vectors, as CALLS. Each is replayed against naive() by the walk below. ──
const VECTORS = [
  {
    name: 'THE ONE THAT MATTERS: a live feed PI answered LAST still outranks every pending one',
    // The report. PI answers 3 scheduled shows, then the one that is on air.
    // naive() hands back [11, 12, 13, 14]; at a cap of 3 the live feed is gone.
    args: [[
      row(11, 'pending', NOW + 86_400),
      row(12, 'pending', NOW + 172_800),
      row(13, 'pending', NOW + 259_200),
      row(14, 'live', NOW - 600),
    ]],
    expect: (r) => r[0] === 14,
  },
  {
    name: 'every live feed comes before every pending one',
    args: [[
      row(21, 'pending', NOW + 3600),
      row(22, 'live', NOW - 60),
      row(23, 'pending', NOW + 7200),
      row(24, 'live', NOW - 9000),
    ]],
    expect: (r) => r.join(',') === '22,24,21,23',
  },
  {
    name: 'live band: the most recently STARTED broadcast leads',
    args: [[row(31, 'live', NOW - 7200), row(32, 'live', NOW - 120), row(33, 'live', NOW - 3600)]],
    expect: (r) => r.join(',') === '32,33,31',
  },
  {
    name: 'pending band: the SOONEST start leads',
    args: [[row(41, 'pending', NOW + 604_800), row(42, 'pending', NOW + 900), row(43, 'pending', NOW + 86_400)]],
    expect: (r) => r.join(',') === '42,43,41',
  },
  {
    name: 'a late pending item (start already past) leads its band, not the live one',
    // A host running twenty minutes behind is the most likely next broadcast,
    // and is still not a claim that anybody is on air.
    args: [[row(53, 'pending', NOW + 1200), row(52, 'pending', NOW - 1200), row(51, 'live', NOW - 30)]],
    expect: (r) => r.join(',') === '51,52,53',
  },
  {
    name: 'an undated LIVE row sorts last in its band, never first',
    // `?? 0` would read absent as the epoch — which in the live band, sorted
    // newest-first, would instead put it last by luck and first in pending.
    // Neither is a decision; this is.
    args: [[row(61, 'live', undefined), row(62, 'live', NOW - 4000)]],
    expect: (r) => r.join(',') === '62,61',
  },
  {
    name: 'an undated PENDING row sorts last in its band too',
    // Here `?? 0` genuinely inverts it: 0 is the soonest start imaginable.
    args: [[row(71, 'pending', undefined), row(72, 'pending', NOW + 500_000)]],
    expect: (r) => r.join(',') === '72,71',
  },
  {
    name: 'an undated live row still outranks a dated pending one',
    args: [[row(81, 'pending', NOW + 60), row(82, 'live', undefined)]],
    expect: (r) => r.join(',') === '82,81',
  },
  {
    name: 'one feed carrying both a live and a pending row is ranked LIVE',
    // Ordinary: a show on air that has already scheduled next week. Its live
    // row arrives LAST, behind another feed's schedule, so first-appearance
    // order buries it.
    args: [[row(93, 'pending', NOW + 3600), row(91, 'pending', NOW + 604_800), row(91, 'live', NOW - 100)]],
    expect: (r) => r.join(',') === '91,93',
  },
  {
    name: 'a feed with two live rows is ranked by the NEWER one',
    // The later row is OLDER, so "keep the first/last one seen" both get it
    // wrong: the feed is ranked by its newest broadcast, which is 102's.
    args: [[row(101, 'live', NOW - 20_000), row(102, 'live', NOW - 5000), row(101, 'live', NOW - 30_000)]],
    expect: (r) => r.join(',') === '102,101',
  },
  {
    name: 'a feed with two pending rows is ranked by the SOONER one',
    // 112's sooner row arrives last, so first-appearance order ranks 111 first.
    args: [[row(111, 'pending', NOW + 500_000), row(112, 'pending', NOW + 3600), row(112, 'pending', NOW + 60)]],
    expect: (r) => r.join(',') === '112,111',
  },
  {
    name: 'each feed appears ONCE however many rows it has',
    args: [[row(121, 'live', NOW - 1), row(121, 'live', NOW - 2), row(121, 'pending', NOW + 9)]],
    expect: (r) => r.length === 1 && r[0] === 121,
    // naive() dedupes too — this is the must-still-work half of it.
    alsoNaive: true,
  },
  {
    name: 'DETERMINISTIC: an equal-ranked pair breaks on feedId, whichever order PI sent them',
    // Two requests a second apart must verify the same 24 feeds. Stability
    // about PI's order is not stability — PI's order is the untrusted input.
    args: [[row(9, 'live', NOW - 100), row(8, 'live', NOW - 100), row(7, 'live', NOW - 100)]],
    expect: (r) => r.join(',') === '7,8,9',
  },
  {
    name: 'feedId arrives as a STRING and is still a feed',
    // PI does not reliably send it as a number; a strict check would drop the
    // whole roster and read as PI having gone quiet.
    args: [[row('4210', 'live', NOW - 50), row('99', 'pending', NOW + 50)]],
    expect: (r) => r.length === 2 && r[0] === 4210 && typeof r[0] === 'number',
    alsoNaive: true,
  },
  {
    name: 'a string feedId and its numeric twin are ONE feed',
    args: [[row('4210', 'pending', NOW + 5), row(4210, 'live', NOW - 5)]],
    expect: (r) => r.length === 1 && r[0] === 4210,
    alsoNaive: true,
  },
  {
    name: 'junk ids are dropped rather than passed on as NaN',
    args: [[row(0, 'live', NOW), row(-3, 'live', NOW), row('abc', 'live', NOW), row(12.5, 'live', NOW), row(55, 'live', NOW)]],
    expect: (r) => r.join(',') === '55',
    // naive() drops them too — the validation is not what this function adds.
    alsoNaive: true,
  },
  {
    name: 'an empty roster is an empty list, not a throw',
    args: [[]],
    expect: (r) => Array.isArray(r) && r.length === 0,
    alsoNaive: true,
  },
  {
    name: 'a non-finite start time is treated as absent, not as a rank',
    args: [[row(131, 'live', Number.NaN), row(132, 'live', NOW - 3)]],
    expect: (r) => r.join(',') === '132,131',
  },
];

// ── The replay is TOTAL: every vector runs against both implementations. ────
for (const v of VECTORS) {
  let real;
  try { real = liveRosterFeedOrder(...v.args.map(clone)); }
  catch (e) { fail(`${v.name} — shipping function threw: ${e.message}`); continue; }
  if (!v.expect(real)) {
    fail(`${v.name} — shipping function gave the wrong answer: [${real.join(',')}]`);
    continue;
  }

  let naiveAgrees;
  try { naiveAgrees = v.expect(naive(...v.args.map(clone))); }
  catch { naiveAgrees = false; }

  if (naiveAgrees && !v.alsoNaive) {
    fail(`${v.name} — naive() passes it too, so this vector proves nothing.\n`
      + '          Either sharpen it, or mark it { alsoNaive: true } as a\n'
      + '          deliberate must-still-work case.');
  } else if (!naiveAgrees && v.alsoNaive) {
    fail(`${v.name} — marked alsoNaive but naive() FAILS it. The mark is wrong.`);
  } else {
    ok(v.name + (v.alsoNaive ? '  (must-still-work)' : '  (naive() fails it)'));
  }
}

// The cap is the whole reason the order matters, so assert the pair: a live
// feed PI answered past the cap must survive a slice at MAX_LIVE_FEEDS.
{
  const roster = [];
  for (let i = 0; i < 40; i++) roster.push(row(1000 + i, 'pending', NOW + 3600 * (i + 1)));
  roster.push(row(2222, 'live', NOW - 90));
  const sliced = liveRosterFeedOrder(roster).slice(0, 24);
  if (!sliced.includes(2222)) fail('a live feed answered 41st is still trimmed by the 24-feed cap');
  else ok('a live feed answered 41st survives the 24-feed cap');
  if (naive(roster).slice(0, 24).includes(2222)) {
    fail('naive() keeps it too, so the cap pairing proves nothing');
  } else {
    ok('naive() loses it at the same cap  (naive() fails it)');
  }
}

// Nothing may be mutated: the route reads `roster` again to build `byFeed`.
{
  const roster = [row(3, 'live', NOW - 1), row(4, 'pending', NOW + 1)];
  const before = JSON.stringify(roster);
  liveRosterFeedOrder(roster);
  if (JSON.stringify(roster) !== before) fail('liveRosterFeedOrder mutated its argument');
  else ok('the roster is not mutated');
}

const read = (await import('node:fs/promises')).readFile;

// The one thing a behavioural pin cannot see: the route no longer calling it.
{
  const src = await read('app/api/live-shows/route.ts', 'utf8');
  if (!src.includes('liveRosterFeedOrder(roster)')) {
    fail('app/api/live-shows/route.ts no longer orders the roster through\n'
      + '          liveRosterFeedOrder — the cap is back to trimming by PI\'s answer order.');
  } else {
    ok('app/api/live-shows/route.ts orders the roster before it slices it');
  }
  if (/const\s+rosterIds\s*=\s*\[\s*\.\.\.byFeed\.keys\(\)\s*\]/.test(src)) {
    fail('app/api/live-shows/route.ts still slices `[...byFeed.keys()]` — that is\n'
      + '          Map insertion order, i.e. Podcast Index\'s response order.');
  } else {
    ok('the cap is not applied to Map insertion order');
  }
}

// `lib/util.ts` must keep only TYPE imports, or this script cannot load the
// shipping function at all and every check above silently becomes a copy test.
{
  const src = await read('lib/util.ts', 'utf8');
  const bad = [...src.matchAll(/^\s*import\s+(?!type\b)[^\n]*$/gm)].map((m) => m[0].trim());
  if (bad.length) {
    fail('lib/util.ts has a value import, which un-pins every check that reaches\n'
      + `          through this file:\n          ${bad.join('\n          ')}`);
  } else {
    ok('lib/util.ts still has only type-only imports');
  }
}

function clone(v) { return JSON.parse(JSON.stringify(v ?? null)); }

console.log(failures
  ? `\n${failures} live-roster check(s) FAILED.\n`
  : '\nAll live-roster checks passed.\n');
process.exit(failures ? 1 : 0);
