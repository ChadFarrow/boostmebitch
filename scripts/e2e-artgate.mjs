// Drives the REAL <Player> in a real browser and asserts what the art gate does
// when a media element says it is in trouble.
//
// WHY THIS IS AN E2E AND NOT A `check:*`. `playableAhead` and `artGateOpen` are
// pinned by `npm run check:art`, and both were correct while the bug this
// script was written against was live: the fault was entirely in the WIRING —
// which event calls which of them, and whether it measures the buffer or simply
// asserts starvation. `<Player>` used to answer `waiting` and `stalled` with a
// flat `setArtOk(false)`. A pure-function pin cannot see that, and neither can
// a DOM assertion on a still screen, because the gate reopens on the next
// headroom sample — inside a second — so the whole event is a FLICKER and an
// endpoint read shows nothing. This script records every distinct hero `src` at
// 100 ms and asserts on the SEQUENCE.
//
// THE FAULT IT WAS WRITTEN AGAINST. Reported as "the chapter art is flickering
// between the chapter art and the show art" on Bowl After Bowl, iPhone only,
// with the sound never breaking. `stalled` is a claim about the FETCH, not
// about the buffer — the spec fires it when no media data has arrived for three
// seconds, whatever the element holds — and AVFoundation pulls a huge chunk and
// then goes quiet. Measured in Safari on 2026-09-09 against this episode:
// `stalled` twice inside eleven seconds, `readyState` 4, 2,001 seconds of audio
// buffered ahead of the play head. Chromium does not fire it here at all, which
// is why the same session on a Mac never reproduced it.
//
// THE EVENTS ARE DISPATCHED BY HAND, and they have to be: no browser exposes a
// way to make a healthy element raise `stalled`, and the one engine that does
// it by itself cannot be driven from here. What is faked is only the EVENT.
// Everything downstream is the shipping code — the real handlers, the real
// `playableAhead` over the element's real `buffered`, and the real `<img src>`
// read back off the DOM.
//
// BOTH HALVES ARE THE TEST. Scenario 1 is the bug; scenario 2 is the reason the
// events are wired to the gate at all, and it must not be lost to fix the
// first. Chapter art on a music feed is routinely tens of megabytes on the
// audio's own host, and yielding it is worth +13.1 s of playback in the next
// 20 s (docs/ui.md, "Artwork must never outrank the audio").
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:artgate                 # add --headed to watch it
//
// It needs the network: the episode's own enclosure, its chapters JSON, and
// Podcast Index through the app's routes. If Bowl After Bowl 456 ever leaves
// the feed, replace the three constants below with any episode that publishes a
// chapters JSON with per-chapter images and an episode cover of its own — the
// assertions are about which of those two is on screen, not about this show.
//
// CHROME_PATH overrides the browser; without it this looks for Chrome where
// macOS puts it, the same convention as scripts/e2e-keyboard.mjs.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const CDP = 9255;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headed = process.argv.includes('--headed');

/** Bowl After Bowl 456: 12 chapters, every one with its own `img`, and an
 *  episode cover that is not any of them — so "chapter art" and "the show's
 *  art" are two URLs this script can tell apart by name. */
const POD = '2d418249-453a-5714-8abc-5b657570b641';
const EPISODE_GUID = 'https://bowlafterbowl.com/episodes/episode-456/';
/** Inside "Behind the Curtain" (starts 9521.629), well clear of its edges. */
const INSIDE_CHAPTER = 9525;
/** Far enough ahead that nothing is buffered there in the same tick. */
const UNBUFFERED = 15500;
const CHAPTER_ART = /behind-the-curtain/;
const EPISODE_ART = /episode-456/;

const appUp = await fetch(`${APP}/privacy`).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);
  process.exit(1);
}

