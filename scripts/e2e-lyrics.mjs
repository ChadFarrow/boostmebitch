// Drives a song's LYRICS in a real browser: an album track, a musicL playlist
// row, and a song inside a show, on desktop and under phone emulation.
//
// THE REQUEST. Chad, 2026-11-26: "can we show lyrics for music tracks on BMB?
// some tracks have transcripts like some of Heycitizens stuff for example". The
// HeyCitizen album "The Heycitizen Experience" writes an application/srt
// <podcast:transcript> on 13 of its 19 items, and Podcast Index carries the url
// on each episode record, so every surface that plays one had the url in hand.
// None fetched it: `transcriptSourceFor` asked the chapters gate, which says no
// to every track (`readsTranscript`, lib/util.ts, pinned by check:musicl).
//
// WHAT THIS PROVES THAT THE CHECK CANNOT. That the url reaches the player on
// each path, that the tab says "Lyrics", that the highlighted line follows the
// play head (and, inside a show, follows it on the SHOW's clock), and that a
// track with no transcript shows no Lyrics tab at all.
//
// THE AUDIO IS ANSWERED BY CDP, NOT BY THE HOSTS. `Fetch.enable` pauses every
// enclosure request and fulfils it with two minutes of 8 kHz silence (960 KB),
// so the clock moves without downloading an 8 MB song or a 265 MB episode. The
// pages, Podcast Index, the feeds and the transcript files are all real. What a
// headless run cannot show is the sync heard against the real song: the lines
// move with the position, and the position is silence.
//
// THE FIXTURES.
//   - The Heycitizen Experience, podcast:guid a2d2e313-9cbd-5169-b89c-ab07b33ecc33:
//     "MoeFactz" (SRT, first cue at 0:00) and "Incogneetus" (no transcript).
//   - The Homegrown Hits musicL playlist, podcast:guid 8aad8bd9-…, whose 11th
//     row is "The Wait Is Over" by Bowl After Bowl's DeMu (SRT). The playlist
//     page lists the first rows only, so the fixture is one near the top.
//   - Homegrown Hits episode 154, whose first <podcast:valueTimeSplit> plays
//     "To be in Nashville" at 30.761 s with no remoteStartTime, so its first
//     line sits at 38.7 s on the show's clock.
//   - Podcasting 2.0 episode 278 (SRT captions): a podcast still says
//     "Transcript".
//
//   npm run dev -- -p 3047          # or npm run build && npm start
//   APP_URL=http://127.0.0.1:3047 npm run e2e:lyrics    # add --headed to watch
import { checker, exit, launchChrome, requireApp, wait, MINI_BAR } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const ALBUM = 'a2d2e313-9cbd-5169-b89c-ab07b33ecc33';
const PLAYLIST = '8aad8bd9-0eac-4bfe-b290-6c73f7148155';
const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';
const HGH_154 = '8b8d4f2e-ecc7-4e03-b8eb-07d9ab733e81';
const PC20 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';
const PC20_278 = 'PC20-278';

/** Two minutes of 8 kHz, 8-bit, mono silence as a WAV, base64. */
function silentWav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n, 0x80);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  return buf.toString('base64');
}
const WAV = Buffer.from(silentWav(120), 'base64');

