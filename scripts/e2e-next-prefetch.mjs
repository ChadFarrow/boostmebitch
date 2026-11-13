// BETA ONLY: the next track's file is downloaded ~30 s before this one ends.
//
// Usage (a BETA build — the download is gated on NEXT_PUBLIC_BETA=1):
//   NEXT_PUBLIC_BETA=1 npm run dev                # in another terminal
//   npm run e2e:prefetch
//   APP_URL=http://127.0.0.1:3019 npm run e2e:prefetch -- --headed --keep
//   PREFETCH_EXPECT=off npm run e2e:prefetch      # against a build WITHOUT the flag
//
// WHY (bug report #546, Chad's iPhone, the Home Screen app, a favorites shuffle
// on beta): with the app in the background a track ended, the shuffle set the
// next file and called play(), its metadata arrived — and then nothing, until
// the app came back to the foreground 13 s later, when it played at once. The
// likely cause is iOS suspending a hidden web app in the silent gap between two
// tracks. The experiment Chad chose (2026-11-13): fetch the NEXT file while this
// one still plays, so the data may already be on the phone at the switch.
//
// WHAT IS NOT KNOWN, and why it is beta only: whether iOS's media loader reuses
// that download. Safari drops `Range` on a cross-origin no-cors fetch, so it is
// the WHOLE file; Playwright's WebKit keeps no HTTP cache, so it could not say.
// Each early download writes `prefetch` to the playback log, so the next bug
// report from the phone shows whether the stall still happens after one.
//
// WHAT IT PINS:
//   1. Nothing is fetched early at the start of a track.
//   2. Inside the last 30 s, the next track's file is fetched (a `fetch`, not
//      the media element), once, and the playback log says so.
//   3. The next track still plays when this one ends.
//   4. A podcast episode that does not advance on its own fetches nothing.
//   With PREFETCH_EXPECT=off, 2 turns over: a main build fetches nothing early
//   and logs nothing, which is the claim that a merge cannot ship this.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const OFF = process.env.PREFETCH_EXPECT === 'off';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`NEXT_PUBLIC_BETA=1 npm run dev\` in another terminal.`);

function silentWav(seconds) {
  const rate = 8000, n = rate * seconds, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const AUDIO = silentWav(90);

const ALBUM_GUID = 'efe40000-0000-4000-8000-000000000001';
const SHOW_GUID = 'efe40000-0000-4000-8000-000000000002';
const ALBUM = { id: 900994, podcastGuid: ALBUM_GUID, title: 'E2E Prefetch Album', author: 'e2e', medium: 'music', url: 'https://feeds.example.invalid/pf-album.xml' };
const SHOW = { id: 900995, podcastGuid: SHOW_GUID, title: 'E2E Prefetch Show', author: 'e2e', medium: 'podcast', url: 'https://feeds.example.invalid/pf-show.xml' };
const TRACKS = [0, 1, 2].map((k) => ({
  id: 9400 + k, guid: `efe40000-0000-4000-8000-00000000010${k}`, podcastGuid: ALBUM_GUID, feedId: ALBUM.id,
  title: `Prefetch track ${k}`, episode: k + 1, duration: 90, enclosureUrl: `${APP}/api/e2e-audio.wav?k=${k}`,
}));
const EPISODES = [0, 1].map((k) => ({
  id: 9500 + k, guid: `efe40000-0000-4000-8000-00000000020${k}`, podcastGuid: SHOW_GUID, feedId: SHOW.id,
  title: `Prefetch episode ${k}`, duration: 90, enclosureUrl: `${APP}/api/e2e-audio.wav?p=${k}`, datePublished: 1700000000 + k,
}));

const { page } = await launchChrome({ name: 'prefetch', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];
const seen = [];   // { kind, type } for every audio request

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
page.on(async (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request, resourceType } = m.params;
  const u = new URL(request.url);
  const q = u.searchParams;
  try {
    if (u.pathname === '/api/e2e-audio.wav') {
      seen.push({ kind: q.has('k') ? `k${q.get('k')}` : `p${q.get('p')}`, type: resourceType });
      const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
      const mm = range && /bytes=(\d+)-(\d*)/.exec(range);
      const start = mm ? Number(mm[1]) : 0;
      const end = mm && mm[2] ? Math.min(Number(mm[2]), AUDIO.length - 1) : AUDIO.length - 1;
      const body = AUDIO.subarray(start, end + 1);
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: mm ? 206 : 200,
        responseHeaders: [
          { name: 'content-type', value: 'audio/wav' }, { name: 'accept-ranges', value: 'bytes' },
          { name: 'content-length', value: String(body.length) },
          ...(mm ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
        ],
        body: body.toString('base64'),
      });
      return;
    }
    const isShow = q.get('guid') === SHOW_GUID || q.get('id') === String(SHOW.id);
    const answer = u.pathname === '/api/by-guid' ? { podcast: isShow ? SHOW : ALBUM }
      : u.pathname === '/api/feed' ? (isShow ? { podcast: SHOW, episodes: EPISODES } : { podcast: ALBUM, episodes: TRACKS })
      : u.pathname === '/api/live-shows' ? { items: [], unverifiedFeeds: 0, truncated: false }
      : {};
    await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: b64(answer) });
  } catch {
    // The page navigated away under a paused request.
  }
});
await send('Page.enable');
await send('Runtime.enable');

