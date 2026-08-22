// Pins the GIF first-frame cut that `/api/og/boost.png` uses on animated cover
// art.
//
// Usage:
//   npm run check:gif
//   CHECK_GIF_FILE=/path/to/real.gif npm run check:gif   # extra, opt-in
//
// Run it after ANY edit to lib/gif-first-frame.ts.
//
// Why this earns a check script. The input is attacker-chosen bytes from a
// podcast feed, walked by offsets the file itself supplies, inside a request
// that has to answer — and the caller hands it a DELIBERATELY TRUNCATED prefix,
// so "the file ends mid-frame" is the ordinary case rather than the exotic one.
// Both failure directions are silent:
//
//   - read one byte too far and the cut GIF is corrupt, which surfaces as a
//     banner with an empty left third, indistinguishable from the "artwork is
//     missing" case this feature exists to fix;
//   - treat "need more bytes" as "malformed" and every animated cover falls
//     through to a channel-level URL, which on Homegrown Hits is a DIFFERENT,
//     older cover — the banner then advertises the wrong artwork with no error
//     anywhere.
//
// Fixtures are real encoder output (Pillow) and a real 4 KB prefix of the
// Homegrown Hits episode artwork — the 19 MB GIF87a that caused this. Nothing
// here is a byte array written by hand from the parser's own assumptions, which
// is the fixture that cannot fail. Every vector is recorded as a CALL and
// replayed against `naive()` at the foot of this file, so a vector cannot be
// added without also being proved to bite.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module.

