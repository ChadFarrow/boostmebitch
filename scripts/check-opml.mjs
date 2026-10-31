// Pins the OPML import and export: `parseOpml` (lib/feed-xml.ts) and
// `planOpmlImport`, `sortOpmlAnswers`, `buildOpml` (lib/opml.ts).
//
// Usage:
//   npm run check:opml
//
// WHY THIS EARNS A CHECK SCRIPT. Two of its failures cannot be taken back.
//
//  1. A PAID FEED'S KEY LEAVES THE DEVICE. An export from the user's current
//     app lists members-only feeds beside the public ones, and their address
//     IS the credential (`?auth=` on Patreon, a path token on Supercast). A
//     lookup sends each address to our server, to the read index — which
//     STORES the key it was asked about — and to Podcast Index. `planOpmlImport`
//     keeps them back; `naivePlan()` is "look up every xmlUrl as written".
//  2. A LIBRARY READ AS "NOT FOUND". `/api/by-guid/batch` answers in three
//     states and an ABSENT key means "could not ask". Reading it as "not
//     found" turns a rate limit into a final answer about half a library, with
//     no button to try again. `naiveSort()` makes that mistake.
//
// The other two are a file this app cannot read (`naiveParse()`: a regex,
// case-sensitive and double-quote-only, no entity decode, no comment strip)
// and a file the NEXT app cannot read (`naiveBuild()`: no escaping, so one
// `&` in a title or a query string makes the whole document invalid XML).
//
// THE FIXTURES are OPML in the shapes Pocket Casts, AntennaPod and Overcast
// write — the XML declaration AntennaPod writes with single quotes, the
// `<outline text="feeds">` folder Pocket Casts and Overcast nest feeds in, and
// Overcast's extended export, which nests EPISODE outlines (`url`, no
// `xmlUrl`) inside each show. They were typed from those formats, NOT
// captured from a device; a real export that disagrees is a new vector. The
// feed addresses are real public feeds; the private ones carry made-up keys.

import { parseOpml } from '../lib/feed-xml.ts';
import {
  OPML_MAX_FEEDS, buildOpml, looksPrivate, planOpmlImport, sortOpmlAnswers,
} from '../lib/opml.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

// ── Fixtures: the wire ─────────────────────────────────────────────────────
const NA = 'http://feed.nashownotes.com/rss.xml';
const PC20 = 'https://feeds.podcastindex.org/pc20.xml';
const ATP = 'https://atp.fm/rss';

const POCKET_CASTS = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head>
    <title>Pocket Casts Feeds</title>
  </head>
  <body>
    <outline text="feeds">
      <outline type="rss" text="No Agenda Show" xmlUrl="${NA}" />
      <outline type="rss" text="Podcasting 2.0" xmlUrl="${PC20}" />
    </outline>
  </body>
</opml>`;

const ANTENNAPOD = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<opml version="2.0">
  <head>
    <title>AntennaPod Subscriptions</title>
    <dateCreated>30 Oct 26 22:00:00 +0000</dateCreated>
  </head>
  <body>
    <outline text="Podcasting 2.0" title="Podcasting 2.0" type="rss" xmlUrl="${PC20}" htmlUrl="https://podcastindex.org" />
  </body>
</opml>`;

const OVERCAST_EXTENDED = `<?xml version="1.0" encoding="utf-8"?>
<opml version="1.0">
  <head><title>Overcast Podcast Subscriptions</title></head>
  <body>
    <outline text="feeds">
      <outline type="rss" overcastId="123" text="Accidental Tech Podcast" title="Accidental Tech Podcast" xmlUrl="${ATP}" htmlUrl="https://atp.fm/">
        <outline type="podcast-episode" overcastId="456" pubDate="2026-10-29T12:00:00-04:00" title="671: Episode" url="https://atp.fm/671" overcastUrl="https://overcast.fm/+abc" enclosureUrl="https://traffic.libsyn.com/atpfm/atp671.mp3" played="1"/>
        <outline type="podcast-episode" overcastId="457" pubDate="2026-10-22T12:00:00-04:00" title="670: Episode" url="https://atp.fm/670" overcastUrl="https://overcast.fm/+abd" enclosureUrl="https://traffic.libsyn.com/atpfm/atp670.mp3" played="0"/>
      </outline>
    </outline>
  </body>
</opml>`;

