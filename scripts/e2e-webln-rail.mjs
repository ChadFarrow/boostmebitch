// End-to-end for WHICH WALLET PAYS beside a WebLN extension, in a real browser:
// the rail a boost pays from must be the rail the header chip names.
//
// THE BUG (measured 2026-11-27 on 49858393, stub wallets, no sats). With a
// WebLN extension in the browser, an NWC wallet connected, and the stored rail
// preference `webln` (a WebLN boost stores it; the Nostr settings restore can
// bring it from another device), a page reload left the header chip and the
// wallet modal on NWC while `pickRail()` paid with the EXTENSION: boosts,
// streaming settles and note zaps. `pickRail()` took the preference when the
// extension was merely present (`hasWebln()`); the chip and the modal take it
// only when it is enabled in this page load (`isWeblnEnabled()`), which a
// reload resets. The boost modal opened with WebLN selected, below a chip that
// said NWC. Now one pure function decides (`railWhenUnnamed`, lib/util.ts,
// pinned by `npm run check:nwcerror`); this script pins the wiring around it.
//
// WHAT IT PINS (every boost is 100 sats, from the episode page, not playing):
//   1. NWC connected + preference `webln` + the extension present, after a
//      reload: the chip says NWC, the boost modal opens with NWC selected, and
//      NWC pays. The extension is never enabled and never asked to pay.
//   2. The same, after the user picked WebLN in this page load: pick WebLN in
//      the boost modal and send (WebLN pays). The NEXT boost opens on WebLN and
//      WebLN pays again, and the chip names WebLN. Then reload: section 1 again.
//      That is how the preference arises in real use.
//   3. ONLY the extension, after a reload, with preference `webln` and with no
//      preference: a boost still pays through WebLN (the last fallback).
//
// NOT DRIVEN HERE: Spark (`hasSpark()` is module state no stub reaches; the
// real-network wallet of e2e:spark is not a stub), streaming settles and note
// zaps. All of them reach the same function, which check:nwcerror pins for
// Spark too.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but the app's and
// loopback (`--host-resolver-rules`). The NWC wallet is a stub on a local relay
// that answers each keysend with a dummy preimage; WebLN is a stand-in that
// records each call and moves nothing. Nobody is signed in, "Don't post" is
// set, and every `/api/nostr/*`, `/api/keysend`, `/api/lnurl` and
// `/api/lightning/boostbox` request is refused here and counted. The SERVER
// still reads Podcast Index and the feed for Two For Tunestr's "Open Range"
// (every payee a node), so it needs `.env.local`; back-to-back runs can draw a
// Podcast Index 429.
//
//   npm run build && npx next start -p 3433 -H 127.0.0.1     # another terminal
//   APP_URL=http://127.0.0.1:3433 npm run e2e:weblnrail
//   add --headed to watch, --keep to leave it open; `ONLY=1,3` runs those sections

import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createRelay } from './local-relay.mjs';

const APP = process.env.APP_URL ?? process.env.BMB_APP ?? 'http://127.0.0.1:3000';
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range — every payee a node
const EPISODE = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
const NWC_SATS = 777_777;
const WEBLN_SATS = 123_456;
const NWC_CHIP = `${NWC_SATS.toLocaleString('en-US')} sats (NWC)`;
const WEBLN_CHIP = `${WEBLN_SATS.toLocaleString('en-US')} sats (WebLN)`;

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm run build && npx next start -p <port>\` and pass APP_URL.`);

const t = checker();
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const section = (n, s) => {
  const on = !ONLY.length || ONLY.includes(String(n));
  if (on) console.log(`\n${n}. ${s}`);
  return on;
};

