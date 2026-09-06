// Drives the REAL <TabBar> in a real browser and asserts where the dock ends up
// while the on-screen keyboard is open, and — the half that matters — where it
// ends up after the keyboard closes.
//
// WHY THIS IS AN E2E AND NOT A `check:*`. The arithmetic in
// `lib/keyboard-inset.ts` is two additions, and every way it goes wrong is a
// wiring fault between three things a pure function cannot see: a
// `visualViewport` event, what `document.activeElement` says at the moment that
// event fires, and the `translateY` the shipping component actually resolves. The first version of
// the module measured inline from the event handler and passed review; driven
// here it held the dock 300px off the bottom of the screen FOREVER after a
// blur, because during `focusout` the field being left is still
// `document.activeElement`. That is scenario 5, and it is the reason the
// measurement is deferred a frame.
//
// THE VISUAL VIEWPORT IS FAKED, and it has to be: no browser exposes a way to
// raise a keyboard, and headless Chromium has none to raise. What is faked is
// only the SOURCE — a `visualViewport` whose height this script sets, installed
// before the app's own JS runs. Everything downstream of it is the shipping
// code: the real module, mounted by the real <TabBar>, painting a real
// transform that is read back off `getBoundingClientRect()`.
//
// The page is /privacy, which is static, needs no Podcast Index key and no
// signer, and still mounts <TabBar> — it is on every route. The textarea is
// appended by the script rather than reached in the feed for the same reason:
// what is under test is the dock, not the composer.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:keyboard                # add --headed to watch it
//
// CHROME_PATH overrides the browser; without it this looks for Chrome where
// macOS puts it, the same convention as e2e-favorites.mjs.

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CDP = 9231;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const HEADED = process.argv.includes('--headed');

// The layout viewport, which the keyboard does NOT change — that is the whole
// premise of the module under test. KB is what the keyboard covers of it.
const LAYOUT_H = 800;
const WIDTH = 390;
const KB = 300;
// What iOS's own bottom toolbar covers when it re-expands, and the shortest
// keyboard that has to keep working. Everything between them is the judgement
// the module makes; see MIN_KEYBOARD_PX in lib/keyboard-inset.ts.
const CHROME_H = 51;
const SHORT_KB = 162;
// What the phone in the report was left holding in `visualViewport.offsetTop`
// after a reply, rounded off the screenshot: 68.3 CSS px on an 874px screen.
const STRANDED = 68;

const appUp = await fetch(`${APP}/privacy`).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);
  process.exit(1);
}

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = `${tmpdir()}/bmb-e2e-keyboard`;
rmSync(profile, { recursive: true, force: true });
// See e2e-favorites.mjs: Chrome refuses to start as root without --no-sandbox,
// and a container is exactly where this runs as root. Gated on actually being
// root so a developer's own machine keeps the sandbox.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const chrome = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  ...(asRoot ? ['--no-sandbox'] : []),
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  'about:blank',
], { stdio: 'ignore' });
const stopChrome = () => chrome.kill();
process.on('exit', stopChrome);

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 250));
  ready = await fetch(`http://127.0.0.1:${CDP}/json/version`).then((r) => r.ok).catch(() => false);
}
if (!ready) { console.error(`Chrome never opened its debug port on ${CDP}.`); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: LAYOUT_H, deviceScaleFactor: 3, mobile: true });
// NOT optional, and it is not about looks: a headless page is not the focused
// page, and Chromium dispatches no focus/blur events to one. Without this
// `focusout` never fires, scenario 5 tests nothing, and the defect it exists to
// catch — a blur that leaves the dock parked off the bottom of the screen —
// passes green.
await send('Emulation.setFocusEmulationEnabled', { enabled: true });

// The fake source, installed before any app script. `window.scrollTo` is
// counted rather than stubbed — scenario 6 asserts the settle nudge actually
// ran, and a stub would assert against itself.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const L = { resize: [], scroll: [] };
    const fake = {
      height: ${LAYOUT_H}, offsetTop: 0, offsetLeft: 0, width: ${WIDTH}, scale: 1,
      addEventListener: (t, f) => L[t] && L[t].push(f),
      removeEventListener: (t, f) => { const a = L[t]; if (!a) return; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    };
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    window.__vv = (h, top = 0, scale = 1) => {
      fake.height = h; fake.offsetTop = top; fake.scale = scale;
      L.resize.forEach((f) => f());
    };
    window.__scrolls = 0;
    const real = window.scrollTo.bind(window);
    window.scrollTo = (...a) => { window.__scrolls++; return real(...a); };
  })();
