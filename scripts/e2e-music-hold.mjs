// Drives the REAL <Player> over real feeds and reads the element's own
// `playbackRate` while the position moves through the songs of an episode.
//
// WHY THIS IS AN E2E AND NOT ONLY `check:vts`. `musicHoldSpans` is pinned there, and
// none of what breaks this feature is in it: the flag has to follow `timeupdate` and
// `seeked` on the element, the apply effect has to re-run without writing the store,
// the resolved list has to replace the raw one without a stale frame, and storage has
// to end up holding the speed the listener SET. Only the element proves any of that.
//
// Real data, on purpose (docs/superpowers/specs/2026-11-02-music-plays-at-1x-design.md):
//   Lightning Thrashes 111   ordinary markers, one a song at 3:16
//   Lightning Thrashes 110   113 minutes pointing at a podcast: must not hold
//   Homegrown Hits 122       5,643 minutes over a song of 3:25: must hold 3:25
//   Doerfel-Verse 79         no markers: stays at the set speed
//
// It can fail (2026-11-02): with the `set()` answer in `useMusicHold` removed, section
// 8's check on the commit that re-sources the element goes red, and only that one.
//
// WHAT IT CANNOT TELL YOU. A locked iPhone can suspend the page's JavaScript while
// the audio plays, an Android device in the background is untested, and the browser
// here is muted, so an audible click at the switch would pass.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:music-hold              # APP_URL=… for another port; ONLY=1,4 for some sections
//
// It needs the network: Podcast Index through the app's routes and each show's
// enclosures, and its enclosures must take a range request.
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const want = (s) => !ONLY || ONLY.has(String(s));

const LT = 'd5e73072-64a2-56a3-9dcd-4a00bfe561d5';
const LT111 = '63909310-a822-4275-b613-03aab65b7018';
const LT110 = '8a99d22c-a704-43e4-a47e-b1cd458e9571';
const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';
const HGH122 = 'e87b7884-0d52-4f02-9703-0c7528db203e';
const HGH122_ID = 49620264200;
const HGH_FEED = 6611624;
const DV = '41aace28-8679-5ef1-9958-75cf76c2b5f0';
const DV79 = '6774f51e-39a2-4965-989b-63fd8fc754ce';
/** A Wavlake single — `medium=music`, the one `e2e:speed` uses. */
const MUSIC = '225fa8a9-abc4-53ec-a133-2d3f10f1486e';

// Lightning Thrashes 111. 196+136 ends at 332 and the next song starts at 336: a gap
// under 5 s, so one hold from 196 to 651. The next song starts at 657, a gap of 6 s.
const TALK = 180;
const SONG_START = 196;
const SONG = 250;
const HOLD_END = 651;

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

