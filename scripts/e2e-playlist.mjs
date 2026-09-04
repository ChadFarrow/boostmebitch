// The API waterfall a `?podcast=<guid>` deep link produces, driven in a real
// browser against a real production build.
//
//   npm run e2e:playlist              # the shape that must hold
//   npm run e2e:playlist -- --blank   # the shape before the by-guid repair
//   npm run e2e:playlist -- --headed  # watch it
//
// **What this guards cannot be pinned by a `check:*` script, and every failure
// it catches is silent on screen.** The page renders correctly whether it took
// two requests or four; the only symptom is that it is slow, which is the one
// thing a screenshot and a DOM assertion both agree looks fine.
//
// Two rules live here, and each shipped broken:
//
//   1. **A playlist deep link must never request `/api/feed`.** Podcast Index
//      can hold a feed it registered but never parsed — ChadF's Greatest Hits,
//      feed 7683902 — and its blank record carries the DEFAULT `medium:
//      "podcast"`. `<HomePage>` reads that field to decide whether it is holding
//      a playlist, so the client asked `/api/feed?id=`, which ran the full PI
//      episode fetch, the RSS enrichment pass and both live-item lookups for a
//      feed that publishes no `<item>` at all, answered zero episodes, and only
//      then fell back to `/api/playlist`. `/api/by-guid` now repairs the record
//      from the feed's own RSS, so the medium is right at the first answer.
//
//   2. **The `<link rel="preload">` in `app/page.tsx` must match the URL
//      `lib/podcast-meta.ts` builds, byte for byte.** A hint that misses is not
//      an error anywhere: the browser simply fetches the same document twice and
//      the page keeps working, one round trip slower than it reads. So the
//      assertion is a COUNT — one interception, not two — because that is the
//      only observable difference between a hint that works and a hint that
//      does nothing at all. `crossOrigin` is part of the spelling: without it
//      React does not emit the tag, and with the wrong value the credentials
//      mode disagrees with `fetch`'s default and the match is refused.
//
// Every `/api/*` request is intercepted at the browser and answered from a
// canned body, so this needs no Podcast Index key, no database and no network.
// It asserts on the REQUEST GRAPH, which is what was wrong; the bodies exist
// only to get the client to the next step.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const APP = 'http://localhost:3000';
const CDP = 9224;
const GUID = 'bdf5a0f9-d803-5d6d-81b6-d99bfba58e4e';
const FEED_URL = 'https://example.com/greatest-hits.xml';
const BLANK = process.argv.includes('--blank');
const HEADED = process.argv.includes('--headed');

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures += 1; console.log(`  FAIL ${m}`); };

// Podcast Index's ACTUAL record for feed 7683902, captured from the live index
// and shared with scripts/check-musicl-playlist.mjs: no title, a derived guid,
// and the default medium over a feed that declares `musicL`.
const PI_BLANK = {
  id: 7683902, podcastGuid: GUID, title: '', author: null, description: '',
  medium: 'podcast', url: FEED_URL,
};
// What `/api/by-guid`'s `repairIfBlank` hands back: PI's id and guid, the
// publisher's own title and medium.
const REPAIRED = {
  ...PI_BLANK, title: "ChadF's Greatest Hits Music Playlist", author: 'ChadF',
  medium: 'musicl', image: 'https://example.com/gh.png',
};
/**
 * Three rows, and the MIDDLE ONE IS UNRESOLVED — which is an ordinary row on an
 * ordinary playlist, not a contrived one. `/api/playlist` yields one row per
 * `<podcast:remoteItem>` whatever Podcast Index said, so a track from an album
 * PI has not crawled arrives with the two guids and an empty enclosure.
 *
 * The two playable ones point at DISTINCT urls even though the bytes are
 * identical, because `audio.currentSrc` is how the autoplay scenario below
 * identifies which track is playing. One shared url would make "advanced to the
 * next track" and "still on the first" indistinguishable.
 */
