// End-to-end for THE NOTE STAMP: `/api/nostr/site-sign` signs a boost note under
// the site's verified name only when an invoice the site minted for EXACTLY
// that event was paid, and every boost that cannot get the stamp still posts its
// note — from a one-time key. Reasoning: docs/security.md and
// docs/money-boosts.md, "the site-sign stamp".
//
// Usage (a THROWAWAY site key — never run this against the real SITE_NOSTR_SK):
//   export E2E_SITE_SK=$(node -e "import('nostr-tools').then(m=>console.log(Buffer.from(m.generateSecretKey()).toString('hex')))")
//   npm run build
//   SITE_NOSTR_SK=$E2E_SITE_SK SITE_STAMP_LNADDRESS=stamp@127.0.0.1:3418 \
//     SITE_SIGN_REQUIRE_STAMP=on npx next start -p 3417 -H 127.0.0.1
//   APP_URL=http://127.0.0.1:3417 E2E_SITE_SK=$E2E_SITE_SK E2E_REQUIRE_STAMP=on npm run e2e:sitestamp
// Phase 1 (the switch off): start the server WITHOUT SITE_SIGN_REQUIRE_STAMP and run
//   E2E_REQUIRE_STAMP= ONLY=1 npm run e2e:sitestamp
// `ONLY=1,3` runs those sections alone; `--headed` to watch, `--keep` to leave it open.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but this one
// (`--host-resolver-rules`); the site's Lightning address is
// `fake-stamp-address.mjs`, started by this script on port 3418, which is why
// the server's SITE_STAMP_LNADDRESS names it; the
// site key is the throwaway above, and the first signature proves the server
// holds it.
//
// What it pins:
//   1. The routes, called with `fetch` from inside the page: a bare template is
//      refused with the switch on and signed with it off; an unpaid stamp is
//      402; a paid stamp signs exactly its own event, as often as asked; a
//      changed note, a flipped MAC and a refused template are 400; an address
//      that refuses, has no verify link, or whose verify link hangs is a 502
//      inside the route's own timeout. The price is 1% of the boost the note
//      states (1000 sats → 10, 50,000 → 500); a note whose text claims more
//      than its `amount` tag, or that has none, is 400 with no invoice.
//   2. Signed out, WebLN, 1000 sats: one 10-sat stamp, paid AFTER every leg;
//      the note is the site's.
//   3–6. The wallet refuses / the address cannot make the invoice / the invoice
//      is for another amount / the verify link hangs: the note still posts, from a one-time key, and the
//      modal stays open and says why — never that the sats stayed.
//   7. × pressed while the stamp is being paid: one note, one stamp, and a
//      second modal opened at once is not closed when the first note lands.
//   8. BOOST ALL, signed out: one stamp for the summary note.
//   9. Signed in, Anonymous: the site's note; the user's signer signs no kind:1;
//      under the Buddy domain the Anonymous line takes no more lines than
//      "My feed"'s, at 390 px and at 1280 px.
//  10. NWC: the stamp goes out as `pay_invoice` through a stub NIP-47 wallet.
//  11. "Don't post" and "My feed": no stamp is ever asked for.
//  12. Every relay refuses the note: RETRY NOTE posts it; still one stamp.
//  13. The message says "boosted 5000 sats" over a 100-sat boost: the page asks
//      for no stamp and pays none, and the note posts one-time with the reason.
//  14. One leg fails: the quoted receipt is for less than the note, and the site
//      still signs. Section 1 also refuses a note quoting a receipt for MORE
//      (a free 1,000,000-sat site receipt under a 1-sat stamp), a quote with no
//      receipt, an edited receipt, another key's, and a malformed one (400, not
//      500); section 2 checks that the real flow quotes the site's receipt.
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
import { createFakeStampAddress } from './fake-stamp-address.mjs';
import { createRelay } from './local-relay.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3417';
const SITE_SK_HEX = process.env.E2E_SITE_SK ?? '';
const REQUIRE_STAMP = process.env.E2E_REQUIRE_STAMP === 'on';
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const runs = (n) => ONLY.length === 0 || ONLY.includes(String(n));
const STAMP_PORT = 3418;

