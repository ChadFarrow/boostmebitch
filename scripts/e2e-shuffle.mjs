// End-to-end for the favorites shuffle: ⤮ SHUFFLE on /favorites' SINGLES, and
// the shuffle list the player steps through (docs/ui.md, "The favorites shuffle").
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:shuffle                           # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:shuffle -- --headed --keep
//
// WHAT IT PINS:
//
//   1. SHUFFLE is on the music items section only, and only with two rows or more.
//   2b. With NOTHING cached — the usual phone — a favorite that stored its
//      enclosure still starts inside the press, with no request at all.
//   2. With every record cached the press sends no episode request and the first
//      track starts. The panel lists a permutation of the singles. ⏭ and ⏮ move
//      through it, a real `ended` advances, the last track stops, and ⏭ is off.
//      Each track asks ITS OWN feed who it pays.
//   3. An album opened mid-shuffle rewrites `episodeQueue`, and the next track is
//      still the shuffle's. A tap on that album's row ends the shuffle.
//   4. A single that is also in Up Next is not drained from Up Next.
//   5. A filter narrows the shuffle to the rows it shows.
//   6. A cold cache with the batch route refusing (429): the cached half plays,
//      no per-track GET is sent, and the skipped count shows. With a slow batch
//      the control is busy until it lands, and the late tracks join with no
//      duplicate, all after the track playing.
//   7. No horizontal overflow at 320, 390 and 1280. The control clears 24×24,
//      shows its whole word, and does not cover the heading's label.
//   8. ⏭ in the open now-playing screen does not move the shuffle list. Each
//      shuffled track starts with its value block unread, and the splits row
//      above the list unmounted until `/api/item-value` answered, so the list
//      jumped up 44px and back on every track (Chad, desktop, beta, 2026-11-13).
//   9. ⏮/⏭ walk PAST a track whose file is dead. The skip that passed it moved
//      only forward, so ⏮ from the track after it landed on it again, and the
//      skip carried the listener back to where they pressed from: the tracks
//      before it were out of reach (review of the merged #541/#545/#547). Here
//      the early check answers "alive", so the file joins the dead list only
//      through its own load error — the case a 403 or a bad format takes.
//  10. The list follows the playing row. A 230-track shuffle opened at row 1
//      with the playing row out of sight (Chad, desktop, beta, 2026-11-14:
//      "it is highlighted it just doesnt auto scroll"). With 40 singles: the
//      sheet opens with row 21 in the middle of the list's box, ⏭ on the open
//      sheet takes the list along, a list the listener scrolled away is left
//      alone until the track changes, and only the BOX scrolls — never the
//      sheet or the page. The album panel does the same for a 40-track album.
//  11. A shuffled single that is ALSO a track of the album opened on screen,
//      built from the favorite (so its id is not the album row's). While the
//      shuffle owns it the row is lit and the cover offers "Play album", which
//      starts the album at track 1. After a reload drops the shuffle, the row
//      is still lit, ⏭ is on, and the song's end continues the album (Chad,
//      desktop, 2026-11-14: `advance via=none` had stopped it).
//  12. ⤮ SHUFFLE on an album, opened by its `/?podcast=` URL (Chad, 2026-11-14:
//      "BMB needs album shuffles here"). It sits ahead of DOWNLOAD ALBUM, plays
//      the album's playable tracks in a random order through the shuffle's
//      list — never a row with no file — ⏭ walks the panel's order and stops
//      at the end, and the song playing before a press is always the new
//      shuffle's LAST track, so a press changes the song. The cover's ▶ still
//      plays the album in order and ends the shuffle. No overflow at 320, 390
//      and 1280; not offered on an album with one playable track, or a podcast.
//
// Signed out: no key, so nothing reaches a relay. The shuffle's own requests are
// answered here; anything else goes to the dev server untouched.
//
// NOT DRIVEN: iOS. The first track starts inside the press because iOS ties
// `play()` to the gesture; Chrome does not enforce that here (autoplay is on),
// so section 2 proves only the half Chrome can see — no request before the
// track starts. The gesture itself needs an iPhone.

