// End-to-end for NEW MUSIC on /favorites: new albums from favorited PUBLISHER
// feeds (artists). See components/favorites-new-music.tsx and lib/new-music.ts.
//
// Usage:
//   npm run dev                                    # in another terminal
//   npm run e2e:newmusic                           # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:newmusic -- --headed --keep
//
// WHAT IT PINS:
//
//   1. A first look at an artist shows ITS LATEST album only, and only when it
//      is under 90 days old; an artist whose newest album is old shows none, and
//      neither does one whose newest album is already a favorite (never the
//      second newest). Every listed album is remembered as seen. An artist whose
//      feed cannot be read is "could not check", and its seen list is not made.
//      Publisher reads go out ONE AT A TIME.
//   2. Inside the hour, a reload paints the stored list and asks nothing.
//   3. A later look shows what the artist ADDED: a dated new album, and an album
//      Podcast Index does not hold yet (no id, no date) — but not an OLD album
//      that is newly listed (a back catalogue moving hosts).
//   4. A row opens its album on `/`, by PI id, or by feed URL when PI does not
//      hold it.
//   5. ✕ removes one row and CLEAR removes all, and neither comes back on the
//      next pass.
//   6. An unfavorited artist's rows and memory go.
//   7. No favorited artist: no section.
//   8. 390px phone: no horizontal overflow; ✕ and the row control are at least
//      24×24.
//   9. ♡ ARTIST on an album page follows its artist ON THIS DEVICE: it shows
//      for an artist feed Podcast Index does not hold, a press writes
//      `bmb:artists` and leaves the shared favorites list unchanged, NEW MUSIC
//      then follows the artist and lists the follow with a ✕ that stops it. An
//      artist already in favorites gets a stamp, not a control.
//  10. A first look whose dates do not come back is not spent.
//  11. A playlist maker's publisher feed (#586) is NOT an artist: its new
//      playlists make no row and are not asked for a date, the heading does not
//      count it, and with only makers followed there is no section. A maker
//      that starts to list an album becomes an artist, with a first look.
//
// Signed out: favorites live in `bmb:favorites:guest` and nothing reaches a
// relay. `/api/publisher`, `/api/new-episodes` and `/api/feed` are answered
// here, so the run does not depend on live Podcast Index data.
//
// NOT DRIVEN: signed in (the pass waits for the relay read to land, as NEW
// EPISODES does), and a following larger than one pass (20 artists).

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// ---- the fixture ----------------------------------------------------------
const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);
const guid = (p, i) => `${p}-${String(i).padStart(4, '0')}-4000-8000-000000000000`;
const pubUrl = (n) => `https://feeds.example.invalid/pub-${n}.xml`;
const albumUrl = (k) => `https://feeds.example.invalid/album-${k}.xml`;
const PUB = (n, title) => ({
  id: 8000 + n, podcastGuid: guid('pub', n), title, author: title, url: pubUrl(n),
  medium: 'publisher', addedAt: 1700000000000 + n,
});
const P1 = PUB(1, 'Artist One');
const P2 = PUB(2, 'Artist Two');
const P3 = PUB(3, 'Artist Unreadable');
// An album PI does not hold comes back from `/api/publisher`'s RSS read with a
// NEGATIVE id (`-fnvHash(url)`); pass `id: 0` to get that shape.
const album = (k, { id = 9000 + k, title = `Album ${k}` } = {}) => ({
  id: id > 0 ? id : -(100000 + k), podcastGuid: id > 0 ? guid('alb', k) : undefined, url: albumUrl(k), title, author: 'e2e',
  medium: 'music', ...(id > 0 ? {} : { isPreview: true }),
  // A full record carries more than the section keeps; none of it may reach storage.
  description: 'x'.repeat(2000),
});
// Days ago of each album's newest track, by PI id.
const AGE = { 9101: 10, 9102: 200, 9201: 400, 9202: 5, 9104: 2, 9106: 500 };
const listing = {
  [pubUrl(1)]: [album(101), album(102), album(103, { id: 0 })],
  [pubUrl(2)]: [album(201), album(202)],
};
// Album 202 is already in the library.
const FAV_ALBUM = { id: 9202, podcastGuid: guid('alb', 202), title: 'Album 202', url: albumUrl(202), medium: 'music', addedAt: 1700000000000 };

