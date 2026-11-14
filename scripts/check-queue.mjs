// Pins the four pure decisions the listen queue rests on.
//
// Usage:
//   npm run check:queue
//
// Run it after ANY edit to the queue helpers in lib/util.ts.
//
// WHY THIS EARNS A CHECK SCRIPT. The queue is a list somebody assembled by
// hand, it persists per npub, and every one of these fails SILENTLY.
//
// `epKey` is the identity of a queued item. It decides which row a Remove press
// takes, which row `queueIndexOf` matches, and whether an add is a duplicate.
// It shipped as `e.guid ?? …`, and `??` falls through only on null and
// undefined — so a feed publishing `<guid></guid>` gave every one of its
// episodes the key `''`. `extractText` in lib/pi.ts returns undefined for a
// MISSING or self-closing tag and an empty string for an empty one, which it
// trims; PI's JSON carries `""` the same way. The failure is the queue removing
// or jumping to the wrong episode, on feeds this app already parses.
//
// `trimForQueue` is a DENYLIST, and that is the whole decision. The two large
// fields the queue never renders come out; everything else stays. An allowlist
// looks tidier and is wrong in one direction that matters: it drops whatever is
// added to `Episode` next, and the fields most likely to be added here are
// money. Losing prose costs a refetch. Losing `valueTimeSplits` streams a music
// show to the show instead of to each artist, invisibly, days after the queue
// was built.
//
// `queueShowFor` is the container rule. A `musicL` playlist lists tracks living
// in hundreds of other feeds, and `<EpisodeList>` renders those containers — so
// the feed you were looking at is not always the show you queued. It refuses
// NARROWLY, the same shape as `payableValue`: the item AND the container must
// each declare a `podcastGuid`, and they must disagree. And when it does
// refuse, the curator's own facts (`nostrNpubs`, `funding`, …) go with it.
//
// `nextPlayableIndexBy` is the walk `stepTo` and both halves of
// `<TransportControls>` share. If they disagree, ⏭ draws enabled over a step
// that refuses to move, or disabled over one that would — which is exactly the
// bug PR #132's own browser pass found on the last chapter of a queued episode.
//
// So all four live in lib/util.ts, whose only import is type-only, and this
// script imports the REAL module under `--experimental-strip-types`. A
// reimplemented copy here would stay green while the shipping code drifted.
// (It deliberately does NOT run `importFreeProblems`: that scan rejects
// type-only relative imports, and lib/util.ts has one. `check:vts` imports this
// same module on the same terms.)
//
// EVERY VECTOR IS A RECORDED CALL, NOT A BARE ASSERTION. The `naive*` functions
// at the foot are the obvious wrong versions, and the whole list is replayed
// against them, because a vector that passes the moment it is written has
// proved nothing. Three of the four naives are not inventions: `naiveKey` is
// the `??` that shipped, `naiveShow` is the pass-through that shipped, and
// `naiveTrim` is the allowlist the denylist comment argues against. Exemptions
// are named one at a time with `alsoNaive: true` — the must-still-work half,
// where over-blocking would be its own regression.

//
// THE PLAY HISTORY rides on the same module and the same reasons (2026-10-01).
// `listenStep` decides what counts as a minute of listening, so a seek or a
// resume deep into an episode cannot put a sampled episode in the history.
// `addToHistory` is a LOG, the opposite of the queue: at the cap the OLDEST
// entry goes, and a re-listen moves to the top. Its naive is the queue's own
// rule copied across, which is the mistake the shared `epKey` invites.
// `boostedOnDevice` draws "⚡ N boosted" beside a BOOST button, so it counts
// only the sats that SETTLED — the boost log keeps a boost whose every leg
// failed — and it reports an unanswered leg, because a mark that says
// "nothing sent" over sats a wallet may have paid invites the double payment
// invariant 11 exists to stop.

//
// THE FAVORITES SHUFFLE rides here too (2026-11-12), because it is a second list
// of the queue's own `QueueItem`s and fails the same silent ways. `shuffleOrder`
// is Fisher-Yates on a COPY: the naive is the `sort(() => random() - 0.5)`
// everyone writes first, which is biased and sorts the caller's array in place —
// the favorites page's own rows. `insertShuffled` places the tracks that load
// after the first one has started, and must never put one at or before the
// track playing now, where it would never be reached. `shuffleIndexOf` is the
// shuffle's `queueIndexOf`, matched by `epKey`, so `<guid></guid>` cannot
// collide. `shuffleTrackFor` is the money half: the stored record's value block
// goes (the player reads the payee from the track's own feed), and the show is
// an ALLOWLIST, so nothing a favorite or a cached record carries can ride onto
// the show that streams are keyed and boost notes are written from.

