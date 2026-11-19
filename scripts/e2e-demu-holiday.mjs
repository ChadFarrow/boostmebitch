#!/usr/bin/env node
/**
 * e2e: the /demu title's emu wears its look, and nothing else moves.
 *
 * Chad, 2026-11-19: "For the new DeMu logo we have on /DeMu can we dress it up
 * for holidays?", then a look for every part of the year, each from the day
 * after the one before through its own day. Design:
 * docs/superpowers/specs/2026-11-19-demu-holiday-year-design.md (and the
 * drawing rules in 2026-11-19-demu-holiday-hats-design.md).
 * Which day wears which look is pinned by `check:demu`; this drives the page.
 *
 * What it drives, under phone emulation (390×844 and 320×640, `mobile: true`),
 * in New York time:
 * - `?holiday=none`: the plain emu, the same SVG as the search menu's DEMU glyph;
 * - `?holiday=<look>` for each of the eleven looks: the costume replaces it
 *   after hydration — a part behind the emu and a part over it exactly where
 *   the look has them, the same emu inside it, bolt yellow, one em square, its
 *   gaps masks and never the page colour painted, the emu's eye still open
 *   (under the sunglasses, the lens there instead) — and the title's box and
 *   the word's x do NOT move;
 * - the calendar itself, under a faked browser date: 24 Nov 2026 wears the
 *   turkey with no parameter and with a junk one, Black Friday 27 Nov 2026
 *   wears the Santa hat, 27 Dec 2026 the New Year's hat (the year wraps), and
 *   4 Jul 2026 the fireworks;
 * - no React hydration warning, and no horizontal overflow at either width;
 * - screenshots of each title in the dark and the light theme (SHOT_DIR).
 *
 * The browser resolves no host but this machine. The dev server asks Podcast
 * Index for the roster; the title does not wait for it.
 *
 *   BMB_APP=http://localhost:3000 node scripts/e2e-demu-holiday.mjs
 *   SHOT_DIR=/some/dir   also writes screenshots there
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
const SHOT_DIR = process.env.SHOT_DIR;
await requireApp(APP, `No app at ${APP}. Start one (npm run dev) or set BMB_APP.`);
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const t = checker();
const { page } = await launchChrome({
  name: 'demuholiday',
  args: ['--window-size=1280,900', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, js, jsOrThrow, until } = page;
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });

// Anything React says about hydration, from the first navigation on.
const hydration = [];
page.on((m) => {
  const text = m.method === 'Runtime.consoleAPICalled'
    ? (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    : m.method === 'Runtime.exceptionThrown' ? (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '') : '';
  // A production build prints only the minified number: #418/#423/#425 are React's hydration errors.
  if (/hydrat|did not match|server rendered|Minified React error #(418|423|425)\b/i.test(text)) hydration.push(text.slice(0, 300));
});

/** Start the page's clock at `ms`, before any of its scripts run; `null` removes it. */
let fakeId = null;
async function fakeNow(ms) {
  if (fakeId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: fakeId });
  fakeId = null;
  if (ms == null) return;
  const source = `(() => {
    const Real = Date, t0 = Real.now(), now = () => ${ms} + (Real.now() - t0);
    function FakeDate(...a) { if (!new.target) return new Real(now()).toString(); return a.length ? new Real(...a) : new Real(now()); }
    FakeDate.prototype = Real.prototype; FakeDate.now = now; FakeDate.UTC = Real.UTC; FakeDate.parse = Real.parse;
    globalThis.Date = FakeDate;
  })();`;
  fakeId = (await send('Page.addScriptToEvaluateOnNewDocument', { source })).result?.identifier ?? null;
}

const TITLE = '[data-demu-title]';
async function go(path) {
  // A mark on the page we leave, so nothing below can read IT as the new one.
  await js('window.__leaving = true');
  await send('Page.navigate', { url: `${APP}${path}` });
  await until('!window.__leaving && document.readyState === "complete"', 20000);
  // Hydrated: React has attached itself to the title.
  await until(`(() => { const h = document.querySelector('${TITLE}'); return !!h && Object.keys(h).some((k) => k.startsWith('__react')); })()`, 20000);
  // The hero image is the page behind the eye (see eyePixel).
  await until(`(() => { const i = document.querySelector('img[src*="hero"]'); return !i || i.complete; })()`, 10000);
  await wait(400);
}

/**
 * The colour on screen at the centre of the emu's eye, which the emu leaves
 * OPEN: a costume must show the page there too, exactly as the plain emu does.
 * The feathers lie behind the eye, and a mask filled by the nonzero rule
 * leaves the eye's own subpath unfilled, so a speck of feather showed in it.
 */
