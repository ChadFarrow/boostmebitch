// Drives DOWNLOAD ALBUM in a real browser, against a real album, with the
// audio bytes answered locally.
//
// WHY THIS IS AN E2E AND NOT ONLY A `check:*`. `albumPlan` is pinned by
// `npm run check:downloads`: which tracks a press fetches and what it costs.
// Everything this script asserts is WIRING that no pure function can see —
// that the first press spends nothing, that the album-wide room check runs
// before a single request, that the queue still takes the tracks one at a time,
// that STOP keeps what finished, and that the control's number agrees with what
// actually lands in IndexedDB.
//
// THE REQUEST FOR IT. From an iPhone, on Tinderbox by Nate Johnivan: *"There
// should be an option to download an entire album."* Bulk download had been
// left out on purpose, because it "spends the listener's data without a screen
// in front of them" (docs/downloads.md). The control answers that reason with
// the total before the press and a confirmation, and those are what this checks.
//
// THE BYTES ARE ANSWERED BY CDP, NOT BY THE HOSTS. `Fetch.enable` pauses every
// enclosure request and fulfils it with 4 KB after a short delay. So the album
// page, Podcast Index, the feed and the app's own routes are all real, and the
// engine, the Cache API bucket and the IndexedDB records are the shipping ones —
// but the run costs 56 KB instead of the album's 43 MB, which matters for a
// feature whose whole point is that bandwidth is scarce. The delay is what makes
// "one at a time" measurable: a parallel queue would show several requests
// paused at once.
//
// THE ALBUM IS THE FIXTURE. Tinderbox (podcast:guid
// 537df90e-0cc4-535b-84d0-dcb3ca87f1f8): 14 tracks, 43,051,087 bytes, every
// size stated, on CloudFront and behind op3.dev. If it leaves Podcast Index,
// replace the constants with any `medium=music` album of a few tracks.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:album                   # add --headed to watch it
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const ALBUM_GUID = '537df90e-0cc4-535b-84d0-dcb3ca87f1f8';
const TRACKS = 14;
/** `fmtBytes(43,051,087)`. */
const ALBUM_SIZE = '43 MB';
/** The two hosts this album's enclosures live on. */
const ENCLOSURE = /d12wklypp119aj\.cloudfront\.net\/track\/|op3\.dev\/e,pg=537df90e/;
/** How long each fulfilment is held, so overlapping requests would be visible. */
const HOLD_MS = 400;
/** Four kilobytes of zeros, base64. Nothing reads it as audio. */
const BODY = Buffer.alloc(4096).toString('base64');

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

const t = checker();
const section = (s) => console.log(`\n${s}`);
const { page } = await launchChrome({ name: 'album' });
const { send, js, jsOrThrow, on } = page;

const exceptions = [];
const requests = [];      // every enclosure request, in the order it was paused
let inFlight = 0;
let maxInFlight = 0;
on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  if (!ENCLOSURE.test(request.url)) {
    void send('Fetch.continueRequest', { requestId }).catch(() => {});
    return;
  }
  requests.push(request.url);
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  setTimeout(() => {
    inFlight -= 1;
    void send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'audio/mpeg' },
        { name: 'Content-Length', value: '4096' },
        // The download reads with `mode: 'cors'`; these hosts do send this.
        { name: 'Access-Control-Allow-Origin', value: '*' },
      ],
      body: BODY,
    }).catch(() => {});
  }, HOLD_MS);
});

await send('Page.enable');
await send('Runtime.enable');
// A phone, where the row this control sits in has to wrap rather than overflow.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
// Only the two enclosure hosts are paused. The album's cover lives on the same
// CloudFront host under /img/, and the pattern leaves it alone.
await send('Fetch.enable', { patterns: [
  { urlPattern: '*d12wklypp119aj.cloudfront.net/track/*', requestStage: 'Request' },
  { urlPattern: '*op3.dev/e,pg=537df90e*', requestStage: 'Request' },
] });

