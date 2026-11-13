// `npm run e2e:livecatchup` — the live player's "N s behind / GO LIVE" row.
//
// THE REPORT, 2026-11-12, Homegrown Hits 158: the listener could not tell
// whether the player was caught up, so they refreshed the page to make sure,
// and the refresh played a few seconds they had already heard. The row read
// `● LIVE streaming now` whatever the delay, so a refresh was the only check.
//
// What was measured that day, and what this script replays:
// - The Icecast MP3 sends ~54 KB at once on connect, then 16 KB/s (128 kbps):
//   a fresh connect starts 3-4 s behind the server. That burst is what a
//   refresh plays again, and why the row stays quiet under 5 s.
// - A 12 s network gap (a proxy holding the bytes, then letting them through)
//   left playback 10.2 s behind, and it stayed there: a live item plays at 1×,
//   so nothing catches up. `buffered.end - currentTime` stayed under 2 s the
//   whole time — the buffer does NOT show the delay, only the clock does.
//
// Part 1 needs nothing running: the rule in lib/live-lag.ts against fixed
// vectors. `UNIT_ONLY=1` stops there. Part 2 drives the real app against a
// local MP3 stream this script paces itself, through a hold it controls.
//
// Part 2 needs the app: `npm run dev` (or `npm run build && npm start`) in
// another terminal, `APP_URL` if it is not on :3000. It needs `ffmpeg` for the
// test tone. Nothing in it depends on a real show being on air: `/api/feed`
// and `/api/live-status` are rewritten in the browser so one item of Homegrown
// Hits is live and its enclosure is the local stream.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveLag, behindToShow, LIVE_BEHIND_MIN_SEC } from '../lib/live-lag.ts';
import { MINI_BAR, checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const t = checker();

console.log('Part 1 — the delay rule (lib/live-lag.ts)');
t.equal('the threshold is 5 s', LIVE_BEHIND_MIN_SEC, 5);
t.equal('on time', liveLag({ wallSec: 0, mediaSec: 100 }, 10, 110).behindSec, 0);
t.equal('a 12 s gap', liveLag({ wallSec: 0, mediaSec: 100 }, 40, 128).behindSec, 12);
const ahead = liveLag({ wallSec: 0, mediaSec: 100 }, 10, 113);
t.equal('ran ahead: not negative', ahead.behindSec, 0);
t.equal('ran ahead: re-anchored where the play head is', ahead.anchor, { wallSec: 10, mediaSec: 113 });
t.equal('ran ahead, then a gap counts in full', liveLag(ahead.anchor, 30, 125).behindSec, 8);
const kept = liveLag({ wallSec: 0, mediaSec: 100 }, 40, 128);
t.equal('behind: the anchor is kept', kept.anchor, { wallSec: 0, mediaSec: 100 });
// A re-attach (hls.js `recoverMediaError` → `load()`) puts `currentTime` at 0
// for a moment. A play head before its own anchor is not a measurement: an
// hour in, the naive subtraction reads "3600 s behind".
const reset = liveLag({ wallSec: 0, mediaSec: 100 }, 50, 0);
t.equal('play head before its anchor: no measurement', reset.behindSec, null);
t.equal('play head before its anchor: the anchor is kept', reset.anchor, { wallSec: 0, mediaSec: 100 });
t.equal('4.9 s shows nothing', behindToShow(4.9), 0);
t.equal('5 s shows', behindToShow(5), 5);
t.equal('10.2 s shows 10', behindToShow(10.2), 10);
t.equal('10.6 s shows 11', behindToShow(10.6), 11);
// HYSTERESIS. `currentTime` inside a timeupdate is where the event was queued,
// so a lag that settles on 5.0 s or on N.5 s jitters across the line every
// tick: the button blinked under the thumb, and the number flipped N ↔ N+1.
t.equal('shown at 5: 4.6 s keeps it', behindToShow(4.6, 5), 5);
t.equal('shown at 5: under 4 s hides it', behindToShow(3.9, 5), 0);
t.equal('shown at 10: 10.6 s keeps 10', behindToShow(10.6, 10), 10);
t.equal('shown at 10: 10.8 s moves to 11', behindToShow(10.8, 10), 11);
t.equal('shown at 10: 9.2 s moves to 9', behindToShow(9.2, 10), 9);
t.equal('nothing shown: 4.9 s still shows nothing', behindToShow(4.9, 0), 0);

if (process.env.UNIT_ONLY) {
  console.log(t.fails ? `\n${t.fails} check(s) FAILED.` : '\nAll unit checks passed.');
  await exit(t.fails ? 1 : 0);
}

console.log('\nPart 2 — the row in the app');
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm run dev\` (or \`npm run build && npm start\`) in another terminal.`);

