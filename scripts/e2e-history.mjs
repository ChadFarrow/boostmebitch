// Drives the REAL home page in a real browser and asserts that the browser's
// back and forward buttons step through the views on `/` — browse, show,
// episode — instead of leaving the site. See lib/view-history.ts.
//
// Reported 2026-11-09: "the back button seems to take me away from the site even
// if i've opened multiple pages within the site". Every view on `/` used to share
// one history entry, because the URL mirror only ever called `replaceState`.
//
// WHY THIS IS AN E2E AND NOT A `check:*`. `viewUrl` is a pure mapping; every way
// this goes wrong is wiring — which write pushes and which replaces, what a
// deep link's restore leaves behind it, what Next.js does to `history.state`,
// and whether a step back into `/` from another route shows that entry's view.
//
// BACK AND FORWARD ARE THE BROWSER'S OWN: `Page.navigateToHistoryEntry`, the
// path the toolbar buttons take, not a `history.back()` the page could watch for.
//
// Section 11 is the fullscreen player (#556): an overlay on every route, and a
// history entry of its own while it is open, so Android's back closes it rather
// than stepping through the pages hidden under it and then closing the app.
//
// Sections 12-14 came from a desktop check of the back button (2026-11-19), and
// each failed against production first: "← back to <origin>" pushed the origin
// page on top of the show, so the back button reopened the show (12); back with
// a modal open stepped the page behind the modal (13); and a focused tab took
// Alt+← and ⌘← — the browser's back keys — as "previous tab" (14). Section 13
// opens the BOOST modal and sends nothing: no wallet is connected.
//
// It talks to Podcast Index through the app, like a visitor: a search, a show,
// its newest episodes and the playlists collection. Run it against a build:
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:history                 # APP_URL=… to point it elsewhere
//   npm run e2e:history -- --mobile     # the same on a 390×844 phone viewport
//
// The browser comes from scripts/cdp.mjs: CHROME_PATH, else the usual install
// paths; muted, on a free debug port, and closed on any exit.
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const MOBILE = process.argv.includes('--mobile');
await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

/**
 * A PODCAST, not music: a music feed's rows are tracks, and a tap plays the
 * track instead of opening an episode view. "podcasting 2.0" was the first
 * query tried, and its top hit was the "Top 100 (Music)" playlist. Podnews
 * Weekly Review publishes every week; any other non-music hit is the fallback.
 * A playlist row is told by its stamp's `data-stamp`, not by a `♫` in its text:
 * the stamp's glyph is an SVG now, so no row's text carries one.
 */
const QUERY = 'podnews weekly review';
const PICK_SHOW = `(() => {
  const rows = [...document.querySelectorAll('aside li > button')];
  return rows.find((b) => /podnews weekly review/i.test(b.textContent)) ?? rows.find((b) => !b.querySelector('[data-stamp="playlist"]'));
})()`;

const browser = await launchChrome({ name: 'history', args: ['--window-size=1200,900'] });
const t = checker();
const exceptions = [];

