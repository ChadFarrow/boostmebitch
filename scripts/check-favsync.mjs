// Pins the cross-app favorites wire format and merge — kind 10333.
//
// Usage:
//   npm run check:favsync
//
// Run it after ANY edit to lib/nostr/favorites-list.ts.
//
// Why this earns a check script: the event is SHARED with other podcast apps
// and is REPLACEABLE, so every writer can destroy every other writer's data
// with one publish. There is no partial update and no undo. A bug here doesn't
// degrade the feature — it deletes favorites the user made in another app, on
// another device, silently, and the device that caused it shows nothing wrong.
//
// The format's whole difficulty is in one sentence: TAG ORDER IS THE DATA. An
// `i` tag is bare, so an item's parent feed is "the most recently opened feed
// group" and its medium is "the last ['medium', …] tag above it". Both are
// carried by position and by nothing on the entry. So the obvious
// implementation — parse into structs, merge the structs, rebuild the array —
// silently reattaches every item to the wrong feed and re-labels everything
// after a medium boundary. Nothing else in the format recovers the association,
// and nothing about it looks wrong on screen.
//
// FIXTURES ARE BUILT FROM LITERAL WIRE TAG ARRAYS, never from the struct they
// parse into. This is not style. The predecessor of this script shipped a
// vector literally named "lossless" that was green for the entire life of the
// feature while every publish truncated the tag it was meant to protect —
// because its input was constructed from the same fields it asserted on, so the
// comparison was vacuously true. A round trip whose input you built out of your
// own struct cannot fail. Every `parse(...)` below takes tags a relay could
// actually have sent.
//
// Several fixtures below are REAL, lifted verbatim from the live kind:10333
// event on relays (`npm run probe:favorites -- <npub> --dump f.json`). Real wire
// data is worth more than invented data precisely because it contains the
// shapes nobody thinks to invent — the non-UUID item guid
// `thenogs-donkey-01-porky-piggin-it` below is one, and a UUID-gated item parser
// would have looked correct forever without it.
//
// ON "A NEW VECTOR MUST BE SEEN TO FAIL FIRST": this replaced a different wire
// format outright, so running these against the predecessor proves nothing —
// the exports don't exist. The meaningful control is the OBVIOUS WRONG
// implementation, so `naive()` at the bottom is exactly that: parse to structs,
// merge by map, rebuild the array. The vectors marked (naive) are asserted to
// FAIL against it, which is what stops this file from being a set of assertions
// that were true the moment they were written.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy stays green while the shipping format
// drifts. favorites-list.ts is importable by plain Node because it has NO
// imports at all — keep it that way.

import {
  EMPTY_BASELINE,
  LIST_ALT,
  baselineFrom,
  entriesFromList,
  groupLocalFavorites,
  identifierKind,
  itemId,
  mergeFavoritesList,
  parseFavoritesList,
  parseItemGuid,
  parseShowGuid,
  partitionList,
  planFavoritesPublish,
  showId,
  tagsFromList,
} from '../lib/nostr/favorites-list.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
  return false;
}

function section(name) {
  console.log(`\n${name}`);
}

// Real guids from the live event, so the fixtures carry real shapes.
const F_MUSIC = 'fce40d63-ef30-5c85-af07-d99b3c759807';
const F_MUSIC2 = '5d5be024-321d-5342-838e-988d1653296b';
const F_UNKNOWN = '791338e2-77bc-579e-8c7c-4c996cf73305';
const F_POD = 'fafd2bfc-98ac-5010-9fcb-7403abfd420a';
const I_A = 'fb279ed1-10ec-4060-967d-9af45c19505f';
const I_B = 'f4cc32b4-0e1e-45a1-a6fb-64e7f8d0e0a2';
const I_C = '19670162-a9cd-43f2-bc95-6354f218852a';
const I_ODD = 'thenogs-donkey-01-porky-piggin-it'; // real, and not a UUID
const I_URL = 'https://example.com/ep/42';

const NO_LOCAL = { groups: [], loose: [] };
const emit = (read, local = NO_LOCAL, baseline = EMPTY_BASELINE) =>
  tagsFromList(mergeFavoritesList({ read, local, baseline }));

