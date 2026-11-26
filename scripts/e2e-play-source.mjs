// `npm run e2e:playsource` — the player's "where is this playing from" mark (#669).
//
// THE REPORT, 2026-11-24, from the installed Android app on boostmebuddy.com:
// "A little icon showing that you're playing a downloaded file or streaming
// would be sweet." `<PlaySource>` answers it in the mini-bar (an icon on the
// secondary line) and in the fullscreen player (icon + word in the clock row).
//
// What this pins, each a way the obvious version is wrong:
// 1. The answer is what the element PLAYS, not what the library holds: a
//    download that finishes while the item streams leaves it streaming, and the
//    mark must keep saying so. (Reading `downloadManager` would flip it.)
// 2. While a download's local read is in flight the mark is a held SLOT — never
//    the previous item's answer, and never a change in the bar's height.
// 3. A live item shows no mark; the ● LIVE stamp already says where it comes from.
// 4. The video rendition of a downloaded episode is network.
// 5. A cold load of a downloaded episode (the hydrating path) says local.
// 6. No horizontal overflow and no change in the bar's height, at 390×844 and
//    320×568 under CDP device emulation (`mobile: true`, never `--window-size`).
//
// Nothing here downloads a real episode. Three items of Homegrown Hits are
// rewritten in the browser: two plain episodes and one live item, each with an
// enclosure on `e2e-audio.invalid` that CDP `Fetch` answers with a 60-second
// silent WAV generated below — for the <audio> element AND for the download's
// own `fetch`, which is the real DOWNLOAD tile of the fullscreen ⋯ menu.
//
// Needs the app: `npm run build && npm start` (or `npm run dev`) in another
// terminal, `APP_URL` if it is not on :3000. `SHOTS=<dir>` saves screenshots.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm run build && npm start\` (or \`npm run dev\`) in another terminal.`);

const t = checker();
/** Homegrown Hits — any feed would do: three of its items are rewritten. */
const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';
const HOST = 'https://e2e-audio.invalid/';
const EP = {
  A: { guid: 'e2e-src-a', title: 'E2E source A', id: -990011, url: `${HOST}a.wav` },
  B: { guid: 'e2e-src-b', title: 'E2E source B', id: -990012, url: `${HOST}b.wav` },
  L: { guid: 'e2e-src-live', title: 'E2E source live', id: -990013, url: `${HOST}live.wav` },
};
const VIDEO = `${HOST}a-video.mp4`;

/** 60 s of 8 kHz mono silence: real audio, so the element plays and seeks. */
function wav(sec, rate = 8000) {
  const n = sec * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
const WAV = wav(60);

const { page } = await launchChrome({ name: `playsource-${process.env.CLAUDE_CODE_SESSION_ID ?? 'run'}`, autoplay: true });
const { send, js, until, on } = page;
const exceptions = [];
const fetched = [];
on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  }
});
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.SHOTS, name), Buffer.from(r.result.data, 'base64'));
};
const finish = async () => {
  t.equal('no uncaught exceptions', exceptions, []);
  console.log(t.fails ? `\n${t.fails} of ${t.count} play-source check(s) FAILED.` : `\nAll ${t.count} play-source checks passed.`);
  await exit(t.fails ? 1 : 0);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// The production build registers a service worker, and a request it answers
// is not this tab's to intercept.
await send('Network.setBypassServiceWorker', { bypass: true });
const phone = async (width, height) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await wait(400);
};
await phone(390, 844);

