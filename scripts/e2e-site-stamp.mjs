// End-to-end for THE NOTE STAMP: `/api/nostr/site-sign` signs a boost note under
// the site's verified name only when a 1-sat invoice the site minted for EXACTLY
// that event was paid, and every boost that cannot get the stamp still posts its
// note — from a one-time key. Reasoning: docs/security.md and
// docs/money-boosts.md, "the site-sign stamp".
//
// Usage (a THROWAWAY site key — never run this against the real SITE_NOSTR_SK):
//   export E2E_SITE_SK=$(node -e "import('nostr-tools').then(m=>console.log(Buffer.from(m.generateSecretKey()).toString('hex')))")
//   npm run build
//   SITE_NOSTR_SK=$E2E_SITE_SK LNBITS_URL=http://127.0.0.1:3418 LNBITS_INVOICE_KEY=e2e-key \
//     SITE_SIGN_REQUIRE_STAMP=on npx next start -p 3417 -H 127.0.0.1
//   APP_URL=http://127.0.0.1:3417 E2E_SITE_SK=$E2E_SITE_SK E2E_REQUIRE_STAMP=on npm run e2e:sitestamp
// Phase 1 (the switch off): start the server WITHOUT SITE_SIGN_REQUIRE_STAMP and run
//   E2E_REQUIRE_STAMP= ONLY=1 npm run e2e:sitestamp
// `ONLY=1,3` runs those sections alone; `--headed` to watch, `--keep` to leave it open.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but this one
// (`--host-resolver-rules`); the LNbits wallet is `fake-lnbits.mjs`, started by
// this script on port 3418, which is why the server's LNBITS_URL names it; the
// site key is the throwaway above, and the first signature proves the server
// holds it.
//
// What it pins:
//   1. The routes, called with `fetch` from inside the page: a bare template is
//      refused with the switch on and signed with it off; an unpaid stamp is
//      402; a paid stamp signs exactly its own event, as often as asked; a
//      changed note, a flipped MAC and a refused template are 400; an LNbits that
//      fails or hangs is a 502 inside the route's own timeout.
//   2. Signed out, WebLN: one stamp, paid AFTER every leg; the note is the site's.
//   3–6. The wallet refuses / LNbits cannot mint / the invoice is not 1 sat / the
//      LNbits lookup hangs: the note still posts, from a one-time key, and the
//      modal stays open and says why — never that the sat stayed.
//   7. × pressed while the stamp is being paid: one note, one stamp, and a
//      second modal opened at once is not closed when the first note lands.
//   8. BOOST ALL, signed out: one stamp for the summary note.
//   9. Signed in, Anonymous: the site's note; the user's signer signs no kind:1;
//      under the Buddy domain the Anonymous line takes no more lines than
//      "My feed"'s, at 390 px and at 1280 px.
//  10. NWC: the stamp goes out as `pay_invoice` through a stub NIP-47 wallet.
//  11. "Don't post" and "My feed": no stamp is ever asked for.
//  12. Every relay refuses the note: RETRY NOTE posts it; still one stamp.
//
// The page talks to the public relays through a WebSocket stand-in installed
// before any script runs: it answers the four DEFAULT_RELAYS with OK/EOSE and
// records each event. Every section asserts the note WAS recorded, so a stand-in
// that intercepted nothing fails rather than passing quietly.
//
// The SERVER still reads Podcast Index and the feeds for Two For Tunestr's
// "Open Range" (every payee a node, so the WebLN stand-in can pay it), and in
// section 8 it asks the LNURL servers of BOOST ALL's lnaddress payees for
// invoices the stand-in refuses — none is paid. Back to back runs can draw a
// Podcast Index 429; wait a few minutes.

import { finalizeEvent, generateSecretKey, getPublicKey, nip04, nip19, nip44, verifyEvent } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createFakeLnbits } from './fake-lnbits.mjs';
import { createRelay } from './local-relay.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3417';
const SITE_SK_HEX = process.env.E2E_SITE_SK ?? '';
const REQUIRE_STAMP = process.env.E2E_REQUIRE_STAMP === 'on';
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const runs = (n) => ONLY.length === 0 || ONLY.includes(String(n));
const LNBITS_PORT = 3418;
const LNBITS_KEY = 'e2e-key';

if (!/^[0-9a-f]{64}$/.test(SITE_SK_HEX)) {
  console.error('E2E_SITE_SK must be the 64-hex throwaway key the server was started with (see the header).');
  process.exit(2);
}
const siteSk = Uint8Array.from(Buffer.from(SITE_SK_HEX, 'hex'));
const sitePk = getPublicKey(siteSk);

