// Drives the player's BOOST while playback moves to the next track, in a real
// browser, against a stub wallet. Issue #551: "the boost screen disappeared when
// the track changed so I couldn't see if everything went through" — a musicL
// playlist, the player's BOOST pressed with a few seconds of the track left.
//
// WHAT IT PINS. `<Player>` used to render `<BoostModal>` from the store's live
// `current`, gated on that item's `hasValue`. A playlist row's payee is not read
// until it plays (`valueNotRead`), so the moment the next track started the gate
// went false and the modal unmounted — mid-send included — and when the new
// track's block arrived the modal came BACK, fresh, for the new track. The modal
// now stays on the item it was opened for until the listener closes it. Sections
// 1 and 2 move on with ⏭, before Send and mid-send; section 3 lets the track END
// (`stepOnEnd`, the reported path) under a failed leg, so the Retry must survive.
// Against the code before the fix, 31 of 84 checks fail, every one on the screen.
//
// WHAT IT ALSO PROVES ABOUT THE MONEY, and this half passes on the old code too:
// the send that was in flight finishes against the ORIGINAL track — one keysend
// to that track's payee, a boostagram naming that track, and a `StoredBoost`
// naming it. `go()` pays from the values it captured at the press, so unmounting
// the modal never stopped or redirected a leg; what the listener lost was the
// screen that would have said so.
//
// AND THE BROWSER'S BACK BUTTON MID-SEND. An open modal is a history entry
// (components/use-modal-history.ts) and back closes one — but not while legs are
// out: section 2 presses it during the held send and the modal, the page and the
// history all stay where they were.
//
// AND A LIVE SHOW, whose payee is the song on air and moves under an open modal
// BY DESIGN. Section 4 pins both halves: before Send the modal still follows the
// on-air song (the fix changes no live payee), and from the press it keeps the
// song the leg paid, so the result stays beside that song's payee. One item of
// Homegrown Hits is made live in the browser, as `e2e:livecatchup` does, its
// audio is a local tone (`ffmpeg`), and `/api/live-value` is stubbed so the test
// decides which song is on air; `bmbLive().poll()` makes the watcher read it now.
//
// NOTHING HERE LEAVES THE MACHINE FOR MONEY OR FOR NOSTR. The wallet is a stub on
// `local-relay.mjs`, every payee is a `type="node"` keysend through it, the note is
// off (`bmb:share_nostr` = '0') and both signing routes are blocked — the script
// fails if either is asked. The playlist, its audio and the Homegrown Hits feed are
// read from the real network, because a real musicL playlist is the medium the
// report came from; each track's value block is stubbed on the wire, one payee per
// track, and the live show's blocks are stubbed the same way.
//
//   SITE_NOSTR_SK= npm run build && SITE_NOSTR_SK= npm run start
//   npm run e2e:boosttrack            (APP_URL=http://127.0.0.1:3102 for another port)

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createRelay } from './local-relay.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const PLAYLIST = 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/HGH-music-playlist.xml';
const BOOST_ROW = 'button[aria-label="Boost this track"]';
const PLAYER_BOOST = '[aria-label="Send a boost"]';
const BOOSTAGRAM_TLV = 7629169;
/** Homegrown Hits, whose one rewritten item plays as the live show. */
const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';
const LIVE_GUID = 'e2e-live-boost';

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`SITE_NOSTR_SK= npm run build && SITE_NOSTR_SK= npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

// --- A stub NIP-47 wallet on a local relay ---------------------------------------------
const relay = createRelay({ port: 0, log: null });
const relayPort = await relay.ready;
const walletSk = generateSecretKey();
const walletPub = getPublicKey(walletSk);
const clientSk = generateSecretKey();
const clientPub = getPublicKey(clientSk);
const conversation = nip44.getConversationKey(walletSk, clientPub);
const METHODS = ['get_info', 'get_balance', 'pay_keysend', 'pay_invoice'];
// `hold` parks a payment request unanswered, which is what a send in flight is.
// `refuseNext` answers the next one with a refusal the app reads as "nothing was
// sent" (`explainPaymentError`'s no-wallet arm): the cheapest way to a leg the
// Retry button offers. Which refusal it is does not matter here.
const wallet = { sats: 50000, pays: [], hold: false, held: [], refuseNext: false };

const walletWs = new WebSocket(`ws://127.0.0.1:${relayPort}`);
const signAndSend = (tmpl) => walletWs.send(JSON.stringify(['EVENT', finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl }, walletSk)]));
const reply = (e, method, result, error = { code: 'NOT_IMPLEMENTED', message: `${method} is not stubbed` }) => signAndSend({
  kind: 23195,
  tags: [['p', clientPub], ['e', e.id]],
  content: nip44.encrypt(JSON.stringify(result
    ? { result_type: method, result }
    : { result_type: method, result: null, error }), conversation),
});
const payResult = () => ({ preimage: 'ab'.repeat(32) });
walletWs.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] !== 'EVENT' || msg[1] !== 'wallet') return;
  const e = msg[2];
  const { method, params } = JSON.parse(nip44.decrypt(e.content, conversation));
  if (method === 'get_info') return reply(e, method, { methods: METHODS, alias: 'stub', pubkey: walletPub, network: 'mainnet', block_height: 1, block_hash: '00', color: '#000000' });
  if (method === 'get_balance') return reply(e, method, { balance: wallet.sats * 1000 });
  if (method === 'pay_keysend' || method === 'pay_invoice') {
    wallet.pays.push({ method, params });
    if (wallet.refuseNext) {
      wallet.refuseNext = false;
      return reply(e, method, null, { code: 'OTHER', message: 'no payment provider available' });
    }
    if (wallet.hold) { wallet.held.push(() => reply(e, method, payResult())); return; }
    return reply(e, method, payResult());
  }
  reply(e, method, null);
};
await new Promise((resolve, reject) => { walletWs.onopen = resolve; walletWs.onerror = reject; });
walletWs.send(JSON.stringify(['REQ', 'wallet', { kinds: [23194], '#p': [walletPub] }]));
signAndSend({ kind: 13194, tags: [['encryption', 'nip44_v2']], content: METHODS.join(' ') });
const releaseWallet = () => { wallet.hold = false; for (const f of wallet.held.splice(0)) f(); };