const TRACKS = [
  {
    id: 100, guid: 'track-0', podcastGuid: 'album-0', title: 'Track 0',
    enclosureUrl: '/api/e2e-audio.mp3?t=0', feedId: 7683902, playlistPlays: 24,
    datePublished: 1697414400, duration: 249,
  },
  {
    id: 101, guid: 'track-1', podcastGuid: 'album-1', title: '',
    enclosureUrl: '', feedId: 7683902, unresolved: 'not-found', playlistPlays: 24,
  },
  {
    id: 102, guid: 'track-2', podcastGuid: 'album-2', title: 'Track 2',
    enclosureUrl: '/api/e2e-audio.mp3?t=2', feedId: 7683902, playlistPlays: 21,
    datePublished: 1699920000, duration: 185,
  },
];
// The play count the Greatest Hits feed writes above each run
// (`<podcast:txt purpose="playcount">24 plays</podcast:txt>`), carried per row
// as `playlistPlays`. It is on the UNRESOLVED row too — the count is the
// curator's claim about the track, and an album Podcast Index has not crawled
// does not change how often the track was played. The list heads each run
// with the SERVER's whole-list track total, which is what `playGroups` is: the
// 24-plays total is deliberately larger than the two rows on this page, so a
// client that counted loaded rows instead would print 2 and fail.
const PLAY_GROUPS = [{ plays: 24, tracks: 9 }, { plays: 21, tracks: 1 }];
const HEADINGS_EXPECTED = ['24 plays · 9 tracks', '21 plays · 1 track'];
const PLAYABLE_TRACKS = TRACKS.filter((t) => !t.unresolved);

/**
 * An ordinary podcast, for the code-split scenario at the end — the episode and
 * discussion views only mount for a feed whose rows are episodes.
 */
const SHOW_GUID = 'e2e-0000-0000-0000-000000000001';
const EPISODE_GUID = 'e2e-episode-1';
const SHOW = {
  id: 424242, podcastGuid: SHOW_GUID, title: 'An Ordinary Show', author: 'Someone',
  description: 'A show with episodes.', medium: 'podcast', url: 'https://example.com/show.xml',
};
const SHOW_EPISODE = {
  id: 900, guid: EPISODE_GUID, title: 'An Ordinary Episode', feedId: SHOW.id,
  enclosureUrl: 'https://example.com/ep.mp3', datePublished: 1700000000,
  description: 'Notes.',
  // The discussion view renders only for an episode that names a thread.
  socialInteract: [{ uri: 'https://example.com/thread', protocol: 'activitypub' }],
};
// A real decodable file, so `ended` is fired by the browser finishing playback
// rather than by anything this script simulates. It is short, which is why the
// scenario can simply wait for it. Served from /api/ so the one interception
// pattern already in place covers it.
const AUDIO = readFileSync(new URL('../public/boost.mp3', import.meta.url));

const appUp = await fetch(APP).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
  console.error('A production build matters here: the preload tag is what this measures.');
  process.exit(1);
}

// Same contract as scripts/e2e-favorites.mjs — `CHROME_PATH` is what lets this
// run anywhere but a Mac, and `--no-sandbox` is gated on actually being root.
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = `${tmpdir()}/bmb-e2e-playlist`;
rmSync(profile, { recursive: true, force: true });
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const chrome = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  ...(asRoot ? ['--no-sandbox'] : []),
  // The autoplay scenario starts playback from a scripted click, which is not a
  // user gesture as far as the media policy is concerned. Nothing under test
  // depends on the policy — the app is always started by a real tap — so this
  // removes a variable rather than papering over one.
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