const lnbits = createFakeLnbits({ port: LNBITS_PORT, key: LNBITS_KEY });
await lnbits.ready;
await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start it as the header says.`);

const t = checker();
const section = (s) => console.log(`\n--- ${s} ---`);

const { page } = await launchChrome({
  name: 'site-stamp',
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

// ---- the page's world: relays, a wallet, a signer ---------------------------
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.fountain.fm'];
const userSk = generateSecretKey();
const userPk = getPublicKey(userSk);
const userNpub = nip19.npubEncode(userPk);
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range — node payees
const EPISODE = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
// Every leg is this one node, paid by the WebLN stand-in (or the NWC stub).
const PAYEE = `02${getPublicKey(generateSecretKey())}`;
const ITEM_VALUE = {
  read: true,
  value: { type: 'lightning', method: 'keysend', suggested: '0.00000005000', recipients: [{ name: 'e2e payee', type: 'node', address: PAYEE, split: 100 }] },
  valueTimeSplits: [],
};

const stampAsks = []; // every POST the page sends to /api/nostr/site-stamp
const stampPays = []; // every invoice the WebLN stand-in was asked to pay
const signerKinds = []; // every kind the user's NIP-07 signer was asked to sign
let payMode = 'ok'; // 'ok' | 'refuse' | 'slow'

await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/item-value*', requestStage: 'Request' },
  { urlPattern: '*/api/nostr/site-stamp*', requestStage: 'Request' },
] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  if (request.url.includes('/api/nostr/site-stamp')) {
    if (request.method === 'POST') stampAsks.push(Date.now());
    await send('Fetch.continueRequest', { requestId }).catch(() => {});
    return;
  }
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(ITEM_VALUE)).toString('base64'),
  }).catch(() => {});
});

// The stamp payment, answered from here so the fake LNbits learns it was paid.
await send('Runtime.addBinding', { name: 'bmbPay' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbPay') return;
  const { rid, invoice } = JSON.parse(m.params.payload);
  let err = null;
  // Only a stamp is paid here. A BOOST ALL lnaddress leg's LNURL invoice is
  // refused, as a keysend-only wallet would, and is not counted.
  const isStamp = lnbits.minted.some((x) => x.bolt11 === invoice);
  if (isStamp) stampPays.push(invoice);
  if (!isStamp) err = 'e2e: keysend only';
  else if (payMode === 'refuse') err = 'e2e: the user rejected the payment';
  else {
    if (payMode === 'slow') await wait(3000);
    if (!lnbits.markPaid(invoice)) err = 'e2e: an invoice the fake never minted';
  }
  await js(`window.__bmbPayResolve(${JSON.stringify(rid)}, ${JSON.stringify(err)})`);
});

// An extension signer (NIP-07) backed by the throwaway user key.
const convo = nip44.v2.utils.getConversationKey(userSk, userPk);
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = userPk;
    else if (fn === 'signEvent') { signerKinds.push(args[0]?.kind); out = finalizeEvent(args[0], userSk); }
    else if (fn === 'nip44.encrypt') out = nip44.v2.encrypt(args[1], convo);
    else if (fn === 'nip44.decrypt') out = nip44.v2.decrypt(args[1], convo);
    else if (fn === 'nip04.encrypt') out = await nip04.encrypt(userSk, args[0], args[1]);
    else if (fn === 'nip04.decrypt') out = await nip04.decrypt(userSk, args[0], args[1]);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
});

await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    // The public relays, answered in the page: OK for an EVENT, EOSE for a REQ.
    const STAND_IN = new Set(${JSON.stringify(DEFAULT_RELAYS)});
    const Real = window.WebSocket;
    window.__published = [];
    class StandIn extends EventTarget {
      constructor(url) {
        super();
        this.url = url; this.readyState = 0; this.protocol = ''; this.extensions = '';
        this.bufferedAmount = 0; this.binaryType = 'blob';
        setTimeout(() => this._emit(new Event('open'), 'onopen', 1), 5);
      }
      _emit(ev, handler, state) {
        if (state !== undefined) this.readyState = state;
        try { this[handler]?.(ev); } finally { this.dispatchEvent(ev); }
      }
      _reply(arr) {
        setTimeout(() => { if (this.readyState === 1) this._emit(new MessageEvent('message', { data: JSON.stringify(arr) }), 'onmessage'); }, 5);
      }
      send(data) {
        let m; try { m = JSON.parse(data); } catch { return; }
        // __relaysDown: every relay refuses, as on a phone between networks.
        if (m[0] === 'EVENT' && window.__relaysDown) this._reply(['OK', m[1].id, false, 'e2e: relay down']);
        else if (m[0] === 'EVENT') { window.__published.push({ url: this.url, event: m[1] }); this._reply(['OK', m[1].id, true, '']); }
        else if (m[0] === 'REQ') this._reply(['EOSE', m[1]]);
      }
      close() { if (this.readyState < 2) this._emit(new CloseEvent('close', { code: 1000 }), 'onclose', 3); }
    }
    function WS(url, protocols) {
      return STAND_IN.has(String(url).replace(/\\/+$/, '')) ? new StandIn(String(url)) : new Real(url, protocols);
    }
    Object.assign(WS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    WS.prototype = Real.prototype;
    window.WebSocket = WS;

    // A WebLN wallet: keysends pay at once; an invoice (the stamp) is answered by the test.
    window.__paid = [];
    const waiting = new Map(); let n = 0;
    window.__bmbPayResolve = (rid, err) => { const p = waiting.get(rid); waiting.delete(rid); err ? p.reject(new Error(err)) : p.resolve({ preimage: '00'.repeat(32) }); };
    window.webln = {
      enable: async () => {},
      isEnabled: async () => true,
      getInfo: async () => ({ node: { alias: 'e2e' }, methods: ['getInfo', 'getBalance', 'keysend', 'sendPayment'] }),
      getBalance: async () => ({ balance: 1000000 }),
      keysend: async (a) => { window.__paid.push({ kind: 'keysend', at: Date.now(), amount: a.amount }); await new Promise((r) => setTimeout(r, 200)); return { preimage: '00'.repeat(32) }; },
      sendPayment: (invoice) => {
        window.__paid.push({ kind: 'invoice', at: Date.now(), invoice });
        return new Promise((resolve, reject) => { const rid = 'p' + (++n); waiting.set(rid, { resolve, reject }); window.bmbPay(JSON.stringify({ rid, invoice })); });
      },
      makeInvoice: async () => { throw new Error('e2e: no makeInvoice'); },
    };

    // NIP-07 over the CDP binding.
    const pending = new Map(); let k = 0;
    window.__bmbResolve = (rid, r) => { const p = pending.get(rid); pending.delete(rid); r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
    const call = (fn, ...args) => new Promise((resolve, reject) => { const rid = 'r' + (++k); pending.set(rid, { resolve, reject }); window.bmbSigner(JSON.stringify({ rid, fn, args })); });
    window.nostr = {
      getPublicKey: () => call('getPublicKey'),
      signEvent: (e) => call('signEvent', e),
      nip44: { encrypt: (p, t) => call('nip44.encrypt', p, t), decrypt: (p, c) => call('nip44.decrypt', p, c) },
      nip04: { encrypt: (p, t) => call('nip04.encrypt', p, t), decrypt: (p, c) => call('nip04.decrypt', p, c) },
    };
  })();
` });

