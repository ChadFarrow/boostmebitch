// Drives a download THROUGH `/api/audio` in a real browser, against the real
// route on a production build, and checks the two things its length is for.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:audioproxy              # add --headed to watch it
//
// WHY. Next 15.5.29 drops a route handler's `Content-Length` (see
// `PROXY_LENGTH_HEADER` in lib/downloads/download-rules.ts), so from #662 every
// download through `/api/audio` reached the browser with no length: no progress
// percentage, no second room check, and no way for anything to tell a body that
// ended early from a whole one. `check:audiowire` pins the headers on the wire
// with Next's real `sendResponse`; this checks the WIRING above them — that
// `downloadBytes` reads `X-Expected-Length`, that the row shows a percentage
// while a proxied download runs, and that a body which ends cleanly with bytes
// missing is refused rather than stored. `e2e:downloads` cannot see any of it:
// its real episode is on a host that sends CORS, so it never reaches the route.
//
// HOW THE ROUTE IS REACHED. CDP fails the browser's own request to the enclosure
// host, which is exactly what a host that sends no `Access-Control-Allow-Origin`
// does to a `mode: 'cors'` fetch, so `downloadBytes` retries through
// `/api/audio`. The SERVER then fetches the real track: about 3 MB per section,
// two sections. The track is from Tinderbox (podcast:guid
// 537df90e-0cc4-535b-84d0-dcb3ca87f1f8), the album `e2e:album` uses, because a
// music track is small; the network is throttled so the download lasts long
// enough to read its percentage.
//
// The cut in section 2 is made by CDP at the RESPONSE stage: the real
// `/api/audio` response, with its real headers, and half its body. Without
// `Content-Length` the browser takes a short body as whole — the case
// `endedShort` exists for.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const ALBUM_GUID = '537df90e-0cc4-535b-84d0-dcb3ca87f1f8';
const ENCLOSURE_PATTERNS = [
  { urlPattern: '*d12wklypp119aj.cloudfront.net/track/*', requestStage: 'Request' },
  { urlPattern: '*op3.dev/e,pg=537df90e*', requestStage: 'Request' },
];
const PROXY_PATTERN = { urlPattern: '*/api/audio?*', requestStage: 'Response' };

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

const t = checker();
const section = (s) => console.log(`\n${s}`);
const { page } = await launchChrome({ name: 'audio-proxy' });
const { send, js, on } = page;