`});

await send('Page.navigate', { url: `${APP}/privacy` });
await wait(2500);

// Every read waits a frame first: the module coalesces its measurement into one
// rAF on purpose, so an immediate read is reading the state BEFORE the event.
const read = async () => {
  await wait(80);
  return JSON.parse(await js(`(() => {
    const n = document.querySelector('nav[aria-label="Main"]');
    if (!n) return JSON.stringify({ missing: true });
    const r = n.getBoundingClientRect();
    return JSON.stringify({
      kb: getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim(),
      navBottom: Math.round(r.bottom),
      scrolls: window.__scrolls,
    });
  })()`));
};

let fails = 0;
const check = (l, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${l}`);
  if (!ok) { fails++; console.log('        expected', JSON.stringify(b), '\n        actual  ', JSON.stringify(a)); }
};

console.log(`\n1. at rest — the dock sits on the bottom of the viewport`);
let s = await read();
check('the variable is 0px', s.kb, '0px');
check('the tab bar ends at the viewport bottom', s.navBottom, LAYOUT_H);
const restBottom = s.navBottom;

console.log(`\n2. the visual viewport shrinks with NOTHING focused — a rubber-band bounce,`);
console.log(`   not a keyboard, and the dock must not move`);
await js(`window.__vv(${LAYOUT_H - KB})`);
s = await read();
check('the variable stays 0px', s.kb, '0px');
check('the tab bar has not moved', s.navBottom, restBottom);

console.log(`\n3. the same shrink with a TEXTAREA focused — the dock hides behind the keyboard`);
await js(`(() => { const t = document.createElement('textarea'); t.id = 'c'; document.body.appendChild(t); t.focus(); })()`);
await js(`window.__vv(${LAYOUT_H - KB})`);
s = await read();
check('the variable is the covered height', s.kb, `${KB}px`);
check('the tab bar is pushed down by exactly that', s.navBottom, restBottom + KB);

console.log(`\n4. a focused BUTTON raises no keyboard, whatever the viewport says`);
await js(`(() => { const b = document.createElement('button'); b.id = 'b'; document.body.appendChild(b); b.focus(); })()`);
await js(`window.__vv(${LAYOUT_H - KB})`);
s = await read();
check('the variable is 0px', s.kb, '0px');
check('the tab bar is back on the bottom', s.navBottom, restBottom);

console.log(`\n5. the keyboard closes the ordinary way — blur, then the viewport reports`);
console.log(`   its height back`);
await js(`document.getElementById('c').focus()`);
await js(`window.__vv(${LAYOUT_H - KB})`);
check('(precondition) the dock is parked', (await read()).kb, `${KB}px`);
await js(`document.getElementById('c').blur()`);
await js(`window.__vv(${LAYOUT_H})`);
s = await read();
check('the variable is 0px again', s.kb, '0px');
check('the tab bar is back on the bottom', s.navBottom, restBottom);
let scrollsBefore = s.scrolls;

console.log(`\n5b. ...and it also comes back on the FOCUSOUT ALONE, with no viewport event.`);
console.log(`    This is the stuck-offset case, and the one that failed: during focusout`);
console.log(`    the field being left is still document.activeElement.`);
// The focusout is dispatched by hand because headless Chromium dispatches no
// focus events to a page that is not the focused page — verified, and with
// Emulation.setFocusEmulationEnabled on as well. The listener under test is a
// plain document-level one, so a synthetic event reaches it exactly as the real
// one does; what is being asserted is what the handler READS, which is real.
await js(`document.getElementById('c').focus()`);
await js(`window.__vv(${LAYOUT_H - KB})`);
check('(precondition) the dock is parked again', (await read()).kb, `${KB}px`);
// The ORDER is the defect: the browser fires focusout while the field is still
// document.activeElement and moves focus after, so dispatching it before the
// blur is what reproduces what an inline measurement reads. Reversed, this
// scenario passes against the broken version too.
await js(`(() => {
  const t = document.getElementById('c');
  t.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  t.blur();
})()`);
s = await read();
check('the variable is 0px', s.kb, '0px');
check('the tab bar is back on the bottom', s.navBottom, restBottom);
scrollsBefore = s.scrolls;

console.log(`\n6. ...and the fixed layer is settled after the dismissal animation`);
await wait(600);
s = await read();
check('scrollTo ran the nudge (twice: away and back)', s.scrolls - scrollsBefore, 2);
check('and the dock did not move doing it', s.navBottom, restBottom);

console.log(`\n7. a bounce at the TOP of the document (negative offsetTop) reads as no keyboard`);
await js(`window.__vv(${LAYOUT_H}, -90)`);
s = await read();
check('the variable is 0px', s.kb, '0px');
check('the tab bar has not moved', s.navBottom, restBottom);

