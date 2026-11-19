// Pins lib/demu.ts — which search rows the DEMU type keeps. See
// docs/superpowers/specs/2026-11-15-demu-search-design.md.
//
// Listeners use DEMU to check that a song is self-hosted before they request
// it on Homegrown Hits, a show that plays only DeMu. Both failure directions
// answer that check wrongly and nothing on screen says so:
//
//   OVER-ACCEPT  A Wavlake album answers "yes, DeMu", and the request goes to a
//                show that cannot play it.
//
//   UNDER-ACCEPT A self-hosted album answers "not DeMu", and the artist loses
//                the request.
//
// `naive()` is the HOST test — "not on wavlake.com" — because it is the obvious
// build and it is wrong: Wavlake's QA feeds live on a `run.app` host and carry
// the Wavlake generator (8097582 below), and a closed host such as RSS Blue is
// not wavlake.com either. Chad's rule tests the generator, not the host.
//
// FIXTURES COME FROM THE WIRE: every row below is Podcast Index's own record
// (`/podcasts/byfeedid`, 2026-11-15), cut to the two fields the rule reads.
// Longy is the reference artist: he has the same album, Katherines Wheel, on
// Wavlake (6443203) and self-hosted on headstarts.uk (7287540).

import {
  isDemuFeed, demuRosterRows, demuRosterFromPi, sortDemuAlbums, demuGroups, demuAge, demuDateLabel, matchesDemuQuery,
  hasValueBlock, demuValueGaps, keepWithValue, keepForDemu, mspFeedGuids, confirmValueMissing,
  demuAppOf, DEMU_APPS, withCoverFallback, saysTest, demuCopyCandidates, demuCopiesToHide,
} from '../lib/demu.ts';
import { DEMU_HIDE_LIST, DEMU_HIDE_AUTHORS, HOMEGROWN_HITS_FEED_URL } from '../lib/demu-hide-list.ts';
import { remoteItemFeedGuids, feedHasValueTag, newestItemImage } from '../lib/feed-xml.ts';
import { closedService } from '../lib/moved-feeds.ts';
import { SEARCH_TYPES, parseSearchType, matchesSearchType, mergeSearchLanes } from '../lib/util.ts';
import { replayVectors } from './replay-vectors.mjs';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

// The /demu list groups and ages rows in the VIEWER'S local time, so the
// vectors below run in a fixed zone whose day differs from UTC's for five
// hours of every day. Set here, not before the imports: ES imports run first,
// and none of the imported modules creates a `Date` while it loads. Node
// re-reads `TZ` on the next `Date` operation.
process.env.TZ = 'America/New_York';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

const naive = (row) => !String(row.url ?? '').includes('wavlake.com');

const ROWS = {
  wavlakeAlbum: { id: 7146493, generator: 'Wavlake', url: 'https://wavlake.com/feed/music/4403575a-c0b8-48df-8738-285ee6c826d7' },
  wheelOnWavlake: { id: 6443203, generator: 'Wavlake', url: 'https://www.wavlake.com/feed/10b82d0f-f893-49c1-b1e2-55e97fe32465' },
  wavlakeQa: { id: 8097582, generator: 'Wavlake', url: 'https://feeds-qa-854568123236.us-central1.run.app/v1/album/naddr1qqjrxdmpxdjnswfj95mxzvrx956rwef595ursdek95ckvwpcxs6rvcmxxcurxq3q8zpx0p6v9qhl2ftq4r3449q9lz6l882zdf4qx7g4nucahuzy4ukqxpqqqzz4kelytds' },
  wheelOnMsp: { id: 7287540, generator: 'Music Side Project Studio', url: 'https://headstarts.uk/msp/longy/Katherines Wheel/katherines wheel.xml' },
  worriedOnFountain: { id: 7520866, generator: 'Fountain', url: 'https://feeds.fountain.fm/aCFEYwJijoBbZSUP32JA' },
  blankGenerator: { id: 46385, generator: '', url: 'https://feed.justcast.com/shows/dennis-cartier-cartieradio-by-dennis-cartier/audioposts.rss' },
  worriedOnRssBlue: { id: 7101864, generator: 'RSS Blue v1.21.3', url: 'https://feeds.rssblue.com/worried' },
};

const vectors = [
  { label: 'Wavlake album on wavlake.com (7146493)', args: [ROWS.wavlakeAlbum], expect: false, alsoNaive: true },
  { label: 'Katherines Wheel, Wavlake copy (6443203)', args: [ROWS.wheelOnWavlake], expect: false, alsoNaive: true },
  { label: 'Wavlake QA feed on run.app (8097582)', args: [ROWS.wavlakeQa], expect: false },
  { label: 'Katherines Wheel, MSP copy on headstarts.uk (7287540)', args: [ROWS.wheelOnMsp], expect: true, alsoNaive: true },
  // Fountain is not DeMu since 2026-11-16 (Chad: "Fountain needs removed there too",
  // after /demu dropped it): by generator, or by a feed on fountain.fm.
  { label: 'Worried on Fountain (7520866)', args: [ROWS.worriedOnFountain], expect: false },
  // NOT FROM THE WIRE: the host half of the rule, and a look-alike host that is not Fountain.
  { label: 'a feed on fountain.fm under another generator', args: [{ id: 1, generator: 'Something Else', url: 'https://feeds.fountain.fm/abc' }], expect: false },
  { label: 'a look-alike host is not fountain.fm', args: [{ id: 2, generator: '', url: 'https://notfountain.fm.example.com/x.xml' }], expect: true, alsoNaive: true },
  { label: 'Cartieradio, blank generator (46385)', args: [ROWS.blankGenerator], expect: true, alsoNaive: true },
  { label: 'Worried on RSS Blue, a closed host (7101864)', args: [ROWS.worriedOnRssBlue], expect: false },
  // NOT FROM THE WIRE — a contract vector. PI always sends `generator`, as ""
  // when the feed has none (Cartieradio above), and `buildPodcast` keeps it.
  // An ABSENT field therefore means the wiring broke (a refactor, a slimmer
  // projection, a lane that builds rows another way), and "absent passes"
  // would turn every Wavlake album into DeMu with nothing on screen to say so.
  // Absent FAILS CLOSED: DEMU goes empty, loudly, instead.
  { label: 'generator field absent (broken wiring) fails closed', args: [{ id: 0, url: ROWS.worriedOnFountain.url }], expect: false },
];

const call = (impl, v) => {
  try {
    return impl === 'real' ? isDemuFeed(v.args[0], closedService) : naive(v.args[0]);
  } catch (e) {
    return `threw ${(e && e.message) || e}`;
  }
};

console.log('isDemuFeed — the shipping answer:');
for (const v of vectors) {
  const got = call('real', v);
  if (got !== v.expect) fail(`"${v.label}" — expected ${v.expect}, got ${got}`);
  else ok(v.label);
}

console.log('\nThe replay against naive():');
replayVectors({ vectors, invoke: call, fail });

