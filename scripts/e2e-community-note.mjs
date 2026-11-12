// e2e for the Nostr NOTE a boost publishes when the song was played from a PLAYLIST
// (community playlists, Task 16), in a real browser.
//
// Needs the dev server of e2e-community-ui.mjs, started with, on the command line (never
// in .env.local):
//   COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres
//   ADMIN_NPUBS=npub1nzwqkakt2cuhrlwfhme3asrvx4s0xfyadm57tkpu2a39t9hqtahs7fsn89
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123
//   npm run dev -- -p 3123
// then:
//   npm run e2e:communitynote               # section 3 runs only if Buddy's route sends CORS
//   npm run e2e:communitynote -- --offline  # never asks Buddy production anything
//   npm run e2e:communitynote -- --force-buddy  # section 3 even without CORS (this script's
//                                               # POST needs none); still local-relay only
// APP_URL overrides the server.
//
// What it boosts, 100 sats each, through the shipping modal:
//   1. the first song of a playlist stored on THIS server (BMB-hosted), shared as "My feed";
//   2. the same, shared as "Anonymous", while Buddy's signing route cannot be read (the
//      state until PR 4, branch `buddy-sign-cors`, is on Buddy production) — simulated in
//      the page, so it runs offline: the note must FAIL, never fall back to this deploy's key;
//   3. the same as "Anonymous", signed by Buddy production for real. SKIPPED with
//      `--offline`, and by default while Buddy's route answers without CORS. The page's
//      origin (localhost) is not one PR 4 allows, so the page's request is handed to this
//      script over a CDP binding and POSTed to Buddy from here, and Buddy's answer goes back;
//   4. the first song of one of the seven existing community feeds (Lightning Thrashes),
//      shared as "My feed": the deploy's own words, with the Heard-on line.
//
// NOTHING LEAVES THIS MACHINE FOR MONEY OR FOR NOSTR, and each half is checked, not intended:
//  - The wallet is a stub NIP-47 service on a local relay (copied from e2e-nwc-relay.mjs),
//    and `/api/item-value` is answered here with one keysend stub node, so every leg is a
//    `pay_keysend` to the stub. There is no real wallet to pay from.
//  - Every WebSocket the page opens to anything but the local relay (or the dev server's
//    own HMR socket) is REDIRECTED to the local relay and recorded. `publishBoostNoteViaSite`
//    publishes to the hard-coded DEFAULT_RELAYS, so without this a site-signed note would
//    land on damus.io and friends. 'no EVENT went to a public relay' reads that record.
//  - The dev server's OWN signing routes (/api/nostr/site-sign and /zap-receipt-sign) are
//    refused in the page and must never be asked: .env.local holds the real BoostMeBitch
//    site key. A Buddy-worded note signed by it is the failure this task forbids.
// Feed and Podcast Index reads still reach the public network through the dev server.
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';
import { getToken } from 'nostr-tools/nip98';
import { BRANDS } from '../lib/brand.ts';

const OFFLINE = process.argv.includes('--offline');
const FORCE_BUDDY = !OFFLINE && process.argv.includes('--force-buddy');
const APP = (process.env.APP_URL || 'http://localhost:3123').replace(/\/$/, '');
await requireApp(APP, `Nothing is serving ${APP}. Start the dev server (see the top of this file).`);

const BUDDY = BRANDS.buddy;
const BITCH = BRANDS.bmb;
const BUDDY_SITE_PK = nip19.decode(BUDDY.siteNpub).data;
const BITCH_SITE_PK = nip19.decode(BITCH.siteNpub).data;
const SONG_SOURCE = 'https://v4vmusic.com/playlist/334bb12d-1f72-4c0e-88e1-266bd1e2dff9.xml';
const COMMUNITY_FEED = 'https://cdn.kolomona.com/podcasts/lightning-thrashes/playlists/001-to-060-lightning-thrashes-playlist.xml';
const STUB_NODE = `02${'ab'.repeat(32)}`;

