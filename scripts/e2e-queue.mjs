// Drives the listen queue in a real browser, with the identity half that
// nothing has ever driven.
//
// Usage:
//   npm run dev                  # in another terminal (or build && npm start)
//   CHROME_PATH=/usr/bin/google-chrome npm run e2e:queue
//   npm run e2e:queue -- --headed --keep
//
// WHY THIS EXISTS. PR #132 shipped with no test of any kind, and its own body
// says where the hole is: "Everything above ran signed out (`:guest`). The four
// identity sites are wired and reviewed but not driven." Per-npub `bmb:*` state
// with an adoption-on-sign-in step is precisely where this repo's silent data
// losses have happened, so that is the half this file is for.
//
// `check:queue` pins the four pure decisions and cannot see any of this: whether
// the bytes reach the right KEY, whether a reload finds them, whether switching
// accounts shows you somebody else's queue, and whether signing out leaves a
// queue on disk that comes back. All of that is wiring.
//
// WHAT IT DRIVES, AND WHAT IT STILL DOES NOT. Sections 1-5 press the real
// controls. Section 4 reaches a signed-in state the way the app does on a page
// load — the RESTORE effect, one of the identity sites — by seeding
// `bmb:npub` + `bmb:signer` and reloading, which is the same thing
// `e2e-favorites.mjs` does. **`completeSignIn`'s adopt branch is NOT driven
// here**: it runs on an interactive sign-in through the modal, not on a
// restore. That one is still owed, and saying so is better than a section that
// looks like it covers it.
//
// A throwaway key lives in this process and is reached from the page over a CDP
// binding, so `window.nostr` is indistinguishable from an extension; the relay
// is the same in-memory NIP-01 one `npm run relay` starts, imported rather than
// copied. NOTHING REACHES A PUBLIC RELAY.

import { createRelay } from './local-relay.mjs';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, nip04 } from 'nostr-tools';

const PORT = 7457, CDP = 9253, APP = process.env.APP_URL ?? 'http://localhost:3000';
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

// Measured feeds, both real and both still published.
const HGH = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';   // Homegrown Hits (music)
const PC20 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';  // Podcasting 2.0 (talk)

const appUp = await fetch(APP).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);
  console.error('(and `rm -rf .next` first if you have just run a production build)');
  process.exit(1);
}

const busy = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(() => true).catch(() => false);
if (busy) {
  console.error(`Something already owns CDP port ${CDP}. A leftover run would hand this script`);
  console.error(`the OLD browser and every assertion below would grade that one instead.`);
  console.error(`  pkill -f 'remote-debugging-port=${CDP}'`);
  process.exit(1);
}

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = `${tmpdir()}/bmb-e2e-queue`;
rmSync(profile, { recursive: true, force: true });
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const chrome = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  ...(asRoot ? ['--no-sandbox'] : []),
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
  '--window-size=1200,900',
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

const skA = generateSecretKey();
const pkA = getPublicKey(skA);
const npubA = nip19.npubEncode(pkA);
const convoA = nip44.v2.utils.getConversationKey(skA, pkA);
const npubB = nip19.npubEncode(getPublicKey(generateSecretKey()));

createRelay({ port: PORT, log: null, onEvent: () => {} });

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
await send('Runtime.addBinding', { name: 'bmbSigner' });
handlers.push(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = pkA;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], skA);
    else if (fn === 'nip44.encrypt') out = nip44.v2.encrypt(args[1], convoA);
    else if (fn === 'nip44.decrypt') out = nip44.v2.decrypt(args[1], convoA);
    else if (fn === 'nip04.encrypt') out = await nip04.encrypt(skA, args[0], args[1]);
    else if (fn === 'nip04.decrypt') out = await nip04.decrypt(skA, args[0], args[1]);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  await send('Runtime.evaluate', {
    expression: `window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify(out ?? null)}, ${JSON.stringify(err)})`,
  });
});
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      const waiting = new Map();
      window.__bmbResolve = (rid, out, err) => {
        const p = waiting.get(rid); if (!p) return; waiting.delete(rid);
        err ? p.reject(new Error(err)) : p.resolve(out);
      };
      let n = 0;
      const call = (fn, args) => new Promise((resolve, reject) => {
        const rid = 'r' + (++n);
        waiting.set(rid, { resolve, reject });
        window.bmbSigner(JSON.stringify({ rid, fn, args }));
      });
      window.nostr = {
        getPublicKey: () => call('getPublicKey', []),
        signEvent: (e) => call('signEvent', [e]),
        nip44: { encrypt: (p, t) => call('nip44.encrypt', [p, t]), decrypt: (p, c) => call('nip44.decrypt', [p, c]) },
        nip04: { encrypt: (p, t) => call('nip04.encrypt', [p, t]), decrypt: (p, c) => call('nip04.decrypt', [p, c]) },
      };
    })();
  `,
});

let failures = 0;
function section(n) { console.log(`\n${n}`); }
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.error(`  FAIL ${label}\n        expected ${e}\n        actual   ${a}`);
}

const queueOnDisk = (who) => js(`
  (() => {
    const raw = localStorage.getItem('bmb:listen_queue:' + ${JSON.stringify(who)});
    return raw ? JSON.parse(raw) : null;
  })()
