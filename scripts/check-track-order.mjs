// Pins the track list of a music album on /api/feed: which rows it keeps
// (`listedTrackGuids`, `onlyListedTracks`), how far back the RSS catch-up
// reaches (`rssCatchUpAfter`), and the order (`compareEpisodeOrder`'s tiebreak),
// all in lib/util.ts. See docs/feeds.md, "A music album lists what its feed lists".
//
// THE FAILURE IT WAS WRITTEN AGAINST (Chad, 2026-11-22): Nate Johnivan's
// "Tinderbox" (PI feed 6422170) played "Analysis Paralysis" FIRST, ahead of
// track 1, while StableKraft and the feed itself start with "Time". Wavlake
// replaced that track on 2024-04-03 under a new guid. Podcast Index kept the old
// row, the feed no longer lists it, and with no `<podcast:episode>` on it the
// music sort (`episode ?? 0`) put it at the front. The old file still plays —
// an older recording. A survey of 154 music feeds the same day found seven with
// such rows, six of them with one in first place; "Live at Rockpile" (7612000)
// listed 15 rows for 8 tracks.
//
// `naive()` is what shipped before: every Podcast Index row, sorted by disc and
// track number alone, ties left in Podcast Index's order.
//
// FIXTURES COME FROM THE WIRE: scripts/fixtures/track-order.json holds each
// feed's `<guid>`s in document order and the rows /api/feed served for it,
// both recorded 2026-11-22. Vectors marked NOT FROM THE WIRE say why.

import { readFileSync } from 'node:fs';
import { listedTrackGuids, onlyListedTracks, rssCatchUpAfter, compareEpisodeOrder } from '../lib/util.ts';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

const { feeds } = JSON.parse(readFileSync(new URL('./fixtures/track-order.json', import.meta.url), 'utf8'));
const FEED = Object.fromEntries(feeds.map((f) => [f.id, f]));

// The route's composition, over the real functions: keep the rows the feed
// lists, then sort with the feed's own position as the tiebreak.
function albumTitles({ rows, items, capped, isMusic }) {
  const listed = listedTrackGuids(items, capped);
  const kept = onlyListedTracks(rows, listed, isMusic);
  const position = new Map();
  items.forEach((g, i) => { if (g && !position.has(g)) position.set(g, i); });
  const sorted = [...kept].sort(compareEpisodeOrder(isMusic, (e) => (e.guid ? position.get(e.guid) : undefined)));
  return sorted.map((r) => r.title);
}

// What shipped before: every row, track number only, ties in input order.
function naiveAlbumTitles({ rows, isMusic }) {
  const cmp = (a, b) => (isMusic
    ? ((a.season ?? 1) - (b.season ?? 1)) || ((a.episode ?? 0) - (b.episode ?? 0))
    : (b.datePublished ?? 0) - (a.datePublished ?? 0));
  return [...rows].sort(cmp).map((r) => r.title);
}

const album = (id, over = {}) => ({ rows: FEED[id].apiRows, items: FEED[id].feedItems, capped: false, isMusic: true, ...over });

const TINDERBOX = [
  'Time', 'Bad People', "We Promise We'll Buy It", 'Mom', 'Surrounded', 'Late', 'Sar Chasm',
  'Analysis Paralysis', 'Stranger Things', 'Back Road', 'Mouth to Mouth', 'Density', 'Creatives',
];
const TINDERBOX_TODAY = ['Analysis Paralysis', ...TINDERBOX];

