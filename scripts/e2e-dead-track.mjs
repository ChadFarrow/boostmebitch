// A track whose file is GONE must not stop a list that plays on its own.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:deadtrack                         # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:deadtrack -- --headed --keep
//
// THE FAULT IT WAS WRITTEN AGAINST (2026-11-13, Chad's iPhone, the Home Screen
// app, a favorites shuffle on the beta site): the Dynamic Island moved to the
// next track, and nothing played until the app came back to the foreground.
// The track was Herbivore's "Winds of Change" on RSS Blue, whose audio AND
// cover answer HTTP 410 Gone while the feed and Podcast Index still list them.
// The media element raised error 4 and `onMediaError` did what it has always
// done — show the message and stop — so one deleted file held up the whole run
// until somebody pressed a button. Albums, musicL playlists and Up Next stop
// on a dead file in exactly the same way.
//
// WHAT IT PINS:
//
//   1. A dead track the list ADVANCED onto is skipped, and the next one plays.
//   2. A dead track the listener PICKED is skipped too, when a list continues
//      after it. Chad, 2026-11-13: "I'd rather have the app continue to play
//      and not stop when it hits a dead item." (The first build showed the
//      message on a picked track and stopped after three dead in a row.)
//   3. Any number of dead tracks in a row are all passed over. A list is
//      finite and the skip only moves forward, so it cannot loop.
//   4. Up Next skips a dead item too, and drains it as an ended item drains.
//      When the dead item is the LAST thing in the list, nothing can follow:
//      the message shows, so a stop is never silent.
//   5. Offline (`navigator.onLine` false) nothing is skipped: the files are
//      not dead then, only out of reach, and the place in the list is worth
//      more than the skip.
//   6. The track AFTER a dead one PLAYS (sections 1 to 3). It loaded paused
//      under a ▶ before `pauseIfStillCurrent`: a late `play()` rejection for
//      the dead file, or the `AbortError` of a reload of the next one, paused
//      the store. A tap on another track after a dead one failed on `main`
//      before the skip existed.
//
// Every request the player makes for this album is answered here; the dead
// files answer 410, as RSS Blue's did. Nothing reaches Podcast Index.

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

const GUID = 'dead4000-0000-4000-8000-000000000001';
const ID = 900888;
// k: 0 ok, 1 dead, 2 ok, 3 dead, 4 dead, 5 dead, 6 ok, 7 dead (the album's last)
const DEAD = new Set([1, 3, 4, 5, 7]);
const ALBUM = {
  id: ID, podcastGuid: GUID, title: 'E2E Dead Track Album', author: 'e2e', medium: 'music',
  url: 'https://feeds.example.invalid/dead.xml',
};
const TRACKS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({
  id: 9900 + k, guid: `dead4000-0000-4000-8000-00000000010${k}`, podcastGuid: GUID, feedId: ID,
  title: `Dead test track ${k}`, episode: k + 1, duration: 30,
  enclosureUrl: `${APP}/api/${DEAD.has(k) ? 'e2e-gone' : 'e2e-audio'}.wav?k=${k}`,
}));

const { page } = await launchChrome({ name: 'deadtrack', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
function answer(pathname) {
  if (pathname === '/api/by-guid') return { podcast: ALBUM };
  if (pathname === '/api/feed') return { podcast: ALBUM, episodes: TRACKS };
  if (pathname === '/api/live-shows') return { items: [], unverifiedFeeds: 0, truncated: false };
  return {};
}
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  try {
    if (u.pathname === '/api/e2e-gone.wav') {
      // What RSS Blue answered for Winds of Change.
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 410,
        responseHeaders: [{ name: 'content-type', value: 'text/plain;charset=UTF-8' }],
        body: Buffer.from('Gone').toString('base64'),
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
await send('Runtime.enable');

const src = () => js(`document.querySelector('audio')?.currentSrc ?? ''`);
const kOf = async () => { const m = (await src()).match(/[?&]k=(\d+)/); return m ? Number(m[1]) : null; };
const playing = () => js(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2; })()`);
const errShown = () => js(`/format not supported or URL unreachable/.test(document.querySelector('${MINI_BAR}')?.textContent ?? '')`);
const waitK = (k, ms = 10000) => until(`/[?&]k=${k}(\\D|$)/.test(document.querySelector('audio')?.currentSrc ?? '')`, ms);
async function endTrack() {
  await until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && isFinite(a.duration); })()`, 8000);
  await js(`(() => { const a = document.querySelector('audio'); a.currentTime = Math.max(0, a.duration - 0.3); if (a.paused) a.play(); return 1; })()`);
}
async function openAlbum(seed = {}) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`(() => { localStorage.clear(); const s = ${JSON.stringify(seed)};
    for (const k in s) localStorage.setItem(k, s[k]); return 1; })()`);
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes('Dead test track 6'))`, 20000);
  await wait(800);
}
const tapRow = (k) => js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Dead test track ${k}'))?.click()`);

