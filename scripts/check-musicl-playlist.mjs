// Pins `parsePlaylistRemoteItems` — the reader that turns a
// `<podcast:medium>musicL</podcast:medium>` playlist's channel into its track
// list, and therefore decides what a listener is shown, what they can play,
// and which identifiers a favorite writes to a SHARED kind:10333 event.
//
// A playlist publishes no `<item>` elements at all: the whole document is
// channel-level `<podcast:remoteItem feedGuid=… itemGuid=…/>`. So this parser
// is not one field of a feed, it IS the feed, and both failure directions are
// silent:
//
//   OVER-ACCEPT  A `<podcast:podroll>` entry is a recommended SHOW and a
//                `<podcast:liveItem>`'s remoteItem is one broadcast's current
//                song. Either read as a track puts rows in the list the
//                curator never published — and a heart on one writes an entry
//                naming a FEED as if it were an item, to a shared list with no
//                undo. An `x-feedGuid` decoy is the same substitution
//                `readAttr` documents, arriving through a new parser.
//
//   UNDER-ACCEPT An empty result renders as a playlist with no tracks, which
//                is indistinguishable from a feed that failed to load.
//
// Imports the REAL shipping parser, never a copy — a reimplementation stays
// green while the module drifts, which is the exact failure this exists to
// catch. Same arrangement as `check:feedxml` and `check:npub`, and it works for
// the same reason: `lib/feed-xml.ts` loads under
// `node --experimental-strip-types`. That is why the parser lives there rather
// than in `lib/pi.ts`, which cannot be loaded that way.
//
// Deliberately does NOT run `scripts/import-free.mjs`: `lib/feed-xml.ts` is not
// one of the modules that scan covers — it imports `nostr-tools`. See the note
// at the top of `scripts/check-feedxml.mjs`.
//
// FIXTURES COME FROM THE WIRE. The awkward shapes below are lifted verbatim
// from ChadFarrow/chadf-musicl-playlists HGH-music-playlist.xml: a colon-
// delimited `indiesats:npub…:…` item guid, a Mongo-style triple, a bare MP3
// URL, and a genuinely repeated pair (that feed writes 1770 entries of which
// 1217 are distinct). Real wire data carries the shapes nobody invents — a
// UUID-gated item parser would look correct forever against synthetic vectors.
import { parsePlaylistRemoteItems, channelSlice, MAX_PLAYLIST_REFS } from '../lib/feed-xml.ts';
import { isPlaylistMedium, playsAsTracks, filterPlaylistsByQuery, rankPlaylistsFirst, piRecordIsBlank, mergeRssOverPi, payableValue, PLAYLIST_MEDIUMS, SEARCH_TYPES, parseSearchType, matchesSearchType, mergeSearchLanes } from '../lib/util.ts';

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ok    ' + msg);

const ri = (feedGuid, itemGuid) =>
  `<podcast:remoteItem feedGuid="${feedGuid}" itemGuid="${itemGuid}"/>`;

const wrap = (inner) =>
  `<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">\n`
  + `  <channel>\n    <title>ChadF Homegrown Hits Music Playlist</title>\n`
  + `    <podcast:medium>musicL</podcast:medium>\n${inner}\n  </channel>\n</rss>`;

// Real guids from the live feed.
const G1 = '19215795-6853-5a12-8f84-8fe4d877ed53';
const I1 = '2c7ca646-ac69-44bb-a0de-c13297e0ad7b';
const G2 = '606dd394-6294-53cd-ba85-9ea5ca59407b';
const I2 = 'indiesats:npub13jml82yy69370amnfl0tfsreyg5hjqwxsmnttxv7g27usl8w5h5qnvtmat:54594dfd3ad9620fcc05d89caf2dd2a78bfe67790c76d85457130a4bcb804006';
const G3 = '054525df-0123-5647-8421-dd9083e56636';
const I3 = '5e8e4af89f932a4f8dc55486:5e8f306098ae344efaa56591:6a84edb7cbad795462a3342c';
const G4 = 'e64ef270-728d-51f0-8052-9fed4883f662';
const I4 = 'https://www.falsefinish.club/wp-content/uploads/2023/05/03.-Rings-of-Saturn_24Bit_Aria_Master_MTC.mp3';
const G5 = 'a2d2e313-9cbd-5169-b89c-ab07b33ecc33';
const I5 = '1c8b3ce3-45b6-4f7e-b5d6-10568e3328e4';

/**
 * Every vector is recorded as a CALL, and the replay at the foot of this file
 * walks the whole list. CLAUDE.md's rule: `check-assetlinks.mjs` shipped with a
 * header claiming a total replay and a footer naming six of twenty-nine by
 * hand, so a whole section sat green having been compared against nothing.
 * A vector cannot be added here without also being proved.
 */
const vectors = [];
function vec(label, xml, expect, opts = {}) {
  vectors.push({ label, args: [xml], expect, ...opts });
}

// ── MUST READ: ordinary playlists ───────────────────────────────────────────
vec(
  'a plain pair, exactly as the live feed writes it',
  wrap(`    ${ri(G1, I1)}`),
  [{ feedGuid: G1, itemGuid: I1 }],
  { alsoNaive: true },
);
vec(
  'a colon-delimited indiesats item guid (real wire)',
  wrap(`    ${ri(G2, I2)}`),
  [{ feedGuid: G2, itemGuid: I2 }],
  { alsoNaive: true },
);
vec(
  'a Mongo-style triple item guid (real wire)',
  wrap(`    ${ri(G3, I3)}`),
  [{ feedGuid: G3, itemGuid: I3 }],
  { alsoNaive: true },
);
vec(
  'a bare MP3 URL as the item guid (real wire)',
  wrap(`    ${ri(G4, I4)}`),
  [{ feedGuid: G4, itemGuid: I4 }],
  { alsoNaive: true },
);
vec(
  'single quotes and a paired (non self-closing) tag still read',
  wrap(`    <podcast:remoteItem feedGuid='${G1}' itemGuid='${I1}'></podcast:remoteItem>`),
  [{ feedGuid: G1, itemGuid: I1 }],
  { alsoNaive: true },
);
vec(
  'attributes in the other order, with newlines between them',
  wrap(`    <podcast:remoteItem\n      itemGuid="${I5}"\n      feedGuid="${G5}"\n    />`),
  [{ feedGuid: G5, itemGuid: I5 }],
  { alsoNaive: true },
);

