// The per-show speed paths `e2e:speed` does not drive, in a real browser:
//
//   1. A `podcastL` playlist row plays at its OWN show's speed, a speed chosen
//      on a row is saved for that show (never for the playlist), and moving
//      between two rows of ONE container re-resolves the speed — the only case
//      where `current.podcast` stays the same while the show changes.
//  1b. The same playlist with a `podcastGuid` on its container, which is the
//      only case where `speedShowKey` reading the EPISODE's guid first matters
//      (Podcast Index does not hold this list, so its container has none).
//   2. The queue writers of `current`: `playFromQueue`, "Next in queue"
//      (`stepTo`), a load of /listen that reveals the queue head, and a real
//      `ended` (`handlePlaybackEnded`).
//   3. A phone layout (CDP device emulation): the SPEED tile and the 3.5× / 5×
//      tiles in the fullscreen player's ⋯ menu, which is where a phone changes
//      speed — the mini-bar chip is `lg:` only.
//
// Every section also logs each `playing` event on the media element and
// asserts that no new source ever PLAYED at the previous show's speed.
//
// It can fail (2026-10-30, against builds of 612e593): with `speedShowKey`
// reading the container's guid first, 1b fails 4 checks; with the
// `useShowSpeed()` call removed, 17 checks fail across 1, 1b, 2 and 3.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:speed-gaps              # APP_URL=… for another port; ONLY=1b,3 for some sections
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';

const SHOW_A = '2d418249-453a-5714-8abc-5b657570b641'; // Bowl After Bowl
const SHOW_B = '917393e3-1b1e-5cef-ace4-edaa54e1f810'; // Podcasting 2.0
const SHOW_C = '290e12c3-91a7-5c30-be14-1837a1a976e2'; // the e2e:artbytes talk show
/** "Small Group Shows", a real `podcastL` that lists Bowl After Bowl episodes. */
const LIST_URL = 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/smallgroup-shows-playlist.xml';
const LIST_GUID = '5da03898-d837-435d-9474-4be9a6c95e13';
/** Chad and Reeds Podcast — a member feed of that playlist ("012. Stay Awhile"). */
const PODHOME = '7c6f7875-2b73-491e-b32c-e2c8d6e91d53';

await requireApp(`${APP}/privacy`, `Nothing is serving ${APP}. Run \`npm start\` after \`npm run build\`.`);

const t = checker();
/** `ONLY=1b,3` runs just those sections. */
const want = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);
const MEDIA_LOG = `
  window.__media = [];
  for (const type of ['playing', 'ratechange']) {
    document.addEventListener(type, (e) => {
      const el = e.target;
      if (!(el instanceof HTMLMediaElement)) return;
      window.__media.push({ type, src: el.currentSrc || el.src, rate: el.playbackRate });
    }, true);
  }
`;

async function open(name, mobile) {
  const b = await launchChrome({ name, autoplay: true, args: ['--window-size=1200,900'] });
  const page = Object.assign(b.page, { done: b.close });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  if (mobile) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: MEDIA_LOG });
  return page;
}

