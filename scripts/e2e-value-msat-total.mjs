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
//   5. The boost Chad reported on 2026-11-17, rebuilt exactly: Chad and Reeds
//      Podcast 014, 100 sats pressed at 7525 s, inside its one song window
//      (7520 s for 213 s; the show keeps 3%). EVERY FIELD of every leg is read:
//      the song's two keysend TLVs, and the BoostBox records of the four
//      Lightning-address legs (the song's MSP 2.0, and ChadF, Reed and "candr
//      show" in the show's group). A BoostBox record names the feed the
//      listener PLAYED in `feed_guid` — the feed that holds its `item_guid` —
//      and the song only in `remote_*`. And the TLV carries no key beyond the
//      ones listed: its bytes ride in the keysend onion (BOOSTAGRAM_MAX).
//   6. A STREAMING settle in the same window: its BoostBox record names the
//      show's feed in `feed_guid` too. Its `value_msat_total` stays the
//      settle's own sats — streaming's total is a separate decision (redirect
//      invariant 8), pinned here as it is. Streaming is switched on at 60
//      sats a minute for ~35 s of silent play; the pause is the settle edge.
//   7. Section 5's boost from a wallet that CANNOT KEYSEND — Spark is one, and
//      the 2026-11-17 boost was paid from Spark. The stand-in is a WebLN wallet
//      with no `keysend`, which takes the same `canKeysend === 'no'` path (a
//      real Spark wallet needs its SDK and its network). Its four Lightning-
//      address legs are paid here against invoices this script mints; the
//      song's two node legs are refused before anything is sent. Every record
//      still says the typed 100000 — a refused leg changes no other leg — and
//      the modal names the two refused payees, says nothing was sent to them,
//      and names the wallet that refused.
//   8. A STREAMING split load that FAILS is asked again (full-code review
//      2026-11-19, finding 8; Chad's option A): `/api/value-splits` answers 503
//      when the context opens in the song window, so the ledger accrues to the
//      show. 30 s later the retry is answered, and from then on the SONG's
//      bucket accrues. No song leg is paid before its settle edge, and the
//      pause pays the song's two nodes. The show's sats from before the retry
//      stay the show's: the retry landing is a track boundary, so it settles
//      them then, as entering a window always has. ~1 min of silent play.
//
// APP_URL may also be a deployed site (a Vercel deployment URL, or production):
// its host is the one Chrome may resolve then, and every rule above still holds.

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

// A silent WAV long enough for section 5's window at 7520 s. 8 kHz, 8-bit:
// about 62 MB, held here and served in ranges, never sent whole.
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
const AUDIO = silentWav(7740);
const MAX_CHUNK = 2 * 1024 * 1024;

