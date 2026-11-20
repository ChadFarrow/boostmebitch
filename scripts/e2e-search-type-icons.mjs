#!/usr/bin/env node
/**
 * e2e: the search box's type menu draws one glyph per type, the words still
 * start at one x, and the same glyph names the type everywhere else it shows.
 *
 * Reported from an iPhone on 2026-11-19: "DeMu and the other options here need
 * a icon like music has". Only `♫ MUSIC` and `⚡ NPUB` carried one, inside the
 * label string, so their words began a glyph and a space to the right of ALL's
 * — and `♫` also marked PLAYLISTS on the hero button and on a result's stamp.
 *
 * What it drives, on desktop (1280×900) and under phone emulation (390×844,
 * `mobile: true`, 3× pixels):
 * - the open menu: six rows, an SVG glyph in each (NPUB's is a key since Chad
 *   dropped its `⚡`), six DIFFERENT SVGs at one size, every word at one x, every glyph centred on
 *   its word, every row at least 24px tall, the menu inside the viewport;
 * - the closed button, once per type: it carries the same glyph as the row, its
 *   accessible name is the word alone, and its height does not move;
 * - the hero's BROWSE PLAYLISTS / BROWSE DEMU, a search result's PLAYLIST stamp,
 *   /demu's title and its "Self-hosted" badge: the same SVG as the menu's row for that type;
 * - NPUB's key in the box's left slot (centred on the input), and on the "look it
 *   up" chip an npub typed under ALL offers. That search is answered INSIDE the
 *   browser (CDP Fetch), so the npub never reaches the dev server or Podcast Index;
 * - no horizontal overflow on the phone.
 *
 * The browser resolves no host but this machine, so nothing it runs reaches a
 * relay. The dev server asks Podcast Index for the one search and for /demu.
 *
 *   BMB_APP=http://localhost:3000 node scripts/e2e-search-type-icons.mjs
 *   SHOT_DIR=/some/dir   also writes screenshots there
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const APP = process.env.BMB_APP ?? 'http://localhost:3000';
const SHOT_DIR = process.env.SHOT_DIR;
await requireApp(APP, `No app at ${APP}. Start one (npm run dev) or set BMB_APP.`);
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const WORDS = ['ALL', 'MUSIC', 'DEMU', 'PODCASTS', 'PLAYLISTS', 'NPUB'];
const TRIGGER = 'button[aria-haspopup="menu"][aria-label^="Search type"]';
const t = checker();

const { page } = await launchChrome({
  name: 'typeicons',
  args: ['--window-size=1280,900', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
});
const { send, js, jsOrThrow, until } = page;
await send('Page.enable');
await send('Runtime.enable');

async function go(path) {
  await send('Page.navigate', { url: `${APP}${path}` });
  await wait(500);
  await until('document.readyState === "complete"', 20000);
}

async function shot(name, clip) {
  if (!SHOT_DIR) return;
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  if (r.result?.data) writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}

const menuOpen = () => js(`!!document.querySelector('[role="menu"] [role="menuitemradio"]')`);
async function openMenu() {
  if (!(await menuOpen())) await jsOrThrow(`document.querySelector('${TRIGGER}').click()`);
  return until(`!!document.querySelector('[role="menu"] [role="menuitemradio"]')`, 5000, 50);
}

/** Each row: the glyph slot, the word, and where both sit. */
const readRows = () => jsOrThrow(`(() => [...document.querySelectorAll('[role="menuitemradio"]')].map((r) => {
  const [tick, slot, word] = [...r.children];
  const svg = slot?.querySelector('svg');
  const glyph = (svg ?? slot?.firstElementChild ?? slot).getBoundingClientRect();
  const w = word.getBoundingClientRect();
  const row = r.getBoundingClientRect();
  return {
    word: word.textContent.trim(),
    svg: svg ? svg.innerHTML : null,
    glyphText: svg ? '' : (slot?.textContent ?? '').trim(),
    gw: glyph.width, gh: glyph.height, gcy: glyph.top + glyph.height / 2,
    wordLeft: w.left, wcy: w.top + w.height / 2,
    rowH: row.height, right: row.right, bottom: row.bottom,
    sameColour: svg ? getComputedStyle(svg).color === getComputedStyle(word).color : true,
  };
}))()`);