// ---------------------------------------------------------------------------
section('Spec vector 1 — a foreign entry survives your republish');
// ---------------------------------------------------------------------------
{
  // Verbatim from the live event: the unknown-medium head group, then the music
  // block. Nothing local at all, so everything here is "foreign".
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['i', `podcast:item:guid:${I_B}`],
    ['i', `podcast:item:guid:${I_C}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['k', 'podcast:guid'],
    ['k', 'podcast:item:guid'],
  ];
  check('a list we contribute nothing to is republished byte-identically',
    emit(parseFavoritesList(wire)), wire);

  // The hard half, and the one that costs another app's data if you get it
  // wrong: the feed IS in our baseline (we opened the group) and we no longer
  // hold it, but a foreign item still sits under it. Dropping the group here
  // deletes the only thing naming that item's parent.
  const baseline = { feeds: [showId(F_MUSIC2)], items: [] };
  const kept = emit(parseFavoritesList(wire), NO_LOCAL, baseline);
  check('a group we published survives while a foreign item remains under it',
    kept.some((t) => t[1] === `podcast:guid:${F_MUSIC2}`), true);
  check('...and so does that item',
    kept.some((t) => t[1] === `podcast:item:guid:${I_A}`), true);

  // Same baseline, but now the group is empty — that IS a removal.
  const emptyWire = [
    ['alt', 'PC 2.0 Favorites'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC2}`],
  ];
  check('a group we published with nothing left under it is dropped',
    emit(parseFavoritesList(emptyWire), NO_LOCAL, baseline),
    [['alt', LIST_ALT]]);
}

// ---------------------------------------------------------------------------
section('Spec vector 2 — an empty list is distinguishable from a read that never happened');
// ---------------------------------------------------------------------------
{
  const merged = parseFavoritesList([['i', `podcast:guid:${F_POD}`]]);
  const local = groupLocalFavorites([{ id: showId(F_POD) }]);

  // The FLAG decides, never the emptiness of readTags. A refactor that
  // populated readTags from a cache would otherwise turn a degraded read into a
  // confident "the list is empty" and republish over it.
  check('a degraded read publishes nothing even with content in hand',
    planFavoritesPublish({ merged, readTags: [], exists: false, trustworthy: false, local }).reason,
    'degraded');
  check('a trustworthy read of a genuinely absent event publishes',
    planFavoritesPublish({ merged, readTags: [], exists: false, trustworthy: true, local }).publish,
    true);
  check('a signed-in user with no favorites does not mint an empty event',
    planFavoritesPublish({
      merged: parseFavoritesList([]), readTags: [], exists: false, trustworthy: true, local: NO_LOCAL,
    }).reason,
    'nothing-to-create');

  // The baseline must be recorded even when nothing is published, or the first
  // unfavorite on this device has nothing to diff against and never propagates.
  const unchanged = planFavoritesPublish({
    merged, readTags: tagsFromList(merged), exists: true, trustworthy: true, local,
  });
  check('an unchanged list still yields a baseline', unchanged.reason === 'unchanged'
    && unchanged.baseline.feeds.length > 0, true);
}

