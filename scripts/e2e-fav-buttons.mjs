// End-to-end for the quick buttons on /favorites: ALBUMS, SINGLES, SHOWS, EPISODES.
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:favbuttons                        # headless
//   APP_URL=http://127.0.0.1:3019 npm run e2e:favbuttons -- --headed --keep
//
// WHAT IT PINS:
//
//   1. A press filters and lands: the view is stored, the other sections are gone
//      and the controls sit right under the pinned row, from any scroll position.
//   2. The bytes cap holds. Sixty revealed rows do not come back as sixty covers
//      when a button changes the list. See `useRevealed` in lists/grouping.tsx.
//   3. The row stays pinned under the header while a long list scrolls under it,
//      and the header does not cover it.
//   4. The button, the heading and the menu use one word and one count. A heading
//      counts its own medium: `ALBUMS — 60`, never `of` every feed in the library.
//   5. A folded section opens on a press. A press of the lit button goes back to all.
//   6. A medium with one half: no button for the absent half, the lit state still
//      works, and no empty heading for the absent half.
//   7. Nothing that is not a press changes the list: the favorites bytes in storage
//      are the same at the end, because these rows are what gets published.
//   8. No horizontal overflow at 320, 390 and 1280, and each button clears 24×24
//      with its whole word showing.
//
// Signed out on purpose: no key means no relay write can happen, and the buttons
// touch only `bmb:fav_view`, `bmb:fav_collapsed` and the page's scroll position.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, `Nothing is serving ${APP}. Start it with \`npm run dev\` in another terminal.`);

// ---- the fixture ----------------------------------------------------------
// `id: 0` and no `feedId`: "not resolved yet". With a real number here the new
// episodes panel asks Podcast Index about whichever feed holds that id, grows
// above the controls at a moment of its own, and moves the landing point.
const guid = (prefix, i) => `${prefix}-${String(i).padStart(4, '0')}-4000-8000-000000000000`;
const feeds = (prefix, medium, n) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => {
    const g = guid(prefix, i);
    return [g, {
      id: 0, podcastGuid: g, title: `${prefix} ${medium} ${i}`, author: 'e2e',
      url: `https://feeds.example.invalid/${g}.xml`, medium, addedAt: 1700000000000 + i,
    }];
  }),
);
const items = (prefix, medium, n) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => {
    const g = guid(prefix, i);
    return [g, {
      itemGuid: g, feedGuid: guid('parent', i), title: `${prefix} ${medium} ${i}`,
      podcastTitle: 'e2e parent', enclosureUrl: `https://cdn.example.invalid/${g}.mp3`,
      medium, addedAt: 1700000000000 + i,
    }];
  }),
);
const FULL_FEEDS = { ...feeds('album', 'music', 60), ...feeds('show', 'podcast', 5) };
const FULL_ITEMS = {
  ...items('single', 'music', 30),
  ...items('episode', 'podcast', 20),
  // A row with no medium: it keeps its own menu entry and gets no button.
  ...items('mystery', '', 2),
};

// ---- the page -------------------------------------------------------------
const { page } = await launchChrome({ name: 'favbuttons', args: ['--disable-gpu'] });
const { send, js, until } = page;
await send('Page.enable');
await send('Runtime.enable');
const pageErrors = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
  }
});

const t = checker();

const CONTROLS = `document.querySelector('[aria-label="Filter favorites"]').parentElement`;
const ROW = `document.querySelector('[role="group"][aria-label="Go to section"]')`;
const button = (word) =>
  `[...${ROW}.querySelectorAll('button')].find((b) => b.textContent.trim().toLowerCase() === ${JSON.stringify(word)})`;

async function open(feedsSeed, itemsSeed, view) {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  await js(`localStorage.clear();
    localStorage.setItem('bmb:favorites:guest', ${JSON.stringify(JSON.stringify(feedsSeed))});
    localStorage.setItem('bmb:favepisodes:guest', ${JSON.stringify(JSON.stringify(itemsSeed))});
    ${view ? `localStorage.setItem('bmb:fav_view', ${JSON.stringify(JSON.stringify(view))});` : ''}
  `);
  await send('Page.navigate', { url: `${APP}/favorites` });
  await until('document.readyState === "complete"');
  await until(`!!document.querySelector('[aria-label="Filter favorites"]')`);
  // `<FavoritesNewEpisodes>` grows 1.2 s after the library settles (docs/ui.md).
  await wait(1800);
}
const labels = () => js(`JSON.stringify([...(${ROW}?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim().toLowerCase()))`).then(JSON.parse);
const pressed = () => js(`JSON.stringify([...(${ROW}?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map((b) => b.textContent.trim().toLowerCase()))`).then(JSON.parse);
// The library's own headings. The new episodes panel is a <section> too.
const HEADINGS = `[...document.querySelectorAll('section > button[aria-expanded]')].filter((b) => !/^new episodes/i.test(b.textContent.trim()))`;
const headings = () => js(`JSON.stringify(${HEADINGS}.map((b) => b.querySelector('span').textContent.trim().toLowerCase()))`).then(JSON.parse);
const rowCount = () => js(`document.querySelectorAll('section ul > li').length`);
const stored = (key) => js(`localStorage.getItem(${JSON.stringify(key)})`);
const view = async () => { const v = JSON.parse(await stored('bmb:fav_view')); return `${v.tab}|${v.split}`; };
const press = async (word) => { await js(`${button(word)}.click()`); await wait(250); };
const top = (expr) => js(`Math.round(${expr}.getBoundingClientRect().top)`);
const trigger = () => js(`document.querySelector('[aria-label="Filter favorites"]').parentElement.querySelector('button').textContent.trim().toLowerCase()`);

