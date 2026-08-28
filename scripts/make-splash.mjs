// Generates public/splash/*.png — the iOS PWA launch images named by
// `appleWebApp.startupImage` in app/layout.tsx.
//
// Usage — Playwright is deliberately not a dependency of this repo; the script
// finds a global install itself (see scripts/playwright-global.mjs):
//
//   node scripts/make-splash.mjs            # write every size
//   node scripts/make-splash.mjs --check    # write nothing; compare to disk
//
// This is a one-shot generator in the make-* family beside
// make-maskable-icon.mjs, not a check:* and not a CI step. Run it when the logo
// changes or a new iPhone size appears; commit the PNGs it writes.
//
// WHY THIS EXISTS AT ALL: iOS picks the launch image whose media query matches
// the device's CSS dimensions and DPR *exactly*, and shows a WHITE screen when
// nothing matches — on an app whose every surface is near-black. There is no
// fallback and no partial credit, so each new iPhone geometry is a new file.
// The seven original PNGs were made by hand and had no generator, which is how
// the list came to stop at the iPhone 15 while the 16, 17 and Air shipped.
//
// WHY CHROMIUM AND NOT AN IMAGE LIBRARY: the same reason make-maskable-icon.mjs
// gives. `sharp` is in this repo's dependencies for /api/art, but reaching for
// it here would put libvips in the path of an asset job for no gain — Playwright
// already renders the same SVG a browser would, and the two generators then
// share one rendering model rather than drifting into two.
//
// THE GEOMETRY IS DERIVED FROM THE COMMITTED ART, NOT CHOSEN. Measuring the
// yellow bounding box in all seven original PNGs gives a bolt width of
// 0.1479, 0.1488, 0.1484, 0.1481, 0.1480, 0.1484 and 0.1473 of the canvas
// width, centred at 0.500 on both axes. So BOLT_WIDTH_RATIO is 0.148 and the
// logo is centred — and `--check` re-derives that from disk rather than trusting
// this comment. A generator that cannot reproduce the art already shipped is not
// trustworthy enough to produce the art that has not.
//
// The bolt is centred inside its own 512 viewBox — the path spans x 128..384 and
// y 96..416, whose midpoint is (256, 256) — so centring the icon box centres the
// logo, with no per-axis offset to get wrong.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadPlaywright } from './playwright-global.mjs';

const BG = '#0a0a08';
const BOLT = '#fae500';
/** Identical to the path in public/icon.svg. If that changes, change this. */
const PATH = 'M272 96 L128 288 L240 288 L240 416 L384 224 L272 224 Z';
/** The icon.svg viewBox the path above is authored in. */
const BOX = 512;
/** The bolt occupies x 128..384 of that box, i.e. half its width. */
const BOLT_IN_BOX = 0.5;
/** Measured off the seven committed PNGs. See the header. */
const BOLT_WIDTH_RATIO = 0.148;

/**
 * Every iPhone geometry iOS will ask us for, portrait only.
 *
 * `pt` is the CSS size the media query matches on; `px` is `pt * 3` (or `* 2`
 * for the two @2x devices) and is what the PNG must actually be. iPad and
 * landscape are deliberately absent — they fall back to white, which
 * app/layout.tsx has always said is acceptable.
 *
 * Devices sharing a geometry share a file: the iPhone 16 is 393x852, the same
 * as the 14 Pro, so it needs no new asset. Only three geometries are new.
 */
