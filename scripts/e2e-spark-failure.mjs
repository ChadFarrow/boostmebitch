// End-to-end for A SPARK FAILURE THE PERSON CAN SEE (#304).
//
//   npm run build && npm start        # or npm run dev
//   BMB_APP=http://127.0.0.1:3433 npm run e2e:sparkfailure
//
// THE BUG. Firefox refuses the responses of one of Spark's three operators,
// `2.spark.flashnet.xyz` (`Access-Control-Allow-Headers: *` does not cover
// `Authorization`; only flashnet can fix that). A CORS refusal reaches the page
// as the same TypeError as a dead connection, and the app hid it twice: the
// page-load restore ran under `.catch(() => {})`, so the wallet silently did not
// open, and `sparkGetInfo` answered `null`, so the card showed "—". Nothing on
// screen, nothing in a bug report.
//
// HOW IT IS MADE HERE. Chrome does not enforce the Firefox rule, so the run
// fails every request to flashnet with CDP `Fetch.failRequest`. The page sees
// exactly what Firefox's refusal gives it: `fetch` rejects with a TypeError.
// The other two operators answer for real (Spark MAINNET). IT SPENDS NOTHING:
// fresh seeds, no sats, nothing paid.
//
// NOTHING IS PUBLISHED TO A PUBLIC RELAY: the e2e-spark-wallet pattern (a
// throwaway key behind a NIP-07 stub, `bmb:relays` on a local relay, and every
// WebSocket EVENT frame watched).
//
//   1. Desktop. flashnet blocked, a pasted seed: the form says "Your Spark
//      wallet did not open", the cause in words and the error's own text, once
//      (no second raw line); the bug report's log holds
//      `spark.connect res=fail why=network`; the console has the warning.
//   2. Phone (390, CDP mobile, a Firefox user agent). A wallet that opened, then
//      a reload with flashnet blocked: the page-load restore fails. The picker's
//      Spark row says "did not open", the form says why with the Firefox
//      sentence, and it fits the screen with 24 x 24 px targets.
//   3. Desktop. flashnet answers, the wallet restores, reads 0. Blocked again,
//      REFRESH: the card says "Spark could not read the balance", the log holds
//      ONE `spark.balance` line after two failed reads. flashnet back, REFRESH:
//      the notice goes and the balance reads 0.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
if (APP.startsWith('https:')) {
  console.error(`e2e:sparkfailure needs an http:// app: an https page cannot reach the local ws:// relay. Got ${APP}`);
  process.exit(2);
}
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

const CONNECT_MS = 60000;
const FIREFOX_UA = 'Mozilla/5.0 (Android 14; Mobile; rv:136.0) Gecko/136.0 Firefox/136.0';

const { page } = await launchChrome({ name: 'sparkfailure', args: ['--disable-gpu'] });
const { send } = page;
const js = page.jsOrThrow;
const t = checker();

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const convo = nip44.v2.utils.getConversationKey(sk, pk);
const relay = createRelay({ port: 0, log: null });
const PORT = await relay.ready;

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');

// --- The publish guard (e2e-spark-wallet) --------------------------------------
const LOOPBACK = /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const sockets = new Map();
const leaks = [];
page.on((m) => {
  if (m.method === 'Network.webSocketCreated') sockets.set(m.params.requestId, m.params.url);
  if (m.method === 'Network.webSocketFrameSent') {
    const url = sockets.get(m.params.requestId) ?? '?';
    if (!LOOPBACK.test(url) && (m.params.response?.payloadData ?? '').startsWith('["EVENT"')) leaks.push(url);
  }
});

// --- flashnet, refused the way Firefox refuses it --------------------------------
let blockFlashnet = false;
let refused = 0;
await send('Fetch.enable', { patterns: [{ urlPattern: '*flashnet.xyz*' }] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  if (blockFlashnet) {
    refused++;
    await send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByResponse' });
  } else {
    await send('Fetch.continueRequest', { requestId: m.params.requestId });
  }
});