// ── The selector: the menu entry, the allowlist, the music half ──────────────
// `lib/util.ts` may not import `lib/demu.ts` (type-only imports there), so the
// lane is composed in the route. The composition below is the route's, over
// the real functions: filter both lanes with the rule, then the shared join.
console.log('\nThe DEMU selector type:');
{
  const MENU = { type: 'demu', label: 'DEMU', noun: 'DeMu albums', placeholder: 'search self-hosted music…' };
  const at = SEARCH_TYPES.findIndex((s) => s.type === 'demu');
  if (JSON.stringify(SEARCH_TYPES[at]) !== JSON.stringify(MENU)) fail(`menu entry is ${JSON.stringify(SEARCH_TYPES[at])}`);
  else ok('the menu entry reads DEMU / DeMu albums / search self-hosted music…');
  if (at !== SEARCH_TYPES.findIndex((s) => s.type === 'music') + 1) fail(`DEMU sits at ${at}, not directly after ♫ MUSIC`);
  else ok('DEMU sits directly after ♫ MUSIC');

  if (parseSearchType('demu') !== 'demu') fail(`parseSearchType('demu') is ${parseSearchType('demu')}`);
  else ok("parseSearchType('demu') is 'demu'");
  if (parseSearchType('DEMU') !== 'demu') fail(`parseSearchType('DEMU') is ${parseSearchType('DEMU')}`);
  else ok("parseSearchType('DEMU') is 'demu'");

  if (matchesSearchType({ medium: 'music' }, 'demu') !== true) fail('a music row does not match demu');
  else ok('a music row matches demu');
  // "Longy - Everything" (7696544) is Longy's publisher feed, not an album. It
  // is under DEMU only once its feed has said it publishes music (the route's
  // `withPublisherMediums`; Chad, 2026-11-16: "demu publisher should be in music
  // and demu"). Unread, it stays in the PODCASTS residual bucket.
  if (matchesSearchType({ medium: 'publisher' }, 'demu') !== false) fail('an unread publisher row matches demu');
  else ok('an unread publisher row does not match demu');
  if (matchesSearchType({ medium: 'publisher', publisherMediums: ['music'] }, 'demu') !== true) fail('a publisher of music does not match demu');
  else ok('a publisher of music matches demu');

  const music = [
    ROWS.wavlakeAlbum, ROWS.wheelOnWavlake, ROWS.wavlakeQa, ROWS.wheelOnMsp,
    ROWS.worriedOnFountain, ROWS.blankGenerator, ROWS.worriedOnRssBlue,
  ].map((r) => ({ ...r, medium: 'music' }));
  const byterm = [
    { id: 7696544, medium: 'publisher', generator: 'MSP 2.0 - Music Side Project Studio', url: 'https://headstarts.uk/msp/publisher-feeds/longy-everything-publisher-feed.xml' },
    { ...ROWS.worriedOnFountain, medium: 'music' },
    { ...ROWS.wheelOnMsp, medium: 'music' },
  ];
  const keep = (f) => isDemuFeed(f, closedService);
  const ids = mergeSearchLanes(music.filter(keep), byterm.filter(keep), 'demu', 50).map((f) => f.id);
  if (JSON.stringify(ids) !== JSON.stringify([7287540, 46385])) fail(`the DEMU lane returned ${JSON.stringify(ids)}`);
  else ok('the DEMU lane keeps 7287540, 46385: Wavlake, Fountain, RSS Blue and the unread publisher feed out, the repeat deduped');

  // The same lane once both publisher feeds were read. Longy's is self-hosted
  // and stays; DJ Yo!'s (8096868, PI's record per #587: generator "Fountain",
  // 46 `music` children) is MUSIC but not DeMu, so `isDemuFeed` drops it.
  const read = [
    { ...byterm[0], publisherMediums: ['music'] },
    { id: 8096868, medium: 'publisher', generator: 'Fountain', url: 'https://feeds.fountain.fm/RUasFqfffS7e3HGkHo24', publisherMediums: ['music'] },
    ...byterm.slice(1),
  ];
  const readIds = mergeSearchLanes(music.filter(keep), read.filter(keep), 'demu', 50).map((f) => f.id);
  if (JSON.stringify(readIds) !== JSON.stringify([7287540, 46385, 7696544])) fail(`the DEMU lane with read publishers returned ${JSON.stringify(readIds)}`);
  else ok('a read DeMu publisher (7696544) joins the DEMU lane; a Fountain publisher (8096868) does not');
}

// ── The /demu list: roster rows, order, groups, ages, dates, search ──────────
// `now` is a Sunday evening in New York, 02:00 MONDAY in UTC — so a function
// that reads UTC fields puts "now" in the next week, which is exactly the
// mistake the group and age vectors exist to catch.
const now = new Date(2026, 10, 15, 21, 0);
const nowSec = Math.floor(now.getTime() / 1000);
const t = (y, m, d, h = 12, min = 0) => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);
const album = (id, newestItemPubdate, extra = {}) => ({ id, title: `a${id}`, medium: 'music', newestItemPubdate, ...extra });

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// naive() for groups: the same bands, read in UTC.
function naiveGroup(sec) {
  if (sec == null) return 'No date';
  const day = (x) => new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
  const monday = (x) => { const y = day(x); y.setUTCDate(y.getUTCDate() - ((y.getUTCDay() + 6) % 7)); return y; };
  const d = new Date(Math.min(sec, nowSec) * 1000);
  const w = Math.round((monday(now) - monday(d)) / (7 * 864e5));
  const md = (x) => `${MON[x.getUTCMonth()]} ${x.getUTCDate()}`;
  if (w < 8) {
    const s = monday(d);
    const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6);
    const range = s.getUTCMonth() === e.getUTCMonth() ? `${md(s)}–${e.getUTCDate()}` : `${md(s)}–${md(e)}`;
    return w === 0 ? `This week · ${range}` : w === 1 ? `Last week · ${range}` : `Week of ${md(s)}`;
  }
  const start = monday(now); start.setUTCDate(start.getUTCDate() - 49);
  const diff = (start.getUTCFullYear() - d.getUTCFullYear()) * 12 + start.getUTCMonth() - d.getUTCMonth();
  return diff <= 11 ? `${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}` : String(d.getUTCFullYear());
}
// naive() for ages: hours inside a day, the way `timeAgo` reads.
function naiveAge(sec) {
  const diff = nowSec - sec;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  const d = Math.floor(diff / 86400);
  if (d === 1) return '1 day';
  if (d < 14) return `${d} days`;
  if (d < 60) return `${Math.floor(d / 7)} weeks`;
  if (d < 365) return `${Math.floor(d / 30)} months`;
  const y = Math.floor(d / 365);
  return y === 1 ? '1 year' : `${y} years`;
}
const naiveDate = (sec) => { const d = new Date(sec * 1000); return `${MON[d.getMonth()]} ${d.getDate()}`; };
const naiveSort = (albums) => [...albums].sort((a, b) => (b.newestItemPubdate ?? 0) - (a.newestItemPubdate ?? 0));
const naiveQuery = (a, q) => (a.title ?? '').includes(q) || (a.author ?? '').includes(q);
const naiveRoster = (rows) => rows.filter((r) => !/wavlake/i.test(r.generator ?? ''));

// The `lemons` pair is a REAL duplicate guid (LNBeats' updateMusicFiles/dupes.json
// lists 7560785 "lemons" and 7216161 "Lemons" under it). Their URLs, generators and
// dates here are stand-ins; the guid, ids and titles are the wire's. The generator is
// a blank stand-in since 2026-11-16, when Fountain left /demu: on Fountain both rows
// would drop as Fountain and the pair would test nothing.
const LEMONS = '27bc3c57-6b47-5029-873d-9876c7ba2f1e';
const ROSTER_IN = [
  ...Object.values(ROWS),
  { id: 7560785, podcastGuid: LEMONS, title: 'lemons', generator: '', url: 'https://example.com/lemons-1.xml', newestItemPubdate: 200 },
  { id: 7216161, podcastGuid: LEMONS, title: 'Lemons', generator: '', url: 'https://example.com/lemons-2.xml', newestItemPubdate: 100 },
  { ...ROWS.worriedOnFountain, id: 1, dead: 1 },
];

