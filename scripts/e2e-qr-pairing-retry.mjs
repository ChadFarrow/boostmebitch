// End-to-end for the "Scan a QR code" screen when the page comes BACK from the
// signer app, against nothing but this machine.
//
// THE BUG (full-code review 2026-11-19, components/nostr-auth/sign-in-modal.tsx).
// Returning to the tab is a `visibilitychange`, and the QR screen answers it by
// starting the pairing again (`onGenerate`), because the socket the page left
// with may be dead. `startPairing` abandons the earlier listener, and the
// abandoned attempt's `ready` REJECTS. `onGenerate` had no attempt counter, so
// that rejection — about a listener nobody uses any more — set the screen's
// error and cleared its busy state OVER THE LIVE ATTEMPT: the user came back
// from approving in their signer to a failure message and a "Retry" button,
// while the new listener was still waiting for the very ack they had approved.
// The Clave, Amber and Primal paths on the same modal each carry the guard
// (`claveAttempt`/`claveSettled` and siblings); the QR one did not.
//
// HOW IT RUNS OFFLINE. The pairing relays are a constant in lib/nostr/bunker.ts
// (NOSTRCONNECT_RELAYS), so a page script swaps `window.WebSocket` before the
// app loads and points those two hosts at a local relay. nostr-tools reads the
// global constructor when it opens each relay, so every pairing socket lands
// here. A stand-in signer (a random key) acks on that relay. Everything else
// the signed-in app reads or writes goes to the same local relay (`bmb:relays`).
// NOTHING REACHES A PUBLIC RELAY.
//
// What it pins:
//   1. After a return to the tab, the screen still says "Waiting for signer…",
//      shows no error and no Retry — and stays that way (it is read again past
//      the point where the abandoned attempt has rejected).
//   2. Must still work: the stand-in's ack then signs the user in, as the
//      stand-in's key. The first listener was abandoned and its pool destroyed,
//      so this proves the retry put a live listener on the same URI, client key
//      and secret.
//
//   npm run build && npm run start      (or `npm run dev`)
//   APP_URL=http://127.0.0.1:3000 npm run e2e:qrretry
//   E2E_MOBILE=1 npm run e2e:qrretry    (a Pixel 6 under CDP device emulation,
//                                        plus a horizontal-overflow check)

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` or \`npm run start\`.`);

// The shipped pairing relays (lib/nostr/bunker.ts, NOSTRCONNECT_RELAYS).
// e2e:pairing pins the list itself against the real hosts.
const PAIRING = ['wss://offchain.pub', 'wss://relay.powr.build'];

const relay = createRelay({ port: 0, log: null });
const PORT = await relay.ready;
const LOCAL = `ws://127.0.0.1:${PORT}`;
const { page } = await launchChrome({ name: 'qr-retry', args: ['--disable-gpu'] });
const { send } = page;
const js = page.jsOrThrow;
const t = checker();
await send('Page.enable');
await send('Runtime.enable');
const MOBILE = process.env.E2E_MOBILE === '1';
if (MOBILE) {
  // A phone viewport is CDP emulation with `mobile: true`, never a window size.
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' });
}
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const swap = new Set(${JSON.stringify(PAIRING)});
  const Real = window.WebSocket;
  window.__e2ePairingSockets = 0;
  function Routed(url, protocols) {
    const bare = String(url).replace(/\\/+$/, '');
    if (swap.has(bare)) { window.__e2ePairingSockets += 1; url = ${JSON.stringify(LOCAL)}; }
    return protocols === undefined ? new Real(url) : new Real(url, protocols);
  }
  Routed.prototype = Real.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Routed[k] = Real[k];
  window.WebSocket = Routed;
})();` });

async function load() {
  await send('Page.navigate', { url: APP + '/' });
  await page.until(`document.readyState === 'complete' && !!document.querySelector('header')`, 30000);
  await wait(1500);
}
async function signedOutLocal() {
  await js(`(() => { localStorage.clear(); localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([LOCAL]))}); return 1; })()`);
}
const ACCOUNT = 'button[aria-label^="Account:"]';
const dialogText = () => js(`document.querySelector('[role="dialog"]')?.innerText ?? ''`);
// The QR screen's error state is its "Try again" button plus the message
// beside it; on main the abandoned attempt's rejection rendered as "Connection
// dropped — approve…". Both are read, so a reworded message cannot hide it.
const retryShown = () => js(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => /^(Try again|Retry)/i.test(b.textContent.trim()))`);
const ERROR_TEXT = /Connection dropped|replaced by a newer one|failed|timed out/i;
const tail = (s) => s.replace(/^[\s\S]*?(HIDE LINK|SHOW LINK)/i, '$1').replace(/\n+/g, ' | ').slice(0, 300);

