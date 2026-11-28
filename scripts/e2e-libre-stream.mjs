// e2e: streaming never waits on the Libre wallet's approval click
// (unattendedRailRefusal + libreHoldsWebln, docs/streaming.md "A payer that can ask").
//
// The Libre wallet's provider opens an approval sheet on first use and past its
// daily limit, and that promise settles only on a click. This drives REAL
// settles through the real engine against a FAKE Libre: the script serves its
// own webpack chunk in place of @libre/wallet-embed's, whose mountLibreWallet
// returns a handle whose provider COUNTS every call and NEVER settles one — the
// sheet nobody answers. With the guard, an unattended settle must not call it.
//
//   NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID=e2e-libre-fake.apps.googleusercontent.com npm run build
//   npx next start -p 3418 -H 127.0.0.1
//   APP_URL=http://127.0.0.1:3418 npm run e2e:librestream
//
// Nothing leaves this machine: every /api/* request is answered by this script
// (a fixture show whose only payee is a fake node pubkey, and a silent WAV), the
// wallet chunk is the fake, every other host resolves to NOTFOUND, and the two
// "wallets" are in-page stubs. So even a run with the guard removed sends
// nothing anywhere — its keysend reaches the stub that never answers.
//
// Cases:
//   1. Libre holds window.webln: the settle is refused (no provider call), the
//      item shows why, and the chain is not held. When Libre lets go, the same
//      item streams again and pays the extension Libre had displaced.
//   2. No Libre, an extension holds window.webln: the settle pays it (the
//      harness settles at all, and the guard does not over-block).
//   3. Libre mounted but NOT running (need-secret), an extension holds
//      window.webln: the settle pays the extension (identity, not "mounted").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3418';
await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start it as the header says.`);

const t = checker();
const section = (s) => console.log(`\n--- ${s} ---`);

// The real chunk, for its chunk id and module id: the fake must register the
// same module the app's dynamic import asks webpack for.
const chunkDir = join(process.cwd(), '.next/static/chunks');
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.js') ? [p] : []);
});
const real = walk(chunkDir).filter((p) => readFileSync(p, 'utf8').includes('googleClientId is required'));
if (real.length !== 1) {
  console.error(`Expected one wallet chunk in .next/static/chunks, found ${real.length}. Build with a client id (see the header).`);
  process.exit(2);
}
const CHUNK = real[0].split('/').pop();
const ids = /push\(\[\[(\d+)\],\{(\d+):/.exec(readFileSync(real[0], 'utf8'));
if (!ids) { console.error(`Could not read the chunk and module ids of ${CHUNK}.`); process.exit(2); }
const FAKE_CHUNK = `"use strict";(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[${ids[1]}],{${ids[2]}:(t,r,e)=>{e.d(r,{mountLibreWallet:()=>(...a)=>window.__fakeMount(...a)});}}]);`;

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
const AUDIO = silentWav(60);

// A fake node pubkey: only ever handed to an in-page stub.
const NODE = `03${'ab'.repeat(32)}`;
const VALUE = { type: 'lightning', method: 'keysend', recipients: [{ name: 'E2E node', type: 'node', address: NODE, split: 100 }] };
const SHOW_GUID = 'b0a50000-0000-4000-8000-000000000001';
const SHOW = { id: 900993, podcastGuid: SHOW_GUID, title: 'E2E Libre Stream Show', author: 'e2e', medium: 'podcast', url: 'https://feeds.example.invalid/libre-stream.xml', value: VALUE };
const EPISODES = [0, 1].map((k) => ({
  id: 9300 + k, guid: `b0a50000-0000-4000-8000-00000000010${k}`, podcastGuid: SHOW_GUID, feedId: SHOW.id,
  title: `Stream episode ${k}`, duration: 60, enclosureUrl: `${APP}/api/e2e-audio.wav?p=${k}`,
  datePublished: 1700000000 + k, value: VALUE,
}));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(u) {
  if (u.pathname === '/api/by-guid') return { podcast: SHOW };
  if (u.pathname === '/api/feed') return { podcast: SHOW, episodes: EPISODES };
  if (u.pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}

// 120 sats/min: ten seconds of play settles 20 sats; under two seconds on the
// next episode stays below the 10-sat floor and carries, so a settle fires only
// where the script means one to.
const RATE = 120;
const LIBRE_MSG = 'the Libre wallet can stop a payment';

/**
 * In-page stubs, before any app script. `libre` is the fake handle's provider:
 * it counts and never settles (the unanswered sheet). `ext` is an extension
 * that pays at once.
 */
const stubs = ({ ext, libre, view }) => `(() => {
  try {
    localStorage.setItem('bmb:stream_on', '1');
    localStorage.setItem('bmb:stream_rate', '${RATE}');
    ${libre ? "localStorage.setItem('bmb:libre_active', '1');" : ''}
  } catch {}
  const calls = window.__calls = { libre: { enable: 0, keysend: 0, sendPayment: 0, other: 0 }, ext: { enable: 0, keysend: 0, sats: 0, dest: [] } };
  const never = () => new Promise(() => {});
  window.__libreProvider = {
    get isEnabled() { return false; },
    enable() { calls.libre.enable++; return never(); },
    keysend() { calls.libre.keysend++; return never(); },
    sendPayment() { calls.libre.sendPayment++; return never(); },
    getInfo() { calls.libre.other++; return never(); },
    makeInvoice() { calls.libre.other++; return never(); },
  };
  const extProvider = {
    async enable() { calls.ext.enable++; },
    async keysend(a) { calls.ext.keysend++; calls.ext.sats += Number(a && a.amount) || 0; calls.ext.dest.push(a && a.destination); return { preimage: '00'.repeat(32) }; },
    async sendPayment() { return { preimage: '00'.repeat(32) }; },
    async getInfo() { return {}; },
  };
  window.__extProvider = extProvider;
  ${ext ? 'window.webln = extProvider;' : ''}
  window.__fakeView = ${JSON.stringify(view ?? 'running')};
  window.__fakeMount = (home, opts) => {
    const el = document.createElement('libre-wallet');
    home.appendChild(el);
    const listeners = new Set();
    window.__fakeLibre = { emit(v) { window.__fakeView = v; for (const f of listeners) f({ view: v }); } };
    window.__mountOpts = { installWebln: opts.installWebln };
    return {
      webln: window.__libreProvider, installedWebln: false, element: el,
      state: () => ({ view: window.__fakeView }),
      onState(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      getTransactions: async () => [], onTransaction: () => () => {}, dispose: async () => {},
    };
  };
})();`;

async function open(name, opts) {
  const b = await launchChrome({
    name: `librestream-${name}`,
    autoplay: true,
    args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
  });
  const { page } = b;
  const errors = [];
  let chunkServed = 0;
  await page.send('Network.enable');
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Fetch.enable', { patterns: [
    { urlPattern: '*/api/*', requestStage: 'Request' },
    { urlPattern: '*/_next/static/chunks/*', requestStage: 'Request' },
  ] });
  page.on(async (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
      return;
    }
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const u = new URL(request.url);
    try {
      if (u.pathname.startsWith('/_next/static/chunks/')) {
        if (u.pathname.endsWith(`/${CHUNK}`)) {
          chunkServed++;
          await page.send('Fetch.fulfillRequest', {
            requestId, responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/javascript' }],
            body: Buffer.from(FAKE_CHUNK).toString('base64'),
          });
        } else {
          await page.send('Fetch.continueRequest', { requestId });
        }
        return;
      }
      if (u.pathname === '/api/e2e-audio.wav') {
        const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
        const mm = range && /bytes=(\d+)-(\d*)/.exec(range);
        const start = mm ? Number(mm[1]) : 0;
        const end = mm && mm[2] ? Math.min(Number(mm[2]), AUDIO.length - 1) : AUDIO.length - 1;
        const body = AUDIO.subarray(start, end + 1);
        await page.send('Fetch.fulfillRequest', {
          requestId, responseCode: mm ? 206 : 200,
          responseHeaders: [
            { name: 'content-type', value: 'audio/wav' },
            { name: 'accept-ranges', value: 'bytes' },
            { name: 'content-length', value: String(body.length) },
            ...(mm ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
          ],
          body: body.toString('base64'),
        });
        return;
      }
      await page.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: b64(answer(u)),
      });
    } catch {
      // The page navigated away under a paused request.
    }
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stubs(opts) });
  await page.send('Page.navigate', { url: `${APP}/?podcast=${SHOW_GUID}` });
  await page.until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes('Stream episode 1'))`, 30000);
  await wait(500);

  const calls = async () => JSON.parse(await page.js('JSON.stringify(window.__calls)'));
  const log = async () => JSON.parse(await page.js(`JSON.stringify(Object.keys(localStorage).filter((k) => k.startsWith('bmb:streamed:')).flatMap((k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } }))`));
  const play = async (k) => {
    await page.js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Stream episode ${k}')).querySelector('button[aria-label="Play"]').click()`);
    return page.until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && /[?&]p=${k}(\\D|$)/.test(a.currentSrc); })()`, 15000);
  };
  /** Play for `secs` of AUDIO time, so the engine's min(wall, position) clock moves. */
  const listen = async (secs) => {
    const from = await page.js(`document.querySelector('audio').currentTime`);
    return page.until(`document.querySelector('audio').currentTime >= ${from + secs}`, (secs + 15) * 1000);
  };
  const webln = () => page.js(`window.webln === window.__libreProvider ? 'libre' : window.webln === window.__extProvider ? 'ext' : typeof window.webln`);
  return { b, page, calls, log, play, listen, webln, errors, chunkServed: () => chunkServed };
}

// ---------------------------------------------------------------------------
section('1. Libre holds window.webln: an unattended settle is refused before it asks');
{
  const c = await open('libre', { ext: true, libre: true, view: 'running' });
  t.ok('the fake wallet chunk was served in place of the package', !!(await c.page.until(`!!document.querySelector('libre-wallet')`, 20000)) && c.chunkServed() > 0);
  await c.page.until(`window.webln === window.__libreProvider`, 10000);
  t.equal('Libre took window.webln over the extension', await c.webln(), 'libre');
  t.ok('episode 0 plays', !!(await c.play(0)));
  t.ok('...for 10 s of audio', !!(await c.listen(10)));
  t.ok('episode 1 plays (the item change settles episode 0)', !!(await c.play(1)));
  const refused = await c.page.until(`Object.keys(localStorage).some((k) => k.startsWith('bmb:streamed:') && (localStorage.getItem(k) || '').includes(${JSON.stringify(LIBRE_MSG)}))`, 10000);
  t.ok('the settle ended in a refusal, logged once for the item', !!refused);
  // Back to episode 0 at once: episode 1 has accrued under the floor, so it carries.
  t.ok('episode 0 plays again', !!(await c.play(0)));
  let k = await c.calls();
  t.equal('Libre\'s provider was never called (no enable, keysend, sendPayment)', k.libre, { enable: 0, keysend: 0, sendPayment: 0, other: 0 });
  t.equal('...and nothing else paid', k.ext.keysend, 0);
  const entries = (await c.log()).filter((e) => (e.error || '').includes(LIBRE_MSG));
  t.equal('one failure entry, 0 sats', entries.map((e) => ({ ok: e.ok, sats: e.sats, episode: e.episodeTitle })), [{ ok: false, sats: 0, episode: 'Stream episode 0' }]);
  const stoppedTitle = `(() => { const s = [...document.querySelectorAll('${MINI_BAR} span[title]')].find((x) => /^Streaming stopped:/.test(x.title)); return s ? s.title : ''; })()`;
  await c.page.until(stoppedTitle, 8000);
  const pulse = await c.page.js(stoppedTitle);
  t.ok('the mini-bar shows WHY on the refused item', typeof pulse === 'string' && pulse.includes(LIBRE_MSG), pulse);

  // Libre lets go (it roamed away / paused): the extension it displaced is back,
  // and the refused item is armed again by the Libre notification alone —
  // WebLN was never enabled here, so no WebLN notification can do it.
  await c.page.js(`window.__fakeLibre.emit('paused'); 1`);
  t.equal('Libre handed window.webln back to the extension', await c.webln(), 'ext');
  t.ok('episode 0 streams again: 10 s of audio', !!(await c.listen(10)));
  t.ok('episode 1 plays (settles episode 0)', !!(await c.play(1)));
  const paid = await c.page.until(`window.__calls.ext.keysend > 0`, 10000);
  t.ok('the re-armed item paid the extension', !!paid);
  k = await c.calls();
  t.ok('...a real batch, to the show\'s payee', k.ext.sats >= 10 && k.ext.dest.every((d) => d === NODE), JSON.stringify(k.ext));
  t.equal('Libre\'s provider still never called', k.libre, { enable: 0, keysend: 0, sendPayment: 0, other: 0 });
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('2. No Libre, an extension holds window.webln: the settle pays it');
{
  const c = await open('ext', { ext: true, libre: false });
  t.equal('no wallet element (nothing asked for Libre)', await c.page.js(`!!document.querySelector('libre-wallet')`), false);
  t.equal('window.webln is the extension', await c.webln(), 'ext');
  t.ok('episode 0 plays for 10 s', !!(await c.play(0)) && !!(await c.listen(10)));
  t.ok('episode 1 plays (settles episode 0)', !!(await c.play(1)));
  t.ok('the extension was paid', !!(await c.page.until(`window.__calls.ext.keysend > 0`, 10000)));
  const ok = (await c.log()).filter((e) => e.ok && e.sats > 0);
  t.equal('one settled entry in the streamed log', ok.length, 1);
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('3. Libre mounted but not running: the extension keeps window.webln and streams');
{
  const c = await open('mounted', { ext: true, libre: true, view: 'need-secret' });
  t.ok('the fake wallet mounted', !!(await c.page.until(`!!document.querySelector('libre-wallet')`, 20000)));
  await wait(1000);
  t.equal('window.webln is still the extension', await c.webln(), 'ext');
  t.ok('episode 0 plays for 10 s', !!(await c.play(0)) && !!(await c.listen(10)));
  t.ok('episode 1 plays (settles episode 0)', !!(await c.play(1)));
  t.ok('the extension was paid', !!(await c.page.until(`window.__calls.ext.keysend > 0`, 10000)));
  t.equal('Libre\'s provider never called', (await c.calls()).libre, { enable: 0, keysend: 0, sendPayment: 0, other: 0 });
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