// ── ORDER IS THE DATA ───────────────────────────────────────────────────────
// A playlist's running order is the order the entries are written in, and
// nothing on an entry restates it. Re-sorting or re-grouping loses it silently.
vec(
  'wire order is preserved across three entries',
  wrap(`    ${ri(G3, I3)}\n    ${ri(G1, I1)}\n    ${ri(G2, I2)}`),
  [
    { feedGuid: G3, itemGuid: I3 },
    { feedGuid: G1, itemGuid: I1 },
    { feedGuid: G2, itemGuid: I2 },
  ],
  { alsoNaive: true },
);
// ── EPISODE CAPTIONS ────────────────────────────────────────────────────────
// Three of the six below are `alsoNaive`: applying a caption FORWARD, leaving
// pre-marker items uncaptioned and treating a blank as no caption are what any
// reasonable implementation does, so they pin behaviour without discriminating.
// The three that bite are the ones with a real trap in them — the `purpose`
// filter, decoding, and dedupe keeping the first caption.
// `<podcast:txt purpose="episode">` marks which show a run of tracks came from.
// Every playlist in the collection that has them puts the marker BEFORE its run
// (HGH has 148, MMM 151), so a caption applies forward, never backward.
vec(
  'a marker captions the items that FOLLOW it, one group each',
  wrap(
    `    <podcast:txt purpose="episode">Homegrown Hits - Episode 147</podcast:txt>\n`
    + `    ${ri(G1, I1)}\n`
    + `    <podcast:txt purpose="episode">Homegrown Hits - Episode 146</podcast:txt>\n`
    + `    ${ri(G2, I2)}`,
  ),
  [
    { feedGuid: G1, itemGuid: I1, episode: 'Homegrown Hits - Episode 147' },
    { feedGuid: G2, itemGuid: I2, episode: 'Homegrown Hits - Episode 146' },
  ],
  { alsoNaive: true },
);
vec(
  'items before the first marker carry no caption',
  wrap(
    `    ${ri(G1, I1)}\n`
    + `    <podcast:txt purpose="episode">Episode 2</podcast:txt>\n`
    + `    ${ri(G2, I2)}`,
  ),
  [
    { feedGuid: G1, itemGuid: I1 },
    { feedGuid: G2, itemGuid: I2, episode: 'Episode 2' },
  ],
  { alsoNaive: true },
);
vec(
  'a NON-episode purpose does not caption anything',
  // Every playlist in the collection carries `purpose="source-feed"`, and other
  // feeds carry verification tokens and npubs under the same tag. Reading an
  // unqualified <podcast:txt> as a caption would print a feed URL as a heading.
  wrap(
    `    <podcast:txt purpose="source-feed">https://feed.homegrownhits.xyz/feed.xml</podcast:txt>\n`
    + `    ${ri(G1, I1)}`,
  ),
  [{ feedGuid: G1, itemGuid: I1 }],
);
vec(
  'an empty marker clears the caption rather than captioning with a blank',
  wrap(
    `    <podcast:txt purpose="episode">Episode 9</podcast:txt>\n`
    + `    ${ri(G1, I1)}\n`
    + `    <podcast:txt purpose="episode">   </podcast:txt>\n`
    + `    ${ri(G2, I2)}`,
  ),
  [{ feedGuid: G1, itemGuid: I1, episode: 'Episode 9' }, { feedGuid: G2, itemGuid: I2 }],
  { alsoNaive: true },
);
vec(
  'a caption is entity- and CDATA-decoded',
  wrap(
    `    <podcast:txt purpose="episode"><![CDATA[Mutton, Mead &amp; Music 150]]></podcast:txt>\n`
    + `    ${ri(G1, I1)}`,
  ),
  [{ feedGuid: G1, itemGuid: I1, episode: 'Mutton, Mead & Music 150' }],
);
vec(
  'a duplicate keeps the caption of its FIRST (newest) appearance',
  wrap(
    `    <podcast:txt purpose="episode">Episode 147</podcast:txt>\n`
    + `    ${ri(G1, I1)}\n`
    + `    <podcast:txt purpose="episode">Episode 12</podcast:txt>\n`
    + `    ${ri(G1, I1)}\n`
    + `    ${ri(G2, I2)}`,
  ),
  [
    { feedGuid: G1, itemGuid: I1, episode: 'Episode 147' },
    { feedGuid: G2, itemGuid: I2, episode: 'Episode 12' },
  ],
);

// ── DEDUPE ──────────────────────────────────────────────────────────────────
// Not cosmetic. `playNext`/`playPrev` locate the current track with
// `findIndex(e => e.id === …)` and a row's React key is that id, so two rows
// sharing one make the second unreachable. The FIRST occurrence wins, which is
// what keeps the curator's order intact.
vec(
  'a repeated pair appears once, at its FIRST position',
  wrap(`    ${ri(G1, I1)}\n    ${ri(G2, I2)}\n    ${ri(G1, I1)}`),
  [{ feedGuid: G1, itemGuid: I1 }, { feedGuid: G2, itemGuid: I2 }],
);
vec(
  'the same item guid under a different feed guid is a DIFFERENT track',
  wrap(`    ${ri(G1, I1)}\n    ${ri(G5, I1)}`),
  [{ feedGuid: G1, itemGuid: I1 }, { feedGuid: G5, itemGuid: I1 }],
  { alsoNaive: true },
);

