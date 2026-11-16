// End-to-end for THE RED RECONNECT DOT THAT NEEDS A PRESS, against nothing but
// this machine.
//
// Usage:
//   npm run build && npx next start -p 3417      # in another terminal
//   APP_URL=http://127.0.0.1:3417 npm run e2e:bunkerrevive
//   add --headed to watch, --keep to leave the browser open
//
// THE REPORT. Chad, on an iPhone with Clave, 2026-11-15: *"See the red little
// reconnect thing pop up with [Clave] a lot, and usually I click that and it
// reconnects, or sometimes I just hit my profile image up to the top menu and
// just open that menu sometimes, reconnects it."* Opening the menu reconnects
// nothing by itself — the tap fires `focus`, which `startBunkerRevive` listens
// for. So every dot that waited for him was one the app's own reconnect had
// given up on, or had raised AFTER it had already succeeded. Two of those are
// reproducible here, and neither needs a phone:
//
//   1. A request issued while a revive is PROBING rides the old transport. The
//      revive's ping fails, it closes that transport and builds a new one — and
//      the request it closed under is never rejected, so it sits out its 30 s,
//      pings its own CLOSED signer, gets nothing, and marks the session stale.
//      The dot goes up over a link that has just been rebuilt and works.
//   2. The retry ladder dies on a busy session. A rung that lands while any
//      signer request is in flight returned, and nothing armed it again —
//      `setBunkerStale` notifies only on a change — so the dot stayed until a
//      foreground return or a press.
//
// The stub signer reads every request and answers none until the page sends
// `connect` — the page's view of a link whose answers are lost, and of the
// rebuild that fixes it. NOTHING LEAVES THE MACHINE: Chrome resolves no host
// but this one, the relay is on a free local port, every key is per run. It
// loads /listen with an empty queue, so it needs no Podcast Index.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm run build && npx next start -p <port>\` and pass APP_URL.`);

const t = checker();
const section = (s) => console.log(`\n${s}`);

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const PORT = await createRelay({ port: 0, log: null }).ready;
const RELAY = `ws://127.0.0.1:${PORT}`;

// ---- the stub remote signer --------------------------------------------------
const bunkerSk = generateSecretKey();
const bunkerPk = getPublicKey(bunkerSk);
const clientSk = generateSecretKey();
const clientPk = getPublicKey(clientSk);
const rpcKey = nip44.v2.utils.getConversationKey(bunkerSk, clientPk);

/** 'answer' | 'deaf' | 'deaf-until-connect' — see e2e-boost-note-signer.mjs. */
let mode = 'answer';
const seen = [];
const relayWs = new WebSocket(RELAY);
await new Promise((r) => relayWs.addEventListener('open', r));
relayWs.send(JSON.stringify(['REQ', 'bunker', { kinds: [24133], '#p': [bunkerPk] }]));
relayWs.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] !== 'EVENT' || msg[1] !== 'bunker') return;
  let req;
  try { req = JSON.parse(nip44.v2.decrypt(msg[2].content, rpcKey)); } catch { return; }
  seen.push({ method: req.method, at: Date.now() });
  if (mode === 'deaf') return;
  if (mode === 'deaf-until-connect') {
    if (req.method !== 'connect') return;
    mode = 'answer';
  }
  const reply = req.method === 'connect' ? { id: req.id, result: 'ack' }
    : req.method === 'get_public_key' ? { id: req.id, result: pk }
    : req.method === 'ping' ? { id: req.id, result: 'pong' }
    : req.method === 'sign_event' ? { id: req.id, result: JSON.stringify(finalizeEvent(JSON.parse(req.params[0]), sk)) }
    : { id: req.id, error: `unsupported: ${req.method}` };
  relayWs.send(JSON.stringify(['EVENT', finalizeEvent({
    kind: 24133,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', clientPk]],
    content: nip44.v2.encrypt(JSON.stringify(reply), rpcKey),
  }, bunkerSk)]));
});
const methodsSince = (at) => seen.filter((s) => s.at >= at).map((s) => s.method);

// ---- the browser -------------------------------------------------------------
const { page } = await launchChrome({
  name: 'bunker-revive',
  args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, js, until } = page;
const exceptions = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300));
  }
});
await send('Page.enable');
await send('Runtime.enable');

/** The red dot: the account button names it in its accessible name. */
const dotUp = () => js(`[...document.querySelectorAll('button[aria-haspopup="menu"]')]
  .some((b) => /signer disconnected/i.test(b.getAttribute('aria-label') || ''))`);