const readTrigger = () => jsOrThrow(`(() => {
  const b = document.querySelector('${TRIGGER}');
  const inner = b.firstElementChild;
  const svg = inner.querySelector('svg');
  const g = (svg ?? inner.firstElementChild ?? inner).getBoundingClientRect();
  const range = document.createRange();
  const textNode = [...inner.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  if (textNode) range.selectNodeContents(textNode);
  const w = textNode ? range.getBoundingClientRect() : inner.getBoundingClientRect();
  const r = b.getBoundingClientRect();
  return {
    name: b.getAttribute('aria-label'),
    text: b.textContent.replace(/\\s+/g, ' ').trim(),
    svg: svg ? svg.innerHTML : null,
    glyphText: svg ? '' : (inner.firstElementChild?.textContent ?? '').trim(),
    h: r.height, w: r.width, top: r.top, left: r.left,
    gcy: g.top + g.height / 2, wcy: w.top + w.height / 2,
  };
})()`);

async function pick(word) {
  await openMenu();
  await jsOrThrow(`[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.trim().endsWith(${JSON.stringify(word)})).click()`);
  await until(`!document.querySelector('[role="menu"]')`, 3000, 50);
}

const spread = (xs) => Math.max(...xs) - Math.min(...xs);
const svgOf = {};

