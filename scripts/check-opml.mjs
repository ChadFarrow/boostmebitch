// Pins the OPML reader in `lib/feed-xml.ts` — `parseOpml` — the favorites
// page's import.
//
// What breaks silently without it:
//
// - An IMPORT that drops or bends feeds. Every app that writes OPML writes
//   `&amp;` inside a query-string feed URL. A reader that does not decode it
//   looks the feed up as `…?a=1&amp;b=2`, Podcast Index finds nothing, and the
//   show lands in "not found" while the user is told their list imported.
// - An import that RESPELLS the URL. Podcast Index's byfeedurl is an exact
//   match, and it holds some feeds with literal spaces. A reader returning
//   `new URL(s).href` turned `…/masters scroll/pubfeed.xml` (in PI as written)
//   into `…/masters%20scroll/…`, and a real Fountain export reported two
//   indexed shows as "not found". `opmlUrlVariants` covers the reverse: the
//   file writes `%20` where PI holds a space.
// - An import that lets a `javascript:` or relative `xmlUrl` through. The URL
//   is sent to Podcast Index and stored as the favorite's `url`, which renders.
//
// Vectors are literal OPML as other apps write it (Overcast, AntennaPod, Pocket
// Casts shapes: nested category outlines, mixed `xmlUrl` casing, single
// quotes), never built from our own structs.
//
// Every vector is replayed against `naive()` (scripts/replay-vectors.mjs): a
// regex reader that neither decodes entities, filters schemes nor dedupes. A vector naive() also passes is marked
// `{ alsoNaive: true }` — a must-still-work input — and that claim is asserted.
//
// Imports the REAL shipping module. Like check:feedxml it does NOT run the
// import-free scan: `lib/feed-xml.ts` carries a type-only relative import (see
// that script's header for why that is survivable).
import { parseOpml, opmlUrlVariants, MAX_OPML_BYTES } from '../lib/feed-xml.ts';
import { replayVectors } from './replay-vectors.mjs';

let failed = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failed++; };

// The obvious wrong implementation.
// The obvious variant generator: none — try the file's spelling only.
const naiveVariants = () => [];
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
    // Fountain export, 2026-10-03. PI holds this feed as written, space and
    // all (feedId 6904362). The previous reader returned `.href`, i.e.
    // `…/masters%20scroll/…`, which byfeedurl does not match. naive() keeps
    // the raw string too, so this is must-still-work against naive() and was
    // checked failing against the `.href` implementation before keeping it.
    label: 'a feed URL with a literal space is kept as written (Fountain export)',
    kind: 'parse',
    args: [doc('<outline text="Master\'s Scroll" title="Master\'s Scroll" type="rss" xmlUrl="https://thunderroad.media/msp/masters scroll/pubfeed.xml" htmlUrl="https://behindthesch3m3s.com/"/>')],
    expect: { ok: true, feeds: [{ url: 'https://thunderroad.media/msp/masters scroll/pubfeed.xml', title: "Master's Scroll" }], skipped: 0 },
    alsoNaive: true,
  },
  {
    // `new URL` strips a tab, so `java&#9;script:` parses as `javascript:`.
    // Validating the parsed form while returning the raw one must not let it by.
    label: 'an entity-encoded tab inside the scheme is refused',
    kind: 'parse',
    args: [doc('<outline type="rss" text="x" xmlUrl="java&#9;script:alert(1)"/>\n<outline type="rss" text="x" xmlUrl="https&#10;://a.example/f"/>')],
    expect: { ok: true, feeds: [], skipped: 2 },
  },
  {
    // Same export: the file writes `%20`, PI holds `…/12 Rods/…` (feedId 6846028).
    label: 'a %20 URL offers the spaced spelling',
    kind: 'variants',
    args: ['https://music.behindthesch3m3s.com/wp-content/uploads/12%20Rods/12%20Rods%20April%206/12%20Rods/feed.xml'],
    expect: ['https://music.behindthesch3m3s.com/wp-content/uploads/12 Rods/12 Rods April 6/12 Rods/feed.xml'],
  },
  {
    label: 'a spaced URL offers the %20 spelling',
    kind: 'variants',
    args: ['https://thunderroad.media/msp/masters scroll/pubfeed.xml'],
    expect: ['https://thunderroad.media/msp/masters%20scroll/pubfeed.xml'],
  },
  {
    label: 'a stray % that is not an escape does not throw',
    kind: 'variants',
    args: ['https://a.example/100%/feed'],
    expect: ['https://a.example/100%25/feed'],
  },
  {
    label: 'a plain URL has nothing else to try',
    kind: 'variants',
    args: ['https://feeds.podcastindex.org/pc20.xml'],
    expect: [],
    alsoNaive: true,
  },
];

function run(which, v) {
  const parse = which === 'real' ? parseOpml : naiveParse;
  const variants = which === 'real' ? opmlUrlVariants : naiveVariants;
  try {
    switch (v.kind) {
      case 'parse': return JSON.stringify(parse(...v.args));
      case 'variants': return JSON.stringify(variants(...v.args));
      default: throw new Error('unknown kind ' + v.kind);
    }
  } catch (e) {
    return 'THREW ' + (e instanceof Error ? e.message : String(e));
  }
}

console.log('parseOpml / opmlUrlVariants — expected answers:');
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
