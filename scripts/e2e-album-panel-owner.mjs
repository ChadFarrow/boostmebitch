// The fullscreen player's Album / Playlist panel, when ONE SONG is a row of two
// lists: its album, and a playlist that names it. Driven in a real browser with
// in-app navigation (a `Page.navigate` would drop what is playing) against
// canned `/api/*` answers.
//
// THE BUG (full-code review 2026-11-19, components/fullscreen-player.tsx:1550).
// The panel lists `episodeQueue`, which is the list the listener OPENED LAST, not
// the list the playing track came from. #633 gated it on "the playing track is a
// row of `episodeQueue`" — but `isPlayingRow` matches on the Podcast Index id, and
// a playlist row for a song carries the same id as the album's row. So: play a
// song from its album, then open a playlist that holds it, and the panel read
// "Album · 3 tracks" over the PLAYLIST's rows, and a tap played another album's
// song under this album's show. The reverse (play from the playlist, open the
// album) labelled the album's rows "Playlist".
//
// WHAT IT PINS:
//   1. Album A plays a1, then playlist P (which holds a1) is opened: no panel.
//   2. P plays a1, then album A is opened: no panel.
//   3. (must still work) A plays a1, A stays open: the Album panel lists A.
//   4. (must still work) P plays b1, P stays open: the Playlist panel lists P.
//   5. Phone emulation (390×844): case 3, no sideways overflow.
//
// Every `/api/*` request is answered from a canned body; the tab is muted.
//
//   npm run build && npm run start          (or any server on BMB_APP)
//   BMB_APP=http://localhost:3000 npm run e2e:albumpanel

import { readFileSync } from 'node:fs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.BMB_APP ?? process.env.E2E_APP ?? 'http://localhost:3000';

const ALBUM = {
  id: 5001, podcastGuid: 'e2e-album-a', title: 'E2E Album A', author: 'Artist A',
  description: '', medium: 'music', url: 'https://example.com/e2e-album-a.xml', image: '',
};
const PLAYLIST = {
  id: 6001, podcastGuid: 'e2e-playlist-p', title: 'E2E Playlist P', author: 'Curator',
  description: '', medium: 'musicl', url: 'https://example.com/e2e-playlist-p.xml', image: '',
};
const song = (id, guid, feed, title, n) => ({
  id, guid, podcastGuid: feed.podcastGuid, feedId: feed.id, title, episode: n,
  enclosureUrl: `/api/e2e-audio.mp3?t=${guid}`, datePublished: 1697414400 + n, duration: 120, feedTitle: feed.title,
});
const ALBUM_B = { id: 7001, podcastGuid: 'e2e-album-b', title: 'E2E Album B' };
const A1 = song(201, 'a1', ALBUM, 'Song A1', 1);
const A2 = song(202, 'a2', ALBUM, 'Song A2', 2);
const A3 = song(203, 'a3', ALBUM, 'Song A3', 3);
const B1 = song(301, 'b1', ALBUM_B, 'Song B1', 1);
const B2 = song(302, 'b2', ALBUM_B, 'Song B2', 2);
const ALBUM_ROWS = [A1, A2, A3];
// The playlist's copy of A1 carries A1's own ids, as `/api/playlist` resolves it.
const PLAYLIST_ROWS = [B1, { ...A1 }, B2];
// About two minutes of audio, so a track cannot END mid-scenario and move on.
const AUDIO = Buffer.concat(Array(120).fill(readFileSync(new URL('../public/boost.mp3', import.meta.url))));

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

const { page } = await launchChrome({ name: 'album-panel-owner', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(pathname, q) {
  if (pathname === '/api/by-guid') {
    return { podcast: q.get('guid') === PLAYLIST.podcastGuid ? PLAYLIST : ALBUM };
  }
  if (pathname === '/api/feed') {
    const isAlbum = q.get('id') === String(ALBUM.id) || q.get('url') === ALBUM.url;
    return isAlbum ? { podcast: ALBUM, episodes: ALBUM_ROWS } : { podcast: PLAYLIST, episodes: [] };
  }
  if (pathname === '/api/playlist') {
    return { podcast: PLAYLIST, episodes: PLAYLIST_ROWS, total: 3, offset: 0, nextOffset: null, notFound: 0, couldNotAsk: 0, sourceShow: null };
  }
  if (pathname === '/api/search') {
    const want = /playlist/i.test(q.get('q') ?? '') ? PLAYLIST : ALBUM;
    return { feeds: [want], type: q.get('type') ?? 'all', total: 1 };
  }
  if (pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
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
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: b64(answer(u.pathname, u.searchParams)),
  });
});
await send('Page.enable');
await send('Runtime.enable');

