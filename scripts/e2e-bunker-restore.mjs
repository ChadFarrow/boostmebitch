// End-to-end for the WINDOW BEFORE THE BUNKER RESTORE SETTLES, against nothing
// but this machine.
//
// Usage:
//   npm run dev                  # in another terminal
//   npm run e2e:bunkerrestore    # headless
//   npm run e2e:bunkerrestore -- --headed --keep
//
// WHAT MAKES THIS WORTH HAVING. Nothing pure can see it. The fault is a
// SILENCE: `restoreBunkerSigner` sets `bunkerStale` only once the attempt
// settles, so a signer that never answers leaves the app looking signed in,
// with no `window.nostr`, for the whole `BUNKER_CONNECT_TIMEOUT_MS` — 90 s in
// which anything the user touches that signs fails with a generic error and
// nothing on screen says why. A unit test cannot observe "nothing rendered for
// ninety seconds", and no `check:*` can load `lib/nostr/bunker.ts` at all: it
// imports nostr-tools and touches browser globals.
//
// So this drives the real app in a real browser against a REAL relay (the same
// ~40 lines of NIP-01 `npm run relay` starts) and a stub remote signer that
// SUBSCRIBES AND SAYS NOTHING. That is the exact shape of the failure — the
// relay connects, the publish succeeds, and the answer never comes — and it is
// not the same as an unreachable relay, which rejects in milliseconds.
//
// NOTHING REACHES A PUBLIC RELAY and every key is generated per run.
//
// What it pins, in order of what it costs when wrong:
//   1. The wait SAYS SO. <BunkerRestoreNotice> is on screen while the handshake
//      hangs, with the menu CLOSED — the surface a cold load actually has.
//   2. It is not frozen. The elapsed count moves.
//   3. It gives way to the settled answer: once the connect times out the
//      notice is gone and <BunkerHealthBanner> has taken over.
//   4. RECONNECT stays disabled ACROSS A MENU CLOSE while its restore is still
//      on the wire. `busy` cannot do that — it dies with the panel — and a
//      pressable button there invites the competing transport this coalesces
//      away.
//   5. A HEALTHY restore raises none of it. This is the must-still-work half —
//      a notice on every cold load is its own bug.

import { createRelay } from './local-relay.mjs';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';

const PORT = 7457, CDP = 9225, APP = 'http://localhost:3000';
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

const appUp = await fetch(APP).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);
  console.error('(and `rm -rf .next` first if you have just run a production build)');
  process.exit(1);
}

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = `${tmpdir()}/bmb-e2e-bunker-restore`;
rmSync(profile, { recursive: true, force: true });
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const chrome = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  ...(asRoot ? ['--no-sandbox'] : []),
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  'about:blank',
], { stdio: 'ignore' });
const stopChrome = () => { if (!KEEP) chrome.kill(); };
process.on('exit', stopChrome);

let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) {
  ready = await fetch(`http://127.0.0.1:${CDP}/json/version`).then((r) => r.ok).catch(() => false);
  if (!ready) await new Promise((r) => setTimeout(r, 250));
}
if (!ready) { console.error(`Chrome never opened its debug port on ${CDP}.`); process.exit(1); }

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);

createRelay({ port: PORT, log: null });

// ---- the stub signer -------------------------------------------------------
//
// One subscription over the local relay, exactly like the mutes suite's. The
// difference is the whole test: `answer` starts false, so every request is READ
// and none is replied to. Flipping it to true is scenario 3's healthy signer.
const bunkerSk = generateSecretKey();
const bunkerPk = getPublicKey(bunkerSk);
const clientSk = generateSecretKey();
const clientPk = getPublicKey(clientSk);
const rpcKey = nip44.v2.utils.getConversationKey(bunkerSk, clientPk);

let answer = false;
const seen = [];
const relayWs = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => relayWs.addEventListener('open', r));
relayWs.send(JSON.stringify(['REQ', 'bunker', { kinds: [24133], '#p': [bunkerPk] }]));
relayWs.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] !== 'EVENT' || msg[1] !== 'bunker') return;
  let req;
  try { req = JSON.parse(nip44.v2.decrypt(msg[2].content, rpcKey)); } catch { return; }
  seen.push(req.method);
  if (!answer) return; // the silence under test
  let reply;
  if (req.method === 'connect') reply = { id: req.id, result: 'ack' };
  else if (req.method === 'get_public_key') reply = { id: req.id, result: pk };
  else if (req.method === 'ping') reply = { id: req.id, result: 'pong' };
  else reply = { id: req.id, error: `unsupported: ${req.method}` };
  relayWs.send(JSON.stringify(['EVENT', finalizeEvent({
    kind: 24133,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', clientPk]],
    content: nip44.v2.encrypt(JSON.stringify(reply), rpcKey),
  }, bunkerSk)]));
});

// ---- CDP -------------------------------------------------------------------
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n          got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

// THE NOTICE RENDERS OUTSIDE THE MENU, which is the point of it, so this reads
// the whole document rather than `[role="menu"]`. The elapsed count comes back
// too: "not frozen" is the second assertion and a boolean cannot carry it.
const restoreNotice = () => js(`(() => {
  const m = (document.body.innerText || '').match(/Reconnecting to your signer…\\s*\\((\\d+)s\\)/);
  return m ? Number(m[1]) : null;
})()`);
const staleBanner = () => js(`/Signer disconnected/i.test(document.body.innerText || '')`);