// ---- the browser --------------------------------------------------------------
const { page } = await launchChrome({
  name: 'value-msat-total',
  autoplay: true,
  args: ['--disable-gpu', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ${new URL(APP).hostname}`],
});
const { send, js, until } = page;
const exceptions = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300));
  }
  if (process.env.DEBUG && m.method === 'Runtime.consoleAPICalled') {
    console.log('  [console]', m.params.type, (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
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
const keysendProbes = [];
// Section 7 answers LNURL-pay itself: a payRequest for any address, then an
// invoice for exactly the amount asked. `bolt11AmountMsat` reads the amount
// from the prefix, and the stand-in wallet pays nothing, so a well-formed
// prefix over filler is enough. Everywhere else /api/lnurl stays a 502.
let lnurlPays = false;
const invoicesAsked = [];
let addLnaddrToShow = false;
const feedRewrites = [];
// Section 8: every /api/value-splits request before this time is answered 503.
let splitsFailUntil = 0;
const splitsAsked = [];
const json = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const PATTERNS = [
  { resourceType: 'Media', requestStage: 'Request' },
  { urlPattern: '*/api/nostr/*', requestStage: 'Request' },
  { urlPattern: '*/api/keysend*', requestStage: 'Request' },
  { urlPattern: '*/api/lnurl*', requestStage: 'Request' },
  { urlPattern: '*/api/lightning/boostbox*', requestStage: 'Request' },
  { urlPattern: '*/api/feed*', requestStage: 'Response' },
  { urlPattern: '*/api/value-splits*', requestStage: 'Request' },
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
      // An open-ended range is answered with one chunk; the element asks for
      // the next. A whole 62 MB body would not fit in one CDP message.
      const end = Math.min(mm && mm[2] ? Number(mm[2]) : start + MAX_CHUNK - 1, AUDIO.length - 1);
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
    if (u.pathname === '/api/value-splits') {
      const failed = Date.now() < splitsFailUntil;
      splitsAsked.push({ at: Date.now(), failed });
      if (failed) { await fulfill(503, json({ error: 'e2e: value-splits down' })); return; }
      await send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    if (u.pathname.startsWith('/api/nostr/')) {
      nostrAsked.push(u.pathname);
      await fulfill(403, json({ error: 'e2e: no nostr' }));
      return;
    }
    if (u.pathname === '/api/keysend') {
      keysendProbes.push(u.search);
      await fulfill(404, json({ error: 'e2e: lnurl only' }));
      return;
    }
    if (u.pathname === '/api/lnurl') {
      if (!lnurlPays) { await fulfill(502, json({ error: 'e2e: no lnurl' })); return; }
      let post = request.postData;
      if (!post && request.hasPostData) {
        post = (await send('Network.getRequestPostData', { requestId: networkId }).catch(() => ({})))?.result?.postData;
      }
      const target = new URL(JSON.parse(post).url);
      const answer = (o) => fulfill(200, json({ status: 200, text: JSON.stringify(o) }));
      if (target.pathname.startsWith('/.well-known/lnurlp/')) {
        await answer({
          tag: 'payRequest', callback: `https://${target.host}/e2e-callback/${target.pathname.split('/').pop()}`,
          minSendable: 1000, maxSendable: 100000000000, commentAllowed: 255, metadata: '[["text/plain","e2e"]]',
        });
      } else {
        const msat = Number(target.searchParams.get('amount'));
        invoicesAsked.push({ host: target.host, msat });
        await answer({ pr: `lnbc${msat / 100}n1${'q'.repeat(80)}`, routes: [] });
      }
      return;
    }
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
  window.__paid = [];
  // Section 7 sets 'e2e:no_keysend' before it loads the episode: a wallet with
  // no keysend at all, which pays invoices (and records them) instead.
  const noKeysend = (() => { try { return localStorage.getItem('e2e:no_keysend') === '1'; } catch { return false; } })();
  // Section 8 sets 'e2e:pays_invoices': a wallet that keysends AND pays
  // invoices, so the show's Lightning-address legs settle too.
  const paysInvoices = (() => { try { return localStorage.getItem('e2e:pays_invoices') === '1'; } catch { return false; } })();
  window.webln = {
    enable: async () => {},
    isEnabled: async () => true,
    getInfo: async () => ({ node: { alias: 'e2e' }, methods: paysInvoices ? ['getInfo', 'getBalance', 'keysend', 'sendPayment'] : ['getInfo', 'getBalance', 'keysend'] }),
    getBalance: async () => ({ balance: 1000000 }),
    keysend: async (a) => {
      window.__legs.push({ destination: a.destination, amount: Number(a.amount), tlv: (a.customRecords || {})['7629169'] ?? null });
      await new Promise((r) => setTimeout(r, 40));
      return { preimage: '00'.repeat(32) };
    },
    sendPayment: async (pr) => {
      if (!noKeysend && !paysInvoices) throw new Error('e2e: keysend only');
      window.__paid.push(pr);
      await new Promise((r) => setTimeout(r, 40));
      return { preimage: '00'.repeat(32) };
    },
    makeInvoice: async () => { throw new Error('e2e: keysend only'); },
  };
  if (noKeysend) {
    delete window.webln.keysend;
    window.webln.getInfo = async () => ({ node: { alias: 'e2e' }, methods: ['getInfo', 'getBalance', 'sendPayment'] });
  }
` });

// ---- helpers ----------------------------------------------------------------
const EPISODE = `${APP}/?podcast=${SHOW}&episode=${encodeURIComponent(ITEM)}`;
const DIALOG = `document.querySelector('[role="dialog"]')`;
const FIELD = `${DIALOG}?.querySelector('input[inputmode="numeric"], input[type="number"]')`;
const buttonIn = (re) => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => ${re}.test(b.textContent.trim()))`;
const SEND = buttonIn(/^send \d+ sats?$/i);
const BOOST_ALL = buttonIn(/^boost \d+ tracks?$/i);
const BOOST_EPISODE = `document.querySelector('button[aria-label="Boost this episode"]')`;
// "▶ RESUME 2:05:25" when the episode has a saved position. A section that
// plays the episode the previous one played meets it: the page `open()` passes
// through loads with that player state and writes it back as it unloads.
const PLAY = `[...document.querySelectorAll('button')].find((b) => /^▶ (PLAY|RESUME)/.test(b.textContent.trim()))`;