// ---------------------------------------------------------------------------
console.log('\n1. A dead track the album advanced onto is skipped');
await openAlbum();
await tapRow(0);
t.ok('track 0 plays', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2; })()`, 15000));
await endTrack();
t.ok('…and when it ends, dead track 1 is passed over and track 2 plays', await waitK(2, 12000), `on k=${await kOf()}`);
t.ok('track 2 is playing', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2; })()`, 10000));
t.equal('no error is left on screen', await errShown(), false);

// ---------------------------------------------------------------------------
console.log('\n2. A dead track the listener picked is passed over too');
await tapRow(1);
t.ok('the album moves on to track 2', await waitK(2, 12000), `on k=${await kOf()}`);
t.ok('…which plays', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2 && /[?&]k=2(\\D|$)/.test(a.currentSrc); })()`, 15000));
t.equal('…and no error is left on screen', await errShown(), false);

// ---------------------------------------------------------------------------
console.log('\n3. Any number of dead tracks in a row are passed over');
await endTrack();
t.ok('it passes 3, 4 and 5 and plays track 6', await waitK(6, 20000), `on k=${await kOf()}`);
t.ok('…which plays', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2 && /[?&]k=6(\\D|$)/.test(a.currentSrc); })()`, 15000));
t.equal('…and no error is left on screen', await errShown(), false);

// ---------------------------------------------------------------------------
console.log('\n3b. A dead LAST track: nothing can follow, so the stop says why');
await tapRow(7);
t.ok('the message shows', await until(`/format not supported or URL unreachable/.test(document.querySelector('${MINI_BAR}')?.textContent ?? '')`, 12000));
await wait(1000);
t.equal('…on the track that was picked, stopped', [await kOf(), await playing()], [7, false]);
// The tap that loaded the next track PAUSED on `main`: a good track picked while
// a dead one's error is on screen must play.
await tapRow(6);
t.ok('a track tapped after the dead one PLAYS', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2 && /[?&]k=6(\\D|$)/.test(a.currentSrc); })()`, 15000));

// ---------------------------------------------------------------------------
console.log('\n4. Up Next skips a dead item, and drains it');
const qItem = (k) => ({ episode: { ...TRACKS[k] }, podcast: { ...ALBUM } });
await openAlbum({ 'bmb:listen_queue:guest': JSON.stringify([qItem(0), qItem(1), qItem(2)]) });
// The page reveals the queue's head paused; the Listen tab plays it.
await send('Page.navigate', { url: `${APP}/listen` });
await until(`document.readyState === "complete"`);
// The row's own play control, by the name it gives itself (queue-list.tsx).
const QROW = `[...document.querySelectorAll('button')].find((b) => /^(Play|Resume) Dead test track 0$/.test(b.getAttribute('aria-label') ?? ''))`;
await until(`!!${QROW}`, 15000);
await js(`${QROW}.click()`);
t.ok('the queue head plays', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2 && /[?&]k=0(\\D|$)/.test(a.currentSrc); })()`, 15000));
await endTrack();
t.ok('the dead item is passed over and the next queued one plays', await waitK(2, 12000), `on k=${await kOf()}`);
await wait(800);
const left = JSON.parse(await js(`localStorage.getItem('bmb:listen_queue:guest') ?? '[]'`)).map((i) => i.episode.title);
t.equal('…and both the finished and the dead item left Up Next', left, ['Dead test track 2']);

console.log('\n4b. A dead LAST item: nothing can follow, so the stop says why');
await openAlbum({ 'bmb:listen_queue:guest': JSON.stringify([qItem(0), qItem(1)]) });
await send('Page.navigate', { url: `${APP}/listen` });
await until(`document.readyState === "complete"`);
await until(`!!${QROW}`, 15000);
await js(`${QROW}.click()`);
t.ok('the queue head plays', await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2 && /[?&]k=0(\\D|$)/.test(a.currentSrc); })()`, 15000));
await endTrack();
t.ok('the dead last item shows the message', await until(`/format not supported or URL unreachable/.test(document.querySelector('${MINI_BAR}')?.textContent ?? '')`, 12000), `on k=${await kOf()}`);
t.equal('…and nothing plays', await playing(), false);

// ---------------------------------------------------------------------------
console.log('\n5. Offline, nothing is skipped');
await openAlbum();
await tapRow(0);
await until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2; })()`, 15000);
await until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && isFinite(a.duration); })()`, 8000);
await send('Network.enable');
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
t.equal('the browser reports offline', await js('navigator.onLine'), false);
await endTrack();
await wait(4000);
t.equal('the run stops on the dead track rather than skipping it', await kOf(), 1);
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
