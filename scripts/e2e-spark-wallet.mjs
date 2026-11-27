// End-to-end for THE SPARK WALLET AGAINST THE REAL SPARK NETWORK: the test to
// run after every update of @buildonspark/spark-sdk (docs/spark-sdk-swap.md,
// "SDK updates").
//
//   npm run e2e:spark
//   BMB_APP=http://localhost:3001 npm run e2e:spark
//
// `check:spark` proves the installed SDK derives the same identity key from a
// seed in Node. This proves the BROWSER bundle does, and that the wallet works
// in the page: it makes a new wallet, reads its balance, and makes invoices,
// against Spark's MAINNET operators. IT SPENDS NOTHING: a fresh wallet has no
// sats, nothing is paid, and an unpaid invoice expires.
//
// NOTHING IS PUBLISHED TO A PUBLIC RELAY. The sign-in is a throwaway key behind
// a NIP-07 stub over a CDP binding (the e2e-favorites pattern), `bmb:relays`
// points the publish set at a local relay, and every WebSocket frame the page
// sends is watched: an EVENT to any socket that is not on this machine fails the
// run. The seed backups (kind:30078) land on the local relay only.
//
//   1. Desktop: Create new → the seed is shown → Back up to Nostr. The backup on
//      the local relay decrypts to the seed on screen, the wallet connects, its
//      balance reads 0 (not "—": `sparkGetInfo` returned a number), and a
//      21-sat invoice is a mainnet BOLT11 for 21 sats.
//   2. Phone (390 x 844 by CDP emulation): a reload restores the wallet from the
//      backup with no click, the card fits with no sideways scroll, its controls
//      are 24 x 24 px or more (WCAG 2.5.8), and a zero-amount invoice and its QR
//      code fit the screen.
//   3. A pasted seed (the BIP-39 test vector) opens the wallet whose identity key
//      `check:spark` pins: the page sends that key to the operators. The new
//      wallet of step 1 sent a different one, so the match is not an accident.
//   4. A pasted seed whose backup reaches NO relay (the local relay refuses the
//      kind:30078 only). The wallet connects, but nothing persists it: after a
//      reload the app opens what the backup holds, not this wallet. So the
//      window stays open on the card, which says so, with no seed words in it;
//      the other rail is still cleared; the notice survives a close and reopen
//      and fits a phone; and "Back up again", with the relay accepting, saves
//      this seed and takes the notice away. Until the full-code review of
//      2026-11-19 the failure was a console warning and the window closed.
//
// Needs the app running (`npm run dev`, or `npm run build && npm start`) and
// network access to Spark's operators.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
// The seed backups go to a ws:// relay on this machine, and an https page may
// not open ws:// (mixed content): against a deployment the backup fails before
// Spark starts. Measured on a Vercel preview, 2026-11-22.
if (APP.startsWith('https:')) {
  console.error(`e2e:spark needs an http:// app (a local \`npm run dev\` or \`npm start\`): an https page cannot reach the local ws:// relay. Got ${APP}`);
  process.exit(2);
}
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.
(and \`rm -rf .next\` first if you have just run a production build)`);

// What check:spark pins for this seed at account 1 (mainnet).
const PASTED_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASTED_IDENTITY = '0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5';
const BACKUP_D = 'boostmebitch:wallet:spark';
// Init (operator auth) can take most of SPARK_INIT_TIMEOUT_MS on a slow link.
const CONNECT_MS = 60000;

const { page } = await launchChrome({ name: 'spark', args: ['--disable-gpu'] });
const { send } = page;
const js = page.jsOrThrow;
const t = checker();

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const convo = nip44.v2.utils.getConversationKey(sk, pk);

// Step 4 turns this on: the local relay then answers the Spark backup's EVENT
// with `OK false`, so the publish reaches no relay. Nothing else is refused.
let refuseBackup = false;
const relay = createRelay({
  port: 0,
  log: null,
  refuse: (e) => (refuseBackup && e.kind === 30078 && e.tags.some((tg) => tg[0] === 'd' && tg[1] === BACKUP_D)
    ? 'blocked: e2e refuses the wallet backup'
    : null),
});
const PORT = await relay.ready;

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');

