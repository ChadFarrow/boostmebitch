// Pins `readAttr` — the attribute reader every feed parser in this app goes
// through, including the one that decides WHO GETS PAID.
//
// The failure this exists to catch: `readAttr` shipped with a `\b` word
// boundary. `-` is a non-word character, so `\baddress` matches inside
// `x-address`, `\bsplit` inside `w-split`, `\bhref` inside `data-href`. Because
// `String.match` returns the FIRST hit, a feed that writes a decoy attribute
// ahead of the real one steers the parser:
//
//   <podcast:valueRecipient x-address="03ATTACKER…" address="03REALARTIST…"
//                           w-split="1" split="100"/>
//
// → address `03ATTACKER…`, split `1`. The sats go to a node the feed does not
// nominate, and NOTHING on this side can tell: every other Podcasting 2.0
// client reads `address=` and sees a correct feed, so the artist, the
// aggregators and any human reviewing the XML all agree it's fine. Only this
// parser is redirected.
//
// Vectors are literal wire strings — attribute substrings a feed could actually
// serve — not structs rebuilt from our own fields. Per CLAUDE.md: a fixture
// built from the thing you parse into cannot fail.
//
// The MUST-STILL-READ half is as load-bearing as the MUST-NOT half. An
// over-anchored fix that stops reading ordinary attributes breaks every feed in
// the wild, so ordinary shapes — leading whitespace, single quotes, newlines
// between attributes, mixed case, empty values — are pinned too.
// Imports the REAL shipping parser, not a copy — same arrangement as
// `check:npub`, which already loads this module.
//
// Deliberately does NOT run `scripts/import-free.mjs`. `lib/feed-xml.ts` is not
// one of the four modules that scan covers, because it carries
// `import type { FeedNpub } from './types'` — erased by type-stripping, so the
// load works, but a relative specifier the scan rejects on principle. Adding it
// to the list means relocating a shared type, which is a change with its own
// drift risk and is not this commit's job. The residual hazard is the one the
// scan documents: rewriting that line as `import { type FeedNpub }` breaks the
// load. It breaks it LOUDLY, in both this script and `check:npub`, with an
// ERR_MODULE_NOT_FOUND naming the specifier — survivable. If you hit that, move
// the type; do not reimplement `readAttr` in here.
import { readAttr } from '../lib/feed-xml.ts';

let failed = 0;

const fail = (msg) => { console.error('  ✗ ' + msg); failed++; };

// ── The decoy-attribute vectors: reading these wrong moves money ────────────
// Each entry: [attribute string, name to read, what a correct parser returns]
const MUST_READ_THE_REAL_ONE = [
  // The money vector, both orderings — decoy first is the exploit, decoy second
  // must not regress either.
  ['x-address="03ATTACKER" address="03REAL"', 'address', '03REAL'],
  ['address="03REAL" x-address="03ATTACKER"', 'address', '03REAL'],
  ['w-split="1" split="100"', 'split', '100'],
  ['data-type="node" type="lnaddress"', 'type', 'lnaddress'],
  ['x-customKey="696969" customKey="7629169"', 'customKey', '7629169'],
  ['x-customValue="EVIL" customValue="REAL"', 'customValue', 'REAL'],
  ['x-fee="true" fee="false"', 'fee', 'false'],
  // Show-notes link rewriting: `data-href` must not satisfy an `href` lookup,
  // or a feed points a rendered link somewhere the reader can't see.
  ['data-href="https://attacker.example/" href="https://real.example/"', 'href', 'https://real.example/'],
  ['data-src="https://attacker.example/x.png" src="https://real.example/x.png"', 'src', 'https://real.example/x.png'],
  // Publisher chain: this URL picks which album feed is fetched, and so which
  // value block is paid.
  ['x-feedUrl="https://attacker.example/f.xml" feedUrl="https://real.example/f.xml"', 'feedUrl', 'https://real.example/f.xml'],
  ['x-url="https://attacker.example/" url="https://real.example/"', 'url', 'https://real.example/'],
];

