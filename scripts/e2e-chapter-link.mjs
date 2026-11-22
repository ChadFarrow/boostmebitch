// A chapter that published a `url` must SHOW it: a chain-link mark right after
// the chapter's title, in the site's yellow, with a real 24×24 target — in the
// episode's chapter list AND on the player's now-playing chapter line.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:chapterlink                       # headless
//   THEME=light npm run e2e:chapterlink           # the same, in light mode
//   APP_URL=http://127.0.0.1:3019 npm run e2e:chapterlink -- --headed --keep
//
// THE FAULT IT WAS WRITTEN AGAINST (2026-11-22, Chad): "in the chapter layout
// here, the link for whatever is linked in the chapter, that button is hard to
// see, and I didn't even know that it had it. It's a little arrow up and to the
// right at the very end." The row's `↗` sat at the far right of the row, grey,
// beside the share icon; the player line's was the same small grey arrow.
//
// WHAT IT PINS, at 1280px and at a 390px phone (CDP device emulation):
//   - the mark follows the title's LAST WORD, also when the title wraps, and is
//     never alone on a line;
//   - it is 24×24, in `--bolt`, and every point of that box hits the link;
//   - it adds NOTHING to the height of the line it sits in (the row, the
//     mini-bar label, the fullscreen label) — measured with the mark and with
//     the mark removed, because the fullscreen cover's `30rem` reserve and the
//     mini-bar's one-height rule both count those lines;
//   - a click on it opens the link and does NOT seek or open the player, while
//     a click anywhere else on the row (title, empty space, thumbnail) still
//     seeks, and share still copies without seeking;
//   - the keyboard: Tab goes seek button → link → share, the row shows a focus
//     ring, the seek button is still named "time title", the link is named, and
//     the player line's mark stays the aria-hidden twin of its linked title.
//
// Everything the page asks for is answered here — the show, the episode, the
// chapters, a silent WAV — so nothing reaches Podcast Index. The chapter links
// point at `.invalid` hosts, so the tab a click opens loads nothing.

import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

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
const AUDIO = silentWav(120);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const GUID = 'c0de4000-0000-4000-8000-0000000c4a91';
const EP_GUID = 'c0de4000-0000-4000-8000-0000000c4a92';
const ID = 900791;
const IMG = (name) => `https://img.example.invalid/${name}.png`;
const LINK = (k) => `https://chapter-link-${k}.example.invalid/page`;
const LONG = 'A much longer chapter title that runs on well past the width of a phone screen, so it has to wrap onto a second line';
const CHAPTERS = [
  { startTime: 0, title: 'Back on the mic and pre-show rabbit holes' },
  { startTime: 20, title: 'Boost Me Bitch beta gets playlist creation', url: LINK(20) },
  { startTime: 40, title: LONG, url: LINK(40) },
  { startTime: 60, title: 'Using Nostr to share playlist RSS across apps' },
  { startTime: 80, title: 'Feature: make it yours (sign in and OPML)', url: LINK(80) },
  { startTime: 100, title: 'Wrap-up', img: IMG('wrap') },
];
const SHOW = {
  id: ID, podcastGuid: GUID, title: 'E2E Chapter Link Show', author: 'e2e', medium: 'podcast',
  image: IMG('show'), artwork: IMG('show'), url: 'https://feeds.example.invalid/chapterlink.xml',
};
const EPISODE = {
  id: 8910, guid: EP_GUID, podcastGuid: GUID, feedId: ID, title: 'Chapter link episode',
  image: IMG('ep'), enclosureUrl: `${APP}/api/e2e-audio.wav`, duration: 120,
  chaptersUrl: 'https://chapters.example.invalid/c.json', datePublished: 1763800000,
};

