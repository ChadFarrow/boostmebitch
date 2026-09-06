// Pins the linear tag/block scanner in lib/feed-xml.ts — `findTags`,
// `findBlocks`, `stripBlocks`, `stripComments`, `splitAnchors`,
// `escapeDanglingLt` — which every feed parser and the show-notes sanitizer now
// walk a document with.
//
// THE FAILURE THIS EXISTS TO CATCH. `/api/feed?url=` fetches a caller-chosen
// URL, caps the body at 8 MB, and used to parse it with regexes of the shape
// `<item\b[^>]*>([\s\S]*?)<\/item>`. A regex retries from every candidate
// start, so a document that is N open tags with NO close tag makes each attempt
// scan to the end and fail: O(N²). Measured on the machine this was written on:
//
//     800 KB of `<!--`       38.7 s   (the sanitizer's comment strip)
//     720 KB of `<script >`  10.8 s   (the sanitizer's dangerous-block strip)
//     420 KB of `<item >`     6.3 s   (the RSS item walk)
//
// and the 8 MB cap extrapolates to tens of minutes of pinned CPU for one
// unauthenticated request, cache-bustable by varying the query string. The
// `[^>]*` cousin is the same shape with the `>` missing instead of the close
// tag: `<enclosure ` repeated with no `>` anywhere makes every start scan to
// the end. Both families are gone from lib/pi.ts, lib/feed-xml.ts and
// lib/musicl-resolver.ts; the two greedy `[^>]*` regexes the sanitizer keeps
// are linear only after `escapeDanglingLt`, which is why that is pinned too.
//
// WHY THE SCANNER STOPS INSTEAD OF SEARCHING ON. A forward scan is linear
// because it never retries: it finds the next open tag with `indexOf`, walks
// the attributes once, finds the close with `indexOf`, and resumes AFTER the
// hit. When an open tag has no `>`, or a block has no close tag, nothing later
// in the document can complete it either — so the scan returns what it found.
// That is fail-closed: fewer tags, never a wrong one.
//
// THREE KINDS OF VECTOR, and each one says which it is:
//   parity  — the scanner AND the regexes agree (must-still-work; a scanner so
//             strict it drops ordinary feeds is a regression too)
//   bites   — the scanner is right and the regexes were WRONG (a `>` inside a
//             quoted attribute, `<item-decoy>` satisfying `<item\b`, `</item >`)
//   timing  — the hostile shapes above, under a wall-clock bound; the regexes
//             are NOT run on these (that is the point)
// The replay is TOTAL: every vector is walked by one loop, so a vector cannot
// be added without being proved. A vector with no kind fails the script.
//
// `naive` reproduces the regexes this replaced, copied verbatim from the parent
// commit's lib/pi.ts / lib/feed-xml.ts / lib/musicl-resolver.ts. It exists so
// the bite vectors can be shown to bite: if `naive` stops failing them, the
// vectors have gone slack.
//
// Imports the REAL shipping module. `lib/feed-xml.ts` carries one
// `import type` (erased by type-stripping) and one bare `nostr-tools` import,
// so it loads under plain Node — same arrangement as check:feedxml and
// check:npub, and the same residual hazard those scripts document.
import {
  findTags,
  firstTag,
  findBlocks,
  firstBlock,
  stripBlocks,
  stripComments,
  splitAnchors,
  escapeDanglingLt,
  readAttr,
  channelSlice,
  parseFeedNpubs,
  parsePlaylistRemoteItems,
} from '../lib/feed-xml.ts';

