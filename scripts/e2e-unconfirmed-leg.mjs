// End-to-end for THE UNANSWERED LEG: in the single BOOST panel, on the NWC rail,
// a leg the wallet does not answer no longer holds the others, and a leg that
// comes back `?` is asked about by its payment hash (`lookup_invoice`) — RETRY
// only once the wallet says it failed, and then under that SAME hash.
// Reasoning: docs/money-boosts.md, "The unanswered wallet".
//
// Usage (a THROWAWAY site key: the summary receipt is site-signed):
//   export E2E_SITE_SK=$(node -e "import('nostr-tools').then(m=>console.log(Buffer.from(m.generateSecretKey()).toString('hex')))")
//   npm run build
//   SITE_NOSTR_SK=$E2E_SITE_SK npx next start -p 3417 -H 127.0.0.1
//   APP_URL=http://127.0.0.1:3417 npm run e2e:unconfirmed
// `ONLY=1,3` runs those sections alone; `--headed` to watch, `--keep` to leave it open.
//
// SLOW ON PURPOSE: the SDK waits 60 s for a payment's reply, and that 60 s is the
// thing under test. The whole run takes about seven minutes.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but this one
// (`--host-resolver-rules`). The wallet is a NIP-47 stub on a local relay; the
// four public relays are answered inside the page; the user is a throwaway key
// behind a NIP-07 stand-in; the LNURL payee of section 4 is answered by CDP
// interception; BoostBox is refused before it reaches our server.
//
// What it pins:
//   1. Five node payees, 100 sats. Four are never answered: each next leg starts
//      15 s after the one before, not 60 s. Then each `?` is asked about:
//      `settled` → ✓ with no second payment; `failed` → RETRY, which pays the
//      SAME preimage and TLV again; `pending` → asked again 15 s later → ✓;
//      NOT_FOUND → "may have paid under its own ID", CHECK AGAIN, never RETRY. One note. The
//      panel never closes while a leg is `?`. No preimage reaches storage. At
//      390 px the lines fit and every control is at least 24×24.
//   2. A wallet whose `get_info` lacks `lookup_invoice`: no lookup is sent, the
//      line says the wallet cannot look up payments, and nothing is paid again.
//   3. The page is FROZEN (as in the background) while a leg waits; the reply the
//      wallet sends meanwhile is lost. On wake the remaining leg is paid, the
//      waiting leg goes `?`, is asked about, and turns ✓; the note posts.
//   4. An LNURL leg: asked about by the payment hash in its BOLT11.
//   5. A RETRY while its payment moves: Escape does not close the panel. The
//      wallet then refuses it: the line says why, the leg stays `?` under the
//      same hash, and RETRY comes back only after the wallet says failed again.
//   6. A signer that does not answer (an iOS extension after the app was in the
//      background): STOP WAITING skips the note, a late signature publishes
//      nothing, and RETRY NOTE posts it later — one note, one receipt asked for.
//
// The SERVER still reads Podcast Index and the feeds for Two For Tunestr's
// "Open Range". Back to back runs can draw a Podcast Index 429; wait a few minutes.

import { finalizeEvent, generateSecretKey, getPublicKey, nip04, nip19, nip44 } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createRelay } from './local-relay.mjs';
import { fakeBolt11 } from './fake-bolt11.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3417';
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const runs = (n) => ONLY.length === 0 || ONLY.includes(String(n));

await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start it as the header says.`);

const t = checker();
const section = (s) => console.log(`\n--- ${s} ---`);
const nowSecs = () => Math.floor(Date.now() / 1000);
const hashOf = (preimageHex) => bytesToHex(sha256(hexToBytes(preimageHex)));

const { page } = await launchChrome({
  name: 'unconfirmed-leg',
  args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, js, until } = page;
const exceptions = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300));
  }
});
// DEBUG=1 prints the page's console, where the [keysend] / [lnurl] / [nwc] lines are.
page.on((m) => {
  if (process.env.DEBUG && m.method === 'Runtime.consoleAPICalled') {
    console.log(`  [page] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
  }
});
await send('Page.enable');
await send('Runtime.enable');

// ---- the page's world: relays, a signer, the value block ---------------------
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.fountain.fm'];
const userSk = generateSecretKey();
const userPk = getPublicKey(userSk);
const userNpub = nip19.npubEncode(userPk);
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range
const EPISODE = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
const node = () => `02${getPublicKey(generateSecretKey())}`;
const valueOf = (recipients) => ({
  read: true,
  value: { type: 'lightning', method: 'keysend', suggested: '0.00000005000', recipients },
  valueTimeSplits: [],
});
let itemValue = valueOf([]);

