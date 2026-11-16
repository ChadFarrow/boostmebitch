// End-to-end for THE BOOST NOTE AND A SIGNER LINK THAT HAS GONE DEAF, against
// nothing but this machine.
//
// Usage:
//   npm run build && npx next start -p 3417      # in another terminal
//   APP_URL=http://127.0.0.1:3417 npm run e2e:boostnote
//   add --headed to watch, --keep to leave the browser open
//
// THE REPORT. Chad, on an iPhone with Clave: *"i sent a boost in BMB but clave
// needed to reconnect so it didnt go to nostr … i clicked the reconnect for it
// and it reconnected just fine. Ive noticed this a lot with clave lately when
// its signed it but needs a wake up on the connection."* The sats moved, the
// note never posted, and RECONNECT fixed the link at once.
//
// THE SHAPE, and why a stub that stops REPLYING is a faithful copy of it. The
// page's kind:24133 subscription is gone while a publish still gets out (see
// `checkSignerLink` in lib/nostr/auth.ts for the nostr-tools mechanics): the
// request reaches the signer and the answer reaches nothing. From the page's
// side that is exactly a signer that reads every request and answers none —
// until the page rebuilds its transport, which is what RECONNECT does, and
// after which answers arrive again. `deaf-until-connect` below is that.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but this one
// (`--host-resolver-rules`), the app publishes to a relay on a free local port,
// every key is generated per run, and the wallet is a WebLN stand-in that
// records each keysend and moves nothing. `/api/item-value` is answered by the
// script with a one-recipient keysend block, so every leg is that stand-in.
// The server still reads Podcast Index for the episode page, and the summary
// receipt is signed by the local server's SITE_NOSTR_SK. Back-to-back runs can
// draw a Podcast Index 429 (the server logs `lookup failed: PI 429`), which
// fails at "episode open" — wait a few minutes rather than rerun at once.
//
// What it pins, in order of what it costs when wrong:
//   1. THE FIELD BUG. A link that answers nothing until reconnected: the boost
//      pays at once, the check finds the link dead and reconnects, and only
//      THEN is anything signed — the note reaches the relay. Before the fix
//      both signatures went into the dead link and the note was lost.
//   2. A signer that never answers: nothing is signed at all, the modal stays
//      OPEN with the reason, and RETRY NOTE posts the note once the signer is
//      back — one note, and the receipt request signed with it.
//   3. Boost-all, the same field bug through the other modal.
//      At 390 and 320 px wide nothing overflows and the button is 24×24.
//   4. Must still work: a healthy signer costs one ping, and the modal closes
//      on its own once the note is out.
//   5. Must still work: an extension signer (NIP-07) is never probed.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip04, nip19, nip44 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr — has an album to boost-all
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range
const EPISODE_URL = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm run build && npx next start -p <port>\` and pass APP_URL.`);

const t = checker();
const section = (s) => console.log(`\n${s}`);

// ---- the relay, and what reaches it ------------------------------------------
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const published = []; // every event the app stored, in arrival order
const PORT = await createRelay({ port: 0, log: null, onEvent: (e) => published.push(e) }).ready;
const RELAY = `ws://127.0.0.1:${PORT}`;
// A `wss://` relay nothing can reach. `mintSummaryReceipt` keeps only `wss://`
// relays, so without one it returns before the kind:9734 is signed and the
// signature order below would be untested. The receipt itself is never
// published anywhere — Chrome resolves no host but this one — so the summary
// receipt and the retry's reuse of it are NOT covered here.
const UNREACHABLE = 'wss://relay.invalid';
const RELAYS = [RELAY, UNREACHABLE];
const notesSince = (mark) => published.slice(mark).filter((e) => e.kind === 1 && e.pubkey === pk && e.content.startsWith('⚡ Boost ⚡'));

// ---- the stub remote signer --------------------------------------------------
const bunkerSk = generateSecretKey();
const bunkerPk = getPublicKey(bunkerSk);
const clientSk = generateSecretKey();
const clientPk = getPublicKey(clientSk);
const rpcKey = nip44.v2.utils.getConversationKey(bunkerSk, clientPk);

/**
 * 'answer'             — a healthy link.
 * 'deaf-until-connect' — the field bug: every request is read, none is
 *                        answered, until a `connect` (the page rebuilding its
 *                        transport) arrives; from then on, 'answer'.
 * 'deaf'               — a signer nothing reaches.
 */
