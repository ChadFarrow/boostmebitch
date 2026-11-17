// End-to-end for WHAT `value_msat_total` SAYS on every leg, read from the TLV
// record the app hands the wallet. No payment leaves this machine.
//
// Usage:
//   npm run build && npx next start -p 3431      # in another terminal
//   APP_URL=http://127.0.0.1:3431 npm run e2e:valuetotal
//   add --headed to watch, --keep to leave the browser open; `ONLY=2,3` runs
//   those sections alone
//
// THE RULE (docs/money-boosts.md, redirect invariant 8). bLIP-10 defines
// `value_msat_total` as "TOTAL … all splits together, before fees. The actual
// number someone entered in their player". So every leg of a boost carries the
// amount the listener TYPED — the artist's legs AND the show's legs of a
// valueTimeSplit redirect, and each track's two groups in BOOST ALL (where the
// listener types an amount PER TRACK). What each payee received is `value_msat`.
// #403 had each group carry its own share instead; this pins the reversal.
//
// WHY AN E2E. The two groups' boostagrams are built inside the two modals, not
// by a pure function a `check:*` could import, and the reversal is invisible
// everywhere but the wire: the note, its `amount` tag and the boost history
// always carried the typed amount.
//
// NOTHING LEAVES THE MACHINE. Chrome resolves no host but this one
// (`--host-resolver-rules`). The wallet is a WebLN stand-in that records each
// keysend and moves nothing. The enclosure is answered with silent audio, so
// the player can sit inside a song window. "Don't post" is set, and every
// `/api/nostr/*` request is refused and counted. `/api/keysend`, `/api/lnurl`
// and `/api/lightning/boostbox` are answered here, so the server's proxies
// never reach a provider or BoostBox. The SERVER still reads Podcast Index and
// the feeds for Two For Tunestr's "Open Range": every payee in it is a node,
// its first song window runs 33–353 s, and the show keeps 10% of a track boost
// (`remotePercentage="90"`). Back-to-back runs can draw a Podcast Index 429.
//
// What it pins (every boost is 100 sats, the modal's minimum):
//   1. A plain episode boost: every leg says 100000, one group, 100 sats paid.
//   2. BOOST pressed inside a song window: two groups (track, show) under two
//      uuids, both naming the track in remote_*; EVERY leg says 100000, never
//      90000 or 10000; the groups paid 90 + 10.
//   3. BOOST ALL at 100 per track: every leg of every track says 100000, never
//      a share and never the album total; each track's groups paid 100.
//   4. The show's block names a Lightning address: its BoostBox record (the
//      metadata an LNURL leg carries) says 100000 too, while its own leg is 1.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const SHOW = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a'; // Two For Tunestr
const ITEM = 'f7cb78c5-c90b-4ace-a6a3-4b6ef01f9d9b'; // Open Range
const FIRST_TRACK_FEED = '93007b6c-2093-5ddb-9b5f-7226c93d67e0'; // the 33–353 s window's remote feed
const INSIDE_FIRST_WINDOW = 45;
const TYPED_MSAT = 100 * 1000;
const LNADDR = 'e2e@pay.example.invalid';

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm run build && npx next start -p <port>\` and pass APP_URL.`);

const t = checker();
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const section = (n, s) => {
  const on = !ONLY.length || ONLY.includes(String(n));
  if (on) console.log(`\n${n}. ${s}`);
  return on;
};

// A 60 s silent WAV: long enough to sit inside the first song window.
function silentWav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const AUDIO = silentWav(60);

