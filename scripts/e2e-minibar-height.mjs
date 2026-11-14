// The mini-bar must keep ONE height across a track change.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:minibar                           # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:minibar -- --headed --keep
//
// THE FAULT IT WAS WRITTEN AGAINST (2026-11-14): "on BMB i notice that the now
// playing bar at the bottom moves up and down when songs change". The bar is
// `fixed` at `bottom: var(--dock-b)`, so its height grows UPWARD — any line that
// comes and goes moves its top edge. From `sm:` up, the buffering readout was a
// line of its own (`hidden sm:block`), and a new source starts with nothing
// buffered, so `waiting` set `stalled` on every ⏭: the bar stood 78px, then
// 98.5px for as long as the next file took to arrive, then 78px again. Measured
// at 1280px in Chromium with the audio held 700 ms. Below `sm:` the readout was
// already folded into the one secondary line (#357), which is why the phone bar
// stood still and the desktop one did not.
//
// WHAT IT PINS, at 390 / 640 / 1280: from ⏭ until the next track plays, every
// animation frame measures the bar at ONE height and ONE top edge. And the
// must-still-work half: the readout is still SAID — some frame in that window
// shows a visible "buffering" line inside the bar, at every width. Deleting the
// readout would pass the first half alone.
//
// Everything the player asks for is answered here, as in e2e:coverhold: the
// album, the pictures, and a silent WAV held 700 ms so `waiting` fires on every
// change. Nothing reaches Podcast Index.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const GUID = 'c0de4000-0000-4000-8000-000000000002';
const ID = 900778;
const IMG = (name) => `https://img.example.invalid/${name}.png`;
const ALBUM = {
  id: ID, podcastGuid: GUID, title: 'E2E Mini Bar Album', author: 'e2e', medium: 'music',
  image: IMG('album'), artwork: IMG('album'), url: 'https://feeds.example.invalid/minibar.xml',
};
const TRACKS = [0, 1, 2, 3].map((k) => ({
  id: 8900 + k, guid: `c0de4000-0000-4000-8000-00000000020${k}`, podcastGuid: GUID, feedId: ID,
  title: `Bar track ${k}`, image: IMG(`bar-${k}`), enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
  episode: k + 1, duration: 30,
}));

const { page } = await launchChrome({ name: 'minibar', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(pathname) {
  if (pathname === '/api/by-guid') return { podcast: ALBUM };
  if (pathname === '/api/feed') return { podcast: ALBUM, episodes: TRACKS };
  if (pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}
await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/*', requestStage: 'Request' },
  { urlPattern: '*img.example.invalid*', requestStage: 'Request' },
] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  try {
    if (u.hostname === 'img.example.invalid' || u.pathname === '/api/art') {
      await wait(60);
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'image/png' }, { name: 'cache-control', value: 'max-age=3600' }],
        body: PNG.toString('base64'),
      });
      return;
    }
    if (u.pathname === '/api/e2e-audio.wav') {
      // Held, so the new source starts EMPTY and `waiting` sets `stalled`.
      await wait(700);
      const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
      const mm = range && /bytes=(\d+)-(\d*)/.exec(range);
      const start = mm ? Number(mm[1]) : 0;
      const end = mm && mm[2] ? Math.min(Number(mm[2]), AUDIO.length - 1) : AUDIO.length - 1;
      const body = AUDIO.subarray(start, end + 1);
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: mm ? 206 : 200,
        responseHeaders: [
          { name: 'content-type', value: 'audio/wav' },
          { name: 'accept-ranges', value: 'bytes' },
          { name: 'content-length', value: String(body.length) },
          ...(mm ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
        ],
        body: body.toString('base64'),
      });
      return;
    }
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: b64(answer(u.pathname)),
    });
  } catch {
    // The page navigated away under a paused request.
  }
});
await send('Page.enable');
await send('Runtime.enable');

const VIEWS = [
  { label: '390px phone', m: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } },
  { label: '640px (sm:)', m: { width: 640, height: 900, deviceScaleFactor: 1, mobile: false } },
  { label: '1280px desktop', m: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false } },
];

for (const v of VIEWS) {
  console.log(`\n${v.label}`);
  await send('Emulation.setDeviceMetricsOverride', v.m);
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  t.ok(`${v.label}: the album lists its tracks`,
    await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes('Bar track 0'))`, 30000));
  await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Bar track 0')).click()`);
  t.ok(`${v.label}: track 1 plays`,
    await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.5; })()`, 20000));
  await wait(500);

  // Every animation frame from ⏭ for 3 s: the bar's box, and whether a
  // "buffering" line is visible inside it.
  await js(`(() => {
    window.__bar = []; const start = performance.now();
    const tick = () => {
      const bar = document.querySelector('[data-mini-player]');
      const r = bar.getBoundingClientRect();
      const line = [...bar.querySelectorAll('div, span')].find((el) => {
        if (el.children.length) return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && /buffering/.test(el.textContent);
      });
      // A truncated instruction is not an instruction (#357): the readout
      // must fit the line it is folded into.
      const cut = !!line && line.scrollWidth > line.clientWidth;
      window.__bar.push({ top: Math.round(r.top * 10) / 10, h: Math.round(r.height * 10) / 10, said: !!line, cut,
        fit: line ? line.scrollWidth + '/' + line.clientWidth + 'px' : null });
      if (performance.now() - start < 3000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    [...document.querySelectorAll('[data-mini-player] button')].find((b) => /^Next/.test(b.getAttribute('aria-label') ?? ''))?.click();
    return 1;
  })()`);
  await wait(3500);
  const frames = JSON.parse(await js('JSON.stringify(window.__bar)'));
  const runs = frames.filter((f, i) => i === 0 || f.h !== frames[i - 1].h || f.said !== frames[i - 1].said);
  console.log(`  ${frames.length} frames: ${runs.map((f) => `${f.h}px${f.said ? ' (buffering)' : ''}`).join(' → ')}`);

  t.ok(`${v.label}: track 2 is playing afterwards`,
    await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && /[?&]k=1(\\D|$)/.test(a.currentSrc); })()`, 8000));
  t.equal(`${v.label}: the bar keeps ONE height through ⏭`, [...new Set(frames.map((f) => f.h))].length, 1);
  t.equal(`${v.label}: the bar keeps ONE top edge through ⏭`, [...new Set(frames.map((f) => f.top))].length, 1);
  t.ok(`${v.label}: the buffering readout is still shown while the next file loads`, frames.some((f) => f.said));
  // Only where this fix moved the readout. KNOWN GAP below `sm:`: at 390px the
  // phone line (unchanged since #357) needs 218px and gets 202px, so it reads
  // "press play to re…" — a separate fault, measured 2026-11-14 and left for
  // its own change rather than reworded here.
  if (!v.m.mobile) {
    t.ok(`${v.label}: …and it is not cut off`, !frames.some((f) => f.cut),
      `text/box ${frames.find((f) => f.cut)?.fit}`);
  } else {
    console.log(`  note ${v.label}: readout text/box ${frames.find((f) => f.said)?.fit} (known gap, not asserted)`);
  }
}

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
