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

import { isDemuFeed } from '../lib/demu.ts';
import { closedService } from '../lib/moved-feeds.ts';
import { SEARCH_TYPES, parseSearchType, matchesSearchType, mergeSearchLanes } from '../lib/util.ts';
import { replayVectors } from './replay-vectors.mjs';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

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
  { label: 'Worried on Fountain (7520866)', args: [ROWS.worriedOnFountain], expect: true, alsoNaive: true },
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
  // "Longy - Everything" (7696544) is Longy's publisher feed, not an album.
  if (matchesSearchType({ medium: 'publisher' }, 'demu') !== false) fail('a publisher row matches demu');
  else ok('a publisher row does not match demu');

  const music = [
    ROWS.wavlakeAlbum, ROWS.wheelOnWavlake, ROWS.wavlakeQa, ROWS.wheelOnMsp,
    ROWS.worriedOnFountain, ROWS.blankGenerator, ROWS.worriedOnRssBlue,
  ].map((r) => ({ ...r, medium: 'music' }));
  const byterm = [
    { id: 7696544, medium: 'publisher', generator: 'MSP 2.0 - Music Side Project Studio', url: 'https://headstarts.uk/msp/publisher-feeds/longy-everything-publisher-feed.xml' },
    { ...ROWS.worriedOnFountain, medium: 'music' },
  ];
  const keep = (f) => isDemuFeed(f, closedService);
  const ids = mergeSearchLanes(music.filter(keep), byterm.filter(keep), 'demu', 50).map((f) => f.id);
  if (JSON.stringify(ids) !== JSON.stringify([7287540, 7520866, 46385])) fail(`the DEMU lane returned ${JSON.stringify(ids)}`);
  else ok('the DEMU lane keeps 7287540, 7520866, 46385: Wavlake, RSS Blue and the publisher feed out, the repeat deduped');
}

// ── The module must stay loadable under plain Node ───────────────────────────
{
  const path = 'lib/demu.ts';
  const problems = importFreeProblems(path);
  if (problems.length) {
    explainImportFree(path, problems);
    failures++;
  } else ok(`${path} is import-free`);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ok');
