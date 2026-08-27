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
import { isPlaylistMedium, playsAsTracks } from '../lib/util.ts';

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

if (failures) {
  console.error(`\n${failures} playlist check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll playlist checks passed.');
