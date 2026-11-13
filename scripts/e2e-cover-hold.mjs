// The now-playing cover must never go EMPTY when the picture changes.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:coverhold                         # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:coverhold -- --headed --keep
//
// THE FAULT IT WAS WRITTEN AGAINST (2026-11-13, reported from the beta site
// while testing the favorites shuffle): "when I skip to the next track, the art
// loads, but then it also flashes just once." Measured on beta with ⏭ in an
// ordinary album, so it is not the shuffle's: the big cover changed THREE times
// in half a second — the new track's published file on the first commit (the
// art gate still open from the last track), the proxied copy once `waiting`
// shut the gate, and the published file again when the buffer reopened it
// (`preferOriginal={open && artOk}`). `<PodcastCover>` renders
// `<img key={current}>`, so every one of those was a NEW element, empty until
// its file arrived: 372 ms of nothing on the last swap. That empty box between
// two pictures is the flash.
//
// WHAT IT PINS: from ⏭ until the new track's published file is on screen,
// every animation frame paints SOME picture in the cover box — the old one is
// held until the next has loaded. And the gate still decides: the proxied copy
// is on screen before the published file, and the cover ends on the published
// file, which is how an animated cover keeps moving.
//
// Everything the player asks for is answered here: the album, the audio (a
// silent WAV, each answer held 700 ms so `waiting` shuts the gate every time),
// and the pictures (the proxied copy after 60 ms, the published file after
// 1.5 s — slower than the gate reopens, as a big original lags its tile on a
// phone; at 600 ms the file was already cached by the swap and the second gap
// never showed). Nothing reaches Podcast Index.

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
// A valid 1×1 PNG. `naturalWidth > 0` once decoded is all the sampler asks.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const GUID = 'c0de4000-0000-4000-8000-000000000001';
const ID = 900777;
const IMG = (name) => `https://img.example.invalid/${name}.png`;
const ALBUM = {
  id: ID, podcastGuid: GUID, title: 'E2E Cover Album', author: 'e2e', medium: 'music',
  image: IMG('album'), artwork: IMG('album'), url: 'https://feeds.example.invalid/cover.xml',
};
const TRACKS = [0, 1, 2].map((k) => ({
  id: 8800 + k, guid: `c0de4000-0000-4000-8000-00000000010${k}`, podcastGuid: GUID, feedId: ID,
  title: `Cover track ${k}`, image: IMG(`cover-${k}`), enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
  episode: k + 1, duration: 30,
}));

const { page } = await launchChrome({ name: 'coverhold', autoplay: true, args: ['--disable-gpu'] });
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
      // The published file lags its proxied tile, as a big original does.
      await wait(u.pathname === '/api/art' ? 60 : 1500);
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'image/png' }, { name: 'cache-control', value: 'max-age=3600' }],
        body: PNG.toString('base64'),
      });
      return;
    }
    if (u.pathname === '/api/e2e-audio.wav') {
      // Held, so the new source starts EMPTY and `waiting` shuts the art gate.
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

// The cover box's pictures, the way e2e:artgate finds the hero: square and large.
const COVER_IMGS = `[...document.images].filter((i) => { const b = i.getBoundingClientRect();
  return b.width > 200 && Math.abs(b.width - b.height) < 40 && !/hero\\.jpg/.test(i.currentSrc); })`;
const painted = () => js(`(() => { const v = ${COVER_IMGS}.filter((i) => getComputedStyle(i).opacity !== '0');
  const p = v.find((i) => i.complete && i.naturalWidth > 0); return p ? p.currentSrc : null; })()`);
const isRaw = (src, k) => !!src && src.startsWith(IMG(`cover-${k}`));
const isProxied = (src, k) => !!src && src.includes('/api/art') && src.includes(encodeURIComponent(IMG(`cover-${k}`)));

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
t.ok('the album lists its tracks', await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes('Cover track 0'))`, 20000));
await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Cover track 0')).click()`);
t.ok('track 1 plays', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2; })()`, 15000));
await js(`document.querySelector('[aria-label^="Open fullscreen player"]')?.click()`);
t.ok('the open cover settles on track 1\'s published file',
  await until(`(() => { const v = ${COVER_IMGS}.filter((i) => getComputedStyle(i).opacity !== '0');
    return v.some((i) => i.complete && i.naturalWidth > 0 && i.currentSrc.startsWith(${JSON.stringify(IMG('cover-0'))})); })()`, 15000),
  await painted());

// Every animation frame from ⏭ for 5 s: which picture is PAINTED, or none.
await js(`(() => {
  window.__frames = []; const start = performance.now();
  const tick = () => {
    const v = ${COVER_IMGS}.filter((i) => getComputedStyle(i).opacity !== '0');
    const p = v.find((i) => i.complete && i.naturalWidth > 0);
    window.__frames.push(p ? p.currentSrc : null);
    if (performance.now() - start < 5000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  [...document.querySelectorAll('button')].filter((b) => /^Next/.test(b.getAttribute('aria-label') ?? '')).pop()?.click();
  return 1;
})()`);
await wait(5500);
const frames = JSON.parse(await js('JSON.stringify(window.__frames)'));
const seq = frames.filter((s, i) => i === 0 || s !== frames[i - 1]);
const short = (s) => (s === null ? '(empty)' : s.includes('/api/art') ? `proxied ${decodeURIComponent(s).match(/cover-\d/)?.[0]}` : `published ${s.match(/cover-\d/)?.[0]}`);
console.log(`  ${frames.length} frames: ${seq.map(short).join(' → ')}`);

const empty = frames.filter((s) => s === null).length;
t.equal('no frame paints an EMPTY cover after ⏭', empty, 0);
t.ok('the cover ends on track 2\'s published file', isRaw(frames[frames.length - 1], 1), short(frames[frames.length - 1]));
const firstProxied = frames.findIndex((s) => isProxied(s, 1));
const firstRaw = frames.findIndex((s) => isRaw(s, 1));
t.ok('the gate still decides: track 2\'s proxied copy shows before its published file',
  firstProxied >= 0 && firstRaw > firstProxied, `proxied at frame ${firstProxied}, published at ${firstRaw}`);
t.ok('track 1\'s picture never comes back once track 2\'s is on screen',
  !frames.slice(Math.max(0, firstProxied)).some((s) => s && s.includes('cover-0')));

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
