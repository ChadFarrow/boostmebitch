// Drives the REAL <Player> in a real browser and asserts where an episode
// resumes, and what `bmb:resume` holds at each step.
//
// WHY THIS IS AN E2E AND NOT A `check:*`. The rules in lib/resume-position.ts
// are two thresholds and a key; the ways this feature breaks are all in the
// WIRING between the store, the writer's subscription and the source effect:
//
// - a new source's first `timeupdate` reports ~0 BEFORE `loadedmetadata` seeks,
//   and a writer that recorded it would erase the saved point during the very
//   load that returns the listener to it. It is a transient that lasts about
//   as long as `loadedmetadata` takes — well under 100 ms on a warm element —
//   so neither an endpoint read nor a poll sees it: step 4 wraps
//   `Storage.prototype.setItem` and records EVERY value written. And it
//   happens only IN-SESSION: Chromium fires `emptied` then `timeupdate@0.0`
//   when the source changes on an element that was somewhere else, which a
//   freshly loaded page never is. Measured, with the 15 s floor set to 0:
//   a reload and a 100 ms poll both passed that broken build.
// - the OUTGOING episode must be flushed from the store's `prev` state when
//   another one starts, because `play()` replaces `current` and `positionSec`
//   in one update. Step 3 moves the head less than the periodic-write distance
//   first, so only that flush can account for the value it reads.
// - `ended` deletes the entry through the pause flush, with no code in
//   `onEnded` — nothing but a real element reaching its end proves that.
//
// It also pins the two things the feature must NOT do: an explicit start (a
// chapter tap) outranks the saved point, and a music track saves nothing.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:resume                  # add --headed to watch it
//
// It needs the network: the episode's own enclosure and chapters JSON, and
// Podcast Index through the app's routes. If Bowl After Bowl 456 ever leaves
// the feed, pick any long episode with a chapters JSON and update the constants;
// if the music feed goes, any `medium=music` feed will do.
//
// The browser comes from scripts/cdp.mjs: CHROME_PATH, else the usual install
// paths. It is muted and on a free debug port, so a leftover browser can
// neither answer for this run nor be heard, and it is closed on any exit.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';

/** Bowl After Bowl 456: over two hours, with a chapters JSON. */
const POD = '2d418249-453a-5714-8abc-5b657570b641';
const EPISODE_GUID = 'https://bowlafterbowl.com/episodes/episode-456/';
const CHAPTER = 'Behind the Curtain';
const CHAPTER_START = 9521.629;
/** A Wavlake single — `medium=music`, so `playsAsTracks`. */
const MUSIC = '225fa8a9-abc4-53ec-a133-2d3f10f1486e';

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

const { page } = await launchChrome({ name: 'resume', autoplay: true, args: ['--window-size=1200,900'] });
const { send, js, until } = page;

const t = checker();
const check = (label, ok, detail) => t.ok(label, ok, detail);
const finish = async () => {
  console.log(t.fails ? `\n${t.fails} resume check(s) FAILED.` : '\nAll resume checks passed.');
  await exit(t.fails ? 1 : 0);
};
const go = async (url) => { await send('Page.navigate', { url }); await wait(1500); };

// `textContent`, not `innerText`: the app uppercases labels in CSS and
// innerText reports the rendered case.
const EP_KEY = `::${EPISODE_GUID}`;
/** The stored entry for episode 456, or null. */
const entry = () => js(`(() => { const m = JSON.parse(localStorage.getItem('bmb:resume') || '{}');
  const k = Object.keys(m).find(k => k.endsWith(${JSON.stringify(EP_KEY)})); return k ? m[k] : null; })()`);
const playButton = `[...document.querySelectorAll('button')].find(b => /^▶ (PLAY|RESUME)/.test(b.textContent.trim()))`;
const audioState = () => js(`(() => { const a = document.querySelector('audio');
  return a ? { t: a.currentTime, d: a.duration, paused: a.paused, ended: a.ended, ready: a.readyState } : null; })()`);
const setTime = (t) => js(`(() => { document.querySelector('audio').currentTime = ${t}; return true; })()`);
const pause = () => js(`(() => { const b = document.querySelector('button[aria-label="Pause"]'); b && b.click(); return !!b; })()`);
const playing = `(() => { const a = document.querySelector('audio'); return a && a.readyState >= 1 && !a.paused; })()`;
/** From the episode page back to the show's list, in-app (no page load, so no
 *  `pagehide` flush to muddy what a step measures). */