const profile = `${tmpdir()}/bmb-e2e-artgate`;
rmSync(profile, { recursive: true, force: true });
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  ...(headed ? [] : ['--headless=new']), '--no-first-run',
  ...(asRoot ? ['--no-sandbox'] : []),
  // The player never gets a click on its own play button here, and a parked
  // element buffers nothing — so there would be no buffer to measure.
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--window-size=1200,900', 'about:blank',
], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await wait(250);
  try {
    const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    target = l.find((t) => t.type === 'page');
  } catch { /* chrome is still coming up */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id;
  pending.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const js = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         ${detail}`}`);
  if (!ok) fails++;
};

// The fullscreen cover: a big square that is not the page's fixed background
// layer. Selected by shape rather than by a test id, so this asserts against
// what a person can see rather than against a hook put there for it.
const HERO = `[...document.images].filter(i => { const b = i.getBoundingClientRect();
  return b.width > 200 && Math.abs(b.width - b.height) < 40 && !/hero\\.jpg/.test(i.currentSrc); })[0]`;
const hero = () => js(`(() => { const im = ${HERO};
  return im ? decodeURIComponent(im.currentSrc).replace(/^.*url=/, '').replace(/&w=\\d+$/, '') : 'none'; })()`);
const bufferState = () => js(`(() => { const a = document.querySelector('audio'); const b = a.buffered; const r = [];
  for (let i = 0; i < b.length; i++) r.push([Math.round(b.start(i)), Math.round(b.end(i))]);
  return JSON.stringify({ pos: Math.round(a.currentTime), ready: a.readyState, ranges: r }); })()`);
/** Start recording distinct hero srcs. The gate reopens within a second, so
 *  the transition is the only place the fault is visible. */
const watch = () => js(`(() => { window.__seq = []; clearInterval(window.__w);
  window.__w = setInterval(() => { const im = ${HERO}; if (!im) return;
    const u = decodeURIComponent(im.currentSrc).replace(/^.*url=/, '').replace(/&w=\\d+$/, '').split('/').pop();
    if (window.__seq[window.__seq.length - 1] !== u) window.__seq.push(u); }, 100);
  return true; })()`);
const seen = () => js(`(() => { clearInterval(window.__w); return window.__seq.join(' -> '); })()`);
const fire = (event) => js(`document.querySelector('audio').dispatchEvent(new Event(${JSON.stringify(event)})); true`);

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${APP}/?podcast=${POD}&episode=${encodeURIComponent(EPISODE_GUID)}` });
await wait(9000);
await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^\\s*(▶|PLAY)/i.test(x.textContent)); b && b.click(); return !!b; })()`);
await wait(5000);
await js(`(() => { const bar = document.querySelector('[aria-label="Open fullscreen player"]'); bar && bar.click(); return !!bar; })()`);
await wait(1500);
await js(`(() => { document.querySelector('audio').currentTime = ${INSIDE_CHAPTER}; return true; })()`);
// Long enough for the seek to settle, the chapter art to paint and the buffer
// to build past the gate's 20 s reopen threshold.
await wait(12000);

console.log(`buffer: ${await bufferState()}`);
const before = await hero();
check('the fullscreen hero starts on the chapter art', CHAPTER_ART.test(before), before);

console.log('\n1. `stalled` on a healthy element — a claim about the fetch, not the buffer');
await watch();
await fire('stalled');
await wait(2500);
const afterStalled = await seen();
check('the hero never leaves the chapter art', !EPISODE_ART.test(afterStalled), `saw: ${afterStalled}`);

console.log('\n2. `waiting` with the play head in a gap — the yield that protects playback');
await watch();
// Same tick as the seek, so `buffered` cannot have caught up: there is
// genuinely no range covering the play head, which is what a wedged element
// looks like from here.
await js(`(() => { const a = document.querySelector('audio'); a.currentTime = ${UNBUFFERED};
  a.dispatchEvent(new Event('waiting')); return true; })()`);
await wait(2500);
const afterWaiting = await seen();
check('the hero yields to the episode cover', EPISODE_ART.test(afterWaiting), `saw: ${afterWaiting}`);

chrome.kill();
console.log(fails ? `\n${fails} art-gate check(s) FAILED.` : '\nAll art-gate checks passed.');
process.exit(fails ? 1 : 0);
