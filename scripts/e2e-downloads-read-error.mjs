// A FAILED read of the downloads library, driven in a real browser: `/downloads`
// with a record really on disk, while `indexedDB.open` is made to throw.
//
// THE BUG (full-code review 2026-11-19, lib/downloads/download-manager.ts:136).
// `hydrate()` caught a failed IndexedDB read and called the library hydrated and
// EMPTY, for the life of the tab: `/downloads` said "Nothing downloaded yet" over
// downloads that were on the device, the player streamed what it had stored, and
// nothing read the library again until a reload.
//
// WHAT IT PINS:
//   1. Every open throws: "Couldn't read your downloads", the storage line and
//      ↻ TRY AGAIN; never "Nothing downloaded yet"; no DELETE ALL.
//   2. Opens work again, ↻ TRY AGAIN pressed: the stored download is listed.
//   3. Only the FIRST open throws: the download is listed by itself, with no
//      press (the timed retry, 2 s after the failure).
//   4. Phone emulation (390×844): case 1, no sideways overflow, and ↻ TRY AGAIN
//      at least 24×24.
//
// The record is written through the browser's own IndexedDB API under the
// app's database and store names, as `e2e-downloads` does. Chrome resolves no
// host but the app's and loopback; nothing is downloaded, played or published.
//
//   npm run build && npm run start          (or any server on APP_URL)
//   APP_URL=http://127.0.0.1:3000 npm run e2e:downloadsread

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? process.env.BMB_APP ?? 'http://127.0.0.1:3000';
const TITLE = 'E2E Downloaded Episode';
const NOTHING = 'Nothing downloaded yet';
const COULDNT = 'Couldn’t read your downloads';

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

const { page } = await launchChrome({
  name: 'downloads-read-error',
  args: ['--disable-gpu', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ${new URL(APP).hostname}`],
});
const { send, js, until } = page;
await send('Page.enable');
await send('Runtime.enable');
// `localStorage['e2e:idb_fail']` = how many more `indexedDB.open` calls throw.
// Read on every call, so the script can change it while the page runs.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    const real = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      const left = Number(localStorage.getItem('e2e:idb_fail') || 0);
      if (left > 0) {
        localStorage.setItem('e2e:idb_fail', String(left - 1));
        throw new DOMException('e2e: open refused', 'UnknownError');
      }
      return real(...args);
    };
  })();
` });

const text = () => js('document.body.innerText');
const tryAgain = `[...document.querySelectorAll('button')].find((b) => /TRY AGAIN/.test(b.textContent ?? ''))`;
const setFails = (n) => js(`(localStorage.setItem('e2e:idb_fail', '${n}'), true)`);
async function openDownloads() {
  await send('Page.navigate', { url: `${APP}/downloads` });
  await until(`document.readyState === 'complete'`, 30000);
}
const settled = () => until(`(() => { const s = document.body.innerText; return !s.includes('Reading your downloads'); })()`, 15000);

// --- One download really on disk ------------------------------------------------
await openDownloads();
await setFails(0);
await until(`document.body.innerText.includes(${JSON.stringify(NOTHING)})`, 15000);
const seeded = await js(`new Promise((resolve) => {
  const req = indexedDB.open('BmbDownloadsDB');
  req.onerror = () => resolve('open failed');
  req.onsuccess = () => {
    const tx = req.result.transaction('downloads', 'readwrite');
    tx.objectStore('downloads').put({
      key: 'e2e-read-error-1', enclosureUrl: 'https://example.invalid/e2e.mp3', sizeBytes: 1234567,
      createdAt: Date.now(), title: ${JSON.stringify(TITLE)}, feedTitle: 'E2E Show',
      itemGuid: 'e2e-item-1', feedGuid: 'e2e-feed-1', feedMedium: 'podcast',
    });
    tx.oncomplete = () => { req.result.close(); resolve('ok'); };
    tx.onerror = () => resolve('put failed');
  };
})`);
t.equal('a download record is on disk', seeded, 'ok');

// ------------------------------------------------------------------------------------
section('1. Every open throws');
await setFails(1000);
await openDownloads();
t.ok('the page settled', await settled(), (await text()).slice(0, 300));
t.ok(`it never says "${NOTHING}"`, !(await text()).includes(NOTHING), (await text()).slice(0, 400));
t.ok('it says it could not read the downloads', (await text()).includes(COULDNT), (await text()).slice(0, 400));
t.ok('...and that they are not deleted', (await text()).includes('They are not deleted'));
t.ok('↻ TRY AGAIN is offered', await js(`!!${tryAgain}`));
t.ok('DELETE ALL is not offered', !/DELETE ALL/.test(await text()));

// ------------------------------------------------------------------------------------
section('2. Opens work again, and ↻ TRY AGAIN is pressed');
await setFails(0);
await js(`${tryAgain}?.click()`);
t.ok('the stored download is listed', await until(`document.body.innerText.includes(${JSON.stringify(TITLE)})`, 10000), (await text()).slice(0, 400));
t.ok('...and the error line is gone', !(await text()).includes(COULDNT) && !(await js(`!!${tryAgain}`)));

// ------------------------------------------------------------------------------------
section('3. Only the first open throws');
await setFails(1);
await openDownloads();
t.ok('the page settled', await settled());
const firstSeen = (await text()).includes(COULDNT);
t.ok('the stored download is listed with no press', await until(`document.body.innerText.includes(${JSON.stringify(TITLE)})`, 8000), (await text()).slice(0, 400));
console.log(`  (the failure showed first: ${firstSeen})`);

// ------------------------------------------------------------------------------------
section('4. Phone emulation (390×844): case 1');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await setFails(1000);
await openDownloads();
t.ok('the page settled', await settled());
t.ok('it says it could not read the downloads', (await text()).includes(COULDNT));
await wait(300);
const m = await js(`(() => {
  const b = ${tryAgain}?.getBoundingClientRect();
  return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, retry: b ? [Math.round(b.width), Math.round(b.height)] : null };
})()`);
t.ok('the page does not overflow sideways', m.overflow <= 0, JSON.stringify(m));
t.ok('↻ TRY AGAIN is at least 24×24', m.retry && m.retry[0] >= 24 && m.retry[1] >= 24, JSON.stringify(m));
await send('Emulation.clearDeviceMetricsOverride');
await setFails(0);

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
