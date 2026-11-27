// End-to-end for HOW LONG the bunker health flag lives, against nothing but
// this machine: a local relay, a stub NIP-46 signer, and a stub NIP-07
// extension. No key is reused and nothing reaches a public relay.
//
// THE BUG (full-code review 2026-11-19, lib/nostr/bunker.ts). `bunkerStale` is
// module state, and `<AccountMenu>` renders "Signer disconnected" — or the
// signer's quoted refusal — off it ALONE, without asking which signer the
// session uses. Two things left it up for a session it did not describe:
//   - SIGN-OUT never cleared it, so after a bunker session went stale (or was
//     refused), the next sign-in by extension opened onto the old fault, with
//     a RECONNECT that had no pointer left to use;
//   - a sign-in's own HANDSHAKE set it: a pasted `bunker://` whose signer acked
//     and then went quiet marked a session that did not exist yet, and the
//     extension sign-in that followed showed it.
//
// WHAT IT PINS:
//   1. A refused restore shows the refusal (must still work), and after
//      sign-out + an extension sign-in the account menu says nothing about a
//      signer.
//   2. A pasted `bunker://` whose `get_public_key` is never answered fails the
//      paste (must still work), and the extension sign-in after it shows no
//      banner.
//
// Scenario 2 waits out the 30 s per-call bound once.
//
//   npm run build && npm run start      (or `npm run dev`; any server on APP_URL)
//   APP_URL=http://127.0.0.1:3000 npm run e2e:bunkerstale

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` or \`npm run start\`.`);

const { page } = await launchChrome({ name: 'bunker-stale', args: ['--disable-gpu', '--window-size=1280,900'] });
const PORT = await createRelay({ port: 0, log: null }).ready;
const RELAY = `ws://127.0.0.1:${PORT}`;
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- the stub NIP-46 signer -------------------------------------------------
// One per scenario: its own key, its own client key, its own behaviour.
function stubSigner(behave) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const clientSk = generateSecretKey();
  const seen = [];
  let rpcKey = null;
  const ws = new WebSocket(RELAY);
  const opened = new Promise((r) => ws.addEventListener('open', r));
  opened.then(() => ws.send(JSON.stringify(['REQ', 's', { kinds: [24133], '#p': [pk] }])));
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg[0] !== 'EVENT' || msg[1] !== 's') return;
    const from = msg[2].pubkey;
    const key = nip44.v2.utils.getConversationKey(sk, from);
    let req;
    try { req = JSON.parse(nip44.v2.decrypt(msg[2].content, key)); } catch { return; }
    seen.push(req.method);
    const reply = behave(req);
    if (!reply) return;
    rpcKey = key;
    ws.send(JSON.stringify(['EVENT', finalizeEvent({
      kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', from]],
      content: nip44.v2.encrypt(JSON.stringify({ id: req.id, ...reply }), rpcKey),
    }, sk)]));
  });
  return { pk, clientSk, seen, opened, close: () => ws.close(), uri: `bunker://${pk}?relay=${encodeURIComponent(RELAY)}` };
}

// ---- the stub NIP-07 extension ------------------------------------------------
// Installed INTO THE RUNNING PAGE, never by a reload: the flag under test is
// module state, so a navigation between the sign-out and the sign-in resets it
// and the test passes against the bug (it did, the first time this was run).
const extSk = generateSecretKey();
const extPk = getPublicKey(extSk);
const { send } = page;
const js = page.jsOrThrow;
await send('Page.enable');
await send('Runtime.enable');
const installExtension = () => js(`(() => {
  window.nostr = {
    async getPublicKey() { return ${JSON.stringify(extPk)}; },
    async signEvent() { throw new Error('e2e: this stub signs nothing'); },
  };
  return 1;
})()`);

