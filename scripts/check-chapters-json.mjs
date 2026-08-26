// Pins the tolerant chapters parse that `/api/chapters` runs over feed-supplied
// bytes.
//
// Usage:
//   npm run check:chapters
//
// Run it after ANY edit to lib/chapters-json.ts.
//
// Why this earns a check script. The input is attacker-chosen: a podcast feed
// names the URL and the host serves the bytes. The module's whole job is to
// accept a document a strict parser rejects, so every mistake here widens what
// a feed can steer, and both failure directions are silent.
//
//   - Repair too much and a chapter TITLE loses characters while the file still
//     parses. The user then reads text the publisher never wrote, with no error
//     anywhere. The obvious implementation does exactly this: one regex over
//     the whole document is blind to string literals, so a title ending in
//     `Take 1, 0` matches the same pattern the corruption does. That is
//     `naiveRegex` below and it is the reason the shipping scan tracks
//     `inString`.
//   - Repair too little and the feature is gone: `JSON.parse` throws, the route
//     answers 500, and the app renders "no chapters", which reads exactly like
//     an episode that published none. That is `naiveNone`.
//
// The primary fixture is REAL WIRE DATA — the complete 3339-byte file that
// V4V Music Spotlight served for episode 005 "Christian Leuenberg" on
// 2026-08-25, base64 so its CRLF line endings and its 25 orphan `0` digits
// survive verbatim. Nothing here is a document written from the parser's own
// assumptions, which is the fixture that cannot fail.
//
// Every vector is recorded as a CALL and replayed against the naive versions at
// the foot of this file, so a vector cannot be added without also being proved
// to bite. The must-still-work half is exempted one vector at a time with
// `alsoNaive: true` — a legitimate input a wrong version also handles is a
// property of that input, not a hole.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module.

import { parseChaptersJson, repairOrphanDigits } from '../lib/chapters-json.ts';
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

// ── Fixtures ────────────────────────────────────────────────────────────────

