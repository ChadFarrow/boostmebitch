// End-to-end for the cover press on /demu: a press on an album's cover plays
// the album, and the rest of the row still opens it (docs/ui.md, "The DeMu
// page", Chad on the #583 preview, 2026-11-16: "if I click the artwork could it
// just play it?"). The glyph is an overlay ON the art, not a badge: Chad,
// iPhone, beta, 2026-11-17, found the round badge on every cover "too
// distracting" and asked for "a transparent overlay kind of on the art".
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:demuplay                          # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:demuplay -- --headed --keep
//
// WHAT IT PINS:
//
//   1. The cover of an album row is its OWN button, beside the row's button.
//      A row that is not an album keeps its cover inside the row's button. An
//      idle cover shows no overlay; a mouse's hover shows it, and a held
//      :hover on a phone (`(hover: none)`, as iOS leaves after a tap) does not.
//   2. A press plays the album's first track on /demu, with no navigation and
//      one feed request.
//   3. ⏭ and a track's end walk the album: the press wrote `episodeQueue`.
//   4. A press on the album that holds the player pauses it, and the next press
//      resumes the same track — never a restart at track 1.
//   5. Only the last press starts anything: a slow album answered after a
//      second press does not take the player, and a pause pressed while it
//      loads is not undone by it. A scheduled live row is never the first track.
//   6. A feed that does not load says so on the cover, leaves the player alone,
//      and the next press tries again.
//   7. The rest of the row still opens the album; the album header's ▶ (which
//      now shares `albumHoldsCurrent` with the cover) starts it and then
//      offers Pause; "← back to DeMu" returns to a cover that says playing.
//      In every state but idle the overlay is drawn without hover, and the
//      album that holds the player, playing or paused, has a bolt border.
//   8. No horizontal overflow at 320 and 390 (phone emulation) and 1280. The
//      cover is at least 24×24, the overlay stays inside the cover's border,
//      and the app badge stays on top of the overlay.
//
// Signed out: no key, so nothing reaches a relay. The roster, the feeds, the
// audio and the player's value lookups are answered here; anything else goes
// to the dev server untouched.
//
// NOT DRIVEN: iOS. A cold first press there may need a second press, because
// the feed request comes between the tap and `play()`; Chrome does not enforce
// the gesture here (autoplay is on). That needs an iPhone.

