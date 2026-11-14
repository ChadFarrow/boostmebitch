// Pins lib/moved-feeds.ts — the decisions behind following a favorite whose
// feed host closed (RSS Blue, 2026-11-14). See
// docs/superpowers/specs/2026-11-14-moved-feeds-design.md.
//
// Every function here decides something a person cannot undo by looking:
// which host counts as closed (a lookalike must not), which copy receives
// boosts with no press (a copycat must not), which copy is OFFERED (a
// title-only match must not be), and what a REPLACE removes from a shared
// list (an unplaceable track must stay).

import {
  closedService, itemOnClosedHost, normTitle, pickLiveTwin, movedCandidates, matchTracks, planSwap, mergeResolvedRow,
} from '../lib/moved-feeds.ts';
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

console.log('closedService');
check('a closed feed host', closedService('https://feeds.rssblue.com/worried'), 'RSS Blue');
check('a closed media host behind the op3 prefix',
  closedService('https://op3.dev/e,pg=7153bbb0-b8c4-521f-80c0-cef62d8ef67b/media.rssblue.com/podcasts/worried/x.mp3'), 'RSS Blue');
check('a closed media host behind the podtrac prefix',
  closedService('https://dts.podtrac.com/redirect.mp3/media.rssblue.com/a.mp3'), 'RSS Blue');
check('a lookalike host is not closed', closedService('https://media.rssblue.com.evil.example/a.jpg'), null);
check('a lookalike path segment is not closed', closedService('https://example.com/media.rssblue.com.evil/a.jpg'), null);
check('a live host is not closed', closedService('https://feeds.fountain.fm/aCFEYwJijoBbZSUP32JA'), null);
check('not a URL', closedService('not a url'), null);
check('empty', closedService(''), null);
check('undefined', closedService(undefined), null);
check('null', closedService(null), null);

console.log('itemOnClosedHost');
check('an enclosure behind op3 on a closed host',
  itemOnClosedHost({ enclosureUrl: 'https://op3.dev/e,pg=x/media.rssblue.com/podcasts/w/a.mp3', image: 'https://feeds.fountain.fm/c.jpg' }), true);
check('only the cover on a closed host', itemOnClosedHost({ image: 'https://media.rssblue.com/podcasts/w/cover.jpg' }), true);
check('only the feed cover on a closed host', itemOnClosedHost({ feedImage: 'https://media.rssblue.com/podcasts/w/cover.jpg' }), true);
check('a live item', itemOnClosedHost({ enclosureUrl: 'https://feeds.fountain.fm/x/a.mp3', image: 'https://feeds.fountain.fm/x/c.jpg' }), false);
check('nothing known', itemOnClosedHost({}), false);

console.log('normTitle');
check('punctuation does not split a title', normTitle('Mr. Videoman') === normTitle('Mr Videoman'), true);
check('ampersand and spaces', normTitle('  Rock & Roll '), 'rock and roll');
check('missing', normTitle(undefined), '');

console.log('pickLiveTwin');
const G = '7153bbb0-b8c4-521f-80c0-cef62d8ef67b';
const dead = { id: 7101864, podcastGuid: G, url: 'https://feeds.rssblue.com/worried', title: 'Worried', author: 'Suzanne Santo', lastCrawlTime: 1754571449 };
const live = { id: 7520866, podcastGuid: G, url: 'https://feeds.fountain.fm/aCFEYwJijoBbZSUP32JA', title: 'Worried', author: 'Suzanne Santo', lastCrawlTime: 1783936530 };
check('the same-guid copy on a live host', pickLiveTwin(dead, [dead, live])?.id, 7520866);
check('a copycat author is refused', pickLiveTwin(dead, [dead, { ...live, author: 'Copycat FM' }]), null);
check('a PI-dead copy is refused', pickLiveTwin(dead, [{ ...live, dead: 1 }]), null);
check('another closed copy is refused', pickLiveTwin(dead, [{ ...live, id: 9, url: 'https://feeds.rssblue.com/worried-2' }]), null);
check('a different guid is refused', pickLiveTwin(dead, [{ ...live, podcastGuid: 'other' }]), null);
check('the dead record itself is not its twin', pickLiveTwin(dead, [dead]), null);
// A scraped copycat copies the guid AND the author, and a publisher can push
// `lastCrawlTime` with a podping: with two candidates nothing tells the real
// copy apart, and this one is paid with no press. Follow none (final review).
check('two live same-guid same-artist copies: follow none',
  pickLiveTwin(dead, [{ ...live, id: 1, lastCrawlTime: 100 }, { ...live, id: 2, lastCrawlTime: 200 }]), null);