// ---- helpers ----------------------------------------------------------------
const nowSecs = () => Math.floor(Date.now() / 1000);
/** The smallest template the validator takes: the prefix and the two `t` markers. */
const template = (content = '⚡ Boost ⚡\n\ne2e: a note stamp test') => ({
  kind: 1,
  created_at: nowSecs(),
  tags: [['t', 'boostagram'], ['t', 'value4value'], ['client', 'e2e']],
  content,
});
/** POST from INSIDE the page, so the browser's own fetch is what is refused. */
const post = (path, body) => js(`fetch(${JSON.stringify(path)}, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: ${JSON.stringify(JSON.stringify(body))},
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
const claimsOf = (stamp) => JSON.parse(Buffer.from(String(stamp).split('.')[0], 'base64url').toString());
const flipLast = (s) => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');

await send('Page.navigate', { url: `${APP}/privacy` });
await page.until('document.readyState === "complete"', 20000);

// =============================================================================
if (runs(1)) {
  section('1. the routes refuse what is not paid');
  lnbits.reset();

  const bare = await post('/api/nostr/site-sign', template());
  if (REQUIRE_STAMP) {
    t.equal('a bare template, switch on → 402', [bare?.status, bare?.body?.error], [402, 'a note stamp is required']);
  } else {
    t.equal('a bare template, switch off → 200 (phase 1)', bare?.status, 200);
    t.equal('...signed by the throwaway site key', bare?.body?.event?.pubkey, sitePk);
  }

  if (!ONLY.length || REQUIRE_STAMP) {
    const before = lnbits.minted.length;
    const note = template();
    const minted = await post('/api/nostr/site-stamp', { template: note });
    t.equal('site-stamp answers 200', minted?.status, 200);
    t.equal('...and minted one invoice', lnbits.minted.length - before, 1);
    const inv = lnbits.minted.at(-1);
    t.ok('...for 1 sat (1000 msat)', inv?.amount === 1000, JSON.stringify(inv));
    t.ok('...with the brand\'s stamp memo', / note stamp$/.test(inv?.memo ?? ''), inv?.memo);
    t.equal('...expiring in 600 s', inv?.expiry, 600);
    t.equal('...and handed back that invoice', minted?.body?.invoice, inv?.bolt11);
    const stamp = minted?.body?.stamp;
    const claims = stamp ? claimsOf(stamp) : {};
    t.equal('the token names the invoice\'s payment hash', claims.ph, inv?.hash);

    const unpaid = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('an unpaid stamp → 402 not paid', [unpaid?.status, unpaid?.body?.error], [402, 'the note stamp is not paid']);

    t.ok('the page pays it (fake LNbits)', lnbits.markPaid(inv?.bolt11));
    const signed = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('a paid stamp → 200', signed?.status, 200);
    if (signed?.body?.event?.pubkey && signed.body.event.pubkey !== sitePk) {
      t.fail('THE SERVER IS NOT RUNNING UNDER E2E_SITE_SK — stop and restart it as the header says');
      await lnbits.close();
      await exit(1);
    }
    t.equal('...signed by the site key', signed?.body?.event?.pubkey, sitePk);
    t.equal('...as exactly the event the stamp was minted for', signed?.body?.event?.id, claims.id);

    const again = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('asked again (RETRY NOTE): the same event id', again?.body?.event?.id, claims.id);
    t.equal('...and no new invoice', lnbits.minted.length - before, 1);

    const changed = await post('/api/nostr/site-sign', { template: { ...note, content: `${note.content}!` }, stamp });
    t.equal('the paid stamp on a changed note → 400', [changed?.status, changed?.body?.error], [400, 'the note stamp is for a different note']);

    const forged = await post('/api/nostr/site-sign', { template: note, stamp: flipLast(stamp ?? 'x.y') });
    t.equal('a flipped MAC character → 400', [forged?.status, forged?.body?.error], [400, 'the note stamp is not valid']);

    const otherKey = generateSecretKey();
    const stranger = finalizeEvent(template(), otherKey);
    const smuggled = await post('/api/nostr/site-sign', { template: note, stamp: `${Buffer.from(JSON.stringify({ v: 1, id: stranger.id, ph: inv?.hash, exp: nowSecs() + 60 })).toString('base64url')}.${stamp?.split('.')[1]}` });
    t.equal('another payload under the paid MAC → 400', [smuggled?.status, smuggled?.body?.error], [400, 'the note stamp is not valid']);

    const mintedBefore = lnbits.minted.length;
    const refused = await post('/api/nostr/site-stamp', { template: template('not a boost note') });
    t.equal('a template the validator refuses → 400 from site-stamp', [refused?.status, refused?.body?.error], [400, 'not a boost note']);
    t.equal('...and no invoice was minted for it', lnbits.minted.length, mintedBefore);

    lnbits.mode.mint = 'fail';
    const mintFail = await post('/api/nostr/site-stamp', { template: template() });
    t.equal('LNbits refuses to mint → 502', [mintFail?.status, mintFail?.body?.error], [502, 'could not create the stamp invoice']);
    lnbits.reset();

    const second = template('⚡ Boost ⚡\n\ne2e: the lookup hangs');
    const m2 = await post('/api/nostr/site-stamp', { template: second });
    lnbits.markPaid(m2?.body?.invoice);
    lnbits.mode.lookup = 'hang';
    const started = Date.now();
    const hang = await post('/api/nostr/site-sign', { template: second, stamp: m2?.body?.stamp });
    const took = Date.now() - started;
    t.equal('LNbits never answers the lookup → 502', [hang?.status, hang?.body?.error], [502, 'could not confirm the stamp']);
    t.ok(`...inside 10 s (took ${took} ms)`, took < 10_000);
    lnbits.reset();
  }
}

// ---- the boost modal ---------------------------------------------------------
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const buttonIn = (re) => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()))`;
const SEND = buttonIn(/^send \d+ sats?$/i);
const BOOST_ALL = buttonIn(/^boost \d+ tracks?$/i);
const CLOSE = `${DIALOG}?.querySelector('button[aria-label="Close"]')`;
const BOOST_EPISODE = `document.querySelector('button[aria-label="Boost this episode"]')`;
const dialogText = async () => String(await js(`${DIALOG}?.innerText ?? ''`));
const ONE_TIME = 'Posted from a one-time key';

/** A fresh store for one section: who is signed in, what is shared, which rail. */
function sessionScript({ signedIn = false, share = true, shareAs = 'self', rail = 'webln', nwcUri = null } = {}) {
  return `localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify(DEFAULT_RELAYS))});
    localStorage.setItem('bmb:rail_pref', ${JSON.stringify(rail)});
    localStorage.setItem('bmb:share_nostr', ${JSON.stringify(share ? '1' : '0')});
    ${shareAs === 'site' ? `localStorage.setItem('bmb:share_nostr_as', 'site');` : ''}
    ${nwcUri ? `localStorage.setItem('bmb:nwc_uri', ${JSON.stringify(nwcUri)});` : ''}
    ${signedIn ? `localStorage.setItem('bmb:npub', ${JSON.stringify(userNpub)}); localStorage.setItem('bmb:signer', 'nip07');` : ''}`;
}
async function openEpisode(opts = {}) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"', 20000);
  await js(`(() => { ${sessionScript(opts)} return 1; })()`);
  await send('Page.navigate', { url: EPISODE });
  await until('document.readyState === "complete"', 20000);
  const ok = await until(`!!${BOOST_EPISODE}`, 60000);
  await wait(800);
  // The stand-ins load before any page script; without them every later
  // check would fail for a reason that has nothing to do with the stamp.
  return !!ok && (await js(`Array.isArray(window.__published) && !!window.webln && !!window.nostr`)) === true;
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
async function pressSend(button = SEND) {
  if (!(await until(`!!(${button}) && !(${button}).disabled`, 20000))) return false;
  await js(`(${button}).click()`);
  return true;
}
/** Every boost note the page published, once each (it goes to four relays). */
const notes = async () => {
  const all = (await js(`window.__published.map((p) => p.event)`)) ?? [];
  return [...new Map(all.filter((e) => e.kind === 1 && String(e.content).startsWith('⚡ Boost ⚡')).map((e) => [e.id, e])).values()];
};
async function noteAfter(ms = 30000) {
  for (let i = 0; i < ms / 250; i += 1) {
    const n = await notes();
    if (n.length) return n[0];
    await wait(250);
  }
  return null;
}
const paidLog = async () => (await js('window.__paid')) ?? [];
const mark = () => ({ asks: stampAsks.length, pays: stampPays.length, minted: lnbits.minted.length });
const since = (m) => ({ asks: stampAsks.length - m.asks, pays: stampPays.length - m.pays, minted: lnbits.minted.length - m.minted });
const failText = (why) => `${ONE_TIME}, not Boost Me Bitch: ${why}.`;
const signerIsOneTime = (e) => !!e && e.pubkey !== sitePk && e.pubkey !== userPk && verifyEvent(e);

/** One signed-out boost of the episode whose stamp fails some way; the note must still post. */
async function oneTimeCase(label, setup, why, extra = async () => {}) {
  lnbits.reset();
  payMode = 'ok';
  t.ok(`${label}: the episode page opens`, await openEpisode());
  t.ok('...the boost modal opens', await openBoost());
  await typeAmount('100');
  const m = mark();
  setup();
  t.ok('...SEND is pressed', await pressSend());
  const started = Date.now();
  const note = await noteAfter(40000);
  t.ok('...the note still reaches the relays', !!note, note ? '' : await dialogText());
  t.ok('...signed by a one-time key (neither the site nor the user)', signerIsOneTime(note), note?.pubkey);
  t.ok(`...within 30 s (took ${Date.now() - started} ms)`, Date.now() - started < 30000);
  t.ok(`...and the modal says "${failText(why)}"`, (await until(`(${DIALOG}?.innerText ?? '').includes(${JSON.stringify(failText(why))})`, 5000)) === true, await dialogText());
  await wait(2500);
  t.ok('...and stays open to say it', !!(await js(`!!${DIALOG}`)));
  t.ok('...over legs that paid (✓)', (await dialogText()).includes('✓'), await dialogText());
  await extra(m);
  payMode = 'ok';
  lnbits.reset();
}

// =============================================================================
if (runs(2)) {
  section('2. signed out, WebLN: one stamp, paid after every leg; the site signs');
  lnbits.reset();
  t.ok('the episode page opens', await openEpisode());
  t.ok('the boost modal opens', await openBoost());
  t.ok('the signed-out share line names the 1 sat', (await until(`/1 sat/.test(${DIALOG}?.innerText ?? '')`, 20000)) === true, await dialogText());
  await typeAmount('100');
  const m = mark();
  t.ok('SEND is pressed', await pressSend());
  const note = await noteAfter(30000);
  t.ok('the note reaches the relays', !!note, note ? '' : await dialogText());
  t.equal('...signed by the site key', note?.pubkey, sitePk);
  t.equal('one stamp asked, minted and paid', since(m), { asks: 1, pays: 1, minted: 1 });
  const paid = await paidLog();
  const lastLeg = Math.max(...paid.filter((p) => p.kind === 'keysend').map((p) => p.at));
  const stampAt = paid.find((p) => p.kind === 'invoice')?.at ?? 0;
  t.ok('...paid AFTER every leg', paid.some((p) => p.kind === 'keysend') && stampAt > lastLeg, JSON.stringify(paid));
  t.ok('no one-time notice', !(await dialogText()).includes(ONE_TIME));
  t.ok('the modal closes on its own', !!(await until(`!${DIALOG}`, 8000)));
}

if (runs(3)) {
  section('3. the wallet refuses the stamp');
  await oneTimeCase('wallet refuses', () => { payMode = 'refuse'; }, 'your wallet did not confirm the 1-sat stamp',
    async (m) => t.equal('...the wallet was asked once', since(m).pays, 1));
}

if (runs(4)) {
  section('4. LNbits cannot mint the stamp invoice');
  await oneTimeCase('mint fails', () => { lnbits.mode.mint = 'fail'; }, 'the site could not make the stamp invoice',
    async (m) => t.equal('...the wallet was never asked', since(m).pays, 0));
}

if (runs(5)) {
  section('5. the stamp invoice is not for 1 sat');
  await oneTimeCase('overcharge', () => { lnbits.mode.mint = 'overcharge'; }, 'your wallet did not confirm the 1-sat stamp',
    async (m) => t.equal('...the wallet was never asked', since(m).pays, 0));
}

if (runs(6)) {
  section('6. the LNbits lookup hangs');
  await oneTimeCase('lookup hangs', () => { lnbits.mode.lookup = 'hang'; }, 'the site could not confirm the 1-sat stamp',
    async (m) => t.equal('...the stamp was paid once', since(m).pays, 1));
}

if (runs(7)) {
  section('7. × while the stamp is being paid: one note, one stamp');
  lnbits.reset();
  t.ok('the episode page opens', await openEpisode());
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  const m = mark();
  payMode = 'slow';
  t.ok('SEND is pressed', await pressSend());
  const paying = await until(`(${DIALOG}?.innerText ?? '').includes('Paying the 1-sat stamp')`, 30000);
  t.ok('the modal says "Paying the 1-sat stamp…"', paying === true, await dialogText());
  await js(`${CLOSE}?.click()`);
  t.ok('× closes the modal', !!(await until(`!${DIALOG}`, 5000)));
  // A second boost opened at once must not be closed by the first one's
  // deferred close when that first note lands.
  t.ok('a second boost modal opens', await openBoost());
  await wait(10000);
  t.ok('...and is still open after the first note posts', !!(await js(`!!(${FIELD})`)));
  await js(`${CLOSE}?.click()`);
  await until(`!${DIALOG}`, 5000);
  const all = await notes();
  t.equal('exactly one note reached the relays', all.length, 1);
  t.equal('...signed by the site key', all[0]?.pubkey, sitePk);
  t.equal('exactly one stamp paid', since(m).pays, 1);
  payMode = 'ok';
  lnbits.reset();
}

if (runs(8)) {
  section('8. BOOST ALL, signed out: one stamp for the summary note');
  lnbits.reset();
  t.ok('the episode page opens', await openEpisode());
  await js(`document.querySelector('button[aria-label="More actions"]')?.click()`);
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => /boost all \\d+ tracks/i.test(b.textContent))`, 10000);
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => /boost all \\d+ tracks/i.test(b.textContent))?.click()`);
  t.ok('the boost-all modal opens', !!(await until(`!!(${FIELD})`, 20000)));
  // The share line renders once the tracks resolve, not with the modal.
  t.ok('...and its share line names the 1 sat', (await until(`/1 sat/.test(${DIALOG}?.innerText ?? '')`, 30000)) === true, await dialogText());
  await typeAmount('100');
  const m = mark();
  t.ok('BOOST ALL is pressed', await pressSend(BOOST_ALL));
  const note = await noteAfter(90000);
  t.ok('the summary note reaches the relays', !!note, note ? '' : await dialogText());
  t.equal('...signed by the site key', note?.pubkey, sitePk);
  t.equal('one stamp asked, minted and paid', since(m), { asks: 1, pays: 1, minted: 1 });
}

