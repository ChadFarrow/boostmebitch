// End-to-end for issue #600: "Signing in published a favorites list that
// replaced 81 entries with 2".
//
// Usage:
//   npm run dev                          # in another terminal
//   npm run e2e:signin-favorites         # headless
//   BMB_APP=http://localhost:3107 npm run e2e:signin-favorites
//
// WHAT HAPPENED. A sign-in read the kind:10333 list, got one empty answer while
// the relays that held the list were not reached, believed "this account has no
// list", and published a NEW list from the two favorites the browser held. A
// create is the one publish that cannot know what it replaces, so it replaced
// 81 entries with 2 — with nothing on screen, and a signer sheet that says only
// "sign kind 10333".
//
// WHAT THIS DRIVES. The real app in a real browser, against NOTHING but this
// machine:
//   - a throwaway key, reached over a CDP binding as `window.nostr`;
//   - local in-memory relays (`createRelay`, the one `npm run relay` starts),
//     one of which is a port with nothing listening — the relay that holds the
//     list and is not reached;
//   - Chrome started with `--host-resolver-rules` mapping every host but this
//     machine to NOTFOUND, so no page socket can reach a public relay at all.
//     `bmb:relays` already keeps the favorites publish local; the resolver rule
//     is what keeps the profile and NIP-65 READS local too.
//
// The four scenarios, each the shape of one way to the same event:
//   A. Sign in through the modal with two signed-out favorites. ONE relay
//      answers "no list" and the relay holding it is down. Nothing is published,
//      and the notice says the list could not be confirmed.
//   B. The same with TWO relays saying "no list". Still nothing published on
//      its own — the notice ASKS — and "save as new list" then creates it.
//   C. The list IS read, but this device's baseline names all of it and the
//      store holds two: "This would remove 7 of your 8 favorites". Nothing is
//      signed until "keep them", which publishes the union with `visibility`
//      and both `k` tags intact.
//   D. The same question answered "remove them": the shrink goes through, and
//      keeps `visibility`.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { WebSocket, WebSocketServer } from 'ws';
import { baselineOfList, parseFavoritesList } from '../lib/nostr/favorites-list.ts';

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// Every host that is not this machine resolves to nothing, so no relay socket
// the page opens can leave it. The app's API routes run in the Next server,
// which is a separate process and still reaches Podcast Index.
const { page } = await launchChrome({
  name: 'signin-favorites',
  args: [
    '--disable-gpu',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    '--window-size=1280,900',
  ],
});
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const t = checker();
const check = (l, a, b) => t.equal(l, a, b);
const section = (s) => console.log(`\n--- ${s} ---`);

// ---- relays -------------------------------------------------------------
const published = []; // every kind:10333 any local relay accepted, with its relay
async function relay(name) {
  const r = createRelay({
    port: 0,
    log: null,
    onEvent: (e) => { if (e.kind === 10333) published.push({ relay: name, event: e }); },
  });
  const port = await r.ready;
  return { ...r, url: `ws://127.0.0.1:${port}` };
}
const holder = await relay('holder');
const empty1 = await relay('empty1');
const empty2 = await relay('empty2');
// A port with nothing on it: bound, read back, closed. The relay that holds the
// list and does not answer — "never connected", which the read excludes.
const deadUrl = await new Promise((resolve) => {
  const s = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  s.once('listening', () => { const p = s.address().port; s.close(() => resolve(`ws://127.0.0.1:${p}`)); });
});

function publishTo(url, event) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (m) => { const d = JSON.parse(m.toString()); if (d[0] !== 'OK') return; ws.close(); if (d[2]) resolve(); else reject(new Error(d[3])); });
    ws.on('error', reject);
  });
}

