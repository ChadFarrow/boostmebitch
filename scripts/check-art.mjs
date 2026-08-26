// Pins the artwork proxy's two pure decisions: which widths /api/art will
// serve, and the order a cover falls back through when the proxy cannot.
//
// Usage:
//   npm run check:art
//
// Run it after ANY edit to `artWidth`/`artCandidates` in lib/util.ts,
// app/api/art/route.ts, or components/podcast-cover.tsx.
//
// Why this earns a check script. Neither half fails loudly.
//
// `artWidth` is the ALLOWLIST, and it is the only thing standing between a
// query parameter and our own CPU. The route decodes a feed-supplied image —
// up to 12 MB of it — and re-encodes it at whatever size it is asked for.
// Widen this to "any integer" and one URL becomes an unbounded family of cache
// keys, each one a cold miss that costs a full decode-and-resize: the CDN stops
// absorbing anything and every request reaches the function. That is a cheap
// amplification lever pointed at the site's own bill, and nothing about it
// looks like an outage while it is happening. The must-still-work half matters
// as much and is why the exemptions below are named one at a time: reject a
// width the app actually asks for and every cover on that surface 400s, which
// the component then papers over by falling back to the raw third-party URL —
// so the proxy silently stops working and the only symptom is the slowness it
// was built to remove.
//
// `artCandidates` is the FALLBACK LADDER, and its whole job is that this
// feature can never make things worse than not having it. The proxied URLs
// must come first (or nothing is ever optimised) and the ORIGINAL URLs must
// still be there behind them (or a broken proxy blanks every cover in the
// app). Drop the raw tail and the failure is total, delayed, and looks like a
// CDN problem. Reorder it and the feature does nothing at all while appearing
// to be installed. `<PodcastCover>` renders on twelve surfaces through one
// component, so both mistakes ship everywhere at once.
//
// The arithmetic therefore lives in lib/util.ts, whose only import is type-only
// and therefore erased by type stripping, so it loads under
// `node --experimental-strip-types` and this script imports the REAL functions. A copy here would stay green while
// the shipping code drifted, which is the exact failure the arrangement exists
// to prevent.
//
// EVERY VECTOR IS A RECORDED CALL, NOT A BARE ASSERTION. `naiveWidth` and
// `naiveCandidates` at the foot are the obvious wrong versions — the first
// trusts the query parameter, the second forgets the raw fallbacks — and the
// whole list is replayed against them, because a vector that passes the moment
// it is written has proved nothing. Recording the ARGUMENTS is what makes the
// replay total: a vector cannot be added without also being proved.
//
// Exemptions are named one at a time with `alsoNaive: true`, never as a
// default: a legitimate input the wrong implementation also handles is a
// property of that input, not a hole in the suite.

import { artWidth, artCandidates, artTypeVerdict, ART_WIDTHS, DEFAULT_ART_WIDTH } from '../lib/util.ts';

let failures = 0;

/** Every recorded call, replayed against the wrong implementations below. */
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

/** An artWidth vector. `alsoNaive` marks a must-still-work input. */
function checkWidth(label, input, expected, { alsoNaive = false } = {}) {
  compare(label, artWidth(input), expected);
  vectors.push({ label, kind: 'width', args: [input], alsoNaive });
}

/** An artCandidates vector. `alsoNaive` marks a must-still-work input. */
function checkCandidates(label, image, artwork, width, expected, { alsoNaive = false } = {}) {
  compare(label, artCandidates(image, artwork, width), expected);
  vectors.push({ label, kind: 'cand', args: [image, artwork, width], alsoNaive });
}

/** An artTypeVerdict vector. `alsoNaive` marks a must-still-work input. */
function checkType(label, input, expected, { alsoNaive = false } = {}) {
  compare(label, artTypeVerdict(input), expected);
  vectors.push({ label, kind: 'type', args: [input], alsoNaive });
}

function section(name) {
  console.log(`\n${name}`);
}

// Real artwork URLs, taken from the live feed on 2026-08-25. Feed data carries
// shapes nobody thinks to invent — note the query string on the imgix one,
// which is exactly what a hand-rolled `url + '?w=' + w` concatenation breaks.
const COVER = 'https://feeds.fountain.fm/R8scBF2Wiykm0YVldsHQ/cover.jpg';
const ALT = 'https://assets.podhome.fm/abc/def-artwork.png';
const QUERY = 'https://megaphone.imgix.net/podcasts/x.jpg?ixlib=rails-4.3.1&w=3000';

const enc = (u, w) => `/api/art?url=${encodeURIComponent(u)}&w=${w}`;

// ---------------------------------------------------------------------------
section('artWidth — the allowlist is the whole guard');
// ---------------------------------------------------------------------------