// --- The publish guard ------------------------------------------------------
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

// --- What the page sends to Spark -------------------------------------------
// The operators and the SSP. A request body is gRPC-web protobuf; the 33-byte
// identity key goes in it as raw bytes (get_challenge, query_nodes), so the
// hex of every body is searched for it.
const SPARK_HOST = /(^|\.)(lightspark\.com|breez\.technology|flashnet\.xyz)$/;
let sparkBodies = [];
let sparkRequests = 0;
page.on(async (m) => {
  if (m.method !== 'Network.requestWillBeSent') return;
  let host;
  try { host = new URL(m.params.request.url).hostname; } catch { return; }
  if (!SPARK_HOST.test(host)) return;
  sparkRequests++;
  const entries = m.params.request.postDataEntries;
  if (entries?.length) {
    sparkBodies.push(entries.map((e) => (e.bytes ? Buffer.from(e.bytes, 'base64').toString('hex') : '')).join(''));
  } else if (m.params.request.hasPostData) {
    const r = await send('Network.getRequestPostData', { requestId: m.params.requestId });
    if (r.result?.postData) sparkBodies.push(Buffer.from(r.result.postData, 'latin1').toString('hex'));
  }
});
const sentIdentity = (hex) => sparkBodies.some((b) => b.includes(hex));

const pageErrors = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 200));
});

// --- The NIP-07 stub (the e2e-favorites pattern) ------------------------------
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

// --- Page helpers -------------------------------------------------------------
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