// ---- the browser --------------------------------------------------------------
const { page } = await launchChrome({
  name: 'value-msat-total',
  autoplay: true,
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
await send('Network.enable');
// A cached /api/feed would skip section 4's rewrite; a service worker would
// fetch the enclosure outside this page's interception.
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.setBypassServiceWorker', { bypass: true });

// ---- the wire this script answers ---------------------------------------------
const nostrAsked = [];
const boostbox = [];
let addLnaddrToShow = false;
const feedRewrites = [];
const json = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const PATTERNS = [
  { resourceType: 'Media', requestStage: 'Request' },
  { urlPattern: '*/api/nostr/*', requestStage: 'Request' },
  { urlPattern: '*/api/keysend*', requestStage: 'Request' },
  { urlPattern: '*/api/lnurl*', requestStage: 'Request' },
  { urlPattern: '*/api/lightning/boostbox*', requestStage: 'Request' },
  { urlPattern: '*/api/feed*', requestStage: 'Response' },
];
await send('Fetch.enable', { patterns: PATTERNS });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request, responseStatusCode, resourceType, networkId } = m.params;
  const u = new URL(request.url);
  if (process.env.DEBUG) console.log('  [paused]', responseStatusCode ?? '-', resourceType, request.url.slice(0, 140));
  const fulfill = (code, body, type = 'application/json') => send('Fetch.fulfillRequest', {
    requestId, responseCode: code, responseHeaders: [{ name: 'content-type', value: type }], body,
  }).catch(() => {});
  try {
    if (responseStatusCode !== undefined) {
      // /api/feed, at the response: section 4 adds a Lightning address to the
      // episode's own (the show's) block. Everything else passes untouched.
      if (!addLnaddrToShow || responseStatusCode !== 200) {
        await send('Fetch.continueRequest', { requestId }).catch(() => {});
        return;
      }
      const { body, base64Encoded } = (await send('Fetch.getResponseBody', { requestId })).result ?? {};
      const data = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
      for (const e of data.episodes ?? []) {
        if (e.guid === ITEM && e.value?.recipients) {
          e.value.recipients = [...e.value.recipients, { name: 'e2e lnaddress', type: 'lnaddress', address: LNADDR, split: 10 }];
          feedRewrites.push(u.search);
        }
      }
      await fulfill(200, json(data));
      return;
    }
    if (resourceType === 'Media') {
      const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
      const mm = range && /bytes=(\d+)-(\d*)/.exec(range);
      const start = mm ? Number(mm[1]) : 0;
      const end = mm && mm[2] ? Math.min(Number(mm[2]), AUDIO.length - 1) : AUDIO.length - 1;
      const part = AUDIO.subarray(start, end + 1);
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: mm ? 206 : 200,
        responseHeaders: [
          { name: 'content-type', value: 'audio/wav' },
          { name: 'accept-ranges', value: 'bytes' },
          { name: 'content-length', value: String(part.length) },
          ...(mm ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
        ],
        body: part.toString('base64'),
      }).catch(() => {});
      return;
    }
    if (u.pathname.startsWith('/api/nostr/')) {
      nostrAsked.push(u.pathname);
      await fulfill(403, json({ error: 'e2e: no nostr' }));
      return;
    }
    if (u.pathname === '/api/keysend') { await fulfill(404, json({ error: 'e2e: lnurl only' })); return; }
    if (u.pathname === '/api/lnurl') { await fulfill(502, json({ error: 'e2e: no lnurl' })); return; }
    if (u.pathname === '/api/lightning/boostbox') {
      let post = request.postData;
      if (!post && request.hasPostData) {
        post = (await send('Network.getRequestPostData', { requestId: networkId }).catch(() => ({})))?.result?.postData;
      }
      boostbox.push(post ? JSON.parse(post) : null);
      await fulfill(503, json({ error: 'e2e: nothing stored' }));
      return;
    }
    await send('Fetch.continueRequest', { requestId }).catch(() => {});
  } catch (e) {
    if (process.env.DEBUG) console.log('  [error]', String(e?.message ?? e).slice(0, 200));
    // The page navigated away under a paused request.
    await send('Fetch.continueRequest', { requestId }).catch(() => {});
  }
});

// The wallet: records every keysend and its TLV 7629169, pays nothing.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__legs = [];
  window.webln = {
    enable: async () => {},
    isEnabled: async () => true,
    getInfo: async () => ({ node: { alias: 'e2e' }, methods: ['getInfo', 'getBalance', 'keysend'] }),
    getBalance: async () => ({ balance: 1000000 }),
    keysend: async (a) => {
      window.__legs.push({ destination: a.destination, amount: Number(a.amount), tlv: (a.customRecords || {})['7629169'] ?? null });
      await new Promise((r) => setTimeout(r, 40));
      return { preimage: '00'.repeat(32) };
    },
    sendPayment: async () => { throw new Error('e2e: keysend only'); },
    makeInvoice: async () => { throw new Error('e2e: keysend only'); },
  };
