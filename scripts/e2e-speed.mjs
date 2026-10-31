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
// It also pins what the feature must NOT do: a music feed saves no show entry,
// and a show never touched follows the global speed. Section 7 plays three
// seeded downloads from /downloads, where only the download RECORD knows an
// album track is music, and a record with no feed guid or id must not share a
// '0' key. Section 8 makes the browser refuse 3.5×: the refused key goes, and
// no show is handed a '1' entry.
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

console.log('\n5. A music feed — the global speed, and no show entry');
expectRate('the music track plays at the global 1×', await playShow(MUSIC), 1);
t.ok('the chip moves the track to 2×', await chipTo(2), JSON.stringify(await stored()));
s = await stored();
expectRate('global bmb:playback_rate', s['bmb:playback_rate'], '2');
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
expectRate('the album track plays at the global 1.5×', await playDownload(DL_ALB.title), 1.5);
t.ok('the chip moves the album track to 2×', await chipTo(2), JSON.stringify(await stored()));
s = await stored();
t.ok('no entry for the album (its record says music)', !(`bmb:playback_rate:${DL_ALB.feed}` in s), JSON.stringify(s));
expectRate('global bmb:playback_rate', s['bmb:playback_rate'], '2');
expectRate('the podcast download plays at the global 2×', await playDownload(DL_POD.title), 2);
t.ok('the chip moves the podcast download to 1.25×', await chipTo(1.25), JSON.stringify(await stored()));
s = await stored();
expectRate(`bmb:playback_rate:${DL_POD.feed}`, s[`bmb:playback_rate:${DL_POD.feed}`], '1.25');
expectRate('the no-id download plays at the global 1.25×', await playDownload(DL_NOID.title), 1.25);
t.ok('the chip moves the no-id download to 1.5×', await chipTo(1.5), JSON.stringify(await stored()));
s = await stored();
t.ok('no shared "0" entry', !('bmb:playback_rate:0' in s), JSON.stringify(s));
t.ok('no entry under any other made-up key', Object.keys(s).every((k) => k === 'bmb:playback_rate'
  || k === `bmb:playback_rate:${DL_POD.feed}`), JSON.stringify(s));

// 8. A browser may REFUSE a speed (the spec lets it throw NotSupportedError).
// The refusal is simulated by a setter that throws for 3.5×, installed before
// any page script runs. <Player> must drop the stored speed that holds the
// refused one and play at what is left — and must NOT save 1× as the show's
// own choice, which `setPlaybackRate(1)` did: that entry outranks the global
// speed for ever. Last, because the stub stays for the rest of the page.
console.log('\n8. A refused speed: drops the key that holds it, saves no "1"');
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
