// End-to-end for the FAVORITES tab of Add songs: a saved song with no art, or no
// medium, of its own takes its ALBUM'S, display only.
//
// Usage (the maker is behind the feature switch, at build time):
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on npm run build && NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on npm run start
//   APP_URL=http://127.0.0.1:3000 npm run e2e:addsongsart
//
// THE GAP (Chad, 2026-11-26). `<FavTrackHeart>` saves the time split's `image`,
// which a split may not have, and the hydrator never re-resolves an item this
// device already holds — so the row stays without art, and Add songs drew an
// empty square. A song saved with no medium but with an enclosure (a track list
// whose feed declared none) was left out of the tab altogether.
//
// THE FIX: `useParentFeeds` (`lib/use-parent-media.ts`) asks Podcast Index for
// the parent album, through the batch door, and the row SHOWS its cover and its
// medium. Nothing is written to the store, so nothing reaches kind:10333.
//
// WHAT IT PINS:
//   1. A row with no image gets an <img> that LOADS the parent album's cover
//      (main renders no <img> at all).
//   2. Must still work: a row with its own image keeps it.
//   3. Must still work: a row whose parent PI does not hold stays in the list,
//      as a track, with no <img> — absent is never a guess, never a broken image.
//   4. A row with no medium and an enclosure, whose parent PI calls `music`, is
//      in the list; one whose parent PI calls `podcast` is not.
//   5. + ADD carries the cover to the draft row (`SongLabel.image`, local only).
//   6. The stored favorites are byte for byte what was seeded.
//   7. The cost is the batch door: one `/api/by-guid/batch`, no per-guid call.
//   8. No horizontal overflow at 390 (CDP `mobile: true`) and at 1280.
//
// Signed out on purpose: no key, so no relay write is possible. + ADD changes the
// local draft only; nothing is published. The parents are real albums from the
// IAM playlist; PI's answers were read on 2026-11-27.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Build and start it with NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on.`);
const maker = await fetch(`${APP}/playlists/make`);
if (maker.status !== 200) {
  console.error(`${APP}/playlists/make answered ${maker.status}: build with NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on.`);
  process.exit(2);
}

const KISS_UP = { feedGuid: 'a53d97a2-21a9-5850-957f-20e6e1f1817b', itemGuid: 'e5fd3601-e1c7-4bc8-a652-7b050f322802', cover: '10b19a49-4990-4bde-8012-ff62af4a771c' };
const NO_WAY_BACK = { feedGuid: '0bc8103c-7e22-5a59-b152-04af80746b49', itemGuid: 'b93c4a1f-5c84-482c-9ac3-b841405c20b0', cover: 'no-way-back.jpg' };
const PIXELATED = { feedGuid: '64253f63-9ad6-570c-8f76-455fb7ac2a42', itemGuid: 'cd90267a-bbfd-4065-9f45-372b9ec6b170' };
const OWN_IMAGE = 'https://d12wklypp119aj.cloudfront.net/image/5781d087-66d8-4c54-88de-0141405e3022.jpg';
const PODCAST = { feedGuid: '917393e3-1b1e-5cef-ace4-edaa54e1f810', itemGuid: 'e2e-addsongs-art-episode' };
const NOBODY = { feedGuid: '00000000-1111-4222-8333-444444444444', itemGuid: 'e2e-addsongs-art-orphan' };

const seed = Object.fromEntries([
  // 1. No image, no medium, no enclosure: the shape <FavTrackHeart> writes.
  [KISS_UP.itemGuid, { itemGuid: KISS_UP.itemGuid, feedGuid: KISS_UP.feedGuid, title: 'Kiss Up row', podcastTitle: 'Kiss Up - EP', addedAt: 6 }],
  // 4. No medium, an enclosure: the shape <FavEpisodeHeart> writes from a feed with no medium.
  [NO_WAY_BACK.itemGuid, { itemGuid: NO_WAY_BACK.itemGuid, feedGuid: NO_WAY_BACK.feedGuid, title: 'No Way Back row', enclosureUrl: 'https://example.invalid/no-way-back.mp3', addedAt: 5 }],
  // 2. Its own image, which must win.
  [PIXELATED.itemGuid, { itemGuid: PIXELATED.itemGuid, feedGuid: PIXELATED.feedGuid, title: 'Pixelated row', image: OWN_IMAGE, medium: 'music', addedAt: 4 }],
  // 4. An episode of a podcast, saved with no medium: not a song.
  [PODCAST.itemGuid, { itemGuid: PODCAST.itemGuid, feedGuid: PODCAST.feedGuid, title: 'Podcast episode row', enclosureUrl: 'https://example.invalid/ep.mp3', addedAt: 3 }],
  // 3. A parent PI does not hold.
  [NOBODY.itemGuid, { itemGuid: NOBODY.itemGuid, feedGuid: NOBODY.feedGuid, title: 'Orphan row', addedAt: 2 }],
]);

const { page } = await launchChrome({ name: 'addsongsart', args: ['--disable-gpu'] });
const { send, js, until } = page;
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
const t = checker();
const pageErrors = [];
const requests = { batch: 0, single: 0 };
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
  }
  if (m.method === 'Network.requestWillBeSent') {
    const url = m.params.request.url;
    if (url.includes('/api/by-guid/batch')) requests.batch += 1;
    else if (/\/api\/by-guid\?/.test(url)) requests.single += 1;
  }
});