if (runs(9)) {
  section('9. signed in, Anonymous: the site signs; the user signs no kind:1');
  lnbits.reset();
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  t.ok('the episode page opens (390 × 844)', await openEpisode({ signedIn: true, shareAs: 'site' }));
  await until(`!!window.nostr`, 20000);
  t.ok('the boost modal opens', await openBoost());
  // The Anonymous line may never take MORE lines than "My feed"'s, so flipping
  // the choice does not move the modal. Measured with the Buddy domain, which
  // sets wider, at a phone width and a desktop width.
  const MY_FEED = 'A public note posted to your feed, signed with your key.';
  const measure = () => js(`(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Anonymous');
    const card = btn?.closest('.card');
    const desc = card?.lastElementChild;
    if (!desc) return null;
    const lines = (text) => {
      const c = desc.cloneNode(true);
      c.textContent = text;
      desc.parentElement.appendChild(c);
      const r = document.createRange(); r.selectNodeContents(c);
      const n = r.getClientRects().length;
      c.remove();
      return n;
    };
    const buddyText = desc.textContent.replace('boostmebitch.com', 'boostmebuddy.com');
    return { pressed: btn.getAttribute('aria-pressed'), text: desc.textContent, buddyText, buddy: lines(buddyText), myFeed: lines(${JSON.stringify(MY_FEED)}) };
  })()`);
  const phone = await measure();
  t.equal('Anonymous is the selected choice', phone?.pressed, 'true');
  t.ok('...its line names "1 sat plus a small network fee"', /1 sat plus a small network fee/.test(phone?.text ?? ''), phone?.text);
  t.ok(`...under Buddy, no more lines than "My feed" at 390 px (${phone?.buddy} vs ${phone?.myFeed})`, !!phone && phone.buddy <= phone.myFeed, phone?.buddyText);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(500);
  const desk = await measure();
  t.ok(`...and at 1280 px (${desk?.buddy} vs ${desk?.myFeed})`, !!desk && desk.buddy <= desk.myFeed, desk?.buddyText);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await wait(500);
  await typeAmount('100');
  const m = mark();
  const kindsBefore = signerKinds.length;
  t.ok('SEND is pressed', await pressSend());
  const note = await noteAfter(30000);
  t.ok('the note reaches the relays', !!note, note ? '' : await dialogText());
  t.equal('...signed by the site key', note?.pubkey, sitePk);
  t.equal('one stamp asked and paid', [since(m).asks, since(m).pays], [1, 1]);
  t.ok('the user\'s signer signed no kind:1', !signerKinds.slice(kindsBefore).includes(1), JSON.stringify(signerKinds.slice(kindsBefore)));
  await send('Emulation.clearDeviceMetricsOverride');
}