async function open(url = EPISODE, extra = {}) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { localStorage.clear();
    localStorage.setItem('bmb:rail_pref', 'webln');
    localStorage.setItem('bmb:share_nostr', '0');
    for (const [k, v] of Object.entries(${JSON.stringify(extra)})) localStorage.setItem(k, v);
    return 1; })()`);
  await send('Page.navigate', { url });
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
/** Plays the episode and parks the player at `sec`, inside a song window. */
async function parkInFirstWindow(sec = INSIDE_FIRST_WINDOW) {
  // 60 s, not 20: after a run of sections the episode can wait on a Podcast
  // Index 429, and a missing ▶ PLAY reads later as "no <audio>" (`at -1 s`).
  await until(`!!(${PLAY})`, 60000);
  await js(`(${PLAY}).click()`);
  const loaded = await until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && a.duration > ${sec}; })()`, 30000);
  await js(`(() => { const a = document.querySelector('audio'); a.currentTime = ${sec}; return 1; })()`);
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
  t.ok('some tracks paid a Lightning address, so BoostBox records exist', lnurl.length > 0);
  t.equal('every BoostBox record names the episode\'s own feed in feed_guid, never a track\'s',
    [...new Set(lnurl.map((l) => l.b.feed_guid))], [SHOW]);
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
  t.equal('...its feed_guid is the show\'s feed, while remote_feed_guid names the track', [r.feed_guid, r.remote_feed_guid], [SHOW, FIRST_TRACK_FEED]);
  t.ok('...while its own leg is a share of the show\'s 10 sats', r.value_msat > 0 && r.value_msat < 10000, `value_msat ${r.value_msat}`);
  t.equal('the keysend legs say 100000 as well', totals(legs), [TYPED_MSAT]);
}

// ---------------------------------------------------------------------------
const CANDR = '7c6f7875-2b73-491e-b32c-e2c8d6e91d53'; // Chad and Reeds Podcast
const CANDR_FEED_URL = `https://serve.podhome.fm/rss/${CANDR}`;
const CANDR_014 = '84c10ff3-cbc3-4871-97f4-ef1283878261';
const CANDR_014_TITLE = '014. What is a musicL playlist?';
const SONG_FEED = 'a2d2e313-9cbd-5169-b89c-ab07b33ecc33'; // The Heycitizen Experience
const SONG_ITEM = 'ae81976d-a05e-4ff9-9adf-cdb11a33fff9'; // Porkchops Fried
const IN_SONG = 7525;
const FROM = 'ChadF and 33 others'; // Chad's kind:0 name, the From field's default
const MSG = 'e2e leg check';
const WIRE_NAMES = ['BoostMeBitch', 'BoostMeBuddy'];
// Every key a keysend TLV of this boost may carry, signed out. A new key is
// bytes in the onion every hop shares, so it is a decision, not a side effect.
const TLV_KEYS = ['action', 'app_name', 'app_version', 'episode', 'episode_guid', 'feedID', 'itemID',
  'message', 'name', 'podcast', 'remote_feed_guid', 'remote_item_guid', 'sender_name', 'ts', 'url',
  'uuid', 'value_msat', 'value_msat_total'];
// The song's payees (97 sats) and the show's (3 sats), as the two feeds name them.
const SONG_NODES = { HeyCitizenNode: 67000, 'The Doerfels': 29000 };
const LNURL_LEGS = {
  'MSP 2.0': { address: 'musicsideproject@getalby.com', split: 1, group: 'song' },
  ChadF: { address: 'chadf@getalby.com', split: 33, group: 'show' },
  Reed: { address: 'reed@getalby.com', split: 33, group: 'show' },
  'candr show': { address: 'greyturkey26@primal.net', split: 33, group: 'show' },
};
const one = (xs) => [...new Set(xs.map((x) => (x === undefined ? '(absent)' : x)))];