import {
  addToHistory,
  boostedOnDevice,
  epKey,
  LISTEN_QUEUE_CAP,
  listenStep,
  nextPlayableIndexBy,
  PLAY_HISTORY_CAP,
  playsAsTracks,
  queueShowFor,
  insertShuffled,
  shuffleIndexOf,
  shuffleOrder,
  shuffleTrackFor,
  episodeFromFavorite,
  fnvHash,
  sameCurrentTrack,
  trimForQueue,
} from '../lib/util.ts';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${label}`); return; }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

function section(name) { console.log(`\n${name}`); }

/** An epKey vector. `alsoNaive` marks a must-still-work input. */
function checkKey(label, ep, expected, { alsoNaive = false } = {}) {
  compare(label, epKey(ep), expected);
  vectors.push({ label, kind: 'key', args: [ep], alsoNaive });
}

/** A trimForQueue vector: assert on the KEYS that survive, sorted. */
function checkTrim(label, ep, expected, { alsoNaive = false } = {}) {
  compare(label, Object.keys(trimForQueue(ep)).sort(), expected);
  vectors.push({ label, kind: 'trim', args: [ep], alsoNaive });
}

/** A queueShowFor vector: assert on the fields the container rule governs. */
function checkShow(label, args, expected, { alsoNaive = false } = {}) {
  const p = queueShowFor(...args);
  compare(label, { guid: p.podcastGuid, title: p.title, value: !!p.value }, expected);
  vectors.push({ label, kind: 'show', args, alsoNaive });
}

/** Which of the container's OWN facts survive onto the recorded show. */
const CURATOR_FACTS = ['author', 'description', 'funding', 'itunesId', 'nostrNpubs', 'podroll'];
const carriedFacts = (p) => CURATOR_FACTS.filter((k) => p[k] !== undefined);
function checkCarried(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, carriedFacts(queueShowFor(...args)), expected);
  vectors.push({ label, kind: 'carried', args, alsoNaive });
}

/** Does the RECORDED show make the item behave as a track? */
function checkPlays(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, playsAsTracks(queueShowFor(...args)), expected);
  vectors.push({ label, kind: 'plays', args, alsoNaive });
}

/** A nextPlayableIndexBy vector. */
function checkWalk(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, nextPlayableIndexBy(...args), expected);
  vectors.push({ label, kind: 'walk', args, alsoNaive });
}

/** A listenStep vector: how many seconds one store tick counts as listened. */
function checkStep(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, listenStep(...args), expected);
  vectors.push({ label, kind: 'step', args, alsoNaive });
}

/** The history as `key@at`, newest first — the order IS what the page draws. */
const historyShape = (list) => list.map((h) => `${epKey(h.episode)}@${h.at}`);
function checkHistory(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, historyShape(addToHistory(...args)), expected);
  vectors.push({ label, kind: 'history', args, alsoNaive });
}

/** A boostedOnDevice vector. */
function checkBoosted(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, boostedOnDevice(...args), expected);
  vectors.push({ label, kind: 'boosted', args, alsoNaive });
}

// ---------------------------------------------------------------------------
section('epKey: the guid when there is one, and a feed-scoped id when there is not');
// ---------------------------------------------------------------------------
checkKey('a real guid is the key', { guid: 'ep-abc', feedId: 41504, id: 9 }, 'ep-abc', { alsoNaive: true });
checkKey('no guid falls back to feed:id', { feedId: 41504, id: 9 }, '41504:9', { alsoNaive: true });
checkKey('an explicit undefined guid falls back', { guid: undefined, feedId: 7, id: 1 }, '7:1', { alsoNaive: true });

// THE ONE THIS SCRIPT EXISTS FOR. `<guid></guid>` reaches Episode as '', and
// `??` keeps it — so two different episodes of the same feed collided on ''.
checkKey('an EMPTY guid falls back rather than becoming the key', { guid: '', feedId: 41504, id: 9 }, '41504:9');
checkKey('a second empty-guid episode gets a DIFFERENT key', { guid: '', feedId: 41504, id: 10 }, '41504:10');
checkKey('an empty guid on another feed does not collide either', { guid: '', feedId: 99, id: 9 }, '99:9');

// ---------------------------------------------------------------------------
section('trimForQueue: a denylist — the two big fields go, everything else stays');
// ---------------------------------------------------------------------------
const FULL = {
  guid: 'ep-1', id: 1, feedId: 41504, title: 'A track', enclosureUrl: 'https://x/1.mp3',
  description: 'a long description', contentEncoded: '<p>even longer</p>',
  value: { model: { type: 'lightning' }, recipients: [] },
  valueTimeSplits: [{ startTime: 10, duration: 5 }],
  image: 'https://x/a.png', duration: 120, datePublished: 1,
};
checkTrim('description and contentEncoded come out; both value fields stay', FULL, [
  'datePublished', 'duration', 'enclosureUrl', 'feedId', 'guid', 'id', 'image',
  'title', 'value', 'valueTimeSplits',
]);
checkTrim('an episode with neither big field is unchanged',
  { guid: 'ep-2', id: 2, feedId: 1, title: 'B', enclosureUrl: 'https://x/2.mp3' },
  ['enclosureUrl', 'feedId', 'guid', 'id', 'title'], { alsoNaive: true });

// THE DENYLIST PROPERTY. A field nobody has written yet must survive, because
// the next one added to `Episode` is as likely to be money as prose.
checkTrim('a field this script has never heard of SURVIVES', { ...FULL, someFutureMoneyField: 1 }, [
  'datePublished', 'duration', 'enclosureUrl', 'feedId', 'guid', 'id', 'image',
  'someFutureMoneyField', 'title', 'value', 'valueTimeSplits',
]);

// ---------------------------------------------------------------------------
section('queueShowFor: the container is not always the show');
// ---------------------------------------------------------------------------
const ALBUM = { id: 100, podcastGuid: 'album-guid', title: 'The Album', value: { model: {}, recipients: [] } };
const PLAYLIST = { id: 200, podcastGuid: 'playlist-guid', title: "Curator's Playlist", value: { model: {}, recipients: [] } };

checkShow('a feed that IS the parent is kept whole',
  [{ guid: 'e1', id: 1, feedId: 100, podcastGuid: 'album-guid' }, ALBUM],
  { guid: 'album-guid', title: 'The Album', value: true }, { alsoNaive: true });
checkShow('an item with no guid of its own keeps the container',
  [{ guid: 'e2', id: 2, feedId: 100 }, ALBUM],
  { guid: 'album-guid', title: 'The Album', value: true }, { alsoNaive: true });

// The SHOW without a guid is the other half of "narrowly". `payableValue`
// refuses only when BOTH guids are present and disagree, so a feed publishing
// no `<podcast:guid>` pays its own episodes — and the queue rewrote them anyway:
// `url`, `value`, title and art cleared on the show's OWN episode, because
// `!!podcast.podcastGuid` made "is the parent" false. Written against that code
// first; both fail there.
const GUIDLESS = { id: 300, title: 'A Show With No Guid', value: { model: {}, recipients: [] } };
checkShow('a show with no guid keeps its own episode whole',
  [{ guid: 'g1', id: 31, feedId: 300 }, GUIDLESS],
  { guid: undefined, title: 'A Show With No Guid', value: true }, { alsoNaive: true });
checkShow('...even when the episode names a guid the show does not',
  [{ guid: 'g2', id: 32, feedId: 300, podcastGuid: 'episode-says-this', title: 'Ep 32' }, GUIDLESS],
  { guid: undefined, title: 'A Show With No Guid', value: true }, { alsoNaive: true });

// The refusal: both guids present and disagreeing.
checkShow('a playlist track records ITS OWN feed, not the curator\'s',
  [{ guid: 'e3', id: 3, feedId: 777, podcastGuid: 'track-album-guid', feedTitle: 'Real Album' }, PLAYLIST],
  { guid: 'track-album-guid', title: 'Real Album', value: false });
checkShow('with no feedTitle it falls back to the track title, never the playlist\'s',
  [{ guid: 'e4', id: 4, feedId: 778, podcastGuid: 'other-guid', title: 'Just The Track' }, PLAYLIST],
  { guid: 'other-guid', title: 'Just The Track', value: false });

// The rewrite must drop EVERY fact about the curator, not just the ones the
// Up Next row draws. `noteNpubs` p-tags `podcast.nostrNpubs` on the boost note
// — a permanent kind:1 naming the curator for a boost on somebody else's song —
// and `funding` put the curator's SUPPORT link under the track.
const CURATED = { ...PLAYLIST, nostrNpubs: ['npub1curator'], funding: [{ url: 'https://curator.example/support', text: 'Support' }],
  podroll: [{ feedGuid: 'x' }], author: 'The Curator', description: 'A playlist', itunesId: 99 };
checkCarried('a playlist track carries none of the curator\'s facts',
  [{ guid: 'e5', id: 5, feedId: 779, podcastGuid: 'track-album-guid', feedTitle: 'Real Album' }, CURATED], []);
checkCarried('the parent feed keeps its own',
  [{ guid: 'e6', id: 6, feedId: 200, podcastGuid: 'playlist-guid' }, CURATED],
  ['author', 'description', 'funding', 'itunesId', 'nostrNpubs', 'podroll'], { alsoNaive: true });

// A track keeps being a TRACK when its container is swapped out. Measured
// 2026-09-19 through /api/search: "Homegrown Hits Music Playlist" is feed
// 7443404, guid 8aad8bd9-…, `musicL`, and every row names another feed. With
// `medium: undefined` on the recorded show, `playsAsTracks` answered false:
// the song became RESUMABLE (#414 writes `bmb:resume` for it and brings it back
// mid-song), did not auto-advance as a track, and streamed labelled as the
// show (`streamAction` → 'stream'). A `podcastL` row must stay an episode.
const MUSIC_PLAYLIST = { id: 7443404, podcastGuid: '8aad8bd9-0eac-4bfe-b290-6c73f7148155', title: 'Homegrown Hits Music Playlist', medium: 'musicL' };
const PODCAST_PLAYLIST = { id: 201, podcastGuid: 'podcast-playlist-guid', title: 'A Podcast Playlist', medium: 'podcastL' };
const MUSIC_ALBUM = { id: 101, podcastGuid: 'album-guid', title: 'The Album', medium: 'music' };
checkPlays('a musicL track from another feed is still a track',
  [{ guid: 't1', id: 11, feedId: 555, podcastGuid: 'track-album-guid', feedTitle: 'Real Album' }, MUSIC_PLAYLIST], true);
checkPlays('an album track is a track', [{ guid: 't2', id: 12, feedId: 101, podcastGuid: 'album-guid' }, MUSIC_ALBUM], true,
  { alsoNaive: true });
checkPlays('a musicL row with no guid of its own keeps the container, and is a track',
  [{ guid: 't3', id: 13, feedId: 7443404 }, MUSIC_PLAYLIST], true, { alsoNaive: true });
// Must-still-work: a podcast playlist is a list of EPISODES (docs/feeds.md).
checkPlays('a podcastL episode from another feed stays an episode',
  [{ guid: 'p1', id: 21, feedId: 556, podcastGuid: 'some-show-guid', feedTitle: 'Some Show' }, PODCAST_PLAYLIST], false,
  { alsoNaive: true });

// ---------------------------------------------------------------------------
section('nextPlayableIndexBy: the walk that skips rows which would play silence');
// ---------------------------------------------------------------------------
const row = (x) => x;
const Q = [
  { enclosureUrl: 'https://x/0.mp3' },
  { enclosureUrl: '' },                       // an unresolved <podcast:remoteItem>
  { enclosureUrl: 'https://x/2.mp3', unresolved: true },
  { enclosureUrl: 'https://x/3.mp3' },
];
checkWalk('forward from 0 skips both dead rows', [Q, 0, 1, row], 3);
checkWalk('back from 3 skips them too', [Q, 3, -1, row], 0);
// The three boundary answers below are must-still-work: plain arithmetic
// reaches -1 there too, and it must. Over-blocking an end-of-queue step would
// be its own regression — it is what draws ⏭ disabled over a move that works.
checkWalk('no playable row ahead answers -1, never the length', [Q, 3, 1, row], -1, { alsoNaive: true });
checkWalk('no playable row behind answers -1', [Q, 0, -1, row], -1, { alsoNaive: true });
checkWalk('a clean queue steps by one', [[Q[0], Q[3]], 0, 1, row], 1, { alsoNaive: true });
checkWalk('an empty queue answers -1', [[], 0, 1, row], -1, { alsoNaive: true });
// `passOver` — the listener's ⏮/⏭ walking past a file this tab knows is dead
// (review of the merged #541/#545/#547, 2026-11-14). ⏮ from the track after a
// dead one landed on it, and the skip carried the listener forward again.
const G = [
  { enclosureUrl: 'https://x/c.mp3' },
  { enclosureUrl: 'https://x/d-gone.mp3' },
  { enclosureUrl: 'https://x/e.mp3' },
];
const gone = (e) => /gone/.test(e.enclosureUrl);
checkWalk('⏮ walks past a dead file to the track before it', [G, 2, -1, row, gone], 0);
checkWalk('⏭ walks past it too', [G, 0, 1, row, gone], 2);
checkWalk('only dead files ahead answers -1, so ⏭ draws disabled', [G.slice(0, 2), 0, 1, row, gone], -1);
// Must-still-work: with nothing to pass over it is the plain walk.
checkWalk('passOver answering false changes nothing', [G, 0, 1, row, () => false], 1, { alsoNaive: true });

// ---------------------------------------------------------------------------
section('listenStep: a minute of LISTENING, not a minute of position');
// ---------------------------------------------------------------------------
// The store ticks `positionSec` about once a second, so one tick of ordinary
// playback is ~1 s and one tick at 5× is ~5 s. Both count.
checkStep('one ordinary tick counts', [120, 121], 1, { alsoNaive: true });
checkStep('a 5× tick counts', [120, 125], 5, { alsoNaive: true });
checkStep('exactly ten seconds still counts', [120, 130], 10, { alsoNaive: true });
checkStep('a rewind counts nothing', [300, 285], 0, { alsoNaive: true });
// THE ONES THIS EXISTS FOR. +30 is the skip button and +600 is a scrub: the
// position moved, nobody listened to what it moved over.
checkStep('the +30 skip is a seek, not listening', [120, 150], 0);
checkStep('a scrub ten minutes on counts nothing', [60, 660], 0);
checkStep('a non-number position counts nothing', [NaN, 5], 0);

// ---------------------------------------------------------------------------
section('addToHistory: a LOG — newest first, a re-listen moves up, the oldest goes');
// ---------------------------------------------------------------------------
const pod = { id: 41504, title: 'A Show' };
const ep = (guid, id = 1) => ({ guid, id, feedId: 41504, title: guid, enclosureUrl: `https://x/${guid}.mp3` });
const hist = (guid, at) => ({ episode: ep(guid), podcast: pod, at });