let ready = false;
for (let i = 0; i < 80 && !ready; i += 1) {
  ready = await fetch(`http://127.0.0.1:${CDP}/json/version`).then((r) => r.ok).catch(() => false);
  if (!ready) await new Promise((r) => setTimeout(r, 250));
}
if (!ready) { console.error(`Chrome never opened its debug port on ${CDP}.`); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const handlers = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) handlers.forEach((h) => h(m));
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
});
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.result?.value;
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(pathname, search) {
  const q = new URLSearchParams(search);
  // The ordinary show, for the code-split scenario. Keyed off the identifier so
  // one stub serves both shapes and the playlist assertions above are untouched.
  if (pathname === '/api/by-guid' && q.get('guid') === SHOW_GUID) return { podcast: SHOW };
  if (pathname === '/api/feed' && q.get('id') === String(SHOW.id)) {
    return { podcast: SHOW, episodes: [SHOW_EPISODE] };
  }
  if (pathname === '/api/by-guid') return { podcast: BLANK ? PI_BLANK : REPAIRED };
  // What `/api/feed` answers for a musicL feed: the medium backfilled from the
  // RSS channel parse, and NO episodes, because a playlist publishes no <item>.
  if (pathname === '/api/feed') return { podcast: REPAIRED, episodes: [] };
  if (pathname === '/api/playlist') {
    return {
      podcast: REPAIRED, episodes: TRACKS, total: TRACKS.length, offset: 0,
      nextOffset: null, notFound: 0, couldNotAsk: 0, sourceShow: null, playGroups: PLAY_GROUPS,
    };
  }
  return {};
}

const t0 = Date.now();
const seen = [];
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
handlers.push(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  if (u.pathname.startsWith('/api/')) seen.push({ ms: Date.now() - t0, path: u.pathname, search: u.search });
  // The audio the two playable rows point at. `accept-ranges: none` keeps this
  // to one plain request — a ranged media fetch would arrive here in pieces
  // that this stub does not answer.
  if (u.pathname === '/api/e2e-audio.mp3') {
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [
        { name: 'content-type', value: 'audio/mpeg' },
        { name: 'accept-ranges', value: 'none' },
        { name: 'content-length', value: String(AUDIO.length) },
      ],
      body: AUDIO.toString('base64'),
    });
    return;
  }
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: b64(answer(u.pathname, u.search)),
  });
});

await send('Page.enable');
await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
// Long enough for hydration, the deep-link effect and the list's own fetch on a
// loaded machine. The assertions are counts, so a slow run reads as a failure
// rather than as a flake only if a request never happens at all.
await new Promise((r) => setTimeout(r, 6000));

console.log(`\n/?podcast=<guid>, where /api/by-guid answers ${BLANK ? "PI's BLANK record" : 'a REPAIRED record'}`);
for (const s of seen) console.log(`  ${String(s.ms).padStart(5)}ms  ${s.path}${s.search.slice(0, 80)}`);

const count = (p) => seen.filter((s) => s.path === p).length;
const byGuid = count('/api/by-guid');
const feed = count('/api/feed');
const playlist = count('/api/playlist');
const rows = await js('document.querySelectorAll("ul.divide-y > li").length');
const header = await js('document.querySelector("h2.font-display")?.textContent ?? ""');

console.log('');
if (BLANK) {
  // Not an assertion about what SHOULD happen — a record of what the repair
  // removed, so `--blank` keeps demonstrating the cost rather than rotting.
  console.log(`  (blank-record path: ${feed} /api/feed and ${playlist} /api/playlist requests)`);
  console.log('  Run without --blank for the assertions.');
  process.exit(0);
}