if (section(5, 'Chad and Reeds 014 at 7525 s, 100 sats: every field on every leg (the 2026-11-17 report)')) {
  t.ok('the episode page opens', await open(`${APP}/?podcast=${CANDR}&episode=${encodeURIComponent(CANDR_014)}`));
  const parked = await parkInFirstWindow(IN_SONG);
  t.ok('the silent enclosure loaded', parked.loaded);
  t.ok('the player sits inside the song window (7520–7733 s)', parked.at >= 7520 && parked.at < 7733, `at ${parked.at} s`);
  await js(`${BOOST_EPISODE}.click()`);
  t.ok('the boost modal opens', await until(`!!(${FIELD})`, 20000));
  const fromField = `(() => { const l = [...(${DIALOG}?.querySelectorAll('label') ?? [])].find((x) => /^from/i.test(x.textContent.trim())); return l ? document.getElementById(l.htmlFor) : null; })()`;
  t.ok('the From field is there', !!(await js(`!!${fromField}`)));
  await js(`(() => { const f = ${fromField}; f.focus(); f.select(); return 1; })()`);
  await send('Input.insertText', { text: FROM });
  await js(`(() => { const m = ${DIALOG}?.querySelector('textarea'); m.focus(); return 1; })()`);
  await send('Input.insertText', { text: MSG });
  await typeAmount('100');
  const mark = await js('window.__legs.length');
  const boxMark = boostbox.length;
  t.ok('SEND is pressable once the song resolves', await pressSend(SEND), await why());
  // The legs go out biggest share first and one at a time; the four LNURL
  // legs end when their invoice is refused, so wait for all four records.
  const end = Date.now() + 90000;
  while (Date.now() < end && boostbox.length - boxMark < 4) await wait(250);
  const keysent = await legsAfter(mark, 20000);
  await wait(1500);
  const records = boostbox.slice(boxMark).filter(Boolean);
  if (process.env.DEBUG) console.log(JSON.stringify({ keysent: keysent.map((l) => l.b), records }, null, 1));

  console.log('  the song\'s keysend legs (TLV 7629169)');
  const tlvs = keysent.map((l) => l.b);
  t.equal('two keysend legs, to the song\'s two nodes', tlvs.map((b) => b?.name).sort(), Object.keys(SONG_NODES).sort());
  t.ok('each pays its share of the song\'s 97 sats', keysent.every((l) => SONG_NODES[l.b?.name] === l.amount * 1000 && l.b?.value_msat === l.amount * 1000),
    JSON.stringify(keysent.map((l) => [l.b?.name, l.amount, l.b?.value_msat])));
  t.equal('value_msat_total is the typed 100000', one(tlvs.map((b) => b?.value_msat_total)), [TYPED_MSAT]);
  t.equal('one uuid for the song\'s group', one(tlvs.map((b) => b?.uuid)).length, 1);
  t.equal('podcast is the show the listener played', one(tlvs.map((b) => b?.podcast)), ['Chad and Reeds Podcast']);
  t.equal('url is the show\'s feed', one(tlvs.map((b) => b?.url)), [CANDR_FEED_URL]);
  t.ok('feedID is the show\'s Podcast Index id', tlvs.every((b) => Number.isInteger(b?.feedID) && b.feedID > 0), JSON.stringify(one(tlvs.map((b) => b?.feedID))));
  t.equal('episode is episode 014', one(tlvs.map((b) => b?.episode)), [CANDR_014_TITLE]);
  t.equal('episode_guid is episode 014', one(tlvs.map((b) => b?.episode_guid)), [CANDR_014]);
  t.ok('itemID is a Podcast Index episode id', tlvs.every((b) => Number.isInteger(b?.itemID) && b.itemID > 0), JSON.stringify(one(tlvs.map((b) => b?.itemID))));
  t.equal('remote_feed_guid is the song\'s feed', one(tlvs.map((b) => b?.remote_feed_guid)), [SONG_FEED]);
  t.equal('remote_item_guid is the song', one(tlvs.map((b) => b?.remote_item_guid)), [SONG_ITEM]);
  t.ok('ts is inside the window', tlvs.every((b) => b?.ts >= 7520 && b.ts < 7733), JSON.stringify(one(tlvs.map((b) => b?.ts))));
  t.equal('sender_name is what From says', one(tlvs.map((b) => b?.sender_name)), [FROM]);
  t.equal('message is what was typed', one(tlvs.map((b) => b?.message)), [MSG]);
  t.equal('action is boost', one(tlvs.map((b) => b?.action)), ['boost']);
  t.ok('app_name is a wire name, app_version is 0.1.0', tlvs.every((b) => WIRE_NAMES.includes(b?.app_name) && b?.app_version === '0.1.0'));
  t.equal('no key beyond the listed ones (the onion\'s bytes are budgeted)',
    one(tlvs.flatMap((b) => Object.keys(b ?? {}).filter((k) => !TLV_KEYS.includes(k)))), []);

  console.log('  the BoostBox records of the four Lightning-address legs');
  t.equal('one record per Lightning-address leg (boostr\'s 0 sats send nothing)',
    records.map((r) => r.recipient_name).sort(), Object.keys(LNURL_LEGS).sort());
  const songUuid = tlvs[0]?.uuid;
  const groupOf = (r) => (r.group === songUuid ? 'song' : 'show');
  t.ok('each record is in its own group: MSP 2.0 with the song\'s keysend legs, the others in one show group',
    records.every((r) => LNURL_LEGS[r.recipient_name]?.group === groupOf(r))
      && one(records.filter((r) => groupOf(r) === 'show').map((r) => r.group)).length === 1,
    JSON.stringify(records.map((r) => [r.recipient_name, r.group])));
  t.ok('each names its payee\'s address and weight', records.every((r) => {
    const e = LNURL_LEGS[r.recipient_name];
    return e && r.recipient_address === e.address && r.split === e.split;
  }), JSON.stringify(records.map((r) => [r.recipient_name, r.recipient_address, r.split])));
  t.equal('each leg is 1 sat (value_msat)', one(records.map((r) => r.value_msat)), [1000]);
  t.equal('value_msat_total is the typed 100000 — never the show\'s 3000', one(records.map((r) => r.value_msat_total)), [TYPED_MSAT]);
  t.equal('feed_guid is the show\'s feed, the one that holds item_guid — never the song\'s', one(records.map((r) => r.feed_guid)), [CANDR]);
  t.equal('feed_title is the show', one(records.map((r) => r.feed_title)), ['Chad and Reeds Podcast']);
  t.equal('item_guid is episode 014', one(records.map((r) => r.item_guid)), [CANDR_014]);
  t.equal('item_title is episode 014', one(records.map((r) => r.item_title)), [CANDR_014_TITLE]);
  t.equal('remote_feed_guid is the song\'s feed', one(records.map((r) => r.remote_feed_guid)), [SONG_FEED]);
  t.equal('remote_item_guid is the song', one(records.map((r) => r.remote_item_guid)), [SONG_ITEM]);
  t.equal('boost_link is the show\'s feed', one(records.map((r) => r.boost_link)), [CANDR_FEED_URL]);
  t.equal('sender_name is what From says', one(records.map((r) => r.sender_name)), [FROM]);
  t.equal('message is what was typed', one(records.map((r) => r.message)), [MSG]);
  t.equal('action is boost', one(records.map((r) => r.action)), ['boost']);
  t.ok('app_name is a wire name, app_version is 0.1.0', records.every((r) => WIRE_NAMES.includes(r.app_name) && r.app_version === '0.1.0'));
  t.equal('signed out: no sender_id, no sender_npub', one(records.flatMap((r) => [r.sender_id, r.sender_npub])), ['(absent)']);
  t.ok('timestamp is an ISO time', records.every((r) => !Number.isNaN(Date.parse(r.timestamp))));

  console.log('  the two groups');
  t.equal('the song\'s group paid 97 sats, the show\'s 3',
    [sumMsat(keysent) + records.filter((r) => groupOf(r) === 'song').reduce((s, r) => s + r.value_msat, 0),
      records.filter((r) => groupOf(r) === 'show').reduce((s, r) => s + r.value_msat, 0)], [97000, 3000]);
}

