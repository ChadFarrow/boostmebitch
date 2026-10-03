// Pins `lib/nostr/like-tally.ts` — the episode LIKE: the kind:17 this app
// publishes, the kind:5 that takes it back, and how a read of both becomes the
// number on the 👍 tile.
//
// WHAT A LIKE IS ON THE WIRE. NIP-25 says a reaction to something that is not a
// Nostr event MUST be kind:17 and MUST carry NIP-73 `k` + `i` tags. Fountain
// shipped exactly that for podcast episodes; every one of the 508 podcast
// kind:17s on this app's four default relays on 2026-10-02 had content `+` and
// the same four tags — item `k`/`i`, then show `k`/`i`, each `i` with a
// fountain.fm hint. Nobody else writes them yet, so Fountain's shape IS the
// format: a like this app publishes in any other shape is one Fountain does not
// count.
//
// FOUR WAYS TO GET THE NUMBER WRONG, each measured or each the obvious version:
//
//   1. COUNTING EVENTS, NOT PEOPLE. Fountain publishes a like TWICE, about two
//      seconds apart — 81 author+episode pairs of 500 events had a duplicate.
//      One episode held 62 kind:17s from 49 people. `naive()` counts events.
//   2. COUNTING A DELETION FROM SOMEBODY ELSE. NIP-09 lets an author delete
//      only their OWN events; a relay that honors it checks the pubkey, but a
//      relay that ignores NIP-09 hands the kind:5 to every reader, and a reader
//      that honors it blindly lets anyone un-like anyone. `anyDeleter()` is that
//      version: right about everything else.
//   3. TRUSTING THE FILTER. `#i` is a REQUEST; a relay may send anything, so an
//      event for another episode, or a kind:7, must not count.
//   4. DROPPING `''`. NIP-25: "`+` or an empty string" is a like. `-` is a
//      dislike and an emoji is a reaction, and neither is a like.
//
// AND ONE WAY TO MAKE UNLIKE NOT WORK. A bare NIP-09 deletion carries only `e`
// and `k` tags, so the `#i` read that finds the like never finds the deletion —
// on any relay that does not honor NIP-09, the like reads back on the next
// load and the tile turns itself back on. `unlikeTags` adds the item's `i` tag.
// The one real kind:17 deletion on the default relays already carries `e`,
// `k:17` and `i` ("vote retracted", fixture DEL_WEB below), so this is a
// convention in use, not one invented here.
//
// FIXTURE PROVENANCE. FOUNTAIN_LIKE is the event Chad pasted on 2026-10-02 and
// it is still on the relays. PAIR_A / PAIR_B are the two real events one author
// published for one episode on 2026-09-30, fetched from relay.fountain.fm.
// DEL_WEB is the real deletion above. Signatures are dropped, because nothing
// here verifies them — the relay pool does that before an event reaches the
// tally: `newPool()` (`lib/nostr/pool.ts`) builds nostr-tools' `SimplePool`
// with its default `verifyEvent`, and each relay checks it on every event
// before a subscription sees it (`abstract-relay.js` in the pinned 2.19.4). The
// deletions OF these likes are synthetic, built in DEL_WEB's real shape.
//
// AND ONE WAY TO TAKE BACK THE WRONG LIKE. The read is filed under the ITEM
// guid alone, and item guids are not unique across feeds — `1` and `ep-1` are
// common — so a viewer's like of guid `1` on show B arrives in show A's read.
// Offering it as the viewer's like on A makes the tile read liked on a show
// they never liked, and an unlike there deletes their like of B. So a like
// whose show `i` tag names ANOTHER feed is not the viewer's to take back here;
// the COUNT is left alone, filed the way Fountain files it.
//
// AND ONE WAY TO NOT SEE YOUR OWN UNLIKE. The count reads the four default
// relays; the viewer's like and unlike go to their PUBLISH set. That set
// normally contains every default, but a `bmb:relays` override or the 20-relay
// cap can leave one out, and then the unlike sits where the count never looks
// and the like turns itself back on. `viewerLikeRelays` adds the publish relays
// to the viewer's own read in exactly that case — and only then, since every
// relay a read asks is one it waits for. `naive()` is the read before the fix:
// the defaults, always.
import {
  EXTERNAL_REACTION_KIND,
  DELETION_KIND,
  LIKE_READ_LIMIT,
  itemLikeTarget,
  likeTags,
  unlikeTags,
  tallyLikes,
  isLikeContent,
  viewerLikeRelays,
} from '../lib/nostr/like-tally.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const fail = (m) => { failures += 1; console.error(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

