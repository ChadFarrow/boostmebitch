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
const PODCAST_EPS = [0, 1].map((k) => ({
  itemGuid: guid('pep', k), feedGuid: SHOW_GUID, title: `Talk ${k}`, podcastTitle: 'E2E Show',
  medium: 'podcast', addedAt: 1700000000000 + k,
}));

// ---- the browser ----------------------------------------------------------
const { page } = await launchChrome({ name: 'shuffle', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

// What the shuffle asks, and how this run answers.
let batchMode = 'ok';            // 'ok' | '429' | 'slow'
let itemValueDelay = 0;          // ms before /api/item-value answers (section 8)
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
    await send('Fetch.continueRequest', { requestId });
  } catch {
    // The page navigated away under a paused request. Nothing to answer.
  }
});
await send('Page.enable');
await send('Runtime.enable');

// ---- helpers --------------------------------------------------------------
async function open({ items = SINGLES, cached = SINGLES.map((_, i) => i), queue = null, feeds = true } = {}) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  const now = Date.now();
  const seed = {
    'bmb:favorites:guest': JSON.stringify(feeds ? { [ALBUM_GUID]: ALBUM, [SHOW_GUID]: SHOW } : {}),
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
t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
