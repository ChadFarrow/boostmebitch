// A musicL playlist keeps ⏭, and a hidden iPhone page moves on before the end.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:hiddenadvance                     # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:hiddenadvance -- --headed --keep
//
// NEVER point APP_URL at beta or production. Every request this script makes
// is answered by the stubs below, but a real deploy is not the place to find
// out that one slipped through: `localAppUrl` refuses anything off this machine.
//
// REPORTED 2026-11-22 from Chad's iPhone, the installed app on beta, on the
// musicL playlist "WrathfulTs Top Tracks" (#647):
//
//   1. On screen, ⏭ was greyed out on track 10 while tracks 11-17 sat below
//      it. Track 10's album writes `<podcast:chapters>` with ONE chapter, and
//      the chapters gate read `isMusicMedium(current.podcast)` — the PLAYLIST —
//      so the chapters loaded and `buildChapterNav` took ⏮/⏭ over.
//   2. In the background, a track ended, the app moved on at once, and the
//      next file sat at HAVE_METADATA until the app came back on screen.
//      WebKit deactivates the audio session when the last playing session is
//      audio that has ENDED, and a hidden iPhone page cannot activate it again.
//      So a hidden iPhone page now moves on about a second BEFORE the end
//      (`advanceBeforeEnd`), while the old file still plays.
//
// No browser here is an iPhone, and Chrome deactivates nothing. So part 2 runs
// on what the PAGE can see: `navigator.userAgent` and
// `document.visibilityState`, both overridden before any app script runs, and
// the playback log. What the iPhone does with the audio session is not
// emulated; that needs the phone.
//
// WHAT IT PINS:
//   1. A playlist track whose album writes chapters: no /api/chapters request,
//      ⏭ reads "Next track" and is enabled, and pressing it plays the next row.
//   2. On screen, on an iPhone: every track plays to `ended` — no early move.
//   3. Hidden, on an iPhone: the swap comes within a second of the end, the old
//      file never reaches `ended`, the log says `advance via=tracks early=1`,
//      and the next track starts at its beginning (the old file's time must not
//      land on it). The LAST track has nothing after it: it plays to `ended`
//      and stops (`advance via=none`).
//   4. Hidden, on Android: unchanged — `ended`, then `advance via=tracks`.

import { checker, exit, launchChrome, requireApp, wait, MINI_BAR } from './cdp.mjs';
import { localAppUrl } from './local-target.mjs';

const APP = localAppUrl('http://127.0.0.1:3000');
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

const TRACK_SEC = 5;
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
const AUDIO = silentWav(TRACK_SEC);

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';

const GUID = 'b0a50000-0000-4000-8000-000000000001';
const FEED_URL = 'https://feeds.example.invalid/hidden-advance-playlist.xml';
const PLAYLIST = { id: 900995, podcastGuid: GUID, title: 'E2E Hidden Playlist', author: 'e2e', medium: 'musicL', url: FEED_URL };
// Four rows from four albums. Each album writes ONE chapter, as the podhome
// feed behind track 10 of the reported playlist does.
const TRACKS = [0, 1, 2, 3].map((k) => ({
  id: 9500 + k, guid: `b0a50000-0000-4000-8000-00000000010${k}`, podcastGuid: `b0a50000-0000-4000-8000-00000000020${k}`,
  feedId: 9600 + k, title: `Hidden track ${k}`, duration: TRACK_SEC, datePublished: 1700000000 + k,
  enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
  chaptersUrl: `https://feeds.example.invalid/chapters/${k}.json`,
}));

