// Drives the permanent host link `/live/<npub>` against relays this script
// controls, in a real browser, and asserts that "isn't live right now" is said
// only after a read that can be believed.
//
// THE BUG (full-code review 2026-11-19, app/live/[npub]/page.tsx:97). The page
// asked `fetchLatestStreamByPubkey` three times and, with no live stream in hand,
// said the host "isn't live right now". That read was `pool.querySync`, which
// resolves at the library's aggregate EOSE — and a failed connection fires that
// too, in milliseconds. So an offline phone, or every relay down, told the
// listener the host was off air. The read now counts relays
// (`collectEventsDetailed`), and the page says it could not tell.
//
// WHAT IT PINS:
//   1. Every relay refuses the connection: the page says it couldn't reach the
//      relays, offers ↻ Try again, and never says "isn't live right now".
//   2. The relays come back and ↻ Try again is pressed: the same page now says
//      "isn't live right now" (the relay answered, and holds nothing).
//   3. The relay holds the host's PLANNED stream: "isn't live right now" and the
//      "Next: … starts …" hint.
//   4. Under phone emulation (390×844): case 1, no sideways overflow, and both
//      buttons at least 24×24 (WCAG 2.5.8).
//   5. The relay holds a host's fresh LIVE stream: the player opens with its
//      title, and neither placeholder is shown (what must still work).
//
// NOTHING LEAVES THE MACHINE. Every relay socket the page opens goes to one local
// gate in front of a local relay; Chrome resolves no host but the app's and
// loopback; nobody signs in, and nothing is published or paid.
//
//   npm run build && npm run start          (or any server on BMB_APP)
//   BMB_APP=http://localhost:3000 npm run e2e:livepage

import http from 'node:http';
import net from 'node:net';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createRelay } from './local-relay.mjs';

const APP = process.env.BMB_APP ?? process.env.E2E_APP ?? 'http://localhost:3000';
const NOT_LIVE = "isn't live right now";
const UNREACHABLE = "Couldn't reach the Nostr relays";

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

