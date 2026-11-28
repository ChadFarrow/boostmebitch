// e2e for ⚡ ZAP on a community playlist (components/lists/playlist-zap.tsx), in a
// real browser at 390 x 844 under CDP device emulation (mobile: true).
//
// Needs a dev server started with the switch, on the command line:
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on npm run dev -- -p 3125
// The switch-OFF half is a second run against a server started WITHOUT it:
//   npm run dev -- -p 3125   then   node scripts/e2e-playlist-zap.mjs --off
// APP_URL overrides the server, on this machine only (scripts/local-target.mjs).
//
// NO SATS MOVE AND NOTHING REACHES A PUBLIC RELAY OR LNURL SERVER:
//   - `/api/playlist` is answered by CDP Fetch interception with a stub playlist,
//     so no database is needed and the maker is whichever key the test names;
//   - every relay socket the page opens is redirected to a LOCAL relay, which
//     holds the makers' kind:0 events (the page's own dev-server socket is not);
//   - the maker's LNURL endpoints are a `.test` host answered by interception,
//     and `/api/lnurl` (the server fallback) is answered 502 and counted;
//   - the wallet is a stub `window.webln` that records the invoice it is handed.
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { localAppUrl } from './local-target.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import { bech32 } from '@scure/base';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const OFF = process.argv.includes('--off');
const APP = localAppUrl('http://localhost:3125');
await requireApp(APP, `Nothing is serving ${APP}. Start the dev server (see the top of this file).`);

// ---- keys and profiles -------------------------------------------------------
const key = () => { const sk = generateSecretKey(); const pk = getPublicKey(sk); return { sk, pk, npub: nip19.npubEncode(pk) }; };
const viewer = key();
const maker = key();     // lud16 on a zap-capable provider
const noZaps = key();    // lud16 on a provider without allowsNostr
const noAddr = key();    // a kind:0 with no Lightning address
const noProfile = key(); // no kind:0 at all: what a guest key looks like
const STUB = 'zap-stub.test';
// LONG on purpose: its LNURL is past bech32's 90-character default, like every
// real address (`sirtjthewrathful@getalby.com` is 100). A short stub address hid
// "Length 100 exceeds limit 90" until Chad hit it on beta (2026-11-25).
const MAKER_LN = 'a-playlist-maker-with-a-long-lightning-name';
const MAKER_NAME = 'E2E Maker';

const relay = createRelay({ port: 0, log: null });
const PORT = await relay.ready;
const LIVE = `ws://127.0.0.1:${PORT}`;
const DEAD = 'ws://127.0.0.1:9'; // discard port: refused at once, so the read is degraded
// A relay that accepts and then never answers: the read waits its full 4 s, as
// it does on a phone behind a slow relay, and then settles degraded.
const silent = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => silent.on('listening', r));
const SILENT = `ws://127.0.0.1:${silent.address().port}`;
const now = Math.floor(Date.now() / 1000);
const profile = (k, content) => {
  const e = finalizeEvent({ kind: 0, created_at: now - 60, tags: [], content: JSON.stringify(content) }, k.sk);
  relay.events.set(e.id, e);
};
profile(maker, { name: 'e2emaker', display_name: MAKER_NAME, lud16: `${MAKER_LN}@${STUB}` });
profile(noZaps, { name: 'nozaps', lud16: `nozap@${STUB}` });
profile(noAddr, { name: 'noaddr', about: 'no lightning here' });

// ---- stub playlists ----------------------------------------------------------
const ORIGIN = 'https://www.boostmebuddy.com'; // COMMUNITY_FEED_ORIGIN's default
const hosted = () => `${ORIGIN}/feeds/playlists/${randomUUID()}.xml`;
const playlists = new Map();
const stubPlaylist = (feedUrl, title, npubs) => {
  const guid = randomUUID();
  playlists.set(feedUrl, {
    podcast: {
      id: -(Math.floor(Math.random() * 1e9) + 1), podcastGuid: guid, title, description: 'e2e playlist',
      image: '', artwork: '', url: feedUrl, medium: 'musicL', isPreview: true, author: 'Typed Name',
      nostrNpubs: npubs.map((k) => ({ npub: k.npub, pubkey: k.pk })),
    },
    episodes: [], total: 0, offset: 0, nextOffset: null, notFound: 0, couldNotAsk: 0,
  });
  return { feedUrl, guid };
};
const A = stubPlaylist(hosted(), 'Zap Test Brunch', [maker]);
const NOZAPS = stubPlaylist(hosted(), 'No Zaps Here', [noZaps]);
const NOADDR = stubPlaylist(hosted(), 'No Address', [noAddr]);
const NOPROFILE = stubPlaylist(hosted(), 'Guest Made', [noProfile]);
const TWO = stubPlaylist(hosted(), 'Two Keys', [maker, noAddr]);
const THIRD = stubPlaylist('https://feeds.example.org/e2e-playlist.xml', 'Someone Elses Feed', [maker]);
const UNREAD = stubPlaylist(hosted(), 'Relays Down', [maker]);