await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/feed?*', requestStage: 'Response' },
  { urlPattern: '*/api/live-status?*', requestStage: 'Request' },
  { urlPattern: `${HOST}*`, requestStage: 'Request' },
] });
on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request, resourceType, responseStatusCode, responseHeaders } = m.params;
  const fulfill = (body, code, headers) =>
    send('Fetch.fulfillRequest', { requestId, responseCode: code, responseHeaders: headers, body: Buffer.from(body).toString('base64') });
  try {
    if (request.url.startsWith(HOST)) {
      fetched.push({ url: request.url, type: resourceType });
      // Ranges answered properly, so a media element's seek is not a re-read.
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers?.Range ?? request.headers?.range ?? '');
      const base = [
        { name: 'content-type', value: 'audio/wav' },
        { name: 'accept-ranges', value: 'bytes' },
        { name: 'access-control-allow-origin', value: '*' },
        { name: 'access-control-expose-headers', value: 'content-length, content-range' },
      ];
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), WAV.length - 1) : WAV.length - 1;
        const part = WAV.subarray(start, end + 1);
        await fulfill(part, 206, [...base,
          { name: 'content-range', value: `bytes ${start}-${end}/${WAV.length}` },
          { name: 'content-length', value: String(part.length) }]);
      } else {
        await fulfill(WAV, 200, [...base, { name: 'content-length', value: String(WAV.length) }]);
      }
      return;
    }
    if (request.url.includes('/api/live-status')) {
      await fulfill(JSON.stringify({ ok: true, items: [{ guid: EP.L.guid, status: 'live' }] }), 200,
        [{ name: 'content-type', value: 'application/json' }]);
      return;
    }
    const r = await send('Fetch.getResponseBody', { requestId });
    const raw = r.result.base64Encoded ? Buffer.from(r.result.body, 'base64').toString('utf8') : r.result.body;
    const data = JSON.parse(raw);
    if (Array.isArray(data.episodes) && data.episodes.length) {
      const now = Math.floor(Date.now() / 1000);
      const base = data.episodes.find((e) => !e.liveStatus) ?? data.episodes[0];
      const item = (e, extra = {}) => {
        const out = { ...base, id: e.id, guid: e.guid, title: e.title, enclosureUrl: e.url,
          enclosureType: 'audio/wav', enclosureLength: WAV.length, duration: 60, ...extra };
        // Nothing that would fetch or redirect: no chapters, transcript, track
        // windows or live value socket for an item that is not real.
        for (const k of ['chaptersUrl', 'transcriptUrl', 'transcriptType', 'valueTimeSplits', 'liveValue', 'alternateEnclosures']) delete out[k];
        return { ...out, ...extra };
      };
      data.episodes = [
        item(EP.L, { liveStatus: 'live', liveStartTime: now - 600, liveEndTime: now + 3600 }),
        item(EP.A, { alternateEnclosures: [{ type: 'video/mp4', title: 'Video', source: VIDEO }] }),
        item(EP.B),
        ...data.episodes.filter((e) => !e.liveStatus),
      ];
    }
    await fulfill(JSON.stringify(data), responseStatusCode,
      (responseHeaders ?? []).filter((h) => !/^content-(length|encoding)$/i.test(h.name)));
  } catch (e) {
    console.log(`  (interception of ${request.url} failed: ${e.message})`);
    await send('Fetch.continueRequest', { requestId }).catch(() => {});
  }
});

// --- What the page shows ---------------------------------------------------
const AUDIO = `document.querySelector('${MINI_BAR} audio')`;
/** The mark (or its held slot) in the mini-bar, or in the fullscreen clock row. */
const MARK = (where) => where === 'mini'
  ? `document.querySelector('${MINI_BAR} [data-play-source], ${MINI_BAR} [data-play-source-slot]')`
  : `[...document.querySelectorAll('[data-play-source], [data-play-source-slot]')].find((el) => !el.closest('${MINI_BAR}'))`;