// ---------------------------------------------------------------------------
section('Spec vector 3 — idempotence');
// ---------------------------------------------------------------------------
{
  // Everything at once: unknown medium, two media blocks, an orphan, an
  // unrecognized identifier kind, a foreign `k`, and a foreign tag type. A
  // flip-flopping emitter is invisible to any single-pass assertion.
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['zzz', 'a tag type from a newer writer'],
    ['i', `podcast:item:guid:${I_ODD}`],
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['i', `podcast:item:guid:${I_B}`],
    ['medium', 'music'],
    ['i', 'podcast:publisher:guid:9b0f1c4e-1111-2222-3333-444455556666'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['k', 'podcast:guid'],
    ['k', 'podcast:item:guid'],
    ['k', 'future:kind'],
  ];
  const once = emit(parseFavoritesList(wire));
  const twice = emit(parseFavoritesList(once));
  check('merge(parse(output)) === output', twice, once);

  // Stated as a fixed point, NOT as output === input. Where the read was
  // interleaved, contiguity legitimately rewrites the first pass; a vector
  // written the naive way fails correctly and gets "fixed" wrongly.
  const interleaved = [
    ['alt', 'PC 2.0 Favorites'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC2}`],
  ];
  const first = emit(parseFavoritesList(interleaved));
  check('an interleaved read is repaired into contiguous medium blocks', first, [
    ['alt', LIST_ALT],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['k', 'podcast:guid'],
  ]);
  check('and the repair is itself a fixed point', emit(parseFavoritesList(first)), first);
}

// ---------------------------------------------------------------------------
section('Spec vector 4 — an unrecognized tag or identifier kind survives');
// ---------------------------------------------------------------------------
{
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['zzz', 'payload', 'second element'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', 'something:else:entirely', 'wss://relay.example'],
    ['i', `podcast:item:guid:${I_A}`],
    ['k', 'podcast:guid'],
    ['k', 'future:kind'],
  ];
  const out = emit(parseFavoritesList(wire));

  check('an unknown tag type survives, whole',
    out.some((t) => JSON.stringify(t) === JSON.stringify(['zzz', 'payload', 'second element'])), true);
  check('an unknown identifier kind survives with its third element',
    out.some((t) => JSON.stringify(t) === JSON.stringify(['i', 'something:else:entirely', 'wss://relay.example'])), true);
  check('a foreign k survives', out.some((t) => t[0] === 'k' && t[1] === 'future:kind'), true);

  // The one that matters most: an unrecognized `i` must not re-parent the
  // entries after it. The item below belongs to F_MUSIC, not to nothing.
  const parsed = parseFavoritesList(out);
  const group = parsed.nodes.find((n) => n.t === 'group');
  check('an unrecognized i between a feed and its item does not re-parent the item',
    group.group.itemGuids, [I_A]);
  check('...and it stays inside the music block, in position',
    out.findIndex((t) => t[1] === 'something:else:entirely')
      > out.findIndex((t) => t[0] === 'medium' && t[1] === 'music'), true);
}

// ---------------------------------------------------------------------------
section('Spec vector 5 — placement');
// ---------------------------------------------------------------------------
{
  const parsed = parseFavoritesList([
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
    ['i', `podcast:item:guid:${I_A}`],
  ]);
  const groups = parsed.nodes.filter((n) => n.t === 'group').map((n) => n.group);
  check('an item attaches to the MOST RECENTLY opened group, not the first',
    groups.map((g) => g.itemGuids), [[], [], [I_A]]);
  check('a group before any medium tag reads as unknown', groups[0].medium, undefined);
  // Asserted explicitly rather than as `=== undefined` alone: defaulting to
  // podcast is wrong for exactly the half of the list the hint exists to
  // separate, and it is the mistake the spec calls out by name.
  check('...and specifically NOT podcast', groups[0].medium === 'podcast', false);
  check('the running medium applies to every entry after it',
    [groups[1].medium, groups[2].medium], ['music', 'music']);
}

// ---------------------------------------------------------------------------
section('Spec vector 6 — a URL-shaped item guid does not corrupt its k tag');
// ---------------------------------------------------------------------------
{
  // "Everything before the last colon" would yield `podcast:item:guid:https` —
  // a k value no relay filter matches, breaking #k discovery with nothing
  // visibly wrong.
  check('the kind comes from the table, not a colon scan',
    identifierKind(itemId(I_URL)), 'podcast:item:guid');
  const out = emit(parseFavoritesList([
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_URL}`],
  ]));
  check('and the emitted k set contains no scanned fragment',
    out.filter((t) => t[0] === 'k').map((t) => t[1]), ['podcast:guid', 'podcast:item:guid']);
  check('a non-UUID item guid is still an item', parseItemGuid(itemId(I_ODD)), I_ODD);
}

// ---------------------------------------------------------------------------
section('Spec vector 7 — both k layouts parse identically');
// ---------------------------------------------------------------------------
{
  const entries = [
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
  ];
  const paired = parseFavoritesList([
    ['alt', 'PC 2.0 Favorites'],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['k', 'podcast:guid'],
    ['i', `podcast:item:guid:${I_A}`],
    ['k', 'podcast:item:guid'],
  ]);
  const trailing = parseFavoritesList([['alt', 'PC 2.0 Favorites'], ...entries,
    ['k', 'podcast:guid'], ['k', 'podcast:item:guid']]);
  // A reader that walks i/k in pairs reads the current form as an EMPTY LIBRARY
  // rather than as an error, which is the worst failure the format allows.
  check('the paired and one-per-kind layouts describe the same list',
    JSON.stringify(paired), JSON.stringify(trailing));
}