const t = checker();
const text = () => js('document.body.innerText || ""');
const BANNER = /Signer disconnected|Your signer refused this connection/i;
const accountMenuText = () => js(`(() => {
  const m = [...document.querySelectorAll('[role="menu"]')].find((el) => /sign out/i.test(el.innerText || ''));
  return m ? m.innerText : null;
})()`);
async function openAccountMenu() {
  for (let round = 0; round < 20; round += 1) {
    if (await accountMenuText() !== null) return true;
    const n = await js(`document.querySelectorAll('button[aria-haspopup="menu"]').length`);
    for (let i = 0; i < n; i += 1) {
      await js(`(() => { const b = document.querySelectorAll('button[aria-haspopup="menu"]')[${i}]; b && b.click(); return 1; })()`);
      await wait(300);
      if (await accountMenuText() !== null) return true;
    }
    await wait(500);
  }
  return false;
}
const triggerLabels = () => js(`[...document.querySelectorAll('button[aria-haspopup="menu"]')].map((b) => (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + b.innerText).join(' | ')`);
const clickButton = (re) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => ${re}.test((x.innerText || '').trim())); if (!b || b.disabled) return false; b.click(); return true; })()`);
async function until(pred, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() > end) return v; await wait(step); }
}
async function openSignIn() {
  // The header's control: "Sign in" (a dropdown when it lists two options), then
  // "Sign in with Nostr".
  await until(() => clickButton('/^Sign in\\s*[▾▴]?$/i'), 15000);
  await wait(400);
  // The item's text starts with its "◆" glyph, so this one is not anchored.
  await until(() => clickButton('/Sign in with Nostr/i'), 5000);
  return until(async () => /Browser Extension|Bunker URI|Scan a QR/i.test(await text()), 10000);
}
const modalOpen = () => js(`/Browser Extension|Bunker URI|Scan a QR|Paste your bunker/i.test(document.body.innerText || '')`);
async function closeModal() {
  for (let i = 0; i < 4 && (await modalOpen()); i += 1) {
    const x = await js(`(() => { const b = document.querySelector('button[aria-label="Close"]'); if (b) { b.click(); return true; } return false; })()`);
    if (!x) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
    await wait(500);
  }
  return !(await modalOpen());
}
async function signInWithExtension() {
  // The modal reads `window.nostr` when it MOUNTS, so it is closed first and the
  // extension is in place before it opens again — with no reload in between.
  if (!(await closeModal())) return 'the sign-in modal would not close';
  await installExtension();
  const reloads = await js('performance.getEntriesByType("navigation").length');
  if (!(await openSignIn())) return 'the sign-in modal did not open';
  if (!(await until(() => clickButton('/^Browser Extension/i'), 10000))) return 'no Browser Extension row';
  const npub = nip19.npubEncode(extPk);
  const ok = await until(async () => (await js(`localStorage.getItem('bmb:npub')`)) === npub, 15000);
  if (!ok) return 'the extension sign-in did not complete';
  // Same document as the sign-out: a navigation here would void the test.
  return (await js('performance.getEntriesByType("navigation").length')) === reloads ? 'ok' : 'the page reloaded';
}
async function freshOrigin() {
  await send('Page.navigate', { url: APP });
  await until(() => js(`document.readyState === 'complete'`), 30000);
  await js(`(() => { localStorage.clear(); localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([RELAY]))}); return 1; })()`);
}

// ------------------------------------------------------------------------------------
console.log('\n1. a refused restore, then sign-out, then an extension sign-in');
{
  const sessionSk = generateSecretKey();
  const sessionNpub = nip19.npubEncode(getPublicKey(sessionSk));
  // Clave's own words for its side of the pairing being gone.
  const signer = stubSigner(() => ({ error: 'Pairing limit reached' }));
  await signer.opened;
  await freshOrigin();
  await js(`(() => {
    localStorage.setItem('bmb:npub', ${JSON.stringify(sessionNpub)});
    localStorage.setItem('bmb:signer', 'bunker');
    localStorage.setItem('bmb:bunker', ${JSON.stringify(JSON.stringify({ uri: signer.uri, clientSk: hex(signer.clientSk) }))});
    return 1; })()`);
  await send('Page.navigate', { url: APP });
  await until(() => js(`document.readyState === 'complete'`), 30000);
  const asked = await until(() => signer.seen.length > 0, 20000);
  t.ok('the restore reached the stub signer', !!asked, JSON.stringify(signer.seen));
  t.ok('the account menu opens', await openAccountMenu());
  const refusedShown = await until(async () => BANNER.test((await accountMenuText()) ?? ''), 20000);
  t.ok('must still work: the refusal is on screen', !!refusedShown, ((await accountMenuText()) ?? '').slice(0, 300));
  t.ok('...in the signer’s own words', /Pairing limit reached/.test((await accountMenuText()) ?? ''));

  await clickButton('/^sign out$/i');
  t.ok('signed out', !!(await until(async () => (await js(`localStorage.getItem('bmb:npub')`)) === null, 10000)));

  const r = await signInWithExtension();
  t.equal('signed in with the extension', r, 'ok');
  t.ok('the account menu opens', await openAccountMenu());
  await wait(1500);
  const menu = (await accountMenuText()) ?? '';
  t.ok('the menu says nothing about a signer', !BANNER.test(menu), menu.slice(0, 400));
  t.ok('...and the account button does not either', !/signer disconnected/i.test(await triggerLabels()), await triggerLabels());
  signer.close();
}

// ------------------------------------------------------------------------------------
console.log('\n2. a pasted bunker:// that never answers get_public_key, then an extension sign-in');
{
  // Acks the connect, then holds get_public_key forever.
  const signer = stubSigner((req) => (req.method === 'connect' ? { result: 'ack' } : null));
  await signer.opened;
  await freshOrigin();
  await send('Page.navigate', { url: APP });
  await until(() => js(`document.readyState === 'complete'`), 30000);
  await wait(1500);
  t.ok('the sign-in modal opens', !!(await openSignIn()));
  t.ok('the Bunker URI screen opens', !!(await until(() => clickButton('/^Bunker URI/i'), 10000)));
  const typed = await until(() => js(`(() => {
    const el = [...document.querySelectorAll('textarea, input')].find((x) => /bunker/i.test(x.placeholder || ''));
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(signer.uri)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`), 10000);
  t.ok('the bunker:// was entered', !!typed);
  await wait(300);
  t.ok('Connect pressed', !!(await until(() => clickButton('/^Connect\\b/i'), 5000)));
  const acked = await until(() => signer.seen.includes('get_public_key'), 20000);
  t.ok('the stub acked and was asked get_public_key', !!acked, JSON.stringify(signer.seen));
  console.log('  (waiting out the 30 s per-call bound)');
  const failed = await until(async () => (await js(`localStorage.getItem('bmb:npub')`)) === null
    && /fail|time|answer|error/i.test(await text()) && !/Connecting/i.test(await text()), 60000, 1000);
  t.ok('must still work: the paste failed and nothing signed in', !!failed && (await js(`localStorage.getItem('bmb:npub')`)) === null);
  signer.close();

  const r = await signInWithExtension();
  t.equal('signed in with the extension', r, 'ok');
  t.ok('the account menu opens', await openAccountMenu());
  await wait(1500);
  const menu = (await accountMenuText()) ?? '';
  t.ok('the menu says nothing about a signer', !BANNER.test(menu), menu.slice(0, 400));
  t.ok('...and the account button does not either', !/signer disconnected/i.test(await triggerLabels()), await triggerLabels());
}

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