// --- A relay behind a gate that can refuse every connection ------------------------
const relay = createRelay({ port: 0, log: null });
const relayPort = await relay.ready;
const gate = { refuse: true, dials: 0, sockets: new Set() };
const gateServer = http.createServer();
gateServer.on('upgrade', (req, sock, head) => {
  gate.dials += 1;
  if (gate.refuse) { sock.destroy(); return; }
  const up = net.connect(relayPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  gate.sockets.add(sock);
  sock.on('error', () => {});
  up.on('error', () => sock.destroy());
  sock.on('close', () => { gate.sockets.delete(sock); up.destroy(); });
  up.on('close', () => sock.destroy());
});
await new Promise((r) => gateServer.listen(0, '127.0.0.1', r));
const GATE = `ws://127.0.0.1:${gateServer.address().port}`;

const hostSk = generateSecretKey();
const host = getPublicKey(hostSk);
const quietHostSk = generateSecretKey();
const quietHost = getPublicKey(quietHostSk);
const planned = finalizeEvent({
  kind: 30311, created_at: Math.floor(Date.now() / 1000), content: '',
  tags: [
    ['d', 'e2e-planned'], ['title', 'E2E planned show'], ['status', 'planned'],
    ['starts', String(Math.floor(Date.now() / 1000) + 3600)],
    ['streaming', 'https://example.invalid/e2e.m3u8'],
  ],
}, hostSk);
const liveHostSk = generateSecretKey();
const liveHost = getPublicKey(liveHostSk);
const live = finalizeEvent({
  kind: 30311, created_at: Math.floor(Date.now() / 1000), content: '',
  tags: [
    ['d', 'e2e-live'], ['title', 'E2E live show'], ['status', 'live'],
    ['starts', String(Math.floor(Date.now() / 1000) - 600)],
    // Unresolvable on purpose (`--host-resolver-rules`): nothing plays.
    ['streaming', 'https://example.invalid/e2e-live.m3u8'],
  ],
}, liveHostSk);
{
  const seeder = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  await new Promise((r, j) => { seeder.onopen = r; seeder.onerror = j; });
  seeder.send(JSON.stringify(['EVENT', planned]));
  seeder.send(JSON.stringify(['EVENT', live]));
  await wait(200);
  seeder.close();
}

// --- The browser --------------------------------------------------------------------
const { page } = await launchChrome({
  name: 'live-page-read',
  args: ['--disable-gpu', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ${new URL(APP).hostname}`],
});
const { send, js, until } = page;
await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const Real = window.WebSocket;
    function Redirected(url, protocols) {
      const u = String(url);
      const own = /^wss?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/_next\\//.test(u);
      const target = own ? u : ${JSON.stringify(GATE)};
      return protocols === undefined ? new Real(target) : new Real(target, protocols);
    }
    Redirected.prototype = Real.prototype;
    Object.assign(Redirected, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Redirected;
  })();
` });

const text = () => js('document.body.innerText');
const settled = () => until(`(() => { const s = document.body.innerText; return s.includes(${JSON.stringify(NOT_LIVE)}) || s.includes(${JSON.stringify(UNREACHABLE)}); })()`, 45000);
async function openLive(pubkey) {
  await send('Page.navigate', { url: `${APP}/live/${nip19.npubEncode(pubkey)}` });
  await until(`document.readyState === 'complete'`, 30000);
  return settled();
}
const button = (re) => `[...document.querySelectorAll('button')].find((b) => ${re}.test(b.textContent ?? ''))`;

// ------------------------------------------------------------------------------------
section('1. Every relay refuses the connection');
gate.refuse = true;
t.ok('the page settled', await openLive(quietHost), (await text()).slice(0, 300));
t.ok('the relays were dialled', gate.dials > 0, `dials ${gate.dials}`);
t.ok(`it never says "${NOT_LIVE}"`, !(await text()).includes(NOT_LIVE), (await text()).slice(0, 300));
t.ok('it says it could not reach the relays', (await text()).includes(UNREACHABLE), (await text()).slice(0, 300));
t.ok('it offers Try again', await js(`!!${button('/try again/i')}`));

// ------------------------------------------------------------------------------------
section('2. The relays come back, and Try again is pressed');
gate.refuse = false;
await js(`${button('/try again/i')}?.click()`);
t.ok('the page settled again', await until(`document.body.innerText.includes(${JSON.stringify(NOT_LIVE)})`, 45000), (await text()).slice(0, 300));
t.ok(`now it says "${NOT_LIVE}"`, (await text()).includes(NOT_LIVE));
t.ok('...and no longer that it could not reach them', !(await text()).includes(UNREACHABLE));

// ------------------------------------------------------------------------------------
section('3. The relay holds the host\'s planned stream');
t.ok('the page settled', await openLive(host), (await text()).slice(0, 300));
t.ok(`it says "${NOT_LIVE}"`, (await text()).includes(NOT_LIVE), (await text()).slice(0, 300));
t.ok('...with the "Next:" hint for the planned stream', /Next: E2E planned show — starts/.test(await text()), (await text()).slice(0, 300));

// ------------------------------------------------------------------------------------
section('4. Phone emulation (390×844): case 1');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
gate.refuse = true;
t.ok('the page settled', await openLive(quietHost));
t.ok('it says it could not reach the relays', (await text()).includes(UNREACHABLE));
const m = await js(`(() => {
  const r = (b) => { const x = b?.getBoundingClientRect(); return x ? [Math.round(x.width), Math.round(x.height)] : null; };
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    retry: r(${button('/try again/i')}),
    browse: r(${button('/browse shows/i')}),
  };
})()`);
t.ok('the page does not overflow sideways', m.overflow <= 0, JSON.stringify(m));
t.ok('Try again is at least 24×24', m.retry && m.retry[0] >= 24 && m.retry[1] >= 24, JSON.stringify(m));
t.ok('Browse shows is at least 24×24', m.browse && m.browse[0] >= 24 && m.browse[1] >= 24, JSON.stringify(m));
await send('Emulation.clearDeviceMetricsOverride');

// ------------------------------------------------------------------------------------
section('5. The relay holds a fresh live stream');
gate.refuse = false;
await send('Page.navigate', { url: `${APP}/live/${nip19.npubEncode(liveHost)}` });
await until(`document.readyState === 'complete'`, 30000);
t.ok('the player opens with the stream title', await until(`document.body.innerText.includes('E2E live show')`, 45000), (await text()).slice(0, 300));
await wait(1000);
t.ok('...and neither placeholder is shown', !(await text()).includes(NOT_LIVE) && !(await text()).includes(UNREACHABLE));

for (const s of gate.sockets) s.destroy();
await new Promise((r) => gateServer.close(r));
await relay.close();
console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