// ---- stub LNURL ----------------------------------------------------------------
const callbacks = []; // every invoice request the page made
const lnurlProxyHits = [];
/** guid -> what /api/community-playlists/maker-hint answers (absent: 404). */
const makerHints = new Map();
const PAYEE_ZAPPER = getPublicKey(generateSecretKey());
const payRequest = (name, allowsNostr) => ({
  tag: 'payRequest', callback: `https://${STUB}/cb/${name}`, minSendable: 1000, maxSendable: 100_000_000_000,
  metadata: JSON.stringify([['text/plain', `${name} e2e`]]), commentAllowed: 200,
  ...(allowsNostr ? { allowsNostr: true, nostrPubkey: PAYEE_ZAPPER } : {}),
});

// ---- the browser ---------------------------------------------------------------
const { page } = await launchChrome({ name: `playlistzap-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`, args: ['--disable-gpu'] });
const { send, js } = page;
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/playlist?*', requestStage: 'Request' },
  { urlPattern: '*/api/lnurl*', requestStage: 'Request' },
  // The stored hint has no database here: each test sets what the route answers.
  { urlPattern: '*/api/community-playlists/maker-hint*', requestStage: 'Request' },
  { urlPattern: `https://${STUB}/*`, requestStage: 'Request' },
] });
page.on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  let status = 200;
  let body;
  if (u.hostname === STUB) {
    if (u.pathname === `/.well-known/lnurlp/${MAKER_LN}`) body = payRequest('maker', true);
    else if (u.pathname === '/.well-known/lnurlp/nozap') body = payRequest('nozap', false);
    else if (u.pathname.startsWith('/cb/')) {
      callbacks.push(request.url);
      const sats = Number(u.searchParams.get('amount')) / 1000;
      body = { pr: `lnbc${sats * 10}n1pe2estubinvoice`, routes: [] };
    } else { status = 404; body = { status: 'ERROR', reason: 'no such stub' }; }
  } else if (u.pathname === '/api/community-playlists/maker-hint') {
    const h = makerHints.get(u.searchParams.get('guid'));
    if (h) body = h; else { status = 404; body = { error: 'not found' }; }
  } else if (u.pathname.startsWith('/api/lnurl')) {
    lnurlProxyHits.push(request.url);
    status = 502; body = { error: 'blocked by e2e' };
  } else {
    const feed = u.searchParams.get('url');
    if (playlists.has(feed)) body = playlists.get(feed);
    else { status = 404; body = { error: 'not found' }; }
  }
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  });
});