checkHistory('the first listen is the whole history',
  [[], { episode: ep('a'), podcast: pod }, 1000], ['a@1000'], { alsoNaive: true });
checkHistory('a new listen goes on TOP',
  [[hist('a', 1000)], { episode: ep('b'), podcast: pod }, 2000], ['b@2000', 'a@1000'], { alsoNaive: true });
// The queue refuses a duplicate and keeps it where it was. A history that did
// the same would bury the episode you just listened to again under newer ones.
checkHistory('a re-listen MOVES to the top with the new time, and is not repeated',
  [[hist('c', 3000), hist('b', 2000), hist('a', 1000)], { episode: ep('a'), podcast: pod }, 4000],
  ['a@4000', 'c@3000', 'b@2000']);
// Two episodes of one feed with an EMPTY guid are two entries: `epKey` falls
// back to `feedId:id`, which is why this goes through it and not through `guid`.
checkHistory('two empty-guid episodes stay two entries',
  [[{ episode: ep('', 9), podcast: pod, at: 1000 }], { episode: ep('', 10), podcast: pod }, 2000],
  ['41504:10@2000', '41504:9@1000'], { alsoNaive: true });
{
  const full = Array.from({ length: PLAY_HISTORY_CAP }, (_, i) => hist(`old${i}`, 1000 - i));
  const shape = historyShape(full);
  // At the cap the queue REFUSES. A log must drop its oldest instead, or the
  // fifty-first episode you listen to never appears — the one you came to boost.
  checkHistory('at the cap the NEWEST goes in and the OLDEST goes out',
    [full, { episode: ep('new'), podcast: pod }, 5000],
    ['new@5000', ...shape.slice(0, PLAY_HISTORY_CAP - 1)]);
}
compare('PLAY_HISTORY_CAP is the queue\'s 50', PLAY_HISTORY_CAP, 50);

