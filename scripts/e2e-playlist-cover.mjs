// The ▶ on a playlist's or an album's art starts the list over.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:playlistcover                     # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:playlistcover -- --headed --keep
//
// NEVER point APP_URL at beta or production. Every request this script makes
// is answered by the stubs below, and it writes no playlist, but `localAppUrl`
// refuses anything off this machine all the same.
//
// REPORTED 2026-11-22 from Chad's iPhone, the installed app on beta, on the
// musicL playlist "WrathfulTs Top Tracks": he reloaded the playlist page while
// the playlist played, the mini player came back on track 13, and the ▶ on the
// playlist's art resumed track 13. In his words: "I think the album art play
// button should just start the playlist over again, even if you were already
// playing it." The cover shared the ALBUM rule (`albumHoldsCurrent`): while
// the list holds the track, the cover pauses and resumes it. #652 made the
// playlist cover start over; asked about albums, Chad answered "album-over:
// yes" the same day, so the album cover now does the same.
//
// WHAT IT PINS (`coverStartSeeks` in lib/util.ts, pinned by `check:queue`):
//   1. Nothing playing: the cover reads "Play playlist from the start" and
//      starts the first row.
//   2. Another row of the playlist PLAYING mid-way: the cover draws ▶, never
//      ❚❚, and a press plays the first row from its start.
//   3. Another row PAUSED mid-way: the same.
//   4. The FIRST row playing mid-way, then paused mid-way: a press goes back
//      to 0:00 and plays — `play()` alone reloads nothing for the same id.
//   5. The playlist's own shuffle, on another row and then on the first row:
//      a press ends the shuffle and plays the playlist in order from 0:00.
//      REPEAT stays on.
//   6. After a reload, the song back alone in the mini player (Chad's case):
//      a press plays the first row.
//   7. An ALBUM starts over the same way: another song playing or paused,
//      its first song mid-way, its own shuffle, and after a reload. (The
//      album covers in a LIST, on /demu, keep their pause and resume:
//      `e2e:demuplay`.)
//   8. Layout at 390 × 844 under device emulation: no sideways scroll, and the
//      cover is a 24 × 24 target or larger.
//
// NOT DRIVEN: iOS. `play()` runs inside the press, as before (iOS ties it to
// the gesture); Chrome does not enforce that rule here (autoplay is on).

import { checker, exit, launchChrome, requireApp, wait, MINI_BAR } from './cdp.mjs';
import { localAppUrl } from './local-target.mjs';

const APP = localAppUrl('http://127.0.0.1:3000');
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// Thirty seconds of 8 kHz 8-bit silence, so a track is still mid-way when the
// test presses the cover.
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

const GUID = 'c0e50000-0000-4000-8000-000000000001';
const FEED_URL = 'https://feeds.example.invalid/cover-playlist.xml';
const PLAYLIST = { id: 900996, podcastGuid: GUID, title: 'E2E Cover Playlist', author: 'e2e', medium: 'musicL', url: FEED_URL };
// Four rows from four albums, as `/api/playlist` answers them.
const TRACKS = [0, 1, 2, 3].map((k) => ({
  id: 9700 + k, guid: `c0e50000-0000-4000-8000-00000000010${k}`, podcastGuid: `c0e50000-0000-4000-8000-00000000020${k}`,
  feedId: 9800 + k, title: `Cover track ${k}`, duration: 30, datePublished: 1700000000 + k,
  enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
}));
const ALBUM_GUID = 'c0e50000-0000-4000-8000-000000000002';
const ALBUM = { id: 900997, podcastGuid: ALBUM_GUID, title: 'E2E Cover Album', author: 'e2e', medium: 'music', url: 'https://feeds.example.invalid/cover-album.xml' };
const ALBUM_TRACKS = [0, 1, 2].map((k) => ({
  id: 9900 + k, guid: `c0e50000-0000-4000-8000-00000000030${k}`, podcastGuid: ALBUM_GUID, feedId: ALBUM.id,
  title: `Album song ${k}`, duration: 30, datePublished: 1700000000 + k, episode: k + 1,
  enclosureUrl: `${APP}/api/e2e-audio.wav?a=${k}`,
  value: { model: { type: 'lightning', method: 'keysend' }, recipients: [{ name: 'album', type: 'node', address: '02album', split: 100 }] },
}));

