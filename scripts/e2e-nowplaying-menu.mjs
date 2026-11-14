// The avatar on the now-playing screen opens the account menu the header opens.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:npmenu                            # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:npmenu -- --headed --keep
//
// ASKED FOR (2026-11-13, Chad's iPhone, the now-playing screen): "if I click my
// avatar in the top right, I'd like it to open the same menu that it does on
// the home screen." It was <NostrIdentityChip>, a readout with no press.
//
// WHAT IT PINS:
//   1. The avatar in the player's bar is a menu button, and a press opens the
//      account menu ON TOP of the player, inside the screen, at phone width.
//   2. It is the header's menu: edit profile, my boosts, report a bug, sign out
//      — and no theme link, which was asked off this screen before.
//   3. "my boosts" closes the player and opens the boosts page.
//   4. "sign out" from this menu signs out: `bmb:npub` is gone and the bar
//      offers SIGN IN. Its own copy of the function (`useSignOut`), so it does
//      not depend on a <NostrAuth> being mounted on the route.
//   5. No horizontal overflow at 320 and 390, and the button clears 24×24.
//
// A throwaway key behind `window.nostr` and an in-memory relay, as e2e:queue
// does it; the album and its audio are answered here. NOTHING reaches a public
// relay or Podcast Index.

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

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
const AUDIO = silentWav(30);
const GUID = 'ac0e4000-0000-4000-8000-000000000001';
const ALBUM = { id: 900993, podcastGuid: GUID, title: 'E2E Menu Album', author: 'e2e', medium: 'music', url: 'https://feeds.example.invalid/menu.xml' };
const TRACKS = [0, 1].map((k) => ({
  id: 9300 + k, guid: `ac0e4000-0000-4000-8000-00000000010${k}`, podcastGuid: GUID, feedId: ALBUM.id,
  title: `Menu track ${k}`, episode: k + 1, duration: 30, enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
}));

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const convo = nip44.v2.utils.getConversationKey(sk, pk);
const relay = createRelay({ port: 0, log: null, onEvent: () => {} });
const PORT = await relay.ready;