// ── Wire fixtures ────────────────────────────────────────────────────────────
const FOUNTAIN_LIKE = {
  id: 'd21edc54cead4a047d13033257d9c3cff73ae56ce4d0be7420416eac39e6ab69',
  pubkey: 'e4f695f05bb05b231255ccce3d471b8d79c64a65bccc014662d27f0f7e921092',
  created_at: 1788625122,
  kind: 17,
  content: '+',
  tags: [
    ['k', 'podcast:item:guid'],
    ['i', 'podcast:item:guid:substack:post:213682035', 'https://fountain.fm/episode/H2steHf3HoLHdy3fRfkY'],
    ['k', 'podcast:guid'],
    ['i', 'podcast:guid:b38a3a5c-2463-5f34-a767-8d31e0fd8f18', 'https://fountain.fm/show/MfX0vbBr12GAs1MHLqfR'],
  ],
};
const FOUNTAIN_ITEM = 'substack:post:213682035';

const PAIR_AUTHOR = '9c6942a87a00d1db6e01c861f0365de14abc2c3855c1d65ebf26459527a632e0';
const PAIR_ITEM = 'e5ec83cb-08c2-4f58-b000-fd4f686b84de';
const pairTags = [
  ['k', 'podcast:item:guid'],
  ['i', 'podcast:item:guid:e5ec83cb-08c2-4f58-b000-fd4f686b84de', 'https://fountain.fm/episode/05E8TAGo3w6xVSxPeEbS'],
  ['k', 'podcast:guid'],
  ['i', 'podcast:guid:d5e73072-64a2-56a3-9dcd-4a00bfe561d5', 'https://fountain.fm/show/yqjEjw3AmDwhgc7dBsjX'],
];
const PAIR_FEED = 'd5e73072-64a2-56a3-9dcd-4a00bfe561d5';
const PAIR_A = {
  id: '701251a30394653b8917a13577a3675c58cb2219004e1c4337fc805af5396539',
  pubkey: PAIR_AUTHOR, created_at: 1790736186, kind: 17, content: '+', tags: pairTags,
};
const PAIR_B = {
  id: 'd106c8265afabd94248dab9e1f9291505042ad1fb80e706e28b982e2380cd34d',
  pubkey: PAIR_AUTHOR, created_at: 1790736184, kind: 17, content: '+', tags: pairTags,
};
const DEL_WEB = {
  id: '985809f040a1cdfe88b80f91c02f02c0a02c56499870ef19a55549ca534e7403',
  pubkey: '22f8fa6add52641356b4734debeb357d661928324e49655fb0f2d4bc133348fa',
  created_at: 1790726750,
  kind: 5,
  content: 'vote retracted',
  tags: [
    ['e', '37dc38f8dcda69c56729eddfbc5d556336f3eb3359dc13887a09cae39fad888a'],
    ['k', '17'],
    ['i', 'https://www.familyhandyman.com/project/diy-arcade-cabinet/'],
  ],
};

// ── Synthetic events, in the wire shapes above ───────────────────────────────
const hex = (c) => c.repeat(64);
const OTHER = hex('b');
const VIEWER = hex('c');
const like = (id, pubkey, content = '+', tags = pairTags, kind = EXTERNAL_REACTION_KIND) =>
  ({ id, pubkey, created_at: 1790736200, kind, content, tags });
const deletion = (id, pubkey, targets, item = PAIR_ITEM) =>
  ({ id, pubkey, created_at: 1790736300, kind: DELETION_KIND, content: '', tags: unlikeTags(targets, item) });
// The SAME item guid, filed under a different show — a collision, not a playlist.
const otherShowTags = [
  pairTags[0],
  pairTags[1],
  ['k', 'podcast:guid'],
  ['i', 'podcast:guid:0f0f0f0f-0000-5000-8000-000000000000', 'https://fountain.fm/show/other'],
];