// ---------------------------------------------------------------------------
if (section(6, 'A streaming settle in the same song window: its BoostBox record names the show\'s feed')) {
  t.ok('the episode page opens with streaming on at 60 sats a minute',
    await open(`${APP}/?podcast=${CANDR}&episode=${encodeURIComponent(CANDR_014)}`, { 'bmb:stream_on': '1', 'bmb:stream_rate': '60' }));
  // Streaming pays only through a CONNECTED rail (pickRail), and WebLN counts
  // as connected once the page has enabled it — signed out, that is Sign in ▾
  // → Connect wallet → the WebLN row. Without it the settle refunds the bucket
  // and sends nothing (the boost modal enables WebLN as it pays; this does not).
  const SIGN_IN = `[...document.querySelectorAll('button')].find((b) => /^sign in/i.test(b.textContent.trim()))`;
  const CONNECT = `[...document.querySelectorAll('[role="menuitem"]')].find((b) => /connect wallet/i.test(b.textContent))`;
  const WEBLN_ROW = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => /WebLN/.test(b.textContent) && /tap to enable/i.test(b.textContent))`;
  await until(`!!(${SIGN_IN})`, 20000);
  await js(`(${SIGN_IN}).click()`);
  t.ok('the Sign in menu offers Connect wallet', await until(`!!(${CONNECT})`, 10000));
  await js(`(${CONNECT}).click()`);
  t.ok('the wallet modal offers WebLN', await until(`!!(${WEBLN_ROW})`, 20000));
  await js(`(${WEBLN_ROW}).click()`);
  t.ok('WebLN connects and the wallet modal closes', await until(`!document.querySelector('[role="dialog"]')`, 20000));
  const parked = await parkInFirstWindow(IN_SONG);
  t.ok('the player sits inside the song window', parked.at >= 7520 && parked.at < 7733, `at ${parked.at} s`);
  const mark = await js('window.__legs.length');
  const boxMark = boostbox.length;
  await js(`document.querySelector('audio').play().then(() => 1)`);
  await wait(35000);
  const at = await js(`Math.round(document.querySelector('audio')?.currentTime ?? -1)`);
  t.ok('~35 s played, still inside the window', at > 7550 && at < 7733, `at ${at} s`);
  // The player's own Pause, not the element's: <Player> takes isPlaying from
  // its controls, and the settle edge is that store value going false.
  const PAUSE = `[...document.querySelectorAll('button[aria-label="Pause"]')].find((b) => b.offsetParent !== null)`;
  t.ok('the player\'s Pause control is there', await until(`!!(${PAUSE})`, 10000));
  await js(`(${PAUSE}).click()`);
  // The pause is a settle edge: the song's bucket goes out as one sendBoost.
  const end = Date.now() + 60000;
  while (Date.now() < end && boostbox.length === boxMark) await wait(250);
  const keysent = await legsAfter(mark, 20000);
  await wait(1500);
  const records = boostbox.slice(boxMark).filter(Boolean);
  if (process.env.DEBUG) {
    console.log(await js(`JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('bmb:stream'))))`));
    console.log(JSON.stringify({ keysent: keysent.map((l) => [l.amount, l.b]), records }, null, 1));
  }
  t.equal('the song\'s two nodes were paid by keysend', keysent.map((l) => l.b?.name).sort(), Object.keys(SONG_NODES).sort());
  t.equal('one BoostBox record, for MSP 2.0\'s Lightning-address leg', records.map((r) => r.recipient_name), ['MSP 2.0']);
  const r = records[0] ?? {};
  t.equal('...feed_guid is the show\'s feed — never the song\'s', r.feed_guid, CANDR);
  t.equal('...remote_feed_guid and remote_item_guid name the song', [r.remote_feed_guid, r.remote_item_guid], [SONG_FEED, SONG_ITEM]);
  t.equal('...item_guid and feed_title name the episode and the show', [r.item_guid, r.feed_title], [CANDR_014, 'Chad and Reeds Podcast']);
  t.equal('...action is stream (a music leg\'s auto, which BoostBox does not take)', r.action, 'stream');
  const settled = sumMsat(keysent) + (r.value_msat ?? 0);
  t.ok('...value_msat_total is the settle\'s own sats, as streaming has always sent it',
    settled > 0 && r.value_msat_total === settled && keysent.every((l) => l.b?.value_msat_total === settled),
    JSON.stringify({ settled, record: r.value_msat_total, tlv: one(keysent.map((l) => l.b?.value_msat_total)) }));
  t.equal('the keysend legs say action auto (a song) and name the song in remote_*',
    [one(keysent.map((l) => l.b?.action)), one(keysent.map((l) => l.b?.remote_feed_guid))], [['auto'], [SONG_FEED]]);
}

// ---------------------------------------------------------------------------
if (section(7, 'The same boost from a wallet that cannot keysend (the 2026-11-17 boost was paid from Spark)')) {
  lnurlPays = true;
  t.ok('the episode page opens with a wallet that has no keysend',
    await open(`${APP}/?podcast=${CANDR}&episode=${encodeURIComponent(CANDR_014)}`, { 'e2e:no_keysend': '1' }));
  t.equal('the stand-in wallet has no keysend method', await js('typeof window.webln.keysend'), 'undefined');
  const parked = await parkInFirstWindow(IN_SONG);
  t.ok('the player sits inside the song window (7520–7733 s)', parked.at >= 7520 && parked.at < 7733, `at ${parked.at} s`);
  await js(`${BOOST_EPISODE}.click()`);
  t.ok('the boost modal opens', await until(`!!(${FIELD})`, 20000));
  const fromField = `(() => { const l = [...(${DIALOG}?.querySelectorAll('label') ?? [])].find((x) => /^from/i.test(x.textContent.trim())); return l ? document.getElementById(l.htmlFor) : null; })()`;
  await js(`(() => { const f = ${fromField}; f.focus(); f.select(); return 1; })()`);
  await send('Input.insertText', { text: FROM });
  await js(`(() => { const m = ${DIALOG}?.querySelector('textarea'); m.focus(); return 1; })()`);
  await send('Input.insertText', { text: MSG });
  await typeAmount('100');
  // What the listener reads BEFORE paying. Recorded, not asserted: whether to
  // warn here is a product decision, and a check would pin today's answer.
  await until(`!!(${SEND}) && !(${SEND}).disabled`, 30000);
  const before = String(await js(`${DIALOG}?.innerText ?? ''`));
  console.log(`  before SEND, the modal ${/keysend|cannot pay|can.t pay/i.test(before) ? 'DOES' : 'does NOT'} say that this wallet cannot pay the song's two nodes`);
  const mark = await js('window.__legs.length');
  const paidMark = await js('window.__paid.length');
  const boxMark = boostbox.length;
  const probeMark = keysendProbes.length;
  const askMark = invoicesAsked.length;
  t.ok('SEND is pressable once the song resolves', await pressSend(SEND), await why());
  const done = `/failed — why/.test(${DIALOG}?.innerText ?? '') && window.__paid.length >= ${paidMark + 4}`;
  t.ok('the boost settles: four legs paid, the rest explained', await until(done, 90000), await why());
  await wait(1500);
  const records = boostbox.slice(boxMark).filter(Boolean);
  const asked = invoicesAsked.slice(askMark);
  const paid = JSON.parse(await js('JSON.stringify(window.__paid)')).slice(paidMark);
  const keysent = await legsAfter(mark, 2000);
  const after = String(await js(`${DIALOG}?.innerText ?? ''`));
  if (process.env.DEBUG) console.log(JSON.stringify({ records, asked, paid: paid.length, after }, null, 1));

  console.log('  the wallet');
  t.equal('no keysend was attempted', keysent.length, 0);
  t.equal('no .well-known/keysend lookup: the wallet\'s "no" is read before any leg', keysendProbes.slice(probeMark), []);
  t.equal('the four Lightning-address legs asked for a 1-sat invoice each', asked.map((a) => a.msat), [1000, 1000, 1000, 1000]);
  t.equal('...and the wallet paid all four', paid.length, 4);

  console.log('  the BoostBox records — a refused leg changes no other leg');
  t.equal('one record per Lightning-address leg', records.map((r) => r.recipient_name).sort(), Object.keys(LNURL_LEGS).sort());
  t.equal('each leg is 1 sat (value_msat)', one(records.map((r) => r.value_msat)), [1000]);
  t.equal('value_msat_total is the typed 100000 — not the 4 sats that moved, nor a group\'s share',
    one(records.map((r) => r.value_msat_total)), [TYPED_MSAT]);
  t.equal('feed_guid is the show\'s feed', one(records.map((r) => r.feed_guid)), [CANDR]);
  t.equal('remote_feed_guid and remote_item_guid name the song',
    [one(records.map((r) => r.remote_feed_guid)), one(records.map((r) => r.remote_item_guid))], [[SONG_FEED], [SONG_ITEM]]);
  const msp = records.find((r) => r.recipient_name === 'MSP 2.0');
  const show = records.filter((r) => r.recipient_name !== 'MSP 2.0');
  t.ok('MSP 2.0 is in the song\'s group, the other three in one show group',
    !!msp && one(show.map((r) => r.group)).length === 1 && show[0]?.group !== msp.group,
    JSON.stringify(records.map((r) => [r.recipient_name, r.group])));
  t.equal('sender_name and message are what was typed', [one(records.map((r) => r.sender_name)), one(records.map((r) => r.message))], [[FROM], [MSG]]);

  console.log('  what the listener reads after SEND');
  t.ok('the modal counts 4 of 6 legs sent', /Lightning: 4\/6 sent/.test(after), after.replace(/\s+/g, ' ').slice(0, 400));
  t.ok('...and says 2 failed', /2 failed — why/.test(after));
  const nodeCause = String(await js(`[...(${DIALOG}?.querySelectorAll('details li') ?? [])].find((li) => /Lightning node/.test(li.textContent))?.innerText ?? ''`));
  t.ok('the refusal names the wallet that refused (WebLN here, Spark for a Spark wallet)',
    /your WebLN wallet cannot pay a node directly \(keysend\)/.test(nodeCause), nodeCause);
  t.ok('...says nothing was sent to those two', /Nothing was sent to these recipients/.test(nodeCause), nodeCause);
  t.equal('...and names exactly the song\'s two nodes',
    (nodeCause.trim().split('\n').pop() ?? '').split(' · ').map((x) => x.trim()).sort(), Object.keys(SONG_NODES).sort());
  lnurlPays = false;
}