async function round(label) {
  console.log(`\n  ${label}`);
  await go('/');
  t.ok(`${label}: the type button renders`, await until(`!!document.querySelector('${TRIGGER}')`, 20000));

  // The hero first: it hides once anything is searched.
  await until(`!!document.querySelector('a[href="/demu"].btn-ghost')`, 15000);
  const hero = await jsOrThrow(`(() => ['/playlists', '/demu'].map((h) => {
    const a = document.querySelector('a[href="' + h + '"].btn-ghost');
    if (!a) return null;
    const svg = a.querySelector('svg');
    return { svg: svg ? svg.innerHTML : null, h: a.getBoundingClientRect().height, text: a.textContent.trim(),
      sameColour: svg ? getComputedStyle(svg).color === getComputedStyle(a).color : false };
  }))()`);

  await openMenu();
  const rows = await readRows();
  const vw = await js('innerWidth');
  const vh = await js('innerHeight');
  t.equal(`${label}: six options, in order`, rows.map((r) => r.word), WORDS);
  rows.forEach((r, i) => { if (r.svg) svgOf[WORDS[i]] = r.svg; });
  t.ok(`${label}: an SVG glyph on all six, NPUB included`, rows.every((r) => r.svg),
    JSON.stringify(rows.map((r) => !!r.svg)));
  t.equal(`${label}: no ⚡ left on NPUB`, rows[5].glyphText, '');
  t.equal(`${label}: the six SVGs are six different shapes`, new Set(rows.map((r) => r.svg)).size, 6);
  t.ok(`${label}: the six SVGs are one size (12–15px)`,
    spread(rows.map((r) => r.gh)) < 0.5 && rows[0].gh >= 12 && rows[0].gh <= 15,
    rows.map((r) => `${r.word} ${r.gw.toFixed(1)}×${r.gh.toFixed(1)}`).join(', '));
  t.ok(`${label}: every word starts at one x`, spread(rows.map((r) => r.wordLeft)) < 0.5,
    rows.map((r) => `${r.word} ${r.wordLeft.toFixed(2)}`).join(', '));
  t.ok(`${label}: every glyph sits on its word's centre line (±1.5px)`,
    rows.every((r) => Math.abs(r.gcy - r.wcy) <= 1.5),
    rows.map((r) => `${r.word} ${(r.gcy - r.wcy).toFixed(2)}`).join(', '));
  t.ok(`${label}: each glyph is the colour of its word`, rows.every((r) => r.sameColour));
  t.ok(`${label}: every row is at least 24px tall`, rows.every((r) => r.rowH >= 24),
    rows.map((r) => r.rowH.toFixed(1)).join(', '));
  t.ok(`${label}: the menu is inside the viewport`, rows.every((r) => r.right <= vw && r.bottom <= vh));
  if (label.startsWith('phone')) {
    t.ok(`${label}: no horizontal overflow with the menu open`,
      await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));
  }

  // Each type once: the closed button carries the row's glyph.
  const trig = [];
  for (const [i, word] of WORDS.entries()) {
    await pick(word);
    const b = await readTrigger();
    trig.push(b);
    t.equal(`${label}: ${word} — the button's accessible name is the word alone`, b.name, `Search type: ${word}`);
    t.ok(`${label}: ${word} — the button shows the same glyph as the row`,
      b.svg && b.svg === rows[i].svg, JSON.stringify({ svg: !!b.svg, glyph: b.glyphText }));
    t.ok(`${label}: ${word} — the glyph sits on the word's centre line (±1.5px)`, Math.abs(b.gcy - b.wcy) <= 1.5,
      (b.gcy - b.wcy).toFixed(2));
    if (word === 'DEMU') {
      await openMenu();
      const r = await jsOrThrow(`(() => { const m = document.querySelector('[role="menu"]').getBoundingClientRect();
        const b = document.querySelector('${TRIGGER}').getBoundingClientRect();
        return { x: Math.min(m.left, b.left) - 8, y: b.top - 8, width: Math.max(m.right, b.right) - Math.min(m.left, b.left) + 16, height: m.bottom - b.top + 16 }; })()`);
      await shot(`${label.split(' ')[0]}-menu-demu`, r);
      await jsOrThrow(`document.querySelector('${TRIGGER}').click()`);
      await until(`!document.querySelector('[role="menu"]')`, 3000, 50);
    }
  }
  t.ok(`${label}: the button keeps one height across all six (≥24px)`, spread(trig.map((b) => b.h)) < 0.5 && trig[0].h >= 24,
    trig.map((b) => b.h.toFixed(1)).join(', '));
  t.ok(`${label}: the button stays where it was`, spread(trig.map((b) => b.top)) < 0.5 && spread(trig.map((b) => b.left)) < 0.5);

  // NPUB is still picked: the box's left slot draws the key, on the input's centre line.
  const slot = () => jsOrThrow(`(() => { const s = document.querySelector('[data-search-mode-icon]'); const i = document.querySelector('input.input');
    const g = s.querySelector('svg'); const gr = (g ?? s).getBoundingClientRect(), ir = i.getBoundingClientRect();
    return { svg: g ? g.innerHTML : null, text: g ? '' : s.textContent.trim(), dy: (gr.top + gr.bottom) / 2 - (ir.top + ir.bottom) / 2, h: gr.height, left: gr.left - ir.left }; })()`);
  const npubSlot = await slot();
  t.ok(`${label}: NPUB — the box's left icon is the NPUB key`, npubSlot.svg && npubSlot.svg === rows[5].svg, JSON.stringify(npubSlot.text));
  t.ok(`${label}: NPUB — the key sits on the input's centre line (±1px), 13–15px tall`,
    Math.abs(npubSlot.dy) <= 1 && npubSlot.h >= 13 && npubSlot.h <= 15, JSON.stringify(npubSlot));
  await pick('ALL');
  const allSlot = await slot();
  t.equal(`${label}: ALL — the left icon is the plain ⌕ again`, allSlot.text, '⌕');

  t.ok(`${label}: BROWSE PLAYLISTS carries the PLAYLISTS glyph`, hero[0]?.svg && hero[0].svg === rows[4].svg, JSON.stringify(hero[0]?.text));
  t.ok(`${label}: BROWSE DEMU carries the DEMU glyph`, hero[1]?.svg && hero[1].svg === rows[2].svg, JSON.stringify(hero[1]?.text));
  t.ok(`${label}: the two hero buttons are one height`, hero[0] && hero[1] && Math.abs(hero[0].h - hero[1].h) < 0.5);
  t.ok(`${label}: each hero glyph is the colour of its words`, hero.every((h) => h?.sameColour));
  if (label.startsWith('phone')) {
    const r = await jsOrThrow(`(() => { const a = document.querySelector('a[href="/playlists"].btn-ghost').parentElement.getBoundingClientRect();
      return { x: a.left - 8, y: a.top - 8, width: a.width + 16, height: a.height + 16 }; })()`);
    await shot('phone-hero', r);
  }
}

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
await round('desktop 1280×900');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await round('phone 390×844');

