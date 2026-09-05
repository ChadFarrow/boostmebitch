// End-to-end for the NIP-51 mute list's PRIVATE HALF, against nothing but this
// machine.
//
// Usage:
//   npm run dev                  # in another terminal
//   npm run e2e:mutes            # headless
//   npm run e2e:mutes -- --headed --keep
//
// WHAT MAKES THIS WORTH HAVING. `check:mutes` pins `classifyMuteContent` and
// `parseMuteTags`, which are pure. Neither can see the WIRING, and the wiring is
// the whole bug: a cold start that fires `nip04_decrypt` at a payload written in
// NIP-44, a republish that re-encodes another client's list into a cipher that
// client cannot open, a blob that is dropped instead of carried. Every one of
// those looks correct on screen and is invisible to a unit test — which is
// exactly what `e2e-favorites.mjs` says about the feature it covers.
//
// So this drives the real app in a real browser with a REAL signer (a throwaway
// key in this process, reached over a CDP binding, so `window.nostr` is
// indistinguishable from an extension and both ciphers are nostr-tools' actual
// implementations) and a REAL relay (the same ~40 lines of NIP-01 that
// `npm run relay` starts, with replaceable-event semantics).
//
// NOTHING REACHES A PUBLIC RELAY and the key is generated per run.
//
// What it pins, in order of what it costs when wrong:
//   1. A NIP-44 private half is READ. This is the reported bug: it was sent to
//      nip04_decrypt and came back `Invalid base64`.
//   2. A NIP-44 list is REPUBLISHED AS NIP-44. Re-encoding it as NIP-04 makes
//      it unreadable to the client that wrote it, from a publish that looks
//      entirely successful here.
//   3. A NIP-04 private half still works, and still republishes as NIP-04.
//   4. A half we cannot open is carried BYTE FOR BYTE, and says so on screen.
//   5. A REAL NIP-46 bunker is not asked to decrypt on a cold start, and an
//      error it ANSWERS with does not get reported as a dead transport.
//
// Scenario 5 stands up an actual remote signer — 60-odd lines of NIP-46 against
// the same local relay — rather than just writing `bmb:signer = 'bunker'`. That
// shortcut does not work and the reason is worth recording: with no stored
// session, `restoreBunkerSigner()` fails immediately and
// `abandonRestoredSession()` clears `bmb:signer` and `bmb:npub` inside a
// second, so the app is signed OUT before the gate is ever read. Measured: both
// keys null at the 1000 ms mark. A test built on that shortcut asserts nothing
// about bunkers, and would have reported a failure in code that is correct.

import { createRelay } from './local-relay.mjs';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';

const PORT = 7456, CDP = 9224, APP = 'http://localhost:3000';
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
const profile = `${tmpdir()}/bmb-e2e-mutes`;
rmSync(profile, { recursive: true, force: true });
// Chrome refuses to start as root without this, and a container (or CI) is
// exactly where this runs as root. Gated on actually BEING root rather than
// passed always: on a developer's own machine the sandbox should stay on, and
// an unconditional --no-sandbox is the kind of flag that gets copied onward.
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
const convo = nip44.v2.utils.getConversationKey(sk, pk);

// Two accounts to mute: one public tag, one hidden in the encrypted half. The
// private one is the whole point — if the read fails, it silently vanishes.
const PUBLIC_MUTE = '1'.repeat(64);
const PRIVATE_MUTE = '2'.repeat(64);
const FOREIGN_WORD = 'a?iv=b'; // the trap: a keyword mute holding the NIP-04 separator

const published = [];
const { events } = createRelay({
  port: PORT,
  log: null,
  onEvent: (e) => { if (e.kind === 10000) published.push(e); },
});

// Seed the relay directly rather than dialling it — `events` is exposed for
// exactly this. Each scenario replaces the last, which is what a replaceable
// event does and what the app has to cope with.
function seedMuteList(content, createdAt) {
  for (const [id, e] of events) if (e.kind === 10000) events.delete(id);
  const ev = finalizeEvent({
    kind: 10000,
    created_at: createdAt,
    tags: [['p', PUBLIC_MUTE]],
    content,
  }, sk);
  events.set(ev.id, ev);
  return ev;
}

// SEED TIMESTAMPS MUST BE IN THE PAST. `publishMuteList` stamps a republish with
// the real clock, and the relay enforces NIP-01 replacement — so a seed dated in
// the future makes the app's own publish the OLDER event, which the relay
// rejects with `OK false`. Nothing reaches `onEvent`, and the test reads it as
// "it never republished". Cost an entirely misleading failure once.
const T0 = Math.floor(Date.now() / 1000) - 3600;

const privateTags = [['p', PRIVATE_MUTE], ['word', FOREIGN_WORD]];
const privateJson = JSON.stringify(privateTags);