const URI = `nostr+walletconnect://${walletPub}?relay=ws://127.0.0.1:${relayPort}&secret=${Buffer.from(clientSk).toString('hex')}`;

/** What one keysend carried: its payee and the boostagram in TLV 7629169. */
const decodePay = (p) => {
  const rec = (p.params?.tlv_records ?? []).find((r) => r.type === BOOSTAGRAM_TLV);
  let boostagram = null;
  try { boostagram = rec ? JSON.parse(Buffer.from(rec.value, 'hex').toString('utf8')) : null; } catch { /* left null */ }
  return { pubkey: p.params?.pubkey, sats: (p.params?.amount ?? 0) / 1000, boostagram };
};

// --- One payee per track, on the wire ------------------------------------------------
// The Nth item guid the page asks about is paid by "E2E payee N" at node 02NN…NN, so
// every leg says which track's block it was computed from.
const valueGuids = [];
const payeeFor = (n) => ({ name: `E2E payee ${n}`, address: `02${String(n).padStart(2, '0').repeat(32)}` });
const valueFor = (guid) => {
  if (!valueGuids.includes(guid)) valueGuids.push(guid);
  const n = valueGuids.indexOf(guid) + 1;
  return {
    read: true,
    value: { type: 'lightning', method: 'keysend', recipients: [{ ...payeeFor(n), type: 'node', split: 100 }] },
    valueTimeSplits: [],
  };
};