// **Two assertions, because either one alone passes while the hint does
// nothing.** A count of one is equally true when there is no preload tag at all
// — the client just fetches once, later — so the count cannot tell a working
// hint from a deleted one. And a tag that exists proves nothing about whether
// the browser could use it.
//
// The expected href is READ OFF THE PAGE and compared with the URL the client
// actually requested, rather than spelled a third time in here: this file
// asserting its own copy of the URL is the drift it exists to catch.
const hint = await js('document.querySelector(\'link[rel="preload"][as="fetch"]\')?.getAttribute("href") ?? null');
// **The LAST one, never the first.** When the hint misses, the first request on
// the wire is the preload itself — so comparing against it compares the hint
// with a copy of itself and passes on exactly the drift this is here to find.
// The last is the client's own, which is the spelling that has to be matched.
const byGuidReqs = seen.filter((s) => s.path === '/api/by-guid');
const clientAsked = byGuidReqs.length ? byGuidReqs[byGuidReqs.length - 1] : null;
if (hint) ok(`app/page.tsx emitted the preload hint (${hint})`);
else fail('no <link rel="preload" as="fetch"> in the document — the deep link waits for hydration again');

if (hint && clientAsked && hint === `${clientAsked.path}${clientAsked.search}`) {
  ok('and it is spelled exactly as lib/podcast-meta.ts spells the request');
} else if (hint && clientAsked) {
  fail(`the hint (${hint}) is not the URL the client asked for (${clientAsked.path}${clientAsked.search})`);
}

if (byGuid === 1 && hint) ok('/api/by-guid crossed the network ONCE — the fetch reused the preload');
else if (byGuid === 1) ok('/api/by-guid crossed the network once (no hint to reuse)');
else if (byGuid === 2) fail('/api/by-guid was fetched TWICE: the hint missed, most likely on crossOrigin/credentials mode');
else fail(`/api/by-guid was requested ${byGuid} times`);

if (feed === 0) ok('/api/feed is never requested — the medium was right at the first answer');
else fail(`/api/feed was requested ${feed} time(s): a blank PI record is reaching <HomePage> unrepaired`);

if (playlist === 1) ok('/api/playlist is requested once');
else fail(`/api/playlist was requested ${playlist} time(s)`);

if (seen[0]?.path === '/api/by-guid') ok('and it is the FIRST request on the page');
else fail(`the first API request was ${seen[0]?.path ?? '(none)'}`);

// The two play-count headings are <li>s in the same list, so the row count
// includes them.
const EXPECTED_LIS = TRACKS.length + PLAY_GROUPS.length;
if (rows === EXPECTED_LIS) ok(`all ${TRACKS.length} tracks rendered, under ${PLAY_GROUPS.length} headings`);
else fail(`expected ${EXPECTED_LIS} list items (${TRACKS.length} tracks + ${PLAY_GROUPS.length} headings), got ${rows}`);

if (header.includes('Greatest Hits')) ok('the show header carries the feed\'s own title, not PI\'s blank one');
else fail(`header reads "${header}"`);

// The play-count headings: one where the count changes, carrying the
// whole-list track total. They are <li>s in the same list as the tracks, so
// the items are read again here and the headings picked out by shape.
const liTexts = await js('Array.from(document.querySelectorAll("ul.divide-y > li")).map((li) => li.textContent.trim())');
const headings = (liTexts ?? []).filter((t) => /^\d+ plays? · \d+ tracks?$/.test(t));
if (JSON.stringify(headings) === JSON.stringify(HEADINGS_EXPECTED)) {
  ok(`the runs are headed with the server's totals (${headings.join(' | ')})`);
} else {
  fail(`play-count headings read ${JSON.stringify(headings)}, want ${JSON.stringify(HEADINGS_EXPECTED)}`);
}

