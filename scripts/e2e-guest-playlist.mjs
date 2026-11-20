// e2e for making, editing and deleting a community playlist with NO Nostr account,
// in a real browser (docs/feeds.md, "Making a playlist without a Nostr account").
//
// Needs a dev server started with, on the command line (never in .env.local):
//   COMMUNITY_DB_URL=postgres://postgres:test@localhost:54329/postgres
//   (the local Postgres with the schema applied: `npm run community:schema`)
//   NEXT_PUBLIC_COMMUNITY_PLAYLISTS=on NEXT_PUBLIC_COMMUNITY_FEED_ORIGIN=http://localhost:3123 \
//   npm run dev -- -p 3123 > /path/to/server.log 2>&1
// APP_URL overrides the server; SERVER_LOG=/path/to/server.log adds the server's own
// output to the search for the key. COMMUNITY_PI_NOTIFY, GITHUB_ARCHIVE_TOKEN and the
// podping variables are NOT set, so nothing reaches Podcast Index, GitHub or Hive.
// The server still needs the real PODCAST_INDEX_KEY/SECRET in .env.local: the publish
// route verifies each song against Podcast Index (a READ).
//
// WHAT IT PROVES
//  1. A visitor with no account publishes, edits (SAVE) and deletes a playlist. Nobody
//     signs in, and the visitor is shown no key. The key is made by PUBLISH, not by
//     looking at the page.
//  2. After a reload, and on a second playlist, the same browser edits again with ONE
//     key (one IndexedDB record). The playlist's owner on the server is that key's pubkey.
//  3. THE KEY NEVER LEAVES THE BROWSER. The secret is recovered from the page's own
//     random draws, and then searched for, in hex, base64, base64url, nsec and raw
//     bytes, in: every request (URL, headers, body), every WebSocket frame, every
//     console line, localStorage, sessionStorage, cookies, the URL, the DOM, the
//     IndexedDB record, and the server's own output.
//  4. WHAT THE WRAP DOES AND DOES NOT DO: the AES key is non-extractable
//     (`exportKey` fails), and a script on this origin can still read the record and
//     call `decrypt()` with it. The test does that, so the PR says it truthfully.
//  5. A lost key (site data cleared) leaves the playlist alive and uneditable, with a
//     plain message and no form; a new playlist then gets a new key.
//  6. A browser that cannot keep a key (no IndexedDB) still publishes, says so, and
//     cannot edit later.
//  7. A signed-in account is unchanged: it publishes under its own key, makes no guest
//     key, and can still edit a guest-made playlist of THIS browser.
//  8. At 1280 x 900 and 390 x 844: no horizontal overflow, controls 24 x 24 or more.
//  9. THE START CHOICE (<StartChoice>, Chad 2026-11-19): signed out with no browser key,
//     the maker asks "SIGN IN WITH NOSTR or I DON'T HAVE NOSTR" first. Closing it (x,
//     Escape) leaves the form and makes no key, and it asks again on the next visit.
//     SIGN IN WITH NOSTR opens the site's sign-in. I DON'T HAVE NOSTR makes the key at
//     once, and PUBLISH then uses that key. A browser holding a key, a signed-in account
//     and an edit address never see it. Clicks on it are real mouse events, so a dialog
//     that is not in front fails them.
// No EVENT reaches a public relay: the local relay is the only WebSocket allowed.
import { readFileSync } from 'node:fs';
import { createRelay } from './local-relay.mjs';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const APP = (process.env.APP_URL || 'http://localhost:3123').replace(/\/$/, '');
await requireApp(APP, `Nothing is serving ${APP}. Start the dev server (see the top of this file).`);
const SERVER_LOG = process.env.SERVER_LOG;

const SONG_SOURCE = 'https://v4vmusic.com/playlist/334bb12d-1f72-4c0e-88e1-266bd1e2dff9.xml';
const GUEST_SLOT = 'bmb:playlist_draft:guest';
const t = checker();

// An account for step 7: a throwaway key behind a fake NIP-07 window.nostr.
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const npub = nip19.npubEncode(pk);
const relayEvents = [];
const relay = createRelay({ port: 0, log: null, onEvent: (e) => relayEvents.push(e) });
const PORT = await relay.ready;

const { page } = await launchChrome({ name: `guestplaylist-${process.env.CLAUDE_CODE_SESSION_ID || 'local'}`, args: ['--disable-gpu'] });
const { send } = page;
const js = page.jsOrThrow;
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
let ipN = 0;
const newIp = () => send('Network.setExtraHTTPHeaders', { headers: { 'x-real-ip': `10.78.${Math.floor(Math.random() * 250)}.${(ipN++ % 250) + 1}` } });
await newIp();