const listVectors = [
  // groups
  { kind: 'group', label: 'Sunday morning is this week', args: [t(2026, 11, 15, 10)], expect: 'This week · Nov 9–15' },
  { kind: 'group', label: 'Monday 00:30 is this week', args: [t(2026, 11, 9, 0, 30)], expect: 'This week · Nov 9–15' },
  { kind: 'group', label: 'Sunday 23:30 is last week', args: [t(2026, 11, 8, 23, 30)], expect: 'Last week · Nov 2–8' },
  { kind: 'group', label: 'Monday 03:00 UTC is still Sunday in New York', args: [Date.UTC(2026, 10, 9, 3) / 1000], expect: 'Last week · Nov 2–8' },
  { kind: 'group', label: 'the DST day (Nov 1) stays in its week', args: [t(2026, 11, 1)], expect: 'Week of Oct 26', alsoNaive: true },
  { kind: 'group', label: 'Monday after DST is last week', args: [t(2026, 11, 2, 0, 30)], expect: 'Last week · Nov 2–8' },
  { kind: 'group', label: 'the 8th weekly group', args: [t(2026, 9, 21)], expect: 'Week of Sep 21' },
  { kind: 'group', label: 'one day past the weekly window is a month', args: [t(2026, 9, 20)], expect: 'September 2026', alsoNaive: true },
  { kind: 'group', label: 'the 12th month back', args: [t(2025, 10, 5)], expect: 'October 2025', alsoNaive: true },
  { kind: 'group', label: 'past the 12 months is a year', args: [t(2025, 9, 30)], expect: '2025', alsoNaive: true },
  { kind: 'group', label: 'an old album is its year', args: [t(2024, 6, 1)], expect: '2024', alsoNaive: true },
  { kind: 'group', label: 'no date is the last group', args: [undefined], expect: 'No date', alsoNaive: true },
  { kind: 'group', label: 'a future date counts as now', args: [t(2026, 11, 20)], expect: 'This week · Nov 9–15' },
  // ages
  { kind: 'age', label: 'earlier today', args: [t(2026, 11, 15, 10)], expect: 'today' },
  { kind: 'age', label: 'last night is 1 day', args: [t(2026, 11, 14, 23)], expect: '1 day' },
  { kind: 'age', label: '3 days', args: [t(2026, 11, 12)], expect: '3 days', alsoNaive: true },
  { kind: 'age', label: '13 days', args: [t(2026, 11, 2)], expect: '13 days', alsoNaive: true },
  { kind: 'age', label: '16 days is 2 weeks', args: [t(2026, 10, 30)], expect: '2 weeks', alsoNaive: true },
  { kind: 'age', label: '75 days is 2 months', args: [t(2026, 9, 1)], expect: '2 months', alsoNaive: true },
  { kind: 'age', label: '370 days is 1 year', args: [t(2025, 11, 10)], expect: '1 year', alsoNaive: true },
  { kind: 'age', label: '897 days is 2 years', args: [t(2024, 6, 1)], expect: '2 years', alsoNaive: true },
  { kind: 'age', label: 'a future date is upcoming', args: [t(2026, 11, 20)], expect: 'upcoming' },
  // dates
  { kind: 'date', label: 'this year: month and day', args: [t(2026, 11, 14)], expect: 'Nov 14', alsoNaive: true },
  { kind: 'date', label: 'another year: with the year', args: [t(2024, 6, 1)], expect: 'Jun 1, 2024' },
  // sort
  {
    kind: 'sort',
    label: 'future as now, ties by id desc, no date last',
    args: [[album(1, t(2026, 11, 1)), album(2, t(2026, 11, 20)), album(3, undefined), album(4, t(2026, 11, 14)), album(5, t(2026, 11, 14))]],
    expect: [2, 5, 4, 1, 3],
  },
  // search
  { kind: 'query', label: 'artist, padded', args: [{ title: 'Katherines Wheel', author: 'Longy' }, ' longy '], expect: true },
  { kind: 'query', label: 'title, other case', args: [{ title: 'Katherines Wheel', author: 'Longy' }, 'WHEEL'], expect: true },
  { kind: 'query', label: 'no match', args: [{ title: 'Katherines Wheel', author: 'Longy' }, 'wavlake'], expect: false, alsoNaive: true },
  { kind: 'query', label: 'an empty query matches', args: [{ title: 'Katherines Wheel', author: 'Longy' }, ''], expect: true, alsoNaive: true },
  // roster
  {
    kind: 'roster',
    label: 'roster drops Wavlake, Fountain, closed, dead and the older duplicate guid',
    args: [ROSTER_IN],
    // 7520866 (Worried, on Fountain) left with Chad's option B, 2026-11-16.
    expect: { ids: [46385, 7287540, 7560785], allMusic: true, generatorKeys: 0 },
  },
];

const runList = (impl, v) => {
  const real = impl === 'real';
  switch (v.kind) {
    case 'group':
      return real ? demuGroups([album(9, v.args[0])], now)[0]?.label : naiveGroup(v.args[0]);
    case 'age': return real ? demuAge(v.args[0], now) : naiveAge(v.args[0]);
    case 'date': return real ? demuDateLabel(v.args[0], now) : naiveDate(v.args[0]);
    case 'sort': return (real ? sortDemuAlbums(v.args[0], nowSec) : naiveSort(v.args[0])).map((a) => a.id);
    case 'query': return real ? matchesDemuQuery(v.args[0], v.args[1]) : naiveQuery(v.args[0], v.args[1]);
    case 'roster': {
      const out = real ? demuRosterRows(v.args[0], closedService) : naiveRoster(v.args[0]);
      return {
        ids: out.map((a) => a.id).sort((a, b) => a - b),
        allMusic: out.every((a) => a.medium === 'music'),
        generatorKeys: out.filter((a) => 'generator' in a).length,
      };
    }
  }
};
const callList = (impl, v) => {
  try { return JSON.stringify(runList(impl, v)); } catch (e) { return `threw ${(e && e.message) || e}`; }
};

console.log('\nThe /demu list — the shipping answer:');
for (const v of listVectors) {
  const got = callList('real', v);
  if (got !== JSON.stringify(v.expect)) fail(`"${v.label}" — expected ${JSON.stringify(v.expect)}, got ${got}`);
  else ok(v.label);
}
console.log('\nThe /demu list — the replay against naive():');
replayVectors({ vectors: listVectors, invoke: callList, fail });
// ── An answer that read nothing is NOT an empty roster ───────────────────────
// `null` is "do not cache, say could-not-load"; `[]` would be cached for six
// hours and rendered as "0 DeMu albums" (final review, 2026-11-15). The naive
// is the code that shipped first: a malformed body flattened into `[]`.
const naiveFromPi = (data) => demuRosterRows(Array.isArray(data?.feeds) ? data.feeds : [], closedService);
const piVectors = [
  { label: 'no body', args: [null], expect: null },
  { label: 'no feeds field (a schema change)', args: [{ status: 'true' }], expect: null },
  { label: 'feeds is not a list', args: [{ feeds: {} }], expect: null },
  { label: 'an empty feeds list', args: [{ feeds: [] }], expect: null },
  { label: 'rows without generator (PI dropped the field) all fail closed', args: [{ feeds: [{ id: 1, url: ROWS.worriedOnFountain.url }, { id: 2, url: ROWS.wheelOnMsp.url }] }], expect: null },
  // 7520866 (Worried, on Fountain) left with Chad's option B, 2026-11-16.
  { label: 'a real answer keeps its DeMu rows', args: [{ feeds: Object.values(ROWS) }], expect: [7287540, 46385], alsoNaive: true },
];
const callPi = (impl, v) => {
  try {
    const out = impl === 'real' ? demuRosterFromPi(v.args[0], closedService) : naiveFromPi(v.args[0]);
    return JSON.stringify(out === null ? null : out.map((a) => a.id).sort((a, b) => a - b));
  } catch (e) { return `threw ${(e && e.message) || e}`; }
};
console.log('\ndemuRosterFromPi — the shipping answer:');
for (const v of piVectors) {
  const want = JSON.stringify(v.expect === null ? null : [...v.expect].sort((a, b) => a - b));
  const got = callPi('real', v);
  if (got !== want) fail(`"${v.label}" — expected ${want}, got ${got}`);
  else ok(v.label);
}
console.log('\ndemuRosterFromPi — the replay against naive():');
replayVectors({ vectors: piVectors, invoke: callPi, fail });