const INPUT = `document.querySelector('input.input[enterkeyhint="search"]')`;
async function deepLink(feed, firstRow) {
  // The app restores the last-played item on load, so each case starts from an
  // empty origin — or a row press on that item would PAUSE it, not play it here.
  await send('Storage.clearDataForOrigin', { origin: new URL(APP).origin, storageTypes: 'local_storage,session_storage,indexeddb' });
  await send('Page.navigate', { url: `${APP}/?podcast=${feed.podcastGuid}` });
  await until(`document.readyState === 'complete'`, 30000);
  return until(`[...document.querySelectorAll('ul.divide-y > li')].some((el) => el.textContent.includes(${JSON.stringify(firstRow)}))`, 30000);
}
async function playRow(title, guid) {
  const clicked = await js(`(() => {
    const row = [...document.querySelectorAll('ul.divide-y > li')].find((el) => el.textContent.includes(${JSON.stringify(title)}));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  return clicked && until(`(document.querySelector('audio')?.currentSrc ?? '').includes('t=${guid}')`, 10000);
}
/** Opens `feed` the way a listener does: the search box, then its result row. */
async function openBySearch(feed, query, firstRow) {
  await js(`(() => { const i = ${INPUT}; i.focus(); i.select(); return 1; })()`);
  await send('Input.insertText', { text: query });
  const listed = await until(`[...document.querySelectorAll('button, a')].some((el) => el.textContent.includes(${JSON.stringify(feed.title)}))`, 10000);
  await js(`[...document.querySelectorAll('button, a')].find((el) => el.textContent.includes(${JSON.stringify(feed.title)}))?.click()`);
  return listed && until(`[...document.querySelectorAll('ul.divide-y > li')].some((el) => el.textContent.includes(${JSON.stringify(firstRow)}))`, 15000);
}
async function panel() {
  await js(`document.querySelector('[aria-label^="Open fullscreen player"]')?.click()`);
  await until(`!!document.querySelector('[aria-label="Close fullscreen player"]')`, 5000);
  await wait(500);
  const p = await js(`(() => {
    const el = document.querySelector('[data-track-panel]');
    if (!el) return null;
    return { kind: el.getAttribute('data-track-panel'), head: el.querySelector('p')?.textContent ?? '', rows: [...el.querySelectorAll('li')].map((li) => li.textContent) };
  })()`);
  const overflow = await js('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  await js(`document.querySelector('[aria-label="Close fullscreen player"]')?.click()`);
  await wait(300);
  return { p, overflow };
}

// ------------------------------------------------------------------------------------
section('1. Album A plays A1, then playlist P (which holds A1) is opened');
t.ok('album A is listed', await deepLink(ALBUM, 'Song A1'));
t.ok('A1 plays', await playRow('Song A1', 'a1'));
t.ok('P is opened from the search box', await openBySearch(PLAYLIST, 'e2e playlist', 'Song B1'));
{
  const { p } = await panel();
  t.ok('the fullscreen player shows no track panel (P is not where A1 came from)', p === null, JSON.stringify(p));
}

// ------------------------------------------------------------------------------------
section('2. Playlist P plays A1, then album A is opened');
t.ok('playlist P is listed', await deepLink(PLAYLIST, 'Song B1'));
t.ok('A1 plays from P', await playRow('Song A1', 'a1'));
t.ok('A is opened from the search box', await openBySearch(ALBUM, 'e2e album', 'Song A2'));
{
  const { p } = await panel();
  t.ok('the fullscreen player shows no track panel (A is not where A1 came from)', p === null, JSON.stringify(p));
}

// ------------------------------------------------------------------------------------
section('3. A plays A1 and A stays open (must still work)');
t.ok('album A is listed', await deepLink(ALBUM, 'Song A1'));
t.ok('A1 plays', await playRow('Song A1', 'a1'));
{
  const { p } = await panel();
  t.ok('the Album panel shows', p?.kind === 'album', JSON.stringify(p));
  t.ok('...listing A\'s three songs', p?.rows?.length === 3 && ['Song A1', 'Song A2', 'Song A3'].every((s, i) => p.rows[i].includes(s)), JSON.stringify(p));
}

// ------------------------------------------------------------------------------------
section('4. P plays B1 and P stays open (must still work)');
t.ok('playlist P is listed', await deepLink(PLAYLIST, 'Song B1'));
t.ok('B1 plays', await playRow('Song B1', 'b1'));
{
  const { p } = await panel();
  t.ok('the Playlist panel shows', p?.kind === 'playlist', JSON.stringify(p));
  t.ok('...listing P\'s three rows', p?.rows?.length === 3 && ['Song B1', 'Song A1', 'Song B2'].every((s, i) => p.rows[i].includes(s)), JSON.stringify(p));
}

// ------------------------------------------------------------------------------------
section('5. Phone emulation (390×844): case 3');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
t.ok('album A is listed', await deepLink(ALBUM, 'Song A1'));
t.ok('A1 plays', await playRow('Song A1', 'a1'));
{
  const { p, overflow } = await panel();
  t.ok('the Album panel shows', p?.kind === 'album', JSON.stringify(p));
  t.ok('the page does not overflow sideways', overflow <= 0, `overflow ${overflow}`);
}
await send('Emulation.clearDeviceMetricsOverride');

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