// ── everything the browser sends or prints, for the search ───────────────────
const seen = { requests: [], frames: [], consoles: [], sockets: [], draws: [], events: [] };
const socketUrl = new Map();
page.on(async (m) => {
  const p = m.params ?? {};
  if (m.method === 'Network.requestWillBeSent') seen.requests.push({ url: p.request.url, method: p.request.method, headers: p.request.headers, body: p.request.postData ?? null });
  else if (m.method === 'Network.requestWillBeSentExtraInfo') seen.requests.push({ headers: p.headers });
  else if (m.method === 'Network.webSocketCreated') { seen.sockets.push(p.url); socketUrl.set(p.requestId, p.url); }
  else if (m.method === 'Network.webSocketFrameSent') {
    const data = p.response?.payloadData ?? '';
    seen.frames.push(data);
    // A READ (REQ) may go to a public relay; an EVENT never may (this test publishes none).
    if (data.startsWith('["EVENT"')) seen.events.push({ to: socketUrl.get(p.requestId) ?? '?', data });
  }
  else if (m.method === 'Runtime.consoleAPICalled') seen.consoles.push(JSON.stringify(p.args?.map((a) => a.value ?? a.description ?? a.type)));
  else if (m.method === 'Runtime.exceptionThrown') seen.consoles.push(JSON.stringify(p.exceptionDetails?.text ?? '') + JSON.stringify(p.exceptionDetails?.exception?.description ?? ''));
  else if (m.method === 'Runtime.bindingCalled' && p.name === 'bmbDraw') seen.draws.push(p.payload);
});

