// Drives the REAL <Player> in a real browser and asserts the speed each show
// plays at, and what `bmb:playback_rate` and `bmb:playback_rate:<showKey>` hold
// at each step.
//
// WHY THIS IS AN E2E AND NOT A `check:*`. `speedShowKey` and the storage
// accessor are a key and an allowlist; the ways per-show speed breaks are in
// the WIRING: `useShowSpeed`'s subscription has to re-resolve the store's
// `playbackRate` inside the `set()` that moved `current`, before <Player>'s
// apply effect puts a speed on the newly sourced element, and it has to be
// subscribed before the reveal effect sets `current` on a reload. Only the
// element's own `playbackRate` proves either.
//
// It also pins what the feature must NOT do: a music feed plays at 1× with no
// control and saves no show entry, and a show never touched follows the global
// speed. Section 7 plays three seeded downloads from /downloads, where only the
// download RECORD knows an album track is music, and a record with no feed guid or
// id must not share a '0' key. The songs INSIDE an episode are `e2e:music-hold`.
// Section 8 drives the 1×–2× SLIDER in the fullscreen player's ⋯
// menu on a phone: the keyboard and a pointer each move it, the speed it saves
// is the list's exact string (never a browser float), the menu's SPEED tile
// goes on from it, a fast tile parks the thumb at 1× while the slider names
// the true speed, a speed between stops (1.25×) steps by the keys and by a tap
// on the stop under the thumb, a slider speed is saved for its show like any
// other, and on a phone in landscape the menu scrolls to it. Section 9 makes
// the browser refuse 3.5×: the refused key goes, and no show is handed a '1'
// entry.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:speed                   # add --headed to watch it
//
// It needs the network: Podcast Index through the app's routes and each
// show's enclosures. If a show goes, any podcast with a playable first row
// will do; if the music feed goes, any `medium=music` feed will.
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';

/** Bowl After Bowl — a talk show. */
const SHOW_A = '2d418249-453a-5714-8abc-5b657570b641';
/** Podcasting 2.0 — a talk show. */
const SHOW_B = '917393e3-1b1e-5cef-ace4-edaa54e1f810';
/** The talk show e2e:artbytes uses — never touched here until the last step. */
const SHOW_C = '290e12c3-91a7-5c30-be14-1837a1a976e2';
/** A Wavlake single — `medium=music`, so `playsAsTracks`. */
const MUSIC = '225fa8a9-abc4-53ec-a133-2d3f10f1486e';

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

// 1200 wide, so the mini-bar shows the SPEED chip (lg: only).
const { page } = await launchChrome({ name: 'speed', autoplay: true, args: ['--window-size=1200,900'] });
const { send, js, until } = page;

const t = checker();
const finish = async () => {
  console.log(t.fails ? `\n${t.fails} speed check(s) FAILED.` : '\nAll speed checks passed.');
  await exit(t.fails ? 1 : 0);
};
const go = async (url) => { await send('Page.navigate', { url }); await wait(1500); };

const PLAYABLE = 'li button[aria-label="Play"]:not([disabled])';
const playing = `(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && !a.paused; })()`;
const rateNow = () => js(`document.querySelector('audio')?.playbackRate ?? null`);
const stored = () => js(`(() => { const o = {};
  for (const k of Object.keys(localStorage)) if (k.startsWith('bmb:playback_rate')) o[k] = localStorage.getItem(k);
  return o; })()`);
const CHIP = `document.querySelector('${MINI_BAR} button[aria-label^="Playback speed"]')`;
/** Press the mini-bar SPEED chip until the element plays at `to`. */
const chipTo = async (to) => {
  for (let i = 0; i < 6; i++) {
    if (await rateNow() === to) return true;
    await js(`${CHIP}?.click()`);
    await wait(300);
  }
  return await rateNow() === to;
};

/** Open a show and play its first playable row; resolves to the element's speed. */
const playShow = async (guid) => {
  await go(`${APP}/?podcast=${guid}`);
  if (!await until(`!!document.querySelector('${PLAYABLE}')`, 30000)) return null;
  await js(`document.querySelector('${PLAYABLE}').click()`);
  if (!await until(playing, 30000)) return null;
  await wait(800);
  return rateNow();
};
const expectRate = (label, got, want) => t.equal(label, got, want);

await send('Page.enable');
await send('Runtime.enable');
await go(`${APP}/privacy`);
await js(`(() => { localStorage.clear(); return true; })()`);

