// e2e: the Libre wallet in the wallet screens (docs/wallets.md, "Libre Wallet").
//
// Picking Libre records a `webln` rail preference, and `isWeblnEnabled()` is
// per page load, so after a reload a running Libre read "not ready": the
// preference lost to any other connected rail in the payer, while the screens
// named Libre. `weblnLive()` is the one answer the payer, the chip and the
// modal read now. This drives the wallet modal, the chip and real boosts
// against a FAKE Libre (the script serves its own webpack chunk in place of
// @libre/wallet-embed's, as e2e:librestream does), and then the REAL package's
// approval sheet over today's modals.
//
//   NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID=e2e-libre-fake.apps.googleusercontent.com npm run build
//   npx next start -p 3418 -H 127.0.0.1
//   APP_URL=http://127.0.0.1:3418 npm run e2e:librewallet
//
// Nothing leaves this machine: every /api/* request is answered by this script
// (a fixture show whose only payee is a fake node pubkey), every other host
// resolves to NOTFOUND, both "wallets" are in-page stubs, the NWC string is
// random bytes for a relay that does not resolve, and nobody signs in, so no
// note is published (`bmb:share_nostr` is 0 as well).
//
// Sections:
//   1. A fresh connect from the picker: the element is borrowed into the
//      modal, "running" lands on the Libre card, and a boost pays Libre.
//   2. After a reload, with a `webln` preference AND an NWC connection stored:
//      Libre pays, and the "Pay via" picker names it "Libre". Libre pausing
//      shows NWC, the rail that pays then. (Section 1: with no other wallet,
//      Libre pausing under its open card keeps the widget in the modal.)
//   3. An extension enabled earlier, then Libre: no balance read reaches
//      Libre's provider (whose `enable()` opens its approval sheet) before the
//      BOOST press, and no extension number shows under Libre's name. The
//      displaced extension is offered back, and its tap hands window.webln back.
//   4. The Libre card at phone size (CDP device emulation).
//   5. The REAL package's approval sheet: on top and answerable with the host
//      collapsed, over an open boost modal, and borrowed into the wallet modal;
//      Escape denies without closing the modal behind; closing the wallet modal
//      under an open sheet still settles it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3418';
await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start it as the header says.`);

const t = checker();
const section = (s) => console.log(`\n--- ${s} ---`);

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

// A fake node pubkey: only ever handed to an in-page stub.
const NODE = `03${'cd'.repeat(32)}`;
const VALUE = { type: 'lightning', method: 'keysend', recipients: [{ name: 'E2E node', type: 'node', address: NODE, split: 100 }] };
const SHOW_GUID = 'b0a50000-0000-4000-8000-000000000002';
const ITEM_GUID = 'b0a50000-0000-4000-8000-000000000200';
const SHOW = { id: 900994, podcastGuid: SHOW_GUID, title: 'E2E Libre Wallet Show', author: 'e2e', medium: 'podcast', url: 'https://feeds.example.invalid/libre-wallet.xml', value: VALUE };
const EPISODES = [{
  id: 9400, guid: ITEM_GUID, podcastGuid: SHOW_GUID, feedId: SHOW.id, title: 'Wallet episode',
  duration: 60, enclosureUrl: 'https://media.example.invalid/wallet.mp3', datePublished: 1700000000, value: VALUE,
}];
const EPISODE_URL = `${APP}/?podcast=${SHOW_GUID}&episode=${encodeURIComponent(ITEM_GUID)}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(u) {
  if (u.pathname === '/api/by-guid') return { podcast: SHOW };
  if (u.pathname === '/api/feed') return { podcast: SHOW, episodes: EPISODES };
  if (u.pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}
// Random bytes for a relay that resolves to NOTFOUND: hasNwc() is true from
// storage alone, and nothing can answer it.
const FAKE_NWC = `nostr+walletconnect://${randomBytes(32).toString('hex')}?relay=wss%3A%2F%2Frelay.e2e.invalid&secret=${randomBytes(32).toString('hex')}`;
const EXT_SATS = 4321;

/**
 * In-page stubs, before any app script. `store` is seeded ONCE per tab (a
 * sessionStorage mark), so a reload keeps what the app wrote. Libre's fake
 * provider and the extension both count every call and pay at once.
 */
const stubs = ({ ext, store, view }) => `(() => {
  try {
    if (!sessionStorage.getItem('__e2e_seeded')) {
      sessionStorage.setItem('__e2e_seeded', '1');
      localStorage.clear();
      localStorage.setItem('bmb:share_nostr', '0');
      for (const [k, v] of Object.entries(${JSON.stringify(store ?? {})})) localStorage.setItem(k, v);
    }
  } catch {}
  const calls = window.__calls = {
    libre: { enable: 0, keysend: 0, sats: 0, sendPayment: 0, other: 0, beforeBoost: null },
    ext: { enable: 0, keysend: 0, balance: 0 },
  };
  const preimage = '00'.repeat(32);
  window.__libreProvider = {
    async enable() { calls.libre.enable++; },
    async isEnabled() { return calls.libre.enable > 0; },
    async getInfo() { calls.libre.other++; return { node: { alias: 'libre-e2e' }, methods: ['keysend', 'sendPayment'] }; },
    async keysend(a) { calls.libre.keysend++; calls.libre.sats += Number(a && a.amount) || 0; return { preimage }; },
    async sendPayment() { calls.libre.sendPayment++; throw new Error('e2e: keysend only'); },
    async makeInvoice() { calls.libre.other++; throw new Error('e2e: keysend only'); },
  };
  window.__extProvider = {
    async enable() { calls.ext.enable++; },
    async isEnabled() { return calls.ext.enable > 0; },
    async getInfo() { return { node: { alias: 'ext-e2e' }, methods: ['getInfo', 'getBalance', 'keysend'] }; },
    async getBalance() { calls.ext.balance++; return { balance: ${EXT_SATS} }; },
    async keysend() { calls.ext.keysend++; return { preimage }; },
    async sendPayment() { throw new Error('e2e: keysend only'); },
    async makeInvoice() { throw new Error('e2e: keysend only'); },
  };
  ${ext ? 'window.webln = window.__extProvider;' : ''}
  window.__fakeView = ${JSON.stringify(view ?? 'stopped')};
  window.__fakeMount = (home, opts) => {
    const el = document.createElement('libre-wallet');
    el.style.cssText = 'display:block;min-height:40px';
    el.textContent = 'fake libre widget';
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
    name: `librewallet-${name}`,
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
        if (u.pathname.endsWith(`/${CHUNK}`)) chunkServed++;
        if (u.pathname.endsWith(`/${CHUNK}`) && !opts.realChunk) {
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
  if (opts.mobile) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stubs(opts) });
  const goEpisode = async () => {
    await page.send('Page.navigate', { url: EPISODE_URL });
    return !!(await page.until(`!!document.querySelector('button[aria-label="Boost this episode"]')`, 30000));
  };
  const c = { b, page, errors, chunkServed: () => chunkServed, goEpisode };
  c.calls = async () => JSON.parse(await page.js('JSON.stringify(window.__calls)'));
  c.webln = () => page.js(`window.webln === window.__libreProvider ? 'libre' : window.webln === window.__extProvider ? 'ext' : typeof window.webln`);
  c.dialogs = () => page.js(`document.querySelectorAll('[role="dialog"]').length`);
  c.heading = () => page.js(`${LAST}?.querySelector('h3')?.textContent ?? null`);
  c.rows = () => page.js(`[...(${LAST}?.querySelectorAll('button.card') ?? [])].map((b) => b.textContent.replace(/\\s+/g, ' ').trim())`);
  c.tapRow = (title) => page.js(`(() => { const b = [...(${LAST}?.querySelectorAll('button.card') ?? [])].find((x) => x.textContent.includes(${JSON.stringify(title)})); if (!b) return false; b.click(); return true; })()`);
  c.click = (text, scope = LAST) => page.js(`(() => { const b = [...(${scope}?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
  c.chipTitles = () => page.js(`[...document.querySelectorAll('[title*=" sats ("]')].map((e) => e.title)`);
  c.libreParent = () => page.js(`(() => { const el = document.querySelector('libre-wallet'); if (!el) return 'none'; return el.closest('[role="dialog"]') ? (el.closest('[data-libre-slot]') ? 'modal-slot' : 'modal') : 'home'; })()`);
  c.openBoost = async () => {
    await page.js(`document.querySelector('button[aria-label="Boost this episode"]').click()`);
    return !!(await page.until(`!!(${FIELD})`, 20000));
  };
  c.pressedRail = () => page.js(`[...(${BOOST}?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map((b) => b.textContent.trim()).find((x) => ['NWC', 'Spark', 'WebLN', 'Libre'].includes(x)) ?? null`);
  c.offeredRails = () => page.js(`[...(${BOOST}?.querySelectorAll('button[aria-pressed]') ?? [])].map((b) => b.textContent.trim()).filter((x) => ['NWC', 'Spark', 'WebLN', 'Libre'].includes(x))`);
  /** Types 100, presses SEND, and waits for the boost modal to close on its own. */
  c.sendBoost = async () => {
    await page.js(`(() => { const f = ${FIELD}; f.blur(); f.focus(); f.select(); return 1; })()`);
    await wait(50);
    await page.send('Input.insertText', { text: '100' });
    await wait(200);
    const ready = await page.until(`!!(${SEND}) && !(${SEND}).disabled`, 30000);
    if (!ready) return false;
    await page.js(`window.__calls.libre.beforeBoost = window.__calls.libre.enable; (${SEND}).click(); 1`);
    return !!(await page.until(`document.querySelectorAll('[role="dialog"]').length === 0`, 60000));
  };
  c.why = async () => `dialog: ${String(await page.js(`${LAST}?.innerText ?? 'closed'`)).replace(/\s+/g, ' ').slice(-300)}`;
  return c;
}

const LAST = `[...document.querySelectorAll('[role="dialog"]')].at(-1)`;
const BOOST = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('input[inputmode="numeric"], input[type="number"]'))`;
const FIELD = `${BOOST}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const SEND = `[...(${BOOST}?.querySelectorAll('button') ?? [])].find((b) => /^send \\d+ sats?$/i.test(b.textContent.trim()))`;

/** From the boost modal, its ⚡ button opens the wallet modal on top. */
async function openWalletFromBoost(c) {
  const ok = await c.page.js(`(() => { const b = [...(${BOOST}?.querySelectorAll('button') ?? [])].find((x) => /⚡ (NO WALLET|WALLET)/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
  return ok && !!(await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 2`, 10000));
}
const closeTop = (c) => c.page.js(`(() => { const b = ${LAST}?.querySelector('button[aria-label="Close"]'); if (!b) return false; b.click(); return true; })()`);

// ---------------------------------------------------------------------------
section('1. A fresh connect from the picker borrows the element, and a boost pays Libre');
{
  const c = await open('fresh', { store: {} });
  t.ok('the episode page opens', await c.goEpisode());
  t.equal('no wallet chunk before anything asks for Libre', c.chunkServed(), 0);
  t.ok('the boost modal opens', await c.openBoost());
  t.ok('its ⚡ button opens the wallet modal on top', await openWalletFromBoost(c), await c.why());
  const rows = await c.rows();
  t.ok('the picker offers a Libre Wallet row', rows.some((r) => r.includes('Libre Wallet')), JSON.stringify(rows));
  t.ok('...last', (rows.at(-1) ?? '').includes('Libre Wallet'), JSON.stringify(rows));
  t.equal('no WebLN row with no extension', rows.some((r) => r.includes('WebLN')), false);
  t.ok('a tap on Libre', await c.tapRow('Libre Wallet'));
  t.ok('...loads the wallet chunk and mounts the element', !!(await c.page.until(`!!document.querySelector('libre-wallet')`, 20000)) && c.chunkServed() > 0);
  t.ok('...borrowed into the wallet modal\'s slot', !!(await c.page.until(`document.querySelector('libre-wallet')?.closest('[data-libre-slot]') !== null`, 5000)), await c.libreParent());
  t.equal('the heading is "Libre Wallet"', await c.heading(), 'Libre Wallet');
  await c.page.js(`window.__fakeLibre.emit('running'); 1`);
  t.ok('"running": Libre takes window.webln', !!(await c.page.until(`window.webln === window.__libreProvider`, 5000)));
  t.ok('...and the modal lands on the Libre card', !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 5000)), await c.why());
  t.equal('...still headed "Libre Wallet"', await c.heading(), 'Libre Wallet');
  t.equal('...with the element still in its slot', await c.libreParent(), 'modal-slot');
  t.ok('...a "Sign out (keep wallet here)" button', !!(await c.page.js(`[...(${LAST}?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === 'Sign out (keep wallet here)')`)));
  t.equal('...and no stream-rate control', await c.page.js(`/streaming/i.test(${LAST}?.querySelector('[data-libre-no-stream]')?.textContent ?? '') && ![...(${LAST}?.querySelectorAll('input[type="range"]') ?? [])].length`), true);
  t.ok('closing the wallet modal', await closeTop(c));
  t.ok('...parks the element at home', !!(await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 1 && !document.querySelector('libre-wallet')?.closest('[role="dialog"]')`, 5000)), await c.libreParent());
  t.equal('the preference is unset (a fresh connect records none)', await c.page.js(`localStorage.getItem('bmb:rail_pref')`), null);
  t.equal('no chip number (the provider has no balance)', await c.chipTitles(), []);
  t.ok('the boost completes', await c.sendBoost(), await c.why());
  const k = await c.calls();
  t.ok('Libre paid the leg', k.libre.keysend > 0 && k.libre.sats >= 100, JSON.stringify(k.libre));
  t.equal('Libre was enabled only by the BOOST press', { before: k.libre.beforeBoost, after: k.libre.enable }, { before: 0, after: 1 });
  t.equal('the preference names the rail that paid', await c.page.js(`localStorage.getItem('bmb:rail_pref')`), 'webln');
  t.ok('the Libre card again', await c.page.js(`(() => { const b = document.querySelector('button[aria-label="Manage Lightning wallet"]'); if (!b) return false; b.click(); return true; })()`)
    && !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 8000)), await c.why());
  // Libre roams away (paused) with no other wallet: no rail is active, but
  // its answer is in the widget, which must stay in front of the person.
  await c.page.js(`window.__fakeLibre.emit('paused'); 1`);
  t.ok('Libre pauses: it lets go of window.webln', !!(await c.page.until(`window.webln !== window.__libreProvider`, 5000)));
  await wait(300);
  t.equal('...the modal keeps the Libre slot (not the picker)', { heading: await c.heading(), where: await c.libreParent() }, { heading: 'Libre Wallet', where: 'modal-slot' });
  await c.page.js(`window.__fakeLibre.emit('running'); 1`);
  t.ok('...and lands on the Libre card when it runs again', !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 5000)), await c.why());
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('2. After a reload: a webln preference and an NWC connection, and Libre pays');
{
  const store = { 'bmb:libre_active': '1', 'bmb:rail_pref': 'webln', 'bmb:nwc_uri': FAKE_NWC };
  const c = await open('reload', { store, view: 'running' });
  t.ok('the episode page opens', await c.goEpisode());
  t.ok('the adopted Libre mounts and takes window.webln', !!(await c.page.until(`window.webln === window.__libreProvider`, 20000)));
  t.equal('the NWC connection is still stored (a reload is not an adoption)', await c.page.js(`!!localStorage.getItem('bmb:nwc_uri')`), true);
  t.ok('the boost modal opens', await c.openBoost());
  t.equal('"Pay via" offers NWC and Libre', await c.offeredRails(), ['NWC', 'Libre']);
  t.equal('...with Libre selected, as the preference says', await c.pressedRail(), 'Libre');
  t.ok('the boost completes', await c.sendBoost(), await c.why());
  const k = await c.calls();
  t.ok('Libre paid the leg, not NWC', k.libre.keysend > 0, JSON.stringify(k.libre));
  t.ok('a second reload', await c.goEpisode());
  await c.page.until(`window.webln === window.__libreProvider`, 20000);
  t.ok('...the wallet modal opens on the Libre card', await c.page.js(`(() => { const b = document.querySelector('button[aria-label="Manage Lightning wallet"]'); if (!b) return false; b.click(); return true; })()`)
    && !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 8000)), await c.why());
  t.equal('...headed "Libre Wallet"', await c.heading(), 'Libre Wallet');
  t.ok('Switch wallet → lists NWC as connected and no WebLN row', await c.click('Switch wallet') && !!(await c.page.until(`${LAST}?.querySelector('h3')?.textContent === 'Switch wallet'`, 5000)));
  const rows = await c.rows();
  t.equal('...no WebLN row while Libre holds window.webln (nothing displaced)', rows.some((r) => r.includes('WebLN')), false);
  await closeTop(c);
  await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 0`, 5000);
  t.ok('the Libre card again', await c.page.js(`(() => { const b = document.querySelector('button[aria-label="Manage Lightning wallet"]'); if (!b) return false; b.click(); return true; })()`)
    && !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 8000)), await c.why());
  // Libre pauses with NWC still connected: NWC is the payer now, so the
  // modal shows NWC's card — the truth about which wallet would pay.
  await c.page.js(`window.__fakeLibre.emit('paused'); 1`);
  t.ok('Libre pauses: it lets go of window.webln', !!(await c.page.until(`window.webln !== window.__libreProvider`, 5000)));
  t.ok('...the modal shows NWC, the rail that pays now', !!(await c.page.until(`${LAST}?.querySelector('h3')?.textContent === 'NWC'`, 5000)), String(await c.heading()));
  await c.page.js(`window.__fakeLibre.emit('running'); 1`);
  t.ok('...and the Libre card when Libre runs again (the preference)', !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 5000)), await c.why());
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('3. An extension enabled first, then Libre: no read asks Libre, no stale number');
{
  const c = await open('displace', { ext: true, store: {} });
  t.ok('the episode page opens', await c.goEpisode());
  t.ok('the boost modal opens', await c.openBoost());
  t.ok('the wallet modal opens', await openWalletFromBoost(c));
  t.ok('a tap on WebLN enables the extension', await c.tapRow('WebLN') && !!(await c.page.until(`window.__calls.ext.enable > 0`, 5000)));
  await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 1`, 5000);
  await closeTop(c);
  await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 0`, 5000);
  t.ok('the chip shows the extension\'s balance', !!(await c.page.until(`[...document.querySelectorAll('[title*=" sats ("]')].some((e) => e.title === '${EXT_SATS.toLocaleString('en-US')} sats (WebLN)')`, 8000)), JSON.stringify(await c.chipTitles()));
  t.ok('the wallet modal opens on the WebLN card', await c.page.js(`(() => { const b = document.querySelector('button[aria-label="Manage Lightning wallet"]'); if (!b) return false; b.click(); return true; })()`)
    && !!(await c.page.until(`${LAST}?.querySelector('h3')?.textContent === 'WebLN'`, 5000)), await c.why());
  t.ok('Switch wallet → Libre', await c.click('Switch wallet') && !!(await c.page.until(`${LAST}?.querySelector('h3')?.textContent === 'Switch wallet'`, 5000)) && await c.tapRow('Libre Wallet'));
  t.ok('...mounts the element in the modal', !!(await c.page.until(`document.querySelector('libre-wallet')?.closest('[data-libre-slot]') !== null`, 20000)));
  await c.page.js(`window.__fakeLibre.emit('running'); 1`);
  t.ok('"running": Libre takes window.webln from the extension', !!(await c.page.until(`window.webln === window.__libreProvider`, 5000)));
  t.ok('...the Libre card shows', !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 5000)), await c.why());
  // Every refresh the chip has: a wallet notification, a tab return, a focus.
  await c.page.js(`window.dispatchEvent(new Event('webln:ready')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); 1`);
  await wait(3000);
  let k = await c.calls();
  t.equal('Libre\'s provider was never asked anything (its enable() is the approval sheet)', { enable: k.libre.enable, keysend: k.libre.keysend, other: k.libre.other }, { enable: 0, keysend: 0, other: 0 });
  t.equal('no number under any rail name (the extension\'s 4,321 is not Libre\'s)', await c.chipTitles(), []);
  await closeTop(c);
  await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 0`, 5000);
  t.equal('...nor after the modal closes', await c.chipTitles(), []);
  t.ok('the boost modal opens', await c.openBoost());
  t.equal('...no number in it either', await c.page.js(`/${EXT_SATS.toLocaleString('en-US')}/.test(${BOOST}?.innerText ?? '')`), false);
  t.ok('the boost completes', await c.sendBoost(), await c.why());
  k = await c.calls();
  t.equal('Libre was enabled by the BOOST press, not before', { before: k.libre.beforeBoost, after: k.libre.enable }, { before: 0, after: 1 });
  t.ok('...and paid the leg', k.libre.keysend > 0, JSON.stringify(k.libre));
  t.equal('...and the extension paid nothing', k.ext.keysend, 0);
  t.ok('the wallet modal → Switch wallet offers the displaced extension', await c.page.js(`(() => { const b = document.querySelector('button[aria-label="Manage Lightning wallet"]'); if (!b) return false; b.click(); return true; })()`)
    && !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 5000)) && await c.click('Switch wallet'));
  await c.page.until(`${LAST}?.querySelector('h3')?.textContent === 'Switch wallet'`, 5000);
  const rows = await c.rows();
  t.ok('...by name, as a switch away from Libre', rows.some((r) => r.includes('WebLN') && r.includes('instead of Libre')), JSON.stringify(rows));
  t.ok('its tap', await c.tapRow('WebLN'));
  t.ok('...hands window.webln back to the extension', !!(await c.page.until(`window.webln === window.__extProvider`, 5000)));
  t.equal('...forgets the adoption', await c.page.js(`localStorage.getItem('bmb:libre_active')`), null);
  t.equal('...and enables the extension, not Libre', (await c.calls()).libre.enable, 1);
  t.ok('the chip shows the extension\'s balance again', !!(await c.page.until(`[...document.querySelectorAll('[title*=" sats ("]')].some((e) => e.title === '${EXT_SATS.toLocaleString('en-US')} sats (WebLN)')`, 8000)), JSON.stringify(await c.chipTitles()));
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('4. The Libre card at phone size');
{
  const c = await open('phone', { mobile: true, store: { 'bmb:libre_active': '1' }, view: 'running' });
  t.ok('the episode page opens', await c.goEpisode());
  await c.page.until(`window.webln === window.__libreProvider`, 20000);
  t.ok('the wallet modal opens on the Libre card', await c.page.js(`(() => { const b = document.querySelector('button[aria-label="Manage Lightning wallet"]'); if (!b) return false; b.click(); return true; })()`)
    && !!(await c.page.until(`!!${LAST}?.querySelector('[data-libre-no-stream]')`, 8000)), await c.why());
  const m = await c.page.js(`(() => {
    const d = ${LAST};
    const size = (txt) => { const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(txt)); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const card = d.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, cardRight: Math.round(card.right), vw: innerWidth,
      signOut: size('Sign out (keep wallet here)'), switchBtn: size('Switch wallet'), close: (() => { const b = d.querySelector('button[aria-label="Close"]'); const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() };
  })()`);
  t.equal('no horizontal overflow', m.overflow, 0);
  t.ok('the card fits the viewport', m.cardRight <= m.vw, JSON.stringify(m));
  for (const k of ['signOut', 'switchBtn', 'close']) t.ok(`${k} is at least 24×24`, !!m[k] && m[k][0] >= 24 && m[k][1] >= 24, JSON.stringify(m[k]));
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('5. The REAL package\'s approval sheet over today\'s modals');
{
  const c = await open('sheet', { realChunk: true, store: { 'bmb:libre_active': '1' } });
  t.ok('the episode page opens', await c.goEpisode());
  const mounted = await c.page.until(`typeof document.querySelector('libre-wallet')?.requestApproval === 'function'`, 30000);
  t.ok('the real element mounts and has requestApproval', !!mounted, await c.libreParent());
  if (mounted) {
    await wait(1500);
    const hostState = await c.page.js(`(() => { const el = document.querySelector('libre-wallet'); const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), where: el.closest('[role="dialog"]') ? 'modal' : 'home' }; })()`);
    console.log(`  (the real element at rest: ${JSON.stringify(hostState)})`);
    // Opens a request and reports whether the sheet is the top-layer modal and
    // what sits at its centre. `window.__sheet` holds the decision once it settles.
    const ask = () => c.page.js(`(() => {
      window.__sheet = { settled: false, decision: null };
      document.querySelector('libre-wallet').requestApproval({ kind: 'enable', origin: location.origin })
        .then((d) => { window.__sheet = { settled: true, decision: d }; });
      return 1;
    })()`);
    const look = () => c.page.js(`(() => {
      const root = document.querySelector('libre-wallet').shadowRoot;
      const d = root.querySelector('dialog');
      if (!d) return { dialog: false };
      const r = d.getBoundingClientRect();
      const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      return { dialog: true, open: d.open, modal: d.matches(':modal'), w: Math.round(r.width), h: Math.round(r.height),
        hitInside: !!hit && d.contains(hit), topIsHost: top === document.querySelector('libre-wallet') };
    })()`);
    const answerSheet = async (tag, how) => {
      const before = await c.dialogs();
      await ask();
      await wait(300);
      const l = await look();
      t.ok(`${tag}: the sheet is open as the top-layer modal`, l.open && l.modal && l.w > 100 && l.h > 50, JSON.stringify(l));
      t.ok(`${tag}: its centre is the sheet, above every app layer`, l.hitInside && l.topIsHost, JSON.stringify(l));
      await c.page.js(`(() => { const i = document.querySelector('libre-wallet').shadowRoot.querySelector('dialog input.field'); i.focus(); return 1; })()`);
      await c.page.send('Input.insertText', { text: '500' });
      await wait(100);
      t.equal(`${tag}: the limit input takes focus and text`, await c.page.js(`(() => { const r = document.querySelector('libre-wallet').shadowRoot; const i = r.querySelector('dialog input.field'); return { focused: r.activeElement === i, value: i.value }; })()`), { focused: true, value: '500' });
      if (how === 'cancel') {
        await c.page.js(`[...document.querySelector('libre-wallet').shadowRoot.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Cancel').click(); 1`);
      } else {
        await c.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
      t.ok(`${tag}: ${how} settles it as a denial`, !!(await c.page.until(`window.__sheet.settled && window.__sheet.decision && window.__sheet.decision.granted === false`, 3000)), JSON.stringify(await c.page.js('window.__sheet')));
      await wait(300);
      t.equal(`${tag}: the modal behind is still open`, await c.dialogs(), before);
    };

    await answerSheet('A. host collapsed', 'cancel');
    await answerSheet('A. host collapsed', 'Escape');

    t.ok('the boost modal opens', await c.openBoost());
    await answerSheet('B. over the boost modal', 'cancel');
    await answerSheet('B. over the boost modal', 'Escape');

    t.ok('the wallet modal opens from it', await openWalletFromBoost(c), await c.why());
    if ((await c.heading()) !== 'Libre Wallet') await c.tapRow('Libre Wallet');
    t.ok('...on the Libre slot, with the real element borrowed', !!(await c.page.until(`document.querySelector('libre-wallet')?.closest('[data-libre-slot]') !== null`, 8000)), await c.why());
    await answerSheet('C. borrowed into the wallet modal', 'cancel');
    await answerSheet('C. borrowed into the wallet modal', 'Escape');

    // The modal goes away under an open sheet (a back press, a route change):
    // the element is moved home, and a moved <dialog> leaves the top layer.
    await ask();
    await wait(300);
    await c.page.js(`history.back(); 1`);
    await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 1`, 5000);
    await wait(500);
    const after = await look();
    const s = await c.page.js('window.__sheet');
    t.ok('the wallet modal closed under the sheet', (await c.dialogs()) === 1, String(await c.dialogs()));
    t.ok('...and the sheet is either still the answerable top-layer modal, or settled as a denial', (after.open && after.modal && after.hitInside) || (s.settled && s.decision?.granted === false), JSON.stringify({ after, s }));
    t.equal('...and is not left open out of the top layer', after.open && !after.modal, false);
    await answerSheet('D. a request after that', 'cancel');
  }
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