const t = checker();
const section = (s) => console.log(`\n--- ${s} ---`);
const ip = () => `10.93.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

// ---- the local relay: notes, the wallet's requests and replies ------------------------
const published = [];
const relay = createRelay({ port: 0, log: null, onEvent: (e) => published.push(e) });
const PORT = await relay.ready;
const LOCAL = `ws://127.0.0.1:${PORT}`;

// ---- a stub NIP-47 wallet (e2e-nwc-relay.mjs), recording every payment's params --------
const walletSk = generateSecretKey();
const walletPub = getPublicKey(walletSk);
const clientSk = generateSecretKey();
const clientPub = getPublicKey(clientSk);
const conversation = nip44.getConversationKey(walletSk, clientPub);
const wallet = { payments: [] };
const METHODS = ['get_info', 'get_balance', 'pay_keysend', 'pay_invoice'];
const walletWs = new WebSocket(LOCAL);
const signAndSend = (tmpl) => walletWs.send(JSON.stringify(['EVENT', finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl }, walletSk)]));
const answerFor = (method, params) => {
  if (method === 'get_info') return { methods: METHODS, alias: 'stub', pubkey: walletPub, network: 'mainnet', block_height: 1, block_hash: '00', color: '#000000' };
  if (method === 'get_balance') return { balance: 1_000_000 * 1000 };
  if (method === 'pay_keysend' || method === 'pay_invoice') {
    wallet.payments.push({ method, params });
    return { preimage: 'ab'.repeat(32) };
  }
  return null;
};
walletWs.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] !== 'EVENT' || msg[1] !== 'wallet') return;
  const e = msg[2];
  const { method, params } = JSON.parse(nip44.decrypt(e.content, conversation));
  const result = answerFor(method, params);
  const body = result
    ? { result_type: method, result }
    : { result_type: method, result: null, error: { code: 'NOT_IMPLEMENTED', message: `${method} is not stubbed` } };
  signAndSend({ kind: 23195, tags: [['p', clientPub], ['e', e.id]], content: nip44.encrypt(JSON.stringify(body), conversation) });
};
await new Promise((resolve, reject) => { walletWs.onopen = resolve; walletWs.onerror = reject; });
walletWs.send(JSON.stringify(['REQ', 'wallet', { kinds: [23194], '#p': [walletPub] }]));
signAndSend({ kind: 13194, tags: [['encryption', 'nip44_v2']], content: METHODS.join(' ') });
const NWC_URI = `nostr+walletconnect://${walletPub}?relay=${LOCAL}&secret=${Buffer.from(clientSk).toString('hex')}`;
/** The boostagram JSON a keysend carried in TLV 7629169. */
const boostagramOf = (p) => {
  const rec = (p?.params?.tlv_records ?? []).find((r) => Number(r.type) === 7629169);
  try { return rec ? JSON.parse(Buffer.from(rec.value, 'hex').toString('utf8')) : null; } catch { return null; }
};

// ---- two throwaway keys: the playlist's maker, and the listener who boosts -------------
const makerSk = generateSecretKey();
const makerPk = getPublicKey(makerSk);
const makerNpub = nip19.npubEncode(makerPk);
const userSk = generateSecretKey();
const userPk = getPublicKey(userSk);
const userNpub = nip19.npubEncode(userPk);

// ---- a playlist stored on this server, made by the maker -----------------------------
const nodeIp = ip();
const src = await fetch(`${APP}/api/playlist?url=${encodeURIComponent(SONG_SOURCE)}&limit=40`, { headers: { 'x-real-ip': nodeIp } })
  .then((r) => r.json()).catch(() => ({}));
const resolved = [...new Map((src.episodes ?? [])
  .filter((e) => !e.unresolved && e.guid && e.podcastGuid && e.title)
  .map((e) => [e.guid, e])).values()];
