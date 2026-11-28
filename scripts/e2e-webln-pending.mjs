// End-to-end for A WEBLN PAYMENT THAT IS STILL PENDING: the single BOOST panel,
// on the WebLN rail, against a stand-in provider that rejects the way Libre does
// when a payment was SENT and has not settled — the embed's `PaymentTimeoutError`
// (`code: 'PAYMENT_TIMEOUT'`) and the extension's `[SETTLEMENT_PENDING]` text.
// Reasoning: docs/money-boosts.md, "A WebLN payment that is still pending".
//
// Usage:
//   npm run build && npx next start -p 3418 -H 127.0.0.1
//   APP_URL=http://127.0.0.1:3418 npm run e2e:weblnpending
// `--headed` to watch, `--keep` to leave it open.
//
// NOTHING LEAVES THE MACHINE, AND NOTHING IS PAID OR PUBLISHED. Chrome resolves
// no host but this one (`--host-resolver-rules`). Nobody is signed in and the
// share picker is "Don't post" (`bmb:share_nostr` = '0'), so no note, no stamp
// and no summary receipt is asked for. WebLN is a stand-in in the page. The
// keysend well-knowns, the LNURL payees and BoostBox are answered by CDP
// interception. The SERVER still reads Podcast Index and the feed for Two For
// Tunestr's "Open Range", whose value block is replaced with the one below.
//
// What it pins, first boost (biggest share first):
//   Nova    node      keysend resolves                      → ✓
//   Oscar   node      keysend: never left the node          → ✗ (a real failure stays one)
//   Papa    lnaddress keysend target; keysend [SETTLEMENT_PENDING] → ?  — no LNURL retry
//   Quebec  lnaddress no keysend target; LNURL; sendPayment PaymentTimeoutError → ?
//   Romeo   lnaddress keysend target; keysend NO_ROUTE → LNURL retry (arm two still
//                     works) → sendPayment PaymentTimeoutError → ?  (the wrapper keeps it)
//   The panel says "3 unconfirmed", stays open, offers no CHECK and no RETRY for
//   them; no payment is made twice; the log stores the three legs as indeterminate.
// Second boost, same page: Papa is NOT demoted (its keysend is tried again, no
// LNURL invoice is asked of it).

import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { fakeBolt11 } from './fake-bolt11.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3418';
await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start it as the header says.`);

const t = checker();
const section = (s) => console.log(`\n--- ${s} ---`);

const { page } = await launchChrome({
  name: 'webln-pending',
  args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, js, until } = page;
const exceptions = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300));
  }
  if (process.env.DEBUG && m.method === 'Runtime.consoleAPICalled') {
    console.log(`  [page] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
  }
});
await send('Page.enable');
await send('Runtime.enable');

const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range
const EPISODE = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
const node = () => `02${getPublicKey(generateSecretKey())}`;
const LN = 'ln.e2e.invalid';
const N = { nova: node(), oscar: node() };
const KS = { papa: node(), romeo: node() }; // the keysend targets two addresses publish
const value = {
  read: true,
  value: {
    type: 'lightning', method: 'keysend', suggested: '0.00000005000',
    recipients: [
      { name: 'Nova', type: 'node', address: N.nova, split: 40 },
      { name: 'Oscar', type: 'node', address: N.oscar, split: 20 },
      { name: 'Papa', type: 'lnaddress', address: `papa@${LN}`, split: 15 },
      { name: 'Quebec', type: 'lnaddress', address: `quebec@${LN}`, split: 15 },
      { name: 'Romeo', type: 'lnaddress', address: `romeo@${LN}`, split: 10 },
    ],
  },
  valueTimeSplits: [],
};