if (runs(10)) {
  section('10. NWC: the stamp goes out as pay_invoice');
  lnbits.reset();
  const relay = createRelay({ port: 0, log: null });
  const relayPort = await relay.ready;
  const walletSk = generateSecretKey();
  const walletPub = getPublicKey(walletSk);
  const clientSk = generateSecretKey();
  const clientPub = getPublicKey(clientSk);
  const conversation = nip44.getConversationKey(walletSk, clientPub);
  const requests = [];
  const METHODS = ['get_info', 'get_balance', 'pay_keysend', 'pay_invoice'];
  const walletWs = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  const signAndSend = (tmpl) => walletWs.send(JSON.stringify(['EVENT', finalizeEvent({ created_at: nowSecs(), ...tmpl }, walletSk)]));
  walletWs.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m[0] !== 'EVENT' || m[1] !== 'wallet') return;
    const e = m[2];
    const { method, params } = JSON.parse(nip44.decrypt(e.content, conversation));
    requests.push(method);
    let result = null;
    if (method === 'get_info') result = { methods: METHODS, alias: 'stub', pubkey: walletPub, network: 'mainnet', block_height: 1, block_hash: '00', color: '#000000' };
    else if (method === 'get_balance') result = { balance: 1_000_000 * 1000 };
    else if (method === 'pay_keysend') result = { preimage: 'ab'.repeat(32) };
    else if (method === 'pay_invoice') { stampPays.push(params?.invoice); result = lnbits.markPaid(params?.invoice) ? { preimage: 'ab'.repeat(32) } : null; }
    const body = result
      ? { result_type: method, result }
      : { result_type: method, result: null, error: { code: 'NOT_IMPLEMENTED', message: `${method} is not stubbed` } };
    signAndSend({ kind: 23195, tags: [['p', clientPub], ['e', e.id]], content: nip44.encrypt(JSON.stringify(body), conversation) });
  };
  await new Promise((resolve, reject) => { walletWs.onopen = resolve; walletWs.onerror = reject; });
  walletWs.send(JSON.stringify(['REQ', 'wallet', { kinds: [23194], '#p': [walletPub] }]));
  signAndSend({ kind: 13194, tags: [['encryption', 'nip44_v2']], content: METHODS.join(' ') });
  const uri = `nostr+walletconnect://${walletPub}?relay=ws://127.0.0.1:${relayPort}&secret=${Buffer.from(clientSk).toString('hex')}`;

  t.ok('the episode page opens with an NWC wallet', await openEpisode({ rail: 'nwc', nwcUri: uri }));
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  const m = mark();
  t.ok('SEND is pressed', await pressSend());
  const note = await noteAfter(40000);
  t.ok('the note reaches the relays', !!note, note ? '' : await dialogText());
  t.equal('...signed by the site key', note?.pubkey, sitePk);
  t.ok('the legs went out as pay_keysend', requests.includes('pay_keysend'), JSON.stringify(requests));
  t.equal('the stub wallet saw exactly one pay_invoice', requests.filter((r) => r === 'pay_invoice').length, 1);
  t.equal('...for the minted stamp', [since(m).minted, since(m).pays], [1, 1]);
  t.equal('WebLN paid nothing', (await paidLog()).length, 0);
  walletWs.close();
  relay.close();
}