const vectors = [
  // ── album: the rows and their order ──
  { kind: 'album', label: 'Tinderbox (6422170): the replaced track is gone, "Time" plays first', args: [album(6422170)], expect: TINDERBOX },
  { kind: 'album', label: 'Two Ships (6471423): a single lists its one song, not "Cherry On Top"', args: [album(6471423)], expect: ['Two Ships'] },
  {
    kind: 'album', label: 'Live at Rockpile (7612000): 8 tracks, not 15', args: [album(7612000)],
    expect: ['The Moment We Leave (Live)', 'Too Late To Be Found (Live)', 'To Be Intended (Live)', 'Come Back To Me Now (Live)',
      'What Frankie Wants (Live)', 'Country Gin (Live)', 'Cats in the Hall (Live)', 'The Middle (Live)'],
  },
  {
    // Partly numbered: the five unnumbered tracks stay in front (`episode ?? 0`),
    // now in the feed's order — "Make It" is 4th in the document, "Carol Of The
    // Bells" 10th. Podcast Index's order put Carol first.
    kind: 'album', label: 'Doerfel-Verse (6642704): unnumbered tracks keep the feed\'s order', args: [album(6642704)],
    expect: null, // filled below from the fixture: the five, then 1..36 by number
  },
  // The feed has an <item> with no <guid>; Podcast Index names that row by its
  // file URL, so the guid set cannot vouch for it. Nothing is dropped.
  { kind: 'album', label: 'Able Kirby misc (4374133): an item with no <guid> drops nothing', args: [album(4374133)], expect: ['Podcast Ring of Fire'], alsoNaive: true },
  // NOT FROM THE WIRE: Tinderbox's rows with the scan stopped at MAX_RSS_ITEMS.
  // A partial list proves nothing about the rest.
  { kind: 'album', label: 'a scan that hit MAX_RSS_ITEMS drops nothing', args: [album(6422170, { capped: true })], expect: TINDERBOX_TODAY, alsoNaive: true },
  // NOT FROM THE WIRE: a read that found no <item> (an HTML error page answers
  // 200 and parses). Zero items is not "the artist removed every track".
  { kind: 'album', label: 'a read that lists no item drops nothing', args: [album(6422170, { items: [] })], expect: TINDERBOX_TODAY, alsoNaive: true },
  // NOT FROM THE WIRE: the same rows as a podcast. A show's RSS often keeps only
  // its newest items while Podcast Index keeps the archive.
  { kind: 'album', label: 'a podcast keeps every Podcast Index row', args: [album(6422170, { isMusic: false })], expect: TINDERBOX_TODAY, alsoNaive: true },
  // NOT FROM THE WIRE: a Podcast Index row with no guid cannot be judged; it stays.
  {
    kind: 'album', label: 'a row with no guid stays',
    args: [album(6471423, { rows: [...FEED[6471423].apiRows, { guid: null, title: 'No guid', season: 1, episode: 2 }] })],
    expect: ['Two Ships', 'No guid'],
  },

  // ── listed: when the read can vouch for the whole list ──
  { kind: 'listed', label: 'Tinderbox\'s 13 guids', args: [FEED[6422170].feedItems, false], expect: JSON.stringify([...FEED[6422170].feedItems].sort()), alsoNaive: true },
  { kind: 'listed', label: 'an item with no <guid> vouches for nothing', args: [FEED[4374133].feedItems, false], expect: 'null' },
  { kind: 'listed', label: 'a capped scan vouches for nothing', args: [FEED[6422170].feedItems, true], expect: 'null' },
  { kind: 'listed', label: 'no item vouches for nothing', args: [[], false], expect: 'null' },

  // ── catchup: how far back the RSS-only rows reach ──
  // A vouched album appends every listed item Podcast Index lacks, whatever its
  // date: dropping an unlisted row must never leave its replacement out.
  { kind: 'catchup', label: 'a vouched album reaches back to the start', args: [1712170091, true, true], expect: 0 },
  { kind: 'catchup', label: 'an album the read cannot vouch for keeps the date bound', args: [1712170091, false, true], expect: 1712170091, alsoNaive: true },
  { kind: 'catchup', label: 'a podcast keeps the date bound', args: [1712170091, true, false], expect: 1712170091, alsoNaive: true },
];

// Doerfel-Verse's expected order, from the fixture rather than typed out: the
// unnumbered tracks in document order, then the numbered ones by track number.
{
  const f = FEED[6642704];
  const at = new Map(f.feedItems.map((g, i) => [g, i]));
  const un = f.apiRows.filter((r) => r.episode == null).sort((a, b) => at.get(a.guid) - at.get(b.guid));
  const num = f.apiRows.filter((r) => r.episode != null).sort((a, b) => ((a.season ?? 1) - (b.season ?? 1)) || (a.episode - b.episode));
  vectors.find((v) => v.args[0]?.rows === f.apiRows).expect = [...un, ...num].map((r) => r.title);
}

const call = (impl, v) => {
  try {
    if (v.kind === 'album') {
      return JSON.stringify(impl === 'real' ? albumTitles(v.args[0]) : naiveAlbumTitles(v.args[0]));
    }
    if (v.kind === 'listed') {
      const [items, capped] = v.args;
      const got = impl === 'real' ? listedTrackGuids(items, capped) : new Set(items.filter(Boolean));
      return got === null ? 'null' : JSON.stringify([...got].sort());
    }
    if (v.kind === 'catchup') {
      const [newestPi, vouched, isMusic] = v.args;
      return impl === 'real' ? rssCatchUpAfter(newestPi, vouched ? new Set(['x']) : null, isMusic) : newestPi;
    }
    return `unknown kind ${v.kind}`;
  } catch (e) {
    return `threw ${(e && e.message) || e}`;
  }
};

console.log('The shipping answer:');
for (const v of vectors) {
  const want = v.kind === 'album' ? JSON.stringify(v.expect) : v.expect;
  const got = call('real', v);
  if (got !== want) fail(`"${v.label}"\n          expected ${want}\n          got      ${got}`);
  else ok(v.label);
}

console.log('\nThe replay against naive():');
replayVectors({ vectors, invoke: call, fail });


console.log(failures ? `\n${failures} failure(s)` : '\nall track-order checks passed');
process.exit(failures ? 1 : 0);