// The real file, byte for byte. 25 chapters, and an orphan `0` at the start of
// the line before every one of the 25 `"title"` keys.
const REAL_BROKEN = Buffer.from(
  'ew0KICAidmVyc2lvbiI6ICIxLjIuMCIsDQogICJjaGFwdGVycyI6IFsNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogMC4wMDAwMDAsDQowICAgICAgInRpdGxlIjogIlY0ViBNdXNpYyBTcG90IC0gQ2hyaXN0aWFuIExldWVuYmVyZyIsDQogICAgICAiaW1nIjogIiIsDQogICAgICAidXJsIjogIiINCiAgICB9LA0KICAgIHsNCiAgICAgICJzdGFydFRpbWUiOiA3OC4yMDQ0NjksDQowICAgICAgInRpdGxlIjogIkhvdyB0byBwcm9ub3VuY2UgQ2hyaXN0aWFuIExldWVuYmVyZyIsDQogICAgICAiaW1nIjogIiIsDQogICAgICAidXJsIjogIiINCiAgICB9LA0KICAgIHsNCiAgICAgICJzdGFydFRpbWUiOiAxMzcuMDkyNDkwLA0KMCAgICAgICJ0aXRsZSI6ICJDaHJpc3RpYW4ncyBtdXNpY2FsIGpvdXJuZXkiLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogNDM3LjQ5MTcxNCwNCjAgICAgICAidGl0bGUiOiAiR2lsbGlnYW4iLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogNjAyLjI4ODM1OCwNCjAgICAgICAidGl0bGUiOiAiXCJXaGVuIFRoZXkgQ2FtZSBBcm91bmRcIiBieSBHaWxsaWdhbiIsDQogICAgICAiaW1nIjogIiIsDQogICAgICAidXJsIjogIiINCiAgICB9LA0KICAgIHsNCiAgICAgICJzdGFydFRpbWUiOiA4NTAuOTc2Mjk0LA0KMCAgICAgICJ0aXRsZSI6ICJSZWNvcmRpbmcgR2lsbGlnYW4iLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogMTA2OS4xMjQ0MzQsDQowICAgICAgInRpdGxlIjogIkFuYWxvZ3VlIGVuZ2luZWVyaW5nIiwNCiAgICAgICJpbWciOiAiIiwNCiAgICAgICJ1cmwiOiAiIg0KICAgIH0sDQogICAgew0KICAgICAgInN0YXJ0VGltZSI6IDE2ODUuNDc3MjU1LA0KMCAgICAgICJ0aXRsZSI6ICJOaW5lIEJ5IE9uZSIsDQogICAgICAiaW1nIjogIiIsDQogICAgICAidXJsIjogIiINCiAgICB9LA0KICAgIHsNCiAgICAgICJzdGFydFRpbWUiOiAxOTA5LjA3MTE2OCwNCjAgICAgICAidGl0bGUiOiAiXCJUaGUgV29ya2luZyBNZW5cIiBieSBDaHJpc3RpYW4gTGV1ZW5iZXJnIiwNCiAgICAgICJpbWciOiAiIiwNCiAgICAgICJ1cmwiOiAiIg0KICAgIH0sDQogICAgew0KICAgICAgInN0YXJ0VGltZSI6IDE5NzEuMDcxMTY4LA0KMCAgICAgICJ0aXRsZSI6ICJcIlRoZSBEcmVhbVwiIGJ5IENocmlzdGlhbiBMZXVlbmJlcmciLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogMjAzNS43Mzc4MzUsDQowICAgICAgInRpdGxlIjogIlwiTGFjayBvZiBMb3ZlXCIgYnkgQ2hyaXN0aWFuIExldWVuYmVyZyIsDQogICAgICAiaW1nIjogIiIsDQogICAgICAidXJsIjogIiINCiAgICB9LA0KICAgIHsNCiAgICAgICJzdGFydFRpbWUiOiAyMDk5LjkwNDQzMiwNCjAgICAgICAidGl0bGUiOiAiSW5zcGlyYXRpb24gYmVoaW5kIHRoZSB0aGVtZXMgb2YgTmluZSBCeSBPbmUiLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogMjMyMS4yOTM2NDAsDQowICAgICAgInRpdGxlIjogIk1vcmUgb24gcmVjb3JkaW5nIE5pbmUgQnkgT25lIiwNCiAgICAgICJpbWciOiAiIiwNCiAgICAgICJ1cmwiOiAiIg0KICAgIH0sDQogICAgew0KICAgICAgInN0YXJ0VGltZSI6IDI0MjcuODg4OTAyLA0KMCAgICAgICJ0aXRsZSI6ICJPbGQgT2FrIFN0dWRpbyIsDQogICAgICAiaW1nIjogIiIsDQogICAgICAidXJsIjogIiINCiAgICB9LA0KICAgIHsNCiAgICAgICJzdGFydFRpbWUiOiAyNzM4LjI4MDY0MSwNCjAgICAgICAidGl0bGUiOiAiVGhlIFZhbHVlVmVyc2UiLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogMjkyMi43NDA1NzksDQowICAgICAgInRpdGxlIjogIlBvZHR1bmVzLmFwcCIsDQogICAgICAiaW1nIjogIiIsDQogICAgICAidXJsIjogIiINCiAgICB9LA0KICAgIHsNCiAgICAgICJzdGFydFRpbWUiOiAzMjgzLjQ3ODQyMiwNCjAgICAgICAidGl0bGUiOiAiUmVjb3JkaW5nIFJpYyBTYXR0bGVyIiwNCiAgICAgICJpbWciOiAiIiwNCiAgICAgICJ1cmwiOiAiIg0KICAgIH0sDQogICAgew0KICAgICAgInN0YXJ0VGltZSI6IDMzODAuNTg3OTUzLA0KMCAgICAgICJ0aXRsZSI6ICJcIlRhbnogYW0gRHJ1aWRlbnN0ZWluXCIgYnkgUmljIFNhdHRsZXIiLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogMzU5OS45MzAxMjksDQowICAgICAgInRpdGxlIjogIlwiVGFueiBhbSBEcnVpZGVuc3RlaW5cIiBieSBSaWMgU2F0dGxlciIsDQogICAgICAiaW1nIjogIiIsDQogICAgICAidXJsIjogIiINCiAgICB9LA0KICAgIHsNCiAgICAgICJzdGFydFRpbWUiOiAzNzE5LjgzODM3MywNCjAgICAgICAidGl0bGUiOiAiT25ib2FyZGluZyBhcnRpc3RzIHRvIFZhbHVlVmVyc2UiLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogMzg2MS43Mjk3MzAsDQowICAgICAgInRpdGxlIjogIkNocmlzdGlhbidzIHdyaXRpbmcvcHJvZHVjdGlvbiBwcm9jZXNzIiwNCiAgICAgICJpbWciOiAiIiwNCiAgICAgICJ1cmwiOiAiIg0KICAgIH0sDQogICAgew0KICAgICAgInN0YXJ0VGltZSI6IDM5ODIuMTcyOTM1LA0KMCAgICAgICJ0aXRsZSI6ICJXb3JraW5nIHdpdGggYW5hbG9ndWUgaGFyZHdhcmUiLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogNDI4OC41MjYwNDIsDQowICAgICAgInRpdGxlIjogIkJlaGluZCBcIlNhdmUgTWUgVG9uaWdodFwiIiwNCiAgICAgICJpbWciOiAiIiwNCiAgICAgICJ1cmwiOiAiIg0KICAgIH0sDQogICAgew0KICAgICAgInN0YXJ0VGltZSI6IDQ0NDAuMzEyNjg5LA0KMCAgICAgICJ0aXRsZSI6ICJcIlNhdmUgTWUgVG9uaWdodFwiIGJ5IENocmlzdGlhbiBMZXVlbmJlcmciLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfSwNCiAgICB7DQogICAgICAic3RhcnRUaW1lIjogNDU3MC45MzE1MTEsDQowICAgICAgInRpdGxlIjogIlRpZHlpbmcgdXAiLA0KICAgICAgImltZyI6ICIiLA0KICAgICAgInVybCI6ICIiDQogICAgfQ0KICBdDQp9',
  'base64',
).toString('utf8');