import { checker, exit, launchChrome, MINI_BAR, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// ---- the audio ------------------------------------------------------------
// Thirty seconds of 8 kHz 8-bit silence, as in e2e-shuffle: long enough that a
// track never ends before the test makes it.
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
const VALUE = { model: { type: 'lightning', method: 'keysend' }, recipients: [{ name: 'artist', type: 'node', address: '02artist', split: 100 }] };
const nowSec = Math.floor(Date.now() / 1000);
// B answers slowly (section 5), C fails until told not to (section 6), and E
// opens with a scheduled live row, which must never be the track a ▶ starts.
const SPEC = [
  { key: 'A', tracks: 3, daysAgo: 1 },
  { key: 'B', tracks: 2, daysAgo: 2 },
  { key: 'C', tracks: 2, daysAgo: 3 },
  { key: 'E', tracks: 3, daysAgo: 4, firstPending: true },
];
const ALBUMS = SPEC.map((s, i) => {
  const id = 910001 + i;
  const podcastGuid = guid('demu', i);
  const title = `E2E Album ${s.key}`;
  return {
    key: s.key,
    title,
    row: {
      id, podcastGuid, title, author: 'e2e artist', medium: 'music',
      newestItemPubdate: nowSec - s.daysAgo * 86400, episodeCount: s.tracks, app: 'self',
    },
    feed: {
      podcast: { id, podcastGuid, title, author: 'e2e artist', medium: 'music', url: `https://feeds.example.invalid/${s.key}.xml`, value: VALUE },
      episodes: Array.from({ length: s.tracks }, (_, k) => ({
        id: 8000 + i * 10 + k, guid: guid(`d${s.key}track`, k), podcastGuid, feedId: id,
        title: `${s.key} track ${k}`, episode: k + 1,
        // Notes, as a real track carries: without them the now-playing screen
        // reads the feed again for each track, and the request counts below
        // would count that instead of the press.
        description: `Notes for ${s.key} track ${k}.`,
        enclosureUrl: `${APP}/api/e2e-audio.wav?demu=${s.key}-${k}`,
        value: VALUE,
        ...(s.firstPending && k === 0 ? { liveStatus: 'pending' } : {}),
      })),
    },
  };
});
// A row that is not an album: its cover must stay inside the row's button.
const TALK = {
  id: 910099, podcastGuid: guid('demu', 99), title: 'E2E Talk Row', author: 'e2e host',
  medium: 'podcast', newestItemPubdate: nowSec - 5 * 86400, episodeCount: 4, app: 'self',
};
const byId = (id) => ALBUMS.find((a) => String(a.row.id) === id);

// ---- the browser ----------------------------------------------------------
const { page } = await launchChrome({ name: 'demuplay', autoplay: true, args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
const pageErrors = [];

let bDelay = 0;           // ms before B's feed answers
let cFails = true;        // C's feed answers 500 while true
const feedAsks = {};      // album key → how many /api/feed requests
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
    if (u.pathname === '/api/demu') {
      await fulfillJson(requestId, { albums: [...ALBUMS.map((a) => a.row), TALK], answered: true, fetchedAt: Date.now() });
      return;
    }
    // Ranges answered, because section 3 seeks to a track's end.
    if (u.pathname === '/api/e2e-audio.wav') {
      const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'range')?.[1];
      const r = range && /bytes=(\d+)-(\d*)/.exec(range);
      const start = r ? Number(r[1]) : 0;
      const end = r && r[2] ? Math.min(Number(r[2]), AUDIO.length - 1) : AUDIO.length - 1;
      const body = AUDIO.subarray(start, end + 1);
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: r ? 206 : 200,
        responseHeaders: [
          { name: 'content-type', value: 'audio/wav' },
          { name: 'accept-ranges', value: 'bytes' },
          { name: 'content-length', value: String(body.length) },
          ...(r ? [{ name: 'content-range', value: `bytes ${start}-${end}/${AUDIO.length}` }] : []),
        ],
        body: body.toString('base64'),
      });
      return;
    }
    if (u.pathname === '/api/feed' && byId(q.get('id') ?? '')) {
      const a = byId(q.get('id'));
      feedAsks[a.key] = (feedAsks[a.key] ?? 0) + 1;
      if (a.key === 'B' && bDelay) await wait(bDelay);
      if (a.key === 'C' && cFails) { await fulfillJson(requestId, { error: 'feed failed' }, 500); return; }
      await fulfillJson(requestId, a.feed);
      return;
    }
    if (u.pathname === '/api/by-guid') {
      const a = ALBUMS.find((x) => x.row.podcastGuid === q.get('guid'));
      if (a) { await fulfillJson(requestId, { podcast: a.feed.podcast }); return; }
    }
    if (u.pathname === '/api/audio-probe') { await fulfillJson(requestId, { status: 206 }); return; }
    if (u.pathname === '/api/value-splits') { await fulfillJson(requestId, { splits: [] }); return; }
    if (u.pathname === '/api/item-value') { await fulfillJson(requestId, { read: true, value: VALUE }); return; }
    await send('Fetch.continueRequest', { requestId });
  } catch {
    // The page navigated away under a paused request. Nothing to answer.
  }
});
await send('Page.enable');
await send('Runtime.enable');
// CSS.forcePseudoState needs both (forceHover below).
await send('DOM.enable');
await send('CSS.enable');