const warnings = [];
const pageErrors = [];
page.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
    warnings.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 200));
});

// --- The NIP-07 stub (e2e-spark-wallet) -------------------------------------------
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = pk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], sk);
    else if (fn === 'nip44.encrypt') out = nip44.v2.encrypt(args[1], convo);
    else if (fn === 'nip44.decrypt') out = nip44.v2.decrypt(args[1], convo);
    else if (fn === 'nip04.encrypt') out = await nip04.encrypt(sk, args[0], args[1]);
    else if (fn === 'nip04.decrypt') out = await nip04.decrypt(sk, args[0], args[1]);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  await page.js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const waiting = new Map(); let n = 0;
    window.__bmbResolve = (rid, r) => { const p = waiting.get(rid); waiting.delete(rid); r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      const rid = 'r' + (++n); waiting.set(rid, { resolve, reject });
      window.bmbSigner(JSON.stringify({ rid, fn, args }));
    });
    window.nostr = {
      getPublicKey: () => call('getPublicKey'),
      signEvent: (e) => call('signEvent', e),
      nip44: { encrypt: (p, t) => call('nip44.encrypt', p, t), decrypt: (p, c) => call('nip44.decrypt', p, c) },
      nip04: { encrypt: (p, t) => call('nip04.encrypt', p, t), decrypt: (p, c) => call('nip04.decrypt', p, c) },
    };
  })();
