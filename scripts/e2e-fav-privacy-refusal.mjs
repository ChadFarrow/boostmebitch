// End-to-end: a favorites privacy switch whose publish is REFUSED says so.
//
// Usage:
//   npm run build && npx next start -p 3431     # or `npm run dev` (port 3000)
//   BMB_APP=http://127.0.0.1:3431 npm run e2e:favrefusal
//   MOBILE=1 BMB_APP=… npm run e2e:favrefusal   # the same, under phone emulation
//
// Full-code review 2026-11-19, finding 14. `apply` in
// components/favorites-privacy.tsx records the new mode, then awaits one
// read-merge-publish cycle to move the entries. That cycle answers `null` for a
// refusal — a degraded read, a publish that reached no relay — and the dialog
// ignored the answer, so it closed as though the move were done. For a switch
// to Private that leaves the entries in plaintext on the relay while the
// control says Private. And the first-favorite prompt closed itself the moment
// `busy` fell, over any error the dialog had just set.
//
// Against nothing but this machine: a throwaway key, a signer reached over a
// CDP binding, and scripts/local-relay.mjs on 127.0.0.1 with its opt-in
// `refuse` hook — REQs answer, EVENTs get `OK false`. Chrome resolves no host
// but loopback, and every WebSocket the page opens is checked to be local.
//
// What it pins:
//   1. A refused switch to Private keeps the dialog open with the reason, the
//      relay still holds the PUBLIC list, and the setting is PUT BACK to Public
//      (a stored mode the wire does not follow is a half-applied setting).
//   2. Pressing Switch again once the relay accepts moves the entries and closes.
//   2b. The reverse, on a list that now STATES its mode: a refused switch to
//      Public keeps the private list and the Private setting.
//   3. The first-favorite prompt (mode never chosen) holds its error too: it no
//      longer closes itself over a refusal, and the answer is kept.
// Against main, 1 and 3 fail: the dialog closes (measured, see the PR).

import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';
import WebSocket from 'ws';

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
const MOBILE = process.env.MOBILE === '1';

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\`, or a build with \`next start\` and BMB_APP.`);

const { page } = await launchChrome({
  name: 'favrefusal',
  // Loopback only — plus the app's own host when BMB_APP is a deployment, which
  // is how the same run measures `main` on production.
  args: ['--disable-gpu', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ${new URL(APP).hostname}`],
});
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const convo = nip44.v2.utils.getConversationKey(sk, pk);

const ALBUM = 'fce40d63-ef30-5c85-af07-d99b3c759807';
const OTHER_ALBUM = '93007b6c-2093-5ddb-9b5f-7226c93d67e0';

let refusing = false;
const published = [];
const relay = createRelay({
  port: 0,
  log: null,
  refuse: () => (refusing ? 'blocked: e2e refuses writes' : null),
  onEvent: (e) => { if (e.kind === 10333) published.push(e); },
});
const PORT = await relay.ready;
const latest = () => [...relay.events.values()].filter((e) => e.kind === 10333 && e.pubkey === pk)
  .sort((a, b) => b.created_at - a.created_at)[0] ?? null;

const { send } = page;
const js = page.jsOrThrow;
const until = page.until;
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
const sockets = new Map(); // requestId -> url
const connected = [];
const exceptions = [];
page.on((m) => {
  if (m.method === 'Network.webSocketCreated') sockets.set(m.params.requestId, m.params.url);
  if (m.method === 'Network.webSocketHandshakeResponseReceived') connected.push(sockets.get(m.params.requestId) ?? '?');
  if (process.env.DEBUG && m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/favorites|fav/i.test(text)) console.log(`     [page] ${text.slice(0, 220)}`);
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
});
if (MOBILE) {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
}

// The signer: a window.nostr indistinguishable from an extension.
await send('Runtime.addBinding', { name: 'bmbSigner' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = pk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], sk);
    else if (fn === 'nip44.encrypt') out = nip44.v2.encrypt(args[1], convo);
    else if (fn === 'nip44.decrypt') out = nip44.v2.decrypt(args[1], convo);
    else if (fn === 'nip04.encrypt') out = await nip04.encrypt(sk, args[0], args[1]);
    else if (fn === 'nip04.decrypt') out = await nip04.decrypt(sk, args[0], args[1]);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  // Not awaited into the void: a reply in flight when the browser closes must
  // not end the run as an unhandled rejection.
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`).catch(() => {});
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const waiting = new Map(); let n = 0;
    window.__bmbResolve = (rid, r) => { const p = waiting.get(rid); waiting.delete(rid); r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      const rid = 'r' + (++n); waiting.set(rid, { resolve, reject });
      window.bmbSigner(JSON.stringify({ rid, fn, args }));
    });
    window.nostr = {
      getPublicKey: () => call('getPublicKey'),
      signEvent: (e) => call('signEvent', e),
      nip44: { encrypt: (p, t) => call('nip44.encrypt', p, t), decrypt: (p, c) => call('nip44.decrypt', p, c) },
      nip04: { encrypt: (p, t) => call('nip04.encrypt', p, t), decrypt: (p, c) => call('nip04.decrypt', p, c) },
    };
  })();