const { page } = await launchChrome({ name: 'hiddenadvance', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];
const seen = [];

// What the page can see of the platform and the visibility, set before any app
// script runs, and switchable without a reload (a reload would stop playback).
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  window.__e2eUA = ${JSON.stringify(IPHONE_UA)};
  window.__e2eHidden = false;
  Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get() { return window.__e2eUA; } });
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__e2eHidden ? 'hidden' : 'visible'; } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return !!window.__e2eHidden; } });
  window.__e2eSetHidden = (h) => { window.__e2eHidden = !!h; document.dispatchEvent(new Event('visibilitychange')); };
  // Every source swap, with the last time the OLD file reported, and the time
  // each new file first plays at. Capture listeners on the document run before
  // the app's own handlers.
  window.__last = null; window.__swaps = []; window.__starts = [];
  document.addEventListener('timeupdate', (e) => {
    const a = e.target; window.__last = { src: a.currentSrc, t: a.currentTime, d: a.duration, ended: a.ended };
  }, true);
  document.addEventListener('emptied', () => { if (window.__last) window.__swaps.push(window.__last); window.__last = null; }, true);
  document.addEventListener('playing', (e) => { window.__starts.push({ src: e.target.currentSrc, t: e.target.currentTime }); }, true);
})();` });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(u) {
  if (u.pathname === '/api/by-guid') return { podcast: PLAYLIST };
  if (u.pathname === '/api/feed') return { podcast: PLAYLIST, episodes: [] };
  if (u.pathname === '/api/playlist') {
    return { podcast: PLAYLIST, episodes: TRACKS, total: TRACKS.length, offset: 0, nextOffset: null, notFound: 0, couldNotAsk: 0, sourceShow: null };
  }
  if (u.pathname === '/api/chapters') return { chapters: [{ startTime: 0, title: '100 sats from ChadF' }] };
  if (u.pathname === '/api/item-value') return { read: true, value: { model: { type: 'lightning', method: 'keysend' }, recipients: [{ name: 'artist', type: 'node', address: '02artist', split: 100 }] } };
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
  seen.push(u.pathname);
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

const kRe = (k) => `/[?&]k=${k}(\\D|$)/`;
const playingK = (k, ms = 15000) => until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2 && ${kRe(k)}.test(a.currentSrc); })()`, ms);
const logLines = async () => JSON.parse(await js(`localStorage.getItem('bmb:plog:device') || '[]'`));
/** The log lines after `mark`, the LAST LINE when the section began. Never a
 *  count: the log is a ring of PLAYBACK_LOG_CAP lines, so once it is full the
 *  count stops moving while the lines do. Each line carries its millisecond. */
const markLog = async () => (await logLines()).at(-1) ?? '';
const since = async (mark) => {
  const l = await logLines();
  return l.slice(l.lastIndexOf(mark) + 1).map((x) => x.replace(/^\S+ /, ''));
};
const nextBtn = () => js(`(() => { const b = document.querySelector('${MINI_BAR} button[aria-label="Next track"], ${MINI_BAR} button[aria-label="Next chapter"]'); return b ? JSON.stringify({ label: b.getAttribute('aria-label'), disabled: b.disabled }) : 'null'; })()`).then(JSON.parse);
async function openPlaylistAndPlay(k) {
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes('Hidden track 3'))`, 20000);
  await wait(500);
  await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Hidden track ${k}')).click()`);
  return playingK(k);
}

// ---------------------------------------------------------------------------
console.log('\n1. A playlist track whose album writes chapters keeps ⏭');
t.ok('track 1 plays', await openPlaylistAndPlay(1));
await wait(1200);
t.equal('no chapters document is requested for a playlist track', seen.filter((p) => p === '/api/chapters').length, 0);
t.equal('⏭ is the playlist\'s, and enabled', await nextBtn(), { label: 'Next track', disabled: false });
await js(`window.__swaps = []; document.querySelector('${MINI_BAR} button[aria-label="Next track"]')?.click()`);
t.ok('…and pressing it plays track 2', await playingK(2));
{
  // Not the track ending on its own: a 5 s track auto-advances too, so the
  // press is proved by WHERE track 1 was when its file was swapped.
  const s1 = JSON.parse(await js(`JSON.stringify(window.__swaps)`)).find((x) => new RegExp(kRe(1).slice(1, -1)).test(x.src));
  t.ok('…by the press, with most of track 1 still to play', s1 && s1.d - s1.t > 1.5, JSON.stringify(s1));
}

