// Pins scripts/playlist-archive.mjs — the GitHub copy of every community
// playlist (docs/feeds.md, "The GitHub copy").
//
// What breaks silently here is a copy: deleted because a list was short or a
// switch answered 404, overwritten by an error page or a body cut off mid-way,
// written under a path a hostile id chose, or a commit on EVERY run because
// something in the output moved with the clock. And since 2026-11-19 (Chad: "can
// we note on GitHub that it was removed from the site?") a 410 KEEPS the copy, in
// playlists/removed/, with the time it was first seen: the old version deleted
// it, and a removal time stamped again on every run would commit every run.
// Each vector is replayed against `naive()`, the obvious version, and must prove
// it wrong.
//
// The feed fixture is the WIRE shape that /feeds/playlists/<id>.xml serves
// (captured 2026-11-19 from the "BMB test playlist" feed, ids and npub replaced):
// the channel <title> comes before <image><title>, and the <podcast:publisher>
// back-link is a remoteItem with no itemGuid.

import {
  canonicalId, listedIds, idsToVisit, feedVerdict, fileAction, songCount, tagText, indexEntry, buildIndex,
  commitMessage, feedUrlFor, removalTimes, removedEntry, FEED_ORIGIN, REMOVED_DIR,
} from './playlist-archive.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); failures++; };

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok    ${label}`);
  else fail(`${label}\n        expected ${e}\n        actual   ${a}`);
}

const ID = 'ed79e282-3d6e-4764-adb5-8702eaf77086';
const OTHER = '11111111-2222-4333-8444-555555555555';
const O = FEED_ORIGIN;

const feed = (id = ID, { title = 'Rock &amp; Roll &#8211; test', medium = 'musicL', tail = '</rss>\n' } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${title}</title>
    <description>test playlist for BMB</description>
    <link>${O}/feeds/playlists/${id}.xml</link>
    <language>en</language>
    <pubDate>Mon, 16 Nov 2026 01:32:37 GMT</pubDate>
    <lastBuildDate>Mon, 16 Nov 2026 18:30:00 GMT</lastBuildDate>
    <generator>Boost Me Buddy (https://www.boostmebuddy.com)</generator>
    <podcast:guid>2bb7307c-c7ed-558d-9a9b-b018e86c8d67</podcast:guid>
    <podcast:publisher>
      <podcast:remoteItem medium="publisher" rel="curator" feedGuid="385ee3de-9325-5781-a073-e57885a97b5f" feedUrl="${O}/feeds/publishers/npub1example.xml"/>
    </podcast:publisher>
    <podcast:medium>${medium}</podcast:medium>
    <podcast:txt purpose="npub">npub1example</podcast:txt>
    <image>
      <url>https://example.com/art.jpg</url>
      <title>image title, not the channel's</title>
      <link>${O}/feeds/playlists/${id}.xml</link>
    </image>
    <podcast:remoteItem feedGuid="7b6bc244-743a-5639-81c4-7ebafea342d8" itemGuid="f10868ca-5733-4a1d-b526-8b0cc637b21d" feedUrl="https://feeds.fountain.fm/Pw6d3L9h2Itp3KxLpF3a" medium="music"/>
    <podcast:remoteItem feedGuid="69c634ad-afea-5826-ad9a-8e1f06d6470b" itemGuid="b94b1090-8c7f-4c59-87ad-b8034ec058b3" feedUrl="https://example.com/Kurtisdrums-V1.xml" medium="music"/>
  </channel>
${tail}`;

const FEED = feed();

// ---------------------------------------------------------------------------
// The obvious versions, each wrong in the way a vector below names.

const naive = {
  // A listed id is the file name as given.
  canonicalId: (raw) => (typeof raw === 'string' && raw ? raw : null),
  // Every id in the body, as given.
  listedIds: (body) => (body && Array.isArray(body.playlists) ? body.playlists.map((p) => p.id) : null),
  // Only what the list names.
  idsToVisit: (listed) => [...(listed ?? [])].sort(),
  // A 200 is a feed; anything else is gone.
  feedVerdict: (_id, _o, status, text) => (status === 200 ? { kind: 'feed', xml: text } : { kind: 'gone' }),
  // Every remoteItem is a song.
  songCount: (xml) => xml.split('<podcast:remoteItem').length - 1,
  // The raw text between the tags.
  tagText: (xml, tag) => {
    const s = xml.indexOf(`<${tag}>`);
    return s < 0 ? '' : xml.slice(s + tag.length + 2, xml.indexOf(`</${tag}>`, s));
  },
  // The version before 2026-11-19: a 410 DELETES the copy, so nothing is left to say it was removed.
  fileAction: (verdict, old) => {
    const exists = typeof old === 'string';
    if (verdict.kind === 'feed') return exists && old === verdict.xml ? 'unchanged' : 'write';
    if (verdict.kind === 'gone') return exists ? 'remove' : 'none';
    return exists ? 'keep' : 'none';
  },
  // Whatever the last index says, as given: a junk file throws, and a hostile id or a non-date is kept.
  removalTimes: (text) => new Map(JSON.parse(text).removed.map((e) => [e.id, e.removed])),
};

