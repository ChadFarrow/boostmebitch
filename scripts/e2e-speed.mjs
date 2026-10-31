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
// and a show never touched follows the global speed.
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

await finish();
