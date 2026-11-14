// On Android the lock-screen player must not vanish at a track change.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:androidkeeper                     # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:androidkeeper -- --headed --keep
//
// THE FAULT IT WAS WRITTEN AGAINST (2026-11-14, Chad's Android phone, the Boost
// Me Buddy Zapstore app, a favorites shuffle): the lock-screen player vanished
// for a moment at every track change — ⏭ and a song ending alike — and came
// back when the next song started. Chrome's lock-screen player belongs to the
// page's media session, which is active only while it holds a media player;
// a new `src` on `<Player>`'s one `<audio>` destroys the player behind it, and
// a track that ENDS leaves the session even before that. So the session sat
// empty until the next file played.
//
// No headless Chrome draws a lock screen, so this pins the MECHANISM through
// the CDP Media domain, which reports every media player and its events:
//
//   1. With an Android user agent, playing starts a second player: a 10 s
//      silent loop from a `blob:` URL (`useAndroidSessionKeeper`). Longer than
//      5 s, or Chrome would count it a one-shot player and disable the
//      lock-screen controls.
//   2. It plays straight through a track that ENDS and through ⏭: no pause, no
//      destroy, while the main player is replaced for each new file. So the
//      session always holds a playing player.
//   3. It pauses with the app, and plays again with it — or the lock screen
//      would draw ❚❚ over a paused app.
//   4. With a desktop user agent there is no second player at all.
//
// NOT DRIVEN: the lock screen itself, on a real Android phone. That needs
// Chad's phone, on beta.
//
// Every request the player makes for this album is answered here. Nothing
// reaches Podcast Index.

import { checker, exit, launchChrome, MINI_BAR, requireApp, wait } from './cdp.mjs';

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
const AUDIO = silentWav(30);

const GUID = 'a4d40000-0000-4000-8000-000000000001';
const ID = 900777;
const ALBUM = {
  id: ID, podcastGuid: GUID, title: 'E2E Keeper Album', author: 'e2e', medium: 'music',
  url: 'https://feeds.example.invalid/keeper.xml',
};
const TRACKS = [0, 1, 2, 3].map((k) => ({
  id: 9700 + k, guid: `a4d40000-0000-4000-8000-00000000010${k}`, podcastGuid: GUID, feedId: ID,
  title: `Keeper test track ${k}`, episode: k + 1, duration: 30,
  enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
}));
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';

const { page } = await launchChrome({ name: 'androidkeeper', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

// Every media player Chrome reports: its first URL, its duration, and the
// ordered list of play/pause/destroy events.
const players = new Map();
const playerOf = (id) => {
  if (!players.has(id)) players.set(id, { url: null, duration: null, events: [] });
  return players.get(id);
};

await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method === 'Media.playerEventsAdded') {
    const p = playerOf(m.params.playerId);
    for (const e of m.params.events) {
      let v; try { v = JSON.parse(e.value); } catch { continue; }
      if (v.event === 'kLoad' && !p.url) p.url = v.url;
      if (v.event === 'kDurationChanged') p.duration = v.duration;
      if (v.event === 'kPlay' || v.event === 'kPause' || v.event === 'kWebMediaPlayerDestroyed') p.events.push(v.event);
    }
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  try {
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
    const answer = u.pathname === '/api/by-guid' ? { podcast: ALBUM }
      : u.pathname === '/api/feed' ? { podcast: ALBUM, episodes: TRACKS }
      : u.pathname === '/api/audio-probe' ? { status: 206 }
      : u.pathname === '/api/live-shows' ? { items: [], unverifiedFeeds: 0, truncated: false }
      : {};
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: b64(answer),
    });
  } catch {
    // The page navigated away under a paused request.
  }
});
await send('Page.enable');
await send('Runtime.enable');
await send('Media.enable');

const playsK = (k, ms = 12000) => until(`(() => { const a = document.querySelector('audio');
  return !!a && !a.paused && a.currentTime > 0.2 && /[?&]k=${k}(\\D|$)/.test(a.currentSrc); })()`, ms);
