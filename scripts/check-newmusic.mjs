// Pins lib/new-music.ts — the decisions behind the NEW MUSIC section on
// /favorites: which albums a favorited publisher (artist) feed lists that the
// reader has NOT been shown, and which of those become a row.
//
// Each function decides something the reader cannot see go wrong:
//
// - A first look at an artist must NOT announce the whole back catalogue. The
//   obvious version ("every album not seen is new") does exactly that on the
//   first pass, because nothing has been seen yet — `naive()` below replays it
//   and the first-check vectors must fail against it.
// - An album must be recognised by EITHER of its keys. Podcast Index answers
//   with a guid and a URL; the RSS fallback (`couldNotAskPi`) may answer with
//   the URL alone. Matching on one key only re-announces every album the pass
//   after PI was rate limiting.
// - A failed read of a publisher feed must not move what was seen, and an
//   unfavorited artist's rows and memory must go.

import {
  albumKeys, rowKey, planPublisher, selectNewMusic, mergeNewMusicRows, pruneNewMusic, stalestFirst, capKeys, newMusicArtists,
  NEW_MUSIC_WINDOW_SECS, NEW_MUSIC_CAP, NEW_MUSIC_SEEN_CAP,
} from '../lib/new-music.ts';
import { parsePublisherRef } from '../lib/feed-xml.ts';
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

// The obvious implementation: no first-check rule, one key, no window.
function naive(prevSeen, albums) {
  const seen = new Set(prevSeen ?? []);
  return albums.filter((a) => !seen.has(a.podcastGuid));
}

const NOW = 1_800_000_000; // unix seconds
const DAY = 86_400;
const A = (n, extra = {}) => ({
  id: 100 + n,
  podcastGuid: `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`,
  url: `https://feeds.example.com/album-${n}`,
  title: `Album ${n}`,
  ...extra,
});

console.log('albumKeys');
check('guid and url, guid first', albumKeys(A(1)), ['guid:00000001-aaaa-4bbb-8ccc-dddddddddddd', 'url:https://feeds.example.com/album-1']);
check('a guid is compared without case', albumKeys({ podcastGuid: 'ABC-DEF', title: '' }), ['guid:abc-def']);
check('a trailing slash and the host case do not split a URL',
  albumKeys({ url: 'https://Feeds.Example.com/a/', title: '' }), ['url:https://feeds.example.com/a']);
check('the path case is kept: paths are case-sensitive',
  albumKeys({ url: 'https://feeds.example.com/A', title: '' }), ['url:https://feeds.example.com/A']);
check('an album with neither has no key', albumKeys({ title: 'x' }), []);
check('a blank guid is not a key', albumKeys({ podcastGuid: '  ', title: '' }), []);

console.log('rowKey');
check('the guid key when there is one', rowKey({ album: A(2) }), 'guid:00000002-aaaa-4bbb-8ccc-dddddddddddd');
check('the url key otherwise', rowKey({ album: { url: 'https://x.example/f', title: '' } }), 'url:https://x.example/f');

console.log('planPublisher');
const listed = [A(1), A(2), A(3)];
const first = planPublisher(undefined, listed);
check('a first look is a first look', first.first, true);
check('a first look offers every album as a CANDIDATE for "latest"', first.candidates.map((a) => a.id), [101, 102, 103]);
check('a first look marks every album seen', first.nextSeen.length, 6);
// The vector `naive()` must fail: with nothing seen, it calls the whole back
// catalogue new. The first-check rule is what turns three albums into at most
// one row (selectNewMusic below).
check('naive() announces the back catalogue on a first look', naive(undefined, listed).length, 3);

const later = planPublisher(first.nextSeen, [...listed, A(4)]);
check('a later look is not a first look', later.first, false);
check('a later look offers only the album not seen', later.candidates.map((a) => a.id), [104]);
check('a later look keeps what was seen and adds the new keys', later.nextSeen.length, 8);

// Seen under PI (guid + url), listed again from RSS with the URL only — the
// `couldNotAskPi` answer. Matching on the guid alone calls it new.
const rssOnly = { url: A(1).url, title: 'Album 1', id: 0 };
check('an album seen by guid is still seen when only its URL comes back',
  planPublisher(first.nextSeen, [rssOnly]).candidates, []);
check('naive() calls the RSS-only copy new', naive(listed.map((a) => a.podcastGuid), [rssOnly]).length, 1);
check('an album seen by URL is still seen when its guid arrives later',
  planPublisher(['url:https://feeds.example.com/album-1'], [A(1)]).candidates, []);