// The LNURL payee of section 4, answered here: the address, then an invoice for
// whatever amount the page asks, with a payment hash the test knows.
const LNURL_HOST = 'lnurl.e2e.invalid';
const lnurl = { hash: '', invoice: '', asked: 0 };

// Every section pays its OWN value block: the feed's answer is rewritten to
// carry it (the episode's `value` is what the panel pays), and the cache is off
// so a section never sees the block of the one before.
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/feed*', requestStage: 'Response' },
  { urlPattern: '*/api/item-value*', requestStage: 'Request' },
  { urlPattern: '*/api/lightning/boostbox*', requestStage: 'Request' },
  { urlPattern: '*/api/keysend*', requestStage: 'Request' },
  { urlPattern: `https://${LNURL_HOST}/*`, requestStage: 'Request' },
] });
const fulfill = (requestId, code, body) => send('Fetch.fulfillRequest', {
  requestId, responseCode: code,
  responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
  body: Buffer.from(JSON.stringify(body)).toString('base64'),
}).catch(() => {});
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const url = new URL(request.url);
  if (m.params.responseStatusCode !== undefined) {
    // /api/feed, at the response stage: put this section's block on the show and on every episode.
    const raw = await send('Fetch.getResponseBody', { requestId }).catch(() => null);
    let feed = null;
    try {
      const text = raw?.result?.base64Encoded ? Buffer.from(raw.result.body, 'base64').toString() : raw?.result?.body;
      feed = JSON.parse(text);
    } catch { /* not JSON: pass it on */ }
    if (!feed?.podcast || !Array.isArray(feed.episodes) || m.params.responseStatusCode !== 200) {
      return send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
    feed.podcast.value = itemValue.value;
    for (const ep of feed.episodes) { ep.value = itemValue.value; ep.valueTimeSplits = []; }
    return fulfill(requestId, 200, feed);
  }
  if (url.pathname.startsWith('/api/item-value')) return fulfill(requestId, 200, itemValue);
  // BoostBox would carry this test's metadata to a real service.
  if (url.pathname.startsWith('/api/lightning/boostbox')) return fulfill(requestId, 503, { error: 'e2e: no BoostBox' });
  // No keysend well-known: the LNURL payee stays an LNURL leg.
  if (url.pathname.startsWith('/api/keysend')) return fulfill(requestId, 404, { error: 'e2e: none' });
  if (url.host === LNURL_HOST && url.pathname === '/.well-known/lnurlp/leg') {
    return fulfill(requestId, 200, {
      status: 'OK', tag: 'payRequest', callback: `https://${LNURL_HOST}/cb`,
      minSendable: 1000, maxSendable: 1_000_000_000, metadata: JSON.stringify([['text/plain', 'e2e leg']]), commentAllowed: 255,
    });
  }
  if (url.host === LNURL_HOST && url.pathname === '/cb') {
    lnurl.asked += 1;
    const amountMsat = Number(url.searchParams.get('amount'));
    lnurl.hash = bytesToHex(sha256(new TextEncoder().encode(`e2e-${Date.now()}`)));
    lnurl.invoice = fakeBolt11({ amountMsat, fields: [{ tag: 's', hex: '22'.repeat(32) }, { tag: 'p', hex: lnurl.hash }, { tag: 'd', text: 'e2e leg' }] });
    return fulfill(requestId, 200, { status: 'OK', pr: lnurl.invoice, routes: [] });
  }
  return fulfill(requestId, 404, { status: 'ERROR', reason: 'e2e: not here' });
});

// An extension signer (NIP-07) backed by the throwaway user key.
const convo = nip44.v2.utils.getConversationKey(userSk, userPk);
// `heldSigns`, when an array, keeps every signEvent unanswered (section 6).
let heldSigns = null;
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  if (fn === 'signEvent' && heldSigns) { heldSigns.push({ rid, args }); return; }
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = userPk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], userSk);
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
        if (m[0] === 'EVENT') { window.__published.push({ url: this.url, event: m[1] }); this._reply(['OK', m[1].id, true, '']); }
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

    // Every summary-receipt request the page sends. The server here signs with
    // a THROWAWAY site key, which is not the brand's pinned npub the request
    // names, so the route answers 400 and no receipt is minted: count the asks.
    window.__receiptAsks = 0;
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input?.url ?? input).includes('/api/nostr/zap-receipt-sign')) window.__receiptAsks += 1;
      return realFetch(input, init);
    };

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

// ---- a NIP-47 wallet on a local relay -----------------------------------------
/**
 * `answer(req)` returns the reply body (`{ result }` or `{ error }`), or null to
 * never answer. `req` is `{ method, params, at, id, reply(body) }`: a test may
 * keep it and call `reply` later.
 */