// The same real file after the shipping repair. Used as the "a well-formed
// document is never rewritten" control, so that control is real wire data too
// rather than a document invented here.
const REAL_FIXED = repairOrphanDigits(REAL_BROKEN);

// Both faults in one document: the orphan `0` the repair exists for, and a
// chapter title that legitimately ENDS in `, 0`. A string-blind regex cannot
// tell them apart — it fixes the first and eats a character out of the second,
// and the result still parses, so nothing anywhere reports a problem.
const TITLE_TRAP =
  '{\r\n  "chapters": [\r\n    {\r\n      "startTime": 12.5,\r\n' +
  '0      "title": "Take 1, 0",\r\n      "img": ""\r\n    }\r\n  ]\r\n}';

// Valid JSON whose array elements each start a line with a digit. Nothing here
// needs repairing, and a rule keyed on "a line beginning with digits" destroys
// it — which is `naiveLineStart`.
const DIGITS_AT_LINE_START = '{\r\n  "starts": [\r\n1,\r\n2,\r\n3\r\n  ]\r\n}';

// A multi-digit orphan, and one with no whitespace at all before the key.
const MULTI_DIGIT = '{"a": 1,\n  12  "b": 2}';
const NO_GAP = '{"a": 1,0"b": 2}';

// Malformed beyond this repair's reach. It must stay malformed: inventing a
// document out of broken bytes is worse than reporting nothing.
const UNFIXABLE = '{"chapters": [ {"startTime": } ]}';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Compact, comparable view of a parse result. */
function summarize(v) {
  if (v === null || typeof v !== 'object') return { shape: typeof v, value: v };
  const chs = Array.isArray(v.chapters) ? v.chapters : null;
  if (!chs) return { shape: 'object', keys: Object.keys(v), json: JSON.stringify(v) };
  const last = chs[chs.length - 1];
  return {
    n: chs.length,
    firstStart: chs[0]?.startTime ?? null,
    firstTitle: chs[0]?.title ?? null,
    lastStart: last?.startTime ?? null,
    lastTitle: last?.title ?? null,
  };
}

/** Run one recorded call against a given repair implementation. */
function callWith(repair, kind, args) {
  const [text] = args;
  if (kind === 'repair') return repair(text);
  if (kind === 'repairChanges') return repair(text) !== text;
  const view = kind === 'titleAt' ? (v) => v?.chapters?.[args[1]]?.title ?? null : summarize;
  try {
    return view(JSON.parse(text));
  } catch {
    const repaired = repair(text);
    if (repaired === text) return 'THROW';
    try {
      return view(JSON.parse(repaired));
    } catch {
      return 'THROW';
    }
  }
}

// ── Vectors, as calls, so the naive replay below is total ────────────────────
const V = [];
const vec = (label, kind, args, expected, opts = {}) =>
  V.push({ label, kind, args, expected, ...opts });

vec(
  'real file: 25 chapters recovered, first and last intact',
  'parse',
  [REAL_BROKEN],
  {
    n: 25,
    firstStart: 0,
    firstTitle: 'V4V Music Spot - Christian Leuenberg',
    lastStart: 4570.931511,
    lastTitle: 'Tidying up',
  },
);

// Chapter 5 of the real file is `"When They Came Around" by Gilligan`, whose
// quotes arrive escaped. The walk has to treat `\"` as content and not as the
// end of the string, or every `,` after it is read as if it were outside one.
vec(
  'real file: a title carrying escaped quotes comes back whole',
  'titleAt',
  [REAL_BROKEN, 4],
  '"When They Came Around" by Gilligan',
);