// ---- the list ------------------------------------------------------------
// The wire SHAPE of the event #600 replaced (88e77504…), cut to 8 entries:
// `visibility` after `alt`, three-element items ahead of `medium`, feed entries
// after it, one `k` per kind at the end. The guids are real, public feeds.
const KEPT = '55b53584-4219-4fb0-b916-075ce23f714e';
const NEW = '636b509a-431d-53dd-a03a-9be92f255972';
const F1 = 'a1077af6-602b-5daf-957b-68a65a03cad1';
const F2 = 'b9c92d07-c0ab-5712-b8e1-05f5e4992e3e';
const WIRE = [
  ['alt', 'PC 2.0 Favorites'],
  ['visibility', 'public'],
  ['i', `podcast:guid:${F1}`, 'podcast:item:guid:8ec41aed-2072-4562-ad11-2ffa9169d3ab'],
  ['i', `podcast:guid:${F1}`, 'podcast:item:guid:8106e789-25e4-4b33-9c47-1ab5de6f7b77'],
  ['i', `podcast:guid:${F2}`, 'podcast:item:guid:5d580bab-8a4a-4cfd-8644-304238c94830'],
  ['medium', 'podcast'],
  ['i', 'podcast:guid:c0be02f5-0e88-59a3-84cb-b76041a83264'],
  ['i', 'podcast:guid:23cc891c-c425-50e8-ac99-c17e6f2582c8'],
  ['i', 'podcast:guid:afbaa6da-4219-55dd-934a-96e0bc79c442'],
  ['i', `podcast:guid:${KEPT}`],
  ['i', 'podcast:guid:e67106b4-08a8-5edb-a6fc-cb7e96af3ca7'],
  ['k', 'podcast:item:guid'],
  ['k', 'podcast:guid'],
];
const LIST_SIZE = WIRE.filter((x) => x[0] === 'i').length; // 8
const FULL_BASELINE = baselineOfList(parseFavoritesList(WIRE));
let seededAt = Math.floor(Date.now() / 1000) - 600;
async function seedHolder() {
  // Newer than anything on the relay — the app's own publishes included — so
  // it REPLACES; then a pause, so the app's next publish is newer than it.
  const newest = Math.max(0, ...published.map((p) => p.event.created_at));
  seededAt = Math.max(seededAt + 1, newest + 1);
  while (Math.floor(Date.now() / 1000) <= seededAt) await wait(250);
  await publishTo(holder.url, finalizeEvent({ kind: 10333, created_at: seededAt, tags: WIRE, content: '' }, sk));
}

// The two shows the browser held: one already on the list, one not.
const twoShows = JSON.stringify({
  [KEPT]: { id: 0, podcastGuid: KEPT, title: 'Kept show', medium: 'podcast', addedAt: 1 },
  [NEW]: { id: 0, podcastGuid: NEW, title: 'New show', medium: 'podcast', addedAt: 2 },
});

// ---- CDP + the signer ----------------------------------------------------
const { send } = page;
const js = page.jsOrThrow;
await send('Page.enable'); await send('Runtime.enable');
const pageLog = [];
page.on((m) => {
  if (m.method !== 'Runtime.consoleAPICalled') return;
  const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? '')).join(' ');
  if (text.includes('[favorites]')) pageLog.push(text.slice(0, 220));
});
let signed = 0; // kind:10333 signatures the page asked for — a signer prompt
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = pk;
    else if (fn === 'signEvent') { if (args[0].kind === 10333) signed += 1; out = finalizeEvent(args[0], sk); }
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
    window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => call('signEvent', e) };
  })();
` });

const notice = () => js(`(() => {
  const n = [...document.querySelectorAll('[role="status"]')].find((x) => /favorites|list/i.test(x.textContent));
  return n ? n.innerText.replace(/\\s+/g, ' ').trim() : null;
})()`);
const press = (label) => js(`(() => {
  const b = [...document.querySelectorAll('[role="status"] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (b) b.click();
  return !!b;
})()`);
async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(500); }
  return null;
}
async function fresh(relays, extra = '') {
  await send('Page.navigate', { url: APP }); await wait(1500);
  await js(`(() => { localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify(relays))});
    ${extra}
    return 1; })()`);
}

console.log(`\n  throwaway npub ${npub.slice(0, 20)}…   app ${APP}`);

// ===========================================================================
section('A. sign in with 2 signed-out favorites; ONE relay says "no list", the holder is down');
// ===========================================================================
await seedHolder(); // the list exists — on a relay this read will not reach
await fresh([deadUrl, empty1.url], `localStorage.setItem('bmb:favorites:guest', ${JSON.stringify(twoShows)});`);
await send('Page.navigate', { url: APP }); await wait(4000);
// The incident's own path: the sign-in modal, then the extension row.
const opened = await js(`(() => {
  const b = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((x) => x.textContent.trim().startsWith('Sign in'));
  if (b) b.click(); return !!b; })()`);
await wait(800);
await js(`(() => { const b = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes('Sign in with Nostr')); if (b) b.click(); return !!b; })()`);
await wait(1200);
const viaModal = await js(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Browser Extension'));
  if (b) b.click(); return !!b; })()`);