` });

// ---- helpers ----------------------------------------------------------------
const EPISODE = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const buttonIn = (re) => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()))`;
const SEND = buttonIn(/^send \d+ sats?$/i);
const BOOST_ALL = buttonIn(/^boost \d+ tracks?$/i);
const BOOST_EPISODE = `document.querySelector('button[aria-label="Boost this episode"]')`;
const PLAY = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '▶ PLAY')`;

async function open() {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { localStorage.clear();
    localStorage.setItem('bmb:rail_pref', 'webln');
    localStorage.setItem('bmb:share_nostr', '0'); return 1; })()`);
  await send('Page.navigate', { url: EPISODE });
  await until('document.readyState === "complete"');
  const ok = await until(`!!${BOOST_EPISODE}`, 60000);
  await wait(800);
  return ok;
}
async function typeAmount(text) {
  await js(`(() => { const f = ${FIELD}; f.blur(); f.focus(); f.select(); return 1; })()`);
  await wait(50);
  await send('Input.insertText', { text });
  await wait(200);
}
async function pressSend(button) {
  const ready = await until(`!!(${button}) && !(${button}).disabled`, 30000);
  if (ready) await js(`(${button}).click()`);
  return !!ready;
}
/** The legs recorded since `mark`, once no new one has arrived for 3 s. */
async function legsAfter(mark, ms = 60000) {
  const end = Date.now() + ms;
  let last = -1;
  let still = 0;
  while (Date.now() < end) {
    const n = await js('window.__legs.length');
    if (n > mark && n === last) still += 1; else still = 0;
    if (still >= 12) break;
    last = n;
    await wait(250);
  }
  const all = JSON.parse(await js('JSON.stringify(window.__legs)'));
  return all.slice(mark).map((l) => ({ ...l, b: l.tlv ? JSON.parse(l.tlv) : null }));
}
const groupsOf = (legs) => {
  const g = new Map();
  for (const l of legs) g.set(l.b?.uuid, [...(g.get(l.b?.uuid) ?? []), l]);
  return [...g.values()];
};
const sumMsat = (legs) => legs.reduce((s, l) => s + (l.b?.value_msat ?? 0), 0);
const totals = (legs) => [...new Set(legs.map((l) => l.b?.value_msat_total))];
const why = async () => `legs ${await js('window.__legs.length')}; dialog: ${String(await js(`${DIALOG}?.innerText ?? 'closed'`)).replace(/\s+/g, ' ').slice(-300)}`;

// ---------------------------------------------------------------------------
if (section(1, 'A plain episode boost: every leg says the typed amount')) {
  t.ok('the episode page opens', await open());
  await js(`${BOOST_EPISODE}.click()`);
  t.ok('the boost modal opens', await until(`!!(${FIELD})`, 20000));
  await typeAmount('100');
  const mark = await js('window.__legs.length');
  t.ok('SEND is pressable', await pressSend(SEND), await why());
  const legs = await legsAfter(mark);
  t.ok('the wallet was asked for at least one keysend', legs.length > 0, await why());
  t.ok('every leg carries a TLV 7629169 record', legs.every((l) => l.b), JSON.stringify(legs.map((l) => l.tlv)));
  t.equal('every leg says value_msat_total 100000', totals(legs), [TYPED_MSAT]);
  t.equal('one group (one uuid)', groupsOf(legs).length, 1);
  t.equal('the legs paid 100 sats', sumMsat(legs), TYPED_MSAT);
  t.ok('each leg\'s keysend amount is its value_msat', legs.every((l) => l.amount * 1000 === l.b.value_msat));
}

