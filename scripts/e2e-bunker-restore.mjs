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
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';

const APP = 'http://localhost:3000';

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.
(and \`rm -rf .next\` first if you have just run a production build)`);

// The browser comes from scripts/cdp.mjs: muted, on a free debug port, closed
// on any exit, `--no-sandbox` only as root, and left open by `--keep`.
const { page } = await launchChrome({ name: 'bunker-restore', args: ['--disable-gpu'] });

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);

// Port 0 and read back, never a fixed port: another run can already hold one.
const PORT = await createRelay({ port: 0, log: null }).ready;

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
/**
 * CLAVE'S CURRENT BEHAVIOUR, and the whole point of scenario 4.
 *
 * Clave `dc59364` (2026-06-14) stopped answering `permission denied` at
 * prompt-time — a populated `error` is TERMINAL under NIP-46, so every compliant
 * client stops listening — and now HOLDS the request, sending nothing until the
 * user taps approve. It keeps answering `ping` throughout, which it auto-allows.
 * So: everything replies, `sign_event` does not.
 */
let holdSign = false;
/** Requests read but deliberately left unanswered, so a later flip can settle
 *  the one already in flight rather than a re-issued copy. */
const held = [];
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
  if (holdSign && req.method === 'sign_event') { held.push(req); return; }
  send46(replyFor(req));
});

function replyFor(req) {
  if (req.method === 'connect') return { id: req.id, result: 'ack' };
  if (req.method === 'get_public_key') return { id: req.id, result: pk };
  if (req.method === 'ping') return { id: req.id, result: 'pong' };
  if (req.method === 'sign_event') {
    // A real signature, so the app's own verification is exercised rather than
    // bypassed — `signEvent`'s caller treats an unverifiable event as a failure.
    return { id: req.id, result: JSON.stringify(finalizeEvent(JSON.parse(req.params[0]), sk)) };
  }
  return { id: req.id, error: `unsupported: ${req.method}` };
}

function send46(reply) {
  relayWs.send(JSON.stringify(['EVENT', finalizeEvent({
    kind: 24133,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', clientPk]],
    content: nip44.v2.encrypt(JSON.stringify(reply), rpcKey),
  }, bunkerSk)]));
}

// ---- CDP -------------------------------------------------------------------
const { send } = page;
const js = page.jsOrThrow;
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const t = checker();
const check = (label, got, want) => t.equal(label, got, want);

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

// ---- 4. the signer that QUEUES the signature -------------------------------
//
// THE FIELD BUG, driven end to end. Reported from an iPhone on an auto-Clave
// (`nostrconnect://`) pairing: sign-in works, the account menu says "Signer
// disconnected", RECONNECT succeeds, and the next action puts the banner back.
//
// Before the fix this failed at the first assertion below. `trackBunkerCall`
// bounded the call at BUNKER_CALL_TIMEOUT_MS (30 s), the expiry is an `Error`,
// so `isRemoteSignerError` was false and `markBunkerStale()` ran — the reconnect
// banner over a signer that was answering `ping` the whole time.
//
// The signature is requested through `window.nostr` rather than by driving a
// control, because that IS the adapter under test: the app publishes the
// signer's `nostrApi` there and reaches it the same way. It keeps the scenario
// about the transport instead of about whichever button happens to sign today.
console.log('\n4. a signer that answers ping but QUEUES the signature');
answer = true;
holdSign = true;
held.length = 0;
await send('Page.navigate', { url: APP }); await wait(2000);
await js(bootstrap());
seen.length = 0;
await send('Page.navigate', { url: APP });
await wait(8000);
check('the session connected before anything is signed', seen.includes('connect'), true);

await js(`(() => {
  window.__signed = null;
  window.nostr.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'queued-approval probe' })
    .then((e) => { window.__signed = { ok: true, id: e.id }; })
    .catch((e) => { window.__signed = { ok: false, err: String(e && e.message ? e.message : e) }; });
  return 1;
})()`);
// PAST THE 30 s BOUND ON PURPOSE. That is the whole point: the old code gave up
// here, and the user has not tapped approve yet.
await wait(38000);

check('the signature is still outstanding, not failed', await js(`window.__signed`), null);
// THE MENU MUST BE OPEN to read the banner: <BunkerHealthBanner> renders inside
// <AccountMenu>, so `document.body.innerText` does not contain it while the menu
// is closed and the assertion would pass whatever the flag said. Scenario 2
// opens it for the same reason; this one nearly shipped without it, and a
// trivially-passing assertion is worse than none.
await openAccountMenu();
check('...and the banner does NOT claim the signer is disconnected', await staleBanner(), false);
// The probe is what earns that: a pong proves both directions of a link a bare
// timeout can only guess about.
check('...because it pinged the signer instead of accusing it', seen.includes('ping'), true);
check('...and it did NOT re-issue, which would queue a second approval',
  seen.filter((m) => m === 'sign_event').length, 1);

// The user taps approve. The request already in flight is the one that settles.
for (const req of held.splice(0)) send46(replyFor(req));
await wait(4000);
const signed = await js(`window.__signed`);
check('a late approval completes the signature that was waiting', signed?.ok, true);
check('...and the banner never went up', await staleBanner(), false);
await closeAccountMenu();

console.log(t.fails === 0 ? '\nAll bunker-restore checks passed.\n' : `\n${t.fails} FAILED\n`);
await exit(t.fails === 0 ? 0 : 1);