await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Start the app in another terminal.`);

const t = checker();
const section = (s) => console.log(`\n${s}`);
const { page } = await launchChrome({ name: 'lyrics', autoplay: true });
const { send, js, jsOrThrow, on } = page;

const exceptions = [];
const enclosures = [];
on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  enclosures.push(request.url);
  // Ranges are answered as a real host answers them, or the element cannot seek
  // and a `t=` link or a tapped line has nowhere to go.
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers?.Range ?? request.headers?.range ?? '');
  const from = range ? Number(range[1]) : 0;
  const to = range && range[2] ? Math.min(Number(range[2]), WAV.length - 1) : WAV.length - 1;
  const slice = WAV.subarray(from, to + 1);
  void send('Fetch.fulfillRequest', {
    requestId,
    responseCode: range ? 206 : 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'audio/wav' },
      { name: 'Content-Length', value: String(slice.length) },
      { name: 'Accept-Ranges', value: 'bytes' },
      ...(range ? [{ name: 'Content-Range', value: `bytes ${from}-${to}/${WAV.length}` }] : []),
      { name: 'Access-Control-Allow-Origin', value: '*' },
    ],
    body: slice.toString('base64'),
  }).catch(() => {});
});

await send('Page.enable');
await send('Runtime.enable');
// Every enclosure in these fixtures is an .mp3, some behind op3.dev.
await send('Fetch.enable', { patterns: [
  { urlPattern: '*.mp3*', requestStage: 'Request' },
  { urlPattern: '*op3.dev/*', requestStage: 'Request' },
] });

const desktop = () => send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
const phone = () => send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

/** A regex matching exactly `text`, every character literal. */
const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^$()|[\]{}\\]/g, (c) => `\\${c}`)}$`);

const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await wait(250); }
};

/** A real pointer press at the centre of the first element matching `selector`
 *  whose text matches `re` (or any text). */