// The first song is one whose album is titled differently from it, so "the header names
// the album, not the song or the playlist" can tell the three apart.
const lead = resolved.find((e) => e.feedTitle && e.feedTitle !== e.title);
const real = lead ? [lead, ...resolved.filter((e) => e !== lead)].slice(0, 12) : [];
t.ok('twelve real songs to store, led by one whose album has its own title', real.length === 12, `got ${real.length}`);
const PLAYLIST_TITLE = `e2e note playlist ${Math.random().toString(36).slice(2, 7)}`;
const draft = { title: PLAYLIST_TITLE, description: 'made by e2e-community-note', artUrl: null, songs: real.map((e) => ({ feedGuid: e.podcastGuid, itemGuid: e.guid })) };
const signAs = (sk) => (e) => finalizeEvent(e, sk);
const created = await (async () => {
  const url = `${APP}/api/community-playlists`;
  const payload = { draft };
  const token = await getToken(url, 'POST', signAs(makerSk), true, payload);
  const r = await fetch(url, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json', 'x-real-ip': nodeIp }, body: JSON.stringify(payload) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
})();
t.ok('the maker stored a playlist (201)', created.status === 201 && created.id && created.feedUrl, JSON.stringify(created));
if (!created.id) await exit(1);
const HOSTED_ORIGIN = new URL(created.feedUrl).origin;
const stored = await fetch(`${APP}/api/playlist?url=${encodeURIComponent(created.feedUrl)}&limit=5`, { headers: { 'x-real-ip': nodeIp } }).then((r) => r.json());
const PL_GUID = stored.podcast?.podcastGuid;
const song = stored.episodes?.[0];
t.ok('the stored playlist reads back with a guid and its first song', !!PL_GUID && song?.guid === real[0].guid, JSON.stringify({ PL_GUID, first: song?.guid }));
console.log(`  stored playlist ${created.id} on ${HOSTED_ORIGIN}; first song "${song?.title}" from "${song?.feedTitle}"`);

// ---- the browser ------------------------------------------------------------------------
const { page } = await launchChrome({
  name: `communitynote-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`,
  args: ['--disable-gpu'],
});
const { send, on } = page;
const js = page.jsOrThrow;
await send('Page.enable'); await send('Runtime.enable');

// A window.nostr indistinguishable from an extension, over a CDP binding (e2e-favorites.mjs).
await send('Runtime.addBinding', { name: 'bmbSigner' });
// The Buddy hand-off for section 3: the page's request, POSTed to Buddy from here.
await send('Runtime.addBinding', { name: 'bmbBuddy' });
// What the page did, kept HERE: a page record would be wiped by every navigation.
await send('Runtime.addBinding', { name: 'bmbRecord' });
const rec = { ws: [], events: [], sign: [] };
const buddyAsked = [];
on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled') return;
  const { name, payload } = m.params;
  if (name === 'bmbRecord') {
    const r = JSON.parse(payload);
    rec[r.type]?.push(r);
    return;
  }
  if (name === 'bmbSigner') {
    const { rid, fn, args } = JSON.parse(payload);
    let out, err = null;
    try {
      if (fn === 'getPublicKey') out = userPk;
      else if (fn === 'signEvent') out = finalizeEvent(args[0], userSk);
      else err = `no such method ${fn}`;
    } catch (e) { err = String(e?.message ?? e); }
    await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
    return;
  }
  if (name === 'bmbBuddy') {
    const { rid, url, body } = JSON.parse(payload);
    let out;
    // Only Buddy's two signing routes, and never with --offline.
    if (OFFLINE || !/^https:\/\/www\.boostmebuddy\.com\/api\/nostr\/(site-sign|zap-receipt-sign)$/.test(url)) {
      out = { status: 599, text: '{"error":"e2e: not handed to Buddy"}' };
    } else {
      buddyAsked.push({ url, body });
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
        out = { status: r.status, text: await r.text() };
      } catch (e) { out = { status: 599, text: JSON.stringify({ error: String(e?.message ?? e) }) }; }
    }
    await js(`window.__bmbBuddyResolve(${JSON.stringify(rid)}, ${JSON.stringify(out)})`);
  }
});

// `/api/item-value` answers one keysend stub node, so no leg can pay anyone real.
const VALUE = {
  read: true,
  value: { type: 'lightning', method: 'keysend', recipients: [{ name: 'E2E stub node', type: 'node', address: STUB_NODE, split: 100 }] },
  valueTimeSplits: [],
};
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/item-value*', requestStage: 'Request' }] });
on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  await send('Fetch.fulfillRequest', {
    requestId: m.params.requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(VALUE)).toString('base64'),
  });
});

