// e2e:moved — a favorite whose feed host closed, end to end in a real browser.
//
//   npm run dev            # in another terminal
//   npm run e2e:moved      # --headed to watch, --keep to leave Chrome open
//
// No real account: a throwaway key signs through a CDP binding (the
// e2e-favorites.mjs pattern) and the list lives in an in-memory local relay.
// Feed reads still reach the PUBLIC Podcast Index through the dev server, so
// this pins real data from 2026-11-14 — RSS Blue closed, and:
//   Worried        7153bbb0… dead 7101864 → live Fountain 7520866, SAME guid
//   Mr. Videoman   f842b7c8… → Fountain 9b2014ae… and Wavlake a6eb05db…, NEW guids
//   Runaway Train  25e0c184… → Fountain 5d6cff48…, NEW guid
//   Homegrown Hits ac746d09… → a healthy control
// If an artist moves again, the expectations here move with them.
//
// See docs/superpowers/specs/2026-11-14-moved-feeds-design.md.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import WebSocket from 'ws';

const APP = 'http://localhost:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

const WORRIED = '7153bbb0-b8c4-521f-80c0-cef62d8ef67b';
const WORRIED_ITEM = '405be9f7-684f-54b8-9035-009111f1933f';
const MRV = 'f842b7c8-9f12-54f2-a0b8-4f95c63dad4c';
const MRV_ITEM = 'ec6d696b-a580-5fdd-9049-a977501cb012';
const MRV_FOUNTAIN = '9b2014ae-ca84-552d-9283-8510b686adc7';
const MRV_FOUNTAIN_ITEM = '3f4b6d0d-4d92-4caa-b170-ff4950f6db17';
const RUNAWAY = '25e0c184-6ae9-541d-b756-1c8816c2cb59';
const HOMEGROWN = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';
const NO_COPY = '6a5d604b-8f89-5664-b603-18472947e530'; // Where Does the Time Go (Prelude), Herbivore: RSS Blue only
const g = (feed, item) => (item ? ['i', `podcast:guid:${feed}`, `podcast:item:guid:${item}`] : ['i', `podcast:guid:${feed}`]);

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);

const published = [];
const relay = createRelay({ port: 0, log: null, onEvent: (e) => { if (e.kind === 10333) published.push(e); } });
const PORT = await relay.ready;
const seed = finalizeEvent({
  kind: 10333,
  created_at: Math.floor(Date.now() / 1000) - 120,
  tags: [
    ['alt', 'PC 2.0 Favorites'], ['visibility', 'public'],
    g(WORRIED), g(MRV), g(RUNAWAY), g(HOMEGROWN), g(NO_COPY),
    g(WORRIED, WORRIED_ITEM), g(MRV, MRV_ITEM),
  ],
  content: '',
}, sk);
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify(['EVENT', seed])));
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d[0] !== 'OK') return;
    ws.close();
    if (d[2]) resolve();
    else reject(new Error(d[3]));
  });
  ws.on('error', reject);
});
published.length = 0; // the seed is not the app's publish