// ---- CDP -----------------------------------------------------------------
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const handlers = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) handlers.forEach((h) => h(m));
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// @noble/hashes does not export ./utils in this version's `exports` map, so
// this stays local rather than dragging in a dependency for eight characters.
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- the account menu ------------------------------------------------------
//
// TWO BANNERS THIS SUITE ASSERTS ON RENDER INSIDE IT — `<BunkerHealthBanner>`
// ("Signer disconnected") and `<BunkerApprovalNotice>` ("Waiting for you to
// approve") — and neither is in the document until the menu is opened. So an
// assertion over `document.body.innerText` is not a weaker version of this one,
// it is a different assertion: it can never see either banner, and it CAN see
// the feed. One of them failed on a Nostr note reading *"You can just build
// things, no permissions asked."*
//
// The trigger is found by role rather than by position: the header has more
// than one popup button, so each is clicked in turn until the menu holding
// "sign out" is the one on screen.
const accountMenuText = () => js(`(() => {
  const m = [...document.querySelectorAll('[role="menu"]')]
    .find((el) => /sign out/i.test(el.innerText || ''));
  return m ? m.innerText : null;
})()`);

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

/** Is the "Signer disconnected — …" reconnect banner showing? */
async function bannerInAccountMenu() {
  if (!await openAccountMenu()) return null; // reported as a failure, not a pass
  return /signer disconnected/i.test(await accountMenuText() ?? '');
}

await send('Page.enable'); await send('Runtime.enable');
const pageLog = [];
handlers.push((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageLog.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
    return;
  }
  if (m.method !== 'Runtime.consoleAPICalled') return;
  const text = (m.params.args || []).map((a) => {
    if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
    return a.description ?? a.preview?.description ?? '';
  }).join(' ');
  pageLog.push(`${m.params.type}: ${text.slice(0, 300)}`);
});