// ---------------------------------------------------------------------------
section('boostedOnDevice: the sats that SETTLED for this episode, and any unanswered leg');
// ---------------------------------------------------------------------------
// Fixtures in the shape `logStoredBoost` writes (components/boost-modal/index.tsx).
const SHOW = { id: 41504, podcastGuid: 'show-guid' };
const EP = { guid: 'ep-guid' };
const leg = (sats, ok, extra = {}) => ({ recipient: 'r@x.com', sats, ok, ...extra });
const boost = (sats, legs, over = {}) => ({
  uuid: `u${sats}`, ts: 1, podcastTitle: 'A Show', podcastId: 41504, podcastGuid: 'show-guid',
  episodeTitle: 'Ep', episodeGuid: 'ep-guid', sats, legs, ...over,
});

checkBoosted('a boost whose legs all paid counts in full',
  [[boost(100, [leg(95, true), leg(5, true)])], EP, SHOW], { sats: 100, unsure: false }, { alsoNaive: true });
checkBoosted('two boosts add up',
  [[boost(100, [leg(100, true)]), boost(50, [leg(50, true)])], EP, SHOW], { sats: 150, unsure: false },
  { alsoNaive: true });
checkBoosted('no boost for this episode is zero',
  [[boost(100, [leg(100, true)], { episodeGuid: 'another-ep' })], EP, SHOW], { sats: 0, unsure: false },
  { alsoNaive: true });
