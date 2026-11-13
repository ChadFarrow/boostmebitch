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
// It talks to Podcast Index through the app, like a visitor: a search, a show,
// its newest episodes and the playlists collection. Run it against a build:
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:history                 # APP_URL=… to point it elsewhere
//   npm run e2e:history -- --mobile     # the same on a 390×844 phone viewport
//
// The browser comes from scripts/cdp.mjs: CHROME_PATH, else the usual install
// paths; muted, on a free debug port, and closed on any exit.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const MOBILE = process.argv.includes('--mobile');
await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

/**
 * A PODCAST, not music: a music feed's rows are tracks, and a tap plays the
 * track instead of opening an episode view. "podcasting 2.0" was the first
 * query tried, and its top hit was the "Top 100 (Music)" playlist. Podnews
 * Weekly Review publishes every week; any other non-music hit is the fallback.
 */
const QUERY = 'podnews weekly review';
const PICK_SHOW = `(() => {
  const rows = [...document.querySelectorAll('aside li > button')];
  return rows.find((b) => /podnews weekly review/i.test(b.textContent)) ?? rows.find((b) => !b.textContent.includes('♫'));
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
      playlist: p.get('playlist'),
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
const BROWSE_UP = `!new URLSearchParams(location.search).has('podcast') && ![...document.querySelectorAll('main button, main a')].some((b) => b.textContent.trim().startsWith('← back'))`;
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
t.ok('a feed from the aside opened', await C.until(`!new URLSearchParams(location.search).has('publisher') && (new URLSearchParams(location.search).has('playlist') || new URLSearchParams(location.search).has('podcast') || new URLSearchParams(location.search).has('feed'))`, 30000));
t.equal('…and pushed', await C.count(), pubBase + 2);
await C.step(-1);
t.ok('back → the aside, its feeds listed again', await C.until(ASIDE_UP, 30000));
t.equal('…with no show selected', [(await C.view()).podcast, (await C.view()).playlist], [null, null]);
t.equal('…and nothing pushed on the way', await C.count(), pubBase + 2);
t.ok('no page load', await C.js(SAME_DOC));

t.equal('no uncaught exceptions', exceptions, []);
console.log(t.fails ? `\nSMOKE FAILED (${t.fails} of ${t.count})` : `\nSMOKE OK (${t.count} checks)`);
await exit(t.fails ? 1 : 0);