// ── MUST NOT READ ───────────────────────────────────────────────────────────
vec(
  'a <podcast:podroll> entry is a recommended SHOW, never a track',
  wrap(
    `    <podcast:podroll>\n`
    + `      <podcast:remoteItem feedGuid="${G5}" feedUrl="https://example.com/f.xml"/>\n`
    + `      ${ri(G3, I3)}\n`
    + `    </podcast:podroll>\n`
    + `    ${ri(G1, I1)}`,
  ),
  [{ feedGuid: G1, itemGuid: I1 }],
);
vec(
  "a <podcast:liveItem>'s remoteItem is one broadcast's current song, not a track",
  wrap(
    `    <podcast:liveItem status="live">\n`
    + `      <title>On air</title>\n`
    + `      ${ri(G3, I3)}\n`
    + `    </podcast:liveItem>\n`
    + `    ${ri(G1, I1)}`,
  ),
  [{ feedGuid: G1, itemGuid: I1 }],
);
vec(
  'an x-feedGuid decoy ahead of the real attribute does not win',
  wrap(`    <podcast:remoteItem x-feedGuid="DECOY-FEED" feedGuid="${G1}" itemGuid="${I1}"/>`),
  [{ feedGuid: G1, itemGuid: I1 }],
);
vec(
  'an x-itemGuid decoy ahead of the real attribute does not win',
  wrap(`    <podcast:remoteItem feedGuid="${G1}" x-itemGuid="DECOY-ITEM" itemGuid="${I1}"/>`),
  [{ feedGuid: G1, itemGuid: I1 }],
);
// These two are exempt because `naive()` happens to require both attributes as
// well — that is a property of THESE INPUTS, not a hole in the real parser. The
// rule they pin still matters (a podroll-shaped entry outside a podroll block
// must not become a track), and the discriminating cases for it are the podroll
// and liveItem vectors above.
vec(
  'a podroll-shaped entry (feedUrl, no itemGuid) is not a track',
  wrap(`    <podcast:remoteItem feedGuid="${G5}" feedUrl="https://example.com/f.xml"/>\n    ${ri(G1, I1)}`),
  [{ feedGuid: G1, itemGuid: I1 }],
  { alsoNaive: true },
);
vec(
  'an entry with no feedGuid is dropped — an item guid alone is not a lookup key',
  wrap(`    <podcast:remoteItem itemGuid="${I1}"/>\n    ${ri(G2, I2)}`),
  [{ feedGuid: G2, itemGuid: I2 }],
  { alsoNaive: true },
);
vec(
  'an over-long feedGuid is refused (matches the batch route cap)',
  wrap(`    ${ri('g'.repeat(121), I1)}\n    ${ri(G1, I1)}`),
  [{ feedGuid: G1, itemGuid: I1 }],
);
vec(
  'an over-long itemGuid is refused (matches the batch route cap)',
  wrap(`    ${ri(G1, 'i'.repeat(2049))}\n    ${ri(G2, I2)}`),
  [{ feedGuid: G2, itemGuid: I2 }],
);
vec(
  'an empty playlist reads as empty, not as a parse failure',
  wrap('    <podcast:txt purpose="episode">Nothing yet</podcast:txt>'),
  [],
  { alsoNaive: true },
);

// ---------------------------------------------------------------------------
console.log('\nparsePlaylistRemoteItems reads what a playlist declares, and nothing else');
// ---------------------------------------------------------------------------
const real = (xml) => parsePlaylistRemoteItems(channelSlice(xml));