const { page } = await launchChrome({ name: 'playlistcover', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(u) {
  const q = u.searchParams;
  if (u.pathname === '/api/by-guid') return { podcast: q.get('guid') === ALBUM_GUID ? ALBUM : PLAYLIST };
  if (u.pathname === '/api/feed') {
    return q.get('id') === String(ALBUM.id) ? { podcast: ALBUM, episodes: ALBUM_TRACKS } : { podcast: PLAYLIST, episodes: [] };
  }
  if (u.pathname === '/api/playlist') {
    return { podcast: PLAYLIST, episodes: TRACKS, total: TRACKS.length, offset: 0, nextOffset: null, notFound: 0, couldNotAsk: 0, sourceShow: null };
  }
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
  try {
    // RANGES ARE ANSWERED, because the test seeks: with `accept-ranges: none`
    // Chrome reports `seekable` as [0, 0] (e2e-shuffle measured it).
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

// ---- helpers --------------------------------------------------------------
// The cover is found by its place, not its words: the words are under test.
const COVER = `document.querySelector('header button.group')`;
const cover = async () => JSON.parse(await js(`JSON.stringify((() => { const b = ${COVER};
  return b ? { label: b.getAttribute('aria-label'), glyph: b.lastElementChild?.textContent.trim() } : null; })())`));
const pressCover = () => js(`(() => { const b = ${COVER}; if (!b) return false; b.click(); return true; })()`);
const audio = () => js(`JSON.stringify((() => { const a = document.querySelector('audio');
  return a ? { src: a.currentSrc, t: a.currentTime, paused: a.paused } : null; })())`).then(JSON.parse);
const on = (re) => `(() => { const a = document.querySelector('audio'); return !!a && ${re}.test(a.currentSrc); })()`;
const kRe = (k) => `/[?&]k=${k}(\\D|$)/`;
const aRe = (k) => `/[?&]a=${k}(\\D|$)/`;
/** The row `re` names plays, and has played past `sec`. */
const playingPast = (re, sec, ms = 15000) =>
  until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > ${sec} && ${re}.test(a.currentSrc); })()`, ms);
/** The row `re` names plays, from near its start: under 2 s once it runs. */
const startedFresh = async (re, ms = 10000) => {
  const ok = await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.05 && ${re}.test(a.currentSrc); })()`, ms);
  const a = await audio();
  return { ok: ok && a.t < 2, a };
};
const tapRow = (title) => js(`(() => { const li = [...document.querySelectorAll('ul > li')].find((x) => x.textContent.includes(${JSON.stringify(title)}));
  if (!li) return false; li.click(); return true; })()`);
const miniButton = (re) => js(`(() => { const b = [...document.querySelectorAll('${MINI_BAR} button')].find((x) => ${re}.test(x.getAttribute('aria-label') ?? ''));
  return b ? JSON.stringify({ label: b.getAttribute('aria-label'), disabled: b.disabled }) : 'null'; })()`).then(JSON.parse);
const pressMini = (re) => js(`(() => { const b = [...document.querySelectorAll('${MINI_BAR} button')].find((x) => ${re}.test(x.getAttribute('aria-label') ?? ''));
  if (!b || b.disabled) return false; b.click(); return true; })()`);
const pause = async () => {
  await pressMini('/^Pause$/');
  return until(`document.querySelector('audio')?.paused === true`, 5000);
};
async function openByUrl(guid, text, { clear = true } = {}) {
  if (clear) {
    await send('Page.navigate', { url: `${APP}/privacy` });
    await until('document.readyState === "complete"');
    await js('(() => { localStorage.clear(); sessionStorage.clear(); return true; })()');
  }
  await send('Page.navigate', { url: `${APP}/?podcast=${guid}` });
  await until('document.readyState === "complete"');
  const ok = await until(`document.body.textContent.includes(${JSON.stringify(text)})`, 20000);
  await wait(600);
  return ok;
}
const FROM_START = { label: 'Play playlist from the start', glyph: '▶' };

// ---------------------------------------------------------------------------
console.log('\n1. Nothing playing');
t.ok('the playlist opens', await openByUrl(GUID, 'Cover track 3'));
t.equal('the cover offers the playlist from the start', await cover(), FROM_START);
t.ok('the press lands', await pressCover());
{
  const r = await startedFresh(kRe(0));
  t.ok('the first row plays, from its start', r.ok, JSON.stringify(r.a));
}

// ---------------------------------------------------------------------------
console.log('\n2. Another row PLAYING mid-way');
t.ok('a tap on row 2 plays it', await tapRow('Cover track 2'));
t.ok('row 2 plays past 2 s', await playingPast(kRe(2), 2));
t.equal('the cover draws ▶ and offers the start — not ❚❚', await cover(), FROM_START);
await pressCover();
{
  const r = await startedFresh(kRe(0));
  t.ok('the press plays the first row from its start', r.ok, JSON.stringify(r.a));
}