import { firstFrameEnd, firstGifFrame } from '../lib/gif-first-frame.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
    failures++;
  }
}

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// ── Fixtures ────────────────────────────────────────────────────────────────
// A real 3-frame animated GIF89a: NETSCAPE looping extension, a Graphic Control
// Extension per frame, one global colour table.
const ANIM = b64(
  'R0lGODlhCAAIAIEAAMgeHgAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAAIEAADABhIsKDBgwgTKlyYMCAAIfkEAQoAAgAsAAAAAAgACAAACBAAAwAYSLCgwYMIEypcmDAgACH5BAEKAAIALAAAAAAIAAgAAAgQAAMAGEiwoMGDCBMqXJgwIAA7',
);
// The same encoder, single frame, GIF87a.
const STILL = b64('R0lGODdhCAAIAIEAAMgeHgAAAAAAAAAAACwAAAAACAAIAAAIEAADABhIsKDBgwgTKlyYMCAAOw==');
// A real PNG — a non-GIF must be refused, not mis-walked.
const PNG = b64(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGPk4uJigAEmOAsvBwAG4AAmg6ZUxwAAAABJRU5ErkJggg==',
);
// The first 4096 bytes of the REAL Homegrown Hits episode artwork: GIF87a with a
// full 256-colour global colour table. In the whole file the first frame ends at
// byte 606,584, so a prefix this short must read as "need more" — never as
// malformed, and never as an end offset.
const REAL_PREFIX = b64('R0lGODdhAAUABfcAAAAAAAIBCwMCEwMCHQoCBAsCDAsCHgwDEwgGKwgHNhMHHxQHMBUISBwJIR4JMCEJOyYJSgMLDwgLHg0LEQIMAxQOYSkSXg4TEyoTbgMWEQMWHg8WNhUWSSAWNwwXHxMXHx0XIR8XKygXQykXTzUXSDcXWDcXYzgXbw4YKy0YN0IZf0YZbTEchA8eE4Ejm0YkkJoktA8lIRAmKx0mIx4miyAnLCUnZS8nOTknV0Unf1knhhEoNT0oZD8ob1oolx8pNg0qhw0qkzkqSAornkcsWaIsyCgtSE8taFAtdHktsxcvRk4vqhk0umI1pmU1uRc2OCc2MU02f082kxY3zxQ4KCo4PGA4hmI4mCE5l3U9j1M+bXk+nx8/STA/REk/VQJBUTFBTn1Dx3ZFs4xGtcRG8AJHXSVH20xHlYBH2RZIOTRIX2ZI1StJOWNJhWVJl2ZJpyxKnSxKt09Kf2dMuQJNUEVNsjdQSURQ1pxQ0R9RTStRTh9SXjdSVFtSbnpSjbxT29xU8kZVVXxVofVW/nhXtBlYbjBYYTxYYkZYaIpZtHpayIZa4zNb6kJb855d64heyppg0kRk10Vk9SJmVz9mVgdndi1nZj9na1BnXwZoZlFob19ozStpfTBpVn9pr5tqqZNspktuf49vt6Vv8L1w9IxxyI1x145xmS93aIp37kB4baN42BN5gC15eEB5VU95a3Z5j7R5v/R5/Sd6il97b2B7gKR7xxZ9jWJ9kKd+uEx/hLp/3tmB96aC68eD+KGEq7iE9SaOaFiOeUKPeVmPkmeQlTSWlcaW+3aYimeZeUaaqTabqEmckqKc5r2c4Y2dskehfFmjb1+jkGOjoduk4NKl49Ol3Ganeninq+Co/Xmqjcyq/PKq/nashIqwsmm0f2S6nGe/sfXA+ufB/XnDpZPFtMjG9OTG733Iu5XLyfrM/7LX5GbeuZfk1YPluarmvKHrtKHsu7zszf/t/7P34LT477D5w5765Jv7z7z8zbP9zMv+5NT/49r/7uT/8P///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEDgAAACwAAAAAAAUABQAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTHgzAsmVBAgJhDpT58iBNlThz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnFlgdYxiRAFQDVqlezXjVY1arMrk7Dih1LtqzZs2jTql3Ltq1bi1rjyp1Lt67du3jz6t3blSrLAgWkegUbse/Xw3wTK17MuLHjx5AjS55MubLluDkDTJgQ4K3nz6BDix5NeuPNmTZTc1Vdc7Xr1rAJno7JWnbtlp1RE644uzbq17aB/449PDhx2sKRH7fqW7nx58WjO5fOPHn15b2zN78Ofbp37tS1W/8Xj31775ITasyYULq9+/fw48ufX7plAY+G6evfz3/jBBD9BSjggAQWaOB+gP11X0f5Hejgg/BtBuGEFFZo4YUYZqjhhhx26OGHIIYo4ogklmjiiSimqOKKLJYlWIswxijjjDTWaOONK+WG44489ujjj0AG6ZZLCREp5JFIJqnkkkw2KZCROb7o5JRUVmnllVgaKGWWXHbp5ZdghumijmKWaeaZaKap5ppstunmm3DGKeecdNZp55145qnnnnz26eefgAYq6KCEFmrooYgmquiijDbq6KOQRirppJRWaumlmGaq6aacdurpp6CGKuqopJZq6qmopqrqqqy26uqrsMb/KuusYl7wAZm05qrrrqZe0EUXF/Aq7LDEbvpBsMUmq+yyzDbr7LPQRivttNRWa+212Gar7bbcduvtt+CGK+645JZr7rnopqvuuuy26+678MYr77z01mvvvfhiKphUF0T1Ia4KAVzkQwIjVPBKBDN1sEELF9QwQQ8PFPGTCTs0MQAXZ8yTxhZX3NDF+YZ81r4CAICJFyVjLPLKLLdsUAEU2OHFghCCPOCWRU6MM5s67guwzxDbLBbQbQostMtYBgACG9p4Ad5+Rv+MMMNTO1w1xFdLnDXFVHdttddYg6212Fx/bXbYZ4+ddtlot62222y/LXfcdKtMtt1r4w233nPj/73v1nzXbTTgg99duJa47fzW0UhPqfQryaTAHn0L4yZAAJcnrvnmnHfu+eeghy766KQLkDnopoueOumst+7667DHLvvsp7dk+uq4Z5777Lz3/vnqUjG+ludPJZWb8I0vSQEFLC0PX88qD2475qljLLr1oWMPuvafc0/86N7HXvvvo2cePufnb56+5usn3j5u77sE/vzX09979bjbXjL1ndm/vf/de934jhefxA1gAMszgAESaIAnHS8AyzvAAilwgAM4UCCmYyADMZiyDFJAgRsEgOk4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');

// ── Vectors, as calls, so the naive replay below is total ───────────────────
const V = [];
const vec = (label, kind, args, expected, opts = {}) => {
  V.push({ label, kind, args, expected, ...opts });
};