let mode = 'answer';
const seen = []; // { method, kind, at }
const relayWs = new WebSocket(RELAY);
await new Promise((r) => relayWs.addEventListener('open', r));
relayWs.send(JSON.stringify(['REQ', 'bunker', { kinds: [24133], '#p': [bunkerPk] }]));
relayWs.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] !== 'EVENT' || msg[1] !== 'bunker') return;
  let req;
  try { req = JSON.parse(nip44.v2.decrypt(msg[2].content, rpcKey)); } catch { return; }
  const kind = req.method === 'sign_event' ? JSON.parse(req.params[0]).kind : undefined;
  seen.push({ method: req.method, kind, at: Date.now() });
  if (mode === 'deaf') return;
  if (mode === 'deaf-until-connect') {
    if (req.method !== 'connect') return;
    mode = 'answer';
  }
  send46(replyFor(req));
});
function replyFor(req) {
  if (req.method === 'connect') return { id: req.id, result: 'ack' };
  if (req.method === 'get_public_key') return { id: req.id, result: pk };
  if (req.method === 'ping') return { id: req.id, result: 'pong' };
  if (req.method === 'sign_event') {
    return { id: req.id, result: JSON.stringify(finalizeEvent(JSON.parse(req.params[0]), sk)) };
  }
  return { id: req.id, error: `unsupported: ${req.method}` };
}
function send46(reply) {
  relayWs.send(JSON.stringify(['EVENT', finalizeEvent({
    kind: 24133,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', clientPk]],
    content: nip44.v2.encrypt(JSON.stringify(reply), rpcKey),
  }, bunkerSk)]));
}
const seenSince = (at) => seen.filter((s) => s.at >= at);
const signsSince = (at) => seenSince(at).filter((s) => s.method === 'sign_event');

// ---- the browser -------------------------------------------------------------
const { page } = await launchChrome({
  name: 'boost-note-signer',
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

// Every leg is this one node, paid by the WebLN stand-in below.
const PAYEE = `02${getPublicKey(generateSecretKey())}`;
const ITEM_VALUE = {
  read: true,
  value: { type: 'lightning', method: 'keysend', suggested: '0.00000005000', recipients: [{ name: 'e2e payee', type: 'node', address: PAYEE, split: 100 }] },
  valueTimeSplits: [],
};
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/item-value*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  await send('Fetch.fulfillRequest', {
    requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(ITEM_VALUE)).toString('base64'),
  });
});

// A wallet that pays after a short delay, like a real one, and records when.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__paid = [];
  window.webln = {
    enable: async () => {},
    isEnabled: async () => true,
    getInfo: async () => ({ node: { alias: 'e2e' }, methods: ['getInfo', 'getBalance', 'keysend'] }),
    getBalance: async () => ({ balance: 1000000 }),
    keysend: async (a) => {
      window.__paid.push({ at: Date.now(), amount: a.amount });
      await new Promise((r) => setTimeout(r, window.__payMs ?? 1500));
      return { preimage: '00'.repeat(32) };
    },
    sendPayment: async () => { throw new Error('e2e: keysend only'); },
    makeInvoice: async () => { throw new Error('e2e: keysend only'); },
  };
` });

// ---- helpers -------------------------------------------------------------------
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const buttonIn = (re) => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()))`;
const SEND = buttonIn(/^send \d+ sats?$/i);
const BOOST_ALL = buttonIn(/^boost \d+ tracks?$/i);
const RETRY_NOTE = buttonIn(/^retry note$/i);
const dialogText = () => js(`${DIALOG}?.innerText ?? ''`);
const paid = () => js(`window.__paid`);

