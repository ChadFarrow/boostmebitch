// End-to-end for WHAT A BOOST NOTE SAYS, through the real modal, against
// nothing but this machine.
//
// Usage:
//   npm run build && npx next start -p 3417      # in another terminal
//   APP_URL=http://127.0.0.1:3417 npm run e2e:notewording
//   add --headed to watch, --keep to leave the browser open
//
// THE REPORT. Chad, with a screenshot of rev.hodl's note b1d67bdd… (2026-11-16):
// "the info here for the track and playlist thats being boosted is a little
// confusing and hard to know whats happening". It read "rev.hodl boosted 121
// sats → ITDV music playlist / 📻 Sing For You": the arrow named the playlist,
// which was paid nothing, and nothing named The Doerfels, who were. His
// wording: "boosted 121 sats to Sing For You from the ITDV music playlist".
//
// WHY AN E2E. `boostSentence` and `itemFeedGuid` are pinned by check:vts and
// the builder by e2e:mentions. Neither sees the MODAL: that a playlist row's
// artist is looked up while the wallet pays and reaches the note, that a lookup
// which never answers costs the "by" words and not the note, and that BOOST
// ALL's hand-built body says the same thing in the same order.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but this one
// (`--host-resolver-rules`), the note goes to a relay on a free local port, the
// key is generated per run, and the wallet is a WebLN stand-in that records
// each keysend and moves nothing. `/api/item-value` is answered by the script
// with a one-recipient keysend block, so every leg is that stand-in. The SERVER
// still reads Podcast Index and the feeds (the playlist, the album, its
// `/api/remote-item` answer) — the guids below are real for that reason.
// Back-to-back runs can draw a Podcast Index 429; wait a few minutes.
//
// What it pins:
//   1. A playlist row: "to Sing For You by The Doerfels from ITDV music
//      playlist", and the row's own feed is the note's first show tag.
//   2. The artist lookup never answers: the note still posts, without "by".
//   3. An album track: "by The Doerfels from Disco Swag - The Album".
//   4. A podcast episode: "to Open Range from Two For Tunestr", no "by".
//   5. BOOST ALL, which only an episode with song splits offers: "boosted N
//      sats to M tracks from Two For Tunestr".
//   7. An album boost (the show's own BOOST): "to Disco Swag - The Album by
//      The Doerfels" — Chad's answer on the shared format, 2026-11-16.
// Every sentence ends "via <app>", the name the note's `client` tag carries
// (PC20-Nostr pc20-boost-notes.md rule 7), so this runs on either brand.
//   6. The playlist opened by a URL the index does not hold, so it has no guid:
//      the row's album is still the first show tag and the artist is still
//      named. The narrow rule tagged no feed and asked for no artist here.
//
// Every boost is 100 sats, the modal's minimum. The episode is Two For
// Tunestr's, as in e2e:boostnote, because every payee it names is a NODE: the
// WebLN stand-in pays a node with no network, while a Lightning address needs
// a lookup this sandbox refuses. The album's 5% Lightning-address leg fails
// here for that reason; its 95% node leg pays, which is all a note needs.
// `ONLY=1,3` runs those sections alone.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip04, nip19, nip44 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
// The URL Podcast Index holds for the ITDV playlist, so the page knows its guid
// — the path rev.hodl's note came by.
const PLAYLIST = 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/ITDV-music-playlist.xml';
// The same file by its `main` URL, which the index does not hold: `/api/playlist`
// answers a preview with NO guid, in production too (measured 2026-11-16).
const PLAYLIST_PREVIEW = 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/main/docs/ITDV-music-playlist.xml';
const ITDV = '88b0640a-489f-4920-be4f-00f85af5b2d4';
const ALBUM = 'b2a87a4c-86f0-5194-9eb3-dcba42ce0695'; // Disco Swag - The Album, The Doerfels
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr (medium podcast)
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range — song splits, node payees

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm run build && npx next start -p <port>\` and pass APP_URL.`);

const t = checker();
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
/** Prints the heading, and answers whether `ONLY` lets the section run. */
const section = (n, s) => {
  const on = !ONLY.length || ONLY.includes(String(n));
  if (on) console.log(`\n${n}. ${s}`);
  return on;
};