if (runs(11)) {
  section('11. "Don\'t post" and "My feed" never ask for a stamp');
  lnbits.reset();
  t.ok('signed in, Don\'t post: the episode page opens', await openEpisode({ signedIn: true, share: false }));
  await until(`!!window.nostr`, 20000);
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  let m = mark();
  t.ok('SEND is pressed', await pressSend());
  t.ok('the legs pay', !!(await until(`(window.__paid ?? []).length > 0`, 30000)));
  await wait(4000);
  t.equal('no stamp asked or minted', [since(m).asks, since(m).minted], [0, 0]);
  t.equal('no note posted', (await notes()).length, 0);

  t.ok('signed in, My feed: the episode page opens', await openEpisode({ signedIn: true, shareAs: 'self' }));
  await until(`!!window.nostr`, 20000);
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  m = mark();
  t.ok('SEND is pressed', await pressSend());
  const note = await noteAfter(30000);
  t.ok('the note reaches the relays', !!note, note ? '' : await dialogText());
  t.equal('...signed by the user\'s own key', note?.pubkey, userPk);
  t.equal('no stamp asked or minted', [since(m).asks, since(m).minted], [0, 0]);
}

if (runs(12)) {
  section('12. no relay takes the note: RETRY NOTE posts it, and pays no second stamp');
  lnbits.reset();
  t.ok('the episode page opens', await openEpisode());
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  const m = mark();
  await js('window.__relaysDown = true');
  t.ok('SEND is pressed (every relay refuses)', await pressSend());
  const RETRY = buttonIn(/^retry note$/i);
  const offered = await until(`!!(${RETRY})`, 40000);
  t.ok('the modal offers RETRY NOTE', !!offered, await dialogText());
  t.ok('...and says the note was not posted', (await dialogText()).includes('Note not posted'), await dialogText());
  t.equal('nothing reached a relay', (await notes()).length, 0);
  t.equal('one stamp paid so far', since(m).pays, 1);
  await js('window.__relaysDown = false');
  await js(`(${RETRY})?.click()`);
  const note = await noteAfter(20000);
  t.ok('RETRY NOTE posts the note', !!note, note ? '' : await dialogText());
  t.equal('...signed by the site key', note?.pubkey, sitePk);
  t.equal('...with no second stamp asked, minted or paid', since(m), { asks: 1, pays: 1, minted: 1 });
}

// =============================================================================
t.equal('no uncaught exception in the page', exceptions, []);
console.log(`\n${t.count - t.fails}/${t.count} passed`);
await lnbits.close();
await wait(50);
await exit(t.fails ? 1 : 0);