const { page, port } = await launchChrome({ name: 'chapterlink', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(pathname) {
  if (pathname === '/api/by-guid') return { podcast: SHOW };
  if (pathname === '/api/feed') return { podcast: SHOW, episodes: [EPISODE] };
  if (pathname === '/api/episode-by-guid') return { episode: EPISODE };
  if (pathname === '/api/chapters') return { chapters: CHAPTERS };
  if (pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}
await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/*', requestStage: 'Request' },
  { urlPattern: '*img.example.invalid*', requestStage: 'Request' },
] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  try {
    if (u.hostname === 'img.example.invalid' || u.pathname === '/api/art') {
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'image/png' }, { name: 'cache-control', value: 'max-age=3600' }],
        body: PNG.toString('base64'),
      });
      return;
    }
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
      body: b64(answer(u.pathname)),
    });
  } catch {
    // The page navigated away under a paused request.
  }
});
await send('Page.enable');
// `THEME=light` runs the same checks in light mode (the mark's colour is read
// from `--bolt`, which the light theme redefines).
if (process.env.THEME === 'light') {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('bmb:theme', 'light'); } catch {}" });
}
await send('Runtime.enable');
await send('DOM.enable');
await send('Accessibility.enable');

// ---- helpers ---------------------------------------------------------------

let touch = false;
const tap = async (x, y) => {
  if (touch) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
};
const key = async (k, code, shift = false) => {
  const modifiers = shift ? 8 : 0;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: k === 'Tab' ? 9 : 13, modifiers });
  if (k === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'Tab' ? 9 : 13, modifiers });
};

/** Every tab the clicks opened, by URL. Closed again after each read. */
const openedTabs = async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((x) => x.type === 'page' && /chapter-link-\d+\.example\.invalid/.test(x.url));
};
const closeOpened = async () => {
  for (const x of await openedTabs()) await fetch(`http://127.0.0.1:${port}/json/close/${x.id}`);
};
const waitForTab = async (k) => {
  for (let i = 0; i < 40; i++) {
    const hit = (await openedTabs()).find((x) => x.url.includes(`chapter-link-${k}.`));
    if (hit) return hit.url;
    await wait(100);
  }
  return null;
};

const audioTime = () => js(`(() => { const a = document.querySelector('audio'); return a && a.src ? Math.round(a.currentTime) : null; })()`);
const pause = () => js(`(() => { const b = document.querySelector('${MINI_BAR} button[aria-label="Pause"]'); b && b.click(); return 1; })()`);

/** The chapter list's row for chapter `k`, measured: the row, its title's
 *  text lines, the mark, the share button. Runs in the page. */
const ROW = (k) => `(() => {
  const want = ${JSON.stringify(CHAPTERS.find((c) => c.startTime === k).title)};
  const li = [...document.querySelectorAll('ul.text-xs > li')].filter((li) => !li.closest('.z-50')).find((li) => {
    const s = li.querySelector('span[aria-hidden="true"]');
    return s && s.textContent === want && !li.closest('.z-50') && li.getBoundingClientRect().width > 0;
  });
  if (!li) return null;
  // Into the middle of the viewport, clear of the fixed mini-bar and dock: a
  // point under them hits THEM, which says nothing about this row.
  li.scrollIntoView({ block: 'center', behavior: 'instant' });
  const titleSpan = li.querySelector('span[aria-hidden="true"]');
  const range = document.createRange();
  range.selectNodeContents(titleSpan);
  const lines = [...range.getClientRects()].filter((r) => r.width > 0);
  const tops = [...new Set(lines.map((r) => Math.round(r.top)))];
  const last = lines[lines.length - 1];
  const a = li.querySelector('a[href]');
  const ab = a && a.getBoundingClientRect();
  const share = li.querySelector('button[title^="Copy link"]');
  const sb = share && share.getBoundingClientRect();
  const lb = li.getBoundingClientRect();
  const tb = li.querySelector('img');
  const ib = tb && tb.getBoundingClientRect();
  const box = (r) => r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  let hits = null;
  if (ab) {
    const pts = [[ab.left + 1, ab.top + 1], [ab.right - 1, ab.top + 1], [ab.left + 1, ab.bottom - 1], [ab.right - 1, ab.bottom - 1], [ab.left + ab.width / 2, ab.top + ab.height / 2]];
    hits = pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.closest('a') === a ? true : (e ? e.tagName + '.' + String(e.className?.baseVal ?? e.className).slice(0, 60) + '@' + JSON.stringify(e.getBoundingClientRect()) : null); });
  }
  return {
    li: box(lb), mark: box(ab), share: box(sb), thumb: box(ib),
    href: a && a.getAttribute('href'),
    color: a && getComputedStyle(a).color,
    label: a && a.getAttribute('aria-label'),
    lines: tops.length,
    last: box(last),
    hits,
    titleH: titleSpan.parentElement.getBoundingClientRect().height,
    iconOff: a ? (() => { const sv = a.querySelector('svg').getBoundingClientRect(); return (sv.top + sv.height / 2) - (last.top + last.height / 2); })() : null,
  };
})()`;
const bolt = async () => `rgb(${(await js(`getComputedStyle(document.documentElement).getPropertyValue('--bolt').trim()`)).split(/\s+/).join(', ')})`;

/** The height of a container measured with the mark in place and with the mark
 *  removed from layout. Equal means the mark costs the line nothing. */
const withAndWithout = (containerExpr) => js(`(() => {
  const c = ${containerExpr};
  if (!c) return null;
  const a = c.querySelector('a svg')?.closest('a');
  const withH = c.getBoundingClientRect().height;
  if (!a) return { withH, withoutH: withH, mark: false };
  a.style.display = 'none';
  const withoutH = c.getBoundingClientRect().height;
  a.style.display = '';
  return { withH, withoutH, mark: true };
})()`);

/** Every OTHER control under the corners of the mark `markExpr` — a button,
 *  input or link that a tap on the mark's edge would otherwise have meant.
 *  Only inside `root` (the mini-bar, the fullscreen player): the page under an
 *  overlay is under every point of it, and no tap reaches it. */
const under = (markExpr, root) => js(`(() => { const a = ${markExpr}; const b = a.getBoundingClientRect(); const root = a.closest(${JSON.stringify(root)});
  const pts = [[b.left + 1, b.top + 1], [b.right - 1, b.top + 1], [b.left + 1, b.bottom - 1], [b.right - 1, b.bottom - 1]];
  return [...new Set(pts.flatMap(([x, y]) => document.elementsFromPoint(x, y)
    .filter((e) => e !== a && !a.contains(e) && root.contains(e) && e.matches('button, input, a, [role="button"]'))
    .map((e) => e.tagName + (e.getAttribute('aria-label') ? '[' + e.getAttribute('aria-label') + ']' : ''))))]; })()`);

/** The accessible name (and ignored flag) of the element `sel` finds. */
const ax = async (selExpr) => {
  await js(`(() => { document.querySelectorAll('[data-e2e-ax]').forEach((e) => e.removeAttribute('data-e2e-ax')); const e = ${selExpr}; if (e) e.setAttribute('data-e2e-ax', '1'); return !!e; })()`);
  const { result: doc } = await send('DOM.getDocument', { depth: 0 });
  const { result: q } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-e2e-ax]' });
  if (!q?.nodeId) return null;
  const { result } = await send('Accessibility.getPartialAXTree', { nodeId: q.nodeId, fetchRelatives: false });
  const n = result?.nodes?.[0];
  return n ? { name: n.name?.value ?? '', ignored: !!n.ignored, role: n.role?.value } : null;
};

const openChapters = async () => {
  t.ok('the episode page shows a Chapters tab',
    await until(`[...document.querySelectorAll('button')].some((b) => /^chapters \\(/i.test(b.textContent.trim()))`, 30000));
  await js(`[...document.querySelectorAll('button')].find((b) => /^chapters \\(/i.test(b.textContent.trim())).click()`);
  t.ok('the chapter list renders', await until(`!!(${ROW(20)})`, 15000));
};

// ---- the checks ------------------------------------------------------------

const VIEWS = [
  { label: '1280px desktop', m: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, touch: false },
  { label: '390px phone', m: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, touch: true },
];

for (const v of VIEWS) {
  console.log(`\n== ${v.label}`);
  touch = v.touch;
  await send('Emulation.setDeviceMetricsOverride', v.m);
  await send('Emulation.setTouchEmulationEnabled', { enabled: v.touch, maxTouchPoints: v.touch ? 5 : 0 });
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}&episode=${EP_GUID}` });
  await openChapters();
  const BOLT = await bolt();
  const L = v.label;

  console.log('1. The mark follows the title, is 24×24, yellow, and all of it hits the link');
  for (const k of [20, 40, 80]) {
    const r = await js(ROW(k));
    t.ok(`${L}: chapter ${k}s has a link mark`, !!r?.mark, JSON.stringify(r));
    if (!r?.mark) continue;
    t.equal(`${L}: chapter ${k}s mark links to the chapter's url`, r.href, LINK(k));
    t.ok(`${L}: chapter ${k}s mark is at least 24×24`, r.mark.width >= 24 && r.mark.height >= 24, `${r.mark.width}×${r.mark.height}`);
    t.equal(`${L}: chapter ${k}s mark is the site's yellow`, r.color, BOLT);
    const gap = r.mark.left - r.last.right;
    t.ok(`${L}: chapter ${k}s mark starts right after the title's last word (gap ${gap.toFixed(1)}px)`, gap >= -1 && gap <= 12, JSON.stringify({ last: r.last, mark: r.mark }));
    const mid = r.mark.top + r.mark.height / 2;
    t.ok(`${L}: chapter ${k}s mark sits on the title's last line`, mid >= r.last.top && mid <= r.last.bottom, JSON.stringify({ last: r.last, mid }));
    t.ok(`${L}: chapter ${k}s icon is centred on the title's last line (off by ${r.iconOff.toFixed(1)}px)`, Math.abs(r.iconOff) <= 1.5);
    t.ok(`${L}: chapter ${k}s mark is left of the share button`, r.share && r.mark.right <= r.share.left, JSON.stringify({ mark: r.mark, share: r.share }));
    t.equal(`${L}: chapter ${k}s every corner of the mark hits the link`, r.hits, [true, true, true, true, true]);
    t.equal(`${L}: chapter ${k}s mark is named for its chapter`, r.label, `Open chapter link: ${CHAPTERS.find((c) => c.startTime === k).title}`);
  }
  for (const k of [0, 60, 100]) {
    const r = await js(ROW(k));
    t.ok(`${L}: chapter ${k}s (no url) has no mark`, r && !r.mark, JSON.stringify(r?.mark));
  }
  const long = await js(ROW(40));
  if (v.m.mobile) {
    t.ok(`${L}: the long title wraps (${long?.lines} lines)`, long?.lines >= 2);
    t.ok(`${L}: …and the mark is not alone on its line`, long && long.last.width > 20, JSON.stringify(long?.last));
  } else {
    console.log(`  note ${L}: the long title takes ${long?.lines} line(s) here`);
  }

  console.log('2. The mark adds nothing to a row\'s height');
  for (const k of [20, 40, 80]) {
    const h = await withAndWithout(`(() => { const li = [...document.querySelectorAll('ul.text-xs > li')].filter((li) => !li.closest('.z-50')).find((li) => li.querySelector('a[href="${LINK(k)}"]')); return li; })()`);
    t.ok(`${L}: chapter ${k}s row is ${h?.withH}px with the mark and ${h?.withoutH}px without`, h && h.mark && Math.abs(h.withH - h.withoutH) < 0.5, JSON.stringify(h));
  }
  const overflow = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  t.ok(`${L}: no sideways page scroll (${overflow}px)`, overflow <= 0);

  console.log('3. Clicks: the mark opens its link and seeks nothing; the rest of the row seeks');
  await closeOpened();
  // A reload restores the last episode into the (paused) player, so "nothing
  // happened" is the player's state not changing, not the player being absent.
  const playerState = () => js(`(() => { const a = document.querySelector('audio'); return a && a.src ? { t: Math.round(a.currentTime), paused: a.paused } : null; })()`);
  const idle = await playerState();
  let r = await js(ROW(20));
  await tap(r.mark.left + r.mark.width / 2, r.mark.top + r.mark.height / 2);
  t.equal(`${L}: a ${touch ? 'tap' : 'click'} on chapter 20s mark opens its link in a new tab`, await waitForTab(20), LINK(20));
  await wait(600);
  t.equal(`${L}: …and neither plays nor seeks anything`, await playerState(), idle);
  await closeOpened();

  r = await js(ROW(20));
  await tap(r.last.left + 10, r.last.top + r.last.height / 2);
  t.ok(`${L}: a ${touch ? 'tap' : 'click'} on chapter 20s TITLE seeks there`,
    await until(`(() => { const a = document.querySelector('audio'); return !!a && a.currentTime >= 19.5 && a.currentTime < 25; })()`, 15000),
    `audio at ${await audioTime()}`);
  await pause();
  await wait(400);
  const at20 = await audioTime();

  r = await js(ROW(80));
  await tap(r.mark.left + r.mark.width / 2, r.mark.top + r.mark.height / 2);
  t.equal(`${L}: chapter 80s mark opens its link`, await waitForTab(80), LINK(80));
  await wait(600);
  t.equal(`${L}: …and the position does not move (still ${at20}s)`, await audioTime(), at20);
  await closeOpened();

  r = await js(ROW(60));
  const emptyX = (r.last.right + r.share.left) / 2;
  if (r.share.left - r.last.right > 16) {
    await tap(emptyX, r.li.top + r.li.height / 2);
    t.ok(`${L}: a ${touch ? 'tap' : 'click'} on the EMPTY part of chapter 60s row seeks there`,
      await until(`(() => { const a = document.querySelector('audio'); return !!a && Math.round(a.currentTime) >= 60 && a.currentTime < 65; })()`, 8000),
      `audio at ${await audioTime()}`);
  } else {
    console.log(`  note ${L}: chapter 60s title fills its row, so it has no empty part to click`);
    await tap(r.last.left + 5, r.last.top + r.last.height / 2);
    await until(`(() => { const a = document.querySelector('audio'); return !!a && Math.round(a.currentTime) >= 60; })()`, 8000);
  }
  await pause();
  await wait(400);
  const at60 = await audioTime();

  r = await js(ROW(40));
  await tap(r.share.left + r.share.width / 2, r.share.top + r.share.height / 2);
  t.ok(`${L}: chapter 40s share button still answers a ${touch ? 'tap' : 'click'}`,
    await until(`(() => { const li = [...document.querySelectorAll('ul.text-xs > li')].filter((li) => !li.closest('.z-50')).find((li) => li.querySelector('a[href="${LINK(40)}"]')); return /COPIED|COPY FAILED/.test(li.querySelector('button[title^="Copy link"]').textContent); })()`, 4000));
  t.equal(`${L}: …and does not seek (still ${at60}s)`, await audioTime(), at60);

  r = await js(ROW(100));
  await tap(r.thumb.left + r.thumb.width / 2, r.thumb.top + r.thumb.height / 2);
  t.ok(`${L}: a ${touch ? 'tap' : 'click'} on chapter 100s thumbnail seeks there`,
    await until(`(() => { const a = document.querySelector('audio'); return !!a && Math.round(a.currentTime) >= 100; })()`, 8000),
    `audio at ${await audioTime()}`);
  await pause();

  if (!touch) {
    console.log('4. The keyboard');
    // Start on chapter 0's share button, then Tab: seek(20) → mark(20) → share(20).
    await js(`[...document.querySelectorAll('ul.text-xs > li')].filter((li) => !li.closest('.z-50'))[0].querySelector('button[title^="Copy link"]').focus()`);
    await key('Tab', 'Tab');
    const seekFocused = await js(`(() => { const e = document.activeElement; return e && e.tagName === 'BUTTON' && e.title === 'Jump to 0:20'; })()`);
    t.ok(`${L}: Tab reaches chapter 20s seek button`, seekFocused, await js('document.activeElement?.outerHTML.slice(0, 160)'));
    const ring = await js(`(() => { const e = document.activeElement; const s = getComputedStyle(e, '::after'); const li = e.closest('li').getBoundingClientRect();
      return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, pos: s.position, own: getComputedStyle(e).outlineStyle, liW: li.width, matchFv: e.matches(':focus-visible') }; })()`);
    t.ok(`${L}: …and the whole row shows a focus ring`, ring.matchFv && ring.style === 'solid' && ring.width === '2px' && ring.color === BOLT && ring.pos === 'absolute', JSON.stringify(ring));
    const seekName = await ax(`document.activeElement`);
    t.equal(`${L}: …which is still named "time title"`, seekName?.name, `0:20 ${CHAPTERS[1].title}`);
    const visTitle = await ax(`document.activeElement.closest('li').querySelector('span[aria-hidden="true"]')`);
    t.ok(`${L}: the visible title is not read twice`, visTitle?.ignored, JSON.stringify(visTitle));
    await key('Tab', 'Tab');
    t.ok(`${L}: the next Tab reaches chapter 20s link mark`, await js(`document.activeElement?.getAttribute('href') === ${JSON.stringify(LINK(20))}`),
      await js('document.activeElement?.outerHTML.slice(0, 160)'));
    t.equal(`${L}: …which is named for its chapter`, (await ax(`document.activeElement`))?.name, `Open chapter link: ${CHAPTERS[1].title}`);
    const before = await audioTime();
    await closeOpened();
    await key('Enter', 'Enter');
    t.equal(`${L}: Enter on it opens the link`, await waitForTab(20), LINK(20));
    await wait(500);
    t.equal(`${L}: …and does not seek (still ${before}s)`, await audioTime(), before);
    await closeOpened();
    await key('Tab', 'Tab');
    t.ok(`${L}: the next Tab reaches chapter 20s share button`, await js(`document.activeElement?.title?.startsWith('Copy link to this chapter at 0:20')`),
      await js('document.activeElement?.outerHTML.slice(0, 160)'));

    console.log('5. The mini-bar chapter line');
    // At 100s: a chapter with no url.
    const lineExpr = `document.querySelector('${MINI_BAR}') && [...document.querySelectorAll('${MINI_BAR} .text-bolt\\\\/90')].find((e) => e.getBoundingClientRect().height > 0)`;
    t.ok(`${L}: the mini-bar names chapter 100s`, await until(`(() => { const e = ${lineExpr}; return !!e && /Wrap-up/.test(e.textContent); })()`, 8000));
    const plain = await withAndWithout(lineExpr);
    r = await js(ROW(80));
    await tap(r.last.left + 10, r.last.top + r.last.height / 2);
    t.ok(`${L}: the mini-bar names chapter 80s`, await until(`(() => { const e = ${lineExpr}; return !!e && /make it yours/.test(e.textContent); })()`, 8000));
    await pause();
    await wait(400);
    const linked = await withAndWithout(lineExpr);
    t.ok(`${L}: the line is 15px with no link (${plain?.withH}px), with the mark (${linked?.withH}px) and without it (${linked?.withoutH}px)`,
      plain && linked && linked.mark && [plain.withH, linked.withH, linked.withoutH].every((h) => Math.round(h) === 15), JSON.stringify({ plain, linked }));
    const mm = await js(`(() => {
      const a = (${lineExpr}).querySelector('a svg').closest('a');
      const b = a.getBoundingClientRect();
      const t = (${lineExpr}).querySelector('a:not([aria-hidden])').getBoundingClientRect();
      const pts = [[b.left + 1, b.top + 1], [b.right - 1, b.top + 1], [b.left + 1, b.bottom - 1], [b.right - 1, b.bottom - 1], [b.left + b.width / 2, b.top + b.height / 2]];
      return { w: b.width, h: b.height, color: getComputedStyle(a).color, gap: b.left - t.right, x: b.left + b.width / 2, y: b.top + b.height / 2,
        hits: pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.closest('a') === a ? true : (e ? e.tagName + '.' + (e.className?.baseVal ?? e.className) : null); }) };
    })()`);
    t.ok(`${L}: its mark is 24×24 (${mm.w}×${mm.h})`, mm.w >= 24 && mm.h >= 24);
    t.equal(`${L}: …in the site's yellow`, mm.color, BOLT);
    t.ok(`${L}: …right after the title (gap ${mm.gap.toFixed(1)}px)`, mm.gap >= 0 && mm.gap <= 8);
    t.equal(`${L}: …and every corner of it hits the link`, mm.hits, [true, true, true, true, true]);
    const geo = await js(`(() => { const line = ${lineExpr}; const a = line.querySelector('a svg').closest('a'); const b = a.getBoundingClientRect(); const i = document.querySelector('${MINI_BAR} input[type=range]').getBoundingClientRect();
      const s = a.querySelector('svg').getBoundingClientRect(); const txt = line.querySelector('a:not([aria-hidden])').getBoundingClientRect(); const bar = document.querySelector('${MINI_BAR}').getBoundingClientRect();
      return { markTop: b.top, markBottom: b.bottom, inputBottom: i.bottom, barBottom: bar.bottom, iconMid: s.top + s.height / 2, textMid: txt.top + txt.height / 2 }; })()`);
    t.ok(`${L}: …and it does not reach into the seek bar's box (mark top ${geo.markTop}, seek bottom ${geo.inputBottom})`, geo.markTop >= geo.inputBottom);
    t.ok(`${L}: …nor past the bar's bottom edge (mark bottom ${geo.markBottom}, bar bottom ${geo.barBottom})`, geo.markBottom <= geo.barBottom);
    t.ok(`${L}: …and its icon is centred on the title (off by ${(geo.iconMid - geo.textMid).toFixed(1)}px)`, Math.abs(geo.iconMid - geo.textMid) <= 1);
    t.equal(`${L}: …and no other control sits under it`, await under(`(${lineExpr}).querySelector('a svg').closest('a')`, MINI_BAR), []);
    t.ok(`${L}: …and it is the aria-hidden twin of the linked title`, (await ax(`(${lineExpr}).querySelector('a svg').closest('a')`))?.ignored);
    const fullOnScreen = `(() => { const i = document.querySelector('.z-50 input[type="range"]'); if (!i) return false; const b = i.getBoundingClientRect(); return b.width > 0 && b.top >= 0 && b.bottom <= innerHeight; })()`;
    await closeOpened();
    await tap(mm.x, mm.y);
    t.equal(`${L}: a click on it opens the link`, await waitForTab(80), LINK(80));
    await wait(800);
    t.ok(`${L}: …and does not open the fullscreen player behind it`, !(await js(fullOnScreen)));
    await closeOpened();
  }

  console.log(`${touch ? '4' : '6'}. The fullscreen player's chapter line`);
  // Into a linked chapter first (on the phone the mini-bar has no chapter line).
  r = await js(ROW(80));
  await tap(r.last.left + 10, r.last.top + r.last.height / 2);
  await until(`(() => { const a = document.querySelector('audio'); return !!a && Math.round(a.currentTime) >= 80; })()`, 8000);
  await pause();
  await js(`(() => { document.querySelector('${MINI_BAR}').click(); return 1; })()`);
  const fullLine = `[...document.querySelectorAll('.z-50 .text-bolt\\\\/90')].find((e) => e.getBoundingClientRect().height > 0)`;
  t.ok(`${L}: the fullscreen player names chapter 80s`, await until(`(() => { const e = ${fullLine}; return !!e && /make it yours/.test(e.textContent) && e.getBoundingClientRect().top >= 0; })()`, 8000));
  await wait(600);
  const fl = await withAndWithout(fullLine);
  t.ok(`${L}: its line is 16px with the mark (${fl?.withH}px) and without (${fl?.withoutH}px)`,
    fl && fl.mark && Math.round(fl.withH) === 16 && Math.round(fl.withoutH) === 16, JSON.stringify(fl));
  const fm = await js(`(() => { const a = (${fullLine}).querySelector('a svg').closest('a'); const b = a.getBoundingClientRect();
    const pts = [[b.left + 1, b.top + 1], [b.right - 1, b.top + 1], [b.left + 1, b.bottom - 1], [b.right - 1, b.bottom - 1]];
    return { w: b.width, h: b.height, color: getComputedStyle(a).color, x: b.left + b.width / 2, y: b.top + b.height / 2,
      hits: pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.closest('a') === a ? true : (e ? e.tagName + '.' + String(e.className?.baseVal ?? e.className).slice(0, 80) + '@' + JSON.stringify(e.getBoundingClientRect()) + ' mark ' + JSON.stringify(b) : null); }) }; })()`);
  t.ok(`${L}: its mark is 24×24 (${fm.w}×${fm.h}) in the site's yellow`, fm.w >= 24 && fm.h >= 24 && fm.color === BOLT, JSON.stringify(fm));
  t.equal(`${L}: …and every corner of it hits the link`, fm.hits, [true, true, true, true]);
  t.equal(`${L}: …and no other control sits under it`, await under(`(${fullLine}).querySelector('a svg').closest('a')`, '.z-50'), []);
  await closeOpened();
  const posBefore = await audioTime();
  await tap(fm.x, fm.y);
  t.equal(`${L}: a ${touch ? 'tap' : 'click'} on it opens the link`, await waitForTab(80), LINK(80));
  await wait(500);
  t.equal(`${L}: …and does not seek (still ${posBefore}s)`, await audioTime(), posBefore);
  await closeOpened();
  const ov = await js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  t.ok(`${L}: no sideways page scroll with the fullscreen player open (${ov}px)`, ov <= 0);

  if (process.env.SHOTS) {
    await js(`(() => { document.querySelector('.z-50 button[aria-label*="lose" i], .z-50 button[aria-label*="ollapse" i]')?.click(); return 1; })()`);
    await wait(800);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${process.env.SHOTS}/chapter-link-${v.m.width}${process.env.THEME === 'light' ? '-light' : ''}.png`, Buffer.from(shot.result.data, 'base64'));
  }
}

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
