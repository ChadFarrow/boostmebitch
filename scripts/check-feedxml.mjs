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
import { readAttr, decodeXmlEntities, extractText, firstBlock } from '../lib/feed-xml.ts';
import { stripHtml } from '../lib/util.ts';

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
  // A whole attribute written INSIDE another attribute's quoted value. A single
  // quote needs no escape in a double-quoted value, so a feed host that lets a
  // collaborator edit a display name could plant this. The name comes before
  // the address in every real feed, so the decoy is always read first.
  [` name="Bob address='03ATTACKER' split='1'" type="node" address="03REAL" split="100"`, 'address', '03REAL'],
  [` name="Bob address='03ATTACKER' split='1'" type="node" address="03REAL" split="100"`, 'split', '100'],
  [` name='Bob address="03ATTACKER"' address='03REAL'`, 'address', '03REAL'],
  [` customKey="x customValue='EVIL'" customValue="REAL"`, 'customValue', 'REAL'],
  [` title="a href='https://attacker.example/'" href="https://real.example/"`, 'href', 'https://real.example/'],
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
  // The decoy sits inside a value and nothing real follows it.
  [` name="Bob address='03ATTACKER' split='1'" type="node"`, 'address'],
  [` name="Bob address='03ATTACKER'"`, 'address'],
  // Run together with no space: not an attribute start in XML.
  [`name="Bob"address="03ATTACKER"`, 'address'],
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
  // The OTHER quote character inside a value is data, and must not derail the walk.
  [`name="O'Brien" address="03REAL"`, 'address', '03REAL'],
  [`name='say "hi"' address='03REAL'`, 'address', '03REAL'],
  // `=` and `>` inside a value.
  [`customValue="a=b>c" address="03REAL"`, 'address', '03REAL'],
  // A valueless attribute, and an unquoted one (not XML), before the real one.
  [`hidden address="03REAL"`, 'address', '03REAL'],
  [`n=1 address="03REAL"`, 'address', '03REAL'],
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