// ── Chad's rule: a feed without <podcast:value> is not on /demu ──────────────
// (2026-11-16: "Remove anything that doesn't have <podcast:value>".) Podcast
// Index's music list carries no value field, so the roster asks two sources:
// the static file of every feed with a value block, and — for feeds the file
// does not list yet — the live batch call, whose `valueBlock` is a JSON STRING
// or null. Fixtures: the batch answer of 2026-11-16 (UXRZONE null, Radio 1
// Timemachine keysend, DJ Yo! lnaddress) and the static file's object shape.
const VB_RADIO1 = '{"model":{"type":"lightning","method":"keysend"},"destinations":[{"name":"Radio 1 Rocks","type":"node","address":"hello@radio1.rocks","split":100}]}';
const VB_DJYO = '{"model":{"type":"lightning","method":"lnaddress"},"destinations":[{"name":"djyo@fountain.fm","type":"lnaddress","address":"djyo@fountain.fm","split":90},{"name":"Fountain","type":"lnaddress","address":"boostbot@fountain.fm","split":10}]}';
const naiveHasValue = (v) => v != null && v !== '';
const valueVectors = [
  { label: 'UXRZONE: valueBlock null', args: [null], expect: false, alsoNaive: true },
  { label: 'Radio 1 Timemachine: a keysend block (a JSON string)', args: [VB_RADIO1], expect: true, alsoNaive: true },
  { label: 'DJ Yo!: an lnaddress block (a JSON string)', args: [VB_DJYO], expect: true, alsoNaive: true },
  { label: 'the static file shape: an object', args: [JSON.parse(VB_DJYO)], expect: true, alsoNaive: true },
  { label: 'a block with no destinations is no value block', args: ['{"model":{"type":"lightning","method":"keysend"},"destinations":[]}'], expect: false },
  { label: 'an unreadable string is no value block', args: ['{not json'], expect: false },
  { label: 'the string "null" is no value block', args: ['null'], expect: false },
];
const callValue = (impl, v) => {
  try { return JSON.stringify(impl === 'real' ? hasValueBlock(v.args[0]) : naiveHasValue(v.args[0])); } catch (e) { return `threw ${(e && e.message) || e}`; }
};
console.log('\nhasValueBlock — the shipping answer:');
for (const v of valueVectors) {
  const got = callValue('real', v);
  if (got !== JSON.stringify(v.expect)) fail(`"${v.label}" — expected ${v.expect}, got ${got}`);
  else ok(v.label);
}
console.log('\nhasValueBlock — the replay against naive():');
replayVectors({ vectors: valueVectors, invoke: callValue, fail });

console.log('\nThe value filter over the roster:');
{
  // Ids and guids from the 2026-11-16 list: 4827093 Radio 1 Timemachine (in the
  // file), 7982024 UXRZONE (in neither), 8115349 I Don't Wanna Leave (newer than
  // the file; the batch says value), 7287540 Longy (in the file).
  const albums = [
    album(4827093, 1, { podcastGuid: '2ad45cc1-f1ff-57f5-bb84-c2c0a9b21fbe' }),
    album(7982024, 2, { podcastGuid: '01f38143-ea31-5285-9dc2-0878d2097b3b' }),
    album(8115349, 3, { podcastGuid: 'AAAA0000-0000-0000-0000-000000000001' }),
    album(7287540, 4, { podcastGuid: 'bbbb0000-0000-0000-0000-000000000002' }),
  ];
  const inFile = new Set([4827093, 7287540]);
  const gaps = demuValueGaps(albums, inFile);
  if (JSON.stringify(gaps) !== JSON.stringify(['01f38143-ea31-5285-9dc2-0878d2097b3b', 'aaaa0000-0000-0000-0000-000000000001'])) {
    fail(`demuValueGaps asks for ${JSON.stringify(gaps)}`);
  } else ok('demuValueGaps asks only for feeds the file does not list, guids lower-cased');
  const batch = new Map([['01f38143-ea31-5285-9dc2-0878d2097b3b', false], ['aaaa0000-0000-0000-0000-000000000001', true]]);
  const kept = keepWithValue(albums, inFile, batch).map((a) => a.id).sort((a, b) => a - b);
  if (JSON.stringify(kept) !== JSON.stringify([4827093, 7287540, 8115349])) fail(`keepWithValue kept ${JSON.stringify(kept)}`);
  else ok('keepWithValue keeps the file’s feeds and the batch’s yes; drops UXRZONE');
  const unasked = keepWithValue(albums, inFile, new Map()).map((a) => a.id).sort((a, b) => a - b);
  if (JSON.stringify(unasked) !== JSON.stringify([4827093, 7287540])) fail(`keepWithValue without a batch answer kept ${JSON.stringify(unasked)}`);
  else ok('a feed nobody answered for is not kept (no value proven)');
}