function helpers(page) {
  const { send, js, until } = page;
  const go = async (url) => { await send('Page.navigate', { url }); await wait(1500); };
  const playing = `(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && !a.paused; })()`;
  const rateNow = () => js(`document.querySelector('audio')?.playbackRate ?? null`);
  const srcNow = () => js(`(() => { const a = document.querySelector('audio'); return a ? (a.currentSrc || a.src) : null; })()`);
  const stored = () => js(`(() => { const o = {};
    for (const k of Object.keys(localStorage)) if (k.startsWith('bmb:playback_rate')) o[k] = localStorage.getItem(k);
    return o; })()`);
  /** Every `playing` the element fired for `src`, and the speed it played at. */
  const playedAt = async (src) => (await js(`window.__media.filter((m) => m.type === 'playing' && m.src === ${JSON.stringify(src)}).map((m) => m.rate)`)) ?? [];
  const CHIP = `document.querySelector('${MINI_BAR} button[aria-label^="Playback speed"]')`;
  const chipTo = async (to) => {
    for (let i = 0; i < 6; i++) {
      if (await rateNow() === to) return true;
      await js(`${CHIP}?.click()`);
      await wait(300);
    }
    return await rateNow() === to;
  };
  /** Press a row's Play, wait for sound, and give back what played. */
  const pressAndPlay = async (expr) => {
    const before = await srcNow();
    const pressed = await js(expr);
    if (!pressed) return { rate: null, src: null, why: 'no such row' };
    if (!await until(`(${playing}) && (document.querySelector('audio').currentSrc || '') !== ${JSON.stringify(before ?? '')}`, 40000)) {
      return { rate: null, src: null, why: 'never played a new source' };
    }
    await wait(900);
    const src = await srcNow();
    return { rate: await rateNow(), src, played: await playedAt(src) };
  };
  const playShow = async (guid) => {
    await go(`${APP}/?podcast=${guid}`);
    if (!await until(`!!document.querySelector('li button[aria-label="Play"]:not([disabled])')`, 30000)) return { rate: null, why: 'no playable row' };
    return pressAndPlay(`(() => { const b = document.querySelector('li button[aria-label="Play"]:not([disabled])'); b?.click(); return !!b; })()`);
  };
  return { send, js, until, go, rateNow, srcNow, stored, chipTo, pressAndPlay, playShow, playing };
}

/** The rate it plays at, and that every `playing` of that source was at it. */
function expectPlay(label, got, want) {
  t.equal(`${label} — element at ${want}×`, got.rate, want);
  if (got.played) {
    t.ok(`${label} — never PLAYED at another speed`, got.played.length > 0 && got.played.every((r) => r === want),
      `playing events at: ${JSON.stringify(got.played)}`);
  } else {
    t.fail(`${label} — it played`, got.why);
  }
}

// ---------------------------------------------------------------------------
console.log('1. A podcastL playlist row plays at its own show\'s speed');
// ---------------------------------------------------------------------------
if (want('1')) {
  const page = await open('speed-podcastl');
  const h = helpers(page);
  await h.go(`${APP}/privacy`);
  await h.js(`(() => { localStorage.clear(); return true; })()`);

  expectPlay('Bowl After Bowl, direct, untouched', await h.playShow(SHOW_A), 1);
  t.ok('chip: Bowl After Bowl to 1.5×', await h.chipTo(1.5));
  expectPlay('Podcasting 2.0, direct, follows the global', await h.playShow(SHOW_B), 1.5);
  t.ok('chip: Podcasting 2.0 to 1× (global key removed)', await h.chipTo(1));
  let s = await h.stored();
  t.equal('precondition: A=1.5, B=1, no global', s, { [`bmb:playback_rate:${SHOW_A}`]: '1.5', [`bmb:playback_rate:${SHOW_B}`]: '1' });

  await h.go(`${APP}/?playlist=${encodeURIComponent(LIST_URL)}`);
  const rowsUp = await h.until(`document.querySelectorAll('li button[aria-label="Play"]').length > 3`, 60000);
  t.ok('the Small Group Shows playlist lists its rows', rowsUp);
  const row = (title) => `(() => {
    const li = [...document.querySelectorAll('li')].find((x) => x.textContent.includes(${JSON.stringify(title)}) && x.querySelector('button[aria-label="Play"], button[aria-label="Resume"]'));
    const b = li?.querySelector('button[aria-label="Play"], button[aria-label="Resume"]'); b?.click(); return !!b; })()`;

  expectPlay('playlist row "Episode 465" (Bowl After Bowl)', await h.pressAndPlay(row('Episode 465')), 1.5);
  t.ok('chip: the row to 1.75×', await h.chipTo(1.75));
  s = await h.stored();
  t.equal('the row saved Bowl After Bowl\'s own speed', s[`bmb:playback_rate:${SHOW_A}`], '1.75');
  t.ok('nothing saved under the playlist\'s guid', !(`bmb:playback_rate:${LIST_GUID}` in s), JSON.stringify(s));

  expectPlay('row "012. Stay Awhile" (another show, untouched) — same container', await h.pressAndPlay(row('Stay Awhile')), 1.75);
  t.ok('chip: that row to 1.25×', await h.chipTo(1.25));
  s = await h.stored();
  t.equal('saved under Chad and Reeds Podcast\'s guid', s[`bmb:playback_rate:${PODHOME}`], '1.25');
  t.ok('still nothing under the playlist\'s guid', !(`bmb:playback_rate:${LIST_GUID}` in s), JSON.stringify(s));

  expectPlay('back to the "Episode 464" row — same container, Bowl After Bowl again', await h.pressAndPlay(row('Episode 464')), 1.75);
  expectPlay('Bowl After Bowl opened directly takes the speed chosen on the row', await h.playShow(SHOW_A), 1.75);
  await page.done();
}