const { page } = await launchChrome({ name: 'music-hold', autoplay: true, args: ['--window-size=1280,900'] });
const { send, js, until, on } = page;
const t = checker();
const finish = async () => {
  console.log(t.fails ? `\n${t.fails} music hold check(s) FAILED.` : '\nAll music hold checks passed.');
  await exit(t.fails ? 1 : 0);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
// Every write to a speed key, for the life of each page.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const set = Storage.prototype.setItem;
  window.__speedWrites = [];
  Storage.prototype.setItem = function (k, v) {
    if (String(k).startsWith('bmb:playback_rate')) window.__speedWrites.push(k + '=' + v);
    return set.call(this, k, v);
  };
  // The rate the lock-screen scrub bar was last told.
  window.__lockScreenRate = null;
  const pos = navigator.mediaSession?.setPositionState?.bind(navigator.mediaSession);
  if (pos) navigator.mediaSession.setPositionState = (s) => { window.__lockScreenRate = s?.playbackRate ?? null; pos(s); };
  // The speed once the commit that re-sourced the element has finished: a microtask
  // after the write to \`src\`, ahead of every media event. See section 8.
  window.__afterSrc = [];
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...src, set(v) {
    src.set.call(this, v);
    queueMicrotask(() => window.__afterSrc.push(this.playbackRate));
  } });
})()` });

const go = async (url) => { await send('Page.navigate', { url }); await wait(1200); };
const A = `document.querySelector('audio')`;
const rate = () => js(`${A}?.playbackRate ?? null`);
const position = () => js(`${A}?.currentTime ?? null`);
// The REAL seek bar, never a write to `currentTime`: `<Player>` reads a large jump
// back with no control behind it as the element having lost its buffer, and puts the
// playhead back (docs/ui.md, and `e2e:resume` section 7).
const scrub = (to) => js(`(() => {
  const r = document.querySelector('input[type=range][aria-label="Seek"]');
  if (!r) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(r, String(${to}));
  r.dispatchEvent(new Event('change', { bubbles: true }));
  r.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const seek = async (to) => {
  // The bar mounts after the element starts, and its `max` comes with the metadata.
  await until(`(() => { const r = document.querySelector('input[type=range][aria-label="Seek"]'); return !!r && Number(r.max) > ${to}; })()`, 30000);
  if (!await scrub(to)) t.fail('the seek bar is reachable');
  const landed = await until(`(() => { const a = ${A}; return !!a && !a.seeking && Math.abs(a.currentTime - ${to}) < 5; })()`, 30000);
  if (!landed) t.fail(`the seek reaches ${to}`, String(await position()));
  await wait(450);
};
const stored = () => js(`(() => { const o = {};
  for (const k of Object.keys(localStorage)) if (k.startsWith('bmb:playback_rate')) o[k] = localStorage.getItem(k);
  return o; })()`);
const seedSpeed = async (global, show) => {
  await go(`${APP}/privacy`);
  await js(`(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('bmb:')) localStorage.removeItem(k);
    if (${JSON.stringify(global)}) localStorage.setItem('bmb:playback_rate', ${JSON.stringify(global)});
    ${show ? `localStorage.setItem('bmb:playback_rate:${show[0]}', '${show[1]}');` : ''}
    return true; })()`);
};
/** Open one episode at one second through the `?t=` link and wait until it plays there. */
const open = async (show, episode, at) => {
  await go(`${APP}/?podcast=${show}&episode=${encodeURIComponent(episode)}&t=${at}`);
  await until(`(() => { const a = ${A}; return !!a && a.readyState >= 2 && a.currentTime > ${at - 2}; })()`, 60000);
  // A page load that finds something to reveal comes back parked at the second and
  // never calls `play()`: production does the same, and it is not what this tests.
  await wait(600);
  await js(`(() => { if (${A}?.paused) document.querySelector('${MINI_BAR} button[aria-label="Play"]')?.click(); return true; })()`);
  const ok = await until(`(() => { const a = ${A}; return !!a && a.readyState >= 2 && !a.paused && a.currentTime > ${at - 2}; })()`, 30000);
  if (!ok) t.fail(`the episode plays at ${at}`, JSON.stringify(await js(`(() => { const a = ${A}; return a && { t: a.currentTime, paused: a.paused, rs: a.readyState, src: a.src }; })()`)));
  return ok;
};
/** Until the element reaches `want`, polled faster than the 250 ms it updates at. */
const rateBecomes = (want, ms = 8000) => until(`${A}?.playbackRate === ${want}`, ms, 50);
/** Sample until the rate changes, and name the position it changed at. */
const flipAt = async (from, ms = 30000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const r = await js(`(() => { const a = ${A}; return { r: a.playbackRate, t: a.currentTime }; })()`);
    if (r && r.r !== from) return r;
    await wait(40);
  }
  return null;
};
const CHIP = `document.querySelector('${MINI_BAR} button[aria-label^="Playback speed"]')`;
const chipText = () => js(`${CHIP}?.textContent.trim() ?? null`);
const press = async () => { await js(`${CHIP}.click()`); await wait(300); };

if (want(1)) {
  console.log('1. A song at a set 2×, Lightning Thrashes 111: the boundaries, as the audio crosses them');
  await seedSpeed('2');
  if (await open(LT, LT111, TALK)) {
    await rateBecomes(2);
    t.equal('the talk plays at the set 2×', await rate(), 2);
    t.ok('the chip names 2× with no note in the talk', !(await js(`${CHIP}?.querySelector('[data-song-hold]')`)), await chipText());
    // Natural play: 16 s of content at 2× is 8 s of waiting. Nothing seeks.
    const down = await flipAt(2);
    t.equal('the audio drops to 1× on its own', down?.r, 1);
    t.ok(`no more than a beat of the song is at speed (dropped at ${down?.t?.toFixed(2)}, the song starts at ${SONG_START})`,
      down && down.t <= SONG_START + 0.3 && down.t >= SONG_START - 1.5, JSON.stringify(down));
    t.equal('the store still says the listener set 2×', (await stored())['bmb:playback_rate'], '2');
    t.ok('the chip keeps naming 2× and says the song plays at 1×', (await chipText())?.startsWith('2×') && (await chipText())?.includes('♪1×'), await chipText());
    t.ok('the chip\'s label states both speeds',
      /2×, this song plays at 1×/.test(await js(`${CHIP}.getAttribute('aria-label')`)), await js(`${CHIP}.getAttribute('aria-label')`));

    await seek(HOLD_END - 3);
    t.equal('a song near its end is still 1×', await rate(), 1);
    const up = await flipAt(1);
    t.equal('the set speed comes back on its own', up?.r, 2);
    t.ok(`the song is not cut short (went up at ${up?.t?.toFixed(2)}, the hold ends at ${HOLD_END})`,
      up && up.t >= HOLD_END - 0.1 && up.t <= HOLD_END + 1, JSON.stringify(up));
    t.ok('the note goes when the song ends', !(await js(`${CHIP}?.querySelector('[data-song-hold]')`)), await chipText());

    // The 4-second gap between 332 and 336 must not flip the rate.
    await seek(334);
    t.equal('a 4-second gap between two songs stays at 1×', await rate(), 1);
    await seek(SONG);
    t.equal('a seek into a song → 1×', await rate(), 1);
    t.ok('the lock screen is told 1×', await until(`window.__lockScreenRate === 1`, 3000), String(await js(`window.__lockScreenRate`)));
    await seek(TALK);
    t.equal('a seek out of a song → 2×', await rate(), 2);
    t.ok('the lock screen is told 2×', await until(`window.__lockScreenRate === 2`, 3000), String(await js(`window.__lockScreenRate`)));
    await seek(SONG);
    t.equal('a seek back in → 1×', await rate(), 1);

    const writes = await js(`window.__speedWrites`);
    t.equal('nothing wrote a speed in all of that', JSON.stringify(writes), '[]');
  }
}

if (want(2)) {
  console.log('\n2. A press during a song changes the speed SET, and it starts when the song ends');
  await seedSpeed('2');
  if (await open(LT, LT111, SONG)) {
    await rateBecomes(1);
    t.equal('in a song at a set 2×', await rate(), 1);
    await press(); // 2× → 1×
    await press(); // 1× → 1.25×
    t.equal('the song stays at 1× through two presses', await rate(), 1);
    const s = await stored();
    t.equal('the press saved the speed for the show', s[`bmb:playback_rate:${LT}`], '1.25');
    t.equal('and globally', s['bmb:playback_rate'], '1.25');
    t.ok('the chip names the new speed', (await chipText())?.startsWith('1.25×'), await chipText());
    await seek(TALK);
    t.equal('the talk after it plays at the new speed', await rate(), 1.25);

    await press(); // 1.25× → 1.5×
    t.equal('a press in the talk applies at once', await rate(), 1.5);
    await seek(SONG);
    t.equal('and the song is 1× again', await rate(), 1);
  }

  console.log('\n   …and with the set speed at 1×, the note has nothing to say');
  await seedSpeed(null);
  if (await open(LT, LT111, SONG)) {
    await rateBecomes(1);
    t.ok('no note at a set 1×', !(await js(`${CHIP}?.querySelector('[data-song-hold]')`)), await chipText());
    t.equal('and the label says only 1×', (await js(`${CHIP}.getAttribute('aria-label')`)).includes('this song'), false);
  }
}

if (want(3)) {
  console.log('\n3. A reload during a song: the 1× is never saved');
  await seedSpeed('2', [LT, '2']);
  if (await open(LT, LT111, SONG)) {
    await rateBecomes(1);
    t.equal('in the song', await rate(), 1);
    await open(LT, LT111, SONG);
    await rateBecomes(1);
    t.equal('in the song after the reload', await rate(), 1);
    const s = await stored();
    t.equal('the show keeps its own 2×', s[`bmb:playback_rate:${LT}`], '2');
    t.equal('the global stays 2×', s['bmb:playback_rate'], '2');
    t.equal('nothing wrote a speed', JSON.stringify(await js(`window.__speedWrites`)), '[]');
    await seek(TALK);
    t.equal('the talk after the reload is 2×', await rate(), 2);
  }
}

if (want(4)) {
  console.log('\n4. A pause during a song, and a seek while paused');
  await seedSpeed('2');
  if (await open(LT, LT111, SONG)) {
    await rateBecomes(1);
    await js(`${A}.pause()`);
    await wait(400);
    t.equal('paused in a song, still 1×', await rate(), 1);
    await scrub(TALK);
    t.ok('a seek out while paused reaches 2×', await rateBecomes(2), String(await rate()));
    t.equal('and it is still paused', await js(`${A}.paused`), true);
    await scrub(SONG);
    t.ok('a seek in while paused reaches 1×', await rateBecomes(1), String(await rate()));
    await js(`${A}.play()`);
    await wait(800);
    t.equal('it plays on at 1×', await rate(), 1);
  }
}

if (want(5)) {
  console.log('\n5. The fast speeds: 3.5× and 5×');
  for (const fast of ['3.5', '5']) {
    await seedSpeed(fast);
    if (await open(LT, LT111, SONG)) {
      await rateBecomes(1);
      t.equal(`in a song at a set ${fast}×`, await rate(), 1);
      t.ok(`the chip names ${fast}× and says the song plays at 1×`,
        (await chipText())?.startsWith(`${fast}×`) && (await chipText())?.includes('♪1×'), await chipText());
      await seek(TALK);
      t.equal(`the talk plays at ${fast}×`, await rate(), Number(fast));
      // 16 s of content, well under 5 s of waiting: the case the lead is for.
      const down = await flipAt(Number(fast));
      t.equal('it drops to 1× on its own', down?.r, 1);
      t.ok(`no more than a beat of the song is at speed (dropped at ${down?.t?.toFixed(2)})`,
        down && down.t <= SONG_START + 0.6, JSON.stringify(down));
      t.equal('the fast speed stays saved', (await stored())['bmb:playback_rate'], fast);
    }
  }
}

if (want(6)) {
  console.log('\n6. Real markers that lie, and an episode with none');
  await seedSpeed('2');
  if (await open(LT, LT110, 5000)) {
    await wait(4000); // Long enough for the list to answer.
    t.equal('Lightning Thrashes 110: 113 minutes pointing at a podcast does not hold', await rate(), 2);
    t.ok('and the position is inside that marker', (await position()) > 3799, String(await position()));
    await seek(3500);
    t.equal('its real song before it does', await rate(), 1);
  }

  const answer = await js(`fetch('/api/value-splits?feedId=${HGH_FEED}&episodeId=${HGH122_ID}').then((r) => r.json())`);
  const bad = answer?.splits?.find((x) => x.startTime === 1862);
  t.equal('/api/value-splits gives the bad marker its song\'s length', bad?.trackDuration, 205);
  t.equal('and its feed\'s medium', bad?.feedMedium, 'music');
  t.equal('and leaves the host\'s declaration empty', bad?.remoteItem?.medium, undefined);
  t.equal('and keeps the bad length, which pays people', bad?.duration, 338617);
  t.equal('and drops no marker', answer?.splits?.length, 14);

  await seedSpeed('2');
  if (await open(HGH, HGH122, 1900)) {
    t.ok('Homegrown Hits 122: the song under a 5,643-minute marker holds, once the list answers',
      await rateBecomes(1, 20000), String(await rate()));
    await seek(2060);
    t.equal('it still holds at the end of the song', await rate(), 1);
    await seek(2400);
    t.equal('the next song holds too (they overlap)', await rate(), 1);
    await seek(2500);
    t.equal('the talk after them is not held by the bad marker', await rate(), 2);
    await seek(3000);
    t.equal('a later song', await rate(), 1);
  }

  await seedSpeed('2');
  if (await open(DV, DV79, 500)) {
    await wait(2000);
    t.equal('Into The Doerfel-Verse 79: no markers, the set speed all the way', await rate(), 2);
  }
}

if (want(7)) {
  console.log('\n7. The list blocked, as offline: the markers on the episode, under the cap');
  await send('Network.setBlockedURLs', { urls: ['*/api/value-splits*'] });
  await seedSpeed('2');
  if (await open(LT, LT111, SONG)) {
    t.ok('an ordinary song still holds', await rateBecomes(1), String(await rate()));
    await seek(TALK);
    t.equal('the talk is 2×', await rate(), 2);
  }
  await seedSpeed('2');
  if (await open(LT, LT110, 5000)) {
    await wait(1500);
    t.equal('a marker over the cap does not hold through the talk', await rate(), 2);
  }
  await seedSpeed('2');
  if (await open(HGH, HGH122, 1900)) {
    await wait(1500);
    t.equal('the song under a bad marker plays at speed: the known cost of no list', await rate(), 2);
  }
  await send('Network.setBlockedURLs', { urls: [] });
}

if (want(8)) {
  console.log('\n8. Moving between episodes in one session');
  await seedSpeed('2');
  await go(`${APP}/?podcast=${LT}`);
  // By name, not by place: this show's first row is often its 24-hour live item.
  const ROW = (i) => `[...document.querySelectorAll('li button[aria-label="Play"]:not([disabled])')].find((b) => b.closest('li').innerText.includes('${i === 0 ? '111 - Lightning' : '110 - Lightning'}'))`;
  if (await until(`!!${ROW(1)} && !!${ROW(0)}`, 30000)) {
    await js(`${ROW(0)}.click()`);
    await until(`(() => { const a = ${A}; return !!a && a.readyState >= 1 && !a.paused; })()`, 60000);
    // Every `playing` of the element, with the speed it had at that moment.
    await js(`(() => { window.__plays = []; const a = ${A};
      a.addEventListener('playing', () => window.__plays.push({ src: a.src, rate: a.playbackRate, t: a.currentTime }));
      return true; })()`);
    await seek(SONG);
    t.equal('the newest episode, in a song', await rate(), 1);
    await wait(11000); // The resume writer saves every 10 s of movement.
    const firstSrc = await js(`${A}.src`);
    await js(`(() => { window.__plays = []; window.__afterSrc = []; return true; })()`);
    await js(`${ROW(1)}.click()`);
    const moved = await until(`(() => { const a = ${A}; return a.src !== ${JSON.stringify(firstSrc)} && a.readyState >= 2 && !a.paused && window.__plays.length > 0; })()`, 60000);
    t.ok('the next episode plays', moved);
    // Lightning Thrashes 110 opens with talk until 0:07.
    const first = (await js(`window.__plays`))[0];
    t.ok(`it starts in talk (at ${first?.t})`, first && first.t < 5, JSON.stringify(first));
    t.equal('the new source never played at the song\'s 1×', first?.rate, 2);
    // Chromium fires `timeupdate` at 0 on a new source ahead of `playing`, so the check
    // above also passes with the `set()` answer in `useMusicHold` removed. This one does
    // not: the speed is right in the commit that re-sourced the element, before any event.
    t.equal('it has the set speed in the commit that re-sourced it', (await js(`window.__afterSrc`))[0], 2);

    await js(`(() => { window.__plays = []; return true; })()`);
    await js(`${ROW(0)}.click()`);
    const back = await until(`window.__plays.length > 0`, 60000);
    t.ok('back on the first episode', back);
    await wait(800);
    t.ok('it resumes inside the song', (await position()) > SONG_START, String(await position()));
    t.equal('and at 1×', await rate(), 1);
    t.equal('the set speed never moved', (await stored())['bmb:playback_rate'], '2');
    t.equal('nothing wrote a speed', JSON.stringify(await js(`window.__speedWrites`)), '[]');
  } else {
    t.fail('the show lists two playable episodes');
  }
}

if (want(9)) {
  console.log('\n9. An album track and a live item: 1×, and no control');
  await seedSpeed('2');
  await go(`${APP}/?podcast=${MUSIC}`);
  if (await until(`!!document.querySelector('li button[aria-label="Play"]:not([disabled])')`, 30000)) {
    await js(`document.querySelector('li button[aria-label="Play"]:not([disabled])').click()`);
    await until(`(() => { const a = ${A}; return !!a && a.readyState >= 1 && !a.paused; })()`, 60000);
    await wait(800);
    t.equal('an album track under a set 2× plays at 1×', await rate(), 1);
    t.ok('with no chip', await js(`!${CHIP}`));
    t.equal('and the set speed is kept for the next podcast', (await stored())['bmb:playback_rate'], '2');
  } else {
    t.fail('the music feed lists a playable track');
  }

  // A live item nobody has to be on air for: the same feed, its first row told it
  // is live, whatever it is today. Lightning Thrashes runs a 24-hour live item, and
  // this keeps the section when that stops. The plain-enclosure kind, on the <audio>.
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/feed*', requestStage: 'Response' }, { urlPattern: '*/api/live-status*', requestStage: 'Response' }] });
  const off = on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    void (async () => {
      const got = await send('Fetch.getResponseBody', { requestId });
      const text = got.result?.base64Encoded ? Buffer.from(got.result.body, 'base64').toString() : got.result?.body;
      let body = text;
      if (request.url.includes('/api/feed')) {
        const j = JSON.parse(text);
        if (j.episodes?.[0]) j.episodes[0] = { ...j.episodes[0], liveStatus: 'live' };
        body = JSON.stringify(j);
      }
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(body).toString('base64'),
      });
    })().catch(() => send('Fetch.continueRequest', { requestId }).catch(() => {}));
  });
  await seedSpeed('2');
  await go(`${APP}/?podcast=${LT}`);
  if (await until(`!!document.querySelector('li button[aria-label="Play"]:not([disabled])')`, 30000)) {
    await js(`document.querySelector('li button[aria-label="Play"]:not([disabled])').click()`);
    await until(`(() => { const a = ${A}; return !!a && a.readyState >= 1 && !a.paused; })()`, 60000);
    await wait(1000);
    t.equal('a live item under a set 2× plays at 1×', await rate(), 1);
    t.ok('with no chip', await js(`!${CHIP}`));
    t.ok('and no note anywhere', await js(`!document.querySelector('[data-song-hold]')`));
  } else {
    t.fail('the stubbed show lists a playable row');
  }
  off();
  await send('Fetch.disable');
}