// The log keeps a boost "regardless of rail" — every leg may have failed. The
// intent total is not money sent.
checkBoosted('a failed leg is not counted',
  [[boost(100, [leg(95, true), leg(5, false)])], EP, SHOW], { sats: 95, unsure: false });
checkBoosted('a boost whose every leg failed counts nothing',
  [[boost(100, [leg(95, false), leg(5, false)])], EP, SHOW], { sats: 0, unsure: false });
// Invariant 11: a wallet that never answered may have paid. The row must say so.
checkBoosted('an unanswered leg makes the mark UNSURE',
  [[boost(100, [leg(95, false, { indeterminate: true }), leg(5, true)])], EP, SHOW], { sats: 5, unsure: true });
// Episode guids are not unique between shows ("1", "2", "ep-1"…).
checkBoosted('the same episode guid on ANOTHER show is not this episode',
  [[boost(100, [leg(100, true)], { podcastGuid: 'other-show', podcastId: 999 })], EP, SHOW],
  { sats: 0, unsure: false });
checkBoosted('a show with no guid matches on its feed id',
  [[boost(100, [leg(100, true)], { podcastGuid: undefined })], EP, { id: 41504 }], { sats: 100, unsure: false },
  { alsoNaive: true });
// A show-level boost carries no episode guid, and an EMPTY guid is no identity.
checkBoosted('an empty episode guid matches nothing',
  [[boost(100, [leg(100, true)], { episodeGuid: '' })], { guid: '' }, SHOW], { sats: 0, unsure: false });

// ---------------------------------------------------------------------------
section('The favorites shuffle: order, insertion, identity, and the track it plays');
// ---------------------------------------------------------------------------
// A recorded sequence, rebuilt on every call so the naive replay sees the same
// numbers the real call did.
const rng = (seq) => { let i = 0; return () => seq[i++ % seq.length]; };

function checkOrder(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, shuffleOrder(args[0], rng(args[1])), expected);
  vectors.push({ label, kind: 'order', args, alsoNaive });
}
/** Sorted, so it asserts "a permutation" and nothing about the order. */
function checkPermutation(label, args, { alsoNaive = false } = {}) {
  compare(label, shuffleOrder(args[0], rng(args[1])).slice().sort(), args[0].slice().sort());
  vectors.push({ label, kind: 'perm', args, alsoNaive });
}
/** The caller's array after the call — the favorites page's own rows. */
function checkUntouched(label, args, { alsoNaive = false } = {}) {
  const items = args[0].slice();
  shuffleOrder(items, rng(args[1]));
  compare(label, items, args[0]);
  vectors.push({ label, kind: 'untouched', args, alsoNaive });
}
function checkInsert(label, args, expected, { alsoNaive = false } = {}) {
  const [list, after, more, seq] = args;
  const before = list.slice();
  compare(label, insertShuffled(list, after, more, rng(seq)), expected);
  compare(`${label} (the list passed in is unchanged)`, list, before);
  vectors.push({ label, kind: 'insert', args, alsoNaive });
}
function checkShuffleIndex(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, shuffleIndexOf(...args), expected);
  vectors.push({ label, kind: 'sindex', args, alsoNaive });
}
/** The track as the player and the boost paths will see it. */
const trackShape = (t) => (t === null ? null : {
  episodeKeys: Object.keys(t.episode).sort(),
  showKeys: Object.keys(t.podcast).sort(),
  show: { id: t.podcast.id, guid: t.podcast.podcastGuid, title: t.podcast.title, image: t.podcast.image, medium: t.podcast.medium },
});
function checkTrack(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, trackShape(shuffleTrackFor(...args)), expected);
  vectors.push({ label, kind: 'track', args, alsoNaive });
}

const ABCD = ['a', 'b', 'c', 'd'];
// Fisher-Yates from the end with j = 0 every time: d<->a, c<->d, b<->c.
checkOrder('Fisher-Yates: a random source of 0 gives one exact order', [ABCD, [0]], ['b', 'c', 'd', 'a']);
checkOrder('Fisher-Yates: j = i every time swaps nothing', [ABCD, [0.999]], ABCD, { alsoNaive: true });
// Derived by hand: i=5 j=3 → a b c f e d; i=4 j=0 → e b c f a d; i=3 j=3;
// i=2 j=0 → c b e f a d; i=1 j=1.
checkOrder('Fisher-Yates: a mixed sequence', [['a', 'b', 'c', 'd', 'e', 'f'], [0.5, 0.1, 0.9, 0.3, 0.7]],
  ['c', 'b', 'e', 'f', 'a', 'd']);
