// e2e: the Libre wallet core is OFF unless its gate is open, and its card sits
// above the dock (lib/v4v/libre.ts, components/libre/libre-wallet-host.tsx,
// docs/wallets.md "Libre Wallet").
//
// Run against a PRODUCTION build (the service worker only registers there):
//
//   NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID=e2e-libre-fake.apps.googleusercontent.com npm run build
//   npx next start -p 3418 -H 127.0.0.1
//   LIBRE_BUILD=on APP_URL=http://127.0.0.1:3418 npm run e2e:librecore
//
// LIBRE_BUILD names the build under test, because the gate is inlined at BUILD
// time and the page cannot be asked which one it is:
//   on     a client id, the Boost Me Bitch brand — the widget mounts when wanted
//   off    NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID= (empty) — nothing ever mounts
//   buddy  a client id AND NEXT_PUBLIC_BRAND=buddy — nothing ever mounts
// Always set the variable on the command line: `.env.local` may carry a real id,
// and a test must never mount the widget against a real OAuth client.
//
// What "the widget loaded" means here: the page REQUESTED the JS chunk that
// carries `@libre/wallet-embed` (found in .next/static/chunks by a string only
// the package has) or `/liblightningjs.wasm`, or a <libre-wallet> element
// exists. "Off" is all three absent. That is "never requested", not "absent
// from the build": the script also says whether the build holds the chunk.
//
// Nothing leaves this machine from the browser: every host but 127.0.0.1 and
// localhost resolves to NOTFOUND (Google's OAuth and Drive, mempool.space, the
// LDK WebSocket bridge). The client id is fake and the access token is a
// literal string. The server does its own ordinary reads (Podcast Index, the
// feed) for the one episode page that puts a mini-bar on screen.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3418';
const BUILD = process.env.LIBRE_BUILD ?? '';
if (!['on', 'off', 'buddy'].includes(BUILD)) {
  console.error('Set LIBRE_BUILD=on|off|buddy to the build under test (see the header).');
  process.exit(2);
}
await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start it as the header says.`);
const ON = BUILD === 'on';

const t = checker();
const section = (s) => console.log(`\n--- ${s} ---`);

// The chunk(s) carrying the package, by a string only the package has.
const MARK = 'googleClientId is required';
const chunkDir = join(process.cwd(), '.next/static/chunks');
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.js') ? [p] : []);
});
const LIBRE_CHUNKS = walk(chunkDir).filter((p) => readFileSync(p, 'utf8').includes(MARK)).map((p) => p.split('/').pop());
console.log(`build "${BUILD}": ${LIBRE_CHUNKS.length} chunk(s) carry @libre/wallet-embed${LIBRE_CHUNKS.length ? ` (${LIBRE_CHUNKS.join(', ')})` : ''}`);
if (ON) t.ok('the on build holds the wallet chunk', LIBRE_CHUNKS.length > 0);

const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range
const EPISODE = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
const HOST = '[data-libre-host]';

/**
 * One fresh browser per case, so no case inherits another's storage, worker or
 * module state. `init` runs before every page script; `blockChunk` fails the
 * wallet chunk's request (a redeploy 404, offline) to put the error card up.
 */
async function open({ name, url, init = '', blockChunk = false, phone = false }) {
  const b = await launchChrome({
    name: `libre-${name}`,
    args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
  });
  const { page } = b;
  const requests = [];
  page.on((m) => {
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  if (phone) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  if (blockChunk) {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/_next/static/chunks/*', requestStage: 'Request' }] });
    page.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      const base = new URL(request.url).pathname.split('/').pop();
      if (LIBRE_CHUNKS.includes(base)) {
        page.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
      } else {
        page.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    });
  }
  if (init) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: init });
  await page.send('Page.navigate', { url });
  await page.until(`document.readyState === 'complete' && !!document.querySelector('nav[aria-label="Main"]')`, 30000);
  const loaded = () => ({
    chunk: requests.some((u) => LIBRE_CHUNKS.includes(new URL(u).pathname.split('/').pop())),
    wasm: requests.some((u) => new URL(u).pathname === '/liblightningjs.wasm'),
  });
  const element = () => page.js(`!!document.querySelector('libre-wallet')`);
  return { b, page, loaded, element, requests };
}

const ACTIVE = `try { localStorage.setItem('bmb:libre_active', '1'); } catch {}`;
const IOS = `window.Capacitor = { getPlatform: () => 'ios', isNativePlatform: () => true };`;
const OAUTH = '#access_token=e2e-not-a-token&token_type=Bearer&expires_in=3599&state=e2e';
// The Amber callback's fragment shape: one key, `r`, whose value holds a signed
// event. A substring test for "access_token" matches it; a parameter test does not.
const AMBER = `#r=e2e;event=${encodeURIComponent(JSON.stringify({ kind: 1, content: 'here is my access_token=abc' }))}`;

