// End-to-end for WHAT THE iOS APP HIDES AND ADDS: no Spark (docs/wallets.md,
// "Spark is off inside the iOS app"), no Google sign-in, and a pasted nsec as
// a local key (docs/signers.md, "Google onboarding" and "Paste your nsec").
//
//   npm run e2e:iosapp
//   BMB_APP=http://localhost:3001 npm run e2e:iosapp
//
// The iOS app is a Capacitor shell that loads the live site, and Capacitor
// puts `window.Capacitor` into the page before any page script runs. On
// 2026-11-20 the owner pressed Connect Wallet in that app and was offered
// Spark — a wallet the app holds, which the iOS app must not offer (it holds no
// funds; NWC only). Hiding the row is not enough: a Spark wallet also starts
// with no click at all, from the page-load restore of the kind:30078 seed
// backup (any signer that may decrypt unattended), from a local key's derived
// wallet, and from the Google new-account branch. All four reach ONE function,
// `sparkInitFromMnemonic`, so that is where the gate is, and this script
// drives the unclicked path as well as the row.
//
// Chrome plays the app by installing a `window.Capacitor` stub on every new
// document. The sign-in is a NIP-07 stub over a CDP binding (e2e-favorites),
// and the seed backup sits on a local relay. NOTHING IS PUBLISHED: the restore
// only reads, and `bmb:relays` points the publish set at the local relay. The
// Spark SDK chunk is BLOCKED for the whole run, so the browser half below
// never reaches Spark's operators: "Spark started" is measured as the app
// REQUESTING that chunk, which `doInitFromMnemonic` does first.
//
//   1. Browser, signed out — the picker offers NWC and Spark (must still work).
//   2. iOS app, signed out — the picker offers NWC and no Spark row.
//   3. iOS app, signed in, a Spark backup on the relay — the app never asks
//      for the Spark SDK, and the wallet window opens on the picker, no Spark.
//   4. Browser, the same sign-in — the app DOES ask for the Spark SDK. Without
//      this, step 3 could pass because the restore never ran at all.
//   5. A signer that may not decrypt unattended (Amber's stored session): the
//      "backup was not read" note names Spark in the browser and only NWC in
//      the app, whose picker has no Spark to send anyone to.
//   6. Browser, signed out — "Continue with Google" is in the header menu and
//      in the sign-in window, and opening the menu fetches Google's script.
//   7. iOS app, signed out — none of the three. Google refuses OAuth inside an
//      app's web view (`disallowed_useragent`), so the button could only fail;
//      the owner asked for it gone on 2026-11-20. The gate reads
//      `window.Capacitor`, which the server cannot see, so this step also
//      asserts no hydration error.
//   8. Browser — the sign-in window has no "Paste your nsec" row (the app only).
//   9. iOS app — the row is there; an npub is refused on screen; a generated
//      burner nsec signs in as its own npub, signs an event that verifies,
//      starts no Spark wallet (a local key's derived one is the fourth door),
//      and is still signed in after a reload. Neither the nsec nor its hex
//      appears in any request or any WebSocket frame the page sends. A typo'd
//      nsec is refused without echoing it, and the screen fits at 390 px.
//  10. iOS app — sign out warns that only the same nsec gets back in (not
//      Google), erases the key, and a reload stays signed out.
//   Steps 2 onward run at 390 x 844 under CDP phone emulation, and the open
//   wallet window must not scroll sideways.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04, verifyEvent } from 'nostr-tools';

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.
(and \`rm -rf .next\` first if you have just run a production build)`);

const { page } = await launchChrome({ name: 'ios-app', args: ['--disable-gpu'] });
const { send } = page;
const js = page.jsOrThrow;
const t = checker();

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const convo = nip44.v2.utils.getConversationKey(sk, pk);