// The fake NIP-07 signer (step 7) and a spy on the page's random draws (the secret).
await send('Runtime.addBinding', { name: 'bmbSigner' });
await send('Runtime.addBinding', { name: 'bmbDraw' });
page.on(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'bmbSigner') return;
  const { rid, fn, args } = JSON.parse(m.params.payload);
  let out, err = null;
  try {
    if (fn === 'getPublicKey') out = pk;
    else if (fn === 'signEvent') out = finalizeEvent(args[0], sk);
    else err = `no such method ${fn}`;
  } catch (e) { err = String(e?.message ?? e); }
  await js(`window.__bmbResolve(${JSON.stringify(rid)}, ${JSON.stringify({ out, err })})`);
});
const INIT = `
  (() => {
    // Only the account steps read window.nostr; a guest never touches it.
    const waiting = new Map(); let n = 0;
    window.__bmbResolve = (rid, r) => { const p = waiting.get(rid); waiting.delete(rid); if (!p) return; r.err ? p.reject(new Error(r.err)) : p.resolve(r.out); };
    const call = (fn, ...args) => new Promise((resolve, reject) => {
      const rid = 'r' + (++n); waiting.set(rid, { resolve, reject });
      window.bmbSigner(JSON.stringify({ rid, fn, args }));
    });
    if (localStorage.getItem('bmb:signer') === 'nip07') window.nostr = { getPublicKey: () => call('getPublicKey'), signEvent: (e) => call('signEvent', e) };
    // nostr-tools draws 48 random bytes and reduces them: the secret is derived from a draw, not a draw itself.
    const g = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: (a) => {
      const out = g(a);
      if (a.byteLength >= 32 && a.byteLength <= 64) { try { window.bmbDraw(Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), (b) => b.toString(16).padStart(2, '0')).join('')); } catch {} }
      return out;
    } });
  })();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });

// ── helpers ──────────────────────────────────────────────────────────────────
const waitFor = async (expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(`!!(${expr})`)) return true; await wait(250); }
  return false;
};
const go = async (path) => { await send('Page.navigate', { url: `${APP}${path}` }); await wait(1500); };
const byText = (label) => `[...document.querySelectorAll('main button, main a')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
const click = (finder) => js(`(() => { const b = ${finder}; if (b) b.click(); return !!b; })()`);
const overflowFree = () => js('document.documentElement.scrollWidth <= document.documentElement.clientWidth');
const tooSmall = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).map((e) => e.textContent.trim().slice(0, 30))`);
const setValue = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
/** A real mouse click at the element's centre: whatever is IN FRONT there gets it. */
const mouseClick = async (finder) => {
  const at = await js(`(() => { const b = ${finder}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!at) return false;
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  return true;
};
const START = `document.querySelector('[data-start-choice]')`;
const START_CLOSE = `${START}?.closest('[role=dialog]')?.querySelector('button[aria-label=Close]')`;
const DIALOG_NAMES = `[...document.querySelectorAll('[role=dialog]')].map((d) => document.getElementById(d.getAttribute('aria-labelledby'))?.textContent ?? '')`;
/** No start choice, still, a while after the page settled (it waits for the key read). */
const noStart = async () => { await wait(1200); return js(`!${START}`); };
const metrics = (mobile) => send('Emulation.setDeviceMetricsOverride', mobile
  ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
  : { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
const api = (path) => fetch(`${APP}${path}`, { headers: { 'x-real-ip': '10.78.250.250' } });
const feedIdOf = (u) => /feeds\/playlists\/([0-9a-f-]{36})\.xml$/.exec(u)?.[1];

/** What the guest key holds in this browser: one record or none. Never reads or prints a secret. */
const idbState = () => js(`new Promise((resolve) => {
  if (typeof indexedDB === 'undefined' || !indexedDB) return resolve({ available: false });
  const open = indexedDB.open('bmb-guest', 1);
  open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys', { keyPath: 'id' }); };
  open.onerror = () => resolve({ available: false, error: true });
  open.onsuccess = () => {
    const all = open.result.transaction('keys', 'readonly').objectStore('keys').getAll();
    all.onsuccess = () => { const recs = all.result.map((r) => ({
      id: r.id, pubkey: r.pubkey, ivBytes: r.iv?.byteLength, ctBytes: r.ct?.byteLength,
      wrapIsCryptoKey: r.wrap instanceof CryptoKey, wrapExtractable: r.wrap?.extractable, wrapAlgorithm: r.wrap?.algorithm?.name,
      keys: Object.keys(r).sort(),
    })); open.result.close(); resolve({ available: true, records: recs }); };
    all.onerror = () => resolve({ available: false, error: true });
  };
})`);

/** Everything the page itself holds that could carry a key, as text. */
const pageText = () => js(`new Promise(async (resolve) => {
  const out = [];
  out.push(JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
  out.push(JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
  out.push(document.cookie, location.href, document.referrer);
  out.push(document.documentElement.outerHTML);
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    for (const d of dbs) {
      if (!d.name) continue;
      await new Promise((res) => {
        const o = indexedDB.open(d.name);
        o.onerror = () => res();
        o.onsuccess = () => {
          const db = o.result; const names = [...db.objectStoreNames];
          if (!names.length) { db.close(); return res(); }
          const tx = db.transaction(names, 'readonly'); let left = names.length;
          for (const n of names) {
            const all = tx.objectStore(n).getAll();
            all.onsuccess = () => {
              for (const r of all.result) {
                // Records are searched as bytes AND as JSON; a CryptoKey serialises to {}.
                out.push(JSON.stringify(r, (k, v) => (v instanceof Uint8Array || v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)).join(',') : v)));
                out.push('BYTES:' + [r.iv, r.ct].filter(Boolean).map((b) => Array.from(new Uint8Array(b)).join(',')).join('|'));
              }
              if (--left === 0) { db.close(); res(); }
            };
            all.onerror = () => { if (--left === 0) { db.close(); res(); } };
          }
        };
      });
    }
  } catch {}
  resolve(out.join('\\n'));
})`);

// secp256k1's order: nostr-tools / noble make the secret as (draw mod (n - 1)) + 1. Which
// byte order the draw is read in differs between noble-curves releases (1.2.0 reads it
// little-endian), so both are tried and the one whose public key matches is the secret.
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const candidatesFromDraws = () => seen.draws.flatMap((hex) => {
  const be = Buffer.from(hex, 'hex');
  return [be, Buffer.from(be).reverse()].map((b) => {
    const v = (BigInt('0x' + b.toString('hex')) % (N - 1n)) + 1n;
    return Uint8Array.from(Buffer.from(v.toString(16).padStart(64, '0'), 'hex'));
  });
});
const secretForPubkey = (pubkey) => candidatesFromDraws().find((c) => { try { return getPublicKey(c) === pubkey; } catch { return false; } }) ?? null;
const forms = (s) => [Buffer.from(s).toString('hex'), Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), nip19.nsecEncode(s)];
const rawBytesForm = (s) => Array.from(s).join(',');
const hasSecret = (hay, s) => forms(s).some((f) => hay.includes(f)) || hay.includes(rawBytesForm(s));

/** Search every place the key could have gone. Returns the places that hold it (empty is the pass). */
async function whereIsIt(secret) {
  const places = [];
  const reqText = JSON.stringify(seen.requests);
  if (hasSecret(reqText, secret)) places.push('a request (URL, header or body)');
  if (hasSecret(seen.frames.join('\n'), secret)) places.push('a WebSocket frame');
  if (hasSecret(seen.consoles.join('\n'), secret)) places.push('the console');
  if (hasSecret(await pageText(), secret)) places.push('page storage, the URL or the DOM');
  if (SERVER_LOG && hasSecret(readFileSync(SERVER_LOG, 'utf8'), secret)) places.push("the server's output");
  return places;
}

// ── twelve real songs ────────────────────────────────────────────────────────
const src = await fetch(`${APP}/api/playlist?url=${encodeURIComponent(SONG_SOURCE)}&limit=40`).then((r) => r.json()).catch(() => ({}));
const real = (src.episodes ?? []).filter((e) => !e.unresolved && e.guid && e.podcastGuid).slice(0, 12);
t.ok('twelve real songs to seed with', real.length === 12, `got ${real.length}`);
const songs = real.map((e) => ({ feedGuid: e.podcastGuid, itemGuid: e.guid }));
const labels = Object.fromEntries(real.map((e) => [e.guid, { title: e.title, ...(e.feedTitle ? { artist: e.feedTitle } : {}) }]));
const seedGuest = (title) => js(`(() => { localStorage.setItem(${JSON.stringify(GUEST_SLOT)}, JSON.stringify({
  draft: ${JSON.stringify({ title, description: 'made by e2e-guest-playlist', ownerName: '', artUrl: null, songs })},
  editingId: null, expectedUpdatedAt: null, labels: ${JSON.stringify(labels)} })); return 1; })()`);
const published = () => waitFor(`document.querySelector('[data-testid=published]')`, 40000);

await send('Page.navigate', { url: APP });
await wait(500);
await js('(() => { localStorage.clear(); sessionStorage.clear(); return 1; })()');
await js(`indexedDB.deleteDatabase('bmb-guest'); 1`);
await js(`localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))}); 1`);

let guestPubkey = null;
const madeIds = [];

// ── the start choice ─────────────────────────────────────────────────────────
console.log('--- the start choice ---');
for (const mobile of [false, true]) {
  const name = mobile ? 'phone 390 x 844' : 'desktop 1280 x 900';
  await metrics(mobile);
  await seedGuest(`e2e start choice (${name})`);
  await go('/playlists/make');
  t.ok(`${name}: signed out with no key, the maker opens the start choice`, await waitFor(START));
  t.ok(`${name}: it offers SIGN IN WITH NOSTR and I DON'T HAVE NOSTR`,
    await js(`${START}.querySelector('[data-start-signin]')?.textContent.trim() === 'SIGN IN WITH NOSTR' && /^I DON.T HAVE NOSTR$/.test(${START}.querySelector('[data-start-guest]')?.textContent.trim() ?? '')`));
  t.ok(`${name}: it says what closing it does before it is closed`, await js(`/close this to decide later/i.test(${START}.innerText) && /makes the key then/i.test(${START}.innerText)`));
  t.ok(`${name}: the draft is loaded behind it`, await waitFor(`document.querySelector('#pl-title')?.value.startsWith('e2e start choice')`));
  t.ok(`${name}: no horizontal overflow`, await overflowFree());
  t.equal(`${name}: the dialog's controls are at least 24 x 24`, await tooSmall('[role=dialog] button'), []);
  t.ok(`${name}: the dialog fits on the screen`, await js(`(() => { const r = ${START}.closest('[role=dialog]').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`));
  t.equal(`${name}: opening the maker made no key`, (await idbState()).records?.length ?? 0, 0);
  if (!mobile) {
    t.ok('x closes it (a real click)', await mouseClick(START_CLOSE));
    t.ok('...and the form is there to build on, with PUBLISH', await waitFor(`!${START} && !!document.querySelector('#pl-title') && !!${byText('PUBLISH')}`, 3000));
    t.ok('...and it does not come back on this page', await noStart());
    t.equal('...and closing it made no key', (await idbState()).records?.length ?? 0, 0);
    await go('/playlists/make');
    t.ok('a later visit with no choice made asks again', await waitFor(START));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    t.ok('Escape closes it too', await waitFor(`!${START} && !!document.querySelector('#pl-title')`, 3000));
  } else {
    t.ok(`${name}: SIGN IN WITH NOSTR pressed (a real tap)`, await mouseClick(`${START}.querySelector('[data-start-signin]')`));
    t.ok(`${name}: the start choice closes and the site's sign-in opens`, await waitFor(`!${START} && ${DIALOG_NAMES}.includes('Sign in')`, 5000));
    t.equal(`${name}: the sign-in dialog fits at 390 wide`, await js(`(() => { const r = [...document.querySelectorAll('[role=dialog]')][0].getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`), true);
    await mouseClick(`document.querySelector('[role=dialog] button[aria-label=Close]')`);
    t.ok(`${name}: closing the sign-in leaves the form`, await waitFor(`!document.querySelector('[role=dialog]') && !!document.querySelector('#pl-title')`, 3000));
    t.ok(`${name}: and the start choice does not come back on this page`, await noStart());
    t.equal(`${name}: and no key was made`, (await idbState()).records?.length ?? 0, 0);
  }
}

for (const mobile of [false, true]) {
  const name = mobile ? 'phone 390 x 844' : 'desktop 1280 x 900';
  console.log(`--- ${name} ---`);
  await metrics(mobile);
  await newIp();

  // 1. The page shows no key, and looking at it makes none.
  await seedGuest(`e2e guest playlist (${name})`);
  await go('/playlists/make');
  t.ok(`${name}: the maker loads the draft with nobody signed in`, await waitFor(`document.querySelector('#pl-title')?.value.startsWith('e2e guest playlist') && document.querySelectorAll('[data-song-row]').length === 12`));
  t.ok(`${name}: the footer says no account is needed`, await js(`/no account needed/i.test(document.querySelector('[data-testid=signed-out-note]')?.innerText ?? '')`));
  t.ok(`${name}: PUBLISH is not blocked (no reason line)`, await js(`!document.querySelector('[data-testid=why-blocked]')`));
  t.ok(`${name}: no horizontal overflow`, await overflowFree());
  t.equal(`${name}: controls at least 24 x 24`, await tooSmall('main button:not(.btn-inline), main a'), []);
  if (!mobile) t.equal('looking at the maker made no key', (await idbState()).records?.length ?? 0, 0);
  let chosenPubkey = null;
  if (!mobile) {
    // The start choice: I DON'T HAVE NOSTR makes the key NOW, before any PUBLISH.
    t.ok('the start choice is open', await waitFor(START));
    t.ok('I DON\'T HAVE NOSTR pressed (a real click)', await mouseClick(`${START}.querySelector('[data-start-guest]')`));
    t.ok('...the start choice closes', await waitFor(`!${START}`, 5000));
    const made = await idbState();
    t.equal('...and the key is made and kept at once: one record', made.records?.length, 1);
    chosenPubkey = made.records?.[0]?.pubkey ?? null;
    t.ok('...the footer still says no account is needed, and that this browser keeps the key',
      await js(`/no account needed/i.test(document.querySelector('[data-testid=signed-out-note]')?.innerText ?? '') && document.querySelector('[data-testid=signed-out-note]')?.dataset.guestKept !== 'false'`));
    t.ok('...and it does not ask again on this page', await noStart());
  } else {
    t.ok(`${name}: a browser that holds the key never sees the start choice`, await noStart());
  }
  const keyBefore = (await idbState()).records?.length ?? 0;

  // 2. PUBLISH makes the key and publishes; nobody signs in.
  t.ok(`${name}: PUBLISH pressed`, await click(byText('PUBLISH')));
  t.ok(`${name}: the Published view appears`, await published());
  const feedUrl = await js(`document.querySelector('#feed-address')?.value ?? ''`);
  const id = feedIdOf(feedUrl);
  t.ok(`${name}: the feed address names the new playlist`, !!id, feedUrl);
  madeIds.push(id);
  t.ok(`${name}: the published view says it was made without an account and can be edited here`,
    await js(`document.querySelector('[data-testid=guest-kept]')?.dataset.guestKept === 'true' && /edit this playlist again in this browser/i.test(document.querySelector('[data-testid=guest-kept]').innerText)`));
  t.ok(`${name}: published: no horizontal overflow`, await overflowFree());
  t.equal(`${name}: published: controls at least 24 x 24`, await tooSmall('main button:not(.btn-inline), main a'), []);
  const st = await idbState();
  t.equal(`${name}: exactly one key record after publishing`, st.records?.length, 1);
  const rec = st.records?.[0];
  guestPubkey ??= rec?.pubkey;
  t.ok(`${name}: it is the same key every time (the first playlist's key)`, rec?.pubkey === guestPubkey, `${rec?.pubkey} vs ${guestPubkey}`);
  t.ok(`${name}: the record holds a public key, an iv, a 48-byte ciphertext and a CryptoKey that is not extractable`,
    /^[0-9a-f]{64}$/.test(rec?.pubkey ?? '') && rec?.ivBytes === 12 && rec?.ctBytes === 48 && rec?.wrapIsCryptoKey === true && rec?.wrapExtractable === false && rec?.wrapAlgorithm === 'AES-GCM', JSON.stringify(rec));
  t.equal(`${name}: the record has only those five fields`, rec?.keys, ['ct', 'id', 'iv', 'pubkey', 'wrap']);
  if (!mobile) {
    t.equal('PUBLISH made no second key: one before, one after', [keyBefore, st.records?.length], [1, 1]);
    t.ok('PUBLISH used the key I DON\'T HAVE NOSTR made', !!chosenPubkey && rec?.pubkey === chosenPubkey, `${rec?.pubkey} vs ${chosenPubkey}`);
  }
  const stored = (await (await api(`/api/community-playlists/${id}`)).json()).playlist;
  t.ok(`${name}: the server's owner for the playlist is the guest key's pubkey`, stored?.ownerPubkey === guestPubkey, `${stored?.ownerPubkey} vs ${guestPubkey}`);
  t.ok(`${name}: and it is not the account's`, stored?.ownerPubkey !== pk);

  // 3. EDIT later: a reload, the same browser, the same key.
  await newIp();
  await go(`/playlists/make?id=${id}`);
  t.ok(`${name}: ?id= opens the playlist for editing with nobody signed in`, await waitFor(`document.querySelector('#pl-title')?.value === ${JSON.stringify(`e2e guest playlist (${name})`)}`, 30000));
  t.ok(`${name}: an edit address never shows the start choice`, await noStart());
  t.ok(`${name}: and says only this browser can change it`, await js(`/only this browser can change this playlist/i.test(document.querySelector('[data-testid=guest-edit-note]')?.innerText ?? '')`));
  t.ok(`${name}: SAVE and DELETE are offered`, await js(`!!${byText('SAVE')} && !!${byText('DELETE')}`));
  await setValue('#pl-title', `e2e guest playlist (${name}) v2`);
  await wait(300);
  t.ok(`${name}: SAVE pressed`, await click(byText('SAVE')));
  t.ok(`${name}: SAVE shows the Published view with the new title`, await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes('v2')`, 40000));
  const after = (await (await api(`/api/community-playlists/${id}`)).json()).playlist;
  t.ok(`${name}: the server has the new title and the SAME owner`, after?.title.endsWith('v2') && after?.ownerPubkey === guestPubkey);
  t.equal(`${name}: still exactly one key record`, (await idbState()).records?.length, 1);
}

// ── THE KEY NEVER LEFT THE BROWSER ───────────────────────────────────────────
console.log('--- the key never leaves the browser ---');
const secret = secretForPubkey(guestPubkey);
t.ok('the secret was recovered from the page\'s own random draws (so the search below can mean something)', !!secret, `${seen.draws.length} draws of ${JSON.stringify(seen.draws.map((h) => h.length / 2))} bytes`);
if (secret) {
  const where = await whereIsIt(secret);
  t.equal('the secret is in NO request, WebSocket frame, console line, storage, cookie, URL, DOM, IndexedDB record or server log', where, []);
  t.ok('requests were recorded (the search is not empty)', seen.requests.length > 20 && seen.requests.some((r) => /community-playlists/.test(r.url ?? '')));
  // The pubkey, in contrast, is public and does travel: the search can find a value that is there.
  t.ok('control: the PUBLIC key does appear in requests (the search can find what is there)', JSON.stringify(seen.requests).includes(guestPubkey) || (await pageText()).includes(guestPubkey));
}
t.equal('no EVENT was sent to a public relay (reads of public relays are allowed, publishing is not)', seen.events.filter((e) => !/^ws:\/\/127\.0\.0\.1:/.test(e.to)).map((e) => e.to), []);
t.equal('no event of the guest went to the local relay either (the guest key signs nothing but playlist requests)',
  relayEvents.filter((e) => e.pubkey === guestPubkey).length, 0);

// ── WHAT THE WRAP DOES AND DOES NOT DO ───────────────────────────────────────
console.log('--- the wrap: what it stops and what it does not ---');
const wrapProbe = await js(`new Promise((resolve) => {
  const open = indexedDB.open('bmb-guest', 1);
  open.onsuccess = async () => {
    const get = open.result.transaction('keys', 'readonly').objectStore('keys').get('playlist-v1');
    get.onsuccess = async () => {
      const r = get.result; const out = {};
      try { await crypto.subtle.exportKey('raw', r.wrap); out.exported = true; } catch { out.exported = false; }
      try {
        const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv, additionalData: new TextEncoder().encode('bmb-guest-playlist-key:v1:' + r.pubkey) }, r.wrap, r.ct));
        out.decrypted = sk.byteLength; out.hex = Array.from(sk, (b) => b.toString(16).padStart(2, '0')).join('');
      } catch { out.decrypted = 0; }
      open.result.close(); resolve(out);
    };
  };
})`);
t.equal('exportKey on the stored AES key is refused', wrapProbe.exported, false);
t.equal('a script ON THIS ORIGIN can still read the record and decrypt the key with it (what the wrap does not stop)', wrapProbe.decrypted, 32);
t.ok('...and what it decrypts is the real key (it derives the same pubkey)', secret && wrapProbe.hex === Buffer.from(secret).toString('hex'));

// ── a second playlist on the same key; DELETE; a lost key ────────────────────
console.log('--- delete, and a lost key ---');
await metrics(false);
await newIp();
await go(`/playlists/make?id=${madeIds[1]}`);
t.ok('the second playlist (made on the phone layout) opens for editing', await waitFor(`!!${byText('DELETE')}`, 30000));
t.ok('DELETE asks first', (await click(byText('DELETE'))) && await waitFor(`document.querySelector('[role=dialog]')?.innerText.includes('Delete this playlist?')`));
t.ok('the confirm DELETE is pressed', await click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'DELETE')`));
let gone = false;
for (let i = 0; i < 40 && !gone; i++) { gone = (await fetch(`${APP}/feeds/playlists/${madeIds[1]}.xml`)).status === 410; if (!gone) await wait(250); }
t.ok('a guest deletes its own playlist: the feed answers 410', gone);

