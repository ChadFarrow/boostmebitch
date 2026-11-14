// End-to-end for the GIF picker's hover preview (docs/money-boosts.md, "A GIF
// on a boost").
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:gifhover
//   APP_URL=http://127.0.0.1:3047 npm run e2e:gifhover -- --headed --keep
//
// WHY IT EXISTS. The picker grid shows ~10–20 KB stills, because an episode may
// be streaming on the same connection and one animated tile can be most of a
// megabyte (870 KB for one id below). Chad asked (2026-11-14) to see a GIF play
// when he hovers it, before he sends it. What has to stay true:
//
//   1. A SWEEP across the grid fetches no animation: the mouse passes each
//      tile in well under the 150 ms wait.
//   2. A mouse that RESTS on a tile animates that tile and no other. The
//      animation sits exactly over the still, and the tile keeps its height.
//   3. The preview follows the mouse to the next tile, and goes when the mouse
//      leaves the grid.
//   4. KEYBOARD focus previews the focused tile.
//   5. A click still picks, and the picked GIF animates above the message.
//   6. PHONE (390×844, touch): a finger held on a tile previews nothing, and
//      the tap still picks.
//
// Only `/api/*` is stubbed — the album, its value block, the GIF search. The
// GIF files load from GIPHY's real CDN, so the loads and sizes are real.
// Signed out, no wallet, nothing sent: nothing is paid and no note is signed.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// Real GIPHY ids, from a public search on 2026-11-14.
const IDS = [
  '1VQr7rkEjsLXG', '26tk1XKMCydK3Eb5K', '3oKHWmJxiPdqZjthp6', 'HXPTVAGwSfuHuDFGtQ',
  'ImmvMbR1l9OHPz2wrC', 'K5Jydr81T7DVwRyaIj', 'KJjVPma0lFzl03HErv', '52015TH7iKpXW3YhBl',
];
const GUID = 'c1f40000-0000-4000-8000-000000000001';
const ID = 900777;
const RECIPIENTS = [{ name: 'E2E stub node', type: 'node', address: `02${'ab'.repeat(32)}`, split: 100 }];
const VALUE = { model: { type: 'lightning', method: 'keysend' }, recipients: RECIPIENTS };
const ALBUM = {
  id: ID, podcastGuid: GUID, title: 'E2E GIF Album', author: 'e2e', medium: 'music',
  url: 'https://feeds.example.invalid/gif.xml', value: VALUE,
};
const TRACKS = [0, 1].map((k) => ({
  id: 9800 + k, guid: `c1f40000-0000-4000-8000-00000000010${k}`, podcastGuid: GUID, feedId: ID,
  title: `GIF test track ${k}`, episode: k + 1, duration: 30,
  enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`, value: VALUE,
}));

function answer(pathname) {
  if (pathname === '/api/by-guid') return { podcast: ALBUM };
  if (pathname === '/api/feed') return { podcast: ALBUM, episodes: TRACKS };
  if (pathname === '/api/item-value') {
    return { read: true, value: { type: 'lightning', method: 'keysend', recipients: RECIPIENTS }, valueTimeSplits: [] };
  }
  if (pathname === '/api/gifs') return { gifs: IDS.map((id, i) => ({ id, title: `e2e gif ${i}` })) };
  if (pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}

const { page } = await launchChrome({ name: 'gifhover', args: ['--disable-gpu'] });
const { send, js, until, on } = page;
const t = checker();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

// Every animated-rendition request the page makes, and how each one ended.
const anim = new Map(); // requestId -> { id, end: 'finished' | 'canceled' | 'failed' | null }
const animFor = (id) => [...anim.values()].filter((a) => a.id === id);
const pageErrors = [];

await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    const mm = /\/media\/([A-Za-z0-9]+)\/200w\.webp$/.exec(m.params.request.url);
    if (mm) anim.set(m.params.requestId, { id: mm[1], end: null });
    return;
  }
  if (m.method === 'Network.loadingFinished' && anim.has(m.params.requestId)) {
    anim.get(m.params.requestId).end = 'finished';
    return;
  }
  if (m.method === 'Network.loadingFailed' && anim.has(m.params.requestId)) {
    anim.get(m.params.requestId).end = m.params.canceled ? 'canceled' : 'failed';
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  try {
    if (u.pathname.startsWith('/api/nostr/')) {
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      return;
    }
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: b64(answer(u.pathname)),
    });
  } catch {
    // The page navigated away under a paused request.
  }
});
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// Every hover must reach the network, or a cached file would hide a fetch.
await send('Network.setCacheDisabled', { cacheDisabled: true });

const section = (s) => console.log(`\n${s}`);
const clickButton = (re) => js(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => ${re}.test(x.innerText) && !x.disabled);
  if (!b) return false;
  b.click();
  return true;
})()`);
const mouseTo = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
/** Each grid tile: its GIPHY id, its centre and its height, in DOM order. */
const tiles = () => js(`[...document.querySelectorAll('img[src$="/200w_s.gif"]')].map((i) => {
  const r = i.closest('button').getBoundingClientRect();
  return { id: i.src.split('/').at(-2), x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height };
})`);
/** Every preview in the DOM, measured against the still under it. */
const previews = () => js(`[...document.querySelectorAll('[data-gif-preview]')].map((p) => {
  const s = p.parentElement.querySelector('img:not([data-gif-preview])');
  const a = p.getBoundingClientRect(), b = s.getBoundingClientRect();
  const near = (u, v) => Math.abs(u - v) < 0.5;
  return {
    id: p.src.split('/').at(-2), file: p.src.split('/').at(-1),
    overStill: near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height),
    loaded: p.complete && p.naturalWidth > 0,
  };
})`);
const searchBox = () => js(`(() => {
  const r = document.querySelector('input[type="search"]')?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
})()`);
const pickedId = () => js(`document.querySelector('img[alt="The GIF this boost will carry"]')?.src.split('/').at(-2) ?? null`);

async function openPicker() {
  const offered = await until(`[...document.querySelectorAll('button')].some((b) => /add a gif/i.test(b.innerText) && !b.disabled)`, 20000);
  const shown = offered ? '' : await js(`[...document.querySelectorAll('[role="dialog"]')].map((d) => d.innerText).join(' | ').replace(/\\s+/g, ' ').slice(0, 600)`);
  t.ok('the boost modal offers + Add a GIF', offered, `the dialog shows: ${shown}`);
  if (!offered) await exit(1);
  await clickButton('/add a gif/i');
  const n = IDS.length;
  t.ok(`the picker shows ${n} stills`, await until(
    `document.querySelectorAll('img[src$="/200w_s.gif"]').length === ${n}
      && [...document.querySelectorAll('img[src$="/200w_s.gif"]')].slice(0, 4).every((i) => i.complete && i.naturalWidth > 0)`,
    20000,
  ));
}

// --- Desktop ---------------------------------------------------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
section('0. Open the boost modal and the GIF picker (desktop, 1280×900)');
t.ok('the album offers BOOST', await until(`!!document.querySelector('button[aria-label="Boost this track"]')`, 90000));
await js(`document.querySelector('button[aria-label="Boost this track"]').click()`);
await openPicker();
t.equal('no tile is animated when the grid opens', await previews(), []);

const box = await searchBox();
await mouseTo(box.x, box.y);
const grid = await tiles();

section('1. A sweep across the grid fetches no animation');
{
  const before = anim.size;
  for (const g of grid) {
    await mouseTo(g.x, g.y);
    await wait(30);
  }
  await mouseTo(box.x, box.y);
  await wait(500);
  t.equal('no animated file was asked for', anim.size - before, 0);
  t.equal('no tile is animated after the sweep', await previews(), []);
}

section('2. A mouse that rests on a tile animates that tile only');
{
  const g = grid[0];
  await mouseTo(g.x, g.y);
  t.equal('nothing animates before the wait ends', await previews(), []);
  t.ok('the tile animates once the mouse rests', await until(`(() => {
    const p = document.querySelectorAll('[data-gif-preview]');
    return p.length === 1 && p[0].complete && p[0].naturalWidth > 0;
  })()`, 15000));
  const p = await previews();
  t.equal('exactly one preview, on the tile under the mouse', p.map((x) => x.id), [g.id]);
  t.equal('it is the animated 200w.webp', p[0]?.file, '200w.webp');
  t.ok('it covers the still exactly', p[0]?.overStill, JSON.stringify(p));
  const after = (await tiles()).find((x) => x.id === g.id);
  t.equal('the tile keeps its height', Math.round(after.h), Math.round(g.h));
  t.equal('one request for that tile', animFor(g.id).length, 1);
}

section('3. The preview follows the mouse, and goes when it leaves the grid');
{
  const g = grid[1];
  await mouseTo(g.x, g.y);
  t.ok('the next tile animates', await until(`(() => {
    const p = [...document.querySelectorAll('[data-gif-preview]')];
    return p.length === 1 && p[0].src.includes(${JSON.stringify(`/${g.id}/`)});
  })()`, 5000));
  t.equal('still only one preview', (await previews()).length, 1);
  await mouseTo(box.x, box.y);
  t.ok('the mouse off the grid: no preview', await until(`!document.querySelector('[data-gif-preview]')`, 3000));
}

section('3b. Observation: does an unmounted preview cancel its fetch?');
{
  const g = grid[7] ?? grid.at(-1); // the 870 KB one, so the fetch is still running at 200 ms
  await mouseTo(g.x, g.y);
  await wait(200);
  await mouseTo(box.x, box.y);
  await wait(4000);
  const ends = animFor(g.id).map((a) => a.end);
  console.log(`  info the preview was removed ~50 ms into its fetch; the fetch ended: ${JSON.stringify(ends)}`);
}

section('4. Keyboard focus previews the focused tile');
{
  await js(`document.querySelector('input[type="search"]').focus()`);
  const tab = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  };
  await tab();
  const focused = await js(`document.activeElement?.querySelector('img[src$="/200w_s.gif"]')?.src.split('/').at(-2) ?? null`);
  t.equal('Tab from the search box focuses the first tile', focused, grid[0].id);
  t.ok('the focused tile animates', await until(`(() => {
    const p = [...document.querySelectorAll('[data-gif-preview]')];
    return p.length === 1 && p[0].src.includes(${JSON.stringify(`/${grid[0].id}/`)});
  })()`, 5000));
  await tab();
  t.ok('Tab again: the next tile animates instead', await until(`(() => {
    const p = [...document.querySelectorAll('[data-gif-preview]')];
    return p.length === 1 && p[0].src.includes(${JSON.stringify(`/${grid[1].id}/`)});
  })()`, 5000));
  await js(`document.activeElement.blur()`);
  t.ok('focus gone: no preview', await until(`!document.querySelector('[data-gif-preview]')`, 3000));
}

section('5. A click still picks');
{
  const g = grid[3];
  await mouseTo(g.x, g.y);
  await wait(300);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', clickCount: 1 });
  t.ok('the picker closes', await until(`!document.querySelector('input[type="search"]')`, 5000));
  t.ok('the picked GIF shows above the message', await until(`document.querySelector('img[alt="The GIF this boost will carry"]')?.src.includes(${JSON.stringify(`/${g.id}/200w.webp`)})`, 5000));
  t.equal('it is the tile that was clicked', await pickedId(), g.id);
}

// --- Phone -----------------------------------------------------------------------
section('6. PHONE (390×844, touch): a held finger previews nothing; the tap picks');
{
  await clickButton('/remove gif/i');
  await mouseTo(-1, -1);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await wait(500);
  await openPicker();
  await js(`(() => {
    window.__previewSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-gif-preview]')) window.__previewSeen = true;
    }).observe(document.body, { subtree: true, childList: true });
  })()`);
  const g = (await tiles())[2];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g.x, y: g.y }] });
  await wait(600);
  t.equal('a finger held 600 ms on a tile: no preview', await previews(), []);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  t.ok('the tap picks the GIF', await until(`document.querySelector('img[alt="The GIF this boost will carry"]')?.src.includes(${JSON.stringify(`/${g.id}/`)})`, 5000));
  t.equal('no preview appeared at any time', await js('window.__previewSeen'), false);
  const w = await js(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`);
  t.ok('no sideways overflow at 390', w && w[0] <= w[1], JSON.stringify(w));
}

if (pageErrors.length) console.log(`\n  info page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
console.log(`\n${t.count - t.fails}/${t.count} checks passed`);
await exit(t.fails ? 1 : 0);