await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    // The signer.
    const waiting = new Map(); let n = 0;
    window.__bmbResolve = (rid, r) => { const p = waiting.get(rid); waiting.delete(rid); if (!p) return; r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      const rid = 'r' + (++n); waiting.set(rid, { resolve, reject });
      window.bmbSigner(JSON.stringify({ rid, fn, args }));
    });
    window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => call('signEvent', e) };

    // Every socket goes to the local relay, except the dev server's own (HMR).
    const LOCAL = ${JSON.stringify(LOCAL)};
    const record = (r) => { try { window.bmbRecord(JSON.stringify(r)); } catch {} };
    const Real = window.WebSocket;
    class Redirecting extends Real {
      constructor(url, protocols) {
        const asked = String(url);
        let keep = asked.startsWith(LOCAL);
        try { keep = keep || new URL(asked).host === location.host; } catch {}
        super(keep ? asked : LOCAL, protocols);
        this.__asked = asked;
        record({ type: 'ws', asked, to: keep ? asked : LOCAL });
      }
      send(d) {
        try {
          if (typeof d === 'string' && d.startsWith('["EVENT"')) {
            const e = JSON.parse(d)[1];
            record({ type: 'events', asked: this.__asked, to: this.url, kind: e.kind, id: e.id });
          }
        } catch {}
        return super.send(d);
      }
    }
    window.WebSocket = Redirecting;

    // The signing routes: this deploy's are refused; Buddy's are unreadable ('nocors',
    // what a browser sees until PR 4 is live) or handed to the script ('proxy').
    const buddyWaiting = new Map(); let b = 0;
    window.__bmbBuddyResolve = (rid, r) => { const p = buddyWaiting.get(rid); buddyWaiting.delete(rid); if (p) p(r); };
    const real = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';
      let abs = url;
      try { abs = new URL(url, location.href).href; } catch {}
      if (/\\/api\\/nostr\\/(site-sign|zap-receipt-sign)(\\?|$)/.test(abs)) {
        let mode = 'nocors';
        try { mode = localStorage.getItem('__e2eBuddy') || 'nocors'; } catch {}
        record({ type: 'sign', url: abs, body: typeof init?.body === 'string' ? init.body : null, mode });
        if (abs.startsWith(location.origin)) return Promise.reject(new TypeError('e2e: this deploy signs nothing here'));
        if (mode !== 'proxy') return Promise.reject(new TypeError('Failed to fetch'));
        return new Promise((resolve) => {
          const rid = 'b' + (++b); buddyWaiting.set(rid, resolve);
          window.bmbBuddy(JSON.stringify({ rid, url: abs, body: init?.body ?? null }));
        }).then((r) => new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } }));
      }
      return real.call(this, input, init);
    };
  })();
