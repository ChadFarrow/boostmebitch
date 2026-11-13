// Music gets ⏮/⏭ on the lock screen; a podcast keeps its skip buttons.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:lockbuttons                       # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:lockbuttons -- --headed --keep
//
// ASKED FOR (2026-11-13, Chad's iPhone lock screen, a favorites shuffle playing
// Right Said Fred): "instead of skip forward and back 10 or 30 seconds? Can we
// have previous and next when listening to music?"
//
// WebKit hands iOS the skip-interval buttons whenever the page has a `seekbackward` or
// `seekforward` handler, and ⏮/⏭ only when it has neither — the track handlers
// were registered all along and never drawn. So for an item that plays as
// tracks (`playsAsTracks`: music and musicL, the favorites shuffle's tracks)
// the two seek handlers are REMOVED; for a podcast they stay. No browser here
// draws a lock screen, so this records what the page hands
// `navigator.mediaSession.setActionHandler`, which is the whole of what iOS
// reads.
//
// WHAT IT PINS:
//   1. A music track: `previoustrack` and `nexttrack` set, `seekbackward` and
//      `seekforward` cleared, `seekto` (the scrub bar) kept.
//   2. The lock-screen ⏭ moves to the next track, and ⏮ back.
//   3. A podcast episode: the two seek handlers are set again.
//   4. Back to music: cleared again — it follows the item, not the first one.
//   5. AFTER the latest `playing` event the page has handed over ALL seven
//      again — the five track/scrub handlers and the two skips (cleared for a
//      track, set for a podcast). On Chad's iPhone (2026-11-13, #553) the
//      lock screen kept ±10 s for music although sections 1-4 passed: WebKit
//      sends iOS the page's handlers only through a remote-command listener
//      that exists while a media element is loading or playing
//      (NowPlayingManager::addSupportedCommand returns early without one), and
//      a NEW listener starts from its defaults — ±skip, no ⏮/⏭ — never from
//      what the page set before. Apple's own MediaSession API test plays
//      first and sets handlers after. So the page re-sends on every `playing`.

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

const ALBUM_GUID = 'b0a40000-0000-4000-8000-000000000001';
const SHOW_GUID = 'b0a40000-0000-4000-8000-000000000002';
const ALBUM = { id: 900991, podcastGuid: ALBUM_GUID, title: 'E2E Lock Album', author: 'e2e', medium: 'music', url: 'https://feeds.example.invalid/lock-album.xml' };
const SHOW = { id: 900992, podcastGuid: SHOW_GUID, title: 'E2E Lock Show', author: 'e2e', medium: 'podcast', url: 'https://feeds.example.invalid/lock-show.xml' };
const TRACKS = [0, 1, 2].map((k) => ({
  id: 9100 + k, guid: `b0a40000-0000-4000-8000-00000000010${k}`, podcastGuid: ALBUM_GUID, feedId: ALBUM.id,
  title: `Lock track ${k}`, episode: k + 1, duration: 30, enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
}));
const EPISODES = [0, 1].map((k) => ({
  id: 9200 + k, guid: `b0a40000-0000-4000-8000-00000000020${k}`, podcastGuid: SHOW_GUID, feedId: SHOW.id,
  title: `Lock episode ${k}`, duration: 30, enclosureUrl: `${APP}/api/e2e-audio.wav?p=${k}`,
  datePublished: 1700000000 + k,
}));