async function eyePixel() {
  const p = await jsOrThrow(`(() => { const r = document.querySelector('${TITLE} svg').getBoundingClientRect();
    return { x: r.left + r.width * 14.6 / 24, y: r.top + r.height * 8.9 / 24 }; })()`);
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: p.x - 0.5, y: p.y - 0.5, width: 1, height: 1, scale: 1 } });
  return jsOrThrow(`(async () => { const i = new Image(); i.src = 'data:image/png;base64,${r.result?.data ?? ''}'; await i.decode();
    const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0);
    const d = x.getImageData(i.width >> 1, i.height >> 1, 1, 1).data; return [d[0], d[1], d[2]]; })()`);
}
const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) <= 16);

/** The title, as measured: its box, the word's left edge, and the glyph. */
const readTitle = () => jsOrThrow(`(() => {
  const h = document.querySelector('${TITLE}'); const g = h.querySelector('svg');
  const word = [...h.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  const range = document.createRange(); range.selectNodeContents(word);
  const hr = h.getBoundingClientRect(), gr = g.getBoundingClientRect(), wr = range.getBoundingClientRect();
  const probe = document.createElement('span'); probe.className = 'text-bolt'; document.body.appendChild(probe);
  const bolt = getComputedStyle(probe).color; probe.remove();
  const part = (p) => !!g.querySelector('[data-part="' + p + '"]');
  return {
    holiday: g.getAttribute('data-holiday'),
    svg: g.innerHTML,
    emu: g.querySelector('[data-part="emu"]')?.innerHTML ?? null,
    parts: { back: part('back'), front: part('front') },
    painted: !!g.querySelector('[class*="fill-ink"], [class*="stroke-ink"]'),
    masks: g.querySelectorAll('mask').length,
    box: [hr.top, hr.height, hr.left, hr.width].map((v) => Math.round(v * 2) / 2),
    wordX: Math.round(wr.left * 2) / 2,
    gw: gr.width, gh: gr.height, fs: parseFloat(getComputedStyle(h).fontSize),
    colour: getComputedStyle(g).color, bolt,
    text: h.textContent.trim(),
  };
})()`);
const noOverflow = () => js('document.documentElement.scrollWidth <= document.documentElement.clientWidth');

async function shot(name) {
  if (!SHOT_DIR) return;
  for (const theme of ['dark', 'light']) {
    await js(`document.documentElement.dataset.theme = '${theme}'`);
    await wait(150);
    const clip = await jsOrThrow(`(() => { const r = document.querySelector('${TITLE}').getBoundingClientRect();
      return { x: 0, y: Math.max(0, r.top - 24), width: Math.min(innerWidth, 260), height: r.height + 48 }; })()`);
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    if (r.result?.data) writeFileSync(join(SHOT_DIR, `${name}-${theme}.png`), Buffer.from(r.result.data, 'base64'));
  }
  await js(`document.documentElement.dataset.theme = 'dark'`);
}

// Each look, in year order, with the parts Chad picked: `back` draws behind the
// emu (masked off it), `front` over it. The names are lib/demu-holiday.ts's
// DEMU_HOLIDAYS; plain Node cannot import a .ts file, so they are listed here.
const LOOKS = {
  newyear: { back: true, front: true }, // confetti; a party hat
  valentines: { back: true, front: true }, // floating hearts; a heart over the ear cup
  stpatricks: { back: false, front: true }, // a leprechaun hat
  easter: { back: false, front: true }, // bunny ears
  pizzaday: { back: false, front: true }, // a pizza-slice hat
  july4: { back: true, front: false }, // fireworks
  summer: { back: false, front: true, eye: 'lens' }, // sunglasses, over the eye on purpose
  podcastday: { back: false, front: true }, // a studio microphone
  halloween: { back: false, front: true }, // a witch hat
  thanksgiving: { back: true, front: true }, // feathers; a pilgrim hat
  christmas: { back: false, front: true }, // a Santa hat
};
const LENS = [0x1f, 0x1d, 0x1c];

