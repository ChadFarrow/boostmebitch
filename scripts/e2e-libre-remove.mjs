// e2e: "Sign out & remove from this device" (removeLibreFromDevice,
// docs/wallets.md "Libre Wallet").
//
// The action deletes the Libre wallet from this browser: the package's six
// IndexedDB stores and its own localStorage / sessionStorage keys, after the
// node was disposed (which saves its last state and releases the Drive lease),
// then a reload. This drives it from the wallet modal against a FAKE Libre (the
// script serves its own webpack chunk in place of @libre/wallet-embed's, as
// e2e:librewallet does) over SEEDED fake wallet data, and then lists what the
// REAL package writes on mount, so a pin bump that adds a store or a key shows.
//
//   NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID=e2e-libre-fake.apps.googleusercontent.com npm run build
//   npx next start -p 3418 -H 127.0.0.1
//   APP_URL=http://127.0.0.1:3418 npm run e2e:libreremove
//
// Nothing leaves this machine: every /api/* request is answered by this
// script, every other host resolves to NOTFOUND, the "wallet data" is made-up
// bytes in a throwaway Chrome profile, and nobody signs in.
//
// Sections:
//   1. Cancel in the confirm: nothing is disposed, nothing is deleted.
//   2. Confirm: the node is disposed BEFORE the wipe, the page reloads, every
//      store and key of the package is emptied or gone, the stores it never
//      had are NOT created, and every other store and key (bmb:*, another
//      app's database, an unrelated libre_ key) stays. The adoption is gone, so
//      the reload loads no wallet chunk.
//   3. The button and the confirm at phone size.
//   4. The REAL package on mount: every database and key it writes is one the
//      wipe covers.
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

// What the wipe must remove, from the pinned bundle (lib/v4v/libre.ts names
// each). Written out again here on purpose: the script checks the code.
const LIBRE_DBS = ['libre-wallet-mainnet', 'libre-wallet-testnet', 'libre-wallet-signet', 'libre-wallet-regtest', 'libre-wallet-meta', 'libre-wallet'];
const GONE_LOCAL = ['libre_drive_hint', 'libre_drive_configured', 'libre_state_version_hwm:mainnet', 'libre_state_version_hwm:signet', 'libre_embed:libre_webln_grants'];
const GONE_SESSION = ['libre_drive_oauth_state'];
const coveredLocal = (k) => ['libre_drive_hint', 'libre_drive_configured'].includes(k) || k.startsWith('libre_state_version_hwm:') || k.startsWith('libre_embed:');
// What must stay: this app's keys, another app's database, an unrelated libre_ key.
const KEPT_LOCAL = { 'bmb:share_nostr': '0', 'bmb:rail_pref': 'webln', libre_ui_network: 'mainnet' };
const OTHER_DB = 'e2e-other-app';
// A real wallet has run on one network: seed three of the six stores, so the
// wipe meets databases that do not exist (it must not create them).
const SEEDED_DBS = ['libre-wallet-mainnet', 'libre-wallet-meta', 'libre-wallet'];
const seededCount = (n) => LIBRE_DBS.map((d) => (SEEDED_DBS.includes(d) ? n : null));