// ---------------------------------------------------------------------------
section('Emission layout');
// ---------------------------------------------------------------------------
{
  const out = emit(parseFavoritesList([
    ['alt', 'Someone else’s label'],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['i', `podcast:guid:${F_UNKNOWN}`], // no medium above it? no — inherits podcast
  ]));
  check('alt is first and ours', out[0], ['alt', LIST_ALT]);
  check('alt appears exactly once', out.filter((t) => t[0] === 'alt').length, 1);

  const withUnknown = emit(parseFavoritesList([
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
  ]));
  check('unknown-medium groups are emitted BEFORE the first medium tag',
    withUnknown.findIndex((t) => t[1] === `podcast:guid:${F_UNKNOWN}`)
      < withUnknown.findIndex((t) => t[0] === 'medium'), true);
  check('no ["medium","unknown"] is ever invented',
    withUnknown.some((t) => t[0] === 'medium' && t[1] === 'unknown'), false);

  const ks = withUnknown.filter((t) => t[0] === 'k');
  check('k tags are trailing', withUnknown.slice(-ks.length).every((t) => t[0] === 'k'), true);
  check('k is one per distinct kind, not one per entry', ks.length, 1);
}

// ---------------------------------------------------------------------------
section('The baseline — foreign entry vs. one we removed');
// ---------------------------------------------------------------------------
{
  const wire = [
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['i', `podcast:item:guid:${I_B}`],
  ];

  // We published both items; we still hold I_A. I_B is a removal.
  const local = groupLocalFavorites([{ id: itemId(I_A), feedRef: F_MUSIC, medium: 'music' }]);
  const baseline = { feeds: [showId(F_MUSIC)], items: [itemId(I_A), itemId(I_B)] };
  const out = emit(parseFavoritesList(wire), local, baseline);
  check('an item we published and no longer hold is removed',
    out.some((t) => t[1] === `podcast:item:guid:${I_B}`), false);
  check('an item we still hold stays',
    out.some((t) => t[1] === `podcast:item:guid:${I_A}`), true);

  // An item we never published, sitting under a feed we hold, is another app's.
  const out2 = emit(parseFavoritesList(wire), local, { feeds: [showId(F_MUSIC)], items: [itemId(I_A)] });
  check('an item we never published is not ours to delete',
    out2.some((t) => t[1] === `podcast:item:guid:${I_B}`), true);

  // An empty baseline must delete nothing — a device that has never synced
  // holds no opinion about what anyone else added.
  check('an empty baseline deletes nothing',
    emit(parseFavoritesList(wire), NO_LOCAL, EMPTY_BASELINE), tagsFromList(parseFavoritesList(wire)));

  // The shape of a real deletion, kept here because the merge is only ever as
  // truthful as the baseline it is handed. An itemless group we never wrote
  // survives on an empty baseline and is DESTROYED by one that falsely names
  // it — which is what a baseline carried over from a different address is. The
  // rule the merge implements is right; the input was a lie. See
  // `storage.favBaseline`, which starts empty for exactly this reason.
  const foreignAlbum = [['medium', 'music'], ['i', `podcast:guid:${F_MUSIC}`]];
  check('an itemless group we never published survives',
    emit(parseFavoritesList(foreignAlbum), NO_LOCAL, EMPTY_BASELINE)
      .some((t) => t[1] === `podcast:guid:${F_MUSIC}`), true);
  check('...and a baseline that falsely claims it is what deletes it',
    emit(parseFavoritesList(foreignAlbum), NO_LOCAL, { feeds: [showId(F_MUSIC)], items: [] })
      .some((t) => t[1] === `podcast:guid:${F_MUSIC}`), false);

  // Removal must propagate even when the parent group is no longer ours.
  const orphanedRemoval = emit(parseFavoritesList(wire), NO_LOCAL,
    { feeds: [], items: [itemId(I_B)] });
  check('an item removal propagates under a group we do not hold',
    orphanedRemoval.some((t) => t[1] === `podcast:item:guid:${I_B}`), false);

  // A feed another writer removed must not come back just because we still
  // have a local row for it — that is the resurrection loop.
  const localOnly = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'music' }]);
  check('a feed another app removed is not resurrected by this device',
    emit(parseFavoritesList([]), localOnly, { feeds: [showId(F_MUSIC)], items: [] }),
    [['alt', LIST_ALT]]);
  check('but a genuinely new local favorite IS published',
    emit(parseFavoritesList([]), localOnly, EMPTY_BASELINE).some((t) => t[1] === `podcast:guid:${F_MUSIC}`),
    true);

  // The case that "don't resurrect" gets wrong if it stops at the group: the
  // album is gone from the relay and we published it, but the user has since
  // favorited a track from it HERE. The track is new, so it must go up — and it
  // cannot be placed without reopening the group that names its parent.
  const newTrackUnderRemovedFeed = groupLocalFavorites([
    { id: showId(F_MUSIC), medium: 'music' },
    { id: itemId(I_A), feedRef: F_MUSIC, medium: 'music' },
  ]);
  const revived = emit(parseFavoritesList([]), newTrackUnderRemovedFeed,
    { feeds: [showId(F_MUSIC)], items: [] });
  check('a new track under a feed another app removed is still published',
    revived.some((t) => t[1] === `podcast:item:guid:${I_A}`), true);
  check('...and its parent group is reopened to place it',
    revived.some((t) => t[1] === `podcast:guid:${F_MUSIC}`), true);
  // The group comes back ONLY to carry the track — it is not a revived feed
  // favorite, and an itemless revival would be exactly the resurrection loop.
  check('...but a removed feed with nothing new under it still stays gone',
    emit(parseFavoritesList([]), localOnly, { feeds: [showId(F_MUSIC)], items: [] })
      .some((t) => t[1] === `podcast:guid:${F_MUSIC}`), false);
}