check('signed in through the modal\'s Browser Extension row', { opened, viaModal }, { opened: true, viaModal: true });
const signedInAs = await waitFor(() => js(`localStorage.getItem('bmb:npub')`), 15000);
check('the app is signed in as the throwaway key', signedInAs, npub);
const noticeA = await waitFor(notice, 30000);
await wait(8000); // past the 1.5 s publish debounce, several times over
check('nothing was published', published.filter((p) => p.relay !== 'holder').length, 0);
check('and no kind:10333 signature was asked for', signed, 0);
check('the notice says the list could not be confirmed', /Couldn.t confirm your list/.test(noticeA ?? ''), true);
check('the two signed-out favorites are still on this device',
  await js(`Object.keys(JSON.parse(localStorage.getItem('bmb:favorites:guest') || '{}')).length`), 2);

// `--only-a` stops here: the run that proves this file fails on the code
// before the fix, where A is the incident.
if (process.argv.includes('--only-a')) {
  if (t.fails) console.log('\n  page log:\n   ' + pageLog.slice(-25).join('\n   '));
  console.log(`\n${t.count - t.fails}/${t.count} passed`);
  await exit(t.fails ? 1 : 0);
}

// ===========================================================================
section('B. TWO relays say "no list": the app asks, and "save as new list" creates it');
// ===========================================================================
await fresh([deadUrl, empty1.url, empty2.url], `
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:favorites:' + ${JSON.stringify(npub)}, ${JSON.stringify(twoShows)});`);
const beforeB = published.length;
await send('Page.navigate', { url: APP });
const noticeB = await waitFor(async () => { const n = await notice(); return n && /No favorites list was found/.test(n) ? n : null; }, 40000);
await wait(6000);
check('a page load does not create the list on its own', published.length - beforeB, 0);
check('it asks, with the count', /save the 2 on this device as a new list/.test(noticeB ?? ''), true);
check('and offers retry first', await js(`[...document.querySelectorAll('[role="status"] button')].map((b) => b.textContent.trim())`), ['retry', 'save as new list']);
await press('save as new list');
await waitFor(() => published.length > beforeB, 20000);
const madeB = published.slice(beforeB).map((p) => p.event);
check('"save as new list" creates it', madeB.length > 0, true);
check('...with the 2 favorites', madeB[0]?.tags.filter((x) => x[0] === 'i').length, 2);

// ===========================================================================
section('C. the list IS read, but the store holds 2 of its 8: the app asks before removing');
// ===========================================================================
await seedHolder();
await fresh([holder.url], `
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:fav_privacy:' + ${JSON.stringify(npub)}, 'public');
  localStorage.setItem('bmb:favorites:' + ${JSON.stringify(npub)}, ${JSON.stringify(twoShows)});
  localStorage.setItem('bmb:favbaseline:' + ${JSON.stringify(npub)}, ${JSON.stringify(JSON.stringify(FULL_BASELINE))});`);