check('the guid that arrived later is remembered too',
  planPublisher(['url:https://feeds.example.com/album-1'], [A(1)]).nextSeen.includes('guid:00000001-aaaa-4bbb-8ccc-dddddddddddd'), true);
check('an album with no key is never a candidate', planPublisher([], [{ title: 'x' }]).candidates, []);
check('an EMPTY seen list is a later look, not a first one', planPublisher([], [A(1)]).first, false);

const many = Array.from({ length: 300 }, (_, i) => `url:https://x.example/${i}`);
const capped = planPublisher(many, [A(9)]).nextSeen;
check('seen is capped', capped.length, NEW_MUSIC_SEEN_CAP);
check('the cap keeps the NEWEST keys', capped.slice(-2), ['guid:00000009-aaaa-4bbb-8ccc-dddddddddddd', 'url:https://feeds.example.com/album-9']);

console.log('selectNewMusic — first look');
const dates = { 101: NOW - 400 * DAY, 102: NOW - 10 * DAY, 103: NOW - 30 * DAY };
check('a first look shows ONE album: the newest, inside the window',
  selectNewMusic({ first: true, candidates: listed, dates, nowSec: NOW, favoriteKeys: new Set() }).map((r) => [r.album.id, r.date]),
  [[102, NOW - 10 * DAY]]);
check('a first look shows nothing when the newest album is older than the window',
  selectNewMusic({ first: true, candidates: [A(1)], dates: { 101: NOW - NEW_MUSIC_WINDOW_SECS - 1 }, nowSec: NOW, favoriteKeys: new Set() }), []);
check('a first look shows nothing when no album has a date',
  selectNewMusic({ first: true, candidates: listed, dates: {}, nowSec: NOW, favoriteKeys: new Set() }), []);
check('a first look shows nothing when the newest album is already a favorite — never the second newest',
  selectNewMusic({ first: true, candidates: listed, dates, nowSec: NOW, favoriteKeys: new Set(albumKeys(A(2))) }), []);
check('a date from the future is not "newest"',
  selectNewMusic({ first: true, candidates: [A(1), A(2)], dates: { 101: NOW + 365 * DAY, 102: NOW - DAY }, nowSec: NOW, favoriteKeys: new Set() }).map((r) => r.album.id),
  [102]);

console.log('selectNewMusic — later look');
check('a new album with a recent date is a row',
  selectNewMusic({ first: false, candidates: [A(4)], dates: { 104: NOW - DAY }, nowSec: NOW, favoriteKeys: new Set() }).map((r) => r.album.id), [104]);
// A new album is often not in Podcast Index yet, so it has no id and no date.
// That is the case this feature exists for.
check('a new album with NO date is a row',
  selectNewMusic({ first: false, candidates: [{ ...A(4), id: 0 }], dates: {}, nowSec: NOW, favoriteKeys: new Set() }).map((r) => r.album.title), ['Album 4']);
check('a newly LISTED album that is old is not a row (a back catalogue moving hosts)',
  selectNewMusic({ first: false, candidates: [A(4)], dates: { 104: NOW - 400 * DAY }, nowSec: NOW, favoriteKeys: new Set() }), []);
check('an album already in favorites is not a row',
  selectNewMusic({ first: false, candidates: [A(4)], dates: { 104: NOW - DAY }, nowSec: NOW, favoriteKeys: new Set(['url:https://feeds.example.com/album-4']) }), []);
check('a row carries no date it was not given',
  'date' in selectNewMusic({ first: false, candidates: [{ ...A(4), id: 0 }], dates: {}, nowSec: NOW, favoriteKeys: new Set() })[0], false);

console.log('mergeNewMusicRows');
const r = (n, date, foundAt = 1) => ({ album: A(n), publisherGuid: 'P', date, foundAt });
check('newest first, by date',
  mergeNewMusicRows([r(1, NOW - 5 * DAY)], [r(2, NOW - DAY)], undefined).map((x) => x.album.id), [102, 101]);
check('a row with no date sorts by when it was found',
  mergeNewMusicRows([r(1, NOW - 5 * DAY)], [{ album: { ...A(2), id: 0 }, publisherGuid: 'P', foundAt: NOW * 1000 }], undefined).map((x) => x.album.title),
  ['Album 2', 'Album 1']);
check('the same album found twice is one row, the stored one kept',
  mergeNewMusicRows([r(1, NOW - 5 * DAY, 7)], [r(1, NOW - 5 * DAY, 9)], undefined).map((x) => x.foundAt), [7]);
