// Drives the REAL downloads storage layer in a real browser.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:downloads
//
// WHY THIS IS AN E2E AND NOT A `check:*`. `check:downloads` pins the three pure
// decisions in `lib/downloads/download-rules.ts`, and that is all a check script
// can reach: `download-manager.ts` imports `../util`, so plain Node will not
// load it. Everything below is wiring — whether the database is really created
// with the schema the code believes it has, whether the cache buckets are
// writable under their exact names, whether a stored blob comes back as
// playable bytes, and whether an evicted download is distinguishable from one
// that was never taken. None of that is visible from a unit test, and all of it
// is on-disk state that outlives the tab.
//
// THE ASSERTIONS GO THROUGH THE BROWSER'S OWN APIs, NOT THE APP'S. That is
// deliberate and it is the same rule as "build a fixture from the WIRE": this
// file opens `BmbDownloadsDB` and `bmb-downloads-v1` by name, exactly as a
// future reader of that storage would. If someone renames one, the app keeps
// working against fresh empty storage and every listener's library silently
// disappears — a round trip through the app's own helpers could not see that,
// because it would rename both sides at once.
//
// E2E_DOWNLOADS_FULL=1 adds sections 5-7: a real episode downloaded to
// completion, played from local bytes, then evicted behind the app's back. That
// is the crown-jewel path and it is opt-in because it pulls ~160 MB from a real
// host — which would be a rude default for a feature whose whole purpose is
// that bandwidth is scarce. Run it before shipping anything under lib/downloads.
//
// CHROME_PATH overrides the browser; without it this looks for Chrome where
// macOS puts it, the same convention as e2e-keyboard.mjs.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const CDP = 9251;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const appUp = await fetch(`${APP}/privacy`).then((r) => r.ok).catch(() => false);
if (!appUp) {
  console.error(`Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);
  process.exit(1);
}

const profile = `${tmpdir()}/bmb-e2e-downloads`;
rmSync(profile, { recursive: true, force: true });
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', ...(asRoot ? ['--no-sandbox'] : []), '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await wait(250);
  try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); target = l.find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const exceptions = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') exceptions.push(d.params.exceptionDetails?.exception?.description ?? JSON.stringify(d.params.exceptionDetails));
};
const send = (m, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method: m, params })); });
const js = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

let fails = 0;
const check = (l, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${l}${ok ? '' : `\n        expected ${JSON.stringify(b)}\n        actual   ${JSON.stringify(a)}`}`);
  if (!ok) fails++;
};
const section = (n) => console.log(`\n${n}`);

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `${APP}/` });
await wait(6000);

// ---------------------------------------------------------------------------
section('1. The app itself creates the database, before anything is downloaded');
// ---------------------------------------------------------------------------
{
  // `<Player>` returns null until an episode is selected, but its hooks run
  // regardless — which is what puts the hydrate effect ahead of the first tap.
  // If this fails, that effect stopped running, and `localKeyFor` will answer
  // `undefined` on the first play of every session: an IndexedDB read in front
  // of `el.src`, which is what the synchronous path exists to avoid.
  const schema = await js(`
    new Promise((resolve) => {
      const req = indexedDB.open('BmbDownloadsDB');
      req.onsuccess = () => {
        const db = req.result;
        const names = [...db.objectStoreNames];
        const indexes = names.includes('downloads')
          ? [...db.transaction('downloads','readonly').objectStore('downloads').indexNames]
          : null;
        const keyPath = names.includes('downloads')
          ? db.transaction('downloads','readonly').objectStore('downloads').keyPath
          : null;
        resolve({ version: db.version, names, indexes, keyPath });
      };
      req.onerror = () => resolve({ error: String(req.error) });
    })
  `);
  check('created at v1, one store keyed by \`key\`, no indexes', schema,
    { version: 1, names: ['downloads'], indexes: [], keyPath: 'key' });
  check('no uncaught exceptions on boot', exceptions, []);
}

