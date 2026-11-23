// ⏮ at the start of a chaptered episode goes to the previous episode.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:prevepisode                       # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:prevepisode -- --headed --keep
//
// NEVER point APP_URL at beta or production: `localAppUrl` refuses anything off
// this machine, and every request the page makes is answered by the stubs below.
//
// REPORTED 2026-11-12 from boostmebuddy.com, the installed app, Chrome 157 on
// Android, a podcast (#534): "I pressed the next button and it jumped to the
// next episode, but when I pushed back it would go back to the start, but not
// back to the previous episode. I expected pushing back twice in a row to go to
// the previous episode." The log shows ⏮ pressed four times, ~1.7 s apart, each
// one an `m.seeked … ct=0` on the new episode and never a `src`.
//
// On a chaptered episode ⏮ is `buildChapterNav`'s override: restart the chapter
// after 3 s, else the previous chapter. On the FIRST chapter that "previous
// chapter" was 0:00 again, and a spent override never reached `episodeQueue`.
// Now the override is spent in the first 3 s of the first chapter, and
// `<TransportControls>` hands a spent ⏮ to the default step (`prevOv`).
//
// WHAT IT PINS (1280px mini-bar, then a 390px phone's fullscreen player under
// CDP device emulation):
//   1. The report: ⏮ in the first seconds of a chaptered episode reads
//      "Previous track", is enabled, and plays the episode above it in the list,
//      from its start.
//   2. Back twice, while playing: 0:30 → ⏮ restarts the chapter (0:20) → ⏮ goes
//      to the previous chapter (0:00) → ⏮ goes to the previous episode. The
//      chapter steps stay on the same file.
//   3. The FIRST episode has nothing before it: ⏮ is disabled in its first 3 s,
//      and past them it still restarts / steps chapters.
//   4. ⏭ is unchanged: on the last chapter it is "Next chapter", disabled — a
//      spent ⏭ still never leaves the episode.
//   5. The phone: the fullscreen player's ⏮ does the same, and is at least
//      24×24; the page has no sideways scroll.

import { checker, exit, launchChrome, requireApp, wait, MINI_BAR } from './cdp.mjs';
import { localAppUrl } from './local-target.mjs';

const APP = localAppUrl('http://127.0.0.1:3000');
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

const EP_SEC = 90;
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
const AUDIO = silentWav(EP_SEC);

const GUID = 'c0de5340-0000-4000-8000-000000000001';
const ID = 900534;
const SHOW = {
  id: ID, podcastGuid: GUID, title: 'E2E Prev Episode Show', author: 'e2e', medium: 'podcast',
  url: 'https://feeds.example.invalid/prev-episode.xml',
};
const EPISODES = [0, 1, 2].map((k) => ({
  id: 9534 + k, guid: `c0de5340-0000-4000-8000-00000000010${k}`, podcastGuid: GUID, feedId: ID,
  title: `Prev episode ${k}`, duration: EP_SEC, datePublished: 1763000000 + k * 86400,
  enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
  chaptersUrl: `https://chapters.example.invalid/${k}.json`,
}));
const CHAPTERS = [
  { startTime: 0, title: 'Intro' },
  { startTime: 20, title: 'Middle' },
  { startTime: 40, title: 'Last' },
];