// ── Wrong version 1: count every `+` event ───────────────────────────────────
function naiveTally(events, _item, viewer) {
  const pluses = events.filter((e) => e.content === '+');
  return {
    count: pluses.length,
    viewerLikeIds: pluses.filter((e) => e.pubkey === viewer).map((e) => e.id),
    capped: false,
  };
}
// The obvious tag list: an `i` per identifier, hint or not, and no `k` at all.
function naiveLikeTags(t) {
  return [
    ['i', `podcast:item:guid:${t.itemGuid}`, t.itemHint ?? ''],
    ['i', `podcast:guid:${t.feedGuid}`, t.showHint ?? ''],
  ];
}
// The bare NIP-09 deletion.
function naiveUnlikeTags(ids) {
  return [...ids.map((id) => ['e', id]), ['k', '17']];
}
// The viewer's own read on the count's relays, whatever the publish set is.
function naiveViewerLikeRelays(countRelays) {
  return [...countRelays];
}

// ── Wrong version 2: right about everything but WHO may delete ───────────────
function anyDeleterTally(events, itemGuid, viewer, feedGuid = null, limit = LIKE_READ_LIMIT) {
  const target = `podcast:item:guid:${itemGuid}`;
  const deleted = new Set();
  for (const e of events) {
    if (e.kind !== DELETION_KIND) continue;
    for (const t of e.tags) if (t[0] === 'e' && typeof t[1] === 'string') deleted.add(t[1]);
  }
  const shows = (e) => e.tags.filter((t) => t[0] === 'i' && t[1]?.startsWith('podcast:guid:')).map((t) => t[1]);
  const authors = new Set();
  const viewerLikeIds = [];
  for (const e of events) {
    if (e.kind !== EXTERNAL_REACTION_KIND) continue;
    if (!(e.content === '+' || e.content === '')) continue;
    if (!e.tags.some((t) => t[0] === 'i' && t[1] === target)) continue;
    if (deleted.has(e.id)) continue;
    authors.add(e.pubkey);
    const s = shows(e);
    const otherShow = !!feedGuid && s.length > 0 && !s.includes(`podcast:guid:${feedGuid}`);
    if (e.pubkey === viewer && !otherShow) viewerLikeIds.push(e.id);
  }
  return { count: authors.size, viewerLikeIds, capped: events.length >= limit };
}

const REAL = { tally: tallyLikes, likeTags, unlikeTags, viewerLikeRelays };
const NAIVE = { tally: naiveTally, likeTags: naiveLikeTags, unlikeTags: naiveUnlikeTags, viewerLikeRelays: naiveViewerLikeRelays };
const ANY_DELETER = { ...REAL, tally: anyDeleterTally };

function run(impl, v) {
  try {
    return JSON.stringify(impl[v.kind](...v.args));
  } catch (e) {
    return `THROW: ${e && e.message}`;
  }
}

// ── Vectors ──────────────────────────────────────────────────────────────────
// `expect` is asserted against the real module; every vector is then replayed
// against `naive()` and the tally vectors against `anyDeleter()` too, and a
// vector a wrong version also gets right is exempted one at a time.
const tally = (count, viewerLikeIds = [], capped = false) => ({ count, viewerLikeIds, capped });
// A distinct id and a distinct author per event. Pad with a fixed digit AFTER a
// prefix, never with a hex digit alone: `'f'.padStart(64, 'f')` and
// `'ff'.padStart(64, 'f')` are the same key, which undercounts by sixteen.
// The four defaults as `lib/nostr/relays.ts` writes them, and a write set.
const DEFAULTS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.fountain.fm'];
const WRITE = Array.from({ length: 19 }, (_, i) => `wss://write${i}.example`);
const many = (n) => Array.from({ length: n }, (_, i) =>
  like(`a${i.toString(16).padStart(63, '0')}`, `b${i.toString(16).padStart(63, '0')}`));