async function stubWallet({ methods, answer }) {
  const relay = createRelay({ port: 0, log: null });
  const relayPort = await relay.ready;
  const walletSk = generateSecretKey();
  const walletPub = getPublicKey(walletSk);
  const clientSk = generateSecretKey();
  const clientPub = getPublicKey(clientSk);
  const conversation = nip44.getConversationKey(walletSk, clientPub);
  const requests = [];
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  const signAndSend = (tmpl) => ws.send(JSON.stringify(['EVENT', finalizeEvent({ created_at: nowSecs(), ...tmpl }, walletSk)]));
  const replyTo = (e, method, body) => signAndSend({
    kind: 23195, tags: [['p', clientPub], ['e', e.id]],
    content: nip44.encrypt(JSON.stringify({ result_type: method, result: null, ...body }), conversation),
  });
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m[0] !== 'EVENT' || m[1] !== 'wallet') return;
    const e = m[2];
    const { method, params } = JSON.parse(nip44.decrypt(e.content, conversation));
    const req = { method, params, at: Date.now(), id: e.id, reply: (body) => replyTo(e, method, body) };
    requests.push(req);
    let body;
    if (method === 'get_info') body = { result: { methods, alias: 'stub', pubkey: walletPub, network: 'mainnet', block_height: 1, block_hash: '00', color: '#000000' } };
    else if (method === 'get_balance') body = { result: { balance: 1_000_000 * 1000 } };
    else body = answer(req);
    if (body) req.reply(body);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify(['REQ', 'wallet', { kinds: [23194], '#p': [walletPub] }]));
  signAndSend({ kind: 13194, tags: [['encryption', 'nip44_v2']], content: methods.join(' ') });
  return {
    uri: `nostr+walletconnect://${walletPub}?relay=ws://127.0.0.1:${relayPort}&secret=${Buffer.from(clientSk).toString('hex')}`,
    requests,
    pays: (pubkey) => requests.filter((r) => r.method === 'pay_keysend' && r.params?.pubkey === pubkey),
    lookups: (hash) => requests.filter((r) => r.method === 'lookup_invoice' && r.params?.payment_hash === hash),
    close() { ws.close(); relay.close(); },
  };
}
const ALL_METHODS = ['get_info', 'get_balance', 'pay_keysend', 'pay_invoice', 'lookup_invoice'];
/** A `lookup_invoice` answer for an outgoing payment. A keysend has no invoice. */
const tx = (hash, extra) => ({ result: {
  type: 'outgoing', invoice: '', description: '', description_hash: '', payment_hash: hash,
  amount: 1000, fees_paid: 0, created_at: nowSecs() - 60, expires_at: null, ...extra,
} });