checkPermutation('every row comes back exactly once', [['a', 'b', 'c', 'd', 'e', 'f', 'g'], [0.3, 0.7, 0.1]],
  { alsoNaive: true });
checkOrder('one row is that row', [['solo'], [0.5]], ['solo'], { alsoNaive: true });
checkOrder('no rows is no rows', [[], [0.5]], [], { alsoNaive: true });
checkUntouched("the caller's array is not shuffled in place", [ABCD, [0]]);

// The current track is at `after`. A late track must land strictly after it.
checkInsert('a source of 0 puts each late track right after the current one',
  [['a', 'b', 'c'], 0, ['x', 'y'], [0]], ['a', 'y', 'x', 'b', 'c']);
checkInsert('with nothing current (-1) a late track may go first',
  [['a', 'b', 'c'], -1, ['x', 'y'], [0]], ['y', 'x', 'a', 'b', 'c']);
checkInsert('on the last track, late tracks still go after it',
  [['a', 'b', 'c'], 2, ['x', 'y'], [0]], ['a', 'b', 'c', 'y', 'x']);
checkInsert('a source near 1 appends', [['a', 'b', 'c'], 0, ['x', 'y'], [0.999]], ['a', 'b', 'c', 'x', 'y'],
  { alsoNaive: true });
checkInsert('nothing late is nothing changed', [['a', 'b'], 0, [], [0]], ['a', 'b'], { alsoNaive: true });

const item = (episode) => ({ episode, podcast: { id: 1, title: 'album' } });
const S = [item({ guid: 'g1', id: 1 }), item({ guid: 'g2', id: 2 }), item({ guid: 'g3', id: 3 })];
checkShuffleIndex('no shuffle is -1', [null, { guid: 'g1', id: 1 }], -1, { alsoNaive: true });
checkShuffleIndex('an empty shuffle is -1', [[], { guid: 'g1', id: 1 }], -1, { alsoNaive: true });
checkShuffleIndex('found by guid', [S, { guid: 'g2', id: 2 }], 1, { alsoNaive: true });
checkShuffleIndex('a track not in the shuffle is -1', [S, { guid: 'other', id: 9 }], -1, { alsoNaive: true });
// `<guid></guid>`: matching on the raw guid finds the FIRST empty one.
checkShuffleIndex('an empty guid matches on feed:id, not on the empty string',
  [[item({ guid: '', feedId: 5, id: 1 }), item({ guid: '', feedId: 5, id: 2 })], { guid: '', feedId: 5, id: 2 }], 1);

const FAV = {
  itemGuid: 'item-1', feedGuid: 'feed-1', feedId: 7, title: 'Song', podcastTitle: 'Album (favorite)',
  image: 'https://x/fav.png', enclosureUrl: 'https://x/old.mp3', medium: 'music', addedAt: 1,
};
const PI_RECORD = {
  id: 11, guid: 'item-1', podcastGuid: 'feed-1', feedId: 7, feedTitle: 'Album (feed)',
  feedImage: 'https://x/feed.png', title: 'Song', enclosureUrl: 'https://x/song.mp3',
  description: 'long', contentEncoded: '<p>longer</p>',
  value: { model: { type: 'lightning' }, recipients: [{ address: 'stale', split: 100 }] },
  valueTimeSplits: [{ startTime: 0, duration: 10 }], liveValueState: 'unread',
};
// THE ONE THIS HELPER EXISTS FOR. No value block rides along — `payableValue`
// reads `episode.value` first, so a cached block would outrank the feed's own —
// and the show is the allowlist: nothing from the favorite rides onto it.
checkTrack('a cached record becomes a track with no payee and an allowlisted show', [FAV, PI_RECORD], {
  episodeKeys: ['enclosureUrl', 'feedId', 'feedImage', 'feedTitle', 'guid', 'id', 'podcastGuid', 'title'],
  showKeys: ['artwork', 'id', 'image', 'medium', 'podcastGuid', 'title'],
  show: { id: 7, guid: 'feed-1', title: 'Album (feed)', image: 'https://x/feed.png', medium: 'music' },
});
// `loadItemValue` asks the feed named by `episode.podcastGuid`, and with neither
// it nor a feed id it asks nobody: the track would play and pay no one. The
// favorite's own parent guid is the item's feed, so it fills the gap.
checkTrack('the favorite fills what the record does not say, the payee lookup included',
  [FAV, { id: 12, guid: 'item-1', title: 'Song', enclosureUrl: 'https://x/song.mp3' }], {
    episodeKeys: ['enclosureUrl', 'guid', 'id', 'podcastGuid', 'title'],
    showKeys: ['artwork', 'id', 'image', 'medium', 'podcastGuid', 'title'],
    show: { id: 7, guid: 'feed-1', title: 'Album (favorite)', image: 'https://x/fav.png', medium: 'music' },
  });
checkTrack('an empty enclosure is no track', [FAV, { ...PI_RECORD, enclosureUrl: '' }], null);
checkTrack('an unresolved record is no track', [FAV, { ...PI_RECORD, unresolved: 'not-found' }], null);

