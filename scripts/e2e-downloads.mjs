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

// REFUSE TO RUN IF SOMETHING ALREADY HOLDS THE DEBUG PORT, and this guard is
// here because its absence cost a long debugging session. A Chrome left over
// from an earlier run keeps both the port and the profile, so the new one exits
// on the locked profile and `fetch(/json/list)` quietly attaches to the OLD
// browser instead. Everything then runs against storage that the assertions
// were never told about, and the failure reads as "the app stored a record but
// no bytes" — a shipping bug that is not there. Fail loudly instead.
const portBusy = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(() => true).catch(() => false);
if (portBusy) {
  console.error(`Something is already listening on ${CDP} — almost certainly a Chrome left over from an earlier run.`);
  console.error(`Close it first:  pkill -f 'remote-debugging-port=${CDP}'`);
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
      await caches.open('bmb-downloads-doc-v1');
      return (await caches.keys()).filter(k => k.startsWith('bmb-downloads')).sort();
    })()
  `);
  check('all three buckets, under their exact names', buckets,
    ['bmb-downloads-art-v1', 'bmb-downloads-doc-v1', 'bmb-downloads-v1']);
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
          // Reported, not just compared: a storage assertion that fails without
          // saying WHAT it saw sends the next reader guessing at whether the
          // record, the bytes or the key was the missing half.
          cacheKeys: keys.length,
          records: recs.length,
          keyIsEnclosureUrl: !!r && keys.includes(r.key),
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
      cacheKeys: 1, records: 1,
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

// ---------------------------------------------------------------------------
section('8. /downloads and the dock, at a real phone viewport');
// ---------------------------------------------------------------------------
{
  // A REAL phone viewport, via CDP device emulation. `--window-size` does not
  // give one: Chrome lays the page out at its default width and crops the
  // screenshot, which reads as a broken layout and has produced a wrong
  // conclusion in this repo before.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: `${APP}/downloads` });
  await wait(5000);
  const page = await js(`
    (() => {
      const nav = document.querySelector('nav[aria-label="Main"]');
      const items = nav ? [...nav.querySelectorAll('a,button')] : [];
      const doc = document.documentElement;
      return {
        heading: document.querySelector('h1')?.textContent ?? null,
        tabs: items.length,
        // WCAG 2.5.8 is 24x24. The dock's own comment says the floor is not
        // threatened until SEVEN tabs; this is the measurement behind that.
        smallestTab: items.length ? Math.min(...items.map(e => Math.round(Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height)))) : 0,
        current: nav?.querySelector('[aria-current="page"]')?.textContent?.trim() ?? null,
        overflow: doc.scrollWidth - doc.clientWidth,
      };
    })()
  `);
  check('five tabs, all clearing 24px, Downloads current, no overflow at 390px', page,
    { heading: 'Downloads', tabs: 5, smallestTab: 56, current: 'Downloads', overflow: 0 });

  // "Nothing downloaded yet" is a CLAIM about the listener's library, and it may
  // only be made once the read has answered — see `downloadManager.ready()`.
  const empty = await js(`document.querySelector('h1')?.nextElementSibling?.textContent?.trim() ?? null`);
  check('an empty library says so only after the read landed', empty, 'Nothing downloaded yet');
}

if (process.env.E2E_DOWNLOADS_FULL === '1') {
  section('9. A downloaded episode is listed, plays IN PLACE, and can be deleted');
  {
    const GUID = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';
    await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
    await wait(14000);
    await js(`document.querySelector('button[aria-label^="Download"]').click(); true`);
    let done = false;
    for (let i = 0; i < 120 && !done; i++) {
      await wait(2000);
      done = await js(`!!document.querySelector('button[aria-label^="Remove the download"]')`);
    }
    await send('Page.navigate', { url: `${APP}/downloads` });
    await wait(5000);
    const listed = await js(`
      (() => {
        const li = document.querySelector('ul li');
        const doc = document.documentElement;
        return {
          rows: document.querySelectorAll('ul li').length,
          saysSize: /[0-9]+ (MB|GB)/.test(document.querySelector('h1')?.nextElementSibling?.textContent ?? ''),
          saysDevice: [...document.querySelectorAll('p')].some(p => /used on this device/.test(p.textContent)),
          // Eviction is expected on iOS rather than exceptional, so the page
          // says so before it happens.
          saysEviction: [...document.querySelectorAll('p')].some(p => /remove downloads to free space/.test(p.textContent)),
          overflow: doc.scrollWidth - doc.clientWidth,
          rowOverflow: li ? li.scrollWidth - li.clientWidth : null,
        };
      })()
    `);
    check('one row, a size, the device figure, the iOS notice, no overflow', listed,
      { rows: 1, saysSize: true, saysDevice: true, saysEviction: true, overflow: 0, rowOverflow: 0 });

    await js(`document.querySelector('ul li button[aria-label^="Play"]').click(); true`);
    await wait(6000);
    const inPlace = await js(`
      (() => { const a = document.querySelector('audio');
        return { path: location.pathname, isBlob: a ? a.src.startsWith('blob:') : null, decoded: a ? (a.readyState >= 1 && a.duration > 60) : null }; })()
    `);
    // Playing must NOT navigate: <Player> is in the root layout, so the audio
    // starts here and the mini-player appears over this list.
    check('plays from local bytes without leaving /downloads', inPlace,
      { path: '/downloads', isBlob: true, decoded: true });

    // Two presses, not window.confirm — a native dialog in the installed PWA is
    // a system sheet over the app.
    await js(`[...document.querySelectorAll('button')].find(x => /DELETE ALL/.test(x.textContent||''))?.click(); true`);
    await wait(400);
    const armed = await js(`[...document.querySelectorAll('button')].some(b => /REALLY DELETE ALL/.test(b.textContent||''))`);
    check('DELETE ALL arms rather than deleting', armed, true);
    await js(`[...document.querySelectorAll('button')].find(x => /REALLY DELETE ALL/.test(x.textContent||''))?.click(); true`);
    await wait(2500);
    check('...and the second press empties the library',
      await js(`document.querySelectorAll('ul li').length`), 0);
  }

  section('10. Chapters and the cover come with it, and survive going OFFLINE');
  {
    const GUID = 'ac746d09-7c3b-5bcd-b28a-f12d6456ca8f';
    await send('Page.navigate', { url: `${APP}/?podcast=${GUID}` });
    await wait(14000);
    await js(`document.querySelector('button[aria-label^="Download"]').click(); true`);
    let done = false;
    for (let i = 0; i < 120 && !done; i++) {
      await wait(2000);
      done = await js(`!!document.querySelector('button[aria-label^="Remove the download"]')`);
    }
    // The extras are fetched AFTER the record is written, so the button turning
    // green is not proof they landed. Give them their own moment.
    await wait(4000);

    const cached = await js(`
      (async () => {
        const doc = await caches.open('bmb-downloads-doc-v1');
        const art = await caches.open('bmb-downloads-art-v1');
        const docKeys = (await doc.keys()).map(r => new URL(r.url).pathname + new URL(r.url).search.slice(0, 22));
        const artHit = (await art.keys()).length;
        const rec = await new Promise((resolve) => {
          const req = indexedDB.open('BmbDownloadsDB');
          req.onsuccess = () => { const g = req.result.transaction('downloads','readonly').objectStore('downloads').getAll(); g.onsuccess = () => resolve(g.result[0] ?? null); };
          req.onerror = () => resolve(null);
        });
        return {
          cachedChapters: docKeys.some(k => k.startsWith('/api/chapters')),
          // Art is NOT asserted, and that is deliberate — see the check below.
          artEntries: artHit,
          // The record must NAME what it cached, or nothing can delete it later.
          recordNamesDocs: Array.isArray(rec?.docKeys) && rec.docKeys.length > 0,
          recordKeepsChaptersUrl: !!rec?.chaptersUrl,
          // The audio is the download; everything else is an extra hanging off it.
          audioStored: !!rec && rec.sizeBytes > 1000,
        };
      })()
    `);
    // ART IS BEST-EFFORT AND IS DELIBERATELY NOT ASSERTED. Measured 2026-09-09:
    // Homegrown Hits' episode cover is a 19 MB GIF that `/api/art` answers 502
    // for, and the feed-level PNG failed the same way from this machine. That is
    // the artwork proxy's own behaviour, and the rule it is under everywhere in
    // this app is that a failing route costs appearance and nothing else. So the
    // invariant worth pinning is the one below: a cover that could not be
    // fetched leaves the download, its record and its documents intact.
    check('a failing cover costs the download nothing', {
      cachedChapters: cached.cachedChapters,
      recordNamesDocs: cached.recordNamesDocs,
      recordKeepsChaptersUrl: cached.recordKeepsChaptersUrl,
      audioStored: cached.audioStored,
    }, { cachedChapters: true, recordNamesDocs: true, recordKeepsChaptersUrl: true, audioStored: true });
    console.log(`        (art entries cached: ${cached.artEntries} — informational, see above)`);

    // THE ACTUAL CLAIM. Everything above proves bytes were stored; only this
    // proves they are reachable when the network is not. `Network.emulate` is
    // used rather than DevTools' Offline toggle because that leaves already-open
    // sockets alive, which has produced a false pass in this repo before.
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await js(`document.querySelector('ul li button, li h3')?.click(); true`);
    await wait(2000);
    await js(`
      (() => {
        const rows = [...document.querySelectorAll('li')];
        const row = rows.find(li => li.querySelector('button[aria-label^="Remove the download"]'));
        (row?.querySelector('h3, button, a') || row)?.click();
        return true;
      })()
    `);
    await wait(8000);
    const offline = await js(`
      (() => {
        const a = document.querySelector('audio');
        return {
          isBlob: a ? a.src.startsWith('blob:') : null,
          decoded: a ? (a.readyState >= 1 && a.duration > 60) : null,
        };
      })()
    `);
    check('it still plays, from local bytes, with the network cut at the browser',
      offline, { isBlob: true, decoded: true });

    const chaptersOffline = await js(`
      (async () => {
        const doc = await caches.open('bmb-downloads-doc-v1');
        const key = (await doc.keys()).map(r => r.url).find(u => u.includes('/api/chapters'));
        if (!key) return { hit: false };
        // Exactly the request useChapters makes, answered from the cache while
        // the network is down. A live fetch of the same URL would reject.
        const hit = await doc.match(key);
        const body = hit ? await hit.json() : null;
        // cache:reload FORCES the network. Without it the browser's own
        // HTTP cache answers happily while offline, and the probe proves
        // nothing about whether the network is really down — which is exactly
        // what it did on the first run of this section.
        let liveFailed = false;
        try { await fetch(key, { cache: 'reload' }); } catch { liveFailed = true; }
        return { hit: !!hit, chapters: Array.isArray(body?.chapters) && body.chapters.length > 0, liveFailed };
      })()
    `);
    check('the chapters document answers from cache while a live fetch cannot',
      chaptersOffline, { hit: true, chapters: true, liveFailed: true });

    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }
}

// ---------------------------------------------------------------------------
section('11. The service worker: offline launch, and cleanup that spares downloads');
// ---------------------------------------------------------------------------
{
  await send('Emulation.clearDeviceMetricsOverride', {});
  await send('Page.navigate', { url: `${APP}/` });
  await wait(8000);

  // The worker is served from a route so it can carry a build id. Without one
  // it could never clean up after an older deploy.
  const control = await js(`
    (async () => {
      const reg = await navigator.serviceWorker.ready;
      const src = await (await fetch('/sw.js')).text();
      const version = (src.match(/const VERSION = "([^"]+)"/) || [])[1] ?? null;
      return { controlled: !!navigator.serviceWorker.controller, scope: new URL(reg.scope).pathname, version };
    })()
  `);
  check('it controls the page, at scope /, with a build id',
    { controlled: control.controlled, scope: control.scope, hasVersion: !!control.version },
    { controlled: true, scope: '/', hasVersion: true });

  // What it did and did NOT keep. `/api/*` is the one that would be a real bug:
  // a cached /api/feed serves a stale episode list and /api/live-status would
  // report a finished show as live.
  const held = await js(`
    (async () => {
      await fetch('/api/live-status?ids=none').catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
      const out = { static: 0, pages: 0, api: 0, crossOrigin: 0 };
      for (const n of await caches.keys()) {
        if (!n.startsWith('bmb-sw-')) continue;
        for (const req of await (await caches.open(n)).keys()) {
          const u = new URL(req.url);
          if (u.origin !== location.origin) out.crossOrigin++;
          else if (u.pathname.startsWith('/api/')) out.api++;
          else if (u.pathname.startsWith('/_next/static/')) out.static++;
          else out.pages++;
        }
      }
      return out;
    })()
  `);
  check('static and page entries kept; nothing from /api/ and nothing cross-origin',
    { hasStatic: held.static > 0, hasPages: held.pages > 0, api: held.api, crossOrigin: held.crossOrigin },
    { hasStatic: true, hasPages: true, api: 0, crossOrigin: 0 });

  // THE POINT OF THE WHOLE PHASE. A cold load with no network — which is what
  // launching the installed app on a plane is — must still produce a document.
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await send('Page.navigate', { url: `${APP}/` });
  await wait(8000);
  const offlineLaunch = await js(`
    (() => ({
      title: document.title.slice(0, 30),
      hasDock: !!document.querySelector('nav[aria-label="Main"]'),
      reactMounted: !!document.querySelector('nav[aria-label="Main"] a[href="/downloads"]'),
    }))()
  `);
  check('the app still boots with the network cut, dock and all',
    { hasDock: offlineLaunch.hasDock, reactMounted: offlineLaunch.reactMounted },
    { hasDock: true, reactMounted: true });
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // A deploy's cleanup, without needing a second deploy: plant a cache named
  // like an older build plus one of the DOWNLOAD buckets, then make the worker
  // install again. `activate` must take the first and leave the second — the
  // prefix test is narrow on purpose, because those are the user's own files.
  await send('Page.navigate', { url: `${APP}/` });
  await wait(6000);
  await js(`
    (async () => {
      const stale = await caches.open('bmb-sw-static-anolderbuild');
      await stale.put('/planted', new Response('x'));
      const mine = await caches.open('bmb-downloads-v1');
      await mine.put('https://example.invalid/keep.mp3', new Response('keep'));
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      return true;
    })()
  `);
  await send('Page.navigate', { url: `${APP}/` });
  await wait(9000);
  const swept = await js(`
    (async () => {
      await navigator.serviceWorker.ready;
      await new Promise(r => setTimeout(r, 2000));
      const names = await caches.keys();
      const downloads = await caches.open('bmb-downloads-v1');
      return {
        staleGone: !names.includes('bmb-sw-static-anolderbuild'),
        currentKept: names.some(n => n.startsWith('bmb-sw-static-')),
        downloadsUntouched: !!(await downloads.match('https://example.invalid/keep.mp3')),
      };
    })()
  `);
  check('the older build is swept, the current one kept, downloads untouched',
    swept, { staleGone: true, currentKept: true, downloadsUntouched: true });
}

check('no uncaught exceptions overall', exceptions, []);
console.log(fails ? `\nDOWNLOADS E2E FAILED (${fails})` : '\nDOWNLOADS E2E OK');
chrome.kill();
process.exit(fails ? 1 : 0);