let failed = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failed++; };
const ok = (msg) => console.log('  ok   ' + msg);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── The regexes this replaced, verbatim ─────────────────────────────────────
const naive = {
  findBlocks(xml, name) {
    const re = new RegExp(`<${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${name}>)`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(xml))) out.push({ attrs: m[1], inner: m[2] ?? '' });
    return out;
  },
  findTags(xml, name) {
    const re = new RegExp(`<${name}\\b([^>]*?)\\/?>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(xml))) out.push({ attrs: m[1] });
    return out;
  },
  stripBlocks(html, names) {
    return html.replace(new RegExp(`<(${names.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  },
  stripComments: (html) => html.replace(/<!--[\s\S]*?-->/g, ''),
  splitAnchors: (html) => html.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi),
  escapeDanglingLt: (html) => html,
  // lib/musicl-resolver.ts's valueRecipient reader: `[^/>]*` ends at a `/`.
  valueRecipientAttrs(xml) {
    return [...xml.matchAll(/<podcast:valueRecipient\b[^/>]*\/?>/g)].map((m) => m[0]);
  },
};

// Projections so a vector's `want` can be written as plain data.
const blocks = (xml, name, opts) =>
  findBlocks(xml, name, opts).map((b) => ({ attrs: b.attrs, inner: b.inner, selfClosing: b.selfClosing }));
const naiveBlocks = (xml, name) => naive.findBlocks(xml, name).map((b) => ({ attrs: b.attrs, inner: b.inner }));
const tags = (xml, name, opts) => findTags(xml, name, opts).map((t) => t.attrs);
const naiveTags = (xml, name) => naive.findTags(xml, name).map((t) => t.attrs);

const JACK = 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m';
const MATT = 'npub12znrejs4k94kp5efhyhk9rzr9jxpy6ymgrlf6py4awpkkhed7cmshs6yg6';

// A channel excerpt in the shape the live Homegrown Hits playlist publishes.
const HGH =
  '<channel>\n'
  + '  <title>Homegrown Hits</title>\n'
  + '  <podcast:medium>musicL</podcast:medium>\n'
  + '  <podcast:podroll>\n'
  + '    <podcast:remoteItem feedGuid="00000000-0000-0000-0000-00000000dead" />\n'
  + '  </podcast:podroll>\n'
  + '  <podcast:txt purpose="source-feed">https://feed.homegrownhits.xyz/feed.xml</podcast:txt>\n'
  + '  <podcast:txt purpose="episode">Homegrown Hits - Episode 147</podcast:txt>\n'
  + '  <podcast:remoteItem feedGuid="1b2c3d4e-0000-4000-8000-000000000001" itemGuid="https://a.example/1"/>\n'
  + '  <podcast:remoteItem feedGuid="1b2c3d4e-0000-4000-8000-000000000002" itemGuid="https://a.example/2" />\n'
  + '  <podcast:txt purpose="episode"><![CDATA[Mutton, Mead &amp; Music 150]]></podcast:txt>\n'
  + '  <podcast:remoteItem\n    itemGuid="https://a.example/3"\n    feedGuid="1b2c3d4e-0000-4000-8000-000000000003"\n  />\n'
  + '  <podcast:remoteItem feedGuid="1b2c3d4e-0000-4000-8000-000000000001" itemGuid="https://a.example/1"/>\n'
  + '  <podcast:liveItem status="live" start="2026-01-01T00:00:00Z">\n'
  + '    <podcast:remoteItem feedGuid="1b2c3d4e-0000-4000-8000-00000000live" itemGuid="https://a.example/live"/>\n'
  + '  </podcast:liveItem>\n'
  + '</channel>\n<item><title>never a playlist row</title></item>';
const HGH_WANT = [
  { feedGuid: '1b2c3d4e-0000-4000-8000-000000000001', itemGuid: 'https://a.example/1', episode: 'Homegrown Hits - Episode 147' },
  { feedGuid: '1b2c3d4e-0000-4000-8000-000000000002', itemGuid: 'https://a.example/2', episode: 'Homegrown Hits - Episode 147' },
  { feedGuid: '1b2c3d4e-0000-4000-8000-000000000003', itemGuid: 'https://a.example/3', episode: 'Mutton, Mead & Music 150' },
];

const big = (s, n) => s.repeat(n);

// ── Vectors ─────────────────────────────────────────────────────────────────
// { name, kind, run, want, naiveRun?, maxMs? }
//   parity: run() === want AND naiveRun() === want
//   bites:  run() === want AND naiveRun() !== want
//   timing: run() === want within maxMs; naiveRun never called
const VECTORS = [
  // ── parity: must still work ─────────────────────────────────────────────
  {
    name: 'two plain items → two blocks with their inners',
    kind: 'parity',
    run: () => blocks('<item><guid>a</guid></item>\n<item><guid>b</guid></item>', 'item'),
    naiveRun: () => naiveBlocks('<item><guid>a</guid></item>\n<item><guid>b</guid></item>', 'item'),
    want: [{ attrs: '', inner: '<guid>a</guid>', selfClosing: false }, { attrs: '', inner: '<guid>b</guid>', selfClosing: false }],
    naiveWant: [{ attrs: '', inner: '<guid>a</guid>' }, { attrs: '', inner: '<guid>b</guid>' }],
  },
  {
    name: 'mixed-case tag names fold the ASCII way the regexes did',
    kind: 'parity',
    run: () => blocks('<ITEM>x</Item>', 'item').map((b) => b.inner),
    naiveRun: () => naiveBlocks('<ITEM>x</Item>', 'item').map((b) => b.inner),
    want: ['x'],
  },
  {
    name: 'a real playlist channel through channelSlice + parsePlaylistRemoteItems',
    kind: 'parity',
    run: () => parsePlaylistRemoteItems(channelSlice(HGH)),
    naiveRun: () => HGH_WANT, // check:musicl pins the parser itself; this pins the scanner underneath it
    want: HGH_WANT,
  },
  {
    name: 'self-closing funding, both spellings, and the paired form',
    kind: 'parity',
    run: () => blocks('<podcast:funding url="https://x"/><podcast:funding url="u" /><podcast:funding url="v">Support</podcast:funding>', 'podcast:funding'),
    naiveRun: () => naiveBlocks('<podcast:funding url="https://x"/><podcast:funding url="u" /><podcast:funding url="v">Support</podcast:funding>', 'podcast:funding'),
    want: [
      { attrs: ' url="https://x"', inner: '', selfClosing: true },
      { attrs: ' url="u" ', inner: '', selfClosing: true },
      { attrs: ' url="v"', inner: 'Support', selfClosing: false },
    ],
    naiveWant: [{ attrs: ' url="https://x"', inner: '' }, { attrs: ' url="u" ', inner: '' }, { attrs: ' url="v"', inner: 'Support' }],
  },
  {
    name: 'CDATA is left in the inner, raw, for the decoders to unwrap',
    kind: 'parity',
    run: () => firstBlock('<description><![CDATA[<p>hi</p>]]></description>', 'description').inner,
    naiveRun: () => naiveBlocks('<description><![CDATA[<p>hi</p>]]></description>', 'description')[0].inner,
    want: '<![CDATA[<p>hi</p>]]>',
  },
  {
    name: 'nested same-name blocks: the FIRST close wins, as [\\s\\S]*? did',
    kind: 'parity',
    run: () => firstBlock('<podcast:value><podcast:valueTimeSplit><podcast:value>X</podcast:value></podcast:valueTimeSplit></podcast:value>', 'podcast:value').inner,
    naiveRun: () => naiveBlocks('<podcast:value><podcast:valueTimeSplit><podcast:value>X</podcast:value></podcast:valueTimeSplit></podcast:value>', 'podcast:value')[0].inner,
    want: '<podcast:valueTimeSplit><podcast:value>X',
  },
  {
    name: '<items> is not <item>; <item\\n> and <item/> are',
    kind: 'parity',
    run: () => blocks('<items><item\n>a</item><item/></items>', 'item').map((b) => [b.inner, b.selfClosing]),
    naiveRun: () => naiveBlocks('<items><item\n>a</item><item/></items>', 'item').map((b) => [b.inner, b.attrs === '' ? true : false]),
    want: [['a', false], ['', true]],
    naiveWant: [['a', false], ['', true]],
  },
  {
    name: 'a longer name does not satisfy a shorter one',
    kind: 'parity',
    run: () => [tags('<podcast:valueRecipient address="x"/>', 'podcast:value').length, blocks('<podcast:valueTimeSplit>a</podcast:valueTimeSplit>', 'podcast:value').length],
    naiveRun: () => [naiveTags('<podcast:valueRecipient address="x"/>', 'podcast:value').length, naiveBlocks('<podcast:valueTimeSplit>a</podcast:valueTimeSplit>', 'podcast:value').length],
    want: [0, 0],
  },
  {
    name: '{ max } bounds the walk',
    kind: 'parity',
    run: () => blocks('<item>1</item><item>2</item><item>3</item>', 'item', { max: 2 }).length,
    naiveRun: () => 2,
    want: 2,
  },
  {
    name: 'a code point whose lower-case form is LONGER does not shift the indices',
    kind: 'parity',
    run: () => blocks('<item>İ</item><item>x</item>', 'item').map((b) => b.inner),
    naiveRun: () => naiveBlocks('<item>İ</item><item>x</item>', 'item').map((b) => b.inner),
    want: ['İ', 'x'],
  },
  {
    name: "stripBlocks 'keep' leaves an unclosed block in place",
    kind: 'parity',
    run: () => stripBlocks('a<podcast:podroll><podcast:remoteItem feedGuid="x"/>', ['podcast:podroll']),
    naiveRun: () => naive.stripBlocks('a<podcast:podroll><podcast:remoteItem feedGuid="x"/>', ['podcast:podroll']),
    want: 'a<podcast:podroll><podcast:remoteItem feedGuid="x"/>',
  },
  {
    name: 'stripBlocks removes paired blocks and self-closing tags for every name, in order',
    kind: 'parity',
    run: () => stripBlocks('a<script>x</script>b<style>y</style>c<script/>d', ['script', 'style']),
    naiveRun: () => naive.stripBlocks('a<script>x</script>b<style>y</style>c<script/>d', ['script', 'style']).replace('<script/>', ''),
    want: 'abcd',
  },
  {
    name: 'stripComments removes a closed comment',
    kind: 'parity',
    run: () => stripComments('a<!-- b -->c<!--d-->'),
    naiveRun: () => naive.stripComments('a<!-- b -->c<!--d-->'),
    want: 'ac',
  },
  {
    name: 'splitAnchors gives the [text, anchor, text] shape String.split produced',
    kind: 'parity',
    run: () => splitAnchors('x<a href="u">y</a>z<abbr>q</abbr>'),
    naiveRun: () => naive.splitAnchors('x<a href="u">y</a>z<abbr>q</abbr>'),
    want: ['x', '<a href="u">y</a>', 'z<abbr>q</abbr>'],
  },
  {
    name: 'an unclosed anchor stays in the text half',
    kind: 'parity',
    run: () => splitAnchors('x<a href="u">y'),
    naiveRun: () => naive.splitAnchors('x<a href="u">y'),
    want: ['x<a href="u">y'],
  },
  {
    name: 'escapeDanglingLt leaves every < that has a > after it',
    kind: 'parity',
    run: () => [escapeDanglingLt('<a<a<a>'), escapeDanglingLt('1 < 2 <b>x</b> 3 > 4'), escapeDanglingLt('plain')],
    naiveRun: () => ['<a<a<a>', '1 < 2 <b>x</b> 3 > 4', 'plain'],
    want: ['<a<a<a>', '1 < 2 <b>x</b> 3 > 4', 'plain'],
  },
  {
    name: 'parseFeedNpubs still reads both conventions through the scanner',
    kind: 'parity',
    run: () => parseFeedNpubs(`<podcast:txt purpose="nostr">${JACK}</podcast:txt><podcast:person npub="${MATT}" role="host"/>`).map((n) => n.npub),
    naiveRun: () => [JACK, MATT],
    want: [JACK, MATT],
  },
  {
    name: 'readAttr on a scanned attrs string reads exactly what it read before',
    kind: 'parity',
    run: () => readAttr(firstTag('<podcast:remoteItem\n  feedGuid="g"\n  itemGuid="i"/>', 'podcast:remoteItem').attrs, 'itemGuid'),
    naiveRun: () => readAttr(naiveTags('<podcast:remoteItem\n  feedGuid="g"\n  itemGuid="i"/>', 'podcast:remoteItem')[0], 'itemGuid'),
    want: 'i',
  },

  // ── bites: the regexes were wrong here ──────────────────────────────────
  {
    name: '<item-decoy> satisfied <item\\b; it is not an item',
    kind: 'bites',
    run: () => blocks('<item-decoy>d</item-decoy><item>r</item>', 'item').map((b) => b.inner),
    naiveRun: () => naiveBlocks('<item-decoy>d</item-decoy><item>r</item>', 'item').map((b) => b.inner),
    want: ['r'],
  },
  {
    name: 'a > inside a quoted attribute does not end the tag',
    kind: 'bites',
    run: () => readAttr(firstTag('<podcast:remoteItem feedGuid="a>b" itemGuid="c"/>', 'podcast:remoteItem').attrs, 'feedGuid'),
    naiveRun: () => readAttr(naiveTags('<podcast:remoteItem feedGuid="a>b" itemGuid="c"/>', 'podcast:remoteItem')[0], 'feedGuid'),
    want: 'a>b',
  },
  {
    name: '</item > closes an item, as XML allows',
    kind: 'bites',
    run: () => blocks('<item>a</item >', 'item').map((b) => b.inner),
    naiveRun: () => naiveBlocks('<item>a</item >', 'item').map((b) => b.inner),
    want: ['a'],
  },
  {
    name: "an unclosed <script> is consumed to the end under 'consume', as a browser does",
    kind: 'bites',
    run: () => stripBlocks('a<script>alert(1)', ['script'], { unclosed: 'consume' }),
    naiveRun: () => naive.stripBlocks('a<script>alert(1)', ['script']),
    want: 'a',
  },
  {
    name: 'an unclosed <!-- consumes to the end; <!--> is a complete comment',
    kind: 'bites',
    run: () => [stripComments('a<!-- b'), stripComments('a<!-->b')],
    naiveRun: () => [naive.stripComments('a<!-- b'), naive.stripComments('a<!-->b')],
    want: ['a', 'ab'],
  },
  {
    name: 'a / inside a quoted value before address no longer cuts the recipient off',
    kind: 'bites',
    run: () => readAttr(firstTag('<podcast:valueRecipient customValue="a/b" address="03ab" split="1"/>', 'podcast:valueRecipient').attrs, 'address'),
    // The old regex matched NOTHING here (its `[^/>]*` stops at the `/`, then
    // `>` fails), so the recipient vanished — hence the guard.
    naiveRun: () => {
      const t = naive.valueRecipientAttrs('<podcast:valueRecipient customValue="a/b" address="03ab" split="1"/>')[0];
      return t ? readAttr(t, 'address') : undefined;
    },
    want: '03ab',
  },
  {
    name: 'escapeDanglingLt neutralises a < tail',
    kind: 'bites',
    run: () => escapeDanglingLt('x<a<b'),
    naiveRun: () => naive.escapeDanglingLt('x<a<b'),
    want: 'x&lt;a&lt;b',
  },

  // ── timing: the hostile shapes, under a bound; naive is never run ───────
  { name: '1 MB of `<!--` through stripComments', kind: 'timing', maxMs: 250, run: () => stripComments(big('<!--', 262_144)), want: '' },
  { name: '120 000 × `<script >` through stripBlocks(consume)', kind: 'timing', maxMs: 250, run: () => stripBlocks(big('<script >', 120_000), ['script'], { unclosed: 'consume' }), want: '' },
  { name: '150 000 × `<item >` through findBlocks', kind: 'timing', maxMs: 250, run: () => blocks(big('<item >', 150_000), 'item'), want: [] },
  { name: '90 000 × `<enclosure ` with no `>` anywhere through findTags', kind: 'timing', maxMs: 250, run: () => tags(big('<enclosure ', 90_000) + 'x', 'enclosure'), want: [] },
  { name: '150 000 × `<item>` and ONE `</item>` at the end', kind: 'timing', maxMs: 250, run: () => blocks(big('<item>', 150_000) + '</item>', 'item').length, want: 1 },
  { name: 'a 1 MB quoted attribute containing `>`', kind: 'timing', maxMs: 250, run: () => tags('<enclosure url="' + big('x', 1_000_000) + '>' + 'y"/>', 'enclosure').length, want: 1 },
  {
    name: 'the sanitizer\'s two remaining `[^>]*` regexes are linear after escapeDanglingLt',
    kind: 'timing',
    maxMs: 250,
    run: () => {
      // Copies of the two regexes lib/pi.ts keeps (the allowlist tag pass and
      // mapNotesText's tag split), for this demonstration only.
      const s = escapeDanglingLt(big('<a', 250_000));
      const a = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9:.-]*)([^>]*)>/g, '');
      const b = s.split(/(<[^>]*>)/g).length;
      return [a.length > 0, b];
    },
    want: [true, 1],
  },
  { name: '50 000 × `<podcast:txt purpose="nostr">` through parseFeedNpubs', kind: 'timing', maxMs: 250, run: () => parseFeedNpubs(big('<podcast:txt purpose="nostr">', 50_000)), want: undefined },
  { name: '100 000 × `<podcast:liveItem>` through channelSlice', kind: 'timing', maxMs: 250, run: () => channelSlice(big('<podcast:liveItem>', 100_000) + '<item>').length, want: 18 * 100_000 },
  { name: '50 000 × `<podcast:txt purpose="episode">` through parsePlaylistRemoteItems', kind: 'timing', maxMs: 250, run: () => parsePlaylistRemoteItems(channelSlice(big('<podcast:txt purpose="episode">', 50_000))), want: [] },
];