// ---- the boost modal ---------------------------------------------------------
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const buttonIn = (re) => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()))`;
const SEND = buttonIn(/^send \d+ sats?$/i);
const BOOST_EPISODE = `document.querySelector('button[aria-label="Boost this episode"]')`;
const dialogText = async () => String(await js(`${DIALOG}?.innerText ?? ''`));
const dialogOpen = async () => (await js(`!!${DIALOG}`)) === true;
/** The unconfirmed line of the payee named `name`: its state, or 'gone' once it left the list. */
const LINE = (name) => `[...document.querySelectorAll('[data-unconfirmed-legs] li')].find((li) => li.textContent.includes(${JSON.stringify(`${name} (`)}))`;
const lineState = async (name) => String(await js(`${LINE(name)}?.dataset.legState ?? 'gone'`));
const lineText = async (name) => String(await js(`${LINE(name)}?.innerText ?? ''`));
const untilLine = (name, state, ms) => until(`(${LINE(name)}?.dataset.legState ?? 'gone') === ${JSON.stringify(state)}`, ms);

function sessionScript(nwcUri) {
  return `localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify(DEFAULT_RELAYS))});
    localStorage.setItem('bmb:rail_pref', 'nwc');
    localStorage.setItem('bmb:share_nostr', '1');
    localStorage.setItem('bmb:nwc_uri', ${JSON.stringify(nwcUri)});
    localStorage.setItem('bmb:npub', ${JSON.stringify(userNpub)});
    localStorage.setItem('bmb:signer', 'nip07');`;
}
async function openBoost(nwcUri) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"', 20000);
  await js(`(() => { ${sessionScript(nwcUri)} return 1; })()`);
  await send('Page.navigate', { url: EPISODE });
  await until('document.readyState === "complete"', 20000);
  if (!(await until(`!!${BOOST_EPISODE}`, 60000))) return false;
  await wait(800);
  if ((await js(`Array.isArray(window.__published) && !!window.nostr`)) !== true) return false;
  await js(`${BOOST_EPISODE}?.click()`);
  if (!(await until(`!!(${FIELD})`, 20000))) return false;
  await js(`(() => { const f = ${FIELD}; f.blur(); f.focus(); f.select(); return 1; })()`);
  await wait(50);
  await send('Input.insertText', { text: '100' });
  await wait(300);
  return true;
}
async function pressSend() {
  if (!(await until(`!!(${SEND}) && !(${SEND}).disabled`, 30000))) return false;
  await js(`(${SEND}).click()`);
  return true;
}
const notes = async () => {
  const all = (await js(`window.__published.map((p) => p.event)`)) ?? [];
  return [...new Map(all.filter((e) => e.kind === 1 && String(e.content).startsWith('⚡ Boost ⚡')).map((e) => [e.id, e])).values()];
};
const answerSign = (h) => js(`window.__bmbResolve(${JSON.stringify(h.rid)}, ${JSON.stringify({ out: finalizeEvent(h.args[0], userSk), err: null })})`);
const sentCount = async () => /Lightning: (\d+)\/(\d+) sent/.exec(await dialogText())?.slice(1, 3).map(Number) ?? null;
const storedLegs = async () => JSON.parse(String(await js(`localStorage.getItem(${JSON.stringify(`bmb:boosts:${userNpub}`)}) ?? '[]'`)))[0]?.legs ?? [];

await send('Page.navigate', { url: `${APP}/privacy` });
await until('document.readyState === "complete"', 20000);

// =============================================================================
if (runs(1)) {
  section('1. four unanswered legs: move on, then ask the wallet about each');
  const P = { a: node(), b: node(), c: node(), d: node(), e: node() };
  itemValue = valueOf([
    { name: 'Alpha', type: 'node', address: P.a, split: 40 },
    { name: 'Bravo', type: 'node', address: P.b, split: 25 },
    { name: 'Charlie', type: 'node', address: P.c, split: 15 },
    { name: 'Delta', type: 'node', address: P.d, split: 10 },
    { name: 'Echo', type: 'node', address: P.e, split: 10 },
  ]);
  let charlieLookups = 0;
  const firstPay = (pubkey) => wallet.pays(pubkey)[0]?.params;
  const wallet = await stubWallet({
    methods: ALL_METHODS,
    answer: (req) => {
      const { method, params } = req;
      if (method === 'pay_keysend') {
        if (params.pubkey === P.e) return { result: { preimage: params.preimage } };
        // Bravo's second payment, from RETRY, is answered.
        if (params.pubkey === P.b && wallet.pays(P.b).length === 2) return { result: { preimage: params.preimage } };
        return null; // the other first payments: never answered
      }
      if (method === 'lookup_invoice') {
        const h = params.payment_hash;
        const of = (pk) => (firstPay(pk) ? hashOf(firstPay(pk).preimage) : '');
        // A wallet echoes the preimage on every state: the app must not read it as proof.
        if (h === of(P.a)) return tx(h, { state: 'settled', preimage: firstPay(P.a).preimage, settled_at: nowSecs() });
        if (h === of(P.b)) return tx(h, { state: 'failed', preimage: firstPay(P.b).preimage });
        if (h === of(P.c)) {
          charlieLookups += 1;
          return charlieLookups === 1
            ? tx(h, { state: 'pending', preimage: firstPay(P.c).preimage })
            : tx(h, { state: 'settled', preimage: firstPay(P.c).preimage, settled_at: nowSecs() });
        }
        return { error: { code: 'NOT_FOUND', message: 'e2e: no such payment' } };
      }
      return { error: { code: 'NOT_IMPLEMENTED', message: `${method} is not stubbed` } };
    },
  });

  t.ok('the boost modal opens with an NWC wallet', await openBoost(wallet.uri));
  const pressed = Date.now();
  t.ok('SEND is pressed', await pressSend());
  t.ok('"Keep the app open until the boost is done." shows while it sends',
    !!(await until(`!!document.querySelector('[data-keep-open]')`, 5000)));

  // Biggest share first: Alpha, Bravo, Charlie, Delta, Echo.
  const echoPaid = await (async () => {
    for (let i = 0; i < 90 * 4; i += 1) { if (wallet.pays(P.e).length) return true; await wait(250); }
    return false;
  })();
  t.ok('Echo, the fifth leg, reaches the wallet', echoPaid);
  const at = (pk) => wallet.pays(pk)[0]?.at ?? NaN;
  const gaps = [at(P.b) - at(P.a), at(P.c) - at(P.b), at(P.d) - at(P.c)];
  t.ok(`each unanswered leg holds the next for about 15 s, not 60 s (${gaps.map((g) => Math.round(g / 1000)).join(' s, ')} s)`,
    gaps.every((g) => g >= 14_000 && g < 25_000), JSON.stringify(gaps));
  t.ok('Echo started before Alpha\'s 60 s were up', at(P.e) - at(P.a) < 62_000, String(at(P.e) - at(P.a)));
  t.ok('the panel is open while legs still wait', await dialogOpen());

  // Delta, the last unanswered leg, times out 60 s after it started.
  const settled = await until(`!(${SEND}) && !document.querySelector('[data-keep-open]')`, 120_000);
  t.ok(`the boost finishes once the last leg times out (${Math.round((Date.now() - pressed) / 1000)} s)`, !!settled, await dialogText());
  t.ok('Alpha: the wallet says settled → ✓, out of the unconfirmed list', !!(await untilLine('Alpha', 'gone', 20000)), await lineText('Alpha'));
  t.ok('Bravo: the wallet says failed → RETRY', !!(await untilLine('Bravo', 'failed', 20000)), await lineText('Bravo'));
  t.ok('...and the line says only what the wallet said', (await lineText('Bravo')).includes('Your wallet says this payment failed.'), await lineText('Bravo'));
  t.ok('Charlie: pending → asked again', !!(await untilLine('Charlie', 'pending', 20000)), await lineText('Charlie'));
  t.ok('Delta: NOT_FOUND → unknown, never RETRY', !!(await untilLine('Delta', 'unknown', 20000)), await lineText('Delta'));
  // NOT_FOUND is what a wallet that ignored our preimage says about a payment
  // that went out: the line must not read as "not paid".
  t.ok('...says the wallet may have paid under its own ID, and to look in the wallet',
    (await lineText('Delta')).includes('It may have paid under its own ID. Look in your wallet'), await lineText('Delta'));
  t.ok('...and CHECK AGAIN, not RETRY', (await js(`!!${LINE('Delta')}?.querySelector('[data-leg-check]') && !${LINE('Delta')}?.querySelector('[data-leg-retry]')`)) === true);
  t.equal('every lookup named its leg\'s payment hash (sha256 of the preimage the app made)',
    [P.a, P.b, P.c, P.d].map((pk) => wallet.lookups(hashOf(firstPay(pk)?.preimage ?? '00')).length > 0), [true, true, true, true]);
  t.equal('Echo, answered, was never asked about', wallet.requests.filter((r) => r.method === 'lookup_invoice' && r.params.payment_hash === hashOf(firstPay(P.e)?.preimage ?? '00')).length, 0);
  t.equal('nothing was paid twice', [P.a, P.b, P.c, P.d, P.e].map((pk) => wallet.pays(pk).length), [1, 1, 1, 1, 1]);
  t.ok('the panel stays open while a leg is ?', await dialogOpen());

  // ---- 390 px, with RETRY and CHECK AGAIN on screen ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await wait(600);
  const layout = await js(`(() => {
    const d = document.documentElement;
    const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
    const lines = [...document.querySelectorAll('[data-unconfirmed-legs] li')];
    return {
      overflow: d.scrollWidth - d.clientWidth,
      lineOverflow: lines.filter((li) => li.scrollWidth > li.clientWidth + 1).length,
      controls: [...document.querySelectorAll('[data-leg-retry], [data-leg-check]')].map(box),
    };
  })()`);
  t.equal('390 px: no sideways overflow on the page', layout?.overflow, 0);
  t.equal('390 px: no unconfirmed line overflows', layout?.lineOverflow, 0);
  t.ok(`390 px: RETRY and CHECK AGAIN are at least 24×24 (${JSON.stringify(layout?.controls)})`,
    layout?.controls?.length === 2 && layout.controls.every(([w, h]) => w >= 24 && h >= 24));
  await send('Emulation.clearDeviceMetricsOverride');
  await wait(400);

  t.ok('Charlie: asked again 15 s later → settled → ✓', !!(await untilLine('Charlie', 'gone', 30000)), await lineText('Charlie'));
  t.equal('...in two lookups', charlieLookups, 2);

  await js(`${LINE('Bravo')}?.querySelector('[data-leg-retry]')?.click()`);
  t.ok('RETRY on Bravo → ✓', !!(await untilLine('Bravo', 'gone', 20000)), await lineText('Bravo'));
  const [b1, b2] = wallet.pays(P.b).map((r) => r.params);
  t.equal('...paid ONCE more', wallet.pays(P.b).length, 2);
  t.equal('...with the SAME preimage, so the same payment hash', b2?.preimage, b1?.preimage);
  t.equal('...and the same amount and TLV records', [b2?.amount, b2?.tlv_records], [b1?.amount, b1?.tlv_records]);

  const lookupsBefore = wallet.lookups(hashOf(firstPay(P.d).preimage)).length;
  await js(`${LINE('Delta')}?.querySelector('[data-leg-check]')?.click()`);
  await until(`(${LINE('Delta')}?.dataset.legState) === 'checking'`, 3000);
  t.ok('CHECK AGAIN on Delta asks once more', !!(await until(`(${LINE('Delta')}?.dataset.legState) === 'unknown'`, 20000)));
  t.equal('...one more lookup', wallet.lookups(hashOf(firstPay(P.d).preimage)).length - lookupsBefore, 1);
  t.equal('...and still no second payment to anyone but Bravo', [P.a, P.c, P.d, P.e].map((pk) => wallet.pays(pk).length), [1, 1, 1, 1]);

  t.equal('Lightning: 4/5 sent', await sentCount(), [4, 5]);
  t.ok('the panel is still open (Delta is ?)', await dialogOpen());
  const n = await notes();
  t.equal('one boost note', n.length, 1);
  t.equal('...signed by the user', n[0]?.pubkey, userPk);

  const legs = await storedLegs();
  const byName = Object.fromEntries(legs.map((l) => [l.recipientName, l]));
  t.equal('the log: Alpha, Bravo, Charlie, Echo paid; Delta unconfirmed',
    ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((k) => [byName[k]?.ok, !!byName[k]?.indeterminate]),
    [[true, false], [true, false], [true, false], [false, true], [true, false]]);
  const disk = String(await js(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))`));
  t.ok('no preimage the app made reaches storage', [P.a, P.b, P.c, P.d, P.e].every((pk) => !disk.includes(firstPay(pk).preimage)));
  t.ok('...nor a payment hash', [P.a, P.b, P.c, P.d].every((pk) => !disk.includes(hashOf(firstPay(pk).preimage))));
  wallet.close();
}