// A decoy with NO real attribute beside it must read as absent, not as the
// decoy. Returning the decoy here is how "the artist has no address, fall back"
// becomes "pay the attacker".
const MUST_NOT_READ_AT_ALL = [
  ['x-address="03ATTACKER"', 'address'],
  ['data-href="javascript:alert(1)"', 'href'],
  ['data-src="https://attacker.example/"', 'src'],
  ['my-url="https://attacker.example/"', 'url'],
  ['w-split="99"', 'split'],
  // Namespaced attributes deliberately do not satisfy a bare-name lookup.
  ['xml:lang="en"', 'lang'],
  ['podcast:url="https://attacker.example/"', 'url'],
];

// Ordinary feed shapes that MUST keep reading. Over-anchoring is a real
// regression: it silently empties every value block in the wild.
const MUST_STILL_READ = [
  // Name at the very start of the attribute string (the `^` half of the anchor).
  ['address="03REAL"', 'address', '03REAL'],
  // Leading whitespace, the common case when slicing a tag.
  [' address="03REAL"', 'address', '03REAL'],
  // Single quotes.
  ["address='03REAL'", 'address', '03REAL'],
  // Newline / tab between attributes — real feeds wrap long value blocks.
  ['name="Artist"\n  address="03REAL"', 'address', '03REAL'],
  ['name="Artist"\t\taddress="03REAL"', 'address', '03REAL'],
  // Whitespace around `=`.
  ['address = "03REAL"', 'address', '03REAL'],
  // Case-insensitive, as the original was.
  ['ADDRESS="03REAL"', 'address', '03REAL'],
  // Empty value is a legitimate read of "" — distinct from absent.
  ['address=""', 'address', ''],
  // A real lnaddress, with the `@` and dots that make it look URL-ish.
  ['type="lnaddress" address="artist@getalby.com"', 'address', 'artist@getalby.com'],
  // Real-world value block, whole tag passed in (the musicl-resolver shape).
  [
    '<podcast:valueRecipient name="Sovereign Feed" type="node" '
      + 'address="03ae9f2b5f2c1a4d8e7b6c5a4938271605f4e3d2c1b0a998877665544332211ff" '
      + 'split="99" customKey="696969" customValue="1234"/>',
    'address',
    '03ae9f2b5f2c1a4d8e7b6c5a4938271605f4e3d2c1b0a998877665544332211ff',
  ],
  // A genuine hyphenated attribute read by its OWN full name still works.
  ['data-npub="npub1abc"', 'data-npub', 'npub1abc'],
];

console.log('readAttr — decoy attributes must not win:');
for (const [attrs, name, want] of MUST_READ_THE_REAL_ONE) {
  const got = readAttr(attrs, name);
  if (got !== want) fail(`readAttr(${JSON.stringify(attrs)}, '${name}') = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

console.log('readAttr — a decoy alone reads as absent:');
for (const [attrs, name] of MUST_NOT_READ_AT_ALL) {
  const got = readAttr(attrs, name);
  if (got !== undefined) fail(`readAttr(${JSON.stringify(attrs)}, '${name}') = ${JSON.stringify(got)}, want undefined`);
}

console.log('readAttr — ordinary feeds must still parse:');
for (const [attrs, name, want] of MUST_STILL_READ) {
  const got = readAttr(attrs, name);
  if (got !== want) fail(`readAttr(${JSON.stringify(attrs)}, '${name}') = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── Proof the vectors bite ─────────────────────────────────────────────────
// A vector that passes the moment it is written has proved nothing. The
// original `\b` implementation is reproduced here so the suite can demonstrate
// it FAILS against it — if this stops failing, the vectors have gone slack and
// the guard is decorative. (CLAUDE.md: run a new vector against the obvious
// wrong implementation before keeping it.)
function naive(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

let naiveCaught = 0;
for (const [attrs, name, want] of MUST_READ_THE_REAL_ONE) {
  if (naive(attrs, name) !== want) naiveCaught++;
}
for (const [attrs, name] of MUST_NOT_READ_AT_ALL) {
  if (naive(attrs, name) !== undefined) naiveCaught++;
}
if (naiveCaught === 0) {
  fail('the `\\b` implementation passes every vector — these vectors guard nothing');
} else {
  console.log(`  (the original \\b implementation fails ${naiveCaught} of these — vectors bite)`);
}

if (failed) {
  console.error(`\ncheck:feedxml FAILED (${failed})`);
  console.error('Fix lib/feed-xml.ts — never edit a vector to match the code.');
  process.exit(1);
}
console.log('\ncheck:feedxml OK');