if (want(10)) {
  console.log('\n10. The label on a phone (390×844, device emulation) and on the desktop bar');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  const MORE = 'button[aria-label="More actions for this episode"]';
  const openMenu = async () => {
    await js(`document.querySelector('button[aria-label^="Open fullscreen player"]')?.click()`);
    await until(`!!document.querySelector('${MORE}')`, 15000);
    // See `e2e:speed`: the ⋯ slides up from below the screen, and the menu measures
    // the trigger once. Wait until two reads, a poll apart, agree.
    await js(`(() => { window.__moreAt = null; return true; })()`);
    await until(`(() => { const r = document.querySelector('${MORE}')?.getBoundingClientRect();
      if (!r || r.top < 0 || r.bottom > innerHeight) return false;
      const at = Math.round(r.top) + ':' + Math.round(r.left); const same = window.__moreAt === at; window.__moreAt = at; return same; })()`, 15000);
    await js(`document.querySelector('${MORE}').click()`);
    return until(`!!document.querySelector('[role="menu"] [data-song-hold]')`, 10000);
  };
  const measure = () => js(`(() => {
    const note = document.querySelector('[role="menu"] [data-song-hold]');
    const tile = note?.closest('button');
    const nr = note?.getBoundingClientRect(); const tr = tile?.getBoundingClientRect();
    const slider = document.querySelector('[role="menu"] input[type="range"]');
    return { noteW: nr?.width, tileW: tr?.width, tileH: tr?.height,
      noteInside: !!nr && nr.left >= tr.left + 1 && nr.right <= tr.right - 1,
      tileScroll: tile ? tile.scrollWidth <= tile.clientWidth : null,
      text: tile?.innerText.replace(/\\s+/g, ' ').trim(), label: tile?.getAttribute('aria-label'),
      valuetext: slider?.getAttribute('aria-valuetext'),
      docW: document.documentElement.scrollWidth, viewW: document.documentElement.clientWidth };
  })()`);
  for (const speed of ['2', '1.75', '5']) {
    await seedSpeed(speed);
    if (await open(LT, LT111, SONG)) {
      await rateBecomes(1);
      t.ok(`phone at a set ${speed}×: the ⋯ menu shows the note`, await openMenu());
      const m = await measure();
      console.log(`      ${JSON.stringify(m)}`);
      t.ok(`the note fits inside the tile at ${speed}×`, m.noteInside && m.tileScroll, JSON.stringify(m));
      t.ok('the tile is at least 24×24', m.tileW >= 24 && m.tileH >= 24, JSON.stringify(m));
      t.ok('the page does not overflow', m.docW <= m.viewW, `${m.docW} > ${m.viewW}`);
      t.ok('the tile\'s label states the song\'s speed', m.label?.includes('this song plays at 1×'), m.label);
      t.equal('the slider names the true speed', m.valuetext, `${speed}×, this song plays at 1×`);
    }
  }
  await seedSpeed('2');
  await go(`${APP}/?podcast=${MUSIC}`);
  if (await until(`!!document.querySelector('li button[aria-label="Play"]:not([disabled])')`, 30000)) {
    await js(`document.querySelector('li button[aria-label="Play"]:not([disabled])').click()`);
    await until(`(() => { const a = ${A}; return !!a && a.readyState >= 1 && !a.paused; })()`, 60000);
    await js(`document.querySelector('button[aria-label^="Open fullscreen player"]')?.click()`);
    await until(`!!document.querySelector('${MORE}')`, 15000);
    await wait(1500);
    await js(`document.querySelector('${MORE}').click()`);
    await until(`!!document.querySelector('[role="menu"]')`, 10000);
    await wait(300);
    t.ok('phone, an album track: the menu has no speed control',
      await js(`!document.querySelector('[role="menu"] button[aria-label^="Playback speed"], [role="menu"] input[type="range"]')`));
  }

  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  for (const speed of ['1.75', '5']) {
    await seedSpeed(speed);
    if (await open(LT, LT111, SONG)) {
      await rateBecomes(1);
      await wait(500);
      const bar = await js(`(() => {
        const chip = ${CHIP}; const r = chip?.getBoundingClientRect(); const b = document.querySelector('${MINI_BAR}');
        return { text: chip?.textContent.trim(), w: r?.width, h: r?.height, right: r?.right,
          barScroll: b ? b.scrollWidth <= b.clientWidth : null, docW: document.documentElement.scrollWidth, viewW: document.documentElement.clientWidth };
      })()`);
      console.log(`      ${JSON.stringify(bar)}`);
      t.ok(`the chip at 1024 wide reads ${speed}× ♪1×`, bar.text?.startsWith(`${speed}×`) && bar.text?.includes('♪1×'), bar.text);
      t.ok('the bar does not overflow', bar.barScroll && bar.docW <= bar.viewW && bar.right <= bar.viewW, JSON.stringify(bar));
    }
  }
}

await finish();
