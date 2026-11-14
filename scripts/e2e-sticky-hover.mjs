// End-to-end for the iOS "sticky hover": a button switched OFF must not keep
// looking ON on a touch screen (docs/ui.md, "Hover only where a pointer can
// hover").
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:stickyhover
//   APP_URL=http://127.0.0.1:3041 npm run e2e:stickyhover -- --headed --keep
//
// WHY IT EXISTS. iOS applies `:hover` to the element last tapped and keeps it
// there until something else is tapped. Every shared control class drew a
// brighter border on `:hover`, so a toggle just pressed OFF stayed brighter
// than its peers and read as still selected — the SINGLES quick button on
// /favorites (Chad, iPhone, beta, 2026-11-13) and the 3.5×/5× speed tiles
// before it. A `(hover: hover)` media query is the boundary: a phone matches
// `(hover: none)`, a mouse matches `(hover: hover)`.
//
// HOW. iOS's held hover cannot be produced by a synthetic tap in Chrome, so the
// state is FORCED (`CSS.forcePseudoState`) on the button just switched off,
// which is exactly the state iOS leaves it in. Then its computed border, text
// and background are compared with a peer that was never pressed.
//
//   1. PHONE (390×844, touch, `(hover: none)`): SINGLES pressed on, then off,
//      then held in :hover, looks the same as ALBUMS. The episode list's
//      order <Chip>, off and held in :hover, looks as it does unhovered.
//   2. DESKTOP (1280, mouse, `(hover: hover)`): the held hover still brightens
//      the button, so a mouse keeps its feedback (the must-still-work half).
//   Both passes also hold :hover on a test button of EVERY shared control
//   class in globals.css: no change on the phone, a change with the mouse.
//
// Signed out, a seeded guest library: nothing reaches a relay.

import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, 'Start the app first: npm run dev');

const guid = (prefix, i) => `${prefix}-${String(i).padStart(4, '0')}-4000-8000-000000000000`;
const SINGLES = [0, 1, 2].map((i) => ({
  itemGuid: guid('single', i), feedGuid: guid('sfeed', i),
  title: `Single ${i}`, podcastTitle: `Album of ${i}`, medium: 'music', addedAt: 1700000000000 + i,
}));
const ALBUM = { id: 900001, podcastGuid: guid('album', 0), title: 'E2E Album', author: 'e2e', medium: 'music', addedAt: 1700000000000 };
const SHOW = { id: 0, podcastGuid: guid('show', 0), title: 'E2E Show', author: 'e2e', medium: 'podcast', addedAt: 1700000000000 };
const TALKS = [0, 1].map((k) => ({
  itemGuid: guid('pep', k), feedGuid: SHOW.podcastGuid, title: `Talk ${k}`, podcastTitle: 'E2E Show',
  medium: 'podcast', addedAt: 1700000000100 + k,
}));

const { page } = await launchChrome({ name: 'stickyhover', args: ['--disable-gpu'] });
const { send, js, until } = page;
const t = checker();
await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('CSS.enable');

async function openFavorites() {
  await send('Page.navigate', { url: `${APP}/privacy` });
  await until('document.readyState === "complete"');
  const seed = {
    'bmb:favorites:guest': JSON.stringify({ [ALBUM.podcastGuid]: ALBUM, [SHOW.podcastGuid]: SHOW }),
    'bmb:favepisodes:guest': JSON.stringify(Object.fromEntries([...SINGLES, ...TALKS].map((e) => [e.itemGuid, e]))),
  };
  await js(`(() => { localStorage.clear(); const s = ${JSON.stringify(seed)};
    for (const k in s) localStorage.setItem(k, s[k]); return true; })()`);
  await send('Page.navigate', { url: `${APP}/favorites` });
  await until('document.readyState === "complete"');
  return until(`document.querySelectorAll('[role="group"][aria-label="Go to section"] button').length >= 2`, 15000);
}

const QUICK = `[role="group"][aria-label="Go to section"] button`;
/** 1-based position of the quick button whose word is `word`, or 0. */
const quickIndex = (word) => js(`[...document.querySelectorAll('${QUICK}')].findIndex((b) => b.textContent.trim().toLowerCase() === '${word}') + 1`);
const look = (sel) => js(`(() => { const b = document.querySelector('${sel}'); if (!b) return null;
  const c = getComputedStyle(b); return JSON.stringify({ border: c.borderTopColor, text: c.color, bg: c.backgroundColor }); })()`).then((s) => (s ? JSON.parse(s) : null));

/** Hold :hover on the element, as iOS does after a tap. */
async function forceHover(sel, on = true) {
  // `send` resolves with the whole CDP message; the answer is under `result`.
  const root = (await send('DOM.getDocument', { depth: 0 })).result?.root;
  const nodeId = root && (await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).result?.nodeId;
  if (!nodeId) return false;
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: on ? ['hover'] : [] });
  return true;
}