check('two copies with the same crawl time: follow none',
  pickLiveTwin(dead, [{ ...live, id: 5, lastCrawlTime: 100 }, { ...live, id: 8, lastCrawlTime: 100 }]), null);
check('the same copy listed twice is still one copy',
  pickLiveTwin(dead, [live, { ...live }])?.id, 7520866);
check('a copycat with a different author does not make the real copy ambiguous',
  pickLiveTwin(dead, [live, { ...live, id: 9, author: 'Copycat FM' }])?.id, 7520866);
check('an author spelled with different punctuation still matches',
  pickLiveTwin(dead, [{ ...live, author: 'suzanne  santo.' }])?.id, 7520866);
check('a dead record with no author has no twin', pickLiveTwin({ ...dead, author: '' }, [{ ...live, author: '' }]), null);

console.log('movedCandidates');
const mrv = { id: 7097000, podcastGuid: 'f842b7c8-9f12-54f2-a0b8-4f95c63dad4c', url: 'https://feeds.rssblue.com/mr-videoman', title: 'Mr. Videoman', author: 'Prosperous Soul' };
const found = movedCandidates(mrv, [
  mrv,
  { id: 7854985, title: 'Mr Videoman', author: 'Prosperous Soul', podcastGuid: '9b2014ae-ca84-552d-9283-8510b686adc7', url: 'https://feeds.fountain.fm/qWWVxucTwMppOeUK9OnC' },
  { id: 6813307, title: 'Mr. Videoman', author: 'Prosperous Soul', podcastGuid: 'a6eb05db-c941-54d9-9037-251e408e373e', url: 'https://wavlake.com/feed/music/6f43fedd' },
  { id: 7401947, title: 'Runaway Train', author: 'Josephus', podcastGuid: 'x1', url: 'https://wavlake.com/feed/music/3a4f' },
  { id: 1, title: 'Mr. Videoman', author: 'Someone Else', podcastGuid: 'x2', url: 'https://example.com/a.xml' },
  { id: 2, title: 'Mr. Videoman', author: 'Prosperous Soul', podcastGuid: 'x3', url: 'https://feeds.rssblue.com/x' },
  { id: 3, title: 'Underground', author: 'Prosperous Soul', podcastGuid: 'x4', url: 'https://feeds.fountain.fm/u' },
]);
check('same title AND artist, live host, new guid', found.map((f) => f.id), [7854985, 6813307]);
check('a same-guid copy is the twin, not a candidate',
  movedCandidates(dead, [live]).map((f) => f.id), []);
const many = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, title: 'Mr Videoman', author: 'Prosperous Soul', podcastGuid: `g${i}`, url: `https://feeds.fountain.fm/${i}` }));
check('never more than three', movedCandidates(mrv, many).length, 3);
check('the same feed listed twice is offered once',
  movedCandidates(mrv, [many[0], many[0]]).map((f) => f.id), [100]);

console.log('matchTracks');
check('by normalized title, unmatched reported',
  matchTracks([{ itemGuid: 'a', title: 'Mr. Videoman' }, { itemGuid: 'b', title: 'Lost' }], [{ guid: 'n1', title: 'Mr Videoman' }]),
  { moves: [{ oldItemGuid: 'a', newItemGuid: 'n1' }], unmatched: ['b'] });
check('one new item takes one old item',
  matchTracks([{ itemGuid: 'a', title: 'Song' }, { itemGuid: 'b', title: 'Song' }], [{ guid: 'n1', title: 'Song' }]),
  { moves: [{ oldItemGuid: 'a', newItemGuid: 'n1' }], unmatched: ['b'] });