// Lost key: the site data is cleared. The first playlist stays alive and is not editable.
await js(`new Promise((r) => { const q = indexedDB.deleteDatabase('bmb-guest'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
await go(`/playlists/make?id=${madeIds[0]}`);
t.ok('lost key: the page says only its maker can change it', await waitFor(`document.querySelector('[data-testid=not-yours]')?.innerText.includes('Only the person who made this playlist can change it')`, 30000));
t.ok('...with no form', await js(`!document.querySelector('#pl-title')`));
t.equal('...and the feed is still alive', (await fetch(`${APP}/feeds/playlists/${madeIds[0]}.xml`)).status, 200);
t.equal('...and reading the page made no new key', (await idbState()).records?.length ?? 0, 0);
t.ok('...and it shows no start choice (it is not a new playlist)', await noStart());
await newIp();
await seedGuest('e2e guest playlist after losing the key');
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')?.value.startsWith('e2e guest playlist after')`);
t.ok('a new playlist after losing the key: the start choice asks again (no key now)', await waitFor(START));
t.ok('...closed with no choice', (await mouseClick(START_CLOSE)) && await waitFor(`!${START}`, 3000));
t.equal('...so still no key before PUBLISH', (await idbState()).records?.length ?? 0, 0);
t.ok('a new playlist after losing the key: PUBLISH works', (await click(byText('PUBLISH'))) && await published());
t.equal('...and PUBLISH made the key (the close-with-no-choice path)', (await idbState()).records?.length ?? 0, 1);
const newId = feedIdOf(await js(`document.querySelector('#feed-address')?.value ?? ''`));
madeIds.push(newId);
const newPub = (await idbState()).records?.[0]?.pubkey;
t.ok('...under a NEW key (the old playlist stays with the lost one)', !!newPub && newPub !== guestPubkey && (await (await api(`/api/community-playlists/${newId}`)).json()).playlist?.ownerPubkey === newPub);

