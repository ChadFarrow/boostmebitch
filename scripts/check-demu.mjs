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