import { checker, exit, launchChrome, MINI_BAR, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// ---- the audio ------------------------------------------------------------
// Thirty seconds of 8 kHz 8-bit silence, so a track never ends before the test
// asks it to (public/boost.mp3 is about a second). `ended` is still the
// browser's own: the test seeks to the last moment and lets it play out.
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

// ---- the fixture ----------------------------------------------------------
const guid = (prefix, i) => `${prefix}-${String(i).padStart(4, '0')}-4000-8000-000000000000`;
const N = 8;
const SINGLES = Array.from({ length: N }, (_, i) => ({
  itemGuid: guid('single', i),
  feedGuid: guid('sfeed', i),
  // Three share a word, for the filter section.
  title: i < 3 ? `Moon song ${i}` : `Single ${i}`,
  podcastTitle: `Album of ${i}`,
  medium: 'music',
  addedAt: 1700000000000 + i,
}));
const record = (i) => ({
  id: 5000 + i,
  guid: SINGLES[i].itemGuid,
  podcastGuid: SINGLES[i].feedGuid,
  feedTitle: SINGLES[i].podcastTitle,
  title: SINGLES[i].title,
  enclosureUrl: `${APP}/api/e2e-audio.wav?n=${i}`,
  // A cached record may carry a block; the shuffle must not keep it.
  value: { model: { type: 'lightning', method: 'keysend' }, recipients: [{ name: 'STALE', type: 'node', address: '02stale', split: 100 }] },
});
const nOf = (key) => SINGLES.findIndex((s) => s.itemGuid === key);
// What a phone usually holds: the favorite with the enclosure it was hearted
// with, and NO `bmb:epmeta` cell — nothing in the app writes one for a favorite
// it already knows, and the cells expire in 7 days.
const WITH_AUDIO = SINGLES.map((s, i) => ({ ...s, enclosureUrl: `${APP}/api/e2e-audio.wav?n=${i}` }));

const ALBUM_GUID = guid('album', 0);
const ALBUM_ID = 900001;
const ALBUM = { id: ALBUM_ID, podcastGuid: ALBUM_GUID, title: 'E2E Album', author: 'e2e', medium: 'music', addedAt: 1700000000000 };
const ALBUM_EPISODES = [0, 1, 2].map((k) => ({
  id: 7000 + k, guid: guid('atrack', k), podcastGuid: ALBUM_GUID, feedId: ALBUM_ID,
  title: `Album track ${k}`, enclosureUrl: `${APP}/api/e2e-audio.wav?album=${k}`, episode: k + 1,
  value: { model: { type: 'lightning', method: 'keysend' }, recipients: [{ name: 'album', type: 'node', address: '02album', split: 100 }] },
}));
const SHOW_GUID = guid('show', 0);
const SHOW = { id: 0, podcastGuid: SHOW_GUID, title: 'E2E Show', author: 'e2e', medium: 'podcast', addedAt: 1700000000000 };
// Section 10: lists longer than their `max-h-80` box. Eight rows fit in it, so
// the fixtures above never scroll.
const LONG = 40;
const MANY = Array.from({ length: LONG }, (_, i) => ({
  itemGuid: guid('many', i), feedGuid: guid('mfeed', i),
  title: `Long single ${i}`, podcastTitle: `Long album of ${i}`, medium: 'music',
  addedAt: 1700000000000 + i, enclosureUrl: `${APP}/api/e2e-audio.wav?n=${100 + i}`,
}));
const LONG_ALBUM_GUID = guid('album', 1);
const LONG_ALBUM_ID = 900002;
const LONG_ALBUM = { id: LONG_ALBUM_ID, podcastGuid: LONG_ALBUM_GUID, title: 'E2E Long Album', author: 'e2e', medium: 'music', addedAt: 1700000000000 };
const LONG_ALBUM_EPISODES = Array.from({ length: LONG }, (_, k) => ({
  id: 7100 + k, guid: guid('ltrack', k), podcastGuid: LONG_ALBUM_GUID, feedId: LONG_ALBUM_ID,
  title: `Long track ${k}`, enclosureUrl: `${APP}/api/e2e-audio.wav?long=${k}`, episode: k + 1,
  value: { model: { type: 'lightning', method: 'keysend' }, recipients: [{ name: 'album', type: 'node', address: '02album', split: 100 }] },
}));
const PODCAST_EPS = [0, 1].map((k) => ({
  itemGuid: guid('pep', k), feedGuid: SHOW_GUID, title: `Talk ${k}`, podcastTitle: 'E2E Show',
  medium: 'podcast', addedAt: 1700000000000 + k,
}));
// Section 12, opened by URL as `/?podcast=<guid>`: an album of six rows whose
// fifth has no file, an album with ONE playable row of two, and a podcast.
const feedFixture = (n, medium, title, rows, rowTitle, noFile = -1) => {
  const podcastGuid = guid('album', n);
  const id = 900000 + n;
  return {
    podcast: { id, podcastGuid, title, author: 'e2e', medium, addedAt: 1700000000000 },
    episodes: Array.from({ length: rows }, (_, k) => ({
      id: 7000 + n * 100 + k, guid: guid(`r${n}track`, k), podcastGuid, feedId: id,
      title: `${rowTitle} ${k}`, episode: k + 1,
      enclosureUrl: k === noFile ? '' : `${APP}/api/e2e-audio.wav?r${n}=${k}`,
      value: { model: { type: 'lightning', method: 'keysend' }, recipients: [{ name: 'album', type: 'node', address: '02album', split: 100 }] },
    })),
  };
};
const SHUF_ALBUM = feedFixture(12, 'music', 'E2E Shuffle Album', 6, 'Shuf track', 4);
const ONE_ALBUM = feedFixture(13, 'music', 'E2E One Track Album', 2, 'Lone track', 1);
const TALK_SHOW = feedFixture(14, 'podcast', 'E2E Talk Show', 3, 'Talk show ep');
const BY_URL = [SHUF_ALBUM, ONE_ALBUM, TALK_SHOW];

// ---- the browser ----------------------------------------------------------
const { page } = await launchChrome({ name: 'shuffle', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

// What the shuffle asks, and how this run answers.
let batchMode = 'ok';            // 'ok' | '429' | 'slow'
let itemValueDelay = 0;          // ms before /api/item-value answers (section 8)
let deadN = null;                // section 9: this single's file answers 410 Gone
let deadAsked = 0;               // …and how often the player asked for it
const seen = { get: 0, batch: 0, itemValue: [] };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const fulfillJson = (requestId, body, responseCode = 200) => send('Fetch.fulfillRequest', {
  requestId, responseCode,
  responseHeaders: [{ name: 'content-type', value: 'application/json' }],
  body: b64(body),
});

await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  const q = u.searchParams;
  try {
    // RANGES ARE ANSWERED, because the test seeks. With `accept-ranges: none`
    // Chrome reports `seekable` as [0, 0] and a seek lands on 0 — measured on
    // this file — so the track never reached its end and no `ended` fired.
    if (u.pathname === '/api/e2e-audio.wav' && deadN !== null && q.get('n') === String(deadN)) {
      deadAsked += 1;
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 410,
        responseHeaders: [{ name: 'content-type', value: 'text/plain;charset=UTF-8' }],
        body: Buffer.from('Gone').toString('base64'),
      });
      return;
    }
    // Section 9: the early check says every file is alive, so the dead one is
    // found only by its load error.
    if (u.pathname === '/api/audio-probe' && deadN !== null) {
      await fulfillJson(requestId, { status: 206 });
      return;
    }
    if (u.pathname === '/api/e2e-audio.wav') {
      const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
      const m = range && /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), AUDIO.length - 1) : AUDIO.length - 1;
      const body = AUDIO.subarray(start, end + 1);
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: m ? 206 : 200,
        responseHeaders: [
          { name: 'content-type', value: 'audio/wav' },
          { name: 'accept-ranges', value: 'bytes' },
          { name: 'content-length', value: String(body.length) },
          ...(m ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
        ],
        body: body.toString('base64'),
      });
      return;
    }
    if (u.pathname === '/api/episode-by-guid') {
      seen.get += 1;
      await fulfillJson(requestId, { error: 'not found' }, 404);
      return;
    }
    if (u.pathname === '/api/episode-by-guid/batch') {
      seen.batch += 1;
      if (batchMode === '429') { await fulfillJson(requestId, { error: 'rate limited' }, 429); return; }
      if (batchMode === 'slow') await wait(1500);
      const { refs } = JSON.parse(request.postData ?? '{"refs":[]}');
      const episodes = {};
      for (const r of refs) {
        const i = SINGLES.findIndex((s) => s.feedGuid === r.feedGuid && s.itemGuid === r.itemGuid);
        episodes[`${r.feedGuid}:${r.itemGuid}`] = i >= 0 ? record(i) : null;
      }
      await fulfillJson(requestId, { episodes });
      return;
    }
    if (u.pathname === '/api/item-value') {
      seen.itemValue.push({ itemGuid: q.get('itemGuid'), feedGuid: q.get('feedGuid'), feedId: q.get('feedId') });
      if (itemValueDelay) await wait(itemValueDelay);
      await fulfillJson(requestId, {
        read: true,
        value: { model: { type: 'lightning', method: 'keysend' }, recipients: [{ name: `artist ${q.get('itemGuid')}`, type: 'node', address: '02artist', split: 100 }] },
      });
      return;
    }
    if (u.pathname === '/api/feed' && q.get('id') === String(ALBUM_ID)) {
      await fulfillJson(requestId, { podcast: { ...ALBUM, url: 'https://feeds.example.invalid/album.xml' }, episodes: ALBUM_EPISODES });
      return;
    }
    if (u.pathname === '/api/by-guid' && q.get('guid') === ALBUM_GUID) {
      await fulfillJson(requestId, { podcast: ALBUM });
      return;
    }
    if (u.pathname === '/api/feed' && q.get('id') === String(LONG_ALBUM_ID)) {
      await fulfillJson(requestId, { podcast: { ...LONG_ALBUM, url: 'https://feeds.example.invalid/long-album.xml' }, episodes: LONG_ALBUM_EPISODES });
      return;
    }
    if (u.pathname === '/api/by-guid' && q.get('guid') === LONG_ALBUM_GUID) {
      await fulfillJson(requestId, { podcast: LONG_ALBUM });
      return;
    }
    const byUrl = u.pathname === '/api/feed' ? BY_URL.find((f) => String(f.podcast.id) === q.get('id'))
      : u.pathname === '/api/by-guid' ? BY_URL.find((f) => f.podcast.podcastGuid === q.get('guid'))
      : null;
    if (byUrl) {
      await fulfillJson(requestId, u.pathname === '/api/feed'
        ? { podcast: { ...byUrl.podcast, url: `https://feeds.example.invalid/${byUrl.podcast.id}.xml` }, episodes: byUrl.episodes }
        : { podcast: byUrl.podcast });
      return;
    }
    await send('Fetch.continueRequest', { requestId });
  } catch {
    // The page navigated away under a paused request. Nothing to answer.
  }
});
await send('Page.enable');
await send('Runtime.enable');