// Every LNURL invoice the page asks for, by payee name.
const invoiceAsks = [];
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/feed*', requestStage: 'Response' },
  { urlPattern: '*/api/item-value*', requestStage: 'Request' },
  { urlPattern: '*/api/lightning/boostbox*', requestStage: 'Request' },
  { urlPattern: '*/api/keysend*', requestStage: 'Request' },
  { urlPattern: '*/api/lnurl*', requestStage: 'Request' },
  { urlPattern: `https://${LN}/*`, requestStage: 'Request' },
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
    const raw = await send('Fetch.getResponseBody', { requestId }).catch(() => null);
    let feed = null;
    try {
      const text = raw?.result?.base64Encoded ? Buffer.from(raw.result.body, 'base64').toString() : raw?.result?.body;
      feed = JSON.parse(text);
    } catch { /* not JSON: pass it on */ }
    if (!feed?.podcast || !Array.isArray(feed.episodes) || m.params.responseStatusCode !== 200) {
      return send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
    feed.podcast.value = value.value;
    for (const ep of feed.episodes) { ep.value = value.value; ep.valueTimeSplits = []; }
    return fulfill(requestId, 200, feed);
  }
  if (url.pathname.startsWith('/api/item-value')) return fulfill(requestId, 200, value);
  if (url.pathname.startsWith('/api/lightning/boostbox')) return fulfill(requestId, 503, { error: 'e2e: no BoostBox' });
  if (url.pathname.startsWith('/api/keysend')) {
    const name = (url.searchParams.get('addr') ?? '').split('@')[0];
    return KS[name]
      ? fulfill(requestId, 200, { status: 'OK', tag: 'keysend', pubkey: KS[name], customData: [] })
      : fulfill(requestId, 404, { error: 'e2e: none' });
  }
  // The server-side LNURL fallback would leave the machine: refuse it.
  if (url.pathname.startsWith('/api/lnurl')) return fulfill(requestId, 502, { error: 'e2e: no proxy' });
  if (url.host === LN && url.pathname.startsWith('/.well-known/lnurlp/')) {
    const name = url.pathname.split('/').pop();
    return fulfill(requestId, 200, {
      status: 'OK', tag: 'payRequest', callback: `https://${LN}/cb/${name}`,
      minSendable: 1000, maxSendable: 1_000_000_000, metadata: JSON.stringify([['text/plain', `e2e ${name}`]]), commentAllowed: 255,
    });
  }
  if (url.host === LN && url.pathname.startsWith('/cb/')) {
    const name = url.pathname.split('/').pop();
    invoiceAsks.push(name);
    const amountMsat = Number(url.searchParams.get('amount'));
    const hash = Buffer.from(`e2e-${name}-${invoiceAsks.length}`.padEnd(32, '.')).toString('hex').slice(0, 64);
    return fulfill(requestId, 200, { status: 'OK', routes: [], pr: fakeBolt11({ amountMsat, fields: [
      { tag: 's', hex: '22'.repeat(32) }, { tag: 'p', hex: hash }, { tag: 'd', text: `e2e ${name}` },
    ] }) });
  }
  return fulfill(requestId, 404, { status: 'ERROR', reason: 'e2e: not here' });
});

// The WebLN stand-in. `__plan.keysend[pubkey]` and `__plan.invoice` choose each
// answer; every call is recorded. The two pending shapes are Libre's own, copied
// from the upstream source (see the vectors in scripts/check-nwcerror.mjs).
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    window.__calls = [];
    window.__plan = { keysend: {}, invoice: 'ok' };
    const embedTimeout = () => {
      const e = new Error('[PAYMENT_TIMEOUT] Payment is still in flight \\u2014 it was sent but has not settled yet. Check the payment history before retrying.');
      e.name = 'PaymentTimeoutError';
      e.code = 'PAYMENT_TIMEOUT';
      return e;
    };
    const answer = (how) => {
      if (how === 'ok') return Promise.resolve({ preimage: '11'.repeat(32) });
      if (how === 'ext-pending') return Promise.reject(new Error('Payment initiated but not yet settled; it may still complete. [SETTLEMENT_PENDING]'));
      if (how === 'embed-pending') return Promise.reject(embedTimeout());
      if (how === 'no-route') return Promise.reject(new Error('400: FAILURE_REASON_NO_ROUTE'));
      return Promise.reject(new Error('Keysend failed: Payment failed to initiate: RouteNotFound'));
    };
    window.webln = {
      enable: async () => {},
      isEnabled: async () => true,
      getInfo: async () => ({ node: { alias: 'e2e' }, methods: ['getInfo', 'keysend', 'sendPayment'] }),
      keysend: (a) => { window.__calls.push({ m: 'keysend', to: a.destination, sats: a.amount }); return answer(window.__plan.keysend[a.destination] ?? 'fail'); },
      sendPayment: (pr) => { window.__calls.push({ m: 'sendPayment', pr }); return answer(window.__plan.invoice); },
      makeInvoice: async () => { throw new Error('e2e: no invoices'); },
    };
  })();
` });

const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const buttonIn = (re) => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()))`;
const SEND = buttonIn(/^send \d+ sats?$/i);
const BOOST_EPISODE = `document.querySelector('button[aria-label="Boost this episode"]')`;
const dialogText = async () => String(await js(`${DIALOG}?.innerText ?? ''`));
const calls = async () => (await js('window.__calls')) ?? [];
const keysendsTo = async (pk) => (await calls()).filter((c) => c.m === 'keysend' && c.to === pk).length;
const invoicesPaid = async () => (await calls()).filter((c) => c.m === 'sendPayment').length;
const storedBoosts = async () => JSON.parse(String(await js(`localStorage.getItem('bmb:boosts:guest') ?? '[]'`)));
/** The glyph each recipient row shows (<SplitsPreview>: name first, glyph last). */
const glyphs = () => js(`(() => {
  const rows = [...(${DIALOG}?.querySelectorAll('li.justify-between') ?? [])];
  const out = {};
  for (const name of ['Nova', 'Oscar', 'Papa', 'Quebec', 'Romeo']) {
    const row = rows.find((li) => (li.firstElementChild?.textContent ?? '').includes(name));
    out[name] = row?.lastElementChild?.firstElementChild?.textContent?.trim()?.[0] ?? null;
  }
  return out;
})()`);