// ---------------------------------------------------------------------------
section('Medium is sticky');
// ---------------------------------------------------------------------------
{
  const wire = [['medium', 'music'], ['i', `podcast:guid:${F_MUSIC}`]];
  const local = groupLocalFavorites([{ id: showId(F_MUSIC), medium: 'podcast' }]);
  const out = emit(parseFavoritesList(wire), local, EMPTY_BASELINE);
  // "Prefer my own resolved value" does not converge: two apps holding
  // different values rewrite the event at each other forever, each publish
  // locally reasonable, the only symptom being that it never stops.
  check('a local value never overwrites a medium another writer set',
    out.find((t) => t[0] === 'medium')[1], 'music');

  const gap = emit(parseFavoritesList([['i', `podcast:guid:${F_MUSIC}`]]), local, EMPTY_BASELINE);
  check('but it does fill a gap', gap.find((t) => t[0] === 'medium')[1], 'podcast');
}

// ---------------------------------------------------------------------------
section('Malformed and unplaceable entries');
// ---------------------------------------------------------------------------
{
  // Old versions of this app wrote feed IDs rather than guids. They are not
  // feeds we can open a group for, but "this app can't read it" is not the same
  // claim as "this is junk" — they are preserved, and removable only through
  // the explicit cleanup hook.
  const parsed = parseFavoritesList([['i', 'podcast:guid:920666']]);
  check('a malformed feed guid becomes a loose entry, not a group',
    parsed.nodes.map((n) => n.t), ['loose']);
  check('...and is carried through a republish',
    emit(parsed), [['alt', LIST_ALT], ['i', 'podcast:guid:920666'], ['k', 'podcast:guid']]);
  check('...and is reported as malformed', partitionList(parsed).malformed, ['podcast:guid:920666']);
  check('parseShowGuid rejects it outright', parseShowGuid('podcast:guid:920666'), null);

  // A favorited item whose parent we never learned rides as an orphan rather
  // than being dropped: losing a track because we can't name its album is a
  // worse trade than an unplaceable entry.
  const orphanLocal = groupLocalFavorites([{ id: itemId(I_A), medium: 'music' }]);
  check('an item with no parent is kept as an orphan, not dropped',
    orphanLocal.loose.map((l) => l.tag), [['i', `podcast:item:guid:${I_A}`]]);
  check('an item whose parent is not a UUID is also an orphan',
    groupLocalFavorites([{ id: itemId(I_A), feedRef: '920666' }]).groups.length, 0);

  // And it must be removable, or the user has a favorite they can never undo.
  const orphanWire = [['i', `podcast:item:guid:${I_A}`]];
  check('an orphan we published and no longer hold is removed',
    emit(parseFavoritesList(orphanWire), NO_LOCAL, { feeds: [], items: [itemId(I_A)] }),
    [['alt', LIST_ALT]]);
  check('an orphan we never published is not ours to delete',
    emit(parseFavoritesList(orphanWire), NO_LOCAL, EMPTY_BASELINE)
      .some((t) => t[1] === `podcast:item:guid:${I_A}`), true);
  check('baselineFrom records orphans, or the above could never fire',
    baselineFrom(orphanLocal).items, [`podcast:item:guid:${I_A}`]);
}

