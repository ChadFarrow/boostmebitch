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
  let answerWithError = null; // when set, every RPC is answered with this error

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

    // The signer's ANSWER. `error` is what nostr-tools rejects with, unwrapped
    // as a bare string — which is exactly what makes it distinguishable from a
    // transport failure, and what scenario 5b turns on.
    let reply;
    if (answerWithError && req.method !== 'connect' && req.method !== 'get_public_key') {
      reply = { id: req.id, error: answerWithError };
    } else if (req.method === 'connect') reply = { id: req.id, result: 'ack' };
    else if (req.method === 'get_public_key') reply = { id: req.id, result: pk };
    else if (req.method === 'ping') reply = { id: req.id, result: 'pong' };
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
    relayWs.send(JSON.stringify(['EVENT', out]));
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