// ── Homegrown Hits plays it → always shown; the hide list → never shown ──────
// Chad, 2026-11-16: "Items that match the remote items in the Homegrown Hits
// feed [are] what we are looking to show here", "Radio shows should be removed",
// "A hide list is a good idea", and what HGH plays is on the show list, never
// the hide list. So PLAYED wins over HIDDEN, which wins over the value rule.
console.log('\nHomegrown Hits and the hide list:');
{
  // Wire: two real tags from feed.homegrownhits.xyz (2026-11-16) — one inside a
  // valueTimeSplit with an itemGuid, one bare — plus an upper-case repeat and a
  // decoy attribute `readAttr` must not read as feedGuid.
  const xml = '<rss><channel><item><podcast:valueTimeSplit startTime="30.665" remotePercentage="99" duration="213">'
    + '<podcast:remoteItem feedGuid="86f9ba78-7c4a-5bd2-a382-c6a88e9a96a0" itemGuid="1e5cea5b-050c-4ac2-8ce1-6867f10e169c" />'
    + '</podcast:valueTimeSplit></item>'
    + '<podcast:remoteItem feedGuid="7c6f7875-2b73-491e-b32c-e2c8d6e91d53" />'
    + '<podcast:remoteItem feedGuid="86F9BA78-7C4A-5BD2-A382-C6A88E9A96A0" itemGuid="x" />'
    + '<podcast:remoteItem x-feedGuid="00000000-0000-0000-0000-00000000dead" /></channel></rss>';
  const got = JSON.stringify(remoteItemFeedGuids(xml));
  const want = JSON.stringify(['86f9ba78-7c4a-5bd2-a382-c6a88e9a96a0', '7c6f7875-2b73-491e-b32c-e2c8d6e91d53']);
  if (got !== want) fail(`remoteItemFeedGuids gave ${got}`);
  else ok('remoteItemFeedGuids: every remoteItem, lower-cased, deduped, no decoy attribute');

  // 4827093 Radio 1 Timemachine (value, HIDDEN); 7744401 MOOKY (no value, PLAYED);
  // 7982024 UXRZONE (no value); 7287540 Longy (value, PLAYED); 1 a played feed
  // someone also put on the hide list — played wins.
  const albums = [
    album(4827093, 1, { podcastGuid: '2ad45cc1-f1ff-57f5-bb84-c2c0a9b21fbe' }),
    album(7744401, 2, { podcastGuid: 'cccc0000-0000-0000-0000-000000000003' }),
    album(7982024, 3, { podcastGuid: '01f38143-ea31-5285-9dc2-0878d2097b3b' }),
    album(7287540, 4, { podcastGuid: 'bbbb0000-0000-0000-0000-000000000002' }),
    album(1, 5, { podcastGuid: 'dddd0000-0000-0000-0000-000000000004' }),
  ];
  const kept = keepForDemu(albums, {
    valueIds: new Set([4827093, 7287540]),
    batch: new Map(),
    played: new Set(['cccc0000-0000-0000-0000-000000000003', 'bbbb0000-0000-0000-0000-000000000002', 'dddd0000-0000-0000-0000-000000000004']),
    hidden: new Set(['2ad45cc1-f1ff-57f5-bb84-c2c0a9b21fbe', 'dddd0000-0000-0000-0000-000000000004']),
  }).map((a) => a.id).sort((a, b) => a - b);
  if (JSON.stringify(kept) !== JSON.stringify([1, 7287540, 7744401])) fail(`keepForDemu kept ${JSON.stringify(kept)}`);
  else ok('keepForDemu: played wins over hidden and over no value; hidden beats a value block; the rest need value');

  const gaps = demuValueGaps(albums, new Set([4827093, 7287540]), new Set(['cccc0000-0000-0000-0000-000000000003', 'dddd0000-0000-0000-0000-000000000004']));
  if (JSON.stringify(gaps) !== JSON.stringify(['01f38143-ea31-5285-9dc2-0878d2097b3b'])) fail(`demuValueGaps with a skip set asks for ${JSON.stringify(gaps)}`);
  else ok('demuValueGaps skips feeds already decided (played or hidden)');

  // The hide list itself: lower-case unique guids, a title and a reason each,
  // and never a feed Homegrown Hits plays (two the show plays, from its feed).
  const guids = DEMU_HIDE_LIST.map((h) => h.guid);
  const wellFormed = DEMU_HIDE_LIST.every((h) => /^[0-9a-f-]{36}$/.test(h.guid) && h.title && h.reason);
  if (!wellFormed || new Set(guids).size !== guids.length) fail('the hide list has a malformed or repeated entry');
  else ok(`the hide list: ${guids.length} entries, lower-case unique guids, each with a title and a reason`);
  const playedSample = ['86f9ba78-7c4a-5bd2-a382-c6a88e9a96a0', 'ee7351fd-9646-4843-ae49-0e2aacf524be'];
  if (guids.some((g) => playedSample.includes(g))) fail('the hide list names a feed Homegrown Hits plays');
  else ok('the hide list names no sampled Homegrown Hits feed');
  if (HOMEGROWN_HITS_FEED_URL !== 'https://feed.homegrownhits.xyz/feed.xml') fail(`HOMEGROWN_HITS_FEED_URL is ${HOMEGROWN_HITS_FEED_URL}`);
  else ok('the Homegrown Hits feed URL is the show’s own feed');

  // Chad, 2026-11-16: "Any feed made by MSP gets shown." Both MSP generator
  // spellings from the wire; a hide-list line still wins (DJ Criket's mixes are
  // MSP-made and Chad hid them by name) — only Homegrown Hits beats the list.
  const msp = mspFeedGuids([
    { id: 7929072, podcastGuid: '9D75EDEC-139E-41A8-8ADD-EE146993E15B', generator: 'MSP 2.0 - Music Side Project Studio' },
    { id: 7287540, podcastGuid: 'bbbb0000-0000-0000-0000-000000000002', generator: 'Music Side Project Studio' },
    { id: 8099814, podcastGuid: 'be51bf9f-4350-4f79-896a-e9328b3c332b', generator: 'MSP 2.0 - Music Side Project Studio' },
    { id: 7520866, podcastGuid: 'eeee0000-0000-0000-0000-000000000005', generator: 'Fountain' },
    { id: 7353237, podcastGuid: 'ffff0000-0000-0000-0000-000000000006', generator: 'Sovereign Feeds' },
  ]);
  if (JSON.stringify([...msp].sort()) !== JSON.stringify(['9d75edec-139e-41a8-8add-ee146993e15b', 'bbbb0000-0000-0000-0000-000000000002', 'be51bf9f-4350-4f79-896a-e9328b3c332b'])) {
    fail(`mspFeedGuids gave ${JSON.stringify([...msp])}`);
  } else ok('mspFeedGuids: both MSP generator spellings, lower-cased; Fountain and Sovereign Feeds are not MSP');
  // NOT FROM THE WIRE: Chad names three more spellings ("MSP or MSP 2.0 or MSP
  // Studio would be in the generator tag"); PI held none of them on 2026-11-16.
  // "MSP" is matched as a WORD, so a tool whose name merely starts with it is not.
  const spelled = mspFeedGuids([
    { id: 1, podcastGuid: 'a0000000-0000-0000-0000-000000000001', generator: 'MSP' },
    { id: 2, podcastGuid: 'a0000000-0000-0000-0000-000000000002', generator: 'MSP 2.0' },
    { id: 3, podcastGuid: 'a0000000-0000-0000-0000-000000000003', generator: 'MSP Studio' },
    { id: 4, podcastGuid: 'a0000000-0000-0000-0000-000000000004', generator: 'MSPodcaster 1.2' },
  ]);
  if (JSON.stringify([...spelled].sort()) !== JSON.stringify(['a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003'])) {
    fail(`mspFeedGuids on Chad's spellings gave ${JSON.stringify([...spelled])}`);
  } else ok('mspFeedGuids: "MSP", "MSP 2.0", "MSP Studio" are MSP; "MSPodcaster" is not');
  const mspKept = keepForDemu(
    [album(7929072, 1, { podcastGuid: '9d75edec-139e-41a8-8add-ee146993e15b' }), album(8099814, 2, { podcastGuid: 'be51bf9f-4350-4f79-896a-e9328b3c332b' })],
    { valueIds: new Set(), batch: new Map(), played: new Set(), hidden: new Set(['be51bf9f-4350-4f79-896a-e9328b3c332b']), msp },
  ).map((a) => a.id);
  if (JSON.stringify(mspKept) !== JSON.stringify([7929072])) fail(`keepForDemu with MSP kept ${JSON.stringify(mspKept)}`);
  else ok('an MSP feed without a value block is shown (Phase 2); a hidden MSP feed is not (DJ Criket)');

  // LNBeats' allowFeed() (thebells1111/lnbeats, src/old_routes/+layout.svelte), Chad
  // 2026-11-16: "Can we add the lnbeats allowfeed() list here also?" Its ids map to
  // guids (PI, 2026-11-16); its two authors hide by name, so a NEW feed of theirs stays
  // off too. Wire: 6801467 is one of the 13 Board Game Design Lab archives on the second
  // guid, author "Gabe Barrett", with a value block in this vector.
  const lnbeats = ['27293ad7-c199-5047-8135-a864fb546492', 'c64fab29-66bf-56da-a7f3-c2a11f37f526',
    'aa9471ed-f45b-5a15-9e72-9b4ea6f6af3b', 'c9c7bad3-4712-514e-9ebd-d1e208fa1b76', '3e7c4f6a-9f9e-5b13-8d8a-eb053b35d377'];
  const missing = lnbeats.filter((g) => !guids.includes(g));
  if (missing.length) fail(`the hide list lacks LNBeats' allowFeed() feeds ${JSON.stringify(missing)}`);
  else ok("the hide list carries every LNBeats allowFeed() feed still in Podcast Index");
  if (JSON.stringify([...DEMU_HIDE_AUTHORS].sort()) !== JSON.stringify(['Gabe Barrett', '小杉毅誉大'])) {
    fail(`DEMU_HIDE_AUTHORS is ${JSON.stringify(DEMU_HIDE_AUTHORS)}`);
  } else ok("DEMU_HIDE_AUTHORS is LNBeats' two authors");
  const byAuthor = keepForDemu(
    [
      album(6801467, 1, { podcastGuid: 'eeee0000-0000-0000-0000-00000000000a', author: 'Gabe Barrett' }),
      album(2, 2, { podcastGuid: 'eeee0000-0000-0000-0000-00000000000b', author: ' 小杉毅誉大 ' }),
      album(3, 3, { podcastGuid: 'eeee0000-0000-0000-0000-00000000000c', author: 'Gabe Barrett' }),
      album(4, 4, { podcastGuid: 'eeee0000-0000-0000-0000-00000000000d', author: 'Gabe Barrett Jr' }),
    ],
    {
      valueIds: new Set([6801467, 2, 3, 4]), batch: new Map(),
      played: new Set(['eeee0000-0000-0000-0000-00000000000c']), hidden: new Set(),
      hiddenAuthors: new Set(DEMU_HIDE_AUTHORS),
    },
  ).map((a) => a.id);
  if (JSON.stringify(byAuthor) !== JSON.stringify([3, 4])) fail(`keepForDemu by author kept ${JSON.stringify(byAuthor)}`);
  else ok('a hidden author is off even with a value block (trimmed, exact name); Homegrown Hits still wins; a longer name is not that author');

  // Chad, 2026-11-16: an album shown without a value block (MOOKY, Homegrown Hits plays
  // it; Phase 2, MSP made it) stays, but says the block is missing. `valueMissing` only
  // when the batch call SAID no — an unanswered guid is "not known", never "missing".
  const flagged = keepForDemu(
    [
      album(7744401, 1, { podcastGuid: 'cccc0000-0000-0000-0000-000000000003' }), // played, batch: no
      album(7929072, 2, { podcastGuid: '9d75edec-139e-41a8-8add-ee146993e15b' }), // MSP, batch: no
      album(7287540, 3, { podcastGuid: 'bbbb0000-0000-0000-0000-000000000002' }), // played, in the value file
      album(5, 4, { podcastGuid: 'cccc0000-0000-0000-0000-000000000005' }), // played, batch: yes
      album(6, 5, { podcastGuid: 'cccc0000-0000-0000-0000-000000000006' }), // played, batch never answered
      album(8115349, 6, { podcastGuid: 'dddd0000-0000-0000-0000-000000000008' }), // value rule only
    ],
    {
      valueIds: new Set([7287540, 8115349]),
      batch: new Map([
        ['cccc0000-0000-0000-0000-000000000003', false],
        ['9d75edec-139e-41a8-8add-ee146993e15b', false],
        ['cccc0000-0000-0000-0000-000000000005', true],
      ]),
      played: new Set(['cccc0000-0000-0000-0000-000000000003', 'bbbb0000-0000-0000-0000-000000000002',
        'cccc0000-0000-0000-0000-000000000005', 'cccc0000-0000-0000-0000-000000000006']),
      hidden: new Set(),
      msp: new Set(['9d75edec-139e-41a8-8add-ee146993e15b']),
    },
  );
  const marks = JSON.stringify(flagged.map((a) => [a.id, a.valueMissing === true]));
  const wantMarks = JSON.stringify([[7744401, true], [7929072, true], [7287540, false], [5, false], [6, false], [8115349, false]]);
  if (marks !== wantMarks) fail(`valueMissing marks ${marks}`);
  else ok('valueMissing: set when the batch said no (MOOKY, Phase 2); never for a value-file feed, a batch yes, or an unanswered guid');
  const gapsKeepPlayed = demuValueGaps(
    [album(7744401, 1, { podcastGuid: 'cccc0000-0000-0000-0000-000000000003' }), album(4827093, 2, { podcastGuid: '2ad45cc1-f1ff-57f5-bb84-c2c0a9b21fbe' })],
    new Set(), new Set(['2ad45cc1-f1ff-57f5-bb84-c2c0a9b21fbe']),
  );
  if (JSON.stringify(gapsKeepPlayed) !== JSON.stringify(['cccc0000-0000-0000-0000-000000000003'])) fail(`demuValueGaps asked ${JSON.stringify(gapsKeepPlayed)}`);
  else ok('a played feed outside the value file is still asked about, so its mark is a fact; a hidden one is not');

  // PI's value data is CHANNEL-level. MOOKY (Podhome, 2026-11-16) carries its block on
  // the ITEM, so PI says "none" while the track pays two recipients. The feed's own RSS
  // decides: any <podcast:value>, channel or item. Wire: MOOKY's item block, trimmed.
  const vectors = [
    ['item-level block (MOOKY)', '<rss><channel><title>MOOKY</title><item><title>t</title><podcast:value type="lightning" method="lnaddress" suggested="0.00004200000"><podcast:valueRecipient name="mooky@fountain.fm" type="node" address="03b6" split="75"/></podcast:value></item></channel></rss>', true],
    ['channel-level block', '<rss><channel><podcast:value type="lightning" method="keysend"><podcast:valueRecipient address="03b6" split="1"/></podcast:value><item/></channel></rss>', true],
    ['self-closing block', '<rss><channel><podcast:value type="lightning" method="keysend" /></channel></rss>', true],
    ['no block (Phase 2)', '<rss><channel><title>Phase 2</title><item><title>t</title><enclosure url="https://x/a.mp3"/></item></channel></rss>', false],
    ['only a valueTimeSplit (not a value block)', '<rss><channel><item><podcast:valueTimeSplit startTime="1" duration="2" remotePercentage="90"><podcast:remoteItem feedGuid="x"/></podcast:valueTimeSplit></item></channel></rss>', false],
    ['only a stray valueRecipient', '<rss><channel><podcast:valueRecipient address="03b6" split="1"/></channel></rss>', false],
  ];
  for (const [name, xml, want] of vectors) {
    if (feedHasValueTag(xml) !== want) fail(`feedHasValueTag: ${name} gave ${!want}`);
    else ok(`feedHasValueTag: ${name} → ${want}`);
  }
  const confirmed = confirmValueMissing(
    [
      { ...album(7744401, 1, { podcastGuid: 'cccc0000-0000-0000-0000-000000000003' }), valueMissing: true }, // RSS: item block
      { ...album(7929072, 2, { podcastGuid: '9d75edec-139e-41a8-8add-ee146993e15b' }), valueMissing: true }, // RSS: none
      { ...album(9, 3, { podcastGuid: 'cccc0000-0000-0000-0000-000000000009' }), valueMissing: true }, // RSS unreadable
      album(8115349, 4, { podcastGuid: 'dddd0000-0000-0000-0000-000000000008' }), // never marked
    ],
    new Map([
      ['cccc0000-0000-0000-0000-000000000003', true],
      ['9d75edec-139e-41a8-8add-ee146993e15b', false],
      ['cccc0000-0000-0000-0000-000000000009', null],
    ]),
  );
  const cmarks = JSON.stringify(confirmed.map((a) => [a.id, a.valueMissing === true]));
  if (cmarks !== JSON.stringify([[7744401, false], [7929072, true], [9, false], [8115349, false]])) fail(`confirmValueMissing gave ${cmarks}`);
  else ok('confirmValueMissing: the stamp stays only when the RSS was read and has no <podcast:value> (Phase 2); item-level (MOOKY) and unreadable lose it');
}