// =============================================================================
if (runs(2)) {
  section('2. a wallet with no lookup_invoice: no lookup, no second payment');
  const P = node();
  itemValue = valueOf([{ name: 'Foxtrot', type: 'node', address: P, split: 100 }]);
  const wallet = await stubWallet({
    methods: ALL_METHODS.filter((x) => x !== 'lookup_invoice'),
    answer: (req) => (req.method === 'pay_keysend' ? null : { error: { code: 'NOT_IMPLEMENTED', message: 'e2e' } }),
  });
  t.ok('the boost modal opens', await openBoost(wallet.uri));
  t.ok('SEND is pressed', await pressSend());
  t.ok('the leg comes back ?, and the line says the wallet cannot look it up',
    !!(await untilLine('Foxtrot', 'unknown', 90_000)) && (await lineText('Foxtrot')).includes('does not let the app look up payments'),
    await lineText('Foxtrot'));
  t.ok('the app read the wallet\'s method list first', wallet.requests.some((r) => r.method === 'get_info'));
  t.equal('...so no lookup_invoice was sent', wallet.requests.filter((r) => r.method === 'lookup_invoice').length, 0);
  t.equal('one payment, never a second', wallet.pays(P).length, 1);
  t.equal('no RETRY', await js(`!!${LINE('Foxtrot')}?.querySelector('[data-leg-retry]')`), false);
  t.ok('the panel stays open', await dialogOpen());
  t.equal('no note: nothing is known to be paid', (await notes()).length, 0);
  wallet.close();
}

