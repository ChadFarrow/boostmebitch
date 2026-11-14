// End-to-end for the GIF picker's playing grid and its two sources
// (docs/money-boosts.md, "A GIF on a boost"; design:
// docs/superpowers/specs/2026-11-14-gif-video-grid-design.md).
//
// Usage:
//   npm run e2e:gifgrid -- --pure                 # section 0 only: no server, no browser
//   npm run dev                                   # in another terminal, then:
//   npm run e2e:gifgrid
//   APP_URL=http://127.0.0.1:3047 npm run e2e:gifgrid -- --headed --keep
//
// WHAT IT PINS. boostmebitch.com searches gifs.nostr.build from the browser;
// boostmebuddy.com searches GIPHY through /api/gifs. Both draw the same grid:
// every GIF near the screen holds a <video> from one page-wide pool and plays
// while it is on screen (nostr.build's grid rules — an animated <img> per tile
// freezes iPhone Safari at 512 threads). Every URL the page renders is rebuilt
// from a validated key, never copied from an API answer.
//
// Section 0 runs the pure modules under plain Node. It is here and not in a
// `check:*` script only because CLAUDE.md, which indexes every check script,
// has no words to spare.
//
// The fixture (scripts/fixtures/gifs-nostr-build.json) is two real answers
// recorded on 2026-11-14 from a page on 127.0.0.1 (the API's development
// client), `tags` removed, plus a synthetic `bad` list.

import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

register('./e2e-resolve-hook.mjs', import.meta.url);

const PURE_ONLY = process.argv.includes('--pure');
const FIX = JSON.parse(readFileSync(new URL('./fixtures/gifs-nostr-build.json', import.meta.url), 'utf8'));
const t = checker();
const section = (s) => console.log(`\n${s}`);

// --- 0. Pure --------------------------------------------------------------------
section('0. Pure: keys, URLs, parsers, tiles');
const nb = await import('../lib/gifs/nostr-build.ts');
const pk = await import('../lib/gifs/pick.ts');
const gp = await import('../lib/giphy.ts');

