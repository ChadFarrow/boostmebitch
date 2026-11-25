// e2e for ⚡ zap on a Nostr note card (components/nostr-note-card.tsx →
// `sendZap`, lib/v4v/zap.ts), up to the invoice and no further, in a real browser
// at 390 x 844 under CDP device emulation (mobile: true).
//
// Usage:
//   npm run dev -- -p 3127                                   # in another terminal
//   APP_URL=http://127.0.0.1:3127 npm run e2e:notezap
// APP_URL must name this machine (scripts/local-target.mjs).
//
// WHAT IT PINS. A zap request carries the recipient's LNURL-pay URL in its LUD-01
// bech32 form (`lnurl1…`), and every real Lightning address encodes past
// bech32's 90-character default: `sirtjthewrathful@getalby.com` is 100, Wallet of
// Satoshi 107, npub.cash 172. Until 2026-11-25 every such zap stopped in the
// dialog with "Length 100 exceeds limit 90" before it asked for an invoice. So
// BOTH authors here have a long address, and the script asserts that length
// itself: a short stub address (`maker@zap-stub.test` is 86) passes on the
// broken code.
//
//   1. An author with a long `lud16`: ⚡ zap opens the dialog, Send asks the
//      stub LNURL server for ONE invoice, the kind:9734 is signed by the viewer
//      with `e` the note and `p` the author, its `lnurl` tag equals the
//      callback's `lnurl` parameter AND the value computed here, and the stub
//      wallet is handed the invoice.
//   2. An author with only a long `lud06` (upper case, as LUD-01 writes it for a
//      QR code): the same, with the URL decoded from the lud06.
//   3. No request ever reaches `/api/lnurl` (the server fallback): the stub
//      server answers with CORS, so the browser reads it directly.
//
// NO SATS MOVE AND NOTHING REACHES A PUBLIC RELAY OR LNURL SERVER:
//   - every relay socket the page opens is redirected to a LOCAL relay, which
//     holds the two authors' kind:0 and one boost note each;
//   - the LNURL endpoints are a `.test` host answered by CDP Fetch interception,
//     and `/api/lnurl` is answered 502 and counted;
//   - the wallet is a stub `window.webln` that records the invoice it is handed
//     and pays nothing; the invoice is a stub string no node could pay;
//   - the viewer's favorites mode is `off`, so the signed-in page publishes
//     nothing, and the relays it would publish to are the local one anyway.
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { localAppUrl } from './local-target.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import { bech32 } from '@scure/base';

const APP = localAppUrl('http://127.0.0.1:3000');
await requireApp(APP, `Nothing is serving ${APP}. Start the dev server (see the top of this file).`);

// ---- keys, addresses, profiles ------------------------------------------------
const key = () => { const sk = generateSecretKey(); const pk = getPublicKey(sk); return { sk, pk, npub: nip19.npubEncode(pk) }; };
const viewer = key();
const lud16Author = key();
const lud06Author = key();
const STUB = 'zap-stub.test';
const LUD16_NAME = 'a-listener-with-a-long-lightning-name';
const LUD16 = `${LUD16_NAME}@${STUB}`;
const LUD16_URL = `https://${STUB}/.well-known/lnurlp/${LUD16_NAME}`;
const LUD06_URL = `https://${STUB}/lnurlp/an-older-profile-with-only-a-lud06?tag=payRequest`;
// Computed here with the unlimited encoder, NOT with the app's: an independent
// value, so the comparison below means something.
const lnurlOf = (url) => bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), false);
const LUD16_LNURL = lnurlOf(LUD16_URL);
const LUD06 = lnurlOf(LUD06_URL).toUpperCase();

const relay = createRelay({ port: 0, log: null });
const PORT = await relay.ready;
const LIVE = `ws://127.0.0.1:${PORT}`;
const now = Math.floor(Date.now() / 1000);
const put = (k, kind, content, tags = []) => {
  const e = finalizeEvent({ kind, created_at: now - 60, tags, content }, k.sk);
  relay.events.set(e.id, e);
  return e;
};
put(lud16Author, 0, JSON.stringify({ name: 'longlud16', display_name: 'Long Lud16', lud16: LUD16 }));
put(lud06Author, 0, JSON.stringify({ name: 'longlud06', display_name: 'Long Lud06', lud06: LUD06 }));
// A boost note each, so `/npub/<npub>` lists it under "sent".
const boostTags = [['t', 'boostagram'], ['amount', '100000']];
const lud16Note = put(lud16Author, 1, 'e2e boost note for the long lud16 zap', boostTags);
const lud06Note = put(lud06Author, 1, 'e2e boost note for the long lud06 zap', boostTags);

// ---- the stub LNURL server -----------------------------------------------------
const callbacks = [];
const proxyHits = [];
const ZAPPER = getPublicKey(generateSecretKey());
const payRequest = (name) => ({
  tag: 'payRequest', callback: `https://${STUB}/cb/${name}`, minSendable: 1000, maxSendable: 100_000_000_000,
  metadata: JSON.stringify([['text/plain', `${name} e2e`]]), commentAllowed: 200,
  allowsNostr: true, nostrPubkey: ZAPPER,
});