`);

/** Press the first N queue controls on the page. Returns how many it pressed. */
const pressQueue = (n) => js(`
  (() => {
    const b = [...document.querySelectorAll('button[aria-label^="Add "]')].slice(0, ${n});
    b.forEach((x) => x.click());
    return b.length;
  })()
`);

const seedRelays = `localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});`;

await send('Page.navigate', { url: APP }); await wait(3000);
await js(`(() => { localStorage.clear(); ${seedRelays} return 1; })()`);

console.log(`\n  throwaway npub ${npubA.slice(0, 20)}…   relay ws://127.0.0.1:${PORT}\n`);

// ---------------------------------------------------------------------------
section('1. Signed out, the queue fills from two different shows and persists');
// ---------------------------------------------------------------------------
await send('Page.navigate', { url: `${APP}/?podcast=${HGH}` }); await wait(14000);
const pressed1 = await pressQueue(2);
await wait(1500);
await send('Page.navigate', { url: `${APP}/?podcast=${PC20}` }); await wait(14000);
const pressed2 = await pressQueue(1);
await wait(1500);

const guest = await queueOnDisk('guest');
check('two shows queued, under the guest key, in press order',
  { pressed: pressed1 + pressed2, len: guest?.length ?? 0, shows: new Set((guest ?? []).map((i) => i.podcast?.podcastGuid)).size },
  { pressed: 3, len: 3, shows: 2 });

// The trim is a denylist and the value block is the reason. A queue read back
// days later is what pays the artist.
const shape = await js(`
  (() => {
    const q = JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]');
    return {
      noDescription: q.every((i) => i.episode.description === undefined),
      noContentEncoded: q.every((i) => i.episode.contentEncoded === undefined),
      keptEnclosure: q.every((i) => !!i.episode.enclosureUrl),
      keptAShow: q.every((i) => typeof i.podcast?.id === 'number'),
    };
  })()
`);
check('description and contentEncoded are trimmed; the enclosure and a show survive',
  shape, { noDescription: true, noContentEncoded: true, keptEnclosure: true, keptAShow: true });

// ---------------------------------------------------------------------------
section('2. The same episode cannot be queued twice');
// ---------------------------------------------------------------------------
// A queued row does not offer a second Add — its control has become Remove.
// That is `epKey` answering, which is why this is the assertion rather than
// pressing Add twice and hoping: pressing twice would hit a DIFFERENT row.
const before = (await queueOnDisk('guest')).length;
const toggled = await js(`
  (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const removeFirst = () => document.querySelector('button[aria-label^="Remove "]');
    const hadRemove = !!removeFirst();
    removeFirst()?.click();
    await sleep(800);
    const afterRemove = JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]').length;
    // Re-add the same row: its control is an Add again.
    document.querySelector('button[aria-label^="Add "]')?.click();
    await sleep(800);
    const afterReAdd = JSON.parse(localStorage.getItem('bmb:listen_queue:guest') || '[]').length;
    return { hadRemove, afterRemove, afterReAdd };
  })()
`);
check('a queued row offers Remove, and the round trip returns to the same length',
  { before, ...toggled }, { before: 3, hadRemove: true, afterRemove: 2, afterReAdd: 3 });

// ---------------------------------------------------------------------------
section('3. It survives a reload, and the player finds it without autoplaying');
// ---------------------------------------------------------------------------
await send('Page.navigate', { url: `${APP}/queue` }); await wait(8000);
const afterReload = await js(`
  (() => {
    const rows = document.querySelectorAll('li');
    const audio = document.querySelector('audio');
    return {
      rows: rows.length,
      playing: audio ? !audio.paused : null,
      headingSaysUpNext: /up next/i.test(document.body.textContent || ''),
    };
  })()
`);
check('the queue renders after a reload and nothing started playing',
  afterReload, { rows: 3, playing: false, headingSaysUpNext: true });