// ---------------------------------------------------------------------------
console.log('\n1b. The same playlist when its container HAS a podcastGuid');
// ---------------------------------------------------------------------------
// Podcast Index does not hold Small Group Shows, so `/api/playlist` builds its
// container with no `podcastGuid` and a synthetic id — and then the episode's
// guid wins whatever order `speedShowKey` reads them in. A `podcastL` that PI
// holds carries its own guid; this gives the container the one its RSS declares
// (`<podcast:guid>`), at the wire, so the "episode's guid first" rule is tested.
if (want('1b')) {
  const page = await open('speed-podcastl-guid');
  const h = helpers(page);
  // In the page's own `fetch`, not CDP `Fetch`: the app's service worker makes
  // the network request, and a page-target interception never sees it.
  await h.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__rewritten = 0;
    const f = window.fetch;
    window.fetch = async function (input, init) {
      const res = await f.call(this, input, init);
      const u = typeof input === 'string' ? input : input && input.url;
      if (!u || !u.includes('/api/playlist?') || !res.ok) return res;
      const j = await res.clone().json();
      if (!j.podcast) return res;
      j.podcast.podcastGuid = ${JSON.stringify(LIST_GUID)};
      window.__rewritten++;
      return new Response(JSON.stringify(j), { status: res.status, headers: { 'content-type': 'application/json' } });
    };
  ` });
  await h.go(`${APP}/privacy`);
  await h.js(`(() => { localStorage.clear(); localStorage.setItem('bmb:playback_rate:${SHOW_A}', '1.5'); return true; })()`);
  await h.go(`${APP}/?playlist=${encodeURIComponent(LIST_URL)}`);
  t.ok('the playlist lists its rows', await h.until(`document.querySelectorAll('li button[aria-label="Play"]').length > 3`, 60000));
  const rewritten = await h.js('window.__rewritten');
  t.ok('the container was given its podcastGuid', rewritten > 0, `rewritten ${rewritten}`);
  const row = (title) => `(() => {
    const li = [...document.querySelectorAll('li')].find((x) => x.textContent.includes(${JSON.stringify(title)}) && x.querySelector('button[aria-label="Play"], button[aria-label="Resume"]'));
    const b = li?.querySelector('button[aria-label="Play"], button[aria-label="Resume"]'); b?.click(); return !!b; })()`;
  expectPlay('row "Episode 465" plays at Bowl After Bowl\'s 1.5×, not the global 1×', await h.pressAndPlay(row('Episode 465')), 1.5);
  t.ok('chip: the row to 2×', await h.chipTo(2));
  const s = await h.stored();
  t.equal('saved under Bowl After Bowl\'s guid', s[`bmb:playback_rate:${SHOW_A}`], '2');
  t.ok('nothing under the playlist\'s own guid', !(`bmb:playback_rate:${LIST_GUID}` in s), JSON.stringify(s));
  await page.done();
}

// ---------------------------------------------------------------------------
console.log('\n2. The queue: playFromQueue, Next in queue, a reveal on reload, and a real ended');
// ---------------------------------------------------------------------------
if (want('2')) {
  const page = await open('speed-queue');
  const h = helpers(page);
  await h.go(`${APP}/privacy`);
  // The key shape section 1 proved the writer uses.
  await h.js(`(() => { localStorage.clear();
    localStorage.setItem('bmb:playback_rate', '2');
    localStorage.setItem('bmb:playback_rate:${SHOW_A}', '1.5');
    localStorage.setItem('bmb:playback_rate:${SHOW_B}', '1');
    return true; })()`);
  const queueOne = `(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 350));
    for (const b of document.querySelectorAll('button[aria-label^="More actions for "]')) {
      b.click(); await tick();
      const add = document.querySelector('[aria-label^="Actions for "] button[aria-label^="Add "]');
      if (add) { add.click(); await tick(); return true; }
      b.click(); await tick();
    }
    return false; })()`;
  for (const g of [SHOW_A, SHOW_B, SHOW_C]) {
    await h.go(`${APP}/?podcast=${g}`);
    await h.until(`!!document.querySelector('button[aria-label^="More actions for "]')`, 30000);
    await wait(1500);
    t.ok(`queued one episode of ${g.slice(0, 8)}`, await h.js(queueOne));
  }
  const queue = await h.js(`JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]').map((q) => ({ title: q.episode.title, guid: q.episode.podcastGuid || q.podcast.podcastGuid, d: q.episode.duration }))`);
  t.equal('the queue holds A, B, C in order', queue.map((q) => q.guid), [SHOW_A, SHOW_B, SHOW_C]);


  // A queue row by its title. Found in JS, not CSS: titles carry quotes.
  const queueRow = (title) => `(() => {
    const b = [...document.querySelectorAll('li button')].find((x) => /^(Play|Resume) /.test(x.getAttribute('aria-label') || '')
      && x.getAttribute('aria-label').endsWith(${JSON.stringify(title)}));
    b?.click(); return !!b; })()`;
  const nowPlaying = async () => {
    const src = await h.srcNow();
    return { rate: await h.rateNow(), src, played: await h.js(`window.__media.filter((m) => m.type === 'playing' && m.src === ${JSON.stringify(src)}).map((m) => m.rate)`) };
  };

  // The Listen tab reveals the queue head without playing it (`revealQueue`).
  await h.go(`${APP}/listen`);
  await h.until(`(() => { const a = document.querySelector('audio'); return !!a && !!a.src; })()`, 30000);
  await wait(1500);
  const shown = await h.js(`document.querySelector('${MINI_BAR}')?.textContent ?? ''`);
  const revealed = queue.find((q) => shown.includes(q.title));
  t.equal('a fresh load of /listen reveals the queue head (A)', revealed?.guid, SHOW_A);
  t.equal('the revealed head sits at A\'s 1.5× before any press', await h.rateNow(), 1.5);

  await h.js(queueRow(queue[0].title));
  await h.until(h.playing, 30000);
  await wait(900);
  expectPlay('Resume the revealed head (A)', await nowPlaying(), 1.5);

  // A row press (`playFromQueue`) removes nothing, so these come before the
  // two forward motions, which each remove the item they leave.
  expectPlay('playFromQueue: A → C', await h.pressAndPlay(queueRow(queue[2].title)), 2);
  expectPlay('playFromQueue: C → A', await h.pressAndPlay(queueRow(queue[0].title)), 1.5);

  // "Next in queue" is offered once no chapter lies ahead, so pause near the end.
  await h.js(`(() => { const a = document.querySelector('audio'); a.pause(); a.currentTime = Math.max(0, a.duration - 5); return true; })()`);
  const offered = await h.until(`!!document.querySelector('${MINI_BAR} button[aria-label="Next in queue"]')`, 15000);
  if (offered) {
    const next = await h.pressAndPlay(`(() => { const b = document.querySelector('${MINI_BAR} button[aria-label="Next in queue"]'); b?.click(); return !!b; })()`);
    expectPlay('Next in queue (stepTo): A → B', next, 1);
  } else {
    t.fail('Next in queue is offered at the end of A', JSON.stringify(await h.js(`[...document.querySelectorAll('${MINI_BAR} button')].map((b) => b.getAttribute('aria-label'))`)));
  }
  const before = await h.srcNow();
  await h.js(`(() => { const a = document.querySelector('audio'); a.currentTime = Math.max(0, a.duration - 3); return true; })()`);
  const drained = await h.until(`(${h.playing}) && (document.querySelector('audio').currentSrc || '') !== ${JSON.stringify(before)}`, 60000);
  await wait(900);
  const src = await h.srcNow();
  const played = await h.js(`window.__media.filter((m) => m.type === 'playing' && m.src === ${JSON.stringify(src)}).map((m) => m.rate)`);
  expectPlay('a real ended (handlePlaybackEnded): B → C', drained ? { rate: await h.rateNow(), src, played } : { rate: null, why: 'no advance after ended' }, 2);
  await page.done();
}