console.log(`\n8. the keyboard closes but the field KEEPS FOCUS, and the browser's own`);
console.log(`   bottom chrome takes its height back — not a keyboard, and the dock`);
console.log(`   must not move`);
// iOS's bottom toolbar collapses on a downward scroll and re-expands on an
// upward one, and it shrinks the VISUAL viewport by its own height while the
// layout viewport is unchanged: the same shape as a keyboard, an order of
// magnitude smaller. The focus test cannot answer it, because the field really
// is still focused — iOS leaves it focused when the keyboard is dismissed by a
// scroll — so this reads as a ~50px keyboard that follows the scroll DIRECTION.
// Reported off a phone as "returns to the bottom when I scroll down but moves
// back up when I scroll up".
await js(`document.getElementById('c').focus()`);
await js(`window.__vv(${LAYOUT_H - CHROME_H})`);
s = await read();
check('the variable is 0px', s.kb, '0px');
check('the tab bar has not moved', s.navBottom, restBottom);

console.log(`\n9. ...and the bounce of scenario 7 with the field still focused`);
// Scenario 7 passes on the focus test alone, so it says nothing about the case
// the phone actually hits: the bounce happens while the composer is focused. A
// negative offsetTop means the visual viewport has travelled ABOVE the layout
// viewport, which is displacement and not coverage.
await js(`window.__vv(${LAYOUT_H}, -90)`);
s = await read();
check('the variable is 0px', s.kb, '0px');
check('the tab bar has not moved', s.navBottom, restBottom);

console.log(`\n10. ...and a SHORT keyboard is still a keyboard`);
// The must-still-work half of 8, and the reason the floor is a floor rather
// than a bigger number: an iPhone's landscape keyboard is about a fifth of the
// screen, far below the portrait one this file otherwise fakes. Raising the
// floor past this brings back the bug #342 exists for, on landscape only.
await js(`window.__vv(${LAYOUT_H - SHORT_KB})`);
s = await read();
check('the variable is the covered height', s.kb, `${SHORT_KB}px`);
check('the tab bar is pushed down by exactly that', s.navBottom, restBottom + SHORT_KB);
await js(`(() => { const t = document.getElementById('c'); t.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); t.blur(); })()`);
await js(`window.__vv(${LAYOUT_H})`);

console.log(`\n11. THE STRANDED VIEWPORT — nothing covers the screen, nothing has focus,`);
console.log(`    and iOS has left the visual viewport scrolled ${STRANDED}px past the`);
console.log(`    layout one. This is the report, and it is the case both earlier`);
console.log(`    versions netted off to a NEGATIVE number and published as 0px.`);
// `bottom: 0` is measured from the layout viewport, so the dock is sitting
// exactly this far above the bottom of the screen with the feed showing under
// it. Measured off the phone: an 874px screen, a 90px bar at full height,
// 68.3px of feed below it. Nothing else in this file reaches this state — the
// bounce scenarios are the same shape with the sign the other way.
await js(`window.__vv(${LAYOUT_H}, ${STRANDED})`);
s = await read();
check('the variable is the leftover', s.kb, `${STRANDED}px`);
check('the tab bar is pushed back down by exactly that', s.navBottom, restBottom + STRANDED);
scrollsBefore = s.scrolls;

console.log(`\n11b. ...and the nudge runs for it too, because the transform only HIDES`);
console.log(`     the leftover — a scroll and back is what settles it at the source`);
await wait(600);
s = await read();
check('scrollTo ran the nudge (twice: away and back)', s.scrolls - scrollsBefore, 2);
await js(`window.__vv(${LAYOUT_H})`);
check('and it relaxes when the viewport comes back', (await read()).navBottom, restBottom);

console.log(`\n12. a keyboard on top of a scrolled viewport — the two terms ADD.`);
console.log(`    Netting them off is what under-corrected the keyboard case by the`);
console.log(`    same number it stranded the dock by afterwards.`);
await js(`document.getElementById('c').focus()`);
await js(`window.__vv(${LAYOUT_H - KB}, ${STRANDED})`);
s = await read();
check('the variable is the keyboard PLUS the lift', s.kb, `${KB + STRANDED}px`);
check('the tab bar is pushed down by exactly that', s.navBottom, restBottom + KB + STRANDED);

console.log(`\n13. a pinch-zoomed page is left alone — above scale 1 offsetTop is a pan`);
console.log(`    offset against a screen no longer painting layout pixels 1:1`);
await js(`window.__vv(${LAYOUT_H - KB}, ${STRANDED}, 2)`);
s = await read();
check('the variable is 0px', s.kb, '0px');
check('the tab bar has not moved', s.navBottom, restBottom);
await js(`(() => { const t = document.getElementById('c'); t.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); t.blur(); })()`);
await js(`window.__vv(${LAYOUT_H})`);

ws.close();
stopChrome();
console.log(fails ? `\n${fails} FAILED` : '\nall keyboard-inset checks passed');
process.exit(fails ? 1 : 0);
