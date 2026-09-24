// Measures what each artwork surface PAYS for one chapter image, in a real
// browser, on the feed the report came from.
//
// WHY THIS IS AN E2E AND NOT A `check:*`. `artCandidates` is pinned by
// `npm run check:art` and every one of its vectors was green while this was
// live: the fault is in WHICH SURFACE PASSES WHAT. Three surfaces render the
// now-playing art — the 48px now-playing tile, the fullscreen player's big
// cover, and the OS lock screen through `MediaMetadata` — and each one decides
// separately whether it takes the proxied copy or the file the feed published.
// No pure function sees that, and no DOM assertion sees the lock screen at all,
// because its fetch is issued by the browser with no element behind it.
//
// THE FAULT IT WAS WRITTEN AGAINST. Reported from an iPhone: *"This is a GIF
// but it only plays in the now playing bar at the bottom."* True, and backwards
// — the 48px tile was the ONE surface on the raw URL, so it was the only one
// that animated, while paying 4,472,805 bytes for a thumbnail on the same
// connection the audio streams over. Measured 2026-09-21 on this episode,
// before the fix: 11,555,231 raw bytes for chapter art with the player
// COLLAPSED, of which the lock screen's two fetches were 10.8 MB and nothing on
// any screen was showing them.
//
// WHAT IT ASSERTS, and each is a different way to get artwork wrong:
//   1. the 48px tile is the PROXIED copy at w=160 — a tile must be cheap;
//   2. a COLLAPSED player fetches no original at all — the lock screen included,
//      which is what makes this more than a styling change;
//   3. the big cover IS the original once the player is open — that is the
//      animation the report asked for, and `naturalWidth` proves it is the
//      published file rather than a proxied resize.
//
// THE EPISODE IS THE FIXTURE. Mutton, Mead & Music, chapter "THANK YOU CAKE
// WALLET" (1:29–4:04), whose `img` is a 4.4 MB animated GIF, with a second
// animated chapter earlier in the same episode. If it ever leaves the feed,
// replace the three constants with any episode carrying a chapters JSON whose
// images are far larger than a thumbnail; the assertions are about which copy
// each surface takes, not about this show.
//
//   npm run build && npm start          # in another terminal
//   npm run e2e:artbytes                # add --headed to watch it
//
// It needs the network: the enclosure, the chapters JSON, and Podcast Index
// through the app's routes.
import { checker, exit, launchChrome, requireApp, wait } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const POD = '290e12c3-91a7-5c30-be14-1837a1a976e2';
const EPISODE_GUID = '21f6be5b-02b7-43e9-b00c-309130dcf151';
/** Inside the animated chapter, clear of both edges. */
const INSIDE_CHAPTER = 150;
/** The host every image in this episode is served from. */
const ASSET_HOST = /assets\.podhome\.fm/;
/** Bigger than any proxied copy at any allowed width, smaller than one GIF. */
const ORIGINAL_BYTES = 1_000_000;

await requireApp(`${APP}/privacy`,
  `Nothing is serving ${APP}. Start it with \`npm start\` (after \`npm run build\`) in another terminal.`);

const t = checker();
const { page } = await launchChrome({ name: 'artbytes', autoplay: true });
const { send, js, on } = page;

// Every finished response, by URL. `encodedDataLength` is what went over the
// wire, which is the number this is about — `Content-Length` is not always sent
// and a decoded size is not what the listener's connection paid.
const urlOf = new Map();
const wire = [];
on((m) => {
  if (m.method === 'Network.requestWillBeSent') urlOf.set(m.params.requestId, m.params.request.url);
  if (m.method === 'Network.loadingFinished') {
    const url = urlOf.get(m.params.requestId);
    if (url) wire.push({ url, bytes: m.params.encodedDataLength });
  }
});

/** Third-party image bytes taken straight from the feed's host, i.e. NOT
 *  through /api/art. The chapters and transcript routes live on our origin and
 *  carry the asset host inside a query string, so the proxy test comes first. */