console.log('1. Show A at 1.5× — saves the global speed AND show A\'s own');
expectRate('show A starts at 1×', await playShow(SHOW_A), 1);
t.ok('the chip moves show A to 1.5×', await chipTo(1.5), JSON.stringify(await stored()));
let s = await stored();
expectRate('global bmb:playback_rate', s['bmb:playback_rate'], '1.5');
expectRate(`bmb:playback_rate:${SHOW_A}`, s[`bmb:playback_rate:${SHOW_A}`], '1.5');

console.log('\n2. Show B, never touched — follows the global speed; 1× there is saved as 1');
expectRate('show B plays at the global 1.5×', await playShow(SHOW_B), 1.5);
t.ok('the chip moves show B to 1×', await chipTo(1), JSON.stringify(await stored()));
s = await stored();
expectRate(`bmb:playback_rate:${SHOW_B}`, s[`bmb:playback_rate:${SHOW_B}`], '1');
expectRate('the global key is removed at 1×', s['bmb:playback_rate'], undefined);

console.log('\n3. Show A again — its own 1.5×, over the global 1×');
expectRate('show A plays at 1.5×', await playShow(SHOW_A), 1.5);

console.log('\n4. Reload — the revealed show A episode comes back at 1.5×');
await go(`${APP}/?podcast=${SHOW_A}`);
await until(`!!document.querySelector('${MINI_BAR}')`, 30000);
await wait(1000);
expectRate('the element is at 1.5× after the reload', await rateNow(), 1.5);
const chip = await js(`${CHIP}?.textContent.trim() ?? null`);
t.ok('the chip names 1.5×', typeof chip === 'string' && chip.startsWith('1.5×'), `chip: ${chip}`);

// Music is hard-coded at 1× (docs/ui.md, "Music plays at 1×"), and until then this
// section pinned that a track played at the global speed.
console.log('\n5. A music feed — 1× under a global 2×, no control, no show entry, the global kept');
await js(`(() => { localStorage.setItem('bmb:playback_rate', '2'); return true; })()`);
expectRate('the music track plays at 1×, not the global 2×', await playShow(MUSIC), 1);
t.ok('no speed chip on a music track', await js(`!${CHIP}`));
s = await stored();
expectRate('the global 2× is untouched', s['bmb:playback_rate'], '2');
const musicKeys = Object.keys(s).filter((k) => k.includes(MUSIC));
t.ok('no entry for the music feed', musicKeys.length === 0, JSON.stringify(musicKeys));

console.log('\n6. Each show keeps its own; a never-touched show takes the new global');
expectRate('show B plays at its 1×', await playShow(SHOW_B), 1);
expectRate('show A plays at its 1.5×', await playShow(SHOW_A), 1.5);
expectRate('show C plays at the global 2×', await playShow(SHOW_C), 2);
s = await stored();
t.ok('show C has no entry', !(`bmb:playback_rate:${SHOW_C}` in s), JSON.stringify(s));