async function endTrack() {
  await until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && isFinite(a.duration); })()`, 8000);
  await js(`(() => { const a = document.querySelector('audio'); a.currentTime = Math.max(0, a.duration - 0.3); if (a.paused) a.play(); return 1; })()`);
}
const pressMini = (re) => js(`(() => { const b = [...document.querySelectorAll('${MINI_BAR} button')].find((x) => ${re}.test(x.getAttribute('aria-label') ?? '')); if (!b || b.disabled) return false; b.click(); return true; })()`);
async function openAlbum() {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { localStorage.clear(); return 1; })()`);
  players.clear();
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes('Keeper test track 3'))`, 20000);
  await wait(800);
}
const tapRow = (k) => js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Keeper test track ${k}'))?.click()`);
// The Media domain reports in batches about once a second.
const settle = () => wait(1500);
const keepers = () => [...players.values()].filter((p) => p.url?.startsWith('blob:') && p.duration === 10);
const mainFor = (k) => [...players.entries()].filter(([, p]) => new RegExp(`[?&]k=${k}(\\D|$)`).test(p.url ?? ''));

// ---------------------------------------------------------------------------
console.log('\n1. Android: playing starts a silent 10 s keeper beside the track');
// `send` resolves with the whole CDP message, so the answer is under `result`.
const desktopUA = (await send('Browser.getVersion')).result.userAgent;
await send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv8l' });
await openAlbum();
t.equal('the page sees an Android user agent', await js(`/Android/.test(navigator.userAgent)`), true);
await tapRow(0);
t.ok('track 0 plays', await playsK(0, 15000));
await settle();
t.ok('exactly one keeper player: a blob: URL, 10 s long', keepers().length === 1,
  JSON.stringify([...players.values()].map((p) => [p.url?.slice(0, 30), p.duration])));
const keeper = keepers()[0];
t.equal('…and it is playing', keeper?.events.at(-1), 'kPlay');
t.ok('…and it is longer than 5 s, so Chrome does not count it one-shot', (keeper?.duration ?? 0) > 5);
t.ok('the playback log says it started', await js(`(localStorage.getItem('bmb:plog:device') ?? '').includes('keeper on=1')`));
t.equal('the keeper writes no m.* lines: the log has m.playing only for the track',
  await js(`(localStorage.getItem('bmb:plog:device') ?? '').split('\\n').filter((l) => / m\\.playing /.test(l) && !/ el=a/.test(l)).length`), 0);

// ---------------------------------------------------------------------------
console.log('\n2. It plays straight through a track that ENDS, and through ⏭');
const keeperEventsBefore = keeper.events.length;
await endTrack();
t.ok('track 0 ends and track 1 plays', await playsK(1));
t.ok('⏭ is pressed', await pressMini('/^Next/'));
t.ok('track 2 plays', await playsK(2));
await settle();
t.equal('the keeper neither paused nor was destroyed across both changes', keeper.events.slice(keeperEventsBefore), []);
t.equal('…and is still the only keeper', keepers().length, 1);
t.ok('the TRACK\'s player was replaced: tracks 1 and 2 each had their own player',
  mainFor(1).length >= 1 && mainFor(2).length >= 1 && mainFor(1)[0][0] !== mainFor(2)[0][0],
  JSON.stringify([...players.entries()].map(([id, p]) => [id.slice(0, 6), (p.url ?? '').slice(-6), p.events.join(',')])));
t.ok('track 0\'s own player was destroyed at the change', mainFor(0).some(([, p]) => p.events.includes('kWebMediaPlayerDestroyed')));

// ---------------------------------------------------------------------------
console.log('\n3. It pauses with the app, and plays again with it');
t.ok('⏸ is pressed', await pressMini('/^Pause$/'));
await settle();
t.equal('the keeper paused', keeper.events.at(-1), 'kPause');
t.ok('the playback log says so', await js(`(localStorage.getItem('bmb:plog:device') ?? '').includes('keeper on=0')`));
t.ok('▶ is pressed', await pressMini('/^Play$/'));
t.ok('track 2 plays again', await playsK(2));
await settle();
t.equal('the keeper plays again', keeper.events.at(-1), 'kPlay');

// ---------------------------------------------------------------------------
console.log('\n4. A desktop user agent gets no keeper');
await send('Emulation.setUserAgentOverride', { userAgent: desktopUA });
await openAlbum();
t.equal('the page sees no Android user agent', await js(`/Android/.test(navigator.userAgent)`), false);
await tapRow(0);
t.ok('track 0 plays', await playsK(0, 15000));
await settle();
t.ok('no keeper player', keepers().length === 0,
  JSON.stringify([...players.values()].map((p) => [p.url?.slice(0, 30), p.duration])));
t.ok('…only the track\'s own', mainFor(0).length >= 1);

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
