// Generates public/icons/icon-512-maskable.png — the padded launcher icon.
//
// Usage — Playwright is deliberately not a dependency of this repo; the script
// finds a global install itself (see scripts/playwright-global.mjs):
//
//   node scripts/make-maskable-icon.mjs
//
// This is a one-shot generator in the probe-* family, not a check:* and not a
// CI step. Run it when the logo changes; commit the PNG it writes.
//
// WHY A SEPARATE FILE AND NOT `purpose: "maskable"` ON THE SHARED ICON:
//
// Android crops a maskable icon to a platform-chosen shape and only guarantees
// the inner 80% survives — a centred circle of radius 0.4 x 512 = 204.8px.
// The bolt in public/icon.svg spans x 128..384 and y 96..416, so its
// half-diagonal from the centre is 204.9px. It sits ON the boundary. Declaring
// that asset maskable does not add support, it opts into having the logo
// clipped on every launcher, which is worse than the non-maskable fallback
// (Android shrinks the icon inside a plate instead). docs/ui.md, "The maskable
// icon that wasn't", removed exactly that declaration and prescribes the
// repair: the same logo at ~66% scale on the #0a0a08 background, saved as its
// OWN file. 0.66 puts the half-diagonal at 135px, comfortably inside 204.8.
//
// WHY CHROMIUM AND NOT AN IMAGE LIBRARY: adding sharp for a once-a-year asset
// job would pull libvips into this repo's dependency tree, which next.config.mjs
// goes out of its way to keep unreachable. Playwright's Chromium is already
// here and renders the same SVG the browser would.
//
// The SVG source lives in this file rather than in public/: the script IS the
// reproducible source, and a second near-identical SVG in public/ is a thing to
// drift out of sync with icon.svg.

import { writeFileSync } from 'node:fs';
import { loadPlaywright } from './playwright-global.mjs';

const SIZE = 512;
/** docs/ui.md's number. Do not "improve" it without redoing the arithmetic above. */
const SCALE = 0.66;
const BG = '#0a0a08';
const BOLT = '#fae500';
/** Identical to the path in public/icon.svg. If that changes, change this. */
const PATH = 'M272 96 L128 288 L240 288 L240 416 L384 224 L272 224 Z';
const OUT = 'public/icons/icon-512-maskable.png';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>
  <g transform="translate(256,256) scale(${SCALE}) translate(-256,-256)">
    <path d="${PATH}" fill="${BOLT}"/>
  </g>
</svg>`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
  });
  // `margin: 0` matters — the default body margin would offset the artwork and
  // silently break the centring the safe-zone arithmetic depends on.
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;padding:0;background:${BG}}svg{display:block}</style>${svg}`,
    { waitUntil: 'load' },
  );
  const png = await page.screenshot({ type: 'png' });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${SIZE}x${SIZE}, logo at ${SCALE * 100}%)`);
} finally {
  await browser.close();
}