/** Homegrown Hits — the show of the report. Any feed would do: one item is rewritten. */
const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';
const GUID = 'e2e-live';

// A LOCAL LIVE STREAM, shaped like the real one: a 54 KB burst on connect,
// then 16 KB/s (128 kbps), for as long as the client stays. `hold()` keeps
// producing but delays delivery — the bytes wait, as they do in TCP during a
// Wi-Fi drop — and `release()` sends the backlog at once.
const dir = mkdtempSync(join(tmpdir(), 'bmb-livecatchup-'));
const tone = join(dir, 'tone.mp3');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
  '-ac', '2', '-ar', '44100', '-b:a', '128k', '-write_xing', '0', '-id3v2_version', '0', tone]);
const mp3 = readFileSync(tone);
rmSync(dir, { recursive: true, force: true });
const RATE = 16000;
const BURST = 54000;
let held = false;
let connections = 0;
const clients = new Set();
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/live.mp3')) { res.writeHead(404); res.end(); return; }
  connections++;
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  const c = { res, pos: 0, backlog: [] };
  clients.add(c);
  const produce = (n) => {
    const parts = [];
    while (n > 0) {
      const take = Math.min(n, mp3.length - c.pos);
      parts.push(mp3.subarray(c.pos, c.pos + take));
      c.pos = (c.pos + take) % mp3.length;
      n -= take;
    }
    const buf = Buffer.concat(parts);
    if (held) c.backlog.push(buf); else res.write(buf);
  };
  produce(BURST);
  const timer = setInterval(() => produce(RATE / 10), 100);
  req.on('close', () => { clearInterval(timer); clients.delete(c); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const STREAM = `http://127.0.0.1:${server.address().port}/live.mp3`;
const hold = () => { held = true; };
const release = () => {
  held = false;
  for (const c of clients) for (const b of c.backlog.splice(0)) c.res.write(b);
};
/** A network gap of `secs`, then `settle` seconds of play so the next tick has measured it. */
const gap = async (secs, settle = 4) => { hold(); await wait(secs * 1000); release(); await wait(settle * 1000); };

const { page } = await launchChrome({ name: `livecatchup-${process.env.CLAUDE_CODE_SESSION_ID ?? 'run'}`, autoplay: true, args: ['--window-size=1280,900'] });
const { send, js, until, on } = page;
/** `SHOTS=<dir>` saves what each state looks like, for a PR or a second look. */
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.SHOTS, name), Buffer.from(r.result.data, 'base64'));
};
const finish = async () => {
  server.close();
  for (const c of clients) c.res.destroy();
  console.log(t.fails ? `\n${t.fails} live catch-up check(s) FAILED.` : '\nAll live catch-up checks passed.');
  await exit(t.fails ? 1 : 0);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// One item of the show becomes a live broadcast whose enclosure is STREAM, and
// the live-status poll keeps it live. `liveValue` is dropped so no Split Kit
// socket opens for a show that is not on air.
await send('Fetch.enable', { patterns: [
  { urlPattern: '*/api/feed?*', requestStage: 'Response' },
  { urlPattern: '*/api/live-status?*', requestStage: 'Request' },
] });
on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request, responseStatusCode, responseHeaders } = m.params;
  const fulfill = (body, code = 200, headers = [{ name: 'content-type', value: 'application/json' }]) =>
    send('Fetch.fulfillRequest', { requestId, responseCode: code, responseHeaders: headers, body: Buffer.from(body).toString('base64') });
  try {
    if (request.url.includes('/api/live-status')) {
      await fulfill(JSON.stringify({ ok: true, items: [{ guid: GUID, status: 'live' }] }));
      return;
    }
    const r = await send('Fetch.getResponseBody', { requestId });
    const raw = r.result.base64Encoded ? Buffer.from(r.result.body, 'base64').toString('utf8') : r.result.body;
    const data = JSON.parse(raw);
    if (Array.isArray(data.episodes) && data.episodes.length) {
      const now = Math.floor(Date.now() / 1000);
      const base = data.episodes.find((e) => !e.liveStatus) ?? data.episodes[0];
      const live = { ...base, id: -990001, guid: GUID, title: 'E2E live broadcast', liveStatus: 'live',
        liveStartTime: now - 600, liveEndTime: now + 3600, enclosureUrl: STREAM, enclosureType: 'audio/mpeg' };
      delete live.liveValue;
      data.episodes = [live, ...data.episodes.filter((e) => !e.liveStatus)];
    }
    await fulfill(JSON.stringify(data), responseStatusCode,
      (responseHeaders ?? []).filter((h) => !/^content-(length|encoding)$/i.test(h.name)));
  } catch (e) {
    console.log(`  (interception of ${request.url} failed: ${e.message})`);
    await send('Fetch.continueRequest', { requestId }).catch(() => {});
  }
});