// --- The browser ----------------------------------------------------------------------
const { page } = await launchChrome({ name: 'boost-track-change', autoplay: true, args: ['--disable-gpu'] });
const { send, js, on } = page;
const signingAsked = [];
// While set, an item-value read waits unanswered — the moment a musicL track has
// started and its payee is not read yet, held open long enough to look at.
const valueHold = { on: false, held: [] };
const answerValue = (requestId, url) => send('Fetch.fulfillRequest', {
  requestId,
  responseCode: 200,
  responseHeaders: [{ name: 'content-type', value: 'application/json' }],
  body: Buffer.from(JSON.stringify(valueFor(new URL(url).searchParams.get('itemGuid')))).toString('base64'),
});
const releaseValues = async () => {
  valueHold.on = false;
  for (const { requestId, url } of valueHold.held.splice(0)) await answerValue(requestId, url);
};
// --- The live show of section 4 -------------------------------------------------------
// Its audio: a local tone, streamed, so the live item really plays.
const toneDir = mkdtempSync(join(tmpdir(), 'bmb-boosttrack-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
  '-ac', '2', '-ar', '44100', '-b:a', '128k', '-write_xing', '0', '-id3v2_version', '0', join(toneDir, 'tone.mp3')]);
const tone = readFileSync(join(toneDir, 'tone.mp3'));
rmSync(toneDir, { recursive: true, force: true });
const streams = new Set();
const streamServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  let pos = 0;
  const produce = (n) => {
    while (n > 0) {
      const take = Math.min(n, tone.length - pos);
      res.write(tone.subarray(pos, pos + take));
      pos = (pos + take) % tone.length;
      n -= take;
    }
  };
  produce(54000);
  const timer = setInterval(() => produce(1600), 100);
  streams.add(res);
  req.on('close', () => { clearInterval(timer); streams.delete(res); });
});
await new Promise((r) => streamServer.listen(0, '127.0.0.1', r));
const STREAM = `http://127.0.0.1:${streamServer.address().port}/live.mp3`;
// The show's own block, and the song on air, which the test moves.
const SHOW_BLOCK = { type: 'lightning', method: 'keysend', recipients: [{ name: 'E2E show', address: payeeFor(90).address, type: 'node', split: 100 }] };
const songPayee = (n) => payeeFor(40 + n);
const song = (n) => ({
  startTime: 0,
  duration: 0,
  remotePercentage: 100,
  title: `E2E song ${n}`,
  remoteItem: { feedGuid: `e2e-feed-song-${n}`, itemGuid: `e2e-item-song-${n}` },
  value: { type: 'lightning', method: 'keysend', recipients: [{ name: `E2E song ${n} payee`, address: songPayee(n).address, type: 'node', split: 100 }] },
});
const onAir = { n: 1, polls: 0 };

await send('Fetch.enable', {
  patterns: [
    { urlPattern: '*/api/item-value*', requestStage: 'Request' },
    { urlPattern: '*/api/nostr/site-sign*', requestStage: 'Request' },
    { urlPattern: '*/api/nostr/zap-receipt-sign*', requestStage: 'Request' },
    { urlPattern: '*/api/feed?*', requestStage: 'Response' },
    { urlPattern: '*/api/live-status?*', requestStage: 'Request' },
    { urlPattern: '*/api/live-value?*', requestStage: 'Request' },
  ],
});
const fulfillJson = (requestId, data, code = 200, headers = [{ name: 'content-type', value: 'application/json' }]) =>
  send('Fetch.fulfillRequest', { requestId, responseCode: code, responseHeaders: headers, body: Buffer.from(JSON.stringify(data)).toString('base64') });