if (!/^[0-9a-f]{64}$/.test(SITE_SK_HEX)) {
  console.error('E2E_SITE_SK must be the 64-hex throwaway key the server was started with (see the header).');
  process.exit(2);
}
const siteSk = Uint8Array.from(Buffer.from(SITE_SK_HEX, 'hex'));
const sitePk = getPublicKey(siteSk);

const stampAddr = createFakeStampAddress({ port: STAMP_PORT });
await stampAddr.ready;
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

// The stamp payment, answered from here so the fake address learns it was paid.
await send('Runtime.addBinding', { name: 'bmbPay' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbPay') return;
  const { rid, invoice } = JSON.parse(m.params.payload);
  let err = null;
  // Only a stamp is paid here. A BOOST ALL lnaddress leg's LNURL invoice is
  // refused, as a keysend-only wallet would, and is not counted.
  const isStamp = stampAddr.minted.some((x) => x.bolt11 === invoice);
  if (isStamp) stampPays.push(invoice);
  if (!isStamp) err = 'e2e: keysend only';
  else if (payMode === 'refuse') err = 'e2e: the user rejected the payment';
  else {
    if (payMode === 'slow') await wait(3000);
    if (!stampAddr.markPaid(invoice)) err = 'e2e: an invoice the fake never minted';
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
      keysend: async (a) => {
        if (window.__failKeysends > 0) { window.__failKeysends -= 1; throw new Error('e2e: this keysend failed'); }
        window.__paid.push({ kind: 'keysend', at: Date.now(), amount: a.amount }); await new Promise((r) => setTimeout(r, 200)); return { preimage: '00'.repeat(32) };
      },
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
/**
 * The smallest template the routes take: the prefix, the two `t` markers, and —
 * for the stamp's price, 1% of the boost — one `amount` tag and a sentence that
 * states the same number.
 */
const template = ({ sats = 100, tail = 'a note stamp test', message = '', content } = {}) => ({
  kind: 1,
  created_at: nowSecs(),
  tags: [['amount', String(sats * 1000)], ['t', 'boostagram'], ['t', 'value4value'], ['client', 'e2e']],
  content: content ?? `⚡ Boost ⚡\n\n${message ? `${message}\n\n` : ''}e2e boosted ${sats} sats to ${tail}`,
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
  stampAddr.reset();

  const bare = await post('/api/nostr/site-sign', template());
  if (REQUIRE_STAMP) {
    t.equal('a bare template, switch on → 402', [bare?.status, bare?.body?.error], [402, 'a note stamp is required']);
  } else {
    t.equal('a bare template, switch off → 200 (phase 1)', bare?.status, 200);
    t.equal('...signed by the throwaway site key', bare?.body?.event?.pubkey, sitePk);
  }

  if (!ONLY.length || REQUIRE_STAMP) {
    const before = stampAddr.minted.length;
    const note = template();
    const minted = await post('/api/nostr/site-stamp', { template: note });
    t.equal('site-stamp answers 200', minted?.status, 200);
    t.equal('...and minted one invoice', stampAddr.minted.length - before, 1);
    const inv = stampAddr.minted.at(-1);
    t.ok('...for 1% of a 100-sat boost: 1 sat (1000 msat)', inv?.amount === 1000, JSON.stringify(inv));
    t.ok('...with the brand\'s stamp comment', / note stamp$/.test(inv?.comment ?? ''), inv?.comment);
    t.equal('...and handed back that invoice', minted?.body?.invoice, inv?.bolt11);
    const stamp = minted?.body?.stamp;
    const claims = stamp ? claimsOf(stamp) : {};
    t.equal('the token names the invoice\'s verify link', claims.vu, inv?.verify);

    const unpaid = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('an unpaid stamp → 402 not paid', [unpaid?.status, unpaid?.body?.error], [402, 'the note stamp is not paid']);

    t.ok('the page pays it (the fake address)', stampAddr.markPaid(inv?.bolt11));
    const signed = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('a paid stamp → 200', signed?.status, 200);
    if (signed?.body?.event?.pubkey && signed.body.event.pubkey !== sitePk) {
      t.fail('THE SERVER IS NOT RUNNING UNDER E2E_SITE_SK — stop and restart it as the header says');
      await stampAddr.close();
      await exit(1);
    }
    t.equal('...signed by the site key', signed?.body?.event?.pubkey, sitePk);
    t.equal('...as exactly the event the stamp was minted for', signed?.body?.event?.id, claims.id);

    const again = await post('/api/nostr/site-sign', { template: note, stamp });
    t.equal('asked again (RETRY NOTE): the same event id', again?.body?.event?.id, claims.id);
    t.equal('...and no new invoice', stampAddr.minted.length - before, 1);

    const changed = await post('/api/nostr/site-sign', { template: { ...note, content: `${note.content}!` }, stamp });
    t.equal('the paid stamp on a changed note → 400', [changed?.status, changed?.body?.error], [400, 'the note stamp is for a different note']);

    const forged = await post('/api/nostr/site-sign', { template: note, stamp: flipLast(stamp ?? 'x.y') });
    t.equal('a flipped MAC character → 400', [forged?.status, forged?.body?.error], [400, 'the note stamp is not valid']);

    const otherKey = generateSecretKey();
    const stranger = finalizeEvent(template(), otherKey);
    const smuggled = await post('/api/nostr/site-sign', { template: note, stamp: `${Buffer.from(JSON.stringify({ v: 1, id: stranger.id, vu: inv?.verify, exp: nowSecs() + 60 })).toString('base64url')}.${stamp?.split('.')[1]}` });
    t.equal('another payload under the paid MAC → 400', [smuggled?.status, smuggled?.body?.error], [400, 'the note stamp is not valid']);

    const mintedBefore = stampAddr.minted.length;
    const refused = await post('/api/nostr/site-stamp', { template: template({ content: 'not a boost note' }) });
    t.equal('a template the validator refuses → 400 from site-stamp', [refused?.status, refused?.body?.error], [400, 'not a boost note']);
    t.equal('...and no invoice was minted for it', stampAddr.minted.length, mintedBefore);

    // The price: 1% of the boost the note states, read by the SERVER.
    const big = await post('/api/nostr/site-stamp', { template: template({ sats: 1000 }) });
    t.equal('a 1000-sat note: 200, and an invoice for 10 sats (10,000 msat)',
      [big?.status, stampAddr.minted.at(-1)?.amount, big?.body?.invoice === stampAddr.minted.at(-1)?.bolt11], [200, 10_000, true]);
    const fifty = await post('/api/nostr/site-stamp', { template: template({ sats: 50_000 }) });
    t.equal('a 50,000-sat note: 500 sats — no maximum', [fifty?.status, stampAddr.minted.at(-1)?.amount], [200, 500_000]);
    const pricedBefore = stampAddr.minted.length;
    const claimsMore = await post('/api/nostr/site-stamp', { template: template({ message: 'Satoshi boosted 1000000 sats to the moon' }) });
    t.equal('a note whose text claims more than its amount tag → 400',
      [claimsMore?.status, claimsMore?.body?.error], [400, 'the note claims a different amount than its amount tag']);
    const noAmount = template();
    noAmount.tags = noAmount.tags.filter((tag) => tag[0] !== 'amount');
    const untagged = await post('/api/nostr/site-stamp', { template: noAmount });
    t.equal('a note with no amount tag → 400', [untagged?.status, untagged?.body?.error], [400, 'a site note needs exactly one amount tag']);
    t.equal('...and neither one minted an invoice', stampAddr.minted.length, pricedBefore);

    {
      // The quoted receipt: Fountain draws the ⚡ figure from it, so it may not
      // claim more than the note the stamp is priced at. Signed here with the
      // throwaway SITE key — exactly what the receipt route would sign.
      const receiptFor = (sats, sk = siteSk) => finalizeEvent({
        kind: 9735, created_at: nowSecs(), content: '',
        tags: [['p', sitePk], ['P', sitePk], ['description', '{}'], ['amount', String(sats * 1000)]],
      }, sk);
      const quotingNote = (sats, receiptId) => {
        const n = template({ sats });
        n.tags.push(['q', receiptId, 'wss://relay.example', sitePk]);
        return n;
      };
      const quoteBefore = stampAddr.minted.length;
      const whole = receiptFor(100);
      const ok100 = await post('/api/nostr/site-stamp', { template: quotingNote(100, whole.id), receipt: whole });
      t.equal('a note quoting the site\'s receipt for its whole boost → 200 and an invoice', [ok100?.status, typeof ok100?.body?.invoice], [200, 'string']);
      const part = receiptFor(640);
      const okPart = await post('/api/nostr/site-stamp', { template: quotingNote(1000, part.id), receipt: part });
      t.equal('...for less (a leg failed: 640 of 1000) → 200, priced at the note: 10 sats',
        [okPart?.status, stampAddr.minted.at(-1)?.amount], [200, 10_000]);
      const minted2 = stampAddr.minted.length;
      const huge = receiptFor(1_000_000);
      const overQuote = await post('/api/nostr/site-stamp', { template: quotingNote(100, huge.id), receipt: huge });
      t.equal('a 100-sat note quoting a FREE 1,000,000-sat site receipt → 400',
        [overQuote?.status, overQuote?.body?.error], [400, 'the quoted receipt claims more than the note']);
      const missing = await post('/api/nostr/site-stamp', { template: quotingNote(100, whole.id) });
      t.equal('a quote with no receipt sent → 400', [missing?.status, missing?.body?.error], [400, 'the note quotes a receipt it did not send']);
      const forged = { ...huge, tags: huge.tags.map((tag) => (tag[0] === 'amount' ? ['amount', '100000'] : tag)) };
      const edited = await post('/api/nostr/site-stamp', { template: quotingNote(100, forged.id), receipt: forged });
      t.equal('a site receipt whose amount was edited after signing → 400', [edited?.status, edited?.body?.error], [400, 'the quoted receipt is not the site’s']);
      const otherReceipt = finalizeEvent({ kind: 9735, created_at: nowSecs(), content: '', tags: forged.tags }, generateSecretKey());
      const strangers = await post('/api/nostr/site-stamp', { template: quotingNote(100, otherReceipt.id), receipt: otherReceipt });
      t.equal('a receipt another key signed → 400', [strangers?.status, strangers?.body?.error], [400, 'the quoted receipt is not the site’s']);
      const malformed = { id: whole.id, kind: 9735, pubkey: sitePk, tags: [['amount', '100000']] };
      const bad = await post('/api/nostr/site-stamp', { template: quotingNote(100, whole.id), receipt: malformed });
      t.equal('a receipt with fields missing → 400, never a 500', [bad?.status, bad?.body?.error], [400, 'the quoted receipt is not the site’s']);
      t.equal('...and no refused one minted an invoice', stampAddr.minted.length, minted2);
      t.ok('(both accepted ones did)', minted2 - quoteBefore === 2);
    }

    stampAddr.mode.mint = 'fail';
    const mintFail = await post('/api/nostr/site-stamp', { template: template() });
    t.equal('the address refuses to make the invoice → 502', [mintFail?.status, mintFail?.body?.error], [502, 'could not create the stamp invoice']);
    stampAddr.reset();

    stampAddr.mode.mint = 'noverify';
    const noVerify = await post('/api/nostr/site-stamp', { template: template() });
    t.equal('an address with no LUD-21 verify link → 502', [noVerify?.status, noVerify?.body?.error], [502, 'could not create the stamp invoice']);
    stampAddr.reset();

    stampAddr.mode.mint = 'overcharge';
    const over = await post('/api/nostr/site-stamp', { template: template() });
    t.equal('an invoice for another amount → 502, never handed to the page', [over?.status, over?.body?.error, over?.body?.invoice], [502, 'could not create the stamp invoice', undefined]);
    stampAddr.reset();

    // The mint is TWO calls in a row. One deadline covers both, or a slow pay
    // request plus a hung callback outlasts the page's 15 s wait.
    stampAddr.mode.payreq = 'slow';
    stampAddr.mode.mint = 'hang';
    const mintStarted = Date.now();
    const slowMint = await post('/api/nostr/site-stamp', { template: template() });
    const mintTook = Date.now() - mintStarted;
    t.equal('a slow pay request, then a callback that never answers → 502', [slowMint?.status, slowMint?.body?.error], [502, 'could not create the stamp invoice']);
    t.ok(`...inside 10 s for both calls together (took ${mintTook} ms)`, mintTook < 10_000);
    stampAddr.reset();

    const second = template({ tail: 'the lookup hangs' });
    const m2 = await post('/api/nostr/site-stamp', { template: second });
    stampAddr.markPaid(m2?.body?.invoice);
    stampAddr.mode.lookup = 'hang';
    const started = Date.now();
    const hang = await post('/api/nostr/site-sign', { template: second, stamp: m2?.body?.stamp });
    const took = Date.now() - started;
    t.equal('the verify link never answers → 502', [hang?.status, hang?.body?.error], [502, 'could not confirm the stamp']);
    t.ok(`...inside 10 s (took ${took} ms)`, took < 10_000);
    stampAddr.reset();
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
async function typeMessage(text) {
  await js(`(() => { const f = ${DIALOG}?.querySelector('textarea'); f.focus(); return 1; })()`);
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
/** The relays the page published an event to, sorted. Both modals call
 *  `publishBoostNoteViaSite` with no `relays`, so this must stay the four
 *  DEFAULT_RELAYS; the option exists for e2e:mentions' local relay only. */
async function relaysOf(id) {
  let got = [];
  for (let i = 0; i < 20; i += 1) {
    const urls = (await js(`window.__published.filter((p) => p.event.id === ${JSON.stringify(id ?? '')}).map((p) => p.url)`)) ?? [];
    got = [...new Set(urls.map((u) => String(u).replace(/\/+$/, '')))].sort();
    if (got.length >= DEFAULT_RELAYS.length) break;
    await wait(250);
  }
  return got;
}
const ALL_FOUR = [...DEFAULT_RELAYS].sort();
/** A kind:9735 the page published, by id. */
const receiptById = async (id) => ((await js(`window.__published.map((p) => p.event)`)) ?? []).find((e) => e.kind === 9735 && e.id === id) ?? null;
const mark = () => ({ asks: stampAsks.length, pays: stampPays.length, minted: stampAddr.minted.length });
const since = (m) => ({ asks: stampAsks.length - m.asks, pays: stampPays.length - m.pays, minted: stampAddr.minted.length - m.minted });
const failText = (why) => `${ONE_TIME}, not Boost Me Bitch: ${why}.`;
const signerIsOneTime = (e) => !!e && e.pubkey !== sitePk && e.pubkey !== userPk && verifyEvent(e);

/** One signed-out boost of the episode whose stamp fails some way; the note must still post. */
async function oneTimeCase(label, setup, why, extra = async () => {}) {
  stampAddr.reset();
  payMode = 'ok';
  t.ok(`${label}: the episode page opens`, await openEpisode());
  t.ok('...the boost modal opens', await openBoost());
  await typeAmount('100');
  const m = mark();
  await setup();
  t.ok('...SEND is pressed', await pressSend());
  const started = Date.now();
  const note = await noteAfter(40000);
  t.ok('...the note still reaches the relays', !!note, note ? '' : await dialogText());
  t.ok('...signed by a one-time key (neither the site nor the user)', signerIsOneTime(note), note?.pubkey);
  t.equal('...on the four DEFAULT_RELAYS', await relaysOf(note?.id), ALL_FOUR);
  t.ok(`...within 30 s (took ${Date.now() - started} ms)`, Date.now() - started < 30000);
  t.ok(`...and the modal says "${failText(why)}"`, (await until(`(${DIALOG}?.innerText ?? '').includes(${JSON.stringify(failText(why))})`, 5000)) === true, await dialogText());
  await wait(2500);
  t.ok('...and stays open to say it', !!(await js(`!!${DIALOG}`)));
  t.ok('...over legs that paid (✓)', (await dialogText()).includes('✓'), await dialogText());
  await extra(m);
  payMode = 'ok';
  stampAddr.reset();
}

// =============================================================================
if (runs(2)) {
  section('2. signed out, WebLN: one stamp, paid after every leg; the site signs');
  stampAddr.reset();
  t.ok('the episode page opens', await openEpisode());
  t.ok('the boost modal opens', await openBoost());
  t.ok('the signed-out share line names the 1%', (await until(`/1% of the boost/.test(${DIALOG}?.innerText ?? '')`, 20000)) === true, await dialogText());
  // 1000 sats, so the price is 10 sats and not the 1-sat minimum.
  await typeAmount('1000');
  const m = mark();
  t.ok('SEND is pressed', await pressSend());
  const note = await noteAfter(30000);
  t.ok('the note reaches the relays', !!note, note ? '' : await dialogText());
  t.equal('...signed by the site key', note?.pubkey, sitePk);
  t.equal('...on the four DEFAULT_RELAYS', await relaysOf(note?.id), ALL_FOUR);
  t.equal('one stamp asked, minted and paid', since(m), { asks: 1, pays: 1, minted: 1 });
  t.equal('...for 1% of the 1000-sat boost: 10 sats', stampAddr.minted.at(-1)?.amount, 10_000);
  t.ok('...and the note says "boosted 1000 sats"', /boosted 1000 sats/.test(note?.content ?? ''), note?.content);
  const q2 = note?.tags.find((tag) => tag[0] === 'q');
  t.equal('...and quotes the site\'s summary receipt (which site-stamp checked)', q2?.[3], sitePk);
  t.equal('...for the whole 1000 sats', (await receiptById(q2?.[1]))?.tags.find((tag) => tag[0] === 'amount')?.[1], '1000000');
  const paid = await paidLog();
  const lastLeg = Math.max(...paid.filter((p) => p.kind === 'keysend').map((p) => p.at));
  const stampAt = paid.find((p) => p.kind === 'invoice')?.at ?? 0;
  t.ok('...paid AFTER every leg', paid.some((p) => p.kind === 'keysend') && stampAt > lastLeg, JSON.stringify(paid));
  t.ok('no one-time notice', !(await dialogText()).includes(ONE_TIME));
  t.ok('the modal closes on its own', !!(await until(`!${DIALOG}`, 8000)));
}

if (runs(3)) {
  section('3. the wallet refuses the stamp');
  await oneTimeCase('wallet refuses', () => { payMode = 'refuse'; }, 'your wallet did not confirm the stamp payment',
    async (m) => t.equal('...the wallet was asked once', since(m).pays, 1));
}

if (runs(4)) {
  section('4. the address cannot make the stamp invoice');
  await oneTimeCase('mint fails', () => { stampAddr.mode.mint = 'fail'; }, 'the site could not make the stamp invoice',
    async (m) => t.equal('...the wallet was never asked', since(m).pays, 0));
}

if (runs(5)) {
  section('5. the stamp invoice is for another amount');
  // The server refuses it now, so the page never holds it: "could not make".
  await oneTimeCase('overcharge', () => { stampAddr.mode.mint = 'overcharge'; }, 'the site could not make the stamp invoice',
    async (m) => t.equal('...the wallet was never asked', since(m).pays, 0));
}

if (runs(6)) {
  section('6. the verify link hangs');
  await oneTimeCase('lookup hangs', () => { stampAddr.mode.lookup = 'hang'; }, 'the site could not confirm the stamp payment',
    async (m) => t.equal('...the stamp was paid once', since(m).pays, 1));
}

if (runs(13)) {
  // The price is read from the note, and a "boosted N sats" in the message that
  // is not the boost would be refused by the route — so the page asks nothing,
  // pays nothing, and says why. A real user can only meet this by typing it.
  section('13. the message claims another amount: no stamp, a one-time note');
  await oneTimeCase('message claims another amount', () => typeMessage('I boosted 5000 sats last week too'),
    'the note names a different amount than the boost',
    async (m) => t.equal('...nothing was asked, minted or paid', since(m), { asks: 0, pays: 0, minted: 0 }));
}

if (runs(14)) {
  // The receipt states the sats that SETTLED; the note states the boost. When a
  // leg fails the receipt is smaller, and the stamp must still pass: "not more
  // than", never "equal". A real boost may never lose the site's name to it.
  section('14. one leg fails: the receipt is less than the note, and the site still signs');
  stampAddr.reset();
  t.ok('the episode page opens', await openEpisode());
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('1000');
  await js('window.__failKeysends = 1');
  const m = mark();
  t.ok('SEND is pressed', await pressSend());
  const note = await noteAfter(30000);
  t.ok('the note reaches the relays', !!note, note ? '' : await dialogText());
  t.equal('...signed by the site key, not a one-time key', note?.pubkey, sitePk);
  t.equal('...after one 10-sat stamp', [since(m), stampAddr.minted.at(-1)?.amount], [{ asks: 1, pays: 1, minted: 1 }, 10_000]);
  const q = note?.tags.find((tag) => tag[0] === 'q');
  const amount = Number((await receiptById(q?.[1]))?.tags.find((tag) => tag[0] === 'amount')?.[1]);
  t.ok(`...quoting the site's receipt for LESS than the 1000 sats (${amount / 1000})`, amount > 0 && amount < 1_000_000, String(amount));
  t.equal('...while the note still states the boost', note?.tags.find((tag) => tag[0] === 'amount')?.[1], '1000000');
  t.ok('the modal shows the failed leg (✗) and no one-time notice', (await dialogText()).includes('✗') && !(await dialogText()).includes(ONE_TIME), await dialogText());
  await js('window.__failKeysends = 0');
  await js(`${CLOSE}?.click()`);
  await until(`!${DIALOG}`, 5000);
  stampAddr.reset();
}

if (runs(7)) {
  section('7. × while the stamp is being paid: one note, one stamp');
  stampAddr.reset();
  t.ok('the episode page opens', await openEpisode());
  t.ok('the boost modal opens', await openBoost());
  await typeAmount('100');
  const m = mark();
  payMode = 'slow';
  t.ok('SEND is pressed', await pressSend());
  const paying = await until(`(${DIALOG}?.innerText ?? '').includes('Paying the 1-sat stamp (1%)')`, 30000);
  t.ok('the modal says "Paying the 1-sat stamp (1%)…"', paying === true, await dialogText());
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
  stampAddr.reset();
}

if (runs(8)) {
  section('8. BOOST ALL, signed out: one stamp for the summary note');
  stampAddr.reset();
  t.ok('the episode page opens', await openEpisode());
  await js(`document.querySelector('button[aria-label="More actions"]')?.click()`);
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => /boost all \\d+ tracks/i.test(b.textContent))`, 10000);
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => /boost all \\d+ tracks/i.test(b.textContent))?.click()`);
  t.ok('the boost-all modal opens', !!(await until(`!!(${FIELD})`, 20000)));
  // The share line renders once the tracks resolve, not with the modal.
  t.ok('...and its share line names the 1%', (await until(`/1% of the boost/.test(${DIALOG}?.innerText ?? '')`, 30000)) === true, await dialogText());
  await typeAmount('100');
  const m = mark();
  t.ok('BOOST ALL is pressed', await pressSend(BOOST_ALL));
  const note = await noteAfter(90000);
  t.ok('the summary note reaches the relays', !!note, note ? '' : await dialogText());
  t.equal('...signed by the site key', note?.pubkey, sitePk);
  t.equal('...on the four DEFAULT_RELAYS', await relaysOf(note?.id), ALL_FOUR);
  t.equal('one stamp asked, minted and paid', since(m), { asks: 1, pays: 1, minted: 1 });
}

if (runs(9)) {
  section('9. signed in, Anonymous: the site signs; the user signs no kind:1');
  stampAddr.reset();
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
  t.ok('...its line names "1% of the boost + network fee"', /1% of the boost \+ network fee/.test(phone?.text ?? ''), phone?.text);
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
  stampAddr.reset();
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
    else if (method === 'pay_invoice') { stampPays.push(params?.invoice); result = stampAddr.markPaid(params?.invoice) ? { preimage: 'ab'.repeat(32) } : null; }
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
  stampAddr.reset();
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
  stampAddr.reset();
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
await stampAddr.close();
await wait(50);
await exit(t.fails ? 1 : 0);