/** A signature the app did not ask for, through the same `window.nostr` every surface uses. */
const startSign = (tag) => js(`(() => {
  window.__r = window.__r || {};
  window.__r[${JSON.stringify(tag)}] = 'pending';
  window.nostr.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: ${JSON.stringify(tag)} })
    .then(() => { window.__r[${JSON.stringify(tag)}] = 'ok'; })
    .catch((e) => { window.__r[${JSON.stringify(tag)}] = 'err: ' + (e && e.message ? e.message : e); });
  return 1;
})()`);
const result = (tag) => js(`(window.__r || {})[${JSON.stringify(tag)}] ?? null`);
/** What a tap on the page does on iOS when the app comes back: a window focus. */
const wake = () => js(`(() => { window.dispatchEvent(new Event('focus')); return 1; })()`);

async function openSession() {
  mode = 'answer';
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([RELAY]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'bunker');
    localStorage.setItem('bmb:bunker', ${JSON.stringify(JSON.stringify({ uri: `bunker://${bunkerPk}?relay=${RELAY}`, clientSk: Buffer.from(clientSk).toString('hex') }))});
    return 1; })()`);
  // /listen, not /privacy: the static page mounts no <NostrAuth>, so nothing
  // restores the session there. /listen with an empty queue asks Podcast Index
  // nothing.
  await send('Page.navigate', { url: `${APP}/listen` });
  await until('document.readyState === "complete"');
  const ok = await until(`!!window.nostr && typeof window.nostr.signEvent === 'function'`, 20000);
  // Past the revive's 30 s throttle from the page-load restore's own stamp is
  // not needed: the load does not stamp it. One quiet second for the restore.
  await wait(1000);
  return ok;
}
/** Sample the dot every 250 ms for `ms`; return when it was first seen up, or null. */
async function watchDot(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await dotUp()) return Date.now();
    await wait(250);
  }
  return null;
}

// ---------------------------------------------------------------------------
section('1. A request made while the revive is probing: no dot over a rebuilt link');
{
  t.ok('signed in over the bunker', await openSession());
  t.equal('no dot to start with', await dotUp(), false);
  mode = 'deaf-until-connect';
  const t0 = Date.now();
  await wake(); // the revive pings, and nothing answers for 10 s
  await wait(1500);
  await startSign('during-probe'); // rides the transport the revive is about to close
  const rebuilt = await (async () => {
    for (let i = 0; i < 100; i += 1) { if (methodsSince(t0).includes('connect')) return true; await wait(250); }
    return false;
  })();
  t.ok('the revive found the link dead and rebuilt it', rebuilt, methodsSince(t0).join(' '));
  // Past the stranded request's 30 s bound and its ping, with room to spare.
  const dotAt = await watchDot(45000);
  t.equal('the dot never went up', dotAt === null ? null : `${Math.round((dotAt - t0) / 1000)} s after the wake`, null);
  t.ok('the stranded request failed — it rode a transport that was closed', /^err:/.test(await result('during-probe') ?? ''), await result('during-probe'));
  await startSign('after');
  t.ok('and the rebuilt link signs', await until(`(window.__r || {}).after === 'ok'`, 10000), await result('after'));
}

// ---------------------------------------------------------------------------
section('2. The dot goes up while the session is busy: the app still reconnects on its own');
{
  t.ok('signed in over the bunker', await openSession());
  mode = 'deaf';
  const t0 = Date.now();
  await startSign('first');           // times out at 30 s, its ping at 40 s: the dot
  await wait(5000);
  await startSign('second');          // still in flight when the ladder's first rung lands
  const dotAt = await watchDot(50000);
  t.ok('the dot went up — nothing answered', dotAt !== null, 'no dot');
  // The signer is reachable again by the time a rung can run.
  mode = 'deaf-until-connect';
  // No focus, no press: only the ladder may bring it back.
  const cleared = await until(`![...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some((b) => /signer disconnected/i.test(b.getAttribute('aria-label') || ''))`, 60000, 500);
  t.ok('the dot clears by itself, with no tap and no press', cleared,
    `after ${Math.round((Date.now() - t0) / 1000)} s; requests: ${methodsSince(t0).join(' ')}`);
  t.ok('...because the app rebuilt the link', methodsSince(t0).includes('connect'), methodsSince(t0).join(' '));
  await startSign('after');
  t.ok('and the rebuilt link signs', await until(`(window.__r || {}).after === 'ok'`, 10000), await result('after'));
}

// ---------------------------------------------------------------------------
section('3. Must still work: a healthy link raises no dot and signs');
{
  t.ok('signed in over the bunker', await openSession());
  const t0 = Date.now();
  await startSign('healthy');
  t.ok('it signs', await until(`(window.__r || {}).healthy === 'ok'`, 10000), await result('healthy'));
  await wake();
  t.equal('a wake pings and goes no further', await watchDot(5000), null);
  t.equal('no rebuild', methodsSince(t0).includes('connect'), false);
}

// ---------------------------------------------------------------------------
section('Page health');
t.equal('no page exceptions', exceptions, []);

relayWs.close();
console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