const VECTORS = [
  // tally — the wire
  {
    label: "Chad's pasted Fountain like counts once",
    kind: 'tally', args: [[FOUNTAIN_LIKE], FOUNTAIN_ITEM, null],
    expect: tally(1), alsoNaive: true, alsoAnyDeleter: true,
  },
  {
    label: "Fountain's real double publish is ONE person",
    kind: 'tally', args: [[PAIR_A, PAIR_B], PAIR_ITEM, null],
    expect: tally(1), alsoAnyDeleter: true,
  },
  {
    label: 'two people are two likes',
    kind: 'tally', args: [[PAIR_A, like(hex('1'), OTHER)], PAIR_ITEM, null],
    expect: tally(2), alsoNaive: true, alsoAnyDeleter: true,
  },
  {
    label: 'an empty content is a like (NIP-25)',
    kind: 'tally', args: [[like(hex('1'), OTHER, '')], PAIR_ITEM, null],
    expect: tally(1), alsoAnyDeleter: true,
  },
  {
    label: 'a `-` is a dislike, not a like',
    kind: 'tally', args: [[like(hex('1'), OTHER, '-')], PAIR_ITEM, null],
    expect: tally(0), alsoNaive: true, alsoAnyDeleter: true,
  },
  {
    label: 'an emoji is a reaction, not a like',
    kind: 'tally', args: [[like(hex('1'), OTHER, '🔥')], PAIR_ITEM, null],
    expect: tally(0), alsoNaive: true, alsoAnyDeleter: true,
  },
  {
    label: 'a like for ANOTHER episode that a relay sent anyway does not count',
    kind: 'tally', args: [[FOUNTAIN_LIKE], PAIR_ITEM, null],
    expect: tally(0), alsoAnyDeleter: true,
  },
  {
    label: 'a kind:7 carrying the episode tag does not count',
    kind: 'tally', args: [[like(hex('1'), OTHER, '+', pairTags, 7)], PAIR_ITEM, null],
    expect: tally(0), alsoAnyDeleter: true,
  },
  {
    label: 'a show-only tag is not a like of this episode',
    kind: 'tally', args: [[like(hex('1'), OTHER, '+', [pairTags[2], pairTags[3]])], PAIR_ITEM, null],
    expect: tally(0), alsoAnyDeleter: true,
  },
  // tally — deletions
  {
    label: "the author's own deletion takes the like back",
    kind: 'tally', args: [[PAIR_A, deletion(hex('d'), PAIR_AUTHOR, [PAIR_A.id])], PAIR_ITEM, null],
    expect: tally(0), alsoAnyDeleter: true,
  },
  {
    label: 'deleting ONE of a double publish leaves the other standing',
    kind: 'tally', args: [[PAIR_A, PAIR_B, deletion(hex('d'), PAIR_AUTHOR, [PAIR_A.id])], PAIR_ITEM, null],
    expect: tally(1), alsoAnyDeleter: true,
  },
  {
    label: "a deletion signed by SOMEBODY ELSE deletes nothing",
    kind: 'tally', args: [[PAIR_A, deletion(hex('d'), OTHER, [PAIR_A.id])], PAIR_ITEM, null],
    expect: tally(1), alsoNaive: true,
  },
  {
    label: 'like, unlike, like again: the new like stands',
    kind: 'tally',
    args: [[like(hex('1'), OTHER), deletion(hex('d'), OTHER, [hex('1')]), like(hex('2'), OTHER)], PAIR_ITEM, null],
    expect: tally(1), alsoAnyDeleter: true,
  },
  {
    label: "a real web-vote deletion leaves an unrelated episode's like alone",
    kind: 'tally', args: [[PAIR_A, DEL_WEB], PAIR_ITEM, null],
    expect: tally(1), alsoNaive: true, alsoAnyDeleter: true,
  },
  // tally — the viewer
  {
    label: "the viewer's double publish yields BOTH ids, so unlike deletes both",
    kind: 'tally', args: [[PAIR_A, PAIR_B], PAIR_ITEM, PAIR_AUTHOR],
    expect: tally(1, [PAIR_A.id, PAIR_B.id]), alsoAnyDeleter: true,
  },
  {
    label: 'a viewer who un-liked holds no like ids',
    kind: 'tally', args: [[like(hex('1'), VIEWER), deletion(hex('d'), VIEWER, [hex('1')])], PAIR_ITEM, VIEWER],
    expect: tally(0), alsoAnyDeleter: true,
  },
  {
    label: "a viewer's `-` is not a like to take back",
    kind: 'tally', args: [[like(hex('1'), VIEWER, '-')], PAIR_ITEM, VIEWER],
    expect: tally(0), alsoNaive: true, alsoAnyDeleter: true,
  },
  // tally — the show the like is filed under
  {
    label: "the viewer's like of the same item guid on ANOTHER show is counted, but not theirs to take back here",
    kind: 'tally', args: [[like(hex('1'), VIEWER, '+', otherShowTags)], PAIR_ITEM, VIEWER, PAIR_FEED],
    expect: tally(1), alsoAnyDeleter: true,
  },
  {
    label: 'a viewer with a like on THIS show and on another deletes only this show\'s',
    kind: 'tally',
    args: [[like(hex('1'), VIEWER), like(hex('2'), VIEWER, '+', otherShowTags)], PAIR_ITEM, VIEWER, PAIR_FEED],
    expect: tally(1, [hex('1')]), alsoAnyDeleter: true,
  },
  {
    label: "the viewer's like on THIS show is still theirs",
    kind: 'tally', args: [[like(hex('1'), VIEWER)], PAIR_ITEM, VIEWER, PAIR_FEED],
    expect: tally(1, [hex('1')]), alsoNaive: true, alsoAnyDeleter: true,
  },
  {
    label: 'a like naming no show at all is still the viewer\'s — nothing says it is another show\'s',
    kind: 'tally', args: [[like(hex('1'), VIEWER, '+', [pairTags[0], pairTags[1]])], PAIR_ITEM, VIEWER, PAIR_FEED],
    expect: tally(1, [hex('1')]), alsoNaive: true, alsoAnyDeleter: true,
  },
  // tally — the cap
  {
    label: 'a read that filled the relay cap is a LOWER bound',
    kind: 'tally', args: [many(LIKE_READ_LIMIT), PAIR_ITEM, null],
    expect: tally(LIKE_READ_LIMIT, [], true), alsoAnyDeleter: true,
  },
  {
    label: 'one short of the cap is a whole answer',
    kind: 'tally', args: [many(LIKE_READ_LIMIT - 1), PAIR_ITEM, null],
    expect: tally(LIKE_READ_LIMIT - 1), alsoNaive: true, alsoAnyDeleter: true,
  },
  // likeTags — what Fountain counts
  {
    label: "given Fountain's hints, a like's tags are byte-identical to Fountain's own",
    kind: 'likeTags',
    args: [{
      itemGuid: FOUNTAIN_ITEM,
      feedGuid: 'b38a3a5c-2463-5f34-a767-8d31e0fd8f18',
      itemHint: 'https://fountain.fm/episode/H2steHf3HoLHdy3fRfkY',
      showHint: 'https://fountain.fm/show/MfX0vbBr12GAs1MHLqfR',
    }],
    expect: FOUNTAIN_LIKE.tags,
  },
  {
    label: 'with no hint an `i` tag has two elements, never an empty third',
    kind: 'likeTags',
    args: [{ itemGuid: PAIR_ITEM, feedGuid: 'd5e73072-64a2-56a3-9dcd-4a00bfe561d5', itemHint: null, showHint: null }],
    expect: [
      ['k', 'podcast:item:guid'],
      ['i', 'podcast:item:guid:e5ec83cb-08c2-4f58-b000-fd4f686b84de'],
      ['k', 'podcast:guid'],
      ['i', 'podcast:guid:d5e73072-64a2-56a3-9dcd-4a00bfe561d5'],
    ],
  },
  {
    label: 'a like with no item guid is refused, never published untargeted',
    kind: 'likeTags', args: [{ itemGuid: '', feedGuid: 'd5e73072-64a2-56a3-9dcd-4a00bfe561d5' }],
    expect: 'THROW',
  },
  {
    label: 'a like with no feed guid is refused',
    kind: 'likeTags', args: [{ itemGuid: PAIR_ITEM, feedGuid: '' }],
    expect: 'THROW',
  },
  // unlikeTags — what the `#i` read can find
  {
    label: 'an unlike carries the episode `i` tag, so the `#i` read finds it',
    kind: 'unlikeTags', args: [[PAIR_A.id, PAIR_B.id], PAIR_ITEM],
    expect: [
      ['e', PAIR_A.id],
      ['e', PAIR_B.id],
      ['k', '17'],
      ['i', 'podcast:item:guid:e5ec83cb-08c2-4f58-b000-fd4f686b84de'],
    ],
  },
  {
    label: 'an unlike naming nothing is refused — it would be a kind:5 deleting nothing',
    kind: 'unlikeTags', args: [[], PAIR_ITEM],
    expect: 'THROW',
  },
  // viewerLikeRelays — where the viewer's own like and unlike can be read
  {
    label: 'a publish set holding every default adds nothing — the count already reads them',
    kind: 'viewerLikeRelays', args: [DEFAULTS, [...WRITE.slice(0, 3), ...DEFAULTS]],
    expect: DEFAULTS, alsoNaive: true,
  },
  {
    label: 'an override naming every default and more still adds nothing',
    kind: 'viewerLikeRelays', args: [DEFAULTS, [...DEFAULTS, 'wss://mine.example']],
    expect: DEFAULTS, alsoNaive: true,
  },
  {
    label: 'an override with NO default: its relays are read too, or an unlike there is never seen',
    kind: 'viewerLikeRelays', args: [DEFAULTS, ['ws://127.0.0.1:7447']],
    expect: [...DEFAULTS, 'ws://127.0.0.1:7447'],
  },
  {
    label: 'an override keeping one default: only its other relays are added',
    kind: 'viewerLikeRelays', args: [DEFAULTS, ['wss://relay.damus.io', 'wss://mine.example']],
    expect: [...DEFAULTS, 'wss://mine.example'],
  },
  {
    label: 'the 20 cap cut a default: the write relays are read too',
    kind: 'viewerLikeRelays', args: [DEFAULTS, [...WRITE, DEFAULTS[0]]],
    expect: [...DEFAULTS, ...WRITE],
  },
];