// --- A stub NIP-47 wallet on a local relay ------------------------------------------
// It answers a keysend with a dummy preimage, so the boost completes on NWC and
// no leg is retried over another route. Every pay_* request is recorded.
const relay = createRelay({ port: 0, log: null });
const relayPort = await relay.ready;
const walletSk = generateSecretKey();
const walletPub = getPublicKey(walletSk);
const clientSk = generateSecretKey();
const clientPub = getPublicKey(clientSk);
const conversation = nip44.getConversationKey(walletSk, clientPub);
const METHODS = ['get_info', 'get_balance', 'pay_keysend', 'pay_invoice', 'notifications'];
const walletWs = new WebSocket(`ws://127.0.0.1:${relayPort}`);
const signAndSend = (tmpl) => walletWs.send(JSON.stringify(['EVENT', finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl }, walletSk)]));
const nwcPaid = [];
walletWs.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] !== 'EVENT' || msg[1] !== 'wallet') return;
  const e = msg[2];
  const { method, params } = JSON.parse(nip44.decrypt(e.content, conversation));
  let body;
  if (method === 'get_info') {
    body = { result_type: method, result: { methods: METHODS, notifications: ['payment_received', 'payment_sent'], alias: 'stub', pubkey: walletPub, network: 'mainnet', block_height: 1, block_hash: '00', color: '#000000' } };
  } else if (method === 'get_balance') {
    body = { result_type: method, result: { balance: NWC_SATS * 1000 } };
  } else if (method === 'pay_keysend') {
    nwcPaid.push({ method, pubkey: params?.pubkey, amount: params?.amount });
    body = { result_type: method, result: { preimage: '00'.repeat(32), fees_paid: 0 } };
  } else {
    if (method.startsWith('pay_')) nwcPaid.push({ method });
    body = { result_type: method, result: null, error: { code: 'NOT_IMPLEMENTED', message: 'e2e: not stubbed' } };
  }
  signAndSend({ kind: 23195, tags: [['p', clientPub], ['e', e.id]], content: nip44.encrypt(JSON.stringify(body), conversation) });
};
await new Promise((resolve, reject) => { walletWs.onopen = resolve; walletWs.onerror = reject; });
walletWs.send(JSON.stringify(['REQ', 'wallet', { kinds: [23194], '#p': [walletPub] }]));
signAndSend({ kind: 13194, tags: [['encryption', 'nip44_v2'], ['notifications', 'payment_received payment_sent']], content: METHODS.join(' ') });
const URI = `nostr+walletconnect://${walletPub}?relay=ws://127.0.0.1:${relayPort}&secret=${Buffer.from(clientSk).toString('hex')}`;

