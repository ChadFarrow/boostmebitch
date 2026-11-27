// Drives the npub page's ZAPS RECEIVED panel (`<BoostExplorer>`) against a read
// index and relays this script controls, in a real browser.
//
// THE BUG (full-code review 2026-11-19, components/boost-explorer.tsx:128). The
// panel paints the index's receipts first, then the relay pass landed with
// `setZaps(z)`. `fetchZapsReceivedBy` answers `[]` for a read that failed or that
// no relay answered — it catches its own errors — so every receipt the index had
// shown was replaced by "no zaps to this npub surfaced…". The answers are now
// UNIONED by receipt id.
//
// WHAT IT PINS (the relay's answers are held back two seconds, so the index
// always lands first — the order the bug needs):
//   1. The index holds two receipts and the relays hold none: both stay listed.
//   2. The index holds two, the relays hold one of them plus a third: all three
//      are listed, once each.
//   3. Neither holds any: the panel says "no zaps…" and is not left searching.
//   4. Under phone emulation (390×844): case 2 again, and the page does not
//      overflow sideways.
//
// NOT PINNED: the panel waiting forever when the RECEIVED BOOSTS read fails with
// nothing on screen (the same review, :180, also fixed here). `useNostrFeed` sets
// `err` only when its fetcher throws, and `fetchBoostsReceivedBy` catches its own
// reads, so no input this script can give reaches that state.
//
// NOTHING LEAVES THE MACHINE. Every relay socket the page opens goes to a local
// relay; the index proxy is answered by CDP interception; Chrome resolves no host
// but the app's and loopback; nobody signs in, and nothing is published or paid.
//
//   npm run build && npm run start          (or any server on BMB_APP)
//   BMB_APP=http://localhost:3000 npm run e2e:explorerzaps

import http from 'node:http';
import net from 'node:net';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { createRelay } from './local-relay.mjs';

const APP = process.env.BMB_APP ?? process.env.E2E_APP ?? 'http://localhost:3000';
const RELAY_DELAY_MS = 2000;

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

// --- Keys and receipts ---------------------------------------------------------------
const now = () => Math.floor(Date.now() / 1000);
const subjectSk = generateSecretKey();
const subject = getPublicKey(subjectSk);
const lnurlServerSk = generateSecretKey(); // signs the receipt, as an LNURL server does
const zapperSk = generateSecretKey();
/** A NIP-57 receipt to `to`, whose zap request a throwaway zapper signed. */
function receipt(to, sats, comment, age) {
  const request = finalizeEvent({
    kind: 9734, created_at: now() - age, content: comment,
    tags: [['p', to], ['amount', String(sats * 1000)], ['relays', 'wss://relay.example']],
  }, zapperSk);
  return finalizeEvent({
    kind: 9735, created_at: now() - age, content: '',
    tags: [['p', to], ['description', JSON.stringify(request)]],
  }, lnurlServerSk);
}

// --- A relay whose answers arrive late -------------------------------------------------
// The handshake passes at once; every byte after it is held RELAY_DELAY_MS, in order,
// so the index answer (CDP, immediate) always lands before the relay pass does.
async function startScenario({ relayEvents }) {
  const relay = createRelay({ port: 0, log: null });
  const relayPort = await relay.ready;
  const seeder = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  await new Promise((r, j) => { seeder.onopen = r; seeder.onerror = j; });
  for (const e of relayEvents) seeder.send(JSON.stringify(['EVENT', e]));
  await wait(200);
  seeder.close();

  const sockets = new Set();
  const gate = http.createServer();
  gate.on('upgrade', (req, sock, head) => {
    const up = net.connect(relayPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      sock.pipe(up);
      let first = true;
      up.on('data', (d) => {
        if (first) { first = false; sock.write(d); return; }
        setTimeout(() => { if (!sock.destroyed) sock.write(d); }, RELAY_DELAY_MS);
      });
    });
    sockets.add(sock);
    sock.on('error', () => {});
    up.on('error', () => sock.destroy());
    sock.on('close', () => { sockets.delete(sock); up.destroy(); });
    up.on('close', () => setTimeout(() => sock.destroy(), RELAY_DELAY_MS + 100));
  });
  await new Promise((r) => gate.listen(0, '127.0.0.1', r));
  return {
    url: `ws://127.0.0.1:${gate.address().port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => gate.close(r));
      await relay.close();
    },
  };
}

// --- The browser ---------------------------------------------------------------------
const { page } = await launchChrome({
  name: 'explorer-zaps',
  args: ['--disable-gpu', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ${new URL(APP).hostname}`],
});
const { send, js, until, on } = page;
await send('Page.enable');
await send('Runtime.enable');