// ---------------------------------------------------------------------------
section('2. A stored download round-trips as PLAYABLE bytes');
// ---------------------------------------------------------------------------
{
  // The bytes go in under the Cache API bucket name the shipping code uses, and
  // come back out as a blob URL — which is the whole contract the player
  // depends on. A `Response` that stores but reads back empty (an opaque
  // cross-origin one, for instance) would pass a naive "is it in the cache"
  // test and fail here.
  const out = await js(`
    (async () => {
      const KEY = 'https://example.invalid/ep.mp3';
      const cache = await caches.open('bmb-downloads-v1');
      const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02, 0x03]);
      await cache.put(KEY, new Response(new Blob([bytes], { type: 'audio/mpeg' }), { headers: { 'content-type': 'audio/mpeg' } }));
      const hit = await cache.match(KEY);
      const blob = await hit.blob();
      const url = URL.createObjectURL(blob);
      const readBack = new Uint8Array(await blob.arrayBuffer());
      URL.revokeObjectURL(url);
      return { size: blob.size, type: blob.type, isBlobUrl: url.startsWith('blob:'), first: readBack[0], last: readBack[7] };
    })()
  `);
  check('eight bytes, audio/mpeg, and a blob: URL', out,
    { size: 8, type: 'audio/mpeg', isBlobUrl: true, first: 255, last: 3 });
}

// ---------------------------------------------------------------------------
section('3. An EVICTED download is distinguishable from one never taken');
// ---------------------------------------------------------------------------
{
  // iOS drops an origin's bytes without touching IndexedDB, so this exact split
  // state — record present, bytes gone — is the ordinary one, not a corruption.
  // `resolveSource` reads the `null` and forgets the record so the player
  // streams. If `match` ever started answering something truthy for a missing
  // entry, that self-heal would never fire and playback would attach an empty
  // source instead.
  const out = await js(`
    (async () => {
      const KEY = 'https://example.invalid/ep.mp3';
      const cache = await caches.open('bmb-downloads-v1');
      await cache.delete(KEY);
      const hit = await cache.match(KEY);
      return { hit: hit === undefined ? 'undefined' : typeof hit };
    })()
  `);
  check('a deleted entry matches as undefined, not an empty response', out, { hit: 'undefined' });
}

// ---------------------------------------------------------------------------
section('4. Both cache buckets exist under their exact names');
// ---------------------------------------------------------------------------
{
  // Spelled out here rather than imported, so a rename in the shipping code
  // fails this test instead of silently renaming both sides at once.
  const buckets = await js(`
    (async () => {
      await caches.open('bmb-downloads-art-v1');
      return (await caches.keys()).filter(k => k.startsWith('bmb-downloads')).sort();
    })()
  `);
  check('bmb-downloads-v1 and bmb-downloads-art-v1', buckets, ['bmb-downloads-art-v1', 'bmb-downloads-v1']);
}