const B = 'https://gifs.nostr.build';
{
  const kept = nb.parseNbResults(FIX.applause);
  t.ok('a real answer keeps 39 of 40 or more', kept.length >= 39, `kept ${kept.length}`);
  t.ok('every kept key passes isNbKey', kept.every((r) => nb.isNbKey(r.key)));
  const odd = FIX.applause.items.find((g) => g.url !== `${B}/${g.id}`);
  const oddKept = kept.find((r) => r.title === (odd?.title ?? '').trim().slice(0, 120));
  t.equal('a result whose id differs from its file keeps the FILE key',
    oddKept?.key, odd?.url.split('/').at(-1));
  const tile = pk.nbTile(kept[0]);
  t.equal('nbTile builds every URL from the key', [tile.mp4, tile.animated, tile.still], [
    `${B}/mp4/orig/${kept[0].key}`, `${B}/anim/w240/${kept[0].key}`, `${B}/still/w240/${kept[0].key}`,
  ]);
}
{
  const kept = nb.parseNbResults(FIX.bad);
  const titles = kept.map((r) => r.title);
  t.ok('a foreign-host url is dropped', !titles.includes('foreign host url'), JSON.stringify(titles));
  t.ok('an mp4 with # is dropped', !titles.includes('hash in mp4'));
  t.ok('a url/mp4 key mismatch is dropped', !titles.includes('url mp4 mismatch'));
  t.equal('a javascript: lqip becomes null', kept.find((r) => r.title === 'javascript lqip')?.lqip, null);
  const tr = kept.find((r) => r.title === 'transparent');
  t.equal('a transparent item keeps webm and hevc', [tr?.webm, tr?.hevc, tr?.transparent], [
    `${B}/webm/orig/${'8'.repeat(64)}.gif`, `${B}/hevc/orig/${'8'.repeat(64)}.gif`, true,
  ]);
  t.equal('a foreign webm becomes null, the item stays', kept.find((r) => r.title === 'foreign webm')?.webm, null);
  t.equal('extreme sizes are kept as given', ['very wide', 'very tall'].map((n) => {
    const r = kept.find((x) => x.title === n);
    return r && [r.width, r.height];
  }), [[1000, 50], [50, 1000]]);
  t.equal('a non-array answer parses to nothing', nb.parseNbResults({ items: 'x' }), []);
}
{
  t.equal('normalizeNbQuery trims, collapses and lowercases', nb.normalizeNbQuery('  Cat   Videos '), 'cat videos');
  t.equal('one Latin letter is not a search', nb.normalizeNbQuery('a'), null);
  t.equal('an emoji alone is a search', nb.normalizeNbQuery('😂'), '😂');
  t.equal('an empty box is not a search', nb.normalizeNbQuery('   '), null);
  t.equal('600 characters are cut to 500 code points', [...nb.normalizeNbQuery('x'.repeat(600))].length, 500);
  t.equal('the cut never splits an emoji', nb.normalizeNbQuery('😂'.repeat(600)), '😂'.repeat(500));
  const u = new URL(nb.nbSearchUrl('cat videos'));
  t.equal('nbSearchUrl asks /api/v1/search with q and limit=200 only',
    [u.origin + u.pathname, u.searchParams.get('q'), u.searchParams.get('limit'), [...u.searchParams.keys()].length],
    [`${B}/api/v1/search`, 'cat videos', '200', 2]);
  t.equal('NB_BROWSE_URL is the daily reaction list', nb.NB_BROWSE_URL, `${B}/api/v1/gifs?kind=reaction&limit=200`);
}
{
  const key = `${'a'.repeat(64)}.gif`;
  t.equal('the nostr.build wire URL', pk.gifWireUrl({ src: 'nostrbuild', key }), `${B}/${key}`);
  t.equal('the GIPHY wire URL', pk.gifWireUrl({ src: 'giphy', id: '1VQr7rkEjsLXG' }),
    'https://media.giphy.com/media/1VQr7rkEjsLXG/giphy.gif');
  t.equal('a nostr.build wire line reads back', pk.gifPickFromWireLine(`${B}/${key}`), { src: 'nostrbuild', key });
  t.equal('a GIPHY wire line reads back', pk.gifPickFromWireLine('https://media.giphy.com/media/1VQr7rkEjsLXG/giphy.gif'),
    { src: 'giphy', id: '1VQr7rkEjsLXG' });
  t.equal('a preview URL is not a wire line', pk.gifPickFromWireLine(`${B}/still/w240/${key}`), null);
  t.equal('another host is not a wire line', pk.gifPickFromWireLine(`https://evil.example/${key}`), null);
  t.equal('trailing text is not a wire line', pk.gifPickFromWireLine(`${B}/${key} hi`), null);
  t.equal('gifPreviewUrl is the animated rendition', [
    pk.gifPreviewUrl({ src: 'nostrbuild', key }), pk.gifPreviewUrl({ src: 'giphy', id: '1VQr7rkEjsLXG' }),
  ], [`${B}/anim/w240/${key}`, 'https://media.giphy.com/media/1VQr7rkEjsLXG/200w.webp']);
  t.equal('gifPickKey names the source and the key', [
    pk.gifPickKey({ src: 'nostrbuild', key }), pk.gifPickKey({ src: 'giphy', id: 'abcd' }),
  ], [`nostrbuild:${key}`, 'giphy:abcd']);
}
{
  const rows = gp.parseGiphyResults({ data: [
    { id: '1VQr7rkEjsLXG', title: 'a', images: { fixed_width: { width: '200', height: '146' } } },
    { id: 'HXPTVAGwSfuHuDFGtQ', title: 'b', images: { original: { width: '480', height: '270' } } },
    { id: 'K5Jydr81T7DVwRyaIj', title: 'c' },
    { id: 'KJjVPma0lFzl03HErv', title: 'd', images: { fixed_width: { width: '-3', height: 'x' } } },
  ] });
  t.equal('GIPHY sizes: fixed_width, else original, else null', rows.map((r) => [r.id, r.width, r.height]), [
    ['1VQr7rkEjsLXG', 200, 146], ['HXPTVAGwSfuHuDFGtQ', 480, 270], ['K5Jydr81T7DVwRyaIj', null, null],
    ['KJjVPma0lFzl03HErv', null, null],
  ]);
  const tile = pk.giphyTile(rows[2]);
  t.equal('a GIPHY tile with no size is a 200×200 square', [tile.width, tile.height], [200, 200]);
  t.equal('a GIPHY tile plays 200w.mp4 and falls back to 200w.webp, 200w_s.gif',
    [tile.mp4, tile.animated, tile.still, tile.alpha, tile.lqip], [
      `https://media.giphy.com/media/${rows[2].id}/200w.mp4`, `https://media.giphy.com/media/${rows[2].id}/200w.webp`,
      `https://media.giphy.com/media/${rows[2].id}/200w_s.gif`, null, null,
    ]);
}

if (PURE_ONLY) {
  console.log(`\n${t.count - t.fails}/${t.count} checks passed`);
  await exit(t.fails ? 1 : 0);
}

// --- The browser ----------------------------------------------------------------
// Installed Chrome (it plays H.264; Playwright's builds do not). Only `/api/*`
// is stubbed — an album with a value block, so BOOST opens, and the GIF search.
// The GIF files come from the real CDNs.
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// 56 real GIPHY ids with their real 200w sizes (scripts/fixtures/gifs-giphy.json).
// Three sizes are changed HERE, so the layout is shown to come from the data
// and never from the media: the real files are all 200 px wide.
const GIPHY = JSON.parse(readFileSync(new URL('./fixtures/gifs-giphy.json', import.meta.url), 'utf8')).gifs
  .map((g, i) => (i === 0 ? { ...g, width: 1000, height: 50 } : i === 1 ? { ...g, width: 50, height: 1000 }
    : i === 2 ? { ...g, width: 200, height: 250 } : g));