// THE REAL-DEVICE CASE (final review, 2026-11-12). `bmb:epmeta` is written only
// when something resolves an episode, the hydrator resolves a favorite only
// while `bmb:favepisodes` lacks it, and the cells expire in 7 days — so on a
// phone the cache is usually EMPTY and the first track could not start inside
// the press. The favorite stores its own `enclosureUrl`; built from that, a
// track plays with no request. Its id is synthetic and per item, because
// `<Player>`'s source effect keys on `episode.id`: one shared id would never
// reload the audio between tracks.
//
// AND IT IS THE RSS READER'S ID, `-fnvHash(itemGuid)` — a money key, not a
// render key (pre-merge review of #541, 2026-11-14). `/api/value-splits` finds
// a negative id in the feed by `-fnvHash(guid)` (`getRssItemValueTimeSplits`,
// the `episodeFromRssItem` rule). The first build hashed the PAIR
// (`feedGuid:itemGuid`, as `lib/playlist-db.ts` does for rows that carry no
// splits), which matched nothing: a shuffled track's time splits never loaded,
// so streaming inside a featured artist's window paid the main block, and a
// boost there said it could not look the track up. `itemGuid` is the key of
// the favorites map, so the id is still unique per favorite.
const fromFavShape = (e) => (e === null ? null : {
  id: e.id, guid: e.guid, podcastGuid: e.podcastGuid, feedId: e.feedId, title: e.title,
  enclosureUrl: e.enclosureUrl, value: e.value,
});
function checkFromFav(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, fromFavShape(episodeFromFavorite(...args)), expected);
  vectors.push({ label, kind: 'fromfav', args, alsoNaive });
}
checkFromFav('a favorite with an enclosure is a playable episode under a per-item id', [FAV], {
  id: -fnvHash('item-1'), guid: 'item-1', podcastGuid: 'feed-1', feedId: 7, title: 'Song',
  enclosureUrl: 'https://x/old.mp3', value: undefined,
});
checkFromFav('a second favorite gets a DIFFERENT id',
  [{ ...FAV, itemGuid: 'item-2' }], {
    id: -fnvHash('item-2'), guid: 'item-2', podcastGuid: 'feed-1', feedId: 7, title: 'Song',
    enclosureUrl: 'https://x/old.mp3', value: undefined,
  });
checkFromFav('no enclosure is no episode', [{ ...FAV, enclosureUrl: undefined }], null);
checkFromFav('the id is the RSS reader\'s for that item, whatever feed guid the favorite stores',
  [{ ...FAV, feedGuid: 'feed-9' }], {
    id: -fnvHash('item-1'), guid: 'item-1', podcastGuid: 'feed-9', feedId: 7, title: 'Song',
    enclosureUrl: 'https://x/old.mp3', value: undefined,
  });
checkFromFav('no title is still an episode, titled by nothing rather than undefined',
  [{ ...FAV, title: undefined }], {
    id: -fnvHash('item-1'), guid: 'item-1', podcastGuid: 'feed-1', feedId: 7, title: '',
    enclosureUrl: 'https://x/old.mp3', value: undefined,
  });

// The cold-load guard: did the listener pick something else while the misses
// loaded? `refreshCurrentValue`, `markCurrentValueUnread` and
// `syncCurrentValue` REPLACE `current` with no choice made, so comparing the
// object drops a shuffle the listener asked for and the press does nothing.
const EP_A = { guid: 'a', id: 1, title: 'A', enclosureUrl: 'https://x/a.mp3' };
const CUR_A = { episode: EP_A, podcast: { id: 1, title: 'show' } };
function checkSame(label, args, expected, { alsoNaive = false } = {}) {
  compare(label, sameCurrentTrack(...args), expected);
  vectors.push({ label, kind: 'same', args, alsoNaive });
}
checkSame('nothing playing, then nothing playing', [null, null], true, { alsoNaive: true });
checkSame('the same object', [CUR_A, CUR_A], true, { alsoNaive: true });
checkSame('the same track with its payee refreshed is the same track',
  [CUR_A, { ...CUR_A, episode: { ...EP_A, value: { model: {}, recipients: [] } } }], true);
checkSame('another track is another choice',
  [CUR_A, { ...CUR_A, episode: { ...EP_A, guid: 'b', id: 2 } }], false, { alsoNaive: true });
checkSame('something started where nothing played', [null, CUR_A], false, { alsoNaive: true });

// ---------------------------------------------------------------------------
section('The cap is a number this repo states, not one a caller passes');
// ---------------------------------------------------------------------------
compare('LISTEN_QUEUE_CAP is 50', LISTEN_QUEUE_CAP, 50);