// ---------------------------------------------------------------------------
console.log('\n2. On screen, on an iPhone: each track plays to its end');
let mark = await markLog();
t.ok('track 2 ends and track 3 plays', await playingK(3, TRACK_SEC * 1000 + 8000));
{
  const l = await since(mark);
  const ended = l.findIndex((x) => x.startsWith('m.ended'));
  const adv = l.findIndex((x) => x === 'advance via=tracks');
  t.ok('`m.ended`, then `advance via=tracks`', ended >= 0 && adv > ended, JSON.stringify(l.slice(0, 6)));
  t.ok('no early move on screen', !l.some((x) => / early=1/.test(x)), JSON.stringify(l.filter((x) => x.startsWith('advance'))));
}
await js(`document.querySelector('audio').pause()`);

// ---------------------------------------------------------------------------
console.log('\n3. Hidden, on an iPhone: the next track starts before the end');
t.ok('track 0 plays', await openPlaylistAndPlay(0));
await js(`window.__swaps = []; window.__starts = []; window.__e2eSetHidden(true)`);
mark = await markLog();
t.ok('track 1 plays, hidden', await playingK(1, TRACK_SEC * 1000 + 8000));
{
  const l = await since(mark);
  const k0Ended = l.some((x) => x.startsWith('m.ended'));
  t.ok('the log says `advance via=tracks early=1`', l.includes('advance via=tracks early=1'), JSON.stringify(l.filter((x) => x.startsWith('advance'))));
  t.ok('track 0 never reached `ended`', !k0Ended, JSON.stringify(l.filter((x) => x.startsWith('m.'))));
  const swaps = JSON.parse(await js(`JSON.stringify(window.__swaps)`));
  const s0 = swaps.find((s) => new RegExp(kRe(0).slice(1, -1)).test(s.src));
  const left = s0 ? s0.d - s0.t : NaN;
  t.ok('the swap came within about a second of the end, before it', s0 && !s0.ended && left > 0 && left <= 1.3, JSON.stringify(s0));
  const starts = JSON.parse(await js(`JSON.stringify(window.__starts)`));
  const s1 = starts.find((s) => new RegExp(kRe(1).slice(1, -1)).test(s.src));
  t.ok('track 1 starts at its beginning, not at track 0\'s time', s1 && s1.t < 1, JSON.stringify(s1));
}
t.ok('track 2 follows, hidden', await playingK(2, TRACK_SEC * 1000 + 8000));
t.ok('track 3 follows, hidden', await playingK(3, TRACK_SEC * 1000 + 8000));
mark = await markLog();
t.ok('the last track plays out and stops', await until(`(() => { const a = document.querySelector('audio'); return !!a && a.paused && a.ended; })()`, TRACK_SEC * 1000 + 8000));
{
  const l = await since(mark);
  t.ok('…through `ended` and `advance via=none` (nothing after it)', l.some((x) => x.startsWith('m.ended')) && l.includes('advance via=none'), JSON.stringify(l));
  t.ok('…with no early move', !l.some((x) => / early=1/.test(x)));
}
await js(`window.__e2eSetHidden(false)`);

// ---------------------------------------------------------------------------
console.log('\n4. Hidden, on Android: unchanged');
t.ok('track 0 plays', await openPlaylistAndPlay(0));
// A navigation runs the init script again, which resets the UA: set it after.
await js(`window.__e2eUA = ${JSON.stringify(ANDROID_UA)}; window.__e2eSetHidden(true)`);
mark = await markLog();
t.ok('track 1 plays, hidden', await playingK(1, TRACK_SEC * 1000 + 8000));
{
  const l = await since(mark);
  const ended = l.findIndex((x) => x.startsWith('m.ended'));
  const adv = l.findIndex((x) => x === 'advance via=tracks');
  t.ok('`m.ended`, then `advance via=tracks`, as before', ended >= 0 && adv > ended, JSON.stringify(l.slice(0, 6)));
  t.ok('no early move off an iPhone', !l.some((x) => / early=1/.test(x)));
}

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