// A seed backup exactly as `publishEncryptedMnemonic` writes it. The BIP-39
// test vector: the SDK chunk is blocked, so no wallet is ever opened with it.
const relay = createRelay({ port: 0, log: null });
const PORT = await relay.ready;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const backup = finalizeEvent({
  kind: 30078,
  created_at: Math.floor(Date.now() / 1000) - 600,
  tags: [['d', 'boostmebitch:wallet:spark']],
  content: nip44.v2.encrypt(MNEMONIC, convo),
}, sk);
relay.events.set(backup.id, backup);

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
const SPARK_CHUNK = /buildonspark|spark-sdk/i;
await send('Network.setBlockedURLs', { urls: ['*buildonspark*', '*spark-sdk*'] });
let sparkRequests = [];
let gisRequests = [];
let hydrationErrors = [];
page.on((m) => {
  if (m.method === 'Network.requestWillBeSent' && SPARK_CHUNK.test(m.params.request.url)) {
    sparkRequests.push(m.params.request.url);
  }
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('accounts.google.com/gsi/client')) {
    gisRequests.push(m.params.request.url);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/hydrat/i.test(text)) hydrationErrors.push(text.slice(0, 200));
  }
});

// The NIP-07 stub (the e2e-favorites pattern).
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
const { result: { identifier: nip07Script } } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
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

// What Capacitor's native bridge gives the page inside the iOS app: the same
// `getPlatform` / `isNativePlatform` answers @capacitor/core reads.
const CAPACITOR_STUB = `window.Capacitor = { getPlatform: () => 'ios', isNativePlatform: () => true };`;
let capacitorScript = null;
async function asIosApp(on) {
  if (on && !capacitorScript) {
    capacitorScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source: CAPACITOR_STUB })).result.identifier;
  } else if (!on && capacitorScript) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: capacitorScript });
    capacitorScript = null;
  }
}

async function load(path = '/') {
  await send('Page.navigate', { url: APP + path });
  await page.until(`document.readyState === 'complete' && !!document.querySelector('header')`, 30000);
  await wait(1500);
}

// The header's wallet entry: signed out it is a row in the SIGN IN menu,
// signed in a button of its own.
async function openWallet() {
  const opened = await js(`(() => {
    const direct = document.querySelector('button[aria-label="Connect Lightning wallet"], button[aria-label="Wallet connecting"], button[aria-label="Manage Lightning wallet"]');
    if (direct) { direct.click(); return 'button'; }
    const signIn = [...document.querySelectorAll('header button')].find((b) => /^SIGN IN/i.test(b.textContent.trim()));
    if (!signIn) return null;
    signIn.click();
    return 'menu';
  })()`);
  if (opened === 'menu') {
    // The row leads with an icon, so match its own label span.
    const row = `[...document.querySelectorAll('button')].find((b) => [...b.querySelectorAll('span')].some((x) => x.textContent.trim() === 'Connect wallet'))`;
    await page.until(`!!${row}`, 5000);
    await js(`(() => { ${row}.click(); return 1; })()`);
  }
  await page.until(`!!document.querySelector('[role="dialog"]')`, 5000);
  await wait(500);
  return opened;
}

// The picker's rail rows, by their title line, and whether a Spark CARD (the
// connected view) is on screen instead.
const walletView = () => js(`(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  const rows = [...d.querySelectorAll('button.card')].map((b) => (b.querySelector('.text-sm')?.textContent ?? '').trim());
  return JSON.stringify({ rows, sparkCard: /Spark\\s*·/.test(d.innerText) });
})()`).then((s) => (s ? JSON.parse(s) : null));
const hasRow = (v, word) => !!v && v.rows.some((r) => r.includes(word));

async function closeWallet() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.until(`!document.querySelector('[role="dialog"]')`, 3000);
}

async function signedIn(on) {
  await js(`(() => {
    localStorage.clear();
    ${on ? `
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'nip07');` : ''}
    return 1;
  })()`);
}

console.log(`\n  throwaway npub ${npub.slice(0, 20)}…  relay ws://127.0.0.1:${PORT}\n`);

console.log('1. Browser, signed out — the picker offers NWC and Spark (must still work)');
await load();
await signedIn(false);
await load();
await openWallet();
let v = await walletView();
t.ok('the picker shows an NWC row', hasRow(v, 'NWC'), JSON.stringify(v));
t.ok('the picker shows a Spark row', hasRow(v, 'Spark'), JSON.stringify(v));
await closeWallet();