// ── the playlists page: EDIT shows on this browser's own playlists only ──────
console.log('--- the playlists page ---');
await go('/playlists');
t.ok('the playlists page marks this browser\'s own playlist with EDIT', await waitFor(`!!document.querySelector('a[data-edit-playlist][href$="id=${newId}"]')`, 30000));
t.equal('...and the lost-key playlist has no EDIT', await js(`!!document.querySelector('a[data-edit-playlist][href$="id=${madeIds[0]}"]')`), false);

// ── a browser that cannot keep a key ─────────────────────────────────────────
console.log('--- a browser with no IndexedDB ---');
const noIdb = await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });` });
await newIp();
await seedGuest('e2e guest playlist with no storage');
await go('/playlists/make');
await waitFor(`document.querySelector('#pl-title')?.value.startsWith('e2e guest playlist with no')`);
t.ok('no IndexedDB: the start choice opens', await waitFor(START));
t.ok('...I DON\'T HAVE NOSTR pressed', (await mouseClick(`${START}.querySelector('[data-start-guest]')`)) && await waitFor(`!${START}`, 5000));
t.ok('...the footer says this browser cannot keep the key, so the playlist cannot be edited later',
  await waitFor(`document.querySelector('[data-testid=signed-out-note]')?.dataset.guestKept === 'false' && /cannot keep a key/i.test(document.querySelector('[data-testid=signed-out-note]').innerText)`, 3000));
t.ok('PUBLISH still works', (await click(byText('PUBLISH'))) && await published());
t.ok('the published view says this browser could not keep the key, so it cannot be edited later',
  await js(`document.querySelector('[data-testid=guest-kept]')?.dataset.guestKept === 'false' && /could not keep the key/i.test(document.querySelector('[data-testid=guest-kept]').innerText)`));
const memId = feedIdOf(await js(`document.querySelector('#feed-address')?.value ?? ''`));
madeIds.push(memId);
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: noIdb.result?.identifier });
await go(`/playlists/make?id=${memId}`);
t.ok('storage is back for the next page', await js(`typeof indexedDB !== 'undefined' && !!indexedDB`), JSON.stringify(noIdb));
t.ok('later, with storage back, that playlist cannot be edited (no key was kept)', await waitFor(`!!document.querySelector('[data-testid=not-yours]')`, 30000));

// ── an account is unchanged ──────────────────────────────────────────────────
console.log('--- a signed-in account ---');
await js(`(() => { localStorage.setItem('bmb:relays', ${JSON.stringify(JSON.stringify([`ws://127.0.0.1:${PORT}`]))});
  localStorage.setItem('bmb:npub', ${JSON.stringify(npub)}); localStorage.setItem('bmb:signer', 'nip07'); return 1; })()`);
await newIp();
await seedGuest('e2e account playlist');
await go('/playlists/make');
t.ok('signed in: the footer names the account', await waitFor(`/Signed in as/.test(document.querySelector('main')?.innerText ?? '')`, 30000));
t.ok('...and the account\'s draft is there', await waitFor(`document.querySelector('#pl-title')?.value === 'e2e account playlist'`, 15000));
t.ok('signed in: no start choice', await noStart());
const keysBeforeAccount = (await idbState()).records?.length ?? 0;
t.ok('the account publishes', (await click(byText('PUBLISH'))) && await published());
const acctId = feedIdOf(await js(`document.querySelector('#feed-address')?.value ?? ''`));
madeIds.push(acctId);
t.equal('...under the ACCOUNT\'s key', (await (await api(`/api/community-playlists/${acctId}`)).json()).playlist?.ownerPubkey, pk);
t.equal('...and it made no guest key', (await idbState()).records?.length ?? 0, keysBeforeAccount);
t.ok('...and the published view has no "made without an account" note', await js(`!document.querySelector('[data-testid=guest-kept]')`));

// Signed in, a guest-made playlist of THIS browser is still editable, with the guest key.
const guestNow = (await idbState()).records?.[0]?.pubkey;
await newIp();
await go(`/playlists/make?id=${newId}`);
const opened = await waitFor(`document.querySelector('#pl-title')?.value.startsWith('e2e guest playlist after')`, 30000);
t.ok('signed in, a guest-made playlist of this browser opens for editing', opened, `${await js(`document.querySelector('main')?.innerText.slice(0, 160)`)} | idb ${JSON.stringify((await idbState()).records?.map((r) => r.pubkey.slice(0, 8)))} want ${newPub.slice(0, 8)}`);
if (!opened) { t.fail('stopping: the account step cannot go on'); console.log(`${t.count - t.fails}/${t.count} passed`); relay.close(); await exit(1); }
t.ok('...and says it was made without an account', await js(`/only this browser can change this playlist|made without an account/i.test(document.querySelector('main')?.innerText ?? '')`));
await setValue('#pl-title', 'e2e guest playlist after losing the key v2');
await wait(300);
t.ok('SAVE (signed with the guest key, while signed in as an account)', (await click(byText('SAVE'))) && await waitFor(`document.querySelector('[data-testid=published]')?.innerText.includes('v2')`, 40000));
const afterAcct = (await (await api(`/api/community-playlists/${newId}`)).json()).playlist;
t.ok('the server kept the guest key as the owner', afterAcct?.ownerPubkey === guestNow && afterAcct?.title.endsWith('v2'));

// ── the key is still nowhere, after all of that ──────────────────────────────
const secret2 = secretForPubkey(guestNow);
t.ok('the second key was recovered too', !!secret2);
if (secret2) t.equal('the second key is in none of the places either', await whereIsIt(secret2), []);
const accountSecretHex = Buffer.from(sk).toString('hex');
t.ok('control: the account\'s own key is not in the page either (the fake signer holds it outside)', !(await pageText()).includes(accountSecretHex));

// ── clean up what this run made, through the guest and account routes ────────
console.log(`${t.count - t.fails}/${t.count} passed`);
relay.close();
await exit(t.fails ? 1 : 0);