// 7. FROM /downloads the player's show is rebuilt with NO medium
// (`dbRowToPodcast`), so only the download RECORD can say an item is an album
// track — the case `deletableAfterPlay` already answers from the record. Three
// 60-second WAVs, seeded where download-manager would put them (the method
// `e2e:downloads` section 15 uses): an album track, a podcast episode, and a
// record with no feed guid and no feed id, which rebuilds as `feedId: 0`.
console.log('\n7. Downloads: an album track saves no entry, a podcast does, no-id saves no "0"');
const DL_ALB = { url: 'https://example.invalid/speed-alb.wav', guid: 'e2e-speed-alb', title: 'Speed Album Track', feed: 'e2e-speed-alb-feed', feedId: 424301, medium: 'music' };
const DL_POD = { url: 'https://example.invalid/speed-pod.wav', guid: 'e2e-speed-pod', title: 'Speed Pod Episode', feed: 'e2e-speed-pod-feed', feedId: 424302, medium: '' };
const DL_NOID = { url: 'https://example.invalid/speed-noid.wav', guid: 'e2e-speed-noid', title: 'Speed No Id Episode', medium: '' };
await go(`${APP}/downloads`);
await js(`(async () => {
  const wav = (sec, rate = 8000) => {
    const n = sec * rate, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    return new Blob([buf], { type: 'audio/wav' });
  };
  const cache = await caches.open('bmb-downloads-v1');
  const db = await new Promise((res, rej) => { const r = indexedDB.open('BmbDownloadsDB'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  let t = 1;
  for (const e of [${JSON.stringify(DL_ALB)}, ${JSON.stringify(DL_POD)}, ${JSON.stringify(DL_NOID)}]) {
    const blob = wav(60);
    await cache.put(e.url, new Response(blob, { headers: { 'content-type': 'audio/wav' } }));
    const rec = {
      key: e.url, enclosureUrl: e.url, enclosureType: 'audio/wav', sizeBytes: blob.size,
      createdAt: t++, itemGuid: e.guid, episodeId: 930000000 + t, title: e.title,
      feedTitle: e.title + ' Show', duration: 60, feedMedium: e.medium,
    };
    if (e.feed) rec.feedGuid = e.feed;
    if (e.feedId) rec.feedId = e.feedId;
    await new Promise((res, rej) => {
      const tx = db.transaction('downloads', 'readwrite');
      tx.objectStore('downloads').put(rec);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }
  for (const k of Object.keys(localStorage)) if (k.startsWith('bmb:playback_rate')) localStorage.removeItem(k);
  localStorage.setItem('bmb:playback_rate', '1.5');
  return true;
})()`);
await go(`${APP}/downloads`);
/** Play one /downloads row; resolves to the element's speed once it plays local bytes. */
const playDownload = async (title) => {
  const sel = `button[aria-label="Play ${title}"]`;
  if (!await until(`!!document.querySelector('${sel}')`, 15000)) return null;
  await js(`document.querySelector('${sel}').click()`);
  if (!await until(`(() => { const a = document.querySelector('audio'); return !!a && a.src.startsWith('blob:') && !a.paused; })()`, 15000)) return null;
  await wait(800);
  return rateNow();
};
expectRate('the album track plays at 1× (its record says music)', await playDownload(DL_ALB.title), 1);
t.ok('no speed chip on the album track', await js(`!${CHIP}`));
s = await stored();
t.ok('no entry for the album (its record says music)', !(`bmb:playback_rate:${DL_ALB.feed}` in s), JSON.stringify(s));
expectRate('the global 1.5× is untouched', s['bmb:playback_rate'], '1.5');
expectRate('the podcast download plays at the global 1.5×', await playDownload(DL_POD.title), 1.5);
t.ok('the chip moves the podcast download to 1.25×', await chipTo(1.25), JSON.stringify(await stored()));
s = await stored();
expectRate(`bmb:playback_rate:${DL_POD.feed}`, s[`bmb:playback_rate:${DL_POD.feed}`], '1.25');
expectRate('the no-id download plays at the global 1.25×', await playDownload(DL_NOID.title), 1.25);
t.ok('the chip moves the no-id download to 1.5×', await chipTo(1.5), JSON.stringify(await stored()));
s = await stored();
t.ok('no shared "0" entry', !('bmb:playback_rate:0' in s), JSON.stringify(s));
t.ok('no entry under any other made-up key', Object.keys(s).every((k) => k === 'bmb:playback_rate'
  || k === `bmb:playback_rate:${DL_POD.feed}`), JSON.stringify(s));