const press = async (selector, re = null) => {
  const at = await js(`(() => {
    const re = ${re ? re.toString() : 'null'};
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((x) => (!re || re.test((x.textContent || '').trim())) && x.getBoundingClientRect().width > 0);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  })()`);
  if (!at) return false;
  await wait(400);
  // Measured AFTER the scroll has settled, so the press lands where the element is.
  const xy = await js(`(() => {
    const re = ${re ? re.toString() : 'null'};
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((x) => (!re || re.test((x.textContent || '').trim())) && x.getBoundingClientRect().width > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!xy) return false;
  const at2 = xy;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: at2.x, y: at2.y, button: 'left', clickCount: 1 });
  }
  return true;
};

/** A fresh visitor: no last-played item, no queue, nothing a reload restores.
 *  Without it a deep link's `t=` does not start (it only plays when nothing is
 *  current), and the previous section's track is what the player shows. */
const fresh = async () => {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await wait(1500);
  await send('Storage.clearDataForOrigin', { origin: new URL(APP).origin, storageTypes: 'all' });
};

/** The fullscreen player's root: the always-mounted sheet, open or not. */
const FS_SELECTOR = 'div.fixed.inset-x-0.top-0.z-50.flex-col.bg-ink';

/** What the fullscreen player's info panel shows, read as a person would. The
 *  player is always mounted, so everything is read inside its dialog. */
const panel = () => jsOrThrow(`(() => {
  const FS = ${JSON.stringify(FS_SELECTOR)};
  const root = document.querySelector(FS) ?? document;
  const tabs = [...root.querySelectorAll('[role=tab]')].map((b) => b.textContent.trim());
  const lyricsTab = [...root.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === 'Lyrics');
  const box = lyricsTab ? lyricsTab.getBoundingClientRect() : null;
  const labels = [...root.querySelectorAll('p')].map((p) => p.textContent.trim()).filter((s) => /^(Lyrics|Transcript)$/.test(s));
  const tabpanel = root.querySelector('[role=tabpanel]');
  const active = tabpanel?.querySelector('li[aria-current=true]');
  const search = root.querySelector('input[aria-label^="Search "]');
  const audio = document.querySelector('audio');
  return {
    tabs,
    labels,
    lyricsBox: box ? { w: Math.round(box.width), h: Math.round(box.height), top: Math.round(box.top + window.scrollY) } : null,
    rows: tabpanel ? tabpanel.querySelectorAll('li').length : 0,
    active: active ? active.textContent.trim() : null,
    search: search ? search.getAttribute('aria-label') : null,
    anyLyricsWord: /Lyrics|Loading lyrics/.test(root.textContent || ''),
    position: audio ? Math.round(audio.currentTime * 10) / 10 : null,
    paused: audio ? audio.paused : null,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`).then((v) => v ?? {}, () => ({}));

/** Start playback, by a deep link that plays or by opening a page and
 *  pressing the row titled `row`, then open the fullscreen player. */
const playAndExpand = async (url, label, row = null) => {
  await fresh();
  enclosures.length = 0;
  await send('Page.navigate', { url });
  if (row) {
    const listed = await until(() => js(`[...document.querySelectorAll('ul.divide-y > li div.font-display.font-medium')].some((d) => d.textContent.trim() === ${JSON.stringify(row)})`), 45000);
    t.ok(`${label}: the row is listed`, !!listed, '');
    await press('ul.divide-y > li div.font-display.font-medium', exactly(row));
  }
  const playing = await until(() => js(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0; })()`), 45000);
  t.ok(`${label}: playback started`, !!playing, JSON.stringify(await panel()));
  t.ok(`${label}: the enclosure came from CDP, not the host`, enclosures.length > 0, JSON.stringify(enclosures));
  await press(MINI_BAR);
  await wait(1200);
  return !!playing;
};

// ---------------------------------------------------------------------------
section('1. An album track with an SRT shows LYRICS, and the line follows the play head (desktop)');
// ---------------------------------------------------------------------------
await desktop();
await playAndExpand(`${APP}/?podcast=${ALBUM}`, 'MoeFactz', 'MoeFactz');
{
  const shown = await until(async () => (await panel()).tabs?.includes('Lyrics'), 20000);
  const p = await panel();
  t.ok('a tab named "Lyrics" (not "Transcript")', !!shown && !p.tabs.includes('Transcript'), JSON.stringify(p.tabs));
  await press(`${FS_SELECTOR} [role=tab]`, /^Lyrics$/);
  await wait(800);
  const a = await panel();
  t.ok('the lyrics list renders lines', a.rows > 5, JSON.stringify(a));
  t.equal('the search box says lyrics', a.search, 'Search lyrics');
  t.ok('a line is highlighted', !!a.active, JSON.stringify(a));
  const first = a.active;
  const moved = await until(async () => { const b = await panel(); return b.active && b.active !== first ? b : null; }, 15000);
  t.ok('the highlighted line moves on as the track plays', !!moved, JSON.stringify({ first, now: await panel() }));
  t.ok('the desktop page does not scroll sideways', (a.overflow ?? 1) <= 0, String(a.overflow));
}

// ---------------------------------------------------------------------------
section('2. A track with no transcript shows no Lyrics tab (desktop)');
// ---------------------------------------------------------------------------
await playAndExpand(`${APP}/?podcast=${ALBUM}`, 'Incogneetus', 'Incogneetus');
{
  // Long enough for a transcript fetch to have landed, had one been made.
  await wait(4000);
  const p = await panel();
  t.ok('no "Lyrics" tab, label or loading line anywhere in the player', !p.anyLyricsWord && !p.tabs.includes('Lyrics') && !p.labels.length, JSON.stringify(p));
}

// ---------------------------------------------------------------------------
section('3. The same album track under phone emulation (390×844)');
// ---------------------------------------------------------------------------
await phone();
await playAndExpand(`${APP}/?podcast=${ALBUM}`, 'MoeFactz on a phone', 'MoeFactz');
{
  const shown = await until(async () => (await panel()).tabs?.includes('Lyrics'), 20000);
  const p = await panel();
  t.ok('the Lyrics tab is there on a phone', !!shown, JSON.stringify(p.tabs));
  t.ok('the Lyrics tab is at least 24×24', !!p.lyricsBox && p.lyricsBox.w >= 24 && p.lyricsBox.h >= 24, JSON.stringify(p.lyricsBox));
  console.log(`  info  the Lyrics tab sits ${p.lyricsBox?.top ?? '?'}px down the player at 390×844`);
  await press(`${FS_SELECTOR} [role=tab]`, /^Lyrics$/);
  await wait(800);
  const a = await panel();
  t.ok('lines render and one is highlighted', a.rows > 5 && !!a.active, JSON.stringify(a));
  t.ok('the phone page does not scroll sideways', (a.overflow ?? 1) <= 0, String(a.overflow));
}
await desktop();

// ---------------------------------------------------------------------------
section('4. A musicL playlist row reads its own lyrics, and ⏭ stays the playlist\'s');
// ---------------------------------------------------------------------------
await playAndExpand(`${APP}/?playlist=${PLAYLIST}`, 'The Wait Is Over from the playlist', 'The Wait Is Over');
{
  const shown = await until(async () => (await panel()).tabs?.includes('Lyrics') || (await panel()).labels?.includes('Lyrics'), 20000);
  const p = await panel();
  t.ok('the playlist row shows Lyrics', !!shown, JSON.stringify(p));
  const next = await js(`(() => {
    const FS = ${JSON.stringify(FS_SELECTOR)};
    const root = document.querySelector(FS) ?? document;
    const b = [...root.querySelectorAll('button')].find((x) => /next/i.test(x.getAttribute('aria-label') || x.title || ''));
    return b ? { label: b.getAttribute('aria-label') || b.title, disabled: b.disabled } : null;
  })()`);
  t.ok('⏭ is enabled on a playlist row (no chapters took it over, #647)', !!next && !next.disabled, JSON.stringify(next));
}

// ---------------------------------------------------------------------------
section('5. A song inside a show: its lyrics on the SHOW\'s clock (HGH 154 at 0:31)');
// ---------------------------------------------------------------------------
await playAndExpand(`${APP}/?podcast=${HGH}&episode=${HGH_154}&t=31`, 'Homegrown Hits 154');
{
  // The window is 30.761–294.761 s and the first line is at 7.973 s of the
  // track, so 38.7 s of the show. Until then no line is lit.
  const shown = await until(async () => (await panel()).tabs?.includes('Lyrics'), 25000);
  const p = await panel();
  t.ok('a Lyrics tab beside the show\'s own tabs', !!shown, JSON.stringify(p.tabs));
  await press(`${FS_SELECTOR} [role=tab]`, /^Lyrics$/);
  await wait(600);
  const before = await panel();
  t.ok('the song is named over its lines', /To be in Nashville/.test(await js(`document.querySelector(${JSON.stringify(FS_SELECTOR)})?.querySelector('[role=tabpanel]')?.textContent || ''`) || ''), '');
  t.ok('before 38.7 s no line is lit', before.position < 38.5 ? !before.active : true, JSON.stringify(before));
  const lit = await until(async () => { const b = await panel(); return b.active ? b : null; }, 20000);
  t.ok('at 38.7 s the first line lights: "Early in the morning"', !!lit && /Early in the morning/.test(lit.active) && lit.position >= 38.5, JSON.stringify(lit));
  t.ok('…and its time reads on the show\'s clock (0:38)', !!lit && /^0:38/.test(lit.active), JSON.stringify(lit?.active));
  // A tap seeks the SHOW to that line: the third line is 12.145 s into the
  // track, so 42.9 s of the show.
  await press(`${FS_SELECTOR} [role=tabpanel] li button`, /On the interstate/);
  const sought = await until(async () => { const b = await panel(); return b.position >= 42.5 && b.position < 46 && /On the interstate/.test(b.active || '') ? b : null; }, 8000);
  t.ok('tapping "On the interstate" seeks the show to 0:42.9 and lights it', !!sought, JSON.stringify(await panel()));
}

// ---------------------------------------------------------------------------
section('6. A podcast episode\'s transcript is still called "Transcript"');
// ---------------------------------------------------------------------------
await playAndExpand(`${APP}/?podcast=${PC20}&episode=${PC20_278}&t=60`, 'Podcasting 2.0 episode 278');
{
  const shown = await until(async () => (await panel()).tabs?.includes('Transcript'), 25000);
  const p = await panel();
  t.ok('a tab named "Transcript", and none named "Lyrics"', !!shown && !p.tabs.includes('Lyrics'), JSON.stringify(p.tabs));
  await press(`${FS_SELECTOR} [role=tab]`, /^Transcript$/);
  await wait(800);
  t.equal('its search box says transcript', (await panel()).search, 'Search transcript');
}

if (exceptions.length) t.fail('no uncaught exceptions in the page', exceptions.slice(0, 3).join(' | '));
else t.pass('no uncaught exceptions in the page');

console.log(`\n${t.fails ? `${t.fails} of ${t.count} checks FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