// ---------------------------------------------------------------------------
console.log('like-tally: the real module against the expected values');
// ---------------------------------------------------------------------------
for (const v of VECTORS) {
  const got = run(REAL, v);
  const want = v.expect === 'THROW' ? 'THROW' : JSON.stringify(v.expect);
  const have = want === 'THROW' && got.startsWith('THROW:') ? 'THROW' : got;
  if (have === want) ok(v.label);
  else fail(`${v.label}\n          want ${want.slice(0, 300)}\n          got  ${have.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
console.log('\nlike-tally: every vector replayed against naive()');
// ---------------------------------------------------------------------------
replayVectors({
  vectors: VECTORS,
  invoke: (which, v) => run(which === 'real' ? REAL : NAIVE, v),
  fail,
});

// ---------------------------------------------------------------------------
console.log('\nlike-tally: the tally vectors replayed against anyDeleter()');
// ---------------------------------------------------------------------------
replayVectors({
  vectors: VECTORS.filter((v) => v.kind === 'tally').map((v) => ({ ...v, alsoNaive: !!v.alsoAnyDeleter })),
  invoke: (which, v) => run(which === 'real' ? REAL : ANY_DELETER, v),
  fail,
});

// ---------------------------------------------------------------------------
console.log('\nlike-tally: a published like and its unlike, round trip');
// ---------------------------------------------------------------------------
{
  // The pair the app actually writes, read back through the tally — the
  // composition no single vector above covers.
  const target = { itemGuid: PAIR_ITEM, feedGuid: 'd5e73072-64a2-56a3-9dcd-4a00bfe561d5' };
  const mine = { id: hex('a'), pubkey: VIEWER, created_at: 1, kind: EXTERNAL_REACTION_KIND, content: '+', tags: likeTags(target) };
  const before = tallyLikes([PAIR_A, mine], PAIR_ITEM, VIEWER);
  if (before.count === 2 && before.viewerLikeIds.join() === mine.id) ok('a published like counts, and is the viewer\'s');
  else fail(`a published like: ${JSON.stringify(before)}`);
  const undo = { id: hex('e'), pubkey: VIEWER, created_at: 2, kind: DELETION_KIND, content: '', tags: unlikeTags(before.viewerLikeIds, PAIR_ITEM) };
  // The read is `#i`, so the deletion is only ever seen if it carries the tag.
  if (undo.tags.some((t) => t[0] === 'i' && t[1] === itemLikeTarget(PAIR_ITEM))) ok('the unlike matches the same `#i` filter');
  else fail('the unlike does not match the `#i` filter the read uses');
  const after = tallyLikes([PAIR_A, mine, undo], PAIR_ITEM, VIEWER);
  if (after.count === 1 && after.viewerLikeIds.length === 0) ok('after the unlike the viewer holds nothing and the count drops');
  else fail(`after the unlike: ${JSON.stringify(after)}`);
}

// ---------------------------------------------------------------------------
console.log('\nisLikeContent');
// ---------------------------------------------------------------------------
for (const [content, want] of [['+', true], ['', true], ['-', false], ['👍', false], [' +', false]]) {
  if (isLikeContent(content) === want) ok(`${JSON.stringify(content)} → ${want}`);
  else fail(`isLikeContent(${JSON.stringify(content)}) should be ${want}`);
}

// ---------------------------------------------------------------------------
console.log('\nimport-free');
// ---------------------------------------------------------------------------
{
  const problems = importFreeProblems('lib/nostr/like-tally.ts');
  if (problems.length) { explainImportFree('lib/nostr/like-tally.ts', problems); failures += problems.length; }
  else ok('lib/nostr/like-tally.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} like check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll like checks passed.');
