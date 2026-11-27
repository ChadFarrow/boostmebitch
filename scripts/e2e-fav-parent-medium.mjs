// End-to-end for a favorited SONG that carries no medium of its own.
//
// Usage:
//   npm run build && npm run start                # or `npm run dev`
//   APP_URL=http://127.0.0.1:3000 npm run e2e:favparentmedium
//
// THE BUG (Chad, 2026-11-26). A song hearted from a `musicL` playlist row, or
// from a track list whose feed declares no medium, is saved with none: the
// heart cannot take a playlist's medium (the container is not the parent), and
// the hydrator fills an item's medium only from its parent's own favorite
// entry. So the song sat under MEDIUM UNKNOWN, and the music section's SHUFFLE
// — which plays that section's rows — skipped it.
//
// THE FIX is display only: the page groups such a row under its parent feed's
// medium as Podcast Index reports it (`lib/use-parent-media.ts`). Nothing is
// written to the store, so nothing reaches the kind:10333 event.
//
// WHAT IT PINS:
//   1. Four songs whose parents PI calls `music` (three with no medium, one
//      control that carries `music`) are ONE music section of four, with SHUFFLE.
//   2. An episode whose parent PI calls `podcast` is under podcast.
//   3. Must still work: a row whose parent PI does not hold stays under
//      "medium unknown" — absent is never a guess.
//   4. The stored rows are byte for byte what was seeded: display only.
//   5. The cost is the batch door: ONE `/api/by-guid/batch` request, and no
//      per-guid `/api/by-guid` request.
//   6. Phone (390 wide, CDP `mobile: true`): no horizontal overflow.
//
// Signed out on purpose: no key, so no relay write can happen. The parent
// lookups are read-only Podcast Index calls through the app's own API.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// Real parents, from the IAM playlist's remote items; PI's mediums were read
// on 2026-11-27. The item guids are the playlist's own.
const MUSIC = [
  ['a53d97a2-21a9-5850-957f-20e6e1f1817b', 'e5fd3601-e1c7-4bc8-a652-7b050f322802'], // Kiss Up - EP
  ['0bc8103c-7e22-5a59-b152-04af80746b49', 'b93c4a1f-5c84-482c-9ac3-b841405c20b0'], // No Way Back - Single
  ['64253f63-9ad6-570c-8f76-455fb7ac2a42', 'cd90267a-bbfd-4065-9f45-372b9ec6b170'], // Pixelated Smile
];
const CONTROL = ['c1fd79f4-7bdd-5dd1-8074-264c97f0f857', '694e3f43-3f40-4c49-9602-a6a68f10ed4b']; // The Westend Sessions
const PODCAST = ['917393e3-1b1e-5cef-ace4-edaa54e1f810', 'e2e-parent-medium-episode']; // Podcasting 2.0
const NOBODY = ['00000000-1111-4222-8333-444444444444', 'e2e-parent-medium-orphan']; // PI: not found

const row = ([feedGuid, itemGuid], medium) => [itemGuid, { itemGuid, feedGuid, ...(medium ? { medium } : {}), addedAt: 0 }];
const itemsSeed = Object.fromEntries([
  ...MUSIC.map((p) => row(p)),
  row(CONTROL, 'music'),
  row(PODCAST),
  row(NOBODY),
]);

const { page } = await launchChrome({ name: 'favparentmedium', args: ['--disable-gpu'] });
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

// The library's headings, as `<Section>` renders them: "<heading> — <count>".
const HEADINGS = `[...document.querySelectorAll('section > button[aria-expanded]')].filter((b) => !/^new (episodes|music)/i.test(b.textContent.trim()))`;
// The fold glyph (▾ / ▴) is dropped, so a count can be read at the end.
const headings = () => js(`JSON.stringify(${HEADINGS}.map((b) => b.textContent.replace(/[▾▴]/g, '').replace(/\\s+/g, ' ').trim().toLowerCase()))`).then(JSON.parse);
const shuffleIn = (re) => js(`(() => {
  const h = ${HEADINGS}.find((b) => ${re}.test(b.textContent.toLowerCase()));
  return !!h && [...h.parentElement.querySelectorAll('button')].some((b) => /shuffle/i.test(b.textContent));
})()`);

console.log('\n1. Songs with no medium, grouped by their parent feed');
await send('Page.navigate', { url: `${APP}/privacy` });
await until('document.readyState === "complete"');
await js(`localStorage.clear();
  localStorage.setItem('bmb:favorites:guest', '{}');
  localStorage.setItem('bmb:favepisodes:guest', ${JSON.stringify(JSON.stringify(itemsSeed))});
  localStorage.setItem('bmb:fav_view', ${JSON.stringify(JSON.stringify({ tab: 'all', split: 'all', sort: 'recent' }))});
  1`);
const seeded = await js(`localStorage.getItem('bmb:favepisodes:guest')`);
requests.batch = 0; requests.single = 0;
await send('Page.navigate', { url: `${APP}/favorites` });
await until('document.readyState === "complete"');
await until(`!!document.querySelector('[aria-label="Filter favorites"]')`);
// The parent lookup is one request; give it time, then read.
const grouped = await until(`${HEADINGS}.some((b) => /— 4/.test(b.textContent) && /single/i.test(b.textContent))`, 15000);
await wait(1500);
const hs = await headings();
t.ok('the four songs are ONE music section of four', grouped, JSON.stringify(hs));
t.ok('...and it carries SHUFFLE', await shuffleIn('/single/'), JSON.stringify(hs));
t.ok('the episode is under podcast', hs.some((h) => /episode/.test(h) && /— 1$/.test(h)), JSON.stringify(hs));
t.ok('must still work: the row whose parent PI does not hold stays under medium unknown', hs.some((h) => /medium unknown/.test(h) && /— 1$/.test(h)), JSON.stringify(hs));
t.ok('no other section is left over', hs.length === 3, JSON.stringify(hs));

console.log('\n2. Display only, and the batch door');
t.equal('the stored rows are byte for byte what was seeded', await js(`localStorage.getItem('bmb:favepisodes:guest')`), seeded);
t.equal('one /api/by-guid/batch request', requests.batch, 1);
t.equal('no per-guid /api/by-guid request', requests.single, 0);

console.log('\n3. Phone');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await wait(500);
const o = await js(`JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`).then(JSON.parse);
t.ok('no horizontal overflow at 390', o.sw <= o.cw, JSON.stringify(o));
t.ok('SHUFFLE is still on the music section', await shuffleIn('/single/'));

t.ok('no uncaught exception in the page', pageErrors.length === 0, JSON.stringify(pageErrors));
await js(`localStorage.clear(); 1`);
console.log(`\n${t.fails ? `${t.fails} of ${t.count} check(s) FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