on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request, responseStatusCode, responseHeaders } = m.params;
  try {
    if (request.url.includes('/api/live-status')) {
      await fulfillJson(requestId, { ok: true, items: [{ guid: LIVE_GUID, status: 'live' }] });
      return;
    }
    if (request.url.includes('/api/live-value')) {
      onAir.polls += 1;
      await fulfillJson(requestId, { split: song(onAir.n), signal: 'remote-item', value: SHOW_BLOCK, liveStatus: 'live' });
      return;
    }
    if (request.url.includes('/api/feed')) {
      // One item of the show becomes a live broadcast on the local tone, paying
      // the stub show block. `liveValue` is dropped so no Split Kit socket opens.
      const r = await send('Fetch.getResponseBody', { requestId });
      const data = JSON.parse(r.result.base64Encoded ? Buffer.from(r.result.body, 'base64').toString('utf8') : r.result.body);
      // Only the show of section 4; every other feed passes through as it came.
      const isShow = data.podcast?.podcastGuid === HGH || data.episodes?.some((e) => e.podcastGuid === HGH);
      if (isShow && Array.isArray(data.episodes) && data.episodes.length) {
        const now = Math.floor(Date.now() / 1000);
        const base = data.episodes.find((e) => !e.liveStatus) ?? data.episodes[0];
        const live = { ...base, id: -990002, guid: LIVE_GUID, title: 'E2E live boost broadcast', liveStatus: 'live',
          liveStartTime: now - 600, liveEndTime: now + 3600, enclosureUrl: STREAM, enclosureType: 'audio/mpeg',
          value: SHOW_BLOCK, valueTimeSplits: [] };
        delete live.liveValue;
        data.episodes = [live, ...data.episodes.filter((e) => !e.liveStatus)];
      }
      await fulfillJson(requestId, data, responseStatusCode,
        (responseHeaders ?? []).filter((h) => !/^content-(length|encoding)$/i.test(h.name)));
      return;
    }
    if (!request.url.includes('/api/item-value')) {
      signingAsked.push(request.url);
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      return;
    }
    if (valueHold.on) { valueHold.held.push({ requestId, url: request.url }); return; }
    await answerValue(requestId, request.url);
  } catch (e) {
    console.log(`  (interception of ${request.url} failed: ${e.message})`);
    await send('Fetch.continueRequest', { requestId }).catch(() => {});
  }
});
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { if (location.protocol === 'http:' && !localStorage.getItem('e2e-seeded')) {
    localStorage.setItem('e2e-seeded', '1');
    localStorage.setItem('bmb:nwc_uri', ${JSON.stringify(URI)});
    localStorage.setItem('bmb:share_nostr', '0');
  } } catch {}`,
});

const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await js(`(${fn})()`);
    if (v) return v;
    await wait(200);
  }
  return null;
};
const untilNode = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(100);
  }
  return false;
};
/** What the boost modal shows, or null when none is on screen. */
const modal = () => js(`(() => {
  const d = document.querySelectorAll('[role="dialog"]');
  if (!d.length) return null;
  return {
    count: d.length,
    title: d[0].querySelector('h3')?.textContent ?? null,
    amount: d[0].querySelector('input[inputmode="numeric"]')?.value ?? null,
    text: d[0].innerText,
  };
})()`);
const nowPlaying = () => js(`document.querySelector(${JSON.stringify(MINI_BAR)})?.innerText ?? ''`);
const setAmount = (n) => js(`(() => {
  const i = document.querySelector('[role="dialog"] input[inputmode="numeric"]');
  if (!i) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '${n}');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const pressDialogButton = (re) => js(`(() => {
  const b = [...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find((x) => ${re}.test(x.innerText) && !x.disabled);
  if (!b) return false;
  b.click();
  return true;
})()`);
/** The listener's ⏭ on the mini-bar. The modal is open over it; a click still lands. */
const pressNext = () => js(`(() => {
  const b = document.querySelector('${MINI_BAR} button[aria-label="Next track"]');
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);
const openPlayerBoost = async () => {
  const opened = await until(`() => { const b = document.querySelector('${PLAYER_BOOST}'); return b && !b.disabled ? (b.click(), true) : null; }`, 30000);
  return opened && (await until(`() => !!document.querySelector('[role="dialog"] h3')`, 15000));
};
/** Wait for the mini-bar to stop naming `title`: the player moved to the next item. */
const movedOff = (title) => until(`() => { const m = document.querySelector('${MINI_BAR}'); return m && !m.innerText.includes(${JSON.stringify(title)}) ? true : null; }`, 15000);
const storedBoosts = () => js(`JSON.parse(localStorage.getItem('bmb:boosts:guest') || '[]')`);
/** The tab's place in its history, and the browser's own back button. */
const historyIndex = async () => (await send('Page.getNavigationHistory')).result.currentIndex;
const browserBack = async () => {
  const h = (await send('Page.getNavigationHistory')).result;
  await send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
};

section('0. A musicL playlist, a track playing, its payee read on play');
await send('Page.navigate', { url: `${APP}/?playlist=${encodeURIComponent(PLAYLIST)}` });
const rows = await until(`() => document.querySelectorAll('${BOOST_ROW}').length`, 60000);
t.ok('the playlist rows render', rows >= 4, `saw ${rows}`);
await js(`(() => {
  const li = [...document.querySelectorAll('ul.divide-y > li')].filter((r) => r.querySelector('button.btn-bolt'))[0];
  li.querySelector('button').click();
})()`);
t.ok('the player\'s BOOST is live once the track\'s payee is read',
  !!(await until(`() => { const b = document.querySelector('${PLAYER_BOOST}'); return b && !b.disabled; }`, 30000)));
t.ok('the playing track has a ⏭ to the next track', !!(await until(`() => { const b = document.querySelector('${MINI_BAR} button[aria-label="Next track"]'); return b && !b.disabled; }`, 15000)));

section('1. The next track starts while the modal is open, before Send');
{
  t.ok('the modal opens from the player', await openPlayerBoost());
  const first = await modal();
  const titleA = first?.title;
  t.ok('it names the playing track', !!titleA && (await nowPlaying()).includes(titleA), `${titleA} / ${await nowPlaying()}`);
  await setAmount(100);
  t.ok('it lists that track\'s payee', !!(await until(`() => document.querySelector('[role="dialog"]')?.innerText.includes('E2E payee 1')`, 8000)));

  // The next track's payee is not read yet: a playlist row carries none.
  valueHold.on = true;
  t.ok('⏭ is pressed', await pressNext());
  t.ok('the player moves to the next track', !!(await movedOff(titleA)));
  await wait(1000);
  let m = await modal();
  t.ok('the modal is still on screen while the new track\'s payee is unread', !!m);
  t.equal('it still names the track it was opened for', m?.title ?? null, titleA);
  t.ok('with that track\'s payee', !!m?.text.includes('E2E payee 1'), m?.text.slice(0, 200));
  t.equal('and the amount the listener typed', m?.amount ?? null, '100');

  await releaseValues();
  await wait(2000);
  m = await modal();
  t.equal('once the new track\'s payee lands there is still ONE modal', m?.count ?? 0, 1);
  t.equal('and it did not move to the new track', m?.title ?? null, titleA);
  t.equal('nor to the new track\'s payee', !!m?.text.includes('E2E payee 2'), false);

  const before = wallet.pays.length;
  const sent = await pressDialogButton('/send 100 sat/i');
  t.ok('Send is pressed in that modal', sent);
  if (sent) {
    t.ok('one leg reaches the wallet', await untilNode(() => wallet.pays.length > before, 15000));
    const legs = wallet.pays.slice(before).map(decodePay);
    t.equal('exactly one keysend', legs.length, 1);
    t.equal('to the track the modal was opened for', legs[0]?.pubkey, payeeFor(1).address);
    t.equal('whose boostagram names that track', legs[0]?.boostagram?.episode, titleA);
    t.equal('by its item guid', legs[0]?.boostagram?.episode_guid, valueGuids[0]);
    t.ok('the modal shows the leg settled', !!(await until(`() => document.querySelector('[role="dialog"]')?.innerText.toLowerCase().includes('lightning: 1/1 sent')`, 10000)));
  }
  t.ok('a paid boost still closes itself', !!(await until(`() => !document.querySelector('[role="dialog"]')`, 8000)));
  await wait(2000);
  t.equal('and no modal comes back for the new track', await modal(), null);
}

section('2. The next track starts while the leg is still going out');
{
  const playing = await nowPlaying();
  t.ok('the modal opens on the track now playing', await openPlayerBoost());
  const titleB = (await modal())?.title;
  t.ok('it names the playing track', !!titleB && playing.includes(titleB), `${titleB} / ${playing}`);
  await setAmount(100);
  t.ok('it lists that track\'s payee', !!(await until(`() => document.querySelector('[role="dialog"]')?.innerText.includes('E2E payee 2')`, 8000)));

  wallet.hold = true;
  const before = wallet.pays.length;
  t.ok('Send is pressed', await pressDialogButton('/send 100 sat/i'));
  t.ok('the leg reaches the wallet, which does not answer yet', await untilNode(() => wallet.held.length === 1, 15000));
  t.ok('the modal says it is sending', !!(await until(`() => document.querySelector('[role="dialog"]')?.innerText.toLowerCase().includes('sending')`, 5000)));

  // The browser's back button mid-send changes NOTHING. An open modal is a
  // history entry (components/use-modal-history.ts), and back closes one — but
  // not this one: `dismissable={false}` while legs are out, so its entry is
  // pushed again and the page under it does not move either.
  const urlMidSend = await js('location.href');
  const indexMidSend = await historyIndex();
  await browserBack();
  await wait(1000);
  let m = await modal();
  t.ok('a back press mid-send leaves the modal on screen', !!m);
  t.ok('…still sending', !!m?.text.toLowerCase().includes('sending'));
  t.equal('…on the same page, its entry pushed again', [await js('location.href'), await historyIndex()], [urlMidSend, indexMidSend]);

  valueHold.on = true;
  t.ok('⏭ is pressed mid-send', await pressNext());
  t.ok('the player moves to the next track', !!(await movedOff(titleB)));
  await wait(1000);
  m = await modal();
  t.ok('the modal is still on screen mid-send', !!m);
  t.equal('it still names the track being paid', m?.title ?? null, titleB);
  t.ok('with the payee being paid', !!m?.text.includes('E2E payee 2'), m?.text.slice(0, 200));
  t.ok('and still says it is sending', !!m?.text.toLowerCase().includes('sending'));

  releaseWallet();
  t.ok('the modal shows the leg settled', !!(await until(`() => document.querySelector('[role="dialog"]')?.innerText.toLowerCase().includes('lightning: 1/1 sent')`, 10000)));

  // The money half. These pass on the old code too: the send never depended on the
  // modal staying mounted.
  const legs = wallet.pays.slice(before).map(decodePay);
  t.equal('exactly one keysend', legs.length, 1);
  t.equal('to the track that was playing at the press', legs[0]?.pubkey, payeeFor(2).address);
  t.equal('for the amount pressed', legs[0]?.sats, 100);
  t.equal('whose boostagram names that track', legs[0]?.boostagram?.episode, titleB);
  t.equal('by its item guid', legs[0]?.boostagram?.episode_guid, valueGuids[1]);
  const stored = (await storedBoosts())[0];
  t.equal('the boost log names that track', stored?.episodeTitle, titleB);
  t.equal('by its item guid', stored?.episodeGuid, valueGuids[1]);
  t.equal('with the one leg settled', (stored?.legs ?? []).map((l) => l.ok), [true]);

  await releaseValues();
  t.ok('a paid boost still closes itself', !!(await until(`() => !document.querySelector('[role="dialog"]')`, 8000)));
  await wait(2000);
  t.equal('and no modal comes back for the new track', await modal(), null);
  t.equal('…and its close stepped back off its entry', await historyIndex(), indexMidSend - 1);
}

section('3. The track ENDS on its own while a failed leg waits for Retry');
{
  // The reported path: a list that plays as tracks steps on when a track ends
  // (`stepOnEnd`), not on the listener's ⏭. And the case where seeing the result
  // matters most — a leg that did not go through, and the Retry that finishes it.
  const playing = await nowPlaying();
  t.ok('the modal opens on the track now playing', await openPlayerBoost());
  const titleC = (await modal())?.title;
  t.ok('it names the playing track', !!titleC && playing.includes(titleC), `${titleC} / ${playing}`);
  await setAmount(100);
  t.ok('it lists that track\'s payee', !!(await until(`() => document.querySelector('[role="dialog"]')?.innerText.includes('E2E payee 3')`, 8000)));

  wallet.refuseNext = true;
  const before = wallet.pays.length;
  t.ok('Send is pressed', await pressDialogButton('/send 100 sat/i'));
  t.ok('the leg fails and offers a retry', !!(await until(`() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => /retry 1 failed/i.test(b.innerText) && !b.disabled)`, 15000)));
  t.equal('nothing was logged as a boost yet', (await storedBoosts()).filter((b) => b.episodeTitle === titleC).length, 0);

  valueHold.on = true;
  const ended = await js(`(async () => {
    const a = [...document.querySelectorAll('audio, video')].find((x) => x.currentSrc);
    if (!a) return 'no media element';
    for (let i = 0; i < 100 && !Number.isFinite(a.duration); i++) await new Promise((r) => setTimeout(r, 200));
    if (!Number.isFinite(a.duration)) return 'the track never reported a duration';
    a.currentTime = Math.max(0, a.duration - 0.5);
    if (a.paused) await a.play().catch(() => {});
    return true;
  })()`);
  t.equal('the track is sought to its last half second', ended, true);
  t.ok('the track ends and the list steps on by itself', !!(await movedOff(titleC)));
  await wait(1000);
  let m = await modal();
  t.ok('the modal is still on screen', !!m);
  t.equal('it still names the track it was opened for', m?.title ?? null, titleC);
  t.ok('and still offers the retry', !!(await until(`() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => /retry 1 failed/i.test(b.innerText) && !b.disabled)`, 3000)));

  await releaseValues();
  await wait(2000);
  m = await modal();
  t.equal('once the next track\'s payee lands it still names the same track', m?.title ?? null, titleC);
  t.ok('Retry is pressed', await pressDialogButton('/retry 1 failed/i'));
  t.ok('the retry reaches the wallet', await untilNode(() => wallet.pays.length >= before + 2, 15000));
  const legs = wallet.pays.slice(before).map(decodePay);
  t.equal('two keysends: the refused one and the retry', legs.length, 2);
  t.equal('both to the track the modal was opened for', legs.map((l) => l.pubkey), [payeeFor(3).address, payeeFor(3).address]);
  t.equal('the retry\'s boostagram names that track', legs[1]?.boostagram?.episode, titleC);
  t.equal('under the same uuid', legs[1]?.boostagram?.uuid, legs[0]?.boostagram?.uuid);
  const stored = (await storedBoosts())[0];
  t.equal('the boost log, written by the retry, names that track', stored?.episodeTitle, titleC);
  t.equal('by its item guid', stored?.episodeGuid, valueGuids[2]);
  t.ok('a paid boost still closes itself', !!(await until(`() => !document.querySelector('[role="dialog"]')`, 8000)));
  await wait(2000);
  t.equal('and no modal comes back for the new track', await modal(), null);
}

section('4. A live show: the modal follows the song on air until Send, then keeps the one it paid');
{
  /** Put song `n` on air and make the watcher read it now. */
  const putOnAir = async (n) => {
    onAir.n = n;
    const before = onAir.polls;
    await js(`window.bmbLive?.().poll()`);
    return untilNode(() => onAir.polls > before, 10000);
  };
  const dialogText = () => js(`document.querySelector('[role="dialog"]')?.innerText ?? null`);
  // A `t=` link plays only on a load with nothing in the player, and the page
  // puts the last-played track back from disk — so that copy goes, on the way
  // out too, after the page's own flush.
  await js(`(() => {
    addEventListener('pagehide', () => { try { localStorage.removeItem('bmb:now_playing'); } catch {} });
    localStorage.removeItem('bmb:now_playing');
  })()`);
  await send('Page.navigate', { url: `${APP}/?podcast=${HGH}&episode=${LIVE_GUID}&t=0` });
  const playingLive = await until(`() => { const a = document.querySelector('${MINI_BAR} audio'); return !!a && a.src === ${JSON.stringify(STREAM)} && !a.paused && a.readyState >= 3; }`, 30000);
  t.ok('the live item plays', !!playingLive);
  t.ok('the watcher reads the song on air', await putOnAir(1));
  t.ok('the modal opens from the player', await openPlayerBoost());
  await setAmount(100);
  t.ok('it names song 1 and its payee', !!(await until(`() => { const d = document.querySelector('[role="dialog"]')?.innerText ?? ''; return d.includes('E2E song 1') && d.includes('E2E song 1 payee'); }`, 15000)), (await dialogText())?.slice(-600));

  // Before Send the live target is FOLLOWED, as it always was: no live payee changes.
  t.ok('song 2 comes on air', await putOnAir(2));
  t.ok('before Send, the modal follows the song on air', !!(await until(`() => { const d = document.querySelector('[role="dialog"]')?.innerText ?? ''; return d.includes('E2E song 2 payee') && !d.includes('E2E song 1 payee'); }`, 10000)), (await dialogText())?.slice(-600));

  wallet.hold = true;
  const before = wallet.pays.length;
  t.ok('Send is pressed', await pressDialogButton('/send 100 sat/i'));
  t.ok('the leg reaches the wallet, which does not answer yet', await untilNode(() => wallet.held.length === 1, 15000));
  t.ok('song 3 comes on air mid-send', await putOnAir(3));
  await wait(1500);
  let text = (await dialogText()) ?? '';
  t.ok('the modal is still on screen', !!text);
  t.ok('it still names the song being paid', text.includes('E2E song 2'), text.slice(-600));
  t.ok('with that song\'s payee', text.includes('E2E song 2 payee'));
  t.equal('and not the song now on air', text.includes('E2E song 3'), false);

  releaseWallet();
  t.ok('the modal shows the leg settled', !!(await until(`() => document.querySelector('[role="dialog"]')?.innerText.toLowerCase().includes('lightning: 1/1 sent')`, 10000)));
  text = (await dialogText()) ?? '';
  t.ok('beside the payee it paid', text.includes('E2E song 2 payee') && !text.includes('E2E song 3'), text.slice(-600));
  const legs = wallet.pays.slice(before).map(decodePay);
  t.equal('exactly one keysend', legs.length, 1);
  t.equal('to the song on air at the press', legs[0]?.pubkey, songPayee(2).address);
  t.equal('whose boostagram names that song', legs[0]?.boostagram?.remote_item_guid, 'e2e-item-song-2');
  t.ok('a paid boost still closes itself', !!(await until(`() => !document.querySelector('[role="dialog"]')`, 8000)));
}

section('5. Nothing left the machine');
t.equal('no signing route was asked', signingAsked, []);
t.ok('every leg went to a stub payee', wallet.pays.every((p) => /^02(\d\d)\1{31}$/.test(decodePay(p).pubkey ?? '')), JSON.stringify(wallet.pays.map((p) => decodePay(p).pubkey)));

console.log(`\n${t.fails ? `${t.fails} of ${t.count} checks FAILED.` : `All ${t.count} checks passed.`}`);
try { walletWs.close(); relay.close(); streamServer.close(); for (const r of streams) r.destroy(); } catch { /* already gone */ }
await exit(t.fails ? 1 : 0);