// ---- helpers --------------------------------------------------------------
const rowOf = (title) => `[...document.querySelectorAll('li')].find((li) => li.querySelector('span.font-display')?.textContent === ${JSON.stringify(title)})`;
const coverOf = (title) => `${rowOf(title)}?.querySelector('button[data-cover-play]')`;
const cover = (title) => js(`(() => {
  const b = ${coverOf(title)};
  if (!b) return null;
  return { state: b.dataset.coverPlay, label: b.getAttribute('aria-label'), busy: b.getAttribute('aria-busy'),
           glyph: b.querySelector('[data-cover-play-glyph]')?.textContent ?? null };
})()`);
// What the overlay looks like, unhovered unless a test forces :hover. `bolt`,
// `nostr` and `bone` are the palette colours, read from a probe so a palette change
// does not break the test.
const look = (title) => js(`JSON.stringify((() => {
  const b = ${coverOf(title)};
  if (!b) return null;
  const g = getComputedStyle(b.querySelector('[data-cover-play-glyph]'));
  const probe = document.createElement('span');
  document.body.append(probe);
  probe.className = 'text-bolt'; const bolt = getComputedStyle(probe).color;
  probe.className = 'text-nostr'; const nostr = getComputedStyle(probe).color;
  probe.className = 'text-bone'; const bone = getComputedStyle(probe).color;
  probe.remove();
  const border = getComputedStyle(b.querySelector('.w-14')).borderTopColor;
  const name = (c) => (c === bolt ? 'bolt' : c === nostr ? 'nostr' : c === bone ? 'bone' : c);
  return { shown: Number(g.opacity) === 1, hidden: Number(g.opacity) === 0, glyph: name(g.color), boltBorder: border === bolt };
})())`).then((x) => (x ? JSON.parse(x) : null));
/**
 * Hold :hover on a cover, as iOS does after a tap (CSS.forcePseudoState, as in
 * e2e-sticky-hover). The release reuses the node id of the hold: a second
 * DOM.getDocument binds the node to a NEW id, and clearing that one leaves the
 * hover held (measured — the overlay stayed).
 */
let heldNode = null;
async function forceHover(title, on = true) {
  if (!on) {
    if (heldNode) await send('CSS.forcePseudoState', { nodeId: heldNode, forcedPseudoClasses: [] });
    heldNode = null;
    return true;
  }
  const marked = await js(`(() => { const b = ${coverOf(title)}; if (!b) return false; b.setAttribute('data-e2e-hover', ''); return true; })()`);
  if (!marked) return false;
  const root = (await send('DOM.getDocument', { depth: 0 })).result?.root;
  const nodeId = root && (await send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-e2e-hover]' })).result?.nodeId;
  await js(`document.querySelector('[data-e2e-hover]')?.removeAttribute('data-e2e-hover')`);
  if (!nodeId) return false;
  heldNode = nodeId;
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  return true;
}
const press = (title) => js(`(() => { const b = ${coverOf(title)}; if (!b) return false; b.click(); return true; })()`);
const stateIs = (title, state, ms = 8000) => until(`${coverOf(title)}?.dataset.coverPlay === ${JSON.stringify(state)}`, ms);
const src = () => js(`document.querySelector('audio')?.currentSrc ?? ''`);
const track = async () => (await src()).match(/[?&]demu=([A-Z]-\d+)/)?.[1] ?? null;
const plays = (key, ms = 8000) => until(`(() => { const a = document.querySelector('audio');
  return !!a && /[?&]demu=${key}(\\D|$)/.test(a.currentSrc) && !a.paused; })()`, ms);
const paused = () => js(`document.querySelector('audio')?.paused ?? null`);
const pressMini = (re) => js(`(() => { const b = [...document.querySelectorAll('${MINI_BAR} button')].find((x) => ${re}.test(x.getAttribute('aria-label') ?? '')); if (!b || b.disabled) return false; b.click(); return true; })()`);
async function endTrack() {
  await until(`(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 1 && isFinite(a.duration); })()`, 8000);
  await js(`(() => { const a = document.querySelector('audio'); a.currentTime = Math.max(0, a.duration - 0.3); if (a.paused) a.play(); return true; })()`);
}
async function openDemu() {
  await send('Page.navigate', { url: `${APP}/demu` });
  // A cold dev server compiles the route on the first visit.
  return until(`!!${coverOf('E2E Album A')}`, 60000);
}