// A correct writer escapes the query string's `&`, and the title's.
const ESCAPED = `<opml version="2.0"><body>
  <outline type="rss" text="Mutton, Mead &amp; Music" xmlUrl="https://example.com/feed?format=rss&amp;tag=music"/>
</body></opml>`;

const SINGLE_QUOTED_LOWERCASE = `<opml version='2.0'><body>
  <outline type='rss' text='No Agenda Show' xmlurl='${NA}'/>
</body></opml>`;

const COMMENTED_OUT = `<opml version="2.0"><body>
  <!-- <outline type="rss" text="Unsubscribed" xmlUrl="https://old.example.com/feed.xml"/> -->
  <outline type="rss" text="Podcasting 2.0" xmlUrl="${PC20}"/>
</body></opml>`;

const DECOY = `<opml version="2.0"><body>
  <outline type="rss" text="Podcasting 2.0" x-xmlUrl="https://decoy.example.com/feed.xml" xmlUrl="${PC20}"/>
</body></opml>`;

const RSS_NOT_OPML = `<?xml version="1.0"?><rss version="2.0"><channel><title>A feed</title></channel></rss>`;

// ── Outlines as the reader hands them to the planner ──────────────────────
const o = (xmlUrl, title = '') => ({ xmlUrl, title });
const PATREON = 'https://www.patreon.com/rss/examplecreator?auth=0a1b2c3d4e5f6a7b8c9d';
const SUPERCAST = 'https://example.supercast.com/feeds/Zx9Yw8Vu7Ts6';
const USERINFO = 'https://member:hunter2@feeds.example.com/private.xml';
const TOKEN_PARAM = 'https://feeds.example.com/show.xml?access_token=abc123';
const SQUARESPACE = 'https://www.example.com/podcast?format=rss';
const YOUTUBE = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCbbbbbbbbbbbbbbbbbbbbbb';
const AUTHOR_PARAM = 'https://feeds.example.com/show.xml?author=jane';

