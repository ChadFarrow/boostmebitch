// Pins the OPML reader and writer in `lib/feed-xml.ts` — `parseOpml`,
// `buildOpml`, `opmlFilename` — the favorites page's import and export.
//
// What breaks silently without it:
//
// - An IMPORT that drops or bends feeds. Every app that writes OPML writes
//   `&amp;` inside a query-string feed URL. A reader that does not decode it
//   looks the feed up as `…?a=1&amp;b=2`, Podcast Index finds nothing, and the
//   show lands in "not found" while the user is told their list imported.
// - An import that lets a `javascript:` or relative `xmlUrl` through. The URL
//   is sent to Podcast Index and stored as the favorite's `url`, which renders.
// - An EXPORT another app cannot read. A title with `&` or `"` written raw is a
//   malformed document, and the other app's importer rejects the whole file.
//
// Vectors are literal OPML as other apps write it (Overcast, AntennaPod, Pocket
// Casts shapes: nested category outlines, mixed `xmlUrl` casing, single
// quotes), never built from our own structs — except the round trip, which is
// the one place the writer's output IS the wire.
//
// Every vector is replayed against `naive()` (scripts/replay-vectors.mjs): a
// regex reader that neither decodes entities, filters schemes nor dedupes, and
// a writer that does not escape. A vector naive() also passes is marked
// `{ alsoNaive: true }` — a must-still-work input — and that claim is asserted.
//
// Imports the REAL shipping module. Like check:feedxml it does NOT run the
// import-free scan: `lib/feed-xml.ts` carries a type-only relative import (see
// that script's header for why that is survivable).
import { parseOpml, buildOpml, opmlFilename, MAX_OPML_BYTES } from '../lib/feed-xml.ts';
import { replayVectors } from './replay-vectors.mjs';

let failed = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failed++; };

const DATE = new Date(Date.UTC(2026, 8, 25, 12, 0, 0));

// The obvious wrong implementation.
function naiveParse(text) {
  if (!/<opml/i.test(text)) return { ok: false, error: 'not opml' };
  const feeds = [];
  for (const m of text.matchAll(/<outline\b([^>]*)>/gi)) {
    const u = m[1].match(/xmlUrl="([^"]*)"/i);
    if (!u) continue;
    const t = m[1].match(/(?:title|text)="([^"]*)"/i);
    feeds.push(t ? { url: u[1], title: t[1] } : { url: u[1] });
  }
  return { ok: true, feeds, skipped: 0 };
}
function naiveBuild(feeds, meta) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>' + meta.title
    + '</title></head><body>'
    + feeds.map((f) => `<outline type="rss" text="${f.title || f.url}" title="${f.title || f.url}" xmlUrl="${f.url}"/>`).join('')
    + '</body></opml>';
}

const doc = (body) => `<?xml version="1.0" encoding="utf-8"?>\n<opml version="1.0">\n<head><title>Subs</title></head>\n<body>\n${body}\n</body>\n</opml>`;