// ── Fountain is not on /demu (Chad, 2026-11-16, option B) ─────────────────────
// "Can we also hide fountain hosted feeds?" — all of them, even the 74 Homegrown
// Hits plays, so the drop happens in the roster, before keepForDemu's played rule.
// "Fountain hosted": generator Fountain OR a feed on fountain.fm (364 and 364, the
// same albums that day). The DEMU search type drops them too ("Fountain needs
// removed there too"), so both read one rule: isDemuFeed → isFountainFeed.
console.log('\nFountain off /demu:');
{
  const rows = demuRosterRows([
    { id: 8115349, podcastGuid: 'f1', title: "I Don't Wanna Leave", generator: 'Fountain', url: 'https://feeds.fountain.fm/keSrIDz6ehktUeJjXm1z', newestItemPubdate: 9 },
    { id: 2, podcastGuid: 'f2', title: 'x', generator: 'Something Else', url: 'https://feeds.fountain.fm/abc', newestItemPubdate: 8 },
    { id: 3, podcastGuid: 'f3', title: 'y', generator: 'Fountain', url: 'https://example.com/y.xml', newestItemPubdate: 7 },
    { id: 4, podcastGuid: 'f4', title: 'z', generator: '', url: 'https://notfountain.fm.example.com/z.xml', newestItemPubdate: 6 },
    { id: 7287540, podcastGuid: 'f5', title: 'Katherines Wheel', generator: 'Music Side Project Studio', url: 'https://headstarts.uk/msp/x.xml', newestItemPubdate: 5 },
  ], () => null).map((a) => a.id);
  if (JSON.stringify(rows) !== JSON.stringify([4, 7287540])) fail(`demuRosterRows kept ${JSON.stringify(rows)}`);
  else ok('the roster drops a Fountain generator or a fountain.fm feed; a look-alike host and MSP stay');
  // The search lane reads the same rule: a Fountain album is not DeMu there either.
  if (isDemuFeed({ generator: 'Fountain', url: 'https://feeds.fountain.fm/x' }, () => null)) fail('isDemuFeed (the DEMU search type) still counts Fountain');
  else ok('isDemuFeed (the DEMU search type) drops Fountain too');
}