// Counts what the page actually ASKS the signer for. This is how "the app fired
// nip04_decrypt at a NIP-44 payload" becomes an assertion instead of a guess.
const calls = [];
await send('Runtime.addBinding', { name: 'bmbSigner' });
handlers.push(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  calls.push(fn);
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
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
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

let fails = 0;
const check = (l, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${l}`);
  if (!ok) { fails++; console.log('        expected', JSON.stringify(b), '\n        actual  ', JSON.stringify(a)); }
};

// Everything the app needs to consider itself signed in with a NIP-07
// extension, minus any favorites, so nothing else publishes during the run.
const bootstrap = (signerKind) => `(() => { localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', ${JSON.stringify(signerKind)});
  return 1; })()`;

// The store is not reachable from here — it is module state inside the bundle,
// not on `window` — so every assertion is made against what the app actually
// EMITS: the DOM for the notice, the relay for the events, and the signer
// binding for which cipher was asked for. That is a better boundary anyway:
// each of those is something a user or another client can observe.
const noticeText = () => js(`(() => {
  const el = [...document.querySelectorAll('[role="status"]')]
    .find(e => /mute/i.test(e.textContent));
  return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
})()`);

console.log(`\n  throwaway npub ${npub.slice(0, 20)}…  relay ws://127.0.0.1:${PORT}\n`);

// ---------------------------------------------------------------------------
console.log('--- 1. A NIP-44 private half is READ (the reported bug) ---');
// ---------------------------------------------------------------------------
{
  const nip44Content = nip44.v2.encrypt(privateJson, convo);
  const seeded = seedMuteList(nip44Content, T0);
  check('the seeded content is NIP-44 shaped (no "?iv=")', seeded.content.includes('?iv='), false);

  await send('Page.navigate', { url: APP }); await wait(2000);
  await js(bootstrap('nip07'));
  // Cleared HERE, not before the navigate above: that first load still runs
  // under the previous scenario's localStorage and would charge its decrypts
  // to this one.
  calls.length = 0;
  await send('Page.navigate', { url: APP }); await wait(16000);

  // THE ASSERTION THE BUG WOULD FAIL. Before this change the app called
  // nip04.decrypt on these bytes and the signer answered "Invalid base64".
  check('the app asked for nip44.decrypt', calls.includes('nip44.decrypt'), true);
  check('...and NEVER asked nip04.decrypt for a NIP-44 payload',
    calls.includes('nip04.decrypt'), false);

  const notice = await noticeText();
  check('no "couldn\'t open" notice is up', notice, null);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. ...and is republished AS NIP-44, never downgraded to NIP-04 ---');
// ---------------------------------------------------------------------------
{
  // Driven through the LOCAL-AHEAD branch rather than by clicking a mute
  // button, because a fresh home page has no notes on it and therefore no mute
  // control — an earlier version of this scenario silently asserted nothing at
  // all for exactly that reason. Seeding `bmb:muted:<npub>` with a cache newer
  // than the relay event is the deterministic way in, and it exercises one more
  // thing on the way: the cache round-trips through `coerceToMuteState`, so a
  // `privateCipher` that field-whitelist drops would show up here as a
  // downgrade rather than as a missing field.
  const relayAt = T0 + 100;
  seedMuteList(nip44.v2.encrypt(privateJson, convo), relayAt);

  const cache = JSON.stringify({
    publicPubkeys: [PUBLIC_MUTE],
    publicOtherTags: [],
    privatePubkeys: [PRIVATE_MUTE],
    privateOtherTags: [['word', FOREIGN_WORD]],
    privateCipher: 'nip44',
    updatedAt: relayAt + 50, // local is ahead → republish
  });

  const before = published.length;
  await send('Page.navigate', { url: APP }); await wait(2000);
  await js(`${bootstrap('nip07')}; localStorage.setItem('bmb:muted:' + ${JSON.stringify(npub)}, ${JSON.stringify(cache)});`);
  await send('Page.navigate', { url: APP }); await wait(20000);

  check('it republished', published.length > before, true);
  const last = published[published.length - 1];
  if (last) {
    check('`content` is NOT NIP-04 — no "?iv=" appeared', last.content.includes('?iv='), false);
    let round = null;
    try { round = JSON.parse(nip44.v2.decrypt(last.content, convo)); } catch { /* stays null */ }
    check('the republished half is readable as NIP-44', Array.isArray(round), true);
    check('the private mute survived the round trip',
      !!round?.some((t) => t[0] === 'p' && t[1] === PRIVATE_MUTE), true);
    check('...and so did the "?iv="-bearing keyword mute',
      !!round?.some((t) => t[0] === 'word' && t[1] === FOREIGN_WORD), true);
    check('the public tag is still public',
      last.tags.some((t) => t[0] === 'p' && t[1] === PUBLIC_MUTE), true);
    check('the private mute did NOT leak into the public tags',
      last.tags.some((t) => t[1] === PRIVATE_MUTE), false);
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- 2b. a NIP-04 list is republished AS NIP-04, never upgraded ---');
// ---------------------------------------------------------------------------
{
  // The mirror image. Silently "upgrading" to NIP-44 is the same interop break
  // pointed the other way: unreadable to the client that wrote it.
  const relayAt = T0 + 300;
  seedMuteList(await nip04.encrypt(sk, pk, privateJson), relayAt);

  const cache = JSON.stringify({
    publicPubkeys: [PUBLIC_MUTE],
    publicOtherTags: [],
    privatePubkeys: [PRIVATE_MUTE],
    privateOtherTags: [],
    privateCipher: 'nip04',
    updatedAt: relayAt + 50,
  });

  const before = published.length;
  await send('Page.navigate', { url: APP }); await wait(2000);
  await js(`${bootstrap('nip07')}; localStorage.setItem('bmb:muted:' + ${JSON.stringify(npub)}, ${JSON.stringify(cache)});`);
  await send('Page.navigate', { url: APP }); await wait(20000);

  check('it republished', published.length > before, true);
  const last = published[published.length - 1];
  if (last) {
    check('`content` is still NIP-04', last.content.includes('?iv='), true);
    let round = null;
    try { round = JSON.parse(await nip04.decrypt(sk, pk, last.content)); } catch { /* stays null */ }
    check('the republished half is readable as NIP-04', Array.isArray(round), true);
    check('the private mute survived', !!round?.some((t) => t[1] === PRIVATE_MUTE), true);
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. A NIP-04 private half still works ---');
// ---------------------------------------------------------------------------
{
  const nip04Content = await nip04.encrypt(sk, pk, privateJson);
  const seeded = seedMuteList(nip04Content, T0 + 500);
  check('the seeded content is NIP-04 shaped', seeded.content.includes('?iv='), true);

  await send('Page.navigate', { url: APP }); await wait(2000);
  await js(bootstrap('nip07'));
  // Cleared HERE, not before the navigate above: that first load still runs
  // under the previous scenario's localStorage and would charge its decrypts
  // to this one.
  calls.length = 0;
  await send('Page.navigate', { url: APP }); await wait(16000);

  check('the app asked for nip04.decrypt', calls.includes('nip04.decrypt'), true);
  check('...and did NOT ask nip44.decrypt for a NIP-04 payload',
    calls.includes('nip44.decrypt'), false);
  check('no "couldn\'t open" notice is up', await noticeText(), null);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. A half we cannot open is carried BYTE FOR BYTE, and says so ---');
// ---------------------------------------------------------------------------
{
  // Neither cipher, and not a tag array: the "unknown" branch. It must reach no
  // signer at all and survive any republish unchanged.
  const opaque = 'this is not a ciphertext this app can classify';
  const relayAt = T0 + 600;
  seedMuteList(opaque, relayAt);

  // A local-ahead cache, so this scenario actually REPUBLISHES and the
  // carry-verbatim claim below is tested rather than assumed. Without it there
  // is no new event and the assertion silently reads the previous scenario's —
  // which is what it did, and it reported a NIP-04 payload as a corrupted blob.
  const cache = JSON.stringify({
    publicPubkeys: [PUBLIC_MUTE],
    publicOtherTags: [],
    privatePubkeys: [],
    privateOtherTags: [],
    updatedAt: relayAt + 50,
  });

  const before = published.length;
  await send('Page.navigate', { url: APP }); await wait(2000);
  await js(`${bootstrap('nip07')}; localStorage.setItem('bmb:muted:' + ${JSON.stringify(npub)}, ${JSON.stringify(cache)});`);
  // Cleared HERE, not before the navigate above: that first load still runs
  // under the previous scenario's localStorage and would charge its decrypts
  // to this one.
  calls.length = 0;
  await send('Page.navigate', { url: APP }); await wait(20000);

  check('no decrypt was attempted on an unrecognized shape',
    calls.some((c) => c.endsWith('.decrypt')), false);

  const notice = await noticeText();
  check('the withholding is ON SCREEN, not just in the console', notice !== null, true);
  if (notice) console.log(`        notice: ${notice}`);

  check('it republished', published.length > before, true);
  const after = published[published.length - 1];
  // THE POINT OF THE WHOLE PARK BRANCH: a half we could not read goes back up
  // exactly as it came down. Anything else destroys private mutes set in
  // another client, on someone else's device, with no undo.
  check('the opaque blob was carried byte for byte', after?.content, opaque);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. A REAL NIP-46 bunker: no cold-start decrypt, and an error is not a disconnect ---');
// ---------------------------------------------------------------------------
{
  // A minimal remote signer speaking NIP-46 over the same local relay. It has
  // to be real: see the header for why writing `bmb:signer = 'bunker'` alone
  // signs the app out before the gate is read.
  //
  // The transport is kind:24133 with NIP-44-encrypted content — nostr-tools
  // 2.19.4's nip46.js uses the same chacha/HKDF construction `nip44.v2` exposes,
  // so the conversation key between the bunker key and the client key is all
  // that is needed to speak it.
  const bunkerSk = generateSecretKey();
  const bunkerPk = getPublicKey(bunkerSk);
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const rpcKey = nip44.v2.utils.getConversationKey(bunkerSk, clientPk);

  const seen = [];
  const seenIds = [];
  let answerWithError = null; // when set, every RPC is answered with this error
  // Scenario 5d/5e: answer the first N requests of one method with an error and
  // then behave normally. This is Clave's shape — it does not hold a request
  // open while its user decides, it refuses immediately and delivers the real
  // result only once the tap happens. `denyFirst.left` counts DOWN.
  let denyFirst = null; // { method, left, error }
  // OFF until scenario 5d turns it on, and that is deliberate rather than
  // cautious. Scenarios 1-5c were written against a stub that answered
  // `sign_event` with "unsupported", so silently teaching it to sign would
  // change what lands on the relay underneath assertions that were not written
  // for it — the fixture-editing antipattern CLAUDE.md names. New behaviour goes
  // behind a flag the new scenario turns on.
  let signEnabled = false;
  // Scenario 5h: hold the answer on the wire for this long. The bug it
  // reproduces needs a cancel to land while a request is UNANSWERED, and a
  // local relay round trip is a few milliseconds — far too short to aim at.
  // Zero everywhere else, so no other scenario changes timing.
  let replyDelayMs = 0;

  const relayWs = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((r) => relayWs.addEventListener('open', r));
  relayWs.send(JSON.stringify(['REQ', 'bunker', { kinds: [24133], '#p': [bunkerPk] }]));
  relayWs.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg[0] !== 'EVENT' || msg[1] !== 'bunker') return;
    const ev = msg[2];
    let req;
    try { req = JSON.parse(nip44.v2.decrypt(ev.content, rpcKey)); } catch { return; }
    seen.push(req.method);
    seenIds.push(req.id);

    // The signer's ANSWER. `error` is what nostr-tools rejects with, unwrapped
    // as a bare string — which is exactly what makes it distinguishable from a
    // transport failure, and what scenario 5b turns on.
    let reply;
    if (denyFirst && denyFirst.method === req.method && denyFirst.left > 0) {
      denyFirst.left -= 1;
      reply = { id: req.id, error: denyFirst.error };
    } else if (answerWithError && req.method !== 'connect' && req.method !== 'get_public_key') {
      reply = { id: req.id, error: answerWithError };
    } else if (req.method === 'connect') reply = { id: req.id, result: 'ack' };
    else if (req.method === 'get_public_key') reply = { id: req.id, result: pk };
    else if (req.method === 'ping') reply = { id: req.id, result: 'pong' };
    else if (req.method === 'sign_event' && signEnabled) {
      // A bunker holds the user's key, so it can sign. NIP-46 passes the
      // template as a JSON string in params[0]; the answer is the finalized
      // event, also JSON-stringified.
      try { reply = { id: req.id, result: JSON.stringify(finalizeEvent(JSON.parse(req.params[0]), sk)) }; }
      catch (e) { reply = { id: req.id, error: String((e && e.message) || e) }; }
    }
    else if (req.method === 'nip44_decrypt') {
      // A bunker holds the user's key, so it can open a payload encrypted to
      // self. NIP-46 params are [third_party_pubkey, ciphertext]. Answering for
      // real is what lets scenario 5c test the SUCCESS path — 5b only ever
      // proved that an error answer is not a dead transport.
      try { reply = { id: req.id, result: nip44.v2.decrypt(req.params[1], convo) }; }
      catch (e) { reply = { id: req.id, error: String((e && e.message) || e) }; }
    }
    else reply = { id: req.id, error: `unsupported: ${req.method}` };

    const out = finalizeEvent({
      kind: 24133,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', clientPk]],
      content: nip44.v2.encrypt(JSON.stringify(reply), rpcKey),
    }, bunkerSk);
    const emit = () => relayWs.send(JSON.stringify(['EVENT', out]));
    if (replyDelayMs > 0) setTimeout(emit, replyDelayMs); else emit();
  });

  const nip44Content = nip44.v2.encrypt(privateJson, convo);
  seedMuteList(nip44Content, T0 + 700);

  await send('Page.navigate', { url: APP }); await wait(2000);
  await js(`(() => { localStorage.clear();
    localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
    localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
    localStorage.setItem('bmb:signer', 'bunker');
    localStorage.setItem('bmb:bunker', ${JSON.stringify(JSON.stringify({ uri: `bunker://${bunkerPk}?relay=ws://127.0.0.1:${PORT}`, clientSk: hex(clientSk) }))});
    return 1; })()`);
  // See the note in scenario 1: clear after the bootstrap load, not before it.
  calls.length = 0;
  seen.length = 0;
  await send('Page.navigate', { url: APP }); await wait(20000);

  check('the bunker session survived the restore (not signed out)',
    await js(`localStorage.getItem('bmb:signer')`), 'bunker');
  check('the bunker really connected', seen.includes('connect'), true);

  // THE POLICY. `window.nostr` is now the bunker adapter, which declares both
  // ciphers, so a decrypt WOULD have gone out. It must not, because the signer
  // lives outside the browser.
  check('no unattended decrypt was sent to the bunker',
    seen.some((m) => m.endsWith('_decrypt')), false);
  check('...and none reached the extension stub either',
    calls.some((c) => c.endsWith('.decrypt')), false);

  const notice = await noticeText();
  check('the user is told the private half was withheld', notice !== null, true);
  if (notice) console.log(`        notice: ${notice}`);
  check('...and it is the "withheld" wording, not the "couldn\'t open" one',
    /wasn/i.test(notice ?? ''), true);

  console.log('\n  5b. an error the signer ANSWERS with is not a dead transport');
  // The unlock button spends the prompt on purpose. Answer it with an error and
  // the app must NOT conclude the link is down: `trackBunkerCall` distinguishes
  // a remote error (a bare string, so not an Error) from a timeout.
  answerWithError = 'nip04_decrypt failed: Invalid base64';
  await js(`(() => { const b=[...document.querySelectorAll('[role="status"] button')].find(x=>/load|retry/i.test(x.textContent)); if(b) b.click(); return !!b; })()`);
  await wait(12000);

  check('the unlock did reach the bunker as a decrypt',
    seen.some((m) => m.endsWith('_decrypt')), true);
  check('...routed to nip44_decrypt, since the payload is NIP-44',
    seen.includes('nip44_decrypt'), true);

  const disconnected = await js(`/signer disconnected/i.test(document.body.innerText)`);
  check('the app does NOT claim the signer is disconnected', disconnected, false);

  console.log('\n  5c. opening the half once STICKS — it is not re-asked on the next load');
  // THE REPORTED BUG, and the reason this scenario exists at all. Everything
  // above was already true: the gate held, the notice appeared, the button sent
  // the right decrypt. And it still could not be fixed by pressing the button,
  // because nothing remembered the answer — the next load parked the identical
  // bytes and said the half stayed shut again.
  //
  // No pure check can see this. It is three separate modules agreeing across a
  // page load: the read records which ciphertext it opened, storage carries that
  // field, and the hydrator compares it to what the wire is holding now.
  answerWithError = null;
  seen.length = 0;
  const mutedKey = `localStorage.getItem('bmb:muted:' + ${JSON.stringify(npub)})`;
  const readMuted = async () => { const raw = await js(mutedKey); return raw ? JSON.parse(raw) : null; };

  await js(`(() => { const b=[...document.querySelectorAll('[role="status"] button')].find(x=>/load|retry/i.test(x.textContent)); if(b) b.click(); return !!b; })()`);
  await wait(12000);

  check('the half opened, so the notice is gone', await noticeText(), null);
  const opened = await readMuted();
  check('the private mute is applied', opened?.privatePubkeys?.includes(PRIVATE_MUTE), true);
  check('the park is gone', opened?.unreadablePrivateContent ?? null, null);
  check('...and the ciphertext it was opened from is remembered',
    opened?.knownPrivateContent, nip44Content);

  seen.length = 0;
  await send('Page.navigate', { url: APP }); await wait(20000);

  check('after a reload the notice does NOT come back', await noticeText(), null);
  // The gate is unchanged — this must still cost no prompt. If the fix worked by
  // simply asking again, this is the check that says so.
  check('...and the bunker was not asked to decrypt again',
    seen.some((m) => m.endsWith('_decrypt')), false);
  const reloaded = await readMuted();
  check('...and the private mute survived the reload',
    reloaded?.privatePubkeys?.includes(PRIVATE_MUTE), true);

  console.log('\n  5d. a QUEUED approval is asked again, on a NEW request id');
  // THE CLAVE SHAPE, and the only automated proof of it there can be.
  // lib/nostr/bunker.ts imports nostr-tools and touches browser globals, so it
  // will never load under `node --experimental-strip-types` and can never have
  // a check:* script — the predicate it branches on (lib/nostr/nip46-errors.ts)
  // is pinned by check:nip46error, but the RE-ISSUE is only observable here.
  //
  // Driven straight at `window.nostr` rather than through a UI toggle. The unit
  // under test is adaptToWindowNostr -> withApprovalWait, and going through the
  // mute publisher would add a debounce, a relay read and a merge between the
  // assertion and the thing it is asserting about.
  //
  // Clave answers `permission denied` and then, once the user approves, sends
  // the real result on the SAME id — which nostr-tools 2.19.4 has already
  // deleted the listener for (`delete listeners[id]` right after
  // `handler.reject`). So the only way through is a fresh request, and that is
  // what the id assertion below is really checking.
  answerWithError = null;
  seen.length = 0;
  seenIds.length = 0;
  signEnabled = true;
  denyFirst = { method: 'sign_event', left: 1, error: 'permission denied' };

  const signStart = Date.now();
  const signed = await js(`(async () => {
    try {
      const ev = await window.nostr.signEvent({ kind: 1, created_at: 1700000000, tags: [], content: 'clave retry probe' });
      return JSON.stringify({ ok: true, id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at });
    } catch (e) { return JSON.stringify({ ok: false, err: String(e) }); }
  })()`);
  const signRes = JSON.parse(signed);
  const signMs = Date.now() - signStart;

  check('the denied signature still came back', signRes.ok, true);
  check('...signed by the account\'s own key', signRes.pubkey, pk);
  // The whole point: re-issuing must not disturb the template. A signer that
  // re-stamped created_at would produce a different event than the one the
  // caller built, which is the assumption every publisher in lib/nostr rests on.
  check('...over the template we handed in, unaltered', signRes.created_at, 1700000000);
  const signRequests = seen.filter((m) => m === 'sign_event');
  check('the request was issued twice', signRequests.length, 2);
  const signIds = seenIds.filter((_, i) => seen[i] === 'sign_event');
  check('...on two DIFFERENT request ids', signIds[0] !== signIds[1], true);
  // THE FIRST GAP IN BUNKER_APPROVAL_GAPS_MS IS 2.5 s, and this floor moved
  // down with it from 7000. What the assertion is for has not changed: the loop
  // must SLEEP between asks. A re-issue is a fresh approval prompt on a signer
  // that did not queue the request, so a loop that does not sleep hammers the
  // very screen the user is being asked to look at. The schedule still widens
  // to 8 s from the third ask; only the first two are dense, and only because
  // the user is demonstrably standing at the signer for those.
  check('...with the retry interval actually waited out', signMs >= 2000, true);
  const stillOk = await js(`/signer disconnected/i.test(document.body.innerText)`);
  check('a queued approval is not reported as a disconnect', stillOk, false);

  console.log('\n  5e. a terminal refusal is NOT retried — it fails fast');
  // The over-match direction, which is the expensive one: a signer that means
  // "no" must not be asked eleven more times over ninety seconds. Only the five
  // approval-pending phrasings may loop; everything else propagates at once.
  seen.length = 0;
  seenIds.length = 0;
  denyFirst = { method: 'sign_event', left: 1, error: 'user rejected the request' };

  const refusedStart = Date.now();
  const refused = await js(`(async () => {
    try { await window.nostr.signEvent({ kind: 1, created_at: 1700000001, tags: [], content: 'x' }); return 'resolved'; }
    catch (e) { return 'rejected:' + String(e); }
  })()`);
  const refusedMs = Date.now() - refusedStart;

  check('a refusal reaches the caller', String(refused).startsWith('rejected:'), true);
  check('...carrying the signer\'s own words', /user rejected the request/.test(String(refused)), true);
  check('...after exactly one request', seen.filter((m) => m === 'sign_event').length, 1);
  // Under the FIRST gap (2.5 s), not merely under the old 8 s one: the point is
  // that a terminal refusal never entered the loop at all.
  check('...and without waiting out the approval interval', refusedMs < 2000, true);

  console.log('\n  5g. the wait ends when the tab comes BACK, not when the timer says so');
  // THE iOS HALF OF THE RE-ISSUE, and the only place it can be exercised
  // without a phone. Approving happens in another app, so the switch back is
  // part of the act — and Safari suspends timers in a backgrounded tab, so a
  // plain setTimeout resumes on return with an arbitrary remainder still to
  // run. `waitBeforeReissue` therefore ends on the first of the timer, a
  // visibilitychange to visible, or a cancel.
  //
  // The page here is always visible, so a SYNTHETIC visibilitychange is what
  // stands in for the return — the listener's own test is
  // `visibilityState === 'visible'`, which is exactly the state a real return
  // arrives in. Scenario 5d above still covers the timer path, so the two
  // together pin both arms.
  seen.length = 0;
  seenIds.length = 0;
  denyFirst = { method: 'sign_event', left: 1, error: 'permission denied' };
  // Assert the premise rather than let it silently turn this into a slow copy
  // of 5d: if the harness ever runs the page hidden, the synthetic event is
  // ignored and the timer answers instead.
  check('the harness page is visible, so the wake is reachable',
    await js(`document.visibilityState`), 'visible');
  const wokeRaw = await js(`(async () => {
    const started = Date.now();
    const p = window.nostr.signEvent({ kind: 1, created_at: 1700000002, tags: [], content: 'clave wake probe' });
    // Lands inside the sleep: the denial is a local relay round trip, so the
    // wait is running long before this fires.
    setTimeout(() => document.dispatchEvent(new Event('visibilitychange')), 400);
    try { const ev = await p; return JSON.stringify({ ok: true, ms: Date.now() - started, created_at: ev.created_at }); }
    catch (e) { return JSON.stringify({ ok: false, err: String(e) }); }
  })()`);
  const woke = JSON.parse(wokeRaw);
  check('the denied signature still came back', woke.ok, true);
  check('...over the template we handed in, unaltered', woke.created_at, 1700000002);
  check('...on two requests, so it really was a re-issue',
    seen.filter((m) => m === 'sign_event').length, 2);
  const wokeIds = seenIds.filter((_, i) => seen[i] === 'sign_event');
  check('...on two DIFFERENT request ids', wokeIds[0] !== wokeIds[1], true);
  // The whole assertion: the first gap is 2.5 s and the return beat it.
  check('...woken by the return rather than the 2.5 s gap', woke.ms < 2000, true);

  console.log('\n  5h. STOP WAITING clears the notice, and it STAYS clear');
  // THE REGRESSION TEST FOR A NOTICE THAT STUCK. Reported as: press Stop
  // waiting, the box goes, then it comes back and never leaves.
  //
  // The order is the whole bug, which is why this scenario is fiddly. A cancel
  // can only land while an attempt is UNANSWERED, and the generation check used
  // to sit after the sleep instead of before the re-arm — so the held answer
  // arrived, the catch put the notice back up, the loop slept, woke on a moved
  // generation and left through a `finally` whose generation guard refused to
  // clear what it had just set. Nothing waiting, notice on screen.
  //
  // Two denials and a held reply are what make that window aimable: the first
  // denial arms the notice, the second is stalled by `replyDelayMs` so the
  // press lands in the middle of it.
  seen.length = 0;
  seenIds.length = 0;
  denyFirst = { method: 'sign_event', left: 2, error: 'permission denied' };
  await js(`(() => {
    window.__bmbStuck = window.nostr.signEvent({ kind: 1, created_at: 1700000003, tags: [], content: 'stop waiting probe' });
    // It is MEANT to reject — the user cancels it. Nothing must be left holding
    // that rejection or the page logs an unhandled one over the assertions.
    window.__bmbStuck.catch(() => {});
    return true;
  })()`);
  await wait(900);
  // The account menu is where <BunkerApprovalNotice> renders outside the boost
  // modal, and every read below is scoped to that menu — see accountMenuText.
  const noticeShowing = async () =>
    /waiting for you to approve/i.test(await accountMenuText() ?? '');
  check('the account menu opened', await openAccountMenu(), true);
  check('the waiting notice reaches it', await noticeShowing(), true);
  // Stall the NEXT answer so the press below lands while it is on the wire.
  // Set now, before the 2.5 s gap elapses and the second ask goes out.
  replyDelayMs = 1500;
  await wait(2200);
  check('the signer was asked a second time', seen.filter((m) => m === 'sign_event').length, 2);
  const stopped = await js(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /stop waiting/i.test(x.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('Stop waiting was pressed while the request was unanswered', stopped, true);
  await wait(300);
  check('the notice goes at once', await noticeShowing(), false);
  // The held denial lands inside this window. Before the fix it re-armed the
  // notice here and nothing ever took it down again.
  await wait(4000);
  check('...and is STILL gone once the held answer arrives', await noticeShowing(), false);
  // The signer answered, so the transport is demonstrably alive — cancelling a
  // wait must not be dressed up as a disconnect. Readable here because the menu
  // holding both banners is open.
  check('a cancelled wait is not reported as a disconnect either',
    /signer disconnected/i.test(await accountMenuText() ?? ''), false);
  replyDelayMs = 0;
  denyFirst = null;
  // Put the menu back the way 5f expects to find it.
  await js(`(() => { document.body.click(); return true; })()`);
  await wait(200);

  // Deliberately NOT asserted: the give-up path at the end of the budget. A stub
  // that never relents costs 90 s of wall clock here, and adding a test-only
  // backdoor to the budget in a module on the money path is worse than leaving
  // that bound to review.
  console.log('\n  5f. a PAIRING denied once still signs in — the handshake retries too');
  // THE SECOND HALF OF 5d, AND IT SHIPPED MISSING. withApprovalWait was applied
  // to the adapter's methods only, on the reasoning that the connect paths own
  // their own timeouts and a retry underneath one would stall sign-in. A field
  // report disproved it: Clave answers the handshake's `get_public_key` the same
  // way it answers a signature, so a paired signer showed "no permission" on
  // screen while its own Recent Activity listed that call succeeding.
  //
  // `no permission` is the exact string the phone produced, and none of the five
  // phrasings copied from clave-casa matched it — so this vector is doing two
  // jobs: the handshake retries at all, and it retries on THAT word.
  seen.length = 0;
  seenIds.length = 0;
  denyFirst = { method: 'get_public_key', left: 1, error: 'no permission' };

  const pairStart = Date.now();
  await send('Page.navigate', { url: APP }); await wait(25000);
  const pairMs = Date.now() - pairStart;

  check('the session came up despite the refusal', await js(`localStorage.getItem('bmb:signer')`), 'bunker');
  // SCOPED TO THE ACCOUNT MENU, and the whole-body version this replaces was
  // wrong twice over. `<BunkerHealthBanner>` renders INSIDE the menu, which is
  // closed — so scanning `document.body.innerText` could never have seen the
  // thing it names, and passed vacuously. What it COULD see is the feed: the
  // assertion failed on a Nostr note reading *"You can just build things, no
  // permissions asked."* An assertion over the whole page is an assertion over
  // whatever strangers published that day.
  check('...and the account menu is not offering a reconnect',
    await bannerInAccountMenu(), false);
  const pkRequests = seen.filter((m) => m === 'get_public_key');
  check('get_public_key was issued more than once', pkRequests.length >= 2, true);
  const pkIds = seenIds.filter((_, i) => seen[i] === 'get_public_key');
  check('...on DIFFERENT request ids', pkIds[0] !== pkIds[1], true);
  check('...with the retry interval waited out', pairMs >= 7000, true);

  console.log('\n  5i. SIGNING OUT tells the signer to forget this client');
  // THE PAIRING LIVES ON THE SIGNER'S SIDE TOO, and closing our socket does not
  // touch it — the app goes on listing this site as connected. Clave caps a user
  // at five connections, so every sign-in/sign-out cycle that does not revoke
  // burns one of five slots that only the user can reclaim, by hand, in another
  // app.
  //
  // `logout` is the NIP-46 method for it (nips#2373, Amber #460) and Clave
  // implements it. What this pins is the half that is ours: that the request is
  // actually PUT ON THE WIRE before the transport is torn down. Getting the
  // order wrong — closing first, as every other teardown path correctly does —
  // is silent, because sign-out succeeds either way and the leftover connection
  // is only visible inside the signer app.
  //
  // The stub answers `unsupported: logout`, which is deliberate: a signer that
  // does not implement it must not keep anyone signed in, so the assertion is
  // about the request going out, never about the answer.
  denyFirst = null;
  signEnabled = false;
  seen.length = 0;
  check('the session is still live before we sign out',
    await js(`localStorage.getItem('bmb:signer')`), 'bunker');
  check('the account menu opened', await openAccountMenu(), true);
  const signedOut = await js(`(() => {
    const m = [...document.querySelectorAll('[role="menu"]')].find((el) => /sign out/i.test(el.innerText || ''));
    if (!m) return false;
    const b = [...m.querySelectorAll('button')].find((x) => /^sign out$/i.test((x.textContent || '').trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('sign out was pressed', signedOut, true);
  await wait(1500);
  check('the session is gone locally', await js(`localStorage.getItem('bmb:signer')`), null);
  check('...and a logout reached the signer', seen.includes('logout'), true);

  relayWs.close();
}

console.log('\n--- publish timeline ---');
published.forEach((e, i) => {
  let inside = '';
  if (e.content) {
    if (e.content.includes('?iv=')) inside = ' cipher=nip04';
    else { try { nip44.v2.decrypt(e.content, convo); inside = ' cipher=nip44'; } catch { inside = ' cipher=UNREADABLE'; } }
  }
  console.log(`  ${i}  created_at=${e.created_at}  pTags=${e.tags.filter((t) => t[0] === 'p').length}  content=${e.content ? e.content.length + 'B' : 'empty'}${inside}`);
});
console.log('\n--- page log ---');
pageLog.filter((l) => /mute|nostr|relay|error|warn/i.test(l)).slice(-30).forEach((l) => console.log('  ' + l));

ws.close();
stopChrome();
if (KEEP) console.log(`\nbrowser left open on ${APP} (--keep)`);
console.log(fails ? `\n${fails} FAILED` : '\nall end-to-end checks passed — nothing left this machine');
process.exit(fails ? 1 : 0);