async function measure(name, width, height = 844, mobile = true) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await wait(300);
  const m = JSON.parse(await js(`JSON.stringify({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    btns: [...${ROW}.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), clip: b.scrollWidth > b.clientWidth };
    }),
  })`));
  t.equal(`${name}: no horizontal overflow`, m.sw, m.cw);
  t.ok(`${name}: each button is at least 24×24`, m.btns.every((b) => b.w >= 24 && b.h >= 24), JSON.stringify(m.btns));
  t.ok(`${name}: no button clips its word`, m.btns.every((b) => !b.clip), JSON.stringify(m.btns));
  return m;
}

// ---------------------------------------------------------------------------
console.log('\n1. The row, at phone width');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await open(FULL_FEEDS, FULL_ITEMS);
const seededFeeds = await stored('bmb:favorites:guest');
const seededItems = await stored('bmb:favepisodes:guest');
t.equal('four buttons, in the order asked for', await labels(), ['albums', 'singles', 'shows', 'episodes']);
t.equal('none is lit under all', await pressed(), []);
t.equal('all shows every section',
  await headings(),
  ['albums — 60', 'shows — 5', 'singles — 30', 'episodes — 20', 'medium unknown items — 2']);
await measure('390', 390);
await measure('320', 320);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await wait(300);

// ---------------------------------------------------------------------------
console.log('\n2. Each press filters, lands, and agrees with the menu');
const CASES = [
  ['albums', 'music|feeds', ['albums — 60'], 'music · albums'],
  ['singles', 'music|items', ['singles — 30'], 'music · singles'],
  ['shows', 'podcast|feeds', ['shows — 5'], 'podcast · shows'],
  ['episodes', 'podcast|items', ['episodes — 20'], 'podcast · episodes'],
];
for (const [word, wantView, wantHeadings, wantTrigger] of CASES) {
  await js('window.scrollTo(0, 0)');
  await press(word);
  t.equal(`${word}: the view is stored`, await view(), wantView);
  t.equal(`${word}: only its own section`, await headings(), wantHeadings);
  t.equal(`${word}: the button is lit`, await pressed(), [word]);
  t.ok(`${word}: the menu names it`, (await trigger()).startsWith(wantTrigger), await trigger());
  const rows = await rowCount();
  t.ok(`${word}: rows render`, rows > 0 && rows <= 24, String(rows));
}

// The two long sections are tall enough to land exactly. The short ones clamp at
// the end of the page, so the exact number is only true here.
await js('window.scrollTo(0, 0)');
await press('albums');
t.equal('albums: the row is pinned under the 71px header', await top(ROW), 71);
t.equal('albums: the controls land 60px under the header', await top(CONTROLS), 131);
t.ok('albums: the first row is on screen', await js(`document.querySelector('section ul > li').getBoundingClientRect().top < 844`));
await press('singles');
t.equal('singles, from albums: the controls land in the same place', await top(CONTROLS), 131);

// ---------------------------------------------------------------------------
console.log('\n3. Deep in a list: pinned, reachable, and the bytes cap holds');
await press('singles'); // unlit: back to all
t.equal('a press of the lit button goes back to all', await view(), 'all|all');
t.equal('nothing is lit after it', await pressed(), []);
t.ok('every section is back', (await headings()).length === 5);
await press('albums');
// Scroll until the auto-reveal has spent a lot of rows. One long section, because
// a scroll to the end of the mixed view only ever reaches the last sentinel.
for (let i = 0; i < 40 && (await rowCount()) < 60; i++) {
  await js('window.scrollTo(0, document.documentElement.scrollHeight)');
  await wait(150);
}
const deepRows = await rowCount();
t.equal('the scroll revealed all sixty albums', deepRows, 60);
const deepY = await js('Math.round(window.scrollY)');
t.ok('the page is deep in the list', deepY > 2000, String(deepY));
t.equal('deep: the row is still pinned', await top(ROW), 71);
t.ok('deep: the header does not cover a button', await js(`(() => {
  const b = ${button('albums')}; const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit === b || b.contains(hit);
})()`));
await press('episodes');
t.equal('deep: the press lands', await headings(), ['episodes — 20']);
t.ok('deep: the press is near the top of the page again', (await js('Math.round(window.scrollY)')) < deepY);
const afterRows = await rowCount();
t.ok('deep: the bytes cap holds on the way out', afterRows <= 24, String(afterRows));
await press('albums');
const backRows = await rowCount();
t.ok('deep: the bytes cap holds on the way back, twelve rows and not the sixty', backRows <= 24, String(backRows));