// ---------------------------------------------------------------------------
console.log('\n1. The cover is its own control');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
t.ok('/demu lists the fixture albums', await openDemu());
t.equal('A: the cover offers Play', await cover('E2E Album A'), { state: 'idle', label: 'Play E2E Album A', busy: null, glyph: '▶' });
const structure = JSON.parse(await js(`JSON.stringify((() => {
  const li = ${rowOf('E2E Album A')};
  const cb = li.querySelector('button[data-cover-play]');
  const rowBtn = [...li.children].find((c) => c.tagName === 'BUTTON' && !c.dataset.coverPlay);
  const talk = ${rowOf('E2E Talk Row')};
  const talkBtn = [...talk.children].find((c) => c.tagName === 'BUTTON');
  return {
    coverIsChildOfLi: cb.parentElement === li,
    coverNotInButton: !cb.parentElement.closest('button'),
    rowButtonHasNoCover: !rowBtn.querySelector('.w-14'),
    rowButtonHasTitle: !!rowBtn.querySelector('span.font-display'),
    talkHasNoCoverButton: !talk.querySelector('button[data-cover-play]'),
    talkCoverInRowButton: !!talkBtn?.querySelector('.w-14'),
  };
})())`));
t.equal('A: the cover is a sibling button and the row button keeps the text', structure, {
  coverIsChildOfLi: true, coverNotInButton: true, rowButtonHasNoCover: true, rowButtonHasTitle: true,
  talkHasNoCoverButton: true, talkCoverInRowButton: true,
});
t.equal('A: an idle cover draws no overlay and no bolt border', await look('E2E Album A'),
  { shown: false, hidden: true, glyph: 'bone', boltBorder: false });
await forceHover('E2E Album A');
await wait(400);
t.equal('A: a mouse hover shows the overlay, a bolt ▶ and a bolt border', await look('E2E Album A'),
  { shown: true, hidden: false, glyph: 'bolt', boltBorder: true });
await forceHover('E2E Album A', false);
await wait(400);
t.ok('A: the overlay goes when the hover goes', (await look('E2E Album A'))?.hidden);
// A phone: iOS keeps :hover on the last element tapped. A held reveal on an
// idle album would read as "this one is current", so `(hover: none)` shows none.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
t.equal('the emulated phone matches (hover: none), as an iPhone does',
  await js(`matchMedia('(hover: none)').matches && !matchMedia('(hover: hover)').matches`), true);
await forceHover('E2E Album A');
await wait(400);
t.equal('A: on a phone, a held :hover draws no overlay and no bolt border', await look('E2E Album A'),
  { shown: false, hidden: true, glyph: 'bone', boltBorder: false });
await forceHover('E2E Album A', false);
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await wait(400);

// ---------------------------------------------------------------------------
console.log('\n2. A press plays the album from its first track');
await press('E2E Album A');
t.ok('A: track 0 plays', await plays('A-0'));
t.equal('A: still on /demu', await js('location.pathname'), '/demu');
t.equal('A: the cover offers Pause', await cover('E2E Album A'), { state: 'playing', label: 'Pause E2E Album A', busy: null, glyph: '❚❚' });
t.equal('A: one feed request', feedAsks.A, 1);
t.equal('A: playing, the overlay shows without hover, a bolt ❚❚ in a bolt border', await look('E2E Album A'),
  { shown: true, hidden: false, glyph: 'bolt', boltBorder: true });
t.ok('the mini player shows', await until(`!!document.querySelector('${MINI_BAR}')`, 5000));