const rows = () => js(`JSON.stringify([...document.querySelectorAll('ul[aria-label="Saved songs"] [data-add-row]')].map((li) => {
  const img = li.querySelector('[data-song-art] img');
  return {
    // The title line, not the preview's hidden error line before it.
    title: li.querySelector('div.min-w-0 > p')?.textContent ?? '',
    img: img ? { src: decodeURIComponent(img.currentSrc), loaded: img.complete && img.naturalWidth > 0, hidden: img.style.visibility === 'hidden' } : null,
  };
}))`).then(JSON.parse);
const row = (list, word) => list.find((r) => r.title.includes(word));

async function openFavoritesTab(width, mobile) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`localStorage.clear();
    localStorage.setItem('bmb:favorites:guest', '{}');
    localStorage.setItem('bmb:favepisodes:guest', ${JSON.stringify(JSON.stringify(seed))});
    1`);
  requests.batch = 0; requests.single = 0;
  await send('Page.navigate', { url: `${APP}/playlists/make` });
  await until('document.readyState === "complete"');
  await until(`[...document.querySelectorAll('button')].some((b) => /ADD SONGS/.test(b.textContent))`, 15000);
  await js(`[...document.querySelectorAll('button')].find((b) => /ADD SONGS/.test(b.textContent)).click(); 1`);
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'FAVORITES')`, 5000);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'FAVORITES').click(); 1`);
  // The covers: the parent lookup is one request, then the images load.
  await until(`(() => {
    const li = [...document.querySelectorAll('[data-add-row]')].find((l) => /Kiss Up row/.test(l.textContent));
    const img = li?.querySelector('[data-song-art] img');
    return !!img && img.complete && img.naturalWidth > 0;
  })()`, 15000);
  await wait(1500);
}

const seeded = JSON.stringify(seed);

console.log('\n1. Phone (390): the FAVORITES tab');
await openFavoritesTab(390, true);
let list = await rows();
const detail = JSON.stringify(list.map((r) => `${r.title}: ${r.img ? `${r.img.loaded ? 'loaded' : 'not loaded'} ${r.img.src.slice(-60)}` : 'no img'}`)).replaceAll('\n', ' | ');
const kiss = row(list, 'Kiss Up row');
t.ok('a row with no image loads its album cover', !!kiss?.img?.loaded && kiss.img.src.includes(KISS_UP.cover), detail);
const pix = row(list, 'Pixelated row');
t.ok('must still work: a row with its own image keeps it', !!pix?.img?.loaded && pix.img.src.includes(OWN_IMAGE), detail);
const orphan = row(list, 'Orphan row');
t.ok('must still work: a row whose parent PI does not hold stays, with no <img>', !!orphan && orphan.img === null, detail);
const nwb = row(list, 'No Way Back row');
t.ok('a row with no medium whose parent is music is listed, with its cover', !!nwb?.img?.loaded && nwb.img.src.includes(NO_WAY_BACK.cover), detail);
t.ok('a row with no medium whose parent is a podcast is not listed', !row(list, 'Podcast episode row'), detail);
t.equal('four songs in the tab', list.length, 4);
t.equal('one /api/by-guid/batch request', requests.batch, 1);
t.equal('no per-guid /api/by-guid request', requests.single, 0);
let o = await js(`JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`).then(JSON.parse);
t.ok('no horizontal overflow at 390', o.sw <= o.cw, JSON.stringify(o));

console.log('\n2. + ADD carries the cover to the draft');
await js(`document.querySelector('button[aria-label="Add Kiss Up row"]').click(); 1`);
const added = await until(`!!document.querySelector('ul[aria-label="Saved songs"] [data-added]')`, 20000);
t.ok('the song was added', added, JSON.stringify(await js(`[...document.querySelectorAll('[data-add-refused]')].map((p) => p.textContent).join(' | ')`)));
await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'DONE').click(); 1`);
await wait(800);
const draftArt = await js(`(() => {
  const img = [...document.querySelectorAll('img')].find((i) => decodeURIComponent(i.currentSrc).includes(${JSON.stringify(KISS_UP.cover)}));
  return !!img && img.complete && img.naturalWidth > 0;
})()`);
t.ok('the draft shows the album cover for the added song', draftArt);
t.equal('the stored favorites are byte for byte what was seeded', await js(`localStorage.getItem('bmb:favepisodes:guest')`), seeded);

console.log('\n3. Desktop (1280)');
await openFavoritesTab(1280, false);
list = await rows();
t.ok('a row with no image loads its album cover', !!row(list, 'Kiss Up row')?.img?.loaded);
o = await js(`JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`).then(JSON.parse);
t.ok('no horizontal overflow at 1280', o.sw <= o.cw, JSON.stringify(o));
t.equal('the stored favorites are byte for byte what was seeded', await js(`localStorage.getItem('bmb:favepisodes:guest')`), seeded);

t.ok('no uncaught exception in the page', pageErrors.length === 0, JSON.stringify(pageErrors));
await js(`localStorage.clear(); 1`);
console.log(`\n${t.fails ? `${t.fails} of ${t.count} check(s) FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