for (const v of vectors) {
  const got = real(...v.args);
  const want = v.expect;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`${v.label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
  } else {
    ok(v.label);
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe feed-supplied list is capped, and the cap is reported by its constant');
// ---------------------------------------------------------------------------
{
  // `safeFetch` accepts 8 MB, which is roughly 88,000 entries — so without a
  // cap one document decides how much this process allocates.
  const many = Array.from({ length: MAX_PLAYLIST_REFS + 50 },
    (_, i) => ri(G1, `track-${i}`)).join('\n');
  const got = real(wrap(many));
  if (got.length !== MAX_PLAYLIST_REFS) {
    fail(`over-long playlist not capped: got ${got.length}, want ${MAX_PLAYLIST_REFS}`);
  } else if (got[0].itemGuid !== 'track-0') {
    fail('the cap dropped from the FRONT — it must keep the first N, in wire order');
  } else {
    ok(`a ${MAX_PLAYLIST_REFS + 50}-entry playlist is cut to ${MAX_PLAYLIST_REFS}, keeping the first`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nEvery vector is proved against naive()');
// ---------------------------------------------------------------------------
{
  /**
   * What somebody actually writes: scan the whole document for
   * `<podcast:remoteItem>` and pull the two attributes with a plain regex.
   *
   * It passes every ordinary playlist — which is the point, and the reason a
   * vector that only exercises the happy path proves nothing. It is wrong on
   * podroll, on liveItem, on a decoy attribute and on duplicates, and each of
   * those is wrong SILENTLY: the list simply has rows in it that the curator
   * never published.
   */
  const naive = (xml) => {
    const out = [];
    let episode;
    const re = /<podcast:txt[^>]*>([\s\S]*?)<\/podcast:txt>|<podcast:remoteItem\b([^>]*?)\/?>/gi;
    for (const m of xml.matchAll(re)) {
      // Reads EVERY <podcast:txt> as a caption — no `purpose` check, no entity
      // or CDATA decoding. Both are the obvious omission, and both are wrong on
      // the real feeds: every playlist in the collection carries a
      // `purpose="source-feed"` tag, so this captions its first group with a URL.
      if (m[1] !== undefined) { episode = m[1].trim() || undefined; continue; }
      const feedGuid = /feedGuid="([^"]*)"/.exec(m[2])?.[1];
      const itemGuid = /itemGuid="([^"]*)"/.exec(m[2])?.[1];
      if (!feedGuid || !itemGuid) continue;
      out.push(episode ? { feedGuid, itemGuid, episode } : { feedGuid, itemGuid });
    }
    return out;
  };

  const call = (impl, v) => {
    try {
      return JSON.stringify(impl === 'real' ? real(...v.args) : naive(...v.args));
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
    } catch (e) {
      return `threw ${(e && e.message) || e}`;
    }
  };

  let exempt = 0;
  for (const v of vectors) {
    if (v.alsoNaive) {
      exempt += 1;
      console.log(`  ok    "${v.label}" is must-still-work — naive() may get it right`);
      continue;
    }
    if (call('real', v) !== call('naive', v)) {
      console.log(`  ok    naive() gets "${v.label}" wrong`);
      continue;
    }
    fail(`"${v.label}" passes against naive() too — the vector proves nothing.\n`
      + '          Either it is a must-still-work input (mark it { alsoNaive: true })\n'
      + '          or it does not exercise anything the real parser adds.');
  }
  console.log(`  ${vectors.length} vector(s) replayed, ${exempt} exempt as must-still-work`);
}

// ---------------------------------------------------------------------------
console.log('\nWhich mediums ARE playlists, and which of those play as tracks');
// ---------------------------------------------------------------------------
{
  // The spec gives EVERY medium an `L`-suffixed "list" counterpart, and says a
  // list feed contains only `<podcast:remoteItem>`s. So "a Podcasting 2.0
  // playlist" is that whole set, not `musicL` alone — the LocalBitcoiners
  // community playlist in ChadFarrow/chadf-musicl-playlists is a real `podcastL`
  // with 949 entries and the identical wire shape.
  const isPl = (m) => isPlaylistMedium({ medium: m });
  const tracks = (m) => playsAsTracks({ medium: m });

  for (const m of ['musicL', 'podcastL', 'videoL', 'filmL', 'audiobookL',
    'newsletterL', 'blogL', 'publisherL', 'courseL', 'mixedL',
    // Case is not ours to assume: PI returns the tag verbatim while the RSS
    // parsers lowercase it, so both spellings must reach the same answer.
    'musicl', 'PODCASTL']) {
    if (isPl(m)) ok(`${m} is a playlist`); else fail(`${m} should be a playlist medium`);
  }

  // MUST NOT be playlists. The `endsWith('l')` shortcut passes every row above
  // AND every row here today — no standard medium happens to end in `l` — which
  // is exactly why the allowlist exists: a feed writing `medium="cool"` must not
  // become a playlist, and the next medium the spec adds must not either.
  for (const m of ['music', 'podcast', 'publisher', 'video', 'film', 'audiobook',
    'newsletter', 'blog', 'course', 'mixed', 'cool', 'l', '', undefined]) {
    if (!isPl(m)) ok(`${JSON.stringify(m)} is not a playlist`);
    else fail(`${JSON.stringify(m)} must NOT be read as a playlist`);
  }

  // A `podcastL` is a playlist whose rows are EPISODES. If it played as tracks,
  // a tap would start playback instead of opening the detail view — putting the
  // show notes, chapters, transcript and discussion out of reach, which is the
  // whole reason somebody taps a podcast row.
  for (const m of ['music', 'musicL', 'musicl']) {
    if (tracks(m)) ok(`${m} rows behave as tracks`); else fail(`${m} rows should behave as tracks`);
  }
  for (const m of ['podcastL', 'videoL', 'blogL', 'podcast', 'publisher']) {
    if (!tracks(m)) ok(`${m} rows do NOT behave as tracks`);
    else fail(`${m} rows must not behave as tracks — a row tap has to open the detail view`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nWhich playlists a typed query surfaces');
// ---------------------------------------------------------------------------
{
  // The candidate set comes from /podcasts/bymedium, which byterm cannot filter
  // by medium. Whatever survives this filter is PREPENDED to the user's search
  // results and stamped as a playlist, so both directions cost something: a
  // non-playlist through here is mislabelled above better-ranked results, and an
  // over-eager match buries the show somebody was actually looking for.
  const F = [
    { title: 'ChadF Homegrown Hits Music Playlist', author: 'ChadFarrow', medium: 'musicL' },
    { title: 'Mutton, Mead & Music Playlist', author: 'ChadF', medium: 'musicL' },
    { title: 'LocalBitcoiners Community Playlist', author: 'ChadF', medium: 'podcastL' },
    { title: 'Homegrown Hits', author: 'Various', medium: 'podcast' },   // the SHOW, not a list
  ];
  const q = (s, n = 10) => filterPlaylistsByQuery(F, s, n).map((f) => f.title);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const cases = [
    ['homegrown', ['ChadF Homegrown Hits Music Playlist'], 'matches a title substring, and NOT the same-named podcast'],
    ['HOMEGROWN', ['ChadF Homegrown Hits Music Playlist'], 'is case-folded'],
    ['chadfarrow', ['ChadF Homegrown Hits Music Playlist'], 'matches the author too'],
    ['mutton music', ['Mutton, Mead & Music Playlist'], 'requires EVERY term, so it does not match on "music" alone'],
    ['localbitcoiners', ['LocalBitcoiners Community Playlist'], 'surfaces a podcastL, not only musicL'],
    ['', [], 'an empty query matches NOTHING — an empty box must not pour the index into the results'],
    ['   ', [], 'a whitespace-only query matches nothing'],
    ['zzzz', [], 'a miss is empty, not everything'],
  ];
  for (const [term, want, why] of cases) {
    if (eq(q(term), want)) ok(`${JSON.stringify(term)} ${why}`);
    else fail(`${JSON.stringify(term)} ${why}\n          got  ${JSON.stringify(q(term))}\n          want ${JSON.stringify(want)}`);
  }

  // Order is Podcast Index's, not ours — this is a filter, not a ranker.
  if (eq(q('playlist'), [F[0].title, F[1].title, F[2].title])) ok('preserves the order PI returned');
  else fail('must preserve PI order');

  // The cap is what stops a broad word jumping the queue ahead of the ranked
  // results. `limit <= 0` returning [] matters: the route passes a constant, and
  // a 0 read as "no limit" would prepend the whole roster.
  if (q('playlist', 2).length === 2) ok('honours the limit'); else fail('limit not honoured');
  if (filterPlaylistsByQuery(F, 'playlist', 0).length === 0) ok('a 0 limit yields nothing, never everything');
  else fail('limit 0 must yield nothing');

  // The medium is re-checked inside the filter rather than trusted from the
  // caller, so a base-medium feed that slipped into the roster cannot be
  // stamped as a playlist.
  const sneaky = [{ title: 'Homegrown Hits', author: 'Various', medium: 'podcast' }];
  if (filterPlaylistsByQuery(sneaky, 'homegrown', 5).length === 0) ok('re-checks the medium; a non-playlist never surfaces');
  else fail('a non-playlist must never surface through the playlist lane');

  // The roster is built by asking PI once per list medium, so the two must not
  // drift: a medium we RECOGNISE but never ASK about is a playlist the lane can
  // never surface.
  if (PLAYLIST_MEDIUMS.every((m) => isPlaylistMedium({ medium: m }))
      && PLAYLIST_MEDIUMS.length === 10) {
    ok(`PLAYLIST_MEDIUMS enumerates all ${PLAYLIST_MEDIUMS.length} list mediums`);
  } else fail('PLAYLIST_MEDIUMS must enumerate exactly the mediums isPlaylistMedium accepts');
}

// ---------------------------------------------------------------------------
console.log('\nA matching playlist is lifted out of where PI buried it');
// ---------------------------------------------------------------------------
{
  // VECTORS ARE REAL PRODUCTION RESPONSES, trimmed to the fields that decide the
  // order. Captured from the deployed /api/search on 2026-08-27 — the numbers in
  // `rankPlaylistsFirst`'s doc comment are these, and a synthetic list would not
  // have produced either of them: the `mutton` set is mostly mutton RECIPES and
  // a dog-behaviour show, which is why the playlist sank to eighth, and the
  // `flowgnar` set is the case that stops this from being a blind prepend.
  const MUTTON = [
    { id: 6594523, title: 'Mutton, Mead & Music', author: 'Øystein Berge', medium: 'podcast' },
    { id: 6796971, title: "The Luchi & Mutton's Podcast, Dog Behaviour & Nutrition", author: 'Surabhi Venkatesh', medium: 'podcast' },
    { id: 5368137, title: 'Best of Muttons in the Morning', author: 'Mediacorp', medium: 'podcast' },
    { id: 1276289, title: 'The Mutton Sandwich Podcast', author: 'Mediacorp', medium: 'podcast' },
    { id: 484374, title: 'British Baseball Podcast', author: 'Matthew Mutton', medium: 'podcast' },
    { id: 6803464, title: 'How Mutton Soup Caught Psycho Wife?', author: 'Wronged', medium: 'podcast' },
    { id: 7588571, title: 'Life in Stereo', author: 'Matthew Mutton', medium: 'podcast' },
    { id: 7476088, title: 'Mutton, Mead & Music Playlist', author: '', medium: 'musicL' },
    { id: 7827705, title: 'Adventure Time Together', author: 'Matthew Mutton', medium: 'podcast' },
  ];
  const FLOWGNAR = [
    { id: 6933361, title: 'Flowgnar', author: 'Kyle M. Bondo', medium: 'podcast' },
    { id: 7475965, title: 'Flowgnar Music Playlist', author: '', medium: 'musicL' },
  ];
  const ids = (a) => a.map((f) => f.id);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // THE BUG THIS FIXES. Position 8 in the live index, behind a dog-behaviour
  // show; second after the fix, under the podcast of the same name.
  const mutton = rankPlaylistsFirst(MUTTON, [], 'mutton', 6);
  if (mutton[1]?.id === 7476088 && mutton[0].id === 6594523) {
    ok('mutton: the playlist moves 8th → 2nd, under the same-named podcast');
  } else fail(`mutton ordering wrong: ${JSON.stringify(ids(mutton).slice(0, 3))}`);
  if (eq(ids(mutton).slice().sort(), ids(MUTTON).slice().sort())) ok('mutton: every result survives, nothing duplicated');
  else fail('mutton: promotion must not drop or duplicate a result');

  // THE CASE THAT STOPS IT BEING A BLIND PREPEND. Already correct in the live
  // index, and must come back byte-identical.
  const flow = rankPlaylistsFirst(FLOWGNAR, [], 'flowgnar', 6);
  if (eq(ids(flow), ids(FLOWGNAR))) ok('flowgnar: PI already had it right, so nothing moves');
  else fail(`flowgnar: must be unchanged, got ${JSON.stringify(ids(flow))}`);

  // A playlist that is ALREADY the leader stays the leader — the head is not
  // held back against itself, which would demote it to second behind a
  // non-match.
  const leadIsList = [FLOWGNAR[1], FLOWGNAR[0]];
  if (eq(ids(rankPlaylistsFirst(leadIsList, [], 'flowgnar', 6)), ids(leadIsList))) {
    ok('a playlist already ranked first stays first');
  } else fail('a leading playlist must not be demoted by its own promotion');

  // Roster-only hits still have a reason to exist, and come AFTER byterm's
  // ranked answers.
  const rosterOnly = [{ id: 999, title: 'Mutton Deep Cuts Playlist', author: '', medium: 'podcastL' }];
  const merged = rankPlaylistsFirst(MUTTON, rosterOnly, 'mutton', 6);
  if (merged[1]?.id === 7476088 && merged[2]?.id === 999) ok('a roster-only playlist lands after byterm\'s, both above the noise');
  else fail(`roster merge wrong: ${JSON.stringify(ids(merged).slice(0, 4))}`);
  if (rankPlaylistsFirst(MUTTON, [MUTTON[7]], 'mutton', 6).filter((f) => f.id === 7476088).length === 1) {
    ok('a playlist in BOTH lanes appears once');
  } else fail('a playlist present in both lanes must not be duplicated');

  // A query matching no playlist must leave the results exactly as PI ranked
  // them — this promotes, it never re-ranks.
  if (eq(ids(rankPlaylistsFirst(MUTTON, [], 'baseball', 6)), ids(MUTTON))) ok('no playlist match ⇒ PI order untouched');
  else fail('a non-matching query must not reorder anything');
  if (eq(rankPlaylistsFirst([], [], 'mutton', 6), [])) ok('an empty result set stays empty');
  else fail('empty in, empty out');
}

// ---------------------------------------------------------------------------
console.log('\nA feed Podcast Index registered but never parsed');
// ---------------------------------------------------------------------------
{
  // PI's ACTUAL record for ChadF's Greatest Hits playlist, captured from the
  // live index. The file carries a duplicate `xmlns:podcast`, so no XML parser
  // can read it — PI holds the URL with an empty title, a DERIVED v5 guid (it
  // had no <podcast:guid> to record) and the default medium.
  const PI_BLANK = {
    id: 7683902, podcastGuid: 'bdf5a0f9-d803-5d6d-81b6-d99bfba58e4e',
    title: '', author: null, description: '', medium: 'podcast',
  };
  const RSS = {
    id: -1312826522, title: "ChadF's Greatest Hits Music Playlist", author: 'ChadF',
    medium: 'musicl', image: 'https://example.com/gh.png', isPreview: true,
    podcastGuid: undefined,
  };

  for (const [label, v, want] of [
    ["PI's real Greatest Hits record", PI_BLANK, true],
    ['a title of only whitespace', { title: '   ' }, true],
    ['an absent title', {}, true],
    ['a null record', null, true],
    ['an undefined record', undefined, true],
    ['a normal PI record', { title: 'Homegrown Hits Music Playlist' }, false],
  ]) {
    if (piRecordIsBlank(v) === want) ok(`${label} → blank: ${want}`);
    else fail(`${label} should be blank: ${want}`);
  }

  const merged = mergeRssOverPi(PI_BLANK, RSS);
  // What only PI can supply, and what the rest of the app resolves by.
  if (merged.id === 7683902) ok('the repaired record keeps PI\'s feed id');
  else fail(`must keep PI's id, got ${merged.id}`);
  if (merged.podcastGuid === PI_BLANK.podcastGuid) ok('and PI\'s guid, which other clients agree on');
  else fail('must keep PI\'s guid');
  // What the publisher declares, read from the live feed moments ago.
  if (merged.title === RSS.title) ok('the title comes from the feed, so the row is visible at all');
  else fail('the feed\'s title must win over a blank one');
  if (merged.medium === 'musicl') ok('and the medium, so the playlist path engages');
  else fail('the feed\'s medium must win over PI\'s default');
  // PI DOES hold this feed; saying otherwise suppresses share, hearts and URL
  // mirroring for something that resolves by guid on any device.
  if (merged.isPreview === undefined) ok('isPreview is cleared — PI really does hold it');
  else fail('a repaired record must not claim to be a preview');
  // A feed PI has never seen keeps its own guid rather than inheriting nothing.
  const noGuid = mergeRssOverPi({ ...PI_BLANK, podcastGuid: undefined }, { ...RSS, podcastGuid: 'abc' });
  if (noGuid.podcastGuid === 'abc') ok('falls back to the feed\'s guid when PI has none');
  else fail('must fall back to the feed\'s guid');
}