// ---------------------------------------------------------------------------
console.log('\n3. ⏭ and a track end walk the album');
t.ok('⏭ is on', await until(`(() => { const b = [...document.querySelectorAll('${MINI_BAR} button')].find((x) => /^Next/.test(x.getAttribute('aria-label') ?? '')); return !!b && !b.disabled; })()`, 5000));
await pressMini('/^Next/');
t.ok('⏭ plays A track 1', await plays('A-1'));
await endTrack();
t.ok('the end of track 1 plays A track 2', await plays('A-2', 12000));

// ---------------------------------------------------------------------------
console.log('\n4. A press on the playing album pauses and resumes it');
await press('E2E Album A');
t.ok('the press pauses', await until(`document.querySelector('audio')?.paused === true`, 5000));
t.ok('the cover offers Resume', await stateIs('E2E Album A', 'paused'));
t.equal('…with a ▶ and the album named', await cover('E2E Album A'), { state: 'paused', label: 'Resume E2E Album A', busy: null, glyph: '▶' });
t.equal('…and paused, the overlay and the bolt border stay', await look('E2E Album A'),
  { shown: true, hidden: false, glyph: 'bolt', boltBorder: true });
await press('E2E Album A');
t.ok('the next press resumes', await until(`document.querySelector('audio')?.paused === false`, 5000));
t.equal('…the same track, not track 0', await track(), 'A-2');
t.equal('A: no second feed request for a pause or a resume', feedAsks.A, 1);

// ---------------------------------------------------------------------------
console.log('\n5. Only the last press starts anything');
bDelay = 1500;
await press('E2E Album B');
t.ok('B: the cover says it is loading', await stateIs('E2E Album B', 'loading', 1000));
t.equal('B: …busy, with a … glyph', await cover('E2E Album B'), { state: 'loading', label: 'Loading E2E Album B', busy: 'true', glyph: '…' });
await wait(400); // the overlay fades in over 150 ms; B answers after 1500
t.equal('B: loading, the overlay shows without hover; the border is not bolt yet', await look('E2E Album B'),
  { shown: true, hidden: false, glyph: 'bolt', boltBorder: false });
await press('E2E Album E');
t.ok('E: a second press plays E', await plays('E-1'));
t.equal('E: the first track is the one after the scheduled live row', await track(), 'E-1');
await wait(bDelay + 800);
t.equal('B: answered late, and did not take the player', await track(), 'E-1');
t.equal('B: its cover is back to Play', (await cover('E2E Album B'))?.state, 'idle');
t.ok('B: …with no overlay', (await look('E2E Album B'))?.hidden);
t.equal('A: no longer current, it has no overlay and no bolt border', await look('E2E Album A'),
  { shown: false, hidden: true, glyph: 'bone', boltBorder: false });
// A pause pressed while another album loads is the newer press.
await press('E2E Album B');
t.ok('B: loading again', await stateIs('E2E Album B', 'loading', 1000));
await press('E2E Album E');
t.ok('E: the press pauses E', await until(`document.querySelector('audio')?.paused === true`, 5000));
await wait(bDelay + 800);
t.equal('B: answered late, and did not undo the pause', { track: await track(), paused: await paused() }, { track: 'E-1', paused: true });
bDelay = 0;

// ---------------------------------------------------------------------------
console.log('\n6. A feed that does not load says so');
await press('E2E Album C');
t.ok('C: the cover says it failed', await stateIs('E2E Album C', 'failed'));
t.equal('C: …with a ! and a way to try again', await cover('E2E Album C'), {
  state: 'failed', label: 'Could not load E2E Album C. Press to try again.', busy: null, glyph: '!',
});
t.equal('C: failed, the overlay shows a magenta ! without hover', await look('E2E Album C'),
  { shown: true, hidden: false, glyph: 'nostr', boltBorder: false });
