// End-to-end for the favorites privacy choice, against NOTHING but this machine.
//
// Usage:
//   npm run dev                     # in another terminal
//   npm run e2e:favorites           # headless
//   npm run e2e:favorites -- --headed --keep   # watch it, and leave the browser open
//
// WHAT MAKES THIS WORTH HAVING. Everything else guarding this feature is either
// a pure function (`check:favsync`) or a DOM assertion. Neither can see the
// wiring BETWEEN them, and the wiring is where this feature kept breaking: a
// background cycle that never decrypted, a planner that answered "nothing
// changed" about a half it could not read, a hydrator that recorded a baseline
// for a publish it had refused. Each of those was invisible to a unit test and
// looked correct on screen.
//
// So this drives the real app in a real browser with:
//   - a REAL signer. A throwaway key lives in this process and is reached from
//     the page over a CDP binding, so `window.nostr` is indistinguishable from
//     an extension and the NIP-44 is nostr-tools' actual implementation.
//   - a REAL relay. ~40 lines of NIP-01 on 127.0.0.1, in-memory, with
//     replaceable-event semantics — which is the behaviour under test, since
//     the whole feature turns on one event replacing another.
//
// NOTHING REACHES A PUBLIC RELAY, and the key is generated per run, so no
// account of yours is involved at any point.
//
// The four things it pins, in order of how much they cost when wrong:
//   1. A public list publishes plaintext tags and an EMPTY `content`.
//   2. Switching to private MOVES the entries: out of the tags, into an
//      encrypted `content`, with an item guid carrying a `?` surviving intact
//      (Amber splits the signer URI on that character, and item guids are
//      routinely permalink URLs).
//   3. IDEMPOTENCE. Two reloads must not republish. NIP-44 draws a fresh nonce
//      per encryption, so a ciphertext comparison here would republish forever
//      — the first thing the spec says a private half breaks.
//   4. The library still renders, decrypted, with no "nothing saved yet".

import { createRelay } from './local-relay.mjs';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';

const PORT = 7455, CDP = 9223, APP = 'http://localhost:3000';
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

const appUp = await fetch(APP).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);
  console.error('(and `rm -rf .next` first if you have just run a production build)');
  process.exit(1);
}

// macOS default, because that is where this is usually run. `CHROME_PATH`
// overrides it, which is what lets this script run on Linux and in CI at all —
// hardcoded, it exits before the first assertion on any other platform.
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = `${tmpdir()}/bmb-e2e-favorites`;
rmSync(profile, { recursive: true, force: true });
// Chrome refuses to start as root without this, and a container (or CI) is
// exactly where this runs as root — without it the script dies at "Chrome never
// opened its debug port", which reads as a port clash rather than a refusal.
// Gated on actually BEING root: on a developer's own machine the sandbox stays
// on, and an unconditional --no-sandbox is the kind of flag that gets copied.
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

// Wait for the debug port rather than sleeping a guessed amount.
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

// ---- relay ---------------------------------------------------------------
// The SAME relay `npm run relay` starts, not a second copy of it. This test
// asserts on replacement — one publish superseding another is the whole
// mechanism the favorites feature rests on — so a reimplemented relay here
// would let the test and the tool a human runs by hand drift apart, and the
// test would keep passing while proving something else.
//
// It already had: the inline copy deleted whatever occupied a slot without
// comparing `created_at`, so an OLDER event replaced a newer one — the exact
// opposite of NIP-01, in the file whose job is to prove replacement works.
const published = [];
createRelay({
  port: PORT,
  log: null, // this script's own output is the report
  onEvent: (e) => { if (e.kind === 10333) published.push(e); },
});


// ---- a relay that REFUSES, so the publish is genuinely partial -------------
//
// A single always-accepting relay is not the shape this feature meets. Real
// publish sets are PARTIAL: measured on a live account on 2026-09-03, three of
// seven relays held the current kind:10333, one held a copy twenty hours older,
// two answered and held nothing, and one never answered. `assertPublished`
// enforces a floor of ONE relay, so with a single fixture relay every scenario
// below runs against the only case where the floor and the ceiling coincide.
//
// This one accepts the connection and answers every EVENT with `OK false`,
// which is how an operator's write policy actually reads on the wire. Two
// things then get proved that one relay cannot: the whole cycle still succeeds
// when a relay refuses, and `<FavoritesSyncNotice>` says so (scenario 2b).
import { WebSocketServer } from 'ws';
const BAD_PORT = PORT + 1;
new WebSocketServer({ host: '127.0.0.1', port: BAD_PORT }).on('connection', (sock) => {
  sock.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m[0] === 'EVENT') sock.send(JSON.stringify(['OK', m[1].id, false, 'blocked: test policy']));
    if (m[0] === 'REQ') sock.send(JSON.stringify(['EOSE', m[1]]));
  });
});

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
await send('Runtime.addBinding', { name: 'bmbSigner' });
handlers.push(async (m) => {
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
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
});

