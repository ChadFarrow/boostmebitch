// Drives the REAL seek bars with a real mouse (CDP `Input.dispatchMouseEvent`)
// and asserts that three things agree: the chapter TICK, the chapter the hover
// TIP names, and where a CLICK actually seeks.
//
// WHY THEY CAN DISAGREE. A range input keeps its thumb inside the box, so a
// value maps to `thumb/2 + (width - thumb) * fraction`, not to `fraction` of
// the width. The ticks were drawn at plain percentages, so near the start of
// the bar a tick sat up to half a thumb (6px) left of the point that seeks to
// it — on Bowl After Bowl 456, 4:38:34 on a ~460px bar, 3.2px was enough to
// land a click in the previous chapter. Step 3 replays the OLD placement and
// asserts exactly that, so this script is red against the placement it
// replaced.
//
// Mouse events, not dispatched DOM events: the tip reacts to `pointerType ===
// 'mouse'`, and the click has to go through the browser's own range-input
// hit-testing to prove anything about where it seeks.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:seekhover               # add --headed to watch it
//
// Needs the network (the episode's enclosure and chapters JSON, and Podcast
// Index through the app's routes). CHROME_PATH overrides the browser; the debug
// port is random and the tab muted, as in scripts/e2e-resume.mjs.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const CDP = 9400 + Math.floor(Math.random() * 500);
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headed = process.argv.includes('--headed');

/** Bowl After Bowl 456: over four hours, a chapters JSON with 12 chapters. */
const POD = '2d418249-453a-5714-8abc-5b657570b641';
const EPISODE_GUID = 'https://bowlafterbowl.com/episodes/episode-456/';

const appUp = await fetch(`${APP}/privacy`).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);
  process.exit(1);
}

const profile = `${tmpdir()}/bmb-e2e-seekhover`;
rmSync(profile, { recursive: true, force: true });
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  ...(headed ? [] : ['--headless=new']), '--no-first-run',
  ...(asRoot ? ['--no-sandbox'] : []),
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
if (!target) {
  chrome.kill();
  console.error(`Chrome did not come up on port ${CDP}. Set CHROME_PATH.`);
  process.exit(1);
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
const finish = async () => {
  await send('Target.closeTarget', { targetId: target.id }).catch(() => {});
  chrome.kill();
  console.log(fails ? `\n${fails} seek-hover check(s) FAILED.` : '\nAll seek-hover checks passed.');
  process.exit(fails ? 1 : 0);
};
const until = async (expr, ms = 20000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await js(expr)) return true;
    await wait(250);
  }
  return false;
};

const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
});
const click = async (x, y) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };

/** The seek bar in a scope: its box, the duration, and every tick with the
 *  fraction it was drawn for (read back off its own inline style). */
const bar = (scope) => js(`(() => {
  const input = document.querySelector(${JSON.stringify(scope)} + ' input[type="range"]');
  if (!input) return null;
  const r = input.getBoundingClientRect();
  const wrap = input.parentElement;
  const ticks = [...wrap.querySelectorAll('span.w-px')].map((s) => {
    const b = s.getBoundingClientRect();
    const m = /\\*\\s*([0-9.e-]+)\\)\\s*$/.exec(s.style.left);
    return { x: b.left + b.width / 2, f: m ? Number(m[1]) : NaN };
  });
  return { left: r.left, width: r.width, height: r.height, y: r.top + r.height / 2,
    wrapH: wrap.getBoundingClientRect().height, max: Number(input.max), ticks };
})()`);
/** The hover tip's text in a scope, or null when none is showing. */
const tip = (scope) => js(`(() => {
  const s = [...document.querySelectorAll(${JSON.stringify(scope)} + ' span.bottom-full')].find((e) => !e.hidden);
  return s ? s.textContent : null; })()`);
/** The same tick again after the bar moved. The time label beside the bar
 *  grows as the position does ("0:05" -> "56:43"), which shifts and narrows the
 *  bar, so any geometry read before a click is stale after it. */
const again = async (scope, f) => {
  const nb = await bar(scope);
  return { nb, t: nb.ticks.reduce((p, q) => (Math.abs(q.f - f) < Math.abs(p.f - f) ? q : p)) };
};
const titleOf = (text) => (text && text.includes(' · ') ? text.slice(text.indexOf(' · ') + 3) : null);
const value = (scope) => js(`Number(document.querySelector(${JSON.stringify(scope)} + ' input[type="range"]').value)`);