check('the same album by URL only is the same row',
  mergeNewMusicRows([r(1, NOW - DAY)], [{ album: { url: A(1).url, title: 'Album 1', id: 0 }, publisherGuid: 'P', foundAt: 2 }], undefined).length, 1);
check('a dismissed row does not come back',
  mergeNewMusicRows([], [r(3, NOW)], new Set([rowKey(r(3, NOW))])), []);
check('a dismissed row does not come back under its other key',
  mergeNewMusicRows([], [r(3, NOW)], new Set(['url:https://feeds.example.com/album-3'])), []);
const lots = Array.from({ length: NEW_MUSIC_CAP + 5 }, (_, i) => r(i + 1, NOW - i * DAY));
check('capped', mergeNewMusicRows([], lots, undefined).length, NEW_MUSIC_CAP);
check('the cap drops the OLDEST', mergeNewMusicRows([], lots, undefined).at(-1).album.id, 100 + NEW_MUSIC_CAP);

console.log('pruneNewMusic');
const rec = {
  checkedAt: 5,
  seen: { P: ['a'], Q: ['b'] },
  checked: { P: 1, Q: 2 },
  rows: [{ ...r(1, NOW), publisherGuid: 'P' }, { ...r(2, NOW), publisherGuid: 'Q' }],
};
const pruned = pruneNewMusic(rec, ['P']);
check('an unfavorited artist loses its rows', pruned.rows.map((x) => x.publisherGuid), ['P']);
check('an unfavorited artist loses what was seen, so a re-favorite is a first look again', Object.keys(pruned.seen), ['P']);
check('an unfavorited artist loses its check time', Object.keys(pruned.checked), ['P']);
check('prune keeps checkedAt', pruned.checkedAt, 5);
check('prune does not mutate', Object.keys(rec.seen), ['P', 'Q']);

console.log('stalestFirst');
check('never checked first, then oldest check',
  stalestFirst(['A', 'B', 'C'], { A: 30, C: 10 }), ['B', 'C', 'A']);
check('stable among equals', stalestFirst(['X', 'Y'], {}), ['X', 'Y']);

console.log('capKeys');
check('keeps the newest keys', capKeys(['a', 'b', 'c'], 2), ['b', 'c']);
check('drops a repeat, keeping the latest position', capKeys(['a', 'b', 'a'], 5), ['b', 'a']);

console.log('newMusicArtists');
const FAVPUB = { podcastGuid: '64569161-a8f7-52e5-8aae-9e0385043149', url: 'https://feeds.fountain.fm/VUDmJJ8Eo1byHznQtHIn', title: 'Haleen' };
const FOLLOW_NJ = { feedGuid: 'aa909244-7555-4b52-ad88-7233860c6fb4', feedUrl: 'https://wavlake.com/feed/artist/aa909244-7555-4b52-ad88-7233860c6fb4', title: 'Nate Johnivan', addedAt: 1 };
check('favorites first, then device follows',
  newMusicArtists([FAVPUB], { [FOLLOW_NJ.feedGuid]: FOLLOW_NJ }).map((a) => a.title), ['Haleen', 'Nate Johnivan']);
check('a device follow carries its feed address',
  newMusicArtists([], { [FOLLOW_NJ.feedGuid]: FOLLOW_NJ })[0].url, FOLLOW_NJ.feedUrl);
check('one artist in both is one artist, and the favorite wins',
  newMusicArtists([FAVPUB], { x: { feedGuid: FAVPUB.podcastGuid.toUpperCase(), feedUrl: 'https://other.example/f', title: 'Dup', addedAt: 1 } }),
  [FAVPUB]);
check('a follow with no address is skipped',
  newMusicArtists([], { x: { feedGuid: FOLLOW_NJ.feedGuid, feedUrl: '', addedAt: 1 } }), []);

// ---- parsePublisherRef (lib/feed-xml.ts) — an album's artist feed ----------
// Fixtures are the WIRE bytes, copied from the feeds on 2026-11-15.
console.log('parsePublisherRef');
const NJ = { feedGuid: 'aa909244-7555-4b52-ad88-7233860c6fb4', feedUrl: 'https://wavlake.com/feed/artist/aa909244-7555-4b52-ad88-7233860c6fb4' };
const HALEEN = { feedGuid: '64569161-a8f7-52e5-8aae-9e0385043149', feedUrl: 'https://feeds.fountain.fm/VUDmJJ8Eo1byHznQtHIn' };
// Tinderbox, Nate Johnivan, on Wavlake: the remoteItem is BARE in the channel.
const WAVLAKE = `<channel><title>Tinderbox</title><author><![CDATA[Nate Johnivan]]></author>
  <podcast:medium>music</podcast:medium>
  <podcast:remoteItem medium="publisher" feedGuid="${NJ.feedGuid}" feedUrl="${NJ.feedUrl}">
  </podcast:remoteItem>
  <podcast:category text="Pop"/>`;
