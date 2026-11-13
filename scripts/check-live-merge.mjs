// Pins `mergeLiveOverPi` (lib/util.ts) — the decision that turns Podcast
// Index's global live roster plus one publisher's RSS into the list `/live`
// renders.
//
// THE FAILURE THIS IS WRITTEN AGAINST. The obvious implementation unions the
// two sources: PI says a show is live, RSS says a show is live, show both.
// That is `naive()` below, and it is wrong in the one direction that has no
// self-correcting signal. Podcast Index lags the live transition in BOTH
// directions — measured 2026-08-07 returning ZERO live items for a feed that
// was actively publishing `status="live"` (docs/feeds.md:30), and it equally
// keeps rows for broadcasts that have already ended. A union therefore leaves
// finished shows on a "what is on air" page indefinitely: nothing in the feed
// will ever say "this ended", because the item is simply gone from it.
//
// The opposite mistake is the expensive one, and it is why this takes an `ok`
// flag rather than a bare array. `getLiveItemsFromRssDetailed` returns `[]` for
// BOTH "this feed lists no live items" and "we could not read this feed"
// (lib/pi.ts:656-661), so a merge that cannot tell them apart takes a running
// broadcast off the air the first time a publisher's host is slow. The rule is
// therefore asymmetric on purpose:
//
//   ok: true  → RSS is authoritative about which items EXIST, deletions included
//   ok: false → RSS is authoritative about NOTHING; PI's rows survive, unverified
//
// WHY THE FUNCTION LIVES IN lib/util.ts. `lib/pi.ts` cannot load under
// `node --experimental-strip-types` (`PiHttpError` uses a parameter property),
// so a check that lived beside the route could only ever have read its source.
// A grep proves the current text and nothing about behaviour. Here the script
// drives the shipping function.
//
// Vectors are recorded as CALLS and the replay walks the list, so a vector
// cannot be added without also being proved against naive(). A vector both
// implementations agree on is reported as proving nothing.
import { feedLiveItems, liveShowToEpisode, mergeLiveOverPi } from '../lib/util.ts';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

// ── The wrong version: union the two sources, trust whatever either says ────
function naive(piRows, rssRead) {
  const seen = new Set();
  const items = [];
  for (const e of [...rssRead.items, ...piRows]) {
    if (e.guid && seen.has(e.guid)) continue;
    if (e.guid) seen.add(e.guid);
    items.push(e);
  }
  return { items, verified: rssRead.ok };
}

// Shapes taken from the wire, not invented. A PI row is `buildEpisode` output
// with liveStatus/liveStartTime hand-added (lib/pi.ts) — positive `id`, and it
// carries `feedTitle`/`feedImage` that the RSS parser never sets. An RSS row is
// `getLiveItemsFromRssDetailed` output — synthetic NEGATIVE id, and it carries
// `value`/`liveValue`/`liveRemoteItem`, none of which PI indexes.
const piRow = (guid, over = {}) => ({
  id: 4210 + guid.length, guid, title: 'Live from the barn', enclosureUrl: 'https://ex.test/s.mp3',
  feedId: 7683902, feedTitle: 'Mutton, Mead & Music', feedImage: 'https://ex.test/art.jpg',
  podcastGuid: 'c90e609a-df1e-596a-bd5e-57bcc8aad6cc',
  liveStatus: 'live', liveStartTime: 1_754_000_000, value: null, ...over,
});
const rssRow = (guid, over = {}) => ({
  id: -998877, guid, title: 'Live from the barn', enclosureUrl: 'https://ex.test/s.mp3',
  feedId: 7683902, liveStatus: 'live', liveStartTime: 1_754_000_000,
  value: { type: 'lightning', method: 'keysend', recipients: [{ name: 'Host', type: 'node', address: '03abc', split: 100 }] },
  ...over,
});