async function openBoost() {
  if (!(await js(`!!${BOOST_EPISODE}`))) {
    await send('Page.navigate', { url: EPISODE });
    await until('document.readyState === "complete"', 20000);
    if (!(await until(`!!${BOOST_EPISODE}`, 60000))) return false;
    await wait(800);
  }
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
const finished = () => until(`!(${SEND}) && !document.querySelector('[data-keep-open]') && /Lightning: \\d+\\/\\d+ sent/.test(${DIALOG}?.innerText ?? '')`, 60000);

await send('Page.navigate', { url: `${APP}/privacy` });
await until('document.readyState === "complete"', 20000);
await js(`(() => {
  localStorage.clear();
  localStorage.setItem('bmb:share_nostr', '0');
  localStorage.setItem('bmb:rail_pref', 'webln');
  return 1;
})()`);

// =============================================================================
section('1. Libre says "sent, not settled": ?, never ✗, and never paid twice');
// Load the episode FIRST: the stand-in is re-created on every new document, so
// a plan set before a navigation is lost.
await send('Page.navigate', { url: EPISODE });
await until('document.readyState === "complete"', 20000);
t.ok('the episode page shows its BOOST button', !!(await until(`!!${BOOST_EPISODE}`, 60000)));
await wait(800);
await js(`(() => { window.__plan.keysend = ${JSON.stringify({ [N.nova]: 'ok', [N.oscar]: 'fail', [KS.papa]: 'ext-pending', [KS.romeo]: 'no-route' })}; window.__plan.invoice = 'embed-pending'; return 1; })()`);
t.ok('the boost panel opens on the WebLN rail', await openBoost());
t.ok('SEND is pressed', await pressSend());
t.ok('the boost finishes', !!(await finished()), await dialogText());
const g = await glyphs();
t.equal('Nova ✓, Oscar ✗, Papa ?, Quebec ?, Romeo ?', g, { Nova: '✓', Oscar: '✗', Papa: '?', Quebec: '?', Romeo: '?' });
const text = await dialogText();
t.ok('"Lightning: 1/5 sent"', /Lightning: 1\/5 sent/.test(text), text);
t.ok('"3 unconfirmed", with the look-before-you-boost line', /3 unconfirmed/.test(text) && /check your wallet before boosting again/i.test(text), text);
t.equal('one keysend each to Nova, Oscar and the two published targets', [
  await keysendsTo(N.nova), await keysendsTo(N.oscar), await keysendsTo(KS.papa), await keysendsTo(KS.romeo),
], [1, 1, 1, 1]);
t.equal('LNURL invoices were asked of Quebec and Romeo only — Papa\'s pending keysend is not retried', [...invoiceAsks].sort(), ['quebec', 'romeo']);
t.equal('two invoices were handed to the wallet, once each', await invoicesPaid(), 2);
t.equal('each unconfirmed line is plain: nothing to ask, nothing to retry',
  await js(`[...document.querySelectorAll('[data-unconfirmed-legs] li')].map((li) => li.dataset.legState)`), ['plain', 'plain', 'plain']);
t.ok('...no RETRY or CHECK AGAIN control anywhere in the panel',
  (await js(`!document.querySelector('[data-leg-retry], [data-leg-check]')`)) === true);
const retryUnsent = /Retry (\d+) unsent/i.exec(text);
t.ok('"Retry N unsent" does not count the three ? legs', !retryUnsent || Number(retryUnsent[1]) <= 1, retryUnsent?.[0] ?? 'no retry button');
const legs = (await storedBoosts())[0]?.legs ?? [];
const legOf = (needle) => legs.find((l) => String(l.recipient).includes(needle));
t.equal('the log stores Papa, Quebec and Romeo as indeterminate, Oscar as a plain failure', [
  legOf('papa')?.indeterminate, legOf('quebec')?.indeterminate, legOf('romeo')?.indeterminate, legOf(N.oscar)?.indeterminate ?? false, legOf(N.nova)?.ok,
], [true, true, true, false, true]);
t.ok('the panel stays open while a leg is ?', (await js(`!!${DIALOG}`)) === true);
const callsBefore = (await calls()).length;
await wait(20_000);
t.equal('20 s later the wallet was asked nothing more', (await calls()).length, callsBefore);

// =============================================================================
section('2. A second boost: the pending address was NOT demoted');
await js(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => /^(close|done)$/i.test(x.textContent.trim()) || x.getAttribute('aria-label') === 'Close'); b?.click(); return !!b; })()`);
t.ok('the panel closes', !!(await until(`!${DIALOG}`, 10000)));
await js(`(() => { for (const k of Object.keys(window.__plan.keysend)) window.__plan.keysend[k] = 'ok'; window.__plan.invoice = 'ok'; return 1; })()`);
const asksBefore = invoiceAsks.length;
t.ok('the boost panel opens again', await openBoost());
t.ok('SEND is pressed', await pressSend());
t.ok('the boost finishes', !!(await finished()), await dialogText());
t.equal('Papa\'s keysend target was tried again (two keysends in all)', await keysendsTo(KS.papa), 2);
t.equal('...and no LNURL invoice was asked of Papa', invoiceAsks.slice(asksBefore).filter((n) => n === 'papa'), []);
t.ok('"Lightning: 5/5 sent"', /Lightning: 5\/5 sent/.test(await dialogText()), await dialogText());

t.equal('no uncaught exception in the page', exceptions, []);
console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