// ---------------------------------------------------------------------------
console.log('\n4. A folded section, the title filter, and a reload');
await press('singles');
await js(`${HEADINGS}[0].click()`);
await wait(200);
t.equal('the heading folds', await js(`${HEADINGS}[0].getAttribute('aria-expanded')`), 'false');
t.equal('a folded section has no rows', await rowCount(), 0);
await press('albums');
await press('singles');
t.equal('a press opens the folded section', await js(`${HEADINGS}[0].getAttribute('aria-expanded')`), 'true');
t.ok('rows are back', (await rowCount()) > 0);
t.ok('the fold is gone from storage', !(await stored('bmb:fav_collapsed') ?? '').includes('favpage:items'));

await press('albums');
await js(`(() => {
  const i = document.querySelector('[aria-label="Filter favorites"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'album music 7');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(300);
t.equal('the heading counts its own medium under a title filter', await headings(), ['albums — 1 of 60']);
await press('episodes');
t.equal('a filter that matches nothing here says so in its own words',
  await js(`document.querySelector('main').innerText.includes('Nothing matches')`), true);
t.equal('the true total stays out of the heading', await headings(), []);
await js(`(() => {
  const i = document.querySelector('[aria-label="Filter favorites"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(200);
t.equal('a cleared filter shows the section', await headings(), ['episodes — 20']);

await send('Page.reload');
await until('document.readyState === "complete"');
await until(`!!document.querySelector('[aria-label="Filter favorites"]')`);
await wait(800);
t.equal('the choice survives a reload, as a device setting', await pressed(), ['episodes']);

// ---------------------------------------------------------------------------
console.log('\n5. The menu and the buttons are one state');
await press('episodes'); // back to all
await js(`document.querySelector('[aria-label="Filter favorites"]').parentElement.querySelector('button').click()`);
await wait(200);
await js(`[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => /albums/i.test(b.textContent)).click()`);
await wait(200);
t.equal('the menu lights the button', await pressed(), ['albums']);
await js(`document.querySelector('[aria-label="Filter favorites"]').parentElement.querySelector('button').click()`);
await wait(200);
await js(`[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => /^\\s*✓?\\s*music/i.test(b.textContent)).click()`);
await wait(200);
t.equal('both halves of music light nothing', await pressed(), []);
t.equal('both halves of music keep both sections', await headings(), ['albums — 60', 'singles — 30']);
await js(`document.querySelector('[aria-label="Filter favorites"]').parentElement.querySelector('button').click()`);
await wait(200);
await js(`[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => /medium unknown/i.test(b.textContent)).click()`);
await wait(200);
t.equal('medium unknown stays in the menu and lights nothing', await pressed(), []);
t.equal('medium unknown shows its own rows', await headings(), ['medium unknown items — 2']);

t.equal('no press changed the saved albums and shows', await stored('bmb:favorites:guest'), seededFeeds);
t.equal('no press changed the saved tracks and episodes', await stored('bmb:favepisodes:guest'), seededItems);

// ---------------------------------------------------------------------------
console.log('\n6. A medium with one half');
await open({ ...feeds('album', 'music', 3), ...feeds('show', 'podcast', 4) }, items('single', 'music', 3));
t.equal('no button for a half with no rows', await labels(), ['albums', 'singles', 'shows']);
await press('shows');
t.equal('the press lights the button although the medium has one half', await pressed(), ['shows']);
t.equal('no empty heading for the half it does not have', await headings(), ['shows — 4']);
await press('shows');
t.equal('and it goes back to all', await view(), 'all|all');

await open(feeds('album', 'music', 3), {});
t.equal('one possible button is no row at all', await js(`!${ROW}`), true);

await open({}, {}).catch(() => {});
t.equal('an empty library has no row', await js(`!${ROW}`), true);
t.equal('an empty library is still the empty card', await js(`document.body.innerText.includes('Nothing saved yet')`), true);

// ---------------------------------------------------------------------------
console.log('\n7. Desktop');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await open(FULL_FEEDS, FULL_ITEMS);
const wide = await measure('1280', 1280, 800, false);
t.ok('1280: the buttons keep their own width', wide.btns.every((b) => b.w < 200), JSON.stringify(wide.btns));
await press('albums');
t.equal('1280: the row is pinned', await top(ROW), 71);
t.equal('1280: the controls land 60px under the header', await top(CONTROLS), 131);

t.equal('no page exception', pageErrors, []);

console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