// ---- the relay, and what reaches it -----------------------------------------
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const published = [];
const PORT = await createRelay({ port: 0, log: null, onEvent: (e) => published.push(e) }).ready;
const RELAY = `ws://127.0.0.1:${PORT}`;
// `mintSummaryReceipt` keeps only `wss://` relays; one nothing can reach keeps
// the receipt path running without it landing anywhere.
const RELAYS = [RELAY, 'wss://relay.invalid'];
const notesSince = (mark) => published.slice(mark)
  .filter((e) => e.kind === 1 && e.pubkey === pk && e.content.startsWith('⚡ Boost ⚡'));
async function noteAfter(mark, ms = 20000) {
  for (let i = 0; i < ms / 250; i += 1) {
    const n = notesSince(mark);
    if (n.length) return n[0];
    await wait(250);
  }
  return null;
}

// ---- the browser --------------------------------------------------------------
const { page } = await launchChrome({
  name: 'boost-note-wording',
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
// `/api/remote-item` passes through unless `holdRemoteItem` is set; then it is
// held forever — a lookup that never answers.
let holdRemoteItem = false;
const remoteItemAsked = [];
await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/item-value*', requestStage: 'Request' },
  { urlPattern: '*/api/remote-item*', requestStage: 'Request' },
] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  if (request.url.includes('/api/remote-item')) {
    remoteItemAsked.push(request.url);
    if (holdRemoteItem) return;
    await send('Fetch.continueRequest', { requestId }).catch(() => {});
    return;
  }
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(ITEM_VALUE)).toString('base64'),
  }).catch(() => {});
});

await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__paid = [];
  window.webln = {
    enable: async () => {},
    isEnabled: async () => true,
    getInfo: async () => ({ node: { alias: 'e2e' }, methods: ['getInfo', 'getBalance', 'keysend'] }),
    getBalance: async () => ({ balance: 1000000 }),
    keysend: async (a) => {
      window.__paid.push({ at: Date.now(), amount: a.amount });
      await new Promise((r) => setTimeout(r, 300));
      return { preimage: '00'.repeat(32) };
    },
    sendPayment: async () => { throw new Error('e2e: keysend only'); },
    makeInvoice: async () => { throw new Error('e2e: keysend only'); },
  };
` });

// An extension signer (NIP-07) backed by the throwaway key, over a CDP binding.
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

// ---- helpers ----------------------------------------------------------------
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const buttonIn = (re) => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()))`;
const SEND = buttonIn(/^send \d+ sats?$/i);
const BOOST_ALL = buttonIn(/^boost \d+ tracks?$/i);
const SESSION = `localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify(RELAYS))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:rail_pref', 'webln');`;

/** A fresh signed-in store, then `url`, then wait for `ready`. */
async function open(url, ready) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { ${SESSION} return 1; })()`);
  await send('Page.navigate', { url });
  await until('document.readyState === "complete"');
  const ok = await until(ready, 60000);
  await until(`!!window.nostr && typeof window.nostr.signEvent === 'function'`, 20000);
  await wait(800);
  return ok;
}
// `textContent`, not `innerText`: a row out of view is skipped by layout, and
// its `innerText` is empty (the album's rows 12–18 read as '').
const ROW = (title) => `[...document.querySelectorAll('ul.divide-y > li')].find((r) => r.querySelector('button.btn-bolt') && [...r.querySelectorAll('*')].some((el) => !el.childElementCount && el.textContent.trim() === ${JSON.stringify(title)}))`;
async function pressRowBoost(title) {
  await js(`${ROW(title)}?.scrollIntoView({ block: 'center' })`);
  await wait(300);
  await js(`${ROW(title)}?.querySelector('button.btn-bolt')?.click()`);
  return until(`!!(${FIELD})`, 20000);
}
async function typeAmount(text) {
  await js(`(() => { const f = ${FIELD}; f.blur(); f.focus(); f.select(); return 1; })()`);
  await wait(50);
  await send('Input.insertText', { text });
  await wait(200);
}
async function pressSend(button = SEND) {
  await until(`!!(${button}) && !(${button}).disabled`, 20000);
  await js(`(${button}).click()`);
}
/** What the modal shows, and what the wallet paid — the detail of a missing note. */
const why = async () => `paid ${await js('window.__paid.length')}; dialog: ${String(await js(`${DIALOG}?.innerText ?? 'closed'`)).replace(/\s+/g, ' ').slice(-400)}`;
const iTags = (e) => (e?.tags ?? []).filter((x) => x[0] === 'i').map((x) => x[1]);
const sentenceOf = (e) => (e?.content ?? '').split('\n').find((l) => / boosted \d+ sats/.test(l)) ?? '';
/** ` via <the app the note's client tag names>` — what every sentence ends with. */
const via = (e) => ` via ${(e?.tags ?? []).find((x) => x[0] === 'client')?.[1] ?? '(no client tag)'}`;