const { page } = await launchChrome({ name: 'moved', args: ['--disable-gpu', '--window-size=1280,900'] });
const { send } = page;
const js = page.jsOrThrow;
await send('Page.enable');
await send('Runtime.enable');
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  if (fn === 'getPublicKey') out = pk;
  else if (fn === 'signEvent') out = finalizeEvent(args[0], sk);
  else err = `not needed by this test: ${fn}`;
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const w = new Map(); let n = 0;
  window.__bmbResolve = (rid, r) => { const p = w.get(rid); w.delete(rid); r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
  const call = (fn, ...args) => new Promise((resolve, reject) => { const rid = 'r' + (++n); w.set(rid, { resolve, reject }); window.bmbSigner(JSON.stringify({ rid, fn, args })); });
  window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => call('signEvent', e),
    nip44: { encrypt: (p, t) => call('nip44.encrypt', p, t), decrypt: (p, c) => call('nip44.decrypt', p, c) },
    nip04: { encrypt: (p, t) => call('nip04.encrypt', p, t), decrypt: (p, c) => call('nip04.decrypt', p, c) } };
})();` });

await send('Page.navigate', { url: APP });
await wait(3000);
await js(`(() => { localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:fav_privacy:' + ${JSON.stringify(npub)}, 'public');
  return 1; })()`);

/** Every row on /favorites: its title, the cover's state and src, and its footer text and buttons. */
const readRows = () => js(`(() => [...document.querySelectorAll('main li')].flatMap((li) => {
  const title = li.querySelector('.font-display.text-base')?.textContent?.trim();
  if (!title) return [];
  const img = li.querySelector('img[class*="w-14"]');
  const foot = li.querySelector('.basis-full');
  return [{
    title,
    src: img ? decodeURIComponent(img.getAttribute('src') || '') : null,
    loaded: img ? img.complete && img.naturalWidth > 0 : false,
    footer: foot ? foot.textContent.trim() : null,
    buttons: foot ? [...foot.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), w: r.width, h: r.height }; }) : [],
  }];
}))()`);
const rowOf = (rows, re) => rows.find((r) => re.test(r.title));
async function settle(ms) {
  await wait(ms);
  // Lazy covers load only near the viewport: walk the page once.
  const h = await js('document.documentElement.scrollHeight');
  for (let y = 0; y < h; y += 600) { await js(`window.scrollTo(0, ${y}); 1`); await wait(250); }
  await js('window.scrollTo(0, 0); 1');
  await wait(2500);
}

const t = checker();

console.log('\n1. a fresh device');
// The FIRST /api/moved for Mr. Videoman is answered 429 here, the way Podcast
// Index throttles a burst (measured 2026-11-14: one throttled load used to hide
// every offer for the life of the tab). The row must retry and still offer.
let throttled = 0;
// The app's service worker (app/sw.js) would otherwise make this request itself,
// out of the page's sight, and the interception below would never see it.
await send('Network.enable');
await send('Network.setBypassServiceWorker', { bypass: true });
await send('Fetch.enable', { patterns: [{ urlPattern: '*api/moved*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  if (throttled === 0 && request.url.includes(MRV)) {
    throttled++;
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: 429,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from('{"error":"rate limited"}').toString('base64'),
    });
    return;
  }
  await send('Fetch.continueRequest', { requestId });
});
await send('Page.navigate', { url: `${APP}/favorites` });
await settle(25000);
// The retry lands ~20 s after the throttled answer: wait for it, bounded.
for (let i = 0; i < 40; i++) {
  const r = rowOf(await readRows(), /^Mr\.? Videoman$/);
  if (/Found:/.test(r?.footer ?? '')) break;
  await wait(1000);
}
let rows = await readRows();
t.equal('the first offer request was throttled', throttled, 1);
if (process.env.MOVED_DEBUG) console.log(JSON.stringify(rows.filter((r) => /Videoman|Runaway|Worried/.test(r.title)), null, 1));
const worried = rowOf(rows, /^Worried$/);
t.ok('Worried is listed', worried, JSON.stringify(rows.map((r) => r.title)));
t.ok('Worried shows the Fountain cover', /feeds\.fountain\.fm/.test(worried?.src ?? ''), worried?.src);
t.ok('the Fountain cover loaded', worried?.loaded, JSON.stringify(worried));
t.equal('Worried offers nothing: it was followed', worried?.footer ?? null, null);
const mrv = rowOf(rows, /^Mr\.? Videoman$/);
t.ok('Mr. Videoman says where it went', /RSS Blue closed\. Found:/.test(mrv?.footer ?? ''), mrv?.footer);
t.equal('two copies offered', (mrv?.buttons ?? []).length, 2);
t.ok('each REPLACE is at least 24×24 CSS px', (mrv?.buttons ?? []).every((b) => b.w >= 24 && b.h >= 24), JSON.stringify(mrv?.buttons));
const runaway = rowOf(rows, /^Runaway Train$/);
t.equal('Runaway Train offers its one copy', (runaway?.buttons ?? []).length, 1);
const hh = rowOf(rows, /^Homegrown Hits$/);
t.ok('Homegrown Hits is listed', hh, '');
t.equal('the healthy control offers nothing', hh?.footer ?? null, null);

// Closed-host rows sit in ONE section at the top (Chad, 2026-11-14).
const sections = await js(`(() => [...document.querySelectorAll('main section')].map((s) => ({
  heading: (s.querySelector('[aria-controls]')?.textContent || '').trim(),
  titles: [...s.querySelectorAll('li')].map((li) => li.querySelector('.font-display.text-base')?.textContent?.trim()).filter(Boolean),
})).filter((s) => s.heading))()`);
const closedIdx = sections.findIndex((s) => /^RSS Blue closed/.test(s.heading));
const firstList = sections.findIndex((s) => s.titles.length > 0);
t.ok('an "RSS Blue closed" section exists', closedIdx >= 0, JSON.stringify(sections.map((s) => s.heading)));
t.equal('it is the first list on the page', closedIdx, firstList);
const closedTitles = sections[closedIdx]?.titles ?? [];
t.ok('it holds the moved and the dead albums', ['Mr. Videoman', 'Runaway Train', 'Where Does the Time Go (Prelude)'].every((x) => closedTitles.includes(x)), JSON.stringify(closedTitles));
t.ok('a followed album (Worried) is not in it', !closedTitles.includes('Worried'), JSON.stringify(closedTitles));
t.ok('the closed rows are not listed twice', sections.filter((s) => s.titles.includes('Runaway Train')).length === 1, JSON.stringify(sections));

const gone = rowOf(rows, /^Where Does the Time Go \(Prelude\)$/);
t.ok('an album with no copy says so', /RSS Blue closed — no copy found\./.test(gone?.footer ?? ''), gone?.footer);
t.equal('and offers REMOVE', (gone?.buttons ?? []).length, 1);
t.ok('REMOVE is at least 24×24 CSS px', (gone?.buttons ?? []).every((b) => b.w >= 24 && b.h >= 24), JSON.stringify(gone?.buttons));

console.log('\n2. phone width');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await wait(1500);
const fit = await js('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })');
t.ok('no horizontal overflow at 390px', fit.sw <= fit.cw, JSON.stringify(fit));
rows = await readRows();
const mrvPhone = rowOf(rows, /^Mr\.? Videoman$/);
t.ok('REPLACE keeps 24×24 at 390px', (mrvPhone?.buttons ?? []).length === 2 && mrvPhone.buttons.every((b) => b.w >= 24 && b.h >= 24), JSON.stringify(mrvPhone?.buttons));
await send('Emulation.clearDeviceMetricsOverride');
await wait(1000);

console.log('\n3. REPLACE');
const before = published.length;
const clicked = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Replace with Mr\\.? Videoman on Fountain$/.test(x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true; })()`);
t.ok('pressed REPLACE on the Fountain copy', clicked, '');
for (let i = 0; i < 40 && published.length === before; i++) await wait(500);
const last = published[published.length - 1];
t.ok('a kind:10333 reached the relay', published.length > before, `published ${published.length}, before ${before}`);
const tags = (last?.tags ?? []).map((x) => x.join(' '));
const has = (feed, item) => tags.includes(g(feed, item).join(' '));
t.ok('the new album is on the list', has(MRV_FOUNTAIN), JSON.stringify(tags));
t.ok('the dead album is off the list', !has(MRV), JSON.stringify(tags));
const movedTrack = tags.some((x) => x.startsWith(`i podcast:guid:${MRV_FOUNTAIN} podcast:item:guid:`));
t.ok('the favorited track moved, or stayed under the old guid — never dropped', movedTrack !== has(MRV, MRV_ITEM), JSON.stringify(tags));
// "Mr. Videoman" on RSS Blue is "Mr Videoman" on Fountain: the title match is
// normalized, so this one must move.
t.ok('the favorited track moved to the Fountain copy', has(MRV_FOUNTAIN, MRV_FOUNTAIN_ITEM) && !has(MRV, MRV_ITEM), JSON.stringify(tags));
t.ok('Worried is untouched', has(WORRIED) && has(WORRIED, WORRIED_ITEM), JSON.stringify(tags));
t.ok('Runaway Train and Homegrown Hits are untouched', has(RUNAWAY) && has(HOMEGROWN), JSON.stringify(tags));
await wait(2000);
rows = await readRows();
const newRow = rowOf(rows, /^Mr\.? Videoman$/);
t.ok('the new row says what happened', /^Replaced from RSS Blue\./.test(newRow?.footer ?? ''), newRow?.footer);
t.ok('the new row shows a Fountain cover', /feeds\.fountain\.fm/.test(newRow?.src ?? ''), newRow?.src);