const real = { canonicalId, listedIds, idsToVisit, feedVerdict, songCount, tagText, fileAction, removalTimes };

// The action a run takes on a file holding `old`, given one answer.
const actionVia = (impl, [id, status, text, old]) => impl.fileAction(impl.feedVerdict(id, O, status, text), old);

const T1 = '2026-11-20T01:07:00.000Z';
const idx1 = (removed) => JSON.stringify({ origin: O, count: 0, playlists: [], removed });

const vectors = [
  // canonicalId — the id becomes a path.
  { label: 'a lower-case uuid is its own file name', kind: 'id', args: [ID], expect: ID, alsoNaive: true },
  { label: 'an upper-case id is lower-cased (one file on a case-blind disk)', kind: 'id', args: [ID.toUpperCase()], expect: ID },
  { label: 'a path climbing out of the folder is refused', kind: 'id', args: ['../../.github/workflows/x'], expect: null },
  { label: 'a uuid with a suffix is refused', kind: 'id', args: [`${ID}.xml`], expect: null },
  { label: 'a number is refused', kind: 'id', args: [12], expect: null, alsoNaive: true },

  // listedIds
  { label: 'list: a bad id is skipped, the rest kept, sorted and unique', kind: 'list',
    args: [{ playlists: [{ id: OTHER }, { id: '../x' }, { id: ID }, { id: ID.toUpperCase() }] }], expect: [OTHER, ID].sort() },
  { label: 'list: not the list answer at all', kind: 'list', args: [{ error: 'not found' }], expect: null, alsoNaive: true },

  // idsToVisit — rule 2.
  { label: 'a copy the list does not name is still asked about (list cap, beta down)', kind: 'visit',
    args: [[ID], [OTHER]], expect: [ID, OTHER].sort() },
  { label: 'no list at all: the copies on disk are still asked about', kind: 'visit', args: [null, [OTHER]], expect: [OTHER] },

  // feedVerdict + fileAction — rules 1 and 3.
  { label: '410: the copy is KEPT, moved to removed/ (Chad: note it, do not drop it)', kind: 'action',
    args: [ID, 410, 'Gone', FEED], expect: 'move-to-removed' },
  { label: '404 (both switches off): the copy STAYS', kind: 'action', args: [ID, 404, 'Not Found', FEED], expect: 'keep' },
  { label: '500: the copy stays', kind: 'action', args: [ID, 500, '', FEED], expect: 'keep' },
  { label: '301 (a redirect is not followed): the copy stays', kind: 'action', args: [ID, 301, '', FEED], expect: 'keep' },
  { label: 'a 200 error page does not overwrite the copy', kind: 'action',
    args: [ID, 200, '<!doctype html><title>Error</title>', FEED], expect: 'keep' },
  { label: 'a 200 body cut off before </rss> does not overwrite the copy', kind: 'action',
    args: [ID, 200, feed(ID, { tail: '' }), feed(ID, { title: 'older' })], expect: 'keep' },
  { label: "another playlist's feed is not written under this id", kind: 'action',
    args: [ID, 200, feed(OTHER), undefined], expect: 'none' },
  { label: 'a feed that is not musicL is not written', kind: 'action',
    args: [ID, 200, feed(ID, { medium: 'music' }), undefined], expect: 'none' },
  { label: 'a whole new feed is written', kind: 'action', args: [ID, 200, FEED, undefined], expect: 'write', alsoNaive: true },
  { label: 'a changed feed is written', kind: 'action', args: [ID, 200, FEED, feed(ID, { title: 'older' })], expect: 'write', alsoNaive: true },
  { label: 'the same bytes are not written again (no empty commit)', kind: 'action', args: [ID, 200, FEED, FEED], expect: 'unchanged', alsoNaive: true },
  { label: '410 with no copy: nothing to do', kind: 'action', args: [ID, 410, '', undefined], expect: 'none', alsoNaive: true },

  // removalTimes — rule 5: the time is read back from the last index, never stamped again.
  { label: 'times: a removal time from the last index is carried', kind: 'times',
    args: [idx1([{ id: ID, removed: T1 }])], expect: [[ID, T1]], alsoNaive: true },
  { label: 'times: an index from before removed/ existed gives none, not a crash', kind: 'times',
    args: [JSON.stringify({ origin: O, count: 1, playlists: [] })], expect: [] },
  { label: 'times: a junk index.json gives none, not a crash', kind: 'times', args: ['{"removed": [tr'], expect: [] },
  { label: 'times: an id that is not a uuid is skipped', kind: 'times',
    args: [idx1([{ id: '../x', removed: T1 }, { id: OTHER, removed: T1 }])], expect: [[OTHER, T1]] },
  { label: 'times: a removal time that is not a time is skipped (that copy is stamped once more)', kind: 'times',
    args: [idx1([{ id: ID, removed: 'yesterday' }])], expect: [] },
  { label: 'times: an upper-case id is the lower-case file', kind: 'times',
    args: [idx1([{ id: ID.toUpperCase(), removed: T1 }])], expect: [[ID, T1]] },

  // songCount — the publisher back-link is not a song.
  { label: 'songs: the publisher back-link is not counted', kind: 'songs', args: [FEED], expect: 2 },

  // tagText — the channel title, unescaped.
  { label: 'title: the CHANNEL title, entities decoded', kind: 'title', args: [FEED, 'title'], expect: 'Rock & Roll – test' },
  { label: 'title: plain text is untouched', kind: 'title', args: [feed(ID, { title: 'Plain' }), 'title'], expect: 'Plain', alsoNaive: true },
];