// ---------------------------------------------------------------------------
console.log('\n3. A phone (390×844, mobile): the SPEED tile and the fast tiles');
// ---------------------------------------------------------------------------
if (want('3')) {
  const page = await open('speed-mobile', true);
  const h = helpers(page);
  await h.go(`${APP}/privacy`);
  await h.js(`(() => { localStorage.clear(); return true; })()`);

  expectPlay('phone: Bowl After Bowl, untouched', await h.playShow(SHOW_A), 1);
  t.ok('phone: the mini-bar has no SPEED chip below lg:', await h.js(`(() => { const c = document.querySelector('${MINI_BAR} button[aria-label^="Playback speed"]'); return !c || c.getBoundingClientRect().width === 0; })()`));
  const openMenu = async () => {
    await h.js(`document.querySelector('button[aria-label^="Open fullscreen player"]')?.click()`);
    await h.until(`!!document.querySelector('button[aria-label="More actions for this episode"]')`, 15000);
    await h.js(`document.querySelector('button[aria-label="More actions for this episode"]').click()`);
    return h.until(`!!document.querySelector('button[aria-label^="Playback speed 1"]')`, 10000);
  };
  t.ok('phone: the ⋯ menu shows the SPEED tile', await openMenu());
  const box = await h.js(`(() => { const r = [...document.querySelectorAll('button[aria-label*=", change to"]')].find((b) => b.getBoundingClientRect().width > 0).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  t.ok('phone: the SPEED tile is at least 24×24 CSS px', box && box.w >= 24 && box.h >= 24, JSON.stringify(box));
  const overflow = await h.js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  t.equal('phone: no horizontal overflow with the menu open', overflow, 0);

  await h.js(`[...document.querySelectorAll('button[aria-label*=", change to"]')].find((b) => b.getBoundingClientRect().width > 0).click()`);
  await wait(400);
  t.equal('phone: SPEED tile → 1.25×', await h.rateNow(), 1.25);
  let s = await h.stored();
  t.equal('phone: saved for the show and globally', s, { 'bmb:playback_rate': '1.25', [`bmb:playback_rate:${SHOW_A}`]: '1.25' });

  await h.js(`document.querySelector('button[aria-label="Playback speed 3.5×"]')?.click()`);
  await wait(400);
  t.equal('phone: the 3.5× tile', await h.rateNow(), 3.5);
  t.equal('phone: 3.5 saved for the show', (await h.stored())[`bmb:playback_rate:${SHOW_A}`], '3.5');
  await h.js(`document.querySelector('button[aria-label="Playback speed 3.5×, turn off"]')?.click()`);
  await wait(400);
  t.equal('phone: the lit 3.5× tile turns it off → 1×', await h.rateNow(), 1);
  s = await h.stored();
  t.equal('phone: 1× written for the show, the global key removed', s, { [`bmb:playback_rate:${SHOW_A}`]: '1' });

  expectPlay('phone: Podcasting 2.0 follows the global 1×', await h.playShow(SHOW_B), 1);
  t.ok('phone: menu open on Podcasting 2.0', await openMenu());
  await h.js(`document.querySelector('button[aria-label="Playback speed 5×"]')?.click()`);
  await wait(400);
  t.equal('phone: the 5× tile', await h.rateNow(), 5);
  expectPlay('phone: Bowl After Bowl keeps its 1× under a global 5×', await h.playShow(SHOW_A), 1);
  expectPlay('phone: a never-touched show takes the global 5×', await h.playShow(SHOW_C), 5);
  await page.done();
}

console.log(t.fails ? `\n${t.fails} of ${t.count} gap check(s) FAILED.` : `\nAll ${t.count} gap checks passed.`);
await exit(t.fails ? 1 : 0);