// ── Vectors, as CALLS. Each is replayed against naive() by the walk below. ──
const VECTORS = [
  {
    name: 'RSS agrees the show is live → emitted, verified',
    args: [[piRow('g-live')], { ok: true, items: [rssRow('g-live')] }],
    expect: (r) => r.verified === true && r.items.length === 1 && r.items[0].liveStatus === 'live',
    // Both implementations emit one live row here.
    alsoNaive: true,
  },
  {
    name: 'RSS carries the value block PI does not index',
    args: [[piRow('g-live')], { ok: true, items: [rssRow('g-live')] }],
    expect: (r) => !!r.items[0].value?.recipients?.length,
    alsoNaive: true,
  },
  {
    name: 'a matched row takes PI’s real id over the parser’s synthetic one',
    args: [[piRow('g-live')], { ok: true, items: [rssRow('g-live')] }],
    // Same broadcast, same id, whichever branch produced the row — otherwise a
    // feed that flickers unreadable between polls remounts the card.
    expect: (r) => r.items[0].id === piRow('g-live').id,
  },
  {
    name: 'a matched row keeps the feed identifiers only PI supplies',
    args: [[piRow('g-live')], { ok: true, items: [rssRow('g-live')] }],
    expect: (r) => r.items[0].feedTitle === 'Mutton, Mead & Music'
      && r.items[0].feedImage === 'https://ex.test/art.jpg',
  },
  {
    name: 'THE ONE THAT MATTERS: readable RSS no longer lists it → the row is DROPPED',
    args: [[piRow('g-ended')], { ok: true, items: [] }],
    // naive() keeps it forever: nothing will ever arrive that says it ended.
    expect: (r) => r.verified === true && r.items.length === 0,
  },
  {
    name: 'unreadable RSS → PI’s row SURVIVES, flagged unverified',
    args: [[piRow('g-live')], { ok: false, items: [] }],
    // The other direction of the same asymmetry. naive() also keeps the row,
    // but reports `verified` off `ok`, so this one is about the pair.
    expect: (r) => r.verified === false && r.items.length === 1 && r.items[0].guid === 'g-live',
    alsoNaive: true,
  },
  {
    name: 'unreadable RSS never launders an empty read into a deletion',
    args: [[piRow('a'), piRow('b'), piRow('c')], { ok: false, items: [] }],
    expect: (r) => r.items.length === 3 && r.verified === false,
    alsoNaive: true,
  },
  {
    name: 'a pending item PI never held still appears',
    args: [[], { ok: true, items: [rssRow('g-next', { liveStatus: 'pending', liveStartTime: 1_754_600_000 })] }],
    // The whole Upcoming tab rests on this: PI indexes broadcasting rows only.
    expect: (r) => r.items.length === 1 && r.items[0].liveStatus === 'pending',
    alsoNaive: true,
  },
  {
    name: 'RSS status wins over PI’s stale one',
    args: [[piRow('g-x', { liveStatus: 'live' })], { ok: true, items: [rssRow('g-x', { liveStatus: 'pending' })] }],
    expect: (r) => r.items[0].liveStatus === 'pending',
    // naive() gets this right by accident — it lists RSS first and dedupes on
    // guid, so the RSS copy wins any field comparison. That accident is exactly
    // why a union LOOKS correct in review: it agrees on every vector where both
    // sources hold the item, and diverges only where one of them does not.
    alsoNaive: true,
  },
  {
    name: 'a guid-less RSS item is kept as the publisher wrote it',
    args: [[piRow('g-live')], { ok: true, items: [rssRow(undefined, { guid: undefined })] }],
    // Unmatchable is not absent — the same rule applyLiveStatuses follows.
    expect: (r) => r.items.length === 1 && r.items[0].id === -998877,
  },
  {
    name: 'an empty roster and an empty readable feed is an empty, verified list',
    args: [[], { ok: true, items: [] }],
    expect: (r) => r.verified === true && r.items.length === 0,
    alsoNaive: true,
  },
];

