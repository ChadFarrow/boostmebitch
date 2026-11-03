// Drives the RSS-only payee path in a real browser, against a real playlist.
//
// WHY THIS IS AN E2E AND NOT ONLY A `check:*`. `feedItemValue`, `valueNotRead`,
// `boostGate` and `withoutStoredValue` are pinned by `npm run check:musicl`. All
// that this script asserts is WIRING no pure function can see: that a playlist page
// asks no feed until somebody acts, that the press reads the row's own feed and
// then opens the modal on the answer, that a play writes the answer where BOOST
// reads it, and that a payee stored on disk cannot reach the modal.
//
// `/api/item-value` is REAL unless a section says otherwise. The two answers a live
// feed cannot be made to give on demand (a feed naming nobody, and a feed that did
// not answer) are stubbed on the wire, so the client code under test is the same.
//
// No wallet is connected, so the modal can only open: nothing can be paid.
//
//   npm run build && npm run start        then, in a second shell:
//   npm run e2e:rsspay

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = 'http://localhost:3000';
const PLAYLIST = 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/refs/heads/main/docs/HGH-music-playlist.xml';
const STALE = 'STALE PAYEE FROM DISK';
const BOOST_ROW = 'button[aria-label="Boost this track"]';

await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run build && npm run start\`.`);
const t = checker();
const section = (s) => console.log(`\n${s}`);

const { page } = await launchChrome({ name: 'rss-payment', autoplay: true, args: ['--disable-gpu'] });
const { send, js, on } = page;

// Every /api/item-value request, and what to do with it. `null` lets it through.
const asked = [];
let stub = null;
// While set, a request waits in `held` until the test lets it through.
let hold = false;
const held = [];
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/item-value*', requestStage: 'Request' }] });
on(async (m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  asked.push(new URL(request.url).search);
  if (hold) { held.push(requestId); return; }
  if (!stub) { await send('Fetch.continueRequest', { requestId }); return; }
  await send('Fetch.fulfillRequest', {
    requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(stub)).toString('base64'),
  });
});

