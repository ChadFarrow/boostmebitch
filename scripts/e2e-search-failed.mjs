// Drives the home page's search box against a `/api/search` this script answers,
// in a real browser, and asserts that a search that got NO ANSWER never reads as
// an empty result.
//
// THE BUG (full-code review 2026-11-19, components/search-bar.tsx:251). The box
// parsed every response body as results. A 429 — our per-IP limit, or Podcast
// Index's passed through — answers `{ error }`, which has no `feeds`, so it became
// `[]`, and the panel printed "no results yet — try another phrase" over a query
// that was never looked up. A fetch that threw did the same from its `catch`.
//
// WHAT IT PINS:
//   1. A 429: "Search is busy right now…", the count line says "no answer", and
//      no "no results" sentence.
//   2. ↻ try again, now answered: the result row is listed.
//   3. A 500: "Search didn't answer…".
//   4. A dropped connection (CDP `Fetch.failRequest`): the same.
//   5. Under MUSIC, a 429: the busy line, never "No albums match".
//   6. Under phone emulation (390×844): case 1, no sideways overflow, and the
//      try-again chip at least 24×24 (WCAG 2.5.8).
//
// NOTHING LEAVES THE MACHINE. Every `/api/search` request is answered by CDP
// interception, Chrome resolves no host but the app's and loopback, and nobody
// signs in.
//
//   npm run build && npm run start          (or any server on BMB_APP)
//   BMB_APP=http://localhost:3000 npm run e2e:searchfailed

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.BMB_APP ?? process.env.E2E_APP ?? 'http://localhost:3000';
const QUERY = 'bowl after bowl';
const BUSY = 'Search is busy right now';
const NO_ANSWER = 'Search didn’t answer';
const NO_RESULTS = /no results yet|No albums match/;

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

const { page } = await launchChrome({
  name: 'search-failed',
  args: ['--disable-gpu', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ${new URL(APP).hostname}`],
});
const { send, js, until, on } = page;
await send('Page.enable');
await send('Runtime.enable');

// How the next /api/search is answered: 'busy' (429), 'error' (500), 'drop', or 'ok'.
let mode = 'busy';
const asked = [];
const RESULT = {
  id: 920000001, podcastGuid: '11111111-2222-3333-4444-555555555555', title: 'E2E Result Show',
  url: 'https://example.invalid/e2e-feed.xml', author: 'E2E', image: '', artwork: '', medium: 'podcast',
};
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/search*', requestStage: 'Request' }] });
on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const u = new URL(m.params.request.url);
  asked.push({ q: u.searchParams.get('q'), type: u.searchParams.get('type'), mode });
  const json = (status, body) => send('Fetch.fulfillRequest', {
    requestId: m.params.requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  });
  if (mode === 'drop') return send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionReset' });
  if (mode === 'busy') return json(429, { error: 'Too many requests' });
  if (mode === 'error') return json(500, { error: 'Search failed' });
  return json(200, { feeds: [RESULT], type: u.searchParams.get('type') ?? 'all', total: 1 });
});

const text = () => js('document.body.innerText');
const INPUT = `document.querySelector('input.input[enterkeyhint="search"]')`;
async function search(q) {
  await js(`(() => { const i = ${INPUT}; i.focus(); i.select(); return 1; })()`);
  await send('Input.insertText', { text: q });
}
async function clearBox() {
  await js(`(() => { const i = ${INPUT}; i.focus(); i.select(); return 1; })()`);
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  }
  await wait(400);
}
const chip = `[...document.querySelectorAll('button')].find((b) => /try again/i.test(b.textContent ?? ''))`;
async function load() {
  await send('Page.navigate', { url: `${APP}/` });
  await until(`document.readyState === 'complete'`, 30000);
  await until(`!!${INPUT}`, 20000);
}

// ------------------------------------------------------------------------------------
section('1. A 429');
await load();
mode = 'busy';
await search(QUERY);
t.ok('the busy line shows', await until(`document.body.innerText.includes(${JSON.stringify(BUSY)})`, 10000), (await text()).slice(0, 400));
t.ok('the search was asked once, for the query typed', asked.length === 1 && asked[0].q === QUERY, JSON.stringify(asked));
t.ok('no "no results" sentence', !NO_RESULTS.test(await text()));
t.ok('the count line says "no answer"', /no answer/i.test(await text()));
t.ok('↻ try again is offered', await js(`!!${chip}`));

// ------------------------------------------------------------------------------------
section('2. ↻ try again, now answered');
mode = 'ok';
await js(`${chip}?.click()`);
t.ok('the result is listed', await until(`document.body.innerText.includes('E2E Result Show')`, 10000), (await text()).slice(0, 400));
t.ok('...the search was asked again', asked.length === 2 && asked[1].mode === 'ok', JSON.stringify(asked));
t.ok('...and the busy line is gone', !(await text()).includes(BUSY));

// ------------------------------------------------------------------------------------
section('3. A 500');
await clearBox();
mode = 'error';
await search('e2e five hundred');
t.ok('the no-answer line shows', await until(`document.body.innerText.includes(${JSON.stringify(NO_ANSWER)})`, 10000), (await text()).slice(0, 400));
t.ok('no "no results" sentence', !NO_RESULTS.test(await text()));

// ------------------------------------------------------------------------------------
section('4. A dropped connection');
await clearBox();
mode = 'drop';
await search('e2e dropped');
t.ok('the no-answer line shows', await until(`document.body.innerText.includes(${JSON.stringify(NO_ANSWER)})`, 10000), (await text()).slice(0, 400));
t.ok('no "no results" sentence', !NO_RESULTS.test(await text()));

// ------------------------------------------------------------------------------------
section('5. Under MUSIC, a 429');
await clearBox();
mode = 'ok';
await js(`document.querySelector('button[aria-haspopup="menu"][aria-label^="Search type"]')?.click()`);
await until(`[...document.querySelectorAll('[role="menuitemradio"]')].some((b) => /music/i.test(b.textContent ?? ''))`, 5000);
await js(`[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => /music/i.test(b.textContent ?? ''))?.click()`);
t.ok('MUSIC is the search type', await until(`/MUSIC/.test(document.querySelector('button[aria-haspopup="menu"][aria-label^="Search type"]')?.getAttribute('aria-label') ?? '')`, 5000));
mode = 'busy';
await search('e2e music busy');
t.ok('the busy line shows', await until(`document.body.innerText.includes(${JSON.stringify(BUSY)})`, 10000), (await text()).slice(0, 400));
t.ok('never "No albums match"', !/No albums match/.test(await text()));
t.ok('the request was a MUSIC search', asked.at(-1)?.type === 'music', JSON.stringify(asked.at(-1)));

// ------------------------------------------------------------------------------------
section('6. Phone emulation (390×844): case 1');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
await load();
mode = 'busy';
await search(QUERY);
t.ok('the busy line shows', await until(`document.body.innerText.includes(${JSON.stringify(BUSY)})`, 10000));
const m = await js(`(() => {
  const b = ${chip}?.getBoundingClientRect();
  return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, chip: b ? [Math.round(b.width), Math.round(b.height)] : null };
})()`);
t.ok('the page does not overflow sideways', m.overflow <= 0, JSON.stringify(m));
t.ok('↻ try again is at least 24×24', m.chip && m.chip[0] >= 24 && m.chip[1] >= 24, JSON.stringify(m));
await send('Emulation.clearDeviceMetricsOverride');

console.log(`\n${t.count} checks, ${t.fails} failed`);
if (t.fails === 0) console.log('all end-to-end checks passed — nothing left this machine');
await exit(t.fails ? 1 : 0);