const GUID = 'c1f40000-0000-4000-8000-000000000002';
const ID = 900778;
const RECIPIENTS = [{ name: 'E2E stub node', type: 'node', address: `02${'ab'.repeat(32)}`, split: 100 }];
const VALUE = { model: { type: 'lightning', method: 'keysend' }, recipients: RECIPIENTS };
const ALBUM = {
  id: ID, podcastGuid: GUID, title: 'E2E GIF Grid Album', author: 'e2e', medium: 'music',
  url: 'https://feeds.example.invalid/gifgrid.xml', value: VALUE,
};
const TRACKS = [0, 1].map((k) => ({
  id: 9810 + k, guid: `c1f40000-0000-4000-8000-00000000020${k}`, podcastGuid: GUID, feedId: ID,
  title: `GIF grid track ${k}`, episode: k + 1, duration: 30,
  enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`, value: VALUE,
}));
/** A different order per query, so ten searches mount and release real tiles. */
const giphyAnswer = (q) => {
  const n = [...q].reduce((s, c) => s + c.charCodeAt(0), 0) % GIPHY.length;
  return { gifs: q ? [...GIPHY.slice(n), ...GIPHY.slice(0, n)].slice(0, 50) : GIPHY.slice(0, 50) };
};
function answer(u) {
  if (u.pathname === '/api/by-guid') return { podcast: ALBUM };
  if (u.pathname === '/api/feed') return { podcast: ALBUM, episodes: TRACKS };
  if (u.pathname === '/api/item-value') {
    return { read: true, value: { type: 'lightning', method: 'keysend', recipients: RECIPIENTS }, valueTimeSplits: [] };
  }
  if (u.pathname === '/api/gifs') return giphyAnswer(u.searchParams.get('q') ?? '');
  if (u.pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}

// 30 s of silence for section 3's track (/api/e2e-audio.wav), as e2e-dead-track.
function silentWav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const AUDIO = silentWav(30);
async function answerAudio(requestId, request) {
  const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
  const mm = range && /bytes=(\d+)-(\d*)/.exec(range);
  const start = mm ? Number(mm[1]) : 0;
  const end = mm && mm[2] ? Math.min(Number(mm[2]), AUDIO.length - 1) : AUDIO.length - 1;
  const body = AUDIO.subarray(start, end + 1);
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: mm ? 206 : 200,
    responseHeaders: [
      { name: 'content-type', value: 'audio/wav' },
      { name: 'accept-ranges', value: 'bytes' },
      { name: 'content-length', value: String(body.length) },
      ...(mm ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
    ],
    body: body.toString('base64'),
  });
}

// `autoplay` so section 3's track plays from a scripted click.
const { page } = await launchChrome({ name: 'gifgrid', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until, on } = page;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const media = []; // every GIF file the page asked for: { host, id, file }
const pageErrors = [];
// gifs.nostr.build's API, answered from the fixture. `nbStub.mode` makes it
// rate-limit (429) or drop the connection; `nbStub.slow` delays one query;
// `nbStub.failWebm` fails every transparent GIF's WebM.
const nbStub = { log: [], mode: 'ok', slow: {}, failWebm: false, heads: [], gets: [], headInFlight: 0, headMax: 0 };
const nbAnswer = (u) => (u.pathname === '/api/v1/gifs' ? FIX.chibi : FIX[u.searchParams.get('q') ?? ''] ?? FIX.applause);
// `--real-nb`: pass gifs.nostr.build's API through to the real service. The
// page is on 127.0.0.1, the API's shared development client, so it is admitted
// without a registration. Only section 2r runs then.
const REAL_NB = process.argv.includes('--real-nb');
async function answerNb(requestId, request, u) {
  if (REAL_NB) { await send('Fetch.continueRequest', { requestId }); return; }
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
  nbStub.log.push({ path: u.pathname, q: u.searchParams.get('q'), kind: u.searchParams.get('kind'),
    limit: u.searchParams.get('limit'), auth: 'authorization' in headers });
  if (nbStub.mode === 'fail') { await send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }); return; }
  const delay = nbStub.slow[u.searchParams.get('q') ?? ''];
  if (delay) await wait(delay);
  const rate = nbStub.mode === 'rate';
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: rate ? 429 : 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/json' },
      // What the real API sends a registered Origin.
      { name: 'access-control-allow-origin', value: headers.origin ?? '*' },
      { name: 'vary', value: 'Origin' },
    ],
    body: b64(rate ? { error: { code: 'rate_limited', message: 'Over the limit.' } } : nbAnswer(u)),
  });
}
await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/*', requestStage: 'Request' },
  { urlPattern: '*gifs.nostr.build/webm/*', requestStage: 'Request' },
  { urlPattern: '*gifs.nostr.build/mp4/*', requestStage: 'Request' },
] });
on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    if (m.params.request.method === 'HEAD' && m.params.request.url.includes('gifs.nostr.build')) nbStub.netHeads = (nbStub.netHeads ?? 0) + 1;
    const g = /^https:\/\/media\.giphy\.com\/media\/([A-Za-z0-9]+)\/([^?#]+)/.exec(m.params.request.url);
    if (g) media.push({ host: 'giphy', id: g[1], file: g[2] });
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  try {
    if (u.hostname === 'gifs.nostr.build') {
      if (u.pathname.startsWith('/api/')) { await answerNb(requestId, request, u); return; }
      if (request.method === 'HEAD') {
        // A warming request: held 400 ms, so the test can see how many run at once.
        nbStub.heads.push(u.pathname);
        nbStub.headInFlight += 1;
        nbStub.headMax = Math.max(nbStub.headMax, nbStub.headInFlight);
        await wait(400);
        nbStub.headInFlight -= 1;
        await send('Fetch.continueRequest', { requestId });
        return;
      }
      if (u.pathname.startsWith('/mp4/')) nbStub.gets.push(u.pathname);
      // true: every WebM fails; a key: only that GIF's (one tile failing alone gets its own pooled element back).
      if (u.pathname.startsWith('/webm/') && (nbStub.failWebm === true || (typeof nbStub.failWebm === 'string' && u.pathname.endsWith(`/${nbStub.failWebm}`)))) await send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
      else await send('Fetch.continueRequest', { requestId });
      return;
    }
    if (u.pathname === '/api/e2e-audio.wav') { await answerAudio(requestId, request); return; }
    if (u.pathname.startsWith('/api/nostr/')) {
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      return;
    }
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: b64(answer(u)),
    });
  } catch { /* the page navigated away under a paused request */ }
});
// Every <video> the page ever makes, counted from before any app script runs.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  window.__videosMade = 0;
  const ce = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...rest) {
    if (String(tag).toLowerCase() === 'video') window.__videosMade++;
    return ce.call(this, tag, ...rest);
  };
})();` });
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// A cached WebM would hide the failure `nbStub.failWebm` makes.
await send('Network.setCacheDisabled', { cacheDisabled: true });

const brand = async () => ((await js(`document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? ''`)) ?? '').includes('buddy') ? 'buddy' : 'bmb';
const clickButton = (re) => js(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => ${re}.test(x.innerText) && !x.disabled);
  if (!b) return false;
  b.click();
  return true;
})()`);
async function openPicker(minTiles = 20) {
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  t.ok('the album offers BOOST', await until(`!!document.querySelector('button[aria-label="Boost this track"]')`, 90000));
  await js(`document.querySelector('button[aria-label="Boost this track"]').click()`);
  t.ok('the boost modal offers + Add a GIF', await until(`[...document.querySelectorAll('button')].some((b) => /add a gif/i.test(b.innerText) && !b.disabled)`, 20000));
  await clickButton('/add a gif/i');
  const shown = await until(`document.querySelectorAll('[data-gif-key]').length >= ${minTiles}`, 20000);
  const seen = shown ? '' : await js(`[...document.querySelectorAll('[role="dialog"]')].map((d) => d.innerText).join(' | ').replace(/\\s+/g, ' ').slice(0, 400)`);
  t.ok(`the grid shows ${minTiles} or more tiles`, shown, `the dialog shows: ${seen}`);
  if (!shown) await exit(1);
}
/** Every tile: its key, state, box (relative to the scroll box) and video. */
const tiles = () => js(`(() => {
  const box = document.querySelector('[data-gif-scroll]').getBoundingClientRect();
  return [...document.querySelectorAll('[data-gif-key]')].map((b) => {
    const r = b.getBoundingClientRect();
    const v = b.querySelector('video');
    const img = b.querySelector('img:not([data-lqip])');
    return {
      key: b.dataset.gifKey, state: b.dataset.state,
      top: r.top - box.top, bottom: r.bottom - box.top, left: Math.round(r.left), width: r.width, height: r.height,
      video: v ? { paused: v.paused, src: v.getAttribute('src') ?? '', rs: v.readyState, ct: v.currentTime } : null,
      img: img && getComputedStyle(img).display !== 'none' ? img.getAttribute('src') : null,
    };
  });
})()`);
const boxHeight = () => js(`document.querySelector('[data-gif-scroll]').clientHeight`);
const scrollGrid = async (y) => { await js(`document.querySelector('[data-gif-scroll]').scrollTop = ${y}`); await wait(900); };
const attachedVideos = () => js(`document.querySelectorAll('video[data-gif-tile]').length`);
const dialogText = () => js(`[...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText ?? ''`);
const idOf = (key) => key.split(':')[1];

await send('Page.navigate', { url: `${APP}/privacy` });
await until(`document.readyState === 'complete' && !!document.querySelector('link[rel="manifest"]')`, 90000);
const BRAND_ID = await brand();
console.log(`\n(the server at ${APP} serves the ${BRAND_ID} brand)`);

if (BRAND_ID !== 'buddy') {
  console.log('\n(skipping section 1: it runs against a NEXT_PUBLIC_BRAND=buddy server)');
} else {
  section('1. GIPHY grid (desktop 1280×900)');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await openPicker(40);
  await wait(1500);
  let all = await tiles();
  const colW = all.find((x) => x.key === `giphy:${GIPHY[3].id}`)?.width ?? 0;
  const lefts = [...new Set(all.map((x) => x.left))];
  t.equal('two columns', lefts.length, 2);
  const h = (i) => all.find((x) => x.key === `giphy:${GIPHY[i].id}`)?.height ?? 0;
  t.ok('a tile takes its height from the DATA (200×250 → 1.25 × width)', Math.abs(h(2) - colW * 1.25) <= 1.5,
    `width ${colW}, height ${h(2)}`);
  t.ok('extreme ratios clamped: 1000×50 → half the width', Math.abs(h(0) - colW / 2) <= 1.5, `height ${h(0)}`);
  t.ok('extreme ratios clamped: 50×1000 → 4/3 of the width', Math.abs(h(1) - (colW * 4) / 3) <= 1.5, `height ${h(1)}`);

  const box = await boxHeight();
  t.ok('an on-screen tile plays', await until(`(() => {
    const b = document.querySelector('[data-gif-key][data-state="playing"]');
    const v = b?.querySelector('video');
    return !!v && !v.paused && v.currentTime > 0.05;
  })()`, 15000));
  all = await tiles();
  const onScreen = all.filter((x) => x.bottom > 0 && x.top < box);
  t.ok('every on-screen tile plays (or is still loading)', onScreen.every((x) => ['playing', 'waiting'].includes(x.state)),
    JSON.stringify(onScreen.map((x) => x.state)));
  const near = all.filter((x) => x.top >= box + 4 && x.top < box * 1.5 - 4);
  t.ok('there are tiles in the near zone below the box', near.length > 0, `box ${box}`);
  t.ok('a near tile waits paused on its first frame', near.length > 0 && near.every((x) => x.state === 'waiting'
    && x.video && x.video.paused && x.video.src.endsWith('#t=0.001') && x.video.rs >= 2), JSON.stringify(near.map((x) => [x.state, x.video])));
  const far = all.filter((x) => x.top > box * 1.5 + 4);
  t.ok('there are far tiles', far.length > 0);
  t.ok('a far tile holds no video and no picture', far.every((x) => x.state === 'far' && !x.video && !x.img),
    JSON.stringify(far.slice(0, 3)));
  const farIds = new Set(far.map((x) => idOf(x.key)));
  t.equal('a far tile asked for no file', media.filter((m) => farIds.has(m.id)).length, 0);
  t.equal('no tile asked for an animated WebP or a still while video plays',
    media.filter((m) => m.file !== '200w.mp4').map((m) => m.file), []);

  const firstKeys = onScreen.map((x) => x.key);
  const scrollMax = await js(`(() => { const s = document.querySelector('[data-gif-scroll]'); return s.scrollHeight - s.clientHeight; })()`);
  await scrollGrid(scrollMax);
  all = await tiles();
  t.ok('scrolled to the end: the first tiles are far again and hold no video',
    all.filter((x) => firstKeys.includes(x.key)).every((x) => x.state === 'far' && !x.video));
  t.equal('every attached video belongs to a near tile', await attachedVideos(),
    all.filter((x) => x.video).length);

  let maxAttached = 0;
  for (let i = 0; i < 10; i++) {
    await js(`(() => {
      const el = document.querySelector('input[type="search"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, 'search ${'x'.repeat(i + 2)}');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(`document.querySelectorAll('[data-gif-key]').length >= 40`, 10000);
    await wait(1200);
    maxAttached = Math.max(maxAttached, await attachedVideos());
    await scrollGrid(600);
    maxAttached = Math.max(maxAttached, await attachedVideos());
  }
  const made = await js('window.__videosMade');
  t.ok('ten searches: videos made ≤ the most attached at once + 4', made <= maxAttached + 4,
    `made ${made}, most attached ${maxAttached}`);

  await clickButton('/^close$/i');
  t.ok('close releases every video', await until(`document.querySelectorAll('video[data-gif-tile]').length === 0`, 3000));
  await clickButton('/add a gif/i');
  const replays = await until(`document.querySelectorAll('[data-gif-key][data-state="playing"]').length > 0`, 15000);
  t.ok('the reopened grid plays', replays, JSON.stringify((await tiles()).slice(0, 6).map((x) => [x.state, x.video])));
  await wait(1500);
  t.ok('a second opening reuses the pool', (await js('window.__videosMade')) <= made,
    `made ${await js('window.__videosMade')} after reopening, ${made} before`);

  await until(`document.querySelectorAll('[data-gif-key][data-state="playing"]').length > 0`, 10000);
  all = await tiles();
  const pickTile = all.find((x) => x.state === 'playing');
  t.ok('a tile is playing when the pick is made', !!pickTile, JSON.stringify(all.slice(0, 6).map((x) => [x.state, x.video])));
  if (!pickTile) await exit(1);
  await js(`document.querySelector('[data-gif-key="${pickTile.key}"]').click()`);
  t.ok('a click picks: the picker closes', await until(`!document.querySelector('[data-gif-scroll]')`, 3000));
  t.equal('the picked GIF shows above the message', await js(`document.querySelector('img[alt="The GIF this boost will carry"]')?.src ?? null`),
    `https://media.giphy.com/media/${idOf(pickTile.key)}/200w.webp`);
  t.equal('a pick releases every video', await attachedVideos(), 0);

  section('1b. Reduced motion: stills, no video');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await openPicker(40);
  await wait(2000);
  all = await tiles();
  const rbox = await boxHeight();
  t.equal('no video is attached', await attachedVideos(), 0);
  // One <video> is allowed: `canPlayH264()` asks `canPlayType` on a bare one,
  // once per page. It is never attached and never given a `src`.
  t.ok('and no tile video was made (only the one H.264 probe)', (await js('window.__videosMade')) <= 1,
    `made ${await js('window.__videosMade')}`);
  t.ok('on-screen tiles show their still', all.filter((x) => x.bottom > 0 && x.top < rbox).every((x) => x.state === 'still'
    && /\/200w_s\.gif$/.test(x.img ?? '')), JSON.stringify(all.slice(0, 2)));
  t.ok('far tiles show nothing', all.filter((x) => x.top > rbox * 1.5 + 4).every((x) => !x.img));
  // Said on screen, so a phone that shows still pictures says why (Chad's iPhone, beta, 2026-11-14).
  t.ok('the picker says Reduce Motion is the reason', /Reduce Motion is on/.test(await dialogText()), await dialogText());
  // Chad (iPhone, Reduce Motion on, 2026-11-14): a "Play anyway" the device
  // remembers, and a way back.
  t.ok('it offers Play anyway', await clickButton('/play anyway/i'));
  t.ok('Play anyway: the on-screen tiles play', await until(`!!document.querySelector('[data-gif-key][data-state="playing"]')`, 15000));
  t.equal('and this device remembers it (bmb:gif_motion)', await js(`localStorage.getItem('bmb:gif_motion')`), '1');
  await clickButton('/^close$/i');
  await clickButton('/add a gif/i');
  t.ok('opened again: it plays at once', await until(`!!document.querySelector('[data-gif-key][data-state="playing"]')`, 15000));
  t.ok('and offers still pictures again', /show still pictures/i.test(await dialogText()), await dialogText());
  await clickButton('/show still pictures/i');
  t.ok('Show still pictures: back to stills', await until(
    `[...document.querySelectorAll('[data-gif-key]')].slice(0, 2).every((b) => b.dataset.state === 'still')`, 5000));
  t.equal('and the key is gone', await js(`localStorage.getItem('bmb:gif_motion')`), null);
  await send('Emulation.setEmulatedMedia', { features: [] });

  section('1c. A refused autoplay: stills for the grid');
  const { result: refusal } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException('refused', 'NotAllowedError')); };` });
  await openPicker(40);
  t.ok('the grid falls back to stills', await until(`(() => {
    const on = [...document.querySelectorAll('[data-gif-key]')].slice(0, 4);
    return on.length === 4 && on.every((b) => b.dataset.state === 'still');
  })()`, 10000), JSON.stringify((await tiles()).slice(0, 4).map((x) => x.state)));
  t.equal('and holds no video', await attachedVideos(), 0);
  t.ok('the picker says the device did not let the GIFs play', /did not let the GIFs play by themselves/.test(await dialogText()), await dialogText());
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: refusal.identifier });

  section('1d. Phone (390×844, touch)');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await openPicker(40);
  await wait(1500);
  all = await tiles();
  t.equal('two columns', [...new Set(all.map((x) => x.left))].length, 2);
  const w = await js(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`);
  t.ok('no sideways overflow', w && w[0] <= w[1], JSON.stringify(w));
  t.ok('an on-screen tile plays on the phone too', await until(`!!document.querySelector('[data-gif-key][data-state="playing"]')`, 15000));
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
}