// =============================================================================
if (runs(3)) {
  section('3. the page is frozen while a leg waits');
  const P = { g: node(), h: node() };
  itemValue = valueOf([
    { name: 'Golf', type: 'node', address: P.g, split: 60 },
    { name: 'Hotel', type: 'node', address: P.h, split: 40 },
  ]);
  let golf = null;
  const wallet = await stubWallet({
    methods: ALL_METHODS,
    answer: (req) => {
      if (req.method === 'pay_keysend' && req.params.pubkey === P.g) { golf = req; return null; } // answered while frozen
      if (req.method === 'pay_keysend') return { result: { preimage: req.params.preimage } };
      if (req.method === 'lookup_invoice' && golf && req.params.payment_hash === hashOf(golf.params.preimage)) {
        return tx(req.params.payment_hash, { state: 'settled', preimage: golf.params.preimage, settled_at: nowSecs() });
      }
      return { error: { code: 'NOT_FOUND', message: 'e2e' } };
    },
  });
  t.ok('the boost modal opens', await openBoost(wallet.uri));
  t.ok('SEND is pressed', await pressSend());
  for (let i = 0; i < 40 && !golf; i += 1) await wait(250);
  t.ok('Golf\'s payment reaches the wallet', !!golf);
  await send('Page.setWebLifecycleState', { state: 'frozen' });
  await wait(500);
  golf?.reply({ result: { preimage: golf.params.preimage } }); // sent while the page is frozen
  console.log('  …  frozen for 65 s (the app in the background)');
  await wait(65_000);
  t.equal('nothing was sent while the page was frozen', wallet.pays(P.h).length, 0);
  await send('Page.setWebLifecycleState', { state: 'active' });
  t.ok('on wake, Hotel is paid', !!(await (async () => { for (let i = 0; i < 80; i += 1) { if (wallet.pays(P.h).length) return true; await wait(250); } return false; })()));
  t.ok('Golf ends ✓', !!(await until(`(() => { const s = /Lightning: (\\d+)\\/2 sent/.exec(${DIALOG}?.innerText ?? ''); return s && s[1] === '2'; })()`, 60_000)), await dialogText());
  t.ok('...because the app ASKED: the reply sent during the freeze was lost', wallet.lookups(hashOf(golf?.params?.preimage ?? '00')).length >= 1);
  t.equal('nothing was paid twice', [wallet.pays(P.g).length, wallet.pays(P.h).length], [1, 1]);
  const n = await (async () => { for (let i = 0; i < 80; i += 1) { const x = await notes(); if (x.length) return x; await wait(250); } return []; })();
  t.equal('the note posts (to the stand-in relays)', n.length, 1);
  wallet.close();
}