const { page } = await launchChrome({ name: 'lockbuttons', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

// What the page hands the OS, recorded before any app script runs.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const ms = navigator.mediaSession; if (!ms) return;
  const orig = ms.setActionHandler.bind(ms);
  window.__msh = {};
  // Every call, stamped with how many \`playing\` events had fired by then. This
  // listener is registered before any app script, so for one event it counts
  // first and the app's own capture listener runs after it.
  window.__msLog = []; window.__playingN = 0;
  document.addEventListener('playing', () => { window.__playingN += 1; }, true);
  ms.setActionHandler = (action, handler) => {
    window.__msh[action] = handler;
    window.__msLog.push({ action, fn: typeof handler === 'function', after: window.__playingN });
    try { orig(action, handler); } catch { /* unsupported */ }
  };
})();` });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(u) {
  const q = u.searchParams;
  const isShow = q.get('guid') === SHOW_GUID || q.get('id') === String(SHOW.id);
  if (u.pathname === '/api/by-guid') return { podcast: isShow ? SHOW : ALBUM };
  if (u.pathname === '/api/feed') return isShow ? { podcast: SHOW, episodes: EPISODES } : { podcast: ALBUM, episodes: TRACKS };
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

const handlers = async () => JSON.parse(await js(`JSON.stringify(Object.fromEntries(Object.entries(window.__msh ?? {}).map(([k, v]) => [k, typeof v === 'function'])))`));
// What the page handed over AFTER the latest \`playing\` event, last call wins.
const sinceLastPlaying = async () => JSON.parse(await js(`JSON.stringify((() => {
  const n = window.__playingN; const out = { playing: n };
  for (const c of window.__msLog) if (c.after === n && n > 0) out[c.action] = c.fn;
  return out;
})())`));
const ALL_FOR_A_TRACK = { play: true, pause: true, previoustrack: true, nexttrack: true, seekto: true, seekbackward: false, seekforward: false };
const ALL_FOR_A_PODCAST = { ...ALL_FOR_A_TRACK, seekbackward: true, seekforward: true };
const sansCount = ({ playing, ...rest }) => rest;
const pick = (h) => ({ previoustrack: h.previoustrack, nexttrack: h.nexttrack, seekbackward: h.seekbackward, seekforward: h.seekforward, seekto: h.seekto });
const playingSrc = (re) => until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2 && ${re}.test(a.currentSrc); })()`, 15000);
async function openFeed(guid, text) {
  await send('Page.navigate', { url: `${APP}/?podcast=${guid}` });
  await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes(${JSON.stringify(text)}))`, 20000);
  await wait(600);
}

// ---------------------------------------------------------------------------
console.log('\n1. A music track: ⏮/⏭ on the lock screen, no skip buttons');
await openFeed(ALBUM_GUID, 'Lock track 2');
await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Lock track 0')).click()`);
t.ok('track 0 plays', await playingSrc('/[?&]k=0(\\D|$)/'));
await wait(400);
t.equal('the handlers the page gives the OS', pick(await handlers()),
  { previoustrack: true, nexttrack: true, seekbackward: false, seekforward: false, seekto: true });
t.equal('…and ALL of them again after the track started playing (WebKit drops what came before)',
  sansCount(await sinceLastPlaying()), ALL_FOR_A_TRACK);

// ---------------------------------------------------------------------------
console.log('\n2. The lock-screen ⏭ and ⏮ move between tracks');
await js(`window.__msh.nexttrack({ action: 'nexttrack' })`);
t.ok('⏭ plays track 1', await playingSrc('/[?&]k=1(\\D|$)/'));
await js(`window.__msh.previoustrack({ action: 'previoustrack' })`);
t.ok('⏮ plays track 0 again', await playingSrc('/[?&]k=0(\\D|$)/'));

// ---------------------------------------------------------------------------
console.log('\n3. A podcast episode keeps its skip buttons');
await openFeed(SHOW_GUID, 'Lock episode 1');
await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Lock episode 0')).querySelector('button[aria-label="Play"]').click()`);
t.ok('the episode plays', await playingSrc('/[?&]p=0(\\D|$)/'));
await wait(400);
const h3 = pick(await handlers());
t.ok('the skip buttons are back', h3.seekbackward && h3.seekforward && h3.seekto, JSON.stringify(h3));
t.equal('…and all seven again after the episode started playing, skips included',
  sansCount(await sinceLastPlaying()), ALL_FOR_A_PODCAST);

// ---------------------------------------------------------------------------
console.log('\n4. Back to music: the skip buttons go again');
await openFeed(ALBUM_GUID, 'Lock track 2');
await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Lock track 2')).click()`);
t.ok('track 2 plays', await playingSrc('/[?&]k=2(\\D|$)/'));
await wait(400);
t.equal('the handlers follow the item', pick(await handlers()),
  { previoustrack: true, nexttrack: true, seekbackward: false, seekforward: false, seekto: true });

// ---------------------------------------------------------------------------
console.log('\n5. Every `playing` re-sends them: a pause and a resume');
await js(`document.querySelector('audio').pause()`);
await wait(300);
const before = (await sinceLastPlaying()).playing;
await js(`document.querySelector('audio').play()`);
t.ok('track 2 plays again', await playingSrc('/[?&]k=2(\\D|$)/'));
await wait(300);
const again = await sinceLastPlaying();
t.ok('a new `playing` event fired', again.playing > before, JSON.stringify({ before, now: again.playing }));
t.equal('all seven were handed over after it', sansCount(again), ALL_FOR_A_TRACK);

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