// ── naive(): the obvious versions ──────────────────────────────────────────
function naiveParse(xml) {
  const out = [];
  for (const m of xml.matchAll(/<outline\b[^>]*>/g)) {
    const url = m[0].match(/xmlUrl="([^"]*)"/);
    if (!url) continue;
    const title = m[0].match(/title="([^"]*)"/) ?? m[0].match(/text="([^"]*)"/);
    out.push({ xmlUrl: url[1], title: title ? title[1] : '' });
  }
  return out;
}
function naivePlan(outlines) {
  return { feeds: outlines.map((x) => ({ url: x.xmlUrl, title: x.title })), skipped: [], overCap: 0 };
}
function naiveSort(feeds, answers, isFavorite) {
  const out = { add: [], already: [], notFound: [], noGuid: [], unasked: [] };
  for (const feed of feeds) {
    const podcast = answers[feed.url] ?? null;
    if (!podcast) out.notFound.push(feed);
    else if (podcast.podcastGuid && isFavorite(podcast.podcastGuid)) out.already.push(feed);
    else out.add.push({ feed, podcast });
  }
  return out;
}
function naiveBuild(shows, head) {
  const lines = shows.filter((s) => s.url)
    .map((s) => `    <outline type="rss" text="${s.title || s.url}" title="${s.title || s.url}" xmlUrl="${s.url}"/>`);
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${head.title}</title>\n  </head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`,
    written: lines.length,
  };
}

// ── Answers as `lookupFeedUrls` returns them ───────────────────────────────
const G1 = '917393e3-1b1e-5cef-ace4-edaa54e1f810';
const G2 = 'c9e9b5b1-0000-4000-8000-000000000002';
const feed = (url, title = '') => ({ url, title });

const vectors = [
  // parseOpml
  { label: 'a Pocket Casts export: two feeds inside a folder outline', kind: 'parse', args: [POCKET_CASTS],
    expect: [o(NA, 'No Agenda Show'), o(PC20, 'Podcasting 2.0')], alsoNaive: true },
  { label: 'an AntennaPod export, single-quoted XML declaration, title over text', kind: 'parse', args: [ANTENNAPOD],
    expect: [o(PC20, 'Podcasting 2.0')], alsoNaive: true },
  { label: "Overcast's extended export: one show, its episode outlines are not shows", kind: 'parse',
    args: [OVERCAST_EXTENDED], expect: [o(ATP, 'Accidental Tech Podcast')], alsoNaive: true },
  { label: 'an escaped `&` in an address and a title is decoded — the address is a lookup key', kind: 'parse',
    args: [ESCAPED], expect: [o('https://example.com/feed?format=rss&tag=music', 'Mutton, Mead & Music')] },
  { label: 'single-quoted attributes and a lowercased `xmlurl` still read', kind: 'parse',
    args: [SINGLE_QUOTED_LOWERCASE], expect: [o(NA, 'No Agenda Show')] },
  { label: 'an outline inside a comment stays out', kind: 'parse', args: [COMMENTED_OUT],
    expect: [o(PC20, 'Podcasting 2.0')] },
  { label: 'a decoy `x-xmlUrl` ahead of the real one is not read', kind: 'parse', args: [DECOY],
    expect: [o(PC20, 'Podcasting 2.0')] },
  { label: 'an RSS feed picked by mistake is "not OPML", not "no feeds"', kind: 'parse', args: [RSS_NOT_OPML],
    expect: null },
  // planOpmlImport
  { label: 'public http(s) feeds are all looked up, in file order', kind: 'plan',
    args: [[o(NA, 'NA'), o(PC20, 'PC20')]], expect: { feeds: [NA, PC20], skipped: [], overCap: 0 }, alsoNaive: true },
  { label: 'a Patreon `?auth=` address never leaves the device', kind: 'plan',
    args: [[o(PATREON), o(PC20)]], expect: { feeds: [PC20], skipped: [[PATREON, 'private']], overCap: 0 } },
  { label: 'a Supercast address (key in the path) never leaves the device', kind: 'plan',
    args: [[o(SUPERCAST)]], expect: { feeds: [], skipped: [[SUPERCAST, 'private']], overCap: 0 } },
  { label: 'a user:password address never leaves the device', kind: 'plan',
    args: [[o(USERINFO)]], expect: { feeds: [], skipped: [[USERINFO, 'private']], overCap: 0 } },
  { label: 'an `access_token` parameter never leaves the device', kind: 'plan',
    args: [[o(TOKEN_PARAM)]], expect: { feeds: [], skipped: [[TOKEN_PARAM, 'private']], overCap: 0 } },
  { label: 'public feeds with ordinary query strings are still looked up', kind: 'plan',
    args: [[o(SQUARESPACE), o(YOUTUBE), o(AUTHOR_PARAM)]],
    expect: { feeds: [SQUARESPACE, YOUTUBE, AUTHOR_PARAM], skipped: [], overCap: 0 }, alsoNaive: true },
  { label: 'a javascript: or relative address is not a web address', kind: 'plan',
    args: [[o('javascript:alert(1)'), o('feeds/show.xml')]],
    expect: { feeds: [], skipped: [['javascript:alert(1)', 'not-web'], ['feeds/show.xml', 'not-web']], overCap: 0 } },
  { label: 'the same address twice is looked up once', kind: 'plan', args: [[o(PC20), o(PC20)]],
    expect: { feeds: [PC20], skipped: [[PC20, 'repeat']], overCap: 0 } },
  { label: `feeds past ${OPML_MAX_FEEDS} are counted, not planned`, kind: 'plan',
    args: [Array.from({ length: OPML_MAX_FEEDS + 3 }, (_, i) => o(`https://feeds.example.com/${i}.xml`))],
    expect: { feeds: OPML_MAX_FEEDS, skipped: [], overCap: 3 } },
  // sortOpmlAnswers
  { label: 'two found shows, neither a favorite: both are added', kind: 'sort',
    args: [[feed(NA), feed(PC20)], { [NA]: { podcastGuid: G1 }, [PC20]: { podcastGuid: G2 } }, []],
    expect: { add: [NA, PC20], already: [], notFound: [], noGuid: [], unasked: [] }, alsoNaive: true },
  { label: 'an ABSENT answer is "not looked up yet", never "not found"', kind: 'sort',
    args: [[feed(NA), feed(PC20)], { [NA]: null }, []],
    expect: { add: [], already: [], notFound: [NA], noGuid: [], unasked: [PC20] } },
  { label: 'a show with no podcast:guid cannot become a favorite', kind: 'sort',
    args: [[feed(NA)], { [NA]: { podcastGuid: '' } }, []],
    expect: { add: [], already: [], notFound: [], noGuid: [NA], unasked: [] } },
  { label: 'two addresses for ONE show add one favorite', kind: 'sort',
    args: [[feed(NA), feed(`${NA}?x=1`)], { [NA]: { podcastGuid: G1 }, [`${NA}?x=1`]: { podcastGuid: G1 } }, []],
    expect: { add: [NA], already: [`${NA}?x=1`], notFound: [], noGuid: [], unasked: [] } },
  { label: 'a show already in the favorites is left alone', kind: 'sort',
    args: [[feed(NA)], { [NA]: { podcastGuid: G1 } }, [G1]],
    expect: { add: [], already: [NA], notFound: [], noGuid: [], unasked: [] }, alsoNaive: true },
  // buildOpml → strict well-formedness + parseOpml
  { label: 'plain titles and addresses round-trip', kind: 'roundtrip',
    args: [[{ url: NA, title: 'No Agenda Show' }, { url: PC20, title: 'Podcasting 2.0' }]],
    expect: { written: 2, strict: [], read: [o(NA, 'No Agenda Show'), o(PC20, 'Podcasting 2.0')] }, alsoNaive: true },
  { label: 'an `&` in a title and a query string is escaped — unescaped, the file is not XML', kind: 'roundtrip',
    args: [[{ url: 'https://example.com/feed?format=rss&tag=music', title: 'Mutton, Mead & Music' }]],
    expect: { written: 1, strict: [], read: [o('https://example.com/feed?format=rss&tag=music', 'Mutton, Mead & Music')] } },
  { label: 'quotes and angle brackets in a title round-trip', kind: 'roundtrip',
    args: [[{ url: PC20, title: 'The "Best" <Show>' }]],
    expect: { written: 1, strict: [], read: [o(PC20, 'The "Best" <Show>')] } },
  { label: 'a control character is dropped and a lone surrogate replaced — XML 1.0 forbids both', kind: 'roundtrip',
    args: [[{ url: PC20, title: 'Tom\u0007 Jerry \ud800' }]],
    expect: { written: 1, strict: [], read: [o(PC20, 'Tom Jerry �')] } },
  { label: 'a show with no feed address is left out, not written as an empty xmlUrl', kind: 'roundtrip',
    args: [[{ title: 'Unresolved' }, { url: PC20, title: 'Podcasting 2.0' }]],
    expect: { written: 1, strict: [], read: [o(PC20, 'Podcasting 2.0')] }, alsoNaive: true },
  { label: 'a title that is only whitespace falls back to the address, as `text` requires', kind: 'roundtrip',
    args: [[{ url: PC20, title: '   ' }]],
    expect: { written: 1, strict: [], read: [o(PC20, PC20)] } },
];