/** `local` | `network` | `pending` (the held slot) | `none` (no mark at all). */
const mark = (where) => js(`(() => { const el = ${MARK(where)}; if (!el) return 'none'; return el.dataset.playSource ?? 'pending'; })()`);
const markInfo = (where) => js(`(() => {
  const el = ${MARK(where)}; if (!el) return null;
  const r = el.getBoundingClientRect();
  return { kind: el.dataset.playSource ?? 'pending', label: el.getAttribute('aria-label'), role: el.getAttribute('role'),
    title: el.getAttribute('title'), text: el.textContent.trim(), l: r.left, r: r.right, w: r.width, h: r.height };
})()`);
/** The mini-bar's geometry: the bar, its title button, and the page's overflow. */
const bar = () => js(`(() => {
  const b = document.querySelector('${MINI_BAR}').getBoundingClientRect();
  const title = document.querySelector('${MINI_BAR} button[aria-label^="Open fullscreen player"]').getBoundingClientRect();
  const second = document.querySelector('${MINI_BAR} button[aria-label^="Open fullscreen player"]').nextElementSibling.getBoundingClientRect();
  return { h: Math.round(b.height * 10) / 10, titleL: Math.round(title.left), titleH: Math.round(title.height * 10) / 10,
    secondH: Math.round(second.height * 10) / 10,
    scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, vw: innerWidth };
})()`);
/** The fullscreen clock row: its height against one clock's, and its width. */
const clockRow = () => js(`(() => {
  const el = ${MARK('full')}; if (!el) return null;
  const row = el.parentElement; const r = row.getBoundingClientRect(); const c = row.firstElementChild.getBoundingClientRect();
  const m = el.getBoundingClientRect(); const last = row.lastElementChild.getBoundingClientRect();
  return { rowH: Math.round(r.height * 10) / 10, clockH: Math.round(c.height * 10) / 10, rowW: Math.round(r.width), scrollW: row.scrollWidth,
    clientW: row.clientWidth, markMid: Math.round((m.left + m.right) / 2), rowMid: Math.round((r.left + r.right) / 2),
    lastR: Math.round(last.right), rowR: Math.round(r.right), clocks: [row.firstElementChild.textContent, row.lastElementChild.textContent] };
})()`);
const src = () => js(`(() => { const a = ${AUDIO}; return a ? { blob: a.src.startsWith('blob:'), src: a.src.slice(0, 60), paused: a.paused, rs: a.readyState } : null; })()`);

const rowButton = (title, labels = ['Play', 'Resume']) => `[...document.querySelectorAll('li')]
  .find((li) => li.textContent.includes(${JSON.stringify(title)}))
  ?.querySelector(${JSON.stringify(labels.map((l) => `button[aria-label="${l}"]`).join(', '))})`;
const playRow = async (e) => js(`(() => { const b = ${rowButton(e.title)}; if (!b) return false; b.click(); return true; })()`);
const playingFrom = (test) => until(`(() => { const a = ${AUDIO}; return !!a && ${test} && !a.paused && a.readyState >= 2; })()`, 15000);
const openFull = async () => {
  await js(`document.querySelector('${MINI_BAR} button[aria-label^="Open fullscreen player"]')?.click()`);
  await until(`!!document.querySelector('button[aria-label="Close fullscreen player"]') && getComputedStyle(document.querySelector('button[aria-label="Close fullscreen player"]')).visibility === 'visible'`, 5000);
  await wait(500);
};
const closeFull = async () => {
  await js(`document.querySelector('button[aria-label="Close fullscreen player"]')?.click()`);
  await wait(700);
};
const checkBar = (label, b, height) => {
  t.ok(`${label}: no horizontal overflow (${b.scroll} ≤ ${b.client})`, b.scroll <= b.client, JSON.stringify(b));
  if (height !== undefined) t.equal(`${label}: the bar keeps its height`, b.h, height);
};
const checkMiniMark = (label, info, vw) => {
  t.ok(`${label}: the mini mark is inside the viewport and 12px`, info && info.l >= 0 && info.r <= vw && Math.round(info.w) === 12, JSON.stringify(info));
  t.ok(`${label}: the mini mark is named for a screen reader`, info && info.role === 'img' && !!info.label && info.title === info.label, JSON.stringify(info));
};

// ---------------------------------------------------------------------------
console.log('1. A streamed episode says network, in both players');
// ---------------------------------------------------------------------------
await send('Page.navigate', { url: `${APP}/?podcast=${HGH}` });
if (!await until(`!!${rowButton(EP.A.title)}`, 30000)) {
  t.fail('the rewritten episode rows render', await js(`document.body.innerText.slice(0, 300)`));
  await finish();
}
await playRow(EP.A);
t.ok('A plays from the network', await playingFrom(`a.src === ${JSON.stringify(EP.A.url)}`), JSON.stringify(await src()));
t.equal('mini-bar: network', await mark('mini'), 'network');
const b390 = await bar();
checkBar('390, network', b390);
checkMiniMark('390, network', await markInfo('mini'), b390.vw);
t.ok('390: the mark does not make the secondary line taller than 17px', b390.secondH <= 17, JSON.stringify(b390));
await shot('390-mini-network.png');

