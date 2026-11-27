// A playlist's NEXT PAGE failing while a listener plays near the end of the
// loaded rows, driven in a real browser against canned `/api/*` answers.
//
// THE BUG (full-code review 2026-11-19, components/lists/episode-list.tsx:462).
// `<EpisodeList>` prefetches a `musicL` playlist's next page once the playing row
// is within three of the end. That effect bailed only on `loadingMore`, and a
// FAILED page clears `loadingMore` too, so the effect re-armed on the same render
// and asked again — a request per round trip, for as long as the route kept
// failing, against our Podcast Index quota.
//
// WHAT IT PINS:
//   1. Page 2 answers 500 while the last loaded row plays: in 12 s it is asked
//      at most 3 times (once, then after 5 s), never in a loop; the "couldn't
//      load more tracks" line and ↻ RETRY show.
//   2. ↻ RETRY, now answered: the three new rows are listed and the error line
//      goes (what must still work).
//   3. Phone emulation (390×844), a failing page again: no sideways overflow,
//      and ↻ RETRY at least 24×24.
//
// Every `/api/*` request is answered from a canned body, so this needs no Podcast
// Index key and no network. The tab is muted.
//
//   npm run build && npm run start          (or any server on BMB_APP)
//   BMB_APP=http://localhost:3000 npm run e2e:playlistretry

import { readFileSync } from 'node:fs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.BMB_APP ?? process.env.E2E_APP ?? 'http://localhost:3000';
const GUID = 'bdf5a0f9-d803-5d6d-81b6-d99bfba58e4e';
const FEED_URL = 'https://example.com/e2e-retry-playlist.xml';
const PODCAST = {
  id: 7683902, podcastGuid: GUID, title: 'E2E Retry Playlist', author: 'E2E',
  description: '', medium: 'musicl', url: FEED_URL, image: '',
};
const track = (n) => ({
  id: 100 + n, guid: `track-${n}`, podcastGuid: `album-${n}`, title: `Track ${n}`,
  enclosureUrl: `/api/e2e-audio.mp3?t=${n}`, feedId: PODCAST.id,
  datePublished: 1697414400 + n, duration: 1,
});
const PAGE_0 = [0, 1, 2].map(track);
const PAGE_1 = [3, 4, 5].map(track);
const AUDIO = readFileSync(new URL('../public/boost.mp3', import.meta.url));

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

const { page } = await launchChrome({ name: 'playlist-page-retry', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;

// How page 2 (`offset=3`) is answered: 'fail' (500 + `{ error }`) or 'ok'.
let mode = 'fail';
const page2Asks = [];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(pathname, q) {
  if (pathname === '/api/by-guid') return [200, { podcast: PODCAST }];
  if (pathname === '/api/feed') return [200, { podcast: PODCAST, episodes: [] }];
  if (pathname === '/api/playlist') {
    if (!q.get('offset')) {
      return [200, { podcast: PODCAST, episodes: PAGE_0, total: 6, offset: 0, nextOffset: 3, notFound: 0, couldNotAsk: 0, sourceShow: null }];
    }
    page2Asks.push(Date.now());
    if (mode === 'fail') return [500, { error: 'Playlist failed' }];
    return [200, { podcast: PODCAST, episodes: PAGE_1, total: 6, offset: 3, nextOffset: null, notFound: 0, couldNotAsk: 0, sourceShow: null }];
  }
  if (pathname === '/api/live-shows') return [200, { items: [], unverifiedFeeds: 0, truncated: false }];
  return [200, {}];
}
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
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
  const [status, body] = answer(u.pathname, u.searchParams);
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: status,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: b64(body),
  });
});
await send('Page.enable');
await send('Runtime.enable');

const text = () => js('document.body.innerText');
const ERROR_LINE = "couldn't load more tracks";
const retryButton = `[...document.querySelectorAll('button')].find((b) => /RETRY/.test(b.textContent ?? '') && b.closest('p')?.textContent?.includes(${JSON.stringify(ERROR_LINE)}))`;

async function openAndPlayLast() {
  page2Asks.length = 0;
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  await until(`document.readyState === 'complete'`, 30000);
  const listed = await until(`document.body.innerText.includes('Track 2')`, 30000);
  const clicked = await js(`(() => {
    const row = [...document.querySelectorAll('ul.divide-y > li')].find((el) => el.textContent.includes('Track 2'));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  return listed && clicked;
}

// ------------------------------------------------------------------------------------
section('1. Page 2 fails while the last loaded row plays');
mode = 'fail';
t.ok('the playlist opened and Track 2 was pressed', await openAndPlayLast(), (await text()).slice(0, 400));
const asked = async (ms) => { for (let i = 0; i < ms / 100 && !page2Asks.length; i += 1) await wait(100); return page2Asks.length > 0; };
t.ok('page 2 was asked for', await asked(10000), `asks ${page2Asks.length}`);
const first = page2Asks[0] ?? Date.now();
await wait(Math.max(0, first + 12_000 - Date.now()));
const asks = page2Asks.length;
const gaps = page2Asks.slice(1, 11).map((x, i) => x - page2Asks[i]);
t.ok('in 12 s page 2 was asked at most 3 times (no loop)', asks <= 3, `asks ${asks}, gaps ${JSON.stringify(gaps)}`);
t.ok('...and asked again automatically, after a wait', asks >= 2 && gaps[0] >= 4_000, `asks ${asks}, gaps ${JSON.stringify(gaps)}`);
t.ok('the error line shows', (await text()).includes(ERROR_LINE), (await text()).slice(-400));
t.ok('↻ RETRY is offered', await js(`!!${retryButton}`));

// ------------------------------------------------------------------------------------
section('2. ↻ RETRY, now answered');
mode = 'ok';
await js(`${retryButton}?.click()`);
t.ok('the three new rows are listed', await until(`['Track 3','Track 4','Track 5'].every((s) => document.body.innerText.includes(s))`, 10000), (await text()).slice(-400));
t.ok('...and the error line is gone', !(await text()).includes(ERROR_LINE));

// ------------------------------------------------------------------------------------
section('3. Phone emulation (390×844): a failing page');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
mode = 'fail';
t.ok('the playlist opened and Track 2 was pressed', await openAndPlayLast());
t.ok('the error line shows', await until(`document.body.innerText.includes(${JSON.stringify(ERROR_LINE)})`, 10000));
const m = await js(`(() => {
  const b = ${retryButton}?.getBoundingClientRect();
  return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, retry: b ? [Math.round(b.width), Math.round(b.height)] : null };
})()`);
t.ok('the page does not overflow sideways', m.overflow <= 0, JSON.stringify(m));
t.ok('↻ RETRY is at least 24×24', m.retry && m.retry[0] >= 24 && m.retry[1] >= 24, JSON.stringify(m));
await send('Emulation.clearDeviceMetricsOverride');

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