/** One tab with the helpers every step below uses. */
async function tab(page) {
  const { send, js } = page;
  page.on((d) => {
    if (d.method === 'Runtime.exceptionThrown') exceptions.push(d.params.exceptionDetails?.exception?.description ?? '');
  });
  await send('Page.enable');
  await send('Runtime.enable');
  // `--mobile`: a phone viewport through device emulation. A narrow window
  // is not one — Chrome lays the page out at its default width and crops.
  if (MOBILE) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }

  /** Poll `expr` until it is truthy; returns its value, or null on timeout. */
  const until = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await js(expr);
      if (v) return v;
      if (Date.now() > end) return null;
      await wait(150);
    }
  };
  /** What is on screen, in the terms the assertions use. */
  const view = () => js(`(() => {
    const p = new URLSearchParams(location.search);
    const text = (sel) => [...document.querySelectorAll(sel)].map((b) => b.textContent.trim());
    const back = text('main button, main a').find((s) => s.startsWith('← back')) ?? null;
    return {
      path: location.pathname,
      podcast: p.get('podcast'), episode: p.get('episode'), t: p.get('t'),
      playlist: p.get('playlist'), album: p.get('album'),
      back,
      results: document.querySelectorAll('aside li > button').length,
    };
  })()`);
  /** The tab's history as the browser holds it. */
  const nav = async () => (await send('Page.getNavigationHistory')).result;
  const step = async (delta) => {
    const h = await nav();
    const entry = h.entries[h.currentIndex + delta];
    if (!entry) throw new Error(`no history entry at ${delta} from ${h.currentIndex}`);
    await send('Page.navigateToHistoryEntry', { entryId: entry.id });
  };
  /** Where the back button would go, without pressing it. */
  const behind = async () => { const h = await nav(); return h.entries[h.currentIndex - 1]?.url ?? null; };
  const count = async () => (await nav()).entries.length;
  const click = (expr) => js(`(() => { const el = ${expr}; if (!el) return false; el.click(); return true; })()`);
  const clickBack = (label) => click(`[...document.querySelectorAll('main button, main a')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))`);
  const openFirstEpisode = async () => {
    const title = await until(`(() => {
      const more = [...document.querySelectorAll('section.card button[aria-label^="More actions for "]')][0];
      return more ? more.getAttribute('aria-label').slice('More actions for '.length) : null;
    })()`);
    if (!title) return null;
    const ok = await click(`[...document.querySelectorAll('section.card button')].find((b) => !b.getAttribute('aria-label') && b.textContent.trim().startsWith(${JSON.stringify(title.slice(0, 30))}))`);
    return ok ? title : null;
  };
  return { send, js, until, view, step, behind, count, click, clickBack, openFirstEpisode };
}

const A = await tab(browser.page);

/** What each view looks like once React has drawn it — the URL alone changes
 *  a render before the view does, and the episode view is a lazy chunk. */