console.log('\n2. iOS app, signed out — no Spark row');
await asIosApp(true);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await load();
t.ok('the page sees the Capacitor stub', await js(`window.Capacitor?.getPlatform?.() === 'ios'`));
await openWallet();
v = await walletView();
t.ok('the picker shows an NWC row', hasRow(v, 'NWC'), JSON.stringify(v));
t.ok('the picker shows NO Spark row', v && !hasRow(v, 'Spark'), JSON.stringify(v));
const overflow = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
t.ok('at 390 px the open wallet window does not scroll sideways', overflow <= 0, `overflow ${overflow}px`);
await closeWallet();

// The restore reads the backup with an 8 s ceiling (FEED_QUERY_MAX_WAIT_MS),
// after the profile and relay-list phase (about 4 s).
const RESTORE_WINDOW_MS = 16000;

console.log('\n3. iOS app, signed in, a Spark backup on the relay — Spark never starts');
await signedIn(true);
sparkRequests = [];
await load();
await page.until(`!!document.querySelector('button[aria-label="Connect Lightning wallet"], button[aria-label="Wallet connecting"], button[aria-label="Manage Lightning wallet"]')`, 20000);
await wait(RESTORE_WINDOW_MS);
t.ok('the app never asked for the Spark SDK', sparkRequests.length === 0, JSON.stringify(sparkRequests));
await openWallet();
v = await walletView();
t.ok('the wallet window shows no Spark card', v && !v.sparkCard, JSON.stringify(v));
t.ok('the picker shows NO Spark row', v && !hasRow(v, 'Spark'), JSON.stringify(v));
await closeWallet();

console.log('\n4. Browser, the same sign-in — the restore DOES start Spark (so step 3 measured something)');
await asIosApp(false);
await signedIn(true);
sparkRequests = [];
await load();
const asked = await (async () => {
  for (let i = 0; i < RESTORE_WINDOW_MS / 250; i++) {
    if (sparkRequests.length > 0) return true;
    await wait(250);
  }
  return false;
})();
t.ok('the app asked for the Spark SDK (blocked here, so nothing reached Spark)', asked, 'no Spark SDK request in the restore window');

// The note is Amber's case: `unattendedDecryptOk()` is false for it, so the
// backups are not read on load. No Amber exists in this browser, and none is
// asked: with nothing to decrypt, the stored session only renders.
const withheldNote = () => js(`(() => {
  const d = document.querySelector('[role="dialog"]');
  const n = d && [...d.querySelectorAll('div')].find((x) => /read\\s+automatically/.test(x.textContent) && x.children.length < 6);
  return n ? n.textContent.replace(/\\s+/g, ' ').trim() : null;
})()`);
async function amberSession() {
  await js(`(() => {
    localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'amber');
    return 1;
  })()`);
}

console.log('\n5. A signer that may not decrypt unattended — the note names only what the picker offers');
await amberSession();
await load();
await openWallet();
let note = await withheldNote();
t.ok('browser: the note is shown and names Spark', !!note && /Spark/.test(note), String(note));
await closeWallet();
await asIosApp(true);
await amberSession();
await load();
await openWallet();
note = await withheldNote();
t.ok('iOS app: the note is shown, names NWC, and does not name Spark', !!note && /NWC/.test(note) && !/Spark/.test(note), String(note));
await closeWallet();
await asIosApp(false);