// ---------------------------------------------------------------------------
section('Every vector above is replayed against the obvious wrong version');
// ---------------------------------------------------------------------------
{
  // NOT AN INVENTION: this is the operator that shipped. `??` keeps an empty
  // string, so it is right on every guid that exists and wrong on every one
  // that is present-but-empty.
  const naiveKey = (e) => e.guid ?? `${e.feedId}:${e.id}`;

  // The allowlist the denylist comment argues against: name what the queue
  // renders, ship it. Right on an episode carrying nothing else, and quietly
  // fatal the day a money field is added to `Episode`.
  const naiveTrim = (e) => {
    const keep = ['guid', 'id', 'feedId', 'title', 'enclosureUrl', 'image', 'duration', 'datePublished'];
    const out = {};
    for (const k of keep) if (e[k] !== undefined) out[k] = e[k];
    return out;
  };

  // Also not an invention: the pass-through that shipped. Right whenever the
  // container really is the parent, wrong for every playlist track.
  const naiveShow = (_episode, podcast) => podcast;
  // What shipped with the container rule: the refusal cleared `medium`, so a
  // recorded show from another feed was never a track.
  const naivePlays = (episode, podcast) => {
    const guid = episode.podcastGuid || podcast.podcastGuid;
    return !!podcast.podcastGuid && podcast.podcastGuid === guid ? playsAsTracks(podcast) : false;
  };

  // What someone writes when the step looks like arithmetic. It hands back a
  // dead row, which reports as playing and is silent.
  const naiveWalk = (queue, from, step) => {
    const to = from + step;
    return to >= 0 && to < queue.length ? to : -1;
  };

  // What anybody writes first: forward movement is listening.
  const naiveStep = (prev, next) => Math.max(0, next - prev);

  // The queue's own rule copied across — refuse a duplicate where it stands,
  // refuse at the cap. Right for a decision, wrong for a log.
  const naiveHistory = (list, item, now) => {
    if (list.length >= PLAY_HISTORY_CAP) return list;
    if (list.some((h) => epKey(h.episode) === epKey(item.episode))) return list;
    return [{ ...item, at: now }, ...list];
  };

  // The log's intent total, matched on the episode guid alone.
  const naiveBoosted = (boosts, episode) => ({
    sats: boosts.filter((b) => b.episodeGuid === episode.guid).reduce((s, b) => s + b.sats, 0),
    unsure: false,
  });

  // The shuffle everyone writes first: biased, and it sorts the CALLER's array.
  const naiveOrder = (items, random) => items.sort(() => random() - 0.5);
  // Late tracks at the end, which is right only by luck.
  const naiveInsert = (list, _after, more) => [...list, ...more];
  // Matched on the raw guid, which `<guid></guid>` makes ''.
  const naiveShuffleIndex = (shuffle, ep) =>
    shuffle && shuffle.length ? shuffle.findIndex((i) => i.episode.guid === ep.guid) : -1;
  // The record as it came, and the favorite as the show.
  const naiveTrack = (fav, episode) => ({ episode, podcast: { ...fav, medium: 'music' } });
  // The favorite as it stands, with the id every such row would share.
  const naiveFromFav = (fav) => ({ ...fav, id: 0, guid: fav.itemGuid, podcastGuid: fav.feedGuid });
  // Identity, which a payee refresh breaks.
  const naiveSame = (a, b) => a === b;

  const call = (impl, v) => {
    try {
      const real = impl === 'real';
      switch (v.kind) {
        case 'key':
          return JSON.stringify(real ? epKey(...v.args) : naiveKey(...v.args));
        case 'trim':
          return JSON.stringify(Object.keys(real ? trimForQueue(...v.args) : naiveTrim(...v.args)).sort());
        case 'show': {
          const p = real ? queueShowFor(...v.args) : naiveShow(...v.args);
          return JSON.stringify({ guid: p.podcastGuid, title: p.title, value: !!p.value });
        }
        case 'carried':
          return JSON.stringify(carriedFacts(real ? queueShowFor(...v.args) : naiveShow(...v.args)));
        case 'plays':
          return JSON.stringify(real ? playsAsTracks(queueShowFor(...v.args)) : naivePlays(...v.args));
        case 'walk':
          return JSON.stringify(real ? nextPlayableIndexBy(...v.args) : naiveWalk(...v.args));
        case 'step':
          return JSON.stringify(real ? listenStep(...v.args) : naiveStep(...v.args));
        case 'history':
          return JSON.stringify(historyShape(real ? addToHistory(...v.args) : naiveHistory(...v.args)));
        case 'boosted':
          return JSON.stringify(real ? boostedOnDevice(...v.args) : naiveBoosted(...v.args));
        case 'order':
          return JSON.stringify((real ? shuffleOrder : naiveOrder)(v.args[0].slice(), rng(v.args[1])));
        case 'perm':
          return JSON.stringify((real ? shuffleOrder : naiveOrder)(v.args[0].slice(), rng(v.args[1])).slice().sort());
        case 'untouched': {
          const items = v.args[0].slice();
          (real ? shuffleOrder : naiveOrder)(items, rng(v.args[1]));
          return JSON.stringify(items);
        }
        case 'insert': {
          const [list, after, more, seq] = v.args;
          return JSON.stringify((real ? insertShuffled : naiveInsert)(list.slice(), after, more, rng(seq)));
        }
        case 'sindex':
          return JSON.stringify((real ? shuffleIndexOf : naiveShuffleIndex)(...v.args));
        case 'track':
          return JSON.stringify(trackShape((real ? shuffleTrackFor : naiveTrack)(...v.args)));
        case 'fromfav':
          return JSON.stringify(fromFavShape((real ? episodeFromFavorite : naiveFromFav)(...v.args)));
        case 'same':
          return JSON.stringify((real ? sameCurrentTrack : naiveSame)(...v.args));
        default: throw new Error(`unknown vector kind ${v.kind}`);
      }
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
    } catch (e) {
      return `threw ${(e && e.message) || e}`;
    }
  };

  // THE SHARED REPLAY. See `scripts/replay-vectors.mjs` — an
  // `{ alsoNaive: true }` vector used to have its `differs` result discarded, so
  // the exemption hid exactly what it was granted to protect.
  replayVectors({ vectors, invoke: call, fail: (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); } });
}

if (failures) {
  console.error(`\n${failures} queue check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll queue checks passed.');