// The rail the boost will pay by, already recorded: `recordLastRail` publishes
// an encrypted settings backup through the signer when the rail CHANGES, and
// that request would land in the middle of the logs below.
const SAME_RAIL = `localStorage.setItem('bmb:rail_pref', 'webln');`;
const bunkerSession = (extra = '') => `localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify(RELAYS))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'bunker');
  localStorage.setItem('bmb:bunker', ${JSON.stringify(JSON.stringify({ uri: `bunker://${bunkerPk}?relay=${RELAY}`, clientSk: Buffer.from(clientSk).toString('hex') }))});
  ${SAME_RAIL}
  ${extra}`;

/** A fresh store, the episode page, a signed-in session whose transport is up. */
async function openEpisode(setup) {
  mode = 'answer';
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { ${setup} return 1; })()`);
  await send('Page.navigate', { url: EPISODE_URL });
  await until('document.readyState === "complete"');
  const ready = await until(`!!document.querySelector('button[aria-label="Boost this episode"]')`, 60000);
  // The page-load restore must have connected before the scenario breaks the link.
  const signer = await until(`!!window.nostr && typeof window.nostr.signEvent === 'function'`, 20000);
  await wait(1000);
  return ready && signer;
}
async function openBoost() {
  await js(`document.querySelector('button[aria-label="Boost this episode"]')?.click()`);
  return until(`!!(${FIELD})`, 15000);
}
async function openBoostAll() {
  await js(`document.querySelector('button[aria-label="More actions"]')?.click()`);
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => /boost all \\d+ tracks/i.test(b.textContent))`, 10000);
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => /boost all \\d+ tracks/i.test(b.textContent))?.click()`);
  return until(`!!(${FIELD})`, 15000);
}
async function typeAmount(text) {
  await js(`(() => { const f = ${FIELD}; f.blur(); f.focus(); f.select(); return 1; })()`);
  await wait(50);
  await send('Input.insertText', { text });
  await wait(200);
}
async function pressSend(button = SEND) {
  await until(`!!(${button}) && !(${button}).disabled`, 15000);
  const at = Date.now();
  await js(`(${button}).click()`);
  return at;
}
const accountMenuStale = async () => {
  await js(`document.querySelector('button[aria-haspopup="menu"]')?.click()`);
  await wait(400);
  const stale = await js(`/Signer disconnected/i.test(document.body.innerText || '')`);
  await js(`(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1; })()`);
  return stale;
};

// ---------------------------------------------------------------------------
section('1. The field bug: a link that answers nothing until it is rebuilt');
{
  t.ok('signed in over the bunker, episode open', await openEpisode(bunkerSession()));
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  const mark = published.length;
  mode = 'deaf-until-connect';
  const t0 = await pressSend();

  const firstPay = await until(`window.__paid.length > 0`, 10000);
  const pays = await paid();
  t.ok('the wallet pays at once — the check does not hold the sats back', firstPay && pays[0].at - t0 < 3000,
    pays[0] ? `${pays[0].at - t0} ms` : 'no payment');

  const noteIn = await (async () => { for (let i = 0; i < 160; i += 1) { if (notesSince(mark).length) return true; await wait(250); } return false; })();
  t.ok('the note reaches the relay', noteIn);
  const log = seenSince(t0).map((s) => (s.kind ? `${s.method}:${s.kind}` : s.method));
  const firstSign = log.findIndex((m) => m.startsWith('sign_event'));
  const connectAt = log.indexOf('connect');
  t.ok('it asked the link first: a ping before anything else', log[0] === 'ping', log.join(' '));
  t.ok('the link was rebuilt BEFORE anything was signed', connectAt >= 0 && firstSign > connectAt, log.join(' '));
  t.equal('nothing was signed into the dead link', log.slice(0, connectAt).filter((m) => m.startsWith('sign_event')).length, 0);
  t.equal('exactly one note', notesSince(mark).length, 1);
  t.ok('the modal closes on its own once the note is out', await until(`!${DIALOG}`, 8000));
  t.equal('and no "Signer disconnected" was left behind', await accountMenuStale(), false);
}