// Where Google is offered: the header's SIGN IN menu, and the sign-in window
// that menu's "Sign in with Nostr" opens.
async function googleOffers() {
  await js(`(() => { [...document.querySelectorAll('header button')].find((b) => /^SIGN IN/i.test(b.textContent.trim())).click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.includes('Sign in with Nostr'))`, 5000);
  await wait(300);
  const inMenu = await js(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.includes('Continue with Google'))`);
  await js(`(() => { [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Sign in with Nostr')).click(); return 1; })()`);
  await page.until(`!!document.querySelector('[role="dialog"]')`, 5000);
  await wait(800);
  const inWindow = await js(`document.querySelector('[role="dialog"]').innerText.includes('Continue with Google')`);
  await closeWallet();
  return { inMenu, inWindow };
}

console.log('\n6. Browser, signed out — Google is offered (must still work)');
await asIosApp(false);
await signedIn(false);
await load();
gisRequests = [];
let g = await googleOffers();
t.ok('the header menu offers Continue with Google', g.inMenu);
t.ok('the sign-in window offers Continue with Google', g.inWindow);
t.ok("opening the menu fetched Google's sign-in script", gisRequests.length > 0, 'no request for accounts.google.com/gsi/client');

console.log('\n7. iOS app, signed out — Google is not offered');
await asIosApp(true);
await signedIn(false);
gisRequests = [];
hydrationErrors = [];
await load();
g = await googleOffers();
t.ok('the header menu does NOT offer Continue with Google', !g.inMenu);
t.ok('the sign-in window does NOT offer Continue with Google', !g.inWindow);
t.ok("Google's sign-in script was never fetched", gisRequests.length === 0, JSON.stringify(gisRequests));
t.ok('no hydration error on the page', hydrationErrors.length === 0, JSON.stringify(hydrationErrors));
await asIosApp(false);

// --- The pasted nsec ------------------------------------------------------
// From here the NIP-07 stand-in is gone: the local signer installs its own
// `window.nostr`, and the stand-in would answer for a different key.
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: nip07Script });
const burnerSk = generateSecretKey();
const burnerHex = Buffer.from(burnerSk).toString('hex');
const burnerPk = getPublicKey(burnerSk);
const burnerNsec = nip19.nsecEncode(burnerSk);
const outbound = [];
page.on((m) => {
  if (m.method === 'Network.requestWillBeSent') outbound.push(`${m.params.request.url} ${m.params.request.postData ?? ''}`);
  if (m.method === 'Network.webSocketFrameSent') outbound.push(m.params.response?.payloadData ?? '');
});
const leaks = () => outbound.filter((x) => x.includes(burnerNsec) || x.includes(burnerHex));
async function relaysOnly() {
  await js(`(() => { localStorage.clear(); localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))}); return 1; })()`);
}
async function openSignInWindow() {
  await js(`(() => { [...document.querySelectorAll('header button')].find((b) => /^SIGN IN/i.test(b.textContent.trim())).click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.includes('Sign in with Nostr'))`, 5000);
  await js(`(() => { [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Sign in with Nostr')).click(); return 1; })()`);
  await page.until(`!!document.querySelector('[role="dialog"]')`, 5000);
  await wait(600);
}
const NSEC_ROW = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Paste your nsec'))`;
const NSEC_INPUT = 'input[aria-label="nsec"]';
const typeNsec = (v) => js(`(() => {
  const el = document.querySelector(${JSON.stringify(NSEC_INPUT)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 1;
})()`);
const pressSignIn = () => js(`(() => { [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Sign in').click(); return 1; })()`);
const ACCOUNT = 'button[aria-label^="Account:"]';
const nostrPubkey = () => js(`window.nostr ? window.nostr.getPublicKey() : null`);

console.log('\n8. Browser — the sign-in window has no nsec row');
await asIosApp(false);
await signedIn(false);
await load();
await openSignInWindow();
t.ok('no "Paste your nsec" row in a browser', !(await js(`!!${NSEC_ROW}`)));
await closeWallet();

console.log('\n9. iOS app — a pasted burner nsec signs in, signs, and survives a reload');
await asIosApp(true);
await relaysOnly();
await load();
await openSignInWindow();
const rowThere = await js(`!!${NSEC_ROW}`);
t.ok('the sign-in window offers "Paste your nsec"', rowThere);
if (rowThere) {
  await js(`(() => { ${NSEC_ROW}.click(); return 1; })()`);
  await page.until(`!!document.querySelector(${JSON.stringify(NSEC_INPUT)})`, 5000);
  t.ok('the key field hides what is typed', await js(`document.querySelector(${JSON.stringify(NSEC_INPUT)}).type === 'password'`));
  await typeNsec(nip19.npubEncode(burnerPk));
  await pressSignIn();
  await wait(500);
  const refusal = await js(`document.querySelector('[role="dialog"]')?.innerText ?? ''`);
  t.ok('an npub is refused on screen, and nobody is signed in', /nsec1/.test(refusal) && !(await js(`!!document.querySelector(${JSON.stringify(ACCOUNT)})`)), refusal.slice(0, 300));
  // One character changed: the checksum fails. nip19.decode's own error quotes
  // the string, so the screen must show ours.
  const typo = burnerNsec.slice(0, -1) + (burnerNsec.endsWith('q') ? 'p' : 'q');
  await typeNsec(typo);
  await pressSignIn();
  await wait(500);
  const typoText = await js(`document.querySelector('[role="dialog"]')?.innerText ?? ''`);
  t.ok('a mistyped nsec is refused, and the screen does not show what was typed', /typing error/.test(typoText) && !typoText.includes(typo.slice(5, 25)), typoText.slice(0, 300));
  const fit = await js(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === 'Sign in').getBoundingClientRect();
    const i = document.querySelector(${JSON.stringify(NSEC_INPUT)}).getBoundingClientRect();
    return JSON.stringify({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, bw: b.width, bh: b.height, ih: i.height, width: innerWidth });
  })()`).then(JSON.parse);
  t.ok('at 390 px the nsec screen does not scroll sideways, and the field and button are 24 px or more', fit.width === 390 && fit.overflow <= 0 && fit.bw >= 24 && fit.bh >= 24 && fit.ih >= 24, JSON.stringify(fit));
  sparkRequests = [];
  await typeNsec(burnerNsec);
  await pressSignIn();
  const inUi = await page.until(`!document.querySelector('[role="dialog"]') && !!document.querySelector(${JSON.stringify(ACCOUNT)})`, 15000);
  t.ok('signed in: the window closed and the header shows the account', inUi);
  t.equal('window.nostr answers with the burner npub', await nostrPubkey(), burnerPk);
  const signed = await js(`(async () => { const t0 = performance.now(); const e = await window.nostr.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'e2e: local signature, never published' }); return JSON.stringify({ e, ms: performance.now() - t0 }); })()`).then(JSON.parse);
  t.ok('it signs an event that verifies, under the burner key', signed.e.pubkey === burnerPk && verifyEvent(signed.e), JSON.stringify(signed.e).slice(0, 200));
  t.ok('the signature took under 1 s (no round trip)', signed.ms < 1000, `${Math.round(signed.ms)} ms`);
  await wait(RESTORE_WINDOW_MS);
  t.ok('no Spark wallet started from the key', sparkRequests.length === 0, JSON.stringify(sparkRequests));
  await load();
  await page.until(`!!document.querySelector(${JSON.stringify(ACCOUNT)})`, 15000);
  await page.until(`!!window.nostr`, 10000);
  t.equal('after a reload it is still signed in as the burner', await nostrPubkey(), burnerPk);
  // So the next check reads real traffic: the app asked the relay about this key.
  t.ok('the capture saw relay frames naming the burner pubkey', outbound.some((x) => x.includes(burnerPk)), `${outbound.length} captured`);
  t.ok('the nsec never left the page (no request, no WebSocket frame)', leaks().length === 0, leaks().slice(0, 2).join(' | ').slice(0, 300));

  console.log('\n10. iOS app — sign out names the nsec, erases the key, and stays signed out');
  await js(`(() => { document.querySelector(${JSON.stringify(ACCOUNT)}).click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'sign out')`, 5000);
  await js(`(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'sign out').click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sign out and erase')`, 5000);
  const warning = await js(`[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => d.innerText).join(' ')`);
  t.ok('the warning says only the same nsec gets back in, and does not mention Google', /nsec/.test(warning) && !/Google/.test(warning), warning.slice(0, 300));
  await js(`(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sign out and erase').click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('header button')].some((b) => /^SIGN IN/i.test(b.textContent.trim()))`, 10000);
  await load();
  await wait(4000);
  t.ok('after a reload it is still signed out (the key was erased)', !(await js(`!!document.querySelector(${JSON.stringify(ACCOUNT)})`)));
} else {
  await closeWallet();
}
await asIosApp(false);

await signedIn(false);
relay.close();
console.log(`\n${t.fails ? `${t.fails} of ${t.count} check(s) FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