/** Wait long enough that a mount which was going to start has started. */
const settle = async (c, want) => {
  if (want) await c.page.until(`!!document.querySelector('libre-wallet')`, 30000);
  else await wait(4000);
};

async function nothingLoads(name, opts, why) {
  const c = await open({ name, ...opts });
  await settle(c, false);
  const l = c.loaded();
  t.ok(`${why}: the wallet chunk is never requested`, !l.chunk);
  t.ok(`${why}: /liblightningjs.wasm is never requested`, !l.wasm);
  t.equal(`${why}: no <libre-wallet> element`, await c.element(), false);
  await c.b.close();
}

async function widgetLoads(name, opts, why) {
  const c = await open({ name, ...opts });
  const mounted = await c.page.until(`!!document.querySelector('libre-wallet')`, 30000);
  t.ok(`${why}: a <libre-wallet> element mounts`, !!mounted);
  t.ok(`${why}: the wallet chunk was requested`, c.loaded().chunk);
  console.log(`  info  ${why}: WASM requested: ${c.loaded().wasm}`);
  await c.b.close();
}

section(`1. A visitor who never chose Libre loads nothing (build "${BUILD}")`);
await nothingLoads('fresh', { url: `${APP}/privacy` }, 'a fresh visit');
t.equal(`the host ${ON ? 'renders its collapsed slot' : 'renders nothing at all'}`,
  await (async () => {
    const c = await open({ name: 'host', url: `${APP}/privacy` });
    const r = await c.page.js(`(() => { const h = document.querySelector('${HOST}'); if (!h) return 'none';
      const b = h.getBoundingClientRect(); return b.width === 0 && b.height === 0 ? 'collapsed' : 'visible'; })()`);
    await c.b.close();
    return r;
  })(), ON ? 'collapsed' : 'none');

section('2. The two doors that need no click');
if (ON) {
  await widgetLoads('active', { url: `${APP}/privacy`, init: ACTIVE }, 'bmb:libre_active=1');
  await widgetLoads('oauth', { url: `${APP}/privacy${OAUTH}` }, 'an OAuth redirect landing (#access_token=…)');
} else {
  await nothingLoads('active', { url: `${APP}/privacy`, init: ACTIVE }, 'bmb:libre_active=1');
  await nothingLoads('oauth', { url: `${APP}/privacy${OAUTH}` }, 'an OAuth redirect landing (#access_token=…)');
}
await nothingLoads('amber', { url: `${APP}/privacy${AMBER}` }, 'an Amber-shaped fragment that MENTIONS access_token');

section('3. Inside the iOS app every door stays shut');
await nothingLoads('ios', { url: `${APP}/privacy${OAUTH}`, init: IOS + ACTIVE }, 'iOS app, bmb:libre_active=1 and an OAuth landing');