// A window.nostr indistinguishable from an extension, from the app's side.
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
async function chooseMode(label) {
  // Dismiss whatever is open first. The first-favorite prompt and a switch
  // confirmation can both be up, and clicking "the first Switch button in a
  // [role=dialog]" then means whichever the DOM happens to hold first.
  await js(`(() => { document.querySelectorAll('[role="dialog"]').forEach(d => { const c=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cancel'); if(c) c.click(); }); return 1; })()`);
  await wait(600);
  await js(`(() => { const b=[...document.querySelectorAll('[aria-label="Where your favorites are stored"] button')].find(x=>x.textContent.trim()===${JSON.stringify(label)}); if (b && !b.disabled) b.click(); return 1; })()`);
  await wait(1200);
  const heading = await js(`(() => { const d=document.querySelector('[role="dialog"]'); return d ? d.querySelector('h3')?.textContent.trim() : null; })()`);
  check(`the dialog is about ${label}`, heading, `Switch to ${label}?`);
  await js(`(() => { const d=document.querySelector('[role="dialog"]'); const b=[...d.querySelectorAll('button')].find(x=>['Switch','Save'].includes(x.textContent.trim())); b.click(); return 1; })()`);
}
const check = (l, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${l}`); if (!ok) { fails++; console.log('        expected', JSON.stringify(b), '\n        actual  ', JSON.stringify(a)); } };

await send('Page.navigate', { url: APP }); await wait(2500);
await js(`(() => { localStorage.clear();
  localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`, `ws://127.0.0.1:${PORT + 1}`]))});
  localStorage.setItem('bmb:fav_private_optin', '1');
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)});
  localStorage.setItem('bmb:signer', 'nip07');
  localStorage.setItem('bmb:favorites:' + ${JSON.stringify(npub)}, JSON.stringify({
    'fce40d63-ef30-5c85-af07-d99b3c759807': { id: 0, podcastGuid: 'fce40d63-ef30-5c85-af07-d99b3c759807', title: 'Homegrown Hits', medium: 'music', addedAt: 1 },
  }));
  localStorage.setItem('bmb:favepisodes:' + ${JSON.stringify(npub)}, JSON.stringify({
    'https://example.com/ep?id=42&utm=x': { itemGuid: 'https://example.com/ep?id=42&utm=x', feedGuid: 'fce40d63-ef30-5c85-af07-d99b3c759807', medium: 'music', title: 'A track with a ? in its guid', addedAt: 2 },
  }));
  return 1; })()`);

console.log(`\n  throwaway npub ${npub.slice(0, 20)}…  relay ws://127.0.0.1:${PORT}\n`);
console.log('--- 1. PUBLIC: the app publishes what this device holds ---');
await send('Page.navigate', { url: `${APP}/favorites` }); await wait(15000);
await chooseMode('Public');
await wait(16000);

let last = published[published.length - 1];
check('a kind:10333 reached the relay', !!last, true);
check('the entries are PUBLIC tags', last?.tags.filter((t) => t[0] === 'i').length, 2);
check('and `content` is empty', last?.content, '');

console.log('\n--- 2. SWITCH TO PRIVATE: the entries move ---');
const before = published.length;
check('the control shows Public as chosen before the switch',
  await js(`(() => { const b=[...document.querySelectorAll('[aria-label="Where your favorites are stored"] button')].find(x=>x.getAttribute('aria-pressed')==='true'); return b ? b.textContent.trim() : null; })()`),
  'Public');
await chooseMode('Private');
await wait(22000);
const dlgErr = await js(`(() => { const d=document.querySelector('[role="dialog"]'); return d ? (d.querySelector('[role="alert"]')?.textContent ?? 'still open, no error shown') : null; })()`);
check('the dialog closed (null) rather than reporting a problem', dlgErr, null);

last = published[published.length - 1];
check('it published again', published.length > before, true);
check('nothing of ours is left in the public tags', last?.tags.filter((t) => t[0] === 'i').length, 0);
check('`content` now carries a private half', (last?.content ?? '').length > 0, true);
check('the ciphertext contains no "?"', (last?.content ?? '').includes('?'), false);