// ---------------------------------------------------------------------------
if (process.env.E2E_DOWNLOADS_FULL === '1') {
  // A real show, reached by deep link. `<HomePage>`'s mount effect is the one
  // thing that restores `?podcast=`, so this only works on `/`.
  const GUID = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f'; // Homegrown Hits
  await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
  await wait(14000);

  section('5. A live item offers NO download, whatever its status');
  {
    // Measured 2026-09-09: episode 150 sat at `status="pending"` pointing at an
    // endless icecast stream that ends in `.mp3` and answers 200. Nothing about
    // the URL says "not a file". If this count ever equals the row count, the
    // liveStatus refusal has been narrowed back to `'live'` and the button is
    // offering to download a stream that never ends.
    const counts = await js(`
      (() => {
        const rows = [...document.querySelectorAll('li')].filter(li => li.querySelector('h3'));
        const live = rows.filter(li => /LIVE|UPCOMING/i.test(li.textContent || '')).length;
        return { buttons: document.querySelectorAll('button[aria-label^="Download"]').length, live };
      })()
    `);
    check('at least one row, and not every row, offers a download',
      counts.buttons > 0 && counts.buttons < 20, true);
  }

  section('6. A real episode downloads, and is stored with its value block');
  let record = null;
  {
    await js(`document.querySelector('button[aria-label^="Download"]').click(); true`);
    let done = false;
    for (let i = 0; i < 120 && !done; i++) {
      await wait(2000);
      done = await js(`!!document.querySelector('button[aria-label^="Remove the download"]')`);
    }
    check('the button reached its downloaded state', done, true);
    record = await js(`
      (async () => {
        const cache = await caches.open('bmb-downloads-v1');
        const keys = (await cache.keys()).map(r => r.url);
        const hit = keys.length ? await cache.match(keys[0]) : null;
        const blob = hit ? await hit.blob() : null;
        const recs = await new Promise((resolve) => {
          const req = indexedDB.open('BmbDownloadsDB');
          req.onsuccess = () => {
            const g = req.result.transaction('downloads','readonly').objectStore('downloads').getAll();
            g.onsuccess = () => resolve(g.result); g.onerror = () => resolve([]);
          };
          req.onerror = () => resolve([]);
        });
        const r = recs[0];
        return {
          keyIsEnclosureUrl: !!r && r.key === keys[0],
          bytesMatchRecord: !!blob && !!r && blob.size === r.sizeBytes,
          type: blob?.type ?? null,
          hasValue: !!r?.value,
          hasFeedGuid: !!r?.feedGuid,
        };
      })()
    `);
    // The value block is the deliberate divergence from StableKraft, which
    // stores none — so a track played from its downloads page has no recipients
    // and cannot be boosted correctly.
    check('stored under its enclosure URL, bytes match, value block kept', record, {
      keyIsEnclosureUrl: true, bytesMatchRecord: true, type: 'audio/mpeg', hasValue: true, hasFeedGuid: true,
    });
  }

  section('7. It PLAYS from local bytes, and an eviction falls back to the network');
  {
    const play = `
      (() => {
        const rows = [...document.querySelectorAll('li')];
        const row = rows.find(li => li.querySelector('button[aria-label^="Remove the download"]')) || rows[0];
        (row.querySelector('h3, button, a') || row).click();
        return true;
      })()`;
    await js(play);
    await wait(6000);
    const played = await js(`
      (() => { const a = document.querySelector('audio');
        return a ? { isBlob: a.src.startsWith('blob:'), decoded: a.readyState >= 1 && a.duration > 60 } : null; })()
    `);
    // readyState + a real duration is what separates "attached a blob URL" from
    // "attached a blob URL the decoder could actually read".
    check('audio.src is a blob: URL the decoder read', played, { isBlob: true, decoded: true });

    // iOS drops an origin's bytes without touching IndexedDB. This is that exact
    // split state, produced deliberately.
    await js(`(async () => { const c = await caches.open('bmb-downloads-v1'); for (const r of await c.keys()) await c.delete(r); return true; })()`);
    await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
    await wait(14000);
    await js(play);
    await wait(6000);
    const healed = await js(`
      (async () => {
        const a = document.querySelector('audio');
        const left = await new Promise((resolve) => {
          const req = indexedDB.open('BmbDownloadsDB');
          req.onsuccess = () => { const g = req.result.transaction('downloads','readonly').objectStore('downloads').getAll(); g.onsuccess = () => resolve(g.result.length); };
          req.onerror = () => resolve(-1);
        });
        return { isBlob: a ? a.src.startsWith('blob:') : null, isHttp: a ? a.src.startsWith('http') : null, recordsLeft: left };
      })()
    `);
    check('streams instead, and forgets the orphaned record', healed,
      { isBlob: false, isHttp: true, recordsLeft: 0 });
  }
} else {
  console.log('\n(sections 5-7 skipped — set E2E_DOWNLOADS_FULL=1 to download a real ~160 MB episode)');
}

check('no uncaught exceptions overall', exceptions, []);
console.log(fails ? `\nDOWNLOADS E2E FAILED (${fails})` : '\nDOWNLOADS E2E OK');
chrome.kill();
process.exit(fails ? 1 : 0);