t.equal('C: the player is left alone', { track: await track(), paused: await paused() }, { track: 'E-1', paused: true });
cFails = false;
await press('E2E Album C');
t.ok('C: the next press plays C', await plays('C-0'));
t.equal('C: the cover offers Pause', (await cover('E2E Album C'))?.state, 'playing');

// ---------------------------------------------------------------------------
console.log('\n7. The rest of the row still opens the album');
await js(`(() => { const li = ${rowOf('E2E Album A')}; [...li.children].find((c) => c.tagName === 'BUTTON' && !c.dataset.coverPlay).click(); })()`);
t.ok('A: the row opens the album page', await until(`location.pathname === '/' && document.body.textContent.includes('back to DeMu') && document.body.textContent.includes('A track 2')`, 20000));
t.equal('C still plays under the open album', await track(), 'C-0');
const header = () => js(`document.querySelector('header button[aria-label="Play album"], header button[aria-label="Pause"]')?.getAttribute('aria-label') ?? null`);
t.equal('the album header offers Play album', await header(), 'Play album');
await js(`document.querySelector('header button[aria-label="Play album"]')?.click()`);
t.ok('the header ▶ plays A track 0', await plays('A-0'));
t.ok('…and then offers Pause', await until(`!!document.querySelector('header button[aria-label="Pause"]')`, 5000));
await js(`[...document.querySelectorAll('a, button')].find((x) => /back to DeMu/.test(x.textContent))?.click()`);
t.ok('← back to DeMu returns', await until(`location.pathname === '/demu' && !!${coverOf('E2E Album A')}`, 20000));
t.equal('A: the cover says playing', (await cover('E2E Album A'))?.state, 'playing');
t.equal('A: …with its overlay and bolt border', await look('E2E Album A'),
  { shown: true, hidden: false, glyph: 'bolt', boltBorder: true });

// ---------------------------------------------------------------------------
console.log('\n8. Layout');
for (const [width, height, mobile] of [[320, 700, true], [390, 844, true], [1280, 900, false]]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await wait(400);
  const m = JSON.parse(await js(`JSON.stringify((() => {
    const de = document.documentElement;
    const rows = ${JSON.stringify(ALBUMS.map((a) => a.title))}.map((title) => {
      const li = [...document.querySelectorAll('li')].find((x) => x.querySelector('span.font-display')?.textContent === title);
      // elementFromPoint sees only the viewport, and the mini player covers its foot.
      li.scrollIntoView({ block: 'center' });
      const cb = li.querySelector('button[data-cover-play]').getBoundingClientRect();
      const art = li.querySelector('button[data-cover-play] .w-14').getBoundingClientRect();
      const ov = li.querySelector('[data-cover-play-glyph]').getBoundingClientRect();
      const app = li.querySelector('[data-demu-app]');
      const ar = app.getBoundingClientRect();
      const top = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2);
      return {
        coverW: Math.round(cb.width), coverH: Math.round(cb.height),
        overlayInsideBorder: ov.left >= art.left + 0.5 && ov.right <= art.right - 0.5 && ov.top >= art.top + 0.5 && ov.bottom <= art.bottom - 0.5,
        appBadgeOnTop: !!top && app.contains(top),
      };
    });
    return { overflow: de.scrollWidth - de.clientWidth, rows };
  })())`));
  t.equal(`${width}px: no horizontal overflow`, m.overflow, 0);
  t.ok(`${width}px: every cover is at least 24×24`, m.rows.every((r) => r.coverW >= 24 && r.coverH >= 24), JSON.stringify(m.rows));
  t.ok(`${width}px: every overlay is inside its cover's border`, m.rows.every((r) => r.overlayInsideBorder), JSON.stringify(m.rows));
  t.ok(`${width}px: every app badge is on top of the overlay`, m.rows.every((r) => r.appBadgeOnTop), JSON.stringify(m.rows));
}
await send('Emulation.clearDeviceMetricsOverride');

// ---------------------------------------------------------------------------
t.equal('no uncaught page errors', pageErrors, []);
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