const call = (kind, args) => {
  if (kind === 'end') return firstFrameEnd(args[0]);
  if (kind === 'cutLen') {
    const out = firstGifFrame(args[0]);
    return out === null ? null : out.byteLength;
  }
  if (kind === 'cutIsSingleFrame') {
    // The output must itself parse as a GIF whose one frame ends exactly at the
    // trailer — i.e. we produced a file, not a fragment.
    const out = firstGifFrame(args[0]);
    if (out === null) return null;
    const scan = firstFrameEnd(out);
    return typeof scan === 'object' && scan !== null && scan.end === out.byteLength - 1;
  }
  if (kind === 'cutKeepsGce') {
    // 0x21 0xF9 — the Graphic Control Extension. It carries the transparency
    // index, so dropping it repaints transparent pixels from the palette.
    const out = firstGifFrame(args[0]);
    if (out === null) return null;
    return out.some((b, i) => b === 0x21 && out[i + 1] === 0xf9);
  }
  throw new Error(`unknown kind ${kind}`);
};

// The offsets below were derived from an INDEPENDENT walker written off the
// GIF89a spec (in Python, from the same fixture bytes), not read back out of
// this module — an expectation printed by the code under test asserts only that
// the code is self-consistent. Both agree: ANIM's first frame ends at 81 of
// 156 bytes, STILL's at 54 of 55.
console.log('A real animated GIF is cut to one frame');
vec('the first frame ends before the file does', 'end', [ANIM], { end: 81 });
vec('the cut is smaller than the animation', 'cutLen', [ANIM], 82);
vec('...and the animation really is bigger', 'end', [ANIM.subarray(0, 80)], 'more');
vec('the cut output is a complete one-frame GIF', 'cutIsSingleFrame', [ANIM], true);
// Exempt from the naive replay on purpose: the extension sits BEFORE the frame
// in every layout, so any implementation that copies a prefix keeps it. The
// assertion still earns its place — it is the regression test for a "skip the
// extensions" rewrite, which would drop the transparency index.
vec('the frame keeps its Graphic Control Extension', 'cutKeepsGce', [ANIM], true, {
  alsoNaive: true,
});

console.log('\nA still GIF survives unchanged');
// It already ends with a trailer, so cutting rewrites the same byte: the output
// is the input's length. A "cut" that shortens a still image is a bug that only
// shows up as a corrupt banner.
vec('a single-frame GIF comes back whole', 'cutLen', [STILL], STILL.byteLength, {
  alsoNaive: true,
});

console.log('\nA truncated prefix says "more", never a wrong answer');
// This is the ordinary case: the route stops the download early on purpose.
vec('real 4 KB prefix of the 19 MB artwork', 'end', [REAL_PREFIX], 'more');
vec('...and yields no frame to draw', 'cutLen', [REAL_PREFIX], null);
vec('a prefix cut inside the colour table', 'end', [REAL_PREFIX.subarray(0, 300)], 'more');
vec('a prefix holding only the header', 'end', [REAL_PREFIX.subarray(0, 6)], 'more');
vec('an empty buffer', 'end', [new Uint8Array(0)], 'more');
vec('an animated GIF cut mid-sub-block', 'end', [ANIM.subarray(0, 48)], 'more');

console.log('\nA non-GIF, or a malformed one, is refused outright');
vec('a PNG is not a GIF', 'end', [PNG], null, { alsoNaive: true });
vec('a PNG yields no frame', 'cutLen', [PNG], null, { alsoNaive: true });
vec('"GIF" with an unknown version', 'end', [b64('R0lGODhhCAAIAIEAAA==')], null);
// Byte 25 is where the block stream starts in both fixtures: 6 header + 7
// logical screen descriptor + 12 global colour table (packed size 1 → 3 * 2^2).
// Both numbers come from the independent walker, not from this module.
const FIRST_BLOCK = 25;
{
  // A real file with one byte changed: the marker where the first block starts.
  // Malformed is NOT the same as truncated, and collapsing the two is the
  // failure that drops every animated cover.
  const bad = Uint8Array.from(ANIM);
  bad[FIRST_BLOCK] = 0xff;
  vec('an unknown block marker is malformed, not "more"', 'end', [bad], null);
}
{
  // A GIF that reaches its trailer without ever holding an image — real header,
  // real colour table, no frame.
  const empty = new Uint8Array(FIRST_BLOCK + 1);
  empty.set(STILL.subarray(0, FIRST_BLOCK));
  empty[FIRST_BLOCK] = 0x3b;
  vec('a GIF with no image block has no frame', 'end', [empty], null);
}