// ── decodeXmlEntities: a recipient NAME for display ────────────────────────
// `readAttr` returns raw bytes, so "Mutton, Mead &amp; Music" reached the
// splits list with the entity showing. The naive fix decodes `&amp;` FIRST,
// which turns the literal text `&amp;lt;` into `<` — a double decode.
const naiveDecode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const DECODE = [
  ['Mutton, Mead &amp; Music', 'Mutton, Mead & Music', { alsoNaive: true }],
  ['&amp;lt;b&amp;gt;', '&lt;b&gt;'],
  ['&#x1F3B5; Song', '\u{1F3B5} Song'],
  ['&#x110000;', '&#x110000;'],
  ['plain name', 'plain name', { alsoNaive: true }],
];
let decodeBites = 0;
for (const [input, want, opts] of DECODE) {
  const got = decodeXmlEntities(input);
  if (got !== want) fail(`decodeXmlEntities(${JSON.stringify(input)}) → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  let naiveGot;
  try { naiveGot = naiveDecode(input); } catch { naiveGot = Symbol('threw'); }
  if (naiveGot === want) {
    if (!opts?.alsoNaive) fail(`decode vector ${JSON.stringify(input)} passes against naive() too — it proves nothing`);
  } else if (opts?.alsoNaive) {
    fail(`decode vector ${JSON.stringify(input)} is marked alsoNaive but naive() disagrees`);
  } else decodeBites++;
}
console.log(`  (naive entity decode fails ${decodeBites} of ${DECODE.length} decode vectors)`);

// ── extractText: a feed's TEXT nodes — titles, guids, descriptions ──────────
// Full-code review 2026-11-19 (lib/pi.ts). Its own entity pass decoded `&amp;`
// first (the literal `&amp;lt;` became `<`) and read numeric references with
// `fromCharCode` (`&#x1F3B5;` became U+F3B5). A guid is a lookup key other apps
// compare against their own parse, so the double decode is a different ITEM,
// not a cosmetic slip. Vectors are wire snippets, recorded as calls and replayed
// against `naiveText`, the pre-fix function verbatim (on the real `firstBlock`).
function naiveText(xml, tag) {
  const hit = firstBlock(xml, tag);
  if (!hit || hit.selfClosing) return undefined;
  const stripped = hit.inner.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1').trim();
  return stripped
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
const TEXT = [
  { args: ['<item><title>Tom &amp; Jerry</title></item>', 'title'], want: 'Tom & Jerry', alsoNaive: true },
  { args: ['<item><title>Why &amp;lt;b&amp;gt; is a tag</title></item>', 'title'], want: 'Why &lt;b&gt; is a tag' },
  { args: ['<item><guid>ep-&amp;#39;42</guid></item>', 'guid'], want: 'ep-&#39;42' },
  { args: ['<item><title>&#x1F3B5; Song</title></item>', 'title'], want: '\u{1F3B5} Song' },
  { args: ['<item><title>&#127925; Song</title></item>', 'title'], want: '\u{1F3B5} Song' },
  { args: ['<item><title>&#x110000;</title></item>', 'title'], want: '&#x110000;' },
  { args: ['<item><title> <![CDATA[ Plain & simple ]]> </title></item>', 'title'], want: 'Plain & simple', alsoNaive: true },
  { args: ['<item><title>&#233;t&#xE9; &quot;live&quot;</title></item>', 'title'], want: 'été "live"', alsoNaive: true },
  { args: ['<item><title/></item>', 'title'], want: undefined, alsoNaive: true },
  { args: ['<item><link>x</link></item>', 'title'], want: undefined, alsoNaive: true },
];
let textBites = 0;
for (const v of TEXT) {
  const label = `extractText(${JSON.stringify(v.args[0])}, '${v.args[1]}')`;
  const got = extractText(...v.args);
  if (got !== v.want) { fail(`${label} → ${JSON.stringify(got)}, want ${JSON.stringify(v.want)}`); continue; }
  const n = naiveText(...v.args);
  if (n === v.want) {
    if (!v.alsoNaive) fail(`${label} passes against naiveText() too — it proves nothing`);
  } else if (v.alsoNaive) {
    fail(`${label} is marked alsoNaive but naiveText() answers ${JSON.stringify(n)}`);
  } else textBites++;
}
console.log(`  (the pre-fix extractText fails ${textBites} of ${TEXT.length} text vectors)`);

// ── stripHtml: a DESCRIPTION (HTML) to the text a reader sees ──────────────
// The second half of the same fix. A `<description>` that carries HTML holds
// `&#160;` after its XML decode; the old `extractText` decoded it a second time,
// so `stripHtml` never had to. Now `stripHtml` decodes numeric references (and
// `&amp;` last), or mmo.show's 209 episodes show "&#160;" between paragraphs.
// `naiveStrip` is the pre-fix function verbatim.
const naiveStrip = (s) => s
  .replace(/<\s*br\s*\/?\s*>/gi, '\n')
  .replace(/<\/(p|div|li)\s*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'")
  .replace(/\n{3,}/g, '\n\n')
  .trim();
const STRIP = [
  { args: ['<p>One&#160;two</p>'], want: 'One\u00A0two' },
  { args: ['A &amp;lt;b&amp;gt; tag'], want: 'A &lt;b&gt; tag' },
  { args: ['&#x1F3B5; Song &#127925;'], want: '\u{1F3B5} Song \u{1F3B5}' },
  { args: ['Tom &amp; Jerry<br>next'], want: 'Tom & Jerry\nnext', alsoNaive: true },
  { args: ['It&#39;s &quot;live&quot;'], want: 'It\'s "live"', alsoNaive: true },
  { args: ['<p>a</p><p>b</p>'], want: 'a\nb', alsoNaive: true },
  { args: ['&#x110000; stays'], want: '&#x110000; stays', alsoNaive: true },
];
let stripBites = 0;
for (const v of STRIP) {
  const label = `stripHtml(${JSON.stringify(v.args[0])})`;
  const got = stripHtml(...v.args);
  if (got !== v.want) { fail(`${label} → ${JSON.stringify(got)}, want ${JSON.stringify(v.want)}`); continue; }
  const n = naiveStrip(...v.args);
  if (n === v.want) {
    if (!v.alsoNaive) fail(`${label} passes against naiveStrip() too — it proves nothing`);
  } else if (v.alsoNaive) {
    fail(`${label} is marked alsoNaive but naiveStrip() answers ${JSON.stringify(n)}`);
  } else stripBites++;
}
console.log(`  (the pre-fix stripHtml fails ${stripBites} of ${STRIP.length} description vectors)`);

if (failed) {
  console.error(`\ncheck:feedxml FAILED (${failed})`);
  console.error('Fix lib/feed-xml.ts — never edit a vector to match the code.');
  process.exit(1);
}
console.log('\ncheck:feedxml OK');