const backToList = async () => {
  await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => /back to episodes/i.test(b.textContent)); b && b.click(); return !!b; })()`);
  await until(`document.querySelectorAll('li button[aria-label="Play"]').length > 1`);
};
let title = '';
/** Press play on the first row that is not episode 456. */
const playOtherRow = () => js(`(() => {
  const li = [...document.querySelectorAll('li')].find(l => l.querySelector('button[aria-label="Play"]') && !l.textContent.includes(${JSON.stringify(title)}));
  if (!li) return false; li.querySelector('button[aria-label="Play"]').click(); return true; })()`);
/** Open episode 456's page from its row. */
const openOwnRow = () => js(`(() => { const li = [...document.querySelectorAll('li')].find(l => l.textContent.includes(${JSON.stringify(title)}));
  const b = li && [...li.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(title)})); (b || li)?.click(); return !!li; })()`);

await send('Page.enable');
await send('Runtime.enable');
await go(`${APP}/privacy`);
await js(`(() => { localStorage.clear(); return true; })()`);

console.log('1. Play, move to 5:00, pause — the pause writes the place');
await go(`${APP}/?podcast=${POD}&episode=${encodeURIComponent(EPISODE_GUID)}`);
if (!await until(`!!${playButton}`)) { check('the episode page renders a PLAY button', false, 'no button'); await finish(); }
title = await js(`document.querySelector('h2')?.textContent.trim()`);
await js(`${playButton}.click()`);
check('the episode starts playing', await until(playing), JSON.stringify(await audioState()));
await setTime(300);
await wait(2500);
await pause();
await wait(800);
let e = await entry();
check('bmb:resume holds ~300 s for the episode', e && e.t >= 299 && e.t < 306, JSON.stringify(e));

console.log('\n2. Reload — the page offers the saved place, and playing starts there');
await go(`${APP}/?podcast=${POD}&episode=${encodeURIComponent(EPISODE_GUID)}`);
await until(`!!${playButton}`);
const label = await js(`${playButton}.textContent.trim()`);
// 5:0x, not 5:00: the episode kept playing for the 2.5 s before the pause.
check('the button reads "▶ RESUME 5:0x"', /^▶ RESUME 5:0\d$/.test(label ?? ''), `read: ${label}`);
await js(`${playButton}.click()`);
await until(playing);
await wait(5000);
const a2 = await audioState();
check('the element resumed at ~5:00', a2 && a2.t >= 299 && a2.t < 320, JSON.stringify(a2));

console.log('\n3. Start another episode — the outgoing one is flushed from the store');
await setTime(600);
await wait(2500);
// Under the periodic-write distance from 600, so the store moves and nothing
// else writes: only the episode-change flush can put ~605+ on disk.
await setTime(605);
await wait(2000);
e = await entry();
check('no periodic write inside the 10 s distance', e && e.t < 604, JSON.stringify(e));
await backToList();
check('another episode row was started', await playOtherRow(), 'no other row with a Play button');
await wait(1500);
e = await entry();
check('the first episode was saved at ~605 when it was replaced', e && e.t >= 604 && e.t < 615, JSON.stringify(e));
const rowText = await js(`(() => { const li = [...document.querySelectorAll('li')].find(l => l.textContent.includes(${JSON.stringify(title)})); return li ? li.textContent : null; })()`);
check('its row says how much is left', !!rowText && /min left/.test(rowText), rowText ? rowText.slice(0, 160) : 'row not in the list');

console.log('\n4. Resume it in-session — the switch does not erase the saved place');
// The other episode must be somewhere other than 0 when the source changes,
// or the element has no transient 0 to report.
await wait(3000);
await openOwnRow();
await until(`!!${playButton}`);
const label4 = await js(`${playButton}.textContent.trim()`);
check('the button reads "▶ RESUME 10:0x"', /^▶ RESUME 10:[01]\d$/.test(label4 ?? ''), `read: ${label4}`);
await js(`(() => { window.__low = Infinity; window.__writes = 0;
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'bmb:resume') { window.__writes++; const m = JSON.parse(v);
      const key = Object.keys(m).find(x => x.endsWith(${JSON.stringify(EP_KEY)}));
      window.__low = Math.min(window.__low, key ? m[key].t : -1); }
    return set.call(this, k, v);
  };
  window.__unwrap = () => { Storage.prototype.setItem = set; };
  return true; })()`);
await js(`${playButton}.click()`);
await until(playing);
await wait(5000);
const low = await js(`(() => { window.__unwrap(); return window.__low; })()`);
const writes = await js(`window.__writes`);
check('the switch wrote bmb:resume at least once', writes > 0, `writes: ${writes}`);
const a4r = await audioState();
check('the element resumed at ~10:05', a4r && a4r.t >= 604 && a4r.t < 625, JSON.stringify(a4r));
check('no write during the switch lowered the saved place', low >= 600, `lowest written: ${low} (-1 = entry deleted)`);

console.log('\n5. A chapter tap outranks the saved place');
// The episode must not be current, or a chapter tap seeks in place instead of
// calling play(). Start the other one again first.
await backToList();
check('the other episode was started again', await playOtherRow(), 'no other row with a Play button');
await wait(1500);
await openOwnRow();
await until(`!!${playButton}`);
await js(`(() => { const t = [...document.querySelectorAll('button, [role="tab"]')].find(b => /^Chapters/i.test(b.textContent.trim())); t && t.click(); return !!t; })()`);
await wait(1000);
const tapped = await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(CHAPTER)})); b && b.click(); return !!b; })()`);
check(`the "${CHAPTER}" chapter row exists`, tapped, 'no chapter button');
await until(playing);
await wait(4000);
const a4 = await audioState();
check('playback started at the chapter, not at ~605', a4 && Math.abs(a4.t - CHAPTER_START) < 20, JSON.stringify(a4));