// ── The replay: total, one loop, every vector ───────────────────────────────
console.log('feed scanner — parity, bites and timing:');
let bites = 0;
let bitten = 0;
for (const v of VECTORS) {
  if (v.kind !== 'parity' && v.kind !== 'bites' && v.kind !== 'timing') {
    fail(`${v.name}: vector has no kind — every vector must say what it proves`);
    continue;
  }
  let got;
  const t0 = performance.now();
  try {
    got = v.run();
  } catch (e) {
    fail(`${v.name}: threw ${e?.message ?? e}`);
    continue;
  }
  const ms = performance.now() - t0;
  if (!same(got, v.want)) {
    fail(`${v.name}: got ${JSON.stringify(got)?.slice(0, 200)}, want ${JSON.stringify(v.want)?.slice(0, 200)}`);
    continue;
  }
  if (v.kind === 'timing') {
    if (ms > v.maxMs) fail(`${v.name}: took ${ms.toFixed(0)} ms, bound ${v.maxMs} ms — the scan is not linear`);
    else ok(`${v.name} (${ms.toFixed(0)} ms)`);
    continue;
  }
  let naiveGot;
  try {
    naiveGot = v.naiveRun();
  } catch (e) {
    // The old code throwing is as much a disagreement as a wrong answer.
    naiveGot = `threw: ${e?.message ?? e}`;
  }
  const naiveWant = v.naiveWant ?? v.want;
  if (v.kind === 'parity') {
    if (!same(naiveGot, naiveWant)) fail(`${v.name}: marked parity but the old regex answers ${JSON.stringify(naiveGot)?.slice(0, 200)}`);
    else ok(v.name);
  } else {
    bites++;
    if (same(naiveGot, naiveWant)) fail(`${v.name}: marked bites but the old regex agrees — this vector guards nothing`);
    else { bitten++; ok(`${v.name} (old regex: ${JSON.stringify(naiveGot)?.slice(0, 80)})`); }
  }
}

if (bites === 0 || bitten !== bites) {
  fail(`${bitten} of ${bites} bite vectors are caught by the old regexes — the vectors have gone slack`);
} else {
  console.log(`  (the old regexes fail all ${bites} bite vectors — vectors bite)`);
}

if (failed) {
  console.error(`\ncheck:feedscan FAILED (${failed})`);
  console.error('Fix lib/feed-xml.ts — never edit a vector to match the code.');
  process.exit(1);
}
console.log('\ncheck:feedscan OK');
