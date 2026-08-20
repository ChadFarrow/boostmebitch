// Captures the phone screenshots the Zapstore listing and the web manifest
// both render.
//
// Usage:
//   node scripts/shoot-screenshots.mjs                       # against production
//   node scripts/shoot-screenshots.mjs http://localhost:3000 # against a dev server
//   node scripts/shoot-screenshots.mjs --manual              # drive it by hand
//   node scripts/shoot-screenshots.mjs --only 01,03
//
// A generator, not a check:*. It is deliberately NOT in CI: it needs a live
// site with real Podcast Index results behind it, and which episode looks good
// in a store listing is a human judgement call, not something to assert.
//
// Output lands in public/screenshots/ and is referenced from exactly one place
// each by public/manifest.json (`screenshots`) and zapstore.yaml (`images`), so
// there is no second copy of these files to drift.
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

const OUT = 'public/screenshots';
// A modern phone's logical size, portrait — matching the manifest's
// `orientation` and the narrow form factor both Zapstore and Chrome's install
// dialog want. deviceScaleFactor 2 makes the PNGs 824x1830.
const VIEWPORT = { width: 412, height: 915 };
const SCALE = 2;

const shots = [
  {
    id: '01',
    name: 'browse',
    label: 'Search Podcasting 2.0 shows',
    async run(page) {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      const search = page.getByPlaceholder(/search podcasts/i);
      await search.waitFor({ timeout: 30_000 });
      await search.fill(query);
      // Results resolve through /api/search and then per-podcast metadata, so
      // wait for artwork rather than for the network to go idle — this app
      // keeps relay sockets open and `networkidle` would never fire.
      await page.locator('img').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
    },
  },
  {
    id: '02',
    name: 'episodes',
    label: 'An episode, its tracks and who they pay',
    async run(page) {
      await page.locator('img').first().click();
      await page.getByLabel(/Boost this (episode|track)/i).first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
    },
  },
  {
    id: '03',
    name: 'boost',
    label: 'The boost modal with a real split',
    async run(page) {
      await page.getByLabel(/Boost this (episode|track)/i).first().click();
      await page.getByRole('dialog').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
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
