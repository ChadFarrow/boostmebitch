// Whether `/api/playlist` lets the CDN keep a page built while Podcast Index
// could not be asked — against the real route, with PI really unavailable.
//
// THE BUG (full-code review 2026-11-19, app/api/playlist/route.ts:99).
// `piRecordFor` swallows a PI throw, so the header falls back to the RSS-only,
// preview-shaped record: synthetic id, NO guid, "NOT IN PI · PREVIEW", and no
// favorite heart. The route kept that out of the CDN only through `couldNotAsk`,
// i.e. only when the same outage also failed a row lookup. Two answers ask PI
// about no row — a page past the end, and a page the playlist database answers
// whole — and both went out `s-maxage=300`, so one PI blip served the thin
// header to everyone for five minutes.
//
// HOW PI IS MADE UNAVAILABLE. This script starts its own `next start` twice from
// the one build in `.next`: once with `PODCAST_INDEX_KEY`/`_SECRET` set EMPTY
// (Next keeps a variable that is already set, even an empty one, over
// `.env.local`, and `authHeaders` then throws before any request), once with the
// normal environment. Both are stopped at the end. No Podcast Index request is
// made by the first; the second makes the reads the app always makes. The feed
// itself is read from its public host, and the playlist database (when
// `PLAYLIST_DB_URL` is set) is read, as in normal use. Nothing is written.
//
// WHAT IT PINS (PI unavailable):
//   1. a page past the end           -> `no-store`
//   2. a page the database answers whole (no row asks PI) -> `no-store`
//      (needs the database reachable; reported SKIPPED, never passed, without it)
// MUST STILL WORK (PI available):
//   3. the same page                 -> the shared cache (`s-maxage`), with a guid
//   4. a page past the end           -> the shared cache
//
//   npm run build
//   npm run e2e:playlistpicache            (FEED_URL=<a musicL feed> to change it)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { checker } from './cdp.mjs';

const FEED =
  process.env.FEED_URL ?? 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/IAM-music-playlist.xml';
const PORT_DOWN = 3436;
const PORT_UP = 3437;

if (!existsSync('.next/BUILD_ID')) {
  console.error('No production build in .next. Run `npm run build` first (and stop any `npm run dev`).');
  process.exit(2);
}

const t = checker();
const servers = [];
function start(port, env) {
  // `node` on Next's own bin, not `npx`: a SIGTERM to npx does not reach the
  // server it started, which would outlive this script.
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  servers.push(child);
  return child;
}
async function up(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/playlist`, { signal: AbortSignal.timeout(2000) });
      if (r.status) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
function stopAll() {
  for (const c of servers) if (c.exitCode === null) c.kill('SIGTERM');
}
process.on('exit', stopAll);

async function ask(port, query) {
  const r = await fetch(`http://127.0.0.1:${port}/api/playlist?url=${encodeURIComponent(FEED)}${query}`, {
    signal: AbortSignal.timeout(60000),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, cache: r.headers.get('cache-control') ?? '', body };
}
const shared = (c) => /s-maxage=\d+/.test(c) && !/no-store/.test(c);

start(PORT_DOWN, { PODCAST_INDEX_KEY: '', PODCAST_INDEX_SECRET: '' });
start(PORT_UP, {});
if (!(await up(PORT_DOWN)) || !(await up(PORT_UP))) {
  console.error('A server did not start.');
  stopAll();
  process.exit(2);
}

console.log(`feed: ${FEED}`);
console.log('\nPI unavailable');
const past = await ask(PORT_DOWN, '&offset=99999');
t.equal('a page past the end answers 200', past.status, 200);
t.ok('...and is not cached', /no-store/.test(past.cache) && !shared(past.cache), past.cache);

const page = await ask(PORT_DOWN, '&offset=0&limit=5');
t.equal('the first page answers 200', page.status, 200);
const rows = page.body?.episodes?.length ?? 0;
const unasked = page.body?.couldNotAsk ?? -1;
console.log(`  (rows ${rows}, couldNotAsk ${unasked}, header guid ${page.body?.podcast?.podcastGuid ?? 'none'})`);
t.ok('...and is not cached', /no-store/.test(page.cache) && !shared(page.cache), page.cache);
if (rows > 0 && unasked === 0) {
  console.log('  (the database answered every row, so no row asked PI: case 2 ran)');
} else {
  // Every row asked PI and failed, so `couldNotAsk` alone keeps this page out of
  // the CDN — on the old route too. Case 2 needs the database reachable.
  console.log('  SKIPPED case 2: the playlist database answered no row (PLAYLIST_DB_URL unset or');
  console.log('          unreachable from here), so this page only proves the row-level guard.');
}

console.log('\nPI available (must still work)');
const pageUp = await ask(PORT_UP, '&offset=0&limit=5');
t.equal('the first page answers 200', pageUp.status, 200);
t.ok('...carries a guid from PI', !!pageUp.body?.podcast?.podcastGuid, JSON.stringify(pageUp.body?.podcast ?? null).slice(0, 200));
t.ok('...and goes to the shared cache', pageUp.body?.couldNotAsk === 0 ? shared(pageUp.cache) : true,
  `${pageUp.cache} (couldNotAsk ${pageUp.body?.couldNotAsk})`);
const pastUp = await ask(PORT_UP, '&offset=99999');
t.ok('a page past the end goes to the shared cache', pastUp.status === 200 && shared(pastUp.cache), pastUp.cache);

stopAll();
console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed');
process.exit(t.fails ? 1 : 0);