// ---------------------------------------------------------------------------
console.log('\n3. Another row PAUSED mid-way');
await tapRow('Cover track 2');
t.ok('row 2 plays past 2 s', await playingPast(kRe(2), 2));
t.ok('the mini player pauses it', await pause());
t.equal('the cover offers the start', await cover(), FROM_START);
await pressCover();
{
  const r = await startedFresh(kRe(0));
  t.ok('the press plays the first row from its start', r.ok, JSON.stringify(r.a));
}

// ---------------------------------------------------------------------------
console.log('\n4. The FIRST row mid-way: back to 0:00');
t.ok('row 0 plays past 3 s', await playingPast(kRe(0), 3));
t.equal('the cover offers the start, not a pause', await cover(), FROM_START);
await pressCover();
{
  const r = await startedFresh(kRe(0), 5000);
  t.ok('playing, the press goes back to its start and plays on', r.ok, JSON.stringify(r.a));
}
t.ok('row 0 plays past 3 s again', await playingPast(kRe(0), 3));
t.ok('the mini player pauses it', await pause());
await pressCover();
{
  const r = await startedFresh(kRe(0), 5000);
  t.ok('paused, the press goes back to its start and plays', r.ok, JSON.stringify(r.a));
}

// ---------------------------------------------------------------------------
console.log('\n5. The playlist\'s own shuffle, and REPEAT');
await js(`document.querySelector('button[data-playlist-repeat]')?.click()`);
t.equal('REPEAT is on', await js(`document.querySelector('button[data-playlist-repeat]')?.getAttribute('aria-pressed')`), 'true');
await js(`document.querySelector('button[data-playlist-shuffle]')?.click()`);
// The row playing (row 0) goes LAST in a new shuffle, so the shuffle opens on
// another row.
t.ok('the shuffle plays another row', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && /[?&]k=[123](\\D|$)/.test(a.currentSrc); })()`, 10000));
t.equal('⏭ is the shuffle\'s', await miniButton('/^Next/'), { label: 'Next in shuffle', disabled: false });
await wait(1500);
t.equal('the cover offers the start', await cover(), FROM_START);
await pressCover();
{
  const r = await startedFresh(kRe(0));
  t.ok('the press plays the first row from its start', r.ok, JSON.stringify(r.a));
}
t.equal('…and ends the shuffle: ⏭ is the playlist\'s', await miniButton('/^Next/'), { label: 'Next track', disabled: false });
t.equal('…and REPEAT stays on', await js(`document.querySelector('button[data-playlist-repeat]')?.getAttribute('aria-pressed')`), 'true');
// Now a shuffle that reaches the FIRST row: it is last in a new shuffle, so
// walk ⏭ to it.
await js(`document.querySelector('button[data-playlist-shuffle]')?.click()`);
await until(`(() => { const a = document.querySelector('audio'); return !!a && /[?&]k=[123](\\D|$)/.test(a.currentSrc); })()`, 10000);
for (let i = 0; i < 3 && !(await js(on(kRe(0)))); i += 1) {
  await wait(800);
  await pressMini('/^Next in shuffle$/');
  await wait(800);
}
t.ok('the shuffle reaches row 0, past 2 s', await playingPast(kRe(0), 2));
t.equal('⏭ is still the shuffle\'s (repeat on)', (await miniButton('/^Next/'))?.label, 'Next in shuffle');
await pressCover();
{
  const r = await startedFresh(kRe(0), 5000);
  t.ok('the press takes row 0 back to its start', r.ok, JSON.stringify(r.a));
}
t.equal('…and ends the shuffle', (await miniButton('/^Next/'))?.label, 'Next track');
await js(`document.querySelector('button[data-playlist-repeat]')?.click()`);

// ---------------------------------------------------------------------------
console.log('\n6. After a reload (Chad\'s case)');
await tapRow('Cover track 2');
t.ok('row 2 plays past 3 s', await playingPast(kRe(2), 3));
await send('Page.reload');
await until('document.readyState === "complete"');
await until(`document.body.textContent.includes('Cover track 3')`, 20000);
await wait(1000);
{
  const a = await audio();
  t.ok('the mini player is back on row 2, paused', !!a && /[?&]k=2(\D|$)/.test(a.src) && a.paused, JSON.stringify(a));
}
t.equal('the cover offers the start — not a resume of row 2', await cover(), FROM_START);
await pressCover();
{
  const r = await startedFresh(kRe(0));
  t.ok('the press plays the first row from its start', r.ok, JSON.stringify(r.a));
}

// ---------------------------------------------------------------------------
console.log('\n7. An ALBUM starts over too ("album-over: yes")');
const ALBUM_START = { label: 'Play album from the start', glyph: '▶' };
t.ok('the album opens', await openByUrl(ALBUM_GUID, 'Album song 2'));
t.equal('the cover offers the album from the start', await cover(), ALBUM_START);
await tapRow('Album song 1');
t.ok('song 1 plays past 2 s', await playingPast(aRe(1), 2));
t.equal('the cover draws ▶ and offers the start — not ❚❚', await cover(), ALBUM_START);
await pressCover();
{
  const r = await startedFresh(aRe(0));
  t.ok('playing song 1, the press plays song 0 from its start', r.ok, JSON.stringify(r.a));
}
await tapRow('Album song 1');
t.ok('song 1 plays past 2 s', await playingPast(aRe(1), 2));
t.ok('the mini player pauses it', await pause());
await pressCover();
{
  const r = await startedFresh(aRe(0));
  t.ok('paused on song 1, the press plays song 0 from its start', r.ok, JSON.stringify(r.a));
}
t.ok('song 0 plays past 3 s', await playingPast(aRe(0), 3));
await pressCover();
{
  const r = await startedFresh(aRe(0), 5000);
  t.ok('song 0 mid-way: back to its start, playing', r.ok, JSON.stringify(r.a));
}
t.ok('song 0 plays past 3 s again', await playingPast(aRe(0), 3));
t.ok('the mini player pauses it', await pause());
await pressCover();
{
  const r = await startedFresh(aRe(0), 5000);
  t.ok('song 0 paused mid-way: back to its start, playing', r.ok, JSON.stringify(r.a));
}
// The album's own shuffle. The song playing (song 0) goes LAST in a new
// shuffle, so it opens on another song.
await js(`document.querySelector('button[data-album-shuffle]')?.click()`);
t.ok('the album shuffle plays another song', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && /[?&]a=[12](\\D|$)/.test(a.currentSrc); })()`, 10000));
t.equal('⏭ is the shuffle\'s', (await miniButton('/^Next/'))?.label, 'Next in shuffle');
await wait(1500);
t.equal('the cover offers the start', await cover(), ALBUM_START);
await pressCover();
{
  const r = await startedFresh(aRe(0));
  t.ok('the press plays song 0 from its start', r.ok, JSON.stringify(r.a));
}
t.equal('…and ends the shuffle: ⏭ is the album\'s', await miniButton('/^Next/'), { label: 'Next track', disabled: false });
// After a reload: the song comes back alone, paused.
await tapRow('Album song 2');
t.ok('song 2 plays past 3 s', await playingPast(aRe(2), 3));
await send('Page.reload');
await until('document.readyState === "complete"');
await until(`document.body.textContent.includes('Album song 2')`, 20000);
await wait(1000);
{
  const a = await audio();
  t.ok('after a reload the mini player is back on song 2, paused', !!a && /[?&]a=2(\D|$)/.test(a.src) && a.paused, JSON.stringify(a));
}
t.equal('the cover offers the start — not a resume of song 2', await cover(), ALBUM_START);
await pressCover();
{
  const r = await startedFresh(aRe(0));
  t.ok('the press plays song 0 from its start', r.ok, JSON.stringify(r.a));
}
await pause();

// ---------------------------------------------------------------------------
console.log('\n8. Layout at 390 × 844');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
t.ok('the playlist opens', await openByUrl(GUID, 'Cover track 3'));
{
  const m = JSON.parse(await js(`JSON.stringify((() => { const b = ${COVER}.getBoundingClientRect(); const d = document.documentElement;
    return { sw: d.scrollWidth, cw: d.clientWidth, w: b.width, h: b.height }; })())`));
  t.ok('no sideways scroll', m.sw <= m.cw, JSON.stringify(m));
  t.ok('the cover is at least 24 × 24', m.w >= 24 && m.h >= 24, JSON.stringify(m));
}
t.equal('the cover offers the start', await cover(), FROM_START);
if (process.env.E2E_SHOT) {
  const { writeFileSync } = await import('node:fs');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.E2E_SHOT, Buffer.from(shot.result?.data ?? '', 'base64'));
  console.log(`  (screenshot: ${process.env.E2E_SHOT})`);
}
await send('Emulation.clearDeviceMetricsOverride');

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