const SHOW_GUID = 'b0a50000-0000-4000-8000-000000000003';
const SHOW = { id: 900995, podcastGuid: SHOW_GUID, title: 'E2E Libre Remove Show', author: 'e2e', medium: 'podcast', url: 'https://feeds.example.invalid/libre-remove.xml' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(u) {
  if (u.pathname === '/api/by-guid') return { podcast: SHOW };
  if (u.pathname === '/api/feed') return { podcast: SHOW, episodes: [] };
  if (u.pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}

/**
 * Seeds ONCE per tab (a sessionStorage mark, which the wipe does not touch):
 * made-up wallet data in every store the package uses, its keys, and the
 * controls. The fake handle's dispose() records how many records the mainnet
 * store held at that moment: the wipe must come AFTER it.
 */
const stubs = ({ seed }) => `(() => {
  const n = Number(sessionStorage.getItem('__e2e_loads') || 0) + 1;
  sessionStorage.setItem('__e2e_loads', String(n));
  window.__loadNo = n;
  const put = (db, store, key, value) => new Promise((resolve) => {
    const r = indexedDB.open(db, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onsuccess = () => { const tx = r.result.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = () => { r.result.close(); resolve(); }; };
    r.onerror = () => resolve();
  });
  // null for a database that does not exist: counting must not create one.
  window.__count = async (db, store) => (await indexedDB.databases()).some((x) => x.name === db) ? new Promise((resolve) => {
    const r = indexedDB.open(db);
    r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains(store)) { d.close(); resolve(-1); return; } const q = d.transaction(store).objectStore(store).count(); q.onsuccess = () => { d.close(); resolve(q.result); }; q.onerror = () => { d.close(); resolve(-2); }; };
    r.onerror = () => resolve(-3);
  }) : null;
  if (${seed ? 'true' : 'false'} && !sessionStorage.getItem('__e2e_seeded')) {
    sessionStorage.setItem('__e2e_seeded', '1');
    localStorage.clear();
    localStorage.setItem('bmb:libre_active', '1');
    for (const [k, v] of Object.entries(${JSON.stringify(KEPT_LOCAL)})) localStorage.setItem(k, v);
    for (const k of ${JSON.stringify(GONE_LOCAL)}) localStorage.setItem(k, 'e2e');
    for (const k of ${JSON.stringify(GONE_SESSION)}) sessionStorage.setItem(k, 'e2e');
    window.__seeded = Promise.all([
      ...${JSON.stringify(SEEDED_DBS)}.map((db) => put(db, 'settings', 'e2e-seed', 'made-up bytes')),
      put(${JSON.stringify(OTHER_DB)}, 'settings', 'keep', 'another app'),
    ]);
  }
  window.__fakeMount = (home) => {
    const el = document.createElement('libre-wallet');
    el.style.cssText = 'display:block;min-height:40px';
    el.textContent = 'fake libre widget';
    home.appendChild(el);
    const preimage = '00'.repeat(32);
    return {
      webln: { async enable() {}, async isEnabled() { return true; }, async getInfo() { return { methods: [] }; }, async keysend() { return { preimage }; }, async sendPayment() { return { preimage }; } },
      installedWebln: false, element: el,
      state: () => ({ view: 'running' }),
      onState() { return () => {}; },
      getTransactions: async () => [], onTransaction: () => () => {},
      dispose: async () => {
        const seen = await window.__count('libre-wallet-mainnet', 'settings');
        const prev = JSON.parse(sessionStorage.getItem('__e2e_dispose') || '{"n":0}');
        sessionStorage.setItem('__e2e_dispose', JSON.stringify({ n: prev.n + 1, recordsAtDispose: seen }));
        el.remove();
      },
    };
  };
})();`;

async function open(name, opts) {
  const b = await launchChrome({
    name: `libreremove-${name}`,
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
  await page.send('Page.navigate', { url: `${APP}/?podcast=${SHOW_GUID}` });
  await page.until(`document.readyState === 'complete'`, 30000);
  await page.js(`(window.__seeded || Promise.resolve()).then(() => 1)`);
  return { b, page, errors, chunkServed: () => chunkServed, resetChunks: () => { chunkServed = 0; } };
}

const LAST = `[...document.querySelectorAll('[role="dialog"]')].at(-1)`;
const REMOVE = `document.querySelector('[data-libre-remove]')`;
const openLibreCard = async (page) => {
  await page.until(`!!document.querySelector('button[aria-label="Manage Lightning wallet"]')`, 20000);
  await page.js(`document.querySelector('button[aria-label="Manage Lightning wallet"]').click(); 1`);
  return !!(await page.until(`!!${REMOVE}`, 8000));
};
const confirmButton = (label) => `[...(${LAST}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
const counts = (page) => page.js(`Promise.all(${JSON.stringify([...LIBRE_DBS, OTHER_DB])}.map((d) => window.__count(d, 'settings'))).then((a) => JSON.stringify(a))`).then(JSON.parse);

// ---------------------------------------------------------------------------
section('1. Cancel in the confirm: nothing disposed, nothing deleted');
{
  const c = await open('cancel', { seed: true });
  t.ok('the adopted (fake) Libre runs and the wallet modal opens on its card', await openLibreCard(c.page));
  t.equal('the remove button is enabled while the node runs', await c.page.js(`${REMOVE}.disabled`), false);
  await c.page.js(`${REMOVE}.click(); 1`);
  t.ok('a press opens an in-app confirm over the wallet modal', !!(await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 2 && !!(${confirmButton('Remove from this device')})`, 5000)));
  t.ok('...that names the recovery phrase', /recovery\s+phrase/i.test(await c.page.js(`${LAST}.innerText`)));
  // dispose() swallows a failed Drive save at the pin, so the copy says so.
  t.ok('...and does not promise the Drive save', /cannot see whether that save worked/i.test(await c.page.js(`${LAST}.innerText`)));
  t.equal('...and focuses Cancel, not the erase', await c.page.js(`document.activeElement?.textContent?.trim()`), 'Cancel');
  await c.page.js(`(${confirmButton('Cancel')}).click(); 1`);
  await c.page.until(`document.querySelectorAll('[role="dialog"]').length === 1`, 5000);
  await wait(800);
  t.equal('Cancel: no dispose', await c.page.js(`sessionStorage.getItem('__e2e_dispose')`), null);
  t.equal('...no reload', await c.page.js('window.__loadNo'), 1);
  t.equal('...every seeded store still holds its record', await counts(c.page), [...seededCount(1), 1]);
  t.equal('...the adoption stays', await c.page.js(`localStorage.getItem('bmb:libre_active')`), '1');
  t.ok('...and the wallet modal is still on the Libre card', !!(await c.page.js(`!!${REMOVE}`)));
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('2. Confirm: dispose, then the wipe, then a reload');
{
  const c = await open('confirm', { seed: true });
  t.ok('the wallet modal opens on the Libre card', await openLibreCard(c.page));
  await c.page.js(`${REMOVE}.click(); 1`);
  await c.page.until(`!!(${confirmButton('Remove from this device')})`, 5000);
  c.resetChunks();
  await c.page.js(`(${confirmButton('Remove from this device')}).click(); 1`);
  const reloaded = await c.page.until(`window.__loadNo === 2 && document.readyState === 'complete'`, 20000);
  t.ok('the page reloads', !!reloaded);
  await wait(1500);
  const d = JSON.parse((await c.page.js(`sessionStorage.getItem('__e2e_dispose')`)) ?? 'null');
  t.equal('the node was disposed once, BEFORE the wipe (its store still held the record)', d, { n: 1, recordsAtDispose: 1 });
  const k = await counts(c.page);
  t.equal('every seeded store of the package is empty, and the three it never had were not created', k.slice(0, 6), seededCount(0));
  const names = await c.page.js(`indexedDB.databases().then((a) => JSON.stringify(a.map((x) => x.name).sort()))`).then(JSON.parse);
  t.equal('...indexedDB.databases() lists no shell', names.filter((n) => n.startsWith('libre') && !SEEDED_DBS.includes(n)), []);
  t.equal('another app\'s database is untouched', k[6], 1);
  t.equal('the package\'s localStorage keys are gone', await c.page.js(`JSON.stringify(${JSON.stringify(GONE_LOCAL)}.filter((x) => localStorage.getItem(x) !== null))`).then(JSON.parse), []);
  t.equal('...and its sessionStorage key', await c.page.js(`JSON.stringify(${JSON.stringify(GONE_SESSION)}.filter((x) => sessionStorage.getItem(x) !== null))`).then(JSON.parse), []);
  t.equal('every other key stays (bmb:*, an unrelated libre_ key)', await c.page.js(`JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(KEPT_LOCAL))}.map((x) => [x, localStorage.getItem(x)])))`).then(JSON.parse), KEPT_LOCAL);
  t.equal('the adoption is gone', await c.page.js(`localStorage.getItem('bmb:libre_active')`), null);
  t.equal('...so the reload mounts no wallet and loads no wallet chunk', { el: await c.page.js(`!!document.querySelector('libre-wallet')`), chunk: c.chunkServed() }, { el: false, chunk: 0 });
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('3. The button and the confirm at phone size');
{
  const c = await open('phone', { seed: true, mobile: true });
  t.ok('the wallet modal opens on the Libre card', await openLibreCard(c.page));
  const size = (sel) => c.page.js(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.right)]; })()`);
  const btn = await size(REMOVE);
  t.ok('the remove button is at least 24×24 and inside the viewport', !!btn && btn[0] >= 24 && btn[1] >= 24 && btn[2] <= 390, JSON.stringify(btn));
  await c.page.js(`${REMOVE}.click(); 1`);
  await c.page.until(`!!(${confirmButton('Remove from this device')})`, 5000);
  for (const label of ['Cancel', 'Remove from this device']) {
    const s = await size(confirmButton(label));
    t.ok(`the confirm's "${label}" is at least 24×24 and inside the viewport`, !!s && s[0] >= 24 && s[1] >= 24 && s[2] <= 390, JSON.stringify(s));
  }
  t.equal('no horizontal overflow', await c.page.js('document.documentElement.scrollWidth - document.documentElement.clientWidth'), 0);
  await c.page.js(`(${confirmButton('Cancel')}).click(); 1`);
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