console.log('\n3b. REMOVE on an album with no copy');
const beforeRemove = published.length;
const removed = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Remove this favorite/.test(x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true; })()`);
t.ok('pressed REMOVE', removed, '');
for (let i = 0; i < 40 && published.length === beforeRemove; i++) await wait(500);
const afterRemove = (published[published.length - 1]?.tags ?? []).map((x) => x.join(' '));
t.ok('a kind:10333 reached the relay', published.length > beforeRemove, '');
t.ok('the dead album is off the list', !afterRemove.includes(g(NO_COPY).join(' ')), JSON.stringify(afterRemove));
t.ok('everything else stayed', afterRemove.includes(g(WORRIED).join(' ')) && afterRemove.includes(g(HOMEGROWN).join(' ')), JSON.stringify(afterRemove));

console.log('\n4. a device whose cache still holds the dead Worried');
await js(`(() => {
  const key = 'bmb:favorites:' + ${JSON.stringify(npub)};
  const favs = JSON.parse(localStorage.getItem(key) || '{}');
  const w = favs[${JSON.stringify(WORRIED)}];
  if (!w) return 'no row';
  const dead = 'https://media.rssblue.com/podcasts/worried/cover-art.worried-artwork.jpg';
  favs[${JSON.stringify(WORRIED)}] = { ...w, id: 7101864, url: 'https://feeds.rssblue.com/worried', image: dead, artwork: dead };
  localStorage.setItem(key, JSON.stringify(favs));
  const pkey = 'bmb:pmeta:' + ${JSON.stringify(WORRIED)};
  const cell = JSON.parse(localStorage.getItem(pkey) || 'null');
  if (cell && cell.v) { cell.v = { ...cell.v, id: 7101864, url: 'https://feeds.rssblue.com/worried', image: dead, artwork: undefined }; localStorage.setItem(pkey, JSON.stringify(cell)); }
  return 'planted';
})()`);
await send('Page.navigate', { url: `${APP}/favorites` });
await settle(15000);
rows = await readRows();
const worried2 = rowOf(rows, /^Worried$/);
t.ok('a stale dead row switches to the Fountain cover after one load', /feeds\.fountain\.fm/.test(worried2?.src ?? ''), worried2?.src);
const stored = await js(`JSON.parse(localStorage.getItem('bmb:favorites:' + ${JSON.stringify(npub)}) || '{}')[${JSON.stringify(WORRIED)}]?.id`);
t.equal('and the cache now holds the live copy', stored, 7520866);

relay.close?.();
console.log(`\n${t.count - t.fails}/${t.count} ok`);
await exit(t.fails ? 1 : 0);