// ---------------------------------------------------------------------------
section('A feed group is not always a favorite');
// ---------------------------------------------------------------------------
{
  // Opening a group is the only way to name an item's parent, so a group
  // appears whether or not the feed was favorited. Reading every group as a
  // favorite manufactures albums the user never chose — measured at 159 of 197
  // groups on the live list this was built against.
  const p = partitionList(parseFavoritesList([
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
  ]));
  check('a group with items is not an unambiguous favorite',
    p.feeds.map((f) => [f.feedGuid, f.itemless]), [[F_MUSIC, false], [F_MUSIC2, true]]);
  check('an item takes its group medium — PC2.0 has no per-item medium',
    p.items, [{ itemGuid: I_A, feedGuid: F_MUSIC, medium: 'music' }]);
}

// ---------------------------------------------------------------------------
section('The store projection is a fixed point');
// ---------------------------------------------------------------------------
{
  // What we render is what we would republish. Without this, a rendering pass
  // can quietly change the wire on the next publish.
  const wire = [
    ['alt', 'PC 2.0 Favorites'],
    ['i', `podcast:guid:${F_UNKNOWN}`],
    ['i', `podcast:item:guid:${I_B}`],
    ['medium', 'music'],
    ['i', `podcast:guid:${F_MUSIC}`],
    ['i', `podcast:item:guid:${I_A}`],
    ['i', `podcast:guid:${F_MUSIC2}`],
    ['medium', 'podcast'],
    ['i', `podcast:guid:${F_POD}`],
    ['k', 'podcast:guid'],
    ['k', 'podcast:item:guid'],
  ];
  const read = parseFavoritesList(wire);
  const local = groupLocalFavorites(entriesFromList(read));
  check('render → regroup → merge reproduces the wire',
    tagsFromList(mergeFavoritesList({ read, local, baseline: baselineFrom(local) })), wire);
}

// ---------------------------------------------------------------------------
section('Control — the obvious wrong implementation must fail these');
// ---------------------------------------------------------------------------
{
  // Parse to structs, merge by map, rebuild the array. This is what someone
  // writes when they have not been bitten yet, and it is the reason the vectors
  // above are not merely assertions that were true when written.
  const naive = (tags) => {
    const byGuid = new Map();
    let cur = null;
    for (const t of tags) {
      if (t[0] !== 'i' || !t[1]) continue;
      const f = parseShowGuid(t[1]);
      if (f !== null) { cur = { feedGuid: f, items: [] }; byGuid.set(f, cur); continue; }
      const i = parseItemGuid(t[1]);
      if (i !== null && cur) cur.items.push(i);
      // an unrecognized kind is dropped, and so is every non-i tag
    }
    const out = [['alt', LIST_ALT]];
    for (const g of [...byGuid.values()].sort((a, b) => a.feedGuid.localeCompare(b.feedGuid))) {
      out.push(['i', showId(g.feedGuid)]);
      for (const i of g.items) out.push(['i', itemId(i)]);
    }
    return out;
  };

  const mustFail = [
    ['it drops an unknown identifier kind',
      [['i', `podcast:guid:${F_MUSIC}`], ['i', 'something:else:entirely']]],
    ['it drops an unknown tag type',
      [['zzz', 'payload'], ['i', `podcast:guid:${F_MUSIC}`]]],
    ['it loses the medium entirely',
      [['medium', 'music'], ['i', `podcast:guid:${F_MUSIC}`]]],
    ['it reorders groups and re-labels the blocks',
      [['medium', 'music'], ['i', `podcast:guid:${F_POD}`], ['i', `podcast:guid:${F_MUSIC}`]]],
  ];

  for (const [label, wire] of mustFail) {
    const ours = emit(parseFavoritesList(wire));
    const theirs = naive(wire);
    const differs = JSON.stringify(ours) !== JSON.stringify(theirs);
    check(`(naive) ${label}`, differs, true);
  }
}

// ---------------------------------------------------------------------------
console.log('\nfavorites-list.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The arrangement this whole script depends on: it imports the REAL module,
  // so the module must keep resolving under `node --experimental-strip-types`.
  // See scripts/import-free.mjs for why a type-only relative import counts.
  const problems = importFreeProblems('lib/nostr/favorites-list.ts');
  if (problems.length) { explainImportFree('lib/nostr/favorites-list.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/nostr/favorites-list.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} favorites check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll favorites checks passed.');