section('4. The service worker never caches the WASM');
{
  const c = await open({ name: 'sw', url: `${APP}/privacy` });
  // The first document is fetched before the worker controls the page.
  await c.page.until(`navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true)`, 20000);
  await c.page.send('Page.reload');
  const controlled = await c.page.until(`!!navigator.serviceWorker.controller`, 20000);
  t.ok('the worker controls the page', !!controlled);
  const r = await c.page.js(`(async () => {
    const w = await fetch('/liblightningjs.wasm'); await w.arrayBuffer();
    const m = await fetch('/manifest.json'); await m.text();
    await new Promise((res) => setTimeout(res, 1000));
    return { wasm: w.status, wasmCached: !!(await caches.match('/liblightningjs.wasm')), manifestCached: !!(await caches.match('/manifest.json')) };
  })()`);
  t.equal('/liblightningjs.wasm is served (postinstall copied it)', r?.wasm, 200);
  t.equal('...and is NOT in any cache', r?.wasmCached, false);
  t.equal('a same-origin file beside it IS cached (the worker was caching)', r?.manifestCached, true);
  await c.b.close();
}

if (ON) {
  section('5. The error card sits above the dock (phone emulation, 390×844)');
  const c = await open({ name: 'card', url: EPISODE, init: ACTIVE, blockChunk: true, phone: true });
  t.ok('a failed load puts the error card up', !!(await c.page.until(`!!document.querySelector('[data-libre-error]')`, 30000)));
  const geo = () => c.page.js(`(() => {
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
    const card = r(document.querySelector('${HOST}'));
    const nav = r(document.querySelector('nav[aria-label="Main"]'));
    const mini = r(document.querySelector('${MINI_BAR}'));
    const btn = [...document.querySelectorAll('${HOST} button')].find((x) => /try again/i.test(x.textContent));
    return { card, nav, mini, btn: r(btn), vh: innerHeight, vw: innerWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  })()`);
  let g = await geo();
  t.ok('the card is inside the viewport', g.card && g.card.top >= 0 && g.card.right <= g.vw && g.card.left >= 0, JSON.stringify(g.card));
  t.ok('the card ends above the tab bar', g.card && g.nav && g.card.bottom <= g.nav.top, `card ${g.card?.bottom} vs tab bar top ${g.nav?.top}`);
  t.equal('no sideways scroll', g.overflow <= 0, true);
  t.ok('"Try again" is at least 24×24', g.btn && g.btn.w >= 24 && g.btn.h >= 24, JSON.stringify(g.btn));

  // Put a mini-bar on screen: play the episode.
  await c.page.until(`[...document.querySelectorAll('button')].some((x) => /^\\s*(▶|PLAY)/i.test(x.textContent))`, 60000);
  await c.page.js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^\\s*(▶|PLAY)/i.test(x.textContent)); b && b.click(); return !!b; })()`);
  const bar = await c.page.until(`!!document.querySelector('${MINI_BAR}')`, 20000);
  t.ok('playing puts the mini-bar on screen', !!bar);
  await wait(1500);
  g = await geo();
  t.ok('the card ends above the mini-bar', g.card && g.mini && g.card.bottom <= g.mini.top, `card ${g.card?.bottom} vs mini-bar top ${g.mini?.top}`);
  t.ok('...and is still inside the viewport', g.card && g.card.top >= 0, JSON.stringify(g.card));
  const centre = await c.page.js(`(() => { const b = document.querySelector('${HOST}').getBoundingClientRect();
    const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e && !!e.closest('${HOST}'); })()`);
  t.ok('the card is on top at its own centre', centre === true);

  // The expanded player (z-50) must cover it.
  await c.page.js(`(() => { document.querySelector('${MINI_BAR}').click(); return 1; })()`);
  await c.page.until(`!!document.querySelector('button[aria-label="Close fullscreen player"]')`, 10000);
  await wait(800);
  const covered = await c.page.js(`(() => { const b = document.querySelector('${HOST}').getBoundingClientRect();
    const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e && !e.closest('${HOST}'); })()`);
  t.ok('the fullscreen player covers the card', covered === true);
  await c.b.close();
}

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