// Section 9: two album pages naming an artist feed (`publisherFeed`, which
// `/api/feed` attaches from either tag form). Artist nine is in Podcast Index;
// artist ten is not, like Wavlake's artist feeds on 2026-11-15.
const P9 = PUB(9, 'Artist Nine');
const P10 = PUB(10, 'Artist Ten Not In PI');
const ARTISTS_IN_PI = { [P9.podcastGuid]: { ...P9, addedAt: undefined } };
const track = (feedId, k) => ({
  id: feedId * 10 + k, guid: guid(`trk${feedId}`, k), feedId, title: `Track ${k}`,
  enclosureUrl: `https://feeds.example.invalid/t-${feedId}-${k}.mp3`, datePublished: 1790000000 + k,
});
const albumPage = (id, title, pub) => ({
  podcast: {
    id, podcastGuid: guid('page', id), title, author: pub.title, medium: 'music', url: albumUrl(id),
    publisherFeed: { feedGuid: pub.podcastGuid, feedUrl: pub.url },
  },
  episodes: [track(id, 1), track(id, 2)],
});
const ALBUM_PAGES = { 9401: albumPage(9401, 'Album By Nine', P9), 9402: albumPage(9402, 'Album By Ten', P10) };
listing[pubUrl(9)] = [album(901), album(902)];
AGE[9901] = 4;
listing[pubUrl(10)] = [album(1001)];
AGE[10001] = 6;

// ---- the browser ----------------------------------------------------------
const { page } = await launchChrome({ name: 'newmusic' });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];
const asked = { publisher: [], latest: [], feed: [] };
// Section 10: the date lookup answers 429, as Podcast Index does under load.
let latestRateLimited = false;
let inFlight = 0;
let maxInFlight = 0;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const fulfillJson = (requestId, body, responseCode = 200) => send('Fetch.fulfillRequest', {
  requestId, responseCode,
  responseHeaders: [{ name: 'content-type', value: 'application/json' }],
  body: b64(body),
});

await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  const q = u.searchParams;
  try {
    if (u.pathname === '/api/publisher') {
      const feedUrl = q.get('feedUrl');
      asked.publisher.push(feedUrl);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await wait(150);
      inFlight -= 1;
      const feeds = listing[feedUrl];
      if (!feeds) {
        await fulfillJson(requestId, { error: 'could not read the publisher feed', upstream: 'feed' }, 502);
        return;
      }
      await fulfillJson(requestId, { feeds, listed: feeds.length, couldNotAskPi: false });
      return;
    }
    if (u.pathname === '/api/new-episodes' && q.get('latest') === '1' && latestRateLimited) {
      await fulfillJson(requestId, { error: 'rate limited' }, 429);
      return;
    }
    if (u.pathname === '/api/new-episodes' && q.get('latest') === '1') {
      const ids = (q.get('feeds') ?? '').split(',').map(Number);
      asked.latest.push(...ids);
      const episodes = ids.filter((id) => AGE[id] !== undefined).map((id) => ({
        id: id * 10, feedId: id, title: `newest of ${id}`, enclosureUrl: '', datePublished: nowSec() - AGE[id] * DAY,
      }));
      await fulfillJson(requestId, { episodes, covered: ids, truncated: false });
      return;
    }
    if (u.pathname === '/api/new-episodes') {
      // The NEW EPISODES section on the same page: nothing new there.
      const ids = (q.get('feeds') ?? '').split(',').map(Number).filter(Boolean);
      await fulfillJson(requestId, { episodes: [], covered: ids, truncated: false });
      return;
    }
    // Section 9: the album pages and the artist lookups behind ♡ ARTIST.
    if (u.pathname === '/api/by-guid' && ARTISTS_IN_PI[q.get('guid')]) {
      await fulfillJson(requestId, { podcast: ARTISTS_IN_PI[q.get('guid')] });
      return;
    }
    if (u.pathname === '/api/by-guid' && [P9.podcastGuid, P10.podcastGuid].includes(q.get('guid'))) {
      await fulfillJson(requestId, { error: 'not found' }, 404);
      return;
    }
    if (u.pathname === '/api/feed' && ALBUM_PAGES[q.get('id')]) {
      await fulfillJson(requestId, ALBUM_PAGES[q.get('id')]);
      return;
    }
    if (u.pathname === '/api/feed') {
      asked.feed.push(q.get('id') ? `id=${q.get('id')}` : `url=${q.get('url')}`);
      const all = Object.values(listing).flat();
      const a = q.get('id') ? all.find((x) => String(x.id) === q.get('id')) : all.find((x) => x.url === q.get('url'));
      await fulfillJson(requestId, a ? { podcast: { ...a, description: '' }, episodes: [] } : { error: 'not found' }, a ? 200 : 404);
      return;
    }
    await send('Fetch.continueRequest', { requestId });
  } catch {
    // The page navigated away under a paused request. Nothing to answer.
  }
});
await send('Page.enable');
await send('Runtime.enable');