// A picture of the list as rendered, for the eyes the assertions above do not
// have. Written beside the profile; the path is printed so it can be found.
{
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await new Promise((r) => setTimeout(r, 500));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = process.env.E2E_SHOT || `${tmpdir()}/bmb-e2e-playlist.png`;
  writeFileSync(out, Buffer.from(shot.result?.data ?? '', 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  console.log(`  (screenshot: ${out})`);
}

// ---- autoplay -------------------------------------------------------------
//
// **The one thing about this page that no request graph can show.** A playlist
// is the surface in this app whose whole purpose is to play one song after
// another, and it was the surface that would not: `<Player>`'s `onEnded` gated
// auto-advance on `isMusicMedium`, which is `music` alone, so every `musicL`
// track ended in silence with the transport still showing ❚❚.
//
// It is driven end to end — a real click on a real row, a real decodable file,
// and the browser's own `ended` event — because the bug lived in the wiring
// between a store action, a media event and a medium test, and each of those
// three reads correctly on its own.
console.log('\nAutoplay');
const clicked = await js(`(() => {
  const rows = [...document.querySelectorAll('ul.divide-y > li')];
  const row = rows.find((el) => el.textContent.includes('Track 0'));
  if (!row) return 'no row';
  row.click();
  return 'clicked';
})()`);
if (clicked !== 'clicked') fail(`could not start playback: ${clicked}`);

const srcHas = async (mark, ms) => {
  for (let i = 0; i < ms / 250; i += 1) {
    const src = await js('document.querySelector("audio")?.currentSrc ?? ""');
    if (src.includes(mark)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

if (await srcHas('t=0', 5000)) {
  ok('a row tap plays the track');
  // Long enough for the file (about a second) plus the advance. A failure here
  // is the real one: the track ended and nothing followed it.
  if (await srcHas('t=2', 15000)) {
    ok('the next track starts on its own when a track ends');
    // The middle row is unresolved and has an empty enclosure, so arriving at
    // Track 2 is also the proof that auto-advance stepped OVER it rather than
    // handing the player a dead track.
    ok(`and it skipped the unresolved row between them (${TRACKS.length - PLAYABLE_TRACKS.length} of ${TRACKS.length})`);
  } else {
    const src = await js('document.querySelector("audio")?.currentSrc ?? ""');
    const playing = await js('!document.querySelector("audio")?.paused');
    fail(`playback did not advance to the next track (src ${src || '(none)'}, playing ${playing})`);
  }
} else {
  fail('the first track never started, so the advance could not be tested');
}

// ---- code-split surfaces --------------------------------------------------
//
// **A `next/dynamic` import of a NAMED export renders nothing when it is wired
// wrong, and says nothing about it.** `.then((m) => m.Wrong)` resolves to
// `undefined`, React renders an empty slot, and the only symptom is a section
// that is missing from a page — which is indistinguishable from the section's
// own "nothing to show" state, and on three of these four that state is the
// normal one for most visitors.
//
// Four surfaces were split out of the first-load bundle (329 kB → 307 kB): the
// two home-page Nostr sections, the episode detail view and the discussion
// view. Each is gated by a condition that is false on the first commit, which
// is exactly why the split is free — and exactly why nobody would notice one of
// them never coming back. So each is mounted here, once.
console.log('\nCode-split surfaces');
const mounts = async (url, needle, what) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 40; i += 1) {
    const hit = await js(`document.body.innerText.includes(${JSON.stringify(needle)})`);
    if (hit) { ok(`${what} mounts`); return; }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${what} never appeared — check its dynamic() import resolves the named export`);
};

// The home page, where both Nostr sections sit below the hero. Their own
// skeletons carry these headings, so this does not wait on a relay.
await mounts(`${APP}/`, 'Live on Nostr', '<NostrLiveStreams>');
if (!(await js('document.body.innerText.includes("Global boost feed")'))) {
  fail('<GlobalNostrFeed> never appeared — check its dynamic() import resolves the named export');
} else ok('<GlobalNostrFeed> mounts');

await mounts(
  `${APP}/?podcast=${SHOW_GUID}&episode=${encodeURIComponent(EPISODE_GUID)}`,
  'An Ordinary Episode',
  '<EpisodeDetailView>',
);
await mounts(
  `${APP}/?podcast=${SHOW_GUID}&episode=${encodeURIComponent(EPISODE_GUID)}&discussion=1`,
  'Discussion',
  '<DiscussionView>',
);

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