// The four the app asks for. Each must survive, or the surface using it loses
// the proxy entirely and silently reverts to the raw third-party URL.
for (const w of [160, 320, 640, 1024]) {
  checkWidth(`${w} is allowed`, String(w), w, { alsoNaive: true });
}

// Every call site that does not care about size lands here, so both must keep
// working — and a wrong implementation gets them right, which is a property of
// the input rather than a hole. Exempted deliberately, one at a time.
checkWidth('absent falls back to the default', null, DEFAULT_ART_WIDTH, { alsoNaive: true });
checkWidth('empty string falls back to the default', '', DEFAULT_ART_WIDTH, { alsoNaive: true });

// The refusals. A wrong-but-plausible number is the one that costs money: it
// is a legal integer, it renders correctly, and it is a brand new cache key.
checkWidth('321 is refused — a near miss is still a new cache key', '321', null);
checkWidth('2048 is refused — above the largest we serve', '2048', null);
checkWidth('1 is refused', '1', null);
checkWidth('0 is refused', '0', null);
checkWidth('negative is refused', '-320', null);

// Shapes that a `Number()` or `parseInt` guard lets through. `parseInt` is the
// dangerous one: it stops at the first non-digit and happily returns 320.
checkWidth('"320abc" is refused — parseInt would return 320', '320abc', null);
checkWidth('" 320" with whitespace is refused', ' 320', null);
checkWidth('"320.0" is refused', '320.0', null);
checkWidth('"0x140" is refused — Number() reads this as 320', '0x140', null);
checkWidth('"3e2" is refused — Number() reads this as 300', '3e2', null);
checkWidth('"+320" is refused', '+320', null);
checkWidth('Infinity is refused', 'Infinity', null);
checkWidth('NaN is refused', 'NaN', null);
checkWidth('an array-ish repeated param is refused', '320,320', null);

// ---------------------------------------------------------------------------
section('artCandidates — proxied first, raw ALWAYS behind it');
// ---------------------------------------------------------------------------

checkCandidates(
  'both URLs: proxied pair first, then the raw pair',
  COVER, ALT, 320,
  [enc(COVER, 320), enc(ALT, 320), COVER, ALT],
);

checkCandidates(
  'image only',
  COVER, null, 320,
  [enc(COVER, 320), COVER],
);

checkCandidates(
  'artwork only — a feed whose channel <image> is dead',
  null, ALT, 640,
  [enc(ALT, 640), ALT],
);

checkCandidates(
  'a URL that already carries a query string is encoded, not concatenated',
  QUERY, null, 160,
  [enc(QUERY, 160), QUERY],
);

checkCandidates(
  'identical image and artwork are not offered twice',
  COVER, COVER, 320,
  [enc(COVER, 320), COVER],
);

checkCandidates(
  'neither URL yields no candidates, so the initial tile renders',
  null, null, 320,
  [],
  { alsoNaive: true },
);

checkCandidates(
  'empty strings are not URLs',
  '', '', 320,
  [],
  { alsoNaive: true },
);

// A data: URL is already inline — proxying it would upload the bytes back to
// ourselves to hand them straight back. safeFetch would refuse it anyway.
checkCandidates(
  'a data: URL is passed through raw, never proxied',
  'data:image/png;base64,iVBORw0KGgo=', null, 320,
  ['data:image/png;base64,iVBORw0KGgo='],
);

// A relative path cannot be fetched server-side, and safeFetch rejects it.
checkCandidates(
  'a relative path is passed through raw',
  '/local/cover.png', null, 320,
  ['/local/cover.png'],
);

checkCandidates(
  'http is proxied too — upgrading it to https is the proxy\'s job, not ours',
  'http://mmmusic.show/cover.jpg', null, 320,
  [enc('http://mmmusic.show/cover.jpg', 320), 'http://mmmusic.show/cover.jpg'],
);

// ---------------------------------------------------------------------------
section('artTypeVerdict — refuse documents, let the decoder judge the rest');
// ---------------------------------------------------------------------------

// Ordinary covers. A strict image/* prefix test gets all of these right, which
// is a property of the inputs rather than a hole — exempted one at a time so
// the exemption can never become the default.
for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']) {
  checkType(`${t} decodes`, t, 'decode', { alsoNaive: true });
}
checkType('a charset parameter is ignored', 'image/jpeg; charset=binary', 'decode', { alsoNaive: true });
checkType('case and padding are normalised', '  IMAGE/JPEG  ', 'decode', { alsoNaive: true });

// The two shapes measured on the live feed. Both are real JPEGs whose host
// declines to say so, and a strict image-type list drops them silently.
checkType('application/octet-stream decodes — measured on a live cover', 'application/octet-stream', 'decode');
checkType('a malformed image/* decodes — measured on a live cover', 'image/*', 'decode', { alsoNaive: true });
checkType('a missing header decodes', null, 'decode');
checkType('an empty header decodes', '', 'decode');