// ---------------------------------------------------------------------------
section('4. The REAL package on mount: everything it writes is covered');
{
  const c = await open('real', { realChunk: true, seed: false });
  await c.page.js(`localStorage.setItem('bmb:libre_active', '1'); location.reload(); 1`);
  await c.page.until(`window.__loadNo >= 2 && document.readyState === 'complete'`, 20000);
  t.ok('the real element mounts', !!(await c.page.until(`typeof document.querySelector('libre-wallet')?.requestApproval === 'function'`, 30000)));
  await wait(4000);
  const w = JSON.parse(await c.page.js(`(async () => JSON.stringify({
    dbs: (await indexedDB.databases()).map((x) => x.name),
    local: Object.keys(localStorage).filter((k) => !k.startsWith('bmb:')),
    session: Object.keys(sessionStorage).filter((k) => !k.startsWith('__e2e')),
  }))()`));
  console.log(`  (written by the real package on mount: ${JSON.stringify(w)})`);
  // Without a Drive login (no real client id here) the package writes little or
  // nothing on mount: this half guards a bump that adds a store or a key at
  // mount, and the source read in lib/v4v/libre.ts stays the primary list.
  t.equal('every libre database it made is one the wipe clears', w.dbs.filter((n) => /^libre/i.test(n) && !LIBRE_DBS.includes(n)), []);
  t.equal('every localStorage key it wrote is one the wipe removes', w.local.filter((k) => /^libre/i.test(k) && !coveredLocal(k)), []);
  t.equal('every sessionStorage key it wrote is one the wipe removes', w.session.filter((k) => /^libre/i.test(k) && !GONE_SESSION.includes(k)), []);
  t.equal('no page exception', c.errors, []);
  await c.b.close();
}

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