// ---------------------------------------------------------------------------
console.log('\nWhose value block a boost for one row may be paid against');
// ---------------------------------------------------------------------------
{
  // A PLAYLIST'S ROWS LIVE IN OTHER PEOPLE'S FEEDS, so the container's
  // `<podcast:value>` is the CURATOR's — and `episode.value ?? podcast.value`,
  // which every boost surface read, hands it the track's payment. Both
  // directions are silent and both are expensive:
  //
  //   OVER-FALL-THROUGH  the modal renders a valid split, every leg reports ✓,
  //                      and the artist was never in it. The listener has no
  //                      way to see that from the screen, and the streaming
  //                      payer makes the same mistake six times an hour with
  //                      nobody looking at all.
  //   OVER-REFUSE        BOOST greys out on a feed that really does declare a
  //                      block. A disabled button reads as a feature this app
  //                      does not have, not as a bug — which is why the
  //                      must-still-work half below is as long as the other.
  //
  // The exempt vectors are the ones that pin the refusal's LIMITS: an
  // unindexed feed (no guids anywhere), a show-level boost on a playlist, and
  // the track block `fillTrackValues` resolves. Each is a property of that
  // input, not a hole — a naive fallback happens to get them right too.
  const ARTIST = { type: 'lightning', method: 'keysend', recipients: [{ name: 'Artist', type: 'node', address: '03aaa', split: 100 }] };
  const CURATOR = { type: 'lightning', method: 'keysend', recipients: [{ name: 'ChadF', type: 'node', address: '03ccc', split: 100 }] };
  const SHOW = { type: 'lightning', method: 'keysend', recipients: [{ name: 'Host', type: 'node', address: '03sss', split: 100 }] };
  const ALBUM_GUID = 'a2d2e313-9cbd-5169-b89c-ab07b33ecc33';
  const LIST_GUID = '30b31f6c-0000-5000-8000-000000000000';

  const vv = [];
  const val = (label, episode, podcast, expect, opts = {}) =>
    vv.push({ label, args: [episode, podcast], expect, ...opts });

  // ── must still work ──────────────────────────────────────────────────────
  val('an episode with no block of its own inherits the show\'s channel block',
    { }, { value: SHOW, medium: 'podcast' }, SHOW, { alsoNaive: true });
  val('the episode\'s own block always wins',
    { value: ARTIST }, { value: SHOW, medium: 'podcast' }, ARTIST, { alsoNaive: true });
  val('a feed Podcast Index has not indexed still falls through — neither side has a guid',
    { }, { value: SHOW, medium: 'podcast' }, SHOW, { alsoNaive: true });
  val('same guid on both sides is the same feed, so the fallback stands',
    { podcastGuid: ALBUM_GUID }, { value: SHOW, medium: 'podcast', podcastGuid: ALBUM_GUID },
    SHOW, { alsoNaive: true });
  val('a SHOW-level boost on a playlist pays the playlist\'s own block',
    // No episode: the listener chose the container, not an item in it. This is
    // the medium rule's limit — refusing here would take the playlist's own
    // BOOST away along with the bug.
    null, { value: CURATOR, medium: 'musicL', podcastGuid: LIST_GUID },
    CURATOR, { alsoNaive: true });
  val('a playlist row that HAS a block is paid against it — what fillTrackValues resolves',
    { value: ARTIST, podcastGuid: ALBUM_GUID },
    { value: CURATOR, medium: 'musicL', podcastGuid: LIST_GUID }, ARTIST, { alsoNaive: true });

  // ── must refuse ──────────────────────────────────────────────────────────
  val('a playlist row with no block of its own is NOT paid to the curator',
    { podcastGuid: ALBUM_GUID }, { value: CURATOR, medium: 'musicL', podcastGuid: LIST_GUID },
    undefined);
  val('the lowercased medium refuses too — PI returns musicL, the RSS parsers lowercase it',
    { podcastGuid: ALBUM_GUID }, { value: CURATOR, medium: 'musicl', podcastGuid: LIST_GUID },
    undefined);
  val('every list medium refuses, not musicL alone',
    { podcastGuid: ALBUM_GUID }, { value: CURATOR, medium: 'podcastL', podcastGuid: LIST_GUID },
    undefined);
  val('a playlist row refuses even when the container has no guid to compare',
    // The medium answers on its own: a list feed PI never indexed is still a
    // list feed, and the guid test has nothing to work with there.
    { podcastGuid: ALBUM_GUID }, { value: CURATOR, medium: 'musicL' }, undefined);
  val('DIFFERING GUIDS refuse on their own, whatever the container\'s medium says',
    // The container that forgot to declare a list medium — the same
    // discriminator the boost modal already uses to write remote_feed_guid.
    { podcastGuid: ALBUM_GUID }, { value: CURATOR, medium: 'podcast', podcastGuid: LIST_GUID },
    undefined);
  val('no podcast at all is undefined, not a throw',
    { }, undefined, undefined);

  const ser = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));
  const naive = (episode, podcast) => episode?.value ?? podcast.value;
  const call = (impl, v) => {
    try {
      return ser(impl === 'real' ? payableValue(...v.args) : naive(...v.args));
    } catch (e) {
      // A wrong implementation may throw where the real one answers. That
      // counts as differing — it is the loudest way to be wrong.
      return `threw ${(e && e.message) || e}`;
    }
  };

  for (const v of vv) {
    const got = call('real', v);
    if (got !== ser(v.expect)) {
      fail(`${v.label}\n          got  ${got}\n          want ${ser(v.expect)}`);
      continue;
    }
    if (v.alsoNaive) { ok(`${v.label} (must-still-work — naive() may agree)`); continue; }
    if (got !== call('naive', v)) ok(`${v.label} — and naive() gets it wrong`);
    else {
      fail(`"${v.label}" passes against naive() too — the vector proves nothing.\n`
        + '          Either it is a must-still-work input (mark it { alsoNaive: true })\n'
        + '          or it does not exercise anything payableValue adds.');
    }
  }
  console.log(`  ${vv.length} vector(s) replayed, ${vv.filter((v) => v.alsoNaive).length} exempt as must-still-work`);
}