// A Fountain album: the spec's wrapper.
const FOUNTAIN = `<channel><title>Garden Of The Soul</title><podcast:medium>music</podcast:medium>
  <podcast:publisher>
    <podcast:remoteItem feedGuid="${HALEEN.feedGuid}" feedUrl="${HALEEN.feedUrl}" medium="publisher" title="Haleen"/>
  </podcast:publisher>`;
// A podroll recommending ANOTHER artist's publisher feed.
const PODROLL = `<channel><podcast:medium>music</podcast:medium>
  <podcast:podroll><podcast:remoteItem medium="publisher" feedGuid="${HALEEN.feedGuid}" feedUrl="${HALEEN.feedUrl}"/></podcast:podroll>`;
// The obvious reader: the first remoteItem anywhere saying medium="publisher".
function naivePublisherRef(xml) {
  const m = xml.match(/<podcast:remoteItem[^>]*medium="publisher"[^>]*feedGuid="([^"]*)"[^>]*feedUrl="([^"]*)"/);
  return m ? { feedGuid: m[1], feedUrl: m[2] } : undefined;
}
check('Wavlake: the bare channel remoteItem', parsePublisherRef(WAVLAKE), NJ);
check('Fountain: the spec wrapper', parsePublisherRef(FOUNTAIN), HALEEN);
check('the wrapper with no medium attribute still names the publisher',
  parsePublisherRef(`<podcast:publisher><podcast:remoteItem feedGuid="${NJ.feedGuid}" feedUrl="${NJ.feedUrl}"/></podcast:publisher>`), NJ);
check('a podroll recommending an artist is NOT this album\'s artist', parsePublisherRef(PODROLL), undefined);
check('naive() takes the podroll\'s artist', naivePublisherRef(PODROLL), HALEEN);
check('a remote item inside the channel value block is not the artist',
  parsePublisherRef(`<podcast:value type="lightning"><podcast:valueTimeSplit startTime="1" duration="2"><podcast:remoteItem medium="publisher" feedGuid="${NJ.feedGuid}" feedUrl="${NJ.feedUrl}"/></podcast:valueTimeSplit></podcast:value>`),
  undefined);
check('a bare remote item of another medium is not the artist',
  parsePublisherRef(`<podcast:remoteItem medium="music" feedGuid="${NJ.feedGuid}" feedUrl="${NJ.feedUrl}"/>`), undefined);
check('a bare remote item with no medium is not the artist',
  parsePublisherRef(`<podcast:remoteItem feedGuid="${NJ.feedGuid}" feedUrl="${NJ.feedUrl}"/>`), undefined);
check('single-quoted attributes are read',
  parsePublisherRef(`<podcast:remoteItem medium='publisher' feedGuid='${NJ.feedGuid}' feedUrl='${NJ.feedUrl}'/>`), NJ);
check('the medium is compared without case',
  parsePublisherRef(`<podcast:remoteItem medium="Publisher" feedGuid="${NJ.feedGuid}" feedUrl="${NJ.feedUrl}"/>`), NJ);
check('no feedUrl: nothing',
  parsePublisherRef(`<podcast:remoteItem medium="publisher" feedGuid="${NJ.feedGuid}"/>`), undefined);
check('a javascript: feedUrl: nothing',
  parsePublisherRef(`<podcast:remoteItem medium="publisher" feedGuid="${NJ.feedGuid}" feedUrl="javascript:alert(1)"/>`), undefined);
check('a feedGuid that is not a guid: nothing',
  parsePublisherRef(`<podcast:remoteItem medium="publisher" feedGuid="joe-martin" feedUrl="${NJ.feedUrl}"/>`), undefined);
check('a decoy x-feedUrl does not steer it (readAttr)',
  parsePublisherRef(`<podcast:remoteItem medium="publisher" x-feedUrl="https://evil.example/f" feedGuid="${NJ.feedGuid}" feedUrl="${NJ.feedUrl}"/>`), NJ);
check('the wrapper wins over a bare one', parsePublisherRef(`${WAVLAKE}${FOUNTAIN}`), HALEEN);
check('an album that names no artist', parsePublisherRef('<channel><title>x</title><podcast:medium>music</podcast:medium>'), undefined);

const problems = importFreeProblems('lib/new-music.ts');
if (problems.length) {
  explainImportFree('lib/new-music.ts', problems);
  failures++;
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ok');