const { page } = await launchChrome({ name: 'npmenu', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

await send('Page.enable');
await send('Runtime.enable');
await send('Runtime.addBinding', { name: 'bmbSigner' });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const waiting = new Map();
  window.__bmbResolve = (rid, out, err) => { const p = waiting.get(rid); if (!p) return; waiting.delete(rid); err ? p.reject(new Error(err)) : p.resolve(out); };
  let n = 0;
  const call = (fn, args) => new Promise((resolve, reject) => { const rid = 'r' + (++n); waiting.set(rid, { resolve, reject }); window.bmbSigner(JSON.stringify({ rid, fn, args })); });
  window.nostr = {
    getPublicKey: () => call('getPublicKey', []),
    signEvent: (e) => call('signEvent', [e]),
    nip44: { encrypt: (p, t) => call('nip44.encrypt', [p, t]), decrypt: (p, c) => call('nip44.decrypt', [p, c]) },
    nip04: { encrypt: (p, t) => call('nip04.encrypt', [p, t]), decrypt: (p, c) => call('nip04.decrypt', [p, c]) },
  };
})();` });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method === 'Runtime.bindingCalled' && m.params.name === 'bmbSigner') {
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
    await send('Runtime.evaluate', { expression: `window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify(out ?? null)}, ${JSON.stringify(err)})` });
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  try {
    if (u.pathname === '/api/e2e-audio.wav') {
      const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
      const mm = range && /bytes=(\d+)-(\d*)/.exec(range);
      const start = mm ? Number(mm[1]) : 0;
      const end = mm && mm[2] ? Math.min(Number(mm[2]), AUDIO.length - 1) : AUDIO.length - 1;
      const body = AUDIO.subarray(start, end + 1);
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: mm ? 206 : 200,
        responseHeaders: [
          { name: 'content-type', value: 'audio/wav' }, { name: 'accept-ranges', value: 'bytes' },
          { name: 'content-length', value: String(body.length) },
          ...(mm ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
        ],
        body: body.toString('base64'),
      });
      return;
    }
    const answer = u.pathname === '/api/by-guid' ? { podcast: ALBUM }
      : u.pathname === '/api/feed' ? { podcast: ALBUM, episodes: TRACKS }
      : u.pathname === '/api/live-shows' ? { items: [], unverifiedFeeds: 0, truncated: false }
      : null;
    if (answer) {
      await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: b64(answer) });
      return;
    }
    await send('Fetch.continueRequest', { requestId });
  } catch {
    // The page navigated away under a paused request.
  }
});

// The player's bar is the row holding its ✕; the menu button is the account one in it.
const BAR = `document.querySelector('[aria-label="Close fullscreen player"]')?.parentElement`;
const TRIGGER = `${BAR}?.querySelector('button[aria-haspopup="menu"][aria-label^="Account:"]')`;
const MENU = `${BAR}?.querySelector('[role="menu"]')`;

async function signedInPlayerOpen() {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'nip07');
    localStorage.setItem('bmb:fav_privacy:${npub}', 'off');
    return 1; })()`);
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes('Menu track 1'))`, 30000);
  await until(`!!document.querySelector('button[aria-label^="Account:"]')`, 30000);
  await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Menu track 0')).click()`);
  await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2; })()`, 15000);
  await js(`document.querySelector('[aria-label^="Open fullscreen player"]')?.click()`);
  await until(`!!document.querySelector('[aria-label="Close fullscreen player"]')`, 10000);
  await wait(800);
}

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

// ---------------------------------------------------------------------------
console.log('\n1. The avatar opens the account menu on top of the player');
await signedInPlayerOpen();
t.ok('the avatar in the bar is a menu button', await until(`!!${TRIGGER}`, 10000));
await js(`${TRIGGER}.click()`);
t.ok('a press opens the menu', await until(`!!${MENU}`, 5000));
const geo = JSON.parse(await js(`JSON.stringify((() => {
  const m = ${MENU}; const r = m.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(40, r.height / 2));
  return { inside: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0, onTop: !!hit && m.contains(hit), w: Math.round(r.width) };
})())`));
t.ok('…inside the screen', geo.inside, JSON.stringify(geo));
t.ok('…and on top of the player, not under it', geo.onTop, JSON.stringify(geo));

// ---------------------------------------------------------------------------
console.log('\n2. It is the header\'s menu');
const items = JSON.parse(await js(`JSON.stringify([...${MENU}.querySelectorAll('button')].map((b) => b.textContent.trim().toLowerCase()))`));
for (const want of ['edit profile', 'my boosts', 'report a bug', 'sign out']) {
  t.ok(`it offers "${want}"`, items.some((x) => x.includes(want)), JSON.stringify(items));
}
t.ok('no theme link on this screen', !items.some((x) => /light mode|dark mode/.test(x)), JSON.stringify(items));

// ---------------------------------------------------------------------------
console.log('\n5. Layout');
await js(`${TRIGGER}.click()`); // close it
await wait(300);
for (const [name, width] of [['320', 320], ['390', 390]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 3, mobile: true });
  await wait(400);
  const m = JSON.parse(await js(`JSON.stringify((() => { const b = ${TRIGGER}.getBoundingClientRect();
    return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }; })())`));
  t.equal(`${name}: no horizontal overflow`, m.sw, m.cw);
  t.ok(`${name}: the button is at least 24×24 and on screen`, m.w >= 24 && m.h >= 24 && m.right <= width, JSON.stringify(m));
}
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

// ---------------------------------------------------------------------------
console.log('\n3. "my boosts" closes the player and opens the boosts page');
await js(`${TRIGGER}.click()`);
await until(`!!${MENU}`, 5000);
// Where the address was at the moment the player closed. A live page
// (`/live/<npub>`, `/stream/<naddr>`) sends a CLOSING player home, and a newer
// push discards the pending one — so the player must close only once the
// address is already the boosts page (review of #549).
// The ROOT's class, not the ✕'s visibility: `invisible` waits out the 300 ms
// slide, `translate-y-full` lands in the render that closes it.
await js(`(() => { window.__closedAt = null;
  const root = document.querySelector('[aria-label="Close fullscreen player"]').closest('div.fixed.inset-x-0.top-0');
  const tick = () => {
    if (root.classList.contains('translate-y-full')) { window.__closedAt = location.pathname; return; }
    requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 1; })()`);
await js(`[...${MENU}.querySelectorAll('button')].find((b) => /my boosts/i.test(b.textContent)).click()`);
t.ok('the boosts page opens', await until(`location.pathname === ${JSON.stringify(`/npub/${npub}`)}`, 15000), await js('location.pathname'));
// Closed is `invisible` on the player's root (fullscreen-player.tsx), so its ✕
// computes `visibility: hidden`.
t.ok('…and the player is closed, not covering it', await until(`(() => { const x = document.querySelector('[aria-label="Close fullscreen player"]'); return !x || getComputedStyle(x).visibility === 'hidden'; })()`, 5000));
t.ok('…closed only once the address was the boosts page, so a live page cannot send it home',
  ((await js('window.__closedAt')) ?? '').startsWith('/npub/'), await js('window.__closedAt'));

// ---------------------------------------------------------------------------
console.log('\n4. "sign out" from this menu signs out');
await signedInPlayerOpen();
await js(`${TRIGGER}.click()`);
await until(`!!${MENU}`, 5000);
await js(`[...${MENU}.querySelectorAll('button')].find((b) => /sign out/i.test(b.textContent)).click()`);
t.ok('bmb:npub is gone', await until(`localStorage.getItem('bmb:npub') === null`, 10000));
t.ok('the bar offers SIGN IN instead of the menu', await until(`!${TRIGGER} && /sign in/i.test(${BAR}?.textContent ?? '')`, 10000), await js(`${BAR}?.textContent`));

// ---------------------------------------------------------------------------
console.log('\n6. A phone in landscape: the menu fits and scrolls');
// A `fixed` box never scrolls with the page, so a menu taller than the room
// under the bar left "sign out" and "report a bug" below the edge, unreachable
// (review of #549; the ⋯ panel in the same bar caps itself the same way).
// 200 tall: the rule is that the menu fits and scrolls at ANY height. This
// test account's menu is four buttons (176px); a real one is taller — an open
// mute list, the stale-signer banner, the key export — than the ~320px Safari's
// bars leave in landscape. So the screen shrinks instead of the menu growing.
await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 200, deviceScaleFactor: 3, mobile: true });
await signedInPlayerOpen();
await js(`${TRIGGER}.click()`);
t.ok('the menu opens', await until(`!!${MENU}`, 5000));
await wait(300);
const land = JSON.parse(await js(`JSON.stringify((() => { const m = ${MENU}; const r = m.getBoundingClientRect();
  return { bottom: Math.round(r.bottom), vh: innerHeight, scrolls: m.scrollHeight > m.clientHeight + 1 }; })())`));
t.ok('the menu ends inside the screen', land.bottom <= land.vh + 1, JSON.stringify(land));
await js(`(() => { const m = ${MENU}; m.scrollTop = m.scrollHeight; return 1; })()`);
await wait(200);
const so = JSON.parse(await js(`JSON.stringify((() => { const b = [...${MENU}.querySelectorAll('button')].find((x) => /sign out/i.test(x.textContent));
  const r = b?.getBoundingClientRect(); return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight } : null; })())`));
t.ok('"sign out" can be scrolled into the screen', !!so && so.bottom <= so.vh + 1 && so.top >= 0, JSON.stringify(so));
await js(`${TRIGGER}.click()`);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

// ---------------------------------------------------------------------------
console.log('\n7. The notices under the avatar sit under the avatar from the start');
// The anchor for the bunker notices (shown while the menu is CLOSED) took its
// height when the player mounted — mid slide-in, with the root still
// translated a screen down — and kept it until the menu was opened once
// (review of #549). Measured against the root, the slide does not matter.
await signedInPlayerOpen();
const anchor = JSON.parse(await js(`JSON.stringify((() => {
  const box = [...(${BAR}?.querySelectorAll('div.fixed.right-4') ?? [])].find((d) => d.getAttribute('role') !== 'menu');
  const b = ${TRIGGER}?.getBoundingClientRect();
  if (!box || !b) return null;
  return { top: Math.round(box.getBoundingClientRect().top), under: Math.round(b.bottom + 8), vh: innerHeight };
})())`));
t.ok('the closed-menu notice anchor is just under the avatar', !!anchor && Math.abs(anchor.top - anchor.under) <= 2, JSON.stringify(anchor));

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
relay.close?.();
await exit(t.fails ? 1 : 0);