// ---------------------------------------------------------------------------
/** Plays the episode and parks the player inside the first song window. */
async function parkInFirstWindow() {
  await until(`!!(${PLAY})`, 20000);
  await js(`(${PLAY}).click()`);
  const loaded = await until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && a.duration > ${INSIDE_FIRST_WINDOW}; })()`, 30000);
  await js(`(() => { const a = document.querySelector('audio'); a.currentTime = ${INSIDE_FIRST_WINDOW}; return 1; })()`);
  await wait(1500);
  await js(`(() => { const a = document.querySelector('audio'); a.pause(); return 1; })()`);
  await wait(800);
  return { loaded: !!loaded, at: await js(`Math.round(document.querySelector('audio')?.currentTime ?? -1)`) };
}

if (section(2, 'BOOST inside a song window: the track and the show both say the typed amount')) {
  t.ok('the episode page opens', await open());
  const parked = await parkInFirstWindow();
  t.ok('the silent enclosure loaded', parked.loaded);
  t.ok('the player sits inside the first song window (33–353 s)', parked.at >= 33 && parked.at < 353, `at ${parked.at} s`);
  await js(`${BOOST_EPISODE}.click()`);
  t.ok('the boost modal opens', await until(`!!(${FIELD})`, 20000));
  await typeAmount('100');
  const mark = await js('window.__legs.length');
  t.ok('SEND is pressable once the track resolves', await pressSend(SEND), await why());
  const legs = await legsAfter(mark);
  const groups = groupsOf(legs);
  t.equal('two groups, under two uuids (the track, then the show)', groups.length, 2);
  t.equal('EVERY leg says value_msat_total 100000 — never 90000 or 10000', totals(legs), [TYPED_MSAT]);
  t.equal('the groups paid 90 + 10 sats', groups.map(sumMsat), [90000, 10000]);
  t.equal('both groups name the track\'s feed in remote_feed_guid',
    [...new Set(legs.map((l) => l.b?.remote_feed_guid))], [FIRST_TRACK_FEED]);
  const items = [...new Set(legs.map((l) => l.b?.remote_item_guid))];
  t.ok('both groups name the same track item in remote_item_guid', items.length === 1 && typeof items[0] === 'string' && items[0].length > 0, JSON.stringify(items));
  t.ok('each leg\'s keysend amount is its value_msat', legs.every((l) => l.amount * 1000 === l.b?.value_msat));
}

// ---------------------------------------------------------------------------
if (section(3, 'BOOST ALL: every leg of every track says the per-track amount')) {
  t.ok('the episode page opens', await open());
  await js(`document.querySelector('button[aria-label="More actions"]')?.click()`);
  await until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => /boost all \\d+ tracks/i.test(b.textContent))`, 20000);
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => /boost all \\d+ tracks/i.test(b.textContent))?.click()`);
  t.ok('the boost-all modal opens', await until(`!!(${FIELD})`, 20000));
  await typeAmount('100');
  await until(`(() => { const b = ${BOOST_ALL}; return !!b && /boost [1-9]\\d* tracks?/i.test(b.textContent); })()`, 90000);
  const label = await js(`(${BOOST_ALL})?.textContent.trim() ?? ''`);
  const tracks = Number(/(\d+)/.exec(String(label))?.[1] ?? 0);
  t.ok('the tracks resolved', tracks > 0, String(label));
  const mark = await js('window.__legs.length');
  const boxMark = boostbox.length;
  t.ok(`${label} is pressable`, await pressSend(BOOST_ALL), await why());
  // A keysend leg is read from the wallet. A Lightning-address leg goes out by
  // LNURL here (`/api/keysend` answers "none"), and its boostagram fields are
  // read from the BoostBox record it posts first; its invoice is refused.
  const keysent = await legsAfter(mark, 180000);
  await wait(3000);
  const lnurl = boostbox.slice(boxMark).map((r) => ({ amount: 0, b: { ...r, uuid: r.group } }));
  const legs = [...keysent, ...lnurl];
  t.ok('the wallet was asked for legs', keysent.length > 0, await why());
  t.equal('EVERY leg says value_msat_total 100000 — never a share, never the album total', totals(legs), [TYPED_MSAT]);
  const byTrack = new Map();
  for (const g of groupsOf(legs)) {
    const k = g[0].b?.remote_item_guid;
    byTrack.set(k, [...(byTrack.get(k) ?? []), g]);
  }
  t.equal(`one remote item per track, ${tracks} in all`, byTrack.size, tracks);
  t.ok('each track went out as two groups (the artist, then the show)',
    [...byTrack.values()].every((gs) => gs.length === 2), JSON.stringify([...byTrack.values()].map((gs) => gs.length)));
  t.ok('each track\'s two groups divide 100 sats between them',
    [...byTrack.values()].every((gs) => gs.reduce((s, g) => s + sumMsat(g), 0) === TYPED_MSAT),
    JSON.stringify([...byTrack.values()].map((gs) => gs.map(sumMsat))));
}

// ---------------------------------------------------------------------------
if (section(4, 'An LNURL leg\'s BoostBox record says the typed amount too')) {
  addLnaddrToShow = true;
  t.ok('the episode page opens', await open());
  t.ok('the feed answer was given a Lightning address in the show\'s block', feedRewrites.length > 0, JSON.stringify(feedRewrites));
  const parked = await parkInFirstWindow();
  t.ok('the player sits inside the first song window', parked.at >= 33 && parked.at < 353, `at ${parked.at} s`);
  await js(`${BOOST_EPISODE}.click()`);
  t.ok('the boost modal opens', await until(`!!(${FIELD})`, 20000));
  await typeAmount('100');
  const mark = await js('window.__legs.length');
  const boxMark = boostbox.length;
  t.ok('SEND is pressable once the track resolves', await pressSend(SEND), await why());
  t.ok('the show\'s card lists the Lightning-address payee',
    String(await js(`${DIALOG}?.innerText ?? ''`)).includes('e2e lnaddress'), await why());
  const legs = await legsAfter(mark);
  await wait(1500);
  addLnaddrToShow = false;
  const records = boostbox.slice(boxMark);
  t.equal('one BoostBox record, for the show\'s Lightning-address leg', records.length, 1);
  const r = records[0] ?? {};
  t.equal('...its value_msat_total is 100000', r.value_msat_total, TYPED_MSAT);
  t.ok('...while its own leg is a share of the show\'s 10 sats', r.value_msat > 0 && r.value_msat < 10000, `value_msat ${r.value_msat}`);
  t.equal('the keysend legs say 100000 as well', totals(legs), [TYPED_MSAT]);
}

// ---------------------------------------------------------------------------
console.log('\nNothing posted, nothing left the machine');
t.equal('no /api/nostr/* request (no note, no stamp, no receipt)', nostrAsked, []);
t.equal('no page exceptions', exceptions, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