// --- The browser --------------------------------------------------------------------
const { page } = await launchChrome({
  name: 'webln-rail',
  args: ['--disable-gpu', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ${new URL(APP).hostname}`],
});
const { send, js, until } = page;
const exceptions = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300));
  }
  if (process.env.DEBUG && m.method === 'Runtime.consoleAPICalled') {
    console.log('  [console]', m.params.type, (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
});
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.setBypassServiceWorker', { bypass: true });

// Every request that could reach a third party on the page's behalf is refused.
const refused = [];
const json = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/nostr/*', requestStage: 'Request' },
  { urlPattern: '*/api/keysend*', requestStage: 'Request' },
  { urlPattern: '*/api/lnurl*', requestStage: 'Request' },
  { urlPattern: '*/api/lightning/boostbox*', requestStage: 'Request' },
] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  refused.push(new URL(request.url).pathname);
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: 503, responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: json({ error: 'e2e: refused' }),
  }).catch(() => {});
});

// The WebLN stand-in: records enable() and every payment call, moves nothing.
// A fresh document starts with empty records, so after a reload they tell what
// THAT page load asked of the extension.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__webln = { enable: 0, keysend: [], sendPayment: 0 };
  window.webln = {
    enable: async () => { window.__webln.enable += 1; },
    isEnabled: async () => window.__webln.enable > 0,
    getInfo: async () => ({ node: { alias: 'e2e' }, methods: ['getInfo', 'getBalance', 'keysend'] }),
    getBalance: async () => ({ balance: ${WEBLN_SATS} }),
    keysend: async (a) => {
      window.__webln.keysend.push({ destination: a.destination, amount: Number(a.amount) });
      await new Promise((r) => setTimeout(r, 40));
      return { preimage: '00'.repeat(32) };
    },
    sendPayment: async () => { window.__webln.sendPayment += 1; throw new Error('e2e: keysend only'); },
    makeInvoice: async () => { throw new Error('e2e: keysend only'); },
  };
` });

// --- helpers ------------------------------------------------------------------------
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const SEND = `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => /^send \\d+ sats?$/i.test(b.textContent.trim()))`;
const BOOST_EPISODE = `document.querySelector('button[aria-label="Boost this episode"]')`;
const RAILS = ['NWC', 'Spark', 'WebLN'];
const railButton = (label) => `[...(${DIALOG}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
const pressedRail = () => js(`[...(${DIALOG}?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map((b) => b.textContent.trim()).find((x) => ${JSON.stringify(RAILS)}.includes(x)) ?? null`);
const offeredRails = () => js(`[...(${DIALOG}?.querySelectorAll('button[aria-pressed]') ?? [])].map((b) => b.textContent.trim()).filter((x) => ${JSON.stringify(RAILS)}.includes(x))`);
const chipTitles = () => js(`[...document.querySelectorAll('[title*=" sats ("]')].map((e) => e.title).join(' | ')`);
const weblnRecord = async () => JSON.parse(await js('JSON.stringify(window.__webln)'));
const dialogs = () => js(`document.querySelectorAll('[role="dialog"]').length`);
const why = async () => `dialog: ${String(await js(`${DIALOG}?.innerText ?? 'closed'`)).replace(/\s+/g, ' ').slice(-300)}`;

/** A fresh store, then the episode page: `store` is what localStorage holds at load. */
async function open(store) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"', 30000);
  await js(`(() => { localStorage.clear();
    localStorage.setItem('bmb:share_nostr', '0');
    for (const [k, v] of Object.entries(${JSON.stringify(store)})) localStorage.setItem(k, v);
    return 1; })()`);
  return reload();
}
/** A reload: the store stays, module state (WebLN's enabled flag) goes. */
async function reload() {
  await send('Page.navigate', { url: EPISODE });
  await until('document.readyState === "complete"', 30000);
  const ok = await until(`!!${BOOST_EPISODE}`, 60000);
  await wait(800);
  return !!ok && (await js('!!window.webln && !!window.__webln')) === true;
}
async function openBoost() {
  await js(`${BOOST_EPISODE}?.click()`);
  return !!(await until(`!!(${FIELD})`, 20000));
}
async function typeAmount(text) {
  await js(`(() => { const f = ${FIELD}; f.blur(); f.focus(); f.select(); return 1; })()`);
  await wait(50);
  await send('Input.insertText', { text });
  await wait(200);
}
/** Types 100, presses SEND, and waits for the modal to close on its own (it does
 *  1.5 s after every leg paid). Returns whether it closed. */
async function sendBoost() {
  await typeAmount('100');
  const ready = await until(`!!(${SEND}) && !(${SEND}).disabled`, 30000);
  if (!ready) return false;
  await js(`(${SEND}).click()`);
  return !!(await until(`document.querySelectorAll('[role="dialog"]').length === 0`, 60000));
}

/** Section 1's assertions, reused by section 2 after its reload. */
async function assertNwcPaysAfterReload(tag) {
  t.ok(`${tag}: the chip names NWC`, await until(`!!document.querySelector('[title="${NWC_CHIP}"]')`, 30000), await chipTitles());
  t.ok(`${tag}: the boost modal opens`, await openBoost());
  t.equal(`${tag}: the modal offers NWC and WebLN`, await offeredRails(), ['NWC', 'WebLN']);
  t.equal(`${tag}: the modal opens with NWC selected, as the chip says`, await pressedRail(), 'NWC');
  const mark = nwcPaid.length;
  t.ok(`${tag}: the boost completes and the modal closes`, await sendBoost(), await why());
  const paid = nwcPaid.slice(mark);
  t.ok(`${tag}: NWC paid the legs`, paid.length > 0 && paid.every((p) => p.method === 'pay_keysend'), JSON.stringify(paid));
  const w = await weblnRecord();
  t.equal(`${tag}: the extension was never asked to pay`, { keysend: w.keysend.length, sendPayment: w.sendPayment }, { keysend: 0, sendPayment: 0 });
  t.equal(`${tag}: the extension was never enabled`, w.enable, 0);
  t.ok(`${tag}: the chip still names NWC`, !!(await js(`!!document.querySelector('[title="${NWC_CHIP}"]')`)), await chipTitles());
}

// ------------------------------------------------------------------------------------
if (section(1, 'NWC + preference webln + extension, after a reload: NWC pays, as the chip says')) {
  t.ok('the episode page opens with NWC and the stand-in', await open({ 'bmb:nwc_uri': URI, 'bmb:rail_pref': 'webln' }));
  await assertNwcPaysAfterReload('after reload');
  t.equal('the preference now names the rail that paid', await js(`localStorage.getItem('bmb:rail_pref')`), 'nwc');
}

// ------------------------------------------------------------------------------------
if (section(2, 'WebLN picked in THIS page load pays, and keeps paying until a reload')) {
  t.ok('the episode page opens with NWC and the stand-in', await open({ 'bmb:nwc_uri': URI }));
  t.ok('the boost modal opens', await openBoost());
  t.equal('it opens on NWC (no preference: the priority)', await pressedRail(), 'NWC');
  await js(`(${railButton('WebLN')}).click()`);
  t.ok('WebLN is now selected', await until(`(${railButton('WebLN')})?.getAttribute('aria-pressed') === 'true'`, 5000));
  let mark = nwcPaid.length;
  t.ok('the boost completes and the modal closes', await sendBoost(), await why());
  let w = await weblnRecord();
  t.ok('WebLN paid the legs', w.keysend.length > 0, JSON.stringify(w));
  t.equal('NWC was not asked to pay', nwcPaid.slice(mark), []);
  t.equal('the preference is webln', await js(`localStorage.getItem('bmb:rail_pref')`), 'webln');
  t.ok('the chip now names WebLN', await until(`!!document.querySelector('[title="${WEBLN_CHIP}"]')`, 15000), await chipTitles());

  const before = w.keysend.length;
  t.ok('a second boost modal opens', await openBoost());
  t.equal('it opens on WebLN, the rail picked in this page load', await pressedRail(), 'WebLN');
  mark = nwcPaid.length;
  t.ok('the second boost completes and the modal closes', await sendBoost(), await why());
  w = await weblnRecord();
  t.ok('WebLN paid the second boost too', w.keysend.length > before, JSON.stringify(w));
  t.equal('NWC was not asked to pay the second boost', nwcPaid.slice(mark), []);

  t.ok('a reload keeps NWC, the stand-in and the preference', await reload());
  t.equal('the preference survived the reload', await js(`localStorage.getItem('bmb:rail_pref')`), 'webln');
  await assertNwcPaysAfterReload('after the reload');
}

// ------------------------------------------------------------------------------------
if (section(3, 'ONLY the extension, after a reload: a boost still pays through WebLN')) {
  for (const [tag, store] of [['pref webln', { 'bmb:rail_pref': 'webln' }], ['no pref', {}]]) {
    t.ok(`${tag}: the episode page opens with the stand-in only`, await open(store));
    t.ok(`${tag}: no NWC connection is stored`, !(await js(`localStorage.getItem('bmb:nwc_uri')`)));
    t.ok(`${tag}: the boost modal opens`, await openBoost());
    t.equal(`${tag}: one rail, so no picker`, await offeredRails(), []);
    const mark = nwcPaid.length;
    t.ok(`${tag}: the boost completes and the modal closes`, await sendBoost(), await why());
    const w = await weblnRecord();
    t.ok(`${tag}: WebLN paid the legs`, w.keysend.length > 0, JSON.stringify(w));
    t.equal(`${tag}: NWC was not asked to pay`, nwcPaid.slice(mark), []);
  }
}

// ------------------------------------------------------------------------------------
console.log('\nthe wire');
// Every payee of this episode is a node, so no leg needs an address lookup,
// an LNURL invoice or a BoostBox record. /api/nostr/* (the read index) is
// refused and may be asked; it pays nothing.
const payRoutes = refused.filter((p) => !p.startsWith('/api/nostr/'));
t.ok('no request reached /api/keysend, /api/lnurl or BoostBox', payRoutes.length === 0, payRoutes.join(', '));
t.ok('no uncaught exception in the page', exceptions.length === 0, exceptions.join(' || '));
t.ok('every dialog closed', (await dialogs()) === 0);

walletWs.close();
await relay.close();
console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