for (const [w, h] of [[390, 844], [320, 640]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
  const at = `${w}px`;
  console.log(`\n  phone ${w}×${h}`);

  await go('/demu?holiday=none');
  const plain = await readTitle();
  const plainEye = await eyePixel();
  t.equal(`${at} ?holiday=none: the plain emu`, plain.holiday, null);
  t.equal(`${at} ?holiday=none: the title reads DeMu`, plain.text, 'DeMu');
  if (w === 390) await shot('plain');

  for (const [holiday, want] of Object.entries(LOOKS)) {
    await go(`/demu?holiday=${holiday}`);
    const seen = await until(`!!document.querySelector('${TITLE} svg[data-holiday="${holiday}"]')`, 5000);
    t.ok(`${at} ?holiday=${holiday}: the title wears it`, seen);
    if (!seen) continue;
    const c = await readTitle();
    t.equal(`${at} ${holiday}: its parts`, c.parts, { back: want.back, front: want.front });
    // The page behind the title is the hero image under bg-ink/75, not --ink: an outline
    // painted in --ink showed as a cream sticker edge on the light theme.
    t.ok(`${at} ${holiday}: its gaps are masks, not the page colour painted`, !c.painted && c.masks === (want.back ? 2 : 1),
      JSON.stringify({ painted: c.painted, masks: c.masks }));
    if (want.eye === 'lens') {
      // On the dark theme the lens is 17 levels from the page behind the eye, too
      // close to tell apart; on the light theme the page there is bright.
      await js(`document.documentElement.dataset.theme = 'light'`);
      await wait(150);
      const eye = await eyePixel();
      await js(`document.documentElement.dataset.theme = 'dark'`);
      t.ok(`${at} ${holiday}: the lens covers the eye`, near(eye, LENS), JSON.stringify({ eye, LENS }));
    } else {
      const eye = await eyePixel();
      t.ok(`${at} ${holiday}: the eye stays open, the page showing in it`, near(eye, plainEye), JSON.stringify({ eye, plainEye }));
    }
    t.ok(`${at} ${holiday}: the same emu inside it`, c.emu && plain.svg && c.emu === plain.svg, c.emu?.slice(0, 80));
    t.ok(`${at} ${holiday}: bolt yellow, one em square`, c.colour === c.bolt && Math.abs(c.gh - c.fs) < 1.5 && Math.abs(c.gw - c.fs) < 1.5,
      JSON.stringify({ colour: c.colour, bolt: c.bolt, gw: c.gw, gh: c.gh, fs: c.fs }));
    t.equal(`${at} ${holiday}: the title's box does not move`, c.box, plain.box);
    t.equal(`${at} ${holiday}: the word does not move`, c.wordX, plain.wordX);
    t.equal(`${at} ${holiday}: the title reads DeMu`, c.text, 'DeMu');
    t.ok(`${at} ${holiday}: no horizontal overflow`, await noOverflow());
    if (w === 390) await shot(holiday);
  }
}

// The calendar, with no parameter: the page's own clock decides.
console.log('\n  the calendar, under a faked browser date (390px)');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
const NOV_24 = Date.UTC(2026, 10, 24, 17, 0); // 12:00 in New York
const BLACK_FRIDAY = Date.UTC(2026, 10, 27, 17, 0); // 12:00 in New York
const DEC_27 = Date.UTC(2026, 11, 27, 17, 0); // 12:00 in New York
const JUL_4 = Date.UTC(2026, 6, 4, 16, 0);
await fakeNow(NOV_24);
t.equal('faked clock: the page reads 24 Nov 2026', (await (async () => { await go('/demu'); return js('new Date().toDateString()'); })()), 'Tue Nov 24 2026');
t.ok('24 Nov 2026, no parameter: the turkey', await until(`!!document.querySelector('${TITLE} svg[data-holiday="thanksgiving"]')`, 5000));
await go('/demu?holiday=birthday');
t.ok('24 Nov 2026, ?holiday=birthday: the calendar still decides', await until(`!!document.querySelector('${TITLE} svg[data-holiday="thanksgiving"]')`, 5000));
await go('/demu?holiday=none');
t.equal('24 Nov 2026, ?holiday=none: the plain emu', (await readTitle()).holiday, null);
// The day after Thanksgiving hands over to Santa (Chad: "once that holiday hits, it
// switches over to the next holiday").
await fakeNow(BLACK_FRIDAY);
await go('/demu');
t.equal('faked clock: the page reads 27 Nov 2026', await js('new Date().toDateString()'), 'Fri Nov 27 2026');
t.ok('Black Friday 2026, no parameter: the Santa hat', await until(`!!document.querySelector('${TITLE} svg[data-holiday="christmas"]')`, 5000));
// After Christmas the year wraps to New Year's, not to a bare emu.
await fakeNow(DEC_27);
await go('/demu');
t.equal('faked clock: the page reads 27 Dec 2026', await js('new Date().toDateString()'), 'Sun Dec 27 2026');
t.ok('27 Dec 2026, no parameter: the New Year\'s hat', await until(`!!document.querySelector('${TITLE} svg[data-holiday="newyear"]')`, 5000));
await fakeNow(JUL_4);
await go('/demu');
t.equal('faked clock: the page reads 4 Jul 2026', await js('new Date().toDateString()'), 'Sat Jul 04 2026');
t.ok('4 Jul 2026, no parameter: the fireworks', await until(`!!document.querySelector('${TITLE} svg[data-holiday="july4"]')`, 5000));
await fakeNow(null);

t.equal('no hydration warning on any load', hydration, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