const A = `document.querySelector('${MINI_BAR} audio')`;
const EDGE = (where) => `document.querySelector('[data-live-edge="${where}"]')`;
const edgeText = (where) => js(`${EDGE(where)}?.textContent ?? null`);
const goLive = (where) => `${EDGE(where)}?.querySelector('[data-go-live]')`;
const behindIn = async (where) => Number((await edgeText(where))?.match(/(\d+) s behind/)?.[1] ?? NaN);
const playing = () => until(`(() => { const a = ${A}; return !!a && a.src === ${JSON.stringify(STREAM)} && !a.paused && a.readyState >= 3; })()`, 20000);

await send('Page.navigate', { url: `${APP}/?podcast=${HGH}&episode=${GUID}&t=0` });
if (!await playing()) {
  t.fail('the live item plays from the local stream', JSON.stringify(await js(`(() => { const a = ${A}; return a && { src: a.src, paused: a.paused, rs: a.readyState }; })()`)));
  await finish();
}
t.pass('the live item plays from the local stream');

/** The mini-bar's height: GO LIVE appearing must not grow it (the docblock claims so). */
const barHeight = () => js(`Math.round(document.querySelector('${MINI_BAR}').getBoundingClientRect().height * 10) / 10`);
/** A connection the browser opened reaches this process a moment after the click. */
const connectionsReach = async (n) => { for (let i = 0; i < 40 && connections < n; i++) await wait(150); return connections === n; };

// 1. On time: the row says so, and offers nothing.
await wait(8000);
t.ok('on time: the mini-bar row reads "streaming now"', /streaming now/.test(await edgeText('mini') ?? ''), await edgeText('mini'));
t.ok('on time: no GO LIVE', !await js(`!!${goLive('mini')}`));
const deskBar = await barHeight();

// 2. A 12 s gap: the row names the delay and offers GO LIVE.
await gap(12);
const n1 = await behindIn('mini');
t.ok('after a 12 s gap: "N s behind" with N in 9..14', n1 >= 9 && n1 <= 14, await edgeText('mini'));
t.ok('after a 12 s gap: GO LIVE is offered', await js(`!!${goLive('mini')}`));
await shot('desktop-mini-behind.png');
/** GO LIVE's box and the play/pause button's, in the mini-bar. */
const miniBoxes = () => js(`(() => {
  const r = (el) => { const b = el?.getBoundingClientRect(); return b && { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
  const toggle = document.querySelector('${MINI_BAR} button[aria-label="Pause"], ${MINI_BAR} button[aria-label="Play"]');
  return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, go: r(${goLive('mini')}), toggle: r(toggle),
    text: document.querySelector('${MINI_BAR}').innerText };
})()`);
// "On screen" is not enough: the first build passed that and the play/pause
// button sat on top of the button's last letter at 390 px. Nothing may cover it.
const uncovered = (b) => b.go && b.toggle && b.go.r <= b.toggle.l;
const desk = await miniBoxes();
t.ok('GO LIVE is at least 24 × 24 px', desk.go && desk.go.w >= 24 && desk.go.h >= 24, JSON.stringify(desk.go));
t.ok('GO LIVE ends before the play/pause button', uncovered(desk), JSON.stringify(desk));
t.equal('GO LIVE does not grow the mini-bar', await barHeight(), deskBar);