` });

// --- Page helpers (e2e-spark-wallet) ----------------------------------------------
async function load(path = '/') {
  await send('Page.navigate', { url: APP + path });
  await page.until(`document.readyState === 'complete' && !!document.querySelector('header')`, 30000);
  await wait(1500);
}
const WALLET_BUTTON = 'button[aria-label="Connect Lightning wallet"], button[aria-label="Wallet connecting"], button[aria-label="Manage Lightning wallet"]';
async function openWallet() {
  await page.until(`!!document.querySelector(${JSON.stringify(WALLET_BUTTON)})`, 20000);
  await js(`(() => { document.querySelector(${JSON.stringify(WALLET_BUTTON)}).click(); return 1; })()`);
  await page.until(`!!document.querySelector('[role="dialog"]')`, 5000);
  await wait(500);
}
async function closeWallet() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.until(`!document.querySelector('[role="dialog"]')`, 3000);
}
const BUTTON = (text) => `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
async function click(text, ms = 10000) {
  if (!(await page.until(`!!(${BUTTON(text)}) && !(${BUTTON(text)}).disabled`, ms))) return false;
  await js(`(() => { (${BUTTON(text)}).click(); return 1; })()`);
  return true;
}
async function overwriteIfAsked() {
  if (await page.until(`!!(${BUTTON('Overwrite backup')})`, 12000)) {
    await js(`(() => { (${BUTTON('Overwrite backup')}).click(); return 1; })()`);
  }
}
const SPARK_ROW = `[...document.querySelectorAll('[role="dialog"] button.card')].find((b) => /Spark/.test(b.textContent))`;
async function pasteAndConnect(seed) {
  await js(`(() => {
    const ta = document.querySelector('[role="dialog"] textarea[aria-label="Seed phrase"]');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(seed)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await click('Connect');
  await overwriteIfAsked();
}
const notice = (op) => js(`(() => {
  const n = document.querySelector('[role="dialog"] [data-spark-failure="${op}"]');
  return n ? JSON.stringify({ text: n.textContent, detail: n.querySelector('[data-spark-failure-detail]')?.textContent ?? '' }) : null;
})()`).then((s) => (s ? JSON.parse(s) : null));
const rawErrors = () => js(`JSON.stringify([...document.querySelectorAll('[role="dialog"] .text-nostr\\\\/80')].map((e) => e.textContent.trim()))`).then(JSON.parse);
const logLines = (code) => js(`JSON.stringify(JSON.parse(localStorage.getItem('bmb:plog:device') || '[]'))`)
  .then(JSON.parse).then((l) => l.filter((x) => x.split(' ')[1] === code));
const balanceText = () => js(`(() => {
  const d = document.querySelector('[role="dialog"]');
  const r = d && d.querySelector('button[aria-label="Refresh balance"]');
  return r ? r.parentElement.querySelector('.font-mono')?.textContent.trim() ?? null : null;
})()`);
async function settledBalance(ms = CONNECT_MS) {
  for (let i = 0; i < ms / 500; i++) {
    const b = await balanceText();
    if (b != null && b !== '—') return b;
    await wait(500);
  }
  return balanceText();
}
const refreshBalance = () => js(`(() => { document.querySelector('[role="dialog"] button[aria-label="Refresh balance"]').click(); return 1; })()`);
const overflowPx = () => js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
const smallTargets = () => js(`(() => {
  const d = document.querySelector('[role="dialog"]');
  return JSON.stringify([...d.querySelectorAll('button, input, textarea')].map((el) => {
    const r = el.getBoundingClientRect();
    return { name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((x) => x.w > 0 && (x.w < 24 || x.h < 24)));
})()`).then(JSON.parse);
const oneLine = (x) => JSON.stringify(x).replaceAll('\n', ' | ');

console.log(`\n  throwaway npub ${npub.slice(0, 20)}…  relay ws://127.0.0.1:${PORT}  app ${APP}\n`);

// --- 1 ------------------------------------------------------------------------
console.log('1. Desktop — flashnet refused, a pasted seed does not connect, and the form says why');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await load();
await js(`(() => {
  localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  return 1;
})()`);
await load();
blockFlashnet = true;
await openWallet();
await js(`(() => { (${SPARK_ROW}).click(); return 1; })()`);
await pasteAndConnect(generateMnemonic(wordlist));
const shown1 = await page.until(`!!document.querySelector('[role="dialog"] [data-spark-failure="connect"]')`, CONNECT_MS);
const n1 = await notice('connect');
t.ok('flashnet was asked and refused', refused > 0, `${refused} request(s)`);
t.ok('the form says the wallet did not open', shown1 && /did not open/.test(n1?.text ?? ''), oneLine(n1));
t.ok('...the cause in words: a server it could not reach', /could not reach one of its servers/.test(n1?.text ?? ''), oneLine(n1));
t.ok('...and the error\'s own text', (n1?.detail ?? '').length > 0, oneLine(n1));
t.ok('...without the Firefox sentence in Chrome', !/Firefox/.test(n1?.text ?? ''), oneLine(n1));
const raw1 = await rawErrors();
t.ok('the error is said once: no second raw line', raw1.length === 0, oneLine(raw1));
const connectLines = await logLines('spark.connect');
t.ok('the bug report log holds spark.connect res=fail why=network', connectLines.some((l) => / res=fail why=network$/.test(l)), oneLine(connectLines));
t.ok('the log line holds no error text', connectLines.every((l) => !/fetch|flashnet|http/i.test(l)), oneLine(connectLines));
t.ok('the console has the warning, with the text', warnings.some((w) => /\[spark\] connect failed \(network\)/.test(w)), oneLine(warnings.slice(-3)));
t.ok('the header still offers to connect (no wallet)', await js(`!!document.querySelector('button[aria-label="Connect Lightning wallet"]')`));
await closeWallet();

// --- 2 ------------------------------------------------------------------------
console.log('\n2. Phone 390, Firefox user agent — the page-load restore fails, and the picker and form say why');
blockFlashnet = false;
await openWallet();
await js(`(() => { (${SPARK_ROW}).click(); return 1; })()`);
const seed2 = generateMnemonic(wordlist);
await pasteAndConnect(seed2);
const connected2 = await page.until(`!document.querySelector('[role="dialog"]')`, CONNECT_MS);
t.ok('with flashnet answering, a pasted seed connects (the window closes)', connected2, oneLine(await notice('connect')));
t.ok('a success takes the failure away', await js(`!document.querySelector('[data-spark-failure]')`));
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setUserAgentOverride', { userAgent: FIREFOX_UA });
blockFlashnet = true;
const refusedBefore = refused;
await load();
// The restore reads the backup from the local relay, then fails at flashnet.
for (let i = 0; i < CONNECT_MS / 500 && refused === refusedBefore; i++) await wait(500);
const restoreDone = await page.until(`!!document.querySelector('button[aria-label="Connect Lightning wallet"]')`, CONNECT_MS);
t.ok('the page-load restore did not open the wallet', restoreDone && refused > refusedBefore, `${refused - refusedBefore} refused`);
await page.until(`JSON.parse(localStorage.getItem('bmb:plog:device') || '[]').filter((l) => l.split(' ')[1] === 'spark.connect').length >= 2`, CONNECT_MS);
await openWallet();
const rowSays = await js(`(() => { const r = ${SPARK_ROW}; return r ? r.textContent : null; })()`);
t.ok('the picker\'s Spark row says it did not open', /did not open/.test(rowSays ?? ''), oneLine(rowSays));
await js(`(() => { (${SPARK_ROW}).click(); return 1; })()`);
await page.until(`!!document.querySelector('[role="dialog"] [data-spark-failure="connect"]')`, 5000);
const n2 = await notice('connect');
t.ok('the form says the wallet did not open', /did not open/.test(n2?.text ?? ''), oneLine(n2));
t.ok('...and, in Firefox, which browser setting is at fault (#304)', /Firefox blocks one of them/.test(n2?.text ?? '') && /#304/.test(n2?.text ?? ''), oneLine(n2));
t.ok('the log holds a second spark.connect line (the restore)', (await logLines('spark.connect')).length >= 2, oneLine(await logLines('spark.connect')));
t.ok('the form does not scroll sideways', (await overflowPx()) <= 0, `overflow ${await overflowPx()}px`);
const small2 = await smallTargets();
t.ok('every control is 24 x 24 px or more', small2.length === 0, oneLine(small2));
const fits = await js(`(() => { const n = document.querySelector('[data-spark-failure="connect"]'); if (!n) return false; const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })()`);
t.ok('the notice fits the screen', fits);
await closeWallet();

// --- 3 ------------------------------------------------------------------------
console.log('\n3. Desktop — a balance read refused, then answered');
await send('Emulation.setUserAgentOverride', { userAgent: '' });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
blockFlashnet = false;
await load();
const restored3 = await page.until(`!!document.querySelector('button[aria-label="Manage Lightning wallet"]')`, CONNECT_MS);
t.ok('with flashnet answering, the wallet restores on load', restored3);
await openWallet();
t.equal('the balance reads 0', await settledBalance(), '0');
const before3 = (await logLines('spark.balance')).length;
blockFlashnet = true;
await refreshBalance();
const shown3 = await page.until(`!!document.querySelector('[role="dialog"] [data-spark-failure="balance"]')`, 30000);
const n3 = await notice('balance');
t.ok('the card says the balance could not be read', shown3 && /could not read the balance/.test(n3?.text ?? ''), oneLine(n3));
await wait(1000);
await refreshBalance();
await wait(5000);
const balanceLines = (await logLines('spark.balance')).slice(before3);
t.equal('two failed reads write ONE spark.balance line', balanceLines.length, 1);
t.ok('...why=network', balanceLines.every((l) => / res=fail why=network$/.test(l)), oneLine(balanceLines));
blockFlashnet = false;
await refreshBalance();
const gone3 = await page.until(`!document.querySelector('[role="dialog"] [data-spark-failure]')`, 30000);
t.ok('flashnet back: the notice goes', gone3);
t.equal('...and the balance reads 0', await settledBalance(), '0');
await closeWallet();

t.ok('nothing was published to a public relay', leaks.length === 0, oneLine(leaks));
t.ok('no uncaught exception in the page', pageErrors.length === 0, oneLine(pageErrors));
await js(`(() => { localStorage.clear(); return 1; })()`);
await relay.close();
console.log(`\n${t.fails ? `${t.fails} of ${t.count} check(s) FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