const beforeC = published.length;
const signedBeforeC = signed;
await send('Page.navigate', { url: APP });
const noticeC = await waitFor(async () => { const n = await notice(); return n && /would remove/.test(n) ? n : null; }, 40000);
await wait(5000);
check('the notice names the numbers', noticeC?.match(/remove \d+ of your \d+ favorites/)?.[0], `remove ${LIST_SIZE - 1} of your ${LIST_SIZE} favorites`);
check('nothing was published while it asks', published.length - beforeC, 0);
check('and nothing was signed', signed - signedBeforeC, 0);
check('keep comes first', await js(`[...document.querySelectorAll('[role="status"] button')].map((b) => b.textContent.trim())`), ['keep them', 'remove them']);
await press('keep them');
await waitFor(() => published.length > beforeC, 25000);
const keptC = published.slice(beforeC).map((p) => p.event).at(-1);
check('"keep them" publishes the list WITH the new show (8 + 1)', keptC?.tags.filter((x) => x[0] === 'i').length, LIST_SIZE + 1);
check('...keeps `visibility` right after `alt`', keptC?.tags.slice(0, 2), [['alt', 'PC 2.0 Favorites'], ['visibility', 'public']]);
check('...keeps a `k` for both kinds', keptC?.tags.filter((x) => x[0] === 'k'), [['k', 'podcast:item:guid'], ['k', 'podcast:guid']]);
await wait(3000);
check('and the notice is gone', await notice(), null);

// ===========================================================================
section('D. the same question, answered "remove them"');
// ===========================================================================
await seedHolder();
await fresh([holder.url], `
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:fav_privacy:' + ${JSON.stringify(npub)}, 'public');
  localStorage.setItem('bmb:favorites:' + ${JSON.stringify(npub)}, ${JSON.stringify(twoShows)});
  localStorage.setItem('bmb:favbaseline:' + ${JSON.stringify(npub)}, ${JSON.stringify(JSON.stringify(FULL_BASELINE))});`);
const beforeD = published.length;
await send('Page.navigate', { url: APP });
await waitFor(async () => /would remove/.test((await notice()) ?? ''), 40000);
await press('remove them');
await waitFor(() => published.length > beforeD, 20000);
const removedD = published.slice(beforeD).map((p) => p.event).at(-1);
check('"remove them" publishes the 2 the device holds', removedD?.tags.filter((x) => x[0] === 'i').length, 2);
check('...and still states `visibility`', removedD?.tags.find((x) => x[0] === 'visibility'), ['visibility', 'public']);

// ===========================================================================
section('E. at phone width, the question fits and its buttons are targets');
// ===========================================================================
// CDP device emulation, never `--window-size`: Chrome lays a page out at its
// default width and then crops, which looks exactly like overflow.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await seedHolder();
await fresh([holder.url], `
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:fav_privacy:' + ${JSON.stringify(npub)}, 'public');
  localStorage.setItem('bmb:favorites:' + ${JSON.stringify(npub)}, ${JSON.stringify(twoShows)});
  localStorage.setItem('bmb:favbaseline:' + ${JSON.stringify(npub)}, ${JSON.stringify(JSON.stringify(FULL_BASELINE))});`);
for (const path of ['/', '/favorites']) {
  await send('Page.navigate', { url: APP + path });
  await waitFor(async () => /would remove/.test((await notice()) ?? ''), 40000);
  const m = JSON.parse(await js(`(() => {
    const n = [...document.querySelectorAll('[role="status"]')].find((x) => /would remove/.test(x.textContent));
    const r = n.getBoundingClientRect();
    return JSON.stringify({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      inView: r.left >= 0 && r.right <= document.documentElement.clientWidth,
      buttons: [...n.querySelectorAll('button')].map((b) => { const q = b.getBoundingClientRect(); return [Math.round(q.width), Math.round(q.height)]; }),
    });
  })()`));
  check(`${path}: no sideways overflow`, m.overflow <= 0, true);
  check(`${path}: the notice sits inside the screen`, m.inView, true);
  check(`${path}: both buttons are at least 24×24`, m.buttons.length === 2 && m.buttons.every(([w, h]) => w >= 24 && h >= 24), true);
  if (!m.buttons.every(([w, h]) => w >= 24 && h >= 24)) console.log('         buttons', JSON.stringify(m.buttons));
}
await send('Emulation.clearDeviceMetricsOverride');

// ===========================================================================
section('Nothing left this machine');
// ===========================================================================
check('every kind:10333 landed on a local relay', published.every((p) => ['holder', 'empty1', 'empty2'].includes(p.relay)), true);

if (t.fails) console.log('\n  page log:\n   ' + pageLog.slice(-25).join('\n   '));
console.log(`\n${t.count - t.fails}/${t.count} passed`);
for (const r of [holder, empty1, empty2]) r.close?.();
await exit(t.fails ? 1 : 0);