// ---- the browser ----------------------------------------------------------------
const { page } = await launchChrome({ name: `notezap-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`, args: ['--disable-gpu'] });
const { send, js } = page;
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/lnurl*', requestStage: 'Request' },
  { urlPattern: `https://${STUB}/*`, requestStage: 'Request' },
] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  let status = 200;
  let body;
  if (u.hostname === STUB) {
    if (u.pathname === `/.well-known/lnurlp/${LUD16_NAME}`) body = payRequest('lud16');
    else if (u.pathname === '/lnurlp/an-older-profile-with-only-a-lud06') body = payRequest('lud06');
    else if (u.pathname.startsWith('/cb/')) {
      callbacks.push(request.url);
      const sats = Number(u.searchParams.get('amount')) / 1000;
      body = { pr: `lnbc${sats * 10}n1pe2estubinvoice`, routes: [] };
    } else { status = 404; body = { status: 'ERROR', reason: 'no such stub' }; }
  } else {
    proxyHits.push(request.url);
    status = 502; body = { error: 'blocked by e2e' };
  }
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  });
});

// The signer: the viewer's key behind a NIP-07 `window.nostr`, signed in Node.
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = viewer.pk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], viewer.sk);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const waiting = new Map(); let n = 0;
    window.__bmbResolve = (rid, r) => { const p = waiting.get(rid); waiting.delete(rid); if (!p) return; r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      const rid = 'r' + (++n); waiting.set(rid, { resolve, reject });
      window.bmbSigner(JSON.stringify({ rid, fn, args }));
    });
    window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => call('signEvent', e) };
    // The stub wallet. It pays nothing: it records the invoice and hands back a
    // preimage, so the test ends at the invoice.
    window.__invoices = [];
    window.webln = {
      enable: async () => {}, getInfo: async () => ({ node: { alias: 'e2e stub' } }), getBalance: async () => ({ balance: 0 }),
      sendPayment: async (pr) => { window.__invoices.push(pr); return { preimage: 'ab'.repeat(32) }; },
    };
    // Every relay socket goes to the local relay. The dev server's own socket stays.
    const Real = window.WebSocket;
    function Redirected(url, protocols) {
      const u = String(url);
      const own = /^wss?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/_next\\//.test(u);
      const target = own ? u : ${JSON.stringify(LIVE)};
      return protocols === undefined ? new Real(target) : new Real(target, protocols);
    }
    Redirected.prototype = Real.prototype;
    Object.assign(Redirected, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Redirected;
  })();
` });

const t = checker();
const waitFor = async (expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(`!!(${expr})`)) return true; await wait(250); }
  return false;
};
const zapDialog = `[...document.querySelectorAll('[role=dialog]')].find((d) => (document.getElementById(d.getAttribute('aria-labelledby'))?.textContent ?? '').includes('Zap '))`;
const ZAP_ACTION = `document.querySelector('article button[aria-label=Zap]')`;

await send('Page.navigate', { url: APP });
await wait(800);
await js(`(() => {
  localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([LIVE]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(viewer.npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:fav_privacy:${viewer.npub}', 'off');
  return 1; })()`);

t.ok(`the lud16's LNURL is past bech32's 90-character default (${LUD16_LNURL.length})`, LUD16_LNURL.length > 90);
t.ok(`the lud06 is past it too (${LUD06.length})`, LUD06.length > 90);

const zapOnce = async (label, author, note, expectLnurl) => {
  console.log(`--- ${label} ---`);
  const before = callbacks.length;
  await send('Page.navigate', { url: `${APP}/npub/${author.npub}` });
  t.ok('the boost note shows, with ⚡ zap', await waitFor(ZAP_ACTION, 45000));
  t.ok('⚡ zap opens the dialog', (await js(`(() => { ${ZAP_ACTION}.click(); return 1; })()`)) && await waitFor(zapDialog, 8000));
  const sendBtn = `[...(${zapDialog}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Send 100 sats')`;
  t.ok('the dialog offers Send 100 sats', await waitFor(sendBtn, 8000), await js(`${zapDialog}?.innerText`));
  await js(`${sendBtn}?.click()`);
  const done = await waitFor(`!${zapDialog} || /zapped/.test(${zapDialog}.innerText) || ${zapDialog}.querySelector('.text-red-400')`, 15000);
  const error = await js(`${zapDialog}?.querySelector('.text-red-400')?.textContent ?? null`);
  t.ok('the zap reaches the invoice with no error', done && !error, error ?? 'timed out');
  t.equal('ONE invoice request to the stub LNURL server', callbacks.length - before, 1);
  const cb = new URL(callbacks[before] ?? `https://${STUB}/none`);
  const zr = JSON.parse(cb.searchParams.get('nostr') ?? '{}');
  const tag = (n) => (zr.tags ?? []).filter((x) => x[0] === n).map((x) => x[1]);
  t.equal('the request is a kind:9734', zr.kind, 9734);
  t.ok('signed by the viewer, and the signature verifies', zr.pubkey === viewer.pk && verifyEvent(zr), zr.pubkey);
  t.equal('the e tag is the note', tag('e'), [note.id]);
  t.equal('the p tag is its author', tag('p'), [author.pk]);
  t.equal('the amount tag', tag('amount'), ['100000']);
  t.equal('the lnurl tag is the long LNURL, in full', tag('lnurl'), [expectLnurl]);
  t.equal('the callback\'s lnurl parameter agrees', cb.searchParams.get('lnurl'), expectLnurl);
  // `window.__invoices` is per page, and each section navigates afresh.
  t.equal('the stub wallet got the invoice, once', await js('window.__invoices'), ['lnbc1000n1pe2estubinvoice']);
};

await zapOnce('1. an author with a long lud16', lud16Author, lud16Note, LUD16_LNURL);
await zapOnce('2. an author with only a long lud06 (upper case)', lud06Author, lud06Note, LUD06.toLowerCase());
console.log('--- 3. the server fallback ---');
t.equal('no request reached /api/lnurl', proxyHits.length, 0);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
relay.close();
await exit(t.fails ? 1 : 0);