// SVG is the one that matters. It is a document that can carry external
// references and scripts, and it has no business reaching a rasteriser.
checkType('image/svg+xml is REFUSED', 'image/svg+xml', 'refuse');
checkType('image/svg is REFUSED', 'image/svg', 'refuse');
checkType('a charset-tagged svg is REFUSED', 'image/svg+xml; charset=utf-8', 'refuse');
checkType('uppercase SVG is REFUSED', 'IMAGE/SVG+XML', 'refuse');

// Other documents. A feed serving these to an <img> is broken, and 415 says so.
checkType('text/html is refused', 'text/html', 'refuse', { alsoNaive: true });
checkType('application/rss+xml is refused', 'application/rss+xml', 'refuse', { alsoNaive: true });
checkType('application/json is refused', 'application/json', 'refuse', { alsoNaive: true });
checkType('audio is refused', 'audio/mpeg', 'refuse', { alsoNaive: true });

// ---------------------------------------------------------------------------
section('ART_WIDTHS is what the route and the component share');
// ---------------------------------------------------------------------------
{
  const listed = JSON.stringify([...ART_WIDTHS].sort((a, b) => a - b));
  compare('the allowlist is exactly 160/320/640/1024', listed, JSON.stringify([160, 320, 640, 1024]));
  compare('the default is a member of the allowlist', ART_WIDTHS.includes(DEFAULT_ART_WIDTH), true);
}

// ---------------------------------------------------------------------------
section('every vector replayed against the wrong implementations');
// ---------------------------------------------------------------------------
{
  /** Trusts the query parameter. Number() accepts hex, exponents and padding. */
  const naiveWidth = (raw) => (raw ? Number(raw) : DEFAULT_ART_WIDTH);

  /** The strict image-type allowlist this replaced. It is *almost* right, which
   *  is the problem: it refuses two real covers on the live feed and, worse,
   *  accepts image/svg+xml because that string does start with "image/". */
  const naiveType = (ct) => {
    const t = (ct ?? '').split(';')[0].trim().toLowerCase();
    return t.startsWith('image/') ? 'decode' : 'refuse';
  };

  /** Proxies everything and forgets the raw fallbacks — the total-failure shape. */
  const naiveCandidates = (image, artwork, width) => {
    const out = [];
    if (image) out.push(enc(image, width));
    if (artwork && artwork !== image) out.push(enc(artwork, width));
    return out;
  };

  // `JSON.stringify` is NOT usable as the comparison here, and that is not a
  // detail. It renders NaN and Infinity as the literal `null` — the same text
  // as a real refusal — so every vector probing a `Number()` guard (`'320abc'`,
  // `'Infinity'`, `'NaN'`, `'320,320'`) silently read as "naive gets this right
  // too" and would have been deleted as proving nothing. They prove the most.
  const repr = (v) => (Array.isArray(v) ? JSON.stringify(v) : `${typeof v}:${String(v)}`);

  const call = (which, v) => {
    try {
      if (v.kind === 'width') {
        return repr(which === 'real' ? artWidth(...v.args) : naiveWidth(...v.args));
      }
      if (v.kind === 'type') {
        return repr(which === 'real' ? artTypeVerdict(...v.args) : naiveType(...v.args));
      }
      return repr(which === 'real' ? artCandidates(...v.args) : naiveCandidates(...v.args));
    } catch (e) {
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
      return `threw ${(e && e.message) || e}`;
    }
  };

  let exempt = 0;
  for (const v of vectors) {
    const differs = call('real', v) !== call('naive', v);
    if (v.alsoNaive) {
      exempt += 1;
      console.log(`  ok    "${v.label}" is must-still-work — naive() may get it right`);
      continue;
    }
    if (differs) {
      console.log(`  ok    naive() gets "${v.label}" wrong`);
      continue;
    }
    failures += 1;
    console.error(`  FAIL  "${v.label}" passes against naive() too — the vector proves nothing.`);
    console.error('          Either it is a must-still-work input (mark it { alsoNaive: true })');
    console.error('          or it does not exercise anything the real module adds.');
  }
  console.log(`  ${vectors.length} vector(s) replayed, ${exempt} exempt as must-still-work`);
}

// lib/util.ts is deliberately NOT scanned by scripts/import-free.mjs, and
// adding that scan here would fail the run for a correct file. That scan
// rejects type-only relative imports on purpose, and util.ts has one —
// `import type { Podcast, ... } from './types'`. It is fine: type-only imports
// are erased by type stripping, so the module loads under plain Node, which is
// all this script needs. The eight modules the scan does enforce are ones with
// NO imports at all; util.ts is not one of them. check:vts imports util.ts the
// same way and does not scan it either.

if (failures) {
  console.error(`\n${failures} art check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll art checks passed.');