/**
 * What a STRICT XML parser would reject in these bytes. The round trip reads
 * back with OUR scanner, which is lenient by design — it decodes `&tag=` as
 * the text it is — so it cannot see an unescaped file. The next app runs a
 * strict parser, so this names the three things one refuses: a bare `&`, a
 * raw `<` inside an attribute, and a character XML 1.0 forbids.
 */
function strictProblems(xml) {
  const problems = [];
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(xml)) problems.push('bare &');
  if (/="[^"]*<[^"]*"/.test(xml)) problems.push('< in an attribute');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(xml)) {
    problems.push('a forbidden character');
  }
  return problems;
}

// ── The dispatcher ─────────────────────────────────────────────────────────
const urlsOf = (list) => list.map((x) => x.url ?? x.feed.url);
const HEAD = { title: 'Boost Me Bitch favorites', created: new Date(Date.UTC(2026, 9, 30, 22)) };
const run = (impl, v) => {
  const real = impl === 'real';
  switch (v.kind) {
    case 'parse':
      return (real ? parseOpml : naiveParse)(...v.args);
    case 'plan': {
      const p = (real ? planOpmlImport : naivePlan)(...v.args);
      return {
        feeds: typeof v.expect.feeds === 'number' ? p.feeds.length : p.feeds.map((f) => f.url),
        skipped: p.skipped.map((s) => [s.url, s.reason]),
        overCap: p.overCap,
      };
    }
    case 'sort': {
      const [feeds, answers, favs] = v.args;
      const s = (real ? sortOpmlAnswers : naiveSort)(feeds, answers, (g) => favs.includes(g));
      return Object.fromEntries(Object.entries(s).map(([k, list]) => [k, urlsOf(list)]));
    }
    case 'roundtrip': {
      const built = (real ? buildOpml : naiveBuild)(v.args[0], HEAD);
      // Read back with the REAL reader either way: the question is whether the
      // file is readable, and the reader is pinned by its own vectors above.
      return { written: built.written, strict: strictProblems(built.xml), read: parseOpml(built.xml) };
    }
    default:
      throw new Error(`unknown kind ${v.kind}`);
  }
};
const call = (impl, v) => {
  try { return JSON.stringify(run(impl, v)); } catch (e) { return `threw ${(e && e.message) || e}`; }
};