// Not the media element: Chrome reports a no-cors fetch() as 'XHR', so anything
// that is not 'Media' is the early download.
const early = (kind) => seen.filter((s) => s.kind === kind && s.type !== 'Media').length;
const plog = async () => JSON.parse(await js(`localStorage.getItem('bmb:plog:device') ?? '[]'`));
const playing = (re) => until(`(() => { const a = document.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0.2 && ${re}.test(a.currentSrc); })()`, 15000);
const seekTo = (fromEnd) => js(`(() => { const a = document.querySelector('audio'); a.currentTime = Math.max(0, a.duration - ${fromEnd}); if (a.paused) a.play(); return 1; })()`);
async function openFeed(guid, text) {
  await send('Page.navigate', { url: `${APP}/?podcast=${guid}` });
  await until(`[...document.querySelectorAll('ul > li')].some((li) => li.textContent.includes(${JSON.stringify(text)}))`, 20000);
  await wait(600);
}

// ---------------------------------------------------------------------------
console.log('\n1. Nothing early at the start of a track');
await openFeed(ALBUM_GUID, 'Prefetch track 2');
await js(`localStorage.setItem('bmb:plog:device', '[]')`);
await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Prefetch track 0')).click()`);
t.ok('track 0 plays', await playing('/[?&]k=0(\\D|$)/'));
await wait(2000);
t.equal('no early fetch of track 1 yet', early('k1'), 0);

// ---------------------------------------------------------------------------
if (OFF) {
  console.log('\n2. A build without NEXT_PUBLIC_BETA=1 fetches nothing early');
  await seekTo(25);
  await wait(4000);
  t.equal('no early fetch of track 1', early('k1'), 0);
  t.equal('no prefetch line in the playback log', (await plog()).filter((l) => / prefetch /.test(l)), []);
} else {
  console.log('\n2. Inside the last 30 s, the next file is fetched once');
  await seekTo(25);
  for (let i = 0; i < 25 && early('k1') === 0; i++) await wait(200);
  t.equal('track 1 is fetched early, not by the media element', early('k1'), 1);
  const lines = (await plog()).filter((l) => / prefetch /.test(l));
  t.ok('the playback log records it', lines.length >= 1, JSON.stringify(lines));
  await seekTo(20);
  await wait(1500);
  t.equal('…once, not again on another seek', early('k1'), 1);
  t.equal('nothing for the track after it', early('k2'), 0);
}

// ---------------------------------------------------------------------------
console.log('\n3. The next track still plays at the end');
await seekTo(0.4);
t.ok('track 1 plays when track 0 ends', await playing('/[?&]k=1(\\D|$)/'));

// ---------------------------------------------------------------------------
console.log('\n4. A podcast episode does not advance on its own, so nothing is fetched');
await openFeed(SHOW_GUID, 'Prefetch episode 1');
await js(`[...document.querySelectorAll('ul > li')].find((li) => li.textContent.includes('Prefetch episode 0')).querySelector('button[aria-label="Play"]').click()`);
t.ok('the episode plays', await playing('/[?&]p=0(\\D|$)/'));
await seekTo(25);
await wait(3000);
t.equal('no early fetch of another episode', early('p1'), 0);

t.equal("no uncaught page errors", pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
