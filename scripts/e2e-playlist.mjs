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
import { rmSync } from 'node:fs';
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
const TRACKS = Array.from({ length: 3 }, (_, i) => ({
  id: 100 + i, guid: `track-${i}`, podcastGuid: `album-${i}`, title: `Track ${i}`,
  enclosureUrl: `https://example.com/${i}.mp3`, feedId: 7683902,
}));

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
function answer(pathname) {
  if (pathname === '/api/by-guid') return { podcast: BLANK ? PI_BLANK : REPAIRED };
  // What `/api/feed` answers for a musicL feed: the medium backfilled from the
  // RSS channel parse, and NO episodes, because a playlist publishes no <item>.
  if (pathname === '/api/feed') return { podcast: REPAIRED, episodes: [] };
  if (pathname === '/api/playlist') {
    return {
      podcast: REPAIRED, episodes: TRACKS, total: TRACKS.length, offset: 0,
      nextOffset: null, notFound: 0, couldNotAsk: 0, sourceShow: null,
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
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: b64(answer(u.pathname)),
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

if (rows === TRACKS.length) ok(`all ${rows} tracks rendered`);
else fail(`expected ${TRACKS.length} track rows, got ${rows}`);

if (header.includes('Greatest Hits')) ok('the show header carries the feed\'s own title, not PI\'s blank one');
else fail(`header reads "${header}"`);

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