// The fullscreen player's info pane mounts on its first open, so its mark is
// read once it is open.
await openFull();
t.equal('fullscreen: network', await mark('full'), 'network');
const fullNet = await markInfo('full');
t.equal('fullscreen word: Online', fullNet?.text, 'Online');
t.ok('fullscreen mark is named for a screen reader', fullNet?.role === 'img' && /network/.test(fullNet.label ?? ''), JSON.stringify(fullNet));
const row390 = await clockRow();
t.ok('fullscreen clock row: no taller than one clock', row390 && row390.rowH <= row390.clockH + 0.5, JSON.stringify(row390));
t.ok('fullscreen clock row: no overflow', row390 && row390.scrollW <= row390.clientW, JSON.stringify(row390));
t.ok('fullscreen clock row: the mark is centred', row390 && Math.abs(row390.markMid - row390.rowMid) <= 2, JSON.stringify(row390));
t.ok('fullscreen clock row: the duration stays on the right edge', row390 && Math.abs(row390.lastR - row390.rowR) <= 1, JSON.stringify(row390));
await shot('390-full-network.png');

// ---------------------------------------------------------------------------
console.log('\n2. A download that FINISHES while the item streams leaves it streaming');
// ---------------------------------------------------------------------------
await js(`document.querySelector('button[aria-label="More actions for this episode"]')?.click()`);
const MENU_DOWNLOAD = `[...document.querySelectorAll('[role="menu"] button[aria-label^="Download "]')].find((b) => /to play without a connection/.test(b.getAttribute('aria-label')))`;
await until(`!!(${MENU_DOWNLOAD})`, 5000);
t.ok('the ⋯ menu offers DOWNLOAD for A', await js(`(() => { const b = ${MENU_DOWNLOAD}; if (!b) return false; b.click(); return true; })()`));
const saved = await until(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('BmbDownloadsDB'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
  if (!db) return false;
  const rec = await new Promise((res) => { const g = db.transaction('downloads').objectStore('downloads').get(${JSON.stringify(EP.A.url)}); g.onsuccess = () => res(g.result); g.onerror = () => res(null); });
  db.close();
  return !!rec && !!(await (await caches.open('bmb-downloads-v1')).match(${JSON.stringify(EP.A.url)}));
})()`, 20000);
t.ok('A is downloaded (record + bytes)', saved, JSON.stringify(fetched.slice(-4)));
// CDP names a `fetch()` from the page `XHR` (or `Fetch`); the element's own
// reads are `Media`.
t.ok('the download went through fetch, not the element', fetched.some((f) => f.url === EP.A.url && f.type !== 'Media'), JSON.stringify(fetched));
await wait(800);
const still = await src();
t.ok('the element still plays the network URL', still && !still.blob && !still.paused, JSON.stringify(still));
t.equal('fullscreen still says network', await mark('full'), 'network');
t.equal('mini-bar still says network', await mark('mini'), 'network');
await js(`document.querySelector('button[aria-label="More actions for this episode"][aria-expanded="true"]')?.click()`);
await closeFull();

// ---------------------------------------------------------------------------
console.log('\n3. Track change: the next item never shows the last one\'s answer');
// ---------------------------------------------------------------------------
await playRow(EP.B);
t.ok('B plays from the network', await playingFrom(`a.src === ${JSON.stringify(EP.B.url)}`), JSON.stringify(await src()));
t.equal('B: network', await mark('mini'), 'network');
const bB = await bar();
// The local read is 10–300 ms for real; 1.5 s makes "pending" observable.
await js(`(() => {
  const match = Cache.prototype.match;
  Cache.prototype.match = function (req, opts) {
    const u = typeof req === 'string' ? req : req.url;
    const hit = match.call(this, req, opts);
    return u && u.endsWith('/a.wav') ? new Promise((r) => setTimeout(() => r(hit), 1500)) : hit;
  };
  return true;
})()`);
await playRow(EP.A);
await wait(250);
const during = await mark('mini');
const bPending = await bar();
t.equal('A, read in flight: the slot is held, not B\'s answer', during, 'pending');
t.equal('A, read in flight: fullscreen shows no answer either', await mark('full'), 'pending');
t.equal('A, read in flight: the bar keeps its height', bPending.h, bB.h);
t.equal('A, read in flight: the title does not move', bPending.titleL, bB.titleL);
t.ok('A plays from local bytes', await playingFrom(`a.src.startsWith('blob:')`), JSON.stringify(await src()));
t.equal('A: local', await mark('mini'), 'local');
const bLocal = await bar();
t.equal('A, local: the bar keeps its height', bLocal.h, bB.h);
t.equal('A, local: the title does not move', bLocal.titleL, bB.titleL);
checkMiniMark('390, local', await markInfo('mini'), bLocal.vw);
await shot('390-mini-local.png');
await openFull();
const fullLocal = await markInfo('full');
t.equal('fullscreen word: Downloaded', fullLocal?.text, 'Downloaded');
t.ok('fullscreen local label names the download', /downloaded file/.test(fullLocal?.label ?? ''), JSON.stringify(fullLocal));
await shot('390-full-local.png');

// ---------------------------------------------------------------------------
console.log('\n4. 320 wide: nothing overflows, in either state');
// ---------------------------------------------------------------------------
await phone(320, 568);
const row320 = await clockRow();
t.ok('320 fullscreen, local: clock row has no overflow', row320 && row320.scrollW <= row320.clientW, JSON.stringify(row320));
t.ok('320 fullscreen, local: clock row no taller than one clock', row320 && row320.rowH <= row320.clockH + 0.5, JSON.stringify(row320));
const doc320 = await js(`({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth })`);
t.ok('320 fullscreen: no page overflow', doc320.s <= doc320.c, JSON.stringify(doc320));
await shot('320-full-local.png');
await closeFull();
const b320l = await bar();
checkBar('320, local', b320l);
checkMiniMark('320, local', await markInfo('mini'), b320l.vw);
await shot('320-mini-local.png');
await playRow(EP.B);
await playingFrom(`a.src === ${JSON.stringify(EP.B.url)}`);
t.equal('320, B: network', await mark('mini'), 'network');
const b320n = await bar();
checkBar('320, network', b320n, b320l.h);
checkMiniMark('320, network', await markInfo('mini'), b320n.vw);
await phone(390, 844);

// ---------------------------------------------------------------------------
console.log('\n5. A live item shows no mark');
// ---------------------------------------------------------------------------
await playRow(EP.L);
t.ok('the live item plays', await playingFrom(`a.src === ${JSON.stringify(EP.L.url)}`), JSON.stringify(await src()));
await wait(500);
t.equal('live: no mark in the mini-bar', await mark('mini'), 'none');
t.equal('live: no mark in the fullscreen player', await mark('full'), 'none');
checkBar('390, live', await bar());

// ---------------------------------------------------------------------------
console.log('\n6. The video rendition of a downloaded episode is network');
// ---------------------------------------------------------------------------
await playRow(EP.A);
await playingFrom(`a.src.startsWith('blob:')`);
t.equal('A (audio): local', await mark('mini'), 'local');
await openFull();
const VIDEO_BTN = `[...document.querySelectorAll('[role="group"][aria-label="Play audio or video"] button')].find((b) => b.textContent.includes('Video'))`;
const AUDIO_BTN = `[...document.querySelectorAll('[role="group"][aria-label="Play audio or video"] button')].find((b) => b.textContent.includes('Audio'))`;
t.ok('A offers the video rendition', await until(`!!(${VIDEO_BTN})`, 5000));
await js(`(${VIDEO_BTN})?.click()`);
await until(`(() => { const v = document.querySelector('video'); return !!v && v.src === ${JSON.stringify(VIDEO)}; })()`, 8000);
t.equal('video: network', await mark('full'), 'network');
await js(`(${AUDIO_BTN})?.click()`);
t.ok('back on audio: local bytes again', await playingFrom(`a.src.startsWith('blob:')`), JSON.stringify(await src()));
t.equal('back on audio: local', await mark('full'), 'local');
await closeFull();

// ---------------------------------------------------------------------------
console.log('\n7. A cold load of a downloaded episode says local');
// ---------------------------------------------------------------------------
await send('Page.navigate', { url: `${APP}/?podcast=${HGH}&episode=${EP.A.guid}&t=0` });
t.ok('A plays from local bytes after a reload', await until(`(() => { const a = ${AUDIO}; return !!a && a.src.startsWith('blob:') && a.readyState >= 1; })()`, 30000), JSON.stringify(await src()));
t.equal('after a reload: local', await mark('mini'), 'local');
checkBar('390, reload', await bar());

await finish();