const VECTORS = [
  {
    label: 'entity-encoded & in a feed URL is decoded',
    kind: 'parse',
    args: [doc('<outline type="rss" text="Q" xmlUrl="https://feeds.example.com/rss?id=7&amp;fmt=mp3"/>')],
    expect: { ok: true, feeds: [{ url: 'https://feeds.example.com/rss?id=7&fmt=mp3', title: 'Q' }], skipped: 0 },
  },
  {
    label: 'entity-encoded title is decoded',
    kind: 'parse',
    args: [doc('<outline type="rss" text="Rock &amp; Roll &quot;Hour&quot;" xmlUrl="https://a.example/feed"/>')],
    expect: { ok: true, feeds: [{ url: 'https://a.example/feed', title: 'Rock & Roll "Hour"' }], skipped: 0 },
  },
  {
    label: 'javascript:, file: and relative xmlUrl are refused and counted',
    kind: 'parse',
    args: [doc([
      '<outline type="rss" text="bad" xmlUrl="javascript:alert(1)"/>',
      '<outline type="rss" text="bad" xmlUrl="file:///etc/passwd"/>',
      '<outline type="rss" text="bad" xmlUrl="/feed.xml"/>',
      '<outline type="rss" text="good" xmlUrl="https://good.example/feed"/>',
    ].join('\n'))],
    expect: { ok: true, feeds: [{ url: 'https://good.example/feed', title: 'good' }], skipped: 3 },
  },
  {
    label: 'a repeated feed is imported once',
    kind: 'parse',
    args: [doc([
      '<outline type="rss" text="One" xmlUrl="https://a.example/feed"/>',
      '<outline type="rss" text="One again" xmlUrl="https://a.example/feed"/>',
    ].join('\n'))],
    expect: { ok: true, feeds: [{ url: 'https://a.example/feed', title: 'One' }], skipped: 0 },
  },
  {
    label: 'single-quoted attributes (AntennaPod shape) are read',
    kind: 'parse',
    args: [doc("<outline text='Solo' type='rss' xmlUrl='https://b.example/rss'/>")],
    expect: { ok: true, feeds: [{ url: 'https://b.example/rss', title: 'Solo' }], skipped: 0 },
  },
  {
    label: 'a decoy x-xmlUrl does not win over the real xmlUrl',
    kind: 'parse',
    args: [doc('<outline type="rss" text="S" data-xmlUrl="https://attacker.example/f" xmlUrl="https://real.example/f"/>')],
    expect: { ok: true, feeds: [{ url: 'https://real.example/f', title: 'S' }], skipped: 0 },
  },
  {
    label: 'nested category outlines flatten; XMLURL casing is read',
    kind: 'parse',
    args: [doc([
      '<outline text="Music">',
      '  <outline type="rss" text="Album A" XMLURL="https://m.example/a.xml"/>',
      '  <outline type="rss" title="Album B" text="ignored" xmlUrl="https://m.example/b.xml" htmlUrl="https://m.example/"/>',
      '</outline>',
    ].join('\n'))],
    expect: { ok: true, feeds: [
      { url: 'https://m.example/a.xml', title: 'Album A' },
      { url: 'https://m.example/b.xml', title: 'Album B' },
    ], skipped: 0 },
    alsoNaive: true,
  },
  {
    label: 'a document that is not OPML is refused',
    kind: 'parse',
    args: ['<rss version="2.0"><channel><title>x</title></channel></rss>'],
    expect: { ok: false, error: 'this file is not an OPML subscription list' },
  },
  {
    label: 'a file over the byte cap is refused',
    kind: 'parse',
    args: [doc('<outline type="rss" xmlUrl="https://a.example/f"/>') + ' '.repeat(MAX_OPML_BYTES)],
    expect: { ok: false, error: 'this file is too large to be a subscription list' },
  },
  {
    label: 'export round-trips titles and URLs with & < > " \'',
    kind: 'roundtrip',
    args: [[
      { url: 'https://feeds.example.com/rss?id=7&fmt=mp3', title: 'Rock & Roll <Live> "Hour" \'n\' more' },
      { url: 'https://plain.example/feed' },
    ]],
    expect: { ok: true, feeds: [
      { url: 'https://feeds.example.com/rss?id=7&fmt=mp3', title: 'Rock & Roll <Live> "Hour" \'n\' more' },
      { url: 'https://plain.example/feed', title: 'https://plain.example/feed' },
    ], skipped: 0 },
  },
  {
    label: 'filename is <site>-subscriptions-YYYY-MM-DD.opml',
    kind: 'filename',
    args: ['boostmebuddy.com', new Date(2026, 0, 5)],
    expect: 'boostmebuddy-subscriptions-2026-01-05.opml',
    alsoNaive: true,
  },
];

function run(which, v) {
  const parse = which === 'real' ? parseOpml : naiveParse;
  const build = which === 'real' ? buildOpml : naiveBuild;
  try {
    switch (v.kind) {
      case 'parse': return JSON.stringify(parse(...v.args));
      case 'roundtrip': return JSON.stringify(parse(build(v.args[0], { title: 'Subs', dateCreated: DATE })));
      case 'filename': return opmlFilename(...v.args);
      default: throw new Error('unknown kind ' + v.kind);
    }
  } catch (e) {
    return 'THREW ' + (e instanceof Error ? e.message : String(e));
  }
}

console.log('parseOpml / buildOpml / opmlFilename — expected answers:');
for (const v of VECTORS) {
  const want = typeof v.expect === 'string' ? v.expect : JSON.stringify(v.expect);
  const got = run('real', v);
  if (got !== want) fail(`"${v.label}"\n      got  ${got}\n      want ${want}`);
}

console.log('replay against naive():');
replayVectors({ vectors: VECTORS, invoke: run, fail });

if (failed) {
  console.error(`\ncheck:opml — ${failed} failure(s)`);
  process.exit(1);
}
console.log('\ncheck:opml — ok');