const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await js(`(${fn})()`);
    if (v) return v;
    await wait(250);
  }
  return null;
};
const rowBoosts = () => js(`document.querySelectorAll('${BOOST_ROW}').length`);
const pressRowBoost = (n) => js(`(() => {
  const li = [...document.querySelectorAll('ul.divide-y > li')].filter((r) => r.querySelector('button.btn-bolt'))[${n}];
  li.querySelector('button.btn-bolt').click();
  // The row's first text line is its ▶, so the title is the first line after it.
  return li.innerText.split('\\n').find((l) => l.trim() && l.trim() !== '▶');
})()`);
const dialog = () => until(`() => { const d = document.querySelector('[role="dialog"]'); return d ? d.innerText : null; }`, 20000);
// The modal lists its recipients only once it has an amount to split.
const dialogRecipients = async () => {
  if (!(await dialog())) return null;
  await js(`(() => {
    const i = document.querySelector('[role="dialog"] input[inputmode="numeric"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '1000');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  return until(`() => { const d = document.querySelector('[role="dialog"]'); return d && d.innerText.includes('RECIPIENTS') ? d.innerText : null; }`, 8000);
};
const closeDialog = async () => {
  await js(`document.querySelector('[role="dialog"] button[aria-label^="Close"]')?.click()`);
  await until(`() => !document.querySelector('[role="dialog"]')`, 5000);
};
const realAnswer = (search) => fetch(`${APP}/api/item-value${search}`).then((r) => r.json());
const names = (a) => (a.value?.recipients ?? []).map((r) => r.name).filter(Boolean);

await send('Page.enable');

section('1. A playlist page asks no feed until somebody acts');
await send('Page.navigate', { url: `${APP}/?playlist=${encodeURIComponent(PLAYLIST)}` });
const shown = await until(`() => document.querySelectorAll('${BOOST_ROW}').length`, 60000);
t.ok('the rows offer BOOST with no payee on them', shown >= 5, `saw ${shown}`);
t.equal('and no row asked its feed on the way in', asked.length, 0);

section('2. The press reads the row\'s own feed, then opens the modal on the answer');
{
  const title = await pressRowBoost(0);
  const text = await dialogRecipients();
  t.ok('the modal opened and lists its recipients', !!text, title);
  t.equal('exactly one read', asked.length, 1);
  const answer = await realAnswer(asked[0]);
  t.ok('the feed named a payee', answer.read && names(answer).length > 0, JSON.stringify(answer).slice(0, 160));
  for (const n of names(answer).slice(0, 3)) {
    t.ok(`the modal names "${n}", from the feed`, text?.includes(n));
  }
  await closeDialog();
  await pressRowBoost(0);
  await dialog();
  t.equal('a second press of the same row does not ask again', asked.length, 1);
  await closeDialog();
}

section('3. A feed that names nobody: no modal, and the row says so');
{
  stub = { read: true, value: null, valueTimeSplits: [] };
  const before = await rowBoosts();
  await pressRowBoost(1);
  const said = await until(`() => [...document.querySelectorAll('[role="status"]')].some((s) => s.textContent.includes('No value block'))`, 10000);
  t.ok('the row says "No value block"', !!said);
  t.equal('no modal opened', await js(`!!document.querySelector('[role="dialog"]')`), false);
  t.equal('that row no longer offers BOOST', await rowBoosts(), before - 1);
}

section('4. A feed that did not answer: the row says that, and a press asks again');
{
  stub = { read: false };
  const n = asked.length;
  await pressRowBoost(1);
  const label = await until(`() => { const b = document.querySelector('button[aria-label^="Could not read"]'); return b ? b.getAttribute('aria-label') : null; }`, 10000);
  t.ok('BOOST stays, and says it could not read the feed', !!label);
  t.equal('no modal opened', await js(`!!document.querySelector('[role="dialog"]')`), false);
  stub = null;
  await js(`document.querySelector('button[aria-label^="Could not read"]').click()`);
  t.ok('the next press reaches the feed and opens the modal', !!(await dialog()));
  t.equal('two reads for two presses', asked.length, n + 2);
  await closeDialog();
}

section('5. A play writes the answer where BOOST reads it');
{
  const n = asked.length;
  await js(`(() => {
    const li = [...document.querySelectorAll('ul.divide-y > li')].filter((r) => r.querySelector('button.btn-bolt'))[3];
    li.querySelector('button').click();
  })()`);
  const open = await until(`() => document.querySelector('[aria-label="Send a boost"]') ? true : null`, 30000);
  t.ok('the player\'s BOOST opens once the feed answers', !!open);
  t.ok('the play read the feed', asked.length > n, `${n} then ${asked.length}`);
}

section('6. A feed that did not answer on play: BOOST says so, not "no value block"');
{
  stub = { read: false };
  await js(`(() => {
    const li = [...document.querySelectorAll('ul.divide-y > li')].filter((r) => r.querySelector('button.btn-bolt'))[4];
    li.querySelector('button').click();
  })()`);
  const label = await until(`() => { const b = document.querySelector('[aria-label^="Could not read the value block for this episode"]'); return b ? b.getAttribute('aria-label') : null; }`, 20000);
  t.ok('the player\'s BOOST names the failed read', !!label);
  stub = null;
}

section('7. A payee on disk cannot reach the modal');
{
  // A real row, with a block on it that no feed names, written the way an older
  // build wrote the queue.
  const seeded = await js(`(async () => {
    const r = await fetch(${JSON.stringify(`/api/playlist?url=${encodeURIComponent(PLAYLIST)}&limit=10`)}).then((x) => x.json());
    const e = r.episodes.filter((x) => x.podcastGuid && x.guid && x.enclosureUrl)[6];
    const stale = { type: 'lightning', method: 'keysend', recipients: [{ name: ${JSON.stringify(STALE)}, type: 'node', address: '03aaa', split: 100 }] };
    localStorage.setItem('bmb:listen_queue:guest', JSON.stringify([{
      episode: { ...e, value: stale },
      podcast: { id: e.feedId, podcastGuid: e.podcastGuid, title: 'Seeded', value: stale },
    }]));
    return e.title;
  })()`);
  t.ok('the queue holds a stale block on disk', !!seeded);
  const n = asked.length;
  await send('Page.navigate', { url: `${APP}/listen` });
  const row = await until(`() => { const b = [...document.querySelectorAll('li button')].find((x) => x.textContent.includes(${JSON.stringify(seeded)})); return b ? (b.click(), true) : null; }`, 30000);
  t.ok('the queued row plays', !!row);
  const open = await until(`() => { const b = document.querySelector('[aria-label="Send a boost"]'); return b ? (b.click(), true) : null; }`, 30000);
  t.ok('the player\'s BOOST opens on what the feed said', !!open);
  t.ok('the play read the feed', asked.length > n);
  const text = await dialogRecipients();
  t.ok('the modal opened and lists its recipients', !!text);
  t.equal('the block from disk is nowhere in it', text?.includes(STALE), false);
  const answer = await realAnswer(asked[asked.length - 1]);
  for (const n of names(answer).slice(0, 3)) {
    t.ok(`the modal names "${n}", from the feed`, text?.includes(n));
  }
}

section('8. The episode last in the player comes back with no payee');
{
  // `revealNowPlaying` puts it back, paused, on the next load, and it is the one
  // stored copy that goes straight into `current`.
  const seeded = await js(`(async () => {
    const r = await fetch(${JSON.stringify(`/api/playlist?url=${encodeURIComponent(PLAYLIST)}&limit=10`)}).then((x) => x.json());
    // A row whose feed names a payee. Some album feeds on this list are gone.
    let e = null;
    for (const x of r.episodes.filter((y) => y.podcastGuid && y.guid && y.enclosureUrl)) {
      const a = await fetch('/api/item-value?feedGuid=' + encodeURIComponent(x.podcastGuid) + '&itemGuid=' + encodeURIComponent(x.guid)).then((y) => y.json());
      if (a.read && a.value?.recipients?.length) { e = x; break; }
    }
    const stale = { type: 'lightning', method: 'keysend', recipients: [{ name: ${JSON.stringify(STALE)}, type: 'node', address: '03aaa', split: 100 }] };
    localStorage.removeItem('bmb:listen_queue:guest');
    const item = {
      episode: { ...e, value: stale },
      podcast: { id: e.feedId, podcastGuid: e.podcastGuid, title: 'Seeded', value: stale },
    };
    // A pagehide flush must not overwrite the seed, so it goes in on the way out too.
    addEventListener('pagehide', () => localStorage.setItem('bmb:now_playing', JSON.stringify(item)));
    localStorage.setItem('bmb:now_playing', JSON.stringify(item));
    return e.title;
  })()`);
  t.ok('the last-played copy holds a stale block on disk', !!seeded);
  await send('Page.navigate', { url: `${APP}/` });
  const back = await until(`() => { const m = document.querySelector('[data-mini-player]'); return m && m.innerText.includes(${JSON.stringify(seeded)}) ? true : null; }`, 30000);
  t.ok('the player came back on that episode', !!back);
  const open = await until(`() => { const b = document.querySelector('[aria-label="Send a boost"]'); return b ? (b.click(), true) : null; }`, 30000);
  t.ok('its BOOST opens', !!open);
  const text = await dialogRecipients();
  t.ok('the modal opened and lists its recipients', !!text);
  t.equal('the block from disk is nowhere in it', text?.includes(STALE), false);
}

section('9. A slow answer cannot swap the payee under an open modal');
{
  await send('Page.navigate', { url: `${APP}/?playlist=${encodeURIComponent(PLAYLIST)}` });
  await until(`() => document.querySelectorAll('${BOOST_ROW}').length >= 3`, 60000);
  // Rows nothing has pressed in this page load: a read one would open at once.
  hold = true;
  const first = await pressRowBoost(0);
  await until(`() => true`, 500);
  for (let i = 0; i < 40 && !held.length; i++) await wait(100);
  t.equal('the first press is waiting on its feed', held.length, 1);
  hold = false;
  const second = await pressRowBoost(1);
  const opened = await dialog();
  t.ok('the second press opened its own modal', opened?.includes(second), `${second} / ${opened?.slice(0, 80)}`);
  await send('Fetch.continueRequest', { requestId: held.shift() });
  await wait(2500);
  const after = await js(`document.querySelector('[role="dialog"]')?.innerText ?? ''`);
  t.ok('the slow answer left that modal on the second row', after.includes(second), after.slice(0, 80));
  if (first !== second) t.equal('and it did not move to the first row', after.includes(first), false);
  await closeDialog();
}

console.log(`\n${t.fails ? `${t.fails} of ${t.count} checks FAILED.` : `All ${t.count} checks passed.`}`);
await exit(t.fails ? 1 : 0);