` });

// ---- helpers ----------------------------------------------------------------------------
const until = async (expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(`!!(${expr})`).catch(() => false)) return true; await wait(250); }
  return false;
};
const untilNode = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(150); }
  return false;
};
const go = async (path) => { await send('Page.navigate', { url: `${APP}${path}` }); await wait(1200); };
const dialogText = () => js(`document.querySelector('[role="dialog"]')?.innerText ?? ''`);
const pressInDialog = (re) => js(`(() => {
  const b = [...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find((x) => ${re}.test(x.innerText) && !x.disabled);
  if (!b) return false; b.click(); return true; })()`);
const seed = (shareAs) => js(`(() => {
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([LOCAL]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(userNpub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:nwc_uri', ${JSON.stringify(NWC_URI)});
  localStorage.setItem('bmb:share_nostr', '1');
  localStorage.setItem('bmb:share_nostr_as', ${JSON.stringify(shareAs)});
  localStorage.setItem('bmb:fav_privacy:${userNpub}', 'off');
  return 1; })()`);
const tagsOf = (e, name) => (e?.tags ?? []).filter((x) => x[0] === name);
const tag1 = (e, name) => tagsOf(e, name)[0] ?? null;
const BUDDY_WORDS = /boostmebuddy|boost ?me ?buddy/i;
const BITCH_WORDS = /boostmebitch|boost ?me ?bitch/i;
const wordsIn = (e) => `${e?.content ?? ''}\n${JSON.stringify(e?.tags ?? [])}`;
/** The note as published, for the log: the body, then the tags. */
const show = (e) => {
  if (!e) return;
  for (const l of e.content.split('\n')) console.log(`    | ${l}`);
  for (const x of e.tags) console.log(`    # ${JSON.stringify(x)}`);
};

/**
 * Open `feedUrl` as a playlist, press BOOST on the row titled `title`, send 100 sats with
 * the share picker on `shareAs`. `buddy` is how the page treats Buddy's signing routes:
 * 'nocors' (unreadable) or 'proxy' (handed to this script). Returns once the publish
 * status settles (published, or failed).
 */
async function boostSong(feedUrl, title, shareAs, buddy = 'nocors') {
  await go('/');
  await seed(shareAs);
  await js(`localStorage.setItem('__e2eBuddy', ${JSON.stringify(buddy)}); 1`);
  await go(`/?playlist=${encodeURIComponent(feedUrl)}`);
  const row = `[...document.querySelectorAll('ul.divide-y > li')].find((li) => li.innerText.includes(${JSON.stringify(title)}))`;
  const listed = await until(`${row}?.querySelector('button.btn-bolt')`, 60000);
  t.ok(`the row "${title}" has a BOOST button`, listed);
  if (!listed) return false;
  await js(`${row}.querySelector('button.btn-bolt').click()`);
  t.ok('the boost modal opens', await until(`document.querySelector('[role="dialog"]')`, 20000));
  await js(`(() => {
    const i = document.querySelector('[role="dialog"] input[inputmode="numeric"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '100');
    i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  t.ok('Send 100 sats is live', await until(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => /send 100 sat/i.test(b.innerText) && !b.disabled)`, 30000), await dialogText());
  await pressInDialog('/send 100 sat/i');
  const settled = await until(`/Published to|Publish failed/.test(document.querySelector('[role="dialog"]')?.innerText ?? '')`, 45000);
  t.ok('the note publish settles (published or failed)', settled, await dialogText());
  return settled;
}
const newNote = async (before, ms = 8000) => {
  await untilNode(() => published.slice(before).some((e) => e.kind === 1 && tagsOf(e, 't').some((x) => x[1] === 'boostagram')), ms);
  return published.slice(before).filter((e) => e.kind === 1 && tagsOf(e, 't').some((x) => x[1] === 'boostagram')).at(-1) ?? null;
};

// ---- 1. a BMB-hosted playlist, "My feed" -------------------------------------------------
section('1. a song from a playlist BMB hosts, shared to my feed: Buddy\'s words, the album, the Heard-on line');
let before = published.length;
let paidBefore = wallet.payments.length;
await boostSong(created.feedUrl, song.title, 'self');
const n1 = await newNote(before);
t.ok('a kind:1 boost note reached the LOCAL relay', !!n1);
show(n1);
t.equal('it is signed by the listener', n1?.pubkey, userPk);
t.ok(`the header names the song's OWN album: "→ ${song.feedTitle}"`, n1?.content.includes(` boosted 100 sats → ${song.feedTitle}\n`), n1?.content);
t.ok('the header does not name the playlist', !n1?.content.includes(`→ ${PLAYLIST_TITLE}`), n1?.content);
t.ok(`📻 ${song.title}`, n1?.content.includes(`📻 ${song.title}`), n1?.content);
t.ok(`🎧 Heard on ${PLAYLIST_TITLE} by nostr:<maker npub>`, n1?.content.includes(`🎧 Heard on ${PLAYLIST_TITLE} by nostr:${makerNpub}`), n1?.content);
const lines1 = n1?.content.split('\n') ?? [];
const heard1 = lines1.indexOf(`🎧 Heard on ${PLAYLIST_TITLE} by nostr:${makerNpub}`);
t.equal(`the next line is the playlist's link, on the hosted origin (${HOSTED_ORIGIN})`, lines1[heard1 + 1], `${HOSTED_ORIGIN}/?podcast=${encodeURIComponent(PL_GUID)}`);
t.ok('the Heard-on lines come after the 📻 line and before the listen links', heard1 > lines1.indexOf(`📻 ${song.title}`) && lines1.indexOf(`📻 ${song.title}`) > 0
  && lines1.findIndex((l) => l.startsWith(`${BUDDY.origin}/?podcast=`)) > heard1 + 1, n1?.content);
t.ok("the maker's npub is printed once, not again in the trailing run", (n1?.content.split(`nostr:${makerNpub}`).length ?? 0) - 1 === 1, n1?.content);
t.ok('a p tag names the maker', tagsOf(n1, 'p').some((x) => x[1] === makerPk), JSON.stringify(tagsOf(n1, 'p')));
t.equal('client = BoostMeBuddy', tag1(n1, 'client'), ['client', BUDDY.wireName]);
t.ok(`imeta is on ${BUDDY.origin}/api/og/boost.png?`, tag1(n1, 'imeta')?.[1]?.startsWith(`url ${BUDDY.origin}/api/og/boost.png?`), JSON.stringify(tag1(n1, 'imeta')));
t.ok('the banner in the body is on Buddy', n1?.content.includes(`${BUDDY.origin}/api/og/boost.png?`), n1?.content);
t.ok("the default sender name is Buddy's", n1?.content.includes(`${BUDDY.senderName} boosted 100 sats`), n1?.content);
t.ok('every r tag is an http(s) URL, the deep link on Buddy', tagsOf(n1, 'r').some((x) => x[1].startsWith(`${BUDDY.origin}/?podcast=${encodeURIComponent(song.podcastGuid)}`)), JSON.stringify(tagsOf(n1, 'r')));
const iTags = tagsOf(n1, 'i').map((x) => x[1]);
t.equal("the FIRST i tags are the song's own feed, then its item", iTags.slice(0, 2), [`podcast:guid:${song.podcastGuid}`, `podcast:item:guid:${song.guid}`]);
t.ok("the playlist's own podcast:guid i tag is kept, after them", iTags.indexOf(`podcast:guid:${PL_GUID}`) > 1, JSON.stringify(iTags));
t.ok('no word of the other brand anywhere in the note', !BITCH_WORDS.test(wordsIn(n1)), wordsIn(n1));
const pay1 = wallet.payments.slice(paidBefore);
t.equal('one payment, a keysend to the stub node', pay1.map((p) => [p.method, p.params?.pubkey]), [['pay_keysend', STUB_NODE]]);
const bg1 = boostagramOf(pay1[0]);
t.equal('the boostagram still says app_name BoostMeBitch', bg1?.app_name, BITCH.wireName);
t.equal("the boostagram's sender name is the deploy's own", bg1?.sender_name, BITCH.senderName);
t.equal("the boostagram's remote_feed_guid is the song's album", bg1?.remote_feed_guid, song.podcastGuid);

// ---- 2. "Anonymous", while Buddy's route cannot be read ------------------------------------
section("2. Anonymous, Buddy's signing route unreadable (no CORS yet): the note fails, never the bitch key");
before = published.length;
paidBefore = wallet.payments.length;
const signBefore = rec.sign.length;
await boostSong(created.feedUrl, song.title, 'site');
t.ok('the payment still went out', wallet.payments.length - paidBefore === 1, `payments +${wallet.payments.length - paidBefore}`);
t.ok('the modal says the publish failed', /Publish failed/.test(await dialogText()), await dialogText());
const asked2 = rec.sign.slice(signBefore);
t.equal('the page asked Buddy\'s site-sign route, and only that', asked2.map((x) => x.url), [`${BUDDY.origin}/api/nostr/site-sign`]);
const tmpl2 = (() => { try { return JSON.parse(asked2[0]?.body ?? 'null'); } catch { return null; } })();
t.equal('the template it sent says client BoostMeBuddy', tag1(tmpl2, 'client'), ['client', BUDDY.wireName]);
t.ok("the template's imeta passes Buddy's own banner rule", tag1(tmpl2, 'imeta')?.[1]?.startsWith(`url ${BUDDY.origin}/api/og/boost.png?`), JSON.stringify(tag1(tmpl2, 'imeta')));
t.ok("the template names Buddy's anonymous sender", tmpl2?.content?.includes(`${BUDDY.senderName} boosted 100 sats`), tmpl2?.content);
t.ok('the template is within the route limits (2000 / 40 / 4096)',
  (tmpl2?.content?.length ?? 9e9) <= 2000 && (tmpl2?.tags?.length ?? 99) <= 40
  && (tmpl2?.tags ?? []).flat().reduce((s, x) => s + x.length, 0) <= 4096);
await wait(2500);
t.equal('no boost note reached any relay', published.slice(before).filter((e) => e.kind === 1).length, 0);
t.ok('nothing signed by the bitch site key, ever', !published.some((e) => e.pubkey === BITCH_SITE_PK));
const bg2 = boostagramOf(wallet.payments.at(-1));
t.ok('the anonymous boostagram drops sender_id and keeps the deploy\'s default name', bg2 && bg2.sender_id === undefined && bg2.sender_name === BITCH.senderName && bg2.app_name === BITCH.wireName, JSON.stringify(bg2));

// ---- 3. "Anonymous", signed by Buddy production -------------------------------------------
section('3. Anonymous, signed by Buddy production (needs PR 4 live there)');
let skip3 = OFFLINE ? '--offline' : null;
if (!skip3) {
  const probe = await fetch(`${BUDDY.origin}/api/nostr/site-sign`, {
    method: 'OPTIONS',
    headers: { Origin: BITCH.origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    signal: AbortSignal.timeout(10000),
  }).catch((e) => ({ error: e }));
  const allow = probe.headers?.get?.('access-control-allow-origin');
  if (probe.error) skip3 = `${BUDDY.origin} could not be reached (${probe.error.message})`;
  else if (allow !== BITCH.origin && !FORCE_BUDDY) skip3 = `${BUDDY.origin}/api/nostr/site-sign answers ${probe.status} with no CORS for ${BITCH.origin} — PR 4 (buddy-sign-cors) is not live there yet`;
  else if (allow !== BITCH.origin) console.log(`  --force-buddy: no CORS for ${BITCH.origin} on Buddy yet; asking it from this script anyway`);
}
if (skip3) {
  console.log(`  SKIP  ${skip3}`);
} else {
  before = published.length;
  await boostSong(created.feedUrl, song.title, 'site', 'proxy');
  const n3 = await newNote(before, 15000);
  show(n3);
  t.equal('Buddy was asked once, for the note', buddyAsked.map((x) => x.url), [`${BUDDY.origin}/api/nostr/site-sign`]);
  t.ok('the note reached the LOCAL relay', !!n3);
  t.equal("its author is Buddy's site key", n3?.pubkey, BUDDY_SITE_PK);
  t.equal('client = BoostMeBuddy', tag1(n3, 'client'), ['client', BUDDY.wireName]);
  t.ok(`🎧 Heard on ${PLAYLIST_TITLE}`, n3?.content.includes(`🎧 Heard on ${PLAYLIST_TITLE} by nostr:${makerNpub}`), n3?.content);
  t.ok('no word of the other brand anywhere in it', !BITCH_WORDS.test(wordsIn(n3)), wordsIn(n3));
}

// ---- 4. one of the seven existing community feeds, "My feed" ------------------------------
section("4. a song from an existing community feed (Lightning Thrashes): the deploy's own words, with the Heard-on line");
const cf = await fetch(`${APP}/api/playlist?url=${encodeURIComponent(COMMUNITY_FEED)}&limit=10`, { headers: { 'x-real-ip': ip() } }).then((r) => r.json()).catch(() => ({}));
const cfSong = (cf.episodes ?? []).find((e) => !e.unresolved && e.title && e.podcastGuid && e.guid);
t.ok('the community feed reads, with a resolved first song', !!cfSong && !!cf.podcast?.title, JSON.stringify({ title: cf.podcast?.title, first: cfSong?.title }));
before = published.length;
paidBefore = wallet.payments.length;
if (cfSong) {
  await boostSong(COMMUNITY_FEED, cfSong.title, 'self');
  const n4 = await newNote(before);
  t.ok('a kind:1 boost note reached the LOCAL relay', !!n4);
  show(n4);
  t.equal('client = BoostMeBitch', tag1(n4, 'client'), ['client', BITCH.wireName]);
  t.ok(`🎧 Heard on ${cf.podcast.title}`, n4?.content.includes(`🎧 Heard on ${cf.podcast.title}`), n4?.content);
  if (cf.podcast.podcastGuid) {
    t.ok(`its playlist link is a line of its own, on ${BITCH.origin}`, (n4?.content.split('\n') ?? []).includes(`${BITCH.origin}/?podcast=${encodeURIComponent(cf.podcast.podcastGuid)}`), n4?.content);
    t.ok("the playlist's podcast:guid i tag is kept, after the song's", tagsOf(n4, 'i').findIndex((x) => x[1] === `podcast:guid:${cf.podcast.podcastGuid}`) > 1, JSON.stringify(tagsOf(n4, 'i')));
  }
  t.ok(`the header names the song's own album: "→ ${cfSong.feedTitle}"`, !cfSong.feedTitle || n4?.content.includes(` boosted 100 sats → ${cfSong.feedTitle}\n`), n4?.content);
  t.ok('no Buddy words anywhere in the note', !BUDDY_WORDS.test(wordsIn(n4)), wordsIn(n4));
  t.ok(`imeta is on ${BITCH.origin}`, tag1(n4, 'imeta')?.[1]?.startsWith(`url ${BITCH.origin}/api/og/boost.png?`), JSON.stringify(tag1(n4, 'imeta')));
  const bg4 = boostagramOf(wallet.payments.slice(paidBefore)[0]);
  t.equal('the boostagram says app_name BoostMeBitch', bg4?.app_name, BITCH.wireName);
}

// ---- nothing left the machine -------------------------------------------------------------
section('nothing left the machine');
const { events, ws: sockets, sign: signAsked } = rec;
t.ok('every EVENT the page sent went to the local relay', events.length > 0 && events.every((e) => e.to.startsWith(LOCAL)), JSON.stringify(events.filter((e) => !e.to.startsWith(LOCAL))));
t.equal('no socket of any kind reached a public relay', sockets.filter((s) => !s.to.startsWith(LOCAL) && !s.to.includes(new URL(APP).host)), []);
const notes = events.filter((e) => e.kind === 1);
console.log(`  (${sockets.length} sockets, ${events.length} EVENT frames, ${notes.length} of them kind:1, asked for: ${[...new Set(notes.map((e) => e.asked))].join(', ')})`);
console.log(`  (the page asked for ${new Set(sockets.filter((s) => s.to !== s.asked).map((s) => s.asked)).size} public relay URL(s); each went to the local relay instead)`);
t.equal("this deploy's own signing routes were never asked", signAsked.filter((x) => x.url.startsWith(APP)).map((x) => x.url), []);
t.ok('every payment was a keysend to the stub node', wallet.payments.length > 0 && wallet.payments.every((p) => p.method === 'pay_keysend' && p.params?.pubkey === STUB_NODE), JSON.stringify(wallet.payments.map((p) => [p.method, p.params?.pubkey])));

// ---- tidy: the maker deletes the stored playlist --------------------------------------------
{
  const url = `${APP}/api/community-playlists/${created.id}`;
  const token = await getToken(url, 'DELETE', signAs(makerSk), true);
  const r = await fetch(url, { method: 'DELETE', headers: { Authorization: token, 'x-real-ip': nodeIp } });
  t.equal('the maker deleted the stored playlist', r.status, 200);
}

console.log(`\n${t.fails ? `${t.fails} of ${t.count} checks FAILED.` : `All ${t.count} checks passed.`}${skip3 ? ` (section 3 skipped: ${skip3})` : ''}`);
try { walletWs.close(); relay.close(); } catch { /* already gone */ }
await exit(t.fails ? 1 : 0);