// ---- helpers --------------------------------------------------------------
const FAVS = (list) => JSON.stringify(Object.fromEntries(list.map((f) => [f.podcastGuid, f])));
async function seed(entries, { clear = true } = {}) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { ${clear ? 'localStorage.clear();' : ''} const s = ${JSON.stringify(entries)};
    for (const k in s) { if (s[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, s[k]); } return true; })()`);
}
async function openFavorites() {
  await send('Page.navigate', { url: `${APP}/favorites` });
  await until('document.readyState === "complete"');
  await until(`!!document.querySelector('[aria-label="Filter favorites"]') || !!document.querySelector('[data-new-music]')`, 15000);
}
const record = () => js(`JSON.parse(localStorage.getItem('bmb:newmusic:guest') || 'null')`);
const settle = () => until(`(() => {
  const s = document.querySelector('[data-new-music]');
  return !!s && !/checking/.test(s.textContent);
})()`, 20000);
async function forcePass() {
  await js(`(() => { const r = JSON.parse(localStorage.getItem('bmb:newmusic:guest')); r.checkedAt = 0;
    localStorage.setItem('bmb:newmusic:guest', JSON.stringify(r)); return true; })()`);
  await openFavorites();
  await until(`!!document.querySelector('[data-new-music]')`, 10000);
  await wait(2800); // SETTLE_MS
  await settle();
}
const rowTitles = () => js(`[...document.querySelectorAll('[data-new-music] li')].map((li) => li.querySelector('[data-new-music-title]')?.textContent ?? '')`);
const sectionText = () => js(`document.querySelector('[data-new-music]')?.textContent ?? ''`);

// ---- 1. a first look ------------------------------------------------------
console.log('1. a first look');
await seed({ 'bmb:favorites:guest': FAVS([P1, P2, P3, FAV_ALBUM]) });
await openFavorites();
await until(`!!document.querySelector('[data-new-music]')`, 10000);
t.ok('the section shows under a favorited artist', await js(`!!document.querySelector('[data-new-music]')`));
await wait(2800);
await settle();
t.equal('only artist one\'s latest album, under 90 days', await rowTitles(), ['Album 101']);
t.ok('the row names the artist', /Artist One/.test(await sectionText()));
t.ok('the unreadable artist is "could not check", not "nothing new"', /Could not check 1 of your artists/.test(await sectionText()));
t.ok('the section says where the albums come from', /New albums from the 3 artists you follow/.test(await sectionText()));
let rec = await record();
t.equal('every listed album of artist one is seen (guid and url keys)', rec.seen[P1.podcastGuid].length, 5);
t.equal('artist two is seen too, though nothing showed', rec.seen[P2.podcastGuid].length, 4);
t.equal('the unreadable artist gets no seen list', P3.podcastGuid in rec.seen, false);
t.equal('the album with no PI id is never asked for a date', asked.latest.some((id) => id <= 0), false);
t.equal('publisher reads go out one at a time', maxInFlight, 1);
t.equal('every artist was asked', asked.publisher.length, 3);
t.equal('no description reached storage', JSON.stringify(rec).includes('xxxxxxxxxx'), false);

// ---- 2. the throttle ------------------------------------------------------
console.log('2. inside the hour');
const before = asked.publisher.length;
await openFavorites();
await until(`!!document.querySelector('[data-new-music] li')`, 10000);
await wait(3500);
t.equal('a reload inside the hour asks nothing', asked.publisher.length, before);
t.equal('and paints the stored row', await rowTitles(), ['Album 101']);

// ---- 3. a later look ------------------------------------------------------
console.log('3. a later look');
listing[pubUrl(1)] = [
  ...listing[pubUrl(1)],
  album(104),                     // new, two days old
  album(105, { id: 0 }),          // new, not in PI yet: no date
  album(106),                     // newly listed, but 500 days old
];
await forcePass();
const later = await rowTitles();
t.equal('the new albums show, undated first, then newest', later, ['Album 105', 'Album 104', 'Album 101']);
t.equal('an old album newly listed is not news', later.includes('Album 106'), false);
t.ok('an undated row says when it was found', /found /.test(await sectionText()));

// ---- 4. a row opens its album ---------------------------------------------
console.log('4. open');
await js(`[...document.querySelectorAll('[data-new-music] li button')].find((b) => /Album 104/.test(b.textContent))?.click()`);
await until(`location.pathname === '/'`, 8000);
await until(`/Album 104/.test(document.body.textContent)`, 8000);
t.ok('opens on / with the album on screen', true);
await wait(800);
t.ok('the album page loads by PI id', asked.feed.includes('id=9104'), JSON.stringify(asked.feed));
await openFavorites();
await until(`!!document.querySelector('[data-new-music] li')`, 10000);
await js(`[...document.querySelectorAll('[data-new-music] li button')].find((b) => /Album 105/.test(b.textContent))?.click()`);
await until(`location.pathname === '/'`, 8000);
for (let i = 0; i < 40 && !asked.feed.includes(`url=${albumUrl(105)}`); i++) await wait(250);
t.ok('an album PI does not hold opens by its feed URL', asked.feed.includes(`url=${albumUrl(105)}`), JSON.stringify(asked.feed));

// ---- 5. ✕ and CLEAR -------------------------------------------------------
console.log('5. ✕ and CLEAR');
await openFavorites();
await until(`!!document.querySelector('[data-new-music] li')`, 10000);
await js(`document.querySelector('[aria-label="Remove Album 104 from new music"]')?.click()`);
await wait(300);
t.equal('✕ removes that row only', await rowTitles(), ['Album 105', 'Album 101']);
await forcePass();
t.equal('a dismissed row does not come back on the next pass', (await rowTitles()).includes('Album 104'), false);
await js(`[...document.querySelectorAll('[data-new-music] button')].find((b) => b.textContent.trim() === 'CLEAR')?.click()`);
await wait(300);
t.equal('CLEAR empties the list', await rowTitles(), []);
await forcePass();
t.equal('nothing cleared comes back', await rowTitles(), []);

// ---- 6. unfavorite --------------------------------------------------------
console.log('6. an unfavorited artist');
listing[pubUrl(1)] = [...listing[pubUrl(1)], album(107)];
AGE[9107] = 1;
await seed({ 'bmb:favorites:guest': FAVS([P2, P3, FAV_ALBUM]) }, { clear: false });
const askedBefore = asked.publisher.length;
await forcePass();
rec = await record();
t.equal('its seen list goes', P1.podcastGuid in rec.seen, false);
t.equal('its rows go', rec.rows.filter((r) => r.publisherGuid === P1.podcastGuid).length, 0);
t.equal('and it is not asked about', asked.publisher.slice(askedBefore).includes(pubUrl(1)), false);

// ---- 7. no artist, no section ---------------------------------------------
console.log('7. no favorited artist');
await seed({ 'bmb:favorites:guest': FAVS([FAV_ALBUM]) });
await openFavorites();
await wait(3500);
t.equal('no section', await js(`!!document.querySelector('[data-new-music]')`), false);

// ---- 8. a phone -----------------------------------------------------------
console.log('8. 390px');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
listing[pubUrl(1)] = [album(301, { title: 'An Album With A Title Long Enough To Wrap Onto A Second Line On A Phone' }), album(302, { id: 0 })];
AGE[9301] = 3;
await seed({ 'bmb:favorites:guest': FAVS([P1, P3]) });
await openFavorites();
await until(`!!document.querySelector('[data-new-music]')`, 10000);
await wait(2800);
await settle();
const m = await js(`(() => {
  const s = document.querySelector('[data-new-music]');
  const x = s.querySelector('[aria-label^="Remove "]')?.getBoundingClientRect();
  const row = s.querySelector('li button')?.getBoundingClientRect();
  const head = s.querySelector('button[aria-expanded]')?.getBoundingClientRect();
  return {
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    x: x && [Math.round(x.width), Math.round(x.height)],
    row: row && [Math.round(row.width), Math.round(row.height)],
    head: head && [Math.round(head.width), Math.round(head.height)],
    rows: s.querySelectorAll('li').length,
  };
})()`);
t.equal('a first look with a row to show', m.rows, 1);
t.ok('no horizontal overflow', m.sw <= m.cw, JSON.stringify(m));
t.ok('✕ is at least 24×24', m.x && m.x[0] >= 24 && m.x[1] >= 24, JSON.stringify(m.x));
t.ok('the row control is at least 24×24', m.row && m.row[0] >= 24 && m.row[1] >= 24, JSON.stringify(m.row));
t.ok('the heading control is at least 24 tall', m.head && m.head[1] >= 24, JSON.stringify(m.head));

// ---- 9. ♡ ARTIST on the album page ----------------------------------------
// A FOLLOW ON THIS DEVICE, never a favorite: the shared list must not change.
console.log('9. ♡ ARTIST');
await seed({ 'bmb:favorites:guest': FAVS([]) });
await send('Page.navigate', { url: `${APP}/?feed=9402` });
await until(`/Album By Ten/.test(document.body.textContent)`, 15000);
const chipShown = await until(`!!document.querySelector('[data-artist-follow] button')`, 8000);
t.ok('♡ ARTIST shows for an artist Podcast Index does not hold', chipShown);
const chip = await js(`(() => {
  const b = document.querySelector('[data-artist-follow] button');
  const r = b?.getBoundingClientRect();
  return b && { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'), w: Math.round(r.width), h: Math.round(r.height),
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
})()`);
t.ok('the chip says ARTIST and is not pressed', /ARTIST/.test(chip?.text ?? '') && chip.pressed === 'false', JSON.stringify(chip));
t.ok('the chip is at least 24×24 on a phone', chip && chip.w >= 24 && chip.h >= 24, JSON.stringify(chip));
t.ok('the album page has no horizontal overflow', chip && chip.sw <= chip.cw, JSON.stringify(chip));
await js(`document.querySelector('[data-artist-follow] button').click()`);
await wait(500);
const follows = await js(`JSON.parse(localStorage.getItem('bmb:artists:guest') || '{}')`);
t.equal('a press follows the artist on this device, with its feed address',
  Object.values(follows).map((f) => [f.feedGuid, f.feedUrl, f.title]), [[P10.podcastGuid, P10.url, P10.title]]);
t.equal('the SHARED favorites list does not change', await js(`localStorage.getItem('bmb:favorites:guest')`), FAVS([]));
t.equal('the chip shows it is pressed', await js(`document.querySelector('[data-artist-follow] button').getAttribute('aria-pressed')`), 'true');
await openFavorites();
await until(`!!document.querySelector('[data-new-music]')`, 10000);
await wait(2800);
await settle();
t.equal('NEW MUSIC follows the artist just followed', await rowTitles(), ['Album 1001']);
t.ok('the section lists the follow', /Followed on this device:.*Artist Ten Not In PI/.test(await sectionText()));
await js(`document.querySelector('[aria-label="Stop following Artist Ten Not In PI"]')?.click()`);
await wait(500);
t.equal('✕ on the follow stops it', await js(`localStorage.getItem('bmb:artists:guest')`), '{}');
t.equal('and with no artist left the section goes', await js(`!!document.querySelector('[data-new-music]')`), false);

// An artist already in the shared favorites: a stamp, never a control that
// could remove the shared favorite.
await seed({ 'bmb:favorites:guest': FAVS([P9]) });
await send('Page.navigate', { url: `${APP}/?feed=9401` });
await until(`/Album By Nine/.test(document.body.textContent)`, 15000);
await until(`/ARTIST IN FAVORITES/.test(document.body.textContent)`, 8000);
t.ok('an artist already in favorites shows the stamp', /ARTIST IN FAVORITES/.test(await js('document.body.textContent')));
t.equal('and no follow button', await js(`!!document.querySelector('[data-artist-follow]')`), false);

// ---- 10. a first look whose dates do not come back ------------------------
console.log('10. dates rate limited on a first look');
latestRateLimited = true;
await seed({ 'bmb:favorites:guest': FAVS([P9]) });
await openFavorites();
await until(`!!document.querySelector('[data-new-music]')`, 10000);
await wait(2800);
await settle();
rec = await record();
t.ok('the artist is "could not check", not "nothing new"', /Could not check 1 of your artists/.test(await sectionText()));
t.equal('and keeps no seen list, so the first look is not spent', P9.podcastGuid in rec.seen, false);
latestRateLimited = false;
await forcePass();
t.equal('the next check names the latest album', await rowTitles(), ['Album 901']);

// ---- 11. a playlist maker is not an artist --------------------------------
// The owner's choice, 2026-11-17. A maker's publisher feed lists playlists
// (`medium="musicL"`), and nothing but those children tells it from an artist's.
console.log('11. a playlist maker');
const P11 = PUB(11, 'A Playlist Maker');
const playlist = (k) => ({ ...album(k, { title: `Playlist ${k}` }), medium: 'musicL' });
listing[pubUrl(11)] = [playlist(1101), playlist(1102)];
AGE[10101] = 1;
AGE[10102] = 3;
await seed({ 'bmb:favorites:guest': FAVS([P9, P11]) });
const latestBefore = asked.latest.length;
await openFavorites();
await until(`!!document.querySelector('[data-new-music]')`, 10000);
await wait(2800);
await settle();
rec = await record();
t.equal('the maker\'s new playlists make no row', await rowTitles(), ['Album 901']);
t.ok('the heading counts the artist and not the maker', /New albums from the 1 artist you follow/.test(await sectionText()), await sectionText());
t.equal('the record names the maker', rec.makers, [P11.podcastGuid]);
t.equal('a maker keeps no seen list', P11.podcastGuid in rec.seen, false);
t.equal('no playlist is asked for a date', asked.latest.slice(latestBefore).some((id) => id === 10101 || id === 10102), false);
t.equal('a maker is not "could not check"', /Could not check/.test(await sectionText()), false);

await seed({ 'bmb:favorites:guest': FAVS([P11]) }, { clear: false });
await openFavorites();
await wait(3500);
t.equal('with only a maker followed, there is no section', await js(`!!document.querySelector('[data-new-music]')`), false);

// The maker lists an album one day: it is an artist from then on.
listing[pubUrl(11)] = [...listing[pubUrl(11)], album(1103)];
AGE[10103] = 2;
await js(`(() => { const r = JSON.parse(localStorage.getItem('bmb:newmusic:guest')); r.checkedAt = 0;
  localStorage.setItem('bmb:newmusic:guest', JSON.stringify(r)); return true; })()`);
await openFavorites();
await wait(2800);
await until(`!!document.querySelector('[data-new-music]')`, 15000);
await settle();
rec = await record();
t.equal('a maker that lists an album becomes an artist, with a first look', await rowTitles(), ['Album 1103']);
t.equal('and leaves the makers', rec.makers, []);

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