const backIs = (label) => `[...document.querySelectorAll('main button, main a')].some((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
const SHOW_UP = backIs('← back to results');
const EPISODE_UP = backIs('← back to episodes');
// A show is named by `?podcast=`, `?album=` or `?playlist=` (lib/util.ts `showLinkParam`).
const BROWSE_UP = `!['podcast', 'album', 'playlist'].some((k) => new URLSearchParams(location.search).has(k)) && ![...document.querySelectorAll('main button, main a')].some((b) => b.textContent.trim().startsWith('← back'))`;
/** Set once per document. Still there after a step = the step stayed in this
 *  document; gone = the browser loaded the page again. */
const MARK = `window.__historyE2e = true`;
const SAME_DOC = `window.__historyE2e === true`;

console.log('1. browse → search → show → episode pushes one entry each');
await A.send('Page.navigate', { url: `${APP}/` });
await A.until(`!!document.querySelector('main input[enterkeyhint="search"]')`);
await wait(1500);
await A.js(MARK);
const base = await A.count();
await A.js(`document.querySelector('main input[enterkeyhint="search"]').focus(); true`);
await A.send('Input.insertText', { text: QUERY });
await A.until(`document.querySelectorAll('aside li > button').length > 0`);
t.equal('a search does not add an entry', await A.count(), base);
await A.click(PICK_SHOW);
t.ok('the show view came up', await A.until(SHOW_UP));
const show = (await A.view()).podcast;
t.ok('the show is in the URL', !!show);
t.equal('opening the show pushed an entry', await A.count(), base + 1);
const episodeTitle = await A.openFirstEpisode();
t.ok('an episode row was there to open', !!episodeTitle);
t.ok('the episode view came up', await A.until(EPISODE_UP));
const episode = (await A.view()).episode;
t.ok('the episode is in the URL', !!episode);
t.equal('opening the episode pushed an entry', await A.count(), base + 2);

console.log('2. the browser back button steps back through the views, and stays on the site');
await A.step(-1);
t.ok('back → the show view', await A.until(SHOW_UP));
let v = await A.view();
t.equal('…with the show, not the episode, in the URL', [v.path, v.podcast, v.episode], ['/', show, null]);
await A.step(-1);
t.ok('back → browse', await A.until(BROWSE_UP));
v = await A.view();
t.equal('…on /', v.path, '/');
t.ok('the search results are still there', v.results > 0, `results: ${v.results}`);
t.ok('no page load: both steps stayed in this document', await A.js(SAME_DOC));
t.equal('nothing was pushed by stepping back', await A.count(), base + 2);

console.log('3. forward replays them');
await A.step(1);
t.ok('forward → the show view', await A.until(SHOW_UP));
t.equal('…this show', (await A.view()).podcast, show);
await A.step(1);
t.ok('forward → the episode view', await A.until(EPISODE_UP));
v = await A.view();
t.equal('…this episode', [v.podcast, v.episode], [show, episode]);
t.ok('no page load', await A.js(SAME_DOC));

console.log('4. the in-app back buttons step back rather than pushing a copy');
await A.clickBack('← back to episodes');
t.ok('"← back to episodes" → the show view', await A.until(SHOW_UP));
t.equal('…and no new entry', [(await A.view()).episode, await A.count()], [null, base + 2]);
await A.clickBack('← back to results');
t.ok('"← back to results" → browse', await A.until(BROWSE_UP));
t.equal('…and no new entry', await A.count(), base + 2);
t.ok('the back button now leaves for the page before the site', !(await A.behind())?.startsWith(APP), await A.behind());

console.log('5. a new search typed from a show is a step the back button undoes');
await A.click(PICK_SHOW);
await A.until(SHOW_UP);
t.equal('re-opening the show dropped the forward entries', await A.count(), base + 1);
await A.js(`(() => { const i = document.querySelector('main input[enterkeyhint="search"]'); i.focus(); i.select(); return true; })()`);
await A.send('Input.insertText', { text: 'boostagram' });
t.ok('the search left the show', await A.until(BROWSE_UP));
t.equal('…and pushed', await A.count(), base + 2);
await A.step(-1);
t.ok('back → the show view', await A.until(SHOW_UP));
t.equal('…the show the search left', (await A.view()).podcast, show);

console.log('6. the Home tab on / clears in place: one entry, not two');
const beforeHome = await A.count();
await A.click(`document.querySelector('nav[aria-label="Main"] a[href="/"]')`);
t.ok('Home → browse', await A.until(BROWSE_UP));
await wait(800);
t.equal('Home pushed exactly one entry (it replaced the forward one)', await A.count(), beforeHome);
await A.step(-1);
t.ok('back → the show view', await A.until(SHOW_UP));
t.equal('…this show', (await A.view()).podcast, show);
t.ok('no page load', await A.js(SAME_DOC));

console.log('7. another route and back: each entry shows ITS view, not the last show in the store');
// /playlists is reached from the browse view's BROWSE PLAYLISTS button only,
// and it hands the playlist to `/` through the store and `router.push('/')`. So
// the store holds the playlist when the steps back land on `/` again — the
// case where the store and the entry disagree.
await A.openFirstEpisode();
await A.until(EPISODE_UP);
const leftAt = await A.view();
await A.click(`document.querySelector('main button[aria-label="Go to home"]')`);
t.ok('the wordmark → browse, with BROWSE PLAYLISTS on offer',
  await A.until(`${BROWSE_UP} && !!document.querySelector('main a[href="/playlists"]')`));
await A.click(`document.querySelector('main a[href="/playlists"]')`);
t.ok('the playlists page listed playlists', await A.until(`location.pathname === '/playlists' && document.querySelectorAll('main li > button').length > 0`, 30000));
await A.click(`document.querySelector('main li > button')`);
t.ok('a playlist opened on /, offering the way back to playlists',
  await A.until(`location.pathname === '/' && ${backIs('← back to playlists')}`, 30000));
v = await A.view();
t.ok('…and it is not the show left above', !!v.playlist || (!!v.podcast && v.podcast !== leftAt.podcast), JSON.stringify(v));
await A.step(-1);
t.ok('back → /playlists', await A.until(`location.pathname === '/playlists'`));
await A.step(-1);
t.ok('back → browse, not the playlist the store still holds', await A.until(`location.pathname === '/' && ${BROWSE_UP}`));
await wait(1000);
t.equal('…and the URL stayed /', (await A.view()).podcast, null);
await A.step(-1);
t.ok('back → the episode view', await A.until(EPISODE_UP));
v = await A.view();
t.equal('…of the episode left above', [v.podcast, v.episode], [leftAt.podcast, leftAt.episode]);
t.ok('no page load across the route change', await A.js(SAME_DOC));

console.log('8. a reload, then back: the URL restore takes over');
await A.send('Page.reload');
t.ok('the reload restored the episode view', await A.until(`document.readyState === 'complete' && ${EPISODE_UP}`, 30000));
await A.step(-1);
t.ok('back → the show view', await A.until(SHOW_UP, 30000));
v = await A.view();
t.equal('…of this show', [v.podcast, v.episode], [show, null]);

console.log('9. a deep link lands on ONE entry: back leaves for where it came from');
const B = await tab(await browser.openTab('about:blank'));
await wait(500);
const deepBase = await B.count();
await B.send('Page.navigate', { url: `${APP}/?podcast=${show}&episode=${encodeURIComponent(episode)}&t=5` });
t.ok('the deep link restored the episode view', await B.until(EPISODE_UP, 30000));
await wait(2000);
v = await B.view();
t.equal('…of this episode, and `t` is gone from the URL', [v.podcast, v.episode, v.t], [show, episode, null]);
t.equal('the restore pushed nothing', await B.count(), deepBase + 1);
t.equal('back leaves for the page before', await B.behind(), 'about:blank');
await B.clickBack('← back to episodes');
t.ok('"← back to episodes" with nothing behind → the show view', await B.until(SHOW_UP));
t.equal('…and pushes it', await B.count(), deepBase + 2);
await B.step(-1);
t.ok('back → the episode view', await B.until(EPISODE_UP));
t.equal('…of this episode', (await B.view()).episode, episode);

console.log('10. the publisher aside is a view too: back from one of its feeds returns to it');
// A `?publisher=` link is the one way into the aside that does not depend on
// what a search happens to return. Its back step is the `flushSync` path in
// `<HomePage>`'s popstate handler: the store half AND the aside, in one commit.
const PUBLISHER = 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/chadf-musicl-publisher.xml';
const C = await tab(await browser.openTab('about:blank'));
await wait(500);
const pubBase = await C.count();
await C.send('Page.navigate', { url: `${APP}/?publisher=${encodeURIComponent(PUBLISHER)}` });
const ASIDE_UP = `new URLSearchParams(location.search).get('publisher') === ${JSON.stringify(PUBLISHER)} && document.querySelectorAll('aside li > button').length > 0`;
t.ok('the publisher link restored the aside with its feeds', await C.until(ASIDE_UP, 30000));
await C.js(MARK);
t.equal('the restore pushed nothing', await C.count(), pubBase + 1);
await C.click(`document.querySelector('aside li > button')`);
t.ok('a feed from the aside opened', await C.until(`!new URLSearchParams(location.search).has('publisher') && ['playlist', 'album', 'podcast', 'feed'].some((k) => new URLSearchParams(location.search).has(k))`, 30000));
t.equal('…and pushed', await C.count(), pubBase + 2);
await C.step(-1);
t.ok('back → the aside, its feeds listed again', await C.until(ASIDE_UP, 30000));
{ const cv = await C.view(); t.equal('…with no show selected', [cv.podcast, cv.album, cv.playlist], [null, null, null]); }
t.equal('…and nothing pushed on the way', await C.count(), pubBase + 2);
t.ok('no page load', await C.js(SAME_DOC));

console.log('11. the open fullscreen player is a step: back closes it, as its ← back does (#556)');
// Reported from the Android app, playing, on /favorites: "Nothing happens the
// first two or three 'back' actions but then another back action will close the
// app." The player is an overlay, not a route, and opening it added no entry, so
// each back stepped through the pages UNDER it — /favorites, then the views on
// `/` it was opened from — while the player covered them, and the next one left
// the site. Measured on main with this sequence: three backs changed the URL
// behind the open player, the fourth reached about:blank.
const D = await tab(await browser.openTab('about:blank'));
await wait(500);
const PLAYER_UP = `(() => { const x = document.querySelector('[aria-label="Close fullscreen player"]'); return !!x && getComputedStyle(x).visibility !== 'hidden'; })()`;
const PLAYER_DOWN = `!${PLAYER_UP}`;
const PLAYER_CONTROL = (label) => `document.querySelector('[aria-label="Close fullscreen player"]')?.closest('div.fixed')?.querySelector('button[aria-label=${JSON.stringify(label)}]')`;
await D.send('Page.navigate', { url: `${APP}/?podcast=${show}` });
t.ok('a show link restored the show view', await D.until(SHOW_UP, 30000));
await D.js(MARK);
const showUrl = await D.js('location.href');
t.ok('an episode row was there to open', !!(await D.openFirstEpisode()));
t.ok('the episode view came up', await D.until(EPISODE_UP));
const episodeUrl = await D.js('location.href');
t.ok('▶ PLAY was there to press', await D.click(`[...document.querySelectorAll('main button')].find((b) => /▶ (PLAY|RESUME)/.test(b.textContent))`));
t.ok('the mini-player came up', await D.until(`!!document.querySelector(${JSON.stringify(MINI_BAR)})`, 15000));
await wait(800);

// On `/` first: the entry it pushes must carry the view of the entry under it.
let before = await D.count();
await D.click(`document.querySelector('[aria-label^="Open fullscreen player"]')`);
t.ok('the fullscreen player opened over the episode view', await D.until(PLAYER_UP, 10000));
t.equal('…and pushed one entry, on the same URL', [await D.count(), await D.js('location.href')], [before + 1, episodeUrl]);
await D.step(-1);
t.ok('back → the player closed', await D.until(PLAYER_DOWN, 5000));
t.ok('…over the episode view, still there', await D.until(EPISODE_UP, 5000));
t.equal('…on its URL, in this document', [await D.js('location.href'), await D.js(SAME_DOC)], [episodeUrl, true]);
t.equal('…and the next back goes to the show, as before the player opened', await D.behind(), showUrl);

// /favorites: the report's own page.
await D.click(`document.querySelector('nav[aria-label="Main"] a[href="/favorites"]')`);
t.ok('the Favorites tab → /favorites', await D.until(`location.pathname === '/favorites'`));
await wait(800);
const favUrl = await D.js('location.href');
before = await D.count();
await D.click(`document.querySelector('[aria-label^="Open fullscreen player"]')`);
t.ok('the fullscreen player opened over /favorites', await D.until(PLAYER_UP, 10000));
t.equal('…and pushed one entry, on the same URL', [await D.count(), await D.js('location.href')], [before + 1, favUrl]);
await D.step(-1);
t.ok('back → the player closed', await D.until(PLAYER_DOWN, 5000));
t.equal('…on /favorites still, in this document', [await D.js('location.href'), await D.js(SAME_DOC)], [favUrl, true]);
t.equal('…and the next back goes to the episode view, not to a copy of /favorites', await D.behind(), episodeUrl);
await D.step(1);
t.ok('forward → the player again, the screen that entry was', await D.until(PLAYER_UP, 5000));
t.ok('its ← back was there to press', await D.click(PLAYER_CONTROL('Back')));
t.ok('← back closed it', await D.until(PLAYER_DOWN, 5000));
t.equal('…by stepping back: no entry left behind for it', [await D.js('location.href'), await D.behind()], [favUrl, episodeUrl]);
await D.click(`document.querySelector('[aria-label^="Open fullscreen player"]')`);
t.ok('opened once more', await D.until(PLAYER_UP, 10000));
t.equal('…pushing over the old forward entry, not beside it', await D.count(), before + 1);
t.ok('its ✕ was there to press', await D.click(PLAYER_CONTROL('Close fullscreen player')));
t.ok('✕ closed it', await D.until(PLAYER_DOWN, 5000));
t.equal('…the same way', [await D.js('location.href'), await D.behind()], [favUrl, episodeUrl]);
await D.step(-1);
t.ok('back from /favorites → the episode view, with the player still closed', await D.until(`location.pathname === '/' && ${EPISODE_UP} && ${PLAYER_DOWN}`, 10000));
t.equal('…of this episode', await D.js('location.href'), episodeUrl);
t.ok('no page load', await D.js(SAME_DOC));

console.log('12. "← back to <origin>" steps back to the page that handed the show over');
// It was a plain <Link>: it PUSHED the origin page on top of the show, and the
// browser's back button then reopened the show just left (/demu → an album →
// "← back to DeMu" → back → the album). Now it steps back when the entry
// behind is that page (`stepBackToOrigin`, lib/view-history.ts).
const E = await tab(await browser.openTab('about:blank'));
await wait(500);
await E.send('Page.navigate', { url: `${APP}/demu` });
// An album's row is the unlabelled button in its <li>; the cover's ▶ beside it plays.
const DEMU_LISTED = `document.querySelectorAll('main button[aria-label^="Play "]').length > 3`;
const DEMU_ROW = `[...document.querySelectorAll('main li button')].find((b) => !b.getAttribute('aria-label'))`;
t.ok('/demu listed albums', await E.until(`location.pathname === '/demu' && ${DEMU_LISTED}`, 30000));
await E.js(MARK);
const demuBase = await E.count();
await E.click(DEMU_ROW);
t.ok('an album opened on /, offering "← back to DeMu"', await E.until(`location.pathname === '/' && ${backIs('← back to DeMu')}`, 30000));
t.equal('…and pushed one entry', await E.count(), demuBase + 1);
await E.clickBack('← back to DeMu');
t.ok('"← back to DeMu" → /demu', await E.until(`location.pathname === '/demu' && ${DEMU_LISTED}`, 15000));
t.equal('…by stepping back: no entry added', await E.count(), demuBase + 1);
t.equal('…so the back button now leaves for the page before /demu', await E.behind(), 'about:blank');
await E.step(1);
t.ok('forward → the album again', await E.until(`location.pathname === '/' && ${backIs('← back to DeMu')}`, 15000));
await E.clickBack('← back to DeMu');
t.ok('"← back to DeMu" after a step forward → /demu', await E.until(`location.pathname === '/demu'`, 15000));
t.equal('…by stepping back again', [await E.count(), await E.behind()], [demuBase + 1, 'about:blank']);
t.ok('no page load', await E.js(SAME_DOC));

await E.send('Page.navigate', { url: `${APP}/playlists` });
t.ok('/playlists listed playlists', await E.until(`location.pathname === '/playlists' && document.querySelectorAll('main li > button').length > 0`, 30000));
await E.js(MARK);
const plBase = await E.count();
await E.click(`document.querySelector('main li > button')`);
t.ok('a playlist opened on /, offering "← back to playlists"', await E.until(`location.pathname === '/' && ${backIs('← back to playlists')}`, 30000));
await E.clickBack('← back to playlists');
t.ok('"← back to playlists" → /playlists', await E.until(`location.pathname === '/playlists'`, 15000));
t.equal('…by stepping back: no entry added', await E.count(), plBase + 1);
t.equal('…and the entry behind is the one before /playlists', await E.behind(), `${APP}/demu`);
t.ok('no page load', await E.js(SAME_DOC));

console.log('13. an open modal is a step: back closes it, and its own close steps back');
// Back with a modal open stepped the page BEHIND the modal: the sign-in modal
// stayed up over the previous view, and the boost modal went away with the view
// that owned it. Now each open modal is an entry (components/use-modal-history.ts).
// Bowl After Bowl carries a value block, so its show page has BOOST; the boost
// modal is only OPENED here — no wallet is connected, and nothing is sent.
const BOWL = '2d418249-453a-5714-8abc-5b657570b641';
const F = await tab(await browser.openTab('about:blank'));
await wait(500);
const DIALOGS = `document.querySelectorAll('[role="dialog"]').length`;
const BOOST_BTN = `[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'BOOST')`;
const IN_DIALOG = (re) => `[...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()) || ${re}.test(b.getAttribute('aria-label') ?? ''))`;
const index = async (P) => (await P.send('Page.getNavigationHistory')).result.currentIndex;
const escape = async (P) => {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await P.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
};
await F.send('Page.navigate', { url: `${APP}/?podcast=${BOWL}` });
t.ok('a value show opened, with BOOST', await F.until(`${SHOW_UP} && !!${BOOST_BTN}`, 30000));
await F.js(MARK);
await wait(800);
const fUrl = await F.js('location.href');
const fCount = await F.count();
const fIndex = await index(F);
const fBehind = await F.behind();

await F.click(BOOST_BTN);
t.ok('BOOST opened its modal', await F.until(`${DIALOGS} === 1`, 10000));
await wait(300);
t.equal('…and pushed one entry, on the same URL', [await F.count(), await F.js('location.href')], [fCount + 1, fUrl]);
await F.step(-1);
t.ok('back → the modal closed', await F.until(`${DIALOGS} === 0`, 5000));
t.ok('…over the show view, still there', await F.until(SHOW_UP, 5000));
t.equal('…on its URL, in this document', [await F.js('location.href'), await F.js(SAME_DOC)], [fUrl, true]);
t.equal('…and the next back goes where it went before the modal opened', await F.behind(), fBehind);

await F.click(BOOST_BTN);
await F.until(`${DIALOGS} === 1`, 10000);
await wait(300);
t.ok('"+ Add a GIF" was there to press', await F.click(IN_DIALOG('/Add a GIF/')));
t.ok('the GIF picker opened over the boost modal', await F.until(`${DIALOGS} === 2`, 10000));
await wait(300);
t.equal('…each modal pushed one entry', await index(F), fIndex + 2);
await F.step(-1);
t.ok('back → the GIF picker closed, the boost modal still open', await F.until(`${DIALOGS} === 1`, 5000));
await wait(300);
t.equal('…and still open a moment later', await F.js(DIALOGS), 1);
await F.step(-1);
t.ok('back again → the boost modal closed', await F.until(`${DIALOGS} === 0`, 5000));
t.equal('…on the show view, its URL', [await F.js('location.href'), await F.js(SAME_DOC)], [fUrl, true]);

await F.click(BOOST_BTN);
await F.until(`${DIALOGS} === 1`, 10000);
await wait(300);
t.ok('the × was there to press', await F.click(IN_DIALOG('/^Close$/')));
t.ok('× closed the modal', await F.until(`${DIALOGS} === 0`, 5000));
await wait(500);
t.equal('…by stepping back: the entry before it is current, on the same URL, the same entry behind',
  [await index(F), await F.js('location.href'), await F.behind()], [fIndex, fUrl, fBehind]);

await F.click(BOOST_BTN);
await F.until(`${DIALOGS} === 1`, 10000);
await wait(300);
await escape(F);
t.ok('Escape closed the modal', await F.until(`${DIALOGS} === 0`, 5000));
await wait(500);
t.equal('…by stepping back too', [await index(F), await F.behind()], [fIndex, fBehind]);

await F.click(BOOST_BTN);
await F.until(`${DIALOGS} === 1`, 10000);
await wait(300);
await F.click(IN_DIALOG('/Add a GIF/'));
await F.until(`${DIALOGS} === 2`, 10000);
await wait(300);
await escape(F);
t.ok('Escape in the GIF picker closed only the picker', await F.until(`${DIALOGS} === 1`, 5000));
await wait(500);
t.equal('…stepping back one entry, onto the boost modal\'s', await index(F), fIndex + 1);
t.ok('Cancel was there to press', await F.click(IN_DIALOG('/^Cancel$/')));
t.ok('Cancel closed the boost modal', await F.until(`${DIALOGS} === 0`, 5000));
await wait(500);
t.equal('…stepping back off its entry', [await index(F), await F.behind()], [fIndex, fBehind]);

const signIn = `[...document.querySelectorAll('button')].find((b) => /^Sign in/.test(b.textContent.trim()))`;
await F.click(signIn);
t.ok('the account menu offers "Sign in with Nostr"', await F.until(`[...document.querySelectorAll('[role^="menuitem"]')].some((m) => /Sign in with Nostr/.test(m.textContent))`, 5000));
await F.click(`[...document.querySelectorAll('[role^="menuitem"]')].find((m) => /Sign in with Nostr/.test(m.textContent))`);
t.ok('the sign-in modal opened', await F.until(`${DIALOGS} === 1`, 5000));
await wait(300);
await F.step(-1);
t.ok('back → the sign-in modal closed', await F.until(`${DIALOGS} === 0`, 5000));
t.equal('…and the page behind it did not move', [await F.js('location.href'), await F.js(SAME_DOC)], [fUrl, true]);
t.ok('…the show view still there', await F.until(SHOW_UP, 3000));

// Over the fullscreen player: its entry and the modal's stack. The player's
// own BOOST opens the modal; back closes the modal and leaves the player up,
// and the next back closes the player. The show's first row can be a pending
// live item, so the episode is a numbered one.
const EPISODE_ROW = `[...document.querySelectorAll('section.card button')].find((b) => !b.getAttribute('aria-label') && /^Episode \\d+/.test(b.textContent.trim()))`;
t.ok('a numbered episode was there to open', await F.until(`!!${EPISODE_ROW}`, 15000) && await F.click(EPISODE_ROW));
t.ok('the episode view came up', await F.until(EPISODE_UP, 15000));
const epUrl = await F.js('location.href');
t.ok('▶ PLAY was there to press', await F.click(`[...document.querySelectorAll('main button')].find((b) => /▶ (PLAY|RESUME)/.test(b.textContent))`));
t.ok('the mini-player came up', await F.until(`!!document.querySelector(${JSON.stringify(MINI_BAR)})`, 15000));
await wait(800);
const pIndex = await index(F);
await F.click(`document.querySelector('[aria-label^="Open fullscreen player"]')`);
t.ok('the fullscreen player opened', await F.until(PLAYER_UP, 10000));
const PLAYER_BOOST = `[...(document.querySelector('[aria-label="Close fullscreen player"]')?.closest('div.fixed')?.querySelectorAll('button') ?? [])].find((b) => /^BOOST$/.test(b.textContent.trim()) && !b.disabled)`;
t.ok('its BOOST was there to press', await F.until(`!!${PLAYER_BOOST}`, 15000) && await F.click(PLAYER_BOOST));
t.ok('the boost modal opened over the player', await F.until(`${DIALOGS} === 1`, 10000));
await wait(300);
t.equal('…two entries above the page: the player\'s, then the modal\'s', await index(F), pIndex + 2);
await F.step(-1);
t.ok('back → the modal closed', await F.until(`${DIALOGS} === 0`, 5000));
await wait(500);
t.ok('…and the player is still open', await F.js(PLAYER_UP));
await F.click(PLAYER_BOOST);
await F.until(`${DIALOGS} === 1`, 10000);
await wait(300);
await F.click(IN_DIALOG('/^Close$/'));
t.ok('× on the modal closed it', await F.until(`${DIALOGS} === 0`, 5000));
await wait(500);
t.equal('…stepping back onto the player\'s entry, the player still open', [await index(F), await F.js(PLAYER_UP)], [pIndex + 1, true]);
await F.step(-1);
t.ok('back → the player closed', await F.until(`!${PLAYER_UP}`, 5000));
t.equal('…on the episode view\'s entry, its URL', [await index(F), await F.js('location.href')], [pIndex, epUrl]);
t.ok('no page load', await F.js(SAME_DOC));

console.log('14. a tab with focus leaves the browser\'s back shortcuts alone');
// Alt+← (Windows, Linux) and ⌘← (macOS) are the browser's BACK. A click on a
// tab leaves focus on it, and <UnderlineTabs> took those keys as "previous
// tab": the tab moved and the navigation was cancelled. A plain ← still moves.
// Headless Chrome on macOS does not run the browser's shortcuts, so the check
// is the one the page controls: the key is not cancelled, and no tab moves.
t.ok('the episode view has tabs', await F.until(`${EPISODE_UP} && document.querySelectorAll('main [role="tab"]').length > 1`, 15000));
await F.js(`window.addEventListener('keydown', (e) => { window.__lastKeyPrevented = e.defaultPrevented; }); true`);
const SELECTED_TAB = `[...document.querySelectorAll('main [role="tab"]')].findIndex((x) => x.getAttribute('aria-selected') === 'true')`;
const keyOnTab = async (label, mods) => {
  await F.click(`document.querySelectorAll('main [role="tab"]')[1]`);
  await F.js(`document.querySelectorAll('main [role="tab"]')[1].focus(); true`);
  await wait(200);
  const before = await F.js(SELECTED_TAB);
  for (const type of ['rawKeyDown', 'keyUp']) {
    await F.send('Input.dispatchKeyEvent', { type, modifiers: mods, key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  }
  await wait(200);
  return { label, before, after: await F.js(SELECTED_TAB), prevented: await F.js('window.__lastKeyPrevented') };
};
for (const [label, mods] of [['Alt+←', 1], ['⌘←', 4], ['Ctrl+←', 2]]) {
  const r = await keyOnTab(label, mods);
  t.equal(`${label} on a focused tab: not cancelled, no tab moved`, [r.prevented, r.after], [false, r.before]);
}
const plain = await keyOnTab('←', 0);
t.equal('a plain ← still moves to the previous tab', [plain.prevented, plain.after], [true, plain.before - 1]);

t.equal('no uncaught exceptions', exceptions, []);
console.log(t.fails ? `\nSMOKE FAILED (${t.fails} of ${t.count})` : `\nSMOKE OK (${t.count} checks)`);
await exit(t.fails ? 1 : 0);