/** The album control's state, read as a person would: its visible words.
 *  `{}` while the page is between documents, when there is nothing to read. */
const control = () => jsOrThrow(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const album = btns.find((b) => /DOWNLOAD (ALBUM|\\d+ MORE)/.test(b.textContent || ''));
  const text = (re) => { const el = [...document.querySelectorAll('span,p')].find((s) => re.test(s.textContent || '') && s.children.length < 4); return el ? el.textContent.trim() : null; };
  const box = album ? album.getBoundingClientRect() : null;
  return {
    button: album ? album.textContent.trim().replace(/\\s+/g, ' ') : null,
    label: album ? album.getAttribute('aria-label') : null,
    h: box ? Math.round(box.height * 10) / 10 : null,
    ask: text(/^Download (the )?\\d+ tracks?/),
    progress: text(/^↓?\\s*Album: \\d+ of \\d+ downloaded/),
    done: text(/All \\d+ tracks downloaded/),
    alert: [...document.querySelectorAll('[role=alert]')].map((a) => a.textContent.trim()).join(' | ') || null,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`).then((v) => v ?? {}, (e) => { if (!/context|navigat/i.test(String(e))) console.log(`  (control read failed: ${e.message})`); return {}; });
/** A real pointer press on the first button whose text matches. */
const press = async (re) => {
  const at = await js(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => ${re}.test((x.textContent || '').trim()));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!at) return false;
  await wait(300);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
  return true;
};
/** Records in the app's downloads database for this album, read by NAME. */
const stored = () => js(`new Promise((resolve) => {
  const req = indexedDB.open('BmbDownloadsDB');
  req.onerror = () => resolve(-1);
  req.onsuccess = () => {
    const db = req.result;
    if (![...db.objectStoreNames].includes('downloads')) { resolve(0); return; }
    const all = db.transaction('downloads', 'readonly').objectStore('downloads').getAll();
    all.onsuccess = () => resolve(all.result.filter((r) => r.feedGuid === '${ALBUM_GUID}').length);
    all.onerror = () => resolve(-1);
  };
})`);
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await wait(250); }
};
/**
 * Open the album page and wait for the control.
 *
 * STOPS THE RUN if the control never appears. Every later check needs this
 * page, so carrying on turns one slow or failed load into twenty-odd FAILs that
 * all look like feature faults. That happened once on 2026-09-22 — 26 of 39
 * failed on a first run, the next five passed, and the log kept was too short
 * to say why. This line is what the next one will say instead.
 */
const open = async () => {
  await send('Page.navigate', { url: `${APP}/?podcast=${ALBUM_GUID}` });
  const shown = await until(async () => (await control()).button, 45000);
  if (!shown) {
    const why = await js(`({ url: location.href, rows: document.querySelectorAll('ul.divide-y > li').length,
      text: document.body.innerText.slice(0, 300) })`);
    t.fail('the album page rendered DOWNLOAD ALBUM within 45 s', JSON.stringify(why));
    console.log(`\nStopped: every later section needs that page. ${t.fails} of ${t.count} checks FAILED.`);
    await exit(1);
  }
  return shown;
};

// ---------------------------------------------------------------------------
section('1. An album that cannot fit is refused WHOLE, before one request');
// ---------------------------------------------------------------------------
{
  // 90 MB of quota: every track fits on its own (7.8 MB + the 64 MB reserve),
  // the album does not (43 MB + 64 MB). So only the album-wide check can refuse
  // here — without it the per-track checks pass all fourteen, and a smaller
  // quota would download seven of twelve and then stop, having spent the data
  // and left no album.
  // `send` resolves with the whole CDP message, so the id is under `.result`.
  // Destructuring it off the top level yields undefined, the removal below then
  // removes nothing, and every later section runs on the 90 MB quota.
  const added = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `StorageManager.prototype.estimate = async () => ({ usage: 0, quota: 90 * 1024 * 1024 });`,
  });
  const identifier = added.result?.identifier;
  await open();
  await press('/DOWNLOAD ALBUM/');
  await wait(800);
  await press('/^DOWNLOAD$/');
  await wait(2500);
  const c = await control();
  t.ok('the refusal is a sentence that names the album and its size',
    !!c.alert && /Not enough space for this album \(43 MB\)/.test(c.alert), JSON.stringify(c));
  t.equal('...and not one enclosure was requested', requests.length, 0);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
}
{
  // Proved, not assumed: the sections below are only meaningful on the
  // browser's real quota.
  await open();
  const quota = await js(`navigator.storage.estimate().then((e) => e.quota)`);
  t.ok('the fake quota is gone before the album is downloaded for real', quota > 1024 * 1024 * 1024, `${quota} bytes`);
}

/** The track titles in the order the album page lists them — what a group on
 *  /downloads must reproduce once the whole album was downloaded. */
let albumOrder = [];

// ---------------------------------------------------------------------------
section('2. The first press spends nothing: it states the count and the size, and asks');
// ---------------------------------------------------------------------------
{
  const shown = await open();
  const c = await control();
  // The row title is the `font-display font-medium` line inside the episode
  // list's `divide-y` <ul>; nothing else on the page carries both.
  albumOrder = await js(`[...document.querySelectorAll('ul.divide-y > li div.font-display.font-medium')]
    .map((el) => el.textContent.trim())`);
  console.log(`  album page order: ${JSON.stringify(albumOrder)}`);
  console.log(`  control: ${JSON.stringify(c)}`);
  t.ok('an album offers DOWNLOAD ALBUM with its size before any press',
    !!shown && /DOWNLOAD ALBUM/.test(c.button) && c.button.includes(ALBUM_SIZE), c.button);
  t.ok('...and its accessible name says the whole of it',
    !!c.label && c.label.includes(`${TRACKS} tracks`) && c.label.includes(ALBUM_SIZE), c.label);
  t.ok('...at least 24px tall, which WCAG 2.5.8 asks of a control', c.h !== null && c.h >= 24, `${c.h}px`);
  t.ok('...and the row it joins does not widen a 390px page', c.overflow <= 0, `${c.overflow}px over`);

  await press('/DOWNLOAD ALBUM/');
  await wait(1200);
  const asked = await control();
  t.ok(`the press asks, naming ${TRACKS} tracks and ${ALBUM_SIZE}`,
    !!asked.ask && asked.ask.includes(`${TRACKS} tracks`) && asked.ask.includes(ALBUM_SIZE), JSON.stringify(asked));
  t.equal('...and has spent nothing', requests.length, 0);

  await press('/^CANCEL$/');
  await wait(800);
  const back = await control();
  t.ok('CANCEL puts the control back', !back.ask && /DOWNLOAD ALBUM/.test(back.button || ''), JSON.stringify(back));
  t.equal('...still having spent nothing', requests.length, 0);
}

// ---------------------------------------------------------------------------
section('3. STOP halts the album and KEEPS what finished');
// ---------------------------------------------------------------------------
let keptAfterStop = 0;
{
  await press('/DOWNLOAD ALBUM/');
  await wait(800);
  await press('/^DOWNLOAD$/');
  const progress = await until(async () => (await control()).progress, 8000);
  t.ok('while it runs the control counts tracks, not bytes', !!progress, String(progress));
  await until(async () => (await stored()) >= 3, 20000);
  await press('/^STOP$/');
  await wait(3000);
  keptAfterStop = await stored();
  const requestsAtStop = requests.length;
  await wait(3000);
  const c = await control();
  console.log(`  after STOP: ${keptAfterStop} kept, ${requests.length} requested, control ${JSON.stringify(c.button)}`);
  t.ok('the finished tracks stay on the device', keptAfterStop >= 3 && keptAfterStop < TRACKS, `${keptAfterStop} stored`);
  t.equal('...and no further track is requested once it stops', requests.length, requestsAtStop);
  t.ok('the control now offers the REST, by count and size',
    new RegExp(`DOWNLOAD ${TRACKS - keptAfterStop} MORE`).test(c.button || '') && /MB/.test(c.button || ''), c.button);
}

// ---------------------------------------------------------------------------
section('4. The rest downloads one track at a time, and the album ends complete');
// ---------------------------------------------------------------------------
{
  const before = requests.length;
  await press('/DOWNLOAD \\d+ MORE/');
  await wait(1000);
  const asked = await control();
  const rest = TRACKS - keptAfterStop;
  t.ok(`the question names only the ${rest} tracks not on this device`,
    !!asked.ask && asked.ask.includes(`the ${rest} tracks not on this device`), JSON.stringify(asked.ask));
  await press('/^DOWNLOAD$/');
  const n = await until(async () => ((await stored()) === TRACKS ? TRACKS : 0), 60000);
  t.equal(`all ${TRACKS} tracks are in the downloads database`, n || await stored(), TRACKS);
  // The track STOP interrupted is fetched again; nothing already stored is.
  const fetched = requests.length - before;
  t.ok('the second press fetched only what was missing', fetched >= rest && fetched <= rest + 1, `${fetched} requests for ${rest} tracks`);
  t.equal('never more than ONE enclosure in flight — the queue, not a pool', maxInFlight, 1);
  await wait(1000);
  const c = await control();
  t.ok(`the control says the album is complete`, !!c.done && c.done.includes(`All ${TRACKS} tracks downloaded`), JSON.stringify(c));
  t.ok('...and offers nothing more to download', !c.button, String(c.button));
}

// ---------------------------------------------------------------------------
section('5. On /downloads the album is ONE entry, closed, that opens in album order');
// ---------------------------------------------------------------------------
{
  // One unrelated download beside the album, written the way the app writes
  // one, so the page has a show of ONE download to keep as a plain row.
  await js(`(async () => {
    const url = 'https://example.invalid/other-show/ep-1.mp3';
    const cache = await caches.open('bmb-downloads-v1');
    await cache.put(url, new Response(new Blob([new Uint8Array(2048)], { type: 'audio/mpeg' })));
    const db = await new Promise((res, rej) => { const r = indexedDB.open('BmbDownloadsDB'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction('downloads', 'readwrite');
      tx.objectStore('downloads').put({ key: url, enclosureUrl: url, enclosureType: 'audio/mpeg', sizeBytes: 2048,
        createdAt: Date.now(), itemGuid: 'other-ep-1', feedGuid: 'other-show-guid', feedId: 999001,
        episodeId: 999002, title: 'A Lone Episode', feedTitle: 'Some Other Show', duration: 60 });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return true;
  })()`);
  await send('Page.navigate', { url: `${APP}/downloads` });
  await until(() => js(`!!document.querySelector('[aria-expanded]')`), 15000);
  await wait(1000);

  const page0 = await js(`(() => {
    const groups = [...document.querySelectorAll('li button[aria-expanded]')];
    const g = groups[0];
    const li = g ? g.closest('li') : null;
    const r = g ? g.getBoundingClientRect() : null;
    return {
      groups: groups.length,
      head: g ? g.textContent.replace(/\\s+/g, ' ').trim() : null,
      expanded: g ? g.getAttribute('aria-expanded') : null,
      h: r ? Math.round(r.height) : null,
      showButtons: li ? [...li.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'SHOW').length : null,
      lone: [...document.querySelectorAll('button[aria-label="Play A Lone Episode"]')].length,
      tracksVisible: [...document.querySelectorAll('button[aria-label^="Play "]')].map((b) => b.getAttribute('aria-label')).filter((l) => l !== 'Play A Lone Episode').length,
      count: (document.body.innerText.match(/\\d+ downloads · [^\\n]+/) || [null])[0],
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);
  console.log(`  page: ${JSON.stringify(page0)}`);
  t.equal('the album is ONE entry', page0.groups, 1);
  t.ok(`...named for the album, with how many and how much`,
    !!page0.head && /Tinderbox/.test(page0.head) && page0.head.includes(`${TRACKS} downloaded`), page0.head);
  t.equal('...and it starts CLOSED — no track row is on the page', [page0.expanded, page0.tracksVisible], ['false', 0]);
  t.equal('...with ONE SHOW for the album, not fourteen', page0.showButtons, 1);
  t.equal('a show with one download stays a plain row', page0.lone, 1);
  t.ok('the page count says downloads, not episodes', !!page0.count && page0.count.startsWith(`${TRACKS + 1} downloads`), page0.count);
  t.ok('...and nothing widens a 390px page', page0.overflow <= 0, `${page0.overflow}px over`);

  await press('/Tinderbox/');
  await wait(800);
  const opened = await js(`(() => {
    const g = document.querySelector('li button[aria-expanded]');
    const list = g ? document.getElementById(g.getAttribute('aria-controls')) : null;
    return {
      expanded: g ? g.getAttribute('aria-expanded') : null,
      titles: list ? [...list.querySelectorAll('button[aria-label^="Play "]')].map((b) => b.getAttribute('aria-label').slice(5)) : [],
      showInside: list ? [...list.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'SHOW').length : null,
    };
  })()`);
  t.equal('a press opens it, and says so to a screen reader', opened.expanded, 'true');
  t.equal(`...showing all ${TRACKS} tracks`, opened.titles.length, TRACKS);
  // The album page's own order, captured in section 2 — the group must not
  // shuffle what DOWNLOAD ALBUM took in order.
  t.ok('...in the album page\'s order, which is the order they were taken',
    albumOrder.length >= TRACKS && JSON.stringify(opened.titles) === JSON.stringify(albumOrder.slice(0, TRACKS)),
    `group ${JSON.stringify(opened.titles)}\n         album ${JSON.stringify(albumOrder)}`);
  t.equal('...and no row inside repeats SHOW', opened.showInside, 0);

  // The group's DELETE removes a whole album with one press, so it asks.
  const del = await js(`(() => {
    const b = document.querySelector('button[aria-label="Delete all ${TRACKS} downloads of Tinderbox"]');
    if (!b) return false; b.click(); return true; })()`);
  await wait(600);
  const ask = await js(`(document.body.innerText.match(/Delete ${TRACKS} downloads[^\\n]*/) || [null])[0]`);
  t.ok('the album\'s DELETE asks first, with the count and the size', del && !!ask && /\(\d+(\.\d)? KB\)\?/.test(ask), String(ask));
  await press('/^CANCEL$/');
  await wait(800);
  t.equal('...and CANCEL deletes nothing', await stored(), TRACKS);

  await js(`document.querySelector('button[aria-label="Delete all ${TRACKS} downloads of Tinderbox"]').click()`);
  await wait(500);
  // The answer names the count, so it is told apart from the group's own
  // DELETE and from the lone row's — all three are on screen at once.
  t.ok('the answer that deletes the album names its count',
    await press(`/^DELETE ${TRACKS}$/`), `no button reads DELETE ${TRACKS}`);
  const gone = await until(async () => ((await stored()) === 0 ? 'gone' : null), 10000);
  t.equal('DELETE removes every track of the album from the database', gone, 'gone');
  const cacheLeft = await js(`caches.open('bmb-downloads-v1').then((c) => c.keys()).then((ks) => ks.filter((r) => /cloudfront|op3\\.dev/.test(r.url)).length)`);
  t.equal('...and every track\'s bytes from the cache', cacheLeft, 0);
  await wait(800);
  const after = await js(`({ groups: document.querySelectorAll('li button[aria-expanded]').length,
    lone: document.querySelectorAll('button[aria-label="Play A Lone Episode"]').length })`);
  t.equal('...while the other show\'s download stays', after, { groups: 0, lone: 1 });
}

t.equal('no uncaught exceptions', exceptions, []);
console.log(t.fails ? `\n${t.fails} of ${t.count} album checks FAILED.` : `\nAll ${t.count} album checks passed.`);
await exit(t.fails ? 1 : 0);