// A truncated download must be refused, not half-parsed. Every version refuses
// it — the point is that the repair does not turn a short read into a document.
vec(
  'a body cut off mid-file is still refused',
  'parse',
  [REAL_BROKEN.slice(0, REAL_BROKEN.indexOf('850.976294'))],
  'THROW',
  { alsoNaive: true },
);

vec(
  'title ending in ", 0" keeps its characters while the orphan digit goes',
  'parse',
  [TITLE_TRAP],
  { n: 1, firstStart: 12.5, firstTitle: 'Take 1, 0', lastStart: 12.5, lastTitle: 'Take 1, 0' },
);

vec(
  'a well-formed document is returned byte-identical',
  'repair',
  [REAL_FIXED],
  REAL_FIXED,
  { alsoNaive: true },
);

vec(
  'valid array with digits at line start is not touched',
  'repair',
  [DIGITS_AT_LINE_START],
  DIGITS_AT_LINE_START,
);

vec('multi-digit orphan is dropped whole', 'parse', [MULTI_DIGIT], {
  shape: 'object',
  keys: ['a', 'b'],
  json: '{"a":1,"b":2}',
});

vec('orphan with no whitespace before the key is dropped', 'parse', [NO_GAP], {
  shape: 'object',
  keys: ['a', 'b'],
  json: '{"a":1,"b":2}',
});

vec('a fault this repair cannot reach still throws', 'parse', [UNFIXABLE], 'THROW', {
  alsoNaive: true,
});

vec('nothing to repair reports no change', 'repairChanges', [REAL_FIXED], false, {
  alsoNaive: true,
});

vec('the real file reports a change', 'repairChanges', [REAL_BROKEN], true);

// ── Run the vectors against the SHIPPING module ──────────────────────────────
console.log('chapters-json vectors');
/** The same recorded call, run against the module that actually ships. */
function shipping(kind, args) {
  const [text] = args;
  if (kind === 'repair') return repairOrphanDigits(text);
  if (kind === 'repairChanges') return repairOrphanDigits(text) !== text;
  try {
    const parsed = parseChaptersJson(text);
    return kind === 'titleAt' ? (parsed?.chapters?.[args[1]]?.title ?? null) : summarize(parsed);
  } catch {
    return 'THROW';
  }
}

for (const v of V) {
  check(v.label, shipping(v.kind, v.args), v.expected);
}

// The original error survives the repair attempt, so the message keeps naming
// the fault the publisher actually served rather than an offset in a string
// nobody sent. Not a vector: every naive version reports the same thing.
console.log('\nthe strict error is what surfaces when the repair does not help');
{
  let strictMsg = '';
  try {
    JSON.parse(UNFIXABLE);
  } catch (e) {
    strictMsg = e.message;
  }
  let thrownMsg = '';
  try {
    parseChaptersJson(UNFIXABLE);
  } catch (e) {
    thrownMsg = e.message;
  }
  check('unfixable input rethrows the strict SyntaxError', thrownMsg, strictMsg);
}

// ── Naive replay: every vector must bite at least one wrong version ──────────
console.log('\nvectors are proved against wrong implementations');

// 1. No repair at all — what shipped before, and what the route did when it
//    called `readCappedJson`. Renders "no chapters" over 25 real ones.
const naiveNone = (t) => t;
// 2. One regex over the whole document. Correct on the real file, and it eats a
//    character out of any title ending in a digit before the closing quote.
const naiveRegex = (t) => t.replace(/,(\s*)\d+(\s*")/g, ',$1$2');
// 3. "Strip a digit run at the start of a line." Correct on the real file, and
//    it destroys any valid document that puts a number at column 1.
const naiveLineStart = (t) => t.replace(/^\d+/gm, '');

const NAIVES = [
  ['no repair at all', naiveNone],
  ['string-blind regex', naiveRegex],
  ['strip digits at line start', naiveLineStart],
];

for (const v of V) {
  if (v.alsoNaive) {
    console.log(`  --    ${v.label} (exempt: a wrong version handles this input too)`);
    continue;
  }
  const survives = NAIVES.filter(([, repair]) => {
    let got;
    try {
      got = callWith(repair, v.kind, v.args);
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

console.log('\nchapters-json.ts stays loadable under plain Node');
{
  const problems = importFreeProblems('lib/chapters-json.ts');
  if (problems.length) {
    explainImportFree('lib/chapters-json.ts', problems);
    failures += problems.length;
  } else {
    console.log('  ok    lib/chapters-json.ts has no imports that plain Node cannot resolve');
  }
}

if (failures) {
  console.error(`\n${failures} chapters-json check(s) failed.`);
  process.exit(1);
}
console.log('\nAll chapters-json checks passed.');