// =============================================================================
if (runs(4)) {
  section('4. an LNURL leg is asked about by its invoice\'s payment hash');
  itemValue = valueOf([{ name: 'India', type: 'lnaddress', address: `leg@${LNURL_HOST}`, split: 100 }]);
  const wallet = await stubWallet({
    methods: ALL_METHODS,
    answer: (req) => {
      if (req.method === 'pay_invoice') return null;
      if (req.method === 'lookup_invoice' && req.params.payment_hash === lnurl.hash) {
        return { result: { ...tx(lnurl.hash).result, invoice: lnurl.invoice, state: 'settled', preimage: 'cd'.repeat(32), settled_at: nowSecs() } };
      }
      if (req.method === 'lookup_invoice') return { error: { code: 'NOT_FOUND', message: 'e2e' } };
      return { error: { code: 'NOT_IMPLEMENTED', message: 'e2e' } };
    },
  });
  t.ok('the boost modal opens', await openBoost(wallet.uri));
  t.ok('SEND is pressed', await pressSend());
  const payInvoice = await (async () => { for (let i = 0; i < 120; i += 1) { const r = wallet.requests.find((x) => x.method === 'pay_invoice'); if (r) return r; await wait(250); } return null; })();
  t.ok('the leg goes out as pay_invoice, for the address\'s invoice', !!lnurl.invoice && payInvoice?.params?.invoice === lnurl.invoice,
    `${payInvoice?.params?.invoice} · ${lnurl.invoice} · ${await dialogText()}`);
  t.ok('India ends ✓ once asked', !!(await until(`/Lightning: 1\\/1 sent/.test(${DIALOG}?.innerText ?? '')`, 100_000)),
    `${await lineState('India')} · ${await dialogText()}`);
  t.equal('the lookup named the hash in the BOLT11 (not the decoy `s` before it)', wallet.requests.filter((r) => r.method === 'lookup_invoice').map((r) => r.params.payment_hash), [lnurl.hash]);
  t.equal('one invoice asked for, one paid', [lnurl.asked, wallet.requests.filter((r) => r.method === 'pay_invoice').length], [1, 1]);
  wallet.close();
}