// A button in the open wallet window (or the confirm dialog on top of it), by
// its exact text.
const BUTTON = (text) => `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
async function click(text, ms = 10000) {
  if (!(await page.until(`!!(${BUTTON(text)}) && !(${BUTTON(text)}).disabled`, ms))) return false;
  await js(`(() => { (${BUTTON(text)}).click(); return 1; })()`);
  return true;
}
// The confirm dialog over the wallet window, when the backup check could not
// prove the coordinate empty (the public relays are read too) or it holds a
// different seed. Pressing it overwrites the LOCAL relay's copy only.
async function overwriteIfAsked() {
  if (await page.until(`!!(${BUTTON('Overwrite backup')})`, 12000)) {
    await js(`(() => { (${BUTTON('Overwrite backup')}).click(); return 1; })()`);
    return true;
  }
  return false;
}

// The connected card: its balance text, or null while it is not on screen.
const balanceText = () => js(`(() => {
  const d = document.querySelector('[role="dialog"]');
  const r = d && d.querySelector('button[aria-label="Refresh balance"]');
  return r ? r.parentElement.querySelector('.font-mono')?.textContent.trim() ?? null : null;
})()`);
// The wallet window closes itself once a wallet connects (handleConnected).
// Wait for that, then open it again on the connected card.
async function reopenConnected() {
  const closed = await page.until(`!document.querySelector('[role="dialog"]')`, CONNECT_MS);
  if (!closed) return false;
  await openWallet();
  return true;
}
async function settledBalance(ms = CONNECT_MS) {
  for (let i = 0; i < ms / 500; i++) {
    const b = await balanceText();
    if (b != null && b !== '—') return b;
    await wait(500);
  }
  return balanceText();
}
const invoiceText = () => js(`(() => {
  const c = [...(document.querySelector('[role="dialog"]')?.querySelectorAll('code') ?? [])].find((x) => /^ln/i.test(x.textContent.trim()));
  return c ? c.textContent.trim() : null;
})()`);
async function generateInvoice(amount) {
  await click('Receive');
  if (amount != null) {
    await js(`(() => {
      const i = document.querySelector('[role="dialog"] input[aria-label="Amount in sats (optional)"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, ${JSON.stringify(String(amount))});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return 1;
    })()`);
  }
  await click('Generate');
  await page.until(`[...(document.querySelector('[role="dialog"]')?.querySelectorAll('code') ?? [])].some((x) => /^ln/i.test(x.textContent.trim()))`, 30000);
  return invoiceText();
}
const dialogError = () => js(`(() => {
  const e = document.querySelector('[role="dialog"] .text-nostr\\\\/80');
  return e ? e.textContent.trim() : null;
})()`);
const overflowPx = () => js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
// Every visible control in the wallet window narrower or shorter than 24 px.
const smallTargets = () => js(`(() => {
  const d = document.querySelector('[role="dialog"]');
  return JSON.stringify([...d.querySelectorAll('button, input, textarea')].map((el) => {
    const r = el.getBoundingClientRect();
    return { name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((x) => x.w > 0 && (x.w < 24 || x.h < 24)));
})()`).then(JSON.parse);

const backupOnRelay = () => [...relay.events.values()]
  .filter((e) => e.kind === 30078 && e.pubkey === pk && e.tags.some((tg) => tg[0] === 'd' && tg[1] === BACKUP_D))
  .sort((a, b) => b.created_at - a.created_at)[0] ?? null;

async function signIn() {
  await js(`(() => {
    localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'nip07');
    return 1;
  })()`);
}

console.log(`\n  throwaway npub ${npub.slice(0, 20)}…  relay ws://127.0.0.1:${PORT}  app ${APP}\n`);

// --- 1 ------------------------------------------------------------------------
console.log('1. Desktop — Create new, back up, connect, balance 0, a 21-sat invoice');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await load();
await signIn();
await load();
await openWallet();
t.ok('the picker offers Spark', await page.until(`[...document.querySelectorAll('[role="dialog"] button.card')].some((b) => /Spark/.test(b.textContent))`, 5000));
await js(`(() => { [...document.querySelectorAll('[role="dialog"] button.card')].find((b) => /Spark/.test(b.textContent)).click(); return 1; })()`);
t.ok('the Spark form offers Create new', await click('Create new'));
await overwriteIfAsked();
const shown = await (async () => {
  for (let i = 0; i < 40; i++) {
    const s = await js(`(() => { const c = [...document.querySelectorAll('[role="dialog"] code')].find((x) => x.textContent.trim().split(/\\s+/).length === 12); return c ? c.textContent.trim() : null; })()`);
    if (s) return s;
    await wait(250);
  }
  return null;
})();
t.ok('a 12-word seed is shown to write down', !!shown);
await js(`(() => { const c = document.querySelector('[role="dialog"] input[type="checkbox"]'); c.click(); return 1; })()`);
sparkBodies = [];
t.ok('Back up to Nostr is pressed', await click('Back up to Nostr'));
const connected1 = await reopenConnected();
if (!connected1) console.log(`         error on screen: ${await dialogError()}`);
t.ok('the wallet connects (the window closes itself)', connected1);
let balance = await settledBalance();
const created = sparkBodies.slice();
const backup = backupOnRelay();
t.ok('the backup is on the LOCAL relay', !!backup);
t.ok('the backup decrypts to the seed on screen', !!backup && nip44.v2.decrypt(backup.content, convo) === shown);
t.equal('the new wallet connects with a balance of 0 sats', balance, '0');
if (balance !== '0') console.log(`         error on screen: ${await dialogError()}`);
t.ok('the page talked to the Spark operators', sparkRequests > 0, `${sparkRequests} request(s)`);
const inv21 = await generateInvoice(21);
t.ok('a 21-sat invoice is a mainnet BOLT11 for 21 sats (lnbc210n1…)', /^lnbc210n1[02-9ac-hj-np-z]+$/.test(inv21 ?? ''), String(inv21).slice(0, 40));
// qrcode.react is a next/dynamic import, so the QR code draws a moment later.
const QR = `[...document.querySelectorAll('svg')].find((x) => x.querySelectorAll('path').length >= 2 && x.getBoundingClientRect().width >= 150)`;
t.ok('its QR code is drawn', await page.until(`!!(${QR})`, 10000));
await click('done');
await closeWallet();

// --- 2 ------------------------------------------------------------------------
console.log('\n2. Phone 390 x 844 — the wallet restores from the backup on load, and fits');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await load();
const restored = await page.until(`!!document.querySelector('button[aria-label="Manage Lightning wallet"]')`, CONNECT_MS);
t.ok('the wallet reconnects with no click (page-load restore)', restored);
await openWallet();
balance = await settledBalance();
t.equal('the restored wallet reads 0 sats', balance, '0');
t.ok('the card does not scroll sideways', (await overflowPx()) <= 0, `overflow ${await overflowPx()}px`);
let small = await smallTargets();
t.ok('every control of the card is 24 x 24 px or more', small.length === 0, JSON.stringify(small));
const inv0 = await generateInvoice(null);
t.ok('a zero-amount invoice is a mainnet BOLT11 with no amount (lnbc1…)', /^lnbc1[02-9ac-hj-np-z]+$/.test(inv0 ?? ''), String(inv0).slice(0, 40));
t.ok('the invoice and its QR code do not scroll sideways', (await overflowPx()) <= 0, `overflow ${await overflowPx()}px`);
await page.until(`!!(${QR})`, 10000);
const qrFits = await js(`(() => { const s = ${QR}; const r = s && s.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= window.innerWidth; })()`);
t.ok('the QR code is inside the screen', qrFits);
small = await smallTargets();
t.ok('every control with the invoice open is 24 x 24 px or more', small.length === 0, JSON.stringify(small));
await click('done');

// --- 3 ------------------------------------------------------------------------
console.log('\n3. A pasted seed opens the wallet check:spark pins');
t.ok('Disconnect is pressed', await click('Disconnect'));
await page.until(`!!document.querySelector('[role="dialog"] button.card')`, 5000);
await js(`(() => { [...document.querySelectorAll('[role="dialog"] button.card')].find((b) => /Spark/.test(b.textContent))?.click(); return 1; })()`);
await page.until(`!!document.querySelector('[role="dialog"] textarea[aria-label="Seed phrase"]')`, 5000);
await js(`(() => {
  const a = document.querySelector('[role="dialog"] textarea[aria-label="Seed phrase"]');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(a, ${JSON.stringify(PASTED_SEED)});
  a.dispatchEvent(new Event('input', { bubbles: true }));
  return 1;
})()`);
sparkBodies = [];
t.ok('Connect is pressed', await click('Connect'));
t.ok('the overwrite of the step-1 backup is confirmed first', await overwriteIfAsked());
const connected3 = await reopenConnected();
if (!connected3) console.log(`         error on screen: ${await dialogError()}`);
t.ok('the pasted wallet connects (the window closes itself)', connected3);
balance = await settledBalance();
t.ok('the pasted wallet connects and reads a balance', balance != null && balance !== '—', `balance ${balance}, error ${await dialogError()}`);
t.ok(`the page sent the pinned identity key ${PASTED_IDENTITY.slice(0, 16)}… to the operators`, sentIdentity(PASTED_IDENTITY), `${sparkBodies.length} request body(ies) read`);
t.ok('the step-1 wallet did NOT send that key (the match is not an accident)', created.length > 0 && !created.some((b) => b.includes(PASTED_IDENTITY)), `${created.length} body(ies) from step 1`);
const latest = backupOnRelay();
t.ok('the backup now holds the pasted seed', !!latest && nip44.v2.decrypt(latest.content, convo) === PASTED_SEED);
await closeWallet();

// --- 4 ------------------------------------------------------------------------
console.log('\n4. A pasted seed whose backup reaches no relay: the card says so, and Back up again saves it');
const FRESH_SEED = generateMnemonic(wordlist);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
// Another rail first, so the run sees that connecting Spark still clears it. A
// throwaway NWC connection on the local relay: nothing ever answers it.
const FAKE_NWC = `nostr+walletconnect://${getPublicKey(generateSecretKey())}?relay=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}&secret=${hex(generateSecretKey())}`;
await openWallet();
t.ok('Disconnect is pressed (the step-3 wallet)', await click('Disconnect'));
await closeWallet();
await js(`(() => { localStorage.setItem('bmb:nwc_uri', ${JSON.stringify(FAKE_NWC)}); return 1; })()`);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await load();
await openWallet();
t.ok('the window opens on the NWC card, with Switch wallet', await click('Switch wallet →'));
await page.until(`[...document.querySelectorAll('[role="dialog"] button.card')].some((b) => /Spark/.test(b.textContent))`, 5000);
await js(`(() => { [...document.querySelectorAll('[role="dialog"] button.card')].find((b) => /Spark/.test(b.textContent)).click(); return 1; })()`);
t.ok('the Spark form opens', await page.until(`!!document.querySelector('[role="dialog"] textarea[aria-label="Seed phrase"]')`, 5000));
await js(`(() => {
  const a = document.querySelector('[role="dialog"] textarea[aria-label="Seed phrase"]');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(a, ${JSON.stringify(FRESH_SEED)});
  a.dispatchEvent(new Event('input', { bubbles: true }));
  return 1;
})()`);
refuseBackup = true;
t.ok('Connect is pressed', await click('Connect'));
t.ok('the overwrite of the step-3 backup is confirmed first', await overwriteIfAsked());
const NOTICE = /no backup on Nostr/i;
const noticeShown = () => js(`${NOTICE}.test(document.querySelector('[role="dialog"]')?.innerText ?? '')`);
const shownAt = await page.until(`${NOTICE}.test(document.querySelector('[role="dialog"]')?.innerText ?? '')`, CONNECT_MS);
t.ok('the window stays open, and the card says the wallet has no backup', shownAt, `dialog open: ${await js(`!!document.querySelector('[role="dialog"]')`)}, error ${await dialogError()}`);
t.ok('...on the connected card (a balance is shown beside it)', (await settledBalance()) != null);
const held = backupOnRelay();
t.ok('the relay still holds the step-3 seed, not this one', !!held && nip44.v2.decrypt(held.content, convo) === PASTED_SEED);
t.ok('the NWC connection was still cleared', (await js(`localStorage.getItem('bmb:nwc_uri')`)) === null);
const seedWords = FRESH_SEED.split(' ');
// Three words in a row is a seed fragment, not a sentence; `innerText` does
// not include a field's value, so the fields are read too.
const SEED_HEAD = seedWords.slice(0, 3).join(' ');
t.ok('no seed words are on the page', !(await js(`document.body.innerText.includes(${JSON.stringify(SEED_HEAD)}) || [...document.querySelectorAll('textarea, input')].some((f) => f.value.includes(${JSON.stringify(SEED_HEAD)}))`)));
await closeWallet();
await openWallet();
t.ok('the notice is still there after a close and reopen', await noticeShown());
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await wait(500);
t.ok('phone: the card with the notice does not scroll sideways', (await overflowPx()) <= 0, `overflow ${await overflowPx()}px`);
small = await smallTargets();
t.ok('phone: every control with the notice is 24 x 24 px or more', small.length === 0, JSON.stringify(small));
if (process.env.E2E_SHOT) {
  // `E2E_SHOT=<file.png>` saves the phone card with the notice, to look at.
  const { writeFile } = await import('node:fs/promises');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(process.env.E2E_SHOT, Buffer.from(shot.result?.data ?? shot.data, 'base64'));
}
refuseBackup = false;
t.ok('Back up again is pressed', await click('Back up again'));
t.ok('the card says the backup is saved', await page.until(`/Backed up to Nostr/.test(document.querySelector('[role="dialog"]')?.innerText ?? '')`, 20000));
t.ok('...and the notice is gone', !(await noticeShown()));
const saved = backupOnRelay();
t.ok('the backup now holds this seed', !!saved && nip44.v2.decrypt(saved.content, convo) === FRESH_SEED);
await closeWallet();

// --- The guards -----------------------------------------------------------------
console.log('\nGuards');
t.ok('no EVENT reached a relay that is not on this machine', leaks.length === 0, JSON.stringify([...new Set(leaks)]));
t.ok('no uncaught exception in the page', pageErrors.length === 0, JSON.stringify(pageErrors));

await js(`(() => { localStorage.clear(); return 1; })()`);
relay.close();
console.log(`\n${t.fails ? `${t.fails} of ${t.count} check(s) FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