const accountMenuText = () => js(`(() => {
  const m = [...document.querySelectorAll('[role="menu"]')]
    .find((el) => /sign out/i.test(el.innerText || ''));
  return m ? m.innerText : null;
})()`);
// `mousedown`, not `click`: the dismiss-on-outside listener is on mousedown.
async function closeAccountMenu() {
  await js(`(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1; })()`);
  await wait(300);
}
async function openAccountMenu() {
  if (await accountMenuText() !== null) return true;
  const triggers = await js(`document.querySelectorAll('button[aria-haspopup="menu"]').length`);
  for (let i = 0; i < triggers; i += 1) {
    await js(`(() => { const b = document.querySelectorAll('button[aria-haspopup="menu"]')[${i}]; if (b) b.click(); return true; })()`);
    await wait(300);
    if (await accountMenuText() !== null) return true;
  }
  return false;
}
/** The RECONNECT button's disabled state, or null when it is not rendered. */
const reconnectDisabled = () => js(`(() => {
  const b = [...document.querySelectorAll('button')].find((el) => /^Reconnect/i.test((el.innerText || '').trim()));
  return b ? b.disabled : null;
})()`);

const bootstrap = () => `(() => { localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'bunker');
  localStorage.setItem('bmb:bunker', ${JSON.stringify(JSON.stringify({ uri: `bunker://${bunkerPk}?relay=ws://127.0.0.1:${PORT}`, clientSk: hex(clientSk) }))});
  return 1; })()`;

await send('Page.enable'); await send('Runtime.enable');

// ---- 1. the signer that never answers --------------------------------------
console.log('\n1. a signer that subscribes and says nothing');
await send('Page.navigate', { url: APP }); await wait(2000);
await js(bootstrap());
seen.length = 0;
const t0 = Date.now();
await send('Page.navigate', { url: APP });

// The quiet period: a healthy handshake settles inside it, so nothing may be on
// screen yet. Read at 3 s — before the notice's own 5 s threshold.
await wait(3000);
check('nothing on screen during the quiet period', await restoreNotice(), null);
check('and no stale banner either — nothing has settled', await staleBanner(), false);

// Past the threshold the wait must be visible with the menu CLOSED.
await wait(5000);
const first = await restoreNotice();
check('the wait is on screen, menu closed', typeof first === 'number', true);
check('the connect really went out', seen.includes('connect'), true);

await wait(4000);
const second = await restoreNotice();
check('the count moves — the sentence is not frozen', typeof second === 'number' && second > first, true);

check('the notice is inside the open menu too',
  await openAccountMenu() ? /Reconnecting to your signer/.test(await accountMenuText() ?? '') : 'menu would not open', true);
// No RECONNECT yet, and that is correct rather than a gap: <BunkerHealthBanner>
// renders off `bunkerStale`, which nothing has set — the attempt has not
// settled. The button is scenario 2's subject, once it has.
check('no reconnect button while nothing has settled', await reconnectDisabled(), null);
await closeAccountMenu();

// ---- 2. the settled answer takes over --------------------------------------
//
// BUNKER_CONNECT_TIMEOUT_MS is 90 s and this waits it out on purpose: the whole
// claim is that the notice covers the window and then GETS OUT OF THE WAY.
console.log('\n2. once it settles, the notice gives way to the banner');
const spent = Date.now() - t0;
await wait(Math.max(0, 95_000 - spent));
check('the notice is gone', await restoreNotice(), null);
check('the session was not signed out', await js(`localStorage.getItem('bmb:signer')`), 'bunker');
check('the reconnect banner has taken over',
  await openAccountMenu() ? /signer disconnected/i.test(await accountMenuText() ?? '') : 'menu would not open', true);
check('and RECONNECT is pressable again', await reconnectDisabled(), false);

// THE PRESS, AND THE CLOSE. `busy` alone would report this button as pressable
// again the moment the panel is re-rendered, with the restore it started still
// on the wire for another 90 s.
await js(`(() => { const b = [...document.querySelectorAll('button')].find((el) => /^Reconnect/i.test((el.innerText || '').trim())); b.click(); return 1; })()`);
await wait(500);
check('RECONNECT is disabled while its own restore runs', await reconnectDisabled(), true);
await closeAccountMenu();
await openAccountMenu();
check('still disabled after the menu was closed and reopened', await reconnectDisabled(), true);
await closeAccountMenu();

// ---- 3. the must-still-work half -------------------------------------------
console.log('\n3. a healthy restore raises none of it');
answer = true;
await send('Page.navigate', { url: APP }); await wait(2000);
await js(bootstrap());
seen.length = 0;
await send('Page.navigate', { url: APP });
await wait(8000);
check('no notice on a cold load that connected', await restoreNotice(), null);
check('no stale banner either', await staleBanner(), false);
check('the bunker really connected', seen.includes('connect'), true);

console.log(failures === 0 ? '\nAll bunker-restore checks passed.\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