// ---------------------------------------------------------------------------
if (section(8, 'A failed split load is asked again: the song\'s bucket takes over, and nothing pays it early')) {
  lnurlPays = true; // the show's Lightning-address legs settle against minted invoices
  splitsFailUntil = Date.now() + 10 * 60_000;
  const songBucket = `t:${SONG_FEED}:${SONG_ITEM}`;
  const pending = async () => JSON.parse(await js(`localStorage.getItem('bmb:stream_pending') || 'null'`) ?? 'null');
  const bucketsNow = async () => Object.fromEntries(Object.entries((await pending())?.buckets ?? {}).filter(([, v]) => v > 0));
  t.ok('the episode page opens with streaming on at 60 sats a minute',
    await open(`${APP}/?podcast=${CANDR}&episode=${encodeURIComponent(CANDR_014)}`, { 'bmb:stream_on': '1', 'bmb:stream_rate': '60', 'e2e:pays_invoices': '1' }));
  const SIGN_IN = `[...document.querySelectorAll('button')].find((b) => /^sign in/i.test(b.textContent.trim()))`;
  const CONNECT = `[...document.querySelectorAll('[role="menuitem"]')].find((b) => /connect wallet/i.test(b.textContent))`;
  const WEBLN_ROW = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => /WebLN/.test(b.textContent) && /tap to enable/i.test(b.textContent))`;
  await until(`!!(${SIGN_IN})`, 20000);
  await js(`(${SIGN_IN}).click()`);
  await until(`!!(${CONNECT})`, 10000);
  await js(`(${CONNECT}).click()`);
  await until(`!!(${WEBLN_ROW})`, 20000);
  await js(`(${WEBLN_ROW}).click()`);
  t.ok('WebLN connects', await until(`!document.querySelector('[role="dialog"]')`, 20000));
  const askedMark = splitsAsked.length;
  const parked = await parkInFirstWindow(IN_SONG);
  t.ok('the player sits inside the song window', parked.at >= 7520 && parked.at < 7733, `at ${parked.at} s`);
  const firstFail = splitsAsked.slice(askedMark).find((a) => a.failed);
  t.ok('the context\'s split load was answered 503', !!firstFail, JSON.stringify(splitsAsked.slice(askedMark)));
  const legMark = await js('window.__legs.length');
  const paidMark = await js('window.__paid.length');
  await js(`document.querySelector('audio').play().then(() => 1)`);
  // 12 s of play (the ledger persists every 10 s): all of it is the show's.
  await wait(12000);
  const early = await bucketsNow();
  t.equal('while the splits cannot load, only the show\'s bucket accrues', Object.keys(early), ['']);
  // The route comes back. The first retry is 30 s after the failed load.
  splitsFailUntil = 0;
  const backAt = Date.now();
  const landed = await until(`(() => { const p = JSON.parse(localStorage.getItem('bmb:stream_pending') || 'null'); return !!p && (p.buckets[${JSON.stringify(songBucket)}] ?? 0) > 0; })()`, 50000, 500);
  const retried = splitsAsked.filter((a) => a.at >= backAt && !a.failed).length;
  t.ok('the split load is asked again, and answered', retried > 0, JSON.stringify(splitsAsked.slice(askedMark).map((a) => [Math.round((a.at - firstFail.at) / 1000), a.failed])));
  t.ok('...the song\'s bucket accrues from then on', !!landed, JSON.stringify(await bucketsNow()));
  const retryAt = splitsAsked.find((a) => a.at >= backAt && !a.failed)?.at ?? 0;
  t.ok('...about 30 s after the failed load, not before', retryAt - firstFail.at >= 29000 && retryAt - firstFail.at < 45000,
    `${Math.round((retryAt - firstFail.at) / 1000)} s`);
  // Past the song bucket's 10-sat floor, or the pause carries it unpaid.
  const funded = await until(`(() => { const p = JSON.parse(localStorage.getItem('bmb:stream_pending') || 'null'); return (p?.buckets[${JSON.stringify(songBucket)}] ?? 0) >= 15000; })()`, 45000, 500);
  t.ok('...and passes its 10-sat floor', !!funded, JSON.stringify(await bucketsNow()));
  const before = await legsAfter(legMark, 1500);
  t.equal('no song leg was paid before its settle edge', before.filter((l) => SONG_NODES[l.b?.name] !== undefined).length, 0);
  // The retry landing moves the allocation from the show to the song, which is
  // a track boundary like entering a window: the show's bucket settles then,
  // to the show, for the sats it earned while the splits could not load.
  const showPaidAtRetry = (await js('window.__paid.length')) - paidMark;
  t.ok('...the show\'s bucket settled at that boundary, to the show\'s Lightning addresses', showPaidAtRetry >= 1,
    `${showPaidAtRetry} invoices paid, ${before.length} keysend legs; buckets ${JSON.stringify(await bucketsNow())}`);
  t.equal('...and nothing of the show\'s is left owed', Math.floor(((await bucketsNow())[''] ?? 0) / 1000) < 10, true);
  const PAUSE = `[...document.querySelectorAll('button[aria-label="Pause"]')].find((b) => b.offsetParent !== null)`;
  t.ok('the player\'s Pause control is there', await until(`!!(${PAUSE})`, 10000));
  await js(`(${PAUSE}).click()`);
  const keysent = await legsAfter(legMark, 30000);
  t.equal('the pause pays the song\'s two nodes, by keysend', keysent.map((l) => l.b?.name).sort(), Object.keys(SONG_NODES).sort());
  t.equal('...naming the song in remote_*', one(keysent.map((l) => l.b?.remote_item_guid)), [SONG_ITEM]);
  lnurlPays = false;
}

// ---------------------------------------------------------------------------
console.log('\nNothing posted, nothing left the machine');
t.equal('no /api/nostr/* request (no note, no stamp, no receipt)', nostrAsked, []);
t.equal('no page exceptions', exceptions, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
