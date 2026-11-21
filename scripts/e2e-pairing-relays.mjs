// End-to-end for the RELAYS A nostrconnect:// PAIRING NAMES (NOSTRCONNECT_RELAYS
// in lib/nostr/bunker.ts; docs/signers.md, "The pairing relays").
//
// Every "Sign in with Clave", Primal and "Scan a QR code" pairing writes these
// relays into its URI, and the signer acks on them. Clave connects to EVERY
// relay in the URI before it acks, so one relay that is down delays the ack —
// and on an iPhone the user's switch back suspends Clave before it is sent.
// relay.nostrconnect.com refused 8 of 9 connections on 2026-11-20.
//
// This drives the real sign-in window against the REAL relays, because a relay
// that is down is exactly what a local relay cannot show:
//   1. The QR screen's URI names the shipped relays, and only those.
//   2. For EACH relay alone, a stand-in signer (a random key) acks the pairing
//      and answers the app's requests on that relay only. The app must sign in
//      as the stand-in's key: each relay carries a whole sign-in by itself.
//
// What it publishes: kind:24133 events (ephemeral, NIP-44 encrypted) from
// throwaway keys, on the pairing relays only. Everything else the signed-in app
// reads or writes goes to a local relay (`bmb:relays`), so no public relay sees
// a profile, list or note from these keys.
//
// Needs the network. Run against a dev server: `npm run e2e:pairing`
// (BMB_APP=http://localhost:3019 for another port).

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';

const EXPECTED = ['wss://offchain.pub', 'wss://relay.powr.build'];
const RETIRED = ['wss://relay.nostrconnect.com', 'wss://relay.nsec.app'];

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

const local = createRelay({ port: 0, log: null });
const PORT = await local.ready;
const { page } = await launchChrome({ name: 'pairing-relays', args: ['--disable-gpu'] });
const { send } = page;
const js = page.jsOrThrow;
const t = checker();
await send('Page.enable'); await send('Runtime.enable');

async function load() {
  await send('Page.navigate', { url: APP + '/' });
  await page.until(`document.readyState === 'complete' && !!document.querySelector('header')`, 30000);
  await wait(1500);
}
async function signedOutLocal() {
  await js(`(() => { localStorage.clear(); localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))}); return 1; })()`);
}
const ACCOUNT = 'button[aria-label^="Account:"]';

// Open "Scan a QR code" and return the nostrconnect:// URI it shows.
async function qrUri() {
  await js(`(() => { [...document.querySelectorAll('header button')].find((b) => /^SIGN IN/i.test(b.textContent.trim())).click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.includes('Sign in with Nostr'))`, 5000);
  await js(`(() => { [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Sign in with Nostr')).click(); return 1; })()`);
  await page.until(`!!document.querySelector('[role="dialog"]')`, 5000);
  await js(`(() => { [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Scan a QR code')).click(); return 1; })()`);
  await wait(800);
  await js(`(() => { const g = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Generate QR Code')); if (g) g.click(); return 1; })()`);
  await page.until(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === 'Show link')`, 10000);
  await js(`(() => { [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Show link').click(); return 1; })()`);
  await page.until(`/^nostrconnect:/.test(document.querySelector('[role="dialog"] code')?.textContent ?? '')`, 5000);
  return js(`document.querySelector('[role="dialog"] code').textContent.trim()`);
}

function parseUri(uri) {
  const u = new URL(uri);
  return { clientPk: u.hostname || u.pathname.replace(/^\/+/, ''), relays: u.searchParams.getAll('relay'), secret: u.searchParams.get('secret') };
}

// A stand-in signer on ONE relay: acks the pairing, then answers requests.
async function standInSigner(relayUrl, clientPk, secret) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const key = nip44.v2.utils.getConversationKey(sk, clientPk);
  const ws = await new Promise((res, rej) => {
    const s = new WebSocket(relayUrl);
    const tm = setTimeout(() => rej(new Error(`connect timeout ${relayUrl}`)), 10000);
    s.onopen = () => { clearTimeout(tm); res(s); };
    s.onerror = () => { clearTimeout(tm); rej(new Error(`connect failed ${relayUrl}`)); };
  });
  const reply = (obj) => ws.send(JSON.stringify(['EVENT', finalizeEvent({
    kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', clientPk]],
    content: nip44.v2.encrypt(JSON.stringify(obj), key),
  }, sk)]));
  const methods = [];
  ws.onmessage = (m) => {
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
  };
  ws.send(JSON.stringify(['REQ', 'signer', { kinds: [24133], '#p': [pk] }]));
  await wait(400);
  const t0 = Date.now();
  reply({ id: Math.random().toString(36).slice(2), result: secret });
  return { pk, t0, methods, close: () => { try { ws.close(); } catch {} } };
}

console.log('1. The pairing URI names the shipped relays');
await load();
await signedOutLocal();
await load();
const uri = await qrUri();
const parsed = parseUri(uri);
t.ok('the URI has a client key and a secret', /^[0-9a-f]{64}$/.test(parsed.clientPk) && !!parsed.secret, uri.slice(0, 120));
t.equal('its relays are exactly the shipped pair', JSON.stringify([...parsed.relays].sort()), JSON.stringify([...EXPECTED].sort()));
t.ok('no retired relay is in it', !parsed.relays.some((r) => RETIRED.includes(r.replace(/\/$/, ''))), JSON.stringify(parsed.relays));

for (const relayUrl of EXPECTED) {
  console.log(`\n2. A stand-in signer acks and answers on ${relayUrl} ONLY — the app signs in`);
  await signedOutLocal();
  await load();
  const p = parseUri(await qrUri());
  let signer = null;
  try {
    signer = await standInSigner(relayUrl, p.clientPk, p.secret);
  } catch (e) {
    t.ok(`the stand-in reached ${relayUrl}`, false, String(e.message));
    continue;
  }
  const inUi = await page.until(`!!document.querySelector(${JSON.stringify(ACCOUNT)})`, 30000);
  const ms = Date.now() - signer.t0;
  t.ok(`signed in through ${relayUrl} alone`, inUi, `methods seen: ${JSON.stringify(signer.methods)}`);
  if (inUi) {
    await page.until(`!!window.nostr`, 10000);
    t.equal('window.nostr answers with the stand-in key', await js(`window.nostr.getPublicKey()`), signer.pk);
    console.log(`     (ack to signed-in header: ${ms} ms; requests answered: ${signer.methods.join(', ')})`);
  }
  signer.close();
}

await signedOutLocal();
local.close();
console.log(`\n${t.fails ? `${t.fails} of ${t.count} check(s) FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