// 8. THE SLIDER, where a phone has it: the fullscreen player's ⋯ menu. It sets
// the store's ONE speed through `setPlaybackRate`, so everything above applies
// to it; what is new is the input itself. Its value is an INDEX into
// `SPEED_SLIDER_RATES`, and the assertions on the stored STRINGS are what
// prove no browser float (1.2000000000000002) reaches the storage allowlist.
console.log('\n8. The slider (phone, 390×844, then landscape): keys and pointer, exact strings, between stops, per show');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await go(`${APP}/privacy`);
await js(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('bmb:playback_rate')) localStorage.removeItem(k); return true; })()`);
const SLIDER = `document.querySelector('input[type="range"][aria-label^="Playback speed, 1× to 2×"]')`;
const openMenu = async () => {
  await js(`document.querySelector('button[aria-label^="Open fullscreen player"]')?.click()`);
  await until(`!!document.querySelector('button[aria-label="More actions for this episode"]')`, 15000);
  // The fullscreen player SLIDES up, and the ⋯ starts BELOW the screen (y=854
  // at 390×844). `useAnchoredMenu` measures the trigger once, at open, so a
  // press during the slide put the panel at `bottom: -1.9px`, off the screen.
  // No finger presses a button below the screen: wait until it is on the
  // screen and two reads, a poll apart, agree on where.
  await js(`(() => { window.__e2eMoreAt = null; return true; })()`);
  await until(`(() => { const r = document.querySelector('button[aria-label="More actions for this episode"]')?.getBoundingClientRect();
    if (!r || r.top < 0 || r.bottom > innerHeight) return false;
    const at = Math.round(r.top) + ':' + Math.round(r.left); const same = window.__e2eMoreAt === at; window.__e2eMoreAt = at; return same; })()`, 15000);
  await js(`document.querySelector('button[aria-label="More actions for this episode"]').click()`);
  // The menu puts focus on its first item a frame or two AFTER it opens
  // (`useMenuKeys`). Focusing the slider before that lands loses it to the
  // first tile, and the arrow keys then press nothing — a test race, not an
  // app one: measured, the keys hold at 30 ms apart once the menu has settled.
  if (!await until(`!!document.activeElement?.closest('[role="menu"]')`, 10000)) return false;
  await wait(300);
  return until(`!!${SLIDER} && ${SLIDER}.getBoundingClientRect().width > 0`, 10000);
};
const key = async (k, code) => {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await wait(150);
};
/** Focus the slider and press `k` `n` times. */
const press = async (k, code, n = 1) => {
  await js(`${SLIDER}.focus()`);
  if (!await js(`document.activeElement === ${SLIDER}`)) t.fail('the slider holds focus before the keys', await js(`document.activeElement?.outerHTML.slice(0, 120) ?? null`));
  for (let i = 0; i < n; i++) await key(k, code);
  await wait(300);
};
const right = (n) => press('ArrowRight', 39, n);
// The tiles are found INSIDE the menu. The mini-bar's SPEED chip carries the
// same label as the menu's SPEED tile ("Playback speed 1.3×, change to 1.5×")
// and comes first in the document, hidden below lg: — an unscoped selector
// clicked the chip, and the tile was never tested.
const IN_MENU = (sel) => `document.querySelector('[role="menu"] ${sel}')`;
const SPEED_TILE = IN_MENU('button[aria-label*=", change to"]');
const FAST_35 = IN_MENU('button[aria-label="Playback speed 3.5×"]');
const tap = async (el) => { await js(`${el}?.click()`); await wait(400); };
const sliderValue = () => js(`${SLIDER}?.value ?? null`);
/** A pointer press on the slider's stop `i` (0 = 1×, 10 = 2×). */
const pressStop = async (i) => {
  const at = JSON.parse(await js(`(() => { const el = ${SLIDER}; const r = el.getBoundingClientRect();
    const thumb = parseFloat(getComputedStyle(el).getPropertyValue('--seek-thumb')) || 16;
    return JSON.stringify({ x: r.left + thumb / 2 + (${i} / 10) * (r.width - thumb), y: r.top + r.height / 2 }); })()`));
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await wait(400);
};
const valuetext = () => js(`${SLIDER}?.getAttribute('aria-valuetext') ?? null`);

expectRate('phone: show A starts at 1×', await playShow(SHOW_A), 1);
t.ok('phone: the ⋯ menu shows the slider', await openMenu());
const sbox = await js(`(() => { const r = ${SLIDER}.getBoundingClientRect(); const m = ${SLIDER}.closest('[role="menu"]').getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), menu: Math.round(m.width) }; })()`);
// "Full-width" is the menu's width less its padding, not a number of pixels.
t.ok('phone: the slider is at least 24px tall and spans the menu', sbox && sbox.h >= 24 && sbox.w >= sbox.menu - 32, JSON.stringify(sbox));
const ticks = await js(`(() => { const m = ${SLIDER}.closest('[role="menu"]'); return [...m.querySelectorAll('[data-speed-tick]')].map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.height); }); })()`);
t.ok('phone: a visible tick for every 0.1 stop — eleven, each at least 8px', Array.isArray(ticks) && ticks.length === 11 && ticks.every((h) => h >= 8), JSON.stringify(ticks));
t.equal('phone: no horizontal overflow with the slider shown', await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0);
// The line above cannot see the menu: a `fixed` panel adds nothing to the
// document's scroll width. So the panel is measured against the screen, and
// the slider and each tick's label against the panel.
const fit = await js(`(() => { const s = ${SLIDER}; const menu = s.closest('[role="menu"]'); const m = menu.getBoundingClientRect();
  const parts = [s, ...[...menu.querySelectorAll('[data-speed-tick]')].map((el) => el.parentElement)].map((el) => el.getBoundingClientRect());
  return { inScreen: m.left >= 0 && m.top >= 0 && m.right <= innerWidth && m.bottom <= innerHeight,
    partsInMenu: parts.every((r) => r.left >= m.left && r.right <= m.right),
    menu: [m.left, m.top, m.right, m.bottom].map(Math.round), screen: [innerWidth, innerHeight] }; })()`);
t.ok('phone: the menu, slider row included, is inside the screen', fit?.inScreen, JSON.stringify(fit));
t.ok('phone: the slider and every tick label are inside the menu', fit?.partsInMenu, JSON.stringify(fit));

await right(3);
expectRate('three ArrowRight presses → 1.3×', await rateNow(), 1.3);
s = await stored();
expectRate('the exact string "1.3", globally', s['bmb:playback_rate'], '1.3');
expectRate('and for show A', s[`bmb:playback_rate:${SHOW_A}`], '1.3');
expectRate('aria-valuetext names it', await valuetext(), '1.3×');
const tile = await js(`(() => { const b = ${SPEED_TILE}; return b ? { label: b.getAttribute('aria-label'), lit: b.classList.contains('text-bolt') } : null; })()`);
t.ok("the menu's SPEED tile names the slider speed, lit", !!tile?.label?.startsWith('Playback speed 1.3×,') && tile.lit, JSON.stringify(tile));
await tap(SPEED_TILE);
expectRate("the menu's SPEED tile goes on to the next stop above it: 1.3× → 1.5×", await rateNow(), 1.5);

await pressStop(8);
expectRate('a pointer press on the 1.8 stop → 1.8×', await rateNow(), 1.8);
expectRate('stored as the exact string "1.8"', (await stored())[`bmb:playback_rate:${SHOW_A}`], '1.8');

// A FAST speed: the thumb parks on the 1× stop, and the slider still says
// what is playing. The stop under the thumb must be reachable — a tap on it,
// or Home, changed no value and so did nothing.
await tap(FAST_35);
expectRate('the 3.5× tile', await rateNow(), 3.5);
expectRate('a fast speed parks the thumb on the 1× stop', await sliderValue(), '0');
expectRate('aria-valuetext names the true speed, 3.5×', await valuetext(), '3.5×');
await pressStop(0);
expectRate('a tap on the 1× stop under the thumb → 1× from 3.5×', await rateNow(), 1);
await tap(FAST_35);
await press('Home', 36);
expectRate('Home from 3.5× → 1×', await rateNow(), 1);

// A speed BETWEEN stops: SPEED's 1.25× puts the thumb on 1.2 (1.2 and 1.3
// are equally near). The keys step from the true speed, and the 1.2 stop
// under the thumb can be chosen.
await tap(SPEED_TILE);
expectRate("the menu's SPEED tile from 1× → 1.25×", await rateNow(), 1.25);
expectRate('1.25× puts the thumb on the 1.2 stop', await sliderValue(), '2');
expectRate('aria-valuetext names 1.25×', await valuetext(), '1.25×');
await press('ArrowLeft', 37);
expectRate('ArrowLeft from 1.25× → 1.2×, not 1.1×', await rateNow(), 1.2);
await tap(SPEED_TILE);
expectRate('SPEED from 1.2× → 1.25×', await rateNow(), 1.25);
await pressStop(2);
expectRate('a tap on the 1.2 stop under the thumb → 1.2×', await rateNow(), 1.2);
await tap(SPEED_TILE);
await right(1);
expectRate('ArrowRight from 1.25× → 1.3×', await rateNow(), 1.3);

await tap(FAST_35);
expectRate('the 3.5× tile again', await rateNow(), 3.5);
await right(1);
expectRate('one ArrowRight from 3.5× → 1.1×, a way back', await rateNow(), 1.1);

expectRate('show B, never touched, follows the global 1.1×', await playShow(SHOW_B), 1.1);
t.ok('phone: the ⋯ menu on show B', await openMenu());
await right(5);
expectRate('the slider moves show B to 1.6×', await rateNow(), 1.6);
s = await stored();
expectRate(`bmb:playback_rate:${SHOW_B}`, s[`bmb:playback_rate:${SHOW_B}`], '1.6');
expectRate('show A keeps the 1.1× its slider left', await playShow(SHOW_A), 1.1);

// A phone in LANDSCAPE, with the browser's bars: ~320px of viewport. The
// slider is the menu's last row and a `fixed` panel cannot be scrolled to by
// the page, so the panel is capped to the room it opens into and scrolls.
await send('Emulation.setDeviceMetricsOverride', { width: 740, height: 320, deviceScaleFactor: 3, mobile: true });
t.ok('landscape: the ⋯ menu opens', await openMenu());
const land = await js(`(() => { const s = ${SLIDER}; const menu = s.closest('[role="menu"]'); const m = menu.getBoundingClientRect();
  const out = { menu: [Math.round(m.top), Math.round(m.bottom)], screen: innerHeight,
    inScreen: m.top >= 0 && m.bottom <= innerHeight, content: menu.scrollHeight, box: menu.clientHeight };
  menu.scrollTop = menu.scrollHeight;
  const r = s.getBoundingClientRect();
  out.sliderShown = r.top >= m.top && r.bottom <= m.bottom && r.bottom <= innerHeight;
  menu.scrollTop = 0;
  return out; })()`);
t.ok('landscape: the menu ends inside the screen', land?.inScreen, JSON.stringify(land));
t.ok('landscape: scrolled to its end, the menu shows the whole slider', land?.sliderShown, JSON.stringify(land));
// The keyboard way there: ArrowUp from the first item wraps to the LAST, the
// slider. `useMenuKeys` focuses with preventScroll, so the panel's own focus
// handler is what brings it into view.
await js(`document.querySelector('[role="menu"] button')?.focus()`);
await key('ArrowUp', 38);
await wait(300);
const kb = await js(`(() => { const s = ${SLIDER}; const m = s.closest('[role="menu"]').getBoundingClientRect(); const r = s.getBoundingClientRect();
  return { focused: document.activeElement === s, shown: r.top >= m.top && r.bottom <= m.bottom && r.bottom <= innerHeight }; })()`);
t.ok('landscape: ArrowUp onto the slider scrolls it into view', kb?.focused && kb.shown, JSON.stringify(kb));
await send('Emulation.clearDeviceMetricsOverride');

// 9. A browser may REFUSE a speed (the spec lets it throw NotSupportedError).
// The refusal is simulated by a setter that throws for 3.5×, installed before
// any page script runs. <Player> must drop the stored speed that holds the
// refused one and play at what is left — and must NOT save 1× as the show's
// own choice, which `setPlaybackRate(1)` did: that entry outranks the global
// speed for ever. Last, because the stub stays for the rest of the page.
console.log('\n9. A refused speed: drops the key that holds it, saves no "1"');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  for (const prop of ['playbackRate', 'defaultPlaybackRate']) {
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, prop);
    Object.defineProperty(HTMLMediaElement.prototype, prop, { ...d, set(v) {
      if (v === 3.5) throw new DOMException('refused by e2e:speed', 'NotSupportedError');
      d.set.call(this, v);
    } });
  }
})()` });
await go(`${APP}/privacy`);
await js(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('bmb:playback_rate')) localStorage.removeItem(k);
  localStorage.setItem('bmb:playback_rate', '2'); localStorage.setItem('bmb:playback_rate:${SHOW_A}', '3.5'); return true; })()`);
expectRate('show A (own 3.5×, refused) plays at the global 2×', await playShow(SHOW_A), 2);
s = await stored();
t.ok('show A\'s refused entry is removed, not rewritten as 1', !(`bmb:playback_rate:${SHOW_A}` in s), JSON.stringify(s));
expectRate('the global 2× is kept', s['bmb:playback_rate'], '2');
await js(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('bmb:playback_rate')) localStorage.removeItem(k);
  localStorage.setItem('bmb:playback_rate', '3.5'); return true; })()`);
expectRate('show B (no entry, global 3.5× refused) plays at 1×', await playShow(SHOW_B), 1);
s = await stored();
// ANY show, not just B: on the reload the refusal lands first on the REVEALED
// item, so `setPlaybackRate(1)` wrote its '1' under show A, not under B.
t.ok('no show gets a "1" entry', Object.keys(s).every((k) => k === 'bmb:playback_rate'), JSON.stringify(s));
expectRate('the refused global key is removed', s['bmb:playback_rate'], undefined);

await finish();