let cutProxy = false;
const directFailed = [];
const proxied = [];       // { url, status, headers } per /api/audio response
const cuts = [];
on((m) => {
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/audio?')) {
    const h = Object.fromEntries(Object.entries(m.params.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    proxied.push({ status: m.params.response.status, headers: h });
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request, responseStatusCode, responseHeaders } = m.params;
  if (responseStatusCode === undefined) {
    // The browser's own request to the host: refuse it as a CORS-less host would.
    directFailed.push(request.url);
    void send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' }).catch(() => {});
    return;
  }
  void (async () => {
    if (!cutProxy) { await send('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
    const got = await send('Fetch.getResponseBody', { requestId });
    const whole = Buffer.from(got.result.body, got.result.base64Encoded ? 'base64' : 'utf8');
    const half = whole.subarray(0, whole.length >> 1);
    cuts.push({ whole: whole.length, sent: half.length });
    await send('Fetch.fulfillRequest', {
      requestId,
      responseCode: responseStatusCode,
      // Every header as it arrived, minus any length: the browser then takes
      // the short body as whole, which is what a clean early end looks like.
      responseHeaders: responseHeaders.filter((h) => !/^(content-length|transfer-encoding)$/i.test(h.name)),
      body: half.toString('base64'),
    }).catch(() => {});
  })();
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// ~400 KB/s, so a 3 MB track takes several seconds and its percentage is readable.
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 20, downloadThroughput: 400 * 1024, uploadThroughput: 200 * 1024,
});
await send('Fetch.enable', { patterns: ENCLOSURE_PATTERNS });

const ROWS = `[...document.querySelectorAll('li')].filter((li) => li.querySelector('button[aria-label="Play"], button[aria-label="Pause"], button[aria-label^="More actions for "]'))`;
const OPEN_MENU = `document.querySelector('[role="menu"]')`;
const MENU_TILE = `document.querySelector('[role="menu"] button[aria-label^="Download "], [role="menu"] button[aria-label^="Downloading "], [role="menu"] button[aria-label^="Remove the download"]')`;

const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await wait(200); }
};
async function openRowMenu(i) {
  await js(`(() => { const b = document.querySelector('button[aria-label^="More actions for "][aria-expanded="true"]'); b?.click(); return true; })()`);
  const has = await js(`(() => { const b = ${ROWS}[${i}]?.querySelector('button[aria-label^="More actions for "]'); if (!b) return false; b.click(); return true; })()`);
  return has && !!(await until(() => js(`!!${OPEN_MENU}`), 3000));
}
async function closeRowMenu() {
  await js(`(() => { const b = document.querySelector('button[aria-label^="More actions for "][aria-expanded="true"]'); b?.click(); return true; })()`);
}
/** Row `i`'s download tile name, read in its open menu. */
async function tileLabel(i) {
  if (!(await openRowMenu(i))) return null;
  const label = await js(`${MENU_TILE}?.getAttribute('aria-label') ?? null`);
  await closeRowMenu();
  return label;
}
async function startDownload(i) {
  if (!(await openRowMenu(i))) return false;
  return js(`(() => { const b = [...document.querySelectorAll('[role="menu"] button[aria-label^="Download "]')].find((x) => /to play without a connection/.test(x.getAttribute('aria-label'))); if (!b) return false; b.click(); return true; })()`);
}
/** Row `i`'s visible text, where `<DownloadMark>` says "↓ 47%" or "✓ downloaded". */
const rowText = (i) => js(`(${ROWS}[${i}]?.textContent || '').replace(/\\s+/g, ' ')`);
/** Cache entries in the audio bucket, read by its on-disk NAME. */
const cached = () => js(`(async () => {
  const cache = await caches.open('bmb-downloads-v1');
  const out = [];
  for (const req of await cache.keys()) out.push({ url: req.url, size: (await (await cache.match(req)).blob()).size });
  return out;
})()`);

await send('Page.navigate', { url: `${APP}/?podcast=${ALBUM_GUID}` });
const rows = await until(() => js(`${ROWS}.length`), 45000);
if (!rows) {
  t.fail('the album page lists its tracks within 45 s', await js(`document.body.innerText.slice(0, 300)`));
  await exit(1);
}
console.log(`  album page: ${rows} rows`);

// ---------------------------------------------------------------------------
section('1. A proxied download states its length, shows a percentage, and stores the whole file');
// ---------------------------------------------------------------------------
{
  t.ok('row 0 offers DOWNLOAD, and it starts', await startDownload(0));
  const seen = new Set();
  const done = await until(async () => {
    const text = await rowText(0);
    const pct = /↓ (\d+)%/.exec(text);
    if (pct) seen.add(Number(pct[1]));
    return /✓ downloaded/.test(text);
  }, 120000);
  const p = proxied[0];
  console.log(`  direct requests refused: ${directFailed.length}; /api/audio answers: ${JSON.stringify(proxied.map((x) => ({ status: x.status, 'x-expected-length': x.headers['x-expected-length'], 'content-length': x.headers['content-length'] ?? null })))}`);
  console.log(`  percentages read on the row: ${[...seen].sort((a, b) => a - b).join(', ') || 'none'}`);
  t.ok('the browser\'s own request was refused, so the route was used', directFailed.length >= 1 && proxied.length >= 1);
  t.ok('/api/audio answered 200 with X-Expected-Length', p?.status === 200 && /^\d+$/.test(p?.headers['x-expected-length'] ?? ''), JSON.stringify(p));
  t.ok('the row showed a download percentage while it ran (the length reached the client)', seen.size >= 2, [...seen].join(','));
  t.ok('the row says ✓ downloaded', !!done);
  const c = await cached();
  t.ok('one file is stored, exactly X-Expected-Length bytes', c.length === 1 && String(c[0].size) === p?.headers['x-expected-length'], JSON.stringify(c));
}

// ---------------------------------------------------------------------------
section('2. A proxied body that ends cleanly with half its bytes is REFUSED, not stored');
// ---------------------------------------------------------------------------
{
  cutProxy = true;
  await send('Fetch.enable', { patterns: [...ENCLOSURE_PATTERNS, PROXY_PATTERN] });
  const before = (await cached()).length;
  t.ok('row 1 offers DOWNLOAD, and it starts', await startDownload(1));
  const failed = await until(async () => {
    const label = await tileLabel(1);
    return label && /failed/.test(label) ? label : null;
  }, 120000);
  const alerts = await js(`[...document.querySelectorAll('[role=alert]')].map((a) => a.textContent.trim()).join(' | ')`);
  console.log(`  cut: ${JSON.stringify(cuts)}; tile: ${JSON.stringify(failed)}; alerts: ${JSON.stringify(alerts)}`);
  t.ok('CDP cut the real /api/audio body in half', cuts.length >= 1 && cuts[0].sent < cuts[0].whole, JSON.stringify(cuts));
  t.ok('the row reports the download FAILED', !!failed, failed);
  t.ok('row 1 never says ✓ downloaded', !/✓ downloaded/.test(await rowText(1)));
  t.equal('nothing more is stored', (await cached()).length, before);
}

console.log(`\n${t.fails ? `${t.fails} of ${t.count} checks FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