// 3. GO LIVE reconnects, and does not open the fullscreen player.
const before = connections;
await js(`${goLive('mini')}?.click()`);
t.ok('GO LIVE opens a new connection', await connectionsReach(before + 1), `connections ${before} → ${connections}`);
await wait(500);
t.ok('GO LIVE does not open the fullscreen player', !await js(`!!document.querySelector('button[aria-label="Close fullscreen player"]')`));
t.ok('after GO LIVE: the row reads "streaming now" again',
  await until(`/streaming now/.test(${EDGE('mini')}?.textContent ?? '')`, 6000), await edgeText('mini'));
t.ok('after GO LIVE: it plays', await playing());

// 4. A second gap after GO LIVE counts from the NEW source, and the fullscreen
//    player shows it and reconnects too.
await js(`document.querySelector('button[aria-label^="Open fullscreen player"]')?.click()`);
await until(`!!${EDGE('full')}`, 10000);
// 12 s like step 2, not 10: a gap soon after a fresh connect starts with more
// of the 54 KB burst still buffered, so the silence is shorter than the gap.
await gap(12);
const n2 = await behindIn('full');
t.ok('fullscreen, after a 12 s gap: "N s behind" with N in 8..14', n2 >= 8 && n2 <= 14, await edgeText('full'));
await shot('desktop-fullscreen-behind.png');
const before2 = connections;
await js(`${goLive('full')}?.click()`);
t.ok('fullscreen GO LIVE: "streaming now" again',
  await until(`/streaming now/.test(${EDGE('full')}?.textContent ?? '')`, 6000), await edgeText('full'));
t.ok('fullscreen GO LIVE: a new connection', await connectionsReach(before2 + 1), `connections ${before2} → ${connections}`);
await js(`document.querySelector('button[aria-label="Close fullscreen player"]')?.click()`);
await wait(800);

// 5. A pause hides the delay; play reconnects at the edge, as it did before.
//    12 s, not less: the element plays the ~2.3 s it holds before it goes
//    silent, so the delay is the gap MINUS that, and an 8 s gap lands on the
//    5 s threshold (it failed one run in two).
await gap(12);
t.ok('before the pause: the delay shows', (await behindIn('mini')) >= 5, await edgeText('mini'));
await js(`document.querySelector('${MINI_BAR} button[aria-label="Pause"]')?.click()`);
await until(`${A}?.paused === true`, 5000);
t.ok('paused: no delay and no GO LIVE', !/behind/.test(await edgeText('mini') ?? '') && !await js(`!!${goLive('mini')}`), await edgeText('mini'));
const before3 = connections;
await js(`document.querySelector('${MINI_BAR} button[aria-label="Play"]')?.click()`);
t.ok('play after a pause reconnects', await playing() && await connectionsReach(before3 + 1), `connections ${before3} → ${connections}`);

// 6. A phone. CDP device emulation, never --window-size (see global.md).
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await wait(1000);
const phoneBar = await barHeight();
await gap(10);
t.equal('390 px: GO LIVE does not grow the mini-bar', await barHeight(), phoneBar);
t.ok('390 px: the delay shows in the mini-bar', (await behindIn('mini')) >= 5, await edgeText('mini'));
await shot('phone-mini-behind.png');
const phone = await miniBoxes();
t.ok('390 px: no horizontal overflow', phone.scroll <= phone.client, JSON.stringify(phone));
t.ok('390 px: GO LIVE is at least 24 × 24 and on screen', phone.go && phone.go.w >= 24 && phone.go.h >= 24 && phone.go.l >= 0 && phone.go.r <= 390, JSON.stringify(phone.go));
t.ok('390 px: GO LIVE ends before the play/pause button', uncovered(phone), JSON.stringify(phone));
t.ok('390 px: play/pause stays on screen', phone.toggle && phone.toggle.r <= 390, JSON.stringify(phone.toggle));
t.ok('390 px: the delay is still said, once', (phone.text.match(/\d+ s behind/g) ?? []).length === 1, phone.text);

await finish();
