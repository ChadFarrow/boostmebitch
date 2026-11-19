#!/usr/bin/env node
/**
 * e2e: the /demu title's emu wears its holiday hat, and nothing else moves.
 *
 * Chad, 2026-11-19: "For the new DeMu logo we have on /DeMu can we dress it up
 * for holidays?" — feathers and a pilgrim hat in Thanksgiving week, a Santa hat
 * 1–26 Dec. Design: docs/superpowers/specs/2026-11-19-demu-holiday-hats-design.md.
 * Which day wears which hat is pinned by `check:demu`; this drives the page.
 *
 * What it drives, under phone emulation (390×844 and 320×640, `mobile: true`),
 * in New York time:
 * - `?holiday=none`: the plain emu, the same SVG as the search menu's DEMU glyph;
 * - `?holiday=thanksgiving` and `?holiday=christmas`: the costume replaces it
 *   after hydration — the right parts (feathers + pilgrim hat and no wattle;
 *   a Santa hat and no feathers), the same emu inside it, bolt yellow, one em
 *   square, its gaps masks and never the page colour painted — and the
 *   title's box and the word's x do NOT move;
 * - the calendar itself, under a faked browser date: 24 Nov 2026 wears the
 *   turkey with no parameter and with a junk one, 4 Jul 2026 is plain;
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
  await send('Page.navigate', { url: `${APP}${path}` });
  await wait(300);
  await until('document.readyState === "complete"', 20000);
  // Hydrated: React has attached itself to the title.
  await until(`(() => { const h = document.querySelector('${TITLE}'); return !!h && Object.keys(h).some((k) => k.startsWith('__react')); })()`, 20000);
  await wait(400);
}

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
    parts: { feathers: part('feathers'), pilgrim: part('pilgrim'), santa: part('santa'), wattle: part('wattle') },
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

const EXPECT = {
  thanksgiving: { feathers: true, pilgrim: true, santa: false, wattle: false },
  christmas: { feathers: false, pilgrim: false, santa: true, wattle: false },
};

for (const [w, h] of [[390, 844], [320, 640]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
  const at = `${w}px`;
  console.log(`\n  phone ${w}×${h}`);

  await go('/demu?holiday=none');
  const plain = await readTitle();
  t.equal(`${at} ?holiday=none: the plain emu`, plain.holiday, null);
  t.equal(`${at} ?holiday=none: the title reads DeMu`, plain.text, 'DeMu');
  if (w === 390) await shot('plain');

  for (const holiday of ['thanksgiving', 'christmas']) {
    await go(`/demu?holiday=${holiday}`);
    const seen = await until(`!!document.querySelector('${TITLE} svg[data-holiday="${holiday}"]')`, 5000);
    t.ok(`${at} ?holiday=${holiday}: the title wears it`, seen);
    if (!seen) continue;
    const c = await readTitle();
    t.equal(`${at} ${holiday}: its parts`, c.parts, EXPECT[holiday]);
    // The page behind the title is the hero image under bg-ink/75, not --ink: an outline
    // painted in --ink showed as a cream sticker edge on the light theme.
    t.ok(`${at} ${holiday}: its gaps are masks, not the page colour painted`, !c.painted && c.masks === (holiday === 'thanksgiving' ? 2 : 1),
      JSON.stringify({ painted: c.painted, masks: c.masks }));
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
const JUL_4 = Date.UTC(2026, 6, 4, 16, 0);
await fakeNow(NOV_24);
t.equal('faked clock: the page reads 24 Nov 2026', (await (async () => { await go('/demu'); return js('new Date().toDateString()'); })()), 'Tue Nov 24 2026');
t.ok('24 Nov 2026, no parameter: the turkey', await until(`!!document.querySelector('${TITLE} svg[data-holiday="thanksgiving"]')`, 5000));
await go('/demu?holiday=easter');
t.ok('24 Nov 2026, ?holiday=easter: the calendar still decides', await until(`!!document.querySelector('${TITLE} svg[data-holiday="thanksgiving"]')`, 5000));
await go('/demu?holiday=none');
t.equal('24 Nov 2026, ?holiday=none: the plain emu', (await readTitle()).holiday, null);
await fakeNow(JUL_4);
await go('/demu');
t.equal('4 Jul 2026, no parameter: the plain emu', (await readTitle()).holiday, null);
await fakeNow(null);

t.equal('no hydration warning on any load', hydration, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