const titled = (title) => `[...document.querySelectorAll('ul.divide-y > li')].filter((r) => r.innerText.includes(${JSON.stringify(title)})).map((r) => JSON.stringify(r.innerText.slice(0, 120))).join(' | ') || ('no row holds it; rows: ' + [...document.querySelectorAll('ul.divide-y > li')].map((r) => r.innerText.split('\\n').filter((l) => l.trim() && l.trim() !== '▶')[0]).join(' / '))`;

// ---------------------------------------------------------------------------
if (section(1, 'A playlist row names the track, its artist, then the playlist')) {
  t.ok('the ITDV playlist shows Sing For You',
    await open(`${APP}/?playlist=${encodeURIComponent(PLAYLIST)}`, `!!(${ROW('Sing For You')})`));
  t.ok('the boost modal opens on the row', await pressRowBoost('Sing For You'));
  await typeAmount('100');
  const mark = published.length;
  await pressSend();
  const note = await noteAfter(mark);
  t.ok('the note reaches the relay', !!note, note ? '' : await why());
  t.ok('...says "to Sing For You by The Doerfels from ITDV music playlist"',
    sentenceOf(note).endsWith('boosted 100 sats to Sing For You by The Doerfels from ITDV music playlist' + via(note)), sentenceOf(note));
  t.equal('the row\'s own feed is the first show tag', iTags(note)[0], `podcast:guid:${ALBUM}`);
  t.equal('then the item, then the playlist', iTags(note), [`podcast:guid:${ALBUM}`, 'podcast:item:guid:12711f57-2d41-4794-8cb9-154ecebb7cf7', `podcast:guid:${ITDV}`]);
  t.ok('the modal closes on its own', await until(`!${DIALOG}`, 8000));
}

// ---------------------------------------------------------------------------
if (section(2, 'An artist lookup that never answers costs the "by", not the note')) {
  t.ok('the ITDV playlist again',
    await open(`${APP}/?playlist=${encodeURIComponent(PLAYLIST)}`, `!!(${ROW('Sing For You')})`));
  t.ok('the boost modal opens on the row', await pressRowBoost('Sing For You'));
  await typeAmount('100');
  holdRemoteItem = true;
  const asked = remoteItemAsked.length;
  const mark = published.length;
  await pressSend();
  // The payment takes ~300 ms here; the lookup's cap is 2 s.
  const note = await noteAfter(mark, 10000);
  holdRemoteItem = false;
  t.ok('the lookup was asked', remoteItemAsked.length > asked, `${remoteItemAsked.length - asked} request(s)`);
  t.ok('the note still reaches the relay, within 10 s', !!note, note ? '' : await why());
  t.ok('...without the artist',
    sentenceOf(note).endsWith('boosted 100 sats to Sing For You from ITDV music playlist' + via(note)), sentenceOf(note));
}

// ---------------------------------------------------------------------------
if (section(3, 'An album track names the album\'s artist, then the album')) {
  t.ok('the album shows Sing For You', await open(`${APP}/?podcast=${ALBUM}`, `!!(${ROW('Sing For You')})`),
    String(await js(titled('Sing For You'))));
  t.ok('the boost modal opens on the row', await pressRowBoost('Sing For You'));
  await typeAmount('100');
  const mark = published.length;
  await pressSend();
  const note = await noteAfter(mark, 30000);
  t.ok('the note reaches the relay', !!note, note ? '' : await why());
  t.ok('...says "to Sing For You by The Doerfels from Disco Swag - The Album"',
    sentenceOf(note).endsWith('boosted 100 sats to Sing For You by The Doerfels from Disco Swag - The Album' + via(note)), sentenceOf(note));
  t.equal('the album is the only show tag', iTags(note).filter((x) => x.startsWith('podcast:guid:')), [`podcast:guid:${ALBUM}`]);
}