// ---------------------------------------------------------------------------
section('2. A signer that never answers: nothing signed, the modal stays, RETRY NOTE posts it');
{
  t.ok('signed in over the bunker, episode open', await openEpisode(bunkerSession()));
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  const mark = published.length;
  mode = 'deaf';
  const t0 = await pressSend();
  t.ok('the wallet pays', await until(`window.__paid.length > 0`, 10000));
  // A 10 s ping, then the reconnect's own 90 s connect window.
  const failed = await until(`/note not posted/i.test(${DIALOG}?.innerText ?? '')`, 130000, 500);
  const text = await dialogText();
  t.ok('the modal is still open, and says the note was not posted', failed, text.slice(-300));
  t.ok('...and why: the signer did not answer', /did not answer/i.test(text), text.slice(-300));
  t.ok('...with RETRY NOTE', await js(`!!(${RETRY_NOTE})`));
  // On a phone, which is where Clave is: CDP device emulation, not a window
  // size (a window size crops a desktop layout and reads as overflow).
  for (const [width, height] of [[390, 844], [320, 640]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
    await wait(400);
    // `null` when the button or the dialog is gone — a FAIL below, not a crash.
    const m = JSON.parse((await js(`(() => {
      const b = ${RETRY_NOTE}; const d = ${DIALOG}; if (!b || !d) return 'null';
      const r = b.getBoundingClientRect(); const de = document.documentElement;
      return JSON.stringify({ page: de.scrollWidth - de.clientWidth, dialog: d.scrollWidth - d.clientWidth,
        w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= 0 && r.right <= innerWidth });
    })()`)) ?? 'null');
    t.ok(`${width}px: nothing overflows sideways`, !!m && m.page <= 0 && m.dialog <= 0, JSON.stringify(m));
    t.ok(`${width}px: RETRY NOTE is on screen and at least 24×24 (WCAG 2.5.8)`, !!m && m.inside && m.w >= 24 && m.h >= 24, JSON.stringify(m));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  t.equal('nothing was sent to the signer to sign', signsSince(t0).length, 0);
  t.equal('no note reached the relay', notesSince(mark).length, 0);

  // Every leg of the boost (this episode pays the episode and the show) has
  // settled by now; RETRY NOTE must add none.
  const legsPaid = (await paid()).length;
  // The signer comes back.
  mode = 'answer';
  await wait(1500);
  const t1 = Date.now();
  await js(`(${RETRY_NOTE}).click()`);
  const posted = await until(`/published to \\d+\\/\\d+ relays/i.test(${DIALOG}?.innerText ?? '')`, 60000, 500);
  t.ok('RETRY NOTE posts the note', posted, (await dialogText()).slice(-300));
  await wait(1000);
  t.equal('exactly one note', notesSince(mark).length, 1);
  t.equal('two signatures for it: the receipt request and the note', signsSince(t1).map((s) => s.kind).sort(), [1, 9734]);
  t.equal('RETRY NOTE paid nothing', (await paid()).length, legsPaid);
  t.equal('no RETRY NOTE once it is out', await js(`!!(${RETRY_NOTE})`), false);
}

// ---------------------------------------------------------------------------
section('3. Boost-all, the same dead link');
{
  t.ok('signed in over the bunker, episode open', await openEpisode(bunkerSession('window.__payMs = 200;')));
  await js(`window.__payMs = 200`);
  t.ok('boost-all opens', await openBoostAll());
  await typeAmount('100');
  const mark = published.length;
  mode = 'deaf-until-connect';
  const t0 = await pressSend(BOOST_ALL);
  const noteIn = await (async () => { for (let i = 0; i < 240; i += 1) { if (notesSince(mark).length) return true; await wait(250); } return false; })();
  t.ok('the summary note reaches the relay', noteIn, await dialogText());
  const log = seenSince(t0).map((s) => (s.kind ? `${s.method}:${s.kind}` : s.method));
  const firstSign = log.findIndex((m) => m.startsWith('sign_event'));
  t.ok('the link was rebuilt BEFORE anything was signed', log.indexOf('connect') >= 0 && firstSign > log.indexOf('connect'), log.join(' '));
  t.equal('exactly one note', notesSince(mark).length, 1);
  t.ok('every track was paid', (await paid()).length > 1, `${(await paid()).length} keysends`);
}

// ---------------------------------------------------------------------------
section('4. Must still work: a healthy link costs one ping');
{
  t.ok('signed in over the bunker, episode open', await openEpisode(bunkerSession()));
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  const mark = published.length;
  const t0 = await pressSend();
  const noteIn = await (async () => { for (let i = 0; i < 80; i += 1) { if (notesSince(mark).length) return true; await wait(250); } return false; })();
  t.ok('the note reaches the relay', noteIn);
  const log = seenSince(t0).map((s) => (s.kind ? `${s.method}:${s.kind}` : s.method));
  t.equal('one ping', log.filter((m) => m === 'ping').length, 1);
  t.equal('no reconnect', log.includes('connect'), false);
  t.equal('two signatures: the receipt request, then the note',
    log.filter((m) => m.startsWith('sign_event')), ['sign_event:9734', 'sign_event:1']);
  t.ok('the ping came before them', log.indexOf('ping') < log.indexOf('sign_event:9734'), log.join(' '));
  t.ok('the modal closes on its own', await until(`!${DIALOG}`, 8000));
}

// ---------------------------------------------------------------------------
section('5. Must still work: an extension signer is never probed');
{
  const convo = nip44.v2.utils.getConversationKey(sk, pk);
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
    await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
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
  t.ok('signed in with the extension, episode open', await openEpisode(`localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify(RELAYS))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'nip07');
    ${SAME_RAIL}`));
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  const mark = published.length;
  const t0 = await pressSend();
  const noteIn = await (async () => { for (let i = 0; i < 80; i += 1) { if (notesSince(mark).length) return true; await wait(250); } return false; })();
  t.ok('the note reaches the relay', noteIn);
  t.equal('no NIP-46 request at all', seenSince(t0).length, 0);
  t.ok('the modal closes on its own', await until(`!${DIALOG}`, 8000));
}

// ---------------------------------------------------------------------------
section('Page health');
t.equal('no page exceptions', exceptions, []);

relayWs.close();
console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