/** Type into the search box the way React hears it. */
const typeQuery = (value) => js(`(() => {
  const el = document.querySelector('input[type="search"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const gridKeys = () => js(`[...document.querySelectorAll('[data-gif-key]')].map((b) => b.dataset.gifKey)`);
const keysOf = (answer) => nb.parseNbResults(answer).map((r) => `nostrbuild:${r.key}`);
/** The grid is two masonry columns, so page order is not result order: compare sets. */
const sorted = (a) => [...a].sort();

if (BRAND_ID !== 'bmb') {
  console.log('\n(skipping section 2: it runs against a server with no NEXT_PUBLIC_BRAND)');
} else if (REAL_NB) {
  section('2r. The REAL gifs.nostr.build API, from 127.0.0.1');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await openPicker(10);
  t.ok('the browse list arrives and a tile plays', await until(`!!document.querySelector('[data-gif-key][data-state="playing"]')`, 20000));
  await typeQuery('applause');
  t.ok('a search for applause shows tiles', await until(`document.querySelectorAll('[data-gif-key]').length >= 10`, 15000));
  t.ok('and one plays', await until(`(() => {
    const v = document.querySelector('[data-gif-key][data-state="playing"] video');
    return !!v && !v.paused && v.currentTime > 0.05 && v.getAttribute('src').startsWith('${B}/');
  })()`, 20000));
} else {
  section('2. nostr.build, from the browser (desktop 1280×900)');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await openPicker(20);
  const browse = nbStub.log.filter((r) => r.path === '/api/v1/gifs');
  t.equal('the empty box asks the browse list once', browse.map((r) => [r.kind, r.limit]), [['reaction', '200']]);
  t.equal('no request carries an Authorization header', nbStub.log.filter((r) => r.auth).length, 0);
  t.equal('the grid shows the browse answer', sorted(await gridKeys()), sorted(keysOf(FIX.chibi)));
  t.ok('the attribution links https://nostr.build', await js(`(() => {
    const a = [...document.querySelectorAll('[role="dialog"] a[href="https://nostr.build"]')].at(-1);
    return !!a && /nostr\\.build/.test(a.innerText) && a.target === '_blank';
  })()`));
  t.ok('"Powered by GIPHY" is not shown', !/Powered by GIPHY/i.test(await dialogText()));

  let before = nbStub.log.length;
  await typeQuery('a');
  await wait(900);
  t.equal('one Latin letter sends nothing', nbStub.log.length - before, 0);

  before = nbStub.log.length;
  await typeQuery('applause');
  t.ok('a typed search shows its answer', await until(`document.querySelector('[data-gif-key="${keysOf(FIX.applause)[0]}"]') !== null`, 8000));
  const asked = nbStub.log.slice(before);
  t.equal('it asked once, with limit=200', asked.map((r) => [r.path, r.q, r.limit]), [['/api/v1/search', 'applause', '200']]);
  before = nbStub.log.length;
  await typeQuery('Applause ');
  await wait(900);
  t.equal('the same query with a trailing space and a capital sends nothing new', nbStub.log.length - before, 0);
  t.ok('and the grid stays', (await gridKeys()).length > 10);

  nbStub.slow.cat = 2000;
  await typeQuery('cat');
  await wait(600);
  await typeQuery('');
  await wait(3200);
  t.equal('late answer ignored: the cleared box shows the browse list', sorted(await gridKeys()), sorted(keysOf(FIX.chibi)));
  delete nbStub.slow.cat;

  before = nbStub.log.length;
  await typeQuery(`nsec1${'q'.repeat(58)}`);
  await wait(900);
  t.equal('a typed nsec sends nothing to gifs.nostr.build', nbStub.log.length - before, 0);
  t.ok('and says so', /secret key/i.test(await dialogText()));

  nbStub.mode = 'rate';
  await typeQuery('ratelimit');
  t.ok('429 says to wait a minute', await until(`/Too many searches for now: give it a minute\\./.test([...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText ?? '')`, 8000));
  t.ok('and offers no Try again', !/Try again/i.test(await dialogText()));

  nbStub.mode = 'fail';
  before = nbStub.log.length;
  await typeQuery('failing');
  t.ok('a failed request says GIFs are unavailable', await until(`/GIFs are unavailable right now\\./.test([...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText ?? '')`, 10000));
  t.equal('it retried once after the network failure', nbStub.log.slice(before).filter((r) => r.q === 'failing').length, 2);
  nbStub.mode = 'ok';
  before = nbStub.log.length;
  await clickButton('/try again/i');
  t.ok('Try again asks again and shows the answer', await until(`document.querySelectorAll('[data-gif-key]').length > 10`, 8000)
    && nbStub.log.slice(before).some((r) => r.q === 'failing'));

  // One letter typed while the first list is still on its way is not a search,
  // so it must not cancel that list either: the grid would pulse its skeleton
  // under "Keep typing to search." for good (final review).
  await clickButton('/^close$/i');
  nbStub.slow[''] = 1500;
  await clickButton('/add a gif/i');
  await until(`!!document.querySelector('input[type="search"]')`, 5000);
  await typeQuery('a');
  t.ok('one letter typed during the first load: the browse list still arrives', await until(
    `document.querySelectorAll('[data-gif-key]').length > 10`, 4000), await dialogText());
  delete nbStub.slow[''];

  section('2b. A transparent GIF plays its WebM, then its MP4 when the WebM fails');
  await typeQuery('');
  await until(`document.querySelector('[data-gif-key="${keysOf(FIX.chibi)[0]}"] video') !== null`, 10000);
  const firstKey = keysOf(FIX.chibi)[0];
  const srcOf = () => js(`document.querySelector('[data-gif-key="${firstKey}"] video')?.getAttribute('src') ?? ''`);
  t.ok('Chrome plays the WebM', (await srcOf()).startsWith(`${B}/webm/orig/`), await srcOf());
  await clickButton('/^close$/i');
  nbStub.failWebm = firstKey.split(':')[1];
  await clickButton('/add a gif/i');
  t.ok('a failed WebM falls back to the MP4', await until(`(document.querySelector('[data-gif-key="${firstKey}"] video')?.getAttribute('src') ?? '').startsWith('${B}/mp4/orig/')`, 10000),
    await srcOf());
  // Loading the MP4 is not enough: the pool hands the SAME element back, so a
  // play effect keyed on the element alone never runs again (final review).
  t.ok('and the fallback MP4 PLAYS', await until(`(() => {
    const b = document.querySelector('[data-gif-key="${firstKey}"]');
    const v = b?.querySelector('video');
    return b?.dataset.state === 'playing' && !!v && !v.paused && v.currentTime > 0.05;
  })()`, 10000), JSON.stringify((await tiles()).find((x) => x.key === firstKey)));
  nbStub.failWebm = false;

  section('2e. Videos a screen and a half ahead are warmed with a HEAD (Chad, beta, 2026-11-14: "slow when I search and scroll")');
  // A video nostr.build has not made yet is made inside its first request
  // (~3 s, the guide says; 0.3–0.6 s measured for a CDN miss here), so a tile
  // that starts its own request only half a screen ahead arrives empty.
  // A fresh page: the warm queue remembers each video for the page's life,
  // and the searches above already warmed this answer's videos.
  await openPicker(20);
  nbStub.heads.length = 0;
  nbStub.gets.length = 0;
  nbStub.headMax = 0;
  await typeQuery('applause');
  await until(`document.querySelector('[data-gif-key="${keysOf(FIX.applause)[0]}"]') !== null`, 8000);
  await wait(3000);
  {
    const box = await boxHeight();
    const all = await tiles();
    const mp4Path = (key) => `/mp4/orig/${key.split(':')[1]}`;
    const warmZone = all.filter((x) => x.top > box * 1.5 + 8 && x.top < box * 2.5 - 8);
    const farZone = all.filter((x) => x.top > box * 2.5 + 8);
    t.ok('there are tiles in the warm zone and beyond it', warmZone.length > 0 && farZone.length > 0,
      `warm ${warmZone.length}, far ${farZone.length}, box ${box}`);
    t.ok('every tile 0.5–1.5 screens ahead got a HEAD for its video',
      warmZone.every((x) => nbStub.heads.includes(mp4Path(x.key))),
      JSON.stringify(warmZone.filter((x) => !nbStub.heads.includes(mp4Path(x.key))).map((x) => x.key.slice(11, 19))));
    t.ok('and no GET: it waits for its own video', warmZone.every((x) => !nbStub.gets.includes(mp4Path(x.key))));
    t.ok('a tile beyond 1.5 screens got no HEAD', farZone.every((x) => !nbStub.heads.includes(mp4Path(x.key))));
    t.equal('each video is warmed once', nbStub.heads.length, new Set(nbStub.heads).size);
    console.log(`  info HEADs seen by the network layer: ${nbStub.netHeads ?? 0}, by the stub: ${nbStub.heads.length}`);
    t.ok('at most three HEADs at a time', nbStub.headMax > 0 && nbStub.headMax <= 3, `max ${nbStub.headMax}`);
  }

  section('2c. A pick, and the stored boost');
  await typeQuery('applause');
  await until(`document.querySelector('[data-gif-key][data-state="playing"]') !== null`, 15000);
  const chosen = await js(`document.querySelector('[data-gif-key][data-state="playing"]').dataset.gifKey`);
  const key = chosen.split(':')[1];
  await js(`document.querySelector('[data-gif-key="${chosen}"]').click()`);
  t.ok('the picker closes', await until(`!document.querySelector('[data-gif-scroll]')`, 3000));
  t.equal('the picked GIF shows its animated preview', await js(`document.querySelector('img[alt="The GIF this boost will carry"]')?.src ?? null`),
    `${B}/anim/w240/${key}`);
  t.equal('the message box gives the URL its room (250 − the URL − 1)', await js(`document.querySelector('[role="dialog"] textarea')?.maxLength ?? null`),
    250 - `${B}/${key}`.length - 1);
  t.equal('a pick releases every video', await attachedVideos(), 0);

  const stored = [
    { uuid: 'e2e-nb', ts: Date.now() - 1000, podcastTitle: 'E2E', sats: 100, message: `nostr.build boost\n${B}/${key}`, legs: [] },
    { uuid: 'e2e-giphy', ts: Date.now() - 2000, podcastTitle: 'E2E', sats: 100, message: 'giphy boost\nhttps://media.giphy.com/media/1VQr7rkEjsLXG/giphy.gif', legs: [] },
  ];
  await js(`localStorage.setItem('bmb:boosts:guest', ${JSON.stringify(JSON.stringify(stored))})`);
  await send('Page.navigate', { url: `${APP}/` });
  t.ok('a stored boost draws its nostr.build GIF and an old GIPHY one', await until(`(() => {
    const s = [...document.querySelectorAll('img[alt="GIF"]')].map((i) => i.src);
    return s.includes('${B}/anim/w240/${key}') && s.includes('https://media.giphy.com/media/1VQr7rkEjsLXG/200w.webp');
  })()`, 20000));
  await js(`localStorage.removeItem('bmb:boosts:guest')`);

  section('2d. Phone (390×844, touch): the field is not focused on open');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await openPicker(10);
  t.ok('the keyboard does not cover the grid', await js(`document.activeElement?.getAttribute('type') !== 'search'`));
  const w = await js(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`);
  t.ok('no sideways overflow', w && w[0] <= w[1], JSON.stringify(w));
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
}

if (!REAL_NB) {
  section('3. The player: GIF tiles write no ms.reg line, and the lock-screen hand-over still runs');
  // What the page hands the OS, stamped with how many `playing` events came
  // from a GIF tile by then. Registered before any app script, so for one
  // event this listener counts first and the app's capture listener runs after.
  const { result: recorder } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const ms = navigator.mediaSession; if (!ms) return;
    const orig = ms.setActionHandler.bind(ms);
    window.__msLog = []; window.__tilePlaying = 0;
    document.addEventListener('playing', (e) => {
      if (e.target instanceof HTMLElement && e.target.hasAttribute('data-gif-tile')) window.__tilePlaying += 1;
    }, true);
    ms.setActionHandler = (action, handler) => {
      window.__msLog.push({ action, fn: typeof handler === 'function', tile: window.__tilePlaying });
      try { orig(action, handler); } catch { /* unsupported */ }
    };
  })();` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes('GIF grid track 0'))`, 60000);
  // The log is a 150-line ring in localStorage that outlives a page load, and
  // the sections above filled it. In a full ring a new line pushes an old one
  // out, so a count only means something from an empty log.
  const clearLog = () => js(`localStorage.setItem('bmb:plog:device', '[]')`);
  const msReg = () => js(`(JSON.parse(localStorage.getItem('bmb:plog:device') ?? '[]')).filter((l) => / ms\\.reg/.test(l)).length`);
  await clearLog();
  await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('GIF grid track 0'))?.click()`);
  t.ok('the track plays', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2; })()`, 20000));
  await wait(500);
  t.ok("the player's own playing logged ms.reg", (await msReg()) >= 1, `ms.reg lines: ${await msReg()}`);
  await clearLog();
  const regBefore = 0;

  await js(`document.querySelector('button[aria-label="Boost this track"]').click()`);
  await until(`[...document.querySelectorAll('button')].some((b) => /add a gif/i.test(b.innerText) && !b.disabled)`, 20000);
  await clickButton('/add a gif/i');
  t.ok('GIF tiles play over the track', await until(`window.__tilePlaying >= 3`, 20000), `tile playing events: ${await js('window.__tilePlaying')}`);
  await wait(800);
  t.equal('no ms.reg line for a tile', await msReg(), regBefore);
  const lastTile = await js('window.__tilePlaying');
  t.ok('the hand-over still ran after the latest tile played (nexttrack set)',
    await js(`window.__msLog.some((e) => e.action === 'nexttrack' && e.fn && e.tile >= ${lastTile})`),
    JSON.stringify((await js('window.__msLog')).slice(-4)));

  await clickButton('/^close$/i');
  await js(`(() => { const a = document.querySelector('audio'); a.pause(); setTimeout(() => a.play(), 300); })()`);
  t.ok("the player's own playing still logs ms.reg", await until(`(JSON.parse(localStorage.getItem('bmb:plog:device') ?? '[]')).filter((l) => / ms\\.reg/.test(l)).length > ${regBefore}`, 8000));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: recorder.identifier });
}

if (pageErrors.length) console.log(`\n  info page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
console.log(`\n${t.count - t.fails}/${t.count} checks passed`);
await exit(t.fails ? 1 : 0);
