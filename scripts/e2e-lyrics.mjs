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
// WHERE THE TAB IS. Chad, beta, 2026-11-26: "I think about and lyrics need to
// be tabs in the tracks area". An album track's list is the first tab of the
// one strip — TRACKS (19) · ABOUT · LYRICS — so section 1 asserts that one
// strip, section 3 where it sits on a phone (it was 1133px down at 390×844),
// and section 8 the two things a list that mounts with its tab can break: the
// playing row in view after LYRICS and back, and a LYRICS pick kept across ⏭.
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
//     "MoeFactz" (SRT, first cue at 0:00) and "Incogneetus" (no transcript),
//     both with notes; "Check Your Pockets" (row 16, SRT, notes); "Boostagrams"
//     (9, SRT, no notes), "How Bout You?" (10, nothing) and "To be in
//     Nashville" (11, SRT, no notes) for the kept pick.
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
/** When set, `/api/transcript` answers with this text instead of the file —
 *  section 7's untimed lyrics. */
let transcriptBody = null;
/** Four lines and a verse break, as a .txt lyrics file is written. */
const PLAIN_LYRICS = 'First line of the song\nSecond line of the song\n\nThe second verse starts here\nAnd ends here\n';
on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  if (/\/api\/transcript\?/.test(request.url)) {
    if (transcriptBody == null) { void send('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
    void send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      body: Buffer.from(transcriptBody).toString('base64'),
    }).catch(() => {});
    return;
  }
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
  // Passed through untouched, except in section 7.
  { urlPattern: '*/api/transcript?*', requestStage: 'Request' },
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
  // The album or playlist list and the strip it is the first tab of.
  const trackPanel = root.querySelector('[data-track-panel]');
  const ul = trackPanel?.querySelector('[role=tabpanel] > ul');
  const playing = ul?.querySelector('li[aria-current=true]');
  const u = ul?.getBoundingClientRect(), r = playing?.getBoundingClientRect();
  return {
    tabs,
    tablists: root.querySelectorAll('[role=tablist]').length,
    trackTabs: trackPanel ? [...trackPanel.querySelectorAll('[role=tab]')].map((b) => b.textContent.trim()) : null,
    selected: root.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? null,
    listTop: u ? Math.round(u.top + window.scrollY) : null,
    playingRow: r ? { index: [...ul.children].indexOf(playing), scrollTop: Math.round(ul.scrollTop), inView: r.top >= u.top - 1 && r.bottom <= u.bottom + 1 } : null,
    cover: (() => { const c = root.querySelector('[class*="aspect-square"]'); return c ? Math.round(c.getBoundingClientRect().width) : null; })(),
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

/** Section 1's list top, for section 2: a track with no lyrics must not move it. */
let listTopWithLyrics = null;

// ---------------------------------------------------------------------------
section('1. An album track with an SRT shows LYRICS, and the line follows the play head (desktop)');
// ---------------------------------------------------------------------------
await desktop();
await playAndExpand(`${APP}/?podcast=${ALBUM}`, 'MoeFactz', 'MoeFactz');
{
  const shown = await until(async () => (await panel()).tabs?.includes('Lyrics'), 20000);
  const p = await panel();
  t.ok('a tab named "Lyrics" (not "Transcript")', !!shown && !p.tabs.includes('Transcript'), JSON.stringify(p.tabs));
  t.equal('ONE strip in the tracks area: TRACKS (19) · ABOUT · LYRICS', JSON.stringify({ n: p.tablists, tabs: p.trackTabs }), JSON.stringify({ n: 1, tabs: ['Tracks (19)', 'About', 'Lyrics'] }));
  t.equal('it opens on the track list', p.selected, 'Tracks (19)');
  t.ok('the list shows, on the playing row', !!p.playingRow?.inView && p.playingRow.index === 0, JSON.stringify(p.playingRow));
  listTopWithLyrics = p.listTop;
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
  t.equal('the strip is TRACKS (19) · ABOUT', JSON.stringify(p.trackTabs), JSON.stringify(['Tracks (19)', 'About']));
  // The strip shows even with one tab, so a song with lyrics and one without
  // put the list at the same height (`showTabs` in <EpisodeInfoPanel>).
  t.ok('the list sits where it sat for a track with lyrics', p.listTop != null && p.listTop === listTopWithLyrics, JSON.stringify({ now: p.listTop, withLyrics: listTopWithLyrics }));
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
  // 1133px before the tabs moved into the tracks area; 754 after, measured.
  t.ok('…at the top of the tracks area, not under the list (it was 1133px)', !!p.lyricsBox && p.lyricsBox.top < 820, JSON.stringify(p.lyricsBox));
  // The cover's room below sm: is measured (the `30rem` reserve and the
  // cover-fit effect, docs/ui.md); the tabs take none of it. 350px at 390×844
  // before and after.
  t.ok('the cover keeps its size (350px)', p.cover != null && p.cover >= 345, String(p.cover));
  await press(`${FS_SELECTOR} [role=tab]`, /^Lyrics$/);
  await wait(800);
  const a = await panel();
  t.ok('lines render and one is highlighted', a.rows > 5 && !!a.active, JSON.stringify(a));
  t.ok('the phone page does not scroll sideways', (a.overflow ?? 1) <= 0, String(a.overflow));
}
await desktop();

// ---------------------------------------------------------------------------
section('4. A musicL playlist row reads its own lyrics');
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
  // A sanity check only: this row writes no <podcast:chapters>, so it cannot
  // show #647 coming back. The pin for that is check:musicl's wiring scan,
  // which asserts chapters still ask `readsEpisodeDocs`.
  t.ok('⏭ is enabled on a playlist row', !!next && !next.disabled, JSON.stringify(next));
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

// ---------------------------------------------------------------------------
section('7. An untimed lyrics file is plain text that keeps its line breaks');
// ---------------------------------------------------------------------------
// No live fixture: the seven text/html lyrics files the playlists name (RSS
// Blue .txt files) all answer 410 Gone on 2026-11-26. So MoeFactz's transcript
// is answered with a .txt-shaped body, which the SRT parser does not take.
transcriptBody = PLAIN_LYRICS;
await playAndExpand(`${APP}/?podcast=${ALBUM}`, 'MoeFactz with a plain-text file', 'MoeFactz');
{
  const shown = await until(async () => { const p = await panel(); return p.tabs?.includes('Lyrics') || p.labels?.includes('Lyrics'); }, 20000);
  t.ok('the Lyrics tab is there', !!shown, JSON.stringify(await panel()));
  await press(`${FS_SELECTOR} [role=tab]`, /^Lyrics$/);
  await wait(800);
  const text = await js(`document.querySelector(${JSON.stringify(FS_SELECTOR)})?.querySelector('[role=tabpanel] div.whitespace-pre-wrap')?.innerText ?? null`);
  t.equal('the lines and the verse break are as the file wrote them', text, PLAIN_LYRICS.trim());
}
transcriptBody = null;

// ---------------------------------------------------------------------------
section('8. The list keeps the playing row in view after LYRICS, and a LYRICS pick is kept across ⏭ (desktop)');
// ---------------------------------------------------------------------------
// The list mounts with its tab (<FollowList>), so the box that comes back after
// LYRICS is a new one. A hook keyed on the sheet alone never scrolled it, and
// row 16 came back out of sight at row 1.
await playAndExpand(`${APP}/?podcast=${ALBUM}`, 'Check Your Pockets', 'Check Your Pockets');
{
  const listed = await until(async () => { const p = await panel(); return p.playingRow?.inView ? p : null; }, 15000);
  t.ok('row 16 is in view in the list', !!listed && listed.playingRow.index === 15 && listed.playingRow.scrollTop > 0, JSON.stringify(listed?.playingRow ?? (await panel()).playingRow));
  await until(async () => (await panel()).tabs?.includes('Lyrics'), 20000);
  await press(`${FS_SELECTOR} [role=tab]`, /^Lyrics$/);
  await wait(600);
  t.equal('LYRICS shows', (await panel()).selected, 'Lyrics');
  await press(`${FS_SELECTOR} [role=tab]`, /^Tracks \(19\)$/);
  await wait(600);
  const back = await panel();
  t.ok('back on TRACKS, row 16 is in view again', !!back.playingRow?.inView && back.playingRow.index === 15 && back.playingRow.scrollTop > 0, JSON.stringify(back.playingRow));
}
await playAndExpand(`${APP}/?podcast=${ALBUM}`, 'Boostagrams', 'Boostagrams');
{
  const next = async () => press(`${FS_SELECTOR} button[aria-label^="Next"]`);
  const onTitle = (title) => until(() => js(`document.querySelector(${JSON.stringify(FS_SELECTOR)})?.querySelector('h1')?.textContent.trim() === ${JSON.stringify(title)}`), 20000);
  await until(async () => (await panel()).tabs?.includes('Lyrics'), 20000);
  const withLyrics = await panel();
  t.equal('Boostagrams (no notes): the strip is TRACKS (19) · LYRICS', JSON.stringify(withLyrics.trackTabs), JSON.stringify(['Tracks (19)', 'Lyrics']));
  await press(`${FS_SELECTOR} [role=tab]`, /^Lyrics$/);
  await wait(600);
  t.equal('Boostagrams: LYRICS picked', (await panel()).selected, 'Lyrics');
  t.ok('⏭ to "How Bout You?"', await next() && !!(await onTitle('How Bout You?')), '');
  await wait(3000);
  const none = await panel();
  t.ok('a song with no lyrics shows TRACKS, and no Lyrics tab', none.selected === 'Tracks (19)' && !none.tabs.includes('Lyrics'), JSON.stringify(none));
  // No notes and no lyrics: TRACKS is the only tab, and its strip still shows,
  // so the list does not move up 36px under the listener on this song.
  t.ok('…with TRACKS alone the strip stays and the list does not move', JSON.stringify(none.trackTabs) === JSON.stringify(['Tracks (19)']) && none.listTop != null && none.listTop === withLyrics.listTop, JSON.stringify({ tabs: none.trackTabs, now: none.listTop, before: withLyrics.listTop }));
  t.ok('⏭ to "To be in Nashville"', await next() && !!(await onTitle('To be in Nashville')), '');
  const kept = await until(async () => { const p = await panel(); return p.selected === 'Lyrics' ? p : null; }, 20000);
  t.ok('the next song with lyrics opens on LYRICS again: the pick is kept', !!kept && kept.rows > 5, JSON.stringify(kept ?? await panel()));
}

if (exceptions.length) t.fail('no uncaught exceptions in the page', exceptions.slice(0, 3).join(' | '));
else t.pass('no uncaught exceptions in the page');

console.log(`\n${t.fails ? `${t.fails} of ${t.count} checks FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