check('an old item with no title is unmatched',
  matchTracks([{ itemGuid: 'a' }], [{ guid: 'n1', title: '' }]),
  { moves: [], unmatched: ['a'] });

console.log('planSwap');
const oldItems = [{ itemGuid: 'a', title: 'Mr. Videoman' }, { itemGuid: 'b', title: 'Lost' }];
const newItems = [{ guid: 'n1', title: 'Mr Videoman' }];
const none = new Set();
check('album row: feed out, feed in, matched track moves, unmatched stays',
  planSwap({ scope: 'feed', feedFav: {}, newFeedIsFav: false, oldItems, newItems, favItemGuids: none }),
  { removeFeed: true, addFeed: true, moves: [{ oldItemGuid: 'a', newItemGuid: 'n1', addNew: true }], unmatched: ['b'] });
check('the new album is already a favorite: not added twice',
  planSwap({ scope: 'feed', feedFav: {}, newFeedIsFav: true, oldItems, newItems, favItemGuids: none }).addFeed, false);
check('album row with no album favorite: tracks only',
  planSwap({ scope: 'feed', feedFav: null, newFeedIsFav: false, oldItems, newItems, favItemGuids: none }),
  { removeFeed: false, addFeed: false, moves: [{ oldItemGuid: 'a', newItemGuid: 'n1', addNew: true }], unmatched: ['b'] });
check('a carried track is never in the plan',
  planSwap({ scope: 'feed', feedFav: {}, newFeedIsFav: false, oldItems: [{ itemGuid: 'a', title: 'Mr. Videoman', carried: true }, oldItems[1]], newItems, favItemGuids: none }),
  { removeFeed: true, addFeed: true, moves: [], unmatched: ['b'] });
check('a carried album is neither removed nor replaced',
  (({ removeFeed, addFeed }) => ({ removeFeed, addFeed }))(planSwap({ scope: 'feed', feedFav: { carried: true }, newFeedIsFav: false, oldItems, newItems, favItemGuids: none })),
  { removeFeed: false, addFeed: false });
check('track row: only that track, no feed change',
  planSwap({ scope: { itemGuid: 'a' }, feedFav: {}, newFeedIsFav: false, oldItems, newItems, favItemGuids: none }),
  { removeFeed: false, addFeed: false, moves: [{ oldItemGuid: 'a', newItemGuid: 'n1', addNew: true }], unmatched: [] });
check('the new track is already a favorite: the old one goes, nothing is added',
  planSwap({ scope: 'feed', feedFav: null, newFeedIsFav: false, oldItems, newItems, favItemGuids: new Set(['n1']) }).moves,
  [{ oldItemGuid: 'a', newItemGuid: 'n1', addNew: false }]);

console.log('mergeResolvedRow');
check('keeps addedAt, medium and carried from the painted row',
  mergeResolvedRow({ addedAt: 5, medium: 'music', carried: true }, { addedAt: 99, title: 'x' }),
  { addedAt: 5, title: 'x', medium: 'music', carried: true });
check('a placeholder addedAt of 0 is not inherited',
  mergeResolvedRow({ addedAt: 0 }, { addedAt: 99 }).addedAt, 99);
check('carried is cleared when the painted row is not carried',
  mergeResolvedRow({ addedAt: 0 }, { addedAt: 99, carried: true }).carried, undefined);
check('a resolved medium wins over the painted hint',
  mergeResolvedRow({ addedAt: 1, medium: 'podcast' }, { addedAt: 2, medium: 'music' }).medium, 'music');
// The paint loop gives EVERY entry a row, so no painted row means the entry
// left the store after the paint — a heart, or a REPLACE on exactly the
// closed-host rows this re-resolves. Re-adding it undid the swap and
// republished the old guid (final review, 2026-11-14).
check('no painted row: removed since the paint, so not re-added',
  mergeResolvedRow(undefined, { addedAt: 7, medium: 'music' }), null);

const problems = importFreeProblems('lib/moved-feeds.ts');
if (problems.length) {
  explainImportFree('lib/moved-feeds.ts', problems);
  failures++;
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ok');