// ---------------------------------------------------------------------------
const EPISODE = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
const BOOST_EPISODE = `document.querySelector('button[aria-label="Boost this episode"]')`;
if (section(4, 'A podcast episode: the episode, then the show, never "by"')) {
  t.ok('the episode page opens', await open(EPISODE, `!!${BOOST_EPISODE}`));
  await js(`${BOOST_EPISODE}?.click()`);
  t.ok('the boost modal opens', await until(`!!(${FIELD})`, 20000));
  await typeAmount('100');
  const mark = published.length;
  await pressSend();
  const note = await noteAfter(mark);
  t.ok('the note reaches the relay', !!note, note ? '' : await why());
  t.ok('...says "to Open Range from Two For Tunestr", with no "by"',
    sentenceOf(note).endsWith('boosted 100 sats to Open Range from Two For Tunestr' + via(note)), sentenceOf(note));
}

// ---------------------------------------------------------------------------
if (section(5, 'BOOST ALL says what, then where')) {
  t.ok('the episode page opens', await open(EPISODE, `!!${BOOST_EPISODE}`));
  await js(`document.querySelector('button[aria-label="More actions"]')?.click()`);
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => /boost all \\d+ tracks/i.test(b.textContent))`, 10000);
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => /boost all \\d+ tracks/i.test(b.textContent))?.click()`);
  t.ok('the boost-all modal opens', await until(`!!(${FIELD})`, 20000));
  await typeAmount('100');
  const mark = published.length;
  await pressSend(BOOST_ALL);
  const note = await noteAfter(mark, 90000);
  const m = sentenceOf(note).endsWith(via(note))
    && sentenceOf(note).slice(0, -via(note).length).match(/ boosted (\d+) sats to (\d+) tracks? from Two For Tunestr( \(.+ each\))?$/);
  t.ok('the note reaches the relay', !!note, note ? '' : await why());
  t.ok('...says "boosted N sats to M tracks from Two For Tunestr[ (N each)] via <app>"', !!m, sentenceOf(note));
  t.ok('...and N is 100 × M', !!m && Number(m[1]) === 100 * Number(m[2]), sentenceOf(note));
}

// ---------------------------------------------------------------------------
if (section(6, 'A playlist with no guid of its own still names the row\'s album and artist')) {
  t.ok('the ITDV playlist by its other URL shows Sing For You',
    await open(`${APP}/?playlist=${encodeURIComponent(PLAYLIST_PREVIEW)}`, `!!(${ROW('Sing For You')})`));
  t.ok('the boost modal opens on the row', await pressRowBoost('Sing For You'));
  await typeAmount('100');
  const asked = remoteItemAsked.length;
  const mark = published.length;
  await pressSend();
  const note = await noteAfter(mark);
  t.ok('the note reaches the relay', !!note, note ? '' : await why());
  t.ok('the artist was looked up', remoteItemAsked.length > asked, `${remoteItemAsked.length - asked} request(s)`);
  t.ok('...says "to Sing For You by The Doerfels from ITDV music playlist"',
    sentenceOf(note).endsWith('boosted 100 sats to Sing For You by The Doerfels from ITDV music playlist' + via(note)), sentenceOf(note));
  t.equal('the album, then the item — no playlist guid to add', iTags(note),
    [`podcast:guid:${ALBUM}`, 'podcast:item:guid:12711f57-2d41-4794-8cb9-154ecebb7cf7']);
}

// ---------------------------------------------------------------------------
const BOOST_SHOW = `document.querySelector('button[title="Boost the show"]')`;
if (section(7, 'An album boost names the album, then its artist')) {
  t.ok('the album page offers BOOST', await open(`${APP}/?podcast=${ALBUM}`, `!!(${BOOST_SHOW})`),
    String(await js(`document.title`)));
  await js(`(${BOOST_SHOW}).click()`);
  t.ok('the boost modal opens', await until(`!!(${FIELD})`, 20000));
  await typeAmount('100');
  const mark = published.length;
  await pressSend();
  const note = await noteAfter(mark, 30000);
  t.ok('the note reaches the relay', !!note, note ? '' : await why());
  t.ok('...says "to Disco Swag - The Album by The Doerfels via <app>"',
    sentenceOf(note).endsWith('boosted 100 sats to Disco Swag - The Album by The Doerfels' + via(note)), sentenceOf(note));
  t.equal('the album is the only i tag', iTags(note), [`podcast:guid:${ALBUM}`]);
}

// ---------------------------------------------------------------------------
console.log('\nPage health');
t.equal('no page exceptions', exceptions, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