const { page } = await launchChrome({ name: 'prevepisode', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(u) {
  if (u.pathname === '/api/by-guid') return { podcast: SHOW };
  if (u.pathname === '/api/feed') return { podcast: SHOW, episodes: EPISODES };
  if (u.pathname === '/api/chapters') return { chapters: CHAPTERS };
  if (u.pathname === '/api/item-value') return { read: true, value: null };
  if (u.pathname === '/api/audio-probe') return { status: 206 };
  if (u.pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  try {
    if (u.pathname === '/api/e2e-audio.wav') {
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
      body: b64(answer(u)),
    });
  } catch {
    // The page navigated away under a paused request.
  }
});
await send('Page.enable');
await send('Runtime.enable');

// ---- helpers ---------------------------------------------------------------

/** Where the transport lives: the mini-bar on desktop, the fullscreen player
 *  (`.z-50`) on the phone, where the mini-bar hides ⏮/⏭. */
let scope = MINI_BAR;
let touch = false;
const kOf = `(() => { const a = document.querySelector('audio'); const m = a && /[?&]k=(\\d)/.exec(a.currentSrc); return m ? Number(m[1]) : null; })()`;
const state = () => js(`(() => { const a = document.querySelector('audio'); const m = a && /[?&]k=(\\d)/.exec(a.currentSrc);
  return a ? { k: m ? Number(m[1]) : null, t: Math.round(a.currentTime * 10) / 10, paused: a.paused } : null; })()`);
const playingK = (k, ms = 15000) => until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && ${kOf} === ${k}; })()`, ms);
const btn = (re) => `[...document.querySelectorAll('${scope} button')].find((b) => ${re}.test(b.getAttribute('aria-label') || '') && b.getBoundingClientRect().width > 0)`;
// Rebuilt per view, after `scope` is set.
let PREV = btn('/^Previous/');
let NEXT = btn('/^Next/');
const read = (sel) => js(`(() => { const b = ${sel}; if (!b) return null; const r = b.getBoundingClientRect();
  return { label: b.getAttribute('aria-label'), disabled: b.disabled, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const press = async (sel) => {
  const b = await read(sel);
  if (!b) return false;
  if (touch) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  }
  return true;
};
/** Wait until ⏮ reads `label` (and `disabled`, when given). */
const prevIs = (label, disabled) => until(`(() => { const b = ${PREV}; return !!b && b.getAttribute('aria-label') === ${JSON.stringify(label)}${disabled === undefined ? '' : ` && b.disabled === ${disabled}`}; })()`, 5000);
/** The chapters have loaded once ⏭ is the chapter override. */
const chaptersLoaded = () => until(`(() => { const b = ${NEXT}; return !!b && b.getAttribute('aria-label') === 'Next chapter'; })()`, 10000);
const timeNear = (lo, hi, ms = 4000) => until(`(() => { const a = document.querySelector('audio'); return !!a && a.currentTime >= ${lo} && a.currentTime < ${hi}; })()`, ms);
const pauseAudio = () => js(`(() => { const b = document.querySelector('button[aria-label="Pause"]'); b && b.click(); return !!b; })()`);

/** The list's rows, top to bottom, as episode numbers. */
const rowOrder = () => js(`[...document.querySelectorAll('li')].filter((l) => l.querySelector('button[aria-label="Play"]') && /Prev episode \\d/.test(l.textContent) && !l.closest('.z-50'))
  .map((l) => Number(/Prev episode (\\d)/.exec(l.textContent)[1]))`);
const playRow = (k) => js(`(() => { const li = [...document.querySelectorAll('li')].find((l) => !l.closest('.z-50') && l.textContent.includes('Prev episode ${k}') && l.querySelector('button[aria-label="Play"]'));
  if (!li) return false; li.querySelector('button[aria-label="Play"]').click(); return true; })()`);
async function openShow() {
  // From a clean profile: a reload restores the last episode into the player,
  // and its row then offers RESUME, not Play.
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until(`document.readyState === 'complete'`, 20000);
  await js(`(() => { localStorage.clear(); sessionStorage.clear(); return true; })()`);
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  return until(`[...document.querySelectorAll('li')].filter((l) => /Prev episode \\d/.test(l.textContent) && l.querySelector('button[aria-label="Play"]')).length === 3`, 30000);
}
/** Start episode `k` from its row and wait for its chapters. */
async function start(k) {
  t.ok(`episode ${k} starts from its row`, (await playRow(k)) && (await playingK(k)), JSON.stringify(await state()));
  t.ok(`…and its chapters load (⏭ reads "Next chapter")`, await chaptersLoaded());
}

// ---- the checks ------------------------------------------------------------

const VIEWS = [
  { label: '1280px desktop', m: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, touch: false },
  { label: '390px phone', m: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, touch: true },
];

for (const v of VIEWS) {
  console.log(`\n== ${v.label}`);
  touch = v.touch;
  scope = v.m.mobile ? '.z-50' : MINI_BAR;
  PREV = btn('/^Previous/');
  NEXT = btn('/^Next/');
  await send('Emulation.setDeviceMetricsOverride', v.m);
  await send('Emulation.setTouchEmulationEnabled', { enabled: v.touch, maxTouchPoints: v.touch ? 5 : 0 });
  t.ok(`${v.label}: the show lists three episodes`, await openShow());
  const order = await rowOrder();
  t.equal(`${v.label}: three rows`, order.length, 3);
  const [first, mid] = order;
  const L = v.label;

  if (v.m.mobile) {
    // The phone: the mini-bar hides ⏮/⏭, so open the fullscreen player.
    console.log('5. The phone\'s fullscreen player');
    t.ok(`${L}: episode ${mid} starts from its row`, (await playRow(mid)) && (await playingK(mid)), JSON.stringify(await state()));
    await pauseAudio();
    await js(`(() => { const b = document.querySelector('${MINI_BAR} button[aria-label^="Open fullscreen player"]'); b && b.click(); return !!b; })()`);
    t.ok(`${L}: the fullscreen player opens with its ⏮`, await until(`!!(${PREV})`, 8000),
      JSON.stringify(await js(`[...document.querySelectorAll('button[aria-label^="Previous"], button[aria-label^="Open fullscreen"], button[aria-label^="Close fullscreen"]')].map((b) => { const r = b.getBoundingClientRect(); return [b.getAttribute('aria-label'), Math.round(r.width), Math.round(r.top), !!b.closest('.z-50'), !!b.closest('${MINI_BAR}')]; })`)));
    t.ok(`${L}: its chapters load`, await chaptersLoaded());
    // The player slides up over 300 ms: a tap read mid-slide lands below ⏮.
    await wait(700);
    const p = await read(PREV);
    t.ok(`${L}: ⏮ in the first seconds reads "Previous track", enabled`, p?.label === 'Previous track' && !p.disabled, JSON.stringify({ p, s: await state() }));
    t.ok(`${L}: ⏮ is at least 24×24 (${p?.w}×${p?.h})`, p && p.w >= 24 && p.h >= 24);
    await press(PREV);
    t.ok(`${L}: a tap plays episode ${first}, the row above`, await playingK(first), JSON.stringify(await state()));
    const s = await state();
    t.ok(`${L}: …from its start`, s && s.t < 3, JSON.stringify(s));
    const overflow = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    t.ok(`${L}: no sideways page scroll (${overflow}px)`, overflow <= 0);
    await pauseAudio();
    continue;
  }

  console.log('1. The report: ⏮ in the first seconds goes to the previous episode');
  await start(mid);
  await pauseAudio();
  let s = await state();
  t.ok(`${L}: paused within the first 3 s (${s?.t}s)`, s && s.t <= 3, JSON.stringify(s));
  t.ok(`${L}: ⏮ reads "Previous track" and is enabled`, await prevIs('Previous track', false), JSON.stringify(await read(PREV)));
  await press(PREV);
  t.ok(`${L}: pressing it plays episode ${first}, the row above`, await playingK(first), JSON.stringify(await state()));
  s = await state();
  t.ok(`${L}: …from its start`, s && s.t < 3, JSON.stringify(s));

  console.log('2. Back twice, while playing: chapter, chapter, then the previous episode');
  await start(mid);
  await press(btn('/^Skip forward 30/'));
  t.ok(`${L}: +30 puts episode ${mid} in its second chapter`, await timeNear(29, 34), JSON.stringify(await state()));
  t.ok(`${L}: ⏮ reads "Previous chapter"`, await prevIs('Previous chapter', false), JSON.stringify(await read(PREV)));
  await press(PREV);
  t.ok(`${L}: ⏮ restarts the chapter (0:20)`, await timeNear(20, 22), JSON.stringify(await state()));
  t.equal(`${L}: …on the same file`, (await state())?.k, mid);
  await wait(300);
  await press(PREV);
  t.ok(`${L}: ⏮ again goes to the first chapter (0:00)`, await timeNear(0, 2), JSON.stringify(await state()));
  t.equal(`${L}: …on the same file`, (await state())?.k, mid);
  t.ok(`${L}: ⏮ now reads "Previous track"`, await prevIs('Previous track', false), JSON.stringify(await read(PREV)));
  await press(PREV);
  t.ok(`${L}: ⏮ a third time plays episode ${first}`, await playingK(first), JSON.stringify(await state()));

  console.log('3. The first episode: nothing before it');
  // Step 2 just started it, so it is in its first seconds: pause it there.
  await pauseAudio();
  t.ok(`${L}: its chapters load`, await chaptersLoaded());
  s = await state();
  t.ok(`${L}: paused within the first 3 s (${s?.t}s)`, s && s.t <= 3, JSON.stringify(s));
  t.ok(`${L}: ⏮ is disabled — there is no previous episode`, await prevIs('Previous track', true), JSON.stringify(await read(PREV)));
  await press(btn('/^Skip forward 30/'));
  t.ok(`${L}: +30 → its second chapter`, await timeNear(29, 34), JSON.stringify(await state()));
  t.ok(`${L}: ⏮ reads "Previous chapter", enabled`, await prevIs('Previous chapter', false), JSON.stringify(await read(PREV)));
  await press(PREV);
  t.ok(`${L}: ⏮ restarts the chapter (0:20)`, await timeNear(20, 22), JSON.stringify(await state()));
  await press(PREV);
  t.ok(`${L}: ⏮ again → the first chapter (0:00)`, await timeNear(0, 2), JSON.stringify(await state()));
  t.ok(`${L}: …and ⏮ is disabled there`, await prevIs('Previous track', true), JSON.stringify(await read(PREV)));
  t.equal(`${L}: …still on episode ${first}`, (await state())?.k, first);

  console.log('4. ⏭ is unchanged: a spent ⏭ never leaves the episode');
  await press(btn('/^Skip forward 30/'));
  await timeNear(29, 34);
  await press(btn('/^Skip forward 30/'));
  t.ok(`${L}: +30 twice → the last chapter`, await timeNear(59, 64), JSON.stringify(await state()));
  t.ok(`${L}: ⏭ reads "Next chapter" and is disabled`,
    await until(`(() => { const b = ${NEXT}; return !!b && b.getAttribute('aria-label') === 'Next chapter' && b.disabled; })()`, 5000),
    JSON.stringify(await read(NEXT)));
}

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