// The episode list's order <Chip> ("Show oldest first"), OFF by default — the
// app's most-used toggle shape. It is compared with ITSELF, unhovered, because
// it has no peer beside it. The Podcasting 2.0 show, for its many episodes.
const PC20 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';
const ORDER_CHIP = 'button[aria-pressed="false"][title="Show oldest first"]';
async function orderChipLooks() {
  await send('Page.navigate', { url: `${APP}/?podcast=${PC20}` });
  await until('document.readyState === "complete"');
  if (!(await until(`!!document.querySelector('${ORDER_CHIP}')`, 30000))) return null;
  const plain = await look(ORDER_CHIP);
  await forceHover(ORDER_CHIP);
  await wait(250);
  const held = await look(ORDER_CHIP);
  await forceHover(ORDER_CHIP, false);
  return { plain, held };
}

// EVERY shared control class whose hover moved into the `(hover: hover)` block,
// on a test button of its own, so the rule is proved for each class and not
// only for the two surfaces above. `is-following` is the follow button's
// second state.
const SHARED = ['btn', 'btn-ghost', 'btn-bolt', 'btn-nostr', 'btn-bolt-soft', 'btn-mini', 'tile', 'npub-follow-btn', 'npub-follow-btn is-following'];
async function sharedLooks() {
  await js(`(() => { document.querySelectorAll('[data-e2e-cls]').forEach((b) => b.remove());
    const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:0;top:0;z-index:99;background:#000';
    ${JSON.stringify(SHARED)}.forEach((c, i) => { const b = document.createElement('button'); b.className = c; b.textContent = 'x';
      b.dataset.e2eCls = String(i); box.appendChild(b); });
    document.body.appendChild(box); return true; })()`);
  const out = [];
  for (let i = 0; i < SHARED.length; i++) {
    const sel = `[data-e2e-cls="${i}"]`;
    const plain = await look(sel);
    await forceHover(sel);
    await wait(250);
    const held = await look(sel);
    await forceHover(sel, false);
    out.push({ cls: SHARED[i], plain, held });
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log('\n1. A phone: a button switched off looks like its peers, even under a held hover');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
t.ok('the quick buttons render', await openFavorites());
t.equal('the emulated phone matches (hover: none), as an iPhone does',
  await js(`matchMedia('(hover: none)').matches && !matchMedia('(hover: hover)').matches`), true);
const si = await quickIndex('singles');
const ai = await quickIndex('albums');
t.ok('SINGLES and ALBUMS are both there', si > 0 && ai > 0, JSON.stringify({ si, ai }));
const SINGLES_BTN = `${QUICK}:nth-of-type(${si})`;
const ALBUMS_BTN = `${QUICK}:nth-of-type(${ai})`;
await js(`document.querySelector('${SINGLES_BTN}').click()`); await wait(300);
t.equal('SINGLES switches on', await js(`document.querySelector('${SINGLES_BTN}').getAttribute('aria-pressed')`), 'true');
await js(`document.querySelector('${SINGLES_BTN}').click()`); await wait(300);
t.equal('…and off again', await js(`document.querySelector('${SINGLES_BTN}').getAttribute('aria-pressed')`), 'false');
t.equal('ALBUMS is off too', await js(`document.querySelector('${ALBUMS_BTN}').getAttribute('aria-pressed')`), 'false');
await forceHover(SINGLES_BTN);
await wait(250); // past `transition`'s 150 ms
const held = await look(SINGLES_BTN);
const peer = await look(ALBUMS_BTN);
await forceHover(SINGLES_BTN, false);
t.equal('SINGLES, off and held in :hover, looks exactly like ALBUMS', held, peer);

const chip = await orderChipLooks();
t.ok('the show page renders its order chip, off', !!chip);
t.equal('the order <Chip>, off and held in :hover, looks exactly as it does unhovered', chip?.held, chip?.plain);

for (const r of await sharedLooks()) {
  t.equal(`.${r.cls.replace(' ', '.')}, held in :hover on a phone, looks as it does unhovered`, r.held, r.plain);
}

// ---------------------------------------------------------------------------
console.log('\n2. A mouse: the hover still shows');
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
t.ok('the quick buttons render', await openFavorites());
t.equal('the desktop matches (hover: hover)', await js(`matchMedia('(hover: hover)').matches`), true);
const si2 = await quickIndex('singles');
const ai2 = await quickIndex('albums');
await forceHover(`${QUICK}:nth-of-type(${si2})`);
await wait(250);
const heldD = await look(`${QUICK}:nth-of-type(${si2})`);
const peerD = await look(`${QUICK}:nth-of-type(${ai2})`);
await forceHover(`${QUICK}:nth-of-type(${si2})`, false);
t.ok('a held hover brightens the border, so a mouse keeps its feedback',
  heldD && peerD && heldD.border !== peerD.border, JSON.stringify({ heldD, peerD }));
const chipD = await orderChipLooks();
t.ok('a held hover still brightens the off order <Chip> with a mouse',
  !!chipD && (chipD.held.border !== chipD.plain.border || chipD.held.text !== chipD.plain.text), JSON.stringify(chipD));

for (const r of await sharedLooks()) {
  t.ok(`.${r.cls.replace(' ', '.')}, held in :hover with a mouse, changes its look`,
    JSON.stringify(r.held) !== JSON.stringify(r.plain), JSON.stringify(r));
}

// ---------------------------------------------------------------------------
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