// ---- helpers --------------------------------------------------------------
async function open({ items = SINGLES, cached = SINGLES.map((_, i) => i), queue = null, feeds = true, longAlbum = false } = {}) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  const now = Date.now();
  const seed = {
    'bmb:favorites:guest': JSON.stringify({
      ...(feeds ? { [ALBUM_GUID]: ALBUM, [SHOW_GUID]: SHOW } : {}),
      ...(longAlbum ? { [LONG_ALBUM_GUID]: LONG_ALBUM } : {}),
    }),
    'bmb:favepisodes:guest': JSON.stringify(Object.fromEntries([...items, ...PODCAST_EPS].map((e) => [e.itemGuid, e]))),
  };
  for (const i of cached) {
    seed[`bmb:epmeta:${SINGLES[i].feedGuid}:${SINGLES[i].itemGuid}`] = JSON.stringify({ t: now, v: record(i) });
  }
  if (queue) seed['bmb:listen_queue:guest'] = JSON.stringify(queue);
  await js(`(() => { localStorage.clear(); const s = ${JSON.stringify(seed)};
    for (const k in s) localStorage.setItem(k, s[k]); return true; })()`);
  await send('Page.navigate', { url: `${APP}/favorites` });
  await until('document.readyState === "complete"');
  await until(`!!document.querySelector('[aria-label="Filter favorites"]')`);
  await wait(1800);
}