// The signer: whichever key `cur` names, behind a NIP-07 `window.nostr`.
let cur = viewer;
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = cur.pk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], cur.sk);
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
    // The celebration, recorded rather than watched. A ping is a play() of
    // boost.mp3 that is NOT paused in the same turn (the prime pauses at once,
    // docs/money-boosts.md, "Success celebration"); recorded whether or not the
    // muted, gesture-less play() is then allowed. Confetti is a canvas added to
    // the page, the zap's bolt a [data-zap-bolt] node; each removes itself when
    // it ends, so they are counted as they arrive.
    window.__pings = 0; window.__confetti = 0; window.__bolts = 0;
    const play = HTMLMediaElement.prototype.play, pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function (...a) {
      const el = this, src = el.currentSrc || el.src || '';
      el.__justPlayed = true;
      queueMicrotask(() => { if (el.__justPlayed && /boost\.mp3/.test(src)) window.__pings++; el.__justPlayed = false; });
      return play.apply(el, a);
    };
    HTMLMediaElement.prototype.pause = function (...a) { this.__justPlayed = false; return pause.apply(this, a); };
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeName === 'CANVAS') window.__confetti++; if (n.nodeType === 1 && n.hasAttribute('data-zap-bolt')) { window.__bolts++; window.__boltMoves = (n.firstElementChild?.getAnimations?.() ?? []).some((a) => a.effect.getKeyframes().some((k) => k.transform)); } } })
      .observe(document, { childList: true, subtree: true });
    // The stub wallet. It pays nothing: it records the invoice and hands back a preimage.
    window.__paid = [];
    window.webln = {
      enable: async () => {}, getInfo: async () => ({ node: { alias: 'e2e stub' } }), getBalance: async () => ({ balance: 0 }),
      sendPayment: async (pr) => { window.__paid.push(pr); return { preimage: 'ab'.repeat(32) }; },
    };
    // Every relay socket goes to THIS machine. The target is read per socket, so a
    // test can take the relays down and bring them back without a reload.
    window.__relayTarget = localStorage.getItem('e2e:relay') || ${JSON.stringify(LIVE)};
    window.__relayAsked = [];
    const Real = window.WebSocket;
    function Redirected(url, protocols) {
      const u = String(url);
      const local = /^wss?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/_next\\//.test(u);
      if (!local) window.__relayAsked.push(u);
      const target = local ? u : window.__relayTarget;
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
const TILE = `document.querySelector('[data-playlist-zap]')`;
const PENDING = `document.querySelector('[data-playlist-zap-pending]')`;
const HEADER_READY = `[...document.querySelectorAll('main button, main a')].some((b) => b.classList.contains('tile') && /SHARE/.test(b.textContent))`;
const DIALOG_NAMES = `[...document.querySelectorAll('[role=dialog]')].map((d) => document.getElementById(d.getAttribute('aria-labelledby'))?.textContent ?? '')`;
const zapDialog = `[...document.querySelectorAll('[role=dialog]')].find((d) => (document.getElementById(d.getAttribute('aria-labelledby'))?.textContent ?? '').startsWith('Zap '))`;
const overflowFree = () => js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`);
// SHOTS=<dir> saves the header, the dialog and the zap's bolt as PNGs, for a look by eye.
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(process.env.SHOTS, { recursive: true });
  writeFileSync(`${process.env.SHOTS}/${name}.png`, Buffer.from(result.data, 'base64'));
};

await send('Page.navigate', { url: APP });
await wait(800);
const setup = async ({ as, relayTarget = LIVE }) => {
  cur = as ?? viewer;
  await js(`(() => {
    localStorage.clear();
    localStorage.setItem('e2e:relay', ${JSON.stringify(relayTarget)});
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([LIVE]))});
    ${as ? `localStorage.setItem('bmb:npub', ${JSON.stringify(as.npub)}); localStorage.setItem('bmb:signer', 'nip07');
    localStorage.setItem('bmb:fav_privacy:${as.npub}', 'off');` : ''}
    return 1; })()`);
};
const open = async (pl) => {
  await send('Page.navigate', { url: `${APP}/?playlist=${encodeURIComponent(pl.feedUrl)}` });
  return waitFor(HEADER_READY, 45000);
};
// "No tile" is only a claim once the read has had its time.
// The pending tile goes too: a place held for a zap that cannot happen is a lie.
const noTileAfterRead = async () => { await wait(6000); return js(`!${TILE} && !${PENDING}`); };
// Where SHARE sits, to prove the row did not reflow when ZAP arrived.
const shareRect = () => js(`(() => { const b = [...document.querySelectorAll('main .tile')].find((x) => /SHARE/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; })()`);
const clickTile = () => js(`(() => { const b = ${TILE}; if (b) b.click(); return !!b; })()`);
const setValue = (sel, v) => js(`(() => { const el = ${sel};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
const RSS_TILE = `button[title="Copy this playlist's RSS feed URL"]`;
const closeDialog = () => js(`(() => { const d = ${zapDialog}; d?.querySelector('button[aria-label=Close]')?.click(); return !!d; })()`);

if (OFF) {
  console.log('--- OFF: a server WITHOUT NEXT_PUBLIC_COMMUNITY_PLAYLISTS: production, where the feeds still play ---');
  await setup({ as: viewer });
  t.ok('the hosted playlist opens', await open(A));
  t.ok('no ZAP tile with the switch off', await noTileAfterRead());
  t.ok('the RSS tile is there with the switch off (every deploy)', await js(`!!document.querySelector(${JSON.stringify(RSS_TILE)})`));
  t.equal('no LNURL request', callbacks.length, 0);
  console.log(`\n${t.count - t.fails}/${t.count} passed`);
  relay.close();
  await exit(t.fails ? 1 : 0);
}

// ---- 1. signed in, the maker has a zap-capable address -----------------------
console.log('--- 1. signed in: the tile, the dialog, and one stubbed zap (390 x 844) ---');
// The bolt's motion depends on this, so pin it rather than inherit the Mac's setting.
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await setup({ as: viewer });
t.ok('the hosted playlist opens', await open(A));
// No reflow: the ZAP slot is in the row the moment SHARE is (Chad, 2026-11-25:
// the row painted three tiles and jumped to four "after a bit").
t.ok('the ZAP slot is in the row as soon as SHARE paints', await js(`!!(${TILE} || ${PENDING})`));
const shareFirst = await shareRect();
t.ok('the ZAP tile appears once the maker\'s kind:0 is read', await waitFor(TILE, 20000));
t.ok('...the held place is gone', await js(`!${PENDING}`));
t.equal('...and SHARE did not move when it arrived', await shareRect(), shareFirst);
// Two different marks: with one, SHARE and RSS read as two SHARE buttons.
t.ok('the RSS tile has its own mark, not the share mark', await js(`(() => {
  const tiles = [...document.querySelectorAll('main .tile')];
  const share = tiles.find((x) => /SHARE/.test(x.textContent))?.querySelector('svg')?.innerHTML;
  const rss = document.querySelector(${JSON.stringify(RSS_TILE)})?.querySelector('svg')?.innerHTML;
  return !!share && !!rss && share !== rss; })()`));
t.equal('the tile says ZAP', await js(`${TILE}.innerText.trim()`), 'ZAP');
const row = await js(`(() => { const z = ${TILE}; const cells = [...z.parentElement.children].filter((c) => c.getBoundingClientRect().width > 0);
  return { labels: cells.map((c) => c.innerText.trim()), tops: [...new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top)))], w: Math.round(z.getBoundingClientRect().width), h: Math.round(z.getBoundingClientRect().height) }; })()`);
// The RSS tile is on every playlist, on beta and off it, and the address is not
// written out under the title (Chad, 2026-11-25: one control, beside SHARE).
const words = (row?.labels ?? []).map((l) => l.split(/\s+/).pop());
t.equal('the row is FAV / SHARE / RSS / ZAP', words, ['FAV', 'SHARE', 'RSS', 'ZAP']);
t.equal('all four tiles on ONE row at 390 px', row?.tops.length, 1);
t.ok('no RSS address written out under the title', await js(`!document.querySelector('[data-feed-address]')`));
t.ok('the tile is at least 24 x 24', row && row.w >= 24 && row.h >= 24, JSON.stringify(row));
t.ok('no horizontal overflow at 390 px', await overflowFree());
console.log(`      row: ${JSON.stringify(row)}`);
await shot('1-header');

t.ok('a press opens the zap dialog', (await clickTile()) && await waitFor(zapDialog, 8000));
t.equal('the dialog names the maker from the kind:0', await js(`${DIALOG_NAMES}.find((n) => n.startsWith('Zap '))`), `Zap ${MAKER_NAME}`);
const sub = await js(`${zapDialog}.innerText`);
t.ok('it says which playlist and which address', sub.includes(`For the playlist “Zap Test Brunch”, to ${MAKER_LN}@zap-stub.test.`), sub);
t.equal('the amount opens at 100 (no saved default)', await js(`${zapDialog}.querySelector('input[type=number]').value`), '100');
t.ok('the dialog fits at 390 px', await overflowFree());
await shot('2-dialog');
await setValue(`${zapDialog}.querySelector('input[type=text]')`, 'thanks for the brunch');
t.ok('Send names the amount', await js(`[...${zapDialog}.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Send 100 sats')`));
await js(`[...${zapDialog}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send 100 sats').click()`);
t.ok('the dialog says it zapped', await waitFor(`/zapped 100 sats/i.test(${zapDialog}?.innerText ?? '')`, 15000), await js(`${zapDialog}?.innerText`));
t.ok('...and the lightning bolt strikes', await waitFor(`window.__bolts === 1`, 5000), String(await js(`window.__bolts`)));
t.equal('...and moves (no reduced motion here)', await js(`window.__boltMoves`), true);
t.ok('...and it is the logo bolt, loaded', await js(`(() => { const i = document.querySelector('[data-zap-bolt] img'); return !!i && i.getAttribute('src') === '/icons/bmb/zap-bolt.svg' && i.complete && i.naturalWidth > 0; })()`), await js(`document.querySelector('[data-zap-bolt] img')?.getAttribute('src')`));
const boltStyle = await js(`(() => { const b = document.querySelector('[data-zap-bolt]'); if (!b) return null; const cs = getComputedStyle(b); return { pe: cs.pointerEvents, z: Number(cs.zIndex), w: Math.round(b.firstElementChild.getBoundingClientRect().width) }; })()`);
t.ok('...it blocks no tap and stays under the status-bar strip (z 70)', boltStyle && boltStyle.pe === 'none' && boltStyle.z < 70, JSON.stringify(boltStyle));
await wait(250); await shot('1-bolt');
t.equal('...no confetti: a zap is a bolt, a boost is confetti', await js(`window.__confetti`), 0);
t.equal('...and the boost ping plays once', await js(`window.__pings`), 1);
t.ok('the bolt removes itself', await waitFor(`!document.querySelector('[data-zap-bolt]')`, 4000));
t.ok('the dialog then closes', await waitFor(`!${zapDialog}`, 8000), await js(`${zapDialog}?.innerText`));

t.equal('ONE invoice request reached the maker\'s LNURL callback', callbacks.length, 1);
const cb = new URL(callbacks[0] ?? `https://${STUB}/none`);
t.equal('it asked for 100 sats', cb.searchParams.get('amount'), '100000');
t.equal('the LUD-21 comment is the typed message', cb.searchParams.get('comment'), 'thanks for the brunch');
const zr = JSON.parse(cb.searchParams.get('nostr') ?? '{}');
const tag = (n) => (zr.tags ?? []).filter((x) => x[0] === n);
t.equal('the zap request is a kind:9734', zr.kind, 9734);
t.ok('signed by the VIEWER, and the signature verifies', zr.pubkey === viewer.pk && verifyEvent(zr), zr.pubkey);
t.equal('exactly one p tag: the maker', tag('p').map((x) => x[1]), [maker.pk]);
t.equal('the amount tag', tag('amount').map((x) => x[1]), ['100000']);
const lnurl = bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(`https://${STUB}/.well-known/lnurlp/${MAKER_LN}`)), false);
t.ok('the maker\'s LNURL is past 90 characters (the beta bug)', lnurl.length > 90, String(lnurl.length));
t.equal('the lnurl tag is the maker\'s address', tag('lnurl').map((x) => x[1]), [lnurl]);
t.equal('the lnurl query parameter agrees', cb.searchParams.get('lnurl'), lnurl);
t.equal('the content is the typed message', zr.content, 'thanks for the brunch');
t.equal('no e tag: a profile zap', tag('e').length, 0);
t.equal('no client tag', tag('client').length, 0);
t.equal('the k tag names a podcast guid', tag('k').map((x) => x[1]), ['podcast:guid']);
const iTag = tag('i')[0] ?? [];
t.equal('the i tag names the PLAYLIST', iTag[1], `podcast:guid:${A.guid}`);
// The boost summary receipt's hint (`receiptRefUrls`): `?podcast=`, on the Buddy
// origin from any deploy (`noteBrandFor`), never this dev server's address.
t.equal('...with the Buddy ?podcast= link as its hint', iTag[2], `${ORIGIN}/?podcast=${A.guid}`);
t.ok('relays tag: 1 to 8 relays', tag('relays').length === 1 && tag('relays')[0].length >= 2 && tag('relays')[0].length <= 9);
t.equal('the stub wallet paid exactly that invoice, once', await js(`window.__paid`), ['lnbc1000n1pe2estubinvoice']);
t.equal('the server LNURL fallback was never used', lnurlProxyHits.length, 0);
t.equal('nothing was published to a relay', [...relay.events.values()].filter((e) => e.kind !== 0).map((e) => e.kind), []);

// ---- 2. the provider does not support zaps -------------------------------------
console.log('--- 2. a provider without allowsNostr: refused before any invoice ---');
callbacks.length = 0;
await setup({ as: viewer });
t.ok('the playlist opens', await open(NOZAPS));
t.ok('the tile appears (the address exists)', await waitFor(TILE, 20000));
t.ok('the dialog opens', (await clickTile()) && await waitFor(zapDialog, 8000));
await js(`[...${zapDialog}.querySelectorAll('button')].find((b) => /^Send /.test(b.textContent.trim())).click()`);
t.ok('the dialog says the provider does not support zaps', await waitFor(`/does not support Nostr zaps/.test(${zapDialog}?.innerText ?? '')`, 10000), await js(`${zapDialog}?.innerText`));
t.equal('no invoice was requested', callbacks.length, 0);
t.equal('the wallet was not asked', await js(`window.__paid.length`), 0);
t.equal('no bolt on a refusal', await js(`window.__bolts`), 0);
t.equal('no ping on a refusal (the prime is not a ping)', await js(`window.__pings`), 0);
t.ok('Send is on again (nothing was attempted)', await js(`![...${zapDialog}.querySelectorAll('button')].find((b) => /^Send /.test(b.textContent.trim()))?.disabled`));
await closeDialog();

// ---- 3. no tile where there is nothing to zap, or nobody to trust ---------------
console.log('--- 3. no tile: no address, no profile, the maker is the viewer, a third-party feed, two keys ---');
await setup({ as: viewer });
t.ok('a maker whose kind:0 has no address: opens', await open(NOADDR));
t.ok('...and shows no tile', await noTileAfterRead());
await setup({ as: viewer });
t.ok('a maker with no kind:0 (a guest key): opens', await open(NOPROFILE));
t.ok('...and shows no tile', await noTileAfterRead());
await setup({ as: maker });
t.ok('the maker opens their own playlist', await open(A));
t.ok('...and sees no tile', await noTileAfterRead());
await setup({ as: viewer });
t.ok('a third-party feed naming the same npub: opens', await open(THIRD));
t.ok('...and shows no tile (the payee guard)', await noTileAfterRead());
// Must still work: a playlist this site does NOT host (a v4vmusic feed, say) keeps
// the RSS tile, which is now its only way to its feed address.
t.ok('...but keeps the RSS tile', await js(`!!document.querySelector(${JSON.stringify(RSS_TILE)})`));
t.ok('...and writes no RSS address under the title', await js(`!document.querySelector('[data-feed-address]')`));
await setup({ as: viewer });
t.ok('a hosted playlist naming TWO keys: opens', await open(TWO));
t.ok('...and shows no tile', await noTileAfterRead());

// ---- 4. signed out: the press opens the sign-in sheet -----------------------
console.log('--- 4. signed out ---');
await setup({});
t.ok('signed out, the playlist opens', await open(A));
t.ok('the tile shows', await waitFor(TILE, 20000));
t.ok('a press opens a dialog', (await clickTile()) && await waitFor(`document.querySelector('[role=dialog]')`, 8000));
t.ok('it is the sign-in sheet, not the zap dialog', await js(`!${zapDialog}`), JSON.stringify(await js(DIALOG_NAMES)));
console.log(`      dialogs: ${JSON.stringify(await js(DIALOG_NAMES))}`);

// ---- 5. the relays do not answer: no false "no address" -------------------------
console.log('--- 5. a degraded read: the tile stays, and the dialog does not claim "no address" ---');
callbacks.length = 0;
await setup({ as: viewer, relayTarget: DEAD });
t.ok('the playlist opens with every relay down', await open(UNREAD));
// The slow read is where the held place shows: dimmed, disabled, in the row.
t.ok('while the relays say nothing, the ZAP place is held, disabled', await js(`!!${PENDING} && ${PENDING}.disabled && !${TILE}`));
const shareSlow = await shareRect();
t.ok('the tile shows (an unread profile is not "no address")', await waitFor(TILE, 30000));
t.equal('...and SHARE did not move when it arrived', await shareRect(), shareSlow);
t.ok('a press reads again and opens the dialog', (await clickTile()) && await waitFor(zapDialog, 30000));
const unreadText = await js(`${zapDialog}.innerText`);
t.ok('the dialog says it could not read the profile', /Could not read the maker's Nostr profile/.test(unreadText), unreadText);
t.ok('...and never says "no Lightning address"', !/no Lightning address/.test(unreadText));
t.ok('...and offers no Send', await js(`![...${zapDialog}.querySelectorAll('button')].some((b) => /^Send /.test(b.textContent.trim()))`));
await closeDialog();
await js(`window.__relayTarget = ${JSON.stringify(LIVE)}; 1`);
t.ok('relays back: a press reads again and opens the form', (await clickTile()) && await waitFor(`[...(${zapDialog}?.querySelectorAll('button') ?? [])].some((b) => /^Send /.test(b.textContent.trim()))`, 30000));
await closeDialog();
t.equal('no invoice was requested in this section', callbacks.length, 0);

// ---- 6. the note card's zap, now through the same dialog ---------------------
console.log('--- 6. ⚡ zap on a Nostr note: the shared dialog, unchanged for the note card ---');
callbacks.length = 0;
const note = finalizeEvent({ kind: 1, created_at: now - 30, tags: [['t', 'boostagram'], ['amount', '100000']], content: 'e2e boost note for the note-card zap' }, maker.sk);
relay.events.set(note.id, note);
await setup({ as: viewer });
// Under iOS Reduce Motion the bolt once never showed (Chad, 2026-11-25). This
// zap runs with it on: the bolt must still show, standing still.
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Page.navigate', { url: `${APP}/npub/${maker.npub}` });
const ZAP_ACTION = `document.querySelector('article button[aria-label=Zap]')`;
t.ok('the maker\'s boost note shows, with ⚡ zap', await waitFor(ZAP_ACTION, 45000));
t.ok('⚡ zap opens the dialog', (await js(`(() => { ${ZAP_ACTION}.click(); return 1; })()`)) && await waitFor(zapDialog, 8000));
t.equal('it names the note\'s author', await js(`${DIALOG_NAMES}.find((n) => n.startsWith('Zap '))`), `Zap ${MAKER_NAME}`);
const noteDialog = await js(`${zapDialog}.innerText`);
t.ok('no playlist line on a note zap', !noteDialog.includes('For the playlist'), noteDialog);
t.ok('the note zap\'s placeholder is unchanged', await js(`${zapDialog}.querySelector('input[type=text]').placeholder === 'great post'`));
await js(`[...${zapDialog}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send 100 sats').click()`);
t.ok('the note zap says it zapped', await waitFor(`/zapped 100 sats/i.test(${zapDialog}?.innerText ?? '')`, 15000), await js(`${zapDialog}?.innerText`));
t.ok('...with the bolt, under reduced motion too', await waitFor(`window.__bolts === 1`, 5000));
t.equal('...by opacity alone: no scale, no turn', await js(`window.__boltMoves`), false);
await wait(450); // past the 0.3 s fade-in
await shot('6-still-bolt');
await wait(350);
t.ok('...still on screen at 1 s, with the dialog open and its ✓', await js(`!!document.querySelector('[data-zap-bolt]') && !!document.querySelector('[data-zap-done]')`));
t.equal('...and one ping', await js(`window.__pings`), 1);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
t.ok('the note zap closes', await waitFor(`!${zapDialog}`, 8000), await js(`${zapDialog}?.innerText`));
t.equal('one invoice request', callbacks.length, 1);
const nz = JSON.parse(new URL(callbacks[0] ?? `https://${STUB}/none`).searchParams.get('nostr') ?? '{}');
const ntag = (n) => (nz.tags ?? []).filter((x) => x[0] === n);
t.equal('the e tag is the note', ntag('e').map((x) => x[1]), [note.id]);
t.equal('the p tag is its author', ntag('p').map((x) => x[1]), [maker.pk]);
t.equal('no NIP-73 refs on a note zap', [...ntag('k'), ...ntag('i')].length, 0);
t.equal('the note zap carries the same long lnurl (shared encoder)', ntag('lnurl').map((x) => x[1]), [lnurl]);
t.ok('signed by the viewer', nz.pubkey === viewer.pk && verifyEvent(nz));
t.equal('the stub wallet paid it', await js(`window.__paid`), ['lnbc1000n1pe2estubinvoice']);
t.equal('the server LNURL fallback was never used', lnurlProxyHits.length, 0);

// ---- 7. a hint lights the tile; only the settled read names the payee ---------
console.log('--- 7. the cached kind:0 lights ZAP at once; Send waits for the settled read ---');
// The device's profile cache, as `storage.profile.set` writes it.
const cacheProfile = (k, v) => js(`(() => { localStorage.setItem('bmb:profile4:${k.pk}', ${JSON.stringify(JSON.stringify({ t: Date.now(), v }))}); return 1; })()`);
callbacks.length = 0;
await setup({ as: viewer, relayTarget: SILENT });
await cacheProfile(maker, { name: 'e2emaker', display_name: MAKER_NAME, lud16: `stale-name@${STUB}` });
t.ok('the playlist opens while every relay is silent', await open(A));
const opened = Date.now();
t.ok('the cached profile lights ZAP well before the read can settle', await waitFor(TILE, 3000) && Date.now() - opened < 3000, `${Date.now() - opened} ms`);
t.ok('...the press opens the dialog', (await clickTile()) && await waitFor(zapDialog, 5000));
t.ok('...which says it is reading the address', await js(`!!${zapDialog}.querySelector('[data-zap-payee-pending]')`), await js(`${zapDialog}?.innerText`));
t.ok('...and offers no Send while it reads', await js(`![...${zapDialog}.querySelectorAll('button')].some((b) => /^Send /.test(b.textContent.trim()))`));
t.ok('when the silent read settles: "could not read", still no Send', await waitFor(`/Could not read the maker's Nostr profile/.test(${zapDialog}?.innerText ?? '')`, 15000), await js(`${zapDialog}?.innerText`));
t.ok('...and no Send', await js(`![...${zapDialog}.querySelectorAll('button')].some((b) => /^Send /.test(b.textContent.trim()))`));
await closeDialog();
t.equal('no invoice was requested on a hint alone', callbacks.length, 0);

await setup({ as: viewer });
await cacheProfile(maker, { name: 'e2emaker', display_name: MAKER_NAME, lud16: `stale-name@${STUB}` });
t.ok('a stale cached address, live relays: the playlist opens', await open(A));
t.ok('...ZAP opens the form once the read lands', (await waitFor(TILE, 3000)) && (await clickTile()) && await waitFor(`[...(${zapDialog}?.querySelectorAll('button') ?? [])].some((b) => /^Send /.test(b.textContent.trim()))`, 15000));
await js(`[...${zapDialog}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send 100 sats').click()`);
t.ok('...it zaps', await waitFor(`/zapped 100 sats/i.test(${zapDialog}?.innerText ?? '')`, 15000), await js(`${zapDialog}?.innerText`));
const hz = JSON.parse(new URL(callbacks[0] ?? `https://${STUB}/none`).searchParams.get('nostr') ?? '{}');
t.equal('...to the address the RELAYS hold, never the cached one', (hz.tags ?? []).filter((x) => x[0] === 'lnurl').map((x) => x[1]), [lnurl]);
await waitFor(`!${zapDialog}`, 8000);

// The hint STORED with the playlist (maker_ln), for a first visit: no cache, and
// relays that never answer, so only the stored hint can light the tile.
callbacks.length = 0;
makerHints.set(A.guid, { owner: maker.pk, zappable: true });
await setup({ as: viewer, relayTarget: SILENT });
t.ok('a stored hint, no cache, silent relays: the playlist opens', await open(A));
const opened2 = Date.now();
t.ok('...the stored hint lights ZAP before any relay answers', await waitFor(TILE, 3000) && Date.now() - opened2 < 3000, `${Date.now() - opened2} ms`);
t.ok('...a press shows "reading", no Send', (await clickTile()) && await waitFor(`!!${zapDialog}?.querySelector('[data-zap-payee-pending]')`, 5000)
  && await js(`![...${zapDialog}.querySelectorAll('button')].some((b) => /^Send /.test(b.textContent.trim()))`));
await closeDialog();
t.equal('...and requests no invoice', callbacks.length, 0);
makerHints.set(A.guid, { owner: noAddr.pk, zappable: true });
await setup({ as: viewer, relayTarget: SILENT });
t.ok('a stored hint for ANOTHER owner: the playlist opens', await open(A));
t.ok('...and lights nothing early (the held place stays)', (await wait(2000), await js(`!${TILE} && !!${PENDING}`)));
makerHints.set(A.guid, { owner: maker.pk, zappable: null });
await setup({ as: viewer, relayTarget: SILENT });
t.ok('a database with no maker_ln column (zappable: null): opens', await open(A));
t.ok('...and lights nothing early', (await wait(2000), await js(`!${TILE} && !!${PENDING}`)));
makerHints.delete(A.guid);

await setup({ as: viewer });
await cacheProfile(noAddr, { name: 'noaddr', lud16: `old@${STUB}` });
t.ok('a cached address for a maker who has since removed it: opens', await open(NOADDR));
t.ok('...the settled read takes the tile away', await noTileAfterRead());

console.log(`\n${t.count - t.fails}/${t.count} passed`);
silent.close();
relay.close();
await exit(t.fails ? 1 : 0);