let plain = '', tags = [];
if (last?.content) { plain = nip44.v2.decrypt(last.content, convo); tags = JSON.parse(plain); }
else { console.log('   (no private half to decrypt — skipping its assertions)'); }
check('it decrypts to a tag array', Array.isArray(tags), true);
check('the album is in it', tags.some((t) => t[1] === 'podcast:guid:fce40d63-ef30-5c85-af07-d99b3c759807'), true);
check('the "?"-bearing track guid survived intact',
  tags.some((t) => t[1] === 'podcast:item:guid:https://example.com/ep?id=42&utm=x'), true);
check('and the plaintext we signed carried no raw "?"', plain.includes('?'), false);


// ---- the partial-acceptance notice ---------------------------------------
console.log('\n--- 2b. PARTIAL ACCEPTANCE: one relay refuses, and it must be said ---');
const reach = JSON.parse(await js(`JSON.stringify({
  text: (document.body.innerText.match(/Saved to \\d+ of \\d+ relays[^]*?depend on one\\./) || [''])[0],
  degraded: /couldn.t (confirm|open)/i.test(document.body.innerText),
})`));
console.log('    ', JSON.stringify(reach));
check('the reach notice is on screen', /Saved to 1 of 2 relays/.test(reach.text), true);
check('...and it names the relay that refused', /127\.0\.0\.1:/.test(reach.text), true);
check('...and it does NOT raise a degraded warning', reach.degraded, false);


console.log('\n--- 3. IDEMPOTENCE: reload twice, created_at must not move ---');
const at = last.created_at, count = published.length;
await send('Page.navigate', { url: `${APP}/favorites` }); await wait(14000);
await send('Page.navigate', { url: `${APP}/favorites` }); await wait(14000);
check('no republish on reload', published.length, count);
check('created_at is unchanged', published[published.length - 1].created_at, at);

console.log('\n--- 4. THE LIST STILL RENDERS, decrypted from `content` ---');
// **Read the heart's ACCESSIBLE NAME, not the page text.** This scanned
// `innerText` for /favorited/i, which coupled the one browser harness this repo
// has to a word on a chip: dropping FAVORITED for a layout reason (the glyph and
// the word both changed width, so toggling a heart shunted its neighbours) turned
// both of these assertions red on a change that broke nothing. It was also weak —
// it matched the string anywhere on the page, including copy that has nothing to
// do with a row. `aria-label` is `Unfavorite <label>` exactly when a heart is in
// the favorited state, it is what a screen reader announces, and counting the
// ROWS that carry one proves what these scenarios actually care about: every row
// that rendered is a favorite.
// innerText is uppercased by CSS on this page, so match case-insensitively.
const shown = await js(`JSON.stringify({
  saved: (document.body.innerText.match(/([0-9]+)\\s+saved/i) || [])[1] ?? null,
  rows: document.querySelectorAll('main li').length,
  favorited: [...document.querySelectorAll('main li')]
    .filter((li) => li.querySelector('[aria-label^="Unfavorite"]')).length,
  placeholder: /couldn.t load this/i.test(document.body.innerText),
  emptyClaim: /nothing saved yet|nothing on this device/i.test(document.body.innerText),
  notice: /couldn.t (confirm|open)/i.test(document.body.innerText),
})`);
console.log('   ', shown);
const sh = JSON.parse(shown);
check('the count still says 2', sh.saved, '2');
// The title on screen comes from Podcast Index, not from the fixture — a
// resolved title outranks the cache, which is the documented behaviour.
check('both rows render, decrypted out of `content`', sh.rows, 2);
check('...and BOTH read as favorited', sh.favorited, 2);
check('...and neither is an unresolved placeholder', sh.placeholder, false);
check('it does NOT claim the library is empty', sh.emptyClaim, false);
check('and no degraded notice is up', sh.notice, false);