// A search result's PLAYLIST stamp. Asks Podcast Index through the dev server.
console.log('\n  the PLAYLIST stamp and the /demu badge (phone)');
await go('/');
await until(`!!document.querySelector('${TRIGGER}')`, 20000);
// Typed too soon after the load, the text lands before React has taken the
// input over, and no search runs from it.
await wait(1500);
await pick('PLAYLISTS');
await jsOrThrow(`(() => { const i = document.querySelector('input.input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'music');
  i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const stampSeen = await until(`[...document.querySelectorAll('.stamp')].some((s) => s.textContent.trim() === 'PLAYLIST')`, 30000);
if (stampSeen) {
  const stamp = await jsOrThrow(`(() => { const s = [...document.querySelectorAll('.stamp')].find((x) => x.textContent.trim() === 'PLAYLIST');
    const svg = s.querySelector('svg'); const r = s.getBoundingClientRect();
    return { svg: svg ? svg.innerHTML : null, h: r.height, gh: svg ? svg.getBoundingClientRect().height : 0, x: r.left, y: r.top, w: r.width,
      marked: s.dataset.stamp === 'playlist' }; })()`);
  t.ok('a PLAYLIST stamp carries the PLAYLISTS glyph', stamp.svg && stamp.svg === svgOf.PLAYLISTS);
  // e2e:history skips a playlist row by this attribute, now that no `♫` is in its text.
  t.ok('the stamp carries data-stamp="playlist"', stamp.marked);
  t.ok('the stamp glyph follows the stamp text (10–13px)', stamp.gh >= 10 && stamp.gh <= 13, stamp.gh.toFixed(1));
  await shot('phone-stamp', { x: stamp.x - 8, y: stamp.y - 8, width: stamp.w + 16, height: stamp.h + 16 });
} else {
  t.fail('a PLAYLIST stamp rendered for the search "music" under PLAYLISTS', 'no result came back from Podcast Index within 30 s');
}

// `?holiday=none`: while a costume is in season the title's emu wears a costume, which is a
// different SVG by design (e2e:demuholiday covers it). This compares the plain one.
await go('/demu?holiday=none');
const title = await until(`!!document.querySelector('[data-demu-title] svg')`, 20000)
  ? await jsOrThrow(`(() => { const h = document.querySelector('[data-demu-title]'); const g = h.querySelector('svg'); const gr = g.getBoundingClientRect(), hr = h.getBoundingClientRect();
      const probe = document.createElement('span'); probe.className = 'text-bolt'; document.body.appendChild(probe); const bolt = getComputedStyle(probe).color; probe.remove();
      return { svg: g.innerHTML, colour: getComputedStyle(g).color, bolt, gh: gr.height, fs: parseFloat(getComputedStyle(h).fontSize), text: h.textContent.trim(), inside: gr.top >= hr.top - 1 && gr.bottom <= hr.bottom + 1 }; })()`)
  : null;
t.ok('/demu: the title wears the DEMU glyph', title && title.svg === svgOf.DEMU, JSON.stringify(title?.text));
t.ok('/demu: the title glyph is bolt yellow, one em tall, inside the title', title && title.colour === title.bolt
  && Math.abs(title.gh - title.fs) < 1.5 && title.inside, JSON.stringify(title && { colour: title.colour, bolt: title.bolt, gh: title.gh, fs: title.fs, inside: title.inside }));
t.equal('/demu: the title reads DeMu', title?.text, 'DeMu');
if (title) await shot('phone-demu-title', await jsOrThrow(`(() => { const r = document.querySelector('[data-demu-title]').parentElement.getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 8), width: 390, height: 160 }; })()`));
const badgeSeen = await until(`!!document.querySelector('[data-demu-app="self"] svg')`, 40000);
if (badgeSeen) {
  const badge = await jsOrThrow(`document.querySelector('[data-demu-app="self"] svg').innerHTML`);
  t.ok('/demu: the Self-hosted badge is the DEMU glyph', badge === svgOf.DEMU);
} else {
  t.fail('/demu: a Self-hosted badge rendered', 'no self-hosted album within 40 s');
}
t.ok('/demu: no horizontal overflow on the phone',
  await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));

// An npub typed under ALL: the box offers "look it up", with NPUB's key on the chip.
// The search the box still runs is answered HERE, empty, so the npub never leaves
// the browser — not to the dev server, not to Podcast Index.
console.log('\n  the "look it up" chip under ALL (phone)');
const strayKey = nip19.npubEncode(getPublicKey(generateSecretKey()));
let searchesHeld = 0;
const offSearch = page.on((m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  searchesHeld++;
  send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify({ feeds: [], total: 0, type: 'all' })).toString('base64') });
});
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/search*', requestStage: 'Request' }] });
await go('/');
await until(`!!document.querySelector('${TRIGGER}')`, 20000);
await wait(1500);
await pick('ALL');
await jsOrThrow(`(() => { const i = document.querySelector('input.input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(strayKey)});
  i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const chipSeen = await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'look it up')`, 15000);
// The chip shows at once; the search runs after the box's debounce. Wait for it, so
// the step proves the search was answered here rather than that none ran.
for (let i = 0; i < 50 && searchesHeld === 0; i++) await wait(100);
if (chipSeen) {
  const chip = await jsOrThrow(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'look it up');
    const g = b.querySelector('svg'); const br = b.getBoundingClientRect(); const gr = g ? g.getBoundingClientRect() : null;
    return { svg: g ? g.innerHTML : null, h: br.height, w: br.width, x: br.left, y: br.top, dy: gr ? (gr.top + gr.bottom) / 2 - (br.top + br.bottom) / 2 : null }; })()`);
  t.ok('the "look it up" chip draws the NPUB key', chip.svg && chip.svg === svgOf.NPUB);
  t.ok('the chip\'s key sits on the chip\'s centre line (±1px)', chip.dy !== null && Math.abs(chip.dy) <= 1, String(chip.dy));
  t.ok('the chip is at least 24px tall', chip.h >= 24, chip.h.toFixed(1));
  await shot('phone-lookup-chip', { x: Math.max(0, chip.x - 140), y: chip.y - 50, width: 390 - Math.max(0, chip.x - 140), height: chip.h + 60 });
  await jsOrThrow(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'look it up').click()`);
  t.ok('the chip switches the box to NPUB, and the left icon to the key', await until(`(() => { const g = document.querySelector('[data-search-mode-icon] svg');
    return !!g && g.innerHTML === ${JSON.stringify(svgOf.NPUB ?? '')}; })()`, 5000));
} else {
  t.fail('an npub under ALL offers "look it up"', 'no chip within 15 s');
}
t.ok('the search under ALL ran, and was answered inside the browser', searchesHeld >= 1, String(searchesHeld));
await send('Fetch.disable');
offSearch();

console.log(`\n  ${t.count - t.fails}/${t.count} passed`);
await exit(t.fails ? 1 : 0);