let indexReceipts = [];
const indexAsked = [];
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/nostr/index*', requestStage: 'Request' }] });
on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const url = decodeURIComponent(m.params.request.url);
  const zaps = url.includes(`/zaps/received/${subject}`);
  indexAsked.push(zaps ? 'zaps' : 'other');
  // Anything but the zaps route gets a shape the client reads as "no answer" —
  // never a 503, which would turn the index off for the whole tab.
  const body = zaps ? { receipts: indexReceipts, profiles: [] } : {};
  await send('Fetch.fulfillRequest', {
    requestId: m.params.requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  });
});

await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const Real = window.WebSocket;
    function Redirected(url, protocols) {
      const u = String(url);
      const own = /^wss?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/_next\\//.test(u);
      // Before the first scenario sets one, a closed port: refused, never public.
      const target = own ? u : (localStorage.getItem('e2e:relay_url') || 'ws://127.0.0.1:9');
      return protocols === undefined ? new Real(target) : new Real(target, protocols);
    }
    Redirected.prototype = Real.prototype;
    Object.assign(Redirected, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Redirected;
  })();
` });

const ZAPS = `[...document.querySelectorAll('section')].find((s) => /zaps received/i.test(s.querySelector('h2')?.textContent ?? ''))`;
const zapCards = () => js(`(() => { const s = ${ZAPS}; return s ? [...s.querySelectorAll('article')].map((a) => a.innerText.match(/e2e zap \\w+/)?.[0] ?? '?') : null; })()`);
const zapsText = () => js(`${ZAPS}?.innerText ?? ''`);

async function openPage(scenario) {
  await send('Page.navigate', { url: `${APP}/` });
  await until(`document.readyState === 'complete'`, 30000);
  // A fresh profile per run, so no feed cache warms a panel; the relay URL rides
  // localStorage so the socket shim reads it before any module opens a socket.
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('e2e:relay_url', ${JSON.stringify(scenario.url)}); 1`);
  indexAsked.length = 0;
  await send('Page.navigate', { url: `${APP}/npub/${nip19.npubEncode(subject)}` });
  await until(`document.readyState === 'complete'`, 30000);
  await until(`!!(${ZAPS})`, 20000);
}
/** Until the relay pass has had time to land: its delay, its quiet window, slack. */
const settle = () => wait(RELAY_DELAY_MS + 2500 + 3000);

const A = receipt(subject, 21, 'e2e zap alpha', 300);
const B = receipt(subject, 42, 'e2e zap bravo', 200);
const C = receipt(subject, 63, 'e2e zap charlie', 100);

// ------------------------------------------------------------------------------------
section('1. The index holds two receipts; the relays answer none');
{
  indexReceipts = [A, B];
  const sc = await startScenario({ relayEvents: [] });
  await openPage(sc);
  t.ok('the index receipts painted first', await until(`(() => { const s = ${ZAPS}; return s && s.querySelectorAll('article').length === 2; })()`, 10000),
    JSON.stringify(await zapCards()));
  t.ok('the index was asked for the zaps', indexAsked.includes('zaps'), JSON.stringify(indexAsked));
  await settle();
  t.equal('after the relay pass, both are still listed', (await zapCards())?.sort(), ['e2e zap alpha', 'e2e zap bravo']);
  t.ok('...and the panel does not claim none', !/no zaps to this npub/i.test(await zapsText()), await zapsText());
  await sc.close();
}

// ------------------------------------------------------------------------------------
section('2. The index holds two; the relays hold one of them and a third');
{
  indexReceipts = [A, B];
  const sc = await startScenario({ relayEvents: [B, C] });
  await openPage(sc);
  await settle();
  const cards = await zapCards();
  t.equal('all three are listed, newest first, each once', cards, ['e2e zap charlie', 'e2e zap bravo', 'e2e zap alpha']);
  await sc.close();
}

// ------------------------------------------------------------------------------------
section('3. Neither holds any');
{
  indexReceipts = [];
  const sc = await startScenario({ relayEvents: [] });
  await openPage(sc);
  await settle();
  t.ok('the panel says none', /no zaps to this npub/i.test(await zapsText()), await zapsText());
  t.ok('...and is not left searching', !/searching nostr relays/i.test(await zapsText()), await zapsText());
  await sc.close();
}

// ------------------------------------------------------------------------------------
section('4. Phone emulation (390×844): case 2, and no sideways overflow');
{
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  indexReceipts = [A, B];
  const sc = await startScenario({ relayEvents: [B, C] });
  await openPage(sc);
  await settle();
  t.equal('all three are listed, each once', await zapCards(), ['e2e zap charlie', 'e2e zap bravo', 'e2e zap alpha']);
  const overflow = await js('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  t.ok('the page does not overflow sideways', overflow <= 0, `overflow ${overflow}px`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sc.close();
}

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