console.log('OPML import and export — the shipping answer:');
for (const v of vectors) {
  const got = call('real', v);
  if (got !== JSON.stringify(v.expect)) fail(`"${v.label}" — expected ${JSON.stringify(v.expect)}, got ${got}`);
  else ok(v.label);
}

console.log('\nThe replay against naive():');
replayVectors({ vectors, invoke: call, fail });

// ── looksPrivate leans towards keeping back, but not on every query string ─
{
  const kept = [PATREON, SUPERCAST, USERINFO, TOKEN_PARAM, 'https://api.substack.com/feed/podcast/123/private/abc.rss'];
  const sent = [NA, PC20, SQUARESPACE, YOUTUBE, AUTHOR_PARAM];
  const wrongKept = kept.filter((u) => !looksPrivate(u));
  const wrongSent = sent.filter((u) => looksPrivate(u));
  if (wrongKept.length) fail(`looksPrivate lets these leave the device: ${wrongKept.join(', ')}`);
  else if (wrongSent.length) fail(`looksPrivate keeps back these public feeds: ${wrongSent.join(', ')}`);
  else ok(`looksPrivate keeps ${kept.length} private addresses back and sends ${sent.length} public ones`);
}

// ── The module must stay loadable under plain Node ─────────────────────────
{
  const path = 'lib/opml.ts';
  const problems = importFreeProblems(path);
  if (problems.length) { failures += 1; explainImportFree(path, problems); }
  else ok(`${path} has no imports`);
}

if (failures) {
  console.error(`\n${failures} OPML check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll OPML checks passed.');
