// Captures the phone screenshots the Zapstore listing renders.
//
// Usage:
//   node scripts/shoot-screenshots.mjs                       # against production
//   node scripts/shoot-screenshots.mjs http://localhost:3000 # against a dev server
//   node scripts/shoot-screenshots.mjs --manual              # drive it by hand
//   node scripts/shoot-screenshots.mjs --only 01,03
//   node scripts/shoot-screenshots.mjs https://www.boostmebuddy.com \
//     --out public/screenshots/buddy                         # the other brand
//
// A generator, not a check:*. It is deliberately NOT in CI: it needs a live
// site with real Podcast Index results behind it, and which episode looks good
// in a store listing is a human judgement call, not something to assert.
//
// Output lands in public/screenshots/, and `images:` in zapstore.yaml names
// those three paths. RE-SHOOT AND RE-COMMIT TOGETHER: zsp fails on a path that
// does not resolve, so renaming a shot here without editing zapstore.yaml
// breaks the publish rather than dropping an image.
//
// TWO OTHER FILES NAME THESE SHOTS, and neither is the store listing.
//
// public/manifest.json declares a `screenshots` member (added by #254 on
// 2026-08-28; this comment used to say it deliberately did not). It hard-codes
// `"sizes": "824x1830"`, which is VIEWPORT x SCALE below — change either and
// that declaration silently stops matching the files. The old comment's worry
// was that manifest.json is read by Bubblewrap as well as by browsers, so a new
// member changes what the next Android build wraps. That is true of a re-`init`
// only: CI runs `bubblewrap update`, which regenerates the Android project from
// android/twa-manifest.json and reads nothing from the web manifest. So this
// member reaches browsers and does not reach the APK.
//
// WHY --manual EXISTS AND IS NOT A FALLBACK: the automated path below drives
// real, live podcast data. A feed can go away, a search can rank differently,
// and the boost modal needs an episode that actually carries a value block. So
// the auto steps are best-effort — a step that cannot find its target WARNS and
// moves on rather than failing the run and losing the shots that did work. When
// a shot needs a specific show, run --manual: the browser opens headed, you
// navigate to what you want, and pressing Enter in the terminal takes the shot
// at the same phone viewport.

import { mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadPlaywright } from './playwright-global.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const base = args.find((a) => a.startsWith('http')) ?? 'https://www.boostmebitch.com';
const manual = flag('--manual');
const only = value('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const query = value('--query', 'Homegrown Hits');

// ONE DIRECTORY PER BRAND, and the file names inside are identical on purpose.
// `zapstore.yaml` and `zapstore-buddy.yaml` each name three paths, and a shot
// carrying the wrong wordmark is the other brand's word on a store listing —
// the failure lib/brand.ts exists to prevent, arriving through an asset rather
// than through a string. Separate directories make that a path mistake anyone
// can see, instead of a picture nobody looks at twice.
//
//   node scripts/shoot-screenshots.mjs
//   node scripts/shoot-screenshots.mjs https://www.boostmebuddy.com --out public/screenshots/buddy
const OUT = value('--out', 'public/screenshots');
// A modern phone's logical size, portrait — matching the manifest's
// `orientation` and the narrow form factor both Zapstore and Chrome's install
// dialog want. deviceScaleFactor 2 makes the PNGs 824x1830.
const VIEWPORT = { width: 412, height: 915 };
const SCALE = 2;

// Shot 03 only. The amount is typed into the boost modal so the split rows have
// something to allocate; nothing is ever sent. 1000 divides across a four-way
// block into numbers a reader can check by eye, which 100 (the minimum) does
// not. The scroll brings RECIPIENTS into frame — override either when the shot
// needs a different show, whose block has a different number of payees.
const BOOST_SATS = value('--sats', '1000');
const BOOST_SCROLL_PX = Number(value('--boost-scroll', '360'));

const titleRe = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

// NEVER `page.locator('img').first()` ANYWHERE IN THIS FILE. app/layout.tsx
// renders public/hero.jpg as a fixed full-viewport layer that is the FIRST
// <img> in the DOM on every route, and it sits inside an aria-hidden,
// pointer-events-none div. Both uses that follow from it are silently wrong:
//
//   - as a "wait for artwork" signal it is already satisfied on first paint, so
//     the shot is taken before /api/search has returned and captures an empty
//     result list;
//   - as a click target it can never resolve, because Playwright's
//     actionability check waits for pointer events that layer will never
//     accept — a 30 s timeout, then a WARN, on every run.
//
// Match the result ROW by the title text instead. It is also the only signal
// that actually means "the search came back".
const resultRow = (page) => page.locator('ul > li').filter({ hasText: titleRe }).first();
const boostButton = (page) => page.getByLabel(/Boost this (episode|track)/i).first();

// TYPE, THEN CHECK THE TEXT SURVIVED. <SearchBar>'s input is a controlled React
// component on a server-rendered page, so the box is present and accepts
// keystrokes for several seconds BEFORE React attaches to it, and everything
// typed in that window is thrown away on hydration. Measured against
// production, both obvious forms fail there and neither says so:
//
//   - `fill(query)` leaves the box EMPTY and never calls /api/search at all,
//     because React re-renders from its own state and that state is '';
//   - `type(query)` loses the first character, so the search runs for
//     "omegrown Hits" and the row this script looks for never appears.
//
// Both then surface as "the results never came back", which reads as a slow
// site rather than an early script. Polling the value is the closest
// self-verifying form available at this level: it asserts the box kept what was
// typed.
//
// IT IS NOT SUFFICIENT ON ITS OWN, and the caller is where that is closed. An
// input that has rendered but not yet hydrated keeps a typed value in the plain
// DOM, so `inputValue()` reads it back and this loop returns on attempt 0 —
// then hydration lands, React re-renders from state `''`, and the query is gone
// having never reached /api/search. Measured against production: the run that
// returned on attempt 0 found no rows in 30 s, and the run that took until
// attempt 1 found them in under 12 s. `ensureResults` therefore retries the
// whole fill against the ROWS rather than trusting one return from here.
async function fillWhenHydrated(input, text) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await input.fill(text);
    await input.page().waitForTimeout(400);
    if ((await input.inputValue()) === text) return;
  }
  throw new Error(`the search box never kept "${text}" — the page may not have hydrated`);
}