` });

const t = checker();
const DIALOG = `document.querySelector('[role="dialog"]')`;
const dialogState = () => js(`(() => { const d = ${DIALOG}; if (!d) return null;
  return JSON.stringify({ heading: d.querySelector('h3')?.textContent.trim() ?? '', alert: d.querySelector('[role="alert"]')?.textContent.trim() ?? '' }); })()`)
  .then((s) => (s ? JSON.parse(s) : null));
const pressInDialog = (label) => js(`(() => { const d = ${DIALOG}; const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
const modeControlSays = () => js(`(() => { const t = document.querySelector('button[aria-haspopup="menu"][aria-label^="Favorites are"]'); return t ? t.getAttribute('aria-label') : null; })()`);
const storedMode = () => js(`localStorage.getItem('bmb:fav_privacy:' + ${JSON.stringify(npub)})`);
const overflow = () => js(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
// Press a dialog button and wait for the app's answer: the dialog gone, or an
// alert up with the button no longer "working…". It first waits for the press
// to TAKE (busy, or gone), or an alert left by the last press settles it at once.
const WORKING = `[...(${DIALOG}?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === 'working…')`;
const pressAndSettle = async (label) => {
  const pressed = await pressInDialog(label);
  await until(`!${DIALOG} || ${WORKING}`, 5000, 50);
  await until(`(() => { const d = ${DIALOG}; return !d || (!${WORKING} && !!d.querySelector('[role="alert"]')?.textContent.trim()); })()`, 45000, 250);
  return pressed;
};

const seedDevice = () => js(`(() => { localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:fav_private_optin', '1');
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:favorites:' + ${JSON.stringify(npub)}, JSON.stringify({
    ${JSON.stringify(ALBUM)}: { id: 0, podcastGuid: ${JSON.stringify(ALBUM)}, title: 'Homegrown Hits', medium: 'music', addedAt: 1 },
  }));
  return 1; })()`);
await send('Page.navigate', { url: APP }); await wait(2500);
await seedDevice();
console.log(`\n  throwaway npub ${npub.slice(0, 20)}…  relay ws://127.0.0.1:${PORT}${MOBILE ? '  (390×844 phone emulation)' : ''}\n`);

// ---------------------------------------------------------------------------
console.log('--- 0. a public list on the relay (the e2e:favorites start) ---');
await send('Page.navigate', { url: `${APP}/favorites` });
const asks = await until(`!![...document.querySelectorAll('[role="status"] button')].find((x) => x.textContent.trim() === 'save as new list')`, 30000);
t.ok('the notice offers to create the list', asks);
await js(`(() => { const b = [...document.querySelectorAll('[role="status"] button')].find((x) => x.textContent.trim() === 'save as new list'); if (b) b.click(); return !!b; })()`);
for (let i = 0; i < 160 && !latest(); i++) await wait(250);
t.ok('a public kind:10333 reaches the relay', !!latest());
t.equal('...with the album in the public tags and an empty content',
  [latest()?.tags.filter((x) => x[0] === 'i').length, latest()?.content], [1, '']);
t.equal('the control shows Public', await modeControlSays(), 'Favorites are: Public');

// ---------------------------------------------------------------------------
console.log('\n--- 1. a switch to Private whose publish is REFUSED stays open and says why ---');
refusing = true;
const beforeRefused = latest();
await js(`(() => { const t = document.querySelector('button[aria-haspopup="menu"][aria-label^="Favorites are"]'); if (t) t.click(); return 1; })()`);
await until(`!![...document.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent.trim() === 'Private')`, 5000);
await js(`(() => { const b = [...document.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent.trim() === 'Private'); if (b && !b.disabled) b.click(); return 1; })()`);
await until(`!!${DIALOG}`, 5000);
t.equal('the switch dialog is up', (await dialogState())?.heading, 'Switch to Private?');
t.ok('Switch is pressed', await pressAndSettle('Switch'));
const refused = await dialogState();
t.ok('the dialog is STILL OPEN after the refusal', refused !== null, 'it closed as if the move were done');
t.ok('...naming what happened', /^Nothing was changed: your relays did not confirm/.test(refused?.alert ?? ''), refused?.alert);
t.ok('...the setting it left in place, and how to retry', /still “Public”\. Press Switch to try again/.test(refused?.alert ?? ''), refused?.alert);
t.equal('the relay still holds the PUBLIC list, untouched', latest()?.id, beforeRefused?.id);
t.equal('the setting is put back to Public', await storedMode(), 'public');
t.equal('...and the control says so', await modeControlSays(), 'Favorites are: Public');
if (MOBILE) t.equal('no sideways overflow with the error up', await overflow(), 0);

// ---------------------------------------------------------------------------
console.log('\n--- 2. Switch again once the relay accepts: the entries move, the dialog closes ---');
refusing = false;
t.ok('Switch is pressed again', await pressAndSettle('Switch'));
t.equal('the dialog closed', await dialogState(), null);
const moved = latest();
t.ok('a new list reached the relay', moved && moved.id !== beforeRefused?.id);
t.equal('nothing of ours is left in the public tags', moved?.tags.filter((x) => x[0] === 'i').length, 0);
let priv = [];
try { priv = JSON.parse(nip44.v2.decrypt(moved?.content ?? '', convo)); } catch { /* asserted below */ }
t.ok('the album is in the encrypted half', priv.some((x) => x[0] === 'i' && x[1] === `podcast:guid:${ALBUM}`), JSON.stringify(priv));
t.equal('the control shows Private', await modeControlSays(), 'Favorites are: Private');
t.equal('the list now STATES its mode', moved?.tags.find((x) => x[0] === 'visibility')?.[1], 'private');

// ---------------------------------------------------------------------------
console.log('\n--- 2b. the reverse, refused: a switch to Public keeps the private list and the setting ---');
refusing = true;
await js(`(() => { const t = document.querySelector('button[aria-haspopup="menu"][aria-label^="Favorites are"]'); if (t) t.click(); return 1; })()`);
await until(`!![...document.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent.trim() === 'Public')`, 5000);
await js(`(() => { const b = [...document.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent.trim() === 'Public'); if (b && !b.disabled) b.click(); return 1; })()`);
await until(`!!${DIALOG}`, 5000);
t.equal('the switch dialog is up', (await dialogState())?.heading, 'Switch to Public?');
t.ok('Switch is pressed', await pressAndSettle('Switch'));
const back = await dialogState();
t.ok('the dialog is still open', back !== null);
t.ok('...saying the setting is still Private', /^Nothing was changed: .*still “Private”\./.test(back?.alert ?? ''), back?.alert);
t.equal('the relay still holds the private list', latest()?.id, moved?.id);
t.equal('the setting is still Private', await storedMode(), 'private');
t.ok('Cancel closes it', await pressInDialog('Cancel') && await until(`!${DIALOG}`, 5000));
refusing = false;

// ---------------------------------------------------------------------------
console.log('\n--- 3. the first-favorite prompt holds its error too ---');
// An AMBIGUOUS wire (entries in both halves) leaves the mode unchosen
// (`seedModeFromWire` answers null), which is how a device reaches the
// first-favorite question with a list already out there.
await new Promise((r) => setTimeout(r, 1100)); // NIP-01: cross a second boundary
const both = finalizeEvent({
  kind: 10333,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['i', `podcast:guid:${OTHER_ALBUM}`]],
  content: nip44.v2.encrypt(JSON.stringify([['i', `podcast:guid:${ALBUM}`]]), convo),
}, sk);
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify(['EVENT', both])));
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m[0] !== 'OK') return; ws.close(); if (m[2]) resolve(); else reject(new Error(m[3])); });
  ws.on('error', reject);
});
t.equal('the relay now holds the two-half list', latest()?.id, both.id);
// A FRESH device, so this scenario does not lean on what 1 and 2 left behind
// (and runs the same against a build where they failed).
await seedDevice();
await send('Page.navigate', { url: `${APP}/favorites` });
t.ok('the control shows Not set', await until(`(document.querySelector('button[aria-haspopup="menu"][aria-label^="Favorites are"]')?.getAttribute('aria-label') ?? '') === 'Favorites are: Not set'`, 30000), await modeControlSays());
// A heart tap is what asks the question.
const HEART = `[...document.querySelectorAll('button[aria-pressed]')].find((b) => /favorite|♥|♡/i.test((b.getAttribute('aria-label') ?? '') + b.textContent))`;
t.ok('a favorite heart is on the page', await until(`!!(${HEART})`, 30000));
// The question is suppressed while the read is in flight; the ambiguous read
// settles as a notice.
t.ok('the read has settled (a notice is up)', await until(`[...document.querySelectorAll('[role="status"]')].some((x) => x.textContent.trim())`, 30000));
await wait(1000);
refusing = true;
console.log(`     heart: ${await js(`(${HEART}).getAttribute('aria-label') + ' pressed=' + (${HEART}).getAttribute('aria-pressed')`)}`);
await js(`(${HEART}).click()`);
t.ok('the first-favorite question opens', await until(`/Where should your favorites live/.test(${DIALOG}?.textContent ?? '')`, 20000), JSON.stringify(await dialogState()));
t.ok('Save is pressed (Public is the default choice)', await pressAndSettle('Save'));
await wait(1500); // the prompt's close-on-mode effect runs after the hold falls
const held = await dialogState();
t.ok('the prompt is STILL OPEN after the refusal', held !== null, 'it closed itself over the error');
t.ok('...naming what happened', /nothing on Nostr has moved yet/.test(held?.alert ?? ''), held?.alert);
t.ok('...and how to retry', /Press Save to try now/.test(held?.alert ?? ''), held?.alert);
t.equal('...and the answer is kept (there is no earlier choice to restore)', await storedMode(), 'public');
t.equal('the relay still holds the two-half list', latest()?.id, both.id);
t.ok('Cancel closes it', await pressInDialog('Cancel') && await until(`!${DIALOG}`, 5000));
refusing = false;

// ---------------------------------------------------------------------------
console.log('\n--- nothing left the machine ---');
// The app still DIALS its default relays for profiles and the like; Chrome
// resolves none of them (`--host-resolver-rules`), so the claim is about what
// CONNECTED, not what was attempted.
t.equal('every WebSocket that connected is loopback',
  connected.filter((u) => !/^wss?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)), []);
t.ok('...and the fixture relay did connect', connected.some((u) => u.includes(`127.0.0.1:${PORT}`)));
t.equal('no page exceptions', exceptions, []);

console.log(`\n${t.count - t.fails}/${t.count} passed`);
relay.close?.();
await exit(t.fails ? 1 : 0);