async function openQr() {
  await js(`(() => { [...document.querySelectorAll('header button')].find((b) => /^SIGN IN/i.test(b.textContent.trim())).click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.includes('Sign in with Nostr'))`, 5000);
  await js(`(() => { [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Sign in with Nostr')).click(); return 1; })()`);
  await page.until(`!!document.querySelector('[role="dialog"]')`, 5000);
  await js(`(() => { [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Scan a QR code')).click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === 'Show link')`, 10000);
  await js(`(() => { [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Show link').click(); return 1; })()`);
  await page.until(`/^nostrconnect:/.test(document.querySelector('[role="dialog"] code')?.textContent ?? '')`, 5000);
  return js(`document.querySelector('[role="dialog"] code').textContent.trim()`);
}
function parseUri(uri) {
  const u = new URL(uri);
  return { clientPk: u.hostname || u.pathname.replace(/^\/+/, ''), relays: u.searchParams.getAll('relay'), secret: u.searchParams.get('secret') };
}
// What the browser fires when the user switches back from the signer app.
const returnToTab = () => js(`(() => { document.dispatchEvent(new Event('visibilitychange')); return document.visibilityState; })()`);

// A stand-in signer on the local relay: acks the pairing, then answers requests.
async function standInSigner(clientPk, secret) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const key = nip44.v2.utils.getConversationKey(sk, clientPk);
  const ws = new WebSocket(LOCAL);
  await new Promise((r) => ws.addEventListener('open', r));
  const reply = (obj) => ws.send(JSON.stringify(['EVENT', finalizeEvent({
    kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', clientPk]],
    content: nip44.v2.encrypt(JSON.stringify(obj), key),
  }, sk)]));
  const methods = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg[0] !== 'EVENT' || msg[2]?.pubkey !== clientPk) return;
    let req;
    try { req = JSON.parse(nip44.v2.decrypt(msg[2].content, key)); } catch { return; }
    methods.push(req.method);
    if (req.method === 'get_public_key') reply({ id: req.id, result: pk });
    else if (req.method === 'ping') reply({ id: req.id, result: 'pong' });
    else if (req.method === 'connect') reply({ id: req.id, result: 'ack' });
    else if (req.method === 'sign_event') reply({ id: req.id, result: JSON.stringify(finalizeEvent(JSON.parse(req.params[0]), sk)) });
    else reply({ id: req.id, result: '', error: 'e2e stand-in: not supported' });
  });
  ws.send(JSON.stringify(['REQ', 'signer', { kinds: [24133], '#p': [pk] }]));
  await wait(400);
  return { pk, methods, ack: () => reply({ id: Math.random().toString(36).slice(2), result: secret }), close: () => ws.close() };
}

// ------------------------------------------------------------------------------------
console.log('\n1. the page comes back from the signer while the QR pairing is waiting');
await load();
await signedOutLocal();
await load();
const uri = await openQr();
const p = parseUri(uri);
t.ok('the QR shows a nostrconnect:// URI with a secret', /^[0-9a-f]{64}$/.test(p.clientPk) && !!p.secret, uri.slice(0, 100));
t.ok('its pairing sockets were routed to the local relay', (await js('window.__e2ePairingSockets')) > 0, String(await js('window.__e2ePairingSockets')));
t.ok('it is waiting for the signer', /Waiting for signer/.test(await dialogText()));
t.ok('...with no error and no Try again yet', !ERROR_TEXT.test(await dialogText()) && !(await retryShown()), tail(await dialogText()));

t.equal('the tab reads as visible', await returnToTab(), 'visible');
// The abandoned listener's `ready` rejects once its pool is down: read the
// screen at 2 s and again at 6 s, so a late rejection is caught too.
await wait(2000);
const textAt2 = await dialogText();
t.ok('2 s later: still waiting for the signer', /Waiting for signer/.test(textAt2), tail(textAt2));
t.ok('2 s later: no error from the replaced attempt', !ERROR_TEXT.test(textAt2), tail(textAt2));
t.ok('2 s later: no Try again button', !(await retryShown()));
await wait(4000);
const textAt6 = await dialogText();
t.ok('6 s later: still waiting, still no error', /Waiting for signer/.test(textAt6) && !ERROR_TEXT.test(textAt6) && !(await retryShown()), tail(textAt6));
if (MOBILE) {
  const o = await js(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
  t.ok('phone: no horizontal overflow on the QR screen', o.sw <= o.cw, JSON.stringify(o));
}
t.equal('the URI survived the retry', await js(`document.querySelector('[role="dialog"] code')?.textContent.trim()`), uri);

console.log('\n2. must still work: the ack after the retry signs in');
const signer = await standInSigner(p.clientPk, p.secret);
signer.ack();
const inUi = await page.until(`!!document.querySelector(${JSON.stringify(ACCOUNT)})`, 30000);
t.ok('signed in', inUi, `methods: ${JSON.stringify(signer.methods)}`);
if (inUi) {
  await page.until('!!window.nostr', 10000);
  t.equal('window.nostr answers with the stand-in key', await js('window.nostr.getPublicKey()'), signer.pk);
  t.ok('the sign-in window closed', !(await js(`!!document.querySelector('[role="dialog"]')`)));
}
signer.close();

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