// ---------------------------------------------------------------------------
console.log('\nWhich kind of thing the search box was asked for');
// ---------------------------------------------------------------------------
{
  // THE SEARCH TYPE SELECTOR. Three pure functions decide what a chip does, and
  // every one of them fails SILENTLY in at least one direction:
  //
  //   `parseSearchType`   picks which Podcast Index endpoint runs, from a
  //                       caller-supplied query parameter. Over-accept and an
  //                       unvalidated string reaches a URL we build.
  //
  //   `matchesSearchType` decides whether a feed belongs under a chip. UNDER-
  //                       accept is the expensive direction and it looks like
  //                       nothing: the row is simply absent, which reads as
  //                       "Podcast Index does not hold this show" rather than as
  //                       a filter. That is the whole failure the playlist lane
  //                       above exists to fix, arriving through a control the
  //                       user pressed themselves.
  //
  //   `mergeSearchLanes`  joins an endpoint that answered the medium question
  //                       with one that did not. Re-filter the first and it
  //                       discards exactly the rows it was asked to find.
  //
  // ONE naive() PER KIND, and the replay refuses a kind it has no implementation
  // for rather than comparing two absences — the trap `check:vpsummary` records,
  // where a whole file's worth of assertions sat green having been compared
  // against nothing under a header claiming otherwise.
  const naive = {
    // What somebody writes: the medium IS the type. It agrees on the two chips
    // whose name happens to equal a medium string and is wrong everywhere else —
    // most expensively on PODCASTS, because Podcast Index leaves the tag blank on
    // a large share of what it holds, so this empties the chip of most of the
    // index with no error anywhere.
    matches: (p, type) => p.medium === type,
    // What somebody writes: filter both lanes by the type and concatenate. It
    // gets the ordering and the byterm half right, which is what makes it
    // tempting, and it throws away every trusted-lane row whose PI `medium`
    // disagrees with the feed's own tag — the measured case, feed 7683902 — plus
    // it emits a feed present in both lanes twice.
    merge: (trusted, byterm, type, limit) =>
      [...trusted, ...byterm].filter((f) => matchesSearchType(f, type)).slice(0, limit),
    // What somebody writes: default when absent, otherwise take what you were
    // given. That is the missing allowlist.
    parse: (v) => v ?? 'all',
  };

  const ser = (v) => JSON.stringify(v ?? null);
  const vv = [];
  const vec = (kind, label, args, expect, opts = {}) => vv.push({ kind, label, args, expect, ...opts });

  // ── matchesSearchType: must still work ───────────────────────────────────
  vec('matches', 'a music feed is music', [{ medium: 'music' }, 'music'], true, { alsoNaive: true });
  vec('matches', 'a podcast feed is a podcast', [{ medium: 'podcast' }, 'podcast'], true, { alsoNaive: true });
  vec('matches', 'a music feed is not a podcast', [{ medium: 'music' }, 'podcast'], false, { alsoNaive: true });
  vec('matches', 'a playlist is not a podcast', [{ medium: 'musicL' }, 'podcast'], false, { alsoNaive: true });
  vec('matches', 'a music feed is not a playlist', [{ medium: 'music' }, 'playlist'], false, { alsoNaive: true });
  // The allowlist, not `endsWith('l')`. naive() happens to agree here because it
  // compares against the literal 'playlist'; the trap itself is pinned against
  // `isPlaylistMedium` in the LIST_MEDIUMS section above, which this delegates to.
  vec('matches', 'medium="cool" is NOT a playlist', [{ medium: 'cool' }, 'playlist'], false, { alsoNaive: true });
  vec('matches', 'no feed is ever a person', [{ medium: 'music' }, 'npub'], false, { alsoNaive: true });

  // ── matchesSearchType: must refuse the naive reading ─────────────────────
  // THE ONE THAT MATTERS. PI leaves `medium` off most of what it holds, so an
  // inclusion test empties the PODCASTS chip of the majority of the index — and
  // an absent row is indistinguishable from a feed PI does not have.
  vec('matches', 'a feed with NO medium is still a podcast', [{}, 'podcast'], true);
  vec('matches', 'an empty-string medium is still a podcast', [{ medium: '' }, 'podcast'], true);
  // A publisher collection is neither music nor a list, so it lands under
  // PODCASTS — a mild mislabel, and the alternative is a feed reachable under no
  // chip but ALL. The row carries its own `▸ ALBUMS` stamp.
  vec('matches', 'a publisher collection falls in the residual bucket', [{ medium: 'publisher' }, 'podcast'], true);
  // PI returns the tag's own spelling and the RSS parsers lowercase it, so both
  // reach this function. A literal comparison matches one path and not the other.
  vec('matches', 'PI\'s musicL spelling is a playlist', [{ medium: 'musicL' }, 'playlist'], true);
  vec('matches', 'the parsers\' lowercased musicl is too', [{ medium: 'musicl' }, 'playlist'], true);
  vec('matches', 'every list medium is a playlist, not musicL alone', [{ medium: 'podcastL' }, 'playlist'], true);
  vec('matches', 'an upper-case MUSIC is music', [{ medium: 'MUSIC' }, 'music'], true);
  vec('matches', 'ALL takes everything, whatever the medium says', [{ medium: 'audiobook' }, 'all'], true);
  vec('matches', 'ALL takes a feed with no medium too', [{}, 'all'], true);

  // ── mergeSearchLanes ─────────────────────────────────────────────────────
  const M_TRUSTED = [{ id: 101, medium: 'music' }, { id: 102, medium: 'music' }];
  const M_BYTERM = [{ id: 102, medium: 'music' }, { id: 200, medium: 'podcast' }, { id: 201, medium: 'music' }];
  vec('merge', 'the trusted lane leads, byterm follows, both filtered and deduped',
    [M_TRUSTED, M_BYTERM, 'music', 50], [{ id: 101, medium: 'music' }, { id: 102, medium: 'music' }, { id: 201, medium: 'music' }]);
  // FEED 7683902: PI holds `medium: "podcast"` over a feed that declares musicL.
  // `/search/music/byterm` answered the medium question by BEING that endpoint,
  // so re-checking its rows throws away the answer it gave. This is the whole
  // asymmetry with `filterPlaylistsByQuery`, which re-checks because its output
  // gets stamped ♫ PLAYLIST on screen and a stamp is a claim.
  vec('merge', 'a trusted row whose PI medium disagrees is KEPT',
    [[{ id: 7683902, medium: 'podcast' }], [], 'music', 50], [{ id: 7683902, medium: 'podcast' }]);
  // The half naive() also gets right, and must not be lost while fixing the half
  // it does not: byterm says nothing about the medium, so its rows are the ones
  // that DO have to pass the test. Dropping this test to "keep every row" would
  // make the MUSIC chip return podcasts.
  vec('merge', 'a byterm row that fails the type is dropped — nothing vouched for it',
    [[], [{ id: 300, medium: 'podcast' }], 'music', 50], [], { alsoNaive: true });
  vec('merge', 'a feed in BOTH lanes appears once, in the trusted lane\'s place',
    [[{ id: 9, medium: 'music' }], [{ id: 8, medium: 'music' }, { id: 9, medium: 'music' }], 'music', 50],
    [{ id: 9, medium: 'music' }, { id: 8, medium: 'music' }]);
  vec('merge', 'the limit caps the joined list', [M_TRUSTED, M_BYTERM, 'music', 2], M_TRUSTED, { alsoNaive: true });
  vec('merge', 'a 0 limit yields nothing, never everything', [M_TRUSTED, M_BYTERM, 'music', 0], [], { alsoNaive: true });
  vec('merge', 'an empty trusted lane leaves byterm doing the work alone',
    [[], M_BYTERM, 'music', 50], [{ id: 102, medium: 'music' }, { id: 201, medium: 'music' }], { alsoNaive: true });
  vec('merge', 'two empty lanes stay empty', [[], [], 'music', 50], [], { alsoNaive: true });

  // ── parseSearchType ──────────────────────────────────────────────────────
  vec('parse', 'a known type is itself', ['music'], 'music', { alsoNaive: true });
  vec('parse', 'an absent parameter is ALL', [null], 'all', { alsoNaive: true });
  vec('parse', 'an undefined parameter is ALL', [undefined], 'all', { alsoNaive: true });
  // An unvalidated value here reaches a URL we build against Podcast Index.
  vec('parse', 'an unknown value is ALL, never passed through', ['../../admin'], 'all');
  vec('parse', 'an empty string is ALL', [''], 'all');
  vec('parse', 'case and surrounding space are normalized', ['  MUSIC '], 'music');
  vec('parse', 'npub survives the round trip — it is a real mode, just not a lane', ['npub'], 'npub', { alsoNaive: true });

  const real = {
    matches: matchesSearchType,
    merge: mergeSearchLanes,
    parse: parseSearchType,
  };
  const call = (impl, v) => {
    const fn = impl === 'real' ? real[v.kind] : naive[v.kind];
    try {
      return ser(fn(...v.args));
    } catch (e) {
      // A wrong implementation may throw where the real one answers. That counts
      // as differing — it is the loudest way to be wrong.
      return `threw ${(e && e.message) || e}`;
    }
  };

  for (const v of vv) {
    // A kind with no naive() would compare `undefined` against `undefined` and
    // pass forever. Refuse rather than pretend.
    if (!real[v.kind] || !naive[v.kind]) { fail(`no implementation registered for kind "${v.kind}"`); continue; }
    const got = call('real', v);
    if (got !== ser(v.expect)) {
      fail(`${v.label}\n          got  ${got}\n          want ${ser(v.expect)}`);
      continue;
    }
    if (v.alsoNaive) { ok(`${v.label} (must-still-work — naive() may agree)`); continue; }
    if (got !== call('naive', v)) ok(`${v.label} — and naive() gets it wrong`);
    else {
      fail(`"${v.label}" passes against naive() too — the vector proves nothing.\n`
        + '          Either it is a must-still-work input (mark it { alsoNaive: true })\n'
        + '          or it does not exercise anything the real function adds.');
    }
  }
  console.log(`  ${vv.length} vector(s) replayed, ${vv.filter((v) => v.alsoNaive).length} exempt as must-still-work`);

  // Every chip the UI can render must be a type this parser accepts, or a chip
  // press sends a value the route silently rewrites to ALL — a control that
  // lights up and quietly does nothing, which is this repo's most-repeated bug.
  if (SEARCH_TYPES.every((s) => parseSearchType(s.type) === s.type)) {
    ok(`all ${SEARCH_TYPES.length} selector types round-trip through parseSearchType`);
  } else fail('a SEARCH_TYPES entry is not accepted by parseSearchType');
  // Every chip needs its own words. Two chips sharing a noun render two counts
  // that read identically over different lists — the collision `crossSplitLabel`
  // documents on the favorites page.
  if (new Set(SEARCH_TYPES.map((s) => s.noun)).size === SEARCH_TYPES.length
    && new Set(SEARCH_TYPES.map((s) => s.label)).size === SEARCH_TYPES.length) {
    ok('every selector type has a distinct label and result noun');
  } else fail('two selector types share a label or a result noun');
}

if (failures) {
  console.error(`\n${failures} playlist check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll playlist checks passed.');