function run(impl, v) {
  try {
    switch (v.kind) {
      case 'id': return impl.canonicalId(...v.args);
      case 'list': return impl.listedIds(...v.args);
      case 'visit': return impl.idsToVisit(...v.args);
      case 'action': return actionVia(impl, v.args);
      case 'times': return [...impl.removalTimes(...v.args)];
      case 'songs': return impl.songCount(...v.args);
      case 'title': return impl.tagText(...v.args);
      default: throw new Error(`unknown kind ${v.kind}`);
    }
  } catch (e) {
    return `threw: ${e instanceof Error ? e.message : e}`;
  }
}

console.log('expected values');
for (const v of vectors) check(v.label, run(real, v), v.expect);

console.log('naive replay');
replayVectors({
  vectors,
  invoke: (which, v) => JSON.stringify(run(which === 'real' ? real : naive, v)),
  fail,
});

console.log('indexEntry / buildIndex');
const entry = indexEntry(ID, O, FEED);
check('an index entry is read from the feed', entry, {
  id: ID,
  title: 'Rock & Roll – test',
  podcastGuid: '2bb7307c-c7ed-558d-9a9b-b018e86c8d67',
  feedUrl: feedUrlFor(O, ID),
  file: `${ID}.xml`,
  songs: 2,
  updated: '2026-11-16T01:32:37.000Z',
});
check('a bad pubDate is null, not a crash', indexEntry(ID, O, FEED.replace(/<pubDate>[^<]*/, '<pubDate>soon')).updated, null);
const older = { ...entry, id: OTHER, updated: '2026-11-01T00:00:00.000Z' };
const idx = buildIndex([older, entry]);
check('the index is the same text on every run (no clock in it)', idx === buildIndex([entry, older]), true);
check('the index has no time-of-run field', /generated|now|runAt/i.test(idx), false);
check('newest change first', JSON.parse(idx).playlists.map((p) => p.id), [ID, OTHER]);

check('an index with no removed copy says so with an empty list', JSON.parse(idx).removed, []);

console.log('removed copies in the index');
const gone = removedEntry(OTHER, O, feed(OTHER, { title: 'Gone one' }), T1);
check('a removed entry names its file in removed/, and when', [gone.file, gone.removed, gone.feedUrl, gone.title],
  [`${REMOVED_DIR}/${OTHER}.xml`, T1, feedUrlFor(O, OTHER), 'Gone one']);
const withGone = JSON.parse(buildIndex([entry], [gone]));
check('the live count and list leave the removed copy out', [withGone.count, withGone.playlists.map((p) => p.id)], [1, [ID]]);
check('the removed list holds it', withGone.removed.map((p) => [p.id, p.removed]), [[OTHER, T1]]);
const T0 = '2026-11-19T09:00:00.000Z';
const gone2 = removedEntry(ID, O, FEED, T0);
check('removed copies: newest removal first', JSON.parse(buildIndex([], [gone2, gone])).removed.map((p) => p.id), [OTHER, ID]);

// Rule 5 across two runs: run 1 stamps the move with ITS clock; run 2, an hour later,
// reads run 1's index and must write the same bytes, or every run commits.
const run1 = buildIndex([entry], [removedEntry(OTHER, O, feed(OTHER), T1)]);
const later = '2026-11-20T02:07:00.000Z';
const carried = removalTimes(run1);
const run2 = buildIndex([entry], [removedEntry(OTHER, O, feed(OTHER), carried.get(OTHER) ?? later)]);
check('the next run writes the same index (the time is carried)', run2 === run1, true);
const restamped = buildIndex([entry], [removedEntry(OTHER, O, feed(OTHER), later)]);
check('and a run that stamped it again would not (this test can fail)', restamped === run1, false);

console.log('commitMessage');
check('nothing changed: no message', commitMessage({ added: [], changed: [], removed: [] }), null);
check('a title with a newline stays on one line',
  commitMessage({ added: [{ id: ID, title: 'a\nb' }] }), `playlists: 1 added\n\nAdded:\n- ${ID} a b\n`);
check('a removal says the site removed it and where the copy went',
  commitMessage({ removed: [{ id: ID, title: 'test' }] }),
  `playlists: 1 removed from the site\n\nRemoved from the site (the feed answers 410). The last copy moves to playlists/${REMOVED_DIR}/:\n- ${ID} test\n`);
check('a playlist back on the site is named',
  commitMessage({ restored: [{ id: ID, title: 'test' }] }),
  `playlists: 1 back on the site\n\nBack on the site (moved out of playlists/${REMOVED_DIR}/):\n- ${ID} test\n`);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ok');