// ── A feed with no cover borrows its newest track's (Chad, 2026-11-16) ────────
// Crem Road's feeds carry no channel cover at all — no <itunes:image>, no
// <image><url> — only one per track, so PI has none and the row drew a letter.
// Wire: the item tag shape of cremroad.com/rss/?artist=Me In The Bath.
console.log('\nCover from the newest track:');
{
  const item = (date, img) => `<item><title>t</title><pubDate>${date}</pubDate>${img ? `<itunes:image href="${img}"/>` : ''}<enclosure url="http://cremroad.com/a.mp3"/></item>`;
  const doc = (...items) => `<rss><channel><title>Me In The Bath</title>${items.join('')}</channel></rss>`;
  const vectors = [
    // Document order is NOT date order: the newest track is second here.
    ['newest by pubDate, not by position', doc(item('Mon, 01 Sep 2025 00:00:00 GMT', 'http://cremroad.com/covers/old.jpg'), item('Thu, 18 Sep 2025 00:00:00 GMT', 'http://cremroad.com/covers/mitb-onrb.jpg')), 'http://cremroad.com/covers/mitb-onrb.jpg'],
    ['a newer track WITHOUT a cover is skipped', doc(item('Fri, 19 Sep 2025 00:00:00 GMT', null), item('Thu, 18 Sep 2025 00:00:00 GMT', 'https://cremroad.com/covers/b.png')), 'https://cremroad.com/covers/b.png'],
    ['no track cover at all', doc(item('Thu, 18 Sep 2025 00:00:00 GMT', null)), undefined],
    ['a javascript: cover is not a cover', doc(item('Thu, 18 Sep 2025 00:00:00 GMT', 'javascript:alert(1)')), undefined],
    ['a data: cover is not a cover', doc(item('Thu, 18 Sep 2025 00:00:00 GMT', 'data:image/png;base64,AAAA')), undefined],
    ['no dates: the first track with a cover', doc(item('', 'https://x.example/1.jpg'), item('', 'https://x.example/2.jpg')), 'https://x.example/1.jpg'],
  ];
  for (const [name, xml, want] of vectors) {
    const got = newestItemImage(xml);
    if (got !== want) fail(`newestItemImage: ${name} gave ${JSON.stringify(got)}`);
    else ok(`newestItemImage: ${name}`);
  }
  const filled = withCoverFallback(
    [album(7621696, 1, { podcastGuid: '23befcef-bd42-57a2-a471-789fcb5aaa8a' }),
      album(2, 2, { podcastGuid: 'g2', image: 'https://has.example/own.jpg' }),
      album(3, 3, { podcastGuid: 'g3', artwork: 'https://has.example/art.jpg' })],
    new Map([['23befcef-bd42-57a2-a471-789fcb5aaa8a', 'http://cremroad.com/covers/mitb-onrb.jpg'], ['g2', 'https://x/no.jpg'], ['g3', 'https://x/no.jpg']]),
  ).map((a) => [a.id, a.image ?? null]);
  if (JSON.stringify(filled) !== JSON.stringify([[7621696, 'http://cremroad.com/covers/mitb-onrb.jpg'], [2, 'https://has.example/own.jpg'], [3, null]])) fail(`withCoverFallback gave ${JSON.stringify(filled)}`);
  else ok('withCoverFallback fills only an album with neither image nor artwork');

  // The Crem Road copies: cremroad.com ignores ?a=, so three PI feeds are one document.
  for (const g of ['c5075dbf-7937-57d9-8023-6d974d2b26de', 'e65712c3-c07c-51c2-8c61-1d81caa9552f']) {
    if (!DEMU_HIDE_LIST.some((h) => h.guid === g)) fail(`the hide list lacks the Crem Road copy ${g}`);
  }
  if (DEMU_HIDE_LIST.some((h) => h.guid === '4fd41d97-7be1-5cca-b933-0638f8fe22dd')) fail('the hide list hides the Crem Road row we keep');
  else ok('two Crem Road copies hidden, cremroad.com/rss/ kept');

  // The Drop BTC copies: one single published three times; the newest is kept.
  for (const g of ['c2eb2af5-5258-5d8a-acea-f84663a156f2', '8a9954fe-980d-5b76-b501-c83adc9a84e9']) {
    if (!DEMU_HIDE_LIST.some((h) => h.guid === g)) fail(`the hide list lacks the Drop BTC copy ${g}`);
  }
  if (DEMU_HIDE_LIST.some((h) => h.guid === 'baf5c0c0-7fbb-5514-9062-94106657fcea')) fail('the hide list hides the Drop BTC row we keep');
  else ok('two Drop BTC copies hidden, the newest (PI 8084510) kept');
}

// ── One row per set of tracks: an older COPY goes (Chad, 2026-11-17) ─────────
// "what we're presenting [is] what we believe is the current version" — music
// shows pick songs from /demu, and self-publishers put out copies "as they're
// learning and fixing". FIXTURES FROM THE WIRE: Podcast Index's roster rows
// and `/episodes/byfeedid` enclosure URLs, 2026-11-17. `naive()` is the obvious
// build: ONE shared audio file makes a copy, the newest by date stays (the first
// one on a tie), and nothing is exempt. It hides a single that sits on its own
// album — 18 Doerfels and CityBeach feeds share audio that way, every one real.
console.log('\nThe copy rule:');
{
  const DROP = { title: 'Drop BTC', author: 'Sovereign Frequency', image: 'https://files.catbox.moe/3pfuvp.png', episodeCount: 1 };
  const DROP_MP3 = ['https://files.catbox.moe/s5rtwb.mp3'];
  const drop = [
    { id: 8084427, podcastGuid: 'c2eb2af5-5258-5d8a-acea-f84663a156f2', ...DROP, newestItemPubdate: 1792759703 },
    { id: 8084476, podcastGuid: '8a9954fe-980d-5b76-b501-c83adc9a84e9', ...DROP, newestItemPubdate: 1792764185 },
    { id: 8084510, podcastGuid: 'baf5c0c0-7fbb-5514-9062-94106657fcea', ...DROP, newestItemPubdate: 1792766160 },
  ];
  const dropTracks = drop.map((a) => [a.id, DROP_MP3]);
  // MSP 2.0 Test Album on new.musicsideproject.com and on musicsideproject.com:
  // the same four tracks, which PI lists in a different order for each feed.
  const OP3 = 'https://op3.dev/e,pg=a8d0625c-c54b-46db-ba30-faee515b5279/podtards.com/';
  const MSP_MP3 = ['c941852acd6651d0a2c3f39b70d93e57a921a99c3d51da91800102eb82cf77c2', '965ea5d3feeeddae033b2973b64804ca3f63bb0e993480eb28e799a21398a3d3',
    'b367974c85b9c526604f1e456cdcbb8d82c3ce2754af3b0c786cc18dc6491b73', 'ac4a5b41d74382c34574bd5ff947b3c851e8729d4c0f884134e5355a53209b94'].map((h) => `${OP3}${h}.mp3`);
  const MSP = { title: 'MSP 2.0 Test Album', author: 'The Doerfels', image: 'https://podtards.com/2e79148af1fb01124c874f5c765324977e28ff0c5369a1ec5933f6d96649191b.png', episodeCount: 4 };
  const msp = [
    { id: 7826523, podcastGuid: 'a8d0625c-c54b-46db-ba30-faee515b5279', ...MSP, newestItemPubdate: 1767657061 },
    { id: 7909769, podcastGuid: 'de2ce8a1-29d7-4c95-9cfc-7fed65a0b787', ...MSP, newestItemPubdate: 1767589200 },
  ];
  const mspTracks = [[7826523, MSP_MP3], [7909769, [MSP_MP3[1], MSP_MP3[0], MSP_MP3[3], MSP_MP3[2]]]];
  const retitled = msp.map((a) => ({ ...a, title: 'Album' }));
  // The Doerfels: a single, and the album that carries it as track 1.
  const DV = 'https://www.doerfelverse.com/tracks/';
  const single = { id: 6473218, podcastGuid: 'b8b6971e-403e-568f-a4e6-7aa2b45e50d4', title: 'Bloodshot Lies - Single', author: 'The Doerfels', image: 'https://www.doerfelverse.com/art/bloodshot-lies.png', episodeCount: 1, newestItemPubdate: 1690485924 };
  const album = { id: 7365153, podcastGuid: 'a1077af6-602b-5daf-957b-68a65a03cad1', title: 'Bloodshot Lies - The Album', author: 'The Doerfels', image: 'https://www.doerfelverse.com/art/bloodshot-lies-the-album.png', episodeCount: 20, newestItemPubdate: 1762498038 };
  const albumMp3 = ['bloodshot-lies', 'movie', 'heartbreak', 'still-a-man', 'so-far-away', 'thought-it-was-real', 'breakaway-demo', 'some1likeyou', 'maybe-its-you', '3-years',
    'love-is-a-war', 'another-man', 'my-brother', 'bloodshot-lies-acoustic', 'bloodshot-lies-funk', 'cinema-85', 'movie-alt', 'heartbreak-falcone-remix', 'so-far-away-early', 'porkchopsfried'].map((n) => `${DV}${n}.mp3`);
  const doerfelTracks = [[6473218, [`${DV}bloodshot-lies.mp3`]], [7365153, albumMp3]];

  const vectors = [
    { kind: 'copies', label: 'Drop BTC: three feeds, one MP3 — the two older go, 8084510 stays', args: [drop, dropTracks, []], expect: [8084427, 8084476], alsoNaive: true },
    { kind: 'copies', label: 'Drop BTC listed newest first — the same answer', args: [[...drop].reverse(), dropTracks, []], expect: [8084427, 8084476], alsoNaive: true },
    { kind: 'copies', label: 'a single on its own album is not a copy (The Doerfels)', args: [[single, album], doerfelTracks, []], expect: [] },
    { kind: 'copies', label: 'Drop BTC, the oldest played by Homegrown Hits — it stays', args: [drop, dropTracks, ['c2eb2af5-5258-5d8a-acea-f84663a156f2']], expect: [8084476] },
    { kind: 'copies', label: 'MSP 2.0 Test Album twice — a feed that says test stays', args: [msp, mspTracks, []], expect: [] },
    { kind: 'copies', label: 'the same two feeds retitled — the older copy goes, the track order does not matter', args: [retitled, mspTracks, []], expect: [7909769], alsoNaive: true },
    { kind: 'copies', label: 'Drop BTC with one date for all three — the higher PI id stays', args: [drop.map((a) => ({ ...a, newestItemPubdate: 1792766160 })), dropTracks, []], expect: [8084427, 8084476] },
    { kind: 'copies', label: 'a feed whose tracks were not read is never a copy', args: [drop, dropTracks.filter(([id]) => id !== 8084476), []], expect: [8084427], alsoNaive: true },
    { kind: 'copies', label: 'an empty track list is never a copy', args: [drop, drop.map((a) => [a.id, []]), []], expect: [], alsoNaive: true },
    { kind: 'candidates', label: 'Drop BTC: all three are candidates', args: [drop], expect: [8084427, 8084476, 8084510], alsoNaive: true },
    { kind: 'candidates', label: 'a copy retitled AND re-credited keeps its count and cover — still a candidate', args: [[drop[0], { ...drop[2], title: 'Drop BTC (fixed)', author: 'SovFreq' }]], expect: [8084427, 8084510] },
    { kind: 'candidates', label: 'a single and its album have different counts — not candidates', args: [[single, album]], expect: [], alsoNaive: true },
    { kind: 'candidates', label: 'an album with no tracks is never a candidate', args: [drop.map((a) => ({ ...a, episodeCount: 0 }))], expect: [] },
    { kind: 'test', label: '"MSP 2.0 Test Album" says test', args: [MSP], expect: true, alsoNaive: true },
    { kind: 'test', label: '"test" by "test" says test', args: [{ title: 'test', author: 'test' }], expect: true, alsoNaive: true },
    { kind: 'test', label: 'the author "ChadF Test Album" says test', args: [{ title: 'Demo Album', author: 'ChadF Test Album' }], expect: true, alsoNaive: true },
    { kind: 'test', label: '"Latest Hits" does not say test', args: [{ title: 'Latest Hits', author: 'Someone' }], expect: false },
    { kind: 'test', label: '"Testament" does not say test', args: [{ title: 'Testament', author: 'Someone' }], expect: false },
    { kind: 'test', label: '"Contest Winner" does not say test', args: [{ title: 'Contest Winner', author: 'Someone' }], expect: false },
  ];

  const naiveCopies = (albums, tracks) => {
    const parent = new Map(albums.map((a) => [a.id, a.id]));
    const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
    const owner = new Map();
    for (const [id, urls] of tracks) {
      if (!parent.has(id)) continue;
      for (const u of urls) {
        if (owner.has(u)) parent.set(find(id), find(owner.get(u)));
        else owner.set(u, id);
      }
    }
    const groups = new Map();
    for (const a of albums) { const k = find(a.id); groups.set(k, [...(groups.get(k) ?? []), a]); }
    const hide = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const newest = g.reduce((b, a) => ((a.newestItemPubdate ?? 0) > (b.newestItemPubdate ?? 0) ? a : b));
      for (const a of g) if (a !== newest) hide.push(a.id);
    }
    return hide;
  };
  const naiveCandidates = (albums) => albums.filter((a) => albums.some((b) => b !== a
    && (a.title ?? '').toLowerCase() === (b.title ?? '').toLowerCase() && (a.author ?? '').toLowerCase() === (b.author ?? '').toLowerCase()));
  const naiveTest = (a) => /test/i.test(`${a.title ?? ''} ${a.author ?? ''}`);

  const call = (impl, v) => {
    try {
      const real = impl === 'real';
      if (v.kind === 'copies') {
        const [albums, tracks, played] = v.args;
        const out = real ? [...demuCopiesToHide(albums, new Map(tracks), new Set(played))] : naiveCopies(albums, tracks);
        return JSON.stringify(out.sort((a, b) => a - b));
      }
      if (v.kind === 'candidates') {
        const out = (real ? demuCopyCandidates(v.args[0]) : naiveCandidates(v.args[0])).map((a) => a.id);
        return JSON.stringify(out.sort((a, b) => a - b));
      }
      return JSON.stringify(real ? saysTest(v.args[0]) : naiveTest(v.args[0]));
    } catch (e) { return `threw ${(e && e.message) || e}`; }
  };
  for (const v of vectors) {
    const want = JSON.stringify(Array.isArray(v.expect) ? [...v.expect].sort((a, b) => a - b) : v.expect);
    const got = call('real', v);
    if (got !== want) fail(`"${v.label}" — expected ${want}, got ${got}`);
    else ok(v.label);
  }
  console.log('\nThe copy rule — the replay against naive():');
  replayVectors({ vectors, invoke: call, fail });
}