const MINI = '[aria-label="Open fullscreen player"]';
const THUMB = 12;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${APP}/?podcast=${POD}&episode=${encodeURIComponent(EPISODE_GUID)}` });
const playBtn = `[...document.querySelectorAll('button')].find(b => /^▶ (PLAY|RESUME)/.test(b.textContent.trim()))`;
if (!await until(`!!${playBtn}`)) { check('the episode page renders a PLAY button', false, 'no button'); await finish(); }
await js(`${playBtn}.click()`);
await until(`(() => { const i = document.querySelector('${MINI} input[type="range"]'); return i && Number(i.max) > 0; })()`);
await until(`document.querySelectorAll('${MINI} span.w-px').length > 3`);
// Pause, so the value read after a click is the click's and not the clock's.
await js(`(() => { const b = document.querySelector('button[aria-label="Pause"]'); b && b.click(); return true; })()`);
await wait(800);

console.log('1. The mini-bar seek bar has a mouse-sized box and the layout did not move');
const b = await bar(MINI);
check('the input is 14px tall for a mouse', b && Math.round(b.height) === 14, JSON.stringify(b && { height: b.height }));
check('its margin box is still 2px (the wrapper is 2px)', b && Math.round(b.wrapH) === 2, JSON.stringify(b && { wrapH: b.wrapH }));
const expectX = (f) => b.left + THUMB / 2 + (b.width - THUMB) * f;
const worst = Math.max(...b.ticks.map((t) => Math.abs(t.x - expectX(t.f))));
check(`every tick sits at thumb/2 + (width - thumb) * f (${b.ticks.length} ticks)`, b.ticks.length > 3 && worst < 1, `worst: ${worst.toFixed(2)}px`);

console.log('\n2. The tip names the chapter under the pointer, and a click seeks there');
// The last tick in the first half of the bar: far enough from the start that
// the previous chapter is a real one, and where the old placement was off.
const early = b.ticks.filter((t) => t.f < 0.5).sort((p, q) => p.f - q.f);
const tk = early[1] ?? early[0];
const start = tk.f * b.max;
await mouse('mouseMoved', tk.x + 2, b.y);
await wait(300);
const after = await tip(MINI);
await mouse('mouseMoved', tk.x - 3, b.y);
await wait(300);
const before = await tip(MINI);
check('a tip shows while the mouse is over the bar', !!after, 'no tip');
check('just right of a tick, it names a chapter', !!titleOf(after), `tip: ${after}`);
check('just left of it, it names a different one', !!titleOf(before) && titleOf(before) !== titleOf(after), `left: ${before} | right: ${after}`);
await click(tk.x + 2, b.y);
await wait(600);
let v = await value(MINI);
const perPx = b.max / (b.width - THUMB);
check('a click just right of the tick seeks into that chapter', v >= start && v < start + 4 * perPx,
  `value ${v.toFixed(1)}, chapter starts ${start.toFixed(1)} (${perPx.toFixed(1)} s/px)`);
let { nb, t: moved } = await again(MINI, tk.f);
await mouse('mouseMoved', moved.x + 2, nb.y);
await wait(300);
check('the tip at that spot names the chapter the click landed in', titleOf(await tip(MINI)) === titleOf(after), `tip: ${await tip(MINI)}`);

console.log('\n3. The OLD placement (plain percent) pointed at the wrong chapter');
// Move the thumb away first: step 2 left it within 6px of this spot, and a
// press ON the thumb grabs it without changing the value.
await click(nb.left + nb.width * 0.85, nb.y);
await wait(600);
// Where the tick used to be drawn, and a click one pixel inside it.
({ nb, t: moved } = await again(MINI, tk.f));
const oldX = nb.left + nb.width * tk.f;
check(`the old tick was ${(moved.x - oldX).toFixed(1)}px left of the new one`, moved.x - oldX > 1.5, `new ${moved.x.toFixed(1)}, old ${oldX.toFixed(1)}`);
await click(oldX + 1, nb.y);
await wait(600);
v = await value(MINI);
check('a click just right of the OLD tick lands BEFORE the chapter it marked', v < start, `value ${v.toFixed(1)}, chapter starts ${start.toFixed(1)}`);

console.log('\n4. The tip goes away when the mouse leaves');
await mouse('mouseMoved', 5, 5);
await wait(300);
check('no tip once the pointer is off the bar', (await tip(MINI)) === null, `tip: ${await tip(MINI)}`);

console.log('\n5. The fullscreen player has the same tip');
await js(`(() => { document.querySelector('${MINI}').click(); return true; })()`);
await wait(1500);
const FULL = '.z-50';
const fb = await bar(FULL);
check('the fullscreen seek bar is on screen', fb && fb.width > 100 && fb.y > 0, JSON.stringify(fb && { width: fb.width, y: fb.y }));
if (fb) {
  const ft = fb.ticks.filter((t) => t.f < 0.5).sort((p, q) => p.f - q.f)[1];
  await mouse('mouseMoved', ft.x + 2, fb.y);
  await wait(300);
  const ftip = await tip(FULL);
  check('hovering it names a chapter', !!titleOf(ftip), `tip: ${ftip}`);
  check('the same chapter the mini-bar named at the same fraction', titleOf(ftip) === titleOf(after), `full: ${ftip} | mini: ${after}`);
}

await finish();