console.log('\n6. Play to the end — the entry is deleted');
const d = (await audioState())?.d;
await setTime(d - 4);
const ended = await until(`document.querySelector('audio')?.ended`, 20000);
check('the element reached its end', ended, JSON.stringify(await audioState()));
await wait(800);
e = await entry();
check('bmb:resume no longer holds the episode', e === null, JSON.stringify(e));

console.log('\n7. An element that came back at 0 does not erase a place minutes in');
// Reported 2026-09-21 on an iPhone, with the download still present so nothing
// was evicted: "I did resume the episode earlier without an issue but the
// second time I tried minutes later it started over."
//
// iOS drops a backgrounded media element's buffer and it returns sitting at 0
// while storage still holds 17:04. Nothing re-seeks it, so play runs from the
// beginning — and fifteen seconds later the writer has replaced 17:04 with 16,
// then 26. The RESUME_MIN_SEC floor is the only reason the FIRST attempt still
// worked: under 15 s nothing is written at all. That is a fifteen-second window
// in which an hour of listening is destroyed by doing nothing.
//
// THIS RUNS IN THE REAL WIRING AND NOT UNDER strip-types, because
// lib/resume-position.ts imports lib/storage and will not load under plain
// Node — the same reason this whole feature is an e2e rather than a check:*.
await go(`${APP}/?podcast=${POD}&episode=${encodeURIComponent(EPISODE_GUID)}`);
await until(`!!${playButton}`);
await js(`${playButton}.click()`);
await until(playing);
await setTime(1024);
await wait(2500);
let deep = await entry();
check('a place 17 minutes in is saved', deep && deep.t >= 1020 && deep.t < 1040, JSON.stringify(deep));

// The element comes back at the start and plays on through the 15 s floor.
for (const at of [16, 40, 90]) { await setTime(at); await wait(1600); }
const kept = await entry();
check('playing from the start does NOT erase it', kept && kept.t >= 1020, JSON.stringify(kept));
// ...and it is still what a fresh play would resume to.
await pause();
await wait(800);
const afterPause = await entry();
check('...not even the pause flush erases it', afterPause && afterPause.t >= 1020, JSON.stringify(afterPause));

// Past the two-minute head the listener plainly means it, and the point moves.
await js(`${playButton}.click()`);
await until(playing);
await setTime(150);
await wait(2500);
const moved = await entry();
check('past the head, a deliberate restart moves the point', moved && moved.t >= 148 && moved.t < 200, JSON.stringify(moved));
// A mid-episode rewind is never refused: the guard needs BOTH a large jump and
// a position near the beginning.
await setTime(3000);
await wait(2000);
await setTime(2400);
await wait(2500);
const scrubbed = await entry();
check('a mid-episode rewind still saves', scrubbed && scrubbed.t >= 2395 && scrubbed.t < 2450, JSON.stringify(scrubbed));
await pause();
await wait(600);

console.log('\n8. A music track saves nothing');
await go(`${APP}/?podcast=${MUSIC}`);
await until(`!!document.querySelector('li button[aria-label="Play"]')`);
await js(`document.querySelector('li button[aria-label="Play"]').click()`);
check('the track starts playing', await until(playing), JSON.stringify(await audioState()));
const md = (await audioState())?.d;
await setTime(Math.min(60, Math.max(20, (md || 120) / 2)));
await wait(2500);
await pause();
await wait(800);
const musicKeys = await js(`Object.keys(JSON.parse(localStorage.getItem('bmb:resume') || '{}')).filter(k => k.startsWith(${JSON.stringify(MUSIC)}))`);
check('no entry for the music feed', Array.isArray(musicKeys) && musicKeys.length === 0, JSON.stringify(musicKeys));

await finish();