// ── Which app made the feed: the cover's corner badge (Chad, 2026-11-16) ──────
// LNBeats' idea: a small logo per app, "just for at a glance". Wire: every generator
// spelling on the DeMu list on 2026-11-16, plus two that must NOT match.
console.log('\nThe app badge:');
{
  const vectors = [
    ['Fountain', 'fountain'],
    ['Music Side Project Studio', 'msp'],
    ['MSP 2.0 - Music Side Project Studio', 'msp'],
    ['Sovereign Feeds', 'sovereign'],
    // A different tool: 13 feeds, all on one artist's own site — self-made.
    ['sovereign-music-feed-generator', 'self'],
    ['Podhome (https://www.podhome.fm)', 'podhome'],
    ['', 'self'],
    [undefined, 'self'],
    ['Sunami', 'self'],
    ['Handcrafted from Demu Open Source Template v0.1.1 ', 'self'],
    ['Castopod - https://castopod.org/', 'self'],
    ['Blubrry PowerPress/11.9.2', 'self'],
    ['MSPodcaster 1.2', 'self'],
  ];
  for (const [gen, want] of vectors) {
    const got = demuAppOf(gen);
    if (got !== want) fail(`demuAppOf(${JSON.stringify(gen)}) gave ${got}, want ${want}`);
    else ok(`demuAppOf(${JSON.stringify(gen)}) → ${want}`);
  }
  // The roster carries it, from the same row it reads the generator of.
  const rows = demuRosterRows([
    { id: 1, podcastGuid: 'a1', title: 'x', generator: 'Fountain', url: 'https://feeds.fountain.fm/x', newestItemPubdate: 5 },
    { id: 2, podcastGuid: 'a2', title: 'y', generator: '', url: 'https://example.com/y.xml', newestItemPubdate: 6 },
  ], () => null).map((a) => [a.id, a.app]);
  if (JSON.stringify(rows) !== JSON.stringify([[2, 'self']])) fail(`demuRosterRows app gave ${JSON.stringify(rows)}`);
  else ok('demuRosterRows sets `app` on every album it keeps');
  // Every app but "self" has its picture in public/demu-apps/, and each label is set.
  const { existsSync } = await import('node:fs');
  const missing = Object.keys(DEMU_APPS).filter((k) => k !== 'self' && !existsSync(`public/demu-apps/${k}.png`));
  const unlabeled = Object.entries(DEMU_APPS).filter(([, v]) => !v.label).map(([k]) => k);
  if (missing.length || unlabeled.length) fail(`DEMU_APPS: no picture for ${JSON.stringify(missing)}, no label for ${JSON.stringify(unlabeled)}`);
  else ok(`DEMU_APPS: ${Object.keys(DEMU_APPS).length} apps, each labelled, each with a picture but "self"`);
}

for (const kind of ['group', 'age', 'date', 'sort', 'query', 'roster']) {
  const fam = listVectors.filter((v) => v.kind === kind);
  if (!fam.some((v) => !v.alsoNaive)) fail(`the ${kind} vectors prove nothing against naive()`);
}

// ── The module must stay loadable under plain Node ───────────────────────────
{
  for (const path of ['lib/demu.ts', 'lib/demu-hide-list.ts']) {
    const problems = importFreeProblems(path);
    if (problems.length) {
      explainImportFree(path, problems);
      failures++;
    } else ok(`${path} is import-free`);
  }
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ok');