// ── The replay is TOTAL: every vector runs against both implementations. ────
for (const v of VECTORS) {
  const real = mergeLiveOverPi(...v.args.map(clone));
  if (!v.expect(real)) { fail(`${v.name} — shipping function gave the wrong answer`); continue; }

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

// Nothing may be mutated in place: the route calls this per feed inside a loop
// over a roster it still reads afterwards.
{
  const pi = [piRow('g-live')];
  const read = { ok: true, items: [rssRow('g-live')] };
  const before = JSON.stringify([pi, read]);
  mergeLiveOverPi(pi, read);
  if (JSON.stringify([pi, read]) !== before) fail('mergeLiveOverPi mutated its arguments');
  else ok('neither argument is mutated');
}

// THE SPLIT KIT SOCKET MUST SURVIVE THE TRIP TO THE PLAYER. The watcher opens
// it from the PLAYING episode's `liveValue` and from nowhere else, and the
// route builds each `LiveShow` field by field — so a field it does not name is
// gone. Measured 2026-11-13 on Homegrown Hits: PLAY on the /live card never
// connected to Split Kit, while PLAY on the same item's show page did.
{
  const lv = { uri: 'https://curiohoster.com/event?event_id=1873a383-d918-44e1-b6ff-c3598189dab6', protocol: 'socket.io' };
  const ep = liveShowToEpisode({
    guid: 'homegrownhits-158', title: 'Homegrown Hits Episode 158',
    enclosureUrl: 'https://ex.test/s.mp3', liveStatus: 'live', feedId: 6611624,
    verified: true, liveValue: lv,
  });
  if (JSON.stringify(ep.liveValue) !== JSON.stringify(lv)) {
    fail('liveShowToEpisode drops liveValue — PLAY on /live cannot open the Split Kit socket.');
  } else {
    ok('liveShowToEpisode carries liveValue to the episode the player stores');
  }
}

// ── `feedLiveItems`: the SHOW PAGE's live list (`/api/feed`) ────────────────
// The route used to union PI's rows with the RSS rows and let PI win a guid.
// That was harmless only while the roster was always empty; once it is not, a
// PI row (no `liveValue`, no payee) replaces the RSS row that carries both, and
// the show page stops connecting to Split Kit — the one door that worked.
{
  const lv = { uri: 'https://curiohoster.com/event?event_id=1873a383-d918-44e1-b6ff-c3598189dab6', protocol: 'socket.io' };
  const pi = [piRow('homegrownhits-158'), piRow('g-pi-only-ended')];
  const rss = rssRow('homegrownhits-158', { liveValue: lv });
  const piWins = (piRows, read) => {
    const seen = new Set();
    return [...piRows, ...read.items].filter((e) => !(e.guid && seen.has(e.guid)) && (seen.add(e.guid), true));
  };
  const read = { ok: true, items: [rss] };
  const got = feedLiveItems(pi, read);
  const old = piWins(pi, read);
  if (got.length !== 1 || JSON.stringify(got[0].liveValue) !== JSON.stringify(lv) || !got[0].value) {
    fail('feedLiveItems: with the RSS read, the RSS row (liveValue + payee) must be the only live item');
  } else if (old[0].liveValue) {
    fail('feedLiveItems: the PI-wins union agrees on this vector, so it proves nothing');
  } else {
    ok('feedLiveItems: a read RSS decides — its row keeps liveValue and payee, a PI-only row is dropped');
  }
  const unread = feedLiveItems(pi, { ok: false, items: [] });
  if (unread.length !== 2) fail('feedLiveItems: an unreadable feed must keep PI\'s rows, never end the show');
  else ok('feedLiveItems: an unreadable feed keeps PI\'s rows');
  const feedSrc = await (await import('node:fs/promises')).readFile('app/api/feed/route.ts', 'utf8');
  if (!/feedLiveItems\(\s*piLive\s*,/.test(feedSrc)) {
    fail('app/api/feed/route.ts no longer picks its live items through feedLiveItems —\n'
      + '          a PI row can replace the RSS row and strip the Split Kit socket.');
  } else {
    ok('app/api/feed/route.ts picks its live items through feedLiveItems');
  }
}

// The one thing a behavioural pin cannot see: the route no longer calling it.
const src = await (await import('node:fs/promises')).readFile('app/api/live-shows/route.ts', 'utf8');
if (!/liveValue:\s*e\.liveValue/.test(src)) {
  fail('app/api/live-shows/route.ts no longer copies liveValue into each LiveShow —\n'
    + '          PLAY on /live cannot open the Split Kit socket.');
} else {
  ok('app/api/live-shows/route.ts copies liveValue into each LiveShow');
}
if (!src.includes('mergeLiveOverPi')) {
  fail('app/api/live-shows/route.ts no longer calls mergeLiveOverPi — an unreadable\n'
    + '          feed can end a live broadcast again.');
} else {
  ok('app/api/live-shows/route.ts still routes its merge through mergeLiveOverPi');
}

// Both fan-outs must stay SEQUENTIAL passes with their own ceiling. Nesting the
// RSS walk inside the PI walk type-checks, lints and is still "bounded" — and
// it makes PI's courtesy limit double as the heap limit, so neither number then
// means what its doc comment says.
if (!/mapLimit\([\s\S]*?PI_FANOUT/.test(src) || !/mapLimit\([\s\S]*?FEED_FANOUT/.test(src)) {
  fail('app/api/live-shows/route.ts no longer bounds both passes with mapLimit.');
} else if (/PI_FANOUT[\s\S]{0,400}?getLiveItemsFromRssDetailed/.test(src)) {
  fail('the RSS read appears INSIDE the PI_FANOUT walk — the two passes must be\n'
    + '          sequential, each with its own ceiling.');
} else {
  ok('the PI and RSS fan-outs are separate passes, each bounded by its own constant');
}

function clone(v) { return JSON.parse(JSON.stringify(v ?? null)); }

console.log(failures
  ? `\n${failures} live-merge check(s) FAILED.\n`
  : '\nAll live-merge checks passed.\n');
process.exit(failures ? 1 : 0);