// ---------------------------------------------------------------------------
section('4. A signed-in account gets ITS queue, never another account\'s');
// ---------------------------------------------------------------------------
// The restore effect is one of the four identity sites. Seeded the way
// e2e-favorites.mjs seeds it, because that is what a page load actually does.
await js(`
  (() => {
    localStorage.setItem('bmb:npub', ${JSON.stringify(npubA)});
    localStorage.setItem('bmb:signer', 'nip07');
    const guest = localStorage.getItem('bmb:listen_queue:guest');
    localStorage.setItem('bmb:listen_queue:' + ${JSON.stringify(npubA)}, guest);
    localStorage.setItem('bmb:listen_queue:' + ${JSON.stringify(npubB)}, '[]');
    return 1;
  })()
`);
await send('Page.navigate', { url: `${APP}/queue` }); await wait(12000);
const asA = await js(`document.querySelectorAll('li').length`);
check("account A sees A's three", { rows: asA }, { rows: 3 });

await js(`(() => { localStorage.setItem('bmb:npub', ${JSON.stringify(npubB)}); return 1; })()`);
await send('Page.navigate', { url: `${APP}/queue` }); await wait(12000);
const asB = await js(`
  (() => ({
    rows: document.querySelectorAll('li').length,
    saysEmpty: /nothing queued/i.test(document.body.textContent || ''),
    aStillOnDisk: JSON.parse(localStorage.getItem('bmb:listen_queue:' + ${JSON.stringify(npubA)}) || '[]').length,
  }))()
`);
check("account B sees its own empty queue, and A's is untouched on disk",
  asB, { rows: 0, saysEmpty: true, aStillOnDisk: 3 });

// ---------------------------------------------------------------------------
section('5. Signing out does not leave a guest queue that comes back');
// ---------------------------------------------------------------------------
// `setListenQueue([])` clears MEMORY. The store seeds `listenQueue` from
// `storage.listenQueue.get(null)` at module scope, so a guest queue left on
// disk reappears on the next load — which the sign-out comment explicitly says
// must not happen.
await js(`(() => { localStorage.setItem('bmb:npub', ${JSON.stringify(npubA)}); return 1; })()`);
await send('Page.navigate', { url: APP }); await wait(12000);
const opened = await js(`
  (() => {
    const t = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-expanded') !== null) && /account|menu|signed/i.test(b.getAttribute('aria-label') || ''));
    if (t) { t.click(); return true; }
    return false;
  })()
`);
await wait(1200);
const signedOut = await js(`
  (() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().toLowerCase() === 'sign out');
    if (!b) return 'no sign-out control found';
    b.click();
    return 'clicked';
  })()
`);
await wait(4000);
const guestAfter = await js(`
  (() => {
    const raw = localStorage.getItem('bmb:listen_queue:guest');
    return { raw, parsed: raw ? JSON.parse(raw).length : null };
  })()
`);
check('the account menu opened and sign out ran', { opened, signedOut }, { opened: true, signedOut: 'clicked' });
check('the guest queue is EMPTY on disk, not merely in memory',
  { len: guestAfter.parsed }, { len: 0 });

await send('Page.navigate', { url: `${APP}/queue` }); await wait(8000);
const resurrect = await js(`document.querySelectorAll('li').length`);
check('and it does not come back on the next load', { rows: resurrect }, { rows: 0 });

// ---------------------------------------------------------------------------
section('6. The dock reaches it, and Queue is second');
// ---------------------------------------------------------------------------
const dock = await js(`
  (() => {
    const nav = document.querySelector('nav[aria-label="Main"]');
    const items = [...nav.querySelectorAll('a,button')];
    return {
      labels: items.map((i) => i.textContent.trim()),
      current: items.find((i) => i.getAttribute('aria-current') === 'page')?.textContent.trim() ?? null,
    };
  })()
`);
check('five tabs, Queue second, Wallet gone, and /queue is current',
  dock, { labels: ['Home', 'Queue', 'Live', 'Favorites', 'Downloads'], current: 'Queue' });

if (failures) {
  console.error(`\nQUEUE E2E FAILED (${failures})`);
  process.exit(1);
}
console.log('\nQUEUE E2E OK');