// =============================================================================
if (runs(5)) {
  section('5. RETRY: no accidental close while it pays, and a refusal says why');
  const P = node();
  itemValue = valueOf([{ name: 'Juliet', type: 'node', address: P, split: 100 }]);
  let held = null;
  const wallet = await stubWallet({
    methods: ALL_METHODS,
    answer: (req) => {
      if (req.method === 'pay_keysend') {
        if (wallet?.pays(P).length > 1) held = req; // the RETRY: the test answers it
        return null; // the first send: never answered → ?
      }
      if (req.method === 'lookup_invoice') return tx(req.params.payment_hash, { state: 'failed' });
      return { error: { code: 'NOT_IMPLEMENTED', message: 'e2e' } };
    },
  });
  t.ok('the boost modal opens', await openBoost(wallet.uri));
  t.ok('SEND is pressed', await pressSend());
  t.ok('Juliet: the wallet says failed → RETRY', !!(await untilLine('Juliet', 'failed', 90_000)), await lineText('Juliet'));
  await js(`${LINE('Juliet')}?.querySelector('[data-leg-retry]')?.click()`);
  for (let i = 0; i < 40 && !held; i += 1) await wait(250);
  t.ok('the RETRY payment reaches the wallet', !!held);
  t.ok('"Keep the app open" shows while it pays', (await dialogText()).includes('Keep the app open'), await dialogText());
  // The two accidental exits <ModalShell> allows: Escape with focus in the card,
  // and a press on the backdrop (x = 5 is inside the overlay's padding).
  await js(`${DIALOG}?.focus()`);
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(400);
  t.ok('Escape does not close the panel while the RETRY payment moves', await dialogOpen());
  const midY = Number(await js('Math.round(innerHeight / 2)'));
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: 5, y: midY, button: 'left', clickCount: 1 });
  await wait(400);
  t.ok('...nor does a press on the backdrop', await dialogOpen());
  held?.reply({ error: { code: 'INSUFFICIENT_BALANCE', message: 'insufficient balance (e2e)' } });
  t.ok('the wallet\'s refusal is shown on the line',
    !!(await until(`(${LINE('Juliet')}?.innerText ?? '').includes('does not have enough sats')`, 20_000)), await lineText('Juliet'));
  t.ok('...the leg is asked about again, and RETRY comes back only after "failed"', !!(await untilLine('Juliet', 'failed', 20_000)), await lineText('Juliet'));
  t.ok('...with the reason still there', (await lineText('Juliet')).includes('does not have enough sats'), await lineText('Juliet'));
  const [first, again] = wallet.pays(P);
  t.equal('both payments carry the SAME preimage', again?.params?.preimage, first?.params?.preimage);
  t.equal('two payments only: the send and the one RETRY', wallet.pays(P).length, 2);
  t.equal('two lookups, both by that hash', wallet.lookups(hashOf(first?.params?.preimage ?? '00')).length, 2);
  t.ok('the panel stays open (the leg is ?)', await dialogOpen());
  wallet.close();
}

// =============================================================================
if (runs(6)) {
  section('6. a signer that does not answer: the note is skipped, and posted later');
  const P = node();
  itemValue = valueOf([{ name: 'Kilo', type: 'node', address: P, split: 100 }]);
  const wallet = await stubWallet({
    methods: ALL_METHODS,
    answer: (req) => (req.method === 'pay_keysend' ? { result: { preimage: req.params.preimage } } : { error: { code: 'NOT_FOUND', message: 'e2e' } }),
  });
  t.ok('the boost modal opens', await openBoost(wallet.uri));
  heldSigns = [];
  t.ok('SEND is pressed', await pressSend());
  t.ok('Kilo is paid', !!(await until(`/Lightning: 1\\/1 sent/.test(${DIALOG}?.innerText ?? '')`, 30_000)), await dialogText());
  t.ok('the note asks the signer, which does not answer',
    await (async () => { for (let i = 0; i < 80; i += 1) { if (heldSigns.length) return true; await wait(250); } return false; })());
  t.ok('after a short wait, STOP WAITING appears', !!(await until(`!!${DIALOG}?.querySelector('[data-note-stop]')`, 20_000)), await dialogText());
  await js(`${DIALOG}?.querySelector('[data-note-stop]')?.click()`);
  const RETRY_NOTE = `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => /retry note/i.test(b.textContent))`;
  t.ok('STOP WAITING: "Note not posted", with RETRY NOTE',
    !!(await until(`/Note not posted/.test(${DIALOG}?.innerText ?? '') && !!(${RETRY_NOTE})`, 5_000)), await dialogText());
  const late = heldSigns ?? [];
  heldSigns = null;
  for (const h of late) await answerSign(h); // the signer answers after all
  await wait(1500);
  t.equal('the late signature is dropped: no note, no receipt asked for', [(await notes()).length, await js('window.__receiptAsks')], [0, 0]);
  t.ok('the panel stays open', await dialogOpen());
  await js(`(${RETRY_NOTE})?.click()`);
  const posted = await (async () => { for (let i = 0; i < 80; i += 1) { const x = await notes(); if (x.length) return x; await wait(250); } return []; })();
  t.equal('RETRY NOTE posts the note once', posted.length, 1);
  t.equal('...after asking for one summary receipt', await js('window.__receiptAsks'), 1);
  t.equal('one payment, never a second', wallet.pays(P).length, 1);
  wallet.close();
}

// =============================================================================
t.equal('no uncaught exception in the page', exceptions, []);
console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