const DEVICES = [
  { file: 'iphone-se-8', pt: [375, 667], dpr: 2, who: 'iPhone SE 2nd/3rd gen, 6/7/8' },
  { file: 'iphone-xr-11', pt: [414, 896], dpr: 2, who: 'iPhone XR, 11' },
  { file: 'iphone-x-xs-11pro-12mini-13mini', pt: [375, 812], dpr: 3, who: 'iPhone X, XS, 11 Pro, 12/13 mini' },
  { file: 'iphone-12-13-14', pt: [390, 844], dpr: 3, who: 'iPhone 12, 13, 14, 12/13 Pro' },
  { file: 'iphone-14pro-15-15pro', pt: [393, 852], dpr: 3, who: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { file: 'iphone-16pro-17-17pro', pt: [402, 874], dpr: 3, who: 'iPhone 16 Pro, 17, 17 Pro' },
  { file: 'iphone-air', pt: [420, 912], dpr: 3, who: 'iPhone Air' },
  { file: 'iphone-12-13promax-14plus', pt: [428, 926], dpr: 3, who: 'iPhone 12/13 Pro Max, 14 Plus' },
  { file: 'iphone-14promax-15plus-15promax', pt: [430, 932], dpr: 3, who: 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus' },
  { file: 'iphone-16promax-17promax', pt: [440, 956], dpr: 3, who: 'iPhone 16 Pro Max, 17 Pro Max' },
];

function svgFor(w, h) {
  // The icon box is sized so the bolt inside it lands at BOLT_WIDTH_RATIO of
  // the canvas: box * BOLT_IN_BOX = w * BOLT_WIDTH_RATIO.
  const box = (w * BOLT_WIDTH_RATIO) / BOLT_IN_BOX;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${BG}"/>
  <svg x="${(w - box) / 2}" y="${(h - box) / 2}" width="${box}" height="${box}" viewBox="0 0 ${BOX} ${BOX}">
    <path d="${PATH}" fill="${BOLT}"/>
  </svg>
</svg>`;
}

/** The yellow bounding box, as fractions of the canvas. Used by --check. */
async function boltBox(page, png) {
  return page.evaluate(
    (dataUrl) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
          for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
              const i = (y * c.width + x) * 4;
              if (data[i] > 180 && data[i + 1] > 160 && data[i + 2] < 120) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
              }
            }
          }
          resolve({
            w: c.width, h: c.height,
            widthRatio: (x1 - x0 + 1) / c.width,
            cx: ((x0 + x1 + 1) / 2) / c.width,
            cy: ((y0 + y1 + 1) / 2) / c.height,
          });
        };
        img.src = dataUrl;
      }),
    png,
  );
}

const check = process.argv.includes('--check');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
let failures = 0;
try {
  for (const d of DEVICES) {
    const [w, h] = [d.pt[0] * d.dpr, d.pt[1] * d.dpr];
    const out = `public/splash/${d.file}.png`;
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    // `margin: 0` matters — the default body margin would offset the artwork
    // and silently break the centring the ratios above are measured against.
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0;background:${BG}}svg{display:block}</style>${svgFor(w, h)}`,
      { waitUntil: 'load' },
    );

    if (check) {
      if (!existsSync(out)) {
        console.log(`MISSING  ${out}`);
        failures++;
      } else {
        const b = await boltBox(page, `data:image/png;base64,${readFileSync(out).toString('base64')}`);
        // 0.003 is a shade over the spread across the seven originals (0.1473
        // to 0.1488), so this passes on the committed art and fails on a real
        // change of scale or position.
        const ok =
          b.w === w && b.h === h &&
          Math.abs(b.widthRatio - BOLT_WIDTH_RATIO) < 0.003 &&
          Math.abs(b.cx - 0.5) < 0.003 && Math.abs(b.cy - 0.5) < 0.003;
        if (!ok) failures++;
        console.log(
          `${ok ? 'ok      ' : 'MISMATCH'} ${d.file.padEnd(34)} ${b.w}x${b.h} ` +
            `bolt=${b.widthRatio.toFixed(4)} centre=${b.cx.toFixed(4)},${b.cy.toFixed(4)}`,
        );
      }
    } else {
      writeFileSync(out, await page.screenshot({ type: 'png' }));
      console.log(`wrote ${out.padEnd(52)} ${w}x${h}  (${d.pt[0]}x${d.pt[1]} @${d.dpr}x — ${d.who})`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
if (check) {
  console.log(failures ? `\n${failures} file(s) do not match the generator.` : '\nAll splash art matches the generator.');
  process.exit(failures ? 1 : 0);
}