const originals = (from) => wire.slice(from).filter(
  (r) => ASSET_HOST.test(r.url) && !/\/api\//.test(r.url) && r.bytes > ORIGINAL_BYTES,
);
const total = (rows) => rows.reduce((n, r) => n + r.bytes, 0);

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// A phone, because that is where this was reported and where a 3x device pixel
// ratio decides which width the tile is entitled to ask for.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Page.navigate', { url: `${APP}/?podcast=${POD}&episode=${EPISODE_GUID}` });
await wait(9000);
await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^\\s*(▶|PLAY)/i.test(x.textContent)); b && b.click(); return !!b; })()`);
await wait(5000);
await js(`(() => { const a = document.querySelector('audio'); if (a) a.currentTime = ${INSIDE_CHAPTER}; return true; })()`);
// Long enough for the chapter art to paint AND for the lock-screen metadata to
// settle — that one waits 3 s for the artwork to hold still before it fetches.
await wait(9000);

const at = await js(`(() => { const a = document.querySelector('audio'); return a ? Math.round(a.currentTime) : null; })()`);
t.ok('the play head is inside the animated chapter', at !== null && at >= INSIDE_CHAPTER, `at ${at}s`);

const tile = await js(`(() => {
  const im = [...document.images].find(i => { const r = i.getBoundingClientRect();
    return Math.round(r.width) === 48 && Math.round(r.height) === 48; });
  return im ? { src: decodeURIComponent(im.currentSrc), w: im.naturalWidth } : null; })()`);
t.ok('the 48px now-playing tile renders the PROXIED copy', !!tile && /\/api\/art\?/.test(tile.src), String(tile && tile.src));
t.ok('...at w=160, which is 48 CSS px at a phone\'s 3x', !!tile && /[?&]w=160(&|$)/.test(tile.src), String(tile && tile.src));

const collapsed = originals(0);
console.log(`collapsed: ${collapsed.length} original(s), ${total(collapsed).toLocaleString()} bytes`);
for (const r of collapsed) console.log(`   ${r.bytes.toLocaleString().padStart(11)}  ${r.url}`);
// The lock screen is in here. It has no element, so this byte count is the only
// place its fetch is visible at all.
t.ok('a COLLAPSED player fetches no original — tile and lock screen both proxied',
  collapsed.length === 0, `${collapsed.length} original(s), ${total(collapsed).toLocaleString()} bytes`);

const mark = wire.length;
const bar = await js(`(() => { const d = document.querySelector('[aria-label="Open fullscreen player"]');
  if (!d) return null; const r = d.getBoundingClientRect();
  return { x: Math.round(r.x + r.width * 0.45), y: Math.round(r.y + 22) }; })()`);
t.ok('the now-playing bar is on screen', !!bar, JSON.stringify(bar));
// A real pointer event: the bar's inner controls call stopPropagation, so a
// synthetic element.click() on the wrapper expands nothing.
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: bar.x, y: bar.y, button: 'left', clickCount: 1 });
}
await wait(9000);

const hero = await js(`(() => {
  const im = [...document.images].filter(i => { const r = i.getBoundingClientRect();
    return r.width > 200 && Math.abs(r.width - r.height) < 40 && !/hero\\.jpg/.test(i.currentSrc); })[0];
  return im ? { src: decodeURIComponent(im.currentSrc), w: im.naturalWidth, box: Math.round(im.getBoundingClientRect().width) } : null; })()`);
console.log(`big cover: ${hero && hero.box}px box, ${hero && hero.w}px file, ${hero && hero.src}`);
t.ok('the big cover renders the ORIGINAL file, which is what animates',
  !!hero && ASSET_HOST.test(hero.src) && !/\/api\/art/.test(hero.src), String(hero && hero.src));
// A proxied copy is exactly the width it was asked for. Anything else is the
// published file, and this is what tells the two apart without trusting a URL.
t.ok('...proved by its natural width, not by the URL', !!hero && hero.w !== 640 && hero.w > 0, `naturalWidth ${hero && hero.w}`);

const opened = originals(mark);
console.log(`opened: ${opened.length} original(s), ${total(opened).toLocaleString()} bytes`);
t.ok('opening the player is what pays for the animation, and only then', opened.length >= 1,
  `${opened.length} original(s)`);

console.log(t.fails ? `\n${t.fails} of ${t.count} art-byte checks FAILED.` : `\nAll ${t.count} art-byte checks passed.`);
await exit(t.fails ? 1 : 0);