/** Search, and leave the results on screen. Idempotent: re-used by later shots. */
async function ensureResults(page) {
  const row = resultRow(page);
  if (await row.count()) return row;
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const search = page.getByPlaceholder(/search podcasts/i);
  await search.waitFor({ timeout: 30_000 });
  // Results resolve through /api/search and then per-podcast metadata. Waiting
  // for the row is what says the search came back; `networkidle` would never
  // fire, because this app keeps relay sockets open.
  //
  // RETRY THE WHOLE FILL, don't just wait longer. A fill that returned before
  // hydration is not slow, it is lost — the query never reached /api/search, so
  // no amount of waiting produces a row (see fillWhenHydrated). Clearing the box
  // between attempts matters: re-filling identical text sets no React state and
  // fires no search. Four attempts at 15 s costs less than the single 30 s wait
  // this replaced, and unlike it, an attempt that lost the query recovers.
  for (let attempt = 1; ; attempt += 1) {
    await fillWhenHydrated(search, query);
    try {
      await row.waitFor({ timeout: 15_000 });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.warn(`        the query did not reach /api/search — retyping (attempt ${attempt + 1})`);
      await search.fill('');
      await page.waitForTimeout(500);
    }
  }
  // Artwork is best-effort on purpose: <PodcastCover> falls back to a
  // colored-initial <div> when every candidate URL fails, so a row can
  // legitimately never hold an <img> and waiting hard for one would strand a
  // shot that was ready.
  await row.locator('img').first().waitFor({ timeout: 10_000 }).catch(() => {});
  return row;
}

/** Open the show, and leave its episode list on screen. Idempotent. */
async function ensureEpisodes(page) {
  if (await boostButton(page).count()) return;
  const row = await ensureResults(page);
  // Click the TITLE, not the row box and not the cover. <FavHeart> sits in the
  // same row and calls stopPropagation, so a click that lands on it toggles a
  // favorite — which for a signed-in user writes to the shared kind:10333 list
  // — instead of opening the show.
  await row.getByText(titleRe).first().click();
  await boostButton(page).waitFor({ timeout: 30_000 });
}

// Each shot brings the page to the state it needs rather than inheriting it
// from the shot before, so `--only 03` works on its own. The helpers above
// short-circuit when the state is already there, so a full run still navigates
// once.
const shots = [
  {
    id: '01',
    name: 'browse',
    label: 'Search Podcasting 2.0 shows',
    async run(page) {
      await ensureResults(page);
      await page.waitForTimeout(1500);
    },
  },
  {
    id: '02',
    name: 'episodes',
    label: 'An episode, its tracks and who they pay',
    async run(page) {
      await ensureEpisodes(page);
      await page.waitForTimeout(1500);
    },
  },
  {
    id: '03',
    name: 'boost',
    label: 'The boost modal with a real split',
    async run(page) {
      await ensureEpisodes(page);
      await boostButton(page).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 20_000 });
      // TYPE AN AMOUNT. The empty modal is a worse shot than it looks: the send
      // button reads "SEND 0 SAT" on a dimmed background and <SplitsPreview>
      // has nothing to allocate, so the one feature this shot exists to show —
      // who a boost pays, and how much each of them gets — renders as a list of
      // zeroes. A number makes splitSats do its largest-remainder pass and the
      // rows fill in. It is typed, never sent: no wallet is connected here, and
      // sending is a click this script never makes.
      const amount = dialog.getByPlaceholder(/enter amount/i);
      await amount.fill(BOOST_SATS);
      await page.waitForTimeout(1200);
      // Then bring the recipients into frame. The modal is taller than a phone
      // viewport, so the default scroll position cuts RECIPIENTS off mid-row.
      await amount.evaluate((el, top) => {
        const scroller = el.closest('[class*="overflow-y"]') ?? el.ownerDocument.scrollingElement;
        if (scroller) scroller.scrollTop = top;
      }, BOOST_SCROLL_PX);
      await page.waitForTimeout(1200);
    },
  },
];

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: !manual });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
const page = await context.newPage();
const rl = manual ? createInterface({ input: process.stdin, output: process.stdout }) : null;

let taken = 0;
let warned = 0;
try {
  for (const shot of shots) {
    if (only.length && !only.includes(shot.id)) continue;
    const path = `${OUT}/${shot.id}-${shot.name}.png`;
    try {
      if (manual) {
        await rl.question(`\n  ${shot.id} ${shot.label}\n  Navigate to it, then press Enter to shoot ${path}: `);
      } else {
        await shot.run(page);
      }
      await page.screenshot({ path });
      console.log(`  ok    ${path}`);
      taken += 1;
    } catch (e) {
      warned += 1;
      console.warn(`  WARN  ${shot.id}-${shot.name}: ${(e && e.message) || e}`);
      console.warn('        Live data moved, or this surface needs a specific show.');
      console.warn(`        Re-run with --manual --only ${shot.id} and drive to it by hand.`);
    }
  }
} finally {
  rl?.close();
  await browser.close();
}

console.log(`\n${taken} screenshot(s) written to ${OUT}/${warned ? `, ${warned} skipped` : ''}`);
if (!taken) {
  console.error('\nNothing was captured. Is the site reachable from here?');
  process.exit(1);
}