console.log('\n--- 5. A SECOND ORIGIN: same account, empty device, list must still render ---');
// One repo, two deploys, and `localStorage` is PER-ORIGIN — so an account that
// arrives at boostmebuddy.com with a full list on the relay has no cache, no
// baseline and no recorded mode. `local` is empty, `localFed` is 0 on both
// halves, and `planFavoritesPublish` says `wholesale-delete`, which is correct:
// it must not publish an empty list over a full one. What it must ALSO not do
// is withhold the list from the screen — there is nothing on this device for
// that refusal to protect. Measured live on boostmebuddy.com: 880 private
// entries read, 0 rendered.
//
// Dropping exactly the per-account favorites keys is what makes this a NEW
// ORIGIN rather than a signed-out browser: the signer here rides a CDP binding,
// so sign-in survives, which is the real shape. `bmb:fav_privacy` goes too —
// its absence is why `seedFavoritesMode` has to read the mode off the wire.
//
// WHAT THIS SCENARIO DOES AND DOES NOT PROVE. It asserts the cacheless device
// renders the list and publishes nothing. It does NOT drive the
// `wholesale-delete` branch, and it passes with that fix reverted — measured,
// not assumed. `planFavoritesPublish` returns `'unchanged'` (line ~206) BEFORE
// it reaches the wipe guard (~line 270) whenever the merge re-serializes byte
// for byte to what the relay holds, which is exactly what a list this harness
// wrote itself does. Reaching the guard needs a read that does NOT round-trip
// identically — a list another app wrote, which is the reported case — and
// forging one here is impossible on purpose, since SimplePool verifies every
// signature. So this is a REGRESSION guard for the render path. The proof that
// the fix bites is `check:favsync`'s `mayAdoptRefusedRead` vectors, two of
// which fail against `naive()`.
const beforeAdopt = published.length;
await js(`(() => {
  for (const k of Object.keys(localStorage)) {
    if (/^bmb:(favorites|favepisodes|favbaseline|fav_cleared|fav_privacy)/.test(k)) {
      localStorage.removeItem(k);
    }
  }
  return true;
})()`);
await send('Page.navigate', { url: `${APP}/favorites` }); await wait(14000);
const adopted = await js(`JSON.stringify({
  rows: document.querySelectorAll('main li').length,
  rowText: [...document.querySelectorAll('main li')].map(li => li.innerText.slice(0, 60)),
  // See the note in scenario 4: the heart's accessible name, not page text.
  favorited: [...document.querySelectorAll('main li')]
    .filter((li) => li.querySelector('[aria-label^="Unfavorite"]')).length,
  emptyClaim: /nothing saved yet|nothing on this device/i.test(document.body.innerText),
  notice: /couldn.t (confirm|open)/i.test(document.body.innerText),
})`);
console.log('   ', adopted);
const ad = JSON.parse(adopted);
// ONE row, not two, and that is the CORRECT contract rather than a shortfall.
// `runHydrate` skips a group that is not `itemless` when this device has no
// cache entry for it (`if (!feed.itemless && !hit) continue`): a group holding
// a favorited item may exist only to NAME that item's parent, and reading it as
// an album favorite manufactures albums the user never chose — 159 of 197
// groups on the list that rule was written against. The album here holds the
// track, so on a device with no cache it is placement, not a favorite. It
// self-corrects the moment its last item goes; inventing a favorite never does.
// The ITEM always renders — `part.items` has no such skip.
check('the list renders on a device that has never seen it', ad.rows, 1);
check('...and it is the ITEM, which is what a cacheless device can be sure of',
  /example\.com\/ep/.test(ad.rowText[0] ?? ''), true);
check('...and it reads as favorited', ad.favorited, 1);
check('it does NOT claim the library is empty', ad.emptyClaim, false);
check('and no degraded notice is up', ad.notice, false);
// The adoption is RENDER-ONLY. Publishing an empty local list over a full relay
// list is the wipe this guard exists for, and it stays refused.
check('and it published NOTHING while adopting', published.length, beforeAdopt);

console.log('\n--- publish timeline ---');
published.forEach((e, i) => {
  const iTags = e.tags.filter((t) => t[0] === 'i').length;
  let inside = '';
  if (e.content) {
    try { inside = ` privateEntries=${JSON.parse(nip44.v2.decrypt(e.content, convo)).filter((t) => t[0] === 'i').length}`; }
    catch { inside = ' private=UNREADABLE'; }
  }
  console.log(`  ${i}  created_at=${e.created_at}  publicEntries=${iTags}  content=${e.content ? e.content.length + 'B' : 'empty'}${inside}`);
});
console.log('\n--- page log ---');
pageLog.filter((l) => /favorites|nostr|relay|error|warn/i.test(l)).slice(-30).forEach((l) => console.log('  ' + l));

ws.close();
stopChrome();
if (KEEP) console.log(`\nbrowser left open on ${APP} (--keep)`);
console.log(fails ? `\n${fails} FAILED` : '\nall end-to-end checks passed — nothing left this machine');
process.exit(fails ? 1 : 0);
