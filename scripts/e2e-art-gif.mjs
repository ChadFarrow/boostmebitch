// End-to-end for /api/art and an animated GIF cover LARGER than the route's
// byte ceiling (docs/ui.md, "The proxy takes frame one").
//
// Usage:
//   npm run dev                                   # in another terminal
//   npm run e2e:artgif
//   APP_URL=http://127.0.0.1:3041 npm run e2e:artgif
//
// WHY IT EXISTS. Baia Silko (Single) on mmmusic.show ships a 23,981,650-byte
// animated GIF as its cover. /api/art read every body with `readCappedBytes`,
// which throws as soon as `Content-Length` says more than MAX_ART_BYTES (12 MB),
// so the route answered 502 "decode failed" before decoding anything. The lock
// screen lists ONE artwork entry, the proxied one, so it showed no picture
// (Chad, iPhone, beta, 2026-11-13, issue #553); every in-app cover fell back to
// the raw 24 MB file. Frame one of that GIF ends at byte 110,262.
//
// WHAT IT PINS (plain HTTP, no browser):
//   1. The 24 MB GIF answers 200 image/webp at w=1024 and w=160, a still
//      picture of frame one (512x512), and the route stops reading early: it
//      answers well inside the 10 s upstream budget.
//   2. A small GIF still answers 200 image/webp (the path under the ceiling).
//   3. A non-GIF cover still answers 200 image/webp (the path this did not
//      change).
//
// THE FIXTURES ARE REAL, PUBLIC FILES, because `safeFetch` refuses a private
// address, so the route cannot be pointed at a local server. If one moves, the
// script says which; update the constant, as e2e:resume's header says for its
// feed.

import { createRequire } from 'node:module';
import { checker, exit, requireApp } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
await requireApp(APP, 'Start the app first: npm run dev');
const sharp = createRequire(import.meta.url)('sharp');
const t = checker();

const BIG_GIF = 'https://mmmusic.show/msp/Baiasilko/Baiasilko_movie.gif';
const SMALL_GIF = 'https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif'; // 1,001,718 bytes, animated
const PNG = 'https://noagendaassets.com/enc/1684513486.722_pcifeedimage.png'; // Podcasting 2.0's own cover

async function art(url, w) {
  const started = Date.now();
  const res = await fetch(`${APP}/api/art?url=${encodeURIComponent(url)}&w=${w}`, { cache: 'no-store' });
  const ms = Date.now() - started;
  const body = Buffer.from(await res.arrayBuffer());
  let meta = null;
  if (res.ok) {
    try { meta = await sharp(body, { animated: true }).metadata(); } catch { /* not an image */ }
  }
  return { status: res.status, type: res.headers.get('content-type'), bytes: body.byteLength, ms, meta,
    error: res.ok ? null : body.toString('utf8').slice(0, 80) };
}

// Is the fixture still what the header says it is?
async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return { status: r.status, type: r.headers.get('content-type'), length: Number(r.headers.get('content-length')) };
  } catch (e) { return { status: 0, error: String(e) }; }
}

// ---------------------------------------------------------------------------
console.log('\n1. A GIF over the 12 MB ceiling: frame one, early');
const h = await head(BIG_GIF);
t.ok('the fixture is still a GIF over 12 MB', h.status === 200 && /gif/.test(h.type ?? '') && h.length > 12 * 1024 * 1024, JSON.stringify(h));
for (const w of [1024, 160]) {
  const r = await art(BIG_GIF, w);
  t.ok(`w=${w}: 200 image/webp, not "decode failed"`, r.status === 200 && r.type === 'image/webp', JSON.stringify(r));
  t.ok(`w=${w}: one still frame`, r.meta && (r.meta.pages ?? 1) === 1, JSON.stringify(r.meta && { format: r.meta.format, pages: r.meta.pages }));
  t.ok(`w=${w}: no wider than ${w} and no wider than the source's 512`,
    r.meta && r.meta.width <= Math.min(w, 512) && r.meta.width > 0, JSON.stringify(r.meta && { w: r.meta.width, h: r.meta.height }));
  t.ok(`w=${w}: answered in under 5 s (it stops reading once frame one is in)`, r.ms < 5000, `${r.ms} ms`);
}

// ---------------------------------------------------------------------------
console.log('\n2. An animated GIF under the ceiling');
const s = await art(SMALL_GIF, 160);
t.ok('200 image/webp', s.status === 200 && s.type === 'image/webp', JSON.stringify(s));
t.ok('one still frame', s.meta && (s.meta.pages ?? 1) === 1, JSON.stringify(s.meta && { pages: s.meta.pages }));

// ---------------------------------------------------------------------------
console.log('\n3. A PNG cover, the path this did not change');
const j = await art(PNG, 160);
t.ok('200 image/webp', j.status === 200 && j.type === 'image/webp', JSON.stringify(j));

// ---------------------------------------------------------------------------
console.log(`\n${t.count - t.fails} of ${t.count} passed`);
await exit(t.fails ? 1 : 0);