for (const v of V) check(v.label, call(v.kind, v.args), v.expected);

// ── Optional: the real file, when someone has it ────────────────────────────
if (process.env.CHECK_GIF_FILE) {
  console.log('\nAgainst the real file at CHECK_GIF_FILE');
  const { readFileSync } = await import('node:fs');
  const real = new Uint8Array(readFileSync(process.env.CHECK_GIF_FILE));
  const scan = firstFrameEnd(real);
  const cut = firstGifFrame(real);
  check('the frame ends inside the file', typeof scan === 'object' && scan.end < real.byteLength, true);
  check('the cut is smaller than the file', cut !== null && cut.byteLength < real.byteLength, true);
  check('the cut is a complete one-frame GIF', call('cutIsSingleFrame', [real]), true);
}

// ── The replay: every vector must fail against an obvious wrong version ─────
//
// Each naive() below is a real thing someone would write. A vector that passes
// against all of them proves nothing, so it is reported as a hole unless it
// carries `alsoNaive` — an input a wrong implementation also handles is a
// property of that input (a PNG is not a GIF under any parser), not a gap.
console.log('\nnaive() — the vectors must reject the obvious wrong versions');

// 1. "Find the first zero byte after the image descriptor." Ignores the
//    sub-block chain, so it cuts inside the pixel data.
function naiveFirstZero(bytes) {
  const at = bytes.indexOf(0x2c);
  if (at < 0) return null;
  for (let i = at + 10; i < bytes.length; i++) if (bytes[i] === 0) return { end: i + 1 };
  return 'more';
}
// 2. "A short file is a broken file." Collapses truncated into malformed, which
//    is the failure that silently drops every animated cover.
function naiveNoMore(bytes) {
  const r = firstFrameEnd(bytes);
  return r === 'more' ? null : r;
}
// 3. "Just use the whole thing." No cut at all — a 19 MB decode.
function naiveWhole(bytes) {
  return { end: Math.max(0, bytes.byteLength - 1) };
}

const NAIVES = [
  ['first-zero terminator', naiveFirstZero],
  ['truncated means malformed', naiveNoMore],
  ['no cut at all', naiveWhole],
];

function naiveCall(fn, kind, args) {
  const scan = fn(args[0]);
  if (kind === 'end') return scan;
  const ok = typeof scan === 'object' && scan !== null;
  if (kind === 'cutLen') return ok ? scan.end + 1 : null;
  if (kind === 'cutIsSingleFrame' || kind === 'cutKeepsGce') {
    if (!ok) return null;
    const out = new Uint8Array(scan.end + 1);
    out.set(args[0].subarray(0, scan.end));
    out[scan.end] = 0x3b;
    if (kind === 'cutKeepsGce') return out.some((b, i) => b === 0x21 && out[i + 1] === 0xf9);
    const s = firstFrameEnd(out);
    return typeof s === 'object' && s !== null && s.end === out.byteLength - 1;
  }
  return null;
}

for (const v of V) {
  if (v.alsoNaive) {
    console.log(`  --    ${v.label} (exempt: a wrong version handles this input too)`);
    continue;
  }
  const survives = NAIVES.filter(([, fn]) => {
    let got;
    try {
      got = naiveCall(fn, v.kind, v.args);
    } catch {
      return false;
    }
    return JSON.stringify(got) === JSON.stringify(v.expected);
  });
  if (survives.length === NAIVES.length) {
    console.log(`  FAIL  ${v.label} — every naive version passes it, so it proves nothing`);
    failures++;
  } else {
    console.log(`  ok    ${v.label} — rejects ${NAIVES.length - survives.length}/${NAIVES.length}`);
  }
}

console.log('\ngif-first-frame.ts stays loadable under plain Node');
{
  const problems = importFreeProblems('lib/gif-first-frame.ts');
  if (problems.length) {
    explainImportFree('lib/gif-first-frame.ts', problems);
    failures += problems.length;
  } else {
    console.log('  ok    lib/gif-first-frame.ts has no imports that plain Node cannot resolve');
  }
}

if (failures) {
  console.error(`\n${failures} GIF check(s) failed.`);
  process.exit(1);
}
console.log('\nAll GIF first-frame checks passed.');