const SHUFFLE_BTN = `document.querySelector('section button[data-shuffle]')`;
const shuffleButtons = () => js(`document.querySelectorAll('section button[data-shuffle]').length`);
const pressShuffle = () => js(`(() => { const b = ${SHUFFLE_BTN}; if (!b) return false; b.click(); return true; })()`);
const src = () => js(`document.querySelector('audio')?.currentSrc ?? ''`);
const srcN = async () => { const m = (await src()).match(/[?&]n(?:=|%3D)(\d+)/); return m ? Number(m[1]) : null; };
const paused = () => js(`document.querySelector('audio')?.paused ?? null`);
const waitSrc = (pred, ms = 8000) => until(`(() => { const s = document.querySelector('audio')?.currentSrc ?? ''; return (${pred.toString()})(s); })()`, ms);
const miniNext = () => js(`(() => { const b = [...document.querySelectorAll('${MINI_BAR} button')].find((x) => /^Next/.test(x.getAttribute('aria-label') ?? '')); return b ? { label: b.getAttribute('aria-label'), disabled: b.disabled } : null; })()`);
const miniPrev = () => js(`(() => { const b = [...document.querySelectorAll('${MINI_BAR} button')].find((x) => /^Previous/.test(x.getAttribute('aria-label') ?? '')); return b ? { label: b.getAttribute('aria-label'), disabled: b.disabled } : null; })()`);
const pressMini = (re) => js(`(() => { const b = [...document.querySelectorAll('${MINI_BAR} button')].find((x) => ${re}.test(x.getAttribute('aria-label') ?? '')); if (!b || b.disabled) return false; b.click(); return true; })()`);
async function panel() {
  await js(`document.querySelector('[aria-label^="Open fullscreen player"]')?.click()`);
  await until(`!!document.querySelector('[aria-label="Close fullscreen player"]')`, 5000);
  await wait(300);
  const r = JSON.parse(await js(`JSON.stringify((() => {
    const p = document.querySelector('[data-shuffle-panel]');
    if (!p) return { present: false, album: !!document.body.textContent.match(/Album · \\d+ tracks/) };
    return {
      present: true,
      heading: p.querySelector('p')?.textContent.trim().toLowerCase(),
      keys: [...p.querySelectorAll('li')].map((li) => li.dataset.key),
      active: p.querySelector('li[aria-current="true"]')?.dataset.key ?? null,
    };
  })())`));
  await js(`document.querySelector('[aria-label="Close fullscreen player"]')?.click()`);
  await wait(300);
  return r;
}
async function endTrack() {
  await until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && isFinite(a.duration); })()`, 8000);
  await js(`(() => { const a = document.querySelector('audio'); a.currentTime = Math.max(0, a.duration - 0.3); if (a.paused) a.play(); return true; })()`);
}

// ---------------------------------------------------------------------------
console.log('\n1. Where SHUFFLE is offered');
await open();
t.equal('one SHUFFLE under all: on SINGLES, not on albums, shows or episodes', await shuffleButtons(), 1);
t.ok('it sits in the singles section',
  await js(`${SHUFFLE_BTN}?.closest('section')?.querySelector('button[aria-expanded]')?.textContent.trim().toLowerCase().startsWith('singles')`));
await js(`[...document.querySelectorAll('[role="group"][aria-label="Go to section"] button')].find((b) => b.textContent.trim().toLowerCase() === 'singles')?.click()`);
await wait(400);
t.equal('the SINGLES quick button keeps it', await shuffleButtons(), 1);
await open({ items: [SINGLES[0]], cached: [0] });
t.equal('one single is no shuffle', await shuffleButtons(), 0);

// ---------------------------------------------------------------------------
console.log('\n2. A shuffle from a warm cache');
await open();
seen.get = 0; seen.batch = 0; seen.itemValue = [];
t.ok('the press lands', await pressShuffle());
t.ok('a single starts', await waitSrc((s) => /[?&]n(=|%3D)\d+/.test(s)));
t.equal('no episode request: every record was cached', { get: seen.get, batch: seen.batch }, { get: 0, batch: 0 });
await until(`!(document.querySelector('audio')?.paused ?? true)`, 5000);
t.equal('it plays', await paused(), false);
let p = await panel();
t.ok('the now-playing screen lists the shuffle, not an album', p.present && /^shuffle · 8 tracks$/.test(p.heading ?? ''), JSON.stringify(p));
const order = p.keys ?? [];
t.equal('the shuffle is every single, once', order.slice().sort(), SINGLES.map((s) => s.itemGuid).sort());
t.equal('the first row is what plays', nOf(order[0]), await srcN());
t.equal('the active row is the first', p.active, order[0]);
await wait(500);
const asked = seen.itemValue.find((r) => r.itemGuid === order[0]);
t.ok('the payee is asked of the track\'s OWN feed', asked && asked.feedGuid === SINGLES[nOf(order[0])].feedGuid, JSON.stringify(seen.itemValue));
t.equal('⏭ is the shuffle\'s', (await miniNext())?.label, 'Next in shuffle');
t.equal('⏮ is off on the first track', (await miniPrev())?.disabled, true);
await pressMini('/^Next/');
t.ok('⏭ goes to the second row', await waitSrc(new Function('s', `return /[?&]n(=|%3D)${nOf(order[1])}(\\D|$)/.test(s)`)));
await pressMini('/^Previous/');
t.ok('⏮ goes back to the first', await waitSrc(new Function('s', `return /[?&]n(=|%3D)${nOf(order[0])}(\\D|$)/.test(s)`)));
await endTrack();
t.ok('a real `ended` advances to the second row', await waitSrc(new Function('s', `return /[?&]n(=|%3D)${nOf(order[1])}(\\D|$)/.test(s)`), 10000));
for (let i = 2; i < N; i++) { await pressMini('/^Next/'); await wait(250); }
t.ok('⏭ reaches the last row', await waitSrc(new Function('s', `return /[?&]n(=|%3D)${nOf(order[N - 1])}(\\D|$)/.test(s)`)));
t.equal('⏭ is off on the last row', (await miniNext())?.disabled, true);
await endTrack();
t.ok('the last track ends and playback stops', await until(`document.querySelector('audio')?.paused === true`, 10000));
t.equal('…on the last track, not on an album', await srcN(), nOf(order[N - 1]));

// ---------------------------------------------------------------------------
console.log('\n2b. Nothing cached: the favorite plays from its own enclosure');
await open({ items: WITH_AUDIO, cached: [] });
seen.get = 0; seen.batch = 0;
t.ok('the press lands', await pressShuffle());
t.ok('a single starts', await waitSrc((s) => /[?&]n(=|%3D)\d+/.test(s)));
t.equal('…with no episode request of any kind', { get: seen.get, batch: seen.batch }, { get: 0, batch: 0 });
t.equal('the control is not left busy', await js(`${SHUFFLE_BTN}?.disabled`), false);
p = await panel();
t.equal('all eight are in the shuffle', (p.keys ?? []).slice().sort(), SINGLES.map((s) => s.itemGuid).sort());
await pressMini('/^Next/');
const n2b = nOf(p.keys?.[1]);
t.ok('⏭ loads the next track\'s audio (a per-item id, so the source reloads)',
  await waitSrc(new Function('s', `return /[?&]n(=|%3D)${n2b}(\\D|$)/.test(s)`)));

// ---------------------------------------------------------------------------
console.log('\n3. An album opened mid-shuffle');
await open();
await pressShuffle();
await waitSrc((s) => /[?&]n(=|%3D)\d+/.test(s));
p = await panel();
const order3 = p.keys ?? [];
await js(`(() => { const li = [...document.querySelectorAll('section ul > li')].find((x) => x.textContent.includes('E2E Album'));
  (li?.querySelector('button') ?? li)?.click(); return !!li; })()`);
t.ok('the album opens and lists its tracks', await until(`document.body.textContent.includes('Album track 2')`, 10000));
await wait(500);
await endTrack();
t.ok('a track ending goes to the shuffle\'s next, not to the album',
  await waitSrc(new Function('s', `return /[?&]n(=|%3D)${nOf(order3[1])}(\\D|$)/.test(s)`), 10000), await src());
// The <li> is the row's tap area (episode-list.tsx, `openRow`), as e2e:playlist taps it.
await js(`(() => { const li = [...document.querySelectorAll('ul > li')].find((x) => x.textContent.includes('Album track 1'));
  li?.click(); return !!li; })()`);
t.ok('a tap on an album row plays it', await waitSrc((s) => /album(=|%3D)1/.test(s)));
t.ok('…and ends the shuffle: ⏭ is no longer the shuffle\'s', (await miniNext())?.label !== 'Next in shuffle', JSON.stringify(await miniNext()));
p = await panel();
t.ok('…and the now-playing screen shows the album again', !p.present && p.album, JSON.stringify(p));

// ---------------------------------------------------------------------------
console.log('\n4. A single that is also in Up Next');
const QUEUED = 5;
const queue = [
  { episode: { ...record(QUEUED), value: undefined }, podcast: { id: 0, podcastGuid: SINGLES[QUEUED].feedGuid, title: SINGLES[QUEUED].podcastTitle, medium: 'music' } },
  { episode: { id: 9100, guid: guid('qtalk', 0), title: 'Queued talk', enclosureUrl: `${APP}/api/e2e-audio.wav?q=0` }, podcast: { id: 0, title: 'E2E Show', medium: 'podcast' } },
];
await open({ queue });
const queueBefore = await js(`localStorage.getItem('bmb:listen_queue:guest')`);
await pressShuffle();
await waitSrc((s) => /[?&]n(=|%3D)\d+/.test(s));
for (let i = 1; i < N; i++) { await pressMini('/^Next/'); await wait(300); }
t.equal('the shuffle reached its last row', await srcN(), nOf((await panel()).keys?.[N - 1]));
t.equal('Up Next is byte-identical after passing the queued single', await js(`localStorage.getItem('bmb:listen_queue:guest')`), queueBefore);

// ---------------------------------------------------------------------------
console.log('\n5. A filter narrows the shuffle');
await open();
await js(`(() => { const el = document.querySelector('[aria-label="Filter favorites"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'moon');
  el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await wait(500);
await pressShuffle();
await waitSrc((s) => /[?&]n(=|%3D)\d+/.test(s));
p = await panel();
t.equal('only the three rows the filter shows', (p.keys ?? []).slice().sort(), [0, 1, 2].map((i) => SINGLES[i].itemGuid).sort());

// ---------------------------------------------------------------------------
console.log('\n6. A cold cache');
batchMode = '429';
// Nothing cached and no enclosure stored: nothing can start, and the batch
// fails. The list is not unplayable — the lookup failed — and the note says so.
await open({ cached: [] });
seen.get = 0; seen.batch = 0;
await pressShuffle();
t.ok('a failed lookup is not called an unplayable list',
  await until(`/8 tracks could not be loaded/i.test(document.querySelector('[data-shuffle-note]')?.textContent ?? '')`, 8000),
  await js(`document.querySelector('[data-shuffle-note]')?.textContent ?? '(no note)'`));
t.equal('…and no GET per track', seen.get, 0);

await open({ cached: [0, 1, 2, 3] });
seen.get = 0; seen.batch = 0;
await pressShuffle();
t.ok('a cached single starts while the rest are asked for', await waitSrc((s) => /[?&]n(=|%3D)[0-3](\D|$)/.test(s)));
t.ok('the note says how many could not load',
  await until(`/4 tracks could not be loaded/i.test(document.querySelector('[data-shuffle-note]')?.textContent ?? '')`, 8000),
  await js(`document.querySelector('[data-shuffle-note]')?.textContent ?? '(no note)'`));
t.ok('the misses went to the batch door', seen.batch >= 1, JSON.stringify(seen));
t.equal('…and never one GET per track', seen.get, 0);
p = await panel();
t.equal('the shuffle holds the four that loaded', (p.keys ?? []).length, 4);

batchMode = 'slow';
await open({ cached: [0, 1, 2, 3] });
seen.get = 0; seen.batch = 0;
await pressShuffle();
await waitSrc((s) => /[?&]n(=|%3D)[0-3](\D|$)/.test(s));
const busy = await js(`(() => { const b = ${SHUFFLE_BTN}; return b ? { disabled: b.disabled, text: b.textContent.trim().toLowerCase() } : null; })()`);
t.ok('while the rest load the control is busy and refuses a second press', busy?.disabled && /shuffling/.test(busy.text), JSON.stringify(busy));
t.ok('it comes back when they land', await until(`(() => { const b = ${SHUFFLE_BTN}; return !!b && !b.disabled; })()`, 8000));
const playingNow = await srcN();
p = await panel();
const keys6 = p.keys ?? [];
t.equal('all eight, no duplicate', [...new Set(keys6)].length, 8);
t.equal('…every single once', keys6.slice().sort(), SINGLES.map((s) => s.itemGuid).sort());
const at = keys6.indexOf(SINGLES[playingNow]?.itemGuid);
t.ok('the late four all come after the track playing', [4, 5, 6, 7].every((i) => keys6.indexOf(SINGLES[i].itemGuid) > at), JSON.stringify({ at, keys6 }));
t.equal('…and no GET per track', seen.get, 0);
batchMode = 'ok';

// ---------------------------------------------------------------------------
console.log('\n7. Layout');
await open();
for (const [name, width, mobile] of [['320', 320, true], ['390', 390, true], ['1280', 1280, false]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await wait(400);
  const m = JSON.parse(await js(`JSON.stringify((() => {
    const b = ${SHUFFLE_BTN};
    const label = b?.closest('section')?.querySelector('button[aria-expanded] > span');
    const r = b?.getBoundingClientRect(); const l = label?.getBoundingClientRect();
    return {
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      w: r && Math.round(r.width), h: r && Math.round(r.height),
      clip: b ? b.scrollWidth > b.clientWidth : null,
      gap: r && l ? Math.round(r.left - l.right) : null,
    };
  })())`));
  t.equal(`${name}: no horizontal overflow`, m.sw, m.cw);
  t.ok(`${name}: SHUFFLE is at least 24×24`, m.w >= 24 && m.h >= 24, JSON.stringify(m));
  t.ok(`${name}: its word is whole`, m.clip === false, JSON.stringify(m));
  t.ok(`${name}: it does not cover the heading's label`, m.gap !== null && m.gap >= 0, JSON.stringify(m));
}
await send('Emulation.clearDeviceMetricsOverride');

// ---------------------------------------------------------------------------
console.log('\n8. ⏭ on the now-playing screen does not move the shuffle list');
// At desktop size the list sits in the pinned header right under the splits row
// (Chad's screenshot, 1920 wide); at phone size the same component is one
// scroll. The answer is held so the window between the press and the value
// block is long enough to see, and the placeholder must be SEEN in it, or the
// check could pass because the answer simply came back too fast.
const SPLITS_ROW = `[...document.querySelectorAll('button[aria-expanded]')].find((b) => /^Splits to /.test(b.textContent.trim()))`;
const listTop = `Math.round(document.querySelector('[data-shuffle-panel]').getBoundingClientRect().top)`;
for (const [name, width, height, mobile] of [['1440', 1440, 900, false], ['390', 390, 844, true]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await open();
  await pressShuffle();
  await waitSrc((s) => /[?&]n(=|%3D)\d+/.test(s));
  await js(`document.querySelector('[aria-label^="Open fullscreen player"]')?.click()`);
  await until(`!!document.querySelector('[data-shuffle-panel]')`, 5000);
  t.ok(`${name}: the first track's splits row is up`, await until(`!!${SPLITS_ROW}`, 5000));
  // The overlay slides up when it opens; sampling during that measured the
  // slide (1176 → 306), not the list. Wait until the list holds still.
  for (let last = null, i = 0; i < 40; i++) {
    const now = await js(listTop);
    if (now === last) break;
    last = now; await wait(150);
  }
  itemValueDelay = 1200;
  await js(`(() => {
    const s = window.__panelTops = []; window.__sawPending = false; window.__sampling = true;
    const tick = () => {
      const el = document.querySelector('[data-shuffle-panel]');
      if (el) s.push(Math.round(el.getBoundingClientRect().top));
      if (document.querySelector('[data-splits-pending]')?.textContent.includes('Checking splits')) window.__sawPending = true;
      if (window.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick); return true; })()`);
  // The now-playing screen's own ⏭: the "Next in shuffle" button nearest the
  // list, not the mini bar's (which is mounted under the overlay too).
  const pressedNext = await js(`(() => {
    let box = document.querySelector('[data-shuffle-panel]'), b = null;
    while (box && !b) { box = box.parentElement; b = box?.querySelector('button[aria-label="Next in shuffle"]'); }
    if (!b || b.disabled) return false; b.click(); return true; })()`);
  t.ok(`${name}: ⏭ on the now-playing screen lands`, pressedNext);
  await wait(1800);
  const r = JSON.parse(await js(`(() => { window.__sampling = false;
    return JSON.stringify({ tops: window.__panelTops, sawPending: window.__sawPending }); })()`));
  itemValueDelay = 0;
  t.ok(`${name}: the row said "Checking splits…" while the block loaded`, r.sawPending);
  t.ok(`${name}: the splits row is back for the new track`, await until(`!!${SPLITS_ROW}`, 3000));
  const lo = Math.min(...r.tops), hi = Math.max(...r.tops);
  t.ok(`${name}: the shuffle list did not move while the value block loaded`,
    r.tops.length > 20 && hi - lo <= 1, JSON.stringify({ frames: r.tops.length, lo, hi, moves: [...new Set(r.tops)] }));
  await js(`document.querySelector('[aria-label="Close fullscreen player"]')?.click()`);
  await wait(300);
}
await send('Emulation.clearDeviceMetricsOverride');

// ---------------------------------------------------------------------------
console.log('\n9. ⏮/⏭ walk past a track whose file is dead');
{
  const onN = (n) => `/[?&]n(?:=|%3D)${n}(\\D|$)/.test(document.querySelector('audio')?.currentSrc ?? '')`;
  const playsN = (n, ms = 12000) => until(`(() => { const a = document.querySelector('audio');
    return !!a && !a.paused && a.currentTime > 0.2 && ${onN(n)}; })()`, ms);
  await open({ items: SINGLES.slice(0, 3), cached: [0, 1, 2] });
  t.ok('SHUFFLE starts', await pressShuffle());
  const order = (await panel()).keys.map(nOf);
  t.equal('three tracks in the shuffle', order.length, 3);
  // The order is random; the MIDDLE one is made dead, after the press, so a
  // track sits on each side of it.
  deadN = order[1];
  deadAsked = 0;
  t.ok('the first track plays', await playsN(order[0]));
  await endTrack();
  t.ok('…the dead second one is passed over and the third plays', await playsN(order[2]), `on n=${await srcN()}`);
  const asked = deadAsked;
  t.ok('…after the player tried the dead file once', asked >= 1, `asked ${asked}`);
  t.equal('⏮ is enabled', (await miniPrev())?.disabled, false);
  await pressMini('/^Previous/');
  t.ok('⏮ lands on the FIRST track, past the dead one', await playsN(order[0]), `on n=${await srcN()}`);
  await wait(1500);
  t.equal('…and stays there: no skip carried it forward again', await srcN(), order[0]);
  t.equal('the player did not ask for the dead file again', deadAsked, asked);
  await pressMini('/^Next/');
  t.ok('⏭ walks past it too, to the third track', await playsN(order[2]), `on n=${await srcN()}`);
  t.equal('…still without asking for the dead file', deadAsked, asked);
  deadN = null;
}

// ---------------------------------------------------------------------------
console.log('\n10. The track list follows the playing row');
{
  const SHUFFLE_UL = `document.querySelector('[data-shuffle-panel] ul')`;
  const ALBUM_UL = `[...document.querySelectorAll('p')].find((p) => /^Album · ${LONG} tracks$/.test(p.textContent.trim()))?.parentElement.querySelector('ul')`;
  // Where the playing row sits in its list's box, and whether anything ABOVE
  // the box scrolled: the sheet's own scroll row on a phone, or the page. Every
  // ancestor up to the fixed sheet opened at 0 and nobody touched it here, so a
  // non-zero one is a scroll this feature caused (`scrollIntoView` does that).
  const listState = async (ul) => JSON.parse(await js(`JSON.stringify((() => {
    const ul = ${ul};
    if (!ul) return null;
    const li = ul.querySelector('li[aria-current="true"]');
    const moved = [];
    for (let el = ul.parentElement; el; el = el.parentElement) {
      if (el.scrollTop) moved.push(el.tagName.toLowerCase() + '=' + Math.round(el.scrollTop));
      if (getComputedStyle(el).position === 'fixed') break;
    }
    if (!li) return { index: -1, scrollTop: Math.round(ul.scrollTop), moved };
    const u = ul.getBoundingClientRect(), r = li.getBoundingClientRect();
    return {
      index: [...ul.children].indexOf(li),
      scrollTop: Math.round(ul.scrollTop),
      inView: r.top >= u.top - 1 && r.bottom <= u.bottom + 1,
      offCenter: Math.round(r.top + r.height / 2 - (u.top + u.height / 2)),
      moved,
    };
  })())`));
  // Smooth scrolls take a moment; poll until the row is centred (one row of
  // slack) rather than sleeping a guess.
  const centred = async (ul, index, ms = 4000) => {
    const end = Date.now() + ms;
    let s = await listState(ul);
    while (Date.now() < end && !(s && s.index === index && s.inView && Math.abs(s.offCenter) <= 20)) {
      await wait(100);
      s = await listState(ul);
    }
    return s;
  };
  const openSheet = async (ul) => {
    await js(`document.querySelector('[aria-label^="Open fullscreen player"]')?.click()`);
    await until(`!!(${ul})`, 5000);
    // The sheet slides up for 300 ms; let it come to rest.
    for (let last = null, i = 0; i < 40; i++) {
      const now = await js(`Math.round((${ul}).getBoundingClientRect().top)`);
      if (now === last) break;
      last = now; await wait(150);
    }
  };
  const closeSheet = async () => {
    await js(`document.querySelector('[aria-label="Close fullscreen player"]')?.click()`);
    await wait(400);
  };
  const sheetNext = () => js(`(() => {
    let box = document.querySelector('[data-shuffle-panel]'), b = null;
    while (box && !b) { box = box.parentElement; b = box?.querySelector('button[aria-label="Next in shuffle"]'); }
    if (!b || b.disabled) return false; b.click(); return true; })()`);

  for (const [name, width, height, mobile] of [['1440', 1440, 900, false], ['390', 390, 844, true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
    await open({ items: MANY, cached: [] });
    t.ok(`${name}: SHUFFLE starts`, await pressShuffle());
    await waitSrc((s) => /[?&]n(=|%3D)1\d\d(\D|$)/.test(s));
    // Twenty steps with the sheet CLOSED: the screenshot's case, where the
    // playing row was far down a list nobody had looked at yet.
    for (let i = 0; i < 20; i++) { await pressMini('/^Next/'); await wait(200); }
    await openSheet(SHUFFLE_UL);
    let s = await centred(SHUFFLE_UL, 20);
    t.ok(`${name}: the sheet opens with the playing row (21 of ${LONG}) in the middle of the list`,
      s?.index === 20 && s.inView && Math.abs(s.offCenter) <= 20, JSON.stringify(s));
    t.equal(`${name}: …by scrolling the list's box only — not the sheet, not the page`, s?.moved, []);

    for (const k of [21, 22]) {
      t.ok(`${name}: ⏭ on the open sheet lands (to row ${k + 1})`, await sheetNext());
      s = await centred(SHUFFLE_UL, k);
      t.ok(`${name}: …and the list follows it`, s?.index === k && s.inView && Math.abs(s.offCenter) <= 20, JSON.stringify(s));
    }
    t.equal(`${name}: still nothing above the box scrolled`, s?.moved, []);

    // The listener scrolls back to the top to read. The track keeps playing,
    // so the sheet re-renders on every `timeupdate` — none of which may pull
    // the list back. Only the next track does.
    await js(`(() => { const ul = ${SHUFFLE_UL}; ul.scrollTo({ top: 0, behavior: 'instant' }); return true; })()`);
    await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.3; })()`, 8000);
    const before = await js(`document.querySelector('audio').currentTime`);
    await wait(1500);
    s = await listState(SHUFFLE_UL);
    const after = await js(`document.querySelector('audio').currentTime`);
    t.ok(`${name}: a list the listener scrolled away stays where they put it while the track plays`,
      s?.scrollTop === 0 && after > before, JSON.stringify({ s, before, after }));
    t.ok(`${name}: ⏭ lands (to row 24)`, await sheetNext());
    s = await centred(SHUFFLE_UL, 23);
    t.ok(`${name}: …and the next track brings the list back to it`, s?.index === 23 && s.inView && Math.abs(s.offCenter) <= 20, JSON.stringify(s));
    // A SECOND open on the same page: the lists are mounted already, so this
    // is the other path in — the close resets the hook, the open catches up.
    await closeSheet();
    for (let i = 0; i < 5; i++) { await pressMini('/^Next/'); await wait(200); }
    await openSheet(SHUFFLE_UL);
    s = await centred(SHUFFLE_UL, 28);
    t.ok(`${name}: closed, five tracks on, opened again: row 29 is in the middle`,
      s?.index === 28 && s.inView && Math.abs(s.offCenter) <= 20, JSON.stringify(s));
    await closeSheet();

    // The album panel: the same list for a track feed, the same follow.
    await open({ items: MANY, cached: [], longAlbum: true });
    await js(`(() => { const li = [...document.querySelectorAll('section ul > li')].find((x) => x.textContent.includes('E2E Long Album'));
      (li?.querySelector('button') ?? li)?.click(); return !!li; })()`);
    t.ok(`${name}: the long album opens`, await until(`document.body.textContent.includes('Long track 39')`, 10000));
    await wait(500);
    await js(`(() => { const li = [...document.querySelectorAll('ul > li')].find((x) => /Long track 25(\\D|$)/.test(x.textContent));
      li?.click(); return !!li; })()`);
    t.ok(`${name}: a tap on track 26 plays it`, await waitSrc((s) => /long(=|%3D)25(\D|$)/.test(s)));
    await openSheet(ALBUM_UL);
    s = await centred(ALBUM_UL, 25);
    t.ok(`${name}: the album panel opens with track 26 of ${LONG} in the middle of the list`,
      s?.index === 25 && s.inView && Math.abs(s.offCenter) <= 20, JSON.stringify(s));
    t.equal(`${name}: …by scrolling the list's box only`, s?.moved, []);
    await closeSheet();
  }
  await send('Emulation.clearDeviceMetricsOverride');
}

// ---------------------------------------------------------------------------
console.log('\n11. A shuffled single that is also a track of the open album');
// Chad, desktop, 2026-11-14: the shuffle reached a song, he opened its album to
// play the album, and the cover's ▶ resumed the shuffle's song instead. After a
// reload had dropped the shuffle, ▶ played that one song and playback stopped —
// `advance via=none` in his playback log, with the album's next track one row
// below. The favorite is built from what it stored (nothing cached, the usual
// device), so its id is `-fnvHash(itemGuid)` while the album row carries the
// index's; and it stored no feed id, so only the feed GUID ties the two.
const ALBUM_SINGLE = {
  itemGuid: ALBUM_EPISODES[1].guid, feedGuid: ALBUM_GUID, title: 'Album track 1', podcastTitle: 'E2E Album',
  medium: 'music', addedAt: 1700000000100, enclosureUrl: `${APP}/api/e2e-audio.wav?album=1`,
};
const COVER = `[...document.querySelectorAll('header button.group')].find((b) => /^(Play album|Pause)$/.test(b.getAttribute('aria-label') ?? ''))`;
const cover = async () => JSON.parse(await js(`JSON.stringify((() => { const b = ${COVER};
  return b ? { label: b.getAttribute('aria-label'), glyph: b.lastElementChild?.textContent.trim() } : null; })())`));
const litRows = async () => JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('ul > li')]
  .filter((li) => li.classList.contains('bg-bolt/10')).map((li) => (li.textContent.match(/Album track \\d/) ?? ['?'])[0]))`));
const lastAdvance = () => js(`(JSON.parse(localStorage.getItem('bmb:plog:device') ?? '[]').filter((l) => / advance /.test(l)).pop() ?? '').replace(/^\\S+ /, '')`);
async function shuffleToAlbumSingle() {
  await open({ items: [ALBUM_SINGLE, WITH_AUDIO[0]], cached: [] });
  await pressShuffle();
  await waitSrc((s) => /([?&]n|album)(=|%3D)\d+/.test(s));
  if (!/album(=|%3D)1(\D|$)/.test(await src())) await pressMini('/^Next/');
  return waitSrc((s) => /album(=|%3D)1(\D|$)/.test(s));
}
async function openAlbum() {
  // The single's own row names the album too; the album's row has no track.
  await js(`(() => { const li = [...document.querySelectorAll('section ul > li')]
    .find((x) => x.textContent.includes('E2E Album') && !x.textContent.includes('Album track'));
    (li?.querySelector('button') ?? li)?.click(); return !!li; })()`);
  const ok = await until(`document.body.textContent.includes('Album track 2')`, 10000);
  await wait(500);
  return ok;
}

// A: the shuffle still runs.
t.ok('A: the shuffle reaches the album\'s song', await shuffleToAlbumSingle(), await src());
t.ok('A: the album opens', await openAlbum());
t.equal('A: the song\'s row is lit while the shuffle plays it', await litRows(), ['Album track 1']);
// The order is random: the song is the shuffle's first or its last track, and
// at the last the shuffle refuses the step rather than handing it to the album.
const nx = await miniNext();
t.ok('A: ⏭ stays the shuffle\'s — its next, or off at its end — never the album\'s',
  nx?.label === 'Next in shuffle' ? nx.disabled === false : nx?.disabled === true, JSON.stringify(nx));
console.log(`       (this run: ${nx?.label}, ${nx?.disabled ? 'off' : 'on'})`);
t.equal('A: the cover offers the album, not a pause', await cover(), { label: 'Play album', glyph: '▶' });
await js(`${COVER}?.click()`);
t.ok('A: ▶ starts the album at its first track', await waitSrc((s) => /album(=|%3D)0(\D|$)/.test(s)), await src());
t.ok('A: …and ends the shuffle', (await miniNext())?.label !== 'Next in shuffle', JSON.stringify(await miniNext()));
await until(`!(document.querySelector('audio')?.paused ?? true)`, 5000);
t.equal('A: the album owns it now, so the cover pauses', await cover(), { label: 'Pause', glyph: '❚❚' });
await endTrack();
t.ok('A: the album goes on to its second track', await waitSrc((s) => /album(=|%3D)1(\D|$)/.test(s), 10000), await src());
await js(`${COVER}?.click()`);
t.ok('A: ❚❚ on the cover pauses', await until(`document.querySelector('audio')?.paused === true`, 5000));

// B: a reload drops the shuffle and puts the song back on its own — Chad's log.
t.ok('B: the shuffle reaches the album\'s song', await shuffleToAlbumSingle(), await src());
await send('Page.reload');
await until('document.readyState === "complete"');
await until(`!!document.querySelector('[aria-label="Filter favorites"]')`);
t.ok('B: the reload puts the song back, paused',
  await waitSrc((s) => /album(=|%3D)1(\D|$)/.test(s)) && await paused() === true, JSON.stringify({ src: await src(), paused: await paused() }));
t.ok('B: the album opens', await openAlbum());
t.equal('B: the song\'s row is lit', await litRows(), ['Album track 1']);
t.equal('B: ⏭ is the album\'s and is on', await miniNext(), { label: 'Next track', disabled: false });
t.equal('B: no list owns the song, so the cover resumes it', await cover(), { label: 'Play album', glyph: '▶' });
await js(`${COVER}?.click()`);
await until(`!(document.querySelector('audio')?.paused ?? true)`, 5000);
t.ok('B: ▶ plays the song in the player', /album(=|%3D)1(\D|$)/.test(await src()) && await paused() === false, await src());
await endTrack();
t.ok('B: when it ends, the album goes on to the next track', await waitSrc((s) => /album(=|%3D)2(\D|$)/.test(s), 10000), await src());
t.equal('B: the playback log says the album moved it', await lastAdvance(), 'advance via=tracks');

// ---------------------------------------------------------------------------
console.log('\n12. ⤮ SHUFFLE on an album');
// Asked for on 2026-11-14 over an album page: "BMB needs album shuffles here".
// Opened by URL, as that link was. The album's fifth row (track 4) has no file.
async function openByUrl(fixture, text) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js('(() => { localStorage.clear(); sessionStorage.clear(); return true; })()');
  await send('Page.navigate', { url: `${APP}/?podcast=${fixture.podcast.podcastGuid}` });
  await until('document.readyState === "complete"');
  const ok = await until(`document.body.textContent.includes(${JSON.stringify(text)})`, 15000);
  await wait(600);
  return ok;
}
const ALBUM_SHUFFLE = `document.querySelector('button[data-album-shuffle]')`;
const albumShuffles = () => js(`document.querySelectorAll('button[data-album-shuffle]').length`);
const pressAlbumShuffle = () => js(`(() => { const b = ${ALBUM_SHUFFLE}; if (!b) return false; b.click(); return true; })()`);
const PLAYABLE = SHUF_ALBUM.episodes.filter((e) => e.enclosureUrl);
const kOf = (s) => { const m = s.match(/[?&]r12(?:=|%3D)(\d+)/); return m ? Number(m[1]) : null; };
const guidOfK = (k) => SHUF_ALBUM.episodes[k].guid;
const shufLit = async () => JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('ul > li')]
  .filter((li) => li.classList.contains('bg-bolt/10')).map((li) => (li.textContent.match(/Shuf track \\d/) ?? ['?'])[0]))`));
const tapRow = (title) => js(`(() => { const li = [...document.querySelectorAll('ul > li')]
  .find((x) => x.textContent.includes(${JSON.stringify(title)}));
  const b = li?.querySelector('button[aria-label="Play"]'); b?.click(); return !!b; })()`);

// A: where it is offered.
t.ok('A: the album opens from its URL', await openByUrl(SHUF_ALBUM, 'Shuf track 5'));
t.equal('A: one ⤮ SHUFFLE on the album', await albumShuffles(), 1);
t.equal('A: it names what it plays', await js(`${ALBUM_SHUFFLE}?.textContent.replace(/\\s+/g, ' ').trim()`),
  '⤮ SHUFFLE the 5 tracks of this album');
t.ok('A: it sits in the row over the list, ahead of DOWNLOAD ALBUM', await js(`(() => {
  const b = ${ALBUM_SHUFFLE};
  const dl = [...(b?.parentElement?.querySelectorAll('button') ?? [])].find((x) => /download/i.test(x.textContent));
  return !!dl && !!(b.compareDocumentPosition(dl) & Node.DOCUMENT_POSITION_FOLLOWING);
})()`));

// B: a press plays the album in a random order, through the shuffle's list.
t.ok('B: the press lands', await pressAlbumShuffle());
t.ok('B: a track of the album starts', await waitSrc((s) => /[?&]r12(=|%3D)\d+/.test(s)), await src());
const firstK = kOf(await src());
t.ok('B: never the row with no file', firstK !== 4 && firstK !== null, String(firstK));
await until(`!(document.querySelector('audio')?.paused ?? true)`, 5000);
t.equal('B: ⏭ is the shuffle\'s', await miniNext(), { label: 'Next in shuffle', disabled: false });
t.equal('B: the playing track\'s row is lit', await shufLit(), [`Shuf track ${firstK}`]);
t.equal('B: the cover offers the album in order, not a pause', await cover(), { label: 'Play album', glyph: '▶' });
const bPanel = await panel();
t.equal('B: the now-playing screen lists the shuffle', bPanel.heading, 'shuffle · 5 tracks');
t.equal('B: …every playable track once, and not the row with no file',
  [...(bPanel.keys ?? [])].sort(), PLAYABLE.map((e) => e.guid).sort());
t.equal('B: …with the playing track marked', bPanel.active, guidOfK(firstK));
const walked = [firstK];
for (let i = 0; i < PLAYABLE.length - 1; i += 1) {
  const before = await src();
  await pressMini('/^Next/');
  await waitSrc(new Function('s', `return s !== ${JSON.stringify(before)};`));
  walked.push(kOf(await src()));
}
t.equal('B: ⏭ walks the panel\'s order', walked.map(guidOfK), bPanel.keys);
t.equal('B: ⏭ reaches every playable track once', [...walked].sort(), [0, 1, 2, 3, 5]);
t.equal('B: at the last track ⏭ is off', (await miniNext())?.disabled, true);
await endTrack();
t.ok('B: the last track ending stops, and plays nothing more',
  await until(`document.querySelector('audio')?.paused === true`, 10000) && kOf(await src()) === walked.at(-1),
  await src());

// C: the song already playing goes last, so a press always changes the song.
t.ok('C: a row tap plays track 2 in order', await tapRow('Shuf track 2')
  && await waitSrc((s) => /[?&]r12(=|%3D)2(\D|$)/.test(s)), await src());
t.equal('C: …as the album, not the shuffle', (await miniNext())?.label, 'Next track');
let playingK = 2;
for (let round = 1; round <= 4; round += 1) {
  await pressAlbumShuffle();
  const was = playingK;
  const moved = await waitSrc(new Function('s', `return !/[?&]r12(=|%3D)${was}(\\D|$)/.test(s);`), 5000);
  playingK = kOf(await src());
  const p = await panel();
  t.ok(`C${round}: the press changes the song (was ${was}, now ${playingK})`, moved && playingK !== was, await src());
  t.equal(`C${round}: the song that was playing is the shuffle's last track`, p.keys?.at(-1), guidOfK(was));
  t.equal(`C${round}: a new press is a whole new shuffle`, p.heading, 'shuffle · 5 tracks');
}

// D: the cover still plays the album in order, and that ends the shuffle.
await js(`${COVER}?.click()`);
t.ok('D: ▶ on the cover starts the album at its first track', await waitSrc((s) => /[?&]r12(=|%3D)0(\D|$)/.test(s)), await src());
t.equal('D: …and the shuffle is over', (await miniNext())?.label, 'Next track');

// E: layout, at the widths a phone and a desktop give it.
for (const [name, width, mobile] of [['320', 320, true], ['390', 390, true], ['1280', 1280, false]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await wait(400);
  const m = JSON.parse(await js(`JSON.stringify((() => {
    const b = ${ALBUM_SHUFFLE};
    const r = b?.getBoundingClientRect();
    const peers = [...(b?.parentElement?.children ?? [])].filter((x) => x !== b).map((x) => x.getBoundingClientRect());
    const overlap = r ? peers.some((p) => p.width && r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom) : null;
    return {
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      w: r && Math.round(r.width), h: r && Math.round(r.height),
      clip: b ? b.scrollWidth > b.clientWidth : null, overlap,
    };
  })())`));
  t.equal(`E ${name}: no horizontal overflow`, m.sw, m.cw);
  t.ok(`E ${name}: SHUFFLE is at least 24×24`, m.w >= 24 && m.h >= 24, JSON.stringify(m));
  t.ok(`E ${name}: its word is whole`, m.clip === false, JSON.stringify(m));
  t.ok(`E ${name}: it covers no other control in its row`, m.overlap === false, JSON.stringify(m));
}
await send('Emulation.clearDeviceMetricsOverride');

// F: where it is NOT offered.
t.ok('F: an album with one playable track of two opens', await openByUrl(ONE_ALBUM, 'Lone track 1'));
t.equal('F: …and offers no shuffle', await albumShuffles(), 0);
t.ok('F: a podcast opens', await openByUrl(TALK_SHOW, 'Talk show ep 2'));
t.equal('F: …and offers no shuffle', await albumShuffles(), 0);

// ---------------------------------------------------------------------------
t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
